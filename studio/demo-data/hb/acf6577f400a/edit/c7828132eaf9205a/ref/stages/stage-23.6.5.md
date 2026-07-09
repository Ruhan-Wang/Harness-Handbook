# Memories, rollout, state, and persistence tests  `stage-23.6.5`

This stage is the system’s safety net for the parts that remember things over time. It sits behind the scenes and checks that saved conversations, rollout logs, runtime state, and recovery rules all behave correctly when the program is running, restarting, or cleaning up after trouble.

Several test groups focus on rollout traces: shared fixtures build tiny fake event histories, then reducer tests check how raw events are turned into simpler summaries for code cells, conversations, model inference, terminal tool use, and multi-agent work. Other rollout tests cover thread-level tracing, protocol event mapping, compression, metadata, indexing, state-database links, recording, loading, scanning, and repair.

Another set checks persistence: runtime helpers create isolated temporary folders, while runtime tests verify external-agent import records and database corruption recovery. Memory tests cover prompt building, citation parsing, startup steps, stored summary files, pruning old extension resources, and workspace diffs. Message-history and thread-store tests make sure stored messages and thread files stay readable and trimmed correctly. Ledger tests confirm external-agent session records are updated efficiently without unnecessary rereading.

## Files in this stage

### Trace reducer fixtures and scenarios
Shared reducer fixtures come first, followed by focused replay and reduction tests for code cells, conversations, inference, and tool-specific agent and terminal behavior.

### `rollout-trace/src/reducer/test_support.rs`

`test` · `test setup and assertions`

This module is a compact test helper layer around `TraceWriter` and `replay_bundle`. It defines canonical root thread ids for ordinary and agent-root traces, plus small constructors for common JSON fragments such as a model message item and a generic `ToolCallSummary`. The writer helpers create a temporary trace bundle with stable ids (`trace-1`, `rollout-1`), append the initial `ThreadStarted` event, and optionally target either the normal root thread or the agent-root thread used by multi-agent tests.

The rest of the helpers encode common raw event sequences with as little ceremony as possible: starting turns, building `RawTraceEventContext` values with thread and turn ids, appending inference starts/completions, and writing request/response payload files before appending the corresponding events. `append_completed_inference` is especially useful because it emits both the request payload and the completion event with the correct contextual envelope. The module deliberately avoids hiding scenario-specific ordering; tests still append the interesting events themselves. `expect_replay_error` is the negative-path assertion helper: it runs `replay_bundle`, requires failure, and checks that the resulting error string contains an expected substring, making reducer invariant tests concise and readable.

#### Function details

##### `message`  (lines 20–26)

```
fn message(role: &str, text: &str) -> serde_json::Value
```

**Purpose**: Builds a canonical JSON conversation message item with a role and single text content part. Tests use it to populate inference request and response payloads without repeating the raw schema shape.

**Data flow**: Takes `role` and `text` string slices, constructs a `serde_json::Value` object with `type: "message"`, the provided role, and one `input_text` content entry, and returns that JSON value. It does not touch external state.

**Call relations**: Scenario tests call this helper when assembling inference payload bodies, especially transcript and compaction tests. It is a leaf fixture function and delegates only to the `json!` macro.

*Call graph*: called by 5 (compaction_boundary_repeats_prefix_and_reuses_replacement_items, context_compaction_boundary_repeats_prefix_and_reuses_replacement_items, encrypted_reasoning_reuses_response_item_in_later_request, encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body, same_encrypted_reasoning_with_different_text_reuses_first_readable_body); 1 external calls (json!).


##### `generic_summary`  (lines 28–34)

```
fn generic_summary(label: &str) -> ToolCallSummary
```

**Purpose**: Creates a `ToolCallSummary::Generic` with a label and no previews. It gives tests a concise way to populate tool-start events when terminal or agent-specific summaries are not under test.

**Data flow**: Takes a label string slice, converts it to `String`, wraps it in `ToolCallSummary::Generic { label, input_preview: None, output_preview: None }`, and returns the summary value. No state is read or written.

**Call relations**: Tool and terminal tests use this helper when appending `ToolCallStarted` events. It is a pure constructor with no downstream delegation.

*Call graph*: called by 4 (code_mode_write_stdin_result_projects_structured_exec_fields, dispatch_write_stdin_payload_reduces_to_terminal_operation, exec_tool_reduces_to_terminal_operation_and_session, write_stdin_operation_reuses_existing_terminal_session).


##### `create_started_writer`  (lines 36–38)

```
fn create_started_writer(temp: &TempDir) -> anyhow::Result<TraceWriter>
```

**Purpose**: Creates a temporary trace writer already initialized with the standard root thread. It is the default setup path for most reducer tests.

**Data flow**: Takes a `&TempDir`, forwards to `create_started_writer_for_thread` with `ROOT_THREAD_ID` and `/root`, and returns the resulting `TraceWriter`. It writes the initial bundle files and thread-start event indirectly through the delegated helper.

**Call relations**: Many reducer tests call this as their first setup step. It is a thin wrapper over `create_started_writer_for_thread` that fixes the common root-thread identity.

*Call graph*: calls 1 internal fn (create_started_writer_for_thread); called by 29 (cancelled_turn_terminates_unfinished_code_cell, code_cell_lifecycle_links_nested_tools_waits_and_outputs, fast_code_cell_lifecycle_waits_for_source_item, runtime_code_cell_ids_can_repeat_across_threads, agent_messages_preserve_routing_and_content, compaction_boundary_repeats_prefix_and_reuses_replacement_items, context_compaction_boundary_repeats_prefix_and_reuses_replacement_items, encrypted_reasoning_reuses_response_item_in_later_request, encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body, full_request_snapshot_can_reorder_existing_items_and_insert_summary (+15 more)).


##### `create_started_agent_writer`  (lines 40–42)

```
fn create_started_agent_writer(temp: &TempDir) -> anyhow::Result<TraceWriter>
```

**Purpose**: Creates a temporary trace writer initialized with the canonical multi-agent root thread id. It standardizes setup for agent-edge tests.

**Data flow**: Takes a `&TempDir`, forwards to `create_started_writer_for_thread` with `AGENT_ROOT_THREAD_ID` and `/root`, and returns the initialized `TraceWriter`. The actual bundle creation and thread-start append happen in the delegated helper.

**Call relations**: Multi-agent tests invoke this instead of `create_started_writer` so edge ids and thread identities match expected fixtures. It is a convenience wrapper around `create_started_writer_for_thread`.

*Call graph*: calls 1 internal fn (create_started_writer_for_thread); called by 9 (agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, close_agent_runtime_payload_targets_thread, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge).


##### `create_started_writer_for_thread`  (lines 44–57)

```
fn create_started_writer_for_thread(
    temp: &TempDir,
    thread_id: &str,
    agent_path: &str,
) -> anyhow::Result<TraceWriter>
```

**Purpose**: Creates a `TraceWriter` bundle with fixed trace/rollout ids and immediately appends a `ThreadStarted` event for the requested thread. It is the shared implementation behind the root and agent-root setup helpers.

**Data flow**: Takes a temp directory, thread id, and agent path; calls `TraceWriter::create` with the temp path and fixed ids, then calls `start_thread` to append the initial thread-start event, and returns the writer. It writes bundle files and mutates the trace log through `TraceWriter`.

**Call relations**: This helper is called by both `create_started_writer` and `create_started_agent_writer`. It delegates the actual event append to `start_thread` so tests can also reuse that lower-level helper directly.

*Call graph*: calls 2 internal fn (start_thread, create); called by 2 (create_started_agent_writer, create_started_writer); 1 external calls (path).


##### `start_thread`  (lines 59–70)

```
fn start_thread(
    writer: &TraceWriter,
    thread_id: &str,
    agent_path: &str,
) -> anyhow::Result<()>
```

**Purpose**: Appends a `ThreadStarted` raw event for a given thread id and agent path. It is the minimal fixture for introducing a thread into the trace.

**Data flow**: Takes a `&TraceWriter`, thread id, and agent path, constructs `RawTraceEventPayload::ThreadStarted` with `metadata_payload: None`, appends it to the writer, and returns `Ok(())`. It mutates the on-disk event log via the writer.

**Call relations**: Called by `create_started_writer_for_thread` and by tests that need to introduce additional child threads. It delegates only to `TraceWriter::append`.

*Call graph*: calls 1 internal fn (append); called by 10 (create_started_writer_for_thread, agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, close_agent_runtime_payload_targets_thread, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge).


##### `start_turn`  (lines 72–74)

```
fn start_turn(writer: &TraceWriter, turn_id: &str) -> anyhow::Result<()>
```

**Purpose**: Appends a `CodexTurnStarted` event for the standard root thread. It is the common turn-start fixture for non-agent tests.

**Data flow**: Takes a writer and turn id, forwards to `start_turn_for_thread` with `ROOT_THREAD_ID`, and returns that result. The actual event append occurs in the delegated helper.

**Call relations**: Many tests call this before appending inference or tool events. It is a convenience wrapper over `start_turn_for_thread`.

*Call graph*: calls 1 internal fn (start_turn_for_thread); called by 27 (cancelled_turn_terminates_unfinished_code_cell, code_cell_lifecycle_links_nested_tools_waits_and_outputs, fast_code_cell_lifecycle_waits_for_source_item, agent_messages_preserve_routing_and_content, compaction_boundary_repeats_prefix_and_reuses_replacement_items, context_compaction_boundary_repeats_prefix_and_reuses_replacement_items, encrypted_reasoning_reuses_response_item_in_later_request, encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body, full_request_snapshot_can_reorder_existing_items_and_insert_summary, incremental_request_carries_prior_request_and_response_items_forward (+15 more)).


##### `start_agent_turn`  (lines 76–78)

```
fn start_agent_turn(writer: &TraceWriter, turn_id: &str) -> anyhow::Result<()>
```

**Purpose**: Appends a `CodexTurnStarted` event for the canonical agent-root thread. It standardizes turn setup in multi-agent tests.

**Data flow**: Takes a writer and turn id, forwards to `start_turn_for_thread` with `AGENT_ROOT_THREAD_ID`, and returns the result. It does not itself build the event payload.

**Call relations**: Agent-edge tests call this before appending tool runtime events. It is a thin wrapper around `start_turn_for_thread`.

*Call graph*: calls 1 internal fn (start_turn_for_thread); called by 9 (agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, close_agent_runtime_payload_targets_thread, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge).


##### `start_turn_for_thread`  (lines 80–90)

```
fn start_turn_for_thread(
    writer: &TraceWriter,
    thread_id: &str,
    turn_id: &str,
) -> anyhow::Result<()>
```

**Purpose**: Appends a `CodexTurnStarted` event for an explicit thread id. It is the shared implementation behind root and agent-root turn helpers.

**Data flow**: Takes a writer, thread id, and turn id, constructs `RawTraceEventPayload::CodexTurnStarted` with owned strings, appends it to the writer, and returns `Ok(())`. It mutates the trace log.

**Call relations**: Called by `start_turn`, `start_agent_turn`, and tests that need child-thread turns. It delegates only to `TraceWriter::append`.

*Call graph*: calls 1 internal fn (append); called by 10 (runtime_code_cell_ids_can_repeat_across_threads, start_agent_turn, start_turn, agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge).


##### `trace_context`  (lines 92–94)

```
fn trace_context(turn_id: &str) -> RawTraceEventContext
```

**Purpose**: Builds a `RawTraceEventContext` for the standard root thread and a given turn. Tests use it when appending context-bearing events.

**Data flow**: Takes a turn id and forwards to `trace_context_for_thread` with `ROOT_THREAD_ID`, returning the resulting context struct. No external state is touched.

**Call relations**: Used by many tests when calling `append_with_context`. It is a convenience wrapper over `trace_context_for_thread`.

*Call graph*: calls 1 internal fn (trace_context_for_thread); called by 10 (cancelled_turn_terminates_unfinished_code_cell, code_cell_lifecycle_links_nested_tools_waits_and_outputs, fast_code_cell_lifecycle_waits_for_source_item, compaction_boundary_repeats_prefix_and_reuses_replacement_items, context_compaction_boundary_repeats_prefix_and_reuses_replacement_items, tool_call_links_model_call_and_followup_output_items, code_mode_write_stdin_result_projects_structured_exec_fields, dispatch_write_stdin_payload_reduces_to_terminal_operation, exec_tool_reduces_to_terminal_operation_and_session, write_stdin_operation_reuses_existing_terminal_session).


##### `trace_context_for_agent`  (lines 96–98)

```
fn trace_context_for_agent(turn_id: &str) -> RawTraceEventContext
```

**Purpose**: Builds a `RawTraceEventContext` for the canonical agent-root thread and a given turn. It avoids repeating the agent-root thread id in tests.

**Data flow**: Takes a turn id and forwards to `trace_context_for_thread` with `AGENT_ROOT_THREAD_ID`, returning the context. It is pure and does not mutate state.

**Call relations**: Agent tests use this when appending tool lifecycle events with explicit context. It is a wrapper over `trace_context_for_thread`.

*Call graph*: calls 1 internal fn (trace_context_for_thread); called by 6 (append_spawn_agent_tool_lifecycle, close_agent_runtime_payload_targets_thread, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge).


##### `trace_context_for_thread`  (lines 100–105)

```
fn trace_context_for_thread(thread_id: &str, turn_id: &str) -> RawTraceEventContext
```

**Purpose**: Constructs a `RawTraceEventContext` with explicit thread and turn ids. It is the base context helper used by all higher-level wrappers.

**Data flow**: Takes thread id and turn id string slices, allocates owned `String`s, and returns `RawTraceEventContext { thread_id: Some(...), codex_turn_id: Some(...) }`. It has no side effects.

**Call relations**: Called by the root and agent context helpers and by tests that need child-thread contexts. It is a pure constructor.

*Call graph*: called by 6 (runtime_code_cell_ids_can_repeat_across_threads, append_completed_inference, trace_context, trace_context_for_agent, agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification).


##### `append_inference_start`  (lines 107–120)

```
fn append_inference_start(
    writer: &TraceWriter,
    inference_call_id: &str,
    codex_turn_id: &str,
    request_payload: RawPayloadRef,
) -> anyhow::Result<()>
```

**Purpose**: Appends an `InferenceStarted` event for the standard root thread. It is the common fixture for tests that want to control the request payload explicitly.

**Data flow**: Takes a writer, inference call id, turn id, and `RawPayloadRef` for the request payload, then forwards to `append_inference_start_for_thread` with `ROOT_THREAD_ID`. It writes the event indirectly through the delegated helper.

**Call relations**: Transcript and inference tests call this when they have already written a request payload file. It is a wrapper over `append_inference_start_for_thread`.

*Call graph*: calls 1 internal fn (append_inference_start_for_thread); called by 21 (agent_messages_preserve_routing_and_content, compaction_boundary_repeats_prefix_and_reuses_replacement_items, context_compaction_boundary_repeats_prefix_and_reuses_replacement_items, encrypted_reasoning_reuses_response_item_in_later_request, encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body, full_request_snapshot_can_reorder_existing_items_and_insert_summary, incremental_request_carries_prior_request_and_response_items_forward, inference_start_rejects_unknown_codex_turn, later_full_request_reuses_prior_json_tool_call_by_position, missing_request_input_is_reducer_error (+11 more)).


##### `append_inference_start_for_thread`  (lines 122–138)

```
fn append_inference_start_for_thread(
    writer: &TraceWriter,
    thread_id: &str,
    codex_turn_id: &str,
    inference_call_id: &str,
    request_payload: RawPayloadRef,
) -> anyhow::Result<()>
```

**Purpose**: Appends an `InferenceStarted` event for an explicit thread and turn using a provided request payload ref. It fills in fixed test model/provider names.

**Data flow**: Takes a writer, thread id, turn id, inference id, and request payload ref; constructs `RawTraceEventPayload::InferenceStarted` with `model: "gpt-test"` and `provider_name: "test-provider"`; appends it; and returns `Ok(())`. It mutates the trace log.

**Call relations**: Called by `append_inference_start` and `append_inference_request`. It centralizes the exact event shape used across tests.

*Call graph*: calls 1 internal fn (append); called by 2 (append_inference_request, append_inference_start).


##### `append_inference_completion`  (lines 140–153)

```
fn append_inference_completion(
    writer: &TraceWriter,
    inference_call_id: &str,
    response_id: &str,
    response_payload: RawPayloadRef,
) -> anyhow::Result<()>
```

**Purpose**: Appends an `InferenceCompleted` event with a supplied response payload and response id. It is the minimal completion helper when the request event has already been written separately.

**Data flow**: Takes a writer, inference call id, response id, and response payload ref, constructs `RawTraceEventPayload::InferenceCompleted` with `upstream_request_id: None`, appends it, and returns `Ok(())`. It writes only the completion event, not the payload file.

**Call relations**: Used by tests that want explicit control over request and response ordering. It delegates only to `TraceWriter::append`.

*Call graph*: calls 1 internal fn (append); called by 7 (encrypted_reasoning_reuses_response_item_in_later_request, incremental_request_carries_prior_request_and_response_items_forward, later_full_request_reuses_prior_json_tool_call_by_position, reasoning_body_preserves_text_summary_and_encoded_content, response_outputs_enter_thread_conversation_on_completion, same_encrypted_reasoning_with_different_text_reuses_first_readable_body, tool_call_links_model_call_and_followup_output_items).


##### `append_inference_request`  (lines 155–165)

```
fn append_inference_request(
    writer: &TraceWriter,
    thread_id: &str,
    turn_id: &str,
    inference_id: &str,
    input: Vec<serde_json::Value>,
) -> anyhow::Result<()>
```

**Purpose**: Writes an inference request payload containing the provided input items and appends the matching `InferenceStarted` event. It is the common one-call fixture for request-side transcript setup.

**Data flow**: Takes a writer, thread id, turn id, inference id, and vector of JSON input items; writes a `RawPayloadKind::InferenceRequest` payload with `{ "input": input }`; then passes the resulting `RawPayloadRef` to `append_inference_start_for_thread`; and returns `Ok(())`. It mutates both payload storage and the event log.

**Call relations**: Called directly by many tests and by `append_completed_inference`. It delegates payload creation to `TraceWriter::write_json_payload` and event append to `append_inference_start_for_thread`.

*Call graph*: calls 2 internal fn (append_inference_start_for_thread, write_json_payload); called by 8 (append_completed_inference, agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge); 1 external calls (json!).


##### `append_completed_inference`  (lines 167–193)

```
fn append_completed_inference(
    writer: &TraceWriter,
    thread_id: &str,
    turn_id: &str,
    inference_id: &str,
    input: Vec<serde_json::Value>,
    output_items: Vec<serde_json::Value>,
)
```

**Purpose**: Writes both sides of a completed inference: the request payload/start event and the response payload/completion event with matching ids. It is the highest-level inference fixture in this module.

**Data flow**: Takes a writer, thread id, turn id, inference id, request input items, and response output items. It first calls `append_inference_request`, then writes an `InferenceResponse` payload containing `response_id: resp-{inference_id}` and `output_items`, then appends an `InferenceCompleted` event with explicit thread/turn context, and returns `Ok(())`.

**Call relations**: Used by tests that need a fully materialized inference exchange with minimal boilerplate. It composes `append_inference_request`, `trace_context_for_thread`, `TraceWriter::write_json_payload`, and `TraceWriter::append_with_context`.

*Call graph*: calls 4 internal fn (append_inference_request, trace_context_for_thread, append_with_context, write_json_payload); called by 1 (agent_result_edge_links_child_result_to_parent_notification); 2 external calls (format!, json!).


##### `expect_replay_error`  (lines 195–202)

```
fn expect_replay_error(temp: &TempDir, expected: &str) -> anyhow::Result<()>
```

**Purpose**: Asserts that replaying the temporary bundle fails and that the error message contains a specific substring. It is the shared negative-path assertion helper for reducer invariant tests.

**Data flow**: Takes a temp directory and expected substring, calls `replay_bundle(temp.path())`, panics if replay succeeds, converts the error to a string, asserts substring containment, and returns `Ok(())`. It reads the bundle from disk but does not mutate it.

**Call relations**: Reducer error tests call this after constructing an invalid event sequence. It directly drives `replay_bundle` and performs the assertion logic locally.

*Call graph*: called by 5 (inference_start_rejects_unknown_codex_turn, missing_request_input_is_reducer_error, model_visible_call_id_reuse_with_different_content_is_reducer_error, unknown_previous_response_id_is_reducer_error, unsupported_model_item_is_reducer_error); 4 external calls (path, assert!, replay_bundle, panic!).


### `rollout-trace/src/reducer/code_cell_tests.rs`

`test` · `test execution`

This test module builds temporary trace bundles with `create_started_writer`, appends raw inference, code-cell, tool-call, and turn events, then replays them through `replay_bundle` to inspect the reduced rollout. The scenarios are intentionally shaped around the tricky invariants in `code_cell.rs`: runtime `CodeCellStarted` can precede the inference completion that introduces the model-visible `custom_tool_call`; initial-response and end events can arrive before the source item exists; nested tool calls should attach to the parent code cell; `wait` calls should be linked by parsing `cell_id` from invocation arguments; and later model-visible `custom_tool_call_output` items should gain `ProducerRef::CodeCell`.

The tests also cover lifecycle cleanup at turn end, asserting that a cancelled turn converts a still-running code cell into `CodeCellRuntimeStatus::Terminated` and `ExecutionStatus::Cancelled`. Another scenario proves that runtime cell ids are only unique within a thread by creating root and child threads that both use runtime cell id `1` and confirming they reduce to distinct code cells. A small helper, `test_reduced_code_cell_id`, mirrors the production id format so assertions can address `rollout.code_cells` directly.

#### Function details

##### `code_cell_lifecycle_links_nested_tools_waits_and_outputs`  (lines 23–190)

```
fn code_cell_lifecycle_links_nested_tools_waits_and_outputs() -> anyhow::Result<()>
```

**Purpose**: Builds a multi-turn trace where a code cell starts before inference completion, later yields, spawns a nested tool call, is waited on by a model-visible `wait` tool, and finally produces a follow-up output item. It asserts that all reverse links and statuses are present on the reduced `CodeCell` and conversation item.

**Data flow**: Creates a temp bundle, writes inference request/response payloads plus `CodeCellStarted`, `CodeCellInitialResponse`, nested `ToolCallStarted/Ended`, second-turn `wait` invocation payload, and `CodeCellEnded`. After `replay_bundle`, it derives the reduced id with `test_reduced_code_cell_id`, reads the resulting `CodeCell`, locates the follow-up output item id from the second inference request, and asserts thread id, runtime/execution status, runtime cell id, nested tool ids, wait tool ids, output item ids, producer refs, and source item kind.

**Call relations**: This test drives the full happy-path call flow through code-cell start queueing, lifecycle replay, nested-tool requester reduction, wait linking from request payload parsing, and late output-item attachment.

