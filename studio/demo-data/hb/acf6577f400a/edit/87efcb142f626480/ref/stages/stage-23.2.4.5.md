# Approvals, permissions, hooks, and review-mediation suites  `stage-23.2.4.5`

This stage tests the system’s “gatekeepers” during the main work of a session: the checks, prompts, and side routes that stand between a requested action and actually doing it. Think of it as the rules desk and security checkpoint for user-visible actions.

The approval and policy tests make sure commands, patching files, and network changes are allowed or blocked for the right reasons, even in tricky combinations of sandbox limits, saved exceptions, and collaboration modes. The permission-request tests cover both asking inline and using a dedicated tool, including temporary versus lasting grants, partial approval, and denial. The user-input tests check how the system pauses to ask the user a question and then resumes cleanly.

Review-focused tests follow `/review` requests and Guardian auto-review routing, making sure review work stays separate from normal conversation and notifications. Metadata tests confirm that later tool calls carry the right context about earlier prompts and reviewer choices. Finally, hook and notification tests check the plug-in style interception points before and after tools run, including rewriting inputs, blocking actions, adding context, and sending a summary notification when a turn finishes.

## Files in this stage

### Approval policy enforcement
These tests establish the core runtime approval and execution-policy matrix, including general approvals, unified exec behavior, and skill-script privilege boundaries.

### `core/tests/suite/approvals.rs`

`test` · `approval request handling, policy persistence, and command/tool execution during integration tests`

This file is the central approval-policy integration suite. It introduces small domain enums and structs—`TargetPath`, `ActionKind`, `Expectation`, `Outcome`, `ScenarioSpec`, and `ScenarioGroup`—that let tests describe an action to perform, the sandbox/approval context, the expected approval flow, and the expected observable result. `ActionKind::prepare` is the key fixture generator: depending on the variant, it may mount HTTP mocks, build Python or shell commands, construct `exec_command` or `shell_command` function-call events, or synthesize freeform/shell `apply_patch` payloads. `Expectation::verify` then interprets captured tool output and checks filesystem, network, or stdout effects.

The `scenarios()` function enumerates a broad matrix across danger-full-access, read-only, workspace-write, apply-patch, and unified-exec groups, including GPT-5.2 vs GPT-5.4 output-shape differences, escalation requests, prefix-rule amendments, and patch approvals. `run_scenario` wires each case together: configure Codex, optionally write policy files, mount the model event and final assistant response, submit the turn, satisfy or deny approval events as specified, parse the resulting tool output, and verify expectations. Beyond the matrix, targeted tests cover session-scoped patch approvals, persisted execpolicy amendments, propagation of amendments from spawned subagents back to the parent session, zsh-fork nested escalation behavior, fallback rules for invalid requested prefix rules, persisted network deny rules, network approval retries with denied-read sandboxes, and managed-network behavior after danger-full-access startup. Helpers decode zstd-compressed request bodies and poll for spawned threads to support these asynchronous flows.

#### Function details

##### `TargetPath::resolve_for_patch`  (lines 77–90)

```
fn resolve_for_patch(self, test: &TestCodex) -> (PathBuf, String)
```

**Purpose**: Resolves a logical target location into both a concrete filesystem path and the patch-path string that should appear inside an apply-patch payload. Workspace targets use a relative patch path; outside-workspace targets use an absolute-looking display path.

**Data flow**: Matches on `self`: for `Workspace(name)` it joins `name` under `test.cwd.path()` and returns `(path, name.to_string())`; for `OutsideWorkspace(name)` it joins `name` under the process current directory and returns `(path.clone(), path.display().to_string())`.

**Call relations**: Action preparation and expectation verification both rely on this helper so they agree on where files should be created and what path string should appear in generated patches.

*Call graph*: 1 external calls (current_dir).


##### `ActionKind::policy_src`  (lines 136–148)

```
fn policy_src(&self) -> Option<&'static str>
```

**Purpose**: Extracts an optional policy-source string from actions that explicitly carry one. This lets scenario setup write a rules file only when needed.

**Data flow**: Returns `Some(policy_src)` for `RunCommandWithPolicy` and `None` for all other action variants.

**Call relations**: `run_scenario` calls this before building the harness; if present, it installs the returned rule text into `rules/default.rules` via a pre-build hook.


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

**Purpose**: Builds the concrete model event and optional expected command string for a scenario’s action. It encapsulates all fixture generation for file writes, network fetches, shell commands, unified exec, and apply-patch variants.

**Data flow**: Given a `TestCodex`, mock server, call ID, and `SandboxPermissions`, it matches on the action variant. File-write actions resolve the target path, remove any preexisting file, build a Python one-liner that writes and prints content, wrap it in a shell event, and return the event plus command string. Network actions mount a GET mock on the server, build a Python urllib script (with or without proxy bypass), wrap it in a shell event, and return the event plus command. Plain shell-command actions build shell events with longer timeouts; prefix-rule actions call `shell_event_with_prefix_rule`; unified-exec actions call `exec_command_event`. Freeform apply-patch actions resolve the target, remove any existing file, build an add-file patch, and return `ev_apply_patch_custom_tool_call` with no command string. Shell apply-patch actions similarly build a patch, wrap it in a heredoc shell script via `shell_apply_patch_command`, and return a shell event plus command string.

**Call relations**: `run_scenario` delegates all action-specific setup here. The returned event becomes the mocked model output for the first response, and the optional command string is later used to validate approval requests.

*Call graph*: calls 6 internal fn (ev_apply_patch_custom_tool_call, build_add_file_patch, exec_command_event, shell_apply_patch_command, shell_event, shell_event_with_prefix_rule); 6 external calls (given, new, format!, remove_file, method, path).


##### `build_add_file_patch`  (lines 300–302)

```
fn build_add_file_patch(patch_path: &str, content: &str) -> String
```

**Purpose**: Constructs a minimal add-file patch body for a target path and content string. It is used by both freeform and shell apply-patch scenarios.

**Data flow**: Formats `*** Begin Patch\n*** Add File: {patch_path}\n+{content}\n*** End Patch\n` and returns the resulting `String`.

**Call relations**: Called by `ActionKind::prepare` for apply-patch actions and by the session-scoped patch-approval test when constructing two sequential patches.

*Call graph*: called by 2 (prepare, approving_apply_patch_for_session_skips_future_prompts_for_same_file); 1 external calls (format!).


##### `shell_apply_patch_command`  (lines 304–312)

```
fn shell_apply_patch_command(patch: &str) -> String
```

**Purpose**: Wraps a patch body in a shell heredoc that invokes `apply_patch`. It normalizes the script to ensure the patch body ends with a newline before the closing marker.

**Data flow**: Starts with `apply_patch <<'PATCH'\n`, appends the patch text, appends a newline if the patch did not already end with one, then appends `PATCH\n` and returns the full shell script string.

**Call relations**: Used by `ActionKind::prepare` for `ApplyPatchShell` scenarios so the model event becomes a shell-command call rather than a freeform custom-tool call.

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

**Purpose**: Builds a `shell_command` function-call event without any prefix-rule override. It is a convenience wrapper around the more general shell-event constructor.

**Data flow**: Accepts call ID, command string, timeout, and sandbox permissions, forwards them to `shell_event_with_prefix_rule` with `prefix_rule: None`, and returns the resulting JSON event.

**Call relations**: Used by many action-preparation branches and several targeted tests that need to synthesize shell-command model outputs.

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

**Purpose**: Constructs the JSON payload for a `shell_command` function call, optionally including requested sandbox override permissions and a requested prefix rule. It serializes the arguments exactly as the model would emit them.

**Data flow**: Builds a JSON object with `command` and `timeout_ms`; if `sandbox_permissions.requests_sandbox_override()` is true it adds `sandbox_permissions`; if a prefix rule vector is provided it adds `prefix_rule`. It serializes the args to a string and returns `ev_function_call(call_id, "shell_command", &args_str)`.

**Call relations**: Called by `shell_event`, by `ActionKind::prepare` for prefix-rule scenarios, and by targeted tests that directly exercise invalid or fallback prefix-rule behavior.

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

**Purpose**: Constructs the JSON payload for a unified `exec_command` function call, including optional yield time and escalation justification when sandbox override is requested. It mirrors the model-side event shape for unified exec.

**Data flow**: Builds a JSON object with `cmd`; conditionally adds `yield_time_ms`; if sandbox override is requested, adds `sandbox_permissions` and a `justification` string using either the supplied justification or `DEFAULT_UNIFIED_EXEC_JUSTIFICATION`. It serializes the args and returns `ev_function_call(call_id, "exec_command", &args_str)`.

**Call relations**: Only `ActionKind::prepare` uses this helper for `RunUnifiedExecCommand` scenarios.

*Call graph*: calls 2 internal fn (ev_function_call, requests_sandbox_override); called by 1 (prepare); 2 external calls (json!, to_string).


##### `Expectation::verify`  (lines 411–600)

```
fn verify(&self, test: &TestCodex, result: &CommandResult) -> Result<()>
```

**Purpose**: Checks the observed command or patch result against the scenario’s expected outcome, including exit-code conventions, stdout diagnostics, filesystem side effects, and cleanup. It centralizes all post-run assertions for the approval matrix.

**Data flow**: Matches on the expectation variant and inspects the supplied `CommandResult` plus the `TestCodex` workspace. Depending on the case it may assert exact or optional-zero exit codes, require stdout substrings like `OK:` or `ERR:`, read created or patched files and compare contents, assert files do not exist, and remove created files afterward. For `FileNotCreated`, it supports `|`-separated alternative substrings in diagnostics. It returns `Ok(())` after all assertions pass.

**Call relations**: `run_scenario` parses the final tool output into `CommandResult` and delegates all scenario-specific validation here. Some targeted tests also instantiate `Expectation` variants directly for ad hoc verification.

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

**Purpose**: Submits a user turn with explicit approval and sandbox policies plus local environment selection. It is the common turn-submission helper for the matrix and many targeted approval tests.

**Data flow**: Clones the session model from `test.session_configured`, then submits `Op::UserInput` with one text item and `ThreadSettingsOverrides` that set local environments, the provided approval policy, `ApprovalsReviewer::User`, the provided sandbox policy, and a default collaboration mode using the session model. It returns `Ok(())` once submission succeeds.

**Call relations**: Matrix execution and many targeted tests call this helper before waiting for approval requests or completion events.

*Call graph*: calls 1 internal fn (local_selections); called by 9 (approving_apply_patch_for_session_skips_future_prompts_for_same_file, approving_execpolicy_amendment_persists_policy_and_skips_future_prompts, approving_fallback_rule_for_compound_command_works, compound_command_with_one_safe_command_still_requires_approval, denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt, invalid_requested_prefix_rule_falls_back_for_compound_command, network_approval_flow_survives_danger_full_access_session_start, run_scenario, spawned_subagent_execpolicy_amendment_propagates_to_parent_session); 2 external calls (default, vec!).


##### `parse_result`  (lines 686–724)

```
fn parse_result(item: &Value) -> CommandResult
```

**Purpose**: Normalizes tool output into a `CommandResult` regardless of whether the output is structured JSON, freeform `Exit code:` text, or plain text without an exit code. It handles both shell-command and apply-patch output formats.

**Data flow**: Reads the `output` string from a JSON item. It first tries to parse that string as JSON and, if successful, extracts `metadata.exit_code` and `output`. If JSON parsing fails, it tries two regexes: one for `Exit code: N ... Output:` and one for `Process exited with code N ... Output:`. If either matches, it parses the exit code and captures the output body; otherwise it returns `CommandResult { exit_code: None, stdout: output_str.to_string() }`.

**Call relations**: `run_scenario` and several targeted tests call this helper after extracting a function-call or custom-tool-call output item from the captured request.

*Call graph*: called by 7 (approving_execpolicy_amendment_persists_policy_and_skips_future_prompts, approving_fallback_rule_for_compound_command_works, denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt, env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command, run_scenario); 2 external calls (new, get).


##### `expect_exec_approval`  (lines 726–751)

```
async fn expect_exec_approval(
    test: &TestCodex,
    expected_command: &str,
) -> ExecApprovalRequestEvent
```

**Purpose**: Waits for the next exec approval request and asserts it targets the expected command. It fails immediately if the turn completes without requesting approval.

**Data flow**: Waits on the codex event stream until either `EventMsg::ExecApprovalRequest(_)` or `EventMsg::TurnComplete(_)` appears. If it receives an approval request, it compares the last command argument to `expected_command` and returns the `ExecApprovalRequestEvent`; if completion arrives first or another event slips through, it panics.

**Call relations**: Matrix scenarios and targeted exec-approval tests use this helper right after submitting a turn when they expect an approval gate before execution can proceed.

*Call graph*: called by 5 (approving_execpolicy_amendment_persists_policy_and_skips_future_prompts, approving_fallback_rule_for_compound_command_works, compound_command_with_one_safe_command_still_requires_approval, invalid_requested_prefix_rule_falls_back_for_compound_command, run_scenario); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `expect_patch_approval`  (lines 753–773)

```
async fn expect_patch_approval(
    test: &TestCodex,
    expected_call_id: &str,
) -> ApplyPatchApprovalRequestEvent
```

**Purpose**: Waits for the next apply-patch approval request and asserts it references the expected call ID. It fails if the turn completes without prompting.

**Data flow**: Waits until either `EventMsg::ApplyPatchApprovalRequest(_)` or `EventMsg::TurnComplete(_)` appears. On approval it asserts `approval.call_id == expected_call_id` and returns the event; on premature completion or unexpected events it panics.

**Call relations**: Used by patch-approval matrix scenarios and the session-scoped patch-approval persistence test.

*Call graph*: called by 2 (approving_apply_patch_for_session_skips_future_prompts_for_same_file, run_scenario); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `wait_for_completion_without_approval`  (lines 775–791)

```
async fn wait_for_completion_without_approval(test: &TestCodex)
```

**Purpose**: Asserts that a turn completes without any exec approval request. It is used for scenarios expected to run automatically under current policy.

**Data flow**: Waits until either `ExecApprovalRequest` or `TurnComplete` appears. It returns silently on `TurnComplete`, but panics if an approval request or any other unexpected event is observed.

**Call relations**: Auto-outcome scenarios and several targeted persistence tests use this helper after submitting a turn that should no longer prompt.

*Call graph*: called by 5 (approving_execpolicy_amendment_persists_policy_and_skips_future_prompts, approving_fallback_rule_for_compound_command_works, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, run_scenario, spawned_subagent_execpolicy_amendment_propagates_to_parent_session); 2 external calls (wait_for_event, panic!).


##### `wait_for_completion`  (lines 793–798)

```
async fn wait_for_completion(test: &TestCodex)
```

**Purpose**: Blocks until the current turn emits `TurnComplete`. It is the simplest completion helper in the file.

**Data flow**: Waits on the codex event stream until `matches!(event, EventMsg::TurnComplete(_))` and then returns.

**Call relations**: Used after approvals are submitted, and by targeted tests that only need to know the turn finished.

*Call graph*: called by 9 (approving_apply_patch_for_session_skips_future_prompts_for_same_file, approving_execpolicy_amendment_persists_policy_and_skips_future_prompts, approving_fallback_rule_for_compound_command_works, compound_command_with_one_safe_command_still_requires_approval, denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt, env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, network_approval_flow_survives_danger_full_access_session_start, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command, run_scenario); 1 external calls (wait_for_event).


##### `body_contains`  (lines 800–818)

```
fn body_contains(req: &Request, text: &str) -> bool
```

**Purpose**: Checks whether a raw wiremock request body contains a substring, transparently decoding zstd-compressed bodies. It supports matcher-based mock routing in subagent tests.

**Data flow**: Inspects `content-encoding` for `zstd`, optionally decodes the body bytes, converts them to UTF-8 if possible, and returns whether the resulting string contains the target text.

**Call relations**: Only matcher-based mock setups use this helper to distinguish parent, child, and follow-up requests by prompt or call ID.

*Call graph*: calls 1 internal fn (new); 1 external calls (decode_all).


##### `wait_for_spawned_thread`  (lines 820–839)

```
async fn wait_for_spawned_thread(test: &TestCodex) -> Result<Arc<CodexThread>>
```

**Purpose**: Polls the thread manager until a child thread appears that is distinct from the session’s original thread. It provides a concrete `CodexThread` handle for subagent approval tests.

**Data flow**: Computes a deadline two seconds in the future, repeatedly lists thread IDs, finds one not equal to `test.session_configured.thread_id`, and if found fetches and returns that thread. If none appears before the deadline, it returns an `anyhow::bail!` timeout error after sleeping in 10 ms increments between polls.

**Call relations**: The spawned-subagent execpolicy-amendment test uses this helper after submitting the parent spawn turn so it can observe and approve the child thread’s command.

*Call graph*: called by 1 (spawned_subagent_execpolicy_amendment_propagates_to_parent_session); 5 external calls (from_millis, from_secs, bail!, now, sleep).


##### `scenarios`  (lines 841–1839)

```
fn scenarios() -> Vec<ScenarioSpec>
```

**Purpose**: Defines the full approval-behavior matrix as data. It enumerates combinations of sandbox policy, approval policy, action type, requested permissions, enabled features, expected approval flow, and expected result.

**Data flow**: Constructs helper closures and then returns a large `Vec<ScenarioSpec>` literal. Each entry specifies a scenario name, approval and sandbox policies, an `ActionKind`, sandbox-permission request mode, optional features/model override, an `Outcome` describing whether approval should occur and how it should be answered, and an `Expectation` describing the final observable result.

**Call relations**: `run_scenario_group` calls this once, filters the returned scenarios by group, and then executes each selected scenario through `run_scenario`.

*Call graph*: called by 1 (run_scenario_group); 1 external calls (vec!).


##### `approval_matrix_covers_group`  (lines 1847–1849)

```
async fn approval_matrix_covers_group(group: ScenarioGroup) -> Result<()>
```

**Purpose**: Parameterized test entrypoint that runs all scenarios belonging to one scenario group. It lets the large matrix be split into manageable named test cases.

**Data flow**: Receives a `ScenarioGroup` from `test_case`, calls `run_scenario_group(group).await`, and returns its result.

**Call relations**: This is the top-level matrix test wrapper; the actual work is delegated to `run_scenario_group`.

*Call graph*: calls 1 internal fn (run_scenario_group).


##### `run_scenario_group`  (lines 1851–1867)

```
async fn run_scenario_group(group: ScenarioGroup) -> Result<()>
```

**Purpose**: Executes every scenario in one logical group, such as read-only or apply-patch. It ensures the group is non-empty and annotates failures with the scenario name.

**Data flow**: Skips if network is unavailable, calls `scenarios()`, filters the vector by `scenario_group(scenario) == group`, asserts the filtered list is non-empty, then iterates each scenario and awaits `run_scenario(&scenario)`, attaching context `approval scenario failed: {name}` to any error.

**Call relations**: Called only by the parameterized matrix entrypoint; it is the bridge from static scenario data to per-scenario execution.

*Call graph*: calls 2 internal fn (run_scenario, scenarios); called by 1 (approval_matrix_covers_group); 2 external calls (assert!, skip_if_no_network!).


##### `scenario_group`  (lines 1869–1887)

```
fn scenario_group(scenario: &ScenarioSpec) -> ScenarioGroup
```

**Purpose**: Classifies a scenario into one of the high-level matrix groups based on its action type and sandbox policy. This drives the parameterized grouping used by the matrix test.

**Data flow**: Matches first on `scenario.action`: apply-patch actions map to `ApplyPatch`, unified exec maps to `UnifiedExec`, and all other actions are grouped by `scenario.sandbox_policy` into `DangerFullAccess`, `ReadOnly`, or `WorkspaceWrite`.

**Call relations**: Used by `run_scenario_group` to filter the full scenario list into the subset relevant for the current parameterized test case.


##### `run_scenario`  (lines 1889–2055)

```
async fn run_scenario(scenario: &ScenarioSpec) -> Result<()>
```

**Purpose**: Executes one approval scenario end-to-end: configure Codex, synthesize the model event, submit the turn, satisfy or deny approvals as specified, parse the resulting tool output, and verify the expected outcome. It is the core engine behind the approval matrix.

**Data flow**: Starts a mock server, extracts scenario settings, builds a `test_codex` harness with the requested model, approval policy, sandbox policy, and enabled features, optionally installs a rules file from `policy_src`, and builds the test. It calls `scenario.action.prepare(...)` to get the first model event and optional expected command, mounts a one-shot SSE response containing that event and a second one-shot assistant completion, then submits the turn via `submit_turn`. It matches on `scenario.outcome`: `Auto` waits for completion without approval; `ExecApproval` waits for an exec approval, optionally checks the reason, submits the configured decision, and waits for completion; `ExecApprovalWithAmendment` additionally checks the proposed amendment before submitting the decision; `PatchApproval` waits for a patch approval, optionally checks the reason, submits the decision, and waits for completion. Finally it extracts either a custom-tool or function-call output item from the captured results request, parses it with `parse_result`, logs it, and delegates verification to `scenario.expectation.verify`.

**Call relations**: Every matrix scenario flows through this function. It orchestrates all helper functions in the file and is the main consumer of `ActionKind`, `Outcome`, and `Expectation`.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, expect_patch_approval, parse_result, submit_turn, wait_for_completion, wait_for_completion_without_approval); called by 1 (run_scenario_group); 4 external calls (assert_eq!, eprintln!, matches!, vec!).


##### `approving_apply_patch_for_session_skips_future_prompts_for_same_file`  (lines 2059–2176)

```
async fn approving_apply_patch_for_session_skips_future_prompts_for_same_file() -> Result<()>
```

**Purpose**: Verifies that approving an apply-patch request for the session suppresses future patch approval prompts for the same file. It checks both the initial approval flow and the no-prompt follow-up.

**Data flow**: Builds a harness with `OnRequest` approval and workspace-write sandbox, resolves an outside-workspace target path, constructs an add-file patch and a later update patch for the same path, mounts the first patch response and assistant completion, submits the first turn, waits for patch approval, submits `ReviewDecision::ApprovedForSession`, waits for completion, and asserts the file contains `before`. It then mounts the second patch response and completion, submits a follow-up turn, waits for either patch approval or completion, asserts completion arrives directly with no approval request, and finally checks the file now contains `after` before cleaning it up.

**Call relations**: This targeted test exercises session-scoped patch approval persistence outside the generic matrix because it spans two turns and depends on remembered approval state.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, build_add_file_patch, expect_patch_approval, submit_turn, wait_for_completion); 9 external calls (assert!, OutsideWorkspace, wait_for_event, format!, remove_file, panic!, skip_if_no_network!, try_from_path, vec!).


##### `approving_execpolicy_amendment_persists_policy_and_skips_future_prompts`  (lines 2180–2348)

```
async fn approving_execpolicy_amendment_persists_policy_and_skips_future_prompts() -> Result<()>
```

**Purpose**: Checks that approving a proposed execpolicy amendment writes the rule to disk, documents it in developer messages, and suppresses future approval prompts for the same command. It validates both persistence and reuse.

**Data flow**: Builds a read-only `UnlessTrusted` harness, prepares a `touch allow-prefix.txt` shell command event, mounts the first command response and assistant completion, submits the first turn, waits for exec approval, asserts the proposed amendment equals `ExecPolicyAmendment(["touch", "allow-prefix.txt"])`, submits `ApprovedExecpolicyAmendment` with that amendment, waits for completion, inspects the captured developer messages for the saved rule, reads `rules/default.rules` to confirm the persisted `prefix_rule(...)`, parses the first command output and checks success plus file creation. It then mounts the same command again, submits a second turn, waits for completion without approval, parses the second output, and confirms it also succeeded without prompting.

**Call relations**: This targeted persistence test extends beyond the matrix by spanning two turns and inspecting both saved policy files and developer-message documentation.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, submit_turn, wait_for_completion, wait_for_completion_without_approval); 7 external calls (new, new_read_only_policy, assert!, assert_eq!, read_to_string, remove_file, vec!).


##### `spawned_subagent_execpolicy_amendment_propagates_to_parent_session`  (lines 2351–2537)

```
async fn spawned_subagent_execpolicy_amendment_propagates_to_parent_session() -> Result<()>
```

**Purpose**: Verifies that an execpolicy amendment approved inside a spawned subagent propagates back to the parent session, so the parent can later run the same command without another prompt. It tests cross-thread policy sharing.

**Data flow**: Builds a collaborative read-only harness, mounts matcher-based SSE responses for the parent spawn turn, the child command turn, the child follow-up, the parent follow-up after spawn, and a later parent rerun of the same command. It submits the parent prompt, waits for the spawned child thread via `wait_for_spawned_thread`, waits on the child for an exec approval request, asserts the proposed amendment matches `touch subagent-allow-prefix.txt`, submits `ApprovedExecpolicyAmendment` to the child, waits for the child to complete without a second approval, confirms the child-created file exists and then removes it, submits a parent rerun turn, and waits for completion without approval.

**Call relations**: This test combines subagent spawning, child-thread approval handling, and parent-session reuse of the approved amendment, which is beyond the scope of the generic matrix.

*Call graph*: calls 8 internal fn (mount_sse_once, mount_sse_once_match, sse, start_mock_server, test_codex, submit_turn, wait_for_completion_without_approval, wait_for_spawned_thread); 12 external calls (from_secs, new, new_read_only_policy, assert!, assert_eq!, wait_for_event_with_timeout, remove_file, json!, panic!, to_string (+2 more)).


##### `env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork`  (lines 2541–2696)

```
async fn env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork() -> Result<()>
```

**Purpose**: Checks under the zsh-fork runtime that a Python process launching a `#!/usr/bin/env zsh` script can still trigger an approval request for a nested escalated command. It validates nested process attribution and approval routing.

**Data flow**: Obtains a zsh-fork runtime, builds a restrictive workspace-write test with a rule prompting on `touch`, writes an executable zsh script that touches an outside path and prints a completion marker, wraps execution of that script in a Python `subprocess.run(...)` command, mounts a shell-command response and assistant completion, submits a raw `Op::UserInput` with explicit local environment and permission profile, waits for an exec approval request, asserts the approval command includes both `/touch` and the outside path, submits `ReviewDecision::Approved`, waits for completion, parses the shell output, and asserts success, presence of the completion marker, and existence of the outside file.

**Call relations**: This targeted Unix-only test exercises nested process escalation behavior under the zsh-fork sandbox runtime rather than the standard matrix path.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, local_selections, turn_permission_fields, build_zsh_fork_test, restrictive_workspace_write_profile, zsh_fork_runtime, parse_result, shell_event (+1 more)); 16 external calls (default, from_secs, assert!, assert_eq!, wait_for_event_with_timeout, format!, metadata, set_permissions, write, panic! (+6 more)).


##### `matched_prefix_rule_runs_unsandboxed_under_zsh_fork`  (lines 2700–2799)

```
async fn matched_prefix_rule_runs_unsandboxed_under_zsh_fork() -> Result<()>
```

**Purpose**: Verifies that under zsh-fork, a command matching an allow `prefix_rule` reruns unsandboxed and succeeds without prompting. It checks that the outside file is actually created.

**Data flow**: Obtains a zsh-fork runtime, builds a restrictive workspace-write test with a saved allow rule for `touch`, mounts a shell-command response and assistant completion for `touch {outside_path}`, submits a raw `Op::UserInput` with explicit local environment and permission profile, waits for completion without approval, parses the shell output, asserts zero exit code, and confirms the outside file exists.

**Call relations**: This Unix-only targeted test validates saved-rule execution behavior specifically under the zsh-fork runtime.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, local_selections, turn_permission_fields, build_zsh_fork_test, restrictive_workspace_write_profile, zsh_fork_runtime, parse_result, shell_event (+1 more)); 8 external calls (default, assert!, assert_eq!, format!, skip_if_no_network!, current_dir, tempdir_in, vec!).


##### `invalid_requested_prefix_rule_falls_back_for_compound_command`  (lines 2803–2852)

```
async fn invalid_requested_prefix_rule_falls_back_for_compound_command() -> Result<()>
```

**Purpose**: Checks that when a requested prefix rule is too narrow for a compound command, Codex falls back to proposing an amendment for the full command instead of trusting the invalid requested rule. It inspects the proposed amendment only.

**Data flow**: Builds a read-only harness, constructs a shell-command event for a compound command with a requested prefix rule of just `touch`, mounts the response, submits the turn, waits for exec approval, extracts the proposed amendment, and asserts it contains the full compound command string.

**Call relations**: This targeted test directly exercises `shell_event_with_prefix_rule` and approval proposal logic for invalid requested rules.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, shell_event_with_prefix_rule, submit_turn); 3 external calls (new_read_only_policy, assert!, vec!).


##### `approving_fallback_rule_for_compound_command_works`  (lines 2856–2968)

```
async fn approving_fallback_rule_for_compound_command_works() -> Result<()>
```

**Purpose**: Verifies that approving the fallback execpolicy amendment for a compound command persists a usable rule and suppresses future prompts for the same command. It is the two-turn counterpart to the previous fallback-rule test.

**Data flow**: Builds a read-only harness, mounts a first shell-command response for the compound command with an invalid requested prefix rule, submits the turn, waits for exec approval, captures the proposed fallback amendment, submits `ApprovedExecpolicyAmendment` with that amendment, and waits for completion. It then mounts the same command again plus an assistant completion, submits a second turn, waits for completion without approval, parses the second output, and asserts success with empty stdout.

**Call relations**: This targeted test extends the fallback-rule scenario across two turns to prove the approved fallback amendment is persisted and reused.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_prefix_rule, submit_turn, wait_for_completion, wait_for_completion_without_approval); 4 external calls (new_read_only_policy, assert!, assert_eq!, vec!).


##### `denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt`  (lines 2971–3249)

```
async fn denying_network_policy_amendment_persists_policy_and_skips_future_network_prompt() -> Result<()>
```

**Purpose**: Checks that denying a proposed network policy amendment writes a deny rule to disk and prevents future network approval prompts for the same host. The command should continue to fail, but without another network approval request.

**Data flow**: Builds a managed-network workspace-write harness from a temp home config, mounts a shell-command response for a proxied HTTP fetch and an assistant completion, submits the first turn, loops through approval events until it finds the synthetic `network-access` approval request, auto-approving any unrelated command approvals along the way, then inspects the network context and proposed allow/deny amendments. It submits a `ReviewDecision::NetworkPolicyAmendment` choosing the deny amendment, waits for completion, reads `rules/default.rules` to confirm the persisted `network_rule(... decision="deny" ...)`, parses the first command output and verifies failure, then mounts the same fetch again, submits a second turn, loops until completion while asserting no `network-access` approval request appears, parses the second output, and again verifies failure.

**Call relations**: This targeted test covers persisted network-policy amendments, which are not represented in the generic scenario matrix.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, parse_result, shell_event, submit_turn, wait_for_completion); 14 external calls (new, new, assert!, assert_eq!, managed_network_requirements_loader, wait_for_event_with_timeout, format!, read_to_string, write, panic! (+4 more)).


