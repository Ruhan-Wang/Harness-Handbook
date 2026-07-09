# Turn context, history, and realtime prompt assembly  `stage-12.4`

This stage prepares the exact package of information the model sees before it answers. It sits in the main work loop, just before a new turn is sent, and it also supports realtime startup and debugging.

The turn context builder creates one reliable snapshot of the session: model choice, file locations, allowed tools, permissions, and settings. The history manager keeps earlier conversation turns, trims them to fit the model’s limited memory space, and can roll back or clean them. Normalization keeps tool requests matched with their results and removes data the selected model cannot use, such as images for a text-only model.

Additional context and context update code work like change notices. They send only what changed, such as new permissions or environment details, instead of repeating the whole setup. Token budgeting adds warnings when the conversation is filling up the available space.

Special user-message context is separated from normal human text. Realtime files build the startup briefing and choose the realtime instruction prompt. Prompt debugging assembles a visible test prompt for developers. Web search history extracts only recent useful text for standalone searches.

## Files in this stage

### Turn context snapshots
These files define the immutable per-turn context and derive incremental context fragments from changing session state and token usage.

### `core/src/session/turn_context.rs`

`orchestration` · `per-turn setup and request handling`

A “turn” is one round of interaction, like one user request and the work needed to answer it. This file creates and exposes the TurnContext, which is the backpack of information carried through that round. It includes model details, reasoning settings, permission rules, sandbox rules, working directories, loaded skills, telemetry, network settings, and environment choices.

The file also defines TurnEnvironment, which represents one selected place where tools may run, including its working directory and optional shell state. Think of it like choosing which desk and toolbox the assistant is allowed to use for this turn.

Most of the work is in Session methods. They start from the session’s saved settings, apply any per-turn updates, ask model and plugin services for current information, load skills, choose the multi-agent behavior, build sandbox permissions, and finally return an Arc<TurnContext>, meaning a shared reference that many tasks can safely use.

An important theme is safety and consistency. The context records exactly which file and network permissions apply, and it keeps older compatibility fields while newer environment-aware fields are introduced. It also emits warnings when model metadata is missing, and it updates external services when permission settings change.

#### Function details

##### `TurnSkillsContext::new`  (lines 37–42)

```
fn new(outcome: Arc<SkillLoadOutcome>) -> Self
```

**Purpose**: Creates the skills-related state for one turn. It keeps the result of loading skills and starts an empty record of which implicitly invoked skills have already been noticed.

**Data flow**: It receives a shared SkillLoadOutcome. It stores that outcome and creates an empty shared set protected by a mutex, which is a lock that prevents two tasks from changing the set at the same time. It returns a TurnSkillsContext ready to be placed inside the turn context.

**Call relations**: This is used when a full TurnContext is assembled, especially by Session::make_turn_context. Tests and review-thread setup also call it when they need a realistic skills context.

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

**Purpose**: Creates a record for one environment selected for the turn. The record says which environment it is, what working directory it uses, and whether there is a shell connected to it.

**Data flow**: It takes an environment id, the environment object, a working directory URI, and an optional shell. It stores them and sets the shell snapshot task to an already-finished empty result, meaning no saved shell snapshot exists yet. It returns the new TurnEnvironment.

**Call relations**: Environment selection code and tests call this when building the set of environments for a turn. Later, TurnContext uses these environments to decide where tools run and how paths should be resolved.

*Call graph*: called by 7 (resolve_selection, set_primary_environment_cwd, primary_environment_uses_first_turn_environment, request_permissions_tool_resolves_relative_paths_against_selected_environment, replace_primary_environment_cwd, test_turn_environment, test_turn_environment); 1 external calls (ready).


##### `TurnEnvironment::shell_snapshot`  (lines 72–80)

```
fn shell_snapshot(&self, cwd: &AbsolutePathBuf) -> Option<AbsolutePathBuf>
```

**Purpose**: Looks up the saved shell snapshot path, but only if the caller is asking about the same working directory as this environment. This avoids returning shell state for the wrong folder.

**Data flow**: It receives an absolute working directory path. It converts that path to the URI form used by the environment and compares it with the environment’s stored cwd. If they match and the snapshot task has already completed with a snapshot file, it returns that file’s path; otherwise it returns nothing.

**Call relations**: This is a helper for code that wants to reuse shell state. It depends on TurnEnvironment’s stored cwd and snapshot task, and it deliberately refuses to cross-match different directories.

*Call graph*: calls 1 internal fn (from_abs_path); 1 external calls (peek).


##### `TurnEnvironment::cwd`  (lines 82–84)

```
fn cwd(&self) -> &PathUri
```

**Purpose**: Returns the working directory selected for this environment. This lets other parts of the system resolve relative paths against the right place.

**Data flow**: It reads the cwd field from the TurnEnvironment and returns a reference to it. Nothing is changed.

**Call relations**: Turn-building code uses this when choosing the primary cwd for the turn. It is part of the move away from relying only on the session’s older single cwd field.

*Call graph*: called by 1 (build).


##### `TurnEnvironment::selection`  (lines 86–91)

```
fn selection(&self) -> TurnEnvironmentSelection
```

**Purpose**: Turns the environment into a small selection record that can be sent around or stored. The selection includes the environment id and its working directory.

**Data flow**: It reads the environment id and cwd, clones them, and packages them into a TurnEnvironmentSelection. It does not change the environment.

**Call relations**: This is used when the system needs the lightweight description of an environment choice rather than the full environment object.

*Call graph*: 1 external calls (clone).


##### `TurnEnvironment::fmt`  (lines 95–102)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Controls how a TurnEnvironment appears in debug logs. It shows useful fields while leaving room for future fields without promising a fixed format.

**Data flow**: It receives a formatter from Rust’s debug-printing machinery. It writes the environment id, environment, cwd, and shell into that formatter, then finishes the debug output.

**Call relations**: This is called automatically when a TurnEnvironment is printed with debug formatting, often during tracing or troubleshooting.

*Call graph*: 1 external calls (debug_struct).


##### `TurnContext::permission_profile`  (lines 167–169)

```
fn permission_profile(&self) -> PermissionProfile
```

**Purpose**: Returns the permission profile for this turn. A permission profile is the turn’s rulebook for file, network, and approval behavior.

**Data flow**: It reads the TurnContext’s permission_profile field, clones it, and returns the clone. The original context is unchanged.

**Call relations**: Many tool and analytics paths call this when they need to know what the assistant is allowed to do, such as applying patches, installing dependencies, refreshing MCP servers, or building a public turn-context item.

*Call graph*: called by 10 (apply_patch, build_permissions_update_item, should_install_mcp_dependencies, augment_mcp_tool_request_meta_with_sandbox_state, install_host_owned_codex_apps_manager, refresh_mcp_servers_inner, track_turn_resolved_config_analytics, to_turn_context_item, apply_spawn_agent_runtime_overrides, test_exec_request); 1 external calls (clone).


##### `TurnContext::file_system_sandbox_policy`  (lines 171–173)

```
fn file_system_sandbox_policy(&self) -> FileSystemSandboxPolicy
```

**Purpose**: Returns the file-system sandbox policy for the turn. This policy says which files and folders tool code may read or write.

**Data flow**: It reads the permission profile and asks it for the file-system sandbox policy. It returns that policy without changing the context.

**Call relations**: Tool execution and patch logic call this when they need file access rules. TurnContext::non_legacy_file_system_sandbox_policy also uses it when preparing context data for clients.

*Call graph*: calls 1 internal fn (file_system_sandbox_policy); called by 3 (non_legacy_file_system_sandbox_policy, effective_patch_permissions, run).


##### `TurnContext::network_sandbox_policy`  (lines 175–177)

```
fn network_sandbox_policy(&self) -> NetworkSandboxPolicy
```

**Purpose**: Returns the network sandbox policy for the turn. This policy says whether network access is blocked, limited, or allowed.

**Data flow**: It reads the permission profile and asks it for the network sandbox policy. It returns that policy without changing anything.

**Call relations**: Execution and analytics code call this to understand the turn’s network rules.

*Call graph*: calls 1 internal fn (network_sandbox_policy); called by 2 (track_turn_resolved_config_analytics, run).


##### `TurnContext::sandbox_policy`  (lines 179–185)

```
fn sandbox_policy(&self) -> SandboxPolicy
```

**Purpose**: Builds the older combined sandbox policy used by legacy callers. It translates the newer permission profile into the compatibility form those callers still expect.

**Data flow**: It reads the permission profile and the context’s legacy cwd. It passes both to the sandbox compatibility helper and returns the combined sandbox policy.

**Call relations**: This supports older parts of the code while newer split file-system and network policies are being adopted. It is used when adding sandbox metadata, deriving legacy file policies, and building the TurnContextItem.

*Call graph*: called by 4 (augment_mcp_tool_request_meta_with_sandbox_state, file_system_policy_with_unreadable_glob, non_legacy_file_system_sandbox_policy, to_turn_context_item); 1 external calls (compatibility_sandbox_policy_for_permission_profile).


##### `TurnContext::effective_reasoning_effort`  (lines 187–195)

```
fn effective_reasoning_effort(&self) -> Option<ReasoningEffortConfig>
```

**Purpose**: Decides what reasoning-effort setting should actually be used for the model. If the model does not support reasoning summaries, it returns no effort setting.

**Data flow**: It checks the model information. If supported, it returns the explicit turn setting when present, otherwise the model’s default reasoning level. If unsupported, it returns nothing.

**Call relations**: MCP metadata building and tracing use this to report or send the reasoning setting that really applies, rather than only the raw user setting.

*Call graph*: called by 3 (build_mcp_tool_call_request_meta, mcp_turn_metadata_context, effective_reasoning_effort_for_tracing).


##### `TurnContext::effective_reasoning_effort_for_tracing`  (lines 197–201)

```
fn effective_reasoning_effort_for_tracing(&self) -> String
```

**Purpose**: Turns the effective reasoning effort into a simple text value for logs and traces. If there is no explicit effective setting, it reports "default".

**Data flow**: It calls TurnContext::effective_reasoning_effort. If that returns a setting, it converts it to text; otherwise it returns the string "default".

**Call relations**: This is a small reporting helper built on top of the main reasoning-effort decision function.

*Call graph*: calls 1 internal fn (effective_reasoning_effort).


##### `TurnContext::model_context_window`  (lines 203–210)

```
fn model_context_window(&self) -> Option<i64>
```

**Purpose**: Calculates how many tokens the system should treat as usable for this model. A token is a small piece of text used by the language model, and the context window is the model’s text limit.

**Data flow**: It reads the model’s resolved context-window size and the configured percentage to use. If a size is known, it multiplies by the percentage and returns the adjusted limit. If no size is known, it returns nothing.

**Call relations**: Prompt-building, token accounting, history trimming, and auto-compaction call this so they do not send more text than the model can handle.

*Call graph*: calls 1 internal fn (resolved_context_window); called by 7 (trim_function_call_history_to_fit_context_window, build_initial_context, recompute_token_usage, record_token_usage_info, set_total_tokens_full, maybe_record_token_budget_remaining_context, auto_compact_token_status).


##### `TurnContext::apps_enabled`  (lines 212–218)

```
fn apps_enabled(&self) -> bool
```

**Purpose**: Decides whether app-related features are enabled for this turn. The answer can depend on both feature flags and the kind of authentication currently in use.

**Data flow**: It checks whether the current auth manager is using the Codex backend. It then asks the managed feature set whether apps are enabled for that auth situation. It returns true or false.

**Call relations**: Initial context building, skills and plugins setup, and tool construction call this when deciding whether app capabilities should be exposed.

*Call graph*: called by 3 (build_initial_context, build_skills_and_plugins, built_tools); 1 external calls (apps_enabled_for_auth).


##### `TurnContext::tool_environment_mode`  (lines 220–222)

```
fn tool_environment_mode(&self) -> ToolEnvironmentMode
```

**Purpose**: Summarizes how tools should think about environments for this turn, based on how many turn environments are available.

**Data flow**: It counts the selected turn environments and converts that count into a ToolEnvironmentMode. Nothing is changed.

**Call relations**: This helper lets tool-related code choose behavior for one environment versus multiple environments without inspecting the environment list directly.

*Call graph*: calls 1 internal fn (from_count).


##### `TurnContext::with_model`  (lines 224–334)

```
async fn with_model(
        &self,
        model: String,
        models_manager: &SharedModelsManager,
    ) -> Self
```

**Purpose**: Creates a copy of the current TurnContext that uses a different model. This is useful when a turn needs to switch models while preserving the rest of the session state.

**Data flow**: It receives a model name and the models manager. It clones the current config, sets the new model, fetches model metadata, chooses the right tool mode, truncation policy, and reasoning effort, updates collaboration metadata and telemetry, refreshes the available model list, and returns a new TurnContext with most other fields copied from the old one.

**Call relations**: This method is a controlled model swap. It talks to the models manager for fresh model information and then rebuilds the context fields that depend on the model, while carrying forward permissions, environments, skills, timing state, and shared error state.

*Call graph*: calls 1 internal fn (with_updates); 18 external calls (clone, new, load, new, clone, get_model_info, list_models, clone, clone, clone (+8 more)).


##### `TurnContext::resolve_path`  (lines 337–341)

```
fn resolve_path(&self, path: Option<String>) -> AbsolutePathBuf
```

**Purpose**: Resolves an optional relative path against the turn’s legacy working directory. It is deprecated because newer code should use the selected environment’s cwd instead.

**Data flow**: It receives an optional path string. If there is no path, it returns the context cwd. If there is a path, it joins that path to the context cwd and returns the resulting absolute path.