*Call graph*: calls 4 internal fn (test_reduced_code_cell_id, create_started_writer, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `fast_code_cell_lifecycle_waits_for_source_item`  (lines 193–269)

```
fn fast_code_cell_lifecycle_waits_for_source_item() -> anyhow::Result<()>
```

**Purpose**: Verifies that a code cell can start, fail on initial response, and end before the inference response containing its source `custom_tool_call` item is reduced. The reducer should queue all lifecycle events and replay them once the source item appears.

**Data flow**: Writes a trace where `CodeCellStarted`, `CodeCellInitialResponse(Failed)`, and `CodeCellEnded(Failed)` all occur before `InferenceCompleted` with the matching `custom_tool_call`. After replay it computes the reduced id with `test_reduced_code_cell_id`, reads the reduced cell, and asserts thread id, failed runtime/execution status, runtime cell id, and source item kind.

**Call relations**: This test specifically exercises the pending-start and pending-lifecycle-event paths, proving that `flush_pending_code_cell_starts` and lifecycle replay preserve failure state for very fast cells.

*Call graph*: calls 4 internal fn (test_reduced_code_cell_id, create_started_writer, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `cancelled_turn_terminates_unfinished_code_cell`  (lines 272–334)

```
fn cancelled_turn_terminates_unfinished_code_cell() -> anyhow::Result<()>
```

**Purpose**: Checks that turn-end cleanup closes a still-running code cell when the owning turn is cancelled. The reduced cell should not remain live after replay.

**Data flow**: Creates a trace with an inference request/response that introduces an `exec` call, then emits `CodeCellStarted` followed by `CodexTurnEnded { status: Cancelled }` without a code-cell end event. After replay it resolves the reduced id via `test_reduced_code_cell_id`, reads the cell, and asserts `runtime_status == Terminated`, `execution.status == Cancelled`, and `execution.ended_seq` equals the turn-end event sequence.

**Call relations**: This test targets the turn-end cleanup path that calls `terminate_running_code_cells_for_turn_end` and then `end_code_cell` with a synthesized terminal status.

*Call graph*: calls 4 internal fn (test_reduced_code_cell_id, create_started_writer, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `runtime_code_cell_ids_can_repeat_across_threads`  (lines 337–423)

```
fn runtime_code_cell_ids_can_repeat_across_threads() -> anyhow::Result<()>
```

**Purpose**: Proves that runtime `cell_id` values are scoped by thread rather than globally unique. Two threads can both use runtime cell id `1` and still reduce to separate code cells.

**Data flow**: Creates root and child threads, starts turns in both, then for each thread writes an inference request, `CodeCellStarted` with runtime cell id `1`, inference completion with a distinct model-visible call id, and `CodeCellEnded`. After replay it computes both reduced ids with `test_reduced_code_cell_id` and asserts each reduced cell has the correct thread id and the same runtime cell id string.

**Call relations**: This test exercises the `(thread_id, runtime_cell_id)` mapping logic used by runtime-id recording and lookup, ensuring cross-thread collisions do not merge cells.

*Call graph*: calls 4 internal fn (test_reduced_code_cell_id, create_started_writer, start_turn_for_thread, trace_context_for_thread); 5 external calls (new, assert_eq!, replay_bundle, format!, json!).


##### `test_reduced_code_cell_id`  (lines 425–427)

```
fn test_reduced_code_cell_id(model_visible_call_id: &str) -> String
```

**Purpose**: Constructs the expected reduced code-cell id string used in assertions. It mirrors the production `code_cell:{model_visible_call_id}` format.

**Data flow**: Takes a model-visible call id string and returns `format!("code_cell:{model_visible_call_id}")`. It has no side effects.

**Call relations**: All tests in this file use it to address entries in `rollout.code_cells` without duplicating the id-formatting literal inline.

*Call graph*: called by 4 (cancelled_turn_terminates_unfinished_code_cell, code_cell_lifecycle_links_nested_tools_waits_and_outputs, fast_code_cell_lifecycle_waits_for_source_item, runtime_code_cell_ids_can_repeat_across_threads); 1 external calls (format!).


### `rollout-trace/src/reducer/conversation_tests.rs`

`test` · `test execution`

This test module constructs temporary traces and replays them to assert the exact shape of reduced conversation state. The scenarios cover both positive and negative behavior. Positive cases verify that full request snapshots reuse prior items by content and position without deduping newly inserted identical items, response outputs are appended to thread conversation immediately, agent messages preserve routing metadata and encoded content, incremental requests reconstruct omitted prefixes from `previous_response_id`, and full snapshots may reorder existing items or insert new summary items. Several tests focus on reasoning items, proving that encrypted reasoning can reuse prior ids across request/response boundaries, merge complementary text and summary evidence, and refuse to overwrite the first readable body with conflicting later text.

The file also exercises compaction semantics: checkpoint installation inserts a structural `CompactionMarker`, replacement history gets fresh ids with `ProducerRef::Compaction`, and the next full request reconciles against replacement items rather than pre-compaction history. Tool-linking behavior is checked by asserting that a model-visible function call item and a later function-call output item both attach to the same reduced tool call with reciprocal producer refs. Negative tests ensure replay fails on unsupported model item types, missing request input, unknown `previous_response_id`, reused `call_id` with different content, and inference starts that reference unknown turns.

#### Function details

##### `request_snapshots_reuse_history_without_deduping_new_identical_items`  (lines 27–68)

```
fn request_snapshots_reuse_history_without_deduping_new_identical_items() -> anyhow::Result<()>
```

**Purpose**: Verifies that a later full request snapshot reuses an earlier identical item at the same logical history position but still creates a fresh id for a newly inserted identical item later in the snapshot. This captures the reducer's 'reuse at most once per snapshot' rule.

**Data flow**: Builds two turns with inference requests: first `[user ok]`, then `[user ok, assistant ack, user ok]`. After replay it reads both inference calls' `request_item_ids` and asserts the first item id is reused, the third item id is distinct from the first, the total conversation item count is three, and the thread's conversation list equals the second request snapshot.

**Call relations**: This test exercises full-snapshot reconciliation and `find_matching_snapshot_item` behavior without involving responses or tools.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 5 external calls (new, assert_eq!, assert_ne!, replay_bundle, json!).


##### `response_outputs_enter_thread_conversation_on_completion`  (lines 71–111)

```
fn response_outputs_enter_thread_conversation_on_completion() -> anyhow::Result<()>
```

**Purpose**: Checks that inference response output items become part of the thread conversation as soon as the response is reduced, not only when a later request echoes them back. It validates immediate append semantics for model-produced output.

**Data flow**: Creates one inference request and one response containing an assistant message, replays the bundle, reads the inference call, concatenates its request and response item ids, and asserts the thread's `conversation_item_ids` exactly match that combined sequence.

**Call relations**: This test targets `reduce_inference_response` and the append-to-thread behavior after response reconciliation.

*Call graph*: calls 4 internal fn (append_inference_completion, append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `agent_messages_preserve_routing_and_content`  (lines 114–195)

```
fn agent_messages_preserve_routing_and_content() -> anyhow::Result<()>
```

**Purpose**: Ensures `agent_message` items normalize into conversation items that retain author/recipient routing metadata and convert content into the expected text or encoded parts. It validates the protocol-model parsing path.

**Data flow**: Writes an inference request containing two `agent_message` items, one with input text and one with encrypted content. After replay it maps the resulting request item ids to tuples of role, channel, kind, agent metadata, and body, then asserts those tuples equal the expected `ConversationRole::Assistant`, `ConversationChannel::Analysis`, `ConversationItemKind::Message`, `AgentMessageMetadata`, and `ConversationBody` values.

**Call relations**: This test specifically exercises normalization through `normalize_agent_message_item` and subsequent conversation-item creation.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `later_full_request_reuses_prior_json_tool_call_by_position`  (lines 198–256)

```
fn later_full_request_reuses_prior_json_tool_call_by_position() -> anyhow::Result<()>
```

**Purpose**: Verifies that a function-call item produced in one response is reused when a later full request snapshot includes the same call content and `call_id`. It confirms that response-produced conversation items can become part of later request snapshots.

**Data flow**: Creates an initial request, a response containing a `function_call`, then a second-turn full request containing the original user message plus the same function call. After replay it reads both inference calls and asserts the second request item ids equal the first request item id followed by the first response item id, and that only two conversation items exist overall.

**Call relations**: This test exercises full-snapshot reuse across request/response boundaries and call-id/content matching for JSON-backed function calls.

*Call graph*: calls 4 internal fn (append_inference_completion, append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `incremental_request_carries_prior_request_and_response_items_forward`  (lines 259–335)

```
fn incremental_request_carries_prior_request_and_response_items_forward() -> anyhow::Result<()>
```

**Purpose**: Checks that an incremental request with `previous_response_id` reconstructs the omitted prefix from the previous request and response before appending its delta item. It also verifies token usage extraction from the earlier response.

**Data flow**: Builds an initial request and response with token usage and a `function_call`, then a second-turn incremental request containing only a `function_call_output` and `previous_response_id`. After replay it reads both inference calls and asserts the second request item ids equal prior request item + prior response item + new output item, the thread conversation equals that reconstructed sequence, and the first inference's usage contains `input_tokens == 10`.

**Call relations**: This test targets the incremental-request branch in `reduce_inference_request` and the usage parsing path in `reduce_inference_response`.

*Call graph*: calls 4 internal fn (append_inference_completion, append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `full_request_snapshot_can_reorder_existing_items_and_insert_summary`  (lines 338–378)

```
fn full_request_snapshot_can_reorder_existing_items_and_insert_summary() -> anyhow::Result<()>
```

**Purpose**: Verifies that a full request snapshot may reorder previously seen items and insert a new summary item while still reusing matching existing items by content. It demonstrates that full snapshots are not strictly positional.

**Data flow**: Creates a first request `[developer, user]` and a second-turn full request `[user, summary, developer]`. After replay it compares the two request item-id vectors and asserts the reordered user and developer items reuse prior ids, the inserted summary gets a fresh id distinct from both originals, and the total conversation item count is three.

**Call relations**: This test exercises `ReconcileMode::FullSnapshot` and content-based reuse via `find_matching_snapshot_item`.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 5 external calls (new, assert_eq!, assert_ne!, replay_bundle, json!).


##### `reasoning_body_preserves_text_summary_and_encoded_content`  (lines 381–428)

```
fn reasoning_body_preserves_text_summary_and_encoded_content() -> anyhow::Result<()>
```

**Purpose**: Checks that a reasoning response item preserves all three supported body forms—readable text, summary text, and encrypted content—in the stored conversation item. It validates the normalization layout for reasoning bodies.

**Data flow**: Creates an inference response containing one `reasoning` item with content, summary, and `encrypted_content`. After replay it reads the response item id and asserts the stored `body.parts` equal `[Text("raw reasoning"), Summary("brief summary"), Encoded("encrypted_content", "encoded-reasoning")]`.

**Call relations**: This test focuses on `normalize_reasoning_item` and the exact ordering of reasoning parts in the reduced conversation item.

*Call graph*: calls 4 internal fn (append_inference_completion, append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `encrypted_reasoning_reuses_response_item_in_later_request`  (lines 431–528)

```
fn encrypted_reasoning_reuses_response_item_in_later_request() -> anyhow::Result<()>
```

**Purpose**: Verifies that a later request carrying only encrypted reasoning can reuse a prior response reasoning item that had readable text, as long as the encrypted identity matches. It also checks that the original readable body is preserved.

**Data flow**: Builds a first request with a user message, a response with readable reasoning plus a function call, then a second-turn full request containing the same user message, encrypted-only reasoning with the same `encrypted_content`, the same function call, and a function-call output. After replay it asserts the second request item ids reuse the first request item, first response reasoning item, and first response function-call item, with a fresh output item appended; it also asserts the reused reasoning item's body still contains the original readable text plus encoded content and that the thread conversation equals the second request snapshot.

**Call relations**: This test exercises reasoning-specific equality via encrypted identity and reuse across response-to-request reconciliation.

*Call graph*: calls 5 internal fn (append_inference_completion, append_inference_start, create_started_writer, message, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body`  (lines 531–595)

```
fn encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body() -> anyhow::Result<()>
```

**Purpose**: Checks that two sightings of the same encrypted reasoning item can merge complementary readable evidence, such as text from one sighting and summary from another. The reducer should keep one item id and enrich its body.

**Data flow**: Creates two turns: the first request contains user + text-only reasoning, the second request contains user + summary-only reasoning with the same `encrypted_content`. After replay it reads both inference calls, asserts the second request reused the first reasoning item id, and checks that the stored body now contains text, summary, and encoded parts in order while the total conversation item count remains two.

**Call relations**: This test targets `merge_reasoning_body` through repeated sightings during full-snapshot reconciliation.

*Call graph*: calls 4 internal fn (append_inference_start, create_started_writer, message, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `same_encrypted_reasoning_with_different_text_reuses_first_readable_body`  (lines 598–672)

```
fn same_encrypted_reasoning_with_different_text_reuses_first_readable_body() -> anyhow::Result<()>
```

**Purpose**: Verifies that conflicting later readable text for the same encrypted reasoning identity does not overwrite the first readable body. The item id is reused, but the original readable evidence wins.

**Data flow**: Creates a first request with a user message, a response with reasoning text `first text` and `encrypted_content`, then a second-turn request with the same user message and reasoning text `different text` but the same encrypted content. After replay it asserts the second request reused the first response reasoning item id and that the stored body still contains only the original text plus encoded content, with no replacement by the conflicting later text.

**Call relations**: This test exercises the conservative branch of `merge_reasoning_body`, where encrypted identity matches but readable text is not a safe upgrade.

*Call graph*: calls 5 internal fn (append_inference_completion, append_inference_start, create_started_writer, message, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `model_visible_call_id_reuse_with_different_content_is_reducer_error`  (lines 675–711)

```
fn model_visible_call_id_reuse_with_different_content_is_reducer_error() -> anyhow::Result<()>
```

**Purpose**: Ensures replay fails when the same model-visible `call_id` is reused for a function call with different content in the same thread. This protects stable linkage between transcript items and reduced tool/code-cell nodes.

**Data flow**: Writes two turns whose requests both contain `function_call` items with `call_id: call-1` but different JSON arguments, then invokes `expect_replay_error` and asserts the error message mentions reused call id with different content.

**Call relations**: This negative test targets `ensure_call_id_consistency` during request reconciliation.

*Call graph*: calls 4 internal fn (append_inference_start, create_started_writer, expect_replay_error, start_turn); 2 external calls (new, json!).


##### `unsupported_model_item_is_reducer_error`  (lines 714–736)

```
fn unsupported_model_item_is_reducer_error() -> anyhow::Result<()>
```

**Purpose**: Checks that unknown model item types are rejected rather than silently skipped. This keeps normalization exhaustive and replay failures explicit when the wire schema evolves.

**Data flow**: Creates an inference request containing one item with `type: new_unhandled_model_item`, then calls `expect_replay_error` and asserts the message mentions the unsupported model item type.

**Call relations**: This test exercises the default error branch in `normalize_model_item`.

*Call graph*: calls 4 internal fn (append_inference_start, create_started_writer, expect_replay_error, start_turn); 2 external calls (new, json!).


##### `missing_request_input_is_reducer_error`  (lines 739–753)

```
fn missing_request_input_is_reducer_error() -> anyhow::Result<()>
```

**Purpose**: Verifies that an inference request payload without an `input` field fails replay. The reducer requires request snapshots to be explicit model-visible transcript evidence.

**Data flow**: Writes an inference request payload containing only `model`, starts inference, and then calls `expect_replay_error` expecting a message that the payload did not contain input.

**Call relations**: This negative test targets the early validation in `reduce_inference_request`.

*Call graph*: calls 4 internal fn (append_inference_start, create_started_writer, expect_replay_error, start_turn); 2 external calls (new, json!).


##### `unknown_previous_response_id_is_reducer_error`  (lines 756–771)

```
fn unknown_previous_response_id_is_reducer_error() -> anyhow::Result<()>
```

**Purpose**: Checks that incremental requests referencing a nonexistent `previous_response_id` fail replay. The reducer must be able to reconstruct the omitted prefix exactly.

**Data flow**: Creates a request with `previous_response_id: resp-missing` and one user input item, starts inference, and then calls `expect_replay_error` expecting an unknown previous-response-id message.

**Call relations**: This test exercises the incremental-request lookup branch in `reduce_inference_request`.

*Call graph*: calls 4 internal fn (append_inference_start, create_started_writer, expect_replay_error, start_turn); 2 external calls (new, json!).


##### `compaction_boundary_repeats_prefix_and_reuses_replacement_items`  (lines 774–874)

```
fn compaction_boundary_repeats_prefix_and_reuses_replacement_items() -> anyhow::Result<()>
```

**Purpose**: Validates the full compaction install flow: input history is recorded, a structural marker is inserted, replacement items get compaction producer refs and fresh ids, and the next full request reconciles against replacement history rather than pre-compaction items. It also checks the encoded compaction summary item shape.

**Data flow**: Creates an initial request with developer and user items, emits a `CompactionInstalled` event with checkpoint payload containing `input_history` and `replacement_history`, then starts a second turn with a full request that repeats developer plus the replacement history. After replay it reads the first and second inference calls and the installed `Compaction`, asserting input ids match the first request, the second request reuses replacement item ids after the repeated developer prefix, the marker item has kind `CompactionMarker`, empty body, and `ProducerRef::Compaction`, the repeated developer gets a fresh post-compaction id, replacement items have compaction producer refs, and the compaction summary item is a summary-channel message with one encoded part.

**Call relations**: This test exercises `reduce_compaction_checkpoint`, `reduce_compaction_installed_event`, pending replacement snapshot handling, and post-compaction full-request reconciliation.

*Call graph*: calls 5 internal fn (append_inference_start, create_started_writer, message, start_turn, trace_context); 5 external calls (new, assert_eq!, assert_ne!, replay_bundle, json!).


##### `context_compaction_boundary_repeats_prefix_and_reuses_replacement_items`  (lines 877–943)

```
fn context_compaction_boundary_repeats_prefix_and_reuses_replacement_items() -> anyhow::Result<()>
```

**Purpose**: Checks that `context_compaction` items normalize the same way as `compaction` items inside replacement history. It focuses on the summary-channel encoded-body representation.

**Data flow**: Builds the same compaction scenario as the previous test but uses `type: context_compaction` in replacement history. After replay it reads the installed `Compaction` and asserts the third replacement item has channel `Summary`, kind `Message`, and an encoded `encrypted_content` body part.

**Call relations**: This test targets the alternate compaction item-type branch in normalization while still relying on compaction checkpoint installation.

*Call graph*: calls 5 internal fn (append_inference_start, create_started_writer, message, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `tool_call_links_model_call_and_followup_output_items`  (lines 946–1040)

```
fn tool_call_links_model_call_and_followup_output_items() -> anyhow::Result<()>
```

**Purpose**: Verifies that a reduced tool call links to both the model-visible function-call item that started it and the later function-call-output item that carries its result back into conversation history. It also checks the reciprocal producer ref on the output item.

**Data flow**: Creates an inference request and response containing a `function_call`, emits `ToolCallStarted` and `ToolCallEnded`, then starts a second turn with an incremental request carrying the matching `function_call_output`. After replay it reads both inference calls, the reduced tool call, and the follow-up output item id, then asserts the first inference recorded the started tool call id, the tool call's `model_visible_call_item_ids` equal the first response item ids, the tool call's `model_visible_output_item_ids` contain the follow-up output item id, and the conversation item's `produced_by` is `ProducerRef::Tool { tool_call_id: "tool-1" }`.

**Call relations**: This test exercises the conversation-to-tool linking hooks that run during item reconciliation and later output-item attachment.

*Call graph*: calls 5 internal fn (append_inference_completion, append_inference_start, create_started_writer, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `inference_start_rejects_unknown_codex_turn`  (lines 1043–1056)

```
fn inference_start_rejects_unknown_codex_turn() -> anyhow::Result<()>
```

**Purpose**: Ensures inference start fails when it references a Codex turn that has not been created. This protects thread/turn consistency before request reduction begins.

**Data flow**: Writes an inference request payload, starts inference against `turn-missing`, and then calls `expect_replay_error` expecting an error about an unknown codex turn.

**Call relations**: This negative test targets the validation in `TraceReducer::start_inference_call` before `reduce_inference_request` is invoked.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, expect_replay_error); 2 external calls (new, json!).


### `rollout-trace/src/reducer/inference_tests.rs`

`test` · `test execution`

This test module focuses on the interaction between inference terminal events and turn-end cleanup. Each test writes a temporary trace bundle, replays it, and inspects the reduced `InferenceCall` plus any conversation items created from response payloads. The first scenario confirms that `InferenceCancelled` with a partial response payload still reduces that payload into conversation items, marks the inference as cancelled, stores the upstream request id, and tags the response item with `ProducerRef::Inference`. The second scenario covers the cleanup path where a turn ends cancelled before any inference terminal event arrives; the reducer should close the still-running inference using the turn-end sequence.

The final test exercises the subtle race where turn-end cleanup marks an inference failed, and only afterward does a late `InferenceCancelled` event arrive with a partial response payload and upstream request id. The reducer must preserve the earlier failed execution status and end sequence while still recording the late raw response payload id, upstream request id, and reduced partial response item. Together these tests document the intended precedence rules between turn lifecycle and asynchronous stream-mapper observations.

#### Function details

##### `cancelled_inference_reduces_partial_response_items`  (lines 16–70)

```
fn cancelled_inference_reduces_partial_response_items() -> anyhow::Result<()>
```

**Purpose**: Verifies that a cancelled inference can still contribute partial response items to the reduced conversation. It also checks that cancellation metadata is preserved on the `InferenceCall`.

**Data flow**: Creates a turn and inference start, writes a partial inference-response payload containing one assistant message, emits `InferenceCancelled` with `upstream_request_id` and that payload, replays the bundle, then reads the reduced inference and its first response item id. It asserts cancelled execution status, stored upstream request id, one response item, the response item's kind, and its `ProducerRef::Inference`.

**Call relations**: This test exercises `complete_inference_call` on the cancelled-event branch together with `reduce_inference_response` for partial payloads.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `cancelled_turn_closes_running_inference_call`  (lines 73–97)

```
fn cancelled_turn_closes_running_inference_call() -> anyhow::Result<()>
```

**Purpose**: Checks that turn-end cleanup closes an inference call that never emitted its own terminal event. The reduced inference should inherit the turn-end cancellation and sequence.

**Data flow**: Creates a turn and inference start, emits `CodexTurnEnded { status: Cancelled }`, replays the bundle, reads the reduced inference, and asserts `execution.status == Cancelled` and `execution.ended_seq` equals the turn-end event sequence.

**Call relations**: This test targets `close_running_inference_calls_for_turn_end` independently of `complete_inference_call`.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `late_cancelled_inference_preserves_turn_end_status`  (lines 100–158)

```
fn late_cancelled_inference_preserves_turn_end_status() -> anyhow::Result<()>
```

**Purpose**: Verifies that a late cancelled inference event with partial response evidence does not overwrite a terminal status already set by turn-end cleanup. It should still record the late payload and upstream request id.

**Data flow**: Creates a turn and inference start, emits `CodexTurnEnded { status: Failed }`, then emits `InferenceCancelled` with `upstream_request_id` and a partial response payload containing one assistant message. After replay it reads the reduced inference and response item id, asserting the execution status remains `Failed`, the ended sequence remains the turn-end sequence, `raw_response_payload_id` equals the late payload id, `upstream_request_id` is stored, one response item exists, and that item's body contains the late partial text.

**Call relations**: This test exercises the precedence logic inside `complete_inference_call` that preserves non-running execution status while still accepting late response evidence.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


### `rollout-trace/src/reducer/tool/agents_tests.rs`

`test` · `test execution`

This test module builds realistic multi-agent traces with `TraceWriter` and then replays them to assert on reduced `interaction_edges`, thread origins, and carried payload evidence. The scenarios cover both older protocol payloads and newer sub-agent activity payloads. Several tests validate the reducer's deferred-resolution design: sender-side tool runtime events are written first, then the child or parent thread later receives a model-visible mailbox message through an inference request, and replay must target that exact `ConversationItem` rather than a coarse thread anchor. Complementary fallback tests omit the recipient transcript item and assert that spawn edges fall back to the child thread while preserving raw payload ids, or that agent-result edges fall back to the child thread as source when the child produced no final assistant message.

The module also verifies metadata-only child thread identity: thread-start metadata can mark a thread as `AgentOrigin::Spawned` without creating a delivery edge until a recipient-side message exists. Helper functions at the bottom keep repetitive fixture construction localized: `append_spawn_agent_tool_lifecycle` emits a full spawn tool lifecycle with invocation, runtime begin/end, and result payloads; `inter_agent_message` serializes the older mailbox transport JSON; `target_conversation_item_id` and `text_body` unwrap expected anchor/body shapes for assertions. Together these tests document the reducer's exact matching rules for author, recipient, content, and fallback behavior.

#### Function details

##### `child_thread_metadata_creates_spawn_origin_without_delivery_edge`  (lines 29–84)

```
fn child_thread_metadata_creates_spawn_origin_without_delivery_edge() -> anyhow::Result<()>
```

**Purpose**: Verifies that thread-start metadata alone is enough to mark a child thread as `AgentOrigin::Spawned`, including nickname, default model, task name, and spawn edge id, but does not itself create an interaction edge. It checks the distinction between identity metadata and actual delivery evidence.

**Data flow**: Creates a temp bundle and writer, writes a session-metadata payload containing nested `session_source.subagent.thread_spawn`, appends a `ThreadStarted` event referencing that payload, replays the bundle, and asserts on the resulting thread fields and absence of the corresponding spawn edge in `interaction_edges`.

**Call relations**: This test directly drives `replay_bundle` after constructing only thread-start metadata, without any child-side transcript item. It validates the behavior implemented in thread reduction and the agent-edge module's decision to wait for recipient evidence before materializing a delivery edge.

*Call graph*: calls 1 internal fn (create); 5 external calls (new, assert!, assert_eq!, replay_bundle, json!).


##### `spawn_runtime_payload_targets_delivered_child_message`  (lines 87–147)

```
fn spawn_runtime_payload_targets_delivered_child_message() -> anyhow::Result<()>
```

**Purpose**: Checks that a spawn tool lifecycle resolves to the child thread's delivered task message when that mailbox item later appears in the child transcript. It confirms the preferred target is the exact child-side `ConversationItem`.

**Data flow**: Creates an agent-root writer, starts a parent turn, appends a full spawn tool lifecycle via `append_spawn_agent_tool_lifecycle`, then starts the child thread and turn, appends an inference request containing the delivered inter-agent message, replays the bundle, and asserts that the spawn edge targets a conversation item in the child thread and carries all invocation/runtime/result payload ids.

**Call relations**: The test composes shared writer helpers plus the local spawn-lifecycle helper, then inspects the reduced edge after `replay_bundle`. It specifically exercises deferred edge resolution from pending sender-side state to a later transcript item.

*Call graph*: calls 8 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, append_spawn_agent_tool_lifecycle, inter_agent_message, target_conversation_item_id); 4 external calls (new, assert_eq!, replay_bundle, vec!).


##### `spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item`  (lines 150–195)

```
fn spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item() -> anyhow::Result<()>
```

**Purpose**: Verifies that when a spawned child thread exists but never receives a model-visible task message, the pending spawn edge is finalized to the child thread itself. It confirms the replay-end fallback path.

**Data flow**: Creates an agent-root writer, starts a parent turn, appends the spawn tool lifecycle, starts the child thread without any child inference request, replays the bundle, and asserts that the spawn edge targets `TraceAnchor::Thread`, carries no item ids, and still preserves all raw payload ids.

**Call relations**: This test relies on `replay_bundle` invoking the final spawn-fallback resolution pass after all events are processed. It complements the previous test by omitting the transcript evidence needed for exact item targeting.

*Call graph*: calls 4 internal fn (create_started_agent_writer, start_agent_turn, start_thread, append_spawn_agent_tool_lifecycle); 4 external calls (new, assert!, assert_eq!, replay_bundle).


##### `sub_agent_started_activity_creates_spawn_edge`  (lines 198–286)

```
fn sub_agent_started_activity_creates_spawn_edge() -> anyhow::Result<()>
```

**Purpose**: Checks that a newer sub-agent activity payload with kind `started` can create the same spawn interaction edge as classic spawn runtime payloads. It validates the v2 activity-based path.

**Data flow**: Creates an agent-root writer, starts a parent turn, writes a spawn-agent invocation payload and `ToolCallStarted`, writes a runtime-end activity payload containing `agent_thread_id` and `kind: started`, appends it, then starts the child thread and turn and appends a child inference request containing a structured agent-message item. After replay it asserts that the spawn edge targets the child conversation item and carries the invocation and activity payload ids.

**Call relations**: This test drives the `end_sub_agent_activity` path rather than classic spawn-end parsing. It uses `trace_context_for_agent` and transcript helpers to create the exact ordering where the edge must be queued first and resolved later.

*Call graph*: calls 7 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_agent, target_conversation_item_id); 6 external calls (new, assert_eq!, replay_bundle, format!, json!, vec!).


##### `send_message_runtime_payload_targets_delivered_child_message`  (lines 289–392)

```
fn send_message_runtime_payload_targets_delivered_child_message() -> anyhow::Result<()>
```

**Purpose**: Verifies that classic send-message runtime begin/end payloads produce a `SendMessage` interaction edge targeting the delivered child mailbox item. It also checks that the edge records an end timestamp.

**Data flow**: Creates an agent-root writer, starts a parent turn, writes a send-message invocation payload and tool start, writes runtime begin and runtime end payloads with sender/receiver/prompt, starts the child thread and turn, appends a child inference request containing the delivered mailbox message, replays the bundle, and asserts on edge kind, source, target item thread, carried item ids, and presence of `ended_at_unix_ms`.

**Call relations**: This test exercises both `start_agent_interaction_from_runtime` and `end_agent_interaction_from_runtime` for classic message payloads, with transcript resolution happening afterward during replay.

*Call graph*: calls 8 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_agent, inter_agent_message, target_conversation_item_id); 6 external calls (new, assert!, assert_eq!, replay_bundle, json!, vec!).


##### `send_message_activity_targets_delivered_child_message`  (lines 395–478)

```
fn send_message_activity_targets_delivered_child_message() -> anyhow::Result<()>
```

**Purpose**: Checks that a newer sub-agent activity payload with kind `interacted` for a send-message tool resolves to the delivered child mailbox item. It validates the activity-based send-message path.

**Data flow**: Creates an agent-root writer, starts a parent turn, writes a send-message invocation payload and tool start, writes a runtime-end activity payload naming the child thread and `kind: interacted`, starts the child thread and turn, appends a child inference request containing the delivered mailbox message, replays the bundle, and asserts that the resulting edge targets the child conversation item and carries the invocation and activity payload ids.

**Call relations**: This test specifically drives `end_sub_agent_activity` for `ToolCallKind::SendMessage`. It complements the classic runtime-payload test by proving both transport shapes reduce to the same edge semantics.

*Call graph*: calls 8 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_agent, inter_agent_message, target_conversation_item_id); 5 external calls (new, assert_eq!, replay_bundle, json!, vec!).


##### `followup_activity_targets_delivered_child_message`  (lines 481–564)

```
fn followup_activity_targets_delivered_child_message() -> anyhow::Result<()>
```

**Purpose**: Verifies that an `AssignAgentTask` tool paired with a sub-agent activity payload of kind `interacted` produces an `AssignAgentTask` interaction edge targeting the delivered child message. It covers follow-up task delivery semantics.

**Data flow**: Creates an agent-root writer, starts a parent turn, writes a follow-up-task invocation payload and tool start, writes a runtime-end activity payload naming the child thread and `kind: interacted`, starts the child thread and turn, appends a child inference request containing the delivered mailbox message, replays the bundle, and asserts on edge kind, target item thread, carried item ids, and carried raw payload ids.

**Call relations**: This test exercises the `AssignAgentTask` branch of `end_sub_agent_activity`. It mirrors the send-message activity test but validates the distinct interaction-edge kind.

*Call graph*: calls 8 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_agent, inter_agent_message, target_conversation_item_id); 5 external calls (new, assert_eq!, replay_bundle, json!, vec!).


##### `close_agent_runtime_payload_targets_thread`  (lines 567–687)

```
fn close_agent_runtime_payload_targets_thread() -> anyhow::Result<()>
```

**Purpose**: Checks that close-agent runtime payloads create a `CloseAgent` interaction edge targeting the child thread directly, not a conversation item, and that child thread shutdown does not imply rollout completion. It validates close semantics and status separation.

**Data flow**: Creates an agent-root writer, starts the child thread, starts a parent turn, writes close-agent invocation, runtime begin, runtime end, and result payloads plus matching tool lifecycle events, appends a `ThreadEnded` for the child, replays the bundle, and asserts on edge kind/source/thread target, empty carried item ids, full carried raw payload ids, child thread execution status, and unchanged rollout status.

**Call relations**: This test drives both agent-edge reduction and thread-end reduction in one scenario. It confirms that `upsert_close_agent_interaction` targets threads directly and that `end_thread` does not propagate child completion to rollout completion.

*Call graph*: calls 4 internal fn (create_started_agent_writer, start_agent_turn, start_thread, trace_context_for_agent); 5 external calls (new, assert!, assert_eq!, replay_bundle, json!).


##### `agent_result_edge_links_child_result_to_parent_notification`  (lines 690–774)

```
fn agent_result_edge_links_child_result_to_parent_notification() -> anyhow::Result<()>
```

**Purpose**: Verifies that a child-result notification edge uses the child's final assistant message as source and the parent's delivered notification mailbox item as target when both transcript items exist. It checks the most precise source and target anchoring.

**Data flow**: Creates an agent-root writer, starts a child thread and turn, appends a completed child inference whose output contains an assistant message `done`, writes an `AgentResult` payload and `AgentResultObserved` event, starts a parent turn, appends a parent inference request containing the delivered notification mailbox message, replays the bundle, and asserts that the edge kind is `AgentResult`, the source anchor is the child's result conversation item with text `done`, the target is a parent conversation item, and the carried raw payload ids contain the agent-result payload.

**Call relations**: This test exercises `queue_agent_result_interaction_edge` plus later target resolution from transcript reduction. It also validates `latest_assistant_message_item_for_turn` by expecting the child result item, not the inbound task message, as the source.

*Call graph*: calls 9 internal fn (append_completed_inference, append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_thread, inter_agent_message, target_conversation_item_id); 6 external calls (new, assert_eq!, replay_bundle, json!, panic!, vec!).


##### `agent_result_edge_falls_back_to_child_thread_without_result_message`  (lines 777–868)

```
fn agent_result_edge_falls_back_to_child_thread_without_result_message() -> anyhow::Result<()>
```

**Purpose**: Checks that when a child task produces no final assistant message, the agent-result edge falls back to the child thread as source while still targeting the exact parent-side notification mailbox item. It validates asymmetric fallback behavior.

**Data flow**: Creates an agent-root writer, starts a child thread and turn, appends only a child inference request containing the inbound task mailbox item, writes an `AgentResult` payload and `AgentResultObserved` event for a failed status, starts a parent turn, appends a parent inference request containing the delivered failure notification mailbox message, replays the bundle, and asserts that the edge source is `TraceAnchor::Thread`, the target is a parent conversation item, and the carried raw payload ids contain the agent-result payload.

**Call relations**: This test drives the fallback branch in `queue_agent_result_interaction_edge` where `latest_assistant_message_item_for_turn` returns none. It complements the previous test by proving the reducer does not mistake the inbound child task message for the child's result.

*Call graph*: calls 8 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_thread, inter_agent_message, target_conversation_item_id); 5 external calls (new, assert_eq!, replay_bundle, json!, vec!).


##### `append_spawn_agent_tool_lifecycle`  (lines 877–966)

```
fn append_spawn_agent_tool_lifecycle(
    writer: &TraceWriter,
    turn_id: &str,
) -> anyhow::Result<SpawnAgentToolPayloads>
```

**Purpose**: Writes a complete parent-side spawn-agent tool lifecycle fixture and returns the four payload refs used by the scenario. It centralizes repetitive spawn setup for the spawn-edge tests.

**Data flow**: Takes a writer and parent turn id, writes a tool invocation payload for `spawn_agent`, appends `ToolCallStarted`, writes runtime begin and runtime end payloads and appends matching runtime events, writes a tool result payload and appends `ToolCallEnded`, then returns `SpawnAgentToolPayloads { invocation, begin, end, result }`.

**Call relations**: Called by the two classic spawn tests to keep them focused on child-side delivery behavior. It delegates context creation to `trace_context_for_agent` and all payload/event writes to `TraceWriter` methods.

*Call graph*: calls 3 internal fn (trace_context_for_agent, append_with_context, write_json_payload); called by 2 (spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item, spawn_runtime_payload_targets_delivered_child_message); 1 external calls (json!).


##### `inter_agent_message`  (lines 968–977)

```
fn inter_agent_message(author: &str, recipient: &str, content: &str, trigger_turn: bool) -> String
```

**Purpose**: Serializes an older-style inter-agent mailbox message transport object into a JSON string. Tests use it to populate assistant message bodies that the reducer should recognize as delivered agent messages.

**Data flow**: Takes author, recipient, content, and `trigger_turn`, constructs a JSON object with those fields plus `other_recipients: []`, converts it to a string with `.to_string()`, and returns it. It is pure.

**Call relations**: Used by multiple tests when building mailbox messages for inference requests. It mirrors the legacy transport shape parsed by `inter_agent_message_fields` in the reducer.

*Call graph*: called by 6 (agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_targets_delivered_child_message); 1 external calls (json!).


##### `target_conversation_item_id`  (lines 979–984)

```
fn target_conversation_item_id(anchor: &TraceAnchor) -> &String
```

**Purpose**: Extracts the conversation item id from a `TraceAnchor` expected to be `ConversationItem`. It is an assertion helper for tests that expect exact item targeting.

**Data flow**: Takes a `&TraceAnchor`, pattern-matches it as `TraceAnchor::ConversationItem { item_id }`, returns `&String` on success, and panics otherwise. It does not mutate state.

**Call relations**: Called by tests after replay when they expect an interaction edge target to be a conversation item. It keeps anchor-shape assertions concise.

*Call graph*: called by 7 (agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge); 1 external calls (panic!).


##### `text_body`  (lines 986–991)

```
fn text_body(item: &crate::model::ConversationItem) -> &str
```

**Purpose**: Extracts the text from a conversation item body expected to contain exactly one `ConversationPart::Text`. It is a narrow assertion helper for result-message tests.

**Data flow**: Takes a `&crate::model::ConversationItem`, pattern-matches `item.body.parts` as a single text part, returns `&str` for that text, and panics if the body shape differs. It is pure.

**Call relations**: Used by the child-result test to assert that the source conversation item contains the expected assistant output text.

*Call graph*: 1 external calls (panic!).


### `rollout-trace/src/reducer/tool/terminal_tests.rs`

`test` · `test execution`

This test module constructs focused traces around terminal-capable tools and verifies the resulting reduced terminal graph in detail. The main exec test covers the full happy path: an inference response emits a model-visible function call, a tool start/runtime start/runtime end/result sequence follows, and a later inference request carries the tool output back to the model. Replay must produce a `ToolCall` summarized as `ToolCallSummary::Terminal`, a `TerminalOperation` with runtime-derived request/result fields and raw payload ids, a `TerminalSession` keyed by process id, and a `TerminalModelObservation` linking the terminal row back to the model-visible call and output items.

The remaining tests probe edge cases and alternate payload sources. One verifies that a `WriteStdin` runtime start on an existing process reuses the already-created terminal session rather than creating a second session. Another shows that dispatch-only `write_stdin` invocation/result payloads are sufficient to create and complete a terminal operation even without runtime begin/end protocol events, including numeric `session_id` normalization. The code-mode test confirms that a structured `code_mode_response` result is projected into terminal-specific fields like `chunk_id`, `exit_code`, and `original_token_count`. Two local helpers append the inference request/response scaffolding needed to create model-visible tool call and output items for the exec scenario.

#### Function details

##### `exec_tool_reduces_to_terminal_operation_and_session`  (lines 27–215)

```
fn exec_tool_reduces_to_terminal_operation_and_session() -> anyhow::Result<()>
```

**Purpose**: Verifies the full exec-command reduction path from model-visible tool call through runtime begin/end and later model-visible tool output. It asserts the exact `ToolCall`, `TerminalOperation`, `TerminalSession`, and terminal model-observation contents.

**Data flow**: Creates a temp bundle and started writer, starts turn 1, appends an inference whose response contains a function call, writes tool invocation/runtime/result payloads and matching tool events, starts turn 2, appends a follow-up inference request containing the tool output, replays the bundle, and asserts on terminal operation id assignment, raw payload ids, terminal summary replacement, operation execution/request/result fields, model observation item ids, and session contents.

**Call relations**: This test composes the local helpers `append_inference_with_tool_call` and `append_followup_with_tool_output` with shared writer fixtures, then validates the combined behavior of generic tool reduction and terminal-specific reduction after `replay_bundle`.

*Call graph*: calls 6 internal fn (create_started_writer, generic_summary, start_turn, trace_context, append_followup_with_tool_output, append_inference_with_tool_call); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `write_stdin_operation_reuses_existing_terminal_session`  (lines 218–318)

```
fn write_stdin_operation_reuses_existing_terminal_session() -> anyhow::Result<()>
```

**Purpose**: Checks that a `WriteStdin` terminal operation started from runtime payloads joins an existing terminal session when both operations share the same process id. It validates session reuse rather than session duplication.

**Data flow**: Creates a started writer, starts a turn, writes an exec-command runtime-start payload for `tool-start` and appends matching tool start/runtime start events, writes a write-stdin runtime-start payload for `tool-stdin` and appends matching tool start/runtime start events, replays the bundle, and asserts that the single terminal session `pty-1` contains both operation ids and that the second operation has the expected running `WriteStdin` request fields and raw payload ids.

**Call relations**: This test drives only runtime-start terminal creation, without terminal end events. It specifically validates `ensure_terminal_session` behavior when multiple operations share one terminal id.

*Call graph*: calls 4 internal fn (create_started_writer, generic_summary, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `dispatch_write_stdin_payload_reduces_to_terminal_operation`  (lines 321–439)

```
fn dispatch_write_stdin_payload_reduces_to_terminal_operation() -> anyhow::Result<()>
```

**Purpose**: Verifies that dispatch-style `write_stdin` invocation and result payloads alone can create and complete a terminal operation and session. It covers the non-protocol fallback path.

**Data flow**: Creates a started writer, starts a turn, writes a `ToolInvocation` payload for `write_stdin` with serialized function arguments including numeric `session_id`, appends `ToolCallStarted`, writes a direct-response `ToolResult` payload, appends `ToolCallEnded`, replays the bundle, and asserts on the tool's terminal summary, the terminal operation's request/result/execution/raw-payload fields, and the terminal session keyed by stringified `session_id`.

**Call relations**: This test exercises `start_terminal_operation_from_invocation` and dispatch response parsing rather than runtime protocol parsing. It validates that generic tool reduction can still produce terminal rows without runtime observations.

*Call graph*: calls 4 internal fn (create_started_writer, generic_summary, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `code_mode_write_stdin_result_projects_structured_exec_fields`  (lines 442–521)

```
fn code_mode_write_stdin_result_projects_structured_exec_fields() -> anyhow::Result<()>
```

**Purpose**: Checks that a code-mode `write_stdin` result payload is projected into structured terminal result fields such as `chunk_id`, `exit_code`, and `original_token_count`. It validates the code-mode response parsing branch.

**Data flow**: Creates a started writer, starts a turn, writes a dispatch-style write-stdin invocation payload and a `code_mode_response` tool result payload, appends a `CodeCellStarted` event, appends `ToolCallStarted` for a code-cell-requested write-stdin tool, appends `ToolCallEnded`, replays the bundle, and asserts that `terminal_operation:1` has the expected structured `TerminalResult`.

**Call relations**: This test combines code-cell context with terminal reduction to ensure the terminal parser handles code-mode result payloads correctly. It primarily exercises `parse_code_mode_exec_result` through the dispatch response path.

*Call graph*: calls 4 internal fn (create_started_writer, generic_summary, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `append_inference_with_tool_call`  (lines 523–558)

```
fn append_inference_with_tool_call(writer: &TraceWriter) -> anyhow::Result<()>
```

**Purpose**: Appends a minimal inference exchange whose response contains a model-visible `function_call` item for `exec_command`. It provides the transcript scaffolding needed for terminal model-observation assertions.

**Data flow**: Takes a writer, writes an `InferenceRequest` payload containing a user message, appends `InferenceStarted` for `inference-1`, writes an `InferenceResponse` payload containing one `function_call` output item with `call_id: call-1`, appends `InferenceCompleted`, and returns `Ok(())`.

**Call relations**: Called only by `exec_tool_reduces_to_terminal_operation_and_session`. It sets up the response-side call item that generic tool reduction later links to the terminal-backed tool call.

*Call graph*: calls 2 internal fn (append, write_json_payload); called by 1 (exec_tool_reduces_to_terminal_operation_and_session); 1 external calls (json!).


##### `append_followup_with_tool_output`  (lines 560–581)

```
fn append_followup_with_tool_output(writer: &TraceWriter) -> anyhow::Result<()>
```

**Purpose**: Appends a follow-up inference request that carries a model-visible `function_call_output` item for the earlier exec tool call. It provides the transcript-side output item used in terminal model observations.

**Data flow**: Takes a writer, writes an `InferenceRequest` payload containing `previous_response_id: "resp-1"` and one `function_call_output` input item for `call-1`, appends `InferenceStarted` for `inference-2`, and returns `Ok(())`. It writes the payload file and event log entry.

**Call relations**: Called only by `exec_tool_reduces_to_terminal_operation_and_session` after the tool lifecycle has been appended. It creates the later transcript evidence that generic tool reduction mirrors onto the terminal operation.

*Call graph*: calls 2 internal fn (append, write_json_payload); called by 1 (exec_tool_reduces_to_terminal_operation_and_session); 1 external calls (json!).


### Trace protocol and thread recording
These tests validate protocol-event mapping and then exercise the thread-scoped tracing API that emits replayable bundles.

### `rollout-trace/src/protocol_event_tests.rs`

`test` · `test-only`

This test module exercises one subtle mapping decision from `protocol_event.rs`: `EventMsg::SubAgentActivity` does not have a separate begin/end pair, but rollout tracing treats it as an `Ended` tool runtime event. The test constructs a realistic `SubAgentActivityEvent` with a generated `ThreadId`, a parsed `AgentPath` of `/root/reviewer`, a fixed `event_id`, timestamp, and `SubAgentActivityKind::Started`, then wraps it in `EventMsg::SubAgentActivity`.

It calls `tool_runtime_trace_event` and pattern-matches the result to require `Some(ToolRuntimeTraceEvent::Ended { ... })`; any other outcome triggers a panic. The assertions then check three things: the emitted `tool_call_id` is the original `event_id`, the derived status is `ExecutionStatus::Completed`, and serializing the borrowed `payload` reproduces the original protocol JSON shape with `event_id`, `occurred_at_ms`, `agent_thread_id`, `agent_path`, and `kind` fields.

Because this is a narrow regression test, its value is in documenting a non-obvious policy choice: sub-agent activity is represented as a terminal runtime event even when the activity kind itself is `Started`.

#### Function details

##### `sub_agent_activity_is_a_terminal_tool_runtime_event`  (lines 14–46)

```
fn sub_agent_activity_is_a_terminal_tool_runtime_event() -> anyhow::Result<()>
```

**Purpose**: Verifies that `SubAgentActivity` protocol events map to `ToolRuntimeTraceEvent::Ended` with completed status and exact payload serialization. It guards a specific trace-policy decision that could be easy to regress.

**Data flow**: Creates a new `ThreadId`, parses an `AgentPath`, builds `EventMsg::SubAgentActivity(SubAgentActivityEvent { ... })`, passes it to `tool_runtime_trace_event`, destructures the returned `Ended` event, and asserts the tool call id, status, and `serde_json::to_value(payload)` output match expected values. It returns `anyhow::Result<()>` so path parsing and payload serialization can use `?`.

**Call relations**: This test directly exercises `tool_runtime_trace_event` from the production module and validates the `ToolRuntimePayload::serialize` behavior indirectly through JSON serialization of the returned payload.

*Call graph*: calls 2 internal fn (try_from, new); 4 external calls (assert_eq!, panic!, SubAgentActivity, tool_runtime_trace_event).


### `rollout-trace/src/thread_tests.rs`

`test` · `test-time validation of trace bundle creation and thread trace behavior`

This test module builds temporary trace bundles and inspects either replayed reduced state or raw `trace.jsonl` contents. The tests validate several important invariants from `thread.rs`: root startup writes a replayable lifecycle (`RolloutStarted`, `ThreadStarted`, `ThreadEnded`, `RolloutEnded`), child threads append into the same root bundle rather than creating a second bundle directory, and disabled contexts accept every tracing call without touching disk or forcing lazy tool-dispatch payload construction.

The helper `minimal_metadata` produces a compact but valid `ThreadStartedTraceMetadata` for most tests, while `single_bundle_dir` asserts that exactly one bundle directory exists under a temporary root and returns its path. The tests intentionally cover both reduced replay semantics and raw event presence. For example, `protocol_wrapper_records_selected_events_as_raw_payloads` parses each JSONL line back into `RawTraceEvent` and checks for `ProtocolEventObserved { event_type: "shutdown_complete", .. }`, proving that the wrapper emits the expected breadcrumb.

Several tests also verify subtle behavior: child completion should not mark the rollout complete, disabled tracing should not evaluate the lazy dispatch invocation closure, and startup metadata should be persisted as raw payloads so replay sees the expected payload count.

#### Function details

##### `create_in_root_writes_replayable_lifecycle_events`  (lines 24–56)

```
fn create_in_root_writes_replayable_lifecycle_events() -> anyhow::Result<()>
```

**Purpose**: Verifies that starting and ending a root thread trace produces a bundle that the reducer can replay into a completed rollout with the expected root thread metadata. It checks both reduced state and raw payload count.

**Data flow**: Creates a `TempDir`, generates a `ThreadId`, constructs full `ThreadStartedTraceMetadata`, starts tracing with `ThreadTraceContext::start_root_in_root_for_test`, records `RolloutStatus::Completed`, locates the single bundle directory, and replays it with `replay_bundle`. It asserts rollout status, root thread id, root agent path, and that exactly one raw payload was written.

**Call relations**: This test drives the root-start path through `start_root_in_root_for_test` and the shutdown path through `record_ended`, then validates the resulting bundle via the reducer.

*Call graph*: calls 3 internal fn (new, start_root_in_root_for_test, single_bundle_dir); 5 external calls (from, new, assert_eq!, replay_bundle, format!).


##### `spawned_thread_start_appends_to_root_bundle`  (lines 59–110)

```
fn spawned_thread_start_appends_to_root_bundle() -> anyhow::Result<()>
```

**Purpose**: Checks that a spawned child thread writes into the existing root bundle and updates only the child thread's execution state, not the rollout's terminal status. It also verifies child metadata capture.

**Data flow**: Creates temp storage, root and child `ThreadId`s, starts a root trace using `minimal_metadata`, then starts a child trace with explicit `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { ... })` metadata. After recording child completion, it replays the single bundle and asserts there is only one bundle directory, two threads in reduced state, the child's agent path and completed execution status are present, rollout status remains `Running`, and two raw payloads exist.

**Call relations**: This test exercises `start_child_thread_trace_or_disabled` and `record_ended` on a child context, proving the shared-writer multi-thread bundle behavior described in `thread.rs`.

*Call graph*: calls 5 internal fn (try_from, new, start_root_in_root_for_test, minimal_metadata, single_bundle_dir); 6 external calls (from, new, SubAgent, assert_eq!, replay_bundle, format!).


##### `disabled_thread_context_accepts_trace_calls_without_writing`  (lines 113–165)

```
fn disabled_thread_context_accepts_trace_calls_without_writing() -> anyhow::Result<()>
```

**Purpose**: Ensures the disabled thread context safely accepts the full surface area of trace calls without creating files or evaluating lazy dispatch payload construction. It validates the no-op contract.

**Data flow**: Creates a temp directory and a disabled `ThreadTraceContext`, then invokes thread-end, protocol, turn, tool-runtime, and agent-result recording methods. It also creates disabled inference and compaction contexts, starts attempts, records success/failure events on them, and calls `start_tool_dispatch_trace` with a closure that would set a `Cell<bool>` if executed. The test asserts the closure was not run, the returned dispatch trace is disabled, and the temp directory remains empty.

**Call relations**: This test covers the disabled fast paths across multiple tracing subsystems reachable from `ThreadTraceContext`, especially the lazy invocation behavior of `start_tool_dispatch_trace`.

*Call graph*: calls 2 internal fn (new, disabled); 6 external calls (new, new, assert!, assert_eq!, Completed, json!).


##### `protocol_wrapper_records_selected_events_as_raw_payloads`  (lines 168–190)

```
fn protocol_wrapper_records_selected_events_as_raw_payloads() -> anyhow::Result<()>
```

**Purpose**: Confirms that selected protocol events are wrapped into raw trace breadcrumbs with the expected event type string. It inspects the raw event log directly rather than replayed reduced state.

**Data flow**: Creates a temp bundle, starts a root trace with `minimal_metadata`, records `EventMsg::ShutdownComplete` via `record_protocol_event`, reads `trace.jsonl` from the bundle directory, deserializes each line into `crate::RawTraceEvent`, and checks that at least one line contains `RawTraceEventPayload::ProtocolEventObserved` with `event_type == "shutdown_complete"`.

**Call relations**: This test specifically targets the protocol-wrapper path in `ThreadTraceContext::record_protocol_event`, validating the event-type filtering and raw breadcrumb append.

*Call graph*: calls 4 internal fn (new, start_root_in_root_for_test, minimal_metadata, single_bundle_dir); 3 external calls (new, assert!, read_to_string).


##### `minimal_metadata`  (lines 192–207)

```
fn minimal_metadata(thread_id: ThreadId) -> ThreadStartedTraceMetadata
```

**Purpose**: Builds a compact, reusable `ThreadStartedTraceMetadata` fixture for tests that only need a valid root-thread startup payload. It standardizes common fields across multiple tests.

**Data flow**: Accepts a `ThreadId`, converts it to string, and returns `ThreadStartedTraceMetadata` with `/root` agent path, `SessionSource::Exec`, `/workspace` cwd, no rollout path, and fixed model/provider/policy strings.

**Call relations**: Used by tests that do not care about custom startup metadata details, reducing duplication while still exercising the real startup path.

*Call graph*: called by 2 (protocol_wrapper_records_selected_events_as_raw_payloads, spawned_thread_start_appends_to_root_bundle); 2 external calls (from, to_string).


##### `single_bundle_dir`  (lines 209–216)

```
fn single_bundle_dir(root: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: Finds and returns the only bundle directory under a temporary trace root, asserting that exactly one exists. It simplifies tests that expect a single root bundle.

**Data flow**: Reads the directory entries under `root`, maps them to paths, collects them into a `Vec<PathBuf>`, sorts the vector, asserts its length is 1, removes and returns the sole path.

**Call relations**: Used by tests that need to inspect the generated bundle after root or child trace operations. Its assertion encodes the expectation that child traces append to the root bundle instead of creating siblings.

*Call graph*: called by 3 (create_in_root_writes_replayable_lifecycle_events, protocol_wrapper_records_selected_events_as_raw_payloads, spawned_thread_start_appends_to_root_bundle); 2 external calls (assert_eq!, read_dir).


### Runtime and persistence support
Runtime-state helpers underpin tests for external-agent config import persistence and database recovery behavior.

### `state/src/runtime/test_support.rs`

`test` · `test fixture setup across runtime state tests`

This file is compiled only for tests and exists to centralize common fixture-building logic used throughout the runtime state test suite. `unique_temp_dir` creates a path under the system temp directory whose name combines the current UNIX-epoch nanoseconds with a random UUID. It does not create the directory itself; callers decide whether and when to materialize it, which lets tests control setup order and failure modes.

`test_thread_metadata` constructs a fully populated `ThreadMetadata` instance with stable, deterministic values suitable for insertion into the runtime database. It fixes both `created_at` and `updated_at` to the same known UTC timestamp, derives `rollout_path` from the supplied `codex_home` and `thread_id`, and fills in representative protocol-derived fields such as `ReasoningEffort::Medium`, a read-only sandbox policy, and `AskForApproval::OnRequest`. It also sets common defaults used by thread-listing and rollout tests: source `cli`, provider `test-provider`, model `gpt-5`, preview and first user message `hello`, zero tokens, and all archive/git fields unset. By keeping these defaults in one place, tests can override only the fields relevant to the behavior under examination while still producing realistic rows.

#### Function details

##### `unique_temp_dir`  (lines 28–36)

```
fn unique_temp_dir() -> PathBuf
```

**Purpose**: Builds a likely-unique temporary directory path for tests without touching the filesystem. The name includes both wall-clock nanoseconds and a UUID to avoid collisions across concurrent test runs.

**Data flow**: It reads `SystemTime::now()`, computes nanoseconds since `UNIX_EPOCH` with a fallback of `0` on clock errors, reads the process temp directory from `std::env::temp_dir()`, formats a directory name containing the timestamp and `Uuid::new_v4()`, and returns the resulting `PathBuf`.

**Call relations**: Many runtime tests call this helper first to isolate their SQLite homes and fixture files. It is purely preparatory and delegates actual directory creation to the caller.

*Call graph*: called by 98 (report_agent_job_item_result_completes_item_atomically, report_agent_job_item_result_rejects_late_reports, backfill_claim_is_singleton_until_stale_and_blocked_when_complete, backfill_state_persists_progress_and_completion, get_backfill_state_repairs_a_missing_singleton_row, get_backfill_state_succeeds_while_another_connection_holds_writer_slot, reads_all_history_records, records_completion_by_import_id, test_runtime, init_configures_logs_db_with_incremental_auto_vacuum (+15 more)); 3 external calls (now, format!, temp_dir).


##### `test_thread_metadata`  (lines 39–71)

```
fn test_thread_metadata(
    codex_home: &Path,
    thread_id: ThreadId,
    cwd: PathBuf,
) -> ThreadMetadata
```

**Purpose**: Creates a deterministic `ThreadMetadata` fixture populated with realistic defaults for runtime database tests. It saves callers from repeating the full struct initialization and ensures cross-test consistency.

**Data flow**: Inputs are `codex_home`, a `ThreadId`, and a working-directory `PathBuf`. The function computes a fixed UTC timestamp, derives `rollout_path` from `codex_home` and `thread_id`, converts protocol enums for sandbox and approval settings into stored strings, and returns a fully initialized `ThreadMetadata` with preset provider/model/preview fields and unset optional archive/git fields.

**Call relations**: Thread-related tests across the runtime module call this helper before inserting or mutating thread rows. It feeds directly into methods like `upsert_thread` and related listing, cleanup, and rollout-application paths.

*Call graph*: calls 1 internal fn (enum_to_string); called by 50 (upsert_test_thread, claim_stage1_jobs_bounds_state_scan_before_memory_probes, claim_stage1_jobs_enforces_global_running_cap, claim_stage1_jobs_filters_by_age_idle_and_current_thread, claim_stage1_jobs_processes_two_full_batches_across_startup_passes, claim_stage1_jobs_skips_threads_with_disabled_memory_mode, clear_memory_data_clears_rows_and_preserves_thread_memory_modes, delete_thread_removes_stage1_output_and_enqueues_phase2_when_selected, get_phase2_input_selection_excludes_polluted_previous_selection, get_phase2_input_selection_excludes_stale_used_memories_but_keeps_fresh_never_used (+15 more)); 5 external calls (from_timestamp, join, new, new_read_only_policy, format!).


### `state/src/runtime/external_agent_config_imports_tests.rs`

`test` · `test-time verification of import result persistence`

This file contains focused integration-style tests for the import-history methods implemented in `external_agent_config_imports.rs`. Each test initializes a fresh `StateRuntime` in a unique temporary directory so the SQLite tables start empty and isolated.

`records_completion_by_import_id` verifies the overwrite semantics of `record_external_agent_config_import_completed`: it writes one import result for `import-1`, writes a second result with the same `import_id` but expanded success and failure lists, then checks that `external_agent_config_import_details_record("import-1")` returns only the newer payload. It also queries `external_agent_config_import_history_records`, maps the returned records down to `(import_id, successes, failures, completed_at_ms > 0)`, and asserts there is exactly one history row with the updated content and a positive completion timestamp.

`reads_all_history_records` verifies that distinct import ids produce multiple history rows. It records empty completions for `import-1` and `import-2`, fetches all history records, sorts them by `import_id` to avoid depending on timestamp ordering in the assertion, and confirms both ids are present. Together these tests pin down the two key behaviors of the module: conflict-upsert replacement for a single import id and complete retrieval across multiple imports.

#### Function details

##### `records_completion_by_import_id`  (lines 6–119)

```
async fn records_completion_by_import_id() -> anyhow::Result<()>
```

**Purpose**: Checks that recording completion twice for the same `import_id` replaces the stored payload instead of creating duplicates. It also verifies that the history API returns the updated record with a nonzero completion timestamp.

**Data flow**: Creates a fresh runtime, writes two completion records for `import-1` with different success/failure arrays, then reads back both the detail record and the history list and compares them against expected typed values using `assert_eq!`.

**Call relations**: This test drives the write API first and then validates both read APIs, proving the `ON CONFLICT(import_id)` behavior exposed by the runtime module.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 1 external calls (assert_eq!).


##### `reads_all_history_records`  (lines 122–145)

```
async fn reads_all_history_records() -> anyhow::Result<()>
```

**Purpose**: Verifies that separate import ids are all returned by the history query. It focuses on presence of multiple rows rather than overwrite semantics.

**Data flow**: Initializes a runtime, records empty completions for `import-1` and `import-2`, fetches the history vector, sorts it by `import_id`, and asserts the resulting id list contains both imports.

**Call relations**: This complements the first test by covering the non-conflicting multi-row case of `external_agent_config_import_history_records`.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 1 external calls (assert_eq!).


### `state/src/runtime/recovery_tests.rs`

`test` · `test-time validation of startup recovery and corruption handling`

This test module targets the runtime recovery helpers in the surrounding module, especially the logic that reacts to SQLite initialization failures by identifying a corrupt database and moving its files into a backup directory before a fresh start. The tests build temporary sqlite homes with realistic sidecar files by iterating the runtime database path set and expanding each database path through `sqlite_paths`, then writing marker contents into each file so the backup operation can be validated concretely. One scenario confirms that `backup_runtime_db_for_fresh_start` only relocates files belonging to the failed database returned by `logs_db_path`, leaving all other runtime databases untouched. Another covers the edge case where the configured sqlite home path is itself a blocking regular file; recovery is expected to replace that file with a directory and still emit a backup path rooted under a renamed backup location.

The remaining tests focus on error classification. They pin the string heuristics that distinguish corruption messages from lock/busy conditions, then force `StateRuntime::init` to open a malformed state database and verify that `runtime_db_path_for_corruption_error` extracts the exact failed database path from the wrapped initialization error. A final regression test ensures this path extraction does not produce false positives merely because the filesystem path contains the word `corrupt`.

#### Function details

##### `backup_moves_only_requested_runtime_db_files_to_backup_folder`  (lines 6–41)

```
async fn backup_moves_only_requested_runtime_db_files_to_backup_folder() -> std::io::Result<()>
```

**Purpose**: Builds a temporary runtime sqlite layout, invokes backup on one failed database, and proves that only that database's SQLite files are moved into the backup area. It also checks that backup destinations are created under the configured backup directory.

**Data flow**: The test creates a unique temp directory, derives all runtime database paths from it, expands each database into its SQLite-related file set via `sqlite_paths`, and writes each file with its own path string as contents. It separately computes the failed logs database path and its sidecar files, calls `backup_runtime_db_for_fresh_start` with that failed path, then asserts on the returned backup records, filesystem existence of original files, and backup path prefixes.

**Call relations**: This is a top-level async test invoked by the test runner. It prepares realistic input state using `unique_temp_dir`, `runtime_db_paths`, and `logs_db_path`, then drives the recovery helper under the condition of a simulated failed logs DB and validates the helper's selective file movement behavior.

*Call graph*: calls 1 internal fn (unique_temp_dir); 7 external calls (new, assert!, assert_eq!, logs_db_path, runtime_db_paths, create_dir_all, write).


##### `backup_replaces_blocking_sqlite_home_file`  (lines 44–64)

```
async fn backup_replaces_blocking_sqlite_home_file() -> std::io::Result<()>
```

**Purpose**: Verifies recovery when the expected sqlite home path is a regular file instead of a directory. The test ensures backup logic renames or replaces the blocking file and proceeds with backup creation.

**Data flow**: It creates a temp directory, writes a regular file at `sqlite-home`, derives the state database path beneath that would-be directory, and passes that path into `backup_runtime_db_for_fresh_start`. After the call it checks that exactly one backup record was returned, that `sqlite-home` now resolves to a directory, and that the backup path lives under a sibling path suffixed with the backup directory name.

**Call relations**: This async test is entered directly by the test harness. It sets up the specific precondition of a non-directory sqlite home and then exercises the backup path creation branch that must recover from that obstruction before normal runtime initialization can continue.

*Call graph*: calls 1 internal fn (unique_temp_dir); 5 external calls (assert!, assert_eq!, state_db_path, create_dir_all, write).


##### `sqlite_error_detail_classifies_corruption_and_lock_errors`  (lines 67–75)

```
fn sqlite_error_detail_classifies_corruption_and_lock_errors()
```

**Purpose**: Pins the string-matching rules used to classify SQLite error details as corruption versus lock contention. It covers both plain and wrapped corruption messages and distinguishes them from lock/busy text.

**Data flow**: The test feeds fixed string literals into `sqlite_error_detail_is_corruption` and `sqlite_error_detail_is_lock`, then asserts the expected booleans. No external state is read or written.

**Call relations**: This synchronous unit test is called only by the test runner. It validates the low-level predicates that upstream recovery code relies on when deciding whether to back up a database or treat the failure as transient locking.

*Call graph*: 1 external calls (assert!).


##### `runtime_db_path_for_corruption_error_returns_failed_database_path`  (lines 78–92)

```
async fn runtime_db_path_for_corruption_error_returns_failed_database_path() -> std::io::Result<()>
```

**Purpose**: Forces runtime initialization to fail on a malformed SQLite file and checks that the recovery helper can recover the exact database path from the resulting error chain. This confirms that corruption-triggered backup targets the right file.

**Data flow**: The test creates a temp sqlite home, computes the state DB path, writes invalid bytes to that file, and calls `StateRuntime::init`. It captures the expected error from the failed initialization and passes it to `runtime_db_path_for_corruption_error`, asserting that the returned `Option<PathBuf>` equals the malformed state DB path.

**Call relations**: The test runner invokes this async test. It deliberately drives `StateRuntime::init` down its failure path, then hands the produced error into the corruption-path extractor to verify the integration between initialization errors and recovery targeting.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 5 external calls (assert_eq!, panic!, state_db_path, create_dir_all, write).


##### `runtime_db_path_for_corruption_error_ignores_corrupt_word_in_path`  (lines 95–105)

```
fn runtime_db_path_for_corruption_error_ignores_corrupt_word_in_path()
```

**Purpose**: Guards against false-positive corruption detection based solely on path text. It confirms that an unrelated permission error on a path containing `corrupt` does not get treated as a corruption-backed database path.

**Data flow**: The test constructs a `PathBuf` whose directory name includes `sqlite_corrupt`, wraps a permission-denied `anyhow` error inside a `RuntimeDbInitError::new`, and passes the resulting `anyhow::Error` to `runtime_db_path_for_corruption_error`. It asserts that the function returns `None`.

**Call relations**: This synchronous regression test is entered by the test harness. It bypasses actual database I/O and directly fabricates the wrapped initialization error shape that the extractor inspects, specifically to validate its text parsing boundaries.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, anyhow!, assert_eq!, new).


### Memories pipeline and storage
These files cover memory prompt rendering, citation parsing, startup orchestration, workspace diffs, pruning, and on-disk storage synchronization.

### `ext/memories/src/prompts_tests.rs`

`test` · `test execution`

This test file exercises the happy-path behavior of `build_memory_tool_developer_instructions` against a temporary on-disk memories directory. Rather than mocking I/O, it creates an actual temp directory, wraps it in `AbsolutePathBuf`, creates the `memories` subdirectory, and writes a small `memory_summary.md`. That setup mirrors the production path layout expected by the prompt builder.

The single async test then awaits the prompt-building function and asserts several concrete properties of the rendered output: it must mention the exact `memory_summary.md` path under the temp memories directory, it must include the summary text verbatim, and it must contain the `========= MEMORY_SUMMARY BEGINS =========` delimiter exactly once. Those assertions collectively prove that the embedded template was parsed and rendered, that the runtime substitutions were wired correctly, and that the summary content is inserted in the intended section rather than duplicated. Because the test uses the real filesystem and the real template, it acts as a regression check for both path formatting and template content changes.

#### Function details

##### `build_memory_tool_developer_instructions_renders_embedded_template`  (lines 8–35)

```
async fn build_memory_tool_developer_instructions_renders_embedded_template()
```

**Purpose**: Creates a temporary memories tree, writes a summary file, invokes the prompt builder, and checks that the rendered instructions contain the expected path, content, and single summary marker.

**Data flow**: It allocates a temp directory, converts its path into `AbsolutePathBuf`, creates `<temp>/memories`, writes `memory_summary.md`, then awaits `build_memory_tool_developer_instructions`. From the returned string it derives boolean and count assertions about included substrings and marker occurrences; it writes only the temporary test files as side effects.

**Call relations**: This is a standalone Tokio test entrypoint, not called by production code. It drives the real prompt-building function through its normal filesystem path to validate the integration between file reading and template rendering.

*Call graph*: calls 1 internal fn (from_absolute_path); 5 external calls (assert!, assert_eq!, tempdir, create_dir_all, write).


### `memories/read/src/citations_tests.rs`

`test` · `unit test execution`

This test module validates the parsing behavior implemented in `citations.rs` using concrete markup strings. Each test constructs one citation blob with embedded XML-like sections, invokes `parse_memory_citation`, and asserts on either the recovered `ThreadId` values or the exact parsed entry fields.

The first test covers backward compatibility with legacy `<thread_ids>` markup. It generates two fresh `ThreadId` values, inserts an invalid `not-a-uuid` line between them, and confirms that `thread_ids_from_memory_citation` returns only the valid IDs in order. The second test exercises the preferred `<rollout_ids>` tag and verifies that a single valid ID is recovered. The third test combines `<citation_entries>` and `<rollout_ids>` in one string, including a duplicate rollout ID, then asserts that entry parsing preserves path, line range, and note text for two entries while rollout IDs are deduplicated to first occurrence order. Together these tests document the parser’s tolerant behavior: malformed IDs are dropped, duplicate IDs are collapsed, and mixed entry/ID content is merged into one `MemoryCitation`.

#### Function details

##### `parse_memory_citation_supports_legacy_thread_ids`  (lines 7–21)

```
fn parse_memory_citation_supports_legacy_thread_ids()
```

**Purpose**: Verifies that the parser still recognizes legacy `<thread_ids>` blocks and that invalid IDs are ignored during typed conversion. It checks ordering of the surviving valid IDs.

**Data flow**: Creates two fresh `ThreadId` values, embeds them plus an invalid line into a citation string inside a one-element vector, parses it with `parse_memory_citation`, converts the result with `thread_ids_from_memory_citation`, and asserts the returned vector equals `[first, second]`.

**Call relations**: This unit test directly exercises `parse_memory_citation` and `thread_ids_from_memory_citation` together to validate backward compatibility behavior.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, parse_memory_citation, vec!).


##### `parse_memory_citation_supports_rollout_ids`  (lines 24–34)

```
fn parse_memory_citation_supports_rollout_ids()
```

**Purpose**: Verifies that the parser recognizes the current `<rollout_ids>` tag and converts its contents into typed thread IDs. It is the minimal happy-path case for the modern format.

**Data flow**: Generates one `ThreadId`, embeds it in a `<rollout_ids>` block, parses the citation vector, converts rollout IDs to typed IDs, and asserts the result is exactly a one-element vector containing that thread ID.

**Call relations**: This test isolates the modern ID-tag path of `parse_memory_citation`, complementing the legacy-tag coverage in the previous test.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, parse_memory_citation, vec!).


##### `parse_memory_citation_extracts_entries_and_rollout_ids`  (lines 37–71)

```
fn parse_memory_citation_extracts_entries_and_rollout_ids()
```

**Purpose**: Verifies that citation entries and rollout IDs are both extracted from the same citation string and that duplicate rollout IDs are removed. It also checks exact field parsing for multiple entry lines.

**Data flow**: Creates two `ThreadId` values, builds a citation string containing two `<citation_entries>` lines and a `<rollout_ids>` block with a duplicate of the first ID, parses it, maps the parsed entries into tuples of `(path, line_start, line_end, note)` for comparison, and asserts both the entry tuple vector and the deduplicated `rollout_ids` vector match the expected values.

**Call relations**: This test exercises the combined parsing path in `parse_memory_citation`, documenting how entry extraction and rollout-ID deduplication interact in one input.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, parse_memory_citation, vec!).


### `memories/write/src/extensions/prune_tests.rs`

`test` · `test execution`

This test module validates the pruning logic with concrete filesystem fixtures. The async pruning test constructs a temporary memories tree, creates an extension named `chronicle` with both `resources/` and `instructions.md`, and then writes four markdown files: one older than the retention window, one exactly at the cutoff, one recent, and one with an invalid timestamp prefix. It also creates a separate `ignored` extension-like directory that has `resources/` but no `instructions.md`, containing an old file that should not be touched.

To make the cutoff deterministic, the test builds a fixed `DateTime<Utc>` by parsing a timestamp string with the same filename format constant used in production. After invoking `prune_old_extension_resources_with_now`, it asserts that the old and exact-cutoff files under `chronicle` are gone, while the recent file, invalidly named file, and old file under `ignored` still exist. This captures several subtle rules: pruning is inclusive at the cutoff, malformed names are preserved, and only directories marked by `instructions.md` count as managed extensions.

The second test isolates `resource_timestamp`, confirming that a valid timestamp-prefixed filename parses to the expected Unix timestamp and that a malformed filename returns `None`.

#### Function details

##### `prunes_only_old_resources_from_extensions_with_instructions`  (lines 7–76)

```
async fn prunes_only_old_resources_from_extensions_with_instructions()
```

**Purpose**: Builds a representative extension directory tree and verifies that pruning deletes only expired timestamped markdown files from recognized extensions. It also checks that cutoff-equal files are removed and unmanaged directories are ignored.

**Data flow**: Creates a temporary memories root, derives `extensions_root`, creates `chronicle/resources`, writes `chronicle/instructions.md`, constructs a fixed `now` timestamp from the configured filename format, writes old/cutoff/recent/invalid resource files, creates an `ignored/resources` directory without instructions and writes an old file there, runs `prune_old_extension_resources_with_now(&memory_root, now)`, then checks file existence with `try_exists` assertions.

**Call relations**: This is a direct async test driver for the internal pruning helper rather than the public wrapper, so it can control time precisely. It exercises the production traversal rules around `memory_extensions_root`, extension recognition via `instructions.md`, and timestamp-based deletion.

*Call graph*: 7 external calls (from_naive_utc_and_offset, parse_from_str, new, assert!, memory_extensions_root, create_dir_all, write).


##### `parses_timestamp_prefix_from_resource_file_name`  (lines 79–85)

```
fn parses_timestamp_prefix_from_resource_file_name()
```

**Purpose**: Confirms that the filename parser extracts the leading timestamp correctly and rejects malformed names. It serves as a focused unit test for the parser used by pruning.

**Data flow**: Calls `resource_timestamp` with a valid timestamp-prefixed markdown filename, unwraps the result, compares its Unix timestamp to a known integer, then calls `resource_timestamp` with `not-a-timestamp.md` and asserts that the result is `None`.

**Call relations**: This standalone unit test targets `resource_timestamp` directly, complementing the broader filesystem pruning test by validating the parser's success and failure cases in isolation.

*Call graph*: 2 external calls (assert!, assert_eq!).


### `memories/write/src/startup_tests.rs`

`test` · `test`

This file is the main test harness for the memories startup subsystem. The top-level async tests exercise realistic startup flows against a mock SSE model server and temporary homes/state DBs. They verify that startup creates the memories root, that phase 2 rewrites the git-backed workspace and resets its baseline across runs, that old extension resource files are pruned both with and without stage-1 inputs, that phase-1 requests inherit live thread service-tier overrides and detached memory metadata, and that provider defaults or explicit config overrides control the model names used for phase 1 and phase 2 requests.

To support those scenarios, the file provides a large set of helpers: builders for `TestCodex` instances with memory features enabled, state-DB initialization, startup triggering, context construction with injected providers, request polling with timeouts, workspace-reset waiting via git diff checks, and seed functions for both stage-1 candidates and completed stage-1 outputs. The seeding helpers populate thread metadata including cwd, rollout path, provider, and git branch so downstream storage and prompt logic see realistic inputs.

`MockMemoryModelProvider` wraps a real provider but overrides only `memory_extraction_preferred_model` and `memory_consolidation_preferred_model`, allowing tests to prove that provider defaults are consulted when config overrides are absent. Overall, this file validates both control flow and many subtle invariants around metadata propagation, DB transitions, and workspace hygiene.

#### Function details

##### `memories_startup_creates_memory_root`  (lines 50–62)

```
async fn memories_startup_creates_memory_root() -> anyhow::Result<()>
```

**Purpose**: Verifies that triggering the startup pipeline creates the `memories` directory under the configured home. It is the simplest end-to-end startup smoke test.

**Data flow**: Starts a mock server, creates a temporary home, builds a test Codex instance, asserts the memory root does not exist, triggers startup, waits for the directory to appear, then shuts the test Codex down. It returns `anyhow::Result<()>`.

**Call relations**: This test drives the public startup entrypoint through `trigger_memories_startup` and uses `wait_for_dir` to observe the asynchronous side effect.

*Call graph*: calls 5 internal fn (start_mock_server, build_test_codex, shutdown_test_codex, trigger_memories_startup, wait_for_dir); 3 external calls (new, new, assert!).


##### `memories_startup_phase2_tracks_workspace_diff_across_runs`  (lines 65–150)

```
async fn memories_startup_phase2_tracks_workspace_diff_across_runs() -> anyhow::Result<()>
```

**Purpose**: Checks that phase 2 detects workspace changes relative to the git baseline, sends a prompt mentioning the diff file, rewrites retained memory files, and resets the workspace baseline afterward. It specifically validates replacement of older retained memories by newer selected ones.

**Data flow**: Creates a temp home and initialized state DB, seeds one stage-1 output, manually writes matching workspace files and resets the git repo, seeds a newer stage-1 output, mounts a mock phase-2 SSE response, builds a test Codex, triggers startup, captures the outgoing request, inspects the prompt text, waits for workspace reset, reads `raw_memories.md` and rollout summary files, and asserts only the newer memory remains. It then shuts down the test Codex.

**Call relations**: This integration test exercises startup orchestration, phase-2 input selection, storage sync, prompt generation, agent execution, and baseline reset together.

*Call graph*: calls 12 internal fn (mount_sse_once, sse, start_mock_server, build_test_codex, init_state_db, phase2_prompt_text, read_rollout_summary_bodies, seed_stage1_output, shutdown_test_codex, trigger_memories_startup (+2 more)); 11 external calls (new, new, assert!, assert_eq!, hours, now, reset_git_repository, create_dir_all, read_to_string, write (+1 more)).


##### `memories_startup_phase2_prunes_old_extension_resources`  (lines 153–220)

```
async fn memories_startup_phase2_prunes_old_extension_resources() -> anyhow::Result<()>
```

**Purpose**: Verifies that phase 2 removes stale extension resource files while retaining recent ones during workspace sync. It also confirms the consolidation prompt still references the workspace diff file.

**Data flow**: Initializes a temp home and DB, seeds one stage-1 output, creates extension instruction and resource files with old and recent timestamps encoded in filenames, mounts a mock phase-2 response, triggers startup, captures the request prompt, waits for workspace reset and old-file removal, then asserts the old file is gone and the recent file still exists before shutdown.

**Call relations**: This test covers the `sync_phase2_workspace_inputs` path, especially `prune_old_extension_resources`, within a full startup run.

*Call graph*: calls 12 internal fn (mount_sse_once, sse, start_mock_server, build_test_codex, init_state_db, phase2_prompt_text, seed_stage1_output, shutdown_test_codex, trigger_memories_startup, wait_for_file_removed (+2 more)); 9 external calls (new, new, assert!, hours, now, format!, create_dir_all, write, vec!).


##### `memories_startup_phase2_prunes_old_extension_resources_without_stage1_input`  (lines 223–272)

```
async fn memories_startup_phase2_prunes_old_extension_resources_without_stage1_input() -> anyhow::Result<()>
```

**Purpose**: Ensures stale extension resources are pruned even when phase 2 runs without any selected stage-1 outputs, as long as a global consolidation job is enqueued. This protects the cleanup path from depending on raw-memory input presence.

**Data flow**: Creates a temp home and DB, enqueues a global consolidation job directly, creates an old extension resource file, mounts a mock phase-2 response, triggers startup, captures the prompt, waits for file removal and workspace reset, and shuts down the test Codex.

**Call relations**: This test targets the branch where phase 2 still runs due to a queued global job even though there are no stage-1 inputs to sync.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, build_test_codex, init_state_db, phase2_prompt_text, shutdown_test_codex, trigger_memories_startup, wait_for_file_removed, wait_for_phase2_workspace_reset (+1 more)); 8 external calls (new, new, assert!, now, format!, create_dir_all, write, vec!).


##### `memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata`  (lines 275–350)

```
async fn memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata() -> anyhow::Result<()>
```

**Purpose**: Verifies two subtle runtime invariants for phase 1: the request context uses the live thread service tier rather than stale config, and detached memory requests include workspace metadata without normal session/thread identifiers. It is a focused integration test of runtime request construction.

**Data flow**: Builds a test Codex, resets the git repo, submits thread settings overriding service tier to Fast, waits until the live config snapshot reflects that tier, constructs a `MemoryStartupContext`, builds a stage-one request context, asserts the service tier was captured, mounts a mock phase-1 SSE response, calls `stream_stage_one_prompt` with a default prompt, captures the outgoing request, parses the `x-codex-turn-metadata` header as JSON, and asserts request-kind/workspace metadata presence and session/thread/window ID absence. It then shuts down the test Codex.

**Call relations**: This test directly exercises `MemoryStartupContext::stage_one_request_context` and `MemoryStartupContext::stream_stage_one_prompt` rather than the full startup pipeline.

*Call graph*: calls 9 internal fn (default, mount_sse_once, sse, start_mock_server, new, build_test_codex, shutdown_test_codex, wait_for_service_tier, wait_for_single_request); 10 external calls (clone, new, default, new, assert!, assert_eq!, reset_git_repository, submit_thread_settings, from_str, vec!).


##### `memories_startup_phase1_provider_default_drives_request_model`  (lines 353–366)

```
async fn memories_startup_phase1_provider_default_drives_request_model() -> anyhow::Result<()>
```

**Purpose**: Checks that phase 1 uses the model provider’s memory-extraction preferred model when no explicit extraction-model override is configured. It validates provider-default model selection.

**Data flow**: Starts a mock server, creates a temp home, runs the helper that executes a phase-1 request with a mock provider and default memories config, then asserts the captured request JSON `model` field equals `MOCK_PROVIDER_PHASE_ONE_MODEL`.

**Call relations**: This test delegates setup and execution to `run_memory_phase_one_model_request_test`, which injects `MockMemoryModelProvider`.

*Call graph*: calls 3 internal fn (start_mock_server, run_memory_phase_one_model_request_test, startup_test_memories_config); 3 external calls (new, new, assert_eq!).


##### `memories_startup_phase2_provider_default_drives_request_model`  (lines 369–382)

```
async fn memories_startup_phase2_provider_default_drives_request_model() -> anyhow::Result<()>
```

**Purpose**: Checks that phase 2 uses the model provider’s memory-consolidation preferred model when no explicit consolidation-model override is configured. It validates provider-default model selection for the spawned agent.

**Data flow**: Starts a mock server, creates a temp home, runs the helper that executes a phase-2 request with a mock provider and default memories config, and asserts the captured request JSON `model` field equals `MOCK_PROVIDER_PHASE_TWO_MODEL`.

**Call relations**: This test relies on `run_memory_phase_two_model_request_test` and the injected mock provider.

*Call graph*: calls 3 internal fn (start_mock_server, run_memory_phase_two_model_request_test, startup_test_memories_config); 3 external calls (new, new, assert_eq!).


##### `memories_startup_phase1_explicit_model_override_drives_request_model`  (lines 385–399)

```
async fn memories_startup_phase1_explicit_model_override_drives_request_model() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicit `memories.extract_model` override takes precedence over the provider default for phase 1. It protects config override semantics.

**Data flow**: Builds a memories config from defaults, sets `extract_model`, runs the phase-1 request helper, and asserts the outgoing request model equals the override string.

**Call relations**: This test is the override-path counterpart to the provider-default phase-1 model test.

*Call graph*: calls 3 internal fn (start_mock_server, run_memory_phase_one_model_request_test, startup_test_memories_config); 3 external calls (new, new, assert_eq!).


##### `memories_startup_phase2_explicit_model_override_drives_request_model`  (lines 402–416)

```
async fn memories_startup_phase2_explicit_model_override_drives_request_model() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicit `memories.consolidation_model` override takes precedence over the provider default for phase 2. It protects config override semantics for the consolidation agent.

**Data flow**: Builds a memories config from defaults, sets `consolidation_model`, runs the phase-2 request helper, and asserts the outgoing request model equals the override string.

**Call relations**: This test is the override-path counterpart to the provider-default phase-2 model test.

*Call graph*: calls 3 internal fn (start_mock_server, run_memory_phase_two_model_request_test, startup_test_memories_config); 3 external calls (new, new, assert_eq!).


##### `run_memory_phase_one_model_request_test`  (lines 418–457)

```
async fn run_memory_phase_one_model_request_test(
    server: &wiremock::MockServer,
    home: Arc<TempDir>,
    memories: MemoriesConfig,
) -> anyhow::Result<ResponsesRequest>
```

**Purpose**: Shared helper that executes a real phase-1 run against a mock SSE server and returns the captured model request. It sets up a seeded stage-1 candidate and injects a mock provider so tests can inspect model selection.

**Data flow**: Builds a test Codex with the supplied memories config, constructs `MockMemoryModelProvider`, obtains the state DB, seeds a stage-1 candidate rollout, mounts a mock SSE response containing valid phase-1 JSON output, builds a startup context/config with the injected provider, runs `phase1::run`, waits for the single request, shuts down the test Codex, and returns the captured `ResponsesRequest`.

**Call relations**: Called by the phase-1 provider-default and explicit-override tests. It drives the actual production `phase1::run` path.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, new, build_test_codex_with_memories_config, memory_startup_context_with_provider, seed_stage1_candidate, shutdown_test_codex, wait_for_single_request); called by 2 (memories_startup_phase1_explicit_model_override_drives_request_model, memories_startup_phase1_provider_default_drives_request_model); 6 external calls (clone, new, hours, now, run, vec!).


##### `run_memory_phase_two_model_request_test`  (lines 459–502)

```
async fn run_memory_phase_two_model_request_test(
    server: &wiremock::MockServer,
    home: Arc<TempDir>,
    memories: MemoriesConfig,
) -> anyhow::Result<ResponsesRequest>
```

**Purpose**: Shared helper that executes a real phase-2 run against a mock SSE server and returns the captured consolidation request. It seeds one completed stage-1 output and prepares the memory root so the consolidation agent can run.

**Data flow**: Builds a test Codex with the supplied memories config, constructs `MockMemoryModelProvider`, obtains the state DB, seeds a stage-1 output, mounts a mock phase-2 SSE response, builds a startup context/config with the injected provider, creates the memory root, seeds extension instructions, runs `phase2::run`, waits for the single request and workspace reset, shuts down the test Codex, and returns the captured request.

**Call relations**: Called by the phase-2 provider-default and explicit-override tests. It exercises the production `phase2::run` path with controlled inputs.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, seed_extension_instructions, run, new, build_test_codex_with_memories_config, memory_startup_context_with_provider, seed_stage1_output, shutdown_test_codex, wait_for_phase2_workspace_reset (+1 more)); called by 2 (memories_startup_phase2_explicit_model_override_drives_request_model, memories_startup_phase2_provider_default_drives_request_model); 5 external calls (new, now, memory_root, create_dir_all, vec!).


##### `startup_test_memories_config`  (lines 504–510)

```
fn startup_test_memories_config() -> MemoriesConfig
```

**Purpose**: Builds the baseline memories configuration used by startup tests. It keeps consolidation input selection small and allows immediate rollout eligibility.

**Data flow**: Starts from `MemoriesConfig::default()`, overrides `max_raw_memories_for_consolidation` to 1 and `min_rollout_idle_hours` to 0, and returns the resulting struct.

**Call relations**: Used by multiple test builders and model-selection tests as the common default memories config.

*Call graph*: calls 1 internal fn (default); called by 5 (build_test_codex, memories_startup_phase1_explicit_model_override_drives_request_model, memories_startup_phase1_provider_default_drives_request_model, memories_startup_phase2_explicit_model_override_drives_request_model, memories_startup_phase2_provider_default_drives_request_model).


##### `build_test_codex`  (lines 512–517)

```
async fn build_test_codex(
    server: &wiremock::MockServer,
    home: Arc<TempDir>,
) -> anyhow::Result<TestCodex>
```

**Purpose**: Convenience wrapper that builds a `TestCodex` using the standard startup-test memories configuration. It reduces duplication in tests that do not need custom memory settings.

**Data flow**: Accepts the mock server and temp home, calls `startup_test_memories_config`, forwards both into `build_test_codex_with_memories_config`, and returns the resulting `TestCodex`.

**Call relations**: Used by several top-level startup integration tests.

*Call graph*: calls 2 internal fn (build_test_codex_with_memories_config, startup_test_memories_config); called by 5 (memories_startup_creates_memory_root, memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata, memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs).


##### `build_test_codex_with_memories_config`  (lines 519–535)

```
async fn build_test_codex_with_memories_config(
    server: &wiremock::MockServer,
    home: Arc<TempDir>,
    memories: MemoriesConfig,
) -> anyhow::Result<TestCodex>
```

**Purpose**: Constructs a `TestCodex` configured for memories startup testing with SQLite enabled and a caller-supplied memories config. It is the common environment builder for this file.

**Data flow**: Starts from `test_codex()`, sets the home directory, mutates the config in a closure to enable `Feature::Sqlite` and assign `config.memories = memories`, then builds against the mock server and returns the async result.

**Call relations**: Called by `build_test_codex` and the phase-1/phase-2 request helper functions.

*Call graph*: calls 1 internal fn (test_codex); called by 3 (build_test_codex, run_memory_phase_one_model_request_test, run_memory_phase_two_model_request_test).


##### `init_state_db`  (lines 537–542)

```
async fn init_state_db(home: &Arc<TempDir>) -> anyhow::Result<Arc<codex_state::StateRuntime>>
```

**Purpose**: Initializes a standalone state DB for tests that need to seed memory rows before constructing a full `TestCodex`. It also marks backfill complete so startup logic can proceed normally.

**Data flow**: Takes the temp home, calls `StateRuntime::init` with the home path and a test provider name, awaits `mark_backfill_complete(None)`, and returns the `Arc<StateRuntime>`.

**Call relations**: Used by phase-2 integration tests that seed DB state directly before startup.

*Call graph*: calls 1 internal fn (init); called by 3 (memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs).


##### `trigger_memories_startup`  (lines 544–559)

```
async fn trigger_memories_startup(test: &TestCodex)
```

**Purpose**: Enables the memory feature in a cloned config snapshot and invokes the public startup entrypoint for a test thread. It is the standard way tests kick off the asynchronous startup pipeline.

**Data flow**: Reads the live config snapshot from the test Codex, clones the base config, enables `Feature::MemoryTool`, wraps the config in `Arc`, and calls `start_memories_startup_task` with the thread manager, auth manager, configured thread ID, thread handle, config, and session source. It returns no value.

**Call relations**: Used by the end-to-end startup tests to invoke the same entrypoint production code uses.

*Call graph*: called by 4 (memories_startup_creates_memory_root, memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs); 3 external calls (clone, new, start_memories_startup_task).


##### `memory_startup_context_with_provider`  (lines 561–583)

```
async fn memory_startup_context_with_provider(
    test: &TestCodex,
    provider: SharedModelProvider,
) -> (Arc<MemoryStartupContext>, Arc<codex_core::config::Config>)
```

**Purpose**: Builds a `MemoryStartupContext` and shared config for tests that need to call phase functions directly with an injected provider. It mirrors production startup-context creation while allowing provider substitution.

**Data flow**: Reads the live config snapshot, clones the base config, enables `Feature::MemoryTool`, wraps the config in `Arc`, constructs `MemoryStartupContext::new_for_testing` with the supplied provider and current thread/session data, wraps that in `Arc`, and returns `(context, config)`.

**Call relations**: Used by the phase-1 and phase-2 model-request helper functions.

*Call graph*: calls 1 internal fn (new_for_testing); called by 2 (run_memory_phase_one_model_request_test, run_memory_phase_two_model_request_test); 2 external calls (clone, new).


##### `MockMemoryModelProvider::new`  (lines 594–598)

```
fn new(info: ModelProviderInfo, auth_manager: Option<Arc<AuthManager>>) -> Self
```

**Purpose**: Creates the mock provider wrapper around a real provider implementation. The wrapper delegates most behavior unchanged while overriding memory-specific preferred-model methods.

**Data flow**: Takes `ModelProviderInfo` and optional `AuthManager`, creates the delegate with `create_model_provider`, stores it in `MockMemoryModelProvider`, and returns the wrapper.

**Call relations**: Called by both model-request helper functions before constructing a startup context with injected provider behavior.

*Call graph*: called by 2 (run_memory_phase_one_model_request_test, run_memory_phase_two_model_request_test); 1 external calls (create_model_provider).


##### `MockMemoryModelProvider::info`  (lines 602–604)

```
fn info(&self) -> &ModelProviderInfo
```

**Purpose**: Delegates provider metadata access to the wrapped real provider. It preserves all non-memory-specific provider identity behavior.

**Data flow**: Returns `self.delegate.info()`. No state changes occur.

**Call relations**: Part of the `ModelProvider` trait implementation used implicitly by runtime code when interacting with the injected provider.

*Call graph*: 1 external calls (info).


##### `MockMemoryModelProvider::memory_extraction_preferred_model`  (lines 606–608)

```
fn memory_extraction_preferred_model(&self) -> &'static str
```

**Purpose**: Overrides the provider’s preferred phase-1 extraction model with a fixed test constant. This lets tests prove provider defaults are consulted.

**Data flow**: Reads no inputs beyond `self` and returns the static string `MOCK_PROVIDER_PHASE_ONE_MODEL`.

**Call relations**: Consumed indirectly by phase-1 `build_request_context` when no explicit extraction-model override is configured.


##### `MockMemoryModelProvider::memory_consolidation_preferred_model`  (lines 610–612)

```
fn memory_consolidation_preferred_model(&self) -> &'static str
```

**Purpose**: Overrides the provider’s preferred phase-2 consolidation model with a fixed test constant. This lets tests prove provider defaults are consulted.

**Data flow**: Reads no mutable state and returns the static string `MOCK_PROVIDER_PHASE_TWO_MODEL`.

**Call relations**: Consumed indirectly by phase-2 `agent::get_config` when no explicit consolidation-model override is configured.


##### `MockMemoryModelProvider::auth_manager`  (lines 614–616)

```
fn auth_manager(&self) -> Option<Arc<AuthManager>>
```

**Purpose**: Delegates auth-manager access to the wrapped provider. It keeps authentication behavior realistic in tests.

**Data flow**: Returns `self.delegate.auth_manager()`. No mutation occurs.

**Call relations**: Part of the trait implementation used by runtime/model-client setup when the mock provider is injected.

*Call graph*: 1 external calls (auth_manager).


##### `MockMemoryModelProvider::auth`  (lines 618–621)

```
fn auth(&self) -> ModelProviderFuture<'_, Option<CodexAuth>>
```

**Purpose**: Delegates asynchronous auth lookup to the wrapped provider. It preserves real auth behavior while still allowing memory-model overrides.

**Data flow**: Clones the delegate `Arc`, returns a boxed pinned future, and inside that future awaits `delegate.auth()`. It yields `Option<CodexAuth>`.

**Call relations**: Used implicitly through the `ModelProvider` trait by runtime code that may need provider auth.

*Call graph*: 2 external calls (clone, pin).


##### `MockMemoryModelProvider::account_state`  (lines 623–625)

```
fn account_state(&self) -> ProviderAccountResult
```

**Purpose**: Delegates provider account-state reporting to the wrapped provider. This avoids test-specific divergence in account readiness behavior.

**Data flow**: Returns `self.delegate.account_state()`. No side effects.

**Call relations**: Part of the trait implementation; not memory-specific but required for a complete provider wrapper.

*Call graph*: 1 external calls (account_state).


##### `MockMemoryModelProvider::models_manager`  (lines 627–634)

```
fn models_manager(
        &self,
        codex_home: PathBuf,
        config_model_catalog: Option<ModelsResponse>,
    ) -> codex_models_manager::manager::SharedModelsManager
```

**Purpose**: Delegates models-manager construction to the wrapped provider. This keeps model metadata resolution realistic while only overriding preferred-model names.

**Data flow**: Accepts `codex_home` and optional model catalog, forwards them to `self.delegate.models_manager`, and returns the shared models manager.

**Call relations**: Used indirectly by runtime model-info lookup when tests build stage-one request contexts.

*Call graph*: 1 external calls (models_manager).


##### `seed_stage1_output`  (lines 637–669)

```
async fn seed_stage1_output(
    db: &codex_state::StateRuntime,
    codex_home: &Path,
    updated_at: chrono::DateTime<chrono::Utc>,
    raw_memory: &str,
    rollout_summary: &str,
    rollout_slug
```

**Purpose**: Seeds a completed stage-1 output row for a newly created thread with realistic metadata such as rollout path, cwd, provider, and git branch. It is the main helper for phase-2 input setup.

**Data flow**: Creates a new `ThreadId`, builds thread metadata with rollout path, updated timestamp, CLI session source, cwd, provider, and git branch, upserts that metadata into the DB, then calls `seed_stage1_output_for_existing_thread` with the generated thread ID and supplied raw memory/summary/slug. It returns the seeded thread ID.

**Call relations**: Used by several phase-2 tests and by the phase-2 model-request helper to create DB-backed consolidation inputs.

*Call graph*: calls 3 internal fn (seed_stage1_output_for_existing_thread, new, new); called by 3 (memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_tracks_workspace_diff_across_runs, run_memory_phase_two_model_request_test); 4 external calls (timestamp, join, format!, upsert_thread).


##### `seed_stage1_candidate`  (lines 671–710)

```
async fn seed_stage1_candidate(
    db: &codex_state::StateRuntime,
    codex_home: &Path,
    updated_at: chrono::DateTime<chrono::Utc>,
    rollout_slug: &str,
) -> anyhow::Result<ThreadId>
```

**Purpose**: Seeds an eligible phase-1 candidate thread by writing a rollout JSONL file and corresponding thread metadata, then enabling memory mode for that thread. It is the main helper for phase-1 input setup.

**Data flow**: Creates a new thread ID and rollout path, builds one `RolloutLine` containing a user message, serializes it to JSONL and writes it to disk, constructs thread metadata with cwd/provider/git branch and preview fields, upserts the metadata, enables thread memory mode in the DB, and returns the thread ID.

**Call relations**: Used by `run_memory_phase_one_model_request_test` to create a claimable rollout for phase 1.

*Call graph*: calls 2 internal fn (new, new); called by 1 (run_memory_phase_one_model_request_test); 9 external calls (to_rfc3339, join, format!, ResponseItem, to_string, set_thread_memory_mode, upsert_thread, write, vec!).


##### `wait_for_single_request`  (lines 712–714)

```
async fn wait_for_single_request(mock: &ResponseMock) -> ResponsesRequest
```

**Purpose**: Waits until a mock server has received at least one request and returns the first captured request. It is a convenience wrapper for tests expecting exactly one model call.

**Data flow**: Calls `wait_for_request(mock, 1)`, removes index 0 from the returned vector, and returns that `ResponsesRequest`.

**Call relations**: Used by multiple tests and helper functions after triggering phase-1 or phase-2 model activity.

*Call graph*: calls 1 internal fn (wait_for_request); called by 6 (memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata, memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs, run_memory_phase_one_model_request_test, run_memory_phase_two_model_request_test).


##### `wait_for_file_removed`  (lines 716–729)

```
async fn wait_for_file_removed(path: &Path) -> anyhow::Result<()>
```

**Purpose**: Polls until a file no longer exists or times out. It is used to observe asynchronous cleanup effects such as diff-file deletion or stale-resource pruning.

**Data flow**: Computes a deadline 10 seconds in the future, loops checking `tokio::fs::try_exists(path)`, returns `Ok(())` once the file is absent, otherwise asserts the deadline has not passed and sleeps 50 ms before retrying.

**Call relations**: Used directly by extension-pruning tests and by `wait_for_phase2_workspace_reset`.

*Call graph*: called by 3 (memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, wait_for_phase2_workspace_reset); 6 external calls (from_millis, from_secs, now, assert!, try_exists, sleep).


##### `wait_for_dir`  (lines 731–744)

```
async fn wait_for_dir(path: &Path) -> anyhow::Result<()>
```

**Purpose**: Polls until a directory exists and is actually a directory, or times out. It is used to observe asynchronous creation of the memories root.

**Data flow**: Computes a 10-second deadline, loops checking `try_exists(path)` and `path.is_dir()`, returns success once both are true, otherwise asserts the deadline has not passed and sleeps 50 ms between checks.

**Call relations**: Used by `memories_startup_creates_memory_root`.

*Call graph*: called by 1 (memories_startup_creates_memory_root); 7 external calls (from_millis, from_secs, now, is_dir, assert!, try_exists, sleep).


##### `wait_for_request`  (lines 746–760)

```
async fn wait_for_request(mock: &ResponseMock, expected_count: usize) -> Vec<ResponsesRequest>
```

**Purpose**: Polls a `ResponseMock` until it has captured at least the expected number of requests. It provides a generic asynchronous wait primitive for request assertions.

**Data flow**: Computes a 10-second deadline, repeatedly reads `mock.requests()`, returns the vector once its length reaches `expected_count`, otherwise asserts the deadline has not passed and sleeps 50 ms.

**Call relations**: Used by `wait_for_single_request`, which is then used throughout the test file.

*Call graph*: calls 1 internal fn (requests); called by 1 (wait_for_single_request); 5 external calls (from_millis, from_secs, now, assert!, sleep).


##### `wait_for_service_tier`  (lines 762–779)

```
async fn wait_for_service_tier(
    test: &TestCodex,
    expected_service_tier: Option<String>,
) -> anyhow::Result<codex_core::ThreadConfigSnapshot>
```

**Purpose**: Polls the live thread config snapshot until the expected service tier appears. It is used to ensure runtime state has caught up before constructing a phase-1 request context.

**Data flow**: Computes a deadline, repeatedly awaits `test.codex.config_snapshot()`, compares `service_tier` to the expected value, returns the snapshot on match, otherwise uses `anyhow::ensure!` to fail on timeout and sleeps 50 ms between polls.

**Call relations**: Used only by the service-tier/detached-metadata integration test.

*Call graph*: called by 1 (memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata); 5 external calls (from_millis, from_secs, now, ensure!, sleep).


##### `phase2_prompt_text`  (lines 781–787)

```
fn phase2_prompt_text(request: &ResponsesRequest) -> String
```

**Purpose**: Extracts the user prompt text from a captured phase-2 request by finding the message that mentions the workspace diff heading. It simplifies prompt-content assertions in tests.

**Data flow**: Reads all user-role input texts from the `ResponsesRequest`, finds the first containing `Memory workspace diff:`, and returns it as a `String`, panicking if none is found.

**Call relations**: Used by several phase-2 tests to inspect the generated consolidation prompt.

*Call graph*: calls 1 internal fn (message_input_texts); called by 3 (memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs).


##### `wait_for_phase2_workspace_reset`  (lines 789–804)

```
async fn wait_for_phase2_workspace_reset(memory_root: &Path) -> anyhow::Result<()>
```

**Purpose**: Waits until phase 2 has both removed the workspace diff file and restored the git workspace to a clean baseline. It is the main synchronization point for asynchronous consolidation completion in tests.

**Data flow**: First awaits `wait_for_file_removed(memory_root.join("phase2_workspace_diff.md"))`, then polls `diff_since_latest_init(memory_root)` until it succeeds and reports no changes, with a 10-second timeout and 50 ms sleeps. It returns `Ok(())` on success.

**Call relations**: Used by multiple phase-2 tests and the phase-2 model-request helper after triggering consolidation.

*Call graph*: calls 1 internal fn (wait_for_file_removed); called by 4 (memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs, run_memory_phase_two_model_request_test); 7 external calls (from_millis, from_secs, now, join, assert!, diff_since_latest_init, sleep).


##### `seed_stage1_output_for_existing_thread`  (lines 806–842)

```
async fn seed_stage1_output_for_existing_thread(
    db: &codex_state::StateRuntime,
    thread_id: ThreadId,
    updated_at: i64,
    raw_memory: &str,
    rollout_summary: &str,
    rollout_slug: Op
```

**Purpose**: Marks an already-existing thread as having a successful stage-1 output by first claiming the stage-1 job and then completing it. It asserts that the success transition enqueues global consolidation.

**Data flow**: Creates a new owner thread ID, calls `try_claim_stage1_job` for the target thread and timestamp, extracts the ownership token from the claimed outcome or panics otherwise, then calls `mark_stage1_job_succeeded` with the supplied raw memory, summary, and optional slug and asserts the returned boolean is true. It returns `anyhow::Result<()>`.

**Call relations**: Used by `seed_stage1_output` to populate completed phase-1 rows in the DB.

*Call graph*: calls 2 internal fn (new, memories); called by 1 (seed_stage1_output); 2 external calls (assert!, panic!).


##### `read_rollout_summary_bodies`  (lines 844–852)

```
async fn read_rollout_summary_bodies(memory_root: &Path) -> anyhow::Result<Vec<String>>
```

**Purpose**: Reads all rollout summary files from the memory workspace and returns their contents sorted. It is a helper for asserting phase-2 storage output.

**Data flow**: Opens the `rollout_summaries` directory under the memory root, iterates entries asynchronously, reads each file to string, pushes contents into a vector, sorts the vector, and returns it.

**Call relations**: Used by the workspace-diff tracking test to verify which summaries remain after consolidation input sync.

*Call graph*: called by 1 (memories_startup_phase2_tracks_workspace_diff_across_runs); 4 external calls (join, new, read_dir, read_to_string).


##### `shutdown_test_codex`  (lines 854–858)

```
async fn shutdown_test_codex(test: &TestCodex) -> anyhow::Result<()>
```

**Purpose**: Gracefully shuts down a `TestCodex` instance and waits for the shutdown-complete event. It ensures background tasks and threads are cleaned up between tests.

**Data flow**: Submits `Op::Shutdown {}` to the test Codex thread, waits for an event matching `EventMsg::ShutdownComplete`, and returns `Ok(())`.

**Call relations**: Called at the end of most integration tests and helper flows to cleanly tear down the test runtime.

*Call graph*: called by 7 (memories_startup_creates_memory_root, memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata, memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs, run_memory_phase_one_model_request_test, run_memory_phase_two_model_request_test); 1 external calls (wait_for_event).


### `memories/write/src/storage_tests.rs`

`test` · `test execution for memory storage naming and sync behavior`

This test module exercises the storage-layer conventions used by the memory writer. Two small helpers construct stable `Stage1Output` fixtures: `stage1_output_with_slug` fills every field with fixed timestamps, paths, and text while varying only `thread_id` and `rollout_slug`, and `fixed_thread_id` supplies a UUID-like `ThreadId` whose embedded timestamp/hash produce a predictable filename stem. The first three tests focus on `rollout_summary_file_stem`, asserting that when `rollout_slug` is absent or empty the stem falls back to the fixed UUID/timestamp/hash prefix, and when a slug is present it is lowercased, sanitized into underscore-separated safe characters, and truncated to exactly 60 characters after the prefix.

The async integration test builds a temporary memory root with `ensure_layout`, manually seeds stale rollout-summary files named only by thread id, then supplies a single current `Stage1Output`. It runs `sync_rollout_summaries_from_memories` and `rebuild_raw_memories_file_from_memories`, then confirms both stale files are deleted, exactly one canonical summary file remains in `rollout_summaries_dir`, and the regenerated raw memories file contains the expected serialized fields: raw memory text, thread id, cwd, rollout path, and the canonical rollout summary filename. The key invariant captured here is that storage is keyed by the current canonical naming scheme, not legacy thread-id-only filenames, and that the raw memories file must reference the actual summary artifact chosen during sync.

#### Function details

##### `stage1_output_with_slug`  (lines 18–30)

```
fn stage1_output_with_slug(thread_id: ThreadId, rollout_slug: Option<&str>) -> Stage1Output
```

**Purpose**: Builds a deterministic `Stage1Output` fixture with fixed timestamps, text payloads, and filesystem paths, varying only the supplied `ThreadId` and optional rollout slug. The helper makes filename-stem tests stable by keeping all other inputs constant.

**Data flow**: It takes a `ThreadId` and `Option<&str>` slug, constructs a `Stage1Output` with `source_updated_at` at Unix second 123 and `generated_at` at 124, fixed `raw_memory`/`rollout_summary` strings, `/tmp/rollout.jsonl` as `rollout_path`, `/tmp/workspace` as `cwd`, and `git_branch: None`. It converts the optional slug into `Option<String>` and returns the populated struct without mutating external state.

**Call relations**: This helper is invoked by the three filename-stem tests to feed controlled inputs into `rollout_summary_file_stem`; it exists solely to isolate those tests from unrelated `Stage1Output` fields.

*Call graph*: called by 3 (rollout_summary_file_stem_sanitizes_and_truncates_slug, rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_is_empty, rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_missing); 1 external calls (from).


##### `fixed_thread_id`  (lines 32–34)

```
fn fixed_thread_id() -> ThreadId
```

**Purpose**: Creates a known-valid `ThreadId` from a hard-coded string so tests can assert an exact derived filename prefix. Its value is chosen to make the stem output reproducible.

**Data flow**: It reads no external state, parses the literal `0194f5a6-89ab-7cde-8123-456789abcdef` via `ThreadId::try_from`, and returns the resulting `ThreadId`, panicking if parsing unexpectedly fails.

**Call relations**: The filename-stem tests call this before constructing their `Stage1Output` fixtures, ensuring all of them share the same deterministic thread identifier.

*Call graph*: calls 1 internal fn (try_from); called by 3 (rollout_summary_file_stem_sanitizes_and_truncates_slug, rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_is_empty, rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_missing).


##### `rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_missing`  (lines 37–42)

```
fn rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_missing()
```

**Purpose**: Verifies that a memory with no `rollout_slug` produces only the UUID/timestamp/hash-based stem, with no slug suffix appended.

**Data flow**: It obtains the fixed thread id, builds a `Stage1Output` with `rollout_slug: None`, passes that fixture to `rollout_summary_file_stem`, and compares the returned stem string against the constant `FIXED_PREFIX`.

**Call relations**: This is a direct unit test of the fallback branch in stem generation, using the two local fixture helpers and asserting the exact output expected from the production naming function.

*Call graph*: calls 2 internal fn (fixed_thread_id, stage1_output_with_slug); 1 external calls (assert_eq!).


##### `rollout_summary_file_stem_sanitizes_and_truncates_slug`  (lines 45–61)

```
fn rollout_summary_file_stem_sanitizes_and_truncates_slug()
```

**Purpose**: Checks that a non-empty slug is normalized into a safe filename suffix and cut to the configured maximum length. It validates both the presence of the suffix and its exact sanitized content.

**Data flow**: It creates a fixed-thread fixture whose slug contains spaces, punctuation, slash characters, mixed case, and an overlong tail. After calling `rollout_summary_file_stem`, it strips the known prefix plus hyphen, asserts the remaining slug suffix length is 60, and compares it to the expected lowercase underscore-normalized truncated string.

**Call relations**: This test drives the slug-processing branch of `rollout_summary_file_stem`, confirming the production function’s sanitization and truncation rules rather than just checking that some suffix exists.

*Call graph*: calls 2 internal fn (fixed_thread_id, stage1_output_with_slug); 3 external calls (assert_eq!, format!, rollout_summary_file_stem).


##### `rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_is_empty`  (lines 64–69)

```
fn rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_is_empty()
```

**Purpose**: Verifies that an explicitly empty slug is treated the same as a missing slug and does not contribute a suffix to the filename stem.

**Data flow**: It builds a deterministic `Stage1Output` with `rollout_slug: Some("")`, calls `rollout_summary_file_stem`, and asserts the result equals `FIXED_PREFIX`.

**Call relations**: Like the missing-slug test, this targets the fallback path in stem generation, but specifically covers the edge case where the slug field exists yet contains no usable content.

*Call graph*: calls 2 internal fn (fixed_thread_id, stage1_output_with_slug); 1 external calls (assert_eq!).


##### `sync_rollout_summaries_and_raw_memories_file_keeps_latest_memories_only`  (lines 72–149)

```
async fn sync_rollout_summaries_and_raw_memories_file_keeps_latest_memories_only()
```

**Purpose**: Exercises the end-to-end storage refresh path to ensure stale rollout summary files are pruned and the raw memories file is rebuilt to reference only current memories and their canonical summary filenames.

**Data flow**: It creates a temporary root, initializes the expected directory layout, writes two preexisting `.md` files under `rollout_summaries_dir` named from `keep_id` and `drop_id`, then constructs a one-element `Vec<Stage1Output>` for only the keep thread. It invokes `sync_rollout_summaries_from_memories` and `rebuild_raw_memories_file_from_memories`, checks via `try_exists` that both old files are gone, enumerates the summaries directory to capture the single surviving canonical filename, reads `raw_memories_file`, and asserts that file text includes the memory body, keep thread id, cwd, rollout path, and `rollout_summary_file: <canonical name>` line.

**Call relations**: This async integration test drives the production sync/rebuild functions under realistic filesystem conditions: after layout setup and stale-file seeding, it validates that sync removes legacy and dropped artifacts and that rebuild emits metadata consistent with the summary file chosen by sync.

*Call graph*: calls 1 internal fn (default); 14 external calls (new, assert!, assert_eq!, ensure_layout, raw_memories_file, rebuild_raw_memories_file_from_memories, rollout_summaries_dir, sync_rollout_summaries_from_memories, format!, tempdir (+4 more)).


### `memories/write/src/workspace_tests.rs`

`test` · `test execution for workspace diff formatting and git-baseline behavior`

This test module imports the workspace implementation directly and validates both pure formatting helpers and filesystem-backed git-baseline behavior. `render_workspace_diff_file_bounds_large_diff` constructs a `GitBaselineDiff` with one modified file and a `unified_diff` larger than `crate::workspace_diff::MAX_BYTES`; it confirms the rendered markdown includes the status line, the explicit truncation notice with the configured byte count, and a properly closed fenced diff block. The two async tests exercise the real workspace lifecycle in a temporary directory. `reset_memory_workspace_baseline_removes_generated_diff` prepares a workspace, writes a memory file and a generated diff artifact, resets the baseline, then asserts the generated file is gone and a subsequent `memory_workspace_diff` reports no changes. `prepare_memory_workspace_recovers_unusable_git_dir` seeds an empty `.git` directory to simulate unusable metadata and verifies preparation repairs the workspace enough that the diff is empty.

The final unit test targets `previous_char_boundary` with the multibyte string `"aé"`, proving truncation at byte index 2 backs up to byte 1 rather than splitting the `é`. Together these tests document the module’s key invariants: generated diff files are ephemeral, baseline reset leaves a clean diff state, preparation can recover from stale git metadata, and truncation logic is UTF-8 aware.

#### Function details

##### `render_workspace_diff_file_bounds_large_diff`  (lines 9–23)

```
fn render_workspace_diff_file_bounds_large_diff()
```

**Purpose**: Verifies that rendering a diff larger than the configured byte cap produces a truncated markdown artifact with the expected status line and closing fence.

**Data flow**: It constructs a `GitBaselineDiff` containing one `GitBaselineChange` marked `Modified` for `MEMORY.md` and a `unified_diff` string of `MAX_BYTES + 128` repeated `a` characters. It passes that diff to `render_workspace_diff_file` and asserts the returned string contains `- M MEMORY.md`, the truncation marker, and ends with "```\n".

**Call relations**: This is a pure unit test of `render_workspace_diff_file`, indirectly exercising `append_bounded_diff` and the truncation path without touching the filesystem.

*Call graph*: 2 external calls (assert!, vec!).


##### `reset_memory_workspace_baseline_removes_generated_diff`  (lines 26–55)

```
async fn reset_memory_workspace_baseline_removes_generated_diff()
```

**Purpose**: Checks that resetting the workspace baseline deletes the generated diff artifact and leaves the workspace in a no-changes state.

**Data flow**: It creates a temporary root, calls `prepare_memory_workspace`, writes `MEMORY.md`, writes a generated workspace diff file via `write_workspace_diff` using an `Added` change and `+memory\n` unified diff, then calls `reset_memory_workspace_baseline`. Afterward it asserts the diff artifact path no longer exists, calls `memory_workspace_diff`, and asserts the returned `changes` vector is empty.

**Call relations**: This async integration test drives the normal prepare → write diff → reset baseline → diff again sequence, validating the interaction among the public workspace functions.

*Call graph*: 5 external calls (new, assert!, assert_eq!, write, vec!).


##### `prepare_memory_workspace_recovers_unusable_git_dir`  (lines 58–72)

```
async fn prepare_memory_workspace_recovers_unusable_git_dir()
```

**Purpose**: Ensures workspace preparation can recover when a `.git` directory exists but is unusable or incomplete.

**Data flow**: It creates a temporary workspace root, manually creates `root/.git`, writes `MEMORY.md`, invokes `prepare_memory_workspace`, then calls `memory_workspace_diff` and asserts the resulting `changes` vector is empty.

**Call relations**: This test targets the recovery behavior delegated by `prepare_memory_workspace` to `ensure_git_baseline_repository`, confirming callers can rely on preparation to normalize stale git metadata before diffing.

*Call graph*: 4 external calls (new, assert_eq!, create_dir_all, write).


##### `previous_char_boundary_handles_multibyte_text`  (lines 75–78)

```
fn previous_char_boundary_handles_multibyte_text()
```

**Purpose**: Confirms that UTF-8 truncation logic backs up to a valid character boundary when the requested byte index lands inside a multibyte character.

**Data flow**: It defines `text` as `"aé"`, calls `previous_char_boundary(text, 2)`, and asserts the returned index is `1`, the boundary before the two-byte `é`.

**Call relations**: This is a focused unit test of the low-level helper used by `append_bounded_diff` to keep truncated diff output valid UTF-8.

*Call graph*: 1 external calls (assert_eq!).


### Message and thread store fixtures
Persistence tests for message history are paired with reusable local thread-store fixtures for realistic rollout-backed storage scenarios.

### `message-history/src/tests.rs`

`test` · `test execution for history file lookup and trimming semantics`

This test module exercises the internal file-oriented helpers directly as well as the public append path. The first three async tests focus on read-side correctness. `lookup_reads_history_entries` writes two serialized `HistoryEntry` lines to a temporary `history.jsonl`, obtains `(log_id, count)` from `history_metadata_for_file`, and confirms `lookup_history_entry` returns the second parsed record at offset 1. `history_metadata_counts_newlines_across_read_boundaries` writes a byte vector larger than three read buffers with newline bytes placed at exact buffer edges and verifies the newline count matches all inserted offsets, proving chunked scanning with `memchr_iter` does not miss boundary cases. `lookup_uses_stable_log_id_after_appends` confirms that appending to the same file preserves the original `log_id` and allows lookup of the newly appended line.

The final two tests drive `append_entry` with a temporary `HistoryConfig`. `append_entry_trims_history_when_beyond_max_bytes` sets `max_bytes` just above the first entry’s serialized length, appends a second entry, and verifies the first line is evicted so only the newest remains within the hard cap. `append_entry_trims_history_to_soft_cap` constructs a scenario where dropping only the oldest line would satisfy the hard cap but still exceed the 80% soft cap; after a third append it confirms the file is pruned more aggressively down to a single newest long entry. These tests document the crate’s whole-line retention policy and its preference for trimming to a soft target rather than merely under the hard limit.

#### Function details

##### `lookup_reads_history_entries`  (lines 9–42)

```
async fn lookup_reads_history_entries()
```

**Purpose**: Verifies that metadata counting and offset-based lookup work together on a normal JSONL history file.

**Data flow**: It creates a temporary history file, builds two `HistoryEntry` values, serializes and writes each as one line, then awaits `history_metadata_for_file` to obtain `(log_id, count)`. It asserts `count` equals the number of entries, calls `lookup_history_entry(&history_path, log_id, 1)`, and asserts the returned entry equals the second fixture.

**Call relations**: This test exercises the read-side pairing of `history_metadata_for_file` and `lookup_history_entry`, showing how callers can count entries and then dereference a specific offset.

*Call graph*: 5 external calls (create, new, assert_eq!, vec!, writeln!).


##### `history_metadata_counts_newlines_across_read_boundaries`  (lines 45–64)

```
async fn history_metadata_counts_newlines_across_read_boundaries()
```

**Purpose**: Checks that newline counting remains correct when newline bytes fall exactly at or across internal read-buffer boundaries.

**Data flow**: It allocates a byte vector of length `3 * HISTORY_READ_BUFFER_SIZE + 1`, overwrites selected offsets with `b'\n'` including positions at `buffer_size - 1`, `buffer_size`, and `2 * buffer_size`, writes the bytes to the history file, then awaits `history_metadata_for_file` and asserts the returned count equals the number of inserted newline offsets.

**Call relations**: This is a focused regression-style test for the chunked scanning logic inside `history_metadata_for_file`, specifically its use of `memchr_iter` over repeated reads.

*Call graph*: 4 external calls (new, assert_eq!, write, vec!).


##### `lookup_uses_stable_log_id_after_appends`  (lines 67–107)

```
async fn lookup_uses_stable_log_id_after_appends()
```

**Purpose**: Ensures that appending to an existing history file does not invalidate the file identity used for later offset lookups.

**Data flow**: It writes one initial serialized `HistoryEntry`, obtains `(log_id, count)` from `history_metadata_for_file`, asserts the count is 1, reopens the same file in append mode, writes a second serialized entry, then calls `lookup_history_entry(&history_path, log_id, 1)` and asserts the fetched entry equals the appended one.

**Call relations**: This test demonstrates the intended contract of `log_id`: appends preserve identity, so offsets obtained against the same file remain meaningful as new lines are added.

*Call graph*: 5 external calls (create, new, assert_eq!, new, writeln!).


##### `append_entry_trims_history_when_beyond_max_bytes`  (lines 110–149)

```
async fn append_entry_trims_history_when_beyond_max_bytes()
```

**Purpose**: Verifies that when a second append pushes the file over `max_bytes`, the oldest entry is evicted and the newest entry is retained.

**Data flow**: It creates a temporary Codex home, starts from `History::default()`, builds a `HistoryConfig`, appends a 200-character first entry, reads the resulting file length, sets `history.max_bytes` to `first_len + 10`, rebuilds the config, and appends a second 200-character entry. It then reads the file contents, parses each line back into `HistoryEntry`, asserts only one entry remains and its `text` is the second entry, and checks the file length is at most the configured limit.

**Call relations**: This async test drives the public `append_entry` API through the trimming path, validating the behavior implemented by `enforce_history_limit` under a simple hard-cap overflow.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, assert!, assert_eq!, default, metadata, read_to_string, try_from).


