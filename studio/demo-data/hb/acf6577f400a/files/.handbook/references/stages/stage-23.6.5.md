# Memories, rollout, state, and persistence tests  `stage-23.6.5`

This stage is the project’s safety net for saved history and recovery. It is not the main user-facing work loop. Instead, it checks the behind-the-scenes machinery that records conversations, rebuilds them later, and keeps stored state usable after mistakes or damage.

The rollout trace tests feed fake event logs into the trace “reducer,” which is the part that turns noisy raw events into a clean replay of a session. They cover conversations, model calls, cancellations, code cells, terminal commands, child agents, protocol events, and thread tracing. The rollout storage tests then check the files and indexes that keep past sessions searchable, compressible, repairable, and linked to saved metadata.

The state and external-agent tests check the small databases and ledgers that remember threads, imported agent sessions, and completed configuration imports. Recovery tests make sure broken database files are moved aside safely.

The memories tests cover startup, prompt text, citations, file naming, cleanup, and workspace diffs. Message-history and thread-store helpers check that saved messages and fake local thread data can be read, appended, trimmed, and reused reliably in tests.

## Files in this stage

### Trace reducer fixtures and scenarios
Shared reducer fixtures come first, followed by focused replay and reduction tests for code cells, conversations, inference, and tool-specific agent and terminal behavior.

### `rollout-trace/src/reducer/test_support.rs`

`test` · `test setup and test assertions`

The reducer is tested by feeding it trace data, which is a record of things that happened during an agent run: a thread starts, a turn starts, a model request is made, a response arrives, and so on. Writing all of that by hand in every test would be noisy and easy to get wrong. This file is the test workshop bench: it provides ready-made helpers for creating a temporary trace writer, starting standard root or agent threads, starting turns, attaching the right thread-and-turn context, and adding inference, meaning model-call, request and completion events.

The helpers deliberately only create shared scaffolding. They do not hide the interesting event sequences inside a test, because those sequences are usually what the test is about. For example, a test can call `create_started_writer`, then `start_turn`, then add exactly the inference events it wants to examine.

Two built-in thread IDs represent common cases: a normal root thread and an agent-style root thread. The file also includes small conveniences for making message-shaped JSON and generic tool summaries. At the end, `expect_replay_error` runs the replay step and checks that a specific failure message appears, which helps tests prove that bad trace data is rejected for the right reason.

#### Function details

##### `message`  (lines 20–26)

```
fn message(role: &str, text: &str) -> serde_json::Value
```

**Purpose**: Builds a simple JSON message object with a role, such as user or assistant, and plain text content. Tests use it when they need realistic conversation input without spelling out the full JSON structure every time.

**Data flow**: It receives a role string and a text string. It places them into a standard message-shaped JSON value, with the text stored as an input text content item. It returns that JSON value and does not change anything else.

**Call relations**: Tests that exercise request compaction, encrypted reasoning, and similar model-input behavior call this helper when they need conversation messages. The helper hands back JSON that those tests can place into inference requests.

*Call graph*: called by 5 (compaction_boundary_repeats_prefix_and_reuses_replacement_items, context_compaction_boundary_repeats_prefix_and_reuses_replacement_items, encrypted_reasoning_reuses_response_item_in_later_request, encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body, same_encrypted_reasoning_with_different_text_reuses_first_readable_body); 1 external calls (json!).


##### `generic_summary`  (lines 28–34)

```
fn generic_summary(label: &str) -> ToolCallSummary
```

**Purpose**: Creates a plain tool-call summary with only a human-readable label. Tests use it when they need a tool summary but the exact input or output preview is not important.

**Data flow**: It receives a label string. It copies that label into a `ToolCallSummary::Generic` value and leaves the optional input and output previews empty. The result is returned to the test.

**Call relations**: Tests about terminal operations and write-stdin behavior call this helper to create expected summaries. It supplies a simple expected value that those tests compare against reducer output.

*Call graph*: called by 4 (code_mode_write_stdin_result_projects_structured_exec_fields, dispatch_write_stdin_payload_reduces_to_terminal_operation, exec_tool_reduces_to_terminal_operation_and_session, write_stdin_operation_reuses_existing_terminal_session).


##### `create_started_writer`  (lines 36–38)

```
fn create_started_writer(temp: &TempDir) -> anyhow::Result<TraceWriter>
```

**Purpose**: Creates a trace writer in a temporary directory and immediately records that the normal root thread has started. It saves tests from repeating the standard first step of a trace.

**Data flow**: It receives a temporary directory. It uses the default root thread ID and root agent path, asks `create_started_writer_for_thread` to create and initialize the writer, and returns that ready-to-use writer or an error.

**Call relations**: Many reducer tests begin by calling this function. It delegates the real work to `create_started_writer_for_thread`, so tests can start from a valid trace without knowing the writer creation details.

*Call graph*: calls 1 internal fn (create_started_writer_for_thread); called by 29 (cancelled_turn_terminates_unfinished_code_cell, code_cell_lifecycle_links_nested_tools_waits_and_outputs, fast_code_cell_lifecycle_waits_for_source_item, runtime_code_cell_ids_can_repeat_across_threads, agent_messages_preserve_routing_and_content, compaction_boundary_repeats_prefix_and_reuses_replacement_items, context_compaction_boundary_repeats_prefix_and_reuses_replacement_items, encrypted_reasoning_reuses_response_item_in_later_request, encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body, full_request_snapshot_can_reorder_existing_items_and_insert_summary (+15 more)).


##### `create_started_agent_writer`  (lines 40–42)

```
fn create_started_agent_writer(temp: &TempDir) -> anyhow::Result<TraceWriter>
```

**Purpose**: Creates a trace writer for tests that use the agent-style root thread and immediately records that this thread has started. This is the agent-thread version of the standard writer setup.

**Data flow**: It receives a temporary directory. It supplies the built-in agent root thread ID and root agent path to `create_started_writer_for_thread`, then returns the initialized writer or an error.

**Call relations**: Agent-routing tests call this when they need their trace to begin as an agent thread. It relies on `create_started_writer_for_thread` for the shared setup, keeping the agent and non-agent setup paths consistent.

*Call graph*: calls 1 internal fn (create_started_writer_for_thread); called by 9 (agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, close_agent_runtime_payload_targets_thread, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge).


##### `create_started_writer_for_thread`  (lines 44–57)

```
fn create_started_writer_for_thread(
    temp: &TempDir,
    thread_id: &str,
    agent_path: &str,
) -> anyhow::Result<TraceWriter>
```

**Purpose**: Creates a new trace writer for a specific thread and records that the thread has started. Use this when a test needs control over the thread ID or agent path.

**Data flow**: It receives a temporary directory, a thread ID, and an agent path. It creates a `TraceWriter` with fixed test trace and rollout IDs, then calls `start_thread` to write the thread-start event. It returns the initialized writer if both steps succeed.

**Call relations**: `create_started_writer` and `create_started_agent_writer` both call this shared helper. It hands the newly created writer to `start_thread` so the trace begins in a valid state before tests append more events.

*Call graph*: calls 2 internal fn (start_thread, create); called by 2 (create_started_agent_writer, create_started_writer); 1 external calls (path).


##### `start_thread`  (lines 59–70)

```
fn start_thread(
    writer: &TraceWriter,
    thread_id: &str,
    agent_path: &str,
) -> anyhow::Result<()>
```

**Purpose**: Writes a thread-start event into a trace. This tells the reducer, in test data, that a conversation or agent thread exists before later events refer to it.

**Data flow**: It receives a trace writer, a thread ID, and an agent path. It builds a `ThreadStarted` event with those values and no extra metadata, appends it to the trace, and returns success or the append error.

**Call relations**: Writer setup helpers call this automatically, and some agent tests call it directly when they need extra child threads. It hands the event to the trace writer, which stores it in the test trace.

*Call graph*: calls 1 internal fn (append); called by 10 (create_started_writer_for_thread, agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, close_agent_runtime_payload_targets_thread, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge).


##### `start_turn`  (lines 72–74)

```
fn start_turn(writer: &TraceWriter, turn_id: &str) -> anyhow::Result<()>
```

**Purpose**: Writes a turn-start event for the normal root thread. A turn is one round of work in a thread, so later model calls and tool activity can be tied to that round.

**Data flow**: It receives a writer and a turn ID. It combines that turn ID with the default root thread ID and calls `start_turn_for_thread`. The result is success or an error from writing the event.

**Call relations**: Many reducer tests call this after creating a started writer. It is a convenience wrapper around `start_turn_for_thread`, used when the test is about the normal root thread.

*Call graph*: calls 1 internal fn (start_turn_for_thread); called by 27 (cancelled_turn_terminates_unfinished_code_cell, code_cell_lifecycle_links_nested_tools_waits_and_outputs, fast_code_cell_lifecycle_waits_for_source_item, agent_messages_preserve_routing_and_content, compaction_boundary_repeats_prefix_and_reuses_replacement_items, context_compaction_boundary_repeats_prefix_and_reuses_replacement_items, encrypted_reasoning_reuses_response_item_in_later_request, encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body, full_request_snapshot_can_reorder_existing_items_and_insert_summary, incremental_request_carries_prior_request_and_response_items_forward (+15 more)).


##### `start_agent_turn`  (lines 76–78)

```
fn start_agent_turn(writer: &TraceWriter, turn_id: &str) -> anyhow::Result<()>
```

**Purpose**: Writes a turn-start event for the built-in agent root thread. Tests use it when they are checking agent routing or child-agent behavior.

**Data flow**: It receives a writer and a turn ID. It pairs the turn ID with the built-in agent root thread ID and asks `start_turn_for_thread` to append the event. It returns success or any write error.

**Call relations**: Agent-focused tests call this after creating an agent writer. It keeps those tests from repeating the special agent thread ID and relies on `start_turn_for_thread` for the actual event writing.

*Call graph*: calls 1 internal fn (start_turn_for_thread); called by 9 (agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, close_agent_runtime_payload_targets_thread, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge).


##### `start_turn_for_thread`  (lines 80–90)

```
fn start_turn_for_thread(
    writer: &TraceWriter,
    thread_id: &str,
    turn_id: &str,
) -> anyhow::Result<()>
```

**Purpose**: Writes a turn-start event for whichever thread the test names. This is the flexible version used when tests involve multiple threads or custom thread IDs.

**Data flow**: It receives a writer, a thread ID, and a turn ID. It builds a `CodexTurnStarted` event containing those IDs, appends it to the trace, and returns success or an error.

**Call relations**: The simpler `start_turn` and `start_agent_turn` helpers call this, and some multi-thread tests call it directly. It is the common point where turn-start events are turned into trace records.

*Call graph*: calls 1 internal fn (append); called by 10 (runtime_code_cell_ids_can_repeat_across_threads, start_agent_turn, start_turn, agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge).


##### `trace_context`  (lines 92–94)

```
fn trace_context(turn_id: &str) -> RawTraceEventContext
```

**Purpose**: Builds a context object for events that belong to the normal root thread and a specific turn. Context is the label that tells the reducer where an event happened.

**Data flow**: It receives a turn ID. It combines that turn ID with the default root thread ID by calling `trace_context_for_thread`, then returns the resulting context object.

**Call relations**: Tests use this when appending events that need explicit context, such as tool activity or model completion details. It delegates to `trace_context_for_thread` so all context objects have the same shape.

*Call graph*: calls 1 internal fn (trace_context_for_thread); called by 10 (cancelled_turn_terminates_unfinished_code_cell, code_cell_lifecycle_links_nested_tools_waits_and_outputs, fast_code_cell_lifecycle_waits_for_source_item, compaction_boundary_repeats_prefix_and_reuses_replacement_items, context_compaction_boundary_repeats_prefix_and_reuses_replacement_items, tool_call_links_model_call_and_followup_output_items, code_mode_write_stdin_result_projects_structured_exec_fields, dispatch_write_stdin_payload_reduces_to_terminal_operation, exec_tool_reduces_to_terminal_operation_and_session, write_stdin_operation_reuses_existing_terminal_session).


##### `trace_context_for_agent`  (lines 96–98)

```
fn trace_context_for_agent(turn_id: &str) -> RawTraceEventContext
```

**Purpose**: Builds a context object for events that belong to the built-in agent root thread and a specific turn. It is the agent-thread shortcut for contextual event writing.

**Data flow**: It receives a turn ID. It combines that turn ID with the agent root thread ID through `trace_context_for_thread`, then returns the context object.

**Call relations**: Agent tests call this when appending runtime or activity events that should be attached to the agent root thread. Like `trace_context`, it uses the shared context builder underneath.

*Call graph*: calls 1 internal fn (trace_context_for_thread); called by 6 (append_spawn_agent_tool_lifecycle, close_agent_runtime_payload_targets_thread, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge).


##### `trace_context_for_thread`  (lines 100–105)

```
fn trace_context_for_thread(thread_id: &str, turn_id: &str) -> RawTraceEventContext
```

**Purpose**: Builds a context object for any named thread and turn. Tests use it when they need exact control over where a trace event is attached.

**Data flow**: It receives a thread ID and a turn ID. It copies both into a `RawTraceEventContext`, with both fields present. It returns that context and does not write anything to disk.

**Call relations**: The root and agent context helpers call this, and tests with repeated IDs across threads or custom thread setups call it directly. Other helpers, such as `append_completed_inference`, use it before writing context-aware events.

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

**Purpose**: Writes the start of a model call for the normal root thread. Tests use it when they already have a saved request payload and want to mark that inference as started.

**Data flow**: It receives a writer, an inference call ID, a turn ID, and a reference to the request payload. It adds the default root thread ID and passes everything to `append_inference_start_for_thread`. It returns success or an error from appending.

**Call relations**: Many reducer tests call this to create model-call start events. It is a root-thread shortcut that hands the real event construction to `append_inference_start_for_thread`.

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

**Purpose**: Writes the start of a model call for a specific thread and turn. This gives tests a realistic inference-start event with fixed test model and provider names.

**Data flow**: It receives a writer, thread ID, turn ID, inference call ID, and request payload reference. It builds an `InferenceStarted` event with those values plus the test model name `gpt-test` and provider `test-provider`, appends it, and returns success or an error.

**Call relations**: `append_inference_start` and `append_inference_request` both call this helper. It is the shared place where test inference-start records are actually written to the trace.

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

**Purpose**: Writes a model-call completion event. Tests use it after an inference start when they want the reducer to see that a response came back.

**Data flow**: It receives a writer, an inference call ID, a response ID, and a response payload reference. It builds an `InferenceCompleted` event with that response ID, no upstream request ID, and the payload reference, then appends it to the trace.

**Call relations**: Tests about response output, reasoning, encrypted content, and tool-call linking call this after creating or referencing a response payload. It writes the completion directly through the trace writer.

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

**Purpose**: Writes a model request payload and then records that a model call has started for that request. This bundles two common test steps into one helper.

**Data flow**: It receives a writer, thread ID, turn ID, inference ID, and a list of JSON input items. It saves a JSON payload shaped like `{ "input": ... }` as an inference request, then calls `append_inference_start_for_thread` with the saved payload reference. It returns success or any error from saving or appending.

**Call relations**: Agent and messaging tests call this when they need a started model call with concrete input. `append_completed_inference` also uses it as the first half of a full request-and-response sequence.

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

**Purpose**: Writes a complete model-call sequence: request payload, inference-start event, response payload, and inference-completed event. It is useful when a test needs a finished model call without focusing on each low-level trace record.

**Data flow**: It receives a writer, thread ID, turn ID, inference ID, input JSON items, and output JSON items. First it writes the request and start event through `append_inference_request`. Then it saves a response payload containing a generated response ID and the output items. Finally, it appends a context-aware completion event tied to the same thread and turn. It returns success or the first error encountered.

**Call relations**: Tests that need a child or agent inference to be fully complete call this helper. It uses `trace_context_for_thread` so the final completion is clearly attached to the right thread and turn before handing it to the writer.

*Call graph*: calls 4 internal fn (append_inference_request, trace_context_for_thread, append_with_context, write_json_payload); called by 1 (agent_result_edge_links_child_result_to_parent_notification); 2 external calls (format!, json!).


##### `expect_replay_error`  (lines 195–202)

```
fn expect_replay_error(temp: &TempDir, expected: &str) -> anyhow::Result<()>
```

**Purpose**: Checks that replaying a test trace fails and that the error message contains expected text. Tests use it to prove the reducer rejects bad trace data for the intended reason.

**Data flow**: It receives a temporary directory containing a trace bundle and a piece of expected error text. It runs `replay_bundle` on the directory. If replay succeeds, it panics because the test expected failure. If replay fails, it turns the error into text and asserts that the text includes the expected phrase. It returns success when the expected failure is seen.

**Call relations**: Reducer error-case tests call this after deliberately writing invalid or unsupported trace data. It hands the temporary trace directory to the replay function and converts the resulting error into a clear test assertion.

*Call graph*: called by 5 (inference_start_rejects_unknown_codex_turn, missing_request_input_is_reducer_error, model_visible_call_id_reuse_with_different_content_is_reducer_error, unknown_previous_response_id_is_reducer_error, unsupported_model_item_is_reducer_error); 4 external calls (path, assert!, replay_bundle, panic!).


### `rollout-trace/src/reducer/code_cell_tests.rs`

`test` · `test run`

A “code cell” here is a chunk of code the model asked the system to run, similar to a notebook cell. The reducer’s job is to read a stream of low-level trace events and rebuild a useful story: which model message requested the code, what thread it belonged to, whether it finished or failed, which tools it called while running, and which later messages contained its output.

These tests create small fake trace bundles in a temporary folder, replay them, and then inspect the reduced result. This matters because real traces do not always arrive in the neat order a person would expect. For example, the runtime may report that a code cell started before the model response that requested it has been reduced. A cell may yield, wait for a later model turn, call nested tools, fail very quickly, or be left unfinished when a turn is cancelled.

The tests act like safety rails. They make sure the reducer links all those pieces into one coherent code-cell record instead of losing relationships or mixing up cells. One especially important check is that runtime cell IDs, like “1”, are only unique within a thread; two different threads can both have a runtime cell “1” without being confused.

#### Function details

##### `code_cell_lifecycle_links_nested_tools_waits_and_outputs`  (lines 23–190)

```
fn code_cell_lifecycle_links_nested_tools_waits_and_outputs() -> anyhow::Result<()>
```

**Purpose**: This test checks the full happy-path story for a code cell that starts, yields, calls a nested tool, is later waited on by the model, and then completes. It proves that the reducer connects the source model tool call, nested runtime tools, wait tools, and output conversation items into one code-cell record.

**Data flow**: The test starts with an empty temporary trace bundle, writes fake events for two turns, and includes JSON payloads that look like model requests and responses. It then replays the bundle into the reduced rollout view. The final checks confirm that the code cell has the right thread, completed status, runtime ID, nested tool ID, wait tool ID, output item link, and source conversation item kind.

**Call relations**: During the test, helper routines create the writer, start turns, and attach turn context to events. After the raw events are written, the test calls the replay step to run the reducer, then uses test_reduced_code_cell_id to look up the expected reduced code-cell record and compare the important fields.