**Call relations**: Execution parameter building still calls this for older path behavior. The deprecation note points readers toward environment-aware path resolution.

*Call graph*: called by 1 (to_exec_params).


##### `TurnContext::file_system_sandbox_context`  (lines 343–373)

```
fn file_system_sandbox_context(
        &self,
        additional_permissions: Option<AdditionalPermissionProfile>,
        cwd: &PathUri,
    ) -> FileSystemSandboxContext
```

**Purpose**: Builds the complete file-system sandbox context used when running file operations. This combines the base permission profile with any extra temporary permissions for this specific action.

**Data flow**: It receives optional additional permissions and a cwd. It starts from the turn’s runtime file and network permissions, applies the additional permissions, rebuilds a permission profile with the same enforcement level, and returns a FileSystemSandboxContext containing those permissions, the cwd, Windows sandbox settings, and the legacy Landlock choice.

**Call relations**: Tool execution code can call this when it needs a precise sandbox setup for one operation. It delegates policy merging to sandbox transform helpers so the effective restrictions are consistent.

*Call graph*: calls 5 internal fn (enforcement, from_runtime_permissions_with_enforcement, to_runtime_permissions, effective_file_system_sandbox_policy, effective_network_sandbox_policy); 2 external calls (use_legacy_landlock, clone).


##### `TurnContext::non_legacy_file_system_sandbox_policy`  (lines 375–389)

```
fn non_legacy_file_system_sandbox_policy(&self) -> Option<FileSystemSandboxPolicy>
```

**Purpose**: Returns the newer file-system sandbox policy only when it differs from the older legacy-derived policy. This keeps outgoing context data stable while both formats exist.

**Data flow**: It derives a legacy file-system policy from the combined sandbox policy and cwd. It also reads the newer split file-system policy. If the two are different, it returns the newer policy; if they match, it returns nothing.

**Call relations**: TurnContext::to_turn_context_item calls this when preparing data for clients. The function acts like a bridge during migration from old sandbox fields to newer split policy fields.

*Call graph*: calls 3 internal fn (file_system_sandbox_policy, sandbox_policy, from_legacy_sandbox_policy_for_cwd); called by 1 (to_turn_context_item).


##### `TurnContext::compact_prompt`  (lines 391–395)

```
fn compact_prompt(&self) -> &str
```

**Purpose**: Returns the prompt text used when compacting or summarizing conversation history. It falls back to a built-in default if the session did not provide one.

**Data flow**: It checks the optional compact_prompt field. If present, it returns that text; otherwise it returns the standard summarization prompt. The context is not changed.

**Call relations**: Compaction logic can call this to get the right instruction text without needing to know where it came from.


##### `TurnContext::to_turn_context_item`  (lines 397–420)

```
fn to_turn_context_item(&self) -> TurnContextItem
```

**Purpose**: Creates a smaller, serializable summary of the turn context. This is the version suitable for recording in conversation context or sending to clients.

**Data flow**: It reads key fields such as turn id, cwd, workspace roots, date, timezone, approval policy, sandbox policy, permission profile, network restrictions, model, personality, collaboration mode, realtime flag, and reasoning effort. It packages them into a TurnContextItem and returns it.

**Call relations**: Context-window and context-recording code call this when they need to capture the turn’s resolved settings. It uses helper methods such as sandbox_policy, permission_profile, non_legacy_file_system_sandbox_policy, and turn_context_network_item.

*Call graph*: calls 6 internal fn (value, non_legacy_file_system_sandbox_policy, permission_profile, sandbox_policy, turn_context_network_item, to_path_buf); called by 2 (maybe_start_new_context_window, record_context_updates_and_set_reference_context_item); 1 external calls (clone).


##### `TurnContext::turn_context_network_item`  (lines 422–441)

```
fn turn_context_network_item(&self) -> Option<TurnContextNetworkItem>
```

**Purpose**: Builds the network-permission summary for the public turn-context item. It reports allowed and denied network domains when those requirements exist.

**Data flow**: It looks into the config layer stack for network requirements. If none exist, it returns nothing. If they do, it extracts allowed and denied domain lists, defaulting to empty lists when unspecified, and returns a TurnContextNetworkItem.

**Call relations**: TurnContext::to_turn_context_item calls this while building the compact summary of the turn’s settings.

*Call graph*: called by 1 (to_turn_context_item).


##### `local_time_context`  (lines 444–452)

```
fn local_time_context() -> (String, String)
```

**Purpose**: Finds the current date and timezone to attach to a turn. If the local timezone cannot be detected, it safely falls back to UTC.

**Data flow**: It asks the system for the IANA timezone name, such as "America/New_York". On success it returns today’s local date and that timezone. On failure it returns today’s UTC date and "Etc/UTC".

**Call relations**: Session::make_turn_context calls this so every new TurnContext can include date and timezone information for prompts, metadata, or tools.

*Call graph*: called by 1 (make_turn_context); 3 external calls (now, now, get_timezone).


##### `Session::build_per_turn_config`  (lines 456–493)

```
fn build_per_turn_config(
        session_configuration: &SessionConfiguration,
        cwd: AbsolutePathBuf,
    ) -> Config
```

**Purpose**: Creates the Config object that applies to one specific turn. It starts from the session’s original config, then overlays the current session settings that can change between turns.

**Data flow**: It receives the session configuration and a cwd. It clones the original config, sets cwd, workspace roots, reasoning settings, service tier, personality, approval reviewer, and permission settings, resolves web-search mode against the permission profile, restores feature flags, and returns the per-turn config.

**Call relations**: Turn-building flows call this before loading models, plugins, skills, and sandbox settings. It is also used by Session::build_effective_session_config for configuration-change notifications.

*Call graph*: calls 2 internal fn (apply_permission_profile_to_permissions, permission_profile); 1 external calls (warn!).


##### `Session::build_effective_session_config`  (lines 495–507)

```
fn build_effective_session_config(
        session_configuration: &SessionConfiguration,
    ) -> Config
```

**Purpose**: Builds a full effective config that represents the current session, not just a single incoming update. This is useful when comparing old and new settings.

**Data flow**: It receives a SessionConfiguration. It builds a per-turn config using the session cwd, then sets the active model, approval policy, and workspace roots to match the session. It returns the resulting Config.

**Call relations**: Session::new_turn_with_sub_id uses this when extension config contributors need to be told what changed between two configurations.

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

**Purpose**: Assembles the final TurnContext from already-resolved ingredients. This is the central packing step that puts model, config, permissions, environments, skills, telemetry, and runtime state into one shared structure.

**Data flow**: It receives identifiers, auth, telemetry, provider info, session configuration, model info, managers, network proxy, environments, cwd, sub-id, and loaded skills. It computes reasoning summary, provider, available models, shell execution mode, tool mode, service tier, metadata state, local date/time, extension data, and timing/error state. It returns a populated TurnContext.

**Call relations**: Session::new_turn_context_from_configuration calls this after it has fetched model data, loaded plugins and skills, and selected environments. TurnSkillsContext::new and local_time_context are used inside this assembly step.

*Call graph*: calls 8 internal fn (new, permission_profile, new, local_time_context, tool_user_shell_type, new, new, for_session); 14 external calls (clone, new, new, new, try_list_models, clone, create_model_provider, unified_exec_feature_mode_for_features, default, clone (+4 more)).


##### `Session::new_turn_with_sub_id`  (lines 636–703)

```
async fn new_turn_with_sub_id(
        &self,
        sub_id: String,
        updates: SessionSettingsUpdate,
    ) -> CodexResult<Arc<TurnContext>>
```

**Purpose**: Starts a new turn using explicit updates from the caller. It validates and applies those updates before building the turn context.

**Data flow**: It receives a sub-id and settings update. It locks the session state, tries to apply the update, detects permission changes, optionally prepares old and new effective configs, updates selected environments, and stores the new session configuration. If validation fails, it sends an error event and returns an invalid-request error. If permissions changed, it refreshes the managed network proxy, then returns a newly built TurnContext.

**Call relations**: This is the main entry for creating a turn when a request changes settings. It hands successful work to Session::new_turn_from_configuration and uses config-change and network-refresh hooks around that handoff.

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

**Purpose**: Builds a normal turn context from a session configuration. It chooses the runtime mode that resolves and stores the multi-agent version.

**Data flow**: It receives a sub-id, session configuration, and optional final output JSON schema setting. It forwards them to Session::new_turn_context_from_configuration with the normal multi-agent runtime mode and returns the resulting shared TurnContext.

**Call relations**: Session::new_turn_with_sub_id and Session::new_default_turn_with_sub_id call this for ordinary turns. It is a small wrapper around the shared turn-building pipeline.

*Call graph*: calls 1 internal fn (new_turn_context_from_configuration); called by 2 (new_default_turn_with_sub_id, new_turn_with_sub_id).


##### `Session::new_startup_prewarm_turn_from_configuration`  (lines 720–732)

```
async fn new_startup_prewarm_turn_from_configuration(
        &self,
        sub_id: String,
        session_configuration: SessionConfiguration,
    ) -> Arc<TurnContext>
```

**Purpose**: Builds a preview turn context used for startup prewarming. Prewarming prepares expensive pieces early without committing the same multi-agent resolution behavior as a real turn.

**Data flow**: It receives a sub-id and session configuration. It forwards them to Session::new_turn_context_from_configuration with no final output schema update and with preview multi-agent runtime mode. It returns the shared TurnContext.

**Call relations**: Session::new_startup_prewarm_turn_with_sub_id calls this during startup prewarm work. It shares the main construction path but changes the multi-agent selection mode.

*Call graph*: calls 1 internal fn (new_turn_context_from_configuration); called by 1 (new_startup_prewarm_turn_with_sub_id).


##### `Session::new_turn_context_from_configuration`  (lines 735–834)

```
async fn new_turn_context_from_configuration(
        &self,
        sub_id: String,
        session_configuration: SessionConfiguration,
        final_output_json_schema: Option<Option<Value>>,
```

**Purpose**: Runs the full recipe for creating a TurnContext from current session settings. It selects environments, builds config, updates permission-aware services, fetches model data, loads plugins and skills, and then assembles the context.

**Data flow**: It receives a sub-id, session configuration, optional final output schema update, and multi-agent runtime mode. It snapshots turn environments, chooses a cwd, builds per-turn config, updates the MCP connection manager with approval and permission settings, fetches model info, chooses the multi-agent version, loads plugin and skill data, calls Session::make_turn_context, marks whether realtime conversation is active, applies any final output schema override, starts git metadata enrichment for a single local environment, and returns the context in an Arc.

**Call relations**: Both normal and startup-prewarm turn builders call this. It is the main orchestration function in the file, handing off the final assembly to Session::make_turn_context after collecting all needed inputs.

*Call graph*: calls 1 internal fn (permission_profile); called by 2 (new_startup_prewarm_turn_from_configuration, new_turn_from_configuration); 4 external calls (clone, new, build_per_turn_config, make_turn_context).


##### `Session::maybe_emit_unknown_model_warning_for_turn`  (lines 836–849)

```
async fn maybe_emit_unknown_model_warning_for_turn(&self, tc: &TurnContext)
```

**Purpose**: Warns the user when the system had to use fallback metadata for the selected model. This matters because missing model metadata can make behavior less accurate or efficient.

**Data flow**: It receives a TurnContext. If the model_info says fallback metadata was used, it formats a warning message naming the model and sends a warning event. If not, it does nothing.

**Call relations**: Callers can run this after creating a turn context. It uses the session event-sending path to surface the warning.

*Call graph*: 2 external calls (format!, Warning).


##### `Session::new_default_turn`  (lines 851–854)

```
async fn new_default_turn(&self) -> Arc<TurnContext>
```

**Purpose**: Creates a new turn using the session’s current default configuration and an automatically generated internal sub-id.

**Data flow**: It asks the session for the next internal sub-id, then passes that id to Session::new_default_turn_with_sub_id. It returns the resulting shared TurnContext.

**Call relations**: This is a convenience wrapper for code that does not need to choose the sub-id itself.

*Call graph*: calls 1 internal fn (new_default_turn_with_sub_id).


##### `Session::new_default_turn_with_sub_id`  (lines 856–864)

```
async fn new_default_turn_with_sub_id(&self, sub_id: String) -> Arc<TurnContext>
```

**Purpose**: Creates a normal turn from the session’s current saved configuration using a caller-provided sub-id.

**Data flow**: It loads the default turn configuration from session state, then calls Session::new_turn_from_configuration with no final output schema override. It returns the resulting shared TurnContext.

**Call relations**: Session::new_default_turn calls this after generating an id. It connects the saved session configuration to the normal turn-building path.

*Call graph*: calls 2 internal fn (default_turn_configuration, new_turn_from_configuration); called by 1 (new_default_turn).


##### `Session::new_startup_prewarm_turn_with_sub_id`  (lines 866–873)

```
async fn new_startup_prewarm_turn_with_sub_id(
        &self,
        sub_id: String,
    ) -> Arc<TurnContext>
```

**Purpose**: Creates a startup prewarm turn from the session’s current saved configuration. This lets the system prepare resources before an ordinary user turn needs them.

**Data flow**: It loads the default turn configuration from session state, then calls Session::new_startup_prewarm_turn_from_configuration with the provided sub-id. It returns the resulting shared TurnContext.

**Call relations**: Startup prewarm code uses this to reach the preview turn-building path while still starting from the current session configuration.

*Call graph*: calls 2 internal fn (default_turn_configuration, new_startup_prewarm_turn_from_configuration).


##### `Session::default_turn_configuration`  (lines 875–878)

```
async fn default_turn_configuration(&self) -> SessionConfiguration
```

**Purpose**: Reads the session’s current configuration for use as the base of a new turn.

