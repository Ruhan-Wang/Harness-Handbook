# Session history, compaction, resume, and persisted state suites  `stage-23.2.4.2`

This stage tests the system’s memory: how a conversation keeps its place across turns, interruptions, and even restarts. It sits in the “continuity” part of the story, making sure the app can stop, save what matters, and pick up again without confusing the model or the user.

Several tests focus on compaction, which means shrinking long history into a shorter summary so future requests stay manageable. compact.rs checks the main compaction behavior, while compact_remote_parity.rs makes sure two remote compaction paths behave the same. compact_resume_fork.rs checks that compacted history still makes sense after resume, fork, or rollback.

Other files cover ongoing conversation flow. pending_input.rs tests how new input is queued and replayed while a turn is still running. resume.rs and resume_warning.rs verify how a saved session is rebuilt, including warnings if the model has changed. fork_thread.rs checks creating a new branch from an old conversation. window_headers.rs tracks the request “window” identity across these changes.

The remaining tests cover what gets saved: image input, temporary setting overrides, finding saved rollout files, and SQLite database state. Together, they verify that both visible history and behind-the-scenes storage stay consistent.

## Files in this stage

### Compaction behavior
These suites establish core compaction semantics, compare remote implementations, and follow compacted history through resume and fork flows.

### `core/tests/suite/compact.rs`

`test` · `request handling`

This file is the broadest compaction integration suite. It defines many constants for synthetic user messages, summaries, warning text, and global-instruction fixtures, plus helpers for building shell-call events, disabled-permission user turns, custom compact prompts, hook scripts, model-provider stubs, rollout parsing, and request-shape snapshots. Most tests run a `TestCodex` against a mock `/v1/responses` server, drive one or more user turns and `Op::Compact`, then inspect captured request bodies, emitted `EventMsg`s, and persisted rollout lines.

The suite covers several compaction modes. Manual compaction should inject the summarization prompt, preserve baseline developer instructions, emit warning and token-count events, and replace prior assistant history with a summary-bearing user message. Automatic compaction is tested both pre-turn and mid-turn, including repeated compactions, body-after-prefix budgeting, clamping to context window, and behavior after resume. Model-switch compaction is exercised when switching to a smaller-context model or when `comp_hash` changes, with assertions that the compact request strips the incoming `<model_switch>` item and the follow-up request restores it. Hook integration is validated by writing Python hook scripts into `hooks.json` and checking matcher behavior plus logged payloads. The file also checks retry behavior on context-window failures, rollout persistence of `TurnContext` and `Compacted` items, lifecycle event ids for compaction items, and a subtle invariant that compaction must keep the creation-time global instruction snapshot even if the underlying `AGENTS.md` file is later rewritten or resumed through remote-v2 replacement history.

#### Function details

##### `ev_shell_command_call`  (lines 94–100)

```
fn ev_shell_command_call(call_id: &str, command: &str) -> serde_json::Value
```

**Purpose**: Builds a synthetic `shell_command` function-call event payload for mocked model responses.

**Data flow**: It takes a call id and command string, wraps the command in a JSON object, serializes it, and returns the `ev_function_call` JSON value.

**Call relations**: Compaction tests that need tool artifacts in history use this helper when scripting SSE responses.

*Call graph*: calls 1 internal fn (ev_function_call); 1 external calls (json!).


##### `disabled_permission_user_turn`  (lines 102–129)

```
fn disabled_permission_user_turn(text: impl Into<String>, cwd: PathBuf, model: String) -> Op
```

**Purpose**: Constructs a `UserInput` op with disabled permissions and explicit collaboration settings for model-switch and resume tests.

**Data flow**: It takes user text, cwd, and model name; derives sandbox policy and permission profile via `turn_permission_fields(PermissionProfile::Disabled, ...)`; builds local environment selections; sets `AskForApproval::Never`; and returns a fully populated `Op::UserInput`.

**Call relations**: Model-switch and resume compaction tests use this helper to make request context deterministic and to include explicit model/collaboration settings in the turn.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 9 (auto_compact_runs_after_resume_when_token_usage_is_over_limit, body_after_prefix_model_switch_budget_compacts_with_next_model, pre_sampling_compact_recovers_comp_hash_after_resume, pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model, pre_sampling_compact_runs_on_switch_to_smaller_context_model, pre_sampling_compact_runs_when_comp_hash_changes, pre_sampling_compact_skips_missing_comp_hash_after_resume, pre_sampling_compact_skips_when_either_comp_hash_is_missing, snapshot_request_shape_pre_turn_compaction_strips_incoming_model_switch); 4 external calls (default, abs, as_path, vec!).


##### `auto_summary`  (lines 131–133)

```
fn auto_summary(summary: &str) -> String
```

**Purpose**: Returns the provided summary string unchanged, serving as a semantic marker for auto-compaction test data.

**Data flow**: It takes `&str` and returns an owned `String` copy.

**Call relations**: Several tests use this helper when constructing mocked compaction responses, mainly to distinguish auto-summary payloads from prefixed summary messages.

*Call graph*: called by 5 (auto_compact_allows_multiple_attempts_when_interleaved_with_other_turn_events, auto_compact_clamps_config_limit_to_context_window, auto_compact_persists_rollout_entries, manual_compact_twice_preserves_latest_user_messages, snapshot_request_shape_mid_turn_continuation_compaction).


##### `summary_with_prefix`  (lines 135–137)

```
fn summary_with_prefix(summary: &str) -> String
```

**Purpose**: Formats a summary as the canonical compacted-history user message by prepending `SUMMARY_PREFIX` and a newline.

**Data flow**: It takes a summary string, formats `SUMMARY_PREFIX + "\n" + summary`, and returns the result.

**Call relations**: Tests use this helper when asserting the exact summary-bearing user message that should appear after compaction.

*Call graph*: called by 3 (manual_compact_twice_preserves_latest_user_messages, multiple_auto_compact_per_task_runs_after_token_limit_hit, summarize_context_three_requests_and_instructions); 1 external calls (format!).


##### `set_test_compact_prompt`  (lines 139–141)

```
fn set_test_compact_prompt(config: &mut Config)
```

**Purpose**: Installs the standard summarization prompt into a mutable `Config` for tests that need deterministic local compaction input.

**Data flow**: It mutates `config.compact_prompt` to `Some(SUMMARIZATION_PROMPT.to_string())`.

**Call relations**: Many builder closures call this helper so compaction requests use a stable prompt string that assertions can search for.


##### `ev_completed_with_usage`  (lines 143–157)

```
fn ev_completed_with_usage(id: &str, input_tokens: i64, output_tokens: i64) -> Value
```

**Purpose**: Builds a synthetic `response.completed` JSON event with explicit input/output/total token usage fields.

**Data flow**: It takes an id plus input/output token counts and returns a JSON value whose nested `usage` object includes those counts and their sum.

**Call relations**: Body-after-prefix and model-switch budget tests use this helper when they need more detailed usage accounting than the simpler total-token event.

*Call graph*: 1 external calls (json!).


##### `body_contains_text`  (lines 159–161)

```
fn body_contains_text(body: &str, text: &str) -> bool
```

**Purpose**: Checks whether a serialized request body contains a given text fragment in JSON-escaped form.

**Data flow**: It converts the target text to a JSON fragment via `json_fragment` and tests `body.contains(...)`.

**Call relations**: Many request-shape assertions use this helper to search for prompts, summaries, or user text without depending on exact surrounding JSON formatting.

*Call graph*: calls 1 internal fn (json_fragment); called by 2 (manual_compact_retries_after_context_window_error, summarize_context_three_requests_and_instructions).


##### `json_fragment`  (lines 163–168)

```
fn json_fragment(text: &str) -> String
```

**Purpose**: Converts plain text into the escaped fragment that would appear inside a JSON string value.

**Data flow**: It serializes the text with `serde_json::to_string`, strips the surrounding quotes, and returns the inner escaped content.

**Call relations**: This helper exists solely to support `body_contains_text` and make substring checks robust against JSON escaping.

*Call graph*: called by 1 (body_contains_text); 1 external calls (to_string).


##### `read_hook_inputs`  (lines 170–176)

```
fn read_hook_inputs(path: &Path) -> Vec<Value>
```

**Purpose**: Reads a JSONL hook log file and parses each non-empty line into a `serde_json::Value`.

**Data flow**: It reads the file to a string, splits into lines, filters blank lines, parses each line as JSON, and returns the collected values.

**Call relations**: Hook-related tests call this after compaction to inspect the exact payloads delivered to pre/post compact hook scripts.

*Call graph*: called by 2 (compact_hooks_respect_matchers_and_post_runs_after_compaction, manual_pre_compact_block_decision_does_not_block_compaction); 1 external calls (read_to_string).


##### `python_hook_command`  (lines 178–180)

```
fn python_hook_command(script_path: &Path) -> String
```

**Purpose**: Formats a shell command that runs a Python hook script by path.

**Data flow**: It takes a script path and returns `python3 "<path>"`.

**Call relations**: The hook-script writers use this helper when generating `hooks.json` entries.

*Call graph*: 1 external calls (format!).


##### `write_unsupported_blocking_pre_compact_hook`  (lines 182–213)

```
fn write_unsupported_blocking_pre_compact_hook(home: &Path)
```

**Purpose**: Writes a pre-compact hook script and `hooks.json` that returns an unsupported blocking decision, for testing that manual compaction ignores it.

**Data flow**: It creates script and log paths under the provided home directory, writes a Python script that logs stdin payload and prints `{"decision":"block"...}`, then writes a `hooks.json` file registering that script as a manual `PreCompact` hook.

**Call relations**: The manual pre-compact block test installs this fixture before building the test harness.

*Call graph*: 4 external calls (join, format!, write, json!).


##### `write_matching_compact_hooks`  (lines 215–265)

```
fn write_matching_compact_hooks(home: &Path)
```

**Purpose**: Writes hook scripts and `hooks.json` for a manual `PostCompact` hook and an auto-only `PreCompact` hook, to test matcher selection.

**Data flow**: It writes two Python scripts that append their stdin payloads to JSONL logs, then writes a `hooks.json` file registering one under `PreCompact` with matcher `auto` and one under `PostCompact` with matcher `manual`.

**Call relations**: The hook-matcher test uses this fixture to prove only the matching manual post-compact hook runs.

*Call graph*: 4 external calls (join, format!, write, json!).


##### `non_openai_model_provider`  (lines 267–274)

```
fn non_openai_model_provider(server: &MockServer) -> ModelProviderInfo
```

**Purpose**: Builds an OpenAI-compatible provider pointed at the mock server but marked as non-websocket for local compaction tests.

**Data flow**: It clones the built-in `openai` provider, renames it, sets `base_url` to the mock server `/v1`, disables websocket support, and returns the provider.

**Call relations**: Most local compaction tests use this provider to force HTTP/SSE request paths against the mock server.

*Call graph*: called by 31 (auto_compact_allows_multiple_attempts_when_interleaved_with_other_turn_events, auto_compact_body_after_prefix_counts_growth_after_compaction, auto_compact_body_after_prefix_ignores_starting_window_prefix, auto_compact_body_after_prefix_still_caps_at_context_window, auto_compact_clamps_config_limit_to_context_window, auto_compact_emits_context_compaction_items, auto_compact_persists_rollout_entries, auto_compact_runs_after_token_limit_hit, auto_compact_starts_after_turn_started, body_after_prefix_model_switch_budget_compacts_with_next_model (+15 more)); 2 external calls (built_in_model_providers, format!).


##### `write_global_file`  (lines 276–284)

```
fn write_global_file(
    home: &TempDir,
    filename: &str,
    contents: impl AsRef<[u8]>,
) -> Result<AbsolutePathBuf>
```

**Purpose**: Writes a file under a temp home directory and returns its absolute path wrapper.

**Data flow**: It joins the filename onto the temp home path, writes the provided bytes, converts the path to `AbsolutePathBuf`, and returns it as `Result`.

**Call relations**: Global-instruction snapshot tests use this helper to create and later rewrite `AGENTS.md` and override files.

*Call graph*: called by 3 (manual_compaction_keeps_the_creation_time_global_instructions, mid_turn_compaction_keeps_the_creation_time_global_instructions, remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation); 2 external calls (path, write).


##### `instruction_fragments`  (lines 286–292)

```
fn instruction_fragments(request: &responses::ResponsesRequest) -> Vec<String>
```

**Purpose**: Extracts user-message text fragments that begin with the rendered `AGENTS.md` instruction prefix from a captured request.

**Data flow**: It reads all user message texts from a `ResponsesRequest`, filters those starting with `# AGENTS.md instructions`, and returns them.

**Call relations**: Instruction-snapshot tests use this helper to assert exactly which global-instruction rendering was sent to the model.

*Call graph*: calls 1 internal fn (message_input_texts).


##### `instruction_fragments_in_items`  (lines 294–307)

```
fn instruction_fragments_in_items(items: &[Value]) -> Vec<String>
```

**Purpose**: Extracts rendered `AGENTS.md` instruction fragments from a raw array of serialized response items.

**Data flow**: It scans item values for user `message` entries, flattens their content arrays, reads text spans, filters those starting with the instruction prefix, and returns them.

**Call relations**: The remote-v2 replacement-history test uses this helper to inspect persisted replacement-history items rather than live requests.

*Call graph*: 1 external calls (iter).


##### `expected_instruction_fragment`  (lines 309–311)

```
fn expected_instruction_fragment(contents: &str) -> String
```

**Purpose**: Formats the exact rendered `AGENTS.md` instruction message expected in requests.

**Data flow**: It wraps the provided contents in `# AGENTS.md instructions` plus `<INSTRUCTIONS>...</INSTRUCTIONS>` markup and returns the string.

**Call relations**: Instruction-snapshot tests compare captured request fragments against this canonical rendering.

*Call graph*: called by 3 (manual_compaction_keeps_the_creation_time_global_instructions, mid_turn_compaction_keeps_the_creation_time_global_instructions, remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation); 1 external calls (format!).


##### `assert_single_instruction_fragment`  (lines 313–315)

```
fn assert_single_instruction_fragment(request: &responses::ResponsesRequest, expected: &str)
```

**Purpose**: Asserts that a captured request contains exactly one rendered global-instruction fragment equal to the expected string.

**Data flow**: It computes `instruction_fragments(request)` and compares the resulting vector to a one-element vector containing the expected string.

**Call relations**: The creation-time instruction snapshot tests use this helper on initial, compact, follow-up, and resumed requests.

*Call graph*: called by 3 (manual_compaction_keeps_the_creation_time_global_instructions, mid_turn_compaction_keeps_the_creation_time_global_instructions, remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation); 1 external calls (assert_eq!).


##### `replacement_history_from_rollout`  (lines 317–338)

```
fn replacement_history_from_rollout(path: &Path) -> Result<Vec<Value>>
```

**Purpose**: Parses a rollout file and returns the serialized `replacement_history` from the first `Compacted` rollout item that contains one.

**Data flow**: It reads the rollout text, parses each non-empty line as `RolloutLine`, finds a `RolloutItem::Compacted` with `replacement_history`, serializes each replacement item back to `Value`, and returns the collected vector or an error if none is found.

**Call relations**: Remote-v2 instruction-resume tests use this helper to compare persisted replacement history with later resumed request prefixes.

*Call graph*: called by 1 (remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation); 2 external calls (read_to_string, from_str).


##### `remote_v2_compaction_response`  (lines 340–351)

```
fn remote_v2_compaction_response() -> String
```

**Purpose**: Builds a mocked SSE response body representing a remote-v2 compaction output item followed by completion.

**Data flow**: It returns an SSE string containing one `response.output_item.done` event with a `compaction` item whose `encrypted_content` is `REMOTE_V2_SUMMARY`, plus a completed event.

**Call relations**: The remote-v2 instruction snapshot test uses this helper when scripting the compaction response.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `local_compaction_provider`  (lines 353–359)

```
fn local_compaction_provider(server: &wiremock::MockServer) -> ModelProviderInfo
```

**Purpose**: Builds an OpenAI-compatible provider pointed at the mock server for local compaction instruction-snapshot tests.

**Data flow**: It clones the built-in `openai` provider, renames it, sets `base_url` to the mock server `/v1`, disables websockets, and returns it.

**Call relations**: The creation-time global-instruction tests use this provider in a narrower local-compaction context.

*Call graph*: called by 2 (manual_compaction_keeps_the_creation_time_global_instructions, mid_turn_compaction_keeps_the_creation_time_global_instructions); 2 external calls (built_in_model_providers, format!).


##### `model_info_with_context_window`  (lines 361–370)

```
fn model_info_with_context_window(slug: &str, context_window: i64) -> ModelInfo
```

**Purpose**: Loads a bundled model definition by slug and overrides its context-window size.

**Data flow**: It parses bundled models, finds the requested slug, mutates `context_window`, and returns the resulting `ModelInfo`.

**Call relations**: Model-switch compaction tests use this helper when mounting a synthetic `/models` response.

*Call graph*: called by 1 (model_info_with_optional_comp_hash); 1 external calls (bundled_models_response).


##### `model_info_with_optional_comp_hash`  (lines 372–376)

```
fn model_info_with_optional_comp_hash(slug: &str, comp_hash: Option<&str>) -> ModelInfo
```

**Purpose**: Loads a bundled model definition and optionally sets its `comp_hash` field.

**Data flow**: It starts from `model_info_with_context_window(slug, 273_000)`, then sets `comp_hash` to the provided optional string and returns the model info.

**Call relations**: Comp-hash-based pre-sampling compaction tests use this helper to control whether a model-switch should trigger compaction.

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

**Purpose**: Asserts the expected three-request shape for pre-sampling compaction during a model switch.

**Data flow**: It takes the first, compact, and follow-up request bodies plus previous/next model names; checks the first and compact requests use the previous model, the follow-up uses the next model, the compact request contains the summarization prompt but not `<model_switch>`, and the follow-up request does contain `<model_switch>`.

**Call relations**: Model-switch and comp-hash tests call this helper after capturing the three relevant requests.

*Call graph*: called by 4 (pre_sampling_compact_recovers_comp_hash_after_resume, pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model, pre_sampling_compact_runs_on_switch_to_smaller_context_model, pre_sampling_compact_runs_when_comp_hash_changes); 3 external calls (to_string, assert!, assert_eq!).


##### `assert_compaction_uses_turn_lifecycle_id`  (lines 405–445)

```
async fn assert_compaction_uses_turn_lifecycle_id(codex: &std::sync::Arc<codex_core::CodexThread>)
```

**Purpose**: Verifies that a compaction item’s start/completion events reuse the enclosing turn’s event id.

**Data flow**: It drains events from a `CodexThread` until `TurnComplete`, recording ids for `TurnStarted`, `ItemStarted(ContextCompaction)`, `ItemCompleted(ContextCompaction)`, and `TurnComplete`, then asserts all compaction lifecycle ids equal the turn id.

**Call relations**: Model-switch and resume compaction tests call this helper immediately after submitting the turn that should trigger compaction.

*Call graph*: called by 5 (body_after_prefix_model_switch_budget_compacts_with_next_model, pre_sampling_compact_recovers_comp_hash_after_resume, pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model, pre_sampling_compact_runs_on_switch_to_smaller_context_model, pre_sampling_compact_runs_when_comp_hash_changes); 1 external calls (assert_eq!).


##### `context_snapshot_options`  (lines 446–450)

```
fn context_snapshot_options() -> ContextSnapshotOptions
```

**Purpose**: Builds the standard snapshot-rendering options used by this file’s `insta` request-shape snapshots.

**Data flow**: It starts from `ContextSnapshotOptions::default()`, strips capability instructions, sets render mode to `KindWithTextPrefix { max_chars: 64 }`, and returns the options.

**Call relations**: Snapshot-formatting helpers call this to keep all request-shape snapshots normalized the same way.

*Call graph*: calls 1 internal fn (default); called by 1 (format_labeled_requests_snapshot).


##### `format_labeled_requests_snapshot`  (lines 452–461)

```
fn format_labeled_requests_snapshot(
    scenario: &str,
    sections: &[(&str, &core_test_support::responses::ResponsesRequest)],
) -> String
```

**Purpose**: Formats a labeled multi-request snapshot string using the file’s standard context-snapshot options.

**Data flow**: It forwards the scenario label, request sections, and `context_snapshot_options()` into `context_snapshot::format_labeled_requests_snapshot` and returns the rendered string.

**Call relations**: Many snapshot-oriented tests call this when asserting request-shape behavior with `insta`.

*Call graph*: calls 2 internal fn (format_labeled_requests_snapshot, context_snapshot_options).


##### `summarize_context_three_requests_and_instructions`  (lines 464–668)

```
async fn summarize_context_three_requests_and_instructions()
```

**Purpose**: Exercises a simple manual compaction flow and verifies the three resulting requests, warning event, and rollout entries.

**Data flow**: It mounts three SSE responses (normal reply, summary reply, final completion), builds a codex with a non-websocket provider and compact prompt, submits a user turn, `Op::Compact`, and another user turn, then inspects the three request bodies for instructions, summarization prompt placement, summary-only history in the third request, and finally shuts down and parses the rollout file for `TurnContext` and `Compacted` entries.

**Call relations**: This is the foundational end-to-end manual compaction test in the file, combining request-shape, event, and rollout assertions.

*Call graph*: calls 7 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, body_contains_text, non_openai_model_provider, summary_with_prefix); 11 external calls (default, new, assert!, assert_eq!, wait_for_event, panic!, println!, from_str, skip_if_no_network!, read_to_string (+1 more)).


##### `manual_pre_compact_block_decision_does_not_block_compaction`  (lines 671–741)

```
async fn manual_pre_compact_block_decision_does_not_block_compaction()
```

**Purpose**: Verifies that an unsupported blocking decision from a manual `PreCompact` hook is treated as a failed hook run but does not prevent compaction.

**Data flow**: It installs the blocking hook fixture, runs one user turn and then `Op::Compact`, waits for a `HookCompleted` event for `PreCompact`, a warning, and turn completion, asserts two requests were still sent, then reads the hook log and checks the payload fields.

**Call relations**: This test ties together hook execution, event reporting, and the compaction request path.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider, read_hook_inputs); 7 external calls (default, assert!, assert_eq!, wait_for_event, wait_for_event_match, skip_if_no_network!, vec!).


##### `compact_hooks_respect_matchers_and_post_runs_after_compaction`  (lines 744–809)

```
async fn compact_hooks_respect_matchers_and_post_runs_after_compaction()
```

**Purpose**: Checks that hook matchers are respected: an auto-only pre-hook should not run for manual compaction, while a manual post-hook should run after compaction.

**Data flow**: It installs the matching-hook fixture, runs a user turn and manual compact, waits for warning and completion, asserts the auto pre-hook log file does not exist, then reads the manual post-hook log and checks its payload fields.

**Call relations**: This is the positive matcher-selection test complementing the unsupported-blocking-hook case.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider, read_hook_inputs); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `manual_compact_uses_custom_prompt`  (lines 812–903)

```
async fn manual_compact_uses_custom_prompt()
```