*Call graph*: calls 4 internal fn (test_reduced_code_cell_id, create_started_writer, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `fast_code_cell_lifecycle_waits_for_source_item`  (lines 193–269)

```
fn fast_code_cell_lifecycle_waits_for_source_item() -> anyhow::Result<()>
```

**Purpose**: This test checks a race-like situation where a code cell starts, fails, and ends before the model response that created its source conversation item has been recorded. It makes sure the reducer waits long enough, conceptually, to connect the finished cell back to the model’s custom tool call.

**Data flow**: The test writes a model inference start, then writes code-cell start, initial failure, and end events, and only afterward writes the model inference completion containing the custom tool call. Replaying the bundle turns those out-of-order events into a reduced rollout. The assertions confirm that the failed cell still has the right thread, failed execution status, runtime ID, and source item type.

**Call relations**: The setup helpers create a temporary trace and a turn context, while the replay step exercises the reducer. The test uses test_reduced_code_cell_id to find the cell by the model-visible call ID, showing that the reducer can link the runtime event to the later-discovered source item.

*Call graph*: calls 4 internal fn (test_reduced_code_cell_id, create_started_writer, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `cancelled_turn_terminates_unfinished_code_cell`  (lines 272–334)

```
fn cancelled_turn_terminates_unfinished_code_cell() -> anyhow::Result<()>
```

**Purpose**: This test checks what happens when a turn is cancelled while a code cell is still running. It ensures the reducer does not leave the cell looking active forever, but marks it as terminated and cancelled.

**Data flow**: The test writes a model request and response that ask for code execution, then records that the code cell started. Instead of writing a code-cell end event, it writes a turn-ended event with a cancelled status. After replay, the reduced code cell is expected to have a terminated runtime status, a cancelled execution status, and an end sequence number matching the cancellation event.

**Call relations**: The test builds the trace with the same writer and context helpers used by the other reducer tests. Once replay_bundle has reduced the trace, test_reduced_code_cell_id gives the lookup key for the expected cell, and the assertions verify that turn cancellation was propagated to the unfinished code cell.

*Call graph*: calls 4 internal fn (test_reduced_code_cell_id, create_started_writer, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `runtime_code_cell_ids_can_repeat_across_threads`  (lines 337–423)

```
fn runtime_code_cell_ids_can_repeat_across_threads() -> anyhow::Result<()>
```

**Purpose**: This test confirms that runtime cell IDs are not treated as globally unique. Two different threads can both have a runtime cell ID like “1”, and the reducer must keep them separate by thread and model-visible call ID.

**Data flow**: The test creates a root thread and a child thread, starts one turn in each, and writes similar inference and code-cell events for both. Both code cells use the same runtime_cell_id value, but different thread IDs and model-visible call IDs. After replay, the test checks that each reduced cell belongs to the correct thread while preserving its runtime ID.

**Call relations**: This test uses thread-aware setup helpers to write events into two separate thread contexts. After replay_bundle reduces all events, test_reduced_code_cell_id is called twice to look up the two distinct reduced cells, proving the reducer did not merge them just because their runtime IDs matched.

*Call graph*: calls 4 internal fn (test_reduced_code_cell_id, create_started_writer, start_turn_for_thread, trace_context_for_thread); 5 external calls (new, assert_eq!, replay_bundle, format!, json!).


##### `test_reduced_code_cell_id`  (lines 425–427)

```
fn test_reduced_code_cell_id(model_visible_call_id: &str) -> String
```

**Purpose**: This small helper builds the reduced code-cell ID used by these tests. It keeps the expected ID format in one place so the tests do not repeat the same string-building logic.

**Data flow**: It receives the model-visible call ID, such as “call-code”, and returns a string in the form “code_cell:<call id>”. It does not read or change any shared state.

**Call relations**: Each test calls this helper after replaying a bundle, when it needs to look up the reduced code-cell record in the rollout. The helper mirrors the reducer’s expected naming convention so the assertions can focus on behavior rather than string formatting.

*Call graph*: called by 4 (cancelled_turn_terminates_unfinished_code_cell, code_cell_lifecycle_links_nested_tools_waits_and_outputs, fast_code_cell_lifecycle_waits_for_source_item, runtime_code_cell_ids_can_repeat_across_threads); 1 external calls (format!).


### `rollout-trace/src/reducer/conversation_tests.rs`

`test` · `test suite`

The reducer is the part of the system that replays a recorded trace and rebuilds the conversation from it. These tests create tiny fake traces in temporary folders, replay them, and check the resulting rollout. A rollout is the reconstructed story: turns, inference calls, conversation items, tool calls, compactions, and their links.

The file focuses on identity and continuity. For example, if a later request repeats an earlier user message, the reducer should reuse the old conversation item. But if the same text appears again as a new message, it should not blindly deduplicate it. The tests also check that assistant responses are added to the thread only after completion, that agent-to-agent messages keep their author and recipient, and that function calls and tool outputs are connected by their model-visible call IDs.

Several tests cover reasoning content, especially encrypted reasoning. Think of encrypted content like a sealed envelope with a label: the reducer can recognize the same envelope later, and may add readable notes if they are complementary, but should not overwrite earlier readable text with conflicting text.

The last group checks failure cases. Missing inputs, unknown previous responses, unsupported model item types, reused call IDs with different content, and inference starts tied to missing turns must produce clear reducer errors instead of silently creating a wrong history.

#### Function details

##### `request_snapshots_reuse_history_without_deduping_new_identical_items`  (lines 27–68)

```
fn request_snapshots_reuse_history_without_deduping_new_identical_items() -> anyhow::Result<()>
```

**Purpose**: Checks that a later full request can reuse old conversation items while still treating a repeated identical-looking message as a new item when it appears in a new position. This prevents the reducer from over-deduplicating the conversation just because two messages have the same text.

**Data flow**: It writes a first inference request with one user message, then writes a second request whose input contains that same message, an assistant message, and another identical user message. After replaying the trace, it compares the item IDs: the first item in the second request must reuse the old ID, while the later identical user message must get a different ID. The final thread history should match the second request snapshot.

**Call relations**: The test builds its trace through create_started_writer, start_turn, and append_inference_start, then asks replay_bundle to reduce the trace. Its assertions check the reducer's snapshot matching behavior after those helper functions have written the raw events.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 5 external calls (new, assert_eq!, assert_ne!, replay_bundle, json!).


##### `response_outputs_enter_thread_conversation_on_completion`  (lines 71–111)

```
fn response_outputs_enter_thread_conversation_on_completion() -> anyhow::Result<()>
```

**Purpose**: Checks that model response output becomes part of the thread conversation only when the inference completion event is replayed. This matters because a request alone should not imply that an assistant response already exists.

**Data flow**: It writes a request containing a user message, then writes a completed response containing one assistant message. After replay, it takes the request item IDs and response item IDs from the inference call, joins them together, and expects the thread's conversation list to contain that combined sequence.

**Call relations**: The test uses append_inference_start to record the request and append_inference_completion to record the response. replay_bundle then reconstructs the rollout, and the test verifies that completion is the moment response items enter the thread.

*Call graph*: calls 4 internal fn (append_inference_completion, append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `agent_messages_preserve_routing_and_content`  (lines 114–195)

```
fn agent_messages_preserve_routing_and_content() -> anyhow::Result<()>
```

**Purpose**: Checks that special agent-to-agent messages keep both their routing information and their body content. Routing means who sent the message and who it was meant for.

**Data flow**: It writes an inference request containing two agent messages: one with plain input text and one with encrypted content. After replay, it looks up the created conversation items and checks their role, channel, kind, author, recipient, and body parts. The expected result is assistant analysis messages with the original sender, receiver, and content preserved.

**Call relations**: The test records a request through append_inference_start and then calls replay_bundle. It verifies the model conversion path that turns raw JSON agent message items into the structured ConversationItem fields used by the rest of the rollout.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `later_full_request_reuses_prior_json_tool_call_by_position`  (lines 198–256)

```
fn later_full_request_reuses_prior_json_tool_call_by_position() -> anyhow::Result<()>
```

**Purpose**: Checks that a later full request can recognize and reuse a function call item that previously came from a model response. This keeps the conversation from duplicating the same model-visible tool call.

**Data flow**: It writes a first request, completes it with a function_call response item, then starts a second turn whose full request includes the original user message and the same function call. After replay, the second request item IDs must point to the first request's user item and the first response's function-call item. The total conversation item count should stay at two.

**Call relations**: The test records request and response events using the inference helpers, then replay_bundle rebuilds the conversation. The assertions focus on the reducer's ability to match a repeated full-request item back to an earlier response item.

*Call graph*: calls 4 internal fn (append_inference_completion, append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `incremental_request_carries_prior_request_and_response_items_forward`  (lines 259–335)

```
fn incremental_request_carries_prior_request_and_response_items_forward() -> anyhow::Result<()>
```

**Purpose**: Checks how incremental requests work when they reference a previous response. An incremental request only supplies new input, so the reducer must carry forward the earlier request and response items before adding the new follow-up item.

**Data flow**: It creates a first inference with a user message and a function-call response, including token usage. Then it creates a second request with previous_response_id and a function_call_output. After replay, the second request's item list must contain the old user item, the old function-call item, and the new tool-output item. It also checks that token usage from the first response was stored.

**Call relations**: The test uses append_inference_completion to establish a known response ID, then append_inference_start for the incremental follow-up. replay_bundle must resolve previous_response_id and assemble the full conversation context.

*Call graph*: calls 4 internal fn (append_inference_completion, append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `full_request_snapshot_can_reorder_existing_items_and_insert_summary`  (lines 338–378)

```
fn full_request_snapshot_can_reorder_existing_items_and_insert_summary() -> anyhow::Result<()>
```

**Purpose**: Checks that a later full request snapshot may reorder existing history items and insert a new summary item. This supports cases where the model context has been reshaped rather than simply appended to.

**Data flow**: It writes an initial request with a developer instruction followed by a user message. The next request contains the old user message first, then a new summary-like user message, then the old developer instruction. After replay, the matching old items must keep their IDs in their new positions, while the inserted summary gets a new ID.

**Call relations**: The test creates two turns with append_inference_start and asks replay_bundle to reconstruct them. It checks the reducer's full-snapshot matching logic rather than simple append-only history growth.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 5 external calls (new, assert_eq!, assert_ne!, replay_bundle, json!).


##### `reasoning_body_preserves_text_summary_and_encoded_content`  (lines 381–428)

```
fn reasoning_body_preserves_text_summary_and_encoded_content() -> anyhow::Result<()>
```

**Purpose**: Checks that reasoning output keeps all three kinds of information the model may provide: raw reasoning text, a summary, and encrypted content. This is important because each part tells a different piece of the story.

**Data flow**: It writes a request, then completes it with a reasoning output item containing reasoning text, summary text, and encrypted content. After replay, it finds the response conversation item and expects its body parts to contain text, summary, and encoded content in order.

**Call relations**: The test uses append_inference_completion to add a response with a reasoning item. replay_bundle converts that raw response into ConversationPart values, and the assertion checks that no part was dropped.

*Call graph*: calls 4 internal fn (append_inference_completion, append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `encrypted_reasoning_reuses_response_item_in_later_request`  (lines 431–528)

```
fn encrypted_reasoning_reuses_response_item_in_later_request() -> anyhow::Result<()>
```

**Purpose**: Checks that encrypted reasoning seen in a later request is recognized as the same item that appeared earlier in a response. This lets the reducer keep a single identity for a sealed reasoning block even when the later request only repeats the encrypted form.

**Data flow**: It creates a first response with readable reasoning plus encrypted content and a function call. A later request repeats the user message, the encrypted reasoning, the function call, and adds a function_call_output. After replay, the later request must reuse the earlier user, reasoning, and function-call item IDs, then add one new output item. The reasoning item should still include the readable text from the first sighting plus the encrypted content.

**Call relations**: The test combines message creation, inference start/completion helpers, and replay_bundle. It exercises the reducer path that matches later request items back to earlier response items using encrypted reasoning identity and function-call identity.

*Call graph*: calls 5 internal fn (append_inference_completion, append_inference_start, create_started_writer, message, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body`  (lines 531–595)

```
fn encrypted_reasoning_upgrades_when_later_sighting_has_more_readable_body() -> anyhow::Result<()>
```

**Purpose**: Checks that two sightings of the same encrypted reasoning can be merged when each provides different readable evidence. In plain terms, if one sighting has the detailed text and another has the summary, the reducer should keep both.

**Data flow**: It writes one request containing a user message and encrypted reasoning with readable text. A later request repeats the same user message and the same encrypted reasoning, but this time with only a summary. After replay, both requests should refer to the same reasoning item, and that item's body should contain the text, the summary, and the encrypted content.

**Call relations**: The test records two inference starts and then calls replay_bundle. It checks that the reducer treats matching encrypted content as one item and safely enriches that item when the new readable part does not conflict with the old one.

*Call graph*: calls 4 internal fn (append_inference_start, create_started_writer, message, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `same_encrypted_reasoning_with_different_text_reuses_first_readable_body`  (lines 598–672)

```
fn same_encrypted_reasoning_with_different_text_reuses_first_readable_body() -> anyhow::Result<()>
```

**Purpose**: Checks that when the same encrypted reasoning appears later with conflicting readable text, the reducer reuses the existing item but does not overwrite the earlier readable text. This avoids replacing trusted earlier evidence with a contradictory later version.

**Data flow**: It writes a response containing encrypted reasoning with the text 'first text'. A later request repeats the same encrypted content but supplies different text. After replay, the second request must reuse the original reasoning item ID, and that item's body must still contain the first text and the encrypted content only.

**Call relations**: The test first establishes the reasoning item through append_inference_completion, then records a conflicting later request. replay_bundle must match the encrypted identity while refusing an unsafe content upgrade.

*Call graph*: calls 5 internal fn (append_inference_completion, append_inference_start, create_started_writer, message, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `model_visible_call_id_reuse_with_different_content_is_reducer_error`  (lines 675–711)

```
fn model_visible_call_id_reuse_with_different_content_is_reducer_error() -> anyhow::Result<()>
```

**Purpose**: Checks that the reducer rejects a model-visible function call ID if it is reused for different call content. A call ID is supposed to identify one specific tool request, so changing the command under the same ID would corrupt later linking.

**Data flow**: It writes one request with call_id 'call-1' for a cargo test command, then another request with the same call_id but a cargo check command. Instead of producing a rollout, replay is expected to fail with an error explaining that the call ID was reused with different content.

**Call relations**: The test uses append_inference_start to create the conflicting events and expect_replay_error to verify the reducer fails. It protects the identity checks used later to connect model calls to tool outputs.

*Call graph*: calls 4 internal fn (append_inference_start, create_started_writer, expect_replay_error, start_turn); 2 external calls (new, json!).


##### `unsupported_model_item_is_reducer_error`  (lines 714–736)

```
fn unsupported_model_item_is_reducer_error() -> anyhow::Result<()>
```

**Purpose**: Checks that an unknown model item type is treated as an error rather than silently ignored. This makes format changes visible and prevents missing conversation data.

**Data flow**: It writes a request whose input contains a made-up item type. When replay is attempted, the expected result is an error message naming that unsupported type, not a partial rollout.

**Call relations**: The test records the bad request with append_inference_start and delegates the expected failure check to expect_replay_error. It guards the reducer's parser against quietly skipping data it does not understand.

*Call graph*: calls 4 internal fn (append_inference_start, create_started_writer, expect_replay_error, start_turn); 2 external calls (new, json!).


##### `missing_request_input_is_reducer_error`  (lines 739–753)

```
fn missing_request_input_is_reducer_error() -> anyhow::Result<()>
```

**Purpose**: Checks that an inference request without an input field is rejected. The reducer cannot reconstruct a conversation request if the actual input history is missing.

**Data flow**: It writes a request payload that includes a model name but no input. Replay is expected to fail with a message saying the request did not contain input.

**Call relations**: The test uses append_inference_start to attach the malformed payload to an inference and expect_replay_error to confirm the reducer reports the problem.

*Call graph*: calls 4 internal fn (append_inference_start, create_started_writer, expect_replay_error, start_turn); 2 external calls (new, json!).


##### `unknown_previous_response_id_is_reducer_error`  (lines 756–771)

```
fn unknown_previous_response_id_is_reducer_error() -> anyhow::Result<()>
```

**Purpose**: Checks that an incremental request cannot point to a previous response ID the reducer has never seen. Without that prior response, the reducer cannot know what history to carry forward.

**Data flow**: It writes a request with previous_response_id set to a missing response and includes a normal user input. Replay should stop with an error naming the unknown previous response ID.

**Call relations**: The test records the bad incremental request through append_inference_start and uses expect_replay_error. It protects the path where replay_bundle resolves previous_response_id references.

*Call graph*: calls 4 internal fn (append_inference_start, create_started_writer, expect_replay_error, start_turn); 2 external calls (new, json!).


##### `compaction_boundary_repeats_prefix_and_reuses_replacement_items`  (lines 774–874)

```
fn compaction_boundary_repeats_prefix_and_reuses_replacement_items() -> anyhow::Result<()>
```

**Purpose**: Checks how a normal compaction checkpoint affects conversation identity. Compaction means older history is replaced by a shorter summary or replacement history, like swapping a stack of papers for a digest plus a marker.

**Data flow**: It writes an initial request with developer and user messages, then records a compaction checkpoint with the original input history and replacement history. A later request repeats the developer prefix and then uses the replacement history. After replay, the compaction should remember the original input item IDs, create replacement items produced by the compaction, create a compaction marker item, and have the later request reuse those replacement items after the prefix.

**Call relations**: The test uses append_inference_start for inference events and append_with_context with a CompactionInstalled event for the checkpoint. replay_bundle must stitch these together so compaction-produced items and later request items line up correctly.

*Call graph*: calls 5 internal fn (append_inference_start, create_started_writer, message, start_turn, trace_context); 5 external calls (new, assert_eq!, assert_ne!, replay_bundle, json!).


##### `context_compaction_boundary_repeats_prefix_and_reuses_replacement_items`  (lines 877–943)

```
fn context_compaction_boundary_repeats_prefix_and_reuses_replacement_items() -> anyhow::Result<()>
```

**Purpose**: Checks the same replacement-history behavior for context compaction items. It specifically verifies that the compacted encrypted summary is represented as a summary-channel message.

**Data flow**: It writes an initial request, installs a compaction checkpoint whose replacement history includes a context_compaction item with encrypted content, and then writes a later request containing that replacement history. After replay, the compacted summary item should have the Summary channel, Message kind, and an encoded body part carrying the encrypted summary.

**Call relations**: The test records inference and compaction events with the same helper pattern as the normal compaction test. replay_bundle converts the raw context_compaction item into the structured conversation item that the assertions inspect.

*Call graph*: calls 5 internal fn (append_inference_start, create_started_writer, message, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `tool_call_links_model_call_and_followup_output_items`  (lines 946–1040)

```
fn tool_call_links_model_call_and_followup_output_items() -> anyhow::Result<()>
```

**Purpose**: Checks that the reducer connects three views of the same tool use: the model's function call, the system's tool-call event, and the later function_call_output sent back to the model. This makes it possible to follow a tool call from request to execution to result.

**Data flow**: It writes a first inference whose response asks for an exec_command tool call with call_id 'call-1'. It then records ToolCallStarted and ToolCallEnded events for a real tool call tied to that model-visible ID. A later incremental request sends the function_call_output for the same call ID. After replay, the first inference should list the tool call it started, the tool call should point to the model call item and output item, and the output conversation item should be marked as produced by that tool.

**Call relations**: The test uses append_inference_completion for the model call, append_with_context for tool lifecycle events, and append_inference_start for the follow-up output. replay_bundle is expected to use the shared model-visible call ID to link all those pieces.

*Call graph*: calls 5 internal fn (append_inference_completion, append_inference_start, create_started_writer, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `inference_start_rejects_unknown_codex_turn`  (lines 1043–1056)

```
fn inference_start_rejects_unknown_codex_turn() -> anyhow::Result<()>
```

**Purpose**: Checks that an inference cannot be attached to a turn that was never started. A turn is the surrounding unit of work, so accepting an unknown turn would leave the inference floating without context.

**Data flow**: It creates a writer but does not start the referenced turn. It writes an inference start that names 'turn-missing'. Replay is expected to fail with an error saying the codex turn is unknown.

**Call relations**: The test intentionally skips start_turn, then records the inference with append_inference_start. expect_replay_error confirms that replay_bundle enforces the requirement that each inference belongs to a known turn.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, expect_replay_error); 2 external calls (new, json!).


### `rollout-trace/src/reducer/inference_tests.rs`

`test` · `test run`

This file is a set of safety checks for the reducer, the part of the system that replays raw trace events and turns them into a structured rollout record. In everyday terms, it checks the project’s “flight recorder” after interrupted model calls: if an assistant answer was only partly produced, the final record should still show what was produced and why the call stopped.

Each test creates a temporary trace bundle, starts a turn, records an inference request, and then appends events that represent cancellation or turn ending. After that, it replays the bundle and inspects the resulting rollout model.

The important behavior is about timing. If an inference is directly cancelled and includes a partial response, the reducer should mark that inference as cancelled and create conversation items from the partial response. If the whole turn is cancelled while an inference is still running, the inference should be closed too. But if the turn has already ended as failed, and a cancellation notice arrives later, the reducer should keep the earlier failed status while still saving useful late information such as the partial response payload and upstream request id. This prevents the final trace from telling a misleading story about what happened.

#### Function details

##### `cancelled_inference_reduces_partial_response_items`  (lines 16–70)

```
fn cancelled_inference_reduces_partial_response_items() -> anyhow::Result<()>
```

**Purpose**: This test checks that a cancelled inference can still contribute a partial assistant message to the final conversation record. It protects against losing useful output just because the model call was interrupted.

**Data flow**: The test starts with an empty temporary trace folder, writes a turn start, writes an inference request, then records an inference cancellation that includes a partial response payload. It replays those raw events into a rollout and checks the result: the inference is marked cancelled, the upstream request id is stored, one response item exists, and that item is recorded as an assistant message produced by this inference.

**Call relations**: The test uses the shared test helpers to create a writer, start a turn, and append the inference start event. It then relies on replay_bundle to run the reducer over the temporary trace, and uses assertions to verify that the reducer turned the cancellation event and partial response into the expected model objects.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `cancelled_turn_closes_running_inference_call`  (lines 73–97)

```
fn cancelled_turn_closes_running_inference_call() -> anyhow::Result<()>
```

**Purpose**: This test checks that when a whole turn is cancelled, any inference still running inside that turn is also treated as cancelled. Without this, the final rollout could show a model call as still open even though its parent turn has ended.

**Data flow**: The test creates a temporary trace, starts one turn, records one inference request, and starts that inference. Instead of cancelling the inference directly, it appends a turn-ended event with a cancelled status. After replay, it reads the inference from the rollout and checks that its execution status is cancelled and that its end sequence matches the turn-ending event.

**Call relations**: The setup is built through the same test-support helpers used by the other reducer tests. The key handoff is to replay_bundle, which interprets the turn cancellation and applies it to the still-running inference. The assertions confirm that this parent-to-child closing behavior happened.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `late_cancelled_inference_preserves_turn_end_status`  (lines 100–158)

```
fn late_cancelled_inference_preserves_turn_end_status() -> anyhow::Result<()>
```

**Purpose**: This test checks a subtle ordering case: a turn has already ended as failed, and only afterward a cancellation event arrives for an inference in that turn. The reducer should keep the original failed status, while still saving useful details from the late cancellation.

**Data flow**: The test writes a turn, starts an inference, then ends the turn with a failed status. After that, it writes a partial inference response and appends a cancellation event that points to that partial response. When the trace is replayed, the inference still has the failed status and the original end sequence from the turn end, but it also stores the late partial response payload id, the upstream request id, and a response item containing the text from the partial response.

**Call relations**: This test models an event stream where cancellation is noticed after the turn has already been closed. It uses the helper functions to build the trace, then replay_bundle runs the reducer. The assertions check that the reducer does not let the later cancellation rewrite the earlier turn-end status, but does still pass along the partial response data into the final rollout.

*Call graph*: calls 3 internal fn (append_inference_start, create_started_writer, start_turn); 4 external calls (new, assert_eq!, replay_bundle, json!).


### `rollout-trace/src/reducer/tool/agents_tests.rs`

`test` · `test run`

This is a test file for the part of the system that replays raw trace events into a clearer story of what happened. In this project, an agent can start another agent, send it work, follow up, close it, or receive a final result. The reducer must turn those scattered raw events into “interaction edges”: links that say, for example, “this tool call in the parent caused this message to appear in the child.” Without these tests, the trace could show separate threads and tool calls but fail to explain how they are connected.

Each test builds a small fake trace in a temporary folder using a TraceWriter. It writes events such as “thread started,” “tool call started,” “runtime event ended,” and “model saw this message.” Then it replays the bundle and checks the reduced model. The important checks are about where an edge starts, where it points, what conversation item it carries, and which raw payloads remain attached as proof.

A recurring idea is fallback behavior. If the reducer can find the exact delivered conversation message, it links to that precise item. If not, it falls back to the thread itself rather than inventing a false message link. That is like labeling a package delivery: best case, you point to the signed receipt; if there is no receipt, you at least point to the destination house.

#### Function details

##### `child_thread_metadata_creates_spawn_origin_without_delivery_edge`  (lines 29–84)

```
fn child_thread_metadata_creates_spawn_origin_without_delivery_edge() -> anyhow::Result<()>
```

**Purpose**: This test checks that metadata on a newly started child thread is enough to mark it as spawned by a parent thread, but not enough to create a delivered-message edge. It makes sure the reducer does not claim a message was delivered before it has seen the child-side conversation item.

**Data flow**: It creates a temporary trace folder, writes session metadata describing a subagent spawn, then writes a thread-start event that points to that metadata. After replaying the trace, it reads the child thread and confirms its nickname, model, and spawn origin were filled in. It also confirms there is no interaction edge yet, because no actual delivered conversation item exists.

**Call relations**: The test builds the trace directly with TraceWriter::create and JSON payload writing, then hands the folder to replay_bundle. It relies on replay_bundle to run the reducer, and the assertions verify that the reducer separates identity metadata from real message delivery.

*Call graph*: calls 1 internal fn (create); 5 external calls (new, assert!, assert_eq!, replay_bundle, json!).


##### `spawn_runtime_payload_targets_delivered_child_message`  (lines 87–147)

```
fn spawn_runtime_payload_targets_delivered_child_message() -> anyhow::Result<()>
```

**Purpose**: This test checks the normal spawn-agent path where a parent tool call creates a child thread and the child receives a model-visible task message. It expects the final interaction edge to point to that exact child conversation item.

**Data flow**: It starts a parent agent turn, appends a full spawn-agent tool lifecycle, starts the child thread and turn, then writes an inference request containing the inter-agent task message. After replay, it reads the spawn edge and checks that the source is the parent tool call, the target is the child conversation item, and the raw payload IDs from the tool lifecycle are carried on the edge.

**Call relations**: This test calls append_spawn_agent_tool_lifecycle to avoid repeating the parent-side spawn setup, uses inter_agent_message to build the delivered child message, and uses target_conversation_item_id to inspect the edge target. It then depends on replay_bundle to connect those pieces into one SpawnAgent interaction edge.

*Call graph*: calls 8 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, append_spawn_agent_tool_lifecycle, inter_agent_message, target_conversation_item_id); 4 external calls (new, assert_eq!, replay_bundle, vec!).


##### `spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item`  (lines 150–195)

```
fn spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item() -> anyhow::Result<()>
```

**Purpose**: This test checks what happens when a spawn-agent tool call starts a child thread, but the child never records the delivered task message. It confirms the reducer still creates a useful spawn edge, but points it only at the child thread.

**Data flow**: It writes the parent spawn tool lifecycle and starts the child thread, but deliberately skips the child inference request that would contain the task message. After replay, it checks that the edge source is the spawn tool call, the target is the child thread, no conversation item IDs are carried, and the raw tool payloads are still attached.

**Call relations**: The setup is shared through append_spawn_agent_tool_lifecycle. Unlike the delivered-message test, this one stops before calling append_inference_request for the child. replay_bundle must therefore use its fallback behavior rather than target a precise conversation item.

*Call graph*: calls 4 internal fn (create_started_agent_writer, start_agent_turn, start_thread, append_spawn_agent_tool_lifecycle); 4 external calls (new, assert!, assert_eq!, replay_bundle).


##### `sub_agent_started_activity_creates_spawn_edge`  (lines 198–286)

```
fn sub_agent_started_activity_creates_spawn_edge() -> anyhow::Result<()>
```

**Purpose**: This test covers a newer style of runtime payload where a spawn is reported as a sub-agent activity event. It verifies that this activity still produces a proper spawn edge to the child’s delivered task message.

**Data flow**: It writes a spawn_agent tool invocation, then writes a runtime-ended activity payload that names the child thread and path. It starts the child thread, adds the child’s task message, replays the trace, and checks that the spawn edge links the parent tool call to the child conversation item. It also checks that the edge carries the invocation and activity payload IDs as evidence.

**Call relations**: The test writes events with trace_context_for_agent so they belong to the parent turn, then uses append_inference_request to place the delivered message in the child timeline. target_conversation_item_id is used after replay_bundle to confirm that the reducer chose the message, not just the thread.

*Call graph*: calls 7 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_agent, target_conversation_item_id); 6 external calls (new, assert_eq!, replay_bundle, format!, json!, vec!).


##### `send_message_runtime_payload_targets_delivered_child_message`  (lines 289–392)

```
fn send_message_runtime_payload_targets_delivered_child_message() -> anyhow::Result<()>
```

**Purpose**: This test checks that a send_message tool call is linked to the exact message that appears in the receiving child agent’s conversation. It protects the trace from showing a send action without its visible delivery point.

**Data flow**: It writes a send_message tool call, runtime start and end payloads naming the sender and receiver threads, then starts the receiver thread and records the delivered inter-agent message. After replay, it checks that the edge is a SendMessage edge, starts at the tool call, points to the child conversation item, belongs to the receiver thread, and has an end time.

**Call relations**: The test uses trace_context_for_agent to attach tool events to the parent turn, inter_agent_message to create the delivered mailbox content, and append_inference_request to put that content into the child turn. replay_bundle is responsible for matching the runtime payload to that delivered item.

*Call graph*: calls 8 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_agent, inter_agent_message, target_conversation_item_id); 6 external calls (new, assert!, assert_eq!, replay_bundle, json!, vec!).


##### `send_message_activity_targets_delivered_child_message`  (lines 395–478)

```
fn send_message_activity_targets_delivered_child_message() -> anyhow::Result<()>
```

**Purpose**: This test checks the activity-event form of send_message, where the runtime payload reports that the parent interacted with a child agent. It confirms that the reducer still finds the delivered child-side message.

**Data flow**: It writes a send_message invocation, writes an activity-style runtime-ended payload naming the child thread and path, then records the child’s received message. After replay, it checks that the SendMessage edge targets the child conversation item and carries both the invocation payload and activity payload.

**Call relations**: This is parallel to the runtime-payload send_message test, but uses a different payload shape. inter_agent_message and append_inference_request create the child-side evidence, while replay_bundle must interpret the activity payload and attach it to the same delivered item.

*Call graph*: calls 8 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_agent, inter_agent_message, target_conversation_item_id); 5 external calls (new, assert_eq!, replay_bundle, json!, vec!).


##### `followup_activity_targets_delivered_child_message`  (lines 481–564)

```
fn followup_activity_targets_delivered_child_message() -> anyhow::Result<()>
```

**Purpose**: This test checks that a follow-up task sent to an existing child agent is linked to the child message that delivers that follow-up. It verifies the reducer treats follow-up assignment as its own kind of agent interaction.

**Data flow**: It writes a followup_task tool invocation using the AssignAgentTask kind, records an activity payload naming the child, starts the child turn, and adds the delivered follow-up message. After replay, it checks that the edge kind is AssignAgentTask, that it targets the child conversation item, and that it carries the raw invocation and activity payload IDs.

**Call relations**: The test follows the same pattern as the send-message activity test, but changes the tool kind and message meaning. replay_bundle must turn those raw events into an AssignAgentTask edge rather than a generic send.

*Call graph*: calls 8 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_agent, inter_agent_message, target_conversation_item_id); 5 external calls (new, assert_eq!, replay_bundle, json!, vec!).


##### `close_agent_runtime_payload_targets_thread`  (lines 567–687)

```
fn close_agent_runtime_payload_targets_thread() -> anyhow::Result<()>
```

**Purpose**: This test checks that closing an agent points to the agent thread itself, not to a conversation message. Closing is an action on the child agent’s lifecycle, so the thread is the right target.

**Data flow**: It starts a child thread, writes a close_agent tool call from the parent, records runtime start and end payloads naming the receiver thread, writes the tool result, and then ends the child thread. After replay, it checks that the CloseAgent edge starts at the tool call, targets the child thread, carries no conversation item IDs, carries all relevant raw payload IDs, and marks the child thread execution as completed.

**Call relations**: The test uses trace_context_for_agent to place the close tool events in the parent turn, then relies on replay_bundle to connect those payloads to the already-started child thread. It also checks that ending the child thread does not incorrectly complete the whole rollout.

*Call graph*: calls 4 internal fn (create_started_agent_writer, start_agent_turn, start_thread, trace_context_for_agent); 5 external calls (new, assert!, assert_eq!, replay_bundle, json!).


##### `agent_result_edge_links_child_result_to_parent_notification`  (lines 690–774)

```
fn agent_result_edge_links_child_result_to_parent_notification() -> anyhow::Result<()>
```

**Purpose**: This test checks the happy path for a child agent reporting a result to its parent. It verifies the edge starts at the child’s actual result message and points to the parent’s notification message.

**Data flow**: It starts a child thread and records a completed child inference whose output text is “done.” It then writes an AgentResultObserved event with a raw payload and later records the parent receiving a notification message. After replay, it checks that the AgentResult edge source is the child result conversation item, the target is the parent notification conversation item, and the raw result payload is carried.

**Call relations**: append_completed_inference creates the child output that can become the edge source. inter_agent_message and append_inference_request create the parent-side notification target. replay_bundle must match both sides so the edge tells the full story from child result to parent notice.

*Call graph*: calls 9 internal fn (append_completed_inference, append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_thread, inter_agent_message, target_conversation_item_id); 6 external calls (new, assert_eq!, replay_bundle, json!, panic!, vec!).


##### `agent_result_edge_falls_back_to_child_thread_without_result_message`  (lines 777–868)

```
fn agent_result_edge_falls_back_to_child_thread_without_result_message() -> anyhow::Result<()>
```

**Purpose**: This test checks a failure case where the child agent sends a status notification but never produced an assistant result message. It makes sure the reducer does not mistake the child’s inbound task message for the child’s result.

**Data flow**: It starts a child thread and records only the child’s incoming task message, then writes an AgentResultObserved failure notification. It also records the parent receiving that failure notification. After replay, it checks that the edge source falls back to the child thread, the target is still the precise parent conversation item, and the raw agent-result payload is carried.

**Call relations**: The test uses trace_context_for_thread to attach the observed result to the child turn, then uses inter_agent_message and append_inference_request for the parent-side delivery. replay_bundle must be careful: it may target the parent notification, but must not invent a child result item.

*Call graph*: calls 8 internal fn (append_inference_request, create_started_agent_writer, start_agent_turn, start_thread, start_turn_for_thread, trace_context_for_thread, inter_agent_message, target_conversation_item_id); 5 external calls (new, assert_eq!, replay_bundle, json!, vec!).


##### `append_spawn_agent_tool_lifecycle`  (lines 877–966)

```
fn append_spawn_agent_tool_lifecycle(
    writer: &TraceWriter,
    turn_id: &str,
) -> anyhow::Result<SpawnAgentToolPayloads>
```

**Purpose**: This helper writes the standard parent-side sequence for a spawn_agent tool call. It lets the spawn tests focus on what happens on the child side instead of repeating the same setup.

**Data flow**: It receives a TraceWriter and a parent turn ID. It writes four raw payloads: the tool invocation, the runtime-start event, the runtime-end event that names the new child thread, and the final tool result. It appends matching trace events for each payload and returns the payload references so the tests can later check that the reducer preserved them on the edge.

**Call relations**: It is called by the two spawn runtime payload tests. Internally it uses trace_context_for_agent so each appended event belongs to the right parent turn, and it hands back a SpawnAgentToolPayloads bundle for later assertions after replay_bundle runs.

*Call graph*: calls 3 internal fn (trace_context_for_agent, append_with_context, write_json_payload); called by 2 (spawn_runtime_payload_falls_back_to_child_thread_without_delivery_item, spawn_runtime_payload_targets_delivered_child_message); 1 external calls (json!).


##### `inter_agent_message`  (lines 968–977)

```
fn inter_agent_message(author: &str, recipient: &str, content: &str, trigger_turn: bool) -> String
```

**Purpose**: This helper builds the JSON text used to represent a message from one agent to another. Tests use it to create realistic delivered mailbox messages without rewriting the same JSON shape each time.

**Data flow**: It takes an author path, a recipient path, message content, and a flag saying whether the message should trigger a turn. It packages those values into a JSON object with no other recipients, converts it to a string, and returns that string for insertion into a test inference request.

**Call relations**: It is used by the spawn, send-message, follow-up, and agent-result tests whenever they need a child or parent conversation item that represents an inter-agent delivery. The returned string is usually passed into message and then append_inference_request.

*Call graph*: called by 6 (agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_targets_delivered_child_message); 1 external calls (json!).


##### `target_conversation_item_id`  (lines 979–984)

```
fn target_conversation_item_id(anchor: &TraceAnchor) -> &String
```

**Purpose**: This helper extracts the conversation item ID from a trace anchor when a test expects an edge to point at a specific message. It fails loudly if the edge points somewhere else, such as a thread.

**Data flow**: It receives a TraceAnchor. If the anchor is a ConversationItem, it returns the contained item ID by reference. If not, it stops the test with a panic, making the mismatch obvious.

**Call relations**: Many tests call this after replay_bundle to inspect an edge target. It turns the general anchor value into the exact ID needed to look up the conversation item and check which thread it belongs to.

*Call graph*: called by 7 (agent_result_edge_falls_back_to_child_thread_without_result_message, agent_result_edge_links_child_result_to_parent_notification, followup_activity_targets_delivered_child_message, send_message_activity_targets_delivered_child_message, send_message_runtime_payload_targets_delivered_child_message, spawn_runtime_payload_targets_delivered_child_message, sub_agent_started_activity_creates_spawn_edge); 1 external calls (panic!).


##### `text_body`  (lines 986–991)

```
fn text_body(item: &crate::model::ConversationItem) -> &str
```

**Purpose**: This helper reads the plain text from a conversation item when the test expects that item to contain exactly one text part. It is used to confirm that the chosen source message really is the child’s result text.

**Data flow**: It receives a ConversationItem, looks inside its body, and returns the text if there is exactly one text part. If the item has a different shape, it panics so the test fails rather than silently reading the wrong content.

**Call relations**: It is used in the agent result linking test after replay_bundle has selected a child conversation item as the edge source. The helper lets the test confirm that the source item says “done,” proving the reducer chose the child output rather than another message.

*Call graph*: 1 external calls (panic!).


### `rollout-trace/src/reducer/tool/terminal_tests.rs`

`test` · `test run`

This is a test file for the trace reducer, the part of the system that takes low-level recorded events and turns them into a more useful story of what happened. The raw trace contains separate facts such as “a tool started,” “a runtime event arrived,” “a tool ended,” and “the model saw this output.” This file verifies that those scattered facts are stitched into terminal operations and terminal sessions.

A terminal operation is one action, such as running `cargo test` or sending text into an existing shell. A terminal session is the longer-lived terminal process that those actions belong to, like one open terminal tab that may receive several commands over time. Without these tests, the reducer could accidentally lose the link between a tool call and the terminal it created, attach stdin to the wrong session, miss raw payload references, or flatten structured command results into incomplete output.

Each test creates a temporary trace, writes a small sequence of fake raw events into it, replays the bundle, and compares the reduced result with the exact expected model. Two helper functions add realistic model inference events: one where the model asks to run a command, and another where the next model request includes the tool output. Together, the tests make sure the reducer preserves both the machine-facing details and the model-facing conversation context.

#### Function details

##### `exec_tool_reduces_to_terminal_operation_and_session`  (lines 27–215)

```
fn exec_tool_reduces_to_terminal_operation_and_session() -> anyhow::Result<()>
```

**Purpose**: This test proves that a normal command execution, such as running `cargo test`, becomes both a terminal operation and a terminal session after replay. It also checks that the reducer keeps the links back to the original raw payloads and to what the model saw.

**Data flow**: It starts with an empty temporary trace, then writes a turn, a model request that asks for an `exec_command`, a tool start event, runtime start and end events, a tool result, and a later model request containing the tool output. After replaying the trace, it expects one terminal operation for the command and one terminal session for the created terminal. The output is not a returned value from the test; instead, the test passes only if the reduced rollout exactly matches the expected command, timing, status, stdout, payload IDs, session ID, and model observation links.

**Call relations**: This is the broad end-to-end test in the file. It uses the shared test setup helpers to create the writer, start turns, and add standard inference events through `append_inference_with_tool_call` and `append_followup_with_tool_output`. It then calls the replay step and uses assertions to confirm that the reducer connected all the pieces into the final terminal records.

*Call graph*: calls 6 internal fn (create_started_writer, generic_summary, start_turn, trace_context, append_followup_with_tool_output, append_inference_with_tool_call); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `write_stdin_operation_reuses_existing_terminal_session`  (lines 218–318)

```
fn write_stdin_operation_reuses_existing_terminal_session() -> anyhow::Result<()>
```

**Purpose**: This test checks that sending input to an already-running terminal does not create a separate, unrelated session. It verifies the everyday case where a shell is started first, and later text like `echo hi` is typed into that same shell.

**Data flow**: It writes a trace where one tool starts a terminal process with process ID `pty-1`, then another tool call writes stdin into that same process. When the trace is replayed, the existing terminal session should contain both operations in order. The stdin operation should point at `pty-1`, contain the typed text, remain running because no end event was written, and keep the raw payload ID that described the stdin event.

**Call relations**: This test builds directly on the reducer’s session-linking behavior. It uses the common writer and turn helpers, writes the startup and stdin runtime events, then calls the replay step. The assertions focus on whether the second operation was added to the first session instead of being treated as a brand-new terminal.

*Call graph*: calls 4 internal fn (create_started_writer, generic_summary, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `dispatch_write_stdin_payload_reduces_to_terminal_operation`  (lines 321–439)

```
fn dispatch_write_stdin_payload_reduces_to_terminal_operation() -> anyhow::Result<()>
```

**Purpose**: This test checks a different path for stdin writes: when the request details come from the tool invocation payload rather than from a runtime event. It makes sure the reducer can still create a complete terminal operation from that dispatched tool-call data.

**Data flow**: It creates a trace with a `write_stdin` tool invocation containing a session ID, characters to send, and output limits. It then writes a tool completion event with a direct response containing `hi`. After replay, the expected result is a completed stdin terminal operation tied to terminal session `123`, with the input text, timing, output, and raw payload IDs all preserved. It also expects the tool call summary to point to the new terminal operation.

**Call relations**: This test covers the path where the tool start and end events themselves provide enough information to form the terminal operation. It uses the usual trace setup helpers, then hands the saved trace to replay. The assertions show that the reducer can build both the operation and its session even without separate runtime start and runtime end events.

*Call graph*: calls 4 internal fn (create_started_writer, generic_summary, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `code_mode_write_stdin_result_projects_structured_exec_fields`  (lines 442–521)

```
fn code_mode_write_stdin_result_projects_structured_exec_fields() -> anyhow::Result<()>
```

**Purpose**: This test makes sure that a stdin write made from code mode keeps structured result fields, not just plain text output. Code mode here means a code cell calls the tool, and the tool result comes back with fields such as exit code, token count, and chunk ID.

**Data flow**: It writes a trace with a code cell start event, a `write_stdin` tool call tied to that code cell, and a code-mode result payload containing output plus structured metadata. After replay, it checks that the terminal operation result includes the exit code, stdout text, formatted output, original token count, and chunk ID. The test succeeds only if those fields survive the reduction step.

**Call relations**: This test focuses on the special code-cell route into terminal tools. It sets up the trace, records the code cell and tool events, then replays the bundle. Its assertion is narrow on purpose: it verifies that the reducer hands structured code-mode response fields into the terminal result instead of reducing them to only a string.

*Call graph*: calls 4 internal fn (create_started_writer, generic_summary, start_turn, trace_context); 4 external calls (new, assert_eq!, replay_bundle, json!).


##### `append_inference_with_tool_call`  (lines 523–558)

```
fn append_inference_with_tool_call(writer: &TraceWriter) -> anyhow::Result<()>
```

**Purpose**: This helper writes a realistic model inference that asks to run an `exec_command`. It exists so the main command-execution test can include the model-facing side of the story without repeating bulky setup code.

**Data flow**: It receives a trace writer. It writes an inference request payload containing a user message, appends an inference-started event, then writes an inference response payload containing a function call for `exec_command` with the command `cargo test`. Finally, it appends an inference-completed event. The trace is changed by adding those payloads and events; the function returns success or an error if writing fails.

**Call relations**: This helper is called by `exec_tool_reduces_to_terminal_operation_and_session` before the raw tool-call events are written. It supplies the model response item that later gets linked to the terminal operation as something the model requested.

*Call graph*: calls 2 internal fn (append, write_json_payload); called by 1 (exec_tool_reduces_to_terminal_operation_and_session); 1 external calls (json!).


##### `append_followup_with_tool_output`  (lines 560–581)

```
fn append_followup_with_tool_output(writer: &TraceWriter) -> anyhow::Result<()>
```

**Purpose**: This helper writes the later model inference request that includes the output from the tool call. It lets the main test check that the reducer connects terminal output back to what the model received next.

**Data flow**: It receives a trace writer. It writes an inference request payload that refers to the previous response and includes a `function_call_output` item for call ID `call-1` with output `ok`. It then appends an inference-started event for the second turn. The trace gains that payload and event, and the function returns success or a writing error.

**Call relations**: This helper is called near the end of `exec_tool_reduces_to_terminal_operation_and_session`, after the command has run and produced output. Its event gives the reducer a follow-up model input item, which the test expects to appear as a model observation on the terminal operation.

*Call graph*: calls 2 internal fn (append, write_json_payload); called by 1 (exec_tool_reduces_to_terminal_operation_and_session); 1 external calls (json!).


### Trace protocol and thread recording
These tests validate protocol-event mapping and then exercise the thread-scoped tracing API that emits replayable bundles.

### `rollout-trace/src/protocol_event_tests.rs`

`test` · `test run`

This is a small test file focused on one important promise: when the system hears that a sub-agent did something, that message should appear in the tool runtime trace as a finished event. A sub-agent is a helper agent working under the main agent, like a reviewer or specialist. The trace is the record of what happened, similar to a receipt after a task is run.

The test builds a realistic protocol event saying that a sub-agent at `/root/reviewer` has started. It includes an event id, a timestamp, the sub-agent thread id, the path that identifies the agent, and the activity kind. Then it passes that event into `tool_runtime_trace_event`, the conversion function from the surrounding rollout trace code.

The important behavior being checked is slightly surprising: a `Started` sub-agent activity becomes a terminal, or finished, tool runtime event with `ExecutionStatus::Completed`. The test also checks that the payload keeps the original event details and serializes them with the expected field names and values. Without this test, a future change could accidentally drop fields, change naming, or stop treating sub-agent activity as a completed trace event, making rollout traces misleading or harder to inspect.

#### Function details

##### `sub_agent_activity_is_a_terminal_tool_runtime_event`  (lines 14–46)

```
fn sub_agent_activity_is_a_terminal_tool_runtime_event() -> anyhow::Result<()>
```

**Purpose**: This test proves that a `SubAgentActivity` protocol message is converted into a completed tool runtime trace event. It also checks that the converted event keeps the expected id, status, and JSON payload.

**Data flow**: The test starts by creating a fresh thread id and a protocol event for a sub-agent at `/root/reviewer`. It feeds that event into `tool_runtime_trace_event`. The expected result is an `Ended` trace event with tool call id `call-spawn`, status `Completed`, and a payload that matches the original sub-agent activity data when turned into JSON. If the conversion does not produce that shape, the test fails.

**Call relations**: During the test, helper constructors create the thread id and agent path, then the protocol event is wrapped as a `SubAgentActivity`. The test calls `tool_runtime_trace_event` because that is the production conversion path it wants to verify. After conversion, assertion helpers compare the returned fields and serialized payload against the expected values; if the conversion is not terminal as expected, the test immediately panics to make the failure clear.

*Call graph*: calls 2 internal fn (try_from, new); 4 external calls (assert_eq!, panic!, SubAgentActivity, tool_runtime_trace_event).


### `rollout-trace/src/thread_tests.rs`

`test` · `test suite`

This is a test file for the rollout tracing feature. A rollout trace is a written record of what happened during an agent run, similar to a flight recorder: it lets the system later replay or inspect the run. These tests create temporary folders, start fake root and child thread traces, write events, then read the trace bundle back to make sure the recorded story is correct.

The tests cover four important promises. First, starting and ending a root thread should create a replayable bundle with the correct thread ID, agent path, status, and raw event payloads. Second, when a child thread is spawned, its trace should be appended to the same root bundle rather than creating a separate unrelated bundle. Third, a disabled trace context should accept all the same tracing calls without writing files or running unnecessary setup work. This matters because callers should not need special-case checks everywhere just because tracing is off. Fourth, selected protocol events, such as shutdown completion, should be captured as raw payloads in the trace log.

The helper functions keep the tests readable: one builds a small default metadata object for a thread start, and one finds the single bundle directory created during a test.

#### Function details

##### `create_in_root_writes_replayable_lifecycle_events`  (lines 24–56)

```
fn create_in_root_writes_replayable_lifecycle_events() -> anyhow::Result<()>
```

**Purpose**: This test checks the basic root-thread tracing path. It proves that starting a root trace, ending it, and replaying the saved bundle produces the expected lifecycle information.

**Data flow**: It starts with a fresh temporary folder and a new thread ID. It creates a root trace with full startup metadata, records that the rollout completed, finds the one bundle directory that was written, and replays it. The result should say the rollout completed, should point to the same root thread ID and agent path, and should contain the expected raw payload.

**Call relations**: This test uses ThreadTraceContext::start_root_in_root_for_test to create the trace bundle, then uses single_bundle_dir to locate the bundle and replay_bundle to read it back. The assertions compare the replayed view against the original inputs, tying the write side and replay side together.

*Call graph*: calls 3 internal fn (new, start_root_in_root_for_test, single_bundle_dir); 5 external calls (from, new, assert_eq!, replay_bundle, format!).


##### `spawned_thread_start_appends_to_root_bundle`  (lines 59–110)

```
fn spawned_thread_start_appends_to_root_bundle() -> anyhow::Result<()>
```

**Purpose**: This test checks that a spawned child thread becomes part of the existing root trace bundle. It guards against a bug where child work might be written into a separate bundle and become disconnected from the main rollout story.

**Data flow**: It creates a temporary folder, a root thread ID, and a child thread ID. It starts a root trace using minimal metadata, then starts a child trace with details such as its agent path, nickname, role, parent thread ID, and working directory. After marking the child completed, it replays the single bundle and checks that there is still only one bundle on disk, that both threads appear in it, and that the child thread has the right path and completed execution status.

**Call relations**: The test calls minimal_metadata to avoid repeating root-thread setup details, then calls start_root_in_root_for_test for the parent and start_child_thread_trace_or_disabled for the child. It uses single_bundle_dir and replay_bundle to inspect what was written, showing that child thread tracing joins the parent bundle instead of branching into a new file tree.

*Call graph*: calls 5 internal fn (try_from, new, start_root_in_root_for_test, minimal_metadata, single_bundle_dir); 6 external calls (from, new, SubAgent, assert_eq!, replay_bundle, format!).


##### `disabled_thread_context_accepts_trace_calls_without_writing`  (lines 113–165)

```
fn disabled_thread_context_accepts_trace_calls_without_writing() -> anyhow::Result<()>
```

**Purpose**: This test checks that a disabled trace context is safe to use like a normal trace context. Code can call tracing methods without first asking whether tracing is enabled, and nothing should be written.

**Data flow**: It creates a temporary folder and a disabled ThreadTraceContext. It sends many kinds of trace calls into it: rollout end, protocol event, turn event, tool call event, agent result, inference attempt, compaction attempt, and tool dispatch setup. The disabled context absorbs those calls, avoids invoking the lazy dispatch-building closure, reports that dispatch tracing is disabled, and leaves the temporary folder empty.

**Call relations**: This test exercises many tracing entry points in their disabled mode. It does not hand off to replay_bundle because there should be no bundle to replay. Its main relationship to the rest of the tracing system is to prove that callers can use the same API in enabled and disabled cases without littering the code with checks.

*Call graph*: calls 2 internal fn (new, disabled); 6 external calls (new, new, assert!, assert_eq!, Completed, json!).


##### `protocol_wrapper_records_selected_events_as_raw_payloads`  (lines 168–190)

```
fn protocol_wrapper_records_selected_events_as_raw_payloads() -> anyhow::Result<()>
```

**Purpose**: This test checks that selected protocol events are copied into the raw trace log. In this case, it verifies that a shutdown-complete event is visible as a raw payload.

**Data flow**: It creates a temporary folder and a new thread ID, starts a root trace with minimal metadata, and records a ShutdownComplete protocol event. Then it reads the trace.jsonl file from the created bundle, parses each line as a raw trace event, and looks for a protocol-event payload whose event type is shutdown_complete. The test passes only if that payload is found.

**Call relations**: This test uses minimal_metadata to start the root trace and single_bundle_dir to locate the written bundle. Unlike the replay-focused tests, it reads the trace log file directly so it can verify the exact raw event payload that was written.

*Call graph*: calls 4 internal fn (new, start_root_in_root_for_test, minimal_metadata, single_bundle_dir); 3 external calls (new, assert!, read_to_string).


##### `minimal_metadata`  (lines 192–207)

```
fn minimal_metadata(thread_id: ThreadId) -> ThreadStartedTraceMetadata
```

**Purpose**: This helper builds a small, standard ThreadStartedTraceMetadata value for tests that do not care about every startup detail. It keeps the test cases focused on the behavior being checked rather than repeating setup fields.

**Data flow**: It takes a ThreadId as input and turns it into the string form used in trace metadata. It fills in a root agent path, default working directory, test model and provider names, approval and sandbox settings, and leaves optional fields such as task name, nickname, role, and rollout path empty. The output is a ready-to-use metadata object for starting a root trace.

**Call relations**: spawned_thread_start_appends_to_root_bundle and protocol_wrapper_records_selected_events_as_raw_payloads call this helper before starting their root traces. It feeds ThreadTraceContext::start_root_in_root_for_test with consistent default data so those tests can concentrate on child-thread appending and protocol-event recording.

*Call graph*: called by 2 (protocol_wrapper_records_selected_events_as_raw_payloads, spawned_thread_start_appends_to_root_bundle); 2 external calls (from, to_string).


##### `single_bundle_dir`  (lines 209–216)

```
fn single_bundle_dir(root: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: This helper finds the one trace bundle directory that a test expects to have been created. It also checks that there is exactly one, which catches accidental extra bundle creation.

**Data flow**: It receives the temporary root folder path. It reads all entries in that folder, converts them to paths, sorts them for stable behavior, and asserts that there is exactly one entry. It then returns that single path as the bundle directory.

**Call relations**: The replay and file-reading tests call this helper after tracing has written output. It hands the bundle path to replay_bundle in the lifecycle tests and to direct file reading in the protocol-event test, making it the bridge between temporary test storage and trace inspection.

*Call graph*: called by 3 (create_in_root_writes_replayable_lifecycle_events, protocol_wrapper_records_selected_events_as_raw_payloads, spawned_thread_start_appends_to_root_bundle); 2 external calls (assert_eq!, read_dir).


### Runtime and persistence support
Runtime-state helpers underpin tests for external-agent config import persistence and database recovery behavior.

### `state/src/runtime/test_support.rs`

`test` · `test setup`

Tests often need two things: a place to write temporary files without colliding with other tests, and realistic sample data that does not change from run to run. This file supplies both.

The first helper, `unique_temp_dir`, builds a path inside the operating system's temporary directory. It mixes the current time with a random identifier, so two tests are very unlikely to choose the same folder. It is like giving each test its own labeled scratch pad instead of making many tests write on the same sheet of paper.

The second helper, `test_thread_metadata`, creates a complete `ThreadMetadata` value. In this project, thread metadata is the saved summary information about a conversation or work thread: its id, where its rollout log lives, when it was created, what model it used, its working directory, approval and sandbox settings, and other searchable details. The function fills these fields with stable test values, including a fixed timestamp, so tests can compare results reliably.

Everything in this file is guarded with `#[cfg(test)]`, which means it is compiled only when running tests. It is not part of the normal application build.

#### Function details

##### `unique_temp_dir`  (lines 28–36)

```
fn unique_temp_dir() -> PathBuf
```

**Purpose**: Creates a unique-looking temporary directory path for a test to use. This helps tests avoid stepping on each other's files when they run at the same time or leave data behind.

**Data flow**: It reads the current system time and generates a new random UUID, which is a long random identifier. It combines those pieces into a folder name under the system temporary directory, then returns that path. It does not create the directory itself; it only chooses the path.

**Call relations**: Many runtime tests call this at the start when they need an isolated place to store test state, rollout files, or database data. Those tests then use the returned path as their private workspace while checking behavior such as backfill progress, history reading, job completion, and import recording.

*Call graph*: called by 98 (report_agent_job_item_result_completes_item_atomically, report_agent_job_item_result_rejects_late_reports, backfill_claim_is_singleton_until_stale_and_blocked_when_complete, backfill_state_persists_progress_and_completion, get_backfill_state_repairs_a_missing_singleton_row, get_backfill_state_succeeds_while_another_connection_holds_writer_slot, reads_all_history_records, records_completion_by_import_id, test_runtime, init_configures_logs_db_with_incremental_auto_vacuum (+15 more)); 3 external calls (now, format!, temp_dir).


##### `test_thread_metadata`  (lines 39–71)

```
fn test_thread_metadata(
    codex_home: &Path,
    thread_id: ThreadId,
    cwd: PathBuf,
) -> ThreadMetadata
```

**Purpose**: Builds a complete, realistic `ThreadMetadata` record for tests. It saves each test from manually filling many fields and keeps the sample thread data consistent.

**Data flow**: It receives the test Codex home path, a thread id, and the thread's current working directory. It creates a fixed timestamp, builds a rollout log path from the home path and thread id, fills in model, sandbox, approval, preview, and other metadata fields, and returns the finished `ThreadMetadata` value. Nothing is written to disk by this function; it only constructs the data in memory.

**Call relations**: Tests call this when they need to insert or compare thread metadata in the state runtime. Inside the helper, sandbox and approval enum values are converted into their stored string form, so the returned record looks like data the real system would save. This supports tests for job claiming, thread deletion, memory cleanup, startup scanning, and related state behavior.

*Call graph*: calls 1 internal fn (enum_to_string); called by 50 (upsert_test_thread, claim_stage1_jobs_bounds_state_scan_before_memory_probes, claim_stage1_jobs_enforces_global_running_cap, claim_stage1_jobs_filters_by_age_idle_and_current_thread, claim_stage1_jobs_processes_two_full_batches_across_startup_passes, claim_stage1_jobs_skips_threads_with_disabled_memory_mode, clear_memory_data_clears_rows_and_preserves_thread_memory_modes, delete_thread_removes_stage1_output_and_enqueues_phase2_when_selected, get_phase2_input_selection_excludes_polluted_previous_selection, get_phase2_input_selection_excludes_stale_used_memories_but_keeps_fresh_never_used (+15 more)); 5 external calls (from_timestamp, join, new, new_read_only_policy, format!).


### `state/src/runtime/external_agent_config_imports_tests.rs`

`test` · `test run`

This is a test file for the part of the system that records configuration imported from an outside agent or tool. Think of it like checking a receipt book: when an import finishes, the runtime should write down what succeeded, what failed, and when it happened. Later, the system should be able to find the receipt for one specific import or list all receipts.

Each test creates a fresh temporary runtime storage area, so it starts with a clean slate and does not depend on files left behind by other tests. The first test records the same import ID twice. The important behavior is that the later completion record replaces or updates the stored details for that same ID, rather than leaving two conflicting versions. It then checks that the details and history contain the final expected successes, failures, and a real completion timestamp.

The second test records two different import IDs and confirms that the history reader returns both of them. Together, these tests protect the bookkeeping behavior that other parts of the application rely on when showing users what configuration imports have already happened.

#### Function details

##### `records_completion_by_import_id`  (lines 6–119)

```
async fn records_completion_by_import_id() -> anyhow::Result<()>
```

**Purpose**: This test proves that a completed external-agent configuration import is stored under its import ID, and that recording the same ID again leaves the runtime with the final expected details. It also checks that the import appears in the history list with a completion time.

**Data flow**: It starts by creating a fresh temporary state runtime. It writes one completion record for import-1, then writes another completion record for the same import ID with a larger set of successes and one failure. It then reads the stored details and the history back out, comparing them with the expected records; the result is success if the runtime returns the final details and a nonzero completion timestamp, or a test failure if it does not.

**Call relations**: During the test, it asks the runtime initializer to create an isolated runtime using a temporary directory from the test helper. After exercising the runtime's import-recording and reading methods, it uses equality assertions to confirm the runtime saved and returned the information exactly as expected.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 1 external calls (assert_eq!).


##### `reads_all_history_records`  (lines 122–145)

```
async fn reads_all_history_records() -> anyhow::Result<()>
```

**Purpose**: This test proves that the runtime can return more than one completed import record from its history. It is focused on making sure separate import IDs are both preserved.

**Data flow**: It creates a new temporary runtime, records two completed imports named import-1 and import-2, then asks for the full import history. Because history order may not be meaningful, it sorts the records by import ID before comparing only the IDs with the expected two-item list. The test passes if both IDs are present.

**Call relations**: Like the other test in this file, it begins by creating isolated runtime storage through the runtime initializer and temporary-directory helper. It then calls the runtime's history-reading path and finishes by using an equality assertion to verify that both recorded imports came back.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 1 external calls (assert_eq!).


### `state/src/runtime/recovery_tests.rs`

`test` · `test run`

This is a test file for the part of the system that recovers from SQLite database trouble. SQLite is a small database stored in ordinary files. If one of those files is corrupt, locked, or blocked by a wrongly placed file, the runtime needs to avoid crashing forever and needs to preserve the bad files for later inspection.

The tests create temporary folders, write fake database files, and then call the recovery helpers as if startup had found a problem. They check that only the files belonging to the failed database are moved into a backup folder, while unrelated runtime database files stay where they are. They also check a tricky case where the expected SQLite home path is not a folder at all but a normal file; the recovery code should move that obstacle aside and create the folder it needs.

The rest of the file checks error interpretation. It verifies that familiar SQLite messages such as “file is not a database” are treated as corruption, while “database is locked” and “database is busy” are treated as lock problems. Finally, it confirms that the system can find the actual failed database path from a real initialization error, and that it does not get fooled just because a folder name contains the word “corrupt.”

#### Function details

##### `backup_moves_only_requested_runtime_db_files_to_backup_folder`  (lines 6–41)

```
async fn backup_moves_only_requested_runtime_db_files_to_backup_folder() -> std::io::Result<()>
```

**Purpose**: This test proves that recovery backs up only the SQLite files for the database that failed. It protects against accidentally moving healthy database files when only one database needs a fresh start.

**Data flow**: It starts with a new temporary SQLite folder, creates all expected runtime database sidecar files, and then chooses the logs database as the simulated failed database. After calling the backup helper, it checks three outcomes: the failed database files are gone from their old location, other database files are still present, and every reported backup file exists inside the backup folder.

**Call relations**: During the test, it asks the test support code for a unique temporary directory, uses the runtime path helpers to discover the database file names, writes placeholder files to disk, and then exercises the recovery backup flow. The assertions tell the story of what the backup helper must guarantee before startup can safely continue.

*Call graph*: calls 1 internal fn (unique_temp_dir); 7 external calls (new, assert!, assert_eq!, logs_db_path, runtime_db_paths, create_dir_all, write).


##### `backup_replaces_blocking_sqlite_home_file`  (lines 44–64)

```
async fn backup_replaces_blocking_sqlite_home_file() -> std::io::Result<()>
```

**Purpose**: This test checks recovery when the place that should be the SQLite directory is blocked by a regular file. The system must move that file out of the way and create the needed directory instead.

**Data flow**: It creates a temporary parent folder, writes a plain file where the SQLite home directory should be, and then asks recovery to prepare a fresh start for the state database under that path. The result should be one backup record, the old blocking file should now be saved under a backup-style name, and the original SQLite home path should have become a real directory.

**Call relations**: The test uses the temporary-directory helper and the state database path helper to build a realistic startup path. It then calls the backup recovery helper and verifies that recovery can repair this filesystem shape before normal database initialization tries to use it.

*Call graph*: calls 1 internal fn (unique_temp_dir); 5 external calls (assert!, assert_eq!, state_db_path, create_dir_all, write).


##### `sqlite_error_detail_classifies_corruption_and_lock_errors`  (lines 67–75)

```
fn sqlite_error_detail_classifies_corruption_and_lock_errors()
```

**Purpose**: This test checks the small pieces of logic that read SQLite error text and decide what kind of problem it describes. That classification matters because corruption and locking need different recovery behavior.

**Data flow**: It feeds several human-readable error messages into the corruption and lock classifiers. Messages like “file is not a database” and “database disk image is malformed” should come out as corruption, while “database is locked” and “database is busy” should come out as lock-related trouble.

**Call relations**: This test directly exercises the error-classification helpers. It does not set up files or start the runtime; it focuses on the decision point that later recovery code relies on when choosing what to do after SQLite reports a failure.

*Call graph*: 1 external calls (assert!).


##### `runtime_db_path_for_corruption_error_returns_failed_database_path`  (lines 78–92)

```
async fn runtime_db_path_for_corruption_error_returns_failed_database_path() -> std::io::Result<()>
```

**Purpose**: This test confirms that when startup fails because a database file is actually malformed, the recovery code can identify which database file caused the failure. That path is needed so only the right files are backed up.

**Data flow**: It creates a temporary SQLite home, writes invalid bytes into the state database file, and then tries to initialize the runtime. Initialization should fail; the test passes that error into the path-finding helper and expects to get back the exact state database path that was corrupted.

**Call relations**: This test goes through the real runtime initialization path rather than only testing a small helper in isolation. It creates the bad file using the state database path helper, calls `StateRuntime::init`, captures the resulting error, and then verifies that the recovery path extractor can read the failure correctly.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 5 external calls (assert_eq!, panic!, state_db_path, create_dir_all, write).


##### `runtime_db_path_for_corruption_error_ignores_corrupt_word_in_path`  (lines 95–105)

```
fn runtime_db_path_for_corruption_error_ignores_corrupt_word_in_path()
```

**Purpose**: This test guards against a false alarm: a path containing the word “corrupt” should not by itself be treated as a corruption error. Only the actual database error details should drive recovery.

**Data flow**: It builds an artificial runtime database initialization error for a path like `/tmp/sqlite_corrupt/state_5.sqlite`, but the underlying cause is “permission denied,” not database corruption. When the error is inspected, the result should be no failed database path.

**Call relations**: The test constructs a `RuntimeDbInitError` by hand and wraps it in a general error value. It then calls the corruption-path detector to make sure that detector reads the real error cause instead of guessing from words in the file path.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, anyhow!, assert_eq!, new).


### Memories pipeline and storage
These files cover memory prompt rendering, citation parsing, startup orchestration, workspace diffs, pruning, and on-disk storage synchronization.

### `ext/memories/src/prompts_tests.rs`

`test` · `test run`

This is a focused automated test for the memory prompt builder. The memory feature keeps a short written summary in a file called `memory_summary.md`, then builds instructions that can be given to the model. Those instructions need to do two things at once: include the summary text directly, and clearly say that this file has already been provided so it should not be opened again.

The test creates a temporary fake Codex home folder, like setting up a small pretend workspace in a disposable box. Inside it, it creates a `memories` folder and writes a sample `memory_summary.md` file. It then calls the real prompt-building function, `build_memory_tool_developer_instructions`, and checks the resulting text.

The checks look for three important promises: the instructions name the summary file path, they say the file is already provided and should not be opened again, and they contain the actual summary text. The test also confirms that the marker showing where the embedded memory summary begins appears exactly once. Without this test, a prompt template change could quietly break memory injection, duplicate the summary block, or cause the model to waste time reading a file it already has.

#### Function details

##### `build_memory_tool_developer_instructions_renders_embedded_template`  (lines 8–35)

```
async fn build_memory_tool_developer_instructions_renders_embedded_template()
```

**Purpose**: This test proves that the memory instruction builder correctly renders its embedded template when a memory summary file exists. It checks both the human-facing text and the included summary content.

**Data flow**: It starts with an empty temporary folder, turns that folder into an absolute Codex home path, then creates a `memories/memory_summary.md` file containing test text. It passes the fake Codex home path into `build_memory_tool_developer_instructions`, receives the generated instruction string, and verifies that the string contains the expected file note, the saved summary, and exactly one start marker for the embedded summary block.

**Call relations**: During the test, it uses temporary-directory and file-writing helpers to build a safe throwaway environment. Once that setup is ready, it calls the real instruction-building code under test. The assertions at the end act like a checklist, confirming that the generated prompt has the pieces other parts of the memory system rely on.

*Call graph*: calls 1 internal fn (from_absolute_path); 5 external calls (assert!, assert_eq!, tempdir, create_dir_all, write).


### `memories/read/src/citations_tests.rs`

`test` · `test run`

Memory citations are small text blocks that point back to memory files, line ranges, notes, and conversation identifiers. This test file checks that the parser understands the shapes of citation text that the system may encounter in real use. That matters because memory citations are evidence trails: if they are parsed incorrectly, the system may lose track of where a remembered fact came from or which conversation produced it.

The tests build example citation strings by hand, like filling out sample forms. They then pass those strings to `parse_memory_citation`, which is the parser being tested. After parsing, the tests compare the result with what should have been found.

There are three main cases. One checks an older format that used a `<thread_ids>` section and confirms that valid thread IDs are kept while invalid text is ignored. Another checks the newer `<rollout_ids>` section. The last checks a fuller citation containing file references, line numbers, notes, and repeated rollout IDs; it confirms entries are extracted cleanly and duplicate rollout IDs are removed. Together, these tests make sure old citation data keeps working while newer citation data is also supported.

#### Function details

##### `parse_memory_citation_supports_legacy_thread_ids`  (lines 7–21)

```
fn parse_memory_citation_supports_legacy_thread_ids()
```

**Purpose**: This test makes sure the parser still understands the older citation format that stores conversation identifiers inside a `<thread_ids>` section. It also checks that bad identifier text does not sneak into the final result.

**Data flow**: The test starts by creating two valid `ThreadId` values, which are unique conversation identifiers. It builds one citation string containing those two valid IDs plus the invalid text `not-a-uuid`, sends that string into `parse_memory_citation`, and then asks `thread_ids_from_memory_citation` for the IDs found in the parsed result. The expected output is only the two valid IDs, in order.

**Call relations**: During the test, fresh IDs are made with `ThreadId::new`, then the citation text is handed to the real parser through `parse_memory_citation`. The final assertion compares the parser's cleaned-up result with the expected list, so this test acts as a safety check for backward compatibility with legacy memory citations.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, parse_memory_citation, vec!).


##### `parse_memory_citation_supports_rollout_ids`  (lines 24–34)

```
fn parse_memory_citation_supports_rollout_ids()
```

**Purpose**: This test checks that the parser recognizes the newer citation format that stores conversation identifiers under `<rollout_ids>`. It confirms that a rollout ID can be recovered as a normal thread ID when later code asks for thread IDs.

**Data flow**: The test creates one valid `ThreadId`, places it inside a citation string with a `<rollout_ids>` section, and parses that string. It then extracts thread IDs from the parsed citation and expects to get back exactly the one ID it put in.

**Call relations**: This test uses `ThreadId::new` to make realistic input, calls `parse_memory_citation` to exercise the parser, and uses an equality assertion to verify the parser's output. It connects the newer rollout-ID storage format to the helper that other code uses when it wants conversation IDs from a citation.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, parse_memory_citation, vec!).


##### `parse_memory_citation_extracts_entries_and_rollout_ids`  (lines 37–71)

```
fn parse_memory_citation_extracts_entries_and_rollout_ids()
```

**Purpose**: This test checks the parser's full behavior on a citation that contains both file references and rollout IDs. It verifies that citation entries are split into path, line range, and note, and that repeated rollout IDs are not kept twice.

**Data flow**: The test creates two valid thread IDs and builds a citation string with two file entries plus three rollout ID lines, where the first ID appears twice. After parsing, it reads the parsed entries and turns them into simple tuples containing path, start line, end line, and note. It expects two clean citation entries and a rollout ID list containing only the first ID and second ID once each.

**Call relations**: This is the broadest test in the file. It creates sample IDs with `ThreadId::new`, sends a realistic mixed citation block through `parse_memory_citation`, and then uses assertions to check both halves of the result: the human-readable file citations and the conversation identifiers used for tracing memory back to its source.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, parse_memory_citation, vec!).


### `memories/write/src/extensions/prune_tests.rs`

`test` · `test run`

This is a test file for the memory extension cleanup feature. The feature it checks is like cleaning out an old filing cabinet: remove papers that are too old, but only from drawers that are officially part of the system, and do not throw away papers whose dates cannot be understood.

The main test builds a temporary fake memory folder on disk. Inside it, it creates one extension called "chronicle" with an instructions file and a resources folder. That instructions file matters because it marks the folder as a real extension that should be considered for cleanup. The test then writes several resource files with dates in their names: one older than the allowed age, one exactly at the cutoff, one newer than the cutoff, and one with no usable timestamp. It also creates a second extension-like folder without instructions, to prove that cleanup ignores it.

After running the pruning function with a fixed pretend current time, the test checks the results. The old and cutoff files are gone. The recent file remains. The badly named file remains because its age cannot be known. The file in the ignored folder remains because that folder is not treated as an active extension.

A second smaller test checks that the timestamp-reading helper correctly pulls a date from the start of a resource filename and rejects filenames that do not start with a valid timestamp.

#### Function details

##### `prunes_only_old_resources_from_extensions_with_instructions`  (lines 7–76)

```
async fn prunes_only_old_resources_from_extensions_with_instructions()
```

**Purpose**: This asynchronous test proves that extension resource pruning deletes only the files it is supposed to delete. It checks the important safety rule that cleanup should not remove recent files, unparseable files, or files from folders that are not valid instructed extensions.

**Data flow**: The test starts with an empty temporary directory. It builds a fake memory-extension folder structure, writes instruction and resource files into it, and chooses a fixed current time so the age calculation is predictable. It then runs the pruning operation. Afterward, it reads the filesystem state and confirms that only the old and exactly-at-cutoff resource files in the instructed extension were removed, while the recent, invalid-name, and ignored-extension files still exist.

**Call relations**: The async test runner calls this function during the test suite. Inside the test, it uses temporary-directory creation, path-building for the extensions root, asynchronous folder and file writes, and timestamp parsing to set up a realistic on-disk scenario. It then exercises the pruning behavior and uses assertions to verify the cleanup result.

*Call graph*: 7 external calls (from_naive_utc_and_offset, parse_from_str, new, assert!, memory_extensions_root, create_dir_all, write).


##### `parses_timestamp_prefix_from_resource_file_name`  (lines 79–85)

```
fn parses_timestamp_prefix_from_resource_file_name()
```

**Purpose**: This test checks the small rule that resource filenames begin with a timestamp that can be read back as a date and time. It also confirms that a filename without a valid timestamp is safely rejected instead of being treated as dated.

**Data flow**: The test gives the timestamp parser a filename that starts with a valid date-time string. It receives a parsed time and compares its numeric Unix timestamp to the expected value. Then it gives the parser a bad filename and checks that the parser returns no timestamp at all.

**Call relations**: The regular test runner calls this function during the test suite. It focuses on the filename-parsing helper that the pruning logic depends on, and uses equality and truth assertions to lock down the expected parsing behavior.

*Call graph*: 2 external calls (assert!, assert_eq!).


### `memories/write/src/startup_tests.rs`

`test` · `automated test runs for memory startup behavior`

The memory startup flow is meant to run quietly when Codex starts. It prepares a memory workspace on disk, looks for past conversations that should become memories, asks the model to summarize or consolidate them, and keeps the workspace clean. This test file proves that those steps happen safely and predictably.

The tests build small throwaway Codex sessions in temporary home folders. A mock response server stands in for the model API, like a practice cashier used to test a shop checkout without charging a real card. The file seeds fake thread history into the state database, starts the memory startup task, waits for background work to finish, and then checks files, prompts, request metadata, model choices, and cleanup behavior.

A few helper functions create test Codex instances, add fake stage-one memory results, wait for files or requests to appear, and shut the test session down cleanly. The mock model provider is important because it lets the tests verify which model name the memory code chooses by default, while still delegating normal provider behavior to the real provider implementation.

#### Function details

##### `memories_startup_creates_memory_root`  (lines 50–62)

```
async fn memories_startup_creates_memory_root() -> anyhow::Result<()>
```

**Purpose**: Checks that starting the memory startup task creates the main memories folder. Without this, later memory files would have nowhere reliable to live.

**Data flow**: It creates a fake model server and a temporary home folder, confirms the memories folder does not exist, starts memory startup, then waits until that folder appears. It finishes by shutting down the test Codex session.

**Call relations**: The test runner calls this test. It builds a test Codex instance, uses trigger_memories_startup to launch the background memory task, uses wait_for_dir to observe the expected folder, and uses shutdown_test_codex for cleanup.

*Call graph*: calls 5 internal fn (start_mock_server, build_test_codex, shutdown_test_codex, trigger_memories_startup, wait_for_dir); 3 external calls (new, new, assert!).


##### `memories_startup_phase2_tracks_workspace_diff_across_runs`  (lines 65–150)

```
async fn memories_startup_phase2_tracks_workspace_diff_across_runs() -> anyhow::Result<()>
```

**Purpose**: Verifies that phase two consolidation notices changes in the memory workspace across runs and only keeps the newer memory output. This protects against stale summaries being carried forward forever.

**Data flow**: It creates an old stage-one memory result, writes matching memory files, records a clean git baseline, then adds a newer stage-one result. After startup runs phase two, it reads the model prompt and memory files to confirm the workspace diff was included and the old raw memory and summary were replaced by the newer ones.

**Call relations**: The test runner calls this test. It relies on init_state_db and seed_stage1_output to prepare database state, trigger_memories_startup to run the real startup path, phase2_prompt_text to inspect the outgoing model prompt, wait_for_phase2_workspace_reset to wait for cleanup, and read_rollout_summary_bodies to verify the final summaries.

*Call graph*: calls 12 internal fn (mount_sse_once, sse, start_mock_server, build_test_codex, init_state_db, phase2_prompt_text, read_rollout_summary_bodies, seed_stage1_output, shutdown_test_codex, trigger_memories_startup (+2 more)); 11 external calls (new, new, assert!, assert_eq!, hours, now, reset_git_repository, create_dir_all, read_to_string, write (+1 more)).


##### `memories_startup_phase2_prunes_old_extension_resources`  (lines 153–220)

```
async fn memories_startup_phase2_prunes_old_extension_resources() -> anyhow::Result<()>
```

**Purpose**: Checks that phase two deletes extension resource files that are too old while keeping recent ones. This prevents the memories area from accumulating outdated helper material.

**Data flow**: It seeds a memory job, creates one old extension resource file and one recent file, then runs startup with a fake model response. After phase two finishes, it confirms the prompt mentioned the workspace diff, the old file disappeared, and the recent file still exists.

**Call relations**: The test runner calls this test. It uses init_state_db and seed_stage1_output to make consolidation work available, trigger_memories_startup to start the flow, phase2_prompt_text to inspect the model request, wait_for_file_removed and wait_for_phase2_workspace_reset to wait for asynchronous cleanup, and shutdown_test_codex at the end.

*Call graph*: calls 12 internal fn (mount_sse_once, sse, start_mock_server, build_test_codex, init_state_db, phase2_prompt_text, seed_stage1_output, shutdown_test_codex, trigger_memories_startup, wait_for_file_removed (+2 more)); 9 external calls (new, new, assert!, hours, now, format!, create_dir_all, write, vec!).


##### `memories_startup_phase2_prunes_old_extension_resources_without_stage1_input`  (lines 223–272)

```
async fn memories_startup_phase2_prunes_old_extension_resources_without_stage1_input() -> anyhow::Result<()>
```

**Purpose**: Verifies that old extension resources are pruned even when there are no fresh stage-one memory results to consolidate. Cleanup should not depend on new memories being present.

**Data flow**: It initializes the database, enqueues a global consolidation job directly, creates an old extension resource, and starts memory startup. It checks that phase two still sends a prompt with the workspace diff and removes the old file.

**Call relations**: The test runner calls this test. It prepares state with init_state_db, starts the normal task through trigger_memories_startup, inspects the request with wait_for_single_request and phase2_prompt_text, then waits for file removal and workspace reset before calling shutdown_test_codex.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, build_test_codex, init_state_db, phase2_prompt_text, shutdown_test_codex, trigger_memories_startup, wait_for_file_removed, wait_for_phase2_workspace_reset (+1 more)); 8 external calls (new, new, assert!, now, format!, create_dir_all, write, vec!).


##### `memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata`  (lines 275–350)

```
async fn memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata() -> anyhow::Result<()>
```

**Purpose**: Checks that phase one uses the current thread's service tier setting and sends memory requests with detached metadata. Detached metadata means the request describes the workspace but does not pretend to be a normal chat turn.

**Data flow**: It starts a test Codex session, changes the thread setting to a fast service tier, waits until the live config snapshot reflects that change, builds a memory startup request context, and sends a phase-one prompt. It then reads the captured request headers to confirm the service tier was used and chat-specific IDs were omitted from the metadata.

**Call relations**: The test runner calls this test. It builds the test session with build_test_codex, waits through wait_for_service_tier, directly constructs a MemoryStartupContext, sends the stage-one prompt, captures the request with wait_for_single_request, and cleans up through shutdown_test_codex.

*Call graph*: calls 9 internal fn (default, mount_sse_once, sse, start_mock_server, new, build_test_codex, shutdown_test_codex, wait_for_service_tier, wait_for_single_request); 10 external calls (clone, new, default, new, assert!, assert_eq!, reset_git_repository, submit_thread_settings, from_str, vec!).


##### `memories_startup_phase1_provider_default_drives_request_model`  (lines 353–366)

```
async fn memories_startup_phase1_provider_default_drives_request_model() -> anyhow::Result<()>
```

**Purpose**: Verifies that phase one uses the model provider's preferred memory extraction model when the user has not set an override. This makes the default model choice come from the provider rather than a hard-coded test assumption.

**Data flow**: It creates a mock server and temporary home, runs the shared phase-one model request helper with default memory settings, then checks that the outgoing request body contains the mock provider's phase-one model name.

**Call relations**: The test runner calls this test. It delegates almost all setup and execution to run_memory_phase_one_model_request_test, using startup_test_memories_config to supply the default memory configuration.

*Call graph*: calls 3 internal fn (start_mock_server, run_memory_phase_one_model_request_test, startup_test_memories_config); 3 external calls (new, new, assert_eq!).


##### `memories_startup_phase2_provider_default_drives_request_model`  (lines 369–382)

```
async fn memories_startup_phase2_provider_default_drives_request_model() -> anyhow::Result<()>
```

**Purpose**: Verifies that phase two uses the model provider's preferred memory consolidation model when no override is configured.

**Data flow**: It creates a mock server and temporary home, runs the shared phase-two model request helper with default memory settings, then checks that the captured request body uses the mock provider's phase-two model name.

**Call relations**: The test runner calls this test. It relies on run_memory_phase_two_model_request_test to seed input, run phase two, and return the captured request.

*Call graph*: calls 3 internal fn (start_mock_server, run_memory_phase_two_model_request_test, startup_test_memories_config); 3 external calls (new, new, assert_eq!).


##### `memories_startup_phase1_explicit_model_override_drives_request_model`  (lines 385–399)

```
async fn memories_startup_phase1_explicit_model_override_drives_request_model() -> anyhow::Result<()>
```

**Purpose**: Checks that a configured phase-one model override wins over the provider default. This lets users or configuration choose a specific extraction model.

**Data flow**: It starts from the standard memory test config, sets the extraction model to an override string, runs the phase-one helper, and verifies that the model request used that override.

**Call relations**: The test runner calls this test. It uses startup_test_memories_config for the base settings and run_memory_phase_one_model_request_test for the actual memory extraction request.

*Call graph*: calls 3 internal fn (start_mock_server, run_memory_phase_one_model_request_test, startup_test_memories_config); 3 external calls (new, new, assert_eq!).


##### `memories_startup_phase2_explicit_model_override_drives_request_model`  (lines 402–416)

```
async fn memories_startup_phase2_explicit_model_override_drives_request_model() -> anyhow::Result<()>
```

**Purpose**: Checks that a configured phase-two consolidation model override wins over the provider default.

**Data flow**: It builds the standard memory config, changes the consolidation model field, runs the phase-two helper, and confirms the outgoing request body names the override model.

**Call relations**: The test runner calls this test. It uses startup_test_memories_config for setup and run_memory_phase_two_model_request_test to exercise phase two.

*Call graph*: calls 3 internal fn (start_mock_server, run_memory_phase_two_model_request_test, startup_test_memories_config); 3 external calls (new, new, assert_eq!).


##### `run_memory_phase_one_model_request_test`  (lines 418–457)

```
async fn run_memory_phase_one_model_request_test(
    server: &wiremock::MockServer,
    home: Arc<TempDir>,
    memories: MemoriesConfig,
) -> anyhow::Result<ResponsesRequest>
```

**Purpose**: Runs a reusable mini-scenario that produces one phase-one memory extraction request and returns it for inspection. Other tests use it to check which model name phase one sends.

**Data flow**: It builds a test Codex session with a supplied memory config, wraps the provider in MockMemoryModelProvider, seeds a candidate thread that should be extracted into memory, mounts a fake streaming model response, runs phase one, captures the single request, shuts down Codex, and returns that request.

**Call relations**: It is called by the phase-one provider-default and explicit-override tests. Inside, it uses build_test_codex_with_memories_config, seed_stage1_candidate, memory_startup_context_with_provider, the phase-one runner, wait_for_single_request, and shutdown_test_codex.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, new, build_test_codex_with_memories_config, memory_startup_context_with_provider, seed_stage1_candidate, shutdown_test_codex, wait_for_single_request); called by 2 (memories_startup_phase1_explicit_model_override_drives_request_model, memories_startup_phase1_provider_default_drives_request_model); 6 external calls (clone, new, hours, now, run, vec!).


##### `run_memory_phase_two_model_request_test`  (lines 459–502)

```
async fn run_memory_phase_two_model_request_test(
    server: &wiremock::MockServer,
    home: Arc<TempDir>,
    memories: MemoriesConfig,
) -> anyhow::Result<ResponsesRequest>
```

**Purpose**: Runs a reusable mini-scenario that produces one phase-two memory consolidation request and returns it for inspection. Other tests use it to check the model selected for consolidation.

**Data flow**: It builds a test Codex session, creates a mock provider, seeds a completed stage-one memory result, mounts a fake model response, prepares the memory root and extension instructions, runs phase two, captures the request, waits for the workspace to become clean again, shuts down Codex, and returns the request.

**Call relations**: It is called by the phase-two provider-default and explicit-override tests. It hands off setup to build_test_codex_with_memories_config, seed_stage1_output, memory_startup_context_with_provider, seed_extension_instructions, the phase-two runner, wait_for_single_request, and wait_for_phase2_workspace_reset.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, seed_extension_instructions, run, new, build_test_codex_with_memories_config, memory_startup_context_with_provider, seed_stage1_output, shutdown_test_codex, wait_for_phase2_workspace_reset (+1 more)); called by 2 (memories_startup_phase2_explicit_model_override_drives_request_model, memories_startup_phase2_provider_default_drives_request_model); 5 external calls (new, now, memory_root, create_dir_all, vec!).


##### `startup_test_memories_config`  (lines 504–510)

```
fn startup_test_memories_config() -> MemoriesConfig
```

**Purpose**: Provides a small memory configuration suited to fast tests. It lowers thresholds so the startup flow does useful work immediately.

**Data flow**: It starts with the default MemoriesConfig, changes the maximum raw memories for consolidation and the minimum idle time, and returns the adjusted config.

**Call relations**: It is used by build_test_codex and by the model-selection tests as the base memory settings before any test-specific override is applied.

*Call graph*: calls 1 internal fn (default); called by 5 (build_test_codex, memories_startup_phase1_explicit_model_override_drives_request_model, memories_startup_phase1_provider_default_drives_request_model, memories_startup_phase2_explicit_model_override_drives_request_model, memories_startup_phase2_provider_default_drives_request_model).


##### `build_test_codex`  (lines 512–517)

```
async fn build_test_codex(
    server: &wiremock::MockServer,
    home: Arc<TempDir>,
) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a standard test Codex session using the startup memory test configuration. This keeps the common setup in one place.

**Data flow**: It receives a mock server and temporary home folder, gets the standard memory config, and passes everything to the more flexible builder. The result is a ready-to-use TestCodex instance.

**Call relations**: It is called by tests that do not need custom memory settings. It delegates to startup_test_memories_config and build_test_codex_with_memories_config.

*Call graph*: calls 2 internal fn (build_test_codex_with_memories_config, startup_test_memories_config); called by 5 (memories_startup_creates_memory_root, memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata, memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs).


##### `build_test_codex_with_memories_config`  (lines 519–535)

```
async fn build_test_codex_with_memories_config(
    server: &wiremock::MockServer,
    home: Arc<TempDir>,
    memories: MemoriesConfig,
) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a test Codex session with a caller-supplied memory configuration and SQLite state enabled. SQLite is the local database feature used here to store thread and memory job state.

**Data flow**: It starts a TestCodex builder, attaches the temporary home, edits the config to enable the SQLite feature and install the given memory config, then builds against the mock server.

**Call relations**: It is the shared builder underneath build_test_codex and the two model-request helper scenarios.

*Call graph*: calls 1 internal fn (test_codex); called by 3 (build_test_codex, run_memory_phase_one_model_request_test, run_memory_phase_two_model_request_test).


##### `init_state_db`  (lines 537–542)

```
async fn init_state_db(home: &Arc<TempDir>) -> anyhow::Result<Arc<codex_state::StateRuntime>>
```

**Purpose**: Creates and prepares the state database used by the tests. It marks old backfill work as complete so tests focus only on the memory startup behavior they set up.

**Data flow**: It receives a temporary home folder, initializes a StateRuntime database in that location for a test provider, marks backfill complete, wraps the database in Arc so it can be shared, and returns it.

**Call relations**: It is called by tests that seed memory jobs directly before starting Codex or memory startup.

*Call graph*: calls 1 internal fn (init); called by 3 (memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs).


##### `trigger_memories_startup`  (lines 544–559)

```
async fn trigger_memories_startup(test: &TestCodex)
```

**Purpose**: Starts the real memory startup background task inside a test Codex session. It also enables the MemoryTool feature flag so the tested path is active.

**Data flow**: It reads the current config snapshot, clones the test config, turns on the memory feature, and calls start_memories_startup_task with the thread manager, auth manager, thread ID, Codex handle, config, and session source. It does not return a result because the task runs in the background.

**Call relations**: It is called by several integration-style tests after they prepare files and database state. It hands control to the production startup task being tested.

*Call graph*: called by 4 (memories_startup_creates_memory_root, memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs); 3 external calls (clone, new, start_memories_startup_task).


##### `memory_startup_context_with_provider`  (lines 561–583)

```
async fn memory_startup_context_with_provider(
    test: &TestCodex,
    provider: SharedModelProvider,
) -> (Arc<MemoryStartupContext>, Arc<codex_core::config::Config>)
```

**Purpose**: Builds a memory startup context for tests that need to inject a custom model provider. This is how the model-selection tests replace provider defaults without changing the rest of the system.

**Data flow**: It reads the current config snapshot, clones and updates the config to enable the memory feature, creates a testing MemoryStartupContext with the supplied provider, and returns both the context and shared config.

**Call relations**: It is called by the reusable phase-one and phase-two model request helpers. Those helpers then pass the returned context into the actual phase runners.

*Call graph*: calls 1 internal fn (new_for_testing); called by 2 (run_memory_phase_one_model_request_test, run_memory_phase_two_model_request_test); 2 external calls (clone, new).


##### `MockMemoryModelProvider::new`  (lines 594–598)

```
fn new(info: ModelProviderInfo, auth_manager: Option<Arc<AuthManager>>) -> Self
```

**Purpose**: Creates a mock memory model provider that overrides only the preferred memory models while delegating normal provider behavior elsewhere.

**Data flow**: It receives provider information and an optional authentication manager, creates the real provider delegate from them, stores that delegate, and returns the mock wrapper.

**Call relations**: It is called by both model request helpers before they build a memory startup context with an injected provider.

*Call graph*: called by 2 (run_memory_phase_one_model_request_test, run_memory_phase_two_model_request_test); 1 external calls (create_model_provider).


##### `MockMemoryModelProvider::info`  (lines 602–604)

```
fn info(&self) -> &ModelProviderInfo
```

**Purpose**: Returns the provider information from the underlying real provider. This keeps the mock looking like the actual provider for everything except memory model defaults.

**Data flow**: It reads the delegate provider's info and returns a borrowed reference to it. No state is changed.

**Call relations**: The model provider interface calls this when code needs provider metadata. This mock simply passes the request through to its delegate.

*Call graph*: 1 external calls (info).


##### `MockMemoryModelProvider::memory_extraction_preferred_model`  (lines 606–608)

```
fn memory_extraction_preferred_model(&self) -> &'static str
```

**Purpose**: Supplies the fake provider default model for phase-one memory extraction. Tests use this fixed value to prove phase one consults the provider default.

**Data flow**: It takes no outside data beyond the provider object and returns the constant phase-one mock model name. Nothing is changed.

**Call relations**: The phase-one runner asks the provider for this value when no explicit extraction model override is configured.


##### `MockMemoryModelProvider::memory_consolidation_preferred_model`  (lines 610–612)

```
fn memory_consolidation_preferred_model(&self) -> &'static str
```

**Purpose**: Supplies the fake provider default model for phase-two memory consolidation. Tests use this fixed value to prove phase two consults the provider default.

**Data flow**: It returns the constant phase-two mock model name and does not read or change other state.

**Call relations**: The phase-two runner asks the provider for this value when no explicit consolidation model override is configured.


##### `MockMemoryModelProvider::auth_manager`  (lines 614–616)

```
fn auth_manager(&self) -> Option<Arc<AuthManager>>
```

**Purpose**: Returns the authentication manager from the underlying provider. This keeps authentication behavior realistic in tests.

**Data flow**: It asks the delegate provider for its auth manager and returns that optional shared object. It does not modify anything.

**Call relations**: The model provider interface calls this when request code needs access to authentication support; the mock forwards the call to the real provider.

*Call graph*: 1 external calls (auth_manager).


##### `MockMemoryModelProvider::auth`  (lines 618–621)

```
fn auth(&self) -> ModelProviderFuture<'_, Option<CodexAuth>>
```

**Purpose**: Returns the current authentication information by forwarding to the real provider asynchronously. Asynchronous means the answer may arrive later without blocking the whole task.

**Data flow**: It clones the delegate provider, creates a future, awaits the delegate's auth result inside that future, and returns the eventual optional CodexAuth value.

**Call relations**: Request-building code can call this through the ModelProvider trait. The mock does not invent credentials; it hands the work to the delegate.

*Call graph*: 2 external calls (clone, pin).


##### `MockMemoryModelProvider::account_state`  (lines 623–625)

```
fn account_state(&self) -> ProviderAccountResult
```

**Purpose**: Reports account state using the underlying provider. This avoids making the mock responsible for account logic.

**Data flow**: It calls the delegate provider's account_state method and returns that result unchanged.

**Call relations**: Any code checking account availability through the provider interface can use this mock safely because it forwards to the real provider.

*Call graph*: 1 external calls (account_state).


##### `MockMemoryModelProvider::models_manager`  (lines 627–634)

```
fn models_manager(
        &self,
        codex_home: PathBuf,
        config_model_catalog: Option<ModelsResponse>,
    ) -> codex_models_manager::manager::SharedModelsManager
```

**Purpose**: Creates or returns the models manager from the underlying provider. The models manager is the component that knows about available model names and model catalog data.

**Data flow**: It receives the Codex home path and optional configured model catalog, passes both to the delegate provider, and returns the shared models manager produced there.

**Call relations**: Model-related code can call this through the provider interface. The mock forwards the work because these tests only need to override memory preferred model names.

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

**Purpose**: Adds a fake completed phase-one memory result for a new thread. This lets phase-two tests start from known memory extraction output.

**Data flow**: It creates a new thread ID, builds thread metadata with rollout path, workspace path, provider, and git branch, writes that metadata into the state database, then calls seed_stage1_output_for_existing_thread to mark the memory extraction job as succeeded. It returns the new thread ID.

**Call relations**: It is called by phase-two tests and the phase-two model helper. It prepares the database records that phase two later reads during consolidation.

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

**Purpose**: Adds a fake thread that is eligible for phase-one extraction but has not yet been extracted. This gives phase one something to process in tests.

**Data flow**: It creates a thread ID and a rollout JSONL file containing one user message, builds matching thread metadata, stores preview text, writes the thread into the database, enables memory mode for that thread, and returns the thread ID.

**Call relations**: It is called by run_memory_phase_one_model_request_test before phase one runs. Phase one then sees this seeded thread as work to extract.

*Call graph*: calls 2 internal fn (new, new); called by 1 (run_memory_phase_one_model_request_test); 9 external calls (to_rfc3339, join, format!, ResponseItem, to_string, set_thread_memory_mode, upsert_thread, write, vec!).


##### `wait_for_single_request`  (lines 712–714)

```
async fn wait_for_single_request(mock: &ResponseMock) -> ResponsesRequest
```

**Purpose**: Waits until a mock response endpoint has received one request and returns it. This is a convenience wrapper for tests that expect exactly one model call.

**Data flow**: It calls wait_for_request with an expected count of one, removes the first request from the returned list, and gives that request back to the caller.

**Call relations**: It is used by tests and helper scenarios after mounting a mock model response, so they can inspect the request sent by the memory code.

*Call graph*: calls 1 internal fn (wait_for_request); called by 6 (memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata, memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs, run_memory_phase_one_model_request_test, run_memory_phase_two_model_request_test).


##### `wait_for_file_removed`  (lines 716–729)

```
async fn wait_for_file_removed(path: &Path) -> anyhow::Result<()>
```

**Purpose**: Waits for a file to disappear, failing the test if it stays too long. This is needed because cleanup happens asynchronously, meaning in the background.

**Data flow**: It repeatedly checks whether the path still exists until either it is gone or a ten-second deadline passes. On success it returns normally; on timeout it fails with a clear message.

**Call relations**: It is called by pruning tests and by wait_for_phase2_workspace_reset to observe cleanup results after phase two runs.

*Call graph*: called by 3 (memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, wait_for_phase2_workspace_reset); 6 external calls (from_millis, from_secs, now, assert!, try_exists, sleep).


##### `wait_for_dir`  (lines 731–744)

```
async fn wait_for_dir(path: &Path) -> anyhow::Result<()>
```

**Purpose**: Waits for a directory to be created, failing the test if it does not appear soon enough.

**Data flow**: It repeatedly checks whether the path exists and is a directory until it succeeds or a ten-second deadline passes. It returns success when the directory appears.

**Call relations**: It is used by memories_startup_creates_memory_root after the startup task is triggered.

*Call graph*: called by 1 (memories_startup_creates_memory_root); 7 external calls (from_millis, from_secs, now, is_dir, assert!, try_exists, sleep).


##### `wait_for_request`  (lines 746–760)

```
async fn wait_for_request(mock: &ResponseMock, expected_count: usize) -> Vec<ResponsesRequest>
```

**Purpose**: Waits until a mock response endpoint has received at least a chosen number of requests. This gives background network work time to complete during tests.

**Data flow**: It repeatedly reads the mock's recorded requests, compares the count with the expected count, and either returns the requests or fails after the deadline.

**Call relations**: It is the lower-level polling helper used by wait_for_single_request.

*Call graph*: calls 1 internal fn (requests); called by 1 (wait_for_single_request); 5 external calls (from_millis, from_secs, now, assert!, sleep).


##### `wait_for_service_tier`  (lines 762–779)

```
async fn wait_for_service_tier(
    test: &TestCodex,
    expected_service_tier: Option<String>,
) -> anyhow::Result<codex_core::ThreadConfigSnapshot>
```

**Purpose**: Waits until the live Codex thread configuration shows the expected service tier. A service tier is a request priority or speed class, such as a fast tier.

**Data flow**: It repeatedly asks Codex for a config snapshot, checks the service_tier field, and returns the snapshot once it matches. If the setting never changes before the deadline, it returns an error.

**Call relations**: It is used by the phase-one metadata test after submitting thread settings, before building the memory request context.

*Call graph*: called by 1 (memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata); 5 external calls (from_millis, from_secs, now, ensure!, sleep).


##### `phase2_prompt_text`  (lines 781–787)

```
fn phase2_prompt_text(request: &ResponsesRequest) -> String
```

**Purpose**: Extracts the user prompt text from a captured phase-two model request. Tests use it to confirm the prompt included the memory workspace diff.

**Data flow**: It reads all user message input texts from the request, finds the one containing the phrase 'Memory workspace diff:', and returns that text. If none is found, the test fails.

**Call relations**: It is called by phase-two tests right after wait_for_single_request returns the captured model request.

*Call graph*: calls 1 internal fn (message_input_texts); called by 3 (memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs).


##### `wait_for_phase2_workspace_reset`  (lines 789–804)

```
async fn wait_for_phase2_workspace_reset(memory_root: &Path) -> anyhow::Result<()>
```

**Purpose**: Waits until phase two has removed its temporary diff file and the memory workspace has a clean git baseline. In plain terms, it checks that phase two put its workbench back in order.

**Data flow**: It first waits for phase2_workspace_diff.md to be removed. Then it repeatedly asks for the git diff since the latest initialization point and returns only when there are no remaining changes.

**Call relations**: It is called after phase-two tests and helpers run consolidation. It uses wait_for_file_removed first, then diff_since_latest_init to verify the workspace is clean.

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

**Purpose**: Marks a specific existing thread's phase-one memory job as successfully completed. This is the lower-level helper that writes the fake raw memory and rollout summary into the state database.

**Data flow**: It creates a temporary owner ID, asks the database to claim the stage-one job for the thread, extracts the ownership token from a successful claim, then marks the job as succeeded with raw memory, rollout summary, and optional rollout slug. It asserts that this success enqueues global consolidation.

**Call relations**: It is called only by seed_stage1_output after that function creates and stores thread metadata.

*Call graph*: calls 2 internal fn (new, memories); called by 1 (seed_stage1_output); 2 external calls (assert!, panic!).


##### `read_rollout_summary_bodies`  (lines 844–852)

```
async fn read_rollout_summary_bodies(memory_root: &Path) -> anyhow::Result<Vec<String>>
```

**Purpose**: Reads all rollout summary files from the memory workspace and returns their text. This lets tests check the final consolidated summaries without caring about exact file order.

**Data flow**: It opens the rollout_summaries directory, reads each file's contents into a list, sorts the list, and returns it.

**Call relations**: It is used by the workspace-diff phase-two test after consolidation, so the test can verify old summaries were removed and the new one remains.

*Call graph*: called by 1 (memories_startup_phase2_tracks_workspace_diff_across_runs); 4 external calls (join, new, read_dir, read_to_string).


##### `shutdown_test_codex`  (lines 854–858)

```
async fn shutdown_test_codex(test: &TestCodex) -> anyhow::Result<()>
```

**Purpose**: Shuts down a test Codex session and waits until shutdown is confirmed. This prevents background tasks from leaking into later tests.

**Data flow**: It submits a shutdown operation to Codex, waits for a ShutdownComplete event, and then returns success.

**Call relations**: Most tests and reusable helpers call this at the end of their scenario to cleanly stop the Codex instance they created.

*Call graph*: called by 7 (memories_startup_creates_memory_root, memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata, memories_startup_phase2_prunes_old_extension_resources, memories_startup_phase2_prunes_old_extension_resources_without_stage1_input, memories_startup_phase2_tracks_workspace_diff_across_runs, run_memory_phase_one_model_request_test, run_memory_phase_two_model_request_test); 1 external calls (wait_for_event).


### `memories/write/src/storage_tests.rs`

`test` · `test run`

This is a test file for the memory-writing storage layer. The project stores two related things: short rollout summary files, and a larger raw memories file that records the original memory text plus metadata. These tests check that the two stay in sync, like making sure an index card in a filing cabinet points to the file that actually exists.

The first group of tests focuses on filename stems for rollout summaries. A rollout may have a human-friendly slug, but filenames must be safe for normal filesystems. So the tests check that missing or empty slugs fall back to a stable stem based on the thread id, timestamp, and hash, while unsafe slugs are lowercased, cleaned of awkward characters, and cut to a fixed length.

The larger async test creates a temporary memory directory, writes old-style summary files named only by thread id, then asks the storage code to sync summaries and rebuild the raw memories file from a single current memory. It verifies that stale summary files are deleted, a new canonical summary file remains, and the raw memories file mentions the memory text, thread id, working directory, rollout path, and the exact summary filename. Without tests like these, the system could leave behind old memory files or write references to files that no longer exist.

#### Function details

##### `stage1_output_with_slug`  (lines 18–30)

```
fn stage1_output_with_slug(thread_id: ThreadId, rollout_slug: Option<&str>) -> Stage1Output
```

**Purpose**: Builds a sample memory record for tests, with a chosen thread id and optional rollout slug. This keeps the filename tests focused on the slug behavior instead of repeating all the fields needed to create a memory.

**Data flow**: It takes a thread id and either a slug string or no slug. It fills in fixed timestamps, fixed text, and fixed paths, then returns a complete Stage1Output test value. The only parts that vary are the thread id and the optional slug.

**Call relations**: The filename tests call this helper when they need a realistic memory object to pass into the storage naming code. It does not drive behavior by itself; it supplies consistent test data so the assertions can compare exact expected filenames.

*Call graph*: called by 3 (rollout_summary_file_stem_sanitizes_and_truncates_slug, rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_is_empty, rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_missing); 1 external calls (from).


##### `fixed_thread_id`  (lines 32–34)

```
fn fixed_thread_id() -> ThreadId
```

**Purpose**: Returns one known thread id for tests that need deterministic output. Using the same id every time makes the expected filename stem stable.

**Data flow**: It starts with a hard-coded thread id string, converts it into the ThreadId type, and returns it. If the string were invalid, the test would fail immediately, but the string is intentionally valid.

**Call relations**: The rollout filename tests call this before building sample Stage1Output values. It feeds stable input into stage1_output_with_slug, which then feeds the filename stem checks.

*Call graph*: calls 1 internal fn (try_from); called by 3 (rollout_summary_file_stem_sanitizes_and_truncates_slug, rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_is_empty, rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_missing).


##### `rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_missing`  (lines 37–42)

```
fn rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_missing()
```

**Purpose**: Checks that a memory with no rollout slug still gets a predictable summary filename stem. This protects the fallback naming path used when there is no human-friendly name available.

**Data flow**: It gets the fixed test thread id, builds a sample memory with no slug, asks the production filename-stem function for the result, and compares that result with the known expected prefix.

**Call relations**: This test uses fixed_thread_id and stage1_output_with_slug to create controlled input. It then exercises rollout_summary_file_stem from the storage code and verifies the fallback behavior directly.

*Call graph*: calls 2 internal fn (fixed_thread_id, stage1_output_with_slug); 1 external calls (assert_eq!).


##### `rollout_summary_file_stem_sanitizes_and_truncates_slug`  (lines 45–61)

```
fn rollout_summary_file_stem_sanitizes_and_truncates_slug()
```

**Purpose**: Checks that a messy, long rollout slug is turned into a safe filename suffix. This matters because user- or system-generated names may contain spaces, symbols, slashes, or too much text for a clean filename.

**Data flow**: It builds a sample memory with an unsafe and extra-long slug. It asks the production naming function for the stem, removes the known fixed prefix, then checks that the remaining slug part is exactly 60 characters and has the expected cleaned-up text.

**Call relations**: This test starts with fixed_thread_id and stage1_output_with_slug, then hands the sample memory to rollout_summary_file_stem. It verifies the part of the storage code that cleans and shortens slugs before they become filenames.

*Call graph*: calls 2 internal fn (fixed_thread_id, stage1_output_with_slug); 3 external calls (assert_eq!, format!, rollout_summary_file_stem).


##### `rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_is_empty`  (lines 64–69)

```
fn rollout_summary_file_stem_uses_uuid_timestamp_and_hash_when_slug_is_empty()
```

**Purpose**: Checks that an empty slug is treated the same as a missing slug. This avoids creating odd filenames with a dangling separator or blank human-readable part.

**Data flow**: It creates a sample memory whose slug field exists but is an empty string. It asks the filename-stem function for the result and confirms that the result is the same stable fallback prefix used when no slug is provided.

**Call relations**: This test uses the same helpers as the other naming tests, then exercises rollout_summary_file_stem through the empty-slug case. It complements the missing-slug test by covering a subtly different input.

*Call graph*: calls 2 internal fn (fixed_thread_id, stage1_output_with_slug); 1 external calls (assert_eq!).


##### `sync_rollout_summaries_and_raw_memories_file_keeps_latest_memories_only`  (lines 72–149)

```
async fn sync_rollout_summaries_and_raw_memories_file_keeps_latest_memories_only()
```

**Purpose**: Tests that syncing memory storage removes stale rollout summary files and rebuilds the raw memories file so it points to the current canonical summary file. This guards against disk state drifting away from the latest memory list.

**Data flow**: It creates a temporary memory directory, sets up the expected folder layout, and writes two old summary files. It then prepares one current memory record, runs the summary-sync step, and rebuilds the raw memories file. After that, it checks that both old thread-id-named files are gone, exactly one summary file remains, and the raw memories text contains the current memory details and the new summary filename.

**Call relations**: This is the integration-style test in the file. It calls the real layout, sync, path, and rebuild functions from the storage module, using temporary disk files as the proving ground. The test confirms that the summary directory and raw memories file are updated together rather than leaving stale files or stale references behind.

*Call graph*: calls 1 internal fn (default); 14 external calls (new, assert!, assert_eq!, ensure_layout, raw_memories_file, rebuild_raw_memories_file_from_memories, rollout_summaries_dir, sync_rollout_summaries_from_memories, format!, tempdir (+4 more)).


### `memories/write/src/workspace_tests.rs`

`test` · `test run`

This is a test file. It does not provide the memory workspace feature itself; instead, it protects that feature from breaking. The memory workspace appears to be a small file area, backed by Git, where memory files such as `MEMORY.md` can be edited and compared against a saved baseline. A baseline is the known starting point, like a “before” photo used to see what changed later.

The tests cover a few important safety cases. One test builds an intentionally huge diff, meaning a text report of file changes, and checks that the rendering code cuts it off at the configured size instead of producing an unlimited block of text. Another creates a temporary workspace, writes a generated diff file, resets the baseline, and confirms that the generated diff file disappears and no changes remain. A third test simulates a bad `.git` directory, like finding a broken filing cabinet where Git metadata should be, and checks that preparing the workspace recovers cleanly. The final test checks that byte-based trimming does not split a multi-byte character, which matters for non-English text and symbols.

Together, these tests make sure the workspace behaves predictably around size limits, cleanup, Git setup, and Unicode text.

#### Function details

##### `render_workspace_diff_file_bounds_large_diff`  (lines 9–23)

```
fn render_workspace_diff_file_bounds_large_diff()
```

**Purpose**: This test checks that rendering a very large workspace diff keeps the useful file summary but cuts off the oversized diff body. It prevents the system from producing an enormous memory-diff report that could waste space or overwhelm a reader.

**Data flow**: It starts with a fake diff that says `MEMORY.md` was modified and gives it more text than the allowed maximum. It sends that diff into the rendering function. The result is inspected to make sure it includes the modified-file line, includes a clear truncation message, and still ends as a properly closed code block.

**Call relations**: The Rust test runner calls this during the test suite. Inside the test, the workspace diff rendering code is treated like the part under inspection, while assertions act as the checklist that confirms the rendered output is both shortened and still well-formed.

*Call graph*: 2 external calls (assert!, vec!).


##### `reset_memory_workspace_baseline_removes_generated_diff`  (lines 26–55)

```
async fn reset_memory_workspace_baseline_removes_generated_diff()
```

**Purpose**: This test checks that resetting the memory workspace baseline removes the generated workspace diff file and leaves the workspace with no reported changes. It protects the cleanup path, so old generated reports do not linger after a reset.

**Data flow**: It creates a temporary directory, prepares a memory workspace inside it, writes a `MEMORY.md` file, and writes a generated diff that says the file was added. Then it resets the baseline. After that, it checks two outcomes: the generated diff file is gone, and asking for the workspace diff returns an empty list of changes.

**Call relations**: The asynchronous test runner calls this test because it uses async workspace operations. The test sets up a realistic small workspace, asks the diff-writing code to create generated state, then hands control to the baseline-reset code and verifies the diff-reading code sees a clean result afterward.

*Call graph*: 5 external calls (new, assert!, assert_eq!, write, vec!).


##### `prepare_memory_workspace_recovers_unusable_git_dir`  (lines 58–72)

```
async fn prepare_memory_workspace_recovers_unusable_git_dir()
```

**Purpose**: This test checks that preparing a memory workspace can recover when a `.git` directory already exists but is not usable as a real Git repository. It matters because a half-created or corrupted Git directory should not permanently break memory storage.

**Data flow**: It creates a temporary memory folder, manually puts an empty `.git` directory there, and writes a `MEMORY.md` file. It then asks the workspace preparation code to set things up. Finally, it reads the workspace diff and expects no changes, showing that preparation repaired or replaced the unusable Git setup well enough to establish a clean baseline.

**Call relations**: The asynchronous test runner calls this during tests. The test deliberately creates a bad starting state, then passes that state to the workspace preparation code and uses the diff-reading path afterward as proof that the workspace is usable again.

*Call graph*: 4 external calls (new, assert_eq!, create_dir_all, write).


##### `previous_char_boundary_handles_multibyte_text`  (lines 75–78)

```
fn previous_char_boundary_handles_multibyte_text()
```

**Purpose**: This test checks that the helper for finding a safe text cut point does not split a multi-byte character. That matters because some characters, such as `é`, take more than one byte, and cutting through the middle would create invalid text.

**Data flow**: It starts with the text `aé` and asks for the previous safe character boundary before or at byte position 2. Since byte position 2 falls inside `é`, the helper should move back to position 1, right after `a`. The test confirms that exact result.

**Call relations**: The normal test runner calls this test. It focuses on the small boundary-finding helper that larger truncation code depends on, especially when shortening text that may contain accented letters, symbols, or other non-ASCII characters.

*Call graph*: 1 external calls (assert_eq!).


### Message and thread store fixtures
Persistence tests for message history are paired with reusable local thread-store fixtures for realistic rollout-backed storage scenarios.

### `message-history/src/tests.rs`

`test` · `test suite`

The message history feature stores past messages in a file where each line is one JSON record. This test file acts like a safety checklist for that storage format. It creates temporary folders and history files, writes sample entries, then asks the real history code to read metadata, find entries, append new ones, and shrink the file when it gets too large.

The tests focus on a few important promises. First, a history file with two saved entries should report the right count, and a lookup by position should return the expected entry. Second, counting entries must still work when newline characters fall exactly around internal read-buffer edges. That catches a common file-reading bug where data split across chunks is counted incorrectly. Third, the file’s “log id” must stay useful even after new entries are appended, so callers can keep using an earlier snapshot marker to fetch later records.

The last two tests cover size limits. They configure a maximum history size, append entries, and verify that old entries are removed when needed. One test checks the hard limit: the file must not exceed the configured byte count. The other checks a softer cleanup target, meaning the code trims more aggressively than the bare minimum so it does not immediately need trimming again. Like testing a notebook with tear-out pages, these tests make sure old pages are removed without damaging the newest useful page.

#### Function details

##### `lookup_reads_history_entries`  (lines 9–42)

```
async fn lookup_reads_history_entries()
```

**Purpose**: This test proves that saved history entries can be counted and then retrieved by their position in the file. It uses two simple sample entries and checks that looking up the second one returns exactly what was written.

**Data flow**: The test starts with a new temporary folder, builds a history file path, and writes two JSON-formatted history records into that file. It then asks the history code for the file’s metadata, receiving a log id and an entry count. Using that log id and an offset of 1, it looks up the second entry and confirms that the returned record matches the second record originally written.

**Call relations**: During the test run, this function sets up the file itself using temporary-file and file-writing helpers, then calls into the history module through `history_metadata_for_file` and `lookup_history_entry`. The metadata result feeds directly into the lookup step, mirroring how real code first learns what is in a history log and then fetches one entry from it.

*Call graph*: 5 external calls (create, new, assert_eq!, vec!, writeln!).


##### `history_metadata_counts_newlines_across_read_boundaries`  (lines 45–64)

```
async fn history_metadata_counts_newlines_across_read_boundaries()
```

**Purpose**: This test checks that entry counting works even when newline characters appear at awkward places in the file. Since each newline marks the end of one history entry, counting them accurately is essential for reporting how many entries exist.

**Data flow**: The test creates a temporary history file filled mostly with placeholder bytes. It then places newline bytes at several positions, including positions right before, right at, and after the history reader’s buffer boundaries. After writing those bytes to disk, it asks `history_metadata_for_file` to count the entries and checks that the count equals the number of newline positions it inserted.

**Call relations**: This function exercises the metadata-reading path under a boundary-condition case. It does not care about valid JSON entries here; it is specifically checking the lower-level counting behavior used by `history_metadata_for_file` when the file is read in chunks.

*Call graph*: 4 external calls (new, assert_eq!, write, vec!).


##### `lookup_uses_stable_log_id_after_appends`  (lines 67–107)

```
async fn lookup_uses_stable_log_id_after_appends()
```

**Purpose**: This test proves that a log id returned before an append can still be used after the file grows. That matters because callers may ask for metadata, then new history may be written before they look up an entry.

**Data flow**: The test creates a history file with one entry and asks for metadata, receiving a log id and a count of one. It then opens the same file in append mode and writes a second entry. Finally, it uses the original log id with an offset pointing to the appended entry, and checks that the lookup returns the newly added record.

**Call relations**: This test tells a small story that resembles real use: metadata is read first, the file changes, and then lookup happens. It relies on the history module’s `history_metadata_for_file` to produce a stable identifier, and on `lookup_history_entry` to interpret that identifier correctly after later appends.

*Call graph*: 5 external calls (create, new, assert_eq!, new, writeln!).


##### `append_entry_trims_history_when_beyond_max_bytes`  (lines 110–149)

```
async fn append_entry_trims_history_when_beyond_max_bytes()
```

**Purpose**: This test checks that appending a new history entry respects a configured maximum file size. If the file would become too large, the older entry should be removed so the newer entry can remain.

**Data flow**: The test creates a temporary Codex home folder and a default history configuration. It writes a first large entry, measures the file size, then sets the maximum allowed size to only a little more than that first-entry size. After appending a second large entry, it reads the history file back, parses each line as a history entry, and confirms that only the second entry remains. It also checks the final file size is at or below the configured limit.

**Call relations**: This function drives the real append path by calling `append_entry` with a `HistoryConfig`. It also rebuilds the configuration after changing `history.max_bytes`, so the append code sees the new size limit. The test then verifies the result from the outside, by reading the file from disk rather than inspecting internal state.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, assert!, assert_eq!, default, metadata, read_to_string, try_from).


##### `append_entry_trims_history_to_soft_cap`  (lines 152–220)

```
async fn append_entry_trims_history_to_soft_cap()
```

**Purpose**: This test checks that history trimming aims below a soft cleanup target, not merely below the absolute maximum size. That helps avoid repeated tiny cleanups every time one more entry is appended.

**Data flow**: The test writes a shorter entry and then a longer entry, measuring how much file space each entry uses. It then sets a maximum size where dropping only the first entry would satisfy the hard limit, but would still be above the softer target. After appending another long entry, it reads and parses the file and confirms that only the latest long entry remains. It also calculates the soft cap and checks the final file length matches the expected more-aggressive trimming behavior.

**Call relations**: This function uses `append_entry` several times to build up realistic file contents, then changes `HistoryConfig` to introduce a size limit. It is connected to the trimming logic more deeply than the previous size test: instead of only checking that the file is small enough, it confirms that the append path prunes enough old entries to satisfy the intended soft-cap policy.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, assert!, assert_eq!, default, metadata, read_to_string, try_from).


### `thread-store/src/local/test_support.rs`

`test` · `test setup`

The local thread store appears to read conversation history from files on disk, including normal sessions and archived sessions. Tests need sample files that look real enough for the production reader to understand them. This file is the test workshop that builds those samples.

It has one helper for making a `LocalThreadStoreConfig`, which is the set of paths and defaults the store needs before it can run. The rest of the file writes JSON Lines session files. “JSON Lines” means each line is its own JSON record, like a logbook where every entry is separate. The helper creates a directory, chooses a filename using a timestamp and session ID, then writes two records: session metadata and the first user message.

There are convenience wrappers for common test cases: an active session, an archived session, a custom session, and a forked session. A forked session records that it came from another session, like a copy of a document that started from an earlier version. Without these helpers, many tests would need to hand-build the same directory layout and JSON records, making the tests harder to read and easier to break when the file format changes.

#### Function details

##### `test_config`  (lines 11–17)

```
fn test_config(codex_home: &Path) -> LocalThreadStoreConfig
```

**Purpose**: Builds a simple local thread-store configuration for tests. It points both main storage locations at the same temporary test home and uses a fixed fake model provider.

**Data flow**: It receives a path for the fake Codex home directory. It copies that path into the configuration as both the Codex home and SQLite home, adds the provider name `test-provider`, and returns the finished `LocalThreadStoreConfig`. It does not write anything to disk.

**Call relations**: Many thread-store tests call this first so they can create a store with predictable paths and defaults. It relies only on converting the incoming path into owned path values, then hands the completed configuration back to the test.

*Call graph*: called by 65 (archive_thread_moves_rollout_to_archived_collection, archive_thread_updates_sqlite_metadata_when_present, delete_rollout_file_treats_vanished_path_as_already_deleted, delete_thread_removes_active_and_archived_rollouts, delete_thread_reports_missing_thread, list_threads_preserves_sqlite_title_search_results, list_threads_rejects_invalid_cursor, list_threads_returns_local_rollout_summary, list_threads_selects_active_or_archived_collection, list_threads_uses_default_provider_when_rollout_omits_provider (+15 more)); 1 external calls (to_path_buf).


##### `write_session_file`  (lines 19–28)

```
fn write_session_file(root: &Path, ts: &str, uuid: Uuid) -> std::io::Result<PathBuf>
```

**Purpose**: Creates a normal, active test session file with a standard first user message and provider. Tests use it when they need a realistic conversation file in the usual sessions folder.

**Data flow**: It receives the test root directory, a timestamp string, and a session UUID. It chooses the active-session date folder under `sessions/2025/01/03`, fills in the default message `Hello from user` and provider `test-provider`, and returns the path to the file that was written. If creating directories or writing the file fails, it returns the I/O error.

**Call relations**: This is a convenience wrapper used by many tests that do not care about custom message text or provider details. It hands the real work to `write_session_file_with`, which then delegates to the lower-level writer.

*Call graph*: calls 1 internal fn (write_session_file_with); called by 34 (archive_thread_moves_rollout_to_archived_collection, archive_thread_updates_sqlite_metadata_when_present, delete_rollout_file_treats_vanished_path_as_already_deleted, delete_thread_removes_active_and_archived_rollouts, list_threads_returns_local_rollout_summary, list_threads_selects_active_or_archived_collection, read_thread_accepts_legacy_sandbox_policy_metadata, read_thread_applies_sqlite_thread_name, read_thread_by_rollout_path_prefers_sqlite_git_info, read_thread_falls_back_to_rollout_search_when_sqlite_path_is_stale (+15 more)); 1 external calls (join).


##### `write_archived_session_file`  (lines 30–43)

```
fn write_archived_session_file(
    root: &Path,
    ts: &str,
    uuid: Uuid,
) -> std::io::Result<PathBuf>
```

**Purpose**: Creates a test session file in the archived-session area instead of the active-session area. Tests use it to check archive, unarchive, delete, and read behavior.

**Data flow**: It receives the test root directory, timestamp, and session UUID. It chooses the archive directory, uses the message `Archived user message` and provider `test-provider`, then returns the path to the archived file it created. Disk failures are passed back as I/O errors.

**Call relations**: Tests call this when they need the store to find a session as archived. Like the active-session helper, it delegates the actual file writing to `write_session_file_with` so archived and active files share the same JSON shape.

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

**Purpose**: Creates a test session file with caller-chosen location, first message, and optional model provider. It is useful for tests that need to vary the contents without dealing with fork metadata.

**Data flow**: It receives the root directory, exact day/archive directory, timestamp, UUID, first user message, and optional provider name. It passes all of that onward and explicitly says there is no `forked_from_id`. The result is the path to the created file, or an I/O error if setup or writing fails.

**Call relations**: The simpler active and archived helpers call this after choosing their standard folders and defaults. This function then calls `write_session_file_with_fork`, which is the one place that actually creates the directory and writes the JSON records.

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

**Purpose**: Writes the actual fake session file, including optional information that the session was forked from another one. This is the core helper behind all the session-file test setup in this file.

**Data flow**: It receives the root path, destination directory, timestamp, session UUID, first user message, optional provider, and optional parent-session UUID. It creates the destination directory, builds a filename like `rollout-<timestamp>-<uuid>.jsonl`, opens the file, writes a session metadata JSON line, then writes a user-message JSON line. It returns the new file path, or an I/O error if any disk operation fails.

**Call relations**: Higher-level helpers call this after deciding which defaults to use. Tests that specifically need fork information call it through the custom helper path, so the resulting file can be read by production code as a forked conversation during read-thread tests.

*Call graph*: called by 2 (read_thread_returns_forked_from_id, write_session_file_with); 6 external calls (join, format!, create, create_dir_all, json!, writeln!).


### External agent session ledger
This focused group verifies ledger behavior for missing files, completed imports, and metadata refresh updates.

### `external-agent-sessions/src/ledger_tests.rs`

`test` · `test run`

The import ledger is like a receipt book for session imports. When the system imports a session file from an outside agent, it records where that file came from, what its contents looked like using a SHA-256 hash (a compact fingerprint of the bytes), and which Codex thread was created from it. These tests check important safety behavior around that receipt book.

The main concern is that once an import is complete, the system should not need the original session file to still exist. A user might delete or move that file after importing it. If the ledger tried to read the source file every time it checked history, old imports could break just because the original file disappeared.

The tests use temporary folders so they do not touch real user data. They create fake session files, compute content fingerprints, record completed imports, reload the ledger from the fake Codex home directory, and verify the stored records. One test also checks that importing the same source again refreshes the existing ledger entry instead of creating a duplicate. Together, these tests protect the ledger’s promise: it should be durable, self-contained evidence of completed imports.

#### Function details

##### `empty_ledger_does_not_read_source`  (lines 10–19)

```
fn empty_ledger_does_not_read_source()
```

**Purpose**: This test proves that a brand-new, empty ledger does not try to inspect a source file when asked whether it contains that source. That matters because an empty ledger should be able to answer “no” even if the file path points to something that does not exist.

**Data flow**: It starts by creating a temporary folder and then invents a path to a missing session file inside it. It asks the default empty ledger whether it contains the current version of that missing source. The expected result is false, and the test also confirms the check succeeds without failing because the file is absent.

**Call relations**: This is a focused guard test for ImportedExternalAgentSessionLedger::contains_current_source. It sets up the simplest possible case, calls that ledger check directly, and uses an assertion to confirm the ledger answers from its own records rather than relying on the missing file.

*Call graph*: 2 external calls (new, assert!).


##### `completed_imports_do_not_read_source_files`  (lines 22–47)

```
fn completed_imports_do_not_read_source_files()
```

**Purpose**: This test checks that recording a completed import saves enough information that the ledger can later be loaded even after the original source file has been deleted. It protects the user-facing behavior that imported sessions remain remembered without depending on old external files.

**Data flow**: It creates a temporary Codex home folder and a fake session file, writes sample contents to that file, turns the source path into its full canonical path, then deletes the file. It records a completed import using the known source path, the SHA-256 content fingerprint, and a newly created thread id. After loading the ledger back from disk, it expects exactly one record with the same source path and thread id, and with no stored modification time because the file was already gone when the completed import was recorded.

**Call relations**: This test exercises the real recording path by calling record_completed_session_imports and then load_import_ledger. It tells the story of a source file that existed during import but disappeared before ledger recording finished, and it verifies the ledger still contains the completed import record without trying to reopen the deleted file.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, assert_eq!, canonicalize, remove_file, write, load_import_ledger, record_completed_session_imports, vec!).


##### `completed_import_refreshes_existing_record_metadata`  (lines 50–85)

```
fn completed_import_refreshes_existing_record_metadata()
```

**Purpose**: This test confirms that recording the same imported source again updates the existing ledger entry rather than adding a duplicate. It also checks that when the source file still exists, the ledger captures current file metadata such as its modification time.

**Data flow**: It creates a temporary source file, writes sample contents, canonicalizes the path, and computes the content fingerprint. It records one completed import with a first thread id, then records another completed import for the same source and same content with a second thread id. After reloading the ledger, the test expects there to be only one record, expects that record to point to the source path, expects the thread id to be the second one, and expects a modification time to be present because the source file was still available.

**Call relations**: This test drives record_completed_session_imports twice and then checks the result through load_import_ledger. It verifies the replacement behavior in the larger import flow: a later completed import for the same source refreshes the ledger’s saved details instead of leaving stale or duplicated history behind.

*Call graph*: calls 1 internal fn (new); 9 external calls (new, assert!, assert_eq!, format!, canonicalize, write, load_import_ledger, record_completed_session_imports, vec!).


### Rollout indexing, metadata, and recording
The rollout subsystem is tested from low-level compression and indexing through metadata/state integration, recorder behavior, and end-to-end filesystem scanning.

### `rollout/src/compression_tests.rs`

`test` · `test suite`

A rollout is a saved session transcript, stored as one JSON object per line in a `.jsonl` file. This test file checks the compressed form of those transcripts, which uses `.zst` files to save disk space. The tests create temporary fake Codex home folders, write small sample rollout files, compress them, and then ask the real rollout code to load, append to, search, resume, or locate those files.

The main idea is that compression should be invisible to users most of the time. If a transcript is compressed, loading it should still work. If the program needs to append new lines, the compressed file should be expanded back into a normal `.jsonl` file first. If both a plain and compressed copy exist, the plain one should win, so the system does not show duplicates. The worker tests check the background cleaner that compresses old rollouts, skips fresh ones, and removes stale temporary files.

The file also pays attention to safety details. It checks that completed temporary files do not overwrite existing destination files, that run markers stop the compression worker from running too often, and, on Unix systems, that file permissions and modification times survive compression and expansion. The helper functions at the bottom act like a small test workshop: they build rollout paths, write sample transcripts, compress them immediately, and make files look old.

#### Function details

##### `load_rollout_items_reads_compressed_rollout`  (lines 29–46)

```
async fn load_rollout_items_reads_compressed_rollout() -> anyhow::Result<()>
```

**Purpose**: This test proves that the rollout loader can read a transcript after it has been compressed. It also checks that loading the compressed file does not recreate the plain file by accident.

**Data flow**: It creates a temporary home folder, builds a rollout path, writes a two-line sample transcript, and compresses it. Then it asks `RolloutRecorder::load_rollout_items` to read from the original logical path. The result should be the original thread id, no parse errors, two loaded items, no plain file left on disk, and a compressed file still present.

**Call relations**: This test uses the local helpers `rollout_path`, `write_rollout`, and `compress_now` to set up the situation. It then calls the production loader, which is the behavior under test: compressed storage should still read like a normal rollout.

*Call graph*: calls 5 internal fn (from_string, compress_now, rollout_path, write_rollout, load_rollout_items); 4 external calls (new, from_u128, assert!, assert_eq!).


##### `rollout_file_from_path_normalizes_compressed_file_names`  (lines 49–63)

```
fn rollout_file_from_path_normalizes_compressed_file_names() -> anyhow::Result<()>
```

**Purpose**: This test checks that a compressed rollout filename is treated as the same rollout as its plain `.jsonl` name. That matters because user-facing lists should not expose compression details as if they were different sessions.

**Data flow**: It builds a normal rollout path, derives its compressed sibling path, and feeds that compressed path into `RolloutFile::from_path`. The expected output keeps the real compressed path but reports the plain filename without the `.zst` suffix.

**Call relations**: The test uses `rollout_path` to create a realistic filename and then checks the path-normalizing behavior of `RolloutFile::from_path`, which is used when discovering rollout files.

*Call graph*: calls 1 internal fn (rollout_path); 3 external calls (new, from_u128, assert_eq!).


##### `rollout_file_from_path_hides_compressed_sibling_when_plain_exists`  (lines 66–78)

```
fn rollout_file_from_path_hides_compressed_sibling_when_plain_exists() -> anyhow::Result<()>
```

**Purpose**: This test makes sure the system does not show a compressed copy when a plain rollout file already exists beside it. The plain file is treated as the active, authoritative version.

**Data flow**: It writes a sample plain rollout, then asks `RolloutFile::from_path` about the compressed path that would sit next to it. Because the plain file exists, the function should return nothing for the compressed sibling.

**Call relations**: The test sets up its file with `rollout_path` and `write_rollout`. It then checks the file-discovery rule that prevents duplicate entries when both compressed and uncompressed names could match.

*Call graph*: calls 3 internal fn (from_string, rollout_path, write_rollout); 3 external calls (new, from_u128, assert_eq!).


##### `append_rollout_item_materializes_compressed_rollout`  (lines 81–106)

```
async fn append_rollout_item_materializes_compressed_rollout() -> anyhow::Result<()>
```

**Purpose**: This test checks that appending to a compressed transcript first turns it back into a normal writable file. Without this, new session events could not be added safely to old compressed logs.

**Data flow**: It writes and compresses a rollout, then appends a new user-message item to the logical rollout path. After that, the plain `.jsonl` file should exist, the `.zst` file should be gone, and loading the rollout should return the original two items plus the new one.

**Call relations**: The setup uses `rollout_path`, `write_rollout`, and `compress_now`. The test then calls `append_rollout_item_to_path`, and finally uses `RolloutRecorder::load_rollout_items` to prove the append and materialization worked together.

*Call graph*: calls 5 internal fn (from_string, compress_now, rollout_path, write_rollout, load_rollout_items); 8 external calls (default, new, from_u128, assert!, assert_eq!, append_rollout_item_to_path, UserMessage, EventMsg).


##### `search_rollout_matches_uses_logical_path_for_compressed_rollout`  (lines 109–130)

```
async fn search_rollout_matches_uses_logical_path_for_compressed_rollout() -> anyhow::Result<()>
```

**Purpose**: This test verifies that searching compressed rollouts reports matches under the normal rollout path, not the storage-specific compressed path. That keeps search results understandable to the rest of the program.

**Data flow**: It writes a rollout containing a target phrase, compresses it, and runs `search_rollout_matches` for part of that phrase. The returned map should contain the plain logical rollout path as the key and the matching text as the value.

**Call relations**: The test creates its compressed sample with `rollout_path`, `write_rollout`, and `compress_now`. It then exercises the production search function, checking that compressed files are searched but presented as normal rollout files.

*Call graph*: calls 4 internal fn (from_string, compress_now, rollout_path, write_rollout); 5 external calls (new, from_u128, assert_eq!, search_rollout_matches, new).


##### `worker_compresses_old_active_and_archived_rollouts`  (lines 133–176)

```
async fn worker_compresses_old_active_and_archived_rollouts() -> anyhow::Result<()>
```

**Purpose**: This test checks the background compression worker. It should compress old rollout files in both active and archived locations, leave fresh files alone, and clean up stale temporary compression files.

**Data flow**: It creates old active and archived rollouts, a fresh active rollout, an old temporary `.tmp` file, and a fresh temporary `.tmp` file. After `worker::run` finishes, the old rollouts should be replaced by compressed files, the fresh rollout should remain plain, the stale temp should be deleted, the fresh temp should remain, and a run marker should exist.

**Call relations**: The test relies on `rollout_path`, `archived_rollout_path`, `write_rollout`, and `set_old_mtime` to build realistic files with different ages. It then calls the worker, which is responsible for deciding what to compress, skip, or clean.

*Call graph*: calls 5 internal fn (from_string, archived_rollout_path, rollout_path, set_old_mtime, write_rollout); 5 external calls (new, from_u128, assert!, write, run).


##### `resume_materializes_compressed_rollout_path`  (lines 179–228)

```
async fn resume_materializes_compressed_rollout_path() -> anyhow::Result<()>
```

**Purpose**: This test proves that resuming a compressed session turns the transcript back into a normal file and continues writing there. It protects the user flow where an old compressed session is reopened and receives new messages.

**Data flow**: It creates and compresses a rollout, then asks for its initial history from the compressed path. The history should point back to the plain logical path. It then creates a `RolloutRecorder` in resume mode, checks that the recorder uses the plain path, writes one new item, flushes and shuts down, and finally reloads the file to confirm all three items are present.

**Call relations**: This test uses `rollout_path`, `write_rollout`, and `compress_now` for setup. It connects several production pieces: `get_rollout_history` reads the compressed file, `RolloutRecorder::new` with resume parameters materializes it, and recorder writing proves the resumed session can continue normally.

*Call graph*: calls 8 internal fn (from_string, compress_now, rollout_path, write_rollout, get_rollout_history, load_rollout_items, new, resume); 8 external calls (default, new, from_u128, assert!, assert_eq!, panic!, UserMessage, EventMsg).


##### `compression_preserves_rollout_permissions`  (lines 232–250)

```
async fn compression_preserves_rollout_permissions() -> anyhow::Result<()>
```

**Purpose**: On Unix systems, this test checks that compressing a restricted rollout keeps its file permissions. That matters because transcripts may contain private conversation content.

**Data flow**: It writes an archived rollout, changes its permissions to owner-read/write only, marks it old, and runs the compression worker. The plain file should be gone, and the compressed file should still have the same restricted permission bits.

**Call relations**: The test uses `archived_rollout_path`, `write_rollout`, and `set_old_mtime` to create an old archived file. It then calls the worker and inspects the compressed file metadata to ensure compression did not loosen access.

*Call graph*: calls 4 internal fn (from_string, archived_rollout_path, set_old_mtime, write_rollout); 7 external calls (new, from_u128, assert!, assert_eq!, from_mode, set_permissions, run).


##### `append_materialization_preserves_compressed_rollout_permissions`  (lines 254–280)

```
async fn append_materialization_preserves_compressed_rollout_permissions() -> anyhow::Result<()>
```

**Purpose**: On Unix systems, this test checks that expanding a compressed rollout before appending keeps the compressed file's restrictive permissions. It prevents a private transcript from becoming more widely readable just because it was reopened.

**Data flow**: It writes and compresses a rollout, sets the compressed file to owner-read/write only, and appends a new message through the normal append path. The result should be a plain rollout file with the same restrictive permission bits, and the compressed file should be removed.

**Call relations**: The test prepares the compressed input with `rollout_path`, `write_rollout`, and `compress_now`. It then exercises `append_rollout_item_to_path`, checking that materialization and permission copying happen as one safe operation.

*Call graph*: calls 4 internal fn (from_string, compress_now, rollout_path, write_rollout); 10 external calls (default, new, from_u128, assert!, assert_eq!, from_mode, append_rollout_item_to_path, set_permissions, UserMessage, EventMsg).


##### `persist_temp_file_noclobber_installs_completed_temp`  (lines 283–294)

```
fn persist_temp_file_noclobber_installs_completed_temp() -> anyhow::Result<()>
```

**Purpose**: This test checks the safe move step used for completed temporary files. If the destination does not already exist, the temporary file should become the real file.

**Data flow**: It writes a temporary file and chooses an empty destination path. After `persist_temp_file_noclobber` runs, the temp path should be gone and the destination should contain the temp file's text.

**Call relations**: This test directly exercises `persist_temp_file_noclobber`, a safety helper used when a temporary output is ready to be installed without risking unwanted overwrite.

*Call graph*: 4 external calls (new, assert!, assert_eq!, write).


##### `persist_temp_file_noclobber_does_not_replace_existing_destination`  (lines 297–309)

```
fn persist_temp_file_noclobber_does_not_replace_existing_destination() -> anyhow::Result<()>
```

**Purpose**: This test checks that the safe move step never overwrites a file that is already there. That avoids losing a real rollout if another process or earlier step already created it.

**Data flow**: It writes both a candidate temporary file and an existing destination file. After `persist_temp_file_noclobber` runs, the temp file should be removed and the destination should still contain its original text.

**Call relations**: Like the companion test, this directly calls `persist_temp_file_noclobber`. It covers the conflict case, where the helper must clean up the temp file but leave the existing destination untouched.

*Call graph*: 4 external calls (new, assert!, assert_eq!, write).


##### `compression_preserves_read_only_rollout_permissions`  (lines 313–331)

```
async fn compression_preserves_read_only_rollout_permissions() -> anyhow::Result<()>
```

**Purpose**: On Unix systems, this test checks that compressing a read-only rollout keeps both its read-only permissions and its modification time. This is important for preserving the meaning and history of archived files.

**Data flow**: It writes an old archived rollout, records its modified time, makes it owner-read-only, and runs the compression worker. The compressed file should replace the plain one, keep the same permission bits, and keep the same modified timestamp.

**Call relations**: The test uses `archived_rollout_path`, `write_rollout`, and `set_old_mtime` for setup, then calls the worker. It verifies that the worker's compression step preserves metadata, not just file contents.

*Call graph*: calls 4 internal fn (from_string, archived_rollout_path, set_old_mtime, write_rollout); 8 external calls (new, from_u128, assert!, assert_eq!, from_mode, metadata, set_permissions, run).


##### `worker_skips_existing_compressed_archived_rollouts`  (lines 334–354)

```
async fn worker_skips_existing_compressed_archived_rollouts() -> anyhow::Result<()>
```

**Purpose**: This test makes sure the compression worker does not damage or duplicate an archived rollout that is already compressed. It should recognize that there is nothing more to do.

**Data flow**: It writes an archived rollout, compresses it immediately, marks the compressed file old, and runs the worker. The compressed file should remain, the plain file should stay absent, and loading through the logical rollout path should still return the expected two items.

**Call relations**: The test uses `archived_rollout_path`, `write_rollout`, `compress_now`, and `set_old_mtime` to build an already-compressed archived rollout. It then calls the worker and the rollout loader to confirm both skipping and later reading still work.

*Call graph*: calls 6 internal fn (from_string, archived_rollout_path, compress_now, set_old_mtime, write_rollout, load_rollout_items); 5 external calls (new, from_u128, assert!, assert_eq!, run).


##### `worker_skips_when_fresh_run_marker_exists`  (lines 357–373)

```
async fn worker_skips_when_fresh_run_marker_exists() -> anyhow::Result<()>
```

**Purpose**: This test checks the throttling guard for the compression worker. If a recent run marker exists, the worker should skip work instead of scanning and compressing again too soon.

**Data flow**: It creates an old archived rollout that would normally qualify for compression, then writes a fresh marker file in the temporary directory. After the worker runs, the rollout should still be plain and no compressed copy should exist.

**Call relations**: The test prepares the old file with `archived_rollout_path`, `write_rollout`, and `set_old_mtime`, then creates the marker that the worker checks. The worker should see the marker and exit without touching eligible files.

*Call graph*: calls 4 internal fn (from_string, archived_rollout_path, set_old_mtime, write_rollout); 6 external calls (new, from_u128, assert!, create_dir_all, write, run).


##### `run_marker_is_removed_unless_persisted`  (lines 376–394)

```
fn run_marker_is_removed_unless_persisted() -> anyhow::Result<()>
```

**Purpose**: This test checks the lifecycle of the compression worker's run marker. A marker should disappear automatically unless the code explicitly chooses to keep it.

**Data flow**: It first claims a marker inside a short scope and lets it drop; the marker file should be removed. It then claims another marker, calls `persist`, and confirms the marker remains on disk and prevents a later claim.

**Call relations**: The test directly exercises `worker::CompressionRunMarker::try_claim` and the marker's `persist` behavior. This supports the worker tests by proving the small locking-and-throttling object cleans up correctly.

*Call graph*: 4 external calls (new, assert!, panic!, try_claim).


##### `find_thread_path_by_id_handles_compressed_rollout_filenames`  (lines 397–420)

```
async fn find_thread_path_by_id_handles_compressed_rollout_filenames() -> anyhow::Result<()>
```

**Purpose**: This test confirms that looking up a thread by id can find a compressed rollout file. It also checks that invalid ids do not accidentally match anything.

**Data flow**: It writes and compresses a rollout whose filename contains a known UUID. A lookup by that UUID string should return the compressed path. A lookup using a non-UUID string should return no path.

**Call relations**: The test sets up the file with `rollout_path`, `write_rollout`, and `compress_now`, then calls `find_thread_path_by_id_str`. It verifies that the thread lookup code understands `.jsonl.zst` rollout names.

*Call graph*: calls 4 internal fn (from_string, compress_now, rollout_path, write_rollout); 3 external calls (new, from_u128, assert_eq!).


##### `find_thread_path_by_id_ignores_compression_temp_matches`  (lines 423–442)

```
async fn find_thread_path_by_id_ignores_compression_temp_matches() -> anyhow::Result<()>
```

**Purpose**: This test makes sure thread lookup ignores temporary files created during compression. A half-finished temp file should never be treated as a real session transcript.

**Data flow**: It builds a filename that looks like a rollout for a known UUID but ends with a compression temporary suffix, writes sample rollout content there, and searches by the UUID. The lookup should return nothing.

**Call relations**: The test uses `rollout_path` only as a base for making a realistic temporary filename, then writes content with `write_rollout`. It calls `find_thread_path_by_id_str` to confirm discovery filters out compression work files.

*Call graph*: calls 3 internal fn (from_string, rollout_path, write_rollout); 4 external calls (new, from_u128, assert_eq!, format!).


##### `rollout_path`  (lines 444–447)

```
fn rollout_path(home: &std::path::Path, ts: &str, uuid: Uuid) -> std::path::PathBuf
```

**Purpose**: This helper builds the normal active-session rollout path used by the tests. It keeps the test filenames consistent with the real directory shape.

**Data flow**: It receives a temporary home directory, a timestamp string, and a UUID. It combines them into a path under `sessions/2025/01/03` with a filename like `rollout-<timestamp>-<uuid>.jsonl`.

**Call relations**: Many tests call this helper before writing, compressing, appending, loading, searching, or looking up an active rollout. It is the common path factory for non-archived test transcripts.

*Call graph*: called by 10 (append_materialization_preserves_compressed_rollout_permissions, append_rollout_item_materializes_compressed_rollout, find_thread_path_by_id_handles_compressed_rollout_filenames, find_thread_path_by_id_ignores_compression_temp_matches, load_rollout_items_reads_compressed_rollout, resume_materializes_compressed_rollout_path, rollout_file_from_path_hides_compressed_sibling_when_plain_exists, rollout_file_from_path_normalizes_compressed_file_names, search_rollout_matches_uses_logical_path_for_compressed_rollout, worker_compresses_old_active_and_archived_rollouts); 2 external calls (join, format!).


##### `archived_rollout_path`  (lines 449–452)

```
fn archived_rollout_path(home: &std::path::Path, ts: &str, uuid: Uuid) -> std::path::PathBuf
```

**Purpose**: This helper builds the archived-session rollout path used by tests. It lets tests create files in the location where older saved sessions are expected to live.

**Data flow**: It receives a temporary home directory, timestamp string, and UUID. It returns a path under `archived_sessions` with the standard rollout filename ending in `.jsonl`.

**Call relations**: Worker and permission tests call this helper when they need archived rollouts. Those tests then pass the path to `write_rollout`, `set_old_mtime`, compression code, or the worker.

*Call graph*: called by 5 (compression_preserves_read_only_rollout_permissions, compression_preserves_rollout_permissions, worker_compresses_old_active_and_archived_rollouts, worker_skips_existing_compressed_archived_rollouts, worker_skips_when_fresh_run_marker_exists); 2 external calls (join, format!).


##### `write_rollout`  (lines 454–499)

```
fn write_rollout(path: &std::path::Path, thread_id: ThreadId, message: &str) -> anyhow::Result<()>
```

**Purpose**: This helper writes a small but realistic rollout transcript for tests. It creates the parent directory, writes session metadata, and writes one user message.

**Data flow**: It receives a path, a thread id, and a message string. It builds two rollout lines: one describing the session and one containing the user message. It turns those lines into JSON Lines text, writes them to disk, and returns success or an error.

**Call relations**: Most tests use this helper to create input files before exercising compression, loading, appending, searching, or lookup behavior. It provides valid rollout content so the production reader can parse the files normally.

*Call graph*: called by 13 (append_materialization_preserves_compressed_rollout_permissions, append_rollout_item_materializes_compressed_rollout, compression_preserves_read_only_rollout_permissions, compression_preserves_rollout_permissions, find_thread_path_by_id_handles_compressed_rollout_filenames, find_thread_path_by_id_ignores_compression_temp_matches, load_rollout_items_reads_compressed_rollout, resume_materializes_compressed_rollout_path, rollout_file_from_path_hides_compressed_sibling_when_plain_exists, search_rollout_matches_uses_logical_path_for_compressed_rollout (+3 more)); 8 external calls (default, parent, format!, create_dir_all, write, UserMessage, EventMsg, SessionMeta).


##### `compress_now`  (lines 501–511)

```
fn compress_now(path: &std::path::Path) -> anyhow::Result<()>
```

**Purpose**: This helper immediately compresses a rollout file for test setup. It simulates what the background compression worker would eventually do.

**Data flow**: It receives a plain rollout path, opens that file, creates the matching compressed path, copies the file contents through a Zstandard compressor, finishes the compressed output, and removes the original plain file.

**Call relations**: Tests call this helper when they need to start from a compressed rollout without running the full worker. The production code under test then loads, appends to, searches, resumes, or locates the compressed file.

*Call graph*: called by 7 (append_materialization_preserves_compressed_rollout_permissions, append_rollout_item_materializes_compressed_rollout, find_thread_path_by_id_handles_compressed_rollout_filenames, load_rollout_items_reads_compressed_rollout, resume_materializes_compressed_rollout_path, search_rollout_matches_uses_logical_path_for_compressed_rollout, worker_skips_existing_compressed_archived_rollouts); 6 external calls (create, open, remove_file, new, copy, new).


##### `set_old_mtime`  (lines 513–523)

```
fn set_old_mtime(path: &std::path::Path) -> anyhow::Result<()>
```

**Purpose**: This helper makes a file look old by changing its modification time to about eight days ago. Tests use it because the compression worker only compresses files old enough to qualify.

**Data flow**: It receives a path, computes a timestamp eight days before the current time, opens the file for writing metadata, and sets the file's modified time to that old timestamp.

**Call relations**: Worker and permission tests call this helper before running `worker::run`. It creates the age condition that tells the worker a rollout or temporary file is stale enough to compress or clean up.

*Call graph*: called by 5 (compression_preserves_read_only_rollout_permissions, compression_preserves_rollout_permissions, worker_compresses_old_active_and_archived_rollouts, worker_skips_existing_compressed_archived_rollouts, worker_skips_when_fresh_run_marker_exists); 4 external calls (from_secs, new, now, new).


### `rollout/src/metadata_tests.rs`

`test` · `test run`

A rollout file is a line-by-line JSON record of a Codex session. This test file creates tiny fake rollout files in temporary folders, then checks that the rollout metadata code reads them the way the rest of the system depends on. Without these tests, a change could silently break thread history: sessions might get the wrong creation time, lose Git information, skip files during backfill, or store messy working-directory paths.

The tests cover two main jobs. First, they check metadata extraction from one rollout file. If the file contains a session metadata line, that line should be trusted. If it does not, the code should still recover basic facts from the filename, like the thread id and timestamp. The tests also check that the latest memory mode is returned when more than one metadata line appears.

Second, they check backfilling. Backfilling means scanning old rollout files and inserting their thread records into the state database, like a librarian cataloging books that were already on the shelf. These tests confirm that backfill resumes after a saved checkpoint, marks itself complete, fills in missing Git fields from rollout data, keeps an existing Git branch if the database already has one, and normalizes the current working directory before saving.

Two helper functions at the bottom write realistic one-line rollout files so each test can focus on the behavior being checked.

#### Function details

##### `extract_metadata_from_rollout_uses_session_meta`  (lines 27–78)

```
async fn extract_metadata_from_rollout_uses_session_meta()
```

**Purpose**: This test proves that when a rollout file contains an explicit session metadata record, the extractor uses that record as the source of truth. It also checks that the file modification time becomes the metadata update time and that no parse errors are reported.

**Data flow**: The test starts with a temporary folder, a new thread id, and a synthetic rollout filename. It writes one JSON line containing session metadata into that file. Then it asks the metadata extractor to read the file, builds the expected metadata from the same session record, applies the rollout item updates, adds the file's modification time, and compares expected versus actual output. The result should include matching metadata, no memory mode, and zero parse errors.

**Call relations**: The async test runner calls this test. Inside the test, temporary-file and JSON helpers create the input, then the rollout metadata extraction path is exercised. The result is checked against metadata built through the same builder path used by the production code, so this test ties together session metadata parsing, rollout item application, and timestamp handling.

*Call graph*: calls 1 internal fn (from_string); 9 external calls (create, new_v4, default, assert_eq!, format!, SessionMeta, to_string, tempdir, writeln!).


##### `extract_metadata_from_rollout_returns_latest_memory_mode`  (lines 81–144)

```
async fn extract_metadata_from_rollout_returns_latest_memory_mode()
```

**Purpose**: This test checks that if a rollout contains more than one session metadata line, the extractor reports the most recent memory mode it sees. This matters because session settings can change over time, and callers need the latest value.

**Data flow**: The test creates a rollout file with two JSON lines. The first line has no memory mode, while the second line has a memory mode value of "polluted" and a later timestamp. It runs metadata extraction on the file and inspects only the returned memory mode. The expected output is the later value, not the earlier empty value.

**Call relations**: The async test runner invokes this test as part of the metadata test suite. It builds its own rollout file directly, then hands that file to the extraction routine. The assertion confirms that extraction reads through the whole file and lets later session metadata update the separate memory-mode result.

*Call graph*: calls 1 internal fn (from_string); 8 external calls (create, new_v4, default, assert_eq!, format!, tempdir, vec!, writeln!).


##### `builder_from_items_falls_back_to_filename`  (lines 147–173)

```
fn builder_from_items_falls_back_to_filename()
```

**Purpose**: This test verifies the fallback path used when a rollout file does not contain a session metadata line. In that case, the system should still recover the thread id and creation time from the rollout filename.

**Data flow**: The test creates a rollout-style path whose filename includes a timestamp and UUID. It supplies rollout items that do not contain session metadata. The builder function receives those items and the path, then should produce a thread metadata builder based on the filename. The test independently parses the same timestamp and UUID, builds the expected builder, and compares the two.

**Call relations**: The normal Rust test runner calls this synchronous test. It exercises the builder fallback directly, without going through file reading. This isolates the behavior that protects older or incomplete rollout files from becoming unusable.

*Call graph*: calls 2 internal fn (from_string, new); 8 external calls (from_naive_utc_and_offset, parse_from_str, new_v4, default, assert_eq!, format!, tempdir, vec!).


##### `backfill_sessions_resumes_from_watermark_and_marks_complete`  (lines 176–242)

```
async fn backfill_sessions_resumes_from_watermark_and_marks_complete()
```

**Purpose**: This test checks that session backfill can resume after a saved checkpoint, called a watermark, and then mark the backfill as complete. A watermark is like a bookmark in a long scan: files before it should not be processed again.

**Data flow**: The test creates two rollout files under a temporary Codex home directory. It initializes a state runtime, marks backfill as running, and saves a checkpoint pointing at the first file. After waiting long enough for the previous backfill lease to expire, it runs backfill. The expected result is that the first thread is still absent, the second thread is inserted, and the saved backfill state says the job is complete with the second file as the latest watermark.

**Call relations**: The async test runner calls this test. The test uses the local helper write_rollout_in_sessions to create realistic rollout inputs, then uses the state runtime and backfill functions together. It checks the full flow from checkpoint recovery, through scanning, to final persisted backfill status.

*Call graph*: calls 3 internal fn (from_string, write_rollout_in_sessions, init); 6 external calls (new_v4, assert!, assert_eq!, from_secs, tempdir, sleep).


##### `backfill_sessions_preserves_existing_git_branch_and_fills_missing_git_fields`  (lines 245–290)

```
async fn backfill_sessions_preserves_existing_git_branch_and_fills_missing_git_fields()
```

**Purpose**: This test makes sure backfill merges Git information carefully when a thread already exists in the state database. It should fill missing Git fields from the rollout file, but not overwrite an existing branch stored in the database.

**Data flow**: The test writes a rollout file containing a Git commit, branch, and repository URL. It extracts metadata from that rollout, deliberately removes the commit and repository URL, and changes the branch to a database-specific value. That partial record is inserted into the state database. After backfill runs, the stored thread should have the rollout commit and repository URL filled in, while keeping the original database branch.

**Call relations**: The async test runner invokes this test. It relies on write_rollout_in_sessions to create the file, uses extraction to create an initial realistic record, stores that record through the state runtime, then runs backfill. The final checks show how backfill cooperates with existing database data instead of blindly replacing it.

*Call graph*: calls 4 internal fn (new, from_string, write_rollout_in_sessions, init); 3 external calls (new_v4, assert_eq!, tempdir).


##### `backfill_sessions_normalizes_cwd_before_upsert`  (lines 293–322)

```
async fn backfill_sessions_normalizes_cwd_before_upsert()
```

**Purpose**: This test confirms that backfill cleans up the session working-directory path before saving it. Normalizing a path means turning equivalent forms, such as a directory ending in '.', into one consistent stored form.

**Data flow**: The test creates a rollout whose session current working directory is the Codex home path with an extra '.' component. It initializes the state runtime and runs backfill. Then it loads the saved thread and compares the stored rollout path and working directory. The rollout path should match the created file, and the working directory should match the normalized version of the input path.

**Call relations**: The async test runner calls this test. It uses write_rollout_in_sessions_with_cwd because this case needs a custom working directory. After backfill writes the thread into the state database, the test checks that the same path-normalization helper used by production code describes the stored result.

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

**Purpose**: This helper writes a simple rollout file into a temporary sessions directory using the Codex home directory as the session working directory. Tests use it to avoid repeating the same setup code.

**Data flow**: The helper receives a Codex home path, a timestamp for the filename, a timestamp for the event inside the file, a thread UUID, and optional Git information. It passes those values along to the more flexible helper, using the Codex home itself as the current working directory. The output is the path of the rollout file that was created.

**Call relations**: Backfill tests call this helper when they do not need a special working directory. It immediately hands off the real work to write_rollout_in_sessions_with_cwd, keeping the common case short and readable.

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

**Purpose**: This helper creates a realistic one-line rollout file for tests, with a chosen current working directory and optional Git information. It acts like a tiny factory for session log files.

**Data flow**: The helper receives the temporary Codex home, filename timestamp, event timestamp, thread UUID, working directory, and optional Git data. It creates a sessions folder, builds a rollout filename, constructs a session metadata object, wraps it in a rollout line, serializes that line as JSON, writes it to disk, and returns the new file path.

**Call relations**: This is the lower-level test helper used directly by the working-directory normalization test and indirectly by write_rollout_in_sessions. The rollout files it creates become the input that metadata extraction and backfill read during the tests.

*Call graph*: calls 1 internal fn (from_string); called by 2 (backfill_sessions_normalizes_cwd_before_upsert, write_rollout_in_sessions); 9 external calls (create, join, to_string, default, format!, SessionMeta, to_string, create_dir_all, writeln!).


### `rollout/src/session_index_tests.rs`

`test` · `test run`

The session index is like a notebook that records conversation thread IDs, their human-readable names, and when each record was added. Because the notebook is append-only, the same thread or name can appear more than once. These tests check that lookups read the notebook from the back, so the most recent record wins.

The file builds small temporary fake session folders instead of touching a real user’s data. The helper `write_index` writes index entries as one JSON object per line. The helper `write_rollout_with_metadata` writes a tiny rollout file, which is the saved conversation file, containing just enough metadata to prove a thread really exists.

The tests cover normal cases and awkward edge cases. They check that looking up a name returns the newest matching thread ID, that looking up an ID returns its latest name, and that missing lookups return nothing. They also check safer behavior: if the newest index entry points to a rollout file that does not exist, or to an empty partial file, the lookup should skip it and fall back to an older valid saved session. One test also protects rename behavior, so an old name does not keep matching a thread after that same thread has been renamed.

#### Function details

##### `write_index`  (lines 13–20)

```
fn write_index(path: &Path, lines: &[SessionIndexEntry]) -> std::io::Result<()>
```

**Purpose**: This helper creates a fake session index file for the tests. It turns each `SessionIndexEntry` into a JSON line, matching the real index format closely enough for lookup code to read it.

**Data flow**: It receives a file path and a list of index entries. It builds one text string by converting each entry to JSON and adding a newline after it, then writes that text to disk. The result is either success or an input/output error if the file cannot be written.

**Call relations**: Most tests call this after creating temporary thread IDs and names. It prepares the index file that the lookup functions under test will later scan, so each test can control exactly what history the lookup sees.

*Call graph*: called by 8 (find_thread_id_by_name_prefers_latest_entry, find_thread_meta_by_name_str_ignores_historical_name_after_rename, find_thread_meta_by_name_str_skips_newest_entry_without_rollout, find_thread_meta_by_name_str_skips_partial_rollout, find_thread_name_by_id_prefers_latest_entry, find_thread_names_by_ids_prefers_latest_entry, scan_index_finds_latest_match_among_mixed_entries, scan_index_returns_none_when_entry_missing); 3 external calls (new, to_string, write).


##### `write_rollout_with_metadata`  (lines 22–51)

```
fn write_rollout_with_metadata(path: &Path, thread_id: ThreadId) -> std::io::Result<()>
```

**Purpose**: This helper creates a minimal saved rollout file for a thread. A rollout file is the stored record of a session, and this helper writes just enough session metadata for the lookup code to recognize it as valid.

**Data flow**: It receives a path and a thread ID. It builds a `RolloutLine` containing `SessionMeta`, serializes that line to JSON, and writes it as a single newline-terminated line to the target file. The output is success or an input/output error.

**Call relations**: The tests that check name-to-session lookup call this helper before writing the index. It gives the lookup code a real saved file to find, especially when comparing a valid older rollout against a newer missing or partial one.

*Call graph*: called by 3 (find_thread_meta_by_name_str_ignores_historical_name_after_rename, find_thread_meta_by_name_str_skips_newest_entry_without_rollout, find_thread_meta_by_name_str_skips_partial_rollout); 4 external calls (format!, SessionMeta, to_string, write).


##### `find_thread_id_by_name_prefers_latest_entry`  (lines 54–76)

```
fn find_thread_id_by_name_prefers_latest_entry() -> std::io::Result<()>
```

**Purpose**: This test proves that when two index entries have the same thread name, the lookup returns the one that was appended last. In plain terms, the newest note in the notebook wins.

**Data flow**: It creates a temporary index with two different thread IDs using the same name. After writing those entries, it scans the index from the end for that name and checks that the returned ID is the second one. Nothing permanent is changed outside the temporary directory.

**Call relations**: It uses `write_index` to set up the fake index, then exercises the index-scanning behavior directly. The assertion confirms that callers relying on name lookup get the latest matching entry rather than the first historical one.

*Call graph*: calls 2 internal fn (new, write_index); 3 external calls (new, assert_eq!, vec!).


##### `find_thread_meta_by_name_str_skips_newest_entry_without_rollout`  (lines 79–112)

```
async fn find_thread_meta_by_name_str_skips_newest_entry_without_rollout() -> std::io::Result<()>
```

**Purpose**: This test checks a safety rule: a newer name entry should not hide an older saved session if the newer thread has no rollout file. This matters because an index entry alone is not enough proof that a session can actually be resumed.

**Data flow**: It creates two thread IDs with the same name. The older ID gets a real rollout file with metadata, while the newer ID is only placed in the index. The name lookup runs and should return the older rollout path and metadata, skipping the newer entry because its saved file is missing.

**Call relations**: It calls `write_rollout_with_metadata` to create the valid saved session and `write_index` to create the competing index entries. It then calls the higher-level name-to-metadata lookup and verifies that lookup falls back to the usable rollout.

*Call graph*: calls 3 internal fn (new, write_index, write_rollout_with_metadata); 5 external calls (new, assert_eq!, format!, create_dir_all, vec!).


##### `find_thread_meta_by_name_str_skips_partial_rollout`  (lines 115–146)

```
async fn find_thread_meta_by_name_str_skips_partial_rollout() -> std::io::Result<()>
```

**Purpose**: This test checks that an empty or incomplete rollout file is treated as unusable. It protects against crashes or interrupted writes leaving behind files that should not be chosen for resume.

**Data flow**: It creates an older valid rollout file and a newer empty rollout file, both referenced by same-name index entries. The lookup by name reads the index and tries to find usable metadata. The expected result is the older valid rollout path, not the newer partial file.

**Call relations**: It uses `write_rollout_with_metadata` for the good file, a direct file write for the empty partial file, and `write_index` for the lookup history. The test then checks that the higher-level metadata lookup skips invalid saved data.

*Call graph*: calls 3 internal fn (new, write_index, write_rollout_with_metadata); 6 external calls (new, assert_eq!, format!, create_dir_all, write, vec!).


##### `find_thread_meta_by_name_str_ignores_historical_name_after_rename`  (lines 149–184)

```
async fn find_thread_meta_by_name_str_ignores_historical_name_after_rename() -> std::io::Result<()>
```

**Purpose**: This test protects rename behavior. If a thread used to have a name but was later renamed, searching for the old name should not return that renamed thread.

**Data flow**: It writes three index entries: one thread once had the name being searched for, another current thread has that name, and then the first thread is renamed to a different name. Only the current thread has a valid rollout for the searched name. The lookup returns the current thread’s rollout, showing that the renamed thread’s old name is ignored.

**Call relations**: It prepares the valid rollout with `write_rollout_with_metadata` and the name history with `write_index`. The higher-level lookup must combine index order with rename awareness so callers do not accidentally resume the wrong thread.

*Call graph*: calls 3 internal fn (new, write_index, write_rollout_with_metadata); 5 external calls (new, assert_eq!, format!, create_dir_all, vec!).


##### `find_thread_name_by_id_prefers_latest_entry`  (lines 187–211)

```
fn find_thread_name_by_id_prefers_latest_entry() -> std::io::Result<()>
```

**Purpose**: This test proves that looking up a thread ID returns its latest recorded name. That is important when a conversation has been renamed.

**Data flow**: It creates one thread ID with two index entries: first name `first`, then name `second`. After writing the index, it scans by ID and checks that the returned name is `second`. The temporary index is the only file it writes.

**Call relations**: It uses `write_index` to create the rename history, then calls the by-ID scanning path. The assertion confirms that features displaying a thread name will show the current name rather than an older one.

*Call graph*: calls 2 internal fn (new, write_index); 3 external calls (new, assert_eq!, vec!).


##### `scan_index_returns_none_when_entry_missing`  (lines 214–231)

```
fn scan_index_returns_none_when_entry_missing() -> std::io::Result<()>
```

**Purpose**: This test confirms that missing lookups return no result instead of inventing one or returning the wrong entry. It checks both missing name and missing ID cases.

**Data flow**: It writes an index containing one known thread. It then searches for a different name and a different thread ID. Both searches should come back as `None`, meaning no matching entry was found.

**Call relations**: It sets up the single-entry index through `write_index`, then exercises the direct scan helpers. This gives the rest of the system a clear contract: absence is reported cleanly.

*Call graph*: calls 2 internal fn (new, write_index); 3 external calls (new, assert_eq!, vec!).


##### `find_thread_names_by_ids_prefers_latest_entry`  (lines 234–269)

```
async fn find_thread_names_by_ids_prefers_latest_entry() -> std::io::Result<()>
```

**Purpose**: This test checks bulk lookup of names for several thread IDs. It makes sure each ID gets its own latest name, even when one of the IDs has been renamed.

**Data flow**: It writes an index where one thread ID appears twice with an older and newer name, and another ID appears once. It asks for names for both IDs as a set. The result should be a map from each ID to the correct latest name.

**Call relations**: It uses `write_index` to create the test history, then calls the asynchronous multi-ID lookup. The assertion shows that batch callers get the same latest-entry behavior as single-ID lookup.

*Call graph*: calls 2 internal fn (new, write_index); 5 external calls (new, new, new, assert_eq!, vec!).


##### `scan_index_finds_latest_match_among_mixed_entries`  (lines 272–313)

```
fn scan_index_finds_latest_match_among_mixed_entries() -> std::io::Result<()>
```

**Purpose**: This test checks that scanning from the end works even when the index contains a mix of matching and non-matching entries. It also documents that append order, not the timestamp text, decides what is latest.

**Data flow**: It writes several entries: older and newer matches for a target name, another thread with the same name, and an unrelated final entry. It then scans by name and by two different IDs. Each scan should return the last appended entry that matches its own condition.

**Call relations**: It relies on `write_index` for the mixed fake index, then calls the direct scan helpers. The test anchors the basic rule used by higher-level lookups: walk backward through the file and stop at the first relevant entry.

*Call graph*: calls 2 internal fn (new, write_index); 3 external calls (new, assert_eq!, vec!).


### `rollout/src/state_db_tests.rs`

`test` · `test suite`

A rollout is a saved conversation log, written as one JSON object per line. The state database turns those logs into a faster, queryable record of threads and their metadata. This test file checks a few edge cases where that process could go wrong.

First, it verifies that cursor timestamps are normalized into the same time format the database expects. That matters because cursors are used like bookmarks; if two timestamp formats mean the same moment but compare differently, listing or resuming history could skip or duplicate entries.

Second, it tests startup backfill behavior. A backfill is the catch-up job that scans old rollout files and loads them into the state database. These tests make sure a second startup waits if another process is already doing that work, but does not wait forever if the first process gets stuck. An everyday analogy is two librarians updating the same catalog: the second should wait for the first to finish, but not stand there forever if the first walks away.

Finally, it checks that reconciling a rollout does not overwrite a title the user or system explicitly set earlier. It may discover the first user message from the log, but it must not replace an already chosen title with an automatically inferred one.

#### Function details

##### `cursor_to_anchor_normalizes_timestamp_format`  (lines 19–31)

```
fn cursor_to_anchor_normalizes_timestamp_format()
```

**Purpose**: This test checks that a cursor timestamp written with dashes between the time parts is converted into the database's normal timestamp form. It protects code that uses cursors as stable bookmarks in chronological lists.

**Data flow**: It starts with the text timestamp `2026-01-27T12-34-56`. The test parses that text into a cursor, converts the cursor into an anchor, separately builds the expected UTC time value, and then compares the two. The expected outcome is that the anchor timestamp is the same moment, with nanoseconds cleared to zero.

**Call relations**: The test runner calls this function during the test suite. Inside it, the flow goes through `parse_cursor` and then the state code's cursor-to-anchor conversion; it also uses date parsing helpers to independently build the expected answer before comparing the result.

*Call graph*: calls 1 internal fn (parse_cursor); 3 external calls (from_naive_utc_and_offset, parse_from_str, assert_eq!).


##### `try_init_waits_for_concurrent_startup_backfill`  (lines 34–63)

```
async fn try_init_waits_for_concurrent_startup_backfill() -> anyhow::Result<()>
```

**Purpose**: This asynchronous test checks that state database startup behaves politely when another startup has already claimed the backfill job. It should wait until that existing backfill finishes, then continue successfully.

**Data flow**: It creates a temporary home directory, initializes a state runtime there, and claims the backfill lease to simulate another process already doing the catch-up scan. A background task waits briefly and then marks the backfill complete. Meanwhile, the test calls the normal initialization path. The result should be an initialized runtime whose backfill status is complete.

**Call relations**: The async test runner drives this function. It calls the state runtime initializer, uses a spawned background task with a short sleep to mimic a concurrent startup finishing its work, and then exercises the higher-level initialization path that must notice and wait for that completion.

*Call graph*: calls 1 internal fn (init); 6 external calls (new, assert!, assert_eq!, from_millis, spawn, sleep).


##### `try_init_times_out_waiting_for_stuck_startup_backfill`  (lines 66–92)

```
async fn try_init_times_out_waiting_for_stuck_startup_backfill() -> anyhow::Result<()>
```

**Purpose**: This asynchronous test checks the failure case for startup backfill coordination. If another process has claimed the backfill job but never finishes, initialization must eventually give up instead of hanging forever.

**Data flow**: It creates a temporary home directory, initializes the state runtime, and claims the backfill lease without ever marking it complete. Then it tries to initialize through the normal startup path. The expected output is an error, and the test checks that the error message says startup timed out waiting for the state database backfill.

**Call relations**: The async test runner calls this test. It uses the same initialization path as real startup, but deliberately leaves the simulated backfill incomplete so the timeout branch is exercised. If initialization returned success, the test would panic because that would mean stuck startup work was not detected.

*Call graph*: calls 1 internal fn (init); 3 external calls (new, assert!, panic!).


##### `reconcile_rollout_preserves_existing_explicit_title`  (lines 95–130)

```
async fn reconcile_rollout_preserves_existing_explicit_title() -> anyhow::Result<()>
```

**Purpose**: This asynchronous test makes sure reconciling a rollout file does not overwrite a thread title that was already explicitly saved. It protects user-visible thread names from being replaced by an automatic title based on the first message.

**Data flow**: It creates a temporary rollout file containing session metadata and one user message, then extracts metadata from that file. The extracted title and first user message are initially both `Hey`. The test changes the title to `math`, saves that thread to the state database, and then runs reconciliation on the same rollout file. Afterward, it reads the thread back and expects the title to still be `math`, while the first user message remains `Hey`.

**Call relations**: The async test runner starts this scenario. The helper `write_rollout_with_user_message` builds the small rollout file used as input. The test then calls metadata extraction, state runtime initialization, thread upsert, and rollout reconciliation, finally reading the persisted thread to confirm reconciliation preserved the explicit title.

*Call graph*: calls 4 internal fn (new, extract_metadata_from_rollout, write_rollout_with_user_message, init); 2 external calls (new, assert_eq!).


##### `write_rollout_with_user_message`  (lines 132–181)

```
fn write_rollout_with_user_message(
    home: &Path,
    thread_id: ThreadId,
    message: &str,
) -> anyhow::Result<std::path::PathBuf>
```

**Purpose**: This helper creates a tiny realistic rollout file for tests: one session metadata line followed by one user message line. It gives the reconciliation test an on-disk conversation log to read, instead of relying on mocked data.

**Data flow**: It receives a home directory, a thread id, and message text. It creates the expected dated `sessions/...` folder, builds a rollout filename that includes the timestamp and thread id, constructs two rollout records, serializes them as JSON lines, writes them to disk, and returns the path to the file it created.

**Call relations**: This helper is called by `reconcile_rollout_preserves_existing_explicit_title` when that test needs a real rollout file. It hands back the file path, which the test then passes into metadata extraction and reconciliation so those parts read data in the same shape they would see in normal use.

*Call graph*: called by 1 (reconcile_rollout_preserves_existing_explicit_title); 9 external calls (default, join, to_path_buf, format!, UserMessage, EventMsg, SessionMeta, create_dir_all, write).


### `rollout/src/recorder_tests.rs`

`test` · `test suite`

A rollout is a saved log of a session, stored as a JSON Lines file, meaning one JSON record per line. This test file builds small fake session histories in temporary folders and checks that the recorder can read, write, list, and repair them correctly. It matters because users rely on these saved sessions to resume work, search past conversations, and see accurate thread lists. If this behavior broke, sessions could disappear from listings, stale database entries could point to missing files, or buffered conversation events could be lost.

The tests cover two storage views working together: the rollout files on disk and a state database, which is a faster index of session metadata. Some tests check that startup backfills the database from existing files before reporting ready. Others check that listing sessions still works when the database is off, or that stale database paths are repaired or removed when files disagree. The file also tests compatibility with older rollout records, such as legacy “ghost snapshot” entries that should be ignored, while preserving older guardian assessment records. Several tests focus on write safety: the recorder may delay creating a file until there is something real to save, and it must retry cleanly after file-system errors. Overall, this is a safety net for session history durability and discoverability.

#### Function details

##### `test_config`  (lines 29–37)

```
fn test_config(codex_home: &Path) -> RolloutConfig
```

**Purpose**: Builds a small test-only rollout configuration rooted in a temporary folder. Tests use it so they can exercise real file and database code without touching a user's real home directory.

**Data flow**: It receives a path for the fake Codex home directory. It copies that path into the configuration fields for session storage, SQLite storage, and current working directory, adds a fixed test model provider name, and returns the completed RolloutConfig.

**Call relations**: Many tests call this helper before creating a RolloutRecorder or listing threads. It supplies the shared setup needed by database backfill, pagination, stale-path repair, filtering, and write-retry tests.

*Call graph*: called by 10 (list_threads_db_disabled_does_not_skip_paginated_items, list_threads_db_enabled_drops_missing_rollout_paths, list_threads_db_enabled_repairs_stale_rollout_paths, list_threads_default_filter_returns_filesystem_scan_results, list_threads_metadata_filter_overlays_state_db_list_metadata, list_threads_search_repairs_stale_state_db_hits_before_returning, list_threads_state_db_only_skips_jsonl_repair_scan, persist_reports_filesystem_error_and_retries_buffered_items, recorder_materializes_on_flush_with_pending_items, state_db_init_backfills_before_returning); 1 external calls (to_path_buf).


##### `write_session_file`  (lines 39–69)

```
fn write_session_file(root: &Path, ts: &str, uuid: Uuid) -> std::io::Result<PathBuf>
```

**Purpose**: Creates a minimal fake rollout file on disk for tests that need an existing saved session. It writes just enough data for the recorder to recognize a session and its first user message.

**Data flow**: It receives a root folder, timestamp text, and UUID. It creates the expected dated sessions directory, writes a JSON Lines file containing a session metadata record and a user message record, and returns the file path it created.

**Call relations**: Thread-listing and resume tests call this helper to seed the file system with known sessions. Those tests then ask the recorder or resume-matching logic to find, repair, filter, or inspect the file.

*Call graph*: called by 6 (list_threads_db_disabled_does_not_skip_paginated_items, list_threads_db_enabled_repairs_stale_rollout_paths, list_threads_default_filter_returns_filesystem_scan_results, list_threads_metadata_filter_overlays_state_db_list_metadata, list_threads_search_repairs_stale_state_db_hits_before_returning, resume_candidate_matches_cwd_reads_latest_turn_context); 6 external calls (create, join, format!, create_dir_all, json!, writeln!).


##### `state_db_init_backfills_before_returning`  (lines 72–145)

```
async fn state_db_init_backfills_before_returning() -> anyhow::Result<()>
```

**Purpose**: Checks that state database initialization does not finish until existing rollout files have been indexed. This protects callers from seeing an empty database immediately after startup when session files already exist.

**Data flow**: The test creates a temporary rollout file with session metadata and a user message, then calls the state database initialization using a test config. It reads the thread metadata back from the database and verifies that the rollout path is present and the backfill status is complete.

**Call relations**: The Rust async test runner invokes this test. Inside it, the test builds a thread id, uses test_config, calls crate::state_db::init, and then queries the returned runtime to confirm the startup backfill happened before control returned.

*Call graph*: calls 3 internal fn (from_string, test_config, init); 11 external calls (default, new, new_v4, new, assert_eq!, format!, create_dir_all, write, UserMessage, EventMsg (+1 more)).


##### `load_rollout_items_skips_legacy_ghost_snapshot_lines`  (lines 148–220)

```
async fn load_rollout_items_skips_legacy_ghost_snapshot_lines() -> std::io::Result<()>
```

**Purpose**: Verifies that old rollout files containing legacy ghost snapshot response items can still be loaded. The important behavior is that those obsolete entries are silently skipped rather than causing a parse failure.

**Data flow**: The test writes a rollout file with session metadata, a legacy ghost snapshot response item, and a normal assistant message. It then loads the file and checks that the thread id was found, there were no parse errors, and only the metadata plus normal message remain.

**Call relations**: The test runner calls this test, which directly exercises RolloutRecorder::load_rollout_items. It creates the file by hand so the loader is tested against the old JSON shape exactly.

*Call graph*: calls 2 internal fn (new, load_rollout_items); 5 external calls (create, new, assert!, assert_eq!, writeln!).


##### `load_rollout_items_preserves_legacy_guardian_assessment_lines`  (lines 223–282)

```
async fn load_rollout_items_preserves_legacy_guardian_assessment_lines() -> std::io::Result<()>
```

**Purpose**: Checks that another older record type, guardian assessment events, is still accepted and preserved. This prevents backward compatibility code from being too aggressive and deleting useful historical data.

**Data flow**: The test writes session metadata and a guardian assessment event in the old JSON format. It loads the rollout, confirms there are no parse errors, then inspects the second item to make sure the assessment id and turn id survived and missing newer timing data defaults safely.

**Call relations**: The async test runner invokes it. It calls RolloutRecorder::load_rollout_items and focuses on the loader's legacy-event conversion path.

*Call graph*: calls 2 internal fn (new, load_rollout_items); 5 external calls (create, new, assert_eq!, panic!, writeln!).


##### `load_rollout_items_filters_legacy_ghost_snapshots_from_compaction_history`  (lines 285–362)

```
async fn load_rollout_items_filters_legacy_ghost_snapshots_from_compaction_history() -> std::io::Result<()>
```

**Purpose**: Makes sure legacy ghost snapshot records are removed even when they are buried inside a compacted history record. Compaction means older conversation history has been summarized, with a replacement list kept for context.

**Data flow**: The test writes a rollout containing session metadata and a compacted record whose replacement history includes one normal assistant message and one obsolete ghost snapshot. After loading, it checks that the compacted item remains but its replacement history contains only the valid assistant message.

**Call relations**: The test runner calls this test, which exercises RolloutRecorder::load_rollout_items. It complements the top-level ghost snapshot test by covering nested history cleanup.

*Call graph*: calls 2 internal fn (new, load_rollout_items); 6 external calls (create, new, assert!, assert_eq!, panic!, writeln!).


##### `recorder_materializes_on_flush_with_pending_items`  (lines 365–443)

```
async fn recorder_materializes_on_flush_with_pending_items() -> std::io::Result<()>
```

**Purpose**: Checks that a recorder can delay creating its rollout file until there is real content to write, then create it during flush. It also verifies that buffered events keep their order and that persisting twice is safe.

**Data flow**: The test creates a recorder in a temporary home and confirms the target file does not yet exist. It records an agent event, flushes, records a user event, flushes again, calls persist twice, then reads the file to verify metadata exists, messages are in the expected order, and the second persist did not change the file.

**Call relations**: The async test runner invokes it. It uses test_config, constructs RolloutRecorderParams and RolloutRecorder, then calls record_canonical_items, flush, persist, and shutdown to test the writer's normal lifecycle.

*Call graph*: calls 5 internal fn (default, new, new, new, test_config); 9 external calls (default, new, new, assert!, assert_eq!, AgentMessage, UserMessage, EventMsg, read_to_string).


##### `persist_reports_filesystem_error_and_retries_buffered_items`  (lines 446–497)

```
async fn persist_reports_filesystem_error_and_retries_buffered_items() -> std::io::Result<()>
```

**Purpose**: Ensures that a failed attempt to create the rollout file reports a real file-system error and does not lose pending conversation items. This is important when directories are temporarily blocked or unavailable.

**Data flow**: The test records an event, then deliberately creates a file where the sessions directory should be, making persistence fail. After confirming the rollout file was not created, it removes the blocker, flushes again, and checks that the originally buffered event was written.

**Call relations**: The test runner calls it. It uses test_config and RolloutRecorder to drive the same persist and flush path the application uses, but injects a file-system obstacle between recording and persistence.

*Call graph*: calls 5 internal fn (default, new, new, new, test_config); 9 external calls (create, new, new, assert!, assert_ne!, remove_file, AgentMessage, EventMsg, read_to_string).


##### `writer_state_retries_write_error_before_reporting_flush_success`  (lines 500–527)

```
async fn writer_state_retries_write_error_before_reporting_flush_success() -> std::io::Result<()>
```

**Purpose**: Tests the lower-level writer state's recovery from a write failure. It proves flush can reopen the rollout file and write queued items before claiming success.

**Data flow**: The test creates a rollout path, opens it read-only, and gives that unsuitable file handle to RolloutWriterState. It queues an event, calls flush, then reads the file and checks that the queued message was written after the retry.

**Call relations**: The async test runner invokes it. Unlike the higher-level recorder tests, this one talks directly to RolloutWriterState::new, add_items, and flush to isolate write-retry behavior.

*Call graph*: calls 1 internal fn (new); 7 external calls (create, new, assert!, new, read_to_string, from_std, vec!).


##### `list_threads_db_disabled_does_not_skip_paginated_items`  (lines 530–574)

```
async fn list_threads_db_disabled_does_not_skip_paginated_items() -> std::io::Result<()>
```

**Purpose**: Checks that listing sessions from files still paginates correctly when the state database is not used. Pagination means returning results in pages, like page 1 and page 2 of search results.

**Data flow**: The test writes three session files with known dates. It asks RolloutRecorder::list_threads for one newest item, saves the returned cursor, then asks for the next page and verifies it gets the middle item rather than skipping it.

**Call relations**: The test runner calls it. It uses test_config and write_session_file to create input data, then calls RolloutRecorder::list_threads with no state database context to exercise the file-system listing path.

*Call graph*: calls 3 internal fn (list_threads, test_config, write_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `list_threads_db_enabled_drops_missing_rollout_paths`  (lines 577–639)

```
async fn list_threads_db_enabled_drops_missing_rollout_paths() -> std::io::Result<()>
```

**Purpose**: Verifies that a database entry pointing to a missing rollout file is not shown to the user. It also checks that the stale database pointer is removed.

**Data flow**: The test inserts thread metadata into the state database with a rollout path that does not exist on disk. It lists threads with the database enabled, expects no returned items, and then asks the database for that thread path to confirm it was cleared.

**Call relations**: The async test runner invokes it. It uses test_config, initializes codex_state::StateRuntime, inserts metadata, and then calls RolloutRecorder::list_threads to trigger stale-path cleanup.

*Call graph*: calls 5 internal fn (from_string, list_threads, test_config, new, init); 4 external calls (new, from_u128, assert_eq!, format!).


##### `list_threads_db_enabled_repairs_stale_rollout_paths`  (lines 642–707)

```
async fn list_threads_db_enabled_repairs_stale_rollout_paths() -> std::io::Result<()>
```

**Purpose**: Checks that if the database points to the wrong path but a real rollout file for the same thread exists, listing repairs the database instead of hiding the session. This keeps old or moved records usable.

**Data flow**: The test creates a real session file, inserts database metadata for the same thread id but with a fake stale path, and lists threads. It expects the returned item to use the real file path, then confirms the database now stores that repaired path.

**Call relations**: The test runner calls it. It combines write_session_file, a manually seeded StateRuntime entry, and RolloutRecorder::list_threads to test the repair bridge between disk and database.

*Call graph*: calls 6 internal fn (from_string, list_threads, test_config, write_session_file, new, init); 4 external calls (new, from_u128, assert_eq!, format!).


##### `list_threads_state_db_only_skips_jsonl_repair_scan`  (lines 710–805)

```
async fn list_threads_state_db_only_skips_jsonl_repair_scan() -> std::io::Result<()>
```

**Purpose**: Shows the difference between listing only from the state database and doing the full listing that can scan JSON Lines files. A database-only query should be fast and should not repair missing index entries by reading disk.

**Data flow**: The test creates a rollout file on disk but does not insert it into the database. A state-database-only listing returns no items. A normal listing then scans the file system and returns the item. After that repair, a database-only listing also returns it.

**Call relations**: The async test runner invokes it. It calls both RolloutRecorder::list_threads_from_state_db and RolloutRecorder::list_threads to prove that only the full listing path performs the JSONL repair scan.

*Call graph*: calls 4 internal fn (list_threads, list_threads_from_state_db, test_config, init); 8 external calls (create, new, from_u128, assert_eq!, format!, create_dir_all, json!, writeln!).


##### `list_threads_default_filter_returns_filesystem_scan_results`  (lines 808–896)

```
async fn list_threads_default_filter_returns_filesystem_scan_results() -> std::io::Result<()>
```

**Purpose**: Checks that the default listing path trusts the current file contents over stale database metadata when filters are involved. This avoids showing a session under an old working-directory filter after the file tells a different story.

**Data flow**: The test writes a real session file, then inserts database metadata for it with a stale current working directory. A database-only listing with that stale directory filter finds the item. A normal listing scans the file and returns none for that stale filter, then the database-only result also becomes empty after repair.

**Call relations**: The test runner calls it. It uses write_session_file and StateRuntime setup, compares list_threads_from_state_db with list_threads, and confirms the full listing path repairs stale metadata.

*Call graph*: calls 7 internal fn (from_string, list_threads, list_threads_from_state_db, test_config, write_session_file, new, init); 3 external calls (new, from_u128, assert_eq!).


##### `list_threads_metadata_filter_overlays_state_db_list_metadata`  (lines 899–963)

```
async fn list_threads_metadata_filter_overlays_state_db_list_metadata() -> std::io::Result<()>
```

**Purpose**: Verifies that when a listed thread has extra metadata in the state database, that metadata is copied onto the item returned from listing. In this test, the important fields are Git details such as branch, commit hash, and origin URL.

**Data flow**: The test creates a session file and database metadata for the same thread, including Git fields. It lists threads filtered by session source and checks that the returned item includes the Git values from the database.

**Call relations**: The async test runner invokes it. It uses write_session_file to provide the disk record, StateRuntime to store richer metadata, and RolloutRecorder::list_threads to verify the two sources are merged.

*Call graph*: calls 6 internal fn (from_string, list_threads, test_config, write_session_file, new, init); 3 external calls (new, from_u128, assert_eq!).


##### `fill_missing_thread_item_metadata_preserves_identity_and_prefers_state_git_fields`  (lines 966–1031)

```
fn fill_missing_thread_item_metadata_preserves_identity_and_prefers_state_git_fields()
```

**Purpose**: Tests the metadata merge rule for a listed thread item. The merge should not change the item's identity, but it should fill missing details and prefer fresher Git fields from the state database.

**Data flow**: The test builds one ThreadItem as if it came from the file system and another as if it came from the database. It calls fill_missing_thread_item_metadata, then checks that path, thread id, first user message, and preview stayed from the file-system item, while missing fields and Git values were filled from the database item.

**Call relations**: This synchronous unit test is called by the test runner. It directly exercises fill_missing_thread_item_metadata, the helper used by thread-listing code when combining file-system and database views.

*Call graph*: calls 1 internal fn (new); 2 external calls (from, assert_eq!).


##### `list_threads_search_repairs_stale_state_db_hits_before_returning`  (lines 1034–1121)

```
async fn list_threads_search_repairs_stale_state_db_hits_before_returning() -> std::io::Result<()>
```

**Purpose**: Checks that search results from stale database metadata are verified against the actual rollout file before being returned. This prevents a search term from matching old indexed text that no longer appears in the real session summary.

**Data flow**: The test creates a rollout file, then stores database metadata whose title contains the search word “needle.” A database-only search finds it. A normal listing with the same search scans and repairs the mismatch, returns no items, and afterward the database-only search also returns none.

**Call relations**: The async test runner invokes it. It compares RolloutRecorder::list_threads_from_state_db with RolloutRecorder::list_threads to show that the full listing path repairs stale search hits.

*Call graph*: calls 7 internal fn (from_string, list_threads, list_threads_from_state_db, test_config, write_session_file, new, init); 3 external calls (new, from_u128, assert_eq!).


##### `resume_candidate_matches_cwd_reads_latest_turn_context`  (lines 1124–1168)

```
async fn resume_candidate_matches_cwd_reads_latest_turn_context() -> std::io::Result<()>
```

**Purpose**: Verifies that resume matching uses the latest turn context in a rollout file, not only the older session metadata. A turn context is a saved snapshot of a conversation turn's working directory and execution settings.

**Data flow**: The test creates a session file, appends a later turn context with a newer current working directory, and then asks resume_candidate_matches_cwd whether the file matches that newer directory even when an older stale directory is provided. It expects the match to succeed.

**Call relations**: The async test runner calls this test. It uses write_session_file for the base rollout, appends a RolloutLine::TurnContext record, and then calls resume_candidate_matches_cwd to check resume-selection behavior.

*Call graph*: calls 1 internal fn (write_session_file); 8 external calls (new, from_u128, new_read_only_policy, assert!, create_dir_all, TurnContext, new, writeln!).


### `rollout/src/tests.rs`

`test` · `test run`

A rollout session is stored as a JSON-lines file: one JSON object per line, like a notebook where each page records one event. This test file creates small temporary versions of those notebooks and asks the real rollout listing and lookup code to read them. The tests protect important user-facing behavior: newest conversations appear first, pagination does not repeat items, filters for source and model provider work, previews come from the right message or goal, and updated times come from the file’s last modified time.

The file also checks the relationship between the filesystem and the state database. The database can remember where a thread’s rollout file lives, but that memory can be stale or missing. These tests make sure lookup falls back to scanning files when needed and then repairs the database, like checking a shelf when the catalog card points to the wrong book.

Several helper functions write realistic session files with different shapes: normal sessions, goal-first sessions, delayed user messages, missing optional metadata, and custom model providers. That keeps the tests close to real data without depending on existing user files.

#### Function details

##### `provider_vec`  (lines 48–53)

```
fn provider_vec(providers: &[&str]) -> Vec<String>
```

**Purpose**: This small helper turns a list of provider names into owned strings, in the exact shape expected by the thread-listing API. Tests use it so their provider filters are easy to read.

**Data flow**: It receives a slice of text references such as "openai" or "test-provider". It copies each name into a new String and returns them as a vector, leaving the original list unchanged.

**Call relations**: Many listing tests call this just before calling get_threads, because get_threads expects provider filters as string values. It does not call any project logic; it simply prepares test input.

*Call graph*: called by 13 (test_base_instructions_missing_in_meta_defaults_to_null, test_base_instructions_present_in_meta_is_preserved, test_created_at_sort_uses_file_mtime_for_updated_at, test_get_thread_contents, test_goal_first_thread_reads_later_user_message, test_list_conversations_latest_first, test_list_threads_scans_past_head_for_user_event, test_list_threads_uses_goal_objective_as_preview, test_model_provider_filter_selects_only_matching_sessions, test_pagination_cursor (+3 more)).


##### `thread_id_from_uuid`  (lines 55–57)

```
fn thread_id_from_uuid(uuid: Uuid) -> ThreadId
```

**Purpose**: This helper converts a UUID into the project’s ThreadId type. Tests use it when they need to compare a session file’s UUID with the thread identifier returned by rollout code.

**Data flow**: It receives a UUID, turns it into normal UUID text, asks ThreadId to parse that text, and returns the resulting ThreadId. If parsing failed, the test would stop, because the UUID should always be valid.

**Call relations**: write_goal_started_session_file uses this when creating a fake goal update event. That lets the generated event carry the same thread identity that the listing code will later read.

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

**Purpose**: This helper creates a state-database record for a fake thread. It is used to test what happens when the database knows about a thread, including cases where its stored rollout path is wrong.

**Data flow**: It receives a temporary home directory, a thread id, a rollout file path, and an archived flag. It initializes the state database, marks its backfill as complete, builds thread metadata with a known provider and first user message, writes that metadata into the database, and returns the database runtime handle.

**Call relations**: The thread-path lookup tests call this to set up the database before asking find_thread_path_by_id_str to locate a file. It hands back a runtime so those tests can exercise the database-first lookup path.

*Call graph*: calls 2 internal fn (new, init); called by 3 (find_thread_path_accepts_existing_state_db_path_without_canonical_filename, find_thread_path_falls_back_when_db_path_is_stale, find_thread_path_falls_back_when_db_path_points_to_another_thread); 1 external calls (to_path_buf).


##### `find_thread_path_falls_back_when_db_path_is_stale`  (lines 98–130)

```
async fn find_thread_path_falls_back_when_db_path_is_stale()
```

**Purpose**: This test proves that lookup still finds a session file when the database points to a path that no longer exists. It also checks that the database is repaired afterward.

**Data flow**: It creates a temporary home, writes a real session file, inserts a database row pointing to a fake future path, then asks for the thread path by id. The expected result is the real file path from disk, and the database should now store that corrected path.

**Call relations**: The test uses write_session_file and insert_state_db_thread to create the mismatch, calls find_thread_path_by_id_str as the behavior under test, and then calls assert_state_db_rollout_path to confirm the repair.

*Call graph*: calls 4 internal fn (from_string, assert_state_db_rollout_path, insert_state_db_thread, write_session_file); 5 external calls (new, from_u128, assert_eq!, find_thread_path_by_id_str, format!).


##### `find_thread_path_falls_back_when_db_path_points_to_another_thread`  (lines 133–175)

```
async fn find_thread_path_falls_back_when_db_path_points_to_another_thread()
```

**Purpose**: This test checks a more dangerous stale-database case: the stored path exists, but belongs to a different thread. Lookup must not return the wrong person’s conversation.

**Data flow**: It writes one session file for the target thread and another for a different thread, then inserts a database row for the target that points at the other file. Lookup should reject that bad database path, scan the filesystem, return the correct target file, and update the database.

**Call relations**: The test sets up files with write_session_file, sets up the bad database row with insert_state_db_thread, calls find_thread_path_by_id_str, and verifies the database correction with assert_state_db_rollout_path.

*Call graph*: calls 4 internal fn (from_string, assert_state_db_rollout_path, insert_state_db_thread, write_session_file); 5 external calls (new, from_u128, assert_eq!, find_thread_path_by_id_str, format!).


##### `find_thread_path_repairs_missing_db_row_after_filesystem_fallback`  (lines 178–208)

```
async fn find_thread_path_repairs_missing_db_row_after_filesystem_fallback()
```

**Purpose**: This test makes sure a missing database record can be recreated from the rollout file on disk. That matters when old sessions exist before the database has learned about them.

**Data flow**: It writes a session file and initializes an empty state database whose backfill is marked complete. When lookup by id runs, it should scan files, find the matching rollout, return its path, and insert the missing path into the database.

**Call relations**: This test directly initializes the state runtime, calls find_thread_path_by_id_str to exercise fallback scanning, and then uses assert_state_db_rollout_path to prove the fallback also repaired state.

*Call graph*: calls 4 internal fn (from_string, assert_state_db_rollout_path, write_session_file, init); 5 external calls (new, from_u128, assert_eq!, find_thread_path_by_id_str, format!).


##### `find_thread_path_accepts_existing_state_db_path_without_canonical_filename`  (lines 211–231)

```
async fn find_thread_path_accepts_existing_state_db_path_without_canonical_filename()
```

**Purpose**: This test confirms that a valid database path is accepted even if the file name does not follow the normal rollout naming pattern. The database is allowed to be the source of truth when its file exists and matches the thread.

**Data flow**: It creates an empty custom-named JSON-lines file, inserts a database thread record pointing at that custom path, and asks lookup for the thread. The result should be exactly the database path, not a reconstructed canonical file name.

**Call relations**: The test uses insert_state_db_thread to populate the database and then calls find_thread_path_by_id_str. Unlike the stale-path tests, it does not expect a filesystem search to replace the database answer.

*Call graph*: calls 2 internal fn (from_string, insert_state_db_thread); 6 external calls (new, from_u128, assert_eq!, find_thread_path_by_id_str, create_dir_all, write).


##### `rollout_date_parts_extracts_directory_components`  (lines 234–241)

```
fn rollout_date_parts_extracts_directory_components()
```

**Purpose**: This test checks that a rollout file name can be parsed into year, month, and day directory pieces. That supports placing and finding files in the expected date-based folder layout.

**Data flow**: It supplies a sample rollout file name, calls rollout_date_parts, and expects the returned pieces to be "2025", "03", and "01". Nothing is written to disk.

**Call relations**: This is a direct unit test of rollout_date_parts. It does not use the larger listing flow; it checks one small parsing rule in isolation.

*Call graph*: 3 external calls (new, assert_eq!, rollout_date_parts).


##### `assert_state_db_rollout_path`  (lines 243–256)

```
async fn assert_state_db_rollout_path(
    home: &Path,
    thread_id: ThreadId,
    expected_path: Option<&Path>,
)
```

**Purpose**: This helper checks what rollout path the state database currently stores for a given thread. Tests use it after fallback lookup to prove the database was repaired, not just that lookup returned the right answer once.

**Data flow**: It receives a home directory, a thread id, and the path expected in the database. It opens the state database, looks up the rollout path for that thread, and asserts that the stored path matches the expected value.

**Call relations**: The fallback-and-repair tests call this after find_thread_path_by_id_str. It serves as the final inspection step for database state.

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

**Purpose**: This convenience helper writes a normal fake session file using the default test model provider. Most tests use it when they need a realistic rollout file without customizing provider metadata.

**Data flow**: It receives a root directory, timestamp text, UUID, record count, and optional source. It forwards those values to write_session_file_with_provider with the default provider, and returns the timestamp and UUID from that lower-level helper.

**Call relations**: Many tests call this before calling get_threads or find_thread_path_by_id_str. It keeps test setup short while delegating the actual file creation to write_session_file_with_provider.

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

**Purpose**: This helper writes a realistic JSON-lines session file, optionally including a specific model provider. It is the main test factory for normal rollout files.

**Data flow**: It parses the timestamp, creates the matching sessions/year/month/day directory, writes a session metadata line, writes a first user-message event, writes the requested number of extra response records, sets the file’s modified time to the session time, and returns the parsed time and UUID.

**Call relations**: write_session_file calls this with the standard test provider. The model-provider filtering test calls it directly to create sessions from different providers, including one with no provider field.

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

**Purpose**: This helper writes a fake session whose first meaningful event is a thread goal, not a user message. It lets tests verify that goal-based sessions still get useful previews.

**Data flow**: It receives a root directory, timestamp, UUID, goal objective, and optional later user message. It creates the rollout file, writes session metadata, writes a thread-goal-updated event with the objective, optionally writes a later user message, and sets the file’s modified time.

**Call relations**: The goal preview tests call this before get_threads. It uses thread_id_from_uuid so the goal event and the file metadata describe the same thread.

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

**Purpose**: This helper creates a session where the first user message appears only after several metadata lines. It tests that summary-reading code looks far enough into a file to find the user’s first message.

**Data flow**: It receives a root directory, timestamp, UUID, and number of metadata lines to write before the user event. It creates the dated rollout file, writes that many metadata lines, then writes one user-message event and sets the modified time.

**Call relations**: test_list_threads_scans_past_head_for_user_event uses this to set up a file with a delayed user event, then calls get_threads to make sure the listing still includes and identifies the thread.

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

**Purpose**: This helper writes a session file using an exact metadata payload chosen by the test. It is useful for checking how optional metadata fields are preserved or defaulted.

**Data flow**: It receives a root directory, timestamp, UUID, and JSON payload. It creates the dated rollout file, writes that payload as the session metadata line, adds a simple user-message event, sets the modified time, and returns success or an I/O error.

**Call relations**: The base-instructions tests call this to create metadata with and without the base_instructions field, then use get_threads and read_head_for_summary to inspect how the summary reader sees it.

*Call graph*: called by 2 (test_base_instructions_missing_in_meta_defaults_to_null, test_base_instructions_present_in_meta_is_preserved); 9 external calls (create, new, join, parse, format!, format_description!, create_dir_all, json!, writeln!).


##### `test_list_conversations_latest_first`  (lines 525–660)

```
async fn test_list_conversations_latest_first()
```

**Purpose**: This test verifies that conversation listing returns sessions newest first when sorting by creation time. It also checks that each listed item contains the expected summary fields.

**Data flow**: It writes three sessions on three different dates, asks get_threads for a large enough page, and compares the returned ThreadsPage to an expected page ordered January 3, January 2, January 1. The comparison includes paths, thread ids, preview text, source, provider, and timestamps.

**Call relations**: The test uses write_session_file to create input files and provider_vec to prepare the provider filter, then calls get_threads as the system behavior under test.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 5 external calls (new, from_u128, assert_eq!, format!, vec!).


##### `test_pagination_cursor`  (lines 663–905)

```
async fn test_pagination_cursor()
```

**Purpose**: This test checks that conversation listing can be split across pages using a cursor, which is a bookmark saying where the previous page ended. It protects against missing or repeating conversations while paging.

**Data flow**: It writes five sessions from oldest to newest. It requests two items at a time, verifies page one contains the two newest sessions and a cursor, page two contains the next two, and page three contains the last one with no further cursor.

**Call relations**: The test repeatedly calls get_threads, passing the previous page’s cursor into the next call. It uses write_session_file for setup and provider_vec for the model-provider filter.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 6 external calls (new, from_u128, assert_eq!, format!, from_str, vec!).


##### `test_list_threads_scans_past_head_for_user_event`  (lines 908–933)

```
async fn test_list_threads_scans_past_head_for_user_event()
```

**Purpose**: This test ensures the listing code does not give up too early when a session’s first user message is not near the top of the file. Without this, valid sessions could be skipped or summarized poorly.

**Data flow**: It writes one session with many metadata lines before the user event, asks get_threads for sessions, and expects exactly one item whose thread id matches the file’s UUID.

**Call relations**: The test relies on write_session_file_with_delayed_user_event to create the unusual file shape, then calls get_threads to verify the real summary-scanning behavior.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file_with_delayed_user_event); 3 external calls (new, from_u128, assert_eq!).


##### `test_list_threads_uses_goal_objective_as_preview`  (lines 936–970)

```
async fn test_list_threads_uses_goal_objective_as_preview()
```

**Purpose**: This test checks that a goal-first thread uses the goal objective as its preview text when there is no user message. That gives users a meaningful label for automated or goal-driven sessions.

**Data flow**: It writes a session containing a thread goal objective and no later user message. After listing threads, it expects one item with the correct thread id, preview set to the objective, and no first_user_message.

**Call relations**: The test uses write_goal_started_session_file for setup, provider_vec for filtering input, and get_threads to read the summary.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_goal_started_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `test_goal_first_thread_reads_later_user_message`  (lines 973–1010)

```
async fn test_goal_first_thread_reads_later_user_message()
```

**Purpose**: This test verifies that a goal-first thread can still record a later user message separately from its preview. The preview should remain the goal, while first_user_message should reflect what the user later said.

**Data flow**: It writes a session with a goal objective followed by a user message. Listing should return one item whose preview is the goal objective and whose first_user_message is the later message.

**Call relations**: The test creates the mixed goal-and-message file with write_goal_started_session_file, then calls get_threads to confirm both summary fields are populated correctly.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_goal_started_session_file); 3 external calls (new, from_u128, assert_eq!).


