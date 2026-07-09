# Approvals, permissions, hooks, and review-mediation suites  `stage-23.2.4.5`

This stage tests the safety gates that sit around Codex while it is doing its main work. These gates decide when an action can run, when the user must be asked, and when something must be blocked. The approval, exec policy, skill approval, and zsh-fork approval tests check shell commands, patches, file writes, network access, and sandbox limits. The permission request tests check the path where Codex asks for extra access, receives a limited grant, and then must obey exactly that grant.

Other tests cover human and reviewer mediation. The request-user-input tests check that Codex can pause to ask a question and resume correctly. The review and Guardian review tests check separate reviewer flows, including automatic safety review, without leaking private review details. MCP metadata tests ensure tool calls to external app servers carry the right approval and review information.

The hook and hook-MCP tests cover small user or plugin scripts that can inspect, block, rewrite, or add context around actions. The notification test checks the final “turn finished” message sent to a user command.

## Files in this stage

### Approval policy enforcement
These tests establish the core runtime approval and execution-policy matrix, including general approvals, unified exec behavior, and skill-script privilege boundaries.

### `core/tests/suite/approvals.rs`

`test` · `test run`

This is an integration test suite for the permission system. Codex can run shell commands, edit files, apply patches, use the network, and spawn helper agents, but those actions must respect the user's safety settings. This file sets up many realistic situations, like writing inside or outside the workspace, running a trusted command, applying a patch, fetching a URL, or asking for broader permissions. It then checks whether Codex does the right thing: proceed, ask for approval, remember an approved rule, deny access, or retry after a sandbox failure.

A useful way to read it is as a safety checklist. The `ScenarioSpec` entries describe a starting policy, an attempted action, the expected approval behavior, and the final result. Helper functions build fake model responses, submit turns to a test Codex session, wait for approval events, and inspect command output. Extra tests cover longer stories, such as approving a patch once for a session, saving command rules for future runs, propagating approvals from subagents, and network policy amendments. Without this file, changes to sandboxing or approvals could silently allow dangerous actions or annoy users with unnecessary prompts.

#### Function details

##### `TargetPath::resolve_for_patch`  (lines 77–90)

```
fn resolve_for_patch(self, test: &TestCodex) -> (PathBuf, String)
```

**Purpose**: Turns a test target name into both a real file path and the path text that should appear in a patch. It lets the same test action target either the temporary workspace or a location outside it.

**Data flow**: It receives a `TargetPath` and the current test session. For workspace targets, it joins the name to the test working directory; for outside targets, it joins the name to the process current directory. It returns the real path to touch on disk and the string path to place in patch text.

**Call relations**: Patch and file-writing helpers call this before building commands or checking results. It is the small translation step between a scenario's human-readable target and the actual file system location used by the test.

*Call graph*: 1 external calls (current_dir).


##### `ActionKind::policy_src`  (lines 136–148)

```
fn policy_src(&self) -> Option<&'static str>
```

**Purpose**: Returns extra rule-file text for actions that need a custom command policy. Most actions do not need one, so they return nothing.

**Data flow**: It reads the selected action variant. If the action is `RunCommandWithPolicy`, it extracts the embedded policy source text; otherwise it returns `None`.

**Call relations**: The scenario runner asks this before building the test Codex instance. If policy text is present, the runner writes it into the test home directory so the command approval system sees it during the scenario.


##### `ActionKind::prepare`  (lines 150–297)

```
async fn prepare(
        &self,
        test: &TestCodex,
        server: &MockServer,
        call_id: &str,
        sandbox_permissions: SandboxPermissions,
    ) -> Result<(Value, Option<String>)>
```

**Purpose**: Builds the fake model tool call for a scenario. In plain terms, it prepares the exact command, patch, or network request that Codex will be told to execute during the test.

**Data flow**: It receives the action, test environment, mock server, call id, and sandbox permission request. It may create mock HTTP responses, delete leftover files, build shell or exec-command JSON, or create patch text. It returns the model event to feed into Codex plus, when relevant, the command string expected in an approval prompt.

**Call relations**: The main scenario runner calls this for every scenario before mounting mocked server responses. It delegates to helpers such as `shell_event`, `exec_command_event`, `build_add_file_patch`, and `shell_apply_patch_command` so each action is represented in the same format Codex normally receives from the model.

*Call graph*: calls 6 internal fn (ev_apply_patch_custom_tool_call, build_add_file_patch, exec_command_event, shell_apply_patch_command, shell_event, shell_event_with_prefix_rule); 6 external calls (given, new, format!, remove_file, method, path).


##### `build_add_file_patch`  (lines 300–302)

```
fn build_add_file_patch(patch_path: &str, content: &str) -> String
```

**Purpose**: Creates a minimal patch that adds one file with given content. Tests use it to simulate the model asking Codex to apply a file-creation patch.

**Data flow**: It takes the path text that should appear in the patch and the desired file content. It formats those into a Begin Patch / Add File / End Patch block and returns the patch string.

**Call relations**: Action preparation uses it for patch scenarios, and a session-level patch approval test uses it directly. It supplies the patch body that later flows into custom patch tool calls or shell `apply_patch` commands.

*Call graph*: called by 2 (prepare, approving_apply_patch_for_session_skips_future_prompts_for_same_file); 1 external calls (format!).


##### `shell_apply_patch_command`  (lines 304–312)

```
fn shell_apply_patch_command(patch: &str) -> String
```

**Purpose**: Wraps patch text in a shell command that runs `apply_patch` through a here-document. A here-document is a shell way to feed a block of text into a command.

**Data flow**: It receives patch text, starts a command string with `apply_patch <<'PATCH'`, appends the patch, ensures there is a trailing newline, and closes the block. It returns a complete shell command.

**Call relations**: Patch-shell action preparation calls this after building the patch. The result is then passed into `shell_event` so Codex sees it like any other shell command from the model.

*Call graph*: called by 1 (prepare); 1 external calls (from).


##### `shell_event`  (lines 314–327)

```
fn shell_event(
    call_id: &str,
    command: &str,
    timeout_ms: u64,
    sandbox_permissions: SandboxPermissions,
) -> Result<Value>
```

**Purpose**: Creates a model function-call event for the standard shell command tool. It is the simple path when no custom prefix rule is requested.

**Data flow**: It receives a call id, command string, timeout, and sandbox permission request. It forwards those values to `shell_event_with_prefix_rule` with no prefix rule. The result is a JSON event representing a shell tool call.

**Call relations**: Many tests and action preparations use this to create realistic shell calls. It keeps common setup short while leaving the more detailed JSON-building work to `shell_event_with_prefix_rule`.

*Call graph*: calls 1 internal fn (shell_event_with_prefix_rule); called by 6 (prepare, denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt, env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, network_approval_flow_survives_danger_full_access_session_start, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command).


##### `shell_event_with_prefix_rule`  (lines 329–348)

```
fn shell_event_with_prefix_rule(
    call_id: &str,
    command: &str,
    timeout_ms: u64,
    sandbox_permissions: SandboxPermissions,
    prefix_rule: Option<Vec<String>>,
) -> Result<Value>
```

**Purpose**: Creates a shell-command tool call, optionally including a requested command prefix rule. Prefix rules are saved patterns such as “allow commands starting with `touch file.txt`.”

**Data flow**: It receives command details, sandbox permissions, and maybe a prefix rule. It builds a JSON argument object, adds sandbox override information only when requested, adds the prefix rule if present, serializes it to text, and returns a function-call event.

**Call relations**: This is the central helper for shell-command events. `shell_event` calls it for the simple case, while targeted tests call it directly to check how invalid or fallback prefix rules behave.

*Call graph*: calls 2 internal fn (ev_function_call, requests_sandbox_override); called by 4 (prepare, approving_fallback_rule_for_compound_command_works, invalid_requested_prefix_rule_falls_back_for_compound_command, shell_event); 2 external calls (json!, to_string).


##### `exec_command_event`  (lines 350–370)

```
fn exec_command_event(
    call_id: &str,
    cmd: &str,
    yield_time_ms: Option<u64>,
    sandbox_permissions: SandboxPermissions,
    justification: Option<&str>,
) -> Result<Value>
```

**Purpose**: Creates a model tool call for the newer unified exec command tool. This is used when tests enable the unified execution feature.

**Data flow**: It receives a call id, command, optional yield time, sandbox permission request, and optional justification. It builds JSON arguments, includes escalation permissions and a reason when needed, serializes them, and returns an exec-command function-call event.

**Call relations**: Unified-exec scenario preparation calls this. It lets the shared scenario runner exercise both old shell-command behavior and the newer exec-command flow.

*Call graph*: calls 2 internal fn (ev_function_call, requests_sandbox_override); called by 1 (prepare); 2 external calls (json!, to_string).


##### `Expectation::verify`  (lines 411–600)

```
fn verify(&self, test: &TestCodex, result: &CommandResult) -> Result<()>
```

**Purpose**: Checks whether the scenario ended the way it promised. It verifies command exit status, output text, file contents, patch results, or network success and failure.

**Data flow**: It receives the test environment and a parsed command result. Depending on the expectation variant, it reads files, checks stdout, checks exit codes, confirms files exist or do not exist, and cleans up created files. It returns success or fails the test with a clear assertion.

**Call relations**: After `run_scenario` extracts the tool output and parses it, it calls this method as the final judge. This is where the scenario's expected behavior becomes concrete test evidence.

*Call graph*: 6 external calls (assert!, assert_eq!, assert_ne!, read_to_string, remove_file, panic!).


##### `submit_turn`  (lines 648–684)

```
async fn submit_turn(
    test: &TestCodex,
    prompt: &str,
    approval_policy: AskForApproval,
    sandbox_policy: SandboxPolicy,
) -> Result<()>
```

**Purpose**: Sends a user message into a test Codex session with the approval and sandbox settings for that scenario. It starts the piece of conversation that should trigger the mocked model tool call.

**Data flow**: It receives the test session, prompt text, approval policy, and sandbox policy. It builds a user-input operation with local environment selection, user approval reviewer, sandbox policy, and model settings, then submits it to Codex. It returns when the submission has been accepted.

**Call relations**: The scenario runner and several longer tests call this whenever they need Codex to process a new turn. It is the bridge from test setup into the real Codex event flow.

*Call graph*: calls 1 internal fn (local_selections); called by 9 (approving_apply_patch_for_session_skips_future_prompts_for_same_file, approving_execpolicy_amendment_persists_policy_and_skips_future_prompts, approving_fallback_rule_for_compound_command_works, compound_command_with_one_safe_command_still_requires_approval, denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt, invalid_requested_prefix_rule_falls_back_for_compound_command, network_approval_flow_survives_danger_full_access_session_start, run_scenario, spawned_subagent_execpolicy_amendment_propagates_to_parent_session); 2 external calls (default, vec!).


##### `parse_result`  (lines 686–724)

```
fn parse_result(item: &Value) -> CommandResult
```

**Purpose**: Turns the model-facing tool output into a simpler `CommandResult` with an exit code and stdout text. It supports both structured JSON output and older free-form text formats.

**Data flow**: It receives a JSON item from the mocked result request. It reads the `output` field, first tries to parse it as JSON, and otherwise uses regular expressions to find an exit code and output section. It returns a normalized command result, using no exit code when the format does not include one.

**Call relations**: Scenario and follow-up tests call this after Codex sends tool results back to the mocked server. Its normalized output is then checked by `Expectation::verify` or direct assertions.

*Call graph*: called by 7 (approving_execpolicy_amendment_persists_policy_and_skips_future_prompts, approving_fallback_rule_for_compound_command_works, denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt, env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command, run_scenario); 2 external calls (new, get).


##### `expect_exec_approval`  (lines 726–751)

```
async fn expect_exec_approval(
    test: &TestCodex,
    expected_command: &str,
) -> ExecApprovalRequestEvent
```

**Purpose**: Waits until Codex asks for command execution approval, and confirms the prompt refers to the expected command. It fails if the turn finishes first.

**Data flow**: It receives the test session and expected command string. It waits for either an exec approval request or turn completion, checks that the last command argument matches the expected command, and returns the approval event.

**Call relations**: The scenario runner and command-policy tests call this at the moment an approval prompt should appear. The returned approval is then answered with approved, denied, or a saved policy amendment.

*Call graph*: called by 5 (approving_execpolicy_amendment_persists_policy_and_skips_future_prompts, approving_fallback_rule_for_compound_command_works, compound_command_with_one_safe_command_still_requires_approval, invalid_requested_prefix_rule_falls_back_for_compound_command, run_scenario); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `expect_patch_approval`  (lines 753–773)

```
async fn expect_patch_approval(
    test: &TestCodex,
    expected_call_id: &str,
) -> ApplyPatchApprovalRequestEvent
```

**Purpose**: Waits until Codex asks for patch approval, and confirms the request belongs to the expected tool call. It fails if Codex completes without asking.

**Data flow**: It receives the test session and expected call id. It waits for a patch approval request or turn completion, checks the call id, and returns the approval request event.

**Call relations**: Patch scenarios and the session-level patch test use this before submitting a patch approval decision. It marks the point where the test verifies that patch safety checks actually interrupted execution.

*Call graph*: called by 2 (approving_apply_patch_for_session_skips_future_prompts_for_same_file, run_scenario); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `wait_for_completion_without_approval`  (lines 775–791)

```
async fn wait_for_completion_without_approval(test: &TestCodex)
```

**Purpose**: Waits for a turn to finish and fails if Codex asks for command approval. It is used when a scenario should run automatically.

**Data flow**: It receives the test session, waits for either an exec approval request or turn completion, accepts only turn completion, and panics if an approval request appears.

**Call relations**: Automatic-run scenarios and saved-rule tests call this after submitting a turn. It proves that Codex did not bother the user when the action should already be allowed.

*Call graph*: called by 5 (approving_execpolicy_amendment_persists_policy_and_skips_future_prompts, approving_fallback_rule_for_compound_command_works, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, run_scenario, spawned_subagent_execpolicy_amendment_propagates_to_parent_session); 2 external calls (wait_for_event, panic!).


##### `wait_for_completion`  (lines 793–798)

```
async fn wait_for_completion(test: &TestCodex)
```

**Purpose**: Waits until Codex reports that the current turn is complete. It is the simple “let the run finish” helper.

**Data flow**: It receives the test session and waits for a `TurnComplete` event. It does not inspect outputs itself.

**Call relations**: Tests call this after they have answered an approval request or otherwise expect the workflow to continue. Later steps then inspect files, policy files, or tool output.

*Call graph*: called by 9 (approving_apply_patch_for_session_skips_future_prompts_for_same_file, approving_execpolicy_amendment_persists_policy_and_skips_future_prompts, approving_fallback_rule_for_compound_command_works, compound_command_with_one_safe_command_still_requires_approval, denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt, env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, network_approval_flow_survives_danger_full_access_session_start, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command, run_scenario); 1 external calls (wait_for_event).


##### `body_contains`  (lines 800–818)

```
fn body_contains(req: &Request, text: &str) -> bool
```

**Purpose**: Checks whether a mocked HTTP request body contains a piece of text, even if the request body was compressed with zstd. This lets tests route mock responses based on what Codex sent.

**Data flow**: It receives a mock HTTP request and search text. It checks the content-encoding header, decompresses the body if needed, converts bytes to UTF-8 text, and returns whether the text appears.

**Call relations**: Request-matching closures use this in multi-step tests, especially parent/child agent flows. It helps the mock server send the right fake model response for the right conversation stage.

*Call graph*: calls 1 internal fn (new); 1 external calls (decode_all).


##### `wait_for_spawned_thread`  (lines 820–839)

```
async fn wait_for_spawned_thread(test: &TestCodex) -> Result<Arc<CodexThread>>
```

**Purpose**: Waits for a child Codex thread to appear after a test asks a subagent to be spawned. A thread is a separate conversation or task running under the same test manager.

**Data flow**: It receives the test session, repeatedly lists known thread ids until it finds one different from the parent session, retrieves that thread, and returns it. If none appears within the deadline, it returns an error.

**Call relations**: The subagent approval propagation test calls this after the parent turn starts. Once it gets the child thread, the test can listen for and answer the child's approval request.

*Call graph*: called by 1 (spawned_subagent_execpolicy_amendment_propagates_to_parent_session); 5 external calls (from_millis, from_secs, bail!, now, sleep).


##### `scenarios`  (lines 841–1839)

```
fn scenarios() -> Vec<ScenarioSpec>
```

**Purpose**: Defines the main approval test matrix. Each scenario names a policy setup, an attempted action, the expected approval outcome, and the final observable result.

**Data flow**: It constructs and returns a vector of `ScenarioSpec` values. The entries cover full access, read-only access, workspace-write access, patch behavior, network behavior, trusted command rules, and unified exec behavior.

**Call relations**: The group runner calls this and filters it by scenario group. The individual scenario runner then executes each selected spec in the same repeatable harness.

*Call graph*: called by 1 (run_scenario_group); 1 external calls (vec!).


##### `approval_matrix_covers_group`  (lines 1847–1849)

```
async fn approval_matrix_covers_group(group: ScenarioGroup) -> Result<()>
```

**Purpose**: Runs the approval matrix for one category of scenarios. The test framework calls it once for each named group.

**Data flow**: It receives a scenario group from the test-case macro and calls `run_scenario_group`. The result is passed back to the async test framework.

**Call relations**: This is the test entry point for the large scenario table. It delegates all real work to `run_scenario_group` so each group uses the same runner.

*Call graph*: calls 1 internal fn (run_scenario_group).


##### `run_scenario_group`  (lines 1851–1867)

```
async fn run_scenario_group(group: ScenarioGroup) -> Result<()>
```

**Purpose**: Runs all matrix scenarios belonging to one group, such as read-only or apply-patch tests. It skips when network-dependent tests cannot run.

**Data flow**: It receives a group, builds the full scenario list, filters it with `scenario_group`, checks that the group is not empty, and runs each scenario. If one fails, it adds the scenario name to the error context.

**Call relations**: `approval_matrix_covers_group` calls this for each test-case group. It calls `scenarios` to get the data and `run_scenario` to perform the actual Codex interaction.

*Call graph*: calls 2 internal fn (run_scenario, scenarios); called by 1 (approval_matrix_covers_group); 2 external calls (assert!, skip_if_no_network!).


##### `scenario_group`  (lines 1869–1887)

```
fn scenario_group(scenario: &ScenarioSpec) -> ScenarioGroup
```

**Purpose**: Classifies a scenario into a broad group so the large matrix can be split into smaller test cases. This keeps failures easier to locate and test runs easier to schedule.

**Data flow**: It receives a scenario spec and looks at its action and sandbox policy. Patch actions become the patch group, unified exec actions become the unified exec group, and other actions are grouped by sandbox type.

**Call relations**: The group runner uses this while filtering the scenario table. It has no side effects; it is just the sorting rule for the matrix.


##### `run_scenario`  (lines 1889–2055)

```
async fn run_scenario(scenario: &ScenarioSpec) -> Result<()>
```

**Purpose**: Executes one scenario from start to finish. It is the main harness that turns a scenario description into a real Codex run and checks the result.

**Data flow**: It receives a scenario spec, starts a mock server, builds a configured test Codex session, prepares the action event, mounts fake model responses, submits the user turn, answers any expected approval request, waits for completion, extracts the tool output, parses it, and verifies the expectation.

**Call relations**: `run_scenario_group` calls this for every matrix entry. It coordinates the helper functions in this file: action preparation, turn submission, approval waiting, result parsing, and expectation checking.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, expect_patch_approval, parse_result, submit_turn, wait_for_completion, wait_for_completion_without_approval); called by 1 (run_scenario_group); 4 external calls (assert_eq!, eprintln!, matches!, vec!).


##### `approving_apply_patch_for_session_skips_future_prompts_for_same_file`  (lines 2059–2176)

```
async fn approving_apply_patch_for_session_skips_future_prompts_for_same_file() -> Result<()>
```

**Purpose**: Tests that approving a patch for the whole session lets later patches to the same file proceed without another prompt. This checks that session-scoped patch trust is remembered.

**Data flow**: It creates an outside-workspace target, sends a first patch that adds the file, approves it with `ApprovedForSession`, confirms the file contains the first content, then sends a second patch updating the file. It expects the second turn to finish without another patch approval and confirms the updated content.

**Call relations**: This standalone test uses patch-building, turn submission, patch approval waiting, and completion helpers. It covers behavior too specific for the table-driven scenarios.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, build_add_file_patch, expect_patch_approval, submit_turn, wait_for_completion); 9 external calls (assert!, OutsideWorkspace, wait_for_event, format!, remove_file, panic!, skip_if_no_network!, try_from_path, vec!).


##### `approving_execpolicy_amendment_persists_policy_and_skips_future_prompts`  (lines 2180–2348)

```
async fn approving_execpolicy_amendment_persists_policy_and_skips_future_prompts() -> Result<()>
```

**Purpose**: Tests that approving a proposed command rule writes it to the rules file and prevents future prompts for the same command. This protects the “remember this command” workflow.

**Data flow**: It runs a command that should prompt, checks the proposed exec-policy amendment, approves that amendment, verifies the developer message and saved policy file, then runs the same command again. The second run should complete without approval and produce the expected empty file.

**Call relations**: This test uses action preparation, exec approval waiting, turn submission, completion waiting, and result parsing. It exercises both the user-facing approval event and the persistent policy file side effect.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, submit_turn, wait_for_completion, wait_for_completion_without_approval); 7 external calls (new, new_read_only_policy, assert!, assert_eq!, read_to_string, remove_file, vec!).


##### `spawned_subagent_execpolicy_amendment_propagates_to_parent_session`  (lines 2351–2537)

```
async fn spawned_subagent_execpolicy_amendment_propagates_to_parent_session() -> Result<()>
```

**Purpose**: Tests that a command rule approved inside a spawned child agent becomes available to the parent session too. This matters because subagents should not learn safety exceptions in isolation.

**Data flow**: It mocks a parent turn that spawns a child, mocks the child running a command, waits for the child approval request, approves the proposed command amendment, confirms the child finishes and creates the file, removes the file, then has the parent run the same command. The parent should complete without another approval.

**Call relations**: This longer test uses request-body matching, spawned-thread waiting, approval submission, and the no-approval completion helper. It connects the multi-agent flow with the persistent approval-rule flow.

*Call graph*: calls 8 internal fn (mount_sse_once, mount_sse_once_match, sse, start_mock_server, test_codex, submit_turn, wait_for_completion_without_approval, wait_for_spawned_thread); 12 external calls (from_secs, new, new_read_only_policy, assert!, assert_eq!, wait_for_event_with_timeout, remove_file, json!, panic!, to_string (+2 more)).


##### `env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork`  (lines 2541–2696)

```
async fn env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork() -> Result<()>
```

**Purpose**: Tests a nested process case: Python starts a script whose shebang uses `env zsh`, and that script requests approval for an out-of-workspace write. It ensures the zsh-fork sandbox path still catches nested risky actions.

**Data flow**: It builds a zsh-fork test runtime, writes an executable zsh script that touches a file outside the workspace, runs that script through Python, waits for an exec approval request for the nested `touch`, approves it, then checks the command output and file creation.

**Call relations**: This standalone Unix test uses zsh-fork setup helpers, shell-event creation, direct turn submission with permission-profile fields, approval waiting, completion waiting, and result parsing. It covers a process-spawning shape not represented in the main scenario matrix.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, local_selections, turn_permission_fields, build_zsh_fork_test, restrictive_workspace_write_profile, zsh_fork_runtime, parse_result, shell_event (+1 more)); 16 external calls (default, from_secs, assert!, assert_eq!, wait_for_event_with_timeout, format!, metadata, set_permissions, write, panic! (+6 more)).


##### `matched_prefix_rule_runs_unsandboxed_under_zsh_fork`  (lines 2700–2799)

```
async fn matched_prefix_rule_runs_unsandboxed_under_zsh_fork() -> Result<()>
```

**Purpose**: Tests that a command matching an allowed prefix rule can run without sandbox blocking under the zsh-fork runtime. It checks that saved allow rules are honored in that execution mode.

**Data flow**: It creates a restrictive profile, writes a rule allowing `touch`, prepares a command that writes outside the workspace, submits the turn, waits for completion without approval, parses the result, and confirms the outside file exists.

**Call relations**: This Unix test combines zsh-fork setup with the no-approval helper. It focuses on the interaction between prefix rules and the zsh-fork sandbox implementation.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, local_selections, turn_permission_fields, build_zsh_fork_test, restrictive_workspace_write_profile, zsh_fork_runtime, parse_result, shell_event (+1 more)); 8 external calls (default, assert!, assert_eq!, format!, skip_if_no_network!, current_dir, tempdir_in, vec!).


##### `invalid_requested_prefix_rule_falls_back_for_compound_command`  (lines 2803–2852)

```
async fn invalid_requested_prefix_rule_falls_back_for_compound_command() -> Result<()>
```

**Purpose**: Tests that when a model requests an unsafe or too-narrow prefix rule for a compound command, Codex falls back to a safer amendment proposal. A compound command is one command line containing multiple operations, such as using `&&`.

**Data flow**: It prepares a compound command while requesting only a `touch` prefix rule, submits the turn, waits for an exec approval prompt, and checks that the proposed amendment contains the whole command instead of blindly trusting the short prefix.

**Call relations**: This test calls `shell_event_with_prefix_rule` directly because the prefix-rule detail is the point of the test. It uses `expect_exec_approval` to inspect the approval proposal.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, shell_event_with_prefix_rule, submit_turn); 3 external calls (new_read_only_policy, assert!, vec!).


##### `approving_fallback_rule_for_compound_command_works`  (lines 2856–2968)

```
async fn approving_fallback_rule_for_compound_command_works() -> Result<()>
```

**Purpose**: Tests that the fallback rule proposed for a compound command can be approved and then used later. It verifies that the safety fallback is not only proposed but also functional.

**Data flow**: It first runs the compound command with an invalid requested prefix, receives the broader fallback amendment, approves it, and waits for completion. Then it runs the same command again and expects no approval prompt, finally parsing the output to confirm success.

**Call relations**: This builds directly on the invalid-prefix-rule case. It uses approval waiting, amendment approval, completion waiting, and result parsing to prove the saved fallback rule takes effect.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_prefix_rule, submit_turn, wait_for_completion, wait_for_completion_without_approval); 4 external calls (new_read_only_policy, assert!, assert_eq!, vec!).


##### `denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt`  (lines 2971–3249)

```
async fn denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt() -> Result<()>
```

**Purpose**: Tests that choosing a network-policy denial writes a deny rule and prevents repeated network approval prompts for the same host. This avoids asking the user the same denied network question again.

**Data flow**: It creates a managed-network configuration, runs a command that tries to fetch a test host, waits until the special network-access approval appears, chooses the deny amendment, verifies the deny rule was written to the policy file, and checks the command failed. It then repeats the fetch and confirms there is no second network approval prompt while the command still fails.

**Call relations**: This standalone network test uses shell-event creation, turn submission, manual approval-loop handling, completion waiting, result parsing, and expectation verification. It covers network amendments, which have a different approval context from ordinary command approvals.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, parse_result, shell_event, submit_turn, wait_for_completion); 14 external calls (new, new, assert!, assert_eq!, managed_network_requirements_loader, wait_for_event_with_timeout, format!, read_to_string, write, panic! (+4 more)).