**Purpose**: Verifies that when `config.compact_prompt` is customized, the compaction request uses that prompt instead of the default summarization prompt.

**Data flow**: It mounts a first-turn and compact response, builds a codex with a custom compact prompt, runs a user turn and `Op::Compact`, then scans the compact request input messages to assert the custom prompt is present and the default prompt is absent.

**Call relations**: This test focuses on prompt injection behavior for manual compaction.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 7 external calls (default, assert!, assert_eq!, wait_for_event, panic!, skip_if_no_network!, vec!).


##### `manual_compact_emits_api_and_local_token_usage_events`  (lines 906–961)

```
async fn manual_compact_emits_api_and_local_token_usage_events()
```

**Purpose**: Checks that manual compaction emits one token-count event from API usage and another from local post-compaction context estimation.

**Data flow**: It mounts a compact response whose API usage reports zero tokens, triggers `Op::Compact`, waits for two `TokenCount` events carrying `last_token_usage.total_tokens`, then asserts the first is zero and the second is positive before waiting for turn completion.

**Call relations**: This test inspects event sequencing and token accounting rather than request shape.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (assert!, assert_eq!, wait_for_event, wait_for_event_match, skip_if_no_network!, vec!).


##### `manual_compact_emits_context_compaction_items`  (lines 964–1038)

```
async fn manual_compact_emits_context_compaction_items()
```

**Purpose**: Verifies that manual compaction emits both the new `ItemStarted/ItemCompleted(ContextCompaction)` events and the legacy `ContextCompacted` event.

**Data flow**: It runs one normal turn and one manual compact, then drains events until it has seen compaction item start/completion, a legacy `ContextCompacted`, and `TurnComplete`, finally asserting the started/completed item ids match.

**Call relations**: This is the manual-compaction lifecycle-event regression test.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `multiple_auto_compact_per_task_runs_after_token_limit_hit`  (lines 1041–1583)

```
async fn multiple_auto_compact_per_task_runs_after_token_limit_hit()
```

**Purpose**: Exercises repeated automatic compactions within one long task and verifies the exact request history after each compaction.

**Data flow**: It scripts alternating reasoning/tool work responses and compaction summaries, submits one user turn, captures all seven requests, normalizes away irrelevant prefix items, and asserts both the compacted-history shape after each compaction and the full expected input arrays for every request index.

**Call relations**: This is one of the most detailed auto-compaction tests, covering repeated compactions, reasoning items, function-call artifacts, and summary replacement over a single task.

*Call graph*: calls 7 internal fn (ev_reasoning_item, mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider, summary_with_prefix); 6 external calls (default, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `auto_compact_runs_after_token_limit_hit`  (lines 1588–1785)

```
async fn auto_compact_runs_after_token_limit_hit()
```

**Purpose**: Verifies the simpler pre-turn auto-compaction flow: an over-limit turn causes the next user turn to insert one compaction request before the follow-up request.

**Data flow**: It mounts four responses (two normal turns, one compaction summary, one final reply), submits three user turns, then inspects the four captured request bodies to locate the single compaction request, confirm it is the third request, and assert the follow-up request contains the earlier user messages plus the summary and new user message.

**Call relations**: This is the baseline automatic pre-turn compaction test.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `auto_compact_emits_context_compaction_items`  (lines 1790–1871)

```
async fn auto_compact_emits_context_compaction_items()
```

**Purpose**: Checks that automatic compaction emits context-compaction item lifecycle events and the legacy `ContextCompacted` event.

**Data flow**: It submits three user turns through a setup that triggers auto-compaction, drains events after each turn until the non-auto turn completes, records any compaction item start/completion and legacy event, and finally asserts the compaction item ids match and the legacy event occurred.

**Call relations**: This is the auto-compaction counterpart to the manual lifecycle-event test.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 5 external calls (default, assert!, assert_eq!, skip_if_no_network!, vec!).


##### `auto_compact_starts_after_turn_started`  (lines 1876–1975)

```
async fn auto_compact_starts_after_turn_started()
```

**Purpose**: Verifies event ordering: on a turn that triggers auto-compaction, `TurnStarted` must be emitted before the compaction item starts.

**Data flow**: It submits two setup turns and a third turn that triggers compaction, waits for the first event among `TurnStarted` and `ItemStarted(ContextCompaction)`, asserts it is `TurnStarted`, then waits for compaction start and final turn completion.

**Call relations**: This test guards event ordering in the turn lifecycle around auto-compaction.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (default, assert_eq!, wait_for_event, wait_for_event_match, skip_if_no_network!, vec!).


##### `auto_compact_runs_after_resume_when_token_usage_is_over_limit`  (lines 1978–2086)

```
async fn auto_compact_runs_after_resume_when_token_usage_is_over_limit()
```

**Purpose**: Checks that an over-limit turn persisted before shutdown triggers remote compaction on the next user turn after resume, not immediately before resume.

**Data flow**: It mounts a remote compact endpoint and an over-limit first turn, submits that turn, resumes from rollout, mounts a follow-up response matcher that expects both the new user text and remote summary, submits the resumed turn, waits for `ContextCompacted` and `TurnComplete`, and asserts exactly one remote compact request hit `/v1/responses/compact`.

**Call relations**: This test bridges local persisted token state with remote compaction after resume.

*Call graph*: calls 7 internal fn (mount_compact_json_once, mount_sse_once, mount_sse_once_match, sse, start_mock_server, test_codex, disabled_permission_user_turn); 6 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `pre_sampling_compact_runs_on_switch_to_smaller_context_model`  (lines 2089–2188)

```
async fn pre_sampling_compact_runs_on_switch_to_smaller_context_model()
```

**Purpose**: Verifies that switching to a smaller-context model triggers pre-sampling compaction before the next turn is sampled.

**Data flow**: It mounts a `/models` response with previous and next model context windows, scripts three responses (before switch, compaction summary, after switch), submits a first turn on the previous model and a second turn on the next model, asserts compaction lifecycle ids, then checks the three requests with `assert_pre_sampling_switch_compaction_requests` and snapshots their shapes.

**Call relations**: This is the main pre-sampling model-switch compaction test.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, assert_compaction_uses_turn_lifecycle_id, assert_pre_sampling_switch_compaction_requests, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 6 external calls (start, assert_eq!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `pre_sampling_compact_runs_when_comp_hash_changes`  (lines 2191–2275)

```
async fn pre_sampling_compact_runs_when_comp_hash_changes()
```

**Purpose**: Checks that a model switch with differing `comp_hash` values also triggers pre-sampling compaction, even without a smaller context window.

**Data flow**: It mounts model metadata with different comp hashes, runs a before-switch turn and an after-switch turn, asserts compaction lifecycle ids, and validates the three-request shape with `assert_pre_sampling_switch_compaction_requests`.

**Call relations**: This is the comp-hash-triggered analogue of the smaller-context model-switch test.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, assert_compaction_uses_turn_lifecycle_id, assert_pre_sampling_switch_compaction_requests, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 5 external calls (start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `pre_sampling_compact_skips_when_either_comp_hash_is_missing`  (lines 2278–2385)

```
async fn pre_sampling_compact_skips_when_either_comp_hash_is_missing()
```

**Purpose**: Verifies that pre-sampling compaction is skipped when either side of a model switch lacks a `comp_hash`.

**Data flow**: It mounts three models covering hash introduction and removal cases, submits three turns across those models, waits for completion each time, then asserts the request sequence contains only the three normal model requests and none include the summarization prompt.

**Call relations**: This is the negative case for comp-hash-based pre-sampling compaction.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_sequence, test_codex, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 6 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `body_after_prefix_model_switch_budget_compacts_with_next_model`  (lines 2388–2479)

```
async fn body_after_prefix_model_switch_budget_compacts_with_next_model()
```

**Purpose**: Checks that in `BodyAfterPrefix` budgeting mode, a model switch can trigger compaction using the next model rather than the previous one.

**Data flow**: It mounts model metadata and three responses, configures `RemoteModels`, a low body-after-prefix limit, and a previous/next model switch, submits two turns, asserts compaction lifecycle ids, then checks that the first request used the previous model while both compact and follow-up requests used the next model and that the compact request contains the summarization prompt.

**Call relations**: This test combines body-after-prefix budgeting with model-switch compaction selection.

*Call graph*: calls 7 internal fn (mount_models_once, mount_sse_sequence, test_codex, assert_compaction_uses_turn_lifecycle_id, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 6 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model`  (lines 2482–2600)

```
async fn pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model()
```

**Purpose**: Verifies that after resuming a thread, switching to a smaller-context model still triggers pre-sampling compaction.

**Data flow**: It runs a pre-resume turn, shuts down, resumes from rollout, submits a turn on the smaller model, asserts compaction lifecycle ids, and validates the three-request shape with `assert_pre_sampling_switch_compaction_requests`.

**Call relations**: This extends the smaller-context model-switch compaction test across a persisted/resumed thread boundary.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, assert_compaction_uses_turn_lifecycle_id, assert_pre_sampling_switch_compaction_requests, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 5 external calls (start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `pre_sampling_compact_recovers_comp_hash_after_resume`  (lines 2603–2731)

```
async fn pre_sampling_compact_recovers_comp_hash_after_resume()
```

**Purpose**: Checks that a persisted `comp_hash` in rollout is recovered on resume and can still trigger pre-sampling compaction when switching to a model with a different hash.

**Data flow**: It runs a pre-resume turn, shuts down, reads the rollout to assert `comp_hash` was persisted, resumes, submits a turn on the next model, asserts compaction lifecycle ids, and validates the three-request shape.

**Call relations**: This is the resume-aware comp-hash compaction test.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, assert_compaction_uses_turn_lifecycle_id, assert_pre_sampling_switch_compaction_requests, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 6 external calls (start, assert_eq!, wait_for_event, read_to_string, skip_if_no_network!, vec!).


##### `pre_sampling_compact_skips_missing_comp_hash_after_resume`  (lines 2734–2860)

```
async fn pre_sampling_compact_skips_missing_comp_hash_after_resume()
```

**Purpose**: Verifies that if the persisted rollout lacks a `comp_hash`, a resumed model switch does not trigger pre-sampling compaction.

**Data flow**: It runs a pre-resume turn on a model without comp hash, shuts down, inspects the rollout to confirm `comp_hash` is absent, resumes, submits a turn on a model with a hash, and asserts only two normal requests were sent and none contain the summarization prompt.

**Call relations**: This is the negative resume case for comp-hash-triggered compaction.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_sequence, test_codex, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 7 external calls (start, assert!, assert_eq!, wait_for_event, read_to_string, skip_if_no_network!, vec!).


##### `auto_compact_persists_rollout_entries`  (lines 2863–3000)

```
async fn auto_compact_persists_rollout_entries()
```

**Purpose**: Checks that automatic compaction still persists one `TurnContext` rollout entry per real user turn.

**Data flow**: It mounts request matchers for first turn, second turn, compaction request, and post-compaction turn, submits three user turns, shuts down, reads the rollout file, counts `RolloutItem::TurnContext` entries, and asserts there are three.

**Call relations**: This test focuses on rollout persistence rather than request shape or event ordering.

*Call graph*: calls 6 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, auto_summary, non_openai_model_provider); 7 external calls (default, assert_eq!, wait_for_event, from_str, skip_if_no_network!, read_to_string, vec!).


##### `manual_compact_retries_after_context_window_error`  (lines 3003–3103)

```
async fn manual_compact_retries_after_context_window_error()
```

**Purpose**: Verifies that manual compaction retries after a `context_length_exceeded` failure by dropping exactly one oldest history item.

**Data flow**: It mounts a normal user turn, a failed compact SSE, and a successful compact SSE, runs a user turn and `Op::Compact`, then compares the first and retry compact request inputs to assert both consistently include or omit the prompt and that the retry input is exactly one item shorter with a different first item.

**Call relations**: This is the manual-compaction retry-shape test for context-window overflow.

*Call graph*: calls 7 internal fn (mount_sse_sequence, sse, sse_failed, start_mock_server, test_codex, body_contains_text, non_openai_model_provider); 7 external calls (default, assert_eq!, assert_ne!, wait_for_event, panic!, skip_if_no_network!, vec!).


##### `manual_compact_non_context_failure_retries_then_emits_task_error`  (lines 3109–3182)

```
async fn manual_compact_non_context_failure_retries_then_emits_task_error()
```

**Purpose**: Checks the current behavior for non-context manual compaction failures: one reconnect attempt followed by a task error event.

**Data flow**: It mounts a user turn and two failing compact SSE streams, configures one stream retry, runs a user turn and `Op::Compact`, waits for a `StreamError` mentioning reconnect and then an `Error` mentioning local compact task failure, and finally waits for turn completion.

**Call relations**: This ignored test documents current known-incorrect behavior for non-context compact failures.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, sse_failed, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (default, assert!, wait_for_event, wait_for_event_match, skip_if_no_network!, vec!).


##### `manual_compact_twice_preserves_latest_user_messages`  (lines 3185–3433)

```
async fn manual_compact_twice_preserves_latest_user_messages()
```

**Purpose**: Verifies that two successive manual compactions preserve the latest user-message history and mark compact requests with compaction metadata while later normal turns use fresh window ids.

**Data flow**: It scripts five responses (turn, compact, turn, compact, final turn), runs that sequence, then inspects all five requests for user-message presence, compact metadata headers, request-kind transitions, window-id changes, and final user-history layout, plus snapshots the first compact and post-compaction history shapes.

**Call relations**: This is a detailed multi-compaction regression test covering metadata headers, history preservation, and compacted-window transitions.

*Call graph*: calls 7 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, auto_summary, non_openai_model_provider, summary_with_prefix); 9 external calls (default, assert!, assert_eq!, assert_ne!, wait_for_event, assert_snapshot!, from_str, skip_if_no_network!, vec!).


##### `auto_compact_allows_multiple_attempts_when_interleaved_with_other_turn_events`  (lines 3436–3547)

```
async fn auto_compact_allows_multiple_attempts_when_interleaved_with_other_turn_events()
```

**Purpose**: Checks that multiple auto-compactions can still occur when other turn events, such as function-call continuations, are interleaved, and that auto-compaction does not emit its own task lifecycle events.

**Data flow**: It scripts six responses including two compaction summaries and a function-call continuation, submits three user turns while collecting any `auto-compact-*` lifecycle events, asserts none were emitted, then inspects the six request bodies to confirm the two compaction requests occurred in the expected positions.

**Call relations**: This test focuses on repeated auto-compaction orchestration in the presence of other turn-level activity.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, auto_summary, non_openai_model_provider); 7 external calls (default, new, assert!, assert_eq!, matches!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_mid_turn_continuation_compaction`  (lines 3550–3654)

```
async fn snapshot_request_shape_mid_turn_continuation_compaction()
```

**Purpose**: Captures the request shape for true mid-turn local compaction after a function-call output pushes the turn over the token threshold.

**Data flow**: It mounts an initial function-call turn, an auto-compaction summary, and a post-compaction final turn, submits one user turn, asserts the first request contains the triggering user message, checks the compact request includes the function-call output and summarization prompt, and snapshots the compact and post-compaction request shapes.

**Call relations**: This is a snapshot-oriented regression test for mid-turn continuation compaction layout.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, auto_summary, non_openai_model_provider); 6 external calls (default, assert!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `auto_compact_clamps_config_limit_to_context_window`  (lines 3657–3714)

```
async fn auto_compact_clamps_config_limit_to_context_window()
```

**Purpose**: Verifies that an auto-compaction limit configured above the model context window is clamped down to the usable context threshold.

**Data flow**: It configures a 100-token context window and a 200-token auto-compact limit, runs an over-limit first turn and a follow-up turn, then asserts the first request contains the over-limit user input and the compact request includes the summarization prompt.

**Call relations**: This test covers threshold calculation rather than history layout.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, auto_summary, non_openai_model_provider); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `auto_compact_body_after_prefix_ignores_starting_window_prefix`  (lines 3717–3783)

```
async fn auto_compact_body_after_prefix_ignores_starting_window_prefix()
```

**Purpose**: Checks that `BodyAfterPrefix` budgeting ignores the initial window prefix and only compacts once growth after the first assistant sample exceeds the configured budget.

**Data flow**: It scripts two normal turns, one compaction summary, and a third turn, configures body-after-prefix mode with a small budget, submits two turns and asserts no compaction yet, then submits a third turn and asserts the third request is the compaction request containing the summarization prompt.

**Call relations**: This is the baseline body-after-prefix budgeting test.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `auto_compact_body_after_prefix_counts_growth_after_compaction`  (lines 3786–3886)

```
async fn auto_compact_body_after_prefix_counts_growth_after_compaction()
```

**Purpose**: Verifies that after a compaction, later growth in the new window is counted against the body-after-prefix budget and can trigger another compaction.

**Data flow**: It scripts six responses spanning an initial turn, first compaction, two more turns, second compaction, and final turn; submits four user turns; and asserts request counts after each phase, with the fourth turn causing a second compaction request containing the summarization prompt.

**Call relations**: This extends body-after-prefix budgeting across multiple windows and compactions.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `auto_compact_body_after_prefix_still_caps_at_context_window`  (lines 3889–3945)

```
async fn auto_compact_body_after_prefix_still_caps_at_context_window()
```

**Purpose**: Checks that body-after-prefix mode still respects the overall context-window cap even if the configured body budget is larger.

**Data flow**: It configures a 100-token context window and 200-token body-after-prefix limit, submits three turns, then asserts the third turn caused a compaction request because total context hit the usable window and that the compact request contains the summarization prompt.

**Call relations**: This is the context-cap negative case for body-after-prefix budgeting.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `auto_compact_counts_encrypted_reasoning_before_last_user`  (lines 3948–4078)

```
async fn auto_compact_counts_encrypted_reasoning_before_last_user()
```

**Purpose**: Verifies that encrypted reasoning content before the last user turn counts toward remote auto-compaction, while reasoning after the last user turn does not trigger compaction until the next user turn.

**Data flow**: It scripts two reasoning-heavy turns and a final turn, mounts a remote compact endpoint returning a summary plus compaction item, submits three user turns, asserts no compaction before the third turn, then checks one remote compact request occurred and that the third request body includes the remote compact summary and encrypted compaction item.

**Call relations**: This test targets the token-estimation boundary around reasoning items relative to the last user message.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_sequence, sse, start_mock_server, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, wait_for_event, format!, json!, skip_if_no_network!, vec!).


##### `auto_compact_runs_when_reasoning_header_clears_between_turns`  (lines 4081–4166)

```
async fn auto_compact_runs_when_reasoning_header_clears_between_turns()
```

**Purpose**: Checks that remote auto-compaction still runs once a server-provided reasoning-included header clears between turns.

**Data flow**: It mounts response sequences where the first turn includes `X-Reasoning-Included: true`, the second does not, and a remote compact endpoint is available; after three user turns it asserts exactly one remote compact request occurred.

**Call relations**: This is a regression test for state carried from response headers into later compaction decisions.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_response_sequence, sse, start_mock_server, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_pre_turn_compaction_including_incoming_user_message`  (lines 4170–4287)

```
async fn snapshot_request_shape_pre_turn_compaction_including_incoming_user_message()
```

**Purpose**: Captures current pre-turn local compaction behavior with a context override and incoming image/text user input, documenting that the compact request still excludes the incoming user message.

**Data flow**: It runs two setup turns, submits thread settings changing the environment cwd, then submits a third turn containing an image and text, waits for completion, snapshots the compact and follow-up requests, and asserts the compact request excludes `USER_THREE` while the follow-up request includes both the text and image.

**Call relations**: This is a snapshot test documenting current known behavior before a planned change to include incoming user input in pre-turn compaction.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, local_selections, test_codex, non_openai_model_provider); 9 external calls (default, assert!, assert_eq!, submit_thread_settings, test_path_buf, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_pre_turn_compaction_strips_incoming_model_switch`  (lines 4292–4392)

```
async fn snapshot_request_shape_pre_turn_compaction_strips_incoming_model_switch()
```

**Purpose**: Captures current pre-turn local compaction behavior during a model switch, documenting that the compact request strips the incoming `<model_switch>` item and the follow-up restores it.

**Data flow**: It runs a first turn on one model, then a second turn on another model under auto-compaction conditions, asserts the compact request contains the summarization prompt but not `<model_switch>`, asserts the follow-up does contain `<model_switch>`, and snapshots all three requests.

**Call relations**: This is the local pre-turn counterpart to the model-switch request-shape tests.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, test_codex, disabled_permission_user_turn, non_openai_model_provider, create_dummy_chatgpt_auth_for_testing); 6 external calls (assert!, assert_eq!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_pre_turn_compaction_context_window_exceeded`  (lines 4395–4485)

```
async fn snapshot_request_shape_pre_turn_compaction_context_window_exceeded()
```

**Purpose**: Documents current behavior when pre-turn local compaction repeatedly fails with context-window errors: the compact request excludes the incoming user message and the turn errors.

**Data flow**: It mounts one normal turn followed by five failing compact responses, submits two user turns, waits for an `Error` event and turn completion, snapshots the first compact request, and asserts the surfaced error message mentions running out of room in the model context window.

**Call relations**: This is a snapshot-oriented failure-path test for pre-turn local compaction.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 7 external calls (default, assert!, wait_for_event, wait_for_event_match, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_manual_compact_without_previous_user_messages`  (lines 4488–4549)

```
async fn snapshot_request_shape_manual_compact_without_previous_user_messages()
```

**Purpose**: Documents current behavior when manual `/compact` is invoked before any prior user turn: a compaction request is still issued and the next turn uses canonical context plus the new user message.

**Data flow**: It mounts a compact response and a follow-up turn response, runs `Op::Compact` and then a user turn, waits for completion after each, and snapshots the compact request and follow-up request.

**Call relations**: This is a snapshot test for an edge case in manual compaction startup behavior.

*Call graph*: calls 5 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, non_openai_model_provider); 6 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `manual_compaction_keeps_the_creation_time_global_instructions`  (lines 4552–4628)

```
async fn manual_compaction_keeps_the_creation_time_global_instructions() -> Result<()>
```

**Purpose**: Verifies that manual local compaction preserves the thread’s creation-time global instruction snapshot even if the selected `AGENTS.md` file is rewritten in place before compaction.

**Data flow**: It writes an initial global file, builds a thread using a local compaction provider, confirms the thread reports that source, submits a turn, rewrites the same file path with new contents, runs `Op::Compact` and a follow-up turn, then asserts all three requests still contain the old rendered instruction fragment and that `instruction_sources()` still reports the original path.

**Call relations**: This is one of the key instruction-snapshot invariants in the file, tying live request rendering to creation-time source snapshots rather than current file contents.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_instruction_fragment, local_compaction_provider, write_global_file); 6 external calls (clone, new, new, assert_eq!, wait_for_event, vec!).


##### `mid_turn_compaction_keeps_the_creation_time_global_instructions`  (lines 4631–4700)

```
async fn mid_turn_compaction_keeps_the_creation_time_global_instructions() -> Result<()>
```

**Purpose**: Verifies that automatic mid-turn local compaction also preserves the creation-time global instruction snapshot even if a preferred override file is added later.

