# Session history, compaction, resume, and persisted state suites  `stage-23.2.4.2`

This stage tests Codex’s memory: how a conversation survives long chats, restarts, branches, and saved state. It is shared support for the main chat loop and for reopening old sessions. The compaction tests check that long history can be squeezed into a shorter summary without losing key instructions, whether done manually, automatically, remotely, after a model switch, or during replay. Resume and fork tests check that saved conversations reopen with the right messages, warnings, settings, and request history, and that a copied branch keeps or drops messages exactly where asked. Pending-input tests make sure messages that arrive during an active model turn wait for the next turn instead of being lost. Window-header tests verify the backend can still identify the right conversation “window” after compacting, resuming, or forking. Rollout and SQLite tests cover the storage layer: finding saved sessions, saving images, preserving tool logs, restored tools, and safety flags. Model override tests ensure temporary thread settings do not quietly rewrite user config or history until a real new turn records them.

## Files in this stage

### Compaction behavior
These suites establish core compaction semantics, compare remote implementations, and follow compacted history through resume and fork flows.

### `core/tests/suite/compact.rs`

`test` · `test execution`

Large language models can only read a limited amount of text at once. Codex works around that by “compacting” a long conversation: it asks the model, or a remote compaction endpoint, to summarize older context and then continues using that summary instead of the full history. This test file is the safety net for that behavior.

The tests create fake model servers, send Codex user turns, and inspect the exact requests Codex sends back. They verify that compaction requests include the right summarization prompt, that follow-up turns contain the compacted summary, and that old assistant messages or tool outputs are kept or removed in the intended places. The file also checks edge cases: compaction after token limits, compaction while a tool call is mid-turn, retrying after context-window errors, switching to a smaller model, resuming from a saved rollout file, and preserving the original AGENTS.md instruction snapshot even if the file changes later.

Think of it like testing a backpack repacking system. When the bag gets too full, Codex should fold old clothes into a labeled bundle, keep the important labels, and continue without losing the new items being packed.

#### Function details

##### `ev_shell_command_call`  (lines 94–100)

```
fn ev_shell_command_call(call_id: &str, command: &str) -> serde_json::Value
```

**Purpose**: Builds a fake model event that says the assistant wants to run a shell command. Tests use it to simulate tool calls without involving a real model.

**Data flow**: It receives a call id and command text, wraps the command in JSON, and returns a response item shaped like a function call.

**Call relations**: It is a small test helper that hands off to the shared fake-event builder for function calls, so larger compaction tests can focus on conversation flow instead of JSON details.

*Call graph*: calls 1 internal fn (ev_function_call); 1 external calls (json!).


##### `disabled_permission_user_turn`  (lines 102–129)

```
fn disabled_permission_user_turn(text: impl Into<String>, cwd: PathBuf, model: String) -> Op
```

**Purpose**: Creates a user-input operation with permissions deliberately locked down. Tests use it when they need a predictable turn that cannot ask for approvals or run with broad sandbox access.

**Data flow**: It takes user text, a working directory, and a model name, looks up the matching permission and sandbox fields, and returns an operation ready to submit to Codex.

**Call relations**: Model-switch and resume tests call this helper before submitting turns, so those tests can concentrate on compaction behavior rather than rebuilding permission settings each time.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 9 (auto_compact_runs_after_resume_when_token_usage_is_over_limit, body_after_prefix_model_switch_budget_compacts_with_next_model, pre_sampling_compact_recovers_comp_hash_after_resume, pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model, pre_sampling_compact_runs_on_switch_to_smaller_context_model, pre_sampling_compact_runs_when_comp_hash_changes, pre_sampling_compact_skips_missing_comp_hash_after_resume, pre_sampling_compact_skips_when_either_comp_hash_is_missing, snapshot_request_shape_pre_turn_compaction_strips_incoming_model_switch); 4 external calls (default, abs, as_path, vec!).


##### `auto_summary`  (lines 131–133)

```
fn auto_summary(summary: &str) -> String
```

**Purpose**: Returns summary text in the simple form expected by several automatic-compaction tests. It makes the test setup read like intent rather than string plumbing.

**Data flow**: It receives summary text and returns the same text as an owned string.

**Call relations**: Automatic and repeated-compaction tests call it when preparing fake model responses that act as summaries.

*Call graph*: called by 5 (auto_compact_allows_multiple_attempts_when_interleaved_with_other_turn_events, auto_compact_clamps_config_limit_to_context_window, auto_compact_persists_rollout_entries, manual_compact_twice_preserves_latest_user_messages, snapshot_request_shape_mid_turn_continuation_compaction).


##### `summary_with_prefix`  (lines 135–137)

```
fn summary_with_prefix(summary: &str) -> String
```

**Purpose**: Adds Codex's standard summary prefix to summary text. Tests use it to check that compacted history is marked clearly as a summary when it is sent back to the model.

**Data flow**: It receives the raw summary and returns a new string containing the shared prefix followed by the summary.

**Call relations**: Manual and multi-auto compaction tests call it when comparing the expected compacted message with the request body Codex produced.

*Call graph*: called by 3 (manual_compact_twice_preserves_latest_user_messages, multiple_auto_compact_per_task_runs_after_token_limit_hit, summarize_context_three_requests_and_instructions); 1 external calls (format!).


##### `set_test_compact_prompt`  (lines 139–141)

```
fn set_test_compact_prompt(config: &mut Config)
```

**Purpose**: Forces a test configuration to use the known summarization prompt. This removes ambiguity from tests that check whether the prompt was inserted correctly.

**Data flow**: It receives a mutable configuration and sets its compact prompt field to the standard summarization prompt.

**Call relations**: Many tests use this during Codex setup before submitting turns, so later request assertions can look for one known prompt.


##### `ev_completed_with_usage`  (lines 143–157)

```
fn ev_completed_with_usage(id: &str, input_tokens: i64, output_tokens: i64) -> Value
```

**Purpose**: Builds a fake completion event with separate input and output token counts. Tests use it when they need to check token-budget logic more precisely than a single total.

**Data flow**: It receives an id plus input and output token counts, calculates the total, and returns a JSON event matching the model API shape.

**Call relations**: Token-budget tests include this event in fake server streams so Codex believes the model reported realistic usage numbers.

*Call graph*: 1 external calls (json!).


##### `body_contains_text`  (lines 159–161)

```
fn body_contains_text(body: &str, text: &str) -> bool
```

**Purpose**: Checks whether a JSON request body contains a particular text value in encoded form. This avoids false misses when quotes or escapes appear in JSON.

**Data flow**: It receives a body string and target text, converts the target into the escaped JSON fragment form, and returns true if the body contains it.

**Call relations**: Request-inspection tests call this helper when looking for the summarization prompt or other user-visible text inside serialized JSON.

*Call graph*: calls 1 internal fn (json_fragment); called by 2 (manual_compact_retries_after_context_window_error, summarize_context_three_requests_and_instructions).


##### `json_fragment`  (lines 163–168)

```
fn json_fragment(text: &str) -> String
```

**Purpose**: Converts plain text into the escaped form it would have inside a JSON string. It supports reliable string searches in serialized request bodies.

**Data flow**: It receives plain text, serializes it as JSON, removes the surrounding quotes, and returns the escaped inner fragment.

**Call relations**: It is used by body_contains_text, which is then used throughout compaction request assertions.

*Call graph*: called by 1 (body_contains_text); 1 external calls (to_string).


##### `read_hook_inputs`  (lines 170–176)

```
fn read_hook_inputs(path: &Path) -> Vec<Value>
```

**Purpose**: Reads the log file written by test hook scripts and turns each JSON line back into a value. Tests use it to confirm which hook ran and what Codex sent to it.

**Data flow**: It receives a path, reads the file, skips blank lines, parses each remaining line as JSON, and returns the list of hook input payloads.

**Call relations**: Hook-related tests call it after compaction completes to verify pre-compact and post-compact hook behavior.

*Call graph*: called by 2 (compact_hooks_respect_matchers_and_post_runs_after_compaction, manual_pre_compact_block_decision_does_not_block_compaction); 1 external calls (read_to_string).


##### `python_hook_command`  (lines 178–180)

```
fn python_hook_command(script_path: &Path) -> String
```

**Purpose**: Formats a command string that runs a generated Python hook script. It keeps hook configuration snippets short and consistent.

**Data flow**: It receives a script path and returns a shell command string using python3 and the script path.

**Call relations**: The hook-writing helpers use it when creating hooks.json entries for test-only command hooks.

*Call graph*: 1 external calls (format!).


##### `write_unsupported_blocking_pre_compact_hook`  (lines 182–213)

```
fn write_unsupported_blocking_pre_compact_hook(home: &Path)
```

**Purpose**: Creates a test hook that tries to block manual compaction, even though that block decision is unsupported. The related test checks that Codex reports the hook failure but still compacts.

**Data flow**: It receives a temporary home directory, writes a Python script that logs hook input and prints a block decision, then writes a hooks.json file pointing at that script.

**Call relations**: The manual pre-compact hook test installs this helper before building Codex, then reads the hook log after compaction.

*Call graph*: 4 external calls (join, format!, write, json!).


##### `write_matching_compact_hooks`  (lines 215–265)

```
fn write_matching_compact_hooks(home: &Path)
```

**Purpose**: Creates test pre- and post-compaction hooks with different match rules. This lets tests prove that only hooks matching the compaction trigger run.

**Data flow**: It receives a home directory, writes Python scripts for an auto pre-hook and a manual post-hook, and writes hooks.json that registers them.

**Call relations**: The hook matcher test installs this setup, triggers manual compaction, and then confirms the auto hook did not run while the manual post hook did.

*Call graph*: 4 external calls (join, format!, write, json!).


##### `non_openai_model_provider`  (lines 267–274)

```
fn non_openai_model_provider(server: &MockServer) -> ModelProviderInfo
```

**Purpose**: Builds a fake OpenAI-compatible provider that points at the local mock server and disables websocket behavior. Tests use it so all model traffic is inspectable.

**Data flow**: It receives a mock server, clones the built-in OpenAI provider settings, changes the name and base URL, disables websockets, and returns the provider info.

**Call relations**: Most tests call this during Codex configuration so requests go to the test server instead of a real model service.

*Call graph*: called by 31 (auto_compact_allows_multiple_attempts_when_interleaved_with_other_turn_events, auto_compact_body_after_prefix_counts_growth_after_compaction, auto_compact_body_after_prefix_ignores_starting_window_prefix, auto_compact_body_after_prefix_still_caps_at_context_window, auto_compact_clamps_config_limit_to_context_window, auto_compact_emits_context_compaction_items, auto_compact_persists_rollout_entries, auto_compact_runs_after_token_limit_hit, auto_compact_starts_after_turn_started, body_after_prefix_model_switch_budget_compacts_with_next_model (+15 more)); 2 external calls (built_in_model_providers, format!).


##### `write_global_file`  (lines 276–284)

```
fn write_global_file(
    home: &TempDir,
    filename: &str,
    contents: impl AsRef<[u8]>,
) -> Result<AbsolutePathBuf>
```

**Purpose**: Writes a global instruction file, such as AGENTS.md, into a temporary Codex home. Tests use it to check whether compaction preserves the instruction snapshot from thread creation time.

**Data flow**: It receives a temporary home directory, a filename, and contents, writes the file, and returns the absolute path to it.

**Call relations**: Instruction-preservation tests call it before and after compaction to simulate instruction files changing on disk.

*Call graph*: called by 3 (manual_compaction_keeps_the_creation_time_global_instructions, mid_turn_compaction_keeps_the_creation_time_global_instructions, remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation); 2 external calls (path, write).


##### `instruction_fragments`  (lines 286–292)

```
fn instruction_fragments(request: &responses::ResponsesRequest) -> Vec<String>
```

**Purpose**: Extracts AGENTS.md instruction blocks from a captured request. This helps tests compare what instructions Codex actually sent to the model.

**Data flow**: It reads user-message texts from a request, keeps only those starting with the AGENTS.md instruction heading, and returns them as strings.

**Call relations**: It supports assert_single_instruction_fragment, which is used by instruction-preservation tests.

*Call graph*: calls 1 internal fn (message_input_texts).


##### `instruction_fragments_in_items`  (lines 294–307)

```
fn instruction_fragments_in_items(items: &[Value]) -> Vec<String>
```

**Purpose**: Finds AGENTS.md instruction blocks inside raw response-history items. It is useful when checking persisted replacement history rather than normal captured requests.

**Data flow**: It receives JSON items, filters to user message content spans, extracts text, keeps AGENTS.md instruction fragments, and returns them.

**Call relations**: The remote-v2 compaction resume test uses it after reading replacement history from the rollout file.

*Call graph*: 1 external calls (iter).


##### `expected_instruction_fragment`  (lines 309–311)

```
fn expected_instruction_fragment(contents: &str) -> String
```

**Purpose**: Builds the exact AGENTS.md instruction block that Codex should send. Tests use it as the expected value in instruction snapshot assertions.

**Data flow**: It receives instruction file contents and wraps them with the heading and INSTRUCTIONS tags Codex uses in requests.

**Call relations**: Instruction-preservation tests call it before checking captured requests with assert_single_instruction_fragment.

*Call graph*: called by 3 (manual_compaction_keeps_the_creation_time_global_instructions, mid_turn_compaction_keeps_the_creation_time_global_instructions, remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation); 1 external calls (format!).


##### `assert_single_instruction_fragment`  (lines 313–315)

```
fn assert_single_instruction_fragment(request: &responses::ResponsesRequest, expected: &str)
```

**Purpose**: Asserts that a request contains exactly one AGENTS.md instruction block and that it matches the expected text. This catches both missing instructions and accidental duplicates.

**Data flow**: It receives a captured request and expected text, extracts instruction fragments, and compares the result to a one-item list.

**Call relations**: Instruction-preservation tests use it across ordinary, compact, follow-up, and resumed requests.

*Call graph*: called by 3 (manual_compaction_keeps_the_creation_time_global_instructions, mid_turn_compaction_keeps_the_creation_time_global_instructions, remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation); 1 external calls (assert_eq!).


##### `replacement_history_from_rollout`  (lines 317–338)

```
fn replacement_history_from_rollout(path: &Path) -> Result<Vec<Value>>
```

**Purpose**: Reads the saved rollout file and extracts the replacement history stored by a compaction entry. This lets tests verify what would be replayed after resuming a session.

**Data flow**: It receives a rollout path, reads JSON lines, finds a compacted entry with replacement history, converts those items back to JSON values, and returns them or an error if none exists.

**Call relations**: The remote-v2 instruction test calls it after flushing rollout data, then compares that persisted history with later resumed requests.

*Call graph*: called by 1 (remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation); 2 external calls (read_to_string, from_str).


##### `remote_v2_compaction_response`  (lines 340–351)

```
fn remote_v2_compaction_response() -> String
```

**Purpose**: Builds a fake server-stream response for remote compaction v2. It simulates the API returning an encrypted compaction summary.

**Data flow**: It creates a stream containing a compaction output item and a completion event, then returns the stream text.

**Call relations**: The remote-v2 instruction-preservation test uses it as the mock response for the compaction request.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `local_compaction_provider`  (lines 353–359)

```
fn local_compaction_provider(server: &wiremock::MockServer) -> ModelProviderInfo
```

**Purpose**: Builds an OpenAI-compatible provider aimed at the local mock server for local compaction tests. It is similar to the generic fake provider but named for compaction-specific scenarios.

**Data flow**: It receives a mock server, clones a built-in provider, changes its display name and base URL, disables websockets, and returns it.

**Call relations**: Global-instruction tests use it when they want local compaction requests captured by the mock server.

*Call graph*: called by 2 (manual_compaction_keeps_the_creation_time_global_instructions, mid_turn_compaction_keeps_the_creation_time_global_instructions); 2 external calls (built_in_model_providers, format!).


##### `model_info_with_context_window`  (lines 361–370)

```
fn model_info_with_context_window(slug: &str, context_window: i64) -> ModelInfo
```

**Purpose**: Creates model metadata with a specific context-window size. Tests use it to simulate switching between models with different memory limits.

**Data flow**: It loads bundled model metadata, finds the requested model slug, replaces its context window, and returns the modified model info.

**Call relations**: Model-switch tests use it directly or through model_info_with_optional_comp_hash when mounting fake model-list responses.

*Call graph*: called by 1 (model_info_with_optional_comp_hash); 1 external calls (bundled_models_response).


##### `model_info_with_optional_comp_hash`  (lines 372–376)

```
fn model_info_with_optional_comp_hash(slug: &str, comp_hash: Option<&str>) -> ModelInfo
```

**Purpose**: Creates model metadata with an optional compaction hash. A compaction hash is a model compatibility marker; when it changes, Codex may need to compact before continuing.

**Data flow**: It starts with model info from model_info_with_context_window, sets or clears the comp_hash field, and returns the result.

**Call relations**: Comp-hash tests use it to build fake model-list responses that should either trigger or skip pre-sampling compaction.

*Call graph*: calls 1 internal fn (model_info_with_context_window).


##### `assert_pre_sampling_switch_compaction_requests`  (lines 378–403)

```
fn assert_pre_sampling_switch_compaction_requests(
    first: &serde_json::Value,
    compact: &serde_json::Value,
    follow_up: &serde_json::Value,
    previous_model: &str,
    next_model: &str,
)
```

**Purpose**: Checks the three-request pattern expected when Codex compacts before sampling after a model switch. It verifies the old model is used for compaction and the new model is used afterward.

**Data flow**: It receives the first, compact, and follow-up request bodies plus model names, checks their model fields, checks the compact prompt is present, and checks model-switch markers are placed only in the follow-up.

**Call relations**: Several pre-sampling model-switch tests call it after collecting mock-server requests.

*Call graph*: called by 4 (pre_sampling_compact_recovers_comp_hash_after_resume, pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model, pre_sampling_compact_runs_on_switch_to_smaller_context_model, pre_sampling_compact_runs_when_comp_hash_changes); 3 external calls (to_string, assert!, assert_eq!).


##### `assert_compaction_uses_turn_lifecycle_id`  (lines 405–445)

```
async fn assert_compaction_uses_turn_lifecycle_id(codex: &std::sync::Arc<codex_core::CodexThread>)
```

**Purpose**: Confirms that compaction events are tied to the same lifecycle id as the user turn that caused them. This keeps the UI/event stream grouped correctly.

**Data flow**: It reads events from a Codex thread until the turn completes, records ids for turn start, compaction start, compaction completion, and turn completion, then asserts they match as expected.

**Call relations**: Pre-sampling and body-budget model-switch tests call it while waiting for compaction and the surrounding turn to finish.

*Call graph*: called by 5 (body_after_prefix_model_switch_budget_compacts_with_next_model, pre_sampling_compact_recovers_comp_hash_after_resume, pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model, pre_sampling_compact_runs_on_switch_to_smaller_context_model, pre_sampling_compact_runs_when_comp_hash_changes); 1 external calls (assert_eq!).


##### `context_snapshot_options`  (lines 446–450)

```
fn context_snapshot_options() -> ContextSnapshotOptions
```

**Purpose**: Defines how request snapshots should be rendered for readable snapshot tests. It trims noisy capability instructions and shows compact item labels.

**Data flow**: It starts from default snapshot options, strips capability instructions, sets a concise render mode, and returns the options.

**Call relations**: format_labeled_requests_snapshot calls it whenever a snapshot test needs stable, human-readable request output.

*Call graph*: calls 1 internal fn (default); called by 1 (format_labeled_requests_snapshot).


##### `format_labeled_requests_snapshot`  (lines 452–461)

```
fn format_labeled_requests_snapshot(
    scenario: &str,
    sections: &[(&str, &core_test_support::responses::ResponsesRequest)],
) -> String
```

**Purpose**: Formats named captured requests into a readable snapshot string. Snapshot tests use this to show before-and-after compaction request shapes.

**Data flow**: It receives a scenario description and labeled request sections, applies the shared snapshot options, and returns formatted text.

**Call relations**: Several snapshot tests call it before passing the result to the snapshot assertion tool.

*Call graph*: calls 2 internal fn (format_labeled_requests_snapshot, context_snapshot_options).


##### `summarize_context_three_requests_and_instructions`  (lines 464–668)

```
async fn summarize_context_three_requests_and_instructions()
```

**Purpose**: Tests the basic manual compaction story: first a normal turn, then a summary request, then a follow-up turn that uses the summary. It also checks rollout persistence.

**Data flow**: It sets up three fake model responses, submits a user turn, submits manual compact, submits another user turn, then inspects request bodies and rollout lines.

**Call relations**: It uses helpers for the fake provider, prompt setup, prompt searching, and summary prefixing to verify the main compaction flow end to end.

*Call graph*: calls 7 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, body_contains_text, non_openai_model_provider, summary_with_prefix); 11 external calls (default, new, assert!, assert_eq!, wait_for_event, panic!, println!, from_str, skip_if_no_network!, read_to_string (+1 more)).


##### `manual_pre_compact_block_decision_does_not_block_compaction`  (lines 671–741)

```
async fn manual_pre_compact_block_decision_does_not_block_compaction()
```

**Purpose**: Verifies that an unsupported blocking decision from a pre-compact hook does not stop manual compaction. Codex should mark the hook run as failed but still send the compact request.

**Data flow**: It installs a hook that prints a block decision, runs a normal turn and manual compact, waits for hook and warning events, then checks request count and hook input.

**Call relations**: It uses the hook-writing and hook-log-reading helpers to connect Codex hook behavior with the captured model requests.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider, read_hook_inputs); 7 external calls (default, assert!, assert_eq!, wait_for_event, wait_for_event_match, skip_if_no_network!, vec!).


##### `compact_hooks_respect_matchers_and_post_runs_after_compaction`  (lines 744–809)

```
async fn compact_hooks_respect_matchers_and_post_runs_after_compaction()
```

**Purpose**: Checks that compact hooks obey their trigger matchers and that post-compact hooks run after manual compaction. This protects user automation from firing at the wrong time.

**Data flow**: It installs one auto pre-hook and one manual post-hook, triggers manual compaction, then checks that only the manual post-hook wrote a log.

**Call relations**: It relies on the matching-hook setup helper, the fake provider, and hook-log parsing to prove matcher behavior.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider, read_hook_inputs); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `manual_compact_uses_custom_prompt`  (lines 812–903)

```
async fn manual_compact_uses_custom_prompt()
```

**Purpose**: Ensures that a user-configured compact prompt replaces the default summarization prompt for manual compaction. This protects customization behavior.

**Data flow**: It configures a custom prompt, runs a turn and manual compact, then searches the compact request input for the custom prompt and absence of the default prompt.

**Call relations**: It uses the fake server and provider setup, then inspects captured requests after the compact turn completes.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 7 external calls (default, assert!, assert_eq!, wait_for_event, panic!, skip_if_no_network!, vec!).


##### `manual_compact_emits_api_and_local_token_usage_events`  (lines 906–961)

```
async fn manual_compact_emits_api_and_local_token_usage_events()
```