##### `network_approval_retry_keeps_deny_read_sandbox_for_escalated_command`  (lines 3253–3454)

```
async fn network_approval_retry_keeps_deny_read_sandbox_for_escalated_command() -> Result<()>
```

**Purpose**: Verifies that when a command with denied-read filesystem restrictions requests both explicit escalation and later network approval, the approved retry preserves the denied-read sandbox constraints. It also ensures only one outer command approval occurs before the network approval.

**Data flow**: Builds a managed-network harness, derives a permission profile from workspace-write sandbox plus an added deny-read glob for `*.env`, mounts a shell-command response for a proxied HTTP fetch and an assistant completion, submits a raw `Op::UserInput` with explicit permission profile and `SandboxPermissions::RequireEscalated`, then loops through approval events. It counts non-network command approvals, asserting exactly one occurs and approving it; when the `network-access` approval arrives, it extracts the allow amendment and submits `ReviewDecision::NetworkPolicyAmendment` with that allow rule. After completion it parses the command output and asserts an exit code is present, indicating the approved retry ran and reported output.

**Call relations**: This non-Windows targeted test exercises a subtle retry path where network approval happens after an explicit escalation approval under a nontrivial filesystem sandbox.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, parse_result, shell_event, wait_for_completion, from_runtime_permissions (+1 more)); 14 external calls (new, default, new, assert!, assert_eq!, managed_network_requirements_loader, wait_for_event_with_timeout, format!, write, panic! (+4 more)).


##### `network_approval_flow_survives_danger_full_access_session_start`  (lines 3457–3597)

```
async fn network_approval_flow_survives_danger_full_access_session_start() -> Result<()>
```

**Purpose**: Checks that a session started under danger-full-access does not activate managed-network proxying, but a later turn using workspace-write sandbox can still trigger and handle a network approval flow correctly. It validates transition behavior across session and turn sandbox modes.

**Data flow**: Builds a harness whose config starts in `DangerFullAccess` despite managed-network config being present, asserts managed-network requirements are inactive and no runtime proxy is exposed in `session_configured`, mounts a shell-command response for a proxied HTTP fetch and an assistant completion, submits a turn using workspace-write sandbox via `submit_turn`, loops through approval events until it finds the `network-access` approval request while auto-approving any unrelated command approvals, asserts the network protocol is HTTP, submits `ReviewDecision::Denied` for the network approval, and waits for completion.

**Call relations**: This targeted test covers a session-start edge case where managed-network state is suppressed initially but network approvals must still function on later constrained turns.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, shell_event, submit_turn, wait_for_completion); 12 external calls (new, new, assert!, assert_eq!, managed_network_requirements_loader, wait_for_event_with_timeout, write, panic!, skip_if_no_network!, from_secs (+2 more)).


##### `compound_command_with_one_safe_command_still_requires_approval`  (lines 3602–3669)

```
async fn compound_command_with_one_safe_command_still_requires_approval() -> Result<()>
```

**Purpose**: Verifies that a compound command is not auto-trusted merely because one component matches an allow prefix rule. The whole command should still require approval under `UnlessTrusted`.

**Data flow**: Builds a workspace-write `UnlessTrusted` harness, writes a saved allow rule for `touch allow-prefix.txt`, prepares a shell-command event for `touch ./test.txt && rm ./test.txt`, mounts the response and assistant completion, submits the turn, waits for exec approval for the full command, submits `ReviewDecision::Denied`, and waits for completion.

**Call relations**: This targeted Unix-only test complements the matrix by checking compound-command trust evaluation against saved prefix rules.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, submit_turn, wait_for_completion); 5 external calls (new_workspace_write_policy, create_dir_all, write, skip_if_no_network!, vec!).


### `core/tests/suite/exec_policy.rs`

`test` · `request handling / tool policy evaluation`

This file mixes small helpers with end-to-end conversation tests that drive tool calls through mocked SSE responses. `collaboration_mode_for_model` constructs a `CollaborationMode` using `ModeKind::Default` and a developer instruction string specifically meant to exercise approval logic. `submit_user_turn` centralizes how tests submit `Op::UserInput`: it derives runtime sandbox fields from a `PermissionProfile` using `turn_permission_fields`, injects local environment selections, sets approval policy, and either uses a supplied collaboration mode or synthesizes a default one from the session model. `assert_no_matched_rules_invariant` inspects serialized function-call output and ensures the internal panic text `matched_rules must be non-empty` never leaks into user-visible output. The tests then cover several scenarios: on Windows, unified exec with Windows sandbox features disabled must reject a managed read-only command as policy-blocked; a local `policy.rules` file forbids shell commands beginning with `echo`; and four collaboration-mode regressions verify that empty-string and whitespace-only scripts for both `shell_command` and `exec_command` complete without surfacing the invariant failure. The common pattern is to mount one SSE response that asks the model to call a tool, a second SSE response for the assistant’s follow-up, submit a user turn with explicit thread settings, wait for `TurnComplete`, and inspect the recorded function-call output.

#### Function details

##### `collaboration_mode_for_model`  (lines 28–37)

```
fn collaboration_mode_for_model(model: String) -> CollaborationMode
```

**Purpose**: Builds a `CollaborationMode` value for a specific model with a fixed developer-instructions string used by the tests. It standardizes the collaboration-mode payload across multiple cases.

**Data flow**: Takes a `String` model name and returns `CollaborationMode { mode: ModeKind::Default, settings: Settings { model, reasoning_effort: None, developer_instructions: Some(...) } }`. It does not read or mutate external state.

**Call relations**: This helper is called by the empty-script and whitespace-script collaboration-mode tests so they all submit turns with the same explicit collaboration settings.

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

**Purpose**: Submits a user text turn to a `TestCodex` instance with explicit approval, sandbox, permission-profile, and collaboration-mode overrides. It hides the repetitive protocol construction needed by the exec-policy tests.

**Data flow**: Reads `test.session_configured.model` and `test.config.cwd`, converts the supplied `PermissionProfile` into `(sandbox_policy, permission_profile)` via `turn_permission_fields`, builds `Op::UserInput` containing one `UserInput::Text` item and `ThreadSettingsOverrides` with local environment selections, the requested approval policy, derived sandbox fields, and either the provided collaboration mode or a synthesized default using the session model. It asynchronously submits that op through `test.codex.submit` and returns `Result<()>`.

**Call relations**: The Windows sandbox rejection test and all collaboration-mode regression tests call this helper instead of constructing `Op::UserInput` inline. It delegates environment selection to `local_selections` and permission translation to `turn_permission_fields` before handing control to the Codex runtime.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 5 (shell_command_empty_script_with_collaboration_mode_does_not_panic, shell_command_whitespace_script_with_collaboration_mode_does_not_panic, unified_exec_disabled_windows_sandbox_rejects_managed_read_only_command, unified_exec_empty_script_with_collaboration_mode_does_not_panic, unified_exec_whitespace_script_with_collaboration_mode_does_not_panic); 2 external calls (default, vec!).


##### `assert_no_matched_rules_invariant`  (lines 80–89)

```
fn assert_no_matched_rules_invariant(output_item: &Value)
```

**Purpose**: Checks that a serialized function-call output payload does not contain the internal invariant panic message about empty matched rules. It is a focused regression assertion against leaked internal failures.

**Data flow**: Accepts a `serde_json::Value` representing a function-call output item, reads its `output` field as a string, and asserts that the string does not contain `invariant failed: matched_rules must be non-empty`. It returns unit and writes no state.

**Call relations**: The four collaboration-mode tests call this helper after extracting the tool output from the mock request, using it as the final regression check once the turn has completed.

*Call graph*: called by 4 (shell_command_empty_script_with_collaboration_mode_does_not_panic, shell_command_whitespace_script_with_collaboration_mode_does_not_panic, unified_exec_empty_script_with_collaboration_mode_does_not_panic, unified_exec_whitespace_script_with_collaboration_mode_does_not_panic); 2 external calls (get, assert!).


##### `unified_exec_disabled_windows_sandbox_rejects_managed_read_only_command`  (lines 93–161)

```
async fn unified_exec_disabled_windows_sandbox_rejects_managed_read_only_command() -> Result<()>
```

**Purpose**: On Windows, verifies that unified exec rejects a managed read-only command when Windows sandbox features are disabled in config. The expected tool output must mention the original command and that it was blocked by policy.

**Data flow**: Builds a test config that enables `Feature::UnifiedExec`, disables `Feature::WindowsSandbox` and `Feature::WindowsSandboxElevated`, and turns off both Windows sandbox booleans. It mounts one SSE sequence that requests `exec_command` with `cmd.exe /c dir`, then a second assistant-completion sequence, submits a user turn via `submit_user_turn` with `AskForApproval::Never` and `PermissionProfile::read_only()`, waits for `TurnComplete`, extracts the function-call output for the known `call_id`, and asserts the output string contains both the command text and `rejected: blocked by policy`.

**Call relations**: This Tokio test is entered by the harness on Windows only. It relies on `submit_user_turn` for protocol submission and on `mount_sse_once`/`wait_for_event` to drive and observe the full request-response cycle.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, submit_user_turn, read_only); 4 external calls (assert!, wait_for_event, json!, vec!).


##### `execpolicy_blocks_shell_invocation`  (lines 164–256)

```
async fn execpolicy_blocks_shell_invocation() -> Result<()>
```

**Purpose**: Confirms that a local exec policy rule forbidding commands starting with `echo` blocks a `shell_command` invocation and surfaces the policy reason in `ExecCommandEnd`. It validates policy-file loading and enforcement.

**Data flow**: Before building the test instance, it writes `rules/policy.rules` under `config.codex_home` containing `prefix_rule(pattern=["echo"], decision="forbidden")`. It mounts SSE responses that request `shell_command` with `echo blocked`, then manually constructs and submits `Op::UserInput` with local environment selections, `AskForApproval::Never`, and permission fields derived from `PermissionProfile::Disabled`. It waits for an `EventMsg::ExecCommandEnd`, then for `TurnComplete`, and asserts that `end.aggregated_output` contains `policy forbids commands starting with \`echo\``.

**Call relations**: Unlike the other tests in this file, this one inlines the `Op::UserInput` construction instead of using `submit_user_turn`, because it directly inspects the emitted `ExecCommandEnd` event before turn completion.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); 6 external calls (default, assert!, wait_for_event, json!, unreachable!, vec!).


##### `shell_command_empty_script_with_collaboration_mode_does_not_panic`  (lines 259–311)

```
async fn shell_command_empty_script_with_collaboration_mode_does_not_panic() -> Result<()>
```

**Purpose**: Regression-tests that an empty `shell_command` script under collaboration mode completes without leaking the matched-rules invariant panic. It targets a previously fragile edge case in approval/policy evaluation.

**Data flow**: Builds a test instance with model `gpt-5.2` and `Feature::CollaborationModes` enabled, mounts SSE responses that request `shell_command` with an empty `command` string and then complete the turn, constructs a collaboration mode via `collaboration_mode_for_model`, submits the turn through `submit_user_turn` with `AskForApproval::OnRequest` and `PermissionProfile::Disabled`, waits for `TurnComplete`, extracts the function-call output from the recorded request, and passes it to `assert_no_matched_rules_invariant`.

**Call relations**: This test uses both helper functions—`collaboration_mode_for_model` to build thread settings and `submit_user_turn` to send them—then finishes with `assert_no_matched_rules_invariant` as its regression oracle.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_no_matched_rules_invariant, collaboration_mode_for_model, submit_user_turn); 3 external calls (wait_for_event, json!, vec!).


##### `unified_exec_empty_script_with_collaboration_mode_does_not_panic`  (lines 314–370)

```
async fn unified_exec_empty_script_with_collaboration_mode_does_not_panic() -> Result<()>
```

**Purpose**: Checks the same empty-script regression for `exec_command` when unified exec and collaboration modes are enabled. It ensures the unified exec path handles blank commands safely.

**Data flow**: Creates a test instance with model `gpt-5.2`, enables `Feature::UnifiedExec` and `Feature::CollaborationModes`, mounts SSE responses that request `exec_command` with empty `cmd`, builds a collaboration mode from the session model, submits the turn with `submit_user_turn`, waits for `TurnComplete`, extracts the function-call output for the known call id, and verifies via `assert_no_matched_rules_invariant` that no invariant panic text appears.

**Call relations**: This follows the same helper-driven flow as the shell variant, but exercises the unified exec tool path by enabling the feature and mocking `exec_command` instead of `shell_command`.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_no_matched_rules_invariant, collaboration_mode_for_model, submit_user_turn); 3 external calls (wait_for_event, json!, vec!).


##### `shell_command_whitespace_script_with_collaboration_mode_does_not_panic`  (lines 373–425)

```
async fn shell_command_whitespace_script_with_collaboration_mode_does_not_panic() -> Result<()>
```

**Purpose**: Verifies that a whitespace-only shell script under collaboration mode also avoids the matched-rules invariant panic. It distinguishes blank input from syntactically present but semantically empty input.

**Data flow**: Builds a `gpt-5.2` test instance with collaboration modes enabled, mounts SSE responses that request `shell_command` with `"  \n\t  "`, creates a collaboration mode, submits the turn with `AskForApproval::OnRequest` and disabled permissions, waits for `TurnComplete`, extracts the function-call output, and checks it with `assert_no_matched_rules_invariant`.

**Call relations**: This test mirrors the empty-shell case but changes only the tool argument payload to whitespace, reusing `collaboration_mode_for_model`, `submit_user_turn`, and `assert_no_matched_rules_invariant`.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_no_matched_rules_invariant, collaboration_mode_for_model, submit_user_turn); 3 external calls (wait_for_event, json!, vec!).


##### `unified_exec_whitespace_script_with_collaboration_mode_does_not_panic`  (lines 428–484)

```
async fn unified_exec_whitespace_script_with_collaboration_mode_does_not_panic() -> Result<()>
```

**Purpose**: Regression-tests whitespace-only unified exec commands under collaboration mode. It ensures the unified exec policy path treats whitespace-only input without panicking.

**Data flow**: Builds a `gpt-5.2` test instance with both unified exec and collaboration modes enabled, mounts SSE responses that request `exec_command` with `cmd` set to whitespace, derives a collaboration mode from the session model, submits the turn through `submit_user_turn`, waits for `TurnComplete`, extracts the output item from the mock request, and asserts through `assert_no_matched_rules_invariant` that the invariant panic text is absent.

**Call relations**: This is the unified-exec counterpart to the shell whitespace test, using the same helper chain and differing only in enabled features and mocked tool name.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_no_matched_rules_invariant, collaboration_mode_for_model, submit_user_turn); 3 external calls (wait_for_event, json!, vec!).


### `core/tests/suite/skill_approval.rs`

`test` · `request handling`

This Unix-only test file sets up synthetic skills under the Codex home directory and then drives them through the zsh-fork execution path. The helpers create skill metadata (`skills/<name>/agents/openai.yaml`), write executable shell scripts under `skills/<name>/scripts`, and build the exact JSON argument string expected by the `shell_command` tool. `submit_turn_with_policies` is the central turn-submission helper: it derives sandbox and permission-profile fields from the requested profile, injects local environment selections, and submits a `UserInput` turn with explicit approval policy and collaboration settings.

The first test constructs a skill whose metadata declares write access to an external directory, but whose script attempts to write outside the workspace under a restrictive workspace-write profile. It then confirms no `ExecApprovalRequest` is emitted, proving the old skill-approval gate is gone, and inspects the recorded tool output to ensure execution was governed by the turn sandbox instead. The second test removes the skill layer entirely and directly verifies that zsh-fork still blocks an out-of-workspace `touch`. A small predicate helper recognizes common sandbox-denial strings across environments (`Permission denied`, `Operation not permitted`, `Read-only file system`), making the assertions robust to platform-specific wording.

#### Function details

##### `write_skill_metadata`  (lines 27–32)

```
fn write_skill_metadata(home: &Path, name: &str, contents: &str) -> Result<()>
```

**Purpose**: Creates the on-disk metadata file for a test skill under the Codex home directory.

**Data flow**: Takes a home path, skill name, and YAML contents. It builds `home/skills/<name>/agents`, creates the directory tree, writes `openai.yaml` there, and returns `Ok(())` or an I/O error.

**Call relations**: Used during zsh-fork test setup to install a skill metadata file that declares permissions, allowing the tests to verify those declarations no longer affect runtime sandboxing.

*Call graph*: 3 external calls (join, create_dir_all, write).


##### `shell_command_arguments`  (lines 34–39)

```
fn shell_command_arguments(command: &str) -> Result<String>
```

**Purpose**: Serializes a shell command into the JSON argument string expected by the `shell_command` tool in these tests.

**Data flow**: Accepts a command string, wraps it in JSON with `timeout_ms: 500`, serializes that JSON to a `String`, and returns it as `Result<String>`.

**Call relations**: Both zsh-fork tests call this before mounting a mocked `shell_command` function call response.

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

**Purpose**: Submits a user turn with explicit approval and permission settings derived from the requested profile.

**Data flow**: Receives a `TestCodex`, prompt text, `AskForApproval` policy, and `PermissionProfile`. It computes `(sandbox_policy, permission_profile)` via `turn_permission_fields`, builds an `Op::UserInput` containing a single text item plus thread settings such as local environment selections, approval policy, sandbox policy, permission profile, and collaboration mode, submits it through `test.codex`, and returns `Ok(())` after the async submission completes.

**Call relations**: This helper is the common entry point for both tests so they can vary approval policy and sandbox profile without duplicating the full `Op::UserInput` construction.

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

**Purpose**: Creates a complete test skill containing `SKILL.md` and an executable shell script.

**Data flow**: Given a home path, skill name, script filename, and script contents, it creates `skills/<name>/scripts`, writes a minimal frontmatter-based `SKILL.md`, writes the script file, reads its metadata, sets Unix mode `0o755`, persists the permissions, and returns the script path.

**Call relations**: Used in the first zsh-fork test’s setup hook to install the executable skill script that will attempt a sandboxed write.

*Call graph*: 6 external calls (join, format!, create_dir_all, metadata, set_permissions, write).


##### `skill_script_command`  (lines 109–116)

```
fn skill_script_command(test: &TestCodex, script_name: &str) -> Result<String>
```

**Purpose**: Builds a shell-safe command string that invokes a specific installed skill script by absolute path.

**Data flow**: Takes a `TestCodex` and script name, canonicalizes `codex_home/skills/mbolin-test-skill/scripts/<script_name>`, shell-quotes that single path with `shlex::try_join`, and returns the resulting command string.

**Call relations**: The skill-permissions test uses this to ensure the mocked `shell_command` call executes the exact installed script rather than relying on PATH lookup.

*Call graph*: calls 1 internal fn (codex_home_path); called by 1 (shell_zsh_fork_skill_scripts_ignore_declared_permissions); 2 external calls (canonicalize, try_join).


##### `wait_for_exec_approval_request`  (lines 118–125)

```
async fn wait_for_exec_approval_request(test: &TestCodex) -> Option<ExecApprovalRequestEvent>
```

**Purpose**: Waits until either an execution approval request arrives or the turn completes without one.

**Data flow**: Observes events from `test.codex` using `wait_for_event_match`. It returns `Some(request)` when it sees `EventMsg::ExecApprovalRequest`, `None` when it sees `TurnComplete` first, and keeps waiting on other events.

**Call relations**: The first test uses this to prove that skill-script execution no longer triggers the removed skill approval path.

*Call graph*: called by 1 (shell_zsh_fork_skill_scripts_ignore_declared_permissions); 1 external calls (wait_for_event_match).


##### `wait_for_turn_complete`  (lines 127–132)

```
async fn wait_for_turn_complete(test: &TestCodex)
```

**Purpose**: Blocks until the current turn emits `TurnComplete`.

**Data flow**: Consumes a `TestCodex` reference and waits on its event stream until an event matches `EventMsg::TurnComplete(_)`.

**Call relations**: Both tests call this after submission so they can safely inspect recorded tool outputs and filesystem side effects.

*Call graph*: called by 2 (shell_zsh_fork_skill_scripts_ignore_declared_permissions, shell_zsh_fork_still_enforces_workspace_write_sandbox); 1 external calls (wait_for_event).


##### `output_shows_sandbox_denial`  (lines 134–138)

```
fn output_shows_sandbox_denial(output: &str) -> bool
```

**Purpose**: Recognizes common textual indicators that a shell command was blocked by sandbox restrictions.

**Data flow**: Takes an output string slice and returns `true` if it contains `Permission denied`, `Operation not permitted`, or `Read-only file system`; otherwise returns `false`.

**Call relations**: Used in both tests to make assertions resilient to environment-specific denial wording.


##### `shell_zsh_fork_skill_scripts_ignore_declared_permissions`  (lines 142–233)

```
async fn shell_zsh_fork_skill_scripts_ignore_declared_permissions() -> Result<()>
```

**Purpose**: Verifies that skill metadata declaring filesystem write permissions does not bypass the turn sandbox when a zsh-fork skill script runs.

**Data flow**: Skips without network, acquires a zsh-fork runtime, defines a granular approval policy with `skill_approval: false`, creates an external allowed directory and a script that writes there, formats matching permissions YAML, starts a mock server, builds a zsh-fork test whose setup hook installs the script and metadata, computes the script command and serialized shell arguments, mounts a mocked `shell_command` response, submits a turn under the restrictive workspace-write profile, waits for any exec approval request, waits for turn completion, then inspects the recorded function-call output and filesystem. It asserts no approval request occurred, no old execution-denied message appears, the sandbox blocked or prevented the write, and the external file was not created.

**Call relations**: This is the main regression test for the removed skill approval path. It combines all helpers in the file plus zsh-fork-specific builders from test support.

*Call graph*: calls 10 internal fn (mount_function_call_agent_response, start_mock_server, build_zsh_fork_test, restrictive_workspace_write_profile, zsh_fork_runtime, shell_command_arguments, skill_script_command, submit_turn_with_policies, wait_for_exec_approval_request, wait_for_turn_complete); 8 external calls (Granular, assert!, format!, create_dir_all, try_join, skip_if_no_network!, current_dir, tempdir_in).


##### `shell_zsh_fork_still_enforces_workspace_write_sandbox`  (lines 237–291)

```
async fn shell_zsh_fork_still_enforces_workspace_write_sandbox() -> Result<()>
```

**Purpose**: Verifies that zsh-fork execution still respects the workspace-write sandbox for ordinary shell commands that try to write outside the workspace.

**Data flow**: Skips without network, acquires a zsh-fork runtime, starts a mock server, defines an outside `/tmp` path, builds a restrictive workspace-write test, serializes a `touch` command into shell arguments, mounts a mocked `shell_command` response, submits the turn with `AskForApproval::Never`, waits for turn completion, then inspects the recorded tool output and the target path. It asserts the output indicates sandbox denial and the outside file does not exist.

**Call relations**: This is the simpler control test that confirms the underlying turn sandbox remains effective even without any skill metadata involved.

*Call graph*: calls 8 internal fn (mount_function_call_agent_response, start_mock_server, build_zsh_fork_test, restrictive_workspace_write_profile, zsh_fork_runtime, shell_command_arguments, submit_turn_with_policies, wait_for_turn_complete); 4 external calls (assert!, format!, remove_file, skip_if_no_network!).


### `core/tests/suite/unified_exec_zsh_fork_approvals.rs`

`test` · `approval handling during integration tests`

This file focuses on a narrower but subtle integration point: unified exec commands that request sandbox escalation and are executed through the zsh-fork runtime. The tests build a specialized `TestCodex` only when the zsh-fork runtime is available, mount mock `exec_command` tool calls that request `SandboxPermissions::RequireEscalated`, submit turns using the session's configured permission profile, and then drive approval decisions through `Op::ExecApproval`.

The three top-level tests distinguish important policy boundaries. One proves that approving the parent unified-exec command does not erase denied-read restrictions inherited from the permission profile. Another proves that parent approval does allow an intercepted shell redirection to write outside the workspace. The third adds a rules file with `prefix_rule(pattern=["touch"], decision="prompt")` and verifies that even after approving the parent command, an intercepted inner `touch` still triggers its own explicit approval request before completion.

Helper functions build permission profiles from TOML, mount the two-step SSE exchange, submit turns with `ApprovalsReviewer::User`, wait for and approve expected exec requests, and parse either JSON or legacy text output into a compact `CommandResult { exit_code, stdout }`. The design intentionally validates both modern structured output and older textual fallback formats.

#### Function details

##### `unified_exec_zsh_fork_parent_approval_preserves_denied_reads`  (lines 52–111)

```
async fn unified_exec_zsh_fork_parent_approval_preserves_denied_reads() -> Result<()>
```

**Purpose**: Verifies that approving the parent unified-exec command does not bypass a permission profile's denied-read restriction.

**Data flow**: It creates a temporary secret file outside the workspace, builds a permission profile that denies reads of that path, confirms the profile reports denied-read restrictions, constructs a zsh-fork test if available, mounts an escalated `exec_command` that runs `cat` on the denied file, submits the turn, approves the expected parent exec request, waits for completion without further approvals, then parses the command result and asserts a non-zero exit code and absence of the secret in stdout.

**Call relations**: This test composes nearly all helpers in the file: profile construction, zsh-fork fixture setup, command mounting, turn submission, approval, completion waiting, and result parsing.

*Call graph*: calls 7 internal fn (approve_expected_exec, build_unified_exec_zsh_fork_test_or_skip, command_result, denied_read_permission_profile, mount_unified_exec_command, submit_turn_with_session_permissions, wait_for_completion_without_approval); 7 external calls (assert!, assert_ne!, format!, write, skip_if_no_network!, current_dir, tempdir_in).


##### `unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec`  (lines 114–172)

```
async fn unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec() -> Result<()>
```

**Purpose**: Checks that approving the parent unified-exec command allows an intercepted shell redirection to write outside the workspace.

**Data flow**: It creates a restrictive workspace-write profile and an out-of-workspace target file, builds the zsh-fork test with a pre-build hook that removes any stale target, mounts an escalated command `printf hi > outside_path`, submits the turn, approves the expected parent exec request, waits for completion without additional approvals, parses the result, and asserts successful exit plus file contents `hi` on disk.

**Call relations**: This is the positive escalation case paired with the denied-read test. It uses the same helper flow but validates that parent approval can widen write access for the parent shell execution.

*Call graph*: calls 7 internal fn (restrictive_workspace_write_profile, approve_expected_exec, build_unified_exec_zsh_fork_test_or_skip, command_result, mount_unified_exec_command, submit_turn_with_session_permissions, wait_for_completion_without_approval); 6 external calls (assert_eq!, format!, read_to_string, skip_if_no_network!, current_dir, tempdir_in).


##### `unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule`  (lines 175–264)

```
async fn unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule() -> Result<()>
```

**Purpose**: Ensures that explicit prompt rules still trigger a second approval for intercepted inner commands even after the parent unified-exec command has been approved.

**Data flow**: It creates a restrictive profile, an out-of-workspace target path, and a rules file containing a `touch` prompt rule via the pre-build hook. It mounts an escalated `touch outside_path` command, submits the turn, approves the parent exec request, waits up to 10 seconds for either an inner `ExecApprovalRequest` or premature completion, asserts the approval request command references `/touch` and the target path, approves that inner request, waits for completion, then parses the result and asserts success and file creation.

**Call relations**: This test extends the standard approval flow by explicitly expecting a second approval event after `approve_expected_exec`, proving that parent approval does not suppress rule-driven prompts for intercepted subcommands.

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

**Purpose**: Builds the specialized zsh-fork unified-exec test fixture when the runtime is available, otherwise returns `None` so callers can skip cleanly.

**Data flow**: It takes a test name, approval policy, permission profile, and pre-build hook, queries `zsh_fork_runtime`, returns `Ok(None)` if unavailable, otherwise starts a mock server, calls `build_unified_exec_zsh_fork_test` with the runtime and supplied parameters, and returns `Some((MockServer, TestCodex))`.

**Call relations**: All three top-level tests call this helper first so they can gracefully no-op on systems without the zsh-fork runtime.

*Call graph*: calls 3 internal fn (start_mock_server, build_unified_exec_zsh_fork_test, zsh_fork_runtime); called by 3 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule, unified_exec_zsh_fork_parent_approval_preserves_denied_reads).


##### `denied_read_permission_profile`  (lines 296–309)

```
fn denied_read_permission_profile(denied_path: &Path) -> Result<PermissionProfile>
```

**Purpose**: Constructs a permission profile TOML string that grants broad read access but explicitly denies one target path.

**Data flow**: It converts the denied path into a TOML key string, interpolates it into a TOML snippet with `/ = read`, `:project_roots = write`, the denied path set to `deny`, and network disabled, then delegates to `permission_profile_from_toml`.

**Call relations**: Only the denied-read approval test uses this helper to create a profile with `has_denied_read_restrictions()`.

*Call graph*: calls 1 internal fn (permission_profile_from_toml); called by 1 (unified_exec_zsh_fork_parent_approval_preserves_denied_reads); 3 external calls (to_string_lossy, new, format!).


##### `permission_profile_from_toml`  (lines 311–355)

```
fn permission_profile_from_toml(profile: &str) -> Result<PermissionProfile>
```

**Purpose**: Parses a small TOML permission-profile fragment into a runtime `PermissionProfile` with filesystem and network sandbox policies.

**Data flow**: It deserializes `PermissionProfileToml`, extracts filesystem entries, maps `/` to `FileSystemSpecialPath::Root`, `:project_roots` to the corresponding special path, maps deny entries to `FileSystemPath::GlobPattern`, rejects unsupported entry shapes, builds `FileSystemSandboxEntry` values, creates a restricted `FileSystemSandboxPolicy`, copies `glob_scan_max_depth`, derives `NetworkSandboxPolicy` from `network.enabled`, and returns `PermissionProfile::from_runtime_permissions`.

**Call relations**: This helper is the TOML-to-runtime bridge used by `denied_read_permission_profile`; it encapsulates the exact subset of TOML syntax these tests need.

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

**Purpose**: Mounts the standard two-response SSE sequence for an approval-oriented unified-exec command: first the tool call, then a final assistant message.

**Data flow**: It formats response IDs and message IDs from `response_prefix`, builds the `exec_command` event via `exec_command_event`, mounts a first SSE response containing `response_created`, the function call, and `completed`, then mounts a second SSE response containing `assistant_message` and `completed`. It returns the `ResponseMock` for the second mount.

**Call relations**: Each top-level approval test uses this helper to prepare the mock server before submitting the turn.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, exec_command_event); called by 3 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule, unified_exec_zsh_fork_parent_approval_preserves_denied_reads); 2 external calls (format!, vec!).


##### `submit_turn_with_session_permissions`  (lines 394–433)

```
async fn submit_turn_with_session_permissions(
    test: &TestCodex,
    prompt: &str,
    approval_policy: AskForApproval,
) -> Result<()>
```

