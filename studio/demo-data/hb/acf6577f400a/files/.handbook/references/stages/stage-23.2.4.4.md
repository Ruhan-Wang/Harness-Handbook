# Multi-agent, collaboration, and remote-environment suites  `stage-23.2.4.4`

This stage checks the system’s collaborative “many helpers” behavior. It is part of the test suite, so it does not run the product itself; it proves that the main work loop stays safe and understandable when one session starts child sessions, delegates work, or uses a remote machine.

The spawn agent description tests make sure the model is shown the right instructions for creating helper agents, including which models are allowed and when not to use them. The agent execution tests check the traffic limit: nested helpers all share one cap, so a child cannot quietly create too many more children. The delegation tests confirm that a sub-agent’s approval requests appear in the parent conversation, without duplicate status messages. The subagent notification tests cover the “wiring” between parent and child sessions: settings, roles, skills, lifecycle messages, and multi-agent communication. The agent jobs tests treat CSV rows like a work queue, sending each row to workers and collecting results safely. The remote environment tests ensure the same rules hold when files, commands, patches, and approvals happen on another machine.

## Files in this stage

### Agent spawning foundations
These tests establish how multi-agent spawning is presented to the model and how nested execution capacity is enforced at runtime.

### `core/tests/suite/spawn_agent_description.rs`

`test` · `test run`

This is a non-Windows automated test for a collaboration feature where the system can offer a `spawn_agent` tool. That tool lets the main assistant create a sub-agent, like asking a helper to work on a side task. The description of that tool matters because it is instructions the assistant reads before deciding whether and how to use it.

The test sets up a fake server instead of calling the real service. The fake server says there are two models: one visible model that users may choose, and one hidden model that should not appear. It also provides reasoning effort choices, such as low, medium, and high, plus a service tier. Then the test starts a Codex test session with collaboration enabled and submits a simple user message.

After the session sends its request to the fake server, the test opens the JSON request body and finds the nested `spawn_agent` tool description. It checks that the description includes the visible model, marks the default reasoning effort, mentions service tiers, and explains that spawned agents inherit the parent model unless an override is really needed. It also checks that hidden models and overly encouraging delegation language are absent. In short, this file protects the safety and clarity of the assistant’s instructions around spawning sub-agents.

#### Function details

##### `spawn_agent_description`  (lines 35–40)

```
fn spawn_agent_description(body: &Value) -> Option<String>
```

**Purpose**: This helper pulls the `description` text for the `spawn_agent` tool out of a JSON request body. It exists so the test can focus on checking the wording, without repeating the JSON-search steps.

**Data flow**: It receives a JSON value representing the request body sent to the model service. It looks inside the `multi_agent_v1` namespace for the `spawn_agent` tool, then reads that tool’s `description` field if it is a string. It returns the description text when found, or nothing if the expected tool or field is missing.

**Call relations**: The main test calls this after capturing the mocked request body. Internally it relies on `namespace_child_tool` to find the nested tool entry, then hands the extracted text back to the test assertions.

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

**Purpose**: This helper builds a complete fake `ModelInfo` record for use in the test. It saves the test from having to repeat a long list of mostly standard model settings each time it wants to describe a model.

**Data flow**: It takes the model details that matter for this test, such as the slug, display name, description, visibility, reasoning levels, and service tiers. It combines those with fixed default values for the many other required fields on `ModelInfo`. It returns a ready-to-use model record that can be placed in the fake models response.

**Call relations**: The main test uses this helper twice while preparing the mock server’s model list: once for a visible model and once for a hidden model. The resulting records are passed into the mocked models endpoint so the rest of the test can observe how the real code turns model metadata into tool description text.

*Call graph*: calls 2 internal fn (bytes, default_input_modalities); 2 external calls (default, new).


##### `wait_for_model_available`  (lines 93–105)

```
async fn wait_for_model_available(manager: &SharedModelsManager, slug: &str)
```

**Purpose**: This helper waits until the models manager has loaded a named remote model. It prevents the test from racing ahead before the background model refresh has finished.

**Data flow**: It receives the shared models manager and the model slug it expects to see. It repeatedly asks for the online model list until the named model appears, sleeping briefly between tries. If the model appears within two seconds, it returns; if not, it stops the test with a timeout error.

**Call relations**: The main test calls this after building the test Codex session and before submitting a turn. It gives the session enough time to learn about the fake server’s `visible-model`, so the later request can include the correct model information in the `spawn_agent` description.

*Call graph*: called by 1 (spawn_agent_description_lists_visible_models_and_reasoning_efforts); 6 external calls (from_millis, from_secs, now, list_models, panic!, sleep).


##### `spawn_agent_description_lists_visible_models_and_reasoning_efforts`  (lines 108–236)

```
async fn spawn_agent_description_lists_visible_models_and_reasoning_efforts() -> Result<()>
```

**Purpose**: This is the actual test case. It verifies that the `spawn_agent` tool description lists visible model options and reasoning efforts correctly, while hiding models and guidance that should not be shown.

**Data flow**: It starts a mock server, mounts a fake model list, and mounts a fake streaming response so the Codex session can complete normally. It builds a test Codex session with dummy authentication, the visible model selected, and collaboration enabled. After waiting for the model metadata to load, it submits a user message, reads the single outgoing request captured by the mock server, extracts the `spawn_agent` description, and checks the exact kinds of text that must be present or absent.

**Call relations**: This test is the driver for the whole file. It uses `test_model_info` to create fake model metadata, uses the test support server helpers to simulate remote API behavior, uses `wait_for_model_available` to avoid timing problems, and finally uses `spawn_agent_description` to inspect the generated tool description before making its assertions.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_once, sse, start_mock_server, test_codex, spawn_agent_description, wait_for_model_available, create_dummy_chatgpt_auth_for_testing); 2 external calls (assert!, vec!).


### `core/tests/suite/agent_execution.rs`

`test` · `test run`

This is a safety test for the system’s multi-agent feature. In plain terms, the product can ask one agent to start another agent, like a manager handing work to a helper. The risk is that helpers could keep spawning more helpers and overwhelm the session. This test checks that all those agents share the same capacity limit.

The file sets up a fake server that pretends to be the model API. Instead of calling a real model, the test server returns a planned sequence of streaming events: first the main agent asks to spawn a worker, then that worker asks to spawn another worker. The configuration allows only two active threads in the session. That means the original thread plus the first spawned worker are allowed, but the second nested spawn should be refused.

Two small helper functions inspect outgoing request bodies. One checks whether a request contains certain prompt text. The other checks whether the request is reporting the result of a particular tool call. These helpers let the fake server respond differently at each stage of the conversation.

The main test enables the collaboration and multi-agent features, submits the first prompt, waits for the nested spawn result, and confirms the result says the agent thread limit was reached. It also checks that only two thread IDs exist, proving the rejected nested worker was not actually created.

#### Function details

##### `body_contains`  (lines 19–22)

```
fn body_contains(request: &wiremock::Request, text: &str) -> bool
```

**Purpose**: This helper checks whether a mocked HTTP request body contains a given piece of text. The test uses it to recognize which stage of the fake conversation a request belongs to.

**Data flow**: It receives a request and a text snippet. It tries to read the request body as JSON, turns that JSON back into a string, and searches for the snippet. It returns true if the body was valid JSON and contained the text; otherwise it returns false.

**Call relations**: The main test uses this helper inside the fake server’s request-matching rules. When Codex sends a request, the mock server calls this check to decide whether to send the planned response for the first prompt or the first worker task.


##### `has_function_call_output`  (lines 24–36)

```
fn has_function_call_output(request: &wiremock::Request, call_id: &str) -> bool
```

**Purpose**: This helper checks whether a mocked request is reporting the result of a specific function call. In this test, that is how the fake server knows when an agent has finished trying to spawn another agent.

**Data flow**: It receives a request and a function call ID. It reads the request body as JSON, looks inside the request’s input list, and searches for an item marked as a function call output with the matching call ID. It returns true only when that exact output is present.

**Call relations**: The main test uses this helper in mock server matchers for follow-up responses. It lets the fake server distinguish between the first worker asking for a nested spawn and later messages that report whether the spawn succeeded or failed.


##### `v2_nested_spawn_checks_shared_active_execution_capacity`  (lines 39–122)

```
async fn v2_nested_spawn_checks_shared_active_execution_capacity() -> Result<()>
```

**Purpose**: This test proves that nested agent spawning uses one shared session limit, not a fresh limit for each worker. It verifies that when the session already has the maximum allowed active threads, a worker’s attempt to spawn another worker is rejected.