**Purpose**: Verifies that manual compaction emits both the token usage reported by the API and Codex's local estimate after compaction. This keeps token-count displays useful even when the API reports zero.

**Data flow**: It sends a compact request whose fake completion reports zero tokens, collects two TokenCount events, and asserts the second estimated count is nonzero.

**Call relations**: It drives Codex with a single manual compact operation and listens to events rather than inspecting request bodies.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (assert!, assert_eq!, wait_for_event, wait_for_event_match, skip_if_no_network!, vec!).


##### `manual_compact_emits_context_compaction_items`  (lines 964–1038)

```
async fn manual_compact_emits_context_compaction_items()
```

**Purpose**: Checks that manual compaction appears in the event stream as started and completed context-compaction items. This supports clients that render compaction as an item in the turn.

**Data flow**: It runs a normal turn, triggers manual compact, reads events until it sees item start, item completion, legacy context-compacted event, and turn completion, then compares item ids.

**Call relations**: It combines fake model responses with event-stream assertions to ensure both new and legacy compaction signals are emitted.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `multiple_auto_compact_per_task_runs_after_token_limit_hit`  (lines 1041–1583)

```
async fn multiple_auto_compact_per_task_runs_after_token_limit_hit()
```

**Purpose**: Tests a long task that crosses the token limit multiple times and should auto-compact more than once. It proves Codex can repeatedly summarize progress and keep going.

**Data flow**: It creates alternating fake work responses and summary responses, submits one user task, then compares every captured request input with the expected sequence.

**Call relations**: It uses fake reasoning items, shell command events, summary prefixing, and the mock request log to validate a full multi-compaction flow.