##### `append_entry_trims_history_to_soft_cap`  (lines 152–220)

```
async fn append_entry_trims_history_to_soft_cap()
```

**Purpose**: Checks that trimming uses the soft-cap target rather than merely dropping enough old data to get under the hard cap.

**Data flow**: It appends a short entry and then a long entry to measure their serialized lengths, computes a `max_bytes` value where keeping both long entries would fit under the hard cap after dropping the first short entry but still exceed the soft cap, rebuilds `HistoryConfig`, and appends a third long entry. It parses the resulting file, asserts only one entry remains and it is the newest long entry, verifies the final file length is within `max_bytes`, computes the soft-cap byte target, and asserts the retained length equals the single long-entry length and is within `soft_cap.max(long_entry_len)`.

**Call relations**: This test specifically targets the `trim_target_bytes` policy used by `enforce_history_limit`, proving the implementation trims more aggressively than the hard cap alone when necessary.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, assert!, assert_eq!, default, metadata, read_to_string, try_from).


### `thread-store/src/local/test_support.rs`

`test` · `test setup`

This file is a compact test-fixture library used across the local thread-store test modules. `test_config` constructs a `LocalThreadStoreConfig` rooted entirely under a temporary directory, using the same path for `codex_home` and `sqlite_home` and a fixed default provider ID of `test-provider`. The remaining helpers create rollout files with the on-disk shape that production code expects.