**Data flow**: It locks the session state, clones the stored SessionConfiguration, and returns the clone. The stored state is not changed.

**Call relations**: Default normal-turn and startup-prewarm builders call this before handing the configuration to their respective turn-building paths.

*Call graph*: called by 2 (new_default_turn_with_sub_id, new_startup_prewarm_turn_with_sub_id).


### `core/src/session/token_budget.rs`

`domain_logic` · `during each conversation turn`

Large language models can only look at a limited amount of text at once. That limit is called the context window: think of it like the size of the desk the model can spread papers on before it runs out of space. This file watches how much of that desk has been used during a turn.

Its one job is to notice when token usage crosses important percentage marks: 25%, 50%, or 75% of the model's context window. A token is a small piece of text, roughly part of a word. If the feature is turned off, if the model's context size is unknown, or if token use did not actually increase, the file does nothing.

When a threshold is crossed, it calculates how many tokens remain and records that as a contextual user fragment in the current session. This is not shown as ordinary user text; it is extra context stored with the conversation so the system can make better decisions later, such as being more careful with long prompts or preserving room for a response.

The important behavior is that it only records at milestone crossings, not on every turn. That avoids noisy repeated notes while still warning the system at meaningful points.

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

**Purpose**: This function checks whether the conversation has just crossed a token-use milestone, such as 25%, 50%, or 75% of the model's available context space. If it has, it records a small note saying how many tokens are still left.

**Data flow**: It receives the current session, the turn's context, and two token counts: how many tokens were used before sampling and after sampling. It first checks whether the token budget feature is enabled and whether the model's context window is known and valid. It then compares the before and after counts against the milestone percentages. If no milestone was crossed, nothing changes. If one was crossed, it computes the remaining token space, wraps that number into a contextual conversation item, and saves it into the session.

**Call relations**: This function is called by `run_turn` while a conversation turn is being processed. It asks the turn context for the model's context window, builds a `TokenBudgetRemainingContext` note when needed, converts it into a contextual user fragment, and hands that fragment to the session's conversation recorder so future work in the same session can see it.

*Call graph*: calls 3 internal fn (into, new, model_context_window); called by 1 (run_turn); 2 external calls (record_conversation_items, from_ref).


### `core/src/state/additional_context.rs`

`domain_logic` · `request handling`

This file defines `AdditionalContextStore`, a small memory store for “additional context”: named pieces of information that the application can attach to a model request. Think of it like a noticeboard with labeled notes. When a fresh set of notes arrives, the store compares it with what was already on the board. Only notes that are new or whose contents changed are turned into input items for the model.

The file also respects where the context came from. If an entry is marked `Untrusted`, it is wrapped as user-provided context, meaning the system should treat it carefully. If it is marked `Application`, it is wrapped as developer-provided context, meaning it comes from the application itself. This distinction matters because different sources can carry different levels of authority and trust.

After finding the changed entries, the store replaces its saved copy with the full new set. The result is a list of `ResponseInputItem` values ready to be added to the next model request. Without this file, the system would either forget what context it had already sent, or it might resend unchanged context unnecessarily, wasting space and potentially confusing the conversation history.

#### Function details

##### `AdditionalContextStore::merge`  (lines 16–36)

```
fn merge(
        &mut self,
        values: BTreeMap<String, AdditionalContextEntry>,
    ) -> Vec<ResponseInputItem>
```

**Purpose**: Compares a new set of additional context entries with the store’s current entries, then returns model input items only for entries that are new or changed. It also updates the store so future calls know what has already been seen.

**Data flow**: It receives a map of context entries keyed by name, and reads the store’s existing map. For each incoming entry, it checks whether the same key already has the same value. If the entry is different or missing, it converts it into the right kind of model input item: untrusted entries become user-context fragments, and application entries become developer-context fragments. Finally, it replaces the old stored map with the new one and returns the list of changed fragments.

**Call relations**: This method is the store’s update point. When another part of the system has a fresh set of additional context to apply, it calls `AdditionalContextStore::merge`. The method hands back only the pieces that need to be sent onward as `ResponseInputItem` values, while keeping its own saved copy for the next comparison.


### `core/src/context_manager/updates.rs`

`domain_logic` · `turn setup / context update`

A conversation with the model has hidden context around it: the current folder and shell, what commands are allowed, whether realtime mode is on, which model is being used, and so on. This file compares the previous turn’s context with the next turn’s context and creates only the messages needed to explain what changed.

Think of it like sending a change-of-address card instead of mailing someone your full life history again. If nothing changed, it sends nothing. If one setting changed, it creates a short developer or user-facing message describing that specific change.

The file separates updates by topic. One helper checks environment context. Another checks permissions. Others check collaboration mode, realtime status, model-specific instructions, and personality. Each helper returns either a piece of text or a protocol message, or returns nothing when no update is needed.

The main combiner, `build_settings_update_items`, gathers these pieces. Developer-facing updates are grouped into one developer message, while environment changes become a contextual user message. This matters because the model reads different message roles differently: developer messages carry instructions, while user-context messages describe the user’s current surroundings.

#### Function details

##### `build_environment_update_item`  (lines 21–40)

```
fn build_environment_update_item(
    previous: Option<&TurnContextItem>,
    next: &TurnContext,
    shell: &Shell,
) -> Option<ResponseItem>
```

**Purpose**: This checks whether the model needs to be told that the user’s environment changed, such as shell-related context. It avoids sending an update when environment context is disabled, missing, or effectively unchanged.

**Data flow**: It receives the previous turn context, the next turn context, and the current shell. It rebuilds an environment description from both old and new information, compares them while ignoring shell-only differences where appropriate, and produces a contextual user message only if there is a real difference to report.

**Call relations**: During `build_settings_update_items`, this is the environment checker. It relies on environment-context builders and a diff routine to turn old-versus-new state into a model-readable update, then hands that update back so it can be included beside any developer instruction changes.

*Call graph*: calls 5 internal fn (into, diff_from_turn_context_item, from_turn_context, from_turn_context_item, name); called by 1 (build_settings_update_items).


##### `build_permissions_update_item`  (lines 42–71)

```
fn build_permissions_update_item(
    previous: Option<&TurnContextItem>,
    next: &TurnContext,
    exec_policy: &Policy,
) -> Option<String>
```

**Purpose**: This decides whether permission instructions need to be refreshed for the model. It is used when command approval rules or permission profiles change, because the model must know what actions are allowed and what needs review.

**Data flow**: It receives the previous context, the next context, and the execution policy. It first checks whether permission instructions are enabled, then compares the old permission profile and approval policy with the new ones. If they changed, it renders a fresh permissions instruction string using the new settings, feature flags, working directory, and execution policy.

**Call relations**: It is called as one part of `build_settings_update_items`. When it detects a permission change, it hands back text that later gets bundled into a developer message, so the model sees the new rules before acting.

*Call graph*: calls 2 internal fn (permission_profile, from_permission_profile); called by 1 (build_settings_update_items).


##### `build_collaboration_mode_update_item`  (lines 73–92)

```
fn build_collaboration_mode_update_item(
    previous: Option<&TurnContextItem>,
    next: &TurnContext,
) -> Option<String>
```

**Purpose**: This checks whether the collaboration style has changed, such as how actively the model should work with the user. It emits new instructions only when the mode actually changes and there are instructions to say.

**Data flow**: It receives the previous and next turn contexts. If collaboration-mode instructions are disabled, or there is no previous context, it returns nothing. Otherwise it compares the old mode with the new one and, when different, renders the new collaboration guidance if that mode has any developer instructions.

**Call relations**: It is used inside `build_settings_update_items` as the collaboration-mode section of the developer update. If it produces text, that text is later combined with other setting changes into one developer message.

*Call graph*: calls 1 internal fn (from_collaboration_mode); called by 1 (build_settings_update_items).


##### `build_realtime_update_item`  (lines 94–121)

```
fn build_realtime_update_item(
    previous: Option<&TurnContextItem>,
    previous_turn_settings: Option<&PreviousTurnSettings>,
    next: &TurnContext,
) -> Option<String>
```

**Purpose**: This decides whether to tell the model that realtime mode has started or stopped. Realtime mode is treated specially because the model needs clear instructions when live interaction becomes active or inactive.

**Data flow**: It receives the previous context, saved settings from the previous turn, and the next context. It compares the old realtime state with the new one. If realtime turns off, it returns an ending instruction. If realtime turns on, it returns either custom start instructions from configuration or a default start instruction. If there is no meaningful change, it returns nothing.

**Call relations**: This helper is used both when building initial realtime context through `build_initial_realtime_item` and when collecting per-turn setting updates through `build_settings_update_items`. It delegates the final wording to realtime instruction builders, then passes the rendered text back to its caller.

*Call graph*: calls 2 internal fn (new, new); called by 2 (build_initial_realtime_item, build_settings_update_items).


##### `build_initial_realtime_item`  (lines 123–129)

```
fn build_initial_realtime_item(
    previous: Option<&TurnContextItem>,
    previous_turn_settings: Option<&PreviousTurnSettings>,
    next: &TurnContext,
) -> Option<String>
```

**Purpose**: This provides the realtime-mode instruction for initial context creation. It is a thin wrapper so initial setup can use the same realtime-change logic as later updates.

**Data flow**: It receives the same previous context, previous settings, and next context used for realtime comparison. It passes them directly into `build_realtime_update_item` and returns whatever that function decides: a start message, an end message, or nothing.

**Call relations**: It is called by `build_initial_context` when the system is assembling the first model-visible context for a turn. Rather than duplicating realtime rules, it hands the decision to `build_realtime_update_item`.

*Call graph*: calls 1 internal fn (build_realtime_update_item); called by 1 (build_initial_context).


##### `build_personality_update_item`  (lines 131–153)

```
fn build_personality_update_item(
    previous: Option<&TurnContextItem>,
    next: &TurnContext,
    personality_feature_enabled: bool,
) -> Option<String>
```

**Purpose**: This checks whether the model’s personality setting changed and whether the model should be told about that change. It only works when the personality feature is enabled and the model itself has not changed.

**Data flow**: It receives the previous context, next context, and a flag saying whether personality support is enabled. It stops early if the feature is off, if there is no previous context, or if the model changed. If the personality changed, it asks `personality_message_for` for the model-specific wording and wraps that wording as personality instructions.

**Call relations**: It is called from `build_settings_update_items` as one possible developer update section. It uses `personality_message_for` to find the right text, then returns rendered instructions to be bundled with other developer-facing changes.

*Call graph*: calls 1 internal fn (personality_message_for); called by 1 (build_settings_update_items).


##### `personality_message_for`  (lines 155–164)

```
fn personality_message_for(
    model_info: &ModelInfo,
    personality: Personality,
) -> Option<String>
```

**Purpose**: This looks up the text that explains a chosen personality for a specific model. It returns nothing if the model has no such message or the message is empty.

**Data flow**: It receives model information and a personality value. It checks the model’s stored message definitions, asks for the message matching that personality, filters out blank text, and returns the usable message if one exists.

**Call relations**: It is used by `build_personality_update_item` when personality changes during an update, and by `build_initial_context` when personality instructions are needed during initial context creation.

*Call graph*: called by 2 (build_personality_update_item, build_initial_context).


##### `build_model_instructions_update_item`  (lines 166–181)

```
fn build_model_instructions_update_item(
    previous_turn_settings: Option<&PreviousTurnSettings>,
    next: &TurnContext,
) -> Option<String>
```

**Purpose**: This creates instructions for the model when the selected model changes between turns. That matters because different models may need different guidance to behave correctly.

**Data flow**: It receives saved settings from the previous turn and the next turn context. It compares the old model name with the new model name. If the model changed, it asks the new model for its instructions, and if those instructions are not empty, wraps them as a model-switch instruction string.

**Call relations**: It is called by `build_settings_update_items` and also by `build_initial_context`. In the settings update flow, its result is intentionally placed first among developer updates so the model reads model-specific guidance before other context changes.

*Call graph*: calls 1 internal fn (new); called by 2 (build_settings_update_items, build_initial_context).


##### `build_developer_update_item`  (lines 183–185)

```
fn build_developer_update_item(text_sections: Vec<String>) -> Option<ResponseItem>
```

**Purpose**: This turns one or more developer instruction sections into a single developer message for the model. Developer messages are used for system guidance rather than ordinary user content.

**Data flow**: It receives a list of text sections. It passes them to `build_text_message` with the role set to `developer`, and returns the resulting protocol message if there is at least one section.

**Call relations**: It is used by `build_settings_update_items` after individual update helpers have produced instruction text. It is also used by `build_initial_context` and `spawn_forked_thread` when those flows need to package developer guidance in the same message format.

*Call graph*: calls 1 internal fn (build_text_message); called by 3 (spawn_forked_thread, build_settings_update_items, build_initial_context).


##### `build_contextual_user_message`  (lines 187–189)

```
fn build_contextual_user_message(text_sections: Vec<String>) -> Option<ResponseItem>
```

**Purpose**: This turns context text into a user-role message. It is used for information that describes the user’s situation, rather than instructions from the developer.

**Data flow**: It receives a list of text sections. It passes them to `build_text_message` with the role set to `user`, and returns a message only when there is text to include.

**Call relations**: It is called by `build_initial_context` when initial user-context material needs to be represented as a protocol message. It shares the common message-building path with `build_developer_update_item`.

*Call graph*: calls 1 internal fn (build_text_message); called by 1 (build_initial_context).


##### `build_text_message`  (lines 191–208)

```
fn build_text_message(role: &str, text_sections: Vec<String>) -> Option<ResponseItem>
```