**Data flow**: It writes an initial global file, builds a thread with a low auto-compaction threshold, confirms the source list, writes a new override file before the turn, submits a turn that triggers mid-turn compaction, and asserts the initial, compact, and resumed requests all contain the old instruction fragment and the source list remains unchanged.

**Call relations**: This extends the creation-time instruction invariant from manual compaction to mid-turn auto-compaction.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_instruction_fragment, local_compaction_provider, write_global_file); 6 external calls (clone, new, new, assert_eq!, assert_ne!, vec!).


##### `remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation`  (lines 4703–4834)

```
async fn remote_v2_compaction_keeps_creation_time_instructions_after_same_path_mutation() -> Result<()>
```

**Purpose**: Verifies that remote-v2 compaction and later cold resume preserve the creation-time instruction snapshot even when the selected source path is rewritten in place.

**Data flow**: It writes an initial `AGENTS.md`, builds a thread with `RemoteCompactionV2`, submits a turn, rewrites the same file path, runs `Op::Compact`, submits a follow-up turn, flushes rollout, asserts the initial/compact/follow-up requests all contain the old instruction fragment, inspects rollout replacement history, shuts down, resumes from rollout, submits another turn, and asserts the resumed request replays the persisted replacement history and still contains the old instruction fragment despite the file now containing new text.

**Call relations**: This is the most comprehensive instruction-snapshot persistence test in the file, spanning remote-v2 compaction, rollout replacement history, and cold resume.