`write_session_file` and `write_archived_session_file` are convenience wrappers that choose standard active and archived directories respectively, then delegate to `write_session_file_with`. `write_session_file_with` adds control over the first user message and optional model provider while still using the common file-writing implementation. The lowest-level helper, `write_session_file_with_fork`, creates the target directory, names the file `rollout-<timestamp>-<uuid>.jsonl`, and writes two JSON lines: a `session_meta` record containing thread ID, optional `forked_from_id`, timestamp, cwd, originator, CLI version, source, model provider, and nested git metadata; followed by an `event_msg` user-message record with the supplied message.

Because many tests rely on rollout parsing, provider fallback, git extraction, fork ancestry, archived detection, and legacy session-meta compatibility, these helpers intentionally produce concrete payloads that exercise those code paths rather than minimal placeholder files.

#### Function details

##### `test_config`  (lines 11–17)

```
fn test_config(codex_home: &Path) -> LocalThreadStoreConfig
```

**Purpose**: Builds a standard `LocalThreadStoreConfig` for tests rooted at a temporary directory with a fixed default provider.

**Data flow**: Takes `codex_home: &Path`, clones it into both `codex_home` and `sqlite_home` `PathBuf`s, sets `default_model_provider_id` to `"test-provider"`, and returns the config.

**Call relations**: Used broadly by tests across local-store modules to create isolated stores with predictable configuration.