**Purpose**: This is the common helper that packages plain text sections into a protocol message with a chosen role. It keeps developer and user message construction consistent.

**Data flow**: It receives a role name, such as `developer` or `user`, and a list of text sections. If the list is empty, it returns nothing. Otherwise it wraps each text section as an input-text content item and returns a message object containing those content items.

**Call relations**: It sits underneath `build_developer_update_item` and `build_contextual_user_message`. Those higher-level helpers choose the role, while this function performs the shared packaging work.

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

**Purpose**: This is the main collector for per-turn context updates. It asks each topic-specific helper what changed, then returns the model-visible messages needed to explain those changes.

**Data flow**: It receives the previous context, previous turn settings, the next context, shell information, execution policy, and a personality-feature flag. It builds an optional contextual user message for environment changes, gathers developer instruction sections for model, permissions, collaboration mode, realtime mode, and personality changes, then returns a small list of response items containing only the messages that are needed.

**Call relations**: This function is the central flow that brings the smaller update builders together. The call graph records it as part of the settings-update path, and inside that path it calls the environment, model, permissions, collaboration, realtime, personality, and developer-message helpers so their separate decisions become one ordered update package.

*Call graph*: calls 7 internal fn (build_collaboration_mode_update_item, build_developer_update_item, build_environment_update_item, build_model_instructions_update_item, build_permissions_update_item, build_personality_update_item, build_realtime_update_item); called by 1 (build_settings_update_items); 1 external calls (with_capacity).


### Transcript normalization and history
These files organize the context manager surface and its core transcript-processing pipeline from normalization helpers to prompt-ready history assembly.

### `core/src/context_manager/mod.rs`

`other` · `cross-cutting`

This file does not contain the context-management logic itself. Instead, it acts like a small table of contents and public counter for the `context_manager` folder. The actual work is split into nearby files: `history` keeps track of conversation history, `normalize` likely prepares or cleans conversation data into a consistent shape, and `updates` is made available to the rest of the crate for code that needs to apply changes to context.

The important job here is deciding what names outside code can reach. It re-exports `ContextManager`, which is the main type other parts of the program use when they need to work with conversation context. It also re-exports two helper functions: `is_user_turn_boundary`, which identifies where a user turn begins or ends in the history, and `truncate_function_output_payload`, which shortens function output content so the stored context does not grow too large.

Without this file, callers would need to know the internal file layout of the context manager module. By providing a single doorway, the project can move implementation details around while keeping the rest of the codebase stable.


### `core/src/context_manager/normalize.rs`

`domain_logic` · `context normalization before model requests`

A conversation with the assistant is not just text. It can include tool calls, shell commands, search requests, tool outputs, and images. Those items need to form a valid story: if the assistant says “run this tool,” there should be a matching result; if there is a result, there should be a matching call. This file is the cleanup station for that story.

Its main job is to normalize a list of ResponseItem values, which are the saved pieces of a conversation. First, it can add safe placeholder outputs for calls that never got a result, usually marking them as “aborted.” This prevents later code or an API from seeing an unfinished tool call. Second, it removes outputs that no longer have a matching call, because those are like receipts without purchases. Third, when one item is removed, it can also remove its partner item so the history stays balanced. Finally, it replaces image content with a short text notice when the model being used does not support image input. For generated image results, it clears the stored image result entirely.

The important idea is consistency. Without this file, the system could send broken conversation history to a model, confuse later context trimming, or accidentally include image content where it is not allowed.

#### Function details

##### `ensure_call_outputs_present`  (lines 14–118)

```
fn ensure_call_outputs_present(items: &mut Vec<ResponseItem>)
```

**Purpose**: This function makes sure every recorded tool-like call has a matching output item. If a call has no result, it inserts a synthetic result such as “aborted” so the conversation history does not contain an unfinished action.

**Data flow**: It receives a mutable list of conversation items. It first scans the list to collect the IDs of outputs that already exist. It then scans the calls and finds calls whose IDs are missing from those output sets. For each missing result, it prepares a placeholder output and later inserts it immediately after the call. The original list is changed in place, with missing outputs filled in.

**Call relations**: This is called during normalize_history, when the system is preparing conversation history for safe reuse. When it finds missing function or search outputs, it logs what happened. For custom tool calls and local shell calls, it reports the problem through error_or_panic because those missing outputs are considered more serious, then still inserts an “aborted” placeholder so the history can remain structurally valid.

*Call graph*: calls 2 internal fn (error_or_panic, from_text); called by 1 (normalize_history); 4 external calls (new, new, format!, info!).


##### `remove_orphan_outputs`  (lines 120–193)

```
fn remove_orphan_outputs(items: &mut Vec<ResponseItem>)
```

**Purpose**: This function removes tool output items that no longer have a matching call item. It keeps the history from containing unexplained results that would not make sense to a model or later cleanup code.

**Data flow**: It receives a mutable list of conversation items. It gathers the call IDs for function calls, tool search calls, local shell calls, and custom tool calls. Then it walks through the list and keeps only outputs whose call ID appears in the matching call set. Outputs with no matching call are removed from the list, and the function may report the inconsistency before removing them. Some server-side or ID-less search outputs are allowed to stay.

**Call relations**: This is called by normalize_history as part of the same cleanup pass that keeps conversation records well-formed. It complements ensure_call_outputs_present: one function fills in missing results for calls, while this one removes results that have lost their calls.

*Call graph*: called by 1 (normalize_history).


##### `remove_corresponding_for`  (lines 195–280)

```
fn remove_corresponding_for(items: &mut Vec<ResponseItem>, item: &ResponseItem)
```

**Purpose**: This function removes the partner item for a given conversation item. For example, if a function call is being removed, it removes the matching function output too, so the history does not become half-broken.

**Data flow**: It receives the full mutable item list and a single item that is being removed or considered for removal. It checks what kind of item that single item is and extracts its call ID if it has one. Then it searches the list for the matching opposite item: call to output, output to call, search call to search output, custom tool call to custom tool output, or local shell call to function output. If it finds a match, it removes the first one from the list.

**Call relations**: This is called by remove_first_item when higher-level context trimming removes one item and needs to keep the remaining history consistent. It delegates the repeated “find the first item matching this condition and remove it” work to remove_first_matching.

*Call graph*: calls 1 internal fn (remove_first_matching); called by 1 (remove_first_item).


##### `remove_first_matching`  (lines 282–289)

```
fn remove_first_matching(items: &mut Vec<ResponseItem>, predicate: F)
```

**Purpose**: This small helper removes the first conversation item that satisfies a provided test. It exists so the pairing logic in remove_corresponding_for does not have to repeat the same search-and-remove pattern many times.

**Data flow**: It receives a mutable list and a predicate, which is a small yes-or-no test for each item. It searches from the start of the list until the predicate says an item matches. If a match is found, that item is removed. If no match is found, the list is left unchanged.

**Call relations**: This helper is used only by remove_corresponding_for. In the bigger flow, remove_corresponding_for decides what kind of partner item is needed, and this helper performs the actual removal once given the matching rule.

*Call graph*: called by 1 (remove_corresponding_for).


##### `strip_images_when_unsupported`  (lines 293–343)

```
fn strip_images_when_unsupported(
    input_modalities: &[InputModality],
    items: &mut [ResponseItem],
)
```

**Purpose**: This function removes or replaces image content when the selected model cannot accept images. It prevents the system from sending unsupported image data while still leaving a clear note that image content was present.

**Data flow**: It receives the model’s supported input types and a mutable slice of conversation items. If the supported input types include images, it does nothing. Otherwise, it walks through each item. In normal messages, image parts are replaced with a text placeholder saying the image was omitted. In function and custom tool outputs, image output parts are replaced with the same placeholder. In image generation call results, the stored result is cleared. The item list remains the same shape, but unsupported image data is removed or replaced.

**Call relations**: This is called by normalize_history when preparing history for a particular model. It acts after the system knows what the model can accept, making the history compatible with text-only models instead of letting image-bearing items reach a place that cannot process them.

*Call graph*: called by 1 (normalize_history); 3 external calls (with_capacity, iter_mut, contains).


### `core/src/context_manager/history.rs`

`domain_logic` · `cross-cutting during conversation turns, rollback, compaction, and prompt preparation`

A chat with an AI model is not just a list of human and assistant messages. It can include tool calls, tool results, hidden reasoning summaries, images, context updates, and bookkeeping about token usage. This file is the notebook that stores those items in order, from oldest to newest, and prepares them safely before they are reused.

The central type is `ContextManager`. It records only items that are meant for the API, skips system-only or internal trigger items, and truncates large tool outputs as they enter the history. Before history is sent to the model, it normalizes it: every tool call must have a matching output, orphaned outputs are removed, and images are stripped if the selected model cannot accept images. This is like checking a receipt before submitting it: every charge needs its matching line item, and unsupported attachments are removed.

The file also supports rollback, replacing history after compaction, replacing recent tool images with placeholder text, and estimating token use. Tokens are chunks of text or image cost that count against the model's context window. The estimates here are deliberately rough but useful for deciding when history may need trimming.

#### Function details

##### `ContextManager::new`  (lines 54–63)

```
fn new() -> Self
```

**Purpose**: Creates an empty conversation history with initial token bookkeeping ready. This is used whenever a new history tracker is needed.

**Data flow**: It starts with no recorded response items, sets the history version to zero, asks the token usage helper to create initial usage information, and leaves the reference context snapshot empty. The result is a fresh `ContextManager` ready to record future items.

**Call relations**: Higher-level setup and tests call this when they need a blank history. It relies on `TokenUsageInfo::new_or_append` to create the starting token information instead of inventing that structure itself.

*Call graph*: calls 1 internal fn (new_or_append); called by 7 (create_history_with_items, record_items_respects_custom_token_limit, record_items_truncates_custom_tool_call_output_content, record_items_truncates_function_call_output_content, reconstruct_history_from_rollout, sample_rollout, new); 1 external calls (new).


##### `ContextManager::token_info`  (lines 65–67)

```
fn token_info(&self) -> Option<TokenUsageInfo>
```

**Purpose**: Returns the current token usage information, if any. Callers use this to inspect how much of the model's context window has been used.

**Data flow**: It reads the stored optional token information and returns a cloned copy. Nothing inside the history is changed.

**Call relations**: This is a small read-only doorway used by outside code that wants token accounting without direct access to the internal fields.

*Call graph*: called by 1 (token_info).


##### `ContextManager::set_token_info`  (lines 69–71)

```
fn set_token_info(&mut self, info: Option<TokenUsageInfo>)
```

**Purpose**: Replaces the stored token usage information. This is useful when another part of the system has recalculated or restored token accounting.

**Data flow**: It receives optional token usage information and stores it in the manager. The previous token information is overwritten.

**Call relations**: Outside wrapper code calls this as a setter. It does not call other helpers because it simply updates the saved value.

*Call graph*: called by 1 (set_token_info).


##### `ContextManager::set_reference_context_item`  (lines 73–75)

```
fn set_reference_context_item(&mut self, item: Option<TurnContextItem>)
```

**Purpose**: Sets the saved context snapshot used as a baseline for future context differences. This lets later turns send only changed context when that is safe.

**Data flow**: It receives an optional `TurnContextItem` and stores it as the current reference snapshot. If `None` is passed, the baseline is cleared.

**Call relations**: History replacement and setter paths call this when the context baseline needs to be updated alongside the transcript.

*Call graph*: called by 2 (replace_history, set_reference_context_item).


##### `ContextManager::reference_context_item`  (lines 77–79)

```
fn reference_context_item(&self) -> Option<TurnContextItem>
```

**Purpose**: Returns the saved reference context snapshot, if one exists. Callers use this to decide what context changes need to be shown to the model.

**Data flow**: It reads the stored optional reference context item and returns a cloned copy. The history itself is not changed.

**Call relations**: This is the read side of the reference-context state that is written by `ContextManager::set_reference_context_item` and sometimes cleared during rollback.

*Call graph*: called by 1 (reference_context_item).


##### `ContextManager::set_token_usage_full`  (lines 81–88)

```
fn set_token_usage_full(&mut self, context_window: i64)
```

**Purpose**: Marks the token usage as filling the whole model context window. This is used when the system knows the history should be treated as completely full.

**Data flow**: It receives a context-window size. If token information already exists, it updates it to show the window as full; otherwise it creates new full-window token information.

**Call relations**: External token-accounting code calls this. When it must create new information, it delegates to `TokenUsageInfo::full_context_window`.

*Call graph*: calls 1 internal fn (full_context_window); called by 1 (set_token_usage_full).


##### `ContextManager::record_items`  (lines 91–105)

```
fn record_items(&mut self, items: I, policy: TruncationPolicy)
```

**Purpose**: Adds new response items to the stored history, while filtering out items that should not be sent back to the API and trimming oversized tool outputs. This is the normal way new conversation events enter the transcript.

**Data flow**: It receives items in oldest-to-newest order plus a truncation policy. For each item, it checks whether it belongs in API history; accepted items are processed, possibly shortened, and appended to the internal list.

**Call relations**: The public recording path calls this when new turn items arrive. It asks `is_api_message` whether each item should be kept, then sends kept items through `ContextManager::process_item` before storing them.

*Call graph*: calls 2 internal fn (process_item, is_api_message); called by 1 (record_items).


##### `ContextManager::for_prompt`  (lines 111–114)

```
fn for_prompt(mut self, input_modalities: &[InputModality]) -> Vec<ResponseItem>
```

**Purpose**: Consumes the history manager and returns the cleaned list of items to send to the model. This is the final preparation step before building a prompt.

**Data flow**: It receives the model's supported input types, such as whether images are allowed. It normalizes the stored history using those capabilities, then returns the internal item list.