##### `network_approval_retry_keeps_deny_read_sandbox_for_escalated_command`  (lines 3253–3454)

```
async fn network_approval_retry_keeps_deny_read_sandbox_for_escalated_command() -> Result<()>
```

**Purpose**: Tests that approving network access during a retried escalated command does not accidentally remove denied-read filesystem restrictions. In plain terms, granting network should not also grant file-reading permissions that were blocked.

**Data flow**: It builds a permission profile with restricted network and an explicit denied read pattern, runs a network fetch command that asks for escalated permissions, approves the outer command request, then handles the network approval by choosing an allow amendment. It waits for completion and checks that command output was produced.

**Call relations**: This test uses custom permission-profile setup instead of only legacy sandbox settings. It exercises the combined flow of command escalation followed by network approval retry.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, parse_result, shell_event, wait_for_completion, from_runtime_permissions (+1 more)); 14 external calls (new, default, new, assert!, assert_eq!, managed_network_requirements_loader, wait_for_event_with_timeout, format!, write, panic! (+4 more)).


##### `network_approval_flow_survives_danger_full_access_session_start`  (lines 3457–3597)

```
async fn network_approval_flow_survives_danger_full_access_session_start() -> Result<()>
```

**Purpose**: Tests that a session initially configured with danger-full-access can still use managed network approval correctly on a later workspace-restricted turn. This guards against startup state disabling later network prompts.

**Data flow**: It starts a session whose default sandbox is danger-full-access, confirms managed network proxy details are hidden at session start, then submits a turn with workspace-write network restrictions and a network-fetch command. It waits for the special network approval request, verifies its protocol context, denies it, and waits for completion.

**Call relations**: This test uses shell-event creation and the shared turn-submission helper, but focuses on session startup versus per-turn permissions. It makes sure network approval state is recalculated for the turn that actually runs.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, shell_event, submit_turn, wait_for_completion); 12 external calls (new, new, assert!, assert_eq!, managed_network_requirements_loader, wait_for_event_with_timeout, write, panic!, skip_if_no_network!, from_secs (+2 more)).


##### `compound_command_with_one_safe_command_still_requires_approval`  (lines 3602–3669)

```
async fn compound_command_with_one_safe_command_still_requires_approval() -> Result<()>
```

**Purpose**: Tests that a compound command still asks for approval even if part of it resembles a safe or allowed command. This prevents a dangerous command from hiding behind a trusted prefix.

**Data flow**: It writes a rule allowing one specific touch command, prepares a different compound command that touches and removes a file, submits the turn, waits for an exec approval prompt, denies it, and waits for completion.

**Call relations**: This standalone Unix test complements the table-driven compound-command scenarios. It uses action preparation and approval waiting to prove Codex evaluates the full command shape, not just one safe-looking piece.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, submit_turn, wait_for_completion); 5 external calls (new_workspace_write_policy, create_dir_all, write, skip_if_no_network!, vec!).


### `core/tests/suite/exec_policy.rs`

`test` · `test run`

This is a test file for Codex’s command-execution safety layer. That layer is the gatekeeper between the assistant and the user’s machine: before a command is run, it checks approval settings, sandbox settings, permission profiles, and local policy rules. Without tests like these, a change could accidentally allow a blocked command to run, or make harmless-but-odd inputs crash the whole turn.

The tests build a fake Codex session and a mock server that pretends to be the model API. The mock server sends scripted events, such as “the assistant wants to call the shell_command tool” or “the assistant wants to call exec_command.” The test then watches what Codex does with that request.

Several tests focus on collaboration mode, where extra model settings are attached to a turn. They deliberately send empty or whitespace-only commands. These are like handing the command runner a blank note: it should decline or report cleanly, not panic because no policy rule matched. Another test writes a local policy file that forbids commands beginning with echo, then confirms that an attempted echo command is rejected. On Windows, one test checks that unified exec is still blocked when the Windows sandbox is disabled and the permission profile is read-only.

#### Function details

##### `collaboration_mode_for_model`  (lines 28–37)

```
fn collaboration_mode_for_model(model: String) -> CollaborationMode
```

**Purpose**: This helper builds a collaboration-mode setting for a chosen model. The tests use it when they want a user turn to exercise the newer collaboration-mode path instead of the plain default settings.

**Data flow**: It receives a model name as text. It wraps that model name together with default mode settings, no special reasoning effort, and a short developer instruction used by these tests. It returns a complete CollaborationMode value that can be attached to a test turn.

**Call relations**: The empty-command and whitespace-command tests call this before submitting their user turn. Its output is passed into submit_user_turn so the simulated conversation uses collaboration-mode settings while the command policy code is being tested.

*Call graph*: called by 4 (shell_command_empty_script_with_collaboration_mode_does_not_panic, shell_command_whitespace_script_with_collaboration_mode_does_not_panic, unified_exec_empty_script_with_collaboration_mode_does_not_panic, unified_exec_whitespace_script_with_collaboration_mode_does_not_panic).


##### `submit_user_turn`  (lines 39–78)

```
async fn submit_user_turn(
    test: &core_test_support::test_codex::TestCodex,
    prompt: &str,
    approval_policy: AskForApproval,
    permission_profile: PermissionProfile,
    collaboration_mode
```

**Purpose**: This helper sends a user message into the test Codex session with the approval, sandbox, permission, and collaboration settings needed for the scenario. It avoids repeating the same setup code in every test.

**Data flow**: It takes the test session, a prompt, an approval policy, a permission profile, and optionally a collaboration mode. It reads the session’s configured model and working directory, converts the permission profile into the sandbox and permission fields expected by the protocol, builds a UserInput operation, and submits it to Codex. It returns success or an error if submission fails.

**Call relations**: Most tests use this as the point where the scripted scenario actually starts. Before it is called, the mock server has already been loaded with fake model responses. After it submits the turn, the tests wait for Codex events and inspect the tool-call result that Codex sent back to the mock server.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 5 (shell_command_empty_script_with_collaboration_mode_does_not_panic, shell_command_whitespace_script_with_collaboration_mode_does_not_panic, unified_exec_disabled_windows_sandbox_rejects_managed_read_only_command, unified_exec_empty_script_with_collaboration_mode_does_not_panic, unified_exec_whitespace_script_with_collaboration_mode_does_not_panic); 2 external calls (default, vec!).


##### `assert_no_matched_rules_invariant`  (lines 80–89)

```
fn assert_no_matched_rules_invariant(output_item: &Value)
```

**Purpose**: This helper checks that a command result did not expose a specific internal panic message about missing policy-rule matches. In plain terms, it verifies that an edge case failed gracefully instead of leaking a crash into the tool output.

**Data flow**: It receives a JSON object representing a function-call output. It reads the string stored under the output field, then asserts that the string does not contain the invariant-failure message. It does not return useful data; it passes silently or fails the test.

**Call relations**: The empty-command and whitespace-command tests call this after Codex finishes the turn and the mock server has captured the tool result. It is the shared final check for the collaboration-mode edge cases.

*Call graph*: called by 4 (shell_command_empty_script_with_collaboration_mode_does_not_panic, shell_command_whitespace_script_with_collaboration_mode_does_not_panic, unified_exec_empty_script_with_collaboration_mode_does_not_panic, unified_exec_whitespace_script_with_collaboration_mode_does_not_panic); 2 external calls (get, assert!).


##### `unified_exec_disabled_windows_sandbox_rejects_managed_read_only_command`  (lines 93–161)

```
async fn unified_exec_disabled_windows_sandbox_rejects_managed_read_only_command() -> Result<()>
```

**Purpose**: This Windows-only test proves that a unified exec command is rejected when the Windows sandbox is disabled and the turn is read-only. It protects against a dangerous failure mode where losing the sandbox might accidentally allow a command to run.

**Data flow**: The test enables the unified exec feature, disables Windows sandbox features, and builds a fake session. It scripts the mock model to request an exec_command call for cmd.exe /c dir. It submits a user turn with never-ask approval and a read-only permission profile, waits for the turn to finish, then inspects the captured tool output. The expected result is a rejection message saying the command was blocked by policy.

**Call relations**: It uses start_mock_server, test_codex, mount_sse_once, and sse to create the fake model conversation. It calls submit_user_turn to feed the scenario into Codex, then waits for TurnComplete and reads the mock server’s recorded function-call output to make the assertion.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, submit_user_turn, read_only); 4 external calls (assert!, wait_for_event, json!, vec!).


##### `execpolicy_blocks_shell_invocation`  (lines 164–256)

```
async fn execpolicy_blocks_shell_invocation() -> Result<()>
```

**Purpose**: This test confirms that a local execution policy file can forbid a shell command. It checks the important safety promise that user or system rules can stop commands before they run.

**Data flow**: The test writes a policy file under the test Codex home directory saying that commands starting with echo are forbidden. It then scripts the mock model to request shell_command with echo blocked. It submits a user input turn with approval disabled and local environment settings, waits for the command-end event, and checks that the reported output says the policy forbids echo commands.

**Call relations**: Unlike the shared helper path, this test builds the user submission inline because it also sets up the policy file and exact thread overrides itself. It still relies on the same mock-server machinery to simulate the model request, then listens for ExecCommandEnd and TurnComplete events to verify Codex’s response.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); 6 external calls (default, assert!, wait_for_event, json!, unreachable!, vec!).


##### `shell_command_empty_script_with_collaboration_mode_does_not_panic`  (lines 259–311)

```
async fn shell_command_empty_script_with_collaboration_mode_does_not_panic() -> Result<()>
```

**Purpose**: This test makes sure an empty shell_command request in collaboration mode does not crash the command-policy logic. It is checking graceful behavior for a blank command.

**Data flow**: The test enables collaboration modes, uses a GPT-5.2 model setting, and scripts the mock model to call shell_command with an empty command string. It submits the turn with on-request approval and disabled permissions, waits until Codex completes the turn, then inspects the tool output. The expected outcome is simply that the internal matched-rules invariant message is absent.

**Call relations**: It prepares the mock conversation with start_mock_server, mount_sse_once, and sse. It uses collaboration_mode_for_model to create the special mode settings and submit_user_turn to start the turn. After wait_for_event reports completion, it hands the captured output to assert_no_matched_rules_invariant.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_no_matched_rules_invariant, collaboration_mode_for_model, submit_user_turn); 3 external calls (wait_for_event, json!, vec!).


##### `unified_exec_empty_script_with_collaboration_mode_does_not_panic`  (lines 314–370)

```
async fn unified_exec_empty_script_with_collaboration_mode_does_not_panic() -> Result<()>
```

**Purpose**: This test checks the same blank-command edge case for the newer unified exec tool. It ensures that exec_command with an empty cmd field does not surface an internal panic in collaboration mode.

**Data flow**: The test enables both unified exec and collaboration modes, then scripts the mock model to call exec_command with an empty cmd string. It submits a user turn using collaboration-mode settings, waits for completion, fetches the function-call output from the mock server, and verifies that the invariant-failure text is not present.

**Call relations**: It follows the shared test pattern: mock server first, fake model events next, submit_user_turn to run the scenario, wait_for_event to know the turn is done, and assert_no_matched_rules_invariant for the final safety check.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_no_matched_rules_invariant, collaboration_mode_for_model, submit_user_turn); 3 external calls (wait_for_event, json!, vec!).


##### `shell_command_whitespace_script_with_collaboration_mode_does_not_panic`  (lines 373–425)

```
async fn shell_command_whitespace_script_with_collaboration_mode_does_not_panic() -> Result<()>
```

**Purpose**: This test makes sure a shell command made only of spaces, tabs, and newlines does not crash policy evaluation in collaboration mode. It covers the case where a command looks non-empty but has no real content.

**Data flow**: The test enables collaboration modes and scripts a shell_command call whose command string contains only whitespace. It submits the user turn with the collaboration-mode settings, waits for Codex to finish, then reads the recorded function-call output. The test passes if that output does not contain the internal matched-rules panic message.

**Call relations**: It uses collaboration_mode_for_model and submit_user_turn to run the collaboration-mode scenario. The mock-server helpers provide the fake model events, and assert_no_matched_rules_invariant performs the shared check once wait_for_event confirms the turn is complete.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_no_matched_rules_invariant, collaboration_mode_for_model, submit_user_turn); 3 external calls (wait_for_event, json!, vec!).


##### `unified_exec_whitespace_script_with_collaboration_mode_does_not_panic`  (lines 428–484)

```
async fn unified_exec_whitespace_script_with_collaboration_mode_does_not_panic() -> Result<()>
```

**Purpose**: This test applies the whitespace-only command check to the unified exec tool. It ensures that exec_command treats a command with no meaningful characters as a clean edge case, not as a crash.

**Data flow**: The test enables unified exec and collaboration modes, then sets up the mock model to request exec_command with a cmd string containing only whitespace. It submits the turn, waits for completion, retrieves the tool output captured by the mock server, and checks that the invariant-failure message is absent.

**Call relations**: It is the unified-exec counterpart to the shell whitespace test. It depends on the same support helpers for fake model responses, collaboration-mode construction, turn submission, event waiting, and final invariant-output checking.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_no_matched_rules_invariant, collaboration_mode_for_model, submit_user_turn); 3 external calls (wait_for_event, json!, vec!).


### `core/tests/suite/skill_approval.rs`

`test` · `test run`

This is a Unix-only test file. It builds small fake Codex sessions, gives the model mocked tool-call responses, and then watches what happens when Codex tries to run shell commands through the zsh-fork runtime. The main concern is safety: a skill may include scripts and metadata that claim extra file permissions, but those declarations must not widen what the current turn is allowed to do. In plain terms, a skill should not be able to hand itself a bigger keyring than the user gave the session.

The file creates temporary skill folders, writes script files into them, starts a mock server that pretends to be the model backend, and submits user turns with specific approval and sandbox settings. A sandbox is a protective boundary that limits what a command can read or write. The tests then wait for either an approval request or the end of the turn, inspect the command output, and check the real filesystem to make sure forbidden files were not created.

The first test proves that skill script permission metadata is ignored for shell execution: the script should be governed by the turn sandbox instead. The second test is a simpler guardrail check: even without skill involvement, zsh-fork shell commands must not write outside the allowed workspace.

#### Function details

##### `write_skill_metadata`  (lines 27–32)

```
fn write_skill_metadata(home: &Path, name: &str, contents: &str) -> Result<()>
```

**Purpose**: Writes a skill's metadata file into the fake Codex home directory used by a test. The metadata can include declared permissions, which the tests use to make sure those declarations do not secretly grant extra power.

**Data flow**: It receives a home directory path, a skill name, and the text to put in the metadata file. It creates the nested `skills/<name>/agents` folder, writes `openai.yaml` there, and returns success or an error if the filesystem work fails.

**Call relations**: The skill-script test calls this while setting up its fake skill. It prepares the permission declaration that the rest of the test later verifies is not allowed to override the turn sandbox.

*Call graph*: 3 external calls (join, create_dir_all, write).


##### `shell_command_arguments`  (lines 34–39)

```
fn shell_command_arguments(command: &str) -> Result<String>
```

**Purpose**: Builds the JSON argument string for a mocked `shell_command` tool call. This lets the fake model response ask Codex to run a specific shell command with a short timeout.

**Data flow**: It takes a shell command as text, wraps it with a `timeout_ms` value of 500 in a JSON object, converts that JSON object to a string, and returns the string or an error if serialization fails.

**Call relations**: Both tests use this before mounting the mocked model response. It turns the command each test wants to run into the exact argument format expected by the shell tool call.

*Call graph*: called by 2 (shell_zsh_fork_skill_scripts_ignore_declared_permissions, shell_zsh_fork_still_enforces_workspace_write_sandbox); 2 external calls (json!, to_string).


##### `submit_turn_with_policies`  (lines 41–76)

```
async fn submit_turn_with_policies(
    test: &TestCodex,
    prompt: &str,
    approval_policy: AskForApproval,
    permission_profile: PermissionProfile,
) -> Result<()>
```

**Purpose**: Submits a user message to the test Codex session while explicitly setting the approval and sandbox rules for that turn. This is how each test says, 'run this prompt under these safety limits.'

**Data flow**: It receives the test session, the prompt text, an approval policy, and a permission profile. It converts the permission profile into sandbox fields for the current working directory, builds a `UserInput` operation with thread settings such as environment selection, approval policy, sandbox policy, permission profile, and model settings, then sends it to Codex asynchronously.

**Call relations**: Both tests call this after the mock server has been prepared. It is the bridge between test setup and the actual Codex run; after it submits the turn, the tests wait for events and inspect the resulting tool output.

*Call graph*: calls 3 internal fn (cwd_path, local_selections, turn_permission_fields); called by 2 (shell_zsh_fork_skill_scripts_ignore_declared_permissions, shell_zsh_fork_still_enforces_workspace_write_sandbox); 2 external calls (default, vec!).


##### `write_skill_with_shell_script_contents`  (lines 79–107)

```
fn write_skill_with_shell_script_contents(
    home: &Path,
    name: &str,
    script_name: &str,
    script_contents: &str,
) -> Result<PathBuf>
```

**Purpose**: Creates a fake skill containing a runnable shell script. The tests use it to simulate a real installed skill that can provide scripts to Codex.

**Data flow**: It receives a home directory, skill name, script filename, and script text. It creates the skill and script folders, writes a simple `SKILL.md` description, writes the script file, marks that script as executable on Unix, and returns the script path.

**Call relations**: The skill-permission test uses this during its zsh-fork test setup hook. It gives Codex a concrete skill script to execute, so the test can check which sandbox rules actually apply to that execution.

*Call graph*: 6 external calls (join, format!, create_dir_all, metadata, set_permissions, write).


##### `skill_script_command`  (lines 109–116)

```
fn skill_script_command(test: &TestCodex, script_name: &str) -> Result<String>
```

**Purpose**: Builds the shell command used to run the fake skill script. It resolves the script to an absolute path and quotes it safely for shell use.

**Data flow**: It reads the test Codex home path, appends the expected skill script location, canonicalizes it into a full real path, shell-quotes that path, and returns the resulting command string.

**Call relations**: The skill-permission test calls this after the fake skill has been created. The returned command is then packed into mocked shell-tool arguments so the simulated model asks Codex to run that script.

*Call graph*: calls 1 internal fn (codex_home_path); called by 1 (shell_zsh_fork_skill_scripts_ignore_declared_permissions); 2 external calls (canonicalize, try_join).


##### `wait_for_exec_approval_request`  (lines 118–125)

```
async fn wait_for_exec_approval_request(test: &TestCodex) -> Option<ExecApprovalRequestEvent>
```

**Purpose**: Waits to see whether Codex asks for approval before executing a command. It returns the approval request if one appears, or `None` if the turn finishes first.

**Data flow**: It listens to events from the test Codex session. If it sees an execution approval request, it clones and returns it; if it sees the turn complete, it returns `None`; other events are ignored while waiting.

**Call relations**: The skill-permission test uses this to confirm that the removed skill approval path is not triggered. In that story, no separate skill approval should appear; the command should proceed under the normal turn sandbox instead.

*Call graph*: called by 1 (shell_zsh_fork_skill_scripts_ignore_declared_permissions); 1 external calls (wait_for_event_match).


##### `wait_for_turn_complete`  (lines 127–132)

```
async fn wait_for_turn_complete(test: &TestCodex)
```

**Purpose**: Waits until the Codex turn has finished. Tests use it so they do not inspect command output or filesystem effects too early.

**Data flow**: It listens to events from the test Codex session until it sees a `TurnComplete` event. It does not return data; it simply pauses the test until the turn is done.

**Call relations**: Both tests call this after submitting a turn, or after checking that no approval request appeared. It marks the point where it is safe for the test to read the mock tool output and check whether files were created.

*Call graph*: called by 2 (shell_zsh_fork_skill_scripts_ignore_declared_permissions, shell_zsh_fork_still_enforces_workspace_write_sandbox); 1 external calls (wait_for_event).


##### `output_shows_sandbox_denial`  (lines 134–138)

```
fn output_shows_sandbox_denial(output: &str) -> bool
```

**Purpose**: Recognizes common shell error messages that mean the sandbox blocked an operation. This keeps the tests tolerant of different operating-system wording.

**Data flow**: It receives command output as text and checks whether it contains phrases such as `Permission denied`, `Operation not permitted`, or `Read-only file system`. It returns `true` if any of those signs appear, otherwise `false`.

**Call relations**: Both tests use this when judging command output. Instead of relying on one exact error string, they ask this helper whether the output looks like a sandbox rejection.


##### `shell_zsh_fork_skill_scripts_ignore_declared_permissions`  (lines 142–233)

```
async fn shell_zsh_fork_skill_scripts_ignore_declared_permissions() -> Result<()>
```

**Purpose**: Tests that a skill script's own permission metadata does not give it extra write access when run through zsh-fork. The script may declare that it can write to a directory, but the turn sandbox must still be the real authority.

**Data flow**: The test skips if network support is unavailable, obtains a zsh-fork runtime, creates a restrictive workspace-write permission profile, and prepares a fake skill whose script tries to write outside the workspace. It also writes skill metadata claiming that outside directory is allowed. It starts a mock server, mounts a fake shell-tool call for the script, submits a user turn that invokes the skill, checks that no execution approval request appears, waits for completion, then inspects the tool output and the target file path. The expected result is that the outside write is blocked and the file does not exist.

**Call relations**: This is one of the two top-level async tests in the file. It uses the setup helpers to create the skill and command, uses `submit_turn_with_policies` to start the Codex run, uses `wait_for_exec_approval_request` and `wait_for_turn_complete` to follow the event flow, and uses `output_shows_sandbox_denial` plus a filesystem check to prove the sandbox remained in control.

*Call graph*: calls 10 internal fn (mount_function_call_agent_response, start_mock_server, build_zsh_fork_test, restrictive_workspace_write_profile, zsh_fork_runtime, shell_command_arguments, skill_script_command, submit_turn_with_policies, wait_for_exec_approval_request, wait_for_turn_complete); 8 external calls (Granular, assert!, format!, create_dir_all, try_join, skip_if_no_network!, current_dir, tempdir_in).


##### `shell_zsh_fork_still_enforces_workspace_write_sandbox`  (lines 237–291)

```
async fn shell_zsh_fork_still_enforces_workspace_write_sandbox() -> Result<()>
```

**Purpose**: Tests the basic safety rule that zsh-fork commands cannot write outside the workspace under a restrictive workspace-write policy. This protects against regressions in the sandbox itself, separate from skill behavior.

**Data flow**: The test skips if network support is unavailable, gets a zsh-fork runtime, starts a mock server, chooses an outside path under `/tmp`, removes any old file at that path, and builds a test Codex session with a restrictive permission profile. It mounts a fake shell-tool call that runs `touch` on the outside path, submits a turn, waits for it to finish, reads the command output, and verifies both that the output shows a sandbox denial and that the file was not created.

**Call relations**: This is the second top-level async test. It follows the same overall pattern as the skill test but removes the skill layer, using `shell_command_arguments`, `submit_turn_with_policies`, `wait_for_turn_complete`, and `output_shows_sandbox_denial` to confirm the zsh-fork sandbox still blocks forbidden writes.

*Call graph*: calls 8 internal fn (mount_function_call_agent_response, start_mock_server, build_zsh_fork_test, restrictive_workspace_write_profile, zsh_fork_runtime, shell_command_arguments, submit_turn_with_policies, wait_for_turn_complete); 4 external calls (assert!, format!, remove_file, skip_if_no_network!).


### `core/tests/suite/unified_exec_zsh_fork_approvals.rs`

`test` · `test run`

These are integration-style tests: they start a mock server that pretends to be the model API, ask Codex to run a command, and then watch the approval and sandbox behavior end to end. The main concern is safety. Codex may ask the user to approve a command that needs more permissions, such as writing outside the workspace. These tests make sure that approval affects only the right layer of execution and does not accidentally open doors that should stay closed.

The file focuses on a zsh-fork runtime, where a parent shell process can intercept and run commands. That is a tricky setup because a shell redirection like `printf hi > file` is not just a normal program call; the shell itself performs the write. The tests verify three important cases: approved shell redirection can write outside the workspace, denied-read rules still block secret files even after approval, and an explicit rule saying “ask before running touch” still triggers a second approval.

Helper functions build the test Codex session, prepare fake model responses, submit a user turn with the right permissions, approve requested commands, and decode the command result returned to the mock server. Together, they act like a small stage crew: one part sets the sandbox, one part plays the model, one part plays the user, and one part inspects what happened.

#### Function details

##### `unified_exec_zsh_fork_parent_approval_preserves_denied_reads`  (lines 52–111)

```
async fn unified_exec_zsh_fork_parent_approval_preserves_denied_reads() -> Result<()>
```

**Purpose**: This test proves that approving a command does not remove an explicit “deny read” rule. It protects against a serious bug where user approval for execution could accidentally let a command read a secret file.

**Data flow**: It creates a temporary secret file, builds a permission profile that allows general reading but denies that exact file, and prepares a fake model response asking to run `cat` on the secret. After submitting a user turn and approving the parent command, it waits for completion and checks the recorded command result. The expected outcome is a non-zero exit code and no secret text in the output.

**Call relations**: This is one of the top-level test cases. It uses the setup helper to start the zsh-fork test environment, the mock-response helper to stage the command, the submit helper to start the turn, the approval helper to approve the command, and the result helper to inspect what the command actually returned.

*Call graph*: calls 7 internal fn (approve_expected_exec, build_unified_exec_zsh_fork_test_or_skip, command_result, denied_read_permission_profile, mount_unified_exec_command, submit_turn_with_session_permissions, wait_for_completion_without_approval); 7 external calls (assert!, assert_ne!, format!, write, skip_if_no_network!, current_dir, tempdir_in).


##### `unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec`  (lines 114–172)

```
async fn unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec() -> Result<()>
```

**Purpose**: This test checks that approval can correctly grant extra permission for a shell operation that the zsh fork intercepts. In plain terms, it makes sure that an approved command can write outside the workspace when that is exactly what the user approved.

**Data flow**: It creates a temporary path outside the workspace, prepares a restrictive permission profile, and asks the fake model to run a command that writes `hi` to that path using shell redirection. After the user approval is simulated, it waits for the turn to finish, reads the command result, and then reads the file from disk. The expected outcome is a successful exit code and a file containing `hi`.

**Call relations**: This top-level test follows the normal approval flow. It relies on the shared zsh-fork setup, staged server events, user-turn submission, approval waiting, and completion waiting helpers, then verifies both the returned command result and the real filesystem side effect.

*Call graph*: calls 7 internal fn (restrictive_workspace_write_profile, approve_expected_exec, build_unified_exec_zsh_fork_test_or_skip, command_result, mount_unified_exec_command, submit_turn_with_session_permissions, wait_for_completion_without_approval); 6 external calls (assert_eq!, format!, read_to_string, skip_if_no_network!, current_dir, tempdir_in).


##### `unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule`  (lines 175–264)

```
async fn unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule() -> Result<()>
```

**Purpose**: This test makes sure that a specific rule saying “prompt before running this command” is still respected after the parent command has already been approved. It prevents broad approval from silently bypassing more precise safety rules.