*Call graph*: called by 65 (archive_thread_moves_rollout_to_archived_collection, archive_thread_updates_sqlite_metadata_when_present, delete_rollout_file_treats_vanished_path_as_already_deleted, delete_thread_removes_active_and_archived_rollouts, delete_thread_reports_missing_thread, list_threads_preserves_sqlite_title_search_results, list_threads_rejects_invalid_cursor, list_threads_returns_local_rollout_summary, list_threads_selects_active_or_archived_collection, list_threads_uses_default_provider_when_rollout_omits_provider (+15 more)); 1 external calls (to_path_buf).


##### `write_session_file`  (lines 19–28)

```
fn write_session_file(root: &Path, ts: &str, uuid: Uuid) -> std::io::Result<PathBuf>
```

**Purpose**: Writes a standard active session rollout file under `sessions/2025/01/03` with the default test message and provider.

**Data flow**: Accepts a root path, timestamp string, and `Uuid`; computes the day directory under `root.join("sessions/2025/01/03")`, delegates to `write_session_file_with`, and returns the created file path.

**Call relations**: Used by many tests that need a normal active rollout fixture without customizing message/provider details.

*Call graph*: calls 1 internal fn (write_session_file_with); called by 34 (archive_thread_moves_rollout_to_archived_collection, archive_thread_updates_sqlite_metadata_when_present, delete_rollout_file_treats_vanished_path_as_already_deleted, delete_thread_removes_active_and_archived_rollouts, list_threads_returns_local_rollout_summary, list_threads_selects_active_or_archived_collection, read_thread_accepts_legacy_sandbox_policy_metadata, read_thread_applies_sqlite_thread_name, read_thread_by_rollout_path_prefers_sqlite_git_info, read_thread_falls_back_to_rollout_search_when_sqlite_path_is_stale (+15 more)); 1 external calls (join).


##### `write_archived_session_file`  (lines 30–43)

```
fn write_archived_session_file(
    root: &Path,
    ts: &str,
    uuid: Uuid,
) -> std::io::Result<PathBuf>
```

**Purpose**: Writes a standard archived session rollout file under the archived sessions subdirectory with the archived test message and default provider.

**Data flow**: Accepts a root path, timestamp string, and `Uuid`; computes the archived directory under `root.join(ARCHIVED_SESSIONS_SUBDIR)`, delegates to `write_session_file_with`, and returns the created file path.

**Call relations**: Used by tests that need archived rollout fixtures for read/list/archive/delete behavior.

*Call graph*: calls 1 internal fn (write_session_file_with); called by 11 (delete_thread_removes_active_and_archived_rollouts, list_threads_selects_active_or_archived_collection, read_thread_prefers_active_rollout_over_archived, read_thread_returns_archived_rollout_when_requested, read_thread_sqlite_fallback_loads_archived_history, load_history_uses_live_writer_rollout_path_for_archived_source, unarchive_thread_restores_rollout_and_returns_updated_thread, unarchive_thread_updates_sqlite_metadata_when_present, update_thread_metadata_keeps_archived_thread_archived_in_sqlite, update_thread_metadata_keeps_live_archived_thread_archived_in_sqlite (+1 more)); 1 external calls (join).


##### `write_session_file_with`  (lines 45–62)

```
fn write_session_file_with(
    root: &Path,
    day_dir: PathBuf,
    ts: &str,
    uuid: Uuid,
    first_user_message: &str,
    model_provider: Option<&str>,
) -> std::io::Result<PathBuf>
```

**Purpose**: Writes a session rollout file with a caller-specified first user message and optional model provider, but no fork ancestry.

**Data flow**: Accepts root path, target day directory, timestamp, UUID, first-user-message string, and optional provider; forwards all of that plus `forked_from_id: None` to `write_session_file_with_fork` and returns the resulting path.

**Call relations**: Intermediate convenience helper used by both active/archived wrappers and tests that need custom message/provider values.

*Call graph*: calls 1 internal fn (write_session_file_with_fork); called by 3 (list_threads_uses_default_provider_when_rollout_omits_provider, write_archived_session_file, write_session_file).


##### `write_session_file_with_fork`  (lines 64–107)