**Purpose**: Submits a user turn using the session's configured permission profile and an explicit approval policy suitable for approval-flow tests.

**Data flow**: It reads the session model and permission profile from `test.session_configured`, derives sandbox fields with `turn_permission_fields`, constructs `Op::UserInput` with one text item, local environment selections, `approval_policy`, `ApprovalsReviewer::User`, and a default collaboration mode carrying the session model, then submits it through `test.codex`.

**Call relations**: All three approval tests call this helper instead of a generic submit helper because they need to preserve the session-configured permission profile and enable user review.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 3 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule, unified_exec_zsh_fork_parent_approval_preserves_denied_reads); 2 external calls (default, vec!).


##### `approve_expected_exec`  (lines 435–438)

```
async fn approve_expected_exec(test: &TestCodex, expected_command: &str) -> Result<()>
```

**Purpose**: Waits for the next expected exec approval request and approves it.

**Data flow**: It calls `expect_exec_approval` to retrieve the pending `ExecApprovalRequestEvent`, extracts its effective approval ID, and passes that ID to `approve_exec`. It returns `Ok(())` after the approval submission succeeds.

**Call relations**: Each top-level test uses this helper for the initial parent unified-exec approval step.

*Call graph*: calls 2 internal fn (approve_exec, expect_exec_approval); called by 3 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule, unified_exec_zsh_fork_parent_approval_preserves_denied_reads).


##### `approve_exec`  (lines 440–449)

```
async fn approve_exec(test: &TestCodex, approval_id: String) -> Result<()>
```

**Purpose**: Submits an approval decision of `Approved` for a specific exec approval ID.

**Data flow**: It constructs `Op::ExecApproval { id, turn_id: None, decision: ReviewDecision::Approved }`, submits it through `test.codex`, and returns `Ok(())` on success.

**Call relations**: Called by `approve_expected_exec` for the parent approval and directly by the explicit-prompt-rule test for the second intercepted-command approval.

*Call graph*: called by 2 (approve_expected_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule).


##### `command_result`  (lines 451–453)

```
fn command_result(results: &ResponseMock, call_id: &str) -> CommandResult
```

**Purpose**: Extracts and parses the function-call output for one call ID from a `ResponseMock` into a compact `CommandResult`.

**Data flow**: It reads the single captured request from `results`, fetches the function-call output item for `call_id`, and delegates to `parse_result`, returning the resulting `CommandResult`.

**Call relations**: All three top-level tests use this helper after completion to inspect the model-visible command result.

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

**Purpose**: Builds the JSON event payload for an `exec_command` function call, optionally including yield time and sandbox-escalation fields.

**Data flow**: It starts with JSON containing `cmd`, conditionally inserts `yield_time_ms`, and if `sandbox_permissions.requests_sandbox_override()` is true also inserts `sandbox_permissions` and `justification`. It serializes the args to a string and wraps them with `ev_function_call(call_id, "exec_command", ...)`.

**Call relations**: Only `mount_unified_exec_command` calls this helper to generate the exact tool-call event shape used in these approval tests.

*Call graph*: calls 2 internal fn (ev_function_call, requests_sandbox_override); called by 1 (mount_unified_exec_command); 2 external calls (json!, to_string).


##### `parse_result`  (lines 476–501)

```
fn parse_result(item: &Value) -> CommandResult
```

**Purpose**: Parses a function-call output item into `CommandResult`, supporting both structured JSON output and legacy text formats.

**Data flow**: It reads `item["output"]` as a string; if absent, it returns `CommandResult { exit_code: None, stdout: "" }`. If the string parses as JSON, it extracts `metadata.exit_code` and `output`. Otherwise it tries two regex-based legacy formats and falls back to treating the whole string as stdout with no exit code.

**Call relations**: This parser is used only by `command_result`, letting the tests tolerate multiple output encodings from the underlying tool implementation.

*Call graph*: calls 1 internal fn (parsed_regex_result); called by 1 (command_result); 2 external calls (new, get).


##### `parsed_regex_result`  (lines 503–512)

```
fn parsed_regex_result(pattern: &str, output_str: &str) -> Option<CommandResult>
```

**Purpose**: Parses one legacy textual command-result format using a supplied regex pattern with exit code and output capture groups.

**Data flow**: It compiles the regex, matches it against `output_str`, parses capture group 1 as `i64` exit code, reads capture group 2 as stdout, and returns `Some(CommandResult)` or `None` if any step fails.

**Call relations**: This is a fallback helper used by `parse_result` after JSON parsing fails.

*Call graph*: called by 1 (parse_result); 1 external calls (new).


##### `expect_exec_approval`  (lines 514–542)

```
async fn expect_exec_approval(
    test: &TestCodex,
    expected_command: &str,
) -> ExecApprovalRequestEvent
```

**Purpose**: Waits for the next exec approval request and asserts it corresponds to the expected parent unified-exec command.

**Data flow**: It waits until either `EventMsg::ExecApprovalRequest` or `TurnComplete` arrives. On approval, it inspects the last command argument, asserts it equals `expected_command`, and returns the approval event. On premature completion or any other event shape it panics.

**Call relations**: `approve_expected_exec` uses this helper to ensure the approval being granted is for the intended parent command, not some unrelated request.

*Call graph*: called by 1 (approve_expected_exec); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `wait_for_completion_without_approval`  (lines 544–560)

```
async fn wait_for_completion_without_approval(test: &TestCodex)
```

**Purpose**: Waits for turn completion and fails if any unexpected approval request appears first.

**Data flow**: It waits for either `ExecApprovalRequest` or `TurnComplete`; if completion arrives it returns unit, and if an approval request or other event arrives it panics with diagnostic information.

**Call relations**: The denied-read and parent-escalation tests call this after approving the parent command to assert no second approval is required in those scenarios.

*Call graph*: called by 2 (unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_preserves_denied_reads); 2 external calls (wait_for_event, panic!).


##### `wait_for_completion`  (lines 562–567)

```
async fn wait_for_completion(test: &TestCodex)
```

**Purpose**: Blocks until the turn emits `TurnComplete`.

**Data flow**: It waits on the codex event stream until the predicate matches `EventMsg::TurnComplete(_)`, then returns unit.

**Call relations**: Only the explicit-prompt-rule test uses this simpler helper because it intentionally handles the intermediate approval itself before waiting for final completion.

*Call graph*: called by 1 (unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule); 1 external calls (wait_for_event).


### Permission request flows
These files cover how permissions are requested, granted, persisted, and later consumed through both inline and standalone tool-driven paths.

### `core/tests/suite/request_permissions.rs`

`test` · `integration test execution for approval prompts and permission escalation during command handling`

This module is a broad integration suite for permission escalation during command execution. It defines lightweight helpers for constructing synthetic tool-call events (`shell_command`, `exec_command`, and `request_permissions`), submitting turns with explicit local environment selections and approval settings, waiting for completion or approval events, and normalizing requested filesystem permissions into `AbsolutePathBuf` roots. The `parse_result` helper is notable: it accepts either structured JSON tool output or legacy textual output formats and extracts an exit code plus stdout, allowing the same assertions to work across multiple execution backends.

The tests cover two related mechanisms. First, inline `additional_permissions` attached to shell/exec calls should trigger `ExecApprovalRequest` under `AskForApproval::OnRequest`, resolve relative paths against the tool workdir, and remain narrowly scoped so read-only profiles do not silently widen to unrelated cwd or tmp writes. Second, the standalone `request_permissions` tool should emit `EventMsg::RequestPermissions`, accept user responses carrying `RequestPermissionsResponse`, and make granted permissions available to later shell/exec calls in the same turn. The suite checks turn-scoped grants, session-scoped grants, non-persistence across turns, partial grants that do not preapprove newly requested roots, and the auto-denial path when granular approval disables request-permissions prompts.

Most tests build a `TestCodex` with `ExecPermissionApprovals` and/or `RequestPermissionsTool` enabled, mount one or more SSE responses to simulate model tool calls, submit a turn, drive the approval or permission-response op back into the runtime, and then inspect both emitted events and actual filesystem side effects. The repeated use of canonicalized paths is intentional: assertions compare normalized permission roots rather than the raw paths originally requested by the model.

#### Function details

##### `absolute_path`  (lines 46–48)

```
fn absolute_path(path: &Path) -> AbsolutePathBuf
```

**Purpose**: Converts a borrowed `Path` into an `AbsolutePathBuf` and panics if the path is not absolute. It is the basic normalization primitive for requested permission roots.

**Data flow**: Takes `&Path`, calls `AbsolutePathBuf::try_from`, and returns the absolute wrapper or panics with `absolute path`.

**Call relations**: Used by permission-construction helpers and inline test setup whenever a request profile needs an absolute filesystem root.

*Call graph*: calls 1 internal fn (try_from).


##### `parse_result`  (lines 55–92)

```
fn parse_result(item: &Value) -> CommandResult
```

**Purpose**: Normalizes tool output into a `CommandResult { exit_code, stdout }` regardless of whether the output is structured JSON or one of two legacy textual formats. This lets tests assert command success/failure uniformly.

**Data flow**: Reads `item["output"]` as a string. It first tries to parse that string as JSON and, if successful, extracts `metadata.exit_code` and `output`. If JSON parsing fails, it applies two regexes matching `Exit code: ... Output:` and `Process exited with code ... Output:` textual layouts; if neither matches, it returns `exit_code = None` and the raw output string as stdout.

**Call relations**: Many tests call this after extracting a function-call output from the mock request log so they can assert on exit status and stdout without caring which backend formatting was used.

*Call graph*: called by 12 (partial_request_permissions_grants_do_not_preapprove_new_permissions, read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write, read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write, relative_additional_permissions_resolve_against_tool_workdir, request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns, with_additional_permissions_denied_approval_blocks_execution (+2 more)); 2 external calls (new, get).


##### `shell_event_with_request_permissions`  (lines 94–107)

```
fn shell_event_with_request_permissions(
    call_id: &str,
    command: &str,
    additional_permissions: &S,
) -> Result<Value>
```

**Purpose**: Builds a synthetic `shell_command` function-call event whose arguments request additional sandbox permissions. It is used to simulate model output that asks for inline permission widening.

**Data flow**: Accepts a call id, shell command string, and serializable additional-permissions payload, wraps them in JSON with `timeout_ms = 1000` and `sandbox_permissions = SandboxPermissions::WithAdditionalPermissions`, serializes the JSON to a string, and returns the `ev_function_call` value.

**Call relations**: Inline-additional-permissions tests use this helper to mount the first SSE response that triggers an exec approval prompt.

*Call graph*: calls 1 internal fn (ev_function_call); called by 5 (read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write, read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write, with_additional_permissions_denied_approval_blocks_execution, with_additional_permissions_requires_approval_under_on_request, workspace_write_with_additional_permissions_can_write_outside_cwd); 2 external calls (json!, to_string).


##### `request_permissions_tool_event`  (lines 109–120)

```
fn request_permissions_tool_event(
    call_id: &str,
    reason: &str,
    permissions: &RequestPermissionProfile,
) -> Result<Value>
```

**Purpose**: Builds a synthetic `request_permissions` tool-call event with a reason string and requested permission profile. It models the standalone permission-request tool.

**Data flow**: Takes a call id, reason, and `RequestPermissionProfile`, serializes `{ reason, permissions }` to JSON, and returns an `ev_function_call` for tool name `request_permissions`.

**Call relations**: Used by tests that exercise the explicit request-permissions flow before a later shell or exec command.

*Call graph*: calls 1 internal fn (ev_function_call); called by 1 (request_permissions_tool_is_auto_denied_when_granular_request_permissions_is_disabled); 2 external calls (json!, to_string).


##### `shell_command_event`  (lines 122–129)

```
fn shell_command_event(call_id: &str, command: &str) -> Result<Value>
```

**Purpose**: Constructs a plain `shell_command` function-call event without inline additional permissions. It is used after a prior request-permissions grant should already authorize the command.

**Data flow**: Serializes `{ command, timeout_ms: 1000 }` and wraps it in `ev_function_call(call_id, "shell_command", ...)`, returning the resulting JSON value.

**Call relations**: Later-shell-command grant tests use this helper for the second SSE response after a standalone permission grant.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `exec_command_event`  (lines 131–138)

```
fn exec_command_event(call_id: &str, command: &str) -> Result<Value>
```

**Purpose**: Constructs a plain `exec_command` function-call event without inline additional permissions. It represents a later command that should rely on previously granted permissions.

**Data flow**: Serializes `{ cmd, yield_time_ms: 1000 }` and returns `ev_function_call(call_id, "exec_command", ...)`.

**Call relations**: Used in tests where a prior `request_permissions` grant should make a later exec command runnable.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `exec_command_event_with_request_permissions`  (lines 140–153)

```
fn exec_command_event_with_request_permissions(
    call_id: &str,
    command: &str,
    additional_permissions: &S,
) -> Result<Value>
```

**Purpose**: Builds an `exec_command` event that includes inline `additional_permissions` and the `WithAdditionalPermissions` sandbox mode. It simulates a command explicitly restating the permissions it needs.

**Data flow**: Accepts call id, command, and serializable additional-permissions payload, serializes `{ cmd, yield_time_ms, sandbox_permissions, additional_permissions }`, and returns the corresponding `ev_function_call` JSON.

**Call relations**: Used by tests that verify explicit inline permissions can be preapproved by an earlier standalone grant, and by the partial-grant test.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `exec_command_event_with_missing_additional_permissions`  (lines 155–166)

```
fn exec_command_event_with_missing_additional_permissions(
    call_id: &str,
    command: &str,
) -> Result<Value>
```

**Purpose**: Constructs an invalid `exec_command` event that requests `WithAdditionalPermissions` sandbox mode but omits the `additional_permissions` field. It is used to prove grants do not silently carry across turns.

**Data flow**: Serializes `{ cmd, yield_time_ms, sandbox_permissions: WithAdditionalPermissions }` without an `additional_permissions` key and returns the `ev_function_call` JSON.

**Call relations**: Only the cross-turn non-persistence test uses this helper to provoke the expected validation error output.

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

**Purpose**: Submits a user turn configured for local execution with explicit approval policy, permission profile, and collaboration mode. It centralizes the thread-settings boilerplate shared by all permission tests.

**Data flow**: Takes a `TestCodex`, prompt, `AskForApproval`, and core `PermissionProfile`. It derives `(sandbox_policy, permission_profile)` via `turn_permission_fields(permission_profile, test.cwd.path())`, builds an `Op::UserInput` with one text item, local environment selections rooted at `test.config.cwd`, `ApprovalsReviewer::User`, and a default collaboration mode using `test.session_configured.model`, submits it, and returns `Result<()>`.

**Call relations**: Nearly every test in the file calls this helper before waiting for either an approval event, a request-permissions event, or turn completion.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 14 (partial_request_permissions_grants_do_not_preapprove_new_permissions, read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write, read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write, relative_additional_permissions_resolve_against_tool_workdir, request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns (+4 more)); 2 external calls (default, vec!).


##### `wait_for_completion`  (lines 207–212)

```
async fn wait_for_completion(test: &TestCodex)
```

**Purpose**: Blocks until the current turn emits `EventMsg::TurnComplete`. It is a tiny synchronization helper used after approvals have been resolved.

**Data flow**: Consumes `&TestCodex`, waits on `wait_for_event` with a predicate matching `TurnComplete`, and returns unit.

**Call relations**: Called after approval or permission-response submission in tests that need to ensure all side effects and mock outputs have been produced.

*Call graph*: called by 13 (partial_request_permissions_grants_do_not_preapprove_new_permissions, read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write, read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write, relative_additional_permissions_resolve_against_tool_workdir, request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns (+3 more)); 1 external calls (wait_for_event).


##### `expect_exec_approval`  (lines 214–239)

```
async fn expect_exec_approval(
    test: &TestCodex,
    expected_command: &str,
) -> ExecApprovalRequestEvent
```

**Purpose**: Waits for the next relevant event and asserts it is an `ExecApprovalRequest` for the expected command. It validates the command payload before returning the approval event.

**Data flow**: Reads events until either `ExecApprovalRequest` or `TurnComplete` appears. On approval, it inspects `approval.command.last()` and asserts it equals `expected_command`, then returns the `ExecApprovalRequestEvent`; on completion or any other event it panics.

**Call relations**: Inline-additional-permissions tests and the partial-grant test use this helper to capture the approval prompt they expect before sending `Op::ExecApproval`.

*Call graph*: called by 7 (partial_request_permissions_grants_do_not_preapprove_new_permissions, read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write, read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write, relative_additional_permissions_resolve_against_tool_workdir, with_additional_permissions_denied_approval_blocks_execution, with_additional_permissions_requires_approval_under_on_request, workspace_write_with_additional_permissions_can_write_outside_cwd); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `wait_for_exec_approval_or_completion`  (lines 241–257)

```
async fn wait_for_exec_approval_or_completion(
    test: &TestCodex,
) -> Option<ExecApprovalRequestEvent>
```

**Purpose**: Waits for either an exec approval prompt or immediate turn completion and returns `Some(approval)` only when a prompt actually occurs. It supports tests where a prior grant may or may not suppress approval.

**Data flow**: Consumes `&TestCodex`, waits for `ExecApprovalRequest` or `TurnComplete`, maps approval to `Some(event)`, completion to `None`, and panics on any unexpected event.

**Call relations**: Grant-propagation tests use this helper because the runtime may preapprove the later command and skip the prompt entirely.

*Call graph*: called by 4 (request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_preapprove_explicit_exec_permissions_outside_on_request); 2 external calls (wait_for_event, panic!).


##### `expect_request_permissions_event`  (lines 259–279)

```
async fn expect_request_permissions_event(
    test: &TestCodex,
    expected_call_id: &str,
) -> RequestPermissionProfile
```

**Purpose**: Waits for a standalone `request_permissions` prompt and returns the normalized permission profile carried by the event. It fails if the turn completes before the prompt appears.

**Data flow**: Reads events until `RequestPermissions` or `TurnComplete`. On `RequestPermissions`, it asserts the `call_id` matches `expected_call_id` and returns `request.permissions`; on completion or any other event it panics.

**Call relations**: All standalone request-permissions tests call this helper before submitting `Op::RequestPermissionsResponse`.

*Call graph*: called by 7 (partial_request_permissions_grants_do_not_preapprove_new_permissions, request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `workspace_write_excluding_tmp`  (lines 281–288)

```
fn workspace_write_excluding_tmp() -> CorePermissionProfile
```

**Purpose**: Constructs a core permission profile that grants workspace write access while explicitly excluding tmp-related write allowances. This narrower baseline makes outside-workspace permission requests meaningful in tests.

**Data flow**: Calls `CorePermissionProfile::workspace_write_with(&[], NetworkSandboxPolicy::Restricted, true, true)` and returns the resulting profile.

**Call relations**: Used as the baseline permission profile in most tests that need to request additional write access outside the workspace.

*Call graph*: called by 9 (partial_request_permissions_grants_do_not_preapprove_new_permissions, request_permissions_grants_apply_to_later_exec_command_calls, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns, with_additional_permissions_denied_approval_blocks_execution, workspace_write_with_additional_permissions_can_write_outside_cwd); 1 external calls (workspace_write_with).


##### `requested_directory_write_permissions`  (lines 290–298)

```
fn requested_directory_write_permissions(path: &Path) -> RequestPermissionProfile
```

**Purpose**: Builds a `RequestPermissionProfile` requesting write access to a specific directory path as originally specified. It preserves the raw absolute path rather than canonicalizing it.

**Data flow**: Takes `&Path`, wraps it with `absolute_path`, constructs `FileSystemPermissions::from_read_write_roots(Some(vec![]), Some(vec![...]))`, inserts that into a default `RequestPermissionProfile`, and returns it.

**Call relations**: Used in tests that compare the model-requested permissions with the normalized permissions later emitted by the runtime.

*Call graph*: calls 1 internal fn (from_read_write_roots); called by 7 (partial_request_permissions_grants_do_not_preapprove_new_permissions, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns, request_permissions_tool_is_auto_denied_when_granular_request_permissions_is_disabled); 2 external calls (default, vec!).


##### `normalized_directory_write_permissions`  (lines 300–308)

```
fn normalized_directory_write_permissions(path: &Path) -> Result<RequestPermissionProfile>
```

**Purpose**: Builds a canonicalized `RequestPermissionProfile` for a directory write root. It represents the normalized form the runtime should emit or store after resolving symlinks and relative segments.

**Data flow**: Canonicalizes the input path with `path.canonicalize()?`, converts it to `AbsolutePathBuf`, wraps it in `FileSystemPermissions::from_read_write_roots`, inserts that into a default `RequestPermissionProfile`, and returns `Result<RequestPermissionProfile>`.

**Call relations**: Tests use this helper for expected values when asserting emitted request-permissions events or approved permission sets.

*Call graph*: calls 1 internal fn (from_read_write_roots); called by 6 (partial_request_permissions_grants_do_not_preapprove_new_permissions, request_permissions_grants_apply_to_later_shell_command_calls, request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature, request_permissions_grants_do_not_carry_across_turns, request_permissions_preapprove_explicit_exec_permissions_outside_on_request, request_permissions_session_grants_carry_across_turns); 2 external calls (default, vec!).


##### `with_additional_permissions_requires_approval_under_on_request`  (lines 311–399)

```
async fn with_additional_permissions_requires_approval_under_on_request() -> Result<()>
```

**Purpose**: Verifies that a shell command carrying inline additional permissions triggers an exec approval prompt under `AskForApproval::OnRequest`, and that approving the prompt allows the command to run and create the requested file.

**Data flow**: Builds a read-only `TestCodex` with `ExecPermissionApprovals` and `RequestPermissionsTool` enabled, creates a requested directory and expected write path, mounts one SSE response containing a `shell_command` with inline additional write permissions and a second response for completion, submits the turn, captures the `ExecApprovalRequest`, asserts its `additional_permissions` match the requested profile, submits `Op::ExecApproval { Approved }`, waits for completion, parses the tool output with `parse_result`, and asserts success plus file creation.

**Call relations**: This is the baseline inline-additional-permissions approval test and uses `shell_event_with_request_permissions`, `submit_turn`, `expect_exec_approval`, and `parse_result` together.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_request_permissions, submit_turn, wait_for_completion, from_read_write_roots); 9 external calls (read_only, default, assert!, assert_eq!, create_dir_all, remove_file, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `request_permissions_tool_is_auto_denied_when_granular_request_permissions_is_disabled`  (lines 402–492)

```
async fn request_permissions_tool_is_auto_denied_when_granular_request_permissions_is_disabled() -> Result<()>
```

**Purpose**: Checks that the standalone `request_permissions` tool is automatically denied when granular approval config disables request-permissions prompts, rather than surfacing an interactive event.

**Data flow**: Builds a read-only `TestCodex` with `AskForApproval::Granular` where `request_permissions = false`, enables `RequestPermissionsTool`, mounts a `request_permissions` tool call followed by completion, submits the turn, waits for either `RequestPermissions` or `TurnComplete`, asserts the turn completed directly, then parses the function-call output as `RequestPermissionsResponse` and checks it is the default empty grant with turn scope.

**Call relations**: This test uses `request_permissions_tool_event` and bypasses the normal approval-response loop to prove the auto-denial branch.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, request_permissions_tool_event, requested_directory_write_permissions, submit_turn); 10 external calls (read_only, Granular, assert!, assert_eq!, wait_for_event, create_dir_all, from_str, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `relative_additional_permissions_resolve_against_tool_workdir`  (lines 503–621)

```
async fn relative_additional_permissions_resolve_against_tool_workdir(
    command_tool: AdditionalPermissionsCommandTool,
) -> Result<()>
```

**Purpose**: Verifies that relative inline additional-permission paths are resolved against the tool's declared workdir for both `shell_command` and `exec_command` variants.

**Data flow**: Parameterized by `AdditionalPermissionsCommandTool`, it builds a read-only `TestCodex` with approval features enabled, creates a nested directory, mounts a tool call whose `workdir` is `nested` and whose additional permissions request write access to `.` relative to that workdir, submits the turn, captures the exec approval, asserts the normalized additional permissions point at the canonical nested directory, approves execution, waits for completion, parses the output, and asserts the file `nested/relative-write.txt` was created successfully.

**Call relations**: This test is the only consumer of the local enum `AdditionalPermissionsCommandTool`; it proves path resolution logic is shared correctly across shell and exec tools.

*Call graph*: calls 10 internal fn (ev_function_call, mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, submit_turn, wait_for_completion, from_read_write_roots); 11 external calls (read_only, default, assert!, assert_eq!, create_dir_all, remove_file, json!, to_string, skip_if_no_network!, skip_if_sandbox! (+1 more)).


##### `read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write`  (lines 625–724)

```
async fn read_only_with_additional_permissions_does_not_widen_to_unrequested_cwd_write() -> Result<()>
```

**Purpose**: Ensures that under a read-only baseline profile, granting inline additional permissions for one specific path does not implicitly widen write access to other files in the current working directory.

**Data flow**: On macOS only, it builds a read-only `TestCodex` with approval features enabled, defines one requested file and one different unrequested cwd file, mounts a shell command that writes to the unrequested file while requesting permission only for the requested file, submits the turn, captures and approves the exec approval, waits for completion, parses the output, and asserts the command failed and neither file was created.

**Call relations**: This negative test uses the same inline-permission machinery as the positive path but asserts that the sandbox remains narrow after approval.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_request_permissions, submit_turn, wait_for_completion, from_read_write_roots); 9 external calls (read_only, default, assert!, assert_eq!, format!, remove_file, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write`  (lines 728–828)

```
async fn read_only_with_additional_permissions_does_not_widen_to_unrequested_tmp_write() -> Result<()>
```

**Purpose**: Checks the same non-widening invariant as the previous test, but for writes into a temporary directory outside the workspace.

**Data flow**: On macOS only, it builds a read-only `TestCodex`, creates a temp directory and a distinct requested file path, mounts a shell command that writes to the temp file while requesting permission only for the unrelated requested path, submits the turn, approves the exec request, waits for completion, parses the output, and asserts the command failed and neither the requested file nor the temp target exists.

**Call relations**: This complements the cwd-widening test by proving tmp writes are not accidentally granted through unrelated additional permissions.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_request_permissions, submit_turn, wait_for_completion, from_read_write_roots); 10 external calls (read_only, default, assert!, assert_eq!, format!, remove_file, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `workspace_write_with_additional_permissions_can_write_outside_cwd`  (lines 831–937)

```
async fn workspace_write_with_additional_permissions_can_write_outside_cwd() -> Result<()>
```

**Purpose**: Verifies that a workspace-write baseline plus approved inline additional permissions can authorize writes outside the workspace without touching unrelated workspace paths.

**Data flow**: Builds a `TestCodex` with `workspace_write_excluding_tmp`, creates an outside temp directory and a placeholder path inside the workspace, mounts a shell command that writes to the outside file while requesting write access to the outside directory, submits the turn, captures the exec approval, asserts the approval carries the canonicalized outside-directory permission, approves it, waits for completion, parses the output, and asserts the outside file contains the expected text while the placeholder remains absent.

**Call relations**: This is the positive outside-workspace counterpart to the two non-widening negative tests.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_request_permissions, submit_turn, wait_for_completion, workspace_write_excluding_tmp (+1 more)); 9 external calls (default, assert!, assert_eq!, format!, remove_file, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `with_additional_permissions_denied_approval_blocks_execution`  (lines 940–1043)

```
async fn with_additional_permissions_denied_approval_blocks_execution() -> Result<()>
```

**Purpose**: Checks that denying an exec approval for inline additional permissions prevents the command from running and returns a rejection message instead of performing the write.

**Data flow**: Builds a workspace-write `TestCodex` with approval features enabled, mounts a shell command that would write outside the workspace with requested additional permissions, submits the turn, captures the approval, asserts the normalized requested permissions, submits `Op::ExecApproval { Denied }`, waits for completion, parses the output, and asserts nonzero/failed status, `rejected by user` text, and absence of the target file.

**Call relations**: This test follows the same setup as the positive inline-permission path but drives the denial branch of the approval flow.

*Call graph*: calls 11 internal fn (mount_sse_once, sse, start_mock_server, test_codex, expect_exec_approval, parse_result, shell_event_with_request_permissions, submit_turn, wait_for_completion, workspace_write_excluding_tmp (+1 more)); 9 external calls (default, assert!, assert_eq!, assert_ne!, format!, remove_file, skip_if_no_network!, tempdir, vec!).


##### `request_permissions_grants_apply_to_later_exec_command_calls`  (lines 1046–1169)

```
async fn request_permissions_grants_apply_to_later_exec_command_calls() -> Result<()>
```

**Purpose**: Verifies that a standalone `request_permissions` grant for a directory write root applies to a later plain `exec_command` in the same turn.

**Data flow**: Builds a workspace-write `TestCodex` with both permission features enabled, creates an outside temp directory and target file, mounts an SSE sequence of `request_permissions`, then plain `exec_command`, then assistant completion, submits the turn, captures the normalized `RequestPermissions` event, responds with `RequestPermissionsResponse { scope: Turn }`, optionally handles an exec approval if one still appears, waits for completion, parses the exec output, and asserts the command succeeded and wrote the expected file contents.

**Call relations**: This test uses `expect_request_permissions_event` followed by `wait_for_exec_approval_or_completion` because the grant may preapprove the later command.

*Call graph*: calls 10 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, parse_result, submit_turn, wait_for_completion, wait_for_exec_approval_or_completion, workspace_write_excluding_tmp, from_read_write_roots); 7 external calls (default, assert_eq!, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `request_permissions_preapprove_explicit_exec_permissions_outside_on_request`  (lines 1172–1291)

```
async fn request_permissions_preapprove_explicit_exec_permissions_outside_on_request() -> Result<()>
```

**Purpose**: Checks that a standalone turn-scoped permission grant also preapproves a later `exec_command` that explicitly repeats the same additional permissions inline.

**Data flow**: Builds a workspace-write `TestCodex`, prepares an outside directory and command, mounts an SSE sequence of `request_permissions`, then `exec_command` with matching inline additional permissions, then completion, submits the turn, captures and approves the normalized request-permissions event, optionally handles any remaining exec approval, waits for completion, parses the exec output, and asserts success plus file contents.

**Call relations**: This test differs from the previous one by proving that explicit inline restatement of already granted permissions does not force a new approval.

*Call graph*: calls 11 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, wait_for_completion, wait_for_exec_approval_or_completion (+1 more)); 7 external calls (assert!, assert_eq!, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `request_permissions_grants_apply_to_later_shell_command_calls`  (lines 1294–1405)

```
async fn request_permissions_grants_apply_to_later_shell_command_calls() -> Result<()>
```

**Purpose**: Verifies that a standalone permission grant applies not only to `exec_command` but also to a later plain `shell_command` in the same turn.

**Data flow**: Builds a workspace-write `TestCodex` with both features enabled, mounts `request_permissions` followed by `shell_command` and completion, submits the turn, captures the normalized request-permissions event, responds with a turn-scoped grant, optionally approves execution if prompted, waits for completion, parses the shell output, and asserts the outside file was written successfully.

**Call relations**: This is the shell-command analogue of the later-exec grant test.

*Call graph*: calls 11 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, wait_for_completion, wait_for_exec_approval_or_completion (+1 more)); 7 external calls (assert!, assert_eq!, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature`  (lines 1408–1521)

```
async fn request_permissions_grants_apply_to_later_shell_command_calls_without_inline_permission_feature() -> Result<()>
```

**Purpose**: Checks that standalone request-permissions grants still authorize later `shell_command` calls even when the inline exec-permission-approvals feature is not enabled.

**Data flow**: Builds a workspace-write `TestCodex` with only `RequestPermissionsTool` enabled, mounts `request_permissions`, then plain `shell_command`, then completion, submits the turn, captures and approves the normalized request-permissions event, optionally handles any exec approval, waits for completion, parses the shell output, and asserts the outside file was written.

**Call relations**: This test isolates the standalone grant mechanism from the inline-permission feature flag to prove they are not tightly coupled.

*Call graph*: calls 11 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, wait_for_completion, wait_for_exec_approval_or_completion (+1 more)); 7 external calls (assert!, assert_eq!, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `partial_request_permissions_grants_do_not_preapprove_new_permissions`  (lines 1524–1688)

```
async fn partial_request_permissions_grants_do_not_preapprove_new_permissions() -> Result<()>
```

**Purpose**: Verifies that granting only part of a requested permission set does not preapprove later commands that ask for additional roots beyond the granted subset. The later approval should reflect the union of already granted and newly requested permissions.

**Data flow**: Builds a workspace-write `TestCodex`, creates two outside directories, mounts an SSE sequence where `request_permissions` asks for both directories and a later `exec_command` explicitly requests only the second directory, submits the turn, captures the normalized initial request, responds with a grant for only the first directory, captures the later exec approval, extracts and sorts its merged filesystem write roots, compares them against the expected union of first and second directories, approves execution, waits for completion, parses the exec output, and asserts the second-directory write succeeded.

**Call relations**: This is the most detailed merge-behavior test in the file, combining `expect_request_permissions_event`, `expect_exec_approval`, and manual inspection of merged permission roots.

*Call graph*: calls 12 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_exec_approval, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, wait_for_completion (+2 more)); 9 external calls (default, default, assert!, assert_eq!, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `request_permissions_grants_do_not_carry_across_turns`  (lines 1691–1803)

```
async fn request_permissions_grants_do_not_carry_across_turns() -> Result<()>
```

**Purpose**: Ensures that turn-scoped permission grants expire at turn boundaries and cannot be reused implicitly in a later turn.

**Data flow**: Builds a workspace-write `TestCodex`, mounts a first turn containing `request_permissions` and completion, submits the turn, captures and approves the normalized request with `scope: Turn`, waits for completion, mounts a second turn containing an `exec_command` that requests `WithAdditionalPermissions` but omits `additional_permissions`, submits the second turn, waits for completion, and asserts the tool output contains `missing `additional_permissions``.

**Call relations**: This test uses `exec_command_event_with_missing_additional_permissions` specifically to prove that no hidden carry-over grant fills in the missing permissions on the next turn.

*Call graph*: calls 9 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, requested_directory_write_permissions, submit_turn, wait_for_completion, workspace_write_excluding_tmp); 6 external calls (assert!, assert_eq!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `request_permissions_session_grants_carry_across_turns`  (lines 1807–1942)

```
async fn request_permissions_session_grants_carry_across_turns() -> Result<()>
```

**Purpose**: Checks that session-scoped permission grants persist across turns and can authorize a later plain `exec_command` in a subsequent turn.

**Data flow**: On macOS only, it builds a workspace-write `TestCodex`, mounts a first turn with `request_permissions`, submits it, captures and approves the normalized request with `scope: Session`, waits for completion, mounts a second turn with a plain `exec_command` writing to the previously granted outside directory, submits the second turn, optionally approves execution if prompted, parses the exec output, and asserts the file write succeeded.

**Call relations**: This is the cross-turn persistence counterpart to the previous test and demonstrates the semantic difference between `PermissionGrantScope::Turn` and `PermissionGrantScope::Session`.

*Call graph*: calls 10 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, wait_for_completion, workspace_write_excluding_tmp); 7 external calls (assert_eq!, wait_for_event, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


### `core/tests/suite/request_permissions_tool.rs`

`test` · `integration test execution for standalone request-permissions tool flows`

This macOS-only module is a narrower companion to the broader request-permissions suite. It defines the same core fixtures—absolute-path conversion, requested versus normalized directory-write permission profiles, command-output parsing across JSON and legacy text formats, and a `submit_turn` helper that wires local environment selections, approval policy, sandbox policy, and optional `ApprovalsReviewer`. The tests here specifically validate that a successful `request_permissions` tool interaction can authorize later operations that do not themselves carry sandbox-expansion arguments.

The first test covers the exec path: the model first calls `request_permissions` for an outside directory, then emits a plain `exec_command` that writes into that directory. After the user responds with a turn-scoped `RequestPermissionsResponse`, the test confirms the command succeeds and the file is created with the expected contents. The second top-level test delegates to `apply_patch_after_request_permissions`, which runs twice—once with `strict_auto_review = false` and once with `true`. That helper mounts a sequence where the model requests permissions, then emits a custom `apply_patch` tool call targeting a file outside the workspace. In strict mode it also expects a guardian-style review request containing the patch path and content; in non-strict mode it asserts no `ApplyPatchApprovalRequest` is emitted after the grant. In both cases it extracts the custom tool output from the captured request stream, parses it, and verifies the patch succeeded on disk.

Overall, the file documents the intended contract of the standalone permission-request tool: once the user grants a normalized folder write root, later exec and patch operations within that root should proceed without needing to restate sandbox arguments, while strict auto-review may still trigger an internal guardian review path.

#### Function details

##### `absolute_path`  (lines 42–44)

```
fn absolute_path(path: &Path) -> AbsolutePathBuf
```

**Purpose**: Converts a borrowed path into `AbsolutePathBuf` and panics if it is not absolute. It supports construction of requested permission profiles.

**Data flow**: Takes `&Path`, calls `AbsolutePathBuf::try_from`, and returns the absolute wrapper.

**Call relations**: Used by the requested-permissions helper to build raw requested write roots.

*Call graph*: calls 1 internal fn (try_from).


##### `request_permissions_tool_event`  (lines 46–57)

```
fn request_permissions_tool_event(
    call_id: &str,
    reason: &str,
    permissions: &RequestPermissionProfile,
) -> Result<Value>
```

**Purpose**: Builds a synthetic `request_permissions` function-call event for the mock SSE stream. It packages the reason and requested permission profile exactly as the model would send them.

**Data flow**: Accepts call id, reason, and `RequestPermissionProfile`, serializes them to JSON, and returns `ev_function_call(call_id, "request_permissions", ...)`.

**Call relations**: Both top-level scenarios use this helper as the first tool call in their mounted SSE sequence.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `exec_command_event`  (lines 59–66)

```
fn exec_command_event(call_id: &str, command: &str) -> Result<Value>
```

**Purpose**: Constructs a plain `exec_command` function-call event without sandbox-expansion arguments. It is used to prove that a prior standalone grant is sufficient on its own.

**Data flow**: Serializes `{ cmd, yield_time_ms: 1000 }` and wraps it in `ev_function_call(call_id, "exec_command", ...)`.

**Call relations**: Only the exec-unblocking test uses this helper for the second step after a granted permission request.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `build_add_file_patch`  (lines 68–74)

```
fn build_add_file_patch(patch_path: &Path, content: &str) -> String
```

**Purpose**: Formats a minimal freeform apply-patch payload that adds a file with one line of content. It produces the exact patch text consumed by the custom apply_patch tool call.

**Data flow**: Takes a target `&Path` and content string, interpolates them into a `*** Begin Patch` / `*** Add File` / `*** End Patch` patch string, and returns the resulting `String`.

**Call relations**: Called only by `apply_patch_after_request_permissions` to generate the patch body for the mocked custom tool call.

*Call graph*: called by 1 (apply_patch_after_request_permissions); 1 external calls (format!).


##### `workspace_write_excluding_tmp`  (lines 76–83)

```
fn workspace_write_excluding_tmp() -> PermissionProfile
```

**Purpose**: Creates a baseline workspace-write permission profile that excludes tmp-related write allowances. This keeps the later outside-directory grant meaningful.

**Data flow**: Calls `PermissionProfile::workspace_write_with(&[], NetworkSandboxPolicy::Restricted, true, true)` and returns the profile.

**Call relations**: Used by both main scenarios as the starting permission profile before requesting extra folder access.

*Call graph*: calls 1 internal fn (workspace_write_with); called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args).