**Data flow**: It creates a temporary outside-workspace path, writes a rule file that says commands starting with `touch` require a prompt, and stages a fake model request to run `touch` on that path. The test first approves the parent unified execution request, then waits for a second approval request for the intercepted `touch` command. After approving that second request, it confirms the turn completes and the file exists.

**Call relations**: This top-level test exercises a two-step approval story. It uses the common setup and submission helpers for the first command, then directly waits for and approves the explicit prompt-rule approval before using the completion and result helpers to verify the end state.

*Call graph*: calls 8 internal fn (restrictive_workspace_write_profile, approve_exec, approve_expected_exec, build_unified_exec_zsh_fork_test_or_skip, command_result, mount_unified_exec_command, submit_turn_with_session_permissions, wait_for_completion); 9 external calls (from_secs, assert!, assert_eq!, wait_for_event_with_timeout, format!, panic!, skip_if_no_network!, current_dir, tempdir_in).


##### `build_unified_exec_zsh_fork_test_or_skip`  (lines 271–294)

```
async fn build_unified_exec_zsh_fork_test_or_skip(
    test_name: &str,
    approval_policy: AskForApproval,
    permission_profile: PermissionProfile,
    pre_build_hook: F,
) -> Result<Option<(MockS
```

**Purpose**: This helper prepares the full test environment, but cleanly skips the test if the required zsh-fork runtime is not available. That lets these tests run only on systems that can actually exercise this execution path.

**Data flow**: It receives a test name, an approval policy, a permission profile, and a setup callback. It asks for a zsh-fork runtime; if none is available, it returns `None`. Otherwise it starts a mock server, builds a `TestCodex` session with the requested permissions and callback, and returns both pieces to the caller.

**Call relations**: All three top-level tests call this before doing anything else. It hands them a mock model server and a Codex test harness, which the later helpers use to stage responses, submit user input, and observe events.

*Call graph*: calls 3 internal fn (start_mock_server, build_unified_exec_zsh_fork_test, zsh_fork_runtime); called by 3 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule, unified_exec_zsh_fork_parent_approval_preserves_denied_reads).


##### `denied_read_permission_profile`  (lines 296–309)

```
fn denied_read_permission_profile(denied_path: &Path) -> Result<PermissionProfile>
```

**Purpose**: This helper creates the special permission profile used by the denied-read test. It describes a sandbox where most files can be read, project roots can be written, but one chosen path is explicitly blocked.

**Data flow**: It receives the path that should be protected, converts it into a TOML-safe key, and builds a small permission-profile text. It then passes that text to the TOML parser helper and returns the resulting runtime permission profile.

**Call relations**: The denied-read top-level test calls this to get the exact sandbox shape it needs. It delegates the detailed conversion from TOML text into a `PermissionProfile` to `permission_profile_from_toml`.

*Call graph*: calls 1 internal fn (permission_profile_from_toml); called by 1 (unified_exec_zsh_fork_parent_approval_preserves_denied_reads); 3 external calls (to_string_lossy, new, format!).


##### `permission_profile_from_toml`  (lines 311–355)

```
fn permission_profile_from_toml(profile: &str) -> Result<PermissionProfile>
```

**Purpose**: This helper turns a small TOML permission profile into the runtime permission object that Codex uses during tests. TOML is a human-readable configuration format, so this lets the test describe sandbox rules clearly.

**Data flow**: It receives profile text, parses it into the configuration form, extracts filesystem entries, converts special paths like `/` and `:project_roots` into sandbox path objects, and turns denied paths into glob patterns. It also converts the network setting into either enabled or restricted network access. The result is a `PermissionProfile` ready to be used by the test harness.

**Call relations**: It is used by the denied-read profile helper. That helper supplies the small TOML snippet, and this function performs the lower-level translation into the permission model used by Codex.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); called by 1 (denied_read_permission_profile).


##### `mount_unified_exec_command`  (lines 357–392)

```
async fn mount_unified_exec_command(
    server: &MockServer,
    response_prefix: &str,
    call_id: &str,
    command: &str,
    justification: &str,
) -> Result<ResponseMock>
```

**Purpose**: This helper programs the mock model server to ask Codex to run one command, then later return a simple assistant message saying the turn is done. It gives the tests a repeatable fake model conversation.

**Data flow**: It receives the mock server, identifiers, the shell command, and a justification for elevated sandbox permissions. It builds one fake streaming response containing an `exec_command` tool call and completion, then mounts a second fake response containing an assistant message and completion. It returns the mock object that records the second request, so the test can later inspect the command output sent back to the model.

**Call relations**: Each top-level test calls this after setup and before submitting the user turn. Internally it uses `exec_command_event` to build the tool-call event and the test support server helpers to mount the fake streaming responses.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, exec_command_event); called by 3 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule, unified_exec_zsh_fork_parent_approval_preserves_denied_reads); 2 external calls (format!, vec!).


##### `submit_turn_with_session_permissions`  (lines 394–433)

```
async fn submit_turn_with_session_permissions(
    test: &TestCodex,
    prompt: &str,
    approval_policy: AskForApproval,
) -> Result<()>
```

**Purpose**: This helper submits a user message to the Codex test session while explicitly carrying over the session’s permission and collaboration settings. It makes the test turn look like a real user request with a known approval policy.

**Data flow**: It reads the model and permission settings from the `TestCodex` session, derives the sandbox and permission fields for the current working directory, and sends a `UserInput` operation to Codex. The submitted operation includes the prompt text, local environment selection, approval policy, user-as-reviewer setting, sandbox policy, permission profile, and collaboration mode.

**Call relations**: All three top-level tests use this to start the actual Codex turn after the mock server has been prepared. Once this is submitted, Codex can receive the fake model response, request approvals, and execute the command.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 3 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule, unified_exec_zsh_fork_parent_approval_preserves_denied_reads); 2 external calls (default, vec!).


##### `approve_expected_exec`  (lines 435–438)

```
async fn approve_expected_exec(test: &TestCodex, expected_command: &str) -> Result<()>
```

**Purpose**: This helper waits for the approval request that should match a specific parent command, then approves it. It combines “check that Codex asked for the right thing” with “simulate the user clicking approve.”

**Data flow**: It receives the test harness and the expected command string. It waits for an execution approval request, verifies that the requested parent command matches, extracts the effective approval id, and sends an approval decision for that id. It returns success once the approval operation has been submitted.

**Call relations**: The top-level tests use this for the first approval in the flow. It depends on `expect_exec_approval` for the waiting and checking part, then hands the approval id to `approve_exec` to send the decision.

*Call graph*: calls 2 internal fn (approve_exec, expect_exec_approval); called by 3 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule, unified_exec_zsh_fork_parent_approval_preserves_denied_reads).


##### `approve_exec`  (lines 440–449)

```
async fn approve_exec(test: &TestCodex, approval_id: String) -> Result<()>
```

**Purpose**: This helper simulates the user approving a pending command execution request. It is the test equivalent of pressing an “Approve” button.

**Data flow**: It receives a test harness and an approval id. It submits an `ExecApproval` operation to Codex with the decision set to approved, and returns once Codex accepts that operation.

**Call relations**: It is called by `approve_expected_exec` for the normal parent approval. The explicit prompt-rule test also calls it directly for the second approval request, after that test has inspected the intercepted command.

*Call graph*: called by 2 (approve_expected_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule).


##### `command_result`  (lines 451–453)

```
fn command_result(results: &ResponseMock, call_id: &str) -> CommandResult
```

**Purpose**: This helper retrieves and parses the command result that Codex sent back to the mock model server. It hides the details of where the recorded tool output is stored.

**Data flow**: It receives a response mock and a tool-call id. It finds the single recorded request, pulls out the function-call output for that id, and passes that value to the parser. It returns a simple `CommandResult` with an optional exit code and stdout text.

**Call relations**: The top-level tests call this after the turn completes so they can assert whether the command succeeded and what it printed. It delegates the actual decoding work to `parse_result`.

*Call graph*: calls 2 internal fn (single_request, parse_result); called by 3 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule, unified_exec_zsh_fork_parent_approval_preserves_denied_reads).


##### `exec_command_event`  (lines 455–474)

```
fn exec_command_event(
    call_id: &str,
    cmd: &str,
    yield_time_ms: Option<u64>,
    sandbox_permissions: SandboxPermissions,
    justification: &str,
) -> Result<Value>
```

**Purpose**: This helper builds the fake model event that asks Codex to call the `exec_command` tool. It lets tests specify the command and whether the tool call asks for elevated sandbox permissions.

**Data flow**: It receives a call id, command text, optional yield time, sandbox permission request, and justification. It creates a JSON argument object, adds timing and sandbox fields when needed, serializes it to a string, and wraps it as a function-call event named `exec_command`.

**Call relations**: Only `mount_unified_exec_command` calls this. The resulting event becomes part of the mock streaming response that Codex reads as if it came from the model.

*Call graph*: calls 2 internal fn (ev_function_call, requests_sandbox_override); called by 1 (mount_unified_exec_command); 2 external calls (json!, to_string).


##### `parse_result`  (lines 476–501)

```
fn parse_result(item: &Value) -> CommandResult
```

**Purpose**: This helper turns the raw command-output value into a simple result object. It supports both the newer JSON-shaped output and older plain-text formats.

**Data flow**: It receives a JSON value from the recorded function-call output. If there is no string output, it returns an empty result. If the output string is JSON, it extracts the exit code from metadata and stdout from the output field. If it is not JSON, it tries known text patterns with regular expressions; if those do not match, it returns the raw text with no exit code.

**Call relations**: It is called by `command_result` whenever a test wants to inspect what happened after command execution. For fallback text formats, it asks `parsed_regex_result` to do the pattern matching.

*Call graph*: calls 1 internal fn (parsed_regex_result); called by 1 (command_result); 2 external calls (new, get).


##### `parsed_regex_result`  (lines 503–512)

```
fn parsed_regex_result(pattern: &str, output_str: &str) -> Option<CommandResult>
```

**Purpose**: This helper extracts an exit code and output text from an older plain-text command result format. It is a compatibility fallback for results that are not valid JSON.

**Data flow**: It receives a regular expression pattern and an output string. It compiles the pattern, matches it against the output, parses the first captured group as an exit code, and uses the second captured group as stdout. If any step fails, it returns `None`.

**Call relations**: It is used only by `parse_result`. `parse_result` tries one text pattern and then another, using this helper as the small reusable matcher.

*Call graph*: called by 1 (parse_result); 1 external calls (new).


##### `expect_exec_approval`  (lines 514–542)

```
async fn expect_exec_approval(
    test: &TestCodex,
    expected_command: &str,
) -> ExecApprovalRequestEvent
```

**Purpose**: This helper waits until Codex either asks for command approval or finishes the turn, then enforces that an approval request arrived first. It also checks that the approval is for the exact parent command the test expected.

**Data flow**: It receives the test harness and expected command text. It listens for the next relevant event. If the event is an execution approval request, it compares the last command argument with the expected command and returns the approval object. If the turn finishes first, or any unexpected event appears, it fails the test.

**Call relations**: It is used by `approve_expected_exec`. That wrapper uses this function to get a verified approval request, then passes the request’s effective approval id to `approve_exec`.

*Call graph*: called by 1 (approve_expected_exec); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `wait_for_completion_without_approval`  (lines 544–560)

```
async fn wait_for_completion_without_approval(test: &TestCodex)
```

**Purpose**: This helper waits for the turn to finish and fails if Codex asks for another approval first. It is used when a test expects one approval to be enough.

**Data flow**: It receives the test harness and listens for either an execution approval request or turn completion. If completion arrives, it returns normally. If another approval request arrives, it panics with the unexpected command.

**Call relations**: The denied-read and approved-write tests call this after approving the parent command. It confirms that no extra approval prompt interrupted the rest of those flows.

*Call graph*: called by 2 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_preserves_denied_reads); 2 external calls (wait_for_event, panic!).


##### `wait_for_completion`  (lines 562–567)

```
async fn wait_for_completion(test: &TestCodex)
```

**Purpose**: This helper waits until Codex reports that the turn is complete. It is used when the test has already dealt with all expected approvals.

**Data flow**: It receives the test harness and watches Codex events until it sees a turn-complete event. It does not return any data; its result is simply that the test can safely continue after the turn has ended.

**Call relations**: The explicit prompt-rule test calls this after approving the second approval request. It marks the point where the command flow should be finished and the test can inspect the filesystem and recorded command output.

*Call graph*: called by 1 (unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule); 1 external calls (wait_for_event).


### Permission request flows
These files cover how permissions are requested, granted, persisted, and later consumed through both inline and standalone tool-driven paths.

### `core/tests/suite/request_permissions.rs`

`test` · `test run`

These tests act like a safety checklist for Codex’s permission system. Codex normally runs commands in a sandbox, which is a restricted area that limits what files or network resources a command can touch. Sometimes the model asks for extra access, such as permission to write to a directory outside the current workspace. This file checks that those requests are shown to the user at the right time, normalized into real absolute paths, applied only where intended, and rejected cleanly when the user says no.

The tests use a mock server to pretend to be the model. The server sends scripted tool calls such as `shell_command`, `exec_command`, or `request_permissions`. The test then watches Codex events: does it ask for approval, finish without asking, or return a denial message? After approval, the tests inspect real files on disk to confirm what actually happened.

A useful analogy is a building access badge. These tests make sure a temporary badge opens only the approved doors, does not secretly open the whole building, expires when it should, and can last for the whole session only when explicitly granted that way.

#### Function details

##### `absolute_path`  (lines 46–48)

```
fn absolute_path(path: &Path) -> AbsolutePathBuf
```

**Purpose**: Converts a normal filesystem path into the project’s absolute-path type. Tests use it when building expected permission requests, because permissions should name exact locations rather than vague relative paths.

**Data flow**: It receives a path, tries to turn it into an absolute path object, and returns that object. If the path is not absolute, the test fails immediately, which keeps bad test setup from hiding permission bugs.

**Call relations**: Permission-building helpers and test setup code call this when they need to describe a directory or file in a permission profile. It hands the converted path to permission structures that compare requested and approved access.

*Call graph*: calls 1 internal fn (try_from).


##### `parse_result`  (lines 55–92)

```
fn parse_result(item: &Value) -> CommandResult
```

**Purpose**: Reads the output of a mocked tool call and extracts the command’s exit code and printed text. Tests use it to decide whether a command really succeeded or failed after permissions were applied.

**Data flow**: It receives a JSON item that contains a tool output string. It first tries to read that string as structured JSON; if that does not work, it falls back to matching older plain-text formats with regular expressions. It returns a small `CommandResult` with an optional exit code and captured standard output.

**Call relations**: Many permission tests call this after Codex finishes a tool call. It turns raw function-call output from the mock response recorder into simple facts the test can assert, such as “exit code was zero” or “the output contains the denial message.”

*Call graph*: called by 12 (partial_request_permissions_grants_do_not_preapprove_new_permissions, read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write, read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write, relative_additional_permissions_resolve_against_tool_workdir, request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns, with_additional_permissions_denied_approval_blocks_execution (+2 more)); 2 external calls (new, get).


##### `shell_event_with_request_permissions`  (lines 94–107)

```
fn shell_event_with_request_permissions(
    call_id: &str,
    command: &str,
    additional_permissions: &S,
) -> Result<Value>
```

**Purpose**: Builds a fake model event for a `shell_command` tool call that asks for extra sandbox permissions. This lets tests simulate a model saying, “run this command, but I need these extra file permissions first.”

**Data flow**: It receives a call id, a shell command, and a serializable permissions object. It packages them into JSON arguments, marks the sandbox permission mode as needing additional permissions, serializes the JSON, and returns a function-call event for the mock server to send.

**Call relations**: Tests that exercise inline permissions for shell commands use this helper while scripting mock server responses. The produced event is later consumed by Codex, which should either request user approval or deny the command depending on policy.

*Call graph*: calls 1 internal fn (ev_function_call); called by 5 (read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write, read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write, with_additional_permissions_denied_approval_blocks_execution, with_additional_permissions_requires_approval_under_on_request, workspace_write_with_additional_permissions_can_write_outside_cwd); 2 external calls (json!, to_string).


##### `request_permissions_tool_event`  (lines 109–120)

```
fn request_permissions_tool_event(
    call_id: &str,
    reason: &str,
    permissions: &RequestPermissionProfile,
) -> Result<Value>
```

**Purpose**: Builds a fake model event for the standalone `request_permissions` tool. This represents the model asking the user for permission before running a later command.

**Data flow**: It receives a call id, a human-readable reason, and a permission profile. It turns those into JSON arguments and wraps them as a model function-call event named `request_permissions`.

**Call relations**: Tests use this when they want the mock model to request a permission grant as its own step. Codex receives the event, may emit a user-facing permission prompt, and the test then sends back an approval or denial response.

*Call graph*: calls 1 internal fn (ev_function_call); called by 1 (request_permissions_tool_is_auto_denied_when_granular_request_permissions_is_disabled); 2 external calls (json!, to_string).


##### `shell_command_event`  (lines 122–129)

```
fn shell_command_event(call_id: &str, command: &str) -> Result<Value>
```

**Purpose**: Builds a fake model event for a plain `shell_command` call with no inline extra permissions. It is used to check whether previously granted permissions are remembered for later shell commands.

**Data flow**: It receives a call id and command text, writes them into the JSON shape expected by the shell-command tool, serializes that JSON, and returns a mock function-call event.

**Call relations**: Later grant tests script this event after a separate permission request. Codex then decides whether the earlier grant is enough to let the shell command run.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `exec_command_event`  (lines 131–138)

```
fn exec_command_event(call_id: &str, command: &str) -> Result<Value>
```

**Purpose**: Builds a fake model event for a plain `exec_command` call. This is the exec-tool counterpart to `shell_command_event`.

**Data flow**: It receives a call id and command text, places them in the exec tool’s expected argument names, serializes the arguments, and returns a mock function-call event.

**Call relations**: Tests use this after permission grants to see whether an ordinary exec command benefits from the granted access. The event flows into Codex’s command execution path.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `exec_command_event_with_request_permissions`  (lines 140–153)

```
fn exec_command_event_with_request_permissions(
    call_id: &str,
    command: &str,
    additional_permissions: &S,
) -> Result<Value>
```

**Purpose**: Builds a fake `exec_command` event that includes inline additional permissions. It tests the case where the command itself carries an explicit permission request.

**Data flow**: It receives a call id, command text, and extra permissions. It creates JSON with the command, timing setting, sandbox mode, and requested permissions, serializes it, and returns a function-call event.

**Call relations**: Tests use this when checking whether explicit exec permissions are preapproved by an earlier grant or whether they still require a fresh approval. Codex reads the event and compares its requested access against the current grants.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `exec_command_event_with_missing_additional_permissions`  (lines 155–166)

```
fn exec_command_event_with_missing_additional_permissions(
    call_id: &str,
    command: &str,
) -> Result<Value>
```

**Purpose**: Builds a deliberately incomplete `exec_command` event: it says extra permissions are needed but does not include the permissions. This checks that Codex rejects malformed permission requests safely.

**Data flow**: It receives a call id and command text, creates JSON that enables the additional-permissions mode without supplying the actual permission object, serializes it, and returns a function-call event.

**Call relations**: The cross-turn grant test uses this to prove that a turn-scoped grant cannot be silently reused later. Codex should produce an error about the missing permissions instead of running the command.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `submit_turn`  (lines 168–205)

```
async fn submit_turn(
    test: &TestCodex,
    prompt: &str,
    approval_policy: AskForApproval,
    permission_profile: CorePermissionProfile,
) -> Result<()>
```

**Purpose**: Starts a test conversation turn with a specific prompt, approval policy, and base permission profile. It centralizes the setup needed to tell Codex what permissions and environment apply to this turn.

**Data flow**: It receives the test harness, prompt text, approval policy, and permission profile. It derives sandbox fields from the profile and current working directory, builds a user-input operation with thread settings, submits it to Codex, and returns success or an error.

**Call relations**: Almost every test calls this after the mock server has been prepared. It is the bridge from test setup into the real Codex turn flow, after which helper functions wait for approval prompts or completion events.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 14 (partial_request_permissions_grants_do_not_preapprove_new_permissions, read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write, read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write, relative_additional_permissions_resolve_against_tool_workdir, request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns (+4 more)); 2 external calls (default, vec!).


##### `wait_for_completion`  (lines 207–212)

```
async fn wait_for_completion(test: &TestCodex)
```

**Purpose**: Waits until Codex reports that the current turn is complete. Tests use it so they do not inspect outputs or files before the system has finished working.

**Data flow**: It receives the test harness, listens to Codex events, and stops when it sees a turn-complete event. It returns nothing; its effect is to pause the test until completion.

**Call relations**: After approvals or permission responses are submitted, tests call this to let Codex finish the scripted model flow. It relies on the shared event-waiting helper from the test support code.

*Call graph*: called by 13 (partial_request_permissions_grants_do_not_preapprove_new_permissions, read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write, read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write, relative_additional_permissions_resolve_against_tool_workdir, request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns (+3 more)); 1 external calls (wait_for_event).


##### `expect_exec_approval`  (lines 214–239)

```
async fn expect_exec_approval(
    test: &TestCodex,
    expected_command: &str,
) -> ExecApprovalRequestEvent
```

**Purpose**: Waits for Codex to ask the user to approve a command, and checks that the requested command is the one the test expected. It fails the test if Codex finishes too early or asks about the wrong command.

**Data flow**: It receives the test harness and expected command string. It waits for either an exec-approval request or turn completion, compares the last command argument against the expected command, and returns the approval request event.

**Call relations**: Tests that expect user approval call this right after submitting a turn. The returned approval id is then used to send an approved or denied decision back to Codex.

*Call graph*: called by 7 (partial_request_permissions_grants_do_not_preapprove_new_permissions, read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write, read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write, relative_additional_permissions_resolve_against_tool_workdir, with_additional_permissions_denied_approval_blocks_execution, with_additional_permissions_requires_approval_under_on_request, workspace_write_with_additional_permissions_can_write_outside_cwd); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `wait_for_exec_approval_or_completion`  (lines 241–257)

```
async fn wait_for_exec_approval_or_completion(
    test: &TestCodex,
) -> Option<ExecApprovalRequestEvent>
```

**Purpose**: Waits for either a command approval prompt or the end of the turn. This is useful for cases where a command may already be allowed and therefore might not need a prompt.

**Data flow**: It receives the test harness, watches Codex events, and returns the approval request if one appears. If the turn completes first, it returns no approval.

**Call relations**: Grant-reuse tests call this after responding to a permission request. If Codex still asks for approval, the test approves it; if Codex completes without asking, the test treats that as valid preapproval behavior.

*Call graph*: called by 4 (request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_preapprove_explicit_exec_permissions_outside_on_request); 2 external calls (wait_for_event, panic!).


##### `expect_request_permissions_event`  (lines 259–279)

```
async fn expect_request_permissions_event(
    test: &TestCodex,
    expected_call_id: &str,
) -> RequestPermissionProfile
```

**Purpose**: Waits for Codex to emit a user-facing permission request from the `request_permissions` tool. It also checks that the request belongs to the expected tool call.

**Data flow**: It receives the test harness and expected call id. It waits for either a permission-request event or turn completion, verifies the call id, and returns the requested permission profile.

**Call relations**: Tests call this after the mock model asks for permissions. The returned profile is compared with the expected normalized permissions, and then the test sends a simulated user response.