```
fn write_session_file_with_fork(
    root: &Path,
    day_dir: PathBuf,
    ts: &str,
    uuid: Uuid,
    first_user_message: &str,
    model_provider: Option<&str>,
    forked_from_id: Option<Uuid>,
```

**Purpose**: Creates a concrete rollout JSONL fixture containing a `session_meta` line and a user-message event, optionally including `forked_from_id`. It is the most flexible rollout writer in the test suite.

**Data flow**: Consumes the root path, target directory, timestamp, UUID, first-user-message, optional provider, and optional fork UUID. It creates the directory tree, constructs the rollout filename, opens the file, writes a JSON `session_meta` object with cwd/root, source, CLI version, provider, fork info, and git metadata, then writes a JSON `event_msg` user-message line, and returns the file path.

**Call relations**: Used directly by fork-related tests and indirectly by all other rollout-writing helpers.

*Call graph*: called by 2 (read_thread_returns_forked_from_id, write_session_file_with); 6 external calls (join, format!, create, create_dir_all, json!, writeln!).


### External agent session ledger
This focused group verifies ledger behavior for missing files, completed imports, and metadata refresh updates.

### `external-agent-sessions/src/ledger_tests.rs`

`test` · `test-time regression coverage`

This companion test file exercises edge cases that are easy to miss in the ledger implementation. The first test proves that `ImportedExternalAgentSessionLedger::contains_current_source` short-circuits when the ledger is empty, so checking a missing path does not attempt canonicalization or hashing and simply returns `false`. The second test covers the write path for completed imports when the source file no longer exists: it writes a file, canonicalizes the path, deletes the file, then records a `CompletedExternalAgentSessionImport` using a precomputed SHA-256. The assertion confirms that the ledger still stores the record and leaves `source_modified_at` as `None` rather than failing.

The final test verifies replacement semantics for duplicate imports of the same source path and content hash. Recording the same session twice with different `ThreadId`s should not create duplicate ledger entries; instead, the existing record is replaced with the newer thread ID and refreshed metadata, including a populated `source_modified_at` when the file is still present. Together these tests document an important design boundary: the ledger can be updated from already-known import results without needing to reopen or rehash the source file, except where the API explicitly computes those values itself.

#### Function details

##### `empty_ledger_does_not_read_source`  (lines 10–19)

```
fn empty_ledger_does_not_read_source()
```

**Purpose**: Verifies that checking a missing source against an empty ledger returns `false` without trying to read the file.

**Data flow**: It creates a temporary directory, constructs a nonexistent session path, calls `ImportedExternalAgentSessionLedger::default().contains_current_source(&missing_source)`, unwraps the result, and asserts the boolean is false.

**Call relations**: This test directly targets the early-return branch in `ImportedExternalAgentSessionLedger::contains_current_source`.

*Call graph*: 2 external calls (new, assert!).


##### `completed_imports_do_not_read_source_files`  (lines 22–47)

```
fn completed_imports_do_not_read_source_files()
```

**Purpose**: Checks that completed imports can be recorded even after the source file has been deleted, as long as the caller supplies the canonical path and content hash.

**Data flow**: It writes a source file, canonicalizes its path, deletes it, computes the expected SHA-256 from the original bytes, calls `record_completed_session_imports` with one `CompletedExternalAgentSessionImport`, reloads the ledger, and asserts that exactly one record exists with the expected path, thread ID, and `source_modified_at == None`.

**Call relations**: This test exercises `record_completed_session_imports` and then `load_import_ledger` to validate the ledger's no-source-read behavior for already completed imports.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, assert_eq!, canonicalize, remove_file, write, load_import_ledger, record_completed_session_imports, vec!).


##### `completed_import_refreshes_existing_record_metadata`  (lines 50–85)

```
fn completed_import_refreshes_existing_record_metadata()
```

**Purpose**: Ensures that recording the same source path and content hash twice updates the existing ledger record instead of appending a duplicate.

**Data flow**: It writes a source file, canonicalizes the path, computes its SHA-256, records one completed import with a first thread ID, records a second completed import with the same path/hash but a different thread ID, reloads the ledger, and asserts there is still one record whose thread ID is the second one and whose `source_modified_at` is populated.

**Call relations**: This test validates the replacement branch inside `record_completed_session_imports`, including metadata refresh on an existing record.

*Call graph*: calls 1 internal fn (new); 9 external calls (new, assert!, assert_eq!, format!, canonicalize, write, load_import_ledger, record_completed_session_imports, vec!).


### Rollout indexing, metadata, and recording
The rollout subsystem is tested from low-level compression and indexing through metadata/state integration, recorder behavior, and end-to-end filesystem scanning.

### `rollout/src/compression_tests.rs`

`test` · `test-time validation of rollout compression, materialization, and worker maintenance behavior`

This test module constructs realistic rollout files containing `SessionMeta` and `UserMessage` lines, then exercises the compression subsystem through public APIs such as `RolloutRecorder::load_rollout_items`, `append_rollout_item_to_path`, `search_rollout_matches`, `RolloutRecorder::new(...resume...)`, and the worker entrypoint `worker::run`. The tests verify that compressed rollouts remain readable, appending to a compressed rollout first materializes it back to plain form, and search/id lookup continue to use the logical plain path even when the physical file is compressed.

Several tests focus on worker behavior: old active and archived rollouts are compressed, fresh rollouts are skipped, stale temp files are cleaned up while fresh temp files remain, existing compressed siblings are not recompressed, and a fresh run marker suppresses another worker pass. Unix-only tests assert that both compression and append-time materialization preserve restrictive permissions and modified times, including read-only files.

The helper functions build deterministic rollout paths, write minimal valid JSONL transcripts, compress them immediately with zstd, and age files by setting old mtimes. Together these tests document the intended representation-switch semantics: plain files win over compressed siblings, temp files must not resolve as real rollouts, and materialization/install paths must be no-clobber and metadata-preserving.

#### Function details

##### `load_rollout_items_reads_compressed_rollout`  (lines 29–46)

```
async fn load_rollout_items_reads_compressed_rollout() -> anyhow::Result<()>
```

**Purpose**: Verifies that rollout loading transparently reads a compressed `.jsonl.zst` file and returns the expected items and thread id. It also confirms the plain file has been replaced by the compressed sibling.

**Data flow**: Creates a temp home, deterministic UUID/thread id, writes a rollout with `write_rollout`, compresses it with `compress_now`, then calls `RolloutRecorder::load_rollout_items(&rollout_path).await`. It asserts the loaded thread id, zero parse errors, item count of 2, absence of the plain path, and presence of the compressed path.

**Call relations**: Exercises the read path through compression-aware rollout loading, relying on helpers that create and compress a valid transcript.

*Call graph*: calls 5 internal fn (from_string, compress_now, rollout_path, write_rollout, load_rollout_items); 4 external calls (new, from_u128, assert!, assert_eq!).


##### `rollout_file_from_path_normalizes_compressed_file_names`  (lines 49–63)

```
fn rollout_file_from_path_normalizes_compressed_file_names() -> anyhow::Result<()>
```

**Purpose**: Checks that `RolloutFile::from_path` accepts a compressed filename and stores the canonical plain `.jsonl` filename alongside the physical compressed path. This validates filename normalization.

**Data flow**: Builds a compressed rollout path from a deterministic UUID and asserts that `RolloutFile::from_path(compressed_path.clone())` returns `Some(RolloutFile { path: compressed_path, plain_file_name: ...jsonl })`.

**Call relations**: Targets the normalization logic in `RolloutFile::from_path` without needing actual file contents.

*Call graph*: calls 1 internal fn (rollout_path); 3 external calls (new, from_u128, assert_eq!).


##### `rollout_file_from_path_hides_compressed_sibling_when_plain_exists`  (lines 66–78)

```
fn rollout_file_from_path_hides_compressed_sibling_when_plain_exists() -> anyhow::Result<()>
```

**Purpose**: Verifies that a compressed sibling is ignored when the plain rollout file exists. This enforces the plain-file precedence rule used by discovery code.

**Data flow**: Creates a plain rollout file with `write_rollout`, computes its compressed sibling path, and asserts `RolloutFile::from_path(compressed_rollout_path(&rollout_path)) == None`.

**Call relations**: Exercises the sibling-hiding branch in `RolloutFile::from_path` and `path::should_skip_compressed_sibling`.

*Call graph*: calls 3 internal fn (from_string, rollout_path, write_rollout); 3 external calls (new, from_u128, assert_eq!).


##### `append_rollout_item_materializes_compressed_rollout`  (lines 81–106)

```
async fn append_rollout_item_materializes_compressed_rollout() -> anyhow::Result<()>
```

**Purpose**: Ensures that appending to a compressed rollout first materializes it back to plain form, then appends successfully. It validates the append-path representation switch.

**Data flow**: Creates and compresses a rollout, calls `append_rollout_item_to_path` with a new `UserMessage` event, then asserts the plain path exists, the compressed sibling is gone, and `RolloutRecorder::load_rollout_items` returns the original thread id, zero parse errors, and three items.

**Call relations**: Exercises `materialize_rollout_for_append` indirectly through the append API and then reuses the normal load path to verify the resulting transcript.

*Call graph*: calls 5 internal fn (from_string, compress_now, rollout_path, write_rollout, load_rollout_items); 8 external calls (default, new, from_u128, assert!, assert_eq!, append_rollout_item_to_path, UserMessage, EventMsg).


##### `search_rollout_matches_uses_logical_path_for_compressed_rollout`  (lines 109–130)

```
async fn search_rollout_matches_uses_logical_path_for_compressed_rollout() -> anyhow::Result<()>
```

**Purpose**: Checks that rollout search reports matches keyed by the logical plain rollout path even when the physical file is compressed. This keeps higher-level APIs representation-agnostic.

**Data flow**: Creates and compresses a rollout containing a target phrase, runs `search_rollout_matches` against the temp home, and asserts the returned map contains the plain `rollout_path` key with the expected snippet.

**Call relations**: Exercises compression-aware path normalization in the search stack rather than direct compression APIs.

*Call graph*: calls 4 internal fn (from_string, compress_now, rollout_path, write_rollout); 5 external calls (new, from_u128, assert_eq!, search_rollout_matches, new).


##### `worker_compresses_old_active_and_archived_rollouts`  (lines 133–176)

```
async fn worker_compresses_old_active_and_archived_rollouts() -> anyhow::Result<()>
```

**Purpose**: Validates the worker's main behavior across active, archived, fresh, and temp files. It confirms old rollouts are compressed, fresh ones are skipped, stale temps are removed, fresh temps remain, and the run marker persists.

**Data flow**: Creates old active and archived rollouts, a fresh active rollout, a stale temp file, and a fresh temp file; ages the old files with `set_old_mtime`; runs `worker::run(home.path().to_path_buf()).await`; then asserts old plain files are gone and compressed siblings exist, the fresh plain file remains uncompressed, the stale temp is removed, the fresh temp remains, and `.tmp/rollout-compression.lock` exists.

**Call relations**: Drives the full worker orchestration path, including stale-temp cleanup, recursive scanning, compression eligibility, and marker persistence.

*Call graph*: calls 5 internal fn (from_string, archived_rollout_path, rollout_path, set_old_mtime, write_rollout); 5 external calls (new, from_u128, assert!, write, run).


##### `resume_materializes_compressed_rollout_path`  (lines 179–228)

```
async fn resume_materializes_compressed_rollout_path() -> anyhow::Result<()>
```

**Purpose**: Ensures that resuming from a compressed rollout path loads history correctly and materializes the rollout back to its plain path for continued recording. It validates resume-time representation switching.

**Data flow**: Creates a `RolloutConfig`, writes and compresses a rollout, loads history via `RolloutRecorder::get_rollout_history(compressed_path.as_path()).await` and asserts it returns `InitialHistory::Resumed` with the plain rollout path, then constructs `RolloutRecorder::new(... RolloutRecorderParams::resume(compressed_path.clone()))`, asserts the recorder now points at the plain path and that the compressed file is gone, records another user message, flushes and shuts down, and finally reloads items to assert thread id, zero parse errors, and three items.

**Call relations**: Exercises both history loading and recorder resume paths that depend on compression materialization.

*Call graph*: calls 8 internal fn (from_string, compress_now, rollout_path, write_rollout, get_rollout_history, load_rollout_items, new, resume); 8 external calls (default, new, from_u128, assert!, assert_eq!, panic!, UserMessage, EventMsg).


##### `compression_preserves_rollout_permissions`  (lines 232–250)

```
async fn compression_preserves_rollout_permissions() -> anyhow::Result<()>
```

**Purpose**: Checks that worker compression preserves restrictive Unix permissions from the source rollout file onto the compressed output. This protects transcript confidentiality across representation changes.

**Data flow**: On Unix, writes an archived rollout, sets permissions to `0o600`, ages it, runs `worker::run`, then asserts the plain file is gone and the compressed file's mode bits equal `0o600`.

**Call relations**: Targets the metadata-preservation path in worker compression, especially `set_file_metadata` and temp-file persistence.

*Call graph*: calls 4 internal fn (from_string, archived_rollout_path, set_old_mtime, write_rollout); 7 external calls (new, from_u128, assert!, assert_eq!, from_mode, set_permissions, run).


##### `append_materialization_preserves_compressed_rollout_permissions`  (lines 254–280)

```
async fn append_materialization_preserves_compressed_rollout_permissions() -> anyhow::Result<()>
```

**Purpose**: Verifies that append-time materialization preserves the compressed file's restrictive permissions on the newly created plain file. This mirrors the worker permission-preservation guarantee in the reverse direction.

**Data flow**: On Unix, writes and compresses a rollout, sets the compressed file's permissions to `0o600`, appends a user message via `append_rollout_item_to_path`, then asserts the plain file exists, the compressed file is gone, and the plain file's mode bits equal `0o600`.

**Call relations**: Exercises `materialize_rollout_for_append_blocking` indirectly through the append API, focusing on `create_file_with_permissions` and install semantics.

*Call graph*: calls 4 internal fn (from_string, compress_now, rollout_path, write_rollout); 10 external calls (default, new, from_u128, assert!, assert_eq!, from_mode, append_rollout_item_to_path, set_permissions, UserMessage, EventMsg).


##### `persist_temp_file_noclobber_installs_completed_temp`  (lines 283–294)

```
fn persist_temp_file_noclobber_installs_completed_temp() -> anyhow::Result<()>
```

**Purpose**: Checks that `persist_temp_file_noclobber` installs a completed temp file when the destination does not yet exist. It validates the happy path of no-clobber persistence.

**Data flow**: Creates a temp file and destination path in a temp directory, writes content to the temp file, calls `persist_temp_file_noclobber`, then asserts the temp file is gone and the destination contains the temp content.

**Call relations**: Directly tests the helper used by materialization when hard-link installation is unavailable.

*Call graph*: 4 external calls (new, assert!, assert_eq!, write).


##### `persist_temp_file_noclobber_does_not_replace_existing_destination`  (lines 297–309)

```
fn persist_temp_file_noclobber_does_not_replace_existing_destination() -> anyhow::Result<()>
```

**Purpose**: Ensures that `persist_temp_file_noclobber` does not overwrite an existing destination file. This protects the winner in races between concurrent materializers.

**Data flow**: Creates both temp and destination files with different contents, calls `persist_temp_file_noclobber`, then asserts the temp file is gone and the destination still contains its original content.

**Call relations**: Directly tests the helper's `AlreadyExists` branch, which is important for race-safe materialization.

*Call graph*: 4 external calls (new, assert!, assert_eq!, write).


##### `compression_preserves_read_only_rollout_permissions`  (lines 313–331)

```
async fn compression_preserves_read_only_rollout_permissions() -> anyhow::Result<()>
```

**Purpose**: Verifies that worker compression preserves both read-only permissions and the original modified time. This is a stricter metadata-preservation test than the writable-permissions case.

**Data flow**: On Unix, writes an archived rollout, ages it, sets permissions to `0o400`, captures the source modified time, runs `worker::run`, then asserts the plain file is gone, the compressed file has mode `0o400`, and its modified time equals the source modified time.

**Call relations**: Exercises the same metadata-preservation path as other worker tests but with a read-only source and explicit mtime verification.

*Call graph*: calls 4 internal fn (from_string, archived_rollout_path, set_old_mtime, write_rollout); 8 external calls (new, from_u128, assert!, assert_eq!, from_mode, metadata, set_permissions, run).


##### `worker_skips_existing_compressed_archived_rollouts`  (lines 334–354)

```
async fn worker_skips_existing_compressed_archived_rollouts() -> anyhow::Result<()>
```

**Purpose**: Checks that the worker does not recompress an archived rollout when the compressed sibling already exists. The compressed file should remain readable and the plain file should stay absent.

**Data flow**: Writes and compresses an archived rollout, ages the compressed file, runs `worker::run`, then asserts the plain file is absent, the compressed file still exists, and `RolloutRecorder::load_rollout_items(&rollout_path)` still returns the expected thread id, zero parse errors, and two items.

**Call relations**: Targets the `SkippedAlreadyCompressed` path in worker compression while also validating that the logical rollout remains readable.

*Call graph*: calls 6 internal fn (from_string, archived_rollout_path, compress_now, set_old_mtime, write_rollout, load_rollout_items); 5 external calls (new, from_u128, assert!, assert_eq!, run).


##### `worker_skips_when_fresh_run_marker_exists`  (lines 357–373)

```
async fn worker_skips_when_fresh_run_marker_exists() -> anyhow::Result<()>
```

**Purpose**: Ensures that a fresh run marker suppresses a worker pass. This prevents overlapping or too-frequent compression runs.

**Data flow**: Writes and ages an archived rollout, manually creates `.tmp/rollout-compression.lock`, runs `worker::run`, and asserts the plain rollout still exists and no compressed sibling was created.

**Call relations**: Exercises the `CompressionRunMarker::try_claim` freshness check through the full worker entrypoint.

*Call graph*: calls 4 internal fn (from_string, archived_rollout_path, set_old_mtime, write_rollout); 6 external calls (new, from_u128, assert!, create_dir_all, write, run).


##### `run_marker_is_removed_unless_persisted`  (lines 376–394)

```
fn run_marker_is_removed_unless_persisted() -> anyhow::Result<()>
```

**Purpose**: Verifies the lock-file lifecycle of `CompressionRunMarker`: dropped unpersisted markers remove their file, while persisted markers leave it behind and block new claims. This documents the worker's lock semantics.

**Data flow**: Creates a temp home and marker path, claims a marker inside a scope and lets it drop, asserts the marker file is gone, then claims again, persists the marker, asserts the file exists, and asserts a subsequent `try_claim` returns `None`.

**Call relations**: Directly tests `CompressionRunMarker::try_claim`, `Drop`, and `persist` without running the full worker.

*Call graph*: 4 external calls (new, assert!, panic!, try_claim).


##### `find_thread_path_by_id_handles_compressed_rollout_filenames`  (lines 397–420)

```
async fn find_thread_path_by_id_handles_compressed_rollout_filenames() -> anyhow::Result<()>
```

**Purpose**: Checks that thread-id lookup can resolve a rollout whose physical file is compressed and whose UUID appears only in the compressed filename. It also verifies invalid UUID strings return `None`.

**Data flow**: Writes and compresses a rollout, computes the compressed path, calls `crate::find_thread_path_by_id_str(home.path(), &uuid.to_string(), None).await` and asserts it returns `Some(compressed_path)`, then calls the same function with `"not-a-uuid"` and asserts `None`.

**Call relations**: Exercises the filename-based lookup path in listing/discovery code against compressed rollout names.

*Call graph*: calls 4 internal fn (from_string, compress_now, rollout_path, write_rollout); 3 external calls (new, from_u128, assert_eq!).


##### `find_thread_path_by_id_ignores_compression_temp_matches`  (lines 423–442)

```
async fn find_thread_path_by_id_ignores_compression_temp_matches() -> anyhow::Result<()>
```

**Purpose**: Ensures that compression temp filenames containing a valid UUID are not mistaken for real rollout files during thread-id lookup. This prevents transient temp artifacts from polluting discovery.

**Data flow**: Creates a temp file whose name looks like `rollout-...jsonl.zst.compress...tmp`, writes rollout contents into it, then calls `crate::find_thread_path_by_id_str` with the embedded UUID and asserts the result is `None`.

**Call relations**: Targets the filename validation and `RolloutFile::from_path` filtering used by id lookup.

*Call graph*: calls 3 internal fn (from_string, rollout_path, write_rollout); 4 external calls (new, from_u128, assert_eq!, format!).


##### `rollout_path`  (lines 444–447)

```
fn rollout_path(home: &std::path::Path, ts: &str, uuid: Uuid) -> std::path::PathBuf
```

**Purpose**: Builds a standard active-session rollout path under `sessions/YYYY/MM/DD`. It gives tests deterministic filenames that encode timestamp and UUID.

**Data flow**: Accepts a home path, timestamp string, and `Uuid`, then joins `sessions/2025/01/03` and formats `rollout-{ts}-{uuid}.jsonl`.

**Call relations**: Used throughout the test module to create active rollout paths for writing, compression, and lookup assertions.

*Call graph*: called by 10 (append_materialization_preserves_compressed_rollout_permissions, append_rollout_item_materializes_compressed_rollout, find_thread_path_by_id_handles_compressed_rollout_filenames, find_thread_path_by_id_ignores_compression_temp_matches, load_rollout_items_reads_compressed_rollout, resume_materializes_compressed_rollout_path, rollout_file_from_path_hides_compressed_sibling_when_plain_exists, rollout_file_from_path_normalizes_compressed_file_names, search_rollout_matches_uses_logical_path_for_compressed_rollout, worker_compresses_old_active_and_archived_rollouts); 2 external calls (join, format!).


##### `archived_rollout_path`  (lines 449–452)

```
fn archived_rollout_path(home: &std::path::Path, ts: &str, uuid: Uuid) -> std::path::PathBuf
```

**Purpose**: Builds a standard archived rollout path under `archived_sessions`. It mirrors `rollout_path` for archived-file tests.

**Data flow**: Accepts a home path, timestamp string, and `Uuid`, then joins `archived_sessions` and formats `rollout-{ts}-{uuid}.jsonl`.

**Call relations**: Used by tests that specifically exercise archived rollout compression and lookup behavior.

*Call graph*: called by 5 (compression_preserves_read_only_rollout_permissions, compression_preserves_rollout_permissions, worker_compresses_old_active_and_archived_rollouts, worker_skips_existing_compressed_archived_rollouts, worker_skips_when_fresh_run_marker_exists); 2 external calls (join, format!).


##### `write_rollout`  (lines 454–499)

```
fn write_rollout(path: &std::path::Path, thread_id: ThreadId, message: &str) -> anyhow::Result<()>
```

**Purpose**: Writes a minimal valid rollout transcript containing a `SessionMeta` line and one `UserMessage` line. It is the core fixture generator for compression tests.

**Data flow**: Accepts a target path, `ThreadId`, and message string. It creates parent directories, constructs a `SessionMetaLine` with fixed metadata and `SessionSource::Cli`, builds two `RolloutLine` values (session meta and user message), serializes them to JSON strings joined by newlines, writes the final JSONL text with a trailing newline, and returns `Ok(())`.

**Call relations**: Used by nearly every test in the module to create realistic rollout files before compression, materialization, search, or lookup operations.

*Call graph*: called by 13 (append_materialization_preserves_compressed_rollout_permissions, append_rollout_item_materializes_compressed_rollout, compression_preserves_read_only_rollout_permissions, compression_preserves_rollout_permissions, find_thread_path_by_id_handles_compressed_rollout_filenames, find_thread_path_by_id_ignores_compression_temp_matches, load_rollout_items_reads_compressed_rollout, resume_materializes_compressed_rollout_path, rollout_file_from_path_hides_compressed_sibling_when_plain_exists, search_rollout_matches_uses_logical_path_for_compressed_rollout (+3 more)); 8 external calls (default, parent, format!, create_dir_all, write, UserMessage, EventMsg, SessionMeta).


##### `compress_now`  (lines 501–511)

```
fn compress_now(path: &std::path::Path) -> anyhow::Result<()>
```

**Purpose**: Immediately compresses a rollout file into its `.zst` sibling for test setup. It is a simple synchronous helper that bypasses the worker.

**Data flow**: Accepts a rollout path, computes the compressed sibling path, opens the input file and output file, wraps the output in a zstd encoder at level 3, copies bytes from a buffered input reader into the encoder, finishes the encoder, removes the original plain file, and returns `Ok(())`.

**Call relations**: Used by tests that need a compressed rollout without waiting for worker eligibility or orchestration.

*Call graph*: called by 7 (append_materialization_preserves_compressed_rollout_permissions, append_rollout_item_materializes_compressed_rollout, find_thread_path_by_id_handles_compressed_rollout_filenames, load_rollout_items_reads_compressed_rollout, resume_materializes_compressed_rollout_path, search_rollout_matches_uses_logical_path_for_compressed_rollout, worker_skips_existing_compressed_archived_rollouts); 6 external calls (create, open, remove_file, new, copy, new).


##### `set_old_mtime`  (lines 513–523)

```
fn set_old_mtime(path: &std::path::Path) -> anyhow::Result<()>
```

**Purpose**: Ages a file by setting its modified time to more than eight days in the past. This makes it eligible for worker compression and stale-temp cleanup.

**Data flow**: Accepts a path, computes `old = SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60)`, builds `FileTimes::new().set_modified(old)`, opens the file for writing, applies the times with `set_times`, and returns `Ok(())`.

**Call relations**: Used by worker tests to force files and temp artifacts into the 'cold' or 'stale' categories.

*Call graph*: called by 5 (compression_preserves_read_only_rollout_permissions, compression_preserves_rollout_permissions, worker_compresses_old_active_and_archived_rollouts, worker_skips_existing_compressed_archived_rollouts, worker_skips_when_fresh_run_marker_exists); 4 external calls (from_secs, new, now, new).


### `rollout/src/metadata_tests.rs`

`test` · `test-time validation of extraction and backfill`

This test module validates the concrete behaviors implemented in `metadata.rs` by constructing small rollout files on disk and comparing extracted or backfilled metadata against expected values. The extraction tests verify that `extract_metadata_from_rollout` prefers embedded `SessionMeta` over filename-derived reconstruction, replays rollout items into the builder, sets `updated_at` from file mtime, and returns the newest `memory_mode` when multiple `SessionMeta` lines appear. A dedicated fallback test covers the no-session-meta case by creating a rollout containing only a `Compacted` item and asserting that `builder_from_items` reconstructs `ThreadId`, creation time, and default `SessionSource` from the filename.

The backfill tests initialize a real `codex_state::StateRuntime` under a temp `codex_home`, write rollout files into `sessions`, and then run `backfill_sessions`. They verify resume-after-watermark behavior by pre-marking backfill running, checkpointing the first file, waiting for the lease to expire, and asserting only later files are imported and the final state is `BackfillStatus::Complete`. Other tests prove that backfill merges rollout git data with existing SQLite rows using the “prefer existing branch/title, fill missing fields” policy, and that cwd values are normalized through `normalize_cwd_for_state_db` before persistence. Helper writers centralize creation of minimal valid rollout JSONL files with configurable timestamps, cwd, and optional `GitInfo`.

#### Function details

##### `extract_metadata_from_rollout_uses_session_meta`  (lines 27–78)

```
async fn extract_metadata_from_rollout_uses_session_meta()
```

**Purpose**: Verifies that extraction builds metadata from the embedded `SessionMetaLine`, replays the rollout item, and stamps `updated_at` from the file’s modification time. It checks the full extracted metadata object against a manually built expected value.

**Data flow**: Creates a temp rollout file containing one serialized `RolloutLine::SessionMeta`; calls `extract_metadata_from_rollout`; separately rebuilds expected metadata via `builder_from_session_meta`, `build`, and `apply_rollout_item`, then sets expected `updated_at` from `file_modified_time_utc`; asserts equality plus `memory_mode == None` and zero parse errors.

**Call relations**: This test drives the main extraction path and indirectly exercises `builder_from_session_meta`, `extract_metadata_from_rollout`, and `file_modified_time_utc` under the simplest valid rollout shape.

*Call graph*: calls 1 internal fn (from_string); 9 external calls (create, new_v4, default, assert_eq!, format!, SessionMeta, to_string, tempdir, writeln!).


##### `extract_metadata_from_rollout_returns_latest_memory_mode`  (lines 81–144)

```
async fn extract_metadata_from_rollout_returns_latest_memory_mode()
```

**Purpose**: Checks that extraction reports the most recent `memory_mode` found in the rollout rather than the first one. The test uses two `SessionMeta` lines with different memory-mode values.

**Data flow**: Writes two serialized `RolloutLine::SessionMeta` entries to a temp file, where the second line sets `memory_mode` to `"polluted"`; runs `extract_metadata_from_rollout`; asserts that `outcome.memory_mode` resolves to the later value.

**Call relations**: It targets the reverse scan inside `extract_metadata_from_rollout` that searches from the end of the item list for the newest `SessionMeta.memory_mode`.

*Call graph*: calls 1 internal fn (from_string); 8 external calls (create, new_v4, default, assert_eq!, format!, tempdir, vec!, writeln!).


##### `builder_from_items_falls_back_to_filename`  (lines 147–173)

```
fn builder_from_items_falls_back_to_filename()
```

**Purpose**: Confirms that when no `SessionMeta` item exists, metadata initialization falls back to parsing the rollout filename. The expected builder is reconstructed explicitly from the UUID and timestamp embedded in the filename.

**Data flow**: Creates a temp path named like a rollout file and an item list containing only `RolloutItem::Compacted`; calls `builder_from_items`; independently parses the timestamp string into `DateTime<Utc>` and constructs an expected `ThreadMetadataBuilder::new`; asserts the builders are equal.

**Call relations**: This test isolates the fallback branch in `builder_from_items`, proving that non-metadata rollouts remain indexable from filename structure alone.

*Call graph*: calls 2 internal fn (from_string, new); 8 external calls (from_naive_utc_and_offset, parse_from_str, new_v4, default, assert_eq!, format!, tempdir, vec!).


##### `backfill_sessions_resumes_from_watermark_and_marks_complete`  (lines 176–242)

```
async fn backfill_sessions_resumes_from_watermark_and_marks_complete()
```

**Purpose**: Verifies that backfill resumes strictly after the stored watermark and marks the backfill state complete when finished. It also checks lease expiration behavior by waiting longer than the test lease.

**Data flow**: Writes two rollout files, initializes `StateRuntime`, computes the first file’s watermark, marks backfill running and checkpoints that watermark, sleeps past `BACKFILL_LEASE_SECONDS`, runs `backfill_sessions`, then queries both thread IDs and the final backfill state to assert only the second thread was imported and completion metadata was recorded.

**Call relations**: This test exercises the lease-claim, watermark filtering, checkpointing, and completion branches of `backfill_sessions`/`backfill_sessions_with_lease`.

*Call graph*: calls 3 internal fn (from_string, write_rollout_in_sessions, init); 6 external calls (new_v4, assert!, assert_eq!, from_secs, tempdir, sleep).