**Call relations**: Prompt-building code uses this when it is done editing history. It calls `ContextManager::normalize_history` so the returned transcript has matching tool calls and outputs and no unsupported images.

*Call graph*: calls 1 internal fn (normalize_history).


##### `ContextManager::raw_items`  (lines 117–119)

```
fn raw_items(&self) -> &[ResponseItem]
```

**Purpose**: Returns a read-only view of the stored history exactly as it is currently kept. This is useful for trimming or inspection code that needs the raw transcript.

**Data flow**: It reads the internal item vector and returns it as a slice. No normalization, truncation, or mutation happens.

**Call relations**: History-trimming code calls this when it needs to examine the current stored items before deciding what to remove.

*Call graph*: called by 1 (trim_function_call_history_to_fit_context_window).


##### `ContextManager::into_raw_items`  (lines 122–124)

```
fn into_raw_items(self) -> Vec<ResponseItem>
```

**Purpose**: Consumes the manager and returns its stored items without cleaning or changing them. This is useful when ownership of the raw transcript needs to move elsewhere.

**Data flow**: It takes the whole `ContextManager`, extracts the internal item vector, and returns it. After this, the manager no longer exists.

**Call relations**: This is a transfer method rather than part of prompt cleanup. Unlike `ContextManager::for_prompt`, it does not call normalization first.


##### `ContextManager::history_version`  (lines 126–128)

```
fn history_version(&self) -> u64
```

**Purpose**: Returns the current history version number. Callers can use this number to notice that the stored history has been rewritten.

**Data flow**: It reads the internal version counter and returns it. The counter is not changed.

**Call relations**: The version is increased by rewrite operations such as `ContextManager::replace` and image replacement; this getter exposes that signal to the rest of the system.


##### `ContextManager::estimate_token_count`  (lines 132–139)

```
fn estimate_token_count(&self, turn_context: &TurnContext) -> Option<i64>
```

**Purpose**: Gives a rough estimate of how many tokens the current history plus base instructions will cost. Tokens are the model's unit for context size, and this estimate helps decide when trimming may be needed.

**Data flow**: It reads model and personality information from the turn context, builds the base instruction text for that model, and passes that to the more direct estimation function. It returns an optional integer token estimate.

**Call relations**: Callers use this when they have a full `TurnContext`. This method gathers the right base instructions, then delegates the actual counting to `ContextManager::estimate_token_count_with_base_instructions`.

*Call graph*: calls 1 internal fn (estimate_token_count_with_base_instructions).


##### `ContextManager::estimate_token_count_with_base_instructions`  (lines 141–155)

```
fn estimate_token_count_with_base_instructions(
        &self,
        base_instructions: &BaseInstructions,
    ) -> Option<i64>
```

**Purpose**: Estimates token use when the caller already knows the base instruction text. This avoids needing a full turn context just to count approximate size.

**Data flow**: It receives base instructions, estimates their token count from their text length, estimates each stored history item, adds the numbers with overflow protection, and returns the total estimate.

**Call relations**: This is called both by `ContextManager::estimate_token_count` and by trimming code that checks whether history fits in the context window. It uses shared approximate-count helpers rather than a full tokenizer.

*Call graph*: called by 2 (trim_function_call_history_to_fit_context_window, estimate_token_count); 2 external calls (approx_token_count, try_from).


##### `ContextManager::remove_first_item`  (lines 157–167)

```
fn remove_first_item(&mut self)
```

**Purpose**: Removes the oldest item from history while keeping tool call/output pairs consistent. This is useful when shaving history from the front.

**Data flow**: It checks whether any items exist. If so, it removes index zero, then asks the normalization helper to remove the corresponding call or output partner if the removed item belonged to such a pair.

**Call relations**: This method performs a small, targeted cleanup instead of running a full normalization pass. It delegates pair cleanup to `normalize::remove_corresponding_for`.

*Call graph*: calls 1 internal fn (remove_corresponding_for).


##### `ContextManager::replace`  (lines 169–172)

```
fn replace(&mut self, items: Vec<ResponseItem>)
```

**Purpose**: Replaces the entire stored history and marks the history as rewritten. This is used after larger edits such as compaction, rollback, or context-window trimming.

**Data flow**: It receives a new vector of response items, stores it as the current history, and increments the history version counter using saturating arithmetic so it cannot overflow badly.

**Call relations**: Trimming, rollback, and history-replacement flows call this after they have built the new transcript. The version bump lets observers know the old history no longer matches.

*Call graph*: called by 3 (trim_function_call_history_to_fit_context_window, drop_last_n_user_turns, replace_history).


##### `ContextManager::replace_last_turn_images`  (lines 176–206)

```
fn replace_last_turn_images(&mut self, placeholder: &str) -> bool
```

**Purpose**: Replaces image content in the most recent tool output with placeholder text. This is useful when the system must keep the fact that a tool returned something but should no longer retain the image data.

**Data flow**: It searches backward for the latest tool-output item or user-turn boundary. If it finds a function-call output, it walks its content items and changes any image item into a text placeholder, then bumps the history version if anything changed.

**Call relations**: This is a focused rewrite used after a turn has been recorded. It does not normalize the whole history; it only edits the most recent eligible tool output and reports whether it changed anything.

*Call graph*: 1 external calls (matches!).


##### `ContextManager::drop_last_n_user_turns`  (lines 224–247)

```
fn drop_last_n_user_turns(&mut self, num_turns: u32)
```

**Purpose**: Rolls back the last N user-style instruction turns from the history. This lets the session undo recent conversation turns without throwing away earlier setup items.

**Data flow**: It receives a number of turns to drop. It finds all user-turn boundaries, chooses where the cut should happen, trims nearby contextual update messages when needed, and replaces the stored history with the surviving prefix.

**Call relations**: Rollback code calls this. It uses `user_message_positions` to find turn boundaries, `ContextManager::trim_pre_turn_context_updates` to remove context-only messages attached to the rolled-back turn, and `ContextManager::replace` to commit the shortened history.

*Call graph*: calls 3 internal fn (replace, trim_pre_turn_context_updates, user_message_positions); 1 external calls (try_from).


##### `ContextManager::update_token_info`  (lines 249–259)

```
fn update_token_info(
        &mut self,
        usage: &TokenUsage,
        model_context_window: Option<i64>,
    )
```

**Purpose**: Adds the latest model-reported token usage to the stored token accounting. This keeps the history's size estimate in sync with responses from the model service.

**Data flow**: It receives a token-usage report and an optional model context-window size. It combines that report with any existing token info and stores the updated result.

**Call relations**: External token-update code calls this after usage information is available. It delegates the merge logic to `TokenUsageInfo::new_or_append`.

*Call graph*: calls 1 internal fn (new_or_append); called by 1 (update_token_info_from_usage); 1 external calls (clone).


##### `ContextManager::get_non_last_reasoning_items_tokens`  (lines 261–281)

```
fn get_non_last_reasoning_items_tokens(&self) -> i64
```

**Purpose**: Estimates tokens for older encrypted reasoning items that may not be included in the latest server token report. This prevents undercounting when older reasoning still occupies context.

**Data flow**: It finds the last user-turn boundary. It then looks only before that boundary, selects encrypted reasoning items, estimates each one's token cost, and returns the sum.

**Call relations**: This helper is used by `ContextManager::get_total_token_usage` when the server's usage report does not already include past reasoning tokens.

*Call graph*: called by 1 (get_total_token_usage).


##### `ContextManager::items_after_last_model_generated_item`  (lines 285–292)

```
fn items_after_last_model_generated_item(&self) -> &[ResponseItem]
```

**Purpose**: Finds local items added after the most recent model-generated item. These items may not be included in the last token usage reported by the model service.

**Data flow**: It scans backward for the latest item produced by the model. It returns a slice of everything after that item, or an empty tail position if there is nothing after it.

**Call relations**: Both total-token and post-model-token estimators call this. It depends on `is_model_generated_item` to decide where the server-accounted portion of history likely ends.

*Call graph*: called by 2 (estimated_tokens_after_last_model_generated_item, get_total_token_usage).


##### `ContextManager::get_total_token_usage`  (lines 296–314)

```
fn get_total_token_usage(&self, server_reasoning_included: bool) -> i64
```

**Purpose**: Returns the best available estimate of total token usage for the current history. It combines server-reported usage with client-side estimates for items the server may not have counted yet.

**Data flow**: It starts with the last total token count from stored token info, or zero. It adds estimated tokens for items added after the last model-generated item, and, if needed, also adds older reasoning tokens.

**Call relations**: External token-reporting code calls this. It uses `ContextManager::items_after_last_model_generated_item` for local additions and `ContextManager::get_non_last_reasoning_items_tokens` when server reasoning is not already included.

*Call graph*: calls 2 internal fn (get_non_last_reasoning_items_tokens, items_after_last_model_generated_item); called by 1 (get_total_token_usage).


##### `ContextManager::estimated_tokens_after_last_model_generated_item`  (lines 316–321)

```
fn estimated_tokens_after_last_model_generated_item(&self) -> i64
```

**Purpose**: Estimates how many tokens have been added locally since the model last produced an item. This is useful for checking extra context that the server has not yet counted.

**Data flow**: It gets the slice of items after the last model-generated item, estimates each item's token cost, and returns their sum.

**Call relations**: This is a narrow version of the logic used by `ContextManager::get_total_token_usage`. It calls `ContextManager::items_after_last_model_generated_item` to find the relevant tail of history.

*Call graph*: calls 1 internal fn (items_after_last_model_generated_item).


##### `ContextManager::normalize_history`  (lines 327–336)

```
fn normalize_history(&mut self, input_modalities: &[InputModality])
```

**Purpose**: Cleans the stored history so it is safe to send to the model. It enforces matching tool calls and outputs, and removes image content when the model cannot accept images.

**Data flow**: It receives the supported input modalities and mutates the internal item list. Missing tool outputs are added where needed, orphaned outputs are removed, and unsupported images are stripped.

**Call relations**: `ContextManager::for_prompt` calls this as the final cleanup step before returning prompt items. The detailed cleanup work is delegated to helper functions in the `normalize` module.

*Call graph*: calls 3 internal fn (ensure_call_outputs_present, remove_orphan_outputs, strip_images_when_unsupported); called by 1 (for_prompt).


##### `ContextManager::process_item`  (lines 338–376)

```
fn process_item(&self, item: &ResponseItem, policy: TruncationPolicy) -> ResponseItem
```

**Purpose**: Prepares one item before it is stored in history. Its main job is to shorten large function or custom-tool outputs so they do not overwhelm future prompts.

**Data flow**: It receives a response item and a truncation policy. Tool-output payloads are copied with their output text or content shortened; other item kinds are cloned unchanged.

**Call relations**: `ContextManager::record_items` calls this for each API-visible item. When truncation is needed, it hands the payload to `truncate_function_output_payload`.

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

**Purpose**: During rollback, removes context-update messages that sit immediately before the turn being removed. This prevents stale context updates from surviving after the user turn they belonged to is gone.

**Data flow**: It receives the old history snapshot, the first eligible turn boundary, and a proposed cut index. It walks backward from the cut over contextual developer or user messages, adjusts the cut point, and may clear the reference context baseline if a mixed developer bundle was trimmed.

**Call relations**: `ContextManager::drop_last_n_user_turns` calls this before committing rollback. It uses context-detection helpers from event mapping to tell normal messages apart from context-only update messages.

*Call graph*: calls 3 internal fn (has_non_contextual_dev_message_content, is_contextual_dev_message_content, is_contextual_user_message_content); called by 1 (drop_last_n_user_turns).


##### `truncate_function_output_payload`  (lines 426–443)

```
fn truncate_function_output_payload(
    output: &FunctionCallOutputPayload,
    policy: TruncationPolicy,
) -> FunctionCallOutputPayload
```

**Purpose**: Shortens a function-call output payload according to a truncation policy. This keeps tool results from becoming too large for later model turns.

**Data flow**: It receives a payload and a policy. If the payload is plain text, it truncates the text; if it is structured content items, it truncates those items with the output-truncation helper. It returns a new payload with the same success flag.

**Call relations**: `ContextManager::process_item` calls this when recording function-call or custom-tool-call outputs. It delegates the actual text and item shortening to shared truncation utilities.

*Call graph*: called by 1 (process_item); 4 external calls (truncate_function_output_items_with_policy, truncate_text, ContentItems, Text).


##### `is_api_message`  (lines 448–467)

```
fn is_api_message(message: &ResponseItem) -> bool
```

**Purpose**: Decides whether a response item belongs in the API-visible conversation history. It filters out system messages and internal-only items that should not be replayed to the model.

**Data flow**: It receives one response item and checks its kind and, for messages, its role. It returns true for user, assistant, tool, reasoning, search, shell, compaction, and similar API-visible items, and false for system, compaction-trigger, and unknown items.

**Call relations**: `ContextManager::record_items` calls this before storing each incoming item. It acts as the gatekeeper for what enters long-term prompt history.

*Call graph*: called by 1 (record_items).


##### `estimate_reasoning_length`  (lines 469–475)

```
fn estimate_reasoning_length(encoded_len: usize) -> usize
```

**Purpose**: Approximates the original byte length of encrypted reasoning content from its encoded length. This helps estimate token cost without decrypting the content.

**Data flow**: It receives the encoded string length, converts from base64-like size toward raw bytes, subtracts a fixed overhead, and returns a non-negative estimate.

**Call relations**: `estimate_response_item_model_visible_bytes` uses this for reasoning and compaction items that contain encrypted content.

*Call graph*: called by 1 (estimate_response_item_model_visible_bytes).