*Call graph*: called by 7 (partial_request_permissions_grants_do_not_preapprove_new_permissions, request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `workspace_write_excluding_tmp`  (lines 281–288)

```
fn workspace_write_excluding_tmp() -> CorePermissionProfile
```

**Purpose**: Creates a workspace-write permission profile that intentionally excludes temporary directories. Tests use this to make sure extra permissions, not default temp access, are what allow outside writes.

**Data flow**: It takes no input. It asks the core permission model for a workspace-write profile with restricted network access and with both environment temp directories and `/tmp` excluded, then returns that profile.

**Call relations**: Many tests use this as the starting permission profile before requesting extra access. That makes the test conditions stricter: outside or temporary writes should only work if the request-permissions flow grants them.

*Call graph*: called by 9 (partial_request_permissions_grants_do_not_preapprove_new_permissions, request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns, with_additional_permissions_denied_approval_blocks_execution, workspace_write_with_additional_permissions_can_write_outside_cwd); 1 external calls (workspace_write_with).


##### `requested_directory_write_permissions`  (lines 290–298)

```
fn requested_directory_write_permissions(path: &Path) -> RequestPermissionProfile
```

**Purpose**: Builds a permission request that asks for write access to one directory. This represents what the model asks for before paths are canonicalized.

**Data flow**: It receives a path, wraps it as an absolute path, creates filesystem permissions with no read roots and one write root, and returns a request-permission profile.

**Call relations**: Tests use this to create the request sent through the mock `request_permissions` tool or inline command permissions. Its output is often compared with the normalized version made by `normalized_directory_write_permissions`.

*Call graph*: calls 1 internal fn (from_read_write_roots); called by 7 (partial_request_permissions_grants_do_not_preapprove_new_permissions, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns, request_permissions_tool_is_auto_denied_when_granular_request_permissions_is_disabled); 2 external calls (default, vec!).


##### `normalized_directory_write_permissions`  (lines 300–308)

```
fn normalized_directory_write_permissions(path: &Path) -> Result<RequestPermissionProfile>
```

**Purpose**: Builds the expected canonical form of a directory-write permission request. Canonical means the path has been resolved to its real filesystem location, avoiding ambiguity from symlinks or relative pieces.

**Data flow**: It receives a path, canonicalizes it through the filesystem, converts it to an absolute path object, places it in a write-root permission profile, and returns that profile or an error.

**Call relations**: Tests call this when checking what Codex should show or store after it processes a permission request. It provides the expected value for assertions against Codex’s normalized permissions.

*Call graph*: calls 1 internal fn (from_read_write_roots); called by 6 (partial_request_permissions_grants_do_not_preapprove_new_permissions, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns); 2 external calls (default, vec!).


##### `with_additional_permissions_requires_approval_under_on_request`  (lines 311–399)

```
async fn with_additional_permissions_requires_approval_under_on_request() -> Result<()>
```

**Purpose**: Checks that inline extra permissions on a shell command cause an approval prompt when the approval policy is “on request.” It proves that the model cannot silently grant itself extra file access.

**Data flow**: The test starts Codex with read-only permissions, scripts a shell command that asks to write in a specific directory, and submits a turn. It expects an exec approval containing those extra permissions, approves it, waits for completion, then confirms the file was created.

**Call relations**: This test uses the mock server helpers to send a shell-command event, `submit_turn` to start Codex, `expect_exec_approval` to catch the prompt, and `parse_result` to inspect the command output after approval.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_request_permissions, submit_turn, wait_for_completion, from_read_write_roots); 9 external calls (read_only, default, assert!, assert_eq!, create_dir_all, remove_file, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `request_permissions_tool_is_auto_denied_when_granular_request_permissions_is_disabled`  (lines 402–492)

```
async fn request_permissions_tool_is_auto_denied_when_granular_request_permissions_is_disabled() -> Result<()>
```

**Purpose**: Checks that the standalone permission-request tool is automatically denied when the granular setting for request permissions is turned off. This prevents a disabled feature path from still prompting or granting access.

**Data flow**: The test configures granular approvals with `request_permissions` disabled, scripts a permission request, and submits a turn. It verifies that no permission prompt is emitted and that the tool output contains an empty permission grant response.

**Call relations**: It builds the fake request with `request_permissions_tool_event`, starts the turn with `submit_turn`, and waits directly for either a permission event or completion. The expected story is completion without a prompt.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, request_permissions_tool_event, requested_directory_write_permissions, submit_turn); 10 external calls (read_only, Granular, assert!, assert_eq!, wait_for_event, create_dir_all, from_str, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `relative_additional_permissions_resolve_against_tool_workdir`  (lines 503–621)

```
async fn relative_additional_permissions_resolve_against_tool_workdir(
    command_tool: AdditionalPermissionsCommandTool,
) -> Result<()>
```

**Purpose**: Checks that relative permission paths are resolved from the tool’s working directory, not from some unrelated process directory. This matters because `.` should mean “where the command runs.”

**Data flow**: For both shell and exec tools, the test creates a nested directory, asks for write access to `.` while setting the tool workdir to that nested directory, and runs a command that writes there. It expects approval to name the canonical nested directory, then approves and verifies the file was created.

**Call relations**: The test scripts tool-call events directly, uses `submit_turn` to run them, waits with `expect_exec_approval`, and reads results through `parse_result`. The test-case attribute runs the same scenario for both supported command tools.

*Call graph*: calls 10 internal fn (ev_function_call, mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, submit_turn, wait_for_completion, from_read_write_roots); 11 external calls (read_only, default, assert!, assert_eq!, create_dir_all, remove_file, json!, to_string, skip_if_no_network!, skip_if_sandbox! (+1 more)).


##### `read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write`  (lines 625–724)

```
async fn read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write() -> Result<()>
```

**Purpose**: On macOS, checks that approving one requested path does not accidentally allow writing anywhere in the current workspace. This guards against a serious sandbox-widening bug.

**Data flow**: The test starts in read-only mode, requests permission for one file, but runs a command that writes to a different unrequested file in the current directory. After approving the requested permission, it expects the command to fail and confirms neither file was created.

**Call relations**: It uses `shell_event_with_request_permissions` to script the command, `expect_exec_approval` to verify the requested permission, and `parse_result` plus filesystem checks to confirm that unrequested current-directory writes remain blocked.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_request_permissions, submit_turn, wait_for_completion, from_read_write_roots); 9 external calls (read_only, default, assert!, assert_eq!, format!, remove_file, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write`  (lines 728–828)

```
async fn read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write() -> Result<()>
```

**Purpose**: On macOS, checks that approving one requested path does not accidentally allow writing to temporary directories. Temporary folders are common escape routes, so this is an important sandbox safety test.

**Data flow**: The test requests permission for a workspace file, but runs a command that writes to a separate temporary-directory file. It approves the request, waits for completion, and expects the write to fail with no files created.

**Call relations**: Like the current-directory widening test, it uses the shell-event helper, approval expectation helper, and result parser. Its special focus is the temporary-directory area rather than the workspace current directory.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_request_permissions, submit_turn, wait_for_completion, from_read_write_roots); 10 external calls (read_only, default, assert!, assert_eq!, format!, remove_file, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `workspace_write_with_additional_permissions_can_write_outside_cwd`  (lines 831–937)

```
async fn workspace_write_with_additional_permissions_can_write_outside_cwd() -> Result<()>
```

**Purpose**: Checks that a user-approved extra permission can let a command write outside the workspace when the base profile allows workspace writing but not that outside location. This verifies that legitimate expansions work.

**Data flow**: The test creates a temporary outside directory, scripts a shell command that writes there, and includes a request for that directory. After Codex asks for approval with the normalized permissions, the test approves, waits, and confirms the outside file contains the expected text.

**Call relations**: It combines `workspace_write_excluding_tmp`, `shell_event_with_request_permissions`, `expect_exec_approval`, and `parse_result`. Together they prove the approval path grants exactly the requested outside write.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_request_permissions, submit_turn, wait_for_completion, workspace_write_excluding_tmp (+1 more)); 9 external calls (default, assert!, assert_eq!, format!, remove_file, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `with_additional_permissions_denied_approval_blocks_execution`  (lines 940–1043)

```
async fn with_additional_permissions_denied_approval_blocks_execution() -> Result<()>
```

**Purpose**: Checks that denying an approval request prevents the command from running. This ensures the user’s “no” is enforced, not just recorded.

**Data flow**: The test scripts a shell command that would write outside the workspace with requested extra permissions. When Codex asks for approval, the test sends a denied decision, waits for completion, then checks that the output says the command was rejected and no file was created.

**Call relations**: It follows the same setup path as successful extra-permission tests, but sends `ReviewDecision::Denied` after `expect_exec_approval`. `parse_result` and filesystem checks confirm the denial stopped execution.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_request_permissions, submit_turn, wait_for_completion, workspace_write_excluding_tmp (+1 more)); 9 external calls (default, assert!, assert_eq!, assert_ne!, format!, remove_file, skip_if_no_network!, tempdir, vec!).


##### `request_permissions_grants_apply_to_later_exec_command_calls`  (lines 1046–1169)

```
async fn request_permissions_grants_apply_to_later_exec_command_calls() -> Result<()>
```

**Purpose**: Checks that a permission granted through the standalone request tool can be used by a later `exec_command` in the same turn. This is the “ask first, act later” workflow.

**Data flow**: The mock model first asks for write access to an outside directory, then later sends an exec command that writes there. The test approves the permission request for the turn, handles any remaining exec approval if Codex asks, and confirms the command wrote the expected file.

**Call relations**: It uses a sequence of mock server responses, `expect_request_permissions_event` to capture the standalone request, `wait_for_exec_approval_or_completion` for optional command approval, and `parse_result` to verify the later exec call.

*Call graph*: calls 10 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, parse_result, submit_turn, wait_for_completion, wait_for_exec_approval_or_completion, workspace_write_excluding_tmp, from_read_write_roots); 7 external calls (default, assert_eq!, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `request_permissions_preapprove_explicit_exec_permissions_outside_on_request`  (lines 1172–1291)

```
async fn request_permissions_preapprove_explicit_exec_permissions_outside_on_request() -> Result<()>
```

**Purpose**: Checks that a later exec command with explicit inline permissions can be preapproved by an earlier matching permission grant. It prevents needless repeated prompts for the same approved access.

**Data flow**: The test first grants directory write access through `request_permissions`. The next mocked response sends an exec command that asks for the same permissions inline. The test allows any approval if it appears, then verifies the command succeeds and writes the expected content.

**Call relations**: It relies on the directory permission helpers to build requested and normalized profiles. The flow goes through `expect_request_permissions_event`, a simulated grant response, optional exec approval, and final result parsing.

*Call graph*: calls 11 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, wait_for_completion, wait_for_exec_approval_or_completion (+1 more)); 7 external calls (assert!, assert_eq!, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `request_permissions_grants_apply_to_later_shell_command_calls`  (lines 1294–1405)

```
async fn request_permissions_grants_apply_to_later_shell_command_calls() -> Result<()>
```

**Purpose**: Checks that a standalone permission grant can also apply to a later `shell_command`, not just `exec_command`. This keeps both command tools consistent.

**Data flow**: The model first requests permission to write outside the workspace. After the test grants that permission for the turn, the model sends a shell command that writes there. The test then verifies the command output and file contents.

**Call relations**: This mirrors the exec-command grant test but uses `shell_command_event` for the later command. It uses the same permission-event, optional approval, completion, and result-parsing helpers.

*Call graph*: calls 11 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, wait_for_completion, wait_for_exec_approval_or_completion (+1 more)); 7 external calls (assert!, assert_eq!, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature`  (lines 1408–1521)

```
async fn request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature() -> Result<()>
```

**Purpose**: Checks that standalone permission grants work for later shell commands even when the inline exec-permission approval feature is not enabled. This proves the request-permissions tool is useful on its own.

**Data flow**: The test enables the request-permissions feature but not the inline permission approvals feature. It grants outside-directory write access, runs a later shell command, and confirms the command succeeds and writes the file.

**Call relations**: It follows the same staged mock response pattern as the previous shell-command test. The key difference is the feature configuration, which proves the later grant path does not depend on inline permission support.

*Call graph*: calls 11 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, wait_for_completion, wait_for_exec_approval_or_completion (+1 more)); 7 external calls (assert!, assert_eq!, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `partial_request_permissions_grants_do_not_preapprove_new_permissions`  (lines 1524–1688)

```
async fn partial_request_permissions_grants_do_not_preapprove_new_permissions() -> Result<()>
```

**Purpose**: Checks that a partial grant only preapproves the part the user actually granted. If a later command asks for additional access, Codex must ask again rather than assuming the original larger request was approved.

**Data flow**: The model asks for write access to two outside directories, but the test grants only the first. The later exec command asks for the second directory. Codex should request exec approval with the merged set of granted and newly requested permissions; after approval, the command writes to the second directory successfully.

**Call relations**: This test ties together the standalone request flow and inline exec approval flow. It uses `expect_request_permissions_event` for the initial broad request, `expect_exec_approval` for the later new access, then parses the command output after approval.

*Call graph*: calls 12 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_exec_approval, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, wait_for_completion (+2 more)); 9 external calls (default, default, assert!, assert_eq!, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `request_permissions_grants_do_not_carry_across_turns`  (lines 1691–1803)

```
async fn request_permissions_grants_do_not_carry_across_turns() -> Result<()>
```

**Purpose**: Checks that a turn-scoped permission grant expires after the current turn. This prevents temporary access from becoming a hidden long-term privilege.

**Data flow**: In the first turn, the test grants outside-directory write access with scope set to the turn. In a second turn, the model tries to run an exec command that says it needs extra permissions but omits the actual permission data. The test confirms Codex rejects it with a missing-permissions message.

**Call relations**: It uses `submit_turn` twice against the same test session. `expect_request_permissions_event` and `wait_for_completion` finish the first turn, then the second mock sequence proves the old grant is not silently reused.

*Call graph*: calls 9 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, requested_directory_write_permissions, submit_turn, wait_for_completion, workspace_write_excluding_tmp); 6 external calls (assert!, assert_eq!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `request_permissions_session_grants_carry_across_turns`  (lines 1807–1942)

```
async fn request_permissions_session_grants_carry_across_turns() -> Result<()>
```

**Purpose**: On macOS, checks that a session-scoped permission grant can be reused in a later turn. This is the intentional long-lived version of permission granting.

**Data flow**: The first turn asks for outside-directory write access and the test grants it with session scope. In the second turn, a plain exec command writes to that same directory. The test approves any command prompt if needed, then confirms the command succeeds and the file contains the expected text.

**Call relations**: This is the companion to the turn-scope expiry test. It uses the same request-event and normalized-permission helpers, but sends a session-scoped response and then verifies reuse in a later submitted turn.

*Call graph*: calls 10 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, wait_for_completion, workspace_write_excluding_tmp); 7 external calls (assert_eq!, wait_for_event, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


### `core/tests/suite/request_permissions_tool.rs`

`test` · `test execution`

This file tests a safety feature: the model can request more permission when it needs to write somewhere it normally cannot. Think of it like a delivery worker asking for a temporary key to one extra room, then using only that key for the rest of the job. Without these tests, Codex might ask for permission but fail to apply it, apply it too broadly, or still interrupt the user with unnecessary approval prompts.

The tests build a fake Codex session connected to a mock server. The mock server pretends to be the model and sends a sequence of events: first a request for permission to write to a temporary folder, then either a shell command or an apply-patch operation that writes inside that folder, then a final assistant message. The test code watches Codex events, verifies that the requested path is converted to its real absolute form, sends back an approval, and checks that the later operation succeeds.

There are two main scenarios. One proves that a granted folder write permission lets a later shell command create a file outside the workspace. The other proves the same for apply_patch edits, including a stricter mode where an extra automatic review is expected. The helpers in this file mostly build fake model events, submit a user turn with the right permission settings, wait for key events, and parse tool output so the tests can make clear assertions.

#### Function details

##### `absolute_path`  (lines 42–44)

```
fn absolute_path(path: &Path) -> AbsolutePathBuf
```

**Purpose**: Turns a normal filesystem path into the project’s absolute-path type. The tests use this so permission objects contain paths in the exact form the permission system expects.

**Data flow**: It receives a path, tries to convert it into an absolute path, and returns that converted value. If the input is not absolute, the test fails immediately because that would make the permission setup invalid.

**Call relations**: It is used while building requested permission profiles, so later test steps can compare granted permissions using the same path type as the real permission system.

*Call graph*: calls 1 internal fn (try_from).


##### `request_permissions_tool_event`  (lines 46–57)

```
fn request_permissions_tool_event(
    call_id: &str,
    reason: &str,
    permissions: &RequestPermissionProfile,
) -> Result<Value>
```

**Purpose**: Builds a fake model tool-call event where the model asks Codex for more permissions. This lets the test server simulate the model saying, “I need write access here, for this reason.”

**Data flow**: It takes a tool call ID, a human-readable reason, and the requested permissions. It packages them as JSON text and wraps that text in a fake `request_permissions` function-call event, returning the event or an error if JSON creation fails.

**Call relations**: The main tests place this event into the mock server’s response stream before any command or patch is attempted. Codex receives it and should emit a real permission-request event to the test harness.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `exec_command_event`  (lines 59–66)

```
fn exec_command_event(call_id: &str, command: &str) -> Result<Value>
```

**Purpose**: Builds a fake model tool-call event that asks Codex to run a shell command. The tests use it after permission approval to check whether the newly granted access really works.

**Data flow**: It receives a call ID and command string, places them into JSON along with a short yield time, then wraps that JSON in an `exec_command` function-call event. The result is a mock event ready to be sent by the fake server.

**Call relations**: The shell-command test includes this after the permission request. Once the test approves the permission request, Codex should run this command without being blocked by the original sandbox limits.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `build_add_file_patch`  (lines 68–74)

```
fn build_add_file_patch(patch_path: &Path, content: &str) -> String
```

**Purpose**: Creates the text for a simple patch that adds one new file with one line of content. This gives the apply-patch test a realistic edit to send through Codex.

**Data flow**: It takes a target path and file content, formats them into the patch syntax used by the apply-patch tool, and returns the patch as a string.

**Call relations**: The apply-patch test calls it after choosing the temporary target file. The resulting patch is then sent through the mock model response as a custom tool call.

*Call graph*: called by 1 (apply_patch_after_request_permissions); 1 external calls (format!).


##### `workspace_write_excluding_tmp`  (lines 76–83)

```
fn workspace_write_excluding_tmp() -> PermissionProfile
```

**Purpose**: Creates the starting permission profile for the tests: Codex may write in the workspace, but not in temporary directories. This is important because the tests need the later temporary-folder access to come only from the explicit permission request.

**Data flow**: It builds and returns a workspace-write permission profile with network access restricted and temporary-directory exceptions excluded. Nothing is changed outside the returned permission object.

**Call relations**: Both main test flows use this as their baseline. They then request a separate grant for a temporary directory, proving the request-permissions tool is what unlocks the later write.

*Call graph*: calls 1 internal fn (workspace_write_with); called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args).


##### `requested_directory_write_permissions`  (lines 85–93)

```
fn requested_directory_write_permissions(path: &Path) -> RequestPermissionProfile
```

**Purpose**: Builds the permission request that the fake model asks for: write access to one chosen directory and no added read roots. This represents the raw request before Codex normalizes the path.

**Data flow**: It receives a directory path, converts it to the absolute-path type, places it in the write-roots list, and returns a request-permission profile containing that filesystem permission.

**Call relations**: The shell-command and apply-patch tests pass this to the fake `request_permissions` tool call. Codex should receive the request and then report back an equivalent normalized version.

*Call graph*: calls 1 internal fn (from_read_write_roots); called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args); 2 external calls (default, vec!).


##### `normalized_directory_write_permissions`  (lines 95–103)

```
fn normalized_directory_write_permissions(path: &Path) -> Result<RequestPermissionProfile>
```

**Purpose**: Builds the permission profile the tests expect Codex to produce after resolving the requested directory to its canonical, real filesystem path. This avoids false mismatches caused by path spelling, symbolic links, or temporary-directory aliases.

**Data flow**: It receives a directory path, asks the operating system for the canonical version, converts that into the absolute-path type, and returns a request-permission profile with that normalized write root. If canonicalization or conversion fails, it returns an error.

**Call relations**: Both main test flows compare Codex’s emitted permission request against this normalized value. The same normalized value is then sent back as the approved grant.

*Call graph*: calls 1 internal fn (from_read_write_roots); called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args); 2 external calls (default, vec!).


##### `parse_result`  (lines 105–133)

```
fn parse_result(item: &Value) -> (Option<i64>, String)
```

**Purpose**: Extracts an exit code and visible output from a tool-call result. It understands both structured JSON output and older plain-text formats, making the tests tolerant of different result shapes.

**Data flow**: It receives a JSON item that should contain an `output` string. It first tries to parse that string as JSON and read the exit code and output from known fields. If that fails, it uses text patterns to pull the same information from a plain message. It returns the optional exit code and the captured output text.

**Call relations**: After the shell command or patch runs, the tests use this helper to check whether the operation succeeded and whether the expected success text or file content appeared.

*Call graph*: called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args); 2 external calls (new, get).


##### `submit_turn`  (lines 135–173)

```
async fn submit_turn(
    test: &TestCodex,
    prompt: &str,
    approval_policy: AskForApproval,
    permission_profile: PermissionProfile,
    approvals_reviewer: Option<ApprovalsReviewer>,
) -> Re
```

**Purpose**: Starts a Codex turn in the test session with a user prompt and carefully chosen permission settings. This is the bridge between the test setup and the real turn-processing code under test.

**Data flow**: It receives the test session, prompt text, approval policy, permission profile, and optional reviewer setting. It derives the sandbox and permission fields for the current workspace, builds a user-input operation with thread overrides, submits it to Codex, and returns success or an error.

**Call relations**: Both main test flows call this after mounting mock server responses. Once submitted, Codex begins reading the fake model events, which leads to the permission request and later command or patch.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args); 2 external calls (default, vec!).


##### `wait_for_completion`  (lines 175–180)

```
async fn wait_for_completion(test: &TestCodex)
```

**Purpose**: Waits until Codex reports that the current turn is complete. It is a small helper for test steps that need to pause until all model/tool work has finished.

**Data flow**: It receives the test session and listens to Codex events until it sees a turn-complete event. It does not return data; it simply waits for the right point in the test flow.

**Call relations**: The strict apply-patch path uses this after sending the permission response, because that path expects an extra automatic review before final completion.

*Call graph*: called by 1 (apply_patch_after_request_permissions); 1 external calls (wait_for_event).


##### `expect_request_permissions_event`  (lines 182–202)

```
async fn expect_request_permissions_event(
    test: &TestCodex,
    expected_call_id: &str,
) -> RequestPermissionProfile
```

**Purpose**: Waits for Codex to ask for permissions and verifies that the request belongs to the expected tool call. If Codex finishes the turn first, or emits an unexpected event, the test fails.

**Data flow**: It receives the test session and expected call ID. It waits for either a permission-request event or turn completion. On a permission request, it checks the call ID and returns the requested permission profile. On completion or any wrong event, it panics because the expected safety flow did not happen.

**Call relations**: Both main test flows use this immediately after submitting the turn. The returned permission profile is compared with the normalized expected profile before the test sends the approval response back to Codex.