*Call graph*: calls 8 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_instruction_fragment, replacement_history_from_rollout, write_global_file, create_dummy_chatgpt_auth_for_testing); 7 external calls (clone, new, new, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/compact_remote_parity.rs`

`test` · `request handling`

This file defines a compact parity framework around two modes: `Legacy` remote compaction via `/responses/compact` and `V2` inline compaction via `/responses` plus a `compaction_trigger`. It introduces small enums and structs—`AuthCase`, `RunSettings`, `Step`, `Scenario`, and `Capture`—to parameterize transcript shape, auth mode, service-tier settings, and the captured artifacts to compare. The helper layer builds deterministic harnesses in a fixed cwd, seeds global instructions, optionally installs manual compact hooks, mounts either a legacy compact endpoint or a v2 compaction response, drives user turns, and then captures the compact request body, post-compact follow-up request body, rollout replacement history, and request counts.

The core comparison logic normalizes away unstable values and protocol-specific differences. `compact_request_view` strips the v2 `compaction_trigger`, `selected_request_fields` keeps only the fields relevant to parity, `normalize_value` rewrites UUID-like strings, temp skill paths, and shell wall times, and `canonical_json` sorts object keys. The top-level tests then compare manual transcript scenarios, pre-turn auto compaction, mid-turn auto compaction, and manual compact hook payloads. One special case allows v2 to add `service_tier` for API-key auth while still requiring all other compact-request fields, follow-up request shape, and replacement history to match legacy behavior. The result is a regression suite that treats legacy and v2 as two implementations of the same externally visible compaction semantics.

#### Function details

##### `AuthCase::build`  (lines 44–49)

```
fn build(self) -> CodexAuth
```

**Purpose**: Constructs the `CodexAuth` value corresponding to an `AuthCase` enum variant.

**Data flow**: For `ChatGpt` it returns `create_dummy_chatgpt_auth_for_testing()`, and for `ApiKey` it returns `from_api_key("dummy")`.

**Call relations**: Harness-building helpers call this when parameterizing parity runs by auth mode.

*Call graph*: calls 2 internal fn (create_dummy_chatgpt_auth_for_testing, from_api_key).


##### `RunSettings::default`  (lines 59–64)

```
fn default() -> Self
```

**Purpose**: Provides default parity-run settings: ChatGPT auth and no fast service tier.

**Data flow**: It returns a `RunSettings` struct with `auth = AuthCase::ChatGpt` and `service_tier_fast = false`.

**Call relations**: Most parity tests use this default and only override settings in the API-key service-tier case.

*Call graph*: called by 3 (build_auto_harness, remote_compaction_parity_manual_transcripts, run_manual_hook_session).


##### `Step::label`  (lines 78–87)

```
fn label(self) -> &'static str
```

**Purpose**: Returns a stable string label for a transcript step kind.

**Data flow**: It matches the `Step` enum and returns a static string such as `assistant`, `function_tool`, or `web_search_assistant`.

**Call relations**: Scenario and response-construction helpers use this label to build deterministic request text and response ids.


##### `remote_compaction_parity_manual_transcripts`  (lines 118–145)

```
async fn remote_compaction_parity_manual_transcripts() -> Result<()>
```

**Purpose**: Runs several manual transcript scenarios through both legacy and v2 remote compaction and asserts parity.

**Data flow**: It defines four `Scenario` values with different step mixes, then iterates them and calls `compare_manual_scenario` with default run settings.

**Call relations**: This is the main top-level parity test for manual compaction across varied transcript shapes.

*Call graph*: calls 2 internal fn (default, compare_manual_scenario); 1 external calls (skip_if_no_network!).


##### `remote_compaction_parity_v2_api_key_sends_service_tier_upgrade`  (lines 148–176)

```
async fn remote_compaction_parity_v2_api_key_sends_service_tier_upgrade() -> Result<()>
```

**Purpose**: Checks the one intentional parity difference: under API-key auth with fast tier configured, v2 sends `service_tier` while legacy omits it.

**Data flow**: It runs the same manual scenario in legacy and v2 modes with API-key auth and fast tier, asserts the legacy compact body lacks `service_tier` while the v2 body contains the fast request value, then compares all other compact, follow-up, and replacement-history artifacts.

**Call relations**: This test uses the same capture machinery as the general parity tests but relaxes equality for one field.

*Call graph*: calls 3 internal fn (assert_compact_requests_eq_except_v2_service_tier, assert_follow_up_and_history_eq, run_manual_session); 2 external calls (assert_eq!, skip_if_no_network!).


##### `remote_compaction_parity_manual_hooks`  (lines 179–186)

```
async fn remote_compaction_parity_manual_hooks() -> Result<()>
```

**Purpose**: Verifies that manual compact hook payloads are identical between legacy and v2 remote compaction.

**Data flow**: It runs `run_manual_hook_session` in both modes and compares the resulting normalized JSON payloads with `assert_json_eq`.

**Call relations**: This is the parity test for hook side effects rather than request bodies.

*Call graph*: calls 2 internal fn (assert_json_eq, run_manual_hook_session); 1 external calls (skip_if_no_network!).


##### `remote_compaction_parity_pre_turn_auto`  (lines 189–196)

```
async fn remote_compaction_parity_pre_turn_auto() -> Result<()>
```

**Purpose**: Verifies parity between legacy and v2 for pre-turn automatic remote compaction.

**Data flow**: It runs `run_pre_turn_auto_session` in both modes and compares the resulting captures with `assert_capture_eq`.

**Call relations**: This is the pre-turn auto-compaction parity entrypoint.

*Call graph*: calls 2 internal fn (assert_capture_eq, run_pre_turn_auto_session); 1 external calls (skip_if_no_network!).


##### `remote_compaction_parity_mid_turn_auto`  (lines 199–206)

```
async fn remote_compaction_parity_mid_turn_auto() -> Result<()>
```

**Purpose**: Verifies parity between legacy and v2 for mid-turn automatic remote compaction.

**Data flow**: It runs `run_mid_turn_auto_session` in both modes and compares the resulting captures with `assert_capture_eq`.

**Call relations**: This is the mid-turn auto-compaction parity entrypoint.

*Call graph*: calls 2 internal fn (assert_capture_eq, run_mid_turn_auto_session); 1 external calls (skip_if_no_network!).


##### `compare_manual_scenario`  (lines 208–213)

```
async fn compare_manual_scenario(scenario: &Scenario, settings: RunSettings) -> Result<()>
```

**Purpose**: Runs one manual transcript scenario in both modes and compares the captures.

**Data flow**: It calls `run_manual_session` for `Legacy` and `V2`, then passes both `Capture` values to `assert_capture_eq`.

**Call relations**: The top-level manual transcript test iterates scenarios through this helper.

*Call graph*: calls 2 internal fn (assert_capture_eq, run_manual_session); called by 1 (remote_compaction_parity_manual_transcripts).


##### `assert_capture_eq`  (lines 215–255)

```
fn assert_capture_eq(label: &str, legacy: &Capture, v2: &Capture)
```

**Purpose**: Asserts full parity between a legacy and v2 capture: compact request view, follow-up request view, replacement history, and expected compact-request counts.

**Data flow**: It checks that legacy made exactly one compact request and v2 made zero legacy compact requests, derives normalized compact and follow-up views with `compact_request_view` and `follow_up_request_view`, compares them and the replacement history with `assert_json_eq`, and prints a summary line with request/item counts.

**Call relations**: This is the central equality checker used by most parity tests.

*Call graph*: calls 3 internal fn (assert_json_eq, compact_request_view, follow_up_request_view); called by 3 (compare_manual_scenario, remote_compaction_parity_mid_turn_auto, remote_compaction_parity_pre_turn_auto); 3 external calls (assert_eq!, format!, println!).


##### `assert_compact_requests_eq_except_v2_service_tier`  (lines 257–275)

```
fn assert_compact_requests_eq_except_v2_service_tier(label: &str, legacy: &Capture, v2: &Capture)
```

**Purpose**: Asserts compact-request parity while explicitly ignoring the `service_tier` field on the v2 side.

**Data flow**: It checks compact-request counts, derives normalized compact views, removes `service_tier` from the v2 view, and compares the remaining JSON with `assert_json_eq`.

**Call relations**: The API-key service-tier upgrade test uses this helper for its compact-request comparison.

*Call graph*: calls 3 internal fn (assert_json_eq, compact_request_view, remove_object_field); called by 1 (remote_compaction_parity_v2_api_key_sends_service_tier_upgrade); 2 external calls (assert_eq!, format!).


##### `assert_follow_up_and_history_eq`  (lines 277–291)

```
fn assert_follow_up_and_history_eq(label: &str, legacy: &Capture, v2: &Capture)
```

**Purpose**: Asserts parity of the post-compact follow-up request and rollout replacement history between legacy and v2 captures.

**Data flow**: It derives normalized follow-up views from both captures and compares them, then compares the replacement-history JSON values.

**Call relations**: The API-key service-tier test uses this helper after handling the compact-request special case separately.

*Call graph*: calls 2 internal fn (assert_json_eq, follow_up_request_view); called by 1 (remote_compaction_parity_v2_api_key_sends_service_tier_upgrade); 1 external calls (format!).


##### `run_manual_session`  (lines 293–336)

```
async fn run_manual_session(
    scenario: &Scenario,
    mode: Mode,
    settings: RunSettings,
) -> Result<Capture>
```

**Purpose**: Runs a manual compaction scenario in one mode and captures the compact request, follow-up request, and replacement history.

**Data flow**: It builds the scripted response sequence for the scenario, appending a v2 compaction response when needed and always appending an after-compact response, builds a harness, mounts normal responses and an optional legacy compact endpoint, submits one user turn per scenario step, submits `Op::Compact`, submits an after-compact user turn, and then calls `capture_from_requests`.

**Call relations**: Manual transcript parity tests and the API-key service-tier test both use this as their scenario runner.

*Call graph*: calls 12 internal fn (mount_sse_sequence, after_compact_response_body, build_harness, capture_from_requests, compaction_v2_response_body, follow_up_index, mount_legacy_compact_if_needed, response_bodies_for_scenario, rollout_path, submit_user_input (+2 more)); called by 2 (compare_manual_scenario, remote_compaction_parity_v2_api_key_sends_service_tier_upgrade); 1 external calls (vec!).


##### `run_pre_turn_auto_session`  (lines 338–394)

```
async fn run_pre_turn_auto_session(mode: Mode) -> Result<Capture>
```

**Purpose**: Runs a pre-turn automatic compaction scenario in one mode and captures the resulting artifacts.

**Data flow**: It chooses a response sequence based on mode, builds an auto-compaction harness, mounts normal responses and an optional legacy compact endpoint, submits a before-turn and after-turn user input, then captures the compact/follow-up artifacts with `capture_from_requests`.

**Call relations**: The pre-turn auto parity test uses this helper for both modes.

*Call graph*: calls 7 internal fn (mount_sse_sequence, build_auto_harness, capture_from_requests, follow_up_index, mount_legacy_compact_if_needed, rollout_path, submit_user_input); called by 1 (remote_compaction_parity_pre_turn_auto); 1 external calls (vec!).


##### `run_mid_turn_auto_session`  (lines 396–444)

```
async fn run_mid_turn_auto_session(mode: Mode) -> Result<Capture>
```

**Purpose**: Runs a mid-turn automatic compaction scenario in one mode and captures the resulting artifacts.

**Data flow**: It chooses a response sequence based on mode, builds an auto-compaction harness, mounts normal responses and an optional legacy compact endpoint, submits one user input that triggers mid-turn compaction, and captures the artifacts with `capture_from_requests`.

**Call relations**: The mid-turn auto parity test uses this helper for both modes.

*Call graph*: calls 7 internal fn (mount_sse_sequence, build_auto_harness, capture_from_requests, follow_up_index, mount_legacy_compact_if_needed, rollout_path, submit_user_input); called by 1 (remote_compaction_parity_mid_turn_auto); 1 external calls (vec!).


##### `run_manual_hook_session`  (lines 446–487)

```
async fn run_manual_hook_session(mode: Mode) -> Result<Value>
```

**Purpose**: Runs a manual compact flow with pre/post compact hooks enabled and returns a normalized view of the hook log payloads.

**Data flow**: It builds a harness with hooks, mounts the normal response sequence and optional legacy compact endpoint, submits one user turn and `Op::Compact`, waits for completion, optionally asserts the legacy compact endpoint was called once, then reads and normalizes the pre/post hook log files into a JSON object.

**Call relations**: The manual hook parity test compares the outputs of this helper across modes.

*Call graph*: calls 7 internal fn (mount_sse_sequence, default, build_harness, hook_log_view, mount_legacy_compact_if_needed, submit_user_input, wait_for_turn_complete); called by 1 (remote_compaction_parity_manual_hooks); 3 external calls (assert_eq!, json!, vec!).


##### `build_auto_harness`  (lines 489–497)

```
async fn build_auto_harness(mode: Mode) -> Result<TestCodexHarness>
```

**Purpose**: Builds a parity harness configured with an automatic compaction limit.

**Data flow**: It delegates to `build_harness_inner` with default run settings, no hooks, and `auto_compact_limit = Some(200)`.

**Call relations**: The pre-turn and mid-turn auto parity runners use this convenience wrapper.

*Call graph*: calls 2 internal fn (default, build_harness_inner); called by 2 (run_mid_turn_auto_session, run_pre_turn_auto_session).


##### `build_harness`  (lines 499–501)

```
async fn build_harness(mode: Mode, settings: RunSettings, hooks: bool) -> Result<TestCodexHarness>
```

**Purpose**: Builds a parity harness for manual scenarios with caller-specified mode, run settings, and optional hooks.

**Data flow**: It forwards its arguments to `build_harness_inner` with no auto-compaction limit.

**Call relations**: Manual scenario and manual hook runners use this wrapper.

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

**Purpose**: Constructs the full `TestCodexHarness` used by parity tests, with fixed cwd, seeded global instructions, optional hooks, auth, service tier, and mode-specific feature flags.

**Data flow**: It creates the fixed workspace directory, starts from `test_codex()`, installs auth and a pre-build hook that writes `AGENTS.md`, optionally adds a hook-writing pre-build hook, then builds a harness whose config sets fixed cwd, developer instructions, optional fast service tier, optional auto-compact limit, trusts discovered hooks when requested, and disables `RemoteCompactionV2` in legacy mode.

**Call relations**: All parity scenario runners funnel through this function to ensure both modes start from the same deterministic environment.

*Call graph*: calls 2 internal fn (with_builder, test_codex); called by 2 (build_auto_harness, build_harness); 1 external calls (create_dir_all).


##### `rollout_path`  (lines 539–546)

```
fn rollout_path(harness: &TestCodexHarness) -> PathBuf
```

**Purpose**: Returns the rollout path for a built parity harness.

**Data flow**: It reads `harness.test().session_configured.rollout_path`, expects it to be present, and returns the `PathBuf`.

**Call relations**: Scenario runners use this path later when extracting replacement history from rollout.

*Call graph*: calls 1 internal fn (test); called by 3 (run_manual_session, run_mid_turn_auto_session, run_pre_turn_auto_session).


##### `mount_legacy_compact_if_needed`  (lines 548–559)

```
async fn mount_legacy_compact_if_needed(
    harness: &TestCodexHarness,
    mode: Mode,
) -> Option<ResponseMock>
```

**Purpose**: Mounts the legacy remote compact endpoint only when running in legacy mode.

**Data flow**: For `Legacy` it mounts `mount_compact_user_history_with_summary_once` on the harness server using the fixed `SUMMARY`; for `V2` it returns `None`.

**Call relations**: Scenario runners call this so the same capture logic can work for both modes.

*Call graph*: calls 2 internal fn (mount_compact_user_history_with_summary_once, server); called by 4 (run_manual_hook_session, run_manual_session, run_mid_turn_auto_session, run_pre_turn_auto_session).


##### `follow_up_index`  (lines 561–563)

```
fn follow_up_index(request_count: usize) -> usize
```

**Purpose**: Computes the index of the final follow-up request in a captured request list.

**Data flow**: It subtracts one from the request count and panics if the count is zero.

**Call relations**: Scenario runners use this when telling `capture_from_requests` which normal response request is the post-compaction follow-up.

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

**Purpose**: Collects the compact request body, follow-up request body, replacement history, and request counts after a scenario run.

**Data flow**: It reads all normal response requests from the `ResponseMock`, selects the follow-up request body by index, chooses the compact body either from the legacy compact mock or from the response request immediately before the follow-up in v2 mode, shuts down the codex and waits for `ShutdownComplete`, then parses replacement history from rollout and returns a `Capture` struct.

**Call relations**: All scenario runners end by calling this helper to produce the comparable artifacts used by parity assertions.

*Call graph*: calls 3 internal fn (submit, requests, replacement_history_from_rollout); called by 3 (run_manual_session, run_mid_turn_auto_session, run_pre_turn_auto_session); 2 external calls (wait_for_event, panic!).


##### `submit_user_input`  (lines 605–617)

```
async fn submit_user_input(codex: &codex_core::CodexThread, items: Vec<UserInput>) -> Result<()>
```

**Purpose**: Submits a `UserInput` op with the provided items and waits for turn completion.

**Data flow**: It wraps the items in `Op::UserInput` with default thread settings and empty optional fields, submits it to the codex thread, waits for turn completion via `wait_for_turn_complete`, and returns success.

**Call relations**: Scenario runners use this helper to keep turn submission and waiting consistent across all parity flows.

*Call graph*: calls 2 internal fn (submit, wait_for_turn_complete); called by 4 (run_manual_hook_session, run_manual_session, run_mid_turn_auto_session, run_pre_turn_auto_session); 1 external calls (default).


##### `wait_for_turn_complete`  (lines 619–621)

```
async fn wait_for_turn_complete(codex: &codex_core::CodexThread)
```

**Purpose**: Waits for a `TurnComplete` event on the codex thread.

**Data flow**: It calls `wait_for_event` with a predicate matching `EventMsg::TurnComplete(_)`.

**Call relations**: This is the simple completion wait used by `submit_user_input` and manual hook flows.

*Call graph*: called by 3 (run_manual_hook_session, run_manual_session, submit_user_input); 1 external calls (wait_for_event).


##### `user_input_for_step`  (lines 623–636)

```
fn user_input_for_step(scenario_name: &str, idx: usize, step: Step) -> Vec<UserInput>
```

**Purpose**: Builds the user input items corresponding to one scenario step, optionally including an image item.

**Data flow**: It starts with an empty vector, prepends a `UserInput::Image` when the step is `ImageAssistant`, then appends a `UserInput::Text` whose text encodes the scenario name, index, and step label.

**Call relations**: Manual scenario runners call this for each step so the transcript shape is deterministic and self-describing.

*Call graph*: called by 1 (run_manual_session); 3 external calls (new, format!, matches!).


##### `response_bodies_for_scenario`  (lines 638–645)

```
fn response_bodies_for_scenario(scenario: &Scenario) -> Vec<String>
```

**Purpose**: Expands a scenario’s step list into the full sequence of mocked SSE response bodies needed to drive it.

**Data flow**: It iterates the scenario steps with indices, calls `response_bodies_for_step` for each, and concatenates the resulting vectors.

**Call relations**: Manual scenario runners use this to mount the normal response sequence before adding compaction responses.

*Call graph*: called by 1 (run_manual_session).


##### `response_bodies_for_step`  (lines 647–722)

```
fn response_bodies_for_step(scenario_name: &str, idx: usize, step: Step) -> Vec<String>
```

**Purpose**: Builds the mocked SSE response body or bodies for one transcript step kind.

**Data flow**: It derives a stable response id from scenario name, index, and step label, then returns one or two SSE strings depending on the step: assistant-only, reasoning+assistant, function-tool plus follow-up assistant, shell-tool plus follow-up assistant, image assistant, or web-search call plus assistant.

**Call relations**: This is the transcript generator behind the manual scenario parity tests.

*Call graph*: 2 external calls (format!, vec!).


##### `compaction_v2_response_body`  (lines 724–735)

```
fn compaction_v2_response_body() -> String
```

**Purpose**: Builds the mocked SSE body for a v2 compaction response containing the fixed encrypted summary item.

**Data flow**: It returns an SSE string with one `response.output_item.done` event whose item is a `compaction` carrying `SUMMARY`, followed by completion.

**Call relations**: Manual and auto v2 scenario runners append this body to their normal response sequences.

*Call graph*: calls 1 internal fn (sse); called by 1 (run_manual_session); 1 external calls (vec!).


##### `after_compact_response_body`  (lines 737–745)

```
fn after_compact_response_body(scenario_name: &str) -> String
```

**Purpose**: Builds the mocked SSE body for the normal assistant reply after compaction.

**Data flow**: It returns an SSE string containing one assistant message whose text includes the scenario name plus `after compact reply`, followed by completion.

**Call relations**: Scenario runners append this as the final normal response after compaction.

*Call graph*: calls 1 internal fn (sse); called by 1 (run_manual_session); 1 external calls (vec!).


##### `compact_request_view`  (lines 747–767)

```
fn compact_request_view(body: &Value, mode: Mode) -> Value
```

**Purpose**: Normalizes a compact request body into the subset of fields relevant for parity comparison, stripping the v2 trigger item when present.

**Data flow**: It clones the request `input` array, pops and validates the trailing `{"type":"compaction_trigger"}` item in v2 mode, selects relevant top-level fields with `selected_request_fields`, replaces `input` with the normalized remaining array, and returns canonicalized JSON.

**Call relations**: Parity assertion helpers call this on both legacy and v2 compact requests before comparing them.

*Call graph*: calls 3 internal fn (canonical_json, normalize_value, selected_request_fields); called by 2 (assert_capture_eq, assert_compact_requests_eq_except_v2_service_tier); 3 external calls (Array, get, assert_eq!).


##### `follow_up_request_view`  (lines 769–777)

```
fn follow_up_request_view(body: &Value) -> Value
```

**Purpose**: Normalizes a post-compaction follow-up request body into the subset of fields relevant for parity comparison.

**Data flow**: It selects relevant top-level fields with `selected_request_fields`, inserts the normalized full `input` array, canonicalizes the result, and returns it.

**Call relations**: Parity assertion helpers use this to compare the post-compaction request shape across modes.

*Call graph*: calls 3 internal fn (canonical_json, normalize_value, selected_request_fields); called by 2 (assert_capture_eq, assert_follow_up_and_history_eq); 1 external calls (get).


##### `replacement_history_from_rollout`  (lines 779–804)

```
fn replacement_history_from_rollout(path: &Path) -> Result<Value>
```

**Purpose**: Extracts and normalizes the persisted replacement history from a rollout file after compaction.

**Data flow**: It reads the rollout file, parses non-empty lines as `RolloutLine`, finds a `RolloutItem::Compacted` with empty `message` and present `replacement_history`, serializes those items to `Value`, normalizes and canonicalizes the array, and returns it.

**Call relations**: Capture construction uses this helper so parity tests can compare persisted replacement history between modes.

*Call graph*: calls 2 internal fn (canonical_json, normalize_value); called by 1 (capture_from_requests); 2 external calls (Array, read_to_string).


##### `write_manual_compact_hooks`  (lines 806–834)

```
fn write_manual_compact_hooks(home: &Path)
```

**Purpose**: Writes pre/post manual compact hook scripts and a `hooks.json` file that registers them.

**Data flow**: It writes two Python scripts via `write_hook_script`, then writes a `hooks.json` file whose `PreCompact` and `PostCompact` entries both use matcher `manual` and invoke those scripts through `python_hook_command`.

**Call relations**: Hook parity runs install this fixture before building the harness.

*Call graph*: calls 1 internal fn (write_hook_script); 3 external calls (join, write, json!).


##### `write_hook_script`  (lines 836–849)

```
fn write_hook_script(script_path: &Path, log_path: &Path)
```

**Purpose**: Writes a Python hook script that logs its JSON stdin payload to a JSONL file with sorted keys.

**Data flow**: It formats a Python script string referencing the target log path and writes it to the given script path.

**Call relations**: The manual hook fixture uses this helper for both pre and post compact scripts.

*Call graph*: called by 1 (write_manual_compact_hooks); 2 external calls (format!, write).


##### `python_hook_command`  (lines 851–853)

```
fn python_hook_command(script_path: &Path) -> String
```

**Purpose**: Formats a shell command that runs a Python hook script by path.

**Data flow**: It returns `python3 "<script_path>"`.

**Call relations**: The hook fixture uses this when generating `hooks.json`.

*Call graph*: 1 external calls (format!).


##### `hook_log_view`  (lines 855–875)

```
fn hook_log_view(path: &Path) -> Result<Value>
```

**Purpose**: Reads a hook JSONL log and reduces each payload to the subset of fields relevant for parity comparison.

**Data flow**: It reads the file, parses each non-empty line as JSON, and maps each payload to an object containing `hook_event_name`, `trigger`, `model`, and booleans indicating presence of optional fields like `reason`, `phase`, `implementation`, `status`, and `error`.

**Call relations**: The manual hook parity test compares the outputs of this helper across legacy and v2 runs.

*Call graph*: called by 1 (run_manual_hook_session); 2 external calls (Array, read_to_string).


##### `selected_request_fields`  (lines 883–919)

```
fn selected_request_fields(body: &Value, mode: SelectedFieldsMode) -> Value
```

**Purpose**: Extracts the top-level request fields relevant for compact or follow-up parity comparison.

**Data flow**: It chooses a field allowlist based on `SelectedFieldsMode`, copies any present fields from the body into a new object after normalizing their values, and returns that object.

**Call relations**: Both `compact_request_view` and `follow_up_request_view` use this helper to ignore irrelevant or mode-specific request fields.

*Call graph*: calls 1 internal fn (normalize_value); called by 2 (compact_request_view, follow_up_request_view); 3 external calls (Object, get, new).


##### `normalize_value`  (lines 921–932)

```
fn normalize_value(value: Value) -> Value
```

**Purpose**: Recursively normalizes JSON values by rewriting unstable strings and descending into arrays/objects.

**Data flow**: It rewrites strings with `normalize_string`, maps arrays and objects recursively, and leaves null/bool/number unchanged.

**Call relations**: Request-view and replacement-history normalization all pass through this helper before canonical comparison.

*Call graph*: calls 1 internal fn (normalize_string); called by 4 (compact_request_view, follow_up_request_view, replacement_history_from_rollout, selected_request_fields); 3 external calls (Array, Object, String).


##### `normalize_string`  (lines 934–964)

```
fn normalize_string(value: &str) -> String
```

**Purpose**: Rewrites unstable string content such as UUIDs, temp skill paths, and shell wall times into deterministic placeholders.

**Data flow**: It first replaces UUID-like strings with `<UUID>`, then normalizes temp-path prefixes before `/skills/` or `\skills\` to `<CODEX_HOME>`, then scans for `Wall time: <number> seconds` substrings and replaces the numeric portion with `<WALL_TIME>`.

**Call relations**: This is the key string-normalization routine used by all parity comparisons and by the dedicated unit tests below.

*Call graph*: calls 2 internal fn (is_uuid_like, normalize_tmp_prefix_before_marker); called by 4 (normalize_string_rewrites_linux_temp_skill_paths, normalize_string_rewrites_shell_wall_times, normalize_string_rewrites_windows_temp_skill_paths, normalize_value).


##### `is_uuid_like`  (lines 966–974)

```
fn is_uuid_like(value: &str) -> bool
```

**Purpose**: Detects whether a string has the canonical 36-character hex-and-dash UUID shape.

**Data flow**: It checks length, dash positions, and that all other bytes are ASCII hex digits.

**Call relations**: String normalization uses this to collapse unstable ids to `<UUID>`.

*Call graph*: called by 1 (normalize_string).


##### `normalize_tmp_prefix_before_marker`  (lines 976–1004)

```
fn normalize_tmp_prefix_before_marker(text: &mut String, marker: &str)
```

**Purpose**: Rewrites OS-specific temporary home prefixes that appear before a skill-path marker to the placeholder `<CODEX_HOME>`.

**Data flow**: It repeatedly searches for the marker, looks backward for known Linux/macOS/Windows temp-directory prefixes, and when found replaces the prefix range before the marker with `<CODEX_HOME>`.

**Call relations**: This helper is called by `normalize_string` to stabilize skill-path references in request bodies and replacement history.

*Call graph*: called by 1 (normalize_string).


##### `normalize_string_rewrites_linux_temp_skill_paths`  (lines 1007–1018)

```
fn normalize_string_rewrites_linux_temp_skill_paths()
```

**Purpose**: Unit test proving Linux/macOS-style temp skill paths are normalized to `<CODEX_HOME>`.

**Data flow**: It passes a string containing `/tmp/.tmp.../skills/...` and `/private/tmp/.tmp.../skills/...` through `normalize_string` and asserts the expected rewritten output.

**Call relations**: This is a direct unit test for one branch of the string-normalization logic.

*Call graph*: calls 1 internal fn (normalize_string); 1 external calls (assert_eq!).


##### `normalize_string_rewrites_windows_temp_skill_paths`  (lines 1021–1032)

```
fn normalize_string_rewrites_windows_temp_skill_paths()
```

**Purpose**: Unit test proving Windows temp skill paths are normalized to `<CODEX_HOME>`.

**Data flow**: It normalizes a string containing both slash and backslash Windows temp skill paths and asserts the expected rewritten output.

**Call relations**: This is the Windows-path counterpart to the Linux temp-path normalization test.

*Call graph*: calls 1 internal fn (normalize_string); 1 external calls (assert_eq!).


##### `normalize_string_rewrites_shell_wall_times`  (lines 1035–1046)

```
fn normalize_string_rewrites_shell_wall_times()
```

**Purpose**: Unit test proving shell wall-time numbers are normalized to `<WALL_TIME>`.

**Data flow**: It normalizes a multiline shell-output string containing `Wall time: 0 seconds` and `Wall time: 0.1 seconds`, then asserts both numeric values were replaced.

**Call relations**: This is the unit test for the wall-time normalization branch.

*Call graph*: calls 1 internal fn (normalize_string); 1 external calls (assert_eq!).


##### `canonical_json`  (lines 1048–1063)

```
fn canonical_json(value: &Value) -> Value
```

**Purpose**: Recursively sorts object keys to produce canonical JSON for stable equality checks.

**Data flow**: It clones scalars, maps arrays recursively, and rebuilds objects from key-sorted entries.

**Call relations**: Request-view and replacement-history helpers use this after normalization to make comparisons deterministic.

*Call graph*: called by 3 (compact_request_view, follow_up_request_view, replacement_history_from_rollout); 3 external calls (Array, Object, clone).


##### `remove_object_field`  (lines 1065–1069)

```
fn remove_object_field(value: &mut Value, field: &str)
```

**Purpose**: Removes a named field from a JSON object value if it is an object.

**Data flow**: It pattern-matches on `Value::Object` and deletes the requested key.

**Call relations**: The API-key service-tier parity test uses this to ignore the intentional v2-only `service_tier` field.

*Call graph*: called by 1 (assert_compact_requests_eq_except_v2_service_tier).


##### `assert_json_eq`  (lines 1071–1075)

```
fn assert_json_eq(label: &str, left: &Value, right: &Value)
```

**Purpose**: Asserts two JSON values are equal and, if not, panics with the first structural difference.

**Data flow**: It compares the two `Value`s and, on inequality, panics with a message built from `first_json_diff(left, right, "$")`.

**Call relations**: All parity assertions ultimately use this helper so failures point to the first meaningful mismatch.

*Call graph*: called by 4 (assert_capture_eq, assert_compact_requests_eq_except_v2_service_tier, assert_follow_up_and_history_eq, remote_compaction_parity_manual_hooks); 1 external calls (panic!).


##### `first_json_diff`  (lines 1077–1131)

```
fn first_json_diff(left: &Value, right: &Value, path: &str) -> String
```

**Purpose**: Computes a human-readable description of the first structural difference between two JSON values.

**Data flow**: It recursively descends through objects and arrays, tracking a JSON-path-like string, and returns a formatted message describing the first differing field, missing key, array length mismatch, or scalar mismatch.

**Call relations**: This is the diagnostic engine behind `assert_json_eq`.

*Call graph*: 1 external calls (format!).


##### `short_json`  (lines 1133–1142)

```
fn short_json(value: &Value) -> String
```

**Purpose**: Serializes a JSON value to a bounded-length string for diff messages.

**Data flow**: It converts the value to JSON text and either returns it whole if short enough or truncates it to 1000 characters with a suffix indicating total length.

**Call relations**: `first_json_diff` uses this helper when formatting mismatch messages.

*Call graph*: 2 external calls (format!, to_string).


##### `compact_input_len`  (lines 1144–1154)

```
fn compact_input_len(body: &Value, mode: Mode) -> usize
```

**Purpose**: Returns the effective number of compact-input items, discounting the v2 `compaction_trigger` item.

**Data flow**: It reads the `input` array length from the body and, in v2 mode, subtracts one with saturation; legacy returns the full length.

**Call relations**: `assert_capture_eq` uses this only for its summary `println!` diagnostics.

*Call graph*: 1 external calls (get).


##### `follow_up_input_len`  (lines 1156–1161)

```
fn follow_up_input_len(body: &Value) -> usize
```

**Purpose**: Returns the number of input items in a follow-up request body.

**Data flow**: It reads `body["input"]` as an array and returns its length or zero if absent.

**Call relations**: This is another diagnostic helper used in the parity summary printout.

*Call graph*: 1 external calls (get).


##### `replacement_history_len`  (lines 1163–1165)

```
fn replacement_history_len(body: &Value) -> usize
```

**Purpose**: Returns the number of items in a normalized replacement-history JSON array.

**Data flow**: It reads the value as an array and returns its length or zero if it is not an array.

**Call relations**: This helper is used only in the parity summary printout emitted by `assert_capture_eq`.

*Call graph*: 1 external calls (as_array).


### `core/tests/suite/compact_resume_fork.rs`

`test` · `request handling`

This file is a focused integration suite for lifecycle operations on compacted conversations. It drives a `CodexThread` through combinations of user turns, manual compaction, shutdown/resume from rollout, forking from an earlier user-message boundary, and rollback. The helper layer starts deterministic test conversations against a mock SSE server, submits user turns and `Op::Compact`, resumes threads through `ThreadManager::resume_thread_from_rollout`, forks them with `ThreadManager::fork_thread`, gathers captured request bodies, normalizes line endings and compact prompts, and extracts user-role message text from raw request JSON.

The main assertions are about model-visible history slices. After compaction, the next request should contain the original user turn plus a summary-bearing user message and the new user input. After resume, that compacted prefix should still be present, and after fork the preserved compacted history should remain while later branch-specific turns diverge. A second compaction on the forked branch should then become the new prefix for a later resume. Rollback tests cover two subtleties: rolling back behind a compaction should replay append-only history from rollout while removing the rolled-back post-compaction turn, and rolling back a turn that introduced persistent pre-thread context diffs should trim those context updates so the next request includes them only once. The file therefore validates not just that resume/fork/rollback succeed, but that they reconstruct the exact prompt history the model should see.

#### Function details

##### `network_disabled`  (lines 48–50)

```
fn network_disabled() -> bool
```

**Purpose**: Checks whether the sandbox has disabled network access for spawned conversations.

**Data flow**: It reads the `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR` environment variable and returns true if it is present.

**Call relations**: Each top-level test uses this helper to skip itself when the sandboxed environment cannot support the networked integration flow.

*Call graph*: called by 4 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view, snapshot_rollback_followup_turn_trims_context_updates, snapshot_rollback_past_compaction_replays_append_only_history); 1 external calls (var).


##### `body_contains_text`  (lines 52–54)

```
fn body_contains_text(body: &str, text: &str) -> bool
```

**Purpose**: Checks whether a serialized request body contains a target text fragment in JSON-escaped form.

**Data flow**: It converts the target text to a JSON fragment with `json_fragment` and tests whether the body string contains it.

**Call relations**: Request-matching helpers use this when mounting compact-response mocks based on prompt content.

*Call graph*: calls 1 internal fn (json_fragment).


##### `json_fragment`  (lines 56–61)

```
fn json_fragment(text: &str) -> String
```

**Purpose**: Converts plain text into the escaped fragment that would appear inside a JSON string.

**Data flow**: It serializes the text with `serde_json::to_string`, strips the surrounding quotes, and returns the inner escaped content.

**Call relations**: This helper exists to support `body_contains_text` and request matchers.

*Call graph*: called by 1 (body_contains_text); 1 external calls (to_string).


##### `normalize_line_endings_str`  (lines 63–69)

```
fn normalize_line_endings_str(text: &str) -> String
```

**Purpose**: Normalizes CRLF or CR line endings to LF in a string.

**Data flow**: If the input contains `\r`, it replaces `\r\n` and bare `\r` with `\n`; otherwise it returns the original text as an owned string.

**Call relations**: Compact-prompt normalization uses this helper so prompt comparisons are stable across platforms.

*Call graph*: called by 1 (normalize_compact_prompts).


##### `extract_summary_user_text`  (lines 71–76)

```
fn extract_summary_user_text(request: &Value, summary_text: &str) -> String
```

**Purpose**: Finds the user-message text in a request that contains a given summary string.

**Data flow**: It extracts all user message texts from the request JSON via `json_message_input_texts`, finds the first one containing the target summary text, and returns it.

**Call relations**: The resume/fork tests use this helper to capture the exact summary-bearing user message inserted by compaction.

*Call graph*: calls 1 internal fn (json_message_input_texts); called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view).


##### `json_message_input_texts`  (lines 78–97)

```
fn json_message_input_texts(request: &Value, role: &str) -> Vec<String>
```

**Purpose**: Extracts all first text spans from message items of a given role in a raw request JSON body.

**Data flow**: It reads `request["input"]` as an array, filters to `type == "message"` and the requested role, takes the first content entry’s `text` field, and returns the collected strings.

**Call relations**: Most history-shape assertions in this file use this helper to compare user-visible prompt text across requests.

*Call graph*: called by 3 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view, extract_summary_user_text); 1 external calls (get).


##### `normalize_compact_prompts`  (lines 99–124)

```
fn normalize_compact_prompts(requests: &mut [Value])
```

**Purpose**: Removes empty user messages and summarization-prompt user messages from captured request bodies so later comparisons focus on durable history rather than compaction triggers.

**Data flow**: It normalizes the canonical summarization prompt’s line endings, then mutates each request’s `input` array in place, retaining only non-empty user messages whose normalized text is not equal to the summarization prompt.

**Call relations**: The main resume/fork tests call this before comparing request histories, because compact-trigger prompts are transient implementation details.

*Call graph*: calls 1 internal fn (normalize_line_endings_str); called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view).


##### `compact_resume_and_fork_preserve_model_history_view`  (lines 129–280)

```
async fn compact_resume_and_fork_preserve_model_history_view()
```

**Purpose**: Drives a conversation through compact, shutdown/resume, and fork, then verifies the model-visible user-history prefixes at each stage.

**Data flow**: It starts a mocked conversation, runs `hello world`, manual compact, and `AFTER_COMPACT`, records the rollout path, shuts down, resumes and submits `AFTER_RESUME`, records the resumed path, forks from the second user message and submits `AFTER_FORK`, gathers and normalizes request bodies, then compares the compact/resume/fork request inputs and expected user-text prefixes including the summary-bearing user message and any seeded user prefix.

**Call relations**: This is the foundational lifecycle-history test in the file, using nearly every helper: conversation startup, compaction, resume, fork, request gathering, and summary extraction.

*Call graph*: calls 13 internal fn (compact_conversation, extract_summary_user_text, fetch_conversation_path, fork_thread, gather_request_bodies, json_message_input_texts, mount_initial_flow, network_disabled, normalize_compact_prompts, resume_conversation (+3 more)); 6 external calls (start, assert!, assert_eq!, json!, println!, vec!).


##### `compact_resume_after_second_compaction_preserves_history`  (lines 285–417)

```
async fn compact_resume_after_second_compaction_preserves_history() -> Result<()>
```

**Purpose**: Verifies that after a forked branch is compacted a second time, a later resume reuses that newer compacted history and appends only the new user message.

**Data flow**: It runs an initial compact/resume/fork flow, adds `AFTER_FORK`, compacts the forked branch again, adds `AFTER_COMPACT_2`, shuts down, resumes again, submits `AFTER_SECOND_RESUME`, then normalizes captured requests and asserts the final resumed request begins with either the full second-compaction history prefix or the local fork prefix, followed only by whole repeats of any seeded user prefix and the final user message.

**Call relations**: This extends the first lifecycle test by adding a second compaction and second resume, proving that the latest compacted branch state becomes the new persisted history base.

*Call graph*: calls 12 internal fn (compact_conversation, extract_summary_user_text, fetch_conversation_path, fork_thread, json_message_input_texts, mount_second_compact_sequence, network_disabled, normalize_compact_prompts, resume_conversation, shutdown_conversation (+2 more)); 7 external calls (start, assert!, assert_eq!, json!, panic!, println!, vec!).


##### `snapshot_rollback_past_compaction_replays_append_only_history`  (lines 423–507)

```
async fn snapshot_rollback_past_compaction_replays_append_only_history() -> Result<()>
```

**Purpose**: Checks that rolling back a post-compaction turn removes that turn while preserving the earlier compacted history and replaying append-only rollout state correctly.

**Data flow**: It runs `hello world`, manual compact, and `EDITED_AFTER_COMPACT`, submits `Op::ThreadRollback { num_turns: 1 }`, waits for `ThreadRolledBack`, submits `AFTER_ROLLBACK`, then inspects the four captured requests to assert the compact request contained the summarization prompt, the pre-rollback request contained the original user, summary, and edited turn, and the post-rollback request still contains the original user and summary but not the edited turn, finally snapshotting the relevant requests.

**Call relations**: This is the rollback-behind-compaction regression test, focused on replayed model-visible history after rollback.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, compact_conversation, network_disabled, start_test_conversation, user_turn); 8 external calls (start, assert!, assert_eq!, wait_for_event, assert_snapshot!, panic!, println!, vec!).


##### `snapshot_rollback_followup_turn_trims_context_updates`  (lines 513–636)

```
async fn snapshot_rollback_followup_turn_trims_context_updates() -> Result<()>
```

**Purpose**: Verifies that rolling back a turn which introduced persistent pre-thread context diffs trims those updates so the next request includes them only once.

**Data flow**: It starts a conversation, runs one user turn, submits thread settings that change environment cwd and collaboration developer instructions, runs a second user turn, rolls back one turn, waits for `ThreadRolledBack`, submits a follow-up user turn, then inspects the rolled-back and follow-up requests to assert the developer instruction and cwd diff each appear exactly once and that the follow-up request ends with the new user text, finally snapshotting both requests.

**Call relations**: This test targets rollback interaction with persisted context-diff state rather than compaction summaries themselves.

*Call graph*: calls 5 internal fn (mount_sse_sequence, local_selections, network_disabled, start_test_conversation, user_turn); 10 external calls (default, start, assert_eq!, submit_thread_settings, wait_for_event, assert_snapshot!, panic!, println!, create_dir_all, vec!).


##### `normalize_line_endings`  (lines 638–655)

```
fn normalize_line_endings(value: &mut Value)
```

**Purpose**: Recursively normalizes CRLF/CR line endings to LF inside a mutable JSON value.

**Data flow**: It pattern-matches on strings, arrays, and objects; rewrites string contents when they contain `\r`; and recurses into nested arrays and object values.

**Call relations**: Request-gathering helpers call this so cross-platform line-ending differences do not affect history comparisons.


##### `gather_requests`  (lines 657–662)

```
fn gather_requests(request_log: &[ResponseMock]) -> Vec<ResponsesRequest>
```

**Purpose**: Flattens a slice of `ResponseMock` values into a single vector of captured `ResponsesRequest`s.

**Data flow**: It iterates the mocks, calls `ResponseMock::requests` on each, and collects all requests into one vector.

**Call relations**: The request-body gathering helper uses this to combine per-mock captures into one ordered request list.

*Call graph*: called by 1 (gather_request_bodies); 1 external calls (iter).


##### `gather_request_bodies`  (lines 664–671)

```
fn gather_request_bodies(request_log: &[ResponseMock]) -> Vec<Value>
```

**Purpose**: Collects and line-ending-normalizes the JSON bodies of all captured requests from a set of response mocks.

**Data flow**: It calls `gather_requests`, maps each request to `body_json()`, then mutates each body with `normalize_line_endings` before returning the vector.

**Call relations**: The main compact/resume/fork test uses this helper before stripping compact prompts and comparing request histories.

*Call graph*: calls 1 internal fn (gather_requests); called by 1 (compact_resume_and_fork_preserve_model_history_view).


##### `mount_initial_flow`  (lines 673–726)

```
async fn mount_initial_flow(server: &MockServer) -> Vec<ResponseMock>
```

**Purpose**: Mounts request-matched SSE mocks for the initial compact/resume/fork scenario so each expected request shape gets the intended response.

**Data flow**: It builds five SSE bodies, then mounts them with `mount_sse_once_match` using body-content predicates that distinguish the first turn, compact request, after-compact turn, after-resume turn, and after-fork turn, returning the resulting `ResponseMock`s in order.

**Call relations**: The first lifecycle test uses this helper to avoid ambiguous request capture when multiple requests share the same endpoint.

*Call graph*: calls 2 internal fn (mount_sse_once_match, sse); called by 1 (compact_resume_and_fork_preserve_model_history_view); 1 external calls (vec!).


##### `mount_second_compact_sequence`  (lines 728–751)

```
async fn mount_second_compact_sequence(server: &MockServer) -> ResponseMock
```

**Purpose**: Mounts a single ordered SSE sequence for the second-compaction/resume scenario.

**Data flow**: It builds eight SSE bodies covering the initial turn, first compact, after-compact turn, after-resume turn, after-fork turn, second compact, after-second-compact turn, and final resumed turn, then mounts them as one sequence and returns the `ResponseMock`.

**Call relations**: The second lifecycle test uses this simpler sequence-based fixture because it only needs ordered capture, not per-request matching.

*Call graph*: calls 2 internal fn (mount_sse_sequence, sse); called by 1 (compact_resume_after_second_compaction_preserves_history); 1 external calls (vec!).


##### `start_test_conversation`  (lines 753–771)

```
async fn start_test_conversation(
    server: &MockServer,
    model: Option<&str>,
) -> (Arc<TempDir>, Config, Arc<ThreadManager>, Arc<CodexThread>)
```

**Purpose**: Builds a new test conversation against the mock server, optionally pinning a model and always installing the summarization prompt.

**Data flow**: It formats the server `/v1` base URL, creates a `test_codex` builder whose config points the model provider at that URL, sets `compact_prompt` to `SUMMARIZATION_PROMPT`, optionally sets `config.model`, builds the harness, and returns the home dir, config, thread manager, and codex thread.

**Call relations**: All top-level tests use this helper to start a deterministic conversation before driving compaction, resume, fork, or rollback.

*Call graph*: calls 1 internal fn (test_codex); called by 4 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view, snapshot_rollback_followup_turn_trims_context_updates, snapshot_rollback_past_compaction_replays_append_only_history); 2 external calls (pin, format!).


##### `user_turn`  (lines 773–788)

```
async fn user_turn(conversation: &Arc<CodexThread>, text: &str)
```

**Purpose**: Submits a simple text-only user turn and waits for completion.

**Data flow**: It wraps the provided text in `Op::UserInput` with default thread settings and empty optional fields, submits it to the conversation, and waits for `TurnComplete`.

**Call relations**: All lifecycle tests use this helper for ordinary user turns.

*Call graph*: called by 4 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view, snapshot_rollback_followup_turn_trims_context_updates, snapshot_rollback_past_compaction_replays_append_only_history); 3 external calls (default, wait_for_event, vec!).


##### `compact_conversation`  (lines 790–807)

```
async fn compact_conversation(conversation: &Arc<CodexThread>)
```

**Purpose**: Runs manual compaction on a conversation and asserts the standard compact warning is emitted before turn completion.

**Data flow**: It submits `Op::Compact`, waits for a `Warning` event whose message equals `COMPACT_WARNING_MESSAGE`, asserts that message, then waits for `TurnComplete`.

**Call relations**: Lifecycle tests call this helper whenever they need a manual compaction step and want the warning semantics checked too.

*Call graph*: called by 3 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view, snapshot_rollback_past_compaction_replays_append_only_history); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `fetch_conversation_path`  (lines 809–811)

```
fn fetch_conversation_path(conversation: &Arc<CodexThread>) -> std::path::PathBuf
```

**Purpose**: Returns the rollout path for a conversation thread.

**Data flow**: It calls `conversation.rollout_path()` and expects a `PathBuf` to be present.

**Call relations**: Resume and fork flows use this helper to capture the persisted conversation path after a given stage.

*Call graph*: called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view).


##### `shutdown_conversation`  (lines 813–818)

```
async fn shutdown_conversation(conversation: &Arc<CodexThread>)
```

**Purpose**: Shuts down a conversation thread and waits for completion.

**Data flow**: It calls `shutdown_and_wait()` on the conversation and expects success.

**Call relations**: Resume-based tests use this helper before reopening a thread from rollout.

*Call graph*: called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view).


##### `resume_conversation`  (lines 820–837)

```
async fn resume_conversation(
    manager: &ThreadManager,
    config: &Config,
    path: std::path::PathBuf,
) -> Arc<CodexThread>
```

**Purpose**: Resumes a conversation thread from a rollout file using the existing `ThreadManager` and config.

**Data flow**: It builds an auth manager from a dummy API key, calls `manager.resume_thread_from_rollout(config.clone(), path, auth_manager, None)`, awaits the result, and returns the resumed thread.

**Call relations**: The compact/resume and second-resume tests use this helper to reopen persisted conversations.

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

**Purpose**: Forks a conversation thread from the nth user-message boundary in a rollout file.

**Data flow**: It calls `manager.fork_thread(nth_user_message, config.clone(), path, None, None)`, awaits the result, and returns the forked thread.

**Call relations**: The lifecycle tests use this helper to create a branch from an earlier point in the compacted conversation history.

*Call graph*: calls 1 internal fn (fork_thread); called by 2 (compact_resume_after_second_compaction_preserves_history, compact_resume_and_fork_preserve_model_history_view); 2 external calls (pin, clone).


### Pending turn continuity
These tests cover in-flight input replay and the resumed-session initialization details that preserve or warn about conversation state.

### `core/tests/suite/pending_input.rs`

`test` · `mid-turn input injection, follow-up scheduling, and compaction handling`

This module uses a streaming SSE test server to precisely gate when model events arrive and when Codex is allowed to continue. A set of helpers builds synthetic SSE chunks, submits ordinary or full-access user turns, injects steering input with `steer_input`, queues inter-agent mail without triggering an immediate turn, and waits for specific runtime events such as reasoning-item start, sleep-item start/completion, agent messages, and turn completion. Additional JSON helpers inspect captured `/responses` bodies by extracting user message texts or `function_call_output` payloads.

The tests cover several interruption policies. `wait_agent` and `sleep` tool calls should be interrupted by new input, and the follow-up request must include both the original and new user prompts plus an interruption output for the tool call. In contrast, once a reasoning item or commentary message has started, queued mail or steered user input should wait until the current model continuation finishes, producing a later follow-up request rather than preempting mid-item. Snapshot-based assertions compare the first and second request inputs for these cases. The final group of tests explores auto-compaction: when a turn exceeds `model_auto_compact_token_limit`, steered input must remain pending through the compaction request and, if necessary, through the post-compact continuation request, only appearing in the subsequent request that actually handles the new prompt. One ignored test documents a flaky delta-driven follow-up scenario.

#### Function details

##### `ev_message_item_done`  (lines 41–51)

```
fn ev_message_item_done(id: &str, text: &str) -> Value
```

**Purpose**: Builds a synthetic `response.output_item.done` assistant-message event with a single `output_text` content span. It is used in streaming SSE fixtures where the tests need explicit control over message completion.

**Data flow**: Inputs are a message id and final text. The function returns a JSON `Value` representing a completed assistant message item with the given id and text.

**Call relations**: Several streaming tests embed this helper’s output inside chunk sequences instead of relying on higher-level canned response builders.

*Call graph*: 1 external calls (json!).


##### `sse_event`  (lines 53–55)

```
fn sse_event(event: Value) -> String
```

**Purpose**: Wraps a single JSON event into an SSE-formatted string body. It is a convenience helper for chunk definitions that contain exactly one event.

**Data flow**: Input is a `serde_json::Value` event. The function places it in a one-element vector, passes it to `responses::sse`, and returns the resulting SSE string.

**Call relations**: The ignored delta-follow-up test uses this helper when constructing manual `StreamingSseChunk` values.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `message_input_texts`  (lines 57–69)

```
fn message_input_texts(body: &Value, role: &str) -> Vec<String>
```

**Purpose**: Extracts all `input_text` strings for a given message role from a captured `/responses` JSON body. It lets tests assert exactly which user prompts were replayed into follow-up requests.

**Data flow**: Inputs are a parsed request body and a role string. The function walks `body["input"]` as an array, filters items of type `message` with the matching role, descends into `content`, keeps spans of type `input_text`, collects their `text` strings, and returns them as `Vec<String>`.

**Call relations**: Many top-level tests call this helper when comparing first, second, third, or post-compact requests to see whether pending input has been included yet.

*Call graph*: called by 6 (any_new_input_interrupts_sleep, injected_user_input_triggers_follow_up_request_with_deltas, steer_interrupts_wait_agent_and_is_sent_in_follow_up_request, steered_user_input_follows_compact_when_only_the_steer_needs_follow_up, steered_user_input_waits_for_model_continuation_after_mid_turn_compact, steered_user_input_waits_when_tool_output_triggers_compact_before_next_request); 1 external calls (get).


##### `function_call_output_text`  (lines 71–81)

```
fn function_call_output_text(body: &'a Value, call_id: &str) -> Option<&'a str>
```

**Purpose**: Finds the output text associated with a specific `function_call_output` item in a captured request body. It is used to inspect interruption outputs for `wait_agent` and `sleep` calls.

**Data flow**: Inputs are a parsed request body and a call id. The function scans `body["input"]` for an item with `type == "function_call_output"` and matching `call_id`, then returns its `output` string as `Option<&str>`.

**Call relations**: The wait-agent and sleep interruption tests call this helper to validate the exact tool-output payload replayed into the follow-up request.

*Call graph*: called by 2 (any_new_input_interrupts_sleep, steer_interrupts_wait_agent_and_is_sent_in_follow_up_request); 1 external calls (get).


##### `assert_interrupted_sleep_output`  (lines 83–97)

```
fn assert_interrupted_sleep_output(output: Option<&str>)
```

**Purpose**: Validates the textual output produced when a `sleep` tool call is interrupted by new input. It checks both the fixed suffix and that the reported wall time parses as a floating-point number.

**Data flow**: Input is an optional output string. The function panics if absent, strips the expected `Wall time: ` prefix and ` seconds\nSleep interrupted by new input.` suffix, parses the remaining substring as `f64`, and asserts parsing succeeds.

**Call relations**: Only `any_new_input_interrupts_sleep` uses this helper after extracting `function_call_output_text` from follow-up requests.

*Call graph*: called by 1 (any_new_input_interrupts_sleep); 2 external calls (assert!, panic!).


##### `chunk`  (lines 99–104)

```
fn chunk(event: Value) -> StreamingSseChunk
```

**Purpose**: Creates an ungated `StreamingSseChunk` containing a single SSE event. It is the basic building block for deterministic streaming sequences.

**Data flow**: Input is a JSON event. The function wraps it with `responses::sse(vec![event])`, sets `gate: None`, and returns the `StreamingSseChunk`.

**Call relations**: Most streaming tests use this helper to define their event sequences compactly.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `gated_chunk`  (lines 106–111)

```
fn gated_chunk(gate: oneshot::Receiver<()>, events: Vec<Value>) -> StreamingSseChunk
```

**Purpose**: Creates a `StreamingSseChunk` whose delivery is blocked on a oneshot receiver. This lets tests pause a stream at a precise point until they inject pending input.

**Data flow**: Inputs are a `oneshot::Receiver<()>` gate and a vector of JSON events. The function SSE-encodes the events, stores the receiver in `gate: Some(...)`, and returns the chunk.

**Call relations**: Tests that need to inject input after reasoning starts, after commentary begins, or before completion use this helper to hold back the rest of the stream.

*Call graph*: calls 1 internal fn (sse).


##### `response_completed_chunks`  (lines 113–118)

```
fn response_completed_chunks(response_id: &str) -> Vec<StreamingSseChunk>
```

**Purpose**: Builds a minimal two-chunk response consisting of `response.created` followed by `response.completed`. It is used for simple follow-up requests that only need to terminate cleanly.

**Data flow**: Input is a response id string. The function returns a two-element vector containing `chunk(ev_response_created(response_id))` and `chunk(ev_completed(response_id))`.

**Call relations**: Several tests append this helper’s output as the final follow-up response after a more complex first streamed turn.

*Call graph*: 1 external calls (vec!).


##### `build_codex`  (lines 120–127)

```
async fn build_codex(server: &StreamingSseServer) -> Arc<CodexThread>
```

**Purpose**: Constructs a streaming-server-backed `CodexThread` configured with model `gpt-5.4`. It is a small async helper for tests that do not need custom config.

**Data flow**: Input is a `StreamingSseServer`. The function builds a `TestCodex` with `.with_model("gpt-5.4")`, attaches it to the streaming server, unwraps the build result, and returns the inner `Arc<CodexThread>`.

**Call relations**: Three tests that focus on pending-input scheduling rather than config details call this helper instead of repeating the builder boilerplate.

*Call graph*: calls 1 internal fn (test_codex); called by 3 (queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, queued_inter_agent_mail_triggers_follow_up_after_reasoning_item, user_input_does_not_preempt_after_reasoning_item).


##### `submit_user_input`  (lines 129–143)

```
async fn submit_user_input(codex: &CodexThread, text: &str)
```

**Purpose**: Submits a plain text `Op::UserInput` with default thread settings to a `CodexThread`. It is the standard way these tests start or continue a turn.

**Data flow**: Inputs are the codex handle and a text string. The function constructs `Op::UserInput` with one `UserInput::Text`, default `additional_context`, default `thread_settings`, and no schema/metadata, submits it asynchronously, and panics on failure.

**Call relations**: Most top-level tests call this helper for initial prompts and, in some cases, for a second prompt that should become pending input.

*Call graph*: calls 1 internal fn (submit); called by 7 (any_new_input_interrupts_sleep, queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, queued_inter_agent_mail_triggers_follow_up_after_reasoning_item, steer_interrupts_wait_agent_and_is_sent_in_follow_up_request, steered_user_input_follows_compact_when_only_the_steer_needs_follow_up, steered_user_input_waits_for_model_continuation_after_mid_turn_compact, user_input_does_not_preempt_after_reasoning_item); 2 external calls (default, vec!).


##### `submit_danger_full_access_user_turn`  (lines 145–175)

```
async fn submit_danger_full_access_user_turn(test: &TestCodex, text: &str)
```

**Purpose**: Submits a text user turn with full-access permissions (`PermissionProfile::Disabled`) and explicit local environment/collaboration overrides. It is used when a test needs shell-command execution to proceed and potentially trigger compaction.

**Data flow**: Inputs are a `TestCodex` and prompt text. The function derives sandbox and permission fields from `turn_permission_fields(PermissionProfile::Disabled, test.config.cwd.as_path())`, builds `ThreadSettingsOverrides` with local environment selections, `AskForApproval::Never`, and collaboration settings using the session model, then submits the resulting `Op::UserInput`.

**Call relations**: Only the tool-output-compaction test uses this helper because that scenario needs a permissive shell-command turn rather than the default restricted one.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 1 (steered_user_input_waits_when_tool_output_triggers_compact_before_next_request); 2 external calls (default, vec!).


##### `steer_user_input`  (lines 177–191)

```
async fn steer_user_input(codex: &CodexThread, text: &str)
```

**Purpose**: Injects steering input into an in-progress turn using `CodexThread::steer_input`. This is the mechanism under test for pending user input that should be replayed later.

**Data flow**: Inputs are the codex handle and steering text. The function calls `steer_input` with a one-element `UserInput::Text` vector, default additional context, no expected turn id, no client user message id, and no client metadata, then panics on failure.

**Call relations**: Tests covering wait interruption, sleep interruption, non-preemption after reasoning, and compaction all use this helper to create pending user input mid-turn.

*Call graph*: calls 1 internal fn (steer_input); called by 5 (any_new_input_interrupts_sleep, steer_interrupts_wait_agent_and_is_sent_in_follow_up_request, steered_user_input_follows_compact_when_only_the_steer_needs_follow_up, steered_user_input_waits_when_tool_output_triggers_compact_before_next_request, user_input_does_not_preempt_after_reasoning_item); 2 external calls (default, vec!).


##### `submit_queue_only_agent_mail`  (lines 193–214)

```
async fn submit_queue_only_agent_mail(codex: &CodexThread, text: &str)
```

**Purpose**: Queues inter-agent communication without immediately triggering a turn, then uses a list-voices request as a barrier to ensure the mail has been processed. This lets tests inject non-user pending input deterministically.

**Data flow**: Inputs are the codex handle and message text. The function submits `Op::InterAgentCommunication` containing `InterAgentCommunication::new(AgentPath::try_from("/root/worker"), AgentPath::root(), Vec::new(), text, false)`, then submits `Op::RealtimeConversationListVoices` and waits for `RealtimeConversationListVoicesResponse` before returning.

**Call relations**: Sleep interruption and queued-mail follow-up tests call this helper to enqueue mailbox input at a precise point in the turn lifecycle.

*Call graph*: calls 4 internal fn (submit, root, try_from, new); called by 3 (any_new_input_interrupts_sleep, queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, queued_inter_agent_mail_triggers_follow_up_after_reasoning_item); 2 external calls (new, wait_for_event).


##### `wait_for_reasoning_item_started`  (lines 216–225)

```
async fn wait_for_reasoning_item_started(codex: &CodexThread)
```

**Purpose**: Blocks until the runtime emits `EventMsg::ItemStarted` for a `TurnItem::Reasoning`. It marks the point after which some pending-input scenarios should no longer preempt the current turn.

**Data flow**: Input is the codex handle. The function waits for an event matching `ItemStarted` whose embedded item is `TurnItem::Reasoning(_)`, then returns once such an event arrives.

**Call relations**: The queued-mail-after-reasoning and user-input-no-preempt-after-reasoning tests use this helper to inject pending input at the intended boundary.

*Call graph*: called by 2 (queued_inter_agent_mail_triggers_follow_up_after_reasoning_item, user_input_does_not_preempt_after_reasoning_item); 1 external calls (wait_for_event).


##### `wait_for_agent_message`  (lines 227–234)

```
async fn wait_for_agent_message(codex: &CodexThread, text: &str)
```

**Purpose**: Waits for a final `EventMsg::AgentMessage` carrying a specific text and asserts the matched event is indeed an agent message. It is used to synchronize on visible assistant output before checking follow-up behavior.

**Data flow**: Inputs are the codex handle and expected message text. The function waits for an event matching `EventMsg::AgentMessage(message) if message.message == text`, then asserts the returned event variant and returns unit.

**Call relations**: Several tests use this helper to ensure the original turn’s visible answer has landed before asserting whether pending input caused an extra request.

*Call graph*: called by 4 (queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, steered_user_input_follows_compact_when_only_the_steer_needs_follow_up, steered_user_input_waits_for_model_continuation_after_mid_turn_compact, user_input_does_not_preempt_after_reasoning_item); 2 external calls (assert!, wait_for_event).


##### `wait_for_turn_complete`  (lines 236–238)

```
async fn wait_for_turn_complete(codex: &CodexThread)
```

**Purpose**: Waits until the current turn emits `EventMsg::TurnComplete`. It is a small synchronization helper used throughout the file.

**Data flow**: Input is the codex handle. The function delegates to `wait_for_event` with a predicate matching `EventMsg::TurnComplete(_)` and returns once the event arrives.

**Call relations**: Most top-level tests call this helper after injecting pending input and releasing any stream gates.

*Call graph*: called by 8 (any_new_input_interrupts_sleep, queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, queued_inter_agent_mail_triggers_follow_up_after_reasoning_item, steer_interrupts_wait_agent_and_is_sent_in_follow_up_request, steered_user_input_follows_compact_when_only_the_steer_needs_follow_up, steered_user_input_waits_for_model_continuation_after_mid_turn_compact, steered_user_input_waits_when_tool_output_triggers_compact_before_next_request, user_input_does_not_preempt_after_reasoning_item); 1 external calls (wait_for_event).


##### `wait_for_sleep_item_started`  (lines 240–262)

```
async fn wait_for_sleep_item_started(codex: &CodexThread, call_id: &str, duration_ms: u64)
```

**Purpose**: Waits for a specific `SleepItem` to start and asserts both its call id and duration. This confirms the runtime recognized the mocked `sleep` tool call as a sleep turn item.

**Data flow**: Inputs are the codex handle, expected call id, and expected duration in milliseconds. The function waits for `EventMsg::ItemStarted` whose item is `TurnItem::Sleep` with the matching id, destructures the event, and asserts equality with `SleepItem { id, duration_ms }`.

**Call relations**: Only the sleep interruption test uses this helper, twice, to observe both the first and second sleep calls.

*Call graph*: called by 1 (any_new_input_interrupts_sleep); 3 external calls (assert_eq!, wait_for_event, unreachable!).


##### `wait_for_sleep_item_completed`  (lines 264–286)

```
async fn wait_for_sleep_item_completed(codex: &CodexThread, call_id: &str, duration_ms: u64)
```

**Purpose**: Waits for a specific `SleepItem` completion and asserts its id and duration. It is used to prove that new input interrupts sleep and causes the sleep item to complete early.

**Data flow**: Inputs are the codex handle, expected call id, and expected duration. The function waits for `EventMsg::ItemCompleted` whose item is `TurnItem::Sleep` with the matching id, destructures the event, and asserts equality with the expected `SleepItem`.

**Call relations**: The sleep interruption test calls this helper after steering input and after queued agent mail to verify both sleep calls were interrupted and completed.

*Call graph*: called by 1 (any_new_input_interrupts_sleep); 3 external calls (assert_eq!, wait_for_event, unreachable!).


##### `steer_interrupts_wait_agent_and_is_sent_in_follow_up_request`  (lines 289–348)

```
async fn steer_interrupts_wait_agent_and_is_sent_in_follow_up_request()
```

**Purpose**: Verifies that steering input interrupts an in-progress `wait_agent` tool call and is included in the follow-up `/responses` request alongside the original prompt. The interrupted wait must also be replayed as a `function_call_output` explaining the interruption.

**Data flow**: The test starts a streaming server whose first response emits `wait_agent` and whose second is a minimal completion, builds a session with `Feature::MultiAgentV2` enabled, submits the initial prompt, waits for `CollabWaitingBegin`, injects steering input, waits for turn completion, and inspects the two captured requests. It asserts the second request contains both the initial and steering prompts in user input and that the `wait_agent` output parses to `{ "message": "Wait interrupted by new input.", "timed_out": false }`.

**Call relations**: This top-level test uses `submit_user_input`, `steer_user_input`, `wait_for_turn_complete`, `message_input_texts`, and `function_call_output_text` to validate the interruption path end to end.

*Call graph*: calls 7 internal fn (start_streaming_sse_server, test_codex, function_call_output_text, message_input_texts, steer_user_input, submit_user_input, wait_for_turn_complete); 4 external calls (assert_eq!, wait_for_event, from_slice, vec!).


##### `any_new_input_interrupts_sleep`  (lines 351–456)

```
async fn any_new_input_interrupts_sleep()
```

**Purpose**: Checks that both steered user input and queued inter-agent mail interrupt `sleep` tool calls, producing follow-up requests with interrupted sleep outputs. It also verifies the completed sleep items are persisted in rollout history.

**Data flow**: The test streams two consecutive `sleep` tool calls followed by a final completion, builds a session with `Feature::SleepTool` enabled, submits the initial prompt, waits for the first sleep to start, injects steering input, waits for the first sleep to complete and the second to start, queues agent mail, waits for the second sleep to complete and the turn to finish, then inspects three captured requests. It asserts the second request contains both prompts and an interrupted output for the first sleep, the third request contains an interrupted output for the second sleep, then shuts down the session, reads the rollout file, filters persisted `EventMsg::ItemCompleted` sleep items, and asserts both sleep items were recorded.

**Call relations**: This is the most comprehensive sleep test, combining `submit_user_input`, `steer_user_input`, `submit_queue_only_agent_mail`, sleep-item wait helpers, request-body inspection helpers, and rollout-file parsing.

*Call graph*: calls 11 internal fn (start_streaming_sse_server, test_codex, assert_interrupted_sleep_output, function_call_output_text, message_input_texts, steer_user_input, submit_queue_only_agent_mail, submit_user_input, wait_for_sleep_item_completed, wait_for_sleep_item_started (+1 more)); 6 external calls (assert_eq!, wait_for_event, json!, from_slice, read_to_string, vec!).


##### `assert_two_responses_input_snapshot`  (lines 458–480)

```
fn assert_two_responses_input_snapshot(snapshot_name: &str, requests: &[Vec<u8>])
```

**Purpose**: Formats and snapshots only the `input` arrays from exactly two captured `/responses` requests, using the suite’s redacted context-snapshot renderer. It is a reusable assertion helper for pending-input follow-up scenarios.

**Data flow**: Inputs are a snapshot name and a slice of raw request bodies. The function asserts there are exactly two requests, builds `ContextSnapshotOptions::default().strip_capability_instructions()`, parses both bodies as JSON, clones each request’s `input` array, formats them with `context_snapshot::format_labeled_items_snapshot`, and snapshots the resulting string.

**Call relations**: Three top-level tests call this helper after producing exactly two requests, allowing them to compare request inputs without hand-writing many field assertions.

*Call graph*: calls 2 internal fn (default, format_labeled_items_snapshot); called by 3 (queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item, queued_inter_agent_mail_triggers_follow_up_after_reasoning_item, user_input_does_not_preempt_after_reasoning_item); 3 external calls (assert_eq!, assert_snapshot!, from_slice).


##### `injected_user_input_triggers_follow_up_request_with_deltas`  (lines 484–587)

```
async fn injected_user_input_triggers_follow_up_request_with_deltas()
```

**Purpose**: Documents a flaky scenario where a second user input arrives after output deltas but before the first response completes, and should trigger a follow-up request containing both prompts. The test is currently ignored.

**Data flow**: The test builds a gated first stream that emits response creation, message-added, output deltas, and message completion before holding `ev_completed`, plus a second minimal response. It submits `first prompt`, waits for an `AgentMessageContentDelta`, submits `second prompt`, releases the completion gate, waits for `TurnComplete`, and inspects both requests. Assertions require the first request to contain only `first prompt` and the second to contain both prompts.

**Call relations**: Although ignored, this test uses the low-level `sse_event` helper and direct `Op::UserInput` submissions to probe a narrow timing window around delta streaming.

*Call graph*: calls 3 internal fn (start_streaming_sse_server, test_codex, message_input_texts); 7 external calls (default, assert!, assert_eq!, wait_for_event, channel, from_slice, vec!).


##### `queued_inter_agent_mail_triggers_follow_up_after_reasoning_item`  (lines 590–632)

```
async fn queued_inter_agent_mail_triggers_follow_up_after_reasoning_item()
```

**Purpose**: Verifies that queued inter-agent mail arriving after a reasoning item has started does not preempt the current turn immediately, but instead causes a later follow-up request. The stale remainder of the first stream should not become the active continuation.

**Data flow**: The test gates the remainder of a first response after `ev_reasoning_item_added`, then appends stale reasoning completion, a stale tool call, stale message output, and completion. It builds a codex session, submits `first prompt`, waits for reasoning to start, queues agent mail, releases the gate, waits for turn completion, and snapshots the two request inputs with `assert_two_responses_input_snapshot`.

**Call relations**: It uses `build_codex`, `submit_user_input`, `wait_for_reasoning_item_started`, `submit_queue_only_agent_mail`, and the snapshot helper to capture the non-preemptive scheduling behavior.

*Call graph*: calls 7 internal fn (start_streaming_sse_server, assert_two_responses_input_snapshot, build_codex, submit_queue_only_agent_mail, submit_user_input, wait_for_reasoning_item_started, wait_for_turn_complete); 2 external calls (channel, vec!).


##### `queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item`  (lines 635–696)

```
async fn queued_inter_agent_mail_triggers_follow_up_after_commentary_message_item()
```

**Purpose**: Checks the analogous behavior for commentary messages: queued inter-agent mail after an assistant commentary item has started should wait for that message to finish and then trigger a follow-up request. This guards another non-preemption boundary.

**Data flow**: The test gates the remainder of a first response after `ev_message_item_added`, then emits output delta, a completed commentary-phase message, stale tool/message output, and completion. It submits `first prompt`, waits for `ItemStarted` on `TurnItem::AgentMessage`, queues agent mail, releases the gate, waits for the visible `first answer` and turn completion, then snapshots the two request inputs.

**Call relations**: It is the commentary-phase counterpart to the reasoning-item test and uses `wait_for_agent_message` in addition to the shared helpers.

*Call graph*: calls 7 internal fn (start_streaming_sse_server, assert_two_responses_input_snapshot, build_codex, submit_queue_only_agent_mail, submit_user_input, wait_for_agent_message, wait_for_turn_complete); 3 external calls (wait_for_event, channel, vec!).


##### `user_input_does_not_preempt_after_reasoning_item`  (lines 699–746)

```
async fn user_input_does_not_preempt_after_reasoning_item()
```

**Purpose**: Verifies that steered user input arriving after a reasoning item has started does not preempt the current turn. The original turn should finish first, and the new prompt should be handled in a later follow-up request.

**Data flow**: The test gates the remainder of a first response after `ev_reasoning_item_added`, then emits reasoning completion, a preserved tool call, a final assistant message, and completion. It submits `first prompt`, waits for reasoning start, injects `second prompt` via steering, releases the gate, waits for `first answer` and turn completion, and snapshots the two request inputs.

**Call relations**: This test mirrors the queued-mail-after-reasoning case but uses `steer_user_input` instead of inter-agent mail to validate the same scheduling rule for user-originated pending input.

*Call graph*: calls 8 internal fn (start_streaming_sse_server, assert_two_responses_input_snapshot, build_codex, steer_user_input, submit_user_input, wait_for_agent_message, wait_for_reasoning_item_started, wait_for_turn_complete); 2 external calls (channel, vec!).


##### `steered_user_input_waits_for_model_continuation_after_mid_turn_compact`  (lines 749–839)

```
async fn steered_user_input_waits_for_model_continuation_after_mid_turn_compact()
```

**Purpose**: Checks that when a turn triggers auto-compaction mid-turn and the model still has continuation work to do afterward, steered input remains pending through both the compaction request and the post-compact continuation request. It should only appear in the subsequent request dedicated to the steered prompt.

**Data flow**: The test streams four responses: an initial tool-call turn ending with 500 tokens, an auto-compact summary response, a post-compact continuation producing `resumed old task`, and a final steered follow-up producing `processed steered prompt`. It builds a session with `model_auto_compact_token_limit = Some(200)` and non-websocket provider settings, submits `first prompt` and then `second prompt`, waits for `resumed old task` and turn completion, and inspects requests 3 and 4. It asserts the post-compact continuation request does not contain `second prompt`, while the final steered request does.

**Call relations**: This top-level test uses `submit_user_input`, `wait_for_agent_message`, `wait_for_turn_complete`, and `message_input_texts` to validate pending-input ordering across compaction boundaries.

*Call graph*: calls 6 internal fn (start_streaming_sse_server, test_codex, message_input_texts, submit_user_input, wait_for_agent_message, wait_for_turn_complete); 4 external calls (assert!, assert_eq!, from_slice, vec!).


##### `steered_user_input_follows_compact_when_only_the_steer_needs_follow_up`  (lines 842–926)

```
async fn steered_user_input_follows_compact_when_only_the_steer_needs_follow_up()
```

**Purpose**: Verifies that if the model has already finished its original work and only compaction remains, steered input should follow immediately after compaction without an extra empty resume request. The steered prompt must not be included in the compaction request itself.

**Data flow**: The test gates the completion of an initial answered turn that exceeds the compact threshold, then streams a compact summary response and a final steered follow-up response. After submitting `first prompt`, waiting for `first answer`, steering `second prompt`, and releasing the completion gate, it waits for `processed steered prompt` and turn completion. It then asserts there are three requests total, that the compact request omits `second prompt`, and that the steered request includes it.

**Call relations**: This is the simpler compaction case where no post-compact continuation is needed. It complements the previous test by proving Codex does not insert an unnecessary intermediate request.

*Call graph*: calls 7 internal fn (start_streaming_sse_server, test_codex, message_input_texts, steer_user_input, submit_user_input, wait_for_agent_message, wait_for_turn_complete); 5 external calls (assert!, assert_eq!, channel, from_slice, vec!).


##### `steered_user_input_waits_when_tool_output_triggers_compact_before_next_request`  (lines 929–1051)

```
async fn steered_user_input_waits_when_tool_output_triggers_compact_before_next_request()
```

**Purpose**: Checks that steered input also stays pending when compaction is triggered by large tool output before the next request. The prompt must be absent from both the compaction request and the post-compact continuation request, appearing only afterward.

**Data flow**: The test builds a shell-command call whose output is large enough to force compaction, gates the first response completion, then streams a compact summary, a post-compact continuation message, and a final steered follow-up. It builds a session with compaction enabled and permissive shell-command turn settings, submits `first prompt`, waits for `TurnStarted`, injects `second prompt`, releases the gate, waits for turn completion, and inspects requests 2, 3, and 4. Assertions require `second prompt` to be absent from the compact and post-compact requests and present in the final steered request.

**Call relations**: This test combines `submit_danger_full_access_user_turn`, `steer_user_input`, `wait_for_turn_complete`, and `message_input_texts` to cover the tool-output-driven compaction path rather than token growth from ordinary model output.

*Call graph*: calls 6 internal fn (start_streaming_sse_server, test_codex, message_input_texts, steer_user_input, submit_danger_full_access_user_turn, wait_for_turn_complete); 8 external calls (assert!, assert_eq!, cfg!, wait_for_event, json!, channel, from_slice, vec!).


### `core/tests/suite/resume.rs`

`test` · `resume`

This file drives resume behavior through `TestCodexBuilder::resume`, using real rollout files produced by an initial session and then repeatedly reopening them until the reconstructed `session_configured.initial_messages` stabilize. The polling helper `resume_until_initial_messages` exists because rollout ingestion is asynchronous; it repeatedly resumes the same rollout path, checks the current `initial_messages` slice against a caller-supplied predicate, and times out after two seconds with the last observed message dump.

The first two tests seed a normal turn against a mock SSE server, then resume and assert the exact event sequence reconstructed from rollout history. One case verifies user text plus `TextElement` annotations and assistant output become `TurnStarted`, `UserMessage`, `AgentMessage`, `TokenCount`, and `TurnComplete`. The reasoning case enables `show_raw_agent_reasoning` and checks that summarized and raw reasoning events are preserved as `AgentReasoning` and `AgentReasoningRawContent` before the assistant message. The remaining tests cover model changes on resume: switching from one configured model to another must preserve the original `instructions` text sent to the API, inject a `<model_switch>` developer message on the first resumed turn, and avoid duplicating that marker on later turns or when a pre-turn thread-settings override changes the model again.

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

**Purpose**: Polls repeated resume attempts until the resumed session exposes an `initial_messages` slice matching a caller-defined shape.

**Data flow**: It takes a mutable `TestCodexBuilder`, mock server reference, shared temp home, rollout path, and predicate over `&[EventMsg]`. Inside a loop it calls `builder.resume(...)`, reads `resumed.session_configured.initial_messages`, returns the resumed fixture immediately if the predicate passes, otherwise stores a formatted debug snapshot, drops the fixture, sleeps 10 ms, and retries until a 2-second deadline, after which it panics with the last observed messages.

**Call relations**: The two initial-message reconstruction tests call this helper after completing an initial turn. It sits between those tests and `TestCodexBuilder::resume`, absorbing eventual-consistency timing so the assertions can target the final stabilized event sequence.

*Call graph*: calls 1 internal fn (resume); called by 2 (resume_includes_initial_messages_from_reasoning_events, resume_includes_initial_messages_from_rollout_events); 8 external calls (clone, from_millis, from_secs, clone, format!, panic!, now, sleep).


##### `resume_includes_initial_messages_from_rollout_events`  (lines 61–146)

```
async fn resume_includes_initial_messages_from_rollout_events() -> Result<()>
```

**Purpose**: Checks that a resumed session reconstructs the prior turn's user and assistant messages, including text-element annotations, from rollout events.

**Data flow**: It builds an initial fixture, captures its `codex`, `home`, and `rollout_path`, mounts an SSE stream that emits response-created, assistant-message, and completed events, submits a `UserInput::Text` carrying both plain text and a `Vec<TextElement>`, waits for turn completion, then calls `resume_until_initial_messages` with a predicate matching a five-event sequence. After resume, it destructures the resulting `initial_messages` slice and asserts the user message text and `text_elements`, assistant message text, matching turn IDs, and `last_agent_message` contents.

**Call relations**: This test is invoked directly by the runner and uses `resume_until_initial_messages` to wait for rollout replay to settle. It depends on the initial live turn to populate the rollout file and then validates the resume path's event reconstruction logic.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, resume_until_initial_messages); 7 external calls (clone, default, assert_eq!, wait_for_event, panic!, skip_if_no_network!, vec!).


##### `resume_includes_initial_messages_from_reasoning_events`  (lines 149–237)

```
async fn resume_includes_initial_messages_from_reasoning_events() -> Result<()>
```

**Purpose**: Verifies that resumed sessions preserve both summarized and raw reasoning events when raw reasoning display is enabled.

**Data flow**: It builds an initial fixture with `config.show_raw_agent_reasoning = true`, mounts an SSE stream containing response-created, a reasoning item with summarized and raw text, an assistant message, and completion, submits a text user turn, waits for completion, then resumes repeatedly until `initial_messages` matches a seven-event sequence including `AgentReasoning` and `AgentReasoningRawContent`. It then pattern-matches the slice and asserts the user text, summarized reasoning text, raw reasoning text, assistant message, and turn-complete linkage.

**Call relations**: Like the rollout-events test, this one uses `resume_until_initial_messages` to tolerate asynchronous rollout ingestion. Its distinguishing dependency is the reasoning SSE payload and the config flag that causes raw reasoning content to be surfaced and therefore expected during resume.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, resume_until_initial_messages); 7 external calls (clone, default, assert_eq!, wait_for_event, panic!, skip_if_no_network!, vec!).


##### `resume_switches_models_preserves_base_instructions`  (lines 240–369)

```
async fn resume_switches_models_preserves_base_instructions() -> Result<()>
```

**Purpose**: Ensures that resuming under a different configured model keeps the original base instructions while adding only one model-switch developer message across subsequent resumed turns.

**Data flow**: It starts an initial session configured with model `gpt-5.2`, runs one turn, captures the first request body, and extracts its `instructions` string. It then mounts two resumed SSE responses, creates a new builder configured with `gpt-5.3-codex`, resumes from the saved rollout, submits two post-resume user turns, waits for each to complete, and inspects both resumed requests. The assertions require two requests total, identical `instructions_text()` on both requests matching the original instructions, at least one `<model_switch>` developer message on the first resumed turn, and exactly one such message on the second turn.

**Call relations**: This test drives the full resume path without the polling helper because it is validating outbound request composition rather than reconstructed initial messages. It compares the initial request captured before resume with the resumed requests captured after the model change.

*Call graph*: calls 5 internal fn (mount_sse_once, mount_sse_sequence, sse, start_mock_server, test_codex); 7 external calls (clone, default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `resume_model_switch_is_not_duplicated_after_pre_turn_override`  (lines 372–461)

```
async fn resume_model_switch_is_not_duplicated_after_pre_turn_override() -> Result<()>
```

**Purpose**: Checks that applying a thread-settings model override before the first resumed turn does not cause duplicate `<model_switch>` developer messages.

**Data flow**: It creates an initial session on `gpt-5.2`, completes one turn to seed rollout state, resumes with a builder configured for `gpt-5.3-codex`, submits `ThreadSettingsOverrides { model: Some("gpt-5.4"), .. }` to the resumed conversation, then submits the first resumed user turn and waits for completion. Finally it inspects the single resumed request's developer-role input texts and counts entries containing `<model_switch>`, asserting the count is exactly one.

**Call relations**: This test extends the model-switch scenario by inserting `submit_thread_settings` before the first resumed turn. It verifies that resume-time model-switch bookkeeping and explicit pre-turn overrides collapse into one developer notice instead of stacking multiple notices.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (clone, default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/resume_warning.rs`

`test` · `resume`

This file is a focused regression test for model-mismatch warnings during resume. The helper `resume_history` fabricates an `InitialHistory::Resumed` value containing a minimal but coherent rollout: `TurnStarted`, `UserMessage`, a `TurnContextItem` populated from the current config but with a caller-supplied previous model string, and `TurnComplete`. The turn context preserves important execution fields such as cwd, approval policy, sandbox policy, reasoning effort, and reasoning summary so the resumed history looks like a real prior turn.

The test itself creates an isolated temp home, loads the default test config, sets `config.model` to `current-model`, and writes an empty rollout placeholder file whose path is embedded into the resumed history. It then constructs a thread manager and auth manager directly from codex-core test support and calls `resume_thread_with_history`. Instead of submitting a turn, it waits immediately for an `EventMsg::Warning` whose message mentions both `previous-model` and `current-model`, proving the warning is emitted during thread initialization. A short sleep at the end drains the initialization window so background tasks do not leak into later tests.

#### Function details

##### `resume_history`  (lines 22–80)

```
fn resume_history(
    config: &codex_core::config::Config,
    previous_model: &str,
    rollout_path: &std::path::Path,
) -> InitialHistory
```

**Purpose**: Builds a minimal `InitialHistory::Resumed` payload that simulates a prior completed turn recorded under a different model.

**Data flow**: It takes the current `Config`, a `previous_model` string, and a rollout path. It synthesizes a fixed turn ID, constructs a `TurnContextItem` using config-derived cwd, approval and sandbox policies, reasoning effort, and reasoning summary but substitutes `previous_model` into the `model` field, then wraps a vector of `RolloutItem`s—`TurnStarted`, `UserMessage`, `TurnContext`, and `TurnComplete`—inside `ResumedHistory` with a default `ThreadId` and the provided rollout path.

**Call relations**: The sole test in this file calls it during setup to bypass real rollout parsing and feed `resume_thread_with_history` a controlled history. That lets the test isolate the model-mismatch warning logic from unrelated resume machinery.

*Call graph*: calls 1 internal fn (default); called by 1 (emits_warning_when_resumed_model_differs); 4 external calls (to_path_buf, legacy_sandbox_policy, Resumed, vec!).


##### `emits_warning_when_resumed_model_differs`  (lines 83–135)

```
async fn emits_warning_when_resumed_model_differs()
```

**Purpose**: Verifies that resuming a conversation whose recorded prior model differs from the current config emits a warning naming both models.

**Data flow**: It creates a temp home, loads default config, sets `config.model` to `current-model`, asserts cwd is absolute, creates an empty rollout file, builds `initial_history` via `resume_history(..., "previous-model", ...)`, constructs a thread manager and auth manager from API-key auth, resumes the thread with history, then waits for a `WarningEvent` whose message contains both model names. After destructuring and reasserting the message contents, it sleeps 50 ms to let initialization-related completion/shutdown activity settle.

**Call relations**: This is the top-level test entrypoint for the file. It delegates history fabrication to `resume_history`, then directly exercises `thread_manager.resume_thread_with_history` and `wait_for_event` to observe the initialization-time warning.

*Call graph*: calls 4 internal fn (auth_manager_from_auth, thread_manager_with_models_provider, resume_history, from_api_key); 8 external calls (from_millis, new, assert!, load_default_config_for_test, wait_for_event, panic!, write, sleep).


### Fork and window lineage
These files verify how persisted history supports thread forking and how request window identifiers evolve across compaction, resume, and fork.

### `core/tests/suite/fork_thread.rs`

`test` · `history persistence / thread management`

This file exercises Codex thread-history persistence rather than tool execution. Both tests create a mock `/v1/responses` endpoint that immediately completes turns, then submit user inputs through a `TestCodex` instance so rollout files are materialized on disk. The helper `read_rollout_items` reads a rollout JSONL file line by line, skips blank lines and `RolloutItem::SessionMeta`, parses each remaining line through `serde_json::Value` into `RolloutLine`, and returns the contained `RolloutItem`s. In `fork_thread_twice_drops_to_first_message`, the test sends three user messages, reads the base rollout, identifies user-message boundaries by scanning `RolloutItem::ResponseItem` entries and passing them through `parse_turn_item`, then computes expected prefixes by truncating strictly before the nth user input. It calls `thread_manager.fork_thread` twice with `ForkSnapshot::TruncateBeforeNthUserMessage`, first from the base rollout and then from the first fork’s rollout, and compares the resulting rollout contents to the expected prefixes via JSON equality. The second test proves `fork_thread_from_history` can reconstruct a new thread from `InitialHistory::Resumed(ResumedHistory { history, rollout_path: None, ... })` without needing the source rollout path; it only asserts that the forked rollout begins with the supplied source history. The subtle invariant is that forking operates on persisted history content, not just live in-memory thread state.

#### Function details

##### `fork_thread_twice_drops_to_first_message`  (lines 25–149)

```
async fn fork_thread_twice_drops_to_first_message()
```

**Purpose**: Verifies that repeated truncation-based forks progressively remove later user turns from rollout history. The first fork drops everything from the second user message onward, and the second fork drops the remaining last user message.

**Data flow**: After the network guard, it starts a mock server whose `/v1/responses` endpoint returns a minimal SSE completion and expects three calls. It builds a test conversation, clones `codex`, `thread_manager`, and config, submits three `Op::UserInput` turns (`first`, `second`, `third`) and waits for `TurnComplete` after each, then reads the base rollout path and parses its items with `read_rollout_items`. It computes user-input positions by scanning parsed items and using `parse_turn_item` to detect `TurnItem::UserMessage`, slices the base items before the second user input to form `expected_after_first`, forks with `ForkSnapshot::TruncateBeforeNthUserMessage(1)`, reads the forked rollout, and asserts JSON equality. It then computes the last user-input boundary within fork1, forks again with `TruncateBeforeNthUserMessage(0)`, reads fork2’s rollout, and asserts it equals the prefix before that last remaining user input.

**Call relations**: This harness test drives the full flow from live conversation to persisted rollout to `thread_manager.fork_thread`. It depends on `read_rollout_items` to turn rollout files back into comparable structured history.

*Call graph*: calls 3 internal fn (sse, test_codex, read_rollout_items); 11 external calls (default, given, start, new, TruncateBeforeNthUserMessage, wait_for_event, assert_eq!, skip_if_no_network!, vec!, method (+1 more)).


##### `fork_thread_from_history_does_not_require_source_rollout_path`  (lines 152–222)

```
async fn fork_thread_from_history_does_not_require_source_rollout_path()
```

**Purpose**: Checks that a new thread can be forked from explicit stored history even when the source `ResumedHistory` omits `rollout_path`. The resulting rollout should begin with the supplied history items.

**Data flow**: It starts a mock server expecting one completed response, builds a test conversation, submits one `Op::UserInput` turn, waits for `TurnComplete`, reads the source rollout path and parses its items with `read_rollout_items`, then calls `thread_manager.fork_thread_from_history` with `ForkSnapshot::Interrupted`, cloned config, and `InitialHistory::Resumed(ResumedHistory { conversation_id, history: source_items.clone(), rollout_path: None })`. After obtaining the forked thread, it reads the forked rollout, converts both source and forked items to `serde_json::Value`, and asserts that the forked sequence starts with the supplied source sequence.

**Call relations**: This test is invoked by the harness and uses `read_rollout_items` both before and after `fork_thread_from_history` to prove that the API can reconstruct a thread from serialized history alone.

*Call graph*: calls 3 internal fn (sse, test_codex, read_rollout_items); 11 external calls (default, given, start, new, assert!, wait_for_event, Resumed, skip_if_no_network!, vec!, method (+1 more)).


##### `read_rollout_items`  (lines 224–242)

```
fn read_rollout_items(path: &std::path::Path) -> Vec<RolloutItem>
```

**Purpose**: Parses a rollout JSONL file into a vector of non-session metadata `RolloutItem`s. It is a test-side reader for persisted conversation history.

**Data flow**: Accepts a filesystem `Path`, reads the entire file to string, iterates over lines, skips empty or whitespace-only lines, parses each remaining line first as `serde_json::Value` and then as `RolloutLine`, discards `RolloutItem::SessionMeta(_)`, pushes every other `RolloutItem` into a `Vec`, and returns that vector. Parsing and I/O failures panic with path- or line-specific messages.

**Call relations**: Both forking tests call this helper whenever they need to inspect rollout files produced by the runtime. It is the only local utility that translates persisted rollout text back into structured items for assertions.

*Call graph*: called by 2 (fork_thread_from_history_does_not_require_source_rollout_path, fork_thread_twice_drops_to_first_message); 5 external calls (new, format!, from_str, from_value, read_to_string).


### `core/tests/suite/window_headers.rs`

`test` · `request handling / persistence-resume regression testing`

This test file drives a real `CodexThread` against a mock SSE-backed model server and inspects the outbound model requests captured by `mount_sse_sequence`. The main test configures a non-OpenAI provider plus `SUMMARIZATION_PROMPT` so `Op::Compact` is enabled, then performs a sequence of turns: one normal user turn, one compact turn, another user turn, shutdown, resume from the persisted rollout path, another user turn, then a fork from snapshot 0 followed by one more user turn. The mock server returns five responses in order, matching those five model requests.

The assertions focus on the `x-codex-window-id` header format and semantics. `window_id_parts` parses the header into a thread identifier and numeric generation by splitting on the final `:`. The test confirms that the first normal turn and the compact request both use generation 0 on the original thread id; the first post-compact turn advances to generation 1; resuming the thread preserves both the original thread id and generation 1; and forking produces a different thread id with generation reset to 0. Helper functions encapsulate the event choreography for user input, compaction, and shutdown, including waiting for `TurnComplete`, checking that compaction emits the expected `WarningEvent`, and waiting for `ShutdownComplete` before proceeding.

#### Function details

##### `window_id_advances_after_compact_persists_on_resume_and_resets_on_fork`  (lines 22–100)

```
async fn window_id_advances_after_compact_persists_on_resume_and_resets_on_fork() -> Result<()>
```

**Purpose**: Builds an end-to-end thread lifecycle around compaction, persistence, resume, and fork, then asserts the exact window-id header behavior on each captured model request. It is the regression test that ties together mock transport setup, thread operations, and header parsing.

**Data flow**: It starts by creating a mock server and mounting five SSE response sequences, then builds a test Codex instance with compaction enabled and extracts the configured rollout path. It submits turns to the initial thread, shuts it down, resumes from the saved home and rollout path, submits another turn, forks from the resumed thread manager, submits a final turn on the fork, and shuts each thread down. Finally it reads the recorded `ResponsesRequest` list, parses each `x-codex-window-id` header via `window_id_parts`, and asserts thread-id equality/inequality and generation values.

**Call relations**: As the top-level async test, it invokes all local helpers: `submit_user_turn` for ordinary prompts, `submit_compact_turn` for the compaction operation, `shutdown_thread` before ending each thread lifecycle, and `window_id_parts` when validating captured requests. It also drives external test support utilities to stand up the mock SSE server and to build/resume/fork Codex threads under the conditions being verified.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, shutdown_thread, submit_compact_turn, submit_user_turn, window_id_parts); 5 external calls (clone, assert_eq!, assert_ne!, skip_if_no_network!, vec!).


##### `submit_user_turn`  (lines 102–117)

```
async fn submit_user_turn(codex: &Arc<CodexThread>, text: &str) -> Result<()>
```

**Purpose**: Submits a single text-only `Op::UserInput` turn to a `CodexThread` and waits until that turn fully completes. It packages the exact request shape used by this test so the main scenario stays readable.

**Data flow**: It takes an `Arc<CodexThread>` and a `&str` prompt, constructs `Op::UserInput` with one `UserInput::Text` item, empty `text_elements`, no output schema or client metadata, and default additional context and thread settings. After awaiting `codex.submit(...)`, it waits for an `EventMsg::TurnComplete(_)` and returns `Ok(())` once the turn has finished.

**Call relations**: It is called repeatedly by `window_id_advances_after_compact_persists_on_resume_and_resets_on_fork` for the initial, post-compact, resumed, and forked user turns. It delegates completion detection to the shared `wait_for_event` test helper so the caller can assume the model request corresponding to that turn has already been issued and processed.

*Call graph*: called by 1 (window_id_advances_after_compact_persists_on_resume_and_resets_on_fork); 3 external calls (default, wait_for_event, vec!).


##### `submit_compact_turn`  (lines 119–128)

```
async fn submit_compact_turn(codex: &Arc<CodexThread>) -> Result<()>
```

**Purpose**: Triggers `Op::Compact`, verifies that the thread emits the expected compact warning message, and then waits for the compact turn to finish. This captures the special event sequence associated with compaction rather than a normal user turn.

**Data flow**: It takes an `Arc<CodexThread>`, submits `Op::Compact`, waits for the first matching `EventMsg::Warning(_)`, destructures it as `WarningEvent { message }`, and asserts that the message equals `COMPACT_WARNING_MESSAGE`. It then waits for `EventMsg::TurnComplete(_)` and returns `Ok(())`.

**Call relations**: It is only invoked by `window_id_advances_after_compact_persists_on_resume_and_resets_on_fork` at the point where the test wants the thread to summarize/compact history. Internally it relies on `wait_for_event` twice because compaction is expected to emit both a warning and a terminal completion event, and it panics if the first matched warning event is not structurally what the test expects.

*Call graph*: called by 1 (window_id_advances_after_compact_persists_on_resume_and_resets_on_fork); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `shutdown_thread`  (lines 130–134)

```
async fn shutdown_thread(codex: &Arc<CodexThread>) -> Result<()>
```

**Purpose**: Gracefully shuts down a `CodexThread` and blocks until the shutdown completion event arrives. It ensures the thread has flushed and persisted state before resume or test teardown continues.

**Data flow**: It accepts an `Arc<CodexThread>`, submits `Op::Shutdown`, waits for `EventMsg::ShutdownComplete`, and returns `Ok(())`. It does not transform data beyond sequencing the shutdown request and completion acknowledgment.

**Call relations**: The main lifecycle test calls it after the initial thread, after the resumed thread, and after the forked thread. It delegates the synchronization point to `wait_for_event`, making shutdown deterministic before subsequent resume/fork assertions inspect persisted behavior.

*Call graph*: called by 1 (window_id_advances_after_compact_persists_on_resume_and_resets_on_fork); 1 external calls (wait_for_event).


##### `window_id_parts`  (lines 136–147)

```
fn window_id_parts(request: &ResponsesRequest) -> (String, u64)
```

**Purpose**: Extracts the logical thread id and numeric generation from a captured `x-codex-window-id` request header. It codifies the header format expected by the test: `<thread_id>:<generation>`.

**Data flow**: It reads the `x-codex-window-id` header from a `ResponsesRequest`, fails immediately if the header is missing, splits on the last colon with `rsplit_once`, parses the suffix as `u64`, and returns `(String, u64)`. The function performs validation at each step with `expect`, so malformed headers abort the test with a targeted message.

**Call relations**: It is called by `window_id_advances_after_compact_persists_on_resume_and_resets_on_fork` for each of the five captured model requests. Its sole role in the flow is to turn raw request metadata into comparable values for the generation/thread-id assertions.

*Call graph*: calls 1 internal fn (header); called by 1 (window_id_advances_after_compact_persists_on_resume_and_resets_on_fork).


### Persisted rollout content
These suites check what runtime changes and message payloads do or do not get written into rollout-backed session history.

### `core/tests/suite/image_rollout.rs`

`test` · `request handling`

This test file focuses on rollout persistence rather than model behavior. It inspects the rollout file written by Codex after a turn and reconstructs the user message that contained an image. The helpers are narrowly targeted: `find_user_message_with_image` scans newline-delimited rollout JSON, tolerates unrelated or malformed lines, and returns the first `ResponseItem::Message` whose role is `user` and whose content contains a `ContentItem::InputImage`; `extract_image_url` pulls the image URL back out of that message; `read_rollout_text` polls briefly because rollout files may appear asynchronously; and `write_test_png` creates a tiny 2x2 RGBA PNG fixture on disk for local-image tests.

Both tests build a `TestCodex`, mount a trivial SSE response so the turn completes, and submit `Op::UserInput` with explicit thread settings derived from `turn_permission_fields`, `local_selections`, and a default collaboration mode using the configured session model. The copy-paste case sends `UserInput::LocalImage` plus trailing text and expects the rollout to contain four content items: an opening local-image tag text with the absolute path, an `InputImage` with `DEFAULT_IMAGE_DETAIL`, a closing tag text, and the freeform text. The drag-drop case sends `UserInput::Image` with a data URL and expects a simpler two-item message: the image span and the text span. In both cases the test shuts Codex down before reading the rollout file, then compares the reconstructed `ResponseItem` structurally with `assert_eq!`.

#### Function details

##### `find_user_message_with_image`  (lines 31–53)

```
fn find_user_message_with_image(text: &str) -> Option<ResponseItem>
```

**Purpose**: Scans rollout log text and returns the first user `ResponseItem::Message` that contains an input-image span. It ignores blank lines and any rollout lines that fail JSON parsing.

**Data flow**: Takes the full rollout file contents as `&str`. It iterates line by line, trims whitespace, skips empties, attempts to deserialize each line into `RolloutLine`, and checks whether `rollout.item` is `RolloutItem::ResponseItem(ResponseItem::Message { role, content, .. })` with `role == "user"` and at least one `ContentItem::InputImage`. When found, it clones and returns that `ResponseItem`; otherwise it returns `None`.

**Call relations**: Both rollout tests call this after reading the rollout file. It is the bridge from raw newline-delimited rollout storage to the structured `ResponseItem` value that the tests compare against expected protocol shapes.

*Call graph*: called by 2 (copy_paste_local_image_persists_rollout_request_shape, drag_drop_image_persists_rollout_request_shape); 1 external calls (from_str).


##### `extract_image_url`  (lines 55–63)

```
fn extract_image_url(item: &ResponseItem) -> Option<String>
```

**Purpose**: Pulls the `image_url` string out of a `ResponseItem::Message` if one of its content spans is an `InputImage`. It is used so expected values can preserve the runtime-generated URL while still asserting the surrounding message structure exactly.

**Data flow**: Accepts a borrowed `ResponseItem`. If the item is `ResponseItem::Message`, it scans `content` and returns a cloned `String` from the first `ContentItem::InputImage { image_url, .. }`; for any other item kind or if no image span exists, it returns `None`.

**Call relations**: Called by both tests after `find_user_message_with_image` succeeds. The tests use it to splice the actual image URL into an otherwise fully deterministic expected `ResponseItem` before asserting equality.

*Call graph*: called by 2 (copy_paste_local_image_persists_rollout_request_shape, drag_drop_image_persists_rollout_request_shape).


##### `read_rollout_text`  (lines 65–77)

```
async fn read_rollout_text(path: &Path) -> anyhow::Result<String>
```

**Purpose**: Waits briefly for the rollout file to appear and become non-empty, then returns its contents. This avoids races between turn completion and asynchronous rollout persistence.

**Data flow**: Receives a rollout `Path`. It loops up to 50 times, each time checking `path.exists()`, attempting `std::fs::read_to_string`, and returning early if the text is non-empty after trimming; otherwise it sleeps 20 ms with `tokio::time::sleep`. If the polling loop never succeeds, it performs one final `read_to_string` with contextual error text and returns the result.

**Call relations**: Both rollout tests call this after shutting Codex down. It isolates the timing sensitivity of rollout file creation so the tests can focus on parsing and structural assertions.

*Call graph*: called by 2 (copy_paste_local_image_persists_rollout_request_shape, drag_drop_image_persists_rollout_request_shape); 4 external calls (from_millis, exists, read_to_string, sleep).


##### `write_test_png`  (lines 79–86)

```
fn write_test_png(path: &Path, color: [u8; 4]) -> anyhow::Result<()>
```

**Purpose**: Creates a tiny PNG fixture on disk for the local-image rollout test. The image contents are deterministic and only large enough to exercise file-based image ingestion.

**Data flow**: Takes a destination `Path` and an RGBA color array. It creates parent directories if needed, constructs a 2x2 `ImageBuffer` filled with `Rgba(color)`, saves it to the given path, and returns `anyhow::Result<()>`.

**Call relations**: Used only by `copy_paste_local_image_persists_rollout_request_shape` before submitting the turn. It supplies a real local file path so the rollout can include the local-image open tag with an absolute path.

*Call graph*: called by 1 (copy_paste_local_image_persists_rollout_request_shape); 4 external calls (from_pixel, parent, Rgba, create_dir_all).


##### `copy_paste_local_image_persists_rollout_request_shape`  (lines 89–187)

```
async fn copy_paste_local_image_persists_rollout_request_shape() -> anyhow::Result<()>
```

**Purpose**: Verifies that a pasted local image is serialized into the rollout as a user message containing local-image tag text, an `InputImage` span with default detail, a closing tag, and trailing text. It checks the exact `ResponseItem::Message` shape rather than just presence of an image.

**Data flow**: This async test skips without network, starts a mock server, builds `TestCodex`, writes a PNG fixture under the test cwd, mounts a simple assistant SSE response, derives sandbox and permission settings, and submits `Op::UserInput` containing `UserInput::LocalImage { path: abs_path, detail: None }` followed by `UserInput::Text`. It waits for `TurnComplete`, submits `Op::Shutdown`, waits for `ShutdownComplete`, reads the rollout file via `read_rollout_text`, extracts the first user message with an image via `find_user_message_with_image`, pulls out the runtime image URL via `extract_image_url`, constructs the expected `ResponseItem::Message`, and asserts equality.

**Call relations**: This is one of the two top-level rollout tests. It depends on `write_test_png` to create the local file fixture and on the parsing helpers to recover the persisted message from the rollout log.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, extract_image_url, find_user_message_with_image, read_rollout_text, write_test_png); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `drag_drop_image_persists_rollout_request_shape`  (lines 190–278)