##### `requested_directory_write_permissions`  (lines 85–93)

```
fn requested_directory_write_permissions(path: &Path) -> RequestPermissionProfile
```

**Purpose**: Builds the raw requested folder-write permission profile for a directory path. It reflects what the model asks for before runtime normalization.

**Data flow**: Wraps the absolute path in `FileSystemPermissions::from_read_write_roots(Some(vec![]), Some(vec![...]))`, inserts it into a default `RequestPermissionProfile`, and returns it.

**Call relations**: Used by both scenarios to populate the `request_permissions` tool call.

*Call graph*: calls 1 internal fn (from_read_write_roots); called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args); 2 external calls (default, vec!).


##### `normalized_directory_write_permissions`  (lines 95–103)

```
fn normalized_directory_write_permissions(path: &Path) -> Result<RequestPermissionProfile>
```

**Purpose**: Builds the canonicalized expected folder-write permission profile that the runtime should emit in the `RequestPermissions` event and store after approval.

**Data flow**: Canonicalizes the input directory, converts it to `AbsolutePathBuf`, wraps it in `FileSystemPermissions::from_read_write_roots`, inserts it into a default `RequestPermissionProfile`, and returns `Result<_>`.

**Call relations**: Both scenarios compare the emitted request-permissions event against this normalized form before responding.

*Call graph*: calls 1 internal fn (from_read_write_roots); called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args); 2 external calls (default, vec!).


##### `parse_result`  (lines 105–133)

```
fn parse_result(item: &Value) -> (Option<i64>, String)
```

**Purpose**: Parses tool output into `(Option<i64>, String)` across structured JSON and legacy textual formats. It lets the tests assert patch/exec success without depending on one output encoding.

**Data flow**: Reads `item["output"]` as a string, first tries JSON parsing to extract `metadata.exit_code` and `output`, otherwise applies two regexes for textual exit-code/output layouts, and falls back to `(None, raw_output)` if neither matches.

**Call relations**: Used by both the exec and apply-patch scenarios after extracting the relevant custom tool output from captured requests.

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

**Purpose**: Submits a local user turn with explicit approval policy, permission profile, and optional reviewer. It centralizes the thread-settings boilerplate for this file's scenarios.

**Data flow**: Takes `&TestCodex`, prompt, `AskForApproval`, `PermissionProfile`, and optional `ApprovalsReviewer`. It derives sandbox and permission fields with `turn_permission_fields`, builds an `Op::UserInput` with local environment selections and a default collaboration mode using the session model, submits it, and returns `Result<()>`.

**Call relations**: Both main scenarios call this helper before waiting for the `RequestPermissions` event.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args); 2 external calls (default, vec!).


##### `wait_for_completion`  (lines 175–180)

```
async fn wait_for_completion(test: &TestCodex)
```

**Purpose**: Waits until the current turn emits `TurnComplete`. It is used in the strict apply-patch path after all approvals and guardian review have finished.

**Data flow**: Consumes `&TestCodex`, waits on `wait_for_event` for `EventMsg::TurnComplete`, and returns unit.

**Call relations**: Only `apply_patch_after_request_permissions` uses this helper.

*Call graph*: called by 1 (apply_patch_after_request_permissions); 1 external calls (wait_for_event).


##### `expect_request_permissions_event`  (lines 182–202)

```
async fn expect_request_permissions_event(
    test: &TestCodex,
    expected_call_id: &str,
) -> RequestPermissionProfile
```

**Purpose**: Waits for the standalone permission-request prompt and returns its normalized permission profile, failing if the turn completes first.

**Data flow**: Reads events until `RequestPermissions` or `TurnComplete`; on `RequestPermissions` it asserts the `call_id` matches and returns `request.permissions`, otherwise it panics.

**Call relations**: Both top-level scenarios use this helper before submitting `Op::RequestPermissionsResponse`.

*Call graph*: called by 2 (apply_patch_after_request_permissions, approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args); 3 external calls (assert_eq!, wait_for_event, panic!).


##### `approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args`  (lines 206–329)

```
async fn approved_folder_write_request_permissions_unblocks_later_exec_without_sandbox_args() -> Result<()>
```

**Purpose**: Verifies that an approved folder-write `request_permissions` call authorizes a later plain `exec_command` that does not include sandbox-expansion arguments.

**Data flow**: Builds a `TestCodex` with workspace-write baseline, on-request approvals, user reviewer, and both permission features enabled; creates an outside temp directory and target file; mounts an SSE sequence of `request_permissions`, then plain `exec_command`, then completion; submits the turn; captures and asserts the normalized request-permissions event; responds with a turn-scoped grant; optionally approves execution if an `ExecApprovalRequest` still appears; parses the exec output; and asserts success plus file creation and contents.

**Call relations**: This is the file's direct exec-path proof that standalone grants can unblock later commands without inline sandbox arguments.

*Call graph*: calls 9 internal fn (mount_sse_sequence, start_mock_server, test_codex, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn, workspace_write_excluding_tmp); 8 external calls (assert!, assert_eq!, wait_for_event, format!, skip_if_no_network!, skip_if_sandbox!, tempdir, vec!).


##### `approved_folder_write_request_permissions_unblocks_later_apply_patch`  (lines 333–341)

```
async fn approved_folder_write_request_permissions_unblocks_later_apply_patch() -> Result<()>
```

**Purpose**: Runs the apply-patch-after-grant scenario in both normal and strict-auto-review modes. It is a thin wrapper that ensures both variants are exercised.

**Data flow**: After network and sandbox guards, it calls `apply_patch_after_request_permissions(false)` and then `apply_patch_after_request_permissions(true)`, propagating any error.

**Call relations**: This top-level test delegates all substantive work to `apply_patch_after_request_permissions`.

*Call graph*: calls 1 internal fn (apply_patch_after_request_permissions); 2 external calls (skip_if_no_network!, skip_if_sandbox!).


##### `apply_patch_after_request_permissions`  (lines 343–514)

```
async fn apply_patch_after_request_permissions(strict_auto_review: bool) -> Result<()>
```

**Purpose**: Verifies that a granted folder-write permission request allows a later custom `apply_patch` outside the workspace, with optional strict auto-review behavior. In strict mode it also confirms a guardian review request contains the patch details.

**Data flow**: Builds a `TestCodex` with workspace-write baseline and permission features enabled, creates an outside temp directory and target file name/content based on `strict_auto_review`, builds a freeform add-file patch string, mounts an SSE sequence containing `request_permissions`, then `apply_patch`, optionally a guardian assistant message when strict mode is enabled, and finally completion. It submits the turn, captures and asserts the normalized request-permissions event, responds with `RequestPermissionsResponse { scope: Turn, strict_auto_review }`, then either waits for completion and inspects the guardian request body (strict mode) or asserts no `ApplyPatchApprovalRequest` occurs (non-strict mode). Finally it extracts the custom tool output for `apply-patch-call`, parses it, and asserts the patch succeeded and wrote the expected file contents.

**Call relations**: This helper is called twice by the wrapper test and contains the core logic for both strict and non-strict apply-patch-after-grant scenarios.

*Call graph*: calls 12 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, build_add_file_patch, expect_request_permissions_event, normalized_directory_write_permissions, parse_result, requested_directory_write_permissions, submit_turn (+2 more)); called by 1 (approved_folder_write_request_permissions_unblocks_later_apply_patch); 6 external calls (assert!, assert_eq!, wait_for_event, panic!, tempdir, vec!).


### User-input and review mediation
These tests follow mediated interaction paths where the system asks the user for input or routes work through review and Guardian review layers.

### `core/tests/suite/request_user_input.rs`

`test` · `integration test execution for interactive tool calls during turn handling`

This module exercises the runtime path where the model asks the user a structured question via the `request_user_input` tool. Two small helpers, `call_output` and `call_output_content_and_success`, read a captured `function_call_output` from a `ResponsesRequest`, verify the `call_id`, and return the output content with or without the optional success flag. The central helper `request_user_input_round_trip_for_mode` mounts a two-step SSE exchange: first a `request_user_input` tool call (optionally including `autoResolutionMs`) plus a synthetic rate-limits event, then a follow-up assistant response after the user answers. It submits a turn with explicit local environment selections, disabled permissions, and a chosen `CollaborationMode`, waits for `EventMsg::RequestUserInput`, asserts the question payload and optional auto-resolution timeout, and importantly confirms that `TokenCount` events are deferred while the request is pending. After submitting `Op::UserInputAnswer`, it waits for token-count and completion events, then verifies the serialized answer JSON returned to the model.

Additional tests cover interruption and mode gating. `request_user_input_interrupt_emits_deferred_token_count` proves that if the turn is interrupted while waiting for user input, the deferred token-count information from the completed upstream response is emitted before `TurnAborted`. The rejection helper `assert_request_user_input_rejected` drives the same tool call under collaboration modes where the tool should be unavailable—Execute, Default without the feature flag, and Pair Programming—and asserts the function-call output contains a human-readable rejection message rather than a structured success payload. A separate positive test enables `Feature::DefaultModeRequestUserInput` and confirms Default mode then behaves like the successful round-trip path.

#### Function details

##### `call_output`  (lines 39–50)

```
fn call_output(req: &ResponsesRequest, call_id: &str) -> String
```

**Purpose**: Extracts the content string from a captured `function_call_output` and asserts the output belongs to the expected call id. It is the strict helper for successful round-trip assertions.

**Data flow**: Takes a `ResponsesRequest` and call id, fetches the raw function-call output object, asserts its `call_id` field matches, calls `function_call_output_content_and_success`, unwraps the content, and returns it as `String`.

**Call relations**: Used by the successful round-trip helper after the second mock request is captured.

*Call graph*: calls 2 internal fn (function_call_output, function_call_output_content_and_success); called by 1 (request_user_input_round_trip_for_mode); 1 external calls (assert_eq!).


##### `call_output_content_and_success`  (lines 52–67)

```
fn call_output_content_and_success(
    req: &ResponsesRequest,
    call_id: &str,
) -> (String, Option<bool>)
```

**Purpose**: Returns both the output content and optional success flag from a captured `function_call_output`, while verifying the call id matches. It supports rejection-path assertions where success may be absent.

**Data flow**: Reads the raw function-call output object from the request, asserts `call_id` equality, calls `function_call_output_content_and_success`, unwraps the content, and returns `(String, Option<bool>)`.

**Call relations**: The rejection helper uses this function to inspect the tool output returned when `request_user_input` is unavailable.

*Call graph*: calls 2 internal fn (function_call_output, function_call_output_content_and_success); called by 1 (assert_request_user_input_rejected); 1 external calls (assert_eq!).


##### `request_user_input_round_trip_resolves_pending`  (lines 70–72)

```
async fn request_user_input_round_trip_resolves_pending() -> anyhow::Result<()>
```

**Purpose**: Runs the standard successful `request_user_input` round trip in Plan mode without an auto-resolution timeout.

**Data flow**: Delegates directly to `request_user_input_round_trip_for_mode(ModeKind::Plan, None)` and returns its result.

**Call relations**: This is a thin wrapper test around the shared round-trip helper.

*Call graph*: calls 1 internal fn (request_user_input_round_trip_for_mode).


##### `request_user_input_round_trip_emits_auto_resolution_ms`  (lines 75–77)

```
async fn request_user_input_round_trip_emits_auto_resolution_ms() -> anyhow::Result<()>
```

**Purpose**: Runs the successful round-trip scenario in Plan mode while requesting an `autoResolutionMs` timeout, verifying that the event exposes the configured timeout.

**Data flow**: Delegates to `request_user_input_round_trip_for_mode(ModeKind::Plan, Some(60_000))`.

**Call relations**: Another thin wrapper around the shared round-trip helper, differing only in the timeout argument.

*Call graph*: calls 1 internal fn (request_user_input_round_trip_for_mode).


##### `request_user_input_round_trip_for_mode`  (lines 79–229)

```
async fn request_user_input_round_trip_for_mode(
    mode: ModeKind,
    auto_resolution_ms: Option<u64>,
) -> anyhow::Result<()>
```

**Purpose**: Implements the full successful `request_user_input` flow for a chosen collaboration mode, including pending-state behavior, answer submission, deferred token counts, and verification of the tool output sent back to the model.

**Data flow**: Starts a mock server, optionally enables `Feature::DefaultModeRequestUserInput` when `mode == ModeKind::Default`, builds a `TestCodex`, constructs JSON arguments for one question and optionally inserts `autoResolutionMs`, mounts a first SSE response containing `request_user_input`, a synthetic rate-limits event, and completion, mounts a second SSE response with an assistant message, derives sandbox and permission fields for disabled permissions, submits a user turn with local environment selections and the requested collaboration mode, waits for `EventMsg::RequestUserInput`, asserts call id, question count, `auto_resolution_ms`, and `is_other`, then uses a short timeout loop over `codex.next_event()` to assert no `TokenCount` arrives while the request is unresolved. It builds a `RequestUserInputResponse` containing answer `yes`, submits `Op::UserInputAnswer`, waits for `TokenCount` and `TurnComplete`, extracts the function-call output from the second request via `call_output`, parses it as JSON, and asserts it matches the expected answers object.

**Call relations**: This helper underpins the positive tests for Plan mode and feature-enabled Default mode.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, call_output); called by 3 (request_user_input_round_trip_emits_auto_resolution_ms, request_user_input_round_trip_in_default_mode_with_feature, request_user_input_round_trip_resolves_pending); 10 external calls (default, new, assert!, assert_eq!, wait_for_event, wait_for_event_match, json!, from_str, skip_if_no_network!, vec!).


##### `ev_rate_limits`  (lines 231–249)

```
fn ev_rate_limits() -> Value
```

**Purpose**: Constructs a synthetic rate-limits event payload inserted into the mocked SSE stream. It lets the tests verify that unrelated upstream events do not bypass the pending user-input gate.

**Data flow**: Returns a fixed JSON object representing a `codex.rate_limits` event with sample plan and usage fields.

**Call relations**: Only the round-trip helper inserts this event into the first mocked response.

*Call graph*: 1 external calls (json!).


##### `request_user_input_interrupt_emits_deferred_token_count`  (lines 252–339)

```
async fn request_user_input_interrupt_emits_deferred_token_count() -> anyhow::Result<()>
```

**Purpose**: Verifies that if a turn is interrupted while waiting on `request_user_input`, any token-count information already received from the upstream response is emitted before the turn aborts.

**Data flow**: Starts a mock server, builds a default `TestCodex`, mounts one SSE response containing `request_user_input` followed by `ev_completed_with_tokens(..., 77)`, submits a Plan-mode turn with local environment selections and disabled permissions, waits for the `RequestUserInput` event, submits `Op::Interrupt`, waits for a `TokenCount` event and asserts `total_tokens == 77`, then waits for `TurnAborted` and finally asserts the original request call id.

**Call relations**: This test covers the interrupt path rather than the answer-submission path and complements the pending-token deferral assertion in the round-trip helper.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); 7 external calls (default, assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, vec!).


##### `assert_request_user_input_rejected`  (lines 341–424)

```
async fn assert_request_user_input_rejected(mode_name: &str, build_mode: F) -> anyhow::Result<()>
```

**Purpose**: Runs a `request_user_input` tool call under a supplied collaboration mode and asserts the runtime rejects it with a plain explanatory output instead of surfacing a `RequestUserInput` event.

**Data flow**: Starts a mock server, builds a default `TestCodex`, derives a slugged call id from `mode_name`, mounts a first SSE response containing `request_user_input` and a second response with an assistant message, builds the requested `CollaborationMode` using the session model, derives sandbox and permission fields for disabled permissions, submits a turn with local environment selections and that mode, waits for `TurnComplete`, captures the second request, extracts `(output, success)` via `call_output_content_and_success`, asserts `success == None`, and checks the output string equals `request_user_input is unavailable in <mode_name> mode`.

**Call relations**: The three rejection tests delegate to this helper with different mode constructors.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, call_output_content_and_success); called by 3 (request_user_input_rejected_in_default_mode_by_default, request_user_input_rejected_in_execute_mode_alias, request_user_input_rejected_in_pair_mode_alias); 7 external calls (default, assert_eq!, wait_for_event, format!, json!, skip_if_no_network!, vec!).


##### `request_user_input_rejected_in_execute_mode_alias`  (lines 427–437)

```
async fn request_user_input_rejected_in_execute_mode_alias() -> anyhow::Result<()>
```

**Purpose**: Asserts that `request_user_input` is unavailable in Execute mode.

**Data flow**: Calls `assert_request_user_input_rejected` with mode name `Execute` and a builder that returns `CollaborationMode { mode: ModeKind::Execute, ... }`.

**Call relations**: Thin wrapper around the shared rejection helper.

*Call graph*: calls 1 internal fn (assert_request_user_input_rejected).


##### `request_user_input_rejected_in_default_mode_by_default`  (lines 440–450)

```
async fn request_user_input_rejected_in_default_mode_by_default() -> anyhow::Result<()>
```

**Purpose**: Asserts that `request_user_input` is unavailable in Default mode unless the enabling feature flag is turned on.

**Data flow**: Calls `assert_request_user_input_rejected` with mode name `Default` and a builder for `ModeKind::Default`.

**Call relations**: This is the negative counterpart to the feature-enabled Default-mode round-trip test.

*Call graph*: calls 1 internal fn (assert_request_user_input_rejected).


##### `request_user_input_round_trip_in_default_mode_with_feature`  (lines 453–455)

```
async fn request_user_input_round_trip_in_default_mode_with_feature() -> anyhow::Result<()>
```

**Purpose**: Verifies that Default mode supports `request_user_input` once `Feature::DefaultModeRequestUserInput` is enabled by the shared helper.

**Data flow**: Delegates to `request_user_input_round_trip_for_mode(ModeKind::Default, None)`.

**Call relations**: Thin wrapper around the shared positive helper, specifically covering feature-gated Default mode.

*Call graph*: calls 1 internal fn (request_user_input_round_trip_for_mode).


##### `request_user_input_rejected_in_pair_mode_alias`  (lines 458–468)

```
async fn request_user_input_rejected_in_pair_mode_alias() -> anyhow::Result<()>
```

**Purpose**: Asserts that `request_user_input` is unavailable in Pair Programming mode.

**Data flow**: Calls `assert_request_user_input_rejected` with mode name `Pair Programming` and a builder for `ModeKind::PairProgramming`.

**Call relations**: Another thin wrapper around the shared rejection helper.

*Call graph*: calls 1 internal fn (assert_request_user_input_rejected).


### `core/tests/suite/review.rs`

`test` · `request handling`

This file tests review mode as a distinct execution path layered on top of normal Codex threads. The helper functions at the bottom keep setup concise: `assistant_message_sse` and `completed_sse` build common SSE payloads, `start_responses_server_with_sse` mounts one or more scripted Responses streams and returns both the `MockServer` and request log, `new_conversation_for_server` creates a fresh `CodexThread` pointed at the mock `/v1` base URL, and `resume_conversation_for_server` does the same starting from an existing rollout file.

The tests assert several review-specific invariants. Structured JSON review output must produce `EnteredReviewMode`, `ExitedReviewMode(Some(review))`, and `TurnComplete`, with the parsed `ReviewOutputEvent` matching the model payload and with parent-thread metadata headers showing `x-openai-subagent: review` plus `parent_thread_id` but no `forked_from_thread_id`. Plain-text review output must fall back into `overall_explanation`. Streaming assistant deltas are filtered during review, and structured review output should surface only one final `AgentMessage`. Model selection prefers `config.review_model` over the session model. Review requests must start from isolated input—environment context plus the review prompt, not prior parent history—while still recording interruption and final review messages back into the parent rollout. Later parent turns should then include those recorded review messages. The final test proves `/review` resolves base-branch prompts using the runtime-overridden cwd by creating a real git repo and checking that the merge-base SHA appears in the request input.

#### Function details

##### `review_op_emits_lifecycle_and_review_output`  (lines 41–201)

```
async fn review_op_emits_lifecycle_and_review_output()
```

**Purpose**: Validates the happy path where a review request returns structured JSON and the parent thread records both lifecycle events and rendered review output.

**Data flow**: It serializes a JSON review payload to text, starts a mock Responses server serving that assistant message, creates a fresh conversation, submits `Op::Review` with a custom target, waits for `EnteredReviewMode`, then for `ExitedReviewMode` and extracts its `review_output`. It compares that output to a fully constructed `ReviewOutputEvent`, waits for `TurnComplete`, reads the rollout file to recover the parent session ID, inspects the outbound request headers and turn metadata, then scans rollout lines to confirm the parent session recorded a user header mentioning full review output, a formatted finding line, a plain assistant review summary equal to `render_review_output_text(&expected)`, and no assistant XML markup.

**Call relations**: This top-level test orchestrates nearly every helper in the file: it uses `assistant_message_sse`, `start_responses_server_with_sse`, `new_conversation_for_server`, and `render_review_output_text`. It is the broadest integration check for review mode's child-thread lifecycle and parent-rollout writeback.

*Call graph*: calls 4 internal fn (render_review_output_text, assistant_message_sse, new_conversation_for_server, start_responses_server_with_sse); 12 external calls (new, new, assert!, assert_eq!, wait_for_event, panic!, from_str, from_value, json!, skip_if_no_network! (+2 more)).


##### `review_op_with_plain_text_emits_review_fallback`  (lines 209–251)

```
async fn review_op_with_plain_text_emits_review_fallback()
```

**Purpose**: Checks that non-JSON assistant output during review is wrapped into a fallback `ReviewOutputEvent` rather than failing the review lifecycle.

**Data flow**: It starts a mock server whose assistant emits plain text, creates a conversation, submits `Op::Review`, waits for `EnteredReviewMode` and `ExitedReviewMode`, extracts the `review_output`, and asserts it equals `ReviewOutputEvent { overall_explanation: "just plain text", ..Default::default() }`. It then waits for `TurnComplete` and verifies the mock server consumed its expected request.

**Call relations**: This test reuses the same setup helpers as the structured-output case but changes only the assistant payload. It proves the review parser falls back gracefully while preserving the same lifecycle events.