*Call graph*: called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args`  (lines 206–329)

```
async fn approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args() -> Result<()>
```

**Purpose**: Tests the full path where Codex requests write access to a folder, the test approves it for the current turn, and a later shell command writes to that folder successfully. It specifically checks that the command succeeds because of the permission grant, not because the command was given special sandbox arguments.

**Data flow**: It starts a mock server, configures Codex with request-permissions features enabled, creates a temporary directory and command that writes a file there, and feeds Codex a fake model sequence: permission request, shell command, final message. The test submits a user turn, verifies and approves the normalized permission request, handles any command approval if one appears, then reads the tool output and filesystem to confirm the file was created with the expected content.

**Call relations**: This is one of the main test cases. It relies on the helpers that build permission profiles, submit the turn, wait for the permission event, and parse the command result. Its success shows that permission grants affect later `exec_command` work inside the same turn.

*Call graph*: calls 9 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, workspace_write_excluding_tmp); 8 external calls (assert!, assert_eq!, wait_for_event, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `approved_folder_write_request_permissions_unblocks_later_apply_patch`  (lines 333–341)

```
async fn approved_folder_write_request_permissions_unblocks_later_apply_patch() -> Result<()>
```

**Purpose**: Runs the apply-patch permission scenario in two modes: normal approval and stricter automatic review. This confirms that folder write grants also work for patch edits, not only shell commands.

**Data flow**: It first skips the test when network access or the environment sandbox would make the scenario unreliable. Then it calls the shared apply-patch test helper once with strict review off and once with strict review on. It returns success only if both subcases pass.

**Call relations**: This is the public test wrapper for the apply-patch scenario. The real setup and assertions live in `apply_patch_after_request_permissions`, which it invokes for each review mode.

*Call graph*: calls 1 internal fn (apply_patch_after_request_permissions); 2 external calls (skip_if_no_network!, skip_if_sandbox!).


##### `apply_patch_after_request_permissions`  (lines 343–514)

```
async fn apply_patch_after_request_permissions(strict_auto_review: bool) -> Result<()>
```

**Purpose**: Tests the full path where Codex requests write access to a folder and then uses apply_patch to create a file there. It also checks the special strict-review mode, where an extra reviewer request should include the patch details.

**Data flow**: It receives a boolean saying whether strict automatic review is enabled. It configures a Codex test session, creates a temporary target file, builds a patch for that file, and mounts fake model responses: permission request, apply-patch call, optional strict-review guardian response, and final message. After submitting the turn, it verifies the normalized permission request, sends the approval response, waits for the expected follow-up behavior, then inspects captured requests and patch output and finally reads the created file to confirm the content.

**Call relations**: The apply-patch wrapper test calls this twice. Inside, it uses helpers for baseline permissions, patch text, permission-event waiting, completion waiting, and result parsing. Its success shows that a turn-scoped permission grant can safely unlock later patch writes, while strict review still gets the information it needs.

*Call graph*: calls 12 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, build_add_file_patch, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn (+2 more)); called by 1 (approved_folder_write_request_permissions_unblocks_later_apply_patch); 6 external calls (assert!, assert_eq!, wait_for_event, panic!, tempdir, vec!).


### User-input and review mediation
These tests follow mediated interaction paths where the system asks the user for input or routes work through review and Guardian review layers.

### `core/tests/suite/request_user_input.rs`

`test` · `test run`

These tests protect a user-facing pause-and-confirm flow. In normal chat, the assistant may call a special tool named request_user_input when it needs the person to choose an option before it continues. This file sets up a fake server that pretends to be the model API, feeds Codex scripted responses, and then checks what Codex sends back.

The tests cover the happy path first. The fake model asks a question, Codex emits a RequestUserInput event to the outside world, and Codex must not finish the turn or report token counts until the user answers. After the test sends a UserInputAnswer back into Codex, Codex forwards that answer to the model as function-call output and the turn completes.

The file also tests a timeout hint field, autoResolutionMs, to make sure it is preserved in the event shown to the client. Another test interrupts the turn while a user-input request is pending, verifying that token usage is still reported before the turn is marked aborted.

Finally, the file checks mode rules. request_user_input is accepted in Plan mode, and in Default mode only when a feature flag is enabled. It is rejected in Execute, Pair Programming, and ordinary Default mode, with a clear message sent back to the model.

#### Function details

##### `call_output`  (lines 39–50)

```
fn call_output(req: &ResponsesRequest, call_id: &str) -> String
```

**Purpose**: This helper pulls the text that Codex sent back to the model for a particular tool call. It also double-checks that the returned tool output really belongs to the expected call ID, so a test cannot accidentally inspect the wrong response.

**Data flow**: It receives a recorded fake-server request and a tool call ID. It reads the function-call output from that request, verifies the embedded call ID matches, extracts the output content, and returns that content as a string. If anything is missing or mismatched, the test fails immediately.

**Call relations**: The round-trip test uses this after Codex resumes from a user answer. It lets request_user_input_round_trip_for_mode inspect the second request sent to the fake model and confirm that the user’s answer was packaged correctly.

*Call graph*: calls 2 internal fn (function_call_output, function_call_output_content_and_success); called by 1 (request_user_input_round_trip_for_mode); 1 external calls (assert_eq!).


##### `call_output_content_and_success`  (lines 52–67)

```
fn call_output_content_and_success(
    req: &ResponsesRequest,
    call_id: &str,
) -> (String, Option<bool>)
```

**Purpose**: This helper reads both the text and the optional success flag from a function-call output. It is used when the tests need to confirm not only what Codex said back to the model, but also whether Codex marked the tool call as successful.

**Data flow**: It takes a recorded request and a call ID. It finds the matching function-call output, confirms the call ID, extracts the content text and success value, and returns them together. Missing content or a mismatched ID causes the test to fail.

**Call relations**: The rejection helper uses this after Codex refuses request_user_input in a disallowed mode. It checks that the model received the expected rejection message and that no explicit success value was attached.

*Call graph*: calls 2 internal fn (function_call_output, function_call_output_content_and_success); called by 1 (assert_request_user_input_rejected); 1 external calls (assert_eq!).


##### `request_user_input_round_trip_resolves_pending`  (lines 70–72)

```
async fn request_user_input_round_trip_resolves_pending() -> anyhow::Result<()>
```

**Purpose**: This test verifies the basic successful flow in Plan mode: Codex pauses for user input and then continues once the answer is supplied.

**Data flow**: It supplies Plan mode with no auto-resolution timeout. The shared round-trip helper drives the fake model interaction, sends an answer, and checks that the final function-call output contains that answer.

**Call relations**: This is a small test entry point. It delegates the full scenario to request_user_input_round_trip_for_mode so the same detailed checks can be reused by other mode and timeout tests.

*Call graph*: calls 1 internal fn (request_user_input_round_trip_for_mode).


##### `request_user_input_round_trip_emits_auto_resolution_ms`  (lines 75–77)

```
async fn request_user_input_round_trip_emits_auto_resolution_ms() -> anyhow::Result<()>
```

**Purpose**: This test verifies that when the model includes an auto-resolution timeout value, Codex passes that value through to the client-facing request event.

**Data flow**: It runs the shared round-trip scenario in Plan mode with an autoResolutionMs value of 60000. The helper checks that the RequestUserInput event contains the same value and that the rest of the answer flow still works.

**Call relations**: Like the basic round-trip test, this function is a short wrapper around request_user_input_round_trip_for_mode. Its job is to exercise the same machinery with the timeout field present.

*Call graph*: calls 1 internal fn (request_user_input_round_trip_for_mode).


##### `request_user_input_round_trip_for_mode`  (lines 79–229)

```
async fn request_user_input_round_trip_for_mode(
    mode: ModeKind,
    auto_resolution_ms: Option<u64>,
) -> anyhow::Result<()>
```

**Purpose**: This is the main reusable test scenario for a successful request_user_input flow. It proves that Codex can receive a model’s question, pause the turn, accept the user’s answer, and send that answer back to the model before completing.

**Data flow**: It starts a mock model server, builds a test Codex session, and scripts the first fake model response to call request_user_input. It submits user text into Codex, waits until Codex emits a RequestUserInput event, checks the question details, and confirms token-count reporting is delayed while the question is unresolved. Then it submits a UserInputAnswer, waits for token count and turn completion, reads the next fake-server request, parses the function-call output JSON, and verifies it contains the expected answer.

**Call relations**: Several wrapper tests call this with different modes and timeout settings. Inside the scenario it uses the fake response helpers to script server events, test_codex helpers to create a session and permissions, wait helpers to observe Codex events, and call_output to inspect what Codex sends back to the fake model.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, call_output); called by 3 (request_user_input_round_trip_emits_auto_resolution_ms, request_user_input_round_trip_in_default_mode_with_feature, request_user_input_round_trip_resolves_pending); 10 external calls (default, new, assert!, assert_eq!, wait_for_event, wait_for_event_match, json!, from_str, skip_if_no_network!, vec!).


##### `ev_rate_limits`  (lines 231–249)

```
fn ev_rate_limits() -> Value
```

**Purpose**: This helper creates a fake rate-limit event, like a small status notice from the model service about usage limits. The round-trip test includes it to make sure such an event does not disturb the pending user-input flow.

**Data flow**: It takes no input. It builds and returns a JSON value describing allowed rate limits, usage percentage, and related empty fields.

**Call relations**: request_user_input_round_trip_for_mode inserts this event into the scripted fake server stream between the tool call and completion. It is not called by other helpers.

*Call graph*: 1 external calls (json!).


##### `request_user_input_interrupt_emits_deferred_token_count`  (lines 252–339)

```
async fn request_user_input_interrupt_emits_deferred_token_count() -> anyhow::Result<()>
```

**Purpose**: This test checks an important cleanup case: if a turn is interrupted while Codex is waiting for user input, Codex still reports the token count from the model response before saying the turn was aborted.

**Data flow**: It starts a fake server, scripts a response that calls request_user_input and completes with token usage, then submits a user message to Codex. After Codex emits the pending RequestUserInput event, the test sends an interrupt operation. It then waits for a TokenCount event, checks that the total token count is 77, and finally waits for the turn-aborted event.

**Call relations**: This test drives the full setup itself rather than using the round-trip helper because the flow ends with an interrupt instead of an answer. It uses the same mock server, scripted SSE response helpers, permission setup, and event-waiting helpers as the successful round-trip tests.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); 7 external calls (default, assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, vec!).


##### `assert_request_user_input_rejected`  (lines 341–424)

```
async fn assert_request_user_input_rejected(mode_name: &str, build_mode: F) -> anyhow::Result<()>
```

**Purpose**: This shared test helper verifies that request_user_input is refused in a particular collaboration mode. It confirms Codex sends a clear rejection message back to the model instead of showing a question to the user.

**Data flow**: It receives a human-readable mode name and a function that builds that mode’s settings. It starts a fake server, scripts the model to call request_user_input, runs a Codex turn in the chosen mode, and waits for the turn to complete. Then it inspects the follow-up request sent to the model and checks that the function-call output says request_user_input is unavailable in that mode, with no success flag.

**Call relations**: The Execute, Default, and Pair Programming rejection tests all call this helper. It uses call_output_content_and_success to inspect the model-facing rejection and the common fake-server and test-session helpers to run the scenario.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, call_output_content_and_success); called by 3 (request_user_input_rejected_in_default_mode_by_default, request_user_input_rejected_in_execute_mode_alias, request_user_input_rejected_in_pair_mode_alias); 7 external calls (default, assert_eq!, wait_for_event, format!, json!, skip_if_no_network!, vec!).


##### `request_user_input_rejected_in_execute_mode_alias`  (lines 427–437)

```
async fn request_user_input_rejected_in_execute_mode_alias() -> anyhow::Result<()>
```

**Purpose**: This test verifies that request_user_input is not available in Execute mode. Execute mode is meant for carrying out work, not pausing to ask the user interactive planning questions through this tool.

**Data flow**: It builds an Execute collaboration mode using the current model name and passes it to the shared rejection helper. The result is a completed turn where Codex has returned an unavailable-in-Execute message to the model.

**Call relations**: This is a mode-specific wrapper around assert_request_user_input_rejected. The shared helper performs the server setup, Codex submission, and output inspection.

*Call graph*: calls 1 internal fn (assert_request_user_input_rejected).


##### `request_user_input_rejected_in_default_mode_by_default`  (lines 440–450)

```
async fn request_user_input_rejected_in_default_mode_by_default() -> anyhow::Result<()>
```

**Purpose**: This test verifies that request_user_input is rejected in Default mode unless the special feature flag is turned on. That protects the default behavior from changing unexpectedly.

**Data flow**: It builds a Default collaboration mode with normal settings and gives it to the shared rejection helper. The helper then proves that Codex completes the turn by sending an unavailable-in-Default message back to the model.

**Call relations**: This wrapper calls assert_request_user_input_rejected for the Default mode case. It pairs with request_user_input_round_trip_in_default_mode_with_feature, which checks the feature-flag-enabled exception.

*Call graph*: calls 1 internal fn (assert_request_user_input_rejected).


##### `request_user_input_round_trip_in_default_mode_with_feature`  (lines 453–455)

```
async fn request_user_input_round_trip_in_default_mode_with_feature() -> anyhow::Result<()>
```

**Purpose**: This test verifies the exception to the Default-mode rule: when the DefaultModeRequestUserInput feature is enabled, Default mode can use request_user_input successfully.

**Data flow**: It asks the shared round-trip helper to run in Default mode. That helper enables the needed feature while building the test configuration, then checks the full ask-answer-continue flow.

**Call relations**: This is a short wrapper around request_user_input_round_trip_for_mode. Together with the Default rejection test, it proves both sides of the feature flag behavior.

*Call graph*: calls 1 internal fn (request_user_input_round_trip_for_mode).


##### `request_user_input_rejected_in_pair_mode_alias`  (lines 458–468)

```
async fn request_user_input_rejected_in_pair_mode_alias() -> anyhow::Result<()>
```

**Purpose**: This test verifies that request_user_input is not available in Pair Programming mode. The expected behavior is a clear model-facing rejection rather than a user-facing question.

**Data flow**: It builds a Pair Programming collaboration mode with the current model name and passes it to the shared rejection helper. The helper runs the fake model turn and checks the rejection text sent back as function-call output.

**Call relations**: This wrapper delegates the complete scenario to assert_request_user_input_rejected, just as the Execute and Default rejection tests do.

*Call graph*: calls 1 internal fn (assert_request_user_input_rejected).


### `core/tests/suite/review.rs`

`test` · `test run`

The review feature is a bit like asking a second specialist to step into the room, inspect something, then hand a summary back to the main conversation. This test file checks that the handoff works safely. It uses a fake Responses API server, so the tests can control exactly what the model “says” without calling the real network service.

The tests submit `Op::Review`, which is the operation that starts review mode. They then watch for events from the Codex thread: entering review mode, exiting review mode, and completing the turn. They verify that structured JSON from the reviewer becomes a proper `ReviewOutputEvent`, while plain text still becomes a useful fallback review summary. They also check that noisy streaming assistant text is hidden during review, so the user interface sees the clean review result instead of partial fragments.

Other tests focus on boundaries. A review should use `review_model` when configured, otherwise the normal session model. It should start with its own prompt rather than blindly copying old parent chat history, but after it finishes, its useful results should be available to later parent turns. One test also creates a real temporary Git repository to confirm that base-branch review uses the session’s current working directory, including runtime overrides.

#### Function details

##### `review_op_emits_lifecycle_and_review_output`  (lines 41–201)

```
async fn review_op_emits_lifecycle_and_review_output()
```

**Purpose**: This test checks the main happy path for review mode. It proves that a structured JSON review from the model turns into a typed review result, that review mode announces its start and finish in order, and that the result is written back into the session history in a readable form.

**Data flow**: The test starts with a fake model response containing one review finding as JSON. It sends a review request into a test Codex conversation, waits for review lifecycle events, compares the parsed review output against the expected structure, then reads the rollout file on disk to confirm the review was recorded without unwanted XML-style markup. It also inspects the fake server’s captured request to confirm review-specific headers and parent session metadata were sent.

**Call relations**: This is one of the top-level async tests. It builds fake server events with `assistant_message_sse`, mounts them through `start_responses_server_with_sse`, creates a Codex thread with `new_conversation_for_server`, and uses `render_review_output_text` to compare the text that should be saved for later conversation history.

*Call graph*: calls 4 internal fn (render_review_output_text, assistant_message_sse, new_conversation_for_server, start_responses_server_with_sse); 12 external calls (new, new, assert!, assert_eq!, wait_for_event, panic!, from_str, from_value, json!, skip_if_no_network! (+2 more)).


##### `review_op_with_plain_text_emits_review_fallback`  (lines 209–251)

```
async fn review_op_with_plain_text_emits_review_fallback()
```

**Purpose**: This test checks what happens when the reviewer model does not return JSON. Instead of failing or losing the review, Codex should wrap the plain text in a simple review result.

**Data flow**: The input is a fake assistant message saying only `just plain text`. The test submits a review operation, waits for review mode to open and close, and expects the final review output to have that text as its overall explanation with all other review fields left at their default empty values.

**Call relations**: This test uses `assistant_message_sse` to create the fake plain-text model response, `start_responses_server_with_sse` to serve it, and `new_conversation_for_server` to run Codex against that fake server. It then relies on event waiting to observe the review lifecycle.

*Call graph*: calls 3 internal fn (assistant_message_sse, new_conversation_for_server, start_responses_server_with_sse); 7 external calls (new, default, new, assert_eq!, wait_for_event, panic!, skip_if_no_network!).


##### `review_filters_agent_message_related_events`  (lines 259–313)

```
async fn review_filters_agent_message_related_events()
```

**Purpose**: This test makes sure review mode does not leak partial assistant-message streaming events to callers. That matters because review mode has its own result event, and showing raw streaming fragments could confuse the user interface.

**Data flow**: The fake server sends a sequence like a normal streaming assistant answer: message started, text deltas, final assistant message, and completion. The test submits a review request and drains events until the turn finishes. If an assistant text delta appears during review, the test fails immediately; otherwise it confirms review mode still entered and exited.

**Call relations**: This top-level test prepares a custom event list directly, serves it with `start_responses_server_with_sse`, and creates the conversation with `new_conversation_for_server`. It is focused on what events the review flow allows through to the outer Codex thread.

*Call graph*: calls 2 internal fn (new_conversation_for_server, start_responses_server_with_sse); 6 external calls (new, new, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `review_does_not_emit_agent_message_on_structured_output`  (lines 321–389)

```
async fn review_does_not_emit_agent_message_on_structured_output()
```

**Purpose**: This test checks that structured review output is surfaced cleanly. The user interface should get the structured review through the review-exit event and only one final assistant message, not a stream of duplicate assistant messages.

**Data flow**: The test feeds the fake server a JSON review result, submits a review request, and counts `AgentMessage` events until the turn completes. The expected before-and-after is: structured model text goes in, review lifecycle events come out, and exactly one final assistant message is emitted.

**Call relations**: It uses `assistant_message_sse` for the fake structured model reply, `start_responses_server_with_sse` for the mock Responses API, and `new_conversation_for_server` for the test Codex thread. It complements the filtering test by checking the non-streaming final message count.

*Call graph*: calls 3 internal fn (assistant_message_sse, new_conversation_for_server, start_responses_server_with_sse); 7 external calls (new, new, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!).


##### `review_uses_custom_review_model_from_config`  (lines 394–440)

```
async fn review_uses_custom_review_model_from_config()
```

**Purpose**: This test verifies that the review feature honors a special reviewer model setting. If the user configures `review_model`, review requests should use that model instead of the main chat model.

**Data flow**: The test creates a config with a normal model and a different review model, then sends a review request. After the fake server receives the request, the test reads the JSON request body and checks that its `model` field is the configured review model.

**Call relations**: It uses `completed_sse` because the model response content is not important here, only the outgoing request. `start_responses_server_with_sse` records the request, and `new_conversation_for_server` applies the config mutation before the review operation runs.

*Call graph*: calls 3 internal fn (completed_sse, new_conversation_for_server, start_responses_server_with_sse); 5 external calls (new, new, assert_eq!, wait_for_event, skip_if_no_network!).


##### `review_uses_session_model_when_review_model_unset`  (lines 445–488)

```
async fn review_uses_session_model_when_review_model_unset()
```

**Purpose**: This test checks the fallback model choice. When no separate review model is configured, the review request should use the same model as the current session.

**Data flow**: The test configures the session model and leaves `review_model` empty. It submits a review, waits for completion, then examines the request captured by the mock server. The request body should name the session model.

**Call relations**: Like the custom-model test, it uses `completed_sse` because the response details do not matter. It creates the fake API with `start_responses_server_with_sse` and the configured Codex conversation with `new_conversation_for_server`.

*Call graph*: calls 3 internal fn (completed_sse, new_conversation_for_server, start_responses_server_with_sse); 5 external calls (new, new, assert_eq!, wait_for_event, skip_if_no_network!).


##### `review_input_isolated_from_parent_history`  (lines 496–667)

```
async fn review_input_isolated_from_parent_history()
```

**Purpose**: This test makes sure a new review does not automatically include earlier parent chat messages as its own input. That isolation matters because the reviewer should judge the requested target, not be biased or cluttered by unrelated old conversation.

**Data flow**: The test first writes a fake saved conversation file containing earlier user and assistant messages. It resumes Codex from that file, submits a review prompt, and inspects the request sent to the fake model. The request should contain environment context and the raw review prompt, with the review rubric in `instructions`, and the rollout file should also note that the review task was interrupted or recorded in the parent history.

**Call relations**: This is the only test that calls `resume_conversation_for_server`, because it needs a pre-existing session history. It uses `completed_sse` and `start_responses_server_with_sse` for a minimal fake response, then checks both the outgoing model request and the saved rollout records.

*Call graph*: calls 3 internal fn (completed_sse, resume_conversation_for_server, start_responses_server_with_sse); 15 external calls (new, new, new_v4, assert!, assert_eq!, wait_for_event, format!, from_str, from_value, json! (+5 more)).


##### `review_history_surfaces_in_parent_session`  (lines 672–765)

```
async fn review_history_surfaces_in_parent_session()
```

**Purpose**: This test checks the other side of history isolation: after review finishes, its useful summary should be visible to later parent conversation turns. Without this, the main assistant could not refer back to the review results.

**Data flow**: The test runs one review turn whose fake assistant output is `review assistant output`. Then it sends a normal user follow-up in the parent session. It inspects the second model request and expects to see the follow-up as the newest user message, plus saved review-related messages from the completed review.

**Call relations**: It creates a two-request fake server using `assistant_message_sse` and `start_responses_server_with_sse`, then starts a fresh conversation with `new_conversation_for_server`. The first request exercises review mode; the second request proves the parent flow can see the review’s recorded output.

*Call graph*: calls 3 internal fn (assistant_message_sse, new_conversation_for_server, start_responses_server_with_sse); 8 external calls (new, default, new, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `review_uses_overridden_cwd_for_base_branch_merge_base`  (lines 770–867)

```
async fn review_uses_overridden_cwd_for_base_branch_merge_base()
```

**Purpose**: This test verifies that base-branch review uses the session’s current working directory, including runtime overrides. This matters because Git comparisons depend on which repository Codex is operating in.

**Data flow**: The test creates a temporary Git repository, commits a file, and records the commit SHA. It starts Codex with one initial working directory, then applies thread settings that point to the Git repository. When it submits a base-branch review for `main`, the outgoing review prompt should include the merge-base SHA from the overridden repository path.

**Call relations**: This test uses `local_selections` to create the runtime environment override, `completed_sse` for a minimal fake model completion, `start_responses_server_with_sse` to capture the request, and `new_conversation_for_server` to start Codex with a configurable initial directory.

*Call graph*: calls 4 internal fn (local_selections, completed_sse, new_conversation_for_server, start_responses_server_with_sse); 11 external calls (new, default, from_utf8, new, assert!, assert_eq!, new, submit_thread_settings, wait_for_event, skip_if_no_network! (+1 more)).


##### `assistant_message_sse`  (lines 869–874)

```
fn assistant_message_sse(text: &str) -> Vec<serde_json::Value>
```

**Purpose**: This helper builds a small fake server-sent event sequence for a completed assistant message. Server-sent events are streamed messages from the server; here they are represented as JSON values for the mock API.

**Data flow**: It takes a text string as input. It wraps that text as an assistant message event, adds a completion event after it, and returns the two events as a list.

**Call relations**: Several review tests call this helper when they need the fake model to return actual assistant text. The resulting event list is usually handed to `start_responses_server_with_sse`, which serves it through the mock Responses API.

*Call graph*: called by 4 (review_does_not_emit_agent_message_on_structured_output, review_history_surfaces_in_parent_session, review_op_emits_lifecycle_and_review_output, review_op_with_plain_text_emits_review_fallback); 1 external calls (vec!).


##### `completed_sse`  (lines 876–878)

```
fn completed_sse() -> Vec<serde_json::Value>
```

**Purpose**: This helper builds the smallest fake streaming response: only a completion event. Tests use it when they care about the outgoing request rather than the model’s answer.

**Data flow**: It takes no input. It returns a one-item list containing a fake completed-response event.

**Call relations**: Model-selection, history-isolation, and working-directory tests call this helper because they only need Codex to finish the turn. The returned event list is passed into `start_responses_server_with_sse`.

*Call graph*: called by 4 (review_input_isolated_from_parent_history, review_uses_custom_review_model_from_config, review_uses_overridden_cwd_for_base_branch_merge_base, review_uses_session_model_when_review_model_unset); 1 external calls (vec!).


##### `start_responses_server_with_sse`  (lines 881–890)

```
async fn start_responses_server_with_sse(
    events: Vec<serde_json::Value>,
    expected_requests: usize,
) -> (MockServer, ResponseMock)
```

**Purpose**: This helper starts a fake Responses API server and teaches it what streaming responses to return. It also gives tests a request log so they can inspect what Codex sent.

**Data flow**: It receives a list of fake server-sent events and the number of expected requests. It starts a mock server, converts the events into an SSE response body, repeats that response for the expected number of calls, mounts the sequence on the server, and returns both the server and its request recorder.

**Call relations**: Almost every test in this file calls this helper before creating a Codex conversation. It hides the setup details of `start_mock_server`, `responses::sse`, and `mount_sse_sequence` so each test can focus on the review behavior it is checking.

*Call graph*: calls 3 internal fn (mount_sse_sequence, sse, start_mock_server); called by 9 (review_does_not_emit_agent_message_on_structured_output, review_filters_agent_message_related_events, review_history_surfaces_in_parent_session, review_input_isolated_from_parent_history, review_op_emits_lifecycle_and_review_output, review_op_with_plain_text_emits_review_fallback, review_uses_custom_review_model_from_config, review_uses_overridden_cwd_for_base_branch_merge_base, review_uses_session_model_when_review_model_unset); 1 external calls (vec!).


##### `new_conversation_for_server`  (lines 893–913)

```
async fn new_conversation_for_server(
    server: &MockServer,
    codex_home: Arc<TempDir>,
    mutator: F,
) -> Arc<CodexThread>
```

**Purpose**: This helper creates a fresh Codex conversation that talks to the fake server instead of the real API. Tests can also tweak the configuration before the conversation starts.

**Data flow**: It receives the mock server, a temporary Codex home directory, and a configuration-changing function. It builds a base URL from the server address, sets that as the model provider endpoint, applies the caller’s config changes, starts the test Codex thread, and returns the thread handle.

**Call relations**: Most tests call this after setting up the fake server. It delegates to `test_codex` for the actual test harness construction, while the caller supplies only the review-specific configuration changes.

*Call graph*: calls 1 internal fn (test_codex); called by 8 (review_does_not_emit_agent_message_on_structured_output, review_filters_agent_message_related_events, review_history_surfaces_in_parent_session, review_op_emits_lifecycle_and_review_output, review_op_with_plain_text_emits_review_fallback, review_uses_custom_review_model_from_config, review_uses_overridden_cwd_for_base_branch_merge_base, review_uses_session_model_when_review_model_unset); 1 external calls (format!).


##### `resume_conversation_for_server`  (lines 916–937)

```
async fn resume_conversation_for_server(
    server: &MockServer,
    codex_home: Arc<TempDir>,
    resume_path: std::path::PathBuf,
    mutator: F,
) -> Arc<CodexThread>
```

**Purpose**: This helper creates a Codex conversation by resuming from an existing rollout file, while still pointing network calls at the fake server. It is used when a test needs old session history to exist before review starts.

**Data flow**: It receives the mock server, temporary Codex home, a saved-session path, and a config mutator. It sets the mock server as the model provider endpoint, applies any config changes, resumes the conversation from the given rollout file, and returns the Codex thread.

**Call relations**: The parent-history isolation test calls this helper after writing a fake session file. Internally it uses the same `test_codex` harness idea as `new_conversation_for_server`, but chooses the resume path instead of starting from an empty conversation.

*Call graph*: calls 1 internal fn (test_codex); called by 1 (review_input_isolated_from_parent_history); 1 external calls (format!).


### `core/tests/suite/guardian_review.rs`

`test` · `integration test run`

This test protects a privacy and correctness boundary. Codex can be configured to run a notification script after a turn, and it can also ask a separate Guardian reviewer to approve risky actions, such as running a command with extra permissions. Those are two different conversations. The final user-facing notification should describe the normal user session, not include the hidden Guardian review prompt or transcript.

The test sets up a fake server that pretends to be the model service. It then creates a temporary shell script to act as the legacy notification command. That script simply writes the notification payload it receives into a file, like leaving a receipt in a mailbox.

Next, the test starts Codex with that notification script enabled, with approvals required on request, and with a sandbox policy that normally restricts command execution. It sends a user request that causes the mocked model to ask Codex to run a command needing escalated permission. The fake server then provides a Guardian review response saying the command is allowed, followed by a normal assistant response of “done.”

After the turn finishes, the test checks three important things: the Guardian review request really included the command and justification; the notification file contains only one payload for the normal user turn; and that payload does not contain the Guardian review transcript. Finally, it confirms the approved command actually wrote the expected marker file.

#### Function details

##### `guardian_review_session_does_not_inherit_legacy_notify`  (lines 34–170)

```
async fn guardian_review_session_does_not_inherit_legacy_notify() -> Result<()>
```

**Purpose**: This test verifies that Guardian auto-review stays separate from the legacy notification system. Someone would use it to catch regressions where an internal approval conversation is accidentally included in the notification payload sent to a configured script.

**Data flow**: The test starts by skipping environments where the scenario cannot run, then creates a mock model server, a temporary notification script, and a Codex test instance with approval and sandbox settings. It feeds Codex a user request and pre-arranged mock server responses: first a tool call needing approval, then a Guardian approval message, then a final assistant message. After Codex finishes, it reads the mock server’s recorded requests, the notification output file, and the command’s marker file. The expected result is that the Guardian request contains the command details, the notification payload contains only the normal user-facing conversation, and the command output file says the approved command ran.

**Call relations**: This is the top-level test case. It calls the test support helpers to start the fake server, build a Codex instance, choose local environment settings, and mount a sequence of fake streaming responses. During the simulated turn, Codex talks to the mock server, runs the Guardian review path, executes the approved command, and invokes the notification script. The test then gathers those outputs and uses assertions to prove the pieces stayed in the right lanes.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex); 18 external calls (default, from_millis, from_secs, new, assert!, assert_eq!, from_mode, wait_for_event, format!, set_permissions (+8 more)).


### `core/tests/suite/mcp_turn_metadata.rs`

`test` · `test run`

These are end-to-end style tests for a subtle part of Codex’s app-tool flow. In this system, the model can call an external app tool, such as a calendar tool. Some tool calls may need approval before they run. The important question tested here is: if the turn already involved asking the user something, does Codex remember that and attach the right note to the later tool call?

The file builds a small fake world: a mock model server sends scripted responses, and a fake apps server records what tool calls it receives. The tests then submit a user message, wait for Codex events, answer approval or user-input prompts when needed, and finally inspect the recorded app call.

Two helper functions edit the test configuration so the calendar app uses a chosen approval style, and another helper submits a complete user turn with the permission and collaboration settings the tests need.

The tests cover three cases. One checks that a user approval prompt before a calendar call causes metadata saying user input was requested during the turn. Another checks that a default app reviewer setting can route approval to an automatic “Guardian” review instead of the user. The last checks the same metadata when the model explicitly uses a request-user-input tool before calling the calendar app.

#### Function details

##### `set_calendar_approval_mode`  (lines 44–61)

```
fn set_calendar_approval_mode(config: &mut Config, approval_mode: AppToolApproval)
```

**Purpose**: This helper changes the test configuration so the calendar app uses a specific default approval mode for its tools. It lets each test say whether calendar tool calls should run automatically, ask for a prompt, or be treated as pre-approved.

**Data flow**: It receives a mutable test Config and an AppToolApproval value. It turns that approval value into the text that would appear in a user config file, builds a small TOML config snippet for the calendar app, parses it, and adds it to the config layer stack. After it runs, the same Config object contains a calendar-specific approval setting.

**Call relations**: The test setup uses this helper when it only needs to control the calendar app’s approval behavior. In this file, the request-user-input metadata test uses it before building the TestCodex instance, so the later submitted turn runs with calendar tool calls approved according to that setting.

*Call graph*: 2 external calls (format!, from_str).


##### `set_calendar_approval_mode_and_default_reviewer`  (lines 63–87)

```
fn set_calendar_approval_mode_and_default_reviewer(
    config: &mut Config,
    approval_mode: AppToolApproval,
    default_approvals_reviewer: ApprovalsReviewer,
)
```

**Purpose**: This helper changes two pieces of test configuration at once: the calendar app’s tool approval mode and the default reviewer for app approvals. It is used to prove that app-specific default reviewer settings override the global reviewer setting.

**Data flow**: It receives a mutable Config, an approval mode, and a default approval reviewer. It converts the approval mode to config text, writes a TOML snippet with an apps-wide default reviewer plus a calendar approval mode, parses that snippet, and inserts it into the config layer stack. The Config is changed in place so later test setup sees these app approval rules.

**Call relations**: The approval-routing tests call this during builder configuration. One test sets the app default reviewer to the user, and another sets it to automatic review, so the later tool-call approval follows the app default rather than the intentionally opposite global setting.

*Call graph*: 2 external calls (format!, from_str).


##### `submit_user_turn`  (lines 89–127)

```
async fn submit_user_turn(
    test: &TestCodex,
    text: &str,
    approval_policy: AskForApproval,
    collaboration_mode: Option<CollaborationMode>,
) -> Result<()>
```

**Purpose**: This helper sends a user message into a TestCodex session with the permission, sandbox, environment, approval, and collaboration settings needed by these tests. It hides the noisy setup so each test can focus on the behavior being checked.

**Data flow**: It receives the TestCodex test harness, the user’s text, an approval policy, and an optional collaboration mode. It reads the current model from the session, builds local environment selections, creates permission fields with sandboxing disabled, wraps the text as user input, and submits it to Codex. If the submit succeeds, it returns success; if Codex rejects the operation, the error is returned.

**Call relations**: All three async tests call this after they finish configuring mock servers and building the test harness. It is the point where the scripted scenario actually starts: after this function submits the user turn, the tests wait for Codex events such as tool-call starts, approval prompts, user-input requests, and turn completion.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 3 (approved_mcp_tool_call_metadata_records_prior_user_input_request, apps_default_auto_review_routes_actual_mcp_approval_to_guardian, mcp_tool_call_metadata_records_prior_request_user_input_tool); 2 external calls (default, vec!).


##### `approved_mcp_tool_call_metadata_records_prior_user_input_request`  (lines 130–231)

```
async fn approved_mcp_tool_call_metadata_records_prior_user_input_request() -> Result<()>
```

**Purpose**: This test verifies that when a calendar app tool call needs user approval, and the user approves it, the actual app call records that user input was requested during the turn. Without this, downstream app tooling would miss an important part of the turn’s history.

**Data flow**: The test creates a fake model response that first asks to call the calendar create-event tool and then later says it is done. It configures the calendar app to prompt for approval and to route that approval to the user. After submitting the user turn, it waits for the calendar tool-call event, waits for the approval request, accepts it, waits for the turn to finish, and then reads the tool call captured by the fake apps server. The expected result is that the recorded call has metadata marking user_input_requested_during_turn as true.

**Call relations**: This test uses the mock server helpers to stage model output, the apps test server to record the calendar call, set_calendar_approval_mode_and_default_reviewer to force user approval routing, and submit_user_turn to start the scenario. It then drives the approval flow by sending ResolveElicitation back into Codex before checking the final recorded app request.

*Call graph*: calls 6 internal fn (mount, recorded_apps_tool_call_by_call_id, search_capable_apps_builder, mount_sse_sequence, start_mock_server, submit_user_turn); 8 external calls (assert_eq!, wait_for_event, json!, panic!, to_string, skip_if_no_network!, unreachable!, vec!).


##### `apps_default_auto_review_routes_actual_mcp_approval_to_guardian`  (lines 234–335)

```
async fn apps_default_auto_review_routes_actual_mcp_approval_to_guardian() -> Result<()>
```

**Purpose**: This test checks that an app-level default reviewer setting can send an approval decision to the automatic Guardian reviewer instead of asking the user. Guardian here means a model-based safety reviewer that judges whether a planned action should be allowed.

**Data flow**: The test scripts three fake model interactions: the main model asks to create a calendar event, the Guardian reviewer returns an allow decision, and the main model then finishes. It configures the global reviewer one way but sets the apps default reviewer to automatic review. After submitting the turn, it expects not to receive a user approval prompt; instead, the turn continues through Guardian review. It then inspects the fake model requests to confirm a Guardian request was made and inspects the fake apps server to confirm the calendar event tool call ran with the expected title.

**Call relations**: This test depends on set_calendar_approval_mode_and_default_reviewer to create the routing condition it cares about, and on submit_user_turn to begin the run. The scripted response sequence stands in for both the parent model and the Guardian review. The final checks connect those pieces: no user-facing elicitation event appears, a Guardian prompt is found, and the calendar app receives the approved call.

*Call graph*: calls 6 internal fn (mount, recorded_apps_tool_call_by_call_id, search_capable_apps_builder, mount_sse_sequence, start_mock_server, submit_user_turn); 7 external calls (assert!, assert_eq!, wait_for_event, json!, to_string, skip_if_no_network!, vec!).


##### `mcp_tool_call_metadata_records_prior_request_user_input_tool`  (lines 338–461)

```
async fn mcp_tool_call_metadata_records_prior_request_user_input_tool() -> Result<()>
```

**Purpose**: This test verifies that if the model uses the request-user-input tool earlier in a turn, a later calendar app tool call includes metadata saying user input was requested during that same turn. It covers the explicit user-question path, not just approval prompts.

**Data flow**: The test scripts the model to first call request_user_input, then call the calendar create-event tool, and finally finish. It configures calendar app calls as approved so the calendar call itself does not need a separate approval prompt. After submitting a planning-mode turn, it waits for the user-input request, sends back a selected answer, waits for the calendar tool call and turn completion, and then reads the recorded calendar app request. The expected output is a recorded app call whose metadata includes user_input_requested_during_turn set to true.

**Call relations**: This test uses set_calendar_approval_mode to keep the calendar call from being blocked by approval, and submit_user_turn to start the scripted turn. It then plays the role of the user by answering the RequestUserInput event. Once Codex proceeds to the app call, the fake apps server provides the evidence that the earlier user-input request was remembered and attached to the later MCP tool call.

*Call graph*: calls 6 internal fn (mount, recorded_apps_tool_call_by_call_id, search_capable_apps_builder, mount_sse_sequence, start_mock_server, submit_user_turn); 9 external calls (from, assert_eq!, wait_for_event, wait_for_event_match, json!, to_string, skip_if_no_network!, unreachable!, vec!).


### Hook interception and notifications
These suites verify lifecycle hooks around prompts and tool execution, including MCP-specific interception and final user-facing notification delivery.

### `core/tests/suite/hooks.rs`

`test` · `test execution`

Hooks are like checkpoint guards around a Codex conversation. A hook can run when a session starts, when the user submits a prompt, before a tool runs, after a tool finishes, when permission is needed, or when the assistant is about to stop. This test file builds many fake Codex sessions, fake model responses, and temporary hook scripts to prove those checkpoints behave correctly. It writes small Python hook programs into temporary home directories, marks those hooks as trusted, starts mock model servers, then submits turns and inspects what happened. The tests cover blocking prompts, retrying after stop hooks, adding extra developer context, spilling very large hook output to files, approving permission requests, changing tool inputs before execution, hiding tool results after execution, and plugin-supplied hooks. They also check details that matter for safety and history: blocked commands must not run, rewritten commands must replace originals, hook logs must contain the right tool and turn identifiers, and resumed or compacted conversations must preserve hook-supplied context. Without tests like these, hook behavior could silently regress, which would be risky because hooks sit directly on the boundary between model decisions, user policy, local tools, and external scripts.

#### Function details

##### `restrictive_workspace_write_profile`  (lines 62–69)

```
fn restrictive_workspace_write_profile() -> PermissionProfile
```

**Purpose**: Creates a strict permission profile for tests where writing is limited to the workspace and network access is restricted. Tests use it to force Codex to ask for approval when a tool tries to write outside allowed places.

**Data flow**: It takes no input. It builds a workspace-write permission profile with restricted network rules and extra exclusions for temporary directories, then returns that profile to the caller.

**Call relations**: The apply-patch permission test calls this when it wants a patch operation to need approval. The helper delegates the actual profile construction to the shared permission-profile builder.

*Call graph*: calls 1 internal fn (workspace_write_with); called by 1 (permission_request_hook_allows_apply_patch_with_write_alias).


##### `network_workspace_write_profile`  (lines 71–78)

```
fn network_workspace_write_profile() -> PermissionProfile
```

**Purpose**: Creates a permission profile for tests where workspace writing is allowed and network access is enabled. It is used when a test needs Codex to exercise network approval behavior.

**Data flow**: It takes no input. It asks the shared permission-profile builder for a workspace-write setup with network access turned on and temporary-directory exclusions disabled, then returns the profile.

**Call relations**: The network permission-request test calls this before submitting a turn. The returned profile becomes part of the test session's permission setup.

*Call graph*: calls 1 internal fn (workspace_write_with); called by 1 (permission_request_hook_allows_network_approval_without_prompt).


##### `code_mode_custom_tool_output_text`  (lines 80–95)

```
fn code_mode_custom_tool_output_text(output_item: &Value) -> String
```

**Purpose**: Extracts readable text from a code-mode custom tool output, even though that output may be stored in several JSON shapes. This lets tests compare what the code-mode tool actually saw.

**Data flow**: It receives a JSON output item. It looks for an output field that may be a string, a list of text spans, or an object with content, converts that to one string, and returns it. If the shape is unexpected, it fails the test.

**Call relations**: Code-mode tests call this after a mocked model uses a custom tool. It turns the raw output record into plain text so the tests can check whether a hook blocked, rewrote, or hid a tool result.

*Call graph*: called by 3 (assert_post_tool_use_blocks_code_mode_tool_result, pre_tool_use_block_rejects_code_mode_tool_promise_before_execution, pre_tool_use_rewrites_code_mode_nested_exec_command_before_execution); 2 external calls (get, panic!).


##### `non_openai_model_provider`  (lines 97–104)

```
fn non_openai_model_provider(server: &wiremock::MockServer) -> ModelProviderInfo
```

**Purpose**: Builds a test model-provider configuration that talks to the mock server but is treated as a non-websocket provider. This is useful for tests that need a predictable HTTP-style provider setup.

**Data flow**: It receives the mock server. It copies the built-in OpenAI provider settings, changes the name and base URL to point at the mock server, disables websocket support, and returns the modified provider.

**Call relations**: The compact-session hook test uses this provider so the fake model requests go to the test server while still exercising the provider configuration path.

*Call graph*: called by 1 (compact_session_start_hook_records_additional_context_for_next_turn); 2 external calls (built_in_model_providers, format!).


##### `trust_plugin_hooks`  (lines 106–122)

```
fn trust_plugin_hooks(config: &mut Config, plugin_hook_sources: Vec<PluginHookSource>)
```

**Purpose**: Enables hook support for plugin hooks and marks the discovered plugin hooks as trusted for the test. This avoids interactive trust prompts and lets the test focus on hook behavior.

**Data flow**: It receives a mutable test configuration and plugin hook sources. It turns on the hooks feature, asks the hook system to list hooks from those sources, checks that at least one hook was found, and records those hooks as trusted in the config.

**Call relations**: Plugin-hook setup uses this helper before building the test Codex instance. It bridges plugin hook discovery and the generic test support helper that trusts hooks.

*Call graph*: calls 1 internal fn (trust_hooks); 3 external calls (assert!, list_hooks, default).


##### `write_stop_hook`  (lines 124–169)

```
fn write_stop_hook(home: &Path, block_prompts: &[&str]) -> Result<()>
```

**Purpose**: Writes a temporary Stop hook script and hooks.json file for tests. The generated hook can block one or more assistant completions and ask Codex to retry with specific continuation prompts.

**Data flow**: It receives a temporary home directory and a list of prompts. It writes a Python script that logs each hook input, blocks while prompts remain, and otherwise allows the stop. It also writes hooks.json pointing Codex at that script.

**Call relations**: Stop-hook tests install this fixture before building Codex. Later, those tests read the hook log and inspect model requests to confirm the continuation prompts were preserved.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_parallel_stop_hooks`  (lines 171–211)