##### `backfill_sessions_preserves_existing_git_branch_and_fills_missing_git_fields`  (lines 245–290)

```
async fn backfill_sessions_preserves_existing_git_branch_and_fills_missing_git_fields()
```

**Purpose**: Checks the merge policy used when backfill encounters an already-existing thread row with partial git metadata. Existing branch data should win, while missing SHA and origin URL should be filled from the rollout.

**Data flow**: Writes a rollout with full `GitInfo`, extracts its metadata, mutates that metadata to remove SHA/origin and replace branch with a SQLite-only value, upserts it into the runtime, runs `backfill_sessions`, then reloads the thread and asserts SHA/origin came from the rollout while branch stayed as the preexisting DB value.

**Call relations**: It targets the `prefer_existing_git_info` logic invoked inside `backfill_sessions_with_lease` after fetching existing metadata from the runtime.

*Call graph*: calls 4 internal fn (new, from_string, write_rollout_in_sessions, init); 3 external calls (new_v4, assert_eq!, tempdir).


##### `backfill_sessions_normalizes_cwd_before_upsert`  (lines 293–322)

```
async fn backfill_sessions_normalizes_cwd_before_upsert()
```

**Purpose**: Ensures that backfill normalizes session cwd paths before storing them in the state DB. The test uses a cwd containing `.` to prove normalization occurs.

**Data flow**: Writes a rollout whose `SessionMeta.cwd` is `codex_home.join(".")`, initializes the runtime, runs `backfill_sessions`, fetches the stored thread, and asserts the persisted `cwd` equals `normalize_cwd_for_state_db(&session_cwd)` while the rollout path remains unchanged.

**Call relations**: This test covers the explicit cwd normalization step in `backfill_sessions_with_lease` before `upsert_thread`.

*Call graph*: calls 3 internal fn (from_string, write_rollout_in_sessions_with_cwd, init); 3 external calls (new_v4, assert_eq!, tempdir).


##### `write_rollout_in_sessions`  (lines 324–339)

```
fn write_rollout_in_sessions(
    codex_home: &Path,
    filename_ts: &str,
    event_ts: &str,
    thread_uuid: Uuid,
    git: Option<GitInfo>,
) -> PathBuf
```

**Purpose**: Convenience helper that writes a minimal rollout file under the `sessions` directory using `codex_home` itself as the session cwd. It reduces duplication across backfill tests.

**Data flow**: Accepts `codex_home`, filename timestamp, event timestamp, thread UUID, and optional `GitInfo`; forwards those values plus `codex_home.to_path_buf()` as cwd to `write_rollout_in_sessions_with_cwd`; returns the created rollout path.

**Call relations**: Used by tests that do not care about custom cwd values, notably the watermark-resume and git-preservation scenarios.

*Call graph*: calls 1 internal fn (write_rollout_in_sessions_with_cwd); called by 2 (backfill_sessions_preserves_existing_git_branch_and_fills_missing_git_fields, backfill_sessions_resumes_from_watermark_and_marks_complete); 1 external calls (to_path_buf).


##### `write_rollout_in_sessions_with_cwd`  (lines 341–384)

```
fn write_rollout_in_sessions_with_cwd(
    codex_home: &Path,
    filename_ts: &str,
    event_ts: &str,
    thread_uuid: Uuid,
    cwd: PathBuf,
    git: Option<GitInfo>,
) -> PathBuf
```

**Purpose**: Creates a one-line rollout JSONL file containing a `SessionMeta` item with configurable cwd and optional git metadata. It is the shared fixture builder for metadata/backfill tests.

**Data flow**: Builds a `ThreadId` from the UUID, creates `sessions/`, constructs the rollout filename, fills a `SessionMeta` and `SessionMetaLine`, wraps them in `RolloutLine`, serializes to JSON, writes one line to disk, and returns the resulting `PathBuf`.

**Call relations**: Called directly by the cwd-normalization test and indirectly by `write_rollout_in_sessions`; it supplies the on-disk inputs consumed by extraction and backfill code.

*Call graph*: calls 1 internal fn (from_string); called by 2 (backfill_sessions_normalizes_cwd_before_upsert, write_rollout_in_sessions); 9 external calls (create, join, to_string, default, format!, SessionMeta, to_string, create_dir_all, writeln!).


### `rollout/src/session_index_tests.rs`

`test` · `test-time validation of session index lookup semantics`

This test module validates the sidecar `session_index.jsonl` logic independently of the main rollout recorder. Two helpers build fixtures: `write_index` writes a sequence of `SessionIndexEntry` values as JSONL, and `write_rollout_with_metadata` creates a minimal rollout file containing a `SessionMeta` line for a given `ThreadId`. The tests then exercise both low-level reverse scanning and higher-level name-to-rollout resolution.

Several tests pin down the core invariant that append order, not `updated_at`, defines recency. `find_thread_id_by_name_prefers_latest_entry`, `find_thread_name_by_id_prefers_latest_entry`, and `scan_index_finds_latest_match_among_mixed_entries` all write multiple entries and assert that reverse scans return the last appended matching row. `scan_index_returns_none_when_entry_missing` confirms absent names and IDs produce `None` rather than errors.

The more interesting async tests cover `find_thread_meta_by_name_str`. They show that the newest matching name entry is not enough by itself: if that thread never materialized a rollout, or its rollout file exists but is empty/partial, the lookup must continue to older matching entries until it finds a readable rollout header. Another test verifies rename semantics: once a thread has a newer entry with a different name, its older historical name must no longer count as current, so a search by the old name should resolve to another thread whose latest name still matches. Finally, `find_thread_names_by_ids_prefers_latest_entry` confirms the bulk forward scan returns the latest name per requested ID.

#### Function details

##### `write_index`  (lines 13–20)

```
fn write_index(path: &Path, lines: &[SessionIndexEntry]) -> std::io::Result<()>
```

**Purpose**: Writes a complete `session_index.jsonl` fixture from an ordered slice of `SessionIndexEntry` values. It preserves append order exactly as provided.

**Data flow**: Builds a `String`, serializes each entry to JSON, appends a newline after each, writes the final string to the target path, and returns the write result.

**Call relations**: Used by nearly every test in this module to seed the index file with controlled append histories.

*Call graph*: called by 8 (find_thread_id_by_name_prefers_latest_entry, find_thread_meta_by_name_str_ignores_historical_name_after_rename, find_thread_meta_by_name_str_skips_newest_entry_without_rollout, find_thread_meta_by_name_str_skips_partial_rollout, find_thread_name_by_id_prefers_latest_entry, find_thread_names_by_ids_prefers_latest_entry, scan_index_finds_latest_match_among_mixed_entries, scan_index_returns_none_when_entry_missing); 3 external calls (new, to_string, write).


##### `write_rollout_with_metadata`  (lines 22–51)

```
fn write_rollout_with_metadata(path: &Path, thread_id: ThreadId) -> std::io::Result<()>
```

**Purpose**: Creates a minimal rollout file containing one `SessionMeta` line for a given thread ID. It provides a readable rollout target for `find_thread_meta_by_name_str` tests.

**Data flow**: Constructs a `RolloutLine` wrapping `RolloutItem::SessionMeta(SessionMetaLine { ... })`, serializes it to JSON, appends a newline, writes it to the given path, and returns the I/O result.

**Call relations**: Used by tests that need some indexed thread IDs to resolve to valid rollout headers.

*Call graph*: called by 3 (find_thread_meta_by_name_str_ignores_historical_name_after_rename, find_thread_meta_by_name_str_skips_newest_entry_without_rollout, find_thread_meta_by_name_str_skips_partial_rollout); 4 external calls (format!, SessionMeta, to_string, write).


##### `find_thread_id_by_name_prefers_latest_entry`  (lines 54–76)

```
fn find_thread_id_by_name_prefers_latest_entry() -> std::io::Result<()>
```

**Purpose**: Verifies that reverse scanning by name returns the last appended matching entry. Two different thread IDs share the same name, and the newer one should win.

**Data flow**: Creates a temp index with two `SessionIndexEntry` rows named `same`, calls `scan_index_from_end` with a predicate on `thread_name`, and asserts the returned entry ID is the second one.

**Call relations**: Directly exercises the low-level reverse-scan helper rather than the async public API.

*Call graph*: calls 2 internal fn (new, write_index); 3 external calls (new, assert_eq!, vec!).


##### `find_thread_meta_by_name_str_skips_newest_entry_without_rollout`  (lines 79–112)

```
async fn find_thread_meta_by_name_str_skips_newest_entry_without_rollout() -> std::io::Result<()>
```

**Purpose**: Checks that a newer name entry without any materialized rollout does not shadow an older persisted session with the same name. Lookup should continue until it finds a readable rollout.

**Data flow**: Writes one valid rollout for `saved_id`, writes index entries for `saved_id` and a newer `unsaved_id` with the same name, calls `find_thread_meta_by_name_str`, and asserts the result resolves to the saved rollout path and ID.

**Call relations**: Exercises the candidate-streaming loop in `find_thread_meta_by_name_str`, especially its willingness to skip unresolved IDs.

*Call graph*: calls 3 internal fn (new, write_index, write_rollout_with_metadata); 5 external calls (new, assert_eq!, format!, create_dir_all, vec!).


##### `find_thread_meta_by_name_str_skips_partial_rollout`  (lines 115–146)

```
async fn find_thread_meta_by_name_str_skips_partial_rollout() -> std::io::Result<()>
```

**Purpose**: Ensures that a newer matching thread whose rollout file exists but is empty/partial is skipped in favor of an older thread with a readable header. This protects lookup from incomplete persisted state.

**Data flow**: Creates one valid rollout and one empty rollout file, writes index entries naming both threads identically with the partial one newer, calls `find_thread_meta_by_name_str`, and asserts the valid older rollout path is returned.

**Call relations**: Targets the branch where rollout-path resolution succeeds but `read_session_meta_line` fails, so the search must continue.

*Call graph*: calls 3 internal fn (new, write_index, write_rollout_with_metadata); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `find_thread_meta_by_name_str_ignores_historical_name_after_rename`  (lines 149–184)

```
async fn find_thread_meta_by_name_str_ignores_historical_name_after_rename() -> std::io::Result<()>
```

**Purpose**: Verifies that historical names for a renamed thread are ignored once a newer entry for that same ID records a different current name. Searching by the old name should not return the renamed thread.

**Data flow**: Creates a valid rollout for `current_id`, writes index entries where `renamed_id` first had name `same` but later changed to `different`, while `current_id` currently has `same`, calls `find_thread_meta_by_name_str("same")`, and asserts the current thread’s rollout path is returned.

**Call relations**: Exercises the `seen`-ID suppression logic in `stream_thread_ids_from_end_by_name`.

*Call graph*: calls 3 internal fn (new, write_index, write_rollout_with_metadata); 5 external calls (new, assert_eq!, format!, create_dir_all, vec!).


##### `find_thread_name_by_id_prefers_latest_entry`  (lines 187–211)

```
fn find_thread_name_by_id_prefers_latest_entry() -> std::io::Result<()>
```

**Purpose**: Checks that reverse scanning by thread ID returns the latest appended name for that ID. Older names should be ignored.

**Data flow**: Writes two index entries for the same ID with names `first` and `second`, calls `scan_index_from_end_by_id`, and asserts the returned entry’s `thread_name` is `second`.

**Call relations**: Directly validates the ID-specialized reverse lookup helper.

*Call graph*: calls 2 internal fn (new, write_index); 3 external calls (new, assert_eq!, vec!).


##### `scan_index_returns_none_when_entry_missing`  (lines 214–231)

```
fn scan_index_returns_none_when_entry_missing() -> std::io::Result<()>
```

**Purpose**: Confirms that reverse scans cleanly return `None` when no matching name or ID exists. Missing lookups should not produce false positives or errors.

**Data flow**: Writes one index entry, calls `scan_index_from_end` with a missing-name predicate and `scan_index_from_end_by_id` with a fresh ID, and asserts both results are `None`.

**Call relations**: Covers the no-match behavior of the reverse scanning helpers.

*Call graph*: calls 2 internal fn (new, write_index); 3 external calls (new, assert_eq!, vec!).


##### `find_thread_names_by_ids_prefers_latest_entry`  (lines 234–269)

```
async fn find_thread_names_by_ids_prefers_latest_entry() -> std::io::Result<()>
```

**Purpose**: Verifies that the bulk forward scan returns the latest name for each requested thread ID. Later entries should overwrite earlier ones in the result map.

**Data flow**: Writes three index entries where one ID appears twice with different names, builds a `HashSet` of the two target IDs, calls `find_thread_names_by_ids`, and asserts the returned `HashMap` contains the latest name for the repeated ID and the only name for the other.

**Call relations**: Exercises the async bulk lookup path used by rollout title filtering.

*Call graph*: calls 2 internal fn (new, write_index); 5 external calls (new, new, new, assert_eq!, vec!).


##### `scan_index_finds_latest_match_among_mixed_entries`  (lines 272–313)

```
fn scan_index_finds_latest_match_among_mixed_entries() -> std::io::Result<()>
```

**Purpose**: Tests reverse scanning across mixed IDs and names, reinforcing that append order determines the latest match. It checks both name-based and ID-based lookups in one fixture.

**Data flow**: Writes several index entries with interleaved target and non-target rows, calls `scan_index_from_end` for name `target` and `scan_index_from_end_by_id` for two IDs, and asserts each lookup returns the expected last appended matching entry.

**Call relations**: Provides broad coverage of the generic and ID-specific reverse scanners over a more realistic mixed-entry file.

*Call graph*: calls 2 internal fn (new, write_index); 3 external calls (new, assert_eq!, vec!).


### `rollout/src/state_db_tests.rs`

`test` · `test execution`

This test module targets the behavior implemented in `state_db.rs`, especially the pieces that are easy to regress because they sit between rollout files and SQLite state. The tests use `TempDir` and direct `codex_state::StateRuntime` initialization to create isolated databases, then invoke the internal helpers under realistic conditions.

`cursor_to_anchor_normalizes_timestamp_format` verifies that a parsed cursor with second precision is converted into a `codex_state::Anchor` timestamp normalized to whole seconds, matching the millisecond-based conversion logic in production. Two async tests cover startup backfill gating: one claims a backfill lease, completes it from a spawned task after a short delay, and confirms `try_init_with_roots_and_backfill_lease` waits and then succeeds; the other leaves the lease incomplete and asserts initialization times out instead of hanging forever.

The reconciliation test writes a minimal JSONL rollout containing `SessionMeta` and a user message, extracts metadata, manually overwrites the persisted title in SQLite, then calls `reconcile_rollout` and confirms the explicit title remains while `first_user_message` still reflects the rollout contents. The local helper `write_rollout_with_user_message` constructs those JSONL files with concrete protocol types (`RolloutLine`, `RolloutItem`, `SessionMetaLine`, `EventMsg::UserMessage`) so the tests exercise the same parsing paths as real rollout files.

#### Function details

##### `cursor_to_anchor_normalizes_timestamp_format`  (lines 19–31)

```
fn cursor_to_anchor_normalizes_timestamp_format()
```

**Purpose**: Verifies that `cursor_to_anchor` converts a parsed cursor timestamp into the expected normalized UTC `DateTime` without stray subsecond precision.

**Data flow**: Builds a cursor string, parses it with `parse_cursor`, passes it into `cursor_to_anchor`, independently parses the same string into a `NaiveDateTime`, converts that to `DateTime<Utc>` with zero nanoseconds, and asserts equality with the anchor's `ts` field. It writes no external state.

**Call relations**: This unit test directly exercises the timestamp-conversion helper in `state_db.rs`. It does not delegate beyond parsing and chrono conversion needed to build the expected value.

*Call graph*: calls 1 internal fn (parse_cursor); 3 external calls (from_naive_utc_and_offset, parse_from_str, assert_eq!).


##### `try_init_waits_for_concurrent_startup_backfill`  (lines 34–63)

```
async fn try_init_waits_for_concurrent_startup_backfill() -> anyhow::Result<()>
```

**Purpose**: Checks that initialization waits for another actor's in-progress startup backfill to complete instead of failing immediately.

**Data flow**: Creates a temporary home directory and initializes a `StateRuntime`, claims a backfill lease, clones the runtime, and spawns a task that sleeps briefly then marks backfill complete. It then calls `try_init_with_roots_and_backfill_lease`, awaits the spawned completion task, reads the initialized runtime's backfill state, and asserts the status is `Complete`.

**Call relations**: This test drives the lease-aware startup path through `try_init_with_roots_and_backfill_lease`, which in turn exercises `wait_for_backfill_gate`'s polling and retry logic under concurrent completion.

*Call graph*: calls 1 internal fn (init); 6 external calls (new, assert!, assert_eq!, from_millis, spawn, sleep).


##### `try_init_times_out_waiting_for_stuck_startup_backfill`  (lines 66–92)

```
async fn try_init_times_out_waiting_for_stuck_startup_backfill() -> anyhow::Result<()>
```

**Purpose**: Ensures startup initialization eventually returns an error when a claimed backfill lease never completes.

**Data flow**: Creates a temporary runtime, claims a backfill lease, then calls `try_init_with_roots_and_backfill_lease` without ever marking completion. It matches the result to extract the error, asserts success would be a panic, and checks the error string contains the timeout message.

**Call relations**: This test covers the timeout branch of `wait_for_backfill_gate` via the same lease-aware initialization helper used in the success case.

*Call graph*: calls 1 internal fn (init); 3 external calls (new, assert!, panic!).


##### `reconcile_rollout_preserves_existing_explicit_title`  (lines 95–130)

```
async fn reconcile_rollout_preserves_existing_explicit_title() -> anyhow::Result<()>
```

**Purpose**: Verifies that full-file reconciliation updates metadata from rollout contents without overwriting a title that was explicitly set in SQLite.

**Data flow**: Creates a temp home and thread id, writes a rollout file with a user message, initializes a runtime, extracts metadata from the rollout, asserts the extracted title and first user message, mutates the metadata title to `"math"`, upserts it, then calls `reconcile_rollout`. Finally it reloads the thread from SQLite and asserts the title stayed `"math"` while `first_user_message` remained `"Hey"`.

**Call relations**: This test exercises the full extraction branch of `reconcile_rollout`, specifically the logic that calls `prefer_existing_explicit_title` before upserting rebuilt metadata.

*Call graph*: calls 4 internal fn (new, extract_metadata_from_rollout, write_rollout_with_user_message, init); 2 external calls (new, assert_eq!).


##### `write_rollout_with_user_message`  (lines 132–181)

```
fn write_rollout_with_user_message(
    home: &Path,
    thread_id: ThreadId,
    message: &str,
) -> anyhow::Result<std::path::PathBuf>
```

**Purpose**: Creates a minimal rollout JSONL file containing session metadata and one user message event for use in reconciliation tests.

**Data flow**: Accepts a home path, thread id, and message text. It creates a dated `sessions/YYYY/MM/DD` directory, constructs a rollout filename embedding the timestamp and thread id, builds two `RolloutLine` values—one `RolloutItem::SessionMeta` with a populated `SessionMeta`, one `RolloutItem::EventMsg(EventMsg::UserMessage(...))`—serializes them to JSON lines, writes the file with a trailing newline, and returns the resulting `PathBuf`.

**Call relations**: This helper is called by `reconcile_rollout_preserves_existing_explicit_title` to generate realistic rollout input for metadata extraction and reconciliation.

*Call graph*: called by 1 (reconcile_rollout_preserves_existing_explicit_title); 9 external calls (default, join, to_path_buf, format!, UserMessage, EventMsg, SessionMeta, create_dir_all, write).


### `rollout/src/recorder_tests.rs`

`test` · `test-time validation of recorder, loader, and listing behavior`

This test module exercises the large orchestration surface in `recorder.rs`. It starts with helpers: `test_config` builds a minimal `RolloutConfig` rooted at a temp directory, and `write_session_file` creates simple rollout JSONL files under `sessions/YYYY/MM/DD` containing a `session_meta` line and a user event. The tests then cover several subsystems.

Writer-path tests verify deferred materialization and retry semantics. `recorder_materializes_on_flush_with_pending_items` proves that a newly created recorder does not create a file until buffered items are flushed, that session metadata is written before later items, and that `persist()` is idempotent after materialization. `persist_reports_filesystem_error_and_retries_buffered_items` blocks the `sessions` directory with a file to force a persist failure, then removes the blocker and confirms a later flush writes the originally buffered item. `writer_state_retries_write_error_before_reporting_flush_success` injects a read-only file handle into `RolloutWriterState` and confirms the reopen-and-retry path succeeds.

Loader tests pin down legacy compatibility: ghost-snapshot response items are skipped entirely, ghost snapshots inside compaction replacement history are pruned, and legacy guardian-assessment events are preserved. Listing tests compare DB-only and scan-and-repair modes, showing that filesystem scans repair stale rollout paths, drop missing ones, override stale cwd/title filter matches, and overlay richer git metadata from SQLite onto filesystem results. The final resume test confirms cwd matching prefers the latest `TurnContext.cwd` over stale cached cwd metadata.

#### Function details

##### `test_config`  (lines 29–37)

```
fn test_config(codex_home: &Path) -> RolloutConfig
```

**Purpose**: Builds a minimal `RolloutConfig` rooted at a temporary codex home for recorder/listing tests. It keeps cwd and sqlite home aligned with the temp directory and enables memories.

**Data flow**: Takes `codex_home: &Path`, clones it into `codex_home`, `sqlite_home`, and `cwd`, sets `model_provider_id` to `"test-provider"` and `generate_memories` to `true`, and returns the config struct.

**Call relations**: Used by most tests in this module as the shared configuration fixture for recorder creation and state DB initialization.

*Call graph*: called by 10 (list_threads_db_disabled_does_not_skip_paginated_items, list_threads_db_enabled_drops_missing_rollout_paths, list_threads_db_enabled_repairs_stale_rollout_paths, list_threads_default_filter_returns_filesystem_scan_results, list_threads_metadata_filter_overlays_state_db_list_metadata, list_threads_search_repairs_stale_state_db_hits_before_returning, list_threads_state_db_only_skips_jsonl_repair_scan, persist_reports_filesystem_error_and_retries_buffered_items, recorder_materializes_on_flush_with_pending_items, state_db_init_backfills_before_returning); 1 external calls (to_path_buf).


##### `write_session_file`  (lines 39–69)

```
fn write_session_file(root: &Path, ts: &str, uuid: Uuid) -> std::io::Result<PathBuf>
```

**Purpose**: Creates a simple rollout JSONL file under the dated `sessions` tree with a session-meta line and one user event. It is the common on-disk fixture for listing and resume tests.

**Data flow**: Builds `sessions/2025/01/03`, creates the directory, constructs a rollout filename from the provided timestamp and UUID, writes one JSON object representing `session_meta` and one representing a `user_message`, and returns the created path.

**Call relations**: Used by listing tests and the cwd-resume test to seed realistic filesystem rollouts.

*Call graph*: called by 6 (list_threads_db_disabled_does_not_skip_paginated_items, list_threads_db_enabled_repairs_stale_rollout_paths, list_threads_default_filter_returns_filesystem_scan_results, list_threads_metadata_filter_overlays_state_db_list_metadata, list_threads_search_repairs_stale_state_db_hits_before_returning, resume_candidate_matches_cwd_reads_latest_turn_context); 6 external calls (create, join, format!, create_dir_all, json!, writeln!).


##### `state_db_init_backfills_before_returning`  (lines 72–145)

```
async fn state_db_init_backfills_before_returning() -> anyhow::Result<()>
```

**Purpose**: Verifies that state DB initialization performs rollout backfill synchronously enough that newly written sessions are queryable before `init` returns. It also checks that backfill state is marked complete.

**Data flow**: Writes a rollout file with `SessionMeta` and a user event under a temp home, initializes the state DB via `crate::state_db::init(&test_config(...))`, fetches the thread metadata by ID, and asserts the rollout path matches and backfill status is `Complete`.

**Call relations**: This test spans `state_db::init`, metadata extraction, and backfill orchestration to prove startup gating behavior.

*Call graph*: calls 3 internal fn (from_string, test_config, init); 11 external calls (default, new, new_v4, new, assert_eq!, format!, create_dir_all, write, UserMessage, EventMsg (+1 more)).


##### `load_rollout_items_skips_legacy_ghost_snapshot_lines`  (lines 148–220)

```
async fn load_rollout_items_skips_legacy_ghost_snapshot_lines() -> std::io::Result<()>
```

**Purpose**: Checks that `RolloutRecorder::load_rollout_items` drops legacy `ghost_snapshot` response-item lines while preserving surrounding valid items. The resulting item list should contain only session metadata and the normal message.

**Data flow**: Writes a rollout file containing `session_meta`, a legacy `ghost_snapshot` response item, and a normal assistant message; loads items with `RolloutRecorder::load_rollout_items`; asserts thread ID extraction, zero parse errors, item count of two, and expected item variants.

**Call relations**: Targets the raw-JSON cleanup path through `strip_legacy_ghost_snapshot_rollout_line` inside the loader.

*Call graph*: calls 2 internal fn (new, load_rollout_items); 5 external calls (create, new, assert!, assert_eq!, writeln!).


##### `load_rollout_items_preserves_legacy_guardian_assessment_lines`  (lines 223–282)

```
async fn load_rollout_items_preserves_legacy_guardian_assessment_lines() -> std::io::Result<()>
```

**Purpose**: Ensures that legacy guardian-assessment event lines still deserialize and survive loading. This guards against over-aggressive legacy filtering.

**Data flow**: Writes a rollout file with `session_meta` and an `event_msg` payload of type `guardian_assessment`; loads items; asserts thread ID, zero parse errors, item count, and concrete guardian-assessment fields such as `id`, `turn_id`, and defaulted `started_at_ms`.

**Call relations**: Exercises the normal deserialization path in `load_rollout_items` for a legacy-but-supported event variant.

*Call graph*: calls 2 internal fn (new, load_rollout_items); 5 external calls (create, new, assert_eq!, panic!, writeln!).


##### `load_rollout_items_filters_legacy_ghost_snapshots_from_compaction_history`  (lines 285–362)

```
async fn load_rollout_items_filters_legacy_ghost_snapshots_from_compaction_history() -> std::io::Result<()>
```

**Purpose**: Verifies that ghost snapshots embedded inside a compacted item’s `replacement_history` are removed rather than causing the whole compacted line to be dropped. The remaining replacement history should keep valid items.

**Data flow**: Writes a rollout file with `session_meta` and a `compacted` payload whose replacement history contains one normal message and one ghost snapshot; loads items; asserts the compacted item remains and its replacement history length is one with the message variant preserved.

**Call relations**: Targets the in-place pruning branch of `strip_legacy_ghost_snapshot_rollout_line`.

*Call graph*: calls 2 internal fn (new, load_rollout_items); 6 external calls (create, new, assert!, assert_eq!, panic!, writeln!).


##### `recorder_materializes_on_flush_with_pending_items`  (lines 365–443)

```
async fn recorder_materializes_on_flush_with_pending_items() -> std::io::Result<()>
```

**Purpose**: Proves that a new recorder stays deferred until there are pending items and a flush occurs, then writes session metadata and buffered items in order. It also checks that repeated `persist()` calls are harmless after materialization.

**Data flow**: Creates a recorder in `Create` mode, confirms the rollout path does not exist, queues an agent-message event, flushes and asserts the file now exists, queues a user-message event, flushes again, calls `persist()` twice, reads the file text, and asserts session metadata is present, buffered-event ordering is preserved, and the second persist does not change file contents.

**Call relations**: Exercises `RolloutRecorder::new`, `record_canonical_items`, `flush`, `persist`, and `shutdown`, plus the deferred writer-state path.

*Call graph*: calls 5 internal fn (default, new, new, new, test_config); 9 external calls (default, new, new, assert!, assert_eq!, AgentMessage, UserMessage, EventMsg, read_to_string).


##### `persist_reports_filesystem_error_and_retries_buffered_items`  (lines 446–497)

```
async fn persist_reports_filesystem_error_and_retries_buffered_items() -> std::io::Result<()>
```

**Purpose**: Checks that a persist failure caused by an invalid filesystem state reports an error without losing buffered items, and that a later flush retries successfully. It validates the writer’s recovery semantics across barriers.

**Data flow**: Creates a deferred recorder, queues one agent-message item, creates a file at `sessions` to block directory creation, calls `persist()` and expects an error, removes the blocker, calls `flush()`, reads the rollout file, and asserts the originally buffered message was eventually written.

**Call relations**: Targets `RolloutWriterState::write_pending_with_recovery` and deferred materialization failure handling through the public recorder API.

*Call graph*: calls 5 internal fn (default, new, new, new, test_config); 9 external calls (create, new, new, assert!, assert_ne!, remove_file, AgentMessage, EventMsg, read_to_string).


##### `writer_state_retries_write_error_before_reporting_flush_success`  (lines 500–527)

```
async fn writer_state_retries_write_error_before_reporting_flush_success() -> std::io::Result<()>
```

**Purpose**: Directly verifies that `RolloutWriterState::flush` retries after a write error by reopening the file and then succeeds. It bypasses the recorder task to isolate state-level recovery logic.

**Data flow**: Creates a real file, opens it read-only, constructs `RolloutWriterState` with that unusable writer, queues one agent-message item, calls `flush()`, then reads the file and asserts the queued message appears after the retry path reopened the file correctly.

**Call relations**: Exercises `RolloutWriterState::new`, `add_items`, and `flush` without involving channels or the spawned task.

*Call graph*: calls 1 internal fn (new); 7 external calls (create, new, assert!, new, read_to_string, from_std, vec!).


##### `list_threads_db_disabled_does_not_skip_paginated_items`  (lines 530–574)

```
async fn list_threads_db_disabled_does_not_skip_paginated_items() -> std::io::Result<()>
```

**Purpose**: Ensures pure-filesystem listing paginates correctly when the state DB is unavailable. The second page should return the next rollout rather than skipping over it.

**Data flow**: Writes three session files with descending timestamps, calls `RolloutRecorder::list_threads` with `state_db_ctx: None`, `page_size: 1`, and descending created-at sort to fetch page 1 and its cursor, then fetches page 2 with that cursor and asserts the expected middle path is returned.

**Call relations**: Targets the filesystem fallback path in `list_threads_with_db_fallback`, especially `page_from_filesystem_scan` and cursor handling.