##### `test_get_thread_contents`  (lines 1013–1101)

```
async fn test_get_thread_contents()
```

**Purpose**: This test checks both that a listed thread points to the correct rollout file and that the file contents are exactly what the helper wrote. It connects summary listing with the raw session file on disk.

**Data flow**: It writes a session with two response records, lists one thread, reads the returned file path, and compares both the ThreadsPage and the full file text against expected JSON-lines content.

**Call relations**: The test uses write_session_file to create the rollout, provider_vec and get_threads to find it, then tokio file reading to inspect the path returned by the listing code.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 7 external calls (new, new_v4, assert_eq!, format!, json!, read_to_string, vec!).


##### `test_base_instructions_missing_in_meta_defaults_to_null`  (lines 1104–1143)

```
async fn test_base_instructions_missing_in_meta_defaults_to_null()
```

**Purpose**: This test checks backward compatibility for old metadata that lacks base_instructions. The summary reader should present that missing field as JSON null instead of leaving it absent.

**Data flow**: It writes a session metadata payload without base_instructions, lists the thread, reads the head summary from the file, and asserts that the first summary object contains base_instructions set to null.

**Call relations**: The test uses write_session_file_with_meta_payload to create the exact metadata shape, get_threads to locate the file, and read_head_for_summary to inspect the normalized summary data.