*Call graph*: calls 3 internal fn (assistant_message_sse, new_conversation_for_server, start_responses_server_with_sse); 7 external calls (new, default, new, assert_eq!, wait_for_event, panic!, skip_if_no_network!).


##### `review_filters_agent_message_related_events`  (lines 259–313)

```
async fn review_filters_agent_message_related_events()
```

**Purpose**: Ensures review mode suppresses assistant streaming events that would normally surface during a standard turn.

**Data flow**: It scripts a response stream containing message-item-added, output-text deltas, a final assistant message, and completion, creates a conversation, submits `Op::Review`, and then drains events until `TurnComplete`. During that drain it records whether `EnteredReviewMode` and `ExitedReviewMode` were seen and panics immediately if `EventMsg::AgentMessageContentDelta` appears.

**Call relations**: The test is driven directly by the runner and uses `wait_for_event` as a looped event drain. Its role is to verify filtering behavior inside the review flow rather than request contents or parsed review output.

*Call graph*: calls 2 internal fn (new_conversation_for_server, start_responses_server_with_sse); 6 external calls (new, new, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `review_does_not_emit_agent_message_on_structured_output`  (lines 321–389)

```
async fn review_does_not_emit_agent_message_on_structured_output()
```

**Purpose**: Verifies that structured review output produces exactly one final non-streaming `AgentMessage` and no extra assistant-message stream artifacts.

**Data flow**: It serves a structured JSON review assistant message, creates a conversation, submits `Op::Review`, then drains events until `TurnComplete` while counting `EventMsg::AgentMessage` occurrences and tracking whether review lifecycle events occurred. At the end it asserts exactly one `AgentMessage` was emitted and both lifecycle events were observed.

**Call relations**: This test complements the streaming-filter test by focusing on the final event count for structured output. It relies on the same helper setup but validates the event stream seen by the UI layer.

*Call graph*: calls 3 internal fn (assistant_message_sse, new_conversation_for_server, start_responses_server_with_sse); 7 external calls (new, new, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!).


##### `review_uses_custom_review_model_from_config`  (lines 394–440)

```
async fn review_uses_custom_review_model_from_config()
```

**Purpose**: Checks that review requests use `config.review_model` instead of the main session model when that override is configured.

**Data flow**: It starts a mock server with an immediate completion SSE, creates a conversation whose config sets `model = gpt-4.1` and `review_model = gpt-5.4`, submits `Op::Review`, waits for `EnteredReviewMode`, `ExitedReviewMode` with `review_output: None`, and `TurnComplete`, then inspects the single request body and asserts `body["model"] == "gpt-5.4"`.

**Call relations**: This test uses the generic conversation/server helpers and focuses solely on outbound request selection. It pairs with the next test, which removes the review-model override to verify fallback behavior.

*Call graph*: calls 3 internal fn (completed_sse, new_conversation_for_server, start_responses_server_with_sse); 5 external calls (new, new, assert_eq!, wait_for_event, skip_if_no_network!).


##### `review_uses_session_model_when_review_model_unset`  (lines 445–488)

```
async fn review_uses_session_model_when_review_model_unset()
```

**Purpose**: Verifies that review requests fall back to the session model when no dedicated review model is configured.

**Data flow**: It starts a completion-only mock server, creates a conversation with `model = gpt-4.1` and `review_model = None`, submits `Op::Review`, waits through the normal review lifecycle, then inspects the request body and asserts the `model` field is `gpt-4.1`.

**Call relations**: This is the control case for `review_uses_custom_review_model_from_config`. Together the two tests pin down the model-selection precedence used when constructing review requests.

*Call graph*: calls 3 internal fn (completed_sse, new_conversation_for_server, start_responses_server_with_sse); 5 external calls (new, new, assert_eq!, wait_for_event, skip_if_no_network!).


##### `review_input_isolated_from_parent_history`  (lines 496–667)

```
async fn review_input_isolated_from_parent_history()
```

**Purpose**: Ensures a review thread starts with only environment context and the review prompt, not prior parent-session chat history, even when resuming from an existing rollout file.

**Data flow**: It writes a synthetic resume JSONL file containing session metadata plus prior user and assistant `ResponseItem::Message` entries, resumes a conversation from that file, submits `Op::Review` with a custom prompt, waits through review completion, then inspects the request body. It asserts the `input` array contains environment context text beginning with `ENVIRONMENT_CONTEXT_OPEN_TAG`, contains the raw review prompt exactly once, and uses `REVIEW_PROMPT` as `instructions`. It then reads the rollout file and scans `RolloutLine`s to confirm a user interruption note mentioning review-task interruption was recorded.

**Call relations**: This test is the only caller of `resume_conversation_for_server`, because it specifically needs preexisting parent history. It validates both request isolation on the child review thread and parent-rollout bookkeeping after the review starts.

*Call graph*: calls 3 internal fn (completed_sse, resume_conversation_for_server, start_responses_server_with_sse); 15 external calls (new, new, new_v4, assert!, assert_eq!, wait_for_event, format!, from_str, from_value, json! (+5 more)).


##### `review_history_surfaces_in_parent_session`  (lines 672–765)

```
async fn review_history_surfaces_in_parent_session()
```

**Purpose**: Checks that once a review thread finishes, its recorded conversation becomes visible to later turns in the parent session.

**Data flow**: It starts a mock server expecting two requests, creates a fresh conversation, runs a review turn that yields assistant text, waits for review completion, then submits a normal `Op::UserInput` follow-up turn and waits for completion. It inspects the second request body, asserts the last input item is the follow-up user text, and also asserts that earlier input items include both the review rollout user note (`User initiated a review task.`) and the review assistant output text.

**Call relations**: This test follows the review-isolation case by checking the opposite boundary: review content should be absent from the child request but present in later parent turns. It uses the same fresh-conversation helper and request-log inspection.

*Call graph*: calls 3 internal fn (assistant_message_sse, new_conversation_for_server, start_responses_server_with_sse); 8 external calls (new, default, new, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `review_uses_overridden_cwd_for_base_branch_merge_base`  (lines 770–867)

```
async fn review_uses_overridden_cwd_for_base_branch_merge_base()
```

**Purpose**: Verifies that `/review` resolves base-branch review prompts using the current runtime-selected cwd rather than the original config cwd.

**Data flow**: It creates a real git repository in a temp dir, initializes `main`, commits a file, captures `HEAD` via `git rev-parse`, creates a conversation whose configured cwd points somewhere else, submits thread settings overriding environments to the repo path, then submits `Op::Review { target: BaseBranch { branch: "main" } }`. After waiting for review start and turn completion, it inspects the single request body and asserts some input text contains the computed merge-base SHA.

**Call relations**: This test combines the review flow with runtime environment overrides and external git commands. It proves the review prompt-generation logic consults the active thread environment rather than stale startup config.

*Call graph*: calls 4 internal fn (local_selections, completed_sse, new_conversation_for_server, start_responses_server_with_sse); 11 external calls (new, default, from_utf8, new, assert!, assert_eq!, new, submit_thread_settings, wait_for_event, skip_if_no_network! (+1 more)).


##### `assistant_message_sse`  (lines 869–874)

```
fn assistant_message_sse(text: &str) -> Vec<serde_json::Value>
```

**Purpose**: Builds the common two-event SSE sequence for tests where the model returns one assistant message and then completes.

**Data flow**: It takes a text string and returns `Vec<serde_json::Value>` containing `responses::ev_assistant_message("msg-1", text)` followed by `responses::ev_completed("resp-1")`.

**Call relations**: Several review tests call this helper when they need a minimal assistant-producing response stream. It keeps the mock-server setup consistent across structured and plain-text review cases.

*Call graph*: called by 4 (review_does_not_emit_agent_message_on_structured_output, review_history_surfaces_in_parent_session, review_op_emits_lifecycle_and_review_output, review_op_with_plain_text_emits_review_fallback); 1 external calls (vec!).


##### `completed_sse`  (lines 876–878)

```
fn completed_sse() -> Vec<serde_json::Value>
```

**Purpose**: Builds the minimal SSE sequence representing an immediate completed response with no assistant content.

**Data flow**: It returns a one-element `Vec<serde_json::Value>` containing only `responses::ev_completed("resp-1")`.

**Call relations**: Tests that care only about request construction or lifecycle completion, not assistant output, use this helper when mounting the mock Responses server.

*Call graph*: called by 4 (review_input_isolated_from_parent_history, review_uses_custom_review_model_from_config, review_uses_overridden_cwd_for_base_branch_merge_base, review_uses_session_model_when_review_model_unset); 1 external calls (vec!).


##### `start_responses_server_with_sse`  (lines 881–890)

```
async fn start_responses_server_with_sse(
    events: Vec<serde_json::Value>,
    expected_requests: usize,
) -> (MockServer, ResponseMock)
```

**Purpose**: Starts a mock Responses server and mounts the provided SSE payload the requested number of times, returning both the server and request log.

**Data flow**: It accepts a vector of SSE event JSON values and an `expected_requests` count, starts a `MockServer`, wraps the events with `responses::sse`, duplicates that SSE response `expected_requests` times into a vector, mounts them as a sequence, and returns `(MockServer, ResponseMock)`.

**Call relations**: Nearly every test in the file uses this helper as the common server bootstrap. It centralizes the pattern of creating a mock `/v1/responses` server plus a request log for later assertions.

*Call graph*: calls 3 internal fn (mount_sse_sequence, sse, start_mock_server); called by 9 (review_does_not_emit_agent_message_on_structured_output, review_filters_agent_message_related_events, review_history_surfaces_in_parent_session, review_input_isolated_from_parent_history, review_op_emits_lifecycle_and_review_output, review_op_with_plain_text_emits_review_fallback, review_uses_custom_review_model_from_config, review_uses_overridden_cwd_for_base_branch_merge_base, review_uses_session_model_when_review_model_unset); 1 external calls (vec!).


##### `new_conversation_for_server`  (lines 893–913)

```
async fn new_conversation_for_server(
    server: &MockServer,
    codex_home: Arc<TempDir>,
    mutator: F,
) -> Arc<CodexThread>
```

**Purpose**: Creates a fresh `CodexThread` configured to send Responses API traffic to the supplied mock server.

**Data flow**: It takes a `MockServer`, shared `TempDir`, and a config mutator closure, formats the server URI into a `/v1` base URL, builds a `test_codex()` fixture with the provided home and a config closure that sets `config.model_provider.base_url` before applying the caller mutator, then builds the fixture and returns its `Arc<CodexThread>`.

**Call relations**: Fresh-session review tests call this helper instead of repeating base-url wiring. It sits between the tests and `test_codex().build(...)`, ensuring all review requests hit the mock server.

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

**Purpose**: Creates a resumed `CodexThread` from an existing rollout file while pointing all Responses API traffic at the supplied mock server.

**Data flow**: It takes a `MockServer`, shared home dir, resume path, and config mutator closure, formats the `/v1` base URL, builds a `test_codex()` fixture with the given home and config mutation, then calls `builder.resume(server, codex_home, resume_path)` and returns the resumed thread.

**Call relations**: Only the parent-history isolation test uses this helper, because that scenario needs a prewritten rollout file. It mirrors `new_conversation_for_server` but routes through the resume path.

*Call graph*: calls 1 internal fn (test_codex); called by 1 (review_input_isolated_from_parent_history); 1 external calls (format!).


### `core/tests/suite/guardian_review.rs`

`test` · `approval flow / post-turn notification`

This non-Windows file sets up a realistic approval flow where an `exec_command` requiring escalation is routed through Guardian auto-review. The test first skips when networking is unavailable or when already running inside a sandbox. It creates a temporary `notify.sh` script that appends its final argument to `notify.jsonl`, marks it executable, and injects it into `config.notify`. The config also allows `AskForApproval::OnRequest` and installs a legacy workspace-write sandbox policy with no writable roots and no network access. The mocked SSE sequence has three phases: the parent model requests `exec_command` with `SandboxPermissions::RequireEscalated` and a justification, the Guardian review model returns a JSON assistant message approving the action, and the parent model then finishes with `done`. The submitted user turn explicitly sets local environment selections, `approval_policy`, `approvals_reviewer: Some(ApprovalsReviewer::AutoReview)`, and the same sandbox policy. After `TurnComplete`, the test finds the outbound Guardian review request by searching recorded requests for the justification text and asserts the reviewed shell command is present. It then waits for the notify file, parses each JSONL payload into `serde_json::Value`, and asserts there is exactly one payload containing only the original user message and final assistant message. The critical invariant is that the Guardian review transcript prompt must not leak into the legacy notify channel.

#### Function details

##### `guardian_review_session_does_not_inherit_legacy_notify`  (lines 34–170)

```
async fn guardian_review_session_does_not_inherit_legacy_notify() -> Result<()>
```

**Purpose**: Exercises an auto-reviewed escalated exec command and verifies that the legacy notify hook receives only the normal conversation, not the Guardian review transcript. It also confirms the approved command writes its marker file successfully.

**Data flow**: After network and sandbox guards, it starts a mock server, defines `approval_policy` and a `SandboxPolicy::WorkspaceWrite` with no writable roots and no network, creates a temporary executable `notify.sh` that appends its last argument to `notify.jsonl`, and configures `test_codex` with that notify script, permissive constrained approval policy, and the legacy sandbox policy. It builds a command that writes `guardian-approved` into a workspace file, wraps it in `tool_args` with `SandboxPermissions::RequireEscalated` and a justification, mounts a three-response SSE sequence for parent tool call, Guardian review assistant JSON, and final assistant completion, submits `Op::UserInput` with local environment selections, `ApprovalsReviewer::AutoReview`, and the sandbox policy, then waits for `TurnComplete`. It searches recorded requests for the Guardian review request containing the justification, asserts the command text is present, waits for `notify.jsonl`, reads and parses its JSON lines, asserts there is exactly one payload with the expected `input-messages` and `last-assistant-message`, asserts the raw notify payload does not contain the Guardian transcript preamble, and finally asserts the output file contains `guardian-approved`.

**Call relations**: This single Tokio test is the file’s entry point. It orchestrates the whole approval path through `mount_sse_sequence`, then uses `wait_for_event` and filesystem polling to validate both the review request and the downstream notify side effect.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex); 18 external calls (default, from_millis, from_secs, new, assert!, assert_eq!, from_mode, wait_for_event, format!, set_permissions (+8 more)).


### `core/tests/suite/mcp_turn_metadata.rs`

`test` · `request handling`

This file exercises the intersection of app-backed MCP tools, approval policy, and turn metadata propagation. Two configuration helpers mutate `Config.config_layer_stack` by synthesizing a TOML user config under `config.codex_home/config.toml`: one sets `[apps.calendar].default_tools_approval_mode`, and the other also sets `[apps._default].approvals_reviewer`. Rather than editing fields directly, they rebuild the layered config stack so the tests mimic real user configuration precedence. A third helper, `submit_user_turn`, standardizes turn submission with disabled permission profile, local environment selection, caller-chosen `AskForApproval`, and either a supplied or default collaboration mode.

Each test mounts both a mock Responses API server and an `AppsTestServer` that records downstream app tool invocations. The first scenario enables `Feature::ToolCallMcpElicitation`, configures calendar approvals to prompt and the default reviewer to `User`, then verifies that approving the elicitation causes the recorded app tool call to include `_meta.x-codex-turn-metadata.user_input_requested_during_turn = true`. The second flips the default reviewer to `AutoReview` while the global reviewer is `User`, proving that the app approval is routed to Guardian instead of surfacing an `ElicitationRequest`; it inspects the Guardian request body and still confirms the actual calendar tool call arguments. The third scenario has the model first call the built-in `request_user_input` tool, waits for `EventMsg::RequestUserInput`, submits a `UserInputAnswer`, then verifies the subsequent calendar MCP call is marked with the same `user_input_requested_during_turn` metadata. Across all three tests, the key invariant is that any user-input solicitation earlier in the turn is reflected in metadata attached to later MCP/app tool calls.

#### Function details

##### `set_calendar_approval_mode`  (lines 44–61)

```
fn set_calendar_approval_mode(config: &mut Config, approval_mode: AppToolApproval)
```

**Purpose**: Injects a user-config layer that sets the calendar app’s default tool approval mode. It lets tests simulate persisted app configuration without editing production config files.

**Data flow**: Takes a mutable `Config` and an `AppToolApproval`. It maps the enum to the TOML strings `auto`, `prompt`, or `approve`, computes `config.codex_home/config.toml`, formats a TOML snippet containing `[apps.calendar] default_tools_approval_mode = ...`, parses it with `toml::from_str`, and replaces `config.config_layer_stack` with a version extended by `with_user_config(&user_config_path, user_config)`. It returns no value.

**Call relations**: Used in the third test’s builder configuration to make calendar tool calls auto-approved. It is the simpler config helper when no default reviewer override is needed.

*Call graph*: 2 external calls (format!, from_str).


##### `set_calendar_approval_mode_and_default_reviewer`  (lines 63–87)

```
fn set_calendar_approval_mode_and_default_reviewer(
    config: &mut Config,
    approval_mode: AppToolApproval,
    default_approvals_reviewer: ApprovalsReviewer,
)
```

**Purpose**: Injects a user-config layer that sets both the global default app approvals reviewer and the calendar app’s default tool approval mode. This allows tests to prove routing comes specifically from `apps._default` rather than the global in-memory config field.

**Data flow**: Accepts a mutable `Config`, an `AppToolApproval`, and an `ApprovalsReviewer`. It converts the approval enum to its TOML string, computes the user config path, formats TOML containing `[apps._default] approvals_reviewer = ...` and `[apps.calendar] default_tools_approval_mode = ...`, parses it, and updates `config.config_layer_stack` via `with_user_config`. It mutates config in place and returns nothing.

**Call relations**: Called by the first two tests inside `search_capable_apps_builder(...).with_config(...)`. Those tests deliberately set the opposite global reviewer on `config.approvals_reviewer` so this helper’s layered config is the source of truth for routing behavior.

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

**Purpose**: Submits a standardized text turn into a `TestCodex` instance with explicit approval policy, local environment selection, disabled permission profile, and optional collaboration mode override. It removes repetitive turn-construction boilerplate from the MCP metadata tests.

**Data flow**: Receives a `&TestCodex`, input text, an `AskForApproval` policy, and an optional `CollaborationMode`. It clones the session model, derives sandbox and permission settings from `test.cwd.path()`, constructs `Op::UserInput` with one `UserInput::Text`, no final schema, default additional context, and `ThreadSettingsOverrides` that set local environments from `test.config.cwd`, the supplied approval policy, derived sandbox and permission profile, and either the provided collaboration mode or a default `ModeKind::Default` mode using the session model. It submits the op through `test.codex.submit(...).await?` and returns `Result<()>`.

**Call relations**: All three top-level tests call this helper to start their scenario. It sits at the front of each call flow, after builder setup and before waiting for elicitation, request-user-input, or MCP tool-call events.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 3 (approved_mcp_tool_call_metadata_records_prior_user_input_request, apps_default_auto_review_routes_actual_mcp_approval_to_guardian, mcp_tool_call_metadata_records_prior_request_user_input_tool); 2 external calls (default, vec!).


##### `approved_mcp_tool_call_metadata_records_prior_user_input_request`  (lines 130–231)

```
async fn approved_mcp_tool_call_metadata_records_prior_user_input_request() -> Result<()>
```

**Purpose**: Verifies that when an app-backed MCP tool call requires user approval and the user accepts, the downstream recorded app tool invocation is tagged with turn metadata indicating user input was requested during the turn. It specifically tests the `ElicitationRequest` approval path.

**Data flow**: This async test skips without network, starts a mock Responses server and mounts an `AppsTestServer`, defines a calendar tool call ID and JSON arguments, mounts a two-step SSE sequence where the first response requests the calendar MCP tool and the second returns `done`, builds a search-capable app test instance with `Feature::ToolCallMcpElicitation` enabled, global reviewer set opposite to the desired route, and layered config from `set_calendar_approval_mode_and_default_reviewer(AppToolApproval::Prompt, ApprovalsReviewer::User)`, then submits a user turn with `AskForApproval::OnRequest`. It waits for `McpToolCallBegin`, then for either `ElicitationRequest` or `TurnComplete`, asserts it got an elicitation, resolves it with `Op::ResolveElicitation { decision: Accept }`, waits for turn completion, fetches the recorded app tool call by call ID, and asserts `_meta/x-codex-turn-metadata/user_input_requested_during_turn` is `true`.

**Call relations**: This is the first of the three metadata-routing scenarios. It uses `submit_user_turn` to start the turn, then drives the approval branch by responding to the emitted `ElicitationRequest`, and finally inspects the app-server recording to verify metadata propagation.

*Call graph*: calls 6 internal fn (mount, recorded_apps_tool_call_by_call_id, search_capable_apps_builder, mount_sse_sequence, start_mock_server, submit_user_turn); 8 external calls (assert_eq!, wait_for_event, json!, panic!, to_string, skip_if_no_network!, unreachable!, vec!).


##### `apps_default_auto_review_routes_actual_mcp_approval_to_guardian`  (lines 234–335)

```
async fn apps_default_auto_review_routes_actual_mcp_approval_to_guardian() -> Result<()>
```

**Purpose**: Verifies that `apps._default.approvals_reviewer = auto_review` routes an app MCP approval through Guardian even when the global reviewer is set to `User`. It proves the route decision comes from layered app config and not the global field.

**Data flow**: The test skips without network, starts the mock Responses server and `AppsTestServer`, defines a calendar call ID and arguments, mounts a three-step SSE sequence consisting of the parent tool-call response, a Guardian review response containing a JSON allow decision, and a final parent assistant response, then builds a search-capable app test instance with `Feature::ToolCallMcpElicitation` enabled, global reviewer set to `User`, and layered config from `set_calendar_approval_mode_and_default_reviewer(AppToolApproval::Prompt, ApprovalsReviewer::AutoReview)`. After `submit_user_turn(..., AskForApproval::OnRequest, None)`, it waits for either `ElicitationRequest` or `TurnComplete` and asserts the route completed without surfacing a user elicitation. It then searches recorded HTTP requests for the Guardian review prompt, asserts that request mentions `calendar_create_event` and `Lunch`, fetches the recorded app tool call, and asserts the title argument is `Lunch`.

**Call relations**: This scenario shares setup structure with the previous test but diverges after submission: instead of resolving an elicitation, it proves no user-facing approval request occurs and that Guardian was consulted. It still ends by inspecting the recorded app tool call on the apps server.

*Call graph*: calls 6 internal fn (mount, recorded_apps_tool_call_by_call_id, search_capable_apps_builder, mount_sse_sequence, start_mock_server, submit_user_turn); 7 external calls (assert!, assert_eq!, wait_for_event, json!, to_string, skip_if_no_network!, vec!).


##### `mcp_tool_call_metadata_records_prior_request_user_input_tool`  (lines 338–461)

```
async fn mcp_tool_call_metadata_records_prior_request_user_input_tool() -> Result<()>
```

**Purpose**: Verifies that if the model first invokes the built-in `request_user_input` tool and only later calls an app-backed MCP tool, the later app tool call is marked as having requested user input during the turn. It covers metadata propagation from tool-mediated user questioning rather than approval elicitation.

**Data flow**: This async test skips without network, starts the mock Responses server and `AppsTestServer`, defines one call ID for `request_user_input` and another for the later calendar call, builds JSON arguments for both, mounts a three-response SSE sequence where the first response calls `request_user_input`, the second calls the calendar MCP tool, and the third returns `done`, then builds a search-capable app test instance with calendar approval mode set to `Approve`. It submits a plan-mode user turn with `AskForApproval::Never`, waits for `EventMsg::RequestUserInput`, asserts the request call ID, submits `Op::UserInputAnswer` containing a `HashMap` answer selecting `Yes (Recommended)`, waits for `McpToolCallBegin` for the calendar call and then `TurnComplete`, fetches the recorded app tool call by the calendar call ID, and asserts `_meta/x-codex-turn-metadata/user_input_requested_during_turn` is `true`.

**Call relations**: This is the non-approval metadata scenario. It uses `submit_user_turn` to start in plan mode, then responds to the emitted `RequestUserInput` event before allowing the later MCP tool call to proceed, finally validating metadata on the recorded downstream app invocation.

*Call graph*: calls 6 internal fn (mount, recorded_apps_tool_call_by_call_id, search_capable_apps_builder, mount_sse_sequence, start_mock_server, submit_user_turn); 9 external calls (from, assert_eq!, wait_for_event, wait_for_event_match, json!, to_string, skip_if_no_network!, unreachable!, vec!).


### Hook interception and notifications
These suites verify lifecycle hooks around prompts and tool execution, including MCP-specific interception and final user-facing notification delivery.

### `core/tests/suite/hooks.rs`

`test` · `cross-cutting / hook execution around turns and tools`

This large test file is the main integration harness for the hooks subsystem. It defines many fixture writers that emit Python hook scripts plus `hooks.json` or `config.toml` entries under a temporary Codex home, covering `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, `PreToolUse`, and `PostToolUse`. Those scripts either log JSON payloads, return structured `hookSpecificOutput` such as `additionalContext`, `permissionDecision`, `updatedInput`, or `decision`, or deliberately exit with status 2 so stderr becomes user-visible feedback. Complementary readers parse the resulting JSONL logs back into `serde_json::Value` for assertions, and small helpers extract hook prompt fragments from rollout files or request bodies, detect spilled-output paths, and normalize code-mode custom tool output. The tests then drive realistic conversations through mocked SSE responses, including streaming SSE for queued-prompt behavior and code-mode custom tool execution. They verify persistence of stop-hook continuation prompts across retries and resumes, ordering of session-start versus prompt-submit hooks, spilling of oversized hook context to disk, permission-request auto-approval without user prompts, pre-tool blocking and input rewriting for shell, unified exec, apply_patch, local function tools, and nested code-mode exec, plus post-tool context injection and output replacement after execution. Additional cases cover plugin-discovered hooks, merged hook sources from `hooks.json` and `config.toml`, alias matching such as `Write` and `Edit`, and session-based exec completion via `write_stdin`. The central invariant throughout is that hook decisions and context become visible at the correct protocol boundary—before execution, after execution, or on the next model turn—while preserving transcript materialization and turn identity.

#### Function details

##### `restrictive_workspace_write_profile`  (lines 62–69)

```
fn restrictive_workspace_write_profile() -> PermissionProfile
```

**Purpose**: Builds a workspace-write permission profile with restricted network and no temp-directory exceptions. It is used where tests want write capability but still force approval-sensitive behavior.

**Data flow**: Calls `PermissionProfile::workspace_write_with(&[], NetworkSandboxPolicy::Restricted, true, true)` and returns the resulting `PermissionProfile`.

**Call relations**: This helper is used by the apply-patch permission-request test to supply a consistent restrictive baseline profile.

*Call graph*: calls 1 internal fn (workspace_write_with); called by 1 (permission_request_hook_allows_apply_patch_with_write_alias).


##### `network_workspace_write_profile`  (lines 71–78)

```
fn network_workspace_write_profile() -> PermissionProfile
```

**Purpose**: Builds a workspace-write permission profile with network enabled and temp-directory access allowed. It supports tests that exercise managed network approval flows.

**Data flow**: Calls `PermissionProfile::workspace_write_with(&[], NetworkSandboxPolicy::Enabled, false, false)` and returns the resulting `PermissionProfile`.

**Call relations**: The network approval test calls this helper to create the runtime profile that should trigger network-specific permission handling.

*Call graph*: calls 1 internal fn (workspace_write_with); called by 1 (permission_request_hook_allows_network_approval_without_prompt).


##### `code_mode_custom_tool_output_text`  (lines 80–95)

```
fn code_mode_custom_tool_output_text(output_item: &Value) -> String
```

**Purpose**: Normalizes the heterogeneous JSON shapes used for code-mode custom tool outputs into a single text string. It supports assertions across string, array, and object output encodings.

**Data flow**: Reads the `output` field from a `serde_json::Value`. If it is a string, it clones and returns it; if it is an array, it concatenates each item's `text` field with newlines; if it is an object, it returns its `content` string or empty string; otherwise it panics with the unexpected shape.

**Call relations**: The code-mode pre-tool and post-tool tests call this helper after extracting custom tool output so they can assert on a plain string regardless of serialization form.

*Call graph*: called by 3 (assert_post_tool_use_blocks_code_mode_tool_result, pre_tool_use_block_rejects_code_mode_tool_promise_before_execution, pre_tool_use_rewrites_code_mode_nested_exec_command_before_execution); 2 external calls (get, panic!).


##### `non_openai_model_provider`  (lines 97–104)

```
fn non_openai_model_provider(server: &wiremock::MockServer) -> ModelProviderInfo
```

**Purpose**: Creates a modified OpenAI provider definition that points at the test server and disables websocket support. It forces compaction-related tests down the non-OpenAI provider path.

**Data flow**: Clones the built-in `openai` provider from `built_in_model_providers(None)`, changes `name`, sets `base_url` to `<server>/v1`, sets `supports_websockets = false`, and returns the modified `ModelProviderInfo`.

**Call relations**: The compact-session-start test injects this provider into config so compaction behavior is exercised under the intended provider assumptions.

*Call graph*: called by 1 (compact_session_start_hook_records_additional_context_for_next_turn); 2 external calls (built_in_model_providers, format!).


##### `trust_plugin_hooks`  (lines 106–122)

```
fn trust_plugin_hooks(config: &mut Config, plugin_hook_sources: Vec<PluginHookSource>)
```

**Purpose**: Enables hooks, discovers hook definitions from plugin sources, asserts discovery succeeded, and marks those hooks as trusted in config. It is the plugin-specific counterpart to the generic trust helpers.

**Data flow**: Mutates the provided `Config` by enabling `Feature::CodexHooks`, calling `codex_hooks::list_hooks` with `feature_enabled: true`, the config layer stack, and the supplied `plugin_hook_sources`, asserting the discovered hook list is non-empty, then passing the discovered hooks into `trust_hooks(config, listed.hooks)`.

**Call relations**: Only the plugin hook integration test uses this helper, because that test needs to synthesize plugin hook sources and then trust the discovered plugin-defined hooks.

*Call graph*: calls 1 internal fn (trust_hooks); 3 external calls (assert!, list_hooks, default).


##### `write_stop_hook`  (lines 124–169)

```
fn write_stop_hook(home: &Path, block_prompts: &[&str]) -> Result<()>
```

**Purpose**: Writes a Python stop-hook fixture and matching `hooks.json` that blocks a configurable number of times before allowing completion. The script also logs each invocation to JSONL.

**Data flow**: Given a home directory and a slice of block prompts, it computes script and log paths, serializes the prompts to JSON, formats a Python script that reads stdin JSON, appends the payload to `stop_hook_log.jsonl`, counts prior invocations, prints a blocking decision with the corresponding prompt while prompts remain, and otherwise prints a passing `systemMessage`. It writes the script file and a `hooks.json` containing a `Stop` hook group invoking that script, then returns `Result<()>`.

**Call relations**: Several stop-hook tests call this fixture writer during `with_pre_build_hook` setup so the runtime will execute the generated hook during turn completion.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_parallel_stop_hooks`  (lines 171–211)

```
fn write_parallel_stop_hooks(home: &Path, prompts: &[&str]) -> Result<()>
```

**Purpose**: Creates multiple stop-hook scripts that can each independently block and contribute continuation prompts. It is used to test accumulation of multiple hook prompt fragments in one retry cycle.

**Data flow**: Iterates over the supplied prompts with indices, writes one Python script per prompt that logs stdin payload and either emits `decision: block` with that prompt or a `systemMessage` when `stop_hook_active` is already true, collects corresponding hook entries, wraps them in a `Stop` hook group JSON object, writes `hooks.json`, and returns `Result<()>`.

**Call relations**: The multiple-blocking-stop-hooks test uses this helper to install more than one stop hook and verify both prompts persist in request and rollout history.

*Call graph*: 3 external calls (join, write, json!).


##### `write_user_prompt_submit_hook`  (lines 213–260)

```
fn write_user_prompt_submit_hook(
    home: &Path,
    blocked_prompt: &str,
    additional_context: &str,
) -> Result<()>
```

**Purpose**: Writes a `UserPromptSubmit` hook fixture that logs every prompt and blocks one specific prompt while attaching additional context. It models prompt rejection before the model sees the text.

**Data flow**: Computes script and log paths, serializes the blocked prompt and additional context, formats a Python script that appends each stdin payload to `user_prompt_submit_hook_log.jsonl` and, when `payload['prompt']` matches the blocked prompt, prints a JSON block decision with `hookSpecificOutput.additionalContext`. It writes the script and a `hooks.json` registering it under `UserPromptSubmit`.

**Call relations**: The blocked-prompt tests install this fixture so they can verify blocked prompts are omitted from model input while their additional context persists to later turns.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_session_start_and_user_prompt_submit_order_hooks`  (lines 262–320)

```
fn write_session_start_and_user_prompt_submit_order_hooks(home: &Path) -> Result<()>
```

**Purpose**: Creates paired `SessionStart` and `UserPromptSubmit` hooks that log minimal identifying fields to a shared file. It is used to assert hook ordering on the first turn.

**Data flow**: Builds script paths for both hooks and a shared `hook_order_log.jsonl`, formats one Python script that logs `hook_event_name` and `source` from session-start payloads and another that logs `hook_event_name` and `prompt` from prompt-submit payloads, writes both scripts, writes a `hooks.json` registering each under its event, and returns `Result<()>`.

**Call relations**: The ordering test installs these fixtures and later reads the shared log to confirm `SessionStart` ran before `UserPromptSubmit`.

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

**Purpose**: Writes a configurable `PreToolUse` hook fixture that can deny, attach context, deny with context, or fail via exit status 2. It also optionally scopes itself with a matcher.

**Data flow**: Given a home path, optional matcher, mode, and reason, it computes script and log paths, serializes mode and reason, formats a Python script that logs stdin payload to `pre_tool_use_hook_log.jsonl` and then emits one of several JSON responses depending on mode (`permissionDecision: deny`, `additionalContext`, both, or stderr plus exit 2). It builds a hook group JSON object, inserts `matcher` when provided, writes the script and `hooks.json`, and returns `Result<()>`.

**Call relations**: Many pre-tool tests use this fixture writer to install the exact hook behavior they want to observe before shell, exec, apply_patch, or local function execution.

*Call graph*: 6 external calls (join, String, format!, write, json!, to_string).


##### `write_updating_pre_tool_use_hook`  (lines 401–447)

```
fn write_updating_pre_tool_use_hook(
    home: &Path,
    matcher: &str,
    updated_input: &Value,
) -> Result<()>
```

**Purpose**: Writes a `PreToolUse` hook fixture that always allows execution but rewrites the tool input to a supplied JSON value. It is the basis for input-rewrite tests.

**Data flow**: Computes script and log paths, serializes `updated_input`, formats a Python script that logs stdin payload and prints `hookSpecificOutput` with `permissionDecision: allow` and `updatedInput`, writes the script and a `hooks.json` containing a matcher-scoped `PreToolUse` hook, and returns `Result<()>`.

**Call relations**: The rewrite tests for shell, exec, apply_patch, and local function tools install this fixture so the runtime should execute the rewritten input instead of the original.

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

**Purpose**: Writes a `PreToolUse` hook fixture configured through `config.toml` instead of `hooks.json`. It lets tests verify TOML-defined hooks and source merging.

**Data flow**: Creates script and log paths, serializes mode and reason, formats a Python script that logs stdin payload and either emits a deny decision or exits 2, constructs a TOML config string enabling hooks and defining `[[hooks.PreToolUse]]` plus nested command hook entries with an optional matcher line, writes the script and `config.toml`, and returns `Result<()>`.

**Call relations**: The config-TOML and merged-source tests use this helper to ensure hooks loaded from TOML behave the same as hooks from `hooks.json`.

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

**Purpose**: Writes a `PermissionRequest` hook fixture that can auto-allow, auto-deny with a message, or fail via exit status 2. It logs every invocation for later inspection.

**Data flow**: Computes script and log paths, serializes mode and reason, formats a Python script that appends stdin payload to `permission_request_hook_log.jsonl` and prints a `hookSpecificOutput.decision` object for allow or deny modes, or writes stderr and exits 2. It optionally inserts a matcher into the hook group, writes the script and `hooks.json`, and returns `Result<()>`.

**Call relations**: This is the underlying fixture writer for all permission-request hook tests and is wrapped by `install_allow_permission_request_hook` for the common allow case.

*Call graph*: called by 1 (install_allow_permission_request_hook); 6 external calls (join, String, format!, write, json!, to_string).


##### `install_allow_permission_request_hook`  (lines 590–597)

```
fn install_allow_permission_request_hook(home: &Path) -> Result<()>
```

**Purpose**: Installs the standard allow-all permission-request hook used by multiple tests. It hardcodes the Bash matcher and the nominal allow reason constant.

**Data flow**: Calls `write_permission_request_hook(home, Some(PERMISSION_REQUEST_HOOK_MATCHER), "allow", PERMISSION_REQUEST_ALLOW_REASON)` and returns its `Result<()>`.

**Call relations**: Several permission-request tests call this convenience wrapper during setup instead of specifying the common allow fixture manually.

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

**Purpose**: Writes a configurable `PostToolUse` hook fixture that can attach context, block with a decision, stop with `continue: false`, or fail via exit status 2. It logs the full post-tool payload for assertions.

**Data flow**: Given home, optional matcher, mode, and reason, it computes script and log paths, serializes mode and reason, formats a Python script that logs stdin payload to `post_tool_use_hook_log.jsonl` and emits one of several JSON responses depending on mode, optionally inserts a matcher into the hook group, writes the script and `hooks.json`, and returns `Result<()>`.

**Call relations**: All post-tool tests use this fixture writer to synthesize the exact post-execution behavior they want to validate.

*Call graph*: 6 external calls (join, String, format!, write, json!, to_string).


##### `write_logging_pre_and_blocking_post_tool_use_hooks`  (lines 671–727)

```
fn write_logging_pre_and_blocking_post_tool_use_hooks(home: &Path, feedback: &str) -> Result<()>
```

**Purpose**: Creates a paired Bash `PreToolUse` logger and `PostToolUse` hook that always fails with stderr feedback after execution. It is tailored for exec-session tests that need both pre- and post-hook logs.

**Data flow**: Computes script and log paths for both hooks, serializes the feedback string, formats a pre-hook Python script that only logs stdin payload and a post-hook script that logs payload, writes feedback to stderr, and exits 2. It writes both scripts plus a `hooks.json` registering matcher-scoped `PreToolUse` and `PostToolUse` hooks for `Bash`, then returns `Result<()>`.

**Call relations**: The exec-session completion-via-`write_stdin` test installs this combined fixture so it can assert both the initial pre-hook input and the final post-hook output.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_session_start_hook_recording_transcript`  (lines 729–764)

```
fn write_session_start_hook_recording_transcript(home: &Path) -> Result<()>
```

**Purpose**: Writes a `SessionStart` hook that records the provided transcript path and whether that path already exists on disk. It verifies transcript materialization timing.

**Data flow**: Computes script and log paths, formats a Python script that reads stdin JSON, extracts `transcript_path`, computes an `exists` boolean using `Path(transcript_path).exists()`, appends that record to `session_start_hook_log.jsonl`, writes the script and a `hooks.json` registering it under `SessionStart`, and returns `Result<()>`.

**Call relations**: The transcript-path test installs this fixture and later reads the log to confirm the runtime materialized the transcript before invoking the hook.

*Call graph*: 4 external calls (join, format!, write, json!).


##### `write_session_start_hook_with_context`  (lines 766–796)

```
fn write_session_start_hook_with_context(home: &Path, additional_context: &str) -> Result<()>
```

**Purpose**: Writes a simple `SessionStart` hook that emits additional developer context without reading stdin. It is used to test context injection and spill behavior.

**Data flow**: Computes the script path, serializes the additional context string, formats a Python script that prints `hookSpecificOutput` with `hookEventName: SessionStart` and the supplied `additionalContext`, writes the script and a `hooks.json` registering it, and returns `Result<()>`.

**Call relations**: The large-context spill test uses this fixture to inject a very large session-start context into the next model request.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_compact_session_start_hook_with_context`  (lines 798–840)

```
fn write_compact_session_start_hook_with_context(
    home: &Path,
    additional_context: &str,
) -> Result<()>
```

**Purpose**: Writes a `SessionStart` hook that matches only `compact` source events, logs its payload, and emits additional context. It supports tests around compaction-triggered session restarts.

**Data flow**: Computes script and log paths, serializes the additional context, formats a Python script that logs stdin payload to `session_start_hook_log.jsonl` and prints `hookSpecificOutput.additionalContext`, writes the script and a `hooks.json` with a `SessionStart` matcher of `compact`, and returns `Result<()>`.

**Call relations**: The compact-session-start test installs this fixture so only the post-compaction session-start event contributes developer context.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_resume_and_compact_session_start_hook_with_context`  (lines 842–899)

```
fn write_resume_and_compact_session_start_hook_with_context(
    home: &Path,
    resume_context: &str,
    compact_context: &str,
) -> Result<()>
```

**Purpose**: Writes one script shared by two `SessionStart` matcher groups, returning different additional context for `resume` and `compact` sources. It lets tests verify both hooks run in sequence on resumed threads that compact.

**Data flow**: Computes script and log paths, serializes the resume and compact context strings, formats a Python script that logs stdin payload and selects context from a `contexts` map keyed by `payload['source']`, writes the script and a `hooks.json` containing two `SessionStart` groups with matchers `resume` and `compact`, and returns `Result<()>`.

**Call relations**: The resumed-thread compaction test installs this fixture to assert that both resume and compact contexts are injected before the next model turn.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `rollout_hook_prompt_texts`  (lines 901–922)

```
fn rollout_hook_prompt_texts(text: &str) -> Result<Vec<String>>
```

**Purpose**: Extracts persisted hook prompt fragments from a rollout JSONL string by scanning user message content. It is a rollout-side counterpart to request inspection.

**Data flow**: Takes rollout text, iterates over non-empty lines, parses each as `RolloutLine`, filters for `RolloutItem::ResponseItem(ResponseItem::Message { role: "user", content, .. })`, scans `ContentItem::InputText` entries, passes each text through `parse_hook_prompt_fragment`, collects the fragment text strings into a `Vec<String>`, and returns `Result<Vec<String>>`.

**Call relations**: The multi-block stop-hook test calls this helper after reading the rollout file to verify continuation prompts were persisted into history.

*Call graph*: calls 1 internal fn (parse_hook_prompt_fragment); called by 1 (stop_hook_can_block_multiple_times_in_same_turn); 2 external calls (new, from_str).


##### `request_hook_prompt_texts`  (lines 924–932)

```
fn request_hook_prompt_texts(
    request: &core_test_support::responses::ResponsesRequest,
) -> Vec<String>
```

**Purpose**: Extracts hook prompt fragments from the user messages of a captured outbound request. It is used to verify what continuation prompts were actually sent back to the model.

**Data flow**: Reads all user message texts from a `ResponsesRequest`, runs each through `parse_hook_prompt_fragment`, keeps only successful parses, maps them to fragment text, and returns the collected `Vec<String>`.

**Call relations**: The stop-hook spill test uses this helper to inspect the second request and confirm the continuation prompt was included, possibly via a spill reference.

*Call graph*: calls 1 internal fn (message_input_texts); called by 1 (stop_hook_spills_large_continuation_prompt).


##### `spilled_hook_output_path`  (lines 934–937)

```
fn spilled_hook_output_path(text: &str) -> Option<&str>
```

**Purpose**: Finds the spill-file path embedded in a hook-generated message that says `Full hook output saved to: ...`. It supports tests for oversized hook output spilling.

**Data flow**: Scans the lines of the input text and returns the suffix of the first line beginning with `Full hook output saved to: `, or `None` if no such line exists.

**Call relations**: Several spill-related tests call this helper after locating a developer or tool-output message that mentions truncation, then read the referenced file to verify the full content.

*Call graph*: called by 4 (post_tool_use_spills_large_feedback_message, pre_tool_use_hook_spills_large_additional_context, session_start_hook_spills_large_additional_context, stop_hook_spills_large_continuation_prompt).


##### `read_stop_hook_inputs`  (lines 939–946)

```
fn read_stop_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads and parses the stop-hook JSONL log into structured values. It is a specialized log reader for stop-hook assertions.

**Data flow**: Reads `<home>/stop_hook_log.jsonl` to string, filters out blank lines, parses each remaining line as `serde_json::Value`, collects them into a vector, and returns `Result<Vec<Value>>`.

**Call relations**: The repeated-stop-hook test uses this helper to inspect turn IDs and `stop_hook_active` flags across multiple invocations.

*Call graph*: called by 1 (stop_hook_can_block_multiple_times_in_same_turn); 2 external calls (join, read_to_string).


##### `read_pre_tool_use_hook_inputs`  (lines 948–950)

```
fn read_pre_tool_use_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the standard pre-tool-use hook log from the Codex home directory. It centralizes the log path used by many pre-tool tests.

**Data flow**: Builds `<home>/pre_tool_use_hook_log.jsonl` and delegates parsing to `read_hook_inputs_from_log`, returning its `Result<Vec<Value>>`.

**Call relations**: Most pre-tool tests call this helper after execution to inspect the exact hook payload the runtime supplied.

*Call graph*: calls 1 internal fn (read_hook_inputs_from_log); called by 12 (assert_pre_tool_use_rewrites_bash_surface, post_tool_use_blocks_when_exec_session_completes_via_write_stdin, pre_tool_use_block_rejects_code_mode_tool_promise_before_execution, pre_tool_use_blocks_apply_patch_before_execution, pre_tool_use_blocks_apply_patch_with_write_alias, pre_tool_use_blocks_exec_command_before_execution, pre_tool_use_blocks_local_function_tool_before_execution, pre_tool_use_blocks_shell_command_before_execution, pre_tool_use_merges_hooks_json_and_config_toml, pre_tool_use_rewrites_apply_patch_before_execution (+2 more)); 1 external calls (join).


##### `read_permission_request_hook_inputs`  (lines 952–959)

```
fn read_permission_request_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads and parses the permission-request hook JSONL log. It is the raw input source for permission-request assertions.

**Data flow**: Reads `<home>/permission_request_hook_log.jsonl`, filters blank lines, parses each line as `serde_json::Value`, collects them, and returns `Result<Vec<Value>>`.

**Call relations**: The higher-level permission-request assertion helpers call this function before checking tool name, command, and omitted fields.

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

**Purpose**: Asserts that one permission-request hook payload has the expected tool name, command, optional description, and absence of unrelated fields. It codifies the expected schema for these hook inputs.

**Data flow**: Reads fields from a `serde_json::Value` and asserts exact equality for `hook_event_name`, `tool_name`, `tool_input.command`, and `tool_input.description`, while also asserting that `approval_attempt`, `sandbox_permissions`, `additional_permissions`, `justification`, `host`, and `protocol` are absent.

**Call relations**: This helper is called by `assert_single_permission_request_hook_input_for_tool` after the log has been loaded and cardinality checked.

*Call graph*: called by 1 (assert_single_permission_request_hook_input_for_tool); 2 external calls (assert!, assert_eq!).


##### `assert_single_permission_request_hook_input`  (lines 982–988)

```
fn assert_single_permission_request_hook_input(
    home: &Path,
    command: &str,
    description: Option<&str>,
) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Convenience wrapper that asserts exactly one permission-request hook input for the default Bash tool. It reduces duplication in shell and exec permission-request tests.

**Data flow**: Delegates to `assert_single_permission_request_hook_input_for_tool(home, "Bash", command, description)` and returns the resulting parsed hook inputs.

**Call relations**: Several permission-request tests call this wrapper when the expected tool name is the default Bash surface.

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

**Purpose**: Loads permission-request hook inputs, asserts there is exactly one, and validates its contents for a specific tool name. It combines cardinality and schema checks.

**Data flow**: Calls `read_permission_request_hook_inputs(home)`, asserts the resulting vector length is 1, passes the sole entry to `assert_permission_request_hook_input` with the expected tool name, command, and description, and returns the parsed vector.

**Call relations**: This helper underpins both the generic wrapper and the apply-patch permission-request test, which needs a non-Bash tool name.

*Call graph*: calls 2 internal fn (assert_permission_request_hook_input, read_permission_request_hook_inputs); called by 2 (assert_single_permission_request_hook_input, permission_request_hook_allows_apply_patch_with_write_alias); 1 external calls (assert_eq!).


##### `read_post_tool_use_hook_inputs`  (lines 1002–1004)

```
fn read_post_tool_use_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the standard post-tool-use hook log from the Codex home directory. It centralizes the path used by post-tool assertions.

**Data flow**: Builds `<home>/post_tool_use_hook_log.jsonl` and delegates parsing to `read_hook_inputs_from_log`, returning `Result<Vec<Value>>`.

**Call relations**: All post-tool tests call this helper to inspect the hook payload, especially `tool_response` and `tool_input.command`.

*Call graph*: calls 1 internal fn (read_hook_inputs_from_log); called by 8 (assert_post_tool_use_blocks_code_mode_tool_result, post_tool_use_block_decision_replaces_shell_command_output_with_reason, post_tool_use_blocks_when_exec_session_completes_via_write_stdin, post_tool_use_continue_false_replaces_shell_command_output_with_stop_reason, post_tool_use_exit_two_replaces_one_shot_exec_command_output_with_feedback, post_tool_use_records_additional_context_for_apply_patch, post_tool_use_records_additional_context_for_shell_command, post_tool_use_records_apply_patch_context_with_edit_alias); 1 external calls (join).


##### `read_hook_inputs_from_log`  (lines 1006–1013)

```
fn read_hook_inputs_from_log(log_path: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Generic JSONL hook-log reader used by multiple hook types and custom log filenames. It parses each non-empty line into `serde_json::Value`.

**Data flow**: Reads the specified log path to string, filters blank lines, parses each line as JSON, collects the values into a vector, and returns `Result<Vec<Value>>`, attaching the log path to read errors.

**Call relations**: This is the shared parser behind pre-tool, post-tool, hook-order, plugin, and config-TOML log inspections.

*Call graph*: called by 6 (plugin_pre_tool_use_blocks_shell_command_before_execution, pre_tool_use_blocks_shell_when_defined_in_config_toml, pre_tool_use_merges_hooks_json_and_config_toml, read_hook_order_inputs, read_post_tool_use_hook_inputs, read_pre_tool_use_hook_inputs); 1 external calls (read_to_string).


##### `read_session_start_hook_inputs`  (lines 1015–1022)

```
fn read_session_start_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads and parses the session-start hook JSONL log. It supports assertions about startup, resume, and compact hook invocations.

**Data flow**: Reads `<home>/session_start_hook_log.jsonl`, filters blank lines, parses each line as `serde_json::Value`, collects them, and returns `Result<Vec<Value>>`.

**Call relations**: Session-start-related tests call this helper after turns or resumes to inspect `source`, `transcript_path`, and other logged fields.

*Call graph*: called by 3 (compact_session_start_hook_records_additional_context_for_next_turn, resumed_thread_runs_resume_then_compact_session_start_hooks, session_start_hook_sees_materialized_transcript_path); 2 external calls (join, read_to_string).


##### `read_user_prompt_submit_hook_inputs`  (lines 1024–1031)

```
fn read_user_prompt_submit_hook_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads and parses the user-prompt-submit hook JSONL log. It is used to verify prompt ordering, blocking, and turn ID propagation.

**Data flow**: Reads `<home>/user_prompt_submit_hook_log.jsonl`, filters blank lines, parses each line as `serde_json::Value`, collects them, and returns `Result<Vec<Value>>`.

**Call relations**: The blocked-prompt tests call this helper to confirm both blocked and accepted prompts were seen by the hook and share the same turn ID when queued.

*Call graph*: called by 2 (blocked_queued_prompt_does_not_strand_earlier_accepted_prompt, blocked_user_prompt_submit_persists_additional_context_for_next_turn); 2 external calls (join, read_to_string).


##### `read_hook_order_inputs`  (lines 1033–1035)

```
fn read_hook_order_inputs(home: &Path) -> Result<Vec<serde_json::Value>>
```

**Purpose**: Reads the shared hook-order log used by the session-start versus prompt-submit ordering test. It is a thin path-specific wrapper.

**Data flow**: Builds `<home>/hook_order_log.jsonl`, delegates to `read_hook_inputs_from_log`, and returns the parsed vector.

**Call relations**: Only the ordering test uses this helper after installing the paired order-recording hooks.

*Call graph*: calls 1 internal fn (read_hook_inputs_from_log); called by 1 (session_start_runs_before_user_prompt_submit_on_first_turn); 1 external calls (join).


##### `ev_message_item_done`  (lines 1037–1047)

```
fn ev_message_item_done(id: &str, text: &str) -> Value
```

**Purpose**: Constructs a synthetic SSE event representing completion of an assistant message item with output text. It supports streaming-SSE tests.

**Data flow**: Takes an item id and text, builds a JSON value with `type: response.output_item.done` and a nested assistant message item containing one `output_text` content span, and returns that `Value`.

**Call relations**: The queued-prompt streaming test uses this helper when assembling chunked SSE bodies for the first response.

*Call graph*: 1 external calls (json!).


##### `sse_event`  (lines 1049–1051)

```
fn sse_event(event: Value) -> String
```

**Purpose**: Wraps a single JSON event into an SSE-formatted string. It is a convenience helper for streaming chunk construction.

**Data flow**: Places the provided `Value` into a one-element vector, passes it to `sse`, and returns the resulting event-stream string.

**Call relations**: The queued-prompt test uses this helper to build individual streaming chunks around synthetic events.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `request_message_input_texts`  (lines 1053–1066)

```
fn request_message_input_texts(body: &[u8], role: &str) -> Vec<String>
```

**Purpose**: Extracts plain input-text spans for a given role directly from a raw request body. It is used when tests capture raw HTTP requests instead of higher-level request wrappers.

**Data flow**: Parses the byte slice as JSON, navigates `input` array items of type `message` with the requested `role`, flattens their `content` arrays, filters spans of type `input_text`, collects each `text` string into a `Vec<String>`, and returns it.

**Call relations**: The queued-prompt streaming test uses this helper on raw server requests to verify which queued prompts reached the second model request.

*Call graph*: called by 1 (blocked_queued_prompt_does_not_strand_earlier_accepted_prompt); 1 external calls (from_slice).


##### `stop_hook_can_block_multiple_times_in_same_turn`  (lines 1069–1174)

```
async fn stop_hook_can_block_multiple_times_in_same_turn() -> Result<()>
```

**Purpose**: Verifies that a stop hook can block the same turn multiple times, injecting successive continuation prompts that persist in both subsequent requests and rollout history. It also checks that all stop-hook invocations share one turn ID and correctly toggle `stop_hook_active`.

**Data flow**: After the network guard, it mounts three sequential assistant responses, installs a stop-hook fixture with two block prompts, builds the test instance, submits one turn, then inspects the three captured requests to assert the second request contains the first continuation prompt and the third request contains both prompts. It reads stop-hook log inputs with `read_stop_hook_inputs`, asserts there are three entries, extracts and compares `turn_id` values, checks `stop_hook_active` values `[false, true, true]`, reads the rollout file text, extracts persisted hook prompt fragments with `rollout_hook_prompt_texts`, and asserts both prompts are present.

**Call relations**: This is the main stop-hook persistence test. It depends on `write_stop_hook` for setup and on both request-side and rollout-side helper readers to validate the runtime’s retry behavior.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_stop_hook_inputs, rollout_hook_prompt_texts); 5 external calls (assert!, assert_eq!, read_to_string, skip_if_no_network!, vec!).


##### `session_start_hook_sees_materialized_transcript_path`  (lines 1177–1213)

```
async fn session_start_hook_sees_materialized_transcript_path() -> Result<()>
```

**Purpose**: Checks that the transcript file path passed to a `SessionStart` hook is non-empty and already exists on disk when the hook runs. It validates transcript materialization ordering.

**Data flow**: It mounts a one-shot assistant response, installs the transcript-recording session-start hook, builds the test instance, submits a turn, reads the session-start hook log with `read_session_start_hook_inputs`, asserts there is one entry, asserts `transcript_path` is present and non-empty, and asserts `exists == true`.

**Call relations**: This test uses `write_session_start_hook_recording_transcript` during setup and then validates the logged payload after a normal turn.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_session_start_hook_inputs); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `session_start_runs_before_user_prompt_submit_on_first_turn`  (lines 1216–1260)