```
fn write_parallel_stop_hooks(home: &Path, prompts: &[&str]) -> Result<()>
```

**Purpose**: Creates several Stop hooks that can all block the same stop event. This tests how Codex combines multiple continuation prompts from multiple hooks.

**Data flow**: It receives a home directory and prompts. For each prompt it writes a separate Python hook script, then writes one hooks.json file that lists all those scripts under the Stop event.

**Call relations**: The multiple-blocking-stop-hooks test installs these scripts and then checks that the next model request and rollout history contain all hook prompt fragments in order.

*Call graph*: 3 external calls (join, write, json!).


##### `write_user_prompt_submit_hook`  (lines 213–260)

```
fn write_user_prompt_submit_hook(
    home: &Path,
    blocked_prompt: &str,
    additional_context: &str,
) -> Result<()>
```

**Purpose**: Writes a UserPromptSubmit hook that can block one specific user prompt and attach extra context for the next turn. This lets tests verify that blocked user text is not sent to the model.

**Data flow**: It receives a home directory, the prompt to block, and extra context text. It writes a Python script that logs every input and, when the prompt matches, returns a block decision plus hook-specific additional context. It also writes hooks.json for the event.

**Call relations**: User-prompt tests install this fixture before submitting accepted and blocked prompts. They later read the log and inspect model requests to ensure only accepted prompts move forward.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_session_start_and_user_prompt_submit_order_hooks`  (lines 262–320)

```
fn write_session_start_and_user_prompt_submit_order_hooks(home: &Path) -> Result<()>
```

**Purpose**: Writes two hooks that record when SessionStart and UserPromptSubmit run. It is used to prove the first session-start hook happens before the first prompt-submit hook.

**Data flow**: It receives a home directory. It writes two Python scripts that append small JSON records to the same log file, then writes hooks.json registering one script for each event.

**Call relations**: The hook-order test installs these scripts, submits one turn, then reads the shared log to verify the observed order.

*Call graph*: 4 external calls (join, format!, write, json!).


##### `write_pre_tool_use_hook`  (lines 322–399)

```
fn write_pre_tool_use_hook(
    home: &Path,
    matcher: Option<&str>,
    mode: &str,
    reason: &str,
) -> Result<()>
```

**Purpose**: Writes a configurable PreToolUse hook, which runs before a tool executes. The generated hook can deny a tool, add context, return both, or fail with exit code 2 to simulate hook feedback.

**Data flow**: It receives a home directory, an optional matcher, a mode, and a reason or context string. It writes a Python script that logs the incoming hook payload and prints a JSON response based on the chosen mode, then writes hooks.json for PreToolUse.

**Call relations**: Many tests install this fixture before asking the model to call tools. The resulting hook output decides whether the test command runs, is blocked, or adds information to the next model request.

*Call graph*: 6 external calls (join, String, format!, write, json!, to_string).


##### `write_updating_pre_tool_use_hook`  (lines 401–447)

```
fn write_updating_pre_tool_use_hook(
    home: &Path,
    matcher: &str,
    updated_input: &Value,
) -> Result<()>
```

**Purpose**: Writes a PreToolUse hook that allows a tool call but replaces its input first. This tests hook-based rewriting, such as changing a shell command or patch before it runs.

**Data flow**: It receives a home directory, a matcher, and the replacement input as JSON. It writes a Python script that logs the original input and prints an allow decision containing updatedInput, then registers it in hooks.json.

**Call relations**: Rewrite tests use this fixture before tool execution. They then verify that the original action did not happen, the rewritten action did happen, and the hook log still captured the original request.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_pre_tool_use_hook_toml`  (lines 449–515)

```
fn write_pre_tool_use_hook_toml(
    home: &Path,
    script_name: &str,
    log_name: &str,
    matcher: Option<&str>,
    mode: &str,
    reason: &str,
) -> Result<()>
```

**Purpose**: Writes a PreToolUse hook using config.toml instead of hooks.json. This checks that hooks defined in the main configuration file work like hooks defined in a separate hooks file.

**Data flow**: It receives file names, an optional matcher, a mode, and a reason. It writes a Python hook script, then writes a config.toml that enables hooks and registers that script.

**Call relations**: Configuration-source tests install this fixture to verify config.toml hooks can block tools and can coexist with hooks.json hooks.

*Call graph*: 4 external calls (join, format!, write, to_string).


##### `write_permission_request_hook`  (lines 517–588)

```
fn write_permission_request_hook(
    home: &Path,
    matcher: Option<&str>,
    mode: &str,
    reason: &str,
) -> Result<()>
```

**Purpose**: Writes a PermissionRequest hook, which can approve or deny a permission request before Codex asks the user. This lets tests check policy automation around risky actions.

**Data flow**: It receives a home directory, optional matcher, mode, and reason. It writes a Python script that logs the permission request and prints an allow or deny decision, or exits with feedback. It then writes hooks.json for PermissionRequest.

**Call relations**: The allow-permission helper calls this with the standard Bash matcher. Permission-request tests use the generated hook to bypass or inspect approval flows.

*Call graph*: called by 1 (install_allow_permission_request_hook); 6 external calls (join, String, format!, write, json!, to_string).


##### `install_allow_permission_request_hook`  (lines 590–597)

```
fn install_allow_permission_request_hook(home: &Path) -> Result<()>
```

**Purpose**: Installs the common permission-request fixture that automatically allows Bash permission requests. It keeps repeated tests from spelling out the same setup.

**Data flow**: It receives a home directory. It calls the lower-level writer with the standard Bash matcher, allow mode, and a placeholder reason, then returns that result.

**Call relations**: Several permission-request tests use this helper during test setup. It hands off the actual file writing to write_permission_request_hook.

*Call graph*: calls 1 internal fn (write_permission_request_hook).


##### `write_post_tool_use_hook`  (lines 599–669)

```
fn write_post_tool_use_hook(
    home: &Path,
    matcher: Option<&str>,
    mode: &str,
    reason: &str,
) -> Result<()>
```

**Purpose**: Writes a PostToolUse hook, which runs after a tool has produced a result. The generated hook can add context, replace the result with a reason, stop continuation, or fail with feedback.

**Data flow**: It receives a home directory, optional matcher, mode, and reason or context. It writes a Python script that logs the tool input and response, prints behavior based on the mode, and registers the hook in hooks.json.

**Call relations**: Post-tool tests install this fixture before triggering shell, exec, or apply_patch tool calls. They then inspect the next model request and hook log to confirm the post-tool effect.

*Call graph*: 6 external calls (join, String, format!, write, json!, to_string).


##### `write_logging_pre_and_blocking_post_tool_use_hooks`  (lines 671–727)

```
fn write_logging_pre_and_blocking_post_tool_use_hooks(home: &Path, feedback: &str) -> Result<()>
```

**Purpose**: Writes a pair of hooks: one PreToolUse hook that only logs and one PostToolUse hook that blocks the final result. It is designed for tests of long-running exec sessions.

**Data flow**: It receives a home directory and feedback text. It writes two Python scripts and a hooks.json file. The pre hook records the starting command; the post hook records the completed output, writes feedback to stderr, and exits with code 2.

**Call relations**: The exec-session completion test uses these hooks to confirm the post hook runs only after the session has finished and can replace the result returned to the model.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_session_start_hook_recording_transcript`  (lines 729–764)

```
fn write_session_start_hook_recording_transcript(home: &Path) -> Result<()>
```

**Purpose**: Writes a SessionStart hook that records whether the transcript file path exists. This proves Codex has created the transcript before running startup hooks.

**Data flow**: It receives a home directory. It writes a Python script that reads transcript_path from stdin, checks whether that file exists, logs the result, and registers the script in hooks.json.

**Call relations**: The transcript-path test installs this fixture, submits a turn, and reads the log to verify the hook saw a real transcript file.

*Call graph*: 4 external calls (join, format!, write, json!).


##### `write_session_start_hook_with_context`  (lines 766–796)

```
fn write_session_start_hook_with_context(home: &Path, additional_context: &str) -> Result<()>
```

**Purpose**: Writes a SessionStart hook that returns additional developer context. This checks that startup hook context is included in the next model request.

**Data flow**: It receives a home directory and context text. It writes a Python script that prints hook-specific additionalContext and writes hooks.json to register it.

**Call relations**: The large session-start context test installs this fixture, then checks whether Codex includes the context directly or spills it to a file when it is too large.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_compact_session_start_hook_with_context`  (lines 798–840)

```
fn write_compact_session_start_hook_with_context(
    home: &Path,
    additional_context: &str,
) -> Result<()>
```

**Purpose**: Writes a SessionStart hook that only matches compacted sessions and adds context after compaction. This tests that compact-specific startup hooks do not run at ordinary startup.

**Data flow**: It receives a home directory and context text. It writes a Python script that logs the hook input, returns additional context, and writes hooks.json with a SessionStart matcher of compact.

**Call relations**: The compact-session test installs this fixture, triggers compaction, and verifies the hook context appears on the next turn rather than the initial turn.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_resume_and_compact_session_start_hook_with_context`  (lines 842–899)

```
fn write_resume_and_compact_session_start_hook_with_context(
    home: &Path,
    resume_context: &str,
    compact_context: &str,
) -> Result<()>
```

**Purpose**: Writes SessionStart hooks for both resume and compact sources. It lets tests prove both kinds of session-start context are carried into a resumed conversation that also auto-compacts.

**Data flow**: It receives a home directory plus separate resume and compact context strings. It writes one Python script that chooses context based on the hook payload source, then registers that script twice with different matchers.

**Call relations**: The resume-plus-compact test installs this fixture before the initial run. After resuming, it reads logs and model requests to confirm both matched hooks ran.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `rollout_hook_prompt_texts`  (lines 901–922)

```
fn rollout_hook_prompt_texts(text: &str) -> Result<Vec<String>>
```

**Purpose**: Extracts hook-generated prompt fragments from a rollout transcript. A rollout is the saved conversation history, one JSON line at a time.

**Data flow**: It receives rollout text. It parses each non-empty line as a rollout record, looks for user message input text, extracts hook prompt fragments, and returns their plain text in order.

**Call relations**: Stop-hook tests use this after reading the saved rollout file. It confirms that continuation prompts from hooks were persisted, not just sent once.

*Call graph*: calls 1 internal fn (parse_hook_prompt_fragment); called by 1 (stop_hook_can_block_multiple_times_in_same_turn); 2 external calls (new, from_str).


##### `request_hook_prompt_texts`  (lines 924–932)

```
fn request_hook_prompt_texts(
    request: &core_test_support::responses::ResponsesRequest,
) -> Vec<String>
```

**Purpose**: Extracts hook-generated prompt fragments from a model request. This is the request-side version of the rollout extractor.

**Data flow**: It receives a captured test request. It collects user input texts from the request, keeps only those that parse as hook prompt fragments, and returns the fragment text.

**Call relations**: Stop-hook tests call this on captured mock-server requests to verify retry prompts are included in the next model call.

*Call graph*: calls 1 internal fn (message_input_texts); called by 1 (stop_hook_spills_large_continuation_prompt).


##### `spilled_hook_output_path`  (lines 934–937)

```
fn spilled_hook_output_path(text: &str) -> Option<&str>
```

**Purpose**: Finds the file path mentioned in a message that says large hook output was saved to disk. This is used when hook text is too big to include directly.

**Data flow**: It receives text. It scans each line for the fixed prefix 'Full hook output saved to: ' and returns the path after that prefix if present.

**Call relations**: Large-output tests use this after inspecting model-visible text. They then read the referenced file to confirm the full hook output was preserved.

*Call graph*: called by 4 (post_tool_use_spills_large_feedback_message, pre_tool_use_hook_spills_large_additional_context, session_start_hook_spills_large_additional_context, stop_hook_spills_large_continuation_prompt).


##### `read_stop_hook_inputs`  (lines 939–946)

```
fn read_stop_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the JSON log written by the Stop hook fixture. This lets tests inspect exactly what Codex sent to Stop hooks.

**Data flow**: It receives the test home directory. It reads stop_hook_log.jsonl, parses each non-empty line as JSON, and returns the list of hook input records.

**Call relations**: The multiple-stop-blocks test calls this after a turn finishes to check turn IDs and stop_hook_active values.

*Call graph*: called by 1 (stop_hook_can_block_multiple_times_in_same_turn); 2 external calls (join, read_to_string).


##### `read_pre_tool_use_hook_inputs`  (lines 948–950)

```
fn read_pre_tool_use_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the standard PreToolUse hook log from the test home. It gives tests a structured view of pre-tool hook payloads.

**Data flow**: It receives the home directory, points to pre_tool_use_hook_log.jsonl, and delegates parsing to the shared log reader. The output is a list of JSON records.

**Call relations**: Many pre-tool tests call this after tool execution or blocking. It relies on read_hook_inputs_from_log for the common file parsing work.

*Call graph*: calls 1 internal fn (read_hook_inputs_from_log); called by 12 (assert_pre_tool_use_rewrites_bash_surface, post_tool_use_blocks_when_exec_session_completes_via_write_stdin, pre_tool_use_block_rejects_code_mode_tool_promise_before_execution, pre_tool_use_blocks_apply_patch_before_execution, pre_tool_use_blocks_apply_patch_with_write_alias, pre_tool_use_blocks_exec_command_before_execution, pre_tool_use_blocks_local_function_tool_before_execution, pre_tool_use_blocks_shell_command_before_execution, pre_tool_use_merges_hooks_json_and_config_toml, pre_tool_use_rewrites_apply_patch_before_execution (+2 more)); 1 external calls (join).


##### `read_permission_request_hook_inputs`  (lines 952–959)

```
fn read_permission_request_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the PermissionRequest hook log. Tests use it to check what information a permission hook received before approval was granted or denied.

**Data flow**: It receives a home directory. It reads permission_request_hook_log.jsonl, skips blank lines, parses each line as JSON, and returns the records.

**Call relations**: The single-permission-request assertion helper calls this, then validates the one expected hook payload.

*Call graph*: called by 1 (assert_single_permission_request_hook_input_for_tool); 2 external calls (join, read_to_string).


##### `assert_permission_request_hook_input`  (lines 961–980)

```
fn assert_permission_request_hook_input(
    hook_input: &Value,
    tool_name: &str,
    command: &str,
    description: Option<&str>,
)
```

**Purpose**: Checks that one PermissionRequest hook input has the expected basic shape. It protects tests from accidentally accepting extra or missing permission fields.

**Data flow**: It receives a hook input JSON value, expected tool name, command, and optional description. It compares those fields and asserts that unrelated approval or network fields are absent.

**Call relations**: The single-permission-request helper calls this after reading a log entry. It is the common validator used by permission-request tests.

*Call graph*: called by 1 (assert_single_permission_request_hook_input_for_tool); 2 external calls (assert!, assert_eq!).


##### `assert_single_permission_request_hook_input`  (lines 982–988)

```
fn assert_single_permission_request_hook_input(
    home: &Path,
    command: &str,
    description: Option<&str>,
) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Checks that exactly one Bash permission-request hook input was logged. It is a convenience wrapper for the common Bash case.

**Data flow**: It receives the home directory, expected command, and optional description. It passes those values along with tool name Bash to the more general helper and returns the parsed hook records.

**Call relations**: Several permission-request tests call this after running a shell or exec command. It delegates all validation to assert_single_permission_request_hook_input_for_tool.

*Call graph*: calls 1 internal fn (assert_single_permission_request_hook_input_for_tool); called by 4 (permission_request_hook_allows_network_approval_without_prompt, permission_request_hook_allows_shell_command_without_user_approval, permission_request_hook_sees_raw_exec_command_input, permission_request_hook_sees_retry_context_after_sandbox_denial).


##### `assert_single_permission_request_hook_input_for_tool`  (lines 990–1000)

```
fn assert_single_permission_request_hook_input_for_tool(
    home: &Path,
    tool_name: &str,
    command: &str,
    description: Option<&str>,
) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Checks that exactly one permission-request hook input exists for a named tool and that its fields match expectations.

**Data flow**: It receives the home directory, expected tool name, command, and optional description. It reads the hook log, asserts there is one entry, validates that entry, and returns the log records.

**Call relations**: The Bash wrapper and apply_patch permission test use this. It combines log reading with the lower-level field validator.

*Call graph*: calls 2 internal fn (assert_permission_request_hook_input, read_permission_request_hook_inputs); called by 2 (assert_single_permission_request_hook_input, permission_request_hook_allows_apply_patch_with_write_alias); 1 external calls (assert_eq!).


##### `read_post_tool_use_hook_inputs`  (lines 1002–1004)