*Call graph*: calls 4 internal fn (get_threads, read_head_for_summary, provider_vec, write_session_file_with_meta_payload); 4 external calls (new, from_u128, assert_eq!, json!).


##### `test_base_instructions_present_in_meta_is_preserved`  (lines 1146–1188)

```
async fn test_base_instructions_present_in_meta_is_preserved()
```

**Purpose**: This test makes sure existing base_instructions metadata is not erased or replaced. If a session recorded custom instructions, summary reading should keep them intact.

**Data flow**: It writes metadata containing base_instructions with a text value, lists the thread, reads the head summary, extracts that text, and checks it matches the original custom instructions.

**Call relations**: Like the missing-field test, it uses write_session_file_with_meta_payload for setup, then get_threads and read_head_for_summary to verify what the rollout summary code returns.

*Call graph*: calls 4 internal fn (get_threads, read_head_for_summary, provider_vec, write_session_file_with_meta_payload); 4 external calls (new, from_u128, assert_eq!, json!).


##### `test_created_at_sort_uses_file_mtime_for_updated_at`  (lines 1191–1242)

```
async fn test_created_at_sort_uses_file_mtime_for_updated_at() -> Result<()>
```

**Purpose**: This test proves that even when sessions are sorted by creation time, the updated_at field comes from the file’s modified time. Creation time and last update time are different ideas and should not be mixed.