```
async fn session_start_runs_before_user_prompt_submit_on_first_turn() -> Result<()>
```

**Purpose**: Verifies that `SessionStart` hooks run before `UserPromptSubmit` hooks on the first turn of a session. It checks both event order and the key payload fields each hook receives.

**Data flow**: It mounts a one-shot assistant response, installs paired order-recording hooks, builds the test instance, submits `hello`, reads the shared order log with `read_hook_order_inputs`, asserts the logged `hook_event_name` sequence is `[SessionStart, UserPromptSubmit]`, then asserts the first entry has `source == startup` and the second has `prompt == hello`.

**Call relations**: This test relies on `write_session_start_and_user_prompt_submit_order_hooks` to create a shared log that captures relative ordering across two hook types.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_hook_order_inputs); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `session_start_hook_spills_large_additional_context`  (lines 1263–1302)

```
async fn session_start_hook_spills_large_additional_context() -> Result<()>
```

**Purpose**: Checks that oversized `SessionStart` additional context is truncated in the developer message and spilled to a file whose contents preserve the full text. It validates the spill mechanism for hook-generated context.

**Data flow**: It mounts a one-shot assistant response, creates a very large repeated context string, installs a session-start hook that emits that context, builds the test instance, submits a turn, inspects the captured request’s developer messages to find one containing a spill path via `spilled_hook_output_path`, asserts the message mentions token truncation, reads the referenced file, and asserts its contents equal the original large context.

**Call relations**: This test uses `write_session_start_hook_with_context` for setup and `spilled_hook_output_path` to locate the spill file referenced in the outbound request.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, spilled_hook_output_path); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `pre_tool_use_hook_spills_large_additional_context`  (lines 1305–1360)

```
async fn pre_tool_use_hook_spills_large_additional_context() -> Result<()>
```

**Purpose**: Verifies that oversized `PreToolUse` additional context is spilled to disk and referenced from the follow-up developer message. It ensures pre-tool hook context uses the same truncation/spill path as session-start context.

**Data flow**: It mounts a two-step SSE sequence where the model calls `shell_command` and then completes, creates a large repeated pre-tool context string, installs a matcher-scoped pre-tool hook in `context` mode, builds the test instance, submits a turn, inspects the second captured request’s developer messages for one containing a spill path, asserts the message mentions token truncation, reads the spill file, and asserts it contains the full original context.

**Call relations**: This test depends on `write_pre_tool_use_hook` to generate the large context and on `spilled_hook_output_path` to recover the saved file path from the follow-up request.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, spilled_hook_output_path); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `compact_session_start_hook_records_additional_context_for_next_turn`  (lines 1363–1435)

```
async fn compact_session_start_hook_records_additional_context_for_next_turn() -> Result<()>
```

**Purpose**: Checks that a `SessionStart` hook matching `compact` injects additional context only after compaction and before the next model turn. It also verifies the hook log records `source: compact`.

**Data flow**: It mounts three sequential assistant responses, creates a non-OpenAI model provider, installs a compact-only session-start hook with fixed context, configures the test instance to use that provider and trusted hooks, submits an initial turn, submits `Op::Compact`, waits for `TurnComplete`, submits a second turn, then inspects the three captured requests. It asserts the first request’s developer messages do not contain the compact context, while the third request’s developer messages do. Finally it reads the session-start hook log and asserts there is one entry with `source == compact`.

**Call relations**: This test combines `non_openai_model_provider`, `write_compact_session_start_hook_with_context`, and `wait_for_event` to validate hook behavior across an explicit compaction boundary.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, non_openai_model_provider, read_session_start_hook_inputs); 5 external calls (assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `resumed_thread_runs_resume_then_compact_session_start_hooks`  (lines 1438–1531)

```
async fn resumed_thread_runs_resume_then_compact_session_start_hooks() -> Result<()>
```

**Purpose**: Verifies that resuming a thread and then auto-compacting it triggers both `resume` and `compact` session-start hooks, and that both contexts are injected before the next model turn. It also checks the hook log records both sources in order.

**Data flow**: It mounts three responses: an initial turn completed with token count above the auto-compact limit, a compaction output item carrying remote summary text, and a post-resume assistant response. It installs a fixture that emits different contexts for `resume` and `compact`, configures auto-compact token limit, builds an initial session, records its home and rollout path, submits the first turn, then builds a resumed session from the same home and rollout path and submits another turn. It inspects the third captured request’s developer messages to assert both resume and compact contexts are present, then reads the session-start hook log from the resumed home and asserts the recorded `source` values are `['resume', 'compact']`.

**Call relations**: This test spans two `test_codex` instances—initial and resumed—and uses the shared session-start fixture to prove both resume and compact hooks fire during resumed-thread startup.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_session_start_hook_inputs); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `stop_hook_spills_large_continuation_prompt`  (lines 1534–1581)

```
async fn stop_hook_spills_large_continuation_prompt() -> Result<()>
```

**Purpose**: Checks that an oversized stop-hook continuation prompt is truncated in the request and spilled to a file containing the full prompt. It validates spill behavior for user hook prompt fragments.