*Call graph*: calls 3 internal fn (list_threads, test_config, write_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `list_threads_db_enabled_drops_missing_rollout_paths`  (lines 577–639)

```
async fn list_threads_db_enabled_drops_missing_rollout_paths() -> std::io::Result<()>
```

**Purpose**: Checks that scan-and-repair listing removes stale SQLite rows whose rollout paths no longer exist on disk. The stale row should disappear from results and from the DB’s rollout-path lookup.

**Data flow**: Initializes a runtime, marks backfill complete, inserts thread metadata pointing at a nonexistent rollout path, calls `RolloutRecorder::list_threads`, asserts the returned page is empty, then queries `find_rollout_path_by_id` and asserts the stale path was cleared.

**Call relations**: Exercises the DB-repair behavior in `list_threads_with_db_fallback` when filesystem scans find no corresponding rollout.

*Call graph*: calls 5 internal fn (from_string, list_threads, test_config, new, init); 4 external calls (new, from_u128, assert_eq!, format!).


##### `list_threads_db_enabled_repairs_stale_rollout_paths`  (lines 642–707)

```
async fn list_threads_db_enabled_repairs_stale_rollout_paths() -> std::io::Result<()>
```

**Purpose**: Verifies that scan-and-repair listing updates a stale SQLite rollout path to the real on-disk path when the thread ID matches an existing rollout. The repaired path should be returned and persisted.

**Data flow**: Writes a real rollout file, inserts DB metadata for the same thread ID but with a stale path, runs `RolloutRecorder::list_threads`, asserts the page contains the real path, then checks `find_rollout_path_by_id` to confirm the DB row was repaired.

**Call relations**: Targets the lightweight path-repair branch in `list_threads_with_db_fallback`.

*Call graph*: calls 6 internal fn (from_string, list_threads, test_config, write_session_file, new, init); 4 external calls (new, from_u128, assert_eq!, format!).


##### `list_threads_state_db_only_skips_jsonl_repair_scan`  (lines 710–805)

```
async fn list_threads_state_db_only_skips_jsonl_repair_scan() -> std::io::Result<()>
```

**Purpose**: Shows the difference between DB-only listing and scan-and-repair listing: DB-only initially misses a rollout absent from SQLite, while the scan path repairs/imports it so later DB-only queries can see it. This proves the repair scan is not implicit in the DB-only API.

**Data flow**: Initializes an empty runtime, writes a rollout file directly to disk, queries `list_threads_from_state_db` with a cwd filter and gets zero items, queries `list_threads` and gets one repaired item, then queries `list_threads_from_state_db` again and now gets one item.

**Call relations**: Exercises both public listing entry points and the reconciliation side effects of the scan-and-repair path.

*Call graph*: calls 4 internal fn (list_threads, list_threads_from_state_db, test_config, init); 8 external calls (create, new, from_u128, assert_eq!, format!, create_dir_all, json!, writeln!).


##### `list_threads_default_filter_returns_filesystem_scan_results`  (lines 808–896)

```
async fn list_threads_default_filter_returns_filesystem_scan_results() -> std::io::Result<()>
```

**Purpose**: Verifies that when metadata filters are applied, the scan-and-repair listing returns filesystem-validated results rather than stale SQLite matches. A stale cwd filter match in SQLite should be excluded after scanning the rollout file.

**Data flow**: Writes a real rollout file, inserts DB metadata for the same thread with a stale cwd, queries `list_threads_from_state_db` with that cwd filter and sees one stale match, queries `list_threads` with the same filter and sees zero items, then re-queries DB-only and confirms the stale row has been repaired away.

**Call relations**: Targets the metadata-filter branch in `list_threads_with_db_fallback` where filesystem results are authoritative and DB-only hits may be reconciled.

*Call graph*: calls 7 internal fn (from_string, list_threads, list_threads_from_state_db, test_config, write_session_file, new, init); 3 external calls (new, from_u128, assert_eq!).


##### `list_threads_metadata_filter_overlays_state_db_list_metadata`  (lines 899–963)

```
async fn list_threads_metadata_filter_overlays_state_db_list_metadata() -> std::io::Result<()>
```

**Purpose**: Checks that metadata-filtered filesystem results are enriched with richer state-DB metadata, especially git fields. The returned `ThreadItem` should keep the filesystem path but expose SQLite git values.

**Data flow**: Writes a rollout file, inserts matching DB metadata with git branch/SHA/origin values, calls `RolloutRecorder::list_threads` with a source filter, and asserts the returned item contains the expected git metadata from SQLite.

**Call relations**: Exercises `fill_missing_thread_item_metadata_from_state_db` and `fill_missing_thread_item_metadata` through the metadata-filter listing path.

*Call graph*: calls 6 internal fn (from_string, list_threads, test_config, write_session_file, new, init); 3 external calls (new, from_u128, assert_eq!).


##### `fill_missing_thread_item_metadata_preserves_identity_and_prefers_state_git_fields`  (lines 966–1031)

```
fn fill_missing_thread_item_metadata_preserves_identity_and_prefers_state_git_fields()
```

**Purpose**: Unit-tests the field-level merge helper used to overlay state metadata onto filesystem items. It proves path/thread identity stay filesystem-derived while git fields prefer state values.

**Data flow**: Constructs one filesystem `ThreadItem` and one state-style `ThreadItem` with differing path, thread ID, and metadata; calls `fill_missing_thread_item_metadata(&mut item, state_item)`; asserts path and thread ID remain unchanged, existing message/preview remain, missing fields are filled, and git fields are overwritten by state values.

**Call relations**: Directly targets the merge semantics used by listing fallback enrichment.

*Call graph*: calls 1 internal fn (new); 2 external calls (from, assert_eq!).


##### `list_threads_search_repairs_stale_state_db_hits_before_returning`  (lines 1034–1121)

```
async fn list_threads_search_repairs_stale_state_db_hits_before_returning() -> std::io::Result<()>
```

**Purpose**: Verifies that title-search listing reconciles stale SQLite hits before returning results. A stale DB title match should disappear after the scan-and-repair path runs.

**Data flow**: Writes a rollout file, inserts DB metadata whose title/preview contains `needle` even though the rollout does not, queries `list_threads_from_state_db` with search term `needle` and sees one stale hit, queries `list_threads` with the same search and sees zero items, then re-queries DB-only and confirms the stale hit is gone.

**Call relations**: Targets the search-specific reconciliation branch in `list_threads_with_db_fallback`, where full `reconcile_rollout` is used instead of lightweight path repair.

*Call graph*: calls 7 internal fn (from_string, list_threads, list_threads_from_state_db, test_config, write_session_file, new, init); 3 external calls (new, from_u128, assert_eq!).


##### `resume_candidate_matches_cwd_reads_latest_turn_context`  (lines 1124–1168)

```
async fn resume_candidate_matches_cwd_reads_latest_turn_context() -> std::io::Result<()>
```

**Purpose**: Checks that cwd-based resume matching prefers the latest `TurnContext.cwd` from the rollout over stale cached cwd metadata. This allows resumed sessions to follow cwd changes recorded during the conversation.

**Data flow**: Creates a rollout file with stale session cwd metadata, appends a serialized `RolloutLine::TurnContext` whose cwd is a different directory, calls `resume_candidate_matches_cwd` with the stale cached cwd and the latest cwd as target, and asserts the function returns true.

**Call relations**: Exercises the middle branch of `resume_candidate_matches_cwd`, where it loads rollout items and scans backward for the newest `TurnContext` before falling back to full metadata extraction.

*Call graph*: calls 1 internal fn (write_session_file); 8 external calls (new, from_u128, new_read_only_policy, assert!, create_dir_all, TurnContext, new, writeln!).


### `rollout/src/tests.rs`

`test` · `test execution`

This large test module validates the rollout subsystem from the perspective of callers that list threads, read summaries, and resolve rollout paths. It mixes pure filesystem scenarios with DB-assisted ones to ensure the fallback logic behaves consistently.

Several helpers generate deterministic test data. `provider_vec` and `thread_id_from_uuid` normalize common inputs. `write_session_file`, `write_session_file_with_provider`, `write_goal_started_session_file`, `write_session_file_with_delayed_user_event`, and `write_session_file_with_meta_payload` create JSONL rollout files under `sessions/YYYY/MM/DD`, populate `SessionMeta` and event records, and set file mtimes so sorting code can be tested. `insert_state_db_thread` seeds a `codex_state::StateRuntime` with thread metadata, including archived state and preview fields, while `assert_state_db_rollout_path` reopens the DB to verify repairs persisted.

The tests cover stale or incorrect DB rollout paths being repaired after filesystem fallback, acceptance of non-canonical but existing DB paths, extraction of date components from rollout filenames, latest-first ordering, cursor pagination semantics, scanning past many metadata lines to find the first user event, using thread-goal objectives as previews, preserving later user messages, preserving or defaulting `base_instructions`, and using file mtime as `updated_at` for both created-at and updated-at sorts. They also document a known filesystem-only limitation: timestamp-only cursors cannot disambiguate multiple files created in the same second, unlike the SQLite path. Source filtering and model-provider filtering are tested explicitly, including the rule that sessions with no provider are included when the requested provider matches the default provider argument.

#### Function details

##### `provider_vec`  (lines 48–53)

```
fn provider_vec(providers: &[&str]) -> Vec<String>
```

**Purpose**: Converts a slice of provider string slices into owned `Vec<String>` values for test filter arguments.

**Data flow**: Reads `&[&str]`, maps each element through `ToString::to_string`, collects into `Vec<String>`, and returns it. It has no side effects.

**Call relations**: Many listing tests call this helper before invoking `get_threads` so they can pass owned provider filters in the same shape production code expects.

*Call graph*: called by 13 (test_base_instructions_missing_in_meta_defaults_to_null, test_base_instructions_present_in_meta_is_preserved, test_created_at_sort_uses_file_mtime_for_updated_at, test_get_thread_contents, test_goal_first_thread_reads_later_user_message, test_list_conversations_latest_first, test_list_threads_scans_past_head_for_user_event, test_list_threads_uses_goal_objective_as_preview, test_model_provider_filter_selects_only_matching_sessions, test_pagination_cursor (+3 more)).


##### `thread_id_from_uuid`  (lines 55–57)

```
fn thread_id_from_uuid(uuid: Uuid) -> ThreadId
```

**Purpose**: Builds a `ThreadId` from a `Uuid` using the same string parsing path as production code.

**Data flow**: Takes a `Uuid`, converts it to a string, parses it with `ThreadId::from_string`, and returns the resulting `ThreadId`, panicking if parsing fails.

**Call relations**: This helper is used when tests need a protocol-level thread id, notably while constructing goal-update events in synthetic rollout files.

*Call graph*: calls 1 internal fn (from_string); called by 1 (write_goal_started_session_file); 1 external calls (to_string).


##### `insert_state_db_thread`  (lines 59–95)

```
async fn insert_state_db_thread(
    home: &Path,
    thread_id: ThreadId,
    rollout_path: &Path,
    archived: bool,
) -> crate::state_db::StateDbHandle
```

**Purpose**: Seeds a temporary SQLite state DB with one thread metadata row pointing at a chosen rollout path.

**Data flow**: Accepts a home path, thread id, rollout path, and archived flag. It initializes a `StateRuntime`, marks backfill complete, constructs a fixed `created_at` timestamp, builds a `ThreadMetadataBuilder` with source `SessionSource::Cli`, fills in provider and cwd, optionally sets `archived_at`, builds metadata, sets `first_user_message` and `preview`, upserts the thread, and returns the runtime handle.

**Call relations**: DB fallback tests call this helper to create stale, wrong, or custom-path metadata before invoking higher-level path lookup logic.

*Call graph*: calls 2 internal fn (new, init); called by 3 (find_thread_path_accepts_existing_state_db_path_without_canonical_filename, find_thread_path_falls_back_when_db_path_is_stale, find_thread_path_falls_back_when_db_path_points_to_another_thread); 1 external calls (to_path_buf).


##### `find_thread_path_falls_back_when_db_path_is_stale`  (lines 98–130)

```
async fn find_thread_path_falls_back_when_db_path_is_stale()
```

**Purpose**: Tests that thread-path lookup ignores a nonexistent DB rollout path, finds the real file on disk, and repairs SQLite to point at it.

**Data flow**: Creates a temp home, deterministic UUID/thread id, writes a real rollout file, constructs a stale future-dated DB path, inserts that stale path into SQLite with `insert_state_db_thread`, calls `find_thread_path_by_id_str`, asserts the returned path is the filesystem path, and then verifies the DB row was repaired with `assert_state_db_rollout_path`.

**Call relations**: This test exercises the DB-first then filesystem-fallback path lookup flow, including the read-repair behavior after a stale path is detected.

*Call graph*: calls 4 internal fn (from_string, assert_state_db_rollout_path, insert_state_db_thread, write_session_file); 5 external calls (new, from_u128, assert_eq!, find_thread_path_by_id_str, format!).


##### `find_thread_path_falls_back_when_db_path_points_to_another_thread`  (lines 133–175)

```
async fn find_thread_path_falls_back_when_db_path_points_to_another_thread()
```

**Purpose**: Tests that lookup rejects a DB path that exists but belongs to a different thread and repairs the DB using filesystem discovery.

**Data flow**: Creates two rollout files for different UUIDs, inserts metadata for the first thread that incorrectly points at the second thread's file, calls `find_thread_path_by_id_str` for the first thread, asserts the correct filesystem path is returned, and confirms SQLite now stores that repaired path.

**Call relations**: This covers a stricter fallback case than a missing file: the DB path exists but is semantically wrong. It validates that higher-level lookup does not trust the DB blindly.

*Call graph*: calls 4 internal fn (from_string, assert_state_db_rollout_path, insert_state_db_thread, write_session_file); 5 external calls (new, from_u128, assert_eq!, find_thread_path_by_id_str, format!).


##### `find_thread_path_repairs_missing_db_row_after_filesystem_fallback`  (lines 178–208)

```
async fn find_thread_path_repairs_missing_db_row_after_filesystem_fallback()
```

**Purpose**: Ensures filesystem fallback can repopulate SQLite when the DB exists but contains no metadata row for the requested thread.

**Data flow**: Creates a rollout file and an otherwise empty initialized runtime with backfill marked complete, calls `find_thread_path_by_id_str`, asserts the filesystem path is found, and then checks that the DB now contains the repaired rollout path for the thread.

**Call relations**: This test drives the slow-path repair behavior where lookup starts with a valid DB handle but no matching row, forcing metadata reconstruction from the rollout file.

*Call graph*: calls 4 internal fn (from_string, assert_state_db_rollout_path, write_session_file, init); 5 external calls (new, from_u128, assert_eq!, find_thread_path_by_id_str, format!).


##### `find_thread_path_accepts_existing_state_db_path_without_canonical_filename`  (lines 211–231)

```
async fn find_thread_path_accepts_existing_state_db_path_without_canonical_filename()
```

**Purpose**: Verifies that an existing rollout path stored in SQLite is accepted even if its filename does not follow the canonical `rollout-...` naming pattern.

**Data flow**: Creates a temp home, thread id, and a custom-named JSONL file under the sessions tree, inserts that exact path into SQLite, calls `find_thread_path_by_id_str`, and asserts the returned path matches the custom DB path.

**Call relations**: This test documents that path lookup trusts an existing DB path when it points to a real file, rather than forcing canonical filename reconstruction.

*Call graph*: calls 2 internal fn (from_string, insert_state_db_thread); 6 external calls (new, from_u128, assert_eq!, find_thread_path_by_id_str, create_dir_all, write).


##### `rollout_date_parts_extracts_directory_components`  (lines 234–241)

```
fn rollout_date_parts_extracts_directory_components()
```

**Purpose**: Checks that the filename parser extracts year, month, and day components from a canonical rollout filename.

**Data flow**: Builds an `OsStr` filename, passes it to `rollout_date_parts`, and asserts the returned tuple of strings matches the expected directory components.

**Call relations**: This is a focused unit test for the filename parsing helper used by rollout path logic.

*Call graph*: 3 external calls (new, assert_eq!, rollout_date_parts).


##### `assert_state_db_rollout_path`  (lines 243–256)

```
async fn assert_state_db_rollout_path(
    home: &Path,
    thread_id: ThreadId,
    expected_path: Option<&Path>,
)
```

**Purpose**: Reopens the SQLite state DB and asserts that a thread's stored rollout path matches an expected value.

**Data flow**: Accepts a home path, thread id, and optional expected path. It initializes a fresh `StateRuntime` for that home, queries `find_rollout_path_by_id(thread_id, Some(false))`, and asserts the returned optional path equals `expected_path`.

**Call relations**: The DB repair tests call this helper after higher-level lookup to verify that read-repair persisted the corrected path.

*Call graph*: calls 1 internal fn (init); called by 3 (find_thread_path_falls_back_when_db_path_is_stale, find_thread_path_falls_back_when_db_path_points_to_another_thread, find_thread_path_repairs_missing_db_row_after_filesystem_fallback); 2 external calls (to_path_buf, assert_eq!).


##### `write_session_file`  (lines 258–273)

```
fn write_session_file(
    root: &Path,
    ts_str: &str,
    uuid: Uuid,
    num_records: usize,
    source: Option<SessionSource>,
) -> std::io::Result<(OffsetDateTime, Uuid)>
```

**Purpose**: Convenience wrapper that writes a synthetic rollout file using the default test provider.

**Data flow**: Accepts root path, timestamp string, UUID, record count, and optional source, then forwards those values plus `Some("test-provider")` into `write_session_file_with_provider`. It returns that helper's `(OffsetDateTime, Uuid)` result.

**Call relations**: Most filesystem-based tests use this wrapper instead of the more configurable provider-aware helper.

*Call graph*: calls 1 internal fn (write_session_file_with_provider); called by 9 (find_thread_path_falls_back_when_db_path_is_stale, find_thread_path_falls_back_when_db_path_points_to_another_thread, find_thread_path_repairs_missing_db_row_after_filesystem_fallback, test_created_at_sort_uses_file_mtime_for_updated_at, test_get_thread_contents, test_list_conversations_latest_first, test_pagination_cursor, test_source_filter_excludes_non_matching_sessions, test_timestamp_only_cursor_skips_same_second_filesystem_ties).


##### `write_session_file_with_provider`  (lines 275–344)

```
fn write_session_file_with_provider(
    root: &Path,
    ts_str: &str,
    uuid: Uuid,
    num_records: usize,
    source: Option<SessionSource>,
    model_provider: Option<&str>,
) -> std::io::Resul
```

**Purpose**: Creates a canonical rollout JSONL file with session metadata, a user message, optional provider/source fields, arbitrary extra response records, and a controlled file mtime.

**Data flow**: Parses the timestamp string into a UTC `PrimitiveDateTime`, creates the dated sessions directory, opens the rollout file, builds a JSON session-meta payload with id, timestamp, cwd, originator, cli version, optional source, and optional model provider, writes that line, writes a user-message event line, writes `num_records` synthetic response records, sets the file's modified time to the parsed timestamp, and returns the parsed datetime plus UUID.

**Call relations**: This helper underpins many listing and filtering tests by generating realistic rollout files in the exact directory layout the scanner expects.

*Call graph*: called by 2 (test_model_provider_filter_selects_only_matching_sessions, write_session_file); 11 external calls (create, new, join, parse, format!, format_description!, create_dir_all, String, json!, to_value (+1 more)).


##### `write_goal_started_session_file`  (lines 346–423)

```
fn write_goal_started_session_file(
    root: &Path,
    ts_str: &str,
    uuid: Uuid,
    objective: &str,
    later_user_message: Option<&str>,
) -> std::io::Result<()>
```

**Purpose**: Creates a rollout file whose first meaningful event is a thread-goal update, optionally followed by a later user message.

**Data flow**: Parses the timestamp, creates the dated directory and file, writes a `session_meta` JSON object with source `vscode` and provider `test-provider`, constructs a `ThreadGoalUpdatedEvent` using `thread_id_from_uuid`, writes it as an `event_msg`, optionally writes a later user-message event, sets file mtime, and returns `std::io::Result<()>`.

**Call relations**: Preview-related tests call this helper to verify that listing logic can derive preview text from goal events and still capture a later first user message.

*Call graph*: calls 1 internal fn (thread_id_from_uuid); called by 2 (test_goal_first_thread_reads_later_user_message, test_list_threads_uses_goal_objective_as_preview); 10 external calls (create, new, join, parse, format!, format_description!, create_dir_all, ThreadGoalUpdated, json!, writeln!).


##### `write_session_file_with_delayed_user_event`  (lines 425–480)

```
fn write_session_file_with_delayed_user_event(
    root: &Path,
    ts_str: &str,
    uuid: Uuid,
    meta_lines_before_user: usize,
) -> std::io::Result<()>
```

**Purpose**: Creates a rollout file where many metadata-like lines appear before the first user message, to test scanner depth behavior.

**Data flow**: Parses the timestamp, creates the dated directory and file, writes `meta_lines_before_user` `session_meta` records—using the target UUID for the first and synthetic UUIDs for later ones—then writes a user-message event and sets file mtime.

**Call relations**: The delayed-user-event listing test uses this helper to ensure summary extraction scans beyond the initial head when necessary.

*Call graph*: called by 1 (test_list_threads_scans_past_head_for_user_event); 10 external calls (create, new, join, parse, from_u128, format!, format_description!, create_dir_all, json!, writeln!).


##### `write_session_file_with_meta_payload`  (lines 482–522)

```
fn write_session_file_with_meta_payload(
    root: &Path,
    ts_str: &str,
    uuid: Uuid,
    payload: serde_json::Value,
) -> std::io::Result<()>
```

**Purpose**: Writes a rollout file using an arbitrary caller-supplied session-meta payload plus a standard user message.

**Data flow**: Parses the timestamp, creates the dated directory and file, wraps the provided JSON payload in a `session_meta` line, writes it, writes a standard user-message event line, sets file mtime, and returns `std::io::Result<()>`.

**Call relations**: The base-instructions tests use this helper to control exactly which metadata fields are present or omitted in the session meta payload.

*Call graph*: called by 2 (test_base_instructions_missing_in_meta_defaults_to_null, test_base_instructions_present_in_meta_is_preserved); 9 external calls (create, new, join, parse, format!, format_description!, create_dir_all, json!, writeln!).


##### `test_list_conversations_latest_first`  (lines 525–660)

```
async fn test_list_conversations_latest_first()
```

**Purpose**: Verifies that filesystem thread listing returns sessions in descending created-at order with the expected metadata fields populated.

**Data flow**: Creates three rollout files on consecutive days, builds a provider filter, calls `get_threads` with `ThreadSortKey::CreatedAt`, constructs expected `ThreadItem` paths and metadata, reuses the runtime-produced `updated_at` values for comparison, and asserts the full `ThreadsPage` matches.

**Call relations**: This is a broad integration test for the filesystem listing path, covering ordering, metadata extraction, and page accounting.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 5 external calls (new, from_u128, assert_eq!, format!, vec!).


##### `test_pagination_cursor`  (lines 663–905)

```
async fn test_pagination_cursor()
```

**Purpose**: Checks cursor-based pagination across multiple pages, including next-cursor values and scanned-file counts.

**Data flow**: Creates five rollout files ordered by day, lists page 1 with size 2, asserts the returned items and cursor, then lists page 2 using `page1.next_cursor` and page 3 using `page2.next_cursor`, constructing expected `ThreadsPage` values for each and comparing them.

**Call relations**: This test exercises the listing layer's cursor semantics end to end, including the scanner's peek-ahead behavior reflected in `num_scanned_files`.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 6 external calls (new, from_u128, assert_eq!, format!, from_str, vec!).


##### `test_list_threads_scans_past_head_for_user_event`  (lines 908–933)

```
async fn test_list_threads_scans_past_head_for_user_event()
```

**Purpose**: Ensures listing logic scans beyond an initial block of metadata lines to find the first user message needed for thread inclusion and summary fields.

**Data flow**: Creates a rollout file with 12 metadata lines before the first user event, builds a provider filter, calls `get_threads`, and asserts exactly one item is returned with the expected thread id.

**Call relations**: This test targets the summary-reading behavior used during filesystem listing when the first user event is not near the top of the file.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file_with_delayed_user_event); 3 external calls (new, from_u128, assert_eq!).


##### `test_list_threads_uses_goal_objective_as_preview`  (lines 936–970)

```
async fn test_list_threads_uses_goal_objective_as_preview()
```

**Purpose**: Verifies that when a thread starts with a goal-update event and no user message, the goal objective becomes the preview text.

**Data flow**: Writes a goal-started rollout file without a later user message, lists threads with `get_threads`, asserts one item is returned, and checks that `preview` equals the goal objective while `first_user_message` is `None`.

**Call relations**: This test covers a nonstandard preview derivation path in the listing logic, using the helper that emits `ThreadGoalUpdatedEvent` records.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_goal_started_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `test_goal_first_thread_reads_later_user_message`  (lines 973–1010)

```
async fn test_goal_first_thread_reads_later_user_message()
```

**Purpose**: Checks that a goal-first thread still records a later user message as `first_user_message` while keeping the goal objective as preview.

**Data flow**: Writes a goal-started rollout file with an additional later user message, lists threads, and asserts the returned item has the expected thread id, preview from the goal objective, and `first_user_message` from the later event.

**Call relations**: This complements the previous preview test by validating that the scanner tracks both preview and first-user-message independently.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_goal_started_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `test_get_thread_contents`  (lines 1013–1101)

```
async fn test_get_thread_contents()
```

**Purpose**: Validates both the listed metadata for a single thread and the exact on-disk JSONL contents written by the test helper.

**Data flow**: Creates one rollout file, lists it with `get_threads`, reads the file contents with `tokio::fs::read_to_string`, constructs an expected single-item `ThreadsPage`, constructs the exact expected JSONL string for the file, and asserts both page equality and content equality.

**Call relations**: This test ties together file generation and listing behavior, ensuring the helpers produce the exact shape the scanner expects.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 7 external calls (new, new_v4, assert_eq!, format!, json!, read_to_string, vec!).


##### `test_base_instructions_missing_in_meta_defaults_to_null`  (lines 1104–1143)

```
async fn test_base_instructions_missing_in_meta_defaults_to_null()
```

**Purpose**: Ensures summary-reading logic treats a missing `base_instructions` field in session metadata as explicit JSON null.

**Data flow**: Writes a rollout file whose meta payload omits `base_instructions`, lists threads to obtain the path, reads the head with `read_head_for_summary`, extracts the first JSON object, and asserts `base_instructions` is present as `serde_json::Value::Null`.

**Call relations**: This test targets metadata normalization in the summary-reading path rather than listing order or filtering.

*Call graph*: calls 4 internal fn (get_threads, read_head_for_summary, provider_vec, write_session_file_with_meta_payload); 4 external calls (new, from_u128, assert_eq!, json!).


##### `test_base_instructions_present_in_meta_is_preserved`  (lines 1146–1188)

```
async fn test_base_instructions_present_in_meta_is_preserved()
```

**Purpose**: Checks that when `base_instructions` is present in session metadata, summary-reading preserves its nested content.

**Data flow**: Writes a rollout file with a `base_instructions` object containing text, lists threads, reads the head summary, drills into `base_instructions.text`, and asserts the extracted string matches the original.

**Call relations**: This complements the missing-field test by covering the preservation branch of the same summary normalization logic.

*Call graph*: calls 4 internal fn (get_threads, read_head_for_summary, provider_vec, write_session_file_with_meta_payload); 4 external calls (new, from_u128, assert_eq!, json!).


##### `test_created_at_sort_uses_file_mtime_for_updated_at`  (lines 1191–1242)

```
async fn test_created_at_sort_uses_file_mtime_for_updated_at() -> Result<()>
```

**Purpose**: Verifies that even when sorting by created-at, the listed `updated_at` field comes from the file's modification time.

**Data flow**: Creates a rollout file, parses its created timestamp, computes a later `updated` time, rewrites the file mtime using `FileTimes`, lists threads sorted by `CreatedAt`, and asserts the returned item's `created_at` matches the filename timestamp while `updated_at` matches the RFC3339-formatted mtime.

**Call relations**: This test documents the separation between ordering key and displayed `updated_at` value in filesystem listings.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 9 external calls (hours, new, parse, new, from_u128, assert_eq!, format!, format_description!, new).


##### `test_updated_at_uses_file_mtime`  (lines 1245–1340)

```
async fn test_updated_at_uses_file_mtime() -> Result<()>
```

**Purpose**: Checks that updated-at sorting and metadata extraction use the file modification time rather than timestamps embedded in rollout records.

**Data flow**: Manually creates a rollout file with session meta, a user message, and many response items, then lists threads sorted by `UpdatedAt`. It parses the returned `updated_at` as RFC3339, converts it to UTC, compares it to `Utc::now()`, and asserts the age is within 30 seconds, reflecting the file's recent mtime.

**Call relations**: This test exercises the updated-at sort path with a hand-built rollout file to ensure mtime, not record timestamps, drives the reported update time.

*Call graph*: calls 3 internal fn (from_string, get_threads, provider_vec); 16 external calls (default, create, new, from_u128, new, assert!, assert_eq!, now, format!, create_dir_all (+6 more)).


##### `test_timestamp_only_cursor_skips_same_second_filesystem_ties`  (lines 1343–1472)

```
async fn test_timestamp_only_cursor_skips_same_second_filesystem_ties()
```

**Purpose**: Documents the filesystem fallback limitation where a cursor with only second precision cannot paginate through multiple files sharing the same timestamp second.

**Data flow**: Creates three rollout files with identical timestamp strings, lists the first page of size 2 and asserts it contains the lexically later two files plus a cursor equal to that timestamp, then requests page 2 with that cursor and asserts it is empty with no next cursor.

**Call relations**: This test captures a known behavior of the filesystem-only listing path and contrasts it in comments with the SQLite-backed path, which uses unique millisecond timestamps.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 7 external calls (new, from_u128, new, assert_eq!, format!, from_str, vec!).


##### `test_source_filter_excludes_non_matching_sessions`  (lines 1475–1547)

```
async fn test_source_filter_excludes_non_matching_sessions()
```

**Purpose**: Verifies that source filtering includes only matching interactive sessions while an empty source filter returns all sessions.

**Data flow**: Creates one CLI rollout and one Exec rollout, builds a provider filter, calls `get_threads` once with `INTERACTIVE_SESSION_SOURCES` and once with `NO_SOURCE_FILTER`, collects returned paths, and asserts the interactive-only result contains just the CLI file while the unfiltered result contains both files.

**Call relations**: This test exercises source-based filtering in the filesystem listing path using concrete session source values.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 4 external calls (new, from_u128, assert!, assert_eq!).


##### `test_model_provider_filter_selects_only_matching_sessions`  (lines 1550–1654)

```
async fn test_model_provider_filter_selects_only_matching_sessions() -> Result<()>
```

**Purpose**: Checks provider filtering semantics, including inclusion of sessions with no explicit provider when the requested provider matches the default provider argument.

**Data flow**: Creates three rollout files: one with provider `openai`, one with `beta`, and one with no provider. It then lists with an `openai` filter and default provider `openai`, asserting two sessions are returned (`openai` plus missing-provider); lists with a `beta` filter and asserts only the beta session is returned; lists with an unknown filter and asserts no sessions; and finally lists without provider filtering and asserts all three sessions are present.

**Call relations**: This test covers the provider-filter branch of listing logic and the fallback-to-default-provider rule for sessions whose metadata omits `model_provider`.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file_with_provider); 4 external calls (new, from_u128, assert!, assert_eq!).