*Call graph*: calls 7 internal fn (ev_reasoning_item, mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider, summary_with_prefix); 6 external calls (default, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `auto_compact_runs_after_token_limit_hit`  (lines 1588–1785)

```
async fn auto_compact_runs_after_token_limit_hit()
```

**Purpose**: Checks the standard automatic compaction path after token usage exceeds the configured limit. The next user turn should trigger a compaction request before continuing.

**Data flow**: It runs two turns that push token usage over the limit, submits a follow-up turn, and inspects four requests: two normal turns, one compact request, and one follow-up.

**Call relations**: It uses the fake provider and prompt-search helper to confirm where the summarization prompt appears and that the follow-up contains prior user messages plus the summary.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `auto_compact_emits_context_compaction_items`  (lines 1790–1871)

```
async fn auto_compact_emits_context_compaction_items()
```

**Purpose**: Ensures automatic compaction also emits context-compaction item events. This keeps UI/event behavior consistent with manual compaction.

**Data flow**: It submits several user turns, watches events during each turn, records compaction start and completion items, and checks the ids match.

**Call relations**: It mirrors the manual item-event test but triggers compaction through token-limit behavior.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 5 external calls (default, assert!, assert_eq!, skip_if_no_network!, vec!).


##### `auto_compact_starts_after_turn_started`  (lines 1876–1975)

```
async fn auto_compact_starts_after_turn_started()
```

**Purpose**: Verifies event ordering: when auto-compaction happens before a follow-up response, the normal turn-start event must appear first. This prevents clients from seeing a compaction item before the turn exists.

**Data flow**: It drives a conversation past the token limit, submits another user turn, reads the next relevant event, and asserts it is TurnStarted before the compaction item starts.

**Call relations**: It uses fake streamed responses and event waiting to check sequencing rather than request contents.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (default, assert_eq!, wait_for_event, wait_for_event_match, skip_if_no_network!, vec!).


##### `auto_compact_runs_after_resume_when_token_usage_is_over_limit`  (lines 1978–2086)

```
async fn auto_compact_runs_after_resume_when_token_usage_is_over_limit()
```

**Purpose**: Checks that if a saved session is resumed while already over the token limit, Codex auto-compacts on the next user turn. This prevents resumed long sessions from immediately overflowing.

**Data flow**: It creates an over-limit turn, resumes from the rollout file, submits a follow-up user turn, and verifies the remote compact endpoint was called once before the follow-up request.

**Call relations**: It uses disabled_permission_user_turn for predictable resumed input and a mounted compact endpoint to prove remote compaction ran.

*Call graph*: calls 7 internal fn (mount_compact_json_once, mount_sse_once, mount_sse_once_match, sse, start_mock_server, test_codex, disabled_permission_user_turn); 6 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `pre_sampling_compact_runs_on_switch_to_smaller_context_model`  (lines 2089–2188)

```
async fn pre_sampling_compact_runs_on_switch_to_smaller_context_model()
```

**Purpose**: Tests that switching to a model with a smaller context window can trigger compaction before the next model call. This avoids sending too much history to the smaller model.

**Data flow**: It mounts fake model metadata, runs a turn on the larger model, submits a turn switching to the smaller model, then checks the user, compact, and follow-up requests.

**Call relations**: It uses the lifecycle-id and request-shape assertion helpers to verify both event grouping and request contents.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, assert_compaction_uses_turn_lifecycle_id, assert_pre_sampling_switch_compaction_requests, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 6 external calls (start, assert_eq!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `pre_sampling_compact_runs_when_comp_hash_changes`  (lines 2191–2275)

```
async fn pre_sampling_compact_runs_when_comp_hash_changes()
```

**Purpose**: Checks that Codex compacts before sampling when the model's compaction compatibility hash changes. This protects against carrying history across incompatible model formats.

**Data flow**: It provides fake model metadata with different hashes, runs one turn, switches models, and confirms a compaction request appears between the two normal requests.

**Call relations**: It shares the model-switch assertion helpers with the smaller-context-window test.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, assert_compaction_uses_turn_lifecycle_id, assert_pre_sampling_switch_compaction_requests, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 5 external calls (start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `pre_sampling_compact_skips_when_either_comp_hash_is_missing`  (lines 2278–2385)

```
async fn pre_sampling_compact_skips_when_either_comp_hash_is_missing()
```

**Purpose**: Verifies that Codex does not trigger hash-based pre-sampling compaction if either model is missing a compaction hash. Missing data should not be treated as a meaningful change.

**Data flow**: It sets up model metadata where hashes are absent on one side of each switch, submits three model-specific turns, and checks no request contains the summarization prompt.

**Call relations**: It uses disabled_permission_user_turn and fake model-list data to isolate comp-hash skip behavior.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_sequence, test_codex, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 6 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `body_after_prefix_model_switch_budget_compacts_with_next_model`  (lines 2388–2479)

```
async fn body_after_prefix_model_switch_budget_compacts_with_next_model()
```

**Purpose**: Tests body-after-prefix token budgeting during a model switch. In this mode, Codex should compact with the next model when the body budget requires it.

**Data flow**: It configures a small body-after-prefix limit, runs a turn on one model, switches to another, waits for compaction tied to the turn, and checks request model fields.

**Call relations**: It uses the lifecycle-id helper and model metadata mounting to verify which model each request uses.

*Call graph*: calls 7 internal fn (mount_models_once, mount_sse_sequence, test_codex, assert_compaction_uses_turn_lifecycle_id, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 6 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model`  (lines 2482–2600)

```
async fn pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model()
```

**Purpose**: Checks that pre-sampling compaction still happens after a session is resumed and the user switches to a smaller model. Resume should not lose the previous model context needed for the decision.

**Data flow**: It runs and shuts down an initial session, resumes from the rollout, submits a smaller-model turn, and inspects the three captured requests.

**Call relations**: It combines resume setup with the same request-shape assertion used by other model-switch compaction tests.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, assert_compaction_uses_turn_lifecycle_id, assert_pre_sampling_switch_compaction_requests, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 5 external calls (start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `pre_sampling_compact_recovers_comp_hash_after_resume`  (lines 2603–2731)

```
async fn pre_sampling_compact_recovers_comp_hash_after_resume()
```

**Purpose**: Verifies that Codex persists and recovers the previous model's compaction hash across resume. Without this, hash-change compaction could be skipped incorrectly.

**Data flow**: It runs an initial turn, reads the rollout to confirm the hash was saved, resumes the session, switches to a different hash, and checks that compaction occurs.

**Call relations**: It uses rollout inspection plus the shared lifecycle and request-shape helpers.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, assert_compaction_uses_turn_lifecycle_id, assert_pre_sampling_switch_compaction_requests, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 6 external calls (start, assert_eq!, wait_for_event, read_to_string, skip_if_no_network!, vec!).


##### `pre_sampling_compact_skips_missing_comp_hash_after_resume`  (lines 2734–2860)

```
async fn pre_sampling_compact_skips_missing_comp_hash_after_resume()
```

**Purpose**: Checks that a missing compaction hash remains missing after resume and does not create a false compaction trigger. This protects old or incomplete model metadata cases.

**Data flow**: It runs a session with no previous hash, verifies the rollout lacks the hash field, resumes, switches models, and confirms only normal model requests were made.

**Call relations**: It pairs resume behavior with disabled_permission_user_turn and fake model metadata to test the skip path.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_sequence, test_codex, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 7 external calls (start, assert!, assert_eq!, wait_for_event, read_to_string, skip_if_no_network!, vec!).


##### `auto_compact_persists_rollout_entries`  (lines 2863–3000)

```
async fn auto_compact_persists_rollout_entries()
```

**Purpose**: Ensures automatic compaction still records one TurnContext entry per real user turn in the rollout file. The saved history must remain resumable and understandable.

**Data flow**: It runs turns that trigger auto-compaction, shuts Codex down to flush the rollout, reads the rollout file, and counts TurnContext entries.

**Call relations**: It uses matcher-based fake responses and the auto-summary helper, then validates persistence rather than request shape.

*Call graph*: calls 6 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, auto_summary, non_openai_model_provider); 7 external calls (default, assert_eq!, wait_for_event, from_str, skip_if_no_network!, read_to_string, vec!).


##### `manual_compact_retries_after_context_window_error`  (lines 3003–3103)

```
async fn manual_compact_retries_after_context_window_error()
```

**Purpose**: Tests that manual compaction retries with less history if the first compaction request is too large for the model context window. This gives Codex a chance to recover from oversized history.

**Data flow**: It runs a normal turn, makes the first compact attempt fail with a context-length error, makes the retry succeed, and checks the retry dropped exactly one oldest history item.

**Call relations**: It uses body_contains_text to ensure the prompt behavior is consistent between the failed attempt and retry.

*Call graph*: calls 7 internal fn (mount_sse_sequence, sse, sse_failed, start_mock_server, test_codex, body_contains_text, non_openai_model_provider); 7 external calls (default, assert_eq!, assert_ne!, wait_for_event, panic!, skip_if_no_network!, vec!).


##### `manual_compact_non_context_failure_retries_then_emits_task_error`  (lines 3109–3182)

```
async fn manual_compact_non_context_failure_retries_then_emits_task_error()
```

**Purpose**: Documents an ignored test for non-context manual compact failures. It is meant to verify retry behavior and final task-error reporting for ordinary server errors.

**Data flow**: It would run a user turn, trigger compact, receive two server-error responses, then assert a reconnect message and a compact task error.

**Call relations**: The test is currently ignored, so it serves as a pending behavior specification rather than an active guard.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, sse_failed, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (default, assert!, wait_for_event, wait_for_event_match, skip_if_no_network!, vec!).


##### `manual_compact_twice_preserves_latest_user_messages`  (lines 3185–3433)

```
async fn manual_compact_twice_preserves_latest_user_messages()
```

**Purpose**: Checks that running manual compaction twice keeps the latest user messages and produces a clean follow-up history. It protects against summaries erasing recent user intent.

**Data flow**: It runs a user turn, compacts, runs another turn, compacts again, then submits a final turn and inspects all captured requests and metadata headers.

**Call relations**: It uses auto_summary, summary_with_prefix, fake responses, and snapshot formatting to verify both request metadata and history layout.

*Call graph*: calls 7 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, auto_summary, non_openai_model_provider, summary_with_prefix); 9 external calls (default, assert!, assert_eq!, assert_ne!, wait_for_event, assert_snapshot!, from_str, skip_if_no_network!, vec!).


##### `auto_compact_allows_multiple_attempts_when_interleaved_with_other_turn_events`  (lines 3436–3547)

```
async fn auto_compact_allows_multiple_attempts_when_interleaved_with_other_turn_events()
```

**Purpose**: Tests that automatic compaction can happen more than once even when tool-call events occur between attempts. This protects long tool-heavy tasks.

**Data flow**: It configures a low token limit, sends three user turns with fake responses including a tool call, collects lifecycle events, and verifies two compact requests were made.

**Call relations**: It uses the fake provider and summary helper to ensure auto-compaction is not blocked by interleaved function-call output.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, auto_summary, non_openai_model_provider); 7 external calls (default, new, assert!, assert_eq!, matches!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_mid_turn_continuation_compaction`  (lines 3550–3654)

```
async fn snapshot_request_shape_mid_turn_continuation_compaction()
```

**Purpose**: Captures the exact request shape when compaction happens mid-turn after a tool output. Snapshot coverage makes accidental history-layout changes visible.

**Data flow**: It sends a turn that triggers a function call and exceeds the token limit, verifies the compact request includes the tool output and prompt, then snapshots compact and continuation requests.

**Call relations**: It uses mounted single responses so each important request can be inspected and labeled separately.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, auto_summary, non_openai_model_provider); 6 external calls (default, assert!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `auto_compact_clamps_config_limit_to_context_window`  (lines 3657–3714)

```
async fn auto_compact_clamps_config_limit_to_context_window()
```

**Purpose**: Verifies that an auto-compact limit configured above the model context window is clamped down to the usable context size. A too-large setting should not disable protection.

**Data flow**: It configures a tiny context window and a larger limit, runs an over-limit turn and a follow-up, then checks that a compact request with the prompt occurred.

**Call relations**: It uses the fake provider and mounted requests to confirm the clamp affects real auto-compaction behavior.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, auto_summary, non_openai_model_provider); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `auto_compact_body_after_prefix_ignores_starting_window_prefix`  (lines 3717–3783)

```
async fn auto_compact_body_after_prefix_ignores_starting_window_prefix()
```

**Purpose**: Checks that body-after-prefix budgeting ignores the fixed starting prefix until conversation growth exceeds the body budget. This avoids compacting immediately just because system context is large.

**Data flow**: It configures body-after-prefix mode, runs two turns that should not compact, then a third that should, and checks request counts and prompt presence.

**Call relations**: It uses fake usage counts to separate fixed prefix size from new conversation growth.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `auto_compact_body_after_prefix_counts_growth_after_compaction`  (lines 3786–3886)

```
async fn auto_compact_body_after_prefix_counts_growth_after_compaction()
```

**Purpose**: Tests that after a compaction, Codex starts measuring new growth again and can compact a second time. This keeps body-after-prefix mode useful across multiple compacted windows.

**Data flow**: It runs turns that trigger one compaction, then additional turns that establish a new baseline and later exceed it, verifying request counts after each stage.

**Call relations**: It relies on ordered fake responses and prompt checks to show when each compaction should occur.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `auto_compact_body_after_prefix_still_caps_at_context_window`  (lines 3889–3945)

```
async fn auto_compact_body_after_prefix_still_caps_at_context_window()
```

**Purpose**: Ensures body-after-prefix mode still respects the overall context-window cap. Even if the body budget is high, Codex must compact before total context exceeds the model's usable window.

**Data flow**: It sets a small context window and a larger configured limit, submits turns, and checks the third turn includes a pre-turn compaction request.

**Call relations**: It uses fake token usage and request inspection to test the safety cap.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `auto_compact_counts_encrypted_reasoning_before_last_user`  (lines 3948–4078)

```
async fn auto_compact_counts_encrypted_reasoning_before_last_user()
```

**Purpose**: Checks that encrypted reasoning content before the latest user turn counts toward remote-compaction limits, while newer reasoning is handled differently. This protects token accounting for hidden reasoning data.

**Data flow**: It creates reasoning-heavy fake responses across three turns, mounts a remote compact endpoint, submits turns, and verifies remote compaction runs once before the third request.

**Call relations**: It combines fake ChatGPT authentication, remote compact mocking, and captured request inspection.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_sequence, sse, start_mock_server, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, wait_for_event, format!, json!, skip_if_no_network!, vec!).


##### `auto_compact_runs_when_reasoning_header_clears_between_turns`  (lines 4081–4166)

```
async fn auto_compact_runs_when_reasoning_header_clears_between_turns()
```

**Purpose**: Verifies that remote compaction can run after a server header saying reasoning was included no longer appears. This tests a subtle state transition in reasoning accounting.

**Data flow**: It sends one response with the reasoning-included header, later responses without it, submits three turns, and checks the remote compact endpoint was called once.

**Call relations**: It uses mounted response sequences and a compact endpoint mock to test header-driven behavior.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_response_sequence, sse, start_mock_server, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_pre_turn_compaction_including_incoming_user_message`  (lines 4170–4287)

```
async fn snapshot_request_shape_pre_turn_compaction_including_incoming_user_message()
```

**Purpose**: Snapshots current pre-turn compaction behavior when a new user message includes both text and an image. The test documents that the incoming user message is excluded from the compact request but restored afterward.

**Data flow**: It runs two turns, changes thread context, submits a third turn with image and text, then snapshots the compact and follow-up request layouts and asserts the third input appears only in the follow-up.

**Call relations**: It uses local environment selection, fake provider setup, and snapshot formatting to document pre-turn history shape.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, local_selections, test_codex, non_openai_model_provider); 9 external calls (default, assert!, assert_eq!, submit_thread_settings, test_path_buf, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_pre_turn_compaction_strips_incoming_model_switch`  (lines 4292–4392)

```
async fn snapshot_request_shape_pre_turn_compaction_strips_incoming_model_switch()
```

**Purpose**: Checks that pre-turn compaction during a model switch strips the incoming model-switch marker from the compact request and restores it in the follow-up. This prevents the summarizer from seeing a pending setting change as history.

**Data flow**: It runs a turn on one model, submits a second turn switching models, then inspects compact and follow-up request bodies for the model-switch marker.

**Call relations**: It uses disabled_permission_user_turn and snapshot formatting to document this model-switch edge case.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, test_codex, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 6 external calls (assert!, assert_eq!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_pre_turn_compaction_context_window_exceeded`  (lines 4395–4485)

```
async fn snapshot_request_shape_pre_turn_compaction_context_window_exceeded()
```

**Purpose**: Tests and snapshots what happens when pre-turn compaction itself keeps failing because the compact request exceeds the context window. Codex should surface a useful error.

**Data flow**: It runs one successful turn, then makes multiple compact attempts fail with context-length errors, captures the emitted error message, and snapshots the compact request shape.

**Call relations**: It uses fake failed SSE responses and event waiting to cover the failure path.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 7 external calls (default, assert!, wait_for_event, wait_for_event_match, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_manual_compact_without_previous_user_messages`  (lines 4488–4549)

```
async fn snapshot_request_shape_manual_compact_without_previous_user_messages()
```

**Purpose**: Documents current behavior when manual compact is requested before any normal user turn. Codex still sends a compaction request and then can continue with a follow-up turn.

**Data flow**: It triggers manual compact immediately, submits a follow-up user input, and snapshots both the compact request and the later request.

**Call relations**: It uses fake responses and snapshot formatting to make this unusual starting-state behavior explicit.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `manual_compaction_keeps_the_creation_time_global_instructions`  (lines 4552–4628)

```
async fn manual_compaction_keeps_the_creation_time_global_instructions() -> Result<()>
```

**Purpose**: Verifies that manual compaction keeps the global instructions as they were when the thread was created, even if the AGENTS.md file changes later. This prevents old conversations from silently changing rules midstream.

**Data flow**: It writes old instructions, starts a thread, runs a turn, rewrites the same file with new instructions, compacts, runs a follow-up, and checks all requests still contain the old fragment.

**Call relations**: It uses write_global_file, expected_instruction_fragment, and assert_single_instruction_fragment to test instruction snapshot stability.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_instruction_fragment, local_compaction_provider, write_global_file); 6 external calls (clone, new, new, assert_eq!, wait_for_event, vec!).


##### `mid_turn_compaction_keeps_the_creation_time_global_instructions`  (lines 4631–4700)

```
async fn mid_turn_compaction_keeps_the_creation_time_global_instructions() -> Result<()>
```

**Purpose**: Checks that automatic mid-turn compaction also preserves the thread's original global instruction snapshot. This covers compaction triggered during tool-heavy work rather than by a manual command.

**Data flow**: It starts with old global instructions, writes a newer override before the turn triggers compaction, then checks the initial, compact, and resumed requests all carry the old instructions.

**Call relations**: It shares the global-file and instruction-fragment helpers with the manual instruction-preservation test.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_instruction_fragment, local_compaction_provider, write_global_file); 6 external calls (clone, new, new, assert_eq!, assert_ne!, vec!).


##### `remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation`  (lines 4703–4834)

```
async fn remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation() -> Result<()>
```

**Purpose**: Tests remote compaction v2 with instruction files that change at the same path, including cold resume afterward. It ensures persisted replacement history and later requests still replay the original instruction context.

**Data flow**: It writes old instructions, runs a turn, rewrites the same file, performs remote-v2 compaction, checks live requests and rollout replacement history, shuts down, resumes cold, and checks the resumed request prefix.

**Call relations**: It uses the remote-v2 fake response, rollout replacement-history reader, global-file helpers, and instruction assertions to cover both live and resumed behavior.

*Call graph*: calls 8 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_instruction_fragment, replacement_history_from_rollout, write_global_file, create_dummy_chatgpt_auth_for_testing); 7 external calls (clone, new, new, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/compact_remote_parity.rs`

`test` · `test execution`

A long chat can become too large to send back to the model every turn, so Codex can “compact” it: replace older conversation history with a shorter encrypted summary. This file tests that the old remote compaction flow and the newer v2 flow behave the same from the user’s point of view. Think of it like checking that two different moving companies pack the same room into different boxes, but nothing important is lost.

The tests build fake Codex sessions with controlled model replies. They run the same scripted conversation twice: once with the legacy compaction feature and once with v2. The conversations include plain assistant replies, reasoning items, function calls, shell commands, image input, web search, manual compaction, automatic compaction before a turn, automatic compaction during a turn, and hook scripts that run around compaction.

After each run, the file captures three important things: the request used to compact history, the follow-up request sent after compaction, and the replacement history written to the rollout log. It normalizes unstable details such as UUIDs, temporary paths, and shell timing so the comparison focuses on real behavior, not machine-specific noise. If anything differs unexpectedly, the test reports the first JSON difference to make debugging easier.

#### Function details

##### `AuthCase::build`  (lines 44–49)

```
fn build(self) -> CodexAuth
```

**Purpose**: Creates the kind of fake login needed for a test run. The tests can pretend to be either a ChatGPT-authenticated user or an API-key user.

**Data flow**: It takes an `AuthCase` choice. For the ChatGPT case, it creates dummy ChatGPT credentials for testing; for the API-key case, it creates credentials from the hard-coded dummy key. It returns a `CodexAuth` object that the test harness can use.

**Call relations**: The harness-building code calls this while setting up a Codex test session. Its result is handed into the test builder so later requests are shaped as if they came from that authentication type.

*Call graph*: calls 2 internal fn (create_dummy_chatgpt_auth_for_testing, from_api_key).


##### `RunSettings::default`  (lines 59–64)

```
fn default() -> Self
```

**Purpose**: Provides the standard test settings: ChatGPT-style authentication and no fast service tier. This keeps most tests simple unless they need a special case.

**Data flow**: It receives no input. It creates a `RunSettings` value with `auth` set to `ChatGpt` and `service_tier_fast` set to false, then returns it.

**Call relations**: Top-level tests and helper builders call this when they want the normal setup. Special tests can override fields afterward, such as the API-key service-tier test.

*Call graph*: called by 3 (build_auto_harness, remote_compaction_parity_manual_transcripts, run_manual_hook_session).


##### `Step::label`  (lines 78–87)

```
fn label(self) -> &'static str
```

**Purpose**: Turns a scripted conversation step into a stable text label. These labels are used in fake user messages and fake response IDs so test data is readable.

**Data flow**: It takes one `Step` value, matches it to its kind, and returns a fixed string such as `assistant`, `shell_tool`, or `web_search_assistant`.

**Call relations**: Conversation-building helpers use this when creating user input and mocked model responses. The labels help connect a generated request or response back to the scenario step that produced it.


##### `remote_compaction_parity_manual_transcripts`  (lines 118–145)

```
async fn remote_compaction_parity_manual_transcripts() -> Result<()>
```

**Purpose**: Runs the main manual-compaction parity checks across several hand-built conversation shapes. It proves that legacy and v2 compaction agree for simple replies, reasoning, images, tools, and mixed histories.

**Data flow**: It first skips the test if network-dependent tests are disabled. It creates a list of scenarios, then sends each scenario to `compare_manual_scenario`. If every comparison passes, it returns success.

**Call relations**: This is a top-level asynchronous test. It delegates each scenario to `compare_manual_scenario`, which performs the two actual Codex runs and compares their captured outputs.

*Call graph*: calls 2 internal fn (default, compare_manual_scenario); 1 external calls (skip_if_no_network!).


##### `remote_compaction_parity_v2_api_key_sends_service_tier_upgrade`  (lines 148–176)

```
async fn remote_compaction_parity_v2_api_key_sends_service_tier_upgrade() -> Result<()>
```

**Purpose**: Checks a deliberate difference between legacy and v2: v2 should include the requested fast service tier for API-key users, while legacy should not. Everything else should still match.

**Data flow**: It skips when needed, builds one tool-heavy scenario with API-key auth and fast service tier enabled, then runs it in legacy and v2 modes. It directly checks the service-tier field, then compares the rest of the compact request, follow-up request, and replacement history.

**Call relations**: This top-level test calls `run_manual_session` for both modes. It then uses `assert_compact_requests_eq_except_v2_service_tier` for the one expected request difference and `assert_follow_up_and_history_eq` for the shared behavior.

*Call graph*: calls 3 internal fn (assert_compact_requests_eq_except_v2_service_tier, assert_follow_up_and_history_eq, run_manual_session); 2 external calls (assert_eq!, skip_if_no_network!).


##### `remote_compaction_parity_manual_hooks`  (lines 179–186)

```
async fn remote_compaction_parity_manual_hooks() -> Result<()>
```

**Purpose**: Verifies that hook scripts run around manual compaction with the same visible payloads in legacy and v2 modes. Hooks are external commands users can configure to react to events.

**Data flow**: It skips when appropriate, runs a hook-enabled manual compaction session in both modes, and compares the simplified hook log JSON from each run. It returns success only if the logs match.

**Call relations**: This top-level test relies on `run_manual_hook_session` to create the hook files, trigger compaction, and read the logs. It uses `assert_json_eq` so a mismatch is reported clearly.

*Call graph*: calls 2 internal fn (assert_json_eq, run_manual_hook_session); 1 external calls (skip_if_no_network!).


##### `remote_compaction_parity_pre_turn_auto`  (lines 189–196)

```
async fn remote_compaction_parity_pre_turn_auto() -> Result<()>
```

**Purpose**: Checks automatic compaction that happens before a later user turn begins. It makes sure the legacy and v2 implementations make equivalent compacted history and follow-up requests.

**Data flow**: It skips if needed, runs a pre-turn auto-compaction session in legacy mode and v2 mode, then compares the resulting captures. It returns success when the compact request view, follow-up request view, and rollout history all match.

**Call relations**: This top-level test calls `run_pre_turn_auto_session` for each mode and sends the two captures to `assert_capture_eq`.

*Call graph*: calls 2 internal fn (assert_capture_eq, run_pre_turn_auto_session); 1 external calls (skip_if_no_network!).


##### `remote_compaction_parity_mid_turn_auto`  (lines 199–206)

```
async fn remote_compaction_parity_mid_turn_auto() -> Result<()>
```

**Purpose**: Checks automatic compaction that happens during a turn, after the model has requested a tool call. This protects the more delicate case where compaction occurs while the system is still working through a response.

**Data flow**: It skips when appropriate, runs a mid-turn auto-compaction session in legacy and v2 modes, then compares their captured requests and rollout history. Success means both modes compact the same usable conversation state.

**Call relations**: This top-level test calls `run_mid_turn_auto_session` twice and then delegates comparison to `assert_capture_eq`.

*Call graph*: calls 2 internal fn (assert_capture_eq, run_mid_turn_auto_session); 1 external calls (skip_if_no_network!).


##### `compare_manual_scenario`  (lines 208–213)

```
async fn compare_manual_scenario(scenario: &Scenario, settings: RunSettings) -> Result<()>
```

**Purpose**: Runs one manual-compaction scenario through both implementations and checks that they match. It is the shared worker for the main scenario table.

**Data flow**: It receives a scenario and settings. It runs `run_manual_session` once in legacy mode and once in v2 mode, then passes both captures to `assert_capture_eq`; if the assertion passes, it returns success.

**Call relations**: `remote_compaction_parity_manual_transcripts` calls this for each scripted scenario. This helper keeps the top-level test focused on listing scenarios rather than repeating the run-and-compare pattern.

*Call graph*: calls 2 internal fn (assert_capture_eq, run_manual_session); called by 1 (remote_compaction_parity_manual_transcripts).


##### `assert_capture_eq`  (lines 215–255)

```
fn assert_capture_eq(label: &str, legacy: &Capture, v2: &Capture)
```

**Purpose**: Compares the important outputs of one legacy run and one v2 run. It enforces that legacy used the old compact endpoint once, v2 did not, and the meaningful JSON content still agrees.

**Data flow**: It receives a label plus two `Capture` records. It checks compact request counts, extracts normalized views of the compact and follow-up requests, compares those views, compares replacement history, and prints a short success summary with item counts.

**Call relations**: Scenario tests call this after running both modes. It calls `compact_request_view`, `follow_up_request_view`, and `assert_json_eq` so comparisons ignore expected transport differences and unstable values.

*Call graph*: calls 3 internal fn (assert_json_eq, compact_request_view, follow_up_request_view); called by 3 (compare_manual_scenario, remote_compaction_parity_mid_turn_auto, remote_compaction_parity_pre_turn_auto); 3 external calls (assert_eq!, format!, println!).


##### `assert_compact_requests_eq_except_v2_service_tier`  (lines 257–275)

```
fn assert_compact_requests_eq_except_v2_service_tier(label: &str, legacy: &Capture, v2: &Capture)
```

**Purpose**: Compares compact requests when v2 is allowed to include one extra field: `service_tier`. This captures an intentional improvement without hiding other regressions.

**Data flow**: It receives a label and two captures. It checks the expected compact request counts, builds normalized compact-request views, removes `service_tier` from the v2 view, and asserts that the remaining JSON is equal.

**Call relations**: The API-key service-tier test calls this after separately checking the service-tier behavior. It uses `compact_request_view`, `remove_object_field`, and `assert_json_eq`.

*Call graph*: calls 3 internal fn (assert_json_eq, compact_request_view, remove_object_field); called by 1 (remote_compaction_parity_v2_api_key_sends_service_tier_upgrade); 2 external calls (assert_eq!, format!).


##### `assert_follow_up_and_history_eq`  (lines 277–291)

```
fn assert_follow_up_and_history_eq(label: &str, legacy: &Capture, v2: &Capture)
```

**Purpose**: Compares the post-compaction follow-up request and rollout replacement history. It is used when the compact request itself has one known special-case difference.

**Data flow**: It receives a label and two captures. It extracts normalized follow-up request views from both, compares them, then compares the stored replacement histories.

**Call relations**: The API-key service-tier test calls this after checking compact-request behavior. It relies on `follow_up_request_view` and `assert_json_eq` to keep the comparison focused and readable.

*Call graph*: calls 2 internal fn (assert_json_eq, follow_up_request_view); called by 1 (remote_compaction_parity_v2_api_key_sends_service_tier_upgrade); 1 external calls (format!).


##### `run_manual_session`  (lines 293–336)

```
async fn run_manual_session(
    scenario: &Scenario,
    mode: Mode,
    settings: RunSettings,
) -> Result<Capture>
```

**Purpose**: Runs a full scripted manual-compaction conversation in either legacy or v2 mode and records what happened. It is the main engine behind the manual parity tests.

**Data flow**: It receives a scenario, a mode, and settings. It builds fake model response bodies, starts a test harness, mounts mocked response endpoints, submits each user turn, triggers manual compaction, sends one more user message, then calls `capture_from_requests` to return the compact request, follow-up request, and replacement history.

**Call relations**: Comparison helpers and the API-key test call this for both modes. It ties together response generation, harness setup, user input submission, endpoint mocking, and final capture.

*Call graph*: calls 12 internal fn (mount_sse_sequence, after_compact_response_body, build_harness, capture_from_requests, compaction_v2_response_body, follow_up_index, mount_legacy_compact_if_needed, response_bodies_for_scenario, rollout_path, submit_user_input (+2 more)); called by 2 (compare_manual_scenario, remote_compaction_parity_v2_api_key_sends_service_tier_upgrade); 1 external calls (vec!).


##### `run_pre_turn_auto_session`  (lines 338–394)

```
async fn run_pre_turn_auto_session(mode: Mode) -> Result<Capture>
```

**Purpose**: Runs a session designed to trigger automatic compaction before the next user turn. It creates a controlled two-turn flow where the first response uses enough tokens to cross the test limit.

**Data flow**: It builds different mocked response sequences for legacy and v2, creates an auto-compaction harness, submits a first user message and then a second one, then captures the compact and follow-up requests plus rollout history.

**Call relations**: The pre-turn auto test calls this once per mode. It uses the same capture path as manual tests, but the compaction is triggered by the configured token limit rather than by an explicit compact command.

*Call graph*: calls 7 internal fn (mount_sse_sequence, build_auto_harness, capture_from_requests, follow_up_index, mount_legacy_compact_if_needed, rollout_path, submit_user_input); called by 1 (remote_compaction_parity_pre_turn_auto); 1 external calls (vec!).


##### `run_mid_turn_auto_session`  (lines 396–444)

```
async fn run_mid_turn_auto_session(mode: Mode) -> Result<Capture>
```

**Purpose**: Runs a session designed to trigger automatic compaction in the middle of a turn, after a tool call appears. This checks a timing-sensitive compaction path.

**Data flow**: It prepares mocked responses where the model first asks for a function tool and reports high token usage. It builds an auto-compaction harness, submits one user message, then captures the compact request, follow-up request, and replacement history.

**Call relations**: The mid-turn auto test calls this for legacy and v2. It shares setup and capture helpers with the pre-turn test but uses a different mocked response shape.

*Call graph*: calls 7 internal fn (mount_sse_sequence, build_auto_harness, capture_from_requests, follow_up_index, mount_legacy_compact_if_needed, rollout_path, submit_user_input); called by 1 (remote_compaction_parity_mid_turn_auto); 1 external calls (vec!).


##### `run_manual_hook_session`  (lines 446–487)

```
async fn run_manual_hook_session(mode: Mode) -> Result<Value>
```

**Purpose**: Runs a manual compaction session with pre-compact and post-compact hook scripts enabled, then returns a simplified view of what those hooks received. This checks that user automation sees the same event details in both modes.

**Data flow**: It builds mocked responses, starts a hook-enabled harness, mounts the needed compact behavior, submits one user message, triggers compaction, waits for completion, then reads the hook log files and returns JSON with `pre` and `post` entries.

**Call relations**: The manual hook parity test calls this for both modes. It depends on harness setup to write hook scripts and on `hook_log_view` to turn raw hook logs into stable comparison data.

*Call graph*: calls 7 internal fn (mount_sse_sequence, default, build_harness, hook_log_view, mount_legacy_compact_if_needed, submit_user_input, wait_for_turn_complete); called by 1 (remote_compaction_parity_manual_hooks); 3 external calls (assert_eq!, json!, vec!).


##### `build_auto_harness`  (lines 489–497)

```
async fn build_auto_harness(mode: Mode) -> Result<TestCodexHarness>
```

**Purpose**: Creates a test Codex harness configured for automatic compaction. It sets a low token limit so tests can trigger compaction quickly.

**Data flow**: It receives a mode, uses default run settings, sets the auto-compaction limit to 200 tokens, and delegates the real setup to `build_harness_inner`. It returns a ready-to-use `TestCodexHarness`.

**Call relations**: The pre-turn and mid-turn automatic compaction runners call this. It is a small convenience wrapper around the shared harness builder.

*Call graph*: calls 2 internal fn (default, build_harness_inner); called by 2 (run_mid_turn_auto_session, run_pre_turn_auto_session).


##### `build_harness`  (lines 499–501)

```
async fn build_harness(mode: Mode, settings: RunSettings, hooks: bool) -> Result<TestCodexHarness>
```

**Purpose**: Creates a normal test Codex harness for manual compaction tests. It leaves automatic compaction disabled unless another helper asks for it.

**Data flow**: It receives a mode, run settings, and a hook flag. It passes those through to `build_harness_inner` with no auto-compaction token limit, then returns the resulting harness.

**Call relations**: Manual session and hook session runners call this. It keeps their setup code short while sharing the same core configuration path.

*Call graph*: calls 1 internal fn (build_harness_inner); called by 2 (run_manual_hook_session, run_manual_session).


##### `build_harness_inner`  (lines 503–537)

```
async fn build_harness_inner(
    mode: Mode,
    settings: RunSettings,
    hooks: bool,
    auto_compact_limit: Option<i64>,
) -> Result<TestCodexHarness>
```

**Purpose**: Performs the actual test harness setup: fixed working directory, fake authentication, instructions, optional hooks, service tier, auto-compaction limit, and feature flag choice. Without this, each parity run could accidentally differ for setup reasons rather than compaction reasons.

**Data flow**: It receives mode, settings, hook choice, and optional token limit. It creates the fixed workspace directory, prepares a `test_codex` builder, writes global instructions, optionally writes hook files, fills in config values, disables v2 for legacy mode, and returns the built harness.

**Call relations**: `build_harness` and `build_auto_harness` both call this. It is the common setup point that ensures legacy and v2 sessions are as identical as possible except for the compaction implementation.

*Call graph*: calls 2 internal fn (with_builder, test_codex); called by 2 (build_auto_harness, build_harness); 1 external calls (create_dir_all).


##### `rollout_path`  (lines 539–546)

```
fn rollout_path(harness: &TestCodexHarness) -> PathBuf
```

**Purpose**: Finds the rollout log file for a test harness. The rollout log is where Codex records conversation events, including compacted replacement history.

**Data flow**: It receives a harness, reads the configured session information from it, extracts the rollout path, and returns that path. If the path is missing, the test fails immediately.

**Call relations**: Session runners call this before activity starts so `capture_from_requests` can later read the compaction record from the same file.

*Call graph*: calls 1 internal fn (test); called by 3 (run_manual_session, run_mid_turn_auto_session, run_pre_turn_auto_session).


##### `mount_legacy_compact_if_needed`  (lines 548–559)

```
async fn mount_legacy_compact_if_needed(
    harness: &TestCodexHarness,
    mode: Mode,
) -> Option<ResponseMock>
```

**Purpose**: Installs a fake legacy compaction endpoint only when the test is running in legacy mode. V2 compaction uses the normal responses endpoint instead, so it should not mount this endpoint.

**Data flow**: It receives the harness and mode. In legacy mode, it mounts a mock `/responses/compact` response that returns the fixed encrypted summary and returns the mock; in v2 mode, it returns `None`.

**Call relations**: All session runners call this after mounting regular response mocks. Later, `capture_from_requests` uses the returned mock, if present, to inspect the legacy compact request.

*Call graph*: calls 2 internal fn (mount_compact_user_history_with_summary_once, server); called by 4 (run_manual_hook_session, run_manual_session, run_mid_turn_auto_session, run_pre_turn_auto_session).


##### `follow_up_index`  (lines 561–563)

```
fn follow_up_index(request_count: usize) -> usize
```

**Purpose**: Calculates which recorded response request is the post-compaction follow-up request. In these tests, it is expected to be the last request sent to the mocked responses endpoint.

**Data flow**: It receives the total number of response requests, subtracts one, and returns that index. If there were no requests, the test fails because a follow-up request is required.

**Call relations**: Manual and automatic session runners call this just before capturing results. The index is passed into `capture_from_requests` so it can pull out the correct request body.

*Call graph*: called by 3 (run_manual_session, run_mid_turn_auto_session, run_pre_turn_auto_session).


##### `capture_from_requests`  (lines 565–603)

```
async fn capture_from_requests(
    mode: Mode,
    codex: &codex_core::CodexThread,
    rollout_path: &Path,
    responses_mock: &ResponseMock,
    compact_mock: Option<&ResponseMock>,
    follow_up_
```

**Purpose**: Collects the evidence that the parity tests compare: compact request body, follow-up request body, replacement history, and request counts. It also shuts down the Codex thread cleanly.

**Data flow**: It receives mode, the Codex thread, the rollout path, response mock, optional compact mock, and follow-up index. It reads the follow-up request, finds the compact request from either the legacy compact mock or the v2 response request just before follow-up, shuts down Codex, reads replacement history from the rollout file, and returns a `Capture` record.

**Call relations**: Session runners call this after they have submitted all user activity. It hands structured capture data to assertion helpers such as `assert_capture_eq`.

*Call graph*: calls 3 internal fn (submit, requests, replacement_history_from_rollout); called by 3 (run_manual_session, run_mid_turn_auto_session, run_pre_turn_auto_session); 2 external calls (wait_for_event, panic!).


##### `submit_user_input`  (lines 605–617)

```
async fn submit_user_input(codex: &codex_core::CodexThread, items: Vec<UserInput>) -> Result<()>
```

**Purpose**: Sends a user input operation to the Codex thread and waits until the turn is complete. This gives tests a simple, reliable way to advance the conversation one turn at a time.

**Data flow**: It receives a Codex thread and a list of user input items. It wraps the items in an `Op::UserInput`, submits it, waits for a turn-complete event, and returns success.

**Call relations**: All session runners use this to feed scripted user messages into Codex. It calls `wait_for_turn_complete` so callers do not proceed while the system is still processing.

*Call graph*: calls 2 internal fn (submit, wait_for_turn_complete); called by 4 (run_manual_hook_session, run_manual_session, run_mid_turn_auto_session, run_pre_turn_auto_session); 1 external calls (default).


##### `wait_for_turn_complete`  (lines 619–621)

```
async fn wait_for_turn_complete(codex: &codex_core::CodexThread)
```

**Purpose**: Waits until Codex reports that the current conversation turn has finished. This prevents tests from reading requests or logs too early.

**Data flow**: It receives a Codex thread and listens for events until it sees `TurnComplete`. It does not return a value; returning means the turn is done.

**Call relations**: `submit_user_input` calls this after every user turn, and manual hook/session code also uses it after explicitly triggering compaction.

*Call graph*: called by 3 (run_manual_hook_session, run_manual_session, submit_user_input); 1 external calls (wait_for_event).


##### `user_input_for_step`  (lines 623–636)

```
fn user_input_for_step(scenario_name: &str, idx: usize, step: Step) -> Vec<UserInput>
```

**Purpose**: Builds the user input items for one scripted scenario step. Image steps include both an image and text; other steps include just text.

**Data flow**: It receives the scenario name, step index, and step kind. It optionally adds a fixed data-URL image, then adds a text message containing the scenario name, index, and step label, and returns the list.

**Call relations**: `run_manual_session` calls this for each step before submitting input. The matching labels help the mocked responses and captured requests stay easy to trace.

*Call graph*: called by 1 (run_manual_session); 3 external calls (new, format!, matches!).


##### `response_bodies_for_scenario`  (lines 638–645)

```
fn response_bodies_for_scenario(scenario: &Scenario) -> Vec<String>
```

**Purpose**: Builds the full list of mocked model responses for a scenario. Each scripted step may require one or more server-sent event responses.

**Data flow**: It receives a scenario, walks through its steps with their indexes, asks `response_bodies_for_step` for each step’s response bodies, flattens the results, and returns one list of strings.

**Call relations**: `run_manual_session` calls this before mounting the mocked responses endpoint. It turns the human-readable scenario definition into the fake network traffic Codex will consume.

*Call graph*: called by 1 (run_manual_session).


##### `response_bodies_for_step`  (lines 647–722)

```
fn response_bodies_for_step(scenario_name: &str, idx: usize, step: Step) -> Vec<String>
```

**Purpose**: Creates the fake streamed model response for one kind of conversation step. A streamed response is a sequence of events, like assistant text, tool calls, reasoning, web search completion, and final completion.

**Data flow**: It receives the scenario name, step index, and step kind. It builds a stable response ID and returns one or two serialized server-sent-event bodies depending on whether the step needs a follow-up after a tool call.

**Call relations**: `response_bodies_for_scenario` uses this to prepare each scenario. The mocked server later serves these bodies when Codex sends requests during the test.

*Call graph*: 2 external calls (format!, vec!).


##### `compaction_v2_response_body`  (lines 724–735)

```
fn compaction_v2_response_body() -> String
```

**Purpose**: Creates the fake v2 compaction response. In v2, compaction is represented as a normal responses-stream item with encrypted summary content.

**Data flow**: It receives no input. It builds a server-sent-event body containing one `compaction` output item with the fixed encrypted summary, followed by a completed event, and returns it as a string.

**Call relations**: V2 session runners add this body to the mocked response sequence before the post-compaction follow-up response. Legacy mode does not use it because it calls the separate compact endpoint.

*Call graph*: calls 1 internal fn (sse); called by 1 (run_manual_session); 1 external calls (vec!).


##### `after_compact_response_body`  (lines 737–745)

```
fn after_compact_response_body(scenario_name: &str) -> String
```

**Purpose**: Creates the fake assistant response that happens after compaction. This lets the tests inspect the request Codex sends once compacted history is in place.

**Data flow**: It receives a scenario name and returns a server-sent-event body with one assistant message and one completion event, both named from the scenario.

**Call relations**: Manual session setup uses this as the final mocked response after compaction. Automatic sessions also create equivalent after-compaction responses inline.

*Call graph*: calls 1 internal fn (sse); called by 1 (run_manual_session); 1 external calls (vec!).


##### `compact_request_view`  (lines 747–767)

```
fn compact_request_view(body: &Value, mode: Mode) -> Value
```

**Purpose**: Extracts the meaningful, comparable parts of a compact request. It hides unstable details and accounts for the v2-only `compaction_trigger` marker.

**Data flow**: It receives a JSON request body and mode. It copies the `input` array, removes and checks the trailing v2 trigger when needed, selects only important request fields, normalizes strings and nested values, sorts object keys, and returns the canonical JSON view.

**Call relations**: Assertion helpers call this before comparing legacy and v2 compact requests. It uses `selected_request_fields`, `normalize_value`, and `canonical_json` to make comparisons fair.

*Call graph*: calls 3 internal fn (canonical_json, normalize_value, selected_request_fields); called by 2 (assert_capture_eq, assert_compact_requests_eq_except_v2_service_tier); 3 external calls (Array, get, assert_eq!).


##### `follow_up_request_view`  (lines 769–777)

```
fn follow_up_request_view(body: &Value) -> Value
```

**Purpose**: Extracts the meaningful, comparable parts of the request sent after compaction. This shows whether Codex continues the conversation from the same compacted state.

**Data flow**: It receives a JSON request body, selects follow-up-relevant fields, normalizes the full `input` array, canonicalizes the result, and returns that stable JSON view.

**Call relations**: `assert_capture_eq` and `assert_follow_up_and_history_eq` call this before comparing follow-up requests. It shares field selection and normalization helpers with compact request comparison.

*Call graph*: calls 3 internal fn (canonical_json, normalize_value, selected_request_fields); called by 2 (assert_capture_eq, assert_follow_up_and_history_eq); 1 external calls (get).


##### `replacement_history_from_rollout`  (lines 779–804)

```
fn replacement_history_from_rollout(path: &Path) -> Result<Value>
```

**Purpose**: Reads the rollout log and extracts the replacement history written by compaction. Replacement history is the compacted conversation items Codex records after replacing older context.

**Data flow**: It receives a path to the rollout file, reads it line by line, parses JSON rollout entries, looks for a compacted entry with empty message text and replacement history, converts those items to JSON, normalizes and canonicalizes them, and returns the result.

**Call relations**: `capture_from_requests` calls this after shutting down Codex. Its output becomes part of the `Capture` compared by parity assertions.

*Call graph*: calls 2 internal fn (canonical_json, normalize_value); called by 1 (capture_from_requests); 2 external calls (Array, read_to_string).


##### `write_manual_compact_hooks`  (lines 806–834)

```
fn write_manual_compact_hooks(home: &Path)
```

**Purpose**: Writes test hook scripts and a hook configuration file for manual compaction. These hooks record the payloads Codex sends before and after manual compaction.

**Data flow**: It receives the test home directory. It writes separate Python scripts for pre-compact and post-compact hooks, then writes `hooks.json` pointing the manual compaction hook events at those scripts.

**Call relations**: `build_harness_inner` installs this as a pre-build hook when hook testing is requested. The resulting files are later exercised by `run_manual_hook_session`.

*Call graph*: calls 1 internal fn (write_hook_script); 3 external calls (join, write, json!).


##### `write_hook_script`  (lines 836–849)

```
fn write_hook_script(script_path: &Path, log_path: &Path)
```

**Purpose**: Creates one small Python script that logs the JSON payload it receives on standard input. This gives the Rust test a simple way to inspect hook inputs afterward.

**Data flow**: It receives a script path and a log path. It writes Python code that reads JSON from stdin and appends a sorted JSON line to the log file.

**Call relations**: `write_manual_compact_hooks` calls this twice, once for the pre-compact hook and once for the post-compact hook.

*Call graph*: called by 1 (write_manual_compact_hooks); 2 external calls (format!, write).


##### `python_hook_command`  (lines 851–853)

```
fn python_hook_command(script_path: &Path) -> String
```

**Purpose**: Builds the shell command used to run a generated Python hook script. It quotes the path so spaces or special path characters are less likely to break the command.

**Data flow**: It receives a script path and returns a string like `python3 "path"`.

**Call relations**: `write_manual_compact_hooks` uses this command string inside `hooks.json`, so Codex knows what external command to execute for each hook.

*Call graph*: 1 external calls (format!).


##### `hook_log_view`  (lines 855–875)

```
fn hook_log_view(path: &Path) -> Result<Value>
```

**Purpose**: Reads a hook log file and turns each raw hook payload into a stable summary. It compares whether important fields are present without depending on every raw detail.

**Data flow**: It receives a log file path, reads each non-empty line as JSON, keeps the hook event name, trigger, model, and several yes/no field-presence flags, then returns those summaries as a JSON array.

**Call relations**: `run_manual_hook_session` calls this for both the pre-compact and post-compact log files. The resulting JSON is compared by the manual hook parity test.

*Call graph*: called by 1 (run_manual_hook_session); 2 external calls (Array, read_to_string).


##### `selected_request_fields`  (lines 883–919)

```
fn selected_request_fields(body: &Value, mode: SelectedFieldsMode) -> Value
```

**Purpose**: Picks only the request fields that matter for a given comparison. This avoids failing tests because of unrelated fields while still checking the important request shape.

**Data flow**: It receives a JSON body and a mode saying whether this is a compact request or follow-up request. It chooses the field list for that mode, copies any present fields, normalizes their values, and returns a JSON object.

**Call relations**: `compact_request_view` and `follow_up_request_view` call this before adding normalized input and canonicalizing the result.

*Call graph*: calls 1 internal fn (normalize_value); called by 2 (compact_request_view, follow_up_request_view); 3 external calls (Object, get, new).


##### `normalize_value`  (lines 921–932)

```
fn normalize_value(value: Value) -> Value
```

**Purpose**: Recursively cleans JSON values so comparisons ignore harmless machine-specific differences. It leaves numbers, booleans, and nulls alone, while normalizing strings inside arrays and objects.

**Data flow**: It receives a JSON value. If it is a string, it passes it to `normalize_string`; if it is an array or object, it normalizes every contained value; otherwise it returns the value unchanged.

**Call relations**: Request view builders and rollout-history extraction call this before comparing JSON. It is the main bridge between raw captured data and stable test data.

*Call graph*: calls 1 internal fn (normalize_string); called by 4 (compact_request_view, follow_up_request_view, replacement_history_from_rollout, selected_request_fields); 3 external calls (Array, Object, String).


##### `normalize_string`  (lines 934–964)

```
fn normalize_string(value: &str) -> String
```

**Purpose**: Rewrites unstable text fragments into placeholders. It handles UUID-like IDs, temporary Codex skill paths, and shell wall-clock times that naturally change between runs.

**Data flow**: It receives a string. If the whole string looks like a UUID, it returns `<UUID>`; otherwise it replaces temporary path prefixes before skill directories and replaces numeric `Wall time: ... seconds` values with `<WALL_TIME>`, then returns the cleaned string.

**Call relations**: `normalize_value` calls this for every string inside compared JSON. The small unit tests at the bottom of the file directly verify its path and timing rewrites.

*Call graph*: calls 2 internal fn (is_uuid_like, normalize_tmp_prefix_before_marker); called by 4 (normalize_string_rewrites_linux_temp_skill_paths, normalize_string_rewrites_shell_wall_times, normalize_string_rewrites_windows_temp_skill_paths, normalize_value).


##### `is_uuid_like`  (lines 966–974)

```
fn is_uuid_like(value: &str) -> bool
```

**Purpose**: Detects whether a string has the basic shape of a UUID, a common random identifier. The test replaces such IDs so two otherwise identical runs can compare equal.

**Data flow**: It receives a string, checks that it is 36 bytes long, has dashes in the UUID positions, and has hexadecimal characters elsewhere. It returns true or false.

**Call relations**: `normalize_string` calls this first. If it returns true, the whole string is replaced with `<UUID>`.

*Call graph*: called by 1 (normalize_string).


##### `normalize_tmp_prefix_before_marker`  (lines 976–1004)

```
fn normalize_tmp_prefix_before_marker(text: &mut String, marker: &str)
```

**Purpose**: Replaces operating-system-specific temporary directory prefixes before a known marker, such as `/skills/`, with `<CODEX_HOME>`. This makes path comparisons stable across Linux, macOS, and Windows-style paths.

**Data flow**: It receives mutable text and a marker string. It searches for the marker, looks backward for known temporary-directory patterns, replaces the prefix with `<CODEX_HOME>` when found, and continues scanning the rest of the text.

**Call relations**: `normalize_string` calls this for both Unix-style `/skills/` and Windows-style `\skills\` markers. The path-normalization unit tests cover the expected rewrites.

*Call graph*: called by 1 (normalize_string).


##### `normalize_string_rewrites_linux_temp_skill_paths`  (lines 1007–1018)

```
fn normalize_string_rewrites_linux_temp_skill_paths()
```

**Purpose**: Tests that Linux and macOS-style temporary skill paths are normalized correctly. This protects the comparison helper from failing only because a temporary directory name changed.

**Data flow**: It feeds a string containing two temporary skill paths into `normalize_string`, then checks that both prefixes became `<CODEX_HOME>` while the meaningful skill paths stayed intact.

**Call relations**: This is a standalone unit test for `normalize_string` and `normalize_tmp_prefix_before_marker`.

*Call graph*: calls 1 internal fn (normalize_string); 1 external calls (assert_eq!).


##### `normalize_string_rewrites_windows_temp_skill_paths`  (lines 1021–1032)

```
fn normalize_string_rewrites_windows_temp_skill_paths()
```

**Purpose**: Tests that Windows-style temporary skill paths are normalized correctly. It covers both forward-slash and backslash forms seen in Windows paths.

**Data flow**: It passes a string with Windows temporary skill paths into `normalize_string` and asserts that the temporary home prefixes are replaced with `<CODEX_HOME>`.

**Call relations**: This unit test exercises the Windows path branches inside `normalize_tmp_prefix_before_marker` through `normalize_string`.

*Call graph*: calls 1 internal fn (normalize_string); 1 external calls (assert_eq!).


##### `normalize_string_rewrites_shell_wall_times`  (lines 1035–1046)

```
fn normalize_string_rewrites_shell_wall_times()
```

**Purpose**: Tests that shell command wall-clock times are replaced with a stable placeholder. Shell timing naturally varies, so it should not decide parity.

**Data flow**: It sends text containing two `Wall time:` values into `normalize_string` and checks that both numeric values are rewritten as `<WALL_TIME>`.

**Call relations**: This unit test directly protects the wall-time rewrite logic used by request and rollout JSON comparisons.

*Call graph*: calls 1 internal fn (normalize_string); 1 external calls (assert_eq!).


##### `canonical_json`  (lines 1048–1063)

```
fn canonical_json(value: &Value) -> Value
```

**Purpose**: Sorts JSON object keys recursively so equivalent JSON compares equal regardless of map ordering. This makes test failures about content, not serialization order.

**Data flow**: It receives a JSON value. For objects, it sorts keys and canonicalizes each value; for arrays, it canonicalizes each item in order; for primitive values, it clones them unchanged. It returns the canonical JSON.

**Call relations**: Compact request, follow-up request, and replacement-history builders call this just before comparison.

*Call graph*: called by 3 (compact_request_view, follow_up_request_view, replacement_history_from_rollout); 3 external calls (Array, Object, clone).


##### `remove_object_field`  (lines 1065–1069)

```
fn remove_object_field(value: &mut Value, field: &str)
```

**Purpose**: Removes one named field from a JSON object if the value is an object. It is used for the one expected v2 service-tier difference.

**Data flow**: It receives a mutable JSON value and a field name. If the JSON value is an object, it deletes that field; otherwise it does nothing.

**Call relations**: `assert_compact_requests_eq_except_v2_service_tier` calls this on the v2 compact request view before comparing it to legacy.

*Call graph*: called by 1 (assert_compact_requests_eq_except_v2_service_tier).


##### `assert_json_eq`  (lines 1071–1075)

```
fn assert_json_eq(label: &str, left: &Value, right: &Value)
```

**Purpose**: Asserts that two JSON values are equal, and if not, reports the first visible difference. This gives developers a useful failure message instead of a giant unreadable JSON dump.

**Data flow**: It receives a label plus left and right JSON values. If they differ, it panics with the label and the result of `first_json_diff`; if they match, it returns normally.

**Call relations**: All higher-level parity assertions use this for compact requests, follow-up requests, replacement history, and hook payload summaries.

*Call graph*: called by 4 (assert_capture_eq, assert_compact_requests_eq_except_v2_service_tier, assert_follow_up_and_history_eq, remote_compaction_parity_manual_hooks); 1 external calls (panic!).


##### `first_json_diff`  (lines 1077–1131)

```
fn first_json_diff(left: &Value, right: &Value, path: &str) -> String
```

**Purpose**: Finds and describes the first difference between two JSON values. It walks through objects and arrays so the failure message points to a specific path.

**Data flow**: It receives left JSON, right JSON, and a path string such as `$`. It compares objects by sorted keys, arrays by index, and primitive values directly, returning a short text description of the first mismatch.

**Call relations**: `assert_json_eq` calls this only when equality has already failed. It uses `short_json` when it needs to include a value in the message.

*Call graph*: 1 external calls (format!).


##### `short_json`  (lines 1133–1142)

```
fn short_json(value: &Value) -> String
```

**Purpose**: Formats a JSON value for an error message without letting huge values flood the test output. Long JSON text is truncated with its original character count.

**Data flow**: It receives a JSON value, serializes it to one-line JSON text, and returns either the full text or a shortened prefix plus a length marker.

**Call relations**: `first_json_diff` uses this when reporting missing or mismatched values.

*Call graph*: 2 external calls (format!, to_string).


##### `compact_input_len`  (lines 1144–1154)

```
fn compact_input_len(body: &Value, mode: Mode) -> usize
```

**Purpose**: Counts how many real conversation input items are in a compact request. For v2, it subtracts the extra compaction trigger marker because that is not part of the original history.

**Data flow**: It receives a compact request body and mode. It reads the `input` array length, defaults to zero if missing, subtracts one for v2 with saturation, and returns the count.

**Call relations**: `assert_capture_eq` uses this only for its success log line, giving developers a quick sense of how much input was compacted.

*Call graph*: 1 external calls (get).


##### `follow_up_input_len`  (lines 1156–1161)

```
fn follow_up_input_len(body: &Value) -> usize
```

**Purpose**: Counts the number of input items in the post-compaction follow-up request. This is used for human-readable test output.

**Data flow**: It receives a request body, reads the `input` array if present, and returns its length or zero.

**Call relations**: `assert_capture_eq` calls this when printing the `PARITY_OK` summary after a successful comparison.

*Call graph*: 1 external calls (get).


##### `replacement_history_len`  (lines 1163–1165)

```
fn replacement_history_len(body: &Value) -> usize
```

**Purpose**: Counts the number of items in the replacement history JSON array. This helps summarize what compaction wrote to the rollout log.

**Data flow**: It receives a JSON value, returns the array length if it is an array, or zero otherwise.

**Call relations**: `assert_capture_eq` calls this for the success summary printed after parity checks pass.

*Call graph*: 1 external calls (as_array).


### `core/tests/suite/compact_resume_fork.rs`

`test` · `test run`

These are integration tests: they run a real Codex conversation against a fake model server instead of testing one small function in isolation. The fake server returns scripted SSE responses, meaning server-sent events: a stream of model-like messages such as assistant replies and completion signals. The tests then inspect every JSON request Codex sent to that fake server.

The main question this file protects is: “What does the model see after the conversation has been shortened, reopened, branched, or rewound?” Compacting replaces earlier chat with a summary to save space. Resuming reloads a saved conversation from its rollout file. Forking starts a new branch from an earlier point. Rolling back removes recent turns. If any of these operations rebuild history incorrectly, the model might lose important context, see duplicate instructions, or see a user message that was supposed to be removed.

The helper functions are like stagehands for the tests. They start a test conversation, send user messages, trigger compaction, resume or fork threads, collect captured requests, and normalize small formatting differences such as Windows line endings. The test cases then compare the visible user and developer messages with the exact sequence expected after each operation.

#### Function details

##### `network_disabled`  (lines 48–50)

```
fn network_disabled() -> bool
```

**Purpose**: Checks whether the test environment has disabled network access. These tests use a local mock HTTP server, so they skip themselves when the sandbox says networking is unavailable.

**Data flow**: It reads one environment variable that signals disabled network access. If the variable exists, it returns true; otherwise it returns false. It does not change anything.

**Call relations**: Each top-level test calls this at the start. When it returns true, the test prints a skip message and exits early instead of trying to start or contact the mock server.

*Call graph*: called by 4 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view, snapshot_rollback_followup_turn_trims_context_updates, snapshot_rollback_past_compaction_replays_append_only_history); 1 external calls (var).


##### `body_contains_text`  (lines 52–54)

```
fn body_contains_text(body: &str, text: &str) -> bool
```

**Purpose**: Checks whether a raw JSON request body contains a particular text value in JSON-escaped form. This avoids false mismatches when special characters are escaped inside JSON.

**Data flow**: It receives a request body as plain text and the text to look for. It converts the search text into the way that text would appear inside JSON, then checks whether the body contains that fragment. The result is a true or false answer.

**Call relations**: It relies on `json_fragment` to make the search text JSON-safe. In this file it supports request-matching logic for mocked model calls, especially when identifying the compaction request.

*Call graph*: calls 1 internal fn (json_fragment).


##### `json_fragment`  (lines 56–61)

```
fn json_fragment(text: &str) -> String
```

**Purpose**: Turns normal text into the escaped form that appears inside a JSON string, without the surrounding quote marks. This makes request-body substring checks match what is actually sent over the wire.

**Data flow**: It takes a text string, serializes it as JSON, removes the opening and closing quotes from that JSON string, and returns the escaped inner text. If serialization somehow fails, the test fails immediately.

**Call relations**: It is called by `body_contains_text`, which uses the result to search raw request bodies accurately.

*Call graph*: called by 1 (body_contains_text); 1 external calls (to_string).


##### `normalize_line_endings_str`  (lines 63–69)

```
fn normalize_line_endings_str(text: &str) -> String
```

**Purpose**: Makes line endings consistent inside a single string. This keeps tests from failing just because one platform or stored prompt uses Windows-style line breaks and another uses Unix-style line breaks.

**Data flow**: It receives text. If the text contains carriage returns, it replaces both Windows `\r\n` and old-style `\r` line endings with `\n`. If not, it returns the text unchanged as a new string.

**Call relations**: It is used by `normalize_compact_prompts` before comparing prompt text, so the tests focus on conversation history rather than harmless formatting differences.

*Call graph*: called by 1 (normalize_compact_prompts).


##### `extract_summary_user_text`  (lines 71–76)

```
fn extract_summary_user_text(request: &Value, summary_text: &str) -> String
```

**Purpose**: Finds the user-visible message in a request that contains the compaction summary. The tests need the full message because the summary may be wrapped with extra context, not just equal to the summary text alone.

**Data flow**: It receives a JSON request and the summary text to search for. It pulls out all user message texts using `json_message_input_texts`, finds the first one containing the summary, and returns that full text. If no summary is found, the test fails.

**Call relations**: The compact/resume/fork tests call this when building their expected history. It depends on `json_message_input_texts` to read the user messages from the request JSON.

*Call graph*: calls 1 internal fn (json_message_input_texts); called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view).


##### `json_message_input_texts`  (lines 78–97)

```
fn json_message_input_texts(request: &Value, role: &str) -> Vec<String>
```

**Purpose**: Pulls the plain text from message entries in a model request for one role, such as `user` or `developer`. This lets the tests compare what the model would see without manually walking nested JSON each time.

**Data flow**: It receives a JSON request and a role name. It looks inside the request's `input` array, keeps only items that are messages for that role, reads the first content text from each, and returns those texts in order.

**Call relations**: Top-level tests use this to inspect captured requests. `extract_summary_user_text` also uses it as its lower-level reader before searching for a summary message.

*Call graph*: called by 3 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view, extract_summary_user_text); 1 external calls (get).


##### `normalize_compact_prompts`  (lines 99–124)

```
fn normalize_compact_prompts(requests: &mut [Value])
```

**Purpose**: Removes the special summarization prompt messages from captured requests before comparing conversation history. The tests care about preserved user history, not the internal prompt Codex sends to ask the model for a summary.

**Data flow**: It receives a mutable list of JSON request bodies. For each request, it walks the `input` array and removes empty user messages and user messages that equal the configured summarization prompt after line-ending normalization. The same request objects are changed in place.

**Call relations**: The compact/resume/fork tests call this after collecting requests. It uses `normalize_line_endings_str` so prompt removal works consistently across platforms.

*Call graph*: calls 1 internal fn (normalize_line_endings_str); called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view).


##### `compact_resume_and_fork_preserve_model_history_view`  (lines 129–280)

```
async fn compact_resume_and_fork_preserve_model_history_view()
```

**Purpose**: Tests the basic story of compacting a conversation, resuming it from disk, then forking it, and confirms the model sees the right history at each step. It protects against losing the compacted summary or changing the prefix of the conversation after resume or fork.

**Data flow**: It starts a mock server, mounts expected model responses, creates a test conversation, sends `hello world`, compacts, sends another message, shuts down, resumes from the saved rollout path, sends another message, forks from an earlier user message, and sends a final branch message. Then it gathers the captured JSON requests, removes internal compact prompts, extracts user-message text, and asserts the compacted history appears as the expected prefix for later requests.

**Call relations**: This is a top-level async test. It calls helpers such as `network_disabled`, `mount_initial_flow`, `start_test_conversation`, `user_turn`, `compact_conversation`, `fetch_conversation_path`, `shutdown_conversation`, `resume_conversation`, `fork_thread`, `gather_request_bodies`, `json_message_input_texts`, and `extract_summary_user_text` to drive the whole scenario from setup through verification.

*Call graph*: calls 13 internal fn (compact_conversation, extract_summary_user_text, fetch_conversation_path, fork_thread, gather_request_bodies, json_message_input_texts, mount_initial_flow, network_disabled, normalize_compact_prompts, resume_conversation (+3 more)); 6 external calls (start, assert!, assert_eq!, json!, println!, vec!).


##### `compact_resume_after_second_compaction_preserves_history`  (lines 285–417)

```
async fn compact_resume_after_second_compaction_preserves_history() -> Result<()>
```

**Purpose**: Tests a longer story where a forked conversation is compacted a second time and then resumed again. It makes sure the resumed conversation reuses the compacted history and only adds the new user message instead of duplicating or dropping older context.

**Data flow**: It sets up an ordered sequence of fake model responses, starts a conversation, sends an initial turn, compacts, resumes, forks, sends more user turns, compacts the fork, resumes that fork from disk, and sends `AFTER_SECOND_RESUME`. It then reads all captured requests, normalizes line endings, removes internal compact prompts, and checks that the last request begins with the correct post-compaction history and ends with the new resume message.

**Call relations**: This top-level async test uses `network_disabled` to skip when needed, then relies on `mount_second_compact_sequence` for mock responses and the conversation helpers to perform each operation. It uses `json_message_input_texts` and `extract_summary_user_text` to verify the final model-visible user history.

*Call graph*: calls 12 internal fn (compact_conversation, extract_summary_user_text, fetch_conversation_path, fork_thread, json_message_input_texts, mount_second_compact_sequence, network_disabled, normalize_compact_prompts, resume_conversation, shutdown_conversation (+2 more)); 7 external calls (start, assert!, assert_eq!, json!, panic!, println!, vec!).


##### `snapshot_rollback_past_compaction_replays_append_only_history`  (lines 423–507)

```
async fn snapshot_rollback_past_compaction_replays_append_only_history() -> Result<()>
```

**Purpose**: Tests that rolling back a turn after compaction removes the rolled-back user message but keeps the earlier compacted history visible. This protects the saved conversation log from replaying too much or too little after a rollback.

**Data flow**: It creates a fake model server with four scripted responses, starts a conversation, sends `hello world`, compacts it, sends an edited post-compaction message, rolls back one turn, then sends `AFTER_ROLLBACK`. It inspects the captured requests to confirm the removed message is gone, the original first turn remains, and the compaction summary remains. It also records a snapshot of the request shapes for future comparison.

**Call relations**: This is a top-level async test. It calls `network_disabled`, builds fake SSE responses with shared test helpers, starts the conversation with `start_test_conversation`, drives it with `user_turn` and `compact_conversation`, submits the rollback operation directly, waits for the rollback event, and then checks the request log.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, compact_conversation, network_disabled, start_test_conversation, user_turn); 8 external calls (start, assert!, assert_eq!, wait_for_event, assert_snapshot!, panic!, println!, vec!).


##### `snapshot_rollback_followup_turn_trims_context_updates`  (lines 513–636)

```
async fn snapshot_rollback_followup_turn_trims_context_updates() -> Result<()>
```

**Purpose**: Tests that context changes attached to a rolled-back turn are not duplicated when the user sends a follow-up turn. The context changes include things like a changed working directory and developer instructions, which should appear once, not twice.

**Data flow**: It starts a mock server and a test conversation, sends a first turn, submits thread settings that change the environment and developer instructions, sends a second turn, rolls that second turn back, and sends a follow-up message. It then counts matching developer and user context messages in the captured requests to confirm the context update appears exactly once before rollback and exactly once after rollback.

**Call relations**: This top-level async test uses `network_disabled`, `start_test_conversation`, `user_turn`, and test-support helpers for local environment selections and settings submission. After the rollback event arrives, it verifies request history and writes a snapshot of the relevant request shapes.

*Call graph*: calls 5 internal fn (mount_sse_sequence, local_selections, network_disabled, start_test_conversation, user_turn); 10 external calls (default, start, assert_eq!, submit_thread_settings, wait_for_event, assert_snapshot!, panic!, println!, create_dir_all, vec!).


##### `normalize_line_endings`  (lines 638–655)

```
fn normalize_line_endings(value: &mut Value)
```

**Purpose**: Normalizes line endings throughout an entire JSON value. This prevents request comparisons from depending on whether a string used Windows or Unix line breaks.

**Data flow**: It receives a mutable JSON value. If the value is a string, it replaces carriage-return line endings with `\n`; if it is an array or object, it recursively applies the same cleanup to every child value. It changes the JSON value in place and returns nothing.

**Call relations**: Request-gathering code uses this after reading captured request bodies. The second-compaction test also applies it directly to every captured body before comparing histories.


##### `gather_requests`  (lines 657–662)

```
fn gather_requests(request_log: &[ResponseMock]) -> Vec<ResponsesRequest>
```

**Purpose**: Collects all captured model requests from a list of response mocks. This gives tests one flat list even though the fake server may have been mounted with several separate mock responses.

**Data flow**: It receives a slice of `ResponseMock` objects. For each mock, it reads the requests that matched that mock, flattens them into one vector, and returns that vector.

**Call relations**: It is the lower-level collector used by `gather_request_bodies`. The first compact/resume/fork test reaches it through that wrapper when it is ready to inspect what Codex sent.

*Call graph*: called by 1 (gather_request_bodies); 1 external calls (iter).


##### `gather_request_bodies`  (lines 664–671)

```
fn gather_request_bodies(request_log: &[ResponseMock]) -> Vec<Value>
```

**Purpose**: Collects captured model requests and returns just their JSON bodies, already cleaned up for line-ending differences. This gives tests the exact payloads Codex sent to the fake model.

**Data flow**: It calls `gather_requests` to get captured request records, converts each request into a JSON value, normalizes line endings inside each JSON body, and returns the resulting list.

**Call relations**: The first compact/resume/fork test calls this after it has driven the conversation. It hands that test the request bodies needed for history-prefix assertions.

*Call graph*: calls 1 internal fn (gather_requests); called by 1 (compact_resume_and_fork_preserve_model_history_view).


##### `mount_initial_flow`  (lines 673–726)

```
async fn mount_initial_flow(server: &MockServer) -> Vec<ResponseMock>
```

**Purpose**: Sets up the fake model server for the first compact/resume/fork scenario. Each mounted response is matched to a specific kind of request, such as the first user turn, the compaction request, or the forked turn.

**Data flow**: It receives a mock server. It builds five fake SSE response streams, creates request-matching rules that look for or exclude marker texts, mounts each response on the server, and returns the response mocks so the test can later read what requests matched them.

**Call relations**: The first top-level test calls this during setup. It uses `sse` to build fake event streams and `mount_sse_once_match` to attach each stream to the server with a custom matcher.

*Call graph*: calls 2 internal fn (mount_sse_once_match, sse); called by 1 (compact_resume_and_fork_preserve_model_history_view); 1 external calls (vec!).


##### `mount_second_compact_sequence`  (lines 728–751)

```
async fn mount_second_compact_sequence(server: &MockServer) -> ResponseMock
```

**Purpose**: Sets up the fake model server for the longer second-compaction scenario. Unlike the first setup, it mounts one ordered sequence so the captured requests reflect the real chronological order.

**Data flow**: It receives a mock server, builds eight fake SSE response streams for the expected calls, mounts them as a sequence, and returns the single response mock that records the ordered requests.

**Call relations**: The second-compaction test calls this at the beginning. It uses `sse` to build the fake streams and `mount_sse_sequence` to make the server answer requests in order.

*Call graph*: calls 2 internal fn (mount_sse_sequence, sse); called by 1 (compact_resume_after_second_compaction_preserves_history); 1 external calls (vec!).


##### `start_test_conversation`  (lines 753–771)

```
async fn start_test_conversation(
    server: &MockServer,
    model: Option<&str>,
) -> (Arc<TempDir>, Config, Arc<ThreadManager>, Arc<CodexThread>)
```

**Purpose**: Creates a fresh Codex conversation wired to the local fake model server. It also configures the compact prompt and, when requested, the model name used by the test.

**Data flow**: It receives the mock server and an optional model name. It builds a base URL pointing at the server, customizes the test config to use that server and summarization prompt, creates the test Codex instance, and returns the temporary home directory, config, thread manager, and active conversation thread.

**Call relations**: All top-level tests call this after starting the mock server. The returned conversation is then driven by helpers such as `user_turn`, `compact_conversation`, `resume_conversation`, and `fork_thread`.

*Call graph*: calls 1 internal fn (test_codex); called by 4 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view, snapshot_rollback_followup_turn_trims_context_updates, snapshot_rollback_past_compaction_replays_append_only_history); 2 external calls (pin, format!).


##### `user_turn`  (lines 773–788)

```
async fn user_turn(conversation: &Arc<CodexThread>, text: &str)
```

**Purpose**: Sends one user text message into a conversation and waits until Codex finishes processing that turn. It is the test helper for saying, “the user now typed this.”

**Data flow**: It receives a conversation thread and a text string. It submits a `UserInput` operation containing that text, then waits until a turn-complete event arrives. It returns nothing, but the conversation state and mock server request log have advanced.

**Call relations**: Every scenario uses this to drive user messages. It hands control to the conversation thread, then waits through `wait_for_event` so later assertions run only after the model request and response have completed.

*Call graph*: called by 4 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view, snapshot_rollback_followup_turn_trims_context_updates, snapshot_rollback_past_compaction_replays_append_only_history); 3 external calls (default, wait_for_event, vec!).


##### `compact_conversation`  (lines 790–807)

```
async fn compact_conversation(conversation: &Arc<CodexThread>)
```

**Purpose**: Triggers compaction for a conversation and waits until it has fully completed. It also confirms Codex emits the expected warning message during compaction.

**Data flow**: It receives a conversation thread, submits a compact operation, waits for a warning event with the expected compaction warning text, checks that the warning matches, and then waits for the turn-complete event. It changes the conversation by adding a compacted summary state.

**Call relations**: The compaction-related tests call this after one or more user turns. It submits the operation directly to the conversation and uses event waiting to ensure the next test step sees the completed compacted state.

*Call graph*: called by 3 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view, snapshot_rollback_past_compaction_replays_append_only_history); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `fetch_conversation_path`  (lines 809–811)

```
fn fetch_conversation_path(conversation: &Arc<CodexThread>) -> std::path::PathBuf
```

**Purpose**: Gets the filesystem path where the current conversation rollout is saved. The tests need this path so they can resume or fork the conversation from disk.

**Data flow**: It receives a conversation thread, asks it for its rollout path, and returns that path. If the conversation does not have a rollout path, the test fails.

**Call relations**: The compact/resume/fork tests call this after important milestones. The returned path is passed into `resume_conversation` or `fork_thread` so those helpers can load the saved history.

*Call graph*: called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view).


##### `shutdown_conversation`  (lines 813–818)

```
async fn shutdown_conversation(conversation: &Arc<CodexThread>)
```

**Purpose**: Stops a conversation thread and waits for it to finish shutting down. This simulates closing a session before reopening it from its saved rollout file.

**Data flow**: It receives a conversation thread, calls its shutdown method, waits for completion, and fails the test if shutdown reports an error. It returns nothing.

**Call relations**: The resume scenarios call this before `resume_conversation`. It makes the test closer to real use: save, close, then reopen from disk.

*Call graph*: called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view).


##### `resume_conversation`  (lines 820–837)

```
async fn resume_conversation(
    manager: &ThreadManager,
    config: &Config,
    path: std::path::PathBuf,
) -> Arc<CodexThread>
```

**Purpose**: Reopens a saved conversation from its rollout file. This is the test helper for checking that persisted history can be loaded back into a new active thread.

**Data flow**: It receives a thread manager, config, and rollout path. It creates a dummy API-key authentication manager, asks the thread manager to resume from the rollout using a cloned config, waits for that operation, and returns the resumed conversation thread.

**Call relations**: The compact/resume/fork tests call this after `shutdown_conversation` and `fetch_conversation_path`. The resumed thread is then passed back to `user_turn` so the test can see what history Codex sends on the next request.

*Call graph*: calls 3 internal fn (auth_manager_from_auth, resume_thread_from_rollout, from_api_key); called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view); 2 external calls (pin, clone).


##### `fork_thread`  (lines 840–856)

```
async fn fork_thread(
    manager: &ThreadManager,
    config: &Config,
    path: std::path::PathBuf,
    nth_user_message: usize,
) -> Arc<CodexThread>
```

**Purpose**: Creates a new conversation branch from a saved rollout at a chosen user-message position. This lets the tests check that branching preserves the right compacted history while allowing new messages on the fork.

**Data flow**: It receives a thread manager, config, rollout path, and the number of the user message to fork from. It asks the manager to create the fork using a cloned config and returns the new thread from the result. If forking fails, the test fails.

**Call relations**: The compact/resume/fork tests call this after resuming and saving a conversation path. The returned forked thread is driven with `user_turn`, and the later request log is checked to ensure the branch sees the expected history.

*Call graph*: calls 1 internal fn (fork_thread); called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view); 2 external calls (pin, clone).


### Pending turn continuity
These tests cover in-flight input replay and the resumed-session initialization details that preserve or warn about conversation state.

### `core/tests/suite/pending_input.rs`

`test` · `test run`

This is a test file for a tricky timing problem: Codex can be in the middle of a model response when more input arrives. That input might be a user steering message, a message from another agent, or a signal that should interrupt a long-running tool such as sleep or wait. If this logic is wrong, Codex could ignore the new input, stop too early, run stale tool calls, or send the model a confusing conversation history.

The tests build a fake streaming model server. The fake server sends planned Server-Sent Events, which are small streamed messages like “response started”, “tool call requested”, “text arrived”, or “response completed”. Some chunks are held behind gates, like pausing a movie at an exact frame, so the test can inject new input at the precise moment it wants.

Most helper functions make these tests easier to read: they create fake stream chunks, submit user input, send queue-only agent mail, wait for specific Codex events, and inspect the JSON request bodies Codex sent to the fake server. The actual tests then verify important rules: steering can interrupt waits and sleeps; mailbox updates can trigger follow-up requests after safe stopping points; normal user steering should not preempt certain in-progress reasoning; and automatic context compaction should happen before pending steering is sent when needed.

#### Function details

##### `ev_message_item_done`  (lines 41–51)

```
fn ev_message_item_done(id: &str, text: &str) -> Value
```

**Purpose**: Builds a fake model-stream event saying that an assistant message item is finished. Tests use it to make the mock server look like the real model API.

**Data flow**: It receives a message id and final text. It wraps them into a JSON object with the expected event shape and returns that JSON value.

**Call relations**: This helper feeds event data into chunk-building helpers and test scenarios. It relies on the JSON macro to create the exact structure the streaming test server will later send to Codex.

*Call graph*: 1 external calls (json!).


##### `sse_event`  (lines 53–55)

```
fn sse_event(event: Value) -> String
```

**Purpose**: Turns one JSON event into a Server-Sent Events string. Server-Sent Events are a simple streaming format where the server sends one event after another over one connection.

**Data flow**: It receives a JSON event. It places that event in a one-item list, formats it as an SSE response body, and returns the resulting text.

**Call relations**: Tests use this when they manually build streaming chunks. It hands the event to the shared response-formatting helper so the mock server emits data in the same style as the real API.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `message_input_texts`  (lines 57–69)

```
fn message_input_texts(body: &Value, role: &str) -> Vec<String>
```

**Purpose**: Extracts the plain text messages for a chosen role, such as user or assistant, from a request body sent to the model. Tests use it to prove that pending input appeared, or did not appear, in the right follow-up request.

**Data flow**: It receives a JSON request body and a role name. It looks through the request's input list, keeps only message items for that role, reads their input_text spans, and returns those text strings as a list.

**Call relations**: Several tests call this after asking the fake server what requests Codex sent. It turns large JSON request bodies into a simple list of texts so the tests can compare the conversation history against expectations.

*Call graph*: called by 6 (any_new_input_interrupts_sleep, injected_user_input_triggers_follow_up_request_with_deltas, steer_interrupts_wait_agent_and_is_sent_in_follow_up_request, steered_user_input_follows_compact_when_only_the_steer_needs_follow_up, steered_user_input_waits_for_model_continuation_after_mid_turn_compact, steered_user_input_waits_when_tool_output_triggers_compact_before_next_request); 1 external calls (get).


##### `function_call_output_text`  (lines 71–81)

```
fn function_call_output_text(body: &'a Value, call_id: &str) -> Option<&'a str>
```

**Purpose**: Finds the output text for a specific tool call inside a model request body. Tests use it to check what Codex told the model about an interrupted wait or sleep tool.

**Data flow**: It receives a JSON request body and a tool call id. It scans the request input for a function_call_output item with that call id and returns its output string if found.

**Call relations**: The wait-agent and sleep interruption tests call this after a follow-up request is sent. It supplies the exact tool-result text that those tests then parse or validate.

*Call graph*: called by 2 (any_new_input_interrupts_sleep, steer_interrupts_wait_agent_and_is_sent_in_follow_up_request); 1 external calls (get).


##### `assert_interrupted_sleep_output`  (lines 83–97)

```
fn assert_interrupted_sleep_output(output: Option<&str>)
```

**Purpose**: Checks that a sleep tool result says the sleep was interrupted and includes a numeric wall-clock time. This protects the user-visible tool output format from silently changing.

**Data flow**: It receives an optional output string. If the output is missing, has the wrong wording, or has a non-number wall time, it fails the test; otherwise it returns normally.

**Call relations**: The sleep interruption test calls this on tool outputs found by function_call_output_text. It is the final checker that confirms Codex reported the interrupted sleep correctly.

*Call graph*: called by 1 (any_new_input_interrupts_sleep); 2 external calls (assert!, panic!).


##### `chunk`  (lines 99–104)

```
fn chunk(event: Value) -> StreamingSseChunk
```

**Purpose**: Builds an immediately available streaming chunk for the fake model server. A chunk is one piece of streamed response data.

**Data flow**: It receives a JSON event. It formats the event as an SSE body and returns a StreamingSseChunk with no gate, meaning the mock server may send it right away.

**Call relations**: Most tests use this to assemble the fake model's scripted responses. It wraps event construction and SSE formatting so each scenario can focus on the timing behavior being tested.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `gated_chunk`  (lines 106–111)

```
fn gated_chunk(gate: oneshot::Receiver<()>, events: Vec<Value>) -> StreamingSseChunk
```

**Purpose**: Builds a streaming chunk that waits for a signal before the fake server sends it. This lets a test pause the model stream at a controlled point.

**Data flow**: It receives a one-shot gate and a list of JSON events. It formats the events as one SSE body and returns a chunk that will not be released until the gate receives its signal.

**Call relations**: Timing-sensitive tests use this to inject pending input while the model is paused mid-response. Once the test sends the gate signal, the fake server continues streaming.

*Call graph*: calls 1 internal fn (sse).


##### `response_completed_chunks`  (lines 113–118)

```
fn response_completed_chunks(response_id: &str) -> Vec<StreamingSseChunk>
```

**Purpose**: Creates the smallest fake response that starts and then completes. Tests use it as a simple follow-up model response when the content is not important.

**Data flow**: It receives a response id. It returns two streaming chunks: one saying the response was created and one saying it completed.

**Call relations**: Many tests pass this to the fake streaming server as the second or later response. It keeps setup short when the test only needs Codex to make another request and finish.

*Call graph*: 1 external calls (vec!).


##### `build_codex`  (lines 120–127)

```
async fn build_codex(server: &StreamingSseServer) -> Arc<CodexThread>
```

**Purpose**: Creates a test Codex session connected to the fake streaming server. It gives tests a ready-to-use Codex thread without repeating setup code.

**Data flow**: It receives a fake streaming server. It builds a TestCodex session using model gpt-5.4, points it at that server, and returns the Codex thread inside an Arc, which is a shared pointer.

**Call relations**: The inter-agent-mail and reasoning tests call this before submitting input. It delegates the detailed session construction to the shared test_codex builder.

*Call graph*: calls 1 internal fn (test_codex); called by 3 (queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, queued_inter_agent_mail_triggers_follow_up_after_reasoning_item, user_input_does_not_preempt_after_reasoning_item).


##### `submit_user_input`  (lines 129–143)

```
async fn submit_user_input(codex: &CodexThread, text: &str)
```

**Purpose**: Sends a normal user text turn into Codex. Tests use it to start a conversation or queue another full user request.

**Data flow**: It receives a Codex thread and text. It wraps the text in the protocol's UserInput format, fills optional fields with defaults, submits it to Codex, and fails the test if submission fails.

**Call relations**: Most test cases call this to create the first prompt, and some call it again to queue later input. It hands the operation to CodexThread.submit, which starts or feeds the session.

*Call graph*: calls 1 internal fn (submit); called by 7 (any_new_input_interrupts_sleep, queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, queued_inter_agent_mail_triggers_follow_up_after_reasoning_item, steer_interrupts_wait_agent_and_is_sent_in_follow_up_request, steered_user_input_follows_compact_when_only_the_steer_needs_follow_up, steered_user_input_waits_for_model_continuation_after_mid_turn_compact, user_input_does_not_preempt_after_reasoning_item); 2 external calls (default, vec!).


##### `submit_danger_full_access_user_turn`  (lines 145–175)

```
async fn submit_danger_full_access_user_turn(test: &TestCodex, text: &str)
```

**Purpose**: Submits a user turn with sandboxing disabled and approval turned off, so a shell command can run freely inside a test. It is used only where the test needs a real large tool output.

**Data flow**: It receives a TestCodex session and prompt text. It builds permission settings for full access, includes local environment selections, submits the text as a user turn with those overrides, and fails if submission does not work.

**Call relations**: The tool-output-compaction test calls this to allow a shell command that prints a large amount of text. It uses helper functions for permission fields and local environment choices before handing the operation to Codex.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 1 (steered_user_input_waits_when_tool_output_triggers_compact_before_next_request); 2 external calls (default, vec!).


##### `steer_user_input`  (lines 177–191)

```
async fn steer_user_input(codex: &CodexThread, text: &str)
```

**Purpose**: Sends a steering message while a turn may already be running. Steering is extra user guidance meant to influence or interrupt the current flow rather than start a completely separate normal turn.

**Data flow**: It receives a Codex thread and text. It wraps the text as user input, calls Codex's steer_input method with default context and no expected turn id, and fails the test if Codex rejects it.

**Call relations**: Tests call this at carefully chosen moments, such as during sleep, wait, reasoning, or before compaction. It is the main way these tests create pending user input mid-turn.

*Call graph*: calls 1 internal fn (steer_input); called by 5 (any_new_input_interrupts_sleep, steer_interrupts_wait_agent_and_is_sent_in_follow_up_request, steered_user_input_follows_compact_when_only_the_steer_needs_follow_up, steered_user_input_waits_when_tool_output_triggers_compact_before_next_request, user_input_does_not_preempt_after_reasoning_item); 2 external calls (default, vec!).


##### `submit_queue_only_agent_mail`  (lines 193–214)

```
async fn submit_queue_only_agent_mail(codex: &CodexThread, text: &str)
```

**Purpose**: Sends an agent-to-agent message that should be queued but should not immediately trigger a new turn by itself. It then waits until Codex has processed the submission barrier.

**Data flow**: It receives a Codex thread and mail text. It creates an inter-agent communication from a worker agent to the root agent with trigger_turn set to false, submits it, then submits a harmless list-voices operation and waits for its response to prove the queue operation has been processed.

**Call relations**: The mailbox-related tests use this to add pending agent mail while another model response is paused. The barrier operation makes the test reliable by ensuring Codex has seen the mail before the stream continues.

*Call graph*: calls 4 internal fn (submit, root, try_from, new); called by 3 (any_new_input_interrupts_sleep, queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, queued_inter_agent_mail_triggers_follow_up_after_reasoning_item); 2 external calls (new, wait_for_event).


##### `wait_for_reasoning_item_started`  (lines 216–225)

```
async fn wait_for_reasoning_item_started(codex: &CodexThread)
```

**Purpose**: Waits until Codex reports that a reasoning item has started. A reasoning item is the model's internal thinking trace as represented by the protocol.

**Data flow**: It receives a Codex thread. It watches emitted events until it finds an ItemStarted event whose item is Reasoning, then returns.

**Call relations**: Tests use this as a timing marker before injecting queued mail or steering input. It relies on the shared wait_for_event helper to listen to Codex events.

*Call graph*: called by 2 (queued_inter_agent_mail_triggers_follow_up_after_reasoning_item, user_input_does_not_preempt_after_reasoning_item); 1 external calls (wait_for_event).


##### `wait_for_agent_message`  (lines 227–234)

```
async fn wait_for_agent_message(codex: &CodexThread, text: &str)
```

**Purpose**: Waits until Codex emits a final assistant message with the exact expected text. This proves a particular model response made it through to the user-facing event stream.

**Data flow**: It receives a Codex thread and expected message text. It listens for an AgentMessage event with that text, then asserts that the matched event is indeed an agent message.

**Call relations**: Several tests call this before continuing or before checking requests. It acts as a human-readable checkpoint, such as “the first answer arrived” or “the steered prompt was processed.”

*Call graph*: called by 4 (queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, steered_user_input_follows_compact_when_only_the_steer_needs_follow_up, steered_user_input_waits_for_model_continuation_after_mid_turn_compact, user_input_does_not_preempt_after_reasoning_item); 2 external calls (assert!, wait_for_event).


##### `wait_for_turn_complete`  (lines 236–238)

```
async fn wait_for_turn_complete(codex: &CodexThread)
```

**Purpose**: Waits until Codex says the current turn is finished. Tests use it before inspecting final request counts and histories.

**Data flow**: It receives a Codex thread. It listens for a TurnComplete event and then returns.

**Call relations**: Nearly every full scenario uses this near the end. It ensures Codex has finished all follow-up work before the test examines the fake server's recorded requests.

*Call graph*: called by 8 (any_new_input_interrupts_sleep, queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, queued_inter_agent_mail_triggers_follow_up_after_reasoning_item, steer_interrupts_wait_agent_and_is_sent_in_follow_up_request, steered_user_input_follows_compact_when_only_the_steer_needs_follow_up, steered_user_input_waits_for_model_continuation_after_mid_turn_compact, steered_user_input_waits_when_tool_output_triggers_compact_before_next_request, user_input_does_not_preempt_after_reasoning_item); 1 external calls (wait_for_event).


##### `wait_for_sleep_item_started`  (lines 240–262)

```
async fn wait_for_sleep_item_started(codex: &CodexThread, call_id: &str, duration_ms: u64)
```

**Purpose**: Waits for a specific sleep tool call to start and verifies its duration. This confirms Codex recognized the model's sleep function call correctly.

**Data flow**: It receives a Codex thread, a sleep call id, and an expected duration in milliseconds. It waits for a matching Sleep item start event, extracts the item, and compares it with the expected id and duration.

**Call relations**: The sleep interruption test uses this before sending input that should interrupt the sleep. It depends on wait_for_event to pause until Codex reports the sleep item.

*Call graph*: called by 1 (any_new_input_interrupts_sleep); 3 external calls (assert_eq!, wait_for_event, unreachable!).


##### `wait_for_sleep_item_completed`  (lines 264–286)

```
async fn wait_for_sleep_item_completed(codex: &CodexThread, call_id: &str, duration_ms: u64)
```

**Purpose**: Waits for a specific sleep tool call to complete and verifies its duration. In these tests, completion may mean the sleep was interrupted rather than allowed to run for the full time.

**Data flow**: It receives a Codex thread, a sleep call id, and an expected duration. It waits for a matching Sleep item completion event, extracts the item, and checks that the id and duration are exactly what the test expected.

**Call relations**: The sleep interruption test calls this after injecting user input or agent mail. It confirms Codex closed out the sleep tool before sending the next model request.

*Call graph*: called by 1 (any_new_input_interrupts_sleep); 3 external calls (assert_eq!, wait_for_event, unreachable!).


##### `steer_interrupts_wait_agent_and_is_sent_in_follow_up_request`  (lines 289–348)

```
async fn steer_interrupts_wait_agent_and_is_sent_in_follow_up_request()
```

**Purpose**: Tests that steering input interrupts a wait_agent tool call and is included in the next request to the model. Without this behavior, Codex could remain stuck waiting even after the user tells it to continue.

**Data flow**: The test scripts a first model response that calls wait_agent, then a simple follow-up response. It submits an initial prompt, waits until Codex begins waiting, sends steering text, waits for completion, and inspects the second request to ensure both prompts are present and the wait tool output says it was interrupted.

**Call relations**: This scenario uses the fake streaming server, submit_user_input, steer_user_input, wait_for_turn_complete, message_input_texts, and function_call_output_text. It exercises the path where mid-turn user steering breaks a collaboration wait and becomes part of the follow-up model context.

*Call graph*: calls 7 internal fn (start_streaming_sse_server, test_codex, function_call_output_text, message_input_texts, steer_user_input, submit_user_input, wait_for_turn_complete); 4 external calls (assert_eq!, wait_for_event, from_slice, vec!).


##### `any_new_input_interrupts_sleep`  (lines 351–456)

```
async fn any_new_input_interrupts_sleep()
```

**Purpose**: Tests that any new input, whether from the user or queued agent mail, interrupts a running sleep tool. This matters because a sleeping agent should wake up when new information arrives.

**Data flow**: The test scripts two long sleep calls followed by a final response. It starts the first sleep, sends steering input to interrupt it, starts a second sleep, sends queue-only agent mail to interrupt that one, then checks later model requests for interrupted sleep outputs. It also shuts Codex down and reads the rollout log to confirm completed sleep items were persisted.

**Call relations**: This is the main consumer of the sleep helper functions, submit_queue_only_agent_mail, message_input_texts, function_call_output_text, and assert_interrupted_sleep_output. It connects live event behavior, outgoing model request contents, and persisted rollout history into one end-to-end check.

*Call graph*: calls 11 internal fn (start_streaming_sse_server, test_codex, assert_interrupted_sleep_output, function_call_output_text, message_input_texts, steer_user_input, submit_queue_only_agent_mail, submit_user_input, wait_for_sleep_item_completed, wait_for_sleep_item_started (+1 more)); 6 external calls (assert_eq!, wait_for_event, json!, from_slice, read_to_string, vec!).


##### `assert_two_responses_input_snapshot`  (lines 458–480)

```
fn assert_two_responses_input_snapshot(snapshot_name: &str, requests: &[Vec<u8>])
```

**Purpose**: Compares the input portions of two model requests against a stored snapshot. A snapshot is a saved expected text representation used to catch unexpected changes.

**Data flow**: It receives a snapshot name and the raw request bytes recorded by the fake server. It parses the first two request bodies, extracts their input arrays, formats them with redactions and capability instructions removed, and asks the snapshot test tool to compare the result.

**Call relations**: The reasoning and mailbox timing tests call this after Codex finishes. It turns complex JSON requests into stable, readable evidence of what conversation context Codex sent before and after pending input arrived.

*Call graph*: calls 2 internal fn (default, format_labeled_items_snapshot); called by 3 (queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, queued_inter_agent_mail_triggers_follow_up_after_reasoning_item, user_input_does_not_preempt_after_reasoning_item); 3 external calls (assert_eq!, assert_snapshot!, from_slice).


##### `injected_user_input_triggers_follow_up_request_with_deltas`  (lines 484–587)

```
async fn injected_user_input_triggers_follow_up_request_with_deltas()
```

**Purpose**: Tests that a second user input arriving while assistant text deltas are streaming causes a follow-up request that includes both the original and new prompt. The test is currently ignored because it is marked flaky.

**Data flow**: The test pauses the fake model just before completing the first response, after some text deltas have arrived. It submits a first prompt, waits for a content delta, submits a second prompt, releases the completion gate, then checks that the first request had only the first prompt while the second request had both.

**Call relations**: This scenario directly uses the fake server, wait_for_event, and message_input_texts rather than the smaller submit helper. It represents the case where new user input arrives during streamed assistant text.

*Call graph*: calls 3 internal fn (start_streaming_sse_server, test_codex, message_input_texts); 7 external calls (default, assert!, assert_eq!, wait_for_event, channel, from_slice, vec!).


##### `queued_inter_agent_mail_triggers_follow_up_after_reasoning_item`  (lines 590–632)

```
async fn queued_inter_agent_mail_triggers_follow_up_after_reasoning_item()
```

**Purpose**: Tests that queued agent mail arriving after a reasoning item starts causes Codex to make a follow-up request instead of continuing with stale later items from the old response.

**Data flow**: The test pauses the first response after a reasoning item begins. It submits an initial prompt, waits for reasoning to start, queues agent mail, releases the rest of the old response, waits for the turn to complete, and snapshots the two request inputs.

**Call relations**: It uses build_codex, submit_user_input, wait_for_reasoning_item_started, submit_queue_only_agent_mail, wait_for_turn_complete, and assert_two_responses_input_snapshot. The scripted stale tool call and stale message after the gate are there to prove Codex should pivot to a follow-up path once mail is pending.

*Call graph*: calls 7 internal fn (start_streaming_sse_server, assert_two_responses_input_snapshot, build_codex, submit_queue_only_agent_mail, submit_user_input, wait_for_reasoning_item_started, wait_for_turn_complete); 2 external calls (channel, vec!).


##### `queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item`  (lines 635–696)

```
async fn queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item()
```

**Purpose**: Tests that queued agent mail arriving around a commentary assistant message also leads to a follow-up request at the right safe point. Commentary here means an assistant message phase used before final completion.

**Data flow**: The test pauses the fake response while an assistant message item is in progress. It submits the first prompt, waits for that message item to start, queues agent mail, releases the response, confirms the visible message arrives, waits for completion, and snapshots the two request inputs.

**Call relations**: It follows the same pattern as the reasoning-mail test but uses an agent message checkpoint instead of a reasoning checkpoint. It calls build_codex, submit_queue_only_agent_mail, wait_for_agent_message, wait_for_turn_complete, and the snapshot assertion helper.

*Call graph*: calls 7 internal fn (start_streaming_sse_server, assert_two_responses_input_snapshot, build_codex, submit_queue_only_agent_mail, submit_user_input, wait_for_agent_message, wait_for_turn_complete); 3 external calls (wait_for_event, channel, vec!).


##### `user_input_does_not_preempt_after_reasoning_item`  (lines 699–746)

```
async fn user_input_does_not_preempt_after_reasoning_item()
```

**Purpose**: Tests that ordinary steered user input does not cut off a model response immediately after a reasoning item has started. This guards against dropping valid tool calls and final messages that should still be preserved.

**Data flow**: The test pauses after reasoning starts, sends steering input, then releases a response containing a tool call and final answer. It waits for the original final answer and turn completion, then snapshots the first and follow-up request inputs.

**Call relations**: This scenario mirrors the queued-mail reasoning test but changes the new input source to steer_user_input. The contrast proves Codex treats user steering and inter-agent mail differently at this stage.

*Call graph*: calls 8 internal fn (start_streaming_sse_server, assert_two_responses_input_snapshot, build_codex, steer_user_input, submit_user_input, wait_for_agent_message, wait_for_reasoning_item_started, wait_for_turn_complete); 2 external calls (channel, vec!).


##### `steered_user_input_waits_for_model_continuation_after_mid_turn_compact`  (lines 749–839)

```
async fn steered_user_input_waits_for_model_continuation_after_mid_turn_compact()
```

**Purpose**: Tests that when automatic context compaction happens in the middle of an unfinished turn, steered user input waits until after the model resumes the old task. Compaction means summarizing old context to fit within the model's token budget.

**Data flow**: The test scripts an initial tool call with high token usage, a compacting summary response, a post-compact continuation, and then a steered follow-up. It submits two user inputs, waits for the resumed old-task message, and verifies the second prompt is absent from the post-compact continuation request but present in the later steered request.

**Call relations**: It uses submit_user_input, wait_for_agent_message, wait_for_turn_complete, and message_input_texts. It checks the ordering between compaction, continuing the interrupted model turn, and finally sending pending steering.

*Call graph*: calls 6 internal fn (start_streaming_sse_server, test_codex, message_input_texts, submit_user_input, wait_for_agent_message, wait_for_turn_complete); 4 external calls (assert!, assert_eq!, from_slice, vec!).


##### `steered_user_input_follows_compact_when_only_the_steer_needs_follow_up`  (lines 842–926)

```
async fn steered_user_input_follows_compact_when_only_the_steer_needs_follow_up()
```

**Purpose**: Tests that if the model's original answer is already done, pending steering can follow immediately after compaction without an unnecessary empty resume request. This keeps the request sequence efficient while still keeping compaction separate.

**Data flow**: The test lets the first answer stream, sends steering input before the completion event is released, then triggers compaction and a steered follow-up. It checks that the steering text is not included in the compaction request but is included in the next request.

**Call relations**: It uses gated streaming, submit_user_input, steer_user_input, wait_for_agent_message, wait_for_turn_complete, and message_input_texts. It focuses on the case where only the pending steer needs another model call after compaction.

*Call graph*: calls 7 internal fn (start_streaming_sse_server, test_codex, message_input_texts, steer_user_input, submit_user_input, wait_for_agent_message, wait_for_turn_complete); 5 external calls (assert!, assert_eq!, channel, from_slice, vec!).


##### `steered_user_input_waits_when_tool_output_triggers_compact_before_next_request`  (lines 929–1051)

```
async fn steered_user_input_waits_when_tool_output_triggers_compact_before_next_request()
```

**Purpose**: Tests that when a large tool output forces compaction before the next model request, steered input still waits until after the compacted continuation. This prevents the new user request from being mixed into the model's needed continuation after tool output.

**Data flow**: The test creates a shell command that prints a large amount of text, submits a full-access user turn so the command can run, sends steering input while the first response is gated, then releases completion. It verifies four requests: original, compaction, post-compaction continuation, and steered follow-up; the second prompt appears only in the final one.

**Call relations**: This is the most complete compaction timing test. It uses submit_danger_full_access_user_turn for the real tool output, steer_user_input for pending input, wait_for_turn_complete for synchronization, and message_input_texts to inspect where the steering text ended up.

*Call graph*: calls 6 internal fn (start_streaming_sse_server, test_codex, message_input_texts, steer_user_input, submit_danger_full_access_user_turn, wait_for_turn_complete); 8 external calls (assert!, assert_eq!, cfg!, wait_for_event, json!, channel, from_slice, vec!).


### `core/tests/suite/resume.rs`

`test` · `test execution`

This is a test file for the session resume feature. A Codex session writes a “rollout” record, which is the saved trail of what happened in the conversation. When the session is resumed, the system should rebuild useful starting messages from that trail, much like reopening a chat app and seeing the earlier messages already in place.

The tests create a fake server that pretends to be the model API. They send user input, feed back scripted server-sent events (streamed responses from the fake model), wait until the turn finishes, and then resume from the saved rollout file. The tests then check that the resumed session contains the expected initial messages: user text, assistant text, reasoning summaries, raw reasoning details when enabled, token count events, and the final turn-complete event.

The file also tests a more subtle case: resuming with a different model. The system should keep the original base instructions, because those describe how the session began, but it should also add a clear developer message saying the model changed. That model-switch note should appear when needed, but not be duplicated on later turns or after a pre-turn model override.

#### Function details

##### `resume_until_initial_messages`  (lines 27–58)

```
async fn resume_until_initial_messages(
    builder: &mut TestCodexBuilder,
    server: &MockServer,
    home: Arc<TempDir>,
    rollout_path: PathBuf,
    predicate: impl Fn(&[EventMsg]) -> bool,
) -
```

**Purpose**: This helper repeatedly resumes a saved session until the resumed session shows the initial messages the test is waiting for. It exists because the rollout file may not be fully settled at the exact instant the test first tries to reopen it.

**Data flow**: It receives a test session builder, the fake server, the temporary home directory, the rollout file path, and a check function that recognizes the desired message shape. It tries to resume from the rollout, looks at the resumed session’s initial messages, and returns the resumed session once the check passes. If the messages never match within a short timeout, it stops the test with a clear failure message showing the last messages it saw.

**Call relations**: The two initial-message resume tests call this helper after they have completed a turn and saved rollout events. Inside the helper, the builder’s resume operation does the actual reopening; this helper adds the polling loop around it so the tests can focus on what the resumed messages should contain.

*Call graph*: calls 1 internal fn (resume); called by 2 (resume_includes_initial_messages_from_reasoning_events, resume_includes_initial_messages_from_rollout_events); 8 external calls (clone, from_millis, from_secs, clone, format!, panic!, now, sleep).


##### `resume_includes_initial_messages_from_rollout_events`  (lines 61–146)

```
async fn resume_includes_initial_messages_from_rollout_events() -> Result<()>
```

**Purpose**: This test checks that ordinary conversation events are restored as initial messages when a session is resumed. It verifies that the user message, assistant reply, and completed-turn information survive the save-and-resume path.

**Data flow**: The test starts a fake model server and a fresh Codex session, then saves the rollout path from that session. It scripts the fake server to return a normal assistant response, submits a user message with text metadata, waits for the turn to finish, and resumes from the rollout. The output it checks is the resumed session’s initial message list, which must contain the turn start, the original user message and text elements, the assistant message, token count, and a turn-complete event tied to the same turn.

**Call relations**: This test uses the mock-server helpers to provide a controlled streamed model response, then calls resume_until_initial_messages to reopen the saved session only once the expected message shape appears. The assertions at the end confirm that the resume code reconstructed the conversation accurately from the rollout events.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, resume_until_initial_messages); 7 external calls (clone, default, assert_eq!, wait_for_event, panic!, skip_if_no_network!, vec!).


##### `resume_includes_initial_messages_from_reasoning_events`  (lines 149–237)

```
async fn resume_includes_initial_messages_from_reasoning_events() -> Result<()>
```

**Purpose**: This test checks that reasoning events are also restored when a session is resumed, not just the final assistant answer. It matters for configurations where the user interface is allowed to show the model’s reasoning summary or raw reasoning content.

**Data flow**: The test starts a fake server and builds a Codex session with raw agent reasoning display turned on. It scripts a response that includes a reasoning summary, raw reasoning text, an assistant message, and completion. After submitting user input and waiting for the turn to finish, it resumes from the saved rollout and inspects the initial messages. The resumed messages must include the user message, the reasoning summary, the raw reasoning text, the assistant message, token count, and the completed turn.

**Call relations**: Like the ordinary rollout test, this test relies on the fake server and resume_until_initial_messages to create and reopen a saved session. Its special role is to prove that the resume path keeps the reasoning-related events in the right order when the configuration says those events should be visible.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, resume_until_initial_messages); 7 external calls (clone, default, assert_eq!, wait_for_event, panic!, skip_if_no_network!, vec!).


##### `resume_switches_models_preserves_base_instructions`  (lines 240–369)

```
async fn resume_switches_models_preserves_base_instructions() -> Result<()>
```

**Purpose**: This test checks what happens when a saved session is resumed with a different model selected. The original base instructions must stay the same, while the resumed conversation must include a clear note that the model changed.

**Data flow**: The test first creates a session using one model and records the instructions sent to the fake server during the initial turn. It then resumes the same rollout with a different configured model and sends two more user turns. It inspects the two resumed requests sent to the fake server: both must keep the original instructions, the first resumed turn must include a model-switch developer message, and the second turn must not add extra duplicate model-switch messages beyond the expected one already in the conversation.

**Call relations**: This test uses one mock response for the original turn and a sequence of mock responses for the two resumed turns. It does not use the polling helper because it is focused on the outgoing request bodies after resume, especially the preserved instructions and the developer messages that explain the model change.

*Call graph*: calls 5 internal fn (mount_sse_once, mount_sse_sequence, sse, start_mock_server, test_codex); 7 external calls (clone, default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `resume_model_switch_is_not_duplicated_after_pre_turn_override`  (lines 372–461)

```
async fn resume_model_switch_is_not_duplicated_after_pre_turn_override() -> Result<()>
```

**Purpose**: This test checks that changing the model through thread settings right after resume does not create repeated model-switch notes. It guards against confusing the model with duplicate developer messages that say essentially the same thing.

**Data flow**: The test creates an initial session with one model, completes a turn, and then resumes the rollout with a different configured model. Before sending the first resumed user turn, it submits a thread settings override that changes the model again. After the resumed turn completes, it inspects the request sent to the fake server and counts developer messages containing the model-switch marker. The expected result is exactly one such message.

**Call relations**: This test combines the normal fake-server resume setup with an explicit thread-settings submission before the next user turn. It verifies the interaction between resume-time model switching and pre-turn model overrides, making sure the request-building path records the model change once rather than stacking duplicate notices.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (clone, default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/resume_warning.rs`

`test` · `test run`

This is a focused automated test for conversation resume behavior. A resumed conversation carries some saved history, including the model that was used before. If the user’s current configuration names a different model, that difference matters: the assistant may behave differently, have different capabilities, or use a different context size. Without this warning, a user could unknowingly continue work under changed assumptions.

The helper function builds a small fake saved conversation. It creates a turn that looks realistic enough for the resume code: a turn starts, the user says “seed,” the turn records its context, and the turn completes. The important detail inside that context is the old model name.

The test then creates a temporary home directory, loads a normal test configuration, sets the current model to “current-model,” and creates an empty rollout file path to represent the saved conversation file. It starts a test thread manager and asks it to resume from the fake history. Finally, it waits for a Warning event whose message mentions both the previous and current model names. That confirms the system noticed the mismatch and told the client about it. A short sleep at the end gives background tasks time to settle so the test does not leave work running behind it.

#### Function details

##### `resume_history`  (lines 22–80)

```
fn resume_history(
    config: &codex_core::config::Config,
    previous_model: &str,
    rollout_path: &std::path::Path,
) -> InitialHistory
```

**Purpose**: Builds a small, realistic saved conversation history for the test to resume. Its main job is to record that the earlier conversation used a chosen previous model, so the resume code has something to compare against the current model.

**Data flow**: It receives the current test configuration, a previous model name, and a path to the saved rollout file. It copies needed settings from the configuration, places the previous model name into a turn context record, wraps that with a start event, a user message, and a completion event, and returns an InitialHistory value that says this is resumed history.

**Call relations**: The test function calls this helper during setup, before asking the thread manager to resume a conversation. The object it returns is handed into the resume flow, where the production code reads it and can detect that the old model differs from the current configured model.

*Call graph*: calls 1 internal fn (default); called by 1 (emits_warning_when_resumed_model_differs); 4 external calls (to_path_buf, legacy_sandbox_policy, Resumed, vec!).


##### `emits_warning_when_resumed_model_differs`  (lines 83–135)

```
async fn emits_warning_when_resumed_model_differs()
```

**Purpose**: Checks the expected user-facing behavior: resuming a conversation made with one model while configured for another model should emit a warning. This makes sure the mismatch is visible instead of being silently ignored.

**Data flow**: It creates a temporary test home, loads a default test configuration, changes the current model to “current-model,” and creates a fake rollout file. It then uses resume_history to make saved history that says the previous model was “previous-model.” After starting a test thread manager and resuming the conversation, it listens for events from the conversation and succeeds only if it sees a warning message containing both model names.

**Call relations**: This is the Tokio asynchronous test entry point for the file. It calls the local resume_history helper to prepare input data, uses test-support helpers to create authentication and a thread manager, then invokes the real resume path. After that, it relies on wait_for_event to observe the warning produced during initialization.

*Call graph*: calls 4 internal fn (auth_manager_from_auth, thread_manager_with_models_provider, resume_history, from_api_key); 8 external calls (from_millis, new, assert!, load_default_config_for_test, wait_for_event, panic!, write, sleep).


### Fork and window lineage
These files verify how persisted history supports thread forking and how request window identifiers evolve across compaction, resume, and fork.

### `core/tests/suite/fork_thread.rs`

`test` · `test run`

This test file protects the project’s conversation forking feature. A “fork” is like making a copy of a chat and rewinding it to an earlier point, so the user can continue from there instead of from the latest message. The saved chat record is called a rollout: it is a line-by-line JSON log of what happened in the conversation.

The tests create a fake server instead of talking to the real Responses API. That fake server returns a simple successful stream for each user message, so the test can focus on local thread history rather than model behavior. The first test sends three user messages, reads the saved rollout file, then forks the thread twice. Each fork asks the system to cut the history before a chosen user message. The test confirms the new rollout files contain exactly the expected earlier part of the conversation.

The second test checks a different path: it gives the thread manager an already-loaded history list, but no source rollout path on disk. That matters because saved conversations may be restored from storage where the original file path is no longer available. The helper at the bottom reads rollout files and ignores session metadata, so the tests compare only the meaningful conversation items.

#### Function details

##### `fork_thread_twice_drops_to_first_message`  (lines 25–149)

```
async fn fork_thread_twice_drops_to_first_message()
```

**Purpose**: This test proves that repeated thread forks keep trimming conversation history correctly. It starts with three user messages, forks once to remove later history, then forks again to remove the new last user message.

**Data flow**: The test begins by setting up a fake HTTP server that will answer three model requests with completed responses. It sends the texts “first,” “second,” and “third” into a test conversation, waits for each turn to finish, then reads the saved rollout file. It finds where user messages appear in that saved history, calculates what the shortened histories should look like, creates two forked threads, reads their rollout files, and compares those files to the expected shortened versions. The output is not a returned value; the test passes if the histories match and fails if they do not.

**Call relations**: This is a top-level asynchronous test run by the Rust test framework. It uses the test server helpers to fake model responses, calls into the thread manager to create forked conversations, and calls read_rollout_items to turn rollout files back into comparable history items.

*Call graph*: calls 3 internal fn (sse, test_codex, read_rollout_items); 11 external calls (default, given, start, new, TruncateBeforeNthUserMessage, wait_for_event, assert_eq!, skip_if_no_network!, vec!, method (+1 more)).


##### `fork_thread_from_history_does_not_require_source_rollout_path`  (lines 152–222)

```
async fn fork_thread_from_history_does_not_require_source_rollout_path()
```

**Purpose**: This test proves that a thread can be forked from history that is already loaded in memory, even when there is no original rollout file path. That is important for restored or imported conversations where the file location may be missing.

**Data flow**: The test sets up a fake server for one completed response, creates a test conversation, sends one user message, and waits for the turn to finish. It reads the source conversation’s rollout items from disk, then passes those items as resumed history while deliberately setting the rollout path to none. It asks the thread manager to fork from that supplied history, reads the new fork’s rollout file, and checks that the forked history starts with the same items as the source history. The test passes if the supplied history is preserved without needing the old file path.

**Call relations**: This is another top-level asynchronous test run by the test framework. It relies on the same fake server and test conversation setup as the first test, uses read_rollout_items to inspect saved rollout logs, and exercises the thread manager’s fork_thread_from_history path instead of forking directly from a rollout path.

*Call graph*: calls 3 internal fn (sse, test_codex, read_rollout_items); 11 external calls (default, given, start, new, assert!, wait_for_event, Resumed, skip_if_no_network!, vec!, method (+1 more)).


##### `read_rollout_items`  (lines 224–242)

```
fn read_rollout_items(path: &std::path::Path) -> Vec<RolloutItem>
```

**Purpose**: This helper reads a rollout file and returns the conversation items that matter for these tests. It skips session metadata so comparisons focus on the actual recorded conversation events.

**Data flow**: The input is a path to a rollout file on disk. The function reads the whole file as text, walks through it line by line, ignores blank lines, parses each line as JSON, converts that JSON into a rollout record, drops session metadata records, and collects the remaining items into a list. The result is a vector of rollout items that tests can compare directly.

**Call relations**: Both tests call this helper after conversations or forks have written rollout files. It sits between the file system and the assertions: the tests give it a path, and it hands back clean, structured history items that can be checked against expected results.

*Call graph*: called by 2 (fork_thread_from_history_does_not_require_source_rollout_path, fork_thread_twice_drops_to_first_message); 5 external calls (new, format!, from_str, from_value, read_to_string).


### `core/tests/suite/window_headers.rs`

`test` · `integration test run`

This file is a focused integration test for a small but important piece of request metadata: the `x-codex-window-id` HTTP header. In plain terms, Codex sends requests to a model provider, and each request is labeled with a window ID. That label has two parts: a thread identity and a generation number. The generation number should go up after a conversation is compacted, because compaction creates a new summarized context window. But if the same thread is resumed later, that generation should stay remembered. If the user forks the thread, the fork should get a new thread identity and start again at generation zero.

The test sets up a fake model server that returns canned streaming responses, then drives a Codex thread through a realistic sequence: send a normal user message, compact the conversation, send another message, shut down, resume from saved rollout data, send another message, then fork and send one more. Afterward it inspects the fake server’s recorded requests and checks their headers.

The helper functions make the test read like a story. One helper submits a normal user turn and waits for completion. Another submits a compact operation and checks that the expected warning is shown. Another shuts down the thread cleanly. The last helper splits the window header into its thread ID and generation number so the test can compare them clearly.

#### Function details

##### `window_id_advances_after_compact_persists_on_resume_and_resets_on_fork`  (lines 22–100)

```
async fn window_id_advances_after_compact_persists_on_resume_and_resets_on_fork() -> Result<()>
```

**Purpose**: This is the main test. It proves that Codex labels model requests correctly across compaction, shutdown and resume, and thread forking.

**Data flow**: It starts with a fake server and a Codex test instance configured to use the summarization prompt. It sends several operations into a Codex thread, then reads back the fake server’s recorded model requests. From each request it extracts the window header and checks the before-and-after story: the first normal request is generation 0, compaction still uses generation 0, requests after compaction and after resume use generation 1, and a fork gets a different thread ID with generation 0.

**Call relations**: This function is the driver for the whole file. It calls the test-support setup helpers to create the fake server and Codex instance, uses `submit_user_turn`, `submit_compact_turn`, and `shutdown_thread` to move the thread through each stage, and then uses `window_id_parts` to turn raw request headers into values it can compare.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, shutdown_thread, submit_compact_turn, submit_user_turn, window_id_parts); 5 external calls (clone, assert_eq!, assert_ne!, skip_if_no_network!, vec!).


##### `submit_user_turn`  (lines 102–117)

```
async fn submit_user_turn(codex: &Arc<CodexThread>, text: &str) -> Result<()>
```

**Purpose**: This helper sends one normal user message to a Codex thread and waits until Codex says that turn is finished. It keeps the main test from being cluttered with the details of building a user-input operation.

**Data flow**: It receives a shared Codex thread and a text string. It wraps the string as a user input operation, submits it to Codex, then listens for a `TurnComplete` event. When that event arrives, the helper returns successfully; if submission fails, the error is passed back.

**Call relations**: The main test calls this helper whenever it wants to create a regular model request: before compaction, after compaction, after resume, and after forking. The helper hands control to Codex by submitting the operation, then relies on `wait_for_event` from the test support code to know when it is safe for the test to continue.

*Call graph*: called by 1 (window_id_advances_after_compact_persists_on_resume_and_resets_on_fork); 3 external calls (default, wait_for_event, vec!).


##### `submit_compact_turn`  (lines 119–128)

```
async fn submit_compact_turn(codex: &Arc<CodexThread>) -> Result<()>
```

**Purpose**: This helper asks Codex to compact the conversation and checks that the user-facing compaction warning appears. Compaction means replacing earlier conversation detail with a summary so the thread can continue with a smaller context.

**Data flow**: It receives a shared Codex thread. It submits a compact operation, waits for a warning event, verifies that the warning text is exactly the expected compact warning, then waits for the compact turn to complete. It returns success only after both the warning and completion have happened.

**Call relations**: The main test calls this after the first user turn to force a new context generation. This helper submits the compact operation to Codex, uses `wait_for_event` to observe Codex’s response, and uses the shared compact-warning constant to make sure the expected warning behavior did not change.

*Call graph*: called by 1 (window_id_advances_after_compact_persists_on_resume_and_resets_on_fork); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `shutdown_thread`  (lines 130–134)

```
async fn shutdown_thread(codex: &Arc<CodexThread>) -> Result<()>
```

**Purpose**: This helper cleanly stops a Codex thread and waits until Codex confirms the shutdown. That matters here because the test later resumes from saved state and needs the previous thread to be fully closed.

**Data flow**: It receives a shared Codex thread, submits a shutdown operation, and waits for a `ShutdownComplete` event. Once that event arrives, it returns success; any submit error is returned to the caller.

**Call relations**: The main test calls this after finishing work on the initial thread and again after the resumed thread. It hands the shutdown request to Codex and uses `wait_for_event` so the next test step does not race ahead before shutdown is complete.

*Call graph*: called by 1 (window_id_advances_after_compact_persists_on_resume_and_resets_on_fork); 1 external calls (wait_for_event).


##### `window_id_parts`  (lines 136–147)

```
fn window_id_parts(request: &ResponsesRequest) -> (String, u64)
```

**Purpose**: This helper reads the `x-codex-window-id` header from one recorded model request and splits it into the thread ID and generation number. It turns a single header string into values the test can compare directly.

**Data flow**: It receives a recorded request from the fake server. It looks up the `x-codex-window-id` header, splits the string at the last colon, parses the part after the colon as a number, and returns the part before the colon as the thread ID together with that number. If the header is missing or malformed, the test fails immediately.

**Call relations**: The main test calls this once for each recorded model request after all thread operations are done. It depends on the request object’s header lookup method, and it feeds clean thread ID and generation values back to the assertions in the main test.

*Call graph*: calls 1 internal fn (header); called by 1 (window_id_advances_after_compact_persists_on_resume_and_resets_on_fork).


### Persisted rollout content
These suites check what runtime changes and message payloads do or do not get written into rollout-backed session history.

### `core/tests/suite/image_rollout.rs`

`test` · `test run`

A rollout file is a saved record of what was sent during a Codex conversation. This test file makes sure images are recorded there correctly, because those records may later be used to replay, inspect, or debug a session. If the image part were saved in the wrong format, a later reader of the rollout might not understand what the user actually sent.

The tests create a fake Codex session connected to a mock server, so no real model response is needed. They send user input that includes an image plus text, wait for the turn to finish, shut the session down, and then read the rollout file from disk. The file is written as JSON lines, meaning each line is a separate JSON object. Helper functions scan those lines to find the saved user message containing an image.

There are two main cases. One simulates a copied or pasted local image file. For that, the expected rollout includes extra text markers around the image, including the local file path, like a label on a package. The other simulates a dragged-and-dropped image that is already represented as a data URL. That one is expected to be saved directly as an image item followed by the user’s text. Both tests also confirm that the default image detail setting is filled in when the user did not provide one.

#### Function details

##### `find_user_message_with_image`  (lines 31–53)

```
fn find_user_message_with_image(text: &str) -> Option<ResponseItem>
```

**Purpose**: This helper looks through the saved rollout text and finds the user message that contains an image. The tests use it so they can focus on the relevant saved message instead of manually inspecting every line.

**Data flow**: It receives the full rollout file as plain text. It checks each non-empty line, tries to read that line as a JSON rollout record, ignores lines that are not usable rollout records, and looks for a user message whose content includes an image item. If it finds one, it returns that saved message; otherwise it returns nothing.

**Call relations**: After each image test reads the rollout file, it calls this helper to locate the important user message. Internally, the helper hands each candidate line to JSON parsing so the test can work with structured message data instead of raw text.

*Call graph*: called by 2 (copy_paste_local_image_persists_rollout_request_shape, drag_drop_image_persists_rollout_request_shape); 1 external calls (from_str).


##### `extract_image_url`  (lines 55–63)

```
fn extract_image_url(item: &ResponseItem) -> Option<String>
```

**Purpose**: This helper pulls the image URL out of a saved response message. The tests need this because the exact stored image URL may be generated or normalized by the system, so they reuse the actual value when building the expected message shape.

**Data flow**: It receives one response item. If that item is a message, it searches the message content for the first image entry and returns its image URL as text. If the item is not a message, or if the message has no image, it returns nothing.

**Call relations**: Both tests call this after finding the saved user message. The returned URL is then placed into the expected message so the assertion checks the structure and surrounding content without depending on an incidental URL value.

*Call graph*: called by 2 (copy_paste_local_image_persists_rollout_request_shape, drag_drop_image_persists_rollout_request_shape).


##### `read_rollout_text`  (lines 65–77)

```
async fn read_rollout_text(path: &Path) -> anyhow::Result<String>
```

**Purpose**: This helper reads the rollout file from disk, waiting briefly for it to appear and contain text. It avoids flaky tests where the session has just shut down but the file write is not visible yet.

**Data flow**: It receives a file path. It repeatedly checks whether the path exists, tries to read it, and returns the text once the file is non-empty. Between attempts it waits for a short time. If the quick waiting period runs out, it makes one final read attempt and includes the path in the error message if that fails.

**Call relations**: Both tests call this after they ask Codex to shut down and receive confirmation. It bridges the live Codex session and the later inspection step by turning the on-disk rollout file into text that `find_user_message_with_image` can scan.

*Call graph*: called by 2 (copy_paste_local_image_persists_rollout_request_shape, drag_drop_image_persists_rollout_request_shape); 4 external calls (from_millis, exists, read_to_string, sleep).


##### `write_test_png`  (lines 79–86)

```
fn write_test_png(path: &Path, color: [u8; 4]) -> anyhow::Result<()>
```

**Purpose**: This helper creates a tiny PNG image file for the local-image test. It gives the test a real image on disk without needing any checked-in image fixture.

**Data flow**: It receives a target file path and a four-byte color value. It creates the parent directory if needed, builds a 2-by-2 pixel image filled with that color, saves it as a PNG at the requested path, and returns success or an error.

**Call relations**: The local copy-paste test calls this before submitting user input. That gives Codex an actual local file path to process, which is important because this test is specifically checking how pasted local images are recorded.

*Call graph*: called by 1 (copy_paste_local_image_persists_rollout_request_shape); 4 external calls (from_pixel, parent, Rgba, create_dir_all).


##### `copy_paste_local_image_persists_rollout_request_shape`  (lines 89–187)

```
async fn copy_paste_local_image_persists_rollout_request_shape() -> anyhow::Result<()>
```

**Purpose**: This test verifies that when a user submits a local image file along with text, the rollout file records the request in the expected format. In particular, it checks that local images are wrapped with text markers that include the file path, and that a default image detail value is added.

**Data flow**: The test starts with a mock server and a temporary Codex session. It writes a small PNG into the session’s working directory, prepares a fake streaming server response, then submits user input containing the local image and the text “pasted image.” After Codex finishes the turn and shuts down, the test reads the rollout file, extracts the user message with the image, builds the expected saved message shape, and compares the actual saved message to that expected value.

**Call relations**: This is one of the file’s two top-level test cases. It uses the mock-response helpers to make the Codex turn complete predictably, uses the session-building helpers to create a controlled environment, uses `write_test_png` to create the image input, then relies on `read_rollout_text`, `find_user_message_with_image`, and `extract_image_url` to inspect what Codex persisted.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, extract_image_url, find_user_message_with_image, read_rollout_text, write_test_png); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `drag_drop_image_persists_rollout_request_shape`  (lines 190–278)

```
async fn drag_drop_image_persists_rollout_request_shape() -> anyhow::Result<()>
```

**Purpose**: This test verifies that when a user submits an image that is already encoded as an image URL, the rollout file records it directly as an image followed by the user’s text. It also checks that the default image detail value is added when none was supplied.

**Data flow**: The test starts a mock server and temporary Codex session, prepares a small PNG represented as a data URL, and mounts a fake streaming response. It submits user input containing that image URL and the text “dropped image.” Once the turn is complete and the session has shut down, it reads the rollout file, finds the saved user image message, copies out the stored image URL, builds the expected message, and asserts that the saved message matches.

**Call relations**: This is the companion test to the local-image case. It follows the same overall path through the mock server, Codex session, rollout reading, message finding, and URL extraction helpers, but it skips `write_test_png` because the image is supplied directly as URL text rather than as a file on disk.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, extract_image_url, find_user_message_with_image, read_rollout_text); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/model_overrides.rs`

`test` · `test run`

This test file protects an important promise: thread-level settings are like a sticky note on one conversation, not a permanent change to the user's saved preferences. The tests start a fake Codex session connected to a mock server, send a request that overrides the model and reasoning effort for that active thread, then shut the session down cleanly. After shutdown, they inspect the home directory used by the test. One test starts with an existing config.toml file and checks that its contents are exactly unchanged. The other starts with no config.toml file and checks that the temporary override did not create one. This matters because users may switch models for a single task without wanting their default setup rewritten behind their back. Without these tests, a bug could silently persist a one-off choice and surprise the user in later sessions. The mock server and temporary test home make the checks safe and repeatable, like rehearsing the whole workflow in a sandbox instead of touching a real user's files.

#### Function details

##### `thread_settings_update_does_not_persist_when_config_exists`  (lines 12–45)

```
async fn thread_settings_update_does_not_persist_when_config_exists()
```

**Purpose**: This test checks that changing thread settings does not rewrite an already existing config.toml file. It is used to catch regressions where a temporary model override accidentally becomes a saved user preference.

**Data flow**: The test starts with a mock server and a temporary home directory containing config.toml with `model = "gpt-4o"`. It launches a test Codex conversation configured with that model, sends a thread override asking for model `o3` and high reasoning effort, then asks Codex to shut down and waits until shutdown is complete. Finally, it reads config.toml back from disk and verifies that the file still contains exactly the original text.

**Call relations**: The test sets up its sandbox through `start_mock_server` and `test_codex`. During the simulated conversation it hands the override request to `submit_thread_settings`, then uses Codex's shutdown operation and `wait_for_event` to make sure all background work has finished before checking the file. It relies on `read_to_string` and `assert_eq!` at the end to prove the saved config was not changed.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 5 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, read_to_string).


##### `thread_settings_update_does_not_create_config_file`  (lines 48–77)

```
async fn thread_settings_update_does_not_create_config_file()
```

**Purpose**: This test checks that changing thread settings does not create a new config.toml file when none existed before. It protects users from having temporary conversation choices written to disk unexpectedly.

**Data flow**: The test starts a mock server and a fresh temporary Codex home directory. It first confirms there is no config.toml file. It then sends a thread override asking for model `o3` and medium reasoning effort, shuts the Codex session down, and waits for shutdown to finish. At the end, it checks the same path again and confirms config.toml still does not exist.

**Call relations**: The test uses `start_mock_server` and `test_codex` to create a safe fake conversation environment. It sends the settings change through `submit_thread_settings`, then drives the session to completion with a shutdown operation and `wait_for_event`. The two `assert!` checks frame the story: before the override there is no config file, and after the override there is still no config file.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 4 external calls (default, assert!, submit_thread_settings, wait_for_event).


### `core/tests/suite/override_updates.rs`

`test` · `test run`

This test file protects a subtle but important behavior: temporary thread setting updates should not create saved conversation history on their own. A “rollout” here is the saved record of a Codex session. If Codex wrote a rollout just because settings changed, it could leave behind misleading or empty history, like writing a diary entry that only says the pen color changed but nothing actually happened.

Each test starts a mock server, launches a test Codex session, sends one kind of thread settings override, then immediately shuts the session down. The tests then look for the rollout file and expect it not to exist. That absence is the point: without a following user message, the update should remain an in-memory change, not a recorded conversation event.

The three covered settings are permission policy, environment selection such as working directory, and collaboration mode instructions. Together they make sure different classes of overrides all follow the same rule. The helper `collab_mode_with_instructions` builds a small collaboration-mode value for the collaboration test, so the test can focus on the behavior being checked rather than on setup details.

#### Function details

##### `collab_mode_with_instructions`  (lines 17–26)

```
fn collab_mode_with_instructions(instructions: Option<&str>) -> CollaborationMode
```

**Purpose**: This helper builds a collaboration mode value with optional developer instructions. It keeps the collaboration test short and makes it clear that the test is changing collaboration instructions, not testing object construction.

**Data flow**: It receives an optional text string. It creates a `CollaborationMode` using the default mode, a fixed model name, no special reasoning effort, and the provided text converted into owned text if it exists. The finished collaboration mode is returned to the caller.

**Call relations**: The collaboration override test calls this helper when it needs a realistic collaboration setting to submit to Codex. The returned value is placed into the thread settings override that the test sends.

*Call graph*: called by 1 (thread_settings_update_without_user_turn_does_not_record_collaboration_update).


##### `thread_settings_update_without_user_turn_does_not_record_permissions_update`  (lines 29–58)

```
async fn thread_settings_update_without_user_turn_does_not_record_permissions_update() -> Result<()>
```

**Purpose**: This test checks that changing the approval or permission policy before any new user message does not create a saved rollout file. This matters because a permissions-only update should not be treated as a conversation turn.

**Data flow**: The test starts by skipping itself if network access is unavailable. It creates a mock server, builds a Codex test session with an initial approval policy, then sends a thread settings update that changes the policy to never ask for approval. After that it shuts Codex down, waits until shutdown is complete, and checks the expected rollout path. The expected result is that no rollout file exists.

**Call relations**: During the test, the mock server and test Codex builder provide a controlled session. The test sends the update through the shared test helper for thread settings, then uses the event-waiting helper to know shutdown has finished before inspecting the filesystem. Its assertion confirms that the core session code did not persist the permissions change as history.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 5 external calls (default, assert!, submit_thread_settings, wait_for_event, skip_if_no_network!).


##### `thread_settings_update_without_user_turn_does_not_record_environment_update`  (lines 61–88)

```
async fn thread_settings_update_without_user_turn_does_not_record_environment_update() -> Result<()>
```

**Purpose**: This test checks that changing the environment selection, such as the working directory, does not create a saved rollout file when no user turn follows. This prevents a bare environment change from being recorded as if something meaningful happened in the conversation.

**Data flow**: The test skips itself if needed, starts a mock server, and builds a test Codex session. It creates a temporary directory and wraps that directory as a local environment selection. It submits that environment override to Codex, shuts the session down, waits for shutdown to finish, and then checks the rollout path. The expected output is no file on disk.

**Call relations**: The test uses the standard mock server and Codex test harness to create a safe, isolated run. It relies on `local_selections` to turn the temporary directory into the kind of environment choice Codex understands. After submitting the override, it waits for shutdown and then verifies that the persistence layer did not record the environment-only update.

*Call graph*: calls 3 internal fn (start_mock_server, local_selections, test_codex); 6 external calls (default, new, assert!, submit_thread_settings, wait_for_event, skip_if_no_network!).


##### `thread_settings_update_without_user_turn_does_not_record_collaboration_update`  (lines 91–119)

```
async fn thread_settings_update_without_user_turn_does_not_record_collaboration_update() -> Result<()>
```

**Purpose**: This test checks that changing collaboration instructions before any new user message does not create a saved rollout file. It makes sure instruction updates are not stored as conversation history unless they are tied to a later user turn.

**Data flow**: The test skips itself if network access is unavailable, starts a mock server, and builds a test Codex session. It creates collaboration instructions with `collab_mode_with_instructions`, submits them as a thread settings override, then shuts Codex down. Once shutdown is complete, it looks at the rollout path and expects that the file was never created.

**Call relations**: This test calls the local helper to build the collaboration mode value, then passes that value into the shared thread-settings submission helper. The mock server and test Codex harness provide the controlled session, and the event-waiting helper ensures the session is fully stopped before the final filesystem check.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, collab_mode_with_instructions); 5 external calls (default, assert!, submit_thread_settings, wait_for_event, skip_if_no_network!).


### Session discovery and state storage
These tests validate finding stored sessions and reconstructing thread state from SQLite-backed metadata and rollout files.

### `core/tests/suite/rollout_list_find.rs`

`test` · `test run`

A “rollout” is a saved record of a Codex conversation, stored as a JSON Lines file, meaning one JSON object per line. This test file builds tiny fake rollout files and then asks Codex’s lookup functions to find them by conversation id or by thread name. Without these tests, Codex could lose track of past conversations, especially when files are hidden by gitignore rules, moved into archive folders, or indexed in the state database.

The file uses temporary folders so each test gets a clean pretend Codex home directory. Helper functions create the expected folder shape, such as sessions/YYYY/MM/DD, and write the smallest rollout file that still contains a session id. Another helper inserts thread metadata into the SQLite-backed state database, which is a small local database used as a faster index of known threads.

The tests cover several important paths: finding a rollout by scanning files, ignoring .gitignore rules that would normally hide files from search tools, preferring the database path when it has an answer, falling back to file search when the database does not, finding a real rollout written by RolloutRecorder, and locating archived sessions. In short, this file is a safety net for the “find my saved conversation” feature.

#### Function details

##### `write_minimal_rollout_with_id_in_subdir`  (lines 25–33)

```
fn write_minimal_rollout_with_id_in_subdir(codex_home: &Path, subdir: &str, id: Uuid) -> PathBuf
```

**Purpose**: Creates a tiny rollout file under a chosen subfolder, such as sessions or archived_sessions. Tests use it to set up realistic-looking saved conversation files without needing to run the full recorder.

**Data flow**: It receives a Codex home folder, a subfolder name, and a conversation id. It builds the dated rollout directory, creates it on disk, asks write_minimal_rollout_with_id_at_path to write the actual file contents, and returns the full path to the file it made.

**Call relations**: This helper is the shared setup step for tests that need rollout files in different areas. write_minimal_rollout_with_id uses it for normal sessions, while find_archived_locates_rollout_file_by_id calls it directly to place a file in the archived sessions area.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id_at_path); called by 2 (find_archived_locates_rollout_file_by_id, write_minimal_rollout_with_id); 3 external calls (join, format!, create_dir_all).


##### `write_minimal_rollout_with_id_at_path`  (lines 35–55)

```
fn write_minimal_rollout_with_id_at_path(file: &Path, id: Uuid)
```

**Purpose**: Writes the smallest valid-looking rollout file needed for these lookup tests. The important part is that the first line contains session metadata with the conversation id, so the finder can recognize the file.

**Data flow**: It receives a file path and an id. It creates the file, writes one JSON line describing a session_meta record with that id and a few required fields, and leaves the file on disk for later lookup.

**Call relations**: Other setup helpers call this when they need actual rollout contents. find_prefers_sqlite_path_by_id also calls it directly because that test needs to place a rollout at a specific database-backed path.

*Call graph*: called by 2 (find_prefers_sqlite_path_by_id, write_minimal_rollout_with_id_in_subdir); 2 external calls (create, writeln!).


##### `write_minimal_rollout_with_id`  (lines 59–61)

```
fn write_minimal_rollout_with_id(codex_home: &Path, id: Uuid) -> PathBuf
```

**Purpose**: Creates a minimal rollout file in the normal sessions folder. It is a convenience wrapper for the common test case: “make me a saved conversation in the usual place.”

**Data flow**: It receives a Codex home folder and an id, passes them to write_minimal_rollout_with_id_in_subdir with the subfolder set to sessions, and returns the created file path.

**Call relations**: Most tests use this helper before calling find_thread_path_by_id_str. It keeps the tests focused on what they are checking instead of repeating folder and file setup code.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id_in_subdir); called by 5 (find_falls_back_to_filesystem_when_sqlite_has_no_match, find_handles_gitignore_covering_codex_home_directory, find_ignores_granular_gitignore_rules, find_locates_rollout_file_by_id, find_prefers_sqlite_path_by_id).


##### `upsert_thread_metadata`  (lines 63–85)

```
async fn upsert_thread_metadata(
    codex_home: &Path,
    thread_id: ThreadId,
    rollout_path: PathBuf,
) -> StateDbHandle
```

**Purpose**: Adds or updates one thread record in the state database used by the lookup code. Tests use it to check how file lookup behaves when the database already knows about a thread.

**Data flow**: It receives a Codex home folder, a thread id, and the rollout path that should be recorded for that thread. It starts a test state runtime, marks the initial backfill as complete, builds metadata with the path and current time, writes that metadata into the database, and returns the database handle for the lookup function to use.

**Call relations**: find_prefers_sqlite_path_by_id uses this to create a database match that should win over filesystem search. find_falls_back_to_filesystem_when_sqlite_has_no_match uses it to create an unrelated database entry, proving the finder can still search files when the database does not match.

*Call graph*: calls 2 internal fn (new, init); called by 2 (find_falls_back_to_filesystem_when_sqlite_has_no_match, find_prefers_sqlite_path_by_id); 3 external calls (to_path_buf, now, default).


##### `find_locates_rollout_file_by_id`  (lines 88–99)

```
async fn find_locates_rollout_file_by_id()
```

**Purpose**: Checks the simplest case: a rollout file exists in the normal sessions folder, and Codex should find it by its id.

**Data flow**: It creates a temporary Codex home, generates a new id, writes a minimal rollout file with that id, then asks find_thread_path_by_id_str to locate it. The expected result is the exact path that was just created.

**Call relations**: This test calls write_minimal_rollout_with_id for setup and then calls the production finder find_thread_path_by_id_str. It verifies the basic filesystem search path before the more unusual cases are tested.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id); 4 external calls (new, new_v4, assert_eq!, find_thread_path_by_id_str).


##### `find_handles_gitignore_covering_codex_home_directory`  (lines 102–116)

```
async fn find_handles_gitignore_covering_codex_home_directory()
```

**Purpose**: Checks that Codex can still find rollout files even when a parent repository’s .gitignore says to ignore the entire .codex directory. This matters because saved conversations should not disappear just because search tools would normally skip ignored files.

**Data flow**: It creates a fake repository, makes a .codex home inside it, writes a .gitignore rule that ignores .codex, creates a rollout file inside that home, and then asks the finder to locate the id. The result should still be the rollout path.

**Call relations**: This test sets up a gitignore edge case and then calls find_thread_path_by_id_str. It depends on write_minimal_rollout_with_id for the rollout file, and it confirms the finder does not blindly follow ignore rules that would hide Codex’s own data.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id); 6 external calls (new, new_v4, assert_eq!, find_thread_path_by_id_str, create_dir_all, write).


##### `find_prefers_sqlite_path_by_id`  (lines 119–136)

```
async fn find_prefers_sqlite_path_by_id()
```

**Purpose**: Checks that when the state database has a path for a thread, Codex uses that path instead of another matching file found by scanning. This keeps lookup aligned with the database index when both sources exist.

**Data flow**: It creates one rollout file at a future dated path, creates another rollout with the same id in the normal helper location, then inserts database metadata pointing to the future dated path. When it asks find_thread_path_by_id_str to find the id using the database handle, the returned path should be the database path.

**Call relations**: This test uses write_minimal_rollout_with_id_at_path, write_minimal_rollout_with_id, and upsert_thread_metadata to create a deliberate conflict. It then calls find_thread_path_by_id_str and proves the database-backed answer takes priority.

*Call graph*: calls 4 internal fn (upsert_thread_metadata, write_minimal_rollout_with_id, write_minimal_rollout_with_id_at_path, from_string); 6 external calls (new, new_v4, assert_eq!, find_thread_path_by_id_str, format!, create_dir_all).


##### `find_falls_back_to_filesystem_when_sqlite_has_no_match`  (lines 139–155)

```
async fn find_falls_back_to_filesystem_when_sqlite_has_no_match()
```

**Purpose**: Checks that a missing database match does not stop Codex from finding a rollout file on disk. The database is helpful, but it must not become a single point of failure for lookup.

**Data flow**: It writes a rollout file with the target id, then creates database metadata for a different, unrelated id. It calls find_thread_path_by_id_str with that database handle, and the finder should ignore the unrelated database entry and return the file found by scanning.

**Call relations**: This test uses upsert_thread_metadata to create a database that is present but not useful for the requested id. It then exercises find_thread_path_by_id_str to confirm the fallback path still works.

*Call graph*: calls 3 internal fn (upsert_thread_metadata, write_minimal_rollout_with_id, from_string); 4 external calls (new, new_v4, assert_eq!, find_thread_path_by_id_str).


##### `find_ignores_granular_gitignore_rules`  (lines 158–170)

```
async fn find_ignores_granular_gitignore_rules()
```

**Purpose**: Checks that a .gitignore rule inside the sessions folder, such as ignoring all .jsonl files, does not prevent Codex from finding its rollout files.

**Data flow**: It creates a rollout file in the sessions area, writes a sessions/.gitignore file that would normally hide JSON Lines files, then asks find_thread_path_by_id_str to find the id. The expected output is still the rollout path.

**Call relations**: This test calls write_minimal_rollout_with_id for setup and then the production finder. It complements the broader .codex ignore test by checking a more specific ignore rule inside the sessions tree.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id); 5 external calls (new, new_v4, assert_eq!, find_thread_path_by_id_str, write).


##### `find_locates_rollout_file_written_by_recorder`  (lines 173–221)

```
async fn find_locates_rollout_file_written_by_recorder() -> std::io::Result<()>
```

**Purpose**: Checks that the name-based finder can locate a rollout created by the real RolloutRecorder, not just by the tiny fake helpers. This gives confidence that the test setup matches real saved conversations closely enough.

**Data flow**: It creates a temporary Codex home and configuration, starts a RolloutRecorder for a new thread, persists and flushes the rollout to disk, and writes a session index entry that maps a human thread name to that id. It then asks find_thread_meta_by_name_str to find the named thread, checks that the returned metadata id matches, confirms the file exists and contains the id, and finally shuts down the recorder.

**Call relations**: This is the most end-to-end test in the file. Instead of writing the rollout by hand, it uses RolloutRecorder, then calls find_thread_meta_by_name_str to prove the name lookup can connect the session index, metadata, and actual rollout file.

*Call graph*: calls 4 internal fn (default, new, new, new); 9 external calls (new, new, assert!, assert_eq!, find_thread_meta_by_name_str, default, format!, read_to_string, write).


##### `find_archived_locates_rollout_file_by_id`  (lines 224–238)

```
async fn find_archived_locates_rollout_file_by_id()
```

**Purpose**: Checks that archived conversations can be found by id. Archived sessions live in a different folder, so they need their own lookup path.

**Data flow**: It creates a temporary Codex home, generates an id, writes a minimal rollout file under archived_sessions, then calls find_archived_thread_path_by_id_str. The expected output is the archived file path.

**Call relations**: This test calls write_minimal_rollout_with_id_in_subdir to place the file in archived_sessions, then calls the archived-session finder. It proves archived lookup mirrors normal lookup but searches the archive location.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id_in_subdir); 4 external calls (new, new_v4, assert_eq!, find_archived_thread_path_by_id_str).


### `core/tests/suite/sqlite_state.rs`

`test` · `test suite`

Codex keeps a written record of each conversation in a rollout file, and, when the SQLite feature is enabled, also stores searchable thread metadata in a SQLite database. SQLite is a small file-based database, like a structured notebook the program can quickly search. This test file checks that those two records stay in sync.

The tests start a fake model server, create Codex test sessions, send user turns, and then inspect the state database. They verify important moments: a brand-new thread should not appear in the database until the user actually sends a message; existing rollout files should be scanned and added to the database; the first user message should be saved; and resumed sessions should recover dynamic tools listed in the rollout metadata.

The file also tests “memory pollution” behavior. When configuration says memories should be disabled after outside context is used, web search and MCP tool calls must mark the thread as polluted. MCP means Model Context Protocol, a way for Codex to call external tools. Finally, it checks that tool-call log entries include the thread id, so later debugging can connect a log line back to the exact conversation that produced it.

#### Function details

##### `new_thread_is_recorded_in_state_db`  (lines 56–109)

```
async fn new_thread_is_recorded_in_state_db() -> Result<()>
```

**Purpose**: This test checks that a new conversation is not written into the SQLite state database too early. It should only be recorded after the first real user message, because before that there is no meaningful thread history to resume or list.

**Data flow**: It starts a mock server and builds a Codex test session with SQLite enabled. It reads the thread id, expected rollout file path, and database path, waits for the database file to exist, and confirms both the rollout file and database entry are still absent. Then it submits one user message and repeatedly checks the database until the thread appears. The final result is a confirmed database row whose id and rollout path match the live session, and a rollout file that now exists on disk.

**Call relations**: The test harness creates the fake server and Codex instance, then this test drives the first user turn. It relies on the state database exposed by the Codex instance to prove that normal conversation startup writes thread metadata only after the rollout has been materialized.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 6 external calls (from_millis, assert!, assert_eq!, state_db_path, try_exists, sleep).


##### `resume_restores_dynamic_tools_from_rollout_with_sqlite_enabled`  (lines 112–219)

```
async fn resume_restores_dynamic_tools_from_rollout_with_sqlite_enabled() -> Result<()>
```

**Purpose**: This test proves that modern dynamic tools saved in a rollout file are restored when a thread is resumed while SQLite support is enabled. Dynamic tools are tools added at runtime rather than built into Codex from the start.

**Data flow**: It prepares two fake model responses, defines a dynamic tool namespace with one function tool and a JSON input shape, then starts a thread with that tool attached. After sending a user message and waiting for the turn to finish, it resumes the same rollout in a new Codex test session. When it sends another message, it inspects the second request sent to the fake model server and checks that the restored tool namespace appears exactly as expected.

**Call relations**: The first Codex session writes the rollout metadata. The resumed session reads that rollout back in and builds the model request. The mock server records those requests, letting the test confirm that resume logic handed the saved tool definition back into the model-facing request path.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 6 external calls (default, assert_eq!, wait_for_event, json!, Namespace, vec!).


##### `resume_restores_legacy_dynamic_tools_from_rollout_with_sqlite_enabled`  (lines 222–339)

```
async fn resume_restores_legacy_dynamic_tools_from_rollout_with_sqlite_enabled() -> Result<()>
```

**Purpose**: This test checks backward compatibility for older rollout files that stored dynamic tools in a legacy format. It matters because users may resume conversations created by older versions of Codex.

**Data flow**: It starts a thread without modern dynamic tools, sends a message so a rollout is written, and shuts the thread down cleanly. Then it opens the rollout file, edits the session metadata line to insert a legacy-style dynamic tool record, and writes the file back. A new Codex session resumes from that edited rollout, sends another message, and the test reads the outgoing model request to verify that the old tool format was converted into the current namespace-and-function format.

**Call relations**: The test acts like an older Codex version by manually rewriting the rollout metadata. The resume path then has to interpret that older shape and pass a modern tool definition into the request sent to the fake model server.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 9 external calls (default, new, assert_eq!, wait_for_event, format!, read_to_string, write, json!, vec!).


##### `backfill_scans_existing_rollouts`  (lines 342–443)

```
async fn backfill_scans_existing_rollouts() -> Result<()>
```

**Purpose**: This test verifies that Codex can scan old rollout files and add them to the SQLite state database. Without this backfill step, existing conversations would be invisible to any feature that lists or resumes threads through the database.

**Data flow**: Before Codex is built, the test creates a fake rollout file under the test Codex home directory. That file contains session metadata and a first user message. Then it starts Codex with SQLite enabled, waits for the database to appear, and repeatedly asks the database for the thread id from the fake rollout. The output is a database entry whose id, rollout path, model provider, and first user message match what the backfill process should have discovered.

**Call relations**: The pre-build hook plants a rollout file as if it already existed before startup. When the test Codex instance starts, the SQLite state machinery scans that file in the background. The test then queries the database to confirm the startup backfill connected the old disk record to the new state index.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, from_string); 8 external calls (from_millis, now_v7, assert!, assert_eq!, state_db_path, format!, try_exists, sleep).


##### `user_messages_persist_in_state_db`  (lines 446–496)

```
async fn user_messages_persist_in_state_db() -> Result<()>
```

**Purpose**: This test confirms that user messages are copied into the thread metadata stored in SQLite. In particular, it checks that the first user message becomes available in the database after conversation turns run.

**Data flow**: It starts a mock server that can answer two turns, builds Codex with SQLite enabled, and waits for the database file. It submits two user messages, then queries the thread metadata until the database entry contains a first user message. The result is a thread record that exists and includes saved user-message information.

**Call relations**: The submitted turns go through the normal Codex conversation flow and rollout writing. The SQLite state layer observes or records that activity, and the test reads the database afterward to make sure the user-facing message data was persisted.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 6 external calls (from_millis, assert!, state_db_path, try_exists, sleep, vec!).


##### `web_search_marks_thread_memory_mode_polluted_when_configured`  (lines 499–535)

```
async fn web_search_marks_thread_memory_mode_polluted_when_configured() -> Result<()>
```

**Purpose**: This test checks that a built-in web search result marks the thread’s memory mode as polluted when configuration says external context should disable memory use. “Polluted” here means the conversation has used outside information, so later memory features should treat it cautiously.

**Data flow**: It sets up a fake model response that includes a completed web search call. It builds Codex with SQLite enabled and with the memory setting that reacts to external context. After sending a user turn, it repeatedly reads the thread’s memory mode from the database until it becomes polluted. The final assertion confirms the database stores that polluted state.

**Call relations**: The fake model server injects a web-search event into the turn. Codex processes that event during the conversation, updates the SQLite thread metadata, and the test verifies the memory-mode result through the database API.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (from_millis, assert_eq!, sleep, vec!).


##### `standalone_web_search_marks_thread_memory_mode_polluted_when_configured`  (lines 538–613)

```
async fn standalone_web_search_marks_thread_memory_mode_polluted_when_configured() -> Result<()>
```

**Purpose**: This test checks the same memory-pollution rule for the standalone web search extension. It makes sure both the newer extension-based web search path and the built-in web-search event path protect memories after outside context is used.

**Data flow**: If network-dependent tests are allowed, it starts a mock server with a fake search endpoint and fake model responses that request the standalone web search tool. It creates test authentication, installs the web search extension, enables SQLite, standalone web search, live web search mode, and the memory setting that disables memories after external context. After submitting a user turn, it polls the database until the thread memory mode is polluted, then asserts that value.

**Call relations**: The model response asks for a namespaced web tool call. The installed web search extension performs the mocked search, Codex continues the turn, and the SQLite state layer records that external context was used. The test reads that state back from the database.

*Call graph*: calls 5 internal fn (auth_manager_from_auth, mount_sse_sequence, start_mock_server, test_codex, from_api_key); 13 external calls (new, from_millis, new, given, new, assert_eq!, install, json!, skip_if_no_network!, sleep (+3 more)).


##### `mcp_call_marks_thread_memory_mode_polluted_when_configured`  (lines 616–745)

```
async fn mcp_call_marks_thread_memory_mode_polluted_when_configured() -> Result<()>
```

**Purpose**: This test verifies that calling an MCP tool also marks a thread as polluted when external context should disable memories. MCP tools are external programs or services Codex can call, so their results count as outside context.

**Data flow**: If network-dependent tests are allowed, it starts a fake model server and configures it to request an MCP echo tool call. The test adds a local stdio MCP server to the Codex configuration, enables SQLite, and turns on the memory setting for external context. It waits for the MCP server to be ready, sends a user request with read-only permissions, waits for the MCP tool call and turn completion, and then polls the database until the thread memory mode is polluted.

**Call relations**: The fake model request triggers Codex to call the configured MCP server. Once that external tool call finishes, the conversation flow updates SQLite thread state. The test watches the emitted events to ensure the tool call happened, then queries the database to confirm the memory-mode update.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, read_only); 11 external calls (default, from_millis, assert_eq!, stdio_server_bin, wait_for_event, wait_for_event_match, wait_for_mcp_server, format!, skip_if_no_network!, sleep (+1 more)).


##### `tool_call_logs_include_thread_id`  (lines 748–823)

```
async fn tool_call_logs_include_thread_id() -> Result<()>
```

**Purpose**: This test ensures tool-call log entries stored in the SQLite log database include the conversation thread id. That makes later troubleshooting possible, because a log line can be traced back to the exact thread that produced it.

**Data flow**: It starts a mock server that asks for a shell command tool call, builds Codex with SQLite enabled, and sends a user turn. Then it starts the SQLite log layer, creates a tracing span containing the expected thread id, and writes a log message that looks like a tool-call log. After flushing the log layer, it queries recent log rows until it finds the tool-call message. The result is a log row whose thread id matches the current session and whose message contains the tool-call text.

**Call relations**: The conversation establishes the real thread id, and the log database layer listens to tracing output. By writing a tool-call log inside a span carrying that thread id, the test checks that the logging pipeline captures the id and stores it alongside the message in SQLite.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, start); 11 external calls (default, from_millis, assert!, assert_eq!, json!, to_string, sleep, new, with_default, registry (+1 more)).