**Data flow**: It mounts two assistant responses, constructs a very large continuation prompt by repeating a phrase 800 times, installs a stop hook that blocks once with that prompt, builds the test instance, submits a turn, inspects the second captured request with `request_hook_prompt_texts`, asserts there is one hook prompt text containing `tokens truncated`, extracts the spill path with `spilled_hook_output_path`, reads the file, and asserts it equals the original continuation prompt.

**Call relations**: This test uses `write_stop_hook` for setup and combines request-side hook-fragment extraction with spill-path detection to validate large continuation prompt handling.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, request_hook_prompt_texts, spilled_hook_output_path); 5 external calls (assert!, assert_eq!, skip_if_no_network!, repeat_n, vec!).


##### `resumed_thread_keeps_stop_continuation_prompt_in_history`  (lines 1584–1646)

```
async fn resumed_thread_keeps_stop_continuation_prompt_in_history() -> Result<()>
```

**Purpose**: Verifies that a stop-hook continuation prompt persisted in rollout history survives a session resume and is sent again on the next turn. It guards against losing hook-generated user context across resumes.

**Data flow**: It mounts two initial assistant responses, installs a stop hook that blocks once with `FIRST_CONTINUATION_PROMPT`, builds the initial session, records its home and rollout path, submits a turn, then mounts a one-shot response for the resumed session, resumes from the saved home and rollout path, submits another turn, and inspects the resumed request with `request_hook_prompt_texts` to assert it contains exactly the persisted continuation prompt.

**Call relations**: This test uses `write_stop_hook` during the initial session and then relies on `test_codex().resume(...)` plus request inspection to prove the prompt was restored from persisted history.

*Call graph*: calls 5 internal fn (mount_sse_once, mount_sse_sequence, sse, start_mock_server, test_codex); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `multiple_blocking_stop_hooks_persist_multiple_hook_prompt_fragments`  (lines 1649–1706)

```
async fn multiple_blocking_stop_hooks_persist_multiple_hook_prompt_fragments() -> Result<()>
```

**Purpose**: Checks that when multiple stop hooks block in parallel, both continuation prompts are preserved in the next request and in rollout history in order. It validates aggregation of multiple hook prompt fragments.

**Data flow**: It mounts two assistant responses, installs parallel stop hooks with `FIRST_CONTINUATION_PROMPT` and `SECOND_CONTINUATION_PROMPT`, builds the test instance, submits a turn, inspects the second request with `request_hook_prompt_texts` to assert both prompts are present in order, reads the rollout file text, extracts persisted hook prompt fragments with `rollout_hook_prompt_texts`, and asserts the same ordered pair is stored there.

**Call relations**: This test depends on `write_parallel_stop_hooks` for setup and uses both request and rollout helpers to verify prompt aggregation.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_eq!, read_to_string, skip_if_no_network!, vec!).


##### `blocked_user_prompt_submit_persists_additional_context_for_next_turn`  (lines 1709–1781)

```
async fn blocked_user_prompt_submit_persists_additional_context_for_next_turn() -> Result<()>
```

**Purpose**: Verifies that a blocked `UserPromptSubmit` hook prevents the blocked prompt from reaching the model but persists its additional context into the next accepted turn. It also checks both hook invocations are logged with non-empty turn IDs.

**Data flow**: It mounts a one-shot assistant response for the second turn, installs a prompt-submit hook that blocks `blocked first prompt` and emits `BLOCKED_PROMPT_CONTEXT`, builds the test instance, submits the blocked prompt and then `second prompt`, inspects the captured request to assert developer messages contain the blocked prompt context, user messages do not contain the blocked prompt, and user messages do contain the second prompt. It then reads the prompt-submit hook log, asserts there are two entries with prompts `blocked first prompt` and `second prompt`, and asserts every logged `turn_id` is non-empty.

**Call relations**: This test uses `write_user_prompt_submit_hook` for setup and then validates both request shaping and hook-log persistence after one blocked and one accepted prompt.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_user_prompt_submit_hook_inputs); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `blocked_queued_prompt_does_not_strand_earlier_accepted_prompt`  (lines 1784–1940)

```
async fn blocked_queued_prompt_does_not_strand_earlier_accepted_prompt() -> Result<()>
```

**Purpose**: Ensures that when prompts are queued during a streaming response, a later blocked queued prompt does not prevent an earlier accepted queued prompt from being sent once the current turn completes. It also checks all queued prompt-submit hook invocations share the same turn ID.

**Data flow**: It builds a streaming SSE server whose first response emits partial assistant output and delays completion behind a oneshot gate, and whose second response handles the accepted queued prompt. It installs a prompt-submit hook that blocks `blocked queued prompt`, builds a streaming test instance, submits `initial prompt`, waits for an `AgentMessageContentDelta`, then submits `accepted queued prompt` and `blocked queued prompt` while the first turn is still open. After a short sleep it releases the completion gate, polls the server until two requests have arrived, extracts user texts from the second raw request with `request_message_input_texts`, asserts the accepted queued prompt is present and the blocked one is absent, then reads the prompt-submit hook log and asserts the three logged prompts are `initial prompt`, `accepted queued prompt`, and `blocked queued prompt`, all with the same non-empty `turn_id`.

**Call relations**: This is the most orchestration-heavy prompt-submit test: it uses `start_streaming_sse_server`, `ev_message_item_done`, `sse_event`, and raw request inspection to validate queue handling under concurrent prompt submission.

*Call graph*: calls 4 internal fn (start_streaming_sse_server, test_codex, read_user_prompt_submit_hook_inputs, request_message_input_texts); 11 external calls (default, from_millis, from_secs, assert!, assert_eq!, wait_for_event, channel, skip_if_no_network!, sleep, timeout (+1 more)).


##### `permission_request_hook_allows_shell_command_without_user_approval`  (lines 1943–2013)

```
async fn permission_request_hook_allows_shell_command_without_user_approval() -> Result<()>
```

**Purpose**: Checks that a permission-request hook can auto-allow a shell command that would otherwise require user approval, and that the command actually executes. It also verifies the hook input omits `tool_use_id` and includes a non-empty `turn_id`.

**Data flow**: It mounts a two-step SSE sequence where the model calls `shell_command` to remove a temp marker file and then completes, installs the standard allow permission-request hook, builds the test instance, seeds the marker file, submits a turn with `AskForApproval::OnRequest` and `PermissionProfile::Disabled`, inspects the second request to ensure function-call output exists, asserts the marker file no longer exists, then loads and validates the single permission-request hook input with `assert_single_permission_request_hook_input`, additionally asserting `tool_use_id` is absent and `turn_id` is non-empty.

**Call relations**: This test uses `install_allow_permission_request_hook` for setup and the shared permission-request assertion helper to validate the hook payload after the runtime bypasses the normal approval prompt.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_permission_request_hook_input); 8 external calls (assert!, assert_eq!, format!, write, json!, skip_if_no_network!, temp_dir, vec!).


##### `permission_request_hook_allows_apply_patch_with_write_alias`  (lines 2016–2085)

```
async fn permission_request_hook_allows_apply_patch_with_write_alias() -> Result<()>
```

**Purpose**: Verifies that a permission-request hook matching the `Write` alias can auto-allow an `apply_patch` tool call that writes outside the workspace. It confirms both execution and hook payload normalization for apply_patch.

**Data flow**: It mounts a two-step SSE sequence where the model issues an `apply_patch` custom tool call adding a file via a relative path outside the workspace, installs a permission-request hook with matcher `^Write$` in allow mode, builds the test instance, computes the target path, submits a turn with `AskForApproval::OnRequest` and `restrictive_workspace_write_profile()`, inspects the second request’s custom tool output, asserts the target file now exists, and validates the single permission-request hook input for tool `apply_patch` and the original patch text via `assert_single_permission_request_hook_input_for_tool`.

**Call relations**: This test combines the restrictive profile helper with the tool-specific permission-request assertion helper to prove alias matching works for apply_patch.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_permission_request_hook_input_for_tool, restrictive_workspace_write_profile); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


##### `permission_request_hook_sees_raw_exec_command_input`  (lines 2088–2162)

```
async fn permission_request_hook_sees_raw_exec_command_input() -> Result<()>
```

**Purpose**: Checks that permission-request hooks for unified exec receive the raw command text and justification as the description field. It also verifies the approved exec command actually runs.

**Data flow**: It mounts a two-step SSE sequence where the model calls `exec_command` with `cmd`, `login`, `sandbox_permissions: require_escalated`, and `justification`, installs the standard allow permission-request hook, enables unified exec in config, builds the test instance, seeds a temp marker file, submits a turn with `AskForApproval::OnRequest` and `PermissionProfile::read_only()`, inspects the second request’s function-call output, asserts the marker file was removed, and validates the single permission-request hook input using the command text and justification string as expected description.

**Call relations**: This test uses the common allow hook but custom unified-exec config, then reuses the generic permission-request assertion helper to confirm the hook saw the raw exec input.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_permission_request_hook_input, read_only); 8 external calls (assert!, assert_eq!, format!, write, json!, skip_if_no_network!, temp_dir, vec!).


##### `permission_request_hook_allows_network_approval_without_prompt`  (lines 2165–2284)

```
async fn permission_request_hook_allows_network_approval_without_prompt() -> Result<()>
```

**Purpose**: Verifies that a permission-request hook can auto-approve managed network access without surfacing an `ExecApprovalRequest` prompt to the user. It also checks the hook sees the synthesized network-access justification.

**Data flow**: It writes a custom `config.toml` under a temporary home enabling limited network access, mounts a two-step SSE sequence where the model calls `shell_command` that performs an HTTP request, builds a test instance with that home, the allow permission-request hook, managed network requirements bundle, `AskForApproval::OnFailure`, and a network-enabled workspace-write profile. It asserts managed network requirements and proxy config are active, submits the turn, waits until the permission-request hook log file appears, then uses `timeout` around `wait_for_event` to assert no `EventMsg::ExecApprovalRequest` arrives. Finally it validates the single permission-request hook input with the command text and expected description `network-access http://codex-network-test.invalid:80`, then shuts down Codex and waits for `ShutdownComplete`.

**Call relations**: This test is the network-specific permission-request path: it combines managed network config, the allow hook, and an explicit absence check for approval events to prove the hook bypasses the prompt.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_permission_request_hook_input, network_workspace_write_profile); 14 external calls (clone, new, from_millis, from_secs, new, assert!, managed_network_requirements_loader, wait_for_event, write, json! (+4 more)).


##### `permission_request_hook_sees_retry_context_after_sandbox_denial`  (lines 2288–2349)

```
async fn permission_request_hook_sees_retry_context_after_sandbox_denial() -> Result<()>
```

**Purpose**: Checks that after an initial sandbox denial, the retry path still invokes the permission-request hook with the original shell command. It verifies the hook participates in escalation after failure.

**Data flow**: On non-Linux targets, it mounts a two-step SSE sequence where the model calls `shell_command` to write a marker file and then completes, installs the standard allow permission-request hook, builds the test instance, removes any stale marker file, submits a turn with `AskForApproval::OnFailure` and `PermissionProfile::read_only()`, inspects the second request’s function-call output, asserts the marker file now contains `retry`, and validates the single permission-request hook input for the original command with no description.

**Call relations**: This test exercises the retry-after-denial path rather than initial approval, but still uses the shared allow hook and assertion helper.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_permission_request_hook_input, read_only); 6 external calls (assert_eq!, format!, remove_file, json!, skip_if_no_network!, vec!).


##### `pre_tool_use_blocks_shell_command_before_execution`  (lines 2352–2443)

```
async fn pre_tool_use_blocks_shell_command_before_execution() -> Result<()>
```

**Purpose**: Verifies that a `PreToolUse` hook can block a shell command before it runs, surfacing the hook reason and blocked command in tool output. It also checks the hook payload includes transcript and turn identifiers.

**Data flow**: It mounts a two-step SSE sequence where the model calls `shell_command` to write a temp marker and then completes, installs a Bash-matched pre-tool hook in `json_deny` mode with reason `blocked by pre hook`, builds the test instance, removes any stale marker file, submits a turn with `PermissionProfile::Disabled`, inspects the second request’s function-call output string to assert it contains both the hook reason and `Command: <command>`, asserts the marker file does not exist, then reads the pre-tool hook log and asserts fields including `hook_event_name`, `tool_name`, `tool_use_id`, `tool_input.command`, non-empty existing `transcript_path`, and non-empty `turn_id`.

**Call relations**: This is the baseline pre-tool blocking test. It uses `write_pre_tool_use_hook` for setup and `read_pre_tool_use_hook_inputs` for detailed payload validation after the runtime blocks execution.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 8 external calls (assert!, assert_eq!, format!, remove_file, json!, skip_if_no_network!, temp_dir, vec!).


##### `pre_tool_use_records_additional_context_for_shell_command`  (lines 2446–2505)

```
async fn pre_tool_use_records_additional_context_for_shell_command() -> Result<()>
```

**Purpose**: Checks that a non-blocking `PreToolUse` hook can attach developer context that appears in the follow-up model request while still allowing the shell command to execute. It validates context propagation without denial.

**Data flow**: It mounts a two-step SSE sequence for a `shell_command` call followed by assistant completion, installs a Bash-matched pre-tool hook in `context` mode with a fixed note, builds the test instance, submits a turn, inspects the second request to assert developer messages contain the note, extracts the function-call output string, and asserts it still contains the shell command’s actual output `pre-tool-output`.

**Call relations**: This test uses the same fixture writer as the blocking case but changes the mode to `context`, proving the runtime preserves execution while carrying hook context into the next model turn.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `blocked_pre_tool_use_records_additional_context_for_shell_command`  (lines 2508–2578)

```
async fn blocked_pre_tool_use_records_additional_context_for_shell_command() -> Result<()>
```

**Purpose**: Verifies that a blocking `PreToolUse` hook can also attach developer context, and that both the context and the block reason are surfaced appropriately. The command itself must not execute.

**Data flow**: It mounts a two-step SSE sequence for a shell command that would write a marker file, installs a Bash-matched pre-tool hook in `json_deny_with_context` mode using one shared reason/context string, builds the test instance, removes any stale marker, submits a turn with disabled permissions, inspects the second request to assert developer messages contain the context, extracts the function-call output string to assert it contains the block reason, and asserts the marker file was not created.

**Call relations**: This test extends the pre-tool context path to the deny case, using the same fixture writer but validating both request-side context injection and execution suppression.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 8 external calls (assert!, assert_eq!, format!, remove_file, json!, skip_if_no_network!, temp_dir, vec!).


##### `BashRewriteSurface::slug`  (lines 2587–2592)

```
fn slug(self) -> &'static str
```

**Purpose**: Returns a stable slug string identifying whether a rewrite test is exercising `exec_command` or `shell_command`. It is used to derive call IDs and marker filenames.

**Data flow**: Matches on `self` and returns either `exec-command` or `shell-command` as a `&'static str`.

**Call relations**: The shared rewrite assertion helper calls this method to parameterize request IDs, prompts, and filesystem markers by surface.

*Call graph*: called by 1 (assert_pre_tool_use_rewrites_bash_surface).


##### `BashRewriteSurface::tool_call`  (lines 2594–2607)

```
fn tool_call(self, call_id: &str, command_text: &str) -> Result<Value>
```

**Purpose**: Builds the appropriate mocked function-call SSE event for the selected Bash surface. It abstracts over the argument key difference between `exec_command` and `shell_command`.

**Data flow**: Given `self`, a `call_id`, and `command_text`, it matches on the surface and returns a JSON event from `ev_function_call` using tool name `exec_command` with `{cmd: ...}` or `shell_command` with `{command: ...}`, serializing the argument object to string.

**Call relations**: The shared rewrite assertion helper uses this method when mounting the first SSE response so the same test logic can target both surfaces.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `BashRewriteSurface::original_command`  (lines 2609–2615)

```
fn original_command(self, marker: &Path) -> String
```

**Purpose**: Constructs the original shell command string that writes `original` into a marker file for the selected surface. It gives the rewrite tests a known side effect to suppress.

**Data flow**: Formats `printf original > <marker>` using the provided path and returns the resulting `String` for either surface.

**Call relations**: The shared rewrite assertion helper calls this to generate the command that should appear in hook input but should not actually execute after rewriting.

*Call graph*: called by 1 (assert_pre_tool_use_rewrites_bash_surface); 1 external calls (format!).


##### `BashRewriteSurface::rewritten_command`  (lines 2617–2623)

```
fn rewritten_command(self, marker: &Path) -> String
```

**Purpose**: Constructs the rewritten shell command string that writes `rewritten` into a marker file for the selected surface. It is the command the hook should substitute in.

**Data flow**: Formats `printf rewritten > <marker>` using the provided path and returns the resulting `String` for either surface.

**Call relations**: The shared rewrite assertion helper uses this to build the `updatedInput` payload supplied by the pre-tool rewrite hook.

*Call graph*: called by 1 (assert_pre_tool_use_rewrites_bash_surface); 1 external calls (format!).


##### `BashRewriteSurface::configure`  (lines 2625–2634)

```
fn configure(self, config: &mut Config)
```

**Purpose**: Applies the configuration needed for the selected Bash surface, always trusting discovered hooks and enabling unified exec when required. It keeps the shared rewrite helper surface-agnostic.

**Data flow**: Mutates the provided `Config` by calling `trust_discovered_hooks(config)` and, when `self` is `ExecCommand`, setting `use_experimental_unified_exec_tool = true` and enabling `Feature::UnifiedExec`.

**Call relations**: The shared rewrite assertion helper delegates per-surface config setup to this method before building the test instance.

*Call graph*: calls 1 internal fn (trust_discovered_hooks); 1 external calls (matches!).


##### `assert_pre_tool_use_rewrites_bash_surface`  (lines 2637–2703)

```
async fn assert_pre_tool_use_rewrites_bash_surface(surface: BashRewriteSurface) -> Result<()>
```

**Purpose**: Shared assertion routine that verifies a `PreToolUse` hook rewrites either `shell_command` or `exec_command` before execution. It confirms only the rewritten command runs and the hook log still records the original input.

**Data flow**: After the network guard, it starts a mock server, derives a slug, call id, original and rewritten marker paths, builds original and rewritten command strings via the `BashRewriteSurface` methods, mounts a two-step SSE sequence whose first response contains the appropriate tool call event from `surface.tool_call`, installs a pre-tool rewrite hook with `updatedInput = { command: rewritten_command }`, configures the test instance via `surface.configure`, removes any stale marker files, submits a turn with disabled permissions, inspects the second request’s function-call output, asserts the original marker does not exist, reads the rewritten marker and asserts it contains `rewritten`, then reads the pre-tool hook log and asserts the logged `tool_input.command` equals the original command.

**Call relations**: This helper is called by the two concrete Bash-surface rewrite tests. It centralizes all shared setup and assertions while delegating surface-specific differences to the enum methods.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, original_command, rewritten_command, slug, read_pre_tool_use_hook_inputs); called by 2 (pre_tool_use_rewrites_exec_command_before_execution, pre_tool_use_rewrites_shell_command_before_execution); 8 external calls (assert!, assert_eq!, format!, remove_file, json!, skip_if_no_network!, temp_dir, vec!).


##### `pre_tool_use_rewrites_shell_command_before_execution`  (lines 2706–2708)

```
async fn pre_tool_use_rewrites_shell_command_before_execution() -> Result<()>
```

**Purpose**: Runs the shared pre-tool rewrite assertion against the `shell_command` surface. It proves shell-command input rewriting works end to end.

**Data flow**: Calls `assert_pre_tool_use_rewrites_bash_surface(BashRewriteSurface::ShellCommand)` and returns its `Result<()>`.

**Call relations**: This is a thin Tokio test wrapper around the shared rewrite helper for the shell-command case.

*Call graph*: calls 1 internal fn (assert_pre_tool_use_rewrites_bash_surface).


##### `pre_tool_use_rewrites_exec_command_before_execution`  (lines 2711–2713)

```
async fn pre_tool_use_rewrites_exec_command_before_execution() -> Result<()>
```

**Purpose**: Runs the shared pre-tool rewrite assertion against the `exec_command` surface. It proves unified-exec input rewriting works end to end.

**Data flow**: Calls `assert_pre_tool_use_rewrites_bash_surface(BashRewriteSurface::ExecCommand)` and returns its `Result<()>`.

**Call relations**: This is the exec-command counterpart to the shell rewrite test, delegating entirely to the shared helper.

*Call graph*: calls 1 internal fn (assert_pre_tool_use_rewrites_bash_surface).


##### `pre_tool_use_rewrites_code_mode_nested_exec_command_before_execution`  (lines 2716–2803)

```
async fn pre_tool_use_rewrites_code_mode_nested_exec_command_before_execution() -> Result<()>
```

**Purpose**: Verifies that a `PreToolUse` hook can rewrite a nested `tools.exec_command` call issued from code mode before the nested command executes. The code-mode tool output should reflect only the rewritten command’s result.

**Data flow**: It mounts a two-step SSE sequence where the model emits a custom `exec` tool call containing JavaScript that awaits `tools.exec_command({ cmd: original_command })` and prints the result. It installs a Bash-matched pre-tool rewrite hook with `updatedInput.command = rewritten_command`, enables `Feature::CodeMode`, builds the test instance, submits a turn with disabled permissions, extracts the custom tool output text via `code_mode_custom_tool_output_text`, asserts it contains `rewritten-result` and not `original-result`, asserts the original marker file does not exist, reads the rewritten marker file and asserts it contains `rewritten`, then reads the pre-tool hook log and asserts the logged command is the original nested command.

**Call relations**: This test extends pre-tool rewriting into nested code-mode tool execution, using the output-normalization helper because custom tool output is not always a plain string.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, code_mode_custom_tool_output_text, read_pre_tool_use_hook_inputs); 8 external calls (new, assert!, assert_eq!, format!, json!, to_string, skip_if_no_network!, vec!).


##### `pre_tool_use_block_rejects_code_mode_tool_promise_before_execution`  (lines 2806–2878)

```
async fn pre_tool_use_block_rejects_code_mode_tool_promise_before_execution() -> Result<()>
```

**Purpose**: Checks that a blocking `PreToolUse` hook causes a nested code-mode `tools.exec_command` promise to reject before execution. The code catches the error and surfaces the hook reason instead of a successful result.

**Data flow**: It mounts a two-step SSE sequence where the model emits custom code that tries `tools.exec_command({ cmd: command })`, prints an `unexpected-success` JSON on success, and prints a caught-error JSON on failure. It installs a Bash-matched pre-tool hook in `json_deny` mode with a fixed reason, enables code mode, builds the test instance, submits a turn, normalizes the custom tool output text, asserts it contains `"kind":"caught"` and the reason but not `unexpected-success`, asserts the marker file was never created, then reads the pre-tool hook log and asserts the logged command matches the blocked nested command.

**Call relations**: This test is the code-mode analogue of shell pre-tool blocking, again relying on `code_mode_custom_tool_output_text` and the pre-tool log reader.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, code_mode_custom_tool_output_text, read_pre_tool_use_hook_inputs); 7 external calls (new, assert!, assert_eq!, format!, to_string, skip_if_no_network!, vec!).


##### `assert_post_tool_use_blocks_code_mode_tool_result`  (lines 2880–2966)

```
async fn assert_post_tool_use_blocks_code_mode_tool_result(
    hook_mode: &'static str,
    reason: &'static str,
) -> Result<()>
```

**Purpose**: Shared helper that verifies a `PostToolUse` hook can reject the result of a nested code-mode `tools.exec_command` after the command has already executed. It confirms the promise rejects, the original result is hidden, and the side effect still occurred.

**Data flow**: After the network guard, it mounts a two-step SSE sequence where custom code awaits `tools.exec_command({ cmd: command })` and prints either `unexpected-success` or a caught-error JSON. The command writes `executed` to a marker file and prints `original-post-tool-result`. It installs a Bash-matched post-tool hook with the supplied mode and reason, enables code mode, builds the test instance, submits a turn, normalizes the custom tool output text, asserts it contains `"kind":"caught"` and the reason but not `unexpected-success` or `original-post-tool-result`, reads the marker file to assert the command did execute, then reads the post-tool hook log and asserts the logged command and `tool_response == "original-post-tool-result"`.

**Call relations**: The two concrete code-mode post-tool rejection tests call this helper with different hook modes (`decision_block` and `exit_2`) to share the same execution and assertion logic.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, code_mode_custom_tool_output_text, read_post_tool_use_hook_inputs); called by 2 (post_tool_use_block_decision_rejects_code_mode_tool_promise, post_tool_use_exit_two_rejects_code_mode_tool_promise); 7 external calls (new, assert!, assert_eq!, format!, to_string, skip_if_no_network!, vec!).


##### `post_tool_use_block_decision_rejects_code_mode_tool_promise`  (lines 2969–2975)

```
async fn post_tool_use_block_decision_rejects_code_mode_tool_promise() -> Result<()>
```

**Purpose**: Runs the shared code-mode post-tool rejection assertion using a structured `decision: block` response. It proves explicit post-tool block decisions reject nested tool promises.

**Data flow**: Calls `assert_post_tool_use_blocks_code_mode_tool_result("decision_block", "blocked nested result by decision")` and returns its `Result<()>`.

**Call relations**: This is a thin wrapper around the shared post-tool code-mode helper for the decision-block variant.

*Call graph*: calls 1 internal fn (assert_post_tool_use_blocks_code_mode_tool_result).


##### `post_tool_use_exit_two_rejects_code_mode_tool_promise`  (lines 2978–2981)

```
async fn post_tool_use_exit_two_rejects_code_mode_tool_promise() -> Result<()>
```

**Purpose**: Runs the shared code-mode post-tool rejection assertion using hook process exit status 2 and stderr feedback. It proves exit-based post-tool failures also reject nested tool promises.

**Data flow**: Calls `assert_post_tool_use_blocks_code_mode_tool_result("exit_2", "blocked nested result by exit two")` and returns its `Result<()>`.

**Call relations**: This is the exit-2 counterpart to the decision-block wrapper, delegating to the same shared helper.

*Call graph*: calls 1 internal fn (assert_post_tool_use_blocks_code_mode_tool_result).


##### `plugin_pre_tool_use_blocks_shell_command_before_execution`  (lines 2984–3132)

```
async fn plugin_pre_tool_use_blocks_shell_command_before_execution() -> Result<()>
```

**Purpose**: Verifies that a plugin-provided `PreToolUse` hook discovered from plugin metadata can block a shell command before execution. It checks both command suppression and the plugin hook’s logged payload.

**Data flow**: It mounts a two-step SSE sequence for a shell command that would write a temp marker, creates a temporary home with plugin manifest, plugin config enabling `sample@test`, plugin hook script and `hooks/hooks.json`, constructs `PluginHookSource` values with absolute paths and parsed hook definitions, builds a test instance with `Feature::Plugins` enabled and `trust_plugin_hooks(config, plugin_hook_sources)`, removes any stale marker, submits a turn with `SandboxPolicy::DangerFullAccess`, inspects the second request’s function-call output to assert it contains the plugin hook reason, asserts the marker file does not exist, then reads the plugin hook log directly and asserts fields including `hook_event_name`, `tool_name`, `tool_use_id`, and `tool_input.command`.

**Call relations**: This test is the only consumer of `trust_plugin_hooks`; it synthesizes plugin discovery inputs and then validates that plugin-defined hooks participate in normal pre-tool interception.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_hook_inputs_from_log, try_from); 13 external calls (clone, new, new, assert!, assert_eq!, format!, create_dir_all, remove_file, write, json! (+3 more)).


##### `pre_tool_use_blocks_shell_when_defined_in_config_toml`  (lines 3135–3216)

```
async fn pre_tool_use_blocks_shell_when_defined_in_config_toml() -> Result<()>
```

**Purpose**: Checks that a `PreToolUse` hook defined in `config.toml` blocks a shell command the same way as one defined in `hooks.json`. It validates TOML hook loading and execution.

**Data flow**: It mounts a two-step SSE sequence for a shell command that would write a temp marker, installs a TOML-defined pre-tool hook in `json_deny` mode with matcher `^Bash$`, builds the test instance, removes any stale marker, submits a turn with disabled permissions, inspects the second request’s function-call output to assert it contains the TOML hook reason, asserts the marker file does not exist, then reads the custom TOML hook log file and asserts fields including `hook_event_name`, `tool_use_id`, and `tool_input.command`.

**Call relations**: This test uses `write_pre_tool_use_hook_toml` instead of the JSON fixture writer to prove config-TOML hooks are honored by the runtime.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_hook_inputs_from_log); 8 external calls (assert!, assert_eq!, format!, remove_file, json!, skip_if_no_network!, temp_dir, vec!).


##### `pre_tool_use_merges_hooks_json_and_config_toml`  (lines 3219–3317)

```
async fn pre_tool_use_merges_hooks_json_and_config_toml() -> Result<()>
```

**Purpose**: Verifies that hooks loaded from `hooks.json` and `config.toml` are both active and each receives the same pre-tool payload. The command should still execute because both fixtures are non-blocking.

**Data flow**: It mounts a two-step SSE sequence for a shell command printing `merged-hooks`, installs one `hooks.json` pre-tool hook and one TOML pre-tool hook, both matcher-scoped to Bash and effectively allowing execution, builds the test instance, submits a turn, inspects the second request’s function-call output to assert it contains `merged-hooks`, then reads both the JSON hook log and the TOML hook log, normalizes each entry down to `hook_event_name`, `tool_name`, `tool_use_id`, and `tool_input`, and asserts both logs equal the same expected single-entry vector.

**Call relations**: This test combines `write_pre_tool_use_hook`, `write_pre_tool_use_hook_toml`, `read_pre_tool_use_hook_inputs`, and `read_hook_inputs_from_log` to validate source merging.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_hook_inputs_from_log, read_pre_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `pre_tool_use_blocks_exec_command_before_execution`  (lines 3320–3398)

```
async fn pre_tool_use_blocks_exec_command_before_execution() -> Result<()>
```

**Purpose**: Checks that a `PreToolUse` hook can block unified exec before the command runs, surfacing the hook reason and original command in output. It is the exec-command analogue of the shell blocking test.

**Data flow**: It mounts a two-step SSE sequence where the model calls `exec_command` with a command that would write a temp marker, installs a Bash-matched pre-tool hook in `exit_2` mode with reason `blocked exec command`, enables unified exec in config, builds the test instance, removes any stale marker, submits a turn, inspects the second request’s function-call output string to assert it contains both the hook reason and `Command: <command>`, asserts the marker file does not exist, then reads the pre-tool hook log and asserts `tool_use_id`, `tool_input.command`, and non-empty `turn_id`.

**Call relations**: This test reuses the generic pre-tool fixture writer but changes runtime config to route through unified exec.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 8 external calls (assert!, assert_eq!, format!, remove_file, json!, skip_if_no_network!, temp_dir, vec!).


##### `pre_tool_use_blocks_apply_patch_before_execution`  (lines 3401–3470)

```
async fn pre_tool_use_blocks_apply_patch_before_execution() -> Result<()>
```