```
fn read_post_tool_use_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the standard PostToolUse hook log from the test home. Tests use it to inspect what Codex reported after a tool finished.

**Data flow**: It receives the home directory, builds the path to post_tool_use_hook_log.jsonl, and delegates parsing to the shared log reader. It returns parsed JSON entries.

**Call relations**: Post-tool tests call this after checking model output. It shares parsing behavior with pre-tool and hook-order log readers.

*Call graph*: calls 1 internal fn (read_hook_inputs_from_log); called by 8 (assert_post_tool_use_blocks_code_mode_tool_result, post_tool_use_block_decision_replaces_shell_command_output_with_reason, post_tool_use_blocks_when_exec_session_completes_via_write_stdin, post_tool_use_continue_false_replaces_shell_command_output_with_stop_reason, post_tool_use_exit_two_replaces_one_shot_exec_command_output_with_feedback, post_tool_use_records_additional_context_for_apply_patch, post_tool_use_records_additional_context_for_shell_command, post_tool_use_records_apply_patch_context_with_edit_alias); 1 external calls (join).


##### `read_hook_inputs_from_log`  (lines 1006–1013)

```
fn read_hook_inputs_from_log(log_path: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Parses a JSON-lines hook log file into JSON values. JSON-lines means one JSON object per line, which is convenient for append-only test logs.

**Data flow**: It receives a log path. It reads the file, skips blank lines, parses each line as JSON, and returns the collected records or an error with file context.

**Call relations**: Several specialized log readers and plugin/config tests use this helper so they do not repeat the same parsing code.

*Call graph*: called by 6 (plugin_pre_tool_use_blocks_shell_command_before_execution, pre_tool_use_blocks_shell_when_defined_in_config_toml, pre_tool_use_merges_hooks_json_and_config_toml, read_hook_order_inputs, read_post_tool_use_hook_inputs, read_pre_tool_use_hook_inputs); 1 external calls (read_to_string).


##### `read_session_start_hook_inputs`  (lines 1015–1022)

```
fn read_session_start_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the SessionStart hook log from the test home. It lets tests verify startup, resume, and compact hook payloads.

**Data flow**: It receives a home directory. It reads session_start_hook_log.jsonl, parses non-empty lines as JSON, and returns the records.

**Call relations**: Session-start tests use this after turns, compaction, or resume to check which source triggered the hook and what transcript information was present.

*Call graph*: called by 3 (compact_session_start_hook_records_additional_context_for_next_turn, resumed_thread_runs_resume_then_compact_session_start_hooks, session_start_hook_sees_materialized_transcript_path); 2 external calls (join, read_to_string).


##### `read_user_prompt_submit_hook_inputs`  (lines 1024–1031)

```
fn read_user_prompt_submit_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the UserPromptSubmit hook log. This shows which user prompts were examined by the hook, including blocked queued prompts.

**Data flow**: It receives a home directory. It reads user_prompt_submit_hook_log.jsonl, parses each non-empty line as JSON, and returns the records.

**Call relations**: Prompt-submit tests call this after submitting accepted and blocked prompts to confirm the hook saw each prompt with consistent turn IDs.

*Call graph*: called by 2 (blocked_queued_prompt_does_not_strand_earlier_accepted_prompt, blocked_user_prompt_submit_persists_additional_context_for_next_turn); 2 external calls (join, read_to_string).


##### `read_hook_order_inputs`  (lines 1033–1035)

```
fn read_hook_order_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the shared hook-order log used by the ordering test. It keeps that test focused on event order rather than file parsing.

**Data flow**: It receives a home directory, points to hook_order_log.jsonl, and uses the shared log parser. It returns the ordered JSON records.

**Call relations**: The SessionStart-before-UserPromptSubmit test calls this after one turn to compare the recorded event names.

*Call graph*: calls 1 internal fn (read_hook_inputs_from_log); called by 1 (session_start_runs_before_user_prompt_submit_on_first_turn); 1 external calls (join).


##### `ev_message_item_done`  (lines 1037–1047)

```
fn ev_message_item_done(id: &str, text: &str) -> Value
```

**Purpose**: Builds a fake streaming event that says an assistant message item is complete. Tests use it to simulate model streaming without a real model.

**Data flow**: It receives a message ID and text. It creates a JSON event with type response.output_item.done and embeds the assistant message content, then returns that JSON value.

**Call relations**: Streaming tests include this event in mock server chunks so Codex believes a model message has finished.

*Call graph*: 1 external calls (json!).


##### `sse_event`  (lines 1049–1051)

```
fn sse_event(event: Value) -> String
```

**Purpose**: Wraps one JSON event as a server-sent event stream body. Server-sent events are a simple text format used for streaming model responses.

**Data flow**: It receives one JSON event. It puts it in a one-item list and passes it to the shared SSE formatter, returning the formatted string.

**Call relations**: The queued-prompt streaming test uses this to build individual chunks for the fake streaming server.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `request_message_input_texts`  (lines 1053–1066)

```
fn request_message_input_texts(body: &[u8], role: &str) -> Vec<String>
```

**Purpose**: Extracts message input text for a given role from a raw captured request body. It is used when the test server records bytes rather than a richer request helper.

**Data flow**: It receives raw request bytes and a role name such as user. It parses the bytes as JSON, walks the input messages, filters by role and input_text spans, and returns the text strings.

**Call relations**: The queued-prompt test uses this on captured streaming-server requests to verify the accepted queued prompt was sent and the blocked one was not.

*Call graph*: called by 1 (blocked_queued_prompt_does_not_strand_earlier_accepted_prompt); 1 external calls (from_slice).


##### `stop_hook_can_block_multiple_times_in_same_turn`  (lines 1069–1174)

```
async fn stop_hook_can_block_multiple_times_in_same_turn() -> Result<()>
```

**Purpose**: Tests that a Stop hook can block more than once during a single user turn and that Codex retries with accumulating continuation prompts.

**Data flow**: It sets up three fake model responses and a Stop hook that blocks twice. It submits one prompt, then checks that three model requests happened, hook prompts accumulated, hook inputs kept one turn ID, and rollout history saved both prompts.

**Call relations**: This test uses the Stop hook writer, request-log helpers, stop-hook log reader, and rollout extractor to follow the same continuation prompt from hook output to model request to saved history.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_stop_hook_inputs, rollout_hook_prompt_texts); 5 external calls (assert!, assert_eq!, read_to_string, skip_if_no_network!, vec!).


##### `session_start_hook_sees_materialized_transcript_path`  (lines 1177–1213)

```
async fn session_start_hook_sees_materialized_transcript_path() -> Result<()>
```

**Purpose**: Tests that SessionStart hooks receive a transcript_path that is not empty and already exists on disk.

**Data flow**: It installs a hook that logs transcript existence, runs one turn against a mock response, reads the hook log, and asserts the path was present and materialized.

**Call relations**: The test depends on the transcript-recording hook fixture and the session-start log reader to verify startup timing.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_session_start_hook_inputs); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `session_start_runs_before_user_prompt_submit_on_first_turn`  (lines 1216–1260)

```
async fn session_start_runs_before_user_prompt_submit_on_first_turn() -> Result<()>
```

**Purpose**: Tests that SessionStart runs before UserPromptSubmit on the first turn. This matters because startup context should be ready before the prompt is processed.

**Data flow**: It installs two logging hooks, submits one prompt, reads the shared order log, and checks that SessionStart with source startup appears before UserPromptSubmit with the prompt text.

**Call relations**: The test uses the ordering fixture and hook-order reader to observe the event sequence inside Codex.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_hook_order_inputs); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `session_start_hook_spills_large_additional_context`  (lines 1263–1302)

```
async fn session_start_hook_spills_large_additional_context() -> Result<()>
```

**Purpose**: Tests that very large SessionStart additional context is written to a file instead of being fully inserted into the model request.

**Data flow**: It creates a long context string, installs a startup hook that returns it, submits a turn, finds the spill-path message in the developer input, and verifies the file contains the full context.

**Call relations**: The test uses the session-start context fixture and spilled-path helper to confirm Codex protects request size while preserving complete hook output.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, spilled_hook_output_path); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `pre_tool_use_hook_spills_large_additional_context`  (lines 1305–1360)

```
async fn pre_tool_use_hook_spills_large_additional_context() -> Result<()>
```

**Purpose**: Tests that large PreToolUse additional context is spilled to a file before the follow-up model request.

**Data flow**: It mocks a shell tool call followed by a normal assistant response, installs a pre-tool hook returning long context, runs a turn, then checks the second request for a spill notice and verifies the saved file.

**Call relations**: The test combines the pre-tool hook writer, mock response sequence, and spill-path helper to validate large context handling around tool calls.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, spilled_hook_output_path); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `compact_session_start_hook_records_additional_context_for_next_turn`  (lines 1363–1435)

```
async fn compact_session_start_hook_records_additional_context_for_next_turn() -> Result<()>
```

**Purpose**: Tests that a SessionStart hook with a compact matcher runs after compaction and supplies context to the next normal turn.

**Data flow**: It installs a compact-only hook, submits an initial turn, triggers compaction, waits for completion, submits another turn, and checks only the post-compact request contains the hook context.

**Call relations**: This test uses the non-OpenAI provider helper, compact hook fixture, event waiting, and session-start log reader to cover the compaction path.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, non_openai_model_provider, read_session_start_hook_inputs); 5 external calls (assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `resumed_thread_runs_resume_then_compact_session_start_hooks`  (lines 1438–1531)

```
async fn resumed_thread_runs_resume_then_compact_session_start_hooks() -> Result<()>
```

**Purpose**: Tests that resuming a conversation can run resume and compact SessionStart hooks and include both contexts in the next model request.

**Data flow**: It starts a session that exceeds the auto-compact token limit, saves its rollout path, resumes it with hooks trusted, submits another turn, and checks the final request and hook log for resume then compact sources.

**Call relations**: The test uses the resume/compact hook fixture, mock model sequence, and session-start log reader to exercise lifecycle behavior across process-like resume.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_session_start_hook_inputs); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `stop_hook_spills_large_continuation_prompt`  (lines 1534–1581)

```
async fn stop_hook_spills_large_continuation_prompt() -> Result<()>
```

**Purpose**: Tests that a very large Stop-hook continuation prompt is stored in a file while a short notice is sent in the next model request.

**Data flow**: It installs a Stop hook with a long retry prompt, runs a turn that needs one retry, extracts the hook prompt from the second request, finds the spill path, and verifies the file content.

**Call relations**: The test uses Stop hook setup, request prompt extraction, and spill-path detection to confirm large stop feedback is preserved safely.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, request_hook_prompt_texts, spilled_hook_output_path); 5 external calls (assert!, assert_eq!, skip_if_no_network!, repeat_n, vec!).


##### `resumed_thread_keeps_stop_continuation_prompt_in_history`  (lines 1584–1646)

```
async fn resumed_thread_keeps_stop_continuation_prompt_in_history() -> Result<()>
```

**Purpose**: Tests that a Stop-hook continuation prompt saved in history still appears after the conversation is resumed.

**Data flow**: It runs an initial session where a Stop hook causes a retry, captures the rollout path, resumes the session, submits a new prompt, and checks the resumed request still contains the earlier hook prompt.

**Call relations**: This test connects Stop-hook persistence with the resume flow, using mock responses before and after resume.

*Call graph*: calls 5 internal fn (mount_sse_once, mount_sse_sequence, sse, start_mock_server, test_codex); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `multiple_blocking_stop_hooks_persist_multiple_hook_prompt_fragments`  (lines 1649–1706)

```
async fn multiple_blocking_stop_hooks_persist_multiple_hook_prompt_fragments() -> Result<()>
```

**Purpose**: Tests that multiple Stop hooks blocking the same stop event produce multiple prompt fragments and preserve their order.

**Data flow**: It installs several Stop hooks, submits one prompt, checks the second model request contains both fragments, then reads the rollout and confirms the same ordered fragments were saved.

**Call relations**: The test uses the parallel Stop hook fixture, request inspection, and rollout extraction to verify combined hook feedback.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_eq!, read_to_string, skip_if_no_network!, vec!).


##### `blocked_user_prompt_submit_persists_additional_context_for_next_turn`  (lines 1709–1781)

```
async fn blocked_user_prompt_submit_persists_additional_context_for_next_turn() -> Result<()>
```

**Purpose**: Tests that when a UserPromptSubmit hook blocks a prompt, its additional context is kept for the next accepted prompt.

**Data flow**: It installs a hook that blocks one exact prompt, submits that prompt and then another prompt, and checks the model request includes the extra context but not the blocked user text.

**Call relations**: The test uses the user-prompt hook fixture and log reader to confirm both prompts were inspected while only the accepted one reached the model.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_user_prompt_submit_hook_inputs); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `blocked_queued_prompt_does_not_strand_earlier_accepted_prompt`  (lines 1784–1940)

```
async fn blocked_queued_prompt_does_not_strand_earlier_accepted_prompt() -> Result<()>
```

**Purpose**: Tests that if prompts are queued while a response is streaming, a later blocked prompt does not prevent an earlier accepted queued prompt from running.

**Data flow**: It starts a streaming fake server, submits an initial prompt, waits until output begins, queues one accepted prompt and one blocked prompt, releases the stream gate, and verifies the second request contains only the accepted queued prompt.

**Call relations**: This test uses the streaming SSE server, raw request text extractor, and user-prompt hook log reader to cover queue ordering under asynchronous streaming.

*Call graph*: calls 4 internal fn (start_streaming_sse_server, test_codex, read_user_prompt_submit_hook_inputs, request_message_input_texts); 11 external calls (default, from_millis, from_secs, assert!, assert_eq!, wait_for_event, channel, skip_if_no_network!, sleep, timeout (+1 more)).


##### `permission_request_hook_allows_shell_command_without_user_approval`  (lines 1943–2013)

```
async fn permission_request_hook_allows_shell_command_without_user_approval() -> Result<()>
```

**Purpose**: Tests that a PermissionRequest hook can approve a shell command so Codex does not need user approval.

**Data flow**: It creates a marker file, installs an allow hook, asks the model to run a command that removes the marker under an approval-required policy, and verifies the marker is gone and the hook input was logged.

**Call relations**: The test uses the standard allow permission hook and single-input assertion helper to prove the hook approval path replaces a user approval prompt.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_permission_request_hook_input); 8 external calls (assert!, assert_eq!, format!, write, json!, skip_if_no_network!, temp_dir, vec!).


##### `permission_request_hook_allows_apply_patch_with_write_alias`  (lines 2016–2085)

```
async fn permission_request_hook_allows_apply_patch_with_write_alias() -> Result<()>
```

**Purpose**: Tests that a PermissionRequest hook matching the Write alias can approve an apply_patch operation.

**Data flow**: It installs a permission hook for Write, uses a restrictive workspace profile so the patch needs approval, runs a patch outside the usual workspace boundary, and checks the file was created.

**Call relations**: The test uses the restrictive profile helper and the permission-input assertion for apply_patch to verify alias matching.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_permission_request_hook_input_for_tool, restrictive_workspace_write_profile); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


##### `permission_request_hook_sees_raw_exec_command_input`  (lines 2088–2162)

```
async fn permission_request_hook_sees_raw_exec_command_input() -> Result<()>
```

**Purpose**: Tests that PermissionRequest hooks see the intended command and justification for the unified exec_command tool.

**Data flow**: It enables the unified exec feature, installs an allow hook, sends an exec_command request with command and justification, and verifies the command executes and the hook log includes the expected description.

**Call relations**: The test combines feature configuration, the standard allow hook, and the Bash permission assertion helper.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_permission_request_hook_input, read_only); 8 external calls (assert!, assert_eq!, format!, write, json!, skip_if_no_network!, temp_dir, vec!).


##### `permission_request_hook_allows_network_approval_without_prompt`  (lines 2165–2284)

```
async fn permission_request_hook_allows_network_approval_without_prompt() -> Result<()>
```

**Purpose**: Tests that a PermissionRequest hook can approve a network access request without showing an approval prompt.

**Data flow**: It configures managed network requirements and network-enabled permissions, installs an allow hook, runs a command that needs network access, waits for the hook log, confirms no approval event appears, and validates the hook input description.

**Call relations**: The test uses the network profile helper, managed-network test configuration, event waiting, and permission-input assertion to cover network-specific approval.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_permission_request_hook_input, network_workspace_write_profile); 14 external calls (clone, new, from_millis, from_secs, new, assert!, managed_network_requirements_loader, wait_for_event, write, json! (+4 more)).


##### `permission_request_hook_sees_retry_context_after_sandbox_denial`  (lines 2288–2349)

```
async fn permission_request_hook_sees_retry_context_after_sandbox_denial() -> Result<()>
```

**Purpose**: Tests that after a sandbox denial, a permission-request hook sees the retry permission context and can approve the retry.

**Data flow**: It runs a shell command under read-only permissions, lets the first attempt fail due to sandbox limits, uses the hook to approve retry, then checks the command wrote the expected marker file.

**Call relations**: This platform-limited test uses the standard allow hook and single-input assertion to verify the retry approval path.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_permission_request_hook_input, read_only); 6 external calls (assert_eq!, format!, remove_file, json!, skip_if_no_network!, vec!).


##### `pre_tool_use_blocks_shell_command_before_execution`  (lines 2352–2443)

```
async fn pre_tool_use_blocks_shell_command_before_execution() -> Result<()>
```

**Purpose**: Tests that a PreToolUse hook can block a shell command before it runs.

**Data flow**: It installs a denying Bash pre-tool hook, prepares a command that would create a marker file, submits a turn, then verifies the tool output reports the hook reason and the marker file was not created.

**Call relations**: The test reads the pre-tool hook log afterward to confirm Codex sent the tool name, call ID, command, transcript path, and turn ID to the hook.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 8 external calls (assert!, assert_eq!, format!, remove_file, json!, skip_if_no_network!, temp_dir, vec!).


##### `pre_tool_use_records_additional_context_for_shell_command`  (lines 2446–2505)

```
async fn pre_tool_use_records_additional_context_for_shell_command() -> Result<()>
```

**Purpose**: Tests that a PreToolUse hook can add developer context while still allowing a shell command to run.

**Data flow**: It installs a context-returning Bash pre-tool hook, triggers a shell command, and checks the follow-up model request includes the context and the command output.

**Call relations**: This test relies on the pre-tool hook fixture and captured mock requests to verify hook context travels into the next model turn.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `blocked_pre_tool_use_records_additional_context_for_shell_command`  (lines 2508–2578)

```
async fn blocked_pre_tool_use_records_additional_context_for_shell_command() -> Result<()>
```

**Purpose**: Tests that a blocked PreToolUse hook can still add context for the next model request.

**Data flow**: It installs a hook that both denies the command and returns additional context, runs a command that would create a marker, and checks the command did not run while the next request contains the context.

**Call relations**: The test uses the same pre-tool hook writer but exercises the combined deny-plus-context response shape.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 8 external calls (assert!, assert_eq!, format!, remove_file, json!, skip_if_no_network!, temp_dir, vec!).


##### `BashRewriteSurface::slug`  (lines 2587–2592)

```
fn slug(self) -> &'static str
```

**Purpose**: Gives a short text label for the Bash-like tool surface being tested. The label is used in IDs and file names.

**Data flow**: It receives either ExecCommand or ShellCommand as self. It returns the matching static string, exec-command or shell-command.

**Call relations**: The shared Bash rewrite assertion calls this to build readable call IDs and marker names for both tool variants.

*Call graph*: called by 1 (assert_pre_tool_use_rewrites_bash_surface).


##### `BashRewriteSurface::tool_call`  (lines 2594–2607)

```
fn tool_call(self, call_id: &str, command_text: &str) -> Result<Value>
```

**Purpose**: Builds the correct fake model tool-call event for either shell_command or exec_command. This lets one shared test cover both surfaces.

**Data flow**: It receives the surface, call ID, and command text. It wraps the command under the right JSON field, creates a function-call event, and returns it.

**Call relations**: The shared Bash rewrite test uses this while setting up the mocked model response sequence.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `BashRewriteSurface::original_command`  (lines 2609–2615)

```
fn original_command(self, marker: &Path) -> String
```

**Purpose**: Creates the original command text that would write an 'original' marker. It gives rewrite tests a visible sign if the wrong command ran.

**Data flow**: It receives the surface and a marker path. It formats a shell command that writes 'original' to that path and returns the command string.

**Call relations**: The shared Bash rewrite assertion calls this before installing the rewriting hook and later checks this command did not execute.

*Call graph*: called by 1 (assert_pre_tool_use_rewrites_bash_surface); 1 external calls (format!).


##### `BashRewriteSurface::rewritten_command`  (lines 2617–2623)

```
fn rewritten_command(self, marker: &Path) -> String
```

**Purpose**: Creates the replacement command text that should run after a hook rewrite. It gives tests a visible marker for successful rewriting.

**Data flow**: It receives the surface and a marker path. It formats a shell command that writes 'rewritten' to that path and returns the command string.

**Call relations**: The shared Bash rewrite assertion calls this to build the updatedInput returned by the pre-tool hook.

*Call graph*: called by 1 (assert_pre_tool_use_rewrites_bash_surface); 1 external calls (format!).


##### `BashRewriteSurface::configure`  (lines 2625–2634)

```
fn configure(self, config: &mut Config)
```

**Purpose**: Applies the right Codex configuration for the Bash-like surface under test. ExecCommand needs the unified exec feature enabled; ShellCommand does not.

**Data flow**: It receives the surface and a mutable config. It trusts discovered hooks, and when the surface is ExecCommand, it enables the experimental unified exec setting and feature flag.

**Call relations**: The shared Bash rewrite test passes this as its configuration hook so each surface runs under the needed feature setup.

*Call graph*: calls 1 internal fn (trust_discovered_hooks); 1 external calls (matches!).


##### `assert_pre_tool_use_rewrites_bash_surface`  (lines 2637–2703)

```
async fn assert_pre_tool_use_rewrites_bash_surface(surface: BashRewriteSurface) -> Result<()>
```

**Purpose**: Shared test logic proving a PreToolUse hook can rewrite either shell_command or exec_command before execution.

**Data flow**: It receives which Bash surface to test. It prepares original and rewritten marker commands, installs a rewriting hook, runs a turn, then checks only the rewritten marker exists and the hook log captured the original command.

**Call relations**: The shell-command and exec-command rewrite tests both call this helper, which uses the BashRewriteSurface methods to customize setup.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, original_command, rewritten_command, slug, read_pre_tool_use_hook_inputs); called by 2 (pre_tool_use_rewrites_exec_command_before_execution, pre_tool_use_rewrites_shell_command_before_execution); 8 external calls (assert!, assert_eq!, format!, remove_file, json!, skip_if_no_network!, temp_dir, vec!).


##### `pre_tool_use_rewrites_shell_command_before_execution`  (lines 2706–2708)

```
async fn pre_tool_use_rewrites_shell_command_before_execution() -> Result<()>
```

**Purpose**: Tests the shared rewrite behavior specifically for shell_command. It is a thin wrapper around the shared Bash rewrite assertion.

**Data flow**: It passes ShellCommand into the shared assertion and returns that async result.

**Call relations**: This test delegates the real setup and checks to assert_pre_tool_use_rewrites_bash_surface.

*Call graph*: calls 1 internal fn (assert_pre_tool_use_rewrites_bash_surface).


##### `pre_tool_use_rewrites_exec_command_before_execution`  (lines 2711–2713)

```
async fn pre_tool_use_rewrites_exec_command_before_execution() -> Result<()>
```

**Purpose**: Tests the shared rewrite behavior specifically for exec_command. It confirms the unified exec path supports pre-tool rewrites.

**Data flow**: It passes ExecCommand into the shared assertion and returns that async result.

**Call relations**: This test delegates to assert_pre_tool_use_rewrites_bash_surface, which enables the needed feature for exec_command.

*Call graph*: calls 1 internal fn (assert_pre_tool_use_rewrites_bash_surface).


##### `pre_tool_use_rewrites_code_mode_nested_exec_command_before_execution`  (lines 2716–2803)

```
async fn pre_tool_use_rewrites_code_mode_nested_exec_command_before_execution() -> Result<()>
```

**Purpose**: Tests that a PreToolUse hook can rewrite a shell command that is nested inside code mode execution.

**Data flow**: It sends a code-mode custom tool call that runs an exec command, installs a hook that rewrites that command, then verifies the code-mode output and marker files show only the rewritten command ran.

**Call relations**: The test uses the code-mode output extractor and pre-tool hook log reader to confirm both the visible result and hook payload.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, code_mode_custom_tool_output_text, read_pre_tool_use_hook_inputs); 8 external calls (new, assert!, assert_eq!, format!, json!, to_string, skip_if_no_network!, vec!).


##### `pre_tool_use_block_rejects_code_mode_tool_promise_before_execution`  (lines 2806–2878)

```
async fn pre_tool_use_block_rejects_code_mode_tool_promise_before_execution() -> Result<()>
```

**Purpose**: Tests that blocking a nested code-mode tool call rejects the code promise before the command executes.

**Data flow**: It builds code that catches tool errors, installs a denying Bash hook, runs the code-mode call, and checks the output contains the caught error and the marker file was not created.

**Call relations**: The test uses the code-mode output extractor and pre-tool hook log reader to prove the block reached code mode as an error.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, code_mode_custom_tool_output_text, read_pre_tool_use_hook_inputs); 7 external calls (new, assert!, assert_eq!, format!, to_string, skip_if_no_network!, vec!).


##### `assert_post_tool_use_blocks_code_mode_tool_result`  (lines 2880–2966)

```
async fn assert_post_tool_use_blocks_code_mode_tool_result(
    hook_mode: &'static str,
    reason: &'static str,
) -> Result<()>
```

**Purpose**: Shared test logic proving a PostToolUse hook can hide or reject a nested code-mode tool result after the command has already run.

**Data flow**: It receives a hook mode and reason. It creates code that runs a command and catches errors, installs a post-tool hook, runs the code-mode call, then checks the command marker exists but the original result did not reach code mode.

**Call relations**: The two code-mode post-tool block tests call this with different hook behaviors: a JSON block decision and exit code 2 feedback.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, code_mode_custom_tool_output_text, read_post_tool_use_hook_inputs); called by 2 (post_tool_use_block_decision_rejects_code_mode_tool_promise, post_tool_use_exit_two_rejects_code_mode_tool_promise); 7 external calls (new, assert!, assert_eq!, format!, to_string, skip_if_no_network!, vec!).


##### `post_tool_use_block_decision_rejects_code_mode_tool_promise`  (lines 2969–2975)

```
async fn post_tool_use_block_decision_rejects_code_mode_tool_promise() -> Result<()>
```

**Purpose**: Tests code-mode post-tool blocking through a JSON block decision. It checks that code sees an error instead of the original tool result.

**Data flow**: It calls the shared post-tool code-mode assertion with decision_block mode and a fixed reason.

**Call relations**: This wrapper delegates all setup and validation to assert_post_tool_use_blocks_code_mode_tool_result.

*Call graph*: calls 1 internal fn (assert_post_tool_use_blocks_code_mode_tool_result).


##### `post_tool_use_exit_two_rejects_code_mode_tool_promise`  (lines 2978–2981)

```
async fn post_tool_use_exit_two_rejects_code_mode_tool_promise() -> Result<()>
```

**Purpose**: Tests code-mode post-tool blocking through a hook process exiting with code 2. Exit code 2 is treated as hook feedback.

**Data flow**: It calls the shared post-tool code-mode assertion with exit_2 mode and a fixed reason.

**Call relations**: This wrapper reuses the same shared checker as the JSON block-decision test.

*Call graph*: calls 1 internal fn (assert_post_tool_use_blocks_code_mode_tool_result).


##### `plugin_pre_tool_use_blocks_shell_command_before_execution`  (lines 2984–3132)

```
async fn plugin_pre_tool_use_blocks_shell_command_before_execution() -> Result<()>
```

**Purpose**: Tests that a PreToolUse hook supplied by a plugin can block a shell command before it runs.

**Data flow**: It creates a fake plugin directory, manifest, plugin hook file, and plugin configuration, trusts the plugin hook, triggers a shell command, then verifies the tool output reports the plugin hook reason and the marker file was not created.

**Call relations**: The test uses trust_plugin_hooks during setup and reads the plugin hook's own log file with the shared log parser.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_hook_inputs_from_log, try_from); 13 external calls (clone, new, new, assert!, assert_eq!, format!, create_dir_all, remove_file, write, json! (+3 more)).


##### `pre_tool_use_blocks_shell_when_defined_in_config_toml`  (lines 3135–3216)

```
async fn pre_tool_use_blocks_shell_when_defined_in_config_toml() -> Result<()>
```

**Purpose**: Tests that a PreToolUse hook defined in config.toml can block shell execution. This covers the alternate configuration source.

**Data flow**: It writes a config.toml hook fixture, triggers a shell command, and checks the output contains the configured block reason while the marker file remains absent.

**Call relations**: The test uses the TOML hook writer and shared log reader to verify config-defined hooks behave like hooks.json hooks.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_hook_inputs_from_log); 8 external calls (assert!, assert_eq!, format!, remove_file, json!, skip_if_no_network!, temp_dir, vec!).


##### `pre_tool_use_merges_hooks_json_and_config_toml`  (lines 3219–3317)

```
async fn pre_tool_use_merges_hooks_json_and_config_toml() -> Result<()>
```

**Purpose**: Tests that hooks from hooks.json and config.toml are both active rather than one replacing the other.

**Data flow**: It installs one pre-tool hook in hooks.json and another in config.toml, triggers a shell command, checks the command output is returned, and verifies both hook logs received the same tool-call payload.

**Call relations**: The test uses both hook writers, the standard pre-tool log reader, and the shared log parser for the TOML hook log.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_hook_inputs_from_log, read_pre_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `pre_tool_use_blocks_exec_command_before_execution`  (lines 3320–3398)

```
async fn pre_tool_use_blocks_exec_command_before_execution() -> Result<()>
```

**Purpose**: Tests that PreToolUse can block the unified exec_command tool before it runs.

**Data flow**: It enables unified exec, installs a hook that exits with feedback, triggers an exec_command that would create a marker, and confirms the output contains the hook reason and the marker was not created.

**Call relations**: The test reads the pre-tool hook log to verify the unified exec call was normalized to Bash hook input with the expected command.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 8 external calls (assert!, assert_eq!, format!, remove_file, json!, skip_if_no_network!, temp_dir, vec!).


##### `pre_tool_use_blocks_apply_patch_before_execution`  (lines 3401–3470)

```
async fn pre_tool_use_blocks_apply_patch_before_execution() -> Result<()>
```

**Purpose**: Tests that a PreToolUse hook can block apply_patch before it changes files.

**Data flow**: It installs a hook matching apply_patch, sends a patch tool call, and verifies the returned output reports the block reason while the target file does not exist.

**Call relations**: The test uses the pre-tool hook log reader to confirm the patch text was sent as the hook command input.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


##### `pre_tool_use_rewrites_apply_patch_before_execution`  (lines 3473–3540)

```
async fn pre_tool_use_rewrites_apply_patch_before_execution() -> Result<()>
```

**Purpose**: Tests that a PreToolUse hook can replace an apply_patch request with a different patch.

**Data flow**: It sends an original patch, installs a hook returning a rewritten patch, runs the turn, then checks the original file was not created and the rewritten file contains the expected text.

**Call relations**: The test uses the updating pre-tool hook fixture and pre-tool log reader to prove the hook saw the original patch but Codex applied the rewritten one.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 6 external calls (assert!, assert_eq!, format!, json!, skip_if_no_network!, vec!).


##### `pre_tool_use_blocks_apply_patch_with_write_alias`  (lines 3543–3608)

```
async fn pre_tool_use_blocks_apply_patch_with_write_alias() -> Result<()>
```

**Purpose**: Tests that a PreToolUse hook matching the Write alias can block apply_patch. This checks alias matching, not just exact tool names.

**Data flow**: It installs a hook with matcher Write, sends an apply_patch call, and verifies the patch is blocked and the file is not created.

**Call relations**: The test reads the pre-tool log afterward to confirm the actual tool name is still apply_patch while the alias matcher caused the hook to run.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


##### `pre_tool_use_blocks_local_function_tool_before_execution`  (lines 3611–3669)

```
async fn pre_tool_use_blocks_local_function_tool_before_execution() -> Result<()>
```

**Purpose**: Tests that PreToolUse can block a local function tool, not only shell-like tools. A local function tool is code built into the test environment.

**Data flow**: It installs a denying hook for test_sync_tool, triggers that tool, and verifies the tool output says the call was blocked with the hook reason and tool name.

**Call relations**: The test uses the pre-tool log reader to confirm generic JSON tool input was passed through unchanged.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `pre_tool_use_rewrites_local_function_tool_before_execution`  (lines 3672–3731)

```
async fn pre_tool_use_rewrites_local_function_tool_before_execution() -> Result<()>
```

**Purpose**: Tests that PreToolUse can rewrite the input for a local function tool before it runs.

**Data flow**: It sends invalid-looking original arguments, installs a hook that replaces them with an empty object, triggers the tool, and checks the tool succeeds with output ok.

**Call relations**: The test reads the pre-tool log to ensure the hook received the original arguments even though the tool executed with rewritten input.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_records_additional_context_for_shell_command`  (lines 3734–3820)

```
async fn post_tool_use_records_additional_context_for_shell_command() -> Result<()>
```

**Purpose**: Tests that a PostToolUse hook can add context after a shell command while preserving the command output.

**Data flow**: It installs a context-returning post-tool hook, triggers a shell command, checks the follow-up request contains the context and command output, then verifies the hook log includes input, response, transcript path, and turn ID.

**Call relations**: The test uses the post-tool hook fixture, captured mock requests, and post-tool log reader.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_block_decision_replaces_shell_command_output_with_reason`  (lines 3823–3880)

```
async fn post_tool_use_block_decision_replaces_shell_command_output_with_reason() -> Result<()>
```

**Purpose**: Tests that a PostToolUse JSON block decision replaces a shell command's output with the hook reason.

**Data flow**: It runs a shell command that prints text, installs a post-tool hook returning decision block, and verifies the model receives the reason instead of the original output.

**Call relations**: The test reads the post-tool hook log to confirm the hook still saw the original tool response before replacing it.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_continue_false_replaces_shell_command_output_with_stop_reason`  (lines 3883–3941)

```
async fn post_tool_use_continue_false_replaces_shell_command_output_with_stop_reason() -> Result<()>
```

**Purpose**: Tests that a PostToolUse response with continue false replaces shell output with its stop reason.

**Data flow**: It runs a shell command, installs a post-tool hook returning continue false and stopReason, and checks the model-visible tool output equals that stop reason.

**Call relations**: The test uses the post-tool log reader to verify the hook observed the original output before Codex substituted the stop reason.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_exit_two_replaces_one_shot_exec_command_output_with_feedback`  (lines 3944–4010)

```
async fn post_tool_use_exit_two_replaces_one_shot_exec_command_output_with_feedback() -> Result<()>
```

**Purpose**: Tests that a PostToolUse hook exiting with code 2 can replace a one-shot exec_command result with feedback.

**Data flow**: It enables unified exec, runs an exec_command, installs a post hook that exits with feedback, and checks the follow-up tool output is exactly that feedback.

**Call relations**: The test reads the post-tool log to verify the exec command input and original output were passed to the hook.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_spills_large_feedback_message`  (lines 4013–4075)

```
async fn post_tool_use_spills_large_feedback_message() -> Result<()>
```

**Purpose**: Tests that very large PostToolUse feedback is spilled to disk instead of being sent inline as tool output.

**Data flow**: It installs a post-tool hook that exits with a long feedback string, runs an exec command, extracts the spill path from the model-visible output, and verifies the file contains the full feedback.

**Call relations**: The test uses the post-tool hook writer and spilled-path helper to cover large feedback handling after tool execution.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, spilled_hook_output_path); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_blocks_when_exec_session_completes_via_write_stdin`  (lines 4078–4177)

```
async fn post_tool_use_blocks_when_exec_session_completes_via_write_stdin() -> Result<()>
```

**Purpose**: Tests that PostToolUse runs when a long-running exec session completes through a later write_stdin poll, and can replace that final result.

**Data flow**: It starts an exec session, then sends write_stdin to wait for completion. The pre hook logs the initial command, the post hook blocks the final session output, and the test checks the model receives the feedback instead.

**Call relations**: This test uses the paired pre/post hook fixture plus both log readers to confirm the pre hook is tied to session start while the post hook sees final session output.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs, read_pre_tool_use_hook_inputs); 6 external calls (assert!, assert_eq!, json!, skip_if_no_network!, skip_if_windows!, vec!).


##### `post_tool_use_records_additional_context_for_apply_patch`  (lines 4180–4248)

```
async fn post_tool_use_records_additional_context_for_apply_patch() -> Result<()>
```

**Purpose**: Tests that a PostToolUse hook can add context after apply_patch succeeds.

**Data flow**: It installs a post-tool hook matching apply_patch, sends a patch that creates a file, checks the follow-up request contains the hook context, verifies the file exists, and inspects the hook's recorded response.

**Call relations**: The test uses the post-tool hook fixture and post-tool log reader to confirm apply_patch output is available to hooks.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


##### `post_tool_use_records_apply_patch_context_with_edit_alias`  (lines 4251–4314)

```
async fn post_tool_use_records_apply_patch_context_with_edit_alias() -> Result<()>
```

**Purpose**: Tests that a PostToolUse hook matching the Edit alias can run for apply_patch and add context.

**Data flow**: It installs a post-tool hook with matcher Edit, applies a patch, checks the next request includes the context, verifies the file exists, and confirms the hook log records apply_patch as the actual tool.

**Call relations**: This test mirrors the apply_patch post-tool context test but focuses on alias matching behavior.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


### `core/tests/suite/hooks_mcp.rs`

`test` · `test run`

MCP, or Model Context Protocol, is a way for Codex to connect to external tool servers. Hooks are user-defined commands that Codex can run before or after a tool is used, like a checkpoint at a doorway. This test file makes sure those checkpoints still work for MCP tools.

The tests build a small fake world: a mock model server sends scripted responses asking Codex to call an MCP echo tool, and a local test MCP server provides that tool. The file then writes temporary hook scripts into the test home directory. These scripts read the hook payload from standard input, record it to a log file, and return a JSON decision to Codex.

There are three main behaviors under test. A pre-tool hook can deny the MCP tool before it runs, and Codex should report the block reason back to the model. A pre-tool hook can also allow the call but replace the tool input, and the MCP tool should receive the rewritten message rather than the original one. A post-tool hook can inspect the tool input and response, then add extra context to the next model request.

The file also tests both old prefixed MCP tool names and newer non-prefixed names, because Codex supports both naming styles. Without these tests, changes to hooks, MCP tool naming, or tool-call plumbing could silently break user safety checks and automation around external tools.

#### Function details

##### `enable_mcp_tool_name_features`  (lines 37–41)

```
fn enable_mcp_tool_name_features(config: &mut Config, prefix_mcp_tool_names: bool)
```

**Purpose**: This helper turns on the feature flag for non-prefixed MCP tool names when a test wants to exercise that newer naming style. It leaves the configuration unchanged when the test is using the legacy prefixed names.

**Data flow**: It receives a mutable Codex configuration and a true-or-false choice about prefixed tool names. If prefixed names are not wanted, it enables the feature that lets MCP tools appear without the old prefix; otherwise it does nothing. The changed configuration is kept in the same object passed in.

**Call relations**: It is used by enable_hooks_and_rmcp_server while preparing each test configuration. That setup helper combines hook trust, MCP naming behavior, and the test MCP server into one ready-to-use configuration.

*Call graph*: called by 1 (enable_hooks_and_rmcp_server).


##### `write_pre_tool_use_hook`  (lines 43–84)

```
fn write_pre_tool_use_hook(home: &Path, reason: &str) -> Result<()>
```

**Purpose**: This helper creates a temporary PreToolUse hook that always blocks the MCP echo tool. Tests use it to prove Codex stops the tool before execution and sends the hook’s reason back to the model.

**Data flow**: It takes a test home directory and a block reason. It writes a small Python script that reads the hook input, appends that input to a JSON-lines log file, and prints a JSON response saying the tool call is denied. It also writes a hooks.json file that tells Codex to run that script for the MCP echo tool.

**Call relations**: The blocking pre-tool test installs this hook during test setup through the test builder’s pre-build hook. Later, when Codex tries to call the MCP echo tool, the hook runs first and its denial becomes the tool-call output inspected by the test.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_updating_pre_tool_use_hook`  (lines 86–128)