##### `estimate_encrypted_function_output_length`  (lines 477–479)

```
fn estimate_encrypted_function_output_length(encoded_len: usize) -> usize
```

**Purpose**: Approximates the model-visible size of encrypted function-output content. This avoids counting the encrypted text exactly as if it were normal visible text.

**Data flow**: It receives an encrypted string length and applies a fixed ratio calculation with ceiling division. The returned number is an estimated byte size.

**Call relations**: This helper supports encrypted output size adjustment. It is used when estimating the replacement cost for encrypted function-output content.


##### `estimate_item_token_count`  (lines 481–484)

```
fn estimate_item_token_count(item: &ResponseItem) -> i64
```

**Purpose**: Estimates the token cost of one response item. This turns a model-visible byte estimate into the rough token unit used for context-window decisions.

**Data flow**: It receives one response item, estimates how many bytes of model-visible content it represents, converts that byte count to approximate tokens, and returns the result.

**Call relations**: Token-counting methods use this repeatedly across history items. It delegates the item-specific byte estimate to `estimate_response_item_model_visible_bytes`.

*Call graph*: calls 1 internal fn (estimate_response_item_model_visible_bytes); 1 external calls (approx_tokens_from_byte_count_i64).


##### `estimate_response_item_model_visible_bytes`  (lines 508–540)

```
fn estimate_response_item_model_visible_bytes(item: &ResponseItem) -> i64
```

**Purpose**: Estimates how many bytes of a response item should count as visible context for the model. It pays special attention to encrypted content and inline images, where raw JSON size can be misleading.

**Data flow**: It receives one response item. Encrypted reasoning-like items use a special length estimate; other items are serialized to JSON, then adjusted by replacing large inline image payloads and encrypted output payloads with more realistic estimated costs.

**Call relations**: `estimate_item_token_count` calls this as the main size estimator. It uses `estimate_reasoning_length`, `image_data_url_estimate_adjustment`, and `encrypted_function_output_estimate_adjustment` for special cases.

*Call graph*: calls 3 internal fn (encrypted_function_output_estimate_adjustment, estimate_reasoning_length, image_data_url_estimate_adjustment); called by 1 (estimate_item_token_count); 2 external calls (try_from, to_string).


##### `parse_base64_image_data_url`  (lines 547–574)

```
fn parse_base64_image_data_url(url: &str) -> Option<&str>
```

**Purpose**: Checks whether a URL is an inline base64 image data URL and, if so, returns just its encoded payload. This lets the estimator treat embedded image bytes differently from ordinary text.

**Data flow**: It receives a URL string. It verifies that it starts with a data URL scheme, has an image media type, includes a base64 marker, and contains a comma separator; if all checks pass, it returns the payload after the comma.

**Call relations**: Image token-estimation code uses this before discounting or decoding image data. Non-image or non-base64 URLs are left alone by returning `None`.


##### `estimate_original_image_bytes`  (lines 576–610)

```
fn estimate_original_image_bytes(image_url: &str) -> Option<i64>
```

**Purpose**: Estimates the token-equivalent byte cost for an inline image requested at original detail. Original-detail images are counted by image patches rather than by the raw base64 string length.

**Data flow**: It receives an image data URL, hashes it for cache lookup, parses and decodes the base64 payload, loads the image to learn its width and height, computes the number of 32-pixel patches up to a maximum, and returns an approximate byte cost. Failed parsing or decoding returns no estimate.

**Call relations**: Image adjustment code calls this for `detail: original` images. It uses a small least-recently-used cache keyed by SHA-1 digest so repeated estimates for the same image do not decode it again.

*Call graph*: 1 external calls (sha1_digest).


##### `image_data_url_estimate_adjustment`  (lines 616–657)

```
fn image_data_url_estimate_adjustment(item: &ResponseItem) -> (i64, i64)
```

**Purpose**: Finds inline base64 images inside one response item and calculates how to adjust their size estimate. This prevents huge base64 strings from being counted as ordinary text.

**Data flow**: It receives a response item, scans message content and tool-output content for image items, and adds up two totals: the raw base64 payload bytes to subtract and the estimated image cost bytes to add back.

**Call relations**: `estimate_response_item_model_visible_bytes` calls this after serializing an item. For original-detail images it may call `estimate_original_image_bytes`; otherwise it uses a fixed resized-image estimate.

*Call graph*: called by 1 (estimate_response_item_model_visible_bytes).


##### `encrypted_function_output_estimate_adjustment`  (lines 659–682)

```
fn encrypted_function_output_estimate_adjustment(item: &ResponseItem) -> (i64, i64)
```

**Purpose**: Finds encrypted content inside function-call outputs and calculates a fairer size adjustment for token estimation. This avoids treating encrypted payload text as if every encoded byte were normal model-visible text.

**Data flow**: It receives a response item. If the item is a function-call output with structured content items, it sums encrypted payload lengths to subtract and estimated replacement lengths to add; otherwise it returns zero adjustments.

**Call relations**: `estimate_response_item_model_visible_bytes` calls this as part of its serialized-size correction. It uses `estimate_encrypted_function_output_length` for each encrypted content item.

*Call graph*: called by 1 (estimate_response_item_model_visible_bytes).


##### `is_model_generated_item`  (lines 684–703)

```
fn is_model_generated_item(item: &ResponseItem) -> bool
```

**Purpose**: Decides whether a history item was generated by the model. This helps separate content already reflected in the last server token report from local additions afterward.

**Data flow**: It receives a response item and returns true for assistant messages, reasoning, model-issued tool calls, searches, shell calls, and compaction items. It returns false for tool outputs, agent messages, triggers, and miscellaneous items.

**Call relations**: `ContextManager::items_after_last_model_generated_item` uses this while scanning backward through history to find the latest model-produced boundary.


##### `is_user_turn_boundary`  (lines 705–715)

```
fn is_user_turn_boundary(item: &ResponseItem) -> bool
```

**Purpose**: Decides whether an item marks the start of a user-style instruction turn. Rollback uses this to know which parts of history count as turns that can be undone.

**Data flow**: It receives a response item. Agent messages always count as a boundary; ordinary user messages count unless they are only contextual updates; assistant messages count when they contain structured inter-agent instructions.

**Call relations**: `user_message_positions` calls this for each history item. It uses `is_contextual_user_message_content` to exclude context-only user messages and `is_inter_agent_instruction_content` to recognize assistant-carried agent instructions.

*Call graph*: calls 2 internal fn (is_inter_agent_instruction_content, is_contextual_user_message_content); called by 1 (user_message_positions); 1 external calls (matches!).


##### `is_inter_agent_instruction_content`  (lines 717–719)

```
fn is_inter_agent_instruction_content(content: &[ContentItem]) -> bool
```

**Purpose**: Checks whether message content is a structured instruction for communication between agents. Such content can behave like an instruction turn boundary.

**Data flow**: It receives a list of content items and asks the protocol helper whether they match the inter-agent communication format. It returns a boolean answer.

**Call relations**: `is_user_turn_boundary` calls this when examining assistant messages. The actual format recognition lives in `InterAgentCommunication::is_message_content`.

*Call graph*: calls 1 internal fn (is_message_content); called by 1 (is_user_turn_boundary).


##### `user_message_positions`  (lines 721–729)

```
fn user_message_positions(items: &[ResponseItem]) -> Vec<usize>
```

**Purpose**: Collects the positions of all user-turn boundaries in a list of history items. This gives rollback code a simple map of where turns begin.

**Data flow**: It receives a slice of response items, walks through them with their indexes, tests each item with `is_user_turn_boundary`, and returns a vector of matching indexes.

**Call relations**: `ContextManager::drop_last_n_user_turns` calls this before deciding where to cut the history. It turns many per-item boundary checks into one ordered list of rollback candidates.

*Call graph*: calls 1 internal fn (is_user_turn_boundary); called by 1 (drop_last_n_user_turns); 2 external calls (new, iter).


### Contextual message filtering
This file separates structured internal context fragments from ordinary user-visible content before prompt assembly consumes them.

### `core/src/context/contextual_user_message.rs`

`domain_logic` · `request handling`

In a chat system, not every “user” message is typed directly by the person. Some messages carry extra context for the model, such as user instructions, environment details, shell-command notes, aborted-turn notices, or compatibility warnings. This file is the filter that tells those special context messages apart from normal user text.

It does this with a registry of known fragment types. You can think of the registry like a checklist at a mailroom: each incoming text snippet is compared against known official forms. If it matches one of those forms, the system knows it is contextual metadata rather than free-form conversation.

The file also understands hook prompt fragments. A hook prompt is a structured prompt produced by an extension or hook, split into text fragments. The code checks whether a content item is either one of these hook fragments or one of the standard registered context fragments. For visible hook prompt messages, it walks through every content item. Hook fragments are collected, ordinary contextual fragments are ignored, and anything else causes the parse to fail. If at least one hook fragment was found, the pieces are combined into a single HookPromptItem.

This matters because the system needs to avoid mistaking internal context for something the user intentionally said, while still preserving structured hook prompts when they should be shown or processed.

#### Function details

##### `is_standard_contextual_user_text`  (lines 60–64)

```
fn is_standard_contextual_user_text(text: &str) -> bool
```

**Purpose**: Checks whether a plain text string matches one of the known built-in contextual user fragments. Someone would use this when they need to know if a piece of text is system-provided context rather than ordinary user writing.

**Data flow**: It receives a text string. It compares that string against every registered contextual fragment type, such as user instructions, environment context, shell command notes, and legacy warnings. It returns true if any registered fragment says the text matches, and false otherwise.

**Call relations**: This is the shared checklist used by the higher-level checks in this file. is_contextual_user_fragment calls it after first checking for hook prompt syntax. parse_visible_hook_prompt_message calls it while scanning a whole message so it can skip known context fragments and focus on hook prompt fragments.

*Call graph*: called by 2 (is_contextual_user_fragment, parse_visible_hook_prompt_message).


##### `is_contextual_user_fragment`  (lines 66–71)

```
fn is_contextual_user_fragment(content_item: &ContentItem) -> bool
```

**Purpose**: Decides whether one content item is a contextual user fragment. It accepts both hook prompt fragments and the standard registered context fragments.

**Data flow**: It receives a ContentItem. If the item is not input text, it immediately returns false because only text can be one of these fragments. If it is text, it first tries to parse it as a hook prompt fragment. If that fails, it checks whether the text matches one of the standard contextual fragment types. The result is a yes-or-no answer.

**Call relations**: This function is the simple public test for callers that only need to classify one content item. It hands hook-style text to parse_hook_prompt_fragment, and it hands all other text to is_standard_contextual_user_text for comparison with the known fragment registry.

*Call graph*: calls 2 internal fn (is_standard_contextual_user_text, parse_hook_prompt_fragment).


##### `parse_visible_hook_prompt_message`  (lines 73–98)

```
fn parse_visible_hook_prompt_message(
    id: Option<&String>,
    content: &[ContentItem],
) -> Option<HookPromptItem>
```

**Purpose**: Tries to turn a whole message into a visible HookPromptItem, but only if the message is made entirely from hook prompt fragments plus other recognized contextual fragments. It refuses to parse messages that contain ordinary user text.

**Data flow**: It receives an optional message id and a list of content items. It creates an empty collection for hook fragments, then reads each content item in order. Every item must be input text; otherwise parsing stops and returns None. Text that parses as a hook prompt fragment is saved. Text that is merely standard contextual material is allowed but not saved. Any other text makes the whole parse fail. At the end, if no hook fragments were collected, it returns None. If there are hook fragments, it combines them with the optional id into a HookPromptItem.

**Call relations**: This function is used when the system needs to recognize a complete visible hook prompt message rather than a single fragment. It relies on parse_hook_prompt_fragment to extract hook pieces, uses is_standard_contextual_user_text to ignore allowed background context, and finally passes the collected pieces to HookPromptItem::from_fragments to build the structured result.

*Call graph*: calls 3 internal fn (is_standard_contextual_user_text, from_fragments, parse_hook_prompt_fragment); 1 external calls (new).


### Realtime prompt inputs
These files assemble the startup context and backend prompt text used to initialize realtime sessions.

### `core/src/realtime_context.rs`

`domain_logic` · `realtime session startup`

When a realtime session starts, the assistant may not yet know what the user has been doing on this machine or in this workspace. This file creates a bounded background note, wrapped in special startup-context tags, that can be injected into the session. Think of it like a quick handoff note left on a desk before a meeting: recent conversation, recent projects, and a small map of the room.

The main flow gathers three kinds of information. First, it reads the current thread history and keeps recent user and assistant turns, skipping internal context messages so it does not echo system-generated material back to itself. Second, it asks the thread store for recent sessions, groups them by project or folder, and summarizes the first user requests from those sessions. Third, it scans a shallow part of the local filesystem: the current directory, the Git project root if there is one, and the user’s home directory if useful.

Because this information is meant for a language model, the file is careful about size. It uses rough token budgets, where a token is approximated as four bytes of text, and trims each section so the startup note stays small. It also hides noisy folders such as build outputs and dependency directories. Without this file, realtime sessions would have less continuity and less awareness of the user’s local workspace at startup.

#### Function details

##### `build_realtime_startup_context`  (lines 59–126)

```
async fn build_realtime_startup_context(
    sess: &Session,
    budget_tokens: usize,
) -> Option<String>
```

**Purpose**: Builds the complete startup-context text for a realtime session. It is the main entry in this file: it gathers conversation history, recent thread metadata, and a small workspace map, then packages them into one background note.

**Data flow**: It receives a session and a requested token budget. From the session it reads the current configuration, current working directory, and cloned conversation history; then it loads recent saved threads and scans nearby folders. It turns those pieces into titled sections, trims each section to fit its own size limit, wraps the final text in startup-context tags, logs what it built, and returns the text, or returns nothing if there is no useful context.

