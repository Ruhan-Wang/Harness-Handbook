# Multi-agent, collaboration, and remote-environment suites  `stage-23.2.4.4`

This stage is a behind-the-scenes safety net for the system’s most complex teamwork features. It tests what happens when one session creates helper agents, passes work down to them, and sometimes runs that work in a separate remote environment instead of the local machine. Think of it as checking that a manager, assistants, inboxes, and off-site workspaces all coordinate correctly.

spawn_agent_description.rs checks the instructions shown when the system offers the “spawn agent” tool, so users only see allowed model choices and clear guidance about overrides, effort levels, service tiers, and approval rules. agent_execution.rs makes sure nested agents share a limited pool of execution slots and fail clearly when that limit is exceeded. codex_delegate.rs verifies that a child agent’s review events are forwarded into the parent conversation in the right form. subagent_notifications.rs follows the full parent/child lifecycle, including inherited context, message passing, and notifications. agent_jobs.rs tests batch-style agent jobs, including creation, cancellation, and saving results to the right thread. remote_env.rs ensures remote execution uses the correct remote files, permissions, and sandbox, without leaking into the local workspace.

## Files in this stage

### Agent spawning foundations
These tests establish how multi-agent spawning is presented to the model and how nested execution capacity is enforced at runtime.

### `core/tests/suite/spawn_agent_description.rs`

`test` · `startup and request handling`

This non-Windows test file inspects the tool metadata sent to the model rather than executing any agent-spawning behavior. `test_model_info` constructs realistic `ModelInfo` values with all required fields populated, including shell tool type, truncation policy, context window, reasoning defaults, and service tiers. `wait_for_model_available` then polls the shared models manager until the remotely mounted model list has been ingested, avoiding races between startup and request inspection.

The main test mounts a `/models` response containing one visible model and one hidden model, then mounts a trivial SSE completion for the actual turn. It builds Codex with dummy ChatGPT auth, selects the visible model, enables the collaboration feature, and disables the config flag that would hide spawn-agent metadata. After waiting for the models manager to expose `visible-model`, it submits a turn and inspects the recorded request body. `spawn_agent_description` navigates the request JSON to the namespaced child tool `multi_agent_v1.spawn_agent` and extracts its `description` string. The assertions are intentionally content-rich: they require visible model summaries, inherited-model guidance, explicit discouragement of unnecessary overrides or sub-agent spawning, reasoning-effort and service-tier summaries, and omission of hidden models and deprecated delegation guidance. This makes the file a precise specification for the prompt text attached to the spawn-agent tool.

#### Function details

##### `spawn_agent_description`  (lines 35–40)

```
fn spawn_agent_description(body: &Value) -> Option<String>
```

**Purpose**: Extracts the description string for the `spawn_agent` child tool inside the `multi_agent_v1` namespace from a request JSON body.

**Data flow**: Takes a `serde_json::Value` request body, locates the namespaced child tool via `namespace_child_tool`, reads its `description` field if present and string-typed, and returns it as `Option<String>`.

**Call relations**: Used only by the main test after capturing the outbound request body, isolating the JSON navigation needed to reach the tool metadata under test.

*Call graph*: calls 1 internal fn (namespace_child_tool); called by 1 (spawn_agent_description_lists_visible_models_and_reasoning_efforts).


##### `test_model_info`  (lines 42–91)

```
fn test_model_info(
    slug: &str,
    display_name: &str,
    description: &str,
    visibility: ModelVisibility,
    default_reasoning_level: ReasoningEffort,
    supported_reasoning_levels: Vec<Re
```

**Purpose**: Builds a fully populated `ModelInfo` fixture with caller-controlled visibility, reasoning presets, and service tiers.

**Data flow**: Consumes model identity and presentation fields plus visibility, default reasoning level, supported reasoning presets, and service tiers. It returns a `ModelInfo` struct with those values inserted and all other required fields filled with stable defaults such as `ConfigShellToolType::ShellCommand`, `default_input_modalities()`, `TruncationPolicyConfig::bytes(10_000)`, and a fixed context window.

**Call relations**: The main test uses this helper twice to create one visible and one hidden model fixture for the mocked models endpoint.

*Call graph*: calls 2 internal fn (bytes, default_input_modalities); 2 external calls (default, new).


##### `wait_for_model_available`  (lines 93–105)

```
async fn wait_for_model_available(manager: &SharedModelsManager, slug: &str)
```

**Purpose**: Polls the shared models manager until a specific model slug appears in the online model list.

**Data flow**: Accepts a `SharedModelsManager` and target slug, repeatedly calls `list_models(RefreshStrategy::Online)` for up to 2 seconds, returns once any listed model matches the slug, and otherwise sleeps 25 ms between attempts before panicking on timeout.

**Call relations**: Called by the main test after startup so the subsequent turn is guaranteed to use the freshly mounted remote model metadata.

*Call graph*: called by 1 (spawn_agent_description_lists_visible_models_and_reasoning_efforts); 6 external calls (from_millis, from_secs, now, list_models, panic!, sleep).


##### `spawn_agent_description_lists_visible_models_and_reasoning_efforts`  (lines 108–236)

```
async fn spawn_agent_description_lists_visible_models_and_reasoning_efforts() -> Result<()>
```

**Purpose**: Verifies that the `spawn_agent` tool description includes only visible models and the intended guidance text about overrides, reasoning efforts, service tiers, and authorization boundaries.

**Data flow**: Starts a mock server, mounts a models response containing visible and hidden fixtures from `test_model_info`, mounts a trivial SSE completion, builds a test Codex with dummy auth, selected model `visible-model`, collaboration enabled, and spawn-agent metadata visible, waits for the model to appear in the models manager, submits a turn, extracts the request body, derives the spawn-agent description string with `spawn_agent_description`, and performs a series of positive and negative substring assertions on that description.

**Call relations**: This is the file’s sole integration test and ties together model fixture setup, model-manager synchronization, request capture, and description-content validation.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_once, sse, start_mock_server, test_codex, spawn_agent_description, wait_for_model_available, create_dummy_chatgpt_auth_for_testing); 2 external calls (assert!, vec!).


### `core/tests/suite/agent_execution.rs`

`test` · `integration test execution during nested agent spawning`

Two small request-inspection helpers support the main test. `body_contains` parses a wiremock request body as JSON and checks whether its serialized form contains a given substring, which is sufficient for matching prompts and task text in these mocked Responses payloads. `has_function_call_output` parses the same JSON and walks the top-level `input` array looking for an item with `type == "function_call_output"` and a matching `call_id`; this distinguishes initial spawn requests from follow-up requests carrying tool results. The integration test mounts four conditional SSE handlers on a mock server. The first matches the original prompt and returns a `spawn_agent` call for `FIRST_TASK`. The second matches the first worker's request before any output for `first-call` exists and returns another `spawn_agent` call for `SECOND_TASK`. A third matcher waits for a follow-up request containing output for `second-call` and responds with assistant text `blocked`, while a fourth does the same for `first-call` and responds `spawned`. The `TestCodex` fixture enables `Feature::Collab` and `Feature::MultiAgentV2` and sets `max_concurrent_threads_per_session = 2`. After submitting the first prompt, the test polls the third recorder until the nested second spawn's output appears, then asserts the output text is exactly `collab spawn failed: agent thread limit reached` and that only two thread ids exist, proving the root thread and first worker consumed the shared capacity.

#### Function details

##### `body_contains`  (lines 19–22)

```
fn body_contains(request: &wiremock::Request, text: &str) -> bool
```

**Purpose**: Checks whether a wiremock request body, interpreted as JSON, contains a given text fragment anywhere in its serialized representation. It is a lightweight matcher for routing mocked Responses requests by prompt/task content.

**Data flow**: Accepts `request: &wiremock::Request` and `text: &str` → attempts `serde_json::from_slice::<serde_json::Value>(&request.body)` and, if parsing succeeds, converts the JSON back to a string and tests `.contains(text)` → returns `bool`, defaulting to `false` on parse failure.

**Call relations**: This helper is used by the main nested-spawn test inside `mount_sse_once_match` predicates to distinguish the initial prompt request from worker-task requests.


##### `has_function_call_output`  (lines 24–36)

```
fn has_function_call_output(request: &wiremock::Request, call_id: &str) -> bool
```

**Purpose**: Detects whether a request body includes a `function_call_output` item for a specific tool call id. It lets the test tell apart pre-output worker requests from follow-up requests that report spawn results back to the model.

**Data flow**: Accepts `request: &wiremock::Request` and `call_id: &str` → parses the body as `serde_json::Value`, reads the `input` array if present, iterates its items, and returns `true` when any item has `type == "function_call_output"` and `call_id` equal to the target → otherwise returns `false`.

**Call relations**: The main test uses this helper in multiple wiremock match predicates: to exclude requests that already contain output for `first-call`, and to positively match follow-up requests carrying output for `second-call` or `first-call`.


##### `v2_nested_spawn_checks_shared_active_execution_capacity`  (lines 39–122)

```
async fn v2_nested_spawn_checks_shared_active_execution_capacity() -> Result<()>
```

**Purpose**: Runs an end-to-end nested-agent scenario and proves that the configured session-wide thread cap applies across parent and child agents. When the first worker tries to spawn a second worker beyond the limit, the system should return a failure output instead of creating another active thread.

**Data flow**: Starts a mock server, serializes `spawn_agent` arguments for the first and second tasks, mounts four conditional SSE responses keyed by `body_contains` and `has_function_call_output`, builds a `TestCodex` with model `koffing`, enables `Feature::Collab` and `Feature::MultiAgentV2`, and sets `config.multi_agent_v2.max_concurrent_threads_per_session = 2`. It submits `FIRST_PROMPT`, then uses `tokio::time::timeout` around a polling loop that repeatedly checks `second_followup.function_call_output_text("second-call")` until available. Once captured, it asserts the output equals `collab spawn failed: agent thread limit reached` and that `test.thread_manager.list_thread_ids().await.len()` is `2` → returns `Result<()>`.