```
async fn drag_drop_image_persists_rollout_request_shape() -> anyhow::Result<()>
```

**Purpose**: Verifies that a drag-and-drop image supplied as a data URL is persisted into the rollout as a simpler user message containing an `InputImage` span and trailing text. It confirms that no local-file wrapper tags are added in this path.

**Data flow**: The test skips without network, starts a mock server, builds `TestCodex`, defines a base64 PNG data URL, mounts a trivial assistant SSE response, computes sandbox and permission settings, and submits `Op::UserInput` with `UserInput::Image { image_url, detail: None }` followed by `UserInput::Text`. After waiting for turn completion and shutdown, it reads the rollout file, finds the user message containing an image, extracts the actual image URL, builds the expected `ResponseItem::Message` with `DEFAULT_IMAGE_DETAIL`, and asserts structural equality.

**Call relations**: This is the companion to the local-image test. It reuses `read_rollout_text`, `find_user_message_with_image`, and `extract_image_url`, but intentionally bypasses `write_test_png` because the image source is already an inline URL.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, extract_image_url, find_user_message_with_image, read_rollout_text); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/model_overrides.rs`

`test` · `teardown`

This small regression file protects a subtle persistence boundary: thread-level model overrides should affect the running session only, not mutate user configuration on disk. It uses `CONFIG_TOML` as the canonical filename and drives the behavior through `core_test_support::submit_thread_settings`, which sends `ThreadSettingsOverrides` into a live `TestCodex` instance.

The first test seeds a real `config.toml` in the temporary home directory during `with_pre_build_hook`, also sets `config.model` in memory to match, then submits overrides selecting model `o3` and `ReasoningEffort::High`. After requesting shutdown and waiting for `EventMsg::ShutdownComplete`, it reads the file asynchronously and asserts the contents are byte-for-byte identical to the original `model = "gpt-4o"\n`. This proves runtime overrides do not rewrite an existing config file.

The second test starts from a clean home with no config file, asserts that absence up front, submits overrides selecting model `o3` and `ReasoningEffort::Medium`, then shuts down and asserts `config.toml` still does not exist. Together the tests establish two invariants: overrides are ephemeral, and merely using them must not create persistence artifacts. The file is intentionally narrow and does not inspect model-selection behavior itself; it only guards the no-write side effect contract.

#### Function details

##### `thread_settings_update_does_not_persist_when_config_exists`  (lines 12–45)

```
async fn thread_settings_update_does_not_persist_when_config_exists()
```

**Purpose**: Verifies that applying thread-level model and effort overrides leaves an existing `config.toml` untouched. It protects against accidental persistence of runtime session changes.

**Data flow**: This async test starts a mock server, defines initial file contents `model = "gpt-4o"\n`, builds `TestCodex` with a pre-build hook that writes those contents to `config.toml` and with in-memory `config.model` set to `gpt-4o`, clones the `codex` handle, computes the config path, submits thread settings overrides `{ model: Some("o3"), effort: Some(Some(ReasoningEffort::High)), ..Default::default() }`, requests shutdown, waits for `ShutdownComplete`, reads the config file with `tokio::fs::read_to_string`, and asserts the contents still equal the original string.

**Call relations**: This top-level regression test uses `submit_thread_settings` to exercise the runtime override path and `wait_for_event` to ensure shutdown has flushed any potential writes before checking the file.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 5 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, read_to_string).


##### `thread_settings_update_does_not_create_config_file`  (lines 48–77)

```
async fn thread_settings_update_does_not_create_config_file()
```

**Purpose**: Verifies that applying thread-level model and effort overrides does not create `config.toml` when no config file existed beforehand. It guards against unintended persistence side effects in the empty-home case.

**Data flow**: The test starts a mock server, builds a default `TestCodex`, clones the `codex` handle, computes the expected config path under the temp home, asserts the file does not exist, submits thread settings overrides `{ model: Some("o3"), effort: Some(Some(ReasoningEffort::Medium)), ..Default::default() }`, requests shutdown, waits for `ShutdownComplete`, and finally asserts the config path still does not exist.

**Call relations**: This is the no-existing-file companion to the previous test. It follows the same override-and-shutdown flow but checks for absence rather than unchanged contents.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 4 external calls (default, assert!, submit_thread_settings, wait_for_event).


### `core/tests/suite/override_updates.rs`

`test` · `pre-turn override staging and shutdown`

This small regression suite protects a subtle persistence invariant: merely updating thread settings should not write a rollout file until a subsequent user turn actually records those settings into conversation history. The helper `collab_mode_with_instructions` constructs a concrete `CollaborationMode` using `ModeKind::Default`, model `gpt-5.4`, and optional developer instructions so the collaboration-update case can be expressed tersely.

Each async test starts a mock server, builds a `TestCodex` session, submits a `ThreadSettingsOverrides` update through `core_test_support::submit_thread_settings`, then immediately shuts the session down and waits for `EventMsg::ShutdownComplete`. After shutdown, the test obtains `test.codex.rollout_path()` and asserts that the path does not exist. The three covered override categories are approval policy, environment selections derived from a fresh `TempDir`, and collaboration mode with explicit instructions. The repeated assertion documents that these updates are staged in memory only; persistence is deferred until a later user turn makes them part of the recorded thread state.

#### Function details

##### `collab_mode_with_instructions`  (lines 17–26)

```
fn collab_mode_with_instructions(instructions: Option<&str>) -> CollaborationMode
```

**Purpose**: Constructs a `CollaborationMode` fixture with the default mode kind, fixed model `gpt-5.4`, no reasoning effort, and optional developer instructions. It keeps the collaboration-update test concise and explicit.

**Data flow**: Input is `Option<&str>` for developer instructions. The function maps the optional string to an owned `String`, embeds it in `Settings`, wraps that in `CollaborationMode { mode: ModeKind::Default, ... }`, and returns the struct.

**Call relations**: Only the collaboration-update test calls this helper before submitting thread settings.

*Call graph*: called by 1 (thread_settings_update_without_user_turn_does_not_record_collaboration_update).


##### `thread_settings_update_without_user_turn_does_not_record_permissions_update`  (lines 29–58)

```
async fn thread_settings_update_without_user_turn_does_not_record_permissions_update() -> Result<()>
```

**Purpose**: Ensures that changing approval policy via thread settings before any new user turn does not create a rollout file. This protects against persisting pure pre-turn permission changes.

**Data flow**: The test starts a mock server, builds a session whose config approval policy is initially `OnRequest`, submits thread settings overriding `approval_policy` to `Never`, then submits `Op::Shutdown` and waits for `ShutdownComplete`. It reads the rollout path from the codex handle and asserts the file does not exist.

**Call relations**: This top-level test uses `submit_thread_settings` to stage the override and then validates persistence behavior only after orderly shutdown.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 5 external calls (default, assert!, submit_thread_settings, wait_for_event, skip_if_no_network!).


##### `thread_settings_update_without_user_turn_does_not_record_environment_update`  (lines 61–88)

```
async fn thread_settings_update_without_user_turn_does_not_record_environment_update() -> Result<()>
```

**Purpose**: Checks that changing the selected environment/cwd before any user turn also does not create rollout history. The environment override should remain ephemeral until a turn is recorded.

**Data flow**: The test starts a mock server, builds a default session, creates a fresh `TempDir`, submits thread settings with `environments: Some(local_selections(new_cwd.abs()))`, shuts down the session, waits for `ShutdownComplete`, and asserts the rollout path does not exist.

**Call relations**: It is the environment-specific counterpart to the permissions test and uses `local_selections` to build the override payload.

*Call graph*: calls 3 internal fn (start_mock_server, local_selections, test_codex); 6 external calls (default, new, assert!, submit_thread_settings, wait_for_event, skip_if_no_network!).


##### `thread_settings_update_without_user_turn_does_not_record_collaboration_update`  (lines 91–119)

```
async fn thread_settings_update_without_user_turn_does_not_record_collaboration_update() -> Result<()>
```

**Purpose**: Verifies that updating collaboration mode, including developer instructions, before any user turn does not write a rollout file. This covers another category of staged-but-unpersisted thread state.

**Data flow**: The test starts a mock server, builds a default session, creates a collaboration-mode fixture with explicit instructions via `collab_mode_with_instructions`, submits it through thread settings, shuts down, waits for `ShutdownComplete`, and asserts the rollout path is absent.

**Call relations**: This test is the only caller of `collab_mode_with_instructions` and completes the trio of non-persisting pre-turn override cases.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, collab_mode_with_instructions); 5 external calls (default, assert!, submit_thread_settings, wait_for_event, skip_if_no_network!).


### Session discovery and state storage
These tests validate finding stored sessions and reconstructing thread state from SQLite-backed metadata and rollout files.

### `core/tests/suite/rollout_list_find.rs`

`test` · `resume`

This file validates the lookup utilities that find rollout files and thread metadata under `CODEX_HOME`. The helper writers create the smallest possible valid rollout artifacts: `write_minimal_rollout_with_id_at_path` writes a single `session_meta` JSONL line containing a supplied UUID, while `write_minimal_rollout_with_id_in_subdir` and `write_minimal_rollout_with_id` place that file under the expected `YYYY/MM/DD` directory layout for `sessions` or another subdirectory. `upsert_thread_metadata` initializes a real `StateRuntime`, marks backfill complete, builds `ThreadMetadata` with `ThreadMetadataBuilder`, and inserts it into the SQLite state DB so tests can exercise the DB-first lookup path.

The tests cover several search behaviors. `find_thread_path_by_id_str` must locate rollout files by ID in normal sessions, ignore broad `.gitignore` rules that cover `.codex` or `*.jsonl`, prefer the SQLite-recorded path when state DB metadata exists, and fall back to filesystem scanning when the DB has no matching thread. `find_archived_thread_path_by_id_str` must search `archived_sessions`. The name-based test uses a real `RolloutRecorder` to persist a rollout, writes a `session_index.jsonl` entry with a thread name, and then verifies `find_thread_meta_by_name_str` returns both the correct path and `SessionMeta`, proving the finder works against recorder-produced files rather than only synthetic fixtures.

#### Function details

##### `write_minimal_rollout_with_id_in_subdir`  (lines 25–33)

```
fn write_minimal_rollout_with_id_in_subdir(codex_home: &Path, subdir: &str, id: Uuid) -> PathBuf
```

**Purpose**: Creates a dated rollout directory under the requested subdirectory and writes a minimal rollout file containing the supplied session ID.

**Data flow**: It joins `codex_home`, `subdir`, and `2024/01/01`, creates that directory tree, constructs a filename of the form `rollout-2024-01-01T00-00-00-{id}.jsonl`, delegates file contents to `write_minimal_rollout_with_id_at_path`, and returns the resulting absolute `PathBuf`.

**Call relations**: This helper underlies both normal-session and archived-session fixture creation. The archived lookup test calls it directly, while the standard-session helper wraps it with a fixed `sessions` subdirectory.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id_at_path); called by 2 (find_archived_locates_rollout_file_by_id, write_minimal_rollout_with_id); 3 external calls (join, format!, create_dir_all).


##### `write_minimal_rollout_with_id_at_path`  (lines 35–55)

```
fn write_minimal_rollout_with_id_at_path(file: &Path, id: Uuid)
```

**Purpose**: Writes a one-line rollout JSONL file whose `session_meta` payload contains the given UUID.

**Data flow**: It creates the target file, serializes a JSON object with `type = "session_meta"` and a payload containing `id`, timestamp, cwd, originator, CLI version, and model provider, writes that line with `writeln!`, and returns no value.

**Call relations**: The path-based writer is used by the subdirectory helper and by the SQLite-preference test, which needs to place a rollout at a specific DB-recorded path.

*Call graph*: called by 2 (find_prefers_sqlite_path_by_id, write_minimal_rollout_with_id_in_subdir); 2 external calls (create, writeln!).


##### `write_minimal_rollout_with_id`  (lines 59–61)

```
fn write_minimal_rollout_with_id(codex_home: &Path, id: Uuid) -> PathBuf
```

**Purpose**: Convenience wrapper that writes a minimal rollout file under the standard `sessions` tree.

**Data flow**: It forwards `codex_home` and `id` to `write_minimal_rollout_with_id_in_subdir(codex_home, "sessions", id)` and returns the resulting path.

**Call relations**: Most filesystem-based lookup tests use this helper because they target the normal sessions directory layout.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id_in_subdir); called by 5 (find_falls_back_to_filesystem_when_sqlite_has_no_match, find_handles_gitignore_covering_codex_home_directory, find_ignores_granular_gitignore_rules, find_locates_rollout_file_by_id, find_prefers_sqlite_path_by_id).


##### `upsert_thread_metadata`  (lines 63–85)

```
async fn upsert_thread_metadata(
    codex_home: &Path,
    thread_id: ThreadId,
    rollout_path: PathBuf,
) -> StateDbHandle
```

**Purpose**: Initializes a test state database and inserts thread metadata pointing at a specific rollout path.

**Data flow**: It creates a `StateRuntime` rooted at `codex_home`, marks backfill complete, constructs a `ThreadMetadataBuilder` with the supplied `thread_id`, `rollout_path`, current UTC time, and default `SessionSource`, overrides `builder.cwd` to `codex_home`, builds metadata for provider `test-provider`, upserts it into the runtime, and returns the resulting `StateDbHandle`.

**Call relations**: The SQLite-preference and filesystem-fallback tests call this helper to seed the DB side of the lookup logic before invoking `find_thread_path_by_id_str`.

*Call graph*: calls 2 internal fn (new, init); called by 2 (find_falls_back_to_filesystem_when_sqlite_has_no_match, find_prefers_sqlite_path_by_id); 3 external calls (to_path_buf, now, default).


##### `find_locates_rollout_file_by_id`  (lines 88–99)

```
async fn find_locates_rollout_file_by_id()
```

**Purpose**: Checks that filesystem scanning can locate a normal-session rollout file by thread ID.

**Data flow**: It creates a temp home, generates a UUID, writes a minimal rollout under `sessions`, calls `find_thread_path_by_id_str(home.path(), id_string, None)`, unwraps the result, and asserts the found path equals the expected path.

**Call relations**: This is the simplest positive control for ID-based lookup with no state DB involved. It establishes the baseline behavior that later tests refine.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id); 4 external calls (new, new_v4, assert_eq!, find_thread_path_by_id_str).


##### `find_handles_gitignore_covering_codex_home_directory`  (lines 102–116)

```
async fn find_handles_gitignore_covering_codex_home_directory()
```

**Purpose**: Verifies that lookup still finds rollout files even when a repository `.gitignore` broadly ignores the `.codex` directory.

**Data flow**: It creates a temp repo, creates `.codex` under it, writes `.gitignore` containing `.codex/**`, writes a minimal rollout inside `.codex/sessions`, calls `find_thread_path_by_id_str` on the `.codex` path, and asserts the result is the expected rollout path.

**Call relations**: This test targets an edge case where generic filesystem walkers might skip ignored directories. It proves the finder intentionally searches Codex home despite repository ignore rules.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id); 6 external calls (new, new_v4, assert_eq!, find_thread_path_by_id_str, create_dir_all, write).


##### `find_prefers_sqlite_path_by_id`  (lines 119–136)

```
async fn find_prefers_sqlite_path_by_id()
```

**Purpose**: Checks that when SQLite metadata exists for a thread ID, the finder returns the DB-recorded rollout path instead of another matching filesystem path.

**Data flow**: It creates a temp home and UUID, converts the UUID into `ThreadId`, writes one rollout at a future-dated explicit `db_path`, writes another matching rollout under the normal sessions tree, seeds the state DB with metadata pointing to `db_path`, calls `find_thread_path_by_id_str(..., Some(&state_db))`, and asserts the returned path is `db_path`.

**Call relations**: This test depends on `upsert_thread_metadata` to create the DB entry. It is the positive case for DB-first lookup precedence.

*Call graph*: calls 4 internal fn (upsert_thread_metadata, write_minimal_rollout_with_id, write_minimal_rollout_with_id_at_path, from_string); 6 external calls (new, new_v4, assert_eq!, find_thread_path_by_id_str, format!, create_dir_all).


##### `find_falls_back_to_filesystem_when_sqlite_has_no_match`  (lines 139–155)

```
async fn find_falls_back_to_filesystem_when_sqlite_has_no_match()
```

**Purpose**: Verifies that the finder falls back to filesystem scanning when the state DB is present but contains only unrelated thread metadata.

**Data flow**: It creates a temp home, writes a minimal rollout for one UUID, seeds the state DB with a different `ThreadId` and unrelated path, calls `find_thread_path_by_id_str` with that DB handle, and asserts the result is the filesystem rollout path for the requested ID.

**Call relations**: This is the negative counterpart to the SQLite-preference test. It proves the presence of a state DB does not suppress filesystem lookup when no DB row matches the requested thread.

*Call graph*: calls 3 internal fn (upsert_thread_metadata, write_minimal_rollout_with_id, from_string); 4 external calls (new, new_v4, assert_eq!, find_thread_path_by_id_str).


##### `find_ignores_granular_gitignore_rules`  (lines 158–170)

```
async fn find_ignores_granular_gitignore_rules()
```

**Purpose**: Checks that granular `.gitignore` rules inside the sessions tree do not prevent rollout discovery.

**Data flow**: It creates a temp home, writes a minimal rollout under `sessions`, writes `sessions/.gitignore` containing `*.jsonl`, calls `find_thread_path_by_id_str` without a state DB, and asserts the rollout is still found.

**Call relations**: This test complements the broad `.codex/**` ignore case by targeting ignore rules placed directly inside the sessions directory.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id); 5 external calls (new, new_v4, assert_eq!, find_thread_path_by_id_str, write).


##### `find_locates_rollout_file_written_by_recorder`  (lines 173–221)

```
async fn find_locates_rollout_file_written_by_recorder() -> std::io::Result<()>
```

**Purpose**: Verifies that name-based lookup can find a rollout produced by the real `RolloutRecorder` and return its parsed session metadata.

**Data flow**: It builds a real `Config` rooted at a temp home, creates a new `ThreadId`, constructs a `RolloutRecorder` with `RolloutRecorderParams` and default `BaseInstructions`, persists and flushes it, writes a `session_index.jsonl` line mapping the thread ID to a human-readable thread name, calls `find_thread_meta_by_name_str`, and asserts the returned `session_meta.meta.id` matches the thread ID, the path exists, and the file contents contain the thread ID string. It then shuts down the recorder.

**Call relations**: Unlike the synthetic-ID tests, this one exercises the recorder-produced file format and the name-based finder. It validates integration between rollout recording and later lookup by thread name.

*Call graph*: calls 4 internal fn (default, new, new, new); 9 external calls (new, new, assert!, assert_eq!, find_thread_meta_by_name_str, default, format!, read_to_string, write).


##### `find_archived_locates_rollout_file_by_id`  (lines 224–238)

```
async fn find_archived_locates_rollout_file_by_id()
```

**Purpose**: Checks that archived-session lookup searches `archived_sessions` rather than only the active sessions tree.

**Data flow**: It creates a temp home, generates a UUID, writes a minimal rollout under `archived_sessions/2024/01/01`, calls `find_archived_thread_path_by_id_str(home.path(), id_string, None)`, and asserts the returned path matches the archived rollout path.

**Call relations**: This test is the archived analogue of the basic ID lookup test, targeting the dedicated archived-session finder.

*Call graph*: calls 1 internal fn (write_minimal_rollout_with_id_in_subdir); 4 external calls (new, new_v4, assert_eq!, find_archived_thread_path_by_id_str).


### `core/tests/suite/sqlite_state.rs`

`test` · `startup, request handling, resume, and teardown-adjacent persistence`

This file is a broad integration suite for the `Feature::Sqlite` state layer. Most tests enable SQLite in the test configuration, then either wait for the database file to appear or query the live state DB through `test.codex.state_db()`. Several tests poll with short sleeps because state persistence and backfill happen asynchronously relative to turn submission.

The first group verifies thread metadata lifecycle: a fresh thread should not exist in the DB or have a materialized rollout before the first user message; after a turn, the rollout path and thread row must appear. Resume tests then prove that dynamic tools survive across restarts, both in the current namespaced rollout format and in a legacy `dynamic_tools` JSON shape manually injected into the first rollout line. Another test seeds a historical rollout file in a pre-build hook and confirms startup backfill scans it into SQLite, including the first user message and default model provider.

The second group checks side effects from external context. Web search, standalone web search via the installed extension, and MCP tool calls should all mark thread memory mode as `polluted` when `memories.disable_on_external_context` is enabled. The final test wires the tracing log DB layer to the same state DB and confirms a synthetic `ToolCall:` log emitted inside a span carrying `thread_id` is persisted with that thread ID attached. Together these tests specify both persisted conversational metadata and auxiliary observability data.

#### Function details

##### `new_thread_is_recorded_in_state_db`  (lines 56–109)

```
async fn new_thread_is_recorded_in_state_db() -> Result<()>
```

**Purpose**: Verifies that a thread is absent from SQLite before the first user message and is recorded only after the first turn materializes the rollout.

**Data flow**: Starts a mock server, builds a SQLite-enabled test, captures the configured thread ID, rollout path, and expected DB path, polls until the DB file exists, obtains the state DB handle, asserts the rollout file does not yet exist and `get_thread(thread_id)` returns `None`, submits a turn, then polls `get_thread` until metadata appears. It finally asserts the stored thread ID and rollout path match expectations and that the rollout file now exists.

**Call relations**: This is the baseline persistence test for SQLite thread metadata and establishes the invariant that thread rows are created lazily on first user activity.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 6 external calls (from_millis, assert!, assert_eq!, state_db_path, try_exists, sleep).


##### `resume_restores_dynamic_tools_from_rollout_with_sqlite_enabled`  (lines 112–219)

```
async fn resume_restores_dynamic_tools_from_rollout_with_sqlite_enabled() -> Result<()>
```

**Purpose**: Checks that resuming a SQLite-enabled thread restores modern namespaced dynamic tools from rollout metadata into the next model request.

**Data flow**: Starts a mock server with two empty SSE turns, defines a namespaced `DynamicToolSpec` fixture, builds a SQLite-enabled base test, starts a thread with that tool, captures its rollout path, submits a user turn to persist the thread, waits for turn completion, then builds a second SQLite-enabled test resumed from the same home and rollout path. After submitting another turn, it inspects the second recorded request body and asserts the `tools` array contains the expected namespace/function JSON for the restored tool.

**Call relations**: This test spans initial thread creation and later resume, proving rollout metadata is sufficient to reconstruct dynamic tool availability when SQLite is enabled.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 6 external calls (default, assert_eq!, wait_for_event, json!, Namespace, vec!).


##### `resume_restores_legacy_dynamic_tools_from_rollout_with_sqlite_enabled`  (lines 222–339)

```
async fn resume_restores_legacy_dynamic_tools_from_rollout_with_sqlite_enabled() -> Result<()>
```

**Purpose**: Checks that resume logic still understands the older rollout `dynamic_tools` schema and converts it into the current namespaced tool representation.

**Data flow**: Builds a SQLite-enabled base test with no initial tools, starts a thread, submits a turn, waits for completion, shuts the thread down, reads and parses the rollout JSONL, mutates the first session metadata line to inject a legacy `dynamic_tools` array, rewrites the rollout file, resumes from that rollout, submits another turn, and inspects the second request body. It asserts the restored `tools` array contains a namespace named `resume_tools` with the expected function and a synthesized namespace description.

**Call relations**: This is the backward-compatibility companion to the modern dynamic-tool resume test, documenting migration behavior from legacy rollout metadata.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 9 external calls (default, new, assert_eq!, wait_for_event, format!, read_to_string, write, json!, vec!).


##### `backfill_scans_existing_rollouts`  (lines 342–443)

```
async fn backfill_scans_existing_rollouts() -> Result<()>
```

**Purpose**: Verifies that SQLite startup backfill discovers preexisting rollout files on disk and inserts corresponding thread metadata into the state DB.

**Data flow**: Generates a new UUID-based thread ID and rollout relative path, builds a test with a pre-build hook that writes a synthetic rollout JSONL containing `SessionMeta` and a `UserMessage` event, enables SQLite, starts the test, computes the DB path and expected rollout path, polls for DB creation, obtains the state DB, then polls `get_thread(thread_id)` until metadata appears. It asserts the stored ID, rollout path, model provider, and presence of `first_user_message`.

**Call relations**: Unlike the live-turn tests, this one validates the startup scanner that backfills SQLite from historical rollout files already present under `codex_home`.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, from_string); 8 external calls (from_millis, now_v7, assert!, assert_eq!, state_db_path, format!, try_exists, sleep).


##### `user_messages_persist_in_state_db`  (lines 446–496)

```
async fn user_messages_persist_in_state_db() -> Result<()>
```

**Purpose**: Checks that user-message metadata, specifically the first user message field, is persisted into SQLite after turns are submitted.

**Data flow**: Starts a mock server with two empty SSE turns, builds a SQLite-enabled test, waits for the DB file, submits two turns, obtains the state DB and thread ID, then polls `get_thread(thread_id)` until the returned metadata includes a non-`None` `first_user_message`. It finally asserts the metadata exists and that field is populated.

**Call relations**: This test narrows in on persisted user-message metadata rather than rollout paths or resume behavior.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 6 external calls (from_millis, assert!, state_db_path, try_exists, sleep, vec!).


##### `web_search_marks_thread_memory_mode_polluted_when_configured`  (lines 499–535)

```
async fn web_search_marks_thread_memory_mode_polluted_when_configured() -> Result<()>
```

**Purpose**: Verifies that a built-in web search tool call marks the thread memory mode as `polluted` when external-context pollution tracking is enabled.

**Data flow**: Starts a mock server, mounts an SSE response containing a completed web-search call event, builds a SQLite-enabled test with `memories.disable_on_external_context = true`, obtains the state DB and thread ID, submits a turn, then polls `get_thread_memory_mode(thread_id)` until it becomes `Some("polluted")`. It asserts the final value is exactly `polluted`.

**Call relations**: This is the simplest external-context pollution test and serves as the baseline for the standalone web-search and MCP variants.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (from_millis, assert_eq!, sleep, vec!).


##### `standalone_web_search_marks_thread_memory_mode_polluted_when_configured`  (lines 538–613)

```
async fn standalone_web_search_marks_thread_memory_mode_polluted_when_configured() -> Result<()>
```

**Purpose**: Verifies that the standalone web-search extension also marks thread memory mode as `polluted` under the same configuration.

**Data flow**: Skips without network, starts a mock server, mounts a `/v1/alpha/search` HTTP response and an SSE sequence that invokes the namespaced `web.run` tool, constructs dummy API-key auth and an extension registry with the web-search extension installed, builds a test with SQLite and `StandaloneWebSearch` enabled, live web-search mode, and external-context pollution tracking on, obtains the state DB and thread ID, submits a turn, then polls `get_thread_memory_mode` until it becomes `polluted` and asserts that value.

**Call relations**: This extends the pollution check to the extension-based standalone web-search path rather than the built-in web-search event path.

*Call graph*: calls 5 internal fn (auth_manager_from_auth, mount_sse_sequence, start_mock_server, test_codex, from_api_key); 13 external calls (new, from_millis, new, given, new, assert_eq!, install, json!, skip_if_no_network!, sleep (+3 more)).


##### `mcp_call_marks_thread_memory_mode_polluted_when_configured`  (lines 616–745)

```
async fn mcp_call_marks_thread_memory_mode_polluted_when_configured() -> Result<()>
```

**Purpose**: Verifies that an MCP tool call marks thread memory mode as `polluted` when external-context pollution tracking is enabled.

**Data flow**: Skips without network, starts a mock server, mounts SSE responses that invoke a namespaced MCP tool `mcp__rmcp.echo` and then complete, configures a SQLite-enabled test with an MCP stdio server entry named `rmcp`, waits for the MCP server to be ready, obtains the state DB and thread ID, derives read-only sandbox and permission settings, submits a user turn with explicit thread settings, waits for `McpToolCallEnd` and then either `TurnComplete` or an error, and finally polls `get_thread_memory_mode(thread_id)` until it becomes `polluted`. It asserts the final value is `polluted`.

**Call relations**: This is the MCP analogue of the web-search pollution tests and proves that external tool calls beyond web search also taint memory mode.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, read_only); 11 external calls (default, from_millis, assert_eq!, stdio_server_bin, wait_for_event, wait_for_event_match, wait_for_mcp_server, format!, skip_if_no_network!, sleep (+1 more)).


##### `tool_call_logs_include_thread_id`  (lines 748–823)

```
async fn tool_call_logs_include_thread_id() -> Result<()>
```

**Purpose**: Checks that log rows written through the SQLite log DB layer preserve the current tracing span’s `thread_id` field.

**Data flow**: Starts a mock server, mounts a `shell_command` tool-call turn, builds a SQLite-enabled test, obtains the state DB and expected thread ID string, submits a turn, starts the log DB tracing layer on that DB, installs it in a temporary subscriber, emits an `info!` log inside a span carrying `thread_id = expected_thread_id`, flushes the layer, then polls `query_logs` until it finds a row whose message contains `ToolCall:`. It asserts that row’s `thread_id` equals the expected thread ID and that the message contains the tool-call text.

**Call relations**: This test is distinct from the conversational-state tests: it validates observability plumbing from tracing spans into persisted SQLite log rows.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, start); 11 external calls (default, from_millis, assert!, assert_eq!, json!, to_string, sleep, new, with_default, registry (+1 more)).