**Call relations**: This is called when the realtime session configuration is being built. It coordinates the rest of the file: it asks build_current_thread_section for this conversation’s recent turns, load_recent_threads and build_recent_work_section for nearby past work, build_workspace_section_with_user_root for the folder map, format_section for size-limited section formatting, and format_startup_context_blob for the final wrapper.

*Call graph*: calls 6 internal fn (build_current_thread_section, build_recent_work_section, build_workspace_section_with_user_root, format_section, format_startup_context_blob, load_recent_threads); called by 1 (build_realtime_session_config); 6 external calls (clone_history, get_config, debug!, home_dir, info!, vec!).


##### `load_recent_threads`  (lines 128–153)

```
async fn load_recent_threads(sess: &Session) -> Vec<StoredThread>
```

**Purpose**: Fetches a small list of recently updated saved threads. These threads are used to remind the assistant what the user has recently worked on in this machine or workspace.

**Data flow**: It receives the current session. It asks the session’s thread store for up to a fixed number of non-archived threads, sorted newest first. If the store responds successfully, it returns the stored thread records; if the lookup fails, it logs a warning and returns an empty list so startup can continue.

**Call relations**: build_realtime_startup_context calls this before building the recent-work section. It does not stop the startup flow on failure; instead it hands back an empty list, allowing the rest of the context, such as current conversation and workspace map, to still be built.

*Call graph*: called by 1 (build_realtime_startup_context); 2 external calls (new, warn!).


##### `build_recent_work_section`  (lines 155–207)

```
async fn build_recent_work_section(
    cwd: &AbsolutePathBuf,
    recent_threads: &[StoredThread],
) -> Option<String>
```

**Purpose**: Creates the “Recent Work” part of the startup note. It groups recent saved conversations by project or directory so the assistant can see what the user has recently asked Codex to do.

**Data flow**: It receives the current working directory and a list of recent stored threads. For each thread, it tries to identify the Git project root, which is the top folder of a version-controlled project; if none is found, it uses the thread’s recorded directory. It sorts groups so the current project comes first and newer work appears before older work, formats a limited number of groups, and returns joined text if any group has useful user asks.

**Call relations**: build_realtime_startup_context calls this after loading recent threads. For each chosen group it hands the work to format_thread_group, which turns the raw thread entries into readable lines.

*Call graph*: calls 2 internal fn (format_thread_group, from_absolute_path); called by 1 (build_realtime_startup_context); 3 external calls (new, new, resolve_root_git_project_for_trust).


##### `build_current_thread_section`  (lines 209–310)

```
fn build_current_thread_section(items: &[ResponseItem]) -> Option<String>
```

**Purpose**: Summarizes the most recent user and assistant turns from the current conversation. This helps the assistant keep continuity without needing the whole thread repeated in full.

**Data flow**: It receives raw response items from the current thread. It walks through them in order, keeps normal user messages, assistant messages, and plain agent messages, and skips contextual user messages that were generated as background rather than typed as a real user request. It groups messages into turns, works backward from the latest turn, trims each turn to a small budget, and returns readable text if at least one turn remains.

**Call relations**: build_realtime_startup_context calls this to create the “Current Thread” section. Inside, it relies on content_items_to_text and plaintext_agent_message_content to turn structured message parts into plain text, is_contextual_user_message_content to avoid including internal context, approx_token_count to estimate size, and truncate_realtime_text_to_token_budget to keep each turn short.

*Call graph*: calls 5 internal fn (content_items_to_text, is_contextual_user_message_content, approx_token_count, truncate_realtime_text_to_token_budget, plaintext_agent_message_content); called by 1 (build_realtime_startup_context); 5 external calls (new, new, format!, take, vec!).


##### `truncate_realtime_text_to_token_budget`  (lines 312–335)

```
fn truncate_realtime_text_to_token_budget(text: &str, budget_tokens: usize) -> String
```

**Purpose**: Shortens text until it fits a requested rough token limit. It exists because the shared truncation tool may add its own marker, and that marker can make the final result slightly larger than expected.

**Data flow**: It receives text and a token budget. It asks the shared truncator to shorten the text, estimates the result’s token count, and if the result is still too large, tightens the requested budget and tries again. It returns a fitting string, or an empty string if even the smallest truncation cannot fit.

**Call relations**: build_current_thread_section and format_section use this when preparing startup-context text. Other realtime output paths also call it, so this helper is a shared guardrail for keeping realtime text within small model-facing limits.

*Call graph*: calls 1 internal fn (approx_token_count); called by 4 (build_current_thread_section, format_section, realtime_backend_item, realtime_backend_output); 3 external calls (new, truncate_text, Tokens).


##### `build_workspace_section_with_user_root`  (lines 337–394)

```
async fn build_workspace_section_with_user_root(
    cwd: &AbsolutePathBuf,
    user_root: Option<PathBuf>,
) -> Option<String>
```

**Purpose**: Builds the “Machine / Workspace Map” section. It gives the assistant a small, safe-looking overview of where the session is running and what nearby folders exist.

**Data flow**: It receives the current working directory and, optionally, the user’s home directory. It tries to find the Git project root, renders shallow directory trees for the current directory, Git root, and user root when they are distinct, and writes labels such as current directory name, Git project name, and user root path. It returns the combined map, or nothing if there is no usable directory information.

**Call relations**: build_realtime_startup_context calls this during startup. It delegates each actual folder listing to render_tree and uses resolve_root_git_project_for_trust to identify the project boundary.

*Call graph*: calls 2 internal fn (render_tree, as_path); called by 1 (build_realtime_startup_context); 4 external calls (new, resolve_root_git_project_for_trust, format!, vec!).


##### `render_tree`  (lines 396–404)

```
fn render_tree(root: &Path) -> Option<Vec<String>>
```

**Purpose**: Creates a short list of lines showing the contents of a directory. It is intentionally shallow so startup context gets a helpful map without dumping the whole filesystem.

**Data flow**: It receives a filesystem path. If the path is not a directory, it returns nothing. Otherwise it asks collect_tree_lines to fill a list with formatted entries and returns that list if it is not empty.

**Call relations**: build_workspace_section_with_user_root calls this for the current directory, Git root, and user root. It hands off the recursive line-building work to collect_tree_lines.

*Call graph*: calls 1 internal fn (collect_tree_lines); called by 1 (build_workspace_section_with_user_root); 2 external calls (is_dir, new).


##### `collect_tree_lines`  (lines 406–437)

```
fn collect_tree_lines(dir: &Path, depth: usize, lines: &mut Vec<String>)
```

**Purpose**: Fills in the visible lines for a small directory tree. It shows folders and files with indentation, like a simple outline.

**Data flow**: It receives a directory, the current depth in the tree, and a mutable list of output lines. If the maximum depth has been reached, it stops. Otherwise it reads sorted entries, skips unreadable ones, adds each visible name with indentation and a slash for folders, recurses into folders, and adds a “more entries” line if the directory was larger than the display limit.

**Call relations**: render_tree starts this process. collect_tree_lines depends on read_sorted_entries to provide filtered, sorted directory entries and file_name_string to produce readable names.

*Call graph*: calls 2 internal fn (file_name_string, read_sorted_entries); called by 1 (render_tree); 1 external calls (format!).


##### `read_sorted_entries`  (lines 439–457)

```
fn read_sorted_entries(dir: &Path) -> io::Result<Vec<DirEntry>>
```

**Purpose**: Reads a directory and returns its useful entries in a predictable order. It hides common clutter so the workspace map stays readable.

**Data flow**: It receives a directory path. It reads the directory from disk, drops entries that cannot be read, removes names considered noisy, then sorts folders before files and sorts names alphabetically within those groups. It returns the sorted list or a filesystem error if the directory cannot be read.

**Call relations**: collect_tree_lines calls this whenever it needs the contents of a folder. This function is the point where raw filesystem data becomes a cleaned-up list suitable for display.

*Call graph*: called by 1 (collect_tree_lines); 1 external calls (read_dir).


##### `is_noisy_name`  (lines 459–462)

```
fn is_noisy_name(name: &OsStr) -> bool
```

**Purpose**: Decides whether a file or folder name should be hidden from the workspace tree. This keeps generated or bulky folders, such as dependency and build directories, from crowding out useful project structure.

**Data flow**: It receives a filesystem name. It converts the name into text and checks whether it starts with a dot or exactly matches one of the known noisy names. It returns true for names that should be skipped and false for names that should be shown.

**Call relations**: This supports the directory-reading path used by the workspace map. In practice, it acts like a doorman for read_sorted_entries, screening out clutter before collect_tree_lines formats the tree.

*Call graph*: 2 external calls (starts_with, to_string_lossy).


##### `format_section`  (lines 464–483)

```
fn format_section(title: &str, body: Option<String>, budget_tokens: usize) -> Option<String>
```

**Purpose**: Turns one optional piece of startup context into a titled section with a size limit. It prevents empty or oversized sections from entering the final startup note.

**Data flow**: It receives a section title, optional body text, and a token budget. If the body is missing or blank, it returns nothing. Otherwise it creates a Markdown-style heading, subtracts the heading’s size from the budget, trims the body to what remains, and returns the finished section if any body text survives.

**Call relations**: build_realtime_startup_context calls this for the Current Thread, Recent Work, Machine / Workspace Map, and Notes sections. It uses approx_token_count and truncate_realtime_text_to_token_budget to keep each section within its assigned space.

*Call graph*: calls 2 internal fn (approx_token_count, truncate_realtime_text_to_token_budget); called by 1 (build_realtime_startup_context); 1 external calls (format!).


##### `format_startup_context_blob`  (lines 485–487)

```
fn format_startup_context_blob(body: &str) -> String
```

**Purpose**: Wraps the finished startup-context body in special opening and closing tags. The tags make it clear to the receiving system that this is background context, not a normal user message.

**Data flow**: It receives the already assembled body text. It places the opening startup-context tag before the body and the closing tag after it, then returns the wrapped string.

**Call relations**: build_realtime_startup_context calls this at the end, after all sections have been prepared and joined together.

*Call graph*: called by 1 (build_realtime_startup_context); 1 external calls (format!).


##### `format_thread_group`  (lines 489–562)

```
async fn format_thread_group(
    current_group: &Path,
    group: &Path,
    entries: Vec<&StoredThread>,
) -> Option<String>
```

**Purpose**: Formats one project or directory group for the recent-work section. It gives a compact summary of recent sessions in that location and lists distinct user requests.

**Data flow**: It receives the current project group, the group being described, and the stored thread entries in that group. It labels the group as a Git repo or directory, records how many recent sessions it contains, notes the latest activity time and branch when available, then collects unique first user messages. It trims very long asks, limits how many asks are shown, and returns the group text only if at least one ask was added.

**Call relations**: build_recent_work_section calls this for each selected recent-work group after sorting groups and entries. It may ask the Git-root resolver whether the latest thread’s directory belongs to a Git project so the heading can be more meaningful.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (build_recent_work_section); 5 external calls (new, new, resolve_root_git_project_for_trust, format!, vec!).


##### `file_name_string`  (lines 564–569)

```
fn file_name_string(path: &Path) -> String
```

**Purpose**: Gets a human-readable name for a path. It is a small fallback helper for cases where a path may not have a normal final filename.

**Data flow**: It receives a path. It tries to take the final path component and convert it to regular text; if that is not possible, it uses the full displayed path instead. It returns the chosen string.

**Call relations**: collect_tree_lines uses this when naming files and folders in the rendered workspace tree. build_workspace_section_with_user_root also benefits from this style of readable naming when presenting directory and project labels.

*Call graph*: called by 1 (collect_tree_lines); 1 external calls (file_name).


##### `approx_token_count`  (lines 571–573)

```
fn approx_token_count(text: &str) -> usize
```

**Purpose**: Estimates how many language-model tokens a piece of text will use. A token is a chunk of text consumed by the model; this estimate uses a simple rule of about four bytes per token.

**Data flow**: It receives text. It measures the text length in bytes, divides by the approximate bytes-per-token value, rounds up, and returns that number.

**Call relations**: build_current_thread_section, format_section, and truncate_realtime_text_to_token_budget call this whenever they need a quick size estimate. It is the shared measuring tape that keeps the startup context within practical limits.

*Call graph*: called by 3 (build_current_thread_section, format_section, truncate_realtime_text_to_token_budget).


### `core/src/realtime_prompt.rs`

`domain_logic` · `realtime session setup`

A realtime assistant needs a starting set of instructions: who it is, how it should speak, and what rules it should follow. This file is the small decision point that prepares those instructions before a realtime session is created. Without it, different parts of the system could disagree about which prompt wins, or the default prompt might be sent with an unreplaced placeholder like “{{ user_first_name }}”.

The main rule is priority. A non-empty prompt from configuration comes first, because it is an explicit system-level override. If there is no usable configured prompt, the file looks at the prompt supplied with the request. A request can provide real text, or it can deliberately say “use no prompt” by passing an empty value. Only when neither configuration nor request provides a prompt does the code use the built-in `BACKEND_PROMPT`.

When the built-in prompt is used, the file personalizes it slightly by replacing the user-name placeholder with the current user’s first name. It gets that name from the operating system account information, first trying the real name and then the username. If both fail, it falls back to “there,” like a polite generic greeting. The tests in this file lock down those priority rules so later changes do not accidentally change which prompt is sent.

#### Function details

##### `prepare_realtime_backend_prompt`  (lines 5–24)

```
fn prepare_realtime_backend_prompt(
    prompt: Option<Option<String>>,
    config_prompt: Option<String>,
) -> String
```