**Call relations**: The Tokio test harness invokes this as the sole scenario test in the file. It orchestrates the entire mocked call flow itself, using the two local helper predicates to route requests and then inspecting the recorded follow-up output to confirm the capacity check fired at the nested spawn point.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex); 8 external calls (from_millis, from_secs, assert_eq!, json!, to_string, sleep, timeout, vec!).


### Subagent collaboration flows
These files cover parent-child coordination, delegated event surfacing, and mailbox-style notifications across collaborative sessions.

### `core/tests/suite/codex_delegate.rs`

`test` · `request handling`

This file contains a small set of integration tests around delegated review flows. The two ignored tests script a sub-agent conversation through mocked SSE responses and then drive the parent `Codex` thread with `Op::Review`. They verify that when the delegated agent emits an approval-requiring tool call—either a `shell_command` function call or an apply-patch custom tool call—the parent thread enters review mode, surfaces the corresponding approval request event (`ExecApprovalRequest` or `ApplyPatchApprovalRequest`), accepts a parent-side decision op, exits review mode, and completes the turn. The tests configure approvals explicitly by setting `approval_policy` to `AskForApproval::OnRequest` and using a read-only `PermissionProfile` so the delegated action requires review.

The active test covers a more subtle event-translation rule: legacy reasoning summary deltas from the delegated stream should not be duplicated or mis-forwarded. It mounts a single response containing `ev_reasoning_item_added`, `ev_reasoning_summary_text_delta`, and completion, submits a delegated review request, then drains events until `TurnComplete` while counting `ReasoningContentDelta` messages. The invariant is that only one new-style reasoning delta should be observed, proving the delegate ignores redundant legacy delta forms while still preserving the modern reasoning event stream.

#### Function details

##### `codex_delegate_forwards_exec_approval_and_proceeds_on_approval`  (lines 29–117)

```
async fn codex_delegate_forwards_exec_approval_and_proceeds_on_approval()
```

**Purpose**: Exercises the delegated review path where a sub-agent requests shell-command approval and the parent approves it.

**Data flow**: It scripts two SSE responses: first a `shell_command` function call with `SandboxPermissions::RequireEscalated`, then a final assistant review JSON. It builds a `TestCodex` with approval-on-request and read-only permissions, submits `Op::Review`, waits for review-mode entry and an `ExecApprovalRequest`, submits `Op::ExecApproval` using the emitted approval id, then waits for review-mode exit and turn completion.

**Call relations**: This ignored test is driven entirely from the parent thread’s event loop. It validates that delegated approval requests are forwarded outward and that the parent’s approval op is routed back into the sub-agent flow.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex); 5 external calls (wait_for_event, panic!, json!, skip_if_no_network!, vec!).


##### `codex_delegate_forwards_patch_approval_and_proceeds_on_decision`  (lines 123–197)

```
async fn codex_delegate_forwards_patch_approval_and_proceeds_on_decision()
```

**Purpose**: Exercises the delegated review path where a sub-agent requests patch approval and the parent denies it, yet the delegated review still proceeds to completion.

**Data flow**: It scripts a first SSE response containing an apply-patch custom tool call and a second response containing final review JSON, builds a restricted-permission `TestCodex`, submits `Op::Review`, waits for `ApplyPatchApprovalRequest`, submits `Op::PatchApproval` with `Denied`, then waits for review-mode exit and turn completion.

**Call relations**: Like the exec-approval test, this ignored test validates parent/sub-agent approval forwarding, but for patch approvals and a denial decision path.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex); 5 external calls (wait_for_event, panic!, json!, skip_if_no_network!, vec!).


##### `codex_delegate_ignores_legacy_deltas`  (lines 200–242)

```
async fn codex_delegate_ignores_legacy_deltas()
```

**Purpose**: Verifies that delegated review mode suppresses redundant legacy reasoning delta events while still surfacing the new reasoning delta stream.

**Data flow**: It mounts one SSE stream containing a response-created event, a reasoning item, a legacy reasoning-summary text delta, and completion. After submitting `Op::Review`, it repeatedly waits for the next event, increments a counter on `EventMsg::ReasoningContentDelta`, breaks on `TurnComplete`, and finally asserts the count is exactly one.