**Data flow**: The test starts a mock model server, prepares fake streaming responses, and configures Codex with collaboration and multi-agent support enabled. It sets the maximum concurrent threads per session to two, submits the first prompt, and waits until the nested spawn attempt reports back. The expected result is the failure message saying the agent thread limit was reached, and the final thread count remains two.

**Call relations**: This is the file’s main scenario. It calls the test-support tools to create the mock server, attach one-use streaming responses, build a test Codex instance, and submit a user turn. The small request-inspection helpers guide the mock server through the staged conversation. At the end, the test uses assertions to confirm that the second nested worker was blocked and no extra thread was created.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex); 8 external calls (from_millis, from_secs, assert_eq!, json!, to_string, sleep, timeout, vec!).


### Subagent collaboration flows
These files cover parent-child coordination, delegated event surfacing, and mailbox-style notifications across collaborative sessions.

### `core/tests/suite/codex_delegate.rs`

`test` · `test run`

This is a test file for the “delegate” review path. In this system, a review can be carried out by a sub-agent, which is like asking an assistant inside the main assistant to do a focused job. The tricky part is that the sub-agent may want to run a shell command or apply a patch, and those actions may need human approval. Without tests like these, the sub-agent could get stuck waiting for permission that the parent conversation never sees, or it could emit confusing duplicate progress messages.

The tests build a fake Codex conversation backed by a mock server. The mock server sends prepared server-sent events, which are streamed messages that imitate what the model service would send back over time. The tests then submit a review request and watch the events Codex emits.

Two tests, currently marked ignored, describe the intended approval behavior: a delegated shell command approval request should be forwarded to the parent, and a delegated patch approval request should also be forwarded and resolved by the parent’s decision. The active test checks a smaller compatibility issue: when the model sends both newer reasoning items and older reasoning summary text deltas, Codex should only surface the newer reasoning content once.

#### Function details

##### `codex_delegate_forwards_exec_approval_and_proceeds_on_approval`  (lines 29–117)

```
async fn codex_delegate_forwards_exec_approval_and_proceeds_on_approval()
```

**Purpose**: This test describes the expected behavior when a delegated review tries to run a shell command that needs approval. It verifies that the parent conversation receives the approval request, sends back an approval decision, and then the delegated review finishes normally.

**Data flow**: The test starts by preparing fake model responses: first a shell command request from the sub-agent, then a final structured review result. It builds a Codex test conversation configured to require approval for risky actions, submits a review request, waits until review mode begins, and then waits for an execution approval event. After it receives that event, it submits an approval decision using the approval ID from the event. The expected end state is that review mode exits and the turn completes.

**Call relations**: The test runner would call this function, though it is currently ignored. Inside the test, the mock server helpers provide the fake streamed model responses, `test_codex` builds the test conversation, and `wait_for_event` is used as the observer at each important step. The test hands the approval decision back into Codex through `submit`, so it exercises the same parent-to-delegate approval path that a real user interface would rely on.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex); 5 external calls (wait_for_event, panic!, json!, skip_if_no_network!, vec!).


##### `codex_delegate_forwards_patch_approval_and_proceeds_on_decision`  (lines 123–197)

```
async fn codex_delegate_forwards_patch_approval_and_proceeds_on_decision()
```

**Purpose**: This test describes the expected behavior when a delegated review tries to apply a patch that needs approval. It checks that the patch approval request reaches the parent conversation and that the delegate continues after the parent denies the patch.

**Data flow**: The test prepares one fake model response containing an apply-patch tool call and another containing the final review answer. It starts a mock server with those responses, builds a Codex test conversation with read-only permissions so patch approval is required, and submits a review request. It waits for review mode to start, captures the patch approval request, then sends back a denial using the call ID from that request. The expected result is that Codex leaves review mode and reports the turn as complete.

**Call relations**: The test runner would call this function, though it is currently ignored. The fake response helpers create the streamed patch request, the mock server serves it, and `test_codex` builds the configured Codex instance. `wait_for_event` connects the stages of the story: start review, see approval request, then finish after the parent decision is submitted.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex); 5 external calls (wait_for_event, panic!, json!, skip_if_no_network!, vec!).


##### `codex_delegate_ignores_legacy_deltas`  (lines 200–242)

```
async fn codex_delegate_ignores_legacy_deltas()
```

**Purpose**: This test makes sure delegated review does not show duplicate reasoning text when the model sends both old and new styles of reasoning updates. It protects the user experience from repeated or noisy progress messages.

**Data flow**: The test creates a fake streamed response that includes a new reasoning item and an older reasoning summary delta, then completes. It builds a default Codex test conversation, submits a delegated review request, and reads emitted events until the turn completes. While reading, it counts only `ReasoningContentDelta` events. At the end, it asserts that exactly one reasoning delta was shown.