**Purpose**: Chooses the final prompt text to send to the realtime backend. It exists so the system has one clear rule for prompt priority: configuration first, then request, then the built-in default.

**Data flow**: It receives two possible prompt sources: `config_prompt`, which may come from settings, and `prompt`, which may come from a request and can itself mean “no prompt.” If the configuration prompt is present and not just whitespace, it returns that. Otherwise it returns the request prompt if one was supplied, returns an empty string if the request explicitly disabled the prompt, or builds the default prompt by trimming it and replacing the user-name placeholder with the current user's first name.

**Call relations**: When realtime session configuration is being built, `build_realtime_session_config` calls this function to get the prompt that should be placed into the session. If the default prompt is needed, this function asks `current_user_first_name` for a friendly name to insert. The default-rendering test also calls it to make sure the fallback prompt is complete and no placeholder is left behind.

*Call graph*: calls 1 internal fn (current_user_first_name); called by 2 (build_realtime_session_config, prepare_realtime_backend_prompt_renders_default); 1 external calls (new).


##### `current_user_first_name`  (lines 26–32)

```
fn current_user_first_name() -> String
```

**Purpose**: Finds a friendly first name for the current user, so the default prompt can refer to the user naturally. If it cannot find a real name, it uses a safe generic fallback.

**Data flow**: It reads the operating system's idea of the user's real name and username. From each value, it takes the first whitespace-separated word, skips empty results, and returns the first usable name it finds. If neither source gives a usable name, it returns `there`.

**Call relations**: This helper is used only by `prepare_realtime_backend_prompt`, and only when the built-in default prompt is being prepared. It relies on the external `whoami` library to ask the operating system for the real name and username.

*Call graph*: called by 1 (prepare_realtime_backend_prompt); 2 external calls (realname, username).


##### `tests::prepare_realtime_backend_prompt_prefers_config_override`  (lines 39–47)

```
fn prepare_realtime_backend_prompt_prefers_config_override()
```

**Purpose**: Checks that a configured prompt wins over a request prompt. This protects the intended priority rule for system-level overrides.

**Data flow**: The test gives the prompt builder both a request prompt and a configuration prompt. It then checks that the returned text is the configuration prompt, proving the request prompt was ignored in that case.

**Call relations**: This test exercises the same choice that happens during realtime session setup, but in a small controlled example. It uses an equality assertion to confirm the expected result.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::prepare_realtime_backend_prompt_uses_request_prompt`  (lines 50–58)

```
fn prepare_realtime_backend_prompt_uses_request_prompt()
```

**Purpose**: Checks that a request prompt is used when there is no configured prompt. This makes sure callers can still customize a realtime session per request.

**Data flow**: The test passes a request prompt and no configuration prompt. It checks that the returned text exactly matches the request prompt.

**Call relations**: This test covers the second step in the prompt priority chain. It uses an equality assertion to verify that `prepare_realtime_backend_prompt` does not fall through to the built-in default when a request prompt exists.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::prepare_realtime_backend_prompt_preserves_empty_request_prompt`  (lines 61–70)

```
fn prepare_realtime_backend_prompt_preserves_empty_request_prompt()
```

**Purpose**: Checks that an intentionally empty request prompt stays empty. This matters because an empty prompt is different from forgetting to provide a prompt at all.

**Data flow**: The test calls the prompt builder with two forms of request-level emptiness: an empty string and a request value that means no prompt text. In both cases, with no configuration override present, it checks that the result is an empty string.

**Call relations**: This test protects a subtle behavior in `prepare_realtime_backend_prompt`: callers can deliberately disable the backend prompt instead of automatically getting the default. It uses equality assertions to lock down both supported empty cases.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::prepare_realtime_backend_prompt_renders_default`  (lines 73–81)

```
fn prepare_realtime_backend_prompt_renders_default()
```

**Purpose**: Checks that the built-in default prompt is used and properly filled in when no other prompt is supplied. It also makes sure the user-name placeholder is replaced.

**Data flow**: The test calls the prompt builder with no request prompt and no configuration prompt. It then inspects the returned text to confirm it starts like the expected default prompt, contains key identity text, includes the phrase introducing the user's name, and no longer contains the raw placeholder.

**Call relations**: This test directly calls `prepare_realtime_backend_prompt`, which in this scenario also calls `current_user_first_name`. The assertions confirm that the fallback path produces a usable prompt for realtime session setup.

*Call graph*: calls 1 internal fn (prepare_realtime_backend_prompt); 1 external calls (assert!).


### Prompt inspection and specialized history
These files build prompt-visible inputs for debugging and for the reduced standalone web-search conversation path.

### `core/src/prompt_debug.rs`

`orchestration` · `debug prompt construction`

This file is a debugging aid for answering a simple but important question: “What will the model actually see?” In a chat system, the final prompt is not just the user’s latest message. It also includes saved conversation history, system instructions, user instructions, tool descriptions, context updates, and other session state. Without a helper like this, debugging prompt problems would mean recreating a full session by hand.

The main function, build_prompt_input, creates a short-lived, temporary session. It marks the configuration as ephemeral, meaning it is meant for this one debug use rather than a lasting conversation. It sets up authentication, runtime paths for the execution server, the thread store, environment information, and a ThreadManager, then starts a thread. Once the session exists, it delegates the actual prompt construction to build_prompt_input_from_session. After that, it shuts the temporary thread down and removes it so the debug operation does not leave background work behind.

The second function does the session-level work. It creates a default turn, records any context updates, optionally converts the provided user input into a conversation item, gathers the conversation history in the form suitable for the model, builds the available tools, fetches the base instructions, and finally calls the normal prompt builder. The result is only the prompt input list, which is the part useful for inspection.

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

**Purpose**: Creates a temporary session and returns the model-visible input list for a single debug turn. Someone would use it when they want to inspect the prompt that would be sent to the model, without keeping a real conversation thread alive.

**Data flow**: It receives a configuration, a list of user input items, an optional state database handle, and a provider for user instructions. It changes the configuration to be temporary, sets up authentication, execution-server paths, thread storage, environment state, and installation identity, then starts a new thread. It passes that thread’s session plus the user input to build_prompt_input_from_session, waits for the thread to shut down, removes it from the thread manager, and returns the finished list of ResponseItem values or an error if setup or shutdown fails.

**Call relations**: This is the outer wrapper for the debug flow. It calls setup helpers such as shared_from_config, from_optional_paths, thread_store_from_config, from_codex_home, and ThreadManager::new so the session looks like a real one. Once the temporary session is ready, it hands control to build_prompt_input_from_session for the actual prompt-building work, then cleans up the thread before returning.

*Call graph*: calls 6 internal fn (build_prompt_input_from_session, new, thread_store_from_config, from_codex_home, from_optional_paths, shared_from_config); 4 external calls (clone, new, empty_extension_registry, resolve_installation_id).


##### `build_prompt_input_from_session`  (lines 74–102)

```
async fn build_prompt_input_from_session(
    sess: &Session,
    input: Vec<UserInput>,
) -> CodexResult<Vec<ResponseItem>>
```

**Purpose**: Builds the prompt input list from an already-created Session. It uses the same session machinery as a normal turn, so the debug output reflects what the model would really receive.

**Data flow**: It receives a Session reference and the user input for this debug turn. It creates a default turn, records the turn’s context updates, and, if there is user input, turns that input into a conversation item and records it. It then reads the session history, filters it for the model’s supported input types, builds the available tools, reads the base instructions, and calls build_prompt. It returns the prompt’s input list as ResponseItem values.

**Call relations**: This is called by build_prompt_input after that function has created a temporary thread and session. Inside the normal turn flow, it calls session methods such as new_default_turn, record_context_updates_and_set_reference_context_item, record_conversation_items, clone_history, and get_base_instructions. It also calls built_tools so tool information is included, then hands everything to build_prompt, which assembles the final prompt structure.

*Call graph*: calls 2 internal fn (build_prompt, built_tools); called by 1 (build_prompt_input); 8 external calls (new, clone_history, get_base_instructions, new_default_turn, record_context_updates_and_set_reference_context_item, record_conversation_items, response_item_from_user_input, from_ref).


### `ext/web-search/src/history.rs`

`domain_logic` · `request handling`

A web search works best when it knows what the user is currently asking and a little bit of what came just before. This file builds that compact search context from the larger conversation log. Think of it like giving a librarian the last few relevant sentences instead of handing over the whole notebook.

The main function, `recent_input`, walks through past response items and keeps only messages that are visible and useful for search: real user text, assistant text, and plain-text agent messages. It skips things like tool calls, developer or system messages, image-only content, and contextual user messages that are not actual user requests. After collecting visible messages, it trims the list so it includes only the tail starting from the last two real user messages. Then it shortens assistant text to a fixed token budget, where a token is a small chunk of text used by language models for counting size.

The result is packaged as `SearchInput::Items` if anything useful remains. Without this file, web search could receive too much history, the wrong kind of history, or private/internal context that should not shape the search query.

#### Function details

##### `recent_input`  (lines 18–27)

```
fn recent_input(items: &[ResponseItem]) -> Option<SearchInput>
```

**Purpose**: Builds the recent conversation context that will accompany a standalone web search. It keeps the current user message, the previous user message, and nearby assistant text, while avoiding old or irrelevant items.

**Data flow**: It receives a list of conversation response items. It asks `push_visible_message` to copy only useful visible text into a new message list, then trims that list to the last two user messages and limits assistant text to about 1,000 tokens. If any messages remain, it returns them wrapped as `SearchInput::Items`; otherwise it returns nothing.

**Call relations**: When `handle_call` needs to perform a web search, it calls `recent_input` to prepare the search context. `recent_input` delegates the first filtering step to `push_visible_message`, then uses shared trimming helpers so the final search input is small enough and focused on the latest user intent.

*Call graph*: calls 1 internal fn (push_visible_message); called by 1 (handle_call); 4 external calls (new, Items, retain_tail_from_last_n_user_messages, truncate_assistant_output_text_to_token_budget).


##### `push_visible_message`  (lines 29–78)

```
fn push_visible_message(messages: &mut Vec<ResponseItem>, item: &ResponseItem)
```

**Purpose**: Decides whether one conversation item is safe and useful enough to include in the web search context. It turns supported items into plain message form and ignores everything else.

**Data flow**: It receives the growing message list and one conversation item. Assistant messages are copied as-is. Plain-text agent messages are converted into assistant-style text that says who the agent was. Real user messages are kept only if they are actual user turns and only their text parts are copied, leaving out things like images. Items such as tool calls, system messages, developer messages, and non-text content do not change the output list.

**Call relations**: This function is called once for each item by `recent_input`. It performs the careful screening step before the broader tail-trimming helpers run, so later code only works with visible, search-relevant text.

*Call graph*: calls 1 internal fn (plaintext_agent_message_content); called by 1 (recent_input); 3 external calls (matches!, clone, vec!).


##### `tests::message`  (lines 91–107)

```
fn message(role: &str, text: &str) -> ResponseItem
```

**Purpose**: Creates a simple test message with either user input text or assistant output text. It gives the tests a short, readable way to build conversation examples.

**Data flow**: It takes a role name and text. If the role is assistant, it puts the text in an output-text content item; otherwise it puts the text in an input-text content item. It returns a `ResponseItem::Message` with no id, phase, or metadata.

**Call relations**: The test cases call this helper when they need sample user, assistant, system, or developer messages. It keeps the tests focused on the history-filtering behavior instead of repeating message construction details.

*Call graph*: 1 external calls (vec!).


##### `tests::keeps_current_user_and_previous_visible_turn`  (lines 110–138)

```
fn keeps_current_user_and_previous_visible_turn()
```

**Purpose**: Checks that search context keeps the latest real user request, the previous user request, and the assistant response between them, while dropping older and non-visible items.

**Data flow**: The test builds a mixed conversation containing system text, old turns, a tool call, developer text, the current user message, and current assistant commentary. It passes that list into `recent_input` and verifies that the result contains only the previous user message, the previous assistant message, and the current user message.

**Call relations**: This test exercises the main flow through `recent_input`, including its use of `push_visible_message` and the tail-retention helper. It confirms that web search is given recent visible conversation context, not the whole transcript.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::keeps_only_text_from_recent_user_messages`  (lines 141–171)

```
fn keeps_only_text_from_recent_user_messages()
```

**Purpose**: Checks that user messages with mixed content are reduced to text before being used for search. This matters because web search context should not include image payloads or other non-text data.

**Data flow**: The test creates a previous user message containing both text and an image, followed by assistant text and a current user message. It sends these items to `recent_input` and expects the returned search input to contain only the text from the previous user message, plus the assistant and current user text.

**Call relations**: This test focuses on the filtering done inside `push_visible_message` when `recent_input` processes user messages. It proves that the search history stays text-only even when the original conversation item had other content.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::ignores_contextual_user_messages_when_selecting_recent_turns`  (lines 174–193)

```
fn ignores_contextual_user_messages_when_selecting_recent_turns()
```

**Purpose**: Checks that internal context messages written with the user role are not treated as real user requests. This prevents environment details from displacing the actual recent conversation in search context.

**Data flow**: The test builds a conversation with a previous user request, an assistant reply, an environment-context message, and the current user request. It passes them to `recent_input` and verifies that the environment-context item is ignored, leaving the previous user request, assistant reply, and current user request.

**Call relations**: This test depends on `push_visible_message` using `parse_turn_item` to recognize genuine user messages. It protects the larger web-search flow from accidentally basing searches on hidden runtime context instead of what the user actually asked.

*Call graph*: 2 external calls (assert_eq!, vec!).