**Data flow**: It writes a session, changes the file’s modified time to two hours after creation, lists by CreatedAt, and checks that created_at stays at the original timestamp while updated_at matches the modified time in RFC3339 format.

**Call relations**: The test uses write_session_file for the file, manually changes its modification time, then calls get_threads to inspect the item returned by the listing code.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 9 external calls (hours, new, parse, new, from_u128, assert_eq!, format!, format_description!, new).


##### `test_updated_at_uses_file_mtime`  (lines 1245–1340)

```
async fn test_updated_at_uses_file_mtime() -> Result<()>
```

**Purpose**: This test checks updated-time behavior when sorting by updated time. It makes sure updated_at reflects the file’s actual last modified time rather than timestamps inside later rollout lines.

**Data flow**: It manually writes a rollout file with metadata, a user message, and many assistant response lines. After listing by UpdatedAt, it verifies created_at is the session timestamp and updated_at is close to the current file modified time.

**Call relations**: This test constructs RolloutLine values directly instead of using the simpler helpers, then calls get_threads with ThreadSortKey::UpdatedAt to test the updated-time path.

*Call graph*: calls 3 internal fn (from_string, get_threads, provider_vec); 16 external calls (default, create, new, from_u128, new, assert!, assert_eq!, now, format!, create_dir_all (+6 more)).