```
fn write_updating_pre_tool_use_hook(home: &Path, updated_message: &str) -> Result<()>
```

**Purpose**: This helper creates a temporary PreToolUse hook that allows the MCP echo tool but rewrites its input message. Tests use it to confirm that hook-updated input is what actually reaches the MCP tool.

**Data flow**: It receives a test home directory and the replacement message. It writes a Python script that logs the original hook payload, then prints a JSON response saying the call is allowed and providing updated input with the new message. It writes hooks.json so Codex knows to run this script before the MCP echo tool.

**Call relations**: The input-rewrite test installs this hook before Codex starts. When the model asks for an MCP echo call, Codex runs the hook, accepts the rewritten input, then passes that changed input on to the MCP server.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_post_tool_use_hook`  (lines 130–171)

```
fn write_post_tool_use_hook(home: &Path, additional_context: &str) -> Result<()>
```

**Purpose**: This helper creates a temporary PostToolUse hook that records what happened during an MCP tool call and returns extra context for the next model request. Tests use it to prove post-tool hooks see the full MCP payload and can influence the follow-up turn.

**Data flow**: It takes a test home directory and a context string. It writes a Python script that reads and logs the post-tool hook payload, then prints JSON containing additional context. It also writes hooks.json so Codex runs this script after the MCP echo tool finishes.

**Call relations**: The post-tool tests install this hook during setup. After Codex executes the MCP echo tool, this hook runs, and its returned context is expected to appear in the next request sent to the mock model server.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `read_hook_inputs`  (lines 173–180)

```
fn read_hook_inputs(home: &Path, log_name: &str) -> Result<Vec<Value>>
```

**Purpose**: This helper reads the log file written by one of the temporary hook scripts. Tests use it to check exactly what Codex sent into the hook.

**Data flow**: It receives the test home directory and the log file name. It reads the file, ignores blank lines, parses each remaining line as JSON, and returns the parsed list. If the file cannot be read or a line is not valid JSON, it reports an error with context about which log failed.

**Call relations**: The pre-tool block, pre-tool rewrite, and post-tool tests call this after submitting a turn. It lets those tests verify that the hook received the expected event name, tool name, tool input, tool response, and transcript path.

*Call graph*: called by 3 (post_tool_use_records_mcp_tool_payload_and_context, pre_tool_use_blocks_mcp_tool_before_execution, pre_tool_use_rewrites_mcp_tool_before_execution); 2 external calls (join, read_to_string).


##### `insert_rmcp_test_server`  (lines 182–214)

```
fn insert_rmcp_test_server(config: &mut Config, command: String, approval_mode: AppToolApproval)
```

**Purpose**: This helper adds the local RMCP test server to the Codex configuration. It gives the tests a real MCP tool server to connect to, rather than only mocking the model side.

**Data flow**: It receives a mutable configuration, the command used to start the test MCP server, and the approval mode for tools. It copies the current MCP server map, inserts a server named rmcp using standard input/output transport, sets timeouts and approval settings, then writes the updated server map back into the configuration.

**Call relations**: It is called by enable_hooks_and_rmcp_server during test setup. Once inserted, the test waits for this server to be ready before asking Codex to process a model turn that calls the echo tool.

*Call graph*: called by 1 (enable_hooks_and_rmcp_server); 3 external calls (from_secs, new, new).


##### `enable_hooks_and_rmcp_server`  (lines 216–225)

```
fn enable_hooks_and_rmcp_server(
    config: &mut Config,
    rmcp_test_server_bin: String,
    approval_mode: AppToolApproval,
    prefix_mcp_tool_names: bool,
)
```

**Purpose**: This setup helper prepares a test configuration with trusted hooks, the requested MCP tool-name style, and the RMCP test server. It keeps repeated setup code out of the individual tests.

**Data flow**: It receives the mutable configuration, the path to the RMCP server binary, the tool approval mode, and whether to use prefixed MCP tool names. It marks discovered hooks as trusted, adjusts the MCP naming feature flag if needed, and inserts the RMCP server into the configuration. The result is a configuration ready for hook-and-MCP testing.

**Call relations**: Each main test passes this helper to the test builder’s configuration step. Internally it calls trust_discovered_hooks, enable_mcp_tool_name_features, and insert_rmcp_test_server to assemble the full test environment.

*Call graph*: calls 3 internal fn (trust_discovered_hooks, enable_mcp_tool_name_features, insert_rmcp_test_server).


##### `pre_tool_use_blocks_mcp_tool_before_execution_with_legacy_prefixed_names`  (lines 228–234)

```
async fn pre_tool_use_blocks_mcp_tool_before_execution_with_legacy_prefixed_names() -> Result<()>
```

**Purpose**: This test entry checks the blocking PreToolUse behavior when MCP tools use the older prefixed namespace. It exists so the legacy naming path keeps working.

**Data flow**: It supplies the shared blocking test with the choice to use prefixed names and the prefixed MCP namespace. The real setup, model simulation, tool call, and assertions happen inside the shared helper it awaits.

**Call relations**: It calls pre_tool_use_blocks_mcp_tool_before_execution as a small wrapper. The wrapper pattern lets the same behavior be tested once with legacy names and once with non-prefixed names.

*Call graph*: calls 1 internal fn (pre_tool_use_blocks_mcp_tool_before_execution).


##### `pre_tool_use_blocks_mcp_tool_before_execution_with_non_prefixed_names`  (lines 237–243)

```
async fn pre_tool_use_blocks_mcp_tool_before_execution_with_non_prefixed_names() -> Result<()>
```

**Purpose**: This test entry checks the blocking PreToolUse behavior when MCP tools use the newer non-prefixed namespace. It protects the feature path where MCP tool names are shorter.

**Data flow**: It passes the shared blocking test the choice to disable prefixed names and the unprefixed MCP namespace. The shared helper then runs the full test and verifies the results.

**Call relations**: It calls pre_tool_use_blocks_mcp_tool_before_execution. Together with the legacy-name wrapper, it proves the hook behavior is independent of the MCP naming style used by the model response.

*Call graph*: calls 1 internal fn (pre_tool_use_blocks_mcp_tool_before_execution).


##### `pre_tool_use_blocks_mcp_tool_before_execution`  (lines 245–332)

```
async fn pre_tool_use_blocks_mcp_tool_before_execution(
    prefix_mcp_tool_names: bool,
    mcp_namespace: &'static str,
) -> Result<()>
```

**Purpose**: This shared test proves that a PreToolUse hook can stop an MCP tool call before the MCP server runs it. It also checks that Codex tells the model why the call was blocked and records the right hook input.

**Data flow**: It starts a mock model server and scripts two model responses: first a request to call the MCP echo tool, then a final assistant message after receiving the tool output. It writes a blocking pre-tool hook, configures Codex with the RMCP server, waits for that server, and submits a user turn. Afterward it inspects the requests sent back to the mock model and the hook log, confirming the output contains the block reason, the hook saw the expected tool name and input, and the transcript path exists on disk.

**Call relations**: The two name-style wrapper tests call this helper. Inside, it relies on the mock server helpers to imitate model streaming events, the test Codex builder to create an isolated run, enable_hooks_and_rmcp_server to prepare configuration, and read_hook_inputs to inspect what the hook received.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_hook_inputs); called by 2 (pre_tool_use_blocks_mcp_tool_before_execution_with_legacy_prefixed_names, pre_tool_use_blocks_mcp_tool_before_execution_with_non_prefixed_names); 7 external calls (assert!, assert_eq!, stdio_server_bin, wait_for_mcp_server, json!, skip_if_no_network!, vec!).


##### `pre_tool_use_rewrites_mcp_tool_before_execution`  (lines 335–407)

```
async fn pre_tool_use_rewrites_mcp_tool_before_execution() -> Result<()>
```

**Purpose**: This test proves that a PreToolUse hook can change the input to an MCP tool before it runs. It checks that the MCP echo tool uses the rewritten message and not the original one.

**Data flow**: It starts a mock model server, scripts a model response that asks for the MCP echo tool with an original message, and scripts a follow-up response. It writes a pre-tool hook that returns updated input, configures Codex with hooks and the RMCP server, waits for the server, and submits a turn. It then checks the final tool output sent to the model: the output must include the rewritten message and must not include the original message. Finally it reads the hook log to confirm the hook was given the original input.

**Call relations**: This is a standalone asynchronous test. It uses the hook-writing helper to install the rewriting hook, enable_hooks_and_rmcp_server during configuration, mock server helpers to stage model responses, and read_hook_inputs to confirm the hook saw the expected before-rewrite data.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_hook_inputs); 7 external calls (assert!, assert_eq!, stdio_server_bin, wait_for_mcp_server, json!, skip_if_no_network!, vec!).


##### `post_tool_use_records_mcp_tool_payload_and_context_with_legacy_prefixed_names`  (lines 410–417)

```
async fn post_tool_use_records_mcp_tool_payload_and_context_with_legacy_prefixed_names() -> Result<()>
```

**Purpose**: This test entry checks PostToolUse behavior when MCP tools use the older prefixed namespace. It makes sure legacy MCP names still produce the right hook payload and follow-up context.

**Data flow**: It calls the shared post-tool test with prefixed names enabled and the prefixed MCP namespace. The shared helper performs the full setup, execution, and checks.

**Call relations**: It is a wrapper around post_tool_use_records_mcp_tool_payload_and_context. It pairs with the non-prefixed wrapper so both MCP naming paths are covered.

*Call graph*: calls 1 internal fn (post_tool_use_records_mcp_tool_payload_and_context).


##### `post_tool_use_records_mcp_tool_payload_and_context_with_non_prefixed_names`  (lines 420–427)

```
async fn post_tool_use_records_mcp_tool_payload_and_context_with_non_prefixed_names() -> Result<()>
```

**Purpose**: This test entry checks PostToolUse behavior when MCP tools use the newer non-prefixed namespace. It ensures the newer naming feature does not break post-tool hooks.

**Data flow**: It calls the shared post-tool test with prefixed names disabled and the unprefixed MCP namespace. The shared helper runs Codex and verifies the hook payload and returned context.

**Call relations**: It delegates to post_tool_use_records_mcp_tool_payload_and_context. Alongside the legacy wrapper, it confirms the same post-tool behavior works under both naming styles.

*Call graph*: calls 1 internal fn (post_tool_use_records_mcp_tool_payload_and_context).


##### `post_tool_use_records_mcp_tool_payload_and_context`  (lines 429–532)

```
async fn post_tool_use_records_mcp_tool_payload_and_context(
    prefix_mcp_tool_names: bool,
    mcp_namespace: &'static str,
) -> Result<()>
```

**Purpose**: This shared test proves that a PostToolUse hook receives the MCP tool input and response, and that any extra context it returns is included in the next model request. It checks both observation and feedback after a tool call.

**Data flow**: It starts a mock model server, scripts one response asking Codex to call the MCP echo tool, and scripts a follow-up response. It writes a post-tool hook that logs its input and returns an additional context note, configures Codex with the RMCP server, waits for the server, and submits a turn. It then checks that the next request to the mock model contains the extra developer context, that the MCP echo output is still present, and that the hook log contains the expected event name, tool name, tool input, structured tool response, and a real transcript path.

**Call relations**: The two post-tool wrapper tests call this helper with different MCP name styles. It uses mock response helpers for the model side, enable_hooks_and_rmcp_server for setup, wait_for_mcp_server before execution, and read_hook_inputs afterward to inspect what the post-tool hook received.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_hook_inputs); called by 2 (post_tool_use_records_mcp_tool_payload_and_context_with_legacy_prefixed_names, post_tool_use_records_mcp_tool_payload_and_context_with_non_prefixed_names); 7 external calls (assert!, assert_eq!, stdio_server_bin, wait_for_mcp_server, json!, skip_if_no_network!, vec!).


### `core/tests/suite/user_notification.rs`

`test` · `test run`

This is an integration test: it starts enough of the real system to check that several parts work together. The real-world feature being tested is a “notify me when the agent is done” hook. A user can configure a command, such as a shell script, and Codex should run it when an assistant turn completes, passing along useful information like the user’s message and the assistant’s final reply.

The test only runs on non-Windows systems because it writes and executes a Unix shell script and sets Unix-style file permissions. It creates a fake server that returns a simple assistant response, “Done,” then creates a temporary notification script. That script writes the notification payload it receives into a nearby file. This is like asking a messenger to leave a receipt on the table so the test can inspect it later.

Next, the test starts a test Codex instance configured to use that script as its notification command. It submits one user message, waits until the turn is complete, then waits for the script-created file to appear. Finally, it reads the saved payload as JSON and confirms three important facts: the notification type says the agent turn completed, the original user input is included, and the last assistant message is “Done.” Without this test, notification payloads could silently become wrong or stop being sent.

#### Function details

##### `summarize_context_three_requests_and_instructions`  (lines 26–82)

```
async fn summarize_context_three_requests_and_instructions() -> anyhow::Result<()>
```

**Purpose**: This test proves that after a normal user message finishes, Codex runs the configured notification script and gives it the expected JSON payload. It protects the user-facing notification feature from regressions.

**Data flow**: The test starts with a fake response server, a temporary folder, and a small shell script that records its last argument into a file. It configures a test Codex instance to use that script, sends the text “hello world,” and waits for the assistant turn to finish. After the notification script writes its file, the test reads the JSON payload and checks that it says the turn completed, includes the user input, and records the assistant’s final message as “Done.”

**Call relations**: The async test runner calls this function as a test case. Inside, it asks the response helpers to start a mock server, build a fake server-sent-events response, and mount that response for one request. It then uses the test Codex builder to create a Codex instance with a custom notification command, submits user input to Codex, waits for the turn-complete event, and finally uses file-waiting and JSON assertion helpers to verify what the notification command received.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 13 external calls (default, from_secs, new, assert_eq!, from_mode, wait_for_event, wait_for_path_exists, from_str, skip_if_no_network!, set_permissions (+3 more)).