**Call relations**: The test runner calls this active async test. The mock server helpers supply the prepared stream, `test_codex` creates the conversation under test, and `wait_for_event` pulls events out of Codex one by one. The final assertion checks the visible behavior: Codex should keep the useful reasoning update and ignore the legacy duplicate.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex); 4 external calls (assert_eq!, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/subagent_notifications.rs`

`test` · `test execution`

This is a test file. It does not implement the subagent feature itself; instead, it builds small fake conversations and proves that the real system behaves as expected. The tests use a mock server in place of the model provider, so they can control exactly what the “model” replies with, such as asking to spawn a child agent or returning a final answer.

The main idea is like testing a dispatch office. A parent agent can send work to a child agent, the child can report back, and both may trigger hooks, which are small user-configured scripts that run at important moments. These tests make sure the right scripts run for the right session, that child agents receive the context they should receive, and that parent sessions learn about child results through subagent notifications or agent messages.

The file also checks configuration rules. For example, a child can inherit the parent model, request a different model, or be forced to use settings from a named role. It verifies that skill instructions can be turned off for both parent and child. It also covers newer multi-agent message behavior, including encrypted task payloads and final-answer delivery back to the parent.

#### Function details

##### `body_contains`  (lines 64–82)

```
fn body_contains(req: &wiremock::Request, text: &str) -> bool
```

**Purpose**: Checks whether an HTTP request body contains a given piece of text. It understands both normal bodies and bodies compressed with zstd, a compression format used to shrink data sent over the network.

**Data flow**: It receives a mock HTTP request and the text to search for. It looks at the request headers to see whether the body is zstd-compressed; if so, it decompresses the bytes, then converts the bytes into text. It returns true if the text is found and false if decompression, text decoding, or the search fails.

**Call relations**: Many tests use this helper inside mock-server matchers. Before the fake model server returns a prepared response, these matchers call this function to confirm that the request is the expected parent turn, child prompt, spawn call, or agent message.

*Call graph*: calls 1 internal fn (new); 1 external calls (decode_all).


##### `has_subagent_notification`  (lines 84–88)

```
fn has_subagent_notification(req: &ResponsesRequest) -> bool
```

**Purpose**: Checks whether a recorded model request includes a subagent notification in the user's message text. A subagent notification is the system's way of telling the parent agent that a child agent produced information.

**Data flow**: It receives a parsed Responses API request. It pulls out the user message texts, searches them for the marker `<subagent_notification>`, and returns true if any message contains it.

**Call relations**: The test for continuing without an explicit wait uses this helper after collecting mock-server requests. It proves that the parent’s next model call includes information about the child agent.

*Call graph*: calls 1 internal fn (message_input_texts).


##### `tool_parameter_description`  (lines 90–97)

```
fn tool_parameter_description(tool: &Value, parameter_name: &str) -> Option<String>
```

**Purpose**: Reads the human-facing description of a named parameter from a tool definition stored as JSON. In these tests, it is used to inspect what the model would be told about the `spawn_agent` tool.

**Data flow**: It receives a JSON tool object and a parameter name. It walks through `parameters`, then `properties`, then the named parameter, then its `description`. If that value is a string, it returns it as owned text; otherwise it returns nothing.

**Call relations**: The tool-description test calls this after fetching the `spawn_agent` tool from tool search output. The returned description is then checked to make sure role-locked model settings are explained to the model.

*Call graph*: called by 1 (spawn_agent_tool_description_mentions_role_locked_settings); 1 external calls (get).


##### `role_block`  (lines 99–111)

```
fn role_block(description: &str, role_name: &str) -> Option<String>
```

**Purpose**: Extracts the section of a larger description that belongs to one named agent role. This makes it easier for a test to compare only the relevant role text.

**Data flow**: It receives a multi-line description and a role name. It finds the line that starts that role block, keeps collecting lines until the next role block begins, and returns the collected block as one string. If the role is not found, it returns nothing.

**Call relations**: The tool-description test calls this after `tool_parameter_description`. It narrows the full `agent_type` description down to the custom role so the test can assert the exact wording.

*Call graph*: called by 1 (spawn_agent_tool_description_mentions_role_locked_settings); 2 external calls (format!, vec!).


##### `write_home_skill`  (lines 113–119)

```
fn write_home_skill(codex_home: &Path, dir: &str, name: &str, description: &str) -> Result<()>
```

**Purpose**: Creates a simple fake skill in the test Codex home directory. A skill is extra instruction material that Codex can discover and include in model prompts.

**Data flow**: It receives the Codex home path, a skill directory name, a skill name, and a description. It creates the skill folder, writes a `SKILL.md` file with a small front matter section and body, and returns success or an error from the file system.

**Call relations**: The skills toggle test uses this helper before building the test Codex instance. The test then verifies that this fake skill is not sent to either the parent or spawned child when skill instructions are disabled.

*Call graph*: 4 external calls (join, format!, create_dir_all, write).


##### `write_subagent_lifecycle_hooks`  (lines 121–262)

```
fn write_subagent_lifecycle_hooks(
    home: &Path,
    stop_prompts: &[&str],
    subagent_stop_matcher: &str,
) -> Result<()>
```

**Purpose**: Writes a complete set of fake hook scripts and a `hooks.json` file for tests. Hooks are small commands Codex runs at lifecycle moments, such as session start, subagent start, user prompt submit, subagent stop, and normal stop.

**Data flow**: It receives a home directory, a list of prompts that should cause the subagent stop hook to block, and a matcher for which subagents the stop hook applies to. It writes several Python scripts that log their input JSON to files and sometimes print structured output back to Codex. It also writes the hook configuration that points Codex at those scripts.

**Call relations**: The subagent start and subagent stop tests install these hook fixtures before Codex starts. Later, the tests read the log files produced by these scripts to prove that Codex invoked the right hook with the right payload.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `read_hook_log`  (lines 264–274)

```
fn read_hook_log(home: &Path, filename: &str) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads one of the JSON-lines hook log files produced by the fake hook scripts. JSON-lines means each line is its own JSON object.

**Data flow**: It receives the test home directory and a log filename. If the file does not exist, it returns an empty list. If it exists, it reads each non-empty line, parses each line as JSON, and returns the list of parsed values.

**Call relations**: Polling code in `wait_for_hook_log` uses this repeatedly while waiting for hooks to run. The subagent stop test also calls it directly to check that normal Stop hooks were not called for child-agent completion.

*Call graph*: called by 2 (subagent_stop_replaces_stop_and_skips_internal_subagents, wait_for_hook_log); 3 external calls (join, new, read_to_string).


##### `wait_for_hook_log`  (lines 276–295)

```
async fn wait_for_hook_log(
    home: &Path,
    filename: &str,
    expected_len: usize,
) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Waits briefly until a hook log file has at least a given number of entries. This avoids flaky tests where the hook may run slightly after the test action starts.

**Data flow**: It receives the home directory, log filename, and expected number of entries. It repeatedly calls `read_hook_log`, sleeping for a few milliseconds between attempts. It returns the log entries once enough are present, or returns an error if the timeout is reached.

**Call relations**: The lifecycle hook tests call this after submitting turns that should trigger hooks. It turns asynchronous hook execution into a clear test checkpoint.

*Call graph*: calls 1 internal fn (read_hook_log); called by 2 (subagent_start_replaces_session_start_and_injects_context, subagent_stop_replaces_stop_and_skips_internal_subagents); 5 external calls (from_millis, from_secs, now, bail!, sleep).


##### `wait_for_spawned_thread_id`  (lines 297–312)

```
async fn wait_for_spawned_thread_id(test: &TestCodex) -> Result<String>
```

**Purpose**: Waits until the test thread manager shows a new thread that is not the original parent thread. That new thread is treated as the spawned child agent.

**Data flow**: It receives a `TestCodex` instance. It repeatedly asks the thread manager for all thread IDs and looks for one different from the parent session ID. It returns that ID as text, or errors if no child appears before the timeout.

**Call relations**: Shared setup code and the subagent start test call this after a parent turn asks to spawn an agent. The returned child ID is used for later checks, such as matching hook input to the actual spawned agent.

*Call graph*: called by 2 (setup_turn_one_with_custom_spawned_child, subagent_start_replaces_session_start_and_injects_context); 5 external calls (from_millis, from_secs, now, bail!, sleep).


##### `wait_for_requests`  (lines 314–328)

```
async fn wait_for_requests(
    mock: &core_test_support::responses::ResponseMock,
) -> Result<Vec<ResponsesRequest>>
```

**Purpose**: Waits until a mock response has recorded at least one matching request. This lets the tests wait for a model call that happens asynchronously.

**Data flow**: It receives a response mock, checks its recorded requests, and loops with short sleeps until at least one request is present. It returns the collected requests or errors if none arrive before the timeout.

**Call relations**: Most tests use this helper after submitting a turn or starting a child agent. It confirms that Codex actually sent the expected request to the fake model server before the test inspects the request body.

*Call graph*: calls 1 internal fn (requests); called by 8 (encrypted_multi_agent_v2_spawn_sends_agent_message_to_child, plaintext_multi_agent_v2_completion_sends_agent_message, setup_turn_one_with_custom_spawned_child, skills_toggle_skips_instructions_for_parent_and_spawned_child, spawned_multi_agent_v2_child_inherits_parent_developer_context, subagent_notification_is_included_without_wait, subagent_start_replaces_session_start_and_injects_context, subagent_stop_replaces_stop_and_skips_internal_subagents); 5 external calls (from_millis, from_secs, now, bail!, sleep).


##### `setup_turn_one_with_spawned_child`  (lines 330–345)

```
async fn setup_turn_one_with_spawned_child(
    server: &MockServer,
    child_response_delay: Option<Duration>,
) -> Result<(TestCodex, String)>
```

**Purpose**: Provides a simple reusable setup where a parent turn spawns a child agent with the standard child prompt. It hides the detailed mock-server setup used by several tests.

**Data flow**: It receives the mock server and an optional delay for the child response. It builds default spawn arguments, delegates to `setup_turn_one_with_custom_spawned_child`, and returns the configured `TestCodex` plus the spawned child thread ID.

**Call relations**: The test for subagent notifications without waiting calls this to get to a known state: a parent has already spawned a child, and the child has completed or is configured to complete.

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

**Purpose**: Builds a full fake conversation where the parent model response asks to spawn a child agent, the child receives a prompt, and the parent later receives a follow-up response. It is the main setup helper for subagent spawning tests.

**Data flow**: It receives a mock server, custom spawn arguments, an optional child-response delay, a flag saying whether to wait for the parent notification, and a function that can customize the test builder. It mounts mock responses for the parent spawn call, the child request, and the parent follow-up. It builds a `TestCodex`, submits the parent prompt, optionally waits until the parent rollout includes a subagent notification, waits for the child thread ID, and returns the test object, child ID, and child request log.

**Call relations**: Higher-level helpers and snapshot tests call this when they need a real spawned child but do not want to repeat all the mock-server wiring. It calls `wait_for_requests` and `wait_for_spawned_thread_id` to ensure the setup has fully happened before returning.

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

**Purpose**: Spawns a child agent and captures the child thread's configuration snapshot. A configuration snapshot records settings such as model and reasoning effort at the time the thread was created.

**Data flow**: It receives a mock server, spawn arguments, and a test-builder customization function. It uses `setup_turn_one_with_custom_spawned_child` to create the child, converts the child ID into a thread ID, fetches that thread from the thread manager, and returns its configuration snapshot.

**Call relations**: The model-setting tests call this to compare what the child actually received against what the spawn request, parent settings, or role configuration should have produced.

*Call graph*: calls 2 internal fn (setup_turn_one_with_custom_spawned_child, from_string); called by 2 (spawn_agent_requested_model_and_reasoning_override_inherited_settings_without_role, spawn_agent_role_overrides_requested_model_and_reasoning_settings).


##### `subagent_start_replaces_session_start_and_injects_context`  (lines 476–598)

```
async fn subagent_start_replaces_session_start_and_injects_context() -> Result<()>
```

**Purpose**: Tests that a spawned subagent runs the SubagentStart hook instead of a normal SessionStart hook, and that extra context returned by that hook is included in the child prompt.

**Data flow**: The test sets up mock model responses for a parent spawning a worker child and for the child request that must include the hook-provided context. It writes lifecycle hook scripts, enables the collaboration feature, submits the parent turn, waits for the child request, and then reads hook logs. It asserts that the child has an agent ID and type in hook inputs, while the parent prompt does not, and that normal session start only happened for the parent.

**Call relations**: This is a top-level test. It uses `write_subagent_lifecycle_hooks` through the test builder, then calls `wait_for_requests`, `wait_for_hook_log`, and `wait_for_spawned_thread_id` to observe the system after the spawn.

*Call graph*: calls 7 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, wait_for_hook_log, wait_for_requests, wait_for_spawned_thread_id); 6 external calls (assert_eq!, assert_ne!, json!, to_string, skip_if_no_network!, vec!).


##### `subagent_stop_replaces_stop_and_skips_internal_subagents`  (lines 601–803)

```
async fn subagent_stop_replaces_stop_and_skips_internal_subagents() -> Result<()>
```

**Purpose**: Tests that a normal spawned subagent uses the SubagentStop hook instead of the regular Stop hook, and that internal system subagents are not accidentally treated like user-visible spawned agents.

**Data flow**: The test sets up a parent spawn, two child turns caused by a blocking SubagentStop hook, a parent follow-up, and a separate internal review subagent. It installs hooks where the first subagent stop blocks with a continuation prompt and the second passes. It then checks SubagentStop log entries, verifies transcript paths and last assistant messages, confirms the regular Stop hook did not run for the child completion, runs an internal subagent, and verifies that hook logs did not change because of that internal subagent.

**Call relations**: This top-level test uses `write_subagent_lifecycle_hooks`, `wait_for_requests`, `wait_for_hook_log`, and `read_hook_log`. It also starts an internal thread directly through the thread manager to exercise the edge case that should not trigger SubagentStop.

*Call graph*: calls 9 internal fn (mount_sse_once_match, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, read_hook_log, wait_for_hook_log, wait_for_requests); 11 external calls (default, new, SubAgent, assert!, assert_eq!, assert_ne!, wait_for_event_match, json!, to_string, skip_if_no_network! (+1 more)).


##### `subagent_notification_is_included_without_wait`  (lines 806–829)

```
async fn subagent_notification_is_included_without_wait() -> Result<()>
```

**Purpose**: Tests that a parent turn after a child finishes can include a subagent notification even when the user did not explicitly ask to wait for the child.

**Data flow**: The test starts a mock server, uses the shared setup to spawn and complete a child, then mounts a response for a second parent prompt. After submitting that second prompt, it inspects the request sent to the mock model and checks that at least one request contains the subagent notification marker.

**Call relations**: This top-level test relies on `setup_turn_one_with_spawned_child` for the initial parent-child state and `wait_for_requests` to capture the second turn request. It uses `has_subagent_notification` as the final request-body check.

*Call graph*: calls 5 internal fn (mount_sse_once_match, sse, start_mock_server, setup_turn_one_with_spawned_child, wait_for_requests); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `spawned_child_receives_forked_parent_context`  (lines 832–926)

```
async fn spawned_child_receives_forked_parent_context() -> Result<()>
```

**Purpose**: Tests that when a spawn request asks to fork context, the child receives earlier parent conversation context. Forking context means copying relevant prior conversation history into the child session.

**Data flow**: The test first sends a seed parent turn, then sends a second turn where the model asks to spawn a child with `fork_context` set to true. It waits for the child request and checks that the child request includes the seed prompt but does not include the spawn call ID itself.

**Call relations**: This top-level test sets up all mock responses directly. It uses `body_contains` in mock matchers and in the final assertions to prove the child got the right history and avoided internal spawn-call details.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex); 10 external calls (from_millis, from_secs, now, bail!, assert!, json!, to_string, skip_if_no_network!, sleep, vec!).


##### `spawn_agent_requested_model_and_reasoning_override_inherited_settings_without_role`  (lines 929–952)

```
async fn spawn_agent_requested_model_and_reasoning_override_inherited_settings_without_role() -> Result<()>
```

**Purpose**: Tests that when no named role is involved, a spawn request's requested model and reasoning effort override the parent’s inherited settings.

**Data flow**: The test creates spawn arguments with a specific model and reasoning effort, spawns a child, captures the child configuration snapshot, and compares the snapshot values to the requested values.

**Call relations**: This top-level test delegates the spawning and snapshot capture to `spawn_child_and_capture_snapshot`. It focuses only on the final configuration result.

*Call graph*: calls 2 internal fn (start_mock_server, spawn_child_and_capture_snapshot); 3 external calls (assert_eq!, json!, skip_if_no_network!).


##### `spawned_multi_agent_v2_child_inherits_parent_developer_context`  (lines 955–1025)

```
async fn spawned_multi_agent_v2_child_inherits_parent_developer_context() -> Result<()>
```

**Purpose**: Tests that with the newer multi-agent feature enabled, a spawned child receives the parent’s developer instructions. Developer instructions are higher-priority guidance configured for the session.

**Data flow**: The test configures parent developer instructions, enables collaboration and MultiAgentV2, and sets up a parent spawn plus a child request. After submitting the parent prompt, it captures the child request and asserts that it contains both the parent developer instructions and the child prompt.

**Call relations**: This top-level test wires mock responses itself and uses `wait_for_requests` to inspect the child request after the spawn. It verifies context inheritance for the MultiAgentV2 path.

*Call graph*: calls 5 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, wait_for_requests); 5 external calls (assert!, json!, to_string, skip_if_no_network!, vec!).


##### `encrypted_multi_agent_v2_spawn_sends_agent_message_to_child`  (lines 1028–1105)

```
async fn encrypted_multi_agent_v2_spawn_sends_agent_message_to_child() -> Result<()>
```

**Purpose**: Tests that an encrypted MultiAgentV2 task is delivered to the child as an `agent_message` input rather than plain user text. An `agent_message` is a structured message between agents.

**Data flow**: The test sets up a parent response that calls `spawn_agent` with an opaque encrypted payload. It expects the child request to contain an input of type `agent_message`, then checks that the message has the right author, recipient, task text, and encrypted content block.

**Call relations**: This top-level test uses mock responses and `wait_for_requests` to capture the child call. Its final assertion checks the structured message extracted from the recorded request.

*Call graph*: calls 5 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, wait_for_requests); 4 external calls (assert_eq!, json!, to_string, vec!).


##### `plaintext_multi_agent_v2_completion_sends_agent_message`  (lines 1116–1242)

```
async fn plaintext_multi_agent_v2_completion_sends_agent_message(
    scenario: CompletionScenario,
) -> Result<()>
```

**Purpose**: Tests that when a MultiAgentV2 child finishes, the parent receives the result as an `agent_message`. It covers both a normal child completion and a terminal stream error.

**Data flow**: The test receives a scenario value. It sets up a parent spawn, a delayed child response that either completes with `child done` or fails before completion, a parent follow-up that calls `wait_agent`, and a final parent request that must contain the delivered final-answer message. It then submits the parent turns and asserts that the recorded `agent_message` has the expected author, recipient, and payload text.

**Call relations**: This parameterized top-level test uses `wait_for_requests` to ensure the child request happened before submitting the follow-up. It exercises the mailbox-like delivery path where `wait_agent` blocks until the child result is available.

*Call graph*: calls 7 internal fn (mount_response_once_match, mount_sse_once_match, sse, sse_response, start_mock_server, test_codex, wait_for_requests); 6 external calls (from_secs, assert_eq!, format!, json!, to_string, vec!).


##### `skills_toggle_skips_instructions_for_parent_and_spawned_child`  (lines 1245–1322)

```
async fn skills_toggle_skips_instructions_for_parent_and_spawned_child() -> Result<()>
```

**Purpose**: Tests that disabling skill instructions prevents skill text from being sent to both the parent and the spawned child. This matters because skills can add extra prompt material, and the setting should apply consistently.

**Data flow**: The test writes a fake home skill, disables skill instructions in the configuration, enables collaboration and MultiAgentV2, and sets up a parent spawn plus child request. It submits the parent turn, checks the parent request, waits for the child request, and confirms neither request contains the skills wrapper or fake skill name.

**Call relations**: This top-level test uses `write_home_skill` during setup and `wait_for_requests` to inspect the child request. It proves the configuration toggle applies across agent boundaries.

*Call graph*: calls 5 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, wait_for_requests); 5 external calls (assert!, json!, to_string, skip_if_no_network!, vec!).


##### `spawn_agent_role_overrides_requested_model_and_reasoning_settings`  (lines 1325–1364)

```
async fn spawn_agent_role_overrides_requested_model_and_reasoning_settings() -> Result<()>
```

**Purpose**: Tests that a named agent role can lock the child’s model and reasoning effort, even if the spawn request asks for different values.

**Data flow**: The test writes a custom role configuration file with its own model and reasoning effort. It then spawns a child with that role while also requesting different settings, captures the child configuration snapshot, and asserts that the role’s values won.

**Call relations**: This top-level test uses `spawn_child_and_capture_snapshot` for the spawn and inspection. Its setup customizes the test builder by adding a role to the configuration before Codex starts.

*Call graph*: calls 2 internal fn (start_mock_server, spawn_child_and_capture_snapshot); 3 external calls (assert_eq!, json!, skip_if_no_network!).


##### `spawn_agent_tool_description_mentions_role_locked_settings`  (lines 1367–1437)

```
async fn spawn_agent_tool_description_mentions_role_locked_settings() -> Result<()>
```

**Purpose**: Tests that the tool description shown to the model explains when a role has locked model and reasoning settings. This helps the model avoid asking for settings that cannot be changed.

**Data flow**: The test configures a custom role with developer instructions, model, and reasoning effort, then has the fake model perform a tool search. It extracts the returned `spawn_agent` tool, reads the `agent_type` parameter description, isolates the custom role block, and compares it to the expected wording.

**Call relations**: This top-level test uses `tool_parameter_description` and `role_block` to inspect nested description text. It also uses `namespace_child_tool` to find the relevant tool in the tool-search output.

*Call graph*: calls 6 internal fn (mount_sse_sequence, namespace_child_tool, start_mock_server, test_codex, role_block, tool_parameter_description); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


### Agent job orchestration
This group tests CSV-driven job spawning, result handling, and cancellation behavior for agent-backed work items.

### `core/tests/suite/agent_jobs.rs`

`test` · `test execution`

This test file builds a small fake world around the agent-job feature. The real system normally talks to an AI service over HTTP and receives streamed events. Here, the tests use a mock server that pretends to be that AI service, so the job system can be exercised without contacting the outside world.

The main helper responders act like scripted AI replies. On the first main request, they tell the system to call the tool `spawn_agents_on_csv`. When worker agents are later created for each CSV row, the responders recognize the worker prompt by looking for the job and item IDs in the request text. They then send back a fake tool call to `report_agent_job_result`, as if the worker completed its item. One special responder reports `stop: true` on the first worker result, which is used to test cancellation.

The tests create temporary CSV files, enable the needed feature flags, run a user turn such as “run batch job,” and then inspect the output CSV and state database. Together, they prove that CSV rows become job items, duplicate item IDs are made unique, results are exported, cancellation leaves later items pending, and job results cannot be accepted from an unrelated thread.

#### Function details

##### `AgentJobsResponder::new`  (lines 31–37)

```
fn new(spawn_args_json: String) -> Self
```

**Purpose**: Creates a scripted mock AI responder for the normal agent-job tests. It stores the JSON arguments that the fake AI should use when it asks the system to start a CSV-based job.

**Data flow**: It receives a JSON string describing the CSV job to spawn. It returns an `AgentJobsResponder` with that string saved, a flag saying the main request has not yet been seen, and a counter starting at zero for naming worker calls.

**Call relations**: The main CSV job tests create this responder before mounting it on the mock HTTP server. Later, the mock server calls `AgentJobsResponder::respond` whenever the system sends an AI request.

*Call graph*: called by 3 (report_agent_job_result_rejects_wrong_thread, spawn_agents_on_csv_dedupes_item_ids, spawn_agents_on_csv_runs_and_exports); 2 external calls (new, new).


##### `StopAfterFirstResponder::new`  (lines 47–53)

```
fn new(spawn_args_json: String, worker_calls: Arc<AtomicUsize>) -> Self
```

**Purpose**: Creates a scripted mock AI responder for the cancellation test. It is like the normal responder, but it also keeps a shared count of how many worker calls happened so it can stop after the first one.

**Data flow**: It receives the JSON job-spawn arguments and a shared atomic counter, which is a thread-safe number. It returns a responder with the arguments saved, the “main request seen” flag set to false, and the worker counter ready to be updated during the test.

**Call relations**: The stop-and-cancel test builds this responder and attaches it to the mock server. The server then calls `StopAfterFirstResponder::respond` for each fake AI response.

*Call graph*: called by 1 (spawn_agents_on_csv_stop_halts_future_items); 1 external calls (new).


##### `StopAfterFirstResponder::respond`  (lines 57–98)

```
fn respond(&self, request: &wiremock::Request) -> ResponseTemplate
```

**Purpose**: Pretends to be the AI service during the cancellation test. It starts the CSV job, answers worker tasks, and marks the first worker result with `stop: true` so the system should not launch more work.

**Data flow**: It receives an HTTP request from the system, decodes the request body, and reads it as JSON. If the request is just sending back a tool result, it replies with a simple completed stream. If it is a worker request, it extracts the job and item IDs, increments the shared worker count, and returns a fake `report_agent_job_result` tool call; only the first such call includes `stop: true`. If it is the first main request, it returns a fake `spawn_agents_on_csv` tool call. Otherwise it returns a harmless completed response.

**Call relations**: The wiremock server invokes this responder whenever the tested system posts to the responses endpoint. It relies on `decode_body_bytes`, `has_function_call_output`, and `extract_job_and_item` to understand what kind of request arrived, then uses the test response helpers to send streamed events back.

*Call graph*: calls 5 internal fn (sse, sse_response, decode_body_bytes, extract_job_and_item, has_function_call_output); 6 external calls (swap, format!, json!, from_slice, to_string, vec!).


##### `AgentJobsResponder::respond`  (lines 102–143)

```
fn respond(&self, request: &wiremock::Request) -> ResponseTemplate
```

**Purpose**: Pretends to be the AI service during the normal CSV job tests. It triggers the CSV job once, then supplies fake successful results for each spawned worker item.

**Data flow**: It receives an HTTP request, decodes and parses its JSON body, and decides what stage of the conversation it represents. Tool-result submissions get a simple completed reply. Worker prompts get a fake `report_agent_job_result` tool call containing the same item ID. The first main prompt gets a fake `spawn_agents_on_csv` tool call using the saved arguments. Later unmatched requests get a completed no-op response.

**Call relations**: The mock server calls this function while tests are running. It uses the shared helper functions to decode the request and recognize worker jobs, then hands back server-sent event style responses that drive the real job code under test.

*Call graph*: calls 5 internal fn (sse, sse_response, decode_body_bytes, extract_job_and_item, has_function_call_output); 6 external calls (swap, format!, json!, from_slice, to_string, vec!).


##### `decode_body_bytes`  (lines 146–163)

```
fn decode_body_bytes(request: &wiremock::Request) -> Vec<u8>
```

**Purpose**: Reads the raw request body from the mock-server request, including bodies compressed with zstd. This lets the tests inspect the system’s outgoing request even when the client compresses it.

**Data flow**: It receives a mock HTTP request. If the request says its body is zstd-compressed, it tries to decompress the bytes; if decompression fails, it falls back to the original bytes. If there is no zstd marker, it simply returns a copy of the body.

**Call relations**: Both responder implementations call this before parsing the request as JSON. Without it, the responders might fail to recognize compressed requests and would not know whether to start a job, answer a worker, or acknowledge a tool result.

*Call graph*: calls 1 internal fn (new); called by 2 (respond, respond); 1 external calls (decode_all).


##### `has_function_call_output`  (lines 165–173)

```
fn has_function_call_output(body: &Value) -> bool
```

**Purpose**: Checks whether an AI request is carrying the result of a tool call back to the model. In these tests, that means the mock AI can simply acknowledge it instead of starting more work.

**Data flow**: It receives a JSON request body and looks inside its `input` array. If any item is marked as `function_call_output`, it returns true; otherwise it returns false.

**Call relations**: Both responders use this early in their decision process. When it returns true, the responder skips job detection and sends back a simple completed response.

*Call graph*: called by 2 (respond, respond); 1 external calls (get).


##### `extract_job_and_item`  (lines 175–196)

```
fn extract_job_and_item(body: &Value) -> Option<(String, String)>
```

**Purpose**: Recognizes worker-agent requests and pulls out the job ID and item ID from the prompt text. This is how the fake AI knows which CSV item it is supposed to report on.

**Data flow**: It receives the parsed JSON request body. It gathers message text, adds any instruction text, checks for the worker-job marker sentence, and then searches the combined text for `Job ID:` and `Item ID:` lines. If both are found, it returns them as strings; otherwise it returns nothing.

**Call relations**: Both responders call this after ruling out tool-result submissions. It depends on `message_input_texts` to collect the readable prompt text, and its output is used to build fake `report_agent_job_result` tool calls.

*Call graph*: calls 1 internal fn (message_input_texts); called by 2 (respond, respond); 2 external calls (new, get).


##### `message_input_texts`  (lines 198–211)

```
fn message_input_texts(body: &Value) -> Vec<String>
```

**Purpose**: Collects the plain text pieces from a request’s message input. It filters away other structured content so the test can search only the human-readable prompt text.

**Data flow**: It receives a JSON request body. It looks for `input` items whose type is `message`, then walks through their content spans and keeps only spans marked `input_text`. It returns those text strings in a list.

**Call relations**: This helper feeds `extract_job_and_item`. It keeps the job-and-item extraction code focused on recognizing the worker prompt rather than knowing the full JSON shape of a model request.

*Call graph*: called by 1 (extract_job_and_item); 2 external calls (get, new).


##### `parse_simple_csv_line`  (lines 213–215)

```
fn parse_simple_csv_line(line: &str) -> Vec<String>
```

**Purpose**: Splits a simple CSV row into columns for test assertions. It is intentionally basic and is used only on the uncomplicated CSV output produced in these tests.

**Data flow**: It receives one line of text and splits it wherever there is a comma. It returns the pieces as strings.

**Call relations**: The duplicate-ID test uses this helper to read the output header and rows, find the `item_id` column, and confirm that duplicate input IDs were made unique.

*Call graph*: called by 1 (spawn_agents_on_csv_dedupes_item_ids).


##### `report_agent_job_result_rejects_wrong_thread`  (lines 218–281)

```
async fn report_agent_job_result_rejects_wrong_thread() -> Result<()>
```

**Purpose**: Tests that a job item result is not accepted if it is reported from the wrong thread. This matters because a worker’s result should only count if it comes from the worker conversation that was assigned that item.

**Data flow**: The test starts a mock server, enables the CSV-spawning and SQLite state features, writes a one-row CSV file, and runs a fake user turn that starts the job. It reads the output CSV to find the job ID, looks up the job and item in the state database, then tries to report a result using a made-up thread ID. The expected outcome is that the database rejects the report.

**Call relations**: This test uses `AgentJobsResponder::new` to script the mock AI conversation. After the normal job flow completes, it bypasses the AI layer and calls the state database directly to prove the thread-safety rule is enforced at the storage/result-reporting level.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, new); 9 external calls (given, assert!, assert_eq!, read_to_string, write, json!, to_string, method, path_regex).


##### `spawn_agents_on_csv_runs_and_exports`  (lines 284–323)

```
async fn spawn_agents_on_csv_runs_and_exports() -> Result<()>
```

**Purpose**: Tests the happy path for running a CSV-based agent job and exporting results. It proves that rows in an input CSV can become worker tasks and that their results appear in the output CSV.

**Data flow**: The test creates an input CSV with two rows, prepares tool arguments pointing to input and output paths, and uses a mock responder to start the job and return worker results. After submitting a user turn, it reads the output CSV and checks that result-related fields and JSON result content were written.

**Call relations**: This is the basic end-to-end test for the feature. It relies on `AgentJobsResponder::new` and `AgentJobsResponder::respond` to imitate the AI service while the real job-spawning, worker-running, database, and CSV-export code execute underneath.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, new); 8 external calls (given, assert!, read_to_string, write, json!, to_string, method, path_regex).


##### `spawn_agents_on_csv_dedupes_item_ids`  (lines 326–382)

```
async fn spawn_agents_on_csv_dedupes_item_ids() -> Result<()>
```

**Purpose**: Tests that duplicate item IDs in the input CSV are made unique. This prevents two job items from having the same identifier, which would make tracking results ambiguous.

**Data flow**: The test writes a CSV where two rows both have the ID `foo`, then asks the system to use that column as the item ID. After the job runs, it reads the output CSV, finds the `item_id` column, collects the item IDs from each row, and checks that there are two distinct values: `foo` and `foo-2`.

**Call relations**: Like the other normal-flow tests, it uses `AgentJobsResponder` to fake the AI service. It uses `parse_simple_csv_line` to inspect the generated CSV output in a lightweight way.

*Call graph*: calls 4 internal fn (start_mock_server, test_codex, new, parse_simple_csv_line); 10 external calls (given, new, assert!, assert_eq!, read_to_string, write, json!, to_string, method, path_regex).


##### `spawn_agents_on_csv_stop_halts_future_items`  (lines 385–444)

```
async fn spawn_agents_on_csv_stop_halts_future_items() -> Result<()>
```

**Purpose**: Tests that a worker can ask the job to stop and that future items are left pending rather than started. This is important for batch jobs where one result may reveal that continuing would be wasteful or unsafe.

**Data flow**: The test creates a three-row CSV and sets maximum concurrency to one, meaning only one worker should run at a time. The mock responder reports a successful result for the first item with `stop: true`. The test then reads the output and database state, expecting the job to be cancelled, one item completed, two items still pending, no items running, and only one worker call made.

**Call relations**: This test uses `StopAfterFirstResponder::new` and `StopAfterFirstResponder::respond` instead of the normal responder. The special responder’s shared worker counter lets the test verify that the cancellation signal actually prevented later worker requests.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, new); 10 external calls (new, new, given, assert_eq!, read_to_string, write, json!, to_string, method, path_regex).


### Remote environment execution
These tests validate isolated execution in remote environments, including filesystem access, environment selection, permissions, and sandbox behavior.

### `core/tests/suite/remote_env.rs`

`test` · `test run`

Codex can be asked to run commands or edit files in more than one place: the user's local workspace and a remote environment such as a Docker container. This test file makes sure Codex sends each action to the right place and respects safety rules while doing it. Without these tests, a model might accidentally write to the local machine when it meant to write remotely, skip a required approval, or let a path escape a sandboxed folder.

The file uses mock model responses, so the tests can pretend the model asked to run a command, request permissions, or apply a patch. Then the tests watch what Codex does: which environment it chooses, what events it emits, whether approvals are requested, and what files actually change.

Several tests focus on sandboxing, which means limiting what files an operation may read or write. They check normal access, rejected path tricks such as symlinks and `..`, and safe behavior around symbolic links. A symbolic link is like a shortcut to another file; these tests make sure removing or copying the shortcut does not unexpectedly damage the target.

Many tests skip themselves when no remote test environment is available. That keeps the suite usable on machines that cannot run the remote Docker-style setup.

#### Function details

##### `unified_exec_test`  (lines 61–71)

```
async fn unified_exec_test(server: &wiremock::MockServer) -> Result<TestCodex>
```

**Purpose**: Builds a test Codex instance with the experimental unified execution tool turned on. This is used by tests that need command execution to work the same way across local and remote environments.

**Data flow**: It receives a mock server that will stand in for the model service. It starts from the standard test Codex builder, changes the configuration to enable unified execution, then builds a Codex test instance connected to both remote and local environments. The result is a ready-to-use `TestCodex`.

**Call relations**: The command-routing and intercepted-apply-patch tests call this helper before they submit model turns. It relies on the shared `test_codex` builder, then hands the prepared test object back to those tests.

*Call graph*: calls 1 internal fn (test_codex); called by 2 (apply_patch_intercepted_exec_command_routes_to_selected_remote_environment, exec_command_routes_to_selected_remote_environment).


##### `submit_turn_with_approval_and_environments`  (lines 73–110)

```
async fn submit_turn_with_approval_and_environments(
    test: &TestCodex,
    prompt: &str,
    environments: Vec<TurnEnvironmentSelection>,
) -> Result<()>
```

**Purpose**: Submits a user prompt while explicitly telling Codex which environments are available and that user approval should be required on request. This gives tests a controlled setup for approval-related behavior.

**Data flow**: It takes a test Codex instance, a prompt, and a list of selected environments. It wraps the prompt as user text, builds thread settings that include those environments, a read-only sandbox, and user-reviewed approval settings, then submits that operation to Codex. It returns success or an error from submission.

**Call relations**: Approval-focused tests use this helper when they need the same environment and approval setup across several turns. It builds the environment selection and submits it; later helpers and test code wait for approval or completion events.

*Call graph*: calls 1 internal fn (new); called by 2 (apply_patch_approvals_are_remembered_per_environment, remote_request_permissions_grant_unblocks_later_remote_exec); 3 external calls (default, new_read_only_policy, vec!).


##### `expect_patch_approval`  (lines 112–132)

```
async fn expect_patch_approval(
    test: &TestCodex,
    expected_call_id: &str,
) -> ApplyPatchApprovalRequestEvent
```

**Purpose**: Waits until Codex asks for approval to apply a patch, and checks that the request is for the expected tool call. It fails the test if the turn finishes first.

**Data flow**: It receives the test Codex instance and the call ID it expects. It watches events until either a patch approval request or turn completion appears. If the approval request arrives with the expected ID, it returns that request; otherwise it panics with a clear test failure.

**Call relations**: The patch-approval scoping test calls this after submitting a turn that should need approval. Internally it uses the shared event-waiting helper, then hands the approval request back so the test can approve it.

*Call graph*: called by 1 (apply_patch_approvals_are_remembered_per_environment); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `wait_for_completion_without_patch_approval`  (lines 134–150)

```
async fn wait_for_completion_without_patch_approval(test: &TestCodex)
```

**Purpose**: Confirms that a turn completes without asking for patch approval. This is used to prove that a previous approval was remembered where it should be.

**Data flow**: It receives the test Codex instance and waits for either a patch approval request or a turn-complete event. If completion arrives first, it does nothing further. If a patch approval appears, it panics because that means approval was unexpectedly required.

**Call relations**: The patch-approval memory test calls this for a follow-up remote patch. It uses the same event stream watched by `expect_patch_approval`, but expects the opposite outcome.

*Call graph*: called by 1 (apply_patch_approvals_are_remembered_per_environment); 2 external calls (wait_for_event, panic!).


##### `remote_test_env_can_connect_and_use_filesystem`  (lines 153–185)

```
async fn remote_test_env_can_connect_and_use_filesystem() -> Result<()>
```

**Purpose**: Checks the basic remote filesystem connection. It proves the test environment can write, read, and remove a file remotely.

**Data flow**: It first checks whether a remote test environment exists, and exits quietly if not. It creates a test environment, writes bytes to a remote file path, reads the bytes back, compares them to the original data, and removes the file. The test succeeds only if all remote filesystem operations behave as expected.

**Call relations**: This is a standalone test that uses the shared test environment builder and remote environment lookup. It is an early smoke test for the filesystem layer that later remote tests depend on.

*Call graph*: calls 2 internal fn (test_env, from_path); 2 external calls (assert_eq!, get_remote_test_env).


##### `remote_test_env_exposes_target_shell_to_model`  (lines 188–229)

```
async fn remote_test_env_exposes_target_shell_to_model() -> Result<()>
```

**Purpose**: Verifies that Codex tells the model the correct shell for the remote environment. This matters because commands for Bash and PowerShell are written differently.

**Data flow**: It starts a mock model server, mounts a simple model response, builds Codex with a remote environment, and submits a prompt. It then inspects the text sent to the model, finds the environment context block, and checks that the `<shell>` value matches the remote target: Bash for Docker or PowerShell for Wine execution.

**Call relations**: This standalone test calls the mock-server helpers and the standard Codex test builder. It reads the captured model request from the mock response to confirm the model-visible environment information is correct.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (assert_eq!, get_remote_test_env, test_environment, unreachable!, vec!).


##### `absolute_path`  (lines 231–233)

```
fn absolute_path(path: PathBuf) -> AbsolutePathBuf
```

**Purpose**: Converts a normal path into an absolute-path type and fails loudly if the path is not absolute. The stricter type helps sandbox tests avoid accidentally passing relative paths.

**Data flow**: It receives a `PathBuf`. It tries to turn it into an `AbsolutePathBuf`. If that conversion succeeds, it returns the absolute path; if not, it panics with a test-only expectation message.

**Call relations**: Sandbox helper functions call this before building permission rules. The symlink removal test also uses it when asking for metadata with a path that must be absolute.

*Call graph*: calls 1 internal fn (try_from); called by 3 (read_only_sandbox, remote_test_env_remove_removes_symlink_not_target, workspace_write_sandbox).


##### `read_only_sandbox`  (lines 235–246)

```
fn read_only_sandbox(readable_root: PathBuf) -> FileSystemSandboxContext
```

**Purpose**: Creates a sandbox rule that allows reading from one chosen root folder and restricts network access. It gives tests a simple way to say, 'this operation may only read here.'

**Data flow**: It receives a readable root path, converts it to an absolute path, builds a filesystem policy that grants read access to that one path, combines it with a restricted network policy, and returns a filesystem sandbox context.

**Call relations**: The remote sandbox read tests call this before attempting allowed and forbidden reads. It uses `absolute_path` to make sure the policy is built from a precise location.

*Call graph*: calls 4 internal fn (absolute_path, from_permission_profile, from_runtime_permissions, restricted); called by 2 (remote_test_env_sandboxed_read_allows_readable_root, remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape); 1 external calls (vec!).


##### `workspace_write_sandbox`  (lines 248–259)

```
fn workspace_write_sandbox(writable_root: PathBuf) -> FileSystemSandboxContext
```

**Purpose**: Creates a sandbox rule that allows writing inside one chosen root folder and restricts network access. It is used to test write-like operations under controlled permissions.

**Data flow**: It receives a writable root path, converts it to an absolute path, builds a filesystem policy that grants write access to that path, combines it with restricted networking, and returns a filesystem sandbox context.

**Call relations**: The symlink remove and copy tests call this before modifying files. Like `read_only_sandbox`, it depends on `absolute_path` so the permission boundary is unambiguous.

*Call graph*: calls 4 internal fn (absolute_path, from_permission_profile, from_runtime_permissions, restricted); called by 2 (remote_test_env_copy_preserves_symlink_source, remote_test_env_remove_removes_symlink_not_target); 1 external calls (vec!).


##### `assert_normalized_path_rejected`  (lines 261–278)

```
fn assert_normalized_path_rejected(error: &std::io::Error)
```

**Purpose**: Checks that a rejected path produced an acceptable kind of error. It is used when the exact operating-system message may vary but the operation must clearly be denied or impossible.

**Data flow**: It receives an I/O error from a failed filesystem operation. It looks at the error kind and message. If the error says the path was not found, invalid, or not permitted in an expected way, the assertion passes; otherwise the test panics.

**Call relations**: The path-escape sandbox test calls this after trying to read through a symlink and `..`. It turns platform-specific error wording into one clear test expectation.

*Call graph*: called by 1 (remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape); 4 external calls (assert!, kind, to_string, panic!).


##### `remote_exec`  (lines 280–295)

```
fn remote_exec(script: &str) -> Result<()>
```

**Purpose**: Runs a shell script directly inside the Docker-backed remote test container. This is used to set up filesystem shapes that are awkward to create through the normal API, such as symlinks.

**Data flow**: It looks up the configured remote environment and its Docker container name. It runs `docker exec ... sh -lc <script>`, checks that the command succeeded, and returns success or an error. If the command fails, the test output includes stdout and stderr.

**Call relations**: The symlink-related remote tests call this to create or clean up files inside the container. It bypasses Codex’s filesystem API on purpose so the test can prepare exact remote conditions before testing the API.

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

**Purpose**: Simulates a model asking Codex to run an `exec_command`, then returns the command output that Codex sent back to the model. This lets a test check which environment actually ran the command.

**Data flow**: It receives a test instance, mock server, call ID, JSON arguments for the command, and optional environment selections. It mounts a two-step mock model conversation: first a function call, then a final assistant message. It submits the turn and extracts the function-call output text for the given call ID.

**Call relations**: The remote command routing test calls this after setting up local and remote marker files. This helper drives the mocked model exchange and hands back the observed command output for assertions.

*Call graph*: calls 2 internal fn (mount_sse_sequence, submit_turn_with_environments); called by 1 (exec_command_routes_to_selected_remote_environment); 1 external calls (vec!).


##### `exec_command_routes_to_selected_remote_environment`  (lines 330–404)

```
async fn exec_command_routes_to_selected_remote_environment() -> Result<()>
```

**Purpose**: Tests that an `exec_command` with the remote environment ID runs in the remote working directory, not the local one. This protects against dangerous environment mix-ups.

**Data flow**: It skips when the needed network or Docker-style remote setup is unavailable. It creates a local folder with one marker value and a remote folder with another, then asks the mocked model to run `cat marker.txt` in the remote environment. It checks the output contains the remote marker and not the local marker, then removes the remote folder.

**Call relations**: This test uses `unified_exec_test` to enable unified command execution and `exec_command_routing_output` to perform the mocked function-call flow. It prepares the filesystem state before the helper runs the command.

*Call graph*: calls 6 internal fn (start_mock_server, local, exec_command_routing_output, unified_exec_test, from_abs_path, from_path); 10 external calls (from, new, assert!, get_remote_test_env, format!, write, json!, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `remote_request_permissions_grant_unblocks_later_remote_exec`  (lines 407–610)

```
async fn remote_request_permissions_grant_unblocks_later_remote_exec() -> Result<()>
```

**Purpose**: Tests that when the model requests remote filesystem permission and the user grants it, a later remote command can run without another approval. It also confirms the grant applies to the remote environment, not the local one.

**Data flow**: It builds Codex with command execution, execution approvals, and the request-permissions tool enabled. It creates matching local and remote paths, has the mocked model first request write permission for a remote folder, waits for the permission request event, submits an approval response, and then lets the mocked model run a remote shell command that writes a file. It checks the approval response was returned to the model, the command output is correct, the remote file exists with the expected contents, and the local file was not created.

**Call relations**: This test uses `submit_turn_with_approval_and_environments` to start the turn with both environments and approval settings. It relies on the mock SSE sequence to make the model request permissions first and execute afterward, then watches Codex events to ensure the permission grant unblocks the command.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_turn_with_approval_and_environments, from_read_write_roots, from_abs_path, from_path); 14 external calls (from, new, default, assert!, assert_eq!, get_remote_test_env, wait_for_event, format!, create_dir, panic! (+4 more)).


##### `apply_patch_freeform_routes_to_selected_remote_environment`  (lines 613–698)

```
async fn apply_patch_freeform_routes_to_selected_remote_environment() -> Result<()>
```

**Purpose**: Tests that a freeform `apply_patch` tool call containing a remote environment ID edits the remote workspace. It ensures the same patch is not accidentally applied locally.

**Data flow**: It creates a remote working directory and a separate local temporary directory. The mocked model sends an apply-patch request that names the remote environment and adds a file. After the turn, the test reads the file from the remote filesystem, checks its contents, confirms no matching local file was created, and cleans up the remote directory.

**Call relations**: This standalone routing test uses the mock server helpers and the standard test Codex builder. The mocked apply-patch call drives Codex’s patch path, and the filesystem assertions prove where the patch landed.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, from_path); 9 external calls (from, new, assert!, assert_eq!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `apply_patch_approvals_are_remembered_per_environment`  (lines 701–885)

```
async fn apply_patch_approvals_are_remembered_per_environment() -> Result<()>
```

**Purpose**: Tests that patch approvals are remembered separately for local and remote environments. A session approval for local edits must not silently approve remote edits, but a remote approval should cover later remote edits.

**Data flow**: It sets approval policy to require user review on request, then prepares local and remote environments plus a shared-looking target path. The mocked model first applies a local patch; the test expects approval and approves it for the session. Then the model applies a remote patch; the test again expects approval because this is a different environment. Finally, the model applies another remote patch, and the test expects completion without a new approval. It verifies file contents after each step and cleans up.

**Call relations**: This test depends on `submit_turn_with_approval_and_environments` to submit each turn, `expect_patch_approval` to catch the first two approvals, and `wait_for_completion_without_patch_approval` to prove the remembered remote approval is used on the follow-up.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_patch_approval, submit_turn_with_approval_and_environments, wait_for_completion_without_patch_approval, from_path); 10 external calls (from, new, assert_eq!, get_remote_test_env, wait_for_event, format!, remove_file, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `apply_patch_intercepted_exec_command_routes_to_selected_remote_environment`  (lines 888–983)

```
async fn apply_patch_intercepted_exec_command_routes_to_selected_remote_environment() -> Result<()>
```

**Purpose**: Tests a special case where the model asks to run a shell command that invokes `apply_patch`. Codex intercepts that pattern, and this test ensures the intercepted patch still applies to the selected remote environment.

**Data flow**: It creates a remote working directory and a local temporary directory. The mocked model sends an `exec_command` whose command text contains an `apply_patch` heredoc and whose environment ID is remote. After the turn, the test checks that the new file exists in the remote directory with the expected content and does not exist locally, then removes the remote directory.

**Call relations**: This test uses `unified_exec_test` because it exercises the unified execution tool path. The mock SSE sequence makes the model call `exec_command`, while Codex’s interception behavior turns the embedded patch into a filesystem edit.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, unified_exec_test, from_path); 9 external calls (from, new, assert!, assert_eq!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `remote_test_env_sandboxed_read_allows_readable_root`  (lines 986–1034)

```
async fn remote_test_env_sandboxed_read_allows_readable_root() -> Result<()>
```

**Purpose**: Tests that a remote sandbox permits reading a file inside an explicitly readable root folder. This is the positive case for read sandboxing.

**Data flow**: It skips if the required remote setup is unavailable. It creates a remote directory and file, builds a read-only sandbox for that directory, reads the file through the sandbox, and checks the bytes match. It then removes the directory.

**Call relations**: This standalone sandbox test uses `read_only_sandbox` to create the permission boundary. It uses the remote filesystem from the shared test environment to prove allowed reads still work.

*Call graph*: calls 3 internal fn (test_env, read_only_sandbox, from_path); 6 external calls (from, assert_eq!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!).


##### `remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape`  (lines 1037–1070)

```
async fn remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape() -> Result<()>
```

**Purpose**: Tests that a remote read sandbox blocks a path escape that combines a symbolic link with `..`, which means 'parent directory'. This protects against a common trick for reaching files outside an allowed folder.

**Data flow**: It creates, directly inside the remote container, an allowed folder, an outside folder, a secret file, and a symlink from the allowed folder to the outside folder. It then asks the remote filesystem to read a path that goes through the symlink and back up with `..` toward the secret file. The read must fail, and the error is checked as an expected rejection. Finally it removes the setup.

**Call relations**: This test uses `remote_exec` to prepare the exact symlink layout, `read_only_sandbox` to allow only the intended folder, and `assert_normalized_path_rejected` to verify the failure is the right kind of denial.

*Call graph*: calls 5 internal fn (test_env, assert_normalized_path_rejected, read_only_sandbox, remote_exec, from_path); 6 external calls (from, bail!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!).


##### `remote_test_env_remove_removes_symlink_not_target`  (lines 1073–1141)

```
async fn remote_test_env_remove_removes_symlink_not_target() -> Result<()>
```

**Purpose**: Tests that removing a symlink in a writable sandbox removes only the shortcut, not the file it points to. This prevents a safe-looking delete inside the sandbox from deleting outside data.

**Data flow**: It creates a remote folder with a symlink inside the allowed area pointing to a file outside it. With a write sandbox limited to the allowed folder, it removes the symlink path. It then checks the symlink is gone but the outside target file still exists and still contains its original text. Finally it removes the whole test tree.

**Call relations**: This test uses `remote_exec` for setup, `workspace_write_sandbox` for the write boundary, and `absolute_path` where an absolute metadata path is required. It validates the remote filesystem remove behavior under sandbox rules.

*Call graph*: calls 6 internal fn (test_env, absolute_path, remote_exec, workspace_write_sandbox, from_abs_path, from_path); 7 external calls (from, assert!, assert_eq!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!).


##### `remote_test_env_copy_preserves_symlink_source`  (lines 1144–1217)

```
async fn remote_test_env_copy_preserves_symlink_source() -> Result<()>
```

**Purpose**: Tests that copying a symlink copies the symlink itself rather than the file it points to. This matters because following the link could leak or duplicate data outside the sandbox.

**Data flow**: It creates a remote symlink inside an allowed folder that points to a file outside that folder. With a write sandbox for the allowed folder, it copies the symlink to a new name. It then runs `readlink` inside the container to confirm the copied item is still a symlink and points to the same outside target. Finally it removes the test tree.

**Call relations**: This test uses `remote_exec` to create the original symlink and `workspace_write_sandbox` to constrain the copy operation. It also directly calls Docker afterward to inspect the copied symlink’s target.

*Call graph*: calls 4 internal fn (test_env, remote_exec, workspace_write_sandbox, from_path); 8 external calls (from, assert!, assert_eq!, new, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec!).