##### `test_timestamp_only_cursor_skips_same_second_filesystem_ties`  (lines 1343–1472)

```
async fn test_timestamp_only_cursor_skips_same_second_filesystem_ties()
```

**Purpose**: This test documents a limitation of filesystem fallback pagination: if several files have the same second-level timestamp, a timestamp-only cursor skips the remaining ties on the next page. The test locks in that known behavior.

**Data flow**: It writes three sessions with the exact same timestamp, requests two items, and gets a cursor equal to that timestamp. When it requests the next page with that cursor, it expects no items because the filesystem cursor cannot distinguish the same-second files.

**Call relations**: The test uses write_session_file to create tied files and get_threads twice to show how cursor paging behaves in the filesystem-backed path.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 7 external calls (new, from_u128, new, assert_eq!, format!, from_str, vec!).


##### `test_source_filter_excludes_non_matching_sessions`  (lines 1475–1547)

```
async fn test_source_filter_excludes_non_matching_sessions()
```

**Purpose**: This test confirms that source filtering works. Interactive listings should include interactive sessions, such as CLI sessions, and exclude non-interactive sessions, such as exec sessions.

**Data flow**: It writes one CLI session and one Exec session. A call with the interactive source filter should return only the CLI file; a call with no source filter should return both files.

**Call relations**: The test sets up files with write_session_file, prepares provider input with provider_vec, and calls get_threads once with INTERACTIVE_SESSION_SOURCES and once with NO_SOURCE_FILTER.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file); 4 external calls (new, from_u128, assert!, assert_eq!).


##### `test_model_provider_filter_selects_only_matching_sessions`  (lines 1550–1654)

```
async fn test_model_provider_filter_selects_only_matching_sessions() -> Result<()>
```

**Purpose**: This test verifies filtering by model provider. It also checks the special fallback rule that sessions with no provider can be included when filtering for the current default provider.

**Data flow**: It writes three sessions: one from openai, one from beta, and one with no provider. Filtering for openai should return the openai session plus the provider-less session; filtering for beta should return only beta; filtering for an unknown provider should return none; no provider filter should return all three.

**Call relations**: The test calls write_session_file_with_provider directly to create different provider cases, uses provider_vec to build filter inputs, and calls get_threads repeatedly to verify each filtering scenario.

*Call graph*: calls 3 internal fn (get_threads, provider_vec, write_session_file_with_provider); 4 external calls (new, from_u128, assert!, assert_eq!).
