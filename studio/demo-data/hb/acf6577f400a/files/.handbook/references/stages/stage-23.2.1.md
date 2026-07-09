# Core src runtime, session, policy, and state tests  `stage-23.2.1`

This stage is a behind-the-scenes safety net for the core runtime. It does not add user features itself. Instead, these tests check that the main conversation engine starts, runs turns, saves state, resumes later, and shuts work down safely. The session tests cover conversation setup, history, settings refresh, hooks, metrics, network rules, plan-mode messages, user shell commands, and worker-failure messages. Rollout, thread, history, compaction, event-mapping, stream, image, and client-request tests make sure saved or streaming conversation data is cleaned, shortened, restored, and sent to APIs in the right shape. Agent tests cover parent and child agents: spawning, roles, registries, delegation, concurrency limits, memory residency, cancellation, and resuming agent trees. Guardian, MCP, execution-policy, sandbox, and patch-safety tests check the permission system that decides what commands, tools, and file edits may run. State, metadata, timing, diff-tracking, Git, shell, AGENTS.md, personality migration, and realtime tests check supporting records and environment details. Together, these tests act like gauges around the engine, warning when lifecycle, safety, or saved-state behavior changes unexpectedly.

## Files in this stage

### Session lifecycle tests
These tests cover the core session engine, including turn handling, guardian approval paths, rollout reconstruction, and related state semantics.

### `core/src/session/tests.rs`

`test` · `test execution`

A session is the project’s live conversation container. It remembers the thread history, starts turns, applies configuration, sends events to the outside world, and decides what tools and network access are available. These tests act like a safety checklist for that container. They create small fake sessions, feed them messages or settings, and then check that the session does the expected thing: emits a “turn started” event promptly, aborts cleanly, reloads user config without changing fixed session settings, rebuilds history from saved transcripts, strips broken images before saving history, and keeps managed network proxy rules from leaking into places where they should not apply. The file also tests smaller parsing and validation rules, such as how assistant message streams hide citation tags, how app mentions inside skill text are detected, and how a requested network policy change must match the host being approved. Without these tests, subtle regressions could make resumed chats lose context, tools run with the wrong network restrictions, hooks fail to refresh, or users see raw internal markup. The helper functions are like test props on a stage: they build realistic messages, telemetry clients, hook files, fake model sessions, and tool runtimes so each test can exercise one behavior clearly. A session is the running state of a Codex conversation: what has been said, which model and permissions are active, what extensions can observe, and what has been saved to disk for resume, fork, or rollback. The tests in this part of the file exercise the parts that are easy to break because they depend on history and timing. They check that token counts use the session's actual instructions, that extensions are told about turn starts, turn errors, token usage, and config changes, and that forked conversations rebuild the right starting context. They also test rollback, which is like rewinding a tape: the system must remove the right completed turns, preserve or recompute the remaining state, and record a marker so future replays understand what happened. Other tests cover permission profile details, rate-limit updates that arrive in partial pieces, and how tool results are converted into assistant-readable payloads. Without these tests, subtle changes could silently corrupt conversation history, notify extensions with the wrong data, lose billing or limit information, or send misleading context to the model. This test file acts like a workshop full of small safety checks for sessions. A session is the running conversation state: which model is used, what folder the agent is working in, what files it may read or write, what network rules apply, what skills are enabled, and how thread history is saved. Without tests like these, a settings update could silently give access to the wrong folder, forget a deny rule, lose thread rollback data, or send incomplete analytics.

The file includes both actual tests and helper builders. The helpers create temporary configuration folders, fake authentication, model information, environment managers, skill managers, and other services so tests can run without depending on a real user setup. Think of them as building a miniature stage set: it looks enough like a real session for the important behavior to be tested, but it is disposable and controlled.

The tests in this chunk focus on several themes: converting tool-call results into output payloads, waiting for rollback events, choosing service tiers, applying session setting updates, preserving sandbox file rules, changing working directories, rebuilding network proxy settings, honoring role-specific skill settings, and failing startup when a required shell feature is unavailable. This part of the test file builds realistic test sessions and then exercises the rules that matter when a Codex session is running. A session is the long-lived conversation state: it knows the current thread, model settings, working environments, granted permissions, event channels, tracing data, and shutdown state. The helper functions here assemble a session with temporary folders, fake authentication, model information, plugin and skill managers, and channels for observing emitted events. The tests then check important edge cases. For example, resumed root sessions should use the restored thread as their session identity, while resumed subagents should keep the parent session identity. Permission tests make sure requests are matched by call id, grants are stored on the right turn or session, and permissions are tied to the correct environment. Other tests verify that path-like permission requests are resolved against the selected environment, not the wrong working directory. The tracing tests check that work keeps the right distributed trace context, like passing a tracking ticket through each handoff. The shutdown tests make sure active turns are aborted before thread-stop callbacks run, multiple waiters can wait for shutdown, and no extra thread-store writes happen after shutdown. This part of the test file checks many small but important promises made by the session system. A session is the running conversation state: it knows the model, tools, permissions, environment details, history, and any child or helper agents. These tests build fake sessions with temporary folders, fake authentication, in-memory message channels, and offline model information so they can exercise the real session code without calling outside services.

The tests focus on practical failure points. They verify that shutting down a parent session also shuts down cached or temporary guardian review sessions. They check that environment changes, network rules, time changes, realtime conversation state, model switches, and multi-agent hints are inserted into the conversation only when needed. They also confirm that extension-provided prompt text is included only when extension state says it should be.

Another theme is persistence: the session must remember the right context baseline and write it to rollout history, which is the saved record used to resume a thread. The file also tests image-generation history messages and skill-list trimming, so the model sees useful instructions without exceeding its context budget. In short, these tests protect the glue between configuration, conversation history, tool setup, and saved session state. This part of the test file checks how a session behaves under realistic stress. A session is like the control desk for a conversation: it starts a turn, feeds input to the model or tools, records what should be remembered, and sends events back to the client. The tests here make sure that this control desk does not lose important context, does not mix new input into the wrong turn, and sends client events in the right order.

Several tests focus on interruption. They check that cancelled turns emit a model-visible marker before the final abort event, that review mode exits cleanly, and that repeated guardian denials stop a turn. Others focus on “steering,” which means adding user input to an already-running turn, and on mailbox messages between agents, making sure late messages wait for the correct turn unless new input reopens delivery. The file also tests persistence of rollout history, thread-idle extension hooks, voice-list responses, fatal tool errors, shell cleanup on cancellation, and security rules around escalated command permissions.

The small fake task types in this chunk are test tools. They simulate tasks that finish immediately, never finish, or repeatedly trigger guardian denials, so the session machinery can be tested without relying on real model calls.

#### Function details

##### `user_message`  (lines 187–197)

```
fn user_message(text: &str) -> ResponseItem
```

**Purpose**: Builds a fake user chat message for tests. It lets tests create realistic conversation history without repeating the full message structure every time.

**Data flow**: It receives plain text, wraps that text as user input content, and returns a ResponseItem marked with the role "user". It does not change any outside state.

**Call relations**: Several rollback and turn-start tests call this helper when they need user messages in a transcript. It hands back a ready-made message that those tests can insert into session history.

*Call graph*: called by 8 (recompute_token_usage_uses_session_base_instructions, thread_rollback_persists_marker_and_replays_cumulatively, thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay, thread_rollback_restores_cleared_reference_context_item_after_compaction, try_start_turn_if_idle_rejects_active_review_turn_without_injecting, try_start_turn_if_idle_rejects_active_turn_without_injecting, try_start_turn_if_idle_rejects_pending_trigger_turn_without_injecting, try_start_turn_if_idle_rejects_plan_mode_without_injecting); 1 external calls (vec!).


##### `assistant_message`  (lines 199–209)

```
fn assistant_message(text: &str) -> ResponseItem
```

**Purpose**: Builds a fake assistant reply for tests. It is the assistant-side companion to user_message.

**Data flow**: It receives plain text, wraps that text as assistant output content, and returns a ResponseItem marked with the role "assistant". Nothing is written elsewhere.

**Call relations**: Rollback tests use it to make saved conversation history look like a real exchange between user and assistant. The resulting item is later replayed or inspected by the session logic under test.

*Call graph*: called by 3 (thread_rollback_persists_marker_and_replays_cumulatively, thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay, thread_rollback_restores_cleared_reference_context_item_after_compaction); 1 external calls (vec!).


##### `test_session_telemetry_without_metadata`  (lines 211–231)

```
fn test_session_telemetry_without_metadata() -> SessionTelemetry
```

**Purpose**: Creates a test telemetry object that records metrics in memory instead of sending them to a real metrics service. This makes metric assertions fast and self-contained.

**Data flow**: It creates an in-memory metric exporter, builds a MetricsClient around it, then creates SessionTelemetry with test model and source values. It returns that telemetry object with metadata tags disabled.

**Call relations**: Metric-focused tests call this helper before exercising session telemetry behavior. It supplies the fake measuring equipment that later assertions can read.

*Call graph*: calls 4 internal fn (new, new, in_memory, new); called by 2 (emit_thread_start_skill_metrics_records_description_truncated_chars_without_omitted_skills, emit_thread_start_skill_metrics_records_enabled_kept_and_truncated_values); 2 external calls (default, env!).


##### `find_metric`  (lines 233–242)

```
fn find_metric(resource_metrics: &'a ResourceMetrics, name: &str) -> &'a Metric
```

**Purpose**: Looks up one named metric inside collected test metrics. It fails loudly if the metric is missing, which makes test failures clear.

**Data flow**: It receives a ResourceMetrics bundle and a metric name, walks through each metric group, and returns the matching Metric reference. If no match exists, it panics with the missing name.

**Call relations**: histogram_sum uses this as its first step. Together they let tests move from a large metrics dump to one specific measured value.

*Call graph*: called by 1 (histogram_sum); 2 external calls (scope_metrics, panic!).


##### `histogram_sum`  (lines 244–257)

```
fn histogram_sum(resource_metrics: &ResourceMetrics, name: &str) -> u64
```

**Purpose**: Reads the total sum from a histogram metric in test telemetry. A histogram is a metric that groups measured values, and this helper extracts the one total the tests care about.

**Data flow**: It receives collected metrics and a metric name, finds that metric, checks that it is a floating-point histogram with exactly one data point, rounds the sum, and returns it as an integer. If the metric has the wrong shape, it panics.

**Call relations**: It builds on find_metric. Tests that need to assert aggregate metric values can call this instead of knowing the nested telemetry format.

*Call graph*: calls 1 internal fn (find_metric); 2 external calls (assert_eq!, panic!).


##### `skill_message`  (lines 259–269)

```
fn skill_message(text: &str) -> ResponseItem
```

**Purpose**: Builds a user-style message that contains skill text. In these tests, a skill is a block of instructions that may mention external apps or connectors.

**Data flow**: It receives text, stores it as user input text inside a ResponseItem, and returns that item. It is structurally the same as a user message, but the name signals that the text represents skill content.

**Call relations**: This helper feeds skill-parsing tests with realistic ResponseItem input. The app-id collection logic then reads the returned message and searches its text for connector mentions.

*Call graph*: 1 external calls (vec!).


##### `regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm`  (lines 272–322)

```
async fn regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm()
```

**Purpose**: Checks that a normal turn announces that it started right away, even if startup prewarming is still blocked. It also verifies that tracing information is preserved.

**Data flow**: The test creates a parent trace context, starts a session inside that trace, installs a startup prewarm task that never completes, then starts a regular task. It reads the first session event and expects a TurnStarted event with the same turn id and trace id, then aborts the task for cleanup.

**Call relations**: The async test runner calls this test. It uses make_session_and_context_with_rx for a session and event receiver, test_model_client_session for the blocked prewarm handle, and session task APIs to prove event emission does not wait on prewarm completion.

*Call graph*: calls 5 internal fn (make_session_and_context_with_rx, test_model_client_session, new, new, install_test_tracing); 10 external calls (clone, new, assert!, assert_eq!, info_span!, panic!, from_millis, now, spawn, timeout).


##### `request_mcp_server_elicitation_auto_accepts_when_auto_deny_is_enabled`  (lines 325–365)

```
async fn request_mcp_server_elicitation_auto_accepts_when_auto_deny_is_enabled()
```

**Purpose**: Verifies a special MCP server prompt path: when automatic denial is enabled, the session accepts the elicitation locally without sending anything to the user. MCP is a tool/server protocol; an elicitation is a server asking the user for extra input.

**Data flow**: The test creates a session, turns on auto-deny for elicitations, builds a simple empty form schema, and asks the session to request an elicitation. It expects an Accept response with empty content, confirms nothing was sent outward, and confirms no event appeared on the receiver.

**Call relations**: The test runner invokes it directly. It exercises Session::request_mcp_server_elicitation through a real test session and checks both the returned response and the absence of outbound events.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 5 external calls (String, assert!, assert_eq!, json!, from_value).


##### `interrupting_regular_turn_waiting_on_startup_prewarm_emits_turn_aborted`  (lines 368–425)

```
async fn interrupting_regular_turn_waiting_on_startup_prewarm_emits_turn_aborted()
```

**Purpose**: Checks that interrupting a turn that is waiting on startup prewarm still produces a clear abort event. This prevents the user interface from getting stuck thinking a turn is active.

**Data flow**: The test creates a session, installs a startup prewarm task that waits forever, starts a regular task, receives the TurnStarted event, then aborts all tasks. It then expects a raw marker item followed by a TurnAborted event with the right turn id, reason, completion time, and duration.

**Call relations**: The async test runner calls it. It uses test_model_client_session to build the suspended prewarm session and relies on the session event channel to observe the start and abort sequence.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, test_model_client_session, new, new); 10 external calls (clone, new, assert!, assert_eq!, panic!, from_millis, from_secs, now, spawn, timeout).


##### `test_model_client_session`  (lines 427–442)

```
fn test_model_client_session() -> crate::client::ModelClientSession
```

**Purpose**: Builds a fake model client session for tests that need a model connection object but do not need a real network call.

**Data flow**: It creates a fixed test thread id, builds a ModelClient using an OpenAI-style provider configuration and test settings, then returns a new ModelClientSession from it.

**Call relations**: Startup-prewarm tests call this inside a spawned task. It supplies the object those tests would receive if prewarming finished successfully.

*Call graph*: calls 3 internal fn (new, create_openai_provider, try_from); called by 2 (interrupting_regular_turn_waiting_on_startup_prewarm_emits_turn_aborted, regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm).


##### `developer_input_texts`  (lines 444–459)

```
fn developer_input_texts(items: &[ResponseItem]) -> Vec<&str>
```

**Purpose**: Extracts all input-text strings from messages whose role is "developer". Developer messages are instructions supplied by the system or app, not by the end user.

**Data flow**: It receives a slice of ResponseItem values, keeps only developer messages, walks through their content items, and returns every input text as string slices borrowed from the original items.

**Call relations**: Initial-context and settings-update tests use this helper to check exactly which developer instructions the session produced. It turns nested message structures into a simple list of text snippets.

*Call graph*: called by 9 (build_initial_context_omits_default_image_save_location_with_image_history, build_initial_context_omits_default_image_save_location_without_image_history, build_initial_context_restates_realtime_start_when_reference_context_is_missing, build_initial_context_trims_skill_metadata_from_context_window_budget, build_initial_context_uses_previous_realtime_state, build_initial_context_uses_previous_turn_settings_for_realtime_end, build_settings_update_items_emits_realtime_end_when_session_stops_being_live, build_settings_update_items_emits_realtime_start_when_session_becomes_live, build_settings_update_items_uses_previous_turn_settings_for_realtime_end); 1 external calls (iter).


##### `developer_message_texts`  (lines 461–480)

```
fn developer_message_texts(items: &[ResponseItem]) -> Vec<Vec<&str>>
```

**Purpose**: Extracts developer message text while preserving message boundaries. This is useful when a test needs to know not just the text, but which pieces came from the same developer message.

**Data flow**: It receives response items, filters for role "developer", then returns a vector for each developer message containing that message’s input-text strings. It only borrows text; it does not alter the items.

**Call relations**: Tests about prompt fragments and multi-agent usage hints call it to inspect generated developer messages. It gives those tests a clearer view of the message grouping.

*Call graph*: called by 6 (build_initial_context_adds_multi_agent_v2_root_usage_hint_as_developer_message, build_initial_context_adds_multi_agent_v2_subagent_usage_hint_as_developer_message, build_initial_context_includes_prompt_fragments_from_extensions, build_initial_context_omits_multi_agent_v2_usage_hints_when_feature_disabled, build_initial_context_omits_multi_agent_v2_usage_hints_when_hint_disabled, build_initial_context_omits_prompt_fragments_without_extension_state); 1 external calls (iter).


##### `user_input_texts`  (lines 482–497)

```
fn user_input_texts(items: &[ResponseItem]) -> Vec<&str>
```

**Purpose**: Extracts all input-text strings from user messages. Tests use it to check user-visible context updates such as environment notices.

**Data flow**: It receives response items, keeps only messages whose role is "user", pulls out input text content, and returns borrowed string slices. Non-user messages and non-text content are ignored.

**Call relations**: Settings-update tests call this after the session builds context items. It reduces a structured response list to the user text that those tests want to compare.

*Call graph*: called by 3 (build_settings_update_items_emits_environment_item_for_network_changes, build_settings_update_items_emits_environment_item_for_time_changes, build_settings_update_items_omits_environment_item_when_disabled); 1 external calls (iter).


##### `write_project_hooks`  (lines 499–518)

```
fn write_project_hooks(dot_codex: &Path) -> std::io::Result<()>
```

**Purpose**: Writes a small hooks.json file into a project’s .codex directory for hook-loading tests. Hooks are commands that can run at certain session events.

**Data flow**: It receives a path, creates the directory if needed, and writes a JSON file defining one SessionStart command hook that echoes a message. It returns any filesystem error to the caller.

**Call relations**: Project trust tests call it to place hook configuration in test project layers. Those tests then verify whether the session loads or ignores the hook based on trust.

*Call graph*: called by 2 (session_start_hooks_only_load_from_trusted_project_layers, session_start_hooks_require_project_trust_without_config_toml); 3 external calls (join, create_dir_all, write).


##### `write_project_trust_config`  (lines 520–545)

```
async fn write_project_trust_config(
    codex_home: &Path,
    trusted_projects: &[(&Path, TrustLevel)],
) -> std::io::Result<()>
```

**Purpose**: Writes a test config.toml that marks selected project paths with trust levels. This lets tests simulate trusted and untrusted project configuration.

**Data flow**: It receives a Codex home directory and a list of project paths with trust levels. It serializes those into ConfigToml and writes the result asynchronously to the config file.

**Call relations**: Project hook trust tests call it after creating hook files. It supplies the trust settings that decide whether those project hooks are allowed to load.

*Call graph*: called by 2 (session_start_hooks_only_load_from_trusted_project_layers, session_start_hooks_require_project_trust_without_config_toml); 5 external calls (default, iter, join, write, to_string).


##### `preview_session_start_hooks`  (lines 547–568)

```
async fn preview_session_start_hooks(
    config: &crate::config::Config,
) -> std::io::Result<Vec<codex_protocol::protocol::HookRunSummary>>
```

**Purpose**: Builds a hook runner from a config and previews which SessionStart hooks would run. Previewing means listing the hook runs without actually executing command effects.

**Data flow**: It receives a Config, creates Hooks with the feature enabled and the config layer stack copied in, then asks for a session-start preview using test request data. It returns the list of hook summaries or an I/O error.

**Call relations**: This helper is available to hook tests that need to inspect hook selection. It hands the config into the hooks subsystem and returns the hook subsystem’s preview result.

*Call graph*: calls 2 internal fn (new, new); 1 external calls (default).


##### `test_tool_runtime`  (lines 570–584)

```
fn test_tool_runtime(session: Arc<Session>, turn_context: Arc<TurnContext>) -> ToolCallRuntime
```

**Purpose**: Creates a ToolCallRuntime for tests that need to run or inspect tool calls. A tool runtime is the bundle of routing, session, turn, and change-tracking state used when tools execute.

**Data flow**: It receives a session and turn context, builds a ToolRouter from the turn’s dynamic tools, creates a mutex-protected TurnDiffTracker, and returns a ToolCallRuntime containing all of them.

**Call relations**: Tool-related tests call it when they need a realistic runtime without repeating setup. It connects the session and turn context to the router used by tool execution.

*Call graph*: calls 3 internal fn (new, from_turn_context, new); called by 4 (handle_output_item_done_records_image_save_history_message, handle_output_item_done_skips_image_save_message_when_save_fails, shell_tool_cancellation_waits_for_runtime_cleanup, tool_calls_reopen_mailbox_delivery_for_current_turn); 4 external calls (new, default, new, new).


##### `make_connector`  (lines 586–602)

```
fn make_connector(id: &str, name: &str) -> AppInfo
```

**Purpose**: Creates a simple fake app connector record. A connector represents an external app integration such as Calendar.

**Data flow**: It receives an id and display name, fills an AppInfo struct with those values, marks it accessible and enabled, and leaves optional metadata empty.

**Call relations**: Skill app-id tests call this to build the connector catalog that skill text is matched against. The collection logic then decides whether mentions point to this connector.

*Call graph*: 1 external calls (new).


##### `assistant_message_stream_parsers_can_be_seeded_from_output_item_added_text`  (lines 605–619)

```
fn assistant_message_stream_parsers_can_be_seeded_from_output_item_added_text()
```

**Purpose**: Tests that assistant stream parsers can begin with text from an initial output item and continue correctly when later text arrives. This matters when internal citation tags are split across streaming events.

**Data flow**: The test creates parsers, seeds one item with partial text containing the start of a memory citation tag, parses the remaining tag and visible text as a delta, then finishes the item. It expects visible text to hide the citation markup and the citation list to contain the completed citation.

**Call relations**: The test runner invokes it. It exercises AssistantMessageStreamParsers through seed_item_text, parse_delta, and finish_item to prove the parser keeps state across calls.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `assistant_message_stream_parsers_seed_buffered_prefix_stays_out_of_finish_tail`  (lines 622–636)

```
fn assistant_message_stream_parsers_seed_buffered_prefix_stays_out_of_finish_tail()
```

**Purpose**: Checks that a partially buffered citation tag from seeded text is not leaked later as leftover visible text. This protects users from seeing broken internal markup.

**Data flow**: The test seeds text ending with an unfinished citation tag prefix, then parses the rest of the tag and normal text, then finishes the item. It expects only normal text to be visible, one citation to be recorded, and no tail text at finish.

**Call relations**: The test runner calls it directly. It focuses on the parser’s buffering behavior between seed_item_text, parse_delta, and finish_item.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `assistant_message_stream_parsers_seed_plan_parser_across_added_and_delta_boundaries`  (lines 639–664)

```
fn assistant_message_stream_parsers_seed_plan_parser_across_added_and_delta_boundaries()
```

**Purpose**: Tests that proposed-plan markup can start in seeded text and finish in later streamed text. Plan mode separates ordinary assistant text from structured proposed plan sections.

**Data flow**: The test creates parsers in plan mode, seeds text ending halfway through a proposed-plan tag, parses the rest of the plan and trailing text, then finishes. It expects visible text to omit the plan body where appropriate and plan segments to mark the plan start, delta, end, and normal text.

**Call relations**: The test runner invokes it. It checks AssistantMessageStreamParsers when both citation-style buffering and plan-mode segmentation are active.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `validated_network_policy_amendment_host_allows_normalized_match`  (lines 667–681)

```
fn validated_network_policy_amendment_host_allows_normalized_match()
```

**Purpose**: Verifies that network policy amendments accept hostnames that match after normalization. Normalization means cleaning differences like case, a trailing dot, or a port number.

**Data flow**: The test creates an amendment for "ExAmPlE.Com.:443" and an approval context for "example.com" over HTTPS. It calls the session validation function and expects the normalized host "example.com" back.

**Call relations**: The test runner calls it. It exercises Session::validated_network_policy_amendment_host to confirm valid user approvals are not rejected for harmless formatting differences.

*Call graph*: 2 external calls (assert_eq!, validated_network_policy_amendment_host).


##### `validated_network_policy_amendment_host_rejects_mismatch`  (lines 684–699)

```
fn validated_network_policy_amendment_host_rejects_mismatch()
```

**Purpose**: Checks that a network policy amendment cannot silently apply to a different host than the one being approved. This prevents a request for one site from changing rules for another.

**Data flow**: The test creates an amendment for "evil.example.com" and a context for "api.example.com". It expects validation to fail and checks that the error message explains the host mismatch.

**Call relations**: The test runner invokes it. It covers the rejection path of Session::validated_network_policy_amendment_host.

*Call graph*: 2 external calls (assert!, validated_network_policy_amendment_host).


##### `start_managed_network_proxy_applies_execpolicy_network_rules`  (lines 702–734)

```
async fn start_managed_network_proxy_applies_execpolicy_network_rules() -> anyhow::Result<()>
```

**Purpose**: Tests that network allow rules from the execution policy are applied to the managed network proxy. The proxy is the controlled gateway used to restrict tool network access.

**Data flow**: The test builds a workspace-write permission profile, creates a proxy spec, adds an allow rule for example.com to an execution policy, and starts the managed proxy. It then reads the proxy configuration and expects example.com to be in the allowed domains list.

**Call relations**: The async test runner calls it. It drives Session::start_managed_network_proxy and then asks the started proxy for its live configuration.

*Call graph*: calls 2 internal fn (from_config_and_constraints, workspace_write); 5 external calls (assert_eq!, empty, start_managed_network_proxy, default, default).


##### `start_managed_network_proxy_ignores_invalid_execpolicy_network_rules`  (lines 737–779)

```
async fn start_managed_network_proxy_ignores_invalid_execpolicy_network_rules() -> anyhow::Result<()>
```

**Purpose**: Checks that execution-policy network rules do not override stricter managed network requirements. This keeps centrally managed restrictions from being weakened by local rules.

**Data flow**: The test builds network constraints that allow only managed.example.com, then adds an execution-policy allow rule for example.com. After starting the proxy, it expects the allowed domains to remain managed.example.com only.

**Call relations**: The test runner invokes it. It uses Session::start_managed_network_proxy to verify how config constraints and execution policy are combined.

*Call graph*: calls 2 internal fn (from_config_and_constraints, workspace_write); 7 external calls (default, assert_eq!, empty, start_managed_network_proxy, default, default, from).


##### `managed_network_proxy_decider_survives_full_access_start`  (lines 782–847)

```
async fn managed_network_proxy_decider_survives_full_access_start() -> anyhow::Result<()>
```

**Purpose**: Ensures the network policy decider remains active even if the proxy is first started under full-access permissions and later switched to workspace-write rules. A decider is callback code that can approve, deny, or ask about a network request.

**Data flow**: The test starts a managed proxy with full-access permissions but with managed network requirements enabled and a decider that always asks/blocks. It then recomputes the spec for workspace-write, applies it, sends an HTTP request through the proxy, and expects a 403 response plus exactly one decider call.

**Call relations**: The async test runner calls it. It exercises proxy startup, live proxy reconfiguration, and an actual TCP request through the proxy to prove the decider is still wired in.

*Call graph*: calls 2 internal fn (from_config_and_constraints, workspace_write); 14 external calls (clone, new, default, from_secs, from_utf8_lossy, assert!, assert_eq!, empty, start_managed_network_proxy, default (+4 more)).


##### `new_turn_refreshes_managed_network_proxy_for_sandbox_change`  (lines 850–937)

```
async fn new_turn_refreshes_managed_network_proxy_for_sandbox_change() -> anyhow::Result<()>
```

**Purpose**: Tests that starting a new turn with a different sandbox policy refreshes the managed network proxy configuration. A sandbox policy controls how much system access a turn gets.

**Data flow**: The test starts a session and proxy with workspace-write rules that include both configured and required domains. It stores that proxy in the session, starts a new turn that switches to danger-full-access, then checks the proxy’s allowed domains have been recomputed to remove the earlier config-only domain.

**Call relations**: The test runner invokes it. It uses Session::start_managed_network_proxy for setup and Session::new_turn_with_sub_id to trigger the refresh path.

*Call graph*: calls 3 internal fn (from_config_and_constraints, make_session_and_context, workspace_write); 9 external calls (new, default, assert_eq!, empty, start_managed_network_proxy, default, default, from, vec!).


##### `danger_full_access_turns_do_not_expose_managed_network_proxy`  (lines 940–962)

```
async fn danger_full_access_turns_do_not_expose_managed_network_proxy() -> anyhow::Result<()>
```

**Purpose**: Verifies that a turn running in danger-full-access mode does not receive a managed network proxy. Full access means the usual sandbox restrictions are disabled, so exposing the managed proxy would be misleading.

**Data flow**: The test creates a config with managed network enabled but the disabled/full-access permission profile. It starts a default turn and expects the turn context’s network field to be empty.

**Call relations**: The async test runner calls it. It uses make_session_with_config to create the exact permission setup and then observes the new turn context.

*Call graph*: calls 2 internal fn (from_config_and_constraints, make_session_with_config); 3 external calls (default, assert!, default).


##### `danger_full_access_tool_attempts_do_not_enforce_managed_network`  (lines 965–1075)

```
async fn danger_full_access_tool_attempts_do_not_enforce_managed_network() -> anyhow::Result<()>
```

**Purpose**: Checks that tool attempts in danger-full-access mode are not told to enforce managed network restrictions. This keeps tool sandbox attempts consistent with the turn’s full-access policy.

**Data flow**: The test defines a small probe tool runtime that records the enforce_managed_network flag from each sandbox attempt. It builds a full-access session with managed network requirements present, runs the probe tool through the tool orchestrator, and expects the recorded flag to be false.

**Call relations**: The test runner invokes it. It connects session setup, ToolOrchestrator::run, and the probe ToolRuntime implementation to observe the sandbox attempt settings.

*Call graph*: calls 4 internal fn (from_config_and_constraints, make_session_with_config, new, plain); 6 external calls (clone, default, default, assert!, assert_eq!, default).


##### `workspace_write_turns_continue_to_expose_managed_network_proxy`  (lines 1078–1101)

```
async fn workspace_write_turns_continue_to_expose_managed_network_proxy() -> anyhow::Result<()>
```

**Purpose**: Confirms that workspace-write turns still receive a managed network proxy when managed networking is enabled. Workspace-write is a restricted mode where controlled network access can matter.

**Data flow**: The test creates a workspace-write permission profile with managed network enabled, builds a session from that config, starts a default turn, and expects the turn context’s network field to be present.

**Call relations**: The async test runner calls it. It is the positive counterpart to the danger-full-access network proxy tests.

*Call graph*: calls 3 internal fn (from_config_and_constraints, make_session_with_config, workspace_write); 3 external calls (default, assert!, default).


##### `user_shell_commands_do_not_inherit_managed_network_proxy`  (lines 1104–1151)

```
async fn user_shell_commands_do_not_inherit_managed_network_proxy() -> anyhow::Result<()>
```

**Purpose**: Verifies that shell commands explicitly run by the user do not inherit the session’s managed network proxy environment variables. This prevents user shell commands from being unexpectedly routed through tool network controls.

**Data flow**: The test creates a workspace-write session with managed networking, starts a turn, then runs a shell command that prints HTTP_PROXY or "not-set". It reads events until the command ends and expects exit code 0 with stdout showing "not-set".

**Call relations**: The test runner invokes it. It uses execute_user_shell_command and watches the session event receiver for ExecCommandEnd to check the shell environment.

*Call graph*: calls 3 internal fn (from_config_and_constraints, make_session_with_config_and_rx, workspace_write); 7 external calls (clone, new, default, assert!, assert_eq!, execute_user_shell_command, default).


##### `get_base_instructions_no_user_content`  (lines 1154–1207)

```
async fn get_base_instructions_no_user_content()
```

**Purpose**: Checks that base model instructions come from model configuration and do not include user content. Base instructions are the system prompt text that guides the model before any user message.

**Data flow**: The test loads bundled model metadata, creates several model test cases, updates the session’s base instructions for each model, calls get_base_instructions, and compares the returned text to the model’s configured base instructions.

**Call relations**: The async test runner calls it. It uses test_config, bundled model data, and Session::get_base_instructions to verify the session reads the configured prompt text unchanged.

*Call graph*: calls 2 internal fn (test_config, make_session_and_context); 4 external calls (assert_eq!, bundled_models_response, include_str!, vec!).


##### `reload_user_config_layer_updates_effective_apps_config`  (lines 1210–1240)

```
async fn reload_user_config_layer_updates_effective_apps_config()
```

**Purpose**: Tests that reloading the user config file updates app settings visible through the session. App settings control whether named app integrations are enabled and whether destructive actions are allowed.

**Data flow**: The test writes a config.toml with calendar app settings, calls reload_user_config_layer, then reads the effective config from the session and deserializes the apps table. It expects calendar to be disabled and destructive_enabled to be false.

**Call relations**: The test runner invokes it. It checks Session::reload_user_config_layer by writing a real temporary user config file and then reading Session::get_config.

*Call graph*: calls 1 internal fn (make_session_and_context); 5 external calls (assert!, assert_eq!, deserialize, create_dir_all, write).


##### `reload_user_config_layer_updates_base_and_selected_profile_layers`  (lines 1243–1304)

```
async fn reload_user_config_layer_updates_base_and_selected_profile_layers()
```

**Purpose**: Verifies that reloading user config updates both the base user config and the selected profile config. A profile is an alternate config file layered on top of the base settings.

**Data flow**: The test writes base and profile config files, installs a config that points at the profile, then changes both files and reloads. It expects the session to still point at the profile file, use the profile’s new model value, and use the base file’s updated approval policy.

**Call relations**: The async test runner calls it. It uses ConfigBuilder to create the profile-based setup and Session::reload_user_config_layer to refresh the layer stack.

*Call graph*: calls 3 internal fn (without_managed_config_for_tests, without_managed_config_for_tests, make_session_and_context); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `reload_user_config_layer_refreshes_hooks`  (lines 1307–1378)

```
async fn reload_user_config_layer_refreshes_hooks() -> anyhow::Result<()>
```

**Purpose**: Checks that reloading user config also refreshes trusted hook definitions. This matters because a hook may become allowed only after its trusted hash is written to config.

**Data flow**: The test enables hooks, builds a session-start hook request, confirms no hook is initially previewed, computes the hook list and trust data, writes a trusted hook state into config.toml, reloads user config, and expects one hook to appear in the preview.

**Call relations**: The test runner invokes it. It combines codex_hooks::list_hooks with Session::reload_user_config_layer and Session::hooks to verify the live hook runner is rebuilt.

*Call graph*: calls 1 internal fn (make_session_with_config); 9 external calls (assert!, assert_eq!, list_hooks, default, from_value, json!, create_dir_all, write, to_string).


##### `refresh_runtime_config_refreshes_hooks`  (lines 1381–1453)

```
async fn refresh_runtime_config_refreshes_hooks() -> anyhow::Result<()>
```

**Purpose**: Tests that refreshing runtime config, not just reloading user config directly, also refreshes hooks. Runtime config refresh is the broader path used when the session is given a newly loaded config object.

**Data flow**: The test enables hooks in session state, writes a trusted hook configuration to config.toml, confirms no hook is currently previewed, loads the latest config for the session, refreshes runtime config, and expects the hook preview to include one hook.

**Call relations**: The async test runner calls it. It uses load_latest_config_for_session to build the next config and Session::refresh_runtime_config to install it.

*Call graph*: calls 2 internal fn (load_latest_config_for_session, make_session_and_context); 12 external calls (new, assert!, assert_eq!, try_from, version_for_toml, format!, from_value, json!, create_dir_all, write (+2 more)).


##### `reload_user_config_layer_updates_effective_tool_suggest_config`  (lines 1456–1482)

```
async fn reload_user_config_layer_updates_effective_tool_suggest_config()
```

**Purpose**: Verifies that reloading user config updates tool suggestion settings. Tool suggestion settings can disable suggested connectors or plugins.

**Data flow**: The test writes a config.toml with two disabled tools, including one connector id with extra spaces, reloads user config, and checks that the session config contains normalized disabled tool entries.

**Call relations**: The test runner invokes it. It exercises Session::reload_user_config_layer and then inspects Session::get_config for the tool_suggest result.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert_eq!, create_dir_all, write).


##### `refresh_runtime_config_updates_runtime_refreshable_fields_and_keeps_session_static_settings`  (lines 1485–1538)

```
async fn refresh_runtime_config_updates_runtime_refreshable_fields_and_keeps_session_static_settings()
```

**Purpose**: Checks that runtime config refresh updates fields meant to change live, while preserving settings that are fixed for the session. This avoids surprising mid-session changes to core choices like model or notification command.

**Data flow**: The test writes app and tool suggestion config, loads a next config, deliberately changes model and notify on that next config, and refreshes the session. It expects apps and disabled tools to update, while model and notify remain equal to the original session values.

**Call relations**: The async test runner calls it. It uses load_latest_config_for_session and Session::refresh_runtime_config to test the boundary between refreshable and static settings.

*Call graph*: calls 2 internal fn (load_latest_config_for_session, make_session_and_context); 6 external calls (assert!, assert_eq!, deserialize, create_dir_all, write, vec!).


##### `collect_explicit_app_ids_from_skill_items_includes_linked_mentions`  (lines 1541–1551)

```
fn collect_explicit_app_ids_from_skill_items_includes_linked_mentions()
```

**Purpose**: Tests that app mentions written as links inside skill text are collected as explicit app ids. For example, an app link can point directly to app://calendar.

**Data flow**: The test creates a calendar connector and a skill message containing a linked calendar mention. It calls collect_explicit_app_ids_from_skill_items and expects the returned set to contain "calendar".

**Call relations**: The test runner invokes it. It uses make_connector and skill-shaped message input to exercise the app-id collection logic.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `collect_explicit_app_ids_from_skill_items_resolves_unambiguous_plain_mentions`  (lines 1554–1564)

```
fn collect_explicit_app_ids_from_skill_items_resolves_unambiguous_plain_mentions()
```

**Purpose**: Tests that a plain dollar-style mention, such as $calendar, is resolved to a connector when there is no ambiguity.

**Data flow**: The test creates one calendar connector and one skill message containing "$calendar". It calls the collection function with no conflicting skill names and expects the set to contain "calendar".

**Call relations**: The test runner calls it. It covers the plain-text mention path of collect_explicit_app_ids_from_skill_items.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `collect_explicit_app_ids_from_skill_items_skips_plain_mentions_with_skill_conflicts`  (lines 1567–1581)

```
fn collect_explicit_app_ids_from_skill_items_skips_plain_mentions_with_skill_conflicts()
```

**Purpose**: Checks that a plain app mention is ignored when the same name also belongs to a skill. This avoids guessing wrong when "$calendar" could mean either a skill or an app.

**Data flow**: The test creates a calendar connector, a skill message with "$calendar", and a skill-name count showing a calendar skill exists. It calls the collection function and expects an empty set.

**Call relations**: The test runner invokes it. It exercises the ambiguity guard in collect_explicit_app_ids_from_skill_items.

*Call graph*: 3 external calls (from, assert_eq!, vec!).


##### `reconstruct_history_matches_live_compactions`  (lines 1584–1595)

```
async fn reconstruct_history_matches_live_compactions()
```

**Purpose**: Verifies that rebuilding history from saved rollout items matches the history produced by live compaction. Compaction is when old conversation details are replaced by a shorter summary to save context space.

**Data flow**: The test creates a sample rollout and its expected compacted history, starts a fresh reconstruction turn, reconstructs history from the rollout, and compares both the reconstructed items and window id.

**Call relations**: The async test runner calls it. It uses sample_rollout for fixture data and Session::reconstruct_history_from_rollout for the behavior under test.

*Call graph*: calls 2 internal fn (make_session_and_context, sample_rollout); 1 external calls (assert_eq!).


##### `reconstruct_history_uses_replacement_history_verbatim`  (lines 1598–1635)

```
async fn reconstruct_history_uses_replacement_history_verbatim()
```

**Purpose**: Checks that when a compacted rollout item includes replacement_history, reconstruction uses that replacement exactly. This prevents reconstruction from trying to reinterpret already-prepared history.

**Data flow**: The test builds a compacted rollout item with a two-item replacement history and window id 42. It reconstructs history from that rollout and expects the same replacement items and window id.

**Call relations**: The test runner invokes it. It directly targets Session::reconstruct_history_from_rollout’s compacted-item shortcut behavior.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (assert_eq!, vec!).


##### `record_initial_history_reconstructs_resumed_transcript`  (lines 1638–1652)

```
async fn record_initial_history_reconstructs_resumed_transcript()
```

**Purpose**: Tests that recording a resumed transcript reconstructs and installs the expected conversation history. Resuming means opening an existing saved conversation rather than starting fresh.

**Data flow**: The test builds a sample rollout, calls record_initial_history with InitialHistory::Resumed, then reads session history from state. It expects the installed raw items to match the reconstructed expected history.

**Call relations**: The async test runner calls it. It uses sample_rollout to provide saved transcript data and Session::record_initial_history to load it into session state.

*Call graph*: calls 3 internal fn (make_session_and_context, sample_rollout, default); 3 external calls (from, assert_eq!, Resumed).


##### `resize_all_images_prepares_failures_before_history_insertion`  (lines 1655–1712)

```
async fn resize_all_images_prepares_failures_before_history_insertion()
```

**Purpose**: Verifies that broken images are converted to safe text before conversation items are inserted into history. This keeps unusable image data from polluting saved history.

**Data flow**: The test enables the ResizeAllImages feature, builds a function-call output containing text, one invalid base64 data image, and one URL image, then records it. It expects history to contain the text, a replacement notice for the bad image, and the untouched URL image.

**Call relations**: The test runner invokes it. It drives Session::record_conversation_items and then inspects session history to confirm preprocessing happened before insertion.

*Call graph*: calls 2 internal fn (make_session_and_context_with_auth_and_config_and_rx, from_api_key); 5 external calls (new, assert_eq!, ContentItems, from_ref, vec!).


##### `resize_all_images_prepares_resumed_history_before_installing_it`  (lines 1715–1765)

```
async fn resize_all_images_prepares_resumed_history_before_installing_it()
```

**Purpose**: Checks that resumed history is also cleaned of broken image content before it becomes session history. This protects old transcripts loaded from disk just like new items.

**Data flow**: The test enables ResizeAllImages, creates a resumed user message with an invalid data image and normal text, records resumed history, and expects installed history to replace the image with an omission notice while keeping the text.

**Call relations**: The async test runner calls it. It tests Session::record_initial_history on the resumed-history path with image preprocessing enabled.

*Call graph*: calls 3 internal fn (make_session_and_context_with_auth_and_config_and_rx, from_api_key, default); 5 external calls (from, new, assert_eq!, Resumed, vec!).


##### `resolve_multi_agent_version_handles_unset_and_legacy_history`  (lines 1768–1831)

```
fn resolve_multi_agent_version_handles_unset_and_legacy_history()
```

**Purpose**: Tests how the session decides which multi-agent protocol version applies when history is new, resumed, forked, inherited, or explicitly marked. Multi-agent mode controls how parent and sub-agent sessions coordinate.

**Data flow**: The test calls resolve_multi_agent_version with several combinations of initial history and inherited version. It expects new sessions without inheritance to stay unset, legacy resumed/forked histories to default to V1, inherited V2 to be kept when appropriate, and explicit metadata to win where defined.

**Call relations**: The test runner invokes it. It uses session_meta_item to build rollout metadata cases and focuses entirely on resolve_multi_agent_version’s decision table.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_eq!).


##### `record_initial_history_new_defers_initial_context_until_first_turn`  (lines 1834–1843)

```
async fn record_initial_history_new_defers_initial_context_until_first_turn()
```

**Purpose**: Verifies that a brand-new session does not immediately write initial context into history. Instead, it waits until the first turn context update.

**Data flow**: The test records InitialHistory::New, then reads the session history, reference context item, and previous turn settings. It expects empty history, no reference context, and no previous settings.

**Call relations**: The async test runner calls it. It exercises Session::record_initial_history for the new-session case and checks state directly afterward.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (assert!, assert_eq!).


##### `session_meta_item`  (lines 1845–1857)

```
fn session_meta_item(
    thread_id: ThreadId,
    multi_agent_version: Option<MultiAgentVersion>,
) -> RolloutItem
```

**Purpose**: Builds a saved transcript metadata item for tests. The metadata can include the thread id and optional multi-agent version.

**Data flow**: It receives a ThreadId and optional MultiAgentVersion, puts them into a SessionMeta value with defaults for other fields, wraps that in a SessionMetaLine, and returns it as a RolloutItem.

**Call relations**: resolve_multi_agent_version_handles_unset_and_legacy_history calls this helper to create rollout histories with explicit multi-agent metadata. The resulting rollout item is then read by resolve_multi_agent_version.

*Call graph*: calls 1 internal fn (default); 1 external calls (SessionMeta).


##### `resumed_history_injects_initial_context_on_first_context_update_only`  (lines 1860–1891)

```
async fn resumed_history_injects_initial_context_on_first_context_update_only()
```

**Purpose**: Checks that resumed sessions add initial context exactly once, at the first context update. This avoids duplicate system/developer context being appended every time context is refreshed.

**Data flow**: The test records resumed history from a sample rollout and confirms the history initially matches the saved transcript. It then records context updates, appends the built initial context to the expected list, and confirms history matches. A second context update should leave history unchanged.

**Call relations**: The async test runner invokes it. It combines Session::record_initial_history, record_context_updates_and_set_reference_context_item, and build_initial_context to verify one-time seeding.

*Call graph*: calls 3 internal fn (make_session_and_context, sample_rollout, default); 3 external calls (from, assert_eq!, Resumed).


##### `record_initial_history_seeds_token_info_from_rollout`  (lines 1894–1968)

```
async fn record_initial_history_seeds_token_info_from_rollout()
```

**Purpose**: Tests that resuming a transcript restores the latest token usage information found in saved rollout events. Token usage tracks how many model tokens were consumed.

**Data flow**: The test creates sample rollout items, appends several TokenCount events including two with info and two empty ones, then records resumed history. It reads token_info from session state and expects the last non-empty token usage info to be stored.

**Call relations**: The async test runner calls it. It exercises Session::record_initial_history’s resume path and verifies that saved EventMsg::TokenCount entries seed session state.

*Call graph*: calls 3 internal fn (make_session_and_context, sample_rollout, default); 5 external calls (from, assert_eq!, TokenCount, Resumed, EventMsg).


##### `recompute_token_usage_uses_session_base_instructions`  (lines 1971–2008)

```
async fn recompute_token_usage_uses_session_base_instructions()
```

**Purpose**: This test proves that recomputing token usage counts the session's current base instructions, not just the model's default instructions. That matters because long custom instructions can change how much context the conversation uses.

**Data flow**: It creates a test session, replaces the session's base instructions with a long distinctive string, records a user message, and calculates two possible token totals: one using the session instructions and one using the model defaults. After asking the session to recompute usage, it reads the stored token total and expects it to match the session-instruction estimate.

**Call relations**: The test builds its setup through make_session_and_context and user_message, then exercises session.recompute_token_usage. It compares the result against the conversation history's own token estimator to make sure recomputation follows the session configuration path.

*Call graph*: calls 2 internal fn (make_session_and_context, user_message); 3 external calls (assert_eq!, assert_ne!, from_ref).


##### `recompute_token_usage_updates_model_context_window`  (lines 2011–2030)

```
async fn recompute_token_usage_updates_model_context_window()
```

**Purpose**: This test checks that recomputing token usage also refreshes the stored model context window, which is the maximum amount of text the model can consider at once. If this stayed stale, the app could make bad decisions about when to compact or trim history.

**Data flow**: It starts with token information that says the model window is 258,400 tokens. Then it changes the turn context to say the active model window is 128,000 tokens, recomputes token usage, and reads the session state back. The expected after-state is that the stored window is now 128,000.

**Call relations**: The test creates a normal session context, edits the test data directly, and then calls session.recompute_token_usage. It verifies that recomputation updates both usage and the model-window metadata kept in session state.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (assert_eq!, default).


##### `record_token_usage_info_notifies_extension_contributors`  (lines 2033–2147)

```
async fn record_token_usage_info_notifies_extension_contributors()
```

**Purpose**: This test makes sure extensions are notified whenever token usage is recorded. Extensions are plug-ins that can observe session events, so they need accurate totals and access to the right session and thread data stores.

**Data flow**: It installs a test token-usage recorder extension, adds marker values to the session-level and thread-level extension stores, and records two usage updates. The recorder captures the store IDs, whether it could see the markers, and the token usage snapshot it received. The final records must show the first usage alone, then the cumulative total after the second usage.

**Call relations**: The test wires a TokenUsageContributor into the extension registry, then calls session.record_token_usage_info twice. The session is expected to hand the contributor the session store, thread store, turn store, and freshly updated TokenUsageInfo each time.

*Call graph*: calls 1 internal fn (make_session_and_context); 7 external calls (clone, new, new, assert_eq!, new, new, vec!).


##### `turn_start_lifecycle_exposes_turn_metadata_and_token_baseline`  (lines 2150–2253)

```
async fn turn_start_lifecycle_exposes_turn_metadata_and_token_baseline()
```

**Purpose**: This test checks that a turn-start extension callback receives the identity of the turn, the collaboration mode, and the token usage that existed before the turn began. That baseline lets extensions compare before-and-after usage.

**Data flow**: It registers a turn lifecycle recorder, marks the session and thread extension stores, sets an existing total token usage value, and starts a never-ending task to trigger turn start. After aborting the task, it checks that exactly one recorded callback contains the expected IDs, collaboration mode, starting token usage, and marker visibility.

**Call relations**: The test uses sess.spawn_task to enter the normal turn lifecycle path and abort_all_tasks to clean up. The TurnLifecycleContributor implementation observes on_turn_start and records what the session passes into that lifecycle hook.

*Call graph*: calls 2 internal fn (make_session_and_context, set_total_token_usage); 6 external calls (clone, new, new, assert_eq!, new, new).


##### `turn_error_lifecycle_exposes_error_and_stores`  (lines 2256–2339)

```
async fn turn_error_lifecycle_exposes_error_and_stores()
```

**Purpose**: This test verifies that turn-error lifecycle callbacks receive both the error value and the correct extension data stores. This lets plug-ins respond to failures with enough context.

**Data flow**: It installs a lifecycle recorder extension, adds markers to session and thread stores, builds an expected record for a usage-limit error, and then emits that turn error. The recorded output must contain the right store IDs, turn ID, error kind, and marker visibility.

**Call relations**: The test calls session.emit_turn_error_lifecycle directly. That path should notify registered TurnLifecycleContributor implementations through their on_turn_error callback.

*Call graph*: calls 1 internal fn (make_session_and_context); 6 external calls (clone, new, new, assert_eq!, new, new).


##### `config_change_contributor_observes_effective_config_changes`  (lines 2342–2466)

```
async fn config_change_contributor_observes_effective_config_changes()
```

**Purpose**: This test ensures that configuration-change extensions see real effective changes, both from runtime settings and from refreshed user configuration files. It also verifies that extension stores are available during the notification.

**Data flow**: It registers a config recorder, remembers the original model and disabled tool list, changes the collaboration mode to a new model, then writes a config file that disables two tools and refreshes runtime config. The recorder should receive two changes: first the model change, then the disabled-tool change.

**Call relations**: The test drives two normal update paths: session.update_settings and session.refresh_runtime_config after load_latest_config_for_session. The ConfigContributor should be called after each effective config transition with previous and new config values.

*Call graph*: calls 2 internal fn (load_latest_config_for_session, make_session_and_context); 10 external calls (clone, new, default, new, assert_eq!, new, create_dir_all, write, new, vec!).


##### `record_initial_history_reconstructs_forked_transcript`  (lines 2469–2479)

```
async fn record_initial_history_reconstructs_forked_transcript()
```

**Purpose**: This test checks that a forked session can rebuild its visible transcript from saved rollout items. A rollout is the saved event log of a thread.

**Data flow**: It creates a sample rollout and the expected reconstructed history, records that rollout as forked initial history, then reads the session's in-memory history. The final history must match the expected raw conversation items.

**Call relations**: The test uses sample_rollout to create realistic saved data, then calls session.record_initial_history with InitialHistory::Forked. It verifies that the session's history reconstruction path produces the same transcript that future model calls would use.

*Call graph*: calls 2 internal fn (make_session_and_context, sample_rollout); 2 external calls (assert_eq!, Forked).


##### `session_configured_reports_permission_profile_for_external_sandbox`  (lines 2482–2509)

```
async fn session_configured_reports_permission_profile_for_external_sandbox() -> anyhow::Result<()>
```

**Purpose**: This test makes sure a session configured with an external sandbox reports that exact permission profile to clients. The important point is that it must not be flattened into a less precise legacy file-system profile.

**Data flow**: It starts a mock server, configures the test session with an external sandbox and restricted network access, then builds the session. The session_configured event must contain the explicit external permission profile.

**Call relations**: The test uses test_codex and start_mock_server to go through normal session startup. It checks the session_configured data that clients receive after startup.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 1 external calls (assert_eq!).


##### `session_permission_profile_rebinds_runtime_workspace_roots`  (lines 2512–2555)

```
async fn session_permission_profile_rebinds_runtime_workspace_roots() -> anyhow::Result<()>
```

**Purpose**: This test checks that workspace-based permissions stay symbolic until the session knows its current workspace roots. In plain terms, a permission like 'workspace writable' should follow the current workspace, not stay stuck to an old path forever.

**Data flow**: It builds a config whose additional writable root is an old workspace path, creates permission-profile state from it, and confirms the stored policy has not hard-coded that old path. Then it builds a session configuration, applies a settings update with a new workspace root, and checks that the new root is writable while the old root is not.

**Call relations**: The test covers session_permission_profile_state_from_config and SessionConfiguration.apply. It ensures settings updates correctly rebind the sandbox policy to the latest workspace roots.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 7 external calls (default, new, assert!, default, test_path_buf, new, vec!).


##### `fork_startup_context_then_first_turn_diff_snapshot`  (lines 2558–2667)

```
async fn fork_startup_context_then_first_turn_diff_snapshot() -> anyhow::Result<()>
```

**Purpose**: This snapshot test checks the exact context sent to the model on the first turn after a fork, especially when startup settings and first-turn overrides differ. A snapshot is a saved expected text output used to catch accidental changes.

**Data flow**: It runs an initial conversation against a mock server, flushes its rollout to disk, forks the thread with a different approval policy, then submits a first forked turn in plan mode with its own settings. It captures the outgoing model request and formats a stripped-down context snapshot for comparison.

**Call relations**: The test goes through the full higher-level flow: test_codex startup, user submit, rollout materialization, thread_manager.fork_thread, another submit, and request snapshot formatting. The mock server records the model request so the test can compare the context that would have been sent externally.

*Call graph*: calls 7 internal fn (allow_any, default, format_labeled_requests_snapshot, mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (default, wait_for_event, clone_current, vec!).


##### `record_initial_history_forked_hydrates_previous_turn_settings`  (lines 2670–2750)

```
async fn record_initial_history_forked_hydrates_previous_turn_settings()
```

**Purpose**: This test ensures that when a fork is created from saved history, the session remembers the previous turn's model settings without duplicating that previous conversation into active history. That previous setting is needed as a reference for later diffs and context decisions.

**Data flow**: It builds rollout items containing a previous turn context with a custom model, records them as forked initial history, and then reads three pieces of state. The expected result is that previous_turn_settings contains the custom model, the active history is empty, and the reference context item matches the saved previous context.

**Call relations**: The test calls session.record_initial_history with InitialHistory::Forked. It checks the fork hydration path that separates reference metadata from the new fork's active conversation history.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert_eq!, Forked, vec!).


##### `thread_rollback_drops_last_turn_from_history`  (lines 2753–2818)

```
async fn thread_rollback_drops_last_turn_from_history()
```

**Purpose**: This test checks the basic rollback behavior: removing the most recent completed turn from both in-memory history and persisted replay data. Rollback is the conversation equivalent of undo.

**Data flow**: It creates a session with persistence, builds initial context plus two turns, saves them, and sets stale previous-turn reference state. After rolling back one turn, it expects the event to report one turn removed, the in-memory history to contain only initial context plus turn one, and the stale reference state to be cleared. It also verifies that the saved rollout contains a rollback marker.

**Call relations**: The test calls handlers::thread_rollback, waits for a ThreadRolledBack event through the receiver, and reads persisted history through RolloutRecorder. This checks that rollback updates live state and disk history together.

*Call graph*: calls 5 internal fn (thread_rollback, attach_thread_persistence, make_session_and_context_with_rx, wait_for_thread_rolled_back, get_rollout_history); 6 external calls (get_mut, new, assert!, assert_eq!, panic!, vec!).


##### `thread_rollback_clears_history_when_num_turns_exceeds_existing_turns`  (lines 2821–2848)

```
async fn thread_rollback_clears_history_when_num_turns_exceeds_existing_turns()
```

**Purpose**: This test checks that asking to roll back more turns than exist does not crash or leave partial user turns behind. The remaining history should be only the initial context.

**Data flow**: It saves a session with initial context and one user turn, then requests rollback of 99 turns. After the rollback event, the session history should contain only the initial context.

**Call relations**: The test drives handlers::thread_rollback with an intentionally oversized count. It confirms the rollback replay logic safely clamps the result to the available conversation turns.

*Call graph*: calls 4 internal fn (thread_rollback, attach_thread_persistence, make_session_and_context_with_rx, wait_for_thread_rolled_back); 4 external calls (get_mut, new, assert_eq!, vec!).


##### `thread_rollback_fails_without_persisted_thread_history`  (lines 2851–2870)

```
async fn thread_rollback_fails_without_persisted_thread_history()
```

**Purpose**: This test verifies that rollback refuses to run when there is no persisted thread history. Since rollback is replay-based, it needs the saved event log as its source of truth.

**Data flow**: It creates a session without attaching persistence, records initial context in memory, and requests rollback. The result should be a failure event with a clear message and error code, while the in-memory history remains unchanged.

**Call relations**: The test calls handlers::thread_rollback and then waits for a rollback-failed event. It confirms the handler protects the session instead of guessing from incomplete in-memory state.

*Call graph*: calls 3 internal fn (thread_rollback, make_session_and_context_with_rx, wait_for_thread_rollback_failed); 1 external calls (assert_eq!).


##### `thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay`  (lines 2873–2992)

```
async fn thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay()
```

**Purpose**: This test checks that rollback rebuilds previous-turn settings and reference context from the saved rollout, not from stale live state. That prevents old cached metadata from surviving after the conversation is rewound.

**Data flow**: It writes two completed turns to the persisted rollout, where the second turn has a different model and will be rolled back. It then deliberately sets stale in-memory history and stale previous-turn settings. After rolling back one turn, the history should contain only turn one's messages, previous-turn settings should match turn one's context, and the reference context should be turn one's saved context item.

**Call relations**: The test uses handlers::thread_rollback to trigger the replay path. It verifies that replayed rollout items, rather than the current in-memory values, determine the post-rollback session state.

*Call graph*: calls 6 internal fn (thread_rollback, assistant_message, attach_thread_persistence, make_session_and_context_with_rx, user_message, wait_for_thread_rolled_back); 11 external calls (get_mut, default, new, assert_eq!, TurnComplete, TurnStarted, UserMessage, EventMsg, ResponseItem, TurnContext (+1 more)).


##### `thread_rollback_restores_cleared_reference_context_item_after_compaction`  (lines 2995–3114)

```
async fn thread_rollback_restores_cleared_reference_context_item_after_compaction()
```

**Purpose**: This test covers rollback when a conversation has been compacted, meaning older messages were replaced by a shorter summary to save context space. After rolling back a later turn, the compacted history and window ID should be restored correctly.

**Data flow**: It writes a first turn, then a compaction event with replacement history and a window ID, then a second turn that will be rolled back. It seeds stale live history and an unrelated compact window ID. After rollback, the active history must be the compacted replacement history, the reference context item should be cleared, and the current window ID should reflect the compaction window.

**Call relations**: The test drives handlers::thread_rollback through a persisted rollout containing a Compacted item. It checks that rollback replay understands compaction events as well as normal message turns.

*Call graph*: calls 6 internal fn (thread_rollback, assistant_message, attach_thread_persistence, make_session_and_context_with_rx, user_message, wait_for_thread_rolled_back); 13 external calls (get_mut, default, new, assert!, assert_eq!, TurnComplete, TurnStarted, UserMessage, Compacted, EventMsg (+3 more)).


##### `thread_rollback_persists_marker_and_replays_cumulatively`  (lines 3117–3237)

```
async fn thread_rollback_persists_marker_and_replays_cumulatively()
```

**Purpose**: This test verifies that multiple rollbacks stack correctly over time. Each rollback should be recorded, and the next rollback should replay history including the earlier rollback marker.

**Data flow**: It saves three completed turns, rolls back one turn, then rolls back one more turn. The final in-memory history should contain only turn one. The persisted rollout should contain two rollback markers.

**Call relations**: The test calls handlers::thread_rollback twice and observes two success events. It then reads the rollout file through RolloutRecorder to prove the markers were persisted and future replays can understand both undo steps.

*Call graph*: calls 7 internal fn (thread_rollback, assistant_message, attach_thread_persistence, make_session_and_context_with_rx, user_message, wait_for_thread_rolled_back, get_rollout_history); 11 external calls (get_mut, default, new, assert_eq!, panic!, TurnComplete, TurnStarted, UserMessage, EventMsg, ResponseItem (+1 more)).


##### `thread_rollback_fails_when_turn_in_progress`  (lines 3240–3258)

```
async fn thread_rollback_fails_when_turn_in_progress()
```

**Purpose**: This test makes sure rollback is blocked while a turn is active. Rewinding while the assistant is still working could mix old and new state in unsafe ways.

**Data flow**: It records initial context, manually marks the session as having an active turn, and requests rollback. The expected result is a rollback-failed event, and the history remains unchanged.

**Call relations**: The test calls handlers::thread_rollback after setting active_turn. It verifies that the handler checks for in-progress work before changing conversation state.

*Call graph*: calls 4 internal fn (thread_rollback, make_session_and_context_with_rx, wait_for_thread_rollback_failed, default); 1 external calls (assert_eq!).


##### `thread_rollback_fails_when_num_turns_is_zero`  (lines 3261–3279)

```
async fn thread_rollback_fails_when_num_turns_is_zero()
```

**Purpose**: This test checks input validation for rollback. A request to roll back zero turns is meaningless, so it should fail clearly.

**Data flow**: It records initial context, asks to roll back zero turns, and waits for a failure event. The event should say that num_turns must be at least one, carry the rollback failure error code, and leave history unchanged.

**Call relations**: The test exercises handlers::thread_rollback with an invalid count. It verifies that validation happens before any replay or history mutation.

*Call graph*: calls 3 internal fn (thread_rollback, make_session_and_context_with_rx, wait_for_thread_rollback_failed); 1 external calls (assert_eq!).


##### `set_rate_limits_retains_previous_credits`  (lines 3282–3385)

```
async fn set_rate_limits_retains_previous_credits()
```

**Purpose**: This test checks that partial rate-limit updates do not erase existing credit information. Some server updates may include new limit windows but omit account credits, so the session should keep the last known credits.

**Data flow**: It builds a session state, stores an initial rate-limit snapshot that includes credits and plan type, then applies an update with new primary and secondary windows but no credits or plan type. The final snapshot should use the new windows while retaining the earlier credits and plan type.

**Call relations**: The test constructs SessionState directly and calls state.set_rate_limits twice. It focuses on the merge behavior inside session state rather than going through a network event.

*Call graph*: calls 5 internal fn (build_test_config, new, construct_model_info_offline_for_tests, get_model_offline_for_tests, new); 6 external calls (clone, new, new, assert_eq!, from_config, tempdir).


##### `set_rate_limits_updates_plan_type_when_present`  (lines 3388–3491)

```
async fn set_rate_limits_updates_plan_type_when_present()
```

**Purpose**: This test checks the companion case for rate-limit updates: when a new plan type is present, it should replace the old one. At the same time, missing credits should still be preserved.

**Data flow**: It creates an initial snapshot with Plus plan and credits, then applies an update with a Pro plan and no credits. The final snapshot should show the new Pro plan, keep the old credits, and update the limit window fields.

**Call relations**: Like the previous rate-limit test, this builds SessionState and calls state.set_rate_limits directly. Together they define how partial snapshots are merged.

*Call graph*: calls 5 internal fn (build_test_config, new, construct_model_info_offline_for_tests, get_model_offline_for_tests, new); 6 external calls (clone, new, new, assert_eq!, from_config, tempdir).


##### `prefers_structured_content_when_present`  (lines 3494–3519)

```
fn prefers_structured_content_when_present()
```

**Purpose**: This test checks that MCP tool results prefer structured content when it is available. MCP, or Model Context Protocol, is a way for tools to return data to the assistant; structured content is machine-readable data like JSON.

**Data flow**: It creates a tool result with both plain content and structured JSON content. When converted into a function-call output payload, the body should be the JSON string from structured content, and the success flag should be true.

**Call relations**: The test calls McpCallToolResult.into_function_call_output_payload. It confirms the conversion path ignores fallback text blocks when meaningful structured data exists.

*Call graph*: 5 external calls (assert_eq!, json!, Text, to_string, vec!).


##### `includes_timed_out_message`  (lines 3522–3539)

```
async fn includes_timed_out_message()
```

**Purpose**: This test makes sure command output shown to the model includes a clear timeout message when a command exceeded its time limit. Without this, the model might treat partial output as a normal successful command.

**Data flow**: It builds an execution result marked as timed out with one second of duration and some aggregated output. After formatting, the output string should begin with 'command timed out after 1000 milliseconds' followed by the command output.

**Call relations**: The test creates a turn context for the truncation policy and calls format_exec_output_str. It verifies the user-visible formatting used for shell command results.

*Call graph*: calls 3 internal fn (make_session_and_context, format_exec_output_str, new); 3 external calls (from_secs, new, assert_eq!).


##### `turn_context_with_model_updates_model_fields`  (lines 3542–3576)

```
async fn turn_context_with_model_updates_model_fields()
```

**Purpose**: This test checks that changing the model on a turn context updates all related fields consistently. The model name, model metadata, reasoning effort, and truncation policy all need to agree.

**Data flow**: It starts with a turn context whose reasoning effort is Minimal, then asks for a copy using model gpt-5.4. The updated context should have gpt-5.4 in config and collaboration mode, model_info from the models manager, reasoning effort reset to Medium, and truncation policy derived from the new model info.

**Call relations**: The test calls turn_context.with_model, which consults session.services.models_manager. It then independently asks the models manager for expected model info to confirm the update path used the same source.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert_eq!).


##### `falls_back_to_content_when_structured_is_null`  (lines 3579–3596)

```
fn falls_back_to_content_when_structured_is_null()
```

**Purpose**: This test checks that a null structured-content value is treated as absent. In that case, the tool's normal content blocks should still be sent onward.

**Data flow**: It creates an MCP tool result with two text blocks and structured_content set to JSON null. Conversion should produce a text payload containing the serialized content blocks, with success true.

**Call relations**: The test calls McpCallToolResult.into_function_call_output_payload. It defines the fallback behavior for the converter when structured content exists syntactically but carries no useful value.

*Call graph*: 4 external calls (assert_eq!, Text, to_string, vec!).


##### `success_flag_reflects_is_error_true`  (lines 3599–3616)

```
fn success_flag_reflects_is_error_true()
```

**Purpose**: This test checks that a tool result marked as an error becomes an unsuccessful function-call output. The content can still be passed through, but the success flag must tell the model it was an error.

**Data flow**: It creates an MCP tool result with is_error set to true and structured JSON saying there was a bad message. Conversion should serialize that JSON as the body and set success to false.

**Call relations**: The test calls McpCallToolResult.into_function_call_output_payload. It verifies that error status is preserved during conversion rather than being lost when formatting the payload.

*Call graph*: 5 external calls (assert_eq!, json!, Text, to_string, vec!).


##### `success_flag_true_with_no_error_and_content_used`  (lines 3619–3636)

```
fn success_flag_true_with_no_error_and_content_used()
```

**Purpose**: Checks that a tool result marked as not an error becomes a function-call output marked as successful. It also verifies that the text content is the body that gets used.

**Data flow**: It starts with a fake MCP tool result containing one text block and `is_error: false`. It converts that result into a function-call output payload. The expected output is JSON text for the content plus `success: true`, and the test passes only if the conversion matches exactly.

**Call relations**: This is a standalone test for the conversion path from `McpCallToolResult` to `FunctionCallOutputPayload`. It uses `text_block` to make the small JSON content item that appears in both the input and expected output.

*Call graph*: 4 external calls (assert_eq!, Text, to_string, vec!).


##### `wait_for_thread_rolled_back`  (lines 3638–3652)

```
async fn wait_for_thread_rolled_back(rx: &async_channel::Receiver<Event>) -> ThreadRolledBackEvent
```

**Purpose**: Waits until a test session emits a successful thread rollback event. It lets rollback tests ignore unrelated events and focus on the one they care about.

**Data flow**: It receives an event channel. For up to two seconds, it reads events from the channel. If an event is `ThreadRolledBack`, it returns that event payload; otherwise it keeps waiting. If no matching event arrives, the test fails with a timeout.

**Call relations**: Thread rollback tests call this helper after they trigger a rollback. It sits between the session's event stream and the assertion code, filtering the stream until it finds the success signal.

*Call graph*: calls 1 internal fn (recv); called by 5 (thread_rollback_clears_history_when_num_turns_exceeds_existing_turns, thread_rollback_drops_last_turn_from_history, thread_rollback_persists_marker_and_replays_cumulatively, thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay, thread_rollback_restores_cleared_reference_context_item_after_compaction); 3 external calls (from_secs, now, timeout).


##### `wait_for_thread_rollback_failed`  (lines 3654–3672)

```
async fn wait_for_thread_rollback_failed(rx: &async_channel::Receiver<Event>) -> ErrorEvent
```

**Purpose**: Waits until a test session reports that thread rollback failed. It is used by tests that intentionally trigger invalid rollback requests.

**Data flow**: It receives an event channel. For up to two seconds, it reads events and looks for an error event whose error kind is `ThreadRollbackFailed`. When it finds that matching error, it returns it. Other events are skipped.

**Call relations**: Rollback failure tests call this after sending a bad rollback request, such as asking to roll back zero turns or rolling back while a turn is active. It turns a noisy event stream into the specific failure payload the test needs.

*Call graph*: calls 1 internal fn (recv); called by 3 (thread_rollback_fails_when_num_turns_is_zero, thread_rollback_fails_when_turn_in_progress, thread_rollback_fails_without_persisted_thread_history); 3 external calls (from_secs, now, timeout).


##### `attach_thread_persistence`  (lines 3674–3712)

```
async fn attach_thread_persistence(session: &mut Session) -> PathBuf
```

**Purpose**: Adds real thread persistence to a test session so tests can check what gets saved to disk-like rollout storage. A rollout is the saved record of the thread's events.

**Data flow**: It reads the session's current configuration, creates a live persisted thread using the session's thread store and metadata such as current folder, model provider, and memory mode, installs that live thread into the session, materializes and flushes the rollout, then returns the path to the rollout file.

**Call relations**: Persistence and rollback tests call this when they need the session to behave as if it has a saved thread history. It hands the session a `LiveThread`, then uses the session's rollout methods to make sure there is an actual path tests can inspect.

*Call graph*: calls 2 internal fn (default, create); called by 9 (cached_guardian_subagent_exposes_its_rollout_path, record_context_updates_and_set_reference_context_item_persists_baseline_without_emitting_diffs, record_context_updates_and_set_reference_context_item_persists_full_reinjection_to_rollout, record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout, thread_rollback_clears_history_when_num_turns_exceeds_existing_turns, thread_rollback_drops_last_turn_from_history, thread_rollback_persists_marker_and_replays_cumulatively, thread_rollback_recomputes_previous_turn_settings_and_reference_context_from_replay, thread_rollback_restores_cleared_reference_context_item_after_compaction); 6 external calls (clone, new, current_rollout_path, ensure_rollout_materialized, flush_rollout, get_config).


##### `text_block`  (lines 3714–3719)

```
fn text_block(s: &str) -> serde_json::Value
```

**Purpose**: Builds a small JSON object representing a text content block. Tests use it to avoid rewriting the same JSON shape by hand.

**Data flow**: It takes a string and returns JSON with `type` set to `text` and `text` set to that string. It does not change anything outside itself.

**Call relations**: The content conversion test uses this helper to create matching input and expected content. It is a tiny fixture builder for test data.

*Call graph*: 1 external calls (json!).


##### `build_test_config`  (lines 3721–3727)

```
async fn build_test_config(codex_home: &Path) -> Config
```

**Purpose**: Creates a default configuration for tests under a temporary Codex home directory. This gives each test a clean, isolated setup.

**Data flow**: It receives a path for the test Codex home. It builds a configuration without managed user config, points it at that path, waits for it to load, and returns the finished `Config`.

**Call relations**: Many session-building helpers call this first. It supplies the base configuration that later helpers wrap in shared pointers and use to construct sessions, model information, and permission settings.

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

**Purpose**: Creates a telemetry record for a test session. Telemetry here means the metadata used when reporting session-related analytics, not the conversation content itself.

**Data flow**: It takes a conversation id, config, model info, and session source. It chooses the offline test model name, fills in fixed test account details, disables prompt logging, and returns a `SessionTelemetry` value.

**Call relations**: Session construction helpers call this when they need a realistic telemetry object for `TurnContext` creation. It feeds test-safe metadata into the same paths used by real sessions.

*Call graph*: calls 2 internal fn (get_model_offline_for_tests, new); called by 2 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx).


##### `model_with_default_service_tier`  (lines 3749–3758)

```
fn model_with_default_service_tier(default_service_tier: Option<&str>) -> ModelInfo
```

**Purpose**: Builds model information for service-tier tests. A service tier is a request option that can ask the backend for a certain processing class, such as priority or default behavior.

**Data flow**: It starts from offline model info for a fake GPT model, replaces its supported service tiers with a single `Fast` tier, sets the model's default tier if one is provided, and returns the modified model info.

**Call relations**: The service-tier tests use this helper to create predictable model metadata. That lets each test focus on what `get_service_tier` does with configured values and the fast-mode flag.

*Call graph*: calls 1 internal fn (model_info_from_slug); called by 6 (get_service_tier_does_not_default_when_model_has_no_default, get_service_tier_does_not_use_model_default_when_absent_and_fast_mode_enabled, get_service_tier_does_not_use_model_default_when_fast_mode_disabled, get_service_tier_drops_unsupported_configured_tier_when_fast_mode_enabled, get_service_tier_ignores_configured_tier_when_fast_mode_disabled, get_service_tier_keeps_supported_explicit_tier); 1 external calls (vec!).


##### `get_service_tier_does_not_use_model_default_when_absent_and_fast_mode_enabled`  (lines 3761–3772)

```
fn get_service_tier_does_not_use_model_default_when_absent_and_fast_mode_enabled()
```

**Purpose**: Checks that fast mode alone does not automatically choose the model's default service tier when the user did not configure one.

**Data flow**: It creates model info with `Fast` as the model default, calls `get_service_tier` with no configured tier and fast mode enabled, and expects `None`.

**Call relations**: This standalone service-tier test uses `model_with_default_service_tier` to set up the model metadata, then exercises `get_service_tier` directly.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `get_service_tier_does_not_use_model_default_when_fast_mode_disabled`  (lines 3775–3786)

```
fn get_service_tier_does_not_use_model_default_when_fast_mode_disabled()
```

**Purpose**: Checks that the model's default service tier is ignored when fast mode is disabled and the user did not configure a tier.

**Data flow**: It creates model info with a `Fast` default, calls `get_service_tier` with no configured tier and fast mode disabled, and expects no service tier to be sent.

**Call relations**: This is part of the service-tier test group. It pairs with the fast-mode-enabled case to show that model defaults are not automatically used in either situation.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `get_service_tier_keeps_supported_explicit_tier`  (lines 3789–3800)

```
fn get_service_tier_keeps_supported_explicit_tier()
```

**Purpose**: Checks that an explicitly configured supported service tier is kept when fast mode allows service-tier selection.

**Data flow**: It creates model info that supports `Fast`, passes `Fast` as the configured tier with fast mode enabled, and expects `Fast` to come back.

**Call relations**: This test exercises the positive path for `get_service_tier`: when the requested tier is valid for the model, the function should preserve it.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `get_service_tier_does_not_default_when_model_has_no_default`  (lines 3803–3814)

```
fn get_service_tier_does_not_default_when_model_has_no_default()
```

**Purpose**: Checks that no service tier is invented when the model has no default tier.

**Data flow**: It creates model info with no default service tier, calls `get_service_tier` without a configured tier while fast mode is enabled, and expects `None`.

**Call relations**: This service-tier test uses the shared model helper to prove that missing model metadata stays missing rather than being filled in with a guess.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `get_service_tier_drops_unsupported_configured_tier_when_fast_mode_enabled`  (lines 3817–3844)

```
fn get_service_tier_drops_unsupported_configured_tier_when_fast_mode_enabled()
```

**Purpose**: Checks that unsupported configured tiers are removed, while the special default request value is still allowed.

**Data flow**: It creates a model that supports only `Fast`. It then tries an unknown string, `Flex`, and the default service-tier request value. The first two return `None`; the default request value is preserved.

**Call relations**: This test drives `get_service_tier` through several invalid or special inputs. It protects the request-building path from sending tiers the selected model does not support.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `get_service_tier_ignores_configured_tier_when_fast_mode_disabled`  (lines 3847–3882)

```
fn get_service_tier_ignores_configured_tier_when_fast_mode_disabled()
```

**Purpose**: Checks that configured service-tier settings are ignored when fast mode is disabled.

**Data flow**: It tries `Fast`, the default request value, an unsupported string, and no configured value with fast mode disabled. Every case is expected to return `None`.

**Call relations**: This test completes the service-tier group by proving that the fast-mode flag is a gate. Even otherwise valid configured tiers are not used when the gate is closed.

*Call graph*: calls 1 internal fn (model_with_default_service_tier); 1 external calls (assert_eq!).


##### `session_settings_null_service_tier_update_uses_default_service_tier`  (lines 3885–3899)

```
async fn session_settings_null_service_tier_update_uses_default_service_tier()
```

**Purpose**: Checks how a settings update with a null service tier is interpreted. In this API shape, null means “use the default request value,” not “leave it absent.”

**Data flow**: It builds a test session configuration, applies a settings update where `service_tier` is present but contains `None`, and expects the updated configuration to contain the default service-tier request value.

**Call relations**: This test uses `make_session_configuration_for_tests` to get a realistic starting point, then exercises `SessionConfiguration.apply` for one service-tier edge case.

*Call graph*: calls 1 internal fn (make_session_configuration_for_tests); 2 external calls (default, assert_eq!).


##### `session_settings_legacy_fast_service_tier_update_uses_priority_request_value`  (lines 3902–3916)

```
async fn session_settings_legacy_fast_service_tier_update_uses_priority_request_value()
```

**Purpose**: Checks that the old service-tier name `fast` is translated to the current request value for the fast or priority tier.

**Data flow**: It builds a test session configuration, applies a settings update with the string `fast`, and expects the stored tier to become `ServiceTier::Fast.request_value()`.

**Call relations**: This test protects backward compatibility. Older clients can still send `fast`, while the session stores the newer canonical value.

*Call graph*: calls 1 internal fn (make_session_configuration_for_tests); 2 external calls (default, assert_eq!).


##### `make_session_configuration_for_tests`  (lines 3918–3967)

```
async fn make_session_configuration_for_tests() -> SessionConfiguration
```

**Purpose**: Builds a realistic `SessionConfiguration` for tests without starting a full session. A session configuration is the bundle of choices such as model, instructions, permissions, working folder, and source.

**Data flow**: It creates a temporary Codex home, loads a test config, derives offline model information, builds the default collaboration mode, copies relevant config fields into a `SessionConfiguration`, and returns it.

**Call relations**: Many tests call this helper before applying setting updates or checking lock files and analytics. It centralizes the boilerplate so each test starts from a consistent default session setup.

*Call graph*: calls 4 internal fn (build_test_config, construct_model_info_offline_for_tests, get_model_offline_for_tests, new); called by 24 (lock_contains_prompts_and_materializes_features, lock_skips_session_values_when_model_catalog_fields_are_not_saved, lock_validation_can_ignore_codex_version_mismatch, lock_validation_ignores_removed_apps_mcp_path_override, lock_validation_rejects_codex_version_mismatch_by_default, lock_validation_reports_config_diff, active_profile_update_rebuilds_network_proxy_config, emit_subagent_session_started_includes_fork_lineage_from_session_configuration, session_configuration_apply_permission_profile_accepts_direct_write_roots, session_configuration_apply_permission_profile_preserves_existing_deny_read_entries (+14 more)); 5 external calls (clone, new, new, from_config, tempdir).


##### `emit_subagent_session_started_includes_fork_lineage_from_session_configuration`  (lines 3970–4046)

```
async fn emit_subagent_session_started_includes_fork_lineage_from_session_configuration()
```

**Purpose**: Checks that analytics for a subagent session include both its parent thread id and the thread it was forked from. A subagent is a child agent/session started from another session.

**Data flow**: It starts a mock HTTP server, configures an analytics client to send to it, creates parent, fork, and child thread ids, puts the fork id into a session configuration, emits the subagent-started analytics event, then waits until the mock server receives the event and checks the JSON fields.

**Call relations**: This test uses `make_session_configuration_for_tests` to create the thread configuration snapshot passed to `emit_subagent_session_started`. The mock server stands in for the real analytics service so the test can inspect the outgoing request.

*Call graph*: calls 6 internal fn (new, make_session_configuration_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, from, new); 9 external calls (from_millis, from_secs, given, start, new, assert_eq!, from_slice, sleep, timeout).


##### `resolved_environments_for_configuration`  (lines 4048–4060)

```
async fn resolved_environments_for_configuration(
    session_configuration: &SessionConfiguration,
) -> (Arc<EnvironmentManager>, TurnEnvironmentSnapshot)
```

**Purpose**: Builds resolved test environments from a session configuration. An environment is where a turn runs, including its working folder and filesystem view.

**Data flow**: It creates a test environment manager and a `ThreadEnvironments` object with a default shell snapshot disabled. It applies the session configuration's environment selections, takes a snapshot of the resolved result, and returns both the manager and snapshot.

**Call relations**: Session-building helpers call this before making a `TurnContext`. It connects high-level environment choices in the configuration to concrete per-turn environment data.

*Call graph*: calls 5 internal fn (new, environment_selections, default_user_shell, disabled, default_for_tests); called by 2 (make_session_and_context, make_session_and_context_with_auth_config_home_and_rx); 3 external calls (clone, new, default).


##### `session_configuration_apply_preserves_profile_file_system_policy_on_cwd_only_update`  (lines 4063–4117)

```
async fn session_configuration_apply_preserves_profile_file_system_policy_on_cwd_only_update()
```

**Purpose**: Checks that changing only the current working directory does not erase or reinterpret a profile's file access policy. File access policy means the rules for what paths can be read or written.

**Data flow**: It builds a session configuration, creates a restricted filesystem policy with write access to project roots and read access to a docs folder, installs it as the permission profile, then applies an update that only changes the working directory. The expected result is the same policy materialized against the original workspace roots.

**Call relations**: This test exercises `SessionConfiguration.apply` for a directory-only update. It protects permission profiles from being accidentally rewritten just because the session moves to another folder.

*Call graph*: calls 6 internal fn (make_session_configuration_for_tests, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, restricted, from, new); 6 external calls (default, new, assert_eq!, create_dir_all, tempdir, vec!).


##### `session_configuration_apply_permission_profile_preserves_existing_deny_read_entries`  (lines 4120–4173)

```
async fn session_configuration_apply_permission_profile_preserves_existing_deny_read_entries()
```

**Purpose**: Checks that applying a new permission profile does not discard existing deny rules. A deny rule is an explicit “do not allow this,” such as blocking `.env` files.

**Data flow**: It creates a workspace-write policy, adds a deny glob for `**/*.env` and a scan depth to the existing filesystem policy, then applies a requested permission profile based on the normal workspace policy. The updated configuration should include the requested policy plus the preserved deny rule and scan depth.

**Call relations**: This test calls `SessionConfiguration.apply` with a permission-profile update. It ensures safety-related restrictions survive profile changes instead of being overwritten by a more general request.

*Call graph*: calls 6 internal fn (make_session_configuration_for_tests, from_runtime_permissions, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, new); 5 external calls (default, new, new_workspace_write_policy, assert_eq!, tempdir).


##### `session_configuration_apply_permission_profile_accepts_direct_write_roots`  (lines 4176–4220)

```
async fn session_configuration_apply_permission_profile_accepts_direct_write_roots()
```

**Purpose**: Checks that a permission profile can directly grant write access to an absolute folder outside the normal workspace-root shorthand.

**Data flow**: It creates a temporary external folder, canonicalizes it into an absolute path, builds a restricted filesystem policy granting write access to that path, converts it into a permission profile, and applies it. The updated configuration must keep that permission profile, keep the filesystem policy, and expose an equivalent legacy sandbox policy with that writable root.

**Call relations**: This test exercises the bridge between modern permission profiles and older sandbox policy fields. It proves direct path grants are not lost during conversion.

*Call graph*: calls 5 internal fn (make_session_configuration_for_tests, from_runtime_permissions, restricted, new, from_absolute_path); 6 external calls (default, new, assert_eq!, canonicalize_preserving_symlinks, tempdir, vec!).


##### `session_configuration_apply_rebinds_symbolic_profile_to_updated_workspace_roots`  (lines 4223–4263)

```
async fn session_configuration_apply_rebinds_symbolic_profile_to_updated_workspace_roots()
```

**Purpose**: Checks that symbolic project-root permissions follow updated workspace roots. A symbolic permission is like saying “the project roots” instead of naming one exact folder.

**Data flow**: It starts with one old workspace root, creates a permission profile that writes to `project_roots`, then applies an update with a new workspace root, an active profile name, and profile workspace roots. The resulting policy should allow writing to the new root, not the old root, and should store the active profile metadata.

**Call relations**: This test drives `SessionConfiguration.apply` through a combined workspace-root and permission-profile update. It ensures symbolic rules are rebound to the new project roots at the right time.

*Call graph*: calls 4 internal fn (new, make_session_configuration_for_tests, from_runtime_permissions, restricted); 5 external calls (default, assert!, assert_eq!, tempdir, vec!).


##### `session_configuration_apply_retargets_implicit_workspace_root_on_cwd_update`  (lines 4266–4308)

```
async fn session_configuration_apply_retargets_implicit_workspace_root_on_cwd_update()
```

**Purpose**: Checks that when the current working directory is also an implicit workspace root, changing the directory retargets that implicit root while preserving extra roots.

**Data flow**: It sets the current directory and workspace roots to include an old root plus an extra root. It installs a symbolic project-root write policy, then applies a current-directory update to a new root. The updated workspace roots should be the new root plus the extra root, and the policy should write to those, not the old root.

**Call relations**: This test protects the logic that updates workspace roots during `SessionConfiguration.apply`. It distinguishes the automatically inferred root from user-added extra roots.

*Call graph*: calls 4 internal fn (make_session_configuration_for_tests, from_runtime_permissions, restricted, new); 6 external calls (default, new, assert!, assert_eq!, tempdir, vec!).


##### `active_profile_update_rebuilds_network_proxy_config`  (lines 4311–4416)

```
async fn active_profile_update_rebuilds_network_proxy_config() -> std::io::Result<()>
```

**Purpose**: Checks that switching permission profiles rebuilds the session's network proxy settings. A proxy is a network middleman the session may be required to use.

**Data flow**: It writes a temporary config file with two permission profiles: one locked down and one web-enabled with a proxy URL. It loads config for the locked profile and confirms the proxy is not selected, then loads config for the web-enabled profile. It applies that selected profile to an existing session configuration and verifies the resulting config now contains the proxy host and has SOCKS disabled.

**Call relations**: This test uses `make_session_configuration_for_tests` as a base, then replaces its stored permission state and original config. It exercises `SessionConfiguration.apply` to confirm that changing the active profile updates not only permissions but also runtime network configuration.

*Call graph*: calls 1 internal fn (make_session_configuration_for_tests); 13 external calls (clone, new, default, assert!, assert_eq!, assert_ne!, Access, default, from, write (+3 more)).


##### `new_default_turn_uses_config_aware_skills_for_role_overrides`  (lines 4420–4503)

```
async fn new_default_turn_uses_config_aware_skills_for_role_overrides()
```

**Purpose**: Checks that a new default turn respects skills disabled by an applied agent role. Skills are reusable capability descriptions loaded from configuration files.

**Data flow**: It creates a session, writes a demo skill file, confirms the parent config sees the skill as enabled, then writes a role config that disables that skill. It applies the role to a cloned child config, stores that config in the session state, creates a new default turn, and verifies the skill is discovered but disabled.

**Call relations**: This test uses `make_session_and_context` to get a full test session. It then calls the role-application path and finally `new_default_turn_with_sub_id`, proving that turn creation reads the role-adjusted configuration when loading skills.

*Call graph*: calls 2 internal fn (apply_role_to_config, make_session_and_context); 8 external calls (clone, new, new, assert_eq!, skills_load_input_from_config, format!, create_dir_all, write).


##### `session_configuration_apply_retargets_legacy_workspace_root_on_cwd_update`  (lines 4506–4557)

```
async fn session_configuration_apply_retargets_legacy_workspace_root_on_cwd_update()
```

**Purpose**: Checks that older-style workspace-write sandbox rules follow the new current directory when the old workspace root was only implicit.

**Data flow**: It creates a session configuration whose workspace roots contain the original current directory. It builds a legacy workspace-write policy for that directory, installs it, then applies a current-directory update to another repo path. The updated configuration should have the new repo as its workspace root, allow writing there, and no longer allow writing to the old directory.

**Call relations**: This test focuses on legacy sandbox compatibility inside `SessionConfiguration.apply`. It makes sure older policies still behave safely when the session changes folders.

*Call graph*: calls 6 internal fn (make_session_configuration_for_tests, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from, new); 6 external calls (default, new, assert!, assert_eq!, tempdir, vec!).


##### `session_configuration_apply_preserves_absolute_cwd_write_root_on_cwd_update`  (lines 4560–4619)

```
async fn session_configuration_apply_preserves_absolute_cwd_write_root_on_cwd_update()
```

**Purpose**: Checks that an explicit absolute write grant to the old current directory stays exactly that, rather than being treated as a symbolic workspace-root grant.

**Data flow**: It creates two directories, sets the first as the current directory, and installs a filesystem policy that reads root and writes the first directory by absolute path. After applying an update to move the current directory to the second directory, the filesystem policy should be unchanged: the old absolute path remains writable and the new current directory is not automatically writable.

**Call relations**: This test guards an important distinction in `SessionConfiguration.apply`: exact path grants and symbolic workspace-root grants must not be confused.

*Call graph*: calls 4 internal fn (make_session_configuration_for_tests, from_runtime_permissions_with_enforcement, restricted, new); 7 external calls (default, new, assert!, assert_eq!, create_dir_all, tempdir, vec!).


##### `session_update_settings_does_not_rewrite_sticky_environment_cwds`  (lines 4622–4669)

```
async fn session_update_settings_does_not_rewrite_sticky_environment_cwds()
```

**Purpose**: Checks that updating the session's primary current directory does not rewrite the stored current directories of sticky turn environments. Sticky environments keep their own location across turns.

**Data flow**: It creates a session, records its current environment selections, creates a new project directory, and calls `session.update_settings` with a new primary current directory plus the existing environments. It then checks that the session's primary cwd changed, the stored environments stayed the same, and a newly created turn still uses the original config cwd.

**Call relations**: This test goes through the real `Session.update_settings` method rather than only `SessionConfiguration.apply`. It then creates a new default turn to confirm the setting change did not unexpectedly affect per-turn environment cwd behavior.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 3 external calls (default, assert_eq!, create_dir_all).


##### `relative_cwd_update_without_environments_resolves_under_session_cwd`  (lines 4672–4701)

```
async fn relative_cwd_update_without_environments_resolves_under_session_cwd()
```

**Purpose**: Checks that a current-directory update still works when there are no explicit environment selections.

**Data flow**: It creates a session, clears the stored environment list, builds a project path under the original current directory, creates that folder, and updates settings with that new path and no environments. The session configuration should now use the project path as cwd and still have no environment selections.

**Call relations**: This test uses the full session update path. It covers the simpler case where the session has only a primary cwd and no separate turn environments to preserve.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 5 external calls (default, new, assert!, assert_eq!, create_dir_all).


##### `environment_settings_preserve_explicit_primary_cwd`  (lines 4704–4734)

```
async fn environment_settings_preserve_explicit_primary_cwd()
```

**Purpose**: Checks that explicit environment current directories are preserved when the session's primary current directory changes.

**Data flow**: It creates a session, installs an explicit local environment pointing at an `environment` folder, then updates the primary cwd to a different `project` folder while passing the same environment list. The session cwd should change, but the environment entry should still point at the original environment folder.

**Call relations**: This test exercises `Session.update_settings` with both a primary cwd update and explicit environments. It proves the update does not rewrite environment entries behind the caller's back.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 4 external calls (default, assert_eq!, create_dir_all, vec!).


##### `absolute_cwd_update_with_turn_environment_is_allowed`  (lines 4737–4764)

```
async fn absolute_cwd_update_with_turn_environment_is_allowed()
```

**Purpose**: Checks that starting a new turn with an absolute current directory and an explicit matching environment is valid.

**Data flow**: It creates a session with an event receiver, makes an absolute subdirectory, and starts a new turn with settings that choose that cwd and one local environment at the same path. The returned turn context should use that absolute cwd in both its deprecated direct field and its config, and should contain one resolved turn environment.

**Call relations**: This test calls `new_turn_with_sub_id`, which applies settings for a single turn. It confirms that absolute paths are accepted when they are paired with explicit environment selections.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, new); 4 external calls (default, assert_eq!, create_dir_all, vec!).


##### `session_new_fails_when_zsh_fork_enabled_without_packaged_zsh`  (lines 4767–4873)

```
async fn session_new_fails_when_zsh_fork_enabled_without_packaged_zsh()
```

**Purpose**: Checks that session startup fails clearly if the zsh-fork shell feature is enabled but no packaged zsh fork path is available. zsh is a Unix shell; this feature needs a bundled helper to work.

**Data flow**: It builds a test config, enables the shell zsh fork feature, removes the zsh path, then constructs all the services needed to call `Session::new`. It expects construction to fail and checks that the error message explains that no packaged zsh fork is available.

**Call relations**: This is a full session-construction failure test. It uses many of the same pieces as normal startup, but deliberately removes one required dependency so `Session::new` must reject the setup.

*Call graph*: calls 17 internal fn (new, new, default, new, new, build_test_config, models_manager_with_provider, default_for_tests, new, from_auth_for_testing (+7 more)); 12 external calls (clone, new, new, assert!, unbounded, default, default, format!, panic!, from_config (+2 more)).


##### `make_session_and_context`  (lines 4876–5098)

```
async fn make_session_and_context() -> (Session, TurnContext)
```

**Purpose**: Builds a complete test `Session` and matching `TurnContext`. A turn context is the per-request view of the session, including config, model info, environments, and loaded skills.

**Data flow**: It creates a temporary config, fake authentication, model manager, agent control, execution policy, session configuration, telemetry, state, resolved environments, plugin and skill managers, network approval service, and all session services. It loads plugins and skills, builds a turn context, manually constructs the `Session`, and returns both.

**Call relations**: Many tests call this when they need more than a bare configuration. It is the main test fixture builder for code paths that require a real session object plus a ready-to-use turn context.

*Call graph*: calls 33 internal fn (new, new, new_uninitialized_with_permission_profile, new, new, new, new, default, new, new (+15 more)); called by 269 (process_compacted_history_with_test_session, test_review_params, build_guardian_prompt_includes_parent_turn_denied_reads, build_guardian_prompt_items_includes_parent_session_id, guardian_review_request_layout_matches_model_visible_request_snapshot, guardian_test_session_and_turn_with_base_url, routes_approval_to_guardian_allows_granular_review_policy, routes_approval_to_guardian_can_use_app_reviewer_override, routes_approval_to_guardian_requires_guardian_reviewer, hook_run_analytics_payload_falls_back_to_turn_context_id (+15 more)); 28 external calls (clone, new, new, new, default, new, from, new, new, from_pointee (+15 more)).


##### `make_session_with_config`  (lines 5100–5105)

```
async fn make_session_with_config(
    mutator: impl FnOnce(&mut Config),
) -> anyhow::Result<Arc<Session>>
```

**Purpose**: Creates a test session after letting the caller modify the configuration. It is a convenience wrapper for tests that need a custom config but do not need the event receiver.

**Data flow**: It receives a function that mutates a `Config`. It forwards that mutator to `make_session_with_config_and_rx`, discards the returned event receiver, and returns the session wrapped in `Arc`, or an error if setup failed.

**Call relations**: Tests call this when they only need the session. It delegates the real setup work to `make_session_with_config_and_rx`, keeping callers shorter and clearer.

*Call graph*: calls 1 internal fn (make_session_with_config_and_rx); called by 5 (danger_full_access_tool_attempts_do_not_enforce_managed_network, danger_full_access_turns_do_not_expose_managed_network_proxy, reload_user_config_layer_refreshes_hooks, shell_tool_cancellation_waits_for_runtime_cleanup, workspace_write_turns_continue_to_expose_managed_network_proxy).


##### `load_latest_config_for_session`  (lines 5107–5115)

```
async fn load_latest_config_for_session(session: &Session) -> Config
```

**Purpose**: Reloads configuration from disk for the same Codex home and current directory as an existing session. Tests use this to check whether runtime config refresh sees new file changes.

**Data flow**: It asks the session for its current config, then builds a fresh config using the same Codex home and the session cwd as a fallback. The newly loaded `Config` is returned.

**Call relations**: Config-refresh tests call this after changing config files or session state. It represents the “what would the config loader see now?” step before comparing old and new effective settings.

*Call graph*: called by 3 (config_change_contributor_observes_effective_config_changes, refresh_runtime_config_refreshes_hooks, refresh_runtime_config_updates_runtime_refreshable_fields_and_keeps_session_static_settings); 2 external calls (default, get_config).


##### `make_session_with_config_and_rx`  (lines 5117–5217)

```
async fn make_session_with_config_and_rx(
    mutator: impl FnOnce(&mut Config),
) -> anyhow::Result<(Arc<Session>, async_channel::Receiver<Event>)>
```

**Purpose**: Builds a test session and returns both the session and a receiver that can observe events the session emits. Tests use it when they need to tweak the configuration before the session is created.

**Data flow**: It starts with a caller-provided configuration mutator. It creates a temporary Codex home, builds a default test config, lets the mutator change it, then constructs the many pieces a session needs: fake authentication, model information, permission settings, environment selection, plugin and skill managers, and event channels. It returns the finished shared session plus the event receiver.

**Call relations**: This helper is called by higher-level test helpers and by tests that need a customized session. Its main handoff is to Session::new, which receives the assembled configuration and services so the test can behave like a real session without contacting real services.

*Call graph*: calls 17 internal fn (new, new, default, new, new, build_test_config, models_manager_with_provider, default_for_tests, new, from_auth_for_testing (+7 more)); called by 2 (make_session_with_config, user_shell_commands_do_not_inherit_managed_network_proxy); 10 external calls (clone, new, new, unbounded, default, default, from_config, tempdir, vec!, channel).


##### `make_session_with_history_source_and_agent_control_and_rx`  (lines 5219–5328)

```
async fn make_session_with_history_source_and_agent_control_and_rx(
    initial_history: InitialHistory,
    session_source: SessionSource,
    agent_control: AgentControl,
) -> anyhow::Result<(Arc<Se
```

**Purpose**: Builds a test session where the starting history, session source, and agent-control settings can be chosen. Tests use it to check how resumed root and subagent sessions pick their identities.

**Data flow**: It receives an initial history value, a description of where the session came from, and agent-control rules. It creates a temporary, ephemeral config, fake auth, model settings, environments, event channels, managers, and a local thread store backed by a test state database. It returns the created session and its event receiver.

**Call relations**: The resumed-session identity tests call this helper so they can create sessions with precise combinations of resumed history and parent-agent control. Like the other builder, it hands all prepared pieces to Session::new.

*Call graph*: calls 18 internal fn (new, new, default, new, new, build_test_config, models_manager_with_provider, default_for_tests, new, from_auth_for_testing (+8 more)); called by 2 (resumed_root_session_uses_thread_id_as_session_id, resumed_subagent_session_keeps_inherited_session_id); 10 external calls (clone, new, new, clone, unbounded, default, from_config, tempdir, vec!, channel).


##### `resumed_root_session_uses_thread_id_as_session_id`  (lines 5331–5354)

```
async fn resumed_root_session_uses_thread_id_as_session_id()
```

**Purpose**: Checks that when a normal root session is resumed, its session id matches the resumed thread id. This matters because callers and events need a stable identity for the restored conversation.

**Data flow**: It creates a fresh thread id, resumes a session from that id, then reads the session's thread id, session id, and first configuration event. The expected result is that both the session object and the emitted event use the resumed thread as the session id.

**Call relations**: It uses make_session_with_history_source_and_agent_control_and_rx to create the resumed session. After setup, it waits for the SessionConfigured event and checks that Session::new reported the same identity outward.

*Call graph*: calls 2 internal fn (make_session_with_history_source_and_agent_control_and_rx, new); 5 external calls (new, assert_eq!, default, panic!, Resumed).


##### `resumed_subagent_session_keeps_inherited_session_id`  (lines 5357–5389)

```
async fn resumed_subagent_session_keeps_inherited_session_id()
```

**Purpose**: Checks that a resumed subagent keeps the parent session id instead of replacing it with its own thread id. This preserves the idea that several agent threads can belong to one larger session.

**Data flow**: It creates a parent thread/session id and a separate child thread id. It resumes a subagent from the child thread while passing agent-control data that contains the parent session id. It then verifies that the thread id is the child thread, but the session id remains the inherited parent id, including in the emitted configuration event.

**Call relations**: It relies on make_session_with_history_source_and_agent_control_and_rx to build a resumed subagent session. The test observes the SessionConfigured event to ensure the identity choice is visible to clients too.

*Call graph*: calls 3 internal fn (make_session_with_history_source_and_agent_control_and_rx, from, new); 6 external calls (new, SubAgent, assert_eq!, default, panic!, Resumed).


##### `notify_request_permissions_response_ignores_unmatched_call_id`  (lines 5392–5418)

```
async fn notify_request_permissions_response_ignores_unmatched_call_id()
```

**Purpose**: Checks that a permission response with an unknown call id is ignored. This prevents an unrelated or stale response from accidentally granting powers to the current turn.

**Data flow**: It creates a session, marks a default active turn, then sends a permission response for the call id "missing". Since no pending request uses that id, nothing should be recorded. Reading granted turn permissions afterward returns none.

**Call relations**: The test calls the session's notification method directly. It verifies the guard around matching permission responses to the original request before any grant-recording logic can run.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 2 external calls (default, assert_eq!).


##### `record_granted_request_permissions_for_turn_uses_originating_turn`  (lines 5421–5469)

```
async fn record_granted_request_permissions_for_turn_uses_originating_turn()
```

**Purpose**: Checks that a turn-scoped permission grant is written to the turn that made the request, even if another turn has become active since then. This avoids granting permission to the wrong piece of work.

**Data flow**: It creates one active turn and saves its turn state, then replaces the session's active turn with a new one. It records a turn-scoped network permission while explicitly passing the original turn state. The original turn receives the grant; the current turn and the session-level grants remain unchanged.

**Call relations**: The test exercises record_granted_request_permissions_for_turn directly. It models the race where a response arrives after the active turn pointer has moved on.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 3 external calls (clone, default, assert_eq!).


##### `request_permission_grants_are_environment_keyed`  (lines 5472–5522)

```
async fn request_permission_grants_are_environment_keyed()
```

**Purpose**: Checks that permission grants are stored separately for each environment. A grant for a remote environment must not silently apply to the local environment.

**Data flow**: It records a turn-scoped grant for environment "remote" and confirms only that environment sees it. Then it records a session-scoped grant for the same environment and confirms the session grant is also keyed to "remote", not "local".

**Call relations**: The test calls the session's grant-recording path twice, once for turn scope and once for session scope. It then reads back both turn and session permission stores to confirm environment separation.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 3 external calls (clone, default, assert_eq!).


##### `enable_strict_auto_review_for_turn_uses_originating_turn`  (lines 5525–5555)

```
async fn enable_strict_auto_review_for_turn_uses_originating_turn()
```

**Purpose**: Checks that strict auto-review is enabled on the turn that asked for it, not merely on whatever turn is current later. Strict auto-review is a mode where later actions are checked more carefully.

**Data flow**: It creates an originating turn state, records a turn-scoped permission response with strict_auto_review set to true, and then reads that original turn state. The output is that strict auto-review is enabled there.

**Call relations**: This is another direct test of record_granted_request_permissions_for_turn. It focuses on the strict-auto-review flag rather than the permission profile itself.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 3 external calls (clone, default, assert!).


##### `strict_auto_review_session_scope_grants_no_permissions`  (lines 5558–5584)

```
fn strict_auto_review_session_scope_grants_no_permissions()
```

**Purpose**: Checks that a response asking for strict auto-review at session scope is normalized into a safe no-permission, turn-scoped response. This prevents a stricter review mode request from becoming a broad session grant.

**Data flow**: It builds a requested network permission and a response that combines session scope with strict auto-review. It passes both through the session's normalization function. The returned response has default empty permissions, turn scope, and strict auto-review turned off.

**Call relations**: The test exercises Session::normalize_request_permissions_response directly. It verifies the cleanup rule before any response would be recorded.

*Call graph*: 4 external calls (default, assert_eq!, normalize_request_permissions_response, new).


##### `request_permissions_emits_event_when_granular_policy_allows_requests`  (lines 5587–5673)

```
async fn request_permissions_emits_event_when_granular_policy_allows_requests()
```

**Purpose**: Checks that when the approval policy allows permission requests, the session emits a request event and waits for the answer. This is the user-facing approval flow.

**Data flow**: It creates a session and turn context, changes the approval policy so request-permissions is allowed, and starts a permission request in a background task. The test receives the emitted RequestPermissions event, checks its call id, environment id, and working directory, sends back an approval response, and confirms the original request returns that response.

**Call relations**: The test drives request_permissions_for_environment and observes the session event channel. It then uses notify_request_permissions_response to complete the pending request.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, default); 11 external calls (clone, get_mut, new, new, from_secs, default, Granular, assert_eq!, panic!, spawn (+1 more)).


##### `request_permissions_tool_resolves_relative_paths_against_selected_environment`  (lines 5676–5782)

```
async fn request_permissions_tool_resolves_relative_paths_against_selected_environment()
```

**Purpose**: Checks that the request_permissions tool resolves relative file paths against the chosen environment's working directory. This prevents asking for access to the wrong file when multiple environments exist.

**Data flow**: It creates a special working directory for a "remote" environment and configures the turn to use it. Then it invokes the request_permissions tool with a relative path, "relative.txt". The emitted request contains an absolute path under the remote environment directory, and the handler completes after the test sends a matching response.

**Call relations**: The test goes through RequestPermissionsHandler, which parses the tool call and forwards the request into the session. It observes the emitted RequestPermissions event and answers it through notify_request_permissions_response.

*Call graph*: calls 6 internal fn (make_session_and_context_with_rx, new, default, new, plain, from_abs_path); 15 external calls (clone, get_mut, new, new, default, from_secs, Granular, assert_eq!, json!, panic! (+5 more)).


##### `request_permissions_tool_rejects_unknown_environment_id`  (lines 5785–5814)

```
async fn request_permissions_tool_rejects_unknown_environment_id()
```

**Purpose**: Checks that the request_permissions tool rejects an environment id that is not part of the current turn. This gives the model a clear error instead of silently using the wrong environment.

**Data flow**: It invokes the tool with environment_id set to "missing" and a network permission request. The handler returns an error meant to be shown back to the model, saying the turn environment id is unknown.

**Call relations**: This test calls RequestPermissionsHandler directly. It confirms validation happens before the session tries to emit or record any permission request.

*Call graph*: calls 3 internal fn (make_session_and_context, new, plain); 6 external calls (new, new, assert_eq!, json!, panic!, new).


##### `request_permissions_response_materializes_session_cwd_grants_before_recording`  (lines 5817–5924)

```
async fn request_permissions_response_materializes_session_cwd_grants_before_recording()
```

**Purpose**: Checks that special file-system permissions, such as "project roots", are converted into concrete paths before being stored as session-wide grants. This makes later permission checks compare real paths instead of vague placeholders.

**Data flow**: It requests write access to the special project-roots path, receives the emitted permission request, and replies with a session-scoped grant. The session turns that special path into the actual request working directory before returning the response and before saving the session grant.

**Call relations**: The test drives request_permissions_for_environment, answers through notify_request_permissions_response, and then reads granted_session_permissions to verify the recorded form is materialized.

*Call graph*: calls 3 internal fn (make_session_and_context_with_rx, default, from_read_write_roots); 12 external calls (clone, get_mut, new, new, default, from_secs, Granular, assert_eq!, panic!, spawn (+2 more)).


##### `request_permissions_is_auto_denied_when_granular_policy_blocks_tool_requests`  (lines 5927–5985)

```
async fn request_permissions_is_auto_denied_when_granular_policy_blocks_tool_requests()
```

**Purpose**: Checks that permission requests are automatically denied when the granular approval policy disables request-permissions. In that mode, no user-facing request event should be emitted.

**Data flow**: It sets the policy so request_permissions is false, then asks for a network permission. The session immediately returns an empty turn-scoped response and the event receiver stays quiet.

**Call relations**: The test calls request_permissions_for_environment directly. It verifies that policy checking happens before the event-based approval flow starts.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, default); 7 external calls (get_mut, new, new, default, Granular, assert!, assert_eq!).


##### `submit_with_id_captures_current_span_trace_context`  (lines 5988–6032)

```
async fn submit_with_id_captures_current_span_trace_context()
```

**Purpose**: Checks that when a submission is sent into Codex, it captures the current trace context if the submission does not already have one. Trace context is metadata that lets logs from related work be connected across tasks and services.

**Data flow**: It creates a Codex object with a submission channel, installs test tracing, and enters a span with a known W3C trace id. It submits an interrupt operation without trace data. The item received from the channel now contains the trace context from the current span.

**Call relations**: The test calls Codex::submit_with_id and then reads the submission channel. It proves the method enriches outgoing submissions with tracing information.

*Call graph*: calls 2 internal fn (make_session_and_context, install_test_tracing); 7 external calls (new, assert!, assert_eq!, bounded, unbounded, info_span!, channel).


##### `new_default_turn_captures_current_span_trace_id`  (lines 6035–6068)

```
async fn new_default_turn_captures_current_span_trace_id()
```

**Purpose**: Checks that a newly created default turn remembers the current trace id. This lets later turn work be tied back to the request that started it.

**Data flow**: It enters a tracing span with a known trace id, calls session.new_default_turn, and reads the turn context's trace_id field. The stored trace id matches the active span's trace id.

**Call relations**: The test calls new_default_turn inside an instrumented span. It verifies trace metadata is copied from the surrounding request into the turn context.

*Call graph*: calls 2 internal fn (make_session_and_context, install_test_tracing); 4 external calls (current, assert!, assert_eq!, info_span!).


##### `submission_dispatch_span_prefers_submission_trace_context`  (lines 6071–6102)

```
fn submission_dispatch_span_prefers_submission_trace_context()
```

**Purpose**: Checks that a dispatch span uses the trace context attached to the submission rather than whatever trace is currently ambient. This keeps work connected to the client request that created the submission.

**Data flow**: It creates one ambient trace and a different trace on a submission. It builds the dispatch span while inside the ambient span. The dispatch span's trace id matches the submission trace, not the ambient one.

**Call relations**: The test calls submission_dispatch_span directly. It confirms the dispatch layer prioritizes explicit submission metadata.

*Call graph*: calls 1 internal fn (install_test_tracing); 3 external calls (assert!, assert_eq!, info_span!).


##### `submission_dispatch_span_uses_debug_for_realtime_audio`  (lines 6105–6127)

```
fn submission_dispatch_span_uses_debug_for_realtime_audio()
```

**Purpose**: Checks that dispatch spans for real-time audio submissions are logged at debug level. Audio frames can be frequent, so this avoids noisy normal-level tracing.

**Data flow**: It creates a submission whose operation is a real-time audio frame and asks for its dispatch span. The span metadata reports DEBUG level.

**Call relations**: The test calls submission_dispatch_span with a RealtimeConversationAudio operation. It verifies the special logging-level rule for high-volume audio events.

*Call graph*: calls 1 internal fn (install_test_tracing); 2 external calls (assert_eq!, RealtimeConversationAudio).


##### `op_kind_for_input_and_context_ops`  (lines 6130–6149)

```
fn op_kind_for_input_and_context_ops()
```

**Purpose**: Checks the short string names returned for user-input and thread-settings operations. These names are useful for logging, tracing, and routing without dumping full operation data.

**Data flow**: It creates a UserInput operation and a ThreadSettings operation, calls kind on each, and compares the returned strings with the expected labels.

**Call relations**: The test exercises Op::kind directly. It protects the stable labels used elsewhere by the session machinery.

*Call graph*: 1 external calls (assert_eq!).


##### `user_turn_updates_approvals_reviewer`  (lines 6152–6194)

```
async fn user_turn_updates_approvals_reviewer()
```

**Purpose**: Checks that a user turn can update the session's approvals reviewer setting. This matters when a client changes how approvals should be reviewed during a conversation.

**Data flow**: It creates a session, builds a user input operation that includes thread settings with approvals_reviewer set to AutoReview, and passes it through the user-input handler. Afterward, the session state shows AutoReview in the session configuration.

**Call relations**: The test calls handlers::user_input_or_turn, which applies user input and thread-setting updates. It then inspects session state to confirm the setting was stored.

*Call graph*: calls 3 internal fn (user_input_or_turn, make_session_and_context_with_rx, local_selections); 3 external calls (default, assert_eq!, vec!).


##### `turn_environments_set_primary_environment`  (lines 6197–6256)

```
async fn turn_environments_set_primary_environment()
```

**Purpose**: Checks that starting a turn with selected environments sets the primary environment and updates the turn working directory. The primary environment is the default place where tools run.

**Data flow**: It creates a selected working directory, starts a new turn with one local environment rooted there, then reads the turn context and stored environment service. The turn has one environment, that environment is primary, the turn config uses the selected directory, and later default turns reuse the stored primary environment.

**Call relations**: The test calls session.new_turn_with_sub_id with an environment update, then checks both the returned turn context and the session's turn-environment service. It also calls new_default_turn to verify the selection persists.

*Call graph*: calls 3 internal fn (make_session_and_context_with_rx, new, try_from); 4 external calls (default, assert!, assert_eq!, vec!).


##### `default_turn_does_not_overlay_legacy_fallback_cwd_onto_stored_thread_environments`  (lines 6259–6289)

```
async fn default_turn_does_not_overlay_legacy_fallback_cwd_onto_stored_thread_environments()
```

**Purpose**: Checks that a default turn respects stored thread environments instead of overwriting them with the older fallback working directory. This prevents losing the user's selected environment.

**Data flow**: It manually stores a selected environment and matching session configuration, then creates a default turn. The turn keeps that selected environment and uses its working directory in both the deprecated cwd field and the current config.

**Call relations**: The test updates the session's turn-environment service and session configuration, then calls new_default_turn. It verifies that stored environment state wins over legacy fallback behavior.

*Call graph*: calls 3 internal fn (make_session_and_context_with_rx, local, try_from); 3 external calls (assert!, assert_eq!, vec!).


##### `default_turn_honors_empty_stored_thread_environments`  (lines 6292–6311)

```
async fn default_turn_honors_empty_stored_thread_environments()
```

**Purpose**: Checks that an explicitly empty environment list stays empty for a default turn. Empty means no primary environment, not "recreate the default one."

**Data flow**: It clears stored environment selections and the session configuration environment list, then creates a default turn. The turn has no primary environment and no turn environments, while its working directory falls back to the session config directory.

**Call relations**: The test prepares empty stored state and calls new_default_turn. It protects the distinction between missing environment data and deliberately empty environment data.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 3 external calls (new, assert!, assert_eq!).


##### `primary_environment_uses_first_turn_environment`  (lines 6314–6353)

```
async fn primary_environment_uses_first_turn_environment()
```

**Purpose**: Checks that the primary environment is simply the first environment in the turn's environment list. This makes ordering meaningful and predictable.

**Data flow**: It starts with an existing turn environment, adds a second one with a different working directory, and then asks for the primary environment. The primary remains the first environment, while the second keeps its own working directory.

**Call relations**: The test mutates the turn context directly and calls the primary helper. It verifies the selection rule used by other session code.

*Call graph*: calls 3 internal fn (make_session_and_context, new, from_abs_path); 2 external calls (clone, assert_eq!).


##### `empty_turn_environments_clear_primary_environment`  (lines 6356–6379)

```
async fn empty_turn_environments_clear_primary_environment()
```

**Purpose**: Checks that starting a turn with an empty environment selection clears the primary environment. This lets clients intentionally run a turn with no selected execution environment.

**Data flow**: It starts a new turn with an environment update containing an empty list. The returned turn context has no primary environment and no environment entries, while its working directory remains the session's configured directory.

**Call relations**: The test calls session.new_turn_with_sub_id with an empty TurnEnvironmentSelections value. It verifies the new-turn setup code does not invent a replacement environment.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, new); 4 external calls (default, assert!, assert_eq!, vec!).


##### `spawn_task_turn_span_inherits_dispatch_trace_context`  (lines 6382–6482)

```
async fn spawn_task_turn_span_inherits_dispatch_trace_context()
```

**Purpose**: Checks that a spawned session task runs under a trace connected to the submission dispatch trace. This keeps logs from the task linked to the submission that caused it.

**Data flow**: It defines a small task that records the current trace context when it runs. The test creates a request trace, builds a submission dispatch span from it, spawns the task inside that span, waits for turn completion, and compares trace ids. The task has the same trace id but a different span id, meaning it is part of the same trace but has its own span.

**Call relations**: The test uses submission_dispatch_span and session.spawn_task together. The custom SessionTask captures the trace context so the test can verify tracing is inherited across the task boundary.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, install_test_tracing); 11 external calls (clone, new, from_secs, assert!, assert_eq!, assert_ne!, context_from_w3c_trace_context, new, timeout, info_span! (+1 more)).


##### `shutdown_complete_does_not_append_to_thread_store_after_shutdown`  (lines 6486–6530)

```
async fn shutdown_complete_does_not_append_to_thread_store_after_shutdown()
```

**Purpose**: Checks that once shutdown is complete, the session does not append extra data to the thread store. This avoids writing stale or duplicate persistence records after the conversation has ended.

**Data flow**: It replaces the session's thread store with an in-memory store that counts calls, creates live thread persistence, then runs the shutdown handler. The store reports one thread creation and one thread shutdown, with no extra append calls.

**Call relations**: The test sets up a LiveThread and calls handlers::shutdown. It checks the thread-store call counters afterward to verify clean persistence behavior.

*Call graph*: calls 3 internal fn (make_session_and_context, default, create); 6 external calls (clone, new, new, assert!, assert_eq!, default).


##### `submission_loop_channel_close_emits_thread_stop_lifecycle`  (lines 6533–6582)

```
async fn submission_loop_channel_close_emits_thread_stop_lifecycle()
```

**Purpose**: Checks that when the submission channel closes, thread-stop lifecycle callbacks are run. Lifecycle callbacks let extensions clean up or record data when a thread ends.

**Data flow**: It registers a test extension contributor that checks the thread id and stored extension data when on_thread_stop runs. Then it closes the submission channel and runs the submission loop. The callback is called exactly once.

**Call relations**: The test configures the session extension registry and calls submission_loop with a closed receiver. The loop's shutdown path hands control to the extension lifecycle hook.

*Call graph*: calls 1 internal fn (make_session_and_context); 6 external calls (clone, new, assert_eq!, bounded, new, new).


##### `submission_loop_channel_close_aborts_active_turn_before_thread_stop_lifecycle`  (lines 6585–6664)

```
async fn submission_loop_channel_close_aborts_active_turn_before_thread_stop_lifecycle()
```

**Purpose**: Checks shutdown ordering when the submission channel closes: active turns must be aborted before the thread-stop callback runs. This gives extensions a clear sequence of events.

**Data flow**: It registers a recorder for both turn-abort and thread-stop lifecycle events, starts a never-ending task as the active turn, closes the submission channel, and runs the submission loop. The recorded order is turn_abort first, then thread_stop.

**Call relations**: The test uses session.spawn_task to create active work, then calls submission_loop. The loop cancels the turn and invokes extension lifecycle callbacks in the expected order.

*Call graph*: calls 1 internal fn (make_session_and_context); 7 external calls (clone, new, new, assert_eq!, bounded, new, new).


##### `shutdown_and_wait_allows_multiple_waiters`  (lines 6667–6702)

```
async fn shutdown_and_wait_allows_multiple_waiters()
```

**Purpose**: Checks that more than one caller can wait for Codex shutdown at the same time. This is useful when different parts of the program all need to know when the session loop has ended.

**Data flow**: It creates a Codex object with a fake session loop that receives a shutdown submission and finishes after a short delay. Two tasks call shutdown_and_wait concurrently. Both complete successfully.

**Call relations**: The test calls Codex::shutdown_and_wait from two spawned tasks. The fake session-loop termination handle stands in for the real background loop.

*Call graph*: calls 1 internal fn (make_session_and_context); 9 external calls (clone, new, from_millis, assert_eq!, bounded, unbounded, spawn, sleep, channel).


##### `shutdown_and_wait_waits_when_shutdown_is_already_in_progress`  (lines 6705–6739)

```
async fn shutdown_and_wait_waits_when_shutdown_is_already_in_progress()
```

**Purpose**: Checks that shutdown_and_wait waits for the session loop to finish even if sending the shutdown command cannot start a fresh shutdown because shutdown is already underway. Waiting is still required so callers know cleanup is complete.

**Data flow**: It creates a Codex object whose submission receiver is already closed and whose session loop only finishes after a one-shot signal. It starts shutdown_and_wait, confirms it is still waiting, sends the completion signal, and then the waiter completes successfully.

**Call relations**: The test calls Codex::shutdown_and_wait while the fake loop is blocked. It verifies the method is tied to loop termination, not just to sending a shutdown message.

*Call graph*: calls 1 internal fn (make_session_and_context); 10 external calls (clone, new, from_millis, assert!, bounded, unbounded, spawn, channel, sleep, channel).


##### `shutdown_and_wait_shuts_down_cached_guardian_subagent`  (lines 6742–6796)

```
async fn shutdown_and_wait_shuts_down_cached_guardian_subagent()
```

**Purpose**: Checks that when a parent Codex session shuts down, a cached guardian subagent is also told to shut down. This matters because leftover child sessions could keep tasks, channels, or resources alive after the main session is gone.

**Data flow**: The test creates a parent session and a fake child Codex session, then stores the child inside the parent guardian-review cache. It calls the parent shutdown method and waits on a one-time signal from the child. The expected result is that the child receives a shutdown operation.

**Call relations**: The async test runner invokes this test. It builds sessions through make_session_and_context, starts lightweight background loops with tokio, then exercises Codex::shutdown_and_wait to prove shutdown flows from the parent to the cached guardian subagent.

*Call graph*: calls 1 internal fn (make_session_and_context); 8 external calls (clone, new, assert_eq!, bounded, unbounded, spawn, channel, channel).


##### `cached_guardian_subagent_exposes_its_rollout_path`  (lines 6799–6828)

```
async fn cached_guardian_subagent_exposes_its_rollout_path()
```

**Purpose**: Checks that a cached guardian subagent can report the path where its rollout, or saved thread record, is stored. This lets parent logic find the child session’s saved conversation trail.

**Data flow**: The test creates a parent session and a child session, attaches persistence to the child, and caches the child in the parent’s guardian review manager. It then asks the parent manager for the trunk rollout path. The returned value should be the child’s rollout path.

**Call relations**: The test runner calls this directly. It relies on attach_thread_persistence to give the child a saved-history location, then verifies the guardian-review manager exposes that location instead of hiding it inside the cached child.

*Call graph*: calls 2 internal fn (attach_thread_persistence, make_session_and_context); 6 external calls (new, assert_eq!, bounded, unbounded, spawn, channel).


##### `shutdown_and_wait_shuts_down_tracked_ephemeral_guardian_review`  (lines 6831–6885)

```
async fn shutdown_and_wait_shuts_down_tracked_ephemeral_guardian_review()
```

**Purpose**: Checks that temporary guardian review sessions are shut down with their parent session. These ephemeral sessions are not cached long-term, but they still must not be left running.

**Data flow**: The test builds a parent session and a fake child review session. It registers the child as an ephemeral guardian review, shuts down the parent, and waits for a one-shot confirmation from the child. The child should receive an explicit shutdown operation.

**Call relations**: The async test runner calls this test. It uses make_session_and_context to create the parent and child, then verifies that Codex::shutdown_and_wait reaches sessions registered through the guardian-review tracking path.

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

**Purpose**: Builds a test session, its turn context, and an event receiver, while letting the caller choose authentication and adjust configuration. It is a convenience wrapper that creates a temporary Codex home directory automatically.

**Data flow**: The function receives test authentication, a list of dynamic tools, and a callback that edits the config. It creates a temporary directory and passes everything to the lower-level session builder. It returns an Arc-wrapped session, an Arc-wrapped turn context, and a channel receiver for emitted events.

**Call relations**: Several tests call this when they need a normal test session but with one or two config changes. It hands off the detailed setup to make_session_and_context_with_auth_config_home_and_rx so callers do not need to repeat boilerplate.

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

**Purpose**: Constructs a full in-memory test Session and TurnContext using a chosen Codex home folder. This is the main factory for tests that need realistic session objects without external network calls.

**Data flow**: The function takes authentication, dynamic tool descriptions, a home directory path, and a config-editing callback. It builds config, auth, model information, telemetry, environment objects, plugin and skill managers, session services, and event channels. It returns a ready-to-use session, turn context, and event receiver.

**Call relations**: Higher-level helpers call this to avoid duplicating a large setup sequence. The sessions it creates are then used by many tests to exercise real methods such as build_initial_context, build_settings_update_items, and record_context_updates_and_set_reference_context_item.

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

**Purpose**: Creates a standard test session with optional dynamic tools and a fake API key. It is useful when a test needs event output but does not need custom authentication or config.

**Data flow**: The function receives a list of dynamic tool specs. It supplies a test API key and an empty config callback to the more flexible session builder. It returns the session, turn context, and event receiver.

**Call relations**: Tests and the simpler make_session_and_context_with_rx helper call this. It delegates all real construction work to make_session_and_context_with_auth_and_config_and_rx.

*Call graph*: calls 2 internal fn (make_session_and_context_with_auth_and_config_and_rx, from_api_key); called by 4 (make_session_and_context_with_rx, assert_failed_apply_patch_tracks_committed_delta, invalidation_emits_empty_turn_diff, net_zero_patch_emits_empty_turn_diff).


##### `make_session_and_context_with_rx`  (lines 7162–7168)

```
async fn make_session_and_context_with_rx() -> (
    Arc<Session>,
    Arc<TurnContext>,
    async_channel::Receiver<Event>,
)
```

**Purpose**: Creates the most common kind of test session: no dynamic tools, default fake authentication, and an event receiver. It keeps individual tests short and focused on the behavior under test.

**Data flow**: The function takes no input. It calls the dynamic-tool helper with an empty list. The output is a standard session, turn context, and receiver for events emitted by the session.

**Call relations**: Many tests use this helper when they need to observe warnings or events. It is a thin wrapper around make_session_and_context_with_dynamic_tools_and_rx.

*Call graph*: calls 1 internal fn (make_session_and_context_with_dynamic_tools_and_rx); called by 68 (delegated_mcp_guardian_abort_returns_synthetic_decline_answer, delegated_mcp_user_reviewer_returns_none_without_metadata, forward_events_cancelled_while_send_blocked_shuts_down_delegate, forward_ops_preserves_submission_trace_context, handle_exec_approval_uses_call_id_for_guardian_review_and_approval_id_for_reply, handle_request_permissions_uses_tool_call_id_for_round_trip, run_codex_thread_interactive_respects_pre_cancelled_spawn, test_review_session, cancelled_guardian_review_emits_terminal_abort_without_warning, guardian_review_surfaces_responses_api_errors_in_rejection_reason (+15 more)); 1 external calls (new).


##### `refresh_mcp_servers_is_deferred_until_next_turn`  (lines 7171–7213)

```
async fn refresh_mcp_servers_is_deferred_until_next_turn()
```

**Purpose**: Checks that MCP server refreshes are not applied immediately when requested, but are picked up at the next turn. MCP means Model Context Protocol, a way for external tools or servers to connect to the agent.

**Data flow**: The test creates a session and remembers the current cancellation token for MCP startup work. It stores a pending refresh config, confirms nothing changed yet, then calls the refresh method for the next turn. Afterward, the old token should be cancelled, the pending config cleared, and a fresh token installed.

**Call relations**: The test runner invokes this test. It uses make_session_and_context to set up a normal session and then directly exercises refresh_mcp_servers_if_requested, which is the method that consumes deferred refresh requests.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert!, json!, to_value).


##### `spawn_task_does_not_update_previous_turn_settings_for_non_run_turn_tasks`  (lines 7216–7240)

```
async fn spawn_task_does_not_update_previous_turn_settings_for_non_run_turn_tasks()
```

**Purpose**: Checks that background or non-run tasks do not accidentally overwrite the remembered settings from the previous user turn. This prevents unrelated tasks from confusing later context-difference logic.

**Data flow**: The test clears previous-turn settings, starts a never-ending regular task with simple user input, then aborts all tasks. It reads previous-turn settings afterward. The expected value is still None.

**Call relations**: The test runner calls this test. It uses make_session_and_context_with_rx for setup, then exercises Session::spawn_task and Session::abort_all_tasks to verify the previous-turn bookkeeping is left untouched.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 3 external calls (clone, assert_eq!, vec!).


##### `build_settings_update_items_emits_environment_item_for_network_changes`  (lines 7243–7302)

```
async fn build_settings_update_items_emits_environment_item_for_network_changes()
```

**Purpose**: Checks that when network permission settings change, the session creates an environment-context update for the model. This helps the model understand which domains are allowed or denied.

**Data flow**: The test creates an old and new turn context, modifies the new config to allow one domain and deny another, then asks the session to build settings update items. It extracts user-visible text and looks for an environment block containing the network rules. The output should include the changed network context.

**Call relations**: The test runner invokes this test. It relies on build_settings_update_items to compare a previous context item with the current turn context and produce only the needed update.

*Call graph*: calls 4 internal fn (new, new, make_session_and_context, user_input_texts); 4 external calls (new, default, assert!, from).


##### `environment_context_uses_session_shell_when_environment_shell_is_absent`  (lines 7305–7345)

```
async fn environment_context_uses_session_shell_when_environment_shell_is_absent()
```

**Purpose**: Checks the fallback rule for shell reporting in environment context. If an environment does not specify its own shell, the session shell should be shown; if it does, that environment shell should win.

**Data flow**: The test sets the session shell to PowerShell and removes shell values from all turn environments. It renders environment context and expects PowerShell. Then it sets the primary environment shell to Cmd, renders again, and expects Cmd.

**Call relations**: The test runner calls this directly. It uses EnvironmentContext::from_turn_context to verify how session-level and environment-level shell information are combined.

*Call graph*: calls 2 internal fn (from_turn_context, make_session_and_context); 3 external calls (new, from, assert!).


##### `build_settings_update_items_emits_environment_item_for_time_changes`  (lines 7348–7371)

```
async fn build_settings_update_items_emits_environment_item_for_time_changes()
```

**Purpose**: Checks that changes to date and timezone are reported to the model as environment updates. This matters because the model may answer differently depending on the current date or local time zone.

**Data flow**: The test creates a previous context and a current context, then changes the current date and timezone. It asks the session for settings update items and searches the resulting text. The expected update includes both the new date and timezone.

**Call relations**: The test runner invokes this test. It exercises build_settings_update_items, which compares old and new context snapshots and emits a compact update when time-related environment data changed.

*Call graph*: calls 2 internal fn (make_session_and_context, user_input_texts); 2 external calls (new, assert!).


##### `build_settings_update_items_omits_environment_item_when_disabled`  (lines 7374–7400)

```
async fn build_settings_update_items_omits_environment_item_when_disabled()
```

**Purpose**: Checks that environment-context updates are not emitted when the configuration says to exclude environment context. This protects users or clients who intentionally turn that feature off.

**Data flow**: The test creates previous and current contexts, disables include_environment_context in the current config, and changes the current date. It builds update items and scans the user text. No environment-context block should appear.

**Call relations**: The test runner calls this test. It verifies build_settings_update_items respects the configuration flag even when there is a real environment change.

*Call graph*: calls 2 internal fn (make_session_and_context, user_input_texts); 2 external calls (new, assert!).


##### `build_settings_update_items_emits_realtime_start_when_session_becomes_live`  (lines 7403–7428)

```
async fn build_settings_update_items_emits_realtime_start_when_session_becomes_live()
```

**Purpose**: Checks that the session tells the model when a realtime conversation becomes active. Realtime here means an ongoing live conversation mode rather than a normal single-turn exchange.

**Data flow**: The test starts with an inactive previous context, changes the current context to realtime active, and builds update items. It reads developer messages from those items. At least one should contain a realtime-conversation start marker.

**Call relations**: The test runner invokes this test. It exercises build_settings_update_items and the helper developer_input_texts to confirm the realtime start notice is produced.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 2 external calls (new, assert!).


##### `build_settings_update_items_emits_realtime_end_when_session_stops_being_live`  (lines 7431–7456)

```
async fn build_settings_update_items_emits_realtime_end_when_session_stops_being_live()
```

**Purpose**: Checks that the session tells the model when realtime mode has ended. Without this, the model might keep assuming live-conversation rules still apply.

**Data flow**: The test marks the previous context as realtime active and the current context as inactive. It builds update items and scans developer text. The expected output includes an inactive reason.

**Call relations**: The test runner calls this directly. It validates build_settings_update_items behavior when realtime_active changes from true to false.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `build_settings_update_items_uses_previous_turn_settings_for_realtime_end`  (lines 7459–7490)

```
async fn build_settings_update_items_uses_previous_turn_settings_for_realtime_end()
```

**Purpose**: Checks that realtime-end detection can use saved previous-turn settings when the previous context item does not contain realtime information. This keeps older or incomplete history records usable.

**Data flow**: The test removes realtime state from the previous context item, stores previous-turn settings saying realtime was active, and sets the current context to inactive. It builds update items and looks for the inactive message. The expected result is a realtime-end update based on the saved settings.

**Call relations**: The test runner invokes this test. It combines Session::set_previous_turn_settings with build_settings_update_items to verify the fallback path.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `build_initial_context_uses_previous_realtime_state`  (lines 7493–7519)

```
async fn build_initial_context_uses_previous_realtime_state()
```

**Purpose**: Checks that initial context describes active realtime state once, but does not duplicate it when resuming from a matching reference context. This avoids repeating the same instruction to the model.

**Data flow**: The test first makes a realtime-active turn context and builds initial context, expecting a realtime marker. It then stores that context as the reference context and builds again. The resumed build should not include a duplicate realtime marker.

**Call relations**: The test runner calls this test. It exercises build_initial_context together with the session state’s reference context item, which acts as the baseline for what the model already knows.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `make_multi_agent_v2_usage_hint_test_session`  (lines 7521–7537)

```
async fn make_multi_agent_v2_usage_hint_test_session(
    enable_multi_agent_v2: bool,
) -> (Arc<Session>, Arc<TurnContext>)
```

**Purpose**: Creates a test session configured with root-agent and subagent usage hints for the Multi-Agent V2 feature. It lets related tests switch the feature on or off without repeating setup.

**Data flow**: The function receives a boolean for enabling Multi-Agent V2. It builds a session with fake API authentication, sets both hint texts in the config, and optionally enables the feature flag. It returns the session and turn context.

**Call relations**: Multi-agent usage-hint tests call this helper. It delegates session creation to make_session_and_context_with_auth_and_config_and_rx and supplies the specific config needed for those tests.

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

**Purpose**: Provides a fake prompt extension used by tests. It contributes a developer-policy prompt fragment only when test state exists in the thread extension store.

**Data flow**: The method receives session-level and thread-level extension data. It checks whether PromptExtensionTestState is present in the thread store. If present, it returns one developer prompt fragment; otherwise it returns an empty list.

**Call relations**: The test extension registry calls this contributor while building initial context. The prompt-extension tests use it to prove extension fragments are included only when the needed extension state has been inserted.

*Call graph*: 1 external calls (pin).


##### `prompt_extension_test_registry`  (lines 7565–7570)

```
fn prompt_extension_test_registry() -> Arc<codex_extension_api::ExtensionRegistry<crate::config::Config>>
```

**Purpose**: Builds a tiny extension registry for tests, containing the fake prompt contributor. It gives tests a controlled way to simulate prompt extensions.

**Data flow**: The function creates a registry builder, registers PromptExtensionTestContributor, builds the registry, and wraps it in Arc for shared ownership. The output is a ready-to-install extension registry.

**Call relations**: The prompt-extension tests call this helper and assign the returned registry to session.services.extensions. During build_initial_context, the registry asks its contributor for prompt fragments.

*Call graph*: calls 1 internal fn (new); called by 2 (build_initial_context_includes_prompt_fragments_from_extensions, build_initial_context_omits_prompt_fragments_without_extension_state); 1 external calls (new).


##### `build_initial_context_includes_prompt_fragments_from_extensions`  (lines 7573–7591)

```
async fn build_initial_context_includes_prompt_fragments_from_extensions()
```

**Purpose**: Checks that initial context includes prompt fragments supplied by an extension when that extension’s thread state is present. This proves extension hooks can add model instructions.

**Data flow**: The test installs the fake extension registry into a session and inserts the test state into thread extension data. It builds initial context and reads developer messages. The expected developer text is the fake extension’s prompt fragment.

**Call relations**: The test runner calls this test. It uses prompt_extension_test_registry, then verifies build_initial_context consults extension contributors.

*Call graph*: calls 3 internal fn (developer_message_texts, make_session_and_context, prompt_extension_test_registry); 1 external calls (assert!).


##### `build_initial_context_omits_prompt_fragments_without_extension_state`  (lines 7594–7608)

```
async fn build_initial_context_omits_prompt_fragments_without_extension_state()
```

**Purpose**: Checks that extension prompt text is not included when the extension has no enabling state. This prevents extensions from adding instructions accidentally.

**Data flow**: The test installs the fake registry but does not insert PromptExtensionTestState. It builds initial context and scans developer messages. The fake prompt text should be absent.

**Call relations**: The test runner invokes this test. It uses the same registry as the positive prompt-extension test but leaves the thread store empty to verify the opposite behavior.

*Call graph*: calls 3 internal fn (developer_message_texts, make_session_and_context, prompt_extension_test_registry); 1 external calls (assert!).


##### `build_initial_context_adds_multi_agent_v2_root_usage_hint_as_developer_message`  (lines 7611–7630)

```
async fn build_initial_context_adds_multi_agent_v2_root_usage_hint_as_developer_message()
```

**Purpose**: Checks that a root thread gets the root usage hint when Multi-Agent V2 is enabled. This ensures the top-level agent receives the right guidance.

**Data flow**: The test creates a Multi-Agent V2 test session with the feature enabled, builds initial context, and reads developer messages. It expects a standalone root guidance message and no subagent guidance.

**Call relations**: The test runner calls this test. It relies on make_multi_agent_v2_usage_hint_test_session for setup and verifies build_initial_context chooses the root-agent hint.

*Call graph*: calls 2 internal fn (developer_message_texts, make_multi_agent_v2_usage_hint_test_session); 1 external calls (assert!).


##### `build_initial_context_adds_multi_agent_v2_subagent_usage_hint_as_developer_message`  (lines 7633–7668)

```
async fn build_initial_context_adds_multi_agent_v2_subagent_usage_hint_as_developer_message()
```

**Purpose**: Checks that a subagent thread gets the subagent usage hint when Multi-Agent V2 is enabled. This keeps child agents from receiving instructions meant for the root agent.

**Data flow**: The test creates a Multi-Agent V2 session, changes the session source to a subagent thread, and mirrors that change in the turn context. It builds initial context and scans developer messages. It expects subagent guidance and rejects root guidance.

**Call relations**: The test runner invokes this test. It uses make_multi_agent_v2_usage_hint_test_session, then edits session state and turn context so build_initial_context sees the thread as a subagent.

*Call graph*: calls 4 internal fn (developer_message_texts, make_multi_agent_v2_usage_hint_test_session, try_from, new); 3 external calls (get_mut, SubAgent, assert!).


##### `build_initial_context_omits_multi_agent_v2_usage_hints_when_feature_disabled`  (lines 7671–7687)

```
async fn build_initial_context_omits_multi_agent_v2_usage_hints_when_feature_disabled()
```

**Purpose**: Checks that Multi-Agent V2 usage hints are not added when the feature flag is off. Configured text alone should not activate the feature.

**Data flow**: The test creates a session with hint text but without enabling Multi-Agent V2. It builds initial context and reads developer messages. Neither the root nor subagent hint should appear.

**Call relations**: The test runner calls this test. It uses make_multi_agent_v2_usage_hint_test_session with the disabled setting to verify build_initial_context respects the feature flag.

*Call graph*: calls 2 internal fn (developer_message_texts, make_multi_agent_v2_usage_hint_test_session); 1 external calls (assert!).


##### `build_initial_context_omits_multi_agent_v2_usage_hints_when_hint_disabled`  (lines 7690–7715)

```
async fn build_initial_context_omits_multi_agent_v2_usage_hints_when_hint_disabled()
```

**Purpose**: Checks that Multi-Agent V2 usage hints can be turned off even when the feature itself is enabled. This gives configuration a separate kill switch for the hint text.

**Data flow**: The test builds a session with Multi-Agent V2 enabled, usage hints disabled, and both hint strings set. It builds initial context and scans developer messages. Neither hint should be included.

**Call relations**: The test runner invokes this test. It uses make_session_and_context_with_auth_and_config_and_rx to create the exact configuration, then tests build_initial_context.

*Call graph*: calls 3 internal fn (developer_message_texts, make_session_and_context_with_auth_and_config_and_rx, from_api_key); 2 external calls (new, assert!).


##### `build_initial_context_omits_default_image_save_location_with_image_history`  (lines 7718–7741)

```
async fn build_initial_context_omits_default_image_save_location_with_image_history()
```

**Purpose**: Checks that initial context does not include default image-save instructions even when the conversation history contains an image generation call. This avoids repeating unnecessary storage details.

**Data flow**: The test inserts an image-generation response item into session history. It then builds initial context and scans developer text. No message about generated images being saved to a default location should appear.

**Call relations**: The test runner calls this test. It uses replace_history to seed history and build_initial_context to verify what instructions are shown to the model.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 2 external calls (assert!, vec!).


##### `build_initial_context_omits_default_image_save_location_without_image_history`  (lines 7744–7756)

```
async fn build_initial_context_omits_default_image_save_location_without_image_history()
```

**Purpose**: Checks the same image-save instruction rule for an empty history. The initial context should not mention a default generated-image save location.

**Data flow**: The test creates a fresh session, builds initial context, and reads developer text. It expects no generated-image save-location instruction.

**Call relations**: The test runner invokes this test. It is the no-history companion to the image-history test and directly exercises build_initial_context.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `build_initial_context_trims_skill_metadata_from_context_window_budget`  (lines 7759–7804)

```
async fn build_initial_context_trims_skill_metadata_from_context_window_budget()
```

**Purpose**: Checks that skill metadata is trimmed when the model’s context window is very small. A context window is the amount of text the model can consider at once.

**Data flow**: The test gives the turn two skills and shrinks the model context window. It builds initial context and scans developer text. The output should contain neither the budget warning nor the skill entries, meaning the oversized skill list was removed from the model-visible context.

**Call relations**: The test runner calls this test. It sets TurnSkillsContext directly and relies on build_initial_context to apply the skill metadata budget.

*Call graph*: calls 3 internal fn (developer_input_texts, make_session_and_context, new); 4 external calls (new, assert!, default, vec!).


##### `emit_thread_start_skill_metrics_records_enabled_kept_and_truncated_values`  (lines 7807–7850)

```
fn emit_thread_start_skill_metrics_records_enabled_kept_and_truncated_values()
```

**Purpose**: Checks that skill rendering records telemetry when the skill list is too large. Telemetry here means numeric runtime measurements used to understand behavior in aggregate.

**Data flow**: The test creates one skill, gives rendering a one-character budget, and asks build_available_skills to render it with thread-start side effects. It then reads the telemetry snapshot. Metrics should show one enabled skill, zero kept skills, one truncated skill, and four truncated description characters.

**Call relations**: The test runner calls this synchronous test. It exercises build_available_skills and verifies the telemetry side effects through test_session_telemetry_without_metadata.

*Call graph*: calls 1 internal fn (test_session_telemetry_without_metadata); 4 external calls (assert_eq!, default, Characters, vec!).


##### `emit_thread_start_skill_metrics_records_description_truncated_chars_without_omitted_skills`  (lines 7853–7906)

```
fn emit_thread_start_skill_metrics_records_description_truncated_chars_without_omitted_skills()
```

**Purpose**: Checks telemetry for a case where skill descriptions are shortened but no whole skills are omitted. This distinguishes partial trimming from dropping skills entirely.

**Data flow**: The test creates two skills and computes a budget large enough for their names and paths but not full descriptions. It renders the skills and inspects the report and telemetry. The result should show zero omitted skills and eight truncated description characters.

**Call relations**: The test runner invokes this test. It calls build_available_skills with thread-start telemetry side effects and verifies the metrics snapshot afterward.

*Call graph*: calls 1 internal fn (test_session_telemetry_without_metadata); 5 external calls (assert_eq!, default, Characters, test_path_buf, vec!).


##### `build_initial_context_emits_thread_start_skill_warning_on_repeated_builds`  (lines 7909–7961)

```
async fn build_initial_context_emits_thread_start_skill_warning_on_repeated_builds()
```

**Purpose**: Checks that skill-budget warnings are emitted as events each time initial context is built, even on repeated builds. This ensures callers are warned whenever the oversized skill list affects a build.

**Data flow**: The test creates a session with an event receiver, installs two skills, and makes the context window tiny. It builds initial context, waits for a warning event, builds again, and waits for another warning. Both warnings should contain the same budget message.

**Call relations**: The test runner calls this async test. It uses make_session_and_context_with_rx so it can observe events emitted by build_initial_context.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, new); 7 external calls (into_inner, new, from_secs, assert!, default, timeout, vec!).


##### `handle_output_item_done_records_image_save_history_message`  (lines 7964–8018)

```
async fn handle_output_item_done_records_image_save_history_message()
```

**Purpose**: Checks that a completed image-generation output saves the image file and records an explanatory history message before the image item. This tells future turns where generated images are stored.

**Data flow**: The test creates an image-generation response item with base64 content for “foo”, builds a handle-output context, and passes the item to handle_output_item_done. It then reads session history and the saved file. The expected history contains an image instructions message followed by the original item, and the file contains the decoded bytes.

**Call relations**: The test runner invokes this test. It uses test_tool_runtime and handle_output_item_done to exercise the same output-processing path used after model responses.

*Call graph*: calls 6 internal fn (into, new, make_session_and_context, test_tool_runtime, image_generation_artifact_path, new); 6 external calls (clone, new, new, assert_eq!, remove_file, vec!).


##### `handle_output_item_done_skips_image_save_message_when_save_fails`  (lines 8021–8057)

```
async fn handle_output_item_done_skips_image_save_message_when_save_fails()
```

**Purpose**: Checks that a bad image payload does not add a misleading save-location message to history. The output item itself should still be recorded.

**Data flow**: The test creates an image-generation item with invalid encoded data and processes it through handle_output_item_done. It reads history and checks the expected file path. The history should contain only the image item, and no file should exist.

**Call relations**: The test runner calls this test. It covers the failure branch of the same image-output processing path tested by the successful save case.

*Call graph*: calls 4 internal fn (make_session_and_context, test_tool_runtime, image_generation_artifact_path, new); 7 external calls (clone, new, new, assert!, assert_eq!, remove_file, vec!).


##### `build_initial_context_uses_previous_turn_settings_for_realtime_end`  (lines 8060–8079)

```
async fn build_initial_context_uses_previous_turn_settings_for_realtime_end()
```

**Purpose**: Checks that initial context can announce a realtime session ended based on saved previous-turn settings. This helps when there is no full reference context item to compare against.

**Data flow**: The test stores previous-turn settings saying realtime was active, then builds initial context for a currently inactive turn. It scans developer text. The expected text explains that realtime is inactive.

**Call relations**: The test runner invokes this test. It uses set_previous_turn_settings and build_initial_context to verify the fallback realtime-end path.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `build_initial_context_restates_realtime_start_when_reference_context_is_missing`  (lines 8082–8102)

```
async fn build_initial_context_restates_realtime_start_when_reference_context_is_missing()
```

**Purpose**: Checks that active realtime state is restated when there is no saved reference context, even if previous-turn settings also say realtime was active. Without a baseline, the model must be told the current state.

**Data flow**: The test marks the current turn as realtime active and stores previous-turn settings with realtime active too. It builds initial context and scans developer text. The output should include the realtime-conversation marker.

**Call relations**: The test runner calls this test. It exercises build_initial_context in the missing-reference-context case.

*Call graph*: calls 2 internal fn (developer_input_texts, make_session_and_context); 1 external calls (assert!).


##### `file_system_policy_with_unreadable_glob`  (lines 8104–8119)

```
fn file_system_policy_with_unreadable_glob(turn_context: &TurnContext) -> FileSystemSandboxPolicy
```

**Purpose**: Creates a test file-system sandbox policy that denies access to .env files under the current working directory. A sandbox policy is a set of rules saying which files the agent may read or write.

**Data flow**: The function receives a turn context, converts its legacy sandbox policy into the newer split file-system policy format, and appends a deny rule for a glob pattern matching .env files. It returns the modified policy.

**Call relations**: Tests that need a file-system policy different from the legacy equivalent call this helper. They use it to verify that special policies are stored in turn context items and persisted to rollout history.

*Call graph*: calls 2 internal fn (sandbox_policy, from_legacy_sandbox_policy_for_cwd); called by 2 (record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout, turn_context_item_stores_split_file_system_sandbox_policy_when_different); 1 external calls (format!).


##### `turn_context_item_uses_turn_context_comp_hash_snapshot`  (lines 8122–8131)

```
async fn turn_context_item_uses_turn_context_comp_hash_snapshot()
```

**Purpose**: Checks that a turn context item uses the turn context’s own component hash snapshot, not a possibly different hash inside model information. This preserves the exact settings snapshot for the turn.

**Data flow**: The test sets one hash on the turn context and another on the model info. It converts the turn context into a stored context item. The stored hash should be the turn-context hash.

**Call relations**: The test runner invokes this test. It directly exercises TurnContext::to_turn_context_item.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert_eq!).


##### `turn_context_item_omits_legacy_equivalent_file_system_sandbox_policy`  (lines 8134–8144)

```
async fn turn_context_item_omits_legacy_equivalent_file_system_sandbox_policy()
```

**Purpose**: Checks that the saved turn context does not redundantly store a file-system sandbox policy when it matches the legacy permission profile. This keeps stored context smaller and avoids duplicate information.

**Data flow**: The test creates a normal turn context and converts it into a context item. It expects the separate file-system sandbox policy field to be None, while the permission profile is still present.

**Call relations**: The test runner calls this test. It validates the default output of TurnContext::to_turn_context_item.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert_eq!).


##### `turn_context_item_stores_split_file_system_sandbox_policy_when_different`  (lines 8147–8166)

```
async fn turn_context_item_stores_split_file_system_sandbox_policy_when_different()
```

**Purpose**: Checks that a custom split file-system sandbox policy is stored when it differs from the legacy-equivalent policy. This preserves important extra access rules such as denied .env files.

**Data flow**: The test creates a custom policy with file_system_policy_with_unreadable_glob and updates the turn context permission profile with it. It converts the context to an item. The item should include the custom file-system policy and the permission profile.

**Call relations**: The test runner invokes this test. It uses the policy helper and then exercises TurnContext::to_turn_context_item.

*Call graph*: calls 3 internal fn (file_system_policy_with_unreadable_glob, make_session_and_context, from_runtime_permissions_with_enforcement); 1 external calls (assert_eq!).


##### `record_context_updates_and_set_reference_context_item_injects_full_context_when_baseline_missing`  (lines 8169–8185)

```
async fn record_context_updates_and_set_reference_context_item_injects_full_context_when_baseline_missing()
```

**Purpose**: Checks that when there is no previous context baseline, the session records the full initial context into history. This ensures resumed conversations have the model instructions they need.

**Data flow**: The test calls record_context_updates_and_set_reference_context_item on a fresh session. It then compares session history with build_initial_context output and reads the saved reference context item. History should contain the full initial context, and the reference item should match the current turn context.

**Call relations**: The test runner calls this test. It exercises the session method that both writes context updates to history and updates the baseline used for future diffs.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert_eq!).


##### `record_context_updates_and_set_reference_context_item_reinjects_full_context_after_clear`  (lines 8188–8226)

```
async fn record_context_updates_and_set_reference_context_item_reinjects_full_context_after_clear()
```

**Purpose**: Checks that if the saved reference context is cleared, the session reinserts full context on the next update. This is important after history compaction or repair, when the baseline may be missing.

**Data flow**: The test records a compacted-summary message, records context once, clears the reference context, replaces history with only the summary, and records context again. It then expects history to contain the summary followed by the full initial context.

**Call relations**: The test runner invokes this test. It combines record_conversation_items, replace_history, and record_context_updates_and_set_reference_context_item to simulate a cleared baseline.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert_eq!, from_ref, vec!).


##### `record_context_updates_and_set_reference_context_item_persists_baseline_without_emitting_diffs`  (lines 8229–8285)

```
async fn record_context_updates_and_set_reference_context_item_persists_baseline_without_emitting_diffs()
```

**Purpose**: Checks that when a context change should be saved as the new baseline but not emitted as visible diff messages, the baseline is still persisted to rollout history. This protects resume behavior even when no conversation items are added.

**Data flow**: The test creates a previous context, switches to another model, stores the previous context as the reference, and attaches rollout persistence. It confirms update items are empty, records context updates, flushes the rollout, and reads saved rollout history. The persisted turn context should match the new turn context even though session history stayed empty.

**Call relations**: The test runner calls this test. It uses attach_thread_persistence and RolloutRecorder::get_rollout_history to verify the save-to-disk side of record_context_updates_and_set_reference_context_item.

*Call graph*: calls 3 internal fn (attach_thread_persistence, make_session_and_context, get_rollout_history); 2 external calls (assert_eq!, panic!).


##### `record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout`  (lines 8288–8319)

```
async fn record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout()
```

**Purpose**: Checks that a custom split file-system sandbox policy is written into rollout history. Without this, a resumed session could lose important file access restrictions.

**Data flow**: The test creates a custom deny-.env policy, installs it into the turn context permission profile, attaches rollout persistence, records context updates, and flushes the rollout. It reads the saved rollout history and extracts the stored file-system policy. The stored policy should equal the custom policy.

**Call relations**: The test runner invokes this test. It uses file_system_policy_with_unreadable_glob, attach_thread_persistence, and RolloutRecorder::get_rollout_history to check persistence.

*Call graph*: calls 5 internal fn (attach_thread_persistence, file_system_policy_with_unreadable_glob, make_session_and_context, from_runtime_permissions_with_enforcement, get_rollout_history); 2 external calls (assert_eq!, panic!).


##### `build_initial_context_prepends_model_switch_message`  (lines 8322–8343)

```
async fn build_initial_context_prepends_model_switch_message()
```

**Purpose**: Checks that initial context starts with a developer message when the model changed since the previous turn. This gives the new model an explicit note that it is taking over from another model.

**Data flow**: The test stores previous-turn settings with a different model name, builds initial context, and inspects the first response item. The first item should be a developer message containing a model-switch marker.

**Call relations**: The test runner calls this test. It uses set_previous_turn_settings and build_initial_context to verify model-switch messaging is placed at the front.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert!, assert_eq!, panic!).


##### `record_context_updates_and_set_reference_context_item_persists_full_reinjection_to_rollout`  (lines 8346–8406)

```
async fn record_context_updates_and_set_reference_context_item_persists_full_reinjection_to_rollout()
```

**Purpose**: Checks that when the session notices a changed turn context, it saves the full reinjected context into the rollout record. This matters because a resumed conversation needs the same context that was active during the original run.

**Data flow**: It creates a session and an earlier context, switches to a different model for the next context, attaches rollout persistence, and seeds the rollout with a user message. It clears the reference context, records the new context update, flushes the rollout file, then reads the file back. The expected result is that the persisted rollout contains a turn-context item matching the new turn context.

**Call relations**: The test builds its session with make_session_and_context, attaches storage with attach_thread_persistence, then exercises the session method that records context updates. It uses RolloutRecorder::get_rollout_history afterward to prove the saved file contains the same context item that the live session produced.

*Call graph*: calls 3 internal fn (attach_thread_persistence, make_session_and_context, get_rollout_history); 6 external calls (default, new, assert_eq!, panic!, UserMessage, EventMsg).


##### `run_user_shell_command_does_not_set_reference_context_item`  (lines 8409–8436)

```
async fn run_user_shell_command_does_not_set_reference_context_item()
```

**Purpose**: Verifies that a standalone user shell command does not change the conversation’s remembered previous context. This prevents one-off shell tasks from accidentally affecting the next model turn.

**Data flow**: It starts a session with an event receiver, clears the reference context, runs a user shell command, and waits until the session reports the turn is complete. After that, it reads the session’s reference context. The expected result is still no reference context.

**Call relations**: The test calls handlers::run_user_shell_command as a client-facing command handler would. It watches events from the receiver until TurnComplete, then checks the session state directly to confirm the shell path did not use the same context-update path as normal turns.

*Call graph*: calls 2 internal fn (run_user_shell_command, make_session_and_context_with_rx); 5 external calls (from_secs, assert!, matches!, now, timeout).


##### `realtime_conversation_list_voices_emits_builtin_list`  (lines 8439–8481)

```
async fn realtime_conversation_list_voices_emits_builtin_list()
```

**Purpose**: Checks that asking for realtime conversation voices returns the built-in voice list. This makes sure clients can reliably populate voice choices without needing an external lookup.

**Data flow**: It creates a session and event receiver, calls the voice-list handler, receives one event, and extracts the voice list from it. The output must exactly match the expected v1 voices, v2 voices, and defaults.

**Call relations**: The test exercises handlers::realtime_conversation_list_voices and then reads the event channel that clients would normally receive. It proves the handler sends a RealtimeConversationListVoicesResponse event with the hard-coded supported voices.

*Call graph*: calls 2 internal fn (realtime_conversation_list_voices, make_session_and_context_with_rx); 2 external calls (assert_eq!, panic!).


##### `CompletingTask::kind`  (lines 8487–8489)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Reports that this fake task is a regular session task. It is used by tests that need a task which behaves like a normal turn and completes quickly.

**Data flow**: It reads no external input and always returns TaskKind::Regular. Nothing else changes.

**Call relations**: Session task spawning code calls this method to classify the task. In these tests, CompletingTask is used when the session needs to run through normal completion behavior.


##### `CompletingTask::span_name`  (lines 8491–8493)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Gives this fake task a tracing name for diagnostics. The name helps identify the task in logs or tracing output during tests.

**Data flow**: It takes the task object and returns the fixed text "session_task.completing". It does not change state.

**Call relations**: The session task runner can ask for this name when creating a trace span, which is a labeled timing/logging section.


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

**Purpose**: Simulates a task that finishes immediately without producing a final assistant message. This lets tests check what the session does when a turn completes cleanly.

**Data flow**: It receives the session context, turn context, input, and cancellation token, but ignores them. It returns None, meaning there is no last agent message.

**Call relations**: The session task runner calls this after spawn_task. Tests use it to trigger normal task-finished cleanup without waiting for real model work.


##### `NeverEndingTask::kind`  (lines 8513–8515)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Reports which kind of fake task this is, such as regular or review. Tests use this to simulate different turn categories.

**Data flow**: It reads the task’s stored kind field and returns it. It does not alter anything.

**Call relations**: The session task runner calls this when deciding how the active turn should behave. Tests vary the stored kind to check rules for regular, review, and compact turns.


##### `NeverEndingTask::span_name`  (lines 8517–8519)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Gives the never-ending fake task a tracing name. This keeps test traces readable if task activity is inspected.

**Data flow**: It returns the fixed text "session_task.never_ending". It does not read or change session state.

**Call relations**: The session task runner may use this when labeling the task’s async execution span.


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

**Purpose**: Simulates a task that keeps a turn open until cancelled, or ignores cancellation forever depending on its setting. This is useful for testing aborts, pending input, and active-turn rejection.

**Data flow**: It receives a cancellation token. If configured to listen, it waits until cancellation and then returns None. If configured not to listen, it sleeps forever in a loop, imitating a stuck task.

**Call relations**: Many tests spawn this task to keep the session busy. Abort and steering tests then observe how session code behaves while a turn is active or when the task is cancelled.

*Call graph*: 3 external calls (cancelled, from_secs, sleep).


##### `GuardianDeniedApprovalTask::kind`  (lines 8542–8544)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Reports that this fake guardian-denial task is a regular task. It lets guardian interruption tests run through the normal turn path.

**Data flow**: It always returns TaskKind::Regular and changes nothing.

**Call relations**: The session runner calls this when the task is spawned. The regular classification means the guardian circuit-breaker behavior is tested in a normal turn.


##### `GuardianDeniedApprovalTask::span_name`  (lines 8546–8548)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Provides a trace label for the fake task that triggers guardian denials. This helps distinguish it from other test tasks.

**Data flow**: It returns the fixed text "session_task.guardian_denied_approval". It does not change state.

**Call relations**: The session runner can use this name when recording task execution in tracing.


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

**Purpose**: Simulates a turn that records three guardian denials and then waits to be cancelled. It tests the safety circuit breaker that should interrupt a turn after repeated denials.

**Data flow**: It clones the session, records three guardian denial events for the turn, then waits on the cancellation token. It returns None after cancellation.

**Call relations**: guardian_auto_review_interrupts_after_three_consecutive_denials spawns this task. The task hands off to crate::guardian::record_guardian_denial_for_test, and the session should respond by aborting the turn.

*Call graph*: 2 external calls (cancelled, record_guardian_denial_for_test).


##### `guardian_auto_review_interrupts_after_three_consecutive_denials`  (lines 8568–8599)

```
async fn guardian_auto_review_interrupts_after_three_consecutive_denials()
```

**Purpose**: Checks that three consecutive guardian denials during a normal turn interrupt that turn. This protects the system from continuing after repeated safety rejections.

**Data flow**: It starts a session, creates user input, spawns GuardianDeniedApprovalTask, and then reads events until it sees TurnAborted. The expected abort reason is Interrupted.

**Call relations**: The test relies on GuardianDeniedApprovalTask to create the denial sequence. It observes the client event stream to confirm the guardian circuit breaker reaches the session abort path.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 7 external calls (clone, new, assert_eq!, TurnAborted, from_secs, timeout, vec!).


##### `guardian_helper_review_interrupts_after_three_consecutive_denials`  (lines 8602–8661)

```
async fn guardian_helper_review_interrupts_after_three_consecutive_denials()
```

**Purpose**: Checks that guardian denials coming from a helper review thread also interrupt the active turn. This matters because reviews can happen outside the main task flow.

**Data flow**: It starts a never-ending regular turn, then starts a separate thread with its own async runtime and records three guardian denials for the same turn. It watches session events until TurnAborted appears, and expects the reason to be Interrupted.

**Call relations**: The active turn is kept alive by NeverEndingTask. The helper thread calls crate::guardian::record_guardian_denial_for_test, and the session is expected to emit the same abort event as it would for denials recorded by the task itself.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 8 external calls (clone, from_secs, new, assert_eq!, TurnAborted, spawn, timeout, vec!).


##### `abort_regular_task_emits_marker_before_turn_aborted`  (lines 8665–8703)

```
async fn abort_regular_task_emits_marker_before_turn_aborted()
```

**Purpose**: Verifies that aborting a regular stuck task sends a model-visible abort marker before the client-facing TurnAborted event. The marker is important because future model context should know the previous turn was interrupted.

**Data flow**: It starts a regular never-ending task that ignores cancellation, aborts all tasks, then reads two events. The first must be a raw response item containing the marker, and the second must be TurnAborted with the Interrupted reason. It also checks no extra events remain.

**Call relations**: The test drives sess.abort_all_tasks directly while NeverEndingTask keeps the turn active. It confirms the session’s abort flow orders history/model marker output before the final client abort notification.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 7 external calls (clone, assert!, assert_eq!, panic!, from_secs, timeout, vec!).


##### `abort_gracefully_emits_marker_before_turn_aborted`  (lines 8706–8744)

```
async fn abort_gracefully_emits_marker_before_turn_aborted()
```

**Purpose**: Checks that even a task which cooperates with cancellation still emits the abort marker before TurnAborted. This keeps abort behavior consistent for both stuck and graceful tasks.

**Data flow**: It starts a regular never-ending task that listens for cancellation, aborts all tasks, and reads the event stream. It expects a RawResponseItem marker first, then TurnAborted with reason Interrupted, and no later events.

**Call relations**: This is the graceful-cancellation counterpart to abort_regular_task_emits_marker_before_turn_aborted. It uses NeverEndingTask with cancellation listening enabled to exercise the cleaner shutdown path.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 7 external calls (clone, assert!, assert_eq!, panic!, from_secs, timeout, vec!).


##### `task_finish_emits_turn_item_lifecycle_for_leftover_pending_user_input`  (lines 8747–8866)

```
async fn task_finish_emits_turn_item_lifecycle_for_leftover_pending_user_input()
```

**Purpose**: Checks that if follow-up user input is still pending when a task finishes, the session records it and emits the full item lifecycle for clients. This prevents late user input from disappearing at turn completion.

**Data flow**: It starts a never-ending turn, clears earlier events, steers new user input into the active turn, then manually finishes the task. It checks history for the pending user message, then verifies events arrive as raw response item, item started, item completed, legacy user message, and turn complete.

**Call relations**: The test uses sess.steer_input to add pending input and sess.on_task_finished to trigger completion cleanup. It observes both stored history and outgoing events to prove the pending input is handled like a real user message.

*Call graph*: calls 2 internal fn (new, make_session_and_context_with_rx); 6 external calls (clone, default, assert!, from_secs, timeout, vec!).


##### `task_finish_emits_thread_idle_lifecycle_after_active_turn_clears`  (lines 8869–8914)

```
async fn task_finish_emits_thread_idle_lifecycle_after_active_turn_clears()
```

**Purpose**: Verifies that thread-idle extension hooks run after the active turn has been cleared. This lets extensions safely react to a truly idle thread.

**Data flow**: It defines a test extension contributor that records calls and sends a signal when idle. It installs that contributor, spawns a CompletingTask, waits for the idle signal, and then checks the hook ran once and active_turn is None.

**Call relations**: CompletingTask causes the turn to finish quickly. The session’s completion path calls the extension registry’s thread idle lifecycle, and the test contributor confirms the correct thread ID and timing.

*Call graph*: calls 1 internal fn (make_session_and_context); 10 external calls (clone, new, from_secs, new, assert!, assert_eq!, bounded, new, new, timeout).


##### `thread_idle_lifecycle_waits_for_trigger_turn_mailbox_work`  (lines 8917–8954)

```
async fn thread_idle_lifecycle_waits_for_trigger_turn_mailbox_work()
```

**Purpose**: Checks that the thread-idle hook does not run while there is mailbox work that should trigger another turn. This avoids telling extensions the thread is idle too early.

**Data flow**: It installs a test idle contributor, enqueues a mailbox communication marked as trigger_turn, calls the session’s idle-check method, and reads the call count. The expected count is zero.

**Call relations**: The test uses the input queue to simulate pending inter-agent mail. When emit_thread_idle_lifecycle_if_idle runs, it should notice that trigger-turn work exists and skip the extension hook.

*Call graph*: calls 3 internal fn (make_session_and_context, root, new); 6 external calls (clone, new, new, assert_eq!, new, new).


##### `try_start_turn_if_idle_rejects_active_turn_without_injecting`  (lines 8957–8983)

```
async fn try_start_turn_if_idle_rejects_active_turn_without_injecting()
```

**Purpose**: Ensures automatic idle-start input is rejected while a turn is already active, and that the rejected input is not secretly queued. This prevents duplicate or misplaced turns.

**Data flow**: It starts a never-ending regular turn, creates a synthetic user message, and calls try_start_turn_if_idle. The function returns a Busy rejection containing the original input, and the input queue remains empty for the active turn.

**Call relations**: NeverEndingTask keeps the session busy. The test exercises sess.try_start_turn_if_idle and then checks both the rejection object and the queue to confirm no side effect occurred.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, user_message); 4 external calls (clone, new, assert_eq!, vec!).


##### `try_start_turn_if_idle_rejects_plan_mode_without_injecting`  (lines 8986–9008)

```
async fn try_start_turn_if_idle_rejects_plan_mode_without_injecting()
```

**Purpose**: Checks that automatic idle-start input is rejected in plan mode. Plan mode is a state where the system should not silently start work from this path.

**Data flow**: It changes the session collaboration mode to Plan, then calls try_start_turn_if_idle with a synthetic user message. The rejection reason is PlanMode, the input is returned untouched, no active turn appears, and nothing is queued.

**Call relations**: The test edits session configuration directly, then exercises sess.try_start_turn_if_idle. It proves the plan-mode guard runs before any input injection.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, user_message); 3 external calls (assert!, assert_eq!, vec!).


##### `try_start_turn_if_idle_rejects_pending_trigger_turn_without_injecting`  (lines 9011–9036)

```
async fn try_start_turn_if_idle_rejects_pending_trigger_turn_without_injecting()
```

**Purpose**: Ensures automatic idle-start input is rejected when trigger-turn mailbox mail is already waiting. This protects mailbox-triggered work from being bypassed or reordered.

**Data flow**: It enqueues trigger-turn inter-agent communication, then tries to start a turn with synthetic input. The result is a PendingTriggerTurn rejection, the original input is returned, no active turn starts, and the trigger mail remains waiting.

**Call relations**: The input queue supplies the pending trigger condition. sess.try_start_turn_if_idle is expected to notice that condition and leave the queue unchanged.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, user_message, root, new); 4 external calls (new, assert!, assert_eq!, vec!).


##### `try_start_turn_if_idle_rejects_active_review_turn_without_injecting`  (lines 9039–9065)

```
async fn try_start_turn_if_idle_rejects_active_review_turn_without_injecting()
```

**Purpose**: Checks that idle-start input is rejected while a review turn is active. Review turns are special, so unrelated automatic input must not be injected into them.

**Data flow**: It starts a never-ending task marked as Review, calls try_start_turn_if_idle with synthetic input, and expects a Busy rejection. The input is returned unchanged and no pending input is added to the active turn.

**Call relations**: NeverEndingTask supplies an active review turn. The test confirms sess.try_start_turn_if_idle treats it as busy and does not use the steering or queueing path.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, user_message); 4 external calls (clone, new, assert_eq!, vec!).


##### `steer_input_requires_active_turn`  (lines 9068–9087)

```
async fn steer_input_requires_active_turn()
```

**Purpose**: Checks that steering input fails when there is no active turn. Steering only makes sense when there is already a running turn to steer.

**Data flow**: It creates a session with no active task, prepares user text, and calls steer_input. The result is a NoActiveTurn error.

**Call relations**: The test directly exercises sess.steer_input before any spawn_task call. It confirms the session rejects the operation at the first safety check.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 3 external calls (default, assert!, vec!).


##### `steer_input_enforces_expected_turn_id`  (lines 9090–9133)

```
async fn steer_input_enforces_expected_turn_id()
```

**Purpose**: Verifies that steering input can require a specific active turn ID, and fails if the active turn is different. This prevents a client’s follow-up text from going into the wrong turn.

**Data flow**: It starts a regular never-ending turn, then calls steer_input with an expected turn ID that does not match. The returned error contains both the expected ID and the actual active turn ID.

**Call relations**: NeverEndingTask creates the active turn. sess.steer_input compares the caller’s expected ID to the active turn context and returns ExpectedTurnMismatch instead of queueing the input.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 5 external calls (clone, default, assert_eq!, panic!, vec!).


##### `steer_input_rejects_non_regular_turns`  (lines 9136–9179)

```
async fn steer_input_rejects_non_regular_turns()
```

**Purpose**: Checks that steering is rejected for review and compact turns. Those turn types have special meaning, so ordinary user follow-up input should not be mixed into them.

**Data flow**: For each non-regular task kind, it starts a turn, tries to steer user text, and expects ActiveTurnNotSteerable with the matching turn kind. It then aborts the task to clean up.

**Call relations**: The test creates review and compact active turns using NeverEndingTask. It exercises sess.steer_input and confirms the turn-kind guard blocks both cases.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 3 external calls (default, assert_eq!, vec!).


##### `steer_input_returns_active_turn_id`  (lines 9182–9218)

```
async fn steer_input_returns_active_turn_id()
```

**Purpose**: Verifies that successful steering returns the ID of the turn that received the input. This gives callers confirmation that their follow-up went to the intended running turn.

**Data flow**: It starts a regular never-ending turn, steers user text with the matching expected turn ID, and receives a turn ID back. It checks the returned ID matches and that the input queue now has pending input.

**Call relations**: The active regular turn comes from NeverEndingTask. sess.steer_input accepts the input, appends it to the active turn’s pending queue, and returns the active turn’s sub_id.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 5 external calls (clone, default, assert!, assert_eq!, vec!).


##### `abort_empty_active_turn_preserves_pending_input`  (lines 9221–9253)

```
async fn abort_empty_active_turn_preserves_pending_input()
```

**Purpose**: Checks that aborting an empty active turn does not discard pending input attached to that turn state. This protects input that should be available after cleanup.

**Data flow**: It manually creates an active turn state, adds a pending response item to that state, aborts all tasks with Replaced, and then confirms the active turn is cleared. It then takes pending input for the saved turn state and expects to get the original item back.

**Call relations**: This test touches the input queue and active_turn state directly to cover a narrow cleanup case. sess.abort_all_tasks clears the active turn but must not erase the turn-state-specific pending input.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 4 external calls (clone, assert!, assert_eq!, vec!).


##### `set_total_token_usage`  (lines 9255–9262)

```
async fn set_total_token_usage(sess: &Session, total_token_usage: TokenUsage)
```

**Purpose**: Sets test token-usage information on a session. It is a helper for tests that need the session to begin with a known token count.

**Data flow**: It locks the session state and stores TokenUsageInfo with the supplied total usage, default last usage, and no model context window. It returns nothing but changes session state.

**Call relations**: turn_start_lifecycle_exposes_turn_metadata_and_token_baseline calls this helper before checking lifecycle metadata. It prepares the session state so that later lifecycle code can read a known baseline.

*Call graph*: called by 1 (turn_start_lifecycle_exposes_turn_metadata_and_token_baseline); 1 external calls (default).


##### `queue_only_mailbox_mail_waits_for_next_turn_after_answer_boundary`  (lines 9265–9306)

```
async fn queue_only_mailbox_mail_waits_for_next_turn_after_answer_boundary()
```

**Purpose**: Checks that non-trigger mailbox mail arriving after the current turn’s answer boundary waits for the next turn. This prevents late child-agent updates from being folded into a turn that has already effectively answered.

**Data flow**: It starts a regular turn, marks mailbox delivery as deferred to the next turn, then enqueues queue-only inter-agent communication. During the active turn, pending input is empty. After aborting/replacing the turn, the queued communication appears as pending input for the next turn.

**Call relations**: The test uses input_queue.defer_mailbox_delivery_to_next_turn to simulate the answer boundary. It verifies enqueue_mailbox_communication respects that boundary until abort_all_tasks clears the current turn.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, root, try_from, new); 4 external calls (clone, new, assert!, assert_eq!).


##### `trigger_turn_mailbox_mail_waits_for_next_turn_after_answer_boundary`  (lines 9309–9342)

```
async fn trigger_turn_mailbox_mail_waits_for_next_turn_after_answer_boundary()
```

**Purpose**: Checks that trigger-turn mailbox mail also waits after the current turn’s answer boundary. It should remain available to start a later turn, not extend the current one.

**Data flow**: It starts a regular active turn, defers mailbox delivery to the next turn, then enqueues trigger-turn communication. The active turn has no pending input. After the turn is replaced, the input queue still reports trigger-turn mailbox items waiting.

**Call relations**: Like the queue-only mailbox test, this uses NeverEndingTask and the input queue’s defer mechanism. The difference is that the mailbox item is marked trigger_turn, so the test checks the trigger mailbox state after abort.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, root, try_from, new); 3 external calls (clone, new, assert!).


##### `steered_input_reopens_mailbox_delivery_for_current_turn`  (lines 9345–9396)

```
async fn steered_input_reopens_mailbox_delivery_for_current_turn()
```

**Purpose**: Verifies that when the user steers an active turn after the answer boundary, queued mailbox delivery can reopen for that current turn. This lets a follow-up bring in related child-agent updates.

**Data flow**: It starts a turn, defers mailbox delivery, enqueues a queued child update, then steers new user input into the same turn. The pending input for the active turn becomes the steered user input followed by the mailbox communication.

**Call relations**: sess.steer_input is the key action that reopens delivery. The test checks input_queue.get_pending_input to prove the previously buffered mailbox item is now attached to the active turn.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, root, try_from, new); 5 external calls (clone, default, new, assert_eq!, vec!).


##### `stale_defer_mailbox_delivery_does_not_override_steered_input`  (lines 9399–9454)

```
async fn stale_defer_mailbox_delivery_does_not_override_steered_input()
```

**Purpose**: Checks that an old or repeated defer call does not undo mailbox delivery after steering has reopened it. This prevents stale bookkeeping from hiding input that is already pending.

**Data flow**: It starts a turn, defers mailbox delivery, enqueues communication, steers user input so delivery reopens, then calls defer again for the same turn. The pending input remains the user input plus the mailbox communication.

**Call relations**: The test combines input_queue.defer_mailbox_delivery_to_next_turn and sess.steer_input in a race-like order. It confirms the queue treats the later stale defer as harmless once current-turn delivery has reopened.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, root, try_from, new); 5 external calls (clone, default, new, assert_eq!, vec!).


##### `tool_calls_reopen_mailbox_delivery_for_current_turn`  (lines 9457–9509)

```
async fn tool_calls_reopen_mailbox_delivery_for_current_turn()
```

**Purpose**: Checks that a tool call can also reopen mailbox delivery for the current turn. This matters because tool activity can mean the turn is still active and should receive queued child-agent updates.

**Data flow**: It starts a turn, defers mailbox delivery, enqueues communication, then simulates a function-call response item for a test tool. handle_output_item_done processes the tool call and reports that follow-up is needed. The queued mailbox communication becomes pending input for the active turn.

**Call relations**: The test builds a HandleOutputCtx with a test tool runtime and calls handle_output_item_done, the normal output-processing path for model tool calls. It then checks the input queue to confirm tool handling reopened delivery.

*Call graph*: calls 6 internal fn (make_session_and_context_with_rx, test_tool_runtime, new, root, try_from, new); 6 external calls (clone, new, new, new, assert!, assert_eq!).


##### `abort_review_task_emits_exited_then_aborted_and_records_history`  (lines 9512–9586)

```
async fn abort_review_task_emits_exited_then_aborted_and_records_history()
```

**Purpose**: Verifies that aborting a review task exits review mode before reporting the turn as aborted, and still records a turn-aborted marker in history. This preserves both correct client state and model memory.

**Data flow**: It starts a ReviewTask, aborts all tasks, then reads events until it sees ExitedReviewMode and TurnAborted. It checks that ExitedReviewMode came first and that the abort reason is Interrupted. Finally it scans history for a user message containing the turn-aborted marker.

**Call relations**: The test uses ReviewTask::new to enter review-mode behavior, then drives sess.abort_all_tasks. It observes client events and session history to prove both the review lifecycle and abort-history paths ran.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, new); 7 external calls (clone, assert!, assert_eq!, from_secs, now, timeout, vec!).


##### `fatal_tool_error_stops_turn_and_reports_error`  (lines 9589–9646)

```
async fn fatal_tool_error_stops_turn_and_reports_error()
```

**Purpose**: Checks that an incompatible shell tool payload becomes a fatal tool error. A fatal error means the turn should stop rather than pretending the tool returned normal output.

**Data flow**: It loads available tools, builds a ToolRouter, creates a custom tool call named shell_command with the wrong payload shape, builds a tool call, and dispatches it. The result must be FunctionCallError::Fatal with the expected message.

**Call relations**: The test exercises ToolRouter::build_tool_call and dispatch_tool_call_with_code_mode_result. It confirms the router and tool dispatch layer reject incompatible tool input in the fatal-error path.

*Call graph*: calls 4 internal fn (make_session_and_context_with_rx, build_tool_call, from_turn_context, new); 8 external calls (clone, new, new, default, new, assert_eq!, panic!, new).


##### `sample_rollout`  (lines 9648–9815)

```
async fn sample_rollout(
    session: &Session,
    _turn_context: &TurnContext,
) -> (Vec<RolloutItem>, Vec<ResponseItem>)
```

**Purpose**: Builds a sample rollout and the matching live conversation history for reconstruction tests. It gives those tests a realistic sequence with initial context, user and assistant messages, and compaction summaries.

**Data flow**: It creates initial context from a new default turn, adds personality instructions if needed, records those items into rollout_items and live_history, then adds several user/assistant exchanges. Twice it compacts the history by replacing older content with a summary. It returns both the rollout items and the final prompt-ready history.

**Call relations**: Several rollout reconstruction tests call this helper to get a known transcript. It uses the same session context-building and compaction code as production paths, so reconstruction tests compare against a realistic expected history rather than a hand-written shortcut.

*Call graph*: calls 4 internal fn (into, build_compacted_history, new, new); called by 5 (reconstruct_history_matches_live_compactions, record_initial_history_reconstructs_forked_transcript, record_initial_history_reconstructs_resumed_transcript, record_initial_history_seeds_token_info_from_rollout, resumed_history_injects_initial_context_on_first_context_update_only); 7 external calls (new, build_initial_context, new_default_turn, Compacted, ResponseItem, once, vec!).


##### `rejects_escalated_permissions_when_policy_not_on_request`  (lines 9818–9912)

```
async fn rejects_escalated_permissions_when_policy_not_on_request()
```

**Purpose**: Checks that the classic shell command tool rejects requests for escalated permissions unless the approval policy is OnRequest. This is a security rule: the model should not ask for extra power when the configured policy does not allow that request flow.

**Data flow**: It creates a session, changes the approval policy to OnFailure, and invokes shell_command with sandbox_permissions set to RequireEscalated. The tool returns an error message for the model, no turn permissions are granted, and a later non-escalated approval check for the same command still skips approval as expected.

**Call relations**: The test calls ShellCommandHandler::handle with a ToolInvocation, then consults the session’s granted permissions and exec policy. It proves the rejection is specific to escalated-permission requests and does not poison ordinary command handling.

*Call graph*: calls 4 internal fn (make_session_and_context, from, new, plain); 10 external calls (clone, get_mut, new, new, assert!, format!, panic!, assert_eq!, json!, new).


##### `shell_tool_cancellation_waits_for_runtime_cleanup`  (lines 9916–9982)

```
async fn shell_tool_cancellation_waits_for_runtime_cleanup() -> anyhow::Result<()>
```

**Purpose**: Verifies that cancelling a shell tool waits for the shell process to run its cleanup trap before the tool task finishes. This prevents leaked or half-cleaned command processes.

**Data flow**: It creates a session with unrestricted sandbox policy, writes a shell command that creates a ready file, waits forever, and on TERM writes a cleanup file. It starts the tool call, waits for the ready file, cancels the token, waits for the tool task to finish, and then reads the cleanup file. The expected contents are "cleaned".

**Call relations**: The test uses test_tool_runtime to run the same shell-tool path as normal tool dispatch. The cancellation token triggers shutdown, and the timeout around the task proves the runtime waits for process cleanup but still returns promptly.

*Call graph*: calls 3 internal fn (make_session_with_config, test_tool_runtime, build_tool_call); 13 external calls (clone, new, new, from_millis, from_secs, bail!, assert_eq!, format!, json!, new (+3 more)).


##### `unified_exec_rejects_escalated_permissions_when_policy_not_on_request`  (lines 9985–10030)

```
async fn unified_exec_rejects_escalated_permissions_when_policy_not_on_request()
```

**Purpose**: Checks the same escalated-permission security rule for the unified exec_command tool. It ensures both command-running backends enforce the approval policy consistently.

**Data flow**: It creates a session, sets approval policy to OnFailure, and invokes exec_command with RequireEscalated sandbox permissions and a justification. The handler returns FunctionCallError::RespondToModel with the expected rejection text.

**Call relations**: This test mirrors rejects_escalated_permissions_when_policy_not_on_request but goes through ExecCommandHandler instead of ShellCommandHandler. It confirms the newer unified execution path has the same guard.

*Call graph*: calls 4 internal fn (make_session_and_context, default, new, plain); 8 external calls (clone, new, new, format!, panic!, assert_eq!, json!, new).


##### `session_start_hooks_only_load_from_trusted_project_layers`  (lines 10033–10077)

```
async fn session_start_hooks_only_load_from_trusted_project_layers() -> std::io::Result<()>
```

**Purpose**: Checks that session-start hooks are discovered only from trusted project configuration layers. Hooks are scripts or actions loaded from project files, so trust boundaries matter for safety.

**Data flow**: It creates a temporary home and nested project, writes hook files at the project root and nested level, marks only the nested directory as trusted, and builds config from the nested working directory. It lists hooks and expects only the nested hook source to appear, marked untrusted, and previewing session-start hooks returns nothing.

**Call relations**: The test sets up files with write_project_hooks and trust data with write_project_trust_config, then calls codex_hooks::list_hooks and preview_session_start_hooks. It checks that config-layer trust controls hook discovery.

*Call graph*: calls 3 internal fn (write_project_hooks, write_project_trust_config, from_absolute_path); 8 external calls (assert!, assert_eq!, list_hooks, default, default, create_dir_all, write, tempdir).


##### `session_start_hooks_require_project_trust_without_config_toml`  (lines 10080–10134)

```
async fn session_start_hooks_require_project_trust_without_config_toml() -> std::io::Result<()>
```

**Purpose**: Verifies that project hooks are loaded only when the project itself is trusted, even if there is no config.toml file. This prevents untrusted project directories from activating hooks just because hook files exist.

**Data flow**: It creates a temporary project with hooks and runs three cases: no trust entry, explicitly untrusted, and trusted. For each case it builds config and lists hooks. The expected hook count is zero for unknown and untrusted projects, and one for the trusted project; previewing session-start hooks still returns empty.

**Call relations**: The test repeatedly writes different trust configs and rebuilds ConfigBuilder output. It uses codex_hooks::list_hooks to confirm trust decisions, and preview_session_start_hooks to ensure no hook preview runs unexpectedly in these setups.

*Call graph*: calls 2 internal fn (write_project_hooks, write_project_trust_config); 11 external calls (new, assert!, assert_eq!, list_hooks, default, format!, default, create_dir_all, write, tempdir (+1 more)).


### `core/src/session/tests/guardian_tests.rs`

`test` · `test run`

This is a test file. It does not implement Guardian itself; instead, it acts like a careful inspector that sets up fake sessions, fake model responses, and sample permission requests to prove the real session code behaves correctly. Guardian is an automatic reviewer that can approve or reject risky actions, such as giving a command network access. The tests use a mock server, which is a pretend model service, so they can verify exactly what the system sends to Guardian and what happens after Guardian replies.

The file covers several important safety paths. It checks that permission requests go to Guardian when auto-review is enabled, and that the session records approved permissions only for the current turn. It checks cancellation, so a hanging Guardian review does not leave permissions behind. It also verifies command tools: shell commands can proceed when Guardian approves extra permissions, while malformed permission requests still fail validation. Another test makes sure compacted conversation history keeps Guardian’s own developer instructions separate, so its safety prompt is not lost or mixed with stale text.

Finally, it checks isolation. A Guardian subagent should not inherit the parent session’s command-blocking policy rules. That matters because Guardian needs to review requests independently, not be accidentally constrained by rules meant for the main agent.

#### Function details

##### `expect_text_output`  (lines 51–68)

```
fn expect_text_output(output: &T) -> String
```

**Purpose**: This helper pulls plain text out of a tool result so tests can easily check what a command printed. It is used when a test expects a tool call to return normal output rather than an error.

**Data flow**: It receives any value that can be turned into a tool output. It converts that output into the same response item format the model would see, looks for a function-call output body, and returns the body as text. If the response is not a function-style output, it stops the test with a panic because the test setup expected a different kind of result.

**Call relations**: The shell-command tests call this after running a command handler. It sits between the low-level tool response format and the human-readable assertion, letting those tests simply ask whether the output contains text like “hi”.

*Call graph*: called by 3 (guardian_allows_shell_command_additional_permissions_requests_past_policy_validation, shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature, strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip); 2 external calls (to_response_item, panic!).


##### `request_permissions_routes_to_guardian_when_reviewer_is_enabled`  (lines 71–167)

```
async fn request_permissions_routes_to_guardian_when_reviewer_is_enabled()
```

**Purpose**: This test proves that a permission request is sent to Guardian when Guardian approval is enabled and the configuration says to use automatic review. It also proves that an approved request becomes a turn-scoped permission grant.

**Data flow**: The test starts a mock model server that will answer Guardian with an “allow” decision. It builds a session and turn context, turns on the approval policy and Guardian feature, asks for network permission, and waits for the permission request to finish. The result should be a permission response for the current turn, and the session should remember that network permission was granted for the local environment. The test also inspects the mock server request to confirm Guardian saw the permission request and its reason.

**Call relations**: The async test harness runs this test directly. Inside the test, the session’s permission-request path calls out to the configured model provider, which is pointed at the mock server. The mock server’s Guardian response flows back into the session, and the test then checks both the returned answer and the stored permission state.

*Call graph*: calls 5 internal fn (default, models_manager_with_provider, mount_sse_once, sse, start_mock_server); 11 external calls (clone, new, new, from_secs, default, assert!, assert_eq!, create_model_provider, format!, timeout (+1 more)).


##### `request_permissions_guardian_review_stops_when_cancelled`  (lines 170–270)

```
async fn request_permissions_guardian_review_stops_when_cancelled()
```

**Purpose**: This test checks that a Guardian review can be cancelled safely. If the review is still waiting, cancelling should stop the permission request and avoid recording any grant.

**Data flow**: The test starts a mock server that begins a Guardian response but delays finishing it. It creates a session with Guardian approval enabled, starts a network permission request in a background task, and waits until a Guardian assessment event shows the review has begun. Then it cancels the cancellation token. The request should return no approval, and the session should have no saved turn permission.

**Call relations**: The test harness runs this as an async test. The spawned permission request enters the same session path used by real permission requests, while the test watches the session’s event channel to know when Guardian review has started. The cancellation token is then handed into that path as the signal to stop waiting.

*Call graph*: calls 6 internal fn (default, models_manager_with_provider, mount_response_once, sse, sse_response, start_mock_server); 13 external calls (clone, get_mut, new, new, from_secs, default, assert_eq!, create_model_provider, format!, matches! (+3 more)).


##### `guardian_allows_shell_command_additional_permissions_requests_past_policy_validation`  (lines 273–363)

```
async fn guardian_allows_shell_command_additional_permissions_requests_past_policy_validation()
```

**Purpose**: This test proves that a shell command asking for extra permissions can pass policy validation when Guardian approves it. In everyday terms, it checks that a command is not blocked just because it needs a carefully reviewed temporary permission.

**Data flow**: The test prepares a mock Guardian response that allows the request, enables Guardian approval and execution permission approvals, and sets the turn’s normal permission profile to disabled. It then invokes the shell command tool with `echo hi`, asks for extra network permission, and includes a justification. If everything works, the command runs and its output contains “hi”.

**Call relations**: The test calls the shell command handler directly, using a tool invocation like the model would produce. The handler’s internal permission path consults Guardian through the mock model server. After the handler returns, the test uses `expect_text_output` to read the command output in a simple form.

*Call graph*: calls 8 internal fn (expect_text_output, models_manager_with_provider, from, new, mount_sse_once, sse, start_mock_server, plain); 11 external calls (clone, new, new, assert!, cfg!, codex_linux_sandbox_exe_or_skip!, create_model_provider, format!, json!, new (+1 more)).


##### `strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip`  (lines 366–461)

```
async fn strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip()
```

**Purpose**: This test checks a stricter safety rule: even if a previous turn-scoped permission grant might let a command skip normal policy checks, a grant marked for strict auto-review still forces Guardian to review the command. This prevents a broad shortcut from bypassing the safety reviewer.

**Data flow**: The test records a turn permission grant for network access and marks it as requiring strict auto-review. It then configures the session so the normal approval reviewer is the user, not Guardian, and runs a simple `echo hi` shell command. The command should still run successfully, but the mock Guardian server should receive a request containing the command text.

**Call relations**: The test seeds session state before invoking the shell command handler. When the handler decides whether the command can run, the strict grant causes the flow to contact Guardian. The test then reads the command output with `expect_text_output` and inspects the mock server log to confirm Guardian was part of the path.

*Call graph*: calls 9 internal fn (expect_text_output, default, models_manager_with_provider, from, new, mount_sse_once, sse, start_mock_server, plain); 10 external calls (clone, new, new, default, assert!, create_model_provider, format!, json!, new, vec!).


##### `guardian_allows_unified_exec_additional_permissions_requests_past_policy_validation`  (lines 464–511)

```
async fn guardian_allows_unified_exec_additional_permissions_requests_past_policy_validation()
```

**Purpose**: This test checks validation for the newer unified exec command path when a command says it wants additional permissions but does not say which ones. Despite the name, the expected result here is a validation error because the request is incomplete.

**Data flow**: The test enables Guardian approval and execution permission approvals, then invokes the exec command tool with a request for `with_additional_permissions` but without the required `additional_permissions` details. The handler should not run the command. Instead, it should return a message telling the model to provide at least network or file-system permissions.

**Call relations**: The async test harness runs this test, and the test calls the exec command handler directly. The flow stops at validation before Guardian or command execution can matter, and the test checks that the error text is exactly the helpful message expected by the model-facing tool path.

*Call graph*: calls 3 internal fn (default, new, plain); 7 external calls (clone, new, new, assert_eq!, panic!, json!, new).


##### `process_compacted_history_preserves_separate_guardian_developer_message`  (lines 514–571)

```
async fn process_compacted_history_preserves_separate_guardian_developer_message()
```

**Purpose**: This test makes sure that when conversation history is compacted, Guardian’s own developer instruction message is preserved separately and stale developer text is removed. This matters because Guardian’s safety instructions must remain clear and current.

**Data flow**: The test marks the session as a Guardian subagent and gives the turn context Guardian’s policy prompt as developer instructions. It then feeds compacted history containing an old developer message and a user summary into the history-compaction function. The refreshed history should not contain the stale developer message, should contain multiple developer messages, and should end with the current Guardian policy.

**Call relations**: The test calls `process_compacted_history`, which rebuilds the model-facing history after compaction. The Guardian session source and developer instructions are the important inputs, and the returned list of response items is inspected to confirm the Guardian prompt survived in the correct role.

*Call graph*: calls 1 internal fn (process_compacted_history); 6 external calls (SubAgent, assert!, assert_eq!, guardian_policy_prompt, Other, vec!).


##### `shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature`  (lines 579–643)

```
async fn shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature()
```

**Purpose**: This Unix-only test checks that a permission already granted for the current turn can still let a shell command run, even when inline additional-permission requests are not enabled. A “sticky” turn permission is like a temporary pass that should keep working for the rest of that turn.

**Data flow**: The test enables the request-permissions tool, creates an active turn, and directly records a network permission grant in that turn’s state. It then runs `echo hi` through the shell command handler without asking for new inline permissions. If the command succeeds, the output should contain “hi”; if it returns a model-facing validation error, that error must not claim that additional permissions are disabled.

**Call relations**: The test prepares the active turn state before calling the shell command handler. The handler reads the existing turn permission while deciding whether the command may run. If the handler returns normal output, the test uses `expect_text_output`; otherwise, it verifies that the error is not the specific validation failure this scenario is meant to avoid.

*Call graph*: calls 5 internal fn (expect_text_output, default, from, new, plain); 8 external calls (clone, new, new, default, assert!, panic!, json!, new).


##### `guardian_subagent_does_not_inherit_parent_exec_policy_rules`  (lines 646–759)

```
async fn guardian_subagent_does_not_inherit_parent_exec_policy_rules()
```

**Purpose**: This test proves that a Guardian subagent does not inherit command policy rules from its parent session. That isolation is important because Guardian should review safety questions independently, not be blocked by parent rules meant for ordinary command execution.

**Data flow**: The test creates a temporary project with an execution policy rule that forbids commands starting with `rm`. It loads that policy and first confirms the parent policy would forbid `rm`. Then it spawns a Codex session whose source is the Guardian reviewer subagent and passes the parent policy as inherited policy. In the spawned Guardian session, checking the same `rm` command should be allowed by default heuristics rather than forbidden by the parent rule.

**Call relations**: The test builds a realistic Codex spawn setup with authentication, model, plugin, skill, environment, and thread-store services. It calls the policy loader to create the parent policy, then calls the Codex spawn path for a Guardian subagent. The final assertion checks the child session’s execution policy to confirm the spawn logic deliberately avoided inheriting the parent’s blocking rule.

*Call graph*: calls 13 internal fn (new, new, new, load, new, spawn, models_manager_with_provider, default_for_tests, from_auth_for_testing, from_api_key (+3 more)); 16 external calls (clone, new, default, new, default, SubAgent, assert_eq!, empty_extension_registry, default, default (+6 more)).


### `core/src/session/turn_tests.rs`

`test` · `test run`

This is a focused test file for the session system’s “plan mode,” where the assistant is producing a plan rather than directly acting. The important question it answers is: if an extension changes the assistant’s turn item, does the session use the changed version or the original text? Without this behavior, extensions could appear to run but their changes would be ignored, which would make plan-mode customization unreliable.

The file creates a tiny fake extension contributor called `RewriteAgentMessageContributor`. A contributor is a plug-in hook: it is given a turn item and may alter it before the rest of the session uses it. This contributor looks for an assistant message and replaces its text with a known phrase.

The helper `assistant_output_text` builds a simple assistant response item containing some original text. The test then creates a session and turn context, installs the fake contributor into the session’s extension registry, and feeds the original assistant message into the plan-mode completion path. Finally, it checks that the remembered last agent message is the contributed text, not the original text. In everyday terms, it is like checking that an editor’s correction is what gets filed, rather than the draft before editing.

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

**Purpose**: This is a test-only plug-in hook that rewrites an assistant message. It exists so the test can prove that contributed, modified turn items are the ones used later by plan mode.

**Data flow**: It receives shared extension data for the thread and turn, plus a mutable turn item. It ignores the extension data, checks whether the item is an agent message, and if so replaces its content with the text `plan contributed assistant text`. It returns a successful asynchronous result and changes the item in place.

**Call relations**: The test installs `RewriteAgentMessageContributor` into the session’s extension registry. When the plan-mode assistant item is processed, the extension system calls this contributor, and its rewritten message becomes the value the test expects to see as the last agent message.

*Call graph*: 2 external calls (pin, vec!).


##### `assistant_output_text`  (lines 28–38)

```
fn assistant_output_text(text: &str) -> ResponseItem
```

**Purpose**: This helper builds a small fake assistant response containing the text the test wants to start with. It keeps the test readable by hiding the response-item construction details.

**Data flow**: It takes a plain text string, copies it into an assistant `ResponseItem::Message`, and fills in the minimal fields needed for the test, such as an id, role, and output-text content. It returns that response item to the caller.

**Call relations**: `plan_mode_uses_contributed_turn_item_for_last_agent_message` calls this helper to create the original assistant message. That original message is then sent through the plan-mode path, where the contributor is expected to replace its text.

*Call graph*: called by 1 (plan_mode_uses_contributed_turn_item_for_last_agent_message); 1 external calls (vec!).


##### `plan_mode_uses_contributed_turn_item_for_last_agent_message`  (lines 41–67)

```
async fn plan_mode_uses_contributed_turn_item_for_last_agent_message()
```

**Purpose**: This test proves that plan mode records the extension-modified assistant message as the last agent message. It guards against a bug where the system might accidentally keep the original assistant text instead of the contributed version.

**Data flow**: It starts by creating a test session and turn context. It then builds an extension registry containing the rewrite contributor and attaches it to the session. Next it creates turn-local extension data, plan-mode stream state, an empty `last_agent_message`, and an assistant response whose text says `original assistant text`. After running the plan-mode assistant-item completion path, it checks two outcomes: the item was handled, and `last_agent_message` now contains `plan contributed assistant text`.

**Call relations**: This is the top-level test case. It uses the session test helper to get a working session setup, uses `assistant_output_text` to make the input message, installs `RewriteAgentMessageContributor`, and then exercises the plan-mode processing path. The final assertions confirm that all those pieces worked together in the intended order.

*Call graph*: calls 5 internal fn (make_session_and_context, new, assistant_output_text, new, new); 3 external calls (new, assert!, assert_eq!).


### `core/src/session/rollout_reconstruction_tests.rs`

`test` · `test run`

A session can be saved as a rollout: a timeline of recorded items such as user messages, assistant replies, turn-start and turn-complete events, context settings, rollbacks, and compaction records. When the program resumes that session, it must rebuild the conversation exactly enough to continue safely. If this goes wrong, the assistant might remember messages that were rolled back, forget the last valid settings, or use the wrong context after compaction.

This test file builds small fake rollouts and checks the reconstruction rules. It uses helper functions to create simple user and assistant messages, then feeds crafted histories into session methods such as `record_initial_history` and `reconstruct_history_from_rollout`. The tests check both the visible chat history and hidden bookkeeping, especially `previous_turn_settings` and `reference_context_item`, which act like labels on the last trustworthy turn.

Several tests cover rollbacks, making sure only real user-driven turns are counted, while standalone internal turns are ignored unless they represent inter-agent instructions. Other tests cover compaction, which is like replacing a pile of old notes with a summary; after that, some older context must no longer be trusted unless a later turn context re-establishes it. The file is important because session resume is a recovery path, and recovery paths often fail in edge cases.

#### Function details

##### `user_message`  (lines 15–25)

```
fn user_message(text: &str) -> ResponseItem
```

**Purpose**: Creates a simple saved conversation item that looks like a user typing plain text. Tests use it so they can compare reconstructed history against clear expected messages.

**Data flow**: It receives a text string, wraps that text as input content from the user, and returns a `ResponseItem` message. It does not change any shared state.

**Call relations**: Rollback reconstruction tests call this helper when they need both rollout input and expected output to use the exact same message shape. It keeps those tests focused on reconstruction behavior rather than message construction details.

*Call graph*: called by 3 (reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_completed_turns, reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_incomplete_turn, reconstruct_history_rollback_skips_non_user_turns_for_history_and_metadata); 1 external calls (vec!).


##### `assistant_message`  (lines 27–37)

```
fn assistant_message(text: &str) -> ResponseItem
```

**Purpose**: Creates a simple saved conversation item that looks like the assistant replying with plain text. Tests use it as the expected assistant side of rebuilt history.

**Data flow**: It receives a text string, wraps that text as output content from the assistant, and returns a `ResponseItem` message. Nothing outside the returned value is changed.

**Call relations**: Several rollback tests call this helper to build assistant replies before handing rollout items to the session reconstruction code. The helper makes those tests compare meaningful history entries rather than hand-built structures.

*Call graph*: called by 4 (reconstruct_history_rollback_counts_inter_agent_assistant_turns, reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_completed_turns, reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_incomplete_turn, reconstruct_history_rollback_skips_non_user_turns_for_history_and_metadata); 1 external calls (vec!).


##### `inter_agent_assistant_message`  (lines 39–56)

```
fn inter_agent_assistant_message(text: &str) -> ResponseItem
```

**Purpose**: Creates an assistant message whose text is actually a serialized inter-agent communication. This tests the special case where one agent instructs or talks to another agent through the normal message stream.

**Data flow**: It receives human-readable text, builds an `InterAgentCommunication` from the root agent to a worker agent, turns that communication into JSON text, and returns it as an assistant `ResponseItem`. The result looks like an assistant message but carries structured agent-to-agent data.

**Call relations**: `reconstruct_history_rollback_counts_inter_agent_assistant_turns` uses this helper to prove that assistant-originated inter-agent turns are counted correctly during rollback. The helper relies on the protocol types that know how to describe agent paths and communication payloads.

*Call graph*: calls 2 internal fn (root, new); called by 1 (reconstruct_history_rollback_counts_inter_agent_assistant_turns); 2 external calls (new, vec!).


##### `record_initial_history_reconstructs_typed_inter_agent_message`  (lines 59–81)

```
async fn record_initial_history_reconstructs_typed_inter_agent_message()
```

**Purpose**: Checks that resuming a session with a typed inter-agent communication restores it as the model input item the session expects. This protects the path where agent-to-agent messages are stored as structured rollout items.

**Data flow**: The test creates a session, builds an inter-agent communication, wraps it in resumed initial history, and records that history into the session. It then reads the session history and expects to see the communication converted into the model-facing input form.

**Call relations**: The async test runner invokes this test. It uses `make_session_and_context` to get a fresh session, then exercises `record_initial_history`, which is the real resume entry point being verified.

*Call graph*: calls 4 internal fn (make_session_and_context, root, new, default); 5 external calls (from, new, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_bare_turn_context_does_not_hydrate_previous_turn_settings`  (lines 84–121)

```
async fn record_initial_history_resumed_bare_turn_context_does_not_hydrate_previous_turn_settings()
```

**Purpose**: Checks that a lone saved turn context is not enough to restore previous turn settings. A context item only becomes trustworthy when it appears inside a real turn lifecycle.

**Data flow**: The test creates a resumed history containing only a `TurnContextItem` with an older model name. After recording it into the session, it reads `previous_turn_settings` and `reference_context_item` and expects both to be empty.

**Call relations**: The test runner calls this case to guard `record_initial_history`. It sets up a session through `make_session_and_context`, then verifies that resume logic does not treat loose metadata as a completed prior turn.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_hydrates_previous_turn_settings_from_lifecycle_turn_with_missing_turn_context_id`  (lines 124–203)

```
async fn record_initial_history_resumed_hydrates_previous_turn_settings_from_lifecycle_turn_with_missing_turn_context_id()
```

**Purpose**: Checks that previous turn settings can still be restored when the turn context itself is missing its turn id, as long as the surrounding turn events identify the turn. This supports older or imperfect logs.

**Data flow**: The test builds a rollout with turn-start, user-message, turn-context, and turn-complete records. The context has no `turn_id`, but the lifecycle events provide one. After resume, the session should remember the previous model, compatibility hash, and realtime setting.

**Call relations**: The test runner invokes it as a resume compatibility case. It uses `record_initial_history` to prove that reconstruction can connect a context item to its active turn even when the context item is incomplete.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert_eq!, Resumed, vec!).


##### `reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_completed_turns`  (lines 206–315)

```
async fn reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_completed_turns()
```

**Purpose**: Checks that rolling back a completed later turn removes both its messages and its saved settings. The remaining history and metadata should both point to the same earlier turn.

**Data flow**: The test creates two completed turns, then adds a rollback that removes one turn. Reconstruction should output only the first turn’s user and assistant messages, and its previous-turn metadata should match the first turn’s context.

**Call relations**: This test calls `user_message` and `assistant_message` to build expected chat items, then calls `reconstruct_history_from_rollout` on the session. It verifies that rollback is not just deleting messages, but also rewinding the hidden context markers.

*Call graph*: calls 3 internal fn (assistant_message, user_message, make_session_and_context); 2 external calls (assert_eq!, vec!).


##### `reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_incomplete_turn`  (lines 318–409)

```
async fn reconstruct_history_rollback_keeps_history_and_metadata_in_sync_for_incomplete_turn()
```

**Purpose**: Checks that rollback also works when the later turn was never completed. An unfinished user turn should not leave behind messages or metadata after rollback.

**Data flow**: The test creates one completed turn, then starts a second user turn without completing it, and finally records a rollback. Reconstruction should keep only the first turn’s messages and restore metadata from the first turn.

**Call relations**: The test runner calls this to cover interrupted or partially written rollouts. It uses the message helpers for expected history and asks `reconstruct_history_from_rollout` to process the incomplete timeline.

*Call graph*: calls 3 internal fn (assistant_message, user_message, make_session_and_context); 2 external calls (assert_eq!, vec!).


##### `reconstruct_history_rollback_skips_non_user_turns_for_history_and_metadata`  (lines 412–535)

```
async fn reconstruct_history_rollback_skips_non_user_turns_for_history_and_metadata()
```

**Purpose**: Checks that rollback counts user-facing turns, not every internal turn. A standalone assistant/internal task should not consume a rollback count meant for user turns.

**Data flow**: The test builds a valid first user turn, a second user turn, then a standalone assistant-only turn, followed by a rollback of one turn. Reconstruction should remove the second user turn and ignore the standalone turn for rollback counting, leaving the first turn’s history and metadata.

**Call relations**: This case uses `user_message` and `assistant_message` to build the rollout and expected result. It exercises `reconstruct_history_from_rollout` to make sure hidden non-user activity does not confuse user-visible undo behavior.

*Call graph*: calls 3 internal fn (assistant_message, user_message, make_session_and_context); 2 external calls (assert_eq!, vec!).


##### `reconstruct_history_rollback_counts_inter_agent_assistant_turns`  (lines 538–636)

```
async fn reconstruct_history_rollback_counts_inter_agent_assistant_turns()
```

**Purpose**: Checks that an assistant turn carrying an inter-agent instruction is counted during rollback. Even though it is assistant-originated, it represents meaningful agent work that must be undoable.

**Data flow**: The test builds a normal user turn, then an assistant-driven inter-agent turn with a worker reply, then rolls back one turn. Reconstruction should remove that inter-agent turn and keep the earlier user turn’s history and metadata.

**Call relations**: This test calls `inter_agent_assistant_message` for the special instruction message and `assistant_message` for ordinary replies. It then uses `reconstruct_history_from_rollout` to verify the rollback classification rule.

*Call graph*: calls 3 internal fn (assistant_message, inter_agent_assistant_message, make_session_and_context); 2 external calls (assert_eq!, vec!).


##### `reconstruct_history_rollback_clears_history_and_metadata_when_exceeding_user_turns`  (lines 639–690)

```
async fn reconstruct_history_rollback_clears_history_and_metadata_when_exceeding_user_turns()
```

**Purpose**: Checks the safety behavior when a rollback asks to remove more turns than exist. The session should end up with no conversation history and no previous-turn metadata.

**Data flow**: The test builds a single completed user turn and then records a rollback for many turns. Reconstruction turns that into an empty history, no previous settings, and no reference context item.

**Call relations**: The async test runner invokes this boundary case. It calls the real reconstruction method to ensure excessive rollback does not leave stale context behind.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert!, assert_eq!, vec!).


##### `record_initial_history_resumed_rollback_skips_only_user_turns`  (lines 693–765)

```
async fn record_initial_history_resumed_rollback_skips_only_user_turns()
```

**Purpose**: Checks that, during full session resume, rollback skips only user turns and does not let standalone task turns affect the count. This mirrors the direct reconstruction rule in the resume path.

**Data flow**: The test records a user turn, then a standalone task turn with no user message, then a rollback of one turn. After `record_initial_history`, the session should have no previous settings or reference context because the one user turn was removed.

**Call relations**: This test is driven by the async test runner and goes through `record_initial_history`, not just the lower-level reconstruction helper. It proves the production resume path applies the same rollback counting rule.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_rollback_drops_incomplete_user_turn_compaction_metadata`  (lines 768–858)

```
async fn record_initial_history_resumed_rollback_drops_incomplete_user_turn_compaction_metadata()
```

**Purpose**: Checks that compaction metadata from an incomplete rolled-back user turn is not allowed to poison the restored reference context. The previous completed turn should remain the trusted baseline.

**Data flow**: The test builds one completed turn with context, then an incomplete user turn that includes a compaction record, then a rollback. After resume, previous settings and reference context should still come from the completed turn, not from the incomplete compacted one.

**Call relations**: The test runner invokes this resume case to protect `record_initial_history` from a subtle ordering problem. It ensures rollback removes the incomplete turn’s compaction effects from metadata accounting.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_bare_turn_context_does_not_seed_reference_context_item`  (lines 861–875)

```
async fn record_initial_history_resumed_bare_turn_context_does_not_seed_reference_context_item()
```

**Purpose**: Checks that a turn context by itself does not become the session’s reference context. The session requires real turn evidence before trusting that context.

**Data flow**: The test creates a resumed history containing only a context item. After recording it, it asks the session for its reference context and expects none.

**Call relations**: This is a focused resume test for `record_initial_history`. It complements the previous-turn-settings test by checking the separate reference-context field.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert!, Resumed, vec!).


##### `record_initial_history_resumed_does_not_seed_reference_context_item_after_compaction`  (lines 878–900)

```
async fn record_initial_history_resumed_does_not_seed_reference_context_item_after_compaction()
```

**Purpose**: Checks that compaction prevents an earlier loose context item from becoming a trusted reference. Once history is compacted, old baseline context may no longer describe the current reconstructed history.

**Data flow**: The test records a bare context item followed by a compaction item. After resume, the session should have no previous settings and no reference context item.

**Call relations**: The test runner calls this to exercise `record_initial_history` with compaction present. It confirms that compaction clears trust in context that was not tied to a valid later turn.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


##### `reconstruct_history_legacy_compaction_without_replacement_history_does_not_inject_current_initial_context`  (lines 903–928)

```
async fn reconstruct_history_legacy_compaction_without_replacement_history_does_not_inject_current_initial_context()
```

**Purpose**: Checks behavior for older compaction records that contain only a summary and no replacement history. Reconstruction should not secretly add the current session’s context into the rebuilt history.

**Data flow**: The test builds history with a user message, assistant reply, and a legacy compaction summary. Reconstruction should keep the original user message and add the summary as a user-style message, while leaving the reference context empty.

**Call relations**: This direct reconstruction test uses simple helper messages and calls `reconstruct_history_from_rollout`. It protects compatibility with old rollout files whose compaction format lacks newer metadata.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert!, assert_eq!, vec!).


##### `reconstruct_history_legacy_compaction_without_replacement_history_clears_later_reference_context_item`  (lines 931–982)

```
async fn reconstruct_history_legacy_compaction_without_replacement_history_clears_later_reference_context_item()
```

**Purpose**: Checks that a legacy compaction record blocks later context from being treated as a valid reference. This avoids trusting context after a history rewrite that cannot be fully reconstructed.

**Data flow**: The test builds a legacy compaction record, then a later normal-looking turn context. Reconstruction should still leave the reference context empty because the earlier compaction made the baseline unreliable.

**Call relations**: The test runner invokes this direct reconstruction case. It calls `reconstruct_history_from_rollout` to verify that old compaction behavior takes priority over later context seeding.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (assert!, vec!).


##### `record_initial_history_resumed_turn_context_after_compaction_reestablishes_reference_context_item`  (lines 985–1094)

```
async fn record_initial_history_resumed_turn_context_after_compaction_reestablishes_reference_context_item()
```

**Purpose**: Checks that a turn context appearing after compaction can re-establish a trusted reference when it is part of a real turn. Compaction clears the old baseline, but a later valid turn can create a new one.

**Data flow**: The test records a turn start and user message, then a compaction item, then a turn context, then turn completion. After resume, the session should restore previous settings and reference context from that post-compaction turn context.

**Call relations**: This test runs through `record_initial_history` to verify the full resume path. It demonstrates the intended reset-and-rebuild behavior around compaction.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_aborted_turn_without_id_clears_active_turn_for_compaction_accounting`  (lines 1097–1209)

```
async fn record_initial_history_resumed_aborted_turn_without_id_clears_active_turn_for_compaction_accounting()
```

**Purpose**: Checks that an abort event with no turn id still clears the active turn for compaction bookkeeping. This matters because some interrupted turns may not record their id on abort.

**Data flow**: The test records a completed prior turn, then starts a new user turn, aborts it with no id, and adds a compaction item. After resume, previous settings should still come from the prior turn, but the reference context should be cleared by compaction.

**Call relations**: The test runner calls this resume scenario to protect `record_initial_history` from stale active-turn state. It verifies that an id-less abort is treated as applying to the currently active turn.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_unmatched_abort_preserves_active_turn_for_later_turn_context`  (lines 1212–1336)

```
async fn record_initial_history_resumed_unmatched_abort_preserves_active_turn_for_later_turn_context()
```

**Purpose**: Checks that an abort for a different turn does not clear the currently active turn. A later context for the active turn should still be accepted.

**Data flow**: The test records one completed prior turn, starts a current turn, inserts an abort event naming some other turn, then records the current turn’s context and completion. After resume, previous settings and reference context should come from the current turn.

**Call relations**: This test exercises `record_initial_history` with mismatched abort data. It pairs with the id-less abort test to define exactly when active-turn tracking should be cleared.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_trailing_incomplete_turn_compaction_clears_reference_context_item`  (lines 1339–1443)

```
async fn record_initial_history_resumed_trailing_incomplete_turn_compaction_clears_reference_context_item()
```

**Purpose**: Checks that if a final incomplete user turn is compacted, the reference context is cleared. The session can keep previous settings from the last completed turn, but should not keep a stale reference context.

**Data flow**: The test records a completed prior turn, then starts a trailing incomplete user turn and adds a compaction item. After resume, previous settings remain from the prior turn, while the reference context is empty.

**Call relations**: The test runner invokes this as a full resume case through `record_initial_history`. It verifies safe cleanup when a rollout ends after compaction but before the active turn finishes.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_trailing_incomplete_turn_preserves_turn_context_item`  (lines 1446–1499)

```
async fn record_initial_history_resumed_trailing_incomplete_turn_preserves_turn_context_item()
```

**Purpose**: Checks that an unfinished trailing turn can still provide valid settings if it contains a turn context and has not been compacted away. This lets a resumed session continue from a partially recorded but context-bearing turn.

**Data flow**: The test starts a turn, records a user message and a turn context, but no completion. After resume, the session should restore previous settings and reference context from that context item.

**Call relations**: This test calls `record_initial_history` to cover the resume path for a rollout that ends mid-turn. It contrasts with the compaction case, where the reference context must be cleared.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 4 external calls (from, assert_eq!, Resumed, vec!).


##### `record_initial_history_resumed_replaced_incomplete_compacted_turn_clears_reference_context_item`  (lines 1502–1618)

```
async fn record_initial_history_resumed_replaced_incomplete_compacted_turn_clears_reference_context_item()
```

**Purpose**: Checks that when an incomplete compacted turn is replaced by a newer turn start, its reference context stays cleared. A new turn starting without completing the old one should not revive stale compacted metadata.

**Data flow**: The test records a completed prior turn, then an incomplete user turn with compaction, then starts another turn that replaces it. After resume, previous settings remain from the completed prior turn, and the reference context is empty.

**Call relations**: The async test runner calls this final edge case through `record_initial_history`. It protects the active-turn and compaction accounting when logs contain overlapping or replaced turns.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 5 external calls (from, assert!, assert_eq!, Resumed, vec!).


### `core/src/session/mcp_tests.rs`

`test` · `test`

This is a test file for the session code that connects MCP, meaning the Model Context Protocol used for tool/server communication, with Guardian, the project’s approval reviewer. In everyday terms, it checks the paperwork for tool approval requests: when a tool asks, “May I do this?”, the system must turn that into the right Guardian review request, then turn Guardian’s answer back into the right MCP reply.

The tests build small fake elicitation requests, which are requests for user or reviewer input. Some helpers create the metadata that marks a request as a Guardian-reviewed MCP tool call. The tests then check several important rules. A valid browser tool request should become a Guardian MCP tool-call approval request with the correct server, tool name, connector details, and arguments. If tool parameters are missing, the request should still be safe and use an empty argument object. Requests that do not explicitly opt in to the Guardian approval shape should not be treated as Guardian requests. Requests with unsupported shapes, such as URL elicitations or forms with extra schema fields, should be declined rather than guessed at.

The file also tests telemetry metadata for plugin install suggestions and confirms that Guardian decisions such as approved, denied, timed out, or aborted become the correct MCP response actions.

#### Function details

##### `meta`  (lines 7–12)

```
fn meta(value: Value) -> Option<Meta>
```

**Purpose**: This helper wraps a JSON object as MCP metadata for use in the tests. It makes test setup shorter and also catches mistakes where a test accidentally passes something other than a JSON object.

**Data flow**: It receives a JSON value. If that value is an object, it wraps the object in a Meta value and returns it inside Some, meaning metadata is present. If the value is not an object, it stops the test with a panic because metadata is expected to be object-shaped.

**Call relations**: The other test helpers and test cases call this when they need metadata. guardian_meta uses it after building the standard Guardian metadata, and two tests call it directly to create intentionally incomplete or unusual metadata shapes.

*Call graph*: called by 3 (guardian_elicitation_review_request_declines_unsupported_opt_in_shapes, guardian_elicitation_review_request_requires_opt_in, guardian_meta); 1 external calls (panic!).


##### `guardian_meta`  (lines 14–27)

```
fn guardian_meta(tool_params: Option<Value>) -> Option<Meta>
```

**Purpose**: This helper creates the standard metadata that says an MCP elicitation is asking Guardian to review an MCP tool call. It optionally includes the tool arguments that Guardian should review.

**Data flow**: It starts with a JSON object containing fields such as approval kind, request type, connector ID, connector name, tool name, and tool title. If tool parameters are provided, it adds them under tool_params. It then passes the finished JSON object to meta, which wraps it as MCP metadata.

**Call relations**: Several tests call this to create a realistic Guardian opt-in request before passing it through form_request. It hands off to meta so all metadata wrapping is done consistently.

*Call graph*: calls 1 internal fn (meta); called by 3 (guardian_elicitation_review_request_builds_mcp_tool_call, guardian_elicitation_review_request_declines_unsupported_opt_in_shapes, guardian_elicitation_review_request_defaults_missing_tool_params); 1 external calls (json!).


##### `form_request`  (lines 29–41)

```
fn form_request(meta: Option<Meta>) -> ElicitationReviewRequest
```

**Purpose**: This helper builds a simple form-style MCP elicitation review request for tests. It represents a tool asking a yes-or-no style approval question with an empty requested form schema.

**Data flow**: It receives optional metadata. It creates an ElicitationReviewRequest for the browser-use server, gives it a numeric request ID, sets a message of “Allow origin?”, and builds an empty form schema. The finished request is returned for the test to inspect through the production conversion functions.

**Call relations**: Most of the Guardian conversion tests call this to avoid repeating the same request setup. Those tests vary only the metadata, then pass the resulting request into guardian_elicitation_review_request.

*Call graph*: called by 4 (guardian_elicitation_review_request_builds_mcp_tool_call, guardian_elicitation_review_request_declines_unsupported_opt_in_shapes, guardian_elicitation_review_request_defaults_missing_tool_params, guardian_elicitation_review_request_requires_opt_in); 2 external calls (builder, Number).


##### `guardian_elicitation_review_request_builds_mcp_tool_call`  (lines 44–80)

```
fn guardian_elicitation_review_request_builds_mcp_tool_call()
```

**Purpose**: This test verifies the happy path: a properly marked MCP elicitation becomes a Guardian approval request for an MCP tool call. It checks that important details are copied correctly, including the tool arguments and connector labels.

**Data flow**: It builds a form request with Guardian metadata and a sample origin argument. It sends that request into guardian_elicitation_review_request. It then unpacks the returned Guardian approval request and compares each important field against the expected values.

**Call relations**: This test uses guardian_meta and form_request to create the input. It exercises the production conversion function guardian_elicitation_review_request and confirms that the result has the exact shape Guardian needs for reviewing a tool call.

*Call graph*: calls 2 internal fn (form_request, guardian_meta); 3 external calls (assert_eq!, json!, panic!).


##### `guardian_elicitation_review_request_defaults_missing_tool_params`  (lines 83–97)

```
fn guardian_elicitation_review_request_defaults_missing_tool_params()
```

**Purpose**: This test checks that missing tool parameters are treated as an empty argument object rather than as an error or a missing value. That matters because Guardian still needs a stable request shape even when a tool has no arguments.

**Data flow**: It builds a Guardian-marked form request without tool_params. It passes the request to guardian_elicitation_review_request, extracts the arguments from the Guardian MCP tool-call request, and checks that they equal an empty JSON object.

**Call relations**: The test relies on guardian_meta to create metadata without optional parameters and form_request to make the review request. It verifies one narrow behavior of guardian_elicitation_review_request: safe defaulting of absent arguments.

*Call graph*: calls 2 internal fn (form_request, guardian_meta); 2 external calls (assert_eq!, panic!).


##### `plugin_install_elicitation_telemetry_metadata_requires_install_tool_suggestion`  (lines 100–154)

```
fn plugin_install_elicitation_telemetry_metadata_requires_install_tool_suggestion()
```

**Purpose**: This test checks that telemetry metadata is collected only for plugin install suggestions, not for other suggestion types such as enabling an already available plugin. Telemetry here means small structured facts used for logging or measurement.

**Data flow**: It first builds an elicitation event whose metadata says it is a tool suggestion to install a plugin named Slack. It calls plugin_install_elicitation_telemetry_metadata and expects the plugin type, ID, and name to be returned. Then it builds a similar event where the suggestion type is enable instead of install, calls the same function, and expects no metadata.

**Call relations**: This test directly exercises plugin_install_elicitation_telemetry_metadata with two event examples. The first shows the accepted path, and the second shows that the function filters out non-install suggestions.

*Call graph*: 4 external calls (String, assert_eq!, json!, ElicitationRequest).


##### `guardian_elicitation_review_request_requires_opt_in`  (lines 157–167)

```
fn guardian_elicitation_review_request_requires_opt_in()
```

**Purpose**: This test makes sure a request is not treated as a Guardian approval request unless it includes the explicit request-type marker. This prevents ordinary or incomplete metadata from being upgraded into an approval flow by accident.

**Data flow**: It creates metadata that says the approval kind is an MCP tool call and includes a tool name, but leaves out the codex_request_type approval marker. It builds a form request with that metadata, passes it to guardian_elicitation_review_request, and expects the result to be NotRequested.

**Call relations**: The test uses meta and form_request to create a deliberately incomplete request. It checks that guardian_elicitation_review_request refuses to enter the Guardian path unless the opt-in metadata is complete.

*Call graph*: calls 2 internal fn (form_request, meta); 2 external calls (assert_eq!, json!).


##### `guardian_elicitation_review_request_declines_unsupported_opt_in_shapes`  (lines 170–211)

```
fn guardian_elicitation_review_request_declines_unsupported_opt_in_shapes()
```

**Purpose**: This test confirms that requests which opt into Guardian review but have unsupported shapes are declined safely. That is important because the system should not guess how to approve requests it does not understand.

**Data flow**: It creates three problematic requests: a URL-style elicitation, a form elicitation with a non-empty schema, and a form request missing the required tool name. Each one is passed to guardian_elicitation_review_request, and each is expected to produce a Decline result.

**Call relations**: The test uses guardian_meta, meta, and form_request for setup, plus schema builders for the non-empty form case. It exercises the defensive branches of guardian_elicitation_review_request, proving that unsupported opt-in requests are rejected rather than silently accepted.

*Call graph*: calls 3 internal fn (form_request, guardian_meta, meta); 6 external calls (new, builder, Boolean, assert!, json!, Number).


##### `guardian_decisions_map_to_elicitation_responses_without_session_state`  (lines 214–269)

```
fn guardian_decisions_map_to_elicitation_responses_without_session_state()
```

**Purpose**: This test checks the translation from Guardian review decisions into MCP elicitation responses without needing a live session. It verifies what the tool server will receive after Guardian approves, denies, times out, or aborts a request.

**Data flow**: It calls mcp_elicitation_response_from_guardian_decision_parts with four decisions. Approved becomes an Accept response with empty content. Denied becomes Decline with the denial message. TimedOut becomes Decline with the standard Guardian timeout message. Abort becomes Cancel. Each response also includes metadata showing that the reviewer was the automatic Guardian reviewer.

**Call relations**: This test directly exercises mcp_elicitation_response_from_guardian_decision_parts. It stands apart from the request-building helpers because it checks the return trip: after Guardian has made a decision, the system must send the correct MCP response back.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/state/session_tests.rs`

`test` · `test run`

A session is the program’s working memory for one interaction: what connectors the user selected, what rate-limit information was last reported, and how much prior conversation may be prefilled when compacting history. This file contains automated tests for that memory. Each test builds a simple test session configuration, creates a fresh SessionState, performs one small action, and compares the result with the expected state.

The connector tests make sure selected connector IDs behave like a set: adding the same connector twice should not create duplicates, and clearing should remove everything. The rate-limit tests protect subtle rules about snapshots received from the service. If a rate-limit update arrives without a limit ID, the state should treat it as the main "codex" bucket rather than accidentally keeping another bucket name. Another test checks that account-level details, such as credits, spend-control limits, and plan type, are carried from the main codex bucket to a related "codex_other" bucket when the later update omits them. Finally, the history test confirms that replacing the conversation clears an estimated prefill value used for auto-compaction, so stale token estimates are not reused after the history changes.

#### Function details

##### `merge_connector_selection_deduplicates_entries`  (lines 11–24)

```
async fn merge_connector_selection_deduplicates_entries()
```

**Purpose**: This test proves that adding connector IDs to the session removes repeats. A user or caller can ask for "calendar" twice, but the stored selection should contain it only once.

**Data flow**: It starts by asking make_session_configuration_for_tests for a test configuration, then creates a fresh SessionState with new. It feeds the state a small list containing two "calendar" entries and one "drive" entry. The result is compared with a set containing only "calendar" and "drive", so the before state with duplicates becomes an after state with unique IDs.

**Call relations**: During the test run, the async test runner calls this function. The function uses the shared test configuration helper and SessionState construction path, then checks the session state's connector-merging behavior with assert_eq!, which reports a clear failure if duplicates remain.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 1 external calls (assert_eq!).


##### `clear_connector_selection_removes_entries`  (lines 28–36)

```
async fn clear_connector_selection_removes_entries()
```

**Purpose**: This test proves that clearing connector selection really empties the saved connector list. Without this, a later request might accidentally reuse a connector the user no longer wanted.

**Data flow**: It gets a test configuration, creates a new SessionState, and first stores one connector ID, "calendar". It then calls the clearing operation and reads the stored connector selection back. The expected output is an empty set, meaning the stored selection changed from containing one item to containing none.

**Call relations**: The async test runner invokes this as an isolated check. It relies on make_session_configuration_for_tests and new to create a clean state, then uses assert_eq! to confirm the clearing operation leaves no connector IDs behind.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 1 external calls (assert_eq!).


##### `set_rate_limits_defaults_limit_id_to_codex_when_missing`  (lines 39–65)

```
async fn set_rate_limits_defaults_limit_id_to_codex_when_missing()
```

**Purpose**: This test checks the default rule for rate-limit updates that arrive without a limit ID. The session should label that update as the main "codex" limit instead of leaving the identity unclear.

**Data flow**: It creates a fresh SessionState from a test configuration. It then sends in a RateLimitSnapshot whose limit_id and limit_name are missing but whose primary usage window has values. After the update, it reads latest_rate_limits from the state and expects the stored limit_id to be "codex".

**Call relations**: The test runner calls this function as part of the state test suite. The function sets up a normal SessionState using make_session_configuration_for_tests and new, exercises the rate-limit update rule, and hands the final comparison to assert_eq!.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 1 external calls (assert_eq!).


##### `replace_history_clears_auto_compact_window_prefill`  (lines 68–81)

```
async fn replace_history_clears_auto_compact_window_prefill()
```

**Purpose**: This test makes sure that replacing the conversation history clears a saved token estimate used for auto-compaction. That matters because an estimate from old history would be misleading after the history has been replaced.

**Data flow**: It creates a new session state, stores an estimated prefill value of 100 tokens, and then replaces the history with an empty list and no reference context item. After that, it asks for the auto-compact window snapshot. The expected result is a snapshot with no prefill_input_tokens value, showing that the old estimate was removed.

**Call relations**: The async test runner invokes this check. It uses the shared test configuration helper, creates a SessionState with new, builds the expected AutoCompactWindowSnapshot value, and uses assert_eq! to verify that history replacement also resets the related compaction bookkeeping.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 2 external calls (new, assert_eq!).


##### `set_rate_limits_defaults_to_codex_when_limit_id_missing_after_other_bucket`  (lines 84–124)

```
async fn set_rate_limits_defaults_to_codex_when_limit_id_missing_after_other_bucket()
```

**Purpose**: This test protects against a subtle mix-up between rate-limit buckets. If the session last saw a "codex_other" bucket and the next update has no ID, the missing ID should still default to "codex", not inherit "codex_other".

**Data flow**: It starts with a clean SessionState. First it stores a rate-limit snapshot explicitly marked as "codex_other". Then it stores a second snapshot with no limit_id. Finally it reads the latest stored rate-limit ID and expects it to be "codex". The important change is that a missing ID is actively filled with the main bucket name rather than copied from the previous update.

**Call relations**: The test runner calls this function to check a sequence of two updates, not just a single update. The setup comes from make_session_configuration_for_tests and new, and assert_eq! verifies that the second update follows the defaulting rule even after a different bucket was stored before.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 1 external calls (assert_eq!).


##### `set_rate_limits_carries_account_metadata_from_codex_to_codex_other`  (lines 127–196)

```
async fn set_rate_limits_carries_account_metadata_from_codex_to_codex_other()
```

**Purpose**: This test checks that account-level details are preserved when moving from a main codex rate-limit update to a related codex_other update. The later bucket update may only contain usage-window data, but the session should not forget credits, spend limits, or plan type that still apply to the account.

**Data flow**: It creates a fresh SessionState and first stores a "codex" RateLimitSnapshot containing usage data plus credits, an individual spend-control limit, and the Plus plan type. It then stores a "codex_other" snapshot that has its own usage window but omits those account details. The final stored snapshot should combine the new "codex_other" usage data with the earlier account metadata from the codex snapshot.

**Call relations**: The async test runner invokes this as a regression check for rate-limit state merging. The function uses make_session_configuration_for_tests and new for setup, then sends two snapshots through the session state and uses assert_eq! to compare the whole final snapshot with the expected merged result.

*Call graph*: calls 2 internal fn (make_session_configuration_for_tests, new); 1 external calls (assert_eq!).


### `core/src/session_prefix_tests.rs`

`test` · `test run`

This test protects a small but important user-facing behavior: failure messages must be useful without becoming too large. In this project, agents can report back to one another, and an agent may finish with an error. If the raw error text is huge, the system should not blindly pass all of it along, because that could waste space, exceed limits, or make the message harder to review. This file creates an intentionally oversized error by repeating the phrase “stream disconnected” many times. It then asks the normal completion-message formatter to turn that failed agent status into the text that would be sent upward from a worker agent to the root agent. The test checks two things. First, the resulting message must stay under the configured token limit, where a token is a rough unit of text size used by language models. Second, the message must still include the standard next-action guidance for errors, so shortening the message does not remove the part that helps a human or calling agent recover. In everyday terms, this is like making sure a smoke alarm report is brief enough to fit on the dashboard, but still says “check the building now.”

#### Function details

##### `error_completion_message_stays_below_manual_review_threshold`  (lines 10–20)

```
fn error_completion_message_stays_below_manual_review_threshold()
```

**Purpose**: This test makes sure an error completion message is shortened enough to stay below the manual review size limit. It also verifies that the shortened message still includes the expected instruction about what should happen next.

**Data flow**: The test starts with a root agent path, a worker agent path, and an error status containing a deliberately huge repeated error string. It sends those into the completion-message formatter. The returned message is then measured with an approximate token counter and searched for the required next-action text. The test passes only if the message is small enough and still contains that guidance.

**Call relations**: During the test run, this function calls the agent-path helpers to describe who is reporting to whom, builds an errored agent status, and hands all of that to the shared completion-message formatting function. It then uses assertions to lock in the expected behavior: the formatter may trim or shape the error text, but it must not produce an oversized message or lose the standard error next step.

*Call graph*: calls 2 internal fn (root, try_from); 3 external calls (assert!, Errored, format_inter_agent_completion_message).


### Transcript and context shaping
These files verify how history, context, events, metadata, and compaction are transformed into the runtime transcript and prompt-visible state.

### `core/src/compact_tests.rs`

`test` · `test run`

Long chat sessions can become too large to send back to a model in full, so the project has code that “compacts” history: it keeps what matters, summarizes the rest, and then adds fresh startup context back in. This test file checks that process from a user’s point of view. It makes small fake conversation histories and verifies the cleaned result is exactly what the rest of the system expects.

The tests cover several important rules. Plain text pieces should be joined, while image-only content should not become text. Only real user messages should be collected; generated setup messages, environment context, aborted-turn notes, and old warning messages should be ignored. When user text is too large, it should be shortened and clearly marked instead of silently overflowing the token budget. A token is roughly a small chunk of text used by language models for size limits.

The file also checks that compacted history is refreshed with the current initial context, like putting the latest instruction sheet back into a folder before continuing work. Stale developer messages are removed, fresh developer context is inserted in the right place, summaries stay last when they should, encrypted compaction records stay last when needed, and model-switch notices are restored when the previous turn used a different model.

#### Function details

##### `process_compacted_history_with_test_session`  (lines 8–25)

```
async fn process_compacted_history_with_test_session(
    compacted_history: Vec<ResponseItem>,
    previous_turn_settings: Option<&PreviousTurnSettings>,
) -> (Vec<ResponseItem>, Vec<ResponseItem>)
```

**Purpose**: This helper builds a realistic test session, optionally gives it previous-turn settings, and runs compacted history through the same refresh path used by the real system. Tests use it so they do not have to repeat the setup work each time.

**Data flow**: It receives a list of compacted conversation items and optional settings from the previous turn. It creates a test session and context, stores the previous settings if any, builds the fresh initial context, then asks the compaction-refresh code to process the history. It returns both the refreshed history and the initial context so each test can compare the result against an expected answer.

**Call relations**: Several async tests call this helper when they need the full session-based path. Inside, it asks `make_session_and_context` for a realistic session setup, then hands the compacted history to `process_compacted_history` so the test exercises the real refresh behavior rather than a hand-made shortcut.

*Call graph*: calls 2 internal fn (process_compacted_history, make_session_and_context); called by 6 (process_compacted_history_drops_legacy_warnings, process_compacted_history_drops_non_user_content_messages, process_compacted_history_inserts_context_before_last_real_user_message_only, process_compacted_history_reinjects_full_initial_context, process_compacted_history_reinjects_model_switch_message, process_compacted_history_replaces_developer_messages).


##### `user_message`  (lines 27–37)

```
fn user_message(text: &str) -> ResponseItem
```

**Purpose**: This small helper creates a standard user message from plain text. It keeps tests shorter and makes each fake conversation item look like the real data structure used by the system.

**Data flow**: It takes a text string, wraps it in a user-role message with one input-text content item, and leaves optional fields such as id and metadata empty. The output is a `ResponseItem` ready to be placed in a test conversation history.

**Call relations**: The legacy-warning compaction test calls this helper to build several fake user messages quickly. The helper uses the usual vector-building machinery to put the content item into the message.

*Call graph*: called by 1 (process_compacted_history_drops_legacy_warnings); 1 external calls (vec!).


##### `compacted_user_message`  (lines 39–44)

```
fn compacted_user_message(text: &str) -> CompactedUserMessage
```

**Purpose**: This helper creates a compacted user message from plain text. It is used when a test needs the smaller intermediate form that compaction code works with before rebuilding response history.

**Data flow**: It receives text, copies it into a `CompactedUserMessage`, and leaves metadata empty. The result is a simple compacted-message value that can be passed to history-building code.

**Call relations**: The token-limit truncation test calls this helper before passing the message into the compacted-history builder. It keeps that test focused on truncation behavior instead of setup details.

*Call graph*: called by 1 (build_token_limited_compacted_history_truncates_overlong_user_messages).


##### `content_items_to_text_joins_non_empty_segments`  (lines 47–63)

```
fn content_items_to_text_joins_non_empty_segments()
```

**Purpose**: This test checks that text content is combined in a clean, readable way. Empty text pieces should not create extra blank output.

**Data flow**: It starts with content containing `hello`, an empty text segment, and `world`. It converts the content to text and expects the result to be `hello` and `world` joined with a newline.

**Call relations**: This is a focused unit test: it builds its sample content locally and then compares the result with the expected text using an equality assertion.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `content_items_to_text_ignores_image_only_content`  (lines 66–75)

```
fn content_items_to_text_ignores_image_only_content()
```

**Purpose**: This test makes sure image-only content is not treated as if it had text. That matters because compacted summaries and user-message collection should not invent text where none exists.

**Data flow**: It creates a content list with only an input image. After conversion, it expects no text result at all, represented as `None`.

**Call relations**: This test builds a single image content item and checks the conversion result directly with an equality assertion.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `collect_user_messages_extracts_user_text_only`  (lines 78–104)

```
fn collect_user_messages_extracts_user_text_only()
```

**Purpose**: This test checks that only real user text is collected from a mixed conversation. Assistant messages and non-message items should be ignored.

**Data flow**: It creates a fake history with an assistant text message, a user text message, and an unrelated item. After collection, only the user's `first` message should remain in compacted form.

**Call relations**: The test constructs the mixed input locally and compares the collected output against a single expected compacted user message.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `collect_user_messages_filters_session_prefix_entries`  (lines 107–146)

```
fn collect_user_messages_filters_session_prefix_entries()
```

**Purpose**: This test checks that generated setup text is not mistaken for something the user actually asked. Project instructions and environment context are useful internally, but they should not become part of the compacted user-message list.

**Data flow**: It feeds in three user-role messages: an AGENTS.md instruction block, an environment-context block, and a real user message. The collection step should drop the first two and return only `real user message`.

**Call relations**: The test builds all messages in place and verifies the filtering rule with an equality assertion.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `collect_user_messages_filters_legacy_warnings`  (lines 149–166)

```
fn collect_user_messages_filters_legacy_warnings()
```

**Purpose**: This test protects against old system warning messages being preserved as user intent. Those warnings were injected into history in older flows, but they should not influence future compacted conversations.

**Data flow**: It creates several warning-shaped user messages plus one real user message. The collection step should remove the warnings and keep only the real message.

**Call relations**: The test uses locally built input data and compares the collected result with the expected single compacted user message.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `build_token_limited_compacted_history_truncates_overlong_user_messages`  (lines 169–209)

```
fn build_token_limited_compacted_history_truncates_overlong_user_messages()
```

**Purpose**: This test checks that very large user messages are shortened before being placed into compacted history. Without this, a compacted conversation could still exceed the model’s size limit.

**Data flow**: It sets a small token limit, creates a very long repeated-word message, and asks the history builder to include it with a summary. The output should contain two messages: a shortened user message with a clear truncation marker, and the summary message unchanged.

**Call relations**: The test calls `compacted_user_message` to make the oversized input, then hands it to `build_compacted_history_with_limit`. It uses assertions to check both the truncation marker and the final summary.

*Call graph*: calls 1 internal fn (compacted_user_message); 6 external calls (new, assert!, assert_eq!, panic!, from_ref, build_compacted_history_with_limit).


##### `build_token_limited_compacted_history_appends_summary_message`  (lines 212–231)

```
fn build_token_limited_compacted_history_appends_summary_message()
```

**Purpose**: This test confirms that the compacted history builder always adds the summary at the end. The summary is the condensed memory of earlier conversation, so losing it would make the model forget important context.

**Data flow**: It starts with no initial context, one compacted user message, and a summary string. After building history, it inspects the last item and expects it to be a user-role message containing exactly the summary text.

**Call relations**: This test builds its input data directly and checks the final history with assertions, including a failure path that reports an unexpected item if the last entry is not the expected message.

*Call graph*: 5 external calls (new, assert!, assert_eq!, panic!, vec!).


##### `build_compacted_history_preserves_user_message_metadata`  (lines 234–248)

```
fn build_compacted_history_preserves_user_message_metadata()
```

**Purpose**: This test checks that metadata attached to a compacted user message, such as a turn id, survives when history is rebuilt. That link matters for tracing which turn a message came from.

**Data flow**: It creates one compacted user message with metadata containing `turn-1`, then builds compacted history with a summary. The rebuilt user message should still carry `turn-1`, while the new summary message should have no turn id.

**Call relations**: The test calls the history builder with a small prepared input and verifies the metadata on the resulting entries with equality assertions.

*Call graph*: 2 external calls (new, assert_eq!).


##### `should_use_remote_compact_task_for_azure_provider`  (lines 251–273)

```
fn should_use_remote_compact_task_for_azure_provider()
```

**Purpose**: This test checks that Azure-backed model providers use the remote compaction task path. That matters because provider differences can affect which compaction method is safe or supported.

**Data flow**: It creates a model-provider description named Azure with response-style API settings. It asks the decision function whether remote compaction should be used and expects the answer to be true.

**Call relations**: This is a direct decision-rule test. It builds the provider record locally and uses an assertion to confirm the rule’s result.

*Call graph*: 1 external calls (assert!).


##### `process_compacted_history_replaces_developer_messages`  (lines 275–320)

```
async fn process_compacted_history_replaces_developer_messages()
```

**Purpose**: This async test verifies that old developer messages inside compacted history are removed and replaced by fresh initial context. Developer messages are instruction-like messages from the system side, so stale ones could give the model outdated rules.

**Data flow**: It starts with compacted history containing stale developer text before and after a user summary. The helper processes the history in a test session. The expected result is the fresh initial context followed by the user summary, with stale developer messages gone.

**Call relations**: The test calls `process_compacted_history_with_test_session`, which in turn creates a test session and runs `process_compacted_history`. After that, the test appends the expected summary to the returned initial context and compares the whole refreshed history.

*Call graph*: calls 1 internal fn (process_compacted_history_with_test_session); 2 external calls (assert_eq!, vec!).


##### `process_compacted_history_reinjects_full_initial_context`  (lines 323–348)

```
async fn process_compacted_history_reinjects_full_initial_context()
```

**Purpose**: This async test checks that even a simple compacted history gets the full current initial context added back. This keeps the continuing conversation aligned with the latest environment and instructions.

**Data flow**: It provides a compacted history containing only a user summary. Processing should produce the fresh initial context followed by that same summary message.

**Call relations**: The test uses `process_compacted_history_with_test_session` to exercise the real session-based refresh flow, then builds the expected output from the returned initial context and compares it to the refreshed result.

*Call graph*: calls 1 internal fn (process_compacted_history_with_test_session); 2 external calls (assert_eq!, vec!).


##### `process_compacted_history_drops_non_user_content_messages`  (lines 351–427)

```
async fn process_compacted_history_drops_non_user_content_messages()
```

**Purpose**: This async test checks that generated context-like messages are removed from compacted history before fresh context is added. It prevents old project instructions, environment blocks, aborted-turn notes, and stale developer instructions from being duplicated or reused incorrectly.

**Data flow**: It feeds in several user-role messages that look like internal session context, one real summary message, and one stale developer message. After processing, only the fresh initial context and the real summary should remain.

**Call relations**: The test calls `process_compacted_history_with_test_session` to run the real refresh path. It then builds the expected result by taking the helper’s initial context and adding the summary message.

*Call graph*: calls 1 internal fn (process_compacted_history_with_test_session); 2 external calls (assert_eq!, vec!).


##### `process_compacted_history_drops_legacy_warnings`  (lines 430–452)

```
async fn process_compacted_history_drops_legacy_warnings()
```

**Purpose**: This async test verifies that old warning messages are discarded during compacted-history refresh. Those warnings are not user requests, so keeping them could confuse the next model turn.

**Data flow**: It creates three warning messages and one latest real user message. After processing through a test session, the refreshed history should contain the fresh initial context followed only by the latest real user message.

**Call relations**: The test uses `user_message` to create the fake messages and calls `process_compacted_history_with_test_session` to run the full refresh behavior. It compares the final result against initial context plus the one real message.

*Call graph*: calls 2 internal fn (process_compacted_history_with_test_session, user_message); 2 external calls (assert_eq!, vec!).


##### `process_compacted_history_inserts_context_before_last_real_user_message_only`  (lines 455–522)

```
async fn process_compacted_history_inserts_context_before_last_real_user_message_only()
```

**Purpose**: This async test checks the exact insertion point for fresh context. The system should place current instructions before the latest real user message, not before an older user message or before a summary marker.

**Data flow**: It starts with an older user message, a summary-prefixed message, and a latest user message. After refresh, the older entries stay first, the fresh initial context is inserted next, and the latest user message remains after that.

**Call relations**: The test calls `process_compacted_history_with_test_session`, then constructs the expected sequence by combining hand-written older entries, the returned initial context, and the latest user message.

*Call graph*: calls 1 internal fn (process_compacted_history_with_test_session); 2 external calls (assert_eq!, vec!).


##### `process_compacted_history_reinjects_model_switch_message`  (lines 525–567)

```
async fn process_compacted_history_reinjects_model_switch_message()
```

**Purpose**: This async test checks that a model-switch notice is restored when the previous turn used a different regular model. That notice tells the continuing conversation about the change, which can matter for consistency.

**Data flow**: It sets previous-turn settings with a model name, processes a compacted summary through a test session, and inspects the fresh initial context. The first context message should be a developer message containing a `<model_switch>` marker, and the final refreshed history should be that context plus the summary.

**Call relations**: The test passes previous-turn settings into `process_compacted_history_with_test_session`. The helper runs the real refresh path, and the test then checks both the model-switch text and the full refreshed history.

*Call graph*: calls 1 internal fn (process_compacted_history_with_test_session); 4 external calls (assert!, assert_eq!, panic!, vec!).


##### `insert_initial_context_before_last_real_user_or_summary_keeps_summary_last`  (lines 570–651)

```
fn insert_initial_context_before_last_real_user_or_summary_keeps_summary_last()
```

**Purpose**: This test checks that inserting fresh initial context does not move a final summary out of its important last position. The summary is meant to close the compacted history, so it should remain at the end.

**Data flow**: It starts with an older user message, a latest user message, and a summary-prefixed message. It inserts one fresh developer-context message. The expected output places the fresh context before the latest real user message while leaving the summary as the final entry.

**Call relations**: This direct unit test builds both the compacted history and initial context locally, calls the insertion behavior under test, and compares the result to the exact expected ordering.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `insert_initial_context_before_last_real_user_or_summary_keeps_compaction_last`  (lines 654–687)

```
fn insert_initial_context_before_last_real_user_or_summary_keeps_compaction_last()
```

**Purpose**: This test checks that an encrypted compaction record stays last when fresh initial context is inserted. That protects the special compacted payload from being displaced by newly added setup messages.

**Data flow**: It starts with a history containing only an encrypted compaction item and a fresh developer-context message to insert. The output should put the developer context first and keep the encrypted compaction item last.

**Call relations**: This direct unit test constructs the two inputs locally, runs the insertion behavior, and verifies the final order with an equality assertion.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/context_manager/history_tests.rs`

`test` · `test suite`

The context manager is like the notebook the assistant carries from turn to turn. If that notebook keeps the wrong pages, loses a tool result, counts images badly, or sends data the model cannot read, later answers can become wrong or the API can reject the request. This test file builds many small fake conversations and checks those edge cases.

The tests cover what gets saved, what gets ignored, and what is sent back in the next prompt. They make sure system-only noise is filtered, reasoning items are counted correctly, and inter-agent messages can act like user-turn boundaries. They also check rollback: when the user asks to drop recent turns, session setup messages should stay, while later context updates should be removed when appropriate.

A large part of the file protects tool-call consistency. A call and its output belong together, like a question and its answer; if one is missing, normalization either repairs the history or panics in debug builds so developers notice. The image tests make sure unsupported models receive text placeholders instead of images, and that huge inline image data does not make token estimates wildly too large. The file also tests truncation of long command or tool output so the history stays small enough for the model.

#### Function details

##### `assistant_msg`  (lines 37–47)

```
fn assistant_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a simple assistant message for tests. It saves each test from repeating the full message structure when only the assistant text matters.

**Data flow**: Text goes in → the helper wraps it as one assistant output-text item → a ResponseItem message comes out.

**Call relations**: Several tests call this when they need an assistant reply before checking filtering, turn rollback, or legacy inter-agent boundary behavior.

*Call graph*: called by 3 (drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns, filters_non_api_messages, legacy_inter_agent_assistant_messages_are_not_turn_boundaries); 1 external calls (vec!).


##### `inter_agent_assistant_msg`  (lines 49–66)

```
fn inter_agent_assistant_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds an assistant message whose text is actually structured inter-agent communication. Tests use it to prove that modern agent-to-agent messages are treated as instruction-like turn boundaries.

**Data flow**: Plain text goes in → the helper creates an InterAgentCommunication record from root to a worker agent and serializes it as JSON → an assistant message containing that JSON comes out.

**Call relations**: Boundary and prompt-preservation tests call this, then pass the result into history functions that decide whether it starts a turn or should be kept for the prompt.

*Call graph*: calls 2 internal fn (root, new); called by 3 (drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns, for_prompt_preserves_inter_agent_assistant_messages, inter_agent_assistant_messages_are_turn_boundaries); 2 external calls (new, vec!).


##### `create_history_with_items`  (lines 68–74)

```
fn create_history_with_items(items: Vec<ResponseItem>) -> ContextManager
```

**Purpose**: Creates a ContextManager already filled with test items. It gives tests a short, consistent way to set up a fake conversation.

**Data flow**: A list of response items goes in → a new ContextManager records them with a generous token budget → the populated history comes out.

**Call relations**: Most tests use this as their setup step before calling history methods such as for_prompt, normalize_history, remove_first_item, or drop_last_n_user_turns.

*Call graph*: calls 1 internal fn (new); called by 38 (drop_last_n_user_turns_clears_reference_context_for_mixed_developer_context_bundles, drop_last_n_user_turns_ignores_session_prefix_user_messages, drop_last_n_user_turns_preserves_prefix, drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns, drop_last_n_user_turns_trims_context_updates_above_rolled_back_turn, estimate_token_count_with_base_instructions_uses_provided_text, for_prompt_clears_image_generation_result_when_images_are_unsupported, for_prompt_preserves_image_generation_calls_when_images_are_supported, for_prompt_preserves_inter_agent_assistant_messages, for_prompt_strips_images_when_model_does_not_support_images (+15 more)); 1 external calls (Tokens).


##### `user_msg`  (lines 76–86)

```
fn user_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a simple user message using output-text content. It is a compact test fixture for ordinary user turns.

**Data flow**: Text goes in → the helper wraps it as a user message item → a ResponseItem comes out.

**Call relations**: Filtering and token-count tests call this to add user content around assistant and tool-output items.

*Call graph*: called by 3 (filters_non_api_messages, items_after_last_model_generated_tokens_include_user_and_tool_output, total_token_usage_includes_all_items_after_last_model_generated_item); 1 external calls (vec!).


##### `user_input_text_msg`  (lines 88–98)

```
fn user_input_text_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a user message using input-text content, which is the form commonly sent into the model. Tests use it for real user turns and session-prefix items.

**Data flow**: Text goes in → it becomes one input-text content item inside a user message → a ResponseItem comes out.

**Call relations**: Rollback tests use this helper when building histories whose user turns, environment blocks, and instruction blocks must be distinguished.

*Call graph*: called by 1 (drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns); 1 external calls (vec!).


##### `developer_msg`  (lines 100–110)

```
fn developer_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a developer-role message for tests. Developer messages represent instructions from the application rather than the end user.

**Data flow**: Instruction text goes in → the helper wraps it as developer input text → a ResponseItem message comes out.

**Call relations**: It supports rollback tests that check whether context-update instructions are retained or removed with nearby turns.

*Call graph*: 1 external calls (vec!).


##### `developer_msg_with_fragments`  (lines 112–125)

```
fn developer_msg_with_fragments(texts: &[&str]) -> ResponseItem
```

**Purpose**: Builds a developer message made of several text fragments. This lets tests model a mixed bundle of instructions instead of one plain string.

**Data flow**: A slice of text fragments goes in → each fragment becomes an input-text content item → one developer ResponseItem comes out.

**Call relations**: The mixed developer-context rollback test uses this to check that bundled contextual instructions are treated carefully.


##### `reference_context_item`  (lines 127–148)

```
fn reference_context_item() -> TurnContextItem
```

**Purpose**: Creates a realistic reference context snapshot for rollback tests. This snapshot describes things like current directory, date, model, approval policy, and sandbox policy.

**Data flow**: No input is needed → the helper fills a TurnContextItem with stable test values → that context item comes out.

**Call relations**: Rollback tests set this on the history, then check whether dropping turns keeps or clears the reference context.

*Call graph*: called by 2 (drop_last_n_user_turns_clears_reference_context_for_mixed_developer_context_bundles, drop_last_n_user_turns_trims_context_updates_above_rolled_back_turn); 2 external calls (from, new_read_only_policy).


##### `custom_tool_call_output`  (lines 150–157)

```
fn custom_tool_call_output(call_id: &str, output: &str) -> ResponseItem
```

**Purpose**: Builds a custom tool output item with text content. Tests use it to check token accounting after model output.

**Data flow**: A call id and output text go in → the text is wrapped in a function-output payload → a CustomToolCallOutput item comes out.

**Call relations**: Token usage tests add this after assistant output to verify that fresh tool results are counted until the next model response.

*Call graph*: calls 1 internal fn (from_text); called by 2 (items_after_last_model_generated_tokens_include_user_and_tool_output, total_token_usage_includes_all_items_after_last_model_generated_item).


##### `reasoning_msg`  (lines 159–171)

```
fn reasoning_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a reasoning item with visible reasoning text and a summary. Tests use it to check which non-message items are retained.

**Data flow**: Reasoning text goes in → the helper creates a reasoning response with a fixed summary and that text → a ResponseItem comes out.

**Call relations**: The filtering test records this beside ignored items to confirm reasoning is kept in history.

*Call graph*: called by 1 (filters_non_api_messages); 2 external calls (new, vec!).


##### `reasoning_with_encrypted_content`  (lines 173–183)

```
fn reasoning_with_encrypted_content(len: usize) -> ResponseItem
```

**Purpose**: Builds a reasoning item that has encrypted content instead of visible reasoning text. Tests use it for reasoning-token estimates.

**Data flow**: A length goes in → the helper creates encrypted content made of repeated characters of that length → a reasoning ResponseItem comes out.

**Call relations**: Reasoning-token tests use these items around user messages to check what counts before the latest user turn.

*Call graph*: 2 external calls (new, vec!).


##### `truncate_exec_output`  (lines 185–187)

```
fn truncate_exec_output(content: &str) -> String
```

**Purpose**: Applies the same token-based truncation used for long execution output in tests. It keeps output small while preserving a truncation marker.

**Data flow**: A command-output string goes in → truncate_text shortens it to the configured token budget if needed → the possibly shortened string comes out.

**Call relations**: Execution-output tests call this, then use assertion helpers to check the marker, retained head and tail text, and removed-token count.

*Call graph*: called by 4 (format_exec_output_marks_byte_truncation_without_omitted_lines, format_exec_output_prefers_line_marker_when_both_limits_exceeded, format_exec_output_reports_omitted_lines_and_keeps_head_and_tail, format_exec_output_truncates_large_error); 2 external calls (truncate_text, Tokens).


##### `approx_token_count_for_text`  (lines 189–191)

```
fn approx_token_count_for_text(text: &str) -> i64
```

**Purpose**: Provides a simple estimate of token count from text length. A token is roughly a chunk of text the model counts for its context limit.

**Data flow**: Text goes in → its byte length is rounded up by groups of four → an integer estimate comes out.

**Call relations**: The base-instructions token-estimate test uses this helper to predict the expected difference between short and long instruction text.

*Call graph*: called by 1 (estimate_token_count_with_base_instructions_uses_provided_text); 1 external calls (try_from).


##### `filters_non_api_messages`  (lines 194–250)

```
fn filters_non_api_messages()
```

**Purpose**: Checks that the history ignores items that should not be sent as API messages, while keeping useful reasoning, user, and assistant items.

**Data flow**: The test records a system message, reasoning item, Other item, user message, and assistant message → it reads raw history → it expects only reasoning, user, and assistant items to remain.

**Call relations**: The Rust test runner calls this; it uses the message helpers to exercise ContextManager::record_items.

*Call graph*: calls 3 internal fn (assistant_msg, reasoning_msg, user_msg); 4 external calls (assert_eq!, default, Tokens, vec!).


##### `non_last_reasoning_tokens_return_zero_when_no_user_messages`  (lines 253–258)

```
fn non_last_reasoning_tokens_return_zero_when_no_user_messages()
```

**Purpose**: Checks that old reasoning-token accounting returns zero when there has not been any user message yet.

**Data flow**: A history containing only encrypted reasoning goes in → the token counter is queried → zero is expected.

**Call relations**: The test runner calls it; it sets up history through create_history_with_items and then checks get_non_last_reasoning_items_tokens.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `non_last_reasoning_tokens_ignore_entries_after_last_user`  (lines 261–273)

```
fn non_last_reasoning_tokens_ignore_entries_after_last_user()
```

**Purpose**: Checks that reasoning after the latest user turn is not counted as older reasoning. This avoids double-counting recent model work.

**Data flow**: A sequence of reasoning and user messages goes into history → the counter looks only before the last user boundary → the expected token total comes out.

**Call relations**: The test runner calls it; it relies on create_history_with_items to feed the ContextManager a controlled sequence.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `items_after_last_model_generated_tokens_include_user_and_tool_output`  (lines 276–294)

```
fn items_after_last_model_generated_tokens_include_user_and_tool_output()
```

**Purpose**: Checks that items added after the latest model-generated response include both user messages and tool outputs for local token estimates.

**Data flow**: A history with assistant output, then user text and tool output, is built → items after the assistant output are gathered and estimated → their sum must match the expected estimate.

**Call relations**: The test runner calls it; it combines user_msg and custom_tool_call_output with ContextManager::items_after_last_model_generated_item.

*Call graph*: calls 3 internal fn (create_history_with_items, custom_tool_call_output, user_msg); 2 external calls (assert_eq!, vec!).


##### `items_after_last_model_generated_tokens_are_zero_without_model_generated_items`  (lines 297–308)

```
fn items_after_last_model_generated_tokens_are_zero_without_model_generated_items()
```

**Purpose**: Checks that no tail-token estimate is added before the model has produced anything. Without a model-generated marker, there is no previous API total to extend.

**Data flow**: A history with only a user message is built → items after the last model-generated item are requested → the estimated sum is zero.

**Call relations**: The test runner calls it; create_history_with_items supplies the single-message history.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `inter_agent_assistant_messages_are_turn_boundaries`  (lines 311–315)

```
fn inter_agent_assistant_messages_are_turn_boundaries()
```

**Purpose**: Checks that modern structured inter-agent assistant messages count as turn boundaries. This matters when one agent triggers another agent’s turn.

**Data flow**: A structured inter-agent assistant message is built → is_user_turn_boundary examines it → true is expected.

**Call relations**: The test runner calls it; it depends on inter_agent_assistant_msg to produce the exact structured message format.

*Call graph*: calls 1 internal fn (inter_agent_assistant_msg); 1 external calls (assert!).


##### `for_prompt_preserves_inter_agent_assistant_messages`  (lines 318–324)

```
fn for_prompt_preserves_inter_agent_assistant_messages()
```

**Purpose**: Checks that structured inter-agent assistant messages are not lost when preparing the prompt. They carry instructions between agents.

**Data flow**: An inter-agent item goes into history → raw_items and for_prompt are read → both should contain the same item.

**Call relations**: The test runner calls it; it uses create_history_with_items and then exercises ContextManager::for_prompt.

*Call graph*: calls 2 internal fn (create_history_with_items, inter_agent_assistant_msg); 2 external calls (assert_eq!, vec!).


##### `drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns`  (lines 327–342)

```
fn drop_last_n_user_turns_treats_inter_agent_assistant_messages_as_instruction_turns()
```

**Purpose**: Checks rollback behavior when an inter-agent assistant message starts a worker turn. Dropping one user-like turn should remove that worker turn but keep earlier conversation.

**Data flow**: A normal turn plus an inter-agent-triggered turn go into history → one user turn is dropped → only the first turn remains.

**Call relations**: The test runner calls it; it uses assistant_msg, user_input_text_msg, and inter_agent_assistant_msg to build the scenario.

*Call graph*: calls 4 internal fn (assistant_msg, create_history_with_items, inter_agent_assistant_msg, user_input_text_msg); 2 external calls (assert_eq!, vec!).


##### `legacy_inter_agent_assistant_messages_are_not_turn_boundaries`  (lines 345–351)

```
fn legacy_inter_agent_assistant_messages_are_not_turn_boundaries()
```

**Purpose**: Checks that old plain-text inter-agent-looking messages are not mistaken for modern structured turn boundaries.

**Data flow**: A legacy formatted assistant string goes into is_user_turn_boundary → the result should be false.

**Call relations**: The test runner calls it; assistant_msg supplies the legacy-looking text without the structured JSON wrapper.

*Call graph*: calls 1 internal fn (assistant_msg); 1 external calls (assert!).


##### `total_token_usage_includes_all_items_after_last_model_generated_item`  (lines 354–375)

```
fn total_token_usage_includes_all_items_after_last_model_generated_item()
```

**Purpose**: Checks that total token usage combines the server-reported total with locally estimated items added afterward.

**Data flow**: A history starts with counted assistant output and server token usage → user and tool output are recorded later → total usage should equal server total plus those new estimates.

**Call relations**: The test runner calls it; it uses create_history_with_items, user_msg, and custom_tool_call_output before querying ContextManager::get_total_token_usage.

*Call graph*: calls 3 internal fn (create_history_with_items, custom_tool_call_output, user_msg); 4 external calls (default, assert_eq!, Tokens, vec!).


##### `for_prompt_strips_images_when_model_does_not_support_images`  (lines 378–536)

```
fn for_prompt_strips_images_when_model_does_not_support_images()
```

**Purpose**: Checks that image content is replaced with clear text placeholders for text-only models, while image-capable models keep images.

**Data flow**: Messages and tool outputs containing images go into history → for_prompt is called with text-only modalities → image parts become explanatory text; with image modalities they remain images.

**Call relations**: The test runner calls it; it uses create_history_with_items and default_input_modalities to compare unsupported and supported model behavior.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 4 external calls (assert!, assert_eq!, panic!, vec!).


##### `for_prompt_preserves_image_generation_calls_when_images_are_supported`  (lines 539–580)

```
fn for_prompt_preserves_image_generation_calls_when_images_are_supported()
```

**Purpose**: Checks that image generation results remain in the prompt when the model supports image input.

**Data flow**: An image-generation call and user message go into history → for_prompt runs with default image-capable modalities → the image-generation call is preserved unchanged.

**Call relations**: The test runner calls it; create_history_with_items supplies the history under test.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `for_prompt_clears_image_generation_result_when_images_are_unsupported`  (lines 583–624)

```
fn for_prompt_clears_image_generation_result_when_images_are_unsupported()
```

**Purpose**: Checks that a text-only model does not receive raw generated image data. The call metadata stays, but the image result is cleared.

**Data flow**: A user request and completed image-generation call go into history → for_prompt runs with text-only input → the result field becomes an empty string.

**Call relations**: The test runner calls it; it verifies ContextManager::for_prompt’s image-safety behavior.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `estimate_token_count_with_base_instructions_uses_provided_text`  (lines 627–646)

```
fn estimate_token_count_with_base_instructions_uses_provided_text()
```

**Purpose**: Checks that token estimates include the actual base instruction text supplied by the caller.

**Data flow**: The same history is estimated once with short base instructions and once with long ones → the difference is compared with the helper’s text-token estimate.

**Call relations**: The test runner calls it; it uses approx_token_count_for_text to calculate the expected change.

*Call graph*: calls 2 internal fn (approx_token_count_for_text, create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `remove_first_item_removes_matching_output_for_function_call`  (lines 649–668)

```
fn remove_first_item_removes_matching_output_for_function_call()
```

**Purpose**: Checks that removing a function call also removes its matching output. A tool call without its answer would leave history inconsistent.

**Data flow**: A function call followed by its output goes into history → remove_first_item is called → both items are gone.

**Call relations**: The test runner calls it; create_history_with_items sets up the paired call and output.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `remove_first_item_removes_matching_call_for_output`  (lines 671–690)

```
fn remove_first_item_removes_matching_call_for_output()
```

**Purpose**: Checks the reverse pairing rule: if the first item is a function output, its matching call is removed too.

**Data flow**: An output followed by its matching call goes into history → remove_first_item runs → history becomes empty.

**Call relations**: The test runner calls it; this protects bidirectional cleanup in ContextManager::remove_first_item.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `replace_last_turn_images_replaces_tool_output_images`  (lines 693–732)

```
fn replace_last_turn_images_replaces_tool_output_images()
```

**Purpose**: Checks that invalid images in the latest tool output can be replaced with text. This prevents repeatedly sending broken image data.

**Data flow**: A user turn and tool output containing an image go into history → replace_last_turn_images runs with replacement text → the tool image becomes text and the function returns true.

**Call relations**: The test runner calls it; it exercises image replacement on FunctionCallOutput content.

*Call graph*: calls 1 internal fn (create_history_with_items); 3 external calls (assert!, assert_eq!, vec!).


##### `replace_last_turn_images_does_not_touch_user_images`  (lines 735–750)

```
fn replace_last_turn_images_does_not_touch_user_images()
```

**Purpose**: Checks that the replacement routine does not modify images originally provided by the user.

**Data flow**: A user image goes into history → replace_last_turn_images is called → it returns false and the history stays unchanged.

**Call relations**: The test runner calls it; it guards the boundary between user-provided content and generated tool-output content.

*Call graph*: calls 1 internal fn (create_history_with_items); 3 external calls (assert!, assert_eq!, vec!).


##### `remove_first_item_handles_local_shell_pair`  (lines 753–777)

```
fn remove_first_item_handles_local_shell_pair()
```

**Purpose**: Checks that local shell calls are cleaned up together with their output. A shell command and its result are another form of call-and-answer pair.

**Data flow**: A local shell call and matching function output go into history → remove_first_item runs → both are removed.

**Call relations**: The test runner calls it; create_history_with_items builds the shell-call pair.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `drop_last_n_user_turns_preserves_prefix`  (lines 780–813)

```
fn drop_last_n_user_turns_preserves_prefix()
```

**Purpose**: Checks that rollback removes recent user turns but keeps session-prefix material that came before the first real user turn.

**Data flow**: A prefix assistant item and two turns go into history → dropping one or many turns removes only real turns after the prefix → the expected prefix or earlier turn remains.

**Call relations**: The test runner calls it; it prepares history and reads it back through for_prompt.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `drop_last_n_user_turns_ignores_session_prefix_user_messages`  (lines 816–913)

```
fn drop_last_n_user_turns_ignores_session_prefix_user_messages()
```

**Purpose**: Checks that setup-style user messages, such as environment context and instruction blocks, are not counted as user turns during rollback.

**Data flow**: Several prefix user messages and two real turns go into history → one, two, or three turns are dropped → prefix messages remain and only real turns are removed.

**Call relations**: The test runner calls it; it uses create_history_with_items and default_input_modalities to inspect the final prompt.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `drop_last_n_user_turns_trims_context_updates_above_rolled_back_turn`  (lines 916–951)

```
fn drop_last_n_user_turns_trims_context_updates_above_rolled_back_turn()
```

**Purpose**: Checks that context updates attached to a rolled-back turn are removed, while older persistent developer instructions can remain.

**Data flow**: A history with an old turn, developer instruction, context-diff messages, and a later turn is built → one turn is dropped → the old turn and safe developer instruction remain.

**Call relations**: The test runner calls it; reference_context_item is used to verify the stored reference context is still retained.

*Call graph*: calls 3 internal fn (create_history_with_items, reference_context_item, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `drop_last_n_user_turns_clears_reference_context_for_mixed_developer_context_bundles`  (lines 954–982)

```
fn drop_last_n_user_turns_clears_reference_context_for_mixed_developer_context_bundles()
```

**Purpose**: Checks a conservative rollback case where contextual and persistent developer instructions are bundled together. Because the bundle is mixed, the reference context is cleared.

**Data flow**: A history with a mixed developer message, context update, and later turn is built → one turn is dropped → the mixed bundle is removed and reference context becomes none.

**Call relations**: The test runner calls it; it uses developer_msg_with_fragments indirectly through the scenario and reference_context_item for the stored context.

*Call graph*: calls 3 internal fn (create_history_with_items, reference_context_item, default_input_modalities); 3 external calls (assert!, assert_eq!, vec!).


##### `remove_first_item_handles_custom_tool_pair`  (lines 985–1005)

```
fn remove_first_item_handles_custom_tool_pair()
```

**Purpose**: Checks that custom tool calls and their outputs are removed as a pair.

**Data flow**: A custom tool call and matching output go into history → remove_first_item runs → history becomes empty.

**Call relations**: The test runner calls it; it covers the custom-tool version of the call-and-answer cleanup rule.

*Call graph*: calls 1 internal fn (create_history_with_items); 2 external calls (assert_eq!, vec!).


##### `normalization_retains_local_shell_outputs`  (lines 1008–1034)

```
fn normalization_retains_local_shell_outputs()
```

**Purpose**: Checks that normalization does not accidentally discard valid local shell outputs.

**Data flow**: A completed shell call and matching output go into history → for_prompt normalizes the prompt view → the same items come back.

**Call relations**: The test runner calls it; create_history_with_items and default_input_modalities prepare the prompt check.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `record_items_truncates_function_call_output_content`  (lines 1037–1074)

```
fn record_items_truncates_function_call_output_content()
```

**Purpose**: Checks that very long function-call output is shortened when recorded. This prevents tool output from filling the model’s context window.

**Data flow**: A huge function output goes into record_items with a small token budget → stored output is shorter and includes a truncation marker → metadata such as turn id is preserved.

**Call relations**: The test runner calls it; it directly creates a ContextManager and tests ContextManager::record_items.

*Call graph*: calls 1 internal fn (new); 6 external calls (assert!, assert_eq!, assert_ne!, panic!, Text, Tokens).


##### `record_items_truncates_custom_tool_call_output_content`  (lines 1077–1107)

```
fn record_items_truncates_custom_tool_call_output_content()
```

**Purpose**: Checks that custom tool outputs get the same truncation treatment as standard function outputs.

**Data flow**: A huge custom tool output is recorded → the stored text differs from the original and contains a truncation marker → the item remains a custom tool output.

**Call relations**: The test runner calls it; it uses FunctionCallOutputPayload::from_text while exercising record_items.

*Call graph*: calls 2 internal fn (new, from_text); 5 external calls (assert!, assert_eq!, assert_ne!, panic!, Tokens).


##### `record_items_respects_custom_token_limit`  (lines 1110–1134)

```
fn record_items_respects_custom_token_limit()
```

**Purpose**: Checks that the caller’s token limit is honored during output truncation.

**Data flow**: A long function output and a very small token policy go into record_items → the stored output contains a token-truncation marker.

**Call relations**: The test runner calls it; it directly verifies ContextManager::record_items with a custom TruncationPolicy.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, panic!, Text, Tokens).


##### `assert_truncated_message_matches`  (lines 1136–1160)

```
fn assert_truncated_message_matches(message: &str, line: &str, expected_removed: usize)
```

**Purpose**: Asserts that a truncated output string has the expected shape and removed-token count. It keeps the truncation tests readable.

**Data flow**: A message, expected starting line, and expected removed count go in → a regular expression extracts the kept body and removed count → assertions confirm size and count.

**Call relations**: Execution-output tests call this after truncate_exec_output; it delegates pattern construction to truncated_message_pattern.

*Call graph*: calls 1 internal fn (truncated_message_pattern); called by 4 (format_exec_output_marks_byte_truncation_without_omitted_lines, format_exec_output_prefers_line_marker_when_both_limits_exceeded, format_exec_output_reports_omitted_lines_and_keeps_head_and_tail, format_exec_output_truncates_large_error); 3 external calls (new, assert!, assert_eq!).


##### `truncated_message_pattern`  (lines 1162–1165)

```
fn truncated_message_pattern(line: &str) -> String
```

**Purpose**: Builds the regular expression used to recognize a truncation marker. It escapes the expected line so test text is treated literally.

**Data flow**: An expected line prefix goes in → it is escaped and inserted into a pattern with named body and removed-count captures → the pattern string comes out.

**Call relations**: assert_truncated_message_matches calls this before compiling the regular expression.

*Call graph*: called by 1 (assert_truncated_message_matches); 2 external calls (format!, escape).


##### `format_exec_output_truncates_large_error`  (lines 1168–1176)

```
fn format_exec_output_truncates_large_error()
```

**Purpose**: Checks that very large error output is shortened and reports the expected number of removed tokens.

**Data flow**: A repeated long error string is passed through truncate_exec_output → the result is compared with the original and checked against the truncation pattern.

**Call relations**: The test runner calls it; it uses assert_truncated_message_matches for the detailed checks.

*Call graph*: calls 2 internal fn (assert_truncated_message_matches, truncate_exec_output); 1 external calls (assert_ne!).


##### `format_exec_output_marks_byte_truncation_without_omitted_lines`  (lines 1179–1188)

```
fn format_exec_output_marks_byte_truncation_without_omitted_lines()
```

**Purpose**: Checks that one extremely long line is truncated without claiming that whole lines were omitted.

**Data flow**: A single overlarge line goes into truncate_exec_output → the shortened result is checked for a token marker and absence of an omitted-lines marker.

**Call relations**: The test runner calls it; assert_truncated_message_matches verifies the common truncation format.

*Call graph*: calls 2 internal fn (assert_truncated_message_matches, truncate_exec_output); 2 external calls (assert!, assert_ne!).


##### `format_exec_output_returns_original_when_within_limits`  (lines 1191–1194)

```
fn format_exec_output_returns_original_when_within_limits()
```

**Purpose**: Checks that small command output is not changed. Truncation should only happen when needed.

**Data flow**: A short repeated output string is prepared → truncation behavior is checked by comparing expected original text with the result.

**Call relations**: The test runner calls it; this is the non-truncating counterpart to the large-output tests.

*Call graph*: 1 external calls (assert_eq!).


##### `format_exec_output_reports_omitted_lines_and_keeps_head_and_tail`  (lines 1197–1216)

```
fn format_exec_output_reports_omitted_lines_and_keeps_head_and_tail()
```

**Purpose**: Checks that long multi-line output keeps useful beginning and ending context while marking that content was removed.

**Data flow**: Many generated lines go into truncate_exec_output → the result is checked for the first line, last line, and expected truncation marker.

**Call relations**: The test runner calls it; it uses assert_truncated_message_matches to validate the marker and count.

*Call graph*: calls 2 internal fn (assert_truncated_message_matches, truncate_exec_output); 2 external calls (assert!, format!).


##### `format_exec_output_prefers_line_marker_when_both_limits_exceeded`  (lines 1219–1229)

```
fn format_exec_output_prefers_line_marker_when_both_limits_exceeded()
```

**Purpose**: Checks the marker choice when both line count and byte size are too large. The test expects the line-oriented truncation path to win.

**Data flow**: Many long lines go into truncate_exec_output → the truncated string is checked against the expected removed-token count.

**Call relations**: The test runner calls it; assert_truncated_message_matches performs the final validation.

*Call graph*: calls 2 internal fn (assert_truncated_message_matches, truncate_exec_output).


##### `normalize_adds_missing_output_for_function_call`  (lines 1233–1264)

```
fn normalize_adds_missing_output_for_function_call()
```

**Purpose**: Checks release-build normalization for a function call missing its output. The history should be repaired by adding an aborted output.

**Data flow**: A lone function call goes into history → normalize_history runs → a matching FunctionCallOutput with text "aborted" is inserted.

**Call relations**: The test runner calls it only in non-debug builds; it uses create_history_with_items and default_input_modalities.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_adds_missing_output_for_custom_tool_call`  (lines 1268–1300)

```
fn normalize_adds_missing_output_for_custom_tool_call()
```

**Purpose**: Checks release-build normalization for a custom tool call missing its output.

**Data flow**: A lone custom tool call goes into history → normalize_history runs → a matching CustomToolCallOutput with "aborted" is inserted.

**Call relations**: The test runner calls it in non-debug builds; it covers repair behavior for custom tools.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_adds_missing_output_for_local_shell_call_with_id`  (lines 1304–1345)

```
fn normalize_adds_missing_output_for_local_shell_call_with_id()
```

**Purpose**: Checks release-build normalization for a local shell call that has a call id but no output.

**Data flow**: A lone shell call goes into history → normalize_history runs → a matching function output marked "aborted" is added.

**Call relations**: The test runner calls it in non-debug builds; it covers shell calls as another call/output pair.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_removes_orphan_function_call_output`  (lines 1349–1360)

```
fn normalize_removes_orphan_function_call_output()
```

**Purpose**: Checks release-build normalization for a function output that has no matching call.

**Data flow**: An orphan function output goes into history → normalize_history runs → the orphan is removed.

**Call relations**: The test runner calls it in non-debug builds; it verifies cleanup of unmatched outputs.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_removes_orphan_custom_tool_call_output`  (lines 1364–1376)

```
fn normalize_removes_orphan_custom_tool_call_output()
```

**Purpose**: Checks release-build normalization for a custom tool output without a matching custom tool call.

**Data flow**: An orphan custom tool output goes into history → normalize_history runs → history becomes empty.

**Call relations**: The test runner calls it in non-debug builds; it is the custom-tool counterpart to orphan function-output cleanup.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_mixed_inserts_and_removals`  (lines 1380–1475)

```
fn normalize_mixed_inserts_and_removals()
```

**Purpose**: Checks that normalization can repair several problems in one history: missing outputs are inserted and orphan outputs are removed.

**Data flow**: A mixed sequence of incomplete calls and orphan output goes into history → normalize_history runs → the final history contains repaired call/output pairs only.

**Call relations**: The test runner calls it in non-debug builds; it exercises the normalization pass as a whole.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_adds_missing_output_for_function_call_inserts_output`  (lines 1478–1507)

```
fn normalize_adds_missing_output_for_function_call_inserts_output()
```

**Purpose**: Checks that a missing standard function-call output is inserted. This version runs regardless of debug configuration.

**Data flow**: A single function call goes into history → normalize_history runs → a matching aborted output appears after it.

**Call relations**: The test runner calls it; it confirms the standard function-call repair path.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_adds_missing_output_for_tool_search_call`  (lines 1510–1543)

```
fn normalize_adds_missing_output_for_tool_search_call()
```

**Purpose**: Checks that a client-side tool search call missing its output is repaired with an empty completed search output.

**Data flow**: A ToolSearchCall with a call id goes into history → normalize_history runs → a ToolSearchOutput with matching id, completed status, client execution, and no tools is inserted.

**Call relations**: The test runner calls it; it extends call/output normalization to tool search.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_adds_missing_output_for_custom_tool_call_panics_in_debug`  (lines 1548–1559)

```
fn normalize_adds_missing_output_for_custom_tool_call_panics_in_debug()
```

**Purpose**: Checks that debug builds panic when a custom tool call is missing its output. Debug mode catches developer mistakes loudly instead of silently repairing them.

**Data flow**: A lone custom tool call goes into history → normalize_history is called → the test expects a panic.

**Call relations**: The test runner calls it only in debug builds; it uses create_history_with_items for setup.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `normalize_adds_missing_output_for_local_shell_call_with_id_panics_in_debug`  (lines 1564–1580)

```
fn normalize_adds_missing_output_for_local_shell_call_with_id_panics_in_debug()
```

**Purpose**: Checks that debug builds panic when a local shell call with an id lacks an output.

**Data flow**: A lone shell call goes into history → normalize_history runs → the expected result is a panic.

**Call relations**: The test runner calls it in debug builds; it protects the shell-call pairing invariant during development.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `normalize_removes_orphan_function_call_output_panics_in_debug`  (lines 1585–1593)

```
fn normalize_removes_orphan_function_call_output_panics_in_debug()
```

**Purpose**: Checks that debug builds panic on an orphan function output.

**Data flow**: An unmatched function output goes into history → normalize_history is called → the test expects a panic.

**Call relations**: The test runner calls it in debug builds; it catches broken call/output ordering early.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `normalize_removes_orphan_custom_tool_call_output_panics_in_debug`  (lines 1598–1607)

```
fn normalize_removes_orphan_custom_tool_call_output_panics_in_debug()
```

**Purpose**: Checks that debug builds panic on an orphan custom tool output.

**Data flow**: An unmatched custom tool output goes into history → normalize_history is called → a panic is expected.

**Call relations**: The test runner calls it in debug builds; it mirrors the standard function-output panic case.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `normalize_removes_orphan_client_tool_search_output`  (lines 1611–1624)

```
fn normalize_removes_orphan_client_tool_search_output()
```

**Purpose**: Checks release-build cleanup of a client tool-search output that has no matching search call.

**Data flow**: An orphan client ToolSearchOutput goes into history → normalize_history runs → it is removed.

**Call relations**: The test runner calls it in non-debug builds; it covers orphan cleanup for client-side search.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_removes_orphan_client_tool_search_output_panics_in_debug`  (lines 1629–1639)

```
fn normalize_removes_orphan_client_tool_search_output_panics_in_debug()
```

**Purpose**: Checks that debug builds panic on an orphan client tool-search output.

**Data flow**: An unmatched client ToolSearchOutput goes into history → normalize_history is called → the test expects a panic.

**Call relations**: The test runner calls it in debug builds; it is the debug counterpart of release cleanup.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `normalize_keeps_server_tool_search_output_without_matching_call`  (lines 1642–1664)

```
fn normalize_keeps_server_tool_search_output_without_matching_call()
```

**Purpose**: Checks that server-side tool-search output can stand alone. Server execution may produce outputs without a local client call.

**Data flow**: A server ToolSearchOutput without a matching call goes into history → normalize_history runs → the output remains unchanged.

**Call relations**: The test runner calls it; it verifies that normalization treats server and client tool-search outputs differently.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 2 external calls (assert_eq!, vec!).


##### `normalize_mixed_inserts_and_removals_panics_in_debug`  (lines 1669–1708)

```
fn normalize_mixed_inserts_and_removals_panics_in_debug()
```

**Purpose**: Checks that debug builds panic on a history containing multiple normalization problems.

**Data flow**: A mixed broken history goes into ContextManager → normalize_history is called → the expected result is a panic.

**Call relations**: The test runner calls it in debug builds; it is the debug counterpart of the mixed repair test.

*Call graph*: calls 2 internal fn (create_history_with_items, default_input_modalities); 1 external calls (vec!).


##### `image_data_url_payload_does_not_dominate_message_estimate`  (lines 1711–1747)

```
fn image_data_url_payload_does_not_dominate_message_estimate()
```

**Purpose**: Checks that huge inline base64 image data in a user message is estimated as a fixed resized-image cost instead of raw string size.

**Data flow**: A message with a large data URL is serialized and estimated → the estimate subtracts the payload and adds a fixed image cost → it is smaller than raw JSON but larger than text-only.

**Call relations**: The test runner calls it; it directly tests estimate_response_item_model_visible_bytes.

*Call graph*: 5 external calls (assert!, assert_eq!, format!, to_string, vec!).


##### `image_data_url_payload_does_not_dominate_function_call_output_estimate`  (lines 1750–1773)

```
fn image_data_url_payload_does_not_dominate_function_call_output_estimate()
```

**Purpose**: Checks the same inline-image estimate rule for standard function-call outputs.

**Data flow**: A function output with text plus a large base64 image goes in → raw JSON length and model-visible estimate are compared → the payload is replaced by fixed image cost.

**Call relations**: The test runner calls it; FunctionCallOutputPayload::from_content_items builds the image-bearing output.

*Call graph*: calls 1 internal fn (from_content_items); 5 external calls (assert!, assert_eq!, format!, to_string, vec!).


##### `image_data_url_payload_does_not_dominate_custom_tool_call_output_estimate`  (lines 1776–1800)

```
fn image_data_url_payload_does_not_dominate_custom_tool_call_output_estimate()
```

**Purpose**: Checks that custom tool outputs also avoid counting huge inline image payloads at full size.

**Data flow**: A custom tool output with a large data URL is estimated → the raw payload length is replaced with a fixed image estimate → the estimate is below raw JSON length.

**Call relations**: The test runner calls it; it covers the custom-tool output variant of image estimation.

*Call graph*: calls 1 internal fn (from_content_items); 5 external calls (assert!, assert_eq!, format!, to_string, vec!).


##### `non_base64_image_urls_are_unchanged`  (lines 1803–1833)

```
fn non_base64_image_urls_are_unchanged()
```

**Purpose**: Checks that ordinary image URLs, such as web or file URLs, are not adjusted by the inline base64-image heuristic.

**Data flow**: Message and function-output items with non-base64 image URLs are estimated → each estimate equals its serialized JSON length.

**Call relations**: The test runner calls it; it verifies the estimator only special-cases inline base64 image data.

*Call graph*: calls 1 internal fn (from_content_items); 2 external calls (assert_eq!, vec!).


##### `encrypted_function_output_uses_plaintext_byte_estimate`  (lines 1836–1854)

```
fn encrypted_function_output_uses_plaintext_byte_estimate()
```

**Purpose**: Checks that encrypted function output is estimated as its expected plaintext size, not just its encrypted string length.

**Data flow**: An encrypted-content output is serialized and estimated → the encrypted text length is replaced with estimate_encrypted_function_output_length → the expected estimate must match.

**Call relations**: The test runner calls it; it validates estimate_response_item_model_visible_bytes for encrypted content items.

*Call graph*: calls 1 internal fn (from_content_items); 3 external calls (assert_eq!, to_string, vec!).


##### `data_url_without_base64_marker_is_unchanged`  (lines 1857–1873)

```
fn data_url_without_base64_marker_is_unchanged()
```

**Purpose**: Checks that a data URL without a base64 marker is left alone by the estimator.

**Data flow**: A message containing a non-base64 SVG data URL is estimated → the estimate equals the raw serialized length.

**Call relations**: The test runner calls it; it prevents over-broad data URL handling.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `non_image_base64_data_url_is_unchanged`  (lines 1876–1894)

```
fn non_image_base64_data_url_is_unchanged()
```

**Purpose**: Checks that base64 data URLs are only adjusted when they are images.

**Data flow**: A function output contains a base64 application/octet-stream URL → the estimator runs → the raw serialized length is kept.

**Call relations**: The test runner calls it; it guards the media-type check inside image estimation.

*Call graph*: calls 1 internal fn (from_content_items); 4 external calls (assert_eq!, format!, to_string, vec!).


##### `mixed_case_data_url_markers_are_adjusted`  (lines 1897–1916)

```
fn mixed_case_data_url_markers_are_adjusted()
```

**Purpose**: Checks that inline image detection is case-insensitive. Real data URLs may use uppercase or mixed-case markers.

**Data flow**: A message with DATA:image/png;BASE64 is estimated → the payload is replaced with fixed image cost → the expected adjusted estimate is returned.

**Call relations**: The test runner calls it; it validates robust parsing in estimate_response_item_model_visible_bytes.

*Call graph*: 4 external calls (assert_eq!, format!, to_string, vec!).


##### `multiple_inline_images_apply_multiple_fixed_costs`  (lines 1919–1950)

```
fn multiple_inline_images_apply_multiple_fixed_costs()
```

**Purpose**: Checks that each inline image contributes its own fixed cost. Multiple images should not be collapsed into one estimate.

**Data flow**: A message with two base64 image URLs is serialized and estimated → both payload lengths are subtracted and two fixed costs are added.

**Call relations**: The test runner calls it; it tests repeated application of the image-estimation rule.

*Call graph*: 4 external calls (assert_eq!, format!, to_string, vec!).


##### `original_detail_images_scale_with_dimensions`  (lines 1953–1983)

```
fn original_detail_images_scale_with_dimensions()
```

**Purpose**: Checks that original-detail images are estimated from their pixel dimensions. Original detail means the model may inspect the image more closely.

**Data flow**: A generated PNG with known width and height is encoded as a data URL → the estimator replaces the payload with a patch-based byte cost → the expected cost is checked.

**Call relations**: The test runner calls it; image creation helpers produce a real PNG so dimension reading is exercised.

*Call graph*: calls 2 internal fn (from_content_items, new); 7 external calls (from_pixel, new, assert_eq!, format!, Rgba, to_string, vec!).


##### `original_detail_images_are_capped_at_max_patch_count`  (lines 1986–2016)

```
fn original_detail_images_are_capped_at_max_patch_count()
```

**Purpose**: Checks that very large original-detail images have a maximum estimate. This prevents huge dimensions from creating unbounded token estimates.

**Data flow**: A very large generated PNG is encoded and estimated → patch count would exceed the cap → the capped byte cost is used.

**Call relations**: The test runner calls it; it verifies the ORIGINAL_IMAGE_MAX_PATCHES limit through estimate_response_item_model_visible_bytes.

*Call graph*: calls 2 internal fn (from_content_items, new); 8 external calls (from_pixel, new, assert_eq!, format!, try_from, Luma, to_string, vec!).


##### `original_detail_webp_images_scale_with_dimensions`  (lines 2019–2048)

```
fn original_detail_webp_images_scale_with_dimensions()
```

**Purpose**: Checks that WebP images use the same dimension-based estimate as PNG images for original detail.

**Data flow**: A WebP image with known dimensions is encoded as base64 → the estimator reads its dimensions and applies the patch-based cost → the expected estimate is returned.

**Call relations**: The test runner calls it; it ensures dimension-aware estimation is not PNG-only.

*Call graph*: calls 2 internal fn (from_content_items, new); 7 external calls (from_pixel, new, assert_eq!, format!, Rgba, to_string, vec!).


##### `text_only_items_unchanged`  (lines 2051–2066)

```
fn text_only_items_unchanged()
```

**Purpose**: Checks that plain text items are estimated by their serialized size without image-specific adjustments.

**Data flow**: An assistant text message is serialized and estimated → both lengths are compared → they are equal.

**Call relations**: The test runner calls it; it is the baseline case for estimate_response_item_model_visible_bytes.

*Call graph*: 3 external calls (assert_eq!, to_string, vec!).


### `core/src/event_mapping_tests.rs`

`test` · `test run`

This is a test file for the event-mapping code. That code sits between low-level model/protocol messages and the cleaner “turn items” the rest of the app can display or reason about. In everyday terms, it is like a mailroom sorter: it receives many kinds of envelopes, throws away internal routing slips, and passes the real message to the right tray.

The tests build sample `ResponseItem` values, which are raw events coming from the protocol layer, then call `parse_turn_item` to see what visible `TurnItem` comes out. They cover normal user messages with text and images, assistant messages, reasoning summaries, hook prompts, and web-search calls. They also check that invisible context is not shown as if the user typed it. Examples include AGENTS.md instructions, environment context, token budgets, skill instructions, internal model context, and image label tags around uploaded local images.

This matters because the user interface and conversation history must show the human-readable conversation, not the hidden scaffolding used to steer the model. Without these tests, internal instructions could leak into the visible timeline, image uploads could appear with ugly wrapper tags, or important events like hook prompts and web searches could be lost or displayed incorrectly.

#### Function details

##### `recognizes_skills_instructions_as_contextual_developer_content`  (lines 23–29)

```
fn recognizes_skills_instructions_as_contextual_developer_content()
```

**Purpose**: Checks that a developer message starting with the skills-instructions marker is treated as contextual support text, not as ordinary visible developer content.

**Data flow**: It creates a small list containing one text content item with the skills instructions opening tag. That list is given to the contextual-content checker, and the test expects the answer to be true.

**Call relations**: During the test run, this calls the contextual developer-content detector directly and uses an assertion to lock in the rule that skills instructions belong to hidden context.

*Call graph*: 1 external calls (assert!).


##### `recognizes_token_budget_as_contextual_developer_content`  (lines 32–40)

```
fn recognizes_token_budget_as_contextual_developer_content()
```

**Purpose**: Checks that token budget messages are classified as hidden context and not as meaningful developer text. A token budget is a note about how much room is left in the model’s context window.

**Data flow**: It builds one text content item containing a `<token_budget>` block. The test passes that content to both the contextual-content checker and the non-contextual-content checker, expecting the first to say yes and the second to say no.

**Call relations**: This test exercises the two classification helpers together, making sure they agree that token-budget bookkeeping should be filtered away from visible conversation content.

*Call graph*: 2 external calls (assert!, vec!).


##### `parses_user_message_with_text_and_two_images`  (lines 43–89)

```
fn parses_user_message_with_text_and_two_images()
```

**Purpose**: Checks that a normal user message containing text plus two image attachments becomes one user turn with all three pieces preserved in order.

**Data flow**: It starts with a raw user `ResponseItem` containing one text item and two image items. It sends that through `parse_turn_item`, then compares the resulting user message content with the expected text and image entries.

**Call relations**: This is a direct example of the main event-mapping path: a raw protocol message is handed to `parse_turn_item`, and the test verifies that the returned `TurnItem::UserMessage` keeps the user’s real input intact.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `skips_local_image_label_text`  (lines 92–135)

```
fn skips_local_image_label_text()
```

**Purpose**: Checks that helper text wrapped around a local image upload is removed, while the image itself and the user’s real words remain visible.

**Data flow**: It builds a user message with an opening image label, an image data URL, a closing image tag, and a normal text request. After parsing, the expected result contains only the image and the real user text.

**Call relations**: This test calls `parse_turn_item` to confirm that the mapper cleans up local-image wrapper text before producing the user-facing turn item.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `parses_assistant_message_input_text_for_backward_compatibility`  (lines 138–172)

```
fn parses_assistant_message_input_text_for_backward_compatibility()
```

**Purpose**: Checks that older assistant messages stored as input text are still understood as assistant messages. This protects conversations or logs produced by earlier versions of the system.

**Data flow**: It creates a raw assistant message whose content uses `InputText` instead of the newer output-text shape. Parsing should still produce an agent message containing exactly that text.

**Call relations**: This test sends the legacy-shaped message through `parse_turn_item` and verifies that compatibility logic still hands back a `TurnItem::AgentMessage` rather than dropping or misclassifying it.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `skips_unnamed_image_label_text`  (lines 175–218)

```
fn skips_unnamed_image_label_text()
```

**Purpose**: Checks the same image-wrapper cleanup as the local image test, but for the standard unnamed image tags produced by the protocol helpers.

**Data flow**: It asks the protocol model helpers for the standard image open and close tag text, places those around an image, and adds real user text afterward. After parsing, only the image and real text should remain.

**Call relations**: This test combines the protocol helper for image tag text with `parse_turn_item`, making sure the mapper recognizes and hides those generated tags in the final user turn.

*Call graph*: calls 1 internal fn (image_open_tag_text); 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `skips_user_instructions_and_env`  (lines 221–285)

```
fn skips_user_instructions_and_env()
```

**Purpose**: Checks that several kinds of hidden user-context messages do not become visible conversation turns. These include AGENTS.md instructions, environment context, skill definitions, and shell-command context.

**Data flow**: It builds a list of raw user messages whose text is only internal context. Each item is passed to `parse_turn_item`, and the expected result is no visible turn item at all.

**Call relations**: This test repeatedly calls the parser with context-only messages. It protects the larger display flow by proving that internal setup material is filtered before it reaches the conversation timeline.

*Call graph*: 3 external calls (assert!, parse_turn_item, vec!).


##### `parses_hook_prompt_message_as_distinct_turn_item`  (lines 288–310)

```
fn parses_hook_prompt_message_as_distinct_turn_item()
```

**Purpose**: Checks that a hook prompt is recognized as its own kind of turn item. A hook prompt is text produced by an automated hook, not a normal user message.

**Data flow**: It builds a hook prompt message from one hook fragment containing prompt text and a hook run ID. After parsing, the result should be a hook-prompt turn with exactly that fragment.

**Call relations**: The test uses the hook-prompt builder to create realistic protocol input, then sends it through `parse_turn_item` and verifies that the parser routes it to `TurnItem::HookPrompt` instead of treating it as user text.

*Call graph*: calls 1 internal fn (build_hook_prompt_message); 4 external calls (from_single_hook, assert_eq!, panic!, parse_turn_item).


##### `parses_hook_prompt_and_hides_other_contextual_fragments`  (lines 313–345)

```
fn parses_hook_prompt_and_hides_other_contextual_fragments()
```

**Purpose**: Checks that hook prompt text can be extracted even when it appears beside other hidden context, and that the hidden context stays hidden.

**Data flow**: It builds a user message with an environment-context text item and a hook-prompt XML-like text item. Parsing should return a hook prompt with the message ID, decoded prompt text, and hook run ID, while ignoring the environment context.

**Call relations**: This test calls `parse_turn_item` on a mixed-context message. It verifies that the mapper can pick out the important hook instruction and discard unrelated scaffolding in the same raw event.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `internal_model_context_does_not_parse_as_visible_turn_item`  (lines 348–364)

```
fn internal_model_context_does_not_parse_as_visible_turn_item()
```

**Purpose**: Checks that internal model context is not shown as a visible user turn. Internal model context is steering information meant for the model, not something the user typed.

**Data flow**: It creates an internal context fragment, renders it into text, and wraps it in a raw user message. When the parser sees that message, the expected result is no visible turn item.

**Call relations**: This test exercises the hidden-context filtering path for `InternalModelContextFragment`, ensuring that internally generated steering text does not leak into the user-facing event stream.

*Call graph*: 2 external calls (assert!, vec!).


##### `parses_agent_message`  (lines 367–389)

```
fn parses_agent_message()
```

**Purpose**: Checks the ordinary assistant-message path: visible assistant output should become an agent message turn.

**Data flow**: It creates a raw assistant message with one output text item saying “Hello from Codex.” The parser should return an agent message whose first content item contains that same text.

**Call relations**: This test gives `parse_turn_item` a standard assistant response and verifies that the mapper produces the expected `TurnItem::AgentMessage` for later display.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `parses_reasoning_summary_and_raw_content`  (lines 392–422)

```
fn parses_reasoning_summary_and_raw_content()
```

**Purpose**: Checks that a reasoning event preserves both its short summary and its raw detailed text. Reasoning here means model thought-trace information represented by the protocol.

**Data flow**: It builds a reasoning response with two summary lines and one raw reasoning text entry. After parsing, the resulting reasoning turn should contain the two summary strings and the raw detail string.

**Call relations**: This test sends a reasoning `ResponseItem` through `parse_turn_item` and confirms that the mapper separates summary text from raw content instead of flattening or losing either part.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `parses_reasoning_including_raw_content`  (lines 425–455)

```
fn parses_reasoning_including_raw_content()
```

**Purpose**: Checks that more than one kind of raw reasoning content is collected into the reasoning turn. This includes both explicit reasoning text and plain text inside the reasoning item.

**Data flow**: It creates a reasoning response with one summary and two raw content entries. The parser should return a reasoning turn with the summary and both raw strings in order.

**Call relations**: This test extends the reasoning coverage for `parse_turn_item`, making sure the mapper does not ignore valid raw content just because it appears under a different reasoning-content variant.

*Call graph*: 4 external calls (assert_eq!, panic!, parse_turn_item, vec!).


##### `parses_web_search_call`  (lines 458–485)

```
fn parses_web_search_call()
```

**Purpose**: Checks that a completed web search action becomes a web-search turn with a readable query.

**Data flow**: It builds a raw web-search call with an ID, completed status, and search query `weather`. Parsing should return a web-search item with the same ID, the query text, and the original search action.

**Call relations**: This test gives `parse_turn_item` a normal search action and verifies that it routes the event to `TurnItem::WebSearch` for display or history tracking.

*Call graph*: 3 external calls (assert_eq!, panic!, parse_turn_item).


##### `parses_web_search_open_page_call`  (lines 488–513)

```
fn parses_web_search_open_page_call()
```

**Purpose**: Checks that opening a web page is also represented as a web-search-style turn, using the URL as the readable query text.

**Data flow**: It creates a raw web-search call whose action is `OpenPage` with a URL. The parsed result should carry the same ID and action, and use the URL as the user-readable query field.

**Call relations**: This test runs an open-page web action through `parse_turn_item`, confirming that non-search browsing actions still become meaningful `TurnItem::WebSearch` entries.

*Call graph*: 3 external calls (assert_eq!, panic!, parse_turn_item).


##### `parses_web_search_find_in_page_call`  (lines 516–543)

```
fn parses_web_search_find_in_page_call()
```

**Purpose**: Checks that a find-in-page web action is converted into a readable web-search turn that names both the search pattern and the page URL.

**Data flow**: It builds a raw web action asking to find `needle` inside `https://example.com`. After parsing, the result should have a query string like `'needle' in https://example.com` and preserve the original action details.

**Call relations**: This test feeds a find-in-page action to `parse_turn_item`, ensuring the mapper creates a clear summary for the conversation timeline while keeping the structured web action.

*Call graph*: 3 external calls (assert_eq!, panic!, parse_turn_item).


##### `parses_partial_web_search_call_without_action_as_other`  (lines 546–566)

```
fn parses_partial_web_search_call_without_action_as_other()
```

**Purpose**: Checks that an incomplete web-search call still becomes a safe placeholder turn instead of failing. This can happen while a search is still in progress and no action details are available yet.

**Data flow**: It creates a web-search call with an ID and in-progress status but no action. Parsing should return a web-search item with an empty query and an `Other` action value.

**Call relations**: This test sends a partial web-search event through `parse_turn_item` and verifies the fallback behavior, so the wider event flow can tolerate unfinished protocol messages.

*Call graph*: 3 external calls (assert_eq!, panic!, parse_turn_item).


### `core/src/context/contextual_user_message_tests.rs`

`test` · `test suite`

Codex sometimes places structured context inside what looks like a user message. Examples include the current working directory, AGENTS.md instructions, internal steering text, subagent notices, and hook prompts. These are not ordinary things the user typed; they are extra context meant to guide the model or the interface. This test file checks that the code can tell the difference.

The tests act like a set of labels on envelopes. Some envelopes are marked with known tags, such as <environment_context> or <codex_internal_context>, and should be treated as contextual user fragments. Other envelopes, such as a made-up <project_context> tag or plain “hello”, should stay visible as normal user text.

The file also checks rendering rules. AGENTS.md instructions must produce the exact legacy header format, with or without a directory name. Internal model context must render with a valid lowercase source name. Hook prompt messages get special attention because they contain user-visible text that may include quotes, ampersands, or angle brackets. The test confirms that this text survives a build-and-parse round trip without being left in an awkward escaped form.

Without these tests, Codex could accidentally hide real user text, show internal context to users, or corrupt prompt text that contains special characters.

#### Function details

##### `detects_environment_context_fragment`  (lines 12–16)

```
fn detects_environment_context_fragment()
```

**Purpose**: Checks that text wrapped in an environment context tag is recognized as special context rather than ordinary user text. This matters because environment details, like the current folder, should be treated as background information.

**Data flow**: The test starts with a content item containing an <environment_context> block. It passes that item to the context-fragment detector. The expected result is true, meaning the item is classified as contextual information.

**Call relations**: During the test run, this test asks the detector to classify one known environment-context example and then uses an assertion to confirm the detector says yes.

*Call graph*: 1 external calls (assert!).


##### `detects_agents_instructions_fragment`  (lines 19–28)

```
fn detects_agents_instructions_fragment()
```

**Purpose**: Checks that AGENTS.md instruction blocks are recognized whether they include an older directory-specific header or the newer shorter header. This keeps backwards-compatible instruction messages working.

**Data flow**: The test tries two pieces of instruction text. Each one is put into an input-text content item and sent to the context-fragment detector. Each should come back as true, showing that both supported header styles are accepted.

**Call relations**: The test runner executes this as a compatibility check. For each sample message, it calls the detector and then relies on an assertion to fail the test if either format is not recognized.

*Call graph*: 1 external calls (assert!).


##### `renders_agents_instructions_with_legacy_directory_header`  (lines 31–40)

```
fn renders_agents_instructions_with_legacy_directory_header()
```

**Purpose**: Checks the exact text produced when AGENTS.md instructions are rendered with a directory name. This protects the older header format that says the instructions are for a specific folder.

**Data flow**: The test builds a UserInstructions value with directory set to /tmp and text set to body. It renders that value into a string. The output must exactly match the expected AGENTS.md block with the directory in the header.

**Call relations**: The test directly exercises UserInstructions rendering and uses an equality assertion to compare the rendered string with the known correct legacy format.

*Call graph*: 1 external calls (assert_eq!).


##### `renders_agents_instructions_without_directory_header`  (lines 43–52)

```
fn renders_agents_instructions_without_directory_header()
```

**Purpose**: Checks the exact text produced when AGENTS.md instructions are rendered without a directory name. This ensures the general, non-directory version stays stable.

**Data flow**: The test builds a UserInstructions value with no directory and with text set to body. It renders it into a string. The result must exactly match the expected AGENTS.md block without a folder name in the header.

**Call relations**: The test focuses only on the no-directory rendering path and uses an equality assertion to catch any accidental change in the message format.

*Call graph*: 1 external calls (assert_eq!).


##### `detects_subagent_notification_fragment_case_insensitively`  (lines 55–59)

```
fn detects_subagent_notification_fragment_case_insensitively()
```

**Purpose**: Checks that subagent notification tags are recognized even when the tag uses different letter casing. This makes the parser more forgiving about uppercase and lowercase tag text.

**Data flow**: The test supplies a string with an uppercase opening subagent notification tag and a lowercase closing tag. It asks the SubagentNotification matcher whether the text fits. The expected answer is true.

**Call relations**: The test calls the subagent notification matching code directly, then uses an assertion to confirm that case differences do not stop recognition.

*Call graph*: 1 external calls (assert!).


##### `detects_internal_model_context_fragment`  (lines 62–76)

```
fn detects_internal_model_context_fragment()
```

**Purpose**: Checks that internal model context can be rendered in the correct tag format and then recognized as a contextual fragment. This protects the path used for hidden steering text from trusted internal sources.

**Data flow**: The test creates a valid internal context source named extension, builds an InternalModelContextFragment with the text Internal steering., and renders it. It first checks that the rendered text exactly matches the expected XML-like block. Then it wraps that text in a content item and confirms the detector classifies it as contextual.

**Call relations**: This test connects creation, rendering, and detection. It calls the source builder, creates the fragment, checks the rendered output, and then hands that output to the general fragment detector.

*Call graph*: calls 2 internal fn (from_static, new); 2 external calls (assert!, assert_eq!).


##### `detects_legacy_goal_context_fragment`  (lines 79–84)

```
fn detects_legacy_goal_context_fragment()
```

**Purpose**: Checks that an older goal-context tag is still recognized as contextual information. This helps preserve support for messages created by earlier versions of the system.

**Data flow**: The test creates a content item containing a <goal_context> block. It sends that item to the context-fragment detector. The expected result is true, meaning legacy goal context is still treated as special context.

**Call relations**: The test runner uses this as a backwards-compatibility check. It calls the shared detector and asserts that the old tag is still accepted.

*Call graph*: 1 external calls (assert!).


##### `does_not_hide_arbitrary_context_tags`  (lines 87–91)

```
fn does_not_hide_arbitrary_context_tags()
```

**Purpose**: Checks that the detector does not treat every tag ending in “context” as special. This is important because ordinary user text could contain custom tags and should not be hidden by mistake.

**Data flow**: The test gives the detector a content item with a made-up <project_context> block. The detector should return false. That means the text remains ordinary user content instead of being classified as hidden context.

**Call relations**: This test protects the detector from being too broad. It calls the same classification function used by the positive tests, but expects the opposite result.

*Call graph*: 1 external calls (assert!).


##### `rejects_invalid_internal_model_context_source`  (lines 94–99)

```
fn rejects_invalid_internal_model_context_source()
```

**Purpose**: Checks that internal model context is not accepted when its source name has invalid casing. This helps keep internal context sources strict and predictable.

**Data flow**: The test builds a content item containing a codex_internal_context tag with source="Extension" instead of the valid lowercase form. It passes that text to the detector. The expected result is false.

**Call relations**: This test exercises the detector’s validation path. It confirms that a tag with the right shape is still rejected if its source value does not meet the accepted rules.

*Call graph*: 1 external calls (assert!).


##### `contextual_user_fragment_is_dyn_compatible`  (lines 102–112)

```
fn contextual_user_fragment_is_dyn_compatible()
```

**Purpose**: Checks that contextual fragments can be used through a trait object, which is Rust’s way of treating different concrete types through one shared interface. This matters if the system wants to store or pass different fragment kinds uniformly.

**Data flow**: The test creates an InternalModelContextFragment and stores it in a boxed ContextualUserFragment trait object. It then calls render through that shared interface. The returned string must match the expected internal-context block.

**Call relations**: This test does not call the detector. Instead, it proves that the fragment interface itself works when used dynamically, after creating the internal context source and fragment.

*Call graph*: calls 2 internal fn (from_static, new); 2 external calls (new, assert_eq!).


##### `ignores_regular_user_text`  (lines 115–119)

```
fn ignores_regular_user_text()
```

**Purpose**: Checks that plain user text is not classified as special context. This protects normal chat messages from being hidden or treated as system-provided background.

**Data flow**: The test wraps the string hello in an input-text content item. It sends that item to the context-fragment detector. The expected result is false, meaning the text stays ordinary user content.

**Call relations**: This is the simplest negative check for the detector. It calls the same classification code as the context-tag tests and asserts that normal text is ignored.

*Call graph*: 1 external calls (assert!).


##### `detects_hook_prompt_fragment_and_roundtrips_escaping`  (lines 122–152)

```
fn detects_hook_prompt_fragment_and_roundtrips_escaping()
```

**Purpose**: Checks that hook prompt fragments are recognized as contextual fragments and that text with special characters survives being built into a message and parsed back out. This is especially important for quotes, ampersands, and angle brackets, which often need escaping in structured text.

**Data flow**: The test starts with hook text containing quotes, an ampersand, and angle brackets, plus a hook run id. It builds a hook prompt message from that fragment, confirms the message has exactly one input-text content item, and verifies that item is contextual. It then parses the visible hook prompt message back into fragments and expects to get the original text and hook id. Finally, it checks that the stored text does not contain an unwanted escaped version of the quote-and-symbol sequence.

**Call relations**: This test walks through the full hook prompt path. It creates a hook fragment, hands it to the message builder, inspects the resulting response item, calls the contextual-fragment detector, and then parses the message back to confirm the round trip preserved the intended content. If the message shape is not what the test expects, it deliberately panics so the failure is clear.

*Call graph*: calls 1 internal fn (build_hook_prompt_message); 4 external calls (from_single_hook, assert!, assert_eq!, panic!).


### `core/src/context/environment_context_tests.rs`

`test` · `test run`

The environment context is like a short briefing note sent along with a request: it tells the model where it is working, what shell is available, what date and timezone it should assume, and what it may or may not access. This test file makes sure that briefing is written correctly.

The tests build small fake environments, render them into the XML-like text used by the system, and compare the result with an exact expected string. They cover simple cases, such as one working directory and one shell, and richer cases, such as network allow/deny lists, multiple selected environments, and subagent descriptions.

A major focus is filesystem permission reporting. The file creates a permission profile where project roots are writable, but private folders are denied. It then checks that those rules are expanded for every workspace root, not just the current directory. That matters because a model must know the true safety boundary before suggesting file changes.

The file also tests comparison behavior: two environment contexts can be considered the same even if their shell names differ, but not if their working directories differ. Without these tests, small formatting or permission mistakes could silently give the model misleading instructions.

#### Function details

##### `fake_shell_name`  (lines 21–27)

```
fn fake_shell_name() -> String
```

**Purpose**: Creates a realistic shell name for tests without depending on the user’s actual machine. It pretends the shell is Bash at `/bin/bash` and returns the display name used by the environment context.

**Data flow**: It starts with no outside input. It builds a small fake shell object with a Bash type and path, asks that object for its human-readable name, and returns that name as a string.

**Call relations**: This helper supports tests that need a stable shell value. In particular, the workspace-root test calls it before building an environment context from a turn context item, so the test can focus on filesystem behavior instead of shell detection.

*Call graph*: called by 1 (turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd); 1 external calls (from).


##### `test_abs_path`  (lines 29–31)

```
fn test_abs_path(unix_path: &str) -> AbsolutePathBuf
```

**Purpose**: Turns a Unix-style test path into the project’s absolute path type. This keeps path setup short and consistent inside the tests.

**Data flow**: It receives a path written as text, passes it through the shared test path builder, converts the result into an absolute path, and returns that absolute path object.

**Call relations**: Tests that need reliable absolute paths call this helper before constructing permission profiles or checking rendered filesystem entries. It delegates the low-level test path creation to `test_path_buf`.

*Call graph*: called by 2 (serialize_environment_context_with_full_filesystem_profile, turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd); 1 external calls (test_path_buf).


##### `serialize_workspace_write_environment_context`  (lines 34–59)

```
fn serialize_workspace_write_environment_context()
```

**Purpose**: Checks the basic rendered environment context for one local workspace. It proves that working directory, shell, current date, and timezone appear in the expected order and shape.

**Data flow**: The test creates a fake current working directory, builds an `EnvironmentContext` with one environment plus date and timezone, renders it to text, and compares that text to the exact expected XML-like block.

**Call relations**: This is a direct test of `EnvironmentContext::new` followed by rendering. It uses the fake shell helper indirectly through `fake_shell_name` and ends by asserting that the rendered context matches the contract.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, test_path_buf, format!, vec!).


##### `serialize_environment_context_with_network`  (lines 62–91)

```
fn serialize_environment_context_with_network()
```

**Purpose**: Checks that network access rules are included when they are present. It verifies that allowed hosts and denied hosts are shown clearly in the rendered environment context.

**Data flow**: The test builds a network context with an allow list and a deny list, adds it to a normal environment context, renders the context, and compares the result with the expected text containing a `<network>` section.

**Call relations**: This test exercises both `NetworkContext::new` and `EnvironmentContext::new`. It confirms that rendering carries network information through instead of dropping it.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert_eq!, format!, vec!).


##### `workspace_write_permission_profile_with_private_denials`  (lines 93–117)

```
fn workspace_write_permission_profile_with_private_denials() -> PermissionProfile
```

**Purpose**: Builds a reusable permission setup for tests: project roots can be written, but `private` areas inside them are blocked. This gives several tests the same safety policy to check against.

**Data flow**: It starts with no input. It creates a restricted filesystem policy with three rules: write access for project roots, denied access for a `private` subpath, and denied access for matching `private/**` glob patterns. It combines that with restricted network access and returns a `PermissionProfile`.

**Call relations**: Filesystem-related tests call this helper so they can focus on how permissions are rendered or expanded. It hands its policy to permission-profile conversion code, which is part of the production environment-context machinery.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); called by 2 (serialize_environment_context_with_full_filesystem_profile, turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd); 1 external calls (vec!).


##### `serialize_environment_context_with_full_filesystem_profile`  (lines 120–161)

```
fn serialize_environment_context_with_full_filesystem_profile()
```

**Purpose**: Checks that a full filesystem permission profile is rendered correctly for multiple workspace roots. It confirms that both allowed roots and denied private paths are shown explicitly.

**Data flow**: The test creates two absolute workspace roots, calculates the private paths and private glob paths that should appear under each root, builds an environment context, attaches a filesystem context made from the reusable permission profile, renders it, and compares the output to the exact expected text.

**Call relations**: This test connects the helper permission profile to `FileSystemContext::from_permission_profile`. It verifies that permission rules are expanded across every workspace root before the environment context is rendered.

*Call graph*: calls 5 internal fn (new, from_permission_profile, test_abs_path, workspace_write_permission_profile_with_private_denials, resolve_path_against_base); 4 external calls (new, assert_eq!, format!, vec!).


##### `turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd`  (lines 164–212)

```
fn turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd()
```

**Purpose**: Checks an important safety rule: filesystem permissions should be based on the declared workspace roots, not merely on the current directory. This prevents permissions from being described for the wrong folder.

**Data flow**: The test builds a turn context item with a current directory that is not the workspace, plus two explicit workspace roots and a permission profile. It converts that item into an environment context, renders it, then checks that the rendered text includes the workspace roots and their private denial paths, while excluding a private path under the unrelated current directory.

**Call relations**: This test drives `EnvironmentContext::from_turn_context_item`, using `fake_shell_name`, `test_abs_path`, and the reusable permission profile helper. It confirms that turn-level data is interpreted correctly before being handed to the model.

*Call graph*: calls 4 internal fn (from_turn_context_item, fake_shell_name, test_abs_path, workspace_write_permission_profile_with_private_denials); 4 external calls (new_read_only_policy, assert!, test_path_buf, vec!).


##### `serialize_read_only_environment_context`  (lines 215–230)

```
fn serialize_read_only_environment_context()
```

**Purpose**: Checks that an environment context can be rendered even when there are no selected environments. It verifies the stripped-down form that only includes date and timezone.

**Data flow**: The test builds an environment context with an empty environment list and with date and timezone values. It renders that context and compares it to the expected text containing only those fields.

**Call relations**: This directly exercises `EnvironmentContext::new` for a minimal case. It protects against rendering code that might assume there is always a working directory and shell.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, assert_eq!).


##### `equals_except_shell_compares_cwd`  (lines 233–257)

```
fn equals_except_shell_compares_cwd()
```

**Purpose**: Checks that two contexts with the same working directory are treated as equal when shell differences are ignored. In this case, even the shell is the same, so equality should clearly pass.

**Data flow**: The test builds two environment contexts with the same absolute current directory and shell. It calls `equals_except_shell` and asserts that the result is true.

**Call relations**: This test focuses on the comparison method used when shell details should not matter. It establishes the positive case before nearby tests check differences.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, vec!).


##### `equals_except_shell_compares_cwd_differences`  (lines 260–285)

```
fn equals_except_shell_compares_cwd_differences()
```

**Purpose**: Checks that working directory differences still matter when comparing contexts while ignoring shells. Two contexts in different folders should not be treated as the same environment.

**Data flow**: The test builds two environment contexts with different absolute current directories. It asks `equals_except_shell` to compare them and asserts that the result is false.

**Call relations**: This test complements the matching-directory case. It makes sure `equals_except_shell` does not become too loose and accidentally ignore the folder where work is happening.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, vec!).


##### `equals_except_shell_ignores_shell`  (lines 288–313)

```
fn equals_except_shell_ignores_shell()
```

**Purpose**: Checks that shell name and environment id are ignored by the special comparison method. This is useful when the system wants to know whether the meaningful workspace context changed, even if the shell label changed.

**Data flow**: The test builds two contexts with the same working directory but different environment ids and shell names. It compares them with `equals_except_shell` and expects true.

**Call relations**: This test directly verifies the reason `equals_except_shell` exists. It shows that the comparison is centered on the working location rather than the shell metadata.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, vec!).


##### `serialize_environment_context_with_subagents`  (lines 316–344)

```
fn serialize_environment_context_with_subagents()
```

**Purpose**: Checks that subagent information is included in the rendered environment context. Subagents are additional helper agents, and the model needs to see the available list in a readable block.

**Data flow**: The test builds an environment context with one workspace, date, timezone, and a multiline subagent description. It renders the context and compares it to the expected text where the subagent lines are indented inside a `<subagents>` section.

**Call relations**: This test exercises `EnvironmentContext::new` with the optional subagents field filled in. It confirms that multiline helper-agent text is preserved and formatted predictably.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, format!, vec!).


##### `serialize_environment_context_with_multiple_selected_environments`  (lines 347–389)

```
fn serialize_environment_context_with_multiple_selected_environments()
```

**Purpose**: Checks the rendered format when more than one environment is selected. Instead of a single top-level current directory and shell, the output should contain an `<environments>` list.

**Data flow**: The test creates local and remote working directories, builds an environment context with two environment entries, adds date and timezone, renders the result, and compares it to the expected nested environment list.

**Call relations**: This test covers the multi-environment path in `EnvironmentContext::new` and rendering. It ensures local and remote contexts are both preserved rather than being flattened or losing their ids.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, test_path_buf, format!, vec!).


##### `serialize_environment_context_prefers_environment_shell_when_present`  (lines 392–432)

```
fn serialize_environment_context_prefers_environment_shell_when_present()
```

**Purpose**: Checks that each environment’s own shell value is used in multi-environment rendering. This matters when different environments use different command interpreters, such as PowerShell and cmd.

**Data flow**: The test builds two environments with different folders and different shell names, renders the context without date or timezone, and compares it to expected text showing each shell under its matching environment.

**Call relations**: This test exercises the same multi-environment rendering path as the previous one, but focuses specifically on shell selection. It confirms the renderer does not overwrite per-environment shell values with a shared default.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, test_path_buf, format!, vec!).


### `core/src/stream_events_utils_tests.rs`

`test` · `test run`

This is a test file. It acts like a checklist for a busy part of the system: the code that receives pieces of output from the model and decides what they mean for the conversation. Without these tests, small changes could accidentally show hidden citation text to the user, treat a search result as if it came only from local tools, run extension code at the wrong time, or save image data unsafely.

The tests build small fake response items, such as assistant messages, web searches, shell calls, and image generation calls. They then feed those items into the real stream-event helper functions from the parent module. The file focuses on a few important rules. External context, such as web search and tool search, is marked differently from local shell or function calls. Memory citation markup is removed from visible assistant text, while the citation data is preserved separately. Optional extension contributors can rewrite or add data to a finished turn item, but only when the caller explicitly chooses to run them. Commentary messages, meaning intermediate “still working” updates, keep the mailbox open, while final-looking messages defer delivery to the next turn. Finally, image generation results must be plain standard base64 data, saved under the Codex home directory, and protected from unsafe path names.

#### Function details

##### `assistant_output_text`  (lines 33–35)

```
fn assistant_output_text(text: &str) -> ResponseItem
```

**Purpose**: This small test helper creates a plain assistant message response item with no special message phase. Tests use it so they do not have to repeat the same response-item setup over and over.

**Data flow**: It receives a text string → passes that text along with no phase to the more general helper → returns a response item shaped like assistant output.

**Call relations**: Many tests call this helper when they need a simple assistant message. It delegates the real construction work to `assistant_output_text_with_phase`, keeping the test cases focused on the behavior they are checking.

*Call graph*: calls 1 internal fn (assistant_output_text_with_phase); called by 9 (completed_item_defers_mailbox_delivery_for_unknown_phase_messages, external_context_pollution_items_exclude_local_tool_calls, finalized_turn_item_defers_mailbox_for_contributed_visible_text, handle_non_tool_response_item_runs_turn_item_contributors_only_when_requested, handle_non_tool_response_item_strips_citations_from_assistant_message, handle_output_item_done_returns_contributed_last_agent_message, last_assistant_message_from_item_returns_none_for_citation_only_message, last_assistant_message_from_item_returns_none_for_plan_only_hidden_message, last_assistant_message_from_item_strips_citations_and_plan_blocks).


##### `assistant_output_text_with_phase`  (lines 37–47)

```
fn assistant_output_text_with_phase(text: &str, phase: Option<MessagePhase>) -> ResponseItem
```

**Purpose**: This helper creates an assistant message response item and lets the test choose its phase, such as commentary. It is used when the exact message phase matters to the expected behavior.

**Data flow**: It receives visible text and an optional message phase → builds a response item with an assistant role, a fixed test id, and one text content entry → returns that item to the test.

**Call relations**: `assistant_output_text` calls this with no phase for ordinary messages. Tests that need a commentary message call it directly so they can verify mailbox behavior for in-progress assistant output.

*Call graph*: called by 3 (assistant_output_text, completed_item_keeps_mailbox_delivery_open_for_commentary_messages, finalized_turn_item_keeps_mailbox_open_for_commentary_text); 1 external calls (vec!).


##### `external_context_pollution_items_include_web_search_and_tool_search`  (lines 50–80)

```
fn external_context_pollution_items_include_web_search_and_tool_search()
```

**Purpose**: This test confirms that web search and tool-search response items are treated as possibly containing outside information. That matters because the system needs to know when a conversation may have been influenced by external context.

**Data flow**: It creates several search-related response items → asks the production helper whether each one may include external context → expects every one of them to be marked yes.

**Call relations**: The test exercises `response_item_may_include_external_context`, which is the shared rule used by stream-event processing to distinguish outside search context from ordinary local activity.

*Call graph*: 3 external calls (new, assert!, json!).


##### `external_context_pollution_items_exclude_local_tool_calls`  (lines 83–133)

```
fn external_context_pollution_items_exclude_local_tool_calls()
```

**Purpose**: This test confirms that local actions, such as shell commands and local tool calls, are not wrongly labeled as outside search context. It protects the distinction between information fetched from the wider world and information produced by local tools.

**Data flow**: It builds examples of local shell calls, function calls, custom tool calls, their outputs, and ordinary assistant text → checks each with the external-context helper → expects none of them to be marked as external context.

**Call relations**: The test uses `assistant_output_text` for the plain message case and then checks the same production helper used by the stream-event code. Together with the search-positive test, it defines both sides of the classification rule.

*Call graph*: calls 2 internal fn (assistant_output_text, from_text); 3 external calls (assert!, Exec, vec!).


##### `handle_non_tool_response_item_strips_citations_from_assistant_message`  (lines 136–172)

```
async fn handle_non_tool_response_item_strips_citations_from_assistant_message()
```

**Purpose**: This test makes sure hidden memory-citation markup is removed from the text shown as an assistant message, while the citation information is still saved separately. This prevents internal citation tags from leaking into the chat while preserving source-tracking data.

**Data flow**: It creates a test session and an assistant message containing memory citation markup → sends it through the non-tool response-item converter → checks that the resulting agent message says only `hello world` and carries the parsed memory citation data.

**Call relations**: The test calls `handle_non_tool_response_item`, which is the production path for assistant output that is not a tool call. It uses `assistant_output_text` to supply a controlled message with citation markup.

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

**Purpose**: This is a fake extension hook used by the tests. It marks that it ran and adds an empty memory citation to agent messages, so tests can tell whether contributor hooks were actually executed.

**Data flow**: It receives shared extension data, per-turn extension data, and a mutable turn item → records a marker in the turn data and, if the item is an agent message, sets its memory citation field → returns success.

**Call relations**: The extension system calls this method when `handle_non_tool_response_item` is asked to run turn-item contributors. The surrounding tests then inspect the turn store and the changed message to prove the hook did or did not run.

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

**Purpose**: This is another fake extension hook used by the tests. It rewrites assistant message text to a known value, making it easy to check whether later code uses the contributed version of the message.

**Data flow**: It receives a mutable turn item → if that item is an agent message, replaces its content with `contributed assistant text` → returns success.

**Call relations**: The production extension pipeline calls this when contributors are enabled. Tests use it with finalization and output completion code to verify that downstream facts, such as the last assistant message, reflect extension changes.

*Call graph*: 2 external calls (pin, vec!).


##### `handle_non_tool_response_item_runs_turn_item_contributors_only_when_requested`  (lines 220–269)

```
async fn handle_non_tool_response_item_runs_turn_item_contributors_only_when_requested()
```

**Purpose**: This test checks that extension contributors are not run by accident. They should run only when the caller explicitly chooses the policy that allows them.

**Data flow**: It creates a session with the fake contributor installed and an assistant message containing hidden citation markup → first processes the item with contributors skipped and confirms no marker or added citation appears → then processes it with contributors enabled and confirms the marker and citation appear while visible text remains cleaned.

**Call relations**: The test drives `handle_non_tool_response_item` in both modes. It relies on `TestTurnItemContributor::contribute` to leave clear evidence when the contributor path is taken.

*Call graph*: calls 4 internal fn (make_session_and_context, assistant_output_text, new, new); 6 external calls (new, assert!, assert_eq!, Run, panic!, handle_non_tool_response_item).


##### `handle_output_item_done_returns_contributed_last_agent_message`  (lines 272–314)

```
async fn handle_output_item_done_returns_contributed_last_agent_message()
```

**Purpose**: This test makes sure that when a stream output item is completed, the recorded “last assistant message” uses the text after extension contributors have had a chance to modify it. That matters because later parts of the system may rely on that final text.

**Data flow**: It builds a realistic output-handling context with a session, turn context, tool router, tool runtime, and turn store → sends in an assistant message with original text → expects the completion result to report the rewritten contributor text instead.

**Call relations**: The test calls `handle_output_item_done`, the broader completion path for stream items. It installs `RewriteAgentMessageContributor::contribute` so the test can confirm that output completion includes contributor changes before reporting the last agent message.

*Call graph*: calls 7 internal fn (make_session_and_context, assistant_output_text, new, from_turn_context, new, new, new); 8 external calls (clone, new, new, default, new, assert_eq!, handle_output_item_done, new).


##### `finalized_turn_item_defers_mailbox_for_contributed_visible_text`  (lines 317–340)

```
async fn finalized_turn_item_defers_mailbox_for_contributed_visible_text()
```

**Purpose**: This test verifies that a finalized assistant item with visible contributed text causes mailbox delivery to be deferred to the next turn. In plain terms, once there is final assistant text, the system should treat the assistant as done for now.

**Data flow**: It creates an assistant message whose original visible content is only hidden citation markup → runs finalization with a contributor that adds visible text → checks that the final facts contain the contributed text and say to defer mailbox delivery.

**Call relations**: The test calls `finalize_non_tool_response_item`, which gathers both the finished turn item and facts about it. It uses `RewriteAgentMessageContributor::contribute` to prove the decision is based on the final contributed item, not just the raw model text.

*Call graph*: calls 4 internal fn (make_session_and_context, assistant_output_text, new, new); 5 external calls (new, assert!, assert_eq!, Run, finalize_non_tool_response_item).


##### `finalized_turn_item_keeps_mailbox_open_for_commentary_text`  (lines 343–366)

```
async fn finalized_turn_item_keeps_mailbox_open_for_commentary_text()
```

**Purpose**: This test checks that commentary messages are treated as in-progress updates, even if an extension contributor rewrites their visible text. The mailbox should stay open because the assistant may still be working.

**Data flow**: It creates a commentary-phase assistant message → finalizes it with the rewriting contributor enabled → confirms the contributed text is recorded but mailbox delivery is not deferred.

**Call relations**: The test calls `finalize_non_tool_response_item` and supplies a phased message through `assistant_output_text_with_phase`. It shows that the message phase still controls mailbox timing after contributor text changes.

*Call graph*: calls 4 internal fn (make_session_and_context, assistant_output_text_with_phase, new, new); 5 external calls (new, assert!, assert_eq!, Run, finalize_non_tool_response_item).


##### `last_assistant_message_from_item_strips_citations_and_plan_blocks`  (lines 369–378)

```
fn last_assistant_message_from_item_strips_citations_and_plan_blocks()
```

**Purpose**: This test confirms that the helper for extracting the last visible assistant message removes hidden memory citations and proposed-plan blocks. Users should see the actual answer text, not internal planning or citation markup.

**Data flow**: It builds an assistant message containing normal text, a memory citation block, a proposed plan block, and more normal text → asks for the last assistant message in plan mode → expects only the visible text before and after the hidden blocks.

**Call relations**: The test exercises `last_assistant_message_from_item`, which is used when the stream code needs a plain text summary of assistant output. `assistant_output_text` supplies the controlled mixed-content message.

*Call graph*: calls 1 internal fn (assistant_output_text); 2 external calls (assert_eq!, last_assistant_message_from_item).


##### `last_assistant_message_from_item_returns_none_for_citation_only_message`  (lines 381–388)

```
fn last_assistant_message_from_item_returns_none_for_citation_only_message()
```

**Purpose**: This test checks that a message made only of hidden citation markup does not count as a visible assistant message. That avoids reporting empty or misleading assistant text.

**Data flow**: It creates an assistant message containing only a memory citation block → extracts the last assistant message → expects no message to be returned.

**Call relations**: The test uses `assistant_output_text` and relies on the same extraction rule checked by the previous test. It covers the edge case where stripping hidden markup leaves nothing visible.

*Call graph*: calls 1 internal fn (assistant_output_text); 1 external calls (assert_eq!).


##### `last_assistant_message_from_item_returns_none_for_plan_only_hidden_message`  (lines 391–398)

```
fn last_assistant_message_from_item_returns_none_for_plan_only_hidden_message()
```

**Purpose**: This test checks that a message made only of a hidden proposed-plan block does not become visible assistant text when plan mode is active. Internal plans should not be mistaken for a final user-facing answer.

**Data flow**: It creates an assistant message containing only a proposed-plan block → extracts the last assistant message with plan-mode stripping enabled → expects no visible message.

**Call relations**: The test uses `assistant_output_text` to create the item and then exercises the production extraction helper. It complements the citation-only test by covering hidden planning content.

*Call graph*: calls 1 internal fn (assistant_output_text); 1 external calls (assert_eq!).


##### `completed_item_defers_mailbox_delivery_for_unknown_phase_messages`  (lines 401–407)

```
fn completed_item_defers_mailbox_delivery_for_unknown_phase_messages()
```

**Purpose**: This test confirms that a completed assistant message with no special phase is treated like final output. The mailbox delivery is deferred because the assistant has produced what looks like a real answer.

**Data flow**: It creates a normal assistant message with no phase → asks whether completion should defer mailbox delivery to the next turn → expects yes.

**Call relations**: The test uses `assistant_output_text` and checks `completed_item_defers_mailbox_delivery_to_next_turn`, the helper that decides whether a completed item should close out the current mailbox flow.

*Call graph*: calls 1 internal fn (assistant_output_text); 1 external calls (assert!).


##### `completed_item_keeps_mailbox_delivery_open_for_commentary_messages`  (lines 410–416)

```
fn completed_item_keeps_mailbox_delivery_open_for_commentary_messages()
```

**Purpose**: This test verifies that commentary messages do not close the mailbox flow. Commentary is treated as a progress update rather than the assistant’s final answer.

**Data flow**: It creates an assistant message marked as commentary → asks the mailbox-deferral helper what to do → expects it not to defer delivery.

**Call relations**: The test uses `assistant_output_text_with_phase` to set the commentary phase and then checks the shared mailbox-timing helper.

*Call graph*: calls 1 internal fn (assistant_output_text_with_phase); 1 external calls (assert!).


##### `completed_item_defers_mailbox_delivery_for_image_generation_calls`  (lines 419–431)

```
fn completed_item_defers_mailbox_delivery_for_image_generation_calls()
```

**Purpose**: This test checks that a completed image generation call is treated as final enough to defer mailbox delivery. Once the image result is ready, the system should move delivery to the next turn.

**Data flow**: It builds a completed image-generation response item with base64 result data → asks the mailbox-deferral helper about it → expects deferral.

**Call relations**: The test directly exercises `completed_item_defers_mailbox_delivery_to_next_turn` for image output, covering a non-text response path.

*Call graph*: 1 external calls (assert!).


##### `save_image_generation_result_saves_base64_to_png_in_codex_home`  (lines 434–448)

```
async fn save_image_generation_result_saves_base64_to_png_in_codex_home()
```

**Purpose**: This test proves that plain base64 image result data is decoded and saved as a PNG file under the Codex home directory. It checks the happy path for turning model-provided image bytes into a local artifact.

**Data flow**: It creates a temporary Codex home directory and calculates the expected artifact path → saves the base64 string for `foo` → checks that the returned path matches and the file contains the decoded bytes.

**Call relations**: The test calls `image_generation_artifact_path` to know where the file should go and `save_image_generation_result` to perform the real save. It cleans up the created file afterward.

*Call graph*: 5 external calls (assert_eq!, remove_file, image_generation_artifact_path, save_image_generation_result, tempdir).


##### `save_image_generation_result_rejects_data_url_payload`  (lines 451–460)

```
async fn save_image_generation_result_rejects_data_url_payload()
```

**Purpose**: This test checks that image saving rejects a data URL such as `data:image/jpeg;base64,...` instead of accepting it as raw base64. The function expects just the encoded bytes, not a browser-style wrapper.

**Data flow**: It creates a temporary Codex home directory → tries to save a data URL payload → expects an invalid-request error instead of a file.

**Call relations**: The test calls `save_image_generation_result` on a deliberately wrong input. It protects the input contract for the image-saving helper.

*Call graph*: 3 external calls (assert!, save_image_generation_result, tempdir).


##### `save_image_generation_result_overwrites_existing_file`  (lines 463–482)

```
async fn save_image_generation_result_overwrites_existing_file()
```

**Purpose**: This test confirms that saving a generated image replaces an existing artifact at the same path. That makes repeated saves for the same session and call id predictable.

**Data flow**: It creates the expected output directory and writes an old file there → saves new base64 image data for the same session and call id → checks that the same path is returned and the file now contains the new decoded bytes.

**Call relations**: The test uses `image_generation_artifact_path` to seed the existing file and `save_image_generation_result` to overwrite it. It verifies the file-writing behavior rather than only the returned path.

*Call graph*: 7 external calls (assert_eq!, create_dir_all, remove_file, write, image_generation_artifact_path, save_image_generation_result, tempdir).


##### `save_image_generation_result_sanitizes_call_id_for_codex_home_output_path`  (lines 485–498)

```
async fn save_image_generation_result_sanitizes_call_id_for_codex_home_output_path()
```

**Purpose**: This test makes sure unsafe-looking call ids cannot make the image saver write outside the intended Codex home artifact location. It is a safety check against path traversal, where names like `../` try to escape a folder.

**Data flow**: It creates a temporary Codex home and uses a call id containing path-like pieces → computes the expected sanitized artifact path → saves valid base64 data → checks that the saved file is exactly at the safe expected path.

**Call relations**: The test compares `image_generation_artifact_path` with the result from `save_image_generation_result`. Together they demonstrate that path construction and saving agree on the sanitized location.

*Call graph*: 5 external calls (assert_eq!, remove_file, image_generation_artifact_path, save_image_generation_result, tempdir).


##### `save_image_generation_result_rejects_non_standard_base64`  (lines 501–508)

```
async fn save_image_generation_result_rejects_non_standard_base64()
```

**Purpose**: This test checks that the image saver accepts only standard base64 encoding. Non-standard variants, such as URL-safe base64 characters, are rejected so the accepted format stays strict and predictable.

**Data flow**: It creates a temporary Codex home directory → tries to save a URL-safe-looking base64 string → expects an invalid-request error.

**Call relations**: The test calls `save_image_generation_result` with malformed input. It complements the successful save test by defining what encoded image data is not allowed.

*Call graph*: 3 external calls (assert!, save_image_generation_result, tempdir).


##### `save_image_generation_result_rejects_non_base64_data_urls`  (lines 511–523)

```
async fn save_image_generation_result_rejects_non_base64_data_urls()
```

**Purpose**: This test confirms that non-base64 data URLs, such as inline SVG text, are rejected by the image saver. The saver is not meant to parse arbitrary data URL formats.

**Data flow**: It creates a temporary Codex home directory → tries to save an SVG data URL that is not base64 image bytes → expects an invalid-request error.

**Call relations**: The test again drives `save_image_generation_result` with invalid input. Alongside the other rejection tests, it guards the image-saving code against accepting confusing or unsafe payload formats.

*Call graph*: 3 external calls (assert!, save_image_generation_result, tempdir).


### `core/src/thread_rollout_truncation_tests.rs`

`test` · `test run`

A “rollout” here is the saved sequence of things that happened in a conversation: user messages, assistant replies, tool calls, internal reasoning, inter-agent messages, and events. The system sometimes needs to trim that history so it can keep only the useful recent part. If this trimming is wrong, the assistant could forget important context, keep context that was supposed to be rolled back, or start a forked conversation from the wrong point.

This test file builds small fake rollouts and asks the truncation code to cut them in different ways. Some tests check cutting from the beginning, using the nth real user message as the boundary. Others check keeping only the last few “fork turns,” where a fork turn can start from either a user message or an inter-agent message that is marked as triggering a new turn. The tests also cover rollback events, which act like an undo button for recent turns. A key detail is that startup or session prefix messages should not be mistaken for normal user conversation.

The helper functions make simple user, assistant, developer, and inter-agent messages so each test can focus on the rule being checked rather than on building protocol objects by hand.

#### Function details

##### `user_msg`  (lines 10–20)

```
fn user_msg(text: &str) -> ResponseItem
```

**Purpose**: Creates a simple fake user message for tests. This lets the tests describe conversation examples in a short, readable way.

**Data flow**: It takes plain text as input, wraps it as output text content, labels the message as coming from the user, and returns a ResponseItem ready to be placed in a rollout.

**Call relations**: The rollout truncation tests call this helper when they need a user turn. In particular, it supports tests that check where truncation happens around user messages and tests that mix session-prefix context with real user requests.

*Call graph*: called by 2 (ignores_session_prefix_messages_when_truncating_rollout_from_start, truncates_rollout_from_start_before_nth_user_only); 1 external calls (vec!).


##### `assistant_msg`  (lines 22–32)

```
fn assistant_msg(text: &str) -> ResponseItem
```

**Purpose**: Creates a simple fake assistant message for tests. It is used to fill in assistant replies between user turns so the test rollout looks like a real conversation.

**Data flow**: It takes plain text, wraps it as output text content, marks the role as assistant, and returns a ResponseItem that can be put into a rollout.

**Call relations**: The tests call this alongside user_msg to build before-and-after conversation sequences. It helps show that truncation boundaries are based on turns, not just on every individual item.

*Call graph*: called by 2 (ignores_session_prefix_messages_when_truncating_rollout_from_start, truncates_rollout_from_start_before_nth_user_only); 1 external calls (vec!).


##### `developer_msg`  (lines 34–44)

```
fn developer_msg(text: &str) -> ResponseItem
```

**Purpose**: Creates a fake developer message, which represents startup or system-provided context rather than a normal user turn. Tests use this kind of message to make sure startup context is treated differently from conversation history.

**Data flow**: It takes text, wraps it as input text content, labels the message with the developer role, and returns it as a ResponseItem.

**Call relations**: This is a fixture helper for tests that need non-user setup content at the start of a rollout. It exists so those tests can clearly separate startup context from real user turns.

*Call graph*: 1 external calls (vec!).


##### `inter_agent_msg`  (lines 46–55)

```
fn inter_agent_msg(text: &str, trigger_turn: bool) -> ResponseItem
```

**Purpose**: Creates an inter-agent communication and converts it into a response item for tests. This is used when a conversation includes one agent sending work or information to another agent.

**Data flow**: It takes message text and a trigger_turn flag. It builds a communication from the root agent to a worker agent, records whether that communication should count as starting a new turn, converts it into the response-item form used in rollouts, and returns it.

**Call relations**: Tests use this helper when they need inter-agent messages embedded among normal response items. Those tests then check whether trigger-turn messages are counted as fork boundaries while non-triggering messages are not.

*Call graph*: calls 3 internal fn (root, try_from, new); 1 external calls (new).


##### `inter_agent_communication`  (lines 57–65)

```
fn inter_agent_communication(text: &str, trigger_turn: bool) -> RolloutItem
```

**Purpose**: Creates an inter-agent communication directly as a rollout item. This is useful for tests that want to inspect rollout-level inter-agent delivery behavior rather than only response-item behavior.

**Data flow**: It takes text and a trigger_turn setting, builds a communication from the root agent to a worker agent, wraps it as a RolloutItem::InterAgentCommunication, and returns that rollout item.

**Call relations**: This helper supports tests that examine fork-turn positions using inter-agent delivery metadata. It hands the truncation-position logic a rollout item that clearly says whether the inter-agent message should start a turn.

*Call graph*: calls 3 internal fn (root, try_from, new); 2 external calls (new, InterAgentCommunication).


##### `truncates_rollout_from_start_before_nth_user_only`  (lines 68–119)

```
fn truncates_rollout_from_start_before_nth_user_only()
```

**Purpose**: Checks that truncating from the start uses user messages as the meaningful cut points. Assistant replies, reasoning records, and tool calls should not by themselves count as user turns.

**Data flow**: The test builds a rollout with two user messages and several non-user items. It asks the truncation code to cut before the first counted user boundary, then compares the result with the exact items that should remain; it also checks that asking for the second user keeps the whole rollout.

**Call relations**: This test uses user_msg and assistant_msg to build the conversation. It then exercises the rollout truncation function and uses an equality assertion to confirm that only the intended prefix is kept.

*Call graph*: calls 2 internal fn (assistant_msg, user_msg); 2 external calls (assert_eq!, vec!).


##### `truncation_max_keeps_full_rollout`  (lines 122–135)

```
fn truncation_max_keeps_full_rollout()
```

**Purpose**: Checks the safety case where the requested user-message limit is extremely large. In that case, the truncation code should not remove anything.

**Data flow**: The test creates a short rollout and passes usize::MAX as the requested boundary count. The output is compared with the original rollout, showing that the rollout is unchanged.

**Call relations**: This test calls the truncation logic directly with an intentionally huge limit. It uses an assertion to make sure the helper behaves like “keep everything” rather than overflowing or cutting unexpectedly.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_from_start_applies_thread_rollback_markers`  (lines 138–164)

```
fn truncates_rollout_from_start_applies_thread_rollback_markers()
```

**Purpose**: Checks that rollback events are honored before deciding where the nth user turn is. A rollback marker means some recent turns should no longer count as active history.

**Data flow**: The test builds a rollout with user turns, assistant replies, and a rollback event that removes one turn from the effective history. It then asks for a cut based on the second effective user turn and checks that the truncation boundary lands after the rolled-back portion is accounted for.

**Call relations**: This test exercises the truncation code in a scenario with ThreadRolledBackEvent markers. The assertion verifies that the function counts the conversation as it exists after rollback, not merely as a raw list of past items.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `ignores_session_prefix_messages_when_truncating_rollout_from_start`  (lines 167–196)

```
async fn ignores_session_prefix_messages_when_truncating_rollout_from_start()
```

**Purpose**: Checks that startup context produced by a session is not mistaken for normal user conversation when truncating. This matters because the system may prepend setup messages before the real task begins.

**Data flow**: The test creates a session and turn context, asks the session to build its initial context, appends two real user-and-assistant exchanges, and then truncates from the start. It expects the initial context to remain while the cut point is based on real user conversation rather than prefix messages.

**Call relations**: This asynchronous test calls make_session_and_context to build realistic session setup data, then uses user_msg and assistant_msg to add normal conversation. It verifies the truncation function against the combined rollout.

*Call graph*: calls 3 internal fn (make_session_and_context, assistant_msg, user_msg); 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_counts_trigger_turn_messages`  (lines 199–224)

```
fn truncates_rollout_to_last_n_fork_turns_counts_trigger_turn_messages()
```

**Purpose**: Checks that inter-agent messages marked as triggering a turn count as fork-turn boundaries. Messages that are only queued should not count the same way.

**Data flow**: The test builds a rollout containing a user message, assistant replies, one non-triggering inter-agent message, one triggering inter-agent message, and another user message. It asks to keep the last two fork turns and expects the result to start at the triggering inter-agent message.

**Call relations**: This test drives the “keep the last N fork turns” truncation path. It uses equality checking to show that trigger-turn metadata changes where the kept suffix begins.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `fork_turn_positions_use_inter_agent_delivery_metadata`  (lines 227–238)

```
fn fork_turn_positions_use_inter_agent_delivery_metadata()
```

**Purpose**: Checks that fork-turn position detection reads the metadata on inter-agent communications. A triggered inter-agent delivery should be treated like a new turn boundary, while a queued one should not.

**Data flow**: The test builds a rollout with a user task, a queued inter-agent message, an assistant reply, a triggered inter-agent message, another reply, and a later user task. It asks for the fork-turn positions and expects indexes for the user task, the triggered inter-agent task, and the next user task.

**Call relations**: This test focuses on fork_turn_positions_in_rollout rather than the full truncation result. It confirms that later truncation decisions have the right raw boundary information to work from.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_drops_startup_prefix_even_when_under_limit`  (lines 241–255)

```
fn truncates_rollout_to_last_n_fork_turns_drops_startup_prefix_even_when_under_limit()
```

**Purpose**: Checks that startup developer context is dropped when keeping fork turns, even if the rollout is small enough to fit within the requested limit. The kept history should begin at the real task, not at setup text.

**Data flow**: The test creates a rollout beginning with a developer message followed by a user task and assistant answer. It asks to keep the last two fork turns and expects the developer prefix to be removed.

**Call relations**: This test exercises the last-N-fork-turn truncation path with startup-prefix content. The assertion confirms that prefix cleanup is separate from simply counting whether the rollout is under the limit.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_applies_thread_rollback_markers`  (lines 258–280)

```
fn truncates_rollout_to_last_n_fork_turns_applies_thread_rollback_markers()
```

**Purpose**: Checks that rollback events are considered when keeping the last N fork turns. Rolled-back turn boundaries should not make the truncation cut too far forward.

**Data flow**: The test creates a rollout with a user turn, a triggered inter-agent turn, a rollback of one turn, and then a new user turn. It asks to keep the last two fork turns and expects the whole rollout to remain because, after rollback, the effective boundaries still fit.

**Call relations**: This test runs the last-N-fork-turn truncation logic on a rollout containing ThreadRolledBackEvent. The assertion shows that rollback-aware counting prevents the function from dropping valid earlier context.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `fork_turn_positions_ignore_zero_turn_rollback_markers`  (lines 283–297)

```
fn fork_turn_positions_ignore_zero_turn_rollback_markers()
```

**Purpose**: Checks that a rollback marker saying zero turns were rolled back has no effect. It should not erase or shift fork-turn boundaries.

**Data flow**: The test builds a rollout with a user message, a triggering inter-agent message, a zero-turn rollback event, and another user message. It asks for fork-turn positions and expects all real boundaries to remain.

**Call relations**: This test targets fork_turn_positions_in_rollout directly. It ensures that harmless rollback markers do not disturb the boundary list used by truncation.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_discards_trigger_boundaries_in_rolled_back_suffix`  (lines 300–324)

```
fn truncates_rollout_to_last_n_fork_turns_discards_trigger_boundaries_in_rolled_back_suffix()
```

**Purpose**: Checks that a trigger-turn boundary inside a rolled-back section is ignored. A turn that was undone should not still affect where history is cut.

**Data flow**: The test builds a rollout where a triggered inter-agent task is followed by a rollback, then a new user turn. It asks to keep the last two fork turns and expects the result to start at the second user message, not at the rolled-back trigger boundary.

**Call relations**: This test exercises truncation with both trigger-turn inter-agent messages and rollback markers. It confirms that rollback cleanup happens before choosing the last N effective fork turns.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_discards_rolled_back_assistant_instruction_turns`  (lines 327–353)

```
fn truncates_rollout_to_last_n_fork_turns_discards_rolled_back_assistant_instruction_turns()
```

**Purpose**: Checks that an assistant-instruction style inter-agent turn is discarded if it was rolled back. Only the later active triggered task should count when keeping one fork turn.

**Data flow**: The test builds a rollout with an initial user exchange, a triggered inter-agent task, a rollback that removes that task, and a second triggered inter-agent task. It asks to keep only the last fork turn and expects the output to begin at the second triggered task.

**Call relations**: This test drives the last-N-fork-turn truncation path in a case with two similar inter-agent triggers but only one still active. The assertion makes sure rolled-back trigger boundaries do not survive in the effective history.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `truncates_rollout_to_last_n_fork_turns_keeps_full_rollout_when_n_is_large`  (lines 356–373)

```
fn truncates_rollout_to_last_n_fork_turns_keeps_full_rollout_when_n_is_large()
```

**Purpose**: Checks that asking to keep more fork turns than exist leaves the rollout unchanged. This is the normal “no trimming needed” case.

**Data flow**: The test creates a rollout with a user turn, an assistant reply, a triggered inter-agent turn, and another assistant reply. It asks to keep ten fork turns, which is more than the rollout contains, and compares the result with the original rollout.

**Call relations**: This test calls the last-N-fork-turn truncation logic with a large limit. The equality assertion protects against accidental over-trimming when the requested history window is bigger than the available history.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/turn_metadata_tests.rs`

`test` · `test run`

Codex sends small packets of metadata alongside its work, like labels on a package. Those labels say things such as which session and thread a turn belongs to, what sandbox is active, whether the request is a normal turn or a compaction request, and how a subagent is related to its parent thread. This test file checks that those labels are correct in many important cases.

The tests build temporary workspaces, sometimes real Git repositories, then create a `TurnMetadataState`, which is the object that remembers metadata for a turn. They turn that state into JSON and inspect the result. Several tests focus on safety: client-provided metadata is allowed for ordinary custom fields, but it must not replace reserved fields such as session IDs, thread IDs, installation IDs, lineage fields, or request kind. Other tests check that detached memory requests do not include turn identity, that non-ASCII paths are escaped safely in headers, and that empty workspace information is omitted.

The file also verifies that some metadata appears only in the right place. For example, model and reasoning effort belong in MCP request metadata, not in the general header. Compaction details appear only on compaction requests, not normal turn requests. In short, this file is a guardrail for trustworthy, privacy-aware request labeling.

#### Function details

##### `test_mcp_turn_metadata_context`  (lines 26–31)

```
fn test_mcp_turn_metadata_context() -> McpTurnMetadataContext<'static>
```

**Purpose**: Builds a small, fixed MCP metadata context for tests. MCP means Model Context Protocol, a way for tools and model-related calls to exchange structured information.

**Data flow**: It takes no input. It creates a context with model name `gpt-5.4` and high reasoning effort, then returns that context for tests to pass into metadata-building code.

**Call relations**: Tests that inspect MCP request metadata call this helper so they all use the same model and reasoning-effort values. That keeps those tests focused on where the metadata appears, rather than on repeatedly constructing the same setup.

*Call graph*: called by 3 (turn_metadata_state_includes_model_and_reasoning_effort_only_in_request_meta, turn_metadata_state_marks_user_input_requested_during_turn_only_for_mcp_request_meta, turn_metadata_state_merges_client_metadata_without_replacing_reserved_fields).


##### `test_responses_metadata_json`  (lines 33–46)

```
fn test_responses_metadata_json(
    state: &TurnMetadataState,
    window_id: &str,
    request_kind: CodexResponsesRequestKind,
) -> String
```

**Purpose**: Turns a `TurnMetadataState` into the JSON string that would be sent as Responses API metadata in a specific kind of request. The Responses API is the model request interface this code is preparing metadata for.

**Data flow**: It receives the current turn metadata state, a window ID, and a request kind. It adds a test installation ID and the supplied window ID, asks the state to build Responses metadata, then extracts the final JSON string.

**Call relations**: This is the shared helper behind the normal-turn and compaction metadata helpers. It calls the state’s metadata conversion method so tests can compare the exact JSON that request code would send.

*Call graph*: calls 1 internal fn (to_responses_metadata); called by 2 (test_compaction_responses_metadata_json, test_turn_responses_metadata_json).


##### `test_turn_responses_metadata_json`  (lines 48–50)

```
fn test_turn_responses_metadata_json(state: &TurnMetadataState, window_id: &str) -> String
```

**Purpose**: Creates Responses API metadata JSON for an ordinary turn request. It saves tests from spelling out the normal request kind each time.

**Data flow**: It receives a metadata state and a window ID. It passes both to the general Responses metadata helper with the request kind set to `Turn`, then returns the resulting JSON string.

**Call relations**: Tests use this when they need to compare normal model-request metadata against other request types, especially compaction requests. It delegates the actual building work to `test_responses_metadata_json`.

*Call graph*: calls 1 internal fn (test_responses_metadata_json); called by 2 (turn_metadata_state_merges_client_metadata_without_replacing_reserved_fields, turn_metadata_state_overlays_compaction_only_on_compaction_requests).


##### `test_compaction_responses_metadata_json`  (lines 52–62)

```
fn test_compaction_responses_metadata_json(
    state: &TurnMetadataState,
    window_id: &str,
    compaction: CompactionTurnMetadata,
) -> String
```

**Purpose**: Creates Responses API metadata JSON for a compaction request. Compaction means summarizing or shrinking prior context so the conversation can continue within model limits.

**Data flow**: It receives a metadata state, a window ID, and compaction details such as trigger, reason, implementation, and phase. It wraps those details as a compaction request kind, then returns the JSON built by the shared helper.

**Call relations**: The compaction-specific test calls this helper to check that compaction fields are overlaid only when the request is truly a compaction request. The helper hands the common work to `test_responses_metadata_json`.

*Call graph*: calls 1 internal fn (test_responses_metadata_json); called by 1 (turn_metadata_state_overlays_compaction_only_on_compaction_requests); 1 external calls (Compaction).


##### `test_turn_metadata_header`  (lines 64–69)

```
fn test_turn_metadata_header(state: &TurnMetadataState) -> String
```

**Purpose**: Builds the general turn metadata header JSON from a `TurnMetadataState`. This represents the baseline metadata before a specific model request kind is added.

**Data flow**: It receives the current metadata state. It asks the state for its metadata template, converts that template to JSON, and returns the JSON string.

**Call relations**: Most tests call this helper before parsing the JSON and checking individual fields. It centralizes the header-building step so each test can focus on one behavior, such as lineage, sandbox tags, or reserved-field protection.

*Call graph*: calls 1 internal fn (responses_metadata_template); called by 11 (turn_metadata_state_ignores_client_reserved_metadata_before_start, turn_metadata_state_includes_forked_thread_spawn_subagent_lineage, turn_metadata_state_includes_known_parent_for_non_thread_spawn_subagents_without_fork, turn_metadata_state_includes_model_and_reasoning_effort_only_in_request_meta, turn_metadata_state_includes_root_fork_lineage, turn_metadata_state_includes_thread_spawn_subagent_parent_without_fork, turn_metadata_state_includes_turn_started_at_unix_ms_after_start, turn_metadata_state_marks_user_input_requested_during_turn_only_for_mcp_request_meta, turn_metadata_state_merges_client_metadata_without_replacing_reserved_fields, turn_metadata_state_preserves_lineage_after_git_enrichment (+1 more)).


##### `create_clean_git_repo`  (lines 71–109)

```
async fn create_clean_git_repo(repo_name: &str) -> (TempDir, AbsolutePathBuf)
```

**Purpose**: Creates a temporary Git repository with one committed file for tests that need real workspace metadata. Git is the version-control tool Codex uses here to tell whether a workspace has changes.

**Data flow**: It receives a repository name. It creates a temporary directory, makes a subdirectory with that name, runs Git initialization and user configuration, writes a README file, commits it, and returns both the temporary directory owner and the absolute repository path.

**Call relations**: Tests for detached memory metadata and Git enrichment call this helper when they need a clean repository. It uses filesystem operations and Git commands so the production metadata code sees a realistic workspace.

*Call graph*: called by 2 (detached_memory_responses_metadata_omits_turn_identity, turn_metadata_state_preserves_lineage_after_git_enrichment); 4 external calls (new, new, create_dir_all, write).


##### `detached_memory_responses_metadata_omits_turn_identity`  (lines 112–154)

```
async fn detached_memory_responses_metadata_omits_turn_identity()
```

**Purpose**: Checks that detached memory metadata says it is a memory request but does not include turn-specific identity fields. This matters because memory work can happen outside a normal conversation turn.

**Data flow**: The test creates a clean Git repository whose name includes non-ASCII characters, builds detached memory metadata for it, parses the JSON, and checks the fields. The result should include request kind `memory` and workspace cleanliness, but no session ID, thread ID, fork ID, turn ID, or window ID.

**Call relations**: The test runner calls this asynchronous test. It first relies on `create_clean_git_repo`, then exercises `detached_memory_responses_metadata` and checks the JSON output using parsed values.

*Call graph*: calls 1 internal fn (create_clean_git_repo); 4 external calls (new, assert!, assert_eq!, from_str).


##### `detached_memory_responses_metadata_omits_empty_workspace_metadata`  (lines 157–176)

```
async fn detached_memory_responses_metadata_omits_empty_workspace_metadata()
```

**Purpose**: Checks that detached memory metadata does not include an empty workspace section when there is nothing useful to say. This keeps the metadata compact and avoids misleading empty objects.

**Data flow**: The test creates a temporary directory that is not prepared as a Git repository, asks for detached memory metadata, parses the JSON, and compares it to the exact expected object. The only field left should be `request_kind: memory`.

**Call relations**: The test runner calls this asynchronous test. It directly exercises `detached_memory_responses_metadata` in a minimal workspace and verifies that the metadata builder leaves out empty workspace details.

*Call graph*: 4 external calls (new, new, assert_eq!, from_str).


##### `turn_metadata_state_uses_platform_sandbox_tag`  (lines 179–216)

```
fn turn_metadata_state_uses_platform_sandbox_tag()
```

**Purpose**: Checks that turn metadata records the sandbox policy using the platform-specific sandbox tag. A sandbox is a safety boundary that limits what code or tools can access.

**Data flow**: The test creates a read-only permission profile and a new metadata state, turns that state into header JSON, and reads back key fields. It expects the sandbox field to match the tag computed from the permission profile and Windows sandbox settings, while session and thread IDs are present and unrelated optional fields are absent.

**Call relations**: The test runner calls this unit test. It builds a `TurnMetadataState`, uses `permission_profile_sandbox_tag` as the source of truth for the expected sandbox name, and uses `test_turn_metadata_header` to inspect what the state emits.

*Call graph*: calls 4 internal fn (permission_profile_sandbox_tag, new, test_turn_metadata_header, read_only); 4 external calls (new, assert!, assert_eq!, from_str).


##### `turn_metadata_state_includes_root_fork_lineage`  (lines 219–248)

```
fn turn_metadata_state_includes_root_fork_lineage()
```

**Purpose**: Checks that metadata records the original thread when a thread is forked from another one. This lineage is like a family tree entry for conversation threads.

**Data flow**: The test creates a source thread ID, builds metadata state with that ID as `forked_from_thread_id`, converts the state to JSON, and checks the lineage fields. The fork field should contain the source thread ID, while parent-thread and subagent fields should be absent.

**Call relations**: The test runner calls this unit test. It uses `ThreadId::from_string` for a stable test ID, creates `TurnMetadataState`, and inspects the JSON through `test_turn_metadata_header`.

*Call graph*: calls 4 internal fn (new, test_turn_metadata_header, read_only, from_string); 4 external calls (new, assert!, assert_eq!, from_str).


##### `turn_metadata_state_includes_thread_spawn_subagent_parent_without_fork`  (lines 251–286)

```
fn turn_metadata_state_includes_thread_spawn_subagent_parent_without_fork()
```

**Purpose**: Checks that a subagent created by spawning a new thread records its parent thread even when it is not a fork. A subagent is a helper agent working under another conversation or task.

**Data flow**: The test creates a parent thread ID, builds state whose session source is a thread-spawn subagent, converts the header to JSON, and verifies the result. The parent thread ID and subagent kind should be present, but the fork field should not be.

**Call relations**: The test runner calls this unit test. It constructs a `SessionSource::SubAgent` value, then uses `test_turn_metadata_header` to confirm that subagent lineage is represented correctly.

*Call graph*: calls 4 internal fn (new, test_turn_metadata_header, read_only, from_string); 5 external calls (new, SubAgent, assert!, assert_eq!, from_str).


##### `turn_metadata_state_includes_forked_thread_spawn_subagent_lineage`  (lines 289–327)

```
fn turn_metadata_state_includes_forked_thread_spawn_subagent_lineage()
```

**Purpose**: Checks the case where a thread-spawn subagent is also forked from a thread. Both relationships are important, so neither should erase the other.

**Data flow**: The test creates one thread ID and uses it as both the fork source and parent thread. It builds state, converts it to JSON, and expects both lineage fields plus the `thread_spawn` subagent kind.

**Call relations**: The test runner calls this unit test. It combines fork lineage and subagent source setup, then verifies through `test_turn_metadata_header` that the metadata state preserves both pieces of ancestry.

*Call graph*: calls 4 internal fn (new, test_turn_metadata_header, read_only, from_string); 4 external calls (new, SubAgent, assert_eq!, from_str).


##### `turn_metadata_state_includes_known_parent_for_non_thread_spawn_subagents_without_fork`  (lines 330–369)

```
fn turn_metadata_state_includes_known_parent_for_non_thread_spawn_subagents_without_fork()
```

**Purpose**: Checks that subagents that are not thread-spawn agents can still report a known parent thread. This covers review agents and custom subagent kinds.

**Data flow**: The test creates one parent thread ID and loops through several subagent sources. For each one, it builds metadata state, converts it to JSON, and checks that the parent thread ID and correct subagent kind appear while the fork field stays absent.

**Call relations**: The test runner calls this unit test. Inside the loop it repeatedly creates `TurnMetadataState` with different `SessionSource::SubAgent` values and uses `test_turn_metadata_header` to check the emitted JSON.

*Call graph*: calls 4 internal fn (new, test_turn_metadata_header, read_only, from_string); 6 external calls (new, SubAgent, assert!, assert_eq!, Other, from_str).


##### `turn_metadata_state_includes_turn_started_at_unix_ms_after_start`  (lines 372–398)

```
fn turn_metadata_state_includes_turn_started_at_unix_ms_after_start()
```

**Purpose**: Checks that metadata can include the time a turn started after that time is set. The time is stored as Unix milliseconds, meaning milliseconds since January 1, 1970 UTC.

**Data flow**: The test creates a metadata state, sets a fixed start timestamp, converts the header to JSON, and checks that the timestamp appears as a number with the same value.

**Call relations**: The test runner calls this unit test. It uses `TurnMetadataState::new`, then the state’s setter for turn start time, and finally `test_turn_metadata_header` to confirm the value reaches the JSON output.

*Call graph*: calls 3 internal fn (new, test_turn_metadata_header, read_only); 3 external calls (new, assert_eq!, from_str).


##### `turn_metadata_state_includes_model_and_reasoning_effort_only_in_request_meta`  (lines 401–446)

```
fn turn_metadata_state_includes_model_and_reasoning_effort_only_in_request_meta()
```

**Purpose**: Checks that model name and reasoning effort are placed only in MCP request metadata, not in the general turn header. This prevents ordinary headers from carrying request-specific model settings.

**Data flow**: The test builds a metadata state and first checks the general header JSON, where model and reasoning effort should be absent. It then asks for the current MCP request metadata using a test context and expects model `gpt-5.4` and reasoning effort `high`; when the context has no reasoning effort, that field should be absent.

**Call relations**: The test runner calls this unit test. It uses `test_turn_metadata_header` for the baseline header and `test_mcp_turn_metadata_context` to supply the MCP-specific values that should appear only in MCP metadata.

*Call graph*: calls 4 internal fn (new, test_mcp_turn_metadata_context, test_turn_metadata_header, read_only); 4 external calls (new, assert!, assert_eq!, from_str).


##### `turn_metadata_state_marks_user_input_requested_during_turn_only_for_mcp_request_meta`  (lines 449–498)

```
fn turn_metadata_state_marks_user_input_requested_during_turn_only_for_mcp_request_meta()
```

**Purpose**: Checks that the flag saying user input was requested during a turn appears only in MCP request metadata. This keeps the general header stable while still telling MCP callers about interactive behavior.

**Data flow**: The test builds state and confirms the flag is absent from both the header and MCP metadata at first. It then marks that user input was requested, checks the header again to make sure it is still absent there, and checks MCP metadata to make sure the flag is now true.

**Call relations**: The test runner calls this unit test. It uses `test_turn_metadata_header` to inspect the general header and `test_mcp_turn_metadata_context` to request MCP metadata before and after the state is marked.

*Call graph*: calls 4 internal fn (new, test_mcp_turn_metadata_context, test_turn_metadata_header, read_only); 4 external calls (new, assert!, assert_eq!, from_str).


##### `turn_metadata_state_ignores_client_reserved_metadata_before_start`  (lines 501–541)

```
fn turn_metadata_state_ignores_client_reserved_metadata_before_start()
```

**Purpose**: Checks that client-supplied metadata cannot introduce reserved lineage or timing fields before Codex has set them. Reserved fields are names the system owns because other services rely on their meaning.

**Data flow**: The test creates state, sets client metadata containing reserved keys such as turn start time, fork source, parent thread, and subagent kind, then converts the header to JSON. Since Codex did not set those fields itself, they should all be absent.

**Call relations**: The test runner calls this unit test. It sets client metadata on `TurnMetadataState`, then uses `test_turn_metadata_header` to verify that reserved names from the client are ignored.

*Call graph*: calls 3 internal fn (new, test_turn_metadata_header, read_only); 4 external calls (from, new, assert!, from_str).


##### `turn_metadata_state_merges_client_metadata_without_replacing_reserved_fields`  (lines 544–669)

```
fn turn_metadata_state_merges_client_metadata_without_replacing_reserved_fields()
```

**Purpose**: Checks that ordinary client metadata is kept, but protected Codex-owned fields cannot be overwritten. This is important because metadata is partly extensible, but identity and routing fields must remain trustworthy.

**Data flow**: The test builds a state with fork and parent lineage, adds many client metadata fields, including both allowed custom fields and forbidden reserved fields, then sets a turn start time. It parses the header JSON and checks that custom fields like `fiber_run_id`, `origin`, and `workspace_kind` survive, while Codex-owned fields keep Codex’s values or are omitted when they do not belong in the header. It also checks normal Responses request metadata and MCP request metadata, where installation, window, model, and reasoning fields are supplied from the right sources.

**Call relations**: The test runner calls this larger unit test. It uses `test_turn_metadata_header` for baseline metadata, `test_turn_responses_metadata_json` for model-request metadata, and `test_mcp_turn_metadata_context` for MCP-specific metadata, tying together the main metadata paths under one reserved-field protection scenario.

*Call graph*: calls 6 internal fn (new, test_mcp_turn_metadata_context, test_turn_metadata_header, test_turn_responses_metadata_json, read_only, from_string); 6 external calls (from, new, SubAgent, assert!, assert_eq!, from_str).


##### `turn_metadata_state_overlays_compaction_only_on_compaction_requests`  (lines 672–723)

```
fn turn_metadata_state_overlays_compaction_only_on_compaction_requests()
```

**Purpose**: Checks that compaction details are added only to compaction requests and not to normal turn requests. This prevents a regular model call from being mislabeled as a context-shrinking operation.

**Data flow**: The test creates a state with client metadata that tries to set `compaction`, then builds one compaction request JSON and one normal turn request JSON. The compaction request should contain structured compaction details chosen by Codex, while the normal turn request should have no compaction field.

**Call relations**: The test runner calls this unit test. It uses `test_compaction_responses_metadata_json` for the compaction path and `test_turn_responses_metadata_json` for the regular path, then compares the two outputs.

*Call graph*: calls 5 internal fn (new, new, test_compaction_responses_metadata_json, test_turn_responses_metadata_json, read_only); 5 external calls (from, new, assert!, assert_eq!, from_str).


##### `turn_metadata_state_preserves_lineage_after_git_enrichment`  (lines 726–779)

```
async fn turn_metadata_state_preserves_lineage_after_git_enrichment()
```

**Purpose**: Checks that adding Git workspace information later does not erase thread lineage. Git enrichment is an asynchronous background step that discovers repository details such as whether files have changed.

**Data flow**: The test creates a clean Git repository, builds metadata state for a forked thread-spawn subagent, starts the Git enrichment task, then repeatedly reads the header until workspace metadata appears. Once enrichment is visible, it checks that fork ID, parent thread ID, and subagent kind are still present.

**Call relations**: The test runner calls this asynchronous test. It relies on `create_clean_git_repo` for a real repository, calls the state’s Git enrichment starter, and repeatedly uses `test_turn_metadata_header` until the background update has completed.

*Call graph*: calls 5 internal fn (new, create_clean_git_repo, test_turn_metadata_header, read_only, from_string); 7 external calls (from_millis, from_secs, SubAgent, assert_eq!, from_str, sleep, timeout).


### `core/src/turn_diff_tracker_tests.rs`

`test` · `test run`

The turn diff tracker is meant to answer a simple but important question: “What did this turn change?” This test file puts that answer under pressure. It creates temporary folders, applies real patch text to files, feeds the resulting change records into a TurnDiffTracker, and compares the tracker’s output with exact expected Git-style diffs. A Git-style diff is the familiar before-and-after text format used by Git to show file changes.

The tests cover everyday editing stories: adding a file and then editing it should still look like one new file; deleting and re-adding the same path should look like an update; moving a file without changing its contents should not pretend the contents changed. They also check trickier cases, such as moving a file over an existing destination and tracking the same physical folder under two environment names.

Two tests focus on performance behavior. They make sure cached rendered diffs are reused when possible, and that repeatedly editing one “hot” file does not force unrelated files to be rendered again. The last test checks a huge rewrite. It verifies that diff creation finishes quickly and that applying the generated diff recreates the exact intended content.

#### Function details

##### `git_blob_sha1_hex`  (lines 16–18)

```
fn git_blob_sha1_hex(data: &str) -> String
```

**Purpose**: Computes the Git object identifier that should appear in an expected diff for a given file body. Tests use it so their expected diff headers match the same hash format Git uses for file contents.

**Data flow**: It receives text content as a string, treats that text as bytes, computes the Git blob SHA-1 value for those bytes, and returns the value as lowercase hexadecimal text. It does not change any files or tracker state.

**Call relations**: Many diff-shape tests call this helper while building their expected output. It gives those tests the correct before-and-after object IDs so the final comparison checks the whole diff, not just the visible changed lines.

*Call graph*: called by 9 (accumulates_add_then_update_as_single_add, accumulates_delete, accumulates_move_and_update, add_over_existing_file_becomes_update, delete_then_readd_same_path_becomes_update, move_over_existing_destination_with_content_change_deletes_source_and_updates_destination, move_over_existing_destination_without_content_change_deletes_source_only, preserves_committed_change_order_with_delete_then_move_overwrite, tracks_same_absolute_path_across_multiple_environments); 1 external calls (format!).


##### `apply_verified_patch`  (lines 20–47)

```
async fn apply_verified_patch(root: &Path, patch: &str) -> AppliedPatchDelta
```

**Purpose**: Applies a patch string to a temporary test folder in the same verified way the real system expects patches to be applied. This keeps the tests close to real behavior instead of hand-building fake change records.

**Data flow**: It receives a root folder and patch text. It turns the root into an absolute path, asks the patch parser to verify the patch command, then applies the patch to the local filesystem. It returns an AppliedPatchDelta, which is the structured record of what changed.

**Call relations**: Most async tests call this before asking the tracker to record a change. If verification does not produce the expected patch action, this helper stops the test immediately, because the rest of the test would no longer be testing the tracker with a real valid patch.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 13 (accumulates_add_then_update_as_single_add, accumulates_delete, accumulates_move_and_update, add_over_existing_file_becomes_update, delete_then_readd_same_path_becomes_update, invalidated_tracker_suppresses_existing_diff, move_over_existing_destination_with_content_change_deletes_source_and_updates_destination, move_over_existing_destination_without_content_change_deletes_source_only, preserves_committed_change_order_with_delete_then_move_overwrite, pure_rename_yields_no_diff (+3 more)); 5 external calls (new, apply_patch, maybe_parse_apply_patch_verified, panic!, vec!).


##### `tracker_with_root`  (lines 49–51)

```
fn tracker_with_root(root: &Path) -> TurnDiffTracker
```

**Purpose**: Creates a TurnDiffTracker for a temporary folder, using the simple default display setup used by most tests. It saves each test from repeating the same setup code.

**Data flow**: It receives a filesystem path, stores that path as the tracker’s display root, and returns a fresh tracker with no tracked changes yet.

**Call relations**: Most tests call this at the start, then feed patch deltas into the returned tracker. Tests with special environment-name behavior bypass it and create the tracker directly.

*Call graph*: calls 1 internal fn (with_environment_display_roots); called by 13 (accumulates_add_then_update_as_single_add, accumulates_delete, accumulates_move_and_update, add_over_existing_file_becomes_update, delete_then_readd_same_path_becomes_update, invalidated_tracker_suppresses_existing_diff, large_rewrite_returns_promptly_and_preserves_exact_content, move_over_existing_destination_with_content_change_deletes_source_and_updates_destination, move_over_existing_destination_without_content_change_deletes_source_only, preserves_committed_change_order_with_delete_then_move_overwrite (+3 more)); 1 external calls (to_path_buf).


##### `accumulates_add_then_update_as_single_add`  (lines 54–85)

```
async fn accumulates_add_then_update_as_single_add()
```

**Purpose**: Checks that creating a new file and then editing it during the same turn is shown as one added file containing the final text. This matches what a reader wants to see: the end result of the turn, not every intermediate step.

**Data flow**: The test starts with an empty temporary folder. It applies an add patch for a.txt, tracks it, then applies an update patch that appends another line and tracks that too. The tracker’s final diff is compared with an expected “new file” diff containing both lines.

**Call relations**: The test runner calls this async test. Inside it, the helper applies real verified patches, the tracker records each delta, and git_blob_sha1_hex supplies the expected final object ID for the assertion.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 3 external calls (assert_eq!, format!, tempdir).


##### `invalidated_tracker_suppresses_existing_diff`  (lines 88–102)

```
async fn invalidated_tracker_suppresses_existing_diff()
```

**Purpose**: Checks that once the tracker is marked invalid, it refuses to return an old diff. This protects callers from showing stale or untrustworthy change information.

**Data flow**: The test creates a file through a patch and records that change. It then invalidates the tracker and asks for the unified diff. The expected result is no diff at all.

**Call relations**: The test runner calls this async test. It uses the normal patch helper and tracker setup, then exercises the tracker’s invalidate path before checking get_unified_diff.

*Call graph*: calls 2 internal fn (apply_verified_patch, tracker_with_root); 2 external calls (assert_eq!, tempdir).


##### `tracks_same_absolute_path_across_multiple_environments`  (lines 105–139)

```
async fn tracks_same_absolute_path_across_multiple_environments()
```

**Purpose**: Checks that the same real folder can be shown separately under different environment labels. This matters when one physical path is viewed through more than one named context, such as “local” and “remote.”

**Data flow**: The test applies a patch that creates shared.txt. It builds a tracker with two display roots pointing to the same temporary folder, records the same delta once under each environment name, and expects two separate diff entries with different displayed paths.

**Call relations**: The test runner calls this async test. Unlike most tests, it creates the tracker directly with multiple environment roots, then uses the patch helper and hash helper to build the final exact comparison.

*Call graph*: calls 3 internal fn (with_environment_display_roots, apply_verified_patch, git_blob_sha1_hex); 3 external calls (assert_eq!, format!, tempdir).


##### `accumulates_delete`  (lines 142–166)

```
async fn accumulates_delete()
```

**Purpose**: Checks that deleting an existing file is reported as a deleted file diff. This ensures the tracker preserves the original content well enough to show what was removed.

**Data flow**: The test writes b.txt with one line, applies a delete patch, and records the delta. It then expects a diff whose left side contains the old line and whose right side is the special “no file” destination.

**Call relations**: The test runner calls this async test. It seeds the filesystem directly, uses apply_verified_patch to perform the delete, and uses git_blob_sha1_hex to fill in the expected old content ID.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `accumulates_move_and_update`  (lines 169–194)

```
async fn accumulates_move_and_update()
```

**Purpose**: Checks that a move combined with a content edit is shown as one before-and-after diff from the old path to the new path. This avoids splitting one logical edit into confusing pieces.

**Data flow**: The test starts with src.txt containing one line. It applies a patch that moves the file to dst.txt and changes the line. The tracker’s output is expected to show src.txt on the old side, dst.txt on the new side, and the line replacement.

**Call relations**: The test runner calls this async test. It uses the shared tracker and patch helpers, then relies on the hash helper to make the expected index line match the old and new file contents.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `pure_rename_yields_no_diff`  (lines 197–210)

```
async fn pure_rename_yields_no_diff()
```

**Purpose**: Checks that a pure rename with unchanged content does not produce a content diff. The tracker is focused on text changes, so moving identical content should not be presented as changed text.

**Data flow**: The test writes old.txt, applies a patch that moves it to new.txt while leaving the content the same, and records the delta. When it asks for a unified diff, it expects no diff.

**Call relations**: The test runner calls this async test. It uses the same real patch path as the other tests, but the final assertion checks that the tracker deliberately stays silent for a rename-only change.

*Call graph*: calls 2 internal fn (apply_verified_patch, tracker_with_root); 3 external calls (assert_eq!, write, tempdir).


##### `add_over_existing_file_becomes_update`  (lines 213–238)

```
async fn add_over_existing_file_becomes_update()
```

**Purpose**: Checks that an “add file” patch targeting a path that already exists is reported as an update, not as a brand-new file. This keeps the diff honest about what was on disk before the turn.

**Data flow**: The test seeds dup.txt with “before,” applies an add patch that writes “after” to the same path, and tracks the result. The expected diff shows one line changed from before to after.

**Call relations**: The test runner calls this async test. It combines direct filesystem setup with the real patch helper, then compares the tracker’s output to an exact update diff built with the hash helper.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `delete_then_readd_same_path_becomes_update`  (lines 241–273)

```
async fn delete_then_readd_same_path_becomes_update()
```

**Purpose**: Checks that deleting a file and then adding it back at the same path during one turn is summarized as an update. To a reader, the meaningful result is that the file changed from old content to new content.

**Data flow**: The test starts with cycle.txt containing “before.” It applies and tracks a delete, then applies and tracks an add with “after.” The final expected diff shows a normal one-line replacement.

**Call relations**: The test runner calls this async test. It uses apply_verified_patch twice on the same path and lets the tracker combine those two events into one final comparison.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `move_over_existing_destination_without_content_change_deletes_source_only`  (lines 276–301)

```
async fn move_over_existing_destination_without_content_change_deletes_source_only()
```

**Purpose**: Checks the case where a file is moved over another file that already has identical content. Since the destination content does not really change, the only meaningful visible change is that the source file disappears.

**Data flow**: The test creates a.txt and b.txt with the same text. It applies a move from a.txt to b.txt with unchanged content and records it. The expected diff shows only a deletion of a.txt.

**Call relations**: The test runner calls this async test. It uses the patch helper to perform the overwrite-like move and the hash helper to describe the deleted source file in the expected diff.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `move_over_existing_destination_with_content_change_deletes_source_and_updates_destination`  (lines 304–339)

```
async fn move_over_existing_destination_with_content_change_deletes_source_and_updates_destination()
```

**Purpose**: Checks the harder overwrite case where moving a file onto an existing destination also changes the destination’s content. The tracker should show both that the source was removed and that the destination was updated.

**Data flow**: The test creates a.txt with “from” and b.txt with “existing.” It applies a patch that moves a.txt to b.txt and changes the content to “new.” The expected output contains two diff blocks: one deleting a.txt and one updating b.txt.

**Call relations**: The test runner calls this async test. It uses direct file seeding, verified patch application, and hash generation so the final assertion checks the exact combined diff the tracker produces.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `preserves_committed_change_order_with_delete_then_move_overwrite`  (lines 342–376)

```
async fn preserves_committed_change_order_with_delete_then_move_overwrite()
```

**Purpose**: Checks that when a patch first deletes a destination file and then moves another file into that same name, the tracker still reports the final changes correctly. This guards against ordering bugs in multi-step patches.

**Data flow**: The test creates a source file and an existing destination file. It applies one patch that deletes the destination, then moves and edits the source into that destination path. The expected diff still shows the source deletion and the destination update from its original content to the new content.

**Call relations**: The test runner calls this async test. It feeds one ordered patch into apply_verified_patch, then checks that TurnDiffTracker’s accumulated view matches the intended before-and-after story.

*Call graph*: calls 3 internal fn (apply_verified_patch, git_blob_sha1_hex, tracker_with_root); 4 external calls (assert_eq!, format!, write, tempdir).


##### `reuses_rendered_diffs_for_unchanged_paths`  (lines 379–405)

```
async fn reuses_rendered_diffs_for_unchanged_paths()
```

**Purpose**: Checks that once a file’s diff has been rendered, the tracker does not redo that work when unrelated files change or when the same aggregate diff is read again. This is a performance safeguard.

**Data flow**: The test adds a.txt and checks that one file diff has been rendered. It then adds b.txt and checks that the count rises to two. Finally it reads the full diff twice and confirms the render count stays unchanged.

**Call relations**: The test runner calls this async test. It uses real patch deltas to touch separate paths, then observes the tracker’s rendered_diff_count as a simple counter for whether cached file diffs are being reused.

*Call graph*: calls 2 internal fn (apply_verified_patch, tracker_with_root); 2 external calls (assert_eq!, tempdir).


##### `repeated_updates_only_rerender_the_touched_path`  (lines 408–428)

```
async fn repeated_updates_only_rerender_the_touched_path()
```

**Purpose**: Checks that repeatedly editing one file does not force the tracker to re-render diffs for other files. This matters for long turns where one file may change many times.

**Data flow**: The test creates two files: stable.txt and hot.txt. It then updates hot.txt forty times, tracking each patch. The expected render count is exactly the initial two renders plus one render for each hot-file update.

**Call relations**: The test runner calls this async test. It relies on apply_verified_patch inside a loop and uses rendered_diff_count to confirm that only the changed path is recalculated each time.

*Call graph*: calls 2 internal fn (apply_verified_patch, tracker_with_root); 3 external calls (assert_eq!, format!, tempdir).


##### `large_rewrite_returns_promptly_and_preserves_exact_content`  (lines 431–495)

```
fn large_rewrite_returns_promptly_and_preserves_exact_content()
```

**Purpose**: Checks that rendering a diff for a very large complete rewrite is fast enough and still exact. This protects the system from hanging or producing a patch that corrupts large files.

**Data flow**: The test creates a temporary Git repository, writes a large old file, and prepares a large new version in memory. It asks the tracker to render a diff between the old and new contents, verifies that this finishes in under two seconds, applies the generated diff with Git patch tooling, and finally reads the file back to confirm it exactly equals the new content.

**Call relations**: The test runner calls this synchronous test. It uses tracker_with_root to get a tracker, calls the tracker’s render_diff directly instead of going through apply_verified_patch, then hands the generated diff to apply_git_patch to prove the diff is usable by real patch machinery.

*Call graph*: calls 2 internal fn (new, tracker_with_root); 6 external calls (now, assert!, assert_eq!, apply_git_patch, write, tempdir).


### `core/src/turn_timing_tests.rs`

`test` · `test run`

This is a test file, not production code. It checks that turn timing behaves the way the rest of the system expects. A “turn” is one back-and-forth unit where the user asks something and the assistant responds. The system records moments inside that turn, such as TTFT, meaning “time to first token” or first meaningful assistant output, and TTFM, meaning “time to first message.” These numbers matter because they are used to understand latency: whether the assistant felt slow because the model was thinking, a tool was running, or something else happened.

The tests create fresh timing state, simulate events like text arriving, tool calls appearing, messages being produced, and phases starting or ending. They then check that the timing state records exactly one first-output time per turn, keeps first-token and first-message timing separate, stores the turn start time in Unix time, and ignores events that should not count as first output.

The final test checks a higher-level profile of a turn. It simulates sampling, tool blocking, a retry, and idle gaps, then confirms the completed profile breaks the total time into the expected buckets. In everyday terms, this file is like a stopwatch audit: it makes sure the stopwatch starts, stops, and labels time slices correctly.

#### Function details

##### `turn_timing_state_records_ttft_only_once_per_turn`  (lines 20–48)

```
async fn turn_timing_state_records_ttft_only_once_per_turn()
```

**Purpose**: This test proves that the first-output timing is recorded only once during a turn. It also checks that output before a turn has started, or non-output events, do not accidentally create a timing record.

**Data flow**: It starts with a fresh `TurnTimingState`, then sends it a text event before the turn starts and expects no result. After marking the turn as started, it sends a non-output event and again expects no result. When real text output arrives, it expects a timing value. When more text arrives later, it expects nothing new, showing the first-output time was not counted twice.

**Call relations**: The async test runner calls this test directly. Inside the test, the state object is exercised through its public timing methods, while assertions compare each returned value with the expected result. Nothing is handed back to production code; the test succeeds only if the timing state follows the one-record-per-turn rule.

*Call graph*: 4 external calls (now, assert!, assert_eq!, default).


##### `turn_timing_state_records_ttfm_independently_of_ttft`  (lines 51–83)

```
async fn turn_timing_state_records_ttfm_independently_of_ttft()
```

**Purpose**: This test checks that first-token timing and first-message timing are separate measurements. Recording one should not prevent the other from being recorded.

**Data flow**: It creates a fresh timing state, starts a turn, records the first text output, and expects that to produce a first-token timing value. It then sends an assistant message item and expects a first-message timing value too. A second assistant message is sent afterward, and the test expects no second first-message timing result.

**Call relations**: The async test runner invokes this test as part of the test suite. The test calls the timing state methods in the same order a real turn might produce output and messages, then uses assertions to confirm the state records each kind of first event once and independently.

*Call graph*: 4 external calls (now, assert!, assert_eq!, default).


##### `turn_timing_state_records_turn_started_epoch_millis`  (lines 86–104)

```
async fn turn_timing_state_records_turn_started_epoch_millis()
```

**Purpose**: This test verifies that when a turn starts, the code also records a wall-clock timestamp in Unix time. Unix time means the number of milliseconds or seconds since January 1, 1970, which is useful for logs and analytics across machines.

**Data flow**: It reads the current system time just before starting the turn, then calls `mark_turn_started`, which returns the recorded start time in milliseconds. It reads the system time again afterward and checks that the recorded value falls between those two moments. It also asks the state for the same start time in seconds and checks that it matches the millisecond value divided by 1000.

**Call relations**: The async test runner calls this test. The test uses system time as a reference clock and checks the timing state’s stored values against that reference. This guards the link between internal turn timing and externally readable timestamps used by analytics.

*Call graph*: 5 external calls (now, now, assert!, assert_eq!, default).


##### `response_item_records_turn_ttft_for_first_output_signals`  (lines 107–137)

```
fn response_item_records_turn_ttft_for_first_output_signals()
```

**Purpose**: This test checks which response items should count as the assistant’s first meaningful output for timing purposes. It confirms that tool calls and non-empty assistant text are treated as first-output signals.

**Data flow**: It builds several response items: a regular function call, a custom tool call, and an assistant message containing visible text. Each item is passed to `response_item_records_turn_ttft`, and the test expects `true` each time, meaning each item is allowed to trigger first-output timing.

**Call relations**: The normal test runner invokes this synchronous test. The test focuses on the helper that decides whether a response item should start the TTFT stopwatch, making sure important early outputs are not ignored.

*Call graph*: 1 external calls (assert!).


##### `response_item_records_turn_ttft_ignores_empty_non_output_items`  (lines 140–157)

```
fn response_item_records_turn_ttft_ignores_empty_non_output_items()
```

**Purpose**: This test makes sure the system does not record first-output timing for things that are not real assistant output. That prevents analytics from claiming the assistant responded before it actually produced anything meaningful.

**Data flow**: It creates an assistant message whose text is empty and a function-call output item, which is a tool result rather than a new assistant output. Each is passed to `response_item_records_turn_ttft`, and the test expects `false`, meaning neither should trigger first-output timing.

**Call relations**: The test runner calls this test during the suite. It complements the positive first-output test by checking the opposite cases, helping keep the TTFT decision rule precise rather than too broad.

*Call graph*: 1 external calls (assert!).


##### `turn_profile_breaks_down_sampling_blocking_and_retry_overhead`  (lines 160–194)

```
fn turn_profile_breaks_down_sampling_blocking_and_retry_overhead()
```

**Purpose**: This test checks that a completed turn profile correctly divides elapsed time into meaningful categories. It verifies time spent before sampling, during model sampling, waiting on tools, between sampling attempts, after sampling, and retry counts.

**Data flow**: It starts a profile at a fixed instant, then simulates a timeline: 100 milliseconds before sampling begins, 500 milliseconds of sampling, 300 milliseconds blocked on a tool, one sampling retry, another 200 milliseconds of sampling, and 100 milliseconds after the last sampling. When the profile is completed, the test compares the produced `TurnProfile` with the exact expected numbers.

**Call relations**: The synchronous test runner invokes this test. The test drives `TurnProfileState` through the same phase changes a real turn would experience, then checks the final analytics object. This ensures later reporting can explain where turn time went instead of showing only one undifferentiated total.

*Call graph*: 4 external calls (from_millis, now, assert_eq!, default).


### `core/src/user_shell_command_tests.rs`

`test` · `test suite`

This is a test file. It checks a small but important contract: when a user asks the system to run a shell command, the command and its result must be written down in a clear, machine-readable text block. Think of it like putting a receipt in an envelope labeled “user_shell_command,” with separate sections for what was run and what happened.

The tests cover three main expectations. First, text should only count as a user shell command record if it is wrapped in the special `<user_shell_command>` tags. Plain text like `echo hi` should not be mistaken for one. Second, when a command finishes successfully, the record should include the command, exit code, duration, and output in exactly the expected format. Third, if the execution result contains a combined or “aggregated” output stream, that combined output should be used instead of separately looking at standard output and standard error. This matters because combined output preserves what the user would have seen in order.

Without these tests, a formatting change could silently break later code that reads these records, or the system could store misleading command results.

#### Function details

##### `detects_user_shell_command_text_variants`  (lines 11–16)

```
fn detects_user_shell_command_text_variants()
```

**Purpose**: This test checks that the system can tell the difference between a properly wrapped user shell command record and ordinary text. It protects the rule that only text inside the special command tags should be treated as this kind of record.

**Data flow**: It starts with two pieces of text: one wrapped in `<user_shell_command>` tags and one plain command. It asks `UserShellCommand::matches_text` whether each one matches the expected record shape. The expected outcome is that the wrapped text is accepted and the plain text is rejected.

**Call relations**: During the test run, this function directly exercises the text-matching helper used for recognizing stored user shell command records. It does not build a session or format output; it focuses only on the recognition rule.

*Call graph*: 1 external calls (assert!).


##### `formats_basic_record`  (lines 19–40)

```
async fn formats_basic_record()
```

**Purpose**: This test checks that a normal successful shell command is turned into the exact record text the rest of the system expects. It verifies the command, exit code, duration, and output are all included in the right places.

**Data flow**: It builds a fake command result with exit code `0`, output `hi`, a one-second duration, and no timeout. It also creates a test session context, then passes the command text and fake result into `user_shell_command_record_item`. The function expects to get back a message containing one text item, and it compares that text against the exact wrapped record format.

**Call relations**: This test uses `make_session_and_context` to create the surrounding context that the formatter expects. It then calls the record-building path and checks the final message content, so it verifies not just raw string formatting but also that the formatted record is packaged as a response item correctly.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 4 external calls (from_secs, new, assert_eq!, panic!).


##### `uses_aggregated_output_over_streams`  (lines 43–58)

```
async fn uses_aggregated_output_over_streams()
```

**Purpose**: This test makes sure the formatter prefers the combined command output over separate standard output and standard error text. That is important because the combined output better represents what actually appeared during command execution.

**Data flow**: It builds a fake failed command result with exit code `42`, separate stdout and stderr values, and a different combined output value. After creating a test context, it calls `format_user_shell_command_record` with the command `false`. The expected record contains the combined output text, proving that the separate streams were not used for the final record.

**Call relations**: This test goes straight to the lower-level formatting function instead of checking the response item wrapper. It complements the basic formatting test by focusing on one specific decision inside formatting: which output source is written into the saved command record.

*Call graph*: calls 2 internal fn (make_session_and_context, new); 2 external calls (from_millis, assert_eq!).


### `core/src/image_preparation_tests.rs`

`test` · `test run`

This is a test file. Its job is to prove that image preparation behaves safely and predictably before response items are used elsewhere in the system. A response item can contain user message content or tool output, including images. Some images arrive as data URLs, meaning the image bytes are embedded directly inside a string. Others may be normal web links. The production code under test, `prepare_response_items`, is expected to inspect these items and adjust only the images it understands.

The tests build small fake PNG images in memory, wrap them as data URLs, run preparation, and then decode the result to see what really happened. This is like putting a photo through a copy machine and then measuring the copy, rather than trusting the label on the paper.

The file checks several important promises. Small valid images should keep their exact bytes. Non-data web URLs should not be rewritten. Large images should be resized according to the requested detail level, such as high detail or original detail. Tool-output images get stricter treatment: broken image data, invalid image bytes, or unsupported low-detail requests are replaced with clear placeholder text, while surrounding text and metadata stay intact. The final test also makes sure internal error details are not exposed directly; users get short, bounded, helpful messages instead.

#### Function details

##### `png_data_url`  (lines 17–25)

```
fn png_data_url(width: u32, height: u32) -> (String, Vec<u8>)
```

**Purpose**: Creates a simple one-color PNG image of a requested size and returns it in two forms: as a data URL string and as the raw PNG bytes. Tests use this to make known, controlled image inputs without reading files from disk.

**Data flow**: It receives a width and height. It builds an in-memory image filled with one fixed color, encodes that image as PNG bytes, then wraps those bytes in a `data:image/png;base64,...` URL. It returns both the URL and the original bytes so later tests can compare prepared output against the exact starting image.

**Call relations**: The image-preparation tests call this whenever they need a valid image input. It feeds known images into tests that check byte preservation, resizing budgets, and replacement behavior for tool-output images.

*Call graph*: calls 1 internal fn (new); called by 3 (detail_policies_apply_the_expected_budgets, preparation_preserves_small_image_bytes_and_non_data_urls, preparation_replaces_only_failed_tool_images_and_preserves_metadata); 5 external calls (ImageRgba8, from_pixel, new, data_url_from_bytes, Rgba).


##### `decoded_image`  (lines 27–32)

```
fn decoded_image(image_url: &str) -> (Vec<u8>, DynamicImage)
```

**Purpose**: Turns a processed image data URL back into bytes and a decoded image object so tests can inspect the result. This lets the tests verify the actual image content, not just the string format.

**Data flow**: It receives an image URL string. It splits off the base64 payload after the comma, decodes that text into bytes, then asks the image library to read those bytes as an image. It returns the decoded bytes and the loaded image, which tests can compare or measure.

**Call relations**: The tests use this after running image preparation to check what came out. It is the measuring tool for confirming that small images are unchanged and resized images have the expected dimensions.

*Call graph*: 1 external calls (load_from_memory).


##### `preparation_preserves_small_image_bytes_and_non_data_urls`  (lines 35–72)

```
fn preparation_preserves_small_image_bytes_and_non_data_urls()
```

**Purpose**: Checks that preparation does not disturb things it should leave alone. A small valid embedded image should keep the same PNG bytes, and a normal web URL should stay exactly the same.

**Data flow**: It creates one small PNG data URL and one ordinary HTTPS image URL, places both in a fake user message, and runs image preparation on that message. It then reads the prepared content back: the embedded image is decoded and compared with the original bytes, while the HTTPS URL is compared with the original string.

**Call relations**: This test exercises the normal user-message path through `prepare_response_items`. It relies on `png_data_url` to create a valid embedded image and `decoded_image` to prove the image was not changed.

*Call graph*: calls 1 internal fn (png_data_url); 3 external calls (assert_eq!, panic!, vec!).


##### `detail_policies_apply_the_expected_budgets`  (lines 75–102)

```
fn detail_policies_apply_the_expected_budgets()
```

**Purpose**: Checks that different image detail settings lead to the expected maximum image sizes. This protects the rules that keep images within safe processing limits while preserving as much useful detail as allowed.

**Data flow**: It loops through several combinations of requested detail level and input size. For each case, it creates a PNG of that size, puts it in a user message, runs image preparation, decodes the resulting image, and compares its final width and height with the expected dimensions.

**Call relations**: This test focuses on the resizing policy used by `prepare_response_items`. It uses `png_data_url` for each input case and `decoded_image` to inspect the prepared image dimensions after the policy has been applied.

*Call graph*: calls 1 internal fn (png_data_url); 3 external calls (assert_eq!, panic!, vec!).


##### `preparation_replaces_only_failed_tool_images_and_preserves_metadata`  (lines 105–169)

```
fn preparation_replaces_only_failed_tool_images_and_preserves_metadata()
```

**Purpose**: Checks the stricter behavior for images returned by tools. Bad or unsupported tool images should be replaced with text placeholders, but valid high-detail images and surrounding metadata should remain intact.

**Data flow**: It builds a fake tool-call output containing text, an invalid base64 image URL, non-image bytes disguised as an image, a valid low-detail image, and a valid high-detail image. After preparation, it compares the entire item with the expected result: the bad or unsupported images have become explanatory text, the valid high-detail image remains, and fields such as the call ID, success flag, and metadata are preserved.

**Call relations**: This test drives `prepare_response_items` through the custom tool-output path. It uses `png_data_url` to supply valid image data, then verifies that only the image entries that fail preparation are replaced, rather than rewriting the whole tool response.

*Call graph*: calls 1 internal fn (png_data_url); 2 external calls (assert_eq!, vec!).


##### `preparation_errors_use_bounded_actionable_placeholders`  (lines 172–197)

```
fn preparation_errors_use_bounded_actionable_placeholders()
```

**Purpose**: Checks that image-preparation errors are converted into short placeholder messages meant for users, rather than leaking detailed internal error text. This matters because detailed parsing or size errors may be useful in logs but too noisy or revealing for response content.

**Data flow**: It creates several representative image-preparation errors, including unsupported low detail, an image-too-large error, and an invalid data URL error with extra details. For each one, it asks the error for its placeholder text and compares that with the expected safe message.

**Call relations**: This test focuses on the error-to-placeholder conversion used when image preparation cannot keep an image. It supports the broader preparation flow by ensuring failures become stable, bounded text that can safely replace failed image content.

*Call graph*: 2 external calls (assert_eq!, Processing).


### `core/src/client_common_tests.rs`

`test` · `test run`

This is a test file. Its job is to protect the code that turns Codex's internal prompt and request settings into the JSON shape expected by the Responses API. Without these tests, small changes could accidentally send extra image-detail fields to a lighter API mode, omit required output-format settings, or serialize options with the wrong names.

The file builds small example requests and then checks their serialized JSON. One group of tests focuses on image inputs. Some API modes do not accept the image detail setting, so the prompt formatting code must make a cleaned copy where those details are removed. The test also confirms the original prompt is not changed, like making a photocopy and blacking out a field on the copy rather than marking up the original.

The other tests focus on optional request fields. They verify that text controls are included only when requested, that verbosity becomes the expected lowercase string, that JSON output schemas are wrapped with the right name, type, and strictness flag, and that a flexible service tier is sent as "flex". Together, these tests act as guardrails around the public API contract: the internal Rust objects may be convenient for the program, but the final JSON must match what the remote service understands.

#### Function details

##### `prompt_with_image_outputs`  (lines 12–49)

```
fn prompt_with_image_outputs() -> Prompt
```

**Purpose**: Builds a sample prompt that contains images in three places: a normal user message, a function-call result, and a custom-tool-call result. The tests use it as a known example for checking whether image detail settings are removed when needed.

**Data flow**: It takes no input. It creates a Prompt with several ResponseItem values, each containing an image URL and an image detail level, while leaving all other prompt fields at their default values. It returns that fully built Prompt for a test to inspect or transform.

**Call relations**: This helper is called by responses_lite_request_copies_strip_image_details. It supplies the deliberately image-heavy prompt that lets that test check the prompt-formatting behavior across all supported image locations.

*Call graph*: called by 1 (responses_lite_request_copies_strip_image_details); 2 external calls (default, vec!).


##### `responses_lite_request_copies_strip_image_details`  (lines 52–99)

```
fn responses_lite_request_copies_strip_image_details()
```

**Purpose**: Checks that when a prompt is prepared for the lighter Responses API mode, image detail settings are removed from the outgoing copy. It also checks that the original prompt stays unchanged.

**Data flow**: It starts by asking prompt_with_image_outputs for a prompt with image detail values. It saves a copy of the original input, asks the prompt to format itself for the lite API mode, and compares the result with the expected version where all image detail fields are gone. Then it confirms the stored prompt data is still the same as before, and that non-lite formatting returns the original data.

**Call relations**: This is a standalone test run by the Rust test framework. It depends on prompt_with_image_outputs to provide the example data, then uses equality checks to verify the behavior of Prompt::get_formatted_input_for_request from the surrounding client code.

*Call graph*: calls 1 internal fn (prompt_with_image_outputs); 1 external calls (assert_eq!).


##### `serializes_text_verbosity_when_set`  (lines 102–132)

```
fn serializes_text_verbosity_when_set()
```

**Purpose**: Checks that a request with a text verbosity setting writes that setting into JSON correctly. In this case, the Rust value for low verbosity must become the string "low".

**Data flow**: It builds a ResponsesApiRequest with empty input and tools but with text controls set to low verbosity. It converts the request to JSON and reads the nested text.verbosity field. The expected result is that this field exists and contains "low".

**Call relations**: This test is run directly by the test framework. It exercises the serialization behavior of ResponsesApiRequest and TextControls, using JSON conversion as the point where the internal request object becomes the API payload.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `serializes_text_schema_with_strict_format`  (lines 135–184)

```
fn serializes_text_schema_with_strict_format()
```

**Purpose**: Checks that when the caller asks for structured JSON output with strict validation, the request contains the correct text format block. A schema is a description of what shape the model's answer should have.

**Data flow**: It creates a small JSON schema requiring an answer string. It passes that schema into create_text_param_for_request with strict mode turned on, puts the resulting text controls into a ResponsesApiRequest, and serializes the request to JSON. It then checks that verbosity is absent, and that the format block has the expected name, type, strict flag set to true, and the original schema.

**Call relations**: This test is run by the test framework and calls create_text_param_for_request, the helper that builds API text controls from user-facing settings. It then verifies that ResponsesApiRequest serialization preserves those controls in the exact structure the API expects.

*Call graph*: 6 external calls (assert!, assert_eq!, create_text_param_for_request, json!, to_value, vec!).


##### `serializes_text_schema_with_non_strict_format`  (lines 187–207)

```
fn serializes_text_schema_with_non_strict_format()
```

**Purpose**: Checks that structured-output settings can also be created in non-strict mode. Non-strict mode means the schema is still supplied, but the API is not asked to enforce it as tightly.

**Data flow**: It builds a JSON schema with answer and rationale fields. It passes that schema into create_text_param_for_request with strict mode turned off. From the returned text controls, it extracts the format settings and verifies that strict is false and that the schema was kept unchanged.

**Call relations**: This test focuses on create_text_param_for_request without wrapping the result in a full request serialization check. It complements serializes_text_schema_with_strict_format by covering the other value of the strictness option.

*Call graph*: 4 external calls (assert!, assert_eq!, create_text_param_for_request, json!).


##### `omits_text_when_not_set`  (lines 210–232)

```
fn omits_text_when_not_set()
```

**Purpose**: Checks that the request JSON leaves out the optional text section when no text controls are provided. This matters because sending an empty or unwanted field can change how an API interprets a request.

**Data flow**: It builds a ResponsesApiRequest with text set to None, meaning no text-specific settings are requested. It serializes the request to JSON and checks that there is no top-level text field at all.

**Call relations**: This test is run by the test framework and exercises ResponsesApiRequest serialization. It confirms the optional-field behavior that pairs with the tests where text controls are present.

*Call graph*: 3 external calls (assert!, to_value, vec!).


##### `serializes_flex_service_tier_when_set`  (lines 235–258)

```
fn serializes_flex_service_tier_when_set()
```

**Purpose**: Checks that choosing the flexible service tier is sent to the API as the string "flex". The service tier tells the remote service what kind of processing capacity or priority to use.

**Data flow**: It builds a ResponsesApiRequest with service_tier set to the string form of ServiceTier::Flex. It serializes the request to JSON and reads the service_tier field. The expected output is the string "flex".

**Call relations**: This test is run directly by the test framework. It verifies that the ServiceTier value from the shared protocol types lines up with the JSON payload produced by ResponsesApiRequest.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


### Agent and thread control
These tests exercise agent orchestration, registry and role behavior, delegated subagents, execution limits, residency, and thread lifecycle management.

### `core/src/agent/control_tests.rs`

`test` · `test run`

Agent control is the part of the system that treats conversation threads like agents that can be spawned, messaged, watched, stopped, and later resumed from saved history. This test file checks that those promises hold in many edge cases. It builds temporary test homes, starts fake thread managers, creates parent and child threads, and then checks what operations were sent and what history was saved. Think of it like testing a dispatch office: a parent agent can send work to child agents, children can report back, and the office must know who is open, closed, missing, or archived. The tests cover normal flows, such as sending user input or spawning a child, and failure flows, such as trying to use control after the manager has been dropped. They also test multi-agent version 2 behavior, where agents have paths like `/root/worker`, completion messages are routed carefully, and saved agent trees can be restored. A major theme is safety: closed descendants should stay closed, thread limits should be enforced and released, stale database data should not corrupt the tree, and forked child histories should be cleaned so a child sees only useful parent context.

#### Function details

##### `test_config_with_cli_overrides`  (lines 41–52)

```
async fn test_config_with_cli_overrides(
    cli_overrides: Vec<(String, TomlValue)>,
) -> (TempDir, Config)
```

**Purpose**: Builds a temporary test configuration, optionally pretending that command-line settings were supplied. Tests use it when they need a clean home directory and custom settings such as a maximum agent count.

**Data flow**: It receives a list of configuration overrides, creates a temporary home folder, feeds both into the test configuration builder, and returns the folder plus the finished configuration. The temporary folder stays alive through the returned value so files written during the test do not disappear too soon.

**Call relations**: Several limit and resume tests call this directly when they need special settings. The simpler `test_config` helper calls it with no overrides for the common case.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); called by 6 (resume_agent_releases_slot_after_resume_failure, resume_agent_respects_max_threads_limit, spawn_agent_limit_shared_across_clones, spawn_agent_releases_slot_after_shutdown, spawn_agent_respects_max_threads_limit, test_config); 1 external calls (new).


##### `test_config`  (lines 54–56)

```
async fn test_config() -> (TempDir, Config)
```

**Purpose**: Creates the default test configuration with no command-line overrides. It is the standard starting point for tests that do not need unusual settings.

**Data flow**: It takes no input, asks `test_config_with_cli_overrides` for a configuration with an empty override list, and returns a temporary home folder plus the configuration.

**Call relations**: The harness constructor and several standalone tests use this helper before creating managers or controls. It keeps setup consistent across the file.

*Call graph*: calls 1 internal fn (test_config_with_cli_overrides); called by 7 (new, ensure_v2_agent_loaded_reloads_registered_unloaded_agent, list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root, resume_agent_errors_when_manager_dropped, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_thread_subagent_restores_stored_nickname_and_role, spawn_agent_errors_when_manager_dropped); 1 external calls (new).


##### `text_input`  (lines 58–64)

```
fn text_input(text: &str) -> Op
```

**Purpose**: Turns a plain string into the operation format used for user input. This lets tests write short readable prompts instead of building the full message structure each time.

**Data flow**: It receives text, wraps it as one `UserInput::Text` item with no extra text elements, and converts the list into an `Op`. The output is ready to submit to an agent.

**Call relations**: Most spawn and resume tests use this helper when they need to give an agent an initial task. It keeps the test setup focused on behavior rather than message boilerplate.

*Call graph*: called by 31 (encrypted_inter_agent_communication_clears_existing_last_task_message, ensure_v2_agent_loaded_reloads_registered_unloaded_agent, list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root, list_agent_subtree_thread_ids_includes_anonymous_and_closed_descendants, multi_agent_v2_completion_ignores_dead_direct_parent, resume_agent_from_rollout_does_not_reopen_closed_descendants, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_agent_from_rollout_reads_archived_rollout_path, resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown, resume_agent_from_rollout_skips_descendants_when_parent_resume_fails (+15 more)); 1 external calls (vec!).


##### `assistant_message`  (lines 66–76)

```
fn assistant_message(text: &str, phase: Option<MessagePhase>) -> ResponseItem
```

**Purpose**: Creates a simple assistant response item with optional phase information. Tests use it to seed histories with final answers, commentary, or unknown-phase messages.

**Data flow**: It receives message text and an optional message phase, wraps the text as assistant output, and returns a `ResponseItem`. It does not write anywhere by itself.

**Call relations**: History-forking tests use this to build parent histories, then check whether child histories keep or remove those assistant messages correctly.

*Call graph*: called by 2 (spawn_agent_can_fork_parent_thread_history_with_sanitized_items, spawn_agent_fork_flushes_parent_rollout_before_loading_history); 1 external calls (vec!).


##### `register_session_root_skips_threads_with_explicit_parent`  (lines 79–85)

```
fn register_session_root_skips_threads_with_explicit_parent()
```

**Purpose**: Checks that a thread with an explicit parent is not registered as the root agent. This matters because parent-child trees would be wrong if child threads could overwrite the root path.

**Data flow**: It creates a default control object, tries to register a new thread as a session root while also giving it a parent, and then reads the root path mapping. The expected result is that no root agent is recorded.

**Call relations**: This is a standalone synchronous test of the control state bookkeeping. It targets the root registration rule directly without starting a thread manager.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, default).


##### `spawn_agent_call`  (lines 87–96)

```
fn spawn_agent_call(call_id: &str) -> ResponseItem
```

**Purpose**: Builds a fake assistant function-call item for `spawn_agent`. Tests use this marker to simulate the exact point in a parent history where a child was spawned.

**Data flow**: It receives a call identifier, creates a response item representing a `spawn_agent` function call with empty arguments, and returns it for insertion into test history.

**Call relations**: Forking tests place this item in parent history so the child-spawn code can find the matching spawn point and copy the right surrounding history.

*Call graph*: called by 6 (spawn_agent_can_fork_parent_thread_history_with_sanitized_items, spawn_agent_fork_flushes_parent_rollout_before_loading_history, spawn_agent_fork_last_n_turns_drops_parent_startup_prefix_when_under_limit, spawn_agent_fork_last_n_turns_keeps_only_recent_turns, spawn_agent_fork_last_n_turns_strips_parent_usage_hints, spawn_agent_fork_strips_parent_usage_hints_from_compacted_history).


##### `AgentControlHarness::new`  (lines 107–110)

```
async fn new() -> Self
```

**Purpose**: Creates the standard test harness with default configuration. It is a convenient one-line setup for tests that need a thread manager, agent control, and temporary home.

**Data flow**: It creates a default test configuration, passes it into `AgentControlHarness::new_with_config`, and returns the fully prepared harness.

**Call relations**: Most async tests start here. It hides repeated setup so each test can focus on the behavior it is checking.

*Call graph*: calls 1 internal fn (test_config); called by 30 (completion_watcher_notifies_parent_when_child_is_missing, encrypted_inter_agent_communication_clears_existing_last_task_message, get_status_returns_not_found_for_missing_thread, get_status_returns_pending_init_for_new_thread, list_agent_subtree_thread_ids_includes_anonymous_and_closed_descendants, multi_agent_v2_completion_ignores_dead_direct_parent, multi_agent_v2_completion_queues_message_for_direct_parent, resume_agent_from_rollout_does_not_reopen_closed_descendants, resume_agent_from_rollout_reads_archived_rollout_path, resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown (+15 more)); 1 external calls (new_with_config).


##### `AgentControlHarness::new_with_config`  (lines 112–129)

```
async fn new_with_config(home: TempDir, config: Config) -> Self
```

**Purpose**: Creates a test harness from a supplied configuration. Tests use it when they need features such as SQLite or multi-agent version 2 enabled before the manager starts.

**Data flow**: It receives a temporary home and configuration, initializes the optional state database, builds a test `ThreadManager`, takes an `AgentControl` handle from it, and stores all of that in the harness.

**Call relations**: The default harness constructor delegates to this, and feature-specific tests call it directly. It wires together the fake authentication, model provider, environment manager, state database, manager, and control handle.

*Call graph*: calls 3 internal fn (with_models_provider_home_and_state_for_tests, default_for_tests, from_api_key); called by 2 (ensure_v2_agent_loaded_reloads_registered_unloaded_agent, resume_agent_from_rollout_does_not_reopen_v2_descendants); 2 external calls (init_state_db, new).


##### `AgentControlHarness::start_thread`  (lines 131–138)

```
async fn start_thread(&self) -> (ThreadId, Arc<CodexThread>)
```

**Purpose**: Starts a new thread using the harness configuration. It gives tests both the thread identifier and the live thread object.

**Data flow**: It reads the harness configuration, asks the manager to start a thread, and returns the new thread ID with the shared thread handle. If starting fails, the test fails immediately.

**Call relations**: Many tests use this after creating a harness to create parent threads or independent agents before exercising control operations.

*Call graph*: calls 1 internal fn (start_thread); 1 external calls (clone).


##### `has_subagent_notification`  (lines 141–156)

```
fn has_subagent_notification(history_items: &[ResponseItem]) -> bool
```

**Purpose**: Checks whether a saved history contains a user-facing notification about a subagent. This is used to confirm that parent threads are told when child agents finish or disappear.

**Data flow**: It receives a slice of response items, scans only user messages, examines their text content, and returns true if any text matches the subagent notification format.

**Call relations**: `wait_for_subagent_notification` repeatedly calls this while polling a parent thread history. Tests then use that wait helper to verify completion notifications.

*Call graph*: called by 1 (wait_for_subagent_notification); 1 external calls (iter).


##### `history_contains_text`  (lines 159–171)

```
fn history_contains_text(history_items: &[ResponseItem], needle: &str) -> bool
```

**Purpose**: Looks for a piece of text anywhere inside message history. Tests use it for simple checks that expected context was kept or unwanted context was removed.

**Data flow**: It receives history items and a search string, scans text spans in message items, and returns true if any text contains the search string.

**Call relations**: History-forking and notification tests use this helper after they clone a thread history. It keeps assertions readable without exposing the nested message structure each time.

*Call graph*: 1 external calls (iter).


##### `history_contains_assistant_inter_agent_communication`  (lines 173–194)

```
fn history_contains_assistant_inter_agent_communication(
    history_items: &[ResponseItem],
    expected: &InterAgentCommunication,
) -> bool
```

**Purpose**: Checks whether assistant history contains a specific inter-agent communication encoded as JSON text. This helps tests prove that messages were or were not written into conversation history.

**Data flow**: It receives history items and an expected communication object, scans assistant output text, tries to parse each text span as an inter-agent communication, and returns true only for an exact match.

**Call relations**: Messaging and completion watcher tests use it to ensure queued messages do not accidentally appear in the wrong history, especially in multi-agent version 2 routing.

*Call graph*: 1 external calls (iter).


##### `wait_for_subagent_notification`  (lines 196–215)

```
async fn wait_for_subagent_notification(parent_thread: &Arc<CodexThread>) -> bool
```

**Purpose**: Waits until a parent thread history shows a subagent notification, or gives up after a timeout. This avoids flaky tests when background watcher tasks need a short time to run.

**Data flow**: It receives a parent thread, repeatedly clones its history, checks it with `has_subagent_notification`, sleeps briefly between attempts, and returns whether the notification appeared within the time limit.

**Call relations**: Completion-related tests call this after child shutdowns or missing-child watcher setup. It bridges asynchronous background work and deterministic assertions.

*Call graph*: calls 1 internal fn (has_subagent_notification); 4 external calls (from_millis, from_secs, sleep, timeout).


##### `persist_thread_for_tree_resume`  (lines 217–228)

```
async fn persist_thread_for_tree_resume(thread: &Arc<CodexThread>, message: &str)
```

**Purpose**: Forces a thread to have saved rollout history that can later be used for resume tests. A rollout is the saved record of a conversation thread.

**Data flow**: It receives a live thread and a message, injects the message without starting a turn, materializes the rollout, flushes it to storage, and returns nothing. The thread’s saved history is changed on disk.

**Call relations**: Tree resume and shutdown tests use this before closing managers or agents. Without it, resume tests would not have reliable saved thread data to reopen.

*Call graph*: called by 9 (resume_agent_from_rollout_does_not_reopen_closed_descendants, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_agent_from_rollout_reads_archived_rollout_path, resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown, resume_agent_from_rollout_skips_descendants_when_parent_resume_fails, resume_agent_from_rollout_uses_edge_data_when_descendant_metadata_source_is_stale, resume_closed_child_reopens_open_descendants, shutdown_agent_tree_closes_descendants_when_started_at_child, shutdown_agent_tree_closes_live_descendants).


##### `wait_for_live_thread_spawn_children`  (lines 230–256)

```
async fn wait_for_live_thread_spawn_children(
    control: &AgentControl,
    parent_thread_id: ThreadId,
    expected_children: &[ThreadId],
)
```

**Purpose**: Waits until the control layer reports exactly the expected live child threads for a parent. This makes tests wait for parent-child links to be persisted before continuing.

**Data flow**: It receives the control handle, a parent thread ID, and expected child IDs. It repeatedly asks for the parent’s open spawned children, sorts both actual and expected lists, and finishes once they match or fails on timeout.

**Call relations**: Tree shutdown and resume tests call it before simulating restarts. It ensures later assertions are testing resume behavior, not racing against unfinished child registration.

*Call graph*: calls 1 internal fn (open_thread_spawn_children); called by 8 (resume_agent_from_rollout_does_not_reopen_closed_descendants, resume_agent_from_rollout_does_not_reopen_v2_descendants, resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown, resume_agent_from_rollout_skips_descendants_when_parent_resume_fails, resume_agent_from_rollout_uses_edge_data_when_descendant_metadata_source_is_stale, resume_closed_child_reopens_open_descendants, shutdown_agent_tree_closes_descendants_when_started_at_child, shutdown_agent_tree_closes_live_descendants); 6 external calls (from_millis, from_secs, sort_by_key, to_vec, sleep, timeout).


##### `assert_thread_not_loaded`  (lines 258–264)

```
async fn assert_thread_not_loaded(manager: &ThreadManager, thread_id: ThreadId)
```

**Purpose**: Asserts that a given thread is not currently loaded in a manager. This is useful when testing that resume does not reopen descendants it should leave closed.

**Data flow**: It receives a manager and thread ID, asks the manager for the thread, and treats `ThreadNotFound` for that same ID as success. Any loaded thread or different error fails the test.

**Call relations**: The multi-agent version 2 resume test uses this to prove that only the root was reopened and descendant agents stayed unloaded.

*Call graph*: calls 1 internal fn (get_thread); called by 1 (resume_agent_from_rollout_does_not_reopen_v2_descendants); 2 external calls (assert_eq!, panic!).


##### `send_input_errors_when_manager_dropped`  (lines 267–284)

```
async fn send_input_errors_when_manager_dropped()
```

**Purpose**: Verifies that sending input through an orphaned control handle fails clearly. An orphaned control has no thread manager behind it.

**Data flow**: It creates a default control with no manager, tries to send a text message to a new thread ID, and checks that the returned error says the thread manager was dropped.

**Call relations**: This standalone async test protects the failure behavior used when callers keep a control handle longer than the manager lifetime.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, default, vec!).


##### `get_status_returns_not_found_without_manager`  (lines 287–291)

```
async fn get_status_returns_not_found_without_manager()
```

**Purpose**: Checks that asking for status through an orphaned control returns `NotFound` instead of crashing. This gives callers a safe answer when the manager is gone.

**Data flow**: It creates a default control with no manager, asks for the status of a new thread ID, and expects `AgentStatus::NotFound`.

**Call relations**: This test pairs with other dropped-manager tests to define safe behavior for stale control handles.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, default).


##### `on_event_updates_status_from_task_started`  (lines 294–303)

```
async fn on_event_updates_status_from_task_started()
```

**Purpose**: Confirms that a turn-started event becomes a running agent status. A turn is one unit of agent work.

**Data flow**: It builds a `TurnStarted` event, feeds it to `agent_status_from_event`, and expects `AgentStatus::Running`.

**Call relations**: This unit test checks the event-to-status translation used by agent control watchers.

*Call graph*: 3 external calls (assert_eq!, agent_status_from_event, TurnStarted).


##### `on_event_updates_status_from_task_complete`  (lines 306–316)

```
async fn on_event_updates_status_from_task_complete()
```

**Purpose**: Confirms that a completed turn becomes a completed agent status and keeps the last assistant message. This message is often what a parent or user cares about.

**Data flow**: It builds a `TurnComplete` event with the text `done`, converts it to a status, and expects a completed status containing that text.

**Call relations**: This supports completion watcher behavior, where finished child agents may report their final message upward.

*Call graph*: 4 external calls (assert_eq!, agent_status_from_event, Completed, TurnComplete).


##### `on_event_updates_status_from_error`  (lines 319–327)

```
async fn on_event_updates_status_from_error()
```

**Purpose**: Confirms that an error event becomes an errored agent status. This keeps failures visible instead of silently treating them as normal completion.

**Data flow**: It builds an error event with message `boom`, converts it through `agent_status_from_event`, and expects an errored status with the same message.

**Call relations**: This unit test protects the status translation used by status subscribers and completion notifications.

*Call graph*: 4 external calls (assert_eq!, agent_status_from_event, Errored, Error).


##### `on_event_updates_status_from_turn_aborted`  (lines 330–340)

```
async fn on_event_updates_status_from_turn_aborted()
```

**Purpose**: Confirms that an interrupted turn becomes an interrupted agent status. This distinguishes a stopped task from a successful or failed one.

**Data flow**: It builds a turn-aborted event with the interrupted reason, converts it to status, and expects `AgentStatus::Interrupted`.

**Call relations**: This is one of the small event translation tests that define how runtime events become public agent status.

*Call graph*: 3 external calls (assert_eq!, agent_status_from_event, TurnAborted).


##### `on_event_updates_status_from_shutdown_complete`  (lines 343–346)

```
async fn on_event_updates_status_from_shutdown_complete()
```

**Purpose**: Confirms that a shutdown-complete event becomes a shutdown status. This tells callers that an agent has fully stopped.

**Data flow**: It passes a shutdown event into the status conversion helper and expects `AgentStatus::Shutdown`.

**Call relations**: Status subscription tests rely on this mapping when a thread receives a shutdown operation.

*Call graph*: 2 external calls (assert_eq!, agent_status_from_event).


##### `spawn_agent_errors_when_manager_dropped`  (lines 349–360)

```
async fn spawn_agent_errors_when_manager_dropped()
```

**Purpose**: Verifies that spawning through an orphaned control handle fails with a clear unsupported-operation error. This prevents hidden panics when the manager is gone.

**Data flow**: It creates a normal config, uses a default control with no manager, attempts to spawn an agent with text input, and checks the error message.

**Call relations**: This mirrors the send-input dropped-manager test, but for agent creation.

*Call graph*: calls 2 internal fn (test_config, text_input); 2 external calls (assert_eq!, default).


##### `resume_agent_errors_when_manager_dropped`  (lines 363–374)

```
async fn resume_agent_errors_when_manager_dropped()
```

**Purpose**: Verifies that resuming an agent through an orphaned control handle fails clearly. Resume needs a live manager to load saved rollout data.

**Data flow**: It creates a config, creates a default control without a manager, attempts to resume a new thread ID, and checks for the manager-dropped error.

**Call relations**: This completes the dropped-manager coverage for the main control operations: send, spawn, and resume.

*Call graph*: calls 2 internal fn (test_config, new); 2 external calls (assert_eq!, default).


##### `send_input_errors_when_thread_missing`  (lines 377–393)

```
async fn send_input_errors_when_thread_missing()
```

**Purpose**: Checks that sending input to an unknown thread reports `ThreadNotFound`. This protects callers from thinking a message was delivered when no such thread exists.

**Data flow**: It creates a harness, chooses a fresh thread ID, sends text input to it, and verifies the error contains that same missing ID.

**Call relations**: This test uses the full harness rather than an orphaned control, so it checks the normal manager-backed missing-thread path.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert_matches!, vec!).


##### `get_status_returns_not_found_for_missing_thread`  (lines 396–400)

```
async fn get_status_returns_not_found_for_missing_thread()
```

**Purpose**: Checks that status lookup for an unknown thread returns `NotFound`. This gives callers a simple status value for missing agents.

**Data flow**: It creates a harness, asks for the status of a fresh thread ID, and expects `AgentStatus::NotFound`.

**Call relations**: This is the manager-backed counterpart to the no-manager status test.

*Call graph*: calls 2 internal fn (new, new); 1 external calls (assert_eq!).


##### `get_status_returns_pending_init_for_new_thread`  (lines 403–408)

```
async fn get_status_returns_pending_init_for_new_thread()
```

**Purpose**: Checks that a newly started thread begins in `PendingInit`. This status means the thread exists but has not yet advanced to active work.

**Data flow**: It creates a harness, starts a thread, asks control for that thread’s status, and expects `PendingInit`.

**Call relations**: This establishes the initial status used by later subscription and status transition tests.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `subscribe_status_errors_for_missing_thread`  (lines 411–420)

```
async fn subscribe_status_errors_for_missing_thread()
```

**Purpose**: Checks that subscribing to status updates for an unknown thread fails with `ThreadNotFound`. Subscriptions should not silently attach to nothing.

**Data flow**: It creates a harness, asks to subscribe to a fresh thread ID, and verifies the missing-thread error contains that ID.

**Call relations**: This test covers the subscription path, while other missing-thread tests cover one-time send and status lookup paths.

*Call graph*: calls 2 internal fn (new, new); 1 external calls (assert_matches!).


##### `subscribe_status_updates_on_shutdown`  (lines 423–440)

```
async fn subscribe_status_updates_on_shutdown()
```

**Purpose**: Checks that a status subscription receives a shutdown update after the thread is told to stop. This proves watchers see real runtime changes.

**Data flow**: It starts a thread, subscribes to its status, confirms the initial pending state, submits a shutdown operation, waits for the subscription to change, and expects `Shutdown`.

**Call relations**: It connects the event-to-status conversion tests with the live subscription mechanism.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `send_input_submits_user_message`  (lines 443–479)

```
async fn send_input_submits_user_message()
```

**Purpose**: Verifies that `send_input` turns a caller’s text into the exact user-input operation sent to the thread. This is the core delivery path for user messages.

**Data flow**: It starts a thread, sends text through control, checks that a nonempty submission ID is returned, and inspects the manager’s captured operations for the expected user-input operation.

**Call relations**: This test exercises the normal manager-backed send path and uses captured operations as the evidence of delivery.

*Call graph*: calls 1 internal fn (new); 4 external calls (default, assert!, assert_eq!, vec!).


##### `send_inter_agent_communication_without_turn_queues_message_without_triggering_turn`  (lines 482–541)

```
async fn send_inter_agent_communication_without_turn_queues_message_without_triggering_turn()
```

**Purpose**: Checks that an inter-agent message marked not to trigger a turn is queued but does not immediately appear as assistant history. This prevents background messages from accidentally starting work.

**Data flow**: It starts a thread, sends a communication with `trigger_turn` set to false, verifies the operation was submitted, waits until pending input exists, and checks history does not contain that communication as an assistant message.

**Call relations**: This test focuses on the control path for agent-to-agent messaging and the difference between queuing input and starting a new turn.

*Call graph*: calls 4 internal fn (new, root, try_from, new); 7 external calls (from_millis, from_secs, new, assert!, assert_eq!, sleep, timeout).


##### `ensure_v2_agent_loaded_reloads_registered_unloaded_agent`  (lines 544–633)

```
async fn ensure_v2_agent_loaded_reloads_registered_unloaded_agent()
```

**Purpose**: Verifies that a known multi-agent version 2 child can be reloaded after being removed from memory. This matters when a saved child agent must receive new messages later.

**Data flow**: It enables multi-agent v2 and SQLite, spawns a child with an agent path, persists child output, shuts it down, removes it from the manager, calls `ensure_v2_agent_loaded`, and then sends an inter-agent message to prove it is usable again.

**Call relations**: This test combines spawning, persistence, manager removal, v2 agent lookup, reload, and message submission.

*Call graph*: calls 6 internal fn (new_with_config, test_config, text_input, root, try_from, new); 7 external calls (default, new, SubAgent, assert!, assert_eq!, panic!, vec!).


##### `resume_agent_from_rollout_does_not_reopen_v2_descendants`  (lines 636–723)

```
async fn resume_agent_from_rollout_does_not_reopen_v2_descendants()
```

**Purpose**: Checks that resuming a multi-agent version 2 root thread does not automatically reopen its descendant agents. Version 2 agents are loaded on demand instead.

**Data flow**: It creates a root, worker, and reviewer, persists all rollouts, verifies live child links, shuts everything down, creates a fresh manager using the same state, resumes only the root, and asserts the descendants are not loaded.

**Call relations**: It uses the persistence and child-wait helpers, then uses `assert_thread_not_loaded` to make the v2 resume rule explicit.

*Call graph*: calls 10 internal fn (new_with_config, assert_thread_not_loaded, persist_thread_for_tree_resume, test_config, text_input, wait_for_live_thread_spawn_children, with_models_provider_home_and_state_for_tests, default_for_tests, from_api_key, root); 5 external calls (from_secs, SubAgent, assert_eq!, assert_ne!, new).


##### `encrypted_inter_agent_communication_clears_existing_last_task_message`  (lines 726–779)

```
async fn encrypted_inter_agent_communication_clears_existing_last_task_message()
```

**Purpose**: Checks that sending an encrypted inter-agent task removes the stored plain-text last task message. This avoids keeping sensitive task text in metadata after an encrypted replacement arrives.

**Data flow**: It spawns a child with an initial plain-text task, confirms that task is stored in metadata, sends an encrypted communication to the child, and verifies the stored last task message is now absent.

**Call relations**: This test protects privacy-related metadata behavior in the inter-agent communication path.

*Call graph*: calls 5 internal fn (new, text_input, root, try_from, new_encrypted); 4 external calls (default, new, SubAgent, assert_eq!).


##### `spawn_agent_creates_thread_and_sends_prompt`  (lines 782–817)

```
async fn spawn_agent_creates_thread_and_sends_prompt()
```

**Purpose**: Verifies that spawning an agent both creates a thread and sends the initial prompt to it. A spawn would be useless if the new agent existed but never got its task.

**Data flow**: It spawns an agent with text input, retrieves the new thread from the manager, and checks captured operations for the expected user-input operation on that thread.

**Call relations**: This is the basic happy-path spawn test that many more specialized spawn tests build on.

*Call graph*: calls 2 internal fn (new, text_input); 3 external calls (default, assert_eq!, vec!).


##### `spawn_agent_can_fork_parent_thread_history_with_sanitized_items`  (lines 820–1055)

```
async fn spawn_agent_can_fork_parent_thread_history_with_sanitized_items()
```

**Purpose**: Checks full-history forking: a child agent can start with useful parent history, but noisy or unsafe items are filtered out. It also checks that parent usage hints are replaced with child-specific guidance.

**Data flow**: It builds a parent history containing user context, developer hints, assistant commentary and final answers, reasoning, inter-agent messages, and a spawn call. It then spawns a child in full-history fork mode and verifies the child history keeps only the allowed parent context plus the child hint, preserves the reference context, and still receives its task.

**Call relations**: This test uses `assistant_message`, `spawn_agent_call`, and text/history helpers to exercise the most complex spawn fork behavior.

*Call graph*: calls 7 internal fn (new, assistant_message, spawn_agent_call, text_input, root, try_from, new); 8 external calls (default, new, SubAgent, assert!, assert_eq!, assert_ne!, TurnContext, vec!).


##### `spawn_agent_fork_strips_parent_usage_hints_from_compacted_history`  (lines 1058–1176)

```
async fn spawn_agent_fork_strips_parent_usage_hints_from_compacted_history()
```

**Purpose**: Checks that parent usage hints are removed even when the parent history has been compacted into a replacement summary. Compaction means older history has been summarized to save space.

**Data flow**: It writes a compacted parent rollout containing normal summary text and a stale parent hint, adds a spawn call, spawns a forked child, and checks that the child keeps the summary, removes the parent hint, and adds the child subagent hint.

**Call relations**: This extends the fork-history cleanup rules to compacted rollout data rather than only live raw history.

*Call graph*: calls 3 internal fn (new, spawn_agent_call, text_input); 8 external calls (default, new, SubAgent, assert!, Compacted, ResponseItem, TurnContext, vec!).


##### `spawn_agent_fork_flushes_parent_rollout_before_loading_history`  (lines 1179–1238)

```
async fn spawn_agent_fork_flushes_parent_rollout_before_loading_history()
```

**Purpose**: Checks that forking flushes the parent’s unsaved rollout before reading history. Without this, a child could miss the most recent parent answer.

**Data flow**: It records an assistant final answer and spawn call in the parent without manually flushing, spawns a full-history forked child, and verifies the child history includes that final answer.

**Call relations**: This test proves the spawn flow performs necessary persistence before copying parent history.

*Call graph*: calls 4 internal fn (new, assistant_message, spawn_agent_call, text_input); 3 external calls (default, SubAgent, assert!).


##### `spawn_agent_fork_last_n_turns_keeps_only_recent_turns`  (lines 1241–1377)

```
async fn spawn_agent_fork_last_n_turns_keeps_only_recent_turns()
```

**Purpose**: Checks bounded forking, where a child receives only the last N parent turns rather than all history. This keeps child context focused and smaller.

**Data flow**: It builds older parent context, queued and triggered inter-agent messages, a current parent task, and a spawn marker. It spawns a child with `LastNTurns(2)` and verifies old context and inter-agent messages are dropped while the current task remains and cached reference context is cleared.

**Call relations**: This test exercises the `LastNTurns` fork mode and confirms it also applies the same sanitizing rules used by full-history forks.

*Call graph*: calls 6 internal fn (new, spawn_agent_call, text_input, root, try_from, new); 6 external calls (default, new, SubAgent, assert!, LastNTurns, TurnContext).


##### `spawn_agent_fork_last_n_turns_drops_parent_startup_prefix_when_under_limit`  (lines 1380–1480)

```
async fn spawn_agent_fork_last_n_turns_drops_parent_startup_prefix_when_under_limit()
```

**Purpose**: Checks that bounded forking drops parent startup context even if there are fewer turns than the requested limit. Startup context often belongs to the parent, not the child.

**Data flow**: It records parent developer startup context, adds a current user task and spawn call, spawns a child with a last-two-turns fork, and verifies the task remains while the startup developer text is absent.

**Call relations**: This narrows the bounded-fork rule so that startup prefix data is not accidentally kept just because the history is short.

*Call graph*: calls 3 internal fn (new, spawn_agent_call, text_input); 5 external calls (default, SubAgent, assert!, LastNTurns, vec!).


##### `spawn_agent_fork_last_n_turns_strips_parent_usage_hints`  (lines 1483–1582)

```
async fn spawn_agent_fork_last_n_turns_strips_parent_usage_hints()
```

**Purpose**: Checks that bounded forking also removes stale parent usage hints. A child should not inherit instructions meant for the parent root agent.

**Data flow**: It creates a parent with a root usage hint and a task, spawns a child with last-N-turns mode and child subagent guidance, then verifies parent task text remains but the parent hint is gone.

**Call relations**: This is the last-N counterpart to the full-history and compacted-history hint cleanup tests.

*Call graph*: calls 3 internal fn (new, spawn_agent_call, text_input); 5 external calls (default, SubAgent, assert!, LastNTurns, vec!).


##### `spawn_agent_respects_max_threads_limit`  (lines 1585–1634)

```
async fn spawn_agent_respects_max_threads_limit()
```

**Purpose**: Verifies that spawning agents honors the configured maximum number of live agent threads. This prevents uncontrolled agent creation.

**Data flow**: It configures `agents.max_threads` as one, starts a regular thread, spawns one agent successfully, then attempts a second spawn and expects an `AgentLimitReached` error carrying the configured limit.

**Call relations**: This starts the group of tests around the shared live-agent slot guard.

*Call graph*: calls 5 internal fn (test_config_with_cli_overrides, text_input, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 4 external calls (assert_eq!, panic!, new, vec!).


##### `spawn_agent_releases_slot_after_shutdown`  (lines 1637–1677)

```
async fn spawn_agent_releases_slot_after_shutdown()
```

**Purpose**: Checks that an agent slot is released when an agent shuts down. Otherwise the system would permanently block new agents after old ones stop.

**Data flow**: It sets the max agent count to one, spawns an agent, shuts it down, then spawns a second agent successfully and shuts that one down too.

**Call relations**: This follows the max-thread limit test by proving shutdown returns capacity to the shared guard.

*Call graph*: calls 5 internal fn (test_config_with_cli_overrides, text_input, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 2 external calls (new, vec!).


##### `spawn_agent_limit_shared_across_clones`  (lines 1680–1722)

```
async fn spawn_agent_limit_shared_across_clones()
```

**Purpose**: Checks that cloned `AgentControl` handles share the same agent limit. A limit would be ineffective if each clone had its own separate counter.

**Data flow**: It creates a control and a clone, spawns one agent through the clone, then tries to spawn another through the original and expects the shared limit error.

**Call relations**: This protects the concurrency-facing design where many parts of the program may hold cloned control handles.

*Call graph*: calls 5 internal fn (test_config_with_cli_overrides, text_input, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 4 external calls (assert_eq!, panic!, new, vec!).


##### `resume_agent_respects_max_threads_limit`  (lines 1725–1778)

```
async fn resume_agent_respects_max_threads_limit()
```

**Purpose**: Checks that resuming a saved agent also counts against the live-thread limit. Resumes should not bypass the same safety rule as spawning.

**Data flow**: It creates one resumable agent and shuts it down, spawns another agent to occupy the only slot, then tries to resume the first and expects `AgentLimitReached`.

**Call relations**: This applies the live-agent guard to the resume path, not just the spawn path.

*Call graph*: calls 5 internal fn (test_config_with_cli_overrides, text_input, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 4 external calls (assert_eq!, panic!, new, vec!).


##### `resume_agent_releases_slot_after_resume_failure`  (lines 1781–1809)

```
async fn resume_agent_releases_slot_after_resume_failure()
```

**Purpose**: Checks that a failed resume does not leak a live-agent slot. If the slot were not released, one bad resume could block later agent creation.

**Data flow**: It configures a one-agent limit, tries to resume a random missing thread and expects failure, then spawns a new agent successfully and shuts it down.

**Call relations**: This complements the resume-limit test by covering cleanup after an error during resume.

*Call graph*: calls 6 internal fn (test_config_with_cli_overrides, text_input, with_models_provider_and_home_for_tests, default_for_tests, from_api_key, new); 2 external calls (new, vec!).


##### `spawn_child_completion_notifies_parent_history`  (lines 1812–1843)

```
async fn spawn_child_completion_notifies_parent_history()
```

**Purpose**: Verifies that when a spawned child shuts down, the parent history receives a subagent notification. This is how a parent learns that delegated work ended.

**Data flow**: It starts a parent, spawns a child subagent, shuts down the child, and waits until the parent history contains a notification.

**Call relations**: This uses `wait_for_subagent_notification` to observe the background completion watcher.

*Call graph*: calls 2 internal fn (new, text_input); 2 external calls (SubAgent, assert_eq!).


##### `multi_agent_v2_completion_ignores_dead_direct_parent`  (lines 1846–1953)

```
async fn multi_agent_v2_completion_ignores_dead_direct_parent()
```

**Purpose**: Checks that in multi-agent version 2, a child completion is not routed through a direct parent that has already been shut down. This avoids sending messages to dead agents or wrongly notifying the root.

**Data flow**: It creates a root, worker, and tester path, shuts down the worker, sends a completion event from the tester, waits briefly, and verifies no inter-agent operation went to the dead worker and no notification appeared in root history.

**Call relations**: This test protects v2 completion routing when the immediate parent is no longer live.

*Call graph*: calls 3 internal fn (new, text_input, root); 5 external calls (from_millis, SubAgent, assert!, TurnComplete, sleep).


##### `multi_agent_v2_completion_queues_message_for_direct_parent`  (lines 1956–2055)

```
async fn multi_agent_v2_completion_queues_message_for_direct_parent()
```

**Purpose**: Checks that in multi-agent version 2, a child completion is queued for its live direct parent, not written into the root history. This keeps tree communication local.

**Data flow**: It starts root, worker, and tester threads, manually starts a completion watcher for the tester, sends a turn-complete event, builds the expected parent-directed communication, waits for that operation to be captured, and verifies root history does not contain it.

**Call relations**: This is the positive counterpart to the dead-parent v2 completion test.

*Call graph*: calls 4 internal fn (new, format_inter_agent_completion_message, root, new); 9 external calls (from_millis, from_secs, new, SubAgent, assert!, Completed, TurnComplete, sleep, timeout).


##### `completion_watcher_notifies_parent_when_child_is_missing`  (lines 2058–2096)

```
async fn completion_watcher_notifies_parent_when_child_is_missing()
```

**Purpose**: Checks that the completion watcher still notifies a parent when the child thread cannot be found. A missing child is itself useful status for the parent.

**Data flow**: It starts a parent, creates a random child ID without starting that child, starts a watcher for it, waits for a parent notification, and checks the notification text includes the child ID and `not_found` status.

**Call relations**: This test covers the error path inside the background completion watcher.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (SubAgent, assert_eq!).


##### `spawn_thread_subagent_gets_random_nickname_in_session_source`  (lines 2099–2140)

```
async fn spawn_thread_subagent_gets_random_nickname_in_session_source()
```

**Purpose**: Verifies that a spawned thread subagent gets a nickname when none is supplied. Nicknames make subagents easier to identify in session metadata.

**Data flow**: It starts a parent, spawns a child subagent with a role but no nickname, reads the child configuration snapshot, and checks the source contains the parent ID, depth, generated nickname, and role.

**Call relations**: This tests metadata enrichment during the spawn flow.

*Call graph*: calls 2 internal fn (new, text_input); 4 external calls (SubAgent, assert!, assert_eq!, panic!).


##### `spawn_thread_subagent_uses_role_specific_nickname_candidates`  (lines 2143–2184)

```
async fn spawn_thread_subagent_uses_role_specific_nickname_candidates()
```

**Purpose**: Checks that role-specific nickname candidates are used when available. This lets configured agent roles choose more meaningful names.

**Data flow**: It adds a `researcher` role with `Atlas` as its only nickname candidate, spawns a researcher child, reads its session source, and expects the nickname `Atlas`.

**Call relations**: This builds on the general nickname test by covering role configuration.

*Call graph*: calls 2 internal fn (new, text_input); 4 external calls (SubAgent, assert_eq!, panic!, vec!).


##### `resume_thread_subagent_restores_stored_nickname_and_role`  (lines 2187–2328)

```
async fn resume_thread_subagent_restores_stored_nickname_and_role()
```

**Purpose**: Verifies that resuming a saved subagent restores its stored nickname and role even if the resume request omits them. This keeps agent identity stable across restarts.

**Data flow**: It enables SQLite, spawns a child with role and path, waits until metadata including nickname and role is stored, shuts the child down, resumes it with missing nickname and role fields, and checks the resumed session source has the original nickname and role.

**Call relations**: This test combines database persistence, status waiting, shutdown, and resume metadata repair.

*Call graph*: calls 6 internal fn (test_config, text_input, with_models_provider_home_and_state_for_tests, default_for_tests, from_api_key, from_string); 10 external calls (from_millis, from_secs, SubAgent, assert_eq!, init_state_db, matches!, panic!, new, sleep, timeout).


##### `resume_agent_from_rollout_reads_archived_rollout_path`  (lines 2331–2377)

```
async fn resume_agent_from_rollout_reads_archived_rollout_path()
```

**Purpose**: Checks that resume can find a thread rollout after the thread has been archived. Archived history should still be usable for restoring an agent.

**Data flow**: It spawns an agent, persists a message to its rollout, shuts it down, archives the thread through the local store, then resumes by thread ID and verifies the same ID is returned.

**Call relations**: This covers the resume path through the thread store’s archived location rather than only the normal live rollout path.

*Call graph*: calls 5 internal fn (new, persist_thread_for_tree_resume, text_input, new, from_config); 1 external calls (assert_eq!).


##### `list_agent_subtree_thread_ids_includes_anonymous_and_closed_descendants`  (lines 2380–2503)

```
async fn list_agent_subtree_thread_ids_includes_anonymous_and_closed_descendants()
```

**Purpose**: Verifies that listing an agent subtree includes descendants without agent paths and descendants that have already closed. This is needed for complete tree shutdown and resume decisions.

**Data flow**: It creates a parent with a worker branch, an anonymous child and grandchild, plus a separate reviewer branch. It closes the anonymous grandchild, lists subtrees from the worker and anonymous child, and checks the returned IDs include the right descendants only.

**Call relations**: This tests thread-tree discovery independent of whether every agent has a named path or is still live.

*Call graph*: calls 3 internal fn (new, text_input, root); 3 external calls (SubAgent, assert_eq!, vec!).


##### `list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root`  (lines 2506–2563)

```
async fn list_agent_subtree_thread_ids_finds_live_descendants_of_unloaded_root()
```

**Purpose**: Checks that subtree listing still finds live descendants when the root thread has been removed from the manager. This matters when only children remain loaded.

**Data flow**: It starts a parent, child, and grandchild without a state database, removes the parent from the manager, then lists the subtree from the parent ID and expects all three IDs.

**Call relations**: This exercises tree discovery using live child links even when the requested root is not itself loaded.

*Call graph*: calls 5 internal fn (test_config, text_input, with_models_provider_home_and_state_for_tests, default_for_tests, from_api_key); 4 external calls (SubAgent, assert_eq!, new, vec!).


##### `shutdown_agent_tree_closes_live_descendants`  (lines 2566–2648)

```
async fn shutdown_agent_tree_closes_live_descendants()
```

**Purpose**: Verifies that shutting down an agent tree closes the root and all live descendants. Tree shutdown should not leave child agents running in the background.

**Data flow**: It creates a parent, child, and grandchild, persists child histories, waits for child links, calls `shutdown_agent_tree` on the parent, then checks all statuses are `NotFound` and shutdown operations were captured for all IDs.

**Call relations**: This is the main happy-path test for recursive tree shutdown.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 3 external calls (SubAgent, assert_eq!, vec!).


##### `shutdown_agent_tree_closes_descendants_when_started_at_child`  (lines 2651–2739)

```
async fn shutdown_agent_tree_closes_descendants_when_started_at_child()
```

**Purpose**: Checks that tree shutdown still closes descendants if part of the tree was already closed from a child node. This prevents orphaned grandchildren.

**Data flow**: It creates a parent-child-grandchild tree, persists child histories, waits for links, closes the child, then shuts down the parent tree and verifies parent, child, and grandchild are all closed with shutdown operations recorded.

**Call relations**: This covers recursive shutdown when a subtree root has already been closed before the full tree shutdown begins.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 3 external calls (SubAgent, assert_eq!, vec!).


##### `resume_agent_from_rollout_does_not_reopen_closed_descendants`  (lines 2742–2834)

```
async fn resume_agent_from_rollout_does_not_reopen_closed_descendants()
```

**Purpose**: Checks that resuming a parent does not reopen descendants that were explicitly closed. Closed means intentionally not active, not merely missing from memory.

**Data flow**: It builds and persists a parent-child-grandchild tree, closes the child, shuts down the parent, resumes the parent from rollout, and verifies only the parent is active while the child and grandchild remain not found.

**Call relations**: This protects the distinction between open descendants that should resume and closed descendants that should stay closed.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 3 external calls (SubAgent, assert_eq!, assert_ne!).


##### `resume_closed_child_reopens_open_descendants`  (lines 2837–2931)

```
async fn resume_closed_child_reopens_open_descendants()
```

**Purpose**: Checks that directly resuming a closed child can reopen that child and its open descendants. Closing the child before resume does not mean its descendant state is lost forever.

**Data flow**: It builds and persists a parent-child-grandchild tree, closes the child, resumes the child from rollout as a subagent, and verifies both child and grandchild are active afterward.

**Call relations**: This is the direct-child resume counterpart to the parent-resume test that leaves closed descendants alone.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 3 external calls (SubAgent, assert_eq!, assert_ne!).


##### `resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown`  (lines 2934–3022)

```
async fn resume_agent_from_rollout_reopens_open_descendants_after_manager_shutdown()
```

**Purpose**: Verifies that after a manager-wide shutdown, resuming the root reopens descendants that were still considered open. This supports restoring a whole active tree after process shutdown.

**Data flow**: It creates and persists a parent-child-grandchild tree, waits for links, shuts down all threads through the manager, resumes the parent, and checks that parent, child, and grandchild are all loaded again.

**Call relations**: This is the main tree-resume test for ordinary non-v2 agent trees.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 4 external calls (from_secs, SubAgent, assert_eq!, assert_ne!).


##### `resume_agent_from_rollout_uses_edge_data_when_descendant_metadata_source_is_stale`  (lines 3025–3153)

```
async fn resume_agent_from_rollout_uses_edge_data_when_descendant_metadata_source_is_stale()
```

**Purpose**: Checks that tree resume trusts stored parent-child edge data over stale descendant session metadata. This prevents corrupted metadata from reconnecting a child to the wrong parent or depth.

**Data flow**: It creates and persists a tree, then deliberately edits the grandchild’s stored metadata to have the wrong parent and depth. After manager shutdown and parent resume, it verifies the grandchild is active and its resumed session source uses the correct edge-derived parent and depth.

**Call relations**: This test protects resume correctness when the database has conflicting information.

*Call graph*: calls 5 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children, new); 6 external calls (from_secs, SubAgent, assert_eq!, assert_ne!, panic!, to_string).


##### `resume_agent_from_rollout_skips_descendants_when_parent_resume_fails`  (lines 3156–3250)

```
async fn resume_agent_from_rollout_skips_descendants_when_parent_resume_fails()
```

**Purpose**: Checks that if a descendant cannot be resumed, its own descendants are skipped too. This avoids reopening grandchildren under a missing or broken parent.

**Data flow**: It creates and persists a parent-child-grandchild tree, records the child rollout path, shuts all threads down, deletes the child rollout file, resumes the parent, and verifies the parent is active while child and grandchild remain not found.

**Call relations**: This tests partial tree resume failure handling and makes sure resume does not create orphaned descendant agents.

*Call graph*: calls 4 internal fn (new, persist_thread_for_tree_resume, text_input, wait_for_live_thread_spawn_children); 5 external calls (from_secs, SubAgent, assert_eq!, assert_ne!, remove_file).


### `core/src/agent/control/execution_tests.rs`

`test` · `test run`

This is a test file for the agent execution limiter, the part of the system that stops too many child agents from running at once. In everyday terms, it checks that the project has a working “room capacity” sign: only a certain number of worker agents are allowed in, and when one leaves, another can enter.

The tests focus on a subtle rule. Only version 2 sub-agent turns count against this limit. Root sessions, such as a normal command-line session, do not count. Older version 1 sub-agent turns also do not count. This matters because applying the limit too broadly could block normal use, while applying it too loosely could allow too many child agents to run and overload the system.

The helper function builds an `AgentControl` object with a chosen maximum number of active threads. One test sets the limit to one, starts a version 2 sub-agent turn, and checks that a second one is rejected with the expected “agent limit reached” error. It then drops the guard object, which represents the active running turn, and confirms that capacity becomes available again. Another test confirms that root and version 1 turns do not receive such guards at all, meaning they are intentionally ignored by this limiter.

#### Function details

##### `control_with_limit`  (lines 8–12)

```
fn control_with_limit(max_threads: usize) -> AgentControl
```

**Purpose**: This helper creates an `AgentControl` object with a specific maximum number of allowed active sub-agent executions. The tests use it so they can clearly set up small, predictable limits.

**Data flow**: It takes a number, `max_threads`, as input. It starts from the default `AgentControl`, initializes that control's execution limiter with the requested limit, and returns the prepared control object for the test to use.

**Call relations**: Both tests call this helper at the beginning to create the test fixture, meaning the controlled environment they need. It relies on the normal default construction of `AgentControl`, then customizes only the execution limit so each test can focus on limiter behavior.

*Call graph*: called by 2 (execution_guards_count_active_v2_subagent_turns, execution_guards_ignore_root_and_v1_turns); 1 external calls (default).


##### `execution_guards_count_active_v2_subagent_turns`  (lines 15–41)

```
fn execution_guards_count_active_v2_subagent_turns()
```

**Purpose**: This test proves that version 2 sub-agent turns are counted against the execution limit. It also proves that the limit comes from the root session setup and is not overwritten by a later child role configuration.

**Data flow**: It starts with an `AgentControl` limited to one active execution, then tries to initialize the limiter again with a larger number to confirm the original limit still wins. It creates a sub-agent session source, checks that the first version 2 turn has capacity, obtains a guard for that running turn, and then checks that a second concurrent turn is rejected. After the first guard is dropped, it checks again and expects capacity to be available.

**Call relations**: This test uses `control_with_limit` to build the controlled setup. It then drives the public limiter-facing methods on `AgentControl`: first asking whether there is room, then taking an execution guard, then checking rejection, and finally verifying release after the guard is dropped. It uses assertions and panics only to make failures explicit when the limiter behaves differently than expected.

*Call graph*: calls 1 internal fn (control_with_limit); 4 external calls (SubAgent, assert_eq!, panic!, Other).


##### `execution_guards_ignore_root_and_v1_turns`  (lines 44–60)

```
fn execution_guards_ignore_root_and_v1_turns()
```

**Purpose**: This test confirms that the execution limiter does not apply to root sessions or older version 1 sub-agent turns. Those cases should not take up any limited sub-agent capacity.

**Data flow**: It creates an `AgentControl` with a limit of zero, which would block anything that actually counted. It then asks for execution guards for a version 2 command-line root session and for a version 1 sub-agent session. In both cases, the result is expected to be empty, showing that no limiter guard was created because these turns are not counted.

**Call relations**: This test also begins with `control_with_limit`, but it deliberately chooses the strictest possible limit to make counted work obvious. It calls into `AgentControl` only to request guards, then uses assertions to verify that the limiter steps aside for the cases that should be ignored.

*Call graph*: calls 1 internal fn (control_with_limit); 1 external calls (assert!).


### `core/src/agent/control/residency_tests.rs`

`test` · `test run`

This is a test file for the “residency” rules of MultiAgent V2. In plain terms, residency means which agent threads are allowed to stay loaded and ready to use. The system has a limit, like a small parking lot with only a few spaces. When a new sub-agent needs a space and the lot is full, the system must decide which old agent can be safely removed.

The tests build a temporary, isolated ThreadManager so they do not touch a real user setup. They enable the MultiAgent V2 feature, set the session limit to two concurrent threads, then start one root thread and create sub-agent threads under it. The root thread is important because it should not be evicted just because sub-agents come and go.

The first test proves that when an idle completed sub-agent is taking up space, reserving another slot unloads that old sub-agent while keeping the root and the newer sub-agent available. The second test covers a more delicate case: an interrupted sub-agent is evicted, and later the system is asked to load it again. The expected behavior is that it stays gone and returns a ThreadNotFound error. Helper functions create test sub-agents and fake completion or interruption events so the tests can focus on residency behavior rather than running a full agent task loop.

#### Function details

##### `residency_slot_reservation_unloads_oldest_idle_v2_agent`  (lines 22–65)

```
async fn residency_slot_reservation_unloads_oldest_idle_v2_agent()
```

**Purpose**: This test checks that when the MultiAgent V2 residency limit is reached, the system removes the oldest idle sub-agent to make room for a new one. It also verifies that the root thread and the newly created sub-agent remain available.

**Data flow**: The test starts with a fresh test configuration, turns on MultiAgent V2, and sets the maximum loaded threads for the session to two. It creates a temporary home folder, starts a root thread, reserves a residency slot, spawns the first sub-agent, and marks it completed so it is idle. Then it reserves another slot, which should force the first sub-agent out. The test checks that looking up the first sub-agent now gives ThreadNotFound, then creates a second sub-agent and confirms the root and second sub-agent can still be found.

**Call relations**: This is a top-level async test run by the test framework. It uses test setup helpers to create configuration and a ThreadManager, calls spawn_v2_subagent to create realistic sub-agent threads, and calls mark_thread_completed to make the first sub-agent safe to evict. Its main interaction is with AgentControl, which performs the residency-slot reservation being tested.

*Call graph*: calls 6 internal fn (mark_thread_completed, spawn_v2_subagent, test_config, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 5 external calls (new, assert!, assert_eq!, panic!, tempdir).


##### `interrupted_v2_agent_is_lost_after_residency_eviction`  (lines 68–127)

```
async fn interrupted_v2_agent_is_lost_after_residency_eviction()
```

**Purpose**: This test checks that an interrupted sub-agent is not quietly restored after it has been evicted from residency. That matters because an interrupted agent may not have a clean, reusable state.

**Data flow**: The test creates the same kind of isolated MultiAgent V2 setup as the other residency test. It starts a root thread, creates a first sub-agent, commits it into a residency slot, and marks that sub-agent as interrupted. It then reserves a second slot, which should evict the interrupted idle sub-agent, and confirms the old thread is missing. After creating and completing a second sub-agent, it asks AgentControl to ensure the first agent is loaded again. The expected output is an error saying that first thread was not found, while the root thread and second sub-agent remain available.

**Call relations**: This is another top-level async test run directly by the test framework. It shares the sub-agent creation helper with the first test, but also uses mark_thread_interrupted to create the special interrupted state. It later calls mark_thread_completed on the second sub-agent so the test leaves that newer thread in a stable finished state while proving the evicted interrupted one stays gone.

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

**Purpose**: This helper creates a sub-agent thread for the tests. It hides the long setup call needed to tell the ThreadManager that the new thread is a child sub-agent of an existing parent thread.

**Data flow**: It receives AgentControl, shared ThreadManager state, a configuration, the parent thread id, and a label such as “worker-1”. It passes those pieces into the thread manager’s thread-spawning routine, marking the new session as a sub-agent and linking it to the parent thread. It returns the newly created thread object, or fails the test if creation does not work.

**Call relations**: Both residency tests call this helper when they need a realistic V2 sub-agent. It hands the work to the ThreadManagerState spawning path, using AgentControl so the new thread is connected to the same control system that enforces residency rules.

*Call graph*: called by 2 (interrupted_v2_agent_is_lost_after_residency_eviction, residency_slot_reservation_unloads_oldest_idle_v2_agent); 3 external calls (SubAgent, clone, Other).


##### `mark_thread_completed`  (lines 153–170)

```
async fn mark_thread_completed(thread: &CodexThread)
```

**Purpose**: This helper makes a test thread look as if it finished a turn successfully. The residency code can then treat that thread as idle and eligible for eviction.

**Data flow**: It takes a CodexThread, creates a new default turn in that thread’s session, and sends a TurnComplete event with a small final message. After sending the event, it clears the session’s active turn field so the fixture looks like a real finished turn. It does not return a value; it changes the thread’s session state.

**Call relations**: The first residency test uses this to make the first sub-agent an idle completed candidate for eviction. The second test uses it for the second sub-agent after the interrupted-agent scenario has been checked. It calls clear_active_turn because these tests do not run the normal background task runner that would usually clean up the active turn.

*Call graph*: calls 1 internal fn (clear_active_turn); called by 2 (interrupted_v2_agent_is_lost_after_residency_eviction, residency_slot_reservation_unloads_oldest_idle_v2_agent); 1 external calls (TurnComplete).


##### `mark_thread_interrupted`  (lines 172–188)

```
async fn mark_thread_interrupted(thread: &CodexThread)
```

**Purpose**: This helper makes a test thread look as if its turn was stopped by interruption. The test uses this to check the special rule that an evicted interrupted agent should stay unavailable.

**Data flow**: It takes a CodexThread, opens a new default turn, and sends a TurnAborted event with the reason set to Interrupted. Then it clears the active turn by calling clear_active_turn. The result is a thread session whose latest turn ended by interruption rather than normal completion.

**Call relations**: Only the interrupted-agent residency test calls this helper. It prepares the first sub-agent for the exact eviction case under test, then relies on clear_active_turn to make the thread appear idle enough for residency eviction logic to consider it.

*Call graph*: calls 1 internal fn (clear_active_turn); called by 1 (interrupted_v2_agent_is_lost_after_residency_eviction); 1 external calls (TurnAborted).


##### `clear_active_turn`  (lines 190–193)

```
async fn clear_active_turn(thread: &CodexThread)
```

**Purpose**: This helper manually clears the thread session’s active turn marker. It is needed because the lightweight test fixture does not include the normal task runner that would clear this after a terminal event.

**Data flow**: It receives a CodexThread, locks the session’s active_turn field, and sets it to None. Before the call, the session may still think a turn is active even though a completion or interruption event was sent. After the call, the session no longer has an active turn recorded.

**Call relations**: mark_thread_completed and mark_thread_interrupted both call this after sending their final turn event. This keeps the test session state consistent with what the full runtime would normally do automatically.

*Call graph*: called by 2 (mark_thread_completed, mark_thread_interrupted).


### `core/src/agent/registry_tests.rs`

`test` · `test run`

The agent registry is like a front desk for worker agents. Before a new agent starts, it must reserve a slot so the system does not create too many at once. It may also reserve a nickname and a path, which is a human-readable location such as `/root/researcher`. When the agent actually starts, the reservation is committed. When it ends, the registry must free the active slot and remove any path lookup.

These tests check the important promises around that front desk. They verify that dropping an uncommitted reservation frees the spawn slot and path, while committing a reservation keeps the slot occupied until the matching thread is released. They also check edge cases, such as releasing an unknown thread, releasing the same old thread twice, and enforcing a maximum thread count.

A large part of the file tests nickname behavior. Nicknames are not immediately reused just because an agent exits; instead, the registry waits until the available nickname pool is exhausted, then starts a new round and adds suffixes like “the 2nd” or “the 3rd.” This avoids confusing two agents with the same visible name in one naming round. The file also tests depth tracking for sub-agents, so recursive thread spawning can be limited safely.

#### Function details

##### `agent_path`  (lines 6–8)

```
fn agent_path(path: &str) -> AgentPath
```

**Purpose**: This small test helper turns a text path into an `AgentPath`, which is the project’s structured form of an agent location. It keeps the path-based tests easy to read.

**Data flow**: It takes a path string such as `/root/researcher`, asks `AgentPath` to parse and validate it, and returns the parsed path. If the test accidentally gives an invalid path, it stops the test immediately with a clear failure message.

**Call relations**: The path reservation and path indexing tests call this helper whenever they need a valid `AgentPath`. It hands parsed paths to registry methods that reserve paths or look up an agent by path.

*Call graph*: calls 1 internal fn (try_from); called by 2 (committed_agent_path_is_indexed_until_release, reserved_agent_path_is_released_when_spawn_fails).


##### `agent_metadata`  (lines 10–15)

```
fn agent_metadata(thread_id: ThreadId) -> AgentMetadata
```

**Purpose**: This helper builds minimal metadata for a spawned agent, with only its thread ID filled in. Tests use it when they care about slot ownership but not about the rest of the agent details.

**Data flow**: It takes a `ThreadId`, creates a default `AgentMetadata` value, inserts that ID into the `agent_id` field, and returns the metadata. Everything else stays at the default value.

**Call relations**: Several registry tests call this helper before committing a spawn reservation. The committed metadata tells the registry which thread owns the reserved slot, so later release calls can prove whether the slot is freed correctly.

*Call graph*: called by 6 (agent_nickname_resets_used_pool_when_exhausted, commit_holds_slot_until_release, release_ignores_unknown_thread_id, release_is_idempotent_for_registered_threads, released_nickname_stays_used_until_pool_reset, repeated_resets_advance_the_ordinal_suffix); 1 external calls (default).


##### `format_agent_nickname_adds_ordinals_after_reset`  (lines 18–39)

```
fn format_agent_nickname_adds_ordinals_after_reset()
```

**Purpose**: This test checks how nicknames are displayed after the nickname pool has reset. It makes sure the first use is plain, and later reuse gets readable suffixes like “the 2nd” and “the 21st.”

**Data flow**: The test feeds the nickname formatter the same base name, `Plato`, with different reset counts. It compares each result with the exact expected display name.

**Call relations**: This test exercises the nickname-formatting rule directly. It supports the later registry tests that depend on those suffixes appearing after names are reused.

*Call graph*: 1 external calls (assert_eq!).


##### `session_depth_defaults_to_zero_for_root_sources`  (lines 42–44)

```
fn session_depth_defaults_to_zero_for_root_sources()
```

**Purpose**: This test confirms that a normal root session starts at depth zero. That matters because spawn-depth limits should only grow when agents create more agents.

**Data flow**: It gives the depth function a root command-line session source and checks that the returned depth is `0`.

**Call relations**: This is a direct check of the session depth calculation. It pairs with the sub-agent depth tests to show how root sessions and child-agent sessions differ.

*Call graph*: 1 external calls (assert_eq!).


##### `thread_spawn_depth_increments_and_enforces_limit`  (lines 47–61)

```
fn thread_spawn_depth_increments_and_enforces_limit()
```

**Purpose**: This test verifies that when a thread-spawned sub-agent creates another thread, its depth goes up by one. It also confirms that the depth limit blocks a child that would go too deep.

**Data flow**: The test builds a sub-agent source with depth `1`, asks for the next child depth, and expects `2`. It then checks that depth `2` exceeds a maximum allowed depth of `1`.

**Call relations**: This test drives the depth helpers used when spawning nested agents. It shows that the system can stop runaway chains of agents creating more agents.

*Call graph*: calls 1 internal fn (new); 3 external calls (SubAgent, assert!, assert_eq!).


##### `non_thread_spawn_subagents_default_to_depth_zero`  (lines 64–71)

```
fn non_thread_spawn_subagents_default_to_depth_zero()
```

**Purpose**: This test confirms that sub-agents created for reasons other than thread spawning, such as review, do not inherit a thread-spawn depth. Their next thread-spawn child starts at depth one.

**Data flow**: The test creates a review sub-agent source, checks that its current depth is `0`, then checks that a child thread spawn would be depth `1`. It also verifies that depth `1` is allowed when the maximum is `1`.

**Call relations**: This complements the thread-spawn depth test. Together they define when recursive spawning depth should and should not grow.

*Call graph*: 3 external calls (SubAgent, assert!, assert_eq!).


##### `reservation_drop_releases_slot`  (lines 74–81)

```
fn reservation_drop_releases_slot()
```

**Purpose**: This test checks that an uncommitted spawn reservation does not permanently consume a thread slot. If a spawn attempt is abandoned, the registry must let another attempt use the slot.

**Data flow**: The test creates a registry, reserves the only allowed slot, then drops the reservation without committing it. It then reserves again with the same one-thread limit and expects success.

**Call relations**: This test exercises the registry’s cleanup behavior for abandoned reservations. It proves that simply reserving a slot is temporary unless the reservation is committed.

*Call graph*: 2 external calls (new, default).


##### `commit_holds_slot_until_release`  (lines 84–104)

```
fn commit_holds_slot_until_release()
```

**Purpose**: This test checks the main lifetime rule for spawned agents: once a reservation is committed, its slot stays occupied until that exact thread is released.

**Data flow**: The test reserves the only slot, creates a new thread ID, commits the reservation with that ID, and then tries to reserve another slot. It expects a limit error. After releasing the committed thread, it tries again and expects the slot to be available.

**Call relations**: This test uses `agent_metadata` to commit the reservation with a thread identity. It follows the normal registry story from reserve, to commit, to limit enforcement, to release.

*Call graph*: calls 2 internal fn (agent_metadata, new); 4 external calls (new, assert_eq!, default, panic!).


##### `release_ignores_unknown_thread_id`  (lines 107–129)

```
fn release_ignores_unknown_thread_id()
```

**Purpose**: This test makes sure releasing a thread ID the registry has never seen does not accidentally free a real active slot. That protects the registry from stale or mistaken release calls.

**Data flow**: The test commits one active thread, then calls release with a different newly created thread ID. It then tries to reserve another slot and expects the maximum-thread error to remain. Only after releasing the real thread does reservation succeed.

**Call relations**: This test builds on the committed-slot behavior and adds a wrong-ID case. It proves that the registry frees slots by matching the stored thread ID, not just by counting release calls.

*Call graph*: calls 2 internal fn (agent_metadata, new); 4 external calls (new, assert_eq!, default, panic!).


##### `release_is_idempotent_for_registered_threads`  (lines 132–160)

```
fn release_is_idempotent_for_registered_threads()
```

**Purpose**: This test checks that releasing an already released thread is harmless. In practical terms, an old cleanup call should not free a slot that now belongs to a different agent.

**Data flow**: The test commits a first thread and releases it. It then commits a second thread into the reused slot, calls release again with the first thread’s old ID, and confirms the slot is still occupied. Finally it releases the second thread and verifies the slot becomes available.

**Call relations**: This test connects the release logic across two generations of agents. It guards against a subtle bug where an outdated thread ID could accidentally remove the current active agent.

*Call graph*: calls 2 internal fn (agent_metadata, new); 4 external calls (new, assert_eq!, default, panic!).


##### `failed_spawn_keeps_nickname_marked_used`  (lines 163–181)

```
fn failed_spawn_keeps_nickname_marked_used()
```

**Purpose**: This test checks that a nickname reserved during a failed spawn is still considered used for the current naming round. That prevents the system from immediately offering the same visible name again after a failed attempt.

**Data flow**: The test reserves the nickname `alpha` and then drops the reservation before committing the spawn. On the next reservation, it offers `alpha` and `beta`; the registry should skip `alpha` and return `beta`.

**Call relations**: This test focuses on nickname reservation rather than thread-slot release. It shows that abandoned spawn attempts free the slot, but do not erase the fact that a nickname was already handed out in the current pool.

*Call graph*: 3 external calls (new, assert_eq!, default).


##### `agent_nickname_resets_used_pool_when_exhausted`  (lines 184–208)

```
fn agent_nickname_resets_used_pool_when_exhausted()
```

**Purpose**: This test verifies what happens when there are no unused nicknames left in the offered list. The registry starts a new naming round and adds an ordinal suffix to show the name is being reused.

**Data flow**: The test reserves and commits `alpha` once. Then it asks for a nickname from a list containing only `alpha` again. The registry returns `alpha the 2nd` and records that the nickname pool has reset once.

**Call relations**: This test uses `agent_metadata` to keep the first agent active while asking for another name. It checks the registry state directly to confirm that the reset counter changed.

*Call graph*: calls 2 internal fn (agent_metadata, new); 3 external calls (new, assert_eq!, default).


##### `released_nickname_stays_used_until_pool_reset`  (lines 211–250)

```
fn released_nickname_stays_used_until_pool_reset()
```

**Purpose**: This test confirms that a nickname stays marked as used even after its agent is released, until all offered nicknames have been used. This keeps naming stable within one round.

**Data flow**: The test first reserves and releases `alpha`. It then asks from `alpha` and `beta` and expects `beta`, because `alpha` is still considered used. After releasing `beta`, the next request from the same pair can reuse one of them with a `the 2nd` suffix, and the reset counter should be one.

**Call relations**: This test combines release behavior with nickname-pool behavior. It proves that freeing an agent slot and freeing a nickname are intentionally different events.

*Call graph*: calls 2 internal fn (agent_metadata, new); 5 external calls (new, from, assert!, assert_eq!, default).


##### `repeated_resets_advance_the_ordinal_suffix`  (lines 253–290)

```
fn repeated_resets_advance_the_ordinal_suffix()
```

**Purpose**: This test checks that repeated nickname pool resets keep advancing the suffix. A name reused for the third round should become “the 3rd,” not stay stuck at “the 2nd.”

**Data flow**: The test repeatedly reserves the only available nickname, `Plato`, commits it, and releases the thread. The first result is `Plato`, the second is `Plato the 2nd`, and the third is `Plato the 3rd`. It also checks that the reset count has reached two.

**Call relations**: This test relies on the same registry nickname machinery as the other nickname tests, but stretches it over multiple cycles. It confirms the formatter and reset counter work together over time.

*Call graph*: calls 2 internal fn (agent_metadata, new); 3 external calls (new, assert_eq!, default).


##### `register_root_thread_indexes_root_path`  (lines 293–303)

```
fn register_root_thread_indexes_root_path()
```

**Purpose**: This test checks that the root thread is registered under the root agent path. That lets later code find the root agent by asking for the root path.

**Data flow**: The test creates a registry and a root thread ID, registers that thread as the root, then asks the registry which thread owns the root path. It expects the same ID back.

**Call relations**: This test exercises the path index for the special root agent. It supports the broader path lookup behavior checked by the committed-path test.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, default).


##### `reserved_agent_path_is_released_when_spawn_fails`  (lines 306–322)

```
fn reserved_agent_path_is_released_when_spawn_fails()
```

**Purpose**: This test makes sure a path reservation is not held forever if the spawn never commits. If an agent fails to start, another attempt should be able to use the same path.

**Data flow**: The test reserves `/root/researcher` during a first spawn reservation and then drops that reservation. It starts a second reservation and tries to reserve the same path again, expecting success.

**Call relations**: This test uses the `agent_path` helper to create the path values. It checks the path side of the same abandoned-reservation cleanup idea tested for thread slots.

*Call graph*: calls 1 internal fn (agent_path); 2 external calls (new, default).


##### `committed_agent_path_is_indexed_until_release`  (lines 325–350)

```
fn committed_agent_path_is_indexed_until_release()
```

**Purpose**: This test checks that a committed agent path can be used to find the agent’s thread while the agent is active, and that the lookup disappears after release.

**Data flow**: The test reserves `/root/researcher`, commits the reservation with both a thread ID and that path, then asks the registry for the thread at that path and expects the ID. After releasing the thread, the same lookup should return nothing.

**Call relations**: This test uses `agent_path` to build the path and commits full metadata instead of the smaller helper. It ties together reservation, commit, path indexing, lookup, and release cleanup.

*Call graph*: calls 2 internal fn (agent_path, new); 4 external calls (new, default, assert_eq!, default).


### `core/src/agent/role_tests.rs`

`test` · `test run`

Agent roles are named presets, such as a default role or a user-defined role, that can change how a spawned agent behaves. This test file checks that those presets are safe and predictable. Without these tests, a role file could accidentally erase unrelated settings, override command-line choices in the wrong order, expose confusing tool descriptions, or silently fail when skills and sandbox settings are involved.

The tests build temporary Codex homes, write small role configuration files, apply those roles to a Config object, and then check the result. Think of it like trying different recipe cards on the same kitchen setup: the card may change the oven temperature, but it should not throw away the groceries or rewrite the house rules unless it explicitly says so.

The file covers several important cases. Unknown roles should return a clear error. Missing or invalid user role files should be reported as unavailable. Role files may set model, reasoning effort, service tier, sandbox, and skills settings, but metadata fields like name and description are not treated as live configuration. The tests also check that role-applied settings are added as a higher-priority configuration layer, so they can deliberately win over earlier session flags. Finally, the spawn tool description is tested so user-defined roles are listed clearly, built-in duplicates are not repeated, and locked settings are explained to whoever asks the agent to spawn another agent.

#### Function details

##### `test_config_with_cli_overrides`  (lines 16–29)

```
async fn test_config_with_cli_overrides(
    cli_overrides: Vec<(String, TomlValue)>,
) -> (TempDir, Config)
```

**Purpose**: Creates a temporary test configuration, optionally with command-line style overrides. Tests use it when they need a clean Codex home directory and a Config object that behaves like a real loaded configuration.

**Data flow**: It receives a list of override key-value pairs. It creates a temporary home folder, feeds that folder and the overrides into ConfigBuilder, waits for the config to load, and returns both the temporary folder and the finished Config. The temporary folder stays alive because it is returned to the caller.

**Call relations**: Many role-application tests call this first to set up their starting point. It relies on the temporary-directory creator and ConfigBuilder, then hands a ready Config to the individual tests that mutate it with apply_role_to_config.

*Call graph*: called by 13 (apply_empty_explorer_role_preserves_current_model_and_reasoning_effort, apply_explorer_role_sets_model_and_adds_session_flags_layer, apply_role_defaults_to_default_and_leaves_config_unchanged, apply_role_does_not_materialize_default_sandbox_workspace_write_fields, apply_role_ignores_agent_metadata_fields_in_user_role_file, apply_role_preserves_existing_service_tier_without_override, apply_role_preserves_unspecified_keys, apply_role_reports_explicit_service_tier, apply_role_returns_error_for_unknown_role, apply_role_returns_unavailable_for_invalid_user_role_toml (+3 more)); 2 external calls (new, default).


##### `write_role_config`  (lines 31–37)

```
async fn write_role_config(home: &TempDir, name: &str, contents: &str) -> PathBuf
```

**Purpose**: Writes a small role configuration file inside a temporary test home. Tests use it to create fake user role files with exactly the contents needed for each scenario.

**Data flow**: It receives a temporary home directory, a file name, and text contents. It joins the home path with the file name, writes the text to that path asynchronously, and returns the path to the newly written file.

**Call relations**: Tests that need a custom role file call this helper before registering that file in config.agent_roles. The returned path is then passed indirectly to apply_role_to_config through the role configuration.

*Call graph*: called by 8 (apply_role_does_not_materialize_default_sandbox_workspace_write_fields, apply_role_ignores_agent_metadata_fields_in_user_role_file, apply_role_preserves_existing_service_tier_without_override, apply_role_preserves_unspecified_keys, apply_role_reports_explicit_service_tier, apply_role_returns_unavailable_for_invalid_user_role_toml, apply_role_skills_config_disables_skill_for_spawned_agent, apply_role_takes_precedence_over_existing_session_flags_for_same_key); 2 external calls (path, write).


##### `session_flags_layer_count`  (lines 39–49)

```
fn session_flags_layer_count(config: &Config) -> usize
```

**Purpose**: Counts how many configuration layers came from session flags. Tests use this to see whether applying a role added a new high-priority layer of settings.

**Data flow**: It receives a Config, asks its configuration layer stack for all layers including disabled ones, filters that list down to layers named SessionFlags, and returns the count.

**Call relations**: Role precedence tests call this before and after applying a role. It does not change the config; it only observes the layer stack so tests can confirm whether a role added a new layer.

*Call graph*: called by 3 (apply_empty_explorer_role_preserves_current_model_and_reasoning_effort, apply_explorer_role_sets_model_and_adds_session_flags_layer, apply_role_takes_precedence_over_existing_session_flags_for_same_key).


##### `apply_role_defaults_to_default_and_leaves_config_unchanged`  (lines 52–61)

```
async fn apply_role_defaults_to_default_and_leaves_config_unchanged()
```

**Purpose**: Checks that asking for no specific role means the default behavior is used and the configuration is not changed. This protects the simplest path: doing nothing special should not surprise the user.

**Data flow**: It starts with a fresh config, clones it as the expected baseline, applies a role with no role name, and compares the final config with the original clone. The output is only the test result: pass if nothing changed, fail if anything did.

**Call relations**: This test uses test_config_with_cli_overrides to get a clean config, then calls apply_role_to_config. It verifies that the role system can be invoked safely even when no explicit role was requested.

*Call graph*: calls 1 internal fn (test_config_with_cli_overrides); 2 external calls (new, assert_eq!).


##### `apply_role_returns_error_for_unknown_role`  (lines 64–72)

```
async fn apply_role_returns_error_for_unknown_role()
```

**Purpose**: Checks that an unknown role name fails with a clear error message. This matters because users need to know when they typed or configured a role that does not exist.

**Data flow**: It creates a fresh config, asks to apply the role named missing-role, expects an error, and compares that error text to the expected message. No successful config change is expected.

**Call relations**: The test setup comes from test_config_with_cli_overrides. The main behavior under test is apply_role_to_config's lookup and error path for a role name that is not registered.

*Call graph*: calls 1 internal fn (test_config_with_cli_overrides); 2 external calls (new, assert_eq!).


##### `apply_explorer_role_sets_model_and_adds_session_flags_layer`  (lines 76–87)

```
async fn apply_explorer_role_sets_model_and_adds_session_flags_layer()
```

**Purpose**: Checks the intended behavior for an explorer role that locks in a model and reasoning effort, while adding those settings as a session-flags layer. The test is currently ignored because no role needs this behavior at the moment.

**Data flow**: It creates a fresh config, records the number of session flag layers, applies the explorer role, and expects the model, reasoning effort, and layer count to change in specific ways. Its result is a pass or fail assertion.

**Call relations**: It combines test_config_with_cli_overrides and session_flags_layer_count around a call to apply_role_to_config. If re-enabled, it would protect built-in explorer role defaults and their priority in the config stack.

*Call graph*: calls 2 internal fn (session_flags_layer_count, test_config_with_cli_overrides); 2 external calls (new, assert_eq!).


##### `apply_empty_explorer_role_preserves_current_model_and_reasoning_effort`  (lines 90–103)

```
async fn apply_empty_explorer_role_preserves_current_model_and_reasoning_effort()
```

**Purpose**: Checks that an explorer role with no active defaults does not overwrite an already chosen model or reasoning effort. This prevents a role from erasing user choices when it has nothing explicit to add.

**Data flow**: It creates a fresh config, manually sets a model and high reasoning effort, applies the explorer role, and checks that those values and the session layer count stay the same.

**Call relations**: The test gets its baseline config from test_config_with_cli_overrides, measures layers with session_flags_layer_count, then calls apply_role_to_config. It confirms the role system is conservative when a role has no relevant settings.

*Call graph*: calls 2 internal fn (session_flags_layer_count, test_config_with_cli_overrides); 2 external calls (new, assert_eq!).


##### `apply_role_returns_unavailable_for_missing_user_role_file`  (lines 106–122)

```
async fn apply_role_returns_unavailable_for_missing_user_role_file()
```

**Purpose**: Checks that a user-defined role pointing to a missing file is reported as unavailable. This gives callers a stable error instead of leaking low-level file-system details.

**Data flow**: It creates a config, inserts a custom role whose config_file path does not exist, applies that role, and expects the shared unavailable-role error string.

**Call relations**: The test builds its config through test_config_with_cli_overrides, then directly adds a role entry before calling apply_role_to_config. It exercises the file-read failure path for user role files.

*Call graph*: calls 1 internal fn (test_config_with_cli_overrides); 3 external calls (from, new, assert_eq!).


##### `apply_role_returns_unavailable_for_invalid_user_role_toml`  (lines 125–142)

```
async fn apply_role_returns_unavailable_for_invalid_user_role_toml()
```

**Purpose**: Checks that a malformed role configuration file is reported as unavailable. TOML is the configuration file format here, and invalid TOML should not partially apply or crash the role system.

**Data flow**: It writes a role file containing broken TOML syntax, registers that file as a custom role, applies the role, and checks that the returned error is the standard unavailable-role message.

**Call relations**: It uses test_config_with_cli_overrides for setup and write_role_config to create the bad file. It then sends the resulting role entry into apply_role_to_config to test parsing failure behavior.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 2 external calls (new, assert_eq!).


##### `apply_role_ignores_agent_metadata_fields_in_user_role_file`  (lines 145–173)

```
async fn apply_role_ignores_agent_metadata_fields_in_user_role_file()
```

**Purpose**: Checks that descriptive role metadata inside a role file is ignored when applying runtime configuration. Fields like name, description, and nickname candidates describe the role; they should not become active config settings.

**Data flow**: It writes a role file containing both metadata fields and a real model setting, registers that file, applies the role, and checks that the model was applied. The metadata fields are allowed to exist but are not treated as config changes.

**Call relations**: The test prepares a custom role file with write_role_config, starts from test_config_with_cli_overrides, and uses apply_role_to_config to verify that only applicable config fields affect the final Config.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 2 external calls (new, assert_eq!).


##### `apply_role_preserves_unspecified_keys`  (lines 176–213)

```
async fn apply_role_preserves_unspecified_keys()
```

**Purpose**: Checks that applying a role only changes the settings the role actually names. This protects unrelated configuration, such as executable paths, from being accidentally cleared.

**Data flow**: It starts with a config whose model came from a command-line override, manually sets sandbox-related executable paths, writes a role file that only sets developer instructions and reasoning effort, applies the role, and checks that the old model and executable paths remain while reasoning effort changes.

**Call relations**: This test uses test_config_with_cli_overrides to simulate an existing user choice, write_role_config to create a narrow role file, and apply_role_to_config to prove that role merging is selective rather than destructive.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 3 external calls (from, assert_eq!, vec!).


##### `apply_role_reports_explicit_service_tier`  (lines 216–243)

```
async fn apply_role_reports_explicit_service_tier()
```

**Purpose**: Checks that a role can explicitly set the service tier, meaning the requested speed or priority class for model service. This matters when a role is meant to prefer faster service if the chosen model supports it.

**Data flow**: It writes a custom role file with service_tier set to priority, applies that role, and checks that the config's service_tier field becomes the request value for the fast tier.

**Call relations**: The test uses test_config_with_cli_overrides and write_role_config to build the scenario, then calls apply_role_to_config. It verifies that role file service tier settings are translated into the form used by later model requests.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 2 external calls (new, assert_eq!).


##### `apply_role_preserves_existing_service_tier_without_override`  (lines 246–273)

```
async fn apply_role_preserves_existing_service_tier_without_override()
```

**Purpose**: Checks that an existing service tier is kept when the role file does not mention service tier. This prevents a role from silently removing a user's previously selected priority setting.

**Data flow**: It creates a config, sets its service_tier to the fast request value, writes a role file with no service_tier field, applies the role, and checks that the original service tier is still present.

**Call relations**: The test starts with test_config_with_cli_overrides, writes a minimal role with write_role_config, and runs apply_role_to_config. It complements the explicit-service-tier test by checking the no-override path.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 2 external calls (new, assert_eq!).


##### `apply_role_does_not_materialize_default_sandbox_workspace_write_fields`  (lines 277–346)

```
async fn apply_role_does_not_materialize_default_sandbox_workspace_write_fields()
```

**Purpose**: Checks that a role's sandbox workspace-write settings only include fields the role actually supplied, instead of expanding hidden default fields into the role layer. This is important because copied defaults could accidentally override earlier user choices.

**Data flow**: It creates a config with workspace-write sandbox mode and network access enabled through command-line-style overrides. It writes a role file that adds only writable_roots under sandbox_workspace_write, applies the role, inspects the role's session-flags layer, and confirms that default fields like network_access were not inserted there. It also checks that the final sandbox policy still has network access enabled from the earlier setting.

**Call relations**: This test uses test_config_with_cli_overrides for the starting sandbox choices and write_role_config for the role layer. After apply_role_to_config, it looks directly into the config layer stack and the legacy sandbox policy to verify both layering and final behavior.

*Call graph*: calls 2 internal fn (test_config_with_cli_overrides, write_role_config); 3 external calls (assert_eq!, panic!, vec!).


##### `apply_role_takes_precedence_over_existing_session_flags_for_same_key`  (lines 349–377)

```
async fn apply_role_takes_precedence_over_existing_session_flags_for_same_key()
```

**Purpose**: Checks that role settings are added with higher priority than existing session flags when both set the same key. In plain terms, if the role says to use one model and an earlier session flag said another, the role wins.

**Data flow**: It creates a config with model set to cli-model, records the current count of session flag layers, writes a role file setting model to role-model, applies the role, and checks that the final model is role-model and one new session-flags layer was added.

**Call relations**: The test uses test_config_with_cli_overrides to simulate an earlier session flag, write_role_config to define the role override, and session_flags_layer_count to confirm the new layer. It directly tests apply_role_to_config's precedence behavior.

*Call graph*: calls 3 internal fn (session_flags_layer_count, test_config_with_cli_overrides, write_role_config); 2 external calls (assert_eq!, vec!).


##### `apply_role_skills_config_disables_skill_for_spawned_agent`  (lines 381–438)

```
async fn apply_role_skills_config_disables_skill_for_spawned_agent()
```

**Purpose**: Checks that a role can disable a skill for the spawned agent. A skill is an extra capability described by a SKILL.md file, and this test ensures role-specific skill settings are honored later when skills are loaded.

**Data flow**: It creates a demo skill file, writes a role file whose skills.config entry points at that skill and sets enabled to false, applies the role, then builds plugin and skills loading inputs from the final config. It asks the skills manager to discover skills and checks that the demo skill exists but is marked disabled.

**Call relations**: This is a longer integration-style test. It uses test_config_with_cli_overrides and write_role_config for setup, apply_role_to_config to add the role settings, PluginsManager to resolve plugin skill roots, and SkillsManager to load the skills. The final assertion proves the role setting survives into the skill-loading phase.

*Call graph*: calls 4 internal fn (new, new, test_config_with_cli_overrides, write_role_config); 8 external calls (clone, new, new, assert_eq!, skills_load_input_from_config, format!, create_dir_all, write).


##### `spawn_tool_spec_build_deduplicates_user_defined_built_in_roles`  (lines 441–460)

```
fn spawn_tool_spec_build_deduplicates_user_defined_built_in_roles()
```

**Purpose**: Checks that the spawn tool's role list does not show duplicate entries when a user defines a role with the same name as a built-in role. The user's version should be shown instead of the built-in description.

**Data flow**: It builds a map containing user-defined explorer and researcher roles, asks spawn_tool_spec::build to produce the text shown to the tool user, and checks that the user explorer text appears, the researcher entry appears, the default built-in appears, and the built-in explorer description does not appear.

**Call relations**: This test calls the spawn tool spec builder directly. It protects the user-facing role catalog produced from the combination of user roles and built-in roles.

*Call graph*: 4 external calls (from, assert!, default, build).


##### `spawn_tool_spec_lists_user_defined_roles_before_built_ins`  (lines 463–480)

```
fn spawn_tool_spec_lists_user_defined_roles_before_built_ins()
```

**Purpose**: Checks that user-defined roles are listed before built-in roles in the spawn tool description. This makes custom roles easier to notice and reinforces that user configuration takes priority.

**Data flow**: It creates one user-defined role, builds the spawn tool specification text, finds the position of that role and the built-in default role in the text, and asserts that the user role appears earlier.

**Call relations**: The test feeds a small role map into spawn_tool_spec::build. It focuses on ordering in the generated text rather than role application to Config.

*Call graph*: 3 external calls (from, assert!, build).


##### `spawn_tool_spec_marks_role_locked_model_and_reasoning_effort`  (lines 483–505)

```
fn spawn_tool_spec_marks_role_locked_model_and_reasoning_effort()
```

**Purpose**: Checks that the spawn tool description warns users when a role file fixes both the model and reasoning effort. Reasoning effort is the model's requested depth of thinking, and locked settings cannot be changed by the spawn request.

**Data flow**: It writes a temporary role file with model set to gpt-5 and model_reasoning_effort set to high, builds the spawn tool spec for that role, and checks that the generated text includes a clear locked-settings note.

**Call relations**: This test creates a role file on disk because spawn_tool_spec::build reads role config files to discover locked settings. It verifies the explanatory text produced for callers of the spawn tool.

*Call graph*: 5 external calls (from, new, assert!, write, build).


##### `spawn_tool_spec_marks_role_locked_reasoning_effort_only`  (lines 508–530)

```
fn spawn_tool_spec_marks_role_locked_reasoning_effort_only()
```

**Purpose**: Checks that the spawn tool description gives the right warning when only reasoning effort is fixed by a role. The message should not imply that the model is also locked.

**Data flow**: It writes a temporary role file with model_reasoning_effort set to medium, builds the spawn tool spec, and checks that the output says the reasoning effort is locked and cannot be changed.

**Call relations**: Like the other spawn tool spec tests, it calls spawn_tool_spec::build with a user role map. It covers the narrower locked-setting case where only reasoning effort is present in the role file.

*Call graph*: 5 external calls (from, new, assert!, write, build).


##### `spawn_tool_spec_marks_role_locked_service_tier`  (lines 533–555)

```
fn spawn_tool_spec_marks_role_locked_service_tier()
```

**Purpose**: Checks that the spawn tool description explains when a role fixes the service tier. This tells the requester that the role's service tier can take priority over a service tier supplied in the spawn request.

**Data flow**: It writes a temporary role file with service_tier set to priority, builds the spawn tool spec, and asserts that the output contains the expected note about service tier precedence.

**Call relations**: The test gives spawn_tool_spec::build a user-defined role backed by a config file. It protects the user-facing explanation of how role service tier settings interact with later spawn requests.

*Call graph*: 5 external calls (from, new, assert!, write, build).


##### `built_in_config_file_contents_resolves_explorer_only`  (lines 558–563)

```
fn built_in_config_file_contents_resolves_explorer_only()
```

**Purpose**: Checks that asking for built-in role config contents with an unknown file path returns nothing. Despite the function name, this particular assertion only verifies the missing-file case shown here.

**Data flow**: It passes the path missing.toml to built_in::config_file_contents and checks that the result is None, meaning no built-in contents were found for that path.

**Call relations**: This is a small direct test of the built_in role helper. It does not build a Config or apply a role; it verifies the lookup behavior used when built-in role config files are resolved.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/codex_delegate_tests.rs`

`test` · `test suite`

A delegated Codex run is like asking a helper to do part of the work while the main agent stays in charge. That creates tricky handoffs. The helper must forward its events to the parent, accept instructions from the parent, ask for permission when needed, and shut down cleanly if the user cancels. This test file checks those handoffs under edge cases that are easy to break.

The tests build small fake sessions using in-memory channels. A channel is a pipe between asynchronous tasks. The tests then start parts of the delegate machinery, send carefully chosen events through those pipes, and check what comes out the other side. Several tests focus on identifiers: a tool call ID, an approval callback ID, or tracing data must survive a round trip so later replies go to the right waiting task. Other tests focus on cancellation. They verify that a blocked event-forwarding task still shuts down, that a delegate started with an already-cancelled token returns immediately, and that a cancelled automatic MCP tool review produces a safe synthetic decline instead of waiting forever.

Without these tests, regressions in delegate coordination could cause hung sessions, approvals sent to the wrong request, lost observability tracing, or unsafe tool calls being treated as approved.

#### Function details

##### `forward_events_cancelled_while_send_blocked_shuts_down_delegate`  (lines 37–112)

```
async fn forward_events_cancelled_while_send_blocked_shuts_down_delegate()
```

**Purpose**: This test proves that event forwarding can still stop when its output pipe is full. It checks that cancellation causes the delegate to interrupt and shut down instead of hanging forever.

**Data flow**: It creates a fake Codex delegate with an input event channel and a deliberately full output channel. It sends one child event, drops the sender, cancels the cancellation token, and waits for the forwarding task to finish. The expected result is that the original prefilled output event remains there, and the delegate receives both an interrupt operation and a shutdown operation.

**Call relations**: The test sets up a session with make_session_and_context_with_rx, then starts forward_events as a background task. It forces forward_events into a blocked-send situation and then cancels it, checking the downstream submission channel to confirm that forward_events handed off the correct cleanup commands.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 15 external calls (clone, new, new, new, new, new, assert!, assert_eq!, bounded, RawResponseItem (+5 more)).


##### `forward_ops_preserves_submission_trace_context`  (lines 115–157)

```
async fn forward_ops_preserves_submission_trace_context()
```

**Purpose**: This test checks that when a parent sends an operation to a delegate, tracing information is not dropped. Tracing information is metadata used to connect related work across systems when debugging or monitoring.

**Data flow**: It creates a submission containing an interrupt operation and a W3C trace context, which includes traceparent and tracestate strings. It sends that submission into the operation-forwarding channel. The forwarded submission received by the delegate must have the same ID, the same operation, and the same trace data.

**Call relations**: The test starts forward_ops in the background, sends it one submission, and then reads from the Codex submission channel. It verifies that forward_ops acts like a faithful relay rather than rebuilding the message and accidentally losing the trace field.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 9 external calls (clone, new, new, from_secs, assert_eq!, bounded, spawn, timeout, channel).


##### `run_codex_thread_interactive_respects_pre_cancelled_spawn`  (lines 160–183)

```
async fn run_codex_thread_interactive_respects_pre_cancelled_spawn()
```

**Purpose**: This test makes sure a delegated interactive Codex run does not start work or hang if it is given a cancellation token that has already been cancelled. This protects callers from getting stuck during shutdown or abort paths.

**Data flow**: It creates a parent session and context, creates a cancellation token, cancels it immediately, and then calls run_codex_thread_interactive. The expected output is an error saying the turn was aborted, returned quickly within the timeout.

**Call relations**: The test calls run_codex_thread_interactive directly with a pre-cancelled token. It uses timeout around the call to prove the function notices cancellation at startup rather than waiting on later delegate activity.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 5 external calls (clone, new, from_secs, assert!, timeout).


##### `handle_request_permissions_uses_tool_call_id_for_round_trip`  (lines 186–282)

```
async fn handle_request_permissions_uses_tool_call_id_for_round_trip()
```

**Purpose**: This test checks that a delegated permission request uses the tool call ID as the key for the whole request-and-response cycle. That matters because the child must receive the answer meant for its exact permission request.

**Data flow**: It prepares a parent session, marks an active turn, and sets a remote environment. Then it calls handle_request_permissions with a request whose call ID is tool-call-1. The parent receives a RequestPermissions event with that same call ID, environment ID, and working directory. The test then sends a permission response back through the parent session using the same call ID, and expects the child submission channel to receive a RequestPermissionsResponse operation containing that ID and response.

**Call relations**: The test runs handle_request_permissions in a background task. That function sends a parent-facing permission event, waits for the parent session to be notified of the answer, and then hands an Op::RequestPermissionsResponse back to the delegate Codex instance.

*Call graph*: calls 2 internal fn (make_session_and_context_with_rx, default); 12 external calls (clone, get_mut, new, new, from_secs, default, assert_eq!, bounded, panic!, spawn (+2 more)).


##### `handle_exec_approval_uses_call_id_for_guardian_review_and_approval_id_for_reply`  (lines 285–395)

```
async fn handle_exec_approval_uses_call_id_for_guardian_review_and_approval_id_for_reply()
```

**Purpose**: This test checks two different identifiers in command approval flow. The command item ID is used for the guardian safety review, while the approval callback ID is used when replying to the child delegate.

**Data flow**: It configures the parent context to use automatic review and an on-request approval policy. It asks handle_exec_approval to review a risky shell command with call ID command-item-1 and approval ID callback-approval-1. The parent receives a GuardianAssessment event targeted at command-item-1. Then the test cancels the token, and the child receives an ExecApproval response using callback-approval-1 with an abort decision.

**Call relations**: The test starts handle_exec_approval as a background task and listens to the parent event stream until it sees the guardian assessment. It then cancels the task and checks the delegate submission channel, confirming that handle_exec_approval talks to the guardian using the command item ID but replies to the delegate using the approval ID.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 14 external calls (clone, new, try_unwrap, new, from_secs, new, assert!, assert_eq!, bounded, test_path_buf (+4 more)).


##### `delegated_mcp_guardian_abort_returns_synthetic_decline_answer`  (lines 398–454)

```
async fn delegated_mcp_guardian_abort_returns_synthetic_decline_answer()
```

**Purpose**: This test makes sure that if automatic review of a delegated MCP tool request is cancelled, the system safely answers as declined. MCP means Model Context Protocol, a way for the agent to call external tools.

**Data flow**: It configures automatic review, records a pending MCP invocation for call-1, and creates a user-input event asking whether to approve that tool call. The cancellation token is already cancelled. When maybe_auto_review_mcp_request_user_input runs, it returns a response containing a synthetic decline answer for the matching approval question.

**Call relations**: The test calls maybe_auto_review_mcp_request_user_input directly. It supplies the pending MCP invocation map and the approval-style question, then verifies that the function converts cancellation into a safe RequestUserInputResponse instead of returning no answer or allowing the request through.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 7 external calls (new, try_unwrap, new, from, new, assert_eq!, vec!).


##### `delegated_mcp_user_reviewer_returns_none_without_metadata`  (lines 457–492)

```
async fn delegated_mcp_user_reviewer_returns_none_without_metadata()
```

**Purpose**: This test checks that MCP approval auto-review does not invent an answer when it lacks the metadata needed for a user-reviewed Codex Apps tool call. In that case, the normal user-input path should continue.

**Data flow**: It creates a pending MCP invocation for call-1 from the Codex Apps MCP server and builds a matching approval question. The cancellation token is not cancelled. When maybe_auto_review_mcp_request_user_input is called, it returns None, meaning it did not produce an automatic response.

**Call relations**: The test calls maybe_auto_review_mcp_request_user_input with a Codex Apps MCP invocation but without the extra metadata needed to decide automatically. It confirms that the function leaves the request for another part of the system to process rather than guessing.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 6 external calls (new, new, from, new, assert_eq!, vec!).


### `core/src/thread_manager_tests.rs`

`test` · `test run`

A “thread” here is one running conversation session, with saved history called a rollout. This test file makes sure the thread manager behaves like a careful librarian: it can reopen a conversation, make a copy from a point in history, hide private internal work, and close every open conversation without losing track of what happened.

The tests cover several important edge cases. Some check how history is cut when a user forks from an earlier message, especially if the old thread stopped halfway through an assistant turn. Others check interruption markers: small history entries that say “this turn was interrupted,” so a forked conversation does not look like it is still mid-answer. There are also tests for resuming from saved rollout paths, preserving thread source metadata, avoiding stale environment selections, and using the configured thread store rather than assuming history lives only on disk.

The file also verifies operational behavior: internal threads should not appear in normal user-facing lists, shutdown should reach every thread, an explicitly supplied installation ID should not create a home-directory file, and model refresh should use the active provider. Without these tests, subtle bugs could make conversations resume with the wrong context, duplicate interruption markers, leak internal threads, or restore unsafe old environment choices.

#### Function details

##### `user_msg`  (lines 37–47)

```
fn user_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a fake user message for tests. It gives tests a short, readable way to create the same kind of history item that a real user message would produce.

**Data flow**: It takes plain text as input, wraps that text in a protocol message marked with the role "user", and returns a ResponseItem that can be placed into conversation history.

**Call relations**: History-truncation tests call this helper when they need user turns in a sample conversation. It keeps those tests focused on the behavior being checked instead of repeating message-building details.

*Call graph*: called by 2 (ignores_session_prefix_messages_when_truncating, truncates_before_requested_user_message); 1 external calls (vec!).


##### `assistant_msg`  (lines 48–58)

```
fn assistant_msg(text: &str) -> ResponseItem
```

**Purpose**: Builds a fake assistant message for tests. It is the companion to user_msg and represents text that the agent has already produced.

**Data flow**: It takes plain text, wraps it in a protocol message marked with the role "assistant", and returns a ResponseItem ready to be added to test history.

**Call relations**: The truncation tests call this helper to fill in assistant replies between user messages. That lets the tests model realistic back-and-forth conversations.

*Call graph*: called by 2 (ignores_session_prefix_messages_when_truncating, truncates_before_requested_user_message); 1 external calls (vec!).


##### `contextual_user_interrupted_marker`  (lines 60–63)

```
fn contextual_user_interrupted_marker() -> ResponseItem
```

**Purpose**: Creates the history marker used when a user-facing turn is interrupted. The marker is a special message that tells a later resumed or forked thread that the previous answer did not finish normally.

**Data flow**: It supplies the contextual-user interruption kind to interrupted_turn_history_marker, expects that marker creation is enabled, and returns the resulting ResponseItem.

**Call relations**: Interrupted-fork tests call this helper when comparing saved history against the expected interruption marker. It delegates the actual marker construction to the shared interrupted_turn_history_marker logic.

*Call graph*: calls 1 internal fn (interrupted_turn_history_marker); called by 2 (interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history, interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source).


##### `developer_interrupted_marker`  (lines 65–68)

```
fn developer_interrupted_marker() -> ResponseItem
```

**Purpose**: Creates the interruption marker used for developer-directed guidance in multi-agent behavior. This checks that the marker is shaped as developer input rather than ordinary user text.

**Data flow**: It asks interrupted_turn_history_marker for the developer interruption kind, expects that to succeed, and returns the marker message.

**Call relations**: The developer-marker test calls this helper, then inspects the returned message. The helper relies on the production marker-building function so the test checks the real format.

*Call graph*: calls 1 internal fn (interrupted_turn_history_marker); called by 1 (multi_agent_v2_interrupted_marker_uses_developer_input_message).


##### `truncates_before_requested_user_message`  (lines 71–141)

```
fn truncates_before_requested_user_message()
```

**Purpose**: Checks that forking history at a requested user message keeps the conversation only up to the right point. This protects the feature where a user can branch from an earlier moment without carrying later context into the new branch.

**Data flow**: It builds a mixed history of user messages, assistant messages, reasoning, and a tool call. It asks truncate_before_nth_user_message to cut before a chosen user message, then compares the resulting rollout items with the expected prefix.

**Call relations**: The Rust test runner invokes this test. It uses user_msg and assistant_msg to create sample history, then exercises the truncation function that thread forking depends on.

*Call graph*: calls 2 internal fn (assistant_msg, user_msg); 3 external calls (assert_eq!, Forked, vec!).


##### `out_of_range_truncation_drops_only_unfinished_suffix_mid_turn`  (lines 144–166)

```
fn out_of_range_truncation_drops_only_unfinished_suffix_mid_turn()
```

**Purpose**: Checks what happens when the requested fork point is beyond the available user messages while the history ends in an unfinished turn. The expected behavior is to remove only the unfinished tail, not valid completed history.

**Data flow**: It creates history with two user turns and a partial assistant reply, marks the snapshot as ending mid-turn, and asks for an out-of-range truncation. The result should contain only the completed first exchange.

**Call relations**: The test runner calls this directly. It exercises truncate_before_nth_user_message in the special case where no requested user message is found but unfinished work must still be discarded.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `fork_thread_accepts_legacy_usize_snapshot_argument`  (lines 169–185)

```
fn fork_thread_accepts_legacy_usize_snapshot_argument()
```

**Purpose**: Confirms that older call sites can still pass a plain number as the fork snapshot argument. This is a compile-time compatibility test, meaning it matters because the code must continue to build for legacy callers.

**Data flow**: It defines a small helper function that calls fork_thread with usize::MAX, then assigns that helper to a function pointer. If the old argument type is no longer accepted, compilation fails.

**Call relations**: The test runner does not need runtime behavior here; the important part is type checking during compilation. It connects to ThreadManager::fork_thread only to prove the legacy call shape still works.


##### `out_of_range_truncation_drops_pre_user_active_turn_prefix`  (lines 188–223)

```
fn out_of_range_truncation_drops_pre_user_active_turn_prefix()
```

**Purpose**: Checks that an unfinished active turn is removed cleanly even when the turn-start event appears before the user message. This prevents a fork from keeping a dangling “turn started” marker with no completed turn behind it.

**Data flow**: It builds history with one completed exchange, then a TurnStarted event, then an unfinished second turn. It detects the snapshot state, truncates with an out-of-range request, and verifies only the completed first exchange remains.

**Call relations**: The test runner calls this test. It first relies on snapshot_turn_state to identify where the active turn began, then feeds that state into truncate_before_nth_user_message.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `ignores_session_prefix_messages_when_truncating`  (lines 226–262)

```
async fn ignores_session_prefix_messages_when_truncating()
```

**Purpose**: Checks that automatic session setup messages do not count as user messages when choosing where to fork. This matters because hidden setup context should not shift the user-visible fork point.

**Data flow**: It creates a real test session context, asks the session to build its initial prefix messages, then adds two user-visible exchanges. It truncates before the first real user message and verifies the prefix plus first exchange remain.

**Call relations**: The async test runner calls this test. It uses make_session_and_context to get realistic session prefix data, then uses the same truncation path that forked threads use.

*Call graph*: calls 3 internal fn (make_session_and_context, assistant_msg, user_msg); 3 external calls (assert_eq!, Forked, vec!).


##### `shutdown_all_threads_bounded_submits_shutdown_to_every_thread`  (lines 265–299)

```
async fn shutdown_all_threads_bounded_submits_shutdown_to_every_thread()
```

**Purpose**: Checks that bounded shutdown sends a shutdown request to every running thread and removes them from the manager. “Bounded” means it waits only up to a specified time limit.

**Data flow**: It creates a temporary config and manager, starts two threads, then calls shutdown_all_threads_bounded with a generous timeout. The report should list both threads as completed, with no failures or timeouts, and the manager should list no remaining threads.

**Call relations**: The async test runner invokes this. It starts threads through ThreadManager, then exercises the manager-wide shutdown path that cleanup code would use.

*Call graph*: calls 4 internal fn (test_config, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 7 external calls (new, from_secs, assert!, assert_eq!, create_dir_all, tempdir, vec!).


##### `start_thread_keeps_internal_threads_hidden_from_normal_lookups`  (lines 302–342)

```
async fn start_thread_keeps_internal_threads_hidden_from_normal_lookups()
```

**Purpose**: Checks that internal background threads are not visible through normal user-facing thread lookup APIs. This prevents private system work, such as memory consolidation, from appearing like a user conversation.

**Data flow**: It starts a thread with an internal session source, then asks the manager to list and fetch normal threads. The internal thread should be absent from those APIs, but shutdown_all_threads_bounded should still find and close it.

**Call relations**: The async test runner calls this. It uses start_thread_with_options to create the internal thread and then verifies both lookup behavior and cleanup behavior.

*Call graph*: calls 4 internal fn (test_config, with_models_provider_and_home_for_tests, default_for_tests, from_api_key); 9 external calls (new, default, from_secs, new, Internal, assert!, assert_eq!, create_dir_all, tempdir).


##### `start_thread_seeds_extension_data_for_mcp_and_lifecycle_contributors`  (lines 345–524)

```
async fn start_thread_seeds_extension_data_for_mcp_and_lifecycle_contributors()
```

**Purpose**: Checks that per-thread extension data is available both to lifecycle hooks and to MCP server contributors. MCP means Model Context Protocol, a way to attach external tools or servers to a session.

**Data flow**: It defines a test extension that records selected capability roots, starts two threads with different selected roots, resolves their runtime MCP configs, and verifies each thread sees only its own initial data.

**Call relations**: The async test runner calls this. ThreadManager::new receives a custom extension registry, start_thread_with_options seeds thread-specific data, and runtime_mcp_config proves that both lifecycle and MCP contribution paths received it.

*Call graph*: calls 6 internal fn (test_config, new, default_for_tests, new, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 7 external calls (clone, new, new, assert_eq!, create_dir_all, new, tempdir).


##### `resume_and_fork_do_not_restore_thread_environments_from_rollout`  (lines 527–642)

```
async fn resume_and_fork_do_not_restore_thread_environments_from_rollout()
```

**Purpose**: Checks that resuming or forking from old saved history does not reuse a prior selected execution environment. This matters because a past working directory or environment choice may be stale or unsafe for a new run.

**Data flow**: It starts a source thread with a selected environment and working directory, saves its rollout, shuts it down, then resumes and forks from that rollout. New turns in both new threads should use the current config default directory, not the saved selected directory.

**Call relations**: The async test runner calls this. It drives ThreadManager start, resume, and fork paths, then asks the session to create new turn contexts to verify the environment selection that will actually be used.

*Call graph*: calls 6 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, try_from); 10 external calls (new, default, new, assert_eq!, assert_ne!, empty_extension_registry, default, create_dir_all, tempdir, vec!).


##### `explicit_installation_id_skips_codex_home_file`  (lines 645–685)

```
async fn explicit_installation_id_skips_codex_home_file()
```

**Purpose**: Checks that when an installation ID is supplied directly to ThreadManager, the manager does not create or read the usual installation-ID file under the Codex home directory. This avoids unnecessary disk state in tests or controlled setups.

**Data flow**: It builds a manager with a generated installation ID, starts a thread, and then checks two things: no installation ID file was created, and the session inside the thread uses the supplied ID.

**Call relations**: The async test runner invokes this. It goes through the normal ThreadManager::new and start_thread path to ensure the explicit ID is honored by real session creation.

*Call graph*: calls 5 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 8 external calls (new, assert!, assert_eq!, empty_extension_registry, init_state_db, create_dir_all, tempdir, new_v4).


##### `resume_active_thread_from_rollout_returns_running_thread`  (lines 688–743)

```
async fn resume_active_thread_from_rollout_returns_running_thread()
```

**Purpose**: Checks that resuming from the rollout path of a thread that is already running returns that same live thread instead of creating a duplicate. This prevents two active objects from claiming the same conversation.

**Data flow**: It starts a thread, materializes and flushes its rollout to get a path, then asks the manager to resume from that path. The returned thread ID and shared pointer should match the original running thread.

**Call relations**: The async test runner calls this. It exercises resume_thread_from_rollout while the source is still registered in the ThreadManager.

*Call graph*: calls 5 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 6 external calls (new, assert!, assert_eq!, empty_extension_registry, create_dir_all, tempdir).


##### `resume_stopped_thread_from_rollout_spawns_new_thread`  (lines 746–806)

```
async fn resume_stopped_thread_from_rollout_spawns_new_thread()
```

**Purpose**: Checks that resuming from a rollout after the original thread has stopped creates a new live thread object with the same conversation ID. This is the normal “reopen a saved conversation” behavior.

**Data flow**: It starts and saves a source thread, shuts it down, then resumes from its rollout path. The resumed thread should have the same thread ID but should not be the same in-memory object.

**Call relations**: The async test runner invokes this. It uses the same resume_thread_from_rollout path as reopening a previous conversation after the old worker has exited.

*Call graph*: calls 5 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 6 external calls (new, assert!, assert_eq!, empty_extension_registry, create_dir_all, tempdir).


##### `resume_stopped_thread_from_rollout_preserves_thread_source`  (lines 809–890)

```
async fn resume_stopped_thread_from_rollout_preserves_thread_source()
```

**Purpose**: Checks that metadata describing where a thread came from is kept when a stopped thread is resumed. In this test, a thread marked as user-created should still be marked that way after reopening.

**Data flow**: It starts a thread with ThreadSource::User, saves and shuts it down, removes it from the manager, then resumes it from its rollout. The resumed thread’s config snapshot should still contain the user source.

**Call relations**: The async test runner calls this. It combines ThreadManager start, rollout saving, removal, and resume to verify metadata survives the full persistence round trip.

*Call graph*: calls 5 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 8 external calls (new, default, new, assert_eq!, empty_extension_registry, init_state_db, create_dir_all, tempdir).


##### `rollout_path_resume_and_fork_read_history_through_thread_store`  (lines 893–996)

```
async fn rollout_path_resume_and_fork_read_history_through_thread_store()
```

**Purpose**: Checks that resume and fork by rollout path ask the configured thread store for history instead of assuming a plain file read. This matters because the project can use different storage backends, including an in-memory store.

**Data flow**: It configures an in-memory thread store, seeds a resumed history with a rollout path, then resumes and forks using that path. Finally it checks the store’s call counter to confirm both operations read history through the store.

**Call relations**: The async test runner invokes this. It drives resume_thread_with_history, resume_thread_from_rollout, and fork_thread, while the in-memory store records whether those paths used the storage abstraction.

*Call graph*: calls 5 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 10 external calls (new, assert_eq!, assert_ne!, empty_extension_registry, init_state_db, format!, Resumed, create_dir_all, tempdir, vec!).


##### `new_uses_active_provider_for_model_refresh`  (lines 999–1029)

```
async fn new_uses_active_provider_for_model_refresh()
```

**Purpose**: Checks that a new ThreadManager refreshes the model list from the active configured model provider. This protects setups where the provider URL is changed and the manager must not use a stale default.

**Data flow**: It starts a mock HTTP server, configures the model provider to point at it, creates a manager, and asks for an online model refresh. The mock server should receive exactly one models request.

**Call relations**: The async test runner calls this. It uses mount_models_once to fake the provider response, then calls manager.list_models to verify the request goes to the configured provider.

*Call graph*: calls 6 internal fn (test_config, new, mount_models_once, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 7 external calls (new, start, assert_eq!, empty_extension_registry, create_dir_all, tempdir, vec!).


##### `interrupted_fork_snapshot_appends_interrupt_boundary`  (lines 1032–1079)

```
fn interrupted_fork_snapshot_appends_interrupt_boundary()
```

**Purpose**: Checks that an interrupted fork adds a clear boundary to history: an interruption marker plus a turn-aborted event. This prevents the new fork from looking like it is still inside an unfinished answer.

**Data flow**: It starts with committed history, calls append_interrupted_boundary with the contextual-user marker type, and compares the resulting rollout items with the expected original history plus marker and abort event. It also checks the empty-history case.

**Call relations**: The test runner calls this. It directly exercises append_interrupted_boundary, the helper used when creating fork snapshots from interrupted turns.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `disabled_interrupted_fork_snapshot_appends_only_interrupt_event`  (lines 1082–1127)

```
fn disabled_interrupted_fork_snapshot_appends_only_interrupt_event()
```

**Purpose**: Checks the behavior when interruption marker messages are disabled. The fork should still record that the turn was aborted, but it should not add the extra marker message.

**Data flow**: It calls append_interrupted_boundary with the disabled marker mode for both non-empty and empty histories. The resulting history should contain only the abort event added after any existing committed items.

**Call relations**: The test runner invokes this. It covers the same boundary-adding function as the previous test, but for the configuration where marker messages are intentionally omitted.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `interrupted_snapshot_is_not_mid_turn`  (lines 1130–1151)

```
fn interrupted_snapshot_is_not_mid_turn()
```

**Purpose**: Checks that history ending with an interruption marker and abort event is considered complete, not mid-turn. This is important so repeated forks do not keep adding more interruption boundaries.

**Data flow**: It builds history with a user message, a partial assistant message, an interruption marker, and a TurnAborted event. snapshot_turn_state should report that the history no longer ends mid-turn.

**Call relations**: The test runner calls this. It verifies snapshot_turn_state understands the boundary format created by append_interrupted_boundary.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `multi_agent_v2_interrupted_marker_uses_developer_input_message`  (lines 1154–1169)

```
fn multi_agent_v2_interrupted_marker_uses_developer_input_message()
```

**Purpose**: Checks that the developer-style interruption marker is a developer message using input text with the expected guidance. This matters for multi-agent behavior, where developer instructions have a different role than user chat text.

**Data flow**: It creates a developer interrupted marker, pattern-matches it as a message, then checks the role and content. If the marker is not a developer InputText containing the expected guidance, the test fails.

**Call relations**: The test runner invokes this. It calls developer_interrupted_marker, which in turn uses the shared interrupted_turn_history_marker builder.

*Call graph*: calls 1 internal fn (developer_interrupted_marker); 3 external calls (assert!, assert_eq!, panic!).


##### `completed_legacy_event_history_is_not_mid_turn`  (lines 1172–1197)

```
fn completed_legacy_event_history_is_not_mid_turn()
```

**Purpose**: Checks that older event-style history with a user message followed by an agent message is treated as a completed turn. This preserves compatibility with saved histories from older formats.

**Data flow**: It creates legacy UserMessage and AgentMessage events, wraps them as forked initial history, and asks snapshot_turn_state to classify the history. The expected state is not mid-turn.

**Call relations**: The test runner calls this. It exercises snapshot_turn_state on legacy EventMsg history rather than newer ResponseItem history.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `mixed_response_and_legacy_user_event_history_is_mid_turn`  (lines 1200–1221)

```
fn mixed_response_and_legacy_user_event_history_is_mid_turn()
```

**Purpose**: Checks that a suspicious mix of newer response-item user history and legacy user-event history is treated as unfinished. This conservative choice avoids accidentally considering incomplete history safe to fork from.

**Data flow**: It builds history containing a ResponseItem user message followed by a legacy UserMessage event, then asks snapshot_turn_state to classify it. The expected result says the history ends mid-turn.

**Call relations**: The test runner invokes this. It covers a mixed-format edge case in the same snapshot detection logic used by fork behavior.

*Call graph*: 3 external calls (assert_eq!, Forked, vec!).


##### `interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history`  (lines 1224–1328)

```
async fn interrupted_fork_snapshot_does_not_synthesize_turn_id_for_legacy_history()
```

**Purpose**: Checks that when legacy-style partial history has no explicit turn ID, an interrupted fork does not invent one. The abort event should accurately reflect that no turn ID was known.

**Data flow**: It creates a source thread from partial history, reads the saved rollout, confirms the snapshot is mid-turn with no active turn ID, then forks with an interrupted snapshot. The forked history should contain exactly one interruption marker and one abort event whose turn ID is still absent.

**Call relations**: The async test runner calls this. It uses ThreadManager resume and fork paths, RolloutRecorder to read saved history, snapshot_turn_state to inspect it, and contextual_user_interrupted_marker for the expected marker.

*Call graph*: calls 7 internal fn (test_config, new, contextual_user_interrupted_marker, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, get_rollout_history); 13 external calls (new, assert!, assert_eq!, empty_extension_registry, init_state_db, TurnAborted, Forked, EventMsg, ResponseItem, to_value (+3 more)).


##### `interrupted_fork_snapshot_preserves_explicit_turn_id`  (lines 1331–1425)

```
async fn interrupted_fork_snapshot_preserves_explicit_turn_id()
```

**Purpose**: Checks that if partial history includes an explicit turn ID, an interrupted fork keeps that ID in the abort event. This keeps tracing and history boundaries tied to the original turn.

**Data flow**: It creates source history beginning with a TurnStarted event named "turn-explicit", saves it, verifies snapshot_turn_state finds that active turn, then forks with an interrupted snapshot. The forked rollout should include a TurnAborted event with the same turn ID.

**Call relations**: The async test runner invokes this. It drives persisted history through ThreadManager and RolloutRecorder, then validates the interruption boundary added by fork_thread.

*Call graph*: calls 6 internal fn (test_config, new, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, get_rollout_history); 9 external calls (new, assert!, assert_eq!, empty_extension_registry, init_state_db, Forked, create_dir_all, tempdir, vec!).


##### `interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source`  (lines 1428–1562)

```
async fn interrupted_fork_snapshot_uses_persisted_mid_turn_history_without_live_source()
```

**Purpose**: Checks that an interrupted fork can use saved mid-turn history even if the original live thread is no longer registered. It also checks that re-forking an already-interrupted fork does not duplicate the interruption boundary.

**Data flow**: It creates a source thread from partial history, reads and confirms the saved history is mid-turn, removes the live source, then forks from the saved rollout. The forked history should no longer be mid-turn and should contain one marker. It then removes that fork and forks again from it, expecting still only one marker and one abort event.

**Call relations**: The async test runner calls this. It exercises fork_thread using persisted rollout history through RolloutRecorder rather than relying on a live ThreadManager entry, and it compares markers using contextual_user_interrupted_marker.

*Call graph*: calls 7 internal fn (test_config, new, contextual_user_interrupted_marker, default_for_tests, from_auth_for_testing, create_dummy_chatgpt_auth_for_testing, get_rollout_history); 11 external calls (new, assert!, assert_eq!, empty_extension_registry, init_state_db, Forked, ResponseItem, to_value, create_dir_all, tempdir (+1 more)).


### Policy and approval behavior
These files lock down execution policy, safety decisions, guardian review behavior, MCP exposure, and sandbox labeling across platforms and approval modes.

### `core/src/guardian/tests.rs`

`test` · `test run`

The Guardian feature is like a second pair of eyes for dangerous actions: shell commands, patches, network access, and tool calls that may need approval. This test file checks that the Guardian is given the right evidence, returns decisions in the expected format, and fails safely when something goes wrong. It builds fake sessions, seeds them with parent conversation history, and points model requests at mock servers so tests can inspect exactly what would be sent to the review model. The tests cover prompt construction, transcript numbering, truncation of large text, JSON shapes for approval requests, retry behavior, cancellation, analytics metadata, and how prior Guardian reviews are reused. They also verify that the Guardian review session is deliberately restricted: no parent developer instructions, no apps/plugins/MCP servers/memory injection, read-only permissions, and a controlled network proxy. Without these tests, a change could silently leak extra context into the Guardian, omit important evidence, retry unsafe denials, or approve actions using the wrong model or policy.

#### Function details

##### `fixed_guardian_parent_session_id`  (lines 81–84)

```
fn fixed_guardian_parent_session_id() -> ThreadId
```

**Purpose**: Returns a fixed, valid session identifier used by many Guardian tests. This makes snapshots and comparisons stable instead of changing every run.

**Data flow**: It starts with a hard-coded UUID string, parses it into a ThreadId, and returns that ThreadId. If the string ever stops being valid, the test setup fails immediately.

**Call relations**: Helper setup functions and several prompt-layout tests call this when they need the parent session to have a predictable identity.

*Call graph*: calls 1 internal fn (from_string); called by 4 (build_guardian_prompt_includes_parent_turn_denied_reads, guardian_review_request_layout_matches_model_visible_request_snapshot, guardian_test_session_and_turn_with_base_url, guardian_test_session_turn_and_rx).


##### `GuardianMemoryContextProbe::on_thread_start`  (lines 97–106)

```
fn on_thread_start(
        &'a self,
        input: codex_extension_api::ThreadStartInput<'a, Config>,
    ) -> codex_extension_api::ExtensionFuture<'a, ()>
```

**Purpose**: Records whether memory support is enabled when a test Guardian thread starts. It is a probe used to prove that Guardian reviews do not accidentally inherit memory context.

**Data flow**: It receives thread-start input from the extension framework, reads the configuration flag for memories, and stores that boolean in the thread-local extension data.

**Call relations**: The extension framework calls this method when the probe is registered in a test session and a thread starts.

*Call graph*: 1 external calls (pin).


##### `GuardianMemoryContextProbe::contribute`  (lines 110–127)

```
fn contribute(
        &'a self,
        _session_store: &'a codex_extension_api::ExtensionData,
        thread_store: &'a codex_extension_api::ExtensionData,
    ) -> codex_extension_api::ExtensionFu
```

**Purpose**: Adds a marker prompt fragment only if the stored memory-enabled flag is true. Tests use that marker to detect unwanted memory context inside Guardian prompts.

**Data flow**: It reads the thread extension store, checks for the saved memory flag, and returns either one developer-policy prompt fragment or an empty list.

**Call relations**: The extension framework calls this while assembling prompt context; the large request-layout test registers the probe and then verifies the marker does not appear in Guardian requests.

*Call graph*: 3 external calls (pin, new, vec!).


##### `guardian_rejection_circuit_breaker_interrupts_after_three_consecutive_denials`  (lines 131–152)

```
fn guardian_rejection_circuit_breaker_interrupts_after_three_consecutive_denials()
```

**Purpose**: Checks that three denials in a row stop the current turn. This prevents the system from repeatedly asking for approvals after the Guardian keeps rejecting them.

**Data flow**: The test creates a fresh circuit breaker, records repeated denials for one turn, and compares each returned action with the expected continue-or-interrupt result.

**Call relations**: The Rust test runner calls this directly; it exercises the GuardianRejectionCircuitBreaker behavior used by approval review flow.

*Call graph*: 2 external calls (assert_eq!, default).


##### `guardian_rejection_circuit_breaker_resets_consecutive_denials_on_non_denial`  (lines 155–177)

```
fn guardian_rejection_circuit_breaker_resets_consecutive_denials_on_non_denial()
```

**Purpose**: Verifies that a non-denial resets the consecutive-denial count but does not erase recent denial history. This distinguishes a short denial streak from repeated trouble over time.

**Data flow**: It records a denial, records a non-denial, then records more denials and checks that interruption happens only after three new consecutive denials, with the total recent count preserved.

**Call relations**: The test runner calls this; it focuses on the same circuit breaker used during Guardian-driven approval decisions.

*Call graph*: 2 external calls (assert_eq!, default).


##### `auto_review_rejection_circuit_breaker_interrupts_after_ten_recent_denials`  (lines 180–196)

```
fn auto_review_rejection_circuit_breaker_interrupts_after_ten_recent_denials()
```

**Purpose**: Checks the broader safety rule that ten recent denials interrupt the turn even if they are not consecutive. This catches a pattern of repeated rejected actions.

**Data flow**: It alternates denials and non-denials nine times, then adds a tenth denial and expects an interrupt action with one consecutive denial but ten recent denials.

**Call relations**: The test runner calls this to protect the recent-denial window logic.

*Call graph*: 2 external calls (assert_eq!, default).


##### `auto_review_rejection_circuit_breaker_forgets_denials_outside_recent_review_window`  (lines 199–215)

```
fn auto_review_rejection_circuit_breaker_forgets_denials_outside_recent_review_window()
```

**Purpose**: Confirms that old denials eventually age out of the recent-denial window. This keeps the circuit breaker from punishing a session forever for old events.

**Data flow**: It records nine denials separated by non-denials, adds enough non-denials to move them outside the window, then verifies a new denial does not interrupt the turn.

**Call relations**: The test runner calls this; it checks the windowing behavior that supports the Guardian rejection safety mechanism.

*Call graph*: 2 external calls (assert_eq!, default).


##### `guardian_test_session_and_turn`  (lines 217–221)

```
async fn guardian_test_session_and_turn(
    server: &wiremock::MockServer,
) -> (Arc<Session>, Arc<TurnContext>)
```

**Purpose**: Creates a standard test session and turn wired to a mock model server. It saves repeated setup code for tests that need Guardian model calls.

**Data flow**: It reads the mock server URL, passes it to the base-URL setup helper, and returns a shared Session and TurnContext.

**Call relations**: Many async Guardian review tests call this before seeding history and running a review against mocked responses.

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

**Purpose**: Creates a Guardian-ready test session, turn, and event receiver. Tests use the receiver to inspect Guardian status and warning events emitted during review.

**Data flow**: It starts a session with an event channel, assigns a fixed parent thread id, points the model provider at the mock server, rebuilds the models manager and provider, clears user instructions, and returns the session, turn, and receiver.

**Call relations**: The retry-exhaustion test calls this so it can check that only the expected terminal Guardian event is emitted.

*Call graph*: calls 3 internal fn (fixed_guardian_parent_session_id, make_session_and_context_with_rx, models_manager_with_provider); called by 1 (guardian_review_exhausts_three_failures_with_one_terminal_event); 5 external calls (clone, get_mut, new, create_model_provider, format!).


##### `guardian_shell_request`  (lines 256–265)

```
fn guardian_shell_request(id: &str) -> GuardianApprovalRequest
```

**Purpose**: Builds a reusable sample shell approval request for `git push`. This keeps retry and denial tests focused on Guardian behavior instead of request construction.

**Data flow**: It takes an id string, fills in a command, working directory, default sandbox permissions, and justification, then returns a GuardianApprovalRequest::Shell.

**Call relations**: Several review retry and denial tests call this helper before sending the request into the Guardian review function.

*Call graph*: called by 5 (guardian_review_does_not_retry_missing_assessment_payload, guardian_review_does_not_retry_valid_denial, guardian_review_exhausts_three_failures_with_one_terminal_event, guardian_review_retries_transient_session_failure_then_approves, guardian_review_retries_two_parse_failures_then_approves); 2 external calls (test_path_buf, vec!).


##### `guardian_test_session_and_turn_with_base_url`  (lines 267–286)

```
async fn guardian_test_session_and_turn_with_base_url(
    base_url: &str,
) -> (Arc<Session>, Arc<TurnContext>)
```

**Purpose**: Creates a test session and turn whose model provider sends requests to a chosen base URL. This is the main setup helper for prompt-building and mock-server tests.

**Data flow**: It makes a normal test session, fixes the parent thread id, clones and edits the config to use the supplied URL, rebuilds the models manager and provider, clears user instructions, and returns shared session and turn objects.

**Call relations**: The simpler mock-server helper calls this, and many prompt tests call it directly with a local fake URL.

*Call graph*: calls 3 internal fn (fixed_guardian_parent_session_id, make_session_and_context, models_manager_with_provider); called by 7 (build_guardian_prompt_delta_mode_handles_empty_delta, build_guardian_prompt_delta_mode_preserves_original_numbering, build_guardian_prompt_full_mode_preserves_initial_review_format, build_guardian_prompt_items_explains_network_access_review_scope, build_guardian_prompt_stale_delta_cursor_falls_back_to_full_prompt, build_guardian_prompt_stale_delta_version_falls_back_to_full_prompt, guardian_test_session_and_turn); 4 external calls (clone, new, create_model_provider, format!).


##### `seed_guardian_parent_history`  (lines 288–331)

```
async fn seed_guardian_parent_history(session: &Arc<Session>, turn: &Arc<TurnContext>)
```

**Purpose**: Adds a realistic parent conversation to a test session. The seeded history gives Guardian prompts something meaningful to quote and assess.

**Data flow**: It writes user text, a tool call, the tool output, and an assistant message into the session history for the given turn.

**Call relations**: Most prompt and review tests call this after creating a session so the Guardian has parent context to include in its review.

*Call graph*: calls 1 internal fn (from_text); called by 16 (build_guardian_prompt_delta_mode_handles_empty_delta, build_guardian_prompt_delta_mode_preserves_original_numbering, build_guardian_prompt_full_mode_preserves_initial_review_format, build_guardian_prompt_includes_parent_turn_denied_reads, build_guardian_prompt_items_explains_network_access_review_scope, build_guardian_prompt_stale_delta_cursor_falls_back_to_full_prompt, build_guardian_prompt_stale_delta_version_falls_back_to_full_prompt, guardian_request_model_for_auto_review, guardian_reuses_prompt_cache_key_and_appends_prior_reviews, guardian_review_does_not_retry_missing_assessment_payload (+6 more)); 1 external calls (vec!).


##### `rollout_item_contains_message_text`  (lines 333–338)

```
fn rollout_item_contains_message_text(item: &RolloutItem, needle: &str) -> bool
```

**Purpose**: Checks whether a saved rollout item contains a message with a chosen piece of text. Tests use it to inspect persisted Guardian fork history.

**Data flow**: It receives a rollout item and search text, ignores non-response items, and delegates message inspection to response_item_contains_message_text.

**Call relations**: The prompt-cache reuse test uses this helper when counting whether a follow-up reminder was saved exactly once.

*Call graph*: calls 1 internal fn (response_item_contains_message_text).


##### `response_item_contains_message_text`  (lines 340–348)

```
fn response_item_contains_message_text(item: &ResponseItem, needle: &str) -> bool
```

**Purpose**: Checks whether a response message contains a given text snippet. It hides the details of message content variants from tests.

**Data flow**: It receives a ResponseItem and search text, ignores non-message items, scans text content pieces, and returns true if any contains the snippet.

**Call relations**: rollout_item_contains_message_text calls this after unwrapping rollout items into response items.

*Call graph*: called by 1 (rollout_item_contains_message_text).


##### `guardian_snapshot_options`  (lines 350–354)

```
fn guardian_snapshot_options() -> ContextSnapshotOptions
```

**Purpose**: Builds snapshot-formatting options suitable for Guardian request snapshots. It removes noisy context that would distract from the Guardian-specific request layout.

**Data flow**: It starts from default snapshot options, turns on stripping for capability instructions and AGENTS.md user context, and returns the configured options.

**Call relations**: Snapshot tests call this when formatting captured model requests for stable comparison.

*Call graph*: calls 1 internal fn (default).


##### `normalize_guardian_snapshot_paths`  (lines 356–373)

```
fn normalize_guardian_snapshot_paths(text: String) -> String
```

**Purpose**: Normalizes platform-specific file paths in snapshot text. This keeps snapshots the same on Unix, Windows, and other environments.

**Data flow**: It receives snapshot text, replaces local platform spellings of known test paths with canonical strings, and returns the cleaned text.

**Call relations**: Snapshot-based Guardian prompt and request tests call this just before asserting stored snapshots.

*Call graph*: 2 external calls (test_path_buf, to_string).


##### `guardian_prompt_text`  (lines 375–383)

```
fn guardian_prompt_text(items: &[codex_protocol::user_input::UserInput]) -> String
```

**Purpose**: Combines the text parts of Guardian prompt input into one string for assertions. This makes prompt tests easy to read.

**Data flow**: It receives a list of user-input items, keeps the text from text items, ignores non-text items, concatenates the pieces, and returns the result.

**Call relations**: Most prompt-building tests call this after build_guardian_prompt_items returns structured prompt items.

*Call graph*: called by 7 (build_guardian_prompt_delta_mode_handles_empty_delta, build_guardian_prompt_delta_mode_preserves_original_numbering, build_guardian_prompt_full_mode_preserves_initial_review_format, build_guardian_prompt_includes_parent_turn_denied_reads, build_guardian_prompt_items_explains_network_access_review_scope, build_guardian_prompt_stale_delta_cursor_falls_back_to_full_prompt, build_guardian_prompt_stale_delta_version_falls_back_to_full_prompt); 1 external calls (iter).


##### `last_user_message_text_from_body`  (lines 385–398)

```
fn last_user_message_text_from_body(body: &serde_json::Value) -> String
```

**Purpose**: Extracts the final user message text from a captured JSON request body. Tests use it to inspect exactly what the model would see last.

**Data flow**: It walks the request body's input array, finds the last user message, collects its input_text spans, concatenates them, and returns the text.

**Call relations**: The parallel trunk-and-fork Guardian test calls this to confirm the retried fork prompt contains the expected transcript delta.


##### `build_guardian_transcript_keeps_original_numbering`  (lines 401–427)

```
fn build_guardian_transcript_keeps_original_numbering()
```

**Purpose**: Checks that rendered transcript entries keep their original numbering when only a prefix is rendered. Stable numbering helps the Guardian refer back to conversation evidence.

**Data flow**: It creates three transcript entries, renders only the first two, and verifies the rendered labels are [1] and [2] with no omission notice.

**Call relations**: The test runner calls this; it directly exercises transcript rendering.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `build_guardian_prompt_full_mode_preserves_initial_review_format`  (lines 430–458)

```
async fn build_guardian_prompt_full_mode_preserves_initial_review_format() -> anyhow::Result<()>
```

**Purpose**: Verifies that a full Guardian prompt uses the expected initial-review wording and transcript boundaries. This protects the first-review prompt contract.

**Data flow**: It creates a session, seeds parent history, builds a full prompt for a shell request, converts prompt items to text, and checks for required and forbidden phrases.

**Call relations**: It uses the session setup, history seeding, and prompt-text helpers before asserting behavior of build_guardian_prompt_items.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, assert_eq!, test_path_buf, vec!).


##### `build_guardian_prompt_includes_parent_turn_denied_reads`  (lines 461–516)

```
async fn build_guardian_prompt_includes_parent_turn_denied_reads() -> anyhow::Result<()>
```

**Purpose**: Checks that Guardian prompts tell the reviewer about files the parent turn was denied from reading. This matters because escalation should not be approved just to bypass denied read rules.

**Data flow**: It builds a turn with read-only access except denied private paths, seeds history, builds a prompt for a command trying to read a secret file, and verifies the denied paths and warning language appear.

**Call relations**: The test runner calls it; it sets up custom permissions and then exercises build_guardian_prompt_items_with_parent_turn.

*Call graph*: calls 6 internal fn (fixed_guardian_parent_session_id, guardian_prompt_text, seed_guardian_parent_history, make_session_and_context, from_runtime_permissions, restricted); 4 external calls (new, assert!, test_path_buf, vec!).


##### `build_guardian_prompt_delta_mode_preserves_original_numbering`  (lines 519–579)

```
async fn build_guardian_prompt_delta_mode_preserves_original_numbering() -> anyhow::Result<()>
```

**Purpose**: Checks that follow-up Guardian prompts include only new transcript entries while preserving their original numbers. This lets reused Guardian sessions understand what changed.

**Data flow**: It seeds four entries, adds two more, builds a delta prompt starting after the first four, and verifies entries [5] and [6] appear while earlier entries do not.

**Call relations**: It relies on the setup and history helpers, then tests build_guardian_prompt_items in delta mode.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, assert_eq!, test_path_buf, vec!).


##### `build_guardian_prompt_delta_mode_handles_empty_delta`  (lines 582–613)

```
async fn build_guardian_prompt_delta_mode_handles_empty_delta() -> anyhow::Result<()>
```

**Purpose**: Verifies that an empty follow-up transcript delta is explicitly represented. This avoids confusing the Guardian when no new retained history exists.

**Data flow**: It seeds history, asks for a delta prompt from the current cursor, and checks that the prompt contains an empty-delta marker and keeps the cursor unchanged.

**Call relations**: The test runner calls it to protect delta-prompt behavior for reused Guardian review sessions.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, assert_eq!, test_path_buf, vec!).


##### `build_guardian_prompt_stale_delta_cursor_falls_back_to_full_prompt`  (lines 616–648)

```
async fn build_guardian_prompt_stale_delta_cursor_falls_back_to_full_prompt() -> anyhow::Result<()>
```

**Purpose**: Checks that an impossible delta cursor causes a full prompt instead of a broken delta. This is a safe fallback when stored review state is out of sync.

**Data flow**: It seeds four transcript entries, asks for a delta starting at entry 99, and verifies the result is a full transcript prompt with the correct cursor reset.

**Call relations**: It exercises build_guardian_prompt_items through the same helpers used by other prompt tests.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, assert_eq!, test_path_buf, vec!).


##### `build_guardian_prompt_stale_delta_version_falls_back_to_full_prompt`  (lines 651–736)

```
async fn build_guardian_prompt_stale_delta_version_falls_back_to_full_prompt() -> anyhow::Result<()>
```

**Purpose**: Checks that history compaction invalidates old delta cursors. After history is replaced, the Guardian should receive a full prompt for the new retained history.

**Data flow**: It seeds history, replaces the session history to bump its version, adds more messages, builds a delta prompt using the old version, and verifies the prompt falls back to full mode with the new cursor version.

**Call relations**: This test combines session history replacement with build_guardian_prompt_items to verify stale-state handling.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, assert_eq!, test_path_buf, vec!).


##### `collect_guardian_transcript_entries_skips_contextual_user_messages`  (lines 739–771)

```
fn collect_guardian_transcript_entries_skips_contextual_user_messages()
```

**Purpose**: Verifies that environment-context messages are not treated as user conversation evidence. The Guardian should assess user intent, not boilerplate environment data.

**Data flow**: It builds a fake history with an environment-context user message and an assistant reply, collects transcript entries, and expects only the assistant entry.

**Call relations**: The test runner calls it to exercise collect_guardian_transcript_entries.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `collect_guardian_transcript_entries_keeps_manual_approval_developer_message`  (lines 774–807)

```
fn collect_guardian_transcript_entries_keeps_manual_approval_developer_message()
```

**Purpose**: Checks that special developer messages representing manual approvals are retained. These messages can be important evidence for later Guardian decisions.

**Data flow**: It creates ordinary and approval-prefixed developer messages, collects transcript entries, and verifies only the manual-approval message remains.

**Call relations**: The test runner calls it to protect the transcript filter rules.

*Call graph*: 3 external calls (assert_eq!, format!, vec!).


##### `collect_guardian_transcript_entries_includes_recent_tool_calls_and_output`  (lines 810–864)

```
fn collect_guardian_transcript_entries_includes_recent_tool_calls_and_output()
```

**Purpose**: Verifies that tool calls and their outputs are included in Guardian transcript evidence. This helps the reviewer see what the agent already did or learned.

**Data flow**: It creates user text, a tool call, tool output, and assistant text, collects transcript entries, and checks that the tool call and result are represented with useful labels.

**Call relations**: The test runner calls it to exercise collection of non-message response items.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `guardian_truncate_text_keeps_prefix_suffix_and_xml_marker`  (lines 867–876)

```
fn guardian_truncate_text_keeps_prefix_suffix_and_xml_marker()
```

**Purpose**: Checks that long text is shortened while preserving both the beginning and end. The inserted marker tells the Guardian that content was omitted.

**Data flow**: It creates a very long string, truncates it with a small token budget, and verifies the result starts with the prefix, ends with the suffix, includes a truncation marker, and reports truncation.

**Call relations**: The test runner calls this to protect the helper used when large actions or transcripts must fit into prompts.

*Call graph*: 1 external calls (assert!).


##### `format_guardian_action_pretty_truncates_large_string_fields`  (lines 879–895)

```
fn format_guardian_action_pretty_truncates_large_string_fields() -> serde_json::Result<()>
```

**Purpose**: Verifies that huge action payloads, such as very large patches, are shortened before being shown to the Guardian. This keeps prompts within practical size limits.

**Data flow**: It builds an apply-patch request with a massive patch string, formats it, and checks that the output includes the tool name, a truncation marker, and is shorter than the original patch.

**Call relations**: The test runner calls it to exercise format_guardian_action_pretty.

*Call graph*: 3 external calls (new, assert!, test_path_buf).


##### `format_guardian_action_pretty_reports_no_truncation_for_small_payload`  (lines 898–912)

```
fn format_guardian_action_pretty_reports_no_truncation_for_small_payload() -> serde_json::Result<()>
```

**Purpose**: Checks that small action payloads are not falsely marked as truncated. This keeps metadata honest for normal requests.

**Data flow**: It builds a small apply-patch request, formats it, and verifies the tool name appears and the truncated flag is false.

**Call relations**: The test runner calls it as the small-input counterpart to the large-payload truncation test.

*Call graph*: 3 external calls (new, assert!, test_path_buf).


##### `guardian_approval_request_to_json_renders_mcp_tool_call_shape`  (lines 915–953)

```
fn guardian_approval_request_to_json_renders_mcp_tool_call_shape() -> serde_json::Result<()>
```

**Purpose**: Verifies the JSON shown to the Guardian for an MCP tool call. MCP means Model Context Protocol, a way to connect external tools to the assistant.

**Data flow**: It creates an MCP tool-call approval request with connector details and annotations, converts it to JSON, and compares it to the exact expected shape.

**Call relations**: The test runner calls it to protect guardian_approval_request_to_json formatting for MCP requests.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `guardian_approval_request_to_json_renders_network_access_trigger`  (lines 956–997)

```
fn guardian_approval_request_to_json_renders_network_access_trigger() -> serde_json::Result<()>
```

**Purpose**: Checks the JSON shape for a network-access approval request that was triggered by a shell command. The Guardian needs both the network target and why it was requested.

**Data flow**: It builds a network request with host, protocol, port, and trigger command details, converts it to JSON, and compares the result with the expected object.

**Call relations**: The test runner calls it to protect serialization of network approval evidence.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `build_guardian_prompt_items_explains_network_access_review_scope`  (lines 1000–1066)

```
async fn build_guardian_prompt_items_explains_network_access_review_scope() -> anyhow::Result<()>
```

**Purpose**: Verifies that network-access prompts explain the correct review scope. The Guardian should judge whether the triggering command is authorized, not require the user to name every connection explicitly.

**Data flow**: It creates a session, seeds history, builds a full prompt for a network access request with a trigger command, inspects the prompt text, and snapshot-checks the layout.

**Call relations**: It uses the standard setup helpers and then exercises build_guardian_prompt_items for network-access requests.

*Call graph*: calls 3 internal fn (guardian_prompt_text, guardian_test_session_and_turn_with_base_url, seed_guardian_parent_history); 4 external calls (assert!, test_path_buf, clone_current, vec!).


##### `guardian_assessment_action_redacts_apply_patch_patch_text`  (lines 1069–1088)

```
fn guardian_assessment_action_redacts_apply_patch_patch_text()
```

**Purpose**: Checks that analytics or assessment metadata for apply-patch requests does not include the patch text itself. This avoids storing potentially sensitive contents where only summary fields are needed.

**Data flow**: It creates an apply-patch request, converts it into an assessment action value, serializes it, and verifies that only type, working directory, and file paths remain.

**Call relations**: The test runner calls it to protect guardian_assessment_action redaction behavior.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `guardian_request_turn_id_prefers_network_access_owner_turn`  (lines 1091–1117)

```
fn guardian_request_turn_id_prefers_network_access_owner_turn()
```

**Purpose**: Verifies that network-access requests keep the turn id of the turn that owns the network request. Other request types use the caller-provided fallback turn id.

**Data flow**: It builds one network request and one patch request, asks for each request's turn id, and compares the answers with owner and fallback expectations.

**Call relations**: The test runner calls it to exercise guardian_request_turn_id.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `guardian_request_target_item_id_omits_network_access_trigger_call_id`  (lines 1120–1141)

```
fn guardian_request_target_item_id_omits_network_access_trigger_call_id()
```

**Purpose**: Checks that a network-access trigger's tool call id is not treated as the Guardian request's target item id. This prevents linking approval to the wrong item.

**Data flow**: It builds a network-access request with a trigger call id, asks for the target item id, and expects no id.

**Call relations**: The test runner calls it to protect guardian_request_target_item_id behavior.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `cancelled_guardian_review_emits_terminal_abort_without_warning`  (lines 1144–1186)

```
async fn cancelled_guardian_review_emits_terminal_abort_without_warning()
```

**Purpose**: Verifies that a review cancelled before it starts ends cleanly as an abort. Cancellation should not look like an error or policy warning.

**Data flow**: It creates a session with event receiver, cancels a token, runs review_approval_request_with_cancel, checks that the decision is Abort, then drains events and expects InProgress followed by Aborted with no warnings.

**Call relations**: The test runner calls it to exercise the cancellation path of Guardian approval review.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 6 external calls (new, new, assert!, assert_eq!, test_path_buf, vec!).


##### `guardian_timeout_message_distinguishes_timeout_from_policy_denial`  (lines 1189–1194)

```
fn guardian_timeout_message_distinguishes_timeout_from_policy_denial()
```

**Purpose**: Checks that timeout wording is clearly different from policy denial wording. Users should understand that the reviewer did not finish, not that the action was judged unsafe.

**Data flow**: It obtains the timeout message and asserts that it mentions the deadline and retry, while not mentioning unacceptable risk.

**Call relations**: The test runner calls it to protect user-facing timeout copy.

*Call graph*: 1 external calls (assert!).


##### `routes_approval_to_guardian_requires_guardian_reviewer`  (lines 1197–1209)

```
async fn routes_approval_to_guardian_requires_guardian_reviewer()
```

**Purpose**: Verifies that approvals only route to Guardian when the configured reviewer is automatic review, not ordinary user review. This prevents accidental Guardian use when the app is configured for manual approval.

**Data flow**: It creates a turn, sets the config reviewer to User and then AutoReview, and checks routing is false then true.

**Call relations**: The test runner calls it to exercise routes_approval_to_guardian.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (new, assert!).


##### `routes_approval_to_guardian_can_use_app_reviewer_override`  (lines 1212–1223)

```
async fn routes_approval_to_guardian_can_use_app_reviewer_override()
```

**Purpose**: Checks that a caller-supplied reviewer override can decide Guardian routing. This supports apps that choose the reviewer outside the stored turn config.

**Data flow**: It creates a turn and calls the override-aware routing function once with User and once with AutoReview, expecting false then true.

**Call relations**: The test runner calls it to exercise routes_approval_to_guardian_with_reviewer.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert!).


##### `routes_approval_to_guardian_allows_granular_review_policy`  (lines 1226–1242)

```
async fn routes_approval_to_guardian_allows_granular_review_policy()
```

**Purpose**: Verifies that Guardian routing still works when the approval policy is granular. Granular means separate approval switches for different categories of risky behavior.

**Data flow**: It creates a turn, enables AutoReview, sets a granular approval configuration with all categories enabled, and checks routing remains true.

**Call relations**: The test runner calls it to ensure the routing logic accepts the granular policy shape.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (new, Granular, assert!).


##### `build_guardian_transcript_reserves_separate_budget_for_tool_evidence`  (lines 1245–1283)

```
fn build_guardian_transcript_reserves_separate_budget_for_tool_evidence()
```

**Purpose**: Checks that transcript rendering does not let large tool evidence crowd out important user and assistant context. The Guardian needs both the human conversation and tool facts.

**Data flow**: It builds a small user/assistant history followed by many large tool entries, renders the transcript, and verifies early conversation evidence remains while some tool entries are omitted.

**Call relations**: The test runner calls it to exercise the transcript renderer's budgeting rules.

*Call graph*: 2 external calls (assert!, vec!).


##### `build_guardian_transcript_preserves_recent_tool_context_when_user_history_is_large`  (lines 1286–1331)

```
fn build_guardian_transcript_preserves_recent_tool_context_when_user_history_is_large()
```

**Purpose**: Verifies that recent tool context survives even when earlier user history is huge. This protects evidence about the immediate blocked action.

**Data flow**: It creates many large user entries followed by a shell tool call and result, renders the transcript, and checks that both recent tool entries remain and an omission notice is reported.

**Call relations**: The test runner calls it to protect the renderer's separate treatment of recent tool evidence.

*Call graph*: 4 external calls (assert!, assert_eq!, Tool, json!).


##### `parse_guardian_assessment_extracts_embedded_json`  (lines 1334–1349)

```
fn parse_guardian_assessment_extracts_embedded_json()
```

**Purpose**: Checks that Guardian assessment parsing can find JSON embedded inside extra text. This makes the parser tolerant of model responses with a short preface.

**Data flow**: It passes a string containing text plus a JSON object, parses it, and compares the resulting risk, authorization, outcome, and rationale fields.

**Call relations**: The test runner calls it to exercise parse_guardian_assessment.

*Call graph*: 1 external calls (assert_eq!).


##### `parse_guardian_assessment_treats_bare_allow_as_low_risk`  (lines 1352–1365)

```
fn parse_guardian_assessment_treats_bare_allow_as_low_risk()
```

**Purpose**: Verifies that a minimal allow response gets safe default details. The Guardian schema only requires outcome, so missing optional fields need sensible defaults.

**Data flow**: It parses JSON containing only `outcome: allow` and expects low risk, unknown user authorization, allow outcome, and a default rationale.

**Call relations**: The test runner calls it as one of the parser defaulting tests.

*Call graph*: 1 external calls (assert_eq!).


##### `parse_guardian_assessment_treats_bare_deny_as_high_risk`  (lines 1368–1381)

```
fn parse_guardian_assessment_treats_bare_deny_as_high_risk()
```

**Purpose**: Verifies that a minimal deny response is treated as high risk by default. Denials without explanation should still fail closed.

**Data flow**: It parses JSON containing only `outcome: deny` and expects high risk, unknown authorization, deny outcome, and a default denial rationale.

**Call relations**: The test runner calls it to protect parser defaults for denial responses.

*Call graph*: 1 external calls (assert_eq!).


##### `guardian_output_schema_requires_only_outcome_and_allows_optional_details`  (lines 1384–1412)

```
fn guardian_output_schema_requires_only_outcome_and_allows_optional_details()
```

**Purpose**: Checks the JSON schema requested from the Guardian model. The schema requires only the final outcome while allowing optional risk, authorization, and rationale fields.

**Data flow**: It builds the schema and compares it exactly with the expected JSON schema object.

**Call relations**: The test runner calls it to protect guardian_output_schema, which is also sent in model requests.

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

**Purpose**: Runs a small Guardian review and reports which model was requested. It is a helper for tests about model selection and analytics metadata.

**Data flow**: It starts a mock server that returns an allow assessment, creates a test session, optionally limits the model catalog, optionally sets an auto-review model override, runs one Guardian review, reads the captured request model, and returns it with parent/preferred model ids and analytics data.

**Call relations**: Three model-selection tests call this helper with different override and catalog setups.

*Call graph*: calls 6 internal fn (guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_once, sse, start_mock_server, new); called by 3 (guardian_review_records_missing_auto_review_model_in_analytics_metadata, guardian_review_uses_model_catalog_override_when_preferred_review_model_exists, guardian_review_uses_preferred_review_model_without_model_catalog_override); 7 external calls (clone, get_mut, new, test_path_buf, panic!, json!, vec!).


##### `guardian_review_uses_model_catalog_override_when_preferred_review_model_exists`  (lines 1507–1544)

```
async fn guardian_review_uses_model_catalog_override_when_preferred_review_model_exists() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicit auto-review model override wins when the catalog supports review models. This lets configuration choose a Guardian model intentionally.

**Data flow**: It asks the helper to run review with an override, then checks the request used the override, not the parent or preferred model, and that analytics recorded the override.

**Call relations**: The test runner calls it; it delegates the review setup to guardian_request_model_for_auto_review.

*Call graph*: calls 1 internal fn (guardian_request_model_for_auto_review); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `guardian_review_uses_preferred_review_model_without_model_catalog_override`  (lines 1547–1582)

```
async fn guardian_review_uses_preferred_review_model_without_model_catalog_override() -> anyhow::Result<()>
```

**Purpose**: Checks that Guardian uses the provider's preferred review model when no override is set. This avoids using the parent conversation model if a better review model is available.

**Data flow**: It runs the helper without an override and verifies the requested model equals the preferred review model, while analytics show no override.

**Call relations**: The test runner calls it; the helper performs the mocked Guardian request.

*Call graph*: calls 1 internal fn (guardian_request_model_for_auto_review); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `guardian_review_records_missing_auto_review_model_in_analytics_metadata`  (lines 1585–1620)

```
async fn guardian_review_records_missing_auto_review_model_in_analytics_metadata() -> anyhow::Result<()>
```

**Purpose**: Verifies the fallback and metadata when the model catalog lacks the preferred review model. The system should fall back to the parent model and record why.

**Data flow**: It runs the helper with a parent-only catalog, then checks the request used the parent model and analytics say the auto-review model was missing.

**Call relations**: The test runner calls it through guardian_request_model_for_auto_review.

*Call graph*: calls 1 internal fn (guardian_request_model_for_auto_review); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `guardian_review_request_layout_matches_model_visible_request_snapshot`  (lines 1623–1820)

```
async fn guardian_review_request_layout_matches_model_visible_request_snapshot() -> anyhow::Result<()>
```

**Purpose**: Checks the full model-visible Guardian request layout. It proves the Guardian sees the right policy, transcript, schema, model metadata, and does not get unwanted skill or memory content.

**Data flow**: It sets up a mock review response, creates a session with memory and a skill probe, seeds history, runs a Guardian review, inspects the captured request body and metadata, and snapshot-checks the formatted request.

**Call relations**: This large integration-style test uses many helpers and directly exercises run_guardian_review_session_for_test.

*Call graph*: calls 8 internal fn (fixed_guardian_parent_session_id, seed_guardian_parent_history, make_session_and_context, models_manager_with_provider, mount_sse_once, sse, start_mock_server, from_string); 17 external calls (clone, new, new, assert!, assert_eq!, assert_ne!, new, create_model_provider, test_path_buf, format! (+7 more)).


##### `build_guardian_prompt_items_includes_parent_session_id`  (lines 1823–1858)

```
async fn build_guardian_prompt_items_includes_parent_session_id() -> anyhow::Result<()>
```

**Purpose**: Verifies that Guardian prompts include the parent session id immediately after the transcript. This helps correlate the review with the session being judged.

**Data flow**: It creates a session, builds a full prompt for `git status`, concatenates prompt text, and checks that the parent session id appears in the expected place.

**Call relations**: The test runner calls it to exercise build_guardian_prompt_items.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert!, test_path_buf, vec!).


##### `guardian_reuses_prompt_cache_key_and_appends_prior_reviews`  (lines 1861–2154)

```
async fn guardian_reuses_prompt_cache_key_and_appends_prior_reviews() -> anyhow::Result<()>
```

**Purpose**: Checks that follow-up Guardian reviews reuse the same prompt cache key and include earlier review context. This lets a Guardian review session continue efficiently without treating prior decisions as binding law.

**Data flow**: It mocks three successful Guardian responses, runs three reviews with parent-history additions between them, checks metadata and shared thread id, inspects captured requests, and verifies only one follow-up reminder is persisted.

**Call relations**: It uses the standard mock-session helpers and exercises repeated run_guardian_review_session_for_test calls.

*Call graph*: calls 5 internal fn (guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_sequence, start_mock_server, from_string); 8 external calls (clone, assert!, assert_eq!, test_path_buf, panic!, clone_current, skip_if_no_network!, vec!).


##### `guardian_reused_trunk_ignores_stale_prior_turn_completion`  (lines 2157–2263)

```
async fn guardian_reused_trunk_ignores_stale_prior_turn_completion() -> anyhow::Result<()>
```

**Purpose**: Verifies that a reused Guardian trunk ignores a stale completion event from an earlier turn. This prevents an old answer from being mistaken for the current review result.

**Data flow**: It runs one review, injects a fake stale completion into the Guardian review session, runs a second review, and checks that the second real mocked response is used.

**Call relations**: The test runner calls it; it uses guardian_test_session_and_turn and mock SSE responses.

*Call graph*: calls 3 internal fn (guardian_test_session_and_turn, mount_sse_sequence, start_mock_server); 8 external calls (clone, assert!, assert_eq!, test_path_buf, panic!, TurnComplete, skip_if_no_network!, vec!).


##### `guardian_review_surfaces_responses_api_errors_in_rejection_reason`  (lines 2266–2374)

```
async fn guardian_review_surfaces_responses_api_errors_in_rejection_reason() -> anyhow::Result<()>
```

**Purpose**: Checks that model API errors are visible in Guardian warnings and denial rationale. Users should see the real failure reason instead of a vague missing-output message.

**Data flow**: It mocks a 400 API error, runs review_approval_request, collects emitted warnings and denied assessments, checks stored rejection rationale by review id, and verifies the user-facing rejection message includes the API error.

**Call relations**: The test runner calls it; it uses an event receiver to inspect review side effects.

*Call graph*: calls 5 internal fn (seed_guardian_parent_history, make_session_and_context_with_rx, models_manager_with_provider, mount_response_sequence, start_mock_server); 11 external calls (clone, get_mut, new, new, assert!, assert_eq!, create_model_provider, test_path_buf, format!, skip_if_no_network! (+1 more)).


##### `guardian_review_retries_transient_session_failure_then_approves`  (lines 2377–2430)

```
async fn guardian_review_retries_transient_session_failure_then_approves() -> anyhow::Result<()>
```

**Purpose**: Verifies that transient Guardian session failures are retried and can still approve. Temporary reviewer overload should not immediately deny the user's action.

**Data flow**: It mocks one failed SSE response followed by a valid allow response, runs a Guardian review with three allowed attempts, and checks the final assessment, attempt count, session kind, and request count.

**Call relations**: The test runner calls it; it uses guardian_shell_request and the mock session helper.

*Call graph*: calls 5 internal fn (guardian_shell_request, guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_sequence, start_mock_server); 7 external calls (clone, assert!, assert_eq!, panic!, json!, skip_if_no_network!, vec!).


##### `guardian_review_does_not_retry_missing_assessment_payload`  (lines 2433–2460)

```
async fn guardian_review_does_not_retry_missing_assessment_payload() -> anyhow::Result<()>
```

**Purpose**: Checks that a completed model response with no assessment is not retried. A missing payload is treated as a terminal review failure.

**Data flow**: It mocks a response-created and completed event with no assistant assessment, runs review_approval_request, and expects denial after one request.

**Call relations**: The test runner calls it through the standard Guardian test setup.

*Call graph*: calls 5 internal fn (guardian_shell_request, guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_sequence, start_mock_server); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `guardian_review_retries_two_parse_failures_then_approves`  (lines 2463–2521)

```
async fn guardian_review_retries_two_parse_failures_then_approves() -> anyhow::Result<()>
```

**Purpose**: Verifies that invalid Guardian JSON can be retried and eventually succeed. This gives the reviewer model a chance to correct formatting mistakes.

**Data flow**: It mocks two invalid text responses followed by a valid allow assessment, runs review with three attempts, and checks approval, rationale, attempt count, reused session kind, and request count.

**Call relations**: The test runner calls it; it combines mock SSE sequences with run_guardian_review_session_for_test.

*Call graph*: calls 5 internal fn (guardian_shell_request, guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_sequence, start_mock_server); 7 external calls (clone, assert!, assert_eq!, panic!, json!, skip_if_no_network!, vec!).


##### `guardian_review_exhausts_three_failures_with_one_terminal_event`  (lines 2524–2577)

```
async fn guardian_review_exhausts_three_failures_with_one_terminal_event() -> anyhow::Result<()>
```

**Purpose**: Checks that three bad Guardian responses produce one final denial event, not multiple noisy terminal events. This keeps client state simple.

**Data flow**: It mocks three invalid responses, runs review_approval_request, expects denial, then reads emitted GuardianAssessment statuses and checks they are only InProgress then Denied.

**Call relations**: The test runner calls it; it uses guardian_test_session_turn_and_rx to observe events.

*Call graph*: calls 5 internal fn (guardian_shell_request, guardian_test_session_turn_and_rx, seed_guardian_parent_history, mount_sse_sequence, start_mock_server); 4 external calls (new, assert_eq!, skip_if_no_network!, vec!).


##### `guardian_review_does_not_retry_valid_denial`  (lines 2580–2615)

```
async fn guardian_review_does_not_retry_valid_denial() -> anyhow::Result<()>
```

**Purpose**: Verifies that a clear Guardian denial is not retried. Retrying a valid deny could pressure the reviewer into approving unsafe work.

**Data flow**: It mocks one valid deny assessment, runs review_approval_request, and checks the decision is Denied after a single request.

**Call relations**: The test runner calls it through the standard mock Guardian setup.

*Call graph*: calls 5 internal fn (guardian_shell_request, guardian_test_session_and_turn, seed_guardian_parent_history, mount_sse_sequence, start_mock_server); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `guardian_ephemeral_retry_preserves_parallel_trunk_and_fork_history`  (lines 2618–2872)

```
async fn guardian_ephemeral_retry_preserves_parallel_trunk_and_fork_history() -> anyhow::Result<()>
```

**Purpose**: Tests a complex case where one Guardian review is in progress while another review forks and retries. It ensures the fork uses committed history, not half-finished trunk state.

**Data flow**: It starts a custom streaming mock server, runs an initial approval, starts a second review that blocks mid-stream, runs and retries a third parallel review, inspects request bodies and prompt cache keys, then unblocks the second review and checks both approve.

**Call relations**: The test runner calls it; internally it creates its own Tokio runtime on a larger stack to handle the long async scenario.

*Call graph*: 2 external calls (anyhow!, new).


##### `guardian_review_session_config_preserves_parent_network_proxy`  (lines 2874–2918)

```
async fn guardian_review_session_config_preserves_parent_network_proxy()
```

**Purpose**: Checks that Guardian review config preserves the parent's network proxy rules when no live override is supplied. The reviewer should obey the same network constraints while still being read-only.

**Data flow**: It builds a parent config with allowed network domains, builds Guardian config, and verifies network settings, active model, reasoning effort, no approval prompts, and read-only permissions.

**Call relations**: The test runner calls it to exercise build_guardian_review_session_config_for_test.

*Call graph*: calls 2 internal fn (from_config_and_constraints, test_config); 4 external calls (default, assert_eq!, default, from).


##### `guardian_review_session_config_clears_parent_developer_instructions`  (lines 2921–2939)

```
async fn guardian_review_session_config_clears_parent_developer_instructions()
```

**Purpose**: Verifies that parent developer instructions do not replace the Guardian policy. The Guardian needs its own review policy, not task-specific parent instructions.

**Data flow**: It sets parent developer instructions, builds Guardian config, and checks developer_instructions is cleared while base_instructions is the Guardian policy prompt.

**Call relations**: The test runner calls it to protect Guardian config isolation.

*Call graph*: calls 1 internal fn (test_config); 1 external calls (assert_eq!).


##### `guardian_review_session_config_clears_legacy_notify`  (lines 2942–2958)

```
async fn guardian_review_session_config_clears_legacy_notify()
```

**Purpose**: Checks that legacy notification commands are removed from Guardian config. A background review should not trigger parent turn notification hooks.

**Data flow**: It sets a parent notify command list, builds Guardian config, and verifies notify is None.

**Call relations**: The test runner calls it to exercise the config builder's cleanup behavior.

*Call graph*: calls 1 internal fn (test_config); 2 external calls (assert_eq!, vec!).


##### `guardian_review_session_config_uses_live_network_proxy_state`  (lines 2961–3002)

```
async fn guardian_review_session_config_uses_live_network_proxy_state()
```

**Purpose**: Verifies that live network proxy state overrides the parent config when building Guardian config. This keeps Guardian reviews aligned with current runtime network policy.

**Data flow**: It creates parent network settings and separate live network settings, builds Guardian config with the live state, and compares the result with a spec built from the live state and read-only permissions.

**Call relations**: The test runner calls it to protect network proxy selection in build_guardian_review_session_config_for_test.

*Call graph*: calls 2 internal fn (from_config_and_constraints, test_config); 3 external calls (assert_eq!, default, vec!).


##### `guardian_review_session_config_disables_mcp_apps_plugins_and_memories`  (lines 3005–3039)

```
async fn guardian_review_session_config_disables_mcp_apps_plugins_and_memories()
```

**Purpose**: Checks that Guardian review sessions disable extension-like features from the parent session. This prevents outside tools, apps, plugins, and memory context from influencing the safety review.

**Data flow**: It enables MCP servers, apps, plugins, app instructions, and memories in the parent config, builds Guardian config, and verifies those features are absent or disabled.

**Call relations**: The test runner calls it to protect the Guardian session sandbox.

*Call graph*: calls 1 internal fn (test_config); 3 external calls (from, assert!, from_str).


##### `guardian_review_session_config_allows_pinned_disabled_feature`  (lines 3042–3066)

```
async fn guardian_review_session_config_allows_pinned_disabled_feature()
```

**Purpose**: Verifies that the Guardian config builder tolerates a workspace-pinned feature even if the Guardian disables related capabilities. This avoids failing config construction unnecessarily.

**Data flow**: It creates managed feature requirements that pin a feature, builds Guardian config, and checks the expected managed feature state while MCP and app instructions remain disabled.

**Call relations**: The test runner calls it to cover a compatibility edge case in Guardian config building.

*Call graph*: calls 2 internal fn (from_configured, test_config); 2 external calls (from, assert!).


##### `guardian_review_session_config_uses_parent_active_model_instead_of_hardcoded_slug`  (lines 3069–3082)

```
async fn guardian_review_session_config_uses_parent_active_model_instead_of_hardcoded_slug()
```

**Purpose**: Checks that Guardian config uses the active model passed by the parent turn, not a stale configured model name. This matters when model selection is resolved at runtime.

**Data flow**: It sets a configured parent model, builds Guardian config with `active-model`, and verifies the Guardian model is `active-model`.

**Call relations**: The test runner calls it to protect model selection in the Guardian config builder.

*Call graph*: calls 1 internal fn (test_config); 1 external calls (assert_eq!).


##### `guardian_review_session_config_keeps_bedrock_provider_for_bedrock_gpt_5_4`  (lines 3085–3115)

```
async fn guardian_review_session_config_keeps_bedrock_provider_for_bedrock_gpt_5_4()
```

**Purpose**: Verifies that Amazon Bedrock GPT-5.4 reviews keep the Bedrock provider instead of being forced to another provider. It also checks retry limits are tightened for Guardian review.

**Data flow**: It creates a parent config using the Bedrock provider, builds Guardian config for the Bedrock model with low reasoning effort, and compares model, provider id, and provider settings with the expected Bedrock provider.

**Call relations**: The test runner calls it to protect provider-specific Guardian config behavior.

*Call graph*: calls 2 internal fn (test_config, create_amazon_bedrock_provider); 1 external calls (assert_eq!).


##### `guardian_review_session_config_uses_requirements_guardian_policy_config`  (lines 3118–3160)

```
async fn guardian_review_session_config_uses_requirements_guardian_policy_config()
```

**Purpose**: Checks that workspace requirements can add Guardian policy configuration. This lets managed workspaces tailor the Guardian policy without replacing its core prompt.

**Data flow**: It creates temporary config roots with a requirements layer containing guardian_policy_config, loads parent config, builds Guardian config, and verifies base_instructions include the trimmed managed policy text.

**Call relations**: The test runner calls it through Config::load_config_with_layer_stack and the Guardian config builder.

*Call graph*: calls 1 internal fn (new); 6 external calls (default, new, load_config_with_layer_stack, assert_eq!, default, tempdir).


##### `guardian_review_session_config_uses_default_guardian_policy_without_requirements_override`  (lines 3163–3196)

```
async fn guardian_review_session_config_uses_default_guardian_policy_without_requirements_override()
```

**Purpose**: Verifies that the default Guardian policy is used when no requirements override is present. This keeps normal workspaces on the built-in safety policy.

**Data flow**: It loads a parent config with no guardian policy requirements, builds Guardian config, and checks base_instructions equal the default Guardian policy prompt.

**Call relations**: The test runner calls it as the default-policy counterpart to the requirements override test.

*Call graph*: calls 1 internal fn (new); 6 external calls (default, new, load_config_with_layer_stack, assert_eq!, default, tempdir).


### `core/src/exec_policy_tests.rs`

`test` · `test run`

Codex can run shell commands, so it needs clear rules about what is safe. This test file exercises those rules from many angles: loading `.rules` files from the right configuration folders, ignoring rules from untrusted projects, combining rules supplied by system requirements, and deciding whether a particular command needs approval. Think of it like testing the guards at several doors: one guard checks where the rule came from, another checks what the command does, and another checks whether the current sandbox is strong enough.

The tests create temporary folders, write small policy files, build test configurations, and then ask the execution policy code what it would do. They cover simple commands like `rm`, shell-wrapped commands like `bash -lc 'rm -rf ...'`, heredoc scripts, absolute program paths, PowerShell commands, network rules, and user-requested policy amendments. They also check that malformed policy files produce useful error messages.

Without these tests, small changes could accidentally let project rules load before trust is granted, allow dangerous commands without approval, reject safe commands unnecessarily, or propose bad rules that make future approvals too broad.

#### Function details

##### `config_stack_for_dot_codex_folder`  (lines 42–55)

```
fn config_stack_for_dot_codex_folder(dot_codex_folder: &Path) -> ConfigLayerStack
```

**Purpose**: Builds a minimal configuration-layer stack that points at a temporary project `.codex` folder. Tests use it when they only care about policy files in one project-like directory.

**Data flow**: It receives a filesystem path, turns it into an absolute path object, wraps it as a project configuration layer with an empty TOML table, and returns a `ConfigLayerStack` with default requirements.

**Call relations**: Several policy-loading tests call this helper before asking the real loader to read rules. It keeps those tests focused on the policy behavior instead of repeating configuration setup.

*Call graph*: calls 3 internal fn (new, new, from_absolute_path); called by 6 (format_exec_policy_error_with_source_renders_range, ignores_policies_outside_policy_dir, ignores_policy_files_when_config_stack_disables_exec_policy_rules, loads_policies_from_policy_subdirectory, returns_empty_policy_when_no_policy_files_exist, rules_path_file_returns_read_dir_error); 5 external calls (default, Table, default, default, vec!).


##### `host_absolute_path`  (lines 57–67)

```
fn host_absolute_path(segments: &[&str]) -> String
```

**Purpose**: Creates a platform-appropriate absolute path string from path pieces. It lets tests build fake host paths that work on both Windows and Unix-like systems.

**Data flow**: It receives path segments, starts from `C:\` on Windows or `/` elsewhere, appends each segment, and returns the path as a string.

**Call relations**: Path-related tests use it directly, and `host_program_path` builds on it when creating executable paths such as `/usr/bin/git`.

*Call graph*: called by 3 (absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths, host_program_path, preserves_host_executables_when_requirements_overlay_is_present); 2 external calls (from, cfg!).


##### `host_program_path`  (lines 69–76)

```
fn host_program_path(name: &str) -> String
```

**Purpose**: Creates a full path to a pretend program in `/usr/bin`, adding `.exe` on Windows. Tests use it to check rules that recognize approved host executables.

**Data flow**: It receives a program name, adjusts the name for Windows if needed, passes the pieces to `host_absolute_path`, and returns the final string.

**Call relations**: Absolute-path approval tests call this helper before writing policy source or building the command under test.

*Call graph*: calls 1 internal fn (host_absolute_path); called by 2 (absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths, absolute_path_exec_approval_requirement_matches_host_executable_rules); 2 external calls (cfg!, format!).


##### `starlark_string`  (lines 78–80)

```
fn starlark_string(value: &str) -> String
```

**Purpose**: Escapes a Rust string so it can be safely inserted into a Starlark policy file string. Starlark is the small scripting language used for `.rules` files.

**Data flow**: It receives text, doubles backslashes and escapes quotation marks, then returns the escaped text.

**Call relations**: Tests that generate policy source with host paths call this before embedding paths inside quoted Starlark strings.

*Call graph*: called by 3 (absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths, absolute_path_exec_approval_requirement_matches_host_executable_rules, preserves_host_executables_when_requirements_overlay_is_present).


##### `write_project_trust_config`  (lines 82–107)

```
async fn write_project_trust_config(
    codex_home: &Path,
    trusted_projects: &[(&Path, TrustLevel)],
) -> std::io::Result<()>
```

**Purpose**: Writes a temporary Codex config file that says which projects are trusted or untrusted. This lets tests prove that project policy files only count after trust is granted.

**Data flow**: It receives a Codex home directory and project trust entries, converts them into TOML config text, writes that text to `config.toml`, and returns the file-write result.

**Call relations**: Project-trust tests call it before building a `Config`, so the real config loader sees the intended trust state.

*Call graph*: called by 3 (exec_policies_only_load_from_trusted_project_layers, exec_policies_require_project_trust_without_config_toml, exec_policy_warnings_ignore_untrusted_project_rules_without_config_toml); 5 external calls (default, iter, join, write, to_string).


##### `test_config`  (lines 109–117)

```
async fn test_config() -> (TempDir, Config)
```

**Purpose**: Creates a default test configuration in a temporary Codex home directory. It is a shared setup helper for tests that compare parent and child execution policies.

**Data flow**: It creates a temp directory, builds a test `Config` that uses that directory as Codex home, and returns both the directory handle and config.

**Call relations**: The child-policy reuse tests call this first, then modify or clone the returned config to see whether reuse should be allowed.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); called by 4 (child_does_not_use_parent_exec_policy_when_ignore_rules_differs, child_does_not_use_parent_exec_policy_when_requirements_exec_policy_differs, child_uses_parent_exec_policy_when_layer_stack_matches, child_uses_parent_exec_policy_when_non_exec_policy_layers_differ); 1 external calls (new).


##### `child_uses_parent_exec_policy_when_layer_stack_matches`  (lines 120–125)

```
async fn child_uses_parent_exec_policy_when_layer_stack_matches()
```

**Purpose**: Checks that a child session can reuse the parent's execution policy when the configuration stack is unchanged.

**Data flow**: It builds one test config, clones it as the child config, asks the reuse check, and expects `true`.

**Call relations**: This is a direct test of `child_uses_parent_exec_policy`; it uses `test_config` for setup and does not hand off to other helpers.

*Call graph*: calls 1 internal fn (test_config); 1 external calls (assert!).


##### `child_uses_parent_exec_policy_when_non_exec_policy_layers_differ`  (lines 128–152)

```
async fn child_uses_parent_exec_policy_when_non_exec_policy_layers_differ()
```

**Purpose**: Checks that harmless configuration differences do not force a child session to reload execution policy. Only layers that affect execution policy should matter.

**Data flow**: It builds a parent config, adds an empty session-flags layer to the child config, rebuilds the stack, and expects policy reuse to still be allowed.

**Call relations**: It uses `test_config` for setup and then exercises the same reuse decision as the matching-stack test.

*Call graph*: calls 3 internal fn (new, new, test_config); 3 external calls (default, Table, assert!).


##### `child_does_not_use_parent_exec_policy_when_ignore_rules_differs`  (lines 155–168)

```
async fn child_does_not_use_parent_exec_policy_when_ignore_rules_differs()
```

**Purpose**: Checks that a child session cannot reuse the parent's execution policy when one config ignores user/project rules and the other does not.

**Data flow**: It builds a parent config, changes the child stack to ignore user and project policy rules, and expects reuse to be rejected.

**Call relations**: It uses `test_config` and then calls the policy reuse check to make sure rule-source changes invalidate reuse.

*Call graph*: calls 1 internal fn (test_config); 1 external calls (assert!).


##### `child_does_not_use_parent_exec_policy_when_requirements_exec_policy_differs`  (lines 171–209)

```
async fn child_does_not_use_parent_exec_policy_when_requirements_exec_policy_differs()
```

**Purpose**: Checks that required execution-policy rules are part of the reuse decision. If a child has different required rules, it must not borrow the parent's policy.

**Data flow**: It builds a config, creates a required policy that forbids `rm`, installs that requirement into the child stack, and expects reuse to be rejected.

**Call relations**: It uses `test_config`, builds a custom `Policy`, and then verifies `child_uses_parent_exec_policy` returns `false`.

*Call graph*: calls 4 internal fn (new, new, new, test_config); 3 external calls (default, assert!, empty).


##### `returns_empty_policy_when_no_policy_files_exist`  (lines 212–233)

```
async fn returns_empty_policy_when_no_policy_files_exist()
```

**Purpose**: Confirms that missing policy files are normal and produce an empty policy, not an error or a new directory.

**Data flow**: It creates a temp project stack with no rules directory, loads the manager, checks that `rm` falls through to the fallback allow decision, and verifies no rules directory was created.

**Call relations**: It relies on `config_stack_for_dot_codex_folder` and then calls the real `ExecPolicyManager::load` path.

*Call graph*: calls 2 internal fn (load, config_stack_for_dot_codex_folder); 4 external calls (assert!, assert_eq!, tempdir, vec!).


##### `rules_path_file_returns_read_dir_error`  (lines 236–253)

```
async fn rules_path_file_returns_read_dir_error()
```

**Purpose**: Checks the error case where the expected rules directory is actually a file. The loader should report that it could not read the directory.

**Data flow**: It writes a file at the rules-directory path, loads policy, captures the error, and checks that the error names that path.

**Call relations**: It sets up the config with `config_stack_for_dot_codex_folder` and then exercises `load_exec_policy` error handling.

*Call graph*: calls 1 internal fn (config_stack_for_dot_codex_folder); 3 external calls (assert!, write, tempdir).


##### `collect_policy_files_returns_empty_when_dir_missing`  (lines 256–265)

```
async fn collect_policy_files_returns_empty_when_dir_missing()
```

**Purpose**: Confirms that asking for policy files in a missing directory simply returns an empty list.

**Data flow**: It points `collect_policy_files` at a non-existent rules directory and checks that the returned file list is empty.

**Call relations**: This isolates the file-collection helper from the rest of the policy loader.

*Call graph*: 2 external calls (assert!, tempdir).


##### `format_exec_policy_error_with_source_renders_range`  (lines 268–291)

```
async fn format_exec_policy_error_with_source_renders_range()
```

**Purpose**: Checks that parse errors are displayed with useful source-location text. This helps users find broken lines in `.rules` files.

**Data flow**: It writes an invalid rules file, loads policy to get a parse error, formats the error, and checks that the output includes the file name and nearby line.

**Call relations**: It uses `config_stack_for_dot_codex_folder`, then exercises the loader and formatter together.

*Call graph*: calls 1 internal fn (config_stack_for_dot_codex_folder); 4 external calls (assert!, create_dir_all, write, tempdir).


##### `parse_starlark_line_from_message_extracts_path_and_line`  (lines 294–302)

```
fn parse_starlark_line_from_message_extracts_path_and_line()
```

**Purpose**: Checks that a Starlark error message can be parsed into a file path and line number.

**Data flow**: It passes a sample error string into the parser and expects the returned path and line number to match.

**Call relations**: This tests the small parsing helper used by error formatting.

*Call graph*: 1 external calls (assert_eq!).


##### `parse_starlark_line_from_message_rejects_zero_line`  (lines 305–310)

```
fn parse_starlark_line_from_message_rejects_zero_line()
```

**Purpose**: Checks that line number zero is treated as invalid. Real editor-friendly line numbers start at one.

**Data flow**: It passes an error message containing line `0` and expects no parsed result.

**Call relations**: This complements the successful parse test for the same helper.

*Call graph*: 1 external calls (assert_eq!).


##### `loads_policies_from_policy_subdirectory`  (lines 313–340)

```
async fn loads_policies_from_policy_subdirectory()
```

**Purpose**: Confirms that `.rules` files inside the expected rules subdirectory are loaded and enforced.

**Data flow**: It writes a rule forbidding `rm`, loads the policy, checks `rm`, and expects a forbidden decision with the matching prefix rule recorded.

**Call relations**: It uses the standard temporary config helper and then verifies the main policy-loading path.

*Call graph*: calls 1 internal fn (config_stack_for_dot_codex_folder); 5 external calls (assert_eq!, create_dir_all, write, tempdir, vec!).


##### `merges_requirements_exec_policy_network_rules`  (lines 343–375)

```
async fn merges_requirements_exec_policy_network_rules() -> anyhow::Result<()>
```

**Purpose**: Checks that execution-policy rules supplied by configuration requirements are merged into the loaded policy. Here the required rule blocks a network domain.

**Data flow**: It creates a required policy denying `blocked.example.com`, builds a config stack with that requirement, loads policy, and checks the compiled denied-domain list.

**Call relations**: This tests the overlay between config requirements and normal policy loading.

*Call graph*: calls 5 internal fn (new, new, new, new, from_absolute_path); 9 external calls (default, Table, default, assert!, assert_eq!, default, empty, tempdir, vec!).


##### `preserves_host_executables_when_requirements_overlay_is_present`  (lines 378–427)

```
async fn preserves_host_executables_when_requirements_overlay_is_present() -> anyhow::Result<()>
```

**Purpose**: Checks that adding required policy rules does not erase host-executable declarations loaded from files.

**Data flow**: It writes a policy file declaring `git` at a host path, adds an unrelated required network rule, loads policy, and confirms the `git` declaration is still present.

**Call relations**: It uses `host_absolute_path` and `starlark_string` to generate valid policy source, then tests the combined loader.

*Call graph*: calls 7 internal fn (new, new, new, new, host_absolute_path, starlark_string, from_absolute_path); 11 external calls (default, Table, default, assert_eq!, default, empty, format!, create_dir_all, write, tempdir (+1 more)).


##### `ignores_policies_outside_policy_dir`  (lines 430–453)

```
async fn ignores_policies_outside_policy_dir()
```

**Purpose**: Confirms that policy files placed outside the official rules directory are ignored.

**Data flow**: It writes `root.rules` beside the rules directory rather than inside it, loads policy, and checks that `ls` falls through to the fallback allow decision.

**Call relations**: It uses `config_stack_for_dot_codex_folder` and tests that the loader only scans the intended subdirectory.

*Call graph*: calls 1 internal fn (config_stack_for_dot_codex_folder); 4 external calls (assert_eq!, write, tempdir, vec!).


##### `ignores_policy_files_when_config_stack_disables_exec_policy_rules`  (lines 456–480)

```
async fn ignores_policy_files_when_config_stack_disables_exec_policy_rules()
```

**Purpose**: Checks that user/project policy files are ignored when the config stack says to ignore them.

**Data flow**: It writes an allow rule for `curl`, marks the stack to ignore user and project rules, loads policy, and verifies `curl` still follows the fallback forbidden decision.

**Call relations**: It builds on the standard config-stack helper and checks the loader's rule-source filter.

*Call graph*: calls 1 internal fn (config_stack_for_dot_codex_folder); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `ignore_user_project_rules_keeps_system_policy_files`  (lines 483–520)

```
async fn ignore_user_project_rules_keeps_system_policy_files()
```

**Purpose**: Confirms that ignoring user and project rules does not disable system policy rules. System rules are higher-trust guardrails.

**Data flow**: It writes a system-layer rule allowing `curl`, marks user/project rules ignored, loads policy, and expects `curl` to be allowed.

**Call relations**: This complements the previous ignore test by proving the filter is selective rather than global.

*Call graph*: calls 3 internal fn (new, new, from_absolute_path); 9 external calls (default, Table, default, assert_eq!, default, create_dir_all, write, tempdir, vec!).


##### `ignores_rules_from_untrusted_project_layers`  (lines 523–559)

```
async fn ignores_rules_from_untrusted_project_layers() -> anyhow::Result<()>
```

**Purpose**: Checks that disabled project layers, such as untrusted projects, do not contribute execution rules.

**Data flow**: It writes a project rule forbidding `ls`, creates a disabled project config layer, loads policy, and verifies `ls` is still allowed by fallback.

**Call relations**: This tests the trust boundary in the policy loader.

*Call graph*: calls 2 internal fn (new, from_absolute_path); 7 external calls (default, assert_eq!, default, create_dir_all, write, tempdir, vec!).


##### `loads_policies_from_multiple_config_layers`  (lines 562–631)

```
async fn loads_policies_from_multiple_config_layers() -> anyhow::Result<()>
```

**Purpose**: Confirms that policy files can be loaded from more than one trusted configuration layer.

**Data flow**: It writes one user rule forbidding `rm` and one project rule prompting for `ls`, builds a stack with both layers, loads policy, and checks both commands.

**Call relations**: This exercises the loader's multi-layer merge behavior.

*Call graph*: calls 2 internal fn (new, from_absolute_path); 7 external calls (default, assert_eq!, default, create_dir_all, write, tempdir, vec!).


##### `evaluates_bash_lc_inner_commands`  (lines 634–653)

```
async fn evaluates_bash_lc_inner_commands()
```

**Purpose**: Checks that shell-wrapped commands are inspected inside the shell string. A forbidden `rm` should still be caught inside `bash -lc`.

**Data flow**: It builds a scenario with a rule forbidding `rm`, sends `bash -lc 'rm -rf ...'`, and expects a forbidden approval requirement explaining the match.

**Call relations**: It uses `assert_exec_approval_requirement_for_command`, which builds the policy and calls the manager.

*Call graph*: calls 1 internal fn (assert_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `commands_for_exec_policy_falls_back_for_empty_shell_script`  (lines 656–667)

```
fn commands_for_exec_policy_falls_back_for_empty_shell_script()
```

**Purpose**: Checks that an empty shell script is not treated as a parsed inner command.

**Data flow**: It passes `bash -lc ''` into command extraction and expects the original command back with complex parsing marked unused.

**Call relations**: This directly tests `commands_for_exec_policy`, separate from approval decisions.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `commands_for_exec_policy_falls_back_for_whitespace_shell_script`  (lines 670–685)

```
fn commands_for_exec_policy_falls_back_for_whitespace_shell_script()
```

**Purpose**: Checks that a shell script containing only whitespace falls back to the original command.

**Data flow**: It passes a whitespace-only `bash -lc` command into extraction and expects the original command with no complex parsing.

**Call relations**: This is the whitespace companion to the empty-script extraction test.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `ignore_user_config_keeps_user_policy_files`  (lines 688–724)

```
async fn ignore_user_config_keeps_user_policy_files() -> std::io::Result<()>
```

**Purpose**: Confirms that ignoring the user's config TOML does not ignore the user's policy files. Policy files remain a separate source.

**Data flow**: It writes an invalid user config and a valid user rule forbidding `curl`, builds config with `ignore_user_config`, loads policy, and verifies `curl` is forbidden.

**Call relations**: This tests interaction between config loading overrides and execution-policy loading.

*Call graph*: 6 external calls (default, assert_eq!, default, create_dir_all, write, tempdir).


##### `evaluates_heredoc_script_against_prefix_rules`  (lines 727–749)

```
async fn evaluates_heredoc_script_against_prefix_rules()
```

**Purpose**: Checks that a heredoc script can still be reduced to its real command when safe to do so. A heredoc is a shell feature that feeds inline text to a command.

**Data flow**: It sends a `python3 <<'PY' ...` shell command with a policy allowing `python3` and expects the command to skip approval and bypass the sandbox.

**Call relations**: It uses the shared approval assertion helper to test the full approval path.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `omits_auto_amendment_for_heredoc_fallback_prompts`  (lines 752–772)

```
async fn omits_auto_amendment_for_heredoc_fallback_prompts()
```

**Purpose**: Checks that the system does not suggest an automatic allow-rule when heredoc parsing falls back in a way that may be too broad.

**Data flow**: It sends a heredoc command without policy under an approval mode that prompts and expects approval needed with no proposed amendment.

**Call relations**: This protects the amendment-suggestion logic used by the approval manager.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `drops_requested_amendment_for_heredoc_fallback_prompts_when_it_wont_match`  (lines 775–799)

```
async fn drops_requested_amendment_for_heredoc_fallback_prompts_when_it_wont_match()
```

**Purpose**: Checks that a user-requested prefix rule is dropped when it would not match the heredoc command being approved.

**Data flow**: It sends a heredoc command, supplies a requested `python3 -m pip` prefix, and expects approval needed with no amendment.

**Call relations**: It uses the shared approval helper and focuses on requested-rule validation.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `drops_requested_amendment_for_heredoc_fallback_prompts_when_it_matches`  (lines 802–822)

```
async fn drops_requested_amendment_for_heredoc_fallback_prompts_when_it_matches()
```

**Purpose**: Checks that even a matching requested prefix is not suggested for heredoc fallback prompts when it would be unsafe or misleading.

**Data flow**: It sends a heredoc command with requested prefix `python3` and expects approval needed with no proposed amendment.

**Call relations**: This is the matching-prefix companion to the previous heredoc amendment test.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `heredoc_with_variable_assignment_is_not_reduced_to_allowed_prefix`  (lines 826–850)

```
async fn heredoc_with_variable_assignment_is_not_reduced_to_allowed_prefix()
```

**Purpose**: Checks that a heredoc preceded by environment changes is not simplified to just the allowed command. Environment changes like `PATH=...` can change what actually runs.

**Data flow**: It sends a shell command that changes `PATH` before `cat`, with a policy allowing `cat`, and expects no sandbox bypass plus a broader amendment suggestion.

**Call relations**: This Unix-only test uses the shared approval helper to guard against unsafe command simplification.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `heredoc_redirect_without_escalation_runs_inside_sandbox`  (lines 853–883)

```
async fn heredoc_redirect_without_escalation_runs_inside_sandbox()
```

**Purpose**: Checks that a heredoc writing to a file can run inside the sandbox when it does not request escalated permissions.

**Data flow**: It sends a `zsh -lc` heredoc with output redirection under workspace-write permissions and expects approval to be skipped without bypassing the sandbox.

**Call relations**: It tests approval behavior for shell redirection through the shared helper.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, workspace_write); 2 external calls (new, vec!).


##### `heredoc_redirect_with_escalation_requires_approval`  (lines 886–916)

```
async fn heredoc_redirect_with_escalation_requires_approval()
```

**Purpose**: Checks that the same kind of heredoc write needs approval when escalated sandbox permissions are requested.

**Data flow**: It sends a heredoc redirection command with a policy allowing `cat` but sandbox escalation required, and expects a needs-approval result.

**Call relations**: This pairs with the non-escalated heredoc redirect test to prove sandbox requests matter.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, workspace_write); 2 external calls (new, vec!).


##### `justification_is_included_in_forbidden_exec_approval_requirement`  (lines 919–947)

```
async fn justification_is_included_in_forbidden_exec_approval_requirement()
```

**Purpose**: Checks that a policy rule's human explanation is shown when a command is forbidden.

**Data flow**: It creates a forbidden `rm` rule with justification `destructive command`, evaluates an `rm -rf` command, and expects the reason text to include that justification.

**Call relations**: It uses the shared approval assertion path and checks user-facing error wording.

*Call graph*: calls 1 internal fn (assert_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `exec_approval_requirement_prefers_execpolicy_match`  (lines 950–966)

```
async fn exec_approval_requirement_prefers_execpolicy_match()
```

**Purpose**: Checks that an explicit execution-policy rule takes priority over general approval heuristics.

**Data flow**: It creates a prompt rule for `rm`, evaluates `rm`, and expects approval because the policy says so.

**Call relations**: It verifies the manager respects policy matches before fallback logic.

*Call graph*: calls 1 internal fn (assert_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `absolute_path_exec_approval_requirement_matches_host_executable_rules`  (lines 969–993)

```
async fn absolute_path_exec_approval_requirement_matches_host_executable_rules()
```

**Purpose**: Checks that a command using an absolute executable path can match a named host executable rule.

**Data flow**: It declares a host executable named `git`, adds an allow rule for `git`, runs the absolute path to `git status`, and expects approval to be skipped with sandbox bypass.

**Call relations**: It uses `host_program_path`, `starlark_string`, and the shared approval helper.

*Call graph*: calls 4 internal fn (assert_exec_approval_requirement_for_command, host_program_path, starlark_string, read_only); 2 external calls (format!, vec!).


##### `absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths`  (lines 996–1029)

```
async fn absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths()
```

**Purpose**: Checks that only declared host executable paths are trusted. A different absolute path to `git` should not match the approved host executable.

**Data flow**: It declares one allowed `git` path, runs a different `git` path, and expects normal sandboxed handling with an amendment for the actual absolute command.

**Call relations**: It uses the path helpers to create allowed and disallowed paths, then checks the manager through the shared helper.

*Call graph*: calls 5 internal fn (assert_exec_approval_requirement_for_command, host_absolute_path, host_program_path, starlark_string, read_only); 4 external calls (new, cfg!, format!, vec!).


##### `requested_prefix_rule_can_approve_absolute_path_commands`  (lines 1032–1055)

```
async fn requested_prefix_rule_can_approve_absolute_path_commands()
```

**Purpose**: Checks that a user-requested prefix rule such as `cargo install` can be proposed even when the actual command uses an absolute path to `cargo`.

**Data flow**: It runs an absolute `cargo install ...` command with a requested `cargo install` prefix and expects an approval prompt containing that amendment.

**Call relations**: It tests requested-rule normalization through the shared approval helper.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `exec_approval_requirement_respects_approval_policy`  (lines 1058–1073)

```
async fn exec_approval_requirement_respects_approval_policy()
```

**Purpose**: Checks that if approval is disabled, a command that would normally prompt becomes forbidden.

**Data flow**: It creates a prompt rule for `rm`, sets approval mode to never ask, and expects a forbidden result with the prompt-conflict reason.

**Call relations**: This verifies how policy decisions combine with the global approval setting.

*Call graph*: calls 1 internal fn (assert_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `unmatched_granular_policy_still_prompts_for_restricted_sandbox_escalation`  (lines 1076–1099)

```
fn unmatched_granular_policy_still_prompts_for_restricted_sandbox_escalation()
```

**Purpose**: Checks that sandbox escalation can still cause a prompt even when no command rule matches under granular approval settings.

**Data flow**: It evaluates an unknown command with sandbox escalation requested and expects a prompt decision.

**Call relations**: This directly tests `render_decision_for_unmatched_command`, the fallback decision maker.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `unmatched_on_request_uses_permission_profile_file_system_policy_for_escalation_prompts`  (lines 1102–1119)

```
fn unmatched_on_request_uses_permission_profile_file_system_policy_for_escalation_prompts()
```

**Purpose**: Checks that `on request` approval mode prompts for escalation when the permission profile has file-system restrictions.

**Data flow**: It evaluates an unknown command under read-only permissions with escalation required and expects a prompt decision.

**Call relations**: It exercises fallback decision logic without building a full manager.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `known_safe_on_request_still_prompts_for_restricted_sandbox_escalation`  (lines 1122–1139)

```
fn known_safe_on_request_still_prompts_for_restricted_sandbox_escalation()
```

**Purpose**: Checks that even a safe-looking command like `echo` must prompt when it asks to escape a restricted Windows-style sandbox.

**Data flow**: It evaluates `echo hello` with workspace-write permissions, restricted-token sandbox level, and escalation required, then expects prompt.

**Call relations**: It tests fallback decision behavior for sandbox escalation.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `managed_cwd_write_profile_has_filesystem_restrictions`  (lines 1142–1165)

```
fn managed_cwd_write_profile_has_filesystem_restrictions()
```

**Purpose**: Checks that a permission profile allowing writes only to project roots is considered filesystem-restricted.

**Data flow**: It builds a restricted file-system policy with root read access and project-root write access, converts it to a permission profile, and expects the restriction detector to return true.

**Call relations**: This directly tests `profile_has_managed_filesystem_restrictions`.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 2 external calls (assert!, vec!).


##### `managed_unresolvable_write_profile_has_filesystem_restrictions`  (lines 1168–1194)

```
fn managed_unresolvable_write_profile_has_filesystem_restrictions()
```

**Purpose**: Checks that writing to a future or unknown special path is treated as restricted rather than full disk access.

**Data flow**: It builds a policy with root read access and unknown-special-path write access, converts it to a permission profile, and expects restrictions to be detected.

**Call relations**: This guards the restriction detector against assuming unknown paths are unrestricted.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 2 external calls (assert!, vec!).


##### `managed_full_disk_write_profile_has_no_filesystem_restrictions`  (lines 1197–1213)

```
fn managed_full_disk_write_profile_has_no_filesystem_restrictions()
```

**Purpose**: Checks that a profile with write access to the filesystem root is not considered restricted.

**Data flow**: It builds a policy granting root write access, converts it to a permission profile, and expects the restriction detector to return false.

**Call relations**: This is the full-access counterpart to the restricted-profile tests.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 2 external calls (assert!, vec!).


##### `exec_approval_requirement_prompts_for_inline_additional_permissions_under_on_request`  (lines 1216–1239)

```
async fn exec_approval_requirement_prompts_for_inline_additional_permissions_under_on_request()
```

**Purpose**: Checks that inline additional permissions trigger approval under `on request` mode.

**Data flow**: It runs a shell `touch` command with additional permissions requested and expects an approval prompt with an amendment for the inner `touch` command.

**Call relations**: It uses the shared approval helper to test permission-request behavior.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `exec_approval_requirement_prompts_for_known_safe_escalation_under_on_request`  (lines 1242–1261)

```
async fn exec_approval_requirement_prompts_for_known_safe_escalation_under_on_request()
```

**Purpose**: Checks that even a known-safe command prompts when it requests sandbox escalation under `on request` mode.

**Data flow**: It evaluates `echo hello` with workspace-write permissions and required escalation, expecting approval needed with an amendment.

**Call relations**: This uses the shared helper and focuses on sandbox escalation.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, workspace_write); 2 external calls (new, vec!).


##### `exec_approval_requirement_rejects_known_safe_escalation_when_granular_sandbox_is_disabled`  (lines 1264–1286)

```
async fn exec_approval_requirement_rejects_known_safe_escalation_when_granular_sandbox_is_disabled()
```

**Purpose**: Checks that granular approval settings can forbid sandbox escalation entirely.

**Data flow**: It evaluates `echo hello` with sandbox approval disabled in granular settings and expects a forbidden result.

**Call relations**: It verifies the manager honors the granular `sandbox_approval` switch.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, workspace_write); 2 external calls (Granular, vec!).


##### `exec_approval_requirement_rejects_unmatched_sandbox_escalation_when_granular_sandbox_is_disabled`  (lines 1289–1311)

```
async fn exec_approval_requirement_rejects_unmatched_sandbox_escalation_when_granular_sandbox_is_disabled()
```

**Purpose**: Checks that an unknown command requesting sandbox escalation is also forbidden when granular sandbox approval is disabled.

**Data flow**: It evaluates `madeup-cmd` with read-only permissions, escalation required, and sandbox approval disabled, expecting forbidden.

**Call relations**: This complements the known-safe granular sandbox rejection test.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (Granular, vec!).


##### `mixed_rule_and_sandbox_prompt_prioritizes_rule_for_rejection_decision`  (lines 1314–1348)

```
async fn mixed_rule_and_sandbox_prompt_prioritizes_rule_for_rejection_decision()
```

**Purpose**: Checks that when both a policy rule and sandbox escalation could prompt, the result is still an approval request when both prompt types are allowed.

**Data flow**: It creates a prompt rule for `git`, evaluates a shell script containing `git status` and another command with escalation required, and expects a needs-approval result.

**Call relations**: It builds a manager manually from a parsed policy to test mixed prompt sources.

*Call graph*: calls 3 internal fn (new, new, read_only); 4 external calls (new, Granular, assert!, vec!).


##### `mixed_rule_and_sandbox_prompt_rejects_when_granular_rules_are_disabled`  (lines 1351–1387)

```
async fn mixed_rule_and_sandbox_prompt_rejects_when_granular_rules_are_disabled()
```

**Purpose**: Checks that if rule-based approvals are disabled, a matching prompt rule causes rejection even if sandbox approvals are allowed.

**Data flow**: It creates a prompt rule for `git`, evaluates a mixed shell command under granular settings with `rules` disabled, and expects a forbidden rule-approval reason.

**Call relations**: This pairs with the previous mixed-prompt test and checks priority when granular switches conflict.

*Call graph*: calls 3 internal fn (new, new, read_only); 4 external calls (new, Granular, assert_eq!, vec!).


##### `exec_approval_requirement_falls_back_to_heuristics`  (lines 1390–1412)

```
async fn exec_approval_requirement_falls_back_to_heuristics()
```

**Purpose**: Checks that with no explicit policy, the system uses built-in safety guesses, called heuristics.

**Data flow**: It evaluates `cargo build` under read-only permissions and expects approval needed with a proposed amendment for that command.

**Call relations**: It uses a default `ExecPolicyManager`, so the result comes from fallback logic.

*Call graph*: calls 2 internal fn (default, read_only); 2 external calls (assert_eq!, vec!).


##### `empty_bash_lc_script_falls_back_to_original_command`  (lines 1415–1437)

```
async fn empty_bash_lc_script_falls_back_to_original_command()
```

**Purpose**: Checks that an empty shell string is treated as the original `bash -lc` command for approval purposes.

**Data flow**: It evaluates `bash -lc ''` with no policy and expects approval needed with an amendment for the original command.

**Call relations**: This is the approval-level companion to the command-extraction empty-script test.

*Call graph*: calls 2 internal fn (default, read_only); 2 external calls (assert_eq!, vec!).


##### `whitespace_bash_lc_script_falls_back_to_original_command`  (lines 1440–1466)

```
async fn whitespace_bash_lc_script_falls_back_to_original_command()
```

**Purpose**: Checks that a whitespace-only shell string is treated as the original command for approval purposes.

**Data flow**: It evaluates `bash -lc` with only whitespace and expects approval needed with an amendment for the original command.

**Call relations**: This mirrors the extraction test but runs through the full manager.

*Call graph*: calls 2 internal fn (default, read_only); 2 external calls (assert_eq!, vec!).


##### `request_rule_uses_prefix_rule`  (lines 1469–1498)

```
async fn request_rule_uses_prefix_rule()
```

**Purpose**: Checks that when a caller asks to approve a specific prefix, that prefix is used for the proposed amendment.

**Data flow**: It evaluates `cargo install cargo-insta` with requested prefix `cargo install` and expects the amendment to contain only that prefix.

**Call relations**: It uses the default manager and tests requested-prefix handling.

*Call graph*: calls 2 internal fn (default, read_only); 2 external calls (assert_eq!, vec!).


##### `request_rule_falls_back_when_prefix_rule_does_not_approve_all_commands`  (lines 1501–1531)

```
async fn request_rule_falls_back_when_prefix_rule_does_not_approve_all_commands()
```

**Purpose**: Checks that a requested prefix is not enough if a shell script contains other unapproved commands.

**Data flow**: It evaluates a shell script with `cargo install` followed by `rm -rf`, requests `cargo install`, and expects the amendment to focus on the unapproved `rm` command.

**Call relations**: This tests command splitting and requested-rule validation together.

*Call graph*: calls 1 internal fn (default); 2 external calls (assert_eq!, vec!).


##### `heuristics_apply_when_other_commands_match_policy`  (lines 1534–1565)

```
async fn heuristics_apply_when_other_commands_match_policy()
```

**Purpose**: Checks that fallback heuristics still apply to commands in a script that do not match policy, even if other commands do match.

**Data flow**: It allows `apple` by policy, evaluates `apple | orange`, and expects approval needed for `orange`.

**Call relations**: It builds a policy manually and tests mixed policy-plus-heuristic evaluation.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, vec!).


##### `append_execpolicy_amendment_updates_policy_and_file`  (lines 1568–1598)

```
async fn append_execpolicy_amendment_updates_policy_and_file()
```

**Purpose**: Checks that accepting an amendment both updates the in-memory policy and writes a persistent `.rules` file.

**Data flow**: It appends an allow rule for `echo hello`, checks the manager now allows `echo hello world`, reads the created rules file, and verifies its contents.

**Call relations**: This exercises the policy update path, not just policy evaluation.

*Call graph*: calls 2 internal fn (from, default); 5 external calls (assert!, assert_eq!, read_to_string, tempdir, vec!).


##### `append_execpolicy_amendment_rejects_empty_prefix`  (lines 1601–1616)

```
async fn append_execpolicy_amendment_rejects_empty_prefix()
```

**Purpose**: Checks that an empty amendment is rejected instead of writing a meaningless allow rule.

**Data flow**: It tries to append an amendment with an empty command prefix and expects an `EmptyPrefix` update error.

**Call relations**: This is the validation-error counterpart to the successful append test.

*Call graph*: calls 2 internal fn (from, default); 3 external calls (assert!, tempdir, vec!).


##### `proposed_execpolicy_amendment_is_present_for_single_command_without_policy_match`  (lines 1619–1637)

```
async fn proposed_execpolicy_amendment_is_present_for_single_command_without_policy_match()
```

**Purpose**: Checks that a single unmatched command can produce a suggested policy amendment.

**Data flow**: It evaluates `cargo build` with no policy and expects approval needed with an amendment for `cargo build`.

**Call relations**: It uses the shared approval helper to test amendment suggestion in the common case.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `proposed_execpolicy_amendment_is_omitted_when_policy_prompts`  (lines 1640–1656)

```
async fn proposed_execpolicy_amendment_is_omitted_when_policy_prompts()
```

**Purpose**: Checks that the system does not suggest a new allow rule when an existing policy already says the command should prompt.

**Data flow**: It creates a prompt rule for `rm`, evaluates `rm`, and expects approval needed with no amendment.

**Call relations**: This protects explicit policy intent from being overwritten by suggestions.

*Call graph*: calls 1 internal fn (assert_exec_approval_requirement_for_command); 1 external calls (vec!).


##### `proposed_execpolicy_amendment_is_present_for_multi_command_scripts`  (lines 1659–1682)

```
async fn proposed_execpolicy_amendment_is_present_for_multi_command_scripts()
```

**Purpose**: Checks that a multi-command shell script can still produce a focused amendment suggestion.

**Data flow**: It evaluates `cargo build && echo ok` with no policy and expects the amendment to use the first relevant command, `cargo build`.

**Call relations**: It tests command splitting through the shared approval helper.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `proposed_execpolicy_amendment_uses_first_no_match_in_multi_command_scripts`  (lines 1685–1710)

```
async fn proposed_execpolicy_amendment_uses_first_no_match_in_multi_command_scripts()
```

**Purpose**: Checks that in a script where one command is allowed by policy, the amendment points to the first command without a policy match.

**Data flow**: It allows `cat`, evaluates `cat && apple`, and expects an amendment for `apple`.

**Call relations**: This tests how matched rules and amendment suggestions interact.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `proposed_execpolicy_amendment_is_present_when_heuristics_allow`  (lines 1713–1731)

```
async fn proposed_execpolicy_amendment_is_present_when_heuristics_allow()
```

**Purpose**: Checks that even when heuristics allow a safe command, the system may suggest adding an explicit allow rule for future clarity.

**Data flow**: It evaluates `echo safe` under `on request` mode with no policy and expects skip plus an amendment for `echo safe`.

**Call relations**: It uses the shared helper and tests the allow-with-suggestion path.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 2 external calls (new, vec!).


##### `proposed_execpolicy_amendment_is_suppressed_when_policy_matches_allow`  (lines 1734–1754)

```
async fn proposed_execpolicy_amendment_is_suppressed_when_policy_matches_allow()
```

**Purpose**: Checks that no amendment is suggested when an explicit allow rule already matches.

**Data flow**: It allows `python3` by policy, evaluates `python3 -c print(1)`, and expects skip with sandbox bypass and no amendment.

**Call relations**: This pairs with the heuristic-allow amendment test.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `multi_segment_shell_requires_policy_allow_for_every_segment_to_bypass_sandbox`  (lines 1757–1785)

```
async fn multi_segment_shell_requires_policy_allow_for_every_segment_to_bypass_sandbox()
```

**Purpose**: Checks that a shell script only bypasses the sandbox if every command segment is explicitly allowed.

**Data flow**: It allows only `cat`, evaluates a script with `cat`, `curl`, and `bash`, and expects skip without sandbox bypass for both tested approval modes.

**Call relations**: This tests the stricter sandbox-bypass rule for multi-command scripts.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, workspace_write); 1 external calls (vec!).


##### `multi_segment_shell_bypasses_sandbox_when_every_segment_matches_policy_allow`  (lines 1788–1815)

```
async fn multi_segment_shell_bypasses_sandbox_when_every_segment_matches_policy_allow()
```

**Purpose**: Checks that sandbox bypass is allowed when every segment in a shell script has an explicit allow rule.

**Data flow**: It allows `cat`, `curl`, and `bash`, evaluates a three-part shell script, and expects skip with sandbox bypass.

**Call relations**: This is the positive counterpart to the partial-policy multi-segment test.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, read_only); 1 external calls (vec!).


##### `derive_requested_execpolicy_amendment_for_test`  (lines 1817–1833)

```
fn derive_requested_execpolicy_amendment_for_test(
    prefix_rule: Option<&Vec<String>>,
    matched_rules: &[RuleMatch],
) -> Option<ExecPolicyAmendment>
```

**Purpose**: Provides a small wrapper around amendment derivation so tests can call it with less setup.

**Data flow**: It receives an optional requested prefix and matched rules, builds a simple command list, calls the real derivation function with an empty policy and allow fallback, and returns the optional amendment.

**Call relations**: The following amendment-derivation unit tests call this helper instead of repeating the full argument list.

*Call graph*: 2 external calls (empty, default).


##### `derive_requested_execpolicy_amendment_returns_none_for_missing_prefix_rule`  (lines 1836–1841)

```
fn derive_requested_execpolicy_amendment_returns_none_for_missing_prefix_rule()
```

**Purpose**: Checks that no requested amendment is produced when the caller did not provide a prefix rule.

**Data flow**: It calls the test wrapper with `None` and expects `None` back.

**Call relations**: This tests the first rejection case for requested amendments.

*Call graph*: 1 external calls (assert_eq!).


##### `derive_requested_execpolicy_amendment_returns_none_for_empty_prefix_rule`  (lines 1844–1849)

```
fn derive_requested_execpolicy_amendment_returns_none_for_empty_prefix_rule()
```

**Purpose**: Checks that an empty requested prefix is rejected.

**Data flow**: It passes an empty vector as the requested prefix and expects no amendment.

**Call relations**: This protects the amendment logic from creating empty rules.

*Call graph*: 1 external calls (assert_eq!).


##### `derive_requested_execpolicy_amendment_returns_none_for_exact_banned_prefix_rule`  (lines 1852–1860)

```
fn derive_requested_execpolicy_amendment_returns_none_for_exact_banned_prefix_rule()
```

**Purpose**: Checks that overly broad banned prefixes, such as exactly `python -c`, are not accepted as requested amendments.

**Data flow**: It passes `python -c` as the requested prefix and expects no amendment.

**Call relations**: This tests the blocklist used by requested-amendment derivation.

*Call graph*: 1 external calls (assert_eq!).


##### `derive_requested_execpolicy_amendment_returns_none_for_windows_and_pypy_variants`  (lines 1863–1877)

```
fn derive_requested_execpolicy_amendment_returns_none_for_windows_and_pypy_variants()
```

**Purpose**: Checks that Python launcher variants are rejected as too broad for requested amendments.

**Data flow**: It tries prefixes such as `py`, `pythonw`, and `pypy3`, and expects no amendment for each.

**Call relations**: This expands the banned-prefix coverage for Python-like commands.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `derive_requested_execpolicy_amendment_returns_none_for_shell_and_powershell_variants`  (lines 1880–1903)

```
fn derive_requested_execpolicy_amendment_returns_none_for_shell_and_powershell_variants()
```

**Purpose**: Checks that shell and PowerShell launcher prefixes are rejected as requested amendments because they could run many different commands.

**Data flow**: It tries prefixes such as `bash -lc`, `sh -c`, `pwsh`, and `powershell.exe -Command`, expecting no amendment for each.

**Call relations**: This protects against approving a whole shell instead of the command inside it.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `derive_requested_execpolicy_amendment_allows_non_exact_banned_prefix_rule_match`  (lines 1906–1917)

```
fn derive_requested_execpolicy_amendment_allows_non_exact_banned_prefix_rule_match()
```

**Purpose**: Checks that a command starting with a banned-looking prefix can still be allowed if it includes the specific payload.

**Data flow**: It passes `python -c print('hi')` and expects that full prefix to become an amendment.

**Call relations**: This proves the ban is for broad launcher prefixes, not all Python command lines.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `derive_requested_execpolicy_amendment_returns_none_when_policy_matches`  (lines 1920–1959)

```
fn derive_requested_execpolicy_amendment_returns_none_when_policy_matches()
```

**Purpose**: Checks that requested amendments are suppressed when an existing policy rule already matched, regardless of whether that rule allows, prompts, or forbids.

**Data flow**: It passes a requested `cargo build` prefix together with different matched policy-rule records and expects no amendment each time.

**Call relations**: This protects existing policy decisions from being replaced by requested amendments.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `dangerous_rm_rf_requires_approval_in_danger_full_access`  (lines 1962–1980)

```
async fn dangerous_rm_rf_requires_approval_in_danger_full_access()
```

**Purpose**: Checks that a dangerous `rm -rf` command still needs approval when running with full access and no sandbox protection.

**Data flow**: It builds an `rm -rf` command, evaluates it with approval allowed on request and sandbox disabled, and expects approval needed with an amendment.

**Call relations**: It uses `vec_str` for command construction and the shared approval helper.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, vec_str); 1 external calls (new).


##### `vec_str`  (lines 1982–1984)

```
fn vec_str(items: &[&str]) -> Vec<String>
```

**Purpose**: Converts a list of string slices into owned `String` values. It keeps command setup short in tests.

**Data flow**: It receives borrowed text items, clones each into a `String`, and returns a vector.

**Call relations**: Dangerous-command and PowerShell tests use it to build command vectors.

*Call graph*: called by 4 (dangerous_command_allowed_when_sandbox_is_explicitly_disabled, dangerous_command_forbidden_in_external_sandbox_when_policy_matches, dangerous_rm_rf_requires_approval_in_danger_full_access, verify_approval_requirement_for_unsafe_powershell_command).


##### `verify_approval_requirement_for_unsafe_powershell_command`  (lines 1989–2086)

```
async fn verify_approval_requirement_for_unsafe_powershell_command()
```

**Purpose**: Checks platform-specific handling of unsafe PowerShell commands and dangerous Unix-like commands. It only runs the PowerShell part when `pwsh` is installed.

**Data flow**: It builds a policy manager with no rules, evaluates a sneaky PowerShell command with read-only permissions, chooses the expected result by platform, then checks `rm -rf` approval and rejection behavior.

**Call relations**: It calls `vec_str` repeatedly and directly uses the manager rather than the shared scenario helper because it needs custom platform-specific assertions.

*Call graph*: calls 2 internal fn (new, vec_str); 6 external calls (new, new, assert_eq!, cfg!, empty, which).


##### `dangerous_command_allowed_when_sandbox_is_explicitly_disabled`  (lines 2089–2110)

```
async fn dangerous_command_allowed_when_sandbox_is_explicitly_disabled()
```

**Purpose**: Checks that an external sandbox profile can mean Codex itself should not block a dangerous command when there is no matching prompt policy.

**Data flow**: It evaluates `rm -rf /tmp/nonexistent` with approval set to never and an external sandbox profile, expecting the command to be skipped rather than forbidden.

**Call relations**: It uses the shared approval helper to test the special external-sandbox case.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, vec_str).


##### `dangerous_command_forbidden_in_external_sandbox_when_policy_matches`  (lines 2113–2131)

```
async fn dangerous_command_forbidden_in_external_sandbox_when_policy_matches()
```

**Purpose**: Checks that explicit policy still wins inside an external sandbox profile. If policy says prompt and asking is disabled, the command is forbidden.

**Data flow**: It adds a prompt rule for `rm`, evaluates `rm -rf` with approval never and external sandbox, and expects a forbidden approval-required reason.

**Call relations**: This pairs with the previous external-sandbox test to show policy matches are still enforced.

*Call graph*: calls 2 internal fn (assert_exec_approval_requirement_for_command, vec_str).


##### `policy_from_src`  (lines 2143–2152)

```
fn policy_from_src(policy_src: Option<&str>) -> Arc<Policy>
```

**Purpose**: Builds a `Policy` from optional Starlark source text for approval tests. If no source is given, it returns an empty policy.

**Data flow**: It receives optional policy text, parses it when present, builds the policy, wraps it in shared ownership, and returns it.

**Call relations**: The shared approval evaluator calls this before creating an `ExecPolicyManager`.

*Call graph*: calls 1 internal fn (new); called by 1 (exec_approval_requirement_for_command); 2 external calls (new, empty).


##### `exec_approval_requirement_for_command`  (lines 2154–2178)

```
async fn exec_approval_requirement_for_command(
    test: ExecApprovalRequirementScenario,
) -> ExecApprovalRequirement
```

**Purpose**: Runs one approval scenario through the real execution-policy manager and returns the decision.

**Data flow**: It unpacks the scenario, builds a policy from the optional source, creates a manager, sends an `ExecApprovalRequest`, awaits the result, and returns the approval requirement.

**Call relations**: The assertion helper calls this, and many tests call the assertion helper to avoid repeating manager setup.

*Call graph*: calls 2 internal fn (new, policy_from_src); called by 1 (assert_exec_approval_requirement_for_command).


##### `assert_exec_approval_requirement_for_command`  (lines 2180–2186)

```
async fn assert_exec_approval_requirement_for_command(
    test: ExecApprovalRequirementScenario,
    expected_requirement: ExecApprovalRequirement,
)
```

**Purpose**: Shared assertion helper for approval-decision tests. It compares the manager's actual answer with the expected answer.

**Data flow**: It receives a scenario and an expected requirement, calls `exec_approval_requirement_for_command`, and asserts equality.

**Call relations**: Most command-approval tests use this as their final handoff into the execution-policy manager.

*Call graph*: calls 1 internal fn (exec_approval_requirement_for_command); called by 29 (absolute_path_exec_approval_requirement_ignores_disallowed_host_executable_paths, absolute_path_exec_approval_requirement_matches_host_executable_rules, dangerous_command_allowed_when_sandbox_is_explicitly_disabled, dangerous_command_forbidden_in_external_sandbox_when_policy_matches, dangerous_rm_rf_requires_approval_in_danger_full_access, drops_requested_amendment_for_heredoc_fallback_prompts_when_it_matches, drops_requested_amendment_for_heredoc_fallback_prompts_when_it_wont_match, evaluates_bash_lc_inner_commands, evaluates_heredoc_script_against_prefix_rules, exec_approval_requirement_prefers_execpolicy_match (+15 more)); 1 external calls (assert_eq!).


##### `exec_policies_only_load_from_trusted_project_layers`  (lines 2189–2234)

```
async fn exec_policies_only_load_from_trusted_project_layers() -> std::io::Result<()>
```

**Purpose**: Checks that when working inside a nested project, only the trusted project layer's policy files are loaded.

**Data flow**: It creates root and nested project rules, marks only the nested project trusted, builds config from the nested directory, loads policy, and verifies root `rm` is ignored while nested `mv` is forbidden.

**Call relations**: It uses `write_project_trust_config` and then tests the real config loader plus policy loader together.

*Call graph*: calls 1 internal fn (write_project_trust_config); 5 external calls (assert_eq!, default, create_dir_all, write, tempdir).


##### `exec_policies_require_project_trust_without_config_toml`  (lines 2237–2292)

```
async fn exec_policies_require_project_trust_without_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that project policy files are ignored unless the project is explicitly trusted, even when there is no project config TOML file.

**Data flow**: It creates a project rule forbidding `rm`, runs three trust cases unknown/untrusted/trusted, builds config for each, and checks whether `rm` is allowed or forbidden as expected.

**Call relations**: It uses `write_project_trust_config` to vary trust state and then calls the real loader.

*Call graph*: calls 1 internal fn (write_project_trust_config); 8 external calls (new, assert_eq!, default, format!, create_dir_all, write, tempdir, vec!).


##### `exec_policy_warnings_ignore_untrusted_project_rules_without_config_toml`  (lines 2295–2342)

```
async fn exec_policy_warnings_ignore_untrusted_project_rules_without_config_toml() -> std::io::Result<()>
```

**Purpose**: Checks that broken policy files in unknown or untrusted projects do not produce warnings, while broken files in trusted projects do.

**Data flow**: It writes an invalid rules file, runs unknown/untrusted/trusted trust cases, checks policy warnings, and expects a parse warning only for the trusted case.

**Call relations**: It uses `write_project_trust_config` and tests the warning path, not just successful policy loading.

*Call graph*: calls 1 internal fn (write_project_trust_config); 8 external calls (new, assert_eq!, default, format!, create_dir_all, write, tempdir, vec!).


### `core/src/exec_policy_windows_tests.rs`

`test` · `test run`

This is a Windows-focused test file for the project’s execution policy: the rules that decide whether an external command is safe to run. That matters because tools often launch commands through wrappers like PowerShell, and the dangerous part may be hidden inside a larger command such as `powershell.exe -Command "Remove-Item test"`. Without these tests, the system might approve the wrapper without checking the real command inside it.

The tests cover several important cases. Some check that PowerShell inner commands are compared against explicit policy rules, such as “allow commands starting with echo” or “prompt before running echo.” Others check the fallback behavior when no rule matches. For example, harmless PowerShell reading commands can be allowed in read-only mode, while dangerous commands such as `Remove-Item` should require approval.

The file also tests how Windows sandbox support affects the decision. A sandbox is a restricted environment, like letting a guest use only a locked-down room instead of the whole house. If a Windows sandbox is available, some read-only unmatched commands can run safely. If no sandbox backend is available and the approval policy says never ask, the command is forbidden instead of silently allowed.

#### Function details

##### `evaluates_powershell_inner_commands_against_prompt_rules`  (lines 5–25)

```
async fn evaluates_powershell_inner_commands_against_prompt_rules()
```

**Purpose**: This test checks that the system looks inside a PowerShell wrapper before applying execution rules. It proves that a rule saying “prompt for echo” still affects `echo` even when it is hidden behind `powershell.exe -Command`.

**Data flow**: The test builds a scenario with a policy rule for `echo`, a PowerShell command that runs `echo blocked`, and an approval setting that never asks the user. It sends that scenario into the shared approval-check helper. The expected result is that the command is forbidden because a prompt would be required, but prompting is not allowed in this setup.

**Call relations**: During the test run, the test calls the shared assertion helper to exercise the real execution-policy decision path. It uses a command vector to describe the Windows command line, then relies on the helper to compare the actual result with the expected forbidden decision.

*Call graph*: 1 external calls (vec!).


##### `evaluates_powershell_inner_commands_against_allow_rules`  (lines 28–49)

```
async fn evaluates_powershell_inner_commands_against_allow_rules()
```

**Purpose**: This test checks that an explicit allow rule can approve a command found inside PowerShell. It confirms that the policy does not stop at the outer `powershell.exe` program name.

**Data flow**: The test creates a scenario where the policy allows commands starting with `echo`, then wraps `echo blocked` inside a PowerShell command. It uses a read-only permission profile and an approval policy that allows trusted commands. The expected output is a skip-approval decision, with sandbox bypass allowed because the rule has already approved the command.

**Call relations**: The test uses the permission-profile helper for read-only mode, then passes the full scenario to the shared approval assertion helper. That helper runs the actual decision code and verifies it matches the expected approval-skipping result.

*Call graph*: calls 1 internal fn (read_only); 1 external calls (vec!).


##### `commands_for_exec_policy_parses_powershell_shell_wrapper`  (lines 52–68)

```
fn commands_for_exec_policy_parses_powershell_shell_wrapper()
```

**Purpose**: This test checks the parsing step that extracts the real command from a PowerShell shell wrapper. It makes sure `powershell.exe -Command "echo blocked"` becomes the simpler command `echo blocked` for policy checking.

**Data flow**: The input is a list of command-line words representing a PowerShell invocation. The parsing function reads that list, recognizes the PowerShell wrapper, and returns an execution-policy command object containing the inner command words, the origin marked as PowerShell, and a note that complex parsing was not needed. The test compares that result to the expected structure.

**Call relations**: This test directly calls the command-extraction function and uses an equality assertion to check the result. It sits before the higher-level approval tests conceptually: if parsing fails here, the policy rules in the other tests would be applied to the wrong command.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `unmatched_safe_powershell_words_are_allowed`  (lines 71–88)

```
fn unmatched_safe_powershell_words_are_allowed()
```

**Purpose**: This test checks that some safe-looking PowerShell commands can be allowed even when no explicit rule matches them. In this case, reading a file with `Get-Content` in a read-only profile is treated as acceptable.

**Data flow**: The test gives the decision function a PowerShell-origin command, `Get-Content Cargo.toml`, plus context saying approval is only needed unless the command is trusted, the permission profile is read-only, and no Windows sandbox is active. The function returns an allow decision, and the test verifies that result.

**Call relations**: The test calls the unmatched-command decision function directly. It focuses on the fallback path used after policy-rule matching has found no explicit allow or deny rule.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `read_only_windows_sandbox_runs_unmatched_commands_under_sandbox`  (lines 91–113)

```
fn read_only_windows_sandbox_runs_unmatched_commands_under_sandbox()
```

**Purpose**: This test checks that unmatched commands can still be allowed in read-only mode when a Windows sandbox is available. The sandbox provides the safety boundary that makes running the command acceptable.

**Data flow**: The test uses a simple Windows command, `cmd.exe /c dir`, and tries it with two sandbox levels: restricted token and elevated. For each level, it passes read-only permissions and a never-ask approval setting into the decision function. The expected result is allow, because the command can rely on the sandbox instead of user approval.

**Call relations**: The test loops through the supported Windows sandbox levels and calls the unmatched-command decision function for each one. It verifies that both sandbox backends lead to the same safe allow decision.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `read_only_windows_policy_without_sandbox_backend_still_requires_approval`  (lines 116–134)

```
fn read_only_windows_policy_without_sandbox_backend_still_requires_approval()
```

**Purpose**: This test checks the opposite of the sandbox case: read-only permissions alone are not enough if there is no Windows sandbox available. If the system cannot ask for approval, the command must be blocked.

**Data flow**: The input is `cmd.exe /c dir` with a read-only permission profile, no Windows sandbox, and an approval policy that never asks the user. The unmatched-command decision function evaluates that context and returns forbidden. The test confirms the command is blocked because there is no sandbox to rely on and no approval path available.

**Call relations**: The test calls the same fallback decision function used by the other unmatched-command tests. It documents the safety rule that the sandbox backend is an important part of allowing Windows commands without asking.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `writable_windows_policy_without_sandbox_backend_still_requires_approval`  (lines 137–172)

```
fn writable_windows_policy_without_sandbox_backend_still_requires_approval()
```

**Purpose**: This test checks that a more permissive file-system setup still does not allow unmatched Windows commands when no sandbox is available. Writable access makes the situation riskier, so the command is forbidden when approval cannot be requested.

**Data flow**: The test first builds a file-system sandbox policy that allows reading the root and writing inside project roots. It turns that runtime policy into a permission profile, then tests `cmd.exe /c dir` with no Windows sandbox and a never-ask approval policy. The decision function returns forbidden, and the test verifies that result.

**Call relations**: This test uses helper constructors to build a realistic permission profile before calling the unmatched-command decision function. It complements the read-only no-sandbox test by showing that writable permissions also cannot bypass the need for approval or sandboxing.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 2 external calls (assert_eq!, vec!).


##### `unmatched_dangerous_powershell_inner_commands_require_approval`  (lines 175–202)

```
async fn unmatched_dangerous_powershell_inner_commands_require_approval()
```

**Purpose**: This test checks that a dangerous PowerShell command hidden inside a wrapper is not silently allowed when no policy rule matches it. It should ask for approval and suggest a policy amendment for the exact inner command.

**Data flow**: The test defines the inner command `Remove-Item test -Force`, then wraps the same text inside `powershell.exe -Command`. With no policy source, approval allowed on request, and disabled permissions, it asks the shared helper to evaluate the scenario. The expected output is a needs-approval decision that includes a proposed policy amendment for the extracted inner command.

**Call relations**: The test calls the shared approval assertion helper, which runs the full approval-requirement flow. It also constructs the expected amendment object, showing that the system should remember the real inner command when suggesting what the user might approve in the future.

*Call graph*: 2 external calls (new, vec!).


### `core/src/safety_tests.rs`

`test` · `test suite`

This is a test file, so it does not provide the safety system itself. Instead, it checks that the safety system behaves correctly in important edge cases. The safety system is like a security guard for file edits: before a patch writes to disk, it asks, “Is this place allowed? Do we need the user to approve this? Is this completely forbidden?”

Each test builds a temporary project folder so it does not touch the real machine. Then it creates a fake patch, usually adding a file either inside the project or just outside it. The tests combine that patch with different permission profiles, such as “workspace write,” “read only,” or “external sandbox.” A sandbox is a restricted area where code is allowed to read or write only certain paths.

The file checks several important promises: writing inside the workspace can be allowed; writing outside usually needs approval or is rejected; read-only mode rejects edits with the right reason; and explicit deny or read-only rules override broader write permissions. It also tests newer “granular approval” settings, where different kinds of approvals can be switched on or off. Without these tests, small changes to the safety rules could silently make Codex too permissive or too strict.

#### Function details

##### `test_writable_roots_constraint`  (lines 15–61)

```
fn test_writable_roots_constraint()
```

**Purpose**: This test checks that a patch is considered safe only when all of its writes stay inside allowed writable folders. It proves that the workspace is writable by default, but its parent folder is not unless it is explicitly added.

**Data flow**: The test starts with a temporary project folder and creates two fake file-add patches: one inside that folder and one in its parent folder. It builds a file-system policy that allows workspace writes, then asks the safety helper whether each patch stays within writable paths. The inside patch comes out allowed, the outside patch comes out disallowed, and after the parent folder is added as an allowed root, the outside patch becomes allowed.

**Call relations**: The Rust test runner calls this test during the test suite. Inside the test, it uses the workspace-write policy builder to create the allowed area, creates test patch actions, and checks the result with assertions. This gives later safety decisions a trusted foundation: the lower-level writable-path check must classify paths correctly.

*Call graph*: calls 1 internal fn (workspace_write); 3 external calls (new, assert!, from_ref).


##### `external_sandbox_auto_approves_in_on_request`  (lines 64–89)

```
fn external_sandbox_auto_approves_in_on_request()
```

**Purpose**: This test checks that when an external sandbox is in charge, a normal in-project patch can be automatically approved under the “ask on request” approval mode. In plain terms, if another sandbox is already protecting the write and the patch is allowed, Codex should not bother the user.

**Data flow**: The test creates a temporary project folder and a fake patch that adds a file inside it. It sets the permission profile to an external sandbox and builds the matching file-system sandbox policy. It then sends the patch and policy into the patch safety checker, which returns an automatic approval with no extra sandbox wrapper and no claim that the user explicitly approved it.

**Call relations**: The test runner invokes this function as one safety scenario. The function creates a patch with the test patch constructor, gets an external sandbox policy, then asks the main patch safety assessment routine for a decision. Its assertion locks in the expected behavior for external-sandbox workflows.

*Call graph*: calls 2 internal fn (new_add_for_test, external_sandbox); 2 external calls (new, assert_eq!).


##### `granular_with_all_flags_true_matches_on_request_for_out_of_root_patch`  (lines 92–134)

```
fn granular_with_all_flags_true_matches_on_request_for_out_of_root_patch()
```

**Purpose**: This test makes sure the newer granular approval mode behaves like the older “ask on request” mode when every granular approval switch is turned on. It focuses on a patch that writes outside the project, where user approval should be required.

**Data flow**: The test creates a temporary project folder, then builds a patch that adds a file in the parent folder outside the workspace. It creates a workspace-write permission profile, which does not allow that outside path. It asks the safety checker twice: once using ordinary “on request” approval, and once using granular approval with all approval categories enabled. Both checks return the same result: ask the user.

**Call relations**: This test is run by the Rust test harness. It uses the workspace-write permission builder and the patch test constructor, then compares two calls to the patch safety checker. Its role is to prove that enabling all granular controls does not accidentally change existing approval behavior.

*Call graph*: calls 2 internal fn (new_add_for_test, workspace_write_with); 2 external calls (new, assert_eq!).


##### `granular_sandbox_approval_false_rejects_out_of_root_patch`  (lines 137–170)

```
fn granular_sandbox_approval_false_rejects_out_of_root_patch()
```

**Purpose**: This test checks that granular approval can fully block a patch when sandbox approval is disabled. A write outside the project should not merely ask the user if the relevant approval path has been turned off; it should be rejected.

**Data flow**: The test creates a temporary project folder and a fake patch that writes just outside it. It builds a workspace-write permission profile, meaning the outside path is not normally writable. Then it calls the safety checker with granular approval settings where sandbox approval is false but the other approval categories are true. The result is a rejection with the standard reason for patches outside the project.

**Call relations**: The test runner calls this function as part of the safety test suite. The function prepares the permission profile and patch, then hands them to the central safety assessment logic. Its assertion documents how granular settings are supposed to affect the final decision.

*Call graph*: calls 2 internal fn (new_add_for_test, workspace_write_with); 2 external calls (new, assert_eq!).


##### `read_only_policy_rejects_patch_with_read_only_reason`  (lines 173–199)

```
fn read_only_policy_rejects_patch_with_read_only_reason()
```

**Purpose**: This test verifies that read-only mode really forbids file edits, even inside the project folder. It also checks that the rejection message explains the right reason: the system is read-only, not merely that the path is outside the project.

**Data flow**: The test creates a temporary project folder and a fake patch that adds a file inside it. It builds a read-only permission profile and gets its file-system policy. First, it confirms that the patch is not considered constrained to writable paths. Then it asks the safety checker for a final decision with approvals disabled, and the checker returns a rejection using the read-only reason.

**Call relations**: The Rust test harness invokes this test. The test uses the read-only profile builder, the patch test constructor, the writable-path check, and the main safety assessment. It connects the low-level path permission result to the user-facing rejection reason.

*Call graph*: calls 2 internal fn (new_add_for_test, read_only); 3 external calls (new, assert!, assert_eq!).


##### `explicit_unreadable_paths_prevent_auto_approval_for_external_sandbox`  (lines 201–241)

```
fn explicit_unreadable_paths_prevent_auto_approval_for_external_sandbox()
```

**Purpose**: This test checks that a specific denied file path overrides a broader write permission. Even when an external sandbox generally allows writing, Codex should not automatically approve a patch that targets a path marked as denied.

**Data flow**: The test creates a temporary project folder and a fake patch aimed at a specific file inside it. It builds an external permission profile and a restricted file-system policy that first allows writing at the root, then explicitly denies the target file. The writable-path check says the patch is not allowed, and the full safety assessment returns “ask the user” instead of automatic approval.

**Call relations**: The test runner calls this scenario during testing. The function constructs a restricted sandbox rule list, creates a patch, and sends both through the writable-path checker and the main patch safety checker. It proves that narrower deny rules are respected before the system grants automatic approval.

*Call graph*: calls 2 internal fn (new_add_for_test, restricted); 4 external calls (new, assert!, assert_eq!, vec!).


##### `explicit_read_only_subpaths_prevent_auto_approval_for_external_sandbox`  (lines 244–285)

```
fn explicit_read_only_subpaths_prevent_auto_approval_for_external_sandbox()
```

**Purpose**: This test verifies that a read-only subfolder blocks automatic approval for writes inside that subfolder. A broad workspace write rule should not override a more specific read-only rule for part of the project.

**Data flow**: The test creates a temporary project folder and chooses a file under a docs folder. It resolves the docs folder to an absolute path, then builds a restricted policy that allows writing to project roots but marks docs as read-only. The fake patch tries to add the blocked file. The writable-path check rejects it, and the full safety checker decides to ask the user instead of approving automatically.

**Call relations**: The Rust test harness invokes this test. The function uses path resolution to identify the protected subfolder, builds a restricted policy with both broad and narrow rules, then sends the patch through the safety checks. It guards the rule that specific read-only areas must win over general write permission.

*Call graph*: calls 3 internal fn (new_add_for_test, restricted, resolve_path_against_base); 4 external calls (new, assert!, assert_eq!, vec!).


##### `missing_project_dot_codex_config_requires_approval`  (lines 288–325)

```
fn missing_project_dot_codex_config_requires_approval()
```

**Purpose**: This test checks a sensitive project configuration path: `.codex/config.toml`. If the `.codex` folder is marked read-only, creating or changing its config file should require approval instead of being silently allowed.

**Data flow**: The test creates a temporary project folder and a fake patch that would add `.codex/config.toml`. It starts with a normal workspace-write permission profile, then adds an extra sandbox entry saying the `.codex` folder is read-only. The writable-path check says the patch is not allowed for automatic writing, and the safety checker returns “ask the user.”

**Call relations**: The test runner calls this function with the rest of the safety tests. The function combines the workspace-write profile with an extra read-only rule, then checks both the lower-level writable-path decision and the final patch safety result. It protects project-level Codex configuration from being changed without an approval step when that folder is restricted.

*Call graph*: calls 2 internal fn (new_add_for_test, workspace_write_with); 3 external calls (new, assert!, assert_eq!).


### `core/src/mcp_tool_exposure_test.rs`

`test` · `test run`

MCP tools are outside tools that Codex can call, such as app actions or server-provided commands. Showing every tool directly can overwhelm the model, so the main code has to choose: expose a small useful set immediately, hide tools that are not meant for the model, and defer large sets so they can be found through tool search instead. This test file checks those decisions.

The helper functions build small fake connectors and fake MCP tools, like props on a stage. Tests then feed these tools into the exposure-building logic and compare the result against what should happen. A small tool list should be shown directly. A large list should be deferred. Tools whose metadata says they are only for the app user interface, not the model, should be excluded. App tools also respect user configuration, so a disabled app tool stays hidden unless the config explicitly enables it. Finally, one feature flag forces all MCP tools, including app tools, to be deferred.

Without these tests, changes to tool exposure could accidentally show hidden tools to the model, ignore a user’s app policy, or flood the model with too many tools at once.

#### Function details

##### `make_connector`  (lines 20–36)

```
fn make_connector(id: &str, name: &str) -> AppInfo
```

**Purpose**: Creates a simple fake app connector for tests. A connector represents an app integration, such as Calendar, that may provide tools.

**Data flow**: It takes an app id and display name as text. It puts those into an AppInfo record, fills optional fields with empty values, and marks the connector as accessible and enabled. The result is a ready-to-use test connector.

**Call relations**: The tests use this helper when they need app-backed tools to look as if they belong to a real connector. It relies on standard string creation to turn the borrowed input text into owned values stored in the connector.

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

**Purpose**: Builds a fake MCP tool with the names and app information a test needs. It saves each test from repeating the long setup needed to describe a tool.

**Data flow**: It receives the MCP server name, public tool name, callable namespace, callable function name, and optional connector id/name. It creates a ToolInfo record with a small test description, an empty input schema, and any connector details. The output is one complete test tool.

**Call relations**: Several tests call this helper when they need named tools with precise properties, especially the visibility and app-policy tests. Inside, it constructs the underlying Tool object and default JSON object so the exposure logic sees something shaped like a real MCP tool.

*Call graph*: called by 2 (applies_per_tool_app_policy_across_the_exposure_build, excludes_tools_hidden_from_model_exposure); 5 external calls (new, default, new, format!, new).


##### `numbered_mcp_tools`  (lines 64–78)

```
fn numbered_mcp_tools(count: usize) -> Vec<ToolInfo>
```

**Purpose**: Creates a list of many simple fake MCP tools named tool_0, tool_1, and so on. It is used to test behavior that depends on how many tools exist.

**Data flow**: It takes a count. It loops from zero up to that count, creates a tool name for each number, builds a matching MCP tool, and collects them into a vector. The result is a predictable list of tools.

**Call relations**: The small-set test and large-set test call this helper to create tool lists just below or at the direct-exposure threshold. It feeds those lists into the exposure builder so the tests can check whether the size rule is working.

*Call graph*: called by 2 (directly_exposes_small_effective_tool_sets, searches_large_effective_tool_sets).


##### `tool_names`  (lines 80–85)

```
fn tool_names(tools: &[ToolInfo]) -> HashSet<ToolName>
```

**Purpose**: Turns a list of full tool records into just their canonical tool names. This makes test comparisons focus on which tools were exposed, not on every detail inside each tool record.

**Data flow**: It receives a slice of ToolInfo values. It reads each tool, asks for its canonical name, and collects those names into a HashSet, which is a collection where order does not matter. The output is that set of names.

**Call relations**: Tests use this when comparing expected tools with actual exposed or deferred tools. The always-defer test also uses it to check that specific names are present after the exposure builder has deferred the tools.

*Call graph*: called by 1 (always_defer_feature_defers_apps_too); 1 external calls (iter).


##### `with_visibility`  (lines 87–95)

```
fn with_visibility(mut tool: ToolInfo, visibility: &[&str]) -> ToolInfo
```

**Purpose**: Adds test metadata that says where a tool should be visible, such as to the app interface, the model, or both. This lets tests check that model-hidden tools stay hidden.

**Data flow**: It takes an existing ToolInfo and a list of visibility labels. It writes a JSON metadata object onto the tool under ui.visibility. It returns the same tool with that metadata added.

**Call relations**: The visibility test calls this helper to mark some tools as visible to the model and others as app-only. It uses the JSON and Meta wrappers so the fake tool metadata matches the shape expected by the exposure logic.

*Call graph*: called by 1 (excludes_tools_hidden_from_model_exposure); 2 external calls (Meta, json!).


##### `directly_exposes_small_effective_tool_sets`  (lines 98–108)

```
async fn directly_exposes_small_effective_tool_sets()
```

**Purpose**: Checks that when there are only a few available MCP tools, they are shown directly to the model. This confirms the basic happy path for small tool lists.

**Data flow**: It starts with a test configuration and creates one fewer tool than the direct-exposure threshold. It runs the exposure builder, then compares the exposed direct tool names with the original tool names. The expected result is that all tools are direct and there is no deferred search-only list.

**Call relations**: This test calls the shared test configuration helper and numbered_mcp_tools to prepare its inputs. It then uses assertions to verify the exposure builder keeps small sets simple instead of routing them through tool search.

*Call graph*: calls 2 internal fn (test_config, numbered_mcp_tools); 2 external calls (assert!, assert_eq!).


##### `excludes_tools_hidden_from_model_exposure`  (lines 111–186)

```
async fn excludes_tools_hidden_from_model_exposure()
```

**Purpose**: Checks that tools marked as not visible to the model are not exposed to it. This matters because some tools may be meant only for the app user interface.

**Data flow**: It creates several tools: a normal visible tool, tools with app-only or empty visibility metadata, and app tools with mixed visibility. It also creates a Calendar connector. After running the exposure builder with search disabled, it expects only the plain visible tool and the app tool that explicitly includes model visibility to remain direct.

**Call relations**: This test uses make_mcp_tool to create the base tools and with_visibility to attach visibility metadata. It then uses assertions to confirm the exposure builder filters out hidden tools before deciding what to show.

*Call graph*: calls 3 internal fn (test_config, make_mcp_tool, with_visibility); 3 external calls (assert!, assert_eq!, vec!).


##### `applies_per_tool_app_policy_across_the_exposure_build`  (lines 189–237)

```
async fn applies_per_tool_app_policy_across_the_exposure_build()
```

**Purpose**: Checks that user configuration can enable one app tool while leaving another tool from the same app disabled. This protects per-tool app policy from being ignored.

**Data flow**: It creates a temporary Codex home folder and writes a config file where Calendar tools are disabled by default, except events/create is explicitly enabled. It builds a config from that folder, creates an enabled Calendar tool and a disabled Calendar tool, then runs the exposure builder. The expected output is that only the enabled tool is directly exposed.

**Call relations**: This test builds its own config instead of using the default test config because it needs a specific policy file. It uses make_mcp_tool for the two Calendar tools, then assertions check that exposure respects the written config throughout the build.

*Call graph*: calls 1 internal fn (make_mcp_tool); 6 external calls (assert!, assert_eq!, default, write, tempdir, vec!).


##### `searches_large_effective_tool_sets`  (lines 240–254)

```
async fn searches_large_effective_tool_sets()
```

**Purpose**: Checks that a large set of MCP tools is not shown directly, but is instead made available through tool search. This prevents the model from being overloaded with too many tool definitions at once.

**Data flow**: It creates exactly enough numbered tools to hit the direct-exposure threshold. It runs the exposure builder with search enabled. The expected result is an empty direct list and a deferred list containing all the original tools.

**Call relations**: This test uses numbered_mcp_tools to create a threshold-sized tool set, then assertions verify the size rule. It complements the small-set test by checking the other side of the cutoff.

*Call graph*: calls 2 internal fn (test_config, numbered_mcp_tools); 2 external calls (assert!, assert_eq!).


##### `always_defer_feature_defers_apps_too`  (lines 257–301)

```
async fn always_defer_feature_defers_apps_too()
```

**Purpose**: Checks that a feature flag forcing MCP tools to be deferred also applies to app-backed tools. This ensures the flag behaves consistently across ordinary MCP tools and Codex app tools.

**Data flow**: It starts with a test config, turns on the ToolSearchAlwaysDeferMcpTools feature, and creates one ordinary MCP tool plus one Calendar app tool. After running the exposure builder, it expects no direct tools. It then checks that both tool names appear in the deferred list.

**Call relations**: This test calls the test configuration helper, updates the feature settings, and uses tool_names to inspect the deferred output. Its assertions confirm that the exposure builder follows the feature flag before exposing either regular or app MCP tools directly.

*Call graph*: calls 2 internal fn (test_config, tool_names); 2 external calls (assert!, vec!).


### `core/src/sandbox_tags_tests.rs`

`test` · `test run`

This is a test file for the code that turns permission profiles into simple labels such as "none", "external", or a platform-specific sandbox name. A sandbox is a safety boundary that limits what a process can touch, like putting a messy craft project inside a tray so glue and paint do not spread everywhere. The tests check that Codex labels those boundaries honestly.

The file focuses on two tag-producing helpers: one that describes the active sandbox style, and one that maps a newer permission profile back to the closest older policy name. It checks important edge cases. Full access should be tagged as "none", even if the current operating system has a default sandbox available. An externally supplied sandbox should keep the label "external". Read-only or enforced managed-network profiles should use the platform sandbox tag when one exists. Managed profiles that effectively allow all file access and network access should not be falsely reported as sandboxed unless network enforcement changes that meaning.

The final test builds a realistic restricted file-system policy with one writable workspace path and confirms it is reported as the older "workspace-write" mode. Without these tests, small changes in permission logic could silently produce misleading telemetry or user-facing status labels.

#### Function details

##### `danger_full_access_is_untagged_even_when_linux_sandbox_defaults_apply`  (lines 19–26)

```
fn danger_full_access_is_untagged_even_when_linux_sandbox_defaults_apply()
```

**Purpose**: Checks that a fully disabled permission profile is reported as having no sandbox. This protects against accidentally labeling dangerous full access as safer than it is.

**Data flow**: The test starts with a disabled permission profile, disabled Windows sandbox setting, and no managed-network enforcement. It passes those inputs into the sandbox-tag helper, then compares the returned text with "none". Nothing is changed outside the test; the result is simply accepted or rejected by the assertion.

**Call relations**: During the test run, this test calls `permission_profile_sandbox_tag` to get the label and then uses `assert_eq!` to prove the label is exactly "none". It stands as a guard for the full-access case.

*Call graph*: 2 external calls (assert_eq!, permission_profile_sandbox_tag).


##### `external_sandbox_keeps_external_tag_when_linux_sandbox_defaults_apply`  (lines 29–38)

```
fn external_sandbox_keeps_external_tag_when_linux_sandbox_defaults_apply()
```

**Purpose**: Checks that a permission profile using an outside sandbox is labeled "external". This matters because an external sandbox is different from Codex’s own platform sandbox and should not be blended into another category.

**Data flow**: The test creates an external permission profile with network access enabled. It asks the sandbox-tag helper for the label under disabled Windows sandbox settings and no managed-network enforcement. The output must be "external".

**Call relations**: The test calls `permission_profile_sandbox_tag` for the external profile and then hands the answer to `assert_eq!`. It confirms that platform defaults do not overwrite the explicit external-sandbox label.

*Call graph*: 2 external calls (assert_eq!, permission_profile_sandbox_tag).


##### `default_linux_sandbox_uses_platform_sandbox_tag`  (lines 41–51)

```
fn default_linux_sandbox_uses_platform_sandbox_tag()
```

**Purpose**: Checks that a normal read-only permission profile is labeled with the sandbox type provided by the current platform, when such a sandbox exists. If no platform sandbox is available, the expected label is "none".

**Data flow**: The test creates a read-only profile, asks `permission_profile_sandbox_tag` for its label, and separately asks `get_platform_sandbox` what sandbox the platform would use. It converts that platform sandbox into its metric tag, or uses "none" if there is no sandbox, then compares the two labels.

**Call relations**: This test uses `read_only` to build the profile, `get_platform_sandbox` to calculate the expected platform answer, and `permission_profile_sandbox_tag` to calculate the actual answer. `assert_eq!` ties the two together and catches disagreement.

*Call graph*: calls 1 internal fn (read_only); 3 external calls (assert_eq!, get_platform_sandbox, permission_profile_sandbox_tag).


##### `profile_sandbox_tag_distinguishes_disabled_from_external`  (lines 54–73)

```
fn profile_sandbox_tag_distinguishes_disabled_from_external()
```

**Purpose**: Checks that the tag logic can tell the difference between no sandbox at all and a sandbox supplied externally. These two cases can both sit outside Codex’s own built-in sandboxing, but they mean very different things.

**Data flow**: The test feeds two different profiles into the tag logic inside assertions: one disabled profile and one external profile with restricted networking. The disabled case must produce "none". The external case must produce "external".

**Call relations**: This test is a compact comparison of two nearby cases. Its assertions verify that the tag function does not collapse disabled and external profiles into the same reported value.

*Call graph*: 1 external calls (assert_eq!).


##### `unrestricted_managed_profile_with_enabled_network_is_untagged`  (lines 76–90)

```
fn unrestricted_managed_profile_with_enabled_network_is_untagged()
```

**Purpose**: Checks that a managed profile with unrestricted file-system access and enabled network access is reported as unsandboxed. Even though the profile is in the “managed” shape, its permissions do not actually restrict much.

**Data flow**: The test builds a managed profile whose file-system permissions are unrestricted and whose network policy is enabled. It asks for the sandbox tag with managed-network enforcement turned off. The expected output is "none".

**Call relations**: The test uses an assertion to lock down how broad managed permissions should be reported. It prevents the tag logic from treating the word “managed” alone as proof that a sandbox is active.

*Call graph*: 1 external calls (assert_eq!).


##### `root_write_managed_profile_with_enabled_network_is_untagged`  (lines 93–115)

```
fn root_write_managed_profile_with_enabled_network_is_untagged()
```

**Purpose**: Checks that a managed profile allowing write access to the root of the file system is still reported as unsandboxed when networking is enabled. Write access to root is effectively very broad access.

**Data flow**: The test builds a restricted-looking file-system policy, but the one entry grants write access to the special root path. It combines that with enabled networking and asks for the sandbox tag. The returned value must be "none".

**Call relations**: This test uses `vec!` to create the list of file-system permission entries and then verifies the final label with `assert_eq!`. It guards against a misleading result where a technically “restricted” profile would be tagged as sandboxed despite allowing root writes.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `managed_network_enforcement_tags_unrestricted_profiles_as_sandboxed`  (lines 118–135)

```
fn managed_network_enforcement_tags_unrestricted_profiles_as_sandboxed()
```

**Purpose**: Checks the special case where managed-network enforcement makes an otherwise unrestricted managed profile count as sandboxed. This matters because network enforcement can add a real safety boundary even when file access is broad.

**Data flow**: The test builds a managed profile with unrestricted file access and enabled network access. It asks the platform what sandbox tag should apply, falling back to "none" if no sandbox exists. Then it asks the sandbox-tag helper for the actual label with managed-network enforcement turned on and compares the two.

**Call relations**: The test uses `get_platform_sandbox` to define the expected platform-specific label and `assert_eq!` to compare it with the tag helper’s answer. It documents when enforcement changes the meaning of an otherwise unrestricted profile.

*Call graph*: 2 external calls (assert_eq!, get_platform_sandbox).


##### `profile_policy_tag_reports_closest_legacy_mode`  (lines 138–160)

```
fn profile_policy_tag_reports_closest_legacy_mode()
```

**Purpose**: Checks that a newer detailed permission profile can still be reported as the closest older policy name, here "workspace-write". This helps older metrics or displays keep working while the permission system becomes more detailed.

**Data flow**: The test first turns two absolute path strings into checked absolute paths: a current working directory and a writable workspace path. It builds a restricted file-system policy that allows writes only to that workspace path and combines it with restricted networking to make a permission profile. It then asks for the legacy-style policy tag and expects "workspace-write".

**Call relations**: This test uses `from_absolute_path` and `new` to create valid paths, `vec!` to package the writable entry, and `from_runtime_permissions` to build the profile. The final assertion verifies that `permission_profile_policy_tag` maps the detailed profile back to the expected older label.

*Call graph*: calls 2 internal fn (from_runtime_permissions, from_absolute_path); 3 external calls (new, assert_eq!, vec!).


### Runtime environment and realtime helpers
These tests cover filesystem and shell-facing helpers, AGENTS.md and personality migration behavior, Git metadata, and realtime context/conversation support.

### `core/src/agents_md_tests.rs`

`test` · `test run`

AGENTS.md files are project instruction files: they tell the agent how to behave in a repository or folder. This test file checks many edge cases around those files, like missing files, nested folders, multiple environments, size limits, invalid text, fallback names, symlinks, and optional feature flags. Without these tests, small changes could accidentally make the agent ignore important project guidance, read the wrong file, include too much text, or merge instructions in a confusing order.

The file builds temporary folders that act like small fake projects. It writes AGENTS.md files into those folders, creates fake repository markers such as .git, and then asks the real loading code to discover and combine instructions. It compares the result against the exact expected text, source list, and provenance, meaning where each instruction came from.

It also includes a fake file system, FailingFileSystem, used to inject read or metadata failures. That lets the tests confirm which errors are reported and which ones are safely ignored, such as a file disappearing after discovery. TestConfig is a small wrapper around the normal configuration so tests can easily add optional global user instructions.

#### Function details

##### `FailingFileSystem::canonicalize`  (lines 128–134)

```
fn canonicalize(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, PathUri>
```

**Purpose**: This fake file-system method exists only to satisfy the file-system interface. The tests in this file should never ask the fake file system to canonicalize, meaning turn a path into its final normalized form.

**Data flow**: It receives a path and optional sandbox information, but it does not use them. If called, it immediately fails the test by marking that path as unreachable.

**Call relations**: It is part of the fake file system used by error-path tests. The trait wrapper boxes this async method, but the intended test flow never reaches it.

*Call graph*: 2 external calls (pin, unreachable!).


##### `FailingFileSystem::read_file`  (lines 136–142)

```
fn read_file(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<u8>>
```

**Purpose**: This fake read operation either returns an injected read error for one chosen path or delegates to the real local file system. It lets tests simulate permission failures or disappearing files without changing the production loader.

**Data flow**: It receives a path and optional sandbox information. If the path matches the configured failing path and the chosen failure is a read failure, it returns that error; otherwise it reads the file normally through the local file system.

**Call relations**: The AGENTS.md loading code calls this when reading discovered instruction files. Tests such as read_agents_md_propagates_read_errors and read_agents_md_ignores_files_removed_after_discovery rely on this behavior to check how read failures are handled.

*Call graph*: calls 1 internal fn (to_abs_path); 2 external calls (pin, new).


##### `FailingFileSystem::read_file_stream`  (lines 144–155)

```
fn read_file_stream(
        &'a self,
        _path: &'a PathUri,
        _sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileSystemReadStream>
```

**Purpose**: This reports that the fake file system does not support streaming reads. Streaming reads are chunk-by-chunk reads, which these tests do not need.

**Data flow**: It receives a path and optional sandbox information, ignores both, and returns an Unsupported error.

**Call relations**: It completes the file-system interface for the fake implementation. The AGENTS.md tests use normal full-file reads, so this is only a defensive placeholder.

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

**Purpose**: This fake write operation exists only to satisfy the file-system interface. These tests never expect AGENTS.md loading to write files.

**Data flow**: It receives a path, file contents, and optional sandbox information, but uses none of them. If called, it marks the path as unreachable and fails the test.

**Call relations**: It guards against accidental writes during instruction loading. If production code started writing through this path, these tests would catch it.

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

**Purpose**: This fake directory-creation operation exists only because the file-system interface requires it. AGENTS.md loading should not create directories.

**Data flow**: It receives a path, directory options, and optional sandbox information, but ignores them and fails if called.

**Call relations**: It is part of the fake file-system implementation. Its unreachable behavior helps prove the loader only reads and checks metadata.

*Call graph*: 2 external calls (pin, unreachable!).


##### `FailingFileSystem::get_metadata`  (lines 177–183)

```
fn get_metadata(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, FileMetadata>
```

**Purpose**: This fake metadata lookup either returns an injected metadata error for one chosen path or delegates to the real local file system. Metadata means basic facts about a file, such as whether it exists and whether it is a regular file.

**Data flow**: It receives a path and optional sandbox information. If the path matches the configured failing path and the chosen failure is a metadata failure, it returns that error; otherwise it asks the local file system for metadata.

**Call relations**: The AGENTS.md discovery code calls this while deciding which files and project markers exist. The read_agents_md_propagates_metadata_errors test uses it to make sure important metadata errors are not silently swallowed.

*Call graph*: calls 1 internal fn (to_abs_path); 2 external calls (pin, new).


##### `FailingFileSystem::read_directory`  (lines 185–191)

```
fn read_directory(
        &'a self,
        path: &'a PathUri,
        sandbox: Option<&'a FileSystemSandboxContext>,
    ) -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>>
```

**Purpose**: This fake directory-read operation exists only to satisfy the interface. The tested AGENTS.md path should not list directory contents through this fake file system.

**Data flow**: It receives a path and optional sandbox information, ignores them, and fails if called.

**Call relations**: It is a guardrail inside the fake file system. If loading behavior changed to scan directories here, the test would reveal that unexpected call.

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

**Purpose**: This fake remove operation exists only to satisfy the interface. AGENTS.md loading should not delete files.

**Data flow**: It receives a path, removal options, and optional sandbox information, but ignores them and fails if called.

**Call relations**: It protects the read-only expectation of the instruction loader during tests.

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

**Purpose**: This fake copy operation exists only to satisfy the interface. Reading project instructions should never copy files.

**Data flow**: It receives source and destination paths, copy options, and optional sandbox information. It does not use them and fails if called.

**Call relations**: It is part of the fake file-system contract and acts as a tripwire for unexpected file-copy behavior.

*Call graph*: 2 external calls (pin, unreachable!).


##### `TestConfig::deref`  (lines 227–229)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: This lets a TestConfig be used like a normal Config when only read access is needed. It keeps test code short and focused on the behavior being tested.

**Data flow**: It receives a TestConfig reference and returns a reference to the inner Config.

**Call relations**: Helper and test functions can pass or inspect TestConfig as though it were Config, while still carrying optional user instructions alongside it.


##### `TestConfig::deref_mut`  (lines 233–235)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: This lets tests modify the inner Config directly through a TestConfig. It is used when a test needs to change fields such as the current working directory or feature flags.

**Data flow**: It receives a mutable TestConfig reference and returns a mutable reference to the inner Config.

**Call relations**: Tests use this convenience when adjusting setup after make_config creates a baseline configuration.


##### `get_user_instructions`  (lines 238–240)

```
async fn get_user_instructions(config: &TestConfig) -> Option<String>
```

**Purpose**: This helper loads AGENTS.md-related instructions and returns only the final combined text. It is used by tests that care about the visible instruction string rather than detailed provenance.

**Data flow**: It takes a TestConfig, calls load_agents_md, and if something was loaded, converts it to plain text. The result is either Some text or None when there are no instructions.

**Call relations**: Many tests call this as their main doorway into the loader. It delegates the real setup to load_agents_md, then simplifies the result for text-focused assertions.

*Call graph*: calls 1 internal fn (load_agents_md); called by 18 (agents_local_md_preferred, agents_md_directory_is_ignored, agents_md_paths_preserve_symlinked_cwd, agents_md_preferred_over_fallbacks, agents_md_special_file_is_ignored, apps_feature_does_not_append_to_agents_md_user_instructions, apps_feature_does_not_emit_user_instructions_by_itself, doc_larger_than_limit_is_truncated, doc_smaller_than_limit_is_returned, finds_doc_in_repo_root (+8 more)).


##### `load_agents_md`  (lines 242–251)

```
async fn load_agents_md(config: &TestConfig) -> Option<LoadedAgentsMd>
```

**Purpose**: This helper runs the real project-instruction loader for a single local environment. It returns the structured LoadedAgentsMd value so tests can inspect text, sources, and provenance.

**Data flow**: It takes a TestConfig, builds a local environment snapshot from the config current working directory, then calls the production load_project_instructions function with the config and optional user instructions.

**Call relations**: get_user_instructions calls it for simpler checks, while deeper tests call it directly when they need to compare LoadedAgentsMd entries or source paths.

*Call graph*: calls 1 internal fn (resolved_local_environments); called by 7 (child_agents_message_after_global_instructions_uses_plain_separator, child_agents_message_after_project_docs_is_not_an_instruction_source, concatenates_root_and_cwd_docs, get_user_instructions, instruction_sources_include_global_before_agents_md_docs, project_doc_invalid_utf8_uses_lossy_text, total_byte_limit_truncates_later_project_docs).


##### `agents_md_paths`  (lines 253–255)

```
async fn agents_md_paths(config: &TestConfig) -> std::io::Result<Vec<AbsolutePathBuf>>
```

**Purpose**: This helper asks the production discovery code which instruction files it would read. It is used by tests that verify path selection separately from file contents.

**Data flow**: It takes a TestConfig, passes its config and current working directory to the real agents_md_paths function, and uses the local file system. It returns either discovered absolute paths or an I/O error.

**Call relations**: Discovery-focused tests call this to confirm rules like override preference, fallback names, ignored directories, and symlink preservation.

*Call graph*: called by 8 (agents_local_md_preferred, agents_md_directory_is_ignored, agents_md_paths_preserve_symlinked_cwd, agents_md_preferred_over_fallbacks, agents_md_special_file_is_ignored, override_directory_falls_back_to_agents_md_file, project_layers_do_not_override_project_root_markers, project_root_markers_are_honored_for_agents_discovery); 1 external calls (agents_md_paths).


##### `resolved_local_environments`  (lines 257–276)

```
fn resolved_local_environments(
    environments: [(&str, AbsolutePathBuf); N],
) -> TurnEnvironmentSnapshot
```

**Purpose**: This helper builds a snapshot of one or more local environments for tests. An environment here means a named place where commands and files are rooted.

**Data flow**: It receives pairs of environment names and current working directories. It turns each pair into a TurnEnvironment using a test local execution environment and returns them as a TurnEnvironmentSnapshot.

**Call relations**: load_agents_md uses it for the common single-environment case. Multi-environment tests call it directly to check how instructions are labeled and ordered across environments.

*Call graph*: called by 8 (child_agents_guidance_is_appended_once_after_environment_groups, load_agents_md, multiple_environment_docs_use_labeled_layout_and_preserve_source_order, multiple_environments_can_exceed_single_environment_project_doc_limit, primary_only_project_doc_preserves_legacy_layout_with_multiple_bound_environments, project_doc_byte_limit_is_applied_independently_per_environment, secondary_environment_invalid_utf8_does_not_suppress_other_docs, secondary_only_project_doc_uses_single_contributor_layout); 1 external calls (into_iter).


##### `project_provenance`  (lines 278–284)

```
fn project_provenance(path: AbsolutePathBuf, cwd: AbsolutePathBuf) -> InstructionProvenance
```

**Purpose**: This helper creates the expected provenance record for a project instruction file. Provenance means the explanation of where a piece of instruction text came from.

**Data flow**: It receives the instruction file path and the working directory, then returns an InstructionProvenance::Project value with the fixed test environment id local.

**Call relations**: Tests that compare full LoadedAgentsMd structures use it to build the expected entries in the same shape as the production loader.


##### `make_config`  (lines 291–310)

```
async fn make_config(root: &TempDir, limit: usize, instructions: Option<&str>) -> TestConfig
```

**Purpose**: This helper creates a normal Config tailored for a temporary test project. It also optionally attaches global user instructions, like a user-level AGENTS.md file.

**Data flow**: It receives a temporary project root, a maximum byte limit for project documents, and optional instruction text. It builds a config with a temporary Codex home, sets cwd and project_doc_max_bytes, and returns TestConfig with optional UserInstructions.

**Call relations**: Most tests call this to avoid repeating setup. More specialized helpers build on it when they need fallback filenames or custom project-root markers.

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

**Purpose**: This helper creates a test config that knows extra fallback filenames to try when AGENTS.md is missing. It is used to test configurable alternative instruction file names.

**Data flow**: It starts with make_config, then replaces the config list of fallback project-document filenames with the provided names. It returns the updated TestConfig.

**Call relations**: Fallback-specific tests call this before using get_user_instructions or agents_md_paths to confirm fallback selection rules.

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

**Purpose**: This helper creates a config with custom project-root markers, such as .codex-root. A project-root marker is a file or directory that tells discovery where the top of a project is.

**Data flow**: It receives a temporary root, byte limit, optional instructions, and marker names. It builds a config with command-line-style overrides for project_root_markers, sets cwd and byte limit, and returns TestConfig.

**Call relations**: The project_root_markers_are_honored_for_agents_discovery test uses it to prove custom markers affect AGENTS.md discovery.

*Call graph*: called by 1 (project_root_markers_are_honored_for_agents_discovery); 4 external calls (abs, new, default, vec!).


##### `no_doc_file_returns_none`  (lines 363–374)

```
async fn no_doc_file_returns_none()
```

**Purpose**: This test proves that when there is no AGENTS.md file and no global instructions, the loader returns nothing. That avoids inventing empty instruction text.

**Data flow**: It creates an empty temporary directory, builds a config with no user instructions, asks for user instructions, and checks the result is None.

**Call relations**: The test runner calls this directly. It uses make_config and get_user_instructions to exercise the normal loading path.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 2 external calls (assert!, tempdir).


##### `empty_loaded_instructions_are_empty`  (lines 377–397)

```
fn empty_loaded_instructions_are_empty()
```

**Purpose**: This test checks that blank or whitespace-only loaded instructions are treated as empty. That keeps meaningless instruction blocks from being sent to the agent.

**Data flow**: It creates loaded-instruction values from empty strings and whitespace strings, then compares each with the default empty value.

**Call relations**: It directly tests constructors on LoadedAgentsMd rather than using the file loader.

*Call graph*: calls 1 internal fn (from_absolute_path); 1 external calls (assert_eq!).


##### `loaded_instructions_with_only_empty_or_whitespace_entries_are_empty`  (lines 400–418)

```
fn loaded_instructions_with_only_empty_or_whitespace_entries_are_empty()
```

**Purpose**: This test checks that entries containing only empty or whitespace text do not make a LoadedAgentsMd value count as meaningful. This matters when internal or project entries are present but contain no real guidance.

**Data flow**: It builds two LoadedAgentsMd values with one empty or whitespace entry, then checks is_empty returns true for both.

**Call relations**: The test runner calls it directly. It focuses on the loaded-instruction data structure rather than file discovery.

*Call graph*: 2 external calls (assert!, vec!).


##### `doc_smaller_than_limit_is_returned`  (lines 422–435)

```
async fn doc_smaller_than_limit_is_returned()
```

**Purpose**: This test proves a normal small AGENTS.md file is returned unchanged. It protects the basic happy path.

**Data flow**: It writes hello world into AGENTS.md, builds a config with a large byte limit, loads instructions, and checks the text exactly matches the file contents.

**Call relations**: It uses make_config and get_user_instructions to go through the standard loading path.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `project_doc_invalid_utf8_uses_lossy_text`  (lines 438–447)

```
async fn project_doc_invalid_utf8_uses_lossy_text()
```

**Purpose**: This test checks that invalid UTF-8 bytes in a project document do not make loading fail. UTF-8 is the usual text encoding; lossy text replaces invalid bytes with the replacement character.

**Data flow**: It writes bytes containing an invalid byte to AGENTS.md, loads the structured instructions, and checks the invalid byte became the replacement character.

**Call relations**: It calls load_agents_md directly because it wants the loaded object before checking its final text.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `doc_larger_than_limit_is_truncated`  (lines 451–464)

```
async fn doc_larger_than_limit_is_truncated()
```

**Purpose**: This test proves oversized AGENTS.md content is cut down to the configured byte limit. That prevents project instructions from growing without bound.

**Data flow**: It writes a file twice the configured limit, loads instructions, and checks the result length and contents equal only the allowed prefix.

**Call relations**: It uses make_config to set the limit and get_user_instructions to read the final text.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `total_byte_limit_truncates_later_project_docs`  (lines 467–498)

```
async fn total_byte_limit_truncates_later_project_docs()
```

**Purpose**: This test checks that when multiple AGENTS.md files are found in one environment, the total per-environment byte budget is shared from root to leaf. Later documents are truncated if earlier ones already used part of the budget.

**Data flow**: It creates a fake repo root with one AGENTS.md and a nested folder with another, sets a seven-byte limit, loads instructions from the nested folder, and compares the structured entries and combined text.

**Call relations**: It calls load_agents_md directly so it can verify both the root and nested entries and their provenance.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 5 external calls (assert_eq!, create_dir, write, tempdir, vec!).


##### `read_agents_md_propagates_metadata_errors`  (lines 501–516)

```
async fn read_agents_md_propagates_metadata_errors()
```

**Purpose**: This test confirms that important metadata errors are returned to the caller instead of hidden. For example, permission denied while checking a marker should be visible.

**Data flow**: It builds a config, creates a FailingFileSystem that fails metadata lookup for a .git marker path, calls read_agents_md, and checks the returned error kind.

**Call relations**: It uses make_config for setup and FailingFileSystem::get_metadata to inject the failure into the production read path.

*Call graph*: calls 1 internal fn (make_config); 3 external calls (assert_eq!, Metadata, tempdir).


##### `read_agents_md_propagates_read_errors`  (lines 519–534)

```
async fn read_agents_md_propagates_read_errors()
```

**Purpose**: This test confirms that serious read errors while opening AGENTS.md are reported. Permission denied should not look like a missing file.

**Data flow**: It writes an AGENTS.md file, configures FailingFileSystem to fail reads for that file with PermissionDenied, calls read_agents_md, and checks the error kind.

**Call relations**: It uses the fake file system to force the production read code down an error path.

*Call graph*: calls 1 internal fn (make_config); 4 external calls (assert_eq!, Read, write, tempdir).


##### `read_agents_md_ignores_files_removed_after_discovery`  (lines 537–552)

```
async fn read_agents_md_ignores_files_removed_after_discovery()
```

**Purpose**: This test checks a race-like case where AGENTS.md existed during discovery but disappeared before reading. The loader should treat that as recoverable instead of failing.

**Data flow**: It writes AGENTS.md, configures FailingFileSystem to return NotFound when reading it, calls read_agents_md, and checks the result is None.

**Call relations**: It relies on FailingFileSystem::read_file to mimic a file being removed after discovery.

*Call graph*: calls 1 internal fn (make_config); 4 external calls (assert_eq!, Read, write, tempdir).


##### `finds_doc_in_repo_root`  (lines 557–580)

```
async fn finds_doc_in_repo_root()
```

**Purpose**: This test proves that when the current folder is nested inside a repository, the loader finds AGENTS.md at the repository root. The repository root is recognized by a .git marker.

**Data flow**: It creates a fake repo with .git and root AGENTS.md, points the config cwd at a nested folder, loads instructions, and checks the root document text is returned.

**Call relations**: It uses make_config and get_user_instructions to exercise normal discovery from a nested working directory.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 5 external calls (assert_eq!, write, create_dir_all, write, tempdir).


##### `zero_byte_limit_disables_docs`  (lines 584–594)

```
async fn zero_byte_limit_disables_docs()
```

**Purpose**: This test proves setting the project document byte limit to zero disables project AGENTS.md loading. That gives configuration a clear off switch.

**Data flow**: It writes AGENTS.md, builds a config with limit zero, loads instructions, and checks the result is None.

**Call relations**: It uses get_user_instructions to observe the final user-facing behavior.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 3 external calls (assert!, write, tempdir).


##### `merges_existing_instructions_with_agents_md`  (lines 599–612)

```
async fn merges_existing_instructions_with_agents_md()
```

**Purpose**: This test checks that global user instructions and project AGENTS.md text are combined in the right order. The global text comes first, followed by a separator and the project text.

**Data flow**: It writes a project AGENTS.md, creates config with base instructions, loads the final text, and compares it to the expected joined string.

**Call relations**: It uses make_config to attach user instructions and get_user_instructions to test the merge result.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 4 external calls (assert_eq!, format!, write, tempdir).


##### `multiple_environment_docs_use_labeled_layout_and_preserve_source_order`  (lines 615–675)

```
async fn multiple_environment_docs_use_labeled_layout_and_preserve_source_order()
```

**Purpose**: This test checks how instructions are displayed when more than one environment contributes documents. The output labels each environment so the agent can tell which root each instruction belongs to.

**Data flow**: It creates primary and secondary projects, writes several AGENTS.md files, builds two environments, loads instructions, and checks labeled text, rendered text, and source order.

**Call relations**: It calls resolved_local_environments directly and then the production load_project_instructions function to test the multi-environment path.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 5 external calls (assert_eq!, format!, create_dir, write, tempdir).


##### `secondary_only_project_doc_uses_single_contributor_layout`  (lines 678–701)

```
async fn secondary_only_project_doc_uses_single_contributor_layout()
```

**Purpose**: This test checks that if only one environment actually contributes a project document, the loader keeps the simpler legacy layout. Even if multiple environments exist, the output does not need labels when there is only one project contributor.

**Data flow**: It creates two environments but writes AGENTS.md only in the secondary one, adds global instructions, loads instructions, and checks legacy text and render format.

**Call relations**: It uses resolved_local_environments to create the multi-environment setup and production loading to verify layout selection.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 4 external calls (assert_eq!, format!, write, tempdir).


##### `primary_only_project_doc_preserves_legacy_layout_with_multiple_bound_environments`  (lines 704–727)

```
async fn primary_only_project_doc_preserves_legacy_layout_with_multiple_bound_environments()
```

**Purpose**: This test mirrors the secondary-only case for the primary environment. It proves multiple bound environments alone do not force labeled output.

**Data flow**: It writes AGENTS.md only in the primary project, creates primary and secondary environments, loads instructions with global text, and checks the legacy combined layout.

**Call relations**: It calls resolved_local_environments and load_project_instructions to test formatting decisions.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 4 external calls (assert_eq!, format!, write, tempdir).


##### `project_doc_byte_limit_is_applied_independently_per_environment`  (lines 730–754)

```
async fn project_doc_byte_limit_is_applied_independently_per_environment()
```

**Purpose**: This test proves each environment gets its own project-document byte limit. One environment's document should not consume another environment's allowance.

**Data flow**: It writes five-character AGENTS.md files in two environments, sets a three-byte limit, loads instructions, and checks each environment contributes its first three characters.

**Call relations**: It uses resolved_local_environments and production loading to verify per-environment truncation.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 3 external calls (assert_eq!, write, tempdir).


##### `multiple_environments_can_exceed_single_environment_project_doc_limit`  (lines 757–791)

```
async fn multiple_environments_can_exceed_single_environment_project_doc_limit()
```

**Purpose**: This test documents the current behavior that combined instructions from multiple environments may exceed the single-environment byte limit. The comment notes this may change if an aggregate cap is added later.

**Data flow**: It writes one full-limit document in each of two environments, loads instructions, sums the bytes from project entries, and checks the sum is twice the limit and appears in the output.

**Call relations**: It uses resolved_local_environments and load_project_instructions to make the current multi-environment budget behavior explicit.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `secondary_environment_invalid_utf8_does_not_suppress_other_docs`  (lines 794–815)

```
async fn secondary_environment_invalid_utf8_does_not_suppress_other_docs()
```

**Purpose**: This test checks that invalid text in one environment does not prevent other environment documents from loading. Bad bytes are converted, not fatal.

**Data flow**: It writes a normal primary AGENTS.md and a secondary AGENTS.md with an invalid byte, loads instructions from both environments, and checks both texts appear with replacement for the invalid byte.

**Call relations**: It uses resolved_local_environments and production loading to test resilience across environments.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 3 external calls (assert!, write, tempdir).


##### `child_agents_guidance_is_appended_once_after_environment_groups`  (lines 818–841)

```
async fn child_agents_guidance_is_appended_once_after_environment_groups()
```

**Purpose**: This test checks that when the child-agents feature is enabled, the extra hierarchical AGENTS.md guidance is appended exactly once. It should appear after all environment-specific instruction groups.

**Data flow**: It writes AGENTS.md in two environments, enables the ChildAgentsMd feature, loads instructions, and checks the special guidance appears once at the end.

**Call relations**: It uses make_config, resolved_local_environments, and load_project_instructions to test feature-flag behavior in multi-environment output.

*Call graph*: calls 2 internal fn (make_config, resolved_local_environments); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `keeps_existing_instructions_when_doc_missing`  (lines 846–854)

```
async fn keeps_existing_instructions_when_doc_missing()
```

**Purpose**: This test proves global instructions are preserved when no AGENTS.md file exists. Missing project docs should not erase user-provided guidance.

**Data flow**: It creates an empty project, builds config with global instructions, loads final text, and checks it equals the original instructions.

**Call relations**: It uses make_config and get_user_instructions to exercise the common no-project-doc path.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 2 external calls (assert_eq!, tempdir).


##### `concatenates_root_and_cwd_docs`  (lines 859–903)

```
async fn concatenates_root_and_cwd_docs()
```

**Purpose**: This test checks that when both the repository root and current working directory have AGENTS.md files, both are included from root to current directory. This lets broad rules come before folder-specific rules.

**Data flow**: It creates a fake git repo with root AGENTS.md, creates a nested folder with its own AGENTS.md, loads structured instructions, and checks entries, text, and sources.

**Call relations**: It calls load_agents_md directly to verify provenance and source ordering, not just final text.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 6 external calls (assert_eq!, write, create_dir_all, write, tempdir, vec!).


##### `project_root_markers_are_honored_for_agents_discovery`  (lines 906–933)

```
async fn project_root_markers_are_honored_for_agents_discovery()
```

**Purpose**: This test proves configured project-root markers affect where discovery starts and stops. A custom marker can make a parent directory the project root even if a nested .git exists.

**Data flow**: It creates a parent marker and AGENTS.md, creates a nested directory with .git and another AGENTS.md, configures .codex-root as the marker, then checks discovered paths and combined text.

**Call relations**: It uses make_config_with_project_root_markers, agents_md_paths, and get_user_instructions to check both discovery and final loading.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config_with_project_root_markers); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `project_layers_do_not_override_project_root_markers`  (lines 936–978)

```
async fn project_layers_do_not_override_project_root_markers()
```

**Purpose**: This test checks that project-level config layers do not change the project-root markers used for AGENTS.md discovery. That prevents local project config from moving the root out from under the discovery process.

**Data flow**: It creates root and nested AGENTS.md files, adds project config layers that try to set ignored markers, runs discovery, and checks the normal .git-based root-to-nested paths are still used.

**Call relations**: It uses make_config for baseline setup and agents_md_paths to inspect discovery behavior directly.

*Call graph*: calls 3 internal fn (new, agents_md_paths, make_config); 7 external calls (default, assert_eq!, default, create_dir, write, tempdir, vec!).


##### `agents_md_paths_preserve_symlinked_cwd`  (lines 981–998)

```
async fn agents_md_paths_preserve_symlinked_cwd()
```

**Purpose**: This test proves discovery preserves a symlinked current working directory path instead of silently replacing it with the real target path. That matters because users may expect paths to match what they entered.

**Data flow**: It creates a target directory with AGENTS.md, creates a symlink to it, sets cwd to the symlink path, runs discovery, and checks the discovered path uses the symlink. It also checks the file still loads.

**Call relations**: It uses agents_md_paths for path inspection and get_user_instructions for the final read.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config); 5 external calls (assert_eq!, create_directory_symlink, create_dir, write, tempdir).


##### `child_agents_message_after_global_instructions_uses_plain_separator`  (lines 1001–1024)

```
async fn child_agents_message_after_global_instructions_uses_plain_separator()
```

**Purpose**: This test checks the child-agents guidance formatting when only global instructions exist. The special message should be appended with a plain blank-line separator.

**Data flow**: It creates config with global instructions, enables the ChildAgentsMd feature, loads instructions, and compares the full LoadedAgentsMd value and text.

**Call relations**: It calls load_agents_md directly because it verifies internal entries and provenance as well as text.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 3 external calls (assert_eq!, tempdir, vec!).


##### `instruction_sources_include_global_before_agents_md_docs`  (lines 1027–1059)

```
async fn instruction_sources_include_global_before_agents_md_docs()
```

**Purpose**: This test proves source tracking lists global instructions before project AGENTS.md files. Source tracking is important for showing users where instruction text came from.

**Data flow**: It writes project AGENTS.md and a global AGENTS.md source file, loads instructions, and checks the loaded structure, user instructions reference, source order, and combined text.

**Call relations**: It uses make_config and load_agents_md to verify both content merging and source reporting.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 5 external calls (assert_eq!, create_dir_all, write, tempdir, vec!).


##### `child_agents_message_after_project_docs_is_not_an_instruction_source`  (lines 1062–1100)

```
async fn child_agents_message_after_project_docs_is_not_an_instruction_source()
```

**Purpose**: This test checks that the internal child-agents guidance is included in text but not reported as a file source. Only real user or project files should appear in the source list.

**Data flow**: It writes global and project instructions, enables ChildAgentsMd, loads instructions, and checks the internal message is present while sources include only the global and project files.

**Call relations**: It calls load_agents_md directly to compare entries, sources, and final text.

*Call graph*: calls 2 internal fn (load_agents_md, make_config); 5 external calls (assert_eq!, create_dir_all, write, tempdir, vec!).


##### `agents_local_md_preferred`  (lines 1104–1123)

```
async fn agents_local_md_preferred()
```

**Purpose**: This test proves the local override instruction file is preferred over the default AGENTS.md when both exist. This allows unversioned or local guidance to take precedence.

**Data flow**: It writes both the default and local override files, loads instructions, checks the local text is used, and checks discovery found only the local override filename.

**Call relations**: It uses get_user_instructions for final behavior and agents_md_paths for discovery behavior.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `uses_configured_fallback_when_agents_missing`  (lines 1127–1144)

```
async fn uses_configured_fallback_when_agents_missing()
```

**Purpose**: This test checks that a configured fallback file is used when AGENTS.md is absent. This supports projects that store instructions under another chosen name.

**Data flow**: It writes EXAMPLE.md, configures that name as a fallback, loads instructions, and checks the fallback text is returned.

**Call relations**: It uses make_config_with_fallback to set the fallback list and get_user_instructions to verify loading.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config_with_fallback); 3 external calls (assert_eq!, write, tempdir).


##### `agents_md_preferred_over_fallbacks`  (lines 1148–1176)

```
async fn agents_md_preferred_over_fallbacks()
```

**Purpose**: This test proves AGENTS.md still wins when both the default file and fallback files exist. Fallbacks are only backups, not higher-priority files.

**Data flow**: It writes AGENTS.md and fallback files, configures fallback names, loads instructions, and checks the AGENTS.md text and discovered filename.

**Call relations**: It uses make_config_with_fallback, get_user_instructions, and agents_md_paths to test both content and discovery priority.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config_with_fallback); 4 external calls (assert!, assert_eq!, write, tempdir).


##### `agents_md_directory_is_ignored`  (lines 1179–1190)

```
async fn agents_md_directory_is_ignored()
```

**Purpose**: This test checks that a directory named AGENTS.md is ignored. The loader should read regular files, not directories.

**Data flow**: It creates a directory called AGENTS.md, loads instructions, and checks no text or discovered paths are returned.

**Call relations**: It uses get_user_instructions and agents_md_paths to verify both loading and discovery ignore the directory.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config); 3 external calls (assert_eq!, create_dir, tempdir).


##### `agents_md_special_file_is_ignored`  (lines 1194–1213)

```
async fn agents_md_special_file_is_ignored()
```

**Purpose**: This Unix-only test checks that a special file named AGENTS.md, such as a FIFO pipe, is ignored. This avoids blocking or unsafe reads from non-regular files.

**Data flow**: It creates a FIFO named AGENTS.md, loads instructions, and checks no text or discovered paths are returned.

**Call relations**: It uses platform-specific setup, then the same get_user_instructions and agents_md_paths helpers as other discovery tests.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config); 4 external calls (new, assert_eq!, mkfifo, tempdir).


##### `override_directory_falls_back_to_agents_md_file`  (lines 1216–1237)

```
async fn override_directory_falls_back_to_agents_md_file()
```

**Purpose**: This test checks that if the local override name exists but is a directory, the loader falls back to the normal AGENTS.md file. An invalid override should not hide a valid default file.

**Data flow**: It creates a directory with the override filename, writes a normal AGENTS.md file, loads instructions, and checks the default file text and discovery result.

**Call relations**: It uses get_user_instructions and agents_md_paths to confirm priority rules with invalid candidates.

*Call graph*: calls 3 internal fn (agents_md_paths, get_user_instructions, make_config); 4 external calls (assert_eq!, create_dir, write, tempdir).


##### `skills_are_not_appended_to_agents_md`  (lines 1240–1255)

```
async fn skills_are_not_appended_to_agents_md()
```

**Purpose**: This test proves installed skills are not automatically appended to AGENTS.md instructions. Skills are a separate feature and should not change project instruction text by accident.

**Data flow**: It writes AGENTS.md, creates a fake skill under the Codex home directory, loads instructions, and checks only the AGENTS.md text is returned.

**Call relations**: It calls create_skill for setup, then uses get_user_instructions to confirm the loader ignores skills.

*Call graph*: calls 3 internal fn (create_skill, get_user_instructions, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `apps_feature_does_not_emit_user_instructions_by_itself`  (lines 1258–1267)

```
async fn apps_feature_does_not_emit_user_instructions_by_itself()
```

**Purpose**: This test checks that enabling the Apps feature does not create instructions when no instruction files exist. A feature flag alone should not add hidden user guidance.

**Data flow**: It builds a config with no AGENTS.md, enables the Apps feature, loads instructions, and checks the result is None.

**Call relations**: It uses make_config and get_user_instructions to test feature-flag behavior in the empty case.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 2 external calls (assert_eq!, tempdir).


##### `apps_feature_does_not_append_to_agents_md_user_instructions`  (lines 1270–1283)

```
async fn apps_feature_does_not_append_to_agents_md_user_instructions()
```

**Purpose**: This test checks that enabling the Apps feature does not append extra text to AGENTS.md instructions. Existing project guidance should remain unchanged.

**Data flow**: It writes AGENTS.md, enables the Apps feature, loads instructions, and checks the text is exactly the file contents.

**Call relations**: It uses make_config and get_user_instructions to test feature-flag behavior with an existing project document.

*Call graph*: calls 2 internal fn (get_user_instructions, make_config); 3 external calls (assert_eq!, write, tempdir).


##### `create_skill`  (lines 1285–1290)

```
fn create_skill(codex_home: PathBuf, name: &str, description: &str)
```

**Purpose**: This helper creates a fake skill directory and SKILL.md file for tests. It lets a test confirm that skills do not affect AGENTS.md instruction loading.

**Data flow**: It receives a Codex home path, skill name, and description. It creates a skills/name directory, writes a small SKILL.md file with front matter and body text, and returns nothing.

**Call relations**: skills_are_not_appended_to_agents_md calls it during setup before loading instructions.

*Call graph*: called by 1 (skills_are_not_appended_to_agents_md); 4 external calls (join, format!, create_dir_all, write).


### `core/src/personality_migration_tests.rs`

`test` · `test run`

This is a test file, not production code. It builds small fake Codex home folders in temporary directories, adds just enough session history to look like a real user, runs the personality migration, and checks the result. The migration being tested is meant to give older users a default personality, `Pragmatic`, if they have used Codex before but have not already chosen a personality themselves.

The helper functions create realistic rollout files. A rollout file is a line-by-line JSON record of a session, like a simple diary where each line is one event. The tests write a session metadata line and a user-message line so the migration can detect that a real session exists.

The tests cover the important safety cases. If normal sessions exist, the migration applies. If only archived sessions exist, it still applies. If the migration marker file already exists, it skips work, like seeing a sticky note that says “already done.” If the user already set a personality, the migration preserves that choice. If there are no sessions, it does not create a config file just to add a personality. These checks matter because configuration migrations must be careful: they should help existing users without overwriting personal choices or repeatedly changing files.

#### Function details

##### `read_config_toml`  (lines 18–21)

```
async fn read_config_toml(codex_home: &Path) -> io::Result<ConfigToml>
```

**Purpose**: Reads the temporary `config.toml` file used by a test and turns it into a `ConfigToml` value. Tests use it to verify what the migration actually wrote to disk.

**Data flow**: It receives the path to a fake Codex home folder. It opens `config.toml` inside that folder, reads the text, parses the TOML text into a configuration object, and returns either that object or an input/output error if reading or parsing fails.

**Call relations**: The migration tests call this after setting up or running the migration so they can inspect the saved configuration. It relies on path joining, asynchronous file reading, and TOML parsing, then hands the parsed result back to the test assertions.

*Call graph*: called by 3 (applies_when_only_archived_sessions_exist_and_no_personality, applies_when_sessions_exist_and_no_personality, skips_when_personality_explicit); 3 external calls (join, read_to_string, from_str).


##### `write_session_with_user_event`  (lines 23–31)

```
async fn write_session_with_user_event(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Creates a fake active session in the normal sessions folder. This gives the migration evidence that the user has previous Codex activity.

**Data flow**: It receives the fake Codex home path, creates a new thread identifier, builds the normal dated sessions directory path, and passes that location plus the thread identifier to the lower-level rollout writer. Its output is success or an input/output error.

**Call relations**: The active-session migration test calls this during setup. This helper does not write the file itself; it delegates to `write_rollout_with_user_event`, which creates the actual JSON-lines rollout content.

*Call graph*: calls 2 internal fn (write_rollout_with_user_event, new); called by 1 (applies_when_sessions_exist_and_no_personality); 1 external calls (join).


##### `write_archived_session_with_user_event`  (lines 33–37)

```
async fn write_archived_session_with_user_event(codex_home: &Path) -> io::Result<()>
```

**Purpose**: Creates a fake archived session. This lets the tests prove that old archived activity still counts as prior use for the migration.

**Data flow**: It receives the fake Codex home path, creates a new thread identifier, chooses the archived sessions directory, and asks `write_rollout_with_user_event` to create the rollout file there. It returns success or an input/output error.

**Call relations**: The archived-session migration test calls this during setup. Like the active-session helper, it leaves the detailed file creation to `write_rollout_with_user_event` so both test paths create the same kind of session data.

*Call graph*: calls 2 internal fn (write_rollout_with_user_event, new); called by 1 (applies_when_only_archived_sessions_exist_and_no_personality); 1 external calls (join).


##### `write_rollout_with_user_event`  (lines 39–87)

```
async fn write_rollout_with_user_event(dir: &Path, thread_id: ThreadId) -> io::Result<()>
```

**Purpose**: Writes a minimal but realistic rollout file containing session metadata and one user message. This is the shared test fixture that makes the migration believe a real conversation happened.

**Data flow**: It receives a directory path and a thread identifier. It creates the directory, opens a rollout file named with the test timestamp and thread id, builds two records, converts each record to JSON, and writes them as separate lines. The first record describes the session; the second records a user saying `hello`. It returns success or an input/output error.

**Call relations**: `write_session_with_user_event` and `write_archived_session_with_user_event` both call this so their fake sessions have the same structure. It uses protocol data types such as session metadata and user-message events to produce rollout data that the real migration code can recognize.

*Call graph*: called by 2 (write_archived_session_with_user_event, write_session_with_user_event); 10 external calls (default, join, new, format!, UserMessage, EventMsg, SessionMeta, from, create, create_dir_all).


##### `applies_when_sessions_exist_and_no_personality`  (lines 90–103)

```
async fn applies_when_sessions_exist_and_no_personality() -> io::Result<()>
```

**Purpose**: Checks the main happy path: an existing user with normal session history and no chosen personality gets the default `Pragmatic` personality.

**Data flow**: The test creates a temporary Codex home, writes a fake active session into it, starts from an empty default configuration, and runs the personality migration. It then checks that the migration reports `Applied`, that the marker file exists, and that `config.toml` now contains `personality = Pragmatic`.

**Call relations**: The asynchronous test runner invokes this test. During setup it calls `write_session_with_user_event`; after migration it calls `read_config_toml` to inspect the saved file. Its assertions connect those helpers to the expected migration outcome.

*Call graph*: calls 2 internal fn (read_config_toml, write_session_with_user_event); 4 external calls (new, assert!, assert_eq!, default).


##### `applies_when_only_archived_sessions_exist_and_no_personality`  (lines 106–119)

```
async fn applies_when_only_archived_sessions_exist_and_no_personality() -> io::Result<()>
```

**Purpose**: Checks that archived session history is enough to trigger the migration. A user should not be missed just because their old sessions have been moved to the archive.

**Data flow**: The test creates a temporary Codex home, writes a fake archived session, uses a default configuration with no personality, and runs the migration. It expects the migration to apply, create its marker file, and persist `Pragmatic` in `config.toml`.

**Call relations**: The asynchronous test runner invokes this test. It uses `write_archived_session_with_user_event` to build the archive-only setup and `read_config_toml` to confirm what the migration wrote.

*Call graph*: calls 2 internal fn (read_config_toml, write_archived_session_with_user_event); 4 external calls (new, assert!, assert_eq!, default).


##### `skips_when_marker_exists`  (lines 122–132)

```
async fn skips_when_marker_exists() -> io::Result<()>
```

**Purpose**: Checks that the migration does nothing if its marker file is already present. This protects users from the same migration running repeatedly.

**Data flow**: The test creates a temporary Codex home, creates the migration marker file, starts with a default configuration, and runs the migration. It expects a `SkippedMarker` result and verifies that no `config.toml` file was created.

**Call relations**: The asynchronous test runner invokes this test. Its setup uses the marker-creation helper from the surrounding module, then the assertions verify that the migration stops early instead of writing configuration.

*Call graph*: 4 external calls (new, assert!, assert_eq!, default).


##### `skips_when_personality_explicit`  (lines 135–155)

```
async fn skips_when_personality_explicit() -> io::Result<()>
```

**Purpose**: Checks that the migration respects a personality the user already chose. The migration may mark itself complete, but it must not overwrite the user’s explicit setting.

**Data flow**: The test creates a temporary Codex home, writes a config with `Friendly` as the personality, reads that config back, and runs the migration. It expects `SkippedExplicitPersonality`, expects the marker file to exist, and confirms the saved personality is still `Friendly`.

**Call relations**: The asynchronous test runner invokes this test. It uses the config-editing builder to create the starting configuration and calls `read_config_toml` before and after migration so the assertions can prove the explicit setting was preserved.

*Call graph*: calls 2 internal fn (new, read_config_toml); 3 external calls (new, assert!, assert_eq!).


##### `skips_when_no_sessions`  (lines 158–167)

```
async fn skips_when_no_sessions() -> io::Result<()>
```

**Purpose**: Checks that the migration does not add a personality for a brand-new user with no session history. This avoids creating configuration for someone who has not actually used Codex before.

**Data flow**: The test creates an empty temporary Codex home and a default in-memory configuration, then runs the migration. It expects `SkippedNoSessions`, expects the marker file to be created, and verifies that no `config.toml` file exists.

**Call relations**: The asynchronous test runner invokes this test. It does not call the session-writing helpers, because the empty directory is the point of the test; its assertions confirm that the migration records completion without changing user configuration.

*Call graph*: 4 external calls (new, assert!, assert_eq!, default).


### `core/src/git_info_tests.rs`

`test` · `test suite`

This is a test file, not production code. Its job is to prove that the Git-related utilities behave correctly in common and awkward situations. The tests create throwaway folders, turn some of them into Git repositories, make commits, add remotes, create branches, and then ask the real utility functions what they see. This is like setting up miniature model train tracks to make sure the signals switch correctly before trusting them on the real railway.

The file checks several important promises. Outside a Git repository, the helpers should return empty or missing results instead of crashing. Inside a repository, they should find the current commit, branch name, and remote URL when available. They should tell the difference between a clean checkout and one with edited or new files. They should produce a diff against the remote branch, including local unpushed commits and untracked files. They also test linked Git worktrees, where one project checkout points back to a main repository, because trust decisions should be based on the main project root, not a side checkout path.

A small pair of helper functions builds reusable temporary repositories. Most tests then modify those repositories and check the imported Git utilities. The file also verifies that Git information serializes to JSON cleanly, omitting missing fields.

#### Function details

##### `create_test_git_repo`  (lines 22–77)

```
async fn create_test_git_repo(temp_dir: &TempDir) -> PathBuf
```

**Purpose**: Creates a temporary Git repository with one committed file, so other tests have a known starting point. This avoids relying on the developer’s real checkout or Git configuration.

**Data flow**: It receives a temporary directory. It creates a `repo` folder inside it, runs Git initialization, sets a local test user name and email, writes `test.txt`, stages it, commits it, and returns the path to the new repository.

**Call relations**: Many tests call this first when they need a real repository. The remote-repository helper builds on it, and the Git-info, change-detection, worktree, and trust-root tests all use its clean committed repo as their baseline.

*Call graph*: called by 12 (create_test_git_repo_with_remote, resolve_root_git_project_for_trust_detects_worktree_and_returns_main_root, resolve_root_git_project_for_trust_regular_repo_returns_repo_root, test_collect_git_info_detached_head, test_collect_git_info_git_repository, test_collect_git_info_with_branch, test_collect_git_info_with_remote, test_get_has_changes_clean_repo_returns_false, test_get_has_changes_ignores_configured_hooks_path, test_get_has_changes_with_tracked_change_returns_true (+2 more)); 5 external calls (path, new, create_dir, write, vec!).


##### `test_recent_commits_non_git_directory_returns_empty`  (lines 80–84)

```
async fn test_recent_commits_non_git_directory_returns_empty()
```

**Purpose**: Checks that asking for recent commits in an ordinary folder returns an empty list. This matters because callers should not have to treat non-Git folders as errors.

**Data flow**: It creates a temporary directory that is not initialized as Git. It calls `recent_commits` with that path and then checks that the returned list has no entries.

**Call relations**: This directly exercises `recent_commits` in the simplest failure-like case: there is no repository history to read, so the utility should quietly return nothing.

*Call graph*: 3 external calls (new, assert!, recent_commits).


##### `test_recent_commits_orders_and_limits`  (lines 87–152)

```
async fn test_recent_commits_orders_and_limits()
```

**Purpose**: Checks that recent commits are returned newest first and that the requested limit is respected. It also verifies that commit identifiers look like valid Git hashes.

**Data flow**: It builds a test repository, makes three new commits with short pauses so their times differ, asks for the latest three commits, and checks their subjects are ordered third, second, first. It also checks each returned short hash is hexadecimal and long enough to be useful.

**Call relations**: This test depends on `create_test_git_repo` for setup and then calls `recent_commits`. It is skipped in sandboxed environments because it shells out to Git and relies on timing.

*Call graph*: calls 1 internal fn (create_test_git_repo); 8 external calls (from_millis, new, assert!, assert_eq!, new, recent_commits, write, skip_if_sandbox!).


##### `create_test_git_repo_with_remote`  (lines 154–187)

```
async fn create_test_git_repo_with_remote(temp_dir: &TempDir) -> (PathBuf, String)
```

**Purpose**: Creates a temporary local repository plus a temporary bare remote repository, then connects and pushes the local branch. Tests use this when they need to compare local work against a remote branch.

**Data flow**: It receives a temporary directory, creates a normal test repository, creates a bare Git repository to act as `origin`, adds that remote, reads the current branch name, pushes the branch, and returns both the local repository path and branch name.

**Call relations**: The working-tree-state tests call this helper before using `git_diff_to_remote`. It hands them a repository that has a real upstream branch, which is needed for remote comparison.

*Call graph*: calls 1 internal fn (create_test_git_repo); called by 4 (test_get_git_working_tree_state_branch_fallback, test_get_git_working_tree_state_clean_repo, test_get_git_working_tree_state_unpushed_commit, test_get_git_working_tree_state_with_changes); 3 external calls (from_utf8, path, new).


##### `test_collect_git_info_non_git_directory`  (lines 190–194)

```
async fn test_collect_git_info_non_git_directory()
```

**Purpose**: Checks that Git metadata collection returns nothing for a folder that is not a Git repository. This prevents misleading information from being reported for unrelated directories.

**Data flow**: It creates a plain temporary directory, passes it to `collect_git_info`, and checks that the result is `None`, meaning no Git information was found.

**Call relations**: This is the negative baseline for `collect_git_info`: before testing real repositories, it proves the function does not invent Git data where none exists.

*Call graph*: 3 external calls (new, assert!, collect_git_info).


##### `test_collect_git_info_git_repository`  (lines 197–218)

```
async fn test_collect_git_info_git_repository()
```

**Purpose**: Checks that Git metadata collection works in a normal repository. It expects to find a full commit hash and a branch name.

**Data flow**: It creates a committed test repository, calls `collect_git_info`, unwraps the returned information, and checks that the commit hash is a 40-character hexadecimal Git SHA-1 value and that the branch is the usual `main` or `master`.

**Call relations**: This test uses `create_test_git_repo` for setup and then exercises `collect_git_info` in the ordinary happy path.

*Call graph*: calls 1 internal fn (create_test_git_repo); 4 external calls (new, assert!, assert_eq!, collect_git_info).


##### `test_collect_git_info_with_remote`  (lines 221–257)

```
async fn test_collect_git_info_with_remote()
```

**Purpose**: Checks that Git metadata collection includes the repository’s remote URL when an `origin` remote exists. This is important when the system needs to identify where a project came from.

**Data flow**: It creates a repository, adds an `origin` remote URL, asks `collect_git_info` for metadata, then asks Git itself what URL it reports and compares the two. This allows for development environments that rewrite remote URLs.

**Call relations**: It builds on `create_test_git_repo` and calls `collect_git_info`. The extra Git command provides the expected value, so the test follows Git’s actual configured behavior rather than a hard-coded assumption.

*Call graph*: calls 1 internal fn (create_test_git_repo); 5 external calls (from_utf8, new, assert_eq!, new, collect_git_info).


##### `test_collect_git_info_detached_head`  (lines 260–289)

```
async fn test_collect_git_info_detached_head()
```

**Purpose**: Checks behavior when the repository is in “detached HEAD” state, meaning it is checked out directly at a commit instead of on a named branch. The utility should still report the commit but not pretend there is a branch.

**Data flow**: It creates a repository, reads the current commit hash, checks out that commit directly, calls `collect_git_info`, and checks that a commit hash exists while the branch field is missing.

**Call relations**: This test uses `create_test_git_repo` for setup and then puts Git into a special state before calling `collect_git_info`. It protects callers from receiving the fake branch name `HEAD` as if it were a real branch.

*Call graph*: calls 1 internal fn (create_test_git_repo); 5 external calls (from_utf8, new, assert!, new, collect_git_info).


##### `test_collect_git_info_with_branch`  (lines 292–310)

```
async fn test_collect_git_info_with_branch()
```

**Purpose**: Checks that Git metadata collection reports the active branch name after switching to a new branch.

**Data flow**: It creates a repository, creates and checks out `feature-branch`, calls `collect_git_info`, and checks that the returned branch is exactly `feature-branch`.

**Call relations**: This is another normal-repository case for `collect_git_info`, using `create_test_git_repo` and then changing the repository state before reading metadata.

*Call graph*: calls 1 internal fn (create_test_git_repo); 4 external calls (new, assert_eq!, new, collect_git_info).


##### `test_get_has_changes_non_git_directory_returns_none`  (lines 313–316)

```
async fn test_get_has_changes_non_git_directory_returns_none()
```

**Purpose**: Checks that change detection returns `None` outside a Git repository. `None` means “this question does not apply here,” not “there are no changes.”

**Data flow**: It creates a plain temporary directory, asks `get_has_changes` whether it has Git changes, and checks that the answer is `None`.

**Call relations**: This is the non-repository baseline for `get_has_changes`, matching the pattern used by the Git-info tests.

*Call graph*: 2 external calls (new, assert_eq!).


##### `test_get_has_changes_clean_repo_returns_false`  (lines 319–323)

```
async fn test_get_has_changes_clean_repo_returns_false()
```

**Purpose**: Checks that a freshly committed repository is reported as clean. A clean repo has no edited tracked files and no untracked files that Git would notice.

**Data flow**: It creates a test repository with an initial commit, calls `get_has_changes`, and expects `Some(false)`, meaning Git is available and there are no changes.

**Call relations**: It uses `create_test_git_repo` to get a known clean state, then exercises the ordinary no-change path of `get_has_changes`.

*Call graph*: calls 1 internal fn (create_test_git_repo); 2 external calls (new, assert_eq!).


##### `test_get_has_changes_with_tracked_change_returns_true`  (lines 326–332)

```
async fn test_get_has_changes_with_tracked_change_returns_true()
```

**Purpose**: Checks that editing a file already tracked by Git is detected as a change.

**Data flow**: It creates a clean repository, overwrites the committed `test.txt` file, calls `get_has_changes`, and expects `Some(true)`.

**Call relations**: This test starts from `create_test_git_repo` and then changes a tracked file before calling `get_has_changes`, proving modified committed files are noticed.

*Call graph*: calls 1 internal fn (create_test_git_repo); 3 external calls (new, assert_eq!, write).


##### `test_get_has_changes_with_untracked_change_returns_true`  (lines 335–341)

```
async fn test_get_has_changes_with_untracked_change_returns_true()
```

**Purpose**: Checks that a brand-new file not yet added to Git is detected as a change. This matters because untracked files can affect the real working state of a project.

**Data flow**: It creates a clean repository, writes `new_file.txt` without staging it, calls `get_has_changes`, and expects `Some(true)`.

**Call relations**: This complements the tracked-file test. Both begin with `create_test_git_repo`, but this one proves `get_has_changes` also pays attention to files Git has not committed yet.

*Call graph*: calls 1 internal fn (create_test_git_repo); 3 external calls (new, assert_eq!, write).


##### `test_get_has_changes_ignores_configured_hooks_path`  (lines 345–385)

```
async fn test_get_has_changes_ignores_configured_hooks_path()
```

**Purpose**: Checks that collecting change status does not run user-configured Git hooks. A Git hook is a script Git may run automatically; tests ensure metadata collection does not trigger those scripts as a side effect.

**Data flow**: On Unix systems, it creates a repository, writes an executable hook script that would create a marker file if run, configures Git to use that hook path, refreshes a tracked file without changing its content, calls `get_has_changes`, and checks the repo is clean and the marker file was not created.

**Call relations**: This uses `create_test_git_repo` and then exercises `get_has_changes` in a safety-sensitive situation. It proves the utility avoids configured hook directories while checking status.

*Call graph*: calls 1 internal fn (create_test_git_repo); 9 external calls (new, assert!, assert_eq!, new, format!, create_dir_all, metadata, set_permissions, write).


##### `test_get_git_working_tree_state_clean_repo`  (lines 388–408)

```
async fn test_get_git_working_tree_state_clean_repo()
```

**Purpose**: Checks that comparing a clean repository to its remote reports the remote commit and an empty diff. A diff is a text description of what changed.

**Data flow**: It creates a local repository with a pushed remote branch, asks Git for the remote branch’s commit hash, calls `git_diff_to_remote`, and checks that the returned SHA matches the remote and that the diff text is empty.

**Call relations**: This test relies on `create_test_git_repo_with_remote` to set up an upstream branch, then calls `git_diff_to_remote` for the clean baseline case.

*Call graph*: calls 1 internal fn (create_test_git_repo_with_remote); 7 external calls (from_utf8, new, assert!, assert_eq!, new, git_diff_to_remote, format!).


##### `test_get_git_working_tree_state_with_changes`  (lines 411–436)

```
async fn test_get_git_working_tree_state_with_changes()
```

**Purpose**: Checks that comparing to the remote includes both edited tracked files and new untracked files in the diff.

**Data flow**: It creates a repository with a remote, edits `test.txt`, creates `untracked.txt`, reads the remote SHA directly from Git, calls `git_diff_to_remote`, and checks that the result names both changed files while still pointing at the remote SHA.

**Call relations**: This builds on `create_test_git_repo_with_remote` and exercises `git_diff_to_remote` when the local working tree has uncommitted changes.

*Call graph*: calls 1 internal fn (create_test_git_repo_with_remote); 8 external calls (from_utf8, new, assert!, assert_eq!, new, git_diff_to_remote, format!, write).


##### `test_get_git_working_tree_state_branch_fallback`  (lines 439–478)

```
async fn test_get_git_working_tree_state_branch_fallback()
```

**Purpose**: Checks that remote comparison can still find a useful remote branch when the current local branch has no direct upstream. This prevents the diff feature from failing just because a local branch is new.

**Data flow**: It creates a repo with a remote, creates and pushes a `feature` branch, then creates a separate local-only branch. It asks for the remote SHA of `origin/feature`, calls `git_diff_to_remote`, and checks that the utility falls back to that remote branch.

**Call relations**: This uses `create_test_git_repo_with_remote` for setup and then calls `git_diff_to_remote` in a branch-layout edge case.

*Call graph*: calls 1 internal fn (create_test_git_repo_with_remote); 5 external calls (from_utf8, new, assert_eq!, new, git_diff_to_remote).


##### `resolve_root_git_project_for_trust_returns_none_outside_repo`  (lines 481–488)

```
async fn resolve_root_git_project_for_trust_returns_none_outside_repo()
```

**Purpose**: Checks that trust-root resolution returns nothing for a path outside any Git repository. This avoids granting trust based on a folder that is not actually a project checkout.

**Data flow**: It creates a temporary directory, converts its path to an absolute path, calls `resolve_root_git_project_for_trust` through the local filesystem interface, and checks that the result is missing.

**Call relations**: This directly tests the negative case for `resolve_root_git_project_for_trust`, using `LOCAL_FS` as the filesystem view.

*Call graph*: 2 external calls (new, assert!).


##### `get_git_repo_root_with_fs_detects_gitdir_pointer`  (lines 491–502)

```
async fn get_git_repo_root_with_fs_detects_gitdir_pointer()
```

**Purpose**: Checks that repository-root discovery recognizes a `.git` file that points to a Git directory, not just a `.git` directory. This matters for Git worktrees and some special checkout layouts.

**Data flow**: It creates a project folder with a nested subfolder, writes a `.git` file containing `gitdir: /tmp/fake-worktree`, calls `get_git_repo_root_with_fs` from the nested path, and expects the project folder as the root.

**Call relations**: This directly exercises `get_git_repo_root_with_fs` through `LOCAL_FS`. It focuses on root detection only, not the fuller trust-root logic.

*Call graph*: 4 external calls (new, assert_eq!, create_dir_all, write).


##### `resolve_root_git_project_for_trust_regular_repo_returns_repo_root`  (lines 505–519)

```
async fn resolve_root_git_project_for_trust_regular_repo_returns_repo_root()
```

**Purpose**: Checks that trust-root resolution returns the repository root for both the root folder itself and a nested folder inside it.

**Data flow**: It creates a real test repository, calls `resolve_root_git_project_for_trust` on the repo path and expects that same path back. Then it creates a nested subdirectory, calls the function there, and expects the original repository root.

**Call relations**: This uses `create_test_git_repo` to set up the normal case for `resolve_root_git_project_for_trust`.

*Call graph*: calls 1 internal fn (create_test_git_repo); 3 external calls (new, assert_eq!, create_dir_all).


##### `resolve_root_git_project_for_trust_detects_worktree_and_returns_main_root`  (lines 522–561)

```
async fn resolve_root_git_project_for_trust_detects_worktree_and_returns_main_root()
```

**Purpose**: Checks that a linked Git worktree resolves to the main repository root for trust purposes. A worktree is an extra checkout connected to the same underlying Git repository.

**Data flow**: It creates a repository, asks Git to add a linked worktree, normalizes the main repository path for fair comparison, then calls `resolve_root_git_project_for_trust` on the worktree root and a nested worktree folder. In both cases it expects the main repository root.

**Call relations**: This test starts with `create_test_git_repo`, uses Git’s real worktree command, then exercises `resolve_root_git_project_for_trust`. It also uses path normalization because operating systems can spell the same path in slightly different ways.

*Call graph*: calls 1 internal fn (create_test_git_repo); 6 external calls (new, assert_eq!, new, resolve_root_git_project_for_trust, normalize_for_path_comparison, create_dir_all).


##### `resolve_root_git_project_for_trust_detects_worktree_pointer_without_git_command`  (lines 564–590)

```
async fn resolve_root_git_project_for_trust_detects_worktree_pointer_without_git_command()
```

**Purpose**: Checks that trust-root resolution can understand a worktree pointer by reading files, even without running the Git command. This makes the logic more robust in restricted environments.

**Data flow**: It manually creates a fake main repository `.git/worktrees/...` layout and a worktree folder whose `.git` file points there. It calls `resolve_root_git_project_for_trust` on the worktree root and a nested folder, expecting the main repository root both times.

**Call relations**: Unlike the previous worktree test, this one does not use `create_test_git_repo` or Git’s worktree command. It directly tests the file-pattern recognition inside `resolve_root_git_project_for_trust`.

*Call graph*: 5 external calls (new, assert_eq!, format!, create_dir_all, write).


##### `resolve_root_git_project_for_trust_non_worktrees_gitdir_returns_none`  (lines 593–620)

```
async fn resolve_root_git_project_for_trust_non_worktrees_gitdir_returns_none()
```

**Purpose**: Checks that a `.git` pointer to an unrelated location is not treated as a trusted worktree. This prevents loose or misleading `.git` files from being trusted accidentally.

**Data flow**: It creates a project-like folder with a nested folder and writes a `.git` file pointing to `some/other/location` instead of a `.git/worktrees/...` path. It calls `resolve_root_git_project_for_trust` on both paths and expects no result.

**Call relations**: This is the rejection case paired with the manual worktree-pointer test. It proves `resolve_root_git_project_for_trust` is specific about which pointer layouts it accepts.

*Call graph*: 5 external calls (new, assert!, format!, create_dir_all, write).


##### `test_get_git_working_tree_state_unpushed_commit`  (lines 623–657)

```
async fn test_get_git_working_tree_state_unpushed_commit()
```

**Purpose**: Checks that a local commit not yet pushed to the remote appears in the diff against the remote. This matters because the remote branch is still behind the local working state.

**Data flow**: It creates a repository with a remote, records the remote SHA, edits `test.txt`, stages and commits the change locally without pushing, calls `git_diff_to_remote`, and checks that the returned base SHA is still the remote SHA and that the diff includes the updated content.

**Call relations**: This uses `create_test_git_repo_with_remote` and then calls `git_diff_to_remote` after creating an unpushed commit. It extends the remote-comparison tests beyond uncommitted file edits.

*Call graph*: calls 1 internal fn (create_test_git_repo_with_remote); 8 external calls (from_utf8, new, assert!, assert_eq!, new, git_diff_to_remote, format!, write).


##### `test_git_info_serialization`  (lines 660–676)

```
fn test_git_info_serialization()
```

**Purpose**: Checks that a filled-in `GitInfo` value turns into JSON with the expected field names and values. JSON is a common text format used to send structured data between parts of a system.

**Data flow**: It builds a `GitInfo` value with a commit hash, branch, and repository URL, serializes it to JSON text, parses that text back into a generic JSON value, and checks each field matches what was provided.

**Call relations**: This test focuses on the data shape of `GitInfo`, not on running Git. It uses `GitSha::new` to build the commit-hash value and `serde_json` to verify serialization.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, from_str, to_string).


##### `test_git_info_serialization_with_nones`  (lines 679–693)

```
fn test_git_info_serialization_with_nones()
```

**Purpose**: Checks that missing `GitInfo` fields are left out of JSON rather than written as null values. This keeps serialized metadata compact and avoids implying that empty fields were deliberately set.

**Data flow**: It builds a `GitInfo` value where commit hash, branch, and repository URL are all absent, serializes it to JSON, parses it back, and checks that none of those keys appear in the JSON object.

**Call relations**: This is the empty-data companion to `test_git_info_serialization`. Together they prove both present and missing Git metadata serialize in the intended shape.

*Call graph*: 3 external calls (assert!, from_str, to_string).


### `core/src/shell_tests.rs`

`test` · `test run`

This is a test file for the shell-detection part of the project. A shell is the program that runs typed commands, such as Bash on many Unix systems or PowerShell on Windows. The rest of the project needs to know which shell to use, where it lives on disk, and which command-line flags make it run a command correctly. If this logic is wrong, user commands might fail even though the command itself is valid.

The tests cover two main ideas. First, they check that the project can locate expected shells on the current platform. For example, macOS should be able to identify Zsh, Unix-like systems should find Bash and sh, and Windows should find PowerShell. Some checks are platform-specific, so they quietly skip themselves on systems where they do not apply.

Second, the file checks that shell commands are built and executed correctly. It uses a tiny command that prints “Works,” then confirms that the selected shell actually runs it and returns that text. This is like checking not only that you found the right key, but also that it really opens the door.

The file also tests the exact argument lists produced for different shell types, because shells expect different flags. Bash and Zsh use one style, while PowerShell uses another.

#### Function details

##### `detects_zsh`  (lines 7–13)

```
fn detects_zsh()
```

**Purpose**: This macOS-only test checks that asking for a Zsh shell returns the expected system Zsh path. It exists because macOS commonly uses Zsh, and the project should recognize it reliably.

**Data flow**: The test asks the shell code for a Zsh shell without giving a custom path. It reads the returned shell path and compares it with `/bin/zsh`. The output is not a returned value; the test passes if the paths match and fails through an assertion if they do not.

**Call relations**: During the test run, the test harness calls this function only on macOS. Inside it, the important handoff is to the shell lookup code, and the final check is made with an equality assertion.

*Call graph*: 1 external calls (assert_eq!).


##### `fish_fallback_to_zsh`  (lines 17–23)

```
fn fish_fallback_to_zsh()
```

**Purpose**: This macOS-only test checks what happens when the user shell path points to Fish. The expected behavior is to fall back to Zsh, which means the project avoids using an unsupported or unwanted shell choice in that situation.

**Data flow**: The test creates a path value for `/bin/fish` and passes it into the default-shell selection logic. That logic returns a shell choice. The test then reads the chosen shell path and confirms it is `/bin/zsh`.

**Call relations**: The test harness runs this on macOS. The function builds a path, asks the default-shell code to interpret it, and uses an equality assertion to verify that the fallback choice is Zsh.

*Call graph*: 2 external calls (from, assert_eq!).


##### `detects_bash`  (lines 26–34)

```
fn detects_bash()
```

**Purpose**: This test checks that the project can find Bash. It does not require Bash to be in one exact location; it only requires that the discovered executable is named `bash`.

**Data flow**: The test asks for a Bash shell with no custom path. It takes the returned path, extracts just the file name, turns that name into text if possible, and checks that it is `bash`. The test passes if that condition is true.

**Call relations**: The test harness calls this as part of the shell test suite. The function relies on the shell lookup code to find Bash, then uses an assertion to turn the result into a pass or failure.

*Call graph*: 1 external calls (assert!).


##### `detects_sh`  (lines 37–44)

```
fn detects_sh()
```

**Purpose**: This test checks that the project can find the basic `sh` shell. `sh` is a common fallback shell on Unix-like systems, so finding it is important for broad compatibility.

**Data flow**: The test asks for an `sh` shell without supplying a path. It inspects the returned path, extracts the file name, and checks that the name is exactly `sh`. Nothing is returned; the assertion decides whether the test passes.

**Call relations**: The test harness runs this function with the other shell tests. It calls into the shell lookup behavior and then uses an assertion to confirm the result is the expected kind of executable.

*Call graph*: 1 external calls (assert!).


##### `can_run_on_shell_test`  (lines 47–87)

```
fn can_run_on_shell_test()
```

**Purpose**: This test checks that the shells found by the project can actually run a simple command. It is a practical end-to-end check: not just “can we find the shell?” but “can that shell execute what we give it?”

**Data flow**: The test starts with a small command meant to print `Works`. On Windows, it tries PowerShell, cmd, and the ultimate fallback shell. On other systems, it tries the fallback shell, Zsh if available, Bash, and sh. For each shell, it passes the shell choice, the command text, and whether that shell is required into `shell_works`. The test succeeds only when required shells run the command successfully.

**Call relations**: The test harness calls this function. It uses platform checks to choose the Windows or non-Windows path, then delegates the actual command execution check to `shell_works`. Its assertions make sure the helper reports success where success is mandatory.

*Call graph*: 2 external calls (assert!, cfg!).


##### `shell_works`  (lines 89–102)

```
fn shell_works(shell: Option<Shell>, command: &str, required: bool) -> bool
```

**Purpose**: This helper tries to run one command through one shell and reports whether that worked. It keeps the larger test readable by putting the repeated “build arguments, run process, inspect output” steps in one place.

**Data flow**: The function receives an optional shell, a command string, and a flag saying whether that shell is required. If a shell is present, it asks the shell object to turn the command into executable arguments, starts that executable as a child process, waits for output, checks that the process succeeded, and checks that standard output contains `Works`. It returns `true` after a successful run. If no shell was found, it returns `true` only when that shell was not required.

**Call relations**: `can_run_on_shell_test` calls this helper for each shell it wants to try. This helper then hands off to the operating system through process creation, using `Command::new`, and uses assertions to fail the test immediately if a found shell cannot run the command correctly.

*Call graph*: 2 external calls (assert!, new).


##### `derive_exec_args`  (lines 105–144)

```
fn derive_exec_args()
```

**Purpose**: This test checks the exact command-line arguments generated for Bash, Zsh, and PowerShell. This matters because each shell needs different flags to run a command string, and a small flag mistake can stop commands from running.

**Data flow**: The test builds three sample shell objects with known paths and shell types. For each one, it asks for the arguments needed to run `echo hello`, both with and without login-shell behavior. It compares each produced list with the exact list expected for that shell.

**Call relations**: The test harness calls this function during the test run. The function exercises the shell object’s argument-building method and uses equality assertions to confirm the result matches the contract expected by the rest of the project.

*Call graph*: 2 external calls (from, assert_eq!).


##### `test_current_shell_detects_zsh`  (lines 147–164)

```
async fn test_current_shell_detects_zsh()
```

**Purpose**: This asynchronous test checks that, when the current user shell is Zsh, the project’s default-shell detection returns that same Zsh shell. It only performs the assertion when the environment actually reports Zsh.

**Data flow**: The test starts a small `sh` command that prints the `$SHELL` environment variable, which is the user’s configured shell path on Unix-like systems. It converts the command output from bytes into text, trims it, and checks whether it ends in `/zsh`. If so, it asks the project for the default user shell and compares it with a Zsh shell built from the detected path.

**Call relations**: The async test harness calls this function. The function first asks the operating system for the current shell through a spawned `sh` process, then, only when that says Zsh, it verifies the project’s default-shell detection with an equality assertion.

*Call graph*: 3 external calls (from_utf8_lossy, assert_eq!, new).


##### `detects_powershell_as_default`  (lines 167–176)

```
async fn detects_powershell_as_default()
```

**Purpose**: This Windows-only test checks that the default user shell is PowerShell. It accepts either modern `pwsh.exe` or older `powershell.exe`, because both may be valid on Windows systems.

**Data flow**: The test first exits early on non-Windows systems. On Windows, it asks for the default user shell, reads the path of that shell, and checks that the path ends with either `pwsh.exe` or `powershell.exe`. The assertion determines whether the test passes.

**Call relations**: The test harness may call this on any platform, but the function uses a platform check to do real work only on Windows. It then relies on the default-shell detection code and verifies the result with an assertion.

*Call graph*: 2 external calls (assert!, cfg!).


##### `finds_powershell`  (lines 179–188)

```
fn finds_powershell()
```

**Purpose**: This Windows-only test checks that explicitly asking for PowerShell finds a usable PowerShell executable. It allows both `pwsh.exe` and `powershell.exe` so the test works across different Windows installations.

**Data flow**: The test returns immediately if the platform is not Windows. On Windows, it asks the shell lookup code for PowerShell, unwraps the result, reads the path, and checks that the path ends with one of the accepted PowerShell executable names.

**Call relations**: The test harness runs this with the rest of the tests, but the function only performs its lookup on Windows. It calls the shell lookup behavior and uses an assertion to confirm that the located executable is a PowerShell program.

*Call graph*: 2 external calls (assert!, cfg!).


### `core/src/shell_snapshot_tests.rs`

`test` · `test suite`

A shell snapshot is like taking a photo of a terminal’s current setup: exported environment variables, aliases, options, and other bits needed to recreate the same working context later. This test file makes sure those photos are readable, safe, and temporary. It verifies that snapshot text starts at the expected marker, that snapshot file names can be linked back to session IDs, and that the Bash snapshot script does not include unsafe or unwanted environment variables. It also checks important real-world behavior: multiline values, such as certificates, must survive in the snapshot; a snapshot process must not hang by reading from the user’s real standard input; and a shell that runs too long must be killed after a timeout. The file also tests cleanup rules. Snapshot files are kept only when they belong to a live or still-relevant session, and removed when they are orphaned, invalid, or tied to stale rollout history. Several tests run only on Unix, Linux, macOS, or Windows because shell behavior and operating system tools differ. Overall, this file protects a fragile boundary between the application and the user’s shell environment.

#### Function details

##### `BlockingStdinPipe::install`  (lines 23–57)

```
fn install() -> Result<Self>
```

**Purpose**: This helper temporarily replaces the process’s standard input with a pipe that stays open but provides no data. It is used to prove that the snapshot shell does not accidentally inherit and wait on the caller’s real input.

**Data flow**: It starts with the current process standard input. It creates a pipe, saves a duplicate of the original input, replaces standard input with the read end of the pipe, closes the extra read handle, and returns a guard object holding the saved original input and the pipe’s write end. If any operating system call fails, it closes what it already opened and returns an error.

**Call relations**: The `snapshot_shell_does_not_inherit_stdin` test calls this before launching a snapshot shell. The returned guard keeps the fake input in place during the test, and its cleanup code restores normal input afterward.

*Call graph*: called by 1 (snapshot_shell_does_not_inherit_stdin); 5 external calls (last_os_error, close, dup, dup2, pipe).


##### `BlockingStdinPipe::drop`  (lines 62–68)

```
fn drop(&mut self)
```

**Purpose**: This cleanup method restores the process’s original standard input when the `BlockingStdinPipe` guard goes out of scope. It prevents the test’s fake input setup from leaking into later tests.

**Data flow**: It takes the saved original input file descriptor and puts it back in the standard input slot. Then it closes both the saved duplicate and the pipe write end, leaving the process back in its earlier state.

**Call relations**: It runs automatically after `snapshot_shell_does_not_inherit_stdin` finishes with its guard. It only calls low-level operating system cleanup functions and does not hand work to other project code.

*Call graph*: 2 external calls (close, dup2).


##### `assert_posix_snapshot_sections`  (lines 72–81)

```
fn assert_posix_snapshot_sections(snapshot: &str)
```

**Purpose**: This helper checks that a Unix-style shell snapshot contains the main expected sections. It gives several platform-specific tests one shared definition of what a basic usable snapshot should include.

**Data flow**: It receives the snapshot text as input. It looks for the snapshot header, aliases section, exports section, a `PATH` export, and shell options section. It does not return a value; it fails the test if any required piece is missing.

**Call relations**: The macOS zsh, Linux Bash, and Linux sh snapshot tests call this after `get_snapshot` produces snapshot text. It is the final checklist those tests use to decide whether the snapshot looks complete.

*Call graph*: called by 3 (linux_bash_snapshot_includes_sections, linux_sh_snapshot_includes_sections, macos_zsh_snapshot_includes_sections); 1 external calls (assert!).


##### `get_snapshot`  (lines 83–89)

```
async fn get_snapshot(shell_type: ShellType) -> Result<String>
```

**Purpose**: This helper creates a snapshot for a requested shell type and returns the snapshot file’s contents. It lets several tests focus on what the snapshot contains instead of repeating temporary-file setup.

**Data flow**: It receives a shell type, creates a temporary directory, chooses a snapshot file path inside it, asks the snapshot writer to write that file, reads the file back as text, and returns that text. The temporary directory keeps the test isolated from the real filesystem.

**Call relations**: The platform-specific snapshot-content tests call this first, then inspect the returned text. It hands off the actual snapshot creation to the production snapshot-writing code and uses file reading only to bring the result back into the test.

*Call graph*: called by 4 (linux_bash_snapshot_includes_sections, linux_sh_snapshot_includes_sections, macos_zsh_snapshot_includes_sections, windows_powershell_snapshot_includes_sections); 2 external calls (read_to_string, tempdir).


##### `strip_snapshot_preamble_removes_leading_output`  (lines 92–96)

```
fn strip_snapshot_preamble_removes_leading_output()
```

**Purpose**: This test proves that extra text before the snapshot marker can be removed. That matters because shell startup files may print noise before the real snapshot begins.

**Data flow**: It builds a small text sample with `noise` before `# Snapshot file`. It passes that text to the preamble-stripping function and checks that the returned text starts exactly at the marker.

**Call relations**: The test runner calls this test directly. It exercises `strip_snapshot_preamble` from the surrounding module and verifies the cleaned result with an equality assertion.

*Call graph*: 1 external calls (assert_eq!).


##### `strip_snapshot_preamble_requires_marker`  (lines 99–102)

```
fn strip_snapshot_preamble_requires_marker()
```

**Purpose**: This test makes sure snapshot cleanup fails when the expected snapshot marker is missing. Without that check, unrelated shell output could be mistaken for a valid snapshot.

**Data flow**: It sends text with no snapshot header into the preamble-stripping function. It expects an error instead of cleaned snapshot text.

**Call relations**: The test runner calls this test directly. It focuses on the failure path of `strip_snapshot_preamble`, confirming that the production code is strict about the marker.

*Call graph*: 1 external calls (assert!).


##### `snapshot_file_name_parser_supports_legacy_and_suffixed_names`  (lines 105–124)

```
fn snapshot_file_name_parser_supports_legacy_and_suffixed_names()
```

**Purpose**: This test checks that snapshot file names can still reveal their session ID across old and newer naming styles. That keeps cleanup code compatible with files created by earlier versions.

**Data flow**: It starts with one session ID string and builds several file names around it, including plain `.sh`, suffixed `.123.sh`, and temporary-looking names. It checks that valid names return the session ID and an unrelated name returns nothing.

**Call relations**: The test runner calls this test directly. It exercises `snapshot_session_id_from_file_name`, which cleanup code relies on when deciding which snapshot files belong to which sessions.

*Call graph*: 1 external calls (assert_eq!).


##### `bash_snapshot_filters_invalid_exports`  (lines 128–148)

```
fn bash_snapshot_filters_invalid_exports() -> Result<()>
```

**Purpose**: This Unix test checks that the Bash snapshot script includes only safe, valid exported variables. It prevents stale, tool-generated, or invalid environment entries from being written into a reusable shell script.

**Data flow**: It launches `/bin/bash` with controlled environment variables: one valid variable and several variables that should be skipped. It captures Bash’s output from the snapshot script, turns it into text, and checks that only the valid export appears.

**Call relations**: The test runner calls this on Unix systems. It runs the real `bash_snapshot_script` through an actual Bash process, then inspects the produced text rather than mocking shell behavior.

*Call graph*: 3 external calls (from_utf8_lossy, assert!, new).


##### `bash_snapshot_preserves_multiline_exports`  (lines 152–188)

```
fn bash_snapshot_preserves_multiline_exports() -> Result<()>
```

**Purpose**: This Unix test verifies that exported values containing line breaks, such as certificates, are saved in a way Bash can read back. This protects users whose environments contain multiline secrets or credentials.

**Data flow**: It starts Bash with a multiline environment variable, runs the snapshot script, and checks that the variable name appears in the output. Then it writes that output to a temporary file and asks Bash to source that file, meaning to load it as shell code. The test passes only if Bash can load the saved snapshot successfully.

**Call relations**: The test runner calls this on Unix systems. It uses the real `bash_snapshot_script`, writes the resulting snapshot to disk, and validates it with another real Bash process.

*Call graph*: 5 external calls (from_utf8_lossy, assert!, new, write, tempdir).


##### `try_create_creates_and_deletes_snapshot_file`  (lines 192–216)

```
async fn try_create_creates_and_deletes_snapshot_file() -> Result<()>
```

**Purpose**: This Unix async test checks the lifetime of a `ShellSnapshot`: creating one should create a file, and dropping it should delete that file. The snapshot should behave like a temporary rental, not permanent clutter.

**Data flow**: It creates a temporary directory and a Bash shell description, then asks `ShellSnapshot::try_create` to make a snapshot there. It records the path, confirms the file exists, drops the snapshot object, and confirms the file is gone.

**Call relations**: The async test runner calls this on Unix systems. It calls the production snapshot creation function and relies on the snapshot object’s cleanup behavior when the object is dropped.

*Call graph*: calls 2 internal fn (try_create, new); 3 external calls (from, assert!, tempdir).


##### `try_create_uses_distinct_generation_paths`  (lines 220–262)

```
async fn try_create_uses_distinct_generation_paths() -> Result<()>
```

**Purpose**: This Unix async test ensures two snapshots for the same session do not overwrite each other. That is important when a session refreshes its shell state while an older snapshot file may still be in use.

**Data flow**: It creates one session ID, then asks for two snapshots in the same directory for that same session. It compares their paths, confirms both files exist, drops the first snapshot and sees only its file disappear, then drops the second and sees its file disappear too.

**Call relations**: The async test runner calls this on Unix systems. It calls `ShellSnapshot::try_create` twice and checks that each returned snapshot owns a separate file with independent cleanup.

*Call graph*: calls 2 internal fn (try_create, new); 4 external calls (from, assert_eq!, assert_ne!, tempdir).


##### `snapshot_shell_does_not_inherit_stdin`  (lines 266–312)

```
async fn snapshot_shell_does_not_inherit_stdin() -> Result<()>
```

**Purpose**: This Unix async test proves that the snapshot shell is given closed or empty input instead of the caller’s real standard input. Without this, a user’s shell startup script could block the snapshot by waiting for keyboard input.

**Data flow**: It first installs the fake blocking standard input guard. Then it creates a temporary home directory with a `.bashrc` that tries to read from standard input and records the read result. It runs the snapshot script as a login shell with a short timeout, reads the recorded status, and checks that Bash saw end-of-file rather than hanging on inherited input. It also checks that snapshot output was still produced.

**Call relations**: The async test runner calls this on Unix systems. It uses `BlockingStdinPipe::install` to create the risky input situation, then calls the production timeout-based script runner to verify the snapshot shell isolates itself correctly.

*Call graph*: calls 1 internal fn (install); 8 external calls (from_secs, from, assert!, assert_eq!, format!, read_to_string, write, tempdir).


##### `timed_out_snapshot_shell_is_terminated`  (lines 316–369)

```
async fn timed_out_snapshot_shell_is_terminated() -> Result<()>
```

**Purpose**: This Linux async test checks that a snapshot shell that runs too long is not merely reported as timed out, but actually stopped. This prevents runaway shell processes from being left behind after a failed snapshot.

**Data flow**: It writes a script that records its own process ID and then sleeps for a long time. It runs that script with a one-second timeout and expects a timeout error. After reading the recorded process ID, it repeatedly asks the operating system whether that process is still alive until it disappears or the test fails.

**Call relations**: The async test runner calls this on Linux. It exercises the production `run_script_with_timeout` behavior and then uses the system `kill -0` check to confirm the child process was terminated.

*Call graph*: 12 external calls (from_secs, now, from, new, null, from_millis, from_secs, assert!, format!, read_to_string (+2 more)).


##### `macos_zsh_snapshot_includes_sections`  (lines 373–377)

```
async fn macos_zsh_snapshot_includes_sections() -> Result<()>
```

**Purpose**: This macOS async test checks that a zsh snapshot contains the standard Unix snapshot sections. It protects the default macOS shell path through the snapshot feature.

**Data flow**: It asks `get_snapshot` for a zsh snapshot, then passes the resulting text to the shared Unix snapshot-section checker. The test fails if the snapshot lacks the expected header, aliases, exports, `PATH`, or options.

**Call relations**: The async test runner calls this on macOS. It chains `get_snapshot` into `assert_posix_snapshot_sections`, reusing the common helper for the final content check.

*Call graph*: calls 2 internal fn (assert_posix_snapshot_sections, get_snapshot).


##### `linux_bash_snapshot_includes_sections`  (lines 381–385)

```
async fn linux_bash_snapshot_includes_sections() -> Result<()>
```

**Purpose**: This Linux async test checks that a Bash snapshot contains the standard Unix snapshot sections. It covers the common Linux interactive shell case.

**Data flow**: It requests a Bash snapshot with `get_snapshot`, receives the file contents as text, and checks that text with the shared Unix section assertions.

**Call relations**: The async test runner calls this on Linux. It relies on `get_snapshot` for setup and creation, then on `assert_posix_snapshot_sections` for the common validation.

*Call graph*: calls 2 internal fn (assert_posix_snapshot_sections, get_snapshot).


##### `linux_sh_snapshot_includes_sections`  (lines 389–393)

```
async fn linux_sh_snapshot_includes_sections() -> Result<()>
```

**Purpose**: This Linux async test checks that a plain `sh` snapshot contains the standard Unix snapshot sections. It ensures the simpler POSIX-style shell path still produces a useful snapshot.

**Data flow**: It asks `get_snapshot` to create a snapshot for `sh`, receives the snapshot text, and verifies the required Unix sections are present.

**Call relations**: The async test runner calls this on Linux. Like the Bash and zsh tests, it delegates snapshot creation to `get_snapshot` and content validation to `assert_posix_snapshot_sections`.

*Call graph*: calls 2 internal fn (assert_posix_snapshot_sections, get_snapshot).


##### `windows_powershell_snapshot_includes_sections`  (lines 398–404)

```
async fn windows_powershell_snapshot_includes_sections() -> Result<()>
```

**Purpose**: This Windows async test, currently ignored, checks that a PowerShell snapshot has the main snapshot header and sections. It documents the intended Windows behavior even if the test is not run by default.

**Data flow**: It asks `get_snapshot` for a PowerShell snapshot and then checks for the snapshot marker, aliases section, and exports section. It returns success only if those pieces are present.

**Call relations**: When enabled, the async test runner calls this on Windows. It uses the same `get_snapshot` helper as the Unix section tests but performs Windows-appropriate assertions directly.

*Call graph*: calls 1 internal fn (get_snapshot); 1 external calls (assert!).


##### `write_rollout_stub`  (lines 406–416)

```
async fn write_rollout_stub(codex_home: &Path, session_id: ThreadId) -> Result<PathBuf>
```

**Purpose**: This helper creates a minimal fake rollout history file for a session. Cleanup tests use it to make a snapshot look connected to a real saved session without needing a full session recording.

**Data flow**: It receives a Codex home directory and a session ID. It creates the expected dated sessions folder, writes an empty JSON-lines rollout file whose name includes the session ID, and returns the file path.

**Call relations**: The stale-snapshot cleanup tests call this when they need a live or stale session marker. It performs just enough filesystem setup for `cleanup_stale_snapshots` to recognize the session.

*Call graph*: called by 3 (cleanup_stale_snapshots_removes_orphans_and_keeps_live, cleanup_stale_snapshots_removes_stale_rollouts, cleanup_stale_snapshots_skips_active_session); 4 external calls (join, format!, create_dir_all, write).


##### `cleanup_stale_snapshots_removes_orphans_and_keeps_live`  (lines 419–442)

```
async fn cleanup_stale_snapshots_removes_orphans_and_keeps_live() -> Result<()>
```

**Purpose**: This async test checks that cleanup removes snapshot files that do not belong to a known session, while keeping a snapshot that does. It also confirms invalidly named files in the snapshot directory are removed.

**Data flow**: It creates a temporary Codex home and snapshot directory, then writes three files: one tied to a fake rollout, one tied to no rollout, and one with an invalid name. After running cleanup, it checks that the live snapshot remains and the orphan and invalid files are gone.

**Call relations**: The async test runner calls this test. It uses `write_rollout_stub` to create the live-session evidence, then calls the production cleanup function and inspects the filesystem afterward.

*Call graph*: calls 2 internal fn (write_rollout_stub, new); 5 external calls (assert_eq!, format!, create_dir_all, write, tempdir).


##### `cleanup_stale_snapshots_removes_stale_rollouts`  (lines 446–463)

```
async fn cleanup_stale_snapshots_removes_stale_rollouts() -> Result<()>
```

**Purpose**: This Unix async test checks that cleanup removes snapshots tied to rollout history that is too old. A session that once existed should not keep snapshot files forever.

**Data flow**: It creates a fake rollout and a matching snapshot, then changes the rollout file’s modification time so it appears older than the retention window. After cleanup runs, it checks that the matching snapshot file was deleted.

**Call relations**: The async test runner calls this on Unix systems. It uses `write_rollout_stub` for the fake session, `set_file_mtime` to age it, and then verifies the production cleanup rule.

*Call graph*: calls 3 internal fn (set_file_mtime, write_rollout_stub, new); 6 external calls (from_secs, assert_eq!, format!, create_dir_all, write, tempdir).


##### `cleanup_stale_snapshots_skips_active_session`  (lines 467–484)

```
async fn cleanup_stale_snapshots_skips_active_session() -> Result<()>
```

**Purpose**: This Unix async test checks that cleanup does not delete the currently active session’s snapshot, even if its rollout file looks old. The active user session must not lose the snapshot it may still need.

**Data flow**: It creates a fake active session rollout and snapshot, makes the rollout file look older than the retention window, and then runs cleanup while naming that same session as active. After cleanup, it checks that the snapshot still exists.

**Call relations**: The async test runner calls this on Unix systems. It combines `write_rollout_stub`, `set_file_mtime`, and the production cleanup function to verify the active-session exception.

*Call graph*: calls 3 internal fn (set_file_mtime, write_rollout_stub, new); 6 external calls (from_secs, assert_eq!, format!, create_dir_all, write, tempdir).


##### `set_file_mtime`  (lines 487–503)

```
fn set_file_mtime(path: &Path, age: Duration) -> Result<()>
```

**Purpose**: This Unix helper changes a file’s modification time so it appears to have been last changed a chosen amount of time ago. Cleanup tests use it to simulate old rollout files without waiting in real time.

**Data flow**: It receives a file path and an age. It calculates a timestamp by subtracting that age from the current time, converts the path to the operating system’s C-style string format, and calls the Unix `utimensat` system function to set both access and modification times. It returns success or the operating system error.

**Call relations**: The stale-rollout cleanup tests call this before running cleanup. It prepares the filesystem state that lets `cleanup_stale_snapshots` decide a rollout is old.

*Call graph*: called by 2 (cleanup_stale_snapshots_removes_stale_rollouts, cleanup_stale_snapshots_skips_active_session); 6 external calls (as_secs, as_os_str, now, last_os_error, utimensat, new).


### `core/src/realtime_context_tests.rs`

`test` · `test run`

When a realtime Codex session starts, the system builds a short “startup context” so the assistant knows where it is, what has happened recently, and what project files may matter. This test file acts like a safety checklist for that context. Without these tests, the startup text could quietly become too large, lose the newest conversation turns, expose unhelpful hidden files, or stop grouping previous sessions in a useful way.

The tests cover several parts of that startup package. They verify that the current thread section shows the newest user and assistant turns first, and that very long turns are shortened by keeping the beginning and end while removing the middle. They also check that each section has its own size limit, rather than cutting off the final combined startup blob as one large block.

The workspace tests create temporary folders and files, then confirm that the workspace map appears only when there is meaningful structure to show. They also check that a separate user root, like a home directory, is summarized without including dotfiles such as `.zshrc`. The recent-work test creates fake stored sessions and a temporary Git repository, then checks that prior sessions are grouped by repository or directory. In short, this file protects the shape, size, and usefulness of the context that helps Codex start a session intelligently.

#### Function details

##### `stored_thread`  (lines 30–69)

```
fn stored_thread(cwd: &str, title: &str, first_user_message: &str) -> StoredThread
```

**Purpose**: Creates a realistic fake saved conversation thread for tests. It lets the recent-work tests describe past sessions without needing a real thread database.

**Data flow**: It receives a working directory, a title, and the first user message. It fills in the rest of a `StoredThread` with stable test values such as a new thread ID, timestamps, model name, Git branch, permission settings, and preview text. The result is a complete stored-thread record that other tests can pass into recent-work context building.

**Call relations**: This helper builds the thread records used when testing recent work. While constructing the record, it asks the protocol types for a new thread ID and a read-only permission profile, and it converts the supplied directory string into a path.

*Call graph*: calls 3 internal fn (read_only, new, new); 1 external calls (from).


##### `message`  (lines 71–79)

```
fn message(role: &str, content: ContentItem) -> ResponseItem
```

**Purpose**: Builds a generic conversation message with a role such as `user` or `assistant`. It keeps the test setup short and makes the later tests easier to read.

**Data flow**: It takes a role name and one content item. It wraps that content item in a one-item list and returns a `ResponseItem::Message` with empty optional fields for things the tests do not care about.

**Call relations**: This is the shared helper underneath `user_message` and `assistant_message`. Those two helpers supply the role and text shape, while this function creates the common message structure.

*Call graph*: called by 2 (assistant_message, user_message); 1 external calls (vec!).


##### `user_message`  (lines 81–83)

```
fn user_message(text: impl Into<String>) -> ResponseItem
```

**Purpose**: Creates a test conversation item that looks like text typed by the user. Tests use it to build fake thread histories.

**Data flow**: It receives any value that can become a string. It converts that value into text, wraps it as user input content, and passes it to `message`, which returns the finished response item.

**Call relations**: This helper feeds user turns into the current-thread tests. In the provided call graph it is used by `current_thread_section_keeps_latest_turns_when_history_exceeds_budget`, where many fake user turns are built before the context section is generated.

*Call graph*: calls 1 internal fn (message); called by 1 (current_thread_section_keeps_latest_turns_when_history_exceeds_budget); 1 external calls (into).


##### `assistant_message`  (lines 85–87)

```
fn assistant_message(text: impl Into<String>) -> ResponseItem
```

**Purpose**: Creates a test conversation item that looks like text produced by the assistant. It pairs with `user_message` so tests can build full back-and-forth turns.

**Data flow**: It receives text-like input, converts it into a string, marks it as assistant output content, and asks `message` to package it as a response item.

**Call relations**: This helper is used when a test needs assistant replies in the fake history. In the call graph, `current_thread_section_keeps_latest_turns_when_history_exceeds_budget` uses it together with `user_message` to create several complete turns.

*Call graph*: calls 1 internal fn (message); called by 1 (current_thread_section_keeps_latest_turns_when_history_exceeds_budget); 1 external calls (into).


##### `long_turn_text`  (lines 89–95)

```
fn long_turn_text(index: usize) -> String
```

**Purpose**: Creates deliberately long test text for one conversation turn. The text includes clear markers at the start, middle, and end so tests can see what survives truncation.

**Data flow**: It receives a turn number. It returns a long string containing `turn-N-start`, a large amount of filler, `turn-N-middle`, more filler, and `turn-N-end`.

**Call relations**: This helper supports the tests that check size limits. `current_thread_section_keeps_latest_turns_when_history_exceeds_budget` uses it to create history entries large enough to force the context builder to drop older content.

*Call graph*: called by 1 (current_thread_section_keeps_latest_turns_when_history_exceeds_budget); 1 external calls (format!).


##### `current_thread_section_includes_short_turns_newest_first_until_budget`  (lines 98–145)

```
fn current_thread_section_includes_short_turns_newest_first_until_budget()
```

**Purpose**: Checks that a short conversation history is shown in newest-first order. This protects the assistant’s ability to see the most recent exchange first when continuing a session.

**Data flow**: The test builds four user/assistant turns, asks the current-thread section builder to format them, and compares the result to the exact expected text. The expected output starts with the latest turn and then labels earlier turns as previous turns.

**Call relations**: This test exercises the current-thread formatting behavior directly. It builds a small list of response items and verifies the final section text with an equality assertion.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `current_thread_turn_truncation_preserves_start_and_end`  (lines 148–161)

```
fn current_thread_turn_truncation_preserves_start_and_end()
```

**Purpose**: Checks that one very long turn is shortened in a useful way. The important rule is that the beginning and end remain visible, while the middle may be removed.

**Data flow**: The test creates one long user message, sends it into the current-thread section builder, and then checks for four facts: the start marker is present, the middle marker is gone, the end marker is present, and a truncation note appears.

**Call relations**: This test calls the production current-thread section builder with intentionally oversized text. It then uses an equality assertion on simple true/false checks to confirm the truncation behavior.

*Call graph*: 3 external calls (assert_eq!, build_current_thread_section, vec!).


##### `current_thread_section_keeps_latest_turns_when_history_exceeds_budget`  (lines 164–183)

```
fn current_thread_section_keeps_latest_turns_when_history_exceeds_budget()
```

**Purpose**: Checks that, when the conversation history is too large, the newest turns are kept and the oldest turns are dropped. This matters because recent context is usually more useful than old context.

**Data flow**: The test builds eight large user turns, each followed by an assistant reply. It passes the full list into the current-thread section builder, then checks that the latest turn remains, that some previous-turn labeling remains, and that the first turn no longer appears.

**Call relations**: This test uses `long_turn_text`, `user_message`, and `assistant_message` to create a large fake history. It hands that history to `build_current_thread_section` and verifies that the section builder spends its limited space on the newest material.

*Call graph*: calls 3 internal fn (assistant_message, long_turn_text, user_message); 4 external calls (new, assert_eq!, format!, build_current_thread_section).


##### `startup_context_blob_is_wrapped_in_tags_without_final_truncation`  (lines 186–194)

```
fn startup_context_blob_is_wrapped_in_tags_without_final_truncation()
```

**Purpose**: Checks that the full startup context is wrapped in clear XML-like tags. These tags give the receiving model a clean boundary around the startup information.

**Data flow**: The test starts with a small body of startup text. It passes that body to the startup-context formatter and expects the same body back with `<startup_context>` before it and `</startup_context>` after it.

**Call relations**: This test focuses on the final wrapping step by calling `format_startup_context_blob`. It confirms that wrapping does not add any extra trimming for this small input.

*Call graph*: 2 external calls (assert_eq!, format_startup_context_blob).


##### `fixed_section_budgets_apply_per_section_without_total_blob_truncation`  (lines 197–236)

```
fn fixed_section_budgets_apply_per_section_without_total_blob_truncation()
```

**Purpose**: Checks that size limits are applied section by section, not by cutting off the completed startup blob at the end. This prevents one long section from deleting later sections entirely.

**Data flow**: The test creates oversized text for several named sections, formats each section with its own token budget, joins them into one body, and wraps the body. It then checks that the wrapper is present, that truncation notices appear, and that all expected section headings are still included.

**Call relations**: This test combines calls to `format_section` and `format_startup_context_blob`. It verifies the bigger contract between them: each section is trimmed before the final blob is wrapped, so the final output keeps its overall structure.

*Call graph*: 3 external calls (assert!, format_section, format_startup_context_blob).


##### `workspace_section_requires_meaningful_structure`  (lines 239–245)

```
async fn workspace_section_requires_meaningful_structure()
```

**Purpose**: Checks that an empty temporary directory does not produce a workspace section. This avoids sending a pointless file-tree summary when there is nothing useful to show.

**Data flow**: The test creates a fresh empty temporary directory and asks for a workspace section using that directory as the current working location. It expects no section to be returned.

**Call relations**: This asynchronous test exercises the workspace context builder at the simplest boundary case: an empty folder. It confirms that the builder stays quiet when there is no meaningful workspace structure.

*Call graph*: 2 external calls (new, assert_eq!).


##### `workspace_section_includes_tree_when_entries_exist`  (lines 248–260)

```
async fn workspace_section_includes_tree_when_entries_exist()
```

**Purpose**: Checks that a workspace section includes a simple directory tree when files and folders are present. This helps the assistant quickly understand the project’s visible shape.

**Data flow**: The test creates a temporary directory, adds a `docs` folder and a `README.md` file, and then asks the workspace builder for a section. It expects the output to mention the working directory tree and list both entries.

**Call relations**: This asynchronous test sets up real files on disk, then calls `build_workspace_section_with_user_root`. It verifies that the builder reads the directory contents and turns them into a human-readable tree.

*Call graph*: 5 external calls (new, assert!, create_dir, write, build_workspace_section_with_user_root).


##### `workspace_section_includes_user_root_tree_when_distinct`  (lines 263–282)

```
async fn workspace_section_includes_user_root_tree_when_distinct()
```

**Purpose**: Checks that a separate user root directory is summarized when it is different from the current workspace. It also checks that hidden dotfiles are not included in that summary.

**Data flow**: The test creates three areas: a current working directory, a Git-like root, and a user root. It puts visible files and folders in them, asks the workspace builder to include the user root, and then checks that the user root tree includes `code/` but excludes `.zshrc`.

**Call relations**: This asynchronous test drives `build_workspace_section_with_user_root` with both a current directory and a separate user root. It confirms the workspace builder can show useful nearby structure without exposing hidden home-directory files.

*Call graph*: 5 external calls (new, assert!, create_dir_all, write, build_workspace_section_with_user_root).


##### `recent_work_section_groups_threads_by_cwd`  (lines 285–332)

```
async fn recent_work_section_groups_threads_by_cwd()
```

**Purpose**: Checks that recent past sessions are grouped by the Git repository or directory where they happened. This makes prior work easier to scan than a flat list of unrelated sessions.

**Data flow**: The test creates a temporary repository, two workspace folders inside it, and one outside folder. It builds fake stored threads for those locations, asks the recent-work builder to summarize them from the current directory, and checks that sessions inside the same Git repo are grouped together while the outside session appears under its own directory.

**Call relations**: This asynchronous test uses `stored_thread` to create realistic recent-session records, sets up real directories and a Git repository, then calls `build_recent_work_section`. It verifies that the recent-work builder connects sessions by location and presents the first user asks under the right headings.

*Call graph*: 7 external calls (new, assert!, new, create_dir, create_dir_all, build_recent_work_section, vec!).


### `core/src/realtime_conversation_tests.rs`

`test` · `test run`

This is a test file, so it does not run in the normal application path. Instead, it acts like a checklist for the real-time conversation code. The real-time system can receive a handoff request, meaning an ongoing voice or live session asks the main Codex logic to take over some text. These tests make sure that handoff text is picked from the right place: the explicit handoff input is preferred, but if that is empty, the active transcript can be turned into plain text like “user: hello”.

The file also tests how that text is wrapped before being sent onward. The wrapper uses a small XML-like format called `<realtime_delegation>`. Because user text can contain characters like `<`, `>`, or `&`, the tests confirm those are escaped so the wrapper cannot be broken by ordinary text. This is like putting a fragile note inside a labeled envelope and making sure the note cannot accidentally tear the envelope.

One async test checks that the current active handoff stored in shared state can be set and then cleared. The final tests check request headers: version 1 of the real-time websocket API needs an `openai-alpha` header, while version 2 must not include it.

#### Function details

##### `prefers_handoff_input_transcript_over_active_transcript`  (lines 14–34)

```
fn prefers_handoff_input_transcript_over_active_transcript()
```

**Purpose**: Checks that when a handoff request contains both a direct input transcript and an active conversation transcript, the direct input wins. This matters because the handoff input is the clearest instruction about what should be delegated.

**Data flow**: The test builds a handoff request with `input_transcript` set to `ignored` and also includes two active transcript messages. It asks the handoff text helper to extract the text. The expected result is only `ignored`, showing that the active transcript is not used when direct input is present.

**Call relations**: The test runner calls this function during the test suite. Inside, it creates sample transcript entries and uses an equality assertion to compare the helper’s output with the expected text.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `extracts_text_from_handoff_request_active_transcript_if_input_missing`  (lines 37–51)

```
fn extracts_text_from_handoff_request_active_transcript_if_input_missing()
```

**Purpose**: Checks the fallback path when the handoff request has no direct input text. In that case, the helper should turn the active transcript into readable text.

**Data flow**: The test starts with an empty `input_transcript` and one active transcript entry from the user saying `hello`. The helper reads that request and produces `user: hello`. The assertion confirms that the transcript becomes the handoff text.

**Call relations**: The test runner calls this test when validating real-time handoff behavior. The test creates a small handoff request, then uses an equality assertion to verify that the extraction helper falls back to the active transcript.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `wraps_handoff_with_transcript_delta`  (lines 54–77)

```
fn wraps_handoff_with_transcript_delta()
```

**Purpose**: Checks that a full handoff delegation includes both the direct input and the recent transcript context. This helps the receiving side understand not only the requested task, but also what was just said.

**Data flow**: The test builds a handoff request with direct input `delegate this` and two active transcript lines. The delegation helper turns that into a `<realtime_delegation>` block containing an `<input>` section and a `<transcript_delta>` section. The assertion checks the full formatted string.

**Call relations**: The test runner calls this function as part of the handoff tests. It prepares realistic handoff data and uses an equality assertion to make sure the delegation-building helper includes the transcript context in the expected format.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `extracts_text_from_handoff_request_input_transcript_if_messages_missing`  (lines 80–91)

```
fn extracts_text_from_handoff_request_input_transcript_if_messages_missing()
```

**Purpose**: Checks that direct handoff input still works when there are no active transcript messages. This protects the simple case where the handoff already carries all needed text.

**Data flow**: The test creates a handoff request with `input_transcript` set to `ignored` and an empty transcript list. The extraction helper reads the request and returns that direct text. The assertion confirms the output is present instead of missing.

**Call relations**: The test runner invokes this test during the suite. The test creates an empty transcript list and checks, through an equality assertion, that the helper does not require conversation messages when direct input exists.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `ignores_empty_handoff_request_input_transcript`  (lines 94–102)

```
fn ignores_empty_handoff_request_input_transcript()
```

**Purpose**: Checks that an entirely empty handoff request produces no text. This prevents the system from forwarding a blank delegation as if it were a real request.

**Data flow**: The test creates a handoff request with an empty `input_transcript` and no active transcript entries. The extraction helper has no usable text to read, so it returns `None`. The assertion confirms there is no delegation text.

**Call relations**: The test runner calls this function with the other real-time handoff tests. It builds an empty request and uses an equality assertion to confirm the helper treats it as absent input.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `wraps_realtime_delegation_input`  (lines 105–110)

```
fn wraps_realtime_delegation_input()
```

**Purpose**: Checks the basic wrapper used to package delegated real-time input. It verifies the simplest case: input text without extra transcript context.

**Data flow**: The test passes `hello` into the wrapper and gives no transcript delta. The wrapper returns a `<realtime_delegation>` block with only an `<input>` section. The assertion compares the exact expected text.

**Call relations**: The test runner calls this small format test. It directly exercises the wrapping helper and uses an equality assertion to lock down the expected envelope format.

*Call graph*: 1 external calls (assert_eq!).


##### `wraps_realtime_delegation_input_with_xml_escaping`  (lines 113–118)

```
fn wraps_realtime_delegation_input_with_xml_escaping()
```

**Purpose**: Checks that special characters are escaped when both input and transcript context are wrapped. This prevents user text from accidentally being interpreted as markup.

**Data flow**: The test sends input containing `<`, `>`, and `&`, plus a transcript delta containing angle brackets. The wrapper converts those characters into safe XML entities such as `&lt;` and `&amp;`. The assertion confirms both sections are safely escaped inside the delegation block.

**Call relations**: The test runner calls this function during formatting tests. It directly checks the wrapper helper with risky-looking text and verifies the exact escaped output using an equality assertion.

*Call graph*: 1 external calls (assert_eq!).


##### `wraps_realtime_delegation_input_with_xml_escaping_without_transcript`  (lines 121–126)

```
fn wraps_realtime_delegation_input_with_xml_escaping_without_transcript()
```

**Purpose**: Checks that escaping still happens when there is no transcript delta. This makes sure the safety behavior is not tied to the optional transcript field.

**Data flow**: The test passes input text with `<`, `>`, and `&`, and no transcript delta. The wrapper escapes the special characters and returns a delegation block with only the safe `<input>` section. The assertion checks the exact result.

**Call relations**: The test runner calls this function with the other wrapper tests. It exercises the same wrapping helper as the transcript case, but confirms the no-transcript path also escapes correctly.

*Call graph*: 1 external calls (assert_eq!).


##### `clears_active_handoff_explicitly`  (lines 129–146)

```
async fn clears_active_handoff_explicitly()
```

**Purpose**: Checks that the stored active handoff can be manually cleared. This matters because once a handoff is finished or canceled, the system must not keep treating an old handoff as active.

**Data flow**: The test creates a bounded async channel and uses it to build a `RealtimeHandoffState`. It sets the shared `active_handoff` value to `handoff_1`, checks that it was stored, then sets it back to `None` and checks that it is gone. The state object is changed in place.

**Call relations**: The async test runner calls this function. The test uses the channel constructor to create the state, then locks the shared handoff field before reading or changing it, and uses equality assertions to verify the before-and-after state.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, bounded).


##### `uses_quicksilver_alpha_header_for_realtime_v1`  (lines 149–161)

```
fn uses_quicksilver_alpha_header_for_realtime_v1()
```

**Purpose**: Checks that version 1 real-time websocket requests include the required `openai-alpha` header. Without this header, the older real-time API path may not be selected correctly.

**Data flow**: The test asks the header-building helper for headers using a session id, an API key, and real-time websocket version 1. It then reads the `openai-alpha` header from the result. The expected value is `quicksilver=v1`.

**Call relations**: The test runner calls this function as part of request-header validation. It calls the real-time request header helper, unwraps the produced headers, and uses an equality assertion to verify the version-specific header is present.

*Call graph*: 2 external calls (assert_eq!, realtime_request_headers).


##### `omits_quicksilver_alpha_header_for_realtime_v2`  (lines 164–171)

```
fn omits_quicksilver_alpha_header_for_realtime_v2()
```

**Purpose**: Checks that version 2 real-time websocket requests do not include the old `openai-alpha` header. This prevents sending obsolete version-1 signaling to the newer API.

**Data flow**: The test asks the header-building helper for headers using real-time websocket version 2. It inspects the resulting header map and confirms there is no `openai-alpha` entry. The output being checked is the absence of that header.

**Call relations**: The test runner calls this function with the other header tests. It calls the same real-time request header helper as the version 1 test, but uses an assertion that the old alpha header is missing for version 2.

*Call graph*: 2 external calls (assert!, realtime_request_headers).