**Call relations**: This is the active regression test in the file. It drives the delegated review path and inspects the parent-visible event stream for correct delta normalization.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex); 4 external calls (assert_eq!, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/subagent_notifications.rs`

`test` · `request handling`

This file is a dense integration suite for collaboration features. It defines constants for prompts, role names, inherited/requested model settings, and expected hook-injected context, then layers helper functions on top of the mock Responses server and `TestCodex` harness. Several helpers inspect outbound requests: `body_contains` transparently decodes zstd-compressed request bodies before substring matching, `has_subagent_notification` searches user message inputs for `<subagent_notification>`, and JSON walkers extract tool parameter descriptions or isolate a role-specific block from a generated description string.

A second helper cluster writes and reads on-disk fixtures under the temporary Codex home. `write_home_skill` creates `skills/<dir>/SKILL.md`, while `write_subagent_lifecycle_hooks` emits Python hook scripts plus `hooks.json` for `SessionStart`, `SubagentStart`, `UserPromptSubmit`, `SubagentStop`, and `Stop`. The stop hook is stateful: it appends each invocation to a JSONL log and can block the first N invocations by printing a JSON decision with a continuation prompt. Polling helpers (`read_hook_log`, `wait_for_hook_log`, `wait_for_spawned_thread_id`, `wait_for_requests`) repeatedly inspect filesystem or mock-server state with short sleeps and hard deadlines.

The setup helpers mount parent spawn responses, child responses, and parent follow-up responses, then optionally wait until the parent rollout file contains a `<subagent_notification>` marker before returning the spawned thread id. The tests then cover: replacing session hooks with subagent hooks and injecting additional context into child prompts; replacing normal stop hooks with subagent stop hooks while skipping internal review subagents; carrying subagent notifications into later parent turns; forking parent context into children; overriding inherited model/reasoning settings via explicit spawn args or role config; preserving developer instructions and suppressing skill instructions under feature toggles; and MultiAgentV2 agent-message semantics for encrypted task dispatch and plaintext final-answer delivery, including terminal child failure propagation.

#### Function details

##### `body_contains`  (lines 64–82)

```
fn body_contains(req: &wiremock::Request, text: &str) -> bool
```

**Purpose**: Checks whether a wiremock request body contains a given substring, transparently handling optional zstd-compressed payloads. This lets tests match requests by semantic content instead of transport encoding.

**Data flow**: It reads the request headers to detect `content-encoding` entries containing `zstd`, chooses either raw `req.body` bytes or decoded bytes from `zstd::stream::decode_all`, converts the bytes to UTF-8 `String` if possible, and returns `true` only if the resulting text contains the requested substring. It writes no state.

**Call relations**: This helper underpins most request matchers in the file, allowing mounted SSE mocks to distinguish parent, child, follow-up, and mailbox-delivery requests regardless of compression.

*Call graph*: calls 1 internal fn (new); 1 external calls (decode_all).


##### `has_subagent_notification`  (lines 84–88)

```
fn has_subagent_notification(req: &ResponsesRequest) -> bool
```

**Purpose**: Detects whether a captured Responses request includes a serialized subagent notification in user-role message inputs. It is used to assert that parent follow-up turns carry child-completion context.

**Data flow**: It reads the request's user message texts via `message_input_texts("user")`, iterates them, and returns whether any text contains `<subagent_notification>`. It does not mutate request state.

**Call relations**: It is used by `subagent_notification_is_included_without_wait` to validate the no-wait path after a child has already completed.

*Call graph*: calls 1 internal fn (message_input_texts).


##### `tool_parameter_description`  (lines 90–97)

```
fn tool_parameter_description(tool: &Value, parameter_name: &str) -> Option<String>
```

**Purpose**: Extracts a tool parameter's `description` string from a tool schema JSON object. The helper navigates the nested `parameters.properties.<parameter>.description` structure expected in tool-search output.

**Data flow**: It takes a `serde_json::Value` representing a tool and a parameter name, walks through `parameters`, `properties`, and the named property, converts the `description` field to `&str`, and returns it as an owned `String` inside `Option`. Missing nodes or non-string values yield `None`.

**Call relations**: This is called by `spawn_agent_tool_description_mentions_role_locked_settings` after locating the `spawn_agent` tool in tool-search output, so the test can inspect the generated `agent_type` description text.

*Call graph*: called by 1 (spawn_agent_tool_description_mentions_role_locked_settings); 1 external calls (get).


##### `role_block`  (lines 99–111)

```
fn role_block(description: &str, role_name: &str) -> Option<String>
```

**Purpose**: Slices a role-specific block out of a multiline description string generated for tool metadata. It looks for a header like `custom: {` and collects lines until the next sibling role block begins.

**Data flow**: Given the full description text and a role name, it formats the expected header, scans line-by-line until that header is found, then accumulates lines into a vector until it encounters another line ending with `: {`. It joins the collected lines with newlines and returns them as `Some(String)`, or `None` if the role header is absent.

**Call relations**: It is used only by `spawn_agent_tool_description_mentions_role_locked_settings` to isolate the `custom` role subsection before comparing it against the expected wording.

*Call graph*: called by 1 (spawn_agent_tool_description_mentions_role_locked_settings); 2 external calls (format!, vec!).


##### `write_home_skill`  (lines 113–119)

```
fn write_home_skill(codex_home: &Path, dir: &str, name: &str, description: &str) -> Result<()>
```

**Purpose**: Creates a synthetic home skill fixture under the temporary Codex home directory. The generated `SKILL.md` includes frontmatter with the supplied name and description.

**Data flow**: It receives the Codex home path plus a subdirectory, skill name, and description; joins them into `skills/<dir>`, creates the directory tree, formats markdown frontmatter and body text, writes `SKILL.md`, and returns `Result<()>`. Its side effects are filesystem directory creation and file writes.

**Call relations**: This helper is used by `skills_toggle_skips_instructions_for_parent_and_spawned_child` during pre-build setup so the test can verify that skill instructions are omitted even when a real skill exists.

*Call graph*: 4 external calls (join, format!, create_dir_all, write).


##### `write_subagent_lifecycle_hooks`  (lines 121–262)

```
fn write_subagent_lifecycle_hooks(
    home: &Path,
    stop_prompts: &[&str],
    subagent_stop_matcher: &str,
) -> Result<()>
```

**Purpose**: Builds a complete hook fixture set for subagent lifecycle tests, including Python scripts, JSONL log destinations, and a `hooks.json` configuration file. The generated hooks record payloads and optionally inject additional context or block subagent stop with continuation prompts.

**Data flow**: It takes a home directory, an ordered slice of stop prompts, and a matcher string for `SubagentStop`. It computes script and log paths, formats Python source strings for session start, subagent start, user prompt submit, subagent stop, and root stop hooks, serializes the stop prompt list into embedded JSON, constructs a `hooks` JSON object describing command hooks, writes all scripts plus `hooks.json`, and returns `Result<()>`. The function's outputs are the created files on disk.

**Call relations**: Tests that need hook behavior install this fixture through `with_pre_build_hook`, then rely on later polling helpers to inspect the JSONL logs those scripts append to.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `read_hook_log`  (lines 264–274)

```
fn read_hook_log(home: &Path, filename: &str) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads a JSONL hook log file into parsed `serde_json::Value` entries. Missing files are treated as an empty log rather than an error.

**Data flow**: It joins the home path with the requested filename, checks existence, returns `Ok(Vec::new())` if absent, otherwise reads the file to string, filters out blank lines, parses each line as JSON, and collects the results into `Result<Vec<Value>>`. It performs filesystem reads but no writes.

**Call relations**: This is the primitive log reader used directly by `subagent_stop_replaces_stop_and_skips_internal_subagents` and indirectly by `wait_for_hook_log` for polling.

*Call graph*: called by 2 (subagent_stop_replaces_stop_and_skips_internal_subagents, wait_for_hook_log); 3 external calls (join, new, read_to_string).


##### `wait_for_hook_log`  (lines 276–295)

```
async fn wait_for_hook_log(
    home: &Path,
    filename: &str,
    expected_len: usize,
) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Polls a hook log until it contains at least a target number of entries or times out. It shields tests from races between asynchronous hook execution and assertions.

**Data flow**: It takes the home path, filename, and expected minimum length, computes a deadline two seconds in the future, repeatedly calls `read_hook_log`, returns the parsed entries once `len() >= expected_len`, or bails with an error containing the observed count after the deadline. Between attempts it sleeps for 10 ms.

**Call relations**: Lifecycle-hook tests call this after submitting turns so assertions run only after the expected hook invocations have been persisted.

*Call graph*: calls 1 internal fn (read_hook_log); called by 2 (subagent_start_replaces_session_start_and_injects_context, subagent_stop_replaces_stop_and_skips_internal_subagents); 5 external calls (from_millis, from_secs, now, bail!, sleep).


##### `wait_for_spawned_thread_id`  (lines 297–312)

```
async fn wait_for_spawned_thread_id(test: &TestCodex) -> Result<String>
```

**Purpose**: Waits until the thread manager reports a child thread distinct from the root session thread, then returns that spawned thread id as a string. This avoids assuming synchronous child creation.

**Data flow**: It reads `test.thread_manager.list_thread_ids().await` in a loop, filters out `test.session_configured.thread_id`, returns the first remaining id converted to string, or bails after a two-second deadline. It sleeps 10 ms between polls and does not mutate thread state.

**Call relations**: The setup helpers use this to return the spawned child id, and `subagent_start_replaces_session_start_and_injects_context` uses it again when comparing hook payloads against the actual child thread.

*Call graph*: called by 2 (setup_turn_one_with_custom_spawned_child, subagent_start_replaces_session_start_and_injects_context); 5 external calls (from_millis, from_secs, now, bail!, sleep).


##### `wait_for_requests`  (lines 314–328)

```
async fn wait_for_requests(
    mock: &core_test_support::responses::ResponseMock,
) -> Result<Vec<ResponsesRequest>>
```

**Purpose**: Polls a `ResponseMock` until at least one request has been captured. It is a generic synchronization helper for tests that need to inspect outbound requests after asynchronous processing.

**Data flow**: It repeatedly reads `mock.requests()`, returns the collected `Vec<ResponsesRequest>` once non-empty, or bails after two seconds with the observed count. It sleeps 10 ms between checks and has no side effects beyond time delay.

**Call relations**: Many tests use this immediately after submitting a turn to ensure the relevant child, follow-up, or mailbox-delivery request has actually been emitted before asserting on its contents.

*Call graph*: calls 1 internal fn (requests); called by 8 (encrypted_multi_agent_v2_spawn_sends_agent_message_to_child, plaintext_multi_agent_v2_completion_sends_agent_message, setup_turn_one_with_custom_spawned_child, skills_toggle_skips_instructions_for_parent_and_spawned_child, spawned_multi_agent_v2_child_inherits_parent_developer_context, subagent_notification_is_included_without_wait, subagent_start_replaces_session_start_and_injects_context, subagent_stop_replaces_stop_and_skips_internal_subagents); 5 external calls (from_millis, from_secs, now, bail!, sleep).


##### `setup_turn_one_with_spawned_child`  (lines 330–345)

```
async fn setup_turn_one_with_spawned_child(
    server: &MockServer,
    child_response_delay: Option<Duration>,
) -> Result<(TestCodex, String)>
```

**Purpose**: Provides a simplified fixture for the common case where turn one spawns a child with the standard `CHILD_PROMPT`. It returns the built `TestCodex` and the spawned child id.

**Data flow**: It accepts a mock server and optional child response delay, constructs default spawn arguments `{ "message": CHILD_PROMPT }`, delegates to `setup_turn_one_with_custom_spawned_child` with parent-notification waiting enabled and an identity builder transform, then discards the child request log and returns `(TestCodex, String)`.

**Call relations**: This wrapper is used by `subagent_notification_is_included_without_wait` to avoid repeating the more configurable setup sequence.

*Call graph*: calls 1 internal fn (setup_turn_one_with_custom_spawned_child); called by 1 (subagent_notification_is_included_without_wait); 1 external calls (json!).


##### `setup_turn_one_with_custom_spawned_child`  (lines 347–449)

```
async fn setup_turn_one_with_custom_spawned_child(
    server: &MockServer,
    spawn_args: serde_json::Value,
    child_response_delay: Option<Duration>,
    wait_for_parent_notification: bool,
    c
```

**Purpose**: Builds the full parent-spawns-child scenario used across the suite, with configurable spawn arguments, optional child response delay, optional waiting for parent notification rollout, and caller-supplied test-builder customization. It mounts all mock responses needed for the parent request, child request, and parent follow-up.

**Data flow**: It serializes `spawn_args`, mounts a first SSE response matching `TURN_1_PROMPT` that emits a namespaced `spawn_agent` function call, mounts either an immediate or delayed child response matching `CHILD_PROMPT` without the spawn call id, mounts a parent follow-up response matching the spawn call id, builds a `TestCodex` with `Feature::Collab` enabled and inherited model/reasoning settings, submits `TURN_1_PROMPT`, optionally waits for the child request and then polls the parent rollout file until `<subagent_notification>` appears, waits for the spawned thread id, and returns `(test, spawned_id, child_request_log)`.

**Call relations**: This is the central orchestration helper for the file. `setup_turn_one_with_spawned_child` uses it for the default case, and `spawn_child_and_capture_snapshot` uses it when the test needs access to the child thread's config snapshot rather than request logs.

*Call graph*: calls 7 internal fn (mount_response_once_match, mount_sse_once_match, sse, sse_response, test_codex, wait_for_requests, wait_for_spawned_thread_id); called by 2 (setup_turn_one_with_spawned_child, spawn_child_and_capture_snapshot); 8 external calls (from_millis, from_secs, now, bail!, to_string, read_to_string, sleep, vec!).


##### `spawn_child_and_capture_snapshot`  (lines 451–473)

```
async fn spawn_child_and_capture_snapshot(
    server: &MockServer,
    spawn_args: serde_json::Value,
    configure_test: impl FnOnce(
        core_test_support::test_codex::TestCodexBuilder,
    ) -
```

**Purpose**: Spawns a child thread through the normal collaboration path and returns that child's `ThreadConfigSnapshot`. It is used to verify inherited versus overridden configuration values.

**Data flow**: It delegates to `setup_turn_one_with_custom_spawned_child` with no child delay and no parent-notification wait, parses the returned spawned id into a `ThreadId`, fetches the thread from `test.thread_manager`, awaits `config_snapshot()`, and returns the snapshot. It reads thread-manager state but does not modify it beyond the earlier spawned-turn setup.

**Call relations**: Configuration inheritance tests call this helper so they can assert directly on the child thread's resolved model and reasoning effort.

*Call graph*: calls 2 internal fn (setup_turn_one_with_custom_spawned_child, from_string); called by 2 (spawn_agent_requested_model_and_reasoning_override_inherited_settings_without_role, spawn_agent_role_overrides_requested_model_and_reasoning_settings).


##### `subagent_start_replaces_session_start_and_injects_context`  (lines 476–598)

```
async fn subagent_start_replaces_session_start_and_injects_context() -> Result<()>
```

**Purpose**: Verifies that a spawned worker subagent triggers `SubagentStart` rather than a second `SessionStart`, that hook payloads include the child agent identity, and that hook-provided additional context is injected into the child prompt. It also checks `UserPromptSubmit` payload differences between parent and child turns.

**Data flow**: The test starts a mock server, mounts a parent spawn response, mounts a child response whose matcher requires `CHILD_PROMPT` plus `SUBAGENT_START_CONTEXT` and excludes both `<subagent_notification>` and the spawn call id, mounts the parent follow-up, builds a `TestCodex` with pre-build hook files from `write_subagent_lifecycle_hooks`, trusts discovered hooks, enables collaboration, submits `TURN_1_PROMPT`, waits for the child request, then polls and inspects `subagent_start_hook_log.jsonl`, `user_prompt_submit_hook_log.jsonl`, and `session_start_hook_log.jsonl`. It asserts agent ids/types, confirms the root session start belongs to a different session than the child, and returns `Ok(())`.

**Call relations**: This test drives the hook fixture end to end: the mounted child matcher proves context injection happened on the wire, while the hook-log assertions prove the correct lifecycle hooks fired with the expected payloads.

*Call graph*: calls 7 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, wait_for_hook_log, wait_for_requests, wait_for_spawned_thread_id); 6 external calls (assert_eq!, assert_ne!, json!, to_string, skip_if_no_network!, vec!).


##### `subagent_stop_replaces_stop_and_skips_internal_subagents`  (lines 601–803)

```
async fn subagent_stop_replaces_stop_and_skips_internal_subagents() -> Result<()>
```

**Purpose**: Checks that child completion invokes `SubagentStop` instead of the normal `Stop` hook, that a blocking subagent-stop hook can force a continuation prompt and a second child turn, and that internal review subagents do not trigger the external subagent-stop path. It also validates transcript-path and last-message fields in the hook payloads.

**Data flow**: It mounts parent spawn, first child, second child continuation, parent follow-up, and internal-review responses; builds a `TestCodex` with lifecycle hooks configured to block the first subagent stop using `SUBAGENT_STOP_CONTINUATION`; submits `TURN_1_PROMPT`; waits for both child requests; polls `subagent_stop_hook_log.jsonl`; asserts two entries with `stop_hook_active` transitioning from `false` to `true`, stable parent/agent transcript paths, and the first child's last assistant message; reads `stop_hook_log.jsonl` to ensure the normal stop hook never saw the child completion; then manually starts an internal subagent thread with `SessionSource::SubAgent(SubAgentSource::Review)`, submits `INTERNAL_SUBAGENT_PROMPT` with explicit thread settings, waits for its turn to start and complete, confirms exactly one internal request was sent, and finally re-reads both hook logs to assert they were unchanged by the internal subagent.

**Call relations**: This is the most comprehensive lifecycle test in the file. It combines the hook fixture, thread-manager APIs, explicit thread startup, and event waiting to prove both replacement semantics and exclusion rules for internal subagents.

*Call graph*: calls 9 internal fn (mount_sse_once_match, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, read_hook_log, wait_for_hook_log, wait_for_requests); 11 external calls (default, new, SubAgent, assert!, assert_eq!, assert_ne!, wait_for_event_match, json!, to_string, skip_if_no_network! (+1 more)).


##### `subagent_notification_is_included_without_wait`  (lines 806–829)

```
async fn subagent_notification_is_included_without_wait() -> Result<()>
```

**Purpose**: Verifies that once a child has completed, a later parent turn submitted without an explicit wait still includes the serialized subagent notification in its request. This covers the no-wait follow-up path.

**Data flow**: It starts a mock server, uses `setup_turn_one_with_spawned_child` to create and complete the initial spawn scenario, mounts a second-turn response matching `TURN_2_NO_WAIT_PROMPT`, submits that prompt, waits for the captured request, and asserts that at least one request satisfies `has_subagent_notification`.

**Call relations**: The test depends on the shared setup helper to establish a completed child and then inspects the next parent request to ensure notification carry-forward works outside an explicit wait flow.

*Call graph*: calls 5 internal fn (mount_sse_once_match, sse, start_mock_server, setup_turn_one_with_spawned_child, wait_for_requests); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `spawned_child_receives_forked_parent_context`  (lines 832–926)

```
async fn spawned_child_receives_forked_parent_context() -> Result<()>
```

**Purpose**: Ensures that when `spawn_agent` is called with `fork_context: true`, the child request includes prior parent conversation context but not the raw spawn tool call metadata. It specifically checks that the seed prompt from an earlier turn is present in the child request body.

**Data flow**: It mounts a seed-turn response, a spawn-turn response whose spawn args include `fork_context: true`, a child response, and a parent follow-up; builds a collaboration-enabled `TestCodex`; submits `TURN_0_FORK_PROMPT` and then `TURN_1_PROMPT`; polls the mock server's received requests until it finds the child request containing `CHILD_PROMPT` but not `SPAWN_CALL_ID`; then asserts that the child request body contains `TURN_0_FORK_PROMPT` and excludes the spawn call id.

**Call relations**: Unlike tests that inspect `ResponseMock` logs, this one scans all received requests directly because it needs to locate the child request after multiple mounted interactions and verify inherited context content.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex); 10 external calls (from_millis, from_secs, now, bail!, assert!, json!, to_string, skip_if_no_network!, sleep, vec!).


##### `spawn_agent_requested_model_and_reasoning_override_inherited_settings_without_role`  (lines 929–952)

```
async fn spawn_agent_requested_model_and_reasoning_override_inherited_settings_without_role() -> Result<()>
```

**Purpose**: Confirms that explicit `model` and `reasoning_effort` fields in `spawn_agent` arguments override the parent's inherited settings when no role-specific config is involved.

**Data flow**: It starts a mock server, calls `spawn_child_and_capture_snapshot` with spawn args containing `CHILD_PROMPT`, `REQUESTED_MODEL`, and `REQUESTED_REASONING_EFFORT`, then asserts that the returned `ThreadConfigSnapshot` has those exact values.

**Call relations**: This test is a focused consumer of the snapshot helper, isolating the precedence rule for explicit spawn arguments over inherited parent defaults.

*Call graph*: calls 2 internal fn (start_mock_server, spawn_child_and_capture_snapshot); 3 external calls (assert_eq!, json!, skip_if_no_network!).


##### `spawned_multi_agent_v2_child_inherits_parent_developer_context`  (lines 955–1025)

```
async fn spawned_multi_agent_v2_child_inherits_parent_developer_context() -> Result<()>
```

**Purpose**: Verifies that under `Feature::MultiAgentV2`, a spawned child request inherits the parent's configured developer instructions. It ensures those instructions are present alongside the child task prompt.

**Data flow**: It mounts a parent spawn response, a child response, and a parent follow-up; builds a `TestCodex` with `Feature::Collab`, `Feature::MultiAgentV2`, and `developer_instructions` set to `Parent developer instructions.`; submits `TURN_1_PROMPT`; waits for the child request log; then asserts the last child request body contains both the developer instructions and `CHILD_PROMPT`.

**Call relations**: This test validates request construction on the MultiAgentV2 path by inspecting the actual child request emitted after a spawn.

*Call graph*: calls 5 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, wait_for_requests); 5 external calls (assert!, json!, to_string, skip_if_no_network!, vec!).


##### `encrypted_multi_agent_v2_spawn_sends_agent_message_to_child`  (lines 1028–1105)

```
async fn encrypted_multi_agent_v2_spawn_sends_agent_message_to_child() -> Result<()>
```

**Purpose**: Checks that a MultiAgentV2 spawn on an encrypted-capable model sends the child task as an `agent_message` input rather than plain user text. The test validates the exact structured payload delivered to the child.

**Data flow**: It starts a mock server, mounts a parent response that emits an un-namespaced `spawn_agent` function call with an opaque encrypted message, mounts a child response matched by the presence of `"type":"agent_message"`, mounts a parent follow-up excluding final-answer delivery, builds a `TestCodex` with model `koffing` and both collaboration features enabled, submits `TURN_1_PROMPT`, waits for the child request, extracts `inputs_of_type("agent_message")`, and asserts it equals a single JSON object with author `/root`, recipient `/root/worker`, an introductory `input_text` block, and an `encrypted_content` block carrying the opaque payload.

**Call relations**: This test covers the outbound parent-to-child mailbox format on the encrypted MultiAgentV2 path, using request inspection rather than thread snapshots or hook logs.

*Call graph*: calls 5 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, wait_for_requests); 4 external calls (assert_eq!, json!, to_string, vec!).


##### `plaintext_multi_agent_v2_completion_sends_agent_message`  (lines 1116–1242)

```
async fn plaintext_multi_agent_v2_completion_sends_agent_message(
    scenario: CompletionScenario,
) -> Result<()>
```

**Purpose**: Verifies that a child's completion is delivered back to the parent as a plaintext `agent_message` final answer in MultiAgentV2, both for normal completion and for terminal child stream failure. It also proves that a later parent turn can block in `wait_agent` until that mailbox delivery is available.

**Data flow**: Parameterized by `CompletionScenario`, it mounts a parent spawn response, a delayed child response whose events either complete normally or terminate after `response.created`, a parent follow-up that excludes final-answer delivery, an intermediate parent turn that calls `wait_agent`, and a final parent request matcher that requires `TURN_2_NO_WAIT_PROMPT`, `Message Type: FINAL_ANSWER`, and scenario-specific expected text. It builds a `TestCodex` with model `koffing`, collaboration features enabled, and both request and stream retries disabled; submits `TURN_1_PROMPT`; waits for the child request; submits `TURN_2_NO_WAIT_PROMPT`; captures the final parent request; and asserts that `inputs_of_type("agent_message")` contains exactly one message from `/root/worker` to `/root` whose text payload is either the child's assistant text or a synthesized terminal-error explanation mentioning `stream disconnected before completion: stream closed before response.completed`.

**Call relations**: This test ties together child execution, mailbox delivery, and parent wait behavior. The delayed child response ensures the parent's second turn exercises the `wait_agent` path before the final answer is injected into the follow-up request.

*Call graph*: calls 7 internal fn (mount_response_once_match, mount_sse_once_match, sse, sse_response, start_mock_server, test_codex, wait_for_requests); 6 external calls (from_secs, assert_eq!, format!, json!, to_string, vec!).


##### `skills_toggle_skips_instructions_for_parent_and_spawned_child`  (lines 1245–1322)

```
async fn skills_toggle_skips_instructions_for_parent_and_spawned_child() -> Result<()>
```

**Purpose**: Ensures that when `include_skill_instructions` is disabled, neither the parent request nor the spawned child request includes skill instruction blocks, even if a real home skill exists and MultiAgentV2 is enabled.

**Data flow**: It mounts parent spawn, child, and parent follow-up responses; builds a `TestCodex` whose pre-build hook writes a demo skill via `write_home_skill`, enables collaboration and MultiAgentV2, and sets `include_skill_instructions = false`; submits `TURN_1_PROMPT`; inspects the parent spawn request and the last child request; and asserts both omit `<skills_instructions>` and the skill name `demo-skill`.

**Call relations**: This test combines filesystem skill fixtures with request inspection to verify that the configuration toggle suppresses skill prompt injection consistently across parent and child requests.

*Call graph*: calls 5 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, wait_for_requests); 5 external calls (assert!, json!, to_string, skip_if_no_network!, vec!).


##### `spawn_agent_role_overrides_requested_model_and_reasoning_settings`  (lines 1325–1364)

```
async fn spawn_agent_role_overrides_requested_model_and_reasoning_settings() -> Result<()>
```

**Purpose**: Checks that when `spawn_agent` specifies an `agent_type` with a role config file, the role's locked model and reasoning effort override explicit `model` and `reasoning_effort` arguments from the spawn call.

**Data flow**: It starts a mock server and calls `spawn_child_and_capture_snapshot` with spawn args containing `agent_type: "custom"`, `REQUESTED_MODEL`, and `REQUESTED_REASONING_EFFORT`. The builder customization writes `custom-role.toml` under `config.codex_home`, inserts an `AgentRoleConfig` pointing at that file, and the test then asserts the child snapshot resolves to `ROLE_MODEL` and `ROLE_REASONING_EFFORT` instead of the requested values.

**Call relations**: This is the role-precedence counterpart to the earlier explicit-override test, using the same snapshot helper but a customized builder that installs role metadata.

*Call graph*: calls 2 internal fn (start_mock_server, spawn_child_and_capture_snapshot); 3 external calls (assert_eq!, json!, skip_if_no_network!).


##### `spawn_agent_tool_description_mentions_role_locked_settings`  (lines 1367–1437)

```
async fn spawn_agent_tool_description_mentions_role_locked_settings() -> Result<()>
```

**Purpose**: Verifies that tool-search metadata for `multi_agent_v1.spawn_agent` describes role-locked model and reasoning settings in the `agent_type` parameter documentation. It checks the exact rendered block for a custom role.

**Data flow**: It mounts an SSE sequence where the first response triggers `tool_search` and the second completes the turn, builds a `TestCodex` with collaboration enabled, `hide_spawn_agent_metadata = false`, and a `custom` role config file containing developer instructions plus locked model/reasoning settings, submits `TURN_1_PROMPT`, reads the second captured request from the response mock, extracts the tool-search output for the call id, locates the namespaced `spawn_agent` tool via `namespace_child_tool`, extracts the `agent_type` description with `tool_parameter_description`, isolates the `custom` block with `role_block`, and asserts it matches the expected multiline string mentioning immutable `gpt-5.4` and `high` reasoning effort.

**Call relations**: This test validates generated tool metadata rather than runtime child behavior. It chains several local helpers to navigate from raw tool-search output to the exact role-specific prose block under assertion.

*Call graph*: calls 6 internal fn (mount_sse_sequence, namespace_child_tool, start_mock_server, test_codex, role_block, tool_parameter_description); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


### Agent job orchestration
This group tests CSV-driven job spawning, result handling, and cancellation behavior for agent-backed work items.

### `core/tests/suite/agent_jobs.rs`

`test` · `request handling during integration tests`

This test file builds small wiremock responders that emulate the model-side control flow for the agent-jobs feature. `AgentJobsResponder` and `StopAfterFirstResponder` inspect each POST body, decode optional zstd-compressed payloads, distinguish tool-output follow-up requests from ordinary turns, and synthesize SSE streams that first ask Codex to call `spawn_agents_on_csv`, then for each worker-item request ask it to call `report_agent_job_result`. The responders detect worker-item prompts by extracting `Job ID` and `Item ID` from message text plus `instructions`, guarded by the invariant phrase "You are processing one item for a generic agent job." Atomic flags/counters ensure the main spawn call is emitted once and worker call IDs are unique; the stop variant marks only the first worker result with `stop: true`.

The tests enable `Feature::SpawnCsv` and `Feature::Sqlite`, create temporary CSV inputs in the harness working directory, mount the responder on `POST .*/responses$`, and submit a natural-language turn. Assertions then inspect exported CSV files and the SQLite-backed state DB. Coverage includes rejecting a result reported from the wrong thread ID, exporting result columns, deduplicating duplicate source IDs into `foo`/`foo-2`, and halting future items when a worker requests stop under `max_concurrency: 1`. The helper CSV parser is intentionally simplistic—plain comma splitting—because the fixtures avoid quoting/escaping complexity.

#### Function details

##### `AgentJobsResponder::new`  (lines 31–37)

```
fn new(spawn_args_json: String) -> Self
```

**Purpose**: Constructs the standard mock responder used by most agent-job tests. It seeds the responder with serialized spawn arguments and resets its one-shot main-call and worker-call counters.

**Data flow**: Takes a `String` containing the JSON arguments that should be passed to `spawn_agents_on_csv`. It stores that string, initializes `seen_main` to `false` and `call_counter` to `0`, and returns a new `AgentJobsResponder` value.

**Call relations**: The setup phase of the happy-path, dedupe, and wrong-thread tests creates this responder before mounting it on the mock `/responses` endpoint so later HTTP requests can be answered deterministically.

*Call graph*: called by 3 (report_agent_job_result_rejects_wrong_thread, spawn_agents_on_csv_dedupes_item_ids, spawn_agents_on_csv_runs_and_exports); 2 external calls (new, new).


##### `StopAfterFirstResponder::new`  (lines 47–53)

```
fn new(spawn_args_json: String, worker_calls: Arc<AtomicUsize>) -> Self
```

**Purpose**: Constructs the cancellation-oriented responder variant that asks the first worker to stop the job. It shares an external atomic counter so the test can assert how many worker requests actually occurred.

**Data flow**: Accepts the serialized spawn-arguments JSON and an `Arc<AtomicUsize>` tracking worker invocations. It stores both, initializes `seen_main` to `false`, and returns a configured `StopAfterFirstResponder`.

**Call relations**: Only the stop/cancellation test uses this constructor before mounting the responder, so later worker requests can flip `stop` on the first item and expose the total worker-call count back to the test.

*Call graph*: called by 1 (spawn_agents_on_csv_stop_halts_future_items); 1 external calls (new).


##### `StopAfterFirstResponder::respond`  (lines 57–98)

```
fn respond(&self, request: &wiremock::Request) -> ResponseTemplate
```

**Purpose**: Implements the mock Responses API behavior for the stop-after-first scenario. It emits a spawn tool call on the first main request, emits one worker result with `stop: true`, then returns inert completed responses for tool-output acknowledgements and any later requests.

**Data flow**: Reads the incoming `wiremock::Request`, decodes its body bytes with `decode_body_bytes`, and parses JSON into `serde_json::Value`. If `has_function_call_output` is true, it returns an SSE response containing only `response.created` and `response.completed`. Otherwise, if `extract_job_and_item` finds a worker prompt, it increments `worker_calls`, derives `call-worker-{index}`, builds JSON args containing `job_id`, `item_id`, a result object, and `stop` set only when `index == 0`, serializes them, and returns an SSE stream with a `report_agent_job_result` function call. If neither case matches and `seen_main` was previously false, it atomically marks the main request as seen and returns a `spawn_agents_on_csv` function call using the stored spawn args. All remaining requests get a default empty completed SSE response.

**Call relations**: Wiremock invokes this for every POST to the mocked responses endpoint in the cancellation test. Its branching mirrors Codex’s expected multi-turn flow: initial model turn → spawn tool output acknowledgement → worker turn → worker tool output acknowledgement, with the first worker response intentionally delegating cancellation back into the system under test.

*Call graph*: calls 5 internal fn (sse, sse_response, decode_body_bytes, extract_job_and_item, has_function_call_output); 6 external calls (swap, format!, json!, from_slice, to_string, vec!).


##### `AgentJobsResponder::respond`  (lines 102–143)

```
fn respond(&self, request: &wiremock::Request) -> ResponseTemplate
```

**Purpose**: Implements the normal mock Responses API behavior for agent-job tests without cancellation. It emits one spawn call, then emits worker result tool calls for each detected item prompt.

**Data flow**: Consumes a `wiremock::Request`, decodes and parses the body JSON, and first short-circuits tool-output follow-up requests by returning a minimal completed SSE stream. If the request body describes a worker-item prompt, it increments `call_counter`, formats a unique `call-worker-N` ID, builds and serializes JSON containing `job_id`, `item_id`, and a result object, and returns an SSE stream with `report_agent_job_result`. If no worker prompt is present and `seen_main` was false, it atomically flips that flag and returns an SSE stream with `spawn_agents_on_csv` using the stored spawn args. Otherwise it returns a default completed response.

**Call relations**: Mounted by the non-cancellation tests, this responder drives the system through the expected orchestration path: first a batch-spawn tool call, then one synthetic worker result per item, while acknowledging Codex’s tool outputs with empty follow-up responses.

*Call graph*: calls 5 internal fn (sse, sse_response, decode_body_bytes, extract_job_and_item, has_function_call_output); 6 external calls (swap, format!, json!, from_slice, to_string, vec!).


##### `decode_body_bytes`  (lines 146–163)

```
fn decode_body_bytes(request: &wiremock::Request) -> Vec<u8>
```

**Purpose**: Normalizes request bodies so tests can inspect both plain and zstd-compressed JSON payloads. It is defensive: failed decompression falls back to the original bytes.

**Data flow**: Reads the request headers for `content-encoding`; if absent, it clones and returns `request.body`. If the comma-separated encodings include `zstd` case-insensitively, it attempts `zstd::stream::decode_all` over a cursor of the body bytes and returns the decoded bytes on success, otherwise the original body clone. Non-zstd encodings also return the original body clone.

**Call relations**: Both responder implementations call this before parsing JSON so the tests remain valid whether request compression is enabled or disabled in the client.

*Call graph*: calls 1 internal fn (new); called by 2 (respond, respond); 1 external calls (decode_all).


##### `has_function_call_output`  (lines 165–173)

```
fn has_function_call_output(body: &Value) -> bool
```

**Purpose**: Detects whether a request is a follow-up carrying tool output rather than a fresh model prompt. The responders use this to return a no-op completion instead of recursively issuing more tool calls.

**Data flow**: Reads `body["input"]` as an array and scans its items for any object whose `type` field is the string `function_call_output`. It returns `true` if such an item exists, otherwise `false`.

**Call relations**: Called early by both responders to separate acknowledgement turns from initial/main or worker-item turns.

*Call graph*: called by 2 (respond, respond); 1 external calls (get).


##### `extract_job_and_item`  (lines 175–196)

```
fn extract_job_and_item(body: &Value) -> Option<(String, String)>
```

**Purpose**: Recognizes worker-item prompts and extracts the job and item identifiers embedded in their text. It intentionally refuses unrelated requests by checking for a fixed worker prompt marker.

**Data flow**: Starts from `message_input_texts(body)`, joins those texts with newlines, appends `body["instructions"]` if present, and returns `None` unless the combined text contains the exact worker sentinel sentence. It then compiles regexes for `Job ID:` and `Item ID:`, captures the first non-newline value after each label, trims them, converts them to owned `String`s, and returns `Some((job_id, item_id))` if both are found.

**Call relations**: Both responders call this after ruling out tool-output requests; a successful parse means the incoming request is a worker execution turn and should trigger a `report_agent_job_result` tool call.

*Call graph*: calls 1 internal fn (message_input_texts); called by 2 (respond, respond); 2 external calls (new, get).


##### `message_input_texts`  (lines 198–211)

```
fn message_input_texts(body: &Value) -> Vec<String>
```

**Purpose**: Extracts plain input-text spans from message items in a Responses request body. It ignores non-message items and non-text content spans.

**Data flow**: Reads `body["input"]` as an array; if absent, returns an empty `Vec<String>`. It filters items whose `type` is `message`, descends into each `content` array, keeps spans whose `type` is `input_text`, pulls their `text` strings, clones them into owned `String`s, and collects them.

**Call relations**: Used only by `extract_job_and_item` to inspect the human-readable prompt content that identifies worker-item requests.

*Call graph*: called by 1 (extract_job_and_item); 2 external calls (get, new).


##### `parse_simple_csv_line`  (lines 213–215)

```
fn parse_simple_csv_line(line: &str) -> Vec<String>
```

**Purpose**: Provides a minimal CSV splitter for the test fixtures’ unquoted comma-separated lines. It is sufficient because the generated fixture files contain no escaped commas or quotes.

**Data flow**: Takes a `&str`, splits on literal commas, converts each segment to `String`, and returns the resulting vector.

**Call relations**: The duplicate-ID test uses it to locate the `item_id` column and inspect output rows after export.

*Call graph*: called by 1 (spawn_agents_on_csv_dedupes_item_ids).


##### `report_agent_job_result_rejects_wrong_thread`  (lines 218–281)

```
async fn report_agent_job_result_rejects_wrong_thread() -> Result<()>
```

**Purpose**: Verifies that the state DB rejects an agent-job item result reported from a thread ID other than the worker thread that owns the item. It also confirms the batch job still ran and exported one row.

**Data flow**: Starts a mock server, builds a test harness with `SpawnCsv` and `Sqlite` enabled, writes a one-row input CSV, serializes spawn arguments including input/output paths, mounts `AgentJobsResponder`, and submits a turn. After the run, it reads the output CSV, extracts the generated job UUID-like value from the first data row, queries the state DB for that job and its items, then calls `report_agent_job_item_result` with a hard-coded all-zero thread ID and a JSON payload. It asserts the returned `accepted` flag is `false` and returns `Ok(())`.

**Call relations**: This is a top-level async test. It drives the full spawn/export flow first, then directly exercises the DB API to validate the thread-ownership guard after the mocked model interactions have created the job and item records.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, new); 9 external calls (given, assert!, assert_eq!, read_to_string, write, json!, to_string, method, path_regex).


##### `spawn_agents_on_csv_runs_and_exports`  (lines 284–323)

```
async fn spawn_agents_on_csv_runs_and_exports() -> Result<()>
```

**Purpose**: Checks the basic happy path for CSV batch spawning and export. It ensures the output CSV contains result-related columns and serialized result content.

**Data flow**: Builds a feature-enabled test harness, writes a two-row input CSV, serializes spawn arguments with input/output paths and an instruction template, mounts `AgentJobsResponder`, and submits a batch-job turn. After completion it reads the output CSV text and asserts that it contains `result_json`, `item_id`, and a JSON string containing `"item_id"`.

**Call relations**: As a top-level integration test, it relies on the responder to trigger `spawn_agents_on_csv` and per-item `report_agent_job_result` calls, then validates the exported artifact produced by the system under test.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, new); 8 external calls (given, assert!, read_to_string, write, json!, to_string, method, path_regex).


##### `spawn_agents_on_csv_dedupes_item_ids`  (lines 326–382)

```
async fn spawn_agents_on_csv_dedupes_item_ids() -> Result<()>
```

**Purpose**: Verifies that duplicate source IDs in the input CSV are made unique in the exported job items. The expected suffixing behavior is `foo` for the first row and `foo-2` for the second.

**Data flow**: Creates a harness with the required features, writes an input CSV whose `id` column repeats `foo`, serializes spawn arguments including `id_column`, mounts `AgentJobsResponder`, and submits the batch turn. It then reads the output CSV, parses the header to find the `item_id` column index, parses each remaining line with `parse_simple_csv_line`, collects the item IDs, sorts and deduplicates them, and asserts there are exactly two unique IDs containing `foo` and `foo-2`.

**Call relations**: This test uses the normal responder-driven spawn/result flow, then inspects the exported CSV to confirm the deduplication logic inside the batch-job implementation.

*Call graph*: calls 4 internal fn (start_mock_server, test_codex, new, parse_simple_csv_line); 10 external calls (given, new, assert!, assert_eq!, read_to_string, write, json!, to_string, method, path_regex).


##### `spawn_agents_on_csv_stop_halts_future_items`  (lines 385–444)

```
async fn spawn_agents_on_csv_stop_halts_future_items() -> Result<()>
```

**Purpose**: Confirms that when the first worker reports `stop: true`, the job is cancelled and no further worker turns are launched. It also checks the persisted progress counters.

**Data flow**: Builds the feature-enabled harness, writes a three-row input CSV, serializes spawn arguments with `max_concurrency: 1`, creates a shared `Arc<AtomicUsize>` worker counter, mounts `StopAfterFirstResponder`, and submits the turn. After completion it reads the output CSV, extracts the job ID from the first row, loads the job and progress from the state DB, and asserts status `Cancelled`, totals of 3 items with 1 completed / 0 failed / 0 running / 2 pending, and exactly one worker call observed in the atomic counter.

**Call relations**: This top-level test depends on the stop-aware responder to inject the `stop` flag on the first worker result. The assertions verify that the orchestration layer honored that signal by cancelling the remaining queued items.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, new); 10 external calls (new, new, given, assert_eq!, read_to_string, write, json!, to_string, method, path_regex).


### Remote environment execution
These tests validate isolated execution in remote environments, including filesystem access, environment selection, permissions, and sandbox behavior.

### `core/tests/suite/remote_env.rs`

`test` · `integration test execution for remote environment turns and filesystem operations`

This test module focuses on the interaction between Codex turns and a configured remote execution environment, usually a Docker-backed POSIX target. It contains small helpers for constructing a `TestCodex` with unified exec enabled, submitting turns with explicit `TurnEnvironmentSelection` values, and waiting for approval-related events (`ApplyPatchApprovalRequest`, `RequestPermissions`, `ExecApprovalRequest`, `TurnComplete`). The tests cover both model-visible metadata and actual side effects: one test confirms the remote filesystem implementation can create, read, and delete files directly; another inspects the serialized `<environment_context>` sent to the model and checks that the exposed shell matches the target environment (`bash` for Docker, `powershell` for Wine-exec).

A second cluster of tests verifies routing. They mount SSE sequences that emit `exec_command`, freeform `apply_patch`, or `exec_command` carrying an intercepted `apply_patch` heredoc, then submit turns with both local and remote environment selections. Assertions confirm that writes and reads happen only in the selected remote cwd and never leak into the local temp directory. Permission tests go further by enabling `UnifiedExec`, `ExecPermissionApprovals`, and `RequestPermissionsTool`, approving a remote `request_permissions` call, and proving that the resulting turn-scoped grant suppresses later exec approval for the same remote environment.

The file also probes sandbox correctness on the remote filesystem. It constructs `FileSystemSandboxContext` values from restricted runtime permission profiles, then checks allowed reads, rejection of symlink-plus-`..` escape attempts after path normalization, removal semantics that delete a symlink rather than its target, and copy semantics that preserve symlink identity. Several tests are skipped when no remote env is configured, when networking is unavailable, or when Wine-exec would invalidate POSIX-specific assumptions.

#### Function details

##### `unified_exec_test`  (lines 61–71)

```
async fn unified_exec_test(server: &wiremock::MockServer) -> Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` configured to use the experimental unified exec tool with the `UnifiedExec` feature explicitly enabled. It is the common setup path for tests that need remote/local environment routing through unified exec.

**Data flow**: Takes a mock `wiremock::MockServer` reference, mutates the test builder config to set `use_experimental_unified_exec_tool = true` and enable `Feature::UnifiedExec`, asserts that feature enabling succeeded, then asynchronously builds and returns a `TestCodex` wired with both remote and local environments.

**Call relations**: This helper is invoked by the exec-routing and intercepted-apply-patch tests when they need the runtime to dispatch `exec_command` through unified exec rather than legacy shell behavior.

*Call graph*: calls 1 internal fn (test_codex); called by 2 (apply_patch_intercepted_exec_command_routes_to_selected_remote_environment, exec_command_routes_to_selected_remote_environment).


##### `submit_turn_with_approval_and_environments`  (lines 73–110)

```
async fn submit_turn_with_approval_and_environments(
    test: &TestCodex,
    prompt: &str,
    environments: Vec<TurnEnvironmentSelection>,
) -> Result<()>
```

**Purpose**: Submits a user turn whose thread settings explicitly select environments and require user-reviewed approvals. It standardizes the approval policy, reviewer, sandbox policy, and collaboration mode used by approval-sensitive remote tests.

**Data flow**: Consumes a `&TestCodex`, prompt text, and a `Vec<TurnEnvironmentSelection>`. It wraps the selections in `TurnEnvironmentSelections::new(test.config.cwd.clone(), environments)`, builds an `Op::UserInput` containing one `UserInput::Text`, sets `approval_policy` to `AskForApproval::OnRequest`, `approvals_reviewer` to `ApprovalsReviewer::User`, `sandbox_policy` to `SandboxPolicy::new_read_only_policy()`, and a default collaboration mode using `test.session_configured.model`, then submits the op and returns `Result<()>`.

**Call relations**: Approval-memory and remote request-permissions tests call this helper before waiting for either a permission prompt or patch approval. It does not delegate to other local helpers; instead it directly constructs the turn payload expected by those tests.

*Call graph*: calls 1 internal fn (new); called by 2 (apply_patch_approvals_are_remembered_per_environment, remote_request_permissions_grant_unblocks_later_remote_exec); 3 external calls (default, new_read_only_policy, vec!).


##### `expect_patch_approval`  (lines 112–132)

```
async fn expect_patch_approval(
    test: &TestCodex,
    expected_call_id: &str,
) -> ApplyPatchApprovalRequestEvent
```

**Purpose**: Waits until either a patch approval request or turn completion arrives, and fails unless the next relevant event is the expected patch approval. It also verifies the approval event belongs to the expected tool call id.

**Data flow**: Reads events from `test.codex` via `wait_for_event`, filtering for `EventMsg::ApplyPatchApprovalRequest` or `EventMsg::TurnComplete`. On approval, it asserts `approval.call_id == expected_call_id` and returns the `ApplyPatchApprovalRequestEvent`; on completion or any other event shape it panics.

**Call relations**: Used only by the per-environment approval-memory test to enforce that the first local patch and first remote patch each trigger a distinct approval before the turn can complete.

*Call graph*: called by 1 (apply_patch_approvals_are_remembered_per_environment); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `wait_for_completion_without_patch_approval`  (lines 134–150)

```
async fn wait_for_completion_without_patch_approval(test: &TestCodex)
```

**Purpose**: Asserts that a turn reaches completion without emitting any patch approval request. It is the inverse of `expect_patch_approval` for follow-up operations that should already be preapproved.

**Data flow**: Consumes `&TestCodex`, waits for the first event matching either `ApplyPatchApprovalRequest` or `TurnComplete`, and returns unit only if that event is `TurnComplete`; otherwise it panics with the unexpected approval call id or event.

**Call relations**: The approval-memory test uses this after a remote approval has already been granted for the session, proving that a subsequent remote patch skips the approval prompt.

*Call graph*: called by 1 (apply_patch_approvals_are_remembered_per_environment); 2 external calls (wait_for_event, panic!).


##### `remote_test_env_can_connect_and_use_filesystem`  (lines 153–185)

```
async fn remote_test_env_can_connect_and_use_filesystem() -> Result<()>
```

**Purpose**: Verifies the remote test environment exposes a working filesystem implementation capable of basic write, read, and remove operations.

**Data flow**: Checks `get_remote_test_env()` and exits early with `Ok(())` if no remote env is configured. Otherwise it creates a `TestEnvironment`, obtains its filesystem, writes a byte payload to a path under the test cwd using `PathUri`, reads the file back, asserts byte equality, removes the file with `RemoveOptions { recursive: false, force: true }`, and returns success.

**Call relations**: This is a standalone smoke test at the bottom of the stack: it does not depend on mock model responses and directly validates the remote filesystem transport before higher-level routing tests run.

*Call graph*: calls 2 internal fn (test_env, from_path); 2 external calls (assert_eq!, get_remote_test_env).


##### `remote_test_env_exposes_target_shell_to_model`  (lines 188–229)

```
async fn remote_test_env_exposes_target_shell_to_model() -> Result<()>
```

**Purpose**: Checks that the environment context injected into model-visible input includes the target shell for the remote environment. The test ensures the orchestrator does not hide whether the target is POSIX or Wine-exec.

**Data flow**: Skips if no remote env exists, starts a mock server, mounts a single SSE response, builds a remote-only `TestCodex`, submits a turn, inspects the captured request body, extracts the user-visible `<environment_context>` text, computes the expected `<shell>` line from `core_test_support::test_environment()`, and asserts the serialized shell tag matches.

**Call relations**: This test is independent of filesystem side effects; it validates request construction by observing the outbound model request captured by the mounted SSE mock.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (assert_eq!, get_remote_test_env, test_environment, unreachable!, vec!).


##### `absolute_path`  (lines 231–233)

```
fn absolute_path(path: PathBuf) -> AbsolutePathBuf
```

**Purpose**: Converts a `PathBuf` into an `AbsolutePathBuf` and crashes the test if the path is not absolute. It centralizes the absolute-path invariant required by sandbox permission builders.

**Data flow**: Takes ownership of a `PathBuf`, calls `AbsolutePathBuf::try_from`, and returns the converted absolute path or panics with a fixed message.

**Call relations**: Used by both sandbox-construction helpers and one symlink-removal test to ensure permission profiles and metadata lookups always use canonical absolute paths.

*Call graph*: calls 1 internal fn (try_from); called by 3 (read_only_sandbox, remote_test_env_remove_removes_symlink_not_target, workspace_write_sandbox).


##### `read_only_sandbox`  (lines 235–246)

```
fn read_only_sandbox(readable_root: PathBuf) -> FileSystemSandboxContext
```

**Purpose**: Builds a restricted filesystem sandbox context that grants read access only to a single root and denies network access. It is tailored for remote read-path tests.

**Data flow**: Accepts a readable root `PathBuf`, normalizes it through `absolute_path`, constructs a `FileSystemSandboxPolicy::restricted` with one `FileSystemSandboxEntry` using `FileSystemAccessMode::Read`, wraps it with `PermissionProfile::from_runtime_permissions(..., NetworkSandboxPolicy::Restricted)`, and converts that profile into a `FileSystemSandboxContext`.

**Call relations**: Called by the allowed-read test and the symlink-parent-escape rejection test so both operate under the same narrow read-only sandbox semantics.

*Call graph*: calls 4 internal fn (absolute_path, from_permission_profile, from_runtime_permissions, restricted); called by 2 (remote_test_env_sandboxed_read_allows_readable_root, remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape); 1 external calls (vec!).


##### `workspace_write_sandbox`  (lines 248–259)

```
fn workspace_write_sandbox(writable_root: PathBuf) -> FileSystemSandboxContext
```

**Purpose**: Builds a restricted filesystem sandbox context that grants write access only to a single root and denies network access. It is used for remote mutation tests involving symlinks.

**Data flow**: Takes a writable root `PathBuf`, converts it to `AbsolutePathBuf`, creates a restricted filesystem policy with one write-capable `FileSystemSandboxEntry`, wraps it in a runtime `PermissionProfile`, and returns the resulting `FileSystemSandboxContext`.

**Call relations**: The symlink-removal and symlink-copy tests use this helper to ensure the operation is authorized only within the allowed directory while still checking that symlink semantics are preserved.

*Call graph*: calls 4 internal fn (absolute_path, from_permission_profile, from_runtime_permissions, restricted); called by 2 (remote_test_env_copy_preserves_symlink_source, remote_test_env_remove_removes_symlink_not_target); 1 external calls (vec!).


##### `assert_normalized_path_rejected`  (lines 261–278)

```
fn assert_normalized_path_rejected(error: &std::io::Error)
```

**Purpose**: Accepts the I/O error from a rejected normalized path access and validates that the failure mode is one of the expected sandbox/path-normalization outcomes. It tolerates platform-specific wording while still rejecting unrelated errors.

**Data flow**: Reads `error.kind()` and `error.to_string()`, then matches on `NotFound`, `InvalidInput`, or `PermissionDenied`. For each accepted kind it asserts the message contains one of several expected substrings; any other error kind triggers a panic.

**Call relations**: Only the symlink-plus-`..` escape test calls this helper after intentionally provoking a normalized-path rejection from the remote filesystem.

*Call graph*: called by 1 (remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape); 4 external calls (assert!, kind, to_string, panic!).


##### `remote_exec`  (lines 280–295)

```
fn remote_exec(script: &str) -> Result<()>
```

**Purpose**: Runs an arbitrary shell script directly inside the configured Docker-backed remote test container. It is a fixture helper for creating or cleaning up symlink-heavy filesystem layouts that are awkward to express through the abstract filesystem API.

**Data flow**: Looks up the remote test environment, extracts its Docker container name, invokes `docker exec <container> sh -lc <script>` via `std::process::Command`, checks the exit status, and returns `Ok(())` or fails the test with captured stdout/stderr.

**Call relations**: The POSIX-specific sandbox, remove, and copy tests call this helper to prepare symlink structures and to tear them down outside the code path under test.

*Call graph*: called by 3 (remote_test_env_copy_preserves_symlink_source, remote_test_env_remove_removes_symlink_not_target, remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape); 3 external calls (assert!, new, get_remote_test_env).


##### `exec_command_routing_output`  (lines 297–327)

```
async fn exec_command_routing_output(
    test: &TestCodex,
    server: &wiremock::MockServer,
    call_id: &str,
    arguments: Value,
    environments: Option<Vec<TurnEnvironmentSelection>>,
) -> Re
```

**Purpose**: Drives a two-response mock conversation where the model first emits an `exec_command` tool call and then a final assistant message, returning the captured tool output text for assertions. It abstracts the repetitive SSE setup used by routing tests.

**Data flow**: Takes a `TestCodex`, mock server, call id, JSON arguments, and optional environment selections. It mounts an SSE sequence containing a function call named `exec_command` with the serialized arguments, submits a turn through `test.submit_turn_with_environments`, then extracts and returns the function-call output text for the given call id, attaching context if missing.

**Call relations**: The remote exec-routing test uses this helper to focus on asserting output provenance rather than rebuilding the same mock sequence inline.

*Call graph*: calls 2 internal fn (mount_sse_sequence, submit_turn_with_environments); called by 1 (exec_command_routes_to_selected_remote_environment); 1 external calls (vec!).


##### `exec_command_routes_to_selected_remote_environment`  (lines 330–404)

```
async fn exec_command_routes_to_selected_remote_environment() -> Result<()>
```

**Purpose**: Proves that unified exec honors `environment_id` and executes in the selected remote cwd even when both local and remote environments are available in the turn.

**Data flow**: After network and environment guards, it builds a unified-exec `TestCodex`, creates a local temp cwd with `marker.txt = local-routing`, creates a unique remote cwd and remote marker file via the remote filesystem API, submits an `exec_command` targeting `REMOTE_ENVIRONMENT_ID` that cats the marker, asserts the output contains `remote-routing` and not `local-routing`, then removes the remote directory.

**Call relations**: This test depends on `unified_exec_test` for setup and `exec_command_routing_output` for the mocked tool-call round trip. It is the primary proof that environment selection affects command routing.

*Call graph*: calls 6 internal fn (start_mock_server, local, exec_command_routing_output, unified_exec_test, from_abs_path, from_path); 10 external calls (from, new, assert!, get_remote_test_env, format!, write, json!, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `remote_request_permissions_grant_unblocks_later_remote_exec`  (lines 407–610)

```
async fn remote_request_permissions_grant_unblocks_later_remote_exec() -> Result<()>
```

**Purpose**: Verifies that a granted remote `request_permissions` call produces a turn-scoped permission grant that preapproves a later remote `exec_command` write in the same turn. It also checks that the write lands only in the remote environment.

**Data flow**: Builds a `TestCodex` with unified exec, on-request approvals, user reviewer, and features `UnifiedExec`, `ExecPermissionApprovals`, and `RequestPermissionsTool`. It prepares parallel local and remote directories, mounts an SSE sequence where the model first calls `request_permissions` for a remote write root and then `exec_command` to write a file under that root, submits a turn with both environment selections, waits for `EventMsg::RequestPermissions`, asserts the request carries `environment_id`, remote cwd, and the expected `RequestPermissionProfile`, submits `Op::RequestPermissionsResponse` approving the grant for the turn, confirms no `ExecApprovalRequest` follows, inspects the mock outputs, reads the remote file contents through `test.fs()`, asserts the local counterpart does not exist, and cleans up the remote cwd.

**Call relations**: This test uses `submit_turn_with_approval_and_environments` to create the turn, then manually drives the approval response path. It demonstrates the interaction between request-permissions state and later exec approval suppression in a remote environment.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_turn_with_approval_and_environments, from_read_write_roots, from_abs_path, from_path); 14 external calls (from, new, default, assert!, assert_eq!, get_remote_test_env, wait_for_event, format!, create_dir, panic! (+4 more)).


##### `apply_patch_freeform_routes_to_selected_remote_environment`  (lines 613–698)

```
async fn apply_patch_freeform_routes_to_selected_remote_environment() -> Result<()>
```

**Purpose**: Checks that a freeform `apply_patch` custom tool call with an explicit remote environment id writes into the selected remote cwd rather than the local workspace.

**Data flow**: Creates local and remote working directories, mounts an SSE sequence whose first response is an `apply_patch` custom tool call containing `*** Environment ID: <remote>` and an add-file patch, submits a turn with both local and remote selections, reads the created file from the remote cwd via `test.fs()`, asserts its contents equal `patched remote freeform\n`, asserts the local temp dir lacks the file, then removes the remote directory.

**Call relations**: This is a standalone routing test for the freeform patch path, complementary to the exec-command routing tests and the intercepted apply_patch test.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, from_path); 9 external calls (from, new, assert!, assert_eq!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `apply_patch_approvals_are_remembered_per_environment`  (lines 701–885)

```
async fn apply_patch_approvals_are_remembered_per_environment() -> Result<()>
```

**Purpose**: Ensures patch approvals are tracked separately per environment: approving a local patch does not preapprove a remote patch, but approving one remote patch does preapprove later remote patches in the same session.

**Data flow**: Builds a `TestCodex` with on-request approvals and user reviewer, prepares local and remote directories plus a shared absolute target path, mounts six SSE responses representing three turns (local patch, remote patch, remote follow-up patch), submits the first turn and uses `expect_patch_approval` to capture `call-local`, approves it for session, waits for completion, and verifies the local filesystem content. It then submits the second turn, captures and approves `call-remote`, waits for completion, verifies the remote file content through `test.fs()`, submits the third turn, uses `wait_for_completion_without_patch_approval` to assert no new prompt appears, verifies the remote update, and finally removes both local and remote artifacts.

**Call relations**: This test is the only caller of both patch-approval waiting helpers. It exercises approval caching behavior across multiple turns and across distinct environment ids.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_patch_approval, submit_turn_with_approval_and_environments, wait_for_completion_without_patch_approval, from_path); 10 external calls (from, new, assert_eq!, get_remote_test_env, wait_for_event, format!, remove_file, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `apply_patch_intercepted_exec_command_routes_to_selected_remote_environment`  (lines 888–983)

```
async fn apply_patch_intercepted_exec_command_routes_to_selected_remote_environment() -> Result<()>
```

**Purpose**: Verifies that when an `exec_command` contains an `apply_patch` heredoc and unified exec intercepts it, the resulting patch still targets the selected remote environment.

**Data flow**: Builds a unified-exec `TestCodex`, creates local and remote directories, constructs a patch string and wraps it in a shell command `apply_patch <<'EOF' ... EOF`, mounts an SSE sequence with an `exec_command` call specifying `environment_id = REMOTE_ENVIRONMENT_ID`, submits a turn with both environment selections, reads the created file from the remote cwd, asserts the remote contents and absence of a local file, then removes the remote directory.

**Call relations**: This test reuses `unified_exec_test` because interception happens in the unified exec path. It complements the freeform patch test by covering the shell-command interception route.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, unified_exec_test, from_path); 9 external calls (from, new, assert!, assert_eq!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `remote_test_env_sandboxed_read_allows_readable_root`  (lines 986–1034)

```
async fn remote_test_env_sandboxed_read_allows_readable_root() -> Result<()>
```

**Purpose**: Confirms that a remote filesystem read succeeds when the requested file lies under the sandbox's explicitly readable root.

**Data flow**: After environment guards, it creates a remote directory and file through the filesystem API, builds a read-only sandbox for that directory with `read_only_sandbox`, reads the file with that sandbox attached, asserts the bytes match `sandboxed hello`, and removes the directory tree.

**Call relations**: This is the positive control for the remote sandbox tests; it establishes that the restricted sandbox permits intended reads before the escape test checks denial behavior.

*Call graph*: calls 3 internal fn (test_env, read_only_sandbox, from_path); 6 external calls (from, assert_eq!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!).


##### `remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape`  (lines 1037–1070)

```
async fn remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape() -> Result<()>
```

**Purpose**: Tests that path normalization defeats a symlink-plus-parent traversal attempt that would otherwise escape the allowed root. The remote filesystem must reject the normalized path rather than following the textual path shape.

**Data flow**: Creates a remote directory tree directly in the container with `remote_exec`, including `allowed/link -> outside` and a sibling `secret.txt`. It then requests `allowed/link/../secret.txt` through the filesystem API under a read-only sandbox rooted at `allowed`, expects `read_file` to fail, validates the resulting `std::io::Error` with `assert_normalized_path_rejected`, and removes the fixture tree with `remote_exec`.

**Call relations**: This test combines `remote_exec`, `read_only_sandbox`, and `assert_normalized_path_rejected` to probe a subtle normalization invariant in the remote filesystem implementation.

*Call graph*: calls 5 internal fn (test_env, assert_normalized_path_rejected, read_only_sandbox, remote_exec, from_path); 6 external calls (from, bail!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!).


##### `remote_test_env_remove_removes_symlink_not_target`  (lines 1073–1141)

```
async fn remote_test_env_remove_removes_symlink_not_target() -> Result<()>
```

**Purpose**: Verifies that removing a symlink inside a writable sandbox deletes the link itself and leaves the external target file untouched.

**Data flow**: Uses `remote_exec` to create a root tree with `allowed/link` pointing to an outside file, builds a write sandbox rooted at `allowed`, calls the filesystem `remove` on the symlink path, checks via `get_metadata` that the symlink no longer exists, reads the outside file to confirm it still contains `outside`, and removes the whole root tree.

**Call relations**: This test relies on `workspace_write_sandbox` for authorization and on direct container setup from `remote_exec` to create the symlink topology under test.

*Call graph*: calls 6 internal fn (test_env, absolute_path, remote_exec, workspace_write_sandbox, from_abs_path, from_path); 7 external calls (from, assert!, assert_eq!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!).


##### `remote_test_env_copy_preserves_symlink_source`  (lines 1144–1217)

```
async fn remote_test_env_copy_preserves_symlink_source() -> Result<()>
```

**Purpose**: Checks that copying a symlink inside the remote filesystem preserves it as a symlink to the same target instead of dereferencing and copying the target file contents.

**Data flow**: Creates a remote tree with an outside file and a source symlink under the allowed directory, builds a write sandbox, invokes filesystem `copy` from the source symlink to a new path, then shells into the Docker container with `readlink` to inspect the copied symlink target and assert it equals the outside file path. Finally it removes the root tree.

**Call relations**: This test pairs `remote_exec` fixture setup with `workspace_write_sandbox` authorization and an out-of-band `docker exec readlink` verification step to confirm symlink identity was preserved.

*Call graph*: calls 4 internal fn (test_env, remote_exec, workspace_write_sandbox, from_path); 8 external calls (from, assert!, assert_eq!, new, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!).