**Purpose**: Verifies that a `PreToolUse` hook can block `apply_patch` before any file changes occur. The blocked output should surface the hook reason and the target file should remain absent.

**Data flow**: It mounts a two-step SSE sequence where the model issues an `apply_patch` custom tool call adding a file, installs a matcher-scoped pre-tool hook for `^apply_patch$` in `json_deny` mode, builds the test instance, submits a turn, inspects the second request’s custom tool output string to assert it contains the hook reason, asserts the target workspace file does not exist, then reads the pre-tool hook log and asserts `tool_name == apply_patch`, `tool_use_id == call_id`, and `tool_input.command` equals the original patch text.

**Call relations**: This test extends pre-tool blocking beyond Bash surfaces to the custom apply-patch tool.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


##### `pre_tool_use_rewrites_apply_patch_before_execution`  (lines 3473–3540)

```
async fn pre_tool_use_rewrites_apply_patch_before_execution() -> Result<()>
```

**Purpose**: Checks that a `PreToolUse` hook can rewrite an `apply_patch` payload before execution so only the rewritten patch is applied. The original patch target must remain untouched.

**Data flow**: It mounts a two-step SSE sequence where the model issues an `apply_patch` custom tool call with an original patch, installs a pre-tool rewrite hook matching `^apply_patch$` and supplying `updatedInput.command = rewritten_patch`, builds the test instance, submits a turn, inspects the second request’s custom tool output, asserts the original target file does not exist, reads the rewritten target file and asserts it contains `rewritten\n`, then reads the pre-tool hook log and asserts the logged command is the original patch text.

**Call relations**: This test uses the generic rewrite fixture writer to prove apply-patch input rewriting works the same way as Bash command rewriting.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 6 external calls (assert!, assert_eq!, format!, json!, skip_if_no_network!, vec!).


##### `pre_tool_use_blocks_apply_patch_with_write_alias`  (lines 3543–3608)

```
async fn pre_tool_use_blocks_apply_patch_with_write_alias() -> Result<()>
```

**Purpose**: Verifies that a `PreToolUse` hook matching the `Write` alias can block `apply_patch`. It confirms alias-based matching applies before patch execution.

**Data flow**: It mounts a two-step SSE sequence for an `apply_patch` call adding a file, installs a pre-tool hook with matcher `^Write$` in `json_deny` mode, builds the test instance, submits a turn, inspects the second request’s custom tool output string to assert it contains the alias-based hook reason, asserts the target file does not exist, then reads the pre-tool hook log and asserts the runtime still reports `tool_name == apply_patch`, the correct `tool_use_id`, and the original patch text as `tool_input.command`.

**Call relations**: This test complements the direct apply-patch matcher case by proving alias matching works for pre-tool interception too.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


##### `pre_tool_use_blocks_local_function_tool_before_execution`  (lines 3611–3669)

```
async fn pre_tool_use_blocks_local_function_tool_before_execution() -> Result<()>
```

**Purpose**: Checks that `PreToolUse` hooks can block local function tools, not just shell-like tools. The blocked output should mention the tool name and hook reason.

**Data flow**: It mounts a two-step SSE sequence where the model calls local function tool `test_sync_tool` with empty JSON args, installs a pre-tool hook matching `^test_sync_tool$` in `json_deny` mode, builds the test instance in code-capable model mode, submits a turn, inspects the second request’s function-call output string to assert it contains `Tool call blocked by PreToolUse hook: <reason>. Tool: test_sync_tool`, then reads the pre-tool hook log and asserts `hook_event_name`, `tool_name`, `tool_use_id`, and `tool_input` equal the original empty args object.

**Call relations**: This test broadens pre-tool coverage to local function tools and uses the same log reader as the shell and exec cases.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `pre_tool_use_rewrites_local_function_tool_before_execution`  (lines 3672–3731)

```
async fn pre_tool_use_rewrites_local_function_tool_before_execution() -> Result<()>
```

**Purpose**: Verifies that a `PreToolUse` hook can rewrite the JSON input to a local function tool before invocation. The rewritten call should succeed even if the original arguments would have been invalid.

**Data flow**: It mounts a two-step SSE sequence where the model calls `test_sync_tool` with an invalid `barrier` object, installs a pre-tool rewrite hook matching `^test_sync_tool$` and supplying empty `{}` as `updatedInput`, builds the test instance, submits a turn, inspects the second request’s function-call output string and asserts it equals `ok`, then reads the pre-tool hook log and asserts the logged `tool_input` is still the original invalid args object.

**Call relations**: This test is the local-function analogue of the Bash and apply-patch rewrite tests, proving rewrite support is generic across tool types.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_pre_tool_use_hook_inputs); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_records_additional_context_for_shell_command`  (lines 3734–3820)

```
async fn post_tool_use_records_additional_context_for_shell_command() -> Result<()>
```

**Purpose**: Checks that a non-blocking `PostToolUse` hook can attach developer context after a shell command executes, while preserving the command output. It also validates the logged post-tool payload.

**Data flow**: It mounts a two-step SSE sequence for a shell command printing `post-tool-output`, installs a Bash-matched post-tool hook in `context` mode with a fixed note, builds the test instance, submits a turn, inspects the second request to assert developer messages contain the note, extracts the function-call output string and asserts it contains `post-tool-output`, then reads the post-tool hook log and asserts fields including `hook_event_name`, `tool_name`, `tool_use_id`, `tool_input.command`, `tool_response == 'post-tool-output'`, non-empty existing `transcript_path`, and non-empty `turn_id`.

**Call relations**: This is the baseline post-tool context test, using `write_post_tool_use_hook` for setup and `read_post_tool_use_hook_inputs` for payload validation.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_block_decision_replaces_shell_command_output_with_reason`  (lines 3823–3880)

```
async fn post_tool_use_block_decision_replaces_shell_command_output_with_reason() -> Result<()>
```

**Purpose**: Verifies that a structured `decision: block` from a `PostToolUse` hook replaces the shell command’s output with the hook’s reason after execution. The hook log should still contain the original tool response.

**Data flow**: It mounts a two-step SSE sequence for a shell command printing `blocked-output`, installs a Bash-matched post-tool hook in `decision_block` mode with a fixed reason, builds the test instance, submits a turn, inspects the second request’s function-call output string and asserts it equals the reason exactly, then reads the post-tool hook log and asserts `tool_response == 'blocked-output'`.

**Call relations**: This test demonstrates post-execution output replacement rather than pre-execution blocking, using the shared post-tool fixture writer and log reader.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_continue_false_replaces_shell_command_output_with_stop_reason`  (lines 3883–3941)

```
async fn post_tool_use_continue_false_replaces_shell_command_output_with_stop_reason() -> Result<()>
```

**Purpose**: Checks that a `PostToolUse` hook returning `continue: false` replaces shell command output with its stop reason. It validates the alternate stop-style post-tool contract.

**Data flow**: It mounts a two-step SSE sequence for a shell command printing `stop-output`, installs a Bash-matched post-tool hook in `continue_false` mode with a stop reason, builds the test instance, submits a turn, inspects the second request’s function-call output string and asserts it equals the stop reason, then reads the post-tool hook log and asserts `tool_response == 'stop-output'`.

**Call relations**: This test is the stop-style counterpart to the decision-block case, proving both post-tool response shapes are honored.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_exit_two_replaces_one_shot_exec_command_output_with_feedback`  (lines 3944–4010)

```
async fn post_tool_use_exit_two_replaces_one_shot_exec_command_output_with_feedback() -> Result<()>
```

**Purpose**: Verifies that when a `PostToolUse` hook exits with status 2 after a one-shot unified exec command, the exec output returned to the model is replaced by the hook’s stderr feedback. The hook log should still capture the original command output.

**Data flow**: It mounts a two-step SSE sequence for `exec_command` printing `post-hook-output`, installs a Bash-matched post-tool hook in `exit_2` mode with feedback `blocked by post hook`, enables unified exec in config, builds the test instance, submits a turn, inspects the second request’s function-call output string and asserts it equals the feedback, then reads the post-tool hook log and asserts the correct `tool_use_id`, `tool_input.command`, and `tool_response == 'post-hook-output'`.

**Call relations**: This test applies the post-tool exit-2 path to unified exec rather than shell_command, using the same fixture writer with different runtime config.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_spills_large_feedback_message`  (lines 4013–4075)

```
async fn post_tool_use_spills_large_feedback_message() -> Result<()>
```

**Purpose**: Checks that oversized post-tool feedback is truncated in the returned tool output and spilled to a file containing the full feedback text. It validates spill behavior for post-tool blocking messages.

**Data flow**: It mounts a two-step SSE sequence for `exec_command` printing `post-hook-output`, creates a very large repeated feedback string, installs a Bash-matched post-tool hook in `exit_2` mode with that feedback, enables unified exec, builds the test instance, submits a turn, inspects the second request’s function-call output string to assert it contains `tokens truncated`, extracts the spill path with `spilled_hook_output_path`, reads the file, and asserts it equals the trimmed original feedback.

**Call relations**: This test combines the post-tool fixture writer with the spill-path helper to validate large feedback handling on the exec path.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, spilled_hook_output_path); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `post_tool_use_blocks_when_exec_session_completes_via_write_stdin`  (lines 4078–4177)

```
async fn post_tool_use_blocks_when_exec_session_completes_via_write_stdin() -> Result<()>
```

**Purpose**: Verifies that `PostToolUse` still runs and can replace output when an exec session completes on a later `write_stdin` poll rather than in the initial `exec_command` call. It also checks the pre-hook and post-hook logs refer back to the original start call.

**Data flow**: After network and non-Windows guards, it mounts a three-step SSE sequence: `exec_command` starts a session running `sleep 1; printf session-post-hook-output`, `write_stdin` polls that session with empty chars, and a final assistant message completes the turn. It installs paired logging pre-hook and blocking post-hook fixtures, enables unified exec, builds the test instance, submits a turn, inspects the third request’s function-call output for the `write_stdin` call and asserts it equals the feedback string, then reads the pre-tool hook log to assert it contains one Bash entry for the original start call and command, and reads the post-tool hook log to assert it also refers to the original start call and that `tool_response` contains `session-post-hook-output`.

**Call relations**: This test is the session-oriented post-tool case, using the combined fixture writer and both hook log readers to prove post-tool evaluation happens when the session finally completes.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs, read_pre_tool_use_hook_inputs); 6 external calls (assert!, assert_eq!, json!, skip_if_no_network!, skip_if_windows!, vec!).


##### `post_tool_use_records_additional_context_for_apply_patch`  (lines 4180–4248)

```
async fn post_tool_use_records_additional_context_for_apply_patch() -> Result<()>
```

**Purpose**: Checks that a non-blocking `PostToolUse` hook can attach developer context after `apply_patch` executes, while the patch still applies successfully. It also validates the logged textual patch result.

**Data flow**: It mounts a two-step SSE sequence for an `apply_patch` custom tool call adding a file, installs a matcher-scoped post-tool hook for `^apply_patch$` in `context` mode, builds the test instance, submits a turn, inspects the second request to assert developer messages contain the post-tool note, asserts the target file exists, then reads the post-tool hook log and asserts `tool_name == apply_patch`, the correct `tool_use_id`, the original patch text in `tool_input.command`, and a string `tool_response` beginning with `Exit code: 0` and mentioning the added file.

**Call relations**: This test extends post-tool context injection to apply_patch and uses the post-tool log reader to inspect the patch tool’s textual success summary.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


##### `post_tool_use_records_apply_patch_context_with_edit_alias`  (lines 4251–4314)

```
async fn post_tool_use_records_apply_patch_context_with_edit_alias() -> Result<()>
```

**Purpose**: Verifies that a `PostToolUse` hook matching the `Edit` alias can attach context for an `apply_patch` call. It confirms alias matching works on the post-tool path as well.

**Data flow**: It mounts a two-step SSE sequence for an `apply_patch` custom tool call adding a file, installs a post-tool hook with matcher `^Edit$` in `context` mode, builds the test instance, submits a turn, inspects the second request to assert developer messages contain the alias-based context, asserts the target file exists, then reads the post-tool hook log and asserts `tool_name == apply_patch`, the correct `tool_use_id`, and the original patch text in `tool_input.command`.

**Call relations**: This is the alias-matching companion to the direct apply-patch post-tool context test, using the same fixture writer and log reader with a different matcher.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_post_tool_use_hook_inputs); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


### `core/tests/suite/hooks_mcp.rs`

`test` · `request handling`

This test file builds realistic MCP scenarios by combining a mock Responses API server, a real stdio MCP test server binary, and dynamically generated hook scripts written into the test Codex home directory. It defines constants for the rmcp server name, namespace variants, the fully qualified echo tool name, and the canonical test message so assertions stay tied to one concrete MCP tool path. The helper layer does three things: toggles the `Feature::NonPrefixedMcpToolNames` feature when requested, writes Python hook scripts plus `hooks.json` registrations for `PreToolUse` and `PostToolUse`, and injects an `McpServerConfig` for a stdio-backed rmcp server into `Config.mcp_servers` with explicit startup timeout and approval mode.

The tests then drive a turn through mocked SSE responses that first ask the model to call the rmcp `echo` tool and then send a follow-up assistant response. In the blocking case, the pre-tool hook returns a deny decision and the test asserts that no real tool output is used; instead the second request contains a synthetic function-call output string naming the hook reason and tool name. In the rewrite case, the hook allows execution but replaces the `message` field, and the test confirms the final tool output reflects only the rewritten input. In the post-tool case, the hook emits `additionalContext`, which must appear in the next developer message while the original MCP structured response is still preserved. All hook scripts append their stdin payloads to JSONL logs, and the tests parse those logs to verify exact hook payload fields and that `transcript_path` files were materialized on disk.

#### Function details

##### `enable_mcp_tool_name_features`  (lines 37–41)

```
fn enable_mcp_tool_name_features(config: &mut Config, prefix_mcp_tool_names: bool)
```

**Purpose**: Adjusts the test `Config` so MCP tool names are either left in legacy prefixed form or switched to the non-prefixed mode. It only mutates feature flags when the caller explicitly requests non-prefixed names.

**Data flow**: Takes a mutable `Config` and a `bool` flag. If `prefix_mcp_tool_names` is `false`, it enables `Feature::NonPrefixedMcpToolNames` on `config.features`; otherwise it leaves configuration unchanged. It returns no value and writes only to the feature set inside the provided config.

**Call relations**: This helper is invoked from `enable_hooks_and_rmcp_server` during test setup, before the test instance is built. It exists so the same end-to-end assertions can be run against both namespace conventions without duplicating feature-toggle logic.

*Call graph*: called by 1 (enable_hooks_and_rmcp_server).


##### `write_pre_tool_use_hook`  (lines 43–84)

```
fn write_pre_tool_use_hook(home: &Path, reason: &str) -> Result<()>
```

**Purpose**: Creates a Python `PreToolUse` hook fixture that logs its input payload and denies execution with a caller-supplied reason. It also writes the matching `hooks.json` registration that targets the rmcp echo tool.

**Data flow**: Receives the test home directory and a denial reason string. It derives `pre_tool_use_hook.py` and `pre_tool_use_hook_log.jsonl` paths under that home, serializes the reason into JSON-safe text, formats a Python script that reads stdin JSON, appends it to the log file, and prints a hook response with `permissionDecision: "deny"` and `permissionDecisionReason`. It then writes both the script file and a `hooks.json` object containing a `PreToolUse` matcher for `RMCP_HOOK_MATCHER` and returns `Result<()>`.

**Call relations**: Used by the blocking pre-tool tests via `with_pre_build_hook`, so the fixture exists before Codex starts. It does not call other local helpers; instead the later test flow relies on the generated files being discovered after `trust_discovered_hooks` is enabled.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_updating_pre_tool_use_hook`  (lines 86–128)

```
fn write_updating_pre_tool_use_hook(home: &Path, updated_message: &str) -> Result<()>
```

**Purpose**: Creates a Python `PreToolUse` hook fixture that logs the original tool payload and allows execution after rewriting the MCP tool input message. This is the fixture for testing hook-driven input mutation.

**Data flow**: Accepts the test home path and the replacement message text. It computes script and JSONL log paths, serializes the replacement string, formats a Python script that reads stdin JSON, appends the original payload to the log, and prints a hook response with `permissionDecision: "allow"` plus `updatedInput: { "message": ... }`. It writes the script and a `hooks.json` file registering the command hook for the rmcp echo matcher, then returns `Result<()>`.

**Call relations**: Called from `pre_tool_use_rewrites_mcp_tool_before_execution` during pre-build setup. The later test asserts both sides of this relation: the hook log still contains the original input, while the actual MCP server execution reflects the rewritten input emitted by this script.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `write_post_tool_use_hook`  (lines 130–171)

```
fn write_post_tool_use_hook(home: &Path, additional_context: &str) -> Result<()>
```

**Purpose**: Creates a Python `PostToolUse` hook fixture that records the completed tool payload and emits additional context for the next model request. It is the post-execution analogue of the pre-tool fixtures.

**Data flow**: Takes the test home path and an `additional_context` string. It builds `post_tool_use_hook.py` and `post_tool_use_hook_log.jsonl` paths, JSON-escapes the context string, formats a Python script that reads stdin JSON, appends it to the log, and prints a hook response containing `hookEventName: "PostToolUse"` and `additionalContext`. It writes that script and a `hooks.json` registration for the rmcp echo matcher, returning `Result<()>`.

**Call relations**: Installed by `post_tool_use_records_mcp_tool_payload_and_context` before the test instance is built. The subsequent turn execution depends on this fixture to inject developer-visible context into the follow-up request while preserving the original tool output.

*Call graph*: 5 external calls (join, format!, write, json!, to_string).


##### `read_hook_inputs`  (lines 173–180)

```
fn read_hook_inputs(home: &Path, log_name: &str) -> Result<Vec<Value>>
```

**Purpose**: Loads the JSONL log produced by a hook script and parses each non-empty line into a `serde_json::Value`. It gives the tests a structured view of the exact hook stdin payloads Codex emitted.

**Data flow**: Receives the test home path and a log filename. It reads the whole file from `home.join(log_name)`, splits into lines, drops blank lines, parses each remaining line as JSON with contextual error messages, and collects the results into `Vec<Value>`. It returns that vector without mutating any state.

**Call relations**: This helper is called by all three end-to-end hook scenarios after the turn completes. Those tests use it to validate concrete fields such as `hook_event_name`, `tool_name`, `tool_use_id`, `tool_input`, `tool_response`, and `transcript_path` that were written by the runtime into the hook process stdin.

*Call graph*: called by 3 (post_tool_use_records_mcp_tool_payload_and_context, pre_tool_use_blocks_mcp_tool_before_execution, pre_tool_use_rewrites_mcp_tool_before_execution); 2 external calls (join, read_to_string).


##### `insert_rmcp_test_server`  (lines 182–214)

```
fn insert_rmcp_test_server(config: &mut Config, command: String, approval_mode: AppToolApproval)
```

**Purpose**: Adds a concrete stdio MCP server entry named `rmcp` into the mutable test configuration. The inserted server is enabled, optional, single-call, and configured with the approval mode requested by the test.

**Data flow**: Takes a mutable `Config`, a command string for the stdio server binary, and an `AppToolApproval`. It clones the current MCP server map, inserts a new `McpServerConfig` keyed by `RMCP_SERVER` with `McpServerTransportConfig::Stdio { command, args: [], env: None, env_vars: [], cwd: None }`, default environment id, `enabled: true`, `required: false`, `supports_parallel_tool_calls: false`, `startup_timeout_sec: Some(Duration::from_secs(10))`, and `default_tools_approval_mode: Some(approval_mode)`, then writes the map back through `config.mcp_servers.set(...)`. It returns no value.

**Call relations**: Called only from `enable_hooks_and_rmcp_server` as part of test configuration assembly. It is the piece that makes the later `wait_for_mcp_server` call meaningful by ensuring the rmcp stdio server exists in the built configuration.

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

**Purpose**: Bundles the common test setup needed for MCP hook scenarios: trust hook discovery, choose the MCP naming mode, and register the rmcp stdio server. It centralizes the configuration mutations shared by all hook tests.

**Data flow**: Consumes a mutable `Config`, the rmcp server binary path, an approval mode, and the prefixing flag. It first marks discovered hooks as trusted, then conditionally enables non-prefixed MCP tool names, then inserts the rmcp server definition. It returns no value and mutates only the provided config.

**Call relations**: Used inside each test builder’s `with_config` closure. It delegates to `trust_discovered_hooks`, `enable_mcp_tool_name_features`, and `insert_rmcp_test_server` so the actual test bodies can focus on mocked responses and assertions.

*Call graph*: calls 3 internal fn (trust_discovered_hooks, enable_mcp_tool_name_features, insert_rmcp_test_server).


##### `pre_tool_use_blocks_mcp_tool_before_execution_with_legacy_prefixed_names`  (lines 228–234)

```
async fn pre_tool_use_blocks_mcp_tool_before_execution_with_legacy_prefixed_names() -> Result<()>
```

**Purpose**: Runs the shared pre-tool blocking scenario using the legacy `mcp__rmcp` namespace. It exists to pin behavior for the older naming convention.

**Data flow**: Takes no arguments and asynchronously calls the shared blocking helper with `prefix_mcp_tool_names = true` and `RMCP_PREFIXED_NAMESPACE`. It returns the helper’s `Result<()>` unchanged.

**Call relations**: This is a thin `#[tokio::test]` wrapper around `pre_tool_use_blocks_mcp_tool_before_execution`. Its only role in call flow is selecting the prefixed namespace variant.

*Call graph*: calls 1 internal fn (pre_tool_use_blocks_mcp_tool_before_execution).


##### `pre_tool_use_blocks_mcp_tool_before_execution_with_non_prefixed_names`  (lines 237–243)

```
async fn pre_tool_use_blocks_mcp_tool_before_execution_with_non_prefixed_names() -> Result<()>
```

**Purpose**: Runs the shared pre-tool blocking scenario using the non-prefixed `rmcp` namespace. It verifies the same hook semantics after the naming feature switch.

**Data flow**: Takes no arguments and asynchronously invokes the shared blocking helper with `prefix_mcp_tool_names = false` and `RMCP_UNPREFIXED_NAMESPACE`. It returns the resulting `Result<()>`.

**Call relations**: Like the legacy wrapper, this test delegates entirely to `pre_tool_use_blocks_mcp_tool_before_execution`, differing only in the namespace and feature mode selected.

*Call graph*: calls 1 internal fn (pre_tool_use_blocks_mcp_tool_before_execution).


##### `pre_tool_use_blocks_mcp_tool_before_execution`  (lines 245–332)

```
async fn pre_tool_use_blocks_mcp_tool_before_execution(
    prefix_mcp_tool_names: bool,
    mcp_namespace: &'static str,
) -> Result<()>
```

**Purpose**: Executes the full deny-before-execution scenario for the rmcp echo tool and proves that a `PreToolUse` hook can stop the MCP call before the stdio server runs. It also verifies the exact hook payload written to disk.

**Data flow**: Accepts the naming-mode flag and expected MCP namespace. It skips when networking is unavailable, starts a mock server, mounts a two-response SSE sequence where the first response emits a function call and the second emits an assistant message, builds a test Codex instance with a generated denying pre-tool hook and rmcp server config, waits for the MCP server to come up, and submits a user turn. After execution it inspects recorded HTTP requests, extracts the function-call output for the original `call_id`, asserts that the output string contains the block reason and fully qualified tool name, reads `pre_tool_use_hook_log.jsonl`, and asserts the logged JSON fields and on-disk `transcript_path`. It returns `Ok(())` on success.

**Call relations**: Invoked by both namespace-specific wrapper tests. Internally it orchestrates the whole scenario: mock Responses API setup, fixture generation through `write_pre_tool_use_hook`, config setup through `enable_hooks_and_rmcp_server`, runtime synchronization via `wait_for_mcp_server`, and post-run verification via `read_hook_inputs`.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_hook_inputs); called by 2 (pre_tool_use_blocks_mcp_tool_before_execution_with_legacy_prefixed_names, pre_tool_use_blocks_mcp_tool_before_execution_with_non_prefixed_names); 7 external calls (assert!, assert_eq!, stdio_server_bin, wait_for_mcp_server, json!, skip_if_no_network!, vec!).


##### `pre_tool_use_rewrites_mcp_tool_before_execution`  (lines 335–407)

```
async fn pre_tool_use_rewrites_mcp_tool_before_execution() -> Result<()>
```

**Purpose**: Verifies that a `PreToolUse` hook can modify MCP tool input before execution and that the rewritten payload, not the original one, reaches the rmcp server. It also confirms the hook itself saw the original input.

**Data flow**: This async test starts a mock server, mounts one SSE response that requests the rmcp echo tool and a second SSE response for the final assistant message, builds a test Codex instance with a generated rewriting pre-tool hook and rmcp server config, waits for the MCP server, and submits a turn. It then inspects the final request’s function-call output string to ensure it contains `ECHOING: {rewritten_message}` and does not contain the original `RMCP_ECHO_MESSAGE`, reads the pre-tool hook JSONL log to confirm the logged `tool_input` still matches the original message, and touches the first mock request to ensure it was consumed. It returns `Result<()>`.

**Call relations**: This is a standalone test rather than a shared helper because only the legacy prefixed namespace is exercised here. It depends on `write_updating_pre_tool_use_hook` for fixture creation, `enable_hooks_and_rmcp_server` for config wiring, and `read_hook_inputs` for validating what the hook process received.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_hook_inputs); 7 external calls (assert!, assert_eq!, stdio_server_bin, wait_for_mcp_server, json!, skip_if_no_network!, vec!).


##### `post_tool_use_records_mcp_tool_payload_and_context_with_legacy_prefixed_names`  (lines 410–417)

```
async fn post_tool_use_records_mcp_tool_payload_and_context_with_legacy_prefixed_names() -> Result<()>
```

**Purpose**: Runs the shared post-tool hook scenario using the legacy prefixed MCP namespace. It ensures post-execution metadata and context work in the older naming mode.

**Data flow**: Takes no arguments and awaits the shared post-tool helper with `prefix_mcp_tool_names = true` and `RMCP_PREFIXED_NAMESPACE`. It returns the helper’s `Result<()>`.

**Call relations**: This wrapper exists only to parameterize `post_tool_use_records_mcp_tool_payload_and_context` for the prefixed namespace variant.

*Call graph*: calls 1 internal fn (post_tool_use_records_mcp_tool_payload_and_context).


##### `post_tool_use_records_mcp_tool_payload_and_context_with_non_prefixed_names`  (lines 420–427)

```
async fn post_tool_use_records_mcp_tool_payload_and_context_with_non_prefixed_names() -> Result<()>
```

**Purpose**: Runs the shared post-tool hook scenario using the non-prefixed MCP namespace. It verifies that post-tool hook payloads and added context survive the naming-mode change.

**Data flow**: Takes no arguments and awaits the shared helper with `prefix_mcp_tool_names = false` and `RMCP_UNPREFIXED_NAMESPACE`. It returns the resulting `Result<()>`.

**Call relations**: Like the legacy wrapper, this test delegates all substantive work to `post_tool_use_records_mcp_tool_payload_and_context`, differing only in the namespace and feature flag selection.

*Call graph*: calls 1 internal fn (post_tool_use_records_mcp_tool_payload_and_context).


##### `post_tool_use_records_mcp_tool_payload_and_context`  (lines 429–532)

```
async fn post_tool_use_records_mcp_tool_payload_and_context(
    prefix_mcp_tool_names: bool,
    mcp_namespace: &'static str,
) -> Result<()>
```

**Purpose**: Executes the full post-tool hook scenario and verifies two outputs: the hook receives the exact MCP request/response payload, and its `additionalContext` is injected into the next model request. It also confirms the original tool output still reaches the model.

**Data flow**: Accepts the naming-mode flag and namespace string. It skips without network, starts a mock server, mounts one SSE response that emits an rmcp echo function call and a second SSE response for the assistant follow-up, builds a test Codex instance with a generated post-tool hook and rmcp server config, waits for the MCP server, and submits a turn. Afterward it inspects the final request to assert the developer message texts include the supplied post-hook context and that the function-call output string still contains `ECHOING: {RMCP_ECHO_MESSAGE}`. It then parses `post_tool_use_hook_log.jsonl` with `read_hook_inputs` and asserts the logged event name, tool name, call id, original input, structured tool response payload, and existence of `transcript_path`, finally confirming the initial call mock was consumed.

**Call relations**: Called by both namespace-specific wrapper tests. It ties together fixture generation via `write_post_tool_use_hook`, common config setup via `enable_hooks_and_rmcp_server`, runtime synchronization via `wait_for_mcp_server`, and log verification via `read_hook_inputs`.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_hook_inputs); called by 2 (post_tool_use_records_mcp_tool_payload_and_context_with_legacy_prefixed_names, post_tool_use_records_mcp_tool_payload_and_context_with_non_prefixed_names); 7 external calls (assert!, assert_eq!, stdio_server_bin, wait_for_mcp_server, json!, skip_if_no_network!, vec!).


### `core/tests/suite/user_notification.rs`

`test` · `post-turn completion hook during integration tests`

This Unix-only test verifies the `notify` configuration path end to end. It starts a mock server that returns a single assistant message `Done`, then creates a temporary directory containing an executable `notify.sh` script. That script writes its final argument into `notify.txt` atomically via a temporary file and `mv`, which mirrors how a real notification command would receive the payload. The test builds `TestCodex` with `cfg.notify = Some(vec![notify_script_path])`, submits a normal `Op::UserInput` containing `hello world`, and waits for `TurnComplete`.

Because the notification script is forked asynchronously, the test then waits for the output file to appear with `fs_wait::wait_for_path_exists`, reads the file contents, parses them as JSON, and asserts the payload shape. Specifically, it expects `type == "agent-turn-complete"`, `input-messages == ["hello world"]`, and `last-assistant-message == "Done"`. The test therefore documents both when notifications fire—after turn completion—and the exact summary fields passed to external hooks.

#### Function details

##### `summarize_context_three_requests_and_instructions`  (lines 26–82)

```
async fn summarize_context_three_requests_and_instructions() -> anyhow::Result<()>
```

**Purpose**: Verifies that a configured notify script is invoked after a completed turn and receives a JSON payload summarizing the turn.

**Data flow**: It starts a mock SSE server returning one assistant message, writes an executable shell script that stores its last argument into `notify.txt`, builds `TestCodex` with that script in `cfg.notify`, submits a text user turn, waits for `TurnComplete`, waits for the notify file to appear, reads and parses the JSON payload, and asserts the payload type, input messages, and last assistant message.

**Call relations**: This is the file's only test and covers the full notification path from turn completion through asynchronous external process execution.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 13 external calls (default, from_secs, new, assert_eq!, from_mode, wait_for_event, wait_for_path_exists, from_str, skip_if_no_network!, set_permissions (+3 more)).
