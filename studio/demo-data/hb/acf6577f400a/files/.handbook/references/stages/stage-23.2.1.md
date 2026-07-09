# Core src runtime, session, policy, and state tests  `stage-23.2.1`

This stage is the core crate’s source-level verification layer for runtime behavior outside the tool implementations themselves. It sits across startup, active turn execution, resume/rollback paths, and policy enforcement, ensuring that sessions, agents, prompts, approvals, and persisted state cooperate correctly under realistic conditions.

The largest cluster centers on session execution: session/tests.rs, guardian_tests.rs, turn_tests.rs, rollout_reconstruction_tests.rs, mcp_tests.rs, and state/session_tests.rs validate turn lifecycle, prompt/context assembly, guardian approval flows, contributor rewrites, rollout reconstruction, MCP review metadata, and subtle SessionState semantics. Context and transcript shaping are covered by compact_tests.rs, history_tests.rs, event_mapping_tests.rs, contextual_user_message_tests.rs, environment_context_tests.rs, stream_events_utils_tests.rs, thread_rollout_truncation_tests.rs, turn_metadata_tests.rs, turn_diff_tracker_tests.rs, turn_timing_tests.rs, user_shell_command_tests.rs, image_preparation_tests.rs, and client_common_tests.rs, which lock down how history is normalized, compacted, rendered, timed, serialized, and exposed.

Agent orchestration tests—agent/control_tests.rs, execution_tests.rs, residency_tests.rs, registry_tests.rs, role_tests.rs, codex_delegate_tests.rs, and thread_manager_tests.rs—exercise spawning, limits, residency, delegation, roles, and thread lifecycle. Policy and environment coverage comes from guardian/tests.rs, exec_policy*_tests.rs, safety_tests.rs, mcp_tool_exposure_test.rs, sandbox_tags_tests.rs, agents_md_tests.rs, personality_migration_tests.rs, git_info_tests.rs, shell*_tests.rs, and realtime_*_tests.rs, which verify approvals, sandboxing, config migration, repository metadata, shell integration, and realtime startup/handoff formatting.

## Files in this stage

### Session lifecycle tests
These tests cover the core session engine, including turn handling, guardian approval paths, rollout reconstruction, and related state semantics.

### `core/src/session/tests.rs`

`test` · `cross-cutting; exercised during unit/integration test runs for session startup, turn handling, config reload, tool execution, persistence, and shutdown`

This file is the main behavioral specification for the session layer. It mixes small test helpers with a very broad set of async and sync tests that exercise `Session`, `SessionConfiguration`, `SessionState`, turn creation, task spawning, tool dispatch, persistence, and extension/lifecycle hooks. The helper section builds concrete `ResponseItem` messages, in-memory telemetry, mock `ToolCallRuntime`s, synthetic `AppInfo` connectors, rollout fixtures, and fully wired test sessions using offline model metadata, local thread stores, default environments, and optional auth/config mutations.

The tests focus on concrete invariants that are easy to miss from implementation alone: turn-start events must not wait on startup prewarm; interrupts emit a model-visible raw marker before `TurnAborted`; managed network proxy exposure depends on permission profile and must refresh when sandbox settings change; user shell commands intentionally do not inherit managed proxy env; config reload only updates runtime-refreshable fields while preserving session-static settings; resumed/forked history reconstruction must match live compaction semantics and seed token/rate-limit/reference-context state correctly; thread rollback requires persisted rollout history and recomputes baseline context from replay; request-permission grants are keyed by environment and can be auto-denied by granular approval policy; tracing propagates W3C context through submissions, dispatch spans, and spawned tasks.

It also validates prompt assembly details such as extension-contributed fragments, multi-agent usage hints, realtime start/end notices, omission of image-save boilerplate, skill-budget truncation metrics/warnings, and split filesystem sandbox policy persistence. Three tiny `SessionTask` implementations (`CompletingTask`, `NeverEndingTask`, `GuardianDeniedApprovalTask`) provide deterministic task behavior for lifecycle and cancellation tests.

#### Function details

##### `user_message`  (lines 187–197)

```
fn user_message(text: &str) -> ResponseItem
```

**Purpose**: Builds a minimal user `ResponseItem::Message` containing one `ContentItem::InputText`. Tests use it as canonical synthetic conversation history input.

**Data flow**: Takes a `&str` text → allocates owned `String` values for role and text → returns a `ResponseItem::Message` with `id`, `phase`, and `metadata` set to `None`.

**Call relations**: Used by rollback, token-count, and idle-turn rejection tests whenever they need exact user-history items without repeating message construction logic.

*Call graph*: called by 8 (recompute_token_usage_uses_session_base_instructions, thread_rollback_persists_marker_and_replays_cumulatively, thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay, thread_rollback_restores_cleared_reference_context_item_after_compaction, try_start_turn_if_idle_rejects_active_review_turn_without_injecting, try_start_turn_if_idle_rejects_active_turn_without_injecting, try_start_turn_if_idle_rejects_pending_trigger_turn_without_injecting, try_start_turn_if_idle_rejects_plan_mode_without_injecting); 1 external calls (vec!).


##### `assistant_message`  (lines 199–209)

```
fn assistant_message(text: &str) -> ResponseItem
```

**Purpose**: Builds a minimal assistant `ResponseItem::Message` with one `ContentItem::OutputText` payload.

**Data flow**: Consumes a borrowed text string → converts it into owned message fields → returns a `ResponseItem::Message` for the assistant role.

**Call relations**: Paired with `user_message` in rollback replay tests to create alternating user/assistant transcripts that can be compared against reconstructed history.

*Call graph*: called by 3 (thread_rollback_persists_marker_and_replays_cumulatively, thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay, thread_rollback_restores_cleared_reference_context_item_after_compaction); 1 external calls (vec!).


##### `test_session_telemetry_without_metadata`  (lines 211–231)

```
fn test_session_telemetry_without_metadata() -> SessionTelemetry
```

**Purpose**: Creates a `SessionTelemetry` configured with an in-memory OpenTelemetry exporter and no account metadata tags.

**Data flow**: Instantiates `InMemoryMetricExporter`, wraps it in `MetricsClient::new(MetricsConfig::in_memory(...).with_runtime_reader())`, then builds `SessionTelemetry::new(...)` and attaches metrics via `with_metrics_without_metadata_tags` → returns the telemetry object.

**Call relations**: Called by skill-metrics tests so they can inspect emitted histogram values without needing external telemetry infrastructure.

*Call graph*: calls 4 internal fn (new, new, in_memory, new); called by 2 (emit_thread_start_skill_metrics_records_description_truncated_chars_without_omitted_skills, emit_thread_start_skill_metrics_records_enabled_kept_and_truncated_values); 2 external calls (default, env!).


##### `find_metric`  (lines 233–242)

```
fn find_metric(resource_metrics: &'a ResourceMetrics, name: &str) -> &'a Metric
```

**Purpose**: Searches a `ResourceMetrics` snapshot for a metric by exact name and panics if it is absent.

**Data flow**: Reads nested scope metrics from `ResourceMetrics` → iterates through each `Metric` → returns the first matching metric reference or panics with a descriptive message.

**Call relations**: A helper for `histogram_sum`, isolating the traversal logic used by telemetry assertions.

*Call graph*: called by 1 (histogram_sum); 2 external calls (scope_metrics, panic!).


##### `histogram_sum`  (lines 244–257)

```
fn histogram_sum(resource_metrics: &ResourceMetrics, name: &str) -> u64
```

**Purpose**: Extracts the rounded sum from a single-point floating-point histogram metric in a telemetry snapshot.

**Data flow**: Looks up a metric with `find_metric` → pattern matches on `AggregatedMetrics::F64(MetricData::Histogram(...))` → asserts exactly one data point exists → returns that point's rounded `sum()` as `u64`; panics on unexpected metric shape.

**Call relations**: Used only by skill telemetry tests to assert concrete metric totals after rendering available skills.

*Call graph*: calls 1 internal fn (find_metric); 2 external calls (assert_eq!, panic!).


##### `skill_message`  (lines 259–269)

```
fn skill_message(text: &str) -> ResponseItem
```

**Purpose**: Builds a user message wrapper for raw skill markup text embedded in tests.

**Data flow**: Takes a text snippet, wraps it as `ContentItem::InputText`, and returns a user-role `ResponseItem::Message` with no metadata.

**Call relations**: Used by app-ID extraction tests to feed `<skill>...</skill>` payloads into parsing logic.

*Call graph*: 1 external calls (vec!).


##### `regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm`  (lines 272–322)

```
async fn regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm()
```

**Purpose**: Verifies that spawning a regular turn emits `TurnStarted` promptly and preserves the request trace ID even when startup prewarm is still blocked.

**Data flow**: Creates tracing context and a session/event receiver, installs a never-resolving startup prewarm handle, spawns a regular task, waits for the first event, and asserts the emitted `TurnStartedEvent` contains the turn ID and inherited trace ID; finally aborts tasks.

**Call relations**: Exercises the session startup/turn-start path under a blocked prewarm condition to prove event emission is decoupled from model-session warmup.

*Call graph*: calls 5 internal fn (make_session_and_context_with_rx, test_model_client_session, new, new, install_test_tracing); 10 external calls (clone, new, assert!, assert_eq!, info_span!, panic!, from_millis, now, spawn, timeout).


##### `request_mcp_server_elicitation_auto_accepts_when_auto_deny_is_enabled`  (lines 325–365)

```
async fn request_mcp_server_elicitation_auto_accepts_when_auto_deny_is_enabled()
```

**Purpose**: Checks that MCP elicitation requests are answered locally with an accept response when the connection manager is configured for auto-deny mode.

**Data flow**: Builds a session, flips `set_elicitations_auto_deny(true)`, deserializes a minimal `McpElicitationSchema`, invokes `request_mcp_server_elicitation`, then asserts the returned `ElicitationResponse` is `Accept` with empty object content and that no event was sent on the session channel.

**Call relations**: Covers the short-circuit branch where elicitation handling avoids client-visible prompting entirely.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 5 external calls (String, assert!, assert_eq!, json!, from_value).


##### `interrupting_regular_turn_waiting_on_startup_prewarm_emits_turn_aborted`  (lines 368–425)

```
async fn interrupting_regular_turn_waiting_on_startup_prewarm_emits_turn_aborted()
```

**Purpose**: Ensures an interrupted regular turn that is still waiting on startup prewarm emits both the raw abort marker and a final `TurnAbortedEvent`.

**Data flow**: Creates a session with blocked prewarm, spawns a regular task, confirms `TurnStarted`, calls `abort_all_tasks(Interrupted)`, then reads two subsequent events: a `RawResponseItem` marker and a `TurnAbortedEvent` with populated completion timestamp and duration.

**Call relations**: Complements the previous prewarm test by validating the abort path and event ordering while the turn has not yet progressed past startup waiting.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, test_model_client_session, new, new); 10 external calls (clone, new, assert!, assert_eq!, panic!, from_millis, from_secs, now, spawn, timeout).


##### `test_model_client_session`  (lines 427–442)

```
fn test_model_client_session() -> crate::client::ModelClientSession
```

**Purpose**: Constructs a concrete `ModelClientSession` backed by an OpenAI provider for tests that need a realistic prewarm result.

**Data flow**: Parses a fixed `ThreadId`, creates `ModelClient::new(...)` with provider/session-source settings, then calls `.new_session()` and returns the resulting session.

**Call relations**: Used as the successful value produced by spawned startup-prewarm tasks in prewarm-related tests.

*Call graph*: calls 3 internal fn (new, create_openai_provider, try_from); called by 2 (interrupting_regular_turn_waiting_on_startup_prewarm_emits_turn_aborted, regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm).


##### `developer_input_texts`  (lines 444–459)

```
fn developer_input_texts(items: &[ResponseItem]) -> Vec<&str>
```

**Purpose**: Extracts all developer-role input text fragments from a slice of `ResponseItem`s.

**Data flow**: Filters `ResponseItem::Message` entries where `role == "developer"`, flattens their `content`, keeps only `ContentItem::InputText`, and returns borrowed `&str` slices.

**Call relations**: Shared by many prompt/context tests that assert whether specific developer instructions were included or omitted.

*Call graph*: called by 9 (build_initial_context_omits_default_image_save_location_with_image_history, build_initial_context_omits_default_image_save_location_without_image_history, build_initial_context_restates_realtime_start_when_reference_context_is_missing, build_initial_context_trims_skill_metadata_from_context_window_budget, build_initial_context_uses_previous_realtime_state, build_initial_context_uses_previous_turn_settings_for_realtime_end, build_settings_update_items_emits_realtime_end_when_session_stops_being_live, build_settings_update_items_emits_realtime_start_when_session_becomes_live, build_settings_update_items_uses_previous_turn_settings_for_realtime_end); 1 external calls (iter).


##### `developer_message_texts`  (lines 461–480)

```
fn developer_message_texts(items: &[ResponseItem]) -> Vec<Vec<&str>>
```

**Purpose**: Groups developer input texts by message, preserving message boundaries instead of flattening them.

**Data flow**: Filters developer messages, then for each message collects its `InputText` items into a `Vec<&str>`; returns `Vec<Vec<&str>>`.

**Call relations**: Used where tests care about standalone developer messages, such as extension fragments and multi-agent usage hints.

*Call graph*: called by 6 (build_initial_context_adds_multi_agent_v2_root_usage_hint_as_developer_message, build_initial_context_adds_multi_agent_v2_subagent_usage_hint_as_developer_message, build_initial_context_includes_prompt_fragments_from_extensions, build_initial_context_omits_multi_agent_v2_usage_hints_when_feature_disabled, build_initial_context_omits_multi_agent_v2_usage_hints_when_hint_disabled, build_initial_context_omits_prompt_fragments_without_extension_state); 1 external calls (iter).


##### `user_input_texts`  (lines 482–497)

```
fn user_input_texts(items: &[ResponseItem]) -> Vec<&str>
```

**Purpose**: Extracts all user-role input text fragments from response items.

**Data flow**: Filters user messages, flattens content arrays, keeps `ContentItem::InputText`, and returns borrowed text slices.

**Call relations**: Supports assertions about generated environment-context update items, which are encoded as user-visible context fragments.

*Call graph*: called by 3 (build_settings_update_items_emits_environment_item_for_network_changes, build_settings_update_items_emits_environment_item_for_time_changes, build_settings_update_items_omits_environment_item_when_disabled); 1 external calls (iter).


##### `write_project_hooks`  (lines 499–518)

```
fn write_project_hooks(dot_codex: &Path) -> std::io::Result<()>
```

**Purpose**: Writes a `.codex/hooks.json` file containing a simple `SessionStart` command hook fixture.

**Data flow**: Creates the target directory tree and writes a fixed JSON document that runs `echo hello from hook` on session start.

**Call relations**: Used by project-trust hook tests to create trusted and untrusted hook sources on disk.

*Call graph*: called by 2 (session_start_hooks_only_load_from_trusted_project_layers, session_start_hooks_require_project_trust_without_config_toml); 3 external calls (join, create_dir_all, write).


##### `write_project_trust_config`  (lines 520–545)

```
async fn write_project_trust_config(
    codex_home: &Path,
    trusted_projects: &[(&Path, TrustLevel)],
) -> std::io::Result<()>
```

**Purpose**: Persists a `config.toml` mapping project trust keys to explicit `TrustLevel`s.

**Data flow**: Takes a codex-home path and `(&Path, TrustLevel)` pairs, converts them into a `ConfigToml { projects: ... }`, serializes to TOML, and writes it asynchronously to the user's config file.

**Call relations**: Feeds the hook-loading tests that distinguish trusted project layers from untrusted ones.

*Call graph*: called by 2 (session_start_hooks_only_load_from_trusted_project_layers, session_start_hooks_require_project_trust_without_config_toml); 5 external calls (default, iter, join, write, to_string).


##### `preview_session_start_hooks`  (lines 547–568)

```
async fn preview_session_start_hooks(
    config: &crate::config::Config,
) -> std::io::Result<Vec<codex_protocol::protocol::HookRunSummary>>
```

**Purpose**: Builds a `Hooks` instance from a config and returns the previewed `SessionStart` hook runs for that config.

**Data flow**: Creates `Hooks` with `feature_enabled: true` and the config's `config_layer_stack`, constructs a `codex_hooks::SessionStartRequest` from config cwd/model defaults, and returns the preview list wrapped in `std::io::Result`.

**Call relations**: Used by hook trust/reload tests to verify whether hooks become active after config changes.

*Call graph*: calls 2 internal fn (new, new); 1 external calls (default).


##### `test_tool_runtime`  (lines 570–584)

```
fn test_tool_runtime(session: Arc<Session>, turn_context: Arc<TurnContext>) -> ToolCallRuntime
```

**Purpose**: Creates a `ToolCallRuntime` suitable for direct tool-call tests against a session and turn context.

**Data flow**: Builds a `ToolRouter` from the turn context and its dynamic tools, allocates a fresh `TurnDiffTracker` mutex, and returns `ToolCallRuntime::new(router, session, turn_context, tracker)`.

**Call relations**: Used by output-item and shell-cancellation tests that need to invoke tool handling without running a full model turn.

*Call graph*: calls 3 internal fn (new, from_turn_context, new); called by 4 (handle_output_item_done_records_image_save_history_message, handle_output_item_done_skips_image_save_message_when_save_fails, shell_tool_cancellation_waits_for_runtime_cleanup, tool_calls_reopen_mailbox_delivery_for_current_turn); 4 external calls (new, default, new, new).


##### `make_connector`  (lines 586–602)

```
fn make_connector(id: &str, name: &str) -> AppInfo
```

**Purpose**: Constructs a minimal enabled and accessible `AppInfo` connector fixture with the given ID and display name.

**Data flow**: Copies the provided strings into an `AppInfo` struct and fills all optional branding/metadata fields with `None` or empty vectors.

**Call relations**: Supports app mention extraction tests by providing connector metadata for resolution.

*Call graph*: 1 external calls (new).


##### `assistant_message_stream_parsers_can_be_seeded_from_output_item_added_text`  (lines 605–619)

```
fn assistant_message_stream_parsers_can_be_seeded_from_output_item_added_text()
```

**Purpose**: Tests that assistant stream parsers can start from already-added text and still parse a citation tag completed by later deltas.

**Data flow**: Creates parsers in non-plan mode, seeds partial text containing an opening citation tag, parses a delta that closes it, finishes the item, and asserts visible text/citation outputs at each stage.

**Call relations**: Exercises parser state continuity across `output_item.added` and delta events.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `assistant_message_stream_parsers_seed_buffered_prefix_stays_out_of_finish_tail`  (lines 622–636)

```
fn assistant_message_stream_parsers_seed_buffered_prefix_stays_out_of_finish_tail()
```

**Purpose**: Verifies that a buffered partial citation prefix supplied during seeding is consumed by later deltas and does not leak into the final tail.

**Data flow**: Seeds text ending with an incomplete `<oai-mem-` prefix, parses the remainder of the citation and trailing text, finishes the item, and asserts the tail is empty.

**Call relations**: Covers a boundary case in incremental citation parsing.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `assistant_message_stream_parsers_seed_plan_parser_across_added_and_delta_boundaries`  (lines 639–664)

```
fn assistant_message_stream_parsers_seed_plan_parser_across_added_and_delta_boundaries()
```

**Purpose**: Checks that plan-mode parsing preserves proposed-plan segment boundaries when the opening tag is split across seed and delta text.

**Data flow**: Creates plan-mode parsers, seeds text ending with `<proposed`, parses the rest of the tag plus plan body and outro, finishes the item, and asserts both visible text and `ProposedPlanSegment` sequence.

**Call relations**: Validates the specialized parser path used when collaboration mode exposes proposed plans.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `validated_network_policy_amendment_host_allows_normalized_match`  (lines 667–681)

```
fn validated_network_policy_amendment_host_allows_normalized_match()
```

**Purpose**: Confirms host validation accepts equivalent hosts after normalization of case and explicit port formatting.

**Data flow**: Builds a `NetworkPolicyAmendment` and `NetworkApprovalContext`, calls `Session::validated_network_policy_amendment_host`, and asserts the normalized host string is returned.

**Call relations**: Covers the permissive normalization branch of network approval amendment validation.

*Call graph*: 2 external calls (assert_eq!, validated_network_policy_amendment_host).


##### `validated_network_policy_amendment_host_rejects_mismatch`  (lines 684–699)

```
fn validated_network_policy_amendment_host_rejects_mismatch()
```

**Purpose**: Confirms host validation rejects amendments whose host does not match the approved request host.

**Data flow**: Creates mismatched amendment/context values, calls `validated_network_policy_amendment_host`, expects an error, and asserts the error message mentions host mismatch.

**Call relations**: Covers the defensive rejection branch for network policy amendments.

*Call graph*: 2 external calls (assert!, validated_network_policy_amendment_host).


##### `start_managed_network_proxy_applies_execpolicy_network_rules`  (lines 702–734)

```
async fn start_managed_network_proxy_applies_execpolicy_network_rules() -> anyhow::Result<()>
```

**Purpose**: Verifies managed proxy startup merges allowlisted domains from exec policy into the proxy configuration.

**Data flow**: Builds a workspace-write permission profile and proxy spec, adds an HTTPS allow rule for `example.com` to an empty `Policy`, starts the managed proxy, fetches current proxy config, and asserts `allowed_domains()` contains `example.com`.

**Call relations**: Exercises `Session::start_managed_network_proxy` with exec-policy-derived network rules.

*Call graph*: calls 2 internal fn (from_config_and_constraints, workspace_write); 5 external calls (assert_eq!, empty, start_managed_network_proxy, default, default).


##### `start_managed_network_proxy_ignores_invalid_execpolicy_network_rules`  (lines 737–779)

```
async fn start_managed_network_proxy_ignores_invalid_execpolicy_network_rules() -> anyhow::Result<()>
```

**Purpose**: Checks that exec-policy rules outside managed-network constraints are ignored rather than widening the proxy allowlist.

**Data flow**: Creates a proxy spec constrained to `managed.example.com`, adds an unrelated allow rule for `example.com`, starts the proxy, and asserts the resulting allowlist contains only the managed constraint domain.

**Call relations**: Validates that managed requirements remain authoritative over unrelated exec-policy rules.

*Call graph*: calls 2 internal fn (from_config_and_constraints, workspace_write); 7 external calls (default, assert_eq!, empty, start_managed_network_proxy, default, default, from).


##### `managed_network_proxy_decider_survives_full_access_start`  (lines 782–847)

```
async fn managed_network_proxy_decider_survives_full_access_start() -> anyhow::Result<()>
```

**Purpose**: Ensures a proxy started under full-access permissions still retains a functioning policy decider after later reconfiguration to a restricted profile.

**Data flow**: Starts a managed proxy with `PermissionProfile::Disabled`, installs a counting async decider that returns `ask`, reapplies a workspace-write spec, performs a raw HTTP request through the proxy, and asserts a 403 allowlist block plus exactly one decider invocation.

**Call relations**: Covers a subtle lifecycle where proxy infrastructure is initialized before restrictions are applied.

*Call graph*: calls 2 internal fn (from_config_and_constraints, workspace_write); 14 external calls (clone, new, default, from_secs, from_utf8_lossy, assert!, assert_eq!, empty, start_managed_network_proxy, default (+4 more)).


##### `new_turn_refreshes_managed_network_proxy_for_sandbox_change`  (lines 850–937)

```
async fn new_turn_refreshes_managed_network_proxy_for_sandbox_change() -> anyhow::Result<()>
```

**Purpose**: Verifies that creating a new turn with a sandbox-policy change recomputes the managed proxy configuration.

**Data flow**: Starts with a proxy spec that combines explicit config and managed requirements, injects it into session state/services, creates a new turn switching to `DangerFullAccess`, then reloads the stored proxy and asserts the explicit `evil.com` domain was removed while managed requirement domains remain.

**Call relations**: Exercises turn creation as the trigger for proxy refresh when permission profile changes.

*Call graph*: calls 3 internal fn (from_config_and_constraints, make_session_and_context, workspace_write); 9 external calls (new, default, assert_eq!, empty, start_managed_network_proxy, default, default, from, vec!).


##### `danger_full_access_turns_do_not_expose_managed_network_proxy`  (lines 940–962)

```
async fn danger_full_access_turns_do_not_expose_managed_network_proxy() -> anyhow::Result<()>
```

**Purpose**: Checks that turns running with full filesystem/network access do not receive a managed network proxy handle in their turn context.

**Data flow**: Builds a session configured with `PermissionProfile::Disabled` and enabled network proxy spec, creates a default turn, and asserts `turn_context.network` is `None`.

**Call relations**: Documents the invariant that managed network is hidden from danger-full-access turns.

*Call graph*: calls 2 internal fn (from_config_and_constraints, make_session_with_config); 3 external calls (default, assert!, default).


##### `danger_full_access_tool_attempts_do_not_enforce_managed_network`  (lines 965–1075)

```
async fn danger_full_access_tool_attempts_do_not_enforce_managed_network() -> anyhow::Result<()>
```

**Purpose**: Verifies tool sandbox attempts under danger-full-access do not set `enforce_managed_network`, even when managed network requirements are configured globally.

**Data flow**: Defines a probe tool runtime that records `attempt.enforce_managed_network`, builds a session with disabled permission profile plus managed-network requirements in the config layer stack, runs the tool through `ToolOrchestrator`, and asserts the recorded flag is `false`.

**Call relations**: Covers the interaction between tool sandbox orchestration and session-level managed-network configuration.

*Call graph*: calls 4 internal fn (from_config_and_constraints, make_session_with_config, new, plain); 6 external calls (clone, default, default, assert!, assert_eq!, default).


##### `workspace_write_turns_continue_to_expose_managed_network_proxy`  (lines 1078–1101)

```
async fn workspace_write_turns_continue_to_expose_managed_network_proxy() -> anyhow::Result<()>
```

**Purpose**: Checks the opposite case of the previous test: workspace-write turns should still expose managed network.

**Data flow**: Creates a session with workspace-write permissions and enabled network proxy spec, creates a default turn, and asserts `turn_context.network.is_some()`.

**Call relations**: Provides the positive control for managed-network exposure.

*Call graph*: calls 3 internal fn (from_config_and_constraints, make_session_with_config, workspace_write); 3 external calls (default, assert!, default).


##### `user_shell_commands_do_not_inherit_managed_network_proxy`  (lines 1104–1151)

```
async fn user_shell_commands_do_not_inherit_managed_network_proxy() -> anyhow::Result<()>
```

**Purpose**: Ensures standalone user shell commands do not inherit `HTTP_PROXY` from the managed network proxy environment.

**Data flow**: Creates a session with managed network enabled, starts a default turn, executes a shell command that prints `HTTP_PROXY` or `not-set`, then consumes events until `ExecCommandEnd` and asserts stdout is `not-set`.

**Call relations**: Tests the explicit design choice that user shell commands bypass managed proxy env injection.

*Call graph*: calls 3 internal fn (from_config_and_constraints, make_session_with_config_and_rx, workspace_write); 7 external calls (clone, new, default, assert!, assert_eq!, execute_user_shell_command, default).


##### `get_base_instructions_no_user_content`  (lines 1154–1207)

```
async fn get_base_instructions_no_user_content()
```

**Purpose**: Verifies `Session::get_base_instructions` returns the session-stored base instructions for several model slugs without injecting user content.

**Data flow**: Loads bundled model metadata and test config, computes `ModelInfo` per slug, writes each model's `base_instructions` into session state, calls `get_base_instructions`, and asserts the returned text matches the stored instructions.

**Call relations**: Covers session-level override behavior for base instructions independent of live turn context.

*Call graph*: calls 2 internal fn (test_config, make_session_and_context); 4 external calls (assert_eq!, bundled_models_response, include_str!, vec!).


##### `reload_user_config_layer_updates_effective_apps_config`  (lines 1210–1240)

```
async fn reload_user_config_layer_updates_effective_apps_config()
```

**Purpose**: Checks that reloading the user config layer updates effective app configuration in the session config stack.

**Data flow**: Writes a user `config.toml` with `[apps.calendar]` settings, calls `session.reload_user_config_layer()`, reads the refreshed config, deserializes the effective `apps` table, and asserts the calendar app flags changed.

**Call relations**: Exercises runtime config reload against the merged config-layer stack.

*Call graph*: calls 1 internal fn (make_session_and_context); 5 external calls (assert!, assert_eq!, deserialize, create_dir_all, write).


##### `reload_user_config_layer_updates_base_and_selected_profile_layers`  (lines 1243–1304)

```
async fn reload_user_config_layer_updates_base_and_selected_profile_layers()
```

**Purpose**: Verifies user-config reload merges both base and selected profile files and preserves the selected profile path.

**Data flow**: Creates base and profile TOML files, loads a config pointing at the profile file, swaps it into session state, edits both files, reloads the user layer, and asserts the effective merged user config contains the new profile model and updated base approval policy.

**Call relations**: Covers profile-aware reload behavior rather than only the default user config file.

*Call graph*: calls 3 internal fn (without_managed_config_for_tests, without_managed_config_for_tests, make_session_and_context); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `reload_user_config_layer_refreshes_hooks`  (lines 1307–1378)

```
async fn reload_user_config_layer_refreshes_hooks() -> anyhow::Result<()>
```

**Purpose**: Ensures reloading user config rebuilds the session's hook registry and activates trusted hooks.

**Data flow**: Creates a session with `Feature::CodexHooks`, writes a user config containing a `SessionStart` hook plus trusted hash state, confirms hooks are initially absent, reloads the user config layer, and asserts `preview_session_start` now returns one hook.

**Call relations**: Tests the coupling between config reload and `Hooks` reconstruction.

*Call graph*: calls 1 internal fn (make_session_with_config); 9 external calls (assert!, assert_eq!, list_hooks, default, from_value, json!, create_dir_all, write, to_string).


##### `refresh_runtime_config_refreshes_hooks`  (lines 1381–1453)

```
async fn refresh_runtime_config_refreshes_hooks() -> anyhow::Result<()>
```

**Purpose**: Checks that replacing the runtime config object also refreshes hooks, not just scalar config fields.

**Data flow**: Enables hooks in session state, writes a trusted hook config file, confirms current hooks preview is empty, loads the latest config from disk, calls `refresh_runtime_config`, and asserts the hook preview now contains one entry.

**Call relations**: Complements user-layer reload by covering the broader runtime-config refresh path.

*Call graph*: calls 2 internal fn (load_latest_config_for_session, make_session_and_context); 12 external calls (new, assert!, assert_eq!, try_from, version_for_toml, format!, from_value, json!, create_dir_all, write (+2 more)).


##### `reload_user_config_layer_updates_effective_tool_suggest_config`  (lines 1456–1482)

```
async fn reload_user_config_layer_updates_effective_tool_suggest_config()
```

**Purpose**: Verifies user config reload normalizes and applies `tool_suggest.disabled_tools` entries.

**Data flow**: Writes a user config with connector/plugin disabled-tool entries containing extra whitespace, reloads the user layer, reads session config, and asserts the normalized `ToolSuggestDisabledTool` vector matches expected IDs.

**Call relations**: Covers runtime refresh of tool-suggestion settings specifically.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert_eq!, create_dir_all, write).


##### `refresh_runtime_config_updates_runtime_refreshable_fields_and_keeps_session_static_settings`  (lines 1485–1538)

```
async fn refresh_runtime_config_updates_runtime_refreshable_fields_and_keeps_session_static_settings()
```

**Purpose**: Checks that runtime refresh updates refreshable config-derived fields while preserving session-static settings like model and notify commands.

**Data flow**: Writes user config affecting apps and tool-suggest, loads current config, mutates a candidate next config's `model` and `notify`, calls `refresh_runtime_config`, then asserts apps/tool-suggest changed but `model` and `notify` stayed equal to the original session config.

**Call relations**: Documents the split between mutable runtime config and immutable session-start settings.

*Call graph*: calls 2 internal fn (load_latest_config_for_session, make_session_and_context); 6 external calls (assert!, assert_eq!, deserialize, create_dir_all, write, vec!).


##### `collect_explicit_app_ids_from_skill_items_includes_linked_mentions`  (lines 1541–1551)

```
fn collect_explicit_app_ids_from_skill_items_includes_linked_mentions()
```

**Purpose**: Tests that explicit `app://...` markdown links inside skill content are recognized as connector references.

**Data flow**: Builds one connector and one skill message containing `[$calendar](app://calendar)`, calls `collect_explicit_app_ids_from_skill_items`, and asserts the returned set contains `calendar`.

**Call relations**: Covers the explicit-link parsing branch of app mention extraction.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `collect_explicit_app_ids_from_skill_items_resolves_unambiguous_plain_mentions`  (lines 1554–1564)

```
fn collect_explicit_app_ids_from_skill_items_resolves_unambiguous_plain_mentions()
```

**Purpose**: Checks that plain `$calendar` mentions resolve when there is no naming conflict.

**Data flow**: Creates connector and skill fixtures, calls the extraction helper with an empty conflict map, and asserts the connector ID is returned.

**Call relations**: Covers the plain-text mention branch under unambiguous conditions.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `collect_explicit_app_ids_from_skill_items_skips_plain_mentions_with_skill_conflicts`  (lines 1567–1581)

```
fn collect_explicit_app_ids_from_skill_items_skips_plain_mentions_with_skill_conflicts()
```

**Purpose**: Ensures plain `$name` mentions are ignored when the same lowercase name is already used by a skill, avoiding ambiguous connector resolution.

**Data flow**: Supplies a conflict map containing `calendar`, runs extraction, and asserts the result is an empty set.

**Call relations**: Documents the ambiguity-avoidance rule in app mention parsing.

*Call graph*: 3 external calls (from, assert_eq!, vec!).


##### `reconstruct_history_matches_live_compactions`  (lines 1584–1595)

```
async fn reconstruct_history_matches_live_compactions()
```

**Purpose**: Verifies rollout-history reconstruction produces the same prompt-visible history as live compaction logic.

**Data flow**: Builds a sample rollout and expected history via `sample_rollout`, creates a fresh turn, calls `reconstruct_history_from_rollout`, and asserts both reconstructed history and window ID match expectations.

**Call relations**: Uses the shared rollout fixture to compare replay behavior against live `ContextManager` compaction.

*Call graph*: calls 2 internal fn (make_session_and_context, sample_rollout); 1 external calls (assert_eq!).


##### `reconstruct_history_uses_replacement_history_verbatim`  (lines 1598–1635)

```
async fn reconstruct_history_uses_replacement_history_verbatim()
```

**Purpose**: Checks that a `CompactedItem` carrying `replacement_history` bypasses normal reconstruction and is installed exactly as provided.

**Data flow**: Creates a rollout containing one compacted item with explicit replacement history and window ID 42, reconstructs history, and asserts both fields are returned unchanged.

**Call relations**: Covers the explicit replacement-history branch of rollout replay.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (assert_eq!, vec!).


##### `record_initial_history_reconstructs_resumed_transcript`  (lines 1638–1652)

```
async fn record_initial_history_reconstructs_resumed_transcript()
```

**Purpose**: Ensures `record_initial_history` for resumed sessions reconstructs and stores the prompt-visible transcript from rollout items.

**Data flow**: Generates sample rollout items and expected history, records `InitialHistory::Resumed`, then reads session history from state and compares raw items to the expected transcript.

**Call relations**: Exercises the resumed-history initialization path.

*Call graph*: calls 3 internal fn (make_session_and_context, sample_rollout, default); 3 external calls (from, assert_eq!, Resumed).


##### `resize_all_images_prepares_failures_before_history_insertion`  (lines 1655–1712)

```
async fn resize_all_images_prepares_failures_before_history_insertion()
```

**Purpose**: Verifies image preprocessing rewrites invalid inline images to explanatory text before function-call output is inserted into history.

**Data flow**: Creates a session with `Feature::ResizeAllImages`, records a `FunctionCallOutput` containing text, an invalid data URL image, and a valid remote image, then asserts stored history replaced only the invalid image with a fixed omission message.

**Call relations**: Covers preprocessing of newly recorded conversation items under image-resize mode.

*Call graph*: calls 2 internal fn (make_session_and_context_with_auth_and_config_and_rx, from_api_key); 5 external calls (new, assert_eq!, ContentItems, from_ref, vec!).


##### `resize_all_images_prepares_resumed_history_before_installing_it`  (lines 1715–1765)

```
async fn resize_all_images_prepares_resumed_history_before_installing_it()
```

**Purpose**: Checks the same image-preparation behavior for resumed rollout history before it is installed into session state.

**Data flow**: Creates a resumed history item containing an invalid inline image and text, records it as `InitialHistory::Resumed`, and asserts the installed history contains omission text plus the original text item.

**Call relations**: Extends image preprocessing coverage to resumed-session initialization.

*Call graph*: calls 3 internal fn (make_session_and_context_with_auth_and_config_and_rx, from_api_key, default); 5 external calls (from, new, assert_eq!, Resumed, vec!).


##### `resolve_multi_agent_version_handles_unset_and_legacy_history`  (lines 1768–1831)

```
fn resolve_multi_agent_version_handles_unset_and_legacy_history()
```

**Purpose**: Tests how multi-agent version is inferred from initial history and inherited settings across new, resumed, and forked sessions.

**Data flow**: Constructs several `InitialHistory` variants with and without `SessionMeta` items and inherited versions, calls `resolve_multi_agent_version`, and asserts the returned `Option<MultiAgentVersion>` for each case.

**Call relations**: Documents fallback behavior for legacy histories and explicit metadata overrides.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_eq!).


##### `record_initial_history_new_defers_initial_context_until_first_turn`  (lines 1834–1843)

```
async fn record_initial_history_new_defers_initial_context_until_first_turn()
```

**Purpose**: Ensures `InitialHistory::New` does not eagerly seed prompt context or previous-turn state before the first turn starts.

**Data flow**: Creates a fresh session, records `InitialHistory::New`, then asserts history is empty, `reference_context_item` is `None`, and `previous_turn_settings` is `None`.

**Call relations**: Covers the empty-start branch of session initialization.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (assert!, assert_eq!).


##### `session_meta_item`  (lines 1845–1857)

```
fn session_meta_item(
    thread_id: ThreadId,
    multi_agent_version: Option<MultiAgentVersion>,
) -> RolloutItem
```

**Purpose**: Builds a `RolloutItem::SessionMeta` fixture with a chosen thread ID and optional multi-agent version.

**Data flow**: Creates `SessionMeta` with defaults plus supplied fields, wraps it in `SessionMetaLine`, then in `RolloutItem::SessionMeta`.

**Call relations**: Used by multi-agent version tests to embed explicit metadata into synthetic rollout history.

*Call graph*: calls 1 internal fn (default); 1 external calls (SessionMeta).


##### `resumed_history_injects_initial_context_on_first_context_update_only`  (lines 1860–1891)

```
async fn resumed_history_injects_initial_context_on_first_context_update_only()
```

**Purpose**: Verifies resumed history remains untouched until the first explicit context update, and that the initial context is injected only once.

**Data flow**: Records resumed rollout history, confirms stored history equals reconstructed transcript, calls `record_context_updates_and_set_reference_context_item` twice, and asserts the first call appends initial context while the second leaves history unchanged.

**Call relations**: Covers deferred baseline-context seeding for resumed sessions.

*Call graph*: calls 3 internal fn (make_session_and_context, sample_rollout, default); 3 external calls (from, assert_eq!, Resumed).


##### `record_initial_history_seeds_token_info_from_rollout`  (lines 1894–1968)

```
async fn record_initial_history_seeds_token_info_from_rollout()
```

**Purpose**: Checks that token usage state is initialized from the latest non-`None` `TokenCountEvent` in resumed rollout history.

**Data flow**: Appends several token-count events with alternating `Some`/`None` info to sample rollout items, records resumed history, then asserts session state's `token_info()` equals the last concrete `TokenUsageInfo`.

**Call relations**: Exercises rollout replay's side effect on token accounting state.

*Call graph*: calls 3 internal fn (make_session_and_context, sample_rollout, default); 5 external calls (from, assert_eq!, TokenCount, Resumed, EventMsg).


##### `recompute_token_usage_uses_session_base_instructions`  (lines 1971–2008)

```
async fn recompute_token_usage_uses_session_base_instructions()
```

**Purpose**: Verifies token recomputation uses the session's overridden base instructions rather than the model's default instructions from the turn context.

**Data flow**: Overrides `state.session_configuration.base_instructions`, records a user message, computes expected token count with explicit `BaseInstructions`, confirms it differs from model-estimated count, runs `recompute_token_usage`, and asserts stored token usage matches the session-based estimate.

**Call relations**: Covers a subtle source-of-truth distinction in token estimation.

*Call graph*: calls 2 internal fn (make_session_and_context, user_message); 3 external calls (assert_eq!, assert_ne!, from_ref).


##### `recompute_token_usage_updates_model_context_window`  (lines 2011–2030)

```
async fn recompute_token_usage_updates_model_context_window()
```

**Purpose**: Ensures recomputing token usage also refreshes the stored model context window from the current turn context.

**Data flow**: Seeds session state with old token info and context window, mutates `turn_context.model_info.context_window`, runs `recompute_token_usage`, and asserts the stored `model_context_window` changed to the new value.

**Call relations**: Tests token recomputation as both usage and metadata refresh.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (assert_eq!, default).


##### `record_token_usage_info_notifies_extension_contributors`  (lines 2033–2147)

```
async fn record_token_usage_info_notifies_extension_contributors()
```

**Purpose**: Checks that recording token usage updates cumulative totals and invokes extension contributors with session/thread/turn stores.

**Data flow**: Installs a custom `TokenUsageContributor`, seeds session/thread extension data markers, records two token-usage increments, then drains recorded callbacks and asserts IDs, cumulative totals, last usage, model context window, and marker visibility.

**Call relations**: Exercises extension lifecycle integration for token accounting.

*Call graph*: calls 1 internal fn (make_session_and_context); 7 external calls (clone, new, new, assert_eq!, new, new, vec!).


##### `turn_start_lifecycle_exposes_turn_metadata_and_token_baseline`  (lines 2150–2253)

```
async fn turn_start_lifecycle_exposes_turn_metadata_and_token_baseline()
```

**Purpose**: Verifies turn-start lifecycle contributors receive turn metadata and the total token usage baseline present at turn start.

**Data flow**: Installs a `TurnLifecycleContributor`, seeds total token usage via `set_total_token_usage`, spawns a never-ending regular task, aborts it, and asserts the contributor recorded session/thread/turn IDs, collaboration mode, and baseline token usage.

**Call relations**: Uses task spawning to trigger the real turn-start lifecycle path.

*Call graph*: calls 2 internal fn (make_session_and_context, set_total_token_usage); 6 external calls (clone, new, new, assert_eq!, new, new).


##### `turn_error_lifecycle_exposes_error_and_stores`  (lines 2256–2339)

```
async fn turn_error_lifecycle_exposes_error_and_stores()
```

**Purpose**: Checks that explicit turn-error lifecycle emission passes the expected `CodexErrorInfo` and extension stores.

**Data flow**: Installs a `TurnLifecycleContributor`, inserts session/thread markers, calls `emit_turn_error_lifecycle` with `UsageLimitExceeded`, and asserts the contributor saw the correct IDs, error enum, and marker presence.

**Call relations**: Covers the error-reporting lifecycle path without needing a full failing turn.

*Call graph*: calls 1 internal fn (make_session_and_context); 6 external calls (clone, new, new, assert_eq!, new, new).


##### `config_change_contributor_observes_effective_config_changes`  (lines 2342–2466)

```
async fn config_change_contributor_observes_effective_config_changes()
```

**Purpose**: Verifies config contributors are notified both for settings-driven model changes and runtime-config refreshes affecting effective config.

**Data flow**: Installs a `ConfigContributor`, captures original model/disabled-tools state, updates collaboration mode through `update_settings`, writes a user config changing disabled tools, refreshes runtime config, and asserts two recorded config-change callbacks with expected before/after values.

**Call relations**: Exercises both session-setting updates and disk-backed config refresh through the extension API.

*Call graph*: calls 2 internal fn (load_latest_config_for_session, make_session_and_context); 10 external calls (clone, new, default, new, assert_eq!, new, create_dir_all, write, new, vec!).


##### `record_initial_history_reconstructs_forked_transcript`  (lines 2469–2479)

```
async fn record_initial_history_reconstructs_forked_transcript()
```

**Purpose**: Ensures forked initial history is reconstructed into prompt-visible transcript the same way as resumed history.

**Data flow**: Builds sample rollout items and expected history, records `InitialHistory::Forked`, then asserts session history equals the expected reconstructed transcript.

**Call relations**: Covers the forked-history initialization branch.

*Call graph*: calls 2 internal fn (make_session_and_context, sample_rollout); 2 external calls (assert_eq!, Forked).


##### `session_configured_reports_permission_profile_for_external_sandbox`  (lines 2482–2509)

```
async fn session_configured_reports_permission_profile_for_external_sandbox() -> anyhow::Result<()>
```

**Purpose**: Checks that `SessionConfigured` reports an explicit external permission profile rather than collapsing it into a lossy legacy sandbox representation.

**Data flow**: Builds a `test_codex` instance with `SandboxPolicy::ExternalSandbox` and matching `PermissionProfile::External`, then asserts the emitted configured event carries the exact external profile.

**Call relations**: Documents protocol fidelity for external sandbox sessions.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 1 external calls (assert_eq!).


##### `session_permission_profile_rebinds_runtime_workspace_roots`  (lines 2512–2555)

```
async fn session_permission_profile_rebinds_runtime_workspace_roots() -> anyhow::Result<()>
```

**Purpose**: Verifies symbolic workspace-root permissions stored in session permission-profile state are rebound against current runtime workspace roots when settings change.

**Data flow**: Builds config with an old writable root, derives session permission-profile state, confirms the stored symbolic policy does not directly grant the old path, installs it into a test `SessionConfiguration`, applies updated workspace roots, and asserts the resulting filesystem policy grants the new root but not the old one.

**Call relations**: Covers the distinction between symbolic stored permissions and materialized runtime policy.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 7 external calls (default, new, assert!, default, test_path_buf, new, vec!).


##### `fork_startup_context_then_first_turn_diff_snapshot`  (lines 2558–2667)

```
async fn fork_startup_context_then_first_turn_diff_snapshot() -> anyhow::Result<()>
```

**Purpose**: Creates a persisted source thread, forks it with changed approval policy and plan mode, then snapshots the first forked request context for regression testing.

**Data flow**: Runs a source thread against a mock SSE server, flushes rollout to disk, forks the thread with modified config, submits a first forked turn with plan-mode overrides, captures the outgoing request, formats a labeled context snapshot, and asserts it with `insta`.

**Call relations**: Acts as a high-level regression test for startup context preservation and first-turn diff generation after forking.

*Call graph*: calls 7 internal fn (allow_any, default, format_labeled_requests_snapshot, mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (default, wait_for_event, clone_current, vec!).


##### `record_initial_history_forked_hydrates_previous_turn_settings`  (lines 2670–2750)

```
async fn record_initial_history_forked_hydrates_previous_turn_settings()
```

**Purpose**: Ensures forked rollout history can hydrate `previous_turn_settings` and `reference_context_item` even when no prompt-visible history remains.

**Data flow**: Builds a forked rollout containing `TurnStarted`, `UserMessage`, `TurnContext`, and `TurnComplete`, records it, then asserts previous-turn settings and reference context were restored while prompt history stayed empty.

**Call relations**: Covers fork replay's metadata hydration path separate from transcript reconstruction.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert_eq!, Forked, vec!).


##### `thread_rollback_drops_last_turn_from_history`  (lines 2753–2818)

```
async fn thread_rollback_drops_last_turn_from_history()
```

**Purpose**: Verifies rolling back one persisted turn removes the latest turn from in-memory history, clears previous-turn/reference-context state, and persists a rollback marker.

**Data flow**: Attaches thread persistence, seeds history and rollout with initial context plus two turns, sets stale previous-turn/reference-context state, invokes `handlers::thread_rollback`, waits for `ThreadRolledBack`, then asserts history now contains only initial context plus turn 1 and that persisted rollout includes a `ThreadRolledBack` event.

**Call relations**: Exercises the normal rollback path against persisted rollout storage.

*Call graph*: calls 5 internal fn (thread_rollback, attach_thread_persistence, make_session_and_context_with_rx, wait_for_thread_rolled_back, get_rollout_history); 6 external calls (get_mut, new, assert!, assert_eq!, panic!, vec!).


##### `thread_rollback_clears_history_when_num_turns_exceeds_existing_turns`  (lines 2821–2848)

```
async fn thread_rollback_clears_history_when_num_turns_exceeds_existing_turns()
```

**Purpose**: Checks rollback clamps to available turns and leaves only initial context when asked to remove more turns than exist.

**Data flow**: Persists initial context plus one user turn, requests rollback of 99 turns, waits for rollback event, and asserts remaining history is just the initial context.

**Call relations**: Covers oversized rollback requests.

*Call graph*: calls 4 internal fn (thread_rollback, attach_thread_persistence, make_session_and_context_with_rx, wait_for_thread_rolled_back); 4 external calls (get_mut, new, assert_eq!, vec!).


##### `thread_rollback_fails_without_persisted_thread_history`  (lines 2851–2870)

```
async fn thread_rollback_fails_without_persisted_thread_history()
```

**Purpose**: Ensures rollback is rejected when the session has no persisted rollout history to replay from.

**Data flow**: Records initial context only in memory, calls `thread_rollback`, waits for an error event tagged `ThreadRollbackFailed`, and asserts history is unchanged.

**Call relations**: Covers the precondition check that rollback requires persisted thread history.

*Call graph*: calls 3 internal fn (thread_rollback, make_session_and_context_with_rx, wait_for_thread_rollback_failed); 1 external calls (assert_eq!).


##### `thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay`  (lines 2873–2992)

```
async fn thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay()
```

**Purpose**: Verifies rollback replay recomputes previous-turn settings and reference context from the surviving persisted turn rather than keeping stale state.

**Data flow**: Persists two complete turns with distinct `TurnContextItem`s, replaces in-memory history with stale data, sets stale previous-turn settings, rolls back one turn, waits for success, and asserts surviving history, recomputed previous-turn settings, and restored reference context all match turn 1.

**Call relations**: Covers replay-derived metadata restoration after rollback.

*Call graph*: calls 6 internal fn (thread_rollback, assistant_message, attach_thread_persistence, make_session_and_context_with_rx, user_message, wait_for_thread_rolled_back); 11 external calls (get_mut, default, new, assert_eq!, TurnComplete, TurnStarted, UserMessage, EventMsg, ResponseItem, TurnContext (+1 more)).


##### `thread_rollback_restores_cleared_reference_context_item_after_compaction`  (lines 2995–3114)

```
async fn thread_rollback_restores_cleared_reference_context_item_after_compaction()
```

**Purpose**: Checks rollback after a compaction turn restores compacted replacement history, clears reference context, and restores the compact window ID.

**Data flow**: Persists a first turn, a compaction turn with `replacement_history` and window ID 7, and a later turn to be rolled back; seeds stale in-memory state and auto-compact window ID 99; rolls back one turn; then asserts history equals compacted replacement history, reference context is `None`, and current window ID ends with `:7`.

**Call relations**: Exercises rollback replay across compaction boundaries.

*Call graph*: calls 6 internal fn (thread_rollback, assistant_message, attach_thread_persistence, make_session_and_context_with_rx, user_message, wait_for_thread_rolled_back); 13 external calls (get_mut, default, new, assert!, assert_eq!, TurnComplete, TurnStarted, UserMessage, Compacted, EventMsg (+3 more)).


##### `thread_rollback_persists_marker_and_replays_cumulatively`  (lines 3117–3237)

```
async fn thread_rollback_persists_marker_and_replays_cumulatively()
```

**Purpose**: Verifies repeated rollbacks accumulate persisted rollback markers and replay from the already-rolled-back persisted state.

**Data flow**: Persists three turns, performs two successive one-turn rollbacks, waits for both events, asserts in-memory history now contains only turn 1, then reloads rollout history and counts two `ThreadRolledBack` markers.

**Call relations**: Covers cumulative rollback semantics rather than one-shot truncation.

*Call graph*: calls 7 internal fn (thread_rollback, assistant_message, attach_thread_persistence, make_session_and_context_with_rx, user_message, wait_for_thread_rolled_back, get_rollout_history); 11 external calls (get_mut, default, new, assert_eq!, panic!, TurnComplete, TurnStarted, UserMessage, EventMsg, ResponseItem (+1 more)).


##### `thread_rollback_fails_when_turn_in_progress`  (lines 3240–3258)

```
async fn thread_rollback_fails_when_turn_in_progress()
```

**Purpose**: Ensures rollback is rejected while a turn is active.

**Data flow**: Seeds initial context, manually sets `active_turn` to `Some(ActiveTurn::default())`, invokes rollback, waits for `ThreadRollbackFailed`, and asserts history is unchanged.

**Call relations**: Covers the active-turn guard on rollback.

*Call graph*: calls 4 internal fn (thread_rollback, make_session_and_context_with_rx, wait_for_thread_rollback_failed, default); 1 external calls (assert_eq!).


##### `thread_rollback_fails_when_num_turns_is_zero`  (lines 3261–3279)

```
async fn thread_rollback_fails_when_num_turns_is_zero()
```

**Purpose**: Checks rollback rejects `num_turns == 0` with a specific error message and code.

**Data flow**: Seeds initial context, calls rollback with zero turns, waits for the failure event, and asserts both the message and `CodexErrorInfo::ThreadRollbackFailed` are present while history remains unchanged.

**Call relations**: Covers argument validation for rollback requests.

*Call graph*: calls 3 internal fn (thread_rollback, make_session_and_context_with_rx, wait_for_thread_rollback_failed); 1 external calls (assert_eq!).


##### `set_rate_limits_retains_previous_credits`  (lines 3282–3385)

```
async fn set_rate_limits_retains_previous_credits()
```

**Purpose**: Verifies `SessionState::set_rate_limits` preserves prior credits/plan metadata when a later update omits them.

**Data flow**: Builds a standalone `SessionState`, seeds an initial `RateLimitSnapshot` with credits and plan type, applies an update lacking those fields, and asserts `latest_rate_limits` merged new windows with old credits/plan values and defaulted `limit_id` to `codex_other`.

**Call relations**: Tests state-merging logic directly without a full session.

*Call graph*: calls 5 internal fn (build_test_config, new, construct_model_info_offline_for_tests, get_model_offline_for_tests, new); 6 external calls (clone, new, new, assert_eq!, from_config, tempdir).


##### `set_rate_limits_updates_plan_type_when_present`  (lines 3388–3491)

```
async fn set_rate_limits_updates_plan_type_when_present()
```

**Purpose**: Checks that a later rate-limit update replaces plan type when it explicitly provides one.

**Data flow**: Creates `SessionState`, seeds initial snapshot with `PlanType::Plus`, applies an update with `PlanType::Pro` and no credits, and asserts the merged snapshot kept old credits but replaced plan type and defaulted `limit_id` to `codex`.

**Call relations**: Complements the previous merge test with explicit plan-type replacement.

*Call graph*: calls 5 internal fn (build_test_config, new, construct_model_info_offline_for_tests, get_model_offline_for_tests, new); 6 external calls (clone, new, new, assert_eq!, from_config, tempdir).


##### `prefers_structured_content_when_present`  (lines 3494–3519)

```
fn prefers_structured_content_when_present()
```

**Purpose**: Tests MCP tool-result conversion prefers non-null `structured_content` over plain `content` blocks.

**Data flow**: Builds `McpCallToolResult` with both `content` and JSON `structured_content`, converts it with `into_function_call_output_payload`, and asserts the payload body is serialized structured JSON with `success: Some(true)`.

**Call relations**: Covers one branch of MCP result normalization.

*Call graph*: 5 external calls (assert_eq!, json!, Text, to_string, vec!).


##### `includes_timed_out_message`  (lines 3522–3539)

```
async fn includes_timed_out_message()
```

**Purpose**: Verifies formatted exec output prepends a timeout message when `ExecToolCallOutput.timed_out` is true.

**Data flow**: Constructs an `ExecToolCallOutput` with empty stdout/stderr, aggregated output, one-second duration, and `timed_out: true`, formats it with the turn's truncation policy, and asserts the exact output string.

**Call relations**: Tests user-visible formatting of timed-out command output.

*Call graph*: calls 3 internal fn (make_session_and_context, format_exec_output_str, new); 3 external calls (from_secs, new, assert_eq!).


##### `turn_context_with_model_updates_model_fields`  (lines 3542–3576)

```
async fn turn_context_with_model_updates_model_fields()
```

**Purpose**: Checks `TurnContext::with_model` updates all model-dependent fields consistently, including reasoning effort fallback and truncation policy.

**Data flow**: Creates a turn context with minimal reasoning effort, calls `with_model("gpt-5.4")`, fetches expected `ModelInfo` from the models manager, and asserts updated config, collaboration mode, model info, reasoning effort, and truncation policy all match the new model.

**Call relations**: Covers model-switch behavior on a turn context object.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert_eq!).


##### `falls_back_to_content_when_structured_is_null`  (lines 3579–3596)

```
fn falls_back_to_content_when_structured_is_null()
```

**Purpose**: Ensures MCP result conversion ignores `structured_content` when it is explicitly JSON null and falls back to serializing `content`.

**Data flow**: Builds a result with text blocks and `structured_content: Some(Value::Null)`, converts it, and asserts the payload body is serialized content-array JSON with `success: Some(true)`.

**Call relations**: Covers the null-structured-content fallback branch.

*Call graph*: 4 external calls (assert_eq!, Text, to_string, vec!).


##### `success_flag_reflects_is_error_true`  (lines 3599–3616)

```
fn success_flag_reflects_is_error_true()
```

**Purpose**: Checks MCP result conversion maps `is_error: true` to `success: Some(false)` even when structured content is used.

**Data flow**: Creates a result with `structured_content` and `is_error: Some(true)`, converts it, and asserts the serialized body plus `success: Some(false)`.

**Call relations**: Covers success-flag derivation from MCP error metadata.

*Call graph*: 5 external calls (assert_eq!, json!, Text, to_string, vec!).


##### `success_flag_true_with_no_error_and_content_used`  (lines 3619–3636)

```
fn success_flag_true_with_no_error_and_content_used()
```

**Purpose**: Verifies MCP result conversion yields `success: Some(true)` when `is_error` is false and plain content is used.

**Data flow**: Builds a content-only result with `is_error: Some(false)`, converts it, and asserts the serialized content body and success flag.

**Call relations**: Provides the positive-control branch for MCP result normalization.

*Call graph*: 4 external calls (assert_eq!, Text, to_string, vec!).


##### `wait_for_thread_rolled_back`  (lines 3638–3652)

```
async fn wait_for_thread_rolled_back(rx: &async_channel::Receiver<Event>) -> ThreadRolledBackEvent
```

**Purpose**: Polls an event receiver until a `ThreadRolledBackEvent` arrives or a two-second deadline expires.

**Data flow**: Repeatedly computes remaining time, awaits `rx.recv()` under `tokio::time::timeout`, ignores unrelated events, and returns the first `ThreadRolledBack` payload.

**Call relations**: Shared by rollback-success tests to avoid duplicating event-loop boilerplate.

*Call graph*: calls 1 internal fn (recv); called by 5 (thread_rollback_clears_history_when_num_turns_exceeds_existing_turns, thread_rollback_drops_last_turn_from_history, thread_rollback_persists_marker_and_replays_cumulatively, thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay, thread_rollback_restores_cleared_reference_context_item_after_compaction); 3 external calls (from_secs, now, timeout).


##### `wait_for_thread_rollback_failed`  (lines 3654–3672)

```
async fn wait_for_thread_rollback_failed(rx: &async_channel::Receiver<Event>) -> ErrorEvent
```

**Purpose**: Polls an event receiver until an `ErrorEvent` tagged `ThreadRollbackFailed` arrives.

**Data flow**: Loops with a two-second deadline, receives events under timeout, filters for `EventMsg::Error` whose `codex_error_info` matches `ThreadRollbackFailed`, and returns that payload.

**Call relations**: Used by rollback-failure tests to isolate the expected error event.

*Call graph*: calls 1 internal fn (recv); called by 3 (thread_rollback_fails_when_num_turns_is_zero, thread_rollback_fails_when_turn_in_progress, thread_rollback_fails_without_persisted_thread_history); 3 external calls (from_secs, now, timeout).


##### `attach_thread_persistence`  (lines 3674–3712)

```
async fn attach_thread_persistence(session: &mut Session) -> PathBuf
```

**Purpose**: Attaches a live persisted thread to a mutable test session and returns the materialized rollout path.

**Data flow**: Reads current config, creates `LiveThread` with `CreateThreadParams` derived from session/config metadata, stores it in `session.services.live_thread`, forces rollout materialization and flush, then loads and returns the current rollout path.

**Call relations**: A foundational helper for rollback and rollout-persistence tests that need durable thread history.

*Call graph*: calls 2 internal fn (default, create); called by 9 (cached_guardian_subagent_exposes_its_rollout_path, record_context_updates_and_set_reference_context_item_persists_baseline_without_emitting_diffs, record_context_updates_and_set_reference_context_item_persists_full_reinjection_to_rollout, record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout, thread_rollback_clears_history_when_num_turns_exceeds_existing_turns, thread_rollback_drops_last_turn_from_history, thread_rollback_persists_marker_and_replays_cumulatively, thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay, thread_rollback_restores_cleared_reference_context_item_after_compaction); 6 external calls (clone, new, current_rollout_path, ensure_rollout_materialized, flush_rollout, get_config).


##### `text_block`  (lines 3714–3719)

```
fn text_block(s: &str) -> serde_json::Value
```

**Purpose**: Builds a JSON text block fixture matching MCP content-item shape.

**Data flow**: Wraps the provided string in `json!({"type":"text","text":...})` and returns the resulting `serde_json::Value`.

**Call relations**: Used by MCP result-conversion tests to avoid repeating JSON literals.

*Call graph*: 1 external calls (json!).


##### `build_test_config`  (lines 3721–3727)

```
async fn build_test_config(codex_home: &Path) -> Config
```

**Purpose**: Loads the default test `Config` rooted at a supplied codex-home directory with managed config disabled.

**Data flow**: Runs `ConfigBuilder::without_managed_config_for_tests().codex_home(...).build().await` and unwraps success.

**Call relations**: Core helper used by nearly every session-construction helper and several direct state tests.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); called by 8 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_configuration_for_tests, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, set_rate_limits_retains_previous_credits, set_rate_limits_updates_plan_type_when_present); 1 external calls (to_path_buf).


##### `session_telemetry`  (lines 3729–3747)

```
fn session_telemetry(
    conversation_id: ThreadId,
    config: &Config,
    model_info: &ModelInfo,
    session_source: SessionSource,
) -> SessionTelemetry
```

**Purpose**: Constructs a `SessionTelemetry` object for a specific conversation/config/model/session-source combination.

**Data flow**: Reads the configured model slug via `get_model_offline_for_tests`, then calls `SessionTelemetry::new(...)` with fixed test account/originator metadata and returns it.

**Call relations**: Used by session-construction helpers to populate realistic telemetry in `SessionServices`.

*Call graph*: calls 2 internal fn (get_model_offline_for_tests, new); called by 2 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx).


##### `model_with_default_service_tier`  (lines 3749–3758)

```
fn model_with_default_service_tier(default_service_tier: Option<&str>) -> ModelInfo
```

**Purpose**: Creates a `ModelInfo` fixture for `gpt-5.4` with a configurable default service tier and one supported `Fast` tier entry.

**Data flow**: Loads base model info from slug, overwrites `service_tiers` and `default_service_tier`, and returns the modified `ModelInfo`.

**Call relations**: Shared by service-tier selection tests.

*Call graph*: calls 1 internal fn (model_info_from_slug); called by 6 (get_service_tier_does_not_default_when_model_has_no_default, get_service_tier_does_not_use_model_default_when_absent_and_fast_mode_enabled, get_service_tier_does_not_use_model_default_when_fast_mode_disabled, get_service_tier_drops_unsupported_configured_tier_when_fast_mode_enabled, get_service_tier_ignores_configured_tier_when_fast_mode_disabled, get_service_tier_keeps_supported_explicit_tier); 1 external calls (vec!).


##### `get_service_tier_does_not_use_model_default_when_absent_and_fast_mode_enabled`  (lines 3761–3772)

```
fn get_service_tier_does_not_use_model_default_when_absent_and_fast_mode_enabled()
```

**Purpose**: Asserts `get_service_tier` does not implicitly adopt the model's default fast tier when no explicit tier is configured.

**Data flow**: Builds a model fixture with default fast tier, calls `get_service_tier(None, true, &model_info)`, and asserts the result is `None`.

**Call relations**: One of several narrow tests documenting service-tier selection rules.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `get_service_tier_does_not_use_model_default_when_fast_mode_disabled`  (lines 3775–3786)

```
fn get_service_tier_does_not_use_model_default_when_fast_mode_disabled()
```

**Purpose**: Checks that disabling fast mode suppresses service-tier selection entirely, even if the model advertises a default fast tier.

**Data flow**: Creates the model fixture, calls `get_service_tier(None, false, ...)`, and asserts `None`.

**Call relations**: Pairs with the previous test to show fast-mode gating.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `get_service_tier_keeps_supported_explicit_tier`  (lines 3789–3800)

```
fn get_service_tier_keeps_supported_explicit_tier()
```

**Purpose**: Verifies an explicitly configured supported tier is preserved when fast mode is enabled.

**Data flow**: Builds the model fixture, calls `get_service_tier(Some(fast), true, ...)`, and asserts the same request value is returned.

**Call relations**: Covers the positive explicit-tier branch.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `get_service_tier_does_not_default_when_model_has_no_default`  (lines 3803–3814)

```
fn get_service_tier_does_not_default_when_model_has_no_default()
```

**Purpose**: Checks that no tier is selected when the model has no default service tier configured.

**Data flow**: Creates a model fixture with `default_service_tier: None`, calls `get_service_tier(None, true, ...)`, and asserts `None`.

**Call relations**: Documents absence-of-default behavior.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `get_service_tier_drops_unsupported_configured_tier_when_fast_mode_enabled`  (lines 3817–3844)

```
fn get_service_tier_drops_unsupported_configured_tier_when_fast_mode_enabled()
```

**Purpose**: Verifies unsupported configured tiers are dropped, while the special `default` request value is preserved, when fast mode is enabled.

**Data flow**: Calls `get_service_tier` three times with unsupported, `flex`, and `default` values and asserts `None`, `None`, and `Some(default)` respectively.

**Call relations**: Covers validation of configured service-tier strings.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `get_service_tier_ignores_configured_tier_when_fast_mode_disabled`  (lines 3847–3882)

```
fn get_service_tier_ignores_configured_tier_when_fast_mode_disabled()
```

**Purpose**: Checks that all configured service-tier values are ignored when fast mode is disabled.

**Data flow**: Calls `get_service_tier` with supported, default, unsupported, and absent values under `fast_mode_enabled = false`, asserting `None` each time.

**Call relations**: Completes the service-tier matrix.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `session_settings_null_service_tier_update_uses_default_service_tier`  (lines 3885–3899)

```
async fn session_settings_null_service_tier_update_uses_default_service_tier()
```

**Purpose**: Verifies a session-settings update with `service_tier: Some(None)` normalizes to the protocol's default request value.

**Data flow**: Builds a test `SessionConfiguration`, applies a `SessionSettingsUpdate` carrying a null service tier, and asserts the updated configuration stores `SERVICE_TIER_DEFAULT_REQUEST_VALUE`.

**Call relations**: Covers normalization of nullable service-tier updates.

*Call graph*: calls 1 internal fn (make_session_configuration_for_tests); 2 external calls (default, assert_eq!).


##### `session_settings_legacy_fast_service_tier_update_uses_priority_request_value`  (lines 3902–3916)

```
async fn session_settings_legacy_fast_service_tier_update_uses_priority_request_value()
```

**Purpose**: Checks that legacy `"fast"` service-tier updates are normalized to the modern fast request value.

**Data flow**: Builds a test `SessionConfiguration`, applies an update with `service_tier: Some(Some("fast"))`, and asserts the normalized stored value equals `ServiceTier::Fast.request_value()`.

**Call relations**: Documents backward-compatibility handling for legacy tier names.

*Call graph*: calls 1 internal fn (make_session_configuration_for_tests); 2 external calls (default, assert_eq!).


##### `make_session_configuration_for_tests`  (lines 3918–3967)

```
async fn make_session_configuration_for_tests() -> SessionConfiguration
```

**Purpose**: Constructs a realistic `SessionConfiguration` fixture from default test config and offline model metadata.

**Data flow**: Builds test config, derives model slug and `ModelInfo`, constructs default `CollaborationMode`, and fills a `SessionConfiguration` with provider, instructions, approval policy, permission-profile state, environments, workspace roots, codex home, and session-source defaults.

**Call relations**: Used widely by configuration-focused tests that need a standalone configuration object without a full `Session`.

*Call graph*: calls 4 internal fn (build_test_config, construct_model_info_offline_for_tests, get_model_offline_for_tests, new); called by 24 (lock_contains_prompts_and_materializes_features, lock_skips_session_values_when_model_catalog_fields_are_not_saved, lock_validation_can_ignore_codex_version_mismatch, lock_validation_ignores_removed_apps_mcp_path_override, lock_validation_rejects_codex_version_mismatch_by_default, lock_validation_reports_config_diff, active_profile_update_rebuilds_network_proxy_config, emit_subagent_session_started_includes_fork_lineage_from_session_configuration, session_configuration_apply_permission_profile_accepts_direct_write_roots, session_configuration_apply_permission_profile_preserves_existing_deny_read_entries (+14 more)); 5 external calls (clone, new, new, from_config, tempdir).


##### `emit_subagent_session_started_includes_fork_lineage_from_session_configuration`  (lines 3970–4046)

```
async fn emit_subagent_session_started_includes_fork_lineage_from_session_configuration()
```

**Purpose**: Verifies analytics emitted for subagent session start include both parent-thread and forked-from-thread lineage.

**Data flow**: Starts a wiremock server, builds an `AnalyticsEventsClient`, prepares a `SessionConfiguration` with `forked_from_thread_id`, calls `emit_subagent_session_started`, then polls received HTTP requests until it finds `codex_thread_initialized` and asserts event params contain both lineage IDs.

**Call relations**: Covers analytics emission rather than session state mutation.

*Call graph*: calls 6 internal fn (new, make_session_configuration_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, from, new); 9 external calls (from_millis, from_secs, given, start, new, assert_eq!, from_slice, sleep, timeout).


##### `resolved_environments_for_configuration`  (lines 4048–4060)

```
async fn resolved_environments_for_configuration(
    session_configuration: &SessionConfiguration,
) -> (Arc<EnvironmentManager>, TurnEnvironmentSnapshot)
```

**Purpose**: Resolves a `SessionConfiguration`'s environment selections into a concrete `TurnEnvironmentSnapshot` using a test `EnvironmentManager`.

**Data flow**: Creates `EnvironmentManager::default_for_tests`, builds `ThreadEnvironments` with default shell and disabled shell snapshot, updates selections from the configuration, snapshots the result, and returns both manager and snapshot.

**Call relations**: Used by session-construction helpers to keep environment resolution logic consistent with production code.

*Call graph*: calls 5 internal fn (new, environment_selections, default_user_shell, disabled, default_for_tests); called by 2 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx); 3 external calls (clone, new, default).


##### `session_configuration_apply_preserves_profile_file_system_policy_on_cwd_only_update`  (lines 4063–4117)

```
async fn session_configuration_apply_preserves_profile_file_system_policy_on_cwd_only_update()
```

**Purpose**: Checks that changing only the cwd/environments does not rewrite a profile-derived filesystem policy that already materializes project-root semantics.

**Data flow**: Builds a configuration with explicit `project_roots` and docs read access, installs a permission profile derived from runtime permissions, applies a cwd-only environment update, and asserts the resulting filesystem sandbox policy equals the previously materialized expected policy.

**Call relations**: Covers `SessionConfiguration::apply` behavior for cwd-only updates with symbolic profile entries.

*Call graph*: calls 6 internal fn (make_session_configuration_for_tests, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, restricted, from, new); 6 external calls (default, new, assert_eq!, create_dir_all, tempdir, vec!).


##### `session_configuration_apply_permission_profile_preserves_existing_deny_read_entries`  (lines 4120–4173)

```
async fn session_configuration_apply_permission_profile_preserves_existing_deny_read_entries()
```

**Purpose**: Verifies applying a new permission profile preserves existing deny entries and glob depth from the current filesystem policy.

**Data flow**: Seeds a workspace-write policy plus a deny glob for `**/*.env`, applies a new permission profile derived from the base workspace policy, and asserts the updated materialized policy still contains the deny entry and previous `glob_scan_max_depth`.

**Call relations**: Documents merge semantics when replacing permission profiles.

*Call graph*: calls 6 internal fn (make_session_configuration_for_tests, from_runtime_permissions, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, new); 5 external calls (default, new, new_workspace_write_policy, assert_eq!, tempdir).


##### `session_configuration_apply_permission_profile_accepts_direct_write_roots`  (lines 4176–4220)

```
async fn session_configuration_apply_permission_profile_accepts_direct_write_roots()
```

**Purpose**: Checks that direct absolute write-root grants in a runtime permission profile are accepted and reflected in both permission profile and legacy sandbox policy.

**Data flow**: Creates an absolute temp directory path, builds a restricted filesystem policy granting write access to that path, applies it as a permission-profile update, and asserts the updated configuration preserves the profile, filesystem policy, and legacy `SandboxPolicy::WorkspaceWrite` writable roots.

**Call relations**: Covers non-symbolic runtime permission profiles.

*Call graph*: calls 5 internal fn (make_session_configuration_for_tests, from_runtime_permissions, restricted, new, from_absolute_path); 6 external calls (default, new, assert_eq!, canonicalize_preserving_symlinks, tempdir, vec!).


##### `session_configuration_apply_rebinds_symbolic_profile_to_updated_workspace_roots`  (lines 4223–4263)

```
async fn session_configuration_apply_rebinds_symbolic_profile_to_updated_workspace_roots()
```

**Purpose**: Verifies applying a symbolic `project_roots` permission profile alongside updated workspace roots rebinds write access to the new roots and preserves active-profile metadata.

**Data flow**: Seeds old/new/profile workspace roots, applies a settings update with new workspace roots, symbolic permission profile, active profile name, and profile workspace roots, then asserts the updated filesystem policy grants only the new root and stores the active/profile root metadata.

**Call relations**: Exercises coordinated updates of workspace roots and active permission profile.

*Call graph*: calls 4 internal fn (new, make_session_configuration_for_tests, from_runtime_permissions, restricted); 5 external calls (default, assert!, assert_eq!, tempdir, vec!).


##### `session_configuration_apply_retargets_implicit_workspace_root_on_cwd_update`  (lines 4266–4308)

```
async fn session_configuration_apply_retargets_implicit_workspace_root_on_cwd_update()
```

**Purpose**: Checks that when the current cwd is implicitly one of the workspace roots, a cwd-only update retargets that implicit root to the new cwd while preserving extra roots.

**Data flow**: Seeds workspace roots `[old_root, extra_root]` with a symbolic `project_roots` permission profile, applies an environment update changing cwd to `new_root`, and asserts workspace roots become `[new_root, extra_root]` and the materialized policy grants new/extra but not old root.

**Call relations**: Covers implicit-root retargeting logic in `SessionConfiguration::apply`.

*Call graph*: calls 4 internal fn (make_session_configuration_for_tests, from_runtime_permissions, restricted, new); 6 external calls (default, new, assert!, assert_eq!, tempdir, vec!).


##### `active_profile_update_rebuilds_network_proxy_config`  (lines 4311–4416)

```
async fn active_profile_update_rebuilds_network_proxy_config() -> std::io::Result<()>
```

**Purpose**: Verifies switching to a permission profile with network settings rebuilds the session's effective network proxy config from the selected profile.

**Data flow**: Writes a config defining `locked-down` and `web-enabled` permission profiles, loads both variants, seeds a `SessionConfiguration` with the locked profile state, applies a settings update selecting the web-enabled profile and active profile name, and asserts the updated original config now exposes the selected proxy host/port and socks setting.

**Call relations**: Covers profile-driven regeneration of network proxy configuration.

*Call graph*: calls 1 internal fn (make_session_configuration_for_tests); 13 external calls (clone, new, default, assert!, assert_eq!, assert_ne!, Access, default, from, write (+3 more)).


##### `new_default_turn_uses_config_aware_skills_for_role_overrides`  (lines 4420–4503)

```
async fn new_default_turn_uses_config_aware_skills_for_role_overrides()
```

**Purpose**: Checks that role-applied config overrides affect skill enablement when creating a new default turn.

**Data flow**: Creates a skill file under codex home, confirms it is enabled under parent config, writes a role config disabling that skill, applies the role to a cloned config and swaps it into session state, creates a new default turn, and asserts the discovered skill is now disabled in the child turn's skill outcome.

**Call relations**: Exercises interaction between agent roles, config files, and per-turn skill loading.

*Call graph*: calls 2 internal fn (apply_role_to_config, make_session_and_context); 8 external calls (clone, new, new, assert_eq!, skills_load_input_from_config, format!, create_dir_all, write).


##### `session_configuration_apply_retargets_legacy_workspace_root_on_cwd_update`  (lines 4506–4557)

```
async fn session_configuration_apply_retargets_legacy_workspace_root_on_cwd_update()
```

**Purpose**: Verifies cwd-only updates retarget legacy workspace-write sandbox grants that implicitly tracked the old cwd.

**Data flow**: Seeds a configuration whose workspace roots equal the current cwd and whose permission profile comes from legacy workspace-write sandbox policy, applies an environment update to a new project root, and asserts the updated workspace roots and filesystem policy grant the new cwd but not the old one.

**Call relations**: Covers legacy sandbox-policy compatibility during cwd changes.

*Call graph*: calls 6 internal fn (make_session_configuration_for_tests, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from, new); 6 external calls (default, new, assert!, assert_eq!, tempdir, vec!).


##### `session_configuration_apply_preserves_absolute_cwd_write_root_on_cwd_update`  (lines 4560–4619)

```
async fn session_configuration_apply_preserves_absolute_cwd_write_root_on_cwd_update()
```

**Purpose**: Ensures an absolute write grant to the old cwd remains absolute and is not reinterpreted as symbolic workspace-root access after cwd changes.

**Data flow**: Seeds a filesystem policy with root read and explicit old-cwd write access, applies a cwd-only environment update, and asserts the policy is unchanged, still grants old cwd, and does not grant the new cwd.

**Call relations**: Documents the distinction between absolute path grants and symbolic workspace-root grants.

*Call graph*: calls 4 internal fn (make_session_configuration_for_tests, from_runtime_permissions_with_enforcement, restricted, new); 7 external calls (default, new, assert!, assert_eq!, create_dir_all, tempdir, vec!).


##### `session_update_settings_does_not_rewrite_sticky_environment_cwds`  (lines 4622–4669)

```
async fn session_update_settings_does_not_rewrite_sticky_environment_cwds()
```

**Purpose**: Checks that updating session settings with a new primary cwd does not rewrite stored per-environment cwd selections or the config used for future default turns.

**Data flow**: Captures current environment selections, updates session settings with a new cwd plus the same environment list, then asserts session configuration cwd changed while stored environment selections stayed identical and newly created default turns still use the original config cwd.

**Call relations**: Covers the intentionally sticky separation between session cwd and stored thread environments.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 3 external calls (default, assert_eq!, create_dir_all).


##### `relative_cwd_update_without_environments_resolves_under_session_cwd`  (lines 4672–4701)

```
async fn relative_cwd_update_without_environments_resolves_under_session_cwd()
```

**Purpose**: Verifies a cwd update with no explicit environments simply updates the session cwd and leaves environment selections empty.

**Data flow**: Clears stored environments, computes a child path under the original cwd, updates settings with that cwd and no environments, then asserts session configuration cwd changed and environment selections remain empty.

**Call relations**: Covers the simplest cwd-update path.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 5 external calls (default, new, assert!, assert_eq!, create_dir_all).


##### `environment_settings_preserve_explicit_primary_cwd`  (lines 4704–4734)

```
async fn environment_settings_preserve_explicit_primary_cwd()
```

**Purpose**: Checks that when explicit turn environments already have their own cwd, updating the primary cwd does not rewrite those environment-specific cwd values.

**Data flow**: Seeds one explicit environment rooted at `environment_cwd`, updates settings with a different primary cwd while reusing the environment list, and asserts session cwd changed but the environment selection still points at the original environment cwd.

**Call relations**: Documents preservation of explicit environment cwd values.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 4 external calls (default, assert_eq!, create_dir_all, vec!).


##### `absolute_cwd_update_with_turn_environment_is_allowed`  (lines 4737–4764)

```
async fn absolute_cwd_update_with_turn_environment_is_allowed()
```

**Purpose**: Verifies creating a new turn with an absolute cwd and matching explicit environment selection succeeds.

**Data flow**: Builds an absolute child directory, calls `new_turn_with_sub_id` with `TurnEnvironmentSelections` rooted there, and asserts the resulting turn context cwd/config cwd and environment count all match the explicit selection.

**Call relations**: Covers validation of absolute cwd updates when accompanied by explicit environments.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, new); 4 external calls (default, assert_eq!, create_dir_all, vec!).


##### `session_new_fails_when_zsh_fork_enabled_without_packaged_zsh`  (lines 4767–4873)

```
async fn session_new_fails_when_zsh_fork_enabled_without_packaged_zsh()
```

**Purpose**: Ensures session construction fails early if the `ShellZshFork` feature is enabled but no packaged zsh fork binary is available.

**Data flow**: Builds config with the feature enabled and `zsh_path = None`, manually assembles all dependencies needed for `Session::new`, awaits construction, expects an error, and asserts the formatted error message mentions the missing packaged zsh fork.

**Call relations**: Covers a startup validation failure path in `Session::new`.

*Call graph*: calls 17 internal fn (new, new, default, new, new, build_test_config, models_manager_with_provider, default_for_tests, new, from_auth_for_testing (+7 more)); 12 external calls (clone, new, new, assert!, unbounded, default, default, format!, panic!, from_config (+2 more)).


##### `make_session_and_context`  (lines 4876–5098)

```
async fn make_session_and_context() -> (Session, TurnContext)
```

**Purpose**: Builds a fully wired non-`Arc` test `Session` and matching `TurnContext` using offline model info, default local environment, and in-memory/test services.

**Data flow**: Creates channels, temp codex home, config, auth/models managers, session configuration, per-turn config, telemetry, session state, resolved environments, plugin/MCP/skills managers, network approval service, `SessionServices`, skill outcome, turn context, and finally the `Session` struct itself.

**Call relations**: This is the central fixture factory for most tests in the file and is reused by many other helpers.

*Call graph*: calls 33 internal fn (new, new, new_uninitialized_with_permission_profile, new, new, new, new, default, new, new (+15 more)); called by 269 (process_compacted_history_with_test_session, test_review_params, build_guardian_prompt_includes_parent_turn_denied_reads, build_guardian_prompt_items_includes_parent_session_id, guardian_review_request_layout_matches_model_visible_request_snapshot, guardian_test_session_and_turn_with_base_url, routes_approval_to_guardian_allows_granular_review_policy, routes_approval_to_guardian_can_use_app_reviewer_override, routes_approval_to_guardian_requires_guardian_reviewer, hook_run_analytics_payload_falls_back_to_turn_context_id (+15 more)); 28 external calls (clone, new, new, new, default, new, from, new, new, from_pointee (+15 more)).


##### `make_session_with_config`  (lines 5100–5105)

```
async fn make_session_with_config(
    mutator: impl FnOnce(&mut Config),
) -> anyhow::Result<Arc<Session>>
```

**Purpose**: Convenience wrapper that builds an `Arc<Session>` with a caller-provided config mutator and discards the event receiver.

**Data flow**: Delegates to `make_session_with_config_and_rx`, returning only the session on success.

**Call relations**: Used by tests that need a customized session but do not inspect emitted events.

*Call graph*: calls 1 internal fn (make_session_with_config_and_rx); called by 5 (danger_full_access_tool_attempts_do_not_enforce_managed_network, danger_full_access_turns_do_not_expose_managed_network_proxy, reload_user_config_layer_refreshes_hooks, shell_tool_cancellation_waits_for_runtime_cleanup, workspace_write_turns_continue_to_expose_managed_network_proxy).


##### `load_latest_config_for_session`  (lines 5107–5115)

```
async fn load_latest_config_for_session(session: &Session) -> Config
```

**Purpose**: Reloads the latest config from disk using the session's current codex home and cwd as builder inputs.

**Data flow**: Reads `session.get_config().await`, feeds its codex home and cwd into `ConfigBuilder::default().fallback_cwd(...)`, builds the config, and returns it.

**Call relations**: Used by runtime-config refresh tests to simulate reloading from disk.

*Call graph*: called by 3 (config_change_contributor_observes_effective_config_changes, refresh_runtime_config_refreshes_hooks, refresh_runtime_config_updates_runtime_refreshable_fields_and_keeps_session_static_settings); 2 external calls (default, get_config).


##### `make_session_with_config_and_rx`  (lines 5117–5217)

```
async fn make_session_with_config_and_rx(
    mutator: impl FnOnce(&mut Config),
) -> anyhow::Result<(Arc<Session>, async_channel::Receiver<Event>)>
```

**Purpose**: Builds an `Arc<Session>` plus event receiver after applying a caller-supplied mutation to the default test config.

**Data flow**: Creates temp config, applies the mutator, constructs auth/models managers and `SessionConfiguration`, then calls `Session::new` with default managers and returns the resulting session and `async_channel::Receiver<Event>`.

**Call relations**: Used by tests that need both custom config and direct access to emitted events.

*Call graph*: calls 17 internal fn (new, new, default, new, new, build_test_config, models_manager_with_provider, default_for_tests, new, from_auth_for_testing (+7 more)); called by 2 (make_session_with_config, user_shell_commands_do_not_inherit_managed_network_proxy); 10 external calls (clone, new, new, unbounded, default, default, from_config, tempdir, vec!, channel).


##### `make_session_with_history_source_and_agent_control_and_rx`  (lines 5219–5328)

```
async fn make_session_with_history_source_and_agent_control_and_rx(
    initial_history: InitialHistory,
    session_source: SessionSource,
    agent_control: AgentControl,
) -> anyhow::Result<(Arc<Se
```

**Purpose**: Constructs a session with explicit initial history, session source, and `AgentControl`, returning the session and event receiver.

**Data flow**: Builds an ephemeral config, derives model/session configuration, creates channels and managers including a state DB-backed thread store, calls `Session::new` with the supplied `InitialHistory`, `SessionSource`, and `AgentControl`, and returns the session plus receiver.

**Call relations**: Used by resumed root/subagent session-ID tests.

*Call graph*: calls 18 internal fn (new, new, default, new, new, build_test_config, models_manager_with_provider, default_for_tests, new, from_auth_for_testing (+8 more)); called by 2 (resumed_root_session_uses_thread_id_as_session_id, resumed_subagent_session_keeps_inherited_session_id); 10 external calls (clone, new, new, clone, unbounded, default, from_config, tempdir, vec!, channel).


##### `resumed_root_session_uses_thread_id_as_session_id`  (lines 5331–5354)

```
async fn resumed_root_session_uses_thread_id_as_session_id()
```

**Purpose**: Verifies a resumed root session uses its thread ID as the session ID and reports that in `SessionConfigured`.

**Data flow**: Creates a resumed session with `SessionSource::Exec`, asserts `session.thread_id()` and `session.session_id()`, receives the first event, pattern matches `SessionConfigured`, and asserts both IDs in the event.

**Call relations**: Covers root-session identity semantics on resume.

*Call graph*: calls 2 internal fn (make_session_with_history_source_and_agent_control_and_rx, new); 5 external calls (new, assert_eq!, default, panic!, Resumed).


##### `resumed_subagent_session_keeps_inherited_session_id`  (lines 5357–5389)

```
async fn resumed_subagent_session_keeps_inherited_session_id()
```

**Purpose**: Checks that a resumed subagent thread keeps the inherited parent session ID instead of adopting its own thread ID.

**Data flow**: Builds a resumed session with `SessionSource::SubAgent` and `AgentControl` seeded with the parent session ID, then asserts both session object and `SessionConfigured` event report the inherited session ID alongside the child thread ID.

**Call relations**: Complements the root-session identity test for subagent lineage.

*Call graph*: calls 3 internal fn (make_session_with_history_source_and_agent_control_and_rx, from, new); 6 external calls (new, SubAgent, assert_eq!, default, panic!, Resumed).


##### `notify_request_permissions_response_ignores_unmatched_call_id`  (lines 5392–5418)

```
async fn notify_request_permissions_response_ignores_unmatched_call_id()
```

**Purpose**: Ensures a permission-response notification with an unknown call ID does not mutate granted permissions state.

**Data flow**: Creates a session with an active turn, calls `notify_request_permissions_response` for a missing call ID, then asserts `granted_turn_permissions(local)` remains `None`.

**Call relations**: Covers the no-op branch of permission-response routing.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 2 external calls (default, assert_eq!).


##### `record_granted_request_permissions_for_turn_uses_originating_turn`  (lines 5421–5469)

```
async fn record_granted_request_permissions_for_turn_uses_originating_turn()
```

**Purpose**: Verifies turn-scoped granted permissions are recorded on the originating turn state, not whichever turn is currently active.

**Data flow**: Creates two distinct `ActiveTurn` states, installs them sequentially as active, records a turn-scoped permission grant while passing the originating turn state, and asserts only the originating turn state received the grant.

**Call relations**: Documents correct attribution of delayed permission responses.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 3 external calls (clone, default, assert_eq!).


##### `request_permission_grants_are_environment_keyed`  (lines 5472–5522)

```
async fn request_permission_grants_are_environment_keyed()
```

**Purpose**: Checks both turn-scoped and session-scoped permission grants are stored separately per environment ID.

**Data flow**: Records a turn-scoped grant for environment `remote`, asserts only `remote` is present in turn state, then records a session-scoped grant for `remote` and asserts session-level grants exist only for that environment.

**Call relations**: Covers environment-keyed storage semantics for granted permissions.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 3 external calls (clone, default, assert_eq!).


##### `enable_strict_auto_review_for_turn_uses_originating_turn`  (lines 5525–5555)

```
async fn enable_strict_auto_review_for_turn_uses_originating_turn()
```

**Purpose**: Verifies `strict_auto_review` on a turn-scoped permission response is enabled on the originating turn state.

**Data flow**: Creates an originating active turn, records a turn-scoped permission response with `strict_auto_review: true`, and asserts `strict_auto_review_enabled()` on that turn state is true.

**Call relations**: Covers the side effect of strict auto-review grants.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 3 external calls (clone, default, assert!).


##### `strict_auto_review_session_scope_grants_no_permissions`  (lines 5558–5584)

```
fn strict_auto_review_session_scope_grants_no_permissions()
```

**Purpose**: Checks normalization strips permissions and downgrades scope when a session-scoped response requests strict auto-review.

**Data flow**: Builds requested permissions and a session-scoped strict-auto-review response, calls `Session::normalize_request_permissions_response`, and asserts the normalized response contains default permissions, turn scope, and `strict_auto_review: false`.

**Call relations**: Documents normalization rules that prevent session-scoped strict-auto-review grants.

*Call graph*: 4 external calls (default, assert_eq!, normalize_request_permissions_response, new).


##### `request_permissions_emits_event_when_granular_policy_allows_requests`  (lines 5587–5673)

```
async fn request_permissions_emits_event_when_granular_policy_allows_requests()
```

**Purpose**: Verifies `request_permissions_for_environment` emits a `RequestPermissions` event and waits for a matching response when granular approval policy allows tool permission requests.

**Data flow**: Creates a session with active turn and granular approval enabling `request_permissions`, spawns a task calling `request_permissions_for_environment`, receives the emitted event, asserts call/environment/cwd fields, sends a matching response via `notify_request_permissions_response`, and asserts the spawned future resolves to that response.

**Call relations**: Exercises the full request/response round trip for permission requests.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, default); 11 external calls (clone, get_mut, new, new, from_secs, default, Granular, assert_eq!, panic!, spawn (+1 more)).


##### `request_permissions_tool_resolves_relative_paths_against_selected_environment`  (lines 5676–5782)

```
async fn request_permissions_tool_resolves_relative_paths_against_selected_environment()
```

**Purpose**: Checks the `request_permissions` tool resolves relative filesystem paths against the selected environment's cwd before emitting the request event.

**Data flow**: Mutates the primary turn environment to `remote` with a custom cwd, invokes `RequestPermissionsHandler` with a relative path in tool arguments, receives the emitted event, and asserts the requested filesystem permission contains an absolute path under the environment cwd.

**Call relations**: Covers tool-argument normalization for environment-specific permission requests.

*Call graph*: calls 6 internal fn (make_session_and_context_with_rx, new, default, new, plain, from_abs_path); 15 external calls (clone, get_mut, new, new, default, from_secs, Granular, assert_eq!, json!, panic! (+5 more)).


##### `request_permissions_tool_rejects_unknown_environment_id`  (lines 5785–5814)

```
async fn request_permissions_tool_rejects_unknown_environment_id()
```

**Purpose**: Ensures the `request_permissions` tool returns a model-facing error when asked for an unknown environment ID.

**Data flow**: Invokes `RequestPermissionsHandler` with `environment_id: "missing"`, expects `FunctionCallError::RespondToModel`, and asserts the error string names the unknown environment.

**Call relations**: Covers validation failure in the request-permissions tool handler.

*Call graph*: calls 3 internal fn (make_session_and_context, new, plain); 6 external calls (new, new, assert_eq!, json!, panic!, new).


##### `request_permissions_response_materializes_session_cwd_grants_before_recording`  (lines 5817–5924)

```
async fn request_permissions_response_materializes_session_cwd_grants_before_recording()
```

**Purpose**: Verifies session-scoped permission responses materialize symbolic cwd/project-root grants into concrete filesystem permissions before storing them.

**Data flow**: Requests write access to `project_roots` under granular approval, receives the emitted request event, responds with session scope, waits for the request future to resolve, and asserts both the returned response and stored session permissions contain concrete read/write roots based on the request cwd.

**Call relations**: Covers normalization and recording of session-scoped filesystem grants.

*Call graph*: calls 3 internal fn (make_session_and_context_with_rx, default, from_read_write_roots); 12 external calls (clone, get_mut, new, new, default, from_secs, Granular, assert_eq!, panic!, spawn (+2 more)).


##### `request_permissions_is_auto_denied_when_granular_policy_blocks_tool_requests`  (lines 5927–5985)

```
async fn request_permissions_is_auto_denied_when_granular_policy_blocks_tool_requests()
```

**Purpose**: Checks permission requests are auto-denied without emitting an event when granular approval disables `request_permissions`.

**Data flow**: Creates a session with granular approval where `request_permissions: false`, calls `request_permissions_for_environment`, asserts the returned response is an empty turn-scoped denial, and confirms no event arrives on the receiver.

**Call relations**: Covers the policy-gated short-circuit branch.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, default); 7 external calls (get_mut, new, new, default, Granular, assert!, assert_eq!).


##### `submit_with_id_captures_current_span_trace_context`  (lines 5988–6032)

```
async fn submit_with_id_captures_current_span_trace_context()
```

**Purpose**: Verifies `Codex::submit_with_id` captures the current tracing span's W3C trace context when the submission itself does not provide one.

**Data flow**: Builds a lightweight `Codex` wrapper around a session, installs tracing, creates a request span with explicit parent trace context, submits an interrupt operation inside that span, then reads the queued submission and asserts its `trace` equals the ambient span's W3C context.

**Call relations**: Covers trace propagation from caller span into queued submissions.

*Call graph*: calls 2 internal fn (make_session_and_context, install_test_tracing); 7 external calls (new, assert!, assert_eq!, bounded, unbounded, info_span!, channel).


##### `new_default_turn_captures_current_span_trace_id`  (lines 6035–6068)

```
async fn new_default_turn_captures_current_span_trace_id()
```

**Purpose**: Checks `Session::new_default_turn` captures the current tracing span's trace ID into the resulting turn context.

**Data flow**: Installs tracing, creates a request span with explicit parent context, creates a default turn inside that span, and asserts `turn_context.trace_id` equals the expected trace ID string.

**Call relations**: Covers trace propagation into turn creation.

*Call graph*: calls 2 internal fn (make_session_and_context, install_test_tracing); 4 external calls (current, assert!, assert_eq!, info_span!).


##### `submission_dispatch_span_prefers_submission_trace_context`  (lines 6071–6102)

```
fn submission_dispatch_span_prefers_submission_trace_context()
```

**Purpose**: Verifies `submission_dispatch_span` uses the trace context embedded in the `Submission` rather than the ambient span context.

**Data flow**: Creates an ambient span with one trace ID, constructs a `Submission` carrying a different W3C trace context, builds the dispatch span inside the ambient scope, and asserts the dispatch span's trace ID matches the submission trace.

**Call relations**: Documents precedence rules for dispatch-span trace parenting.

*Call graph*: calls 1 internal fn (install_test_tracing); 3 external calls (assert!, assert_eq!, info_span!).


##### `submission_dispatch_span_uses_debug_for_realtime_audio`  (lines 6105–6127)

```
fn submission_dispatch_span_uses_debug_for_realtime_audio()
```

**Purpose**: Checks dispatch spans for realtime audio submissions are created at DEBUG level.

**Data flow**: Builds a `Submission` containing `Op::RealtimeConversationAudio`, creates its dispatch span, and asserts the span metadata level is `tracing::Level::DEBUG`.

**Call relations**: Covers logging-level selection for high-volume realtime audio ops.

*Call graph*: calls 1 internal fn (install_test_tracing); 2 external calls (assert_eq!, RealtimeConversationAudio).


##### `op_kind_for_input_and_context_ops`  (lines 6130–6149)

```
fn op_kind_for_input_and_context_ops()
```

**Purpose**: Verifies `Op::kind()` returns the expected string identifiers for user-input and thread-settings operations.

**Data flow**: Constructs representative `Op::UserInput` and `Op::ThreadSettings` values and asserts their `.kind()` strings.

**Call relations**: A small protocol-shape regression test.

*Call graph*: 1 external calls (assert_eq!).


##### `user_turn_updates_approvals_reviewer`  (lines 6152–6194)

```
async fn user_turn_updates_approvals_reviewer()
```

**Purpose**: Checks that processing a user turn with thread settings updates the session configuration's `approvals_reviewer`.

**Data flow**: Builds a session and config, invokes `handlers::user_input_or_turn` with `Op::UserInput` carrying thread settings including `ApprovalsReviewer::AutoReview`, then reads session state and asserts the reviewer changed.

**Call relations**: Exercises settings application through the user-input handler path.

*Call graph*: calls 3 internal fn (user_input_or_turn, make_session_and_context_with_rx, local_selections); 3 external calls (default, assert_eq!, vec!).


##### `turn_environments_set_primary_environment`  (lines 6197–6256)

```
async fn turn_environments_set_primary_environment()
```

**Purpose**: Verifies creating a turn with explicit environment selections sets the primary environment consistently in the turn context and stored thread environments.

**Data flow**: Creates a selected cwd, starts a new turn with one local environment, asserts the turn context's primary environment points at the first environment entry, checks cwd/config cwd, reads the stored primary environment from `session.services.turn_environments`, and confirms a later default turn reuses it.

**Call relations**: Covers synchronization between session-stored thread environments and per-turn snapshots.

*Call graph*: calls 3 internal fn (make_session_and_context_with_rx, new, try_from); 4 external calls (default, assert!, assert_eq!, vec!).


##### `default_turn_does_not_overlay_legacy_fallback_cwd_onto_stored_thread_environments`  (lines 6259–6289)

```
async fn default_turn_does_not_overlay_legacy_fallback_cwd_onto_stored_thread_environments()
```

**Purpose**: Checks a default turn respects stored thread environments and does not overwrite them with the session config's fallback cwd.

**Data flow**: Manually updates stored thread environments and session configuration to a selected cwd, creates a default turn, and asserts the turn uses the stored environment and selected cwd rather than the original session cwd.

**Call relations**: Documents precedence of stored thread environments over legacy fallback cwd.

*Call graph*: calls 3 internal fn (make_session_and_context_with_rx, local, try_from); 3 external calls (assert!, assert_eq!, vec!).


##### `default_turn_honors_empty_stored_thread_environments`  (lines 6292–6311)

```
async fn default_turn_honors_empty_stored_thread_environments()
```

**Purpose**: Verifies a default turn preserves an intentionally empty stored environment list and falls back only for cwd.

**Data flow**: Clears stored thread environments and session configuration environments, creates a default turn, and asserts there is no primary environment, the environment list is empty, and cwd/config cwd equal the session cwd.

**Call relations**: Covers the empty-environment case distinct from implicit local fallback.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 3 external calls (new, assert!, assert_eq!).


##### `primary_environment_uses_first_turn_environment`  (lines 6314–6353)

```
async fn primary_environment_uses_first_turn_environment()
```

**Purpose**: Checks `TurnEnvironmentSnapshot::primary()` always returns the first environment entry.

**Data flow**: Creates a second environment entry sharing the same underlying environment object but different ID/cwd, appends it to the turn context, and asserts `primary()` still returns the first environment while the second retains its own cwd.

**Call relations**: Documents ordering semantics for multiple turn environments.

*Call graph*: calls 3 internal fn (make_session_and_context, new, from_abs_path); 2 external calls (clone, assert_eq!).


##### `empty_turn_environments_clear_primary_environment`  (lines 6356–6379)

```
async fn empty_turn_environments_clear_primary_environment()
```

**Purpose**: Verifies creating a turn with an explicit empty environment selection clears the primary environment.

**Data flow**: Starts a new turn with `TurnEnvironmentSelections` containing the session cwd and an empty environment vector, then asserts no primary environment exists and cwd/config cwd remain the session cwd.

**Call relations**: Covers explicit clearing of turn environments.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, new); 4 external calls (default, assert!, assert_eq!, vec!).


##### `spawn_task_turn_span_inherits_dispatch_trace_context`  (lines 6382–6482)

```
async fn spawn_task_turn_span_inherits_dispatch_trace_context()
```

**Purpose**: Ensures the tracing span used for a spawned session task inherits the submission dispatch trace context while using a distinct span ID.

**Data flow**: Defines a `TraceCaptureTask` that records `current_span_w3c_trace_context`, creates a submission dispatch span with explicit trace context, spawns the task inside that span, waits for turn completion, then compares captured task trace ID against submission trace ID and dispatch span ID.

**Call relations**: Exercises trace propagation from submission dispatch into task execution.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, install_test_tracing); 11 external calls (clone, new, from_secs, assert!, assert_eq!, assert_ne!, context_from_w3c_trace_context, new, timeout, info_span! (+1 more)).


##### `shutdown_complete_does_not_append_to_thread_store_after_shutdown`  (lines 6486–6530)

```
async fn shutdown_complete_does_not_append_to_thread_store_after_shutdown()
```

**Purpose**: In debug builds, verifies shutdown completes without appending extra thread-store writes after the thread has been shut down.

**Data flow**: Attaches an `InMemoryThreadStore`-backed `LiveThread` to a session, calls `handlers::shutdown`, then asserts the store recorded exactly one `create_thread` and one `shutdown_thread` call.

**Call relations**: Covers shutdown persistence hygiene.

*Call graph*: calls 3 internal fn (make_session_and_context, default, create); 6 external calls (clone, new, new, assert!, assert_eq!, default).


##### `submission_loop_channel_close_emits_thread_stop_lifecycle`  (lines 6533–6582)

```
async fn submission_loop_channel_close_emits_thread_stop_lifecycle()
```

**Purpose**: Checks that when the submission channel closes, `submission_loop` emits thread-stop lifecycle callbacks.

**Data flow**: Installs a `ThreadLifecycleContributor`, closes the submission sender before entering `submission_loop`, waits for loop completion, and asserts the contributor was called once with the expected thread/session stores.

**Call relations**: Exercises thread-stop lifecycle on loop termination by channel closure.

*Call graph*: calls 1 internal fn (make_session_and_context); 6 external calls (clone, new, assert_eq!, bounded, new, new).


##### `submission_loop_channel_close_aborts_active_turn_before_thread_stop_lifecycle`  (lines 6585–6664)

```
async fn submission_loop_channel_close_aborts_active_turn_before_thread_stop_lifecycle()
```

**Purpose**: Verifies `submission_loop` aborts an active turn before emitting thread-stop lifecycle callbacks when the submission channel closes.

**Data flow**: Installs a recorder implementing both thread-stop and turn-abort contributors, spawns a never-ending task, closes the submission channel, runs `submission_loop`, and asserts the recorded callback order is `turn_abort` then `thread_stop`.

**Call relations**: Covers shutdown ordering between active-turn cleanup and thread lifecycle.

*Call graph*: calls 1 internal fn (make_session_and_context); 7 external calls (clone, new, new, assert_eq!, bounded, new, new).


##### `shutdown_and_wait_allows_multiple_waiters`  (lines 6667–6702)

```
async fn shutdown_and_wait_allows_multiple_waiters()
```

**Purpose**: Checks multiple concurrent callers can await `Codex::shutdown_and_wait()` successfully.

**Data flow**: Builds a lightweight `Codex` with a session-loop task that consumes one shutdown submission, spawns two concurrent shutdown waiters, and asserts both complete successfully.

**Call relations**: Exercises synchronization around shared shutdown completion.

*Call graph*: calls 1 internal fn (make_session_and_context); 9 external calls (clone, new, from_millis, assert_eq!, bounded, unbounded, spawn, sleep, channel).


##### `shutdown_and_wait_waits_when_shutdown_is_already_in_progress`  (lines 6705–6739)

```
async fn shutdown_and_wait_waits_when_shutdown_is_already_in_progress()
```

**Purpose**: Verifies `shutdown_and_wait` blocks until session-loop termination even if shutdown has already started and the submission channel is closed.

**Data flow**: Builds a `Codex` whose session-loop handle waits on a oneshot, starts `shutdown_and_wait`, confirms the waiter is still pending after a short sleep, then releases the oneshot and asserts the waiter completes.

**Call relations**: Covers the in-progress shutdown path rather than the initial shutdown trigger.

*Call graph*: calls 1 internal fn (make_session_and_context); 10 external calls (clone, new, from_millis, assert!, bounded, unbounded, spawn, channel, sleep, channel).


##### `shutdown_and_wait_shuts_down_cached_guardian_subagent`  (lines 6742–6796)

```
async fn shutdown_and_wait_shuts_down_cached_guardian_subagent()
```

**Purpose**: Ensures shutting down a parent `Codex` also sends a shutdown op to a cached guardian-review subagent session.

**Data flow**: Builds parent and child codex instances with independent submission loops, caches the child in `guardian_review_session`, calls parent `shutdown_and_wait`, and asserts the child loop received `Op::Shutdown`.

**Call relations**: Covers guardian subagent cleanup for cached review sessions.

*Call graph*: calls 1 internal fn (make_session_and_context); 8 external calls (clone, new, assert_eq!, bounded, unbounded, spawn, channel, channel).


##### `cached_guardian_subagent_exposes_its_rollout_path`  (lines 6799–6828)

```
async fn cached_guardian_subagent_exposes_its_rollout_path()
```

**Purpose**: Checks a cached guardian subagent exposes its persisted rollout path through the parent session's guardian-review manager.

**Data flow**: Builds parent and child sessions, attaches thread persistence to the child, caches the child codex, and asserts `trunk_rollout_path()` returns the child's rollout path.

**Call relations**: Tests guardian-review session bookkeeping rather than shutdown.

*Call graph*: calls 2 internal fn (attach_thread_persistence, make_session_and_context); 6 external calls (new, assert_eq!, bounded, unbounded, spawn, channel).


##### `shutdown_and_wait_shuts_down_tracked_ephemeral_guardian_review`  (lines 6831–6885)

```
async fn shutdown_and_wait_shuts_down_tracked_ephemeral_guardian_review()
```

**Purpose**: Ensures parent shutdown also terminates tracked ephemeral guardian-review sessions.

**Data flow**: Builds parent and child codex instances, registers the child as ephemeral in `guardian_review_session`, calls parent `shutdown_and_wait`, and asserts the child received a shutdown submission.

**Call relations**: Complements cached-subagent shutdown coverage for ephemeral review sessions.

*Call graph*: calls 1 internal fn (make_session_and_context); 8 external calls (clone, new, assert_eq!, bounded, unbounded, spawn, channel, channel).


##### `make_session_and_context_with_auth_and_config_and_rx`  (lines 6887–6907)

```
async fn make_session_and_context_with_auth_and_config_and_rx(
    auth: CodexAuth,
    dynamic_tools: Vec<DynamicToolSpec>,
    configure_config: F,
) -> (
    Arc<Session>,
    Arc<TurnContext>,
```

**Purpose**: Convenience wrapper that creates a temp codex home and delegates to the more general auth/config-home session builder.

**Data flow**: Allocates a temporary directory, forwards auth, dynamic tools, codex-home path, and config mutator to `make_session_and_context_with_auth_config_home_and_rx`, and returns its session/turn/receiver triple.

**Call relations**: Used by tests that need custom auth or feature flags but not a fixed codex-home path.

*Call graph*: calls 1 internal fn (make_session_and_context_with_auth_config_home_and_rx); called by 5 (build_initial_context_omits_multi_agent_v2_usage_hints_when_hint_disabled, make_multi_agent_v2_usage_hint_test_session, make_session_and_context_with_dynamic_tools_and_rx, resize_all_images_prepares_failures_before_history_insertion, resize_all_images_prepares_resumed_history_before_installing_it); 1 external calls (tempdir).


##### `make_session_and_context_with_auth_config_home_and_rx`  (lines 6909–7143)

```
async fn make_session_and_context_with_auth_config_home_and_rx(
    auth: CodexAuth,
    dynamic_tools: Vec<DynamicToolSpec>,
    codex_home: &Path,
    configure_config: F,
) -> (
    Arc<Session>,
```

**Purpose**: Builds an `Arc<Session>`, `Arc<TurnContext>`, and event receiver with caller-specified auth, dynamic tools, codex-home path, and config mutation.

**Data flow**: Creates config and applies mutation, builds auth/models managers, session configuration, telemetry, state, resolved environments, services, skill outcome, turn context, and final `Arc<Session>` similarly to `make_session_and_context`, but parameterized by auth/home/dynamic tools.

**Call relations**: General-purpose fixture factory used by image-resize, multi-agent hint, and dynamic-tool tests.

*Call graph*: calls 32 internal fn (new, new, new_uninitialized_with_permission_profile, new, new, new, new, default, new, new (+15 more)); called by 1 (make_session_and_context_with_auth_and_config_and_rx); 26 external calls (clone, new, new, new, default, new, from, new, from_pointee, from (+15 more)).


##### `make_session_and_context_with_dynamic_tools_and_rx`  (lines 7145–7158)

```
async fn make_session_and_context_with_dynamic_tools_and_rx(
    dynamic_tools: Vec<DynamicToolSpec>,
) -> (
    Arc<Session>,
    Arc<TurnContext>,
    async_channel::Receiver<Event>,
)
```

**Purpose**: Builds a session/turn/receiver triple using default API-key auth and caller-supplied dynamic tools.

**Data flow**: Delegates to `make_session_and_context_with_auth_and_config_and_rx` with `CodexAuth::from_api_key("Test API Key")` and a no-op config mutator.

**Call relations**: Used by `make_session_and_context_with_rx` and dynamic-tool-specific tests elsewhere.

*Call graph*: calls 2 internal fn (make_session_and_context_with_auth_and_config_and_rx, from_api_key); called by 4 (make_session_and_context_with_rx, assert_failed_apply_patch_tracks_committed_delta, invalidation_emits_empty_turn_diff, net_zero_patch_emits_empty_turn_diff).


##### `make_session_and_context_with_rx`  (lines 7162–7168)

```
async fn make_session_and_context_with_rx() -> (
    Arc<Session>,
    Arc<TurnContext>,
    async_channel::Receiver<Event>,
)
```

**Purpose**: Primary convenience helper returning an `Arc<Session>`, `Arc<TurnContext>`, and event receiver with default auth and no dynamic tools.

**Data flow**: Delegates to `make_session_and_context_with_dynamic_tools_and_rx(Vec::new())`.

**Call relations**: This is the most commonly used fixture in event-ordering and lifecycle tests.

*Call graph*: calls 1 internal fn (make_session_and_context_with_dynamic_tools_and_rx); called by 68 (delegated_mcp_guardian_abort_returns_synthetic_decline_answer, delegated_mcp_user_reviewer_returns_none_without_metadata, forward_events_cancelled_while_send_blocked_shuts_down_delegate, forward_ops_preserves_submission_trace_context, handle_exec_approval_uses_call_id_for_guardian_review_and_approval_id_for_reply, handle_request_permissions_uses_tool_call_id_for_round_trip, run_codex_thread_interactive_respects_pre_cancelled_spawn, test_review_session, cancelled_guardian_review_emits_terminal_abort_without_warning, guardian_review_surfaces_responses_api_errors_in_rejection_reason (+15 more)); 1 external calls (new).


##### `refresh_mcp_servers_is_deferred_until_next_turn`  (lines 7171–7213)

```
async fn refresh_mcp_servers_is_deferred_until_next_turn()
```

**Purpose**: Verifies pending MCP server refresh config is not applied immediately but is consumed on the next explicit refresh point, replacing the startup cancellation token.

**Data flow**: Creates a session, captures the current MCP startup cancellation token, stores a `McpServerRefreshConfig` in `pending_mcp_server_refresh_config`, calls `refresh_mcp_servers_if_requested`, and asserts the old token was cancelled, pending config cleared, and a fresh uncancelled token installed.

**Call relations**: Covers deferred MCP refresh behavior tied to turn boundaries.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert!, json!, to_value).


##### `spawn_task_does_not_update_previous_turn_settings_for_non_run_turn_tasks`  (lines 7216–7240)

```
async fn spawn_task_does_not_update_previous_turn_settings_for_non_run_turn_tasks()
```

**Purpose**: Checks spawning a non-run regular task does not mutate `previous_turn_settings`.

**Data flow**: Creates a session, explicitly clears previous-turn settings, spawns a never-ending regular task with user input, aborts it, and asserts previous-turn settings remain `None`.

**Call relations**: Documents that only completed run turns should update previous-turn metadata.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 3 external calls (clone, assert_eq!, vec!).


##### `build_settings_update_items_emits_environment_item_for_network_changes`  (lines 7243–7302)

```
async fn build_settings_update_items_emits_environment_item_for_network_changes()
```

**Purpose**: Verifies settings-diff generation emits an `<environment_context>` user item when managed network constraints change.

**Data flow**: Creates previous/current turn contexts, injects network requirements into the current config layer stack, builds settings update items against the previous reference context, extracts user texts, and asserts one contains serialized allowed/denied network domains.

**Call relations**: Covers environment-context diff generation for network changes.

*Call graph*: calls 4 internal fn (new, new, make_session_and_context, user_input_texts); 4 external calls (new, default, assert!, from).


##### `environment_context_uses_session_shell_when_environment_shell_is_absent`  (lines 7305–7345)

```
async fn environment_context_uses_session_shell_when_environment_shell_is_absent()
```

**Purpose**: Checks rendered environment context falls back to the session shell when per-environment shell metadata is absent, but prefers explicit environment shell when present.

**Data flow**: Mutates session shell to PowerShell and clears environment shells, renders `EnvironmentContext`, asserts `<shell>powershell</shell>`, then sets the primary environment shell to Cmd, rerenders, and asserts `<shell>cmd</shell>`.

**Call relations**: Documents shell-selection precedence in environment-context rendering.

*Call graph*: calls 2 internal fn (from_turn_context, make_session_and_context); 3 external calls (new, from, assert!).


##### `build_settings_update_items_emits_environment_item_for_time_changes`  (lines 7348–7371)

```
async fn build_settings_update_items_emits_environment_item_for_time_changes()
```

**Purpose**: Verifies settings-diff generation emits environment context when current date/timezone change.

**Data flow**: Creates previous/current turn contexts, mutates `current_date` and `timezone` on the current context, builds update items, extracts user texts, and asserts the environment context contains both tags.

**Call relations**: Covers time-related environment-context diffs.

*Call graph*: calls 2 internal fn (make_session_and_context, user_input_texts); 2 external calls (new, assert!).


##### `build_settings_update_items_omits_environment_item_when_disabled`  (lines 7374–7400)

```
async fn build_settings_update_items_omits_environment_item_when_disabled()
```

**Purpose**: Checks environment-context diff items are omitted entirely when `include_environment_context` is disabled in config.

**Data flow**: Creates previous/current contexts, disables `include_environment_context` in current config, mutates current date, builds update items, and asserts no user text contains `<environment_context>`.

**Call relations**: Covers config gating of environment-context updates.

*Call graph*: calls 2 internal fn (make_session_and_context, user_input_texts); 2 external calls (new, assert!).


##### `build_settings_update_items_emits_realtime_start_when_session_becomes_live`  (lines 7403–7428)

```
async fn build_settings_update_items_emits_realtime_start_when_session_becomes_live()
```

**Purpose**: Verifies settings-diff generation emits a developer realtime-start message when realtime becomes active.

**Data flow**: Creates previous/current contexts, sets `current_context.realtime_active = true`, builds update items, extracts developer texts, and asserts one contains `<realtime_conversation>`.

**Call relations**: Covers realtime-start diff generation.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 2 external calls (new, assert!).


##### `build_settings_update_items_emits_realtime_end_when_session_stops_being_live`  (lines 7431–7456)

```
async fn build_settings_update_items_emits_realtime_end_when_session_stops_being_live()
```

**Purpose**: Checks settings-diff generation emits a developer realtime-end message when realtime becomes inactive.

**Data flow**: Creates a previous context with `realtime_active = true`, derives a current context with `realtime_active = false`, builds update items, and asserts developer text mentions `Reason: inactive`.

**Call relations**: Covers realtime-end diff generation from explicit previous context.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `build_settings_update_items_uses_previous_turn_settings_for_realtime_end`  (lines 7459–7490)

```
async fn build_settings_update_items_uses_previous_turn_settings_for_realtime_end()
```

**Purpose**: Verifies realtime-end diff generation can fall back to `previous_turn_settings` when the reference context item lacks realtime state.

**Data flow**: Creates a previous context item with `realtime_active = None`, stores previous-turn settings indicating realtime was active, builds update items for a current inactive context, and asserts a realtime-end developer message is emitted.

**Call relations**: Covers fallback to previous-turn metadata during diff generation.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `build_initial_context_uses_previous_realtime_state`  (lines 7493–7519)

```
async fn build_initial_context_uses_previous_realtime_state()
```

**Purpose**: Checks initial-context generation includes realtime-start instructions when realtime is active, but does not duplicate them once a matching reference context exists.

**Data flow**: Creates a turn context with `realtime_active = true`, builds initial context and asserts a realtime message exists, stores the turn's context item as reference context, rebuilds initial context, and asserts the realtime message is absent the second time.

**Call relations**: Covers deduplication of realtime context in initial prompt assembly.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `make_multi_agent_v2_usage_hint_test_session`  (lines 7521–7537)

```
async fn make_multi_agent_v2_usage_hint_test_session(
    enable_multi_agent_v2: bool,
) -> (Arc<Session>, Arc<TurnContext>)
```

**Purpose**: Builds a session fixture with configurable `Feature::MultiAgentV2` and explicit root/subagent usage-hint text.

**Data flow**: Delegates to `make_session_and_context_with_auth_and_config_and_rx`, optionally enabling the feature and setting `multi_agent_v2.root_agent_usage_hint_text` and `.subagent_usage_hint_text`, then returns the session and turn context.

**Call relations**: Shared by multi-agent usage-hint prompt tests.

*Call graph*: calls 2 internal fn (make_session_and_context_with_auth_and_config_and_rx, from_api_key); called by 3 (build_initial_context_adds_multi_agent_v2_root_usage_hint_as_developer_message, build_initial_context_adds_multi_agent_v2_subagent_usage_hint_as_developer_message, build_initial_context_omits_multi_agent_v2_usage_hints_when_feature_disabled); 1 external calls (new).


##### `PromptExtensionTestContributor::contribute`  (lines 7543–7562)

```
fn contribute(
        &'a self,
        _session_store: &'a codex_extension_api::ExtensionData,
        thread_store: &'a codex_extension_api::ExtensionData,
    ) -> std::pin::Pin<
        Box<dyn s
```

**Purpose**: Implements a test prompt contributor that emits one developer-policy fragment only when thread extension state contains `PromptExtensionTestState`.

**Data flow**: Reads `thread_store.get::<PromptExtensionTestState>()`, conditionally constructs `PromptFragment::developer_policy("prompt extension enabled")`, and returns either a one-element or empty vector inside a boxed future.

**Call relations**: Used by prompt-extension tests to verify extension-contributed prompt fragments are included conditionally.

*Call graph*: 1 external calls (pin).


##### `prompt_extension_test_registry`  (lines 7565–7570)

```
fn prompt_extension_test_registry() -> Arc<codex_extension_api::ExtensionRegistry<crate::config::Config>>
```

**Purpose**: Builds an extension registry containing only the `PromptExtensionTestContributor`.

**Data flow**: Creates `ExtensionRegistryBuilder`, registers the prompt contributor, builds the registry, and wraps it in `Arc`.

**Call relations**: Injected into sessions by prompt-extension tests.

*Call graph*: calls 1 internal fn (new); called by 2 (build_initial_context_includes_prompt_fragments_from_extensions, build_initial_context_omits_prompt_fragments_without_extension_state); 1 external calls (new).


##### `build_initial_context_includes_prompt_fragments_from_extensions`  (lines 7573–7591)

```
async fn build_initial_context_includes_prompt_fragments_from_extensions()
```

**Purpose**: Verifies initial-context generation includes developer prompt fragments contributed by extensions when the required thread extension state is present.

**Data flow**: Installs the test extension registry and inserts `PromptExtensionTestState` into thread extension data, builds initial context, extracts developer messages, and asserts one text equals `prompt extension enabled`.

**Call relations**: Exercises extension prompt contribution in initial prompt assembly.

*Call graph*: calls 3 internal fn (developer_message_texts, make_session_and_context, prompt_extension_test_registry); 1 external calls (assert!).


##### `build_initial_context_omits_prompt_fragments_without_extension_state`  (lines 7594–7608)

```
async fn build_initial_context_omits_prompt_fragments_without_extension_state()
```

**Purpose**: Checks extension prompt fragments are omitted when the extension registry is present but the enabling thread state is absent.

**Data flow**: Installs the test extension registry without inserting state, builds initial context, extracts developer messages, and asserts the extension text is absent.

**Call relations**: Provides the negative control for prompt-extension contribution.

*Call graph*: calls 3 internal fn (developer_message_texts, make_session_and_context, prompt_extension_test_registry); 1 external calls (assert!).


##### `build_initial_context_adds_multi_agent_v2_root_usage_hint_as_developer_message`  (lines 7611–7630)

```
async fn build_initial_context_adds_multi_agent_v2_root_usage_hint_as_developer_message()
```

**Purpose**: Verifies root-thread initial context includes the configured MultiAgentV2 root usage hint as its own developer message.

**Data flow**: Builds a session with MultiAgentV2 enabled, generates initial context, groups developer messages, and asserts one message is exactly `Root guidance.` while none equal `Subagent guidance.`.

**Call relations**: Covers root-thread usage-hint insertion.

*Call graph*: calls 2 internal fn (developer_message_texts, make_multi_agent_v2_usage_hint_test_session); 1 external calls (assert!).


##### `build_initial_context_adds_multi_agent_v2_subagent_usage_hint_as_developer_message`  (lines 7633–7668)

```
async fn build_initial_context_adds_multi_agent_v2_subagent_usage_hint_as_developer_message()
```

**Purpose**: Checks subagent-thread initial context includes the configured subagent usage hint instead of the root hint.

**Data flow**: Builds a MultiAgentV2 session, mutates session and turn context source to `SessionSource::SubAgent`, builds initial context, and asserts developer messages contain `Subagent guidance.` but not `Root guidance.`.

**Call relations**: Covers subagent-specific usage-hint insertion.

*Call graph*: calls 4 internal fn (developer_message_texts, make_multi_agent_v2_usage_hint_test_session, try_from, new); 3 external calls (get_mut, SubAgent, assert!).


##### `build_initial_context_omits_multi_agent_v2_usage_hints_when_feature_disabled`  (lines 7671–7687)

```
async fn build_initial_context_omits_multi_agent_v2_usage_hints_when_feature_disabled()
```

**Purpose**: Ensures usage hints are omitted entirely when the MultiAgentV2 feature flag is disabled.

**Data flow**: Builds a session with hint text configured but feature disabled, generates initial context, and asserts no developer message equals either root or subagent guidance.

**Call relations**: Covers feature gating of usage hints.

*Call graph*: calls 2 internal fn (developer_message_texts, make_multi_agent_v2_usage_hint_test_session); 1 external calls (assert!).


##### `build_initial_context_omits_multi_agent_v2_usage_hints_when_hint_disabled`  (lines 7690–7715)

```
async fn build_initial_context_omits_multi_agent_v2_usage_hints_when_hint_disabled()
```

**Purpose**: Checks usage hints are omitted when the feature is enabled but `usage_hint_enabled` is false.

**Data flow**: Builds a session with MultiAgentV2 enabled, explicit hint text, and `usage_hint_enabled = false`, generates initial context, and asserts neither hint appears.

**Call relations**: Covers config gating of usage hints independent of feature flag.

*Call graph*: calls 3 internal fn (developer_message_texts, make_session_and_context_with_auth_and_config_and_rx, from_api_key); 2 external calls (new, assert!).


##### `build_initial_context_omits_default_image_save_location_with_image_history`  (lines 7718–7741)

```
async fn build_initial_context_omits_default_image_save_location_with_image_history()
```

**Purpose**: Verifies initial context does not include default image-save-location instructions even when image-generation history exists.

**Data flow**: Replaces session history with one `ResponseItem::ImageGenerationCall`, builds initial context, extracts developer texts, and asserts none mention `Generated images are saved to`.

**Call relations**: Documents omission of legacy image-save boilerplate.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 2 external calls (assert!, vec!).


##### `build_initial_context_omits_default_image_save_location_without_image_history`  (lines 7744–7756)

```
async fn build_initial_context_omits_default_image_save_location_without_image_history()
```

**Purpose**: Checks the same omission when there is no image-generation history at all.

**Data flow**: Builds initial context for a fresh session and asserts developer texts do not mention generated-image save location.

**Call relations**: Provides the baseline case for the previous test.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `build_initial_context_trims_skill_metadata_from_context_window_budget`  (lines 7759–7804)

```
async fn build_initial_context_trims_skill_metadata_from_context_window_budget()
```

**Purpose**: Verifies skill metadata is dropped from initial context when the model context window budget is too small, without surfacing the warning inside the prompt itself.

**Data flow**: Creates a tiny-context-window turn with two skills, builds initial context, extracts developer texts, and asserts neither the budget warning nor any skill metadata lines appear.

**Call relations**: Covers prompt-budget trimming behavior for skill metadata.

*Call graph*: calls 3 internal fn (developer_input_texts, make_session_and_context, new); 4 external calls (new, assert!, default, vec!).


##### `emit_thread_start_skill_metrics_records_enabled_kept_and_truncated_values`  (lines 7807–7850)

```
fn emit_thread_start_skill_metrics_records_enabled_kept_and_truncated_values()
```

**Purpose**: Checks thread-start skill rendering emits the expected enabled/kept/truncated metrics and warning when the budget omits all descriptions and skills.

**Data flow**: Creates in-memory telemetry and one skill, renders available skills with a one-character budget and `SkillRenderSideEffects::ThreadStart`, asserts the warning message, snapshots metrics, and checks histogram sums for enabled, kept, truncated, and truncated-description-chars metrics.

**Call relations**: Exercises telemetry side effects of skill rendering at thread start.

*Call graph*: calls 1 internal fn (test_session_telemetry_without_metadata); 4 external calls (assert_eq!, default, Characters, vec!).


##### `emit_thread_start_skill_metrics_records_description_truncated_chars_without_omitted_skills`  (lines 7853–7906)

```
fn emit_thread_start_skill_metrics_records_description_truncated_chars_without_omitted_skills()
```

**Purpose**: Verifies skill rendering can truncate descriptions without omitting whole skills and records only truncated-character metrics in that case.

**Data flow**: Creates telemetry and two skills, computes a budget large enough for minimal skill lines plus six extra chars, renders skills, asserts no skills were omitted but eight description chars were truncated, and checks the corresponding metrics.

**Call relations**: Complements the previous skill-metrics test with partial truncation instead of omission.

*Call graph*: calls 1 internal fn (test_session_telemetry_without_metadata); 5 external calls (assert_eq!, default, Characters, test_path_buf, vec!).


##### `build_initial_context_emits_thread_start_skill_warning_on_repeated_builds`  (lines 7909–7961)

```
async fn build_initial_context_emits_thread_start_skill_warning_on_repeated_builds()
```

**Purpose**: Checks each initial-context build emits a warning event when skill metadata exceeds the thread-start budget.

**Data flow**: Creates a session with receiver, installs a tiny-context-window turn containing two skills, calls `build_initial_context` twice, and after each call waits for a `WarningEvent` with the expected budget-exceeded message.

**Call relations**: Covers warning-event emission separate from prompt contents and metrics.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, new); 7 external calls (into_inner, new, from_secs, assert!, default, timeout, vec!).


##### `handle_output_item_done_records_image_save_history_message`  (lines 7964–8018)

```
async fn handle_output_item_done_records_image_save_history_message()
```

**Purpose**: Verifies handling a completed image-generation output item saves the artifact to disk and prepends a contextual history message describing where generated images are stored.

**Data flow**: Builds session/turn/tool runtime, computes expected artifact path, handles a completed `ImageGenerationCall`, then asserts session history contains an `ImageGenerationInstructions` contextual message followed by the original item and that the decoded image bytes were written to disk.

**Call relations**: Exercises `handle_output_item_done` side effects for successful image generation.

*Call graph*: calls 6 internal fn (into, new, make_session_and_context, test_tool_runtime, image_generation_artifact_path, new); 6 external calls (clone, new, new, assert_eq!, remove_file, vec!).


##### `handle_output_item_done_skips_image_save_message_when_save_fails`  (lines 8021–8057)

```
async fn handle_output_item_done_skips_image_save_message_when_save_fails()
```

**Purpose**: Checks failed image artifact decoding/writing does not insert the contextual save-location message, while still recording the original output item.

**Data flow**: Handles an `ImageGenerationCall` with invalid base64 payload, then asserts history contains only the original item and no artifact file exists.

**Call relations**: Covers the failure branch of image-generation artifact persistence.

*Call graph*: calls 4 internal fn (make_session_and_context, test_tool_runtime, image_generation_artifact_path, new); 7 external calls (clone, new, new, assert!, assert_eq!, remove_file, vec!).


##### `build_initial_context_uses_previous_turn_settings_for_realtime_end`  (lines 8060–8079)

```
async fn build_initial_context_uses_previous_turn_settings_for_realtime_end()
```

**Purpose**: Verifies initial-context generation can emit a realtime-end message based solely on `previous_turn_settings` when the current turn is inactive.

**Data flow**: Stores previous-turn settings with `realtime_active: Some(true)`, builds initial context for a normal turn, extracts developer texts, and asserts one mentions `Reason: inactive`.

**Call relations**: Covers previous-turn fallback during initial prompt assembly.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `build_initial_context_restates_realtime_start_when_reference_context_is_missing`  (lines 8082–8102)

```
async fn build_initial_context_restates_realtime_start_when_reference_context_is_missing()
```

**Purpose**: Checks initial-context generation restates active realtime state when previous-turn settings say realtime was active but no reference context item exists.

**Data flow**: Creates a turn with `realtime_active = true`, stores previous-turn settings indicating realtime was active, builds initial context, and asserts a realtime-start developer message is present.

**Call relations**: Documents behavior when baseline context is missing and realtime state must be restated.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `file_system_policy_with_unreadable_glob`  (lines 8104–8119)

```
fn file_system_policy_with_unreadable_glob(turn_context: &TurnContext) -> FileSystemSandboxPolicy
```

**Purpose**: Builds a filesystem sandbox policy derived from the turn's legacy sandbox policy plus an extra deny glob for `.env` files under the cwd.

**Data flow**: Starts from `FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd`, formats a cwd-prefixed `**/*.env` glob, appends a deny entry, and returns the modified policy.

**Call relations**: Used by tests that need a filesystem policy differing from the legacy-equivalent permission profile.

*Call graph*: calls 2 internal fn (sandbox_policy, from_legacy_sandbox_policy_for_cwd); called by 2 (record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout, turn_context_item_stores_split_file_system_sandbox_policy_when_different); 1 external calls (format!).


##### `turn_context_item_uses_turn_context_comp_hash_snapshot`  (lines 8122–8131)

```
async fn turn_context_item_uses_turn_context_comp_hash_snapshot()
```

**Purpose**: Verifies `TurnContext::to_turn_context_item()` uses the turn context's own `comp_hash` snapshot rather than the current `model_info.comp_hash`.

**Data flow**: Mutates both `turn_context.comp_hash` and `turn_context.model_info.comp_hash` to different values, converts to `TurnContextItem`, and asserts the item stores the turn-context value.

**Call relations**: Covers serialization semantics for compaction hash snapshots.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert_eq!).


##### `turn_context_item_omits_legacy_equivalent_file_system_sandbox_policy`  (lines 8134–8144)

```
async fn turn_context_item_omits_legacy_equivalent_file_system_sandbox_policy()
```

**Purpose**: Checks `TurnContextItem` omits `file_system_sandbox_policy` when it is equivalent to the permission profile's legacy-derived policy.

**Data flow**: Creates a default turn context, converts it to `TurnContextItem`, and asserts `file_system_sandbox_policy` is `None` while `permission_profile` is present.

**Call relations**: Documents compact serialization of redundant filesystem policy state.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert_eq!).


##### `turn_context_item_stores_split_file_system_sandbox_policy_when_different`  (lines 8147–8166)

```
async fn turn_context_item_stores_split_file_system_sandbox_policy_when_different()
```

**Purpose**: Verifies `TurnContextItem` stores an explicit split filesystem policy when it differs from the permission profile's legacy-equivalent policy.

**Data flow**: Builds a modified filesystem policy with an unreadable glob, updates the turn context's permission profile to use it, converts to `TurnContextItem`, and asserts both explicit filesystem policy and permission profile are stored.

**Call relations**: Covers serialization of non-legacy-equivalent filesystem policy.

*Call graph*: calls 3 internal fn (file_system_policy_with_unreadable_glob, make_session_and_context, from_runtime_permissions_with_enforcement); 1 external calls (assert_eq!).


##### `record_context_updates_and_set_reference_context_item_injects_full_context_when_baseline_missing`  (lines 8169–8185)

```
async fn record_context_updates_and_set_reference_context_item_injects_full_context_when_baseline_missing()
```

**Purpose**: Checks recording context updates with no baseline injects the full initial context into history and stores the current reference context item.

**Data flow**: Calls `record_context_updates_and_set_reference_context_item` on a fresh session, compares resulting history to `build_initial_context`, and asserts the stored reference context equals `turn_context.to_turn_context_item()`.

**Call relations**: Covers baseline-missing behavior for context update recording.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert_eq!).


##### `record_context_updates_and_set_reference_context_item_reinjects_full_context_after_clear`  (lines 8188–8226)

```
async fn record_context_updates_and_set_reference_context_item_reinjects_full_context_after_clear()
```

**Purpose**: Verifies clearing the reference context after compaction causes the next context update to reinject full initial context after existing summary history.

**Data flow**: Records a compacted summary item, records context updates once, clears reference context and replaces history with only the summary, records context updates again, and asserts history now contains the summary followed by full initial context.

**Call relations**: Covers reinjection after baseline loss.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert_eq!, from_ref, vec!).


##### `record_context_updates_and_set_reference_context_item_persists_baseline_without_emitting_diffs`  (lines 8229–8285)

```
async fn record_context_updates_and_set_reference_context_item_persists_baseline_without_emitting_diffs()
```

**Purpose**: Checks that when a baseline reference context exists and no prompt-visible diffs are needed, recording context updates still persists the new `TurnContextItem` to rollout without changing history.

**Data flow**: Seeds a previous reference context, attaches persistence, confirms `build_settings_update_items` returns empty, records context updates, asserts history stays empty, flushes rollout, reloads persisted history, and asserts a `RolloutItem::TurnContext` matching the new turn context was stored.

**Call relations**: Documents separation between persisted baseline updates and prompt-visible diff items.

*Call graph*: calls 3 internal fn (attach_thread_persistence, make_session_and_context, get_rollout_history); 2 external calls (assert_eq!, panic!).


##### `record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout`  (lines 8288–8319)

```
async fn record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout()
```

**Purpose**: Verifies persisted `TurnContext` rollout items include explicit split filesystem policy when present.

**Data flow**: Builds a turn context with modified filesystem policy, attaches persistence, records context updates, flushes rollout, reloads persisted history, and asserts the stored `TurnContext` carries that filesystem policy.

**Call relations**: Covers rollout persistence of non-default filesystem policy state.

*Call graph*: calls 5 internal fn (attach_thread_persistence, file_system_policy_with_unreadable_glob, make_session_and_context, from_runtime_permissions_with_enforcement, get_rollout_history); 2 external calls (assert_eq!, panic!).


##### `build_initial_context_prepends_model_switch_message`  (lines 8322–8343)

```
async fn build_initial_context_prepends_model_switch_message()
```

**Purpose**: Checks initial context begins with a developer `<model_switch>` message when previous-turn settings indicate a different prior model.

**Data flow**: Stores previous-turn settings with a different model slug, builds initial context, inspects the first `ResponseItem`, and asserts it is a developer message whose text contains `<model_switch>`.

**Call relations**: Covers model-switch messaging in initial prompt assembly.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert!, assert_eq!, panic!).


##### `record_context_updates_and_set_reference_context_item_persists_full_reinjection_to_rollout`  (lines 8346–8406)

```
async fn record_context_updates_and_set_reference_context_item_persists_full_reinjection_to_rollout()
```

**Purpose**: Verifies when baseline context is missing and full context is reinjected, the new `TurnContextItem` is also persisted to rollout.

**Data flow**: Attaches persistence, seeds rollout with a user message, clears reference context, stores previous-turn settings, records context updates, flushes rollout, reloads persisted history, and asserts a persisted `TurnContext` matches the current turn context.

**Call relations**: Complements the baseline-persistence test for the reinjection path.

*Call graph*: calls 3 internal fn (attach_thread_persistence, make_session_and_context, get_rollout_history); 6 external calls (default, new, assert_eq!, panic!, UserMessage, EventMsg).


##### `run_user_shell_command_does_not_set_reference_context_item`  (lines 8409–8436)

```
async fn run_user_shell_command_does_not_set_reference_context_item()
```

**Purpose**: Ensures standalone user shell command turns do not mutate the session's reference context item.

**Data flow**: Clears reference context, invokes `handlers::run_user_shell_command`, waits until a `TurnComplete` event arrives, and asserts `reference_context_item()` is still `None`.

**Call relations**: Documents that standalone shell tasks are not treated as context-bearing conversational turns.

*Call graph*: calls 2 internal fn (run_user_shell_command, make_session_and_context_with_rx); 5 external calls (from_secs, assert!, matches!, now, timeout).


##### `realtime_conversation_list_voices_emits_builtin_list`  (lines 8439–8481)

```
async fn realtime_conversation_list_voices_emits_builtin_list()
```

**Purpose**: Checks the realtime voice-list handler emits the built-in v1/v2 voice catalog and defaults.

**Data flow**: Invokes `handlers::realtime_conversation_list_voices`, receives one event, pattern matches `RealtimeConversationListVoicesResponse`, and asserts the full `RealtimeVoicesList` contents.

**Call relations**: Covers a simple protocol handler that returns static voice metadata.

*Call graph*: calls 2 internal fn (realtime_conversation_list_voices, make_session_and_context_with_rx); 2 external calls (assert_eq!, panic!).


##### `CompletingTask::kind`  (lines 8487–8489)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Reports that `CompletingTask` is a regular task.

**Data flow**: Reads no state and returns `TaskKind::Regular`.

**Call relations**: Used by task-finish/thread-idle tests when spawning a task that should complete immediately.


##### `CompletingTask::span_name`  (lines 8491–8493)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Provides the tracing span name for `CompletingTask` executions.

**Data flow**: Returns the static string `"session_task.completing"`.

**Call relations**: Consumed by session task spawning to label tracing spans.


##### `CompletingTask::run`  (lines 8495–8503)

```
async fn run(
        self: Arc<Self>,
        _session: Arc<SessionTaskContext>,
        _ctx: Arc<TurnContext>,
        _input: Vec<TurnInput>,
        _cancellation_token: CancellationToken,
    )
```

**Purpose**: Implements a no-op task that completes immediately without producing a final agent message.

**Data flow**: Ignores session, turn, input, and cancellation token and returns `None`.

**Call relations**: Used to trigger normal task completion and thread-idle lifecycle without extra behavior.


##### `NeverEndingTask::kind`  (lines 8513–8515)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Returns the configured `TaskKind` stored in the `NeverEndingTask` fixture.

**Data flow**: Reads `self.kind` and returns it unchanged.

**Call relations**: Lets tests reuse the same task body for regular, review, or compact turns.


##### `NeverEndingTask::span_name`  (lines 8517–8519)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Provides the tracing span name for the never-ending task fixture.

**Data flow**: Returns the static string `"session_task.never_ending"`.

**Call relations**: Used by task spawning for trace labeling.


##### `NeverEndingTask::run`  (lines 8521–8535)

```
async fn run(
        self: Arc<Self>,
        _session: Arc<SessionTaskContext>,
        _ctx: Arc<TurnContext>,
        _input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -
```

**Purpose**: Implements a task that either waits for cancellation or sleeps forever, depending on fixture configuration.

**Data flow**: If `listen_to_cancellation_token` is true, awaits `cancellation_token.cancelled()` and returns `None`; otherwise loops forever sleeping for 60 seconds at a time.

**Call relations**: This is the main long-lived task fixture for abort, steering, mailbox, and lifecycle-ordering tests.

*Call graph*: 3 external calls (cancelled, from_secs, sleep).


##### `GuardianDeniedApprovalTask::kind`  (lines 8542–8544)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Reports that the guardian-denial fixture runs as a regular task.

**Data flow**: Returns `TaskKind::Regular`.

**Call relations**: Used by guardian circuit-breaker tests.


##### `GuardianDeniedApprovalTask::span_name`  (lines 8546–8548)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Provides the tracing span name for the guardian-denial fixture task.

**Data flow**: Returns the static string `"session_task.guardian_denied_approval"`.

**Call relations**: Used by task spawning for trace labeling.


##### `GuardianDeniedApprovalTask::run`  (lines 8550–8564)

```
async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        _input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) ->
```

**Purpose**: Simulates three consecutive guardian denials for the current turn, then waits for cancellation.

**Data flow**: Clones the underlying `Session`, loops three times calling `record_guardian_denial_for_test(&session, &ctx, &ctx.sub_id)`, then awaits cancellation and returns `None`.

**Call relations**: Drives guardian circuit-breaker tests that expect the session to interrupt the turn after repeated denials.

*Call graph*: 2 external calls (cancelled, record_guardian_denial_for_test).


##### `guardian_auto_review_interrupts_after_three_consecutive_denials`  (lines 8568–8599)

```
async fn guardian_auto_review_interrupts_after_three_consecutive_denials()
```

**Purpose**: Verifies three guardian denials recorded from within the active task trigger turn interruption.

**Data flow**: Spawns `GuardianDeniedApprovalTask` with user input, then consumes events until `TurnAborted` arrives or times out, collecting observed events for diagnostics, and asserts the abort reason is `Interrupted`.

**Call relations**: Exercises the guardian denial circuit breaker in the auto-review path.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 7 external calls (clone, new, assert_eq!, TurnAborted, from_secs, timeout, vec!).


##### `guardian_helper_review_interrupts_after_three_consecutive_denials`  (lines 8602–8661)

```
async fn guardian_helper_review_interrupts_after_three_consecutive_denials()
```

**Purpose**: Checks the same guardian circuit breaker when denials are recorded from a helper thread while a turn remains active.

**Data flow**: Spawns a cancellable never-ending regular task, starts a separate OS thread with its own Tokio runtime that records three guardian denials, then waits for `TurnAborted` and asserts interruption.

**Call relations**: Covers cross-thread guardian denial recording and interruption.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 8 external calls (clone, from_secs, new, assert_eq!, TurnAborted, spawn, timeout, vec!).


##### `abort_regular_task_emits_marker_before_turn_aborted`  (lines 8665–8703)

```
async fn abort_regular_task_emits_marker_before_turn_aborted()
```

**Purpose**: Verifies aborting a non-cooperative regular task emits the model-visible raw abort marker before the `TurnAborted` event and nothing afterward.

**Data flow**: Spawns a never-ending regular task that ignores cancellation, calls `abort_all_tasks(Interrupted)`, receives a `RawResponseItem`, then a `TurnAborted` event, and finally asserts the receiver is empty.

**Call relations**: Covers abort event ordering for forcefully interrupted tasks.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 7 external calls (clone, assert!, assert_eq!, panic!, from_secs, timeout, vec!).


##### `abort_gracefully_emits_marker_before_turn_aborted`  (lines 8706–8744)

```
async fn abort_gracefully_emits_marker_before_turn_aborted()
```

**Purpose**: Checks the same marker-before-aborted ordering for a task that cooperatively listens for cancellation.

**Data flow**: Spawns a cancellable never-ending regular task, aborts all tasks, receives the raw marker then `TurnAborted`, and asserts no extra events remain.

**Call relations**: Provides the graceful-cancellation counterpart to the previous test.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 7 external calls (clone, assert!, assert_eq!, panic!, from_secs, timeout, vec!).


##### `task_finish_emits_turn_item_lifecycle_for_leftover_pending_user_input`  (lines 8747–8866)

```
async fn task_finish_emits_turn_item_lifecycle_for_leftover_pending_user_input()
```

**Purpose**: Verifies pending steered user input left in the mailbox at task completion is persisted to history and emitted through item lifecycle plus legacy user-message events before `TurnComplete`.

**Data flow**: Spawns a never-ending task, clears any startup events, steers late user input with text elements into the active turn, manually calls `on_task_finished`, then asserts history contains the pending input and the event stream emits `RawResponseItem`, `ItemStarted`, `ItemCompleted`, legacy `UserMessage`, and finally `TurnComplete` in order.

**Call relations**: Exercises task-finish cleanup of leftover pending input.

*Call graph*: calls 2 internal fn (new, make_session_and_context_with_rx); 6 external calls (clone, default, assert!, from_secs, timeout, vec!).


##### `task_finish_emits_thread_idle_lifecycle_after_active_turn_clears`  (lines 8869–8914)

```
async fn task_finish_emits_thread_idle_lifecycle_after_active_turn_clears()
```

**Purpose**: Checks thread-idle lifecycle callbacks fire after a completing task clears the active turn.

**Data flow**: Installs a `ThreadLifecycleContributor` that signals over a channel, spawns `CompletingTask`, waits for the idle signal, then asserts the callback count is one and `session.active_turn` is `None`.

**Call relations**: Covers idle lifecycle emission on normal task completion.

*Call graph*: calls 1 internal fn (make_session_and_context); 10 external calls (clone, new, from_secs, new, assert!, assert_eq!, bounded, new, new, timeout).


##### `thread_idle_lifecycle_waits_for_trigger_turn_mailbox_work`  (lines 8917–8954)

```
async fn thread_idle_lifecycle_waits_for_trigger_turn_mailbox_work()
```

**Purpose**: Verifies thread-idle lifecycle is suppressed while trigger-turn mailbox work is pending.

**Data flow**: Installs a thread-idle contributor, enqueues an `InterAgentCommunication` with `trigger_turn = true`, calls `emit_thread_idle_lifecycle_if_idle`, and asserts the contributor was not called.

**Call relations**: Documents that pending trigger-turn mailbox items keep the thread logically non-idle.

*Call graph*: calls 3 internal fn (make_session_and_context, root, new); 6 external calls (clone, new, new, assert_eq!, new, new).


##### `try_start_turn_if_idle_rejects_active_turn_without_injecting`  (lines 8957–8983)

```
async fn try_start_turn_if_idle_rejects_active_turn_without_injecting()
```

**Purpose**: Checks `try_start_turn_if_idle` rejects synthetic input when a regular turn is already active and does not enqueue that input.

**Data flow**: Spawns a cancellable regular task, calls `try_start_turn_if_idle` with one user message, inspects the rejection reason and returned input, asserts the input queue stayed empty, then aborts the task.

**Call relations**: Covers the busy-turn rejection branch for idle-start attempts.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, user_message); 4 external calls (clone, new, assert_eq!, vec!).


##### `try_start_turn_if_idle_rejects_plan_mode_without_injecting`  (lines 8986–9008)

```
async fn try_start_turn_if_idle_rejects_plan_mode_without_injecting()
```

**Purpose**: Verifies idle-start attempts are rejected in plan mode without creating an active turn or queueing input.

**Data flow**: Mutates session collaboration mode to `ModeKind::Plan`, calls `try_start_turn_if_idle`, and asserts rejection reason `PlanMode`, no active turn, and no queued input.

**Call relations**: Covers plan-mode gating of automatic idle turns.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, user_message); 3 external calls (assert!, assert_eq!, vec!).


##### `try_start_turn_if_idle_rejects_pending_trigger_turn_without_injecting`  (lines 9011–9036)

```
async fn try_start_turn_if_idle_rejects_pending_trigger_turn_without_injecting()
```

**Purpose**: Checks idle-start attempts are rejected when trigger-turn mailbox items are pending.

**Data flow**: Enqueues trigger-turn inter-agent communication, calls `try_start_turn_if_idle`, and asserts rejection reason `PendingTriggerTurn`, no active turn, and mailbox trigger work still present.

**Call relations**: Covers mailbox gating of automatic idle turns.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, user_message, root, new); 4 external calls (new, assert!, assert_eq!, vec!).


##### `try_start_turn_if_idle_rejects_active_review_turn_without_injecting`  (lines 9039–9065)

```
async fn try_start_turn_if_idle_rejects_active_review_turn_without_injecting()
```

**Purpose**: Verifies idle-start attempts are rejected while a review turn is active, just like regular active turns.

**Data flow**: Spawns a cancellable `TaskKind::Review` task, calls `try_start_turn_if_idle`, asserts `Busy` rejection and empty pending-input queue, then aborts the task.

**Call relations**: Extends busy-turn rejection coverage to non-regular active turns.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, user_message); 4 external calls (clone, new, assert_eq!, vec!).


##### `steer_input_requires_active_turn`  (lines 9068–9087)

```
async fn steer_input_requires_active_turn()
```

**Purpose**: Checks steering input fails with `SteerInputError::NoActiveTurn` when no turn is active.

**Data flow**: Calls `steer_input` on a fresh session with one text input and asserts the returned error variant.

**Call relations**: Covers the basic precondition for steering.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 3 external calls (default, assert!, vec!).


##### `steer_input_enforces_expected_turn_id`  (lines 9090–9133)

```
async fn steer_input_enforces_expected_turn_id()
```

**Purpose**: Verifies steering input fails when the caller supplies an expected turn ID that does not match the active turn.

**Data flow**: Spawns a regular task, calls `steer_input` with `expected_turn_id = "different-turn-id"`, pattern matches `ExpectedTurnMismatch`, and asserts both expected and actual IDs.

**Call relations**: Covers optimistic-concurrency protection for steering.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 5 external calls (clone, default, assert_eq!, panic!, vec!).


##### `steer_input_rejects_non_regular_turns`  (lines 9136–9179)

```
async fn steer_input_rejects_non_regular_turns()
```

**Purpose**: Checks steering is rejected for active review and compact turns with the correct `NonSteerableTurnKind`.

**Data flow**: Loops over `(TaskKind::Review, Review)` and `(TaskKind::Compact, Compact)`, spawns each task kind, calls `steer_input`, asserts `ActiveTurnNotSteerable { turn_kind }`, and aborts the task.

**Call relations**: Documents which turn kinds can accept steered input.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 3 external calls (default, assert_eq!, vec!).


##### `steer_input_returns_active_turn_id`  (lines 9182–9218)

```
async fn steer_input_returns_active_turn_id()
```

**Purpose**: Verifies successful steering returns the active turn ID and leaves pending input queued for that turn.

**Data flow**: Spawns a regular task, calls `steer_input` with matching expected turn ID, asserts the returned ID equals the active turn's sub-ID, and checks the input queue now has pending input.

**Call relations**: Covers the successful steering path.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 5 external calls (clone, default, assert!, assert_eq!, vec!).


##### `abort_empty_active_turn_preserves_pending_input`  (lines 9221–9253)

```
async fn abort_empty_active_turn_preserves_pending_input()
```

**Purpose**: Checks aborting an otherwise empty active turn preserves pending queued input associated with that turn state.

**Data flow**: Creates an `ActiveTurn`, appends one pending `TurnInput::ResponseItem` to its turn-state queue, aborts all tasks with `Replaced`, then asserts active turn is cleared and the pending input can still be taken from the old turn state.

**Call relations**: Documents queue preservation across abort when no task consumed the pending input.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 4 external calls (clone, assert!, assert_eq!, vec!).


##### `set_total_token_usage`  (lines 9255–9262)

```
async fn set_total_token_usage(sess: &Session, total_token_usage: TokenUsage)
```

**Purpose**: Helper that seeds session state with a `TokenUsageInfo` containing a specified total token usage and default last usage.

**Data flow**: Locks session state and writes `Some(TokenUsageInfo { total_token_usage, last_token_usage: default, model_context_window: None })`.

**Call relations**: Used by turn-start lifecycle tests to establish a token baseline.

*Call graph*: called by 1 (turn_start_lifecycle_exposes_turn_metadata_and_token_baseline); 1 external calls (default).


##### `queue_only_mailbox_mail_waits_for_next_turn_after_answer_boundary`  (lines 9265–9306)

```
async fn queue_only_mailbox_mail_waits_for_next_turn_after_answer_boundary()
```

**Purpose**: Verifies non-trigger mailbox communications arriving after the current turn's answer boundary stay buffered for the next turn rather than extending the current turn.

**Data flow**: Spawns a cancellable regular task, marks mailbox delivery deferred for the current turn, enqueues queue-only inter-agent communication, asserts no pending input is visible to the active turn, aborts the turn with `Replaced`, and then asserts the communication appears as pending input for the next turn.

**Call relations**: Covers mailbox buffering semantics after answer boundary for queue-only mail.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, root, try_from, new); 4 external calls (clone, new, assert!, assert_eq!).


##### `trigger_turn_mailbox_mail_waits_for_next_turn_after_answer_boundary`  (lines 9309–9342)

```
async fn trigger_turn_mailbox_mail_waits_for_next_turn_after_answer_boundary()
```

**Purpose**: Checks trigger-turn mailbox communications arriving after answer boundary also wait for the next turn instead of extending the current one.

**Data flow**: Spawns a cancellable regular task, defers mailbox delivery, enqueues trigger-turn communication, asserts no pending input is visible to the active turn, aborts the turn, and then asserts trigger-turn mailbox items remain queued.

**Call relations**: Covers the trigger-turn variant of post-answer mailbox buffering.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, root, try_from, new); 3 external calls (clone, new, assert!).


##### `steered_input_reopens_mailbox_delivery_for_current_turn`  (lines 9345–9396)

```
async fn steered_input_reopens_mailbox_delivery_for_current_turn()
```

**Purpose**: Verifies steering new user input after mailbox delivery was deferred reopens delivery so buffered queue-only mailbox communication joins the current turn's pending input.

**Data flow**: Spawns a cancellable regular task, defers mailbox delivery, enqueues queue-only communication, successfully steers follow-up user input, and asserts pending input now contains both the steered user input and the buffered communication.

**Call relations**: Documents that steering reopens the current turn to additional mailbox work.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, root, try_from, new); 5 external calls (clone, default, new, assert_eq!, vec!).


##### `stale_defer_mailbox_delivery_does_not_override_steered_input`  (lines 9399–9454)

```
async fn stale_defer_mailbox_delivery_does_not_override_steered_input()
```

**Purpose**: Checks a stale later call to defer mailbox delivery does not undo the reopening caused by steered input.

**Data flow**: Repeats the previous setup, steers follow-up input, calls `defer_mailbox_delivery_to_next_turn` again with the same turn ID, and asserts pending input still contains both steered input and mailbox communication.

**Call relations**: Covers idempotence/staleness handling in mailbox-delivery deferral.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, root, try_from, new); 5 external calls (clone, default, new, assert_eq!, vec!).


##### `tool_calls_reopen_mailbox_delivery_for_current_turn`  (lines 9457–9509)

```
async fn tool_calls_reopen_mailbox_delivery_for_current_turn()
```

**Purpose**: Verifies handling a tool call after answer boundary reopens mailbox delivery so buffered queue-only mailbox communication becomes pending for the current turn.

**Data flow**: Spawns a cancellable regular task, defers mailbox delivery, enqueues queue-only communication, handles a `ResponseItem::FunctionCall` through `handle_output_item_done`, asserts the returned output requests follow-up/tool future, and checks pending input now contains the buffered communication.

**Call relations**: Shows that tool-call follow-up, like steered input, reopens current-turn mailbox delivery.

*Call graph*: calls 6 internal fn (make_session_and_context_with_rx, test_tool_runtime, new, root, try_from, new); 6 external calls (clone, new, new, new, assert!, assert_eq!).


##### `abort_review_task_emits_exited_then_aborted_and_records_history`  (lines 9512–9586)

```
async fn abort_review_task_emits_exited_then_aborted_and_records_history()
```

**Purpose**: Checks aborting a review task emits `ExitedReviewMode` before `TurnAborted` and still records the model-visible `<turn_aborted>` marker in history.

**Data flow**: Spawns `ReviewTask::new()`, aborts all tasks, scans events until it sees both `ExitedReviewMode` and `TurnAborted`, asserts ordering and abort reason, then inspects history to confirm a user message matching `TurnAborted` marker text exists.

**Call relations**: Covers review-mode-specific abort sequencing and history recording.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, new); 7 external calls (clone, assert!, assert_eq!, from_secs, now, timeout, vec!).


##### `fatal_tool_error_stops_turn_and_reports_error`  (lines 9589–9646)

```
async fn fatal_tool_error_stops_turn_and_reports_error()
```

**Purpose**: Verifies dispatching a tool call with an incompatible payload yields `FunctionCallError::Fatal` with the expected message.

**Data flow**: Builds a `ToolRouter` with MCP tool lists, constructs a `CustomToolCall` for `shell_command`, converts it to a tool call, dispatches it through the router, expects an error, and asserts the fatal message text.

**Call relations**: Covers the fatal validation path in tool dispatch.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, build_tool_call, from_turn_context, new); 8 external calls (clone, new, new, default, new, assert_eq!, panic!, new).


##### `sample_rollout`  (lines 9648–9815)

```
async fn sample_rollout(
    session: &Session,
    _turn_context: &TurnContext,
) -> (Vec<RolloutItem>, Vec<ResponseItem>)
```

**Purpose**: Builds a synthetic rollout history and the corresponding expected prompt-visible history after two live compactions.

**Data flow**: Creates a fresh reconstruction turn, builds initial context, records it into both rollout items and a `ContextManager`, appends user/assistant exchanges, performs two compactions using `compact::build_compacted_history` over collected user messages, appends a final exchange, and returns both the rollout item list and the final prompt-visible history snapshot.

**Call relations**: Shared fixture for reconstruction and initial-history tests; it mirrors live compaction logic so replay can be compared against it.

*Call graph*: calls 4 internal fn (into, build_compacted_history, new, new); called by 5 (reconstruct_history_matches_live_compactions, record_initial_history_reconstructs_forked_transcript, record_initial_history_reconstructs_resumed_transcript, record_initial_history_seeds_token_info_from_rollout, resumed_history_injects_initial_context_on_first_context_update_only); 7 external calls (new, build_initial_context, new_default_turn, Compacted, ResponseItem, once, vec!).


##### `rejects_escalated_permissions_when_policy_not_on_request`  (lines 9818–9912)

```
async fn rejects_escalated_permissions_when_policy_not_on_request()
```

**Purpose**: Verifies the shell-command tool rejects requests for escalated permissions when approval policy is not `OnRequest`, and that this rejection does not poison later non-escalated approval checks.

**Data flow**: Creates a session/turn with `AskForApproval::OnFailure`, invokes `ShellCommandHandler` with `SandboxPermissions::RequireEscalated`, asserts the model-facing rejection string and absence of granted permissions, then switches the turn to `PermissionProfile::Disabled`, derives exec approval requirement for the same command under default sandbox permissions, and asserts it is `ExecApprovalRequirement::Skip`.

**Call relations**: Covers early policy rejection in shell-command approval handling and confirms it is isolated to the escalated path.

*Call graph*: calls 4 internal fn (make_session_and_context, from, new, plain); 10 external calls (clone, get_mut, new, new, assert!, format!, panic!, assert_eq!, json!, new).


##### `shell_tool_cancellation_waits_for_runtime_cleanup`  (lines 9916–9982)

```
async fn shell_tool_cancellation_waits_for_runtime_cleanup() -> anyhow::Result<()>
```

**Purpose**: On Unix, verifies cancelling a running shell tool waits for the process's TERM cleanup trap to run before dispatch returns.

**Data flow**: Builds a danger-full-access session, creates temp marker files, dispatches a shell command that writes a ready marker and traps TERM to write a cleanup marker, waits for readiness, cancels the tool call, awaits completion, and asserts the cleanup marker file contains `cleaned`.

**Call relations**: Exercises cancellation semantics of shell tool runtime and process cleanup.

*Call graph*: calls 3 internal fn (make_session_with_config, test_tool_runtime, build_tool_call); 13 external calls (clone, new, new, from_millis, from_secs, bail!, assert_eq!, format!, json!, new (+3 more)).


##### `unified_exec_rejects_escalated_permissions_when_policy_not_on_request`  (lines 9985–10030)

```
async fn unified_exec_rejects_escalated_permissions_when_policy_not_on_request()
```

**Purpose**: Checks the unified exec tool rejects escalated-permission requests when approval policy is not `OnRequest`.

**Data flow**: Creates a session/turn with `AskForApproval::OnFailure`, invokes `ExecCommandHandler` with `SandboxPermissions::RequireEscalated`, expects `FunctionCallError::RespondToModel`, and asserts the exact rejection message.

**Call relations**: Provides the unified-exec counterpart to the shell-command escalation rejection test.

*Call graph*: calls 4 internal fn (make_session_and_context, default, new, plain); 8 external calls (clone, new, new, format!, panic!, assert_eq!, json!, new).


##### `session_start_hooks_only_load_from_trusted_project_layers`  (lines 10033–10077)

```
async fn session_start_hooks_only_load_from_trusted_project_layers() -> std::io::Result<()>
```

**Purpose**: Verifies session-start hooks are discovered only from trusted project layers, even when multiple `.codex/hooks.json` files exist in the project tree.

**Data flow**: Creates codex home, project root, nested project, root and nested hook files, writes trust config trusting only the nested project, builds config rooted at the nested cwd, lists hooks, and asserts only the nested hook source path is discovered and preview remains empty because the hook is still untrusted.

**Call relations**: Covers interaction between project trust, config-layer discovery, and hook listing.

*Call graph*: calls 3 internal fn (write_project_hooks, write_project_trust_config, from_absolute_path); 8 external calls (assert!, assert_eq!, list_hooks, default, default, create_dir_all, write, tempdir).


##### `session_start_hooks_require_project_trust_without_config_toml`  (lines 10080–10134)

```
async fn session_start_hooks_require_project_trust_without_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks project hooks are discovered only when the project is explicitly trusted, even if no project `config.toml` exists.

**Data flow**: Creates a project with `.git` and `.codex/hooks.json`, then iterates over unknown/untrusted/trusted trust-config cases, building config each time, listing hooks, asserting expected hook count, and confirming preview remains empty; when discovered, the hook is still marked untrusted until trusted hash state exists.

**Call relations**: Complements the previous hook test by isolating project-trust requirements from other config files.

*Call graph*: calls 2 internal fn (write_project_hooks, write_project_trust_config); 11 external calls (new, assert!, assert_eq!, list_hooks, default, format!, default, create_dir_all, write, tempdir (+1 more)).


### `core/src/session/tests/guardian_tests.rs`

`test` · `request handling and permission-review paths during test execution`

This test module is a focused integration-style suite around guardian-mediated approvals. It builds real `Session`/turn contexts with `make_session_and_context` helpers, then selectively mutates runtime state such as `active_turn`, approval policy, enabled `Feature` flags, permission profiles, model-provider configuration, and granted turn permissions. Several tests stand up a mock SSE server and point `config.model_provider.base_url` at it so guardian review runs through the normal model-provider path and emits concrete `/v1/responses` requests whose bodies are asserted to contain permission reasons or shell commands.

The file covers both positive and negative control flow. It confirms that `request_permissions_for_environment` routes to guardian auto-review when `ApprovalsReviewer::AutoReview` and `Feature::GuardianApproval` are enabled, and that the async review can be interrupted via `CancellationToken` before any permission grant is recorded. It also checks tool-level behavior: shell-command execution may proceed when guardian-approved additional permissions are requested, strict auto-reviewed turn grants still force guardian review for later shell commands, and sticky turn permissions bypass inline validation even without the inline request-permissions feature. For unified exec, the test intentionally expects a validation error when `with_additional_permissions` omits `additional_permissions`.

Two tests cover guardian-specific session semantics beyond approvals: compacted history must preserve a separate guardian developer prompt instead of stale developer text, and a guardian subagent spawned from a parent session must not inherit the parent thread's project exec-policy rules, falling back to heuristic allow behavior instead.

#### Function details

##### `expect_text_output`  (lines 51–68)

```
fn expect_text_output(output: &T) -> String
```

**Purpose**: Normalizes a tool result into plain text by forcing it through the `ToolOutput` response-item conversion path and extracting the textual body from function-call output variants. It fails loudly if the tool returned any other response shape.

**Data flow**: It takes a borrowed `T: ToolOutput`, calls `to_response_item` with a fixed call id (`"call-guardian"`) and a synthetic empty `ToolPayload::Function`, then pattern-matches the resulting `ResponseInputItem`. For `FunctionCallOutput` or `CustomToolCallOutput`, it reads `output.body` and returns `to_text().unwrap_or_default()`. Any non-output variant triggers `panic!`, so the helper enforces the invariant that these tests only inspect tool-call outputs.

**Call relations**: This helper is invoked by the shell-command tests after `ShellCommandHandler::handle` succeeds, so those tests can assert on concrete stdout text instead of protocol structs. It delegates only to the `ToolOutput` conversion API because the tests want to validate the externally visible tool response format, not internal output types.

*Call graph*: called by 3 (guardian_allows_shell_command_additional_permissions_requests_past_policy_validation, shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature, strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip); 2 external calls (to_response_item, panic!).


##### `request_permissions_routes_to_guardian_when_reviewer_is_enabled`  (lines 71–167)

```
async fn request_permissions_routes_to_guardian_when_reviewer_is_enabled()
```

**Purpose**: Verifies that a permission request is auto-reviewed by the guardian model when guardian approvals are enabled, and that the resulting turn-scoped grant is recorded without waiting for a human client approval.

**Data flow**: The test creates a mock SSE server that returns a guardian JSON assessment with outcome `allow`. It builds a session/turn context, seeds an `ActiveTurn`, switches approval policy to `AskForApproval::OnRequest`, enables `Feature::GuardianApproval`, rewrites config to `ApprovalsReviewer::AutoReview` and to use the mock model-provider base URL, then rebuilds the models manager and provider from that config. It constructs a `RequestPermissionProfile` enabling network access, derives the primary environment selection, and awaits `session.request_permissions_for_environment(...)` under a 45-second timeout. The returned `Option<RequestPermissionsResponse>` is asserted to contain the requested permissions, `PermissionGrantScope::Turn`, and `strict_auto_review: false`; session state is then queried to confirm the local environment now has the granted turn permissions. Finally, the captured HTTP request body is inspected for `request_permissions` and the human reason text.

**Call relations**: This is a top-level async test that drives the full request-permissions path. Internally it relies on the session method under the condition that guardian approval is enabled and reviewer mode is auto-review; the mock server stands in for the guardian model endpoint so the test can observe the outbound review request and the resulting state mutation.

*Call graph*: calls 5 internal fn (default, models_manager_with_provider, mount_sse_once, sse, start_mock_server); 11 external calls (clone, new, new, from_secs, default, assert!, assert_eq!, create_model_provider, format!, timeout (+1 more)).


##### `request_permissions_guardian_review_stops_when_cancelled`  (lines 170–270)

```
async fn request_permissions_guardian_review_stops_when_cancelled()
```

**Purpose**: Checks that an in-flight guardian review exits promptly when its cancellation token is triggered, returning no grant and leaving turn permissions unchanged.

**Data flow**: The test mounts a delayed SSE response that emits only `response_created` and then stalls for 60 seconds, ensuring the guardian review remains pending. It creates a session/turn context plus an event receiver, seeds `ActiveTurn`, enables `AskForApproval::OnRequest` and `Feature::GuardianApproval`, rewrites config for `ApprovalsReviewer::AutoReview` and the mock base URL, and updates the session services/provider accordingly. It prepares a network-enabled `RequestPermissionProfile`, spawns `request_permissions_for_environment(...)` in a task with a cloned `CancellationToken`, then waits up to 5 seconds on the event channel until a `GuardianAssessment` event proves the review has started. After calling `cancel()`, it awaits the task under another timeout and asserts the result is `None`; a subsequent lookup of granted turn permissions for the local environment must also return `None`.

**Call relations**: This test is invoked directly by the test runner and exercises the cancellation branch of the same permission-request machinery used in the success case. It coordinates with the event stream to ensure cancellation happens after guardian review begins, then depends on the session method honoring the token instead of hanging on the delayed SSE response.

*Call graph*: calls 6 internal fn (default, models_manager_with_provider, mount_response_once, sse, sse_response, start_mock_server); 13 external calls (clone, get_mut, new, new, from_secs, default, assert_eq!, create_model_provider, format!, matches! (+3 more)).


##### `guardian_allows_shell_command_additional_permissions_requests_past_policy_validation`  (lines 273–363)

```
async fn guardian_allows_shell_command_additional_permissions_requests_past_policy_validation()
```

**Purpose**: Demonstrates that a shell command requesting additional sandbox permissions can execute successfully when guardian approval is enabled and returns an allow decision, even though the base permission profile is disabled.

**Data flow**: The test starts a mock guardian SSE server that returns an allow assessment. It builds a session/turn context, injects the Linux sandbox executable, sets approval policy to `OnRequest`, enables `Feature::GuardianApproval` on the turn and `Feature::ExecPermissionApprovals` on the session, and explicitly sets `turn_context_raw.permission_profile` to `PermissionProfile::Disabled`. It rewrites config to use the mock model provider, rebuilds models/provider, wraps session and turn in `Arc`, and computes a short timeout value. It then constructs a `ShellCommandHandler`, invokes it with a `ToolInvocation` whose JSON arguments request `SandboxPermissions::WithAdditionalPermissions`, include network `additional_permissions`, and justify the request, and awaits the result. On success, it passes the returned tool output through `expect_text_output` and asserts the text contains `hi` from `echo hi`.

**Call relations**: This test drives the shell-command tool path rather than calling request-permissions directly. The handler is expected to consult the guardian approval machinery because additional permissions are requested while normal permissions are disabled; the helper `expect_text_output` is used afterward to inspect the protocol-level tool output.

*Call graph*: calls 8 internal fn (expect_text_output, models_manager_with_provider, from, new, mount_sse_once, sse, start_mock_server, plain); 11 external calls (clone, new, new, assert!, cfg!, codex_linux_sandbox_exe_or_skip!, create_model_provider, format!, json!, new (+1 more)).


##### `strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip`  (lines 366–461)

```
async fn strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip()
```

**Purpose**: Verifies that a previously recorded strict auto-reviewed turn grant still causes later shell-command execution to go through guardian review, even when the normal approval reviewer is configured as the user and the command otherwise fits within the granted permissions.

**Data flow**: The test mounts a mock guardian SSE allow response, creates a session/turn context, seeds an `ActiveTurn`, captures its `turn_state`, and records a granted request-permissions response for the local environment with network enabled, turn scope, and `strict_auto_review: true`. It then sets the turn approval policy to `AskForApproval::OnFailure`, disables the inline permission profile, rewrites config to `ApprovalsReviewer::User` plus the mock base URL, rebuilds models/provider, and wraps state in `Arc`. A `ShellCommandHandler` is invoked with a simple `echo hi` payload lacking explicit additional-permissions fields. The test extracts text via `expect_text_output`, asserts the command ran, and inspects the guardian request log to confirm the outbound review body included `echo hi`.

**Call relations**: This test sits at the intersection of recorded turn grants and shell-command policy checks. It relies on `record_granted_request_permissions_for_turn` to seed session state before invoking the handler, then confirms that the handler still delegates to guardian review because the grant was marked strict auto-review.

*Call graph*: calls 9 internal fn (expect_text_output, default, models_manager_with_provider, from, new, mount_sse_once, sse, start_mock_server, plain); 10 external calls (clone, new, new, default, assert!, create_model_provider, format!, json!, new, vec!).


##### `guardian_allows_unified_exec_additional_permissions_requests_past_policy_validation`  (lines 464–511)

```
async fn guardian_allows_unified_exec_additional_permissions_requests_past_policy_validation()
```

**Purpose**: Confirms the unified `exec_command` tool still performs argument validation for additional-permissions requests, specifically rejecting `with_additional_permissions` when no concrete `additional_permissions` object is supplied.

**Data flow**: The test creates a session/turn context, sets approval policy to `OnRequest`, enables `Feature::GuardianApproval` on the turn and `Feature::ExecPermissionApprovals` on the session, then wraps session, turn, and a fresh `TurnDiffTracker` in `Arc`. It constructs a default `ExecCommandHandler` and invokes it with JSON arguments containing `cmd: "echo hi"`, `sandbox_permissions: WithAdditionalPermissions`, and a justification string but no `additional_permissions`. The awaited result is pattern-matched to require `Err(FunctionCallError::RespondToModel(output))`, and the returned validation message is asserted to exactly match the missing-additional-permissions error text.

**Call relations**: This top-level test exercises the unified exec handler's early validation path rather than the guardian network path. It is called directly by the test runner and expects the handler to stop before any execution or approval flow, surfacing a model-facing error string.

*Call graph*: calls 3 internal fn (default, new, plain); 7 external calls (clone, new, new, assert_eq!, panic!, json!, new).


##### `process_compacted_history_preserves_separate_guardian_developer_message`  (lines 514–571)

```
async fn process_compacted_history_preserves_separate_guardian_developer_message()
```

**Purpose**: Checks that history compaction for a guardian subagent rewrites developer messages correctly: stale developer content is removed, while the guardian policy prompt remains as a distinct developer message appended to the refreshed history.

**Data flow**: The test creates a session and mutable turn context, obtains the canonical guardian policy prompt, and constructs a guardian `SessionSource::SubAgent(SubAgentSource::Other(...))` using `GUARDIAN_REVIEWER_NAME`. It writes that source into both session state and turn context, and sets `turn_context.developer_instructions` to the guardian policy. It then calls `crate::compact_remote::process_compacted_history(...)` with two input `ResponseItem::Message` values: a stale developer message and a user summary, using `InitialContextInjection::BeforeLastUserMessage`. From the returned history vector, it filters only developer-role messages, converts their content to text, and asserts none contain the stale text, that there are at least two developer messages, and that the last one equals the guardian policy prompt.

**Call relations**: This test targets compaction logic rather than approvals or tool execution. It invokes `process_compacted_history` under the specific condition that the session is a guardian subagent, validating that guardian-specific developer instructions survive compaction as a separate message instead of being merged away or replaced by stale content.

*Call graph*: calls 1 internal fn (process_compacted_history); 6 external calls (SubAgent, assert!, assert_eq!, guardian_policy_prompt, Other, vec!).


##### `shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature`  (lines 579–643)

```
async fn shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature()
```

**Purpose**: Ensures shell-command execution can rely on already-recorded turn permissions even when the inline request-permissions feature is not enabled, preventing the tool from rejecting the command as if additional permissions were unavailable.

**Data flow**: On Unix only, the test creates a session and turn context, enables `Feature::RequestPermissionsTool`, seeds an `ActiveTurn`, then directly locks the active turn state and records granted local-environment permissions with network enabled. After wrapping session and turn in `Arc`, it constructs a classic `ShellCommandHandler` and invokes it with a basic `echo hi` payload and no explicit additional-permissions request. The result is matched in three branches: `Ok(output)` is converted with `expect_text_output` and must contain `hi`; `Err(FunctionCallError::RespondToModel(output))` is tolerated only if the message does not mention `additional permissions are disabled`; any other error panics.

**Call relations**: This test is called directly by the runner and probes a compatibility path where sticky turn grants should satisfy permission checks before inline validation rejects the command. It uses direct mutation of active-turn state to seed the precondition, then delegates execution to the shell-command handler.

*Call graph*: calls 5 internal fn (expect_text_output, default, from, new, plain); 8 external calls (clone, new, new, default, assert!, panic!, json!, new).


##### `guardian_subagent_does_not_inherit_parent_exec_policy_rules`  (lines 646–759)

```
async fn guardian_subagent_does_not_inherit_parent_exec_policy_rules()
```

**Purpose**: Verifies that a guardian subagent spawned from a parent session ignores inherited project exec-policy rules, so guardian review runs under its own permissive policy baseline instead of the parent's custom deny rules.

**Data flow**: The test creates temporary codex-home and project directories, writes a `rules/deny.rules` file containing a prefix rule forbidding `rm`, and builds test config rooted at that project. It replaces `config.config_layer_stack` with a project layer pointing at the temp project, then loads the parent `ExecPolicyManager` from that stack and asserts `check_multiple` on command `[["rm"]]` yields `Decision::Forbidden` with a `PrefixRuleMatch`. Next it constructs the supporting runtime pieces needed for `Codex::spawn`: auth manager, models manager, plugins manager, skills manager, MCP manager, local thread store, default test environment manager, and other spawn arguments. Crucially, it sets `session_source` to the guardian subagent source and passes `inherited_exec_policy: Some(Arc::new(parent_exec_policy))`. After spawning, it asserts the spawned codex session's current exec policy evaluates the same `rm` command to `Decision::Allow` with a `HeuristicsRuleMatch`, then drops the spawned codex.

**Call relations**: This is the broadest integration test in the file, covering process/session construction rather than a single handler. It first proves the parent policy denies the command, then invokes `Codex::spawn` under guardian-subagent conditions to confirm the spawn path intentionally discards inherited exec-policy rules for guardian reviewers.

*Call graph*: calls 13 internal fn (new, new, new, load, new, spawn, models_manager_with_provider, default_for_tests, from_auth_for_testing, from_api_key (+3 more)); 16 external calls (clone, new, default, new, default, SubAgent, assert_eq!, empty_extension_registry, default, default (+6 more)).


### `core/src/session/turn_tests.rs`

`test` · `test execution`

This test file defines a minimal `TurnItemContributor` implementation and one focused async test around plan-mode completion behavior. `RewriteAgentMessageContributor` intercepts `TurnItem::AgentMessage` values and replaces their content with a single `AgentMessageContent::Text` entry containing the fixed string `"plan contributed assistant text"`. The helper `assistant_output_text` constructs a synthetic assistant `ResponseItem::Message` with one `ContentItem::OutputText` chunk, making it easy to feed deterministic input into the plan-mode completion path.

The test `plan_mode_uses_contributed_turn_item_for_last_agent_message` builds a session and turn context using shared test helpers, registers the contributor in an `ExtensionRegistryBuilder`, creates a fresh per-turn `ExtensionData` store and `PlanModeStreamState`, and then calls `handle_assistant_item_done_in_plan_mode` directly with a raw assistant message containing different text. The assertions check two things: the specialized handler reports that it handled the item, and the mutable `last_agent_message` output is the contributor-rewritten text rather than the original assistant output. This locks in an important invariant for plan mode: contributor finalization is authoritative for the final agent message surfaced to later logic.

#### Function details

##### `RewriteAgentMessageContributor::contribute`  (lines 11–25)

```
fn contribute(
        &'a self,
        _thread_store: &'a ExtensionData,
        _turn_store: &'a ExtensionData,
        item: &'a mut TurnItem,
    ) -> codex_extension_api::ExtensionFuture<'a, Res
```

**Purpose**: Rewrites any contributed `TurnItem::AgentMessage` so its content becomes a single fixed text fragment. It leaves all other turn-item variants unchanged and reports success.

**Data flow**: Inputs are thread store, turn store, and a mutable `TurnItem`. Inside the boxed async future it pattern matches the item; if it is `TurnItem::AgentMessage`, it overwrites `agent_message.content` with `vec![AgentMessageContent::Text { text: "plan contributed assistant text".to_string() }]`. It returns `Ok(())`.

**Call relations**: Registered by the test through the extension registry so `handle_assistant_item_done_in_plan_mode` will run contributor finalization and observe the rewritten agent message.

*Call graph*: 2 external calls (pin, vec!).


##### `assistant_output_text`  (lines 28–38)

```
fn assistant_output_text(text: &str) -> ResponseItem
```

**Purpose**: Builds a synthetic assistant `ResponseItem::Message` containing one output-text chunk. It is a compact fixture helper for tests that need a finalized assistant response item.

**Data flow**: It takes a `&str`, constructs `ResponseItem::Message` with fixed ID `msg-1`, role `assistant`, `content` containing one `ContentItem::OutputText { text }`, and `None` for phase/metadata, then returns it.

**Call relations**: Used by `plan_mode_uses_contributed_turn_item_for_last_agent_message` to create the raw assistant item passed into the plan-mode completion handler.

*Call graph*: called by 1 (plan_mode_uses_contributed_turn_item_for_last_agent_message); 1 external calls (vec!).


##### `plan_mode_uses_contributed_turn_item_for_last_agent_message`  (lines 41–67)

```
async fn plan_mode_uses_contributed_turn_item_for_last_agent_message()
```

**Purpose**: Verifies that in plan mode, contributor-finalized agent-message text becomes the `last_agent_message` recorded by assistant-item completion handling. This guards against accidentally using the raw assistant response text after contributors have rewritten the turn item.

**Data flow**: The test creates a session and turn context, installs `RewriteAgentMessageContributor` into the extension registry, creates fresh `ExtensionData`, `PlanModeStreamState`, and `last_agent_message`, builds a raw assistant response item with `assistant_output_text`, then awaits `handle_assistant_item_done_in_plan_mode`. It asserts that the handler returned `true` and that `last_agent_message.as_deref()` equals `Some("plan contributed assistant text")`.

**Call relations**: This test directly exercises `handle_assistant_item_done_in_plan_mode` under contributor-enabled plan mode, using the custom contributor and helper fixture to isolate the behavior.

*Call graph*: calls 5 internal fn (make_session_and_context, new, assistant_output_text, new, new); 3 external calls (new, assert!, assert_eq!).


### `core/src/session/rollout_reconstruction_tests.rs`

`test` · `resume/history reconstruction testing`

This file is a focused async test module for the session subsystem’s rollout replay logic. It builds synthetic `RolloutItem` sequences—mixing `EventMsg` lifecycle events, `ResponseItem` chat messages, `TurnContextItem` snapshots, `CompactedItem` compaction markers, and `InterAgentCommunication` payloads—and verifies how `Session::record_initial_history` and `Session::reconstruct_history_from_rollout` interpret them.

Three small helpers create concrete `ResponseItem::Message` values for user text, assistant text, and assistant messages whose output text is serialized `InterAgentCommunication` JSON. The tests then probe subtle reconstruction rules: typed inter-agent messages must be rehydrated into model-input history; a standalone `TurnContextItem` must not seed `previous_turn_settings` or `reference_context_item`; a lifecycle-bounded turn can still hydrate settings even if the embedded `turn_id` is missing; and `ThreadRolledBack { num_turns }` must remove only user-originating turns from both visible history and metadata baselines.

Several cases stress compaction semantics. Legacy compaction with `replacement_history: None` is treated as a summary-only boundary that must not inject the current initial context and must clear any later reference context baseline. Newer compaction with replacement history can temporarily clear the baseline until a later `TurnContextItem` re-establishes it. The tests also distinguish incomplete, aborted, unmatched-abort, and replaced turns so that active-turn accounting does not incorrectly preserve or discard reference metadata. Overall, the file documents the exact replay contract between rollout logs and resumed session state.

#### Function details

##### `user_message`  (lines 15–25)

```
fn user_message(text: &str) -> ResponseItem
```

**Purpose**: Builds a concrete `ResponseItem::Message` representing a user utterance with a single `ContentItem::InputText` payload. It is a fixture helper used to make expected reconstructed histories readable and explicit.

**Data flow**: Takes `text: &str`, clones it into owned `String` fields, and returns a `ResponseItem::Message` with `role = "user"`, `id = None`, `phase = None`, `metadata = None`, and `content` containing exactly one `InputText` item.

**Call relations**: This helper is invoked by rollback reconstruction tests when assembling rollout inputs and expected `history` vectors. It delegates only to standard allocation/conversion machinery to construct the enum value used in assertions.

*Call graph*: called by 3 (reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_completed_turns, reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_incomplete_turn, reconstruct_history_rollback_skips_non_user_turns_for_history_and_metadata); 1 external calls (vec!).


##### `assistant_message`  (lines 27–37)

```
fn assistant_message(text: &str) -> ResponseItem
```

**Purpose**: Builds a concrete assistant-side `ResponseItem::Message` with one `ContentItem::OutputText`. It mirrors `user_message` but for assistant replies.

**Data flow**: Consumes `text: &str`, converts it to owned strings, and returns a `ResponseItem::Message` whose `role` is `"assistant"` and whose `content` is a one-element vector containing `OutputText { text }`; all optional metadata fields are left `None`.

**Call relations**: Rollback-oriented tests call this helper to populate rollout transcripts and expected post-reconstruction histories. It does not touch session state; it only produces deterministic fixture values for comparisons.

*Call graph*: called by 4 (reconstruct_history_rollback_counts_inter_agent_assistant_turns, reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_completed_turns, reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_incomplete_turn, reconstruct_history_rollback_skips_non_user_turns_for_history_and_metadata); 1 external calls (vec!).


##### `inter_agent_assistant_message`  (lines 39–56)

```
fn inter_agent_assistant_message(text: &str) -> ResponseItem
```

**Purpose**: Creates an assistant `ResponseItem` whose output text is a serialized `InterAgentCommunication` command from the root agent to a `worker` child. It lets tests verify that replay logic recognizes assistant messages that actually encode typed inter-agent traffic.

**Data flow**: Starts from a plain `text: &str`, constructs an `InterAgentCommunication` with `from = AgentPath::root()`, `to = root/worker`, empty attachments, the provided body text, and `trigger_turn = true`; it then JSON-serializes that struct and wraps the resulting string in `ResponseItem::Message` with assistant role and `OutputText` content.

**Call relations**: Only the inter-agent rollback-counting test uses this helper. Internally it delegates to `AgentPath::root`, `join`, `InterAgentCommunication::new`, and `serde_json::to_string` so the produced message matches the wire format the session replay code parses.

*Call graph*: calls 2 internal fn (root, new); called by 1 (reconstruct_history_rollback_counts_inter_agent_assistant_turns); 2 external calls (new, vec!).


##### `record_initial_history_reconstructs_typed_inter_agent_message`  (lines 59–81)

```
async fn record_initial_history_reconstructs_typed_inter_agent_message()
```

**Purpose**: Verifies that resuming from rollout history containing a typed `RolloutItem::InterAgentCommunication` stores the corresponding model-input item in session history rather than leaving it as an opaque event.

**Data flow**: Creates a fresh session/context pair, builds an `InterAgentCommunication` from `worker` back to root with `trigger_turn = false`, wraps it in `InitialHistory::Resumed(ResumedHistory { conversation_id, history, rollout_path })`, and awaits `session.record_initial_history(...)`. It then reads `session.state`, clones the reconstructed history, extracts raw items, and asserts equality with `communication.to_model_input_item()`.

**Call relations**: This test is a direct caller of `make_session_and_context` and `session.record_initial_history`. It exercises the resume path specifically for typed inter-agent rollout items and confirms the downstream state visible through the session’s locked history snapshot.

*Call graph*: calls 4 internal fn (make_session_and_context, root, new, default); 5 external calls (from, new, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_bare_turn_context_does_not_hydrate_previous_turn_settings`  (lines 84–121)

```
async fn record_initial_history_resumed_bare_turn_context_does_not_hydrate_previous_turn_settings()
```

**Purpose**: Checks that a resumed rollout containing only a `TurnContextItem` is insufficient to infer prior-turn metadata. The session must not treat an isolated context snapshot as a completed historical turn.

**Data flow**: Builds a synthetic `TurnContextItem` using the current test `turn_context` but with a distinct `model` string, passes it as the sole rollout item to `record_initial_history`, then queries `session.previous_turn_settings()` and `session.reference_context_item()`. The expected outputs are `None` and `None`.

**Call relations**: The test drives the resume entrypoint and then inspects the two metadata accessors that reconstruction seeds. It exists to prove that hydration requires lifecycle evidence, not just the presence of a context object in the log.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_hydrates_previous_turn_settings_from_lifecycle_turn_with_missing_turn_context_id`  (lines 124–203)

```
async fn record_initial_history_resumed_hydrates_previous_turn_settings_from_lifecycle_turn_with_missing_turn_context_id()
```

**Purpose**: Ensures previous-turn settings can still be recovered when the `TurnContextItem` itself lacks `turn_id`, as long as surrounding lifecycle events identify the turn. This guards against partially populated historical context records.

**Data flow**: Starts from a populated `TurnContextItem`, saves its original `turn_id`, clears the field to `None`, and constructs a rollout sequence with `TurnStarted`, `UserMessage`, the modified `TurnContext`, and `TurnComplete` for the saved ID. After `record_initial_history`, it reads `session.previous_turn_settings()` and expects `Some(PreviousTurnSettings { model, comp_hash, realtime_active })` derived from that context item.

**Call relations**: This test invokes the resume path with a lifecycle-bounded turn and validates that reconstruction correlates the context item to the active turn even without an embedded ID. It specifically probes the logic that joins event-stream turn identity with context metadata.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert_eq!, Resumed, vec!).


##### `reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_completed_turns`  (lines 206–315)

```
async fn reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_completed_turns()
```

**Purpose**: Verifies that rolling back one completed user turn removes both its chat messages and its metadata baseline, leaving the prior completed turn as the reconstructed state. The test checks synchronization between visible history and `previous_turn_settings`/`reference_context_item`.

**Data flow**: Creates two completed user turns: the first uses the current context item and user/assistant messages; the second uses a cloned context item with a different `turn_id` and `model`. It appends `ThreadRolledBack { num_turns: 1 }`, calls `session.reconstruct_history_from_rollout(&turn_context, &rollout_items)`, and asserts that the returned `history` contains only turn one’s messages, `previous_turn_settings` reflects the first context/model, and `reference_context_item` serializes equal to the first context item.

**Call relations**: This test bypasses `record_initial_history` and directly exercises the lower-level reconstruction routine. It uses `user_message` and `assistant_message` to make the expected transcript explicit and demonstrates that rollback trimming must update metadata and transcript together.

*Call graph*: calls 3 internal fn (assistant_message, user_message, make_session_and_context); 2 external calls (assert_eq!, vec!).


##### `reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_incomplete_turn`  (lines 318–409)

```
async fn reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_incomplete_turn()
```

**Purpose**: Checks the same rollback invariant as the completed-turn case, but when the rolled-back turn was incomplete and never emitted `TurnComplete`. The prior completed user turn must remain the baseline.

**Data flow**: Builds a rollout with one completed user turn followed by a second started user turn that has a `UserMessage` and one `ResponseItem` but no completion event, then appends `ThreadRolledBack { num_turns: 1 }`. After calling `reconstruct_history_from_rollout`, it asserts that only the first turn’s user/assistant messages survive and that metadata points back to the first turn’s context and model.

**Call relations**: Like the previous test, this one directly targets `reconstruct_history_from_rollout`. It exists to prove that rollback accounting treats incomplete user turns as rollback candidates and still keeps transcript and metadata aligned.

*Call graph*: calls 3 internal fn (assistant_message, user_message, make_session_and_context); 2 external calls (assert_eq!, vec!).


##### `reconstruct_history_rollback_skips_non_user_turns_for_history_and_metadata`  (lines 412–535)

```
async fn reconstruct_history_rollback_skips_non_user_turns_for_history_and_metadata()
```

**Purpose**: Confirms that rollback counts only user turns, not standalone assistant-only turns. A later non-user turn should not consume the rollback budget or disturb the retained baseline.

**Data flow**: Constructs three turns: a completed user turn with context and messages, a second completed user turn, and a third standalone assistant-only turn with no `UserMessage`. After `ThreadRolledBack { num_turns: 1 }`, reconstruction is expected to drop only the second user turn while leaving the first turn’s messages as history and the first context item as metadata baseline.

**Call relations**: This test directly invokes reconstruction and uses both message helpers to define the transcript. It probes the classification logic that distinguishes rollback-eligible user turns from auxiliary assistant-only turns.

*Call graph*: calls 3 internal fn (assistant_message, user_message, make_session_and_context); 2 external calls (assert_eq!, vec!).


##### `reconstruct_history_rollback_counts_inter_agent_assistant_turns`  (lines 538–636)

```
async fn reconstruct_history_rollback_counts_inter_agent_assistant_turns()
```

**Purpose**: Verifies that an assistant-initiated turn carrying inter-agent instructions still counts as a rollback-eligible turn. Even without a `UserMessage`, such a turn should be removed when one turn is rolled back.

**Data flow**: Creates an initial completed user turn, then a second completed turn whose context has a new `turn_id` and whose responses are an inter-agent assistant instruction plus a worker reply. After appending `ThreadRolledBack { num_turns: 1 }`, it reconstructs history and asserts that only the first turn’s user/assistant pair remains, with metadata still anchored to the first context item.

**Call relations**: This test is the sole caller of `inter_agent_assistant_message`, combining it with `assistant_message` to model a multi-agent assistant turn. It demonstrates that rollback logic recognizes assistant-originated inter-agent turns as substantive turns for counting purposes.

*Call graph*: calls 3 internal fn (assistant_message, inter_agent_assistant_message, make_session_and_context); 2 external calls (assert_eq!, vec!).


##### `reconstruct_history_rollback_clears_history_and_metadata_when_exceeding_user_turns`  (lines 639–690)

```
async fn reconstruct_history_rollback_clears_history_and_metadata_when_exceeding_user_turns()
```

**Purpose**: Checks the boundary case where rollback requests more user turns than exist. Reconstruction should fully clear transcript and metadata rather than leaving stale baseline state.

**Data flow**: Builds a rollout containing exactly one completed user turn and then `ThreadRolledBack { num_turns: 99 }`. It calls `reconstruct_history_from_rollout` and asserts that the returned `history` is empty, `previous_turn_settings` is `None`, and `reference_context_item` is absent.

**Call relations**: This test directly exercises the rollback truncation path in reconstruction. It validates the invariant that metadata cannot outlive all retained user turns.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert!, assert_eq!, vec!).


##### `record_initial_history_resumed_rollback_skips_only_user_turns`  (lines 693–765)

```
async fn record_initial_history_resumed_rollback_skips_only_user_turns()
```

**Purpose**: Ensures the higher-level resume path applies the same rollback counting rule as direct reconstruction: only user turns consume `ThreadRolledBack.num_turns`. A standalone task turn must not be mistaken for the rolled-back user turn.

**Data flow**: Creates a resumed rollout with one lifecycle-bounded user turn carrying a `TurnContextItem`, followed by a standalone turn that has `TurnStarted` and `TurnComplete` but no `UserMessage`, then a rollback of one turn. After `record_initial_history`, it reads `previous_turn_settings` and `reference_context_item`, expecting both to be cleared because the sole user turn was rolled back.

**Call relations**: This test drives `session.record_initial_history` rather than the lower-level reconstruction helper. It mirrors the direct rollback tests to prove the public resume API preserves the same user-turn-only semantics.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_rollback_drops_incomplete_user_turn_compaction_metadata`  (lines 768–858)

```
async fn record_initial_history_resumed_rollback_drops_incomplete_user_turn_compaction_metadata()
```

**Purpose**: Checks that compaction metadata attached to an incomplete user turn does not survive if that turn is later rolled back. The session should fall back to the previous completed turn’s settings and reference context.

**Data flow**: Builds a rollout with one completed user turn containing a `TurnContextItem`, then starts a second user turn, emits a `CompactedItem` with empty replacement history, and finally rolls back one turn. After recording initial history, it asserts that `previous_turn_settings` still reflect the earlier completed turn and that `reference_context_item` equals that earlier context item.

**Call relations**: This test exercises the interaction between resume-time rollback handling and compaction bookkeeping. It confirms that compaction state from a rolled-back incomplete turn is discarded instead of poisoning the resumed baseline.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_bare_turn_context_does_not_seed_reference_context_item`  (lines 861–875)

```
async fn record_initial_history_resumed_bare_turn_context_does_not_seed_reference_context_item()
```

**Purpose**: Verifies specifically that an isolated `TurnContextItem` does not establish the session’s `reference_context_item`. This is the reference-context half of the earlier bare-context hydration rule.

**Data flow**: Creates a rollout consisting only of a cloned current `TurnContextItem`, records it as resumed history, then queries `session.reference_context_item()` and asserts it is `None`.

**Call relations**: This test calls the public resume API and inspects only the reference-context accessor. It isolates the invariant that context seeding requires a meaningful turn lifecycle, not just a context record in the log.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert!, Resumed, vec!).


##### `record_initial_history_resumed_does_not_seed_reference_context_item_after_compaction`  (lines 878–900)

```
async fn record_initial_history_resumed_does_not_seed_reference_context_item_after_compaction()
```

**Purpose**: Ensures that a `TurnContextItem` followed immediately by compaction does not leave a reference baseline behind. Compaction invalidates that context unless a later turn context re-establishes it.

**Data flow**: Constructs resumed history with a single `TurnContextItem` and then `CompactedItem { replacement_history: Some(Vec::new()) }`, records it, and asserts both `previous_turn_settings()` and `reference_context_item()` are absent.

**Call relations**: This test targets the resume path’s compaction handling. It complements the bare-context tests by showing that even if a context appears before compaction, the compaction boundary clears any tentative baseline.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


##### `reconstruct_history_legacy_compaction_without_replacement_history_does_not_inject_current_initial_context`  (lines 903–928)

```
async fn reconstruct_history_legacy_compaction_without_replacement_history_does_not_inject_current_initial_context()
```

**Purpose**: Checks legacy compaction semantics when `replacement_history` is `None`: reconstruction should preserve the pre-compaction transcript and append the legacy summary as a user message, but it must not inject the current session’s initial context item.

**Data flow**: Creates rollout items consisting of a user message, an assistant reply, and a legacy `CompactedItem` with `message = "legacy summary"` and `replacement_history = None`. After reconstruction, it asserts that `history` becomes `[user_message("before compact"), user_message("legacy summary")]` and that `reference_context_item` is `None`.

**Call relations**: This test directly invokes `reconstruct_history_from_rollout` to pin down backward-compatibility behavior for older compaction records. It demonstrates that legacy summaries alter transcript shape without seeding context metadata.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert!, assert_eq!, vec!).


##### `reconstruct_history_legacy_compaction_without_replacement_history_clears_later_reference_context_item`  (lines 931–982)

```
async fn reconstruct_history_legacy_compaction_without_replacement_history_clears_later_reference_context_item()
```

**Purpose**: Verifies that once legacy compaction without replacement history occurs, a later `TurnContextItem` does not restore a reference baseline during reconstruction. The legacy boundary permanently prevents reference-context seeding for that replay.

**Data flow**: Builds a rollout with a user message, a legacy compacted summary, then a later lifecycle-bounded user turn containing the current `TurnContextItem`. It reconstructs history and asserts only that `reference_context_item` remains `None` despite the later context item.

**Call relations**: This test extends the previous legacy-compaction case by adding later lifecycle data. It proves that the reconstruction logic treats old-style compaction as a hard reset for reference-context derivation.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (assert!, vec!).


##### `record_initial_history_resumed_turn_context_after_compaction_reestablishes_reference_context_item`  (lines 985–1094)

```
async fn record_initial_history_resumed_turn_context_after_compaction_reestablishes_reference_context_item()
```

**Purpose**: Checks that modern compaction clears the baseline only temporarily: a later `TurnContextItem` within the same turn can re-establish both previous-turn settings and the reference context item.

**Data flow**: Creates a lifecycle-bounded user turn with `TurnStarted` and `UserMessage`, inserts a modern `CompactedItem` with empty replacement history before the `TurnContextItem`, then completes the turn. After `record_initial_history`, it asserts that `previous_turn_settings` reflect the later context item’s `model` and that `reference_context_item` equals that context item.

**Call relations**: This test drives the public resume API through a compaction-then-context sequence. It documents the intended recovery path after compaction: later explicit context snapshots can restore the metadata baseline.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_aborted_turn_without_id_clears_active_turn_for_compaction_accounting`  (lines 1097–1209)

```
async fn record_initial_history_resumed_aborted_turn_without_id_clears_active_turn_for_compaction_accounting()
```

**Purpose**: Ensures that a `TurnAborted` event lacking `turn_id` still clears the currently active turn for subsequent compaction accounting. Otherwise compaction after an aborted turn could incorrectly wipe the previous completed baseline.

**Data flow**: Builds a completed prior user turn with context, then starts a second user turn, emits `TurnAborted { turn_id: None, reason: Interrupted }`, and follows it with a modern `CompactedItem`. After recording resumed history, it asserts that `previous_turn_settings` still point to the earlier completed turn while `reference_context_item` is cleared.

**Call relations**: This test exercises a subtle resume-time state machine edge case: anonymous aborts must terminate the active turn. It validates that later compaction is attributed correctly and does not mutate the preserved previous-turn settings.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_unmatched_abort_preserves_active_turn_for_later_turn_context`  (lines 1212–1336)

```
async fn record_initial_history_resumed_unmatched_abort_preserves_active_turn_for_later_turn_context()
```

**Purpose**: Checks the opposite abort edge case: if `TurnAborted` names a different turn than the active one, the active turn must remain open so a later `TurnContextItem` can still seed metadata for it.

**Data flow**: Creates a completed previous turn, then starts a new current turn, emits `UserMessage`, emits `TurnAborted` for some unrelated `other-turn`, then records a `TurnContextItem` for the current turn and completes it. After `record_initial_history`, it asserts that `previous_turn_settings` and `reference_context_item` both reflect the current turn’s context/model.

**Call relations**: This test drives the resume path through mismatched abort handling. It proves the active-turn tracker ignores aborts for unrelated IDs and continues associating subsequent context with the still-active current turn.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_trailing_incomplete_turn_compaction_clears_reference_context_item`  (lines 1339–1443)

```
async fn record_initial_history_resumed_trailing_incomplete_turn_compaction_clears_reference_context_item()
```

**Purpose**: Verifies that if a completed turn is followed by a trailing incomplete user turn that gets compacted, the session keeps the previous-turn settings from the completed turn but clears the reference context item. The incomplete compacted tail cannot remain as the baseline.

**Data flow**: Builds a completed prior user turn with context, then starts another user turn, emits its `UserMessage`, and ends the rollout with a modern `CompactedItem` before completion or abort. After recording resumed history, it asserts preserved `previous_turn_settings` from the earlier turn and `reference_context_item == None`.

**Call relations**: This test targets resume-time handling of a compacted trailing partial turn. It confirms that compaction on an unfinished tail invalidates the reference baseline even though earlier completed-turn settings remain recoverable.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_trailing_incomplete_turn_preserves_turn_context_item`  (lines 1446–1499)

```
async fn record_initial_history_resumed_trailing_incomplete_turn_preserves_turn_context_item()
```

**Purpose**: Checks that an incomplete trailing user turn without compaction still preserves its `TurnContextItem` as the current metadata baseline. Incompleteness alone does not invalidate the context snapshot.

**Data flow**: Creates a rollout with `TurnStarted`, `UserMessage`, and a `TurnContextItem` for the current turn, but no completion, abort, or compaction. After `record_initial_history`, it asserts that `previous_turn_settings` reflect the current turn’s model and realtime flag and that `reference_context_item` equals the current context item.

**Call relations**: This test uses the public resume API to distinguish plain incompleteness from compacted incompleteness. It demonstrates that a trailing active turn can still seed metadata if nothing later invalidates it.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_replaced_incomplete_compacted_turn_clears_reference_context_item`  (lines 1502–1618)

```
async fn record_initial_history_resumed_replaced_incomplete_compacted_turn_clears_reference_context_item()
```

**Purpose**: Ensures that when an incomplete compacted turn is implicitly superseded by a newer `TurnStarted`, the compacted turn’s reference context does not survive. The session should retain only the earlier completed-turn settings and no reference context item.

**Data flow**: Builds a completed previous turn with context, then starts a second user turn, emits its `UserMessage`, compacts it, and finally starts a third replacing turn without ever completing or aborting the compacted one. After `record_initial_history`, it asserts that `previous_turn_settings` still reflect the earlier completed turn and that `reference_context_item` is `None`.

**Call relations**: This test drives the resume path through a replacement scenario where a newer turn start implicitly displaces an older incomplete compacted turn. It validates that active-turn replacement does not accidentally resurrect invalid reference metadata from the displaced turn.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


### `core/src/session/mcp_tests.rs`

`test` · `test execution`

This test module targets the pure helper logic in `session/mcp.rs` rather than the live session transport. Small builders keep the fixtures concise: `meta` wraps a JSON object into `rmcp::model::Meta` and panics if the caller passes a non-object; `guardian_meta` constructs the canonical metadata payload for an MCP tool-call approval request and optionally inserts `tool_params`; `form_request` builds a standard `ElicitationReviewRequest` using an empty `ElicitationSchema`. The tests then exercise the parser and mapper functions directly. `guardian_elicitation_review_request_builds_mcp_tool_call` confirms that valid metadata becomes `GuardianApprovalRequest::McpToolCall` with the expected synthesized id `mcp_elicitation:browser-use:7`, connector fields, tool title, and JSON arguments. Another test verifies missing `tool_params` defaults to `{}`. `plugin_install_elicitation_telemetry_metadata_requires_install_tool_suggestion` checks that telemetry is emitted only for `codex_approval_kind = tool_suggestion` plus `suggest_type = install`, not for other suggestion actions like `enable`. Additional tests prove that Guardian review requires explicit opt-in via `codex_request_type = approval_request`, and that unsupported shapes—URL elicitations, non-empty form schemas, or missing tool names—produce `Decline` results. The final test directly validates `mcp_elicitation_response_from_guardian_decision_parts`, ensuring approved, denied, timed-out, and abort decisions map to the exact `ElicitationResponse` action/content/meta combinations expected by MCP clients.

#### Function details

##### `meta`  (lines 7–12)

```
fn meta(value: Value) -> Option<Meta>
```

**Purpose**: Test helper that converts a JSON object into `Meta` and rejects non-object values.

**Data flow**: Accepts a `serde_json::Value`, pattern-matches it as `Value::Object(map)`, panics if the value is not an object, and otherwise returns `Some(Meta(map))`.

**Call relations**: Used by other test helpers and cases to build metadata fixtures in the same shape consumed by the production parser.

*Call graph*: called by 3 (guardian_elicitation_review_request_declines_unsupported_opt_in_shapes, guardian_elicitation_review_request_requires_opt_in, guardian_meta); 1 external calls (panic!).


##### `guardian_meta`  (lines 14–27)

```
fn guardian_meta(tool_params: Option<Value>) -> Option<Meta>
```

**Purpose**: Builds the canonical metadata object for a Guardian-reviewed MCP tool-call approval request, optionally including tool parameters.

**Data flow**: Starts from a JSON object containing approval kind, request type, connector id/name, tool name, and tool title; if `tool_params` is provided it inserts that field; then passes the JSON value to `meta` and returns the resulting `Option<Meta>`.

**Call relations**: Shared by multiple tests that need a valid opt-in metadata payload for `guardian_elicitation_review_request`.

*Call graph*: calls 1 internal fn (meta); called by 3 (guardian_elicitation_review_request_builds_mcp_tool_call, guardian_elicitation_review_request_declines_unsupported_opt_in_shapes, guardian_elicitation_review_request_defaults_missing_tool_params); 1 external calls (json!).


##### `form_request`  (lines 29–41)

```
fn form_request(meta: Option<Meta>) -> ElicitationReviewRequest
```

**Purpose**: Constructs a standard form-based `ElicitationReviewRequest` fixture with the supplied metadata and an empty schema.

**Data flow**: Consumes optional `Meta`, fills fixed `server_name`, numeric `request_id`, and message fields, builds an empty `ElicitationSchema` via its builder, and returns the assembled `ElicitationReviewRequest`.

**Call relations**: Used by most tests in this file to avoid repeating the common request envelope around varying metadata.

*Call graph*: called by 4 (guardian_elicitation_review_request_builds_mcp_tool_call, guardian_elicitation_review_request_declines_unsupported_opt_in_shapes, guardian_elicitation_review_request_defaults_missing_tool_params, guardian_elicitation_review_request_requires_opt_in); 2 external calls (builder, Number).


##### `guardian_elicitation_review_request_builds_mcp_tool_call`  (lines 44–80)

```
fn guardian_elicitation_review_request_builds_mcp_tool_call()
```

**Purpose**: Verifies that a valid Guardian MCP approval-request metadata payload is converted into the expected `GuardianApprovalRequest::McpToolCall`.

**Data flow**: Builds a form request with `guardian_meta` containing `tool_params.origin`, calls `guardian_elicitation_review_request`, destructures the result as `ApprovalRequest`, then destructures the boxed guardian request and asserts exact values for id, server, tool name, arguments, connector metadata, tool title/description, and annotations.

**Call relations**: This test directly exercises the happy-path parser branch in `guardian_elicitation_review_request`.

*Call graph*: calls 2 internal fn (form_request, guardian_meta); 3 external calls (assert_eq!, json!, panic!).


##### `guardian_elicitation_review_request_defaults_missing_tool_params`  (lines 83–97)

```
fn guardian_elicitation_review_request_defaults_missing_tool_params()
```

**Purpose**: Checks that omitted `tool_params` are normalized to an empty JSON object rather than `None`.

**Data flow**: Builds a form request with `guardian_meta(None)`, calls `guardian_elicitation_review_request`, destructures the resulting `ApprovalRequest`, extracts `arguments`, and asserts they equal `Some(json!({}))`.

**Call relations**: This test covers the parser’s defaulting behavior for absent tool arguments.

*Call graph*: calls 2 internal fn (form_request, guardian_meta); 2 external calls (assert_eq!, panic!).


##### `plugin_install_elicitation_telemetry_metadata_requires_install_tool_suggestion`  (lines 100–154)

```
fn plugin_install_elicitation_telemetry_metadata_requires_install_tool_suggestion()
```

**Purpose**: Ensures plugin-install telemetry metadata is extracted only for install suggestions, not for other tool-suggestion actions.

**Data flow**: Constructs one `EventMsg::ElicitationRequest` whose form metadata declares `codex_approval_kind = tool_suggestion`, `suggest_type = install`, and plugin identifiers, then asserts `plugin_install_elicitation_telemetry_metadata` returns the expected `PluginInstallElicitationTelemetryMetadata`. It constructs a second otherwise similar event with `suggest_type = enable` and asserts the helper returns `None`.

**Call relations**: This test targets the telemetry classifier used by `Session::request_mcp_server_elicitation`.

*Call graph*: 4 external calls (String, assert_eq!, json!, ElicitationRequest).


##### `guardian_elicitation_review_request_requires_opt_in`  (lines 157–167)

```
fn guardian_elicitation_review_request_requires_opt_in()
```

**Purpose**: Verifies that Guardian review is not requested unless metadata explicitly opts in with the approval-request request type.

**Data flow**: Builds a form request whose metadata includes `codex_approval_kind = mcp_tool_call` and `tool_name` but omits `codex_request_type`, calls `guardian_elicitation_review_request`, and asserts the result is `GuardianElicitationReview::NotRequested`.

**Call relations**: This test protects the opt-in requirement enforced by the production parser.

*Call graph*: calls 2 internal fn (form_request, meta); 2 external calls (assert_eq!, json!).


##### `guardian_elicitation_review_request_declines_unsupported_opt_in_shapes`  (lines 170–211)

```
fn guardian_elicitation_review_request_declines_unsupported_opt_in_shapes()
```

**Purpose**: Checks that malformed or unsupported opt-in requests are explicitly declined rather than silently ignored.

**Data flow**: Builds three requests: a URL elicitation with Guardian opt-in metadata, a form elicitation with a non-empty boolean schema property, and a form elicitation missing `tool_name` despite approval-request metadata. It calls `guardian_elicitation_review_request` on each and asserts each result matches `GuardianElicitationReview::Decline(_)`.

**Call relations**: This test covers the parser’s defensive branches for unsupported elicitation shapes and incomplete metadata.

*Call graph*: calls 3 internal fn (form_request, guardian_meta, meta); 6 external calls (new, builder, Boolean, assert!, json!, Number).


##### `guardian_decisions_map_to_elicitation_responses_without_session_state`  (lines 214–269)

```
fn guardian_decisions_map_to_elicitation_responses_without_session_state()
```

**Purpose**: Validates the pure mapping from Guardian review decisions to MCP elicitation responses without needing a live session.

**Data flow**: Calls `mcp_elicitation_response_from_guardian_decision_parts` with `ReviewDecision::Approved`, `Denied` plus a custom message, `TimedOut`, and `Abort`, and asserts each returned `ElicitationResponse` has the expected action, content, and metadata JSON.

**Call relations**: This test directly exercises the pure decision-mapping helper used by the session-aware Guardian review flow.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/state/session_tests.rs`

`test` · `test execution`

This file contains async unit tests for the session-state container. Each test constructs a real `SessionState` using `make_session_configuration_for_tests()` and then exercises one narrow behavior. Two tests cover connector selection: merging repeated connector IDs must deduplicate into a `HashSet`, and clearing the selection must remove all entries. Three tests cover rate-limit normalization and metadata carry-forward: a missing `limit_id` should become `"codex"`, even if the previous snapshot used another bucket such as `"codex_other"`; and when switching from `codex` to `codex_other`, omitted account metadata (`credits`, `individual_limit`, `plan_type`) must be preserved from the previous snapshot. Another test verifies that replacing history clears the auto-compact window's prefill snapshot, preventing stale token-prefill estimates from surviving transcript replacement.

The tests are intentionally concrete, constructing full `RateLimitSnapshot`, `RateLimitWindow`, `CreditsSnapshot`, and `SpendControlLimitSnapshot` values rather than mocking internals. That makes them useful as executable documentation for the merge policy implemented in `merge_rate_limit_fields` and the reset behavior in `replace_history()`.

#### Function details

##### `merge_connector_selection_deduplicates_entries`  (lines 11–24)

```
async fn merge_connector_selection_deduplicates_entries()
```

**Purpose**: Verifies that merging connector IDs into session state collapses duplicates and returns the unique merged set. It specifically checks repeated `calendar` entries alongside a distinct `drive` entry.

**Data flow**: The test awaits a test `SessionConfiguration`, constructs `SessionState::new`, calls `merge_connector_selection` with three strings containing one duplicate, and asserts that the returned `HashSet` contains only `calendar` and `drive` once each.

**Call relations**: This test exercises the constructor and connector-selection merge path directly. It serves as a regression check for the `HashSet`-based deduplication behavior in `SessionState::merge_connector_selection`.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 1 external calls (assert_eq!).


##### `clear_connector_selection_removes_entries`  (lines 28–36)

```
async fn clear_connector_selection_removes_entries()
```

**Purpose**: Checks that clearing connector selection empties the stored set after entries have been added. It confirms the reset behavior rather than merge semantics.

**Data flow**: The test builds a fresh `SessionState`, inserts `calendar` via `merge_connector_selection`, calls `clear_connector_selection`, then reads back the state with `get_connector_selection` and asserts it equals an empty `HashSet`.

**Call relations**: It validates the interaction between merge, clear, and read accessors on connector state. The test is a direct regression guard for `SessionState::clear_connector_selection`.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 1 external calls (assert_eq!).


##### `set_rate_limits_defaults_limit_id_to_codex_when_missing`  (lines 39–65)

```
async fn set_rate_limits_defaults_limit_id_to_codex_when_missing()
```

**Purpose**: Ensures that a rate-limit snapshot lacking `limit_id` is normalized to the default `codex` bucket. This protects callers from provider snapshots that omit the bucket identifier.

**Data flow**: The test creates a new `SessionState`, calls `set_rate_limits` with a `RateLimitSnapshot` whose `limit_id` is `None`, then inspects `state.latest_rate_limits` and asserts the stored `limit_id` is `Some("codex")`.

**Call relations**: This test targets the defaulting branch in `merge_rate_limit_fields`, reached through `SessionState::set_rate_limits`. It documents that missing IDs are not left unset.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 1 external calls (assert_eq!).


##### `replace_history_clears_auto_compact_window_prefill`  (lines 68–81)

```
async fn replace_history_clears_auto_compact_window_prefill()
```

**Purpose**: Verifies that replacing session history also clears any remembered auto-compaction prefill tokens. This prevents stale prefill accounting from leaking across transcript resets.

**Data flow**: The test constructs a new `SessionState`, seeds the auto-compact window with `set_auto_compact_window_estimated_prefill(100)`, calls `replace_history` with an empty item list and no reference context, then asserts that `auto_compact_window_snapshot()` has `prefill_input_tokens: None`.

**Call relations**: It exercises the coupling between transcript replacement and auto-compact bookkeeping. The test specifically guards the `clear_prefill()` call inside `SessionState::replace_history`.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 2 external calls (new, assert_eq!).


##### `set_rate_limits_defaults_to_codex_when_limit_id_missing_after_other_bucket`  (lines 84–124)

```
async fn set_rate_limits_defaults_to_codex_when_limit_id_missing_after_other_bucket()
```

**Purpose**: Checks that a later snapshot with missing `limit_id` resets to `codex` even if the previous snapshot used a different bucket. This prevents accidental inheritance of `codex_other` or similar IDs.

**Data flow**: The test creates a state, stores an initial snapshot with `limit_id: Some("codex_other")`, then stores a second snapshot with `limit_id: None`. It finally asserts that the resulting stored snapshot has `limit_id: Some("codex")`.

**Call relations**: This test covers a subtle edge case in `merge_rate_limit_fields`: missing `limit_id` should default, not preserve the previous bucket. It is a regression test for bucket normalization across successive updates.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 1 external calls (assert_eq!).


##### `set_rate_limits_carries_account_metadata_from_codex_to_codex_other`  (lines 127–196)

```
async fn set_rate_limits_carries_account_metadata_from_codex_to_codex_other()
```

**Purpose**: Verifies that account metadata omitted from a later snapshot is preserved from the previous one when switching buckets from `codex` to `codex_other`. It covers credits, spend-control limits, and plan type together.

**Data flow**: The test seeds `SessionState` with a full `RateLimitSnapshot` containing credits, individual limit, and plan type under `codex`, then applies a second snapshot for `codex_other` with those fields omitted. It asserts that `latest_rate_limits` equals a snapshot combining the new bucket/window data with the old account metadata.

**Call relations**: This test exercises the metadata-preservation branches in `merge_rate_limit_fields` through `SessionState::set_rate_limits`. It documents the intended carry-forward behavior when providers send partial updates.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 1 external calls (assert_eq!).


### `core/src/session_prefix_tests.rs`

`test` · `test execution`

This file contains a single regression test for the token-budgeting logic in `format_inter_agent_completion_message`. The test constructs an `AgentStatus::Errored` with a very large repeated error string (`"stream disconnected "` repeated 1000 times), then asks the formatter to build a completion message from a root task to a `/root/worker` sender path. The result is expected to exist because errored status is terminal.

The assertions verify two concrete properties of the formatted message. First, `approx_token_count(&message)` must be strictly less than `COMPLETION_MESSAGE_MAX_TOKENS`, proving that the formatter's `ERROR_MAX_TOKENS` reserve and envelope budgeting keep the final rendered message below the threshold. Second, the message must still contain `ERROR_NEXT_ACTION`, ensuring that truncation does not remove the remediation guidance appended for errored agents. This test protects against future changes that might accidentally let large error payloads exceed review limits or omit the instruction telling the parent agent how to proceed.

#### Function details

##### `error_completion_message_stays_below_manual_review_threshold`  (lines 10–20)

```
fn error_completion_message_stays_below_manual_review_threshold()
```

**Purpose**: Checks that formatting a very large errored-agent completion message still produces a bounded message under the configured token cap and retains the fixed next-action guidance. It is a regression test for truncation-envelope math.

**Data flow**: The test constructs root and worker `AgentPath` values, creates `AgentStatus::Errored` with a repeated long string, calls `format_inter_agent_completion_message`, unwraps the `Some` result, computes `approx_token_count(&message)`, and asserts that the count is below `COMPLETION_MESSAGE_MAX_TOKENS` and that the message contains `ERROR_NEXT_ACTION`.

**Call relations**: This test directly exercises `format_inter_agent_completion_message` with an oversized error payload to validate the truncation behavior defined in `session_prefix.rs`.

*Call graph*: calls 2 internal fn (root, try_from); 3 external calls (assert!, Errored, format_inter_agent_completion_message).


### Transcript and context shaping
These files verify how history, context, events, metadata, and compaction are transformed into the runtime transcript and prompt-visible state.

### `core/src/compact_tests.rs`

`test` · `test execution`

This test module covers the helper logic shared across local and remote compaction. It includes small fixture builders for user messages and `CompactedUserMessage`, plus `process_compacted_history_with_test_session`, which creates a real test session/context, optionally seeds previous-turn settings, computes canonical initial context, and runs the shared remote post-processor with `InitialContextInjection::BeforeLastUserMessage`.

The tests validate several important invariants. `content_items_to_text` must join non-empty text segments and ignore image-only content. `collect_user_messages` must keep only real user text while filtering assistant items, session-prefix wrappers such as AGENTS/environment context, and legacy warning messages. `build_compacted_history_with_limit` must truncate oversized retained user messages under a token budget, append the summary as the final user message, and preserve per-message metadata like `turn_id`.

The remote-history processing tests are especially concrete: stale developer messages from remote output are dropped and replaced by freshly built canonical initial context; non-user wrapper content and legacy warnings are removed; model-switch messages from previous-turn settings are reintroduced through initial context; and context insertion must happen before the last real user message while keeping summary or compaction items last. These tests effectively specify the installed transcript shape after compaction.

#### Function details

##### `process_compacted_history_with_test_session`  (lines 8–25)

```
async fn process_compacted_history_with_test_session(
    compacted_history: Vec<ResponseItem>,
    previous_turn_settings: Option<&PreviousTurnSettings>,
) -> (Vec<ResponseItem>, Vec<ResponseItem>)
```

**Purpose**: Creates a test session/context, runs shared remote compacted-history post-processing, and returns both the processed history and the canonical initial context used for comparison. It is the main async fixture helper for transcript-shaping tests.

**Data flow**: Takes a compacted-history vector and optional `PreviousTurnSettings` reference → creates `(session, turn_context)` via `make_session_and_context()` → stores cloned previous-turn settings into the session → builds initial context from the session/turn context → calls `crate::compact_remote::process_compacted_history(...)` with `InitialContextInjection::BeforeLastUserMessage` → returns `(processed_history, initial_context)`.

**Call relations**: Used by multiple async tests that validate how remote compacted history is sanitized and where canonical context is reinserted.

*Call graph*: calls 2 internal fn (process_compacted_history, make_session_and_context); called by 6 (process_compacted_history_drops_legacy_warnings, process_compacted_history_drops_non_user_content_messages, process_compacted_history_inserts_context_before_last_real_user_message_only, process_compacted_history_reinjects_full_initial_context, process_compacted_history_reinjects_model_switch_message, process_compacted_history_replaces_developer_messages).


##### `user_message`  (lines 27–37)

```
fn user_message(text: &str) -> ResponseItem
```

**Purpose**: Builds a simple user-role `ResponseItem::Message` fixture with one input-text content part. It reduces boilerplate in warning-filtering tests.

**Data flow**: Takes `&str` text → constructs and returns a `ResponseItem::Message` with role `user`, one `ContentItem::InputText`, and no id/phase/metadata.

**Call relations**: Used by tests that need concise user-message fixtures, especially legacy-warning filtering cases.

*Call graph*: called by 1 (process_compacted_history_drops_legacy_warnings); 1 external calls (vec!).


##### `compacted_user_message`  (lines 39–44)

```
fn compacted_user_message(text: &str) -> CompactedUserMessage
```

**Purpose**: Builds a `CompactedUserMessage` fixture with no metadata. It simplifies tests for compacted-history construction.

**Data flow**: Takes `&str` text → returns `CompactedUserMessage { message: text.to_string(), metadata: None }`.

**Call relations**: Used by the token-limited compacted-history truncation test.

*Call graph*: called by 1 (build_token_limited_compacted_history_truncates_overlong_user_messages).


##### `content_items_to_text_joins_non_empty_segments`  (lines 47–63)

```
fn content_items_to_text_joins_non_empty_segments()
```

**Purpose**: Verifies that textual content extraction joins non-empty input/output text segments with newlines and ignores empty text segments.

**Data flow**: Builds a content vector containing non-empty input text, empty output text, and non-empty output text → calls `content_items_to_text` → asserts the result is `Some("hello\nworld")`.

**Call relations**: Tests the positive text-joining behavior of the helper in `compact.rs`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `content_items_to_text_ignores_image_only_content`  (lines 66–75)

```
fn content_items_to_text_ignores_image_only_content()
```

**Purpose**: Verifies that image-only content yields no extracted text. This prevents image placeholders from being treated as textual transcript content.

**Data flow**: Builds a content vector containing only `InputImage` → calls `content_items_to_text` → asserts the result is `None`.

**Call relations**: Tests the image-ignoring branch of the text extraction helper.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `collect_user_messages_extracts_user_text_only`  (lines 78–104)

```
fn collect_user_messages_extracts_user_text_only()
```

**Purpose**: Verifies that user-message collection keeps only real user messages and ignores assistant items and unrelated variants. It checks the basic extraction path.

**Data flow**: Builds a mixed item list with an assistant message, a user message, and `ResponseItem::Other` → calls `collect_user_messages` → asserts the result contains only one `CompactedUserMessage("first")`.

**Call relations**: Tests the core filtering behavior of `collect_user_messages`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `collect_user_messages_filters_session_prefix_entries`  (lines 107–146)

```
fn collect_user_messages_filters_session_prefix_entries()
```

**Purpose**: Verifies that session-prefix wrapper messages such as AGENTS instructions and environment context are excluded from retained user messages. Only real user-authored content should survive compaction retention.

**Data flow**: Builds three user-role messages containing AGENTS instructions, environment context, and a real user message → calls `collect_user_messages` → asserts only the real user message is retained.

**Call relations**: Exercises the interaction between `collect_user_messages` and turn-item parsing that classifies wrapper content as non-user-message items.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `collect_user_messages_filters_legacy_warnings`  (lines 149–166)

```
fn collect_user_messages_filters_legacy_warnings()
```

**Purpose**: Verifies that legacy warning messages encoded as user-role messages are filtered out during retained-user extraction. This prevents warnings from polluting compacted history.

**Data flow**: Builds several warning-shaped user messages plus one real user message → calls `collect_user_messages` → asserts only the real user message remains.

**Call relations**: Tests warning filtering in the user-message extraction path.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `build_token_limited_compacted_history_truncates_overlong_user_messages`  (lines 169–209)

```
fn build_token_limited_compacted_history_truncates_overlong_user_messages()
```

**Purpose**: Verifies that token-limited compacted-history construction truncates oversized retained user content and still appends the summary. It uses a small budget to make truncation deterministic and fast.

**Data flow**: Creates one very large `CompactedUserMessage`, calls `build_compacted_history_with_limit` with a small token budget and summary text, inspects the first returned message’s text via `content_items_to_text`, and asserts it contains a truncation marker rather than the full original text; then inspects the second message and asserts it equals `SUMMARY`.

**Call relations**: Directly tests the internal token-budgeted history builder used by `build_compacted_history`.

*Call graph*: calls 1 internal fn (compacted_user_message); 6 external calls (new, assert!, assert_eq!, panic!, from_ref, build_compacted_history_with_limit).


##### `build_token_limited_compacted_history_appends_summary_message`  (lines 212–231)

```
fn build_token_limited_compacted_history_appends_summary_message()
```

**Purpose**: Verifies that compacted-history construction always ends with the summary message. This locks in the invariant that the summary is the final user-role item.

**Data flow**: Builds one retained user message and summary text → calls `build_compacted_history` → inspects the last history item’s text and asserts it equals the provided summary.

**Call relations**: Tests the final-summary append behavior of the public compacted-history builder.

*Call graph*: 5 external calls (new, assert!, assert_eq!, panic!, vec!).


##### `build_compacted_history_preserves_user_message_metadata`  (lines 234–248)

```
fn build_compacted_history_preserves_user_message_metadata()
```

**Purpose**: Verifies that retained user-message metadata survives compaction-history rebuilding while the synthetic summary message has no inherited metadata. This matters for preserving turn IDs and similar annotations.

**Data flow**: Builds compacted history from one `CompactedUserMessage` carrying `ResponseItemMetadata { turn_id: Some("turn-1") }` and a summary → asserts `history[0].turn_id()` is `Some("turn-1")` and `history[1].turn_id()` is `None`.

**Call relations**: Tests metadata propagation in `build_compacted_history`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `should_use_remote_compact_task_for_azure_provider`  (lines 251–273)

```
fn should_use_remote_compact_task_for_azure_provider()
```

**Purpose**: Verifies that an Azure-style provider configuration is recognized as supporting remote compaction. It locks in provider-capability policy for at least one concrete provider shape.

**Data flow**: Constructs a `ModelProviderInfo` representing Azure/OpenAI Responses → calls `should_use_remote_compact_task` → asserts the result is true.

**Call relations**: Tests the provider-capability wrapper in `compact.rs`.

*Call graph*: 1 external calls (assert!).


##### `process_compacted_history_replaces_developer_messages`  (lines 275–320)

```
async fn process_compacted_history_replaces_developer_messages()
```

**Purpose**: Verifies that stale developer messages from remote compacted history are dropped and replaced by freshly built canonical initial context. The summary user message should remain after that context.

**Data flow**: Builds compacted history containing developer/user/developer messages → runs `process_compacted_history_with_test_session` → appends the expected summary user message to the returned initial context and asserts the processed history matches.

**Call relations**: Tests `compact_remote::process_compacted_history` filtering plus canonical context reinjection.

*Call graph*: calls 1 internal fn (process_compacted_history_with_test_session); 2 external calls (assert_eq!, vec!).


##### `process_compacted_history_reinjects_full_initial_context`  (lines 323–348)

```
async fn process_compacted_history_reinjects_full_initial_context()
```

**Purpose**: Verifies that when remote compacted history contains only a summary, the full canonical initial context is reinserted ahead of it. This ensures the next turn sees the expected context prefix.

**Data flow**: Builds compacted history with one summary user message → runs `process_compacted_history_with_test_session` → appends the summary to the returned initial context and asserts equality with the processed history.

**Call relations**: Tests the simplest positive reinjection path of `process_compacted_history`.

*Call graph*: calls 1 internal fn (process_compacted_history_with_test_session); 2 external calls (assert_eq!, vec!).


##### `process_compacted_history_drops_non_user_content_messages`  (lines 351–427)

```
async fn process_compacted_history_drops_non_user_content_messages()
```

**Purpose**: Verifies that non-user-content wrapper messages and stale developer instructions are removed from remote compacted history before canonical context is reinserted. Only the real summary should remain after filtering.

**Data flow**: Builds compacted history containing AGENTS instructions, environment context, turn-aborted wrapper, summary, and stale developer message → runs `process_compacted_history_with_test_session` → appends the summary to the returned initial context and asserts the processed history matches.

**Call relations**: Tests the filtering rules encoded by `should_keep_compacted_history_item` and turn-item parsing.

*Call graph*: calls 1 internal fn (process_compacted_history_with_test_session); 2 external calls (assert_eq!, vec!).


##### `process_compacted_history_drops_legacy_warnings`  (lines 430–452)

```
async fn process_compacted_history_drops_legacy_warnings()
```

**Purpose**: Verifies that legacy warning messages are removed from remote compacted history while the latest real user message is preserved. This prevents warning noise from surviving compaction installation.

**Data flow**: Builds compacted history from three warning-shaped user messages plus one latest user message → runs `process_compacted_history_with_test_session` → appends the latest user message to the returned initial context and asserts equality.

**Call relations**: Tests warning filtering in the shared remote post-processing path.

*Call graph*: calls 2 internal fn (process_compacted_history_with_test_session, user_message); 2 external calls (assert_eq!, vec!).


##### `process_compacted_history_inserts_context_before_last_real_user_message_only`  (lines 455–522)

```
async fn process_compacted_history_inserts_context_before_last_real_user_message_only()
```

**Purpose**: Verifies that canonical initial context is inserted before the last real user message, not before an earlier summary-like user message. This preserves the model-expected ordering for mid-turn compaction.

**Data flow**: Builds compacted history with an older user message, a summary-prefixed user message, and a latest user message → runs `process_compacted_history_with_test_session` → constructs the expected sequence as older user, summary, initial context, latest user → asserts equality.

**Call relations**: Tests the insertion-point priority implemented by `insert_initial_context_before_last_real_user_or_summary`.

*Call graph*: calls 1 internal fn (process_compacted_history_with_test_session); 2 external calls (assert_eq!, vec!).


##### `process_compacted_history_reinjects_model_switch_message`  (lines 525–567)

```
async fn process_compacted_history_reinjects_model_switch_message()
```

**Purpose**: Verifies that previous-turn settings cause the rebuilt canonical initial context to include a model-switch developer message, and that this context is reinserted ahead of the summary. It ensures model-switch state survives compaction.

**Data flow**: Builds compacted history with one summary user message and seeds `PreviousTurnSettings` with a prior model → runs `process_compacted_history_with_test_session` → inspects the first initial-context message to confirm it is a developer message containing `<model_switch>` → appends the summary and asserts the processed history matches.

**Call relations**: Tests the interaction between session-built initial context and remote compacted-history post-processing.

*Call graph*: calls 1 internal fn (process_compacted_history_with_test_session); 4 external calls (assert!, assert_eq!, panic!, vec!).


##### `insert_initial_context_before_last_real_user_or_summary_keeps_summary_last`  (lines 570–651)

```
fn insert_initial_context_before_last_real_user_or_summary_keeps_summary_last()
```

**Purpose**: Verifies that inserting canonical context into compacted history preserves the summary as the final item. Context should be placed before the last real user message when a summary is already last.

**Data flow**: Builds compacted history with older user, latest user, and summary-prefixed user messages plus one developer initial-context item → calls `insert_initial_context_before_last_real_user_or_summary` → asserts the result is older user, developer context, latest user, summary.

**Call relations**: Directly tests the insertion helper’s summary-preserving branch.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `insert_initial_context_before_last_real_user_or_summary_keeps_compaction_last`  (lines 654–687)

```
fn insert_initial_context_before_last_real_user_or_summary_keeps_compaction_last()
```

**Purpose**: Verifies that when compacted history ends with a compaction item and has no user messages, inserted initial context goes before that compaction item. This preserves the compaction marker as the final item.

**Data flow**: Builds compacted history containing only `ResponseItem::Compaction` plus one developer initial-context item → calls `insert_initial_context_before_last_real_user_or_summary` → asserts the result is developer context followed by the compaction item.

**Call relations**: Directly tests the insertion helper’s compaction-item fallback branch.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/context_manager/history_tests.rs`

`test` · `test`

This test module builds a large matrix of transcript scenarios around `ContextManager`. It starts with fixture constructors for assistant, user, developer, reasoning, custom-tool-output, and inter-agent assistant messages, plus a reusable `create_history_with_items` helper that records items under a generous token truncation policy. Those fixtures are then used to verify filtering (`system` and `Other` are dropped), prompt normalization (missing outputs inserted, orphan outputs removed, local shell outputs retained), and rollback semantics that distinguish session-prefix contextual user fragments from real user turns.

Several tests focus on image behavior. They confirm that `for_prompt` replaces `InputImage` content with the exact omission placeholder when image input is unsupported, preserves images otherwise, clears `ImageGenerationCall.result` when necessary, and rewrites only tool-output images in `replace_last_turn_images`. Another cluster validates token estimation heuristics: encrypted reasoning before the last user turn, local items after the last model-generated item, base64 image payload discounting, encrypted function output replacement sizing, and patch-based estimates for `ImageDetail::Original` images including cache-friendly repeated logic and patch-count capping.

The file also checks truncation markers emitted by `truncate_text`, using regex-based assertions to verify retained body size and removed-token counts. Debug-vs-release normalization behavior is covered explicitly: some malformed histories panic in debug builds but are repaired or pruned in non-debug builds.

#### Function details

##### `assistant_msg`  (lines 37–47)

```
fn assistant_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a minimal assistant `ResponseItem::Message` fixture containing one `OutputText` item.

**Data flow**: Takes `text: &str`, wraps it in `ContentItem::OutputText`, and returns a `ResponseItem::Message` with role `assistant` and empty optional metadata fields.

**Call relations**: Used across many tests as the canonical assistant reply fixture.

*Call graph*: called by 3 (drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns, filters_non_api_messages, legacy_inter_agent_assistant_messages_are_not_turn_boundaries); 1 external calls (vec!).


##### `inter_agent_assistant_msg`  (lines 49–66)

```
fn inter_agent_assistant_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds an assistant message whose text payload is serialized `InterAgentCommunication`, representing a structured inter-agent instruction turn.

**Data flow**: Creates an `InterAgentCommunication` from root to `/worker`, serializes it with `serde_json::to_string`, wraps that string in `ContentItem::OutputText`, and returns an assistant `ResponseItem::Message`.

**Call relations**: Used by tests that verify inter-agent assistant messages are treated as turn boundaries and preserved in prompts.

*Call graph*: calls 2 internal fn (root, new); called by 3 (drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns, for_prompt_preserves_inter_agent_assistant_messages, inter_agent_assistant_messages_are_turn_boundaries); 2 external calls (new, vec!).


##### `create_history_with_items`  (lines 68–74)

```
fn create_history_with_items(items: Vec<ResponseItem>) -> ContextManager
```

**Purpose**: Creates a `ContextManager`, records a supplied item list into it, and returns the populated history.

**Data flow**: Takes `Vec<ResponseItem>`, constructs `ContextManager::new()`, records `items.iter()` with `TruncationPolicy::Tokens(10_000)`, and returns the manager.

**Call relations**: This is the main fixture factory used by most tests in the file.

*Call graph*: calls 1 internal fn (new); called by 38 (drop_last_n_user_turns_clears_reference_context_for_mixed_developer_context_bundles, drop_last_n_user_turns_ignores_session_prefix_user_messages, drop_last_n_user_turns_preserves_prefix, drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns, drop_last_n_user_turns_trims_context_updates_above_rolled_back_turn, estimate_token_count_with_base_instructions_uses_provided_text, for_prompt_clears_image_generation_result_when_images_are_unsupported, for_prompt_preserves_image_generation_calls_when_images_are_supported, for_prompt_preserves_inter_agent_assistant_messages, for_prompt_strips_images_when_model_does_not_support_images (+15 more)); 1 external calls (Tokens).


##### `user_msg`  (lines 76–86)

```
fn user_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a user message fixture using `OutputText` content.

**Data flow**: Wraps the provided text in `ContentItem::OutputText` and returns a `ResponseItem::Message` with role `user`.

**Call relations**: Used in tests that focus on generic user-turn behavior rather than contextual input fragments.

*Call graph*: called by 3 (filters_non_api_messages, items_after_last_model_generated_tokens_include_user_and_tool_output, total_token_usage_includes_all_items_after_last_model_generated_item); 1 external calls (vec!).


##### `user_input_text_msg`  (lines 88–98)

```
fn user_input_text_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a user message fixture using `InputText` content.

**Data flow**: Wraps the provided text in `ContentItem::InputText` and returns a `ResponseItem::Message` with role `user`.

**Call relations**: Used where tests need content to be interpreted as model input, especially contextual-fragment and rollback cases.

*Call graph*: called by 1 (drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns); 1 external calls (vec!).


##### `developer_msg`  (lines 100–110)

```
fn developer_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a developer message fixture with a single `InputText` fragment.

**Data flow**: Creates `ResponseItem::Message { role: "developer", content: vec![InputText{text}] }`.

**Call relations**: Supports rollback and contextual developer-message tests.

*Call graph*: 1 external calls (vec!).


##### `developer_msg_with_fragments`  (lines 112–125)

```
fn developer_msg_with_fragments(texts: &[&str]) -> ResponseItem
```

**Purpose**: Builds a developer message fixture containing multiple `InputText` fragments.

**Data flow**: Maps each `&str` in `texts` into `ContentItem::InputText` and collects them into a developer `ResponseItem::Message`.

**Call relations**: Used to simulate mixed contextual and persistent developer bundles.


##### `reference_context_item`  (lines 127–148)

```
fn reference_context_item() -> TurnContextItem
```

**Purpose**: Constructs a representative `TurnContextItem` baseline for rollback/reference-context tests.

**Data flow**: Returns a fully populated `TurnContextItem` with fixed cwd, date, timezone, approval policy, read-only sandbox policy, model slug, and other optional fields.

**Call relations**: Used by tests that verify whether rollback preserves or clears `reference_context_item`.

*Call graph*: called by 2 (drop_last_n_user_turns_clears_reference_context_for_mixed_developer_context_bundles, drop_last_n_user_turns_trims_context_updates_above_rolled_back_turn); 2 external calls (from, new_read_only_policy).


##### `custom_tool_call_output`  (lines 150–157)

```
fn custom_tool_call_output(call_id: &str, output: &str) -> ResponseItem
```

**Purpose**: Builds a `CustomToolCallOutput` fixture with plain-text output.

**Data flow**: Takes `call_id` and `output`, converts the text via `FunctionCallOutputPayload::from_text`, and returns `ResponseItem::CustomToolCallOutput`.

**Call relations**: Used in token-accounting tests for local tool-output tails.

*Call graph*: calls 1 internal fn (from_text); called by 2 (items_after_last_model_generated_tokens_include_user_and_tool_output, total_token_usage_includes_all_items_after_last_model_generated_item).


##### `reasoning_msg`  (lines 159–171)

```
fn reasoning_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a reasoning item fixture with visible reasoning text and summary.

**Data flow**: Returns `ResponseItem::Reasoning` with empty id, one summary entry, one `ReasoningText` content entry, no encrypted content, and no metadata.

**Call relations**: Used in filtering tests to confirm reasoning items are retained as API messages.

*Call graph*: called by 1 (filters_non_api_messages); 2 external calls (new, vec!).


##### `reasoning_with_encrypted_content`  (lines 173–183)

```
fn reasoning_with_encrypted_content(len: usize) -> ResponseItem
```

**Purpose**: Builds a reasoning item fixture whose payload is only encrypted content of a requested length.

**Data flow**: Creates `ResponseItem::Reasoning` with `encrypted_content: Some("a".repeat(len))`, a summary, and no visible content.

**Call relations**: Used by token-estimation tests for encrypted reasoning heuristics.

*Call graph*: 2 external calls (new, vec!).


##### `truncate_exec_output`  (lines 185–187)

```
fn truncate_exec_output(content: &str) -> String
```

**Purpose**: Applies the same token-based truncation helper used for exec-output formatting tests.

**Data flow**: Passes `content` to `truncate_text` with `TruncationPolicy::Tokens(EXEC_FORMAT_MAX_TOKENS)` and returns the truncated string.

**Call relations**: Used by the exec-output formatting tests below.

*Call graph*: called by 4 (format_exec_output_marks_byte_truncation_without_omitted_lines, format_exec_output_prefers_line_marker_when_both_limits_exceeded, format_exec_output_reports_omitted_lines_and_keeps_head_and_tail, format_exec_output_truncates_large_error); 2 external calls (truncate_text, Tokens).


##### `approx_token_count_for_text`  (lines 189–191)

```
fn approx_token_count_for_text(text: &str) -> i64
```

**Purpose**: Implements the same simple 4-bytes-per-token heuristic expected by token-estimation assertions.

**Data flow**: Computes `(text.len() + 3) / 4`, converts to `i64`, and returns it.

**Call relations**: Used to derive expected deltas in base-instructions token-estimation tests.

*Call graph*: called by 1 (estimate_token_count_with_base_instructions_uses_provided_text); 1 external calls (try_from).


##### `filters_non_api_messages`  (lines 194–250)

```
fn filters_non_api_messages()
```

**Purpose**: Verifies that `record_items` drops system and `Other` items while retaining reasoning, user, and assistant messages.

**Data flow**: Builds a default history, records a system message, reasoning item, and `Other`, then records user and assistant messages and asserts the final raw history equals only the retained items.

**Call relations**: Exercises `ContextManager::record_items` and `is_api_message` behavior.

*Call graph*: calls 3 internal fn (assistant_msg, reasoning_msg, user_msg); 4 external calls (assert_eq!, default, Tokens, vec!).


##### `non_last_reasoning_tokens_return_zero_when_no_user_messages`  (lines 253–258)

```
fn non_last_reasoning_tokens_return_zero_when_no_user_messages()
```

**Purpose**: Checks that encrypted reasoning tokens are ignored when there is no user-turn boundary.

**Data flow**: Creates history with one encrypted reasoning item and asserts `get_non_last_reasoning_items_tokens()` returns `0`.

**Call relations**: Targets the early-return branch in `ContextManager::get_non_last_reasoning_items_tokens`.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `non_last_reasoning_tokens_ignore_entries_after_last_user`  (lines 261–273)

```
fn non_last_reasoning_tokens_ignore_entries_after_last_user()
```

**Purpose**: Verifies that only encrypted reasoning before the last user boundary contributes to the non-last reasoning estimate.

**Data flow**: Builds a mixed history of reasoning and user messages, computes the method result, and compares it to the expected heuristic total.

**Call relations**: Exercises the boundary logic inside `get_non_last_reasoning_items_tokens`.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `items_after_last_model_generated_tokens_include_user_and_tool_output`  (lines 276–294)

```
fn items_after_last_model_generated_tokens_include_user_and_tool_output()
```

**Purpose**: Confirms that the post-model suffix includes both a later user message and a later custom tool output.

**Data flow**: Creates history ending with user and tool-output items after an assistant message, sums `estimate_item_token_count` over the returned suffix, and compares it to the expected sum.

**Call relations**: Validates `items_after_last_model_generated_item` and downstream token summation.

*Call graph*: calls 3 internal fn (create_history_with_items, custom_tool_call_output, user_msg); 2 external calls (assert_eq!, vec!).


##### `items_after_last_model_generated_tokens_are_zero_without_model_generated_items`  (lines 297–308)

```
fn items_after_last_model_generated_tokens_are_zero_without_model_generated_items()
```

**Purpose**: Checks that no suffix is counted when history contains no model-generated item at all.

**Data flow**: Creates history with only a user message and asserts the summed token estimate over the returned suffix is `0`.

**Call relations**: Covers the empty-suffix branch of `items_after_last_model_generated_item`.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `inter_agent_assistant_messages_are_turn_boundaries`  (lines 311–315)

```
fn inter_agent_assistant_messages_are_turn_boundaries()
```

**Purpose**: Verifies that structured inter-agent assistant messages count as rollback turn boundaries.

**Data flow**: Builds an inter-agent assistant message and asserts `is_user_turn_boundary(&item)` is true.

**Call relations**: Directly tests the assistant/inter-agent branch in `is_user_turn_boundary`.

*Call graph*: calls 1 internal fn (inter_agent_assistant_msg); 1 external calls (assert!).


##### `for_prompt_preserves_inter_agent_assistant_messages`  (lines 318–324)

```
fn for_prompt_preserves_inter_agent_assistant_messages()
```

**Purpose**: Ensures prompt normalization does not strip or rewrite inter-agent assistant messages.

**Data flow**: Creates history with one inter-agent assistant message, checks raw items, then consumes history with `for_prompt` and asserts the same item is returned.

**Call relations**: Confirms normalization leaves this message type intact.

*Call graph*: calls 2 internal fn (create_history_with_items, inter_agent_assistant_msg); 2 external calls (assert_eq!, vec!).


##### `drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns`  (lines 327–342)

```
fn drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns()
```

**Purpose**: Checks rollback semantics when the latest instruction turn is an assistant inter-agent message rather than a user message.

**Data flow**: Builds two turns where the second begins with an inter-agent assistant message, rolls back one turn, and asserts only the first turn remains.

**Call relations**: Exercises `drop_last_n_user_turns` together with `is_user_turn_boundary`'s inter-agent logic.

*Call graph*: calls 4 internal fn (assistant_msg, create_history_with_items, inter_agent_assistant_msg, user_input_text_msg); 2 external calls (assert_eq!, vec!).


##### `legacy_inter_agent_assistant_messages_are_not_turn_boundaries`  (lines 345–351)

```
fn legacy_inter_agent_assistant_messages_are_not_turn_boundaries()
```

**Purpose**: Verifies that old plain-text assistant messages resembling inter-agent instructions are not treated as structured boundaries.

**Data flow**: Builds a normal assistant text message with legacy formatting and asserts `is_user_turn_boundary` is false.

**Call relations**: Protects backward compatibility by distinguishing structured JSON content from legacy text.

*Call graph*: calls 1 internal fn (assistant_msg); 1 external calls (assert!).


##### `total_token_usage_includes_all_items_after_last_model_generated_item`  (lines 354–375)

```
fn total_token_usage_includes_all_items_after_last_model_generated_item()
```

**Purpose**: Checks that total token usage adds local suffix estimates on top of the last server-reported total.

**Data flow**: Creates history with an assistant message, updates token info to `100`, records a user message and custom tool output, then asserts `get_total_token_usage(true)` equals `100 + estimated tail`.

**Call relations**: Exercises `update_token_info`, `record_items`, and `get_total_token_usage` together.

*Call graph*: calls 3 internal fn (create_history_with_items, custom_tool_call_output, user_msg); 4 external calls (default, assert_eq!, Tokens, vec!).


##### `for_prompt_strips_images_when_model_does_not_support_images`  (lines 378–536)

```
fn for_prompt_strips_images_when_model_does_not_support_images()
```

**Purpose**: Verifies that prompt normalization replaces message/tool-output images with omission text when only text modality is allowed, while preserving them when image modality is present.

**Data flow**: Builds a history containing user images, function call/output images, and custom tool output images; runs `for_prompt(&[InputModality::Text])` and compares against an expected fully rewritten transcript, then separately checks that image-supporting modalities preserve images.

**Call relations**: Exercises `normalize_history` and specifically `strip_images_when_unsupported` across multiple item variants.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 4 external calls (assert!, assert_eq!, panic!, vec!).


##### `for_prompt_preserves_image_generation_calls_when_images_are_supported`  (lines 539–580)

```
fn for_prompt_preserves_image_generation_calls_when_images_are_supported()
```

**Purpose**: Checks that `ImageGenerationCall` items survive prompt normalization unchanged when image input is supported.

**Data flow**: Creates history with an image-generation call and a user message, runs `for_prompt(default_input_modalities())`, and asserts exact equality.

**Call relations**: Covers the no-op branch for image generation under image-capable models.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `for_prompt_clears_image_generation_result_when_images_are_unsupported`  (lines 583–624)

```
fn for_prompt_clears_image_generation_result_when_images_are_unsupported()
```

**Purpose**: Checks that prompt normalization clears the binary result field of image-generation calls for text-only models.

**Data flow**: Creates history with a user request and completed `ImageGenerationCall`, runs `for_prompt(&[InputModality::Text])`, and asserts the returned call has `result: String::new()`.

**Call relations**: Targets the `ImageGenerationCall` branch in `strip_images_when_unsupported`.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `estimate_token_count_with_base_instructions_uses_provided_text`  (lines 627–646)

```
fn estimate_token_count_with_base_instructions_uses_provided_text()
```

**Purpose**: Verifies that token estimation changes exactly with the supplied base-instructions text length.

**Data flow**: Creates history with one assistant message, computes estimates for short and long `BaseInstructions`, derives the expected delta with `approx_token_count_for_text`, and asserts the estimate difference matches.

**Call relations**: Exercises `estimate_token_count_with_base_instructions` independently of `TurnContext`.

*Call graph*: calls 2 internal fn (approx_token_count_for_text, create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `remove_first_item_removes_matching_output_for_function_call`  (lines 649–668)

```
fn remove_first_item_removes_matching_output_for_function_call()
```

**Purpose**: Checks that removing an oldest function call also removes its paired output.

**Data flow**: Creates history with a `FunctionCall` followed by matching `FunctionCallOutput`, calls `remove_first_item`, and asserts history becomes empty.

**Call relations**: Tests `remove_first_item` plus `normalize::remove_corresponding_for` for call-first ordering.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `remove_first_item_removes_matching_call_for_output`  (lines 671–690)

```
fn remove_first_item_removes_matching_call_for_output()
```

**Purpose**: Checks that removing an oldest function output also removes its paired call.

**Data flow**: Creates history with output first and call second, removes the first item, and asserts history becomes empty.

**Call relations**: Covers the output-first branch in `remove_corresponding_for`.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `replace_last_turn_images_replaces_tool_output_images`  (lines 693–732)

```
fn replace_last_turn_images_replaces_tool_output_images()
```

**Purpose**: Verifies that `replace_last_turn_images` rewrites only tool-output images in the latest turn to placeholder text.

**Data flow**: Creates history with a user message and a `FunctionCallOutput` containing `InputImage`, calls `replace_last_turn_images("Invalid image")`, and asserts the output content item becomes `InputText` with that placeholder.

**Call relations**: Exercises the successful mutation path in `replace_last_turn_images`.

*Call graph*: calls 1 internal fn (create_history_with_items); 3 external calls (assert!, assert_eq!, vec!).


##### `replace_last_turn_images_does_not_touch_user_images`  (lines 735–750)

```
fn replace_last_turn_images_does_not_touch_user_images()
```

**Purpose**: Checks that `replace_last_turn_images` does nothing when the latest turn boundary is a user message containing images.

**Data flow**: Creates history with a user image message, calls `replace_last_turn_images`, asserts it returns false, and confirms history is unchanged.

**Call relations**: Covers the branch where the located boundary is a `Message` rather than a tool output.

*Call graph*: calls 1 internal fn (create_history_with_items); 3 external calls (assert!, assert_eq!, vec!).


##### `remove_first_item_handles_local_shell_pair`  (lines 753–777)

```
fn remove_first_item_handles_local_shell_pair()
```

**Purpose**: Verifies paired removal for a `LocalShellCall` and its corresponding `FunctionCallOutput`.

**Data flow**: Creates history with a completed local shell call and matching output, removes the first item, and asserts the transcript is empty.

**Call relations**: Tests the local-shell-specific pairing logic in `remove_corresponding_for`.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `drop_last_n_user_turns_preserves_prefix`  (lines 780–813)

```
fn drop_last_n_user_turns_preserves_prefix()
```

**Purpose**: Checks that rollback removes only requested turns and preserves items before the first real user turn.

**Data flow**: Builds histories with a session-prefix assistant item and two user turns, rolls back one turn and then many turns, and compares `for_prompt` output to expected retained prefixes.

**Call relations**: Exercises the cut-index logic in `drop_last_n_user_turns`.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `drop_last_n_user_turns_ignores_session_prefix_user_messages`  (lines 816–913)

```
fn drop_last_n_user_turns_ignores_session_prefix_user_messages()
```

**Purpose**: Verifies that contextual user-prefix messages such as environment context, AGENTS instructions, skills, shell commands, and subagent notifications are not counted as rollback turns.

**Data flow**: Builds histories with several contextual user messages before real turns, performs rollback with different counts, and asserts only real turns are removed while contextual prefix items remain.

**Call relations**: Tests the interaction between `is_contextual_user_message_content`, `is_user_turn_boundary`, and rollback slicing.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `drop_last_n_user_turns_trims_context_updates_above_rolled_back_turn`  (lines 916–951)

```
fn drop_last_n_user_turns_trims_context_updates_above_rolled_back_turn()
```

**Purpose**: Checks that rollback also removes contiguous contextual developer/user updates immediately above the removed turn while preserving unrelated persistent developer text.

**Data flow**: Creates a history with turn 1, a persistent developer message, contextual developer and user updates, and turn 2; sets a reference context item; rolls back one turn; then asserts the contextual updates are gone but the persistent developer message and reference context remain.

**Call relations**: Exercises `trim_pre_turn_context_updates` without triggering baseline invalidation.

*Call graph*: calls 3 internal fn (create_history_with_items, reference_context_item, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `drop_last_n_user_turns_clears_reference_context_for_mixed_developer_context_bundles`  (lines 954–982)

```
fn drop_last_n_user_turns_clears_reference_context_for_mixed_developer_context_bundles()
```

**Purpose**: Verifies that trimming a mixed contextual/non-contextual developer bundle clears the stored reference context baseline.

**Data flow**: Builds history with turn 1, a mixed-fragment developer message, contextual user diff, and turn 2; sets a reference context item; rolls back one turn; asserts only turn 1 remains and `reference_context_item()` is `None`.

**Call relations**: Targets the branch in `trim_pre_turn_context_updates` that invalidates stale diff baselines.

*Call graph*: calls 3 internal fn (create_history_with_items, reference_context_item, default_input_modalities); 3 external calls (assert!, assert_eq!, vec!).


##### `remove_first_item_handles_custom_tool_pair`  (lines 985–1005)

```
fn remove_first_item_handles_custom_tool_pair()
```

**Purpose**: Verifies paired removal for a custom tool call and its output.

**Data flow**: Creates history with `CustomToolCall` and matching `CustomToolCallOutput`, removes the first item, and asserts the transcript is empty.

**Call relations**: Covers custom-tool pairing in `remove_corresponding_for`.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `normalization_retains_local_shell_outputs`  (lines 1008–1034)

```
fn normalization_retains_local_shell_outputs()
```

**Purpose**: Checks that normalization does not remove valid local shell outputs paired with local shell calls.

**Data flow**: Creates a local shell call plus matching `FunctionCallOutput`, runs `for_prompt`, and asserts the normalized history equals the original items.

**Call relations**: Confirms local shell outputs are treated as legitimate function outputs during normalization.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `record_items_truncates_function_call_output_content`  (lines 1037–1074)

```
fn record_items_truncates_function_call_output_content()
```

**Purpose**: Verifies that oversized plain-text function outputs are truncated during ingestion and retain metadata.

**Data flow**: Creates a long `FunctionCallOutput` text body with metadata, records it under a small token budget, then asserts the stored output differs from the original, contains a truncation marker, and preserves the turn id.

**Call relations**: Exercises `record_items`, `process_item`, and `truncate_function_output_payload` for standard function outputs.

*Call graph*: calls 1 internal fn (new); 6 external calls (assert!, assert_eq!, assert_ne!, panic!, Text, Tokens).


##### `record_items_truncates_custom_tool_call_output_content`  (lines 1077–1107)

```
fn record_items_truncates_custom_tool_call_output_content()
```

**Purpose**: Verifies that oversized custom tool outputs are truncated during ingestion.

**Data flow**: Creates a long `CustomToolCallOutput`, records it, and asserts the stored text differs from the original and contains a truncation marker.

**Call relations**: Covers the custom-tool branch in `process_item`.

*Call graph*: calls 2 internal fn (new, from_text); 5 external calls (assert!, assert_eq!, assert_ne!, panic!, Tokens).


##### `record_items_respects_custom_token_limit`  (lines 1110–1134)

```
fn record_items_respects_custom_token_limit()
```

**Purpose**: Checks that a very small caller-supplied token budget is honored during output truncation.

**Data flow**: Creates a long function output, records it with `TruncationPolicy::Tokens(10)`, extracts the stored output, and asserts it contains the truncation marker.

**Call relations**: Confirms `record_items` uses the provided policy rather than a fixed internal limit.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, panic!, Text, Tokens).


##### `assert_truncated_message_matches`  (lines 1136–1160)

```
fn assert_truncated_message_matches(message: &str, line: &str, expected_removed: usize)
```

**Purpose**: Asserts that a truncated exec-output string matches the expected regex shape, retained-body size, and removed-token count.

**Data flow**: Builds a regex from `truncated_message_pattern(line)`, matches it against `message`, extracts named captures `body` and `removed`, checks body byte length against `EXEC_FORMAT_MAX_BYTES`, parses `removed`, and compares it to `expected_removed`.

**Call relations**: Shared assertion helper for the exec-output truncation tests.

*Call graph*: calls 1 internal fn (truncated_message_pattern); called by 4 (format_exec_output_marks_byte_truncation_without_omitted_lines, format_exec_output_prefers_line_marker_when_both_limits_exceeded, format_exec_output_reports_omitted_lines_and_keeps_head_and_tail, format_exec_output_truncates_large_error); 3 external calls (new, assert!, assert_eq!).


##### `truncated_message_pattern`  (lines 1162–1165)

```
fn truncated_message_pattern(line: &str) -> String
```

**Purpose**: Builds the regex pattern used to validate truncation markers around a retained line prefix.

**Data flow**: Escapes the provided `line` with `regex_lite::escape` and interpolates it into a pattern containing named `body` and `removed` captures.

**Call relations**: Used only by `assert_truncated_message_matches`.

*Call graph*: called by 1 (assert_truncated_message_matches); 2 external calls (format!, escape).


##### `format_exec_output_truncates_large_error`  (lines 1168–1176)

```
fn format_exec_output_truncates_large_error()
```

**Purpose**: Checks truncation of a very large multi-line exec error string.

**Data flow**: Builds a repeated long line, truncates it with `truncate_exec_output`, validates the result with `assert_truncated_message_matches`, and asserts it differs from the original.

**Call relations**: Exercises line/token truncation behavior of `truncate_text` through the local helper.

*Call graph*: calls 2 internal fn (assert_truncated_message_matches, truncate_exec_output); 1 external calls (assert_ne!).


##### `format_exec_output_marks_byte_truncation_without_omitted_lines`  (lines 1179–1188)

```
fn format_exec_output_marks_byte_truncation_without_omitted_lines()
```

**Purpose**: Verifies truncation messaging when only byte limits are exceeded and no lines are omitted.

**Data flow**: Creates one extremely long line, truncates it, validates the marker and removed-token count, and asserts the output does not mention omitted lines.

**Call relations**: Covers a byte-limit-specific truncation shape.

*Call graph*: calls 2 internal fn (assert_truncated_message_matches, truncate_exec_output); 2 external calls (assert!, assert_ne!).


##### `format_exec_output_returns_original_when_within_limits`  (lines 1191–1194)

```
fn format_exec_output_returns_original_when_within_limits()
```

**Purpose**: Checks that small exec output is returned unchanged.

**Data flow**: Builds a short repeated string and asserts `truncate_exec_output(&content) == content`.

**Call relations**: Covers the no-truncation path.

*Call graph*: 1 external calls (assert_eq!).


##### `format_exec_output_reports_omitted_lines_and_keeps_head_and_tail`  (lines 1197–1216)

```
fn format_exec_output_reports_omitted_lines_and_keeps_head_and_tail()
```

**Purpose**: Verifies that line-based truncation preserves both the beginning and end of large multi-line output while reporting omitted content.

**Data flow**: Constructs 2,000 numbered lines, truncates them, validates the truncation marker, and asserts both the first and last line prefixes remain present.

**Call relations**: Exercises the line-preserving truncation strategy in `truncate_text`.

*Call graph*: calls 2 internal fn (assert_truncated_message_matches, truncate_exec_output); 2 external calls (assert!, format!).


##### `format_exec_output_prefers_line_marker_when_both_limits_exceeded`  (lines 1219–1229)

```
fn format_exec_output_prefers_line_marker_when_both_limits_exceeded()
```

**Purpose**: Checks that line-oriented truncation messaging wins when both line and byte limits are exceeded.

**Data flow**: Builds many long numbered lines, truncates them, and validates the resulting marker with `assert_truncated_message_matches`.

**Call relations**: Covers truncation precedence behavior.

*Call graph*: calls 2 internal fn (assert_truncated_message_matches, truncate_exec_output).


##### `normalize_adds_missing_output_for_function_call`  (lines 1233–1264)

```
fn normalize_adds_missing_output_for_function_call()
```

**Purpose**: In non-debug builds, verifies that normalization inserts a synthetic aborted output after a function call missing its output.

**Data flow**: Creates history with only a `FunctionCall`, runs `normalize_history`, and asserts a matching `FunctionCallOutput` with text `aborted` was inserted.

**Call relations**: Exercises release-mode repair behavior in `ensure_call_outputs_present`.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_adds_missing_output_for_custom_tool_call`  (lines 1268–1300)

```
fn normalize_adds_missing_output_for_custom_tool_call()
```

**Purpose**: In non-debug builds, verifies synthetic insertion of an aborted custom tool output.

**Data flow**: Creates history with only a `CustomToolCall`, normalizes it, and asserts a matching `CustomToolCallOutput` was inserted.

**Call relations**: Covers release-mode repair for missing custom tool outputs.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_adds_missing_output_for_local_shell_call_with_id`  (lines 1304–1345)

```
fn normalize_adds_missing_output_for_local_shell_call_with_id()
```

**Purpose**: In non-debug builds, verifies synthetic insertion of a `FunctionCallOutput` for a local shell call with a call id.

**Data flow**: Creates history with only a `LocalShellCall`, normalizes it, and asserts an aborted `FunctionCallOutput` was inserted after it.

**Call relations**: Tests local-shell repair behavior in release mode.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_removes_orphan_function_call_output`  (lines 1349–1360)

```
fn normalize_removes_orphan_function_call_output()
```

**Purpose**: In non-debug builds, verifies that orphan function outputs are removed during normalization.

**Data flow**: Creates history with only a `FunctionCallOutput`, normalizes it, and asserts the history becomes empty.

**Call relations**: Exercises release-mode pruning in `remove_orphan_outputs`.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_removes_orphan_custom_tool_call_output`  (lines 1364–1376)

```
fn normalize_removes_orphan_custom_tool_call_output()
```

**Purpose**: In non-debug builds, verifies that orphan custom tool outputs are removed.

**Data flow**: Creates history with only a `CustomToolCallOutput`, normalizes it, and asserts the history becomes empty.

**Call relations**: Covers custom-tool orphan pruning.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_mixed_inserts_and_removals`  (lines 1380–1475)

```
fn normalize_mixed_inserts_and_removals()
```

**Purpose**: In non-debug builds, verifies normalization can simultaneously insert missing outputs and remove orphan outputs across multiple item types.

**Data flow**: Creates a mixed malformed history, normalizes it, and asserts the final transcript contains inserted aborted outputs for valid calls while dropping the orphan output.

**Call relations**: Exercises the combined effect of `ensure_call_outputs_present` and `remove_orphan_outputs`.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_adds_missing_output_for_function_call_inserts_output`  (lines 1478–1507)

```
fn normalize_adds_missing_output_for_function_call_inserts_output()
```

**Purpose**: Checks function-call output insertion in the always-enabled test variant.

**Data flow**: Creates history with a lone `FunctionCall`, normalizes it, and asserts the inserted aborted output appears immediately after the call.

**Call relations**: Duplicates the core insertion expectation independent of debug gating.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_adds_missing_output_for_tool_search_call`  (lines 1510–1543)

```
fn normalize_adds_missing_output_for_tool_search_call()
```

**Purpose**: Verifies that a missing client-side `ToolSearchOutput` is synthesized for a `ToolSearchCall` with a call id.

**Data flow**: Creates history with a lone `ToolSearchCall`, normalizes it, and asserts a completed client `ToolSearchOutput` with empty tools was inserted.

**Call relations**: Covers tool-search-specific normalization behavior.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_adds_missing_output_for_custom_tool_call_panics_in_debug`  (lines 1548–1559)

```
fn normalize_adds_missing_output_for_custom_tool_call_panics_in_debug()
```

**Purpose**: In debug builds, verifies that missing custom tool outputs trigger a panic instead of silent repair.

**Data flow**: Creates malformed history with a lone `CustomToolCall`, calls `normalize_history`, and expects the test to panic.

**Call relations**: Checks debug-mode strictness via `error_or_panic`.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `normalize_adds_missing_output_for_local_shell_call_with_id_panics_in_debug`  (lines 1564–1580)

```
fn normalize_adds_missing_output_for_local_shell_call_with_id_panics_in_debug()
```

**Purpose**: In debug builds, verifies that missing local shell outputs panic during normalization.

**Data flow**: Creates malformed history with a lone `LocalShellCall`, normalizes it, and expects a panic.

**Call relations**: Covers debug strictness for local shell pairing.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `normalize_removes_orphan_function_call_output_panics_in_debug`  (lines 1585–1593)

```
fn normalize_removes_orphan_function_call_output_panics_in_debug()
```

**Purpose**: In debug builds, verifies that orphan function outputs panic during normalization.

**Data flow**: Creates history with a lone `FunctionCallOutput`, normalizes it, and expects a panic.

**Call relations**: Tests debug-mode orphan detection.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `normalize_removes_orphan_custom_tool_call_output_panics_in_debug`  (lines 1598–1607)

```
fn normalize_removes_orphan_custom_tool_call_output_panics_in_debug()
```

**Purpose**: In debug builds, verifies that orphan custom tool outputs panic during normalization.

**Data flow**: Creates history with a lone `CustomToolCallOutput`, normalizes it, and expects a panic.

**Call relations**: Covers debug-mode custom-tool orphan detection.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `normalize_removes_orphan_client_tool_search_output`  (lines 1611–1624)

```
fn normalize_removes_orphan_client_tool_search_output()
```

**Purpose**: In non-debug builds, verifies that orphan client-side tool-search outputs are removed.

**Data flow**: Creates history with a lone client `ToolSearchOutput`, normalizes it, and asserts the history becomes empty.

**Call relations**: Exercises client tool-search orphan pruning.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_removes_orphan_client_tool_search_output_panics_in_debug`  (lines 1629–1639)

```
fn normalize_removes_orphan_client_tool_search_output_panics_in_debug()
```

**Purpose**: In debug builds, verifies that orphan client-side tool-search outputs panic.

**Data flow**: Creates history with a lone client `ToolSearchOutput`, normalizes it, and expects a panic.

**Call relations**: Checks debug strictness for tool-search orphan outputs.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `normalize_keeps_server_tool_search_output_without_matching_call`  (lines 1642–1664)

```
fn normalize_keeps_server_tool_search_output_without_matching_call()
```

**Purpose**: Verifies that server-executed tool-search outputs are preserved even without a matching call item.

**Data flow**: Creates history with a lone server `ToolSearchOutput`, normalizes it, and asserts it remains unchanged.

**Call relations**: Covers the explicit server-output exemption in `remove_orphan_outputs`.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_mixed_inserts_and_removals_panics_in_debug`  (lines 1669–1708)

```
fn normalize_mixed_inserts_and_removals_panics_in_debug()
```

**Purpose**: In debug builds, verifies that a mixed malformed history triggers a panic rather than being repaired.

**Data flow**: Creates the same mixed malformed history as the release-mode test, normalizes it, and expects a panic.

**Call relations**: Checks that debug builds fail fast on any invariant violation.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `image_data_url_payload_does_not_dominate_message_estimate`  (lines 1711–1747)

```
fn image_data_url_payload_does_not_dominate_message_estimate()
```

**Purpose**: Verifies that inline base64 image payload bytes in user messages are discounted and replaced with a fixed heuristic cost.

**Data flow**: Builds a message with a huge `data:image/png;base64,...` URL, computes raw serialized length and estimated visible bytes, derives the expected adjusted size, and asserts the estimate matches and is smaller than raw JSON size.

**Call relations**: Exercises `estimate_response_item_model_visible_bytes` and `image_data_url_estimate_adjustment` for messages.

*Call graph*: 5 external calls (assert!, assert_eq!, format!, to_string, vec!).


##### `image_data_url_payload_does_not_dominate_function_call_output_estimate`  (lines 1750–1773)

```
fn image_data_url_payload_does_not_dominate_function_call_output_estimate()
```

**Purpose**: Verifies the same image-payload discounting for `FunctionCallOutput` content items.

**Data flow**: Builds a function output containing text plus a huge inline image, computes raw and estimated sizes, and asserts the expected adjusted estimate.

**Call relations**: Covers image adjustment inside standard tool outputs.

*Call graph*: calls 1 internal fn (from_content_items); 5 external calls (assert!, assert_eq!, format!, to_string, vec!).


##### `image_data_url_payload_does_not_dominate_custom_tool_call_output_estimate`  (lines 1776–1800)

```
fn image_data_url_payload_does_not_dominate_custom_tool_call_output_estimate()
```

**Purpose**: Verifies image-payload discounting for `CustomToolCallOutput` content items.

**Data flow**: Builds a custom tool output with text plus a huge inline image, computes raw and estimated sizes, and asserts the expected adjusted estimate.

**Call relations**: Covers image adjustment inside custom tool outputs.

*Call graph*: calls 1 internal fn (from_content_items); 5 external calls (assert!, assert_eq!, format!, to_string, vec!).


##### `non_base64_image_urls_are_unchanged`  (lines 1803–1833)

```
fn non_base64_image_urls_are_unchanged()
```

**Purpose**: Checks that ordinary HTTP/file image URLs are not discounted by the estimator.

**Data flow**: Builds a message with an HTTPS image and a function output with a file URL image, computes estimates, and asserts each equals raw serialized length.

**Call relations**: Exercises the negative path in `parse_base64_image_data_url`.

*Call graph*: calls 1 internal fn (from_content_items); 2 external calls (assert_eq!, vec!).


##### `encrypted_function_output_uses_plaintext_byte_estimate`  (lines 1836–1854)

```
fn encrypted_function_output_uses_plaintext_byte_estimate()
```

**Purpose**: Verifies that encrypted function-output content is discounted from raw serialized size and replaced with the plaintext heuristic.

**Data flow**: Builds a function output containing one `EncryptedContent` item, computes raw and estimated sizes, derives the expected replacement using `estimate_encrypted_function_output_length`, and asserts equality.

**Call relations**: Exercises `encrypted_function_output_estimate_adjustment`.

*Call graph*: calls 1 internal fn (from_content_items); 3 external calls (assert_eq!, to_string, vec!).


##### `data_url_without_base64_marker_is_unchanged`  (lines 1857–1873)

```
fn data_url_without_base64_marker_is_unchanged()
```

**Purpose**: Checks that non-base64 `data:image/...` URLs are left at raw serialized size.

**Data flow**: Builds a message with an SVG data URL lacking `;base64`, computes the estimate, and asserts it equals raw JSON length.

**Call relations**: Covers another negative path in image URL parsing.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `non_image_base64_data_url_is_unchanged`  (lines 1876–1894)

```
fn non_image_base64_data_url_is_unchanged()
```

**Purpose**: Checks that base64 data URLs with non-image MIME types are not discounted.

**Data flow**: Builds a function output with `data:application/octet-stream;base64,...`, computes raw and estimated sizes, and asserts equality.

**Call relations**: Verifies MIME-type filtering in `parse_base64_image_data_url`.

*Call graph*: calls 1 internal fn (from_content_items); 4 external calls (assert_eq!, format!, to_string, vec!).


##### `mixed_case_data_url_markers_are_adjusted`  (lines 1897–1916)

```
fn mixed_case_data_url_markers_are_adjusted()
```

**Purpose**: Verifies that case-insensitive `DATA:` and `BASE64` markers are still recognized for image discounting.

**Data flow**: Builds a message with mixed-case data URL markers, computes raw and estimated sizes, and asserts the expected adjusted estimate.

**Call relations**: Covers case-insensitive parsing behavior.

*Call graph*: 4 external calls (assert_eq!, format!, to_string, vec!).


##### `multiple_inline_images_apply_multiple_fixed_costs`  (lines 1919–1950)

```
fn multiple_inline_images_apply_multiple_fixed_costs()
```

**Purpose**: Checks that multiple inline images each contribute their own replacement estimate.

**Data flow**: Builds a message with two base64 image URLs, computes raw and estimated sizes, and asserts the estimate subtracts both payload lengths and adds two fixed image costs.

**Call relations**: Exercises accumulation logic in `image_data_url_estimate_adjustment`.

*Call graph*: 4 external calls (assert_eq!, format!, to_string, vec!).


##### `original_detail_images_scale_with_dimensions`  (lines 1953–1983)

```
fn original_detail_images_scale_with_dimensions()
```

**Purpose**: Verifies patch-based estimation for `ImageDetail::Original` images using actual encoded PNG dimensions.

**Data flow**: Creates a 2304x864 PNG in memory, base64-encodes it into a data URL, wraps it in a function output image item, computes the estimate, and asserts the replacement bytes equal the expected patch-derived value.

**Call relations**: Exercises `estimate_original_image_bytes` on a decodable PNG payload.

*Call graph*: calls 2 internal fn (from_content_items, new); 7 external calls (from_pixel, new, assert_eq!, format!, Rgba, to_string, vec!).


##### `original_detail_images_are_capped_at_max_patch_count`  (lines 1986–2016)

```
fn original_detail_images_are_capped_at_max_patch_count()
```

**Purpose**: Checks that original-detail image estimates are capped at `ORIGINAL_IMAGE_MAX_PATCHES` for very large images.

**Data flow**: Creates a 3201x3201 grayscale PNG, encodes it into a data URL, computes the estimate, derives the capped replacement bytes from `approx_bytes_for_tokens(ORIGINAL_IMAGE_MAX_PATCHES)`, and asserts equality.

**Call relations**: Covers the patch-count cap in `estimate_original_image_bytes`.

*Call graph*: calls 2 internal fn (from_content_items, new); 8 external calls (from_pixel, new, assert_eq!, format!, try_from, Luma, to_string, vec!).


##### `original_detail_webp_images_scale_with_dimensions`  (lines 2019–2048)

```
fn original_detail_webp_images_scale_with_dimensions()
```

**Purpose**: Verifies that original-detail estimation also works for decodable WebP payloads.

**Data flow**: Creates a 2304x864 WebP image in memory, base64-encodes it, computes the estimate for a function output image item, and asserts the same patch-derived replacement bytes as the PNG case.

**Call relations**: Confirms format-agnostic dimension decoding in `estimate_original_image_bytes`.

*Call graph*: calls 2 internal fn (from_content_items, new); 7 external calls (from_pixel, new, assert_eq!, format!, Rgba, to_string, vec!).


##### `text_only_items_unchanged`  (lines 2051–2066)

```
fn text_only_items_unchanged()
```

**Purpose**: Checks that text-only items use raw serialized size with no heuristic adjustments.

**Data flow**: Builds an assistant text message, computes estimated visible bytes and raw JSON length, and asserts they are equal.

**Call relations**: Covers the baseline path in `estimate_response_item_model_visible_bytes`.

*Call graph*: 3 external calls (assert_eq!, to_string, vec!).


### `core/src/event_mapping_tests.rs`

`test` · `test`

This test module validates the behavior of `event_mapping.rs` from the perspective of transcript rendering. The first tests cover contextual developer classification, asserting that skills instructions and token-budget tags are recognized as contextual developer content and that pure contextual bundles do not report non-contextual fragments. The user-message parsing tests then verify that ordinary text and multiple images become `UserInput` entries in order, while synthetic image label/open/close tag text around inline images is suppressed so only the actual image and surrounding user text remain visible.

Several tests ensure contextual prompt scaffolding is hidden from visible transcripts. User messages containing AGENTS instructions, environment context, skills, shell-command wrappers, or internal model context fragments all parse to `None`. Hook prompts are a special exception: `parse_turn_item` should surface them as distinct `TurnItem::HookPrompt` values, even when mixed with other contextual fragments in the same message, and preserve the original message id when present.

Assistant, reasoning, and web-search parsing are also covered. Assistant messages accept both `OutputText` and legacy `InputText` payloads for backward compatibility. Reasoning items expose both summary text and raw content vectors. Web-search calls are mapped into `WebSearchItem`s with the correct derived query string for search, open-page, find-in-page, and partial/no-action cases. Together these tests document exactly which raw history items become visible transcript entries and which are intentionally suppressed.

#### Function details

##### `recognizes_skills_instructions_as_contextual_developer_content`  (lines 23–29)

```
fn recognizes_skills_instructions_as_contextual_developer_content()
```

**Purpose**: Verifies that a developer message beginning with the skills-instructions open tag is classified as contextual developer content.

**Data flow**: Builds a one-item `ContentItem::InputText` slice containing `SKILLS_INSTRUCTIONS_OPEN_TAG`, calls `is_contextual_dev_message_content`, and asserts the result is true.

**Call relations**: Tests the developer-prefix classifier against one of the configured contextual tags.

*Call graph*: 1 external calls (assert!).


##### `recognizes_token_budget_as_contextual_developer_content`  (lines 32–40)

```
fn recognizes_token_budget_as_contextual_developer_content()
```

**Purpose**: Verifies that token-budget instructions are contextual developer content and contain no non-contextual fragments.

**Data flow**: Builds a developer-content vector containing a `<token_budget>` block, calls both `is_contextual_dev_message_content` and `has_non_contextual_dev_message_content`, and asserts true then false respectively.

**Call relations**: Exercises both developer contextuality predicates on the same input.

*Call graph*: 2 external calls (assert!, vec!).


##### `parses_user_message_with_text_and_two_images`  (lines 43–89)

```
fn parses_user_message_with_text_and_two_images()
```

**Purpose**: Checks that a visible user message with text and two images becomes a `TurnItem::UserMessage` with matching `UserInput` entries.

**Data flow**: Builds a user `ResponseItem::Message` containing one `InputText` and two `InputImage`s, calls `parse_turn_item`, matches `TurnItem::UserMessage`, and asserts the parsed `user.content` equals the expected vector.

**Call relations**: Exercises `parse_turn_item` and `parse_user_message` on ordinary visible user content.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `skips_local_image_label_text`  (lines 92–135)

```
fn skips_local_image_label_text()
```

**Purpose**: Verifies that local-image label/open/close tag text adjacent to an image is omitted from parsed user-visible content.

**Data flow**: Builds a user message with a local image open tag, an `InputImage`, a closing `</image>` tag, and trailing user text; parses it and asserts the resulting `UserInput` vector contains only the image and trailing text.

**Call relations**: Tests the adjacency-based tag skipping logic in `parse_user_message`.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `parses_assistant_message_input_text_for_backward_compatibility`  (lines 138–172)

```
fn parses_assistant_message_input_text_for_backward_compatibility()
```

**Purpose**: Checks that assistant messages using `InputText` instead of `OutputText` still parse as visible agent messages.

**Data flow**: Builds an assistant message with one `InputText`, parses it, matches `TurnItem::AgentMessage`, extracts the rendered text content, and asserts it matches the original string.

**Call relations**: Exercises the backward-compatible branch in `parse_agent_message`.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `skips_unnamed_image_label_text`  (lines 175–218)

```
fn skips_unnamed_image_label_text()
```

**Purpose**: Verifies that generic image open/close tag text around an inline image is omitted from parsed user-visible content.

**Data flow**: Builds a user message with `image_open_tag_text()`, an `InputImage`, the matching close tag, and trailing text; parses it and asserts only the image and trailing text remain.

**Call relations**: Covers the non-local image-tag skipping path in `parse_user_message`.

*Call graph*: calls 1 internal fn (image_open_tag_text); 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `skips_user_instructions_and_env`  (lines 221–285)

```
fn skips_user_instructions_and_env()
```

**Purpose**: Checks that various contextual user messages parse to no visible turn item.

**Data flow**: Builds several user `ResponseItem::Message` values containing AGENTS instructions, environment context, skills, shell-command wrappers, and mixed contextual fragments; loops over them, calls `parse_turn_item`, and asserts each result is `None`.

**Call relations**: Exercises contextual-user suppression in `parse_turn_item` and `parse_user_message`.

*Call graph*: 3 external calls (assert!, parse_turn_item, vec!).


##### `parses_hook_prompt_message_as_distinct_turn_item`  (lines 288–310)

```
fn parses_hook_prompt_message_as_distinct_turn_item()
```

**Purpose**: Verifies that a hook prompt message is surfaced as `TurnItem::HookPrompt` rather than a generic user message.

**Data flow**: Builds a hook prompt message with `build_hook_prompt_message`, parses it, matches `TurnItem::HookPrompt`, and asserts the parsed fragment text and hook run id.

**Call relations**: Tests the hook-prompt-first branch in `parse_turn_item`.

*Call graph*: calls 1 internal fn (build_hook_prompt_message); 4 external calls (from_single_hook, assert_eq!, panic!, parse_turn_item).


##### `parses_hook_prompt_and_hides_other_contextual_fragments`  (lines 313–345)

```
fn parses_hook_prompt_and_hides_other_contextual_fragments()
```

**Purpose**: Checks that hook prompts remain visible even when mixed with other contextual user fragments in the same message.

**Data flow**: Builds a user message containing environment context plus a hook prompt fragment, parses it, matches `TurnItem::HookPrompt`, and asserts the message id and parsed fragment contents.

**Call relations**: Exercises the precedence of `parse_visible_hook_prompt_message` over generic contextual-user suppression.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `internal_model_context_does_not_parse_as_visible_turn_item`  (lines 348–364)

```
fn internal_model_context_does_not_parse_as_visible_turn_item()
```

**Purpose**: Verifies that internal model-context fragments are hidden from visible transcript parsing.

**Data flow**: Builds a user message containing `InternalModelContextFragment::render()`, calls `parse_turn_item`, and asserts the result is `None`.

**Call relations**: Covers another contextual-user suppression case.

*Call graph*: 2 external calls (assert!, vec!).


##### `parses_agent_message`  (lines 367–389)

```
fn parses_agent_message()
```

**Purpose**: Checks that a normal assistant `OutputText` message becomes a visible `TurnItem::AgentMessage`.

**Data flow**: Builds an assistant message with one `OutputText`, parses it, matches `TurnItem::AgentMessage`, extracts the first text content item, and asserts its text.

**Call relations**: Exercises the standard assistant-message path in `parse_turn_item`.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `parses_reasoning_summary_and_raw_content`  (lines 392–422)

```
fn parses_reasoning_summary_and_raw_content()
```

**Purpose**: Verifies that reasoning items expose both summary text and raw reasoning content.

**Data flow**: Builds a `ResponseItem::Reasoning` with two summary entries and one raw content entry, parses it, matches `TurnItem::Reasoning`, and asserts both vectors.

**Call relations**: Tests reasoning-item conversion in `parse_turn_item`.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `parses_reasoning_including_raw_content`  (lines 425–455)

```
fn parses_reasoning_including_raw_content()
```

**Purpose**: Checks that both `ReasoningText` and plain `Text` reasoning content entries are preserved in raw-content output.

**Data flow**: Builds a reasoning item with one summary and two content entries of different variants, parses it, and asserts the resulting `raw_content` vector contains both strings in order.

**Call relations**: Covers both content variants handled in reasoning parsing.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `parses_web_search_call`  (lines 458–485)

```
fn parses_web_search_call()
```

**Purpose**: Verifies parsing of a standard web-search action into a `WebSearchItem` with the expected query string.

**Data flow**: Builds a `WebSearchCall` with `WebSearchAction::Search`, parses it, matches `TurnItem::WebSearch`, and asserts the full `WebSearchItem` value.

**Call relations**: Exercises the web-search branch in `parse_turn_item` with a search action.

*Call graph*: 3 external calls (assert_eq!, panic!, parse_turn_item).


##### `parses_web_search_open_page_call`  (lines 488–513)

```
fn parses_web_search_open_page_call()
```

**Purpose**: Verifies parsing of an open-page web-search action into a `WebSearchItem` whose query is the URL.

**Data flow**: Builds a `WebSearchCall` with `WebSearchAction::OpenPage`, parses it, and asserts the resulting `WebSearchItem` fields.

**Call relations**: Covers `web_search_action_detail` behavior for open-page actions.

*Call graph*: 3 external calls (assert_eq!, panic!, parse_turn_item).


##### `parses_web_search_find_in_page_call`  (lines 516–543)

```
fn parses_web_search_find_in_page_call()
```

**Purpose**: Verifies parsing of a find-in-page web-search action into a `WebSearchItem` with the expected derived query string.

**Data flow**: Builds a `WebSearchCall` with `WebSearchAction::FindInPage`, parses it, and asserts the resulting `WebSearchItem` contains the formatted query `'<pattern>' in <url>`.

**Call relations**: Covers another `web_search_action_detail` mapping.

*Call graph*: 3 external calls (assert_eq!, panic!, parse_turn_item).


##### `parses_partial_web_search_call_without_action_as_other`  (lines 546–566)

```
fn parses_partial_web_search_call_without_action_as_other()
```

**Purpose**: Checks that a partial web-search call lacking an action is still surfaced as `WebSearchAction::Other` with an empty query.

**Data flow**: Builds a `WebSearchCall` with `action: None`, parses it, matches `TurnItem::WebSearch`, and asserts the fallback `WebSearchItem` fields.

**Call relations**: Exercises the `None` action fallback branch in `parse_turn_item`.

*Call graph*: 3 external calls (assert_eq!, panic!, parse_turn_item).


### `core/src/context/contextual_user_message_tests.rs`

`test` · `test`

This test module exercises the classification logic in `contextual_user_message.rs` against concrete fragment strings and rendered fragment objects. Several tests verify that known contextual wrappers—`<environment_context>`, AGENTS.md instruction blocks, subagent notifications, internal model context, and a legacy `<goal_context>` tag—are recognized by `is_contextual_user_fragment`. Negative tests ensure arbitrary tags like `<project_context>` remain visible and that malformed internal context, such as an invalid `source` attribute casing, is rejected.

The file also checks rendering behavior for `UserInstructions`, including the legacy directory-prefixed header and the headerless form, and confirms `SubagentNotification::matches_text` is case-insensitive. Two tests focus on trait-object behavior and protocol integration: one boxes an `InternalModelContextFragment` as `Box<dyn ContextualUserFragment>` to prove dynamic dispatch compatibility, and another builds a hook-prompt response item with escaped content, verifies the resulting `ContentItem` is classified as contextual, then parses it back with `parse_visible_hook_prompt_message` and asserts the original unescaped `HookPromptFragment` payload is preserved. Together these tests pin down both the accepted surface syntax and the intended invisibility semantics of contextual fragments.

#### Function details

##### `detects_environment_context_fragment`  (lines 12–16)

```
fn detects_environment_context_fragment()
```

**Purpose**: Verifies that a literal `<environment_context>` text block is recognized as contextual user content. It protects the basic environment-context detection path.

**Data flow**: The test constructs a `ContentItem::InputText` containing environment XML and passes it to `is_contextual_user_fragment`. It asserts the returned boolean is `true`; no persistent state is changed.

**Call relations**: This test directly exercises the single-item classification path used by production code when scanning message content for hidden context.

*Call graph*: 1 external calls (assert!).


##### `detects_agents_instructions_fragment`  (lines 19–28)

```
fn detects_agents_instructions_fragment()
```

**Purpose**: Checks that both supported AGENTS.md instruction header variants are treated as contextual fragments. It covers the legacy directory-qualified header and the header without a directory.

**Data flow**: It iterates over two instruction strings, wraps each in `ContentItem::InputText`, calls `is_contextual_user_fragment`, and asserts `true` for each case. The loop ensures both textual forms map to the same classification outcome.

**Call relations**: This test validates the fragment registration for `UserInstructions` and ensures the classifier accepts both historical and current renderings.

*Call graph*: 1 external calls (assert!).


##### `renders_agents_instructions_with_legacy_directory_header`  (lines 31–40)

```
fn renders_agents_instructions_with_legacy_directory_header()
```

**Purpose**: Confirms that `UserInstructions` renders with the legacy `for /tmp` header when a directory is present. It locks down the exact serialized text expected by downstream matching logic.

**Data flow**: The test constructs a `UserInstructions` value with `directory: Some("/tmp")` and `text: "body"`, calls `.render()`, and compares the resulting string to the expected multiline literal.

**Call relations**: This rendering test complements detection tests by proving the producer side emits the same syntax the classifier later recognizes.

*Call graph*: 1 external calls (assert_eq!).


##### `renders_agents_instructions_without_directory_header`  (lines 43–52)

```
fn renders_agents_instructions_without_directory_header()
```

**Purpose**: Confirms that `UserInstructions` omits the directory suffix in its header when no directory is supplied. It distinguishes the no-directory serialization from the legacy directory form.

**Data flow**: It builds `UserInstructions { directory: None, text: "body" }`, renders it, and asserts exact equality with the expected header and instruction block string.

**Call relations**: Like the previous rendering test, this one documents the canonical text form that the contextual-fragment matcher must continue to accept.

*Call graph*: 1 external calls (assert_eq!).


##### `detects_subagent_notification_fragment_case_insensitively`  (lines 55–59)

```
fn detects_subagent_notification_fragment_case_insensitively()
```

**Purpose**: Verifies that subagent notification tags are matched without case sensitivity. This prevents brittle failures when tag casing varies.

**Data flow**: The test passes a mixed-case opening/closing tag string directly to `SubagentNotification::matches_text` and asserts the boolean result is `true`.

**Call relations**: It targets the fragment type’s own matcher rather than the top-level classifier, documenting a lower-level invariant relied on by contextual detection.

*Call graph*: 1 external calls (assert!).


##### `detects_internal_model_context_fragment`  (lines 62–76)

```
fn detects_internal_model_context_fragment()
```

**Purpose**: Checks both rendering and detection of internal model context fragments with a valid source. It ensures the generated XML is exactly what the classifier accepts.

**Data flow**: The test creates an `InternalModelContextFragment` using `InternalContextSource::from_static("extension")`, renders it to text, asserts exact string equality, then wraps that text in `ContentItem::InputText` and asserts `is_contextual_user_fragment` returns `true`.

**Call relations**: This test bridges producer and consumer paths: fragment construction and rendering feed directly into the top-level contextual classifier.

*Call graph*: calls 2 internal fn (from_static, new); 2 external calls (assert!, assert_eq!).


##### `detects_legacy_goal_context_fragment`  (lines 79–84)

```
fn detects_legacy_goal_context_fragment()
```

**Purpose**: Ensures a legacy `<goal_context>` wrapper is still recognized as contextual. It preserves backward compatibility for older serialized context.

**Data flow**: It creates a `ContentItem::InputText` containing the legacy goal-context XML and asserts that `is_contextual_user_fragment` returns `true`.

**Call relations**: This regression test covers one of the legacy fragment registrations included in the contextual fragment registry.

*Call graph*: 1 external calls (assert!).


##### `does_not_hide_arbitrary_context_tags`  (lines 87–91)

```
fn does_not_hide_arbitrary_context_tags()
```

**Purpose**: Verifies that unknown XML-like tags are not automatically treated as hidden context. It prevents overbroad suppression of user-visible content.

**Data flow**: The test wraps `<project_context>...</project_context>` in `ContentItem::InputText`, calls `is_contextual_user_fragment`, and asserts the result is `false`.

**Call relations**: This negative case guards the classifier’s conservative design: only registered fragments and parsed hook prompts should be hidden.

*Call graph*: 1 external calls (assert!).


##### `rejects_invalid_internal_model_context_source`  (lines 94–99)

```
fn rejects_invalid_internal_model_context_source()
```

**Purpose**: Checks that malformed internal model context metadata is rejected even if the outer tag name looks correct. Specifically, it rejects an invalid source attribute value casing.

**Data flow**: It constructs a `ContentItem::InputText` with `<codex_internal_context source="Extension">...`, calls `is_contextual_user_fragment`, and asserts `false`.

**Call relations**: This test exercises the parser-backed validation path for internal model context fragments, ensuring recognition depends on valid structured content rather than tag shape alone.

*Call graph*: 1 external calls (assert!).


##### `contextual_user_fragment_is_dyn_compatible`  (lines 102–112)

```
fn contextual_user_fragment_is_dyn_compatible()
```

**Purpose**: Demonstrates that contextual fragments can be used through the `ContextualUserFragment` trait object interface. It confirms object-safe rendering behavior.

**Data flow**: The test boxes an `InternalModelContextFragment` as `Box<dyn ContextualUserFragment>`, calls `render()` through dynamic dispatch, and asserts the exact rendered string.

**Call relations**: This test documents that higher-level code may store heterogeneous contextual fragments behind trait objects and still obtain the expected serialized output.

*Call graph*: calls 2 internal fn (from_static, new); 2 external calls (new, assert_eq!).


##### `ignores_regular_user_text`  (lines 115–119)

```
fn ignores_regular_user_text()
```

**Purpose**: Verifies that ordinary free-form text is not misclassified as contextual content. It is the simplest negative baseline for the classifier.

**Data flow**: It wraps the string `hello` in `ContentItem::InputText`, calls `is_contextual_user_fragment`, and asserts the result is `false`.

**Call relations**: This test complements the positive fragment cases by confirming the classifier does not hide normal user messages.

*Call graph*: 1 external calls (assert!).


##### `detects_hook_prompt_fragment_and_roundtrips_escaping`  (lines 122–152)

```
fn detects_hook_prompt_fragment_and_roundtrips_escaping()
```

**Purpose**: Tests end-to-end hook-prompt detection and parsing, including preservation of special characters through escaping and unescaping. It proves that visible hook prompt messages can be reconstructed into structured fragments without losing the original payload.

**Data flow**: The test builds a hook-prompt response item from a single `HookPromptFragment` containing quotes, ampersands, and angle brackets. It destructures the resulting `ResponseItem::Message`, extracts the sole `ContentItem`, asserts that item is contextual, then calls `parse_visible_hook_prompt_message(None, content.as_slice())` and compares the parsed fragment vector to the original unescaped fragment data. It also checks the serialized text does not contain an over-escaped quoted substring.

**Call relations**: This is the main integration test for the file’s parser: protocol-side message construction feeds into `is_contextual_user_fragment` and `parse_visible_hook_prompt_message`, validating the exact round-trip those production functions are meant to support.

*Call graph*: calls 1 internal fn (build_hook_prompt_message); 4 external calls (from_single_hook, assert!, assert_eq!, panic!).


### `core/src/context/environment_context_tests.rs`

`test` · `test`

This test module validates the behavior of `EnvironmentContext` and its nested filesystem/network serializers using concrete path and permission fixtures. Helper functions provide a stable shell name (`bash`) and absolute test paths. Several tests assert exact `render()` output for common cases: a single writable workspace with date/time, a read-only context with no environments, network restrictions with allowed and denied domains, subagent listings, and multiple selected environments where each environment carries its own shell.

Filesystem coverage is especially detailed. `workspace_write_permission_profile_with_private_denials` builds a restricted `PermissionProfile` that grants write access to project roots while denying a `private` subdirectory and matching glob. `serialize_environment_context_with_full_filesystem_profile` verifies that project-root-relative permissions are materialized for multiple workspace roots and rendered as concrete `<entry>` elements. `turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd` confirms persisted `TurnContextItem` reconstruction uses explicit `workspace_roots` rather than the legacy `cwd` fallback when both are present.

The comparison tests pin down `equals_except_shell`: same cwd compares equal, different cwd compares unequal, and shell differences are ignored even when environment ids differ in the single-environment case. Overall, the file documents both the exact wire format and the compatibility rules around persisted historical context.

#### Function details

##### `fake_shell_name`  (lines 21–27)

```
fn fake_shell_name() -> String
```

**Purpose**: Builds a deterministic shell name string for tests by constructing a Bash `Shell` and asking it for its display name. It avoids repeating shell-construction boilerplate across tests.

**Data flow**: It creates `crate::shell::Shell { shell_type: ShellType::Bash, shell_path: PathBuf::from("/bin/bash") }`, calls `shell.name().to_string()`, and returns the resulting `String`.

**Call relations**: This helper is used by tests that need a realistic shell name, especially persisted-context reconstruction where the shell string is passed into `EnvironmentContext::from_turn_context_item`.

*Call graph*: called by 1 (turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd); 1 external calls (from).


##### `test_abs_path`  (lines 29–31)

```
fn test_abs_path(unix_path: &str) -> AbsolutePathBuf
```

**Purpose**: Converts a Unix-style test path string into an `AbsolutePathBuf` using shared test support. It keeps path fixture setup concise.

**Data flow**: It takes `&str`, passes it to `test_path_buf(unix_path)`, calls `.abs()`, and returns the absolute path buffer.

**Call relations**: This helper is used by filesystem-heavy tests to build absolute workspace roots and derived paths without repeating conversion code.

*Call graph*: called by 2 (serialize_environment_context_with_full_filesystem_profile, turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd); 1 external calls (test_path_buf).


##### `serialize_workspace_write_environment_context`  (lines 34–59)

```
fn serialize_workspace_write_environment_context()
```

**Purpose**: Verifies exact rendering of a basic single-environment context with cwd, shell, current date, and timezone. It establishes the canonical serialized shape for the common legacy single-environment case.

**Data flow**: The test constructs an `EnvironmentContext` with one `EnvironmentContextEnvironment`, date/time values, and no network or subagents, then compares `context.render()` to an expected multiline string built with `format!`.

**Call relations**: This test exercises `EnvironmentContext::new` and the `ContextualUserFragment` rendering path, documenting the baseline output consumed by the model.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, test_path_buf, format!, vec!).


##### `serialize_environment_context_with_network`  (lines 62–91)

```
fn serialize_environment_context_with_network()
```

**Purpose**: Checks that network restrictions are rendered inline inside the environment context with comma-joined allowed and denied domain lists. It validates the `<network enabled="true">` subsection format.

**Data flow**: It creates a `NetworkContext` with two allowed domains and one denied domain, embeds it in a single-environment `EnvironmentContext`, renders the context, and asserts exact equality with the expected string.

**Call relations**: This test covers `NetworkContext::new`, `NetworkContext::render`, and their integration into `EnvironmentContext::body`.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert_eq!, format!, vec!).


##### `workspace_write_permission_profile_with_private_denials`  (lines 93–117)

```
fn workspace_write_permission_profile_with_private_denials() -> PermissionProfile
```

**Purpose**: Builds a reusable restricted `PermissionProfile` fixture that grants write access to project roots but denies a `private` subdirectory and matching glob. It provides realistic filesystem permissions for serialization tests.

**Data flow**: It constructs a restricted `FileSystemSandboxPolicy` with three `FileSystemSandboxEntry` values—write to project roots, deny to `project_roots/private`, and deny to the `private/**` glob—pairs it with `NetworkSandboxPolicy::Restricted`, and converts the runtime permissions into a `PermissionProfile` via `PermissionProfile::from_runtime_permissions`.

**Call relations**: This fixture function is called by tests that verify full filesystem rendering and persisted-item workspace-root handling.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); called by 2 (serialize_environment_context_with_full_filesystem_profile, turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd); 1 external calls (vec!).


##### `serialize_environment_context_with_full_filesystem_profile`  (lines 120–161)

```
fn serialize_environment_context_with_full_filesystem_profile()
```

**Purpose**: Verifies that a managed restricted filesystem profile is fully materialized and rendered for multiple workspace roots. It checks concrete path expansion, deny entries, glob entries, and workspace-root listing.

**Data flow**: The test computes absolute paths for two repos and their `private` subpaths and globs, creates a base `EnvironmentContext`, assigns `context.filesystem = Some(FileSystemContext::from_permission_profile(...))` using the shared permission-profile fixture and both workspace roots, renders the context, and asserts exact equality with a long expected string.

**Call relations**: This test exercises `FileSystemContext::from_permission_profile`, project-root materialization, restricted-entry rendering, XML escaping helpers indirectly, and integration into `EnvironmentContext::body`.

*Call graph*: calls 5 internal fn (new, from_permission_profile, test_abs_path, workspace_write_permission_profile_with_private_denials, resolve_path_against_base); 4 external calls (new, assert_eq!, format!, vec!).


##### `turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd`  (lines 164–212)

```
fn turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd()
```

**Purpose**: Ensures persisted turn-context reconstruction uses explicit `workspace_roots` rather than the item’s `cwd` when materializing filesystem permissions. It protects against incorrectly binding project-root-relative rules to the wrong directory.

**Data flow**: It builds a `TurnContextItem` whose `cwd` differs from its `workspace_roots`, includes the shared restricted permission profile, reconstructs an environment context with `EnvironmentContext::from_turn_context_item(&item, fake_shell_name())`, renders it, and asserts that the output contains both workspace roots and the expected denied private path while not containing a private path under the unrelated cwd.

**Call relations**: This test targets the compatibility path through `from_turn_context_item`, `filesystem_from_turn_context_item`, and `workspace_roots_from_turn_context_item`.

*Call graph*: calls 4 internal fn (from_turn_context_item, fake_shell_name, test_abs_path, workspace_write_permission_profile_with_private_denials); 4 external calls (new_read_only_policy, assert!, test_path_buf, vec!).


##### `serialize_read_only_environment_context`  (lines 215–230)

```
fn serialize_read_only_environment_context()
```

**Purpose**: Checks rendering when there are no selected environments and only date/time metadata is present. It confirms that empty environment lists do not produce empty cwd/shell wrappers.

**Data flow**: It constructs `EnvironmentContext::new(Vec::new(), ...)` with date and timezone, renders it, and compares the result to the expected minimal `<environment_context>` body.

**Call relations**: This test covers the `EnvironmentContextEnvironments::None` branch in `EnvironmentContext::body`.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, assert_eq!).


##### `equals_except_shell_compares_cwd`  (lines 233–257)

```
fn equals_except_shell_compares_cwd()
```

**Purpose**: Verifies that two otherwise identical single-environment contexts compare equal when their cwd values match. It documents the positive baseline for shell-agnostic comparison.

**Data flow**: It creates two `EnvironmentContext` values with the same cwd and shell, calls `context1.equals_except_shell(&context2)`, and asserts `true`.

**Call relations**: This test directly exercises `EnvironmentContext::equals_except_shell` and, underneath it, `EnvironmentContextEnvironments::equals_except_shell`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, vec!).


##### `equals_except_shell_compares_cwd_differences`  (lines 260–285)

```
fn equals_except_shell_compares_cwd_differences()
```

**Purpose**: Verifies that differing cwd values make two single-environment contexts unequal even when other fields match. It confirms cwd is the meaningful identity field in the single-environment comparison path.

**Data flow**: It constructs two contexts with different cwd values, calls `equals_except_shell`, and asserts the result is `false`.

**Call relations**: This negative comparison test complements the matching-cwd case and documents the exact field sensitivity of the shell-agnostic comparator.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, vec!).


##### `equals_except_shell_ignores_shell`  (lines 288–313)

```
fn equals_except_shell_ignores_shell()
```

**Purpose**: Checks that shell differences are ignored in single-environment comparisons. The test also shows that the single-environment comparison does not consider environment id.

**Data flow**: It creates two contexts with the same cwd but different `id` and `shell` values, calls `equals_except_shell`, and asserts `true`.

**Call relations**: This test captures the intentional semantics implemented by `EnvironmentContextEnvironments::equals_except_shell` for the `Single` variant.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, vec!).


##### `serialize_environment_context_with_subagents`  (lines 316–344)

```
fn serialize_environment_context_with_subagents()
```

**Purpose**: Verifies that subagent summary text is rendered as a multiline `<subagents>` block with each source line indented. It documents the exact formatting of embedded subagent listings.

**Data flow**: It constructs a single-environment `EnvironmentContext` with date/time and a two-line subagent string, renders it, and asserts exact equality with the expected multiline output.

**Call relations**: This test covers the optional subagent branch in `EnvironmentContext::body`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, format!, vec!).


##### `serialize_environment_context_with_multiple_selected_environments`  (lines 347–389)

```
fn serialize_environment_context_with_multiple_selected_environments()
```

**Purpose**: Checks rendering of the multi-environment form using a nested `<environments>` block with per-environment ids, cwd values, and shells. It validates the newer non-legacy serialization shape.

**Data flow**: It creates an `EnvironmentContext` with two `EnvironmentContextEnvironment` entries, date/time metadata, renders it, and compares the output to the expected multiline string.

**Call relations**: This test exercises the `EnvironmentContextEnvironments::Multiple` branch in `EnvironmentContext::body`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, test_path_buf, format!, vec!).


##### `serialize_environment_context_prefers_environment_shell_when_present`  (lines 392–432)

```
fn serialize_environment_context_prefers_environment_shell_when_present()
```

**Purpose**: Verifies that each environment’s own shell string is rendered in the multi-environment form rather than a shared fallback shell. It documents per-environment shell fidelity.

**Data flow**: It constructs a two-environment context with distinct shell names (`powershell` and `cmd`), renders it, and asserts exact equality with the expected output.

**Call relations**: This test complements the multi-environment rendering case and reflects the production rule implemented when environments are built from `TurnEnvironment` values.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, test_path_buf, format!, vec!).


### `core/src/stream_events_utils_tests.rs`

`test` · `test execution`

This test module validates the behavior of `stream_events_utils.rs` using real session/turn scaffolding from `make_session_and_context()`. It includes helper constructors for assistant `ResponseItem::Message` values and two test contributors implementing `TurnItemContributor`: `TestTurnItemContributor` records that it ran and injects an empty `MemoryCitation`, while `RewriteAgentMessageContributor` rewrites agent text to a known string. The tests verify that assistant-message finalization strips `<oai-mem-citation>` markup while preserving parsed citation metadata, that contributors run only when `TurnItemContributorPolicy::Run` is selected, and that contributed text affects both `last_agent_message` and mailbox-deferral facts.

Additional tests lock down mailbox behavior: visible assistant text with unknown phase defers mailbox delivery, commentary does not, and image-generation calls always defer. External-context classification is checked positively for web/tool search items and negatively for local shell, function-call, custom-tool, and plain assistant items. The image-generation persistence tests verify path construction under codex home, overwriting behavior, sanitization of unsafe call IDs, and rejection of malformed payloads such as data URLs or non-standard base64. Together these tests document the intended semantics of stream finalization, extension contribution ordering, and artifact persistence.

#### Function details

##### `assistant_output_text`  (lines 33–35)

```
fn assistant_output_text(text: &str) -> ResponseItem
```

**Purpose**: Builds a simple assistant message response item with no explicit phase for use in tests. It is a convenience wrapper around the phase-aware helper.

**Data flow**: It takes `&str text`, forwards it to `assistant_output_text_with_phase(text, None)`, and returns the resulting `ResponseItem::Message`.

**Call relations**: Used throughout the test module to create baseline assistant messages for stripping, mailbox, and contributor tests. It delegates construction to `assistant_output_text_with_phase`.

*Call graph*: calls 1 internal fn (assistant_output_text_with_phase); called by 9 (completed_item_defers_mailbox_delivery_for_unknown_phase_messages, external_context_pollution_items_exclude_local_tool_calls, finalized_turn_item_defers_mailbox_for_contributed_visible_text, handle_non_tool_response_item_runs_turn_item_contributors_only_when_requested, handle_non_tool_response_item_strips_citations_from_assistant_message, handle_output_item_done_returns_contributed_last_agent_message, last_assistant_message_from_item_returns_none_for_citation_only_message, last_assistant_message_from_item_returns_none_for_plan_only_hidden_message, last_assistant_message_from_item_strips_citations_and_plan_blocks).


##### `assistant_output_text_with_phase`  (lines 37–47)

```
fn assistant_output_text_with_phase(text: &str, phase: Option<MessagePhase>) -> ResponseItem
```

**Purpose**: Constructs a `ResponseItem::Message` representing assistant output with a caller-specified `MessagePhase`. Tests use it to distinguish commentary from final-answer behavior.

**Data flow**: It takes `&str text` and `Option<MessagePhase>`, builds a `ResponseItem::Message` with fixed ID `msg-1`, role `assistant`, a single `ContentItem::OutputText` containing the provided text, the supplied phase, and `metadata: None`, then returns it.

**Call relations**: Used by the simpler helper and by tests that need commentary-phase messages. It is the common fixture constructor for assistant message items.

*Call graph*: called by 3 (assistant_output_text, completed_item_keeps_mailbox_delivery_open_for_commentary_messages, finalized_turn_item_keeps_mailbox_open_for_commentary_text); 1 external calls (vec!).


##### `external_context_pollution_items_include_web_search_and_tool_search`  (lines 50–80)

```
fn external_context_pollution_items_include_web_search_and_tool_search()
```

**Purpose**: Verifies that web-search and tool-search response items are classified as potentially introducing external context. This protects the memory-pollution gating logic.

**Data flow**: The test constructs an array containing `WebSearchCall`, `ToolSearchCall`, and `ToolSearchOutput` items, then asserts that iterating over them and applying `response_item_may_include_external_context` yields true for all entries.

**Call relations**: It directly exercises the classifier used by memory-mode pollution marking. The test documents the positive set of polluting variants.

*Call graph*: 3 external calls (new, assert!, json!).


##### `external_context_pollution_items_exclude_local_tool_calls`  (lines 83–133)

```
fn external_context_pollution_items_exclude_local_tool_calls()
```

**Purpose**: Checks that local shell calls, function/custom tool calls and outputs, and plain assistant text are not treated as external-context pollution. This prevents over-marking threads as polluted.

**Data flow**: The test builds an array of non-polluting `ResponseItem` variants including local shell, function call/output, custom tool call/output, and an assistant message from `assistant_output_text`, then asserts that none of them satisfy `response_item_may_include_external_context`.

**Call relations**: It complements the positive classifier test by documenting excluded variants. Together the two tests define the intended boundary of external-context detection.

*Call graph*: calls 2 internal fn (assistant_output_text, from_text); 3 external calls (assert!, Exec, vec!).


##### `handle_non_tool_response_item_strips_citations_from_assistant_message`  (lines 136–172)

```
async fn handle_non_tool_response_item_strips_citations_from_assistant_message()
```

**Purpose**: Verifies that non-tool assistant message handling removes hidden memory-citation markup from visible text while still parsing the citation into structured metadata. It checks both text cleanup and citation extraction.

**Data flow**: The test creates a session and turn context, builds an assistant message containing visible text around an `<oai-mem-citation>` block, calls `handle_non_tool_response_item` with contributor policy `Skip`, unwraps the resulting `TurnItem::AgentMessage`, concatenates its text content, and asserts the visible text is `hello world`. It then inspects `memory_citation` and asserts the parsed entry path and rollout ID.

**Call relations**: This test exercises the parse/finalize path for assistant messages without extension contributors. It validates the behavior implemented by `finalize_turn_item` and its citation-stripping helper.

*Call graph*: calls 2 internal fn (make_session_and_context, assistant_output_text); 3 external calls (assert_eq!, panic!, handle_non_tool_response_item).


##### `TestTurnItemContributor::contribute`  (lines 180–196)

```
fn contribute(
        &'a self,
        _thread_store: &'a ExtensionData,
        turn_store: &'a ExtensionData,
        item: &'a mut TurnItem,
    ) -> codex_extension_api::ExtensionFuture<'a, Resu
```

**Purpose**: Test contributor implementation that records its execution in turn-local extension data and injects an empty `MemoryCitation` into agent messages. It gives tests a concrete way to observe contributor execution and precedence.

**Data flow**: It receives thread store, turn store, and mutable `TurnItem`. Inside the boxed async block it inserts a `TurnItemContributorRan` marker into `turn_store`; if the item is an `AgentMessage`, it sets `agent_message.memory_citation` to `Some(MemoryCitation { entries: Vec::new(), rollout_ids: Vec::new() })`; then it returns `Ok(())`.

**Call relations**: Registered in contributor-related tests to verify that contributors run only under `TurnItemContributorPolicy::Run` and that contributor-provided memory citations are preserved by later finalization.

*Call graph*: calls 1 internal fn (insert); 2 external calls (pin, new).


##### `RewriteAgentMessageContributor::contribute`  (lines 202–216)

```
fn contribute(
        &'a self,
        _thread_store: &'a ExtensionData,
        _turn_store: &'a ExtensionData,
        item: &'a mut TurnItem,
    ) -> codex_extension_api::ExtensionFuture<'a, Res
```

**Purpose**: Test contributor implementation that rewrites any agent message content to a fixed string. It is used to prove that contributor mutations affect downstream `last_agent_message` and mailbox-deferral facts.

**Data flow**: It receives thread store, turn store, and mutable `TurnItem`. In the boxed async block, if the item is an `AgentMessage`, it replaces `agent_message.content` with a single `AgentMessageContent::Text` containing `contributed assistant text`, then returns `Ok(())`.

**Call relations**: Used by tests around `handle_output_item_done` and `finalize_non_tool_response_item` to show that contributor output is what later logic sees, not the original assistant text.

*Call graph*: 2 external calls (pin, vec!).


##### `handle_non_tool_response_item_runs_turn_item_contributors_only_when_requested`  (lines 220–269)

```
async fn handle_non_tool_response_item_runs_turn_item_contributors_only_when_requested()
```

**Purpose**: Confirms that turn-item contributors are skipped under `TurnItemContributorPolicy::Skip` and executed under `Run`, with observable effects on extension data and memory citation fields. It also checks that hidden markup stripping still occurs after contribution.

**Data flow**: The test creates a session/context, installs `TestTurnItemContributor` in the extension registry, creates a fresh `ExtensionData` turn store, and builds an assistant message containing hidden citation markup. It first calls `handle_non_tool_response_item` with `Skip` and asserts the turn store lacks the marker and the resulting agent message has no memory citation. It then calls the same function with `Run(&turn_store)`, asserts the marker is present, the resulting agent message has a memory citation, and the visible text equals `hello world`.

**Call relations**: This test exercises contributor gating inside `finalize_turn_item` and verifies contributor effects survive the rest of finalization. It documents the semantics of `TurnItemContributorPolicy`.

*Call graph*: calls 4 internal fn (make_session_and_context, assistant_output_text, new, new); 6 external calls (new, assert!, assert_eq!, Run, panic!, handle_non_tool_response_item).


##### `handle_output_item_done_returns_contributed_last_agent_message`  (lines 272–314)

```
async fn handle_output_item_done_returns_contributed_last_agent_message()
```

**Purpose**: Verifies that `handle_output_item_done` reports the contributor-rewritten assistant text as `last_agent_message`. This ensures downstream follow-up logic sees finalized visible text, not raw model output.

**Data flow**: The test creates a session/context, installs `RewriteAgentMessageContributor`, builds a real `ToolRouter` and `ToolCallRuntime`, constructs `HandleOutputCtx`, sends an assistant message through `handle_output_item_done`, and asserts that the returned `OutputItemResult.last_agent_message` is `Some("contributed assistant text")`.

**Call relations**: It exercises the full non-tool branch of `handle_output_item_done`, including contributor execution and fact extraction. The test proves that `finalize_non_tool_response_item` feeds its derived facts back into the returned output.

*Call graph*: calls 7 internal fn (make_session_and_context, assistant_output_text, new, from_turn_context, new, new, new); 8 external calls (clone, new, new, default, new, assert_eq!, handle_output_item_done, new).


##### `finalized_turn_item_defers_mailbox_for_contributed_visible_text`  (lines 317–340)

```
async fn finalized_turn_item_defers_mailbox_for_contributed_visible_text()
```

**Purpose**: Checks that mailbox deferral is based on the finalized contributed visible text, even when the original raw assistant message contained only hidden markup. This guards the interaction between contributors and mailbox policy.

**Data flow**: The test creates a session/context with `RewriteAgentMessageContributor`, builds a turn store, creates an assistant message containing only hidden citation markup, calls `finalize_non_tool_response_item` with contributor execution enabled, and asserts that `facts.last_agent_message` is the contributed text and `facts.defers_mailbox_delivery_to_next_turn` is true.

**Call relations**: It targets the fact-derivation logic in `finalize_non_tool_response_item`. The test demonstrates that contributor rewrites happen before mailbox-deferral decisions are computed.

*Call graph*: calls 4 internal fn (make_session_and_context, assistant_output_text, new, new); 5 external calls (new, assert!, assert_eq!, Run, finalize_non_tool_response_item).


##### `finalized_turn_item_keeps_mailbox_open_for_commentary_text`  (lines 343–366)

```
async fn finalized_turn_item_keeps_mailbox_open_for_commentary_text()
```

**Purpose**: Verifies that commentary-phase assistant messages do not defer mailbox delivery, even when contributors rewrite them to visible text. Commentary remains non-terminal for mailbox purposes.

**Data flow**: The test sets up a session/context with `RewriteAgentMessageContributor`, creates a commentary-phase assistant message, finalizes it with `finalize_non_tool_response_item`, and asserts that the contributed text appears in `facts.last_agent_message` while `facts.defers_mailbox_delivery_to_next_turn` is false.

**Call relations**: This test covers the commentary exception in mailbox-deferral fact derivation. It complements the prior test by showing that visible text alone is not sufficient when phase is commentary.

*Call graph*: calls 4 internal fn (make_session_and_context, assistant_output_text_with_phase, new, new); 5 external calls (new, assert!, assert_eq!, Run, finalize_non_tool_response_item).


##### `last_assistant_message_from_item_strips_citations_and_plan_blocks`  (lines 369–378)

```
fn last_assistant_message_from_item_strips_citations_and_plan_blocks()
```

**Purpose**: Ensures that `last_assistant_message_from_item` removes both memory citations and proposed-plan blocks in plan mode, leaving only visible assistant text. It documents the exact stripping behavior for plan-mode messages.

**Data flow**: The test builds an assistant message containing visible text before and after hidden citation and `<proposed_plan>` markup, calls `last_assistant_message_from_item(&item, true)`, unwraps the result, and asserts it equals `before\nafter`.

**Call relations**: It directly exercises the helper used by mailbox-deferral logic. The test validates the composition of citation stripping and plan-block stripping.

*Call graph*: calls 1 internal fn (assistant_output_text); 2 external calls (assert_eq!, last_assistant_message_from_item).


##### `last_assistant_message_from_item_returns_none_for_citation_only_message`  (lines 381–388)

```
fn last_assistant_message_from_item_returns_none_for_citation_only_message()
```

**Purpose**: Checks that an assistant message containing only hidden citation markup yields no visible last message. This prevents hidden-only output from being treated as user-visible text.

**Data flow**: The test constructs a citation-only assistant message with `assistant_output_text`, calls `last_assistant_message_from_item(&item, false)`, and asserts the result is `None`.

**Call relations**: It covers the empty-after-stripping branch of `last_assistant_message_from_item`. This behavior feeds into mailbox-deferral decisions for hidden-only messages.

*Call graph*: calls 1 internal fn (assistant_output_text); 1 external calls (assert_eq!).


##### `last_assistant_message_from_item_returns_none_for_plan_only_hidden_message`  (lines 391–398)

```
fn last_assistant_message_from_item_returns_none_for_plan_only_hidden_message()
```

**Purpose**: Verifies that a plan-mode assistant message containing only a hidden proposed-plan block yields no visible last message. This keeps hidden planning scaffolding out of visible-message logic.

**Data flow**: The test creates an assistant message containing only `<proposed_plan>` markup, calls `last_assistant_message_from_item(&item, true)`, and asserts the result is `None`.

**Call relations**: It complements the citation-only test by covering the plan-block stripping path. Together they define when hidden-only content should disappear entirely.

*Call graph*: calls 1 internal fn (assistant_output_text); 1 external calls (assert_eq!).


##### `completed_item_defers_mailbox_delivery_for_unknown_phase_messages`  (lines 401–407)

```
fn completed_item_defers_mailbox_delivery_for_unknown_phase_messages()
```

**Purpose**: Checks that assistant messages with visible text and no explicit phase are treated as terminal enough to defer mailbox delivery to the next turn. Untagged providers default to the safer behavior.

**Data flow**: The test builds a plain assistant message with `assistant_output_text`, calls `completed_item_defers_mailbox_delivery_to_next_turn(&item, false)`, and asserts the result is true.

**Call relations**: It directly validates the default mailbox policy encoded in `completed_item_defers_mailbox_delivery_to_next_turn` for `phase: None`.

*Call graph*: calls 1 internal fn (assistant_output_text); 1 external calls (assert!).


##### `completed_item_keeps_mailbox_delivery_open_for_commentary_messages`  (lines 410–416)

```
fn completed_item_keeps_mailbox_delivery_open_for_commentary_messages()
```

**Purpose**: Verifies that commentary-phase assistant messages do not defer mailbox delivery. Commentary is treated as in-progress output rather than a final answer.

**Data flow**: The test creates a commentary-phase assistant message with `assistant_output_text_with_phase`, calls `completed_item_defers_mailbox_delivery_to_next_turn`, and asserts the result is false.

**Call relations**: It covers the commentary branch of the mailbox-deferral helper and complements the unknown-phase positive test.

*Call graph*: calls 1 internal fn (assistant_output_text_with_phase); 1 external calls (assert!).


##### `completed_item_defers_mailbox_delivery_for_image_generation_calls`  (lines 419–431)

```
fn completed_item_defers_mailbox_delivery_for_image_generation_calls()
```

**Purpose**: Ensures that completed image-generation calls always defer mailbox delivery to the next turn. Image generation is treated as terminal visible output for mailbox purposes.

**Data flow**: The test constructs a `ResponseItem::ImageGenerationCall` with completed status and base64 result, calls `completed_item_defers_mailbox_delivery_to_next_turn`, and asserts the result is true.

**Call relations**: It validates the non-message branch of mailbox-deferral policy for image generation.

*Call graph*: 1 external calls (assert!).


##### `save_image_generation_result_saves_base64_to_png_in_codex_home`  (lines 434–448)

```
async fn save_image_generation_result_saves_base64_to_png_in_codex_home()
```

**Purpose**: Verifies that a standard base64 image payload is decoded and written to the expected PNG path under codex home. It also checks the file contents match the decoded bytes.

**Data flow**: The test creates a temporary codex home, computes the expected path with `image_generation_artifact_path`, removes any preexisting file, calls `save_image_generation_result(..., "Zm9v")`, asserts the returned path equals the expected path, reads the file back and asserts its bytes are `b"foo"`, then removes the file.

**Call relations**: This test exercises the happy path of image artifact persistence, including path construction and overwrite-capable file writing.

*Call graph*: 5 external calls (assert_eq!, remove_file, image_generation_artifact_path, save_image_generation_result, tempdir).


##### `save_image_generation_result_rejects_data_url_payload`  (lines 451–460)

```
async fn save_image_generation_result_rejects_data_url_payload()
```

**Purpose**: Checks that data-URL style payloads are rejected instead of being treated as raw base64 image data. This prevents accidental acceptance of unsupported formats.

**Data flow**: The test creates a temporary codex home, calls `save_image_generation_result` with `data:image/jpeg;base64,Zm9v`, expects an error, and asserts the error matches `CodexErr::InvalidRequest(_)`.

**Call relations**: It validates the strict base64-decoding policy in `save_image_generation_result`, specifically rejecting prefixed data URLs.

*Call graph*: 3 external calls (assert!, save_image_generation_result, tempdir).


##### `save_image_generation_result_overwrites_existing_file`  (lines 463–482)

```
async fn save_image_generation_result_overwrites_existing_file()
```

**Purpose**: Verifies that saving an image generation result overwrites an existing file at the target path. This documents the write semantics for repeated call IDs.

**Data flow**: The test creates a temporary codex home, computes the target path, creates parent directories, seeds the file with `existing`, calls `save_image_generation_result(..., "Zm9v")`, then asserts the returned path is unchanged and the file contents are now `b"foo"` before cleanup.

**Call relations**: It exercises the filesystem behavior of `tokio::fs::write` as used by `save_image_generation_result`, confirming replacement rather than append/failure semantics.

*Call graph*: 7 external calls (assert_eq!, create_dir_all, remove_file, write, image_generation_artifact_path, save_image_generation_result, tempdir).


##### `save_image_generation_result_sanitizes_call_id_for_codex_home_output_path`  (lines 485–498)

```
async fn save_image_generation_result_sanitizes_call_id_for_codex_home_output_path()
```

**Purpose**: Ensures that unsafe call IDs containing path traversal characters are sanitized into a safe artifact filename under codex home. This guards against directory escape via call IDs.

**Data flow**: The test creates a temporary codex home, computes the expected sanitized path with `image_generation_artifact_path(&codex_home, "session-1", "../ig/..")`, removes any preexisting file, saves base64 data with that unsafe call ID, and asserts the returned path equals the sanitized expected path and contains the decoded bytes.

**Call relations**: It validates the sanitizer embedded in `image_generation_artifact_path` as exercised through `save_image_generation_result`.

*Call graph*: 5 external calls (assert_eq!, remove_file, image_generation_artifact_path, save_image_generation_result, tempdir).


##### `save_image_generation_result_rejects_non_standard_base64`  (lines 501–508)

```
async fn save_image_generation_result_rejects_non_standard_base64()
```

**Purpose**: Checks that URL-safe or otherwise non-standard base64 payloads are rejected. The save path accepts only standard base64 encoding.

**Data flow**: The test creates a temporary codex home, calls `save_image_generation_result` with the payload `_-8`, expects an error, and asserts it matches `CodexErr::InvalidRequest(_)`.

**Call relations**: It documents the decoder choice in `save_image_generation_result` by proving non-standard base64 is not silently accepted.

*Call graph*: 3 external calls (assert!, save_image_generation_result, tempdir).


##### `save_image_generation_result_rejects_non_base64_data_urls`  (lines 511–523)

```
async fn save_image_generation_result_rejects_non_base64_data_urls()
```

**Purpose**: Verifies that non-base64 data URLs such as inline SVG are rejected as invalid requests. This closes another malformed-payload path.

**Data flow**: The test creates a temporary codex home, calls `save_image_generation_result` with `data:image/svg+xml,<svg/>`, expects an error, and asserts it matches `CodexErr::InvalidRequest(_)`.

**Call relations**: It complements the other malformed-payload tests by covering non-base64 data URLs specifically.

*Call graph*: 3 external calls (assert!, save_image_generation_result, tempdir).


### `core/src/thread_rollout_truncation_tests.rs`

`test` · `test execution`

This test file validates the pure truncation logic in `thread_rollout_truncation.rs`. It defines compact constructors for user, assistant, and developer `ResponseItem::Message` values, plus helpers that build inter-agent communications either as embedded response items or as explicit `RolloutItem::InterAgentCommunication` values. The tests for `truncate_rollout_before_nth_user_message_from_start` verify strict cutting before the nth user message, the `usize::MAX` no-op case, rollback-aware indexing after `ThreadRolledBack`, and the rule that session startup context should not be counted as user turns.

The second half focuses on fork-turn semantics. These tests show that `truncate_rollout_to_last_n_fork_turns` counts both real user messages and trigger-turn inter-agent messages, including explicit `InterAgentCommunication` rollout items and legacy assistant envelopes carrying the same metadata. They also verify that when the requested number of fork turns exceeds what exists, truncation still drops startup prefix by starting at the first fork-turn boundary. Several rollback tests confirm that rollback markers remove stale trigger boundaries and assistant instruction turns from the effective suffix, while zero-turn rollbacks are ignored. Together these tests document the intended distinction between rollback-counted instruction turns and the mixed set of fork-turn boundaries retained for suffix truncation.

#### Function details

##### `user_msg`  (lines 10–20)

```
fn user_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a minimal user message response item for truncation tests.

**Data flow**: Takes `text`, wraps it in `ContentItem::OutputText`, and returns `ResponseItem::Message` with role `user` and unset optional fields.

**Call relations**: Used throughout the test cases that construct synthetic rollout histories.

*Call graph*: called by 2 (ignores_session_prefix_messages_when_truncating_rollout_from_start, truncates_rollout_from_start_before_nth_user_only); 1 external calls (vec!).


##### `assistant_msg`  (lines 22–32)

```
fn assistant_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a minimal assistant message response item for truncation tests.

**Data flow**: Takes `text`, wraps it in `ContentItem::OutputText`, and returns `ResponseItem::Message` with role `assistant`.

**Call relations**: Used alongside `user_msg` in synthetic rollout histories.

*Call graph*: called by 2 (ignores_session_prefix_messages_when_truncating_rollout_from_start, truncates_rollout_from_start_before_nth_user_only); 1 external calls (vec!).


##### `developer_msg`  (lines 34–44)

```
fn developer_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a developer message response item used to represent startup context in tests.

**Data flow**: Takes `text`, wraps it in `ContentItem::InputText`, and returns `ResponseItem::Message` with role `developer`.

**Call relations**: Used in the test that verifies startup prefix is dropped even when under the requested fork-turn limit.

*Call graph*: 1 external calls (vec!).


##### `inter_agent_msg`  (lines 46–55)

```
fn inter_agent_msg(text: &str, trigger_turn: bool) -> ResponseItem
```

**Purpose**: Builds a legacy response-item representation of inter-agent communication with a configurable `trigger_turn` flag.

**Data flow**: Constructs an `InterAgentCommunication` from root to `/root/worker`, with empty attachments and the supplied text/flag, converts it to a response input item, and then into `ResponseItem`.

**Call relations**: Used in tests that verify trigger-turn assistant envelopes count as fork-turn boundaries.

*Call graph*: calls 3 internal fn (root, try_from, new); 1 external calls (new).


##### `inter_agent_communication`  (lines 57–65)

```
fn inter_agent_communication(text: &str, trigger_turn: bool) -> RolloutItem
```

**Purpose**: Builds an explicit `RolloutItem::InterAgentCommunication` with a configurable `trigger_turn` flag.

**Data flow**: Constructs `InterAgentCommunication` from root to `/root/worker` and wraps it directly in `RolloutItem::InterAgentCommunication`.

**Call relations**: Used to test fork-turn detection from explicit rollout-item communications rather than embedded response items.

*Call graph*: calls 3 internal fn (root, try_from, new); 2 external calls (new, InterAgentCommunication).


##### `truncates_rollout_from_start_before_nth_user_only`  (lines 68–119)

```
fn truncates_rollout_from_start_before_nth_user_only()
```

**Purpose**: Verifies prefix truncation before the nth user message and no truncation when the requested boundary is beyond the available user turns.

**Data flow**: Builds a mixed rollout of user, assistant, reasoning, and function-call items, truncates before user turn 1 and 2, and compares serialized results to the expected prefix and full rollout.

**Call relations**: Directly exercises `truncate_rollout_before_nth_user_message_from_start`.

*Call graph*: calls 2 internal fn (assistant_msg, user_msg); 2 external calls (assert_eq!, vec!).


##### `truncation_max_keeps_full_rollout`  (lines 122–135)

```
fn truncation_max_keeps_full_rollout()
```

**Purpose**: Checks that `usize::MAX` disables start-based truncation.

**Data flow**: Builds a short rollout, calls `truncate_rollout_before_nth_user_message_from_start(&rollout, usize::MAX)`, and asserts the serialized result equals the original rollout.

**Call relations**: Covers the explicit no-op branch in start truncation.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_from_start_applies_thread_rollback_markers`  (lines 138–164)

```
fn truncates_rollout_from_start_applies_thread_rollback_markers()
```

**Purpose**: Verifies that user-turn indexing honors `ThreadRolledBack` markers when deciding where to cut.

**Data flow**: Builds a rollout with user turns `u1`, `u2`, rollback(1), then `u3`, `u4`; truncates before effective user turn index 2 and asserts the result cuts before `u4`, reflecting effective history `u1, u3, u4`.

**Call relations**: Tests rollback-aware user-boundary computation.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `ignores_session_prefix_messages_when_truncating_rollout_from_start`  (lines 167–196)

```
async fn ignores_session_prefix_messages_when_truncating_rollout_from_start()
```

**Purpose**: Ensures session startup context does not count as user-turn boundaries for start truncation.

**Data flow**: Builds a real session initial context, appends two user turns and assistant replies, truncates before the second user turn, and asserts the result keeps the startup prefix plus the first user turn only.

**Call relations**: Mirrors the corresponding thread-manager helper test at the lower-level truncation API.

*Call graph*: calls 3 internal fn (make_session_and_context, assistant_msg, user_msg); 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_counts_trigger_turn_messages`  (lines 199–224)

```
fn truncates_rollout_to_last_n_fork_turns_counts_trigger_turn_messages()
```

**Purpose**: Checks that suffix truncation counts trigger-turn inter-agent messages as fork-turn boundaries alongside user messages.

**Data flow**: Builds a rollout containing user turns, assistant replies, a non-trigger inter-agent message, and a trigger-turn inter-agent message, truncates to the last two fork turns, and asserts the retained suffix starts at the trigger-turn message.

**Call relations**: Exercises `truncate_rollout_to_last_n_fork_turns` with legacy embedded trigger-turn messages.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `fork_turn_positions_use_inter_agent_delivery_metadata`  (lines 227–238)

```
fn fork_turn_positions_use_inter_agent_delivery_metadata()
```

**Purpose**: Verifies that explicit `RolloutItem::InterAgentCommunication` items contribute fork-turn boundaries based on their `trigger_turn` metadata.

**Data flow**: Builds a rollout with a user task, a non-trigger communication, an assistant answer, a trigger communication, another answer, and a second user task; asserts `fork_turn_positions_in_rollout` returns indices `[0, 3, 5]`.

**Call relations**: Directly tests fork-turn boundary detection from explicit communication items.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_drops_startup_prefix_even_when_under_limit`  (lines 241–255)

```
fn truncates_rollout_to_last_n_fork_turns_drops_startup_prefix_even_when_under_limit()
```

**Purpose**: Checks that suffix truncation still removes startup developer context even when fewer fork turns exist than requested.

**Data flow**: Builds a rollout with developer startup context followed by one user turn and an answer, truncates to the last two fork turns, and asserts the result starts at the user turn rather than keeping the developer prefix.

**Call relations**: Covers the branch that falls back to the first fork-turn boundary when under the requested limit.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_applies_thread_rollback_markers`  (lines 258–280)

```
fn truncates_rollout_to_last_n_fork_turns_applies_thread_rollback_markers()
```

**Purpose**: Verifies that rollback markers are applied when computing the suffix that keeps the last N fork turns.

**Data flow**: Builds a rollout with a user turn, a trigger-turn message, rollback(1), then another user turn, truncates to the last two fork turns, and asserts the full rollout is retained because the effective fork turns are the first user turn and the later user turn.

**Call relations**: Tests rollback-aware fork-turn computation.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `fork_turn_positions_ignore_zero_turn_rollback_markers`  (lines 283–297)

```
fn fork_turn_positions_ignore_zero_turn_rollback_markers()
```

**Purpose**: Checks that rollback markers with `num_turns: 0` do not alter fork-turn positions.

**Data flow**: Builds a rollout with a user turn, a trigger-turn message, rollback(0), and another user turn, then asserts `fork_turn_positions_in_rollout` returns all three boundaries unchanged.

**Call relations**: Covers the explicit zero-turn rollback fast path.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_discards_trigger_boundaries_in_rolled_back_suffix`  (lines 300–324)

```
fn truncates_rollout_to_last_n_fork_turns_discards_trigger_boundaries_in_rolled_back_suffix()
```

**Purpose**: Verifies that trigger-turn boundaries inside a rolled-back suffix are removed from the effective fork-turn list.

**Data flow**: Builds a rollout with two user turns, a trigger-turn message, an assistant reply, rollback(1), then a third user turn; truncates to the last two fork turns and asserts the retained suffix starts at the second user turn, not the rolled-back trigger boundary.

**Call relations**: Tests the retain-before-rollback-start behavior in fork-turn rollback handling.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_discards_rolled_back_assistant_instruction_turns`  (lines 327–353)

```
fn truncates_rollout_to_last_n_fork_turns_discards_rolled_back_assistant_instruction_turns()
```

**Purpose**: Checks that rollback removes stale assistant instruction-turn boundaries so only surviving trigger turns are considered.

**Data flow**: Builds a rollout with a user turn, a trigger-turn message, rollback(1), then a second trigger-turn message; truncates to the last one fork turn and asserts the retained suffix starts at the second trigger-turn message.

**Call relations**: Exercises rollback handling where the removed turn is an assistant-triggered instruction turn rather than a user turn.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_keeps_full_rollout_when_n_is_large`  (lines 356–373)

```
fn truncates_rollout_to_last_n_fork_turns_keeps_full_rollout_when_n_is_large()
```

**Purpose**: Verifies that requesting more fork turns than exist keeps the full rollout from the first fork-turn boundary onward.

**Data flow**: Builds a rollout beginning with a user turn and later containing a trigger-turn message, truncates to the last 10 fork turns, and asserts the serialized result equals the original rollout.

**Call relations**: Covers the under-limit behavior when the first item is already a fork-turn boundary.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/turn_metadata_tests.rs`

`test` · `test execution; validates metadata serialization and enrichment during request construction`

This file exercises `TurnMetadataState` and `detached_memory_responses_metadata` by serializing metadata to JSON and asserting exact field presence, absence, and precedence. Several small helpers keep the tests focused: `test_mcp_turn_metadata_context` supplies a stable model/reasoning-effort pair; `test_responses_metadata_json`, `test_turn_responses_metadata_json`, and `test_compaction_responses_metadata_json` serialize `CodexResponsesMetadata` for different request kinds; and `test_turn_metadata_header` serializes the raw template header without request overlays.

`create_clean_git_repo` builds a real temporary Git repository with an initial commit, allowing tests to verify workspace metadata and asynchronous enrichment against actual Git state. The detached-memory tests confirm that memory requests emit `request_kind = memory`, omit turn/session/window identity, preserve ASCII-safe serialization, and include workspace metadata only when non-empty.

The remaining tests focus on `TurnMetadataState` semantics: sandbox tags come from `permission_profile_sandbox_tag`; lineage fields differ between root forks and subagent parents; `turn_started_at_unix_ms` appears only after being set; model, reasoning effort, and `user_input_requested_during_turn` appear only in MCP request metadata, not in the base header; client metadata is filtered so reserved keys cannot override state-owned fields, while non-reserved keys like `fiber_run_id`, `origin`, and `workspace_kind` survive; compaction metadata is overlaid only on compaction requests; and asynchronous Git enrichment populates workspace metadata without disturbing lineage fields. Many assertions parse JSON into `serde_json::Value` and inspect exact keys, making these tests a specification for metadata shape and precedence.

#### Function details

##### `test_mcp_turn_metadata_context`  (lines 26–31)

```
fn test_mcp_turn_metadata_context() -> McpTurnMetadataContext<'static>
```

**Purpose**: Provides a stable MCP metadata context used across tests that inspect model and reasoning-effort overlays.

**Data flow**: Returns `McpTurnMetadataContext { model: "gpt-5.4", reasoning_effort: Some(High) }` with no inputs or side effects.

**Call relations**: Used by tests that call `current_meta_value_for_mcp_request`.

*Call graph*: called by 3 (turn_metadata_state_includes_model_and_reasoning_effort_only_in_request_meta, turn_metadata_state_marks_user_input_requested_during_turn_only_for_mcp_request_meta, turn_metadata_state_merges_client_metadata_without_replacing_reserved_fields).


##### `test_responses_metadata_json`  (lines 33–46)

```
fn test_responses_metadata_json(
    state: &TurnMetadataState,
    window_id: &str,
    request_kind: CodexResponsesRequestKind,
) -> String
```

**Purpose**: Serializes a state's Responses metadata for a given window id and request kind into JSON text.

**Data flow**: Calls `state.to_responses_metadata(...)` with fixed installation id `installation-a`, the provided window id and request kind, then calls `turn_metadata_json()` and unwraps the result.

**Call relations**: Shared helper used by the turn and compaction serialization wrappers.

*Call graph*: calls 1 internal fn (to_responses_metadata); called by 2 (test_compaction_responses_metadata_json, test_turn_responses_metadata_json).


##### `test_turn_responses_metadata_json`  (lines 48–50)

```
fn test_turn_responses_metadata_json(state: &TurnMetadataState, window_id: &str) -> String
```

**Purpose**: Convenience wrapper that serializes normal turn-request metadata JSON.

**Data flow**: Delegates to `test_responses_metadata_json` with `CodexResponsesRequestKind::Turn`.

**Call relations**: Used in tests that compare regular turn requests against compaction or MCP metadata.

*Call graph*: calls 1 internal fn (test_responses_metadata_json); called by 2 (turn_metadata_state_merges_client_metadata_without_replacing_reserved_fields, turn_metadata_state_overlays_compaction_only_on_compaction_requests).


##### `test_compaction_responses_metadata_json`  (lines 52–62)

```
fn test_compaction_responses_metadata_json(
    state: &TurnMetadataState,
    window_id: &str,
    compaction: CompactionTurnMetadata,
) -> String
```

**Purpose**: Convenience wrapper that serializes compaction-request metadata JSON.

**Data flow**: Delegates to `test_responses_metadata_json` with `CodexResponsesRequestKind::Compaction(compaction)`.

**Call relations**: Used by the compaction-overlay test.

*Call graph*: calls 1 internal fn (test_responses_metadata_json); called by 1 (turn_metadata_state_overlays_compaction_only_on_compaction_requests); 1 external calls (Compaction).


##### `test_turn_metadata_header`  (lines 64–69)

```
fn test_turn_metadata_header(state: &TurnMetadataState) -> String
```

**Purpose**: Serializes the raw metadata template header from a `TurnMetadataState` without adding request-scoped installation/window/request-kind fields.

**Data flow**: Calls `state.responses_metadata_template().turn_metadata_json()` and unwraps the resulting JSON string.

**Call relations**: Used by many tests that inspect the base header shape and reserved-field precedence.

*Call graph*: calls 1 internal fn (responses_metadata_template); called by 11 (turn_metadata_state_ignores_client_reserved_metadata_before_start, turn_metadata_state_includes_forked_thread_spawn_subagent_lineage, turn_metadata_state_includes_known_parent_for_non_thread_spawn_subagents_without_fork, turn_metadata_state_includes_model_and_reasoning_effort_only_in_request_meta, turn_metadata_state_includes_root_fork_lineage, turn_metadata_state_includes_thread_spawn_subagent_parent_without_fork, turn_metadata_state_includes_turn_started_at_unix_ms_after_start, turn_metadata_state_marks_user_input_requested_during_turn_only_for_mcp_request_meta, turn_metadata_state_merges_client_metadata_without_replacing_reserved_fields, turn_metadata_state_preserves_lineage_after_git_enrichment (+1 more)).


##### `create_clean_git_repo`  (lines 71–109)

```
async fn create_clean_git_repo(repo_name: &str) -> (TempDir, AbsolutePathBuf)
```

**Purpose**: Creates a temporary Git repository with user config, one committed `README.md`, and returns both the tempdir handle and absolute repo path.

**Data flow**: Creates a temp dir, creates the repo directory, runs `git init`, configures user name/email, writes `README.md`, runs `git add .` and `git commit -m initial`, then returns `(TempDir, AbsolutePathBuf)`.

**Call relations**: Used by detached-memory and Git-enrichment tests to provide real repository state.

*Call graph*: called by 2 (detached_memory_responses_metadata_omits_turn_identity, turn_metadata_state_preserves_lineage_after_git_enrichment); 4 external calls (new, new, create_dir_all, write).


##### `detached_memory_responses_metadata_omits_turn_identity`  (lines 112–154)

```
async fn detached_memory_responses_metadata_omits_turn_identity()
```

**Purpose**: Verifies that detached memory metadata includes memory request kind and workspace Git info but omits turn/session/thread/window identity fields.

**Data flow**: Creates a clean Git repo with a non-ASCII name, calls `detached_memory_responses_metadata`, serializes to JSON, asserts ASCII-safe output and absence of the repo-name Unicode text, parses JSON, and checks request kind, omitted identity fields, workspace path, and `has_changes = false`.

**Call relations**: Exercises the detached-memory helper on a real Git repository.

*Call graph*: calls 1 internal fn (create_clean_git_repo); 4 external calls (new, assert!, assert_eq!, from_str).


##### `detached_memory_responses_metadata_omits_empty_workspace_metadata`  (lines 157–176)

```
async fn detached_memory_responses_metadata_omits_empty_workspace_metadata()
```

**Purpose**: Checks that detached memory metadata collapses to just `{"request_kind":"memory"}` when no Git workspace metadata is available.

**Data flow**: Creates a plain temp directory, calls `detached_memory_responses_metadata` with no sandbox, serializes and parses the JSON, and asserts exact equality with a one-field JSON object.

**Call relations**: Covers the empty-workspace suppression path in `memory_workspaces`.

*Call graph*: 4 external calls (new, new, assert_eq!, from_str).


##### `turn_metadata_state_uses_platform_sandbox_tag`  (lines 179–216)

```
fn turn_metadata_state_uses_platform_sandbox_tag()
```

**Purpose**: Verifies that a new turn metadata state serializes the sandbox tag derived from the permission profile and includes session/thread ids while omitting lineage and request-kind fields.

**Data flow**: Creates a temp cwd and read-only permission profile, constructs `TurnMetadataState::new`, serializes the header, parses JSON, computes the expected sandbox tag with `permission_profile_sandbox_tag`, and asserts field values and omissions.

**Call relations**: Covers baseline header serialization for a normal exec session.

*Call graph*: calls 4 internal fn (permission_profile_sandbox_tag, new, test_turn_metadata_header, read_only); 4 external calls (new, assert!, assert_eq!, from_str).


##### `turn_metadata_state_includes_root_fork_lineage`  (lines 219–248)

```
fn turn_metadata_state_includes_root_fork_lineage()
```

**Purpose**: Checks that a root-forked thread records `forked_from_thread_id` but no parent-thread or subagent-kind fields.

**Data flow**: Creates a state with `forked_from_thread_id = Some(...)` and no parent, serializes the header, parses JSON, and asserts the fork lineage field is present while parent and subagent fields are absent.

**Call relations**: Exercises one lineage configuration of `TurnMetadataState::new`.

*Call graph*: calls 4 internal fn (new, test_turn_metadata_header, read_only, from_string); 4 external calls (new, assert!, assert_eq!, from_str).


##### `turn_metadata_state_includes_thread_spawn_subagent_parent_without_fork`  (lines 251–286)

```
fn turn_metadata_state_includes_thread_spawn_subagent_parent_without_fork()
```

**Purpose**: Verifies that a thread-spawn subagent without a fork records `parent_thread_id` and `subagent_kind = thread_spawn` but no fork lineage.

**Data flow**: Constructs a state whose `SessionSource` is `SubAgent(ThreadSpawn { ... })` and whose parent thread id is set, serializes the header, parses JSON, and asserts the expected lineage fields.

**Call relations**: Covers subagent lineage derivation from session source.

*Call graph*: calls 4 internal fn (new, test_turn_metadata_header, read_only, from_string); 5 external calls (new, SubAgent, assert!, assert_eq!, from_str).


##### `turn_metadata_state_includes_forked_thread_spawn_subagent_lineage`  (lines 289–327)

```
fn turn_metadata_state_includes_forked_thread_spawn_subagent_lineage()
```

**Purpose**: Checks that a forked thread-spawn subagent can carry both `forked_from_thread_id` and `parent_thread_id`, with `subagent_kind = thread_spawn`.

**Data flow**: Constructs a state with both lineage ids set to the same thread id and a thread-spawn subagent source, serializes the header, parses JSON, and asserts all three fields.

**Call relations**: Exercises combined fork-plus-parent lineage serialization.

*Call graph*: calls 4 internal fn (new, test_turn_metadata_header, read_only, from_string); 4 external calls (new, SubAgent, assert_eq!, from_str).


##### `turn_metadata_state_includes_known_parent_for_non_thread_spawn_subagents_without_fork`  (lines 330–369)

```
fn turn_metadata_state_includes_known_parent_for_non_thread_spawn_subagents_without_fork()
```

**Purpose**: Verifies that non-thread-spawn subagent sources still serialize a known `parent_thread_id` and the correct `subagent_kind` string when no fork lineage exists.

**Data flow**: Loops over `Review`, `Other("guardian")`, and `Other("agent_job:job-1")`, constructing a state for each with the same parent thread id, serializing the header, parsing JSON, and asserting parent lineage plus the expected subagent-kind string.

**Call relations**: Covers multiple `SessionSource::SubAgent` variants and their metadata mapping.

*Call graph*: calls 4 internal fn (new, test_turn_metadata_header, read_only, from_string); 6 external calls (new, SubAgent, assert!, assert_eq!, Other, from_str).


##### `turn_metadata_state_includes_turn_started_at_unix_ms_after_start`  (lines 372–398)

```
fn turn_metadata_state_includes_turn_started_at_unix_ms_after_start()
```

**Purpose**: Checks that `turn_started_at_unix_ms` appears in serialized metadata only after being explicitly set.

**Data flow**: Creates a state, calls `set_turn_started_at_unix_ms(1_700_000_000_123)`, serializes the header, parses JSON, and asserts the timestamp field equals that value.

**Call relations**: Validates the mutable timestamp field in `TurnMetadataState`.

*Call graph*: calls 3 internal fn (new, test_turn_metadata_header, read_only); 3 external calls (new, assert_eq!, from_str).


##### `turn_metadata_state_includes_model_and_reasoning_effort_only_in_request_meta`  (lines 401–446)

```
fn turn_metadata_state_includes_model_and_reasoning_effort_only_in_request_meta()
```

**Purpose**: Verifies that model and reasoning-effort fields are absent from the base header but present in MCP request metadata, and that reasoning effort is omitted when not supplied.

**Data flow**: Creates a state, serializes the base header and checks absence of `model` and `reasoning_effort`, then calls `current_meta_value_for_mcp_request` twice—once with `High` reasoning effort and once with `None`—and asserts the resulting JSON fields accordingly.

**Call relations**: Exercises the MCP-specific overlay logic in `current_meta_value_for_mcp_request`.

*Call graph*: calls 4 internal fn (new, test_mcp_turn_metadata_context, test_turn_metadata_header, read_only); 4 external calls (new, assert!, assert_eq!, from_str).


##### `turn_metadata_state_marks_user_input_requested_during_turn_only_for_mcp_request_meta`  (lines 449–498)

```
fn turn_metadata_state_marks_user_input_requested_during_turn_only_for_mcp_request_meta()
```

**Purpose**: Checks that the user-input-requested flag affects only MCP request metadata and never the base header.

**Data flow**: Creates a state, serializes the header and MCP metadata before marking to confirm absence, calls `mark_user_input_requested_during_turn()`, serializes again, and asserts the header still omits the field while MCP metadata now contains `true`.

**Call relations**: Validates the atomic flag's limited serialization scope.

*Call graph*: calls 4 internal fn (new, test_mcp_turn_metadata_context, test_turn_metadata_header, read_only); 4 external calls (new, assert!, assert_eq!, from_str).


##### `turn_metadata_state_ignores_client_reserved_metadata_before_start`  (lines 501–541)

```
fn turn_metadata_state_ignores_client_reserved_metadata_before_start()
```

**Purpose**: Verifies that client-supplied values for reserved metadata keys are filtered out and do not appear in the base header before any state-owned values are set.

**Data flow**: Creates a state, calls `set_responsesapi_client_metadata` with reserved keys like `turn_started_at_unix_ms`, `forked_from_thread_id`, `parent_thread_id`, and `subagent_kind`, serializes the header, parses JSON, and asserts those keys are absent.

**Call relations**: Exercises `filter_extra_metadata` and reserved-field protection.

*Call graph*: calls 3 internal fn (new, test_turn_metadata_header, read_only); 4 external calls (from, new, assert!, from_str).


##### `turn_metadata_state_merges_client_metadata_without_replacing_reserved_fields`  (lines 544–669)

```
fn turn_metadata_state_merges_client_metadata_without_replacing_reserved_fields()
```

**Purpose**: Checks that non-reserved client metadata survives serialization while reserved fields remain owned by state, and that Responses-request overlays add installation/window ids only where appropriate.

**Data flow**: Creates a state with fork and parent lineage, sets a large client metadata map containing both allowed and reserved keys, sets turn-start time, serializes the base header and parses it to assert allowed keys (`fiber_run_id`, `origin`, `workspace_kind`, client `model`) survive while reserved ids and lineage fields come from state. It then serializes a normal turn request to assert `request_kind`, installation id, and window id overlays, and finally inspects MCP metadata and `workspace_kind()`.

**Call relations**: This is the most comprehensive reserved-versus-extra metadata precedence test.

*Call graph*: calls 6 internal fn (new, test_mcp_turn_metadata_context, test_turn_metadata_header, test_turn_responses_metadata_json, read_only, from_string); 6 external calls (from, new, SubAgent, assert!, assert_eq!, from_str).


##### `turn_metadata_state_overlays_compaction_only_on_compaction_requests`  (lines 672–723)

```
fn turn_metadata_state_overlays_compaction_only_on_compaction_requests()
```

**Purpose**: Verifies that compaction metadata is injected only for compaction requests and not for ordinary turn requests, even if client metadata contains a `compaction` key.

**Data flow**: Creates a state, stores client metadata with `compaction`, serializes a compaction request using `CompactionTurnMetadata::new(...)`, parses and asserts the structured compaction object and request kind, then serializes a regular turn request and asserts `compaction` is absent there.

**Call relations**: Exercises request-kind-specific overlay behavior in `to_responses_metadata` consumers.

*Call graph*: calls 5 internal fn (new, new, test_compaction_responses_metadata_json, test_turn_responses_metadata_json, read_only); 5 external calls (from, new, assert!, assert_eq!, from_str).


##### `turn_metadata_state_preserves_lineage_after_git_enrichment`  (lines 726–779)

```
async fn turn_metadata_state_preserves_lineage_after_git_enrichment()
```

**Purpose**: Checks that asynchronous Git enrichment eventually populates workspace metadata without disturbing existing lineage fields.

**Data flow**: Creates a clean Git repo, constructs a state with both fork and parent lineage and a thread-spawn subagent source, calls `spawn_git_enrichment_task()`, then polls serialized header JSON inside a timeout loop until `workspaces` becomes non-empty. It finally asserts the lineage fields remain correct.

**Call relations**: Exercises the background enrichment task together with concurrent header serialization.

*Call graph*: calls 5 internal fn (new, create_clean_git_repo, test_turn_metadata_header, read_only, from_string); 7 external calls (from_millis, from_secs, SubAgent, assert_eq!, from_str, sleep, timeout).


### `core/src/turn_diff_tracker_tests.rs`

`test` · `test execution; validates turn-level diff accumulation and rendering`

This test file drives `TurnDiffTracker` with real verified `apply_patch` deltas rather than synthetic change structs. `apply_verified_patch` first asks `codex_apply_patch::maybe_parse_apply_patch_verified` to confirm the patch is a verified apply-patch action, then executes `codex_apply_patch::apply_patch` against a temporary workspace and returns the resulting `AppliedPatchDelta`. That means each test compares tracker output against the same patch semantics used in production.

`tracker_with_root` creates a tracker whose display root strips the temp directory prefix, making expected diff headers stable. The tests then cover a wide range of net-effect behaviors: add followed by update collapsing into a single add diff, invalidation clearing prior output, identical absolute paths tracked separately across `local` and `remote` environments, deletes, move-plus-update rendering as a single rename diff, pure renames yielding no diff, add-over-existing and delete-then-readd collapsing into updates, and move-overwrite cases splitting into source deletion plus optional destination update depending on content change.

Several tests verify ordering and caching details that are easy to miss. `preserves_committed_change_order_with_delete_then_move_overwrite` ensures aggregate output respects committed patch order. `reuses_rendered_diffs_for_unchanged_paths` and `repeated_updates_only_rerender_the_touched_path` inspect the test-only render counter to prove per-path diff caching works. The final large-rewrite test calls `render_diff` directly on a 48k-line rewrite, asserts it completes promptly, and then applies the generated diff with `apply_git_patch` to prove the timeout-based rendering still preserves exact content.

#### Function details

##### `git_blob_sha1_hex`  (lines 16–18)

```
fn git_blob_sha1_hex(data: &str) -> String
```

**Purpose**: Test helper that computes the expected Git blob object id for a text string.

**Data flow**: Converts the input string to bytes, calls `git_blob_sha1_hex_bytes`, formats the digest as lowercase hex, and returns the resulting `String`.

**Call relations**: Used by many tests to build exact expected `index` lines in rendered diffs.

*Call graph*: called by 9 (accumulates_add_then_update_as_single_add, accumulates_delete, accumulates_move_and_update, add_over_existing_file_becomes_update, delete_then_readd_same_path_becomes_update, move_over_existing_destination_with_content_change_deletes_source_and_updates_destination, move_over_existing_destination_without_content_change_deletes_source_only, preserves_committed_change_order_with_delete_then_move_overwrite, tracks_same_absolute_path_across_multiple_environments); 1 external calls (format!).


##### `apply_verified_patch`  (lines 20–47)

```
async fn apply_verified_patch(root: &Path, patch: &str) -> AppliedPatchDelta
```

**Purpose**: Applies an `apply_patch` script to a temporary workspace and returns the exact `AppliedPatchDelta` produced by the patch engine.

**Data flow**: Converts `root` into an `AbsolutePathBuf`, builds argv `['apply_patch', patch]`, verifies the patch parses as a verified apply-patch action, then runs `codex_apply_patch::apply_patch` with captured stdout/stderr and returns the resulting delta. It panics if verification yields an unexpected variant or application fails.

**Call relations**: This is the core fixture used by nearly every test to generate realistic deltas for the tracker.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 13 (accumulates_add_then_update_as_single_add, accumulates_delete, accumulates_move_and_update, add_over_existing_file_becomes_update, delete_then_readd_same_path_becomes_update, invalidated_tracker_suppresses_existing_diff, move_over_existing_destination_with_content_change_deletes_source_and_updates_destination, move_over_existing_destination_without_content_change_deletes_source_only, preserves_committed_change_order_with_delete_then_move_overwrite, pure_rename_yields_no_diff (+3 more)); 5 external calls (new, apply_patch, maybe_parse_apply_patch_verified, panic!, vec!).


##### `tracker_with_root`  (lines 49–51)

```
fn tracker_with_root(root: &Path) -> TurnDiffTracker
```

**Purpose**: Creates a tracker configured to display paths relative to a single workspace root.

**Data flow**: Wraps the provided root path in a one-entry environment-display-root mapping with empty environment id and returns `TurnDiffTracker::with_environment_display_roots(...)`.

**Call relations**: Used by most tests to keep expected diff paths simple and stable.

*Call graph*: calls 1 internal fn (with_environment_display_roots); called by 13 (accumulates_add_then_update_as_single_add, accumulates_delete, accumulates_move_and_update, add_over_existing_file_becomes_update, delete_then_readd_same_path_becomes_update, invalidated_tracker_suppresses_existing_diff, large_rewrite_returns_promptly_and_preserves_exact_content, move_over_existing_destination_with_content_change_deletes_source_and_updates_destination, move_over_existing_destination_without_content_change_deletes_source_only, preserves_committed_change_order_with_delete_then_move_overwrite (+3 more)); 1 external calls (to_path_buf).


##### `accumulates_add_then_update_as_single_add`  (lines 54–85)

```
async fn accumulates_add_then_update_as_single_add()
```

**Purpose**: Verifies that adding a new file and then updating it within the same turn renders as one net add diff containing the final content.

**Data flow**: Creates a temp dir and tracker, applies an add patch then an update patch to `a.txt`, tracks both deltas, computes the expected right blob id for `foo\nbar\n`, formats the exact expected unified diff, and compares it to `tracker.get_unified_diff()`.

**Call relations**: Exercises net-effect accumulation across multiple exact deltas on the same new path.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 3 external calls (assert_eq!, format!, tempdir).


##### `invalidated_tracker_suppresses_existing_diff`  (lines 88–102)

```
async fn invalidated_tracker_suppresses_existing_diff()
```

**Purpose**: Checks that once invalidated, the tracker stops reporting even previously accumulated diffs.

**Data flow**: Creates a tracker, applies and tracks an add patch, calls `tracker.invalidate()`, then asserts `get_unified_diff()` returns `None`.

**Call relations**: Directly validates the invalidation behavior used when non-exact deltas occur.

*Call graph*: calls 2 internal fn (apply_verified_patch, tracker_with_root); 2 external calls (assert_eq!, tempdir).


##### `tracks_same_absolute_path_across_multiple_environments`  (lines 105–139)

```
async fn tracks_same_absolute_path_across_multiple_environments()
```

**Purpose**: Verifies that the same filesystem path tracked under different environment ids produces separate diff entries with environment-prefixed display paths.

**Data flow**: Applies one add patch in a temp dir, creates a tracker with `local` and `remote` display roots pointing to the same directory, tracks the same delta once for each environment id, builds the expected two-diff aggregate string, and compares it to the tracker output.

**Call relations**: Tests the `TrackedPath` environment dimension and `display_path` prefixing logic.

*Call graph*: calls 3 internal fn (with_environment_display_roots, apply_verified_patch, git_blob_sha1_hex); 3 external calls (assert_eq!, format!, tempdir).


##### `accumulates_delete`  (lines 142–166)

```
async fn accumulates_delete()
```

**Purpose**: Checks that deleting an existing file renders as a Git-style deleted-file diff with the original blob id and `/dev/null` target.

**Data flow**: Seeds `b.txt`, creates a tracker, applies a delete patch, tracks the delta, computes the expected left blob id for `x\n`, formats the expected diff, and asserts equality with the tracker output.

**Call relations**: Covers baseline capture for first-seen deletions.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `accumulates_move_and_update`  (lines 169–194)

```
async fn accumulates_move_and_update()
```

**Purpose**: Verifies that moving a file and changing its content in one patch renders as a single rename/update diff from source path to destination path.

**Data flow**: Seeds `src.txt`, tracks a patch that moves it to `dst.txt` and changes `line` to `line2`, computes left and right blob ids, formats the expected diff headers and hunk, and compares against the tracker output.

**Call relations**: Exercises rename pairing plus content update rendering.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `pure_rename_yields_no_diff`  (lines 197–210)

```
async fn pure_rename_yields_no_diff()
```

**Purpose**: Checks that a rename with no content change produces no unified diff at all.

**Data flow**: Seeds `old.txt`, tracks a patch that moves it to `new.txt` without changing content, and asserts `get_unified_diff()` is `None`.

**Call relations**: Validates the `render_diff` early-return path when left and right contents are identical after rename pairing.

*Call graph*: calls 2 internal fn (apply_verified_patch, tracker_with_root); 3 external calls (assert_eq!, write, tempdir).


##### `add_over_existing_file_becomes_update`  (lines 213–238)

```
async fn add_over_existing_file_becomes_update()
```

**Purpose**: Verifies that an add patch overwriting an existing file is represented as an update from old content to new content, not as a brand-new file.

**Data flow**: Seeds `dup.txt`, tracks an add patch for the same path, computes blob ids for `before\n` and `after\n`, formats the expected update diff, and asserts equality.

**Call relations**: Exercises `apply_add` handling of `overwritten_content`.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `delete_then_readd_same_path_becomes_update`  (lines 241–273)

```
async fn delete_then_readd_same_path_becomes_update()
```

**Purpose**: Checks that deleting a file and then re-adding it in the same turn collapses into a single update diff from original to final content.

**Data flow**: Seeds `cycle.txt`, tracks a delete patch then an add patch, computes expected blob ids, formats the expected update diff, and compares it to the tracker output.

**Call relations**: Validates net-effect accumulation across delete/add cycles on one path.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `move_over_existing_destination_without_content_change_deletes_source_only`  (lines 276–301)

```
async fn move_over_existing_destination_without_content_change_deletes_source_only()
```

**Purpose**: Verifies that moving a file over an existing destination with identical content results in only a source deletion diff, since the destination's net content does not change.

**Data flow**: Seeds `a.txt` and `b.txt` with the same content, tracks a move-overwrite patch from `a.txt` to `b.txt`, computes the source blob id, formats the expected delete-only diff for `a.txt`, and asserts equality.

**Call relations**: Exercises overwrite-move semantics where destination update is elided because content is unchanged.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `move_over_existing_destination_with_content_change_deletes_source_and_updates_destination`  (lines 304–339)

```
async fn move_over_existing_destination_with_content_change_deletes_source_and_updates_destination()
```

**Purpose**: Checks that moving over an existing destination with changed content yields two diffs: source deletion and destination update.

**Data flow**: Seeds `a.txt` and `b.txt` with different contents, tracks a move-overwrite patch that changes content to `new`, computes blob ids for source old, destination old, and destination new, formats the expected two-diff aggregate, and compares it to tracker output.

**Call relations**: Covers the overwrite-move case where both source disappearance and destination content change matter.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `preserves_committed_change_order_with_delete_then_move_overwrite`  (lines 342–376)

```
async fn preserves_committed_change_order_with_delete_then_move_overwrite()
```

**Purpose**: Verifies that aggregate diff ordering follows the committed patch change order when a destination is deleted before a source is moved over it.

**Data flow**: Seeds source and destination files, applies a patch that first deletes `b.txt` then moves/updates `a.txt` to `b.txt`, tracks the delta, builds the expected aggregate with source deletion first and destination update second, and asserts equality.

**Call relations**: Tests ordering guarantees in `refresh_unified_diff` after complex multi-change patches.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `reuses_rendered_diffs_for_unchanged_paths`  (lines 379–405)

```
async fn reuses_rendered_diffs_for_unchanged_paths()
```

**Purpose**: Proves that adding a second file rerenders only the new path and that repeated reads of the aggregate diff do not trigger rerendering.

**Data flow**: Creates a tracker, tracks an add for `a.txt` and checks `rendered_diff_count() == 1`, tracks an add for `b.txt`, then asserts the count is 2 and remains 2 across repeated `get_unified_diff()` calls.

**Call relations**: Validates the per-path rendered-diff cache and the fact that aggregate reads are pure.

*Call graph*: calls 2 internal fn (apply_verified_patch, tracker_with_root); 2 external calls (assert_eq!, tempdir).


##### `repeated_updates_only_rerender_the_touched_path`  (lines 408–428)

```
async fn repeated_updates_only_rerender_the_touched_path()
```

**Purpose**: Checks that repeated updates to one file rerender only that file while leaving another stable file's cached diff untouched.

**Data flow**: Creates a tracker, tracks adds for `stable.txt` and `hot.txt`, then loops 40 times applying and tracking updates to `hot.txt`. Finally it asserts the render count is 42: once per initial add plus once per hot-file update.

**Call relations**: Stress-tests cache invalidation granularity by revision key.

*Call graph*: calls 2 internal fn (apply_verified_patch, tracker_with_root); 3 external calls (assert_eq!, format!, tempdir).


##### `large_rewrite_returns_promptly_and_preserves_exact_content`  (lines 431–495)

```
fn large_rewrite_returns_promptly_and_preserves_exact_content()
```

**Purpose**: Ensures `render_diff` handles a huge full-file rewrite quickly enough and still emits a patch that Git can apply to reproduce the exact new content.

**Data flow**: Initializes a temp Git repo, writes and stages a 48k-line file, constructs a tracker and `TrackedPath`, times a direct `render_diff` call from old to new content, asserts it finishes within two seconds, applies the generated diff with `apply_git_patch`, and verifies the file now equals `new_content`.

**Call relations**: Directly exercises the timeout-based diff rendering path and validates correctness by round-tripping through Git patch application.

*Call graph*: calls 2 internal fn (new, tracker_with_root); 6 external calls (now, assert!, assert_eq!, apply_git_patch, write, tempdir).


### `core/src/turn_timing_tests.rs`

`test` · `test execution`

This file is a focused test suite for the turn timing state machine and the helper that decides whether a response item counts as the first visible output of a turn. The async tests exercise `TurnTimingState` as a mutable per-turn recorder: before a turn starts, TTFT recording must return `None`; after `mark_turn_started`, non-output events such as `ResponseEvent::Created` still do not count, while the first output-bearing event does and subsequent output deltas are ignored. A separate test confirms that TTFM recording for `TurnItem::AgentMessage` is tracked independently from TTFT, so the first message item can still produce a timing even if TTFT was already recorded from a streaming text delta.

Another test checks the wall-clock metadata captured by `mark_turn_started`: it returns Unix epoch milliseconds within the observed before/after bounds and exposes matching whole-second precision through `started_at_unix_secs`. The pure unit tests around `response_item_records_turn_ttft` pin down which `ResponseItem` variants are considered first-output signals: function calls, custom tool calls, and assistant messages with non-empty `ContentItem::OutputText` count; empty output text and `FunctionCallOutput` do not. The final test drives `TurnProfileState` through sampling and tool-blocking phases, including a retry, and asserts the exact `TurnProfile` decomposition into pre-sampling delay, total sampling time, between-sampling overhead, tool-blocking time, post-sampling tail time, request count, and retry count.

#### Function details

##### `turn_timing_state_records_ttft_only_once_per_turn`  (lines 20–48)

```
async fn turn_timing_state_records_ttft_only_once_per_turn()
```

**Purpose**: Verifies that TTFT is only recorded after a turn has started and only for the first qualifying response event in that turn. It also confirms that non-output events do not trigger TTFT.

**Data flow**: Creates a default `TurnTimingState`, invokes `record_ttft_for_response_event` first without prior start state, then after `mark_turn_started(Instant::now())` feeds `ResponseEvent::Created` and two `ResponseEvent::OutputTextDelta` values. It observes the returned `Option` values and asserts the sequence `None`, `None`, `Some(_)`, `None`, without mutating any external state beyond the internal timing flags in `TurnTimingState`.

**Call relations**: This is a standalone async test entry invoked by the test runner. It directly exercises the TTFT-recording path on `TurnTimingState` to validate the one-shot behavior that production code relies on when streaming response events arrive.

*Call graph*: 4 external calls (now, assert!, assert_eq!, default).


##### `turn_timing_state_records_ttfm_independently_of_ttft`  (lines 51–83)

```
async fn turn_timing_state_records_ttfm_independently_of_ttft()
```

**Purpose**: Checks that first-message timing is tracked separately from first-token timing. The test proves that recording TTFT does not consume or suppress the first eligible TTFM measurement.

**Data flow**: Builds a default `TurnTimingState`, marks the turn started at `Instant::now()`, records TTFT from an `OutputTextDelta`, then passes two `TurnItem::AgentMessage` values with distinct ids into `record_ttfm_for_turn_item`. It asserts that the first agent message returns `Some(_)` and the second returns `None`, reflecting internal one-time TTFM state.

**Call relations**: This test is run directly by the test harness and targets the interaction between two timing channels inside `TurnTimingState`. It complements the TTFT-only test by showing that the message-item path remains independently active after TTFT has already been captured.

*Call graph*: 4 external calls (now, assert!, assert_eq!, default).


##### `turn_timing_state_records_turn_started_epoch_millis`  (lines 86–104)

```
async fn turn_timing_state_records_turn_started_epoch_millis()
```

**Purpose**: Validates that starting a turn stores a wall-clock timestamp in Unix milliseconds and exposes a consistent seconds value. It guards against incorrect epoch conversion or stale timestamp storage.

**Data flow**: Captures `before` and `after` bounds from `SystemTime::now().duration_since(UNIX_EPOCH).as_millis()`, calls `mark_turn_started(Instant::now())`, and compares the returned `started_at_unix_ms` against those bounds. It then reads `started_at_unix_secs()` from the state and asserts it equals `started_at_unix_ms / 1000`.

**Call relations**: This standalone test is invoked by the test runner to verify the wall-clock side effect of `mark_turn_started`. It focuses on the persisted timestamp metadata rather than latency calculations.

*Call graph*: 5 external calls (now, now, assert!, assert_eq!, default).


##### `response_item_records_turn_ttft_for_first_output_signals`  (lines 107–137)

```
fn response_item_records_turn_ttft_for_first_output_signals()
```

**Purpose**: Confirms which `ResponseItem` variants are treated as the first output signal for TTFT accounting. It specifically covers tool-call-like items and assistant messages with non-empty output text.

**Data flow**: Constructs three concrete `ResponseItem` values: `FunctionCall`, `CustomToolCall`, and `Message` containing `ContentItem::OutputText { text: "hello" }`. Each is passed to `response_item_records_turn_ttft`, and the boolean result is asserted to be true.

**Call relations**: This synchronous unit test directly targets the helper predicate used by timing code. It documents the intended classification rules for response items that should start TTFT.

*Call graph*: 1 external calls (assert!).


##### `response_item_records_turn_ttft_ignores_empty_non_output_items`  (lines 140–157)

```
fn response_item_records_turn_ttft_ignores_empty_non_output_items()
```

**Purpose**: Pins down negative cases for the TTFT predicate so empty or follow-up output structures do not incorrectly count as first output. It prevents false-positive TTFT recording.

**Data flow**: Builds a `ResponseItem::Message` whose only `OutputText` content is an empty string and a `ResponseItem::FunctionCallOutput` with textual payload. It passes both into `response_item_records_turn_ttft` and asserts false for each result.

**Call relations**: This test is called by the test harness and complements the positive predicate test. It ensures the helper distinguishes between meaningful first output and empty or non-qualifying response items.

*Call graph*: 1 external calls (assert!).


##### `turn_profile_breaks_down_sampling_blocking_and_retry_overhead`  (lines 160–194)

```
fn turn_profile_breaks_down_sampling_blocking_and_retry_overhead()
```

**Purpose**: Exercises `TurnProfileState` across multiple phases and verifies the exact aggregate `TurnProfile` produced at completion. It checks both duration accounting and request/retry counters.

**Data flow**: Creates a start `Instant`, initializes `TurnProfileState`, calls `start`, begins and ends a sampling phase from +100ms to +600ms, begins and ends a tool-blocking phase from +600ms to +900ms, records one sampling retry, begins and ends a second sampling phase from +1000ms to +1200ms, then calls `complete` at +1300ms. The returned `TurnProfile` is compared against a fully specified expected struct with concrete millisecond totals and counts.

**Call relations**: This test is a direct harness-driven check of the profiling state machine. It validates the phase transitions and final aggregation logic that production analytics code depends on for turn breakdown reporting.

*Call graph*: 4 external calls (from_millis, now, assert_eq!, default).


### `core/src/user_shell_command_tests.rs`

`test` · `test-time validation of shell-command record formatting`

This test file validates the small but user-visible formatting layer in `user_shell_command.rs`. The first test checks `UserShellCommand::matches_text`, ensuring the system recognizes the wrapped `<user_shell_command>...</user_shell_command>` form and does not falsely match plain command text. The two async tests then exercise record construction against a real session/turn context.

`formats_basic_record` builds an `ExecToolCallOutput` with exit code 0, one second of duration, and simple `stdout`/`aggregated_output` text. It calls `user_shell_command_record_item`, destructures the resulting `ResponseItem::Message`, and asserts the exact serialized text payload, including `<command>`, `<result>`, exit code, duration formatting to four decimal places, and output body. `uses_aggregated_output_over_streams` constructs an output where `stdout` and `stderr` disagree with `aggregated_output`, then calls the test-only string formatter and asserts that the rendered record uses the aggregated output text. Together these tests document both the wrapper syntax and the precedence rule that persisted shell-command records should reflect the combined output view rather than raw individual streams.

#### Function details

##### `detects_user_shell_command_text_variants`  (lines 11–16)

```
fn detects_user_shell_command_text_variants()
```

**Purpose**: Verifies the text-matching helper recognizes wrapped user-shell-command records and rejects plain command text.

**Data flow**: Calls `UserShellCommand::matches_text` with a wrapped record string and with `"echo hi"`, then asserts true for the former and false for the latter.

**Call relations**: Tests the detection logic on the `UserShellCommand` type that other code may use when parsing or identifying persisted fragments.

*Call graph*: 1 external calls (assert!).


##### `formats_basic_record`  (lines 19–40)

```
async fn formats_basic_record()
```

**Purpose**: Checks that a basic execution result is serialized into the exact expected `ResponseItem` message text.

**Data flow**: Builds an `ExecToolCallOutput` with exit code, stream outputs, aggregated output, and duration; obtains a test `TurnContext`; calls `user_shell_command_record_item`; destructures the returned `ResponseItem::Message` and its single `ContentItem::InputText`; then asserts the exact wrapped text string.

**Call relations**: Exercises the production record-item path end to end, including conversion into protocol message content.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 4 external calls (from_secs, new, assert_eq!, panic!).


##### `uses_aggregated_output_over_streams`  (lines 43–58)

```
async fn uses_aggregated_output_over_streams()
```

**Purpose**: Verifies that rendered shell-command records use `aggregated_output` rather than concatenating or preferring individual stdout/stderr fields.

**Data flow**: Builds an `ExecToolCallOutput` where `stdout`, `stderr`, and `aggregated_output` differ, obtains a test `TurnContext`, calls `format_user_shell_command_record`, and asserts the exact rendered string contains only the aggregated output text.

**Call relations**: Targets the formatting helper’s output-selection rule, ensuring persisted records match the combined-output view expected by users.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 2 external calls (from_millis, assert_eq!).


### `core/src/image_preparation_tests.rs`

`test` · `test execution`

This test file builds concrete PNG data URLs and feeds them through `prepare_response_items` to validate the image preparation rules implemented in the parent module. Two local helpers keep the tests precise: `png_data_url` synthesizes an RGBA PNG of a known solid color and returns both the encoded bytes and a `data:` URL, while `decoded_image` reverses a processed data URL back into raw bytes and an `image::DynamicImage` so tests can compare exact bytes or dimensions.

The tests cover three distinct paths. First, small inline images should survive byte-for-byte, while non-data URLs such as `https://...` must remain untouched. Second, the `ImageDetail` policy matrix is checked against exact output dimensions, confirming the budget differences between `High`, `Original`, `Auto`, and omitted detail. Third, tool output content is treated more defensively: malformed base64 and non-image payloads are replaced with `InputText` placeholders, low-detail tool images are rejected with a dedicated unsupported-detail placeholder, and valid high-detail images remain as images. The assertions compare full `ResponseItem::CustomToolCallOutput` structures to ensure metadata like `call_id`, `success`, and surrounding text items are preserved exactly. A final table-driven test confirms that `ImagePreparationError::placeholder()` collapses internal processing details into stable, bounded strings rather than leaking verbose diagnostics.

#### Function details

##### `png_data_url`  (lines 17–25)

```
fn png_data_url(width: u32, height: u32) -> (String, Vec<u8>)
```

**Purpose**: Constructs a synthetic PNG image of the requested size and returns both its `data:image/png;base64,...` URL and the exact encoded PNG bytes. The helper gives tests a deterministic image fixture with known dimensions and content.

**Data flow**: Takes `width` and `height` as `u32`. It creates an `ImageBuffer<Rgba<u8>, _>` filled with the constant pixel `[10, 20, 30, 255]`, wraps it as `DynamicImage::ImageRgba8`, writes PNG bytes into a `Cursor<Vec<u8>>`, then converts those bytes into a data URL via `data_url_from_bytes("image/png", &bytes)`. Returns `(String, Vec<u8>)` containing the URL and original encoded bytes.

**Call relations**: Used by the image-preparation tests as the canonical source image fixture. The preservation, resizing-budget, and failed-tool-image tests all call it before invoking `prepare_response_items`, so they can compare the post-processed image against a known original.

*Call graph*: calls 1 internal fn (new); called by 3 (detail_policies_apply_the_expected_budgets, preparation_preserves_small_image_bytes_and_non_data_urls, preparation_replaces_only_failed_tool_images_and_preserves_metadata); 5 external calls (ImageRgba8, from_pixel, new, data_url_from_bytes, Rgba).


##### `decoded_image`  (lines 27–32)

```
fn decoded_image(image_url: &str) -> (Vec<u8>, DynamicImage)
```

**Purpose**: Decodes a processed image data URL back into raw bytes and an `image::DynamicImage` for assertions. It lets tests inspect both exact encoded output and decoded dimensions.

**Data flow**: Accepts `image_url: &str`, splits on the first comma to isolate the base64 payload, decodes it with the standard base64 engine, and loads the resulting bytes with `image::load_from_memory`. Returns `(Vec<u8>, DynamicImage)`.

**Call relations**: This helper is only used inside assertions after `prepare_response_items` has rewritten image URLs. The preservation test compares returned bytes to the original PNG bytes, while the detail-policy test reads the decoded image dimensions.

*Call graph*: 1 external calls (load_from_memory).


##### `preparation_preserves_small_image_bytes_and_non_data_urls`  (lines 35–72)

```
fn preparation_preserves_small_image_bytes_and_non_data_urls()
```

**Purpose**: Verifies that preprocessing leaves already-small inline PNGs unchanged and does not touch non-data URLs at all. It checks both image bytes and the untouched HTTP URL/detail pair.

**Data flow**: Builds one small PNG data URL and one HTTP URL, embeds both in a `ResponseItem::Message` containing `ContentItem::InputImage` entries, mutably passes the vector into `prepare_response_items`, then destructures the rewritten message content. It asserts that the first image decodes to the original PNG bytes and that the second image URL still equals the original HTTP string.

**Call relations**: This is a direct black-box test of `prepare_response_items`. It uses `png_data_url` to create the inline image fixture and then inspects the mutated `items` vector after preparation.

*Call graph*: calls 1 internal fn (png_data_url); 3 external calls (assert_eq!, panic!, vec!).


##### `detail_policies_apply_the_expected_budgets`  (lines 75–102)

```
fn detail_policies_apply_the_expected_budgets()
```

**Purpose**: Checks that each supported `ImageDetail` mode maps oversized images to the expected resized dimensions. The test encodes the policy table explicitly, including default behavior when detail is omitted.

**Data flow**: Iterates over a fixed array of `(detail, input_dimensions, expected_dimensions)` cases. For each case it creates a PNG data URL of the input size, wraps it in a single-image `ResponseItem::Message`, calls `prepare_response_items`, extracts the rewritten image URL, decodes it with `decoded_image`, and compares `dimensions()` to the expected tuple.

**Call relations**: Acts as the policy regression test for the parent module’s resizing logic. It repeatedly calls `png_data_url` to generate oversized fixtures and validates the output after `prepare_response_items` runs.

*Call graph*: calls 1 internal fn (png_data_url); 3 external calls (assert_eq!, panic!, vec!).


##### `preparation_replaces_only_failed_tool_images_and_preserves_metadata`  (lines 105–169)

```
fn preparation_replaces_only_failed_tool_images_and_preserves_metadata()
```

**Purpose**: Confirms that image preparation for custom tool output replaces only invalid or unsupported image entries, while preserving valid images and all surrounding payload structure. It specifically distinguishes malformed data URLs, non-image bytes, unsupported low-detail images, and valid high-detail images.

**Data flow**: Creates a `ResponseItem::CustomToolCallOutput` whose `FunctionCallOutputPayload.body` is a `ContentItems` list containing text plus several `FunctionCallOutputContentItem::InputImage` variants: invalid base64, valid data URL with non-image bytes, valid low-detail image, and valid high-detail image. After mutating the vector with `prepare_response_items`, it asserts full structural equality against an expected vector where the first two bad images become `InputText` placeholders, the low-detail image becomes the unsupported-detail placeholder, and the final high-detail image remains intact; `call_id`, `success`, and `metadata` are unchanged.

**Call relations**: This test targets the tool-output branch of `prepare_response_items`, not the normal message-input branch. It uses `png_data_url` only to produce the valid image fixture and then validates exact replacement behavior through a full-value equality assertion.

*Call graph*: calls 1 internal fn (png_data_url); 2 external calls (assert_eq!, vec!).


##### `preparation_errors_use_bounded_actionable_placeholders`  (lines 172–197)

```
fn preparation_errors_use_bounded_actionable_placeholders()
```

**Purpose**: Verifies that each public-facing image preparation error maps to the intended placeholder string rather than exposing detailed internal diagnostics. It protects the contract of concise, actionable fallback text.

**Data flow**: Builds a small table of `ImagePreparationError` values, including `UnsupportedLowDetail`, `Processing(ImageTooLarge { ... })`, and `Processing(InvalidDataUrl { ... })`. For each pair it calls `error.placeholder()` and asserts equality with the expected placeholder constant.

**Call relations**: This is a focused unit test for the error-to-placeholder conversion logic used by image preparation. It does not invoke `prepare_response_items`; instead it validates the stable user-visible strings that preparation code emits on failure.

*Call graph*: 2 external calls (assert_eq!, Processing).


### `core/src/client_common_tests.rs`

`test` · `test execution`

This test module focuses on two concrete contracts. First, it verifies how `Prompt::get_formatted_input_for_request` rewrites image-bearing input for Responses Lite. The `prompt_with_image_outputs` fixture builds a prompt containing three image locations: a user message `ContentItem::InputImage`, a `FunctionCallOutput` image, and a `CustomToolCallOutput` image. The corresponding test confirms that enabling Responses Lite strips every `detail` field to `None` in the returned copy while leaving the original prompt input unchanged, and that disabling Responses Lite returns the original structure untouched.

Second, the file validates JSON serialization of `codex_api::ResponsesApiRequest` and `TextControls`. Rather than invoking the full client stack, the tests construct request structs directly and serialize them with `serde_json::to_value`. They verify that verbosity serializes as `"low"`, that schema-based text formatting includes the expected `name`, `type`, `strict`, and `schema` fields, that non-strict schema formatting preserves `strict: false`, that the `text` field is omitted entirely when unset, and that `service_tier` serializes as `"flex"`. Together these tests lock down the exact wire JSON shape expected by downstream APIs.

#### Function details

##### `prompt_with_image_outputs`  (lines 12–49)

```
fn prompt_with_image_outputs() -> Prompt
```

**Purpose**: Builds a prompt fixture containing image inputs in all supported locations that should be normalized for Responses Lite. It gives the stripping test a compact but representative input shape.

**Data flow**: Constructs a `Prompt` whose `input` contains a user `Message` with `ContentItem::InputImage`, a `FunctionCallOutput` with `FunctionCallOutputContentItem::InputImage`, and a `CustomToolCallOutput` with the same kind of image content; all three start with non-`None` `detail` values. Remaining prompt fields come from `Default::default()`.

**Call relations**: Used only by `responses_lite_request_copies_strip_image_details` to supply a fixture that exercises every branch of `strip_image_details`.

*Call graph*: called by 1 (responses_lite_request_copies_strip_image_details); 2 external calls (default, vec!).


##### `responses_lite_request_copies_strip_image_details`  (lines 52–99)

```
fn responses_lite_request_copies_strip_image_details()
```

**Purpose**: Verifies that Responses Lite formatting strips image detail metadata from a copied input while preserving the original prompt unchanged. It also checks that the non-Lite path is a no-op.

**Data flow**: Creates the fixture prompt, clones its original `input`, calls `get_formatted_input_for_request(true)`, and asserts the returned vector has all image `detail` fields set to `None`. It then asserts `prompt.input` still equals the original clone and that `get_formatted_input_for_request(false)` returns the original structure.

**Call relations**: This test directly exercises `Prompt::get_formatted_input_for_request` and, transitively, `strip_image_details`.

*Call graph*: calls 1 internal fn (prompt_with_image_outputs); 1 external calls (assert_eq!).


##### `serializes_text_verbosity_when_set`  (lines 102–132)

```
fn serializes_text_verbosity_when_set()
```

**Purpose**: Checks that `ResponsesApiRequest.text.verbosity` serializes to the expected lowercase string form. It guards the JSON wire representation of verbosity controls.

**Data flow**: Constructs a `ResponsesApiRequest` with `text = Some(TextControls { verbosity: Some(OpenAiVerbosity::Low), format: None })` and otherwise empty input/tools → serializes it with `serde_json::to_value` → asserts `text.verbosity` equals `"low"`.

**Call relations**: This test validates serde behavior for request structs used by the client transport layer, without invoking request-building helpers.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `serializes_text_schema_with_strict_format`  (lines 135–184)

```
fn serializes_text_schema_with_strict_format()
```

**Purpose**: Verifies that schema-based text controls serialize with the expected strict JSON-schema format wrapper. It checks both omission of verbosity and exact schema metadata fields.

**Data flow**: Builds a JSON schema value, passes it to `create_text_param_for_request(None, &Some(schema.clone()), true)`, embeds the resulting `TextControls` in a `ResponsesApiRequest`, serializes to JSON, and asserts that `text.verbosity` is absent while `text.format` contains `name = codex_output_schema`, `type = json_schema`, `strict = true`, and the original schema payload.

**Call relations**: This test exercises the external helper `create_text_param_for_request` and confirms the serialized shape expected when `ModelClient::build_responses_request` includes schema output controls.

*Call graph*: 6 external calls (assert!, assert_eq!, create_text_param_for_request, json!, to_value, vec!).


##### `serializes_text_schema_with_non_strict_format`  (lines 187–207)

```
fn serializes_text_schema_with_non_strict_format()
```

**Purpose**: Checks that non-strict schema output controls preserve `strict: false` and the original schema. It validates the alternate schema-formatting mode.

**Data flow**: Builds a schema JSON value, calls `create_text_param_for_request(None, &Some(schema.clone()), false)`, extracts the resulting `format`, and asserts `format.strict` is false and `format.schema` equals the original schema.

**Call relations**: Like the strict-format test, this validates the external text-control builder used by request construction, but focuses on the non-strict branch.

*Call graph*: 4 external calls (assert!, assert_eq!, create_text_param_for_request, json!).


##### `omits_text_when_not_set`  (lines 210–232)

```
fn omits_text_when_not_set()
```

**Purpose**: Ensures that a request with `text: None` serializes without any `text` field at all. This distinguishes omission from an empty object.

**Data flow**: Constructs a `ResponsesApiRequest` with `text = None`, serializes it to JSON, and asserts `v.get("text")` is `None`.

**Call relations**: This test guards the serde contract for requests that do not use verbosity or output-schema controls.

*Call graph*: 3 external calls (assert!, to_value, vec!).


##### `serializes_flex_service_tier_when_set`  (lines 235–258)

```
fn serializes_flex_service_tier_when_set()
```

**Purpose**: Verifies that `service_tier` serializes to the expected lowercase string value. It locks down the wire representation of service-tier selection.

**Data flow**: Constructs a `ResponsesApiRequest` with `service_tier = Some(ServiceTier::Flex.to_string())`, serializes it to JSON, and asserts the `service_tier` field equals `"flex"`.

**Call relations**: This test covers another direct serialization contract relied on by `ModelClient::build_responses_request` when it sets service tier.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


### Agent and thread control
These tests exercise agent orchestration, registry and role behavior, delegated subagents, execution limits, residency, and thread lifecycle management.

### `core/src/agent/control_tests.rs`

`test` · `test execution`

This is the main integration test suite for the agent-control subsystem. It builds realistic `ThreadManager`/`AgentControl` fixtures, often with temporary homes and optional SQLite state, then drives public APIs end-to-end. The helper layer includes config builders (`test_config_with_cli_overrides`, `test_config`), protocol constructors (`text_input`, `assistant_message`, `spawn_agent_call`), an `AgentControlHarness` that wires manager, control, config, and optional state DB together, and polling/assertion helpers for parent notifications, persisted rollout, live child discovery, and unloaded-thread checks.

The tests cover several distinct behaviors. Basic cases verify manager-dropped and thread-missing errors, status derivation from `EventMsg`, status subscriptions, and that `send_input` / `send_inter_agent_communication` submit the expected `Op` values. Spawn tests verify thread creation, max-thread accounting, slot release after shutdown or failed resume, shared limits across cloned controls, and encrypted inter-agent communication clearing `last_task_message` metadata.

A large cluster focuses on multi-agent spawning and resume semantics: V2 lazy reload of unloaded agents, forked-child history sanitization, flushing parent rollout before fork, bounded last-N-turn forks, stripping stale usage hints from both normal and compacted history, nickname assignment and restoration, archived-rollout resume, subtree enumeration, recursive shutdown, and persisted open/closed descendant behavior during resume. Completion-watcher tests distinguish V1-style parent notifications from V2 direct-parent queueing and ensure dead parents are ignored. Overall, this file documents the intended external behavior of `AgentControl` far more comprehensively than the implementation comments do.

#### Function details

##### `test_config_with_cli_overrides`  (lines 41–52)

```
async fn test_config_with_cli_overrides(
    cli_overrides: Vec<(String, TomlValue)>,
) -> (TempDir, Config)
```

**Purpose**: Builds a temporary test home and a `Config` with optional CLI override values applied. It is the common setup path for tests that need custom limits or feature flags.

**Data flow**: Accepts `Vec<(String, TomlValue)>`, creates a `TempDir`, feeds its path plus the overrides into `ConfigBuilder::without_managed_config_for_tests()`, awaits `build()`, and returns `(TempDir, Config)`. It writes configuration state only inside the newly built config object.

**Call relations**: This helper is called by `test_config` and by limit-focused tests that need to override `agents.max_threads`. It delegates config construction to the builder API.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); called by 6 (resume_agent_releases_slot_after_resume_failure, resume_agent_respects_max_threads_limit, spawn_agent_limit_shared_across_clones, spawn_agent_releases_slot_after_shutdown, spawn_agent_respects_max_threads_limit, test_config); 1 external calls (new).


##### `test_config`  (lines 54–56)

```
async fn test_config() -> (TempDir, Config)
```

**Purpose**: Returns a default temporary-home test configuration with no CLI overrides. It is the simplest fixture constructor used throughout the suite.

**Data flow**: Calls `test_config_with_cli_overrides(Vec::new()).await` and returns the resulting `(TempDir, Config)` unchanged.

**Call relations**: Many tests and `AgentControlHarness::new` call this helper as their baseline configuration source.

*Call graph*: calls 1 internal fn (test_config_with_cli_overrides); called by 7 (new, ensure_v2_agent_loaded_reloads_registered_unloaded_agent, list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root, resume_agent_errors_when_manager_dropped, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_thread_subagent_restores_stored_nickname_and_role, spawn_agent_errors_when_manager_dropped); 1 external calls (new).


##### `text_input`  (lines 58–64)

```
fn text_input(text: &str) -> Op
```

**Purpose**: Constructs a simple `Op::UserInput` containing one text item. It keeps tests concise when they only need a plain prompt.

**Data flow**: Takes `&str`, builds `vec![UserInput::Text { text: text.to_string(), text_elements: Vec::new() }]`, converts that vector into an `Op`, and returns it.

**Call relations**: This helper is used across most spawn and input-submission tests as the initial operation payload.

*Call graph*: called by 31 (encrypted_inter_agent_communication_clears_existing_last_task_message, ensure_v2_agent_loaded_reloads_registered_unloaded_agent, list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root, list_agent_subtree_thread_ids_includes_anonymous_and_closed_descendants, multi_agent_v2_completion_ignores_dead_direct_parent, resume_agent_from_rollout_does_not_reopen_closed_descendants, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_agent_from_rollout_reads_archived_rollout_path, resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown, resume_agent_from_rollout_skips_descendants_when_parent_resume_fails (+15 more)); 1 external calls (vec!).


##### `assistant_message`  (lines 66–76)

```
fn assistant_message(text: &str, phase: Option<MessagePhase>) -> ResponseItem
```

**Purpose**: Creates a `ResponseItem::Message` representing assistant output with an optional `MessagePhase`. It is used to seed parent histories for fork tests.

**Data flow**: Accepts message text and `Option<MessagePhase>`, constructs a `ResponseItem::Message` with role `assistant` and one `ContentItem::OutputText`, and returns it.

**Call relations**: Fork-history tests call this helper when assembling parent rollout items that should or should not survive into a child fork.

*Call graph*: called by 2 (spawn_agent_can_fork_parent_thread_history_with_sanitized_items, spawn_agent_fork_flushes_parent_rollout_before_loading_history); 1 external calls (vec!).


##### `register_session_root_skips_threads_with_explicit_parent`  (lines 79–85)

```
fn register_session_root_skips_threads_with_explicit_parent()
```

**Purpose**: Verifies that registering a session root does not create a root-path registry entry when the thread already has an explicit parent. This protects the root namespace from child threads.

**Data flow**: Creates `AgentControl::default()`, calls `register_session_root` with a new thread ID and `Some(parent_id)`, then asserts `control.state.agent_id_for_path(&AgentPath::root()) == None`.

**Call relations**: This is a focused unit test for root-registration behavior and does not use the broader harness.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, default).


##### `spawn_agent_call`  (lines 87–96)

```
fn spawn_agent_call(call_id: &str) -> ResponseItem
```

**Purpose**: Builds a synthetic `ResponseItem::FunctionCall` for `spawn_agent`. It is used in fork tests to mimic the parent history around a spawn invocation.

**Data flow**: Takes a `call_id: &str`, constructs a `ResponseItem::FunctionCall` with name `spawn_agent`, empty JSON arguments, and the provided call ID, then returns it.

**Call relations**: Several fork-history tests insert this item into parent rollout so the child fork resembles a real spawn-triggering turn.

*Call graph*: called by 6 (spawn_agent_can_fork_parent_thread_history_with_sanitized_items, spawn_agent_fork_flushes_parent_rollout_before_loading_history, spawn_agent_fork_last_n_turns_drops_parent_startup_prefix_when_under_limit, spawn_agent_fork_last_n_turns_keeps_only_recent_turns, spawn_agent_fork_last_n_turns_strips_parent_usage_hints, spawn_agent_fork_strips_parent_usage_hints_from_compacted_history).


##### `AgentControlHarness::new`  (lines 107–110)

```
async fn new() -> Self
```

**Purpose**: Creates a default test harness with temporary config, manager, state DB, and `AgentControl`. It is the standard fixture entry point for most integration tests.

**Data flow**: Awaits `test_config()` to get `(home, config)`, then awaits `Self::new_with_config(home, config)` and returns the resulting harness.

**Call relations**: Most tests call this helper instead of wiring manager and control manually. It delegates actual construction to `AgentControlHarness::new_with_config`.

*Call graph*: calls 1 internal fn (test_config); called by 30 (completion_watcher_notifies_parent_when_child_is_missing, encrypted_inter_agent_communication_clears_existing_last_task_message, get_status_returns_not_found_for_missing_thread, get_status_returns_pending_init_for_new_thread, list_agent_subtree_thread_ids_includes_anonymous_and_closed_descendants, multi_agent_v2_completion_ignores_dead_direct_parent, multi_agent_v2_completion_queues_message_for_direct_parent, resume_agent_from_rollout_does_not_reopen_closed_descendants, resume_agent_from_rollout_reads_archived_rollout_path, resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown (+15 more)); 1 external calls (new_with_config).


##### `AgentControlHarness::new_with_config`  (lines 112–129)

```
async fn new_with_config(home: TempDir, config: Config) -> Self
```

**Purpose**: Builds a harness from a caller-supplied `Config`, including optional SQLite state initialization. It centralizes realistic manager/control setup for integration tests.

**Data flow**: Accepts a `TempDir` and `Config`, initializes state DB with `init_state_db(&config).await`, constructs a `ThreadManager` via `with_models_provider_home_and_state_for_tests(...)`, obtains `manager.agent_control()`, and returns `AgentControlHarness { _home, config, state_db, manager, control }`.

**Call relations**: This is called by `AgentControlHarness::new` and by tests that need to mutate config before harness creation, such as V2 reload/resume scenarios.

*Call graph*: calls 3 internal fn (with_models_provider_home_and_state_for_tests, default_for_tests, from_api_key); called by 2 (ensure_v2_agent_loaded_reloads_registered_unloaded_agent, resume_agent_from_rollout_does_not_reopen_v2_descendants); 2 external calls (init_state_db, new).


##### `AgentControlHarness::start_thread`  (lines 131–138)

```
async fn start_thread(&self) -> (ThreadId, Arc<CodexThread>)
```

**Purpose**: Starts a root thread using the harness configuration and returns both its ID and thread handle. It is a convenience wrapper around the manager’s start API.

**Data flow**: Clones `self.config`, awaits `self.manager.start_thread(...)`, unwraps success, and returns `(new_thread.thread_id, new_thread.thread)`.

**Call relations**: Many tests use this helper to obtain a live parent or root thread before exercising control operations.

*Call graph*: calls 1 internal fn (start_thread); 1 external calls (clone).


##### `has_subagent_notification`  (lines 141–156)

```
fn has_subagent_notification(history_items: &[ResponseItem]) -> bool
```

**Purpose**: Scans response history for a user-visible subagent notification message. It recognizes notifications by delegating text matching to `SubagentNotification::matches_text`.

**Data flow**: Takes `&[ResponseItem]`, iterates message items with role `user`, inspects each text-bearing content item, and returns `true` if any text matches the notification pattern; otherwise `false`.

**Call relations**: This helper is used by `wait_for_subagent_notification` and by tests that inspect parent history after child completion or missing-child notifications.

*Call graph*: called by 1 (wait_for_subagent_notification); 1 external calls (iter).


##### `history_contains_text`  (lines 159–171)

```
fn history_contains_text(history_items: &[ResponseItem], needle: &str) -> bool
```

**Purpose**: Checks whether any message content in a history slice contains a given substring. It is a generic assertion helper for fork and notification tests.

**Data flow**: Accepts `&[ResponseItem]` and `needle: &str`, iterates message items and their text content, and returns `true` if any text span contains the substring.

**Call relations**: Many tests call this helper directly when asserting that specific parent or child history text was preserved or removed.

*Call graph*: 1 external calls (iter).


##### `history_contains_assistant_inter_agent_communication`  (lines 173–194)

```
fn history_contains_assistant_inter_agent_communication(
    history_items: &[ResponseItem],
    expected: &InterAgentCommunication,
) -> bool
```

**Purpose**: Detects whether assistant history contains a serialized `InterAgentCommunication` equal to an expected value. It is used to distinguish queued communications from visible assistant messages.

**Data flow**: Takes `&[ResponseItem]` and `&InterAgentCommunication`, iterates assistant message items, attempts `serde_json::from_str::<InterAgentCommunication>(text)` on each output-text span, and returns whether any parsed value equals the expected communication.

**Call relations**: Tests around inter-agent communication and completion notifications use this helper to assert whether a communication was rendered into history.

*Call graph*: 1 external calls (iter).


##### `wait_for_subagent_notification`  (lines 196–215)

```
async fn wait_for_subagent_notification(parent_thread: &Arc<CodexThread>) -> bool
```

**Purpose**: Polls a parent thread’s history until a subagent notification appears or a timeout expires. It hides asynchronous watcher scheduling delays from individual tests.

**Data flow**: Accepts `&Arc<CodexThread>`, repeatedly clones session history, converts it to raw items, and checks `has_subagent_notification`. It sleeps 25 ms between polls and wraps the loop in a 10-second `timeout`, returning `true` on success and `false` on timeout.

**Call relations**: Completion-notification tests call this helper after spawning or simulating child completion. It delegates the actual history predicate to `has_subagent_notification`.

*Call graph*: calls 1 internal fn (has_subagent_notification); 4 external calls (from_millis, from_secs, sleep, timeout).


##### `persist_thread_for_tree_resume`  (lines 217–228)

```
async fn persist_thread_for_tree_resume(thread: &Arc<CodexThread>, message: &str)
```

**Purpose**: Writes a user message into a thread and flushes rollout so resume tests have durable history on disk. It prepares threads for later shutdown and restoration.

**Data flow**: Takes `&Arc<CodexThread>` and a message string, injects the user message without a turn, awaits `ensure_rollout_materialized`, then flushes rollout and panics if flushing fails. It returns no value and mutates the thread’s persisted history.

**Call relations**: Tree-resume and shutdown tests call this helper before shutting threads down so persisted rollout exists for later resume.

*Call graph*: called by 9 (resume_agent_from_rollout_does_not_reopen_closed_descendants, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_agent_from_rollout_reads_archived_rollout_path, resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown, resume_agent_from_rollout_skips_descendants_when_parent_resume_fails, resume_agent_from_rollout_uses_edge_data_when_descendant_metadata_source_is_stale, resume_closed_child_reopens_open_descendants, shutdown_agent_tree_closes_descendants_when_started_at_child, shutdown_agent_tree_closes_live_descendants).


##### `wait_for_live_thread_spawn_children`  (lines 230–256)

```
async fn wait_for_live_thread_spawn_children(
    control: &AgentControl,
    parent_thread_id: ThreadId,
    expected_children: &[ThreadId],
)
```

**Purpose**: Polls `AgentControl` until the live open-child list for a parent matches an expected set of thread IDs. It synchronizes tests with asynchronous spawn-edge persistence and in-memory registration.

**Data flow**: Accepts `&AgentControl`, a parent thread ID, and a slice of expected child IDs. It sorts the expected IDs, repeatedly calls `open_thread_spawn_children(parent_thread_id).await`, extracts and sorts the returned child IDs, compares them to the expected list, sleeps 25 ms between attempts, and fails if a 5-second timeout expires.

**Call relations**: Subtree shutdown and resume tests use this helper before asserting tree behavior, ensuring the live spawn tree is fully visible.

*Call graph*: calls 1 internal fn (open_thread_spawn_children); called by 8 (resume_agent_from_rollout_does_not_reopen_closed_descendants, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown, resume_agent_from_rollout_skips_descendants_when_parent_resume_fails, resume_agent_from_rollout_uses_edge_data_when_descendant_metadata_source_is_stale, resume_closed_child_reopens_open_descendants, shutdown_agent_tree_closes_descendants_when_started_at_child, shutdown_agent_tree_closes_live_descendants); 6 external calls (from_millis, from_secs, sort_by_key, to_vec, sleep, timeout).


##### `assert_thread_not_loaded`  (lines 258–264)

```
async fn assert_thread_not_loaded(manager: &ThreadManager, thread_id: ThreadId)
```

**Purpose**: Asserts that a thread manager no longer has a given thread loaded in memory. It provides a clearer failure message than repeating the match logic in each test.

**Data flow**: Takes `&ThreadManager` and `thread_id`, awaits `manager.get_thread(thread_id)`, and matches the result: success is a panic, `ThreadNotFound(id)` asserts `id == thread_id`, and any other error panics.

**Call relations**: This helper is used by the V2 descendant-resume test to verify that unloaded descendants stay absent after root resume.

*Call graph*: calls 1 internal fn (get_thread); called by 1 (resume_agent_from_rollout_does_not_reopen_v2_descendants); 2 external calls (assert_eq!, panic!).


##### `send_input_errors_when_manager_dropped`  (lines 267–284)

```
async fn send_input_errors_when_manager_dropped()
```

**Purpose**: Checks that `AgentControl::send_input` fails with a manager-dropped error when the control is detached from any live thread manager. This validates graceful failure for orphaned controls.

**Data flow**: Creates `AgentControl::default()`, calls `send_input` on a fresh `ThreadId` with a one-item text input op, awaits the error, and asserts the error string equals `unsupported operation: thread manager dropped`.

**Call relations**: This test exercises the public send-input API without using the harness, specifically to simulate a dropped manager.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, default, vec!).


##### `get_status_returns_not_found_without_manager`  (lines 287–291)

```
async fn get_status_returns_not_found_without_manager()
```

**Purpose**: Verifies that status queries on a detached `AgentControl` report `AgentStatus::NotFound` rather than panicking or returning stale state.

**Data flow**: Creates `AgentControl::default()`, awaits `get_status(ThreadId::new())`, and asserts the result equals `AgentStatus::NotFound`.

**Call relations**: This is a basic detached-control behavior test independent of the harness.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, default).


##### `on_event_updates_status_from_task_started`  (lines 294–303)

```
async fn on_event_updates_status_from_task_started()
```

**Purpose**: Confirms that a `TurnStarted` event maps to `AgentStatus::Running`. It documents the event-to-status translation used elsewhere in the subsystem.

**Data flow**: Constructs `EventMsg::TurnStarted(TurnStartedEvent { ... })`, passes it to `agent_status_from_event`, and asserts the returned option is `Some(AgentStatus::Running)`.

**Call relations**: This test targets the status-mapping helper imported from the agent module rather than `AgentControl` methods directly.

*Call graph*: 3 external calls (assert_eq!, agent_status_from_event, TurnStarted).


##### `on_event_updates_status_from_task_complete`  (lines 306–316)

```
async fn on_event_updates_status_from_task_complete()
```

**Purpose**: Checks that a `TurnComplete` event with a final message maps to `AgentStatus::Completed(Some(message))`.

**Data flow**: Builds `EventMsg::TurnComplete(TurnCompleteEvent { last_agent_message: Some("done"), ... })`, feeds it to `agent_status_from_event`, and asserts the result equals `Some(AgentStatus::Completed(Some("done".to_string())))`.

**Call relations**: Like the other event-mapping tests, this isolates status derivation logic.

*Call graph*: 4 external calls (assert_eq!, agent_status_from_event, Completed, TurnComplete).


##### `on_event_updates_status_from_error`  (lines 319–327)

```
async fn on_event_updates_status_from_error()
```

**Purpose**: Verifies that an `Error` event becomes `AgentStatus::Errored` with the event message preserved.

**Data flow**: Constructs `EventMsg::Error(ErrorEvent { message: "boom", ... })`, calls `agent_status_from_event`, and asserts the result is `Some(AgentStatus::Errored("boom".to_string()))`.

**Call relations**: This is another focused status-mapping test.

*Call graph*: 4 external calls (assert_eq!, agent_status_from_event, Errored, Error).


##### `on_event_updates_status_from_turn_aborted`  (lines 330–340)

```
async fn on_event_updates_status_from_turn_aborted()
```

**Purpose**: Checks that an interrupted `TurnAborted` event maps to `AgentStatus::Interrupted`.

**Data flow**: Creates `EventMsg::TurnAborted(TurnAbortedEvent { reason: TurnAbortReason::Interrupted, ... })`, passes it to `agent_status_from_event`, and asserts the returned status is `Some(AgentStatus::Interrupted)`.

**Call relations**: This complements the other event-to-status tests.

*Call graph*: 3 external calls (assert_eq!, agent_status_from_event, TurnAborted).


##### `on_event_updates_status_from_shutdown_complete`  (lines 343–346)

```
async fn on_event_updates_status_from_shutdown_complete()
```

**Purpose**: Verifies that `EventMsg::ShutdownComplete` maps to `AgentStatus::Shutdown`.

**Data flow**: Calls `agent_status_from_event(&EventMsg::ShutdownComplete)` and asserts the result equals `Some(AgentStatus::Shutdown)`.

**Call relations**: This completes the event-mapping coverage for terminal shutdown.

*Call graph*: 2 external calls (assert_eq!, agent_status_from_event).


##### `spawn_agent_errors_when_manager_dropped`  (lines 349–360)

```
async fn spawn_agent_errors_when_manager_dropped()
```

**Purpose**: Ensures spawning through a detached `AgentControl` fails with the expected manager-dropped error. It validates the spawn path’s upgrade check.

**Data flow**: Creates `AgentControl::default()`, obtains a default test config, calls `spawn_agent(config, text_input("hello"), None).await`, expects an error, and asserts the error string matches the dropped-manager message.

**Call relations**: This test uses `test_config` and `text_input` but intentionally avoids a live harness to exercise the detached-control path.

*Call graph*: calls 2 internal fn (test_config, text_input); 2 external calls (assert_eq!, default).


##### `resume_agent_errors_when_manager_dropped`  (lines 363–374)

```
async fn resume_agent_errors_when_manager_dropped()
```

**Purpose**: Checks that rollout resume through a detached `AgentControl` fails cleanly with the manager-dropped error.

**Data flow**: Creates `AgentControl::default()`, gets a test config, calls `resume_agent_from_rollout(config, ThreadId::new(), SessionSource::Exec).await`, expects an error, and asserts the error string.

**Call relations**: This mirrors the detached spawn test for the resume API.

*Call graph*: calls 2 internal fn (test_config, new); 2 external calls (assert_eq!, default).


##### `send_input_errors_when_thread_missing`  (lines 377–393)

```
async fn send_input_errors_when_thread_missing()
```

**Purpose**: Verifies that sending input to a nonexistent thread returns `CodexErr::ThreadNotFound` with the requested ID.

**Data flow**: Builds a harness, creates a fresh `ThreadId`, calls `control.send_input(thread_id, text-op).await`, expects an error, and uses `assert_matches!` to confirm it is `ThreadNotFound(id)` with the same ID.

**Call relations**: This test uses the harness so the manager is live and the only failure condition is the missing thread.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert_matches!, vec!).


##### `get_status_returns_not_found_for_missing_thread`  (lines 396–400)

```
async fn get_status_returns_not_found_for_missing_thread()
```

**Purpose**: Checks that querying status for an unknown thread in a live manager returns `AgentStatus::NotFound`.

**Data flow**: Creates a harness, calls `control.get_status(ThreadId::new()).await`, and asserts the result equals `AgentStatus::NotFound`.

**Call relations**: This complements the detached-control status test by covering the live-manager missing-thread case.

*Call graph*: calls 2 internal fn (new, new); 1 external calls (assert_eq!).


##### `get_status_returns_pending_init_for_new_thread`  (lines 403–408)

```
async fn get_status_returns_pending_init_for_new_thread()
```

**Purpose**: Verifies that a freshly started thread initially reports `AgentStatus::PendingInit`.

**Data flow**: Creates a harness, starts a thread via `harness.start_thread().await`, queries `control.get_status(thread_id).await`, and asserts the returned status.

**Call relations**: This test uses the harness start helper to create a real thread before checking status.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `subscribe_status_errors_for_missing_thread`  (lines 411–420)

```
async fn subscribe_status_errors_for_missing_thread()
```

**Purpose**: Ensures status subscription fails with `ThreadNotFound` when the target thread does not exist.

**Data flow**: Creates a harness, generates a fresh `ThreadId`, calls `control.subscribe_status(thread_id).await`, expects an error, and matches it as `CodexErr::ThreadNotFound(id)`.

**Call relations**: This is the subscription analogue of the missing-thread status and send-input tests.

*Call graph*: calls 2 internal fn (new, new); 1 external calls (assert_matches!).


##### `subscribe_status_updates_on_shutdown`  (lines 423–440)

```
async fn subscribe_status_updates_on_shutdown()
```

**Purpose**: Checks that a status subscription receives a transition from `PendingInit` to `Shutdown` after a thread is sent `Op::Shutdown`.

**Data flow**: Creates a harness, starts a thread, subscribes to its status, asserts the initial borrowed value is `PendingInit`, submits `Op::Shutdown {}` directly to the thread, awaits `status_rx.changed()`, and asserts the new borrowed value is `Shutdown`.

**Call relations**: This test exercises the live status broadcast path after thread shutdown.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `send_input_submits_user_message`  (lines 443–479)

```
async fn send_input_submits_user_message()
```

**Purpose**: Verifies that `AgentControl::send_input` submits the expected `Op::UserInput` to the manager and returns a nonempty submission ID.

**Data flow**: Creates a harness and thread, calls `control.send_input(thread_id, text-op).await`, asserts the returned submission ID is nonempty, constructs the exact expected `(thread_id, Op::UserInput { ... })` tuple, and searches `manager.captured_ops()` for it.

**Call relations**: This test validates the public send-input API by inspecting the manager’s captured operations.

*Call graph*: calls 1 internal fn (new); 4 external calls (default, assert!, assert_eq!, vec!).


##### `send_inter_agent_communication_without_turn_queues_message_without_triggering_turn`  (lines 482–541)

```
async fn send_inter_agent_communication_without_turn_queues_message_without_triggering_turn()
```

**Purpose**: Checks that non-triggering inter-agent communication is queued as input but does not start a turn or appear as assistant-visible communication in history.

**Data flow**: Creates a harness and thread, builds an `InterAgentCommunication` with `trigger_turn = false`, sends it through `control.send_inter_agent_communication`, asserts a nonempty submission ID and the expected captured `Op`, then polls the thread’s input queue until pending input exists. It finally clones history and asserts the communication is not present as assistant inter-agent output.

**Call relations**: This test combines manager-op inspection with direct session-state inspection to verify the no-turn queueing semantics.

*Call graph*: calls 4 internal fn (new, root, try_from, new); 7 external calls (from_millis, from_secs, new, assert!, assert_eq!, sleep, timeout).


##### `ensure_v2_agent_loaded_reloads_registered_unloaded_agent`  (lines 544–633)

```
async fn ensure_v2_agent_loaded_reloads_registered_unloaded_agent()
```

**Purpose**: Verifies that a known V2 subagent removed from memory can be reloaded on demand and then accepts further inter-agent communication. It covers the lazy-load path for unloaded but persisted V2 agents.

**Data flow**: Builds a V2+SQLite harness, starts a parent thread, spawns a V2 child with metadata, injects a persisted assistant final answer into the child, shuts the child down, removes it from the manager, confirms it is absent, calls `control.ensure_v2_agent_loaded(config, child_id).await`, confirms the child is loaded again, then sends a non-triggering inter-agent communication to the reloaded child and asserts the expected captured `Op`.

**Call relations**: This test drives `spawn_agent_with_metadata`, thread persistence, manager removal, and `ensure_v2_agent_loaded` together to validate the reload workflow.

*Call graph*: calls 6 internal fn (new_with_config, test_config, text_input, root, try_from, new); 7 external calls (default, new, SubAgent, assert!, assert_eq!, panic!, vec!).


##### `resume_agent_from_rollout_does_not_reopen_v2_descendants`  (lines 636–723)

```
async fn resume_agent_from_rollout_does_not_reopen_v2_descendants()
```

**Purpose**: Checks that resuming a V2 root thread from rollout does not automatically reopen its V2 descendants. This documents the intentional difference between V2 and non-V2 tree resume.

**Data flow**: Creates a V2+SQLite harness, starts a parent thread, spawns worker and reviewer descendants, persists rollout for all three, waits for live child edges to appear, shuts down all threads through the manager, creates a fresh manager/control over the same home and state DB, resumes the parent from rollout with `SessionSource::Exec`, asserts the parent is present, and uses `assert_thread_not_loaded` to confirm worker and reviewer remain unloaded.

**Call relations**: This test uses `persist_thread_for_tree_resume`, `wait_for_live_thread_spawn_children`, and `assert_thread_not_loaded` to validate the high-level resume policy for V2 trees.

*Call graph*: calls 10 internal fn (new_with_config, assert_thread_not_loaded, persist_thread_for_tree_resume, test_config, text_input, wait_for_live_thread_spawn_children, with_models_provider_home_and_state_for_tests, default_for_tests, from_api_key, root); 5 external calls (from_secs, SubAgent, assert_eq!, assert_ne!, new).


##### `encrypted_inter_agent_communication_clears_existing_last_task_message`  (lines 726–779)

```
async fn encrypted_inter_agent_communication_clears_existing_last_task_message()
```

**Purpose**: Verifies that sending encrypted inter-agent communication clears any stored plaintext `last_task_message` metadata for the child. This prevents stale plaintext task text from remaining in registry metadata.

**Data flow**: Creates a harness and parent thread, spawns a child with initial plaintext task input, asserts `control.state.agent_metadata_for_thread(child_id).last_task_message` is that plaintext, constructs an encrypted `InterAgentCommunication` with `trigger_turn = true`, sends it, and then asserts the metadata field is now `None`.

**Call relations**: This test inspects registry metadata before and after the public send-inter-agent API to validate side effects on stored task text.

*Call graph*: calls 5 internal fn (new, text_input, root, try_from, new_encrypted); 4 external calls (default, new, SubAgent, assert_eq!).


##### `spawn_agent_creates_thread_and_sends_prompt`  (lines 782–817)

```
async fn spawn_agent_creates_thread_and_sends_prompt()
```

**Purpose**: Checks that spawning a root agent creates a registered thread and immediately submits the provided initial prompt as `Op::UserInput`.

**Data flow**: Creates a harness, calls `control.spawn_agent(config.clone(), text_input("spawned"), None).await`, confirms the thread exists in the manager, constructs the expected captured `Op::UserInput`, and asserts it appears in `manager.captured_ops()`.

**Call relations**: This is the basic happy-path spawn integration test for root threads.

*Call graph*: calls 2 internal fn (new, text_input); 3 external calls (default, assert_eq!, vec!).


##### `spawn_agent_can_fork_parent_thread_history_with_sanitized_items`  (lines 820–1055)

```
async fn spawn_agent_can_fork_parent_thread_history_with_sanitized_items()
```

**Purpose**: Verifies full-history fork behavior: parent rollout is sanitized, stale parent usage hints are removed, only final assistant output survives, the child subagent hint is inserted when enabled, and the parent reference context is preserved.

**Data flow**: Creates a harness, configures distinct parent and child V2 usage hints, starts a parent thread, injects seed context and a turn containing developer hints, assistant commentary/final/unknown-phase messages, reasoning, trigger communication, and a spawn call, persists a `TurnContext`, flushes rollout, then spawns a forked child with `SpawnAgentForkMode::FullHistory`. It loads the child history and asserts it equals the expected sanitized sequence, compares serialized reference-context items to ensure preservation, repeats the spawn with usage hints disabled and asserts the child hint is absent, verifies the initial child prompt was submitted, and finally shuts down both children and the parent.

**Call relations**: This test is the most comprehensive consumer of fork logic, using `assistant_message`, `spawn_agent_call`, and `text_input` to build parent history and then validating `spawn_agent_with_metadata` fork behavior.

*Call graph*: calls 7 internal fn (new, assistant_message, spawn_agent_call, text_input, root, try_from, new); 8 external calls (default, new, SubAgent, assert!, assert_eq!, assert_ne!, TurnContext, vec!).


##### `spawn_agent_fork_strips_parent_usage_hints_from_compacted_history`  (lines 1058–1176)

```
async fn spawn_agent_fork_strips_parent_usage_hints_from_compacted_history()
```

**Purpose**: Checks that fork sanitization removes stale parent usage hints even when they appear inside `Compacted.replacement_history`, while preserving non-hint compacted content and adding the child hint.

**Data flow**: Creates parent and child V2 configs with different hints, starts a parent thread, persists a `RolloutItem::Compacted` containing replacement history with a user summary and a parent developer hint, plus a `TurnContext` and spawn call, flushes rollout, spawns a full-history forked child, loads child history, and asserts the compacted summary remains, the parent hint is absent, and the child subagent hint is present. It then shuts down child and parent.

**Call relations**: This test specifically targets the compacted-history sanitization branch inside fork spawning.

*Call graph*: calls 3 internal fn (new, spawn_agent_call, text_input); 8 external calls (default, new, SubAgent, assert!, Compacted, ResponseItem, TurnContext, vec!).


##### `spawn_agent_fork_flushes_parent_rollout_before_loading_history`  (lines 1179–1238)

```
async fn spawn_agent_fork_flushes_parent_rollout_before_loading_history()
```

**Purpose**: Verifies that fork spawning flushes the parent’s pending rollout writes before reading stored history, so unflushed final answers are visible in the child fork.

**Data flow**: Creates a harness and parent thread, records an assistant final answer and spawn call into a turn without flushing first, spawns a full-history forked child, loads the child history, and asserts the previously unflushed final answer text is present. It then shuts down child and parent.

**Call relations**: This test validates the explicit parent `flush_rollout` step in `spawn_forked_thread`.

*Call graph*: calls 4 internal fn (new, assistant_message, spawn_agent_call, text_input); 3 external calls (default, SubAgent, assert!).


##### `spawn_agent_fork_last_n_turns_keeps_only_recent_turns`  (lines 1241–1377)

```
async fn spawn_agent_fork_last_n_turns_keeps_only_recent_turns()
```

**Purpose**: Checks bounded fork behavior for `LastNTurns(2)`: older parent context is dropped, queued and triggered inter-agent messages are filtered, the recent parent task is retained, and reference context is cleared so the child rebuilds context.

**Data flow**: Creates a harness and parent thread, injects old context, records a queued non-triggering communication turn, records a triggering communication turn, injects the current parent task, records a spawn call and `TurnContext`, flushes rollout, spawns a child with `SpawnAgentForkMode::LastNTurns(2)`, loads child history, and asserts absence or presence of the expected texts plus `reference_context_item().await.is_none()`. It then shuts down child and parent.

**Call relations**: This test exercises the truncation path in fork spawning and uses history helpers to verify exactly what survived.

*Call graph*: calls 6 internal fn (new, spawn_agent_call, text_input, root, try_from, new); 6 external calls (default, new, SubAgent, assert!, LastNTurns, TurnContext).


##### `spawn_agent_fork_last_n_turns_drops_parent_startup_prefix_when_under_limit`  (lines 1380–1480)

```
async fn spawn_agent_fork_last_n_turns_drops_parent_startup_prefix_when_under_limit()
```

**Purpose**: Verifies that bounded forks still drop startup-prefix context even when the requested last-N window exceeds the number of recent turns available. The child should rebuild startup context rather than inherit the parent prefix.

**Data flow**: Creates a harness and parent thread, records a startup developer-context turn, injects a current parent task, records a spawn call, flushes rollout, spawns a child with `LastNTurns(2)`, loads child history, and asserts the current task remains, the startup developer context is absent, and `reference_context_item()` is `None`. It then shuts down child and parent.

**Call relations**: This test covers the under-limit truncation edge case for bounded forks.

*Call graph*: calls 3 internal fn (new, spawn_agent_call, text_input); 5 external calls (default, SubAgent, assert!, LastNTurns, vec!).


##### `spawn_agent_fork_last_n_turns_strips_parent_usage_hints`  (lines 1483–1582)

```
async fn spawn_agent_fork_last_n_turns_strips_parent_usage_hints()
```

**Purpose**: Checks that bounded forks remove stale parent usage hints before the child rebuilds its own startup context. It ensures hint sanitization is not limited to full-history forks.

**Data flow**: Creates parent and child V2 configs, starts a parent thread, injects a parent task, records a developer parent hint and spawn call, flushes rollout, spawns a child with `LastNTurns(2)`, loads child history, and asserts the parent task remains while the parent hint text is absent. It then shuts down child and parent.

**Call relations**: This test targets the interaction between last-N truncation and usage-hint filtering.

*Call graph*: calls 3 internal fn (new, spawn_agent_call, text_input); 5 external calls (default, SubAgent, assert!, LastNTurns, vec!).


##### `spawn_agent_respects_max_threads_limit`  (lines 1585–1634)

```
async fn spawn_agent_respects_max_threads_limit()
```

**Purpose**: Verifies that spawning respects the configured `agents.max_threads` limit and returns `CodexErr::AgentLimitReached` with the configured maximum when exceeded.

**Data flow**: Builds a config with `agents.max_threads = 1`, creates a manager/control, starts one root thread, spawns a first agent successfully, attempts to spawn a second agent, matches the resulting error as `AgentLimitReached { max_threads }`, asserts `max_threads == 1`, and shuts down the first agent.

**Call relations**: This test uses `test_config_with_cli_overrides` to configure the limit and then drives the public spawn API against a real manager.

*Call graph*: calls 5 internal fn (test_config_with_cli_overrides, text_input, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 4 external calls (assert_eq!, panic!, new, vec!).


##### `spawn_agent_releases_slot_after_shutdown`  (lines 1637–1677)

```
async fn spawn_agent_releases_slot_after_shutdown()
```

**Purpose**: Checks that shutting down a spawned agent releases its spawn-slot accounting so another agent can be spawned afterward under the same limit.

**Data flow**: Builds a config with `agents.max_threads = 1`, creates manager/control, spawns one agent, shuts it down, spawns a second agent successfully with the same config, and shuts the second down.

**Call relations**: This test complements the limit-enforcement test by validating slot release on shutdown.

*Call graph*: calls 5 internal fn (test_config_with_cli_overrides, text_input, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 2 external calls (new, vec!).


##### `spawn_agent_limit_shared_across_clones`  (lines 1680–1722)

```
async fn spawn_agent_limit_shared_across_clones()
```

**Purpose**: Verifies that cloned `AgentControl` handles share the same spawn-limit accounting. A slot consumed through one clone blocks spawning through another.

**Data flow**: Builds a one-thread config, creates manager/control and a clone, spawns the first agent through the clone, attempts a second spawn through the original control, matches `AgentLimitReached { max_threads }`, asserts the value is 1, and shuts down the first agent.

**Call relations**: This test documents that the registry state is shared behind cloned controls rather than copied.

*Call graph*: calls 5 internal fn (test_config_with_cli_overrides, text_input, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 4 external calls (assert_eq!, panic!, new, vec!).


##### `resume_agent_respects_max_threads_limit`  (lines 1725–1778)

```
async fn resume_agent_respects_max_threads_limit()
```

**Purpose**: Checks that rollout resume consumes the same spawn-slot budget as fresh spawn and is rejected when the configured thread limit is already occupied.

**Data flow**: Builds a one-thread config, creates manager/control, spawns and shuts down a resumable thread, spawns another active thread to occupy the slot, attempts `resume_agent_from_rollout` for the first thread, matches `AgentLimitReached { max_threads }`, asserts the value is 1, and shuts down the active thread.

**Call relations**: This test validates that resume paths use the same registry reservation mechanism as spawn.

*Call graph*: calls 5 internal fn (test_config_with_cli_overrides, text_input, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 4 external calls (assert_eq!, panic!, new, vec!).


##### `resume_agent_releases_slot_after_resume_failure`  (lines 1781–1809)

```
async fn resume_agent_releases_slot_after_resume_failure()
```

**Purpose**: Verifies that a failed resume attempt does not leak a spawn slot, allowing a subsequent spawn to succeed under the same limit.

**Data flow**: Builds a one-thread config, creates manager/control, attempts to resume a random `ThreadId` and expects failure, then spawns a new agent successfully and shuts it down.

**Call relations**: This test covers reservation cleanup on resume failure.

*Call graph*: calls 6 internal fn (test_config_with_cli_overrides, text_input, with_models_provider_and_home_for_tests, default_for_tests, from_api_key, new); 2 external calls (new, vec!).


##### `spawn_child_completion_notifies_parent_history`  (lines 1812–1843)

```
async fn spawn_child_completion_notifies_parent_history()
```

**Purpose**: Checks that when a spawned child shuts down, the parent eventually receives a subagent notification in its history. This validates the completion-watcher path for ordinary child spawns.

**Data flow**: Creates a harness, starts a parent thread, spawns a child subagent, loads the child thread, submits `Op::Shutdown {}` to it, and asserts `wait_for_subagent_notification(&parent_thread).await == true`.

**Call relations**: This test relies on the completion watcher started during non-V2 child spawn and uses the polling helper to observe the parent-side effect.

*Call graph*: calls 2 internal fn (new, text_input); 2 external calls (SubAgent, assert_eq!).


##### `multi_agent_v2_completion_ignores_dead_direct_parent`  (lines 1846–1953)

```
async fn multi_agent_v2_completion_ignores_dead_direct_parent()
```

**Purpose**: Verifies that V2 completion handling does not queue a direct-parent message or root notification when the direct parent thread has already been shut down. This prevents stale upward routing through dead parents.

**Data flow**: Creates a harness, enables V2 for a root and nested worker/tester topology, spawns worker and tester subagents, shuts down the worker, sends a `TurnComplete` event to the tester, waits briefly, then asserts no captured op targeted the dead worker and that the root history contains neither the serialized completion communication nor a subagent notification.

**Call relations**: This test exercises the V2 completion path after parent death, contrasting with the next test where the direct parent is alive.

*Call graph*: calls 3 internal fn (new, text_input, root); 5 external calls (from_millis, SubAgent, assert!, TurnComplete, sleep).


##### `multi_agent_v2_completion_queues_message_for_direct_parent`  (lines 1956–2055)

```
async fn multi_agent_v2_completion_queues_message_for_direct_parent()
```

**Purpose**: Checks that V2 child completion queues an `InterAgentCommunication` to the direct parent thread rather than surfacing as a root-history notification. It validates the direct-parent routing behavior.

**Data flow**: Creates a harness with separate root and worker threads plus a V2 tester thread, manually starts a completion watcher for the tester with a thread-spawn session source, sends a `TurnComplete` event to the tester, computes the expected completion message via `format_inter_agent_completion_message`, constructs the expected captured `Op::InterAgentCommunication` to the worker, polls `manager.captured_ops()` until it appears, and finally asserts the root history does not contain that communication.

**Call relations**: This test manually invokes `maybe_start_completion_watcher` and then observes the queued parent-directed op, documenting the V2 completion-routing contract.

*Call graph*: calls 4 internal fn (new, format_inter_agent_completion_message, root, new); 9 external calls (from_millis, from_secs, new, SubAgent, assert!, Completed, TurnComplete, sleep, timeout).


##### `completion_watcher_notifies_parent_when_child_is_missing`  (lines 2058–2096)

```
async fn completion_watcher_notifies_parent_when_child_is_missing()
```

**Purpose**: Verifies that the completion watcher still notifies the parent when the child thread cannot be loaded, reporting the child as `not_found` in the notification payload.

**Data flow**: Creates a harness and parent thread, generates a fresh child thread ID that does not exist, starts a completion watcher for that missing child, waits for a parent notification, clones parent history, and asserts it contains the child ID and the JSON status string `"status":"not_found"`.

**Call relations**: This test covers the missing-child branch of the completion watcher rather than a normal completion event.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (SubAgent, assert_eq!).


##### `spawn_thread_subagent_gets_random_nickname_in_session_source`  (lines 2099–2140)

```
async fn spawn_thread_subagent_gets_random_nickname_in_session_source()
```

**Purpose**: Checks that a thread-spawn subagent receives an automatically assigned nickname in its stored session source when none is provided.

**Data flow**: Creates a harness and parent thread, spawns a child subagent with `agent_nickname: None`, loads the child thread, obtains its config snapshot, pattern-matches the `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { ... })`, and asserts the parent ID and depth are correct, `agent_nickname.is_some()`, and the role is preserved.

**Call relations**: This test validates the nickname reservation path used during `prepare_thread_spawn`.

*Call graph*: calls 2 internal fn (new, text_input); 4 external calls (SubAgent, assert!, assert_eq!, panic!).


##### `spawn_thread_subagent_uses_role_specific_nickname_candidates`  (lines 2143–2184)

```
async fn spawn_thread_subagent_uses_role_specific_nickname_candidates()
```

**Purpose**: Verifies that role-specific nickname candidates from config override the default nickname pool during subagent spawn.

**Data flow**: Creates a harness, inserts an `AgentRoleConfig` for `researcher` with nickname candidate `Atlas`, starts a parent thread, spawns a child subagent with role `researcher`, loads the child snapshot, pattern-matches the thread-spawn session source, and asserts `agent_nickname == Some("Atlas".to_string())`.

**Call relations**: This test ties config role metadata to the spawn-time nickname selection logic.

*Call graph*: calls 2 internal fn (new, text_input); 4 external calls (SubAgent, assert_eq!, panic!, vec!).


##### `resume_thread_subagent_restores_stored_nickname_and_role`  (lines 2187–2328)

```
async fn resume_thread_subagent_restores_stored_nickname_and_role()
```

**Purpose**: Checks that resuming a thread-spawn subagent restores its persisted nickname and role from SQLite metadata even if the resume request omits them.

**Data flow**: Builds a SQLite-enabled harness manually, starts a parent thread, spawns a child with an explicit agent path and role, waits until the child status advances past `PendingInit`, captures the original nickname from the child config snapshot, polls the state DB until persisted metadata contains nickname and role, shuts the child down, resumes it from rollout with a session source lacking nickname and role, loads the resumed snapshot, pattern-matches the thread-spawn source, and asserts parent ID, depth, path, nickname, and role all match the persisted values. It then shuts the resumed child down.

**Call relations**: This test validates the metadata-restoration branch inside `resume_single_agent_from_rollout`.

*Call graph*: calls 6 internal fn (test_config, text_input, with_models_provider_home_and_state_for_tests, default_for_tests, from_api_key, from_string); 10 external calls (from_millis, from_secs, SubAgent, assert_eq!, init_state_db, matches!, panic!, new, sleep, timeout).


##### `resume_agent_from_rollout_reads_archived_rollout_path`  (lines 2331–2377)

```
async fn resume_agent_from_rollout_reads_archived_rollout_path()
```

**Purpose**: Verifies that resume can find and use a rollout path after the thread has been archived. This ensures archived threads remain resumable.

**Data flow**: Creates a harness, spawns a child, persists rollout, shuts the child down, constructs a `LocalThreadStore`, archives the thread, calls `resume_agent_from_rollout` for the archived thread ID, asserts the resumed ID matches, and shuts the resumed child down.

**Call relations**: This test covers the archived-thread storage path rather than only live or unarchived rollout files.

*Call graph*: calls 5 internal fn (new, persist_thread_for_tree_resume, text_input, new, from_config); 1 external calls (assert_eq!).


##### `list_agent_subtree_thread_ids_includes_anonymous_and_closed_descendants`  (lines 2380–2503)

```
async fn list_agent_subtree_thread_ids_includes_anonymous_and_closed_descendants()
```

**Purpose**: Checks that subtree enumeration includes descendants without agent paths and descendants that have already been shut down. It validates tree traversal by thread relationships rather than only live named paths.

**Data flow**: Creates a harness and parent thread, spawns a worker subtree with both named and anonymous descendants plus a separate reviewer branch, shuts down the anonymous grandchild, calls `manager.list_agent_subtree_thread_ids(worker_thread_id).await` and `... (no_path_child_thread_id).await`, sorts the results, and asserts they match the expected thread-ID sets including the closed grandchild.

**Call relations**: This test exercises manager-side subtree enumeration after a mix of named, anonymous, and closed descendants have been created.

*Call graph*: calls 3 internal fn (new, text_input, root); 3 external calls (SubAgent, assert_eq!, vec!).


##### `list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root`  (lines 2506–2563)

```
async fn list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root()
```

**Purpose**: Verifies that subtree enumeration can still find live descendants even when the root thread itself has been removed from the manager. This covers partially unloaded trees without a state DB.

**Data flow**: Builds a manager/control without SQLite, starts a parent thread, spawns child and grandchild subagents, removes the parent thread from the manager, calls `manager.list_agent_subtree_thread_ids(parent_thread_id).await`, sorts the result, and asserts it contains the unloaded root ID plus both live descendants.

**Call relations**: This test documents that subtree discovery is not limited to currently loaded roots.

*Call graph*: calls 5 internal fn (test_config, text_input, with_models_provider_home_and_state_for_tests, default_for_tests, from_api_key); 4 external calls (SubAgent, assert_eq!, new, vec!).


##### `shutdown_agent_tree_closes_live_descendants`  (lines 2566–2648)

```
async fn shutdown_agent_tree_closes_live_descendants()
```

**Purpose**: Checks that shutting down an agent tree from the root closes the root and all live descendants, updates their statuses to `NotFound`, and submits shutdown ops for each thread.

**Data flow**: Creates a harness and parent thread, spawns child and grandchild, persists rollout for descendants, waits for live child edges, calls `control.shutdown_agent_tree(parent_thread_id).await`, asserts all three thread statuses are `NotFound`, extracts shutdown-target thread IDs from `manager.captured_ops()`, sorts them, and asserts they equal the expected set.

**Call relations**: This test validates the recursive shutdown behavior implemented in `legacy.rs` using persisted and live tree state.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 3 external calls (SubAgent, assert_eq!, vec!).


##### `shutdown_agent_tree_closes_descendants_when_started_at_child`  (lines 2651–2739)

```
async fn shutdown_agent_tree_closes_descendants_when_started_at_child()
```

**Purpose**: Verifies that closing a child subtree first and then shutting down the parent tree still results in all relevant threads being shut down exactly as expected.

**Data flow**: Creates a harness and parent/child/grandchild topology, persists rollout for descendants, waits for live child edges, calls `control.close_agent(child_thread_id).await`, then `control.shutdown_agent_tree(parent_thread_id).await`, asserts all statuses are `NotFound`, and checks the captured shutdown op IDs match parent, child, and grandchild.

**Call relations**: This test combines `close_agent` and `shutdown_agent_tree` to validate interaction between explicit close persistence and later tree shutdown.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 3 external calls (SubAgent, assert_eq!, vec!).


##### `resume_agent_from_rollout_does_not_reopen_closed_descendants`  (lines 2742–2834)

```
async fn resume_agent_from_rollout_does_not_reopen_closed_descendants()
```

**Purpose**: Checks that resuming a parent from rollout does not reopen descendants whose spawn edges were explicitly closed. This preserves durable close semantics across restart/resume.

**Data flow**: Creates a harness and parent/child/grandchild topology, persists rollout for all threads, waits for live child edges, closes the child, shuts down the parent, resumes the parent from rollout, asserts the parent is present but child and grandchild statuses are `NotFound`, and finally shuts down the resumed parent tree.

**Call relations**: This test validates the persisted closed-edge filtering in the resume-tree logic.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 3 external calls (SubAgent, assert_eq!, assert_ne!).


##### `resume_closed_child_reopens_open_descendants`  (lines 2837–2931)

```
async fn resume_closed_child_reopens_open_descendants()
```

**Purpose**: Verifies that directly resuming a previously closed child thread reopens that child and any descendants whose edges remain open beneath it. This distinguishes subtree-local resume from parent-root resume.

**Data flow**: Creates a harness and parent/child/grandchild topology, persists rollout, waits for live child edges, closes the child, resumes the child directly from rollout with a thread-spawn session source, asserts both child and grandchild statuses are no longer `NotFound`, then closes the child again and shuts down the parent.

**Call relations**: This test exercises resume-tree traversal starting from a non-root node after that node had been explicitly closed.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 3 external calls (SubAgent, assert_eq!, assert_ne!).


##### `resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown`  (lines 2934–3022)

```
async fn resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown()
```

**Purpose**: Checks that after a full manager shutdown, resuming a parent from rollout reopens the parent and all descendants whose persisted edges are still open.

**Data flow**: Creates a harness and parent/child/grandchild topology, persists rollout for all threads, waits for live child edges, shuts down all threads through the manager, resumes the parent from rollout, asserts parent, child, and grandchild statuses are all present, and then shuts down the resumed tree.

**Call relations**: This test covers the normal non-V2 subtree-resume path after a clean manager shutdown.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 4 external calls (from_secs, SubAgent, assert_eq!, assert_ne!).


##### `resume_agent_from_rollout_uses_edge_data_when_descendant_metadata_source_is_stale`  (lines 3025–3153)

```
async fn resume_agent_from_rollout_uses_edge_data_when_descendant_metadata_source_is_stale()
```

**Purpose**: Verifies that descendant resume uses persisted spawn-edge data rather than trusting stale serialized session-source metadata stored on the descendant itself. This protects tree reconstruction from corrupted descendant metadata.

**Data flow**: Creates a harness and parent/child/grandchild topology, persists rollout, waits for live child edges, loads the grandchild’s SQLite metadata, overwrites its serialized `source` with a bogus parent/depth, persists that stale metadata, shuts down all threads, resumes the parent from rollout, asserts all three threads are present, loads the resumed grandchild snapshot, pattern-matches its thread-spawn source, and asserts the resumed parent ID and depth are the correct edge-derived values. It then shuts down the resumed tree.

**Call relations**: This test targets the resume-tree logic that reconstructs descendant session sources from edge traversal rather than descendant metadata.

*Call graph*: calls 5 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children, new); 6 external calls (from_secs, SubAgent, assert_eq!, assert_ne!, panic!, to_string).


##### `resume_agent_from_rollout_skips_descendants_when_parent_resume_fails`  (lines 3156–3250)

```
async fn resume_agent_from_rollout_skips_descendants_when_parent_resume_fails()
```

**Purpose**: Checks that if a descendant’s own resume fails, its descendants are not reopened either. The tree-resume traversal only continues through successfully resumed nodes.

**Data flow**: Creates a harness and parent/child/grandchild topology, persists rollout, waits for live child edges, records the child rollout path, shuts down all threads, deletes the child rollout file, resumes the parent from rollout, asserts the parent is present while child and grandchild remain `NotFound`, and then shuts down the resumed parent tree.

**Call relations**: This test validates the breadth-first resume queue behavior: descendants are enqueued only when their parent child node resumed successfully.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 5 external calls (from_secs, SubAgent, assert_eq!, assert_ne!, remove_file).


### `core/src/agent/control/execution_tests.rs`

`test` · `test execution`

This test file exercises the small execution-capacity subsystem in isolation. It builds `AgentControl` instances with a preconfigured `AgentExecutionLimiter` and then drives the public `ensure_execution_capacity` and `execution_guard` methods directly, without needing live threads or async task execution.

The helper `control_with_limit` constructs a default `AgentControl` and initializes the limiter once. The first test proves two important invariants: only the first `initialize` call matters, and a live `AgentExecutionGuard` increments the active count until dropped. It sets a limit of 1, attempts a second initialization with 2, then verifies that the second V2 subagent turn is rejected with `CodexErr::AgentLimitReached { max_threads: 1 }`. After explicitly dropping the first guard, the same capacity check succeeds again, demonstrating RAII-based release.

The second test covers the policy exclusions. It creates a control with a zero limit and confirms that `execution_guard` still returns `None` for a V2 root session (`SessionSource::Cli`) and for a V1 subagent session. Using a zero limit here is deliberate: if those cases were incorrectly counted, the test would fail immediately. Together these tests pin down both the inclusion predicate and the one-time initialization behavior.

#### Function details

##### `control_with_limit`  (lines 8–12)

```
fn control_with_limit(max_threads: usize) -> AgentControl
```

**Purpose**: Builds a default `AgentControl` with its execution limiter initialized to a chosen maximum. It is a small fixture helper shared by the tests in this file.

**Data flow**: Takes `max_threads: usize`, creates `AgentControl::default()`, calls `control.agent_execution_limiter.initialize(max_threads)`, and returns the configured control. It mutates only the newly created control’s limiter state.

**Call relations**: Both tests call this helper to avoid repeating setup. It delegates object creation to `AgentControl::default` and limiter configuration to `initialize`.

*Call graph*: called by 2 (execution_guards_count_active_v2_subagent_turns, execution_guards_ignore_root_and_v1_turns); 1 external calls (default).


##### `execution_guards_count_active_v2_subagent_turns`  (lines 15–41)

```
fn execution_guards_count_active_v2_subagent_turns()
```

**Purpose**: Verifies that V2 subagent executions consume capacity, that the first configured limit is retained, and that dropping a guard frees the slot. It checks the exact error payload returned when the cap is exceeded.

**Data flow**: Creates a control with limit 1, attempts a second initialization with 2, constructs a `SessionSource::SubAgent(SubAgentSource::Other("worker"))`, then calls `ensure_execution_capacity` and `execution_guard` for a first successful reservation. It performs a second capacity check, pattern-matches the resulting `CodexErr::AgentLimitReached { max_threads }`, asserts `max_threads == 1`, drops the first guard, and finally confirms capacity is available again.

**Call relations**: This test drives the public limiter API directly after setup from `control_with_limit`. It does not call internal helpers beyond constructing the subagent source and asserting outcomes.

*Call graph*: calls 1 internal fn (control_with_limit); 4 external calls (SubAgent, assert_eq!, panic!, Other).


##### `execution_guards_ignore_root_and_v1_turns`  (lines 44–60)

```
fn execution_guards_ignore_root_and_v1_turns()
```

**Purpose**: Confirms that sessions outside the V2-subagent policy boundary are never counted. It uses a zero-thread limit to make any accidental counting immediately visible.

**Data flow**: Creates a control with limit 0, then calls `execution_guard` twice: once for `MultiAgentVersion::V2` with `SessionSource::Cli`, and once for `MultiAgentVersion::V1` with a subagent source. It asserts both calls return `None` and performs no stateful cleanup because no guard is created.

**Call relations**: This test also uses `control_with_limit` for setup. It validates the same policy predicate used by production code, but through the externally visible `execution_guard` behavior.

*Call graph*: calls 1 internal fn (control_with_limit); 1 external calls (assert!).


### `core/src/agent/control/residency_tests.rs`

`test` · `test execution`

This file integration-tests the residency subsystem against a real `ThreadManager` and `AgentControl`. Each test enables `Feature::MultiAgentV2`, constrains `config.multi_agent_v2.max_concurrent_threads_per_session`, and uses a temporary home directory so rollout and thread state are isolated. The helper `spawn_v2_subagent` creates subagent threads through `ThreadManagerState::spawn_new_thread_with_source`, while `mark_thread_completed` and `mark_thread_interrupted` synthesize terminal events directly into a thread session and then manually clear `active_turn` because the fixture has no task runner to do that automatically.

The first test proves LRU-style eviction of an idle completed V2 subagent. After reserving and committing the first slot, it marks that thread completed, reserves a second slot, and expects the first thread to have been removed from the manager before the second child is spawned. It also verifies that the root thread remains loaded.

The second test repeats the pattern with an interrupted thread and then calls `ensure_v2_agent_loaded` on the evicted thread ID. The expected result is `CodexErr::ThreadNotFound`, documenting an important behavior: interrupted V2 agents evicted by residency are considered lost rather than resumable from persisted state. These tests therefore validate both eviction eligibility and the post-eviction semantics of interrupted residents.

#### Function details

##### `residency_slot_reservation_unloads_oldest_idle_v2_agent`  (lines 22–65)

```
async fn residency_slot_reservation_unloads_oldest_idle_v2_agent()
```

**Purpose**: Verifies that reserving a new V2 residency slot evicts the oldest idle completed subagent when capacity is full. It confirms the root thread and the newly spawned resident remain loaded.

**Data flow**: Builds a V2-enabled `Config` with capacity 2 and temporary filesystem paths, creates a `ThreadManager`, starts a root thread, obtains `AgentControl` and manager state, reserves and commits a first residency slot around a spawned V2 subagent, marks that child completed, then reserves a second slot. It checks that `manager.get_thread(first.thread_id)` now returns `CodexErr::ThreadNotFound`, spawns a second subagent, commits the second slot, and asserts the root and second child are still present.

**Call relations**: This test uses `spawn_v2_subagent` to create resident candidates and `mark_thread_completed` to make the first one unloadable. It drives the production `reserve_v2_residency_slot` path end-to-end.

*Call graph*: calls 6 internal fn (mark_thread_completed, spawn_v2_subagent, test_config, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 5 external calls (new, assert!, assert_eq!, panic!, tempdir).


##### `interrupted_v2_agent_is_lost_after_residency_eviction`  (lines 68–127)

```
async fn interrupted_v2_agent_is_lost_after_residency_eviction()
```

**Purpose**: Checks that an interrupted idle V2 subagent can be evicted for residency pressure and that, once evicted, it is not reloadable through `ensure_v2_agent_loaded`. This captures the intended semantics for interrupted residents.

**Data flow**: Creates the same V2-enabled manager setup as the previous test, reserves and commits a first slot for a spawned subagent, marks that thread interrupted, reserves a second slot and verifies the first thread has been removed, then spawns and commits a second subagent and marks it completed. It finally calls `control.ensure_v2_agent_loaded(config, first.thread_id).await`, expects an error, matches it as `CodexErr::ThreadNotFound(first.thread_id)`, and rechecks manager visibility for root, second, and first threads.

**Call relations**: This test uses `spawn_v2_subagent`, `mark_thread_interrupted`, and `mark_thread_completed` to shape thread state before invoking the production reload path. It extends the eviction scenario by asserting the follow-on behavior of `ensure_v2_agent_loaded`.

*Call graph*: calls 7 internal fn (mark_thread_completed, mark_thread_interrupted, spawn_v2_subagent, test_config, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 5 external calls (new, assert!, assert_eq!, panic!, tempdir).


##### `spawn_v2_subagent`  (lines 129–151)

```
async fn spawn_v2_subagent(
    control: &AgentControl,
    state: &Arc<ThreadManagerState>,
    config: Config,
    parent_thread_id: ThreadId,
    label: &str,
) -> crate::thread_manager::NewThread
```

**Purpose**: Creates a V2 subagent thread under a specified parent using the thread manager state directly. It is a reusable fixture helper for the residency tests.

**Data flow**: Accepts `&AgentControl`, `&Arc<ThreadManagerState>`, a `Config`, `parent_thread_id`, and a label string. It calls `state.spawn_new_thread_with_source` with `control.clone()`, `SessionSource::SubAgent(SubAgentSource::Other(label.to_string()))`, the parent thread ID, `Some(ThreadSource::Subagent)`, and no inherited environments or exec policy. It returns the resulting `crate::thread_manager::NewThread` or panics if spawning fails.

**Call relations**: Both residency tests call this helper to create resident candidates. It delegates actual thread creation to `ThreadManagerState::spawn_new_thread_with_source`.

*Call graph*: called by 2 (interrupted_v2_agent_is_lost_after_residency_eviction, residency_slot_reservation_unloads_oldest_idle_v2_agent); 3 external calls (SubAgent, clone, Other).


##### `mark_thread_completed`  (lines 153–170)

```
async fn mark_thread_completed(thread: &CodexThread)
```

**Purpose**: Synthesizes a terminal completed state for a test thread without running the normal task machinery. It also clears the active turn so residency eviction sees the thread as idle.

**Data flow**: Takes `&CodexThread`, creates a default turn with `new_default_turn().await`, sends `EventMsg::TurnComplete(TurnCompleteEvent { ... })` into the session, then awaits `clear_active_turn(thread)`. It returns no value and mutates the thread’s session history and active-turn state.

**Call relations**: This helper is used by both residency tests to make a resident unloadable after commit. It delegates final cleanup of the active-turn lock to `clear_active_turn`.

*Call graph*: calls 1 internal fn (clear_active_turn); called by 2 (interrupted_v2_agent_is_lost_after_residency_eviction, residency_slot_reservation_unloads_oldest_idle_v2_agent); 1 external calls (TurnComplete).


##### `mark_thread_interrupted`  (lines 172–188)

```
async fn mark_thread_interrupted(thread: &CodexThread)
```

**Purpose**: Synthesizes an interrupted terminal state for a test thread and clears its active turn. This lets the residency logic treat the thread as an idle interrupted resident.

**Data flow**: Takes `&CodexThread`, creates a default turn, sends `EventMsg::TurnAborted(TurnAbortedEvent { reason: TurnAbortReason::Interrupted, ... })`, then calls `clear_active_turn(thread).await`. It returns no value and mutates the thread session state.

**Call relations**: This helper is used by `interrupted_v2_agent_is_lost_after_residency_eviction` to prepare an interrupted resident for eviction. It delegates active-turn cleanup to `clear_active_turn`.

*Call graph*: calls 1 internal fn (clear_active_turn); called by 1 (interrupted_v2_agent_is_lost_after_residency_eviction); 1 external calls (TurnAborted).


##### `clear_active_turn`  (lines 190–193)

```
async fn clear_active_turn(thread: &CodexThread)
```

**Purpose**: Manually clears a thread’s `active_turn` lock in tests that do not have a task runner to do it automatically. This is necessary for residency eviction predicates to consider the thread idle.

**Data flow**: Accepts `&CodexThread`, acquires `thread.codex.session.active_turn.lock().await`, and writes `None` into the guarded option. It returns no value.

**Call relations**: This helper is called by `mark_thread_completed` and `mark_thread_interrupted` after they inject terminal events.

*Call graph*: called by 2 (mark_thread_completed, mark_thread_interrupted).


### `core/src/agent/registry_tests.rs`

`test` · `test-time validation of agent spawn bookkeeping and naming rules`

This test module validates the behavior of the agent registry subsystem from the outside, using small helpers to construct valid `AgentPath` values and minimal `AgentMetadata` records keyed by `ThreadId`. The tests cover three distinct areas. First, they pin down pure helper behavior: nickname formatting adds ordinal suffixes only after the nickname pool resets, root sessions report depth 0, thread-spawn subagents increment depth, and only thread-spawn sources participate in depth-limit enforcement. Second, they verify reservation accounting in `AgentRegistry`: dropping an uncommitted reservation frees the spawn slot, committing a reservation keeps the slot occupied until `release_spawned_thread`, releasing an unknown thread does nothing, and releasing the same registered thread twice is harmless. Third, they check identity tracking: nickname reservations remain globally “used” even if spawn fails, released nicknames are not immediately reusable until the candidate pool is exhausted and reset, repeated resets advance the ordinal counter, root threads are indexed at `/root`, reserved agent paths are freed on failed spawn, and committed paths remain queryable until thread release. Several tests inspect the registry’s internal `active_agents` mutex-protected state to confirm hidden invariants such as `nickname_reset_count`.

#### Function details

##### `agent_path`  (lines 6–8)

```
fn agent_path(path: &str) -> AgentPath
```

**Purpose**: Builds a valid `AgentPath` from a string literal for use in path-indexing tests. It turns malformed test input into an immediate panic so the tests only exercise registry behavior, not path parsing failures.

**Data flow**: Takes `&str` path text, passes it to `AgentPath::try_from`, and unwraps the `Result` with `expect("valid agent path")`. Returns the parsed `AgentPath` and writes no external state.

**Call relations**: This helper is used by the path-reservation tests when they need concrete `/root/...` paths. Those tests rely on it to supply canonical `AgentPath` values before invoking registry reservation and lookup APIs.

*Call graph*: calls 1 internal fn (try_from); called by 2 (committed_agent_path_is_indexed_until_release, reserved_agent_path_is_released_when_spawn_fails).


##### `agent_metadata`  (lines 10–15)

```
fn agent_metadata(thread_id: ThreadId) -> AgentMetadata
```

**Purpose**: Creates a minimal `AgentMetadata` fixture whose only meaningful field is `agent_id`. It keeps the tests focused on slot ownership rather than unrelated metadata fields.

**Data flow**: Accepts a `ThreadId`, constructs `AgentMetadata { agent_id: Some(thread_id), ..Default::default() }`, and returns it. It reads only the provided thread id and the type’s default values.

**Call relations**: Commit-oriented tests call this helper immediately before `reservation.commit(...)` so they can register a spawned thread without manually filling every metadata field.

*Call graph*: called by 6 (agent_nickname_resets_used_pool_when_exhausted, commit_holds_slot_until_release, release_ignores_unknown_thread_id, release_is_idempotent_for_registered_threads, released_nickname_stays_used_until_pool_reset, repeated_resets_advance_the_ordinal_suffix); 1 external calls (default).


##### `format_agent_nickname_adds_ordinals_after_reset`  (lines 18–39)

```
fn format_agent_nickname_adds_ordinals_after_reset()
```

**Purpose**: Verifies that nickname display formatting leaves the original name unchanged on first use and appends the correct ordinal suffix after each pool reset. It specifically checks common suffix edge cases like `2nd`, `3rd`, `11th`, and `21st`.

**Data flow**: Calls `format_agent_nickname` with the same base nickname and several reset counts, then compares each returned string against the expected formatted nickname using assertions. It does not mutate shared state.

**Call relations**: This is a standalone unit test for the nickname-formatting helper and is not part of a larger registry flow.

*Call graph*: 1 external calls (assert_eq!).


##### `session_depth_defaults_to_zero_for_root_sources`  (lines 42–44)

```
fn session_depth_defaults_to_zero_for_root_sources()
```

**Purpose**: Confirms that a root `SessionSource::Cli` session has depth 0. This establishes the baseline used by subagent depth calculations.

**Data flow**: Constructs a `SessionSource::Cli`, passes it to `session_depth`, and asserts that the returned integer is `0`. No state is written.

**Call relations**: This test isolates the root-session branch of the depth helper, complementing later tests that cover subagent variants.

*Call graph*: 1 external calls (assert_eq!).


##### `thread_spawn_depth_increments_and_enforces_limit`  (lines 47–61)

```
fn thread_spawn_depth_increments_and_enforces_limit()
```

**Purpose**: Checks that a thread-spawned subagent reports its stored depth, increments correctly for a child spawn, and trips the configured maximum-depth guard when appropriate.

**Data flow**: Builds `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { ... depth: 1 ... })`, computes `next_thread_spawn_depth`, asserts it becomes `2`, then feeds that depth into `exceeds_thread_spawn_depth_limit` with `max_depth = 1` and asserts the limit is exceeded.

**Call relations**: This test exercises the thread-spawn-specific control path in the depth helpers, covering the branch where nested thread spawning is tracked explicitly.

*Call graph*: calls 1 internal fn (new); 3 external calls (SubAgent, assert!, assert_eq!).


##### `non_thread_spawn_subagents_default_to_depth_zero`  (lines 64–71)

```
fn non_thread_spawn_subagents_default_to_depth_zero()
```

**Purpose**: Verifies that non-thread-spawn subagent sources do not inherit a stored depth and instead behave like depth 0 sessions whose next spawned child starts at depth 1.

**Data flow**: Creates `SessionSource::SubAgent(SubAgentSource::Review)`, checks `session_depth` returns `0`, checks `next_thread_spawn_depth` returns `1`, and confirms that depth `1` does not exceed a max depth of `1`.

**Call relations**: This complements the thread-spawn test by covering the fallback branch for other subagent origins.

*Call graph*: 3 external calls (SubAgent, assert!, assert_eq!).


##### `reservation_drop_releases_slot`  (lines 74–81)

```
fn reservation_drop_releases_slot()
```

**Purpose**: Proves that an uncommitted spawn reservation is purely provisional: dropping it returns the slot to the registry immediately. This prevents failed spawns from leaking capacity.

**Data flow**: Creates an `Arc<AgentRegistry>` from `Default`, reserves a slot with `max_threads = Some(1)`, drops the reservation without committing, then reserves again and expects success. The observable effect is that no persistent occupancy remains after the first drop.

**Call relations**: This test drives the reservation RAII path directly, validating the cleanup behavior that should occur when callers abandon a spawn before registration.

*Call graph*: 2 external calls (new, default).


##### `commit_holds_slot_until_release`  (lines 84–104)

```
fn commit_holds_slot_until_release()
```

**Purpose**: Checks that once a reservation is committed to a real thread, the slot remains occupied until that exact thread id is released. It also verifies the specific `CodexErr::AgentLimitReached` payload.

**Data flow**: Creates a registry, reserves one slot, generates a `ThreadId`, commits metadata for that id, then attempts another reservation and expects an error. After matching `CodexErr::AgentLimitReached { max_threads }` and asserting `max_threads == 1`, it calls `release_spawned_thread(thread_id)` and confirms a new reservation succeeds.

**Call relations**: This test follows the normal successful spawn lifecycle: reserve → commit → enforce limit → release → reuse. It depends on `agent_metadata` to create the committed record.

*Call graph*: calls 2 internal fn (agent_metadata, new); 4 external calls (new, assert_eq!, default, panic!).


##### `release_ignores_unknown_thread_id`  (lines 107–129)

```
fn release_ignores_unknown_thread_id()
```

**Purpose**: Ensures that releasing a thread id the registry never registered does not accidentally free capacity. Only the committed thread should release the occupied slot.

**Data flow**: Reserves and commits one thread, calls `release_spawned_thread` with a different fresh `ThreadId`, then attempts another reservation and expects the same limit error as before. After releasing the real committed id, it verifies the slot becomes available.

**Call relations**: This test covers the defensive branch in thread release logic where the lookup misses. It mirrors the successful flow from `commit_holds_slot_until_release` but inserts an irrelevant release call first.

*Call graph*: calls 2 internal fn (agent_metadata, new); 4 external calls (new, assert_eq!, default, panic!).


##### `release_is_idempotent_for_registered_threads`  (lines 132–160)

```
fn release_is_idempotent_for_registered_threads()
```

**Purpose**: Verifies that releasing a previously registered thread twice does not corrupt accounting or free a later occupant that reused the slot. The registry must forget the old id after the first release.

**Data flow**: Commits `first_id`, releases it, reserves and commits `second_id`, then calls `release_spawned_thread(first_id)` again. A subsequent reservation still fails with `AgentLimitReached`, proving the second release did not free `second_id`’s slot. Finally it releases `second_id` and confirms reuse succeeds.

**Call relations**: This test extends the release path to a stale-id scenario after slot reuse, ensuring release bookkeeping is keyed to currently registered threads only.

*Call graph*: calls 2 internal fn (agent_metadata, new); 4 external calls (new, assert_eq!, default, panic!).


##### `failed_spawn_keeps_nickname_marked_used`  (lines 163–181)

```
fn failed_spawn_keeps_nickname_marked_used()
```

**Purpose**: Shows that nickname reservation is sticky even if the spawn never commits. A dropped reservation should free capacity and path reservations, but not make the nickname immediately reusable.

**Data flow**: Reserves a slot, reserves nickname `alpha`, drops the reservation, then reserves a new slot and asks for a nickname from `["alpha", "beta"]`. The second reservation returns `beta`, demonstrating `alpha` remained in the used-name pool.

**Call relations**: This test targets the nickname allocator’s persistence semantics on failed spawn, contrasting with slot/path cleanup tests where dropped reservations do release resources.

*Call graph*: 3 external calls (new, assert_eq!, default).


##### `agent_nickname_resets_used_pool_when_exhausted`  (lines 184–208)

```
fn agent_nickname_resets_used_pool_when_exhausted()
```

**Purpose**: Confirms that when all nickname candidates are exhausted, the registry resets the used-name pool and reuses names with ordinalized display strings. It also checks the internal reset counter increments.

**Data flow**: Commits a first agent named `alpha`, then reserves a second slot with only `alpha` available. The second nickname reservation returns `alpha the 2nd`. The test then locks `registry.active_agents` and asserts `nickname_reset_count == 1`.

**Call relations**: This test drives the exhaustion branch of nickname allocation after at least one committed use. It uses `agent_metadata` for the first commit and inspects internal state to verify the hidden reset mechanism.

*Call graph*: calls 2 internal fn (agent_metadata, new); 3 external calls (new, assert_eq!, default).


##### `released_nickname_stays_used_until_pool_reset`  (lines 211–250)

```
fn released_nickname_stays_used_until_pool_reset()
```

**Purpose**: Verifies that releasing a thread does not immediately return its nickname to the available pool; reuse only happens after all candidates are exhausted and the pool resets. The exact reused name after reset may depend on candidate ordering, so the test accepts either ordinalized option.

**Data flow**: Commits and releases `alpha`, then reserves again from `["alpha", "beta"]` and gets `beta` because `alpha` is still marked used. After committing and releasing `beta`, a third reservation from the same candidate set returns either `alpha the 2nd` or `beta the 2nd`. The test then inspects `nickname_reset_count` and expects `1`.

**Call relations**: This test combines release behavior with nickname-pool exhaustion, showing that thread lifecycle and nickname lifecycle are intentionally decoupled.

*Call graph*: calls 2 internal fn (agent_metadata, new); 5 external calls (new, from, assert!, assert_eq!, default).


##### `repeated_resets_advance_the_ordinal_suffix`  (lines 253–290)

```
fn repeated_resets_advance_the_ordinal_suffix()
```

**Purpose**: Checks that each full nickname-pool reset increments the ordinal suffix monotonically across repeated reuse of the same base nickname. The suffix is tied to reset count, not active-thread count.

**Data flow**: Commits and releases `Plato`, then repeats the cycle twice more with only `Plato` as a candidate. The observed names are `Plato`, `Plato the 2nd`, and `Plato the 3rd`; afterward the test locks `active_agents` and asserts `nickname_reset_count == 2`.

**Call relations**: This is the multi-cycle version of the pool-reset test, validating cumulative state across several reserve/commit/release rounds.

*Call graph*: calls 2 internal fn (agent_metadata, new); 3 external calls (new, assert_eq!, default).


##### `register_root_thread_indexes_root_path`  (lines 293–303)

```
fn register_root_thread_indexes_root_path()
```

**Purpose**: Ensures that explicitly registering a root thread populates the path index for the canonical root agent path. This gives path-based lookup a stable entry for the top-level agent.

**Data flow**: Creates a registry and a fresh `ThreadId`, calls `register_root_thread(root_thread_id)`, then queries `agent_id_for_path(&AgentPath::root())` and asserts it returns `Some(root_thread_id)`.

**Call relations**: This test covers the special-case registration path for the root agent rather than spawned subagents.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, default).


##### `reserved_agent_path_is_released_when_spawn_fails`  (lines 306–322)

```
fn reserved_agent_path_is_released_when_spawn_fails()
```

**Purpose**: Verifies that path reservations behave like slot reservations: if a spawn is abandoned before commit, the reserved agent path becomes available again. This prevents failed spawns from permanently blocking a path.

**Data flow**: Reserves a first slot, reserves `/root/researcher` as its agent path, drops the reservation, then reserves a second slot and successfully reserves the same path again.

**Call relations**: This test exercises the RAII cleanup path for reserved agent paths, using `agent_path` to construct the concrete path value.

*Call graph*: calls 1 internal fn (agent_path); 2 external calls (new, default).


##### `committed_agent_path_is_indexed_until_release`  (lines 325–350)

```
fn committed_agent_path_is_indexed_until_release()
```

**Purpose**: Checks that once a reservation with an agent path is committed, the registry indexes that path to the thread id and removes the mapping only when the thread is released.

**Data flow**: Reserves a slot, reserves `/root/researcher`, commits `AgentMetadata` containing both `agent_id` and `agent_path`, then queries `agent_id_for_path` and expects `Some(thread_id)`. After `release_spawned_thread(thread_id)`, the same lookup returns `None`.

**Call relations**: This test follows the successful path-index lifecycle from reservation through commit to release, complementing the failed-spawn cleanup test.

*Call graph*: calls 2 internal fn (agent_path, new); 4 external calls (new, default, assert_eq!, default).


### `core/src/agent/role_tests.rs`

`test` · `test-time validation of role config loading, merging, and tool-spec formatting`

This async-heavy test module builds temporary `Config` instances and role files to exercise `agent::role` end to end. The helper `test_config_with_cli_overrides` constructs a baseline config rooted in a temp codex home, while `write_role_config` writes TOML snippets into that temp tree and `session_flags_layer_count` inspects the resulting `ConfigLayerStack`. The tests verify that applying no role defaults to `default` and leaves config unchanged, unknown roles produce a precise error, missing or invalid user role files collapse to the stable unavailable message, and metadata-only fields in role files are ignored while actual config keys like `model`, `model_reasoning_effort`, and `service_tier` take effect.

A major focus is precedence and stickiness: role layers are inserted as `SessionFlags`, can override existing session-flag values for the same key, but preserve current provider/service-tier choices when the role does not explicitly set them. There is also a regression test ensuring role-layer sandbox TOML does not materialize omitted default subfields. Another integration test proves role-based skill config can disable a discovered skill after plugin and skill resolution. The final block tests `spawn_tool_spec::build`: user-defined roles shadow built-ins of the same name, user roles appear first, and descriptions are annotated when role TOML locks model, reasoning effort, or service tier. A small built-in-content test confirms unknown built-in filenames resolve to `None`.

#### Function details

##### `test_config_with_cli_overrides`  (lines 16–29)

```
async fn test_config_with_cli_overrides(
    cli_overrides: Vec<(String, TomlValue)>,
) -> (TempDir, Config)
```

**Purpose**: Creates a temporary `Config` configured with optional CLI override TOML entries for role-application tests. It standardizes test setup around a temp codex home and fallback cwd.

**Data flow**: Accepts `Vec<(String, TomlValue)>`, creates a `TempDir`, derives its path, builds a `Config` with `ConfigBuilder::default()` using that path for `codex_home` and `fallback_cwd`, applies the provided CLI overrides, awaits `build()`, and returns `(TempDir, Config)`.

**Call relations**: Most async tests call this first to obtain an isolated config before mutating `config.agent_roles` or invoking `apply_role_to_config`.

*Call graph*: called by 13 (apply_empty_explorer_role_preserves_current_model_and_reasoning_effort, apply_explorer_role_sets_model_and_adds_session_flags_layer, apply_role_defaults_to_default_and_leaves_config_unchanged, apply_role_does_not_materialize_default_sandbox_workspace_write_fields, apply_role_ignores_agent_metadata_fields_in_user_role_file, apply_role_preserves_existing_service_tier_without_override, apply_role_preserves_unspecified_keys, apply_role_reports_explicit_service_tier, apply_role_returns_error_for_unknown_role, apply_role_returns_unavailable_for_invalid_user_role_toml (+3 more)); 2 external calls (new, default).


##### `write_role_config`  (lines 31–37)

```
async fn write_role_config(home: &TempDir, name: &str, contents: &str) -> PathBuf
```

**Purpose**: Writes a role TOML file into a temporary home directory and returns its path. It keeps file-backed role tests concise.

**Data flow**: Takes `&TempDir`, a filename, and TOML contents, joins the filename onto `home.path()`, asynchronously writes the contents with `tokio::fs::write`, and returns the resulting `PathBuf`.

**Call relations**: Tests that exercise user-defined role files call this helper before inserting the returned path into `config.agent_roles`.

*Call graph*: called by 8 (apply_role_does_not_materialize_default_sandbox_workspace_write_fields, apply_role_ignores_agent_metadata_fields_in_user_role_file, apply_role_preserves_existing_service_tier_without_override, apply_role_preserves_unspecified_keys, apply_role_reports_explicit_service_tier, apply_role_returns_unavailable_for_invalid_user_role_toml, apply_role_skills_config_disables_skill_for_spawned_agent, apply_role_takes_precedence_over_existing_session_flags_for_same_key); 2 external calls (path, write).


##### `session_flags_layer_count`  (lines 39–49)

```
fn session_flags_layer_count(config: &Config) -> usize
```

**Purpose**: Counts how many `SessionFlags` layers are present in a config’s layer stack. It is used to verify whether applying a role inserted a new layer.

**Data flow**: Reads `config.config_layer_stack`, gets layers in lowest-precedence-first order including disabled ones, filters for `layer.name == ConfigLayerSource::SessionFlags`, counts them, and returns the `usize` count.

**Call relations**: Layer-precedence tests call this before and after `apply_role_to_config` to detect whether a role added a new session-flags layer.

*Call graph*: called by 3 (apply_empty_explorer_role_preserves_current_model_and_reasoning_effort, apply_explorer_role_sets_model_and_adds_session_flags_layer, apply_role_takes_precedence_over_existing_session_flags_for_same_key).


##### `apply_role_defaults_to_default_and_leaves_config_unchanged`  (lines 52–61)

```
async fn apply_role_defaults_to_default_and_leaves_config_unchanged()
```

**Purpose**: Checks that omitting the role name applies the built-in default role and leaves the config unchanged because that role has no config file.

**Data flow**: Builds a baseline config, clones it into `before`, applies `apply_role_to_config(&mut config, None)`, and asserts `before == config`.

**Call relations**: This test exercises the default-role branch of `apply_role_to_config` using the shared config-construction helper.

*Call graph*: calls 1 internal fn (test_config_with_cli_overrides); 2 external calls (new, assert_eq!).


##### `apply_role_returns_error_for_unknown_role`  (lines 64–72)

```
async fn apply_role_returns_error_for_unknown_role()
```

**Purpose**: Verifies that requesting a nonexistent role returns the exact unknown-agent-type error string.

**Data flow**: Creates a baseline config, calls `apply_role_to_config(&mut config, Some("missing-role"))`, expects an error, and compares the returned string to `"unknown agent_type 'missing-role'"`.

**Call relations**: This test covers the early failure path where `resolve_role_config` returns `None`.

*Call graph*: calls 1 internal fn (test_config_with_cli_overrides); 2 external calls (new, assert_eq!).


##### `apply_explorer_role_sets_model_and_adds_session_flags_layer`  (lines 76–87)

```
async fn apply_explorer_role_sets_model_and_adds_session_flags_layer()
```

**Purpose**: Checks the intended behavior of the built-in `explorer` role when it carries a config file: it should set model-related fields and add one session-flags layer. The test is currently ignored because no active role requires it.

**Data flow**: Builds a config, records the initial session-flags count, applies the `explorer` role, then asserts `config.model`, `config.model_reasoning_effort`, and the incremented layer count.

**Call relations**: This ignored test documents the expected built-in-role layering behavior when a built-in role file is non-empty.

*Call graph*: calls 2 internal fn (session_flags_layer_count, test_config_with_cli_overrides); 2 external calls (new, assert_eq!).


##### `apply_empty_explorer_role_preserves_current_model_and_reasoning_effort`  (lines 90–103)

```
async fn apply_empty_explorer_role_preserves_current_model_and_reasoning_effort()
```

**Purpose**: Verifies that an effectively empty explorer role does not overwrite already selected model and reasoning effort and does not add a new session-flags layer.

**Data flow**: Builds a config, records the current session-flags count, manually sets `config.model` and `config.model_reasoning_effort`, applies `explorer`, and asserts those fields and the layer count remain unchanged.

**Call relations**: This test covers the short-circuit path where the loaded role TOML is empty and `apply_role_to_config_inner` returns without rebuilding config.

*Call graph*: calls 2 internal fn (session_flags_layer_count, test_config_with_cli_overrides); 2 external calls (new, assert_eq!).


##### `apply_role_returns_unavailable_for_missing_user_role_file`  (lines 106–122)

```
async fn apply_role_returns_unavailable_for_missing_user_role_file()
```

**Purpose**: Ensures that a user-defined role pointing at a nonexistent file does not leak filesystem details and instead returns the stable unavailable message.

**Data flow**: Builds a config, inserts a `custom` `AgentRoleConfig` with `config_file` set to a nonexistent absolute path, applies the role, expects an error, and asserts it equals `AGENT_TYPE_UNAVAILABLE_ERROR`.

**Call relations**: This test drives the user-role file-loading failure path inside `load_role_layer_toml` and the outer error mapping in `apply_role_to_config`.

*Call graph*: calls 1 internal fn (test_config_with_cli_overrides); 3 external calls (from, new, assert_eq!).


##### `apply_role_returns_unavailable_for_invalid_user_role_toml`  (lines 125–142)

```
async fn apply_role_returns_unavailable_for_invalid_user_role_toml()
```

**Purpose**: Checks that malformed TOML in a user role file is surfaced as the same generic unavailable message rather than a parser-specific error.

**Data flow**: Creates a temp config and writes `model = [` to a role file, inserts that file into `config.agent_roles`, applies the role, expects failure, and compares the error string to `AGENT_TYPE_UNAVAILABLE_ERROR`.

**Call relations**: This test covers the parse-failure branch of `load_role_layer_toml` for user-defined roles.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 2 external calls (new, assert_eq!).


##### `apply_role_ignores_agent_metadata_fields_in_user_role_file`  (lines 145–173)

```
async fn apply_role_ignores_agent_metadata_fields_in_user_role_file()
```

**Purpose**: Verifies that role-file metadata fields such as `name`, `description`, and `nickname_candidates` do not interfere with config application, while actual config keys still apply.

**Data flow**: Writes a role file containing metadata fields plus `developer_instructions` and `model = "role-model"`, inserts it as `custom`, applies the role, and asserts `config.model` becomes `Some("role-model")`.

**Call relations**: This test exercises the user-role parsing path through `parse_agent_role_file_contents`, confirming metadata stripping before config merge.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 2 external calls (new, assert_eq!).


##### `apply_role_preserves_unspecified_keys`  (lines 176–213)

```
async fn apply_role_preserves_unspecified_keys()
```

**Purpose**: Checks that applying a role only changes keys it explicitly sets and preserves unrelated existing config values and executable-path overrides.

**Data flow**: Builds a config with CLI override `model = "base-model"`, manually sets sandbox-wrapper executable paths, writes a role file that only sets `developer_instructions` and `model_reasoning_effort = "high"`, applies it, and asserts the original model and executable paths remain while reasoning effort updates to `High`.

**Call relations**: This test validates the reload path’s merge semantics and the sticky override behavior encoded in `reload::reload_overrides`.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 3 external calls (from, assert_eq!, vec!).


##### `apply_role_reports_explicit_service_tier`  (lines 216–243)

```
async fn apply_role_reports_explicit_service_tier()
```

**Purpose**: Verifies that when a role explicitly sets `service_tier`, the resulting config reflects that tier after role application.

**Data flow**: Writes a role file with `service_tier = "priority"`, inserts it as `custom`, applies the role, and asserts `config.service_tier` equals the request value for `ServiceTier::Fast`.

**Call relations**: This test covers the branch where `preserve_current_service_tier` is false because the role layer explicitly sets the key.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 2 external calls (new, assert_eq!).


##### `apply_role_preserves_existing_service_tier_without_override`  (lines 246–273)

```
async fn apply_role_preserves_existing_service_tier_without_override()
```

**Purpose**: Ensures that an already selected service tier survives role application when the role file does not specify `service_tier`.

**Data flow**: Builds a config, sets `config.service_tier` to the fast-tier request value, writes a role file without a `service_tier` key, applies it, and asserts the original tier remains unchanged.

**Call relations**: This test specifically validates the sticky-service-tier branch in `apply_role_to_config_inner` and `reload::reload_overrides`.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 2 external calls (new, assert_eq!).


##### `apply_role_does_not_materialize_default_sandbox_workspace_write_fields`  (lines 277–346)

```
async fn apply_role_does_not_materialize_default_sandbox_workspace_write_fields()
```

**Purpose**: Checks that a role layer adding only selected `sandbox_workspace_write` fields does not inject omitted default subfields into the role layer TOML, while the effective sandbox policy still preserves inherited values like `network_access`.

**Data flow**: Builds a config with CLI sandbox overrides, writes a role file containing only `sandbox_workspace_write.writable_roots`, applies the role, inspects the last `SessionFlags` layer’s raw TOML table to assert absent keys remain absent, then matches `config.legacy_sandbox_policy()` and asserts inherited `network_access` is still `true`.

**Call relations**: This regression test exercises both raw layer inspection and effective-config behavior after role reload.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 3 external calls (assert_eq!, panic!, vec!).


##### `apply_role_takes_precedence_over_existing_session_flags_for_same_key`  (lines 349–377)

```
async fn apply_role_takes_precedence_over_existing_session_flags_for_same_key()
```

**Purpose**: Verifies that a role layer inserted as `SessionFlags` can override an existing session-flags value for the same key, rather than being ignored behind earlier CLI overrides.

**Data flow**: Builds a config with CLI override `model = "cli-model"`, records the initial session-flags count, writes a role file setting `model = "role-model"`, applies it, and asserts the effective model is `role-model` and the session-flags count increased by one.

**Call relations**: This test validates the ordering logic in `reload::insert_layer` and the decision to represent role layers as `ConfigLayerSource::SessionFlags`.

*Call graph*: calls 3 internal fn (session_flags_layer_count, test_config_with_cli_overrides, write_role_config); 2 external calls (assert_eq!, vec!).


##### `apply_role_skills_config_disables_skill_for_spawned_agent`  (lines 381–438)

```
async fn apply_role_skills_config_disables_skill_for_spawned_agent()
```

**Purpose**: Performs an end-to-end integration check that a role’s `[[skills.config]] enabled = false` entry disables a discovered skill for the spawned agent’s effective config.

**Data flow**: Creates a temp skill directory and `SKILL.md`, writes a role file disabling that skill path, inserts the role, applies it, then constructs `PluginsManager` and `SkillsManager`, derives plugin and skill inputs from the resulting config, loads skills, finds the `demo-skill`, and asserts `outcome.is_skill_enabled(skill) == false`.

**Call relations**: This is the broadest integration test in the file: after `apply_role_to_config`, it drives plugin and skill resolution to prove the role layer affects downstream subsystems.

*Call graph*: calls 4 internal fn (new, new, test_config_with_cli_overrides, write_role_config); 8 external calls (clone, new, new, assert_eq!, skills_load_input_from_config, format!, create_dir_all, write).


##### `spawn_tool_spec_build_deduplicates_user_defined_built_in_roles`  (lines 441–460)

```
fn spawn_tool_spec_build_deduplicates_user_defined_built_in_roles()
```

**Purpose**: Checks that a user-defined role with the same name as a built-in shadows the built-in entry in the generated tool spec, while other roles still appear.

**Data flow**: Builds a `BTreeMap` containing a user-defined `explorer` and a default `researcher`, calls `spawn_tool_spec::build`, and asserts the output contains the user override and built-in `default` entry but not the built-in explorer description text.

**Call relations**: This test targets the deduplication logic in `spawn_tool_spec::build_from_configs`.

*Call graph*: 4 external calls (from, assert!, default, build).


##### `spawn_tool_spec_lists_user_defined_roles_before_built_ins`  (lines 463–480)

```
fn spawn_tool_spec_lists_user_defined_roles_before_built_ins()
```

**Purpose**: Verifies that user-defined roles are listed before built-in roles in the generated spawn-tool description.

**Data flow**: Creates a single user-defined role `aaa`, builds the spec string, finds the index of the user role block and the built-in `default` block, and asserts the user role appears earlier.

**Call relations**: This test covers the ordering guarantee implemented by iterating user roles before built-ins in `build_from_configs`.

*Call graph*: 3 external calls (from, assert!, build).


##### `spawn_tool_spec_marks_role_locked_model_and_reasoning_effort`  (lines 483–505)

```
fn spawn_tool_spec_marks_role_locked_model_and_reasoning_effort()
```

**Purpose**: Checks that the tool spec annotates a role whose config file locks both `model` and `model_reasoning_effort` with the combined explanatory note.

**Data flow**: Writes a role TOML file containing both keys, builds a user-defined role map pointing at that file, generates the spec, and asserts the expected explanatory sentence is present.

**Call relations**: This test exercises the TOML-inspection branch in `spawn_tool_spec::format_role` for the `(Some(model), Some(reasoning_effort))` case.

*Call graph*: 5 external calls (from, new, assert!, write, build).


##### `spawn_tool_spec_marks_role_locked_reasoning_effort_only`  (lines 508–530)

```
fn spawn_tool_spec_marks_role_locked_reasoning_effort_only()
```

**Purpose**: Verifies that the tool spec emits the reasoning-effort-only note when a role config locks `model_reasoning_effort` but not `model`.

**Data flow**: Writes a role file with only `model_reasoning_effort = "medium"`, builds the spec, and asserts the output contains the corresponding single-setting note.

**Call relations**: This covers the `(None, Some(reasoning_effort))` formatting branch in `spawn_tool_spec::format_role`.

*Call graph*: 5 external calls (from, new, assert!, write, build).


##### `spawn_tool_spec_marks_role_locked_service_tier`  (lines 533–555)

```
fn spawn_tool_spec_marks_role_locked_service_tier()
```

**Purpose**: Checks that the tool spec explains when a role config fixes `service_tier` and that this tier can override a valid spawn request tier if supported by the resolved model.

**Data flow**: Writes a role file with `service_tier = "priority"`, builds the spec for a user-defined `tiered` role, and asserts the generated note about service-tier precedence is present.

**Call relations**: This test exercises the service-tier annotation branch in `spawn_tool_spec::format_role`.

*Call graph*: 5 external calls (from, new, assert!, write, build).


##### `built_in_config_file_contents_resolves_explorer_only`  (lines 558–563)

```
fn built_in_config_file_contents_resolves_explorer_only()
```

**Purpose**: Confirms that unknown built-in config filenames are not resolved to embedded contents. It guards the negative case of the built-in file lookup table.

**Data flow**: Calls `built_in::config_file_contents(Path::new("missing.toml"))` and asserts the result is `None`.

**Call relations**: This is a small direct test of the built-in embedded-file resolver used by role loading and tool-spec formatting.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/codex_delegate_tests.rs`

`test` · `test execution`

This test module validates the edge cases of delegated child-session orchestration. Several tests construct synthetic `Codex` facades from bounded async channels and watch channels rather than spawning full child sessions, which makes the forwarding logic directly observable. `forward_events_cancelled_while_send_blocked_shuts_down_delegate` fills the outbound event channel so forwarding blocks, then cancels the delegate and confirms `Interrupt` and `Shutdown` ops were sent to the child. `forward_ops_preserves_submission_trace_context` verifies that `Submission.trace` survives the forwarding path unchanged.

The request/approval tests focus on identifier correctness and guardian integration. `handle_request_permissions_uses_tool_call_id_for_round_trip` confirms that the delegated permission request uses the original tool call id in both the parent-facing event and the child-facing response op. `handle_exec_approval_uses_call_id_for_guardian_review_and_approval_id_for_reply` checks the subtle split between the shell command item id used in guardian assessment events and the callback approval id used in the eventual `Op::ExecApproval` reply.

The final two tests cover the legacy MCP approval compatibility path. One verifies that when guardian review is cancelled, `maybe_auto_review_mcp_request_user_input` returns a synthetic decline answer rather than surfacing the prompt. The other verifies that when metadata is insufficient and reviewer routing does not select guardian, the helper returns `None` so normal user prompting can proceed.

#### Function details

##### `forward_events_cancelled_while_send_blocked_shuts_down_delegate`  (lines 37–112)

```
async fn forward_events_cancelled_while_send_blocked_shuts_down_delegate()
```

**Purpose**: Verifies that `forward_events` shuts down the delegated child when cancellation occurs while forwarding is blocked on a full outbound channel. It checks that both interrupt and shutdown ops are emitted.

**Data flow**: Creates bounded event/output channels and a synthetic `Codex`, pre-fills the outbound channel with a `TurnAborted` event so the next send blocks, spawns `forward_events`, sends a child `RawResponseItem` event into the child event channel, drops the child sender, cancels the token, waits for the task to finish, then drains the child submission channel and asserts it contains both `Op::Interrupt` and `Op::Shutdown`.

**Call relations**: Exercises `forward_events`, `forward_event_or_shutdown`, and `shutdown_delegate` together under blocked-send cancellation conditions.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 15 external calls (clone, new, new, new, new, new, assert!, assert_eq!, bounded, RawResponseItem (+5 more)).


##### `forward_ops_preserves_submission_trace_context`  (lines 115–157)

```
async fn forward_ops_preserves_submission_trace_context()
```

**Purpose**: Checks that `forward_ops` forwards the entire `Submission`, including its W3C trace context, without modification. It validates trace propagation through the delegated op bridge.

**Data flow**: Builds a synthetic `Codex` with a submission receiver, spawns `forward_ops`, sends a `Submission` containing `Op::Interrupt` and a populated `trace`, drops the sender, receives the forwarded submission from the child channel, and asserts id/op/trace all match the original before awaiting task completion.

**Call relations**: Directly exercises `forward_ops` and confirms it uses `submit_with_id` semantics rather than reconstructing submissions.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 9 external calls (clone, new, new, from_secs, assert_eq!, bounded, spawn, timeout, channel).


##### `run_codex_thread_interactive_respects_pre_cancelled_spawn`  (lines 160–183)

```
async fn run_codex_thread_interactive_respects_pre_cancelled_spawn()
```

**Purpose**: Verifies that `run_codex_thread_interactive` exits promptly with `CodexErr::TurnAborted` when given an already-cancelled token. It guards against hangs during delegated spawn cancellation.

**Data flow**: Creates a parent session/context fixture, cancels a fresh token before calling the function, wraps the call in a one-second timeout, and asserts the result is `Err(CodexErr::TurnAborted)`.

**Call relations**: Exercises the cancellation path around `Codex::spawn(...).or_cancel(&cancel_token)` inside `run_codex_thread_interactive`.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 5 external calls (clone, new, from_secs, assert!, timeout).


##### `handle_request_permissions_uses_tool_call_id_for_round_trip`  (lines 186–282)

```
async fn handle_request_permissions_uses_tool_call_id_for_round_trip()
```

**Purpose**: Checks that delegated permission requests preserve the original tool call id through the parent-session request and the child-session response op. It validates correlation-id integrity.

**Data flow**: Creates a parent session/context with an active turn and a modified environment id, builds a synthetic child `Codex`, spawns `handle_request_permissions` with a `RequestPermissionsEvent` carrying `call_id = tool-call-1` and delegated cwd, waits for the parent-facing `EventMsg::RequestPermissions`, asserts its call id/environment/cwd, notifies the parent session with an expected `RequestPermissionsResponse`, waits for the handler to finish, then receives the child submission and asserts it is `Op::RequestPermissionsResponse { id: call_id, response: expected_response }`.

**Call relations**: Directly exercises `handle_request_permissions` and, transitively, `await_request_permissions_with_cancel` in the normal non-cancelled path.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, default); 12 external calls (clone, get_mut, new, new, from_secs, default, assert_eq!, bounded, panic!, spawn (+2 more)).


##### `handle_exec_approval_uses_call_id_for_guardian_review_and_approval_id_for_reply`  (lines 285–395)

```
async fn handle_exec_approval_uses_call_id_for_guardian_review_and_approval_id_for_reply()
```

**Purpose**: Verifies the split identity semantics of delegated exec approvals: guardian assessment events should target the shell command item id, while the reply op should use the callback approval id. It also checks cancellation-driven abort behavior.

**Data flow**: Creates a parent session/context configured for guardian auto-review, builds a synthetic child `Codex`, spawns `handle_exec_approval` with an `ExecApprovalRequestEvent` whose `call_id` and `approval_id` differ, waits for a `GuardianAssessment` event from the parent session and asserts its target item id, turn id, status, and command action fields, cancels the token, waits for the handler to finish, then receives the child submission and asserts it is `Op::ExecApproval { id: approval_id, turn_id: Some(child-turn-1), decision: ReviewDecision::Abort }`.

**Call relations**: Exercises `handle_exec_approval`, guardian review spawning, and `await_approval_with_cancel` under cancellation.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 14 external calls (clone, new, try_unwrap, new, from_secs, new, assert!, assert_eq!, bounded, test_path_buf (+4 more)).


##### `delegated_mcp_guardian_abort_returns_synthetic_decline_answer`  (lines 398–454)

```
async fn delegated_mcp_guardian_abort_returns_synthetic_decline_answer()
```

**Purpose**: Checks that the legacy MCP approval compatibility helper returns a synthetic decline answer when guardian review is selected but cancelled. It ensures delegated MCP approvals fail closed rather than hanging or surfacing raw prompts.

**Data flow**: Creates a parent session/context configured for guardian auto-review, seeds `pending_mcp_invocations` with a matching `McpInvocation`, cancels the token before calling `maybe_auto_review_mcp_request_user_input`, passes a `RequestUserInputEvent` containing an MCP approval question id, awaits the result, and asserts it equals `Some(RequestUserInputResponse)` whose answer is `MCP_TOOL_APPROVAL_DECLINE_SYNTHETIC`.

**Call relations**: Directly exercises `maybe_auto_review_mcp_request_user_input` and its use of `await_approval_with_cancel` when guardian review is aborted.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 7 external calls (new, try_unwrap, new, from, new, assert_eq!, vec!).


##### `delegated_mcp_user_reviewer_returns_none_without_metadata`  (lines 457–492)

```
async fn delegated_mcp_user_reviewer_returns_none_without_metadata()
```

**Purpose**: Verifies that the MCP auto-review helper declines to auto-answer when metadata/reviewer routing does not support guardian review. It preserves the fallback path to ordinary user prompting.

**Data flow**: Creates a parent session/context, seeds `pending_mcp_invocations` with an invocation for the apps MCP server, builds a matching `RequestUserInputEvent`, calls `maybe_auto_review_mcp_request_user_input`, and asserts the result is `None`.

**Call relations**: Exercises the early-return path in `maybe_auto_review_mcp_request_user_input` where metadata/reviewer selection does not route the request to guardian.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 6 external calls (new, new, from, new, assert_eq!, vec!).


### `core/src/thread_manager_tests.rs`

`test` · `test execution`

This test file validates both public `ThreadManager` APIs and the private snapshot helpers in `thread_manager.rs`. It defines compact builders for `ResponseItem::Message` user and assistant messages plus helper constructors for the contextual-user and developer interrupted markers. The tests cover truncation before user-message boundaries, including out-of-range truncation on mid-turn histories and histories with explicit `TurnStarted` events. They verify that startup/session-prefix messages are ignored when counting user turns.

Several async tests construct real managers using either the production constructor or test constructors rooted in temporary directories. Those tests assert that `shutdown_all_threads_bounded` submits shutdown to every tracked thread and removes completed ones; internal-session threads remain hidden from `list_thread_ids` and `get_thread`; extension-scoped initialization data is visible to both lifecycle contributors and MCP contributors on a per-thread basis; resume and fork intentionally recompute environment selections from the current config instead of restoring persisted rollout environments; and an explicit installation id is used directly without writing the codex-home installation-id file.

Resume/fork persistence behavior is checked carefully: resuming an active thread returns the same `Arc`, resuming a stopped thread creates a new runtime with the same thread id, resumed thread source metadata is preserved, and rollout-path resume/fork reads history through the configured thread store. The interrupted-fork tests are especially detailed: they verify marker insertion, disabled-marker behavior, mid-turn detection for legacy and mixed histories, preservation of explicit turn ids, absence of synthesized turn ids for legacy histories, and idempotence when re-forking an already interrupted persisted snapshot.

#### Function details

##### `user_msg`  (lines 37–47)

```
fn user_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a minimal user `ResponseItem::Message` for test rollout histories.

**Data flow**: Takes `text: &str`, converts it into a `ResponseItem::Message` with role `user`, one `ContentItem::OutputText`, and all optional fields unset; returns the constructed `ResponseItem`.

**Call relations**: Used by many truncation and fork-snapshot tests to create concise synthetic histories.

*Call graph*: called by 2 (ignores_session_prefix_messages_when_truncating, truncates_before_requested_user_message); 1 external calls (vec!).


##### `assistant_msg`  (lines 48–58)

```
fn assistant_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a minimal assistant `ResponseItem::Message` for test rollout histories.

**Data flow**: Takes `text: &str`, converts it into a `ResponseItem::Message` with role `assistant`, one `ContentItem::OutputText`, and unset optional fields; returns the item.

**Call relations**: Paired with `user_msg` in synthetic rollout histories across truncation and interruption tests.

*Call graph*: called by 2 (ignores_session_prefix_messages_when_truncating, truncates_before_requested_user_message); 1 external calls (vec!).


##### `contextual_user_interrupted_marker`  (lines 60–63)

```
fn contextual_user_interrupted_marker() -> ResponseItem
```

**Purpose**: Returns the enabled contextual-user interrupted marker expected in interrupted fork snapshots.

**Data flow**: Calls `interrupted_turn_history_marker(InterruptedTurnHistoryMarker::ContextualUser)`, unwraps the `Option`, and returns the resulting `ResponseItem`.

**Call relations**: Used in assertions that compare persisted interrupted-fork histories against expected marker content.

*Call graph*: calls 1 internal fn (interrupted_turn_history_marker); called by 2 (interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history, interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source).


##### `developer_interrupted_marker`  (lines 65–68)

```
fn developer_interrupted_marker() -> ResponseItem
```

**Purpose**: Returns the enabled developer-role interrupted marker used by multi-agent v2 behavior.

**Data flow**: Calls `interrupted_turn_history_marker(InterruptedTurnHistoryMarker::Developer)`, unwraps the `Option`, and returns the marker item.

**Call relations**: Used by the test that verifies developer guidance is encoded as developer input text.

*Call graph*: calls 1 internal fn (interrupted_turn_history_marker); called by 1 (multi_agent_v2_interrupted_marker_uses_developer_input_message).


##### `truncates_before_requested_user_message`  (lines 71–141)

```
fn truncates_before_requested_user_message()
```

**Purpose**: Verifies that truncation cuts strictly before the requested user-message boundary and leaves the rollout unchanged when the requested boundary is beyond the last user turn.

**Data flow**: Builds a mixed rollout of user, assistant, reasoning, and function-call items, wraps them as `RolloutItem::ResponseItem`, calls `truncate_before_nth_user_message` twice with different `n`, and compares serialized JSON forms of the resulting rollout items to expected prefixes/full history.

**Call relations**: Directly exercises the helper used by fork snapshots.

*Call graph*: calls 2 internal fn (assistant_msg, user_msg); 3 external calls (assert_eq!, Forked, vec!).


##### `out_of_range_truncation_drops_only_unfinished_suffix_mid_turn`  (lines 144–166)

```
fn out_of_range_truncation_drops_only_unfinished_suffix_mid_turn()
```

**Purpose**: Checks that out-of-range truncation on a mid-turn history removes only the unfinished suffix rather than keeping the partial turn.

**Data flow**: Creates a short forked history ending with a partial assistant response, passes a `SnapshotTurnState` marked `ends_mid_turn: true` and `usize::MAX` to `truncate_before_nth_user_message`, then asserts the result keeps only the committed prefix before the active turn.

**Call relations**: Targets the special mid-turn fallback branch in truncation logic.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `fork_thread_accepts_legacy_usize_snapshot_argument`  (lines 169–185)

```
fn fork_thread_accepts_legacy_usize_snapshot_argument()
```

**Purpose**: Confirms at compile time that `ThreadManager::fork_thread` still accepts a raw `usize` snapshot argument through `Into<ForkSnapshot>`.

**Data flow**: Defines a local function that calls `manager.fork_thread(usize::MAX, ...)` and assigns it to a function pointer of the expected type; there is no runtime assertion.

**Call relations**: Guards the legacy API surface preserved by `impl From<usize> for ForkSnapshot`.


##### `out_of_range_truncation_drops_pre_user_active_turn_prefix`  (lines 188–223)

```
fn out_of_range_truncation_drops_pre_user_active_turn_prefix()
```

**Purpose**: Verifies that when an explicit active turn started before the latest user message, out-of-range truncation cuts at the active turn’s start index.

**Data flow**: Builds a history containing `TurnStarted`, user, and partial assistant items, computes `snapshot_turn_state`, asserts the detected explicit turn id/start index, then truncates with `usize::MAX` and checks that only the prefix before the active turn remains.

**Call relations**: Exercises the branch that prefers `active_turn_start_index` over the last user position.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `ignores_session_prefix_messages_when_truncating`  (lines 226–262)

```
async fn ignores_session_prefix_messages_when_truncating()
```

**Purpose**: Ensures truncation counts only actual user-turn boundaries and ignores session-initial context messages prepended by session setup.

**Data flow**: Builds a real session initial context via `make_session_and_context`, appends two user turns and assistant replies, wraps them as rollout items, truncates before the second user turn, and asserts the result keeps the startup prefix plus the first user turn only.

**Call relations**: Validates that truncation logic aligns with session-generated startup context.

*Call graph*: calls 3 internal fn (make_session_and_context, assistant_msg, user_msg); 3 external calls (assert_eq!, Forked, vec!).


##### `shutdown_all_threads_bounded_submits_shutdown_to_every_thread`  (lines 265–299)

```
async fn shutdown_all_threads_bounded_submits_shutdown_to_every_thread()
```

**Purpose**: Checks that bounded shutdown concurrently shuts down all tracked threads, reports them as completed, and leaves no visible live threads.

**Data flow**: Creates a temp config and test manager, starts two threads, calls `shutdown_all_threads_bounded(Duration::from_secs(10))`, sorts expected ids, and asserts `completed` matches while `submit_failed` and `timed_out` are empty and `list_thread_ids()` returns empty.

**Call relations**: Exercises the manager-wide shutdown path on ordinary visible threads.

*Call graph*: calls 4 internal fn (test_config, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 7 external calls (new, from_secs, assert!, assert_eq!, create_dir_all, tempdir, vec!).


##### `start_thread_keeps_internal_threads_hidden_from_normal_lookups`  (lines 302–342)

```
async fn start_thread_keeps_internal_threads_hidden_from_normal_lookups()
```

**Purpose**: Verifies that threads started with an internal session source are tracked for shutdown but hidden from normal listing and lookup APIs.

**Data flow**: Starts a thread with `SessionSource::Internal(InternalSessionSource::MemoryConsolidation)`, asserts `list_thread_ids()` is empty and `get_thread()` fails, then shuts down all threads and checks the internal thread still appears in the shutdown report.

**Call relations**: Tests the visibility filter implemented by `list_thread_ids` and `get_thread`.

*Call graph*: calls 4 internal fn (test_config, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 9 external calls (new, default, from_secs, new, Internal, assert!, assert_eq!, create_dir_all, tempdir).


##### `start_thread_seeds_extension_data_for_mcp_and_lifecycle_contributors`  (lines 345–524)

```
async fn start_thread_seeds_extension_data_for_mcp_and_lifecycle_contributors()
```

**Purpose**: Checks that per-thread extension initialization data is available to both lifecycle contributors and MCP contributors and remains isolated per thread.

**Data flow**: Defines a local `InitialDataRecorder` implementing `ThreadLifecycleContributor` and `McpServerContributor`, builds an extension registry containing it, starts two threads with different `ExtensionDataInit` values carrying `SelectedCapabilityRoot`, resolves each thread’s runtime MCP config, and asserts the recorder observed the correct thread-local ids and that each resolved MCP config contains only its own selected server/environment.

**Call relations**: Exercises thread startup integration with extension-scoped data stores and MCP resolution.

*Call graph*: calls 6 internal fn (test_config, new, default_for_tests, new, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 7 external calls (clone, new, new, assert_eq!, create_dir_all, new, tempdir).


##### `resume_and_fork_do_not_restore_thread_environments_from_rollout`  (lines 527–642)

```
async fn resume_and_fork_do_not_restore_thread_environments_from_rollout()
```

**Purpose**: Verifies that resumed and forked threads derive turn environments from the current config/default selection logic rather than restoring persisted rollout environment cwd values.

**Data flow**: Starts a source thread with a non-default selected cwd/environment, flushes and shuts it down, resumes it from rollout, creates a new turn and inspects `turn_environments`, then forks from the same rollout and inspects the forked turn’s environments; both are asserted to use the default cwd from current config, not the persisted selected cwd.

**Call relations**: Covers an intentional design choice in resume/fork startup behavior.

*Call graph*: calls 6 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, try_from); 10 external calls (new, default, new, assert_eq!, assert_ne!, empty_extension_registry, default, create_dir_all, tempdir, vec!).


##### `explicit_installation_id_skips_codex_home_file`  (lines 645–685)

```
async fn explicit_installation_id_skips_codex_home_file()
```

**Purpose**: Ensures that when `ThreadManager::new` is given an explicit installation id, thread startup uses it directly and does not create the codex-home installation-id file.

**Data flow**: Builds a manager with a generated installation id and initialized state db/thread store, starts a thread, asserts the installation-id file does not exist under `codex_home` and that the session’s `installation_id` equals the explicit value, then shuts the thread down.

**Call relations**: Tests constructor behavior around installation-id sourcing.

*Call graph*: calls 5 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 8 external calls (new, assert!, assert_eq!, empty_extension_registry, init_state_db, create_dir_all, tempdir, new_v4).


##### `resume_active_thread_from_rollout_returns_running_thread`  (lines 688–743)

```
async fn resume_active_thread_from_rollout_returns_running_thread()
```

**Purpose**: Checks that resuming from a rollout path while the corresponding thread is still running returns the existing live thread instead of spawning a duplicate runtime.

**Data flow**: Starts a source thread, materializes and flushes its rollout, calls `resume_thread_from_rollout` without shutting the source down, and asserts the returned thread id matches and `Arc::ptr_eq` confirms the same `Arc<CodexThread>`.

**Call relations**: Exercises the duplicate-resume fast path in `spawn_thread_with_source`.

*Call graph*: calls 5 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 6 external calls (new, assert!, assert_eq!, empty_extension_registry, create_dir_all, tempdir).


##### `resume_stopped_thread_from_rollout_spawns_new_thread`  (lines 746–806)

```
async fn resume_stopped_thread_from_rollout_spawns_new_thread()
```

**Purpose**: Checks that resuming from a rollout path after the original runtime has stopped creates a new live thread object with the same thread id.

**Data flow**: Starts, flushes, and shuts down a source thread, then resumes from its rollout path and asserts the resumed thread id matches the original while `Arc::ptr_eq` is false.

**Call relations**: Exercises the branch that removes a stopped thread from the registry and respawns it.

*Call graph*: calls 5 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 6 external calls (new, assert!, assert_eq!, empty_extension_registry, create_dir_all, tempdir).


##### `resume_stopped_thread_from_rollout_preserves_thread_source`  (lines 809–890)

```
async fn resume_stopped_thread_from_rollout_preserves_thread_source()
```

**Purpose**: Verifies that persisted `thread_source` metadata survives shutdown and is restored on resume.

**Data flow**: Starts a thread with `thread_source: Some(ThreadSource::User)`, flushes and shuts it down, removes it from the manager, resumes from rollout, then reads `config_snapshot().await.thread_source` from the resumed thread and asserts it is still `Some(ThreadSource::User)`.

**Call relations**: Tests that resume reconstructs thread metadata from persisted history/store state.

*Call graph*: calls 5 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 8 external calls (new, default, new, assert_eq!, empty_extension_registry, init_state_db, create_dir_all, tempdir).


##### `rollout_path_resume_and_fork_read_history_through_thread_store`  (lines 893–996)

```
async fn rollout_path_resume_and_fork_read_history_through_thread_store()
```

**Purpose**: Ensures rollout-path resume and fork operations load history through the configured thread store rather than bypassing it.

**Data flow**: Configures an in-memory thread store, starts and removes a source thread, seeds a rollout path by resuming synthetic history into the store, then calls `resume_thread_from_rollout` and `fork_thread` on that path. It asserts the resumed thread id matches the seeded one, the forked thread id differs, and the in-memory store’s recorded `read_thread_by_rollout_path` call count is exactly 2.

**Call relations**: Validates the store-backed path-loading behavior of both resume and fork APIs.

*Call graph*: calls 5 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 10 external calls (new, assert_eq!, assert_ne!, empty_extension_registry, init_state_db, format!, Resumed, create_dir_all, tempdir, vec!).


##### `new_uses_active_provider_for_model_refresh`  (lines 999–1029)

```
async fn new_uses_active_provider_for_model_refresh()
```

**Purpose**: Checks that a manager built with `ThreadManager::new` refreshes models against the active configured provider endpoint.

**Data flow**: Starts a mock HTTP server, mounts a one-shot models response, builds a config whose model provider base URL points at the mock and whose model catalog is disabled, constructs a manager, calls `list_models(RefreshStrategy::Online)`, and asserts the mock received exactly one request.

**Call relations**: Covers `build_models_manager` and provider wiring in the production constructor.

*Call graph*: calls 6 internal fn (test_config, new, mount_models_once, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 7 external calls (new, start, assert_eq!, empty_extension_registry, create_dir_all, tempdir, vec!).


##### `interrupted_fork_snapshot_appends_interrupt_boundary`  (lines 1032–1079)

```
fn interrupted_fork_snapshot_appends_interrupt_boundary()
```

**Purpose**: Verifies that appending an interrupted boundary adds both the configured interrupted marker and a `TurnAborted` event for non-empty and empty histories.

**Data flow**: Calls `append_interrupted_boundary` on `InitialHistory::Forked` and `InitialHistory::New` using `InterruptedTurnHistoryMarker::ContextualUser`, serializes the resulting rollout items, and compares them to explicit expected vectors containing the marker and abort event.

**Call relations**: Directly tests the helper used when interrupted fork snapshots are synthesized.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `disabled_interrupted_fork_snapshot_appends_only_interrupt_event`  (lines 1082–1127)

```
fn disabled_interrupted_fork_snapshot_appends_only_interrupt_event()
```

**Purpose**: Checks that when interrupted markers are disabled, interrupted-boundary synthesis appends only the abort event and no marker item.

**Data flow**: Calls `append_interrupted_boundary` with `InterruptedTurnHistoryMarker::Disabled` on both non-empty and empty histories and compares serialized rollout items to expected vectors containing only the original content plus `TurnAborted`.

**Call relations**: Covers the marker-disabled branch in interrupted-boundary synthesis.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `interrupted_snapshot_is_not_mid_turn`  (lines 1130–1151)

```
fn interrupted_snapshot_is_not_mid_turn()
```

**Purpose**: Ensures that a history already ending with an interrupted marker and `TurnAborted` event is not considered mid-turn.

**Data flow**: Builds a forked history containing user text, partial assistant text, the contextual interrupted marker, and a `TurnAborted` event, then asserts `snapshot_turn_state` returns `ends_mid_turn: false` with no active turn metadata.

**Call relations**: Guards against duplicate interruption synthesis on already interrupted snapshots.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `multi_agent_v2_interrupted_marker_uses_developer_input_message`  (lines 1154–1169)

```
fn multi_agent_v2_interrupted_marker_uses_developer_input_message()
```

**Purpose**: Verifies that the developer-style interrupted marker is encoded as a developer message with `InputText` content containing the expected guidance string.

**Data flow**: Obtains the marker via `developer_interrupted_marker`, pattern-matches it as `ResponseItem::Message`, asserts the role is `developer`, and checks the content contains `TurnAborted::INTERRUPTED_DEVELOPER_GUIDANCE`.

**Call relations**: Tests the marker content selected for multi-agent v2 interruption behavior.

*Call graph*: calls 1 internal fn (developer_interrupted_marker); 3 external calls (assert!, assert_eq!, panic!).


##### `completed_legacy_event_history_is_not_mid_turn`  (lines 1172–1197)

```
fn completed_legacy_event_history_is_not_mid_turn()
```

**Purpose**: Checks that a legacy event-only history containing a user message followed by an agent message is treated as completed rather than mid-turn.

**Data flow**: Builds `InitialHistory::Forked` from `EventMsg::UserMessage` and `EventMsg::AgentMessage`, then asserts `snapshot_turn_state` reports not mid-turn and no active turn metadata.

**Call relations**: Covers legacy-history fallback logic in mid-turn detection.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `mixed_response_and_legacy_user_event_history_is_mid_turn`  (lines 1200–1221)

```
fn mixed_response_and_legacy_user_event_history_is_mid_turn()
```

**Purpose**: Checks that a mixed history lacking a terminating turn boundary after the last user message is treated as mid-turn.

**Data flow**: Builds a forked history containing a response-item user message followed by a legacy `EventMsg::UserMessage`, then asserts `snapshot_turn_state` reports `ends_mid_turn: true`.

**Call relations**: Exercises the fallback branch that scans after the last user boundary for completion/abort events.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history`  (lines 1224–1328)

```
async fn interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history()
```

**Purpose**: Verifies that interrupted fork snapshots created from legacy mid-turn histories preserve the absence of an explicit turn id instead of inventing one.

**Data flow**: Creates a manager and source thread from a partial forked history without explicit turn lifecycle events, reads the persisted rollout history, confirms `snapshot_turn_state` is mid-turn with `active_turn_id == None`, forks with `ForkSnapshot::Interrupted`, reads the forked rollout history, filters out session metadata, and asserts exactly one interrupted marker and one `TurnAborted` event exist with `turn_id: None`.

**Call relations**: Tests the interaction between persisted-history inspection and interrupted-boundary synthesis when no live source thread metadata is available.

*Call graph*: calls 7 internal fn (test_config, new, contextual_user_interrupted_marker, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, get_rollout_history); 13 external calls (new, assert!, assert_eq!, empty_extension_registry, init_state_db, TurnAborted, Forked, EventMsg, ResponseItem, to_value (+3 more)).


##### `interrupted_fork_snapshot_preserves_explicit_turn_id`  (lines 1331–1425)

```
async fn interrupted_fork_snapshot_preserves_explicit_turn_id()
```

**Purpose**: Checks that interrupted fork snapshots preserve an explicit active turn id from persisted history.

**Data flow**: Creates a source thread from history beginning with `EventMsg::TurnStarted { turn_id: "turn-explicit" }` followed by partial content, reads persisted history to confirm `snapshot_turn_state` captures that turn id and start index, forks with `ForkSnapshot::Interrupted`, reads the forked rollout history, and asserts a `TurnAborted` event exists with `turn_id == "turn-explicit"`.

**Call relations**: Covers the explicit-turn-id preservation path in interrupted snapshot generation.

*Call graph*: calls 6 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, get_rollout_history); 9 external calls (new, assert!, assert_eq!, empty_extension_registry, init_state_db, Forked, create_dir_all, tempdir, vec!).


##### `interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source`  (lines 1428–1562)

```
async fn interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source()
```

**Purpose**: Verifies that interrupted forking relies on persisted rollout history alone, works after the live source thread has been removed, and does not duplicate interruption markers when re-forking an already interrupted snapshot.

**Data flow**: Creates a source thread from partial history, reads and confirms its persisted history is mid-turn, removes the live thread from the manager, forks from the rollout path, reads the forked history and asserts it is no longer mid-turn and contains exactly one interrupted marker. It then removes the forked thread, forks again from the already interrupted rollout, reads the re-forked history, and asserts there is still exactly one interrupted marker and one interrupted `TurnAborted` event.

**Call relations**: Exercises the persisted-history-only fork path and idempotence of interrupted snapshot handling.

*Call graph*: calls 7 internal fn (test_config, new, contextual_user_interrupted_marker, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, get_rollout_history); 11 external calls (new, assert!, assert_eq!, empty_extension_registry, init_state_db, Forked, ResponseItem, to_value, create_dir_all, tempdir (+1 more)).


### Policy and approval behavior
These files lock down execution policy, safety decisions, guardian review behavior, MCP exposure, and sandbox labeling across platforms and approval modes.

### `core/src/guardian/tests.rs`

`test` · `test-only`

This file is the guardian subsystem’s broad test suite. It exercises both small pure helpers and full nested-review flows against mock SSE servers. The fixtures build sessions and turns with deterministic parent thread IDs, custom model-provider base URLs, and seeded parent history containing user intent, tool evidence, and assistant follow-up. Several helpers normalize prompt text and snapshot paths so request-layout snapshots remain stable across platforms.

A notable test-only probe is `GuardianMemoryContextProbe`, an extension that records whether memories are enabled at thread start and contributes a developer-policy fragment only when they are. The guardian request-layout tests use this to prove that nested guardian sessions do not inherit memory context or skill-body injection, even when the parent session has those features enabled. The suite also validates delta prompt numbering, stale-cursor fallback to full prompts, network-access-specific prompt wording, transcript budgeting for tool evidence, parsing defaults for bare allow/deny JSON, model-selection analytics, prompt-cache-key reuse across follow-up reviews, stale-event handling on reused trunks, retry behavior for transient session and parse failures, and ephemeral fork behavior when a parallel trunk review is still in flight. The later tests focus on `build_guardian_review_session_config`, asserting that guardian sessions preserve only the intended parent state—such as active model choice and constrained network proxy—while clearing developer instructions, notifications, MCP servers, memories, and most optional features.

#### Function details

##### `fixed_guardian_parent_session_id`  (lines 81–84)

```
fn fixed_guardian_parent_session_id() -> ThreadId
```

**Purpose**: Returns a deterministic UUID thread ID used by guardian tests that need stable parent-session identity.

**Data flow**: Parses a fixed UUID string with `ThreadId::from_string` and returns the resulting `ThreadId`.

**Call relations**: Used by multiple fixtures and request-layout tests so guardian prompt-cache keys and session IDs are stable across runs.

*Call graph*: calls 1 internal fn (from_string); called by 4 (build_guardian_prompt_includes_parent_turn_denied_reads, guardian_review_request_layout_matches_model_visible_request_snapshot, guardian_test_session_and_turn_with_base_url, guardian_test_session_turn_and_rx).


##### `GuardianMemoryContextProbe::on_thread_start`  (lines 97–106)

```
fn on_thread_start(
        &'a self,
        input: codex_extension_api::ThreadStartInput<'a, Config>,
    ) -> codex_extension_api::ExtensionFuture<'a, ()>
```

**Purpose**: Test extension hook that records whether memories were enabled in the thread’s config at startup.

**Data flow**: Receives `ThreadStartInput<Config>`, boxes an async block, and inserts `GuardianMemoryContextEnabled(input.config.memories.use_memories)` into the thread-local extension store.

**Call relations**: Used only in guardian request-layout tests to verify that nested guardian sessions do not expose memory-derived prompt fragments.

*Call graph*: 1 external calls (pin).


##### `GuardianMemoryContextProbe::contribute`  (lines 110–127)

```
fn contribute(
        &'a self,
        _session_store: &'a codex_extension_api::ExtensionData,
        thread_store: &'a codex_extension_api::ExtensionData,
    ) -> codex_extension_api::ExtensionFu
```

**Purpose**: Test extension prompt contributor that emits a developer-policy probe string only when the thread-start hook recorded memories as enabled.

**Data flow**: Reads the thread-local extension store, checks for `GuardianMemoryContextEnabled(true)`, and returns either a one-element vector containing `PromptFragment::developer_policy(GUARDIAN_MEMORY_CONTEXT_PROBE)` or an empty vector.

**Call relations**: Paired with `on_thread_start` in the request-layout test to detect whether guardian sessions accidentally inherit memory context.

*Call graph*: 3 external calls (pin, new, vec!).


##### `guardian_rejection_circuit_breaker_interrupts_after_three_consecutive_denials`  (lines 131–152)

```
fn guardian_rejection_circuit_breaker_interrupts_after_three_consecutive_denials()
```

**Purpose**: Verifies that the circuit breaker interrupts after three consecutive denials and only once.

**Data flow**: Creates a default `GuardianRejectionCircuitBreaker`, calls `record_denial("turn-1")` four times, and asserts the first two return `Continue`, the third returns `InterruptTurn { consecutive_denials: 3, recent_denials: 3 }`, and the fourth returns `Continue` because the interrupt latch is already set.

**Call relations**: Tests the consecutive-denial threshold in `GuardianRejectionCircuitBreaker::record_denial`.

*Call graph*: 2 external calls (assert_eq!, default).


##### `guardian_rejection_circuit_breaker_resets_consecutive_denials_on_non_denial`  (lines 155–177)

```
fn guardian_rejection_circuit_breaker_resets_consecutive_denials_on_non_denial()
```

**Purpose**: Verifies that a non-denial resets the consecutive-denial streak without erasing recent-denial history.

**Data flow**: Creates a circuit breaker, records one denial, one non-denial, then three more denials, and asserts the interrupt occurs only after the new streak reaches three while recent denials count all prior denied entries in the window.

**Call relations**: Tests the interaction between `record_denial` and `record_non_denial`.

*Call graph*: 2 external calls (assert_eq!, default).


##### `auto_review_rejection_circuit_breaker_interrupts_after_ten_recent_denials`  (lines 180–196)

```
fn auto_review_rejection_circuit_breaker_interrupts_after_ten_recent_denials()
```

**Purpose**: Verifies that the rolling recent-denial threshold triggers interruption even without a long consecutive streak.

**Data flow**: Alternates denial and non-denial nine times, then records a tenth denial and asserts the result is `InterruptTurn { consecutive_denials: 1, recent_denials: 10 }`.

**Call relations**: Tests the recent-window threshold in the circuit breaker.

*Call graph*: 2 external calls (assert_eq!, default).


##### `auto_review_rejection_circuit_breaker_forgets_denials_outside_recent_review_window`  (lines 199–215)

```
fn auto_review_rejection_circuit_breaker_forgets_denials_outside_recent_review_window()
```

**Purpose**: Verifies that denials falling outside the bounded recent-review window no longer count toward interruption.

**Data flow**: Builds up nine alternating denials/non-denials, then appends enough non-denials to push the oldest denials out of the window, records one more denial, and asserts the result is still `Continue`.

**Call relations**: Tests the bounded deque behavior enforced by `record_recent_review`.

*Call graph*: 2 external calls (assert_eq!, default).


##### `guardian_test_session_and_turn`  (lines 217–221)

```
async fn guardian_test_session_and_turn(
    server: &wiremock::MockServer,
) -> (Arc<Session>, Arc<TurnContext>)
```

**Purpose**: Convenience fixture that builds a guardian-capable session and turn using a mock server’s base URL.

**Data flow**: Reads `server.uri()`, forwards it to `guardian_test_session_and_turn_with_base_url`, and returns the resulting `(Arc<Session>, Arc<TurnContext>)`.

**Call relations**: Used by many integration tests that need a configured session/turn pair pointed at a mock Responses API server.

*Call graph*: calls 1 internal fn (guardian_test_session_and_turn_with_base_url); called by 7 (guardian_request_model_for_auto_review, guardian_reused_trunk_ignores_stale_prior_turn_completion, guardian_reuses_prompt_cache_key_and_appends_prior_reviews, guardian_review_does_not_retry_missing_assessment_payload, guardian_review_does_not_retry_valid_denial, guardian_review_retries_transient_session_failure_then_approves, guardian_review_retries_two_parse_failures_then_approves); 1 external calls (uri).


##### `guardian_test_session_turn_and_rx`  (lines 223–254)

```
async fn guardian_test_session_turn_and_rx(
    server: &wiremock::MockServer,
) -> (
    Arc<Session>,
    Arc<TurnContext>,
    async_channel::Receiver<Event>,
)
```

**Purpose**: Fixture that builds a guardian-capable session, turn, and event receiver for tests that need to inspect emitted events.

**Data flow**: Creates a session/turn/event-receiver fixture, overwrites the session thread ID with `fixed_guardian_parent_session_id()`, clones and rewrites the turn config’s model-provider base URL, rebuilds the models manager and provider, clears user instructions, and returns `(session, turn, rx)`.

**Call relations**: Used by tests that need both guardian review execution and direct access to emitted `Event`s.

*Call graph*: calls 3 internal fn (fixed_guardian_parent_session_id, make_session_and_context_with_rx, models_manager_with_provider); called by 1 (guardian_review_exhausts_three_failures_with_one_terminal_event); 5 external calls (clone, get_mut, new, create_model_provider, format!).


##### `guardian_shell_request`  (lines 256–265)

```
fn guardian_shell_request(id: &str) -> GuardianApprovalRequest
```

**Purpose**: Builds a standard shell approval request used across multiple guardian review tests.

**Data flow**: Constructs and returns `GuardianApprovalRequest::Shell` with the supplied ID, command `git push`, a fixed repo cwd, default sandbox permissions, no additional permissions, and a justification string.

**Call relations**: Shared fixture for retry and denial-path tests.

*Call graph*: called by 5 (guardian_review_does_not_retry_missing_assessment_payload, guardian_review_does_not_retry_valid_denial, guardian_review_exhausts_three_failures_with_one_terminal_event, guardian_review_retries_transient_session_failure_then_approves, guardian_review_retries_two_parse_failures_then_approves); 2 external calls (test_path_buf, vec!).


##### `guardian_test_session_and_turn_with_base_url`  (lines 267–286)

```
async fn guardian_test_session_and_turn_with_base_url(
    base_url: &str,
) -> (Arc<Session>, Arc<TurnContext>)
```

**Purpose**: Builds a session and turn configured for guardian tests against an arbitrary model-provider base URL.

**Data flow**: Creates a session/turn fixture, sets a deterministic parent thread ID, clones and rewrites the turn config’s base URL, rebuilds the models manager and provider from that config, clears user instructions, and returns `Arc`-wrapped session and turn.

**Call relations**: Underlying fixture used by `guardian_test_session_and_turn` and prompt-construction tests.

*Call graph*: calls 3 internal fn (fixed_guardian_parent_session_id, make_session_and_context, models_manager_with_provider); called by 7 (build_guardian_prompt_delta_mode_handles_empty_delta, build_guardian_prompt_delta_mode_preserves_original_numbering, build_guardian_prompt_full_mode_preserves_initial_review_format, build_guardian_prompt_items_explains_network_access_review_scope, build_guardian_prompt_stale_delta_cursor_falls_back_to_full_prompt, build_guardian_prompt_stale_delta_version_falls_back_to_full_prompt, guardian_test_session_and_turn); 4 external calls (clone, new, create_model_provider, format!).


##### `seed_guardian_parent_history`  (lines 288–331)

```
async fn seed_guardian_parent_history(session: &Arc<Session>, turn: &Arc<TurnContext>)
```

**Purpose**: Seeds a parent session with representative user, tool-call, tool-result, and assistant history for guardian prompt tests.

**Data flow**: Calls `session.record_conversation_items(...)` with a fixed sequence of `ResponseItem`s: a user request about checking repo visibility and pushing a docs fix, a `gh_repo_view` function call, its textual output, and an assistant message requesting approval to push.

**Call relations**: Used by most prompt and review integration tests so guardian sees realistic retained transcript context.

*Call graph*: calls 1 internal fn (from_text); called by 16 (build_guardian_prompt_delta_mode_handles_empty_delta, build_guardian_prompt_delta_mode_preserves_original_numbering, build_guardian_prompt_full_mode_preserves_initial_review_format, build_guardian_prompt_includes_parent_turn_denied_reads, build_guardian_prompt_items_explains_network_access_review_scope, build_guardian_prompt_stale_delta_cursor_falls_back_to_full_prompt, build_guardian_prompt_stale_delta_version_falls_back_to_full_prompt, guardian_request_model_for_auto_review, guardian_reuses_prompt_cache_key_and_appends_prior_reviews, guardian_review_does_not_retry_missing_assessment_payload (+6 more)); 1 external calls (vec!).


##### `rollout_item_contains_message_text`  (lines 333–338)

```
fn rollout_item_contains_message_text(item: &RolloutItem, needle: &str) -> bool
```

**Purpose**: Checks whether a `RolloutItem` wraps a message containing a given substring.

**Data flow**: Matches the rollout item as `RolloutItem::ResponseItem` and delegates to `response_item_contains_message_text`; otherwise returns false.

**Call relations**: Used by follow-up review tests that inspect committed fork rollout snapshots.

*Call graph*: calls 1 internal fn (response_item_contains_message_text).


##### `response_item_contains_message_text`  (lines 340–348)

```
fn response_item_contains_message_text(item: &ResponseItem, needle: &str) -> bool
```

**Purpose**: Checks whether a `ResponseItem::Message` contains a given substring in any text content span.

**Data flow**: Matches the item as `ResponseItem::Message`, iterates its `ContentItem`s, and returns true if any input/output text contains `needle`; non-message items and images return false.

**Call relations**: Helper for rollout snapshot assertions.

*Call graph*: called by 1 (rollout_item_contains_message_text).


##### `guardian_snapshot_options`  (lines 350–354)

```
fn guardian_snapshot_options() -> ContextSnapshotOptions
```

**Purpose**: Builds the snapshot-formatting options used for guardian request-layout snapshots.

**Data flow**: Starts from `ContextSnapshotOptions::default()`, strips capability instructions and agents.md user context, and returns the configured options.

**Call relations**: Used by snapshot-based request-layout tests to keep snapshots focused on guardian-specific content.

*Call graph*: calls 1 internal fn (default).


##### `normalize_guardian_snapshot_paths`  (lines 356–373)

```
fn normalize_guardian_snapshot_paths(text: String) -> String
```

**Purpose**: Normalizes platform-specific path renderings in snapshot text back to canonical Unix-style test paths.

**Data flow**: Iterates over canonical paths, computes the platform-specific rendering via `test_path_buf(...).display()`, and replaces both raw and JSON-escaped platform paths with the canonical path in the supplied string.

**Call relations**: Used before snapshot assertions so guardian prompt/request snapshots are stable across operating systems.

*Call graph*: 2 external calls (test_path_buf, to_string).


##### `guardian_prompt_text`  (lines 375–383)

```
fn guardian_prompt_text(items: &[codex_protocol::user_input::UserInput]) -> String
```

**Purpose**: Concatenates the text spans from guardian `UserInput` items into one string for assertions.

**Data flow**: Iterates over `UserInput` items, extracts `text` from `UserInput::Text`, substitutes empty strings for non-text items, concatenates them, and returns the result.

**Call relations**: Used by many prompt-construction tests to assert on the assembled guardian prompt body.

*Call graph*: called by 7 (build_guardian_prompt_delta_mode_handles_empty_delta, build_guardian_prompt_delta_mode_preserves_original_numbering, build_guardian_prompt_full_mode_preserves_initial_review_format, build_guardian_prompt_includes_parent_turn_denied_reads, build_guardian_prompt_items_explains_network_access_review_scope, build_guardian_prompt_stale_delta_cursor_falls_back_to_full_prompt, build_guardian_prompt_stale_delta_version_falls_back_to_full_prompt); 1 external calls (iter).


##### `last_user_message_text_from_body`  (lines 385–398)

```
fn last_user_message_text_from_body(body: &serde_json::Value) -> String
```

**Purpose**: Extracts the concatenated text of the last user message from a serialized Responses API request body.

**Data flow**: Navigates the JSON body through `/input`, filters for user-role items, takes the last user content array, filters for `input_text` spans, concatenates their `text` fields, and returns the resulting string.

**Call relations**: Used by tests that inspect serialized guardian request bodies, especially follow-up and ephemeral-fork request layout.


##### `build_guardian_transcript_keeps_original_numbering`  (lines 401–427)

```
fn build_guardian_transcript_keeps_original_numbering()
```

**Purpose**: Verifies that transcript rendering preserves original entry numbering for the retained subset.

**Data flow**: Builds three transcript entries, renders only the first two with `render_guardian_transcript_entries`, and asserts the output lines are numbered `[1]` and `[2]` with no omission note.

**Call relations**: Tests transcript rendering behavior in the prompt module.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `build_guardian_prompt_full_mode_preserves_initial_review_format`  (lines 430–458)

```
async fn build_guardian_prompt_full_mode_preserves_initial_review_format() -> anyhow::Result<()>
```

**Purpose**: Verifies the full guardian prompt layout for an initial review, including transcript boundaries and action heading.

**Data flow**: Builds a test session/turn, seeds parent history, calls `build_guardian_prompt_items` in `Full` mode with a retry reason and shell request, concatenates prompt text, and asserts presence/absence of expected headings and transcript cursor count.

**Call relations**: Tests the full-mode branch of guardian prompt assembly.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, assert_eq!, test_path_buf, vec!).


##### `build_guardian_prompt_includes_parent_turn_denied_reads`  (lines 461–516)

```
async fn build_guardian_prompt_includes_parent_turn_denied_reads() -> anyhow::Result<()>
```

**Purpose**: Verifies that guardian prompts include parent-turn denied-read filesystem context when the permission profile blocks specific roots and globs.

**Data flow**: Creates a session/turn fixture, sets a restricted `PermissionProfile` with denied path and glob entries, seeds parent history, builds a full guardian prompt for a denied file read, concatenates prompt text, and asserts the denied-read section and entries are present.

**Call relations**: Tests `parent_turn_denied_reads_context` integration in prompt assembly.

*Call graph*: calls 6 internal fn (fixed_guardian_parent_session_id, guardian_prompt_text, seed_guardian_parent_history, make_session_and_context, from_runtime_permissions, restricted); 4 external calls (new, assert!, test_path_buf, vec!).


##### `build_guardian_prompt_delta_mode_preserves_original_numbering`  (lines 519–579)

```
async fn build_guardian_prompt_delta_mode_preserves_original_numbering() -> anyhow::Result<()>
```

**Purpose**: Verifies that delta-mode guardian prompts include only new transcript entries while preserving original numbering offsets.

**Data flow**: Seeds parent history, appends two more conversation items, builds a delta prompt with cursor count 4, concatenates prompt text, and asserts the delta headings, `[5]`/`[6]` numbering, absence of earlier entries, and updated transcript cursor count.

**Call relations**: Tests the valid-delta branch of prompt assembly.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, assert_eq!, test_path_buf, vec!).


##### `build_guardian_prompt_delta_mode_handles_empty_delta`  (lines 582–613)

```
async fn build_guardian_prompt_delta_mode_handles_empty_delta() -> anyhow::Result<()>
```

**Purpose**: Verifies that delta-mode prompts render an explicit placeholder when no new retained transcript entries were added.

**Data flow**: Seeds parent history, builds a delta prompt with a cursor matching the current retained entry count, concatenates prompt text, and asserts the delta placeholder and unchanged transcript cursor count.

**Call relations**: Tests the empty-delta rendering path.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, assert_eq!, test_path_buf, vec!).


##### `build_guardian_prompt_stale_delta_cursor_falls_back_to_full_prompt`  (lines 616–648)

```
async fn build_guardian_prompt_stale_delta_cursor_falls_back_to_full_prompt() -> anyhow::Result<()>
```

**Purpose**: Verifies that an invalid delta cursor with an entry count beyond current history falls back to full prompt mode.

**Data flow**: Seeds parent history, builds a delta prompt with an impossible `transcript_entry_count`, concatenates prompt text, and asserts the full-mode headings are used instead of delta headings.

**Call relations**: Tests stale-cursor fallback logic in prompt assembly.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, assert_eq!, test_path_buf, vec!).


##### `build_guardian_prompt_stale_delta_version_falls_back_to_full_prompt`  (lines 651–736)

```
async fn build_guardian_prompt_stale_delta_version_falls_back_to_full_prompt() -> anyhow::Result<()>
```

**Purpose**: Verifies that a stale delta cursor from an earlier history version falls back to full prompt mode after history replacement/compaction.

**Data flow**: Seeds parent history, replaces session history with compacted items, appends new conversation items, builds a delta prompt with the old history version, concatenates prompt text, and asserts full-mode headings, correct numbering of current retained entries, and updated history version in the returned cursor.

**Call relations**: Tests history-version validation for delta prompt reuse.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, assert_eq!, test_path_buf, vec!).


##### `collect_guardian_transcript_entries_skips_contextual_user_messages`  (lines 739–771)

```
fn collect_guardian_transcript_entries_skips_contextual_user_messages()
```

**Purpose**: Verifies that synthetic contextual user messages are excluded from the guardian transcript.

**Data flow**: Builds a contextual user message and a normal assistant message, calls `collect_guardian_transcript_entries`, and asserts only the assistant entry remains.

**Call relations**: Tests transcript filtering of contextual scaffolding.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `collect_guardian_transcript_entries_keeps_manual_approval_developer_message`  (lines 774–807)

```
fn collect_guardian_transcript_entries_keeps_manual_approval_developer_message()
```

**Purpose**: Verifies that only the special developer message marking manual approval of a previously denied action is retained.

**Data flow**: Builds one ordinary developer message and one prefixed approval-marker developer message, collects transcript entries, and asserts only the prefixed message is retained as a `Developer` entry.

**Call relations**: Tests the selective developer-message retention rule.

*Call graph*: 3 external calls (assert_eq!, format!, vec!).


##### `collect_guardian_transcript_entries_includes_recent_tool_calls_and_output`  (lines 810–864)

```
fn collect_guardian_transcript_entries_includes_recent_tool_calls_and_output()
```

**Purpose**: Verifies that tool calls and their outputs are retained and labeled correctly in the guardian transcript.

**Data flow**: Builds a user message, function call, function call output, and assistant message, collects transcript entries, and asserts the tool call and tool result entries are present with `tool read_file call` and `tool read_file result` labels.

**Call relations**: Tests tool-evidence extraction in transcript collection.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `guardian_truncate_text_keeps_prefix_suffix_and_xml_marker`  (lines 867–876)

```
fn guardian_truncate_text_keeps_prefix_suffix_and_xml_marker()
```

**Purpose**: Verifies that long text truncation preserves both ends of the string and inserts the XML-like omission marker.

**Data flow**: Builds a long repeated string, calls `guardian_truncate_text` with a small token cap, and asserts the result starts with the prefix, contains the truncation marker, ends with the suffix, and reports truncation.

**Call relations**: Tests the truncation helper used by transcript and action rendering.

*Call graph*: 1 external calls (assert!).


##### `format_guardian_action_pretty_truncates_large_string_fields`  (lines 879–895)

```
fn format_guardian_action_pretty_truncates_large_string_fields() -> serde_json::Result<()>
```

**Purpose**: Verifies that pretty-rendered guardian action JSON truncates oversized string fields such as large patches.

**Data flow**: Builds an `ApplyPatch` request with a huge patch string, calls `format_guardian_action_pretty`, and asserts the rendered JSON contains the tool name, truncation marker, shorter text length, and `truncated = true`.

**Call relations**: Tests action formatting behavior from the approval-request module.

*Call graph*: 3 external calls (new, assert!, test_path_buf).


##### `format_guardian_action_pretty_reports_no_truncation_for_small_payload`  (lines 898–912)

```
fn format_guardian_action_pretty_reports_no_truncation_for_small_payload() -> serde_json::Result<()>
```

**Purpose**: Verifies that small action payloads are rendered without truncation.

**Data flow**: Builds a small `ApplyPatch` request, formats it, and asserts the rendered JSON contains the tool name and `truncated = false`.

**Call relations**: Companion test for non-truncating action formatting.

*Call graph*: 3 external calls (new, assert!, test_path_buf).


##### `guardian_approval_request_to_json_renders_mcp_tool_call_shape`  (lines 915–953)

```
fn guardian_approval_request_to_json_renders_mcp_tool_call_shape() -> serde_json::Result<()>
```

**Purpose**: Verifies the JSON shape produced for MCP tool-call approval requests, including optional connector and annotation fields.

**Data flow**: Builds a `GuardianApprovalRequest::McpToolCall`, converts it with `guardian_approval_request_to_json`, and asserts exact JSON equality.

**Call relations**: Tests approval-request serialization used in guardian prompt assembly.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `guardian_approval_request_to_json_renders_network_access_trigger`  (lines 956–997)

```
fn guardian_approval_request_to_json_renders_network_access_trigger() -> serde_json::Result<()>
```

**Purpose**: Verifies the JSON shape produced for network-access approval requests with a captured triggering action.

**Data flow**: Builds a `GuardianApprovalRequest::NetworkAccess` with a `GuardianNetworkAccessTrigger`, converts it to JSON, and asserts exact JSON equality including trigger fields.

**Call relations**: Tests network-access request serialization.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `build_guardian_prompt_items_explains_network_access_review_scope`  (lines 1000–1066)

```
async fn build_guardian_prompt_items_explains_network_access_review_scope() -> anyhow::Result<()>
```

**Purpose**: Verifies the specialized guardian prompt wording for network-access reviews, especially the emphasis on the triggering command rather than exact network target authorization.

**Data flow**: Builds a test session/turn, seeds parent history, constructs a network-access request with trigger, builds a full guardian prompt, concatenates prompt text, asserts the specialized explanatory text and absence of generic action/retry wording, and snapshots the normalized prompt layout.

**Call relations**: Tests the network-access branch in prompt assembly.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, test_path_buf, clone_current, vec!).


##### `guardian_assessment_action_redacts_apply_patch_patch_text`  (lines 1069–1088)

```
fn guardian_assessment_action_redacts_apply_patch_patch_text()
```

**Purpose**: Verifies that the redacted action summary used in guardian assessment events omits raw patch contents.

**Data flow**: Builds an `ApplyPatch` request, converts `guardian_assessment_action(&action)` to JSON, and asserts only type, cwd, and files are present.

**Call relations**: Tests redaction behavior in approval-request summarization.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `guardian_request_turn_id_prefers_network_access_owner_turn`  (lines 1091–1117)

```
fn guardian_request_turn_id_prefers_network_access_owner_turn()
```

**Purpose**: Verifies that network-access approval requests use their owning turn ID rather than the fallback turn ID.

**Data flow**: Builds a network-access request and an apply-patch request, calls `guardian_request_turn_id` on both with the same fallback, and asserts the network request returns its embedded owner turn while the patch request returns the fallback.

**Call relations**: Tests turn-ID derivation used by guardian review orchestration.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `guardian_request_target_item_id_omits_network_access_trigger_call_id`  (lines 1120–1141)

```
fn guardian_request_target_item_id_omits_network_access_trigger_call_id()
```

**Purpose**: Verifies that network-access approval requests do not expose the trigger call ID as the guardian target item ID.

**Data flow**: Builds a network-access request with a trigger and asserts `guardian_request_target_item_id(&network_access)` returns `None`.

**Call relations**: Tests target-item derivation used in guardian assessment events and analytics.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `cancelled_guardian_review_emits_terminal_abort_without_warning`  (lines 1144–1186)

```
async fn cancelled_guardian_review_emits_terminal_abort_without_warning()
```

**Purpose**: Verifies that an already-cancelled guardian review emits in-progress and aborted assessment events but no warning event.

**Data flow**: Creates a session/turn/event receiver fixture, cancels a token, runs `review_approval_request_with_cancel` on an apply-patch request, asserts `ReviewDecision::Abort`, drains emitted events, and asserts statuses are `[InProgress, Aborted]` with no warnings.

**Call relations**: Tests the immediate-cancellation branch in `run_guardian_review`.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 6 external calls (new, new, assert!, assert_eq!, test_path_buf, vec!).


##### `guardian_timeout_message_distinguishes_timeout_from_policy_denial`  (lines 1189–1194)

```
fn guardian_timeout_message_distinguishes_timeout_from_policy_denial()
```

**Purpose**: Verifies that the timeout message contains retry guidance and does not read like a policy denial.

**Data flow**: Calls `guardian_timeout_message()` and asserts the returned string mentions deadline and retry guidance but not unacceptable risk.

**Call relations**: Tests the timeout-message helper.

*Call graph*: 1 external calls (assert!).


##### `routes_approval_to_guardian_requires_guardian_reviewer`  (lines 1197–1209)

```
async fn routes_approval_to_guardian_requires_guardian_reviewer()
```

**Purpose**: Verifies that guardian routing depends on `ApprovalsReviewer::AutoReview`, not just the approval policy.

**Data flow**: Builds a turn fixture, toggles `config.approvals_reviewer` between `User` and `AutoReview`, and asserts `routes_approval_to_guardian(&turn)` changes from false to true.

**Call relations**: Tests the default routing predicate in review orchestration.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (new, assert!).


##### `routes_approval_to_guardian_can_use_app_reviewer_override`  (lines 1212–1223)

```
async fn routes_approval_to_guardian_can_use_app_reviewer_override()
```

**Purpose**: Verifies that the reviewer-aware routing helper respects an explicit reviewer override.

**Data flow**: Builds a turn fixture and asserts `routes_approval_to_guardian_with_reviewer` returns false for `User` and true for `AutoReview`.

**Call relations**: Tests the reviewer-override routing helper.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert!).


##### `routes_approval_to_guardian_allows_granular_review_policy`  (lines 1226–1242)

```
async fn routes_approval_to_guardian_allows_granular_review_policy()
```

**Purpose**: Verifies that granular approval policy still routes through guardian when the reviewer is `AutoReview`.

**Data flow**: Builds a turn fixture, sets `approvals_reviewer = AutoReview`, updates `approval_policy` to `AskForApproval::Granular(...)`, and asserts `routes_approval_to_guardian(&turn)` is true.

**Call relations**: Tests the policy branch in guardian routing.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (new, Granular, assert!).


##### `build_guardian_transcript_reserves_separate_budget_for_tool_evidence`  (lines 1245–1283)

```
fn build_guardian_transcript_reserves_separate_budget_for_tool_evidence()
```

**Purpose**: Verifies that transcript rendering preserves user/assistant context even when many huge tool entries are present, thanks to the separate tool budget.

**Data flow**: Builds a transcript with one user, one assistant, and many oversized tool entries, renders it, and asserts the human entries remain while some early tool entries are omitted and an omission note is present.

**Call relations**: Tests the separate message/tool budgeting policy in transcript rendering.

*Call graph*: 2 external calls (assert!, vec!).


##### `build_guardian_transcript_preserves_recent_tool_context_when_user_history_is_large`  (lines 1286–1331)

```
fn build_guardian_transcript_preserves_recent_tool_context_when_user_history_is_large()
```

**Purpose**: Verifies that recent tool evidence is still retained even when user history alone is large.

**Data flow**: Builds many oversized user entries plus a recent tool call and tool result, renders the transcript, and asserts at least one user entry and both recent tool entries are present, with an omission note.

**Call relations**: Tests the newest-first non-user retention logic in transcript rendering.

*Call graph*: 4 external calls (assert!, assert_eq!, Tool, json!).


##### `parse_guardian_assessment_extracts_embedded_json`  (lines 1334–1349)

```
fn parse_guardian_assessment_extracts_embedded_json()
```

**Purpose**: Verifies that guardian assessment parsing can recover a JSON object embedded inside surrounding prose.

**Data flow**: Calls `parse_guardian_assessment` on a string containing prose plus JSON and asserts the returned `GuardianAssessment` fields match the embedded object.

**Call relations**: Tests the prose-wrapper recovery path in guardian assessment parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `parse_guardian_assessment_treats_bare_allow_as_low_risk`  (lines 1352–1365)

```
fn parse_guardian_assessment_treats_bare_allow_as_low_risk()
```

**Purpose**: Verifies defaulting behavior for a minimal allow assessment containing only `{"outcome":"allow"}`.

**Data flow**: Parses the bare allow JSON and asserts the returned assessment defaults to `risk_level = Low`, `user_authorization = Unknown`, and the canned allow rationale.

**Call relations**: Tests parser defaults for omitted optional fields on allow.

*Call graph*: 1 external calls (assert_eq!).


##### `parse_guardian_assessment_treats_bare_deny_as_high_risk`  (lines 1368–1381)

```
fn parse_guardian_assessment_treats_bare_deny_as_high_risk()
```

**Purpose**: Verifies defaulting behavior for a minimal deny assessment containing only `{"outcome":"deny"}`.

**Data flow**: Parses the bare deny JSON and asserts the returned assessment defaults to `risk_level = High`, `user_authorization = Unknown`, and the canned deny rationale.

**Call relations**: Tests parser defaults for omitted optional fields on deny.

*Call graph*: 1 external calls (assert_eq!).


##### `guardian_output_schema_requires_only_outcome_and_allows_optional_details`  (lines 1384–1412)

```
fn guardian_output_schema_requires_only_outcome_and_allows_optional_details()
```

**Purpose**: Verifies the exact guardian output JSON schema shape.

**Data flow**: Calls `guardian_output_schema()` and asserts exact JSON equality with the expected object schema requiring only `outcome`.

**Call relations**: Tests the schema helper used in guardian review requests.

*Call graph*: 1 external calls (assert_eq!).


##### `guardian_request_model_for_auto_review`  (lines 1419–1504)

```
async fn guardian_request_model_for_auto_review(
    auto_review_model_override: Option<String>,
    catalog: GuardianTestCatalog,
) -> anyhow::Result<(
    String,
    String,
    String,
    codex_a
```

**Purpose**: Shared integration helper that runs one guardian review against a mock server and returns the actual request model, parent model, preferred review model, and guardian analytics metadata.

**Data flow**: Starts a mock server, mounts a one-shot SSE approval response, builds a guardian test session/turn, optionally replaces the model catalog with parent-only models, applies an auto-review model override if supplied, seeds parent history, runs `run_guardian_review_session_for_test` with one attempt, extracts the request body’s `model` field from the logged request, and returns `(request_model, parent_model, preferred_model, analytics_result)`.

**Call relations**: Used by the three model-selection analytics tests below.

*Call graph*: calls 6 internal fn (guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_once, sse, start_mock_server, new); called by 3 (guardian_review_records_missing_auto_review_model_in_analytics_metadata, guardian_review_uses_model_catalog_override_when_preferred_review_model_exists, guardian_review_uses_preferred_review_model_without_model_catalog_override); 7 external calls (clone, get_mut, new, test_path_buf, panic!, json!, vec!).


##### `guardian_review_uses_model_catalog_override_when_preferred_review_model_exists`  (lines 1507–1544)

```
async fn guardian_review_uses_model_catalog_override_when_preferred_review_model_exists() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicit auto-review model override is used when present and recorded correctly in analytics metadata.

**Data flow**: Calls `guardian_request_model_for_auto_review` with an override and bundled catalog, then asserts the request model equals the override, differs from parent and preferred models, and that analytics fields record catalog presence, default review model ID, override flag/value, and provider ID.

**Call relations**: Tests model-selection logic in guardian review session setup.

*Call graph*: calls 1 internal fn (guardian_request_model_for_auto_review); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `guardian_review_uses_preferred_review_model_without_model_catalog_override`  (lines 1547–1582)

```
async fn guardian_review_uses_preferred_review_model_without_model_catalog_override() -> anyhow::Result<()>
```

**Purpose**: Verifies that guardian uses the provider’s preferred review model when no explicit override is configured and the catalog contains that model.

**Data flow**: Calls the shared helper without an override and with the bundled catalog, then asserts the request model equals the preferred review model, differs from the parent model, and analytics metadata reflects no override.

**Call relations**: Tests the default preferred-model path.

*Call graph*: calls 1 internal fn (guardian_request_model_for_auto_review); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `guardian_review_records_missing_auto_review_model_in_analytics_metadata`  (lines 1585–1620)

```
async fn guardian_review_records_missing_auto_review_model_in_analytics_metadata() -> anyhow::Result<()>
```

**Purpose**: Verifies that when the preferred auto-review model is absent from the catalog, guardian falls back to the parent model and records that absence in analytics.

**Data flow**: Calls the shared helper without an override and with a parent-only catalog, then asserts the request model equals the parent model, differs from the preferred review model, and analytics metadata marks `guardian_catalog_contains_auto_review = false`.

**Call relations**: Tests fallback model selection and analytics reporting.

*Call graph*: calls 1 internal fn (guardian_request_model_for_auto_review); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `guardian_review_request_layout_matches_model_visible_request_snapshot`  (lines 1623–1820)

```
async fn guardian_review_request_layout_matches_model_visible_request_snapshot() -> anyhow::Result<()>
```

**Purpose**: End-to-end snapshot test that verifies the serialized guardian review request body seen by the model, including schema, prompt layout, model metadata, and exclusion of memory/skill-body injection.

**Data flow**: Starts a mock server with an allow response, builds a session/turn with deterministic thread ID, temp cwd, enabled memories and memory tool, installs the `GuardianMemoryContextProbe` extension, writes a test skill file, seeds parent history plus a user message mentioning the skill, runs one guardian review session, inspects the logged request body and guardian analytics metadata, asserts the request contains the untrusted skill mention but not the skill body or memory probe, checks schema fields and model/reasoning metadata, and snapshots the normalized request layout.

**Call relations**: This is the broadest request-layout integration test, covering prompt assembly, session config hardening, and analytics metadata capture.

*Call graph*: calls 8 internal fn (fixed_guardian_parent_session_id, seed_guardian_parent_history, make_session_and_context, models_manager_with_provider, mount_sse_once, sse, start_mock_server, from_string); 17 external calls (clone, new, new, assert!, assert_eq!, assert_ne!, new, create_model_provider, test_path_buf, format! (+7 more)).


##### `build_guardian_prompt_items_includes_parent_session_id`  (lines 1823–1858)

```
async fn build_guardian_prompt_items_includes_parent_session_id() -> anyhow::Result<()>
```

**Purpose**: Verifies that the guardian prompt includes the reviewed parent session ID immediately after the transcript end marker.

**Data flow**: Builds a session fixture, constructs a full guardian prompt for a shell request, concatenates prompt text, and asserts it contains `Reviewed Codex session id: {session.thread_id}` directly after `>>> TRANSCRIPT END`.

**Call relations**: Tests a specific prompt-layout invariant in guardian prompt assembly.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert!, test_path_buf, vec!).


##### `guardian_reuses_prompt_cache_key_and_appends_prior_reviews`  (lines 1861–2154)

```
async fn guardian_reuses_prompt_cache_key_and_appends_prior_reviews() -> anyhow::Result<()>
```

**Purpose**: End-to-end test that verifies guardian trunk reuse across follow-up reviews, shared prompt-cache key, one-time follow-up reminder injection, and delta transcript prompts that append prior guardian context.

**Data flow**: Starts a mock server with three sequential allow responses, builds a guardian test session/turn, seeds parent history, runs three guardian review sessions with additional parent conversation inserted between them, inspects returned assessments and analytics metadata, asserts trunk-new then trunk-reused session kinds, stable guardian thread ID, `had_prior_review_context` transitions, shared prompt-cache key across requests, presence of the follow-up reminder and first rationale in later requests, persistence of the reminder in committed fork rollout items, and delta transcript numbering in the second request. It also snapshots the initial and follow-up request layouts.

**Call relations**: Exercises the reusable trunk session path, prompt-cache-key behavior, follow-up reminder injection, and committed fork snapshot persistence.

*Call graph*: calls 5 internal fn (guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_sequence, start_mock_server, from_string); 8 external calls (clone, assert!, assert_eq!, test_path_buf, panic!, clone_current, skip_if_no_network!, vec!).


##### `guardian_reused_trunk_ignores_stale_prior_turn_completion`  (lines 2157–2263)

```
async fn guardian_reused_trunk_ignores_stale_prior_turn_completion() -> anyhow::Result<()>
```

**Purpose**: Verifies that a reused guardian trunk ignores an injected stale completion event from a prior turn and waits for the real follow-up review response.

**Data flow**: Runs one guardian review to create a trunk, injects a raw stale `TurnComplete` event into the trunk session, runs a second review, and asserts the second assessment comes from the real second server response and that only two requests were sent.

**Call relations**: Tests stale-event filtering on reused trunk sessions end-to-end.

*Call graph*: calls 3 internal fn (guardian_test_session_and_turn, mount_sse_sequence, start_mock_server); 8 external calls (clone, assert!, assert_eq!, test_path_buf, panic!, TurnComplete, skip_if_no_network!, vec!).


##### `guardian_review_surfaces_responses_api_errors_in_rejection_reason`  (lines 2266–2374)

```
async fn guardian_review_surfaces_responses_api_errors_in_rejection_reason() -> anyhow::Result<()>
```

**Purpose**: Verifies that Responses API request errors are surfaced in guardian warning messages, denial rationales, stored rejection state, and later rejection-message retrieval.

**Data flow**: Starts a mock server returning a 400 invalid-request error, builds a session/turn/event receiver fixture pointed at that server, seeds parent history, runs `review_approval_request`, asserts denial and one request, drains warning and denied assessment events to check they contain the backend error message, inspects `session.services.guardian_rejections` for the stored review ID, and calls `guardian_rejection_message` to assert the user-facing message includes the same rationale.

**Call relations**: Tests fail-closed session-error handling and rejection rationale propagation in review orchestration.

*Call graph*: calls 5 internal fn (seed_guardian_parent_history, make_session_and_context_with_rx, models_manager_with_provider, mount_response_sequence, start_mock_server); 11 external calls (clone, get_mut, new, new, assert!, assert_eq!, create_model_provider, test_path_buf, format!, skip_if_no_network! (+1 more)).


##### `guardian_review_retries_transient_session_failure_then_approves`  (lines 2377–2430)

```
async fn guardian_review_retries_transient_session_failure_then_approves() -> anyhow::Result<()>
```

**Purpose**: Verifies that guardian retries a transient structured session failure and succeeds on the next attempt.

**Data flow**: Starts a mock server that first emits a transient overloaded failure and then an allow response, builds a guardian test session/turn, seeds parent history, runs `run_guardian_review_session_for_test` with `max_attempts = 3`, and asserts the final assessment is allow, rationale matches the second response, attempt count is 2, session kind is reused trunk, and two requests were sent.

**Call relations**: Tests retry behavior for transient structured session failures.

*Call graph*: calls 5 internal fn (guardian_shell_request, guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_sequence, start_mock_server); 7 external calls (clone, assert!, assert_eq!, panic!, json!, skip_if_no_network!, vec!).


##### `guardian_review_does_not_retry_missing_assessment_payload`  (lines 2433–2460)

```
async fn guardian_review_does_not_retry_missing_assessment_payload() -> anyhow::Result<()>
```

**Purpose**: Verifies that guardian does not retry when the nested review completes without any assessment payload.

**Data flow**: Starts a mock server that emits only response-created and completed events, builds a guardian test session/turn, seeds parent history, runs `review_approval_request`, and asserts denial with exactly one request.

**Call relations**: Tests that missing-payload failures are treated as non-retriable session errors.

*Call graph*: calls 5 internal fn (guardian_shell_request, guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_sequence, start_mock_server); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `guardian_review_retries_two_parse_failures_then_approves`  (lines 2463–2521)

```
async fn guardian_review_retries_two_parse_failures_then_approves() -> anyhow::Result<()>
```

**Purpose**: Verifies that guardian retries parse failures up to the configured limit and succeeds when a later attempt returns valid JSON.

**Data flow**: Starts a mock server with two invalid guardian messages followed by a valid allow response, builds a guardian test session/turn, seeds parent history, runs `run_guardian_review_session_for_test` with three attempts, and asserts allow outcome, final rationale, attempt count 3, reused-trunk session kind, and three requests.

**Call relations**: Tests retry behavior for parse failures.

*Call graph*: calls 5 internal fn (guardian_shell_request, guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_sequence, start_mock_server); 7 external calls (clone, assert!, assert_eq!, panic!, json!, skip_if_no_network!, vec!).


##### `guardian_review_exhausts_three_failures_with_one_terminal_event`  (lines 2524–2577)

```
async fn guardian_review_exhausts_three_failures_with_one_terminal_event() -> anyhow::Result<()>
```

**Purpose**: Verifies that exhausting all retry attempts still produces only one terminal guardian assessment event at the outer review layer.

**Data flow**: Starts a mock server with three invalid guardian messages, builds a session/turn/event receiver fixture, seeds parent history, runs `review_approval_request`, asserts denial and three requests, drains guardian assessment events, and asserts the statuses are only `[InProgress, Denied]`.

**Call relations**: Tests outer-event emission behavior across multiple internal retry attempts.

*Call graph*: calls 5 internal fn (guardian_shell_request, guardian_test_session_turn_and_rx, seed_guardian_parent_history, mount_sse_sequence, start_mock_server); 4 external calls (new, assert_eq!, skip_if_no_network!, vec!).


##### `guardian_review_does_not_retry_valid_denial`  (lines 2580–2615)

```
async fn guardian_review_does_not_retry_valid_denial() -> anyhow::Result<()>
```

**Purpose**: Verifies that a valid deny assessment is terminal and not retried.

**Data flow**: Starts a mock server with one valid deny response, builds a guardian test session/turn, seeds parent history, runs `review_approval_request`, and asserts denial with exactly one request.

**Call relations**: Tests that explicit guardian denials are not considered retryable.

*Call graph*: calls 5 internal fn (guardian_shell_request, guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_sequence, start_mock_server); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `guardian_ephemeral_retry_preserves_parallel_trunk_and_fork_history`  (lines 2618–2872)

```
async fn guardian_ephemeral_retry_preserves_parallel_trunk_and_fork_history() -> anyhow::Result<()>
```

**Purpose**: Stress-style integration test that verifies a parallel ephemeral guardian review forks from the last committed trunk state, preserves prompt-cache key across retries, and does not inherit still-in-flight trunk review context.

**Data flow**: Runs inside a dedicated thread/runtime with larger stack. It starts a streaming SSE server whose second response is gated, builds a guardian test session/turn, seeds parent history, runs an initial trunk review, appends more parent history, starts a second trunk follow-up review that blocks on the gate, appends additional parent history, runs a third review in parallel, and asserts the third review succeeds via an ephemeral fork after one parse-failure retry. It inspects the logged request bodies to verify shared prompt-cache key across trunk and ephemeral requests, inclusion of the first committed guardian rationale but exclusion of the still in-flight second rationale, and correct delta transcript numbering. It then releases the gate and asserts the blocked trunk review completes.

**Call relations**: Exercises the most complex interaction among trunk reuse, ephemeral forking, retry, prompt-cache-key reuse, and committed-fork snapshot semantics.

*Call graph*: 2 external calls (anyhow!, new).


##### `guardian_review_session_config_preserves_parent_network_proxy`  (lines 2874–2918)

```
async fn guardian_review_session_config_preserves_parent_network_proxy()
```

**Purpose**: Verifies that guardian session config preserves the parent network proxy spec when no live override is supplied, while still forcing guardian-specific model and permission settings.

**Data flow**: Builds a parent config with a constrained network proxy spec, calls `build_guardian_review_session_config_for_test`, and asserts the resulting guardian config keeps the same network spec, uses the supplied active model and reasoning effort, forces `approval_policy = never`, and uses `PermissionProfile::read_only()`.

**Call relations**: Tests guardian session config derivation for inherited network settings.

*Call graph*: calls 2 internal fn (from_config_and_constraints, test_config); 4 external calls (default, assert_eq!, default, from).


##### `guardian_review_session_config_clears_parent_developer_instructions`  (lines 2921–2939)

```
async fn guardian_review_session_config_clears_parent_developer_instructions()
```

**Purpose**: Verifies that guardian session config removes parent developer instructions and replaces them with the guardian policy prompt in `base_instructions`.

**Data flow**: Sets `developer_instructions` on a parent config, builds guardian config, and asserts `developer_instructions == None` and `base_instructions == Some(guardian_policy_prompt())`.

**Call relations**: Tests one of the key prompt-hardening invariants in guardian session config.

*Call graph*: calls 1 internal fn (test_config); 1 external calls (assert_eq!).


##### `guardian_review_session_config_clears_legacy_notify`  (lines 2942–2958)

```
async fn guardian_review_session_config_clears_legacy_notify()
```

**Purpose**: Verifies that guardian session config clears legacy notification hooks.

**Data flow**: Sets `notify` on a parent config, builds guardian config, and asserts `guardian_config.notify == None`.

**Call relations**: Tests another hardening invariant in guardian session config.

*Call graph*: calls 1 internal fn (test_config); 2 external calls (assert_eq!, vec!).


##### `guardian_review_session_config_uses_live_network_proxy_state`  (lines 2961–3002)

```
async fn guardian_review_session_config_uses_live_network_proxy_state()
```

**Purpose**: Verifies that when live network proxy state is supplied, guardian session config rebuilds network permissions from that live state rather than stale parent config state.

**Data flow**: Builds a parent config with one allowed domain, constructs a different live network config with another allowed domain, builds guardian config with the live override, and asserts the resulting network proxy spec matches the live config rebuilt under read-only permissions.

**Call relations**: Tests the live-network override branch in guardian session config building.

*Call graph*: calls 2 internal fn (from_config_and_constraints, test_config); 3 external calls (assert_eq!, default, vec!).


##### `guardian_review_session_config_disables_mcp_apps_plugins_and_memories`  (lines 3005–3039)

```
async fn guardian_review_session_config_disables_mcp_apps_plugins_and_memories()
```

**Purpose**: Verifies that guardian session config clears MCP servers and disables apps, plugins, app instructions, and memories inherited from the parent config.

**Data flow**: Builds a parent config with an MCP server, enabled apps/plugins, app instructions, and memories, builds guardian config, and asserts MCP servers are empty and all those features/settings are disabled.

**Call relations**: Tests the feature-stripping behavior of guardian session config.

*Call graph*: calls 1 internal fn (test_config); 3 external calls (from, assert!, from_str).


##### `guardian_review_session_config_allows_pinned_disabled_feature`  (lines 3042–3066)

```
async fn guardian_review_session_config_allows_pinned_disabled_feature()
```

**Purpose**: Verifies that guardian session config continues successfully even when a managed requirement pins a feature on and prevents disabling it.

**Data flow**: Builds a parent config whose managed features pin `multi_agent` enabled, builds guardian config, and asserts the resulting config still has `Feature::Collab` enabled while other hardening changes like clearing MCP servers and app instructions still apply.

**Call relations**: Tests the warning-and-continue behavior when feature disabling cannot fully succeed.

*Call graph*: calls 2 internal fn (from_configured, test_config); 2 external calls (from, assert!).


##### `guardian_review_session_config_uses_parent_active_model_instead_of_hardcoded_slug`  (lines 3069–3082)

```
async fn guardian_review_session_config_uses_parent_active_model_instead_of_hardcoded_slug()
```

**Purpose**: Verifies that guardian session config uses the supplied active model argument rather than any model slug already stored in the parent config.

**Data flow**: Sets `parent_config.model`, builds guardian config with a different `active-model`, and asserts the resulting config model is `active-model`.

**Call relations**: Tests active-model override behavior in guardian session config.

*Call graph*: calls 1 internal fn (test_config); 1 external calls (assert_eq!).


##### `guardian_review_session_config_keeps_bedrock_provider_for_bedrock_gpt_5_4`  (lines 3085–3115)

```
async fn guardian_review_session_config_keeps_bedrock_provider_for_bedrock_gpt_5_4()
```

**Purpose**: Verifies that guardian session config preserves the Bedrock provider identity and settings when using a Bedrock GPT-5.4 review model.

**Data flow**: Builds a parent config with Bedrock provider ID/info, builds guardian config for the Bedrock GPT-5.4 model with low reasoning effort, constructs the expected provider info with retries reduced to 1, and asserts exact equality of model, provider ID, and provider info.

**Call relations**: Tests provider-preservation behavior for non-OpenAI review models.

*Call graph*: calls 2 internal fn (test_config, create_amazon_bedrock_provider); 1 external calls (assert_eq!).


##### `guardian_review_session_config_uses_requirements_guardian_policy_config`  (lines 3118–3160)

```
async fn guardian_review_session_config_uses_requirements_guardian_policy_config()
```

**Purpose**: Verifies that a workspace-managed guardian policy override from config requirements is injected into guardian `base_instructions`.

**Data flow**: Builds a `ConfigLayerStack` containing `guardian_policy_config`, loads a parent config from it, builds guardian config, and asserts `developer_instructions == None` and `base_instructions == Some(guardian_policy_prompt_with_config(trimmed_override))`.

**Call relations**: Tests guardian policy override handling in session config building.

*Call graph*: calls 1 internal fn (new); 6 external calls (default, new, load_config_with_layer_stack, assert_eq!, default, tempdir).


##### `guardian_review_session_config_uses_default_guardian_policy_without_requirements_override`  (lines 3163–3196)

```
async fn guardian_review_session_config_uses_default_guardian_policy_without_requirements_override()
```

**Purpose**: Verifies that guardian session config falls back to the bundled default guardian policy when no requirements override is present.

**Data flow**: Builds a default `ConfigLayerStack`, loads a parent config, builds guardian config, and asserts `developer_instructions == None` and `base_instructions == Some(guardian_policy_prompt())`.

**Call relations**: Tests the default-policy branch in guardian session config building.

*Call graph*: calls 1 internal fn (new); 6 external calls (default, new, load_config_with_layer_stack, assert_eq!, default, tempdir).


### `core/src/exec_policy_tests.rs`

`test` · `test execution`

This large test module exercises nearly every branch in `exec_policy.rs`. It includes helpers for constructing synthetic `ConfigLayerStack`s, generating host-style executable paths, escaping strings for Starlark snippets, writing trust configuration, and building temporary `Config` instances. Many tests create temporary `rules/` directories and `.rules` files to verify loading order, ignored locations, disabled user/project rules, requirements overlays, and parse-error formatting.

A second major cluster validates command evaluation. Tests cover shell-wrapper lowering (`bash -lc`), heredoc fallback parsing, PowerShell behavior via a Windows-only submodule, absolute-path host executable matching, dangerous-command heuristics, and the interaction between `AskForApproval`, sandbox escalation requests, and explicit policy prompts. The expected `ExecApprovalRequirement` values are asserted exactly, including `reason`, `bypass_sandbox`, and proposed `ExecPolicyAmendment` contents.

The file also checks amendment suggestion rules in detail: banned broad prefixes are rejected, caller-supplied prefix rules must approve every parsed segment, and heuristic amendments are suppressed when explicit policy already matches. Finally, trust-related tests verify that project exec-policy files load only from trusted project layers or trusted roots discovered through nested repositories and worktrees, while warnings from untrusted project rules are intentionally ignored.

#### Function details

##### `config_stack_for_dot_codex_folder`  (lines 42–55)

```
fn config_stack_for_dot_codex_folder(dot_codex_folder: &Path) -> ConfigLayerStack
```

**Purpose**: Builds a minimal `ConfigLayerStack` rooted at a supplied `.codex` folder for policy-loading tests. It avoids full config loading when only layer structure matters.

**Data flow**: Reads `dot_codex_folder`, converts it to `AbsolutePathBuf`, constructs a single project `ConfigLayerEntry` with an empty TOML table, creates a `ConfigLayerStack` with default requirements and requirements TOML, and returns it.

**Call relations**: Used by many policy-loading tests that need a simple project-layer stack. It feeds directly into `load_exec_policy`, `ExecPolicyManager::load`, or warning-formatting checks.

*Call graph*: calls 3 internal fn (new, new, from_absolute_path); called by 6 (format_exec_policy_error_with_source_renders_range, ignores_policies_outside_policy_dir, ignores_policy_files_when_config_stack_disables_exec_policy_rules, loads_policies_from_policy_subdirectory, returns_empty_policy_when_no_policy_files_exist, rules_path_file_returns_read_dir_error); 5 external calls (default, Table, default, default, vec!).


##### `host_absolute_path`  (lines 57–67)

```
fn host_absolute_path(segments: &[&str]) -> String
```

**Purpose**: Constructs a platform-appropriate absolute path string from path segments for host-executable tests. It abstracts over Unix `/` and Windows `C:\` roots.

**Data flow**: Reads `segments`, starts from either `C:\` or `/` depending on `cfg!(windows)`, pushes each segment into a `PathBuf`, converts the result to a lossy string, and returns it.

**Call relations**: Used by host-executable and absolute-path command tests, and by `host_program_path`.

*Call graph*: called by 3 (absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths, host_program_path, preserves_host_executables_when_requirements_overlay_is_present); 2 external calls (from, cfg!).


##### `host_program_path`  (lines 69–76)

```
fn host_program_path(name: &str) -> String
```

**Purpose**: Builds a plausible absolute path to a host executable, adding `.exe` on Windows. It keeps host-executable rule tests platform-neutral.

**Data flow**: Reads `name`, appends `.exe` when `cfg!(windows)` is true, passes the executable name into `host_absolute_path` under `/usr/bin`-style segments, and returns the resulting string.

**Call relations**: Used by tests that verify host executable aliasing and absolute-path command matching against policy rules.

*Call graph*: calls 1 internal fn (host_absolute_path); called by 2 (absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths, absolute_path_exec_approval_requirement_matches_host_executable_rules); 2 external calls (cfg!, format!).


##### `starlark_string`  (lines 78–80)

```
fn starlark_string(value: &str) -> String
```

**Purpose**: Escapes backslashes and double quotes for embedding paths inside Starlark rule source strings. It prevents test-generated `.rules` snippets from becoming syntactically invalid.

**Data flow**: Reads `value`, replaces `\` with `\\` and `"` with `\"`, and returns the escaped string.

**Call relations**: Used by tests that generate `host_executable(...)` or other path-containing rule snippets.

*Call graph*: called by 3 (absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths, absolute_path_exec_approval_requirement_matches_host_executable_rules, preserves_host_executables_when_requirements_overlay_is_present).


##### `write_project_trust_config`  (lines 82–107)

```
async fn write_project_trust_config(
    codex_home: &Path,
    trusted_projects: &[(&Path, TrustLevel)],
) -> std::io::Result<()>
```

**Purpose**: Writes a `config.toml` containing project trust entries for trust-sensitive exec-policy tests. It simulates user trust configuration without invoking interactive flows.

**Data flow**: Reads `codex_home` and `trusted_projects`, builds a `ConfigToml` whose `projects` map associates each project path string with a `ProjectConfig { trust_level }`, serializes it with `toml::to_string`, and writes it asynchronously to `<codex_home>/config.toml`.

**Call relations**: Called by tests that verify trusted vs untrusted project-layer rule loading and warning suppression.

*Call graph*: called by 3 (exec_policies_only_load_from_trusted_project_layers, exec_policies_require_project_trust_without_config_toml, exec_policy_warnings_ignore_untrusted_project_rules_without_config_toml); 5 external calls (default, iter, join, write, to_string).


##### `test_config`  (lines 109–117)

```
async fn test_config() -> (TempDir, Config)
```

**Purpose**: Creates a temporary Codex home and loads a default test `Config`. It is a reusable fixture for tests comparing parent and child config stacks.

**Data flow**: Creates a `TempDir`, builds a config with `ConfigBuilder::without_managed_config_for_tests().codex_home(...)`, awaits `build()`, and returns `(TempDir, Config)`.

**Call relations**: Used by the `child_uses_parent_exec_policy` tests to obtain realistic configs without external files.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); called by 4 (child_does_not_use_parent_exec_policy_when_ignore_rules_differs, child_does_not_use_parent_exec_policy_when_requirements_exec_policy_differs, child_uses_parent_exec_policy_when_layer_stack_matches, child_uses_parent_exec_policy_when_non_exec_policy_layers_differ); 1 external calls (new).


##### `child_uses_parent_exec_policy_when_layer_stack_matches`  (lines 120–125)

```
async fn child_uses_parent_exec_policy_when_layer_stack_matches()
```

**Purpose**: Verifies identical parent and child configs are considered safe to share exec-policy state.

**Data flow**: Obtains a test config, clones it for the child, calls `child_uses_parent_exec_policy`, and asserts the result is true.

**Call relations**: Exercises the positive baseline for the config-comparison helper.

*Call graph*: calls 1 internal fn (test_config); 1 external calls (assert!).


##### `child_uses_parent_exec_policy_when_non_exec_policy_layers_differ`  (lines 128–152)

```
async fn child_uses_parent_exec_policy_when_non_exec_policy_layers_differ()
```

**Purpose**: Checks that adding a non-exec-policy-relevant layer does not force policy reload. It confirms the comparison ignores unrelated config layers.

**Data flow**: Builds parent and child configs, clones the child’s layers, appends a `SessionFlags` layer with empty TOML, rebuilds the child `ConfigLayerStack`, calls `child_uses_parent_exec_policy`, and asserts true.

**Call relations**: Targets the helper’s selective comparison logic by changing layer structure without changing config folders or exec-policy requirements.

*Call graph*: calls 3 internal fn (new, new, test_config); 3 external calls (default, Table, assert!).


##### `child_does_not_use_parent_exec_policy_when_ignore_rules_differs`  (lines 155–168)

```
async fn child_does_not_use_parent_exec_policy_when_ignore_rules_differs()
```

**Purpose**: Verifies differing `ignore_user_and_project_exec_policy_rules` settings prevent policy reuse.

**Data flow**: Builds parent and child configs, modifies the child stack with `with_user_and_project_exec_policy_rules_ignored(true)`, calls `child_uses_parent_exec_policy`, and asserts false.

**Call relations**: Covers one of the explicit mismatch conditions checked by the helper.

*Call graph*: calls 1 internal fn (test_config); 1 external calls (assert!).


##### `child_does_not_use_parent_exec_policy_when_requirements_exec_policy_differs`  (lines 171–209)

```
async fn child_does_not_use_parent_exec_policy_when_requirements_exec_policy_differs()
```

**Purpose**: Verifies differing requirements-overlay exec policy prevents policy reuse between parent and child configs.

**Data flow**: Builds parent and child configs, constructs a new `ConfigRequirements` containing a non-empty `exec_policy` overlay with a forbidden `rm` prefix rule, rebuilds the child stack, calls `child_uses_parent_exec_policy`, and asserts false.

**Call relations**: Covers the helper’s comparison of requirements-based exec-policy overlays.

*Call graph*: calls 4 internal fn (new, new, new, test_config); 3 external calls (default, assert!, empty).


##### `returns_empty_policy_when_no_policy_files_exist`  (lines 212–233)

```
async fn returns_empty_policy_when_no_policy_files_exist()
```

**Purpose**: Checks that loading from a config stack with no `rules/` directory yields an empty policy rather than an error.

**Data flow**: Creates a temp directory and config stack, awaits `ExecPolicyManager::load`, reads `manager.current()`, evaluates a sample command with an allow fallback, and asserts the result is a heuristic allow plus that the `rules/` directory does not exist.

**Call relations**: Exercises the non-error empty-policy path through `ExecPolicyManager::load` and `load_exec_policy_with_warning`.

*Call graph*: calls 2 internal fn (load, config_stack_for_dot_codex_folder); 4 external calls (assert!, assert_eq!, tempdir, vec!).


##### `rules_path_file_returns_read_dir_error`  (lines 236–253)

```
async fn rules_path_file_returns_read_dir_error()
```

**Purpose**: Verifies that if `rules` exists as a file instead of a directory, policy loading surfaces a `ReadDir` error.

**Data flow**: Creates a temp directory, writes a plain file at `<temp>/rules`, builds a config stack, calls `load_exec_policy`, expects an error, and asserts it matches `ExecPolicyError::ReadDir` for that path.

**Call relations**: Targets filesystem error mapping in `collect_policy_files` and `load_exec_policy`.

*Call graph*: calls 1 internal fn (config_stack_for_dot_codex_folder); 3 external calls (assert!, write, tempdir).


##### `collect_policy_files_returns_empty_when_dir_missing`  (lines 256–265)

```
async fn collect_policy_files_returns_empty_when_dir_missing()
```

**Purpose**: Checks that a missing policy directory is treated as empty rather than erroneous.

**Data flow**: Creates a temp directory, computes a nonexistent `rules` path, awaits `collect_policy_files`, and asserts the returned vector is empty.

**Call relations**: Directly exercises the `NotFound` branch in `collect_policy_files`.

*Call graph*: 2 external calls (assert!, tempdir).


##### `format_exec_policy_error_with_source_renders_range`  (lines 268–291)

```
async fn format_exec_policy_error_with_source_renders_range()
```

**Purpose**: Verifies parse errors are formatted with file and line information suitable for display.

**Data flow**: Creates a broken `.rules` file, calls `load_exec_policy` expecting a parse error, formats it with `format_exec_policy_error_with_source`, and asserts the rendered string mentions `broken.rules:1:` and `on or around line 1`.

**Call relations**: Exercises the parse-error formatting path that combines parser output with source-location extraction.

*Call graph*: calls 1 internal fn (config_stack_for_dot_codex_folder); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `parse_starlark_line_from_message_extracts_path_and_line`  (lines 294–302)

```
fn parse_starlark_line_from_message_extracts_path_and_line()
```

**Purpose**: Checks that textual Starlark error messages are parsed into `(PathBuf, line)` correctly.

**Data flow**: Passes a synthetic parser message string into `parse_starlark_line_from_message`, unwraps the result, and asserts the path and line number match expectations.

**Call relations**: Directly tests the fallback location parser used by formatted error rendering.

*Call graph*: 1 external calls (assert_eq!).


##### `parse_starlark_line_from_message_rejects_zero_line`  (lines 305–310)

```
fn parse_starlark_line_from_message_rejects_zero_line()
```

**Purpose**: Ensures line number `0` is treated as invalid and yields no parsed location.

**Data flow**: Calls `parse_starlark_line_from_message` with a message containing line `0` and asserts the result is `None`.

**Call relations**: Covers the parser’s explicit invalid-line guard.

*Call graph*: 1 external calls (assert_eq!).


##### `loads_policies_from_policy_subdirectory`  (lines 313–340)

```
async fn loads_policies_from_policy_subdirectory()
```

**Purpose**: Verifies `.rules` files under `rules/` are discovered and parsed into active policy rules.

**Data flow**: Creates a temp config stack and `rules/deny.rules` file containing a forbidden `rm` prefix rule, loads policy, evaluates `rm`, and asserts the result is a `PrefixRuleMatch` with `Decision::Forbidden`.

**Call relations**: Exercises the normal file-discovery and parsing path through `load_exec_policy`.

*Call graph*: calls 1 internal fn (config_stack_for_dot_codex_folder); 5 external calls (assert_eq!, create_dir_all, write, tempdir, vec!).


##### `merges_requirements_exec_policy_network_rules`  (lines 343–375)

```
async fn merges_requirements_exec_policy_network_rules() -> anyhow::Result<()>
```

**Purpose**: Checks that requirements-overlay network rules are merged into the loaded policy even without file-based rules.

**Data flow**: Builds a requirements policy containing a forbidden HTTPS rule for `blocked.example.com`, constructs a config stack with that requirements overlay, loads policy, reads `compiled_network_domains()`, and asserts the denied domain list contains the host.

**Call relations**: Targets the final overlay merge in `load_exec_policy`.

*Call graph*: calls 5 internal fn (new, new, new, new, from_absolute_path); 9 external calls (default, Table, default, assert!, assert_eq!, default, empty, tempdir, vec!).


##### `preserves_host_executables_when_requirements_overlay_is_present`  (lines 378–427)

```
async fn preserves_host_executables_when_requirements_overlay_is_present() -> anyhow::Result<()>
```

**Purpose**: Verifies that merging a requirements overlay does not discard host executable mappings loaded from files.

**Data flow**: Creates a `host.rules` file defining `host_executable(name = "git", paths = [...])`, builds a requirements overlay with a network rule, loads policy, and asserts `policy.host_executables()["git"]` still contains the configured absolute path.

**Call relations**: Exercises the interaction between file-parsed policy state and requirements overlay merging.

*Call graph*: calls 7 internal fn (new, new, new, new, host_absolute_path, starlark_string, from_absolute_path); 11 external calls (default, Table, default, assert_eq!, default, empty, format!, create_dir_all, write, tempdir (+1 more)).


##### `ignores_policies_outside_policy_dir`  (lines 430–453)

```
async fn ignores_policies_outside_policy_dir()
```

**Purpose**: Checks that `.rules` files outside the `rules/` subdirectory are ignored.

**Data flow**: Writes `root.rules` at the config root instead of under `rules/`, loads policy, evaluates `ls` with an allow fallback, and asserts the result remains a heuristic allow.

**Call relations**: Validates that `load_exec_policy` only scans `rules/` directories discovered via `collect_policy_files`.

*Call graph*: calls 1 internal fn (config_stack_for_dot_codex_folder); 4 external calls (assert_eq!, write, tempdir, vec!).


##### `ignores_policy_files_when_config_stack_disables_exec_policy_rules`  (lines 456–480)

```
async fn ignores_policy_files_when_config_stack_disables_exec_policy_rules()
```

**Purpose**: Verifies user/project policy files are skipped when the config stack is configured to ignore them.

**Data flow**: Creates a project `rules/allow.rules`, marks the config stack with `with_user_and_project_exec_policy_rules_ignored(true)`, loads policy, evaluates `curl` with a forbidden fallback, and asserts the decision stays forbidden.

**Call relations**: Exercises the layer-skipping branch in `load_exec_policy`.

*Call graph*: calls 1 internal fn (config_stack_for_dot_codex_folder); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `ignore_user_project_rules_keeps_system_policy_files`  (lines 483–520)

```
async fn ignore_user_project_rules_keeps_system_policy_files()
```

**Purpose**: Checks that ignoring user/project rules does not suppress system-layer policy files.

**Data flow**: Creates a synthetic system config layer with `rules/allow.rules`, builds a stack with `ignore_user_and_project_exec_policy_rules` enabled, loads policy, evaluates `curl` with a forbidden fallback, and asserts the decision becomes allow.

**Call relations**: Tests the selective nature of the ignore flag inside `load_exec_policy`.

*Call graph*: calls 3 internal fn (new, new, from_absolute_path); 9 external calls (default, Table, default, assert_eq!, default, create_dir_all, write, tempdir, vec!).


##### `ignores_rules_from_untrusted_project_layers`  (lines 523–559)

```
async fn ignores_rules_from_untrusted_project_layers() -> anyhow::Result<()>
```

**Purpose**: Verifies disabled/untrusted project layers do not contribute exec-policy rules.

**Data flow**: Creates a project `rules/untrusted.rules`, wraps it in a disabled `ConfigLayerEntry`, loads policy, evaluates `ls` with an allow fallback, and asserts the result is still heuristic allow.

**Call relations**: Exercises the `include_disabled = false` layer iteration used by policy loading.

*Call graph*: calls 2 internal fn (new, from_absolute_path); 7 external calls (default, assert_eq!, default, create_dir_all, write, tempdir, vec!).


##### `loads_policies_from_multiple_config_layers`  (lines 562–631)

```
async fn loads_policies_from_multiple_config_layers() -> anyhow::Result<()>
```

**Purpose**: Checks that rules from multiple config layers are all loaded and remain independently effective.

**Data flow**: Creates separate user and project `rules/` directories with different prefix rules, builds a two-layer stack, loads policy, evaluates `rm` and `ls`, and asserts each command matches the expected rule from its respective layer.

**Call relations**: Validates multi-layer discovery and precedence-aware accumulation in `load_exec_policy`.

*Call graph*: calls 2 internal fn (new, from_absolute_path); 7 external calls (default, assert_eq!, default, create_dir_all, write, tempdir, vec!).


##### `evaluates_bash_lc_inner_commands`  (lines 634–653)

```
async fn evaluates_bash_lc_inner_commands()
```

**Purpose**: Verifies exec-policy evaluates the inner command of a `bash -lc` wrapper rather than the wrapper argv itself.

**Data flow**: Builds a scenario with a forbidden `rm` rule and a `bash -lc 'rm -rf ...'` command, runs `assert_exec_approval_requirement_for_command`, and expects a forbidden requirement whose reason references the original wrapped command.

**Call relations**: Exercises shell-wrapper lowering through `commands_for_exec_policy` and reason rendering through `derive_forbidden_reason`.

*Call graph*: calls 1 internal fn (assert_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `commands_for_exec_policy_falls_back_for_empty_shell_script`  (lines 656–667)

```
fn commands_for_exec_policy_falls_back_for_empty_shell_script()
```

**Purpose**: Checks that an empty `bash -lc` script is not lowered into an empty inner command list and instead falls back to the original argv.

**Data flow**: Constructs `bash -lc ""`, calls `commands_for_exec_policy`, and asserts the returned `ExecPolicyCommands` contains the original command, `used_complex_parsing: false`, and `Generic` origin.

**Call relations**: Directly tests a fallback branch in command normalization.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `commands_for_exec_policy_falls_back_for_whitespace_shell_script`  (lines 670–685)

```
fn commands_for_exec_policy_falls_back_for_whitespace_shell_script()
```

**Purpose**: Checks that whitespace-only shell scripts also fall back to the original argv rather than producing empty parsed commands.

**Data flow**: Constructs `bash -lc` with whitespace script text, calls `commands_for_exec_policy`, and asserts the same fallback structure as the empty-script case.

**Call relations**: Complements the empty-script fallback test for another degenerate shell-wrapper input.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `ignore_user_config_keeps_user_policy_files`  (lines 688–724)

```
async fn ignore_user_config_keeps_user_policy_files() -> std::io::Result<()>
```

**Purpose**: Verifies that ignoring user config parsing does not suppress user policy files under the Codex home directory.

**Data flow**: Creates a Codex home with an invalid `config.toml` and a valid `rules/deny-curl.rules`, builds a config with `LoaderOverrides { ignore_user_config: true }`, loads policy, evaluates `curl` with an allow fallback, and asserts the decision is forbidden.

**Call relations**: Tests separation between config-file parsing and policy-file loading.

*Call graph*: 6 external calls (default, assert_eq!, default, create_dir_all, write, tempdir).


##### `evaluates_heredoc_script_against_prefix_rules`  (lines 727–749)

```
async fn evaluates_heredoc_script_against_prefix_rules()
```

**Purpose**: Checks that heredoc shell scripts can still match prefix rules via fallback parsing. This preserves existing allow/prompt/forbidden behavior for heredoc wrappers.

**Data flow**: Builds a scenario with `bash -lc` heredoc invoking `python3`, a policy allowing `python3`, and read-only permissions; asserts the resulting requirement is `Skip { bypass_sandbox: true, proposed_execpolicy_amendment: None }`.

**Call relations**: Exercises the `parse_shell_lc_single_command_prefix` fallback path and the rule-matching logic that still applies to heredoc commands.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `omits_auto_amendment_for_heredoc_fallback_prompts`  (lines 752–772)

```
async fn omits_auto_amendment_for_heredoc_fallback_prompts()
```

**Purpose**: Verifies automatic amendment suggestions are suppressed when command parsing used the complex heredoc fallback path.

**Data flow**: Builds a heredoc `python3` scenario with no policy and `AskForApproval::UnlessTrusted`, runs the approval helper, and asserts the result is `NeedsApproval` with no proposed amendment.

**Call relations**: Targets the `auto_amendment_allowed = !used_complex_parsing` guard in approval-requirement construction.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `drops_requested_amendment_for_heredoc_fallback_prompts_when_it_wont_match`  (lines 775–799)

```
async fn drops_requested_amendment_for_heredoc_fallback_prompts_when_it_wont_match()
```

**Purpose**: Checks that even a caller-supplied prefix rule is discarded for heredoc fallback prompts when auto-amendment is disabled.

**Data flow**: Builds the same heredoc prompt scenario but supplies a nonmatching requested prefix rule (`python3 -m pip`), runs the helper, and asserts no amendment is proposed.

**Call relations**: Exercises the interaction between complex parsing and requested amendment suppression.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `drops_requested_amendment_for_heredoc_fallback_prompts_when_it_matches`  (lines 802–822)

```
async fn drops_requested_amendment_for_heredoc_fallback_prompts_when_it_matches()
```

**Purpose**: Checks that a matching requested prefix rule is still suppressed when heredoc fallback parsing was used.

**Data flow**: Builds the heredoc prompt scenario with requested prefix `python3`, runs the helper, and asserts the result remains `NeedsApproval` with no amendment.

**Call relations**: Confirms that complex parsing disables all auto-derived amendments, not just ineffective ones.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `heredoc_with_variable_assignment_is_not_reduced_to_allowed_prefix`  (lines 826–850)

```
async fn heredoc_with_variable_assignment_is_not_reduced_to_allowed_prefix()
```

**Purpose**: Verifies heredoc commands with leading variable assignments are not simplified down to an allowed inner prefix in a way that would incorrectly bypass sandbox.

**Data flow**: On non-Windows, builds a heredoc command `PATH=/tmp/evil:$PATH cat <<EOF ...`, supplies a policy allowing `cat`, runs the helper, and asserts the result is `Skip` without sandbox bypass but with an amendment for the full original wrapper command.

**Call relations**: Exercises conservative fallback behavior for complex shell syntax where reducing to a simple prefix would be unsafe.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `heredoc_redirect_without_escalation_runs_inside_sandbox`  (lines 853–883)

```
async fn heredoc_redirect_without_escalation_runs_inside_sandbox()
```

**Purpose**: Checks that a heredoc redirect requiring no sandbox escalation is allowed to run inside the sandbox and may still produce an amendment suggestion.

**Data flow**: Builds a `zsh -lc` heredoc redirect command under workspace-write permissions with default sandbox permissions, runs the helper, and asserts `Skip { bypass_sandbox: false, proposed_execpolicy_amendment: Some(full wrapper command) }`.

**Call relations**: Covers the branch where heuristics allow execution but no explicit policy allow exists to justify sandbox bypass.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, workspace_write); 2 external calls (new, vec!).


##### `heredoc_redirect_with_escalation_requires_approval`  (lines 886–916)

```
async fn heredoc_redirect_with_escalation_requires_approval()
```

**Purpose**: Checks that the same heredoc redirect requires approval when sandbox escalation is explicitly requested.

**Data flow**: Uses the same command and permissions as the previous test but sets `SandboxPermissions::RequireEscalated`, runs the helper, and asserts `NeedsApproval` with an amendment for the full wrapper command.

**Call relations**: Exercises the escalation-sensitive branch in unmatched-command fallback logic.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, workspace_write); 2 external calls (new, vec!).


##### `justification_is_included_in_forbidden_exec_approval_requirement`  (lines 919–947)

```
async fn justification_is_included_in_forbidden_exec_approval_requirement()
```

**Purpose**: Verifies user-authored rule justifications are surfaced in forbidden-command reasons.

**Data flow**: Builds a policy source with a forbidden `rm` rule carrying `justification="destructive command"`, runs the helper on `rm -rf ...`, and asserts the forbidden reason includes that justification.

**Call relations**: Exercises `derive_forbidden_reason`’s justification path.

*Call graph*: calls 1 internal fn (assert_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `exec_approval_requirement_prefers_execpolicy_match`  (lines 950–966)

```
async fn exec_approval_requirement_prefers_execpolicy_match()
```

**Purpose**: Checks that an explicit policy prompt takes precedence over heuristic reasoning and yields a policy-specific approval reason.

**Data flow**: Builds a prompt rule for `rm`, runs the helper on `rm`, and asserts the result is `NeedsApproval` with reason `` `rm` requires approval by policy `` and no amendment.

**Call relations**: Exercises explicit-rule precedence and `derive_prompt_reason`.

*Call graph*: calls 1 internal fn (assert_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `absolute_path_exec_approval_requirement_matches_host_executable_rules`  (lines 969–993)

```
async fn absolute_path_exec_approval_requirement_matches_host_executable_rules()
```

**Purpose**: Verifies absolute executable paths can match host-executable aliases and then satisfy prefix rules written against the logical executable name.

**Data flow**: Builds a policy defining `host_executable(name="git", paths=[abs_path])` plus `prefix_rule(pattern=["git"], decision="allow")`, runs the helper on `[abs_path, "status"]`, and asserts sandbox bypass is true with no amendment.

**Call relations**: Exercises host-executable resolution during policy matching.

*Call graph*: calls 4 internal fn (assert_exec_approval_requirement_for_command, host_program_path, starlark_string, read_only); 2 external calls (format!, vec!).


##### `absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths`  (lines 996–1029)

```
async fn absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths()
```

**Purpose**: Checks that absolute paths not listed in `host_executable` mappings do not inherit the alias’s policy rule.

**Data flow**: Builds a policy allowing logical `git` only for one absolute path, runs the helper on a different absolute git path, and asserts execution is allowed only heuristically with no sandbox bypass and an amendment for the full absolute-path command.

**Call relations**: Validates that host-executable aliasing is path-restricted rather than name-only.

*Call graph*: calls 5 internal fn (assert_exec_approval_requirement_for_command, host_absolute_path, host_program_path, starlark_string, read_only); 4 external calls (new, cfg!, format!, vec!).


##### `requested_prefix_rule_can_approve_absolute_path_commands`  (lines 1032–1055)

```
async fn requested_prefix_rule_can_approve_absolute_path_commands()
```

**Purpose**: Verifies a caller-supplied prefix rule can be proposed even when the actual command uses an absolute executable path, as long as the prefix would approve the parsed command.

**Data flow**: Builds a no-policy scenario for an absolute `cargo install cargo-insta` command with requested prefix `["cargo", "install"]`, runs the helper, and asserts `NeedsApproval` with that prefix as the proposed amendment.

**Call relations**: Exercises requested amendment derivation together with host executable resolution.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `exec_approval_requirement_respects_approval_policy`  (lines 1058–1073)

```
async fn exec_approval_requirement_respects_approval_policy()
```

**Purpose**: Checks that a policy prompt becomes a hard rejection when `AskForApproval::Never` forbids surfacing prompts.

**Data flow**: Builds a prompt rule for `rm`, runs the helper with `AskForApproval::Never`, and asserts the result is `Forbidden` with `PROMPT_CONFLICT_REASON`.

**Call relations**: Exercises `prompt_is_rejected_by_policy` in the rule-prompt case.

*Call graph*: calls 1 internal fn (assert_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `unmatched_granular_policy_still_prompts_for_restricted_sandbox_escalation`  (lines 1076–1099)

```
fn unmatched_granular_policy_still_prompts_for_restricted_sandbox_escalation()
```

**Purpose**: Verifies unmatched commands still prompt under granular approval when sandbox escalation is requested and granular sandbox approval is enabled.

**Data flow**: Calls `render_decision_for_unmatched_command` on a made-up command with granular approval config, read-only permissions, disabled Windows sandbox backend, and `RequireEscalated`; asserts the decision is `Prompt`.

**Call relations**: Directly tests unmatched-command fallback logic for granular approval plus restricted sandbox escalation.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `unmatched_on_request_uses_permission_profile_file_system_policy_for_escalation_prompts`  (lines 1102–1119)

```
fn unmatched_on_request_uses_permission_profile_file_system_policy_for_escalation_prompts()
```

**Purpose**: Checks that `AskForApproval::OnRequest` prompts for unmatched commands when the permission profile is restricted and escalation is requested.

**Data flow**: Calls `render_decision_for_unmatched_command` with a made-up command, read-only profile, disabled Windows sandbox backend, and `RequireEscalated`; asserts `Decision::Prompt`.

**Call relations**: Directly exercises the `OnRequest` restricted-sandbox branch in fallback logic.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `known_safe_on_request_still_prompts_for_restricted_sandbox_escalation`  (lines 1122–1139)

```
fn known_safe_on_request_still_prompts_for_restricted_sandbox_escalation()
```

**Purpose**: Verifies even known-safe commands prompt under `OnRequest` when they request sandbox escalation in a restricted sandbox.

**Data flow**: Calls `render_decision_for_unmatched_command` on `echo hello` with workspace-write permissions, restricted-token Windows level, and `RequireEscalated`; asserts `Decision::Prompt`.

**Call relations**: Confirms that sandbox-escalation prompting is independent of command safelist status.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `managed_cwd_write_profile_has_filesystem_restrictions`  (lines 1142–1165)

```
fn managed_cwd_write_profile_has_filesystem_restrictions()
```

**Purpose**: Checks that a managed restricted profile with root read and project-root write counts as having managed filesystem restrictions.

**Data flow**: Builds a restricted `FileSystemSandboxPolicy`, converts it to a `PermissionProfile`, calls `profile_has_managed_filesystem_restrictions`, and asserts true.

**Call relations**: Directly tests the helper used by Windows conservative fallback logic.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 2 external calls (assert!, vec!).


##### `managed_unresolvable_write_profile_has_filesystem_restrictions`  (lines 1168–1194)

```
fn managed_unresolvable_write_profile_has_filesystem_restrictions()
```

**Purpose**: Checks that a managed restricted profile with an unknown writable special path still counts as having filesystem restrictions.

**Data flow**: Builds a restricted policy with root read and an unknown special-path write carveout, converts it to a `PermissionProfile`, calls the helper, and asserts true.

**Call relations**: Covers another positive branch of `profile_has_managed_filesystem_restrictions`.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 2 external calls (assert!, vec!).


##### `managed_full_disk_write_profile_has_no_filesystem_restrictions`  (lines 1197–1213)

```
fn managed_full_disk_write_profile_has_no_filesystem_restrictions()
```

**Purpose**: Verifies a managed restricted profile that effectively grants root write is treated as lacking meaningful filesystem restrictions.

**Data flow**: Builds a restricted policy with root write, converts it to a `PermissionProfile`, calls the helper, and asserts false.

**Call relations**: Covers the helper’s negative branch when full-disk write access is present.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 2 external calls (assert!, vec!).


##### `exec_approval_requirement_prompts_for_inline_additional_permissions_under_on_request`  (lines 1216–1239)

```
async fn exec_approval_requirement_prompts_for_inline_additional_permissions_under_on_request()
```

**Purpose**: Checks that requesting additional inline permissions under `OnRequest` causes an approval requirement even for otherwise ordinary commands.

**Data flow**: Builds a `zsh -lc touch ...` scenario with read-only permissions and `SandboxPermissions::WithAdditionalPermissions`, runs the helper, and asserts `NeedsApproval` with an amendment for the parsed inner `touch` command.

**Call relations**: Exercises the escalation/request-permissions path in unmatched-command fallback and amendment derivation.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `exec_approval_requirement_prompts_for_known_safe_escalation_under_on_request`  (lines 1242–1261)

```
async fn exec_approval_requirement_prompts_for_known_safe_escalation_under_on_request()
```

**Purpose**: Verifies a known-safe command still requires approval when it explicitly requests sandbox escalation under `OnRequest`.

**Data flow**: Runs the helper on `echo hello` with workspace-write permissions and `RequireEscalated`, asserting `NeedsApproval` with an amendment for `echo hello`.

**Call relations**: Covers the same escalation branch through the full approval-requirement pipeline.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, workspace_write); 2 external calls (new, vec!).


##### `exec_approval_requirement_rejects_known_safe_escalation_when_granular_sandbox_is_disabled`  (lines 1264–1286)

```
async fn exec_approval_requirement_rejects_known_safe_escalation_when_granular_sandbox_is_disabled()
```

**Purpose**: Checks that sandbox-escalation prompts are converted into hard rejections when granular sandbox approval is disabled.

**Data flow**: Runs the helper on `echo hello` with granular approval config where `sandbox_approval: false`, workspace-write permissions, and `RequireEscalated`; asserts `Forbidden` with `REJECT_SANDBOX_APPROVAL_REASON`.

**Call relations**: Exercises `prompt_is_rejected_by_policy` for sandbox-driven prompts.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, workspace_write); 2 external calls (Granular, vec!).


##### `exec_approval_requirement_rejects_unmatched_sandbox_escalation_when_granular_sandbox_is_disabled`  (lines 1289–1311)

```
async fn exec_approval_requirement_rejects_unmatched_sandbox_escalation_when_granular_sandbox_is_disabled()
```

**Purpose**: Verifies the same granular rejection behavior applies to unmatched commands, not just known-safe ones.

**Data flow**: Runs the helper on a made-up command with granular sandbox approval disabled and `RequireEscalated`; asserts `Forbidden` with the sandbox rejection reason.

**Call relations**: Confirms prompt rejection is based on prompt type, not command classification.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (Granular, vec!).


##### `mixed_rule_and_sandbox_prompt_prioritizes_rule_for_rejection_decision`  (lines 1314–1348)

```
async fn mixed_rule_and_sandbox_prompt_prioritizes_rule_for_rejection_decision()
```

**Purpose**: Checks that when both a policy rule and sandbox escalation would prompt, the system treats the prompt as rule-driven for granular approval purposes.

**Data flow**: Builds a policy prompting on `git`, creates a manager from it, evaluates `bash -lc 'git status && madeup-cmd'` with granular approvals enabled and `RequireEscalated`, and asserts the result is still `NeedsApproval`.

**Call relations**: Exercises the `prompt_is_rule` detection logic inside `create_exec_approval_requirement_for_command`.

*Call graph*: calls 3 internal fn (new, new, read_only); 4 external calls (new, Granular, assert!, vec!).


##### `mixed_rule_and_sandbox_prompt_rejects_when_granular_rules_are_disabled`  (lines 1351–1387)

```
async fn mixed_rule_and_sandbox_prompt_rejects_when_granular_rules_are_disabled()
```

**Purpose**: Verifies that in the mixed prompt case, disabling granular rule approval causes rejection even if sandbox approval remains enabled.

**Data flow**: Builds the same mixed command and policy as the previous test but with `rules: false`, evaluates it, and asserts `Forbidden` with `REJECT_RULES_APPROVAL_REASON`.

**Call relations**: Confirms rule prompts take precedence over sandbox prompts when deciding granular rejection.

*Call graph*: calls 3 internal fn (new, new, read_only); 4 external calls (new, Granular, assert_eq!, vec!).


##### `exec_approval_requirement_falls_back_to_heuristics`  (lines 1390–1412)

```
async fn exec_approval_requirement_falls_back_to_heuristics()
```

**Purpose**: Checks that with an empty policy, command approval comes entirely from heuristics and can produce an amendment suggestion.

**Data flow**: Creates a default manager, evaluates `cargo build` under `UnlessTrusted` and read-only permissions, and asserts `NeedsApproval` with no reason and an amendment for the command.

**Call relations**: Exercises the no-policy path through `create_exec_approval_requirement_for_command`.

*Call graph*: calls 2 internal fn (default, read_only); 2 external calls (assert_eq!, vec!).


##### `empty_bash_lc_script_falls_back_to_original_command`  (lines 1415–1437)

```
async fn empty_bash_lc_script_falls_back_to_original_command()
```

**Purpose**: Verifies empty shell-wrapper scripts produce amendments for the original wrapper argv rather than an empty inner command.

**Data flow**: Creates a default manager, evaluates `bash -lc ""`, and asserts `NeedsApproval` with an amendment equal to the original command vector.

**Call relations**: Combines command-normalization fallback with heuristic amendment derivation.

*Call graph*: calls 2 internal fn (default, read_only); 2 external calls (assert_eq!, vec!).


##### `whitespace_bash_lc_script_falls_back_to_original_command`  (lines 1440–1466)

```
async fn whitespace_bash_lc_script_falls_back_to_original_command()
```

**Purpose**: Verifies whitespace-only shell-wrapper scripts behave the same as empty scripts for amendment derivation.

**Data flow**: Creates a default manager, evaluates `bash -lc` with whitespace script text, and asserts `NeedsApproval` with an amendment equal to the original command vector.

**Call relations**: Complements the empty-script fallback test through the full approval pipeline.

*Call graph*: calls 2 internal fn (default, read_only); 2 external calls (assert_eq!, vec!).


##### `request_rule_uses_prefix_rule`  (lines 1469–1498)

```
async fn request_rule_uses_prefix_rule()
```

**Purpose**: Checks that a caller-supplied prefix rule is used as the proposed amendment when it would approve the command.

**Data flow**: Creates a default manager, evaluates `cargo install cargo-insta` under `OnRequest` with `RequireEscalated` and requested prefix `["cargo", "install"]`, and asserts `NeedsApproval` with that prefix as the amendment.

**Call relations**: Exercises `derive_requested_execpolicy_amendment_from_prefix_rule`’s positive path.

*Call graph*: calls 2 internal fn (default, read_only); 2 external calls (assert_eq!, vec!).


##### `request_rule_falls_back_when_prefix_rule_does_not_approve_all_commands`  (lines 1501–1531)

```
async fn request_rule_falls_back_when_prefix_rule_does_not_approve_all_commands()
```

**Purpose**: Verifies a requested prefix rule is discarded when it would not approve every parsed command segment in a multi-command shell script.

**Data flow**: Creates a default manager, evaluates `bash -lc 'cargo install cargo-insta && rm -rf /tmp/codex'` with requested prefix `["cargo", "install"]`, and asserts the amendment falls back to the heuristic prompt command `rm -rf /tmp/codex`.

**Call relations**: Exercises `prefix_rule_would_approve_all_commands` and the fallback amendment path.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert_eq!, vec!).


##### `heuristics_apply_when_other_commands_match_policy`  (lines 1534–1565)

```
async fn heuristics_apply_when_other_commands_match_policy()
```

**Purpose**: Checks that heuristic evaluation still applies to unmatched segments even when another segment in the same shell script matches policy.

**Data flow**: Builds a policy allowing `apple`, evaluates `bash -lc 'apple | orange'` under `UnlessTrusted`, and asserts `NeedsApproval` with an amendment for the unmatched `orange` segment.

**Call relations**: Exercises mixed policy/heuristic evaluation across multiple parsed command segments.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, vec!).


##### `append_execpolicy_amendment_updates_policy_and_file`  (lines 1568–1598)

```
async fn append_execpolicy_amendment_updates_policy_and_file()
```

**Purpose**: Verifies appending an amendment writes the expected rule text to disk and updates the in-memory policy immediately.

**Data flow**: Creates a temp Codex home and default manager, appends an amendment for `echo hello`, reads `manager.current()` and checks that `echo hello world` now evaluates to allow, then reads `default.rules` from disk and asserts its exact contents.

**Call relations**: Exercises `append_amendment_and_update` end to end, including file persistence and in-memory replacement.

*Call graph*: calls 2 internal fn (from, default); 5 external calls (assert!, assert_eq!, read_to_string, tempdir, vec!).


##### `append_execpolicy_amendment_rejects_empty_prefix`  (lines 1601–1616)

```
async fn append_execpolicy_amendment_rejects_empty_prefix()
```

**Purpose**: Checks that attempting to append an empty prefix amendment fails with the expected structured error.

**Data flow**: Creates a temp Codex home and default manager, calls `append_amendment_and_update` with an empty amendment, and asserts the result matches `ExecPolicyUpdateError::AppendRule { source: AmendError::EmptyPrefix, .. }`.

**Call relations**: Exercises error propagation from the blocking append helper through the update API.

*Call graph*: calls 2 internal fn (from, default); 3 external calls (assert!, tempdir, vec!).


##### `proposed_execpolicy_amendment_is_present_for_single_command_without_policy_match`  (lines 1619–1637)

```
async fn proposed_execpolicy_amendment_is_present_for_single_command_without_policy_match()
```

**Purpose**: Verifies a single unmatched command under `UnlessTrusted` yields a proposed amendment for that command.

**Data flow**: Builds a no-policy scenario for `cargo build`, runs the helper, and asserts `NeedsApproval` with `Some(ExecPolicyAmendment::new(command))`.

**Call relations**: Covers the basic heuristic prompt amendment path.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `proposed_execpolicy_amendment_is_omitted_when_policy_prompts`  (lines 1640–1656)

```
async fn proposed_execpolicy_amendment_is_omitted_when_policy_prompts()
```

**Purpose**: Checks that explicit policy prompt rules suppress amendment suggestions.

**Data flow**: Builds a prompt rule for `rm`, runs the helper on `rm`, and asserts `NeedsApproval` with a policy reason and `proposed_execpolicy_amendment: None`.

**Call relations**: Exercises `try_derive_execpolicy_amendment_for_prompt_rules`’s policy-match suppression.

*Call graph*: calls 1 internal fn (assert_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `proposed_execpolicy_amendment_is_present_for_multi_command_scripts`  (lines 1659–1682)

```
async fn proposed_execpolicy_amendment_is_present_for_multi_command_scripts()
```

**Purpose**: Verifies multi-command shell scripts propose an amendment for the first unmatched prompting segment.

**Data flow**: Builds a no-policy scenario for `bash -lc 'cargo build && echo ok'`, runs the helper, and asserts `NeedsApproval` with an amendment for `cargo build`.

**Call relations**: Exercises parsed multi-command evaluation and first-match amendment selection.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `proposed_execpolicy_amendment_uses_first_no_match_in_multi_command_scripts`  (lines 1685–1710)

```
async fn proposed_execpolicy_amendment_uses_first_no_match_in_multi_command_scripts()
```

**Purpose**: Checks that when earlier segments are explicitly allowed by policy, the amendment targets the first later segment with no policy match.

**Data flow**: Builds a policy allowing `cat`, evaluates `bash -lc 'cat && apple'`, and asserts `NeedsApproval` with an amendment for `apple`.

**Call relations**: Exercises mixed explicit/heuristic matching in amendment derivation.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `proposed_execpolicy_amendment_is_present_when_heuristics_allow`  (lines 1713–1731)

```
async fn proposed_execpolicy_amendment_is_present_when_heuristics_allow()
```

**Purpose**: Verifies heuristic allow outcomes can still carry a proposed amendment for future sandbox bypass.

**Data flow**: Builds a no-policy scenario for `echo safe` under `OnRequest`, runs the helper, and asserts `Skip { bypass_sandbox: false, proposed_execpolicy_amendment: Some(command) }`.

**Call relations**: Exercises `try_derive_execpolicy_amendment_for_allow_rules`.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `proposed_execpolicy_amendment_is_suppressed_when_policy_matches_allow`  (lines 1734–1754)

```
async fn proposed_execpolicy_amendment_is_suppressed_when_policy_matches_allow()
```

**Purpose**: Checks that explicit allow rules suppress heuristic amendment suggestions and can justify sandbox bypass.

**Data flow**: Builds a policy allowing `python3`, evaluates `python3 -c 'print(1)'`, and asserts `Skip { bypass_sandbox: true, proposed_execpolicy_amendment: None }`.

**Call relations**: Exercises explicit allow precedence and bypass-sandbox computation.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `multi_segment_shell_requires_policy_allow_for_every_segment_to_bypass_sandbox`  (lines 1757–1785)

```
async fn multi_segment_shell_requires_policy_allow_for_every_segment_to_bypass_sandbox()
```

**Purpose**: Verifies sandbox bypass is denied unless every parsed segment in a shell script is explicitly allowed by policy.

**Data flow**: Builds a policy allowing only `cat`, evaluates a multi-segment shell script containing `cat`, `curl`, and `bash`, and for two approval policies asserts `Skip { bypass_sandbox: false, proposed_execpolicy_amendment: None }`.

**Call relations**: Targets the `commands.iter().all(...)` bypass-sandbox check in approval-requirement construction.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, workspace_write); 1 external calls (vec!).


##### `multi_segment_shell_bypasses_sandbox_when_every_segment_matches_policy_allow`  (lines 1788–1815)

```
async fn multi_segment_shell_bypasses_sandbox_when_every_segment_matches_policy_allow()
```

**Purpose**: Checks that sandbox bypass becomes true when every parsed shell segment has an explicit allow rule.

**Data flow**: Builds a policy allowing `cat`, `curl`, and `bash`, evaluates the same multi-segment shell script, and asserts `Skip { bypass_sandbox: true, proposed_execpolicy_amendment: None }`.

**Call relations**: Covers the positive branch of the all-segments-explicitly-allowed bypass rule.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `derive_requested_execpolicy_amendment_for_test`  (lines 1817–1833)

```
fn derive_requested_execpolicy_amendment_for_test(
    prefix_rule: Option<&Vec<String>>,
    matched_rules: &[RuleMatch],
) -> Option<ExecPolicyAmendment>
```

**Purpose**: Provides a compact harness for testing requested-prefix amendment derivation in isolation.

**Data flow**: Reads optional `prefix_rule` and `matched_rules`, synthesizes a `commands` vector from the prefix or a default `echo`, calls `derive_requested_execpolicy_amendment_from_prefix_rule` with an empty policy, allow fallback, and default match options, and returns the result.

**Call relations**: Used by the following focused unit tests for banned prefixes, missing prefixes, and policy-match suppression.

*Call graph*: 2 external calls (empty, default).


##### `derive_requested_execpolicy_amendment_returns_none_for_missing_prefix_rule`  (lines 1836–1841)

```
fn derive_requested_execpolicy_amendment_returns_none_for_missing_prefix_rule()
```

**Purpose**: Checks that no amendment is proposed when no requested prefix rule is supplied.

**Data flow**: Calls the local harness with `None` and empty matches, and asserts the result is `None`.

**Call relations**: Exercises the earliest return in requested amendment derivation.

*Call graph*: 1 external calls (assert_eq!).


##### `derive_requested_execpolicy_amendment_returns_none_for_empty_prefix_rule`  (lines 1844–1849)

```
fn derive_requested_execpolicy_amendment_returns_none_for_empty_prefix_rule()
```

**Purpose**: Checks that an empty requested prefix is rejected.

**Data flow**: Calls the harness with `Some(&Vec::new())` and empty matches, and asserts `None`.

**Call relations**: Covers the empty-prefix guard in requested amendment derivation.

*Call graph*: 1 external calls (assert_eq!).


##### `derive_requested_execpolicy_amendment_returns_none_for_exact_banned_prefix_rule`  (lines 1852–1860)

```
fn derive_requested_execpolicy_amendment_returns_none_for_exact_banned_prefix_rule()
```

**Purpose**: Verifies exact banned broad prefixes like `python -c` are never suggested as amendments.

**Data flow**: Calls the harness with prefix `["python", "-c"]` and asserts the result is `None`.

**Call relations**: Exercises the banned-prefix list check.

*Call graph*: 1 external calls (assert_eq!).


##### `derive_requested_execpolicy_amendment_returns_none_for_windows_and_pypy_variants`  (lines 1863–1877)

```
fn derive_requested_execpolicy_amendment_returns_none_for_windows_and_pypy_variants()
```

**Purpose**: Checks several banned interpreter launcher variants are all rejected as requested amendments.

**Data flow**: Iterates over prefixes such as `py`, `py -3`, `pythonw`, `pyw`, `pypy`, and `pypy3`, calling the harness for each and asserting `None`.

**Call relations**: Expands coverage of the banned-prefix suggestion table.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `derive_requested_execpolicy_amendment_returns_none_for_shell_and_powershell_variants`  (lines 1880–1903)

```
fn derive_requested_execpolicy_amendment_returns_none_for_shell_and_powershell_variants()
```

**Purpose**: Checks shell-wrapper and PowerShell launcher prefixes are rejected as amendment suggestions.

**Data flow**: Iterates over prefixes like `bash -lc`, `sh -c`, `zsh -lc`, `/bin/bash -lc`, `pwsh`, and `powershell.exe -Command`, calling the harness and asserting `None` each time.

**Call relations**: Further validates the banned-prefix list used to avoid overly broad or dangerous suggestions.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `derive_requested_execpolicy_amendment_allows_non_exact_banned_prefix_rule_match`  (lines 1906–1917)

```
fn derive_requested_execpolicy_amendment_allows_non_exact_banned_prefix_rule_match()
```

**Purpose**: Verifies only exact banned prefixes are rejected; longer, more specific prefixes extending them may still be suggested.

**Data flow**: Builds prefix `["python", "-c", "print('hi')"]`, calls the harness, and asserts it returns `Some(ExecPolicyAmendment::new(prefix.clone()))`.

**Call relations**: Covers the exact-match semantics of the banned-prefix filter.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `derive_requested_execpolicy_amendment_returns_none_when_policy_matches`  (lines 1920–1959)

```
fn derive_requested_execpolicy_amendment_returns_none_when_policy_matches()
```

**Purpose**: Checks that any explicit policy match—prompt, allow, or forbidden—suppresses requested amendment suggestions.

**Data flow**: Builds a requested prefix `cargo build`, constructs three different `matched_rules` vectors containing explicit prefix matches with prompt/allow/forbidden decisions, calls the harness for each, and asserts `None` every time.

**Call relations**: Exercises the policy-match suppression branch in requested amendment derivation.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `dangerous_rm_rf_requires_approval_in_danger_full_access`  (lines 1962–1980)

```
async fn dangerous_rm_rf_requires_approval_in_danger_full_access()
```

**Purpose**: Verifies dangerous commands require approval under `OnRequest` when no explicit policy exists and the environment is effectively unsandboxed.

**Data flow**: Builds `rm -rf /tmp/nonexistent` with `vec_str`, runs the helper under `PermissionProfile::Disabled`, and asserts `NeedsApproval` with an amendment for the command.

**Call relations**: Exercises dangerous-command heuristic prompting through the full approval pipeline.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, vec_str); 1 external calls (new).


##### `vec_str`  (lines 1982–1984)

```
fn vec_str(items: &[&str]) -> Vec<String>
```

**Purpose**: Converts a slice of `&str` into `Vec<String>` for concise command construction in tests.

**Data flow**: Reads `items`, maps each item through `ToString::to_string`, collects into `Vec<String>`, and returns it.

**Call relations**: Used by several dangerous-command and PowerShell tests as a small fixture helper.

*Call graph*: called by 4 (dangerous_command_allowed_when_sandbox_is_explicitly_disabled, dangerous_command_forbidden_in_external_sandbox_when_policy_matches, dangerous_rm_rf_requires_approval_in_danger_full_access, verify_approval_requirement_for_unsafe_powershell_command).


##### `verify_approval_requirement_for_unsafe_powershell_command`  (lines 1989–2086)

```
async fn verify_approval_requirement_for_unsafe_powershell_command()
```

**Purpose**: Checks cross-platform behavior for unsafe PowerShell commands and dangerous commands under heuristic fallback. It documents the Windows-specific conservative behavior when no sandbox backend is available.

**Data flow**: Skips early if `pwsh` is unavailable, creates an empty-policy manager, builds a PowerShell command and expected amendment, chooses expected requirement based on `cfg!(windows)`, evaluates the command and asserts equality, then evaluates a dangerous `rm -rf /important/data` command under `OnRequest` and `Never` and asserts the expected approval/forbidden outcomes.

**Call relations**: Exercises PowerShell command-origin handling, dangerous-command heuristics, and the `AskForApproval::Never` forbidden path.

*Call graph*: calls 2 internal fn (new, vec_str); 6 external calls (new, new, assert_eq!, cfg!, empty, which).


##### `dangerous_command_allowed_when_sandbox_is_explicitly_disabled`  (lines 2089–2110)

```
async fn dangerous_command_allowed_when_sandbox_is_explicitly_disabled()
```

**Purpose**: Verifies dangerous commands are allowed under `AskForApproval::Never` when the permission profile explicitly disables sandboxing via `External`.

**Data flow**: Builds `rm -rf /tmp/nonexistent`, runs the helper with `PermissionProfile::External { network: Restricted }`, and asserts `Skip` with no sandbox bypass but with an amendment for the command.

**Call relations**: Exercises the special-case branch in unmatched-command fallback that allows dangerous commands when sandbox disablement is explicit.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, vec_str).


##### `dangerous_command_forbidden_in_external_sandbox_when_policy_matches`  (lines 2113–2131)

```
async fn dangerous_command_forbidden_in_external_sandbox_when_policy_matches()
```

**Purpose**: Checks that explicit policy prompts still force rejection under `AskForApproval::Never` even when the permission profile is `External`.

**Data flow**: Builds a prompt rule for `rm`, runs the helper on `rm -rf /tmp/nonexistent` with `PermissionProfile::External` and `AskForApproval::Never`, and asserts `Forbidden` with `PROMPT_CONFLICT_REASON`.

**Call relations**: Shows that explicit policy matches override the heuristic special case for externally sandboxed profiles.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, vec_str).


##### `policy_from_src`  (lines 2143–2152)

```
fn policy_from_src(policy_src: Option<&str>) -> Arc<Policy>
```

**Purpose**: Parses optional inline policy source into an `Arc<Policy>` for test scenarios. It returns an empty policy when no source is provided.

**Data flow**: Reads `policy_src`; if `Some`, creates a `PolicyParser`, parses the source under identifier `test.rules`, builds the policy, wraps it in `Arc`, and returns it; otherwise returns `Arc::new(Policy::empty())`.

**Call relations**: Used by the scenario-based approval helper to construct test policies without filesystem setup.

*Call graph*: calls 1 internal fn (new); called by 1 (exec_approval_requirement_for_command); 2 external calls (new, empty).


##### `exec_approval_requirement_for_command`  (lines 2154–2178)

```
async fn exec_approval_requirement_for_command(
    test: ExecApprovalRequirementScenario,
) -> ExecApprovalRequirement
```

**Purpose**: Runs a complete approval evaluation for a test scenario and returns the resulting requirement. It centralizes scenario unpacking and manager construction.

**Data flow**: Consumes `ExecApprovalRequirementScenario`, extracts its fields, builds a policy with `policy_from_src`, constructs an `ExecPolicyManager`, calls `create_exec_approval_requirement_for_command` with a fixed `WindowsSandboxLevel::RestrictedToken`, and returns the awaited `ExecApprovalRequirement`.

**Call relations**: This helper underpins many scenario-style tests in the file. It delegates actual decision logic to the production manager method.

*Call graph*: calls 2 internal fn (new, policy_from_src); called by 1 (assert_exec_approval_requirement_for_command).


##### `assert_exec_approval_requirement_for_command`  (lines 2180–2186)

```
async fn assert_exec_approval_requirement_for_command(
    test: ExecApprovalRequirementScenario,
    expected_requirement: ExecApprovalRequirement,
)
```

**Purpose**: Convenience assertion wrapper around the scenario-based approval helper. It keeps tests focused on inputs and expected outputs.

**Data flow**: Reads a test scenario and expected requirement, awaits `exec_approval_requirement_for_command(test)`, and asserts equality with `expected_requirement`.

**Call relations**: Called by many tests that validate exact `ExecApprovalRequirement` values.

*Call graph*: calls 1 internal fn (exec_approval_requirement_for_command); called by 29 (absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths, absolute_path_exec_approval_requirement_matches_host_executable_rules, dangerous_command_allowed_when_sandbox_is_explicitly_disabled, dangerous_command_forbidden_in_external_sandbox_when_policy_matches, dangerous_rm_rf_requires_approval_in_danger_full_access, drops_requested_amendment_for_heredoc_fallback_prompts_when_it_matches, drops_requested_amendment_for_heredoc_fallback_prompts_when_it_wont_match, evaluates_bash_lc_inner_commands, evaluates_heredoc_script_against_prefix_rules, exec_approval_requirement_prefers_execpolicy_match (+15 more)); 1 external calls (assert_eq!).


##### `exec_policies_only_load_from_trusted_project_layers`  (lines 2189–2234)

```
async fn exec_policies_only_load_from_trusted_project_layers() -> std::io::Result<()>
```

**Purpose**: Verifies nested project exec-policy loading respects trust and only includes rules from trusted project layers.

**Data flow**: Creates a Codex home, a project root with `.git`, nested directories, root and nested `.codex/rules` directories containing different forbidden rules, writes trust config marking only the nested project trusted, builds a config rooted in the nested directory, loads policy, and asserts `rm` is allowed while `mv` is forbidden.

**Call relations**: Exercises trust-aware config-layer construction and policy loading across nested project roots.

*Call graph*: calls 1 internal fn (write_project_trust_config); 5 external calls (assert_eq!, default, create_dir_all, write, tempdir).


##### `exec_policies_require_project_trust_without_config_toml`  (lines 2237–2292)

```
async fn exec_policies_require_project_trust_without_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that project exec-policy files are ignored unless the project is explicitly trusted, even when no project `config.toml` exists.

**Data flow**: Creates a git project with a forbidden `rm` rule, iterates over unknown/untrusted/trusted trust configurations written to separate Codex homes, builds configs rooted in a nested directory, loads policy for each, and asserts the resulting decision for `rm` matches the expected trust-dependent outcome.

**Call relations**: Exercises trust gating for project-layer rule loading in several trust states.

*Call graph*: calls 1 internal fn (write_project_trust_config); 8 external calls (new, assert_eq!, default, format!, create_dir_all, write, tempdir, vec!).


##### `exec_policy_warnings_ignore_untrusted_project_rules_without_config_toml`  (lines 2295–2342)

```
async fn exec_policy_warnings_ignore_untrusted_project_rules_without_config_toml() -> std::io::Result<()>
```

**Purpose**: Verifies parse warnings from broken project rules are surfaced only when the project is trusted; untrusted or unknown projects suppress both loading and warnings.

**Data flow**: Creates a git project with a broken `.rules` file, iterates over unknown/untrusted/trusted trust configurations, builds configs rooted in the nested directory, calls `check_execpolicy_for_warnings`, and asserts whether a parse warning is present according to trust.

**Call relations**: Exercises the interaction between trust filtering and warning-only policy loading.

*Call graph*: calls 1 internal fn (write_project_trust_config); 8 external calls (new, assert_eq!, default, format!, create_dir_all, write, tempdir, vec!).


### `core/src/exec_policy_windows_tests.rs`

`test` · `test execution`

This Windows-only companion test module focuses on behavior that differs from Unix-like platforms. Several tests verify that `commands_for_exec_policy` lowers a top-level `powershell.exe ... -Command ...` wrapper into inner PowerShell words, and that explicit prefix rules are applied to those lowered words rather than to the wrapper executable. That means a prompt or allow rule for `echo` can govern `powershell.exe -Command "echo blocked"`.

The remaining tests target unmatched-command heuristics under Windows. They confirm that PowerShell-specific safe-word classification can allow benign commands like `Get-Content Cargo.toml`, while dangerous PowerShell commands such as `Remove-Item ... -Force` require approval and produce amendments for the lowered inner command. The module also captures a key Windows design choice: when the Windows sandbox backend is disabled, even read-only or writable managed policies are treated conservatively because there is no platform sandbox to enforce them. In that case `AskForApproval::Never` yields `Decision::Forbidden`, whereas enabled restricted-token or elevated backends allow unmatched commands to proceed under sandbox protection.

#### Function details

##### `evaluates_powershell_inner_commands_against_prompt_rules`  (lines 5–25)

```
async fn evaluates_powershell_inner_commands_against_prompt_rules()
```

**Purpose**: Verifies a prompt rule written for a lowered PowerShell inner command causes rejection when approval prompts are disabled.

**Data flow**: Builds a scenario with policy source `prefix_rule(pattern=["echo"], decision="prompt")`, a `powershell.exe -NoProfile -Command "echo blocked"` command, `AskForApproval::Never`, and disabled permissions; runs the shared assertion helper and expects `Forbidden` with `PROMPT_CONFLICT_REASON`.

**Call relations**: Uses the scenario helper from the parent test module to exercise PowerShell lowering plus prompt rejection.

*Call graph*: 1 external calls (vec!).


##### `evaluates_powershell_inner_commands_against_allow_rules`  (lines 28–49)

```
async fn evaluates_powershell_inner_commands_against_allow_rules()
```

**Purpose**: Checks that an allow rule for a lowered PowerShell inner command can justify sandbox bypass.

**Data flow**: Builds a scenario with policy source `prefix_rule(pattern=["echo"], decision="allow")`, a PowerShell wrapper command, `UnlessTrusted`, and read-only permissions; asserts the result is `Skip { bypass_sandbox: true, proposed_execpolicy_amendment: None }`.

**Call relations**: Exercises explicit allow matching on lowered PowerShell words through the shared scenario helper.

*Call graph*: calls 1 internal fn (read_only); 1 external calls (vec!).


##### `commands_for_exec_policy_parses_powershell_shell_wrapper`  (lines 52–68)

```
fn commands_for_exec_policy_parses_powershell_shell_wrapper()
```

**Purpose**: Verifies command normalization lowers a PowerShell wrapper into a single inner command with `PowerShell` origin.

**Data flow**: Constructs a `powershell.exe -NoProfile -Command "echo blocked"` argv vector, calls `commands_for_exec_policy`, and asserts the returned `ExecPolicyCommands` contains `[["echo", "blocked"]]`, `used_complex_parsing: false`, and `command_origin: PowerShell`.

**Call relations**: Directly tests the Windows-specific parsing branch in `commands_for_exec_policy`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `unmatched_safe_powershell_words_are_allowed`  (lines 71–88)

```
fn unmatched_safe_powershell_words_are_allowed()
```

**Purpose**: Checks that PowerShell-specific safe-word heuristics allow benign unmatched commands under `UnlessTrusted`.

**Data flow**: Calls `render_decision_for_unmatched_command` on lowered PowerShell words `Get-Content Cargo.toml` with read-only permissions, disabled Windows sandbox backend, default sandbox permissions, and `PowerShell` origin; asserts `Decision::Allow`.

**Call relations**: Directly exercises the PowerShell-specific safe-command classifier in unmatched fallback logic.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `read_only_windows_sandbox_runs_unmatched_commands_under_sandbox`  (lines 91–113)

```
fn read_only_windows_sandbox_runs_unmatched_commands_under_sandbox()
```

**Purpose**: Verifies that when a real Windows sandbox backend is enabled, unmatched commands can be allowed under sandbox even with `AskForApproval::Never`.

**Data flow**: Builds `cmd.exe /c dir`, iterates over `WindowsSandboxLevel::RestrictedToken` and `Elevated`, calls `render_decision_for_unmatched_command` with read-only permissions and generic origin, and asserts `Decision::Allow` for both levels.

**Call relations**: Exercises the branch where backend availability prevents the conservative no-sandbox rejection.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `read_only_windows_policy_without_sandbox_backend_still_requires_approval`  (lines 116–134)

```
fn read_only_windows_policy_without_sandbox_backend_still_requires_approval()
```

**Purpose**: Checks that a read-only managed policy is treated conservatively when the Windows sandbox backend is disabled and prompts are forbidden.

**Data flow**: Calls `render_decision_for_unmatched_command` on `cmd.exe /c dir` with read-only permissions, `WindowsSandboxLevel::Disabled`, generic origin, and `AskForApproval::Never`; asserts `Decision::Forbidden` with an explanatory message.

**Call relations**: Targets the `windows_managed_fs_restrictions_without_sandbox_backend` branch in unmatched fallback logic.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `writable_windows_policy_without_sandbox_backend_still_requires_approval`  (lines 137–172)

```
fn writable_windows_policy_without_sandbox_backend_still_requires_approval()
```

**Purpose**: Verifies the same conservative rejection applies to writable managed filesystem policies when no Windows sandbox backend exists.

**Data flow**: Builds a restricted filesystem policy with root read and project-root write, converts it to a `PermissionProfile`, calls `render_decision_for_unmatched_command` on `cmd.exe /c dir` with `WindowsSandboxLevel::Disabled` and `AskForApproval::Never`, and asserts `Decision::Forbidden`.

**Call relations**: Extends coverage of the no-backend conservative branch to writable managed profiles.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 2 external calls (assert_eq!, vec!).


##### `unmatched_dangerous_powershell_inner_commands_require_approval`  (lines 175–202)

```
async fn unmatched_dangerous_powershell_inner_commands_require_approval()
```

**Purpose**: Checks that dangerous lowered PowerShell commands require approval and propose an amendment for the inner command words.

**Data flow**: Builds inner command `Remove-Item test -Force`, wraps it in a PowerShell `-Command` invocation with no policy and disabled permissions, runs the shared assertion helper, and expects `NeedsApproval` with `Some(ExecPolicyAmendment::new(inner_command))`.

**Call relations**: Exercises PowerShell-specific dangerous-command heuristics through the full approval pipeline.

*Call graph*: 2 external calls (new, vec!).


### `core/src/safety_tests.rs`

`test` · `test-time validation of patch safety policy`

This test file validates the behavior of `assess_patch_safety` and `is_write_patch_constrained_to_writable_paths` using temporary directories and synthetic patch actions. The tests build realistic `PermissionProfile` and `FileSystemSandboxPolicy` combinations, then assert the exact `SafetyCheck` outcome or writable-path predicate result.

Several tests focus on path-scope analysis: `test_writable_roots_constraint` proves that writes inside the workspace are accepted, writes outside are rejected unless the parent directory is explicitly added as a writable root, and the helper behaves consistently with temporary workspace roots. Other tests verify approval semantics: external sandbox profiles auto-approve constrained writes under `OnRequest`, while out-of-root writes under managed workspace-write profiles require user approval. Granular approval settings are checked in both permissive and restrictive forms, confirming that `sandbox_approval: false` converts an otherwise ask-user case into a hard rejection.

The file also covers nuanced deny/read-only behavior inside broader writable policies. Explicit unreadable or read-only subpaths prevent auto-approval even for external sandbox profiles, and a missing `.codex/config.toml` path under a read-only `.codex` directory similarly forces approval. Finally, the read-only managed profile test verifies both the path predicate and the specific rejection reason string, ensuring the code distinguishes read-only sandboxes from generic outside-project rejections.

#### Function details

##### `test_writable_roots_constraint`  (lines 15–61)

```
fn test_writable_roots_constraint()
```

**Purpose**: Verifies that the writable-path predicate accepts writes inside the workspace, rejects writes outside it, and accepts outside writes once the parent directory is explicitly configured as writable.

**Data flow**: It creates a temporary directory, derives `cwd` and its parent, constructs helper patch actions that add files inside and outside the workspace, builds a workspace-only `FileSystemSandboxPolicy`, and asserts the boolean results of `is_write_patch_constrained_to_writable_paths` for each case. It then builds a second policy with the parent directory added via `workspace_write` and asserts that the outside write becomes allowed.

**Call relations**: This test directly exercises `is_write_patch_constrained_to_writable_paths` rather than the higher-level approval function. It documents the foundational writable-root behavior that `assess_patch_safety` relies on.

*Call graph*: calls 1 internal fn (workspace_write); 3 external calls (new, assert!, from_ref).


##### `external_sandbox_auto_approves_in_on_request`  (lines 64–89)

```
fn external_sandbox_auto_approves_in_on_request()
```

**Purpose**: Verifies that an external sandbox profile auto-approves an in-workspace patch under `AskForApproval::OnRequest` and uses `SandboxType::None` for the outer Codex sandbox.

**Data flow**: It creates a temporary workspace, constructs an add-file patch inside it, builds `PermissionProfile::External` and `FileSystemSandboxPolicy::external_sandbox()`, calls `assess_patch_safety`, and asserts that the result is `SafetyCheck::AutoApprove { sandbox_type: SandboxType::None, user_explicitly_approved: false }`.

**Call relations**: This test targets the branch in `assess_patch_safety` that treats external profiles as already sandboxed and therefore not requiring an additional platform sandbox for constrained writes.

*Call graph*: calls 2 internal fn (new_add_for_test, external_sandbox); 2 external calls (new, assert_eq!).


##### `granular_with_all_flags_true_matches_on_request_for_out_of_root_patch`  (lines 92–134)

```
fn granular_with_all_flags_true_matches_on_request_for_out_of_root_patch()
```

**Purpose**: Verifies that a fully permissive granular approval configuration behaves like `OnRequest` for an out-of-root patch, producing `AskUser` rather than rejection.

**Data flow**: It creates a temporary workspace and an add-file patch outside the workspace, builds a managed workspace-write permission profile and its filesystem policy, then calls `assess_patch_safety` twice: once with `AskForApproval::OnRequest` and once with `AskForApproval::Granular` where all flags are `true`. It asserts that both results are `SafetyCheck::AskUser`.

**Call relations**: This test compares two policy modes against the same patch and sandbox setup to confirm that granular approval with sandbox approval enabled does not tighten behavior beyond the standard ask-user path.

*Call graph*: calls 2 internal fn (new_add_for_test, workspace_write_with); 2 external calls (new, assert_eq!).


##### `granular_sandbox_approval_false_rejects_out_of_root_patch`  (lines 137–170)

```
fn granular_sandbox_approval_false_rejects_out_of_root_patch()
```

**Purpose**: Verifies that disabling `sandbox_approval` in granular approval mode turns an out-of-root patch into a hard rejection with the outside-project reason.

**Data flow**: It creates a temporary workspace and an outside-workspace add patch, builds a managed workspace-write permission profile and filesystem policy, calls `assess_patch_safety` with `AskForApproval::Granular` where `sandbox_approval` is `false`, and asserts that the result is `SafetyCheck::Reject { reason: PATCH_REJECTED_OUTSIDE_PROJECT_REASON.to_string() }`.

**Call relations**: This test covers the `rejects_sandbox_approval` branch in `assess_patch_safety`, proving that the function rejects rather than asks when policy forbids sandbox approval.

*Call graph*: calls 2 internal fn (new_add_for_test, workspace_write_with); 2 external calls (new, assert_eq!).


##### `read_only_policy_rejects_patch_with_read_only_reason`  (lines 173–199)

```
fn read_only_policy_rejects_patch_with_read_only_reason()
```

**Purpose**: Verifies that a read-only managed profile both fails the writable-path predicate and yields the specific read-only rejection reason under `AskForApproval::Never`.

**Data flow**: It creates a temporary workspace and an in-workspace add patch, builds `PermissionProfile::read_only()` and its filesystem policy, asserts that `is_write_patch_constrained_to_writable_paths` returns `false`, then calls `assess_patch_safety` with `AskForApproval::Never` and asserts a `Reject` containing `PATCH_REJECTED_READ_ONLY_REASON.to_string()`.

**Call relations**: This test exercises both the low-level path predicate and the `patch_rejection_reason` path selected by `assess_patch_safety` for managed profiles with no writable roots.

*Call graph*: calls 2 internal fn (new_add_for_test, read_only); 3 external calls (new, assert!, assert_eq!).


##### `explicit_unreadable_paths_prevent_auto_approval_for_external_sandbox`  (lines 201–241)

```
fn explicit_unreadable_paths_prevent_auto_approval_for_external_sandbox()
```

**Purpose**: Verifies that an explicit deny rule for a specific path prevents auto-approval even under an external sandbox profile, forcing user approval instead.

**Data flow**: It creates a temporary workspace and a patch targeting `blocked.txt`, builds `PermissionProfile::External` plus a restricted filesystem policy containing a broad write rule for root and a deny rule for the blocked path, asserts that `is_write_patch_constrained_to_writable_paths` is `false`, then calls `assess_patch_safety` with `OnRequest` and asserts `SafetyCheck::AskUser`.

**Call relations**: This test demonstrates that external sandbox profiles are only auto-approved when the patch is actually constrained to writable paths; explicit deny entries still route through the ask-user branch in `assess_patch_safety`.

*Call graph*: calls 2 internal fn (new_add_for_test, restricted); 4 external calls (new, assert!, assert_eq!, vec!).


##### `explicit_read_only_subpaths_prevent_auto_approval_for_external_sandbox`  (lines 244–285)

```
fn explicit_read_only_subpaths_prevent_auto_approval_for_external_sandbox()
```

**Purpose**: Verifies that a read-only subdirectory inside an otherwise writable project root prevents auto-approval for writes beneath that subpath, even with an external sandbox profile.

**Data flow**: It creates a temporary workspace, computes absolute paths for `docs` and `docs/blocked.txt`, constructs an add patch for the blocked file, builds `PermissionProfile::External` and a restricted filesystem policy that grants write access to project roots but only read access to the `docs` directory, asserts the writable-path predicate is `false`, then calls `assess_patch_safety` with `OnRequest` and asserts `SafetyCheck::AskUser`.

**Call relations**: This test covers a more specific policy-overrides-general-policy scenario, confirming that `is_write_patch_constrained_to_writable_paths` respects narrower read-only entries and that `assess_patch_safety` responds by requiring approval.

*Call graph*: calls 3 internal fn (new_add_for_test, restricted, resolve_path_against_base); 4 external calls (new, assert!, assert_eq!, vec!).


##### `missing_project_dot_codex_config_requires_approval`  (lines 288–325)

```
fn missing_project_dot_codex_config_requires_approval()
```

**Purpose**: Verifies that creating `.codex/config.toml` requires approval when the `.codex` directory is only readable, even under a workspace-write managed profile.

**Data flow**: It creates a temporary workspace, constructs an add patch for `.codex/config.toml`, builds a workspace-write permission profile and filesystem policy, mutates the policy by pushing a read-only `FileSystemSandboxEntry` for the `.codex` directory, asserts that `is_write_patch_constrained_to_writable_paths` returns `false`, then calls `assess_patch_safety` with `OnRequest` and asserts `SafetyCheck::AskUser`.

**Call relations**: This test exercises the interaction between project-local special paths and explicit read-only overrides, validating that the safety logic does not auto-approve writes into a read-only `.codex` subtree.

*Call graph*: calls 2 internal fn (new_add_for_test, workspace_write_with); 3 external calls (new, assert!, assert_eq!).


### `core/src/mcp_tool_exposure_test.rs`

`test` · `unit tests for tool exposure computation during tool inventory assembly`

This file is the focused test suite for `mcp_tool_exposure.rs`. It defines small fixture builders for `AppInfo` and `codex_mcp::ToolInfo`, including helpers to generate numbered tool sets and to inject MCP metadata controlling model visibility. The fixtures are intentionally concrete: `make_mcp_tool` fills `ToolInfo` fields such as `server_name`, `callable_namespace`, `callable_name`, `connector_id`, and an `rmcp::model::Tool` with a default JSON schema object, while `with_visibility` writes `tool.tool.meta` in the same nested `ui.visibility` shape used by production visibility checks.

The tests cover the main exposure decisions. Small effective tool sets remain directly exposed, while sets at the threshold are deferred into `deferred_tools` when search is enabled. Visibility metadata is honored for both ordinary MCP tools and Codex Apps tools, so tools marked app-only are excluded from model exposure. Codex Apps tools are also filtered through real config-driven app policy by writing a temporary `config.toml` that disables tools by default and selectively re-enables one tool. Finally, enabling `Feature::ToolSearchAlwaysDeferMcpTools` forces both ordinary MCP tools and Codex Apps tools into deferred exposure even when the set is small. The assertions compare canonical `ToolName`s rather than raw structs, making the tests robust to irrelevant field differences.

#### Function details

##### `make_connector`  (lines 20–36)

```
fn make_connector(id: &str, name: &str) -> AppInfo
```

**Purpose**: Builds a minimal accessible and enabled `AppInfo` fixture for a connector.

**Data flow**: Takes connector `id` and `name`, converts them to owned strings, fills the remaining `AppInfo` fields with `None`, `true`, or empty vectors as appropriate, and returns the struct.

**Call relations**: Used by exposure tests that need a connector inventory to authorize Codex Apps tools.

*Call graph*: 1 external calls (new).


##### `make_mcp_tool`  (lines 38–62)

```
fn make_mcp_tool(
    server_name: &str,
    tool_name: &str,
    callable_namespace: &str,
    callable_name: &str,
    connector_id: Option<&str>,
    connector_name: Option<&str>,
) -> ToolInfo
```

**Purpose**: Constructs a synthetic `ToolInfo` with configurable server identity, callable naming, and optional connector metadata.

**Data flow**: Accepts server/tool/callable names plus optional connector ID/name, creates an `rmcp::model::Tool` via `Tool::new` with a default empty `JsonObject` schema and a generated description, then returns a `ToolInfo` populated with those values and default flags like `supports_parallel_tool_calls = false`.

**Call relations**: Called by tests that need explicit ordinary MCP tools or Codex Apps tools with known canonical names and connector IDs.

*Call graph*: called by 2 (applies_per_tool_app_policy_across_the_exposure_build, excludes_tools_hidden_from_model_exposure); 5 external calls (new, default, new, format!, new).


##### `numbered_mcp_tools`  (lines 64–78)

```
fn numbered_mcp_tools(count: usize) -> Vec<ToolInfo>
```

**Purpose**: Generates a sequence of ordinary MCP tools named `tool_<index>` for threshold tests.

**Data flow**: Maps over `0..count`, formats each tool name, calls `make_mcp_tool` with server `rmcp` and namespace `mcp__rmcp`, and collects the resulting `ToolInfo` values into a vector.

**Call relations**: Used by the small-set and threshold deferral tests to create predictable tool inventories of varying size.

*Call graph*: called by 2 (directly_exposes_small_effective_tool_sets, searches_large_effective_tool_sets).


##### `tool_names`  (lines 80–85)

```
fn tool_names(tools: &[ToolInfo]) -> HashSet<ToolName>
```

**Purpose**: Normalizes a tool list into a `HashSet<ToolName>` for order-insensitive assertions.

**Data flow**: Iterates over `tools`, calls `codex_mcp::ToolInfo::canonical_tool_name` on each, and collects the results into a `HashSet<ToolName>`.

**Call relations**: Used in assertions where only the exposed tool identities matter, not vector ordering or other fields.

*Call graph*: called by 1 (always_defer_feature_defers_apps_too); 1 external calls (iter).


##### `with_visibility`  (lines 87–95)

```
fn with_visibility(mut tool: ToolInfo, visibility: &[&str]) -> ToolInfo
```

**Purpose**: Adds MCP metadata controlling UI/model visibility to a `ToolInfo` fixture.

**Data flow**: Takes ownership of a `ToolInfo`, sets `tool.tool.meta` to `Some(Meta(...))` containing JSON `{ "ui": { "visibility": visibility } }`, and returns the modified tool.

**Call relations**: Used by the visibility-filtering test to create model-visible, app-only, and empty-visibility variants.

*Call graph*: called by 1 (excludes_tools_hidden_from_model_exposure); 2 external calls (Meta, json!).


##### `directly_exposes_small_effective_tool_sets`  (lines 98–108)

```
async fn directly_exposes_small_effective_tool_sets()
```

**Purpose**: Verifies that an effective MCP tool set smaller than the threshold is exposed directly when search is enabled.

**Data flow**: Builds a default test config and `DIRECT_MCP_TOOL_EXPOSURE_THRESHOLD - 1` numbered tools, calls `build_mcp_tool_exposure` with no connectors and `search_tool_enabled = true`, then asserts `direct_tools` matches the original set and `deferred_tools` is `None`.

**Call relations**: Covers the non-deferral branch of `build_mcp_tool_exposure`.

*Call graph*: calls 2 internal fn (test_config, numbered_mcp_tools); 2 external calls (assert!, assert_eq!).


##### `excludes_tools_hidden_from_model_exposure`  (lines 111–186)

```
async fn excludes_tools_hidden_from_model_exposure()
```

**Purpose**: Checks that tools hidden from model visibility are excluded from exposure for both ordinary MCP servers and Codex Apps.

**Data flow**: Builds visible and hidden ordinary tools plus visible and hidden Codex Apps tools using `with_visibility`, supplies a matching `calendar` connector, calls `build_mcp_tool_exposure` with search disabled, and asserts only the visible ordinary tool and visible app tool remain in `direct_tools` with no deferred set.

**Call relations**: Exercises both filtering helpers together, especially the shared `tool_is_model_visible` gate.

*Call graph*: calls 3 internal fn (test_config, make_mcp_tool, with_visibility); 3 external calls (assert!, assert_eq!, vec!).


##### `applies_per_tool_app_policy_across_the_exposure_build`  (lines 189–237)

```
async fn applies_per_tool_app_policy_across_the_exposure_build()
```

**Purpose**: Verifies that Codex Apps exposure respects config-driven per-tool enablement policy.

**Data flow**: Writes a temporary `config.toml` disabling calendar tools by default but enabling `events/create`, builds config, creates enabled and disabled Codex Apps tools plus a `calendar` connector, calls `build_mcp_tool_exposure`, and asserts only the enabled tool appears in `direct_tools`.

**Call relations**: Specifically targets the `AppToolPolicyEvaluator` branch inside `filter_codex_apps_mcp_tools`.

*Call graph*: calls 1 internal fn (make_mcp_tool); 6 external calls (assert!, assert_eq!, default, write, tempdir, vec!).


##### `searches_large_effective_tool_sets`  (lines 240–254)

```
async fn searches_large_effective_tool_sets()
```

**Purpose**: Checks that an effective tool set at the threshold is deferred to search rather than exposed directly.

**Data flow**: Builds a default config and exactly `DIRECT_MCP_TOOL_EXPOSURE_THRESHOLD` numbered tools, calls `build_mcp_tool_exposure` with search enabled, and asserts `direct_tools` is empty while `deferred_tools` exists and contains the full tool set.

**Call relations**: Covers the threshold-triggered deferral branch in `build_mcp_tool_exposure`.

*Call graph*: calls 2 internal fn (test_config, numbered_mcp_tools); 2 external calls (assert!, assert_eq!).


##### `always_defer_feature_defers_apps_too`  (lines 257–301)

```
async fn always_defer_feature_defers_apps_too()
```

**Purpose**: Verifies that the `ToolSearchAlwaysDeferMcpTools` feature forces deferral of both ordinary MCP tools and Codex Apps tools regardless of set size.

**Data flow**: Enables the feature on a test config, builds one ordinary MCP tool and one Codex Apps tool plus a matching connector, calls `build_mcp_tool_exposure` with search enabled, and asserts `direct_tools` is empty while `deferred_tools` contains both canonical tool names.

**Call relations**: Tests the feature-flag override branch that bypasses the numeric threshold.

*Call graph*: calls 2 internal fn (test_config, tool_names); 2 external calls (assert!, vec!).


### `core/src/sandbox_tags_tests.rs`

`test` · `test execution`

This test module exercises two tag-producing helpers imported from the parent module: `permission_profile_sandbox_tag` and `permission_profile_policy_tag`. The assertions are intentionally concrete about how `PermissionProfile` variants map to short metric strings, especially in cases where Linux or platform defaults might otherwise blur distinctions. Several tests verify that `PermissionProfile::Disabled` always reports `"none"`, while `PermissionProfile::External` preserves the explicit `"external"` tag even when a platform sandbox would normally be inferred. Other cases build managed profiles with `ManagedFileSystemPermissions::Unrestricted` or a restricted entry granting write access to the special root path and confirm these are treated as effectively unsandboxed when managed-network enforcement is off. A complementary test flips `enforce_managed_network` on and expects the platform sandbox tag from `get_platform_sandbox(...).map(SandboxType::as_metric_tag)`, proving that network enforcement changes the tagging outcome even for otherwise unrestricted profiles. The final test constructs a runtime filesystem policy rooted under `/tmp/codex`, converts it back into a `PermissionProfile` with `from_runtime_permissions`, and checks that `permission_profile_policy_tag` reports the closest legacy mode string `"workspace-write"`. Together these tests document the invariants that metric tags are semantic summaries, not raw reflections of every low-level permission field.

#### Function details

##### `danger_full_access_is_untagged_even_when_linux_sandbox_defaults_apply`  (lines 19–26)

```
fn danger_full_access_is_untagged_even_when_linux_sandbox_defaults_apply()
```

**Purpose**: Verifies that a fully disabled permission profile is tagged as `"none"` rather than inheriting any platform sandbox default.

**Data flow**: Builds no intermediate state beyond passing `&PermissionProfile::Disabled`, `WindowsSandboxLevel::Disabled`, and `false` for managed-network enforcement into `permission_profile_sandbox_tag`; compares the returned tag string against the literal `"none"` with `assert_eq!`.

**Call relations**: This is a standalone regression test invoked by the Rust test harness. It directly probes the helper under the condition where Linux/platform defaults might otherwise imply sandboxing, and confirms the helper suppresses that inference for the disabled profile.

*Call graph*: 2 external calls (assert_eq!, permission_profile_sandbox_tag).


##### `external_sandbox_keeps_external_tag_when_linux_sandbox_defaults_apply`  (lines 29–38)

```
fn external_sandbox_keeps_external_tag_when_linux_sandbox_defaults_apply()
```

**Purpose**: Checks that an externally managed sandbox profile keeps the explicit `"external"` metric tag.

**Data flow**: Constructs `PermissionProfile::External { network: NetworkSandboxPolicy::Enabled }`, passes it with disabled Windows sandboxing and `enforce_managed_network = false` to `permission_profile_sandbox_tag`, and asserts the returned string is `"external"`.

**Call relations**: Run by the test harness as a focused case for the external-profile branch. It complements the disabled-profile test by proving the helper distinguishes explicit external sandboxing from no sandbox at all.

*Call graph*: 2 external calls (assert_eq!, permission_profile_sandbox_tag).


##### `default_linux_sandbox_uses_platform_sandbox_tag`  (lines 41–51)

```
fn default_linux_sandbox_uses_platform_sandbox_tag()
```

**Purpose**: Confirms that a normal read-only profile uses the current platform sandbox type as its metric tag.

**Data flow**: Creates a read-only `PermissionProfile` via `PermissionProfile::read_only()`, computes the actual tag with `permission_profile_sandbox_tag`, separately computes the expected tag from `get_platform_sandbox(false)` and `SandboxType::as_metric_tag` with `"none"` fallback, then asserts equality.

**Call relations**: This test is called by the harness to validate the default-path behavior rather than a special-case override. It ties the tag helper to the lower-level platform sandbox selector so future changes in platform detection remain reflected in metrics.

*Call graph*: calls 1 internal fn (read_only); 3 external calls (assert_eq!, get_platform_sandbox, permission_profile_sandbox_tag).


##### `profile_sandbox_tag_distinguishes_disabled_from_external`  (lines 54–73)

```
fn profile_sandbox_tag_distinguishes_disabled_from_external()
```

**Purpose**: Asserts side by side that disabled and external profiles produce different tags.

**Data flow**: Calls `permission_profile_sandbox_tag` twice—once with `PermissionProfile::Disabled`, once with `PermissionProfile::External { network: NetworkSandboxPolicy::Restricted }`—and compares the results to `"none"` and `"external"` respectively.

**Call relations**: This test is a compact distinction check driven by the harness. It reinforces that the helper’s output space preserves an important semantic split that downstream metrics or dashboards may rely on.

*Call graph*: 1 external calls (assert_eq!).


##### `unrestricted_managed_profile_with_enabled_network_is_untagged`  (lines 76–90)

```
fn unrestricted_managed_profile_with_enabled_network_is_untagged()
```

**Purpose**: Verifies that a managed profile with unrestricted filesystem access and enabled network is treated as effectively unsandboxed when managed-network enforcement is disabled.

**Data flow**: Builds `PermissionProfile::Managed { file_system: ManagedFileSystemPermissions::Unrestricted, network: NetworkSandboxPolicy::Enabled }`, passes it to `permission_profile_sandbox_tag` with disabled Windows sandboxing and `false` enforcement, and asserts the result is `"none"`.

**Call relations**: Executed by the test harness as one of the managed-profile edge cases. It documents that the helper collapses this permissive managed configuration into the same metric bucket as no sandbox.

*Call graph*: 1 external calls (assert_eq!).


##### `root_write_managed_profile_with_enabled_network_is_untagged`  (lines 93–115)

```
fn root_write_managed_profile_with_enabled_network_is_untagged()
```

**Purpose**: Checks that a managed profile granting write access to the special root path is also considered effectively unsandboxed for tagging.

**Data flow**: Constructs a `PermissionProfile::Managed` whose restricted filesystem entries contain one `FileSystemSandboxEntry` targeting `FileSystemSpecialPath::Root` with `FileSystemAccessMode::Write`; passes that profile to `permission_profile_sandbox_tag` and asserts the returned tag is `"none"`.

**Call relations**: This harness-driven test covers a less obvious permissive configuration. It ensures the tag helper recognizes root-write access as broad enough to collapse into the unsandboxed metric category.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `managed_network_enforcement_tags_unrestricted_profiles_as_sandboxed`  (lines 118–135)

```
fn managed_network_enforcement_tags_unrestricted_profiles_as_sandboxed()
```

**Purpose**: Shows that enabling managed-network enforcement changes an otherwise unrestricted managed profile from `"none"` to the platform sandbox tag.

**Data flow**: Creates the same unrestricted managed profile as an earlier test, computes the expected platform tag from `get_platform_sandbox(false)` and `SandboxType::as_metric_tag`, then calls `permission_profile_sandbox_tag` with `enforce_managed_network = true` and asserts it matches that expected tag.

**Call relations**: This test is the counterpart to the unrestricted-managed untaged case. It demonstrates the conditional branch where network enforcement causes the helper to report sandboxing even when filesystem permissions are unrestricted.

*Call graph*: 2 external calls (assert_eq!, get_platform_sandbox).


##### `profile_policy_tag_reports_closest_legacy_mode`  (lines 138–160)

```
fn profile_policy_tag_reports_closest_legacy_mode()
```

**Purpose**: Validates that the policy-tag helper maps a concrete runtime permission set back to the expected legacy policy label.

**Data flow**: Creates absolute paths for a cwd and writable workspace root, builds a restricted `FileSystemSandboxPolicy` with one writable path entry, converts runtime permissions into a `PermissionProfile` using `PermissionProfile::from_runtime_permissions`, then passes the profile and cwd path into `permission_profile_policy_tag` and asserts the result is `"workspace-write"`.

**Call relations**: Invoked by the test harness to cover the legacy-policy summarization path. It bridges low-level runtime permission structures and the higher-level compatibility tag expected by metrics or older interfaces.

*Call graph*: calls 2 internal fn (from_runtime_permissions, from_absolute_path); 3 external calls (new, assert_eq!, vec!).


### Runtime environment and realtime helpers
These tests cover filesystem and shell-facing helpers, AGENTS.md and personality migration behavior, Git metadata, and realtime context/conversation support.

### `core/src/agents_md_tests.rs`

`test` · `test-time validation of AGENTS.md discovery and rendering behavior`

This large test module is the executable specification for `agents_md.rs`. It defines `FailingFileSystem`, an `ExecutorFileSystem` implementation that delegates reads and metadata calls to `LOCAL_FS` except for one injected path/error-kind pair, allowing tests to distinguish recoverable `NotFound` races from propagated permission failures. `TestConfig` wraps a `Config` plus optional host `UserInstructions` and implements `Deref`/`DerefMut` so helpers can pass it where `Config` is expected. Setup helpers build temporary configs with byte limits, fallback filenames, or explicit `project_root_markers`, create synthetic environment snapshots, and construct expected `InstructionProvenance::Project` values.

The tests cover empty and whitespace-only instruction bundles, byte-limit truncation across hierarchical docs, lossy UTF-8 decoding, repo-root discovery via `.git`, zero-byte disabling, merging host instructions with project docs, and the distinction between single-contributor legacy layout and multi-environment labeled layout. They also verify that per-environment byte budgets are independent, child-agent guidance is appended once and excluded from `sources()`, project config layers cannot override root-marker discovery rules, symlinked cwd paths are preserved, `AGENTS.override.md` outranks `AGENTS.md`, configured fallbacks are used only when preferred names are absent, directories and special files are ignored, and unrelated features like skills or apps do not inject AGENTS instructions. Together these tests pin down both visible output strings and subtle provenance/order invariants.

#### Function details

##### `FailingFileSystem::canonicalize`  (lines 128–134)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: Implements the test filesystem’s canonicalize operation as unreachable because AGENTS discovery should never call it. Any invocation indicates an unexpected code path.

**Data flow**: Accepts a `PathUri` and optional sandbox context, immediately panics via `unreachable!`, and returns no meaningful value.

**Call relations**: This method exists only to satisfy the `ExecutorFileSystem` trait for `FailingFileSystem`; the tests rely on AGENTS loading using only metadata and file reads.

*Call graph*: 2 external calls (pin, unreachable!).


##### `FailingFileSystem::read_file`  (lines 136–142)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: Either injects a configured read failure for one target path or delegates the read to `LOCAL_FS`. It lets tests simulate files disappearing or becoming unreadable after discovery.

**Data flow**: Converts the incoming `PathUri` to an absolute path, compares it to `self.path`, and if `self.failure` is `InjectedFailure::Read(kind)` returns `io::Error::new(kind, "injected read failure")`; otherwise it awaits `LOCAL_FS.read_file(path, sandbox)` and returns those bytes.

**Call relations**: The trait implementation forwards `ExecutorFileSystem::read_file` here. Read-error tests call AGENTS loading with this filesystem to exercise recovery and propagation branches.

*Call graph*: calls 1 internal fn (to_abs_path); 2 external calls (pin, new).


##### `FailingFileSystem::read_file_stream`  (lines 144–155)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: Rejects streaming reads because the AGENTS loader does not use them and the test double does not implement them.

**Data flow**: Ignores its inputs and returns a boxed future that resolves to `Err(io::ErrorKind::Unsupported)` with a fixed message.

**Call relations**: This is trait boilerplate for `ExecutorFileSystem`; no AGENTS tests are expected to drive it.

*Call graph*: 2 external calls (pin, new).


##### `FailingFileSystem::write_file`  (lines 157–164)

```
fn write_file(
        &'a self,
        path: &'a PathUri,
        contents: Vec<u8>,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Marks write operations as unreachable on the failing filesystem because AGENTS loading is read-only.

**Data flow**: Accepts path, contents, and sandbox arguments, then panics with `unreachable!`.

**Call relations**: Provided only to complete the trait implementation; tests would fail immediately if AGENTS loading unexpectedly attempted writes.

*Call graph*: 2 external calls (pin, unreachable!).


##### `FailingFileSystem::create_directory`  (lines 166–175)

```
fn create_directory(
        &'a self,
        path: &'a PathUri,
        options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a,
```

**Purpose**: Marks directory creation as unreachable for the same reason as writes: AGENTS discovery should not mutate the filesystem.

**Data flow**: Accepts path, options, and sandbox, then panics via `unreachable!`.

**Call relations**: Trait-completion method for the test double; not part of the intended AGENTS code path.

*Call graph*: 2 external calls (pin, unreachable!).


##### `FailingFileSystem::get_metadata`  (lines 177–183)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: Either injects a configured metadata failure for one target path or delegates to `LOCAL_FS`. It is used to test root-marker and candidate-file probing error handling.

**Data flow**: Converts the incoming `PathUri` to an absolute path, compares it to `self.path`, and if `self.failure` is `InjectedFailure::Metadata(kind)` returns `io::Error::new(kind, "injected metadata failure")`; otherwise it awaits `LOCAL_FS.get_metadata(path, sandbox)`.

**Call relations**: The trait implementation forwards metadata requests here. Metadata-error tests use it to verify that permission failures propagate while `NotFound` remains recoverable.

*Call graph*: calls 1 internal fn (to_abs_path); 2 external calls (pin, new).


##### `FailingFileSystem::read_directory`  (lines 185–191)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: Marks directory listing as unreachable because AGENTS discovery probes explicit candidate paths rather than enumerating directories.

**Data flow**: Ignores inputs and panics with `unreachable!`.

**Call relations**: Another trait-completion method that guards against unexpected discovery strategies in the production code.

*Call graph*: 2 external calls (pin, unreachable!).


##### `FailingFileSystem::remove`  (lines 193–200)

```
fn remove(
        &'a self,
        path: &'a PathUri,
        options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, ()>
```

**Purpose**: Marks file removal as unreachable in the read-only test double.

**Data flow**: Accepts path, remove options, and sandbox, then panics.

**Call relations**: Included only to satisfy the filesystem trait; AGENTS loading should never invoke it.

*Call graph*: 2 external calls (pin, unreachable!).


##### `FailingFileSystem::copy`  (lines 202–216)

```
fn copy(
        &'a self,
        source_path: &'a PathUri,
        destination_path: &'a PathUri,
        options: CopyOptions,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> Execut
```

**Purpose**: Marks copy operations as unreachable because AGENTS discovery should not perform filesystem mutations or duplication.

**Data flow**: Accepts source, destination, options, and sandbox, then panics via `unreachable!`.

**Call relations**: Trait boilerplate for the test double; not expected in any AGENTS test flow.

*Call graph*: 2 external calls (pin, unreachable!).


##### `TestConfig::deref`  (lines 227–229)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets `TestConfig` be used as `&Config` in helper calls and assertions by exposing the wrapped config reference.

**Data flow**: Returns `&self.config`.

**Call relations**: This deref support simplifies test helpers like `read_agents_md` and `agents_md_paths`, which can accept `&TestConfig` while still accessing config fields naturally.


##### `TestConfig::deref_mut`  (lines 233–235)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: Lets tests mutate the wrapped `Config` directly through `TestConfig` values.

**Data flow**: Returns `&mut self.config`.

**Call relations**: Used implicitly in tests that adjust `cwd`, feature flags, or layer stacks after constructing a `TestConfig`.


##### `get_user_instructions`  (lines 238–240)

```
async fn get_user_instructions(config: &TestConfig) -> Option<String>
```

**Purpose**: Loads AGENTS instructions for a test config and returns only the rendered text, if any. It is the most common convenience wrapper in the file.

**Data flow**: Accepts `&TestConfig`, awaits `load_agents_md(config)`, maps the resulting `LoadedAgentsMd` to `loaded.text()`, and returns `Option<String>`.

**Call relations**: Many tests call this when they only care about the final instruction string rather than provenance or structured entries.

*Call graph*: calls 1 internal fn (load_agents_md); called by 18 (agents_local_md_preferred, agents_md_directory_is_ignored, agents_md_paths_preserve_symlinked_cwd, agents_md_preferred_over_fallbacks, agents_md_special_file_is_ignored, apps_feature_does_not_append_to_agents_md_user_instructions, apps_feature_does_not_emit_user_instructions_by_itself, doc_larger_than_limit_is_truncated, doc_smaller_than_limit_is_returned, finds_doc_in_repo_root (+8 more)).


##### `load_agents_md`  (lines 242–251)

```
async fn load_agents_md(config: &TestConfig) -> Option<LoadedAgentsMd>
```

**Purpose**: Runs the production `load_project_instructions` path for a single local environment derived from the test config’s cwd and optional host instructions.

**Data flow**: Builds a `TurnEnvironmentSnapshot` with `resolved_local_environments([("local", config.config.cwd.clone())])`, clones `config.user_instructions`, passes both plus `&config.config` to `load_project_instructions`, awaits it, and returns `Option<LoadedAgentsMd>`.

**Call relations**: This helper underpins `get_user_instructions` and tests that need the full `LoadedAgentsMd` structure.

*Call graph*: calls 1 internal fn (resolved_local_environments); called by 7 (child_agents_message_after_global_instructions_uses_plain_separator, child_agents_message_after_project_docs_is_not_an_instruction_source, concatenates_root_and_cwd_docs, get_user_instructions, instruction_sources_include_global_before_agents_md_docs, project_doc_invalid_utf8_uses_lossy_text, total_byte_limit_truncates_later_project_docs).


##### `agents_md_paths`  (lines 253–255)

```
async fn agents_md_paths(config: &TestConfig) -> std::io::Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Exposes the production path-discovery helper to tests using the local filesystem and the test config’s cwd.

**Data flow**: Calls `super::agents_md_paths(&config.config, &config.cwd, LOCAL_FS.as_ref()).await` and returns the resulting `io::Result<Vec<AbsolutePathBuf>>`.

**Call relations**: Discovery-focused tests call this directly when they want to inspect chosen file paths without reading contents.

*Call graph*: called by 8 (agents_local_md_preferred, agents_md_directory_is_ignored, agents_md_paths_preserve_symlinked_cwd, agents_md_preferred_over_fallbacks, agents_md_special_file_is_ignored, override_directory_falls_back_to_agents_md_file, project_layers_do_not_override_project_root_markers, project_root_markers_are_honored_for_agents_discovery); 1 external calls (agents_md_paths).


##### `resolved_local_environments`  (lines 257–276)

```
fn resolved_local_environments(
    environments: [(&str, AbsolutePathBuf); N],
) -> TurnEnvironmentSnapshot
```

**Purpose**: Builds a `TurnEnvironmentSnapshot` from a fixed array of `(environment_id, cwd)` pairs using local test environments. It supports multi-environment AGENTS rendering tests.

**Data flow**: Consumes an array of environment tuples, iterates it, creates a test `Environment` for each, wraps it in `Arc`, converts cwd to `PathUri`, constructs `TurnEnvironment::new(...)`, collects them into `turn_environments`, and returns the snapshot.

**Call relations**: Used by `load_agents_md` for the single-environment case and directly by multi-environment tests that call `load_project_instructions` themselves.

*Call graph*: called by 8 (child_agents_guidance_is_appended_once_after_environment_groups, load_agents_md, multiple_environment_docs_use_labeled_layout_and_preserve_source_order, multiple_environments_can_exceed_single_environment_project_doc_limit, primary_only_project_doc_preserves_legacy_layout_with_multiple_bound_environments, project_doc_byte_limit_is_applied_independently_per_environment, secondary_environment_invalid_utf8_does_not_suppress_other_docs, secondary_only_project_doc_uses_single_contributor_layout); 1 external calls (into_iter).


##### `project_provenance`  (lines 278–284)

```
fn project_provenance(path: AbsolutePathBuf, cwd: AbsolutePathBuf) -> InstructionProvenance
```

**Purpose**: Constructs the expected `InstructionProvenance::Project` value for local-environment assertions. It keeps expected-value setup concise and consistent.

**Data flow**: Takes a source path and cwd, wraps them with fixed `environment_id: "local".to_string()`, and returns the enum value.

**Call relations**: Tests comparing full `LoadedAgentsMd` structures use this helper to build expected provenance entries.


##### `make_config`  (lines 291–310)

```
async fn make_config(root: &TempDir, limit: usize, instructions: Option<&str>) -> TestConfig
```

**Purpose**: Creates a baseline `TestConfig` rooted at a temporary workspace with a configurable AGENTS byte limit and optional host instructions. It is the primary fixture builder for this file.

**Data flow**: Creates a temp codex home, builds a default `Config` with `ConfigBuilder`, sets `config.cwd` to the provided root’s absolute path and `project_doc_max_bytes` to `limit`, optionally constructs `UserInstructions` whose source is `codex_home/AGENTS.md`, and returns `TestConfig { config, user_instructions }`.

**Call relations**: Most tests start here before tweaking cwd, features, or config-layer state.

*Call graph*: called by 33 (agents_local_md_preferred, agents_md_directory_is_ignored, agents_md_paths_preserve_symlinked_cwd, agents_md_special_file_is_ignored, apps_feature_does_not_append_to_agents_md_user_instructions, apps_feature_does_not_emit_user_instructions_by_itself, child_agents_guidance_is_appended_once_after_environment_groups, child_agents_message_after_global_instructions_uses_plain_separator, child_agents_message_after_project_docs_is_not_an_instruction_source, concatenates_root_and_cwd_docs (+15 more)); 3 external calls (abs, new, default).


##### `make_config_with_fallback`  (lines 312–324)

```
async fn make_config_with_fallback(
    root: &TempDir,
    limit: usize,
    instructions: Option<&str>,
    fallbacks: &[&str],
) -> TestConfig
```

**Purpose**: Extends `make_config` by also setting `project_doc_fallback_filenames`. It is used for fallback-filename discovery tests.

**Data flow**: Awaits `make_config`, converts the provided fallback `&str` slice into owned `String`s, assigns them to `config.project_doc_fallback_filenames`, and returns the modified `TestConfig`.

**Call relations**: Fallback-preference tests call this instead of manually mutating the config after creation.

*Call graph*: calls 1 internal fn (make_config); called by 2 (agents_md_preferred_over_fallbacks, uses_configured_fallback_when_agents_missing).


##### `make_config_with_project_root_markers`  (lines 326–359)

```
async fn make_config_with_project_root_markers(
    root: &TempDir,
    limit: usize,
    instructions: Option<&str>,
    markers: &[&str],
) -> TestConfig
```

**Purpose**: Builds a `TestConfig` whose config includes explicit `project_root_markers` CLI overrides. It supports tests for custom root-marker discovery.

**Data flow**: Creates a temp codex home, builds CLI overrides containing a TOML array of marker strings, constructs a `Config` with `ConfigBuilder`, sets cwd and byte limit, optionally creates host `UserInstructions`, and returns `TestConfig`.

**Call relations**: Only the root-marker discovery test uses this helper to exercise non-default marker behavior.

*Call graph*: called by 1 (project_root_markers_are_honored_for_agents_discovery); 4 external calls (abs, new, default, vec!).


##### `no_doc_file_returns_none`  (lines 363–374)

```
async fn no_doc_file_returns_none()
```

**Purpose**: Verifies that when no AGENTS file exists and no host instructions are provided, loading returns `None`.

**Data flow**: Creates an empty temp directory, builds a config with no instructions, calls `get_user_instructions`, and asserts the result is `None`.

**Call relations**: This is the baseline absence test for the entire AGENTS loading pipeline.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 2 external calls (assert!, tempdir).


##### `empty_loaded_instructions_are_empty`  (lines 377–397)

```
fn empty_loaded_instructions_are_empty()
```

**Purpose**: Checks that constructors collapse empty or whitespace-only user/internal instruction text to `LoadedAgentsMd::default()`.

**Data flow**: Builds an absolute source path, calls `LoadedAgentsMd::new_user` and `LoadedAgentsMd::from_text_for_testing` with empty and whitespace strings, and asserts each equals the default value.

**Call relations**: This test targets constructor-level normalization rather than filesystem discovery.

*Call graph*: calls 1 internal fn (from_absolute_path); 1 external calls (assert_eq!).


##### `loaded_instructions_with_only_empty_or_whitespace_entries_are_empty`  (lines 400–418)

```
fn loaded_instructions_with_only_empty_or_whitespace_entries_are_empty()
```

**Purpose**: Verifies that `LoadedAgentsMd::is_empty` treats explicit empty or whitespace-only entries as empty even when the entries vector is non-empty.

**Data flow**: Constructs two `LoadedAgentsMd` values manually with internal entries containing `""` and whitespace, then asserts `is_empty()` is true for both.

**Call relations**: This complements the constructor tests by checking the emptiness predicate directly.

*Call graph*: 2 external calls (assert!, vec!).


##### `doc_smaller_than_limit_is_returned`  (lines 422–435)

```
async fn doc_smaller_than_limit_is_returned()
```

**Purpose**: Checks that a small AGENTS file is returned verbatim when it fits within the byte budget and there are no host instructions.

**Data flow**: Writes `AGENTS.md` containing `hello world`, builds a config with a large limit, calls `get_user_instructions`, unwraps the result, and asserts it equals the file contents.

**Call relations**: This is the simplest positive-path content-loading test.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `project_doc_invalid_utf8_uses_lossy_text`  (lines 438–447)

```
async fn project_doc_invalid_utf8_uses_lossy_text()
```

**Purpose**: Verifies that invalid UTF-8 bytes in a project doc are decoded with replacement characters rather than causing failure.

**Data flow**: Writes raw bytes `project\xFF doc` to `AGENTS.md`, loads the structured result with `load_agents_md`, calls `.text()`, and asserts the output contains `\u{FFFD}`.

**Call relations**: This test exercises the `String::from_utf8_lossy` branch in `read_agents_md`.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `doc_larger_than_limit_is_truncated`  (lines 451–464)

```
async fn doc_larger_than_limit_is_truncated()
```

**Purpose**: Checks that a single oversized AGENTS file is truncated exactly to `project_doc_max_bytes`.

**Data flow**: Writes a string twice the configured limit, loads instructions with `get_user_instructions`, and asserts both the resulting length and exact prefix match the configured limit.

**Call relations**: This covers the truncation path in `read_agents_md` for a single file.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `total_byte_limit_truncates_later_project_docs`  (lines 467–498)

```
async fn total_byte_limit_truncates_later_project_docs()
```

**Purpose**: Verifies that when multiple hierarchical project docs are loaded, the byte budget is consumed in order and later docs are truncated once the remaining budget is small.

**Data flow**: Creates a repo root with `.git` and `AGENTS.md = "root"`, a nested cwd with `AGENTS.md = "abcdef"`, sets the limit to 7, loads `LoadedAgentsMd`, constructs the expected entries `"root"` and `"abc"` with provenance, and asserts both the structured value and `.text()` output.

**Call relations**: This test exercises root-to-cwd discovery plus cumulative budget accounting inside `read_agents_md`.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 5 external calls (assert_eq!, create_dir, write, tempdir, vec!).


##### `read_agents_md_propagates_metadata_errors`  (lines 501–516)

```
async fn read_agents_md_propagates_metadata_errors()
```

**Purpose**: Ensures that unexpected metadata failures during discovery are returned to the caller rather than silently ignored.

**Data flow**: Builds a config, targets the `.git` marker path with a `FailingFileSystem` configured for `PermissionDenied` metadata errors, calls `read_agents_md`, expects an error, and asserts its kind is `PermissionDenied`.

**Call relations**: This test drives the error-propagation branch in `agents_md_paths`/`read_agents_md` using the injected filesystem.

*Call graph*: calls 1 internal fn (make_config); 3 external calls (assert_eq!, Metadata, tempdir).


##### `read_agents_md_propagates_read_errors`  (lines 519–534)

```
async fn read_agents_md_propagates_read_errors()
```

**Purpose**: Checks that unexpected file-read failures after successful discovery are propagated as errors.

**Data flow**: Writes `AGENTS.md`, builds a config, wraps the AGENTS path in a `FailingFileSystem` configured for `PermissionDenied` read errors, calls `read_agents_md`, and asserts the returned error kind.

**Call relations**: This complements the metadata-error test by targeting the read phase in `read_agents_md`.

*Call graph*: calls 1 internal fn (make_config); 4 external calls (assert_eq!, Read, write, tempdir).


##### `read_agents_md_ignores_files_removed_after_discovery`  (lines 537–552)

```
async fn read_agents_md_ignores_files_removed_after_discovery()
```

**Purpose**: Verifies that a file disappearing between metadata check and read is treated as a recoverable race and results in no loaded docs rather than an error.

**Data flow**: Writes `AGENTS.md`, builds a config, uses `FailingFileSystem` to inject `NotFound` on read for that path, calls `read_agents_md`, and asserts the result is `None`.

**Call relations**: This test covers the special `NotFound` recovery branch in `read_agents_md` after discovery has already succeeded.

*Call graph*: calls 1 internal fn (make_config); 4 external calls (assert_eq!, Read, write, tempdir).


##### `finds_doc_in_repo_root`  (lines 557–580)

```
async fn finds_doc_in_repo_root()
```

**Purpose**: Checks that when cwd is nested inside a repository, discovery walks up to the repo root marker and loads the root-level AGENTS file.

**Data flow**: Creates a temp repo with a `.git` marker file and root `AGENTS.md`, creates a nested cwd, points config.cwd there, calls `get_user_instructions`, and asserts the returned text is the root doc.

**Call relations**: This is the core project-root traversal test for default `.git` markers.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 5 external calls (assert_eq!, write, create_dir_all, write, tempdir).


##### `zero_byte_limit_disables_docs`  (lines 584–594)

```
async fn zero_byte_limit_disables_docs()
```

**Purpose**: Verifies that setting `project_doc_max_bytes` to zero disables project-doc loading entirely.

**Data flow**: Writes `AGENTS.md`, builds a config with limit 0, calls `get_user_instructions`, and asserts the result is `None`.

**Call relations**: This covers the early-return guard at the top of `read_agents_md`.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 3 external calls (assert!, write, tempdir).


##### `merges_existing_instructions_with_agents_md`  (lines 599–612)

```
async fn merges_existing_instructions_with_agents_md()
```

**Purpose**: Checks that host instructions and project docs are concatenated with `AGENTS_MD_SEPARATOR` when both are present.

**Data flow**: Writes `AGENTS.md = "proj doc"`, builds a config with host instructions `"base instructions"`, calls `get_user_instructions`, constructs the expected combined string with `format!`, and asserts equality.

**Call relations**: This test exercises the user-to-project transition formatting in `LoadedAgentsMd::legacy_text`.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 4 external calls (assert_eq!, format!, write, tempdir).


##### `multiple_environment_docs_use_labeled_layout_and_preserve_source_order`  (lines 615–675)

```
async fn multiple_environment_docs_use_labeled_layout_and_preserve_source_order()
```

**Purpose**: Verifies the multi-environment rendering mode: project docs are grouped and labeled by environment, source order is preserved, and `render()` omits the outer cwd wrapper in favor of inline labels.

**Data flow**: Creates primary and secondary temp environments with AGENTS docs, including hierarchical root and nested docs for primary, builds a config with global instructions, constructs a two-environment snapshot, calls `load_project_instructions`, and asserts `environment_labeled_text()`, `text()`, `render()`, and `sources()` all match the expected labeled ordering.

**Call relations**: This is the main integration test for `LoadedAgentsMd::has_multiple_project_environments`, `environment_labeled_text`, `render`, and `sources` together.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 5 external calls (assert_eq!, format!, create_dir, write, tempdir).


##### `secondary_only_project_doc_uses_single_contributor_layout`  (lines 678–701)

```
async fn secondary_only_project_doc_uses_single_contributor_layout()
```

**Purpose**: Checks that when multiple environments are bound but only one contributes project docs, the loader still uses the legacy single-contributor layout rather than environment labels.

**Data flow**: Creates primary and secondary temp dirs with only secondary containing `AGENTS.md`, builds config with global instructions, loads instructions across both environments, and asserts `legacy_text()`, `text()`, and `render()` use the single-project-doc format for the secondary cwd.

**Call relations**: This test validates that the layout switch depends on contributing project environments, not merely the number of bound environments.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 4 external calls (assert_eq!, format!, write, tempdir).


##### `primary_only_project_doc_preserves_legacy_layout_with_multiple_bound_environments`  (lines 704–727)

```
async fn primary_only_project_doc_preserves_legacy_layout_with_multiple_bound_environments()
```

**Purpose**: Mirrors the previous test for the case where only the primary environment contributes docs. It confirms the same single-contributor formatting rule.

**Data flow**: Creates two environments with only primary containing `AGENTS.md`, loads instructions with global text, and asserts the legacy text and rendered wrapper reference the primary cwd.

**Call relations**: Together with the secondary-only test, this pins down the single-contributor behavior regardless of which environment contributes.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 4 external calls (assert_eq!, format!, write, tempdir).


##### `project_doc_byte_limit_is_applied_independently_per_environment`  (lines 730–754)

```
async fn project_doc_byte_limit_is_applied_independently_per_environment()
```

**Purpose**: Verifies that each environment gets its own full project-doc byte budget rather than sharing one global cap across all environments.

**Data flow**: Creates two environments each with a 5-byte AGENTS file, sets the limit to 3, loads instructions across both, and asserts the final text contains `ABC` for primary and `VWX` for secondary with separate environment labels.

**Call relations**: This test documents the current per-environment budgeting behavior in `load_project_instructions` and `read_agents_md`.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 3 external calls (assert_eq!, write, tempdir).


##### `multiple_environments_can_exceed_single_environment_project_doc_limit`  (lines 757–791)

```
async fn multiple_environments_can_exceed_single_environment_project_doc_limit()
```

**Purpose**: Documents the consequence of per-environment budgeting: combined project-doc bytes across environments can exceed the configured single-environment limit.

**Data flow**: Creates two environments each with an AGENTS file exactly `LIMIT` bytes long, loads instructions with no host text, sums the lengths of project entries in the resulting `LoadedAgentsMd`, and asserts the total is `LIMIT * 2`, greater than `config.project_doc_max_bytes`, while both full docs remain present in the text.

**Call relations**: This is a behavior-specification test for a known limitation noted in the inline TODO.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `secondary_environment_invalid_utf8_does_not_suppress_other_docs`  (lines 794–815)

```
async fn secondary_environment_invalid_utf8_does_not_suppress_other_docs()
```

**Purpose**: Checks that lossy decoding of one environment’s invalid UTF-8 doc does not prevent docs from other environments from being included.

**Data flow**: Writes a valid primary AGENTS file and an invalid-UTF-8 secondary file, loads instructions across both environments, and asserts the final text contains both the valid primary text and the lossy-decoded secondary text.

**Call relations**: This extends the single-environment lossy-decoding test to the multi-environment aggregation path.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 3 external calls (assert!, write, tempdir).


##### `child_agents_guidance_is_appended_once_after_environment_groups`  (lines 818–841)

```
async fn child_agents_guidance_is_appended_once_after_environment_groups()
```

**Purpose**: Verifies that enabling `Feature::ChildAgentsMd` appends exactly one copy of `HIERARCHICAL_AGENTS_MESSAGE` after all environment-derived docs.

**Data flow**: Creates two environments with AGENTS docs, enables the feature on the config, loads instructions, extracts `text`, and asserts the hierarchical message appears exactly once and at the end.

**Call relations**: This test covers the feature-flag append logic in `load_project_instructions` and its interaction with multi-environment rendering.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `keeps_existing_instructions_when_doc_missing`  (lines 846–854)

```
async fn keeps_existing_instructions_when_doc_missing()
```

**Purpose**: Checks that host instructions are preserved unchanged when no project docs are found.

**Data flow**: Builds an empty temp workspace with host instructions, calls `get_user_instructions`, and asserts the result is exactly the original instruction string wrapped in `Some`.

**Call relations**: This is the no-project-doc counterpart to the merge test.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 2 external calls (assert_eq!, tempdir).


##### `concatenates_root_and_cwd_docs`  (lines 859–903)

```
async fn concatenates_root_and_cwd_docs()
```

**Purpose**: Verifies hierarchical discovery from repo root to cwd and confirms both the structured provenance and the rendered text order.

**Data flow**: Creates a repo with `.git`, root `AGENTS.md`, nested cwd `AGENTS.md`, points config.cwd at the nested dir, loads `LoadedAgentsMd`, constructs the expected entries with `project_provenance`, and asserts the struct, `.text()`, and `.sources()` all match.

**Call relations**: This is the main positive-path test for multi-level root-to-cwd concatenation.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 6 external calls (assert_eq!, write, create_dir_all, write, tempdir, vec!).


##### `project_root_markers_are_honored_for_agents_discovery`  (lines 906–933)

```
async fn project_root_markers_are_honored_for_agents_discovery()
```

**Purpose**: Checks that explicitly configured `project_root_markers` replace the default `.git` behavior during AGENTS discovery.

**Data flow**: Creates a root with `.codex-root` and AGENTS doc, a nested child with its own `.git` and AGENTS doc, builds config with markers set to `[".codex-root"]`, points cwd at the child, calls `agents_md_paths` and `get_user_instructions`, and asserts discovery includes both parent and child docs in that order.

**Call relations**: This test exercises the custom-marker branch in `agents_md_paths`.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config_with_project_root_markers); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `project_layers_do_not_override_project_root_markers`  (lines 936–978)

```
async fn project_layers_do_not_override_project_root_markers()
```

**Purpose**: Verifies that project config layers are intentionally ignored when computing root markers for AGENTS discovery, so a project cannot redefine the traversal rule from within project-local config.

**Data flow**: Creates a root repo and nested cwd each with AGENTS docs, builds a config, replaces `config.config_layer_stack` with project layers that set bogus `project_root_markers`, calls `agents_md_paths`, and asserts discovery still follows the default `.git` root and returns root plus nested AGENTS paths.

**Call relations**: This test targets the explicit `if matches!(layer.name, ConfigLayerSource::Project { .. }) { continue; }` logic in `agents_md_paths`.

*Call graph*: calls 3 internal fn (new, agents_md_paths, make_config); 7 external calls (default, assert_eq!, default, create_dir, write, tempdir, vec!).


##### `agents_md_paths_preserve_symlinked_cwd`  (lines 981–998)

```
async fn agents_md_paths_preserve_symlinked_cwd()
```

**Purpose**: Checks that discovery preserves a symlinked cwd path rather than canonicalizing it away, and still finds the AGENTS file through that symlink path.

**Data flow**: Creates a target directory with `AGENTS.md`, creates a symlinked cwd pointing to it, sets config.cwd to the symlink path, calls `agents_md_paths` and `get_user_instructions`, and asserts the discovered path is `cfg.cwd.join("AGENTS.md")` and the loaded text is correct.

**Call relations**: This test documents the non-canonicalizing behavior of AGENTS discovery.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config); 5 external calls (assert_eq!, create_directory_symlink, create_dir, write, tempdir).


##### `child_agents_message_after_global_instructions_uses_plain_separator`  (lines 1001–1024)

```
async fn child_agents_message_after_global_instructions_uses_plain_separator()
```

**Purpose**: Verifies that when only global instructions and internal child-agent guidance are present, they are separated by a plain blank line rather than the project-doc separator.

**Data flow**: Builds a config with host instructions and `Feature::ChildAgentsMd` enabled, loads `LoadedAgentsMd`, constructs the expected struct with one internal entry, and asserts both the struct and `.text()` output.

**Call relations**: This test targets the formatting distinction in `legacy_text` between project and internal entries.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 3 external calls (assert_eq!, tempdir, vec!).


##### `instruction_sources_include_global_before_agents_md_docs`  (lines 1027–1059)

```
async fn instruction_sources_include_global_before_agents_md_docs()
```

**Purpose**: Checks that `sources()` yields the host instruction source first, followed by project AGENTS sources, matching visible instruction order.

**Data flow**: Creates a workspace with project `AGENTS.md`, builds config with host instructions and writes the corresponding global source file, loads `LoadedAgentsMd`, constructs the expected struct, and asserts `user_instructions()`, `sources()`, and `.text()` all match expectations.

**Call relations**: This test exercises provenance ordering and the `LoadedAgentsMd::user_instructions` accessor.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 5 external calls (assert_eq!, create_dir_all, write, tempdir, vec!).


##### `child_agents_message_after_project_docs_is_not_an_instruction_source`  (lines 1062–1100)

```
async fn child_agents_message_after_project_docs_is_not_an_instruction_source()
```

**Purpose**: Verifies that appended internal child-agent guidance appears in the rendered text but does not contribute a file path to `sources()`.

**Data flow**: Creates project and global instructions, enables `ChildAgentsMd`, loads `LoadedAgentsMd`, constructs the expected entries including one internal message, and asserts `sources()` contains only the global and project file paths while `.text()` includes the internal message at the end.

**Call relations**: This test specifically covers `InstructionProvenance::Internal` and `InstructionProvenance::path` behavior.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 5 external calls (assert_eq!, create_dir_all, write, tempdir, vec!).


##### `agents_local_md_preferred`  (lines 1104–1123)

```
async fn agents_local_md_preferred()
```

**Purpose**: Checks that `AGENTS.override.md` is preferred over `AGENTS.md` when both exist in the same directory.

**Data flow**: Writes both files, builds a config, calls `get_user_instructions` and `agents_md_paths`, and asserts the loaded text is from the override file and only that filename appears in discovery.

**Call relations**: This test validates the filename ordering produced by `candidate_filenames`.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `uses_configured_fallback_when_agents_missing`  (lines 1127–1144)

```
async fn uses_configured_fallback_when_agents_missing()
```

**Purpose**: Verifies that a configured fallback filename is used when neither `AGENTS.override.md` nor `AGENTS.md` exists.

**Data flow**: Writes `EXAMPLE.md`, builds a config with fallback filenames containing `EXAMPLE.md`, calls `get_user_instructions`, and asserts the fallback contents are returned.

**Call relations**: This covers the fallback branch in `candidate_filenames` and `agents_md_paths`.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config_with_fallback); 3 external calls (assert_eq!, write, tempdir).


##### `agents_md_preferred_over_fallbacks`  (lines 1148–1176)

```
async fn agents_md_preferred_over_fallbacks()
```

**Purpose**: Checks that standard `AGENTS.md` still wins over configured fallback filenames when both are present.

**Data flow**: Writes both `AGENTS.md` and `EXAMPLE.md`, builds a config with fallbacks, calls `get_user_instructions` and `agents_md_paths`, and asserts the loaded text and discovered filename correspond to `AGENTS.md`.

**Call relations**: This complements the fallback-only test by validating preference order.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config_with_fallback); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `agents_md_directory_is_ignored`  (lines 1179–1190)

```
async fn agents_md_directory_is_ignored()
```

**Purpose**: Verifies that a directory named `AGENTS.md` is not treated as a valid instruction file.

**Data flow**: Creates a directory at `AGENTS.md`, builds a config, calls `get_user_instructions` and `agents_md_paths`, and asserts both return no usable docs.

**Call relations**: This test covers the metadata `is_file` check in discovery and reading.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config); 3 external calls (assert_eq!, create_dir, tempdir).


##### `agents_md_special_file_is_ignored`  (lines 1194–1213)

```
async fn agents_md_special_file_is_ignored()
```

**Purpose**: Checks on Unix that a special file such as a FIFO named `AGENTS.md` is ignored just like a directory.

**Data flow**: Creates a FIFO at `AGENTS.md` with `libc::mkfifo`, builds a config, calls `get_user_instructions` and `agents_md_paths`, and asserts no docs are loaded or discovered.

**Call relations**: This extends the non-regular-file filtering behavior beyond directories.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config); 4 external calls (new, assert_eq!, mkfifo, tempdir).


##### `override_directory_falls_back_to_agents_md_file`  (lines 1216–1237)

```
async fn override_directory_falls_back_to_agents_md_file()
```

**Purpose**: Verifies that if `AGENTS.override.md` exists but is a directory, discovery skips it and falls back to a regular `AGENTS.md` file.

**Data flow**: Creates a directory named `AGENTS.override.md` and a file `AGENTS.md`, builds a config, calls `get_user_instructions` and `agents_md_paths`, and asserts the standard AGENTS file is used.

**Call relations**: This test combines filename preference with regular-file filtering.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config); 4 external calls (assert_eq!, create_dir, write, tempdir).


##### `skills_are_not_appended_to_agents_md`  (lines 1240–1255)

```
async fn skills_are_not_appended_to_agents_md()
```

**Purpose**: Checks that discovered skills under `codex_home/skills` do not automatically contribute to AGENTS instruction text.

**Data flow**: Writes `AGENTS.md`, builds a config, creates a skill via `create_skill`, calls `get_user_instructions`, and asserts the result remains just the AGENTS doc text.

**Call relations**: This guards against accidental coupling between the skills subsystem and AGENTS instruction assembly.

*Call graph*: calls 3 internal fn (create_skill, get_user_instructions, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `apps_feature_does_not_emit_user_instructions_by_itself`  (lines 1258–1267)

```
async fn apps_feature_does_not_emit_user_instructions_by_itself()
```

**Purpose**: Verifies that enabling the `Apps` feature alone does not create AGENTS instructions when no docs or host instructions exist.

**Data flow**: Builds an empty config, enables `Feature::Apps`, calls `get_user_instructions`, and asserts the result is `None`.

**Call relations**: This is a negative regression test ensuring unrelated feature flags do not affect AGENTS loading.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 2 external calls (assert_eq!, tempdir).


##### `apps_feature_does_not_append_to_agents_md_user_instructions`  (lines 1270–1283)

```
async fn apps_feature_does_not_append_to_agents_md_user_instructions()
```

**Purpose**: Checks that enabling the `Apps` feature does not append anything to existing AGENTS-derived instructions.

**Data flow**: Writes `AGENTS.md`, builds a config, enables `Feature::Apps`, calls `get_user_instructions`, and asserts the output remains exactly the AGENTS doc text.

**Call relations**: This complements the previous test for the case where AGENTS docs already exist.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `create_skill`  (lines 1285–1290)

```
fn create_skill(codex_home: PathBuf, name: &str, description: &str)
```

**Purpose**: Creates a minimal skill directory and `SKILL.md` file under a given codex home for tests that need a discovered skill present on disk.

**Data flow**: Takes a `PathBuf` codex home, skill name, and description, builds `skills/<name>` under that home, creates the directory tree, formats frontmatter plus body content, and writes it to `SKILL.md`.

**Call relations**: Only `skills_are_not_appended_to_agents_md` calls this helper to prove skills do not leak into AGENTS instructions.

*Call graph*: called by 1 (skills_are_not_appended_to_agents_md); 4 external calls (join, format!, create_dir_all, write).


### `core/src/personality_migration_tests.rs`

`test` · `test execution`

This test module builds temporary Codex homes, writes rollout JSONL files that look like real sessions, invokes `maybe_migrate_personality`, and inspects both the returned `PersonalityMigrationStatus` and the persisted filesystem state. The helper layer is intentionally concrete: `write_session_with_user_event` and `write_archived_session_with_user_event` choose the active-session and archived-session directories respectively, while `write_rollout_with_user_event` creates a `rollout-<timestamp>-<thread_id>.jsonl` file containing a `RolloutItem::SessionMeta` line followed by a `RolloutItem::EventMsg(EventMsg::UserMessage(...))` line. That shape ensures the thread store sees the fixture as a legitimate recorded session rather than an empty placeholder.

`read_config_toml` reloads the generated `config.toml` and parses it back into `ConfigToml`, letting tests assert on persisted personality values rather than internal builder behavior. The test cases cover: applying migration when active sessions exist, applying when only archived sessions exist, skipping immediately when the marker already exists, skipping but marking when personality was explicitly configured, and skipping with marker creation when no sessions exist. Together they validate idempotence, marker semantics, and the migration's dependence on actual historical session presence.

#### Function details

##### `read_config_toml`  (lines 18–21)

```
async fn read_config_toml(codex_home: &Path) -> io::Result<ConfigToml>
```

**Purpose**: Loads and parses the `config.toml` file from a temporary Codex home so tests can assert on persisted migration output. It converts TOML parse failures into `io::ErrorKind::InvalidData`.

**Data flow**: It takes `codex_home`, joins `config.toml`, reads the file contents as a string with Tokio, then passes the string to `toml::from_str` to produce `ConfigToml`. It returns `io::Result<ConfigToml>` and does not mutate state.

**Call relations**: The migration-application and explicit-personality tests call this after setup or migration to inspect the resulting config file. It delegates only to filesystem read and TOML parsing.

*Call graph*: called by 3 (applies_when_only_archived_sessions_exist_and_no_personality, applies_when_sessions_exist_and_no_personality, skips_when_personality_explicit); 3 external calls (join, read_to_string, from_str).


##### `write_session_with_user_event`  (lines 23–31)

```
async fn write_session_with_user_event(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Creates a synthetic non-archived session fixture under the standard dated sessions directory. It is a convenience wrapper around the lower-level rollout writer.

**Data flow**: It accepts `codex_home`, generates a fresh `ThreadId`, constructs the path `<codex_home>/<SESSIONS_SUBDIR>/2025/01/01`, and forwards that directory plus the thread ID to `write_rollout_with_user_event`. It returns the underlying `io::Result<()>`.

**Call relations**: Only the active-session migration test uses this helper to ensure `maybe_migrate_personality` sees a normal recorded session. It delegates all file creation details to `write_rollout_with_user_event`.

*Call graph*: calls 2 internal fn (write_rollout_with_user_event, new); called by 1 (applies_when_sessions_exist_and_no_personality); 1 external calls (join).


##### `write_archived_session_with_user_event`  (lines 33–37)

```
async fn write_archived_session_with_user_event(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Creates a synthetic archived session fixture under the archived sessions directory. This isolates the branch where migration must detect history outside the active-session tree.

**Data flow**: It takes `codex_home`, generates a fresh `ThreadId`, constructs `<codex_home>/<ARCHIVED_SESSIONS_SUBDIR>`, and calls `write_rollout_with_user_event` with that directory and ID. It returns `io::Result<()>`.

**Call relations**: The archived-session migration test invokes this helper before running the migration. It delegates the actual JSONL file generation to `write_rollout_with_user_event`.

*Call graph*: calls 2 internal fn (write_rollout_with_user_event, new); called by 1 (applies_when_only_archived_sessions_exist_and_no_personality); 1 external calls (join).


##### `write_rollout_with_user_event`  (lines 39–87)

```
async fn write_rollout_with_user_event(dir: &Path, thread_id: ThreadId) -> io::Result<()>
```

**Purpose**: Writes a minimal but valid rollout JSONL file containing session metadata and one user message event. The fixture is shaped to be discoverable by the thread store as a real session.

**Data flow**: Inputs are a target directory and `ThreadId`. It creates the directory tree, builds a filename `rollout-2025-01-01T00-00-00-<thread_id>.jsonl`, opens the file, constructs `SessionMeta`, wraps it in `SessionMetaLine` and `RolloutLine`, constructs a `UserMessageEvent` with message `"hello"`, wraps that in `EventMsg` and `RolloutLine`, serializes both lines with `serde_json::to_string`, and writes them with trailing newlines. It returns `io::Result<()>`.

**Call relations**: Both session-writing helpers call this to avoid duplicating fixture serialization logic. It does not invoke migration code directly; its role is preparing realistic input data for those tests.

*Call graph*: called by 2 (write_archived_session_with_user_event, write_session_with_user_event); 10 external calls (default, join, new, format!, UserMessage, EventMsg, SessionMeta, from, create, create_dir_all).


##### `applies_when_sessions_exist_and_no_personality`  (lines 90–103)

```
async fn applies_when_sessions_exist_and_no_personality() -> io::Result<()>
```

**Purpose**: Verifies that migration applies when a legacy active session exists and no personality is configured. It checks status, marker creation, and persisted config contents.

**Data flow**: The test creates a `TempDir`, writes an active session fixture, constructs `ConfigToml::default()`, calls `maybe_migrate_personality`, then asserts the returned status is `Applied`, the marker file exists, and `read_config_toml` shows `personality == Some(Personality::Pragmatic)`. It writes temporary files and reads them back as part of the assertion flow.

**Call relations**: This test drives the main success path through `maybe_migrate_personality`. It depends on `write_session_with_user_event` for setup and `read_config_toml` for verification.

*Call graph*: calls 2 internal fn (read_config_toml, write_session_with_user_event); 4 external calls (new, assert!, assert_eq!, default).


##### `applies_when_only_archived_sessions_exist_and_no_personality`  (lines 106–119)

```
async fn applies_when_only_archived_sessions_exist_and_no_personality() -> io::Result<()>
```

**Purpose**: Verifies that archived sessions alone are sufficient to trigger migration. This protects the fallback branch that checks archived history after active history is absent.

**Data flow**: It creates a temp home, writes an archived session fixture, uses `ConfigToml::default()`, runs `maybe_migrate_personality`, and asserts `Applied`, marker existence, and persisted `Personality::Pragmatic` in `config.toml`. The test's observable outputs are filesystem writes and assertions.

**Call relations**: This test specifically exercises the second `has_threads` probe reached through `has_recorded_sessions`. It uses `write_archived_session_with_user_event` for setup and `read_config_toml` for postconditions.

*Call graph*: calls 2 internal fn (read_config_toml, write_archived_session_with_user_event); 4 external calls (new, assert!, assert_eq!, default).


##### `skips_when_marker_exists`  (lines 122–132)

```
async fn skips_when_marker_exists() -> io::Result<()>
```

**Purpose**: Checks that an existing migration marker short-circuits all other work. It confirms the migration does not create or modify `config.toml` in that case.

**Data flow**: The test creates a temp home, writes the marker via `create_marker`, constructs default config, calls `maybe_migrate_personality`, and asserts the status is `SkippedMarker` and `config.toml` does not exist. It performs only marker-file setup and result inspection.

**Call relations**: This test targets the earliest return path in `maybe_migrate_personality`. It relies on the production `create_marker` helper to establish the precondition.

*Call graph*: 4 external calls (new, assert!, assert_eq!, default).


##### `skips_when_personality_explicit`  (lines 135–155)

```
async fn skips_when_personality_explicit() -> io::Result<()>
```

**Purpose**: Verifies that an explicitly configured personality is preserved and causes migration to skip while still creating the marker. This ensures the migration never overwrites user intent.

**Data flow**: It creates a temp home, uses `ConfigEditsBuilder` to persist `Personality::Friendly`, reloads that config with `read_config_toml`, runs `maybe_migrate_personality`, then asserts `SkippedExplicitPersonality`, marker existence, and that the persisted personality remains `Friendly`. It writes config before migration and reads it both before and after.

**Call relations**: This test exercises the explicit-config skip branch in `maybe_migrate_personality`. It uses `read_config_toml` to verify both setup and non-destructive behavior.

*Call graph*: calls 2 internal fn (new, read_config_toml); 3 external calls (new, assert!, assert_eq!).


##### `skips_when_no_sessions`  (lines 158–167)

```
async fn skips_when_no_sessions() -> io::Result<()>
```

**Purpose**: Verifies that migration does not create a config file when there is no recorded session history. It still expects the marker to be written so the check is one-time.

**Data flow**: The test creates an empty temp home, uses `ConfigToml::default()`, calls `maybe_migrate_personality`, and asserts the status is `SkippedNoSessions`, the marker exists, and `config.toml` does not exist. No session fixtures are written.

**Call relations**: This test covers the no-history branch after both active and archived thread checks fail. It invokes only the migration entrypoint and inspects the resulting filesystem state.

*Call graph*: 4 external calls (new, assert!, assert_eq!, default).


### `core/src/git_info_tests.rs`

`test` · `test execution`

This module uses real `git` subprocesses to create temporary repositories and then exercises functions from `codex_git_utils`. The helper `create_test_git_repo` initializes a repository with isolated Git config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), sets user identity, writes a file, stages it, and creates an initial commit. `create_test_git_repo_with_remote` extends that setup with a bare remote and upstream branch so tests can compare local state to `origin`.

The tests cover recent commit listing, basic `GitInfo` extraction, branch and detached-HEAD handling, remote URL reporting, and dirty-working-tree detection for both tracked and untracked changes. One Unix-specific test ensures `get_has_changes` does not trigger configured hooks, guarding metadata collection against side effects.

Another cluster validates `git_diff_to_remote`, checking clean repos, modified/untracked files, branch fallback when the current branch lacks an upstream, and unpushed local commits. Finally, several tests focus on trust-root discovery: they verify repository-root detection via `.git` directories and `gitdir:` pointer files, linked worktree resolution back to the main repository root, and rejection of non-worktree `.git` pointers. The last two tests confirm `GitInfo` serializes optional fields correctly, omitting `None` values from JSON.

#### Function details

##### `create_test_git_repo`  (lines 22–77)

```
async fn create_test_git_repo(temp_dir: &TempDir) -> PathBuf
```

**Purpose**: Creates a temporary Git repository with one committed file and isolated Git configuration. It is the foundational fixture for most repository-based tests.

**Data flow**: Reads `temp_dir`, creates `<temp>/repo`, defines environment overrides disabling global/system Git config, runs `git init`, configures `user.name` and `user.email`, writes `test.txt`, runs `git add .` and `git commit -m 'Initial commit'`, and returns the repository `PathBuf`.

**Call relations**: Used by many tests that need a real repository in a known initial state, and by `create_test_git_repo_with_remote`.

*Call graph*: called by 12 (create_test_git_repo_with_remote, resolve_root_git_project_for_trust_detects_worktree_and_returns_main_root, resolve_root_git_project_for_trust_regular_repo_returns_repo_root, test_collect_git_info_detached_head, test_collect_git_info_git_repository, test_collect_git_info_with_branch, test_collect_git_info_with_remote, test_get_has_changes_clean_repo_returns_false, test_get_has_changes_ignores_configured_hooks_path, test_get_has_changes_with_tracked_change_returns_true (+2 more)); 5 external calls (path, new, create_dir, write, vec!).


##### `test_recent_commits_non_git_directory_returns_empty`  (lines 80–84)

```
async fn test_recent_commits_non_git_directory_returns_empty()
```

**Purpose**: Verifies `recent_commits` returns no entries outside a Git repository.

**Data flow**: Creates a temp directory, awaits `recent_commits(temp_dir.path(), 10)`, and asserts the returned list is empty.

**Call relations**: Exercises the non-repository branch of commit listing.

*Call graph*: 3 external calls (new, assert!, recent_commits).


##### `test_recent_commits_orders_and_limits`  (lines 87–152)

```
async fn test_recent_commits_orders_and_limits()
```

**Purpose**: Checks that `recent_commits` returns the newest commits first and respects the requested limit.

**Data flow**: Skips in sandboxed environments, creates a test repo, makes three additional commits with delays between them, calls `recent_commits(&repo_path, 3)`, asserts the subjects are `third change`, `second change`, `first change` in that order, and validates SHA formatting.

**Call relations**: Exercises commit enumeration, ordering, and truncation against a real repository history.

*Call graph*: calls 1 internal fn (create_test_git_repo); 8 external calls (from_millis, new, assert!, assert_eq!, new, recent_commits, write, skip_if_sandbox!).


##### `create_test_git_repo_with_remote`  (lines 154–187)

```
async fn create_test_git_repo_with_remote(temp_dir: &TempDir) -> (PathBuf, String)
```

**Purpose**: Creates a test repository with a bare `origin` remote and pushes the initial branch upstream. It supports tests that compare local state to a remote branch.

**Data flow**: Calls `create_test_git_repo`, creates `<temp>/remote.git` as a bare repo, adds it as `origin`, runs `git rev-parse --abbrev-ref HEAD` to capture the current branch name, pushes `-u origin <branch>`, and returns `(repo_path, branch)`.

**Call relations**: Used by `git_diff_to_remote` tests that need an upstream reference.

*Call graph*: calls 1 internal fn (create_test_git_repo); called by 4 (test_get_git_working_tree_state_branch_fallback, test_get_git_working_tree_state_clean_repo, test_get_git_working_tree_state_unpushed_commit, test_get_git_working_tree_state_with_changes); 3 external calls (from_utf8, path, new).


##### `test_collect_git_info_non_git_directory`  (lines 190–194)

```
async fn test_collect_git_info_non_git_directory()
```

**Purpose**: Verifies `collect_git_info` returns `None` outside a repository.

**Data flow**: Creates a temp directory, awaits `collect_git_info(temp_dir.path())`, and asserts the result is `None`.

**Call relations**: Exercises the non-repository branch of Git metadata collection.

*Call graph*: 3 external calls (new, assert!, collect_git_info).


##### `test_collect_git_info_git_repository`  (lines 197–218)

```
async fn test_collect_git_info_git_repository()
```

**Purpose**: Checks that `collect_git_info` returns commit hash and branch information for a normal repository.

**Data flow**: Creates a test repo, awaits `collect_git_info(&repo_path)`, asserts `commit_hash` is present and 40 hex characters long, asserts `branch` is present and equals `main` or `master`, and leaves remote URL optional.

**Call relations**: Exercises the standard repository metadata path.

*Call graph*: calls 1 internal fn (create_test_git_repo); 4 external calls (new, assert!, assert_eq!, collect_git_info).


##### `test_collect_git_info_with_remote`  (lines 221–257)

```
async fn test_collect_git_info_with_remote()
```

**Purpose**: Verifies `collect_git_info` reports the repository’s remote URL when `origin` is configured.

**Data flow**: Creates a test repo, adds `origin` pointing at a GitHub-style URL, awaits `collect_git_info`, separately runs `git remote get-url origin`, trims the reported URL, and asserts `git_info.repository_url` equals that value.

**Call relations**: Exercises remote URL extraction while tolerating environment-specific URL rewriting.

*Call graph*: calls 1 internal fn (create_test_git_repo); 5 external calls (from_utf8, new, assert_eq!, new, collect_git_info).


##### `test_collect_git_info_detached_head`  (lines 260–289)

```
async fn test_collect_git_info_detached_head()
```

**Purpose**: Checks that detached HEAD repositories still report commit hash but omit branch name.

**Data flow**: Creates a test repo, reads `HEAD` commit hash via `git rev-parse HEAD`, checks out that hash directly, awaits `collect_git_info`, and asserts `commit_hash` is present while `branch` is `None`.

**Call relations**: Exercises detached-HEAD handling in metadata collection.

*Call graph*: calls 1 internal fn (create_test_git_repo); 5 external calls (from_utf8, new, assert!, new, collect_git_info).


##### `test_collect_git_info_with_branch`  (lines 292–310)

```
async fn test_collect_git_info_with_branch()
```

**Purpose**: Verifies `collect_git_info` reports a newly created branch name.

**Data flow**: Creates a test repo, runs `git checkout -b feature-branch`, awaits `collect_git_info`, and asserts `branch == Some("feature-branch")`.

**Call relations**: Exercises branch-name extraction after branch changes.

*Call graph*: calls 1 internal fn (create_test_git_repo); 4 external calls (new, assert_eq!, new, collect_git_info).


##### `test_get_has_changes_non_git_directory_returns_none`  (lines 313–316)

```
async fn test_get_has_changes_non_git_directory_returns_none()
```

**Purpose**: Checks that dirty-state detection returns `None` outside a repository.

**Data flow**: Creates a temp directory, awaits `get_has_changes(temp_dir.path())`, and asserts `None`.

**Call relations**: Exercises the non-repository branch of dirty-state detection.

*Call graph*: 2 external calls (new, assert_eq!).


##### `test_get_has_changes_clean_repo_returns_false`  (lines 319–323)

```
async fn test_get_has_changes_clean_repo_returns_false()
```

**Purpose**: Verifies a freshly committed repository is reported as clean.

**Data flow**: Creates a test repo, awaits `get_has_changes(&repo_path)`, and asserts `Some(false)`.

**Call relations**: Exercises the clean-repository branch of dirty-state detection.

*Call graph*: calls 1 internal fn (create_test_git_repo); 2 external calls (new, assert_eq!).


##### `test_get_has_changes_with_tracked_change_returns_true`  (lines 326–332)

```
async fn test_get_has_changes_with_tracked_change_returns_true()
```

**Purpose**: Checks that modifying a tracked file marks the repository as dirty.

**Data flow**: Creates a test repo, overwrites `test.txt`, awaits `get_has_changes(&repo_path)`, and asserts `Some(true)`.

**Call relations**: Exercises tracked-change detection.

*Call graph*: calls 1 internal fn (create_test_git_repo); 3 external calls (new, assert_eq!, write).


##### `test_get_has_changes_with_untracked_change_returns_true`  (lines 335–341)

```
async fn test_get_has_changes_with_untracked_change_returns_true()
```

**Purpose**: Checks that creating an untracked file marks the repository as dirty.

**Data flow**: Creates a test repo, writes `new_file.txt`, awaits `get_has_changes(&repo_path)`, and asserts `Some(true)`.

**Call relations**: Exercises untracked-file detection.

*Call graph*: calls 1 internal fn (create_test_git_repo); 3 external calls (new, assert_eq!, write).


##### `test_get_has_changes_ignores_configured_hooks_path`  (lines 345–385)

```
async fn test_get_has_changes_ignores_configured_hooks_path()
```

**Purpose**: Verifies dirty-state collection does not execute configured Git hooks, avoiding side effects during metadata reads.

**Data flow**: On Unix, creates a test repo, writes an executable `post-index-change` hook under a custom hooks directory that would create a marker file, configures `core.hooksPath` to that directory, rewrites `test.txt`, awaits `get_has_changes`, asserts the repo is still reported clean, and asserts the marker file was never created.

**Call relations**: Exercises a safety property of dirty-state collection: metadata reads must not invoke hooks.

*Call graph*: calls 1 internal fn (create_test_git_repo); 9 external calls (new, assert!, assert_eq!, new, format!, create_dir_all, metadata, set_permissions, write).


##### `test_get_git_working_tree_state_clean_repo`  (lines 388–408)

```
async fn test_get_git_working_tree_state_clean_repo()
```

**Purpose**: Checks that `git_diff_to_remote` returns the upstream SHA and an empty diff for a clean repository tracking a remote.

**Data flow**: Creates a repo with remote, reads `origin/<branch>` SHA via `git rev-parse`, awaits `git_diff_to_remote(&repo_path)`, and asserts `state.sha` equals that remote SHA and `state.diff` is empty.

**Call relations**: Exercises the clean tracked-remote branch of working-tree state collection.

*Call graph*: calls 1 internal fn (create_test_git_repo_with_remote); 7 external calls (from_utf8, new, assert!, assert_eq!, new, git_diff_to_remote, format!).


##### `test_get_git_working_tree_state_with_changes`  (lines 411–436)

```
async fn test_get_git_working_tree_state_with_changes()
```

**Purpose**: Verifies `git_diff_to_remote` includes both tracked and untracked modifications while still reporting the upstream SHA.

**Data flow**: Creates a repo with remote, modifies `test.txt`, writes `untracked.txt`, reads the remote SHA, awaits `git_diff_to_remote`, and asserts the SHA matches the remote and the diff text mentions both files.

**Call relations**: Exercises dirty working-tree diff generation against a remote base.

*Call graph*: calls 1 internal fn (create_test_git_repo_with_remote); 8 external calls (from_utf8, new, assert!, assert_eq!, new, git_diff_to_remote, format!, write).


##### `test_get_git_working_tree_state_branch_fallback`  (lines 439–478)

```
async fn test_get_git_working_tree_state_branch_fallback()
```

**Purpose**: Checks that when the current local branch lacks an upstream, `git_diff_to_remote` falls back to another relevant remote branch.

**Data flow**: Creates a repo with remote, creates and pushes branch `feature`, creates local branch `local-branch` without pushing it, reads `origin/feature` SHA, awaits `git_diff_to_remote`, and asserts the returned SHA equals the feature branch’s remote SHA.

**Call relations**: Exercises branch-selection fallback logic in remote diff computation.

*Call graph*: calls 1 internal fn (create_test_git_repo_with_remote); 5 external calls (from_utf8, new, assert_eq!, new, git_diff_to_remote).


##### `resolve_root_git_project_for_trust_returns_none_outside_repo`  (lines 481–488)

```
async fn resolve_root_git_project_for_trust_returns_none_outside_repo()
```

**Purpose**: Verifies trust-root resolution returns `None` when the path is not inside any Git repository.

**Data flow**: Creates a temp directory, calls `resolve_root_git_project_for_trust(LOCAL_FS.as_ref(), &tmp.path().abs())`, awaits it, and asserts the result is `None`.

**Call relations**: Exercises the non-repository branch of trust-root discovery.

*Call graph*: 2 external calls (new, assert!).


##### `get_git_repo_root_with_fs_detects_gitdir_pointer`  (lines 491–502)

```
async fn get_git_repo_root_with_fs_detects_gitdir_pointer()
```

**Purpose**: Checks that repository-root detection recognizes a `.git` file containing a `gitdir:` pointer.

**Data flow**: Creates nested directories, writes `.git` in the project root with `gitdir: /tmp/fake-worktree`, calls `get_git_repo_root_with_fs(LOCAL_FS.as_ref(), &nested.abs())`, awaits it, and asserts the result is the project root.

**Call relations**: Exercises `.git` pointer-file handling in repository-root discovery.

*Call graph*: 4 external calls (new, assert_eq!, create_dir_all, write).


##### `resolve_root_git_project_for_trust_regular_repo_returns_repo_root`  (lines 505–519)

```
async fn resolve_root_git_project_for_trust_regular_repo_returns_repo_root()
```

**Purpose**: Verifies trust-root resolution returns the repository root for both the root itself and nested paths inside a normal repository.

**Data flow**: Creates a test repo, normalizes it to an absolute path, calls `resolve_root_git_project_for_trust` on the root and on a created nested subdirectory, and asserts both results equal the repo root.

**Call relations**: Exercises standard repository-root trust resolution.

*Call graph*: calls 1 internal fn (create_test_git_repo); 3 external calls (new, assert_eq!, create_dir_all).


##### `resolve_root_git_project_for_trust_detects_worktree_and_returns_main_root`  (lines 522–561)

```
async fn resolve_root_git_project_for_trust_detects_worktree_and_returns_main_root()
```

**Purpose**: Checks that linked worktrees resolve back to the main repository root for trust decisions.

**Data flow**: Creates a test repo, adds a linked worktree via `git worktree add`, normalizes the main repo path, calls `resolve_root_git_project_for_trust` on the worktree root and a nested path inside it, normalizes the returned paths, and asserts both equal the main repo root.

**Call relations**: Exercises worktree-aware trust-root resolution using real Git worktrees.

*Call graph*: calls 1 internal fn (create_test_git_repo); 6 external calls (new, assert_eq!, new, resolve_root_git_project_for_trust, normalize_for_path_comparison, create_dir_all).


##### `resolve_root_git_project_for_trust_detects_worktree_pointer_without_git_command`  (lines 564–590)

```
async fn resolve_root_git_project_for_trust_detects_worktree_pointer_without_git_command()
```

**Purpose**: Verifies worktree pointer files alone are sufficient to resolve the main repository root without invoking Git commands.

**Data flow**: Creates a fake repo root with `.git/worktrees/feature-x`, creates a separate worktree root whose `.git` file points at that worktree git dir, calls `resolve_root_git_project_for_trust` on the worktree root and nested path, and asserts both resolve to the repo root.

**Call relations**: Exercises filesystem-only worktree pointer resolution.

*Call graph*: 5 external calls (new, assert_eq!, format!, create_dir_all, write).


##### `resolve_root_git_project_for_trust_non_worktrees_gitdir_returns_none`  (lines 593–620)

```
async fn resolve_root_git_project_for_trust_non_worktrees_gitdir_returns_none()
```

**Purpose**: Checks that `.git` pointer files not pointing into a `worktrees` layout are not treated as valid trust roots.

**Data flow**: Creates a project with nested directories, writes a `.git` file pointing at an unrelated location, calls `resolve_root_git_project_for_trust` on the project root and nested path, and asserts both results are `None`.

**Call relations**: Exercises rejection of non-worktree pointer files in trust-root discovery.

*Call graph*: 5 external calls (new, assert!, format!, create_dir_all, write).


##### `test_get_git_working_tree_state_unpushed_commit`  (lines 623–657)

```
async fn test_get_git_working_tree_state_unpushed_commit()
```

**Purpose**: Verifies `git_diff_to_remote` reports local unpushed commits as diff content while keeping the upstream SHA as the base.

**Data flow**: Creates a repo with remote, reads the remote SHA, modifies and commits `test.txt` locally without pushing, awaits `git_diff_to_remote`, and asserts the SHA matches the remote while the diff contains `updated`.

**Call relations**: Exercises remote-diff behavior when local history is ahead of upstream.

*Call graph*: calls 1 internal fn (create_test_git_repo_with_remote); 8 external calls (from_utf8, new, assert!, assert_eq!, new, git_diff_to_remote, format!, write).


##### `test_git_info_serialization`  (lines 660–676)

```
fn test_git_info_serialization()
```

**Purpose**: Checks that `GitInfo` serializes populated optional fields into JSON with the expected keys and values.

**Data flow**: Constructs a `GitInfo` with commit hash, branch, and repository URL, serializes it with `serde_json::to_string`, parses it back into `serde_json::Value`, and asserts each field matches the original data.

**Call relations**: Exercises serde serialization for the populated case.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, from_str, to_string).


##### `test_git_info_serialization_with_nones`  (lines 679–693)

```
fn test_git_info_serialization_with_nones()
```

**Purpose**: Verifies `GitInfo` omits `None` fields during JSON serialization.

**Data flow**: Constructs a `GitInfo` with all fields `None`, serializes and parses it as JSON, and asserts the resulting object contains none of the optional field keys.

**Call relations**: Exercises `skip_serializing_if` behavior on the data model.

*Call graph*: 3 external calls (assert!, from_str, to_string).


### `core/src/shell_tests.rs`

`test` · `test execution`

This test module covers the lightweight shell abstraction in `shell.rs`. Several tests validate detection behavior: macOS should resolve zsh at `/bin/zsh`, unsupported fish login shells should fall back to zsh on macOS, generic bash and sh detection should return executables whose filenames match the requested shell type, and Windows should find PowerShell as both the default user shell and an explicit shell lookup. The tests intentionally inspect concrete paths or path suffixes rather than only shell types, because downstream execution depends on a real executable path.

The central behavioral test is `can_run_on_shell_test`, which uses the helper `shell_works` to actually spawn each detected shell with a simple command and assert successful execution plus expected stdout. This confirms that `derive_exec_args` produces a valid argv layout for each shell family, including PowerShell and `cmd` on Windows and fallback/default shells on Unix. The dedicated `derive_exec_args` test then checks exact vectors for bash, zsh, and PowerShell, including the login-shell distinction (`-c` vs `-lc`) and PowerShell's `-NoProfile` suppression for non-login execution. Finally, `test_current_shell_detects_zsh` compares `default_user_shell()` against the environment's `$SHELL` when it ends in zsh, giving a sanity check that runtime detection aligns with the host shell configuration.

#### Function details

##### `detects_zsh`  (lines 7–13)

```
fn detects_zsh()
```

**Purpose**: Asserts that explicit zsh detection on macOS resolves to `/bin/zsh`.

**Data flow**: Calls `get_shell(ShellType::Zsh, None)`, unwraps the returned `Shell`, extracts `shell_path`, and compares it to `Path::new("/bin/zsh")`.

**Call relations**: Platform-specific detection test for the zsh branch of shell lookup.

*Call graph*: 1 external calls (assert_eq!).


##### `fish_fallback_to_zsh`  (lines 17–23)

```
fn fish_fallback_to_zsh()
```

**Purpose**: Verifies that an unsupported fish login shell path falls back to zsh on macOS.

**Data flow**: Builds `Some(PathBuf::from("/bin/fish"))`, passes it to `default_user_shell_from_path`, extracts the resulting `shell_path`, and asserts it equals `/bin/zsh`.

**Call relations**: Exercises the macOS-specific fallback helper exposed only for tests.

*Call graph*: 2 external calls (from, assert_eq!).


##### `detects_bash`  (lines 26–34)

```
fn detects_bash()
```

**Purpose**: Checks that bash detection returns an executable whose filename is `bash`.

**Data flow**: Calls `get_shell(ShellType::Bash, None)`, unwraps the shell, reads `shell_path.file_name()`, converts it to `&str`, and asserts it matches `Some("bash")`.

**Call relations**: Basic detection test for the bash lookup path.

*Call graph*: 1 external calls (assert!).


##### `detects_sh`  (lines 37–44)

```
fn detects_sh()
```

**Purpose**: Checks that `sh` detection returns an executable whose filename is `sh`.

**Data flow**: Calls `get_shell(ShellType::Sh, None)`, unwraps the shell, reads the filename from `shell_path`, and asserts it matches `Some("sh")`.

**Call relations**: Basic detection test for the POSIX `sh` lookup path.

*Call graph*: 1 external calls (assert!).


##### `can_run_on_shell_test`  (lines 47–87)

```
fn can_run_on_shell_test()
```

**Purpose**: Runs a simple command through the detected shells for the current platform and asserts that each required shell actually works.

**Data flow**: Builds a command string, branches on `cfg!(windows)`, and for each relevant shell calls `shell_works(...)`; asserts each returned boolean according to whether the shell is required or optional.

**Call relations**: High-level integration test that ties shell detection and `derive_exec_args` together by executing real subprocesses.

*Call graph*: 2 external calls (assert!, cfg!).


##### `shell_works`  (lines 89–102)

```
fn shell_works(shell: Option<Shell>, command: &str, required: bool) -> bool
```

**Purpose**: Helper that executes a command through an optional `Shell` and reports whether the shell was available and produced the expected output.

**Data flow**: Takes `shell: Option<Shell>`, `command`, and `required`; if `Some`, derives argv with `shell.derive_exec_args`, spawns `std::process::Command`, captures output, asserts success and stdout containing `Works`, and returns `true`; if `None`, returns `!required`.

**Call relations**: Used only by `can_run_on_shell_test` to normalize optional-shell behavior across platforms.

*Call graph*: 2 external calls (assert!, new).


##### `derive_exec_args`  (lines 105–144)

```
fn derive_exec_args()
```

**Purpose**: Checks the exact argv vectors produced for bash, zsh, and PowerShell in login and non-login modes.

**Data flow**: Constructs concrete `Shell` values with fixed paths, calls `derive_exec_args` with `echo hello` and both `use_login_shell` settings, and asserts the returned `Vec<String>` matches the expected literals.

**Call relations**: Direct unit test for the shell-specific branching in `Shell::derive_exec_args`.

*Call graph*: 2 external calls (from, assert_eq!).


##### `test_current_shell_detects_zsh`  (lines 147–164)

```
async fn test_current_shell_detects_zsh()
```

**Purpose**: Sanity-checks that `default_user_shell()` matches the runtime `$SHELL` environment when the host shell is zsh.

**Data flow**: Runs `sh -c 'echo $SHELL'`, decodes stdout to a trimmed string, and if it ends with `/zsh`, asserts `default_user_shell()` equals a `Shell { shell_type: Zsh, shell_path: PathBuf::from(shell_path) }`.

**Call relations**: Cross-checks default shell detection against the environment rather than only static lookup.

*Call graph*: 3 external calls (from_utf8_lossy, assert_eq!, new).


##### `detects_powershell_as_default`  (lines 167–176)

```
async fn detects_powershell_as_default()
```

**Purpose**: Verifies on Windows that the detected default user shell is a PowerShell executable.

**Data flow**: Returns early when not on Windows; otherwise calls `default_user_shell()`, reads `shell_path`, and asserts it ends with `pwsh.exe` or `powershell.exe`.

**Call relations**: Windows-specific default-shell detection test.

*Call graph*: 2 external calls (assert!, cfg!).


##### `finds_powershell`  (lines 179–188)

```
fn finds_powershell()
```

**Purpose**: Verifies on Windows that explicit PowerShell lookup succeeds and resolves to a PowerShell executable path.

**Data flow**: Returns early when not on Windows; otherwise calls `get_shell(ShellType::PowerShell, None)`, unwraps the shell, reads `shell_path`, and asserts it ends with `pwsh.exe` or `powershell.exe`.

**Call relations**: Windows-specific explicit shell lookup test.

*Call graph*: 2 external calls (assert!, cfg!).


### `core/src/shell_snapshot_tests.rs`

`test` · `test execution`

This test module targets the snapshot subsystem end to end. It includes a Unix-only `BlockingStdinPipe` helper that temporarily replaces process stdin with a pipe whose write end stays open, allowing tests to verify that spawned snapshot shells receive `Stdio::null()` rather than inheriting a blocking stdin. Several tests focus on snapshot text correctness: `strip_snapshot_preamble` must discard startup noise but require the marker, filename parsing must accept both legacy and nonce-suffixed snapshot names, and bash snapshot scripts must exclude invalid export names such as `PWD`, names with dashes, and test harness variables while still preserving multiline values in a form that can be sourced successfully.

The async tests cover lifecycle semantics of `ShellSnapshot::try_create`: files are created under a temp directory, distinct generations for the same session get distinct paths, and dropping the guard deletes only the owned file. Process-management tests verify that timed-out snapshot shells are actually terminated and that shell startup scripts observing stdin see EOF rather than hanging. Platform-specific smoke tests assert that generated snapshots contain the expected sections for zsh, bash, sh, and PowerShell. Cleanup tests build fake rollout files and snapshot directories to confirm that orphaned or malformed snapshots are removed, stale rollouts trigger deletion after the retention window, and the active session is exempt from cleanup.

#### Function details

##### `BlockingStdinPipe::install`  (lines 23–57)

```
fn install() -> Result<Self>
```

**Purpose**: Replaces the process stdin file descriptor with the read end of a pipe while preserving the original stdin for later restoration.

**Data flow**: Creates a pipe with `libc::pipe`, duplicates `STDIN_FILENO` with `dup`, swaps stdin to the pipe's read end with `dup2`, closes temporary descriptors on success or failure, and returns a `BlockingStdinPipe` holding the original stdin fd and the pipe write end.

**Call relations**: Used only by `snapshot_shell_does_not_inherit_stdin` to create a hostile stdin setup that would block if child processes inherited it.

*Call graph*: called by 1 (snapshot_shell_does_not_inherit_stdin); 5 external calls (last_os_error, close, dup, dup2, pipe).


##### `BlockingStdinPipe::drop`  (lines 62–68)

```
fn drop(&mut self)
```

**Purpose**: Restores the original stdin and closes the temporary pipe descriptors when the guard goes out of scope.

**Data flow**: On drop, calls `dup2(self.original, STDIN_FILENO)` and closes both `self.original` and `self.write_end`; no return value.

**Call relations**: Runs automatically after stdin-isolation tests, ensuring the process test environment is restored.

*Call graph*: 2 external calls (close, dup2).


##### `assert_posix_snapshot_sections`  (lines 72–81)

```
fn assert_posix_snapshot_sections(snapshot: &str)
```

**Purpose**: Checks that a POSIX snapshot contains the expected major sections and at least one PATH export.

**Data flow**: Reads `snapshot: &str` and asserts presence of `# Snapshot file`, `aliases`, `exports`, `PATH`, and `setopts` markers; no return value.

**Call relations**: Shared by the Linux and macOS snapshot smoke tests to avoid duplicating section assertions.

*Call graph*: called by 3 (linux_bash_snapshot_includes_sections, linux_sh_snapshot_includes_sections, macos_zsh_snapshot_includes_sections); 1 external calls (assert!).


##### `get_snapshot`  (lines 83–89)

```
async fn get_snapshot(shell_type: ShellType) -> Result<String>
```

**Purpose**: Generates a snapshot file for a given shell type in a temporary directory and returns its contents.

**Data flow**: Creates a temp directory, computes `snapshot.sh`, calls `write_shell_snapshot(shell_type, ...)`, reads the file back with `fs::read_to_string`, and returns the content as `Result<String>`.

**Call relations**: Used by platform-specific smoke tests to exercise the real snapshot-writing path rather than only script generation.

*Call graph*: called by 4 (linux_bash_snapshot_includes_sections, linux_sh_snapshot_includes_sections, macos_zsh_snapshot_includes_sections, windows_powershell_snapshot_includes_sections); 2 external calls (read_to_string, tempdir).


##### `strip_snapshot_preamble_removes_leading_output`  (lines 92–96)

```
fn strip_snapshot_preamble_removes_leading_output()
```

**Purpose**: Verifies that leading noise before the snapshot marker is discarded.

**Data flow**: Supplies a synthetic snapshot string with a noise prefix to `strip_snapshot_preamble`, unwraps the result, and asserts the returned string starts at `# Snapshot file`.

**Call relations**: Direct unit test for the preamble-stripping helper.

*Call graph*: 1 external calls (assert_eq!).


##### `strip_snapshot_preamble_requires_marker`  (lines 99–102)

```
fn strip_snapshot_preamble_requires_marker()
```

**Purpose**: Verifies that snapshot output lacking the required marker is rejected.

**Data flow**: Calls `strip_snapshot_preamble` with a string missing the marker and asserts that the result is an error.

**Call relations**: Complements the successful preamble test by covering the failure path.

*Call graph*: 1 external calls (assert!).


##### `snapshot_file_name_parser_supports_legacy_and_suffixed_names`  (lines 105–124)

```
fn snapshot_file_name_parser_supports_legacy_and_suffixed_names()
```

**Purpose**: Checks that snapshot filename parsing accepts legacy, generation-suffixed, and temp-file formats while rejecting unrelated files.

**Data flow**: Builds several filename strings around a fixed session id, passes each to `snapshot_session_id_from_file_name`, and asserts the expected `Some(session_id)` or `None` result.

**Call relations**: Unit test for the parser used by stale snapshot cleanup.

*Call graph*: 1 external calls (assert_eq!).


##### `bash_snapshot_filters_invalid_exports`  (lines 128–148)

```
fn bash_snapshot_filters_invalid_exports() -> Result<()>
```

**Purpose**: Ensures the generated bash snapshot script excludes unstable or invalid environment variable names from exported output.

**Data flow**: Runs `/bin/bash -c <bash_snapshot_script()>` with controlled environment variables, captures stdout, and asserts that valid names appear while `PWD`, a test harness variable with an invalid name pattern, and a dashed name do not.

**Call relations**: Directly exercises the embedded bash script logic rather than the higher-level snapshot writer.

*Call graph*: 3 external calls (from_utf8_lossy, assert!, new).


##### `bash_snapshot_preserves_multiline_exports`  (lines 152–188)

```
fn bash_snapshot_preserves_multiline_exports() -> Result<()>
```

**Purpose**: Verifies that multiline exported values survive snapshot generation and can be sourced back into bash successfully.

**Data flow**: Runs the bash snapshot script with a multiline `MULTILINE_CERT` env var, asserts the name appears in stdout, writes stdout to a temp snapshot file, then launches bash to source that file and asserts successful validation.

**Call relations**: Regression test for export serialization correctness in the bash snapshot script.

*Call graph*: 5 external calls (from_utf8_lossy, assert!, new, write, tempdir).


##### `try_create_creates_and_deletes_snapshot_file`  (lines 192–216)

```
async fn try_create_creates_and_deletes_snapshot_file() -> Result<()>
```

**Purpose**: Checks that `ShellSnapshot::try_create` produces a real file and that dropping the returned guard deletes it.

**Data flow**: Creates a temp directory and a concrete bash `Shell`, awaits `ShellSnapshot::try_create`, clones the resulting path, asserts the file exists, drops the snapshot guard, and asserts the file no longer exists.

**Call relations**: End-to-end lifecycle test for snapshot creation and `Drop` cleanup.

*Call graph*: calls 2 internal fn (try_create, new); 3 external calls (from, assert!, tempdir).


##### `try_create_uses_distinct_generation_paths`  (lines 220–262)

```
async fn try_create_uses_distinct_generation_paths() -> Result<()>
```

**Purpose**: Ensures repeated snapshot creation for the same session uses distinct filenames and independent ownership semantics.

**Data flow**: Creates two snapshots for the same `session_id`, captures both paths, asserts they differ and both exist, drops the first guard and confirms only its file disappears, then drops the second and confirms its file is removed too.

**Call relations**: Covers the nonce-based generation naming and per-handle deletion behavior in `try_create` and `ShellSnapshotFile::drop`.

*Call graph*: calls 2 internal fn (try_create, new); 4 external calls (from, assert_eq!, assert_ne!, tempdir).


##### `snapshot_shell_does_not_inherit_stdin`  (lines 266–312)

```
async fn snapshot_shell_does_not_inherit_stdin() -> Result<()>
```

**Purpose**: Verifies that snapshot shell subprocesses receive EOF on stdin instead of inheriting the parent's potentially blocking stdin.

**Data flow**: Installs `BlockingStdinPipe`, writes a `.bashrc` that performs a timed `read` and records its exit status, constructs a bash snapshot script with `HOME` pointed at the temp directory, runs `run_script_with_timeout`, reads the recorded status file, and asserts the startup `read` saw EOF (`1`) and the snapshot marker appears in output.

**Call relations**: Exercises the low-level subprocess setup in `run_script_with_timeout`, specifically its `stdin(Stdio::null())` behavior.

*Call graph*: calls 1 internal fn (install); 8 external calls (from_secs, from, assert!, assert_eq!, format!, read_to_string, write, tempdir).


##### `timed_out_snapshot_shell_is_terminated`  (lines 316–369)

```
async fn timed_out_snapshot_shell_is_terminated() -> Result<()>
```

**Purpose**: Checks that a snapshot shell process killed by timeout does not remain alive after the command future returns an error.

**Data flow**: Runs `/bin/sh` with a script that writes its PID then sleeps, expects `run_script_with_timeout` to return a timeout error, reads the PID file, and polls `kill -0` until the process disappears or a grace deadline is exceeded.

**Call relations**: Regression test for `kill_on_drop(true)` and timeout handling in the snapshot subprocess runner.

*Call graph*: 12 external calls (from_secs, now, from, new, null, from_millis, from_secs, assert!, format!, read_to_string (+2 more)).


##### `macos_zsh_snapshot_includes_sections`  (lines 373–377)

```
async fn macos_zsh_snapshot_includes_sections() -> Result<()>
```

**Purpose**: Smoke-tests that a zsh snapshot generated on macOS contains the standard POSIX sections.

**Data flow**: Awaits `get_snapshot(ShellType::Zsh)`, passes the returned text to `assert_posix_snapshot_sections`, and returns `Result<()>`.

**Call relations**: Platform-specific integration test for zsh snapshot generation.

*Call graph*: calls 2 internal fn (assert_posix_snapshot_sections, get_snapshot).


##### `linux_bash_snapshot_includes_sections`  (lines 381–385)

```
async fn linux_bash_snapshot_includes_sections() -> Result<()>
```

**Purpose**: Smoke-tests that a bash snapshot generated on Linux contains the standard POSIX sections.

**Data flow**: Awaits `get_snapshot(ShellType::Bash)`, validates the content with `assert_posix_snapshot_sections`, and returns `Result<()>`.

**Call relations**: Platform-specific integration test for bash snapshot generation.

*Call graph*: calls 2 internal fn (assert_posix_snapshot_sections, get_snapshot).


##### `linux_sh_snapshot_includes_sections`  (lines 389–393)

```
async fn linux_sh_snapshot_includes_sections() -> Result<()>
```

**Purpose**: Smoke-tests that an `sh` snapshot generated on Linux contains the standard POSIX sections.

**Data flow**: Awaits `get_snapshot(ShellType::Sh)`, validates the content with `assert_posix_snapshot_sections`, and returns `Result<()>`.

**Call relations**: Platform-specific integration test for portable `sh` snapshot generation.

*Call graph*: calls 2 internal fn (assert_posix_snapshot_sections, get_snapshot).


##### `windows_powershell_snapshot_includes_sections`  (lines 398–404)

```
async fn windows_powershell_snapshot_includes_sections() -> Result<()>
```

**Purpose**: Ignored Windows smoke test that checks a PowerShell snapshot contains the expected major sections.

**Data flow**: Awaits `get_snapshot(ShellType::PowerShell)` and asserts the returned text contains the snapshot marker plus alias and export sections.

**Call relations**: Provides future-facing coverage for PowerShell snapshot support, though it is currently ignored.

*Call graph*: calls 1 internal fn (get_snapshot); 1 external calls (assert!).


##### `write_rollout_stub`  (lines 406–416)

```
async fn write_rollout_stub(codex_home: &Path, session_id: ThreadId) -> Result<PathBuf>
```

**Purpose**: Creates a fake rollout file in the expected dated session directory layout for cleanup tests.

**Data flow**: Builds `sessions/2025/01/01`, creates the directory tree, writes an empty `rollout-...-{session_id}.jsonl` file, and returns its `PathBuf`.

**Call relations**: Helper used by stale snapshot cleanup tests to simulate live or stale session rollout metadata.

*Call graph*: called by 3 (cleanup_stale_snapshots_removes_orphans_and_keeps_live, cleanup_stale_snapshots_removes_stale_rollouts, cleanup_stale_snapshots_skips_active_session); 4 external calls (join, format!, create_dir_all, write).


##### `cleanup_stale_snapshots_removes_orphans_and_keeps_live`  (lines 419–442)

```
async fn cleanup_stale_snapshots_removes_orphans_and_keeps_live() -> Result<()>
```

**Purpose**: Verifies that cleanup removes orphaned and malformed snapshot files while preserving snapshots with a matching rollout.

**Data flow**: Creates a temp `codex_home`, snapshot directory, one live rollout stub, live/orphan/invalid snapshot files, runs `cleanup_stale_snapshots`, and asserts the live snapshot remains while orphan and invalid files are deleted.

**Call relations**: Integration test for the main cleanup decision tree: valid live session, missing rollout, and malformed filename.

*Call graph*: calls 2 internal fn (write_rollout_stub, new); 5 external calls (assert_eq!, format!, create_dir_all, write, tempdir).


##### `cleanup_stale_snapshots_removes_stale_rollouts`  (lines 446–463)

```
async fn cleanup_stale_snapshots_removes_stale_rollouts() -> Result<()>
```

**Purpose**: Verifies that snapshots tied to rollout files older than the retention window are deleted.

**Data flow**: Creates a stale rollout stub and snapshot file, backdates the rollout mtime with `set_file_mtime`, runs `cleanup_stale_snapshots`, and asserts the snapshot file is gone.

**Call relations**: Covers the age-based expiration branch in cleanup logic.

*Call graph*: calls 3 internal fn (set_file_mtime, write_rollout_stub, new); 6 external calls (from_secs, assert_eq!, format!, create_dir_all, write, tempdir).


##### `cleanup_stale_snapshots_skips_active_session`  (lines 467–484)

```
async fn cleanup_stale_snapshots_skips_active_session() -> Result<()>
```

**Purpose**: Verifies that cleanup does not delete the active session's snapshot even if its rollout appears stale.

**Data flow**: Creates an active-session rollout and snapshot, backdates the rollout mtime, runs `cleanup_stale_snapshots` with that same session id as active, and asserts the snapshot still exists.

**Call relations**: Covers the explicit active-session exemption in cleanup logic.

*Call graph*: calls 3 internal fn (set_file_mtime, write_rollout_stub, new); 6 external calls (from_secs, assert_eq!, format!, create_dir_all, write, tempdir).


##### `set_file_mtime`  (lines 487–503)

```
fn set_file_mtime(path: &Path, age: Duration) -> Result<()>
```

**Purpose**: Backdates a file's modification time by a requested age using `utimensat` for retention-window tests.

**Data flow**: Computes a Unix timestamp as `now - age`, converts it into `libc::timespec`, builds a C string path from the OS string bytes, calls `libc::utimensat`, and returns `Result<()>` or the OS error.

**Call relations**: Used by stale-rollout cleanup tests to simulate files older than `SNAPSHOT_RETENTION`.

*Call graph*: called by 2 (cleanup_stale_snapshots_removes_stale_rollouts, cleanup_stale_snapshots_skips_active_session); 6 external calls (as_secs, as_os_str, now, last_os_error, utimensat, new).


### `core/src/realtime_context_tests.rs`

`test` · `test execution`

This file is a focused test module for the realtime context assembly logic defined in the parent module. It builds realistic `StoredThread` fixtures, `ResponseItem::Message` conversation items, and temporary directory trees, then asserts on the exact strings returned by `build_current_thread_section`, `build_recent_work_section`, `build_workspace_section_with_user_root`, `format_section`, and `format_startup_context_blob`. The helper constructors keep the tests concrete: `stored_thread` fills every important `StoredThread` field, including timestamps, cwd, git metadata, approval mode, and a read-only permission profile; `message`, `user_message`, and `assistant_message` create protocol-level chat items; `long_turn_text` generates oversized turns with recognizable start/middle/end markers so truncation behavior can be checked precisely.

The tests cover several invariants that are easy to miss from implementation alone. Current-thread history must be ordered newest-first by turn pair, preserve the latest turns when over budget, and truncate long turns by keeping both the beginning and end while inserting a truncation marker. Startup context wrapping is intentionally non-lossy at the blob level: section budgets are enforced independently, and the final `<startup_context>` wrapper must not apply another truncation pass. Workspace summaries are omitted when the directory has no meaningful structure, include visible tree entries when present, and show a separate user-root tree only when it is distinct from the working area, excluding hidden dotfiles in the asserted case. Recent-work summaries are expected to group sessions by git repo or plain directory and surface the first user ask for each stored thread.

#### Function details

##### `stored_thread`  (lines 30–69)

```
fn stored_thread(cwd: &str, title: &str, first_user_message: &str) -> StoredThread
```

**Purpose**: Builds a fully populated `StoredThread` fixture with deterministic timestamps, cwd, git info, and preview fields so recent-work tests can exercise grouping and rendering logic without depending on external storage.

**Data flow**: It takes `cwd`, `title`, and `first_user_message` strings and constructs a `StoredThread` value. The function converts the cwd into a `PathBuf`, conditionally sets `name` only when `title` is non-empty, stamps fixed `created_at` and `updated_at` `Utc` times, inserts a synthetic `GitInfo` with branch `main` and commit `abcdef`, uses `ThreadId::new()` for a fresh id, and sets `permission_profile` to `PermissionProfile::read_only()`. It returns the assembled struct without mutating external state.

**Call relations**: This helper is only used by `recent_work_section_groups_threads_by_cwd`, which needs multiple realistic thread records spanning different directories. It does not delegate to project logic beyond basic constructors and profile helpers; its role is to centralize fixture setup so the test can focus on `build_recent_work_section` behavior.

*Call graph*: calls 3 internal fn (read_only, new, new); 1 external calls (from).


##### `message`  (lines 71–79)

```
fn message(role: &str, content: ContentItem) -> ResponseItem
```

**Purpose**: Creates a protocol `ResponseItem::Message` with a single content item and a caller-specified role.

**Data flow**: It accepts a role string slice and a `ContentItem`, converts the role into an owned `String`, wraps the content in a one-element `Vec`, and returns `ResponseItem::Message { id: None, role, content, phase: None, metadata: None }`. No shared state is read or written.

**Call relations**: This is the common constructor used by `user_message` and `assistant_message`. Those wrappers supply the role-specific `ContentItem` variants so tests can build conversation histories for `build_current_thread_section` with minimal duplication.

*Call graph*: called by 2 (assistant_message, user_message); 1 external calls (vec!).


##### `user_message`  (lines 81–83)

```
fn user_message(text: impl Into<String>) -> ResponseItem
```

**Purpose**: Builds a single user chat message containing `ContentItem::InputText` from arbitrary text input.

**Data flow**: It takes any `Into<String>` text, converts it into a `String`, wraps it as `ContentItem::InputText`, and passes that plus the literal role `"user"` into `message`. It returns the resulting `ResponseItem` and does not touch external state.

**Call relations**: This helper is used when tests need user turns in synthetic thread histories, notably in `current_thread_section_keeps_latest_turns_when_history_exceeds_budget` and also directly in other current-thread tests. It delegates all message-shape construction to `message` so the tests stay focused on section output.

*Call graph*: calls 1 internal fn (message); called by 1 (current_thread_section_keeps_latest_turns_when_history_exceeds_budget); 1 external calls (into).


##### `assistant_message`  (lines 85–87)

```
fn assistant_message(text: impl Into<String>) -> ResponseItem
```

**Purpose**: Builds a single assistant chat message containing `ContentItem::OutputText` from arbitrary text input.

**Data flow**: It accepts any `Into<String>` text, converts it into a `String`, wraps it as `ContentItem::OutputText`, and calls `message` with the literal role `"assistant"`. It returns the constructed `ResponseItem` without side effects.

**Call relations**: This helper pairs with `user_message` in the current-thread history tests, especially `current_thread_section_keeps_latest_turns_when_history_exceeds_budget`. It exists so those tests can alternate user and assistant turns while reusing the shared `message` constructor.

*Call graph*: calls 1 internal fn (message); called by 1 (current_thread_section_keeps_latest_turns_when_history_exceeds_budget); 1 external calls (into).


##### `long_turn_text`  (lines 89–95)

```
fn long_turn_text(index: usize) -> String
```

**Purpose**: Generates an intentionally oversized turn body with stable markers at the beginning, middle, and end so truncation tests can verify which portions survive.

**Data flow**: It takes a numeric `index` and returns a formatted `String` containing `turn-{index}-start`, a repeated `head filler` segment, `turn-{index}-middle`, a repeated `tail filler` segment, and `turn-{index}-end`. It reads no external state and writes nothing.

**Call relations**: The helper is consumed by `current_thread_section_keeps_latest_turns_when_history_exceeds_budget` and conceptually supports truncation-oriented assertions by producing text large enough to exceed section budgets. It does not call project code; it prepares deterministic input for `build_current_thread_section`.

*Call graph*: called by 1 (current_thread_section_keeps_latest_turns_when_history_exceeds_budget); 1 external calls (format!).


##### `current_thread_section_includes_short_turns_newest_first_until_budget`  (lines 98–145)

```
fn current_thread_section_includes_short_turns_newest_first_until_budget()
```

**Purpose**: Verifies that a short conversation history is rendered as complete user/assistant turn pairs in reverse chronological order, with the newest pair labeled `Latest turn` and older pairs labeled `Previous turn N`.

**Data flow**: The test constructs a `Vec<ResponseItem>` containing four alternating user and assistant messages, passes it to `build_current_thread_section`, and compares the returned `Option<String>` against one exact expected multiline string. The only output is the assertion result.

**Call relations**: This test directly exercises `build_current_thread_section` under the non-truncating case where all turns fit within budget. It does not delegate to local helpers in the call graph facts, instead supplying explicit fixture data to validate ordering and section headings.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `current_thread_turn_truncation_preserves_start_and_end`  (lines 148–161)

```
fn current_thread_turn_truncation_preserves_start_and_end()
```

**Purpose**: Checks that when a single turn is too long, the current-thread formatter drops the middle rather than the edges and emits a truncation notice.

**Data flow**: It builds a one-item vector containing a long user message, calls `build_current_thread_section`, unwraps the resulting section string, and asserts a tuple of booleans: the output must contain the start marker and end marker, must not contain the middle marker, and must contain `tokens truncated`. No persistent state is modified.

**Call relations**: This test targets the truncation branch inside `build_current_thread_section`. It supplies oversized input specifically to force the formatter to summarize a turn rather than omit it entirely, validating the implementation's preserve-both-ends strategy.

*Call graph*: 3 external calls (assert_eq!, build_current_thread_section, vec!).


##### `current_thread_section_keeps_latest_turns_when_history_exceeds_budget`  (lines 164–183)

```
fn current_thread_section_keeps_latest_turns_when_history_exceeds_budget()
```

**Purpose**: Ensures that when many long turns exceed the section budget, the formatter retains the newest turns and drops older history instead of spreading truncation evenly across all turns.

**Data flow**: It incrementally builds a `Vec<ResponseItem>` for eight user/assistant turn pairs, using `long_turn_text` for large user messages and formatted assistant replies, then passes the full history to `build_current_thread_section`. The test asserts that the resulting string includes markers from turn 8 and a `Previous turn 2` heading, while excluding markers from turn 1.

**Call relations**: This test combines the local helpers `user_message`, `assistant_message`, and `long_turn_text` to create budget pressure before invoking `build_current_thread_section`. Its role in the suite is to verify recency prioritization once the formatter can no longer include the entire thread.

*Call graph*: calls 3 internal fn (assistant_message, long_turn_text, user_message); 4 external calls (new, assert_eq!, format!, build_current_thread_section).


##### `startup_context_blob_is_wrapped_in_tags_without_final_truncation`  (lines 186–194)

```
fn startup_context_blob_is_wrapped_in_tags_without_final_truncation()
```

**Purpose**: Confirms that the final startup-context formatter only wraps the provided body in `<startup_context>` tags and preserves the body content verbatim.

**Data flow**: It defines a small body string containing the startup header and a section heading, passes it to `format_startup_context_blob`, and asserts exact equality with the expected tagged string including leading and trailing newlines. There are no side effects.

**Call relations**: This test isolates `format_startup_context_blob` from section-building concerns. It verifies the final wrapping stage used after individual sections have already been prepared, ensuring no extra truncation or rewriting occurs at blob assembly time.

*Call graph*: 2 external calls (assert_eq!, format_startup_context_blob).


##### `fixed_section_budgets_apply_per_section_without_total_blob_truncation`  (lines 197–236)

```
fn fixed_section_budgets_apply_per_section_without_total_blob_truncation()
```

**Purpose**: Validates that each startup-context section is truncated according to its own token budget and that the combined blob still contains all section headings inside the wrapper.

**Data flow**: The test builds a body by concatenating `STARTUP_CONTEXT_HEADER` with four calls to `format_section`, each using a different section title, repeated oversized content, and the corresponding budget constant. It then wraps the joined body with `format_startup_context_blob` and asserts that the result starts and ends with the wrapper tags, contains `tokens truncated`, and still includes all four section headings.

**Call relations**: This test exercises `format_section` repeatedly and then `format_startup_context_blob` to verify the intended two-stage formatting pipeline. It demonstrates that truncation is local to each section and that the final blob assembler should not perform a second global budget pass.

*Call graph*: 3 external calls (assert!, format_section, format_startup_context_blob).


##### `workspace_section_requires_meaningful_structure`  (lines 239–245)

```
async fn workspace_section_requires_meaningful_structure()
```

**Purpose**: Checks that the workspace section is omitted entirely for an empty temporary directory with no meaningful tree to report.

**Data flow**: It creates a fresh `TempDir`, converts its path to an absolute path via the test-support extension, calls `build_workspace_section_with_user_root` with no user root, and asserts that the async result is `None`. The test only creates and later drops the temporary directory.

**Call relations**: This async test drives the early-exit path of `build_workspace_section_with_user_root`. It establishes the invariant that the startup context should not include a workspace map section when there is no useful filesystem structure to summarize.

*Call graph*: 2 external calls (new, assert_eq!).


##### `workspace_section_includes_tree_when_entries_exist`  (lines 248–260)

```
async fn workspace_section_includes_tree_when_entries_exist()
```

**Purpose**: Verifies that a non-empty working directory produces a workspace section containing a visible tree listing of directories and files.

**Data flow**: It creates a temporary directory, adds a `docs` subdirectory and `README.md` file with `std::fs`, then awaits `build_workspace_section_with_user_root` on the absolute cwd path with no user root. The returned section string is asserted to contain `Working directory tree:`, `- docs/`, and `- README.md`.

**Call relations**: This test exercises the normal filesystem-scanning path of `build_workspace_section_with_user_root`. By creating concrete entries before the call, it verifies that the builder emits a tree summary rather than returning `None`.

*Call graph*: 5 external calls (new, assert!, create_dir, write, build_workspace_section_with_user_root).


##### `workspace_section_includes_user_root_tree_when_distinct`  (lines 263–282)

```
async fn workspace_section_includes_user_root_tree_when_distinct()
```

**Purpose**: Checks that when a separate user root exists apart from the cwd, the workspace section includes a distinct `User root tree:` summary and excludes hidden files in the asserted output.

**Data flow**: It creates a temporary root containing separate `cwd`, `git`, and `home` directories; populates cwd with visible files, creates a `.git` directory and `Cargo.toml` under the git root, and adds both a visible `code/` child and hidden `.zshrc` file under the user root. It then awaits `build_workspace_section_with_user_root` with the cwd absolute path and `Some(user_root)`, asserting that the section contains `User root tree:` and `- code/` but not `- .zshrc`.

**Call relations**: This async test targets the branch in `build_workspace_section_with_user_root` that emits both working-directory and user-root summaries when they are distinct locations. Its setup intentionally mixes visible and hidden entries to verify filtering behavior in the rendered tree.

*Call graph*: 5 external calls (new, assert!, create_dir_all, write, build_workspace_section_with_user_root).


##### `recent_work_section_groups_threads_by_cwd`  (lines 285–332)

```
async fn recent_work_section_groups_threads_by_cwd()
```

**Purpose**: Verifies that recent sessions are grouped by git repository when applicable, otherwise by plain directory, and that each entry surfaces the stored first user request.

**Data flow**: The test creates a temporary repo root, initializes git via `Command::new("git")`, creates two workspace directories inside the repo and one outside it, then builds three `StoredThread` fixtures with `stored_thread`. It calls `build_recent_work_section` with the current cwd set to one workspace and the thread list, awaits the section string, and asserts that the output contains a `### Git repo:` heading for the repo path, `Recent sessions: 2`, `User asks:`, an entry for the current workspace's first user message, a separate `### Directory:` heading for the outside path, and the outside thread's ask text.

**Call relations**: This is the highest-level integration test in the file for recent-work summarization. It uses `stored_thread` to prepare realistic metadata, then invokes `build_recent_work_section` to validate grouping logic across repo-contained and non-repo directories under actual filesystem conditions.

*Call graph*: 7 external calls (new, assert!, new, create_dir, create_dir_all, build_recent_work_section, vec!).


### `core/src/realtime_conversation_tests.rs`

`test` · `test execution`

This file is a pure test module that exercises the concrete edge cases around converting a `RealtimeHandoffRequested` payload into text or XML-like delegation input, plus a small state mutation check for `RealtimeHandoffState` and version-specific websocket header behavior. Most tests build a `codex_protocol::protocol::RealtimeHandoffRequested` with explicit `handoff_id`, `item_id`, `input_transcript`, and `active_transcript: Vec<RealtimeTranscriptEntry>` values, then assert exact string outputs. The assertions establish an important precedence rule: a non-empty `input_transcript` wins over any `active_transcript`, while an empty input falls back to a newline-joined `role: text` rendering of transcript entries, and fully empty handoff content yields `None`. Separate tests verify `realtime_delegation_from_handoff` and `wrap_realtime_delegation_input` produce the exact `<realtime_delegation>` envelope, including optional `<transcript_delta>` insertion and XML escaping for `<`, `>`, and `&` in both input and transcript text.

The async test constructs `RealtimeHandoffState::new(...)` with a bounded async channel and confirms the `active_handoff` mutex-protected field can be set and then explicitly cleared to `None`, rather than only changing through higher-level flows. The final two tests pin down protocol-version behavior in `realtime_request_headers`: `RealtimeWsVersion::V1` must emit `openai-alpha: quicksilver=v1`, while `V2` must omit that header entirely. Together these tests serve as executable specification for formatting, fallback, escaping, and version gating.

#### Function details

##### `prefers_handoff_input_transcript_over_active_transcript`  (lines 14–34)

```
fn prefers_handoff_input_transcript_over_active_transcript()
```

**Purpose**: Verifies that handoff text extraction prefers the top-level `input_transcript` string even when `active_transcript` contains user/assistant entries. This locks in the precedence rule for downstream delegation formatting.

**Data flow**: Creates a `RealtimeHandoffRequested` with non-empty `input_transcript` and a two-entry `active_transcript`, passes a shared reference into `realtime_text_from_handoff_request`, and compares the returned `Option<String>` against `Some("ignored".to_string())`. It does not mutate external state; the only output is the assertion result.

**Call relations**: This is a standalone unit test run by the Rust test harness. It exercises the extraction helper indirectly as a specification check and delegates all behavior under test to `realtime_text_from_handoff_request`, failing if that helper ever starts preferring transcript entries over explicit input.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `extracts_text_from_handoff_request_active_transcript_if_input_missing`  (lines 37–51)

```
fn extracts_text_from_handoff_request_active_transcript_if_input_missing()
```

**Purpose**: Checks the fallback path where an empty `input_transcript` causes extraction to synthesize text from `active_transcript`. It confirms the exact `role: text` formatting used for a single transcript entry.

**Data flow**: Builds a `RealtimeHandoffRequested` whose `input_transcript` is `String::new()` and whose `active_transcript` contains one `RealtimeTranscriptEntry { role: "user", text: "hello" }`. The test feeds that struct to `realtime_text_from_handoff_request` and asserts the function returns `Some("user: hello".to_string())`.

**Call relations**: Invoked only by the test runner, this test covers the branch taken when explicit handoff input is absent. It delegates the actual formatting logic to `realtime_text_from_handoff_request` and ensures callers can rely on transcript fallback instead of receiving `None` prematurely.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `wraps_handoff_with_transcript_delta`  (lines 54–77)

```
fn wraps_handoff_with_transcript_delta()
```

**Purpose**: Validates end-to-end conversion from a handoff request into the wrapped realtime delegation payload, including transcript delta emission. It confirms both the chosen input source and the exact multiline XML-like layout.

**Data flow**: Constructs a `RealtimeHandoffRequested` with `input_transcript` set to `delegate this` and two active transcript entries, then passes it to `realtime_delegation_from_handoff`. The returned `Option<String>` is asserted to equal a fully expanded `<realtime_delegation>` block containing `<input>` and `<transcript_delta>` sections with newline-separated transcript lines.

**Call relations**: This test is called by the harness and targets the higher-level wrapper helper rather than the lower-level text extractor alone. It verifies that `realtime_delegation_from_handoff` composes transcript extraction and wrapping correctly when both explicit input and transcript history are present.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `extracts_text_from_handoff_request_input_transcript_if_messages_missing`  (lines 80–91)

```
fn extracts_text_from_handoff_request_input_transcript_if_messages_missing()
```

**Purpose**: Confirms that a non-empty `input_transcript` still produces text when there are no transcript messages at all. This protects the no-history handoff case from being treated as empty.

**Data flow**: Creates a `RealtimeHandoffRequested` with `input_transcript` set to `ignored` and `active_transcript` as an empty vector, then calls `realtime_text_from_handoff_request`. The assertion expects `Some("ignored".to_string())`.

**Call relations**: Run directly by the test harness, this test covers the branch where transcript fallback data is unavailable. It delegates to `realtime_text_from_handoff_request` and ensures the helper does not require transcript entries when explicit input exists.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `ignores_empty_handoff_request_input_transcript`  (lines 94–102)

```
fn ignores_empty_handoff_request_input_transcript()
```

**Purpose**: Checks the fully empty case: no input transcript and no active transcript entries should yield no extracted text. It defines the boundary between meaningful handoff content and absence of content.

**Data flow**: Builds a `RealtimeHandoffRequested` with `input_transcript: String::new()` and `active_transcript: vec![]`, passes it to `realtime_text_from_handoff_request`, and asserts the result is `None`. No shared state is read or written beyond the assertion.

**Call relations**: This test is another direct harness entry that exercises the helper’s empty-input branch. It ensures callers of `realtime_text_from_handoff_request` can distinguish an empty handoff from one that should be serialized.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `wraps_realtime_delegation_input`  (lines 105–110)

```
fn wraps_realtime_delegation_input()
```

**Purpose**: Verifies the basic wrapper output when only input text is present and no transcript delta is supplied. It fixes the exact tag structure and indentation of the generated payload.

**Data flow**: Passes the literal input `"hello"` and `None` for the transcript delta into `wrap_realtime_delegation_input`, then asserts the returned string equals a two-line `<realtime_delegation>` block containing only `<input>hello</input>`. The function under test is pure and no state changes occur.

**Call relations**: Executed by the test runner, this test isolates the low-level wrapping helper from handoff parsing concerns. It delegates all formatting behavior to `wrap_realtime_delegation_input` and guards against accidental changes to the serialized envelope.

*Call graph*: 1 external calls (assert_eq!).


##### `wraps_realtime_delegation_input_with_xml_escaping`  (lines 113–118)

```
fn wraps_realtime_delegation_input_with_xml_escaping()
```

**Purpose**: Ensures the wrapper escapes XML-sensitive characters in both the input body and the optional transcript delta. This prevents malformed delegation payloads when user text contains `<`, `>`, or `&`.

**Data flow**: Calls `wrap_realtime_delegation_input` with input text `use a < b && c > d` and transcript delta `Some("saw <that>")`. It asserts the returned string contains `&lt;`, `&gt;`, and `&amp;` substitutions in the corresponding `<input>` and `<transcript_delta>` elements.

**Call relations**: This harness-invoked unit test targets the escaping branch of `wrap_realtime_delegation_input`. It demonstrates that the helper is responsible not just for wrapping but also for sanitizing embedded text before serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `wraps_realtime_delegation_input_with_xml_escaping_without_transcript`  (lines 121–126)

```
fn wraps_realtime_delegation_input_with_xml_escaping_without_transcript()
```

**Purpose**: Checks that XML escaping still occurs when no transcript delta is present, so escaping is not accidentally tied to the optional second field. It covers the pure-input branch with special characters.

**Data flow**: Invokes `wrap_realtime_delegation_input` with `"use a < b && c > d"` and `None`, then compares the returned string to an expected `<realtime_delegation>` block whose `<input>` content is escaped and which omits `<transcript_delta>` entirely.

**Call relations**: Called only by the test harness, this test complements the previous escaping test by covering the no-transcript path. It ensures `wrap_realtime_delegation_input` applies escaping uniformly regardless of optional transcript inclusion.

*Call graph*: 1 external calls (assert_eq!).


##### `clears_active_handoff_explicitly`  (lines 129–146)

```
async fn clears_active_handoff_explicitly()
```

**Purpose**: Verifies that `RealtimeHandoffState`’s `active_handoff` field can be manually set and then explicitly cleared back to `None`. This confirms the mutex-protected state behaves as a normal mutable optional handoff marker.

**Data flow**: Creates a bounded async channel with capacity 1, constructs `RealtimeHandoffState::new(tx, false, None, RealtimeSessionKind::V1)`, acquires the async lock on `state.active_handoff` to write `Some("handoff_1".to_string())`, reads it back for assertion, then locks again to write `None` and asserts the cleared value. The test mutates only the in-memory state object it creates.

**Call relations**: This async test is run by Tokio’s test runtime rather than the plain test harness because it awaits mutex locks. It delegates initialization to `RealtimeHandoffState::new` and then directly manipulates the exposed `active_handoff` field to validate state semantics independent of higher-level conversation flows.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, bounded).


##### `uses_quicksilver_alpha_header_for_realtime_v1`  (lines 149–161)

```
fn uses_quicksilver_alpha_header_for_realtime_v1()
```

**Purpose**: Confirms that realtime websocket header construction for protocol version V1 includes the legacy alpha negotiation header. It pins the exact header name and value expected by the upstream service.

**Data flow**: Calls `realtime_request_headers(Some("session_1"), Some("sk-test"), RealtimeWsVersion::V1)`, unwraps the nested `Result<Option<_>>`, reads the `openai-alpha` header from the returned header map, converts it to `&str`, and asserts it equals `Some("quicksilver=v1")`.

**Call relations**: Invoked by the test harness, this test covers the version-gated branch in `realtime_request_headers`. It ensures callers constructing V1 websocket requests continue to send the compatibility header required for that protocol version.

*Call graph*: 2 external calls (assert_eq!, realtime_request_headers).


##### `omits_quicksilver_alpha_header_for_realtime_v2`  (lines 164–171)

```
fn omits_quicksilver_alpha_header_for_realtime_v2()
```

**Purpose**: Checks that realtime websocket header construction for protocol version V2 does not include the V1-only alpha header. This prevents stale compatibility metadata from leaking into newer protocol requests.

**Data flow**: Calls `realtime_request_headers(Some("session_1"), Some("sk-test"), RealtimeWsVersion::V2)`, unwraps the returned headers, and asserts that `headers.get("openai-alpha")` is `None`. The test reads but does not modify any external state.

**Call relations**: This test is the counterpart to the V1 header test and is run directly by the harness. It exercises the alternate branch in `realtime_request_headers`, ensuring version selection controls header emission exactly as intended.

*Call graph*: 2 external calls (assert!, realtime_request_headers).
