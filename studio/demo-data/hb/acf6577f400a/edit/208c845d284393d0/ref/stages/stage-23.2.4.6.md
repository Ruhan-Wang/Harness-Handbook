# Tool, shell/exec, MCP/app, plugin, and runtime item suites  `stage-23.2.4.6`

This stage is the system’s full dress rehearsal for tool use during the main work of a turn. It checks what tools the model or user can see, what happens when those tools run, and how the results are reported back. Think of it as testing the workshop floor: which tools are on the bench, who is allowed to use them, and what gets written in the job log.

Several suites focus on command running. tools.rs, tool_harness.rs, exec.rs, shell_command.rs, unified_exec.rs, shell_snapshot.rs, user_shell_cmd.rs, and abort_tasks.rs cover shell and exec commands, time limits, sandboxes, snapshots, interruptions, and the records produced while they run. apply_patch_cli.rs and shell_serialization.rs check file-editing tools and make sure outputs are sent back in the right plain-text form, with truncation.rs limiting oversized results safely.

Other files test special tool families. plugins.rs, request_plugin_install.rs, search_tool.rs, openai_file_mcp.rs, extension_sandbox.rs, code_mode.rs, and view_image.rs cover plugin discovery, app/MCP integrations, file upload before tool calls, extension permissions, script-runtime tool use, and image handling. Finally, tool_parallelism.rs and items.rs verify that multiple tools can run together and that the stream of events and history items accurately tells the story of what happened.

## Files in this stage

### Tool execution foundations
These suites establish the baseline harness, exposure rules, and core execution paths for built-in shell, exec, and apply-patch tooling.

### `core/tests/suite/tools.rs`

`test` · `request handling`

This non-Windows suite mixes tool-list inspection with execution-path tests. The helper `tool_names` extracts tool identifiers from a request body, accepting either `name` or `type` fields so it works across tool schema variants. The first tests use that helper to verify feature and environment gating: with `Feature::UnifiedExec` enabled but an explicit empty turn-environment list, environment-backed tools such as `exec_command`, `write_stdin`, `apply_patch`, and `view_image` must be omitted while non-environment tools like `update_plan` remain; selecting a local environment restores those tools.

Execution tests then drive mocked tool calls through `TestCodex`. Unknown custom tools must produce a custom-tool output string of the form `unsupported custom tool call: ...`. Shell-command approval logic is checked by first requesting `SandboxPermissions::RequireEscalated` under `AskForApproval::Never`, which should be rejected with a precise policy message, followed by a normal shell command that succeeds. Sandbox behavior is tested more deeply by running commands that attempt forbidden writes or reads: the returned shell output must preserve the command's original stdout/stderr, include OS-specific denial text and the denied path, and surface a non-zero exit code rather than replacing the output with a generic fallback.

The file also includes `collect_tools`, a small end-to-end helper used to compare tool exposure with UnifiedExec disabled versus enabled. Finally, two timeout tests validate that long-running shell commands report timeout metadata or acceptable fallback signal errors, and that detached grandchildren inheriting stdout do not cause the exec path to hang past the timeout window.

#### Function details

##### `tool_names`  (lines 37–52)

```
fn tool_names(body: &Value) -> Vec<String>
```

**Purpose**: Extracts the advertised tool names from a request body JSON value. It supports both `name` and `type` fields so tests can inspect heterogeneous tool schemas uniformly.

**Data flow**: It reads `body["tools"]` as an array, iterates each tool object, tries `tool["name"]` first and then `tool["type"]`, converts any string values to owned `String`s, collects them into a vector, and returns an empty vector if the tools array is absent.

**Call relations**: This helper is used by the environment-selection tests and by `collect_tools` to compare feature-gated tool exposure.

*Call graph*: called by 3 (collect_tools, empty_turn_environments_omits_environment_backed_tools, turn_environment_selection_keeps_environment_backed_tools); 1 external calls (get).


##### `empty_turn_environments_omits_environment_backed_tools`  (lines 55–93)

```
async fn empty_turn_environments_omits_environment_backed_tools() -> Result<()>
```

**Purpose**: Verifies that explicitly selecting no environments for a turn removes environment-backed tools from the tool list even when UnifiedExec is enabled. It preserves non-environment tools such as `update_plan`.

**Data flow**: It starts a mock server, mounts a simple assistant-completion response, builds a `TestCodex` with `Feature::UnifiedExec` enabled, submits a turn with `Some(vec![])` as the environment selection, extracts tool names from the captured request body, asserts `update_plan` is present, and asserts `exec_command`, `write_stdin`, `apply_patch`, and `view_image` are absent.

**Call relations**: This test checks request construction rather than tool execution, establishing the semantics of an explicit empty environment list.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_names); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `turn_environment_selection_keeps_environment_backed_tools`  (lines 96–131)

```
async fn turn_environment_selection_keeps_environment_backed_tools() -> Result<()>
```

**Purpose**: Checks the opposite environment-selection case: when a local environment is explicitly selected, environment-backed tools remain available in the request.

**Data flow**: It starts a mock server, mounts a simple completion response, builds a `TestCodex` with UnifiedExec enabled, submits a turn with `Some(vec![local(test.config.cwd.clone())])`, extracts tool names from the captured request, and asserts that `exec_command` is present.

**Call relations**: This complements the previous test by proving that tool omission is tied to an empty selection, not to explicit environment selection in general.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_names); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `custom_tool_unknown_returns_custom_output_error`  (lines 134–178)

```
async fn custom_tool_unknown_returns_custom_output_error() -> Result<()>
```

**Purpose**: Ensures that an unsupported custom tool call is surfaced back to the model as a custom-tool output error string rather than crashing or silently disappearing.

**Data flow**: It starts a mock server, builds a default `TestCodex`, mounts one SSE response containing `ev_custom_tool_call` for `unsupported_tool` and a second completion response, submits a turn with approval disabled and `PermissionProfile::Disabled`, reads the custom tool output item from the second request, extracts its `output` string, formats the expected `unsupported custom tool call: unsupported_tool` message, and asserts equality.

**Call relations**: This test covers the fallback path for unknown custom tools, distinct from the standard function-call tool paths exercised elsewhere.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (assert_eq!, format!, skip_if_no_network!, vec!).


##### `shell_command_escalated_permissions_rejected_then_ok`  (lines 181–272)

```
async fn shell_command_escalated_permissions_rejected_then_ok() -> Result<()>
```

**Purpose**: Verifies that a shell command requesting escalated sandbox permissions is rejected under `AskForApproval::Never`, while a subsequent normal shell command in the same overall interaction succeeds. It checks both the rejection wording and the successful output format.

**Data flow**: It starts a mock server, builds a `TestCodex` with model `test-gpt-5-codex`, prepares two shell-command argument objects for the same command—one with `sandbox_permissions: RequireEscalated`, one without—mounts three SSE responses (blocked call, successful call, final assistant completion), submits a turn with approval disabled and `PermissionProfile::Disabled`, then inspects the second request's blocked tool output and asserts it equals the formatted approval-policy rejection message. It inspects the third request's successful tool output and regex-matches the standard shell output envelope containing `shell ok`.

**Call relations**: This test exercises approval-policy enforcement inside the shell tool runner while also proving that later non-escalated calls still execute normally.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (assert_eq!, assert_regex_match, format!, json!, skip_if_no_network!, vec!).


##### `sandbox_denied_shell_command_returns_original_output`  (lines 275–362)

```
async fn sandbox_denied_shell_command_returns_original_output() -> Result<()>
```

**Purpose**: Checks that when the sandbox denies a shell command's filesystem write, the tool output returned to the model preserves the command's original stdout/stderr and exit code rather than replacing it with a generic sandbox failure wrapper.

**Data flow**: It starts a mock server, builds a `TestCodex` with model `gpt-5.4`, constructs a command that prints a sentinel line and then attempts to write to a target file, mounts a two-response SSE sequence with a `shell_command` call and final completion, submits a turn under `PermissionProfile::read_only()`, extracts the shell output text from the mock, parses the first line's exit code, lowercases the body for denial checks, and asserts that the output contains an OS-specific denial phrase, the sentinel stdout, the denied path string, no generic `failed in sandbox` fallback text, and a non-zero exit code.

**Call relations**: This test focuses on fidelity of error propagation from the sandboxed shell process back into the model-visible tool output.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_only); 6 external calls (assert!, assert_ne!, format!, json!, skip_if_no_network!, vec!).


##### `shell_command_enforces_glob_deny_read_policy`  (lines 365–467)

```
async fn shell_command_enforces_glob_deny_read_policy() -> Result<()>
```

**Purpose**: Verifies that a glob-based deny-read sandbox rule blocks access to matching files while still allowing reads of non-matching files, and that the shell output reflects both the denial and the allowed content.

**Data flow**: It skips sandboxed environments, starts a mock server, builds a `TestCodex` whose config installs a `FileSystemSandboxPolicy` entry denying `**/*.env` under the workspace and derives a permission profile from that runtime policy, creates fixture files `secret.env` and `notes.txt`, mounts a two-response SSE sequence with a shell command that cats the denied file, then the allowed file, and exits with the denied command's status, submits a turn using the configured permission profile, extracts the shell output text, parses the exit code, and asserts the exit code is non-zero, the allowed file contents are present, the secret contents are absent, and the output contains an OS-specific denial phrase.

**Call relations**: This test validates path-pattern enforcement in the shell sandbox and confirms that denied reads do not leak file contents into the model-visible output.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 9 external calls (assert!, assert_ne!, format!, create_dir_all, write, json!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `collect_tools`  (lines 469–503)

```
async fn collect_tools(use_unified_exec: bool) -> Result<Vec<String>>
```

**Purpose**: Builds a codex instance with UnifiedExec either enabled or disabled, submits a simple turn, and returns the advertised tool names. It is a reusable helper for feature-toggle assertions.

**Data flow**: It starts a mock server, mounts a single assistant-completion response, builds a `TestCodex` whose config enables or disables `Feature::UnifiedExec` based on the boolean argument, submits a turn with approval disabled and `PermissionProfile::Disabled`, reads the first request body from the mock, extracts tool names with `tool_names`, and returns them as `Result<Vec<String>>`.

**Call relations**: This helper is used only by `unified_exec_spec_toggle_end_to_end` to compare the tool list across the feature toggle.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, tool_names); called by 1 (unified_exec_spec_toggle_end_to_end); 1 external calls (vec!).


##### `unified_exec_spec_toggle_end_to_end`  (lines 506–530)

```
async fn unified_exec_spec_toggle_end_to_end() -> Result<()>
```

**Purpose**: Checks the end-to-end effect of the UnifiedExec feature flag on tool exposure. It ensures `exec_command` and `write_stdin` are absent when disabled and present when enabled.

**Data flow**: It skips if no network, calls `collect_tools(false)` and asserts neither `exec_command` nor `write_stdin` appears, then calls `collect_tools(true)` and asserts both names are present.

**Call relations**: This test is a concise consumer of `collect_tools`, validating the feature gate at the request-schema level rather than through execution.

*Call graph*: calls 1 internal fn (collect_tools); 2 external calls (assert!, skip_if_no_network!).


##### `shell_command_timeout_includes_timeout_prefix_and_metadata`  (lines 533–616)

```
async fn shell_command_timeout_includes_timeout_prefix_and_metadata() -> Result<()>
```

**Purpose**: Verifies timeout reporting for long-running shell commands, accepting both the preferred structured timeout output and a fallback signal-classification path. It checks that timeout metadata or equivalent timeout text reaches the model.

**Data flow**: It starts a mock server, builds a `TestCodex` with model `test-gpt-5-codex`, mounts a `shell_command` call running `yes line | head -n 400; sleep 1` with a 50 ms timeout and a second completion response, submits a turn with approval disabled and `PermissionProfile::Disabled`, extracts the raw `output` string from the function-call output item, then branches: if the string parses as JSON, it asserts `metadata.exit_code == 124` and that the `output` field mentions `command timed out`; otherwise it normalizes line endings and accepts either a regex-matched plain shell timeout envelope with exit code 124 or a fallback regex indicating a signal-based execution error.

**Call relations**: This test is intentionally tolerant of timing-dependent implementation details while still enforcing that timeout semantics are surfaced correctly.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (new, assert!, assert_eq!, assert_regex_match, json!, skip_if_no_network!, vec!).


##### `shell_command_timeout_handles_background_grandchild_stdout`  (lines 619–713)

```
async fn shell_command_timeout_handles_background_grandchild_stdout() -> Result<()>
```

**Purpose**: Ensures the shell-command timeout path does not hang when the timed-out process spawned a detached grandchild that inherited stdout/stderr. It validates both timeout reporting and prompt return after the timeout deadline.

**Data flow**: It starts a mock server, builds a `TestCodex` with model `gpt-5.4` and disabled permissions, writes a Python script into the workspace that spawns a detached `/bin/sh -c 'sleep 60'` grandchild, records its pid to a file, and then sleeps, mounts a `shell_command` call running that script with a 200 ms timeout plus a completion response, records `Instant::now()`, wraps turn submission and output extraction in `tokio::time::timeout(Duration::from_secs(10), ...)`, then inspects the returned output string. If it parses as JSON it asserts exit code 124; otherwise it regex-matches generic timeout text. It asserts total elapsed time is under 9 seconds and, if the pid file exists and parses, sends `SIGKILL` to clean up the detached grandchild.

**Call relations**: This test targets a subtle process-management edge case: even with live descendants holding pipes open, the exec path must return promptly after timeout instead of blocking on inherited stdout closure.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 13 external calls (from_secs, now, assert!, assert_eq!, assert_regex_match, format!, read_to_string, write, json!, kill (+3 more)).


### `core/tests/suite/tool_harness.rs`

`test` · `request handling`

This non-Windows test suite drives individual tool calls through the normal turn loop using mocked model responses. Two small helpers, `call_output` and `custom_call_output`, validate that a captured request contains the expected `call_id` and then extract the tool output text plus optional success flag from either standard `function_call_output` items or custom-tool outputs.

Each test builds a `TestCodex`, mounts one SSE response that instructs the model to invoke a tool, and mounts a second response that completes the turn after the tool result is sent back. The submitted `Op::UserInput` always includes explicit `ThreadSettingsOverrides`: local environment selections, `AskForApproval::Never`, a sandbox policy and permission profile derived from the test workspace, and a collaboration-mode block carrying the session model. That ensures the tool is actually available and executable in the turn.

The shell-command test checks the formatted output envelope (`Exit code`, `Wall time`, `Output`) with a regex. The plan-update tests watch the event stream for `EventMsg::PlanUpdate`, asserting correct `StepStatus` values for a valid payload and confirming no plan event is emitted for malformed arguments while the tool output reports a parse failure and may mark `success=false`. The apply-patch tests go further by asserting `ItemStarted`, `ItemCompleted`, `PatchApplyBegin`, and `PatchApplyEnd` events, verifying the resulting file contents on disk, and checking that malformed patches surface parser diagnostics in the custom tool output.

#### Function details

##### `call_output`  (lines 32–44)

```
fn call_output(req: &ResponsesRequest, call_id: &str) -> (String, Option<bool>)
```

**Purpose**: Extracts and validates a standard function-call output item from a captured request. It ensures the embedded `call_id` matches the expected tool invocation before returning the output text and success flag.

**Data flow**: It takes a `ResponsesRequest` and expected `call_id`, reads the raw function-call output JSON, asserts its `call_id` field matches, then reads the parsed `(content, success)` tuple via `function_call_output_content_and_success`, unwraps the content string, and returns `(String, Option<bool>)`.

**Call relations**: The shell-command and update-plan tests use this helper to avoid repeating output extraction and `call_id` consistency checks.

*Call graph*: calls 2 internal fn (function_call_output, function_call_output_content_and_success); called by 3 (shell_command_tool_executes_command_and_streams_output, update_plan_tool_emits_plan_update_event, update_plan_tool_rejects_malformed_payload); 1 external calls (assert_eq!).


##### `custom_call_output`  (lines 46–58)

```
fn custom_call_output(req: &ResponsesRequest, call_id: &str) -> (String, Option<bool>)
```

**Purpose**: Extracts and validates a custom-tool output item from a captured request. It mirrors `call_output` but for custom tool calls such as `apply_patch`.

**Data flow**: It takes a `ResponsesRequest` and expected `call_id`, reads the raw custom-tool output JSON, asserts the `call_id` matches, then obtains `(content, success)` from `custom_tool_call_output_content_and_success`, unwraps the content string, and returns it with the optional success flag.

**Call relations**: The apply-patch tests use this helper when inspecting the custom tool output sent back to the model.

*Call graph*: calls 2 internal fn (custom_tool_call_output, custom_tool_call_output_content_and_success); called by 2 (apply_patch_reports_parse_diagnostics, apply_patch_tool_executes_and_emits_patch_events); 1 external calls (assert_eq!).


##### `shell_command_tool_executes_command_and_streams_output`  (lines 61–135)

```
async fn shell_command_tool_executes_command_and_streams_output() -> anyhow::Result<()>
```

**Purpose**: Verifies that the `shell_command` tool executes a simple command and returns the expected formatted output to the model. It covers the happy path for standard shell execution through the tool harness.

**Data flow**: It starts a mock server, builds a `TestCodex` with model `test-gpt-5-codex`, mounts a first SSE response that calls `shell_command` with `echo tool harness` and `login: false`, mounts a second assistant-completion response, derives sandbox and permission settings from the workspace, submits an `Op::UserInput` with explicit thread settings, waits for `TurnComplete`, then inspects the second request with `call_output` and regex-matches the returned text against the expected exit-code/wall-time/output format.

**Call relations**: This test is the simplest end-to-end harness check in the file and establishes the baseline output format later reused in timeout and sandbox-related suites.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, call_output); 6 external calls (default, assert_regex_match, wait_for_event, json!, skip_if_no_network!, vec!).


##### `update_plan_tool_emits_plan_update_event`  (lines 138–230)

```
async fn update_plan_tool_emits_plan_update_event() -> anyhow::Result<()>
```

**Purpose**: Checks that a valid `update_plan` tool call both emits a `PlanUpdate` event to the client and returns `Plan updated` to the model. It validates event payload structure as well as tool output.

**Data flow**: It mounts a first SSE response that calls `update_plan` with an explanation and two plan steps, mounts a second completion response, submits a user turn with explicit thread settings, then waits on events until `TurnComplete`, setting a local flag when `EventMsg::PlanUpdate` arrives and asserting the explanation, step texts, and `StepStatus` values. After completion it inspects the second request via `call_output` and asserts the output text is exactly `Plan updated`.

**Call relations**: This test couples event-stream observation with request inspection, proving that the tool harness updates both client-visible state and model-visible tool output.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, call_output); 7 external calls (default, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `update_plan_tool_rejects_malformed_payload`  (lines 233–327)

```
async fn update_plan_tool_rejects_malformed_payload() -> anyhow::Result<()>
```

**Purpose**: Ensures that malformed `update_plan` arguments do not emit a `PlanUpdate` event and instead produce an error-like tool output, optionally marked with `success=false`.

**Data flow**: It mounts a first SSE response that calls `update_plan` with JSON missing the required `plan` field, mounts a second completion response, submits a turn with explicit thread settings, waits through events until `TurnComplete` while tracking whether any `PlanUpdate` was seen, asserts that none occurred, then extracts the tool output with `call_output`, checks that the text contains `failed to parse function arguments`, and if a success flag is present asserts it is false.

**Call relations**: This is the negative-path counterpart to `update_plan_tool_emits_plan_update_event`, confirming malformed payloads are rejected cleanly without mutating plan state.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, call_output); 6 external calls (default, assert!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `apply_patch_tool_executes_and_emits_patch_events`  (lines 330–470)

```
async fn apply_patch_tool_executes_and_emits_patch_events() -> anyhow::Result<()>
```

**Purpose**: Verifies that the `apply_patch` custom tool applies a patch to the filesystem, emits the expected file-change and patch lifecycle events, and returns a success summary to the model.

**Data flow**: It builds a workspace fixture path, formats a patch that adds `notes.txt`, mounts a first SSE response containing `ev_apply_patch_custom_tool_call`, mounts a second completion response, submits a turn with explicit thread settings, then waits through events until `TurnComplete` while tracking `ItemStarted`, `ItemCompleted`, `PatchApplyBegin`, and `PatchApplyEnd`. It asserts the `TurnItem::FileChange` ids and statuses, confirms patch success, extracts the custom tool output with `custom_call_output`, regex-matches the success summary, reads the created file from disk, and asserts its contents equal `Tool harness apply patch\n`.

**Call relations**: This test exercises the richest event flow in the file, proving that patch application updates both the event stream and the actual workspace before the result is serialized back to the model.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, custom_call_output); 9 external calls (default, assert!, assert_eq!, assert_regex_match, wait_for_event, format!, read_to_string, skip_if_no_network!, vec!).


##### `apply_patch_reports_parse_diagnostics`  (lines 473–558)

```
async fn apply_patch_reports_parse_diagnostics() -> anyhow::Result<()>
```

**Purpose**: Checks that an invalid patch produces diagnostic output rather than a silent failure or malformed success. It validates the error text and optional `success=false` flag for custom patch execution.

**Data flow**: It mounts a first SSE response with an `apply_patch` custom tool call whose patch lacks a valid hunk, mounts a second completion response, submits a turn with explicit thread settings, waits for `TurnComplete`, then extracts the custom tool output with `custom_call_output`. It asserts the output contains both `apply_patch verification failed` and `invalid hunk`, and if a success flag is present asserts it is false.

**Call relations**: This negative-path patch test complements the successful patch application case by focusing on parser/verification diagnostics returned through the custom tool channel.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, custom_call_output); 5 external calls (default, assert!, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/exec.rs`

`test` · `tool execution / sandbox enforcement`

This macOS-only test file drives `codex_core::exec::process_exec_tool_call` directly instead of going through the full conversation stack. The helper `skip_test` avoids running when `CODEX_SANDBOX_ENV_VAR` is already forcing seatbelt externally, because that environment would interfere with the assumptions of the test harness. The central helper `run_test_cmd` creates an `ExecParams` value with a temporary directory as both current working directory and allowed root, `ExecCapturePolicy::ShellTool`, empty environment, default sandbox permissions, and Windows sandbox fields disabled. Before executing, it queries `get_platform_sandbox(false)` and asserts that the platform sandbox resolves to `SandboxType::MacosSeatbelt`, making the tests explicitly about the real seatbelt path. Individual tests then assert concrete output behavior: `echo hello` returns stdout text and empty stderr; large line counts and large byte counts are preserved without truncation metadata; a nonexistent shell command still returns an `Ok` result rather than a sandbox error; Python `os.openpty()` works under the sandbox; and attempting to `touch` a file in the temp directory fails as an execution error because the sandbox blocks writes. The file’s key design choice is to isolate exec semantics from higher-level orchestration while still exercising the production sandbox implementation.

#### Function details

##### `skip_test`  (lines 18–25)

```
fn skip_test() -> bool
```

**Purpose**: Detects an externally forced seatbelt sandbox configuration that would make these tests unreliable and requests an early skip. It also prints a diagnostic explaining why the test was skipped.

**Data flow**: Reads the `CODEX_SANDBOX_ENV_VAR` environment variable with `std::env::var`; if it equals the string `seatbelt`, it writes a message to stderr and returns `true`. Otherwise it returns `false` without mutating any state.

**Call relations**: This helper is called at the start of each concrete test in the file. Those callers branch on its boolean result and immediately return when the environment would invalidate the intended sandbox setup.

*Call graph*: called by 6 (exit_code_0_succeeds, exit_command_not_found_is_ok, openpty_works_under_real_exec_seatbelt_path, truncates_output_bytes, truncates_output_lines, write_file_fails_as_sandbox_error); 2 external calls (eprintln!, var).


##### `run_test_cmd`  (lines 27–61)

```
async fn run_test_cmd(tmp: TempDir, command: I) -> Result<ExecToolCallOutput>
```

**Purpose**: Constructs a real `ExecParams` request for a temporary working directory and executes it through `process_exec_tool_call`. It standardizes the sandbox, cwd, capture policy, and permission profile used by the macOS exec tests.

**Data flow**: Consumes a `TempDir` and an iterable of command parts, resolves the platform sandbox with `get_platform_sandbox(false)`, asserts it is `SandboxType::MacosSeatbelt`, computes an absolute cwd from `tmp.path().abs()`, and builds `ExecParams` with collected command strings, a 1000ms expiration, `ExecCapturePolicy::ShellTool`, empty env, no explicit network override, `SandboxPermissions::UseDefault`, disabled Windows sandbox settings, and no justification or `arg0`. It then passes those params plus `PermissionProfile::read_only()`, the cwd, a one-element allowed-root slice, `&None` for session state, `false` for legacy landlock, and no stdout stream into `process_exec_tool_call`, returning its async `Result<ExecToolCallOutput>`.

**Call relations**: All success-path exec tests delegate actual command execution to this helper so they share identical runtime parameters. It is the single bridge from the test cases into the production exec implementation.

*Call graph*: calls 2 internal fn (process_exec_tool_call, read_only); called by 5 (exit_code_0_succeeds, exit_command_not_found_is_ok, openpty_works_under_real_exec_seatbelt_path, truncates_output_bytes, truncates_output_lines); 6 external calls (new, into_iter, path, assert_eq!, get_platform_sandbox, from_ref).


##### `exit_code_0_succeeds`  (lines 65–77)

```
async fn exit_code_0_succeeds()
```

**Purpose**: Confirms that a simple successful command produces expected stdout, empty stderr, and no truncation metadata. It is the baseline sanity check for the seatbelt exec path.

**Data flow**: Checks `skip_test`, creates a fresh `TempDir`, builds the command vector `['echo', 'hello']`, awaits `run_test_cmd`, unwraps the successful `ExecToolCallOutput`, and asserts `stdout.text == 'hello\n'`, `stderr.text == ''`, and `stdout.truncated_after_lines == None`.

**Call relations**: This Tokio test is invoked by the harness and immediately delegates execution to `run_test_cmd` after the environment gate from `skip_test`.

*Call graph*: calls 2 internal fn (run_test_cmd, skip_test); 3 external calls (new, assert_eq!, vec!).


##### `truncates_output_lines`  (lines 81–97)

```
async fn truncates_output_lines()
```

**Purpose**: Verifies that producing 300 newline-delimited lines does not trigger line truncation in the captured output. It checks the exact reconstructed stdout payload.

**Data flow**: After the skip gate, it creates a temp directory, runs `seq 300` through `run_test_cmd`, constructs the expected output string by joining `1\n` through `300\n`, and asserts that `output.stdout.text` matches exactly and `truncated_after_lines` remains `None`.

**Call relations**: This test follows the common pattern of `skip_test` then `run_test_cmd`, using the shared helper to isolate the assertion to output-capture behavior.

*Call graph*: calls 2 internal fn (run_test_cmd, skip_test); 3 external calls (new, assert_eq!, vec!).


##### `truncates_output_bytes`  (lines 101–114)

```
async fn truncates_output_bytes()
```

**Purpose**: Checks that large byte volume alone does not mark stdout as truncated. The command emits fifteen lines padded to roughly 1000 bytes each.

**Data flow**: It skips when necessary, creates a temp directory, runs a Bash pipeline that formats each `seq 15` line to width 1000, unwraps the result from `run_test_cmd`, asserts the captured stdout length is at least 15000 bytes, and confirms `truncated_after_lines == None`.

**Call relations**: Like the other output tests, this one is a direct harness entry that delegates execution to `run_test_cmd` and focuses only on postconditions.

*Call graph*: calls 2 internal fn (run_test_cmd, skip_test); 4 external calls (new, assert!, assert_eq!, vec!).


##### `exit_command_not_found_is_ok`  (lines 118–126)

```
async fn exit_command_not_found_is_ok()
```

**Purpose**: Ensures that a shell-level command-not-found condition is represented as a normal exec result rather than a sandbox failure. The test documents that exit code 127 is not treated as policy denial.

**Data flow**: After `skip_test`, it creates a temp directory, prepares `/bin/bash -c nonexistent_command_12345`, calls `run_test_cmd`, and simply unwraps the outer `Result`, ignoring the returned output object because success here means the exec subsystem itself did not error.

**Call relations**: This test uses `run_test_cmd` to exercise the same production path as successful commands, but asserts only that the wrapper returns `Ok` despite the inner command failing.

*Call graph*: calls 2 internal fn (run_test_cmd, skip_test); 2 external calls (new, vec!).


##### `openpty_works_under_real_exec_seatbelt_path`  (lines 129–157)

```
async fn openpty_works_under_real_exec_seatbelt_path()
```

**Purpose**: Verifies that PTY creation and loopback I/O via Python’s `os.openpty()` work inside the real seatbelt sandbox. It guards against regressions where the sandbox blocks pseudo-terminal operations.

**Data flow**: It first checks `skip_test`, then resolves `python3` with `which::which`; if absent, it prints a skip message and returns. Otherwise it creates a temp directory, builds a Python `-c` script that opens a PTY, writes `ping` to the slave, and asserts the master reads it back, runs that command via `run_test_cmd`, and asserts both stdout and stderr are empty.

**Call relations**: This harness test conditionally short-circuits when Python is unavailable, but otherwise follows the same helper-driven execution path through `run_test_cmd`.

*Call graph*: calls 2 internal fn (run_test_cmd, skip_test); 5 external calls (new, assert_eq!, eprintln!, vec!, which).


##### `write_file_fails_as_sandbox_error`  (lines 161–174)

```
async fn write_file_fails_as_sandbox_error()
```

**Purpose**: Checks that attempting to create a file in the temp working directory is rejected by the sandbox and surfaced as an execution error. It distinguishes policy denial from ordinary command failure.

**Data flow**: After the skip gate, it creates a temp directory, computes `test.txt` under that directory, builds a `/usr/bin/touch <path>` command vector, runs it through `run_test_cmd`, and asserts that the returned `Result` is `Err`.

**Call relations**: Unlike the success-path tests, this one does not use the shared helper’s output; it only relies on `skip_test` and then asserts that the production exec path rejects the write attempt.

*Call graph*: calls 1 internal fn (skip_test); 3 external calls (new, assert!, vec!).


### `core/tests/suite/shell_command.rs`

`test` · `request handling`

This test file builds mocked SSE response sequences that instruct the agent to invoke the `shell_command` tool, then inspects the tool output captured by `TestCodexHarness`. The helpers centralize two recurring concerns: constructing the exact JSON arguments sent in the mocked function call (`command`, `timeout_ms`, and optional `login`) and mounting those responses onto the harness server before a turn is submitted. Platform-specific constants widen timeouts on Windows, reflecting slower shell startup and execution there.

The core assertion logic is intentionally strict about the output envelope while tolerant about timing variance. `assert_shell_command_output` normalizes CRLF/CR line endings to `\n`, trims trailing newlines, and matches a regex requiring the standard freeform shell output format: `Exit code`, `Wall time`, and `Output:` followed by the expected payload. Individual tests then vary only the command and login mode. Pipe tests are skipped on Windows, and all tests are gated on network availability because they still drive the full mocked remote-turn path. The timeout test separately checks for exit code `124` and the human-readable timeout message rather than using the success helper. Unicode tests deliberately use model `gpt-5.2` and, on Windows, a `cmd.exe` child process to validate UTF-8/BOM-sensitive shell behavior rather than only shell builtins.

#### Function details

##### `shell_responses_with_timeout`  (lines 29–54)

```
fn shell_responses_with_timeout(
    call_id: &str,
    command: &str,
    login: Option<bool>,
    timeout_ms: i64,
) -> Vec<String>
```

**Purpose**: Builds the two-message mocked SSE exchange for a `shell_command` tool call with an explicit timeout. It serializes the exact tool arguments the model would emit and follows that with a trivial assistant completion.

**Data flow**: Takes a tool `call_id`, shell `command`, optional `login` flag, and integer `timeout_ms`. It constructs a JSON object with those fields, serializes it to a string, and returns a `Vec<String>` containing two SSE payloads: one with `response.created`, `function_call(shell_command, arguments)`, and `completed`, and a second with an assistant message `done` and completion.

**Call relations**: This is the low-level fixture generator for the file. `shell_responses` delegates to it for the default timeout case, and `mount_shell_responses_with_timeout` uses it directly when tests need a custom timeout such as the timeout and Unicode cases.

*Call graph*: called by 2 (mount_shell_responses_with_timeout, shell_responses); 3 external calls (json!, to_string, vec!).


##### `shell_responses`  (lines 56–58)

```
fn shell_responses(call_id: &str, command: &str, login: Option<bool>) -> Vec<String>
```

**Purpose**: Convenience wrapper that produces mocked `shell_command` SSE responses using the file’s platform-specific default timeout.

**Data flow**: Accepts `call_id`, `command`, and optional `login`; forwards them with `DEFAULT_SHELL_TIMEOUT_MS` to `shell_responses_with_timeout`; returns the resulting SSE sequence unchanged.

**Call relations**: Used by `mount_shell_responses` so the common success-path tests do not need to specify timeouts explicitly.

*Call graph*: calls 1 internal fn (shell_responses_with_timeout); called by 1 (mount_shell_responses).


##### `shell_command_harness_with`  (lines 60–65)

```
async fn shell_command_harness_with(
    configure: impl FnOnce(TestCodexBuilder) -> TestCodexBuilder,
) -> Result<TestCodexHarness>
```

**Purpose**: Creates a `TestCodexHarness` after applying a caller-supplied builder customization, typically selecting a model.

**Data flow**: Receives a closure from `TestCodexBuilder` to `TestCodexBuilder`. It starts from `test_codex()`, applies the closure, then asynchronously constructs and returns a `TestCodexHarness` via `with_builder`.

**Call relations**: Every test in this file begins by calling this helper to get a configured harness. It isolates harness construction so each test only specifies the model or other builder tweaks it cares about.

*Call graph*: calls 2 internal fn (with_builder, test_codex); called by 9 (multi_line_output_with_login, output_with_login, output_without_login, pipe_output_with_login, pipe_output_without_login, shell_command_times_out_with_timeout_ms, shell_command_works, unicode_output, unicode_output_with_newlines).


##### `mount_shell_responses`  (lines 67–74)

```
async fn mount_shell_responses(
    harness: &TestCodexHarness,
    call_id: &str,
    command: &str,
    login: Option<bool>,
)
```

**Purpose**: Mounts the default-timeout mocked `shell_command` SSE sequence onto the harness’s mock server.

**Data flow**: Takes a harness reference plus `call_id`, `command`, and optional `login`. It reads the server handle from `harness.server()`, generates the SSE sequence with `shell_responses`, and asynchronously registers that sequence with `mount_sse_sequence`.

**Call relations**: The normal-output tests call this immediately before `harness.submit(...)` so the next model request receives the expected tool-call stream.

*Call graph*: calls 3 internal fn (mount_sse_sequence, server, shell_responses); called by 6 (multi_line_output_with_login, output_with_login, output_without_login, pipe_output_with_login, pipe_output_without_login, shell_command_works).


##### `mount_shell_responses_with_timeout`  (lines 76–88)

```
async fn mount_shell_responses_with_timeout(
    harness: &TestCodexHarness,
    call_id: &str,
    command: &str,
    login: Option<bool>,
    timeout: Duration,
)
```

**Purpose**: Mounts a mocked `shell_command` SSE sequence using a caller-provided `Duration` timeout.

**Data flow**: Accepts a harness, tool identifiers, command text, optional login flag, and a `Duration`. It converts the duration to milliseconds with `as_millis() as i64`, builds the SSE sequence through `shell_responses_with_timeout`, and mounts it on the harness server.

**Call relations**: Used by tests that need non-default timing semantics, specifically the timeout case and the Unicode cases that allow a medium timeout.

*Call graph*: calls 3 internal fn (mount_sse_sequence, server, shell_responses_with_timeout); called by 3 (shell_command_times_out_with_timeout_ms, unicode_output, unicode_output_with_newlines); 1 external calls (as_millis).


##### `assert_shell_command_output`  (lines 90–103)

```
fn assert_shell_command_output(output: &str, expected: &str) -> Result<()>
```

**Purpose**: Validates that shell output matches the standard success envelope and contains the expected payload exactly after newline normalization.

**Data flow**: Consumes raw `output` and an `expected` body string. It normalizes CRLF and CR to LF, strips trailing newlines, formats a regex requiring exit code 0, a numeric wall time, and `Output:` followed by the expected text, then asserts the regex matches. It returns `Ok(())` on success.

**Call relations**: All success-path tests delegate their final verification here so they share identical normalization and envelope checks.

*Call graph*: called by 8 (multi_line_output_with_login, output_with_login, output_without_login, pipe_output_with_login, pipe_output_without_login, shell_command_works, unicode_output, unicode_output_with_newlines); 2 external calls (assert_regex_match, format!).


##### `shell_command_works`  (lines 106–125)

```
async fn shell_command_works() -> anyhow::Result<()>
```

**Purpose**: Verifies the basic `shell_command` path by running `echo 'hello, world'` with default login behavior and checking the formatted output.

**Data flow**: Skips when networking is unavailable, builds a harness with model `gpt-5.4`, mounts a mocked `shell_command` call for `echo 'hello, world'`, submits a natural-language prompt, reads the captured stdout for the tool call, and asserts it matches the expected success format and payload.

**Call relations**: This is the baseline happy-path test: it drives harness creation, response mounting, turn submission, and output assertion without any login or timeout variation.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 1 external calls (skip_if_no_network!).


##### `output_with_login`  (lines 128–141)

```
async fn output_with_login() -> anyhow::Result<()>
```

**Purpose**: Checks that `shell_command` succeeds when the mocked tool call explicitly requests `login: true`.

**Data flow**: After the network skip guard, it creates a `gpt-5.4` harness, mounts a response whose tool arguments include `login = Some(true)`, submits the turn, fetches stdout for that call ID, and validates the output body `hello, world` with the shared assertion helper.

**Call relations**: Invoked as an independent async test; it follows the same flow as the baseline test but exercises the explicit login-shell branch.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 1 external calls (skip_if_no_network!).


##### `output_without_login`  (lines 144–157)

```
async fn output_without_login() -> anyhow::Result<()>
```

**Purpose**: Checks that `shell_command` succeeds when the mocked tool call explicitly requests `login: false`.

**Data flow**: Builds the harness, mounts a `shell_command` response with `login = Some(false)`, submits the prompt, retrieves the tool stdout, and verifies the standard formatted output contains `hello, world`.

**Call relations**: Complements `output_with_login` by covering the explicit non-login-shell argument rather than the omitted default.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 1 external calls (skip_if_no_network!).


##### `multi_line_output_with_login`  (lines 160–179)

```
async fn multi_line_output_with_login() -> anyhow::Result<()>
```

**Purpose**: Verifies that multi-line shell output is preserved correctly when running under a login shell.

**Data flow**: Creates a harness, mounts a mocked tool call for `echo 'first line\nsecond line'` with `login = Some(true)`, submits the turn, reads stdout, and checks that the output section contains both lines in order under the standard success envelope.

**Call relations**: Uses the same helper path as the simpler echo tests, but specifically probes newline preservation in the output body.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 1 external calls (skip_if_no_network!).


##### `pipe_output_with_login`  (lines 182–202)

```
async fn pipe_output_with_login() -> anyhow::Result<()>
```

**Purpose**: Confirms that piped shell commands execute correctly with default login behavior on non-Windows platforms.

**Data flow**: Skips for missing network and on Windows, builds a `gpt-5.4` harness, mounts a tool call for `echo 'hello, world' | cat` with `login = None`, submits the turn, and asserts the resulting stdout matches the expected formatted output.

**Call relations**: This test exists because pipelines depend on shell parsing rather than direct process execution; it is only meaningful on supported non-Windows shells.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 2 external calls (skip_if_no_network!, skip_if_windows!).


##### `pipe_output_without_login`  (lines 205–219)

```
async fn pipe_output_without_login() -> anyhow::Result<()>
```

**Purpose**: Confirms that piped shell commands also work when `login: false` is explicitly requested.

**Data flow**: After skip guards, it creates the harness, mounts a `shell_command` response for `echo 'hello, world' | cat` with `Some(false)`, submits the prompt, retrieves stdout, and validates the formatted output body.

**Call relations**: Pairs with `pipe_output_with_login` to ensure the pipeline behavior is not dependent on login-shell startup.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 2 external calls (skip_if_no_network!, skip_if_windows!).


##### `shell_command_times_out_with_timeout_ms`  (lines 222–254)

```
async fn shell_command_times_out_with_timeout_ms() -> anyhow::Result<()>
```

**Purpose**: Verifies that a long-running shell command is terminated according to the provided timeout and reported with exit code 124 plus a timeout message.

**Data flow**: Skips without network, builds a harness, chooses `timeout /t 5` on Windows or `sleep 5` elsewhere, mounts a mocked tool call with a 200 ms timeout, submits the turn, reads stdout, normalizes line endings, and regex-matches the timeout-specific output format including `command timed out after ... milliseconds`.

**Call relations**: Unlike the success tests, this one bypasses `assert_shell_command_output` because it expects a nonzero exit code and a timeout diagnostic. It specifically exercises `mount_shell_responses_with_timeout`.

*Call graph*: calls 2 internal fn (mount_shell_responses_with_timeout, shell_command_harness_with); 4 external calls (from_millis, cfg!, assert_regex_match, skip_if_no_network!).


##### `unicode_output`  (lines 262–284)

```
async fn unicode_output(login: bool) -> anyhow::Result<()>
```

**Purpose**: Checks that Unicode text survives shell execution and output capture, including Windows-specific encoding-sensitive paths.

**Data flow**: Parameterized by `login: bool`, it skips without network, builds a `gpt-5.2` harness, selects a platform-specific command that prints `naïve_café`, mounts a response with `MEDIUM_TIMEOUT` and the chosen login flag, submits the turn, reads stdout, and validates the formatted output body.

**Call relations**: This test is called twice by `test_case`, once with login and once without. It uses the timeout-aware mounting helper because Unicode-sensitive shells may need more startup time.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses_with_timeout, shell_command_harness_with); 2 external calls (cfg!, skip_if_no_network!).


##### `unicode_output_with_newlines`  (lines 289–309)

```
async fn unicode_output_with_newlines(login: bool) -> anyhow::Result<()>
```

**Purpose**: Verifies that Unicode characters embedded in multi-line output are preserved and serialized in the expected freeform shell output format.

**Data flow**: Parameterized by `login: bool`, it creates a `gpt-5.2` harness, mounts a command that echoes three lines including `naïve café`, submits the turn, reads stdout, and asserts the output body matches the expected escaped newline representation under the standard success envelope.

**Call relations**: Like `unicode_output`, this is a parameterized encoding-focused test using the timeout-aware mounting helper, but it adds newline handling to the Unicode scenario.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses_with_timeout, shell_command_harness_with); 1 external calls (skip_if_no_network!).


### `core/tests/suite/unified_exec.rs`

`test` · `request handling and cross-cutting execution behavior during integration tests`

This test file is the main behavioral specification for unified exec. It builds `TestCodex` fixtures against a mock SSE server, submits turns that cause `exec_command` or `write_stdin` tool calls, and then validates both event-stream behavior (`ExecCommandBegin`, `ExecCommandOutputDelta`, `TerminalInteraction`, `ExecCommandEnd`, `PatchApplyBegin/End`, `TurnComplete`, `TurnAborted`) and the serialized tool output returned to the model. The helper layer is important: `parse_unified_exec_output` decodes the human-readable output envelope into `ParsedUnifiedExecOutput` fields such as `chunk_id`, `wall_time_seconds`, `process_id`, `exit_code`, `original_token_count`, and raw `output`; `collect_tool_outputs` extracts those records from captured request bodies; `submit_unified_exec_turn` standardizes turn submission with explicit sandbox and collaboration settings.

The tests cover intercepted `apply_patch`, workdir resolution for relative and absolute paths, startup/end event emission, PTY and non-PTY behavior, delayed output polling, background watcher completion, network-denial failures under managed proxy policy, token-limit truncation and policy clamping, TTY defaults, early exit timing, EOF and Ctrl-C session termination, Windows-specific unsupported interrupt reporting, persistence of long-running sessions across turn completion and interrupt, lagged-output draining, sandbox enforcement including glob deny rules, macOS seatbelt interaction with Python prompts, and cross-platform execution. A recurring invariant is that long-lived sessions expose `process_id` until exit, while completed commands expose `exit_code` and clear session identity.

#### Function details

##### `extract_output_text`  (lines 53–59)

```
fn extract_output_text(item: &Value) -> Option<&str>
```

**Purpose**: Pulls the textual payload out of a function-call output item regardless of whether the `output` field is stored as a plain JSON string or as an object with `content`.

**Data flow**: It reads a `serde_json::Value` item, looks up `output`, and pattern-matches on the JSON shape. It returns `Some(&str)` for either a direct string or `output.content`, otherwise `None`, without mutating any state.

**Call relations**: This is a low-level parser helper used only while harvesting tool outputs from captured request bodies in `collect_tool_outputs`, where mixed output encodings must be normalized before unified-exec parsing.

*Call graph*: called by 1 (collect_tool_outputs); 1 external calls (get).


##### `parse_unified_exec_output`  (lines 71–140)

```
fn parse_unified_exec_output(raw: &str) -> Result<ParsedUnifiedExecOutput>
```

**Purpose**: Parses the formatted unified-exec transcript envelope into structured metadata and body text. It recognizes optional truncation headers, chunk IDs, wall time, exit code, running-session IDs, original token counts, and the final `Output:` section.

**Data flow**: It takes the raw output string, trims carriage returns, lazily initializes a compiled `Regex` in a `OnceLock`, matches named capture groups, parses numeric fields into `f64`, `i32`, and `usize`, and constructs a `ParsedUnifiedExecOutput`. On malformed input or failed numeric conversion it returns an `anyhow::Error` with context.

**Call relations**: This parser underpins nearly every assertion that inspects model-visible unified-exec output. `collect_tool_outputs` uses it for request-log analysis, `wait_for_raw_unified_exec_output` uses it for event-stream inspection, and a few targeted tests call it directly when validating raw request text or ignored pruning behavior.

*Call graph*: called by 4 (collect_tool_outputs, unified_exec_prunes_exited_sessions_first, wait_for_raw_unified_exec_output, write_stdin_ctrl_c_reports_unsupported_interrupt_to_model_on_windows); 1 external calls (new).


##### `collect_tool_outputs`  (lines 142–166)

```
fn collect_tool_outputs(bodies: &[Value]) -> Result<HashMap<String, ParsedUnifiedExecOutput>>
```

**Purpose**: Scans captured response-request bodies and builds a map from tool `call_id` to parsed unified-exec output metadata.

**Data flow**: It accepts a slice of JSON request bodies, iterates through each body's `input` array, filters for items whose `type` is `function_call_output`, extracts `call_id`, obtains text via `extract_output_text`, skips empty trimmed outputs, parses the content with `parse_unified_exec_output`, and inserts the result into a `HashMap<String, ParsedUnifiedExecOutput>`. It returns the populated map or an error if required content is missing or unparsable.

**Call relations**: Most tests that validate what the model saw after a turn use this helper after `mount_sse_sequence`/request-log capture. It sits between raw HTTP request inspection and the concrete assertions about process IDs, truncation headers, exit codes, and echoed output.

*Call graph*: calls 2 internal fn (extract_output_text, parse_unified_exec_output); called by 14 (assert_write_stdin_ctrl_c_interrupts_non_tty_session, exec_command_reports_chunk_and_exit_metadata, unified_exec_can_enable_tty, unified_exec_defaults_to_pipe, unified_exec_enforces_glob_deny_read_policy, unified_exec_formats_large_output_summary, unified_exec_python_prompt_under_seatbelt, unified_exec_respects_early_exit_notifications, unified_exec_reuses_session_via_stdin, unified_exec_runs_on_all_platforms (+4 more)); 1 external calls (new).


##### `wait_for_raw_unified_exec_output`  (lines 168–187)

```
async fn wait_for_raw_unified_exec_output(
    test: &TestCodex,
    call_id: &str,
) -> Result<ParsedUnifiedExecOutput>
```

**Purpose**: Waits on the live event stream for a specific `FunctionCallOutput` item and parses its text as unified-exec output.

**Data flow**: It takes a `TestCodex` and target `call_id`, waits until `wait_for_event_match` sees `EventMsg::RawResponseItem(ResponseItem::FunctionCallOutput { ... })` for that call, extracts `text_content`, then feeds the text into `parse_unified_exec_output`. It returns the parsed structure or an error with call-specific context.

**Call relations**: This helper is used by truncation-clamping tests that need the exact raw output emitted for a single tool call rather than reconstructing it from request logs after the turn.

*Call graph*: calls 1 internal fn (parse_unified_exec_output); called by 2 (exec_command_clamps_model_requested_max_output_tokens_to_policy, write_stdin_clamps_model_requested_max_output_tokens_to_policy); 1 external calls (wait_for_event_match).


##### `submit_unified_exec_turn`  (lines 189–225)

```
async fn submit_unified_exec_turn(
    test: &TestCodex,
    prompt: &str,
    permission_profile: PermissionProfile,
) -> Result<()>
```

**Purpose**: Submits a standard user turn configured to allow unified-exec testing with explicit sandbox, permission, and collaboration settings.

**Data flow**: It reads the session model from `test.session_configured`, derives `(sandbox_policy, permission_profile)` via `turn_permission_fields`, constructs `Op::UserInput` with one `UserInput::Text`, `AskForApproval::Never`, and a `CollaborationMode` carrying the session model, then submits it through `test.codex`. It returns `Ok(())` after the async submit succeeds.

**Call relations**: This is the common setup path for most tests in the file. Individual tests mount mock SSE responses first, then call this helper to trigger the tool invocation under a consistent turn configuration.

*Call graph*: calls 1 internal fn (turn_permission_fields); called by 27 (assert_write_stdin_ctrl_c_interrupts_non_tty_session, exec_command_clamps_model_requested_max_output_tokens_to_policy, exec_command_reports_chunk_and_exit_metadata, unified_exec_can_enable_tty, unified_exec_defaults_to_pipe, unified_exec_emits_end_event_when_session_dies_via_stdin, unified_exec_emits_exec_command_begin_event, unified_exec_emits_exec_command_end_event, unified_exec_emits_one_begin_and_one_end_event, unified_exec_emits_output_delta_for_exec_command (+15 more)); 2 external calls (default, vec!).


##### `create_workspace_directory`  (lines 227–241)

```
async fn create_workspace_directory(
    test: &TestCodex,
    rel_path: impl AsRef<std::path::Path>,
) -> Result<std::path::PathBuf>
```

**Purpose**: Creates a directory inside the test workspace through the filesystem abstraction rather than direct host I/O.

**Data flow**: It joins the provided relative path onto `test.config.cwd`, converts the absolute path to `PathUri`, invokes `test.fs().create_directory` with `recursive: true`, and returns the resulting absolute `PathBuf`.

**Call relations**: Workdir-resolution tests call this helper to ensure the target directory exists before unified exec is asked to run with either a relative or absolute `workdir` override.

*Call graph*: calls 2 internal fn (fs, from_path); called by 2 (unified_exec_resolves_relative_workdir, unified_exec_respects_workdir_override); 1 external calls (as_ref).


##### `unified_exec_intercepts_apply_patch_exec_command`  (lines 244–384)

```
async fn unified_exec_intercepts_apply_patch_exec_command() -> Result<()>
```

**Purpose**: Verifies that an `exec_command` carrying an `apply_patch` heredoc is intercepted by patch-application logic instead of being executed as a normal shell command.

**Data flow**: The test enables `Feature::UnifiedExec` and the experimental unified-exec tool flag, mounts two SSE responses (tool call then assistant completion), submits a turn with local environment selections, records patch and exec events while waiting for `TurnComplete`, then reads the captured stdout and the created file from disk. It asserts patch begin/end events occurred, exec begin/end did not, the patch succeeded, stdout contains the patch summary, and `uexec_apply.txt` contains the expected text.

**Call relations**: This test bypasses `submit_unified_exec_turn` because it needs explicit `environments: Some(local_selections(cwd))`. It validates the interception path before normal exec lifecycle events would be emitted.

*Call graph*: calls 5 internal fn (mount_sse_sequence, with_builder, local_selections, test_codex, turn_permission_fields); 10 external calls (default, assert!, assert_eq!, wait_for_event, format!, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `unified_exec_emits_exec_command_begin_event`  (lines 387–448)

```
async fn unified_exec_emits_exec_command_begin_event() -> Result<()>
```

**Purpose**: Checks that a unified-exec startup command emits `ExecCommandBegin` with the expected shell command vector and cwd.

**Data flow**: It starts a mock server, builds a unified-exec-enabled test, mounts an `exec_command` followed by assistant completion, submits a turn, waits for the matching begin event, and asserts the command is `bash -lc /bin/echo hello unified exec` and the cwd equals the test workspace. It then waits for `TurnComplete`.

**Call relations**: The test uses `submit_unified_exec_turn` for setup and `assert_command` for shell-vector validation. It focuses on the first lifecycle event before completion.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_command, submit_unified_exec_turn); 9 external calls (assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_resolves_relative_workdir`  (lines 451–521)

```
async fn unified_exec_resolves_relative_workdir() -> Result<()>
```

**Purpose**: Ensures a relative `workdir` argument is resolved against the turn cwd before command execution begins.

**Data flow**: It creates a workspace subdirectory, mounts an `exec_command` with `workdir` set to the relative path string, submits the turn, waits for `ExecCommandBegin`, and asserts the event's cwd equals the absolute path of the created directory. It then waits for turn completion.

**Call relations**: This test depends on `create_workspace_directory` to provision the target directory and on `submit_unified_exec_turn` to trigger the command.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, create_workspace_directory, submit_unified_exec_turn); 10 external calls (assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, from, vec!).


##### `unified_exec_respects_workdir_override`  (lines 524–586)

```
async fn unified_exec_respects_workdir_override() -> Result<()>
```

**Purpose**: Confirms that an absolute `workdir` override is honored and reflected in the begin event.

**Data flow**: It creates a workspace directory, mounts an `exec_command` whose `workdir` is the absolute path string, submits the turn, waits for `ExecCommandBegin`, asserts the cwd matches that absolute directory, waits for `TurnComplete`, and finally checks that at least one POST request reached the mock server.

**Call relations**: Like the relative-workdir test, it uses `create_workspace_directory` and `submit_unified_exec_turn`, but validates the absolute-path branch.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, create_workspace_directory, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `unified_exec_emits_exec_command_end_event`  (lines 589–661)

```
async fn unified_exec_emits_exec_command_end_event() -> Result<()>
```

**Purpose**: Verifies that a completed unified-exec command eventually emits `ExecCommandEnd` with exit status and aggregated output.

**Data flow**: It mounts an `exec_command` that prints `END-EVENT`, then a `write_stdin` poll call, then assistant completion. After submitting the turn, it waits for the end event for the original call, asserts `exit_code == 0` and that `aggregated_output` contains the marker, then waits for turn completion.

**Call relations**: The extra poll response models the follow-up path that drains output and finalizes the session. The test uses `submit_unified_exec_turn` and event matching to observe the end event emitted for the startup call.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 10 external calls (assert!, assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_emits_output_delta_for_exec_command`  (lines 664–721)

```
async fn unified_exec_emits_output_delta_for_exec_command() -> Result<()>
```

**Purpose**: Checks that command output is surfaced through the exec lifecycle and visible in the final event payload.

**Data flow**: It mounts a simple `printf 'HELLO-UEXEC'` command, submits the turn, waits for `ExecCommandEnd`, reads `stdout` from that event, and asserts the marker text is present before waiting for `TurnComplete`.

**Call relations**: This is a lightweight lifecycle test using `submit_unified_exec_turn`; it validates output propagation without the more elaborate polling or background watcher scenarios.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 9 external calls (assert!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_full_lifecycle_with_background_end_event`  (lines 724–818)

```
async fn unified_exec_full_lifecycle_with_background_end_event() -> Result<()>
```

**Purpose**: Exercises a long-lived PTY command whose completion is observed after the turn machinery has already progressed, ensuring begin and end events are both emitted exactly once.

**Data flow**: It mounts a command that sleeps and then prints `HELLO-FULL-LIFECYCLE`, submits the turn, loops over all events collecting the matching begin event, the single matching end event, and whether `TurnComplete` has occurred, then asserts the begin event has a `process_id`, the end event has `exit_code == 0`, also carries a `process_id`, and its aggregated output contains the full transcript.

**Call relations**: Unlike simpler tests, this one manually consumes the event stream until both completion conditions are satisfied, modeling the background watcher path where `ExecCommandEnd` may arrive after turn completion.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_network_denial_emits_failed_background_end_event`  (lines 821–863)

```
async fn unified_exec_network_denial_emits_failed_background_end_event() -> Result<()>
```

**Purpose**: Validates that a long-running command blocked by managed network policy ends with a failed background `ExecCommandEnd` event rather than silently hanging.

**Data flow**: It creates a managed-network test fixture and permission profile, mounts a Python command that sleeps, attempts a proxied network connection, and then sleeps again, submits the turn, waits for the matching end event via `wait_for_unified_exec_end`, and asserts `status == Failed`, `exit_code == -1`, `aggregated_output` mentions network access denial, and a `process_id` is present. If the turn had not yet completed, it waits for `TurnComplete`.

**Call relations**: This test composes `unified_exec_network_denial_test`, `mount_unified_exec_network_denial_responses`, and `wait_for_unified_exec_end` to isolate the denial path where the background watcher terminates the stored process.

*Call graph*: calls 5 internal fn (start_mock_server, mount_unified_exec_network_denial_responses, submit_unified_exec_turn, unified_exec_network_denial_test, wait_for_unified_exec_end); 8 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!).


##### `unified_exec_short_lived_network_denial_emits_failed_end_event`  (lines 866–908)

```
async fn unified_exec_short_lived_network_denial_emits_failed_end_event() -> Result<()>
```

**Purpose**: Checks the same managed-network denial behavior for a shorter-lived command that fails within the initial yield window.

**Data flow**: It builds the managed-network fixture, mounts a Python command that immediately attempts the denied connection, submits the turn, waits for the end event, and asserts failed status, `exit_code == -1`, denial text in aggregated output, and a present `process_id`. It waits for `TurnComplete` if necessary.

**Call relations**: This shares the same helper stack as the background-denial test but covers the branch where the denial happens quickly rather than after a longer-running session.

*Call graph*: calls 5 internal fn (start_mock_server, mount_unified_exec_network_denial_responses, submit_unified_exec_turn, unified_exec_network_denial_test, wait_for_unified_exec_end); 8 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!).


##### `unified_exec_network_denial_test`  (lines 910–960)

```
async fn unified_exec_network_denial_test(
    server: &wiremock::MockServer,
) -> Result<(TestCodex, PermissionProfile)>
```

**Purpose**: Constructs a `TestCodex` configured with a workspace-write permission profile and managed limited-network proxy settings suitable for network-denial tests.

**Data flow**: It creates a temporary home directory, writes a `config.toml` enabling workspace permissions with limited network mode, builds a matching runtime `PermissionProfile` via `workspace_write_with`, configures the test builder with unified exec enabled, managed network requirements, approval policy `Never`, and the permission profile, then builds the test against the provided mock server. It asserts network config is present and returns the test plus a clone of the permission profile.

**Call relations**: Both network-denial tests call this helper to centralize the special home/config setup needed for managed proxy enforcement.

*Call graph*: calls 2 internal fn (test_codex, workspace_write_with); called by 2 (unified_exec_network_denial_emits_failed_background_end_event, unified_exec_short_lived_network_denial_emits_failed_end_event); 5 external calls (new, new, assert!, managed_network_requirements_loader, write).


##### `mount_unified_exec_network_denial_responses`  (lines 962–980)

```
async fn mount_unified_exec_network_denial_responses(
    server: &wiremock::MockServer,
    call_id: &str,
    args: &Value,
) -> Result<core_test_support::responses::ResponseMock>
```

**Purpose**: Mounts the standard two-response SSE sequence used by the network-denial tests: one tool call and one assistant completion.

**Data flow**: It formats the provided `call_id` and JSON args into an `exec_command` function-call event, wraps it in an SSE response followed by a second assistant-message response, mounts the sequence on the mock server, and returns the resulting `ResponseMock`.

**Call relations**: The network-denial tests use this helper after creating the managed-network fixture so they can later inspect request counts while waiting for the end event.

*Call graph*: calls 1 internal fn (mount_sse_sequence); called by 2 (unified_exec_network_denial_emits_failed_background_end_event, unified_exec_short_lived_network_denial_emits_failed_end_event); 1 external calls (vec!).


##### `wait_for_unified_exec_end`  (lines 982–1018)

```
async fn wait_for_unified_exec_end(
    test: &TestCodex,
    call_id: &str,
    response_mock: &core_test_support::responses::ResponseMock,
) -> (codex_protocol::protocol::ExecCommandEndEvent, bool)
```

**Purpose**: Consumes the event stream until the specified unified-exec end event arrives or a hard deadline expires, while recording diagnostic context.

**Data flow**: It takes a `TestCodex`, target `call_id`, and `ResponseMock`, computes a 15-second deadline, repeatedly awaits `test.codex.next_event()` under a shrinking timeout, records stringified events, tracks whether `TurnComplete` has been seen, and breaks when it encounters `EventMsg::ExecCommandEnd` for the target call. On timeout it panics with observed events and response-request count. It returns the end event plus a boolean indicating whether turn completion was already observed.

**Call relations**: This helper is specialized for the network-denial tests, where event ordering can vary and richer timeout diagnostics are needed.

*Call graph*: called by 2 (unified_exec_network_denial_emits_failed_background_end_event, unified_exec_short_lived_network_denial_emits_failed_end_event); 7 external calls (new, format!, matches!, panic!, from_secs, now, timeout).


##### `unified_exec_emits_terminal_interaction_for_write_stdin`  (lines 1021–1103)

```
async fn unified_exec_emits_terminal_interaction_for_write_stdin() -> Result<()>
```

**Purpose**: Ensures that a `write_stdin` call against a live TTY session emits a `TerminalInteraction` event tied back to the original startup call.

**Data flow**: It mounts an interactive `/bin/bash -i` startup command and a subsequent `write_stdin` sending `echo WSTDIN-MARK\n`, submits the turn, loops through events until `TurnComplete`, captures the matching `TerminalInteraction`, and asserts its `process_id` is `1000` and its `stdin` equals the chars sent in the write call.

**Call relations**: This test uses `submit_unified_exec_turn` and event-stream scanning to validate the side-channel event emitted for interactive stdin writes.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 8 external calls (assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_terminal_interaction_captures_delayed_output`  (lines 1106–1284)

```
async fn unified_exec_terminal_interaction_captures_delayed_output() -> Result<()>
```

**Purpose**: Tests repeated polling of a live TTY session where output appears only after delays, ensuring terminal interactions, streamed deltas, and final aggregated output all capture the delayed markers.

**Data flow**: It mounts one startup command that emits `MARKER1` and `MARKER2` after sleeps, followed by three `write_stdin` poll calls with different `yield_time_ms` values, then assistant completion. After submitting the turn, it consumes all events, collecting the begin event, concatenated `ExecCommandOutputDelta` chunks, all `TerminalInteraction` events, the end event, and turn completion. It asserts there are exactly three terminal interactions with stdin `x`, both markers appear in streamed deltas and aggregated output, and begin/end events carry a `process_id` with successful exit.

**Call relations**: This is the most complete interactive polling test in the file, combining startup, repeated stdin polling, delta streaming, and final session closure.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 12 external calls (from_utf8_lossy, new, new, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows! (+2 more)).


##### `unified_exec_emits_one_begin_and_one_end_event`  (lines 1287–1407)

```
async fn unified_exec_emits_one_begin_and_one_end_event() -> Result<()>
```

**Purpose**: Checks that a startup command followed by an empty poll produces exactly one begin event and one end event, and that empty completed polls do not emit terminal-interaction noise.

**Data flow**: It mounts a short `sleep 0.1` startup command and a `write_stdin` poll with empty `chars`, submits the turn, loops until turn completion and at least one end event, counts matching begin/end/terminal-interaction events, and asserts one begin, one end, zero terminal interactions, startup source `UnifiedExecStartup`, no `interaction_input`, and the expected shell command vector.

**Call relations**: This test uses `assert_command` and explicit event counting to guard against duplicate lifecycle events caused by polling.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_command, submit_unified_exec_turn); 9 external calls (new, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `exec_command_reports_chunk_and_exit_metadata`  (lines 1410–1502)

```
async fn exec_command_reports_chunk_and_exit_metadata() -> Result<()>
```

**Purpose**: Verifies that completed `exec_command` outputs include chunk IDs, wall time, exit code, truncation metadata, and no lingering process ID.

**Data flow**: It mounts a command that emits enough tokens to exceed `max_output_tokens: 6`, submits the turn, waits for completion, parses captured request bodies with `collect_tool_outputs`, and asserts the selected output has a 6-character hexadecimal `chunk_id`, non-negative wall time, `process_id == None`, `exit_code == Some(0)`, truncation text in `output`, and `original_token_count > 6`.

**Call relations**: This test is one of the main consumers of `collect_tool_outputs`, validating the serialized metadata contract rather than event-stream behavior.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `exec_command_clamps_model_requested_max_output_tokens_to_policy`  (lines 1505–1566)

```
async fn exec_command_clamps_model_requested_max_output_tokens_to_policy() -> Result<()>
```

**Purpose**: Ensures a model-requested `max_output_tokens` larger than policy is clamped to the configured tool-output token limit for `exec_command`.

**Data flow**: It configures `tool_output_token_limit = Some(50)`, mounts a command that prints 999 numbered lines while requesting `max_output_tokens: 70_000`, submits the turn, waits for the raw function-call output for the startup call, and asserts `original_token_count == Some(8991)` plus a regex match on the exact truncated output shape. It then waits for turn completion.

**Call relations**: This test uses `wait_for_raw_unified_exec_output` because it needs the exact formatted output envelope, including truncation headers and line counts.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn, wait_for_raw_unified_exec_output); 9 external calls (assert_eq!, assert_regex_match, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `write_stdin_clamps_model_requested_max_output_tokens_to_policy`  (lines 1569–1657)

```
async fn write_stdin_clamps_model_requested_max_output_tokens_to_policy() -> Result<()>
```

**Purpose**: Checks the same policy clamp for `write_stdin` output on a live TTY session.

**Data flow**: It starts an interactive command that prints `READY`, waits for input, then emits 999 numbered lines; mounts a `write_stdin` call sending `go\n` with `max_output_tokens: 70_000`; submits the turn; parses the startup output to confirm a running `process_id`; parses the stdin output to assert `original_token_count == Some(9492)` and a regex match on the truncated body including the echoed `go`; then waits for completion.

**Call relations**: This complements the previous test by covering the interactive-session branch where truncation happens on follow-up polling rather than initial startup.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn, wait_for_raw_unified_exec_output); 10 external calls (assert!, assert_eq!, assert_regex_match, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_defaults_to_pipe`  (lines 1660–1728)

```
async fn unified_exec_defaults_to_pipe() -> Result<()>
```

**Purpose**: Verifies that unified exec uses pipe mode by default rather than allocating a TTY.

**Data flow**: It mounts a Python command that prints `sys.stdin.isatty()`, submits the turn, waits for completion, parses request bodies with `collect_tool_outputs`, normalizes line endings, and asserts the output contains `False` and `exit_code == Some(0)`.

**Call relations**: This test contrasts with the explicit TTY test and validates the default backend mode visible to the child process.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_can_enable_tty`  (lines 1731–1796)

```
async fn unified_exec_can_enable_tty() -> Result<()>
```

**Purpose**: Checks that setting `tty: true` causes the child process to observe a TTY-backed stdin.

**Data flow**: It mounts the same Python `isatty()` command but with `tty: true`, submits the turn, waits for completion, parses outputs, normalizes line endings, and asserts the output contains `True`, `exit_code == Some(0)`, and no `process_id` because the process already exited.

**Call relations**: This is the positive counterpart to `unified_exec_defaults_to_pipe`, using the same output-parsing path to prove the TTY flag changes process behavior.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_respects_early_exit_notifications`  (lines 1799–1881)

```
async fn unified_exec_respects_early_exit_notifications() -> Result<()>
```

**Purpose**: Ensures a short-lived process that exits before the requested yield deadline is reported as completed promptly rather than being treated as still running.

**Data flow**: It mounts `sleep 0.05` with a very large `yield_time_ms`, submits the turn, waits for completion, parses outputs from request logs, and asserts there is no `process_id`, `exit_code == Some(0)`, `wall_time_seconds < 0.75`, and empty output.

**Call relations**: This test validates the early-exit fast path in unified exec's timing logic using `collect_tool_outputs` rather than event sequencing.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `write_stdin_returns_exit_metadata_and_clears_session`  (lines 1884–2036)

```
async fn write_stdin_returns_exit_metadata_and_clears_session() -> Result<()>
```

**Purpose**: Checks that a live session keeps returning `process_id` while running, then returns `exit_code` and clears the session once EOF is sent.

**Data flow**: It mounts `/bin/cat` startup, a write sending `hello unified exec\n`, and a final write sending Ctrl-D. After submitting the turn and waiting for completion, it parses all outputs, asserts the startup output has a nontrivial `process_id` and no exit code, the echo output contains the text and reuses the same `process_id` with no exit code, and the EOF output omits `process_id`, includes `exit_code == 0`, and has a hexadecimal `chunk_id`.

**Call relations**: This test is the canonical session-lifecycle check for `write_stdin`, proving both reuse and cleanup semantics through model-visible output.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `write_stdin_ctrl_c_interrupts_non_tty_session`  (lines 2039–2049)

```
async fn write_stdin_ctrl_c_interrupts_non_tty_session() -> Result<()>
```

**Purpose**: Runs the shared non-TTY interrupt assertion against a shell command that traps SIGINT and exits with a custom code after printing a marker.

**Data flow**: It delegates to `assert_write_stdin_ctrl_c_interrupts_non_tty_session` with a trap-based command, expected exit code `42`, and expected interrupt output `INT-TRAP` after skipping unsupported Wine environments.

**Call relations**: This is a thin scenario wrapper around the shared interrupt helper, selecting the trapped-SIGINT branch.

*Call graph*: calls 1 internal fn (assert_write_stdin_ctrl_c_interrupts_non_tty_session); 1 external calls (skip_if_wine_exec!).


##### `write_stdin_ctrl_c_default_interrupt_reports_130_for_non_tty_session`  (lines 2052–2062)

```
async fn write_stdin_ctrl_c_default_interrupt_reports_130_for_non_tty_session() -> Result<()>
```

**Purpose**: Runs the shared non-TTY interrupt assertion against a command with default SIGINT handling, expecting shell-style exit code 130.

**Data flow**: It delegates to `assert_write_stdin_ctrl_c_interrupts_non_tty_session` with a simple `sleep` command, expected exit code `130`, and no expected interrupt-output marker.

**Call relations**: This is the second wrapper around the shared interrupt helper, covering default signal semantics instead of a trap handler.

*Call graph*: calls 1 internal fn (assert_write_stdin_ctrl_c_interrupts_non_tty_session); 1 external calls (skip_if_wine_exec!).


##### `assert_write_stdin_ctrl_c_interrupts_non_tty_session`  (lines 2064–2184)

```
async fn assert_write_stdin_ctrl_c_interrupts_non_tty_session(
    test_name: &str,
    command: &str,
    expected_exit_code: i32,
    expected_interrupt_output: Option<&str>,
) -> Result<()>
```

**Purpose**: Implements the common non-TTY Ctrl-C test flow: start a long-lived session, send ETX, and verify the process exits with the expected metadata and optional drained output.

**Data flow**: It builds a unified-exec-enabled test, mounts startup and interrupt tool calls plus assistant completion, submits the turn, waits for `TurnComplete`, parses outputs from request logs, and asserts the startup output reports running session `1000` with `READY`, while the interrupt output clears `process_id`, reports the expected exit code, and optionally contains expected signal-handler output.

**Call relations**: Both Unix interrupt tests call this helper to avoid duplicating setup and assertions. It centralizes the non-TTY interrupt contract for `write_stdin`.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); called by 2 (write_stdin_ctrl_c_default_interrupt_reports_130_for_non_tty_session, write_stdin_ctrl_c_interrupts_non_tty_session); 9 external calls (assert!, assert_eq!, wait_for_event, format!, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `write_stdin_ctrl_c_reports_unsupported_interrupt_to_model_on_windows`  (lines 2188–2284)

```
async fn write_stdin_ctrl_c_reports_unsupported_interrupt_to_model_on_windows() -> Result<()>
```

**Purpose**: Validates the Windows-specific behavior where Ctrl-C interruption is unsupported by the backend and the failure is surfaced to the model as tool output text.

**Data flow**: It mounts a `cmd` startup command that prints `READY` and sleeps, then a `write_stdin` call sending ETX, submits the turn, waits for completion, parses the startup output with `parse_unified_exec_output` to confirm a running session `1000`, then inspects the raw interrupt output text from the request log and asserts it contains both `write_stdin failed` and the unsupported-interrupt explanation.

**Call relations**: This test bypasses `collect_tool_outputs` for the interrupt call because the failure text is not expected to match the normal unified-exec envelope.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, parse_unified_exec_output, submit_unified_exec_turn); 7 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `unified_exec_emits_end_event_when_session_dies_via_stdin`  (lines 2287–2378)

```
async fn unified_exec_emits_end_event_when_session_dies_via_stdin() -> Result<()>
```

**Purpose**: Ensures that when a session exits because of stdin input, the emitted `ExecCommandEnd` event is attributed to the original startup `exec_command` call ID.

**Data flow**: It mounts `/bin/cat` startup, an echo write, an EOF write, and assistant completion; submits the turn; waits specifically for `ExecCommandEnd` whose `call_id` matches the startup call; asserts `exit_code == 0`; then waits for turn completion.

**Call relations**: This test complements the model-visible metadata checks by asserting the event-stream attribution rule for session termination via `write_stdin`.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 9 external calls (assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_keeps_long_running_session_after_turn_end`  (lines 2381–2488)

```
async fn unified_exec_keeps_long_running_session_after_turn_end() -> Result<()>
```

**Purpose**: Verifies that a long-running unified-exec process survives normal turn completion and is only terminated during shutdown.

**Data flow**: It builds a test, creates a temp pid file path, mounts an `exec_command` that writes its PID then `exec sleep 3000`, submits a turn with local environment selections, waits for `ExecCommandBegin`, waits for the pid file to appear, waits for `TurnComplete`, asserts the process is still alive, submits `Op::Shutdown`, waits for `ShutdownComplete`, and finally waits for the process to exit.

**Call relations**: This test manually constructs the turn submission instead of using `submit_unified_exec_turn` so it can include local environment selections and then drive explicit shutdown behavior.

*Call graph*: calls 7 internal fn (wait_for_pid_file, wait_for_process_exit, mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields); 11 external calls (default, assert!, wait_for_event, wait_for_event_match, format!, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, tempdir (+1 more)).


##### `unified_exec_interrupt_preserves_long_running_session`  (lines 2491–2586)

```
async fn unified_exec_interrupt_preserves_long_running_session() -> Result<()>
```

**Purpose**: Checks that interrupting the active turn does not kill a background unified-exec process that was started during that turn.

**Data flow**: It mounts a long-running command that writes its PID and sleeps, submits the turn, waits for startup and pid-file creation, sends `Op::Interrupt`, waits for `TurnAborted`, asserts the process is still alive, then submits `Op::CleanBackgroundTerminals` and waits for process exit.

**Call relations**: This is the interrupt analogue of the previous shutdown test, proving that turn interruption and background-terminal cleanup are separate lifecycle controls.

*Call graph*: calls 7 internal fn (wait_for_pid_file, wait_for_process_exit, mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields); 11 external calls (default, assert!, wait_for_event, wait_for_event_match, format!, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, tempdir (+1 more)).


##### `unified_exec_reuses_session_via_stdin`  (lines 2589–2686)

```
async fn unified_exec_reuses_session_via_stdin() -> Result<()>
```

**Purpose**: Confirms that `write_stdin` targets and reuses the session created by an earlier `exec_command` call.

**Data flow**: It mounts `/bin/cat` startup and a follow-up stdin write, submits the turn, waits for completion, parses outputs from request logs, and asserts the startup output contains a non-empty `process_id` with empty output while the second output reuses the same `process_id` and contains the echoed text.

**Call relations**: This is the simplest positive session-reuse test, using `collect_tool_outputs` rather than event-stream assertions.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_streams_after_lagged_output`  (lines 2689–2804)

```
async fn unified_exec_streams_after_lagged_output() -> Result<()>
```

**Purpose**: Tests that after an initial response truncates or lags behind a large PTY burst, a later poll still drains and returns subsequent tail output.

**Data flow**: It mounts a Python script that emits a large binary-ish burst, sleeps, then prints `TAIL-MARKER` repeatedly, followed by a `write_stdin` poll with empty chars and long yield. After submitting the turn and waiting for completion with an extended timeout, it parses outputs and asserts the startup output returned a session ID and the poll output contains `TAIL-MARKER`.

**Call relations**: This test targets a worst-case lag/drain path and therefore uses `wait_for_event_with_timeout` with the file-level `UNIFIED_EXEC_LAGGED_OUTPUT_TIMEOUT` constant.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 8 external calls (assert!, wait_for_event_with_timeout, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_timeout_and_followup_poll`  (lines 2807–2893)

```
async fn unified_exec_timeout_and_followup_poll() -> Result<()>
```

**Purpose**: Verifies that when the initial yield window expires before output appears, the command remains live and a later empty poll retrieves the delayed output.

**Data flow**: It mounts `sleep 0.5; echo ready` with `yield_time_ms: 10`, then a `write_stdin` poll with empty chars and longer yield, submits the turn, consumes events until `TurnComplete`, parses outputs, and asserts the first output has a `process_id` and empty body while the poll output contains `ready`.

**Call relations**: This is the simpler timeout-followed-by-poll scenario, distinct from the lagged-output truncation stress case.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 8 external calls (assert!, matches!, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_formats_large_output_summary`  (lines 2898–2971)

```
async fn unified_exec_formats_large_output_summary() -> Result<()>
```

**Purpose**: Checks the formatting of truncated large-output summaries, including warning header, total line count, preserved head/tail, and omitted-token marker.

**Data flow**: It mounts a Python script that prints `token token` 5000 times with `max_output_tokens: 100`, submits the turn, waits for completion, parses outputs, normalizes line endings, regex-matches the expected summary shape, and asserts `original_token_count` is present and positive.

**Call relations**: This test focuses on the textual summary format produced for oversized outputs and uses `collect_tool_outputs` to inspect the model-visible result.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_regex_match, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_runs_under_sandbox`  (lines 2974–3060)

```
async fn unified_exec_runs_under_sandbox() -> Result<()>
```

**Purpose**: Ensures unified exec still runs successfully when the turn uses a read-only permission profile and sandbox policy.

**Data flow**: It builds a test, mounts a simple `echo 'hello'` command, submits a turn manually with `PermissionProfile::read_only()` and local environment selections, waits for completion, parses outputs from request logs, and regex-matches `hello` in the command output.

**Call relations**: This test manually constructs the turn to exercise sandboxed execution rather than the disabled-permissions default used by many other tests.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, collect_tool_outputs, read_only); 9 external calls (default, assert!, assert_regex_match, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `unified_exec_enforces_glob_deny_read_policy`  (lines 3064–3201)

```
async fn unified_exec_enforces_glob_deny_read_policy() -> Result<()>
```

**Purpose**: Verifies that a glob-based filesystem deny rule blocks reads of matching files while still allowing reads of non-matching files in the same workspace.

**Data flow**: It configures a permission profile whose filesystem sandbox denies `**/*.env`, creates fixture files `secret.env` and `notes.txt`, mounts a command that cats both and exits with the denied read's status, submits a read-only turn with local environment selections, waits for completion, parses outputs, and asserts a non-zero exit code, presence of allowed file contents, absence of the secret, and denial wording such as permission denied or operation not permitted.

**Call relations**: This test extends the sandbox coverage beyond simple read-only mode by validating glob deny enforcement through unified exec output.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, collect_tool_outputs, read_only); 10 external calls (default, assert!, wait_for_event, format!, create_dir_all, write, json!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `unified_exec_python_prompt_under_seatbelt`  (lines 3205–3343)

```
async fn unified_exec_python_prompt_under_seatbelt() -> Result<()>
```

**Purpose**: On macOS, checks that an interactive Python process started under seatbelt sandboxing still presents a prompt and can be exited cleanly via stdin.

**Data flow**: It locates `python` or `python3`, builds a unified-exec-enabled test, mounts startup `python -i` and follow-up `write_stdin` sending `exit()\n`, submits a read-only turn with local environment selections, waits for completion, parses outputs, and asserts the startup output contains `>>>`, reports session `1000`, and the exit output reports `exit_code == Some(0)`.

**Call relations**: This platform-specific test combines sandboxing, TTY interaction, and session reuse to guard against seatbelt regressions.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, collect_tool_outputs, read_only); 9 external calls (default, assert!, assert_eq!, wait_for_event, eprintln!, json!, skip_if_no_network!, vec!, which).


##### `unified_exec_runs_on_all_platforms`  (lines 3346–3404)

```
async fn unified_exec_runs_on_all_platforms() -> Result<()>
```

**Purpose**: Provides a minimal cross-platform smoke test that unified exec can run a simple echo command and return its output.

**Data flow**: It mounts an `exec_command` for `echo 'hello crossplat'`, submits a turn, waits for completion, parses outputs from request logs, and regex-matches the returned output with a deliberately weak pattern to tolerate Windows control characters.

**Call relations**: This is the broadest portability smoke test in the file, intentionally avoiding stricter platform-specific assumptions.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 8 external calls (assert!, assert_regex_match, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_wine_exec!, vec!).


##### `unified_exec_prunes_exited_sessions_first`  (lines 3408–3552)

```
async fn unified_exec_prunes_exited_sessions_first() -> Result<()>
```

**Purpose**: Ignored regression test that fills the session cache to verify exited sessions are pruned before live ones, preserving active sessions and rejecting writes to pruned IDs.

**Data flow**: It mounts a large single SSE response containing one persistent `/bin/cat` session, one short sleeper intended for pruning, many filler `exec_command` calls to exhaust the session budget, a write to the kept session, and a probe write to the pruned session. After submitting the turn and waiting for completion, it parses request outputs directly, asserting the kept and prune-target sessions initially had `process_id`s, the kept write still echoes input, and the probe output reports an unknown process ID.

**Call relations**: Although ignored, this test is the only one that stresses session-cache eviction order and directly uses `parse_unified_exec_output` on individual request entries.

*Call graph*: calls 8 internal fn (ev_completed, ev_function_call, mount_sse_sequence, sse, start_mock_server, test_codex, parse_unified_exec_output, submit_unified_exec_turn); 9 external calls (assert!, wait_for_event, format!, json!, to_string, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `assert_command`  (lines 3554–3566)

```
fn assert_command(command: &[String], expected_args: &str, expected_cmd: &str)
```

**Purpose**: Asserts that a shell command vector matches the expected `bash` executable, shell flag, and command string.

**Data flow**: It reads a `&[String]`, checks length `== 3`, validates the first element is a plausible bash path, and compares the second and third elements to the expected args and command. It returns unit and only fails via assertions.

**Call relations**: Begin-event tests call this helper to avoid duplicating shell-vector assertions while tolerating different absolute bash locations.

*Call graph*: called by 2 (unified_exec_emits_exec_command_begin_event, unified_exec_emits_one_begin_and_one_end_event); 2 external calls (assert!, assert_eq!).


### `core/tests/suite/apply_patch_cli.rs`

`test` · `tool execution, sandbox enforcement, and diff emission during integration tests`

This file is the main regression suite for patch application. It defines harness builders (`apply_patch_harness`, `apply_patch_harness_with`), submission helpers that send `Op::UserInput` with explicit sandbox and approval settings, and permission-profile constructors for restricted workspace, read-only roots, and denied-read paths. It also abstracts model-side responses with `mount_apply_patch`, `mount_apply_patch_model_output`, and `apply_patch_responses`, which synthesize a two-step SSE sequence: first a custom-tool or shell-command patch invocation, then a final assistant message.

The tests cover successful patch operations (add, update, delete, move, overwrite, multiple hunks, EOF anchors, insert-only hunks, newline normalization), failure modes (invalid headers, missing context, missing files, empty patches, deleting directories, partial verification rollback), and path-safety rules (rejecting traversal outside the workspace, blocking symlink escapes, preserving hard-link semantics). Several tests focus on eventing: pure renames should not emit `TurnDiff`, successful patch application should emit unified diffs, shell heredoc invocation should produce `PatchApplyBegin`/`PatchApplyEnd`, streaming custom-tool deltas should emit incremental `PatchApplyUpdated` snapshots, and aggregated diffs should combine multiple successful tool calls but clear to an empty string after an inexact delta such as overwriting binary content. Multi-environment coverage verifies diff paths are prefixed `local/` and `remote/`. The suite also includes a dynamic responder that feeds shell-command output into a later `apply_patch` call, proving tool chaining works end-to-end.

#### Function details

##### `apply_patch_harness`  (lines 67–69)

```
async fn apply_patch_harness() -> Result<TestCodexHarness>
```

**Purpose**: Builds the default test harness used by most apply-patch tests. It is a convenience wrapper around the configurable harness constructor.

**Data flow**: Takes no arguments, calls `apply_patch_harness_with` with the identity builder transform, awaits the resulting `TestCodexHarness`, and returns it.

**Call relations**: Most top-level tests call this helper during setup when they do not need custom model or workspace configuration.

*Call graph*: calls 1 internal fn (apply_patch_harness_with); called by 28 (apply_patch_aggregates_diff_across_multiple_tool_calls, apply_patch_aggregates_diff_preserves_success_after_failure, apply_patch_change_context_disambiguates_target, apply_patch_cli_add_overwrites_existing_file, apply_patch_cli_delete_directory_reports_verification_error, apply_patch_cli_delete_missing_file_reports_error, apply_patch_cli_end_of_file_anchor, apply_patch_cli_insert_only_hunk_modifies_file, apply_patch_cli_missing_second_chunk_context_rejected, apply_patch_cli_move_overwrites_existing_destination (+15 more)).


##### `apply_patch_harness_with`  (lines 71–78)

```
async fn apply_patch_harness_with(
    configure: impl FnOnce(TestCodexBuilder) -> TestCodexBuilder,
) -> Result<TestCodexHarness>
```

**Purpose**: Constructs a `TestCodexHarness` with caller-supplied builder customization while keeping the async future small. It centralizes remote-environment harness startup for this suite.

**Data flow**: Accepts a closure from `TestCodexBuilder` to `TestCodexBuilder`, applies it to `test_codex()`, then boxes and awaits `TestCodexHarness::with_remote_env_builder(builder)`, returning the harness.

**Call relations**: Used by the default harness wrapper and by tests that need custom models, features, cwd, or workspace setup before exercising apply-patch behavior.

*Call graph*: calls 2 internal fn (with_remote_env_builder, test_codex); called by 11 (apply_patch_clears_aggregated_diff_after_inexact_delta, apply_patch_cli_can_use_shell_command_output_as_patch_input, apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace, apply_patch_cli_multiple_operations_integration, apply_patch_cli_preserves_existing_hard_link_outside_workspace, apply_patch_custom_tool_streaming_emits_updated_changes, apply_patch_harness, apply_patch_shell_command_failure_propagates_error_and_skips_diff, apply_patch_shell_command_heredoc_with_cd_emits_turn_diff, apply_patch_shell_command_heredoc_with_cd_updates_relative_workdir (+1 more)); 1 external calls (pin).


##### `submit_without_wait`  (lines 80–88)

```
async fn submit_without_wait(harness: &TestCodexHarness, prompt: &str) -> Result<()>
```

**Purpose**: Submits a user turn configured for danger-full-access execution without waiting for completion. Tests use it when they want to observe intermediate events such as diffs or patch lifecycle notifications.

**Data flow**: Takes a harness and prompt string, forwards them to `submit_without_wait_with_turn_permissions` with `SandboxPolicy::DangerFullAccess` and no explicit permission profile, and returns the async result.

**Call relations**: Event-focused tests call this helper so they can immediately start waiting on `EventMsg` streams instead of using the harness’s higher-level submit-and-wait helpers.

*Call graph*: calls 1 internal fn (submit_without_wait_with_turn_permissions); called by 9 (apply_patch_aggregates_diff_across_multiple_tool_calls, apply_patch_aggregates_diff_preserves_success_after_failure, apply_patch_clears_aggregated_diff_after_inexact_delta, apply_patch_cli_move_without_content_change_has_no_turn_diff, apply_patch_custom_tool_streaming_emits_updated_changes, apply_patch_emits_turn_diff_event_with_unified_diff, apply_patch_shell_command_failure_propagates_error_and_skips_diff, apply_patch_shell_command_heredoc_with_cd_emits_turn_diff, apply_patch_turn_diff_paths_stay_repo_relative_when_session_cwd_is_nested).


##### `submit_without_wait_with_turn_permissions`  (lines 90–124)

```
async fn submit_without_wait_with_turn_permissions(
    harness: &TestCodexHarness,
    prompt: &str,
    sandbox_policy: SandboxPolicy,
    permission_profile: Option<PermissionProfile>,
) -> Result<
```

**Purpose**: Submits a raw `Op::UserInput` with explicit sandbox policy and optional permission profile, but does not wait for turn completion. It mirrors the harness submit path while exposing per-turn permission controls.

**Data flow**: Reads the underlying `TestCodex` from the harness, clones the session model, and submits `Op::UserInput` containing one text item plus `ThreadSettingsOverrides` that set `approval_policy: Never`, the provided `sandbox_policy`, optional `permission_profile`, and a default collaboration mode using the session model. It returns `Ok(())` once the submit future resolves.

**Call relations**: Called by `submit_without_wait`; tests that need custom permission profiles use the harness’s other helpers directly, while this function is the low-level path for event-observation scenarios.

*Call graph*: calls 1 internal fn (test); called by 1 (submit_without_wait); 2 external calls (default, vec!).


##### `restrictive_workspace_write_profile`  (lines 126–133)

```
fn restrictive_workspace_write_profile() -> PermissionProfile
```

**Purpose**: Builds a workspace-write permission profile that excludes temp directories and network access. It is used to make path-traversal attempts fail under approval settings.

**Data flow**: Calls `PermissionProfile::workspace_write_with` with no extra writable roots, `NetworkSandboxPolicy::Restricted`, and both temp exclusions enabled, returning the resulting profile.

**Call relations**: Traversal-rejection tests use this helper when submitting turns so writes outside the project are blocked by policy rather than silently allowed.

*Call graph*: calls 1 internal fn (workspace_write_with); called by 2 (apply_patch_cli_rejects_move_path_traversal_outside_workspace, apply_patch_cli_rejects_path_traversal_outside_workspace).


##### `workspace_write_with_read_only_root`  (lines 135–154)

```
fn workspace_write_with_read_only_root(read_only_root: AbsolutePathBuf) -> PermissionProfile
```

**Purpose**: Creates a permission profile that allows writes under project roots but only read access under a specified external root. It is used to test symlink and hard-link interactions with outside paths.

**Data flow**: Builds a restricted `FileSystemSandboxPolicy` with two entries: read access to the supplied absolute root path and write access to `project_roots(None)`. It then converts that filesystem policy plus restricted network policy into a `PermissionProfile` and returns it.

**Call relations**: Symlink-escape and hard-link-preservation tests use this profile to model an outside directory that should not be writable directly.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); called by 2 (apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace, apply_patch_cli_preserves_existing_hard_link_outside_workspace); 1 external calls (vec!).


##### `workspace_write_with_unreadable_path`  (lines 157–176)

```
fn workspace_write_with_unreadable_path(unreadable_path: AbsolutePathBuf) -> PermissionProfile
```

**Purpose**: Creates a Unix-only permission profile that explicitly denies reads to one path while allowing writes in project roots. It is used to ensure intercepted verification honors local sandbox restrictions.

**Data flow**: Builds a restricted filesystem policy with a `Deny` entry for the supplied absolute path and a write entry for project roots, then converts it with restricted network policy into a `PermissionProfile`.

**Call relations**: Only the intercepted verification test uses this helper to force apply-patch verification to fail when following a symlink to a denied target.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); called by 1 (intercepted_apply_patch_verification_uses_local_sandbox); 1 external calls (vec!).


##### `create_file_symlink`  (lines 189–194)

```
fn create_file_symlink(_source: &std::path::Path, _link: &std::path::Path) -> std::io::Result<()>
```

**Purpose**: Creates a file symlink in a platform-specific way for tests that need link-based escape scenarios. Unsupported platforms return an explicit error.

**Data flow**: On Unix it calls `std::os::unix::fs::symlink`; on Windows it calls `std::os::windows::fs::symlink_file`; on other platforms it returns an `Unsupported` `std::io::Error`.

**Call relations**: Symlink-based sandbox tests call this helper during fixture setup to create workspace links pointing at outside files.

*Call graph*: called by 2 (apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace, intercepted_apply_patch_verification_uses_local_sandbox); 3 external calls (new, symlink, symlink_file).


##### `mount_apply_patch`  (lines 196–212)

```
async fn mount_apply_patch(
    harness: &TestCodexHarness,
    call_id: &str,
    patch: &str,
    assistant_msg: &str,
)
```

**Purpose**: Mounts the standard two-response SSE sequence for a freeform `apply_patch` custom tool call followed by an assistant message. It hides the repetitive mock-server setup used by most tests.

**Data flow**: Accepts a harness, call ID, patch text, and assistant message, builds the response bodies via `apply_patch_responses` using `ev_apply_patch_custom_tool_call`, mounts them on the harness server with `mount_sse_sequence`, and awaits completion.

**Call relations**: Most apply-patch tests call this during setup so the next turn will cause Codex to receive a patch tool call and then a final assistant response.

*Call graph*: calls 3 internal fn (mount_sse_sequence, server, apply_patch_responses); called by 28 (apply_patch_change_context_disambiguates_target, apply_patch_cli_add_overwrites_existing_file, apply_patch_cli_delete_directory_reports_verification_error, apply_patch_cli_delete_missing_file_reports_error, apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace, apply_patch_cli_end_of_file_anchor, apply_patch_cli_insert_only_hunk_modifies_file, apply_patch_cli_missing_second_chunk_context_rejected, apply_patch_cli_move_overwrites_existing_destination, apply_patch_cli_move_without_content_change_has_no_turn_diff (+15 more)).


##### `mount_apply_patch_model_output`  (lines 214–232)

```
async fn mount_apply_patch_model_output(
    harness: &TestCodexHarness,
    call_id: &str,
    patch: &str,
    assistant_msg: &str,
    model_output: ApplyPatchModelOutput,
)
```

**Purpose**: Mounts the same two-step SSE sequence as `mount_apply_patch`, but lets the caller choose the model-output representation for the patch call. Currently this supports shell-command-via-heredoc output.

**Data flow**: Takes a harness, call ID, patch text, assistant message, and `ApplyPatchModelOutput`. It maps the enum to the appropriate event-construction function, builds the response sequence with `apply_patch_responses`, mounts it on the harness server, and awaits completion.

**Call relations**: Tests that specifically exercise heredoc shell output rather than freeform custom-tool output use this helper.

*Call graph*: calls 3 internal fn (mount_sse_sequence, server, apply_patch_responses); called by 2 (apply_patch_shell_accepts_lenient_heredoc_wrapped_patch, intercepted_apply_patch_verification_uses_local_sandbox).


##### `apply_patch_responses`  (lines 234–251)

```
fn apply_patch_responses(
    call_id: &str,
    patch: &str,
    assistant_msg: &str,
    apply_patch_call: fn(&str, &str) -> serde_json::Value,
) -> Vec<String>
```

**Purpose**: Builds the canonical pair of SSE response bodies used by patch tests: one response containing the patch tool call and one containing the assistant follow-up. It is pure fixture generation.

**Data flow**: Accepts a call ID, patch text, assistant message, and a function that constructs the patch-call event. It returns a `Vec<String>` containing two SSE strings: first `response.created` + patch call + `completed`, then assistant message + `completed`.

**Call relations**: Both mount helpers delegate to this function so the suite uses one consistent mock response shape regardless of patch-call encoding.

*Call graph*: called by 2 (mount_apply_patch, mount_apply_patch_model_output); 1 external calls (vec!).


##### `apply_patch_cli_uses_codex_self_exe_with_linux_sandbox_helper_alias`  (lines 255–286)

```
async fn apply_patch_cli_uses_codex_self_exe_with_linux_sandbox_helper_alias() -> Result<()>
```

**Purpose**: Checks on Linux that apply-patch execution uses the configured sandbox helper alias and still applies a simple add-file patch successfully.

**Data flow**: Builds the default harness, reads `codex_linux_sandbox_exe` from config and asserts its filename matches `CODEX_LINUX_SANDBOX_ARG0`, mounts a simple add-file patch, submits a turn, reads the apply-patch tool output, regex-matches a successful summary, and asserts the created file contains `hello\n`.

**Call relations**: This Linux-only top-level test combines harness configuration inspection with a normal patch application to verify the helper executable wiring.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert_eq!, assert_regex_match, skip_if_no_network!).


##### `apply_patch_cli_multiple_operations_integration`  (lines 289–325)

```
async fn apply_patch_cli_multiple_operations_integration() -> Result<()>
```

**Purpose**: Verifies a single patch can add, modify, and delete files in one operation and that the tool output reports all three changes. It is a broad happy-path integration test.

**Data flow**: Builds a harness with model `gpt-5.4`, seeds workspace files, mounts a patch containing add/delete/update operations, submits a turn, captures the tool output, regex-matches the success summary including `A`, `M`, and `D` lines, and asserts the resulting filesystem state matches the patch.

**Call relations**: This test uses the standard mount helper and then validates both textual tool output and actual file contents after the patch is applied.

*Call graph*: calls 2 internal fn (apply_patch_harness_with, mount_apply_patch); 4 external calls (assert!, assert_eq!, assert_regex_match, skip_if_no_network!).


##### `apply_patch_cli_multiple_chunks`  (lines 328–348)

```
async fn apply_patch_cli_multiple_chunks() -> Result<()>
```

**Purpose**: Checks that a patch with multiple hunks against the same file applies both changes correctly. It guards against only the first chunk being honored.

**Data flow**: Creates a harness, writes `multi.txt`, mounts a patch with two `@@` hunks replacing line 2 and line 4, submits a turn, and asserts the final file text contains both replacements.

**Call relations**: A straightforward happy-path regression test using the standard patch fixture path.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_moves_file_to_new_directory`  (lines 351–370)

```
async fn apply_patch_cli_moves_file_to_new_directory() -> Result<()>
```

**Purpose**: Verifies that `*** Move to:` can relocate a file into a newly created directory while also changing its contents. It checks both deletion of the old path and creation of the new path.

**Data flow**: Writes `old/name.txt`, mounts a patch that updates the file and moves it to `renamed/dir/name.txt`, submits a turn, then asserts the old path no longer exists and the new path contains the updated text.

**Call relations**: This test exercises move semantics plus implicit directory creation through the normal apply-patch tool path.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert!, assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_updates_file_appends_trailing_newline`  (lines 373–392)

```
async fn apply_patch_cli_updates_file_appends_trailing_newline() -> Result<()>
```

**Purpose**: Ensures updating a file that lacks a trailing newline produces normalized output ending with a newline. It checks both content replacement and newline insertion.

**Data flow**: Writes `no_newline.txt` without a final newline, mounts an update patch replacing the single line with two lines, submits a turn, reads the file, and asserts it ends with `\n` and equals the expected two-line text.

**Call relations**: This regression test targets newline normalization in patch application.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert!, assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_insert_only_hunk_modifies_file`  (lines 395–415)

```
async fn apply_patch_cli_insert_only_hunk_modifies_file() -> Result<()>
```

**Purpose**: Checks that a hunk containing only context plus inserted lines is applied correctly. It verifies insertion without deletions.

**Data flow**: Writes `insert_only.txt`, mounts a patch whose hunk inserts `beta` between `alpha` and `omega`, submits a turn, and asserts the resulting file contains the inserted line in the correct position.

**Call relations**: This test covers a patch shape that can be mishandled by parsers expecting deletions or replacements.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_move_overwrites_existing_destination`  (lines 418–440)

```
async fn apply_patch_cli_move_overwrites_existing_destination() -> Result<()>
```

**Purpose**: Verifies that moving a file onto an existing destination path overwrites the destination rather than failing or preserving old contents. It also confirms the source path disappears.

**Data flow**: Seeds both source and destination files, mounts a move patch updating the source content, submits a turn, then asserts the source path is gone and the destination contains the new content.

**Call relations**: This is a move-specific overwrite regression test using the standard patch fixture path.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert!, assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_move_without_content_change_has_no_turn_diff`  (lines 443–473)

```
async fn apply_patch_cli_move_without_content_change_has_no_turn_diff() -> Result<()>
```

**Purpose**: Ensures a pure rename with no content change does not emit a `TurnDiff` event. The filesystem should still reflect the rename.

**Data flow**: Builds a harness and clones the codex handle, writes the source file, mounts a move patch whose hunk preserves identical content, submits without waiting, then listens for events until `TurnComplete`, recording whether any `EventMsg::TurnDiff` occurred. It asserts no diff was seen and verifies the file moved successfully.

**Call relations**: This event-focused test uses `submit_without_wait` so it can observe the event stream and distinguish rename-only operations from content-changing patches.

*Call graph*: calls 3 internal fn (apply_patch_harness, mount_apply_patch, submit_without_wait); 4 external calls (assert!, assert_eq!, wait_for_event, skip_if_no_network!).


##### `apply_patch_cli_add_overwrites_existing_file`  (lines 476–494)

```
async fn apply_patch_cli_add_overwrites_existing_file() -> Result<()>
```

**Purpose**: Checks that `*** Add File:` overwrites an existing file at the same path rather than failing. It validates the final file contents only.

**Data flow**: Writes `duplicate.txt`, mounts an add-file patch for the same path with new content, submits a turn, and asserts the file now contains the new text.

**Call relations**: A simple overwrite regression test for add-file semantics.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_rejects_invalid_hunk_header`  (lines 497–519)

```
async fn apply_patch_cli_rejects_invalid_hunk_header() -> Result<()>
```

**Purpose**: Verifies that malformed patch headers are rejected with a verification failure message. It checks the diagnostic text surfaced to the tool output.

**Data flow**: Builds a harness, mounts a patch containing `*** Frobnicate File: foo`, submits a turn, reads the apply-patch output, and asserts it contains both `apply_patch verification failed` and `is not a valid hunk header`.

**Call relations**: This negative test validates parser diagnostics rather than filesystem effects.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_cli_reports_missing_context`  (lines 522–548)

```
async fn apply_patch_cli_reports_missing_context() -> Result<()>
```

**Purpose**: Checks that an update patch whose expected old lines are absent fails verification and leaves the file unchanged. It validates both diagnostics and rollback.

**Data flow**: Writes `modify.txt`, mounts a patch replacing nonexistent line `missing`, submits a turn, reads the tool output, asserts it contains verification-failure text and `Failed to find expected lines in`, and finally asserts the file contents remain unchanged.

**Call relations**: This negative test covers context mismatch handling in the verifier.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert!, assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_reports_missing_target_file`  (lines 551–577)

```
async fn apply_patch_cli_reports_missing_target_file() -> Result<()>
```

**Purpose**: Verifies that updating a nonexistent file fails with a clear read-error diagnostic and does not create the file. It checks both output text and filesystem state.

**Data flow**: Mounts an update patch for `missing.txt`, submits a turn, reads the tool output, asserts it contains verification-failure text, `Failed to read file to update`, and the missing path, and asserts the path still does not exist.

**Call relations**: A missing-target regression test for update operations.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_cli_delete_missing_file_reports_error`  (lines 580–607)

```
async fn apply_patch_cli_delete_missing_file_reports_error() -> Result<()>
```

**Purpose**: Checks that deleting a nonexistent file fails with a read-related verification error and leaves the filesystem unchanged. It ensures delete operations are not silently ignored.

**Data flow**: Mounts a delete patch for `missing.txt`, submits a turn, reads the tool output, asserts it contains verification-failure text, a read-failure phrase, and the target path, and confirms the file does not exist.

**Call relations**: This negative test is the delete-operation counterpart to the missing-update-file case.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_cli_rejects_empty_patch`  (lines 610–627)

```
async fn apply_patch_cli_rejects_empty_patch() -> Result<()>
```

**Purpose**: Verifies that a patch containing only `*** Begin Patch` and `*** End Patch` is rejected as empty. It checks the exact rejection wording.

**Data flow**: Mounts an empty patch, submits a turn, reads the apply-patch output, and asserts it contains `patch rejected: empty patch`.

**Call relations**: A parser/validation regression test for degenerate patch input.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_cli_delete_directory_reports_verification_error`  (lines 630–647)

```
async fn apply_patch_cli_delete_directory_reports_verification_error() -> Result<()>
```

**Purpose**: Ensures `*** Delete File:` cannot target a directory path. The verifier should report a read failure rather than deleting the directory.

**Data flow**: Creates a directory `dir`, mounts a delete patch for that path, submits a turn, reads the tool output, and asserts it contains verification-failure text and `Failed to read`.

**Call relations**: This negative test covers directory/file type mismatches in delete operations.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_cli_rejects_path_traversal_outside_workspace`  (lines 650–687)

```
async fn apply_patch_cli_rejects_path_traversal_outside_workspace() -> Result<()>
```

**Purpose**: Checks that add-file patches using `..` to escape the workspace are rejected under restrictive workspace-write permissions. It verifies both the rejection message and absence of side effects.

**Data flow**: Computes an outside `escape.txt` path adjacent to cwd, removes it if present, mounts an add-file patch for `../escape.txt`, submits a turn with `restrictive_workspace_write_profile()`, reads the tool output, asserts it contains the outside-project rejection message, and confirms the outside path was not created.

**Call relations**: This test combines patch validation with permission-profile enforcement to prove traversal is blocked before any write occurs.

*Call graph*: calls 3 internal fn (apply_patch_harness, mount_apply_patch, restrictive_workspace_write_profile); 2 external calls (assert!, skip_if_no_network!).


##### `intercepted_apply_patch_verification_uses_local_sandbox`  (lines 691–746)

```
async fn intercepted_apply_patch_verification_uses_local_sandbox() -> Result<()>
```

**Purpose**: Verifies that intercepted heredoc-style apply-patch verification runs under the local sandbox and cannot read through a symlink to a denied target. The denied target must remain unchanged.

**Data flow**: On Unix/local-only setups, creates a real outside file, symlinks to it from the workspace, mounts a heredoc shell-command patch updating the symlink path, submits with a permission profile denying reads to the target, captures the shell stdout, asserts it is plain text rather than JSON, contains verification-failure and read-failure diagnostics, and finally asserts the outside file still contains its original text.

**Call relations**: This test specifically targets the shell-command interception path rather than freeform custom-tool execution, proving verification honors local sandbox restrictions.

*Call graph*: calls 5 internal fn (apply_patch_harness, create_file_symlink, mount_apply_patch_model_output, workspace_write_with_unreadable_path, try_from); 6 external calls (assert!, assert_eq!, format!, skip_if_no_network!, skip_if_remote!, write).


##### `apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace`  (lines 749–811)

```
async fn apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace() -> Result<()>
```

**Purpose**: Ensures apply-patch does not follow a workspace symlink to modify a file outside the workspace when outside roots are read-only. The symlink itself should remain intact.

**Data flow**: Creates separate work and outside directories, builds a harness rooted at the work dir, writes an outside victim file, creates a workspace symlink to it, mounts an update patch against the symlink path, submits with a profile that makes the outside dir read-only, reads the tool output, asserts the outside file contents are unchanged, and checks via `symlink_metadata` that the workspace path is still a symlink.

**Call relations**: This test covers path-resolution safety for symlink escapes in the normal freeform apply-patch path.

*Call graph*: calls 5 internal fn (apply_patch_harness_with, create_file_symlink, mount_apply_patch, workspace_write_with_read_only_root, try_from); 12 external calls (assert!, assert_eq!, cfg!, eprintln!, format!, skip_if_no_network!, skip_if_remote!, current_dir, create_dir_all, symlink_metadata (+2 more)).


##### `apply_patch_cli_preserves_existing_hard_link_outside_workspace`  (lines 814–909)

```
async fn apply_patch_cli_preserves_existing_hard_link_outside_workspace() -> Result<()>
```

**Purpose**: Checks the nuanced hard-link behavior: on Windows writes through an existing hard link to an outside file are rejected, while on other platforms they are intentionally allowed and must preserve shared-inode semantics. It also ensures apply-patch does not replace the hard link with a new file.

**Data flow**: Creates work and outside dirs, builds a harness rooted at work, writes an outside victim file, creates a hard link to it inside the workspace, mounts an update patch against the hard-link path, submits with a profile making the outside dir read-only, and reads the tool output. On Windows it asserts rejection and unchanged contents through both paths, then writes through the outside path and confirms the workspace path still reflects the same inode. On non-Windows it asserts success, matching updated contents through both paths, then writes through the outside path again and confirms the workspace path still sees the change.

**Call relations**: This test documents intentional platform-specific semantics around existing hard links and ensures apply-patch preserves link identity rather than unlinking/replacing files.

*Call graph*: calls 4 internal fn (apply_patch_harness_with, mount_apply_patch, workspace_write_with_read_only_root, try_from); 11 external calls (assert!, assert_eq!, cfg!, format!, skip_if_no_network!, skip_if_remote!, current_dir, create_dir_all, hard_link, write (+1 more)).


##### `apply_patch_cli_rejects_move_path_traversal_outside_workspace`  (lines 912–954)

```
async fn apply_patch_cli_rejects_move_path_traversal_outside_workspace() -> Result<()>
```

**Purpose**: Verifies that `*** Move to:` cannot escape the workspace via `..` under restrictive workspace-write permissions. The source file must remain unchanged.

**Data flow**: Computes an outside destination path, removes it if present, writes `stay.txt` in the workspace, mounts a move patch targeting `../escape-move.txt`, submits with `restrictive_workspace_write_profile()`, reads the tool output, asserts it contains the outside-project rejection message, confirms the outside path was not created, and asserts `stay.txt` still contains its original text.

**Call relations**: This is the move-operation counterpart to the add-file traversal test.

*Call graph*: calls 3 internal fn (apply_patch_harness, mount_apply_patch, restrictive_workspace_write_profile); 4 external calls (assert!, assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `apply_patch_cli_verification_failure_has_no_side_effects`  (lines 957–975)

```
async fn apply_patch_cli_verification_failure_has_no_side_effects() -> Result<()>
```

**Purpose**: Checks that verification is atomic across a multi-operation patch: if a later operation fails, earlier successful-looking operations are not applied. It guards against partial filesystem mutation.

**Data flow**: Mounts a patch that would add `created.txt` and then fail updating `missing.txt`, submits a turn, and asserts `created.txt` does not exist afterward.

**Call relations**: This negative test validates all-or-nothing behavior across multiple patch operations in one tool call.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_shell_command_heredoc_with_cd_updates_relative_workdir`  (lines 978–1010)

```
async fn apply_patch_shell_command_heredoc_with_cd_updates_relative_workdir() -> Result<()>
```

**Purpose**: Verifies that a shell-command invocation of `apply_patch` via heredoc respects a preceding `cd` and applies relative paths from the changed working directory. It checks the shell interception path rather than freeform tool calls.

**Data flow**: Builds a `gpt-5.4` harness, writes `sub/in_sub.txt`, mounts a two-response SSE sequence whose first event is a `shell_command` call containing `cd sub && apply_patch <<'EOF' ...`, submits a turn, reads the shell function-call stdout, asserts it contains `Success.`, and verifies `sub/in_sub.txt` now contains `after\n`.

**Call relations**: This test bypasses the standard mount helper because it needs a raw shell-command event, exercising the shell interception and relative-workdir logic.

*Call graph*: calls 2 internal fn (mount_sse_sequence, apply_patch_harness_with); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `apply_patch_cli_can_use_shell_command_output_as_patch_input`  (lines 1013–1153)

```
async fn apply_patch_cli_can_use_shell_command_output_as_patch_input() -> Result<()>
```

**Purpose**: Proves that model tool chaining can read file contents via `shell_command` and then feed that output into a later `apply_patch` call. It validates dynamic request/response sequencing rather than a fixed fixture.

**Data flow**: Builds a harness with `gpt-5.4` and Windows shell support, writes `source.txt`, defines local helpers to normalize shell stdout and extract `function_call_output` text from request bodies, and mounts a custom `DynamicApplyFromRead` responder. On the first request the responder emits a shell command to read `source.txt`; on the second it parses the prior tool output from the request body, converts each line into `+...` patch lines, and emits an `apply_patch` call adding `target.txt`; on the third it emits a final assistant message. After submitting the turn, the test reads `target.txt` and asserts it exactly matches the original source contents.

**Call relations**: This is the most dynamic test in the file: wiremock invokes the custom responder three times, and the responder itself derives the second tool call from Codex’s first tool output.

*Call graph*: calls 1 internal fn (apply_patch_harness_with); 7 external calls (new, given, assert_eq!, skip_if_no_network!, skip_if_remote!, method, path_regex).


##### `apply_patch_custom_tool_streaming_emits_updated_changes`  (lines 1156–1257)

```
async fn apply_patch_custom_tool_streaming_emits_updated_changes() -> Result<()>
```

**Purpose**: Checks that streaming custom-tool input deltas for `apply_patch` produce incremental `PatchApplyUpdated` events before the final patch is applied. It validates the intermediate change snapshots emitted to the event stream.

**Data flow**: Builds a harness with `Feature::ApplyPatchStreamingEvents` enabled, mounts an SSE sequence whose first response streams `response.output_item.added`, several `response.custom_tool_call_input.delta` chunks, then the final `ev_apply_patch_custom_tool_call`, and whose second response is a final assistant message. It submits without waiting, collects `EventMsg::PatchApplyUpdated` events until `TurnComplete`, and asserts there are two updates for the same call ID: the first reports `streamed.txt` as an added file with empty content, the last reports the full `hello\nworld\n` content. It then verifies the file was actually written.

**Call relations**: This event-centric test uses `submit_without_wait` and listens to Codex events to validate streaming patch-preview behavior before final application.

*Call graph*: calls 3 internal fn (mount_sse_sequence, apply_patch_harness_with, submit_without_wait); 5 external calls (new, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `apply_patch_shell_command_heredoc_with_cd_emits_turn_diff`  (lines 1260–1319)

```
async fn apply_patch_shell_command_heredoc_with_cd_emits_turn_diff() -> Result<()>
```

**Purpose**: Verifies that a successful heredoc shell-command patch emits patch lifecycle events and a unified turn diff. It complements the earlier heredoc test by focusing on event emission.

**Data flow**: Builds a `gpt-5.4` harness, writes `sub/in_sub.txt`, mounts a shell-command SSE sequence using a raw `shell_command` function call with JSON args, submits without waiting, and listens for `PatchApplyBegin`, `PatchApplyEnd`, `TurnDiff`, and `TurnComplete`. It asserts the begin/end events reference the expected call ID, the end event reports success, and the captured diff contains `diff --git`.

**Call relations**: This test uses the shell-command path and event stream observation to ensure intercepted apply-patch operations integrate with turn-diff reporting.

*Call graph*: calls 3 internal fn (mount_sse_sequence, apply_patch_harness_with, submit_without_wait); 5 external calls (assert!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `apply_patch_turn_diff_paths_stay_repo_relative_when_session_cwd_is_nested`  (lines 1322–1390)

```
async fn apply_patch_turn_diff_paths_stay_repo_relative_when_session_cwd_is_nested() -> Result<()>
```

**Purpose**: Checks that unified diffs remain repository-relative even when the session cwd is a nested subdirectory and the patch references `..` paths inside the repo. Absolute repo paths must not leak into the diff.

**Data flow**: Builds a harness whose cwd is `subdir` under a fake repo root marked by `.git`, writes `repo.txt` at the repo root, mounts a patch updating `../repo.txt`, submits without waiting, captures the last `TurnDiff`, and asserts it contains `diff --git a/repo.txt b/repo.txt` while not containing the absolute repo-root path string.

**Call relations**: This event-focused test validates diff path normalization after successful patch application in nested-cwd sessions.

*Call graph*: calls 3 internal fn (apply_patch_harness_with, mount_apply_patch, submit_without_wait); 3 external calls (assert!, wait_for_event, skip_if_no_network!).


##### `apply_patch_shell_command_failure_propagates_error_and_skips_diff`  (lines 1393–1447)

```
async fn apply_patch_shell_command_failure_propagates_error_and_skips_diff() -> Result<()>
```

**Purpose**: Ensures that when a heredoc shell-command patch fails verification, Codex surfaces the failure output but does not emit a turn diff. The target file must remain unchanged.

**Data flow**: Builds a `gpt-5.4` harness, writes `invalid.txt`, mounts a shell-command SSE sequence whose patch references nonexistent old content, submits without waiting, listens for events until `TurnComplete` while recording whether any `TurnDiff` occurred, asserts no diff was seen, reads the shell stdout, checks it contains the missing-context diagnostics and file path, and verifies the file contents are unchanged.

**Call relations**: This is the failure-path counterpart to the heredoc diff-emission test, proving diffs are only emitted for successful patch application.

*Call graph*: calls 3 internal fn (mount_sse_sequence, apply_patch_harness_with, submit_without_wait); 6 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `apply_patch_shell_accepts_lenient_heredoc_wrapped_patch`  (lines 1450–1485)

```
async fn apply_patch_shell_accepts_lenient_heredoc_wrapped_patch() -> Result<()>
```

**Purpose**: Checks that heredoc-style shell output containing a patch body in a lenient wrapped form is still accepted and applied. It also verifies the shell output is plain text rather than structured JSON.

**Data flow**: Builds the default harness, constructs a simple add-file patch string, mounts it via `mount_apply_patch_model_output` using `ShellCommandViaHeredoc`, submits a turn, reads the shell stdout, asserts it is not parseable as JSON, contains the success summary and created-file line, and verifies the file contents.

**Call relations**: This test targets compatibility with shell-produced patch output formatting rather than the freeform custom-tool path.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch_model_output); 4 external calls (assert!, assert_eq!, format!, skip_if_no_network!).


##### `apply_patch_cli_end_of_file_anchor`  (lines 1488–1502)

```
async fn apply_patch_cli_end_of_file_anchor() -> Result<()>
```

**Purpose**: Verifies support for `*** End of File` anchors in update hunks. It ensures EOF-anchored replacements apply correctly.

**Data flow**: Writes `tail.txt`, mounts an update patch replacing the last line and including `*** End of File`, submits a turn, and asserts the resulting file text is `alpha\nend\n`.

**Call relations**: A focused parser/patch-application regression test.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_missing_second_chunk_context_rejected`  (lines 1505–1532)

```
async fn apply_patch_cli_missing_second_chunk_context_rejected() -> Result<()>
```

**Purpose**: Checks that a malformed second chunk lacking its own `@@` context is rejected and leaves the file unchanged. It validates diagnostics for multi-chunk parse/verification errors.

**Data flow**: Writes `two_chunks.txt`, mounts a patch whose first chunk is valid but second chunk omits `@@`, submits a turn, reads the tool output, asserts it contains verification-failure text and missing-context diagnostics, and confirms the original file contents remain intact.

**Call relations**: This negative test covers malformed multi-chunk patches that might otherwise partially apply.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert!, assert_eq!, skip_if_no_network!).


##### `apply_patch_emits_turn_diff_event_with_unified_diff`  (lines 1535–1566)

```
async fn apply_patch_emits_turn_diff_event_with_unified_diff() -> Result<()>
```

**Purpose**: Verifies that a successful freeform apply-patch call emits a `TurnDiff` event containing a unified diff. It checks only for basic diff markers rather than exact content.

**Data flow**: Builds the default harness, mounts an add-file patch, submits without waiting, listens for `TurnDiff` until `TurnComplete`, and asserts the captured diff contains `diff --git`, either `--- /dev/null` or `--- a/`, and `+++ b/`.

**Call relations**: This is the baseline diff-emission test for successful freeform patch application.

*Call graph*: calls 3 internal fn (apply_patch_harness, mount_apply_patch, submit_without_wait); 4 external calls (assert!, wait_for_event, format!, skip_if_no_network!).


##### `apply_patch_turn_diff_tracks_local_and_remote_environment_paths`  (lines 1569–1731)

```
async fn apply_patch_turn_diff_tracks_local_and_remote_environment_paths() -> Result<()>
```

**Purpose**: Checks that turn diffs aggregate changes from both local and remote environments and prefix paths with `local/` and `remote/` respectively. It also verifies the actual file contents in each environment.

**Data flow**: Builds a remote+local harness, creates a shared cwd in both environments, mounts three SSE responses that apply one patch to the local environment and one to the remote environment before a final assistant message, computes turn permission fields for disabled permissions, submits a raw `Op::UserInput` with explicit environment selections for local and remote shared cwd, waits for the last `TurnDiff`, asserts the local filesystem contains `local\n`, the remote filesystem contains `remote\n`, and compares the diff string against an exact expected multi-file unified diff with `a/local/...` and `a/remote/...` paths. It then cleans up both shared directories.

**Call relations**: This test bypasses the harness convenience submit path to explicitly set multi-environment turn settings and validate cross-environment diff aggregation.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, test_codex, turn_permission_fields, new, from_path); 11 external calls (default, from, assert_eq!, get_remote_test_env, wait_for_event, format!, create_dir_all, remove_dir_all, skip_if_no_network!, skip_if_wine_exec! (+1 more)).


##### `apply_patch_aggregates_diff_across_multiple_tool_calls`  (lines 1734–1781)

```
async fn apply_patch_aggregates_diff_across_multiple_tool_calls() -> Result<()>
```

**Purpose**: Verifies that multiple successful apply-patch tool calls within one turn are aggregated into a single final turn diff. The final diff should reflect the end state after all patches.

**Data flow**: Builds the default harness, mounts three SSE responses: first add `agg/a.txt`, second update `agg/a.txt` and add `agg/b.txt`, third final assistant message. It submits without waiting, captures the last `TurnDiff`, and asserts the diff mentions both files and includes the final `v2` content for `a.txt`.

**Call relations**: This event-focused test validates diff aggregation across multiple successful patch tool calls in one turn.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, apply_patch_harness, submit_without_wait); 4 external calls (assert!, wait_for_event, skip_if_no_network!, vec!).


##### `apply_patch_aggregates_diff_preserves_success_after_failure`  (lines 1784–1854)

```
async fn apply_patch_aggregates_diff_preserves_success_after_failure() -> Result<()>
```

**Purpose**: Checks that if one patch tool call succeeds and a later one fails verification, the aggregated diff still reflects the successful earlier changes. It also verifies the failure output for the failed call.

**Data flow**: Builds the default harness, mounts responses for a successful add-file patch, then a failing update patch, then a final assistant message, submits without waiting, waits with timeout for the last `TurnDiff`, asserts the diff still contains the successful file and `+ok`, reads the failed custom-tool output and checks for verification-failure diagnostics, and confirms the successfully added file exists with the expected contents.

**Call relations**: This test documents that diff aggregation is resilient to later failures and preserves already-applied successful changes.

*Call graph*: calls 3 internal fn (mount_sse_sequence, apply_patch_harness, submit_without_wait); 6 external calls (from_secs, assert!, assert_eq!, wait_for_event_with_timeout, skip_if_no_network!, vec!).


##### `apply_patch_clears_aggregated_diff_after_inexact_delta`  (lines 1857–1924)

```
async fn apply_patch_clears_aggregated_diff_after_inexact_delta() -> Result<()>
```

**Purpose**: Verifies that an inexact delta—such as replacing binary content with text—invalidates the aggregate diff and causes the final `TurnDiff` payload to be the empty string. Successful earlier changes still remain on disk.

**Data flow**: Builds a harness whose workspace initially contains binary `binary.dat`, mounts responses for a successful add-file patch followed by an add-file patch overwriting `binary.dat` with text, submits without waiting, waits with timeout for the last `TurnDiff`, asserts it is exactly `""`, and verifies both the earlier successful file and the overwritten binary path now contain their expected final contents.

**Call relations**: This test targets the diff-aggregation invalidation path when Codex can no longer produce an exact unified diff for the cumulative changes.

*Call graph*: calls 3 internal fn (mount_sse_sequence, apply_patch_harness_with, submit_without_wait); 5 external calls (from_secs, assert_eq!, wait_for_event_with_timeout, skip_if_no_network!, vec!).


##### `apply_patch_change_context_disambiguates_target`  (lines 1927–1946)

```
async fn apply_patch_change_context_disambiguates_target() -> Result<()>
```

**Purpose**: Checks that change-context syntax in a hunk header can disambiguate which repeated matching line should be updated. It ensures the patch applies to the intended function block.

**Data flow**: Writes `multi_ctx.txt` containing two `x=10` lines under different function labels, mounts a patch with `@@ fn b` context replacing only the second occurrence, submits a turn, reads the file, and asserts only the `fn b` section changed to `x=11`.

**Call relations**: This focused regression test validates contextual disambiguation in patch matching.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert_eq!, skip_if_no_network!).


### Output shaping and interruption
These tests focus on how tool results are serialized, truncated, parallelized, snapshotted, and represented when execution is aborted.

### `core/tests/suite/shell_serialization.rs`

`test` · `request handling`

This non-Windows test file focuses on the exact string form recorded for tool outputs in outbound function-call results. Its helper `shell_responses` takes a vector of argv fragments, shell-quotes them with `shlex::try_join`, and emits a mocked `shell_command` function call with a fixed 2-second timeout. The tests then inspect the mock server’s recorded request body, drill into `function_call_output(call_id)`, and assert on the `output` string field.

Several tests prove that shell output is intentionally freeform text: a JSON fixture printed by `sed` must remain plain text in the `Output:` section rather than becoming parsed JSON; a sleeping command must record a positive wall-clock duration; and nonzero exits still use the same textual envelope with the actual exit code. Two size-boundary tests verify truncation behavior around 10,000 bytes: exactly 10,000 `1` characters must be preserved in full, while 10,001 bytes must be replaced by a truncation marker. The file also covers the custom `apply_patch` tool path using a dedicated harness from another suite module. Those tests assert the same `Exit code`/`Wall time`/`Output:` framing for successful file creation and modification, but expect a raw failure string for verification errors, documenting that apply-patch failures are surfaced differently from successful shell-like tool output.

#### Function details

##### `shell_responses`  (lines 37–58)

```
fn shell_responses(call_id: &str, command: Vec<&str>) -> Result<Vec<String>>
```

**Purpose**: Constructs a mocked `shell_command` SSE exchange from an argv-style command vector, ensuring the command string is shell-quoted exactly once.

**Data flow**: Accepts a `call_id` and `Vec<&str>` command parts. It joins the parts into a shell command string with `shlex::try_join`, wraps that plus `timeout_ms: 2_000` in JSON, serializes it, and returns a `Result<Vec<String>>` containing the tool-call SSE followed by a simple assistant completion SSE.

**Call relations**: Used by the shell-output serialization tests as the common fixture generator whenever they want the model to invoke `shell_command` with a realistic quoted command.

*Call graph*: called by 3 (shell_output_is_freeform_for_nonzero_exit, shell_output_preserves_fixture_json_as_freeform, shell_output_records_duration); 3 external calls (json!, try_join, vec!).


##### `shell_output_preserves_fixture_json_as_freeform`  (lines 61–109)

```
async fn shell_output_preserves_fixture_json_as_freeform() -> Result<()>
```

**Purpose**: Proves that shell output containing JSON text is returned as plain text inside the output envelope rather than being interpreted as structured JSON.

**Data flow**: Starts a mock server, builds a test harness, writes `FIXTURE_JSON` to `fixture.json` in the test cwd, mounts a `shell_command` call that prints the file with `/usr/bin/sed -n p`, submits a turn with permissions disabled, then reads the recorded function-call output string from the mock request. It asserts that parsing the whole output as JSON fails, splits on `Output:\n`, regex-checks the header, and compares the body exactly to `FIXTURE_JSON`.

**Call relations**: This test drives the full request/response path and inspects the serialized outbound tool result rather than local stdout helpers, making it the clearest specification of freeform shell-output semantics.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, shell_responses); 6 external calls (assert!, assert_eq!, assert_regex_match, write, skip_if_no_network!, vec!).


##### `shell_output_records_duration`  (lines 112–152)

```
async fn shell_output_records_duration() -> Result<()>
```

**Purpose**: Checks that shell output includes a measurable wall-time line and that the recorded duration is greater than zero for a sleeping command.

**Data flow**: Builds a mock-backed test, mounts a `shell_command` call for `/bin/sh -c 'sleep 0.2'`, submits the turn, extracts the `output` string from the recorded function-call output, regex-matches the overall envelope, then parses the numeric wall time with `Regex` and asserts it exceeds 0.1 seconds.

**Call relations**: Uses the shared `shell_responses` helper and extends the serialization checks beyond formatting into semantic timing content.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, shell_responses); 5 external calls (new, assert!, assert_regex_match, skip_if_no_network!, vec!).


##### `apply_patch_custom_tool_call_creates_file`  (lines 155–194)

```
async fn apply_patch_custom_tool_call_creates_file() -> Result<()>
```

**Purpose**: Verifies that a successful custom `apply_patch` tool call reports a shell-like success envelope and actually creates the requested file with the expected contents.

**Data flow**: Creates an apply-patch harness, formats an add-file patch for `custom_tool_apply_patch.txt`, mounts the mocked apply-patch response, submits a turn with permissions disabled, reads the captured apply-patch output string, regex-matches the success report listing `A <file>`, then reads the created file and asserts its contents are `custom tool content\n`.

**Call relations**: This test uses the dedicated apply-patch helpers from the sibling suite module rather than the generic shell-response helper, documenting the custom tool’s success serialization contract.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 4 external calls (assert_eq!, assert_regex_match, format!, skip_if_no_network!).


##### `apply_patch_custom_tool_call_updates_existing_file`  (lines 197–234)

```
async fn apply_patch_custom_tool_call_updates_existing_file() -> Result<()>
```

**Purpose**: Verifies that a successful custom `apply_patch` update reports a modification entry and rewrites the target file contents.

**Data flow**: Builds the apply-patch harness, prewrites `before\n` to the target file, formats an update patch replacing it with `after`, mounts the mocked tool response, submits the turn, reads the apply-patch output, regex-checks for `M <file>` in the success report, and finally reads the file back to confirm it now contains `after\n`.

**Call relations**: Complements the create-file test by covering the update path and ensuring both the textual report and filesystem side effect are correct.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 4 external calls (assert_eq!, assert_regex_match, format!, skip_if_no_network!).


##### `apply_patch_custom_tool_call_reports_failure_output`  (lines 237–268)

```
async fn apply_patch_custom_tool_call_reports_failure_output() -> Result<()>
```

**Purpose**: Checks that a failing custom `apply_patch` invocation returns the raw verification failure text instead of the normal shell-style output envelope.

**Data flow**: Skips under Wine and without network, creates the apply-patch harness, formats a patch that updates a nonexistent file, mounts the mocked response, submits the turn, reads the apply-patch output string, constructs the expected absolute-path failure message using the harness cwd, and asserts exact equality.

**Call relations**: This is the negative counterpart to the successful apply-patch tests and documents that failure serialization is intentionally different.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 4 external calls (assert_eq!, format!, skip_if_no_network!, skip_if_wine_exec!).


##### `shell_output_is_freeform_for_nonzero_exit`  (lines 271–302)

```
async fn shell_output_is_freeform_for_nonzero_exit() -> Result<()>
```

**Purpose**: Ensures that shell output for a failing command still uses the freeform text envelope and preserves the nonzero exit code.

**Data flow**: Starts a mock server and test harness, mounts a `shell_command` call for `/bin/sh -c 'exit 42'`, submits the turn, extracts the recorded `output` string from the function-call output, and regex-matches an envelope with `Exit code: 42`, a wall-time line, and an empty `Output:` section.

**Call relations**: Uses `shell_responses` and complements the success serialization tests by proving the same freeform format applies to failures.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, shell_responses); 3 external calls (assert_regex_match, skip_if_no_network!, vec!).


##### `shell_command_output_is_freeform`  (lines 305–354)

```
async fn shell_command_output_is_freeform() -> Result<()>
```

**Purpose**: Checks the direct `shell_command` tool path returns a plain text output envelope containing the command’s stdout.

**Data flow**: Builds a mock-backed test, manually constructs JSON args for `echo shell command` with `login: false` and `timeout_ms: 1_000`, mounts a two-step SSE sequence, submits the turn, extracts the `output` string from the recorded function-call output, and regex-matches the expected envelope ending with `shell command`.

**Call relations**: Unlike the earlier shell tests that use argv joining, this one directly specifies the `shell_command` arguments to validate the exact tool path used by the model.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_regex_match, json!, skip_if_no_network!, vec!).


##### `shell_command_output_is_not_truncated_under_10k_bytes`  (lines 357–405)

```
async fn shell_command_output_is_not_truncated_under_10k_bytes() -> Result<()>
```

**Purpose**: Verifies that `shell_command` output at exactly 10,000 bytes is preserved in full without truncation.

**Data flow**: Creates a mock-backed test with model `gpt-5.4`, mounts a `shell_command` call that runs `perl -e 'print "1" x 10000'`, submits the turn, extracts the serialized `output` string, and regex-matches an envelope whose body is exactly 10,000 `1` characters.

**Call relations**: This is the lower boundary test for output truncation behavior and pairs with the over-limit case below.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_regex_match, json!, skip_if_no_network!, vec!).


##### `shell_command_output_is_not_truncated_over_10k_bytes`  (lines 408–456)

```
async fn shell_command_output_is_not_truncated_over_10k_bytes() -> Result<()>
```

**Purpose**: Verifies that `shell_command` output exceeding 10,000 bytes is truncated and replaced with the expected truncation marker text.

**Data flow**: Builds a mock-backed test with model `gpt-5.2`, mounts a `shell_command` call that prints 10,001 `1` characters, submits the turn, extracts the serialized `output` string, and regex-matches an envelope whose body contains the `… chars truncated…` marker rather than the full payload.

**Call relations**: This is the upper boundary companion to the exact-10k test and documents the truncation policy visible to downstream consumers.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_regex_match, json!, skip_if_no_network!, vec!).


### `core/tests/suite/abort_tasks.rs`

`test` · `integration test execution during turn interruption and follow-up turns`

All three tests use a mocked Responses SSE stream that emits a `shell_command` function call for a long-running `sleep 60` command. The first test is the narrowest: it mounts a single SSE response, builds a `TestCodex`, submits a user turn, waits until `EventMsg::ExecCommandBegin` appears to avoid racing the interrupt, then submits `Op::Interrupt` and waits for `EventMsg::TurnAborted`. The second and third tests extend that flow into a follow-up turn by mounting a two-response sequence. After the initial tool call begins, they sleep briefly (`0.1` seconds) so elapsed wall time is measurable, interrupt, wait for `TurnAborted`, then submit another user turn and wait for `TurnComplete`. They inspect the recorded outbound requests rather than only internal events. `interrupt_tool_records_history_entries` asserts there were exactly two Responses API calls, that the original tool call id is present in history, and that the synthesized `function_call_output` text matches a regex of the form `Wall time: <secs> seconds\naborted by user`, with parsed elapsed time at least `0.1`. `interrupt_persists_turn_aborted_marker_in_next_request` inspects the second request's user message texts and requires one to contain `<turn_aborted>`, proving the abort is persisted into future model context, not just emitted as a transient event.

#### Function details

##### `interrupt_long_running_tool_emits_turn_aborted`  (lines 23–68)

```
async fn interrupt_long_running_tool_emits_turn_aborted()
```

**Purpose**: Checks the immediate runtime behavior of interrupting a long-running shell tool. It ensures that once execution has actually begun, sending `Op::Interrupt` causes the session to emit `TurnAborted`.

**Data flow**: Builds JSON tool arguments for `sleep 60`, wraps them in an SSE body containing a `shell_command` function call and completion event, starts a mock server, mounts the response, builds a `TestCodex`, submits `Op::UserInput`, waits for an `ExecCommandBegin` event, submits `Op::Interrupt`, then waits for a `TurnAborted` event → returns `()` if both waits succeed.

**Call relations**: The Tokio test harness invokes this directly as the simplest abort-path test. It delegates event synchronization to `wait_for_event` and uses only one mocked model response because it is concerned with the immediate interrupt outcome, not follow-up history.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (default, wait_for_event, json!, vec!).


##### `interrupt_tool_records_history_entries`  (lines 75–174)

```
async fn interrupt_tool_records_history_entries()
```

**Purpose**: Verifies that interrupting a tool leaves model-visible history entries for both the original function call and a synthesized aborted output. It specifically checks that the abort output includes elapsed wall time and the text `aborted by user`.

**Data flow**: Creates two SSE responses: the first emits a `shell_command` call with `call_id`, the second is a follow-up completion. It starts a mock server, mounts the sequence, builds a `TestCodex`, clones the shared codex handle, submits an initial user turn, waits for `ExecCommandBegin`, sleeps `0.1s`, interrupts, waits for `TurnAborted`, submits a follow-up user turn, and waits for `TurnComplete`. It then reads all recorded requests from the mock, asserts there are two, confirms the function call id appears in the payload, extracts the `function_call_output` text, matches it against a regex, parses the captured seconds as `f32`, and asserts the elapsed time is at least `0.1` → returns `()` on success.

**Call relations**: This test is invoked by the harness as the history-persistence companion to the immediate-abort test. It relies on the mock response recorder's inspection helpers after the second turn to prove that the abort was serialized back to the model, not merely tracked internally.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex); 10 external calls (clone, default, from_secs_f32, new, assert!, assert_matches!, wait_for_event, json!, sleep, vec!).


##### `interrupt_persists_turn_aborted_marker_in_next_request`  (lines 179–256)

```
async fn interrupt_persists_turn_aborted_marker_in_next_request()
```

**Purpose**: Asserts that an interrupted turn leaves a `<turn_aborted>` marker in the next outbound model request. This checks a separate persistence mechanism from the aborted function-call output text.

**Data flow**: Sets up the same two-response long-running tool scenario as the previous test, builds a `TestCodex`, submits the first user turn, waits for `ExecCommandBegin`, sleeps briefly, interrupts, waits for `TurnAborted`, submits a follow-up turn, and waits for `TurnComplete`. It then fetches the two recorded requests, selects the second one, extracts user-role message texts, and asserts at least one contains `<turn_aborted>` → returns `()` if the marker is present.

**Call relations**: The harness runs this alongside the other abort tests. It shares the same interrupt-and-follow-up control flow as `interrupt_tool_records_history_entries`, but its final assertion targets the persisted conversation marker rather than the synthesized tool output.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex); 9 external calls (clone, default, from_secs_f32, assert!, assert_eq!, wait_for_event, json!, sleep, vec!).


### `core/tests/suite/shell_snapshot.rs`

`test` · `request handling`

This file builds higher-level integration tests around shell snapshots: temporary shell initialization scripts written under `codex_home/shell_snapshots` and sourced before command execution. It defines a `SnapshotRun` record that captures the begin/end exec events plus the snapshot path, snapshot contents, and Codex home directory so tests can assert both process invocation and filesystem artifacts. Polling helpers wait for snapshot files and eventual file contents with explicit deadlines, because snapshot creation and patch side effects are asynchronous.

Two runner helpers encapsulate the full setup for unified exec (`exec_command`) and classic `shell_command`. Each enables the necessary feature flags, optionally injects `shell_environment_policy.r#set`, mounts a mocked tool call, submits a user turn with explicit thread settings and disabled permissions, waits for `ExecCommandBegin`, reads the snapshot file, then waits for `ExecCommandEnd` and `TurnComplete`. Additional helpers generate a policy-specific PATH override snapshot and a shell command that proves policy-set environment variables are re-applied after sourcing the snapshot. The tests then assert platform-specific command-line shapes (`-lc` on Linux, a sourcing trampoline on macOS, PowerShell arguments on Windows), verify snapshot sections such as aliases/exports/setopts, confirm policy precedence, ensure `apply_patch` is still intercepted even when running through a snapshot-enabled shell, and finally check that snapshot files are deleted after shutdown.

#### Function details

##### `wait_for_snapshot`  (lines 52–74)

```
async fn wait_for_snapshot(codex_home: &Path) -> Result<PathBuf>
```

**Purpose**: Polls the shell snapshot directory until a snapshot script file appears or a timeout elapses.

**Data flow**: Takes `codex_home`, appends `shell_snapshots`, and repeatedly reads the directory for up to 5 seconds. It returns the first entry whose extension is `sh` or `ps1`; otherwise it sleeps 25 ms between attempts and bails with an error on timeout.

**Call relations**: Called by the snapshot runners and several tests that need to inspect or overwrite the generated snapshot file before asserting later behavior.

*Call graph*: called by 6 (linux_unified_exec_snapshot_preserves_shell_environment_policy_set, run_shell_command_snapshot_with_options, run_snapshot_command_with_options, shell_command_snapshot_preserves_shell_environment_policy_set, shell_command_snapshot_still_intercepts_apply_patch, shell_snapshot_deleted_after_shutdown_with_skills); 7 external calls (from_millis, from_secs, now, join, bail!, read_dir, sleep).


##### `wait_for_file_contents`  (lines 76–91)

```
async fn wait_for_file_contents(path: &Path) -> Result<String>
```

**Purpose**: Waits until a file becomes readable and returns its contents, tolerating initial absence.

**Data flow**: Accepts a path and repeatedly attempts `fs::read_to_string` for up to 15 seconds. `NotFound` is treated as a retry condition; any other I/O error is returned immediately; success returns the file contents string.

**Call relations**: Used only in the apply-patch interception test to wait for the patched file to appear after asynchronous patch processing.

*Call graph*: 6 external calls (from_millis, from_secs, now, bail!, read_to_string, sleep).


##### `policy_set_path_for_test`  (lines 93–95)

```
fn policy_set_path_for_test() -> HashMap<String, String>
```

**Purpose**: Builds the shell environment policy map used by policy-preservation tests.

**Data flow**: Returns a `HashMap<String, String>` containing a single `PATH` entry set to the constant `POLICY_PATH_FOR_TEST`.

**Call relations**: Consumed indirectly by tests that configure `shell_environment_policy.r#set` and then verify that policy-set values override snapshot-provided values.

*Call graph*: 1 external calls (from).


##### `snapshot_override_content_for_policy_test`  (lines 97–101)

```
fn snapshot_override_content_for_policy_test() -> String
```

**Purpose**: Generates replacement snapshot script contents that deliberately set a conflicting PATH and a marker variable.

**Data flow**: Formats and returns a shell script string beginning with `# Snapshot file`, exporting `PATH` to `SNAPSHOT_PATH_FOR_TEST` and exporting `CODEX_SNAPSHOT_POLICY_MARKER=from_snapshot`.

**Call relations**: Policy-preservation tests write this content into the generated snapshot file to simulate a snapshot that would conflict with policy-applied environment settings.

*Call graph*: called by 2 (linux_unified_exec_snapshot_preserves_shell_environment_policy_set, shell_command_snapshot_preserves_shell_environment_policy_set); 1 external calls (format!).


##### `command_asserting_policy_after_snapshot`  (lines 103–107)

```
fn command_asserting_policy_after_snapshot() -> String
```

**Purpose**: Builds a shell command that succeeds only if the snapshot marker is present but the final PATH reflects policy reapplication rather than the snapshot override.

**Data flow**: Returns a formatted shell snippet that checks the marker variable and PATH contents. On success it prints `policy-after-snapshot`; otherwise it prints diagnostic `path=... marker=...` text.

**Call relations**: Used by both shell-command and unified-exec policy tests as the runtime proof that policy-set environment variables are applied after sourcing the snapshot.

*Call graph*: called by 2 (linux_unified_exec_snapshot_preserves_shell_environment_policy_set, shell_command_snapshot_preserves_shell_environment_policy_set); 1 external calls (format!).


##### `run_snapshot_command`  (lines 109–111)

```
async fn run_snapshot_command(command: &str) -> Result<SnapshotRun>
```

**Purpose**: Convenience wrapper that runs a unified exec command with default snapshot options.

**Data flow**: Accepts a command string, constructs default `SnapshotRunOptions`, forwards to `run_snapshot_command_with_options`, and returns the resulting `SnapshotRun`.

**Call relations**: Platform-specific unified-exec tests call this when they do not need custom environment policy overrides.

*Call graph*: calls 1 internal fn (run_snapshot_command_with_options); called by 3 (linux_unified_exec_uses_shell_snapshot, macos_unified_exec_uses_shell_snapshot, windows_unified_exec_uses_shell_snapshot); 1 external calls (default).


##### `run_snapshot_command_with_options`  (lines 113–210)

```
async fn run_snapshot_command_with_options(
    command: &str,
    options: SnapshotRunOptions,
) -> Result<SnapshotRun>
```

**Purpose**: Executes a mocked `exec_command` turn with shell snapshots enabled and captures both exec events and the generated snapshot file.

**Data flow**: Consumes a command string and `SnapshotRunOptions`. It builds a test configuration enabling `UnifiedExec` and `ShellSnapshot`, applies any `shell_environment_policy.r#set`, creates a harness, mounts an `exec_command` function call with JSON args `{cmd, yield_time_ms: 1000}`, submits a user turn with explicit thread settings, waits for `ExecCommandBegin`, waits for and reads the snapshot file, waits for `ExecCommandEnd` and `TurnComplete`, then returns a `SnapshotRun` containing begin/end events, snapshot path/content, and `codex_home`.

**Call relations**: This is the main orchestration helper behind the unified-exec snapshot tests. `run_snapshot_command` delegates to it, and the Linux/macOS/Windows unified-exec tests assert on its returned structure.

*Call graph*: calls 6 internal fn (mount_sse_sequence, with_builder, local_selections, test_codex, turn_permission_fields, wait_for_snapshot); called by 1 (run_snapshot_command); 6 external calls (default, wait_for_event, wait_for_event_match, read_to_string, json!, vec!).


##### `run_shell_command_snapshot`  (lines 212–214)

```
async fn run_shell_command_snapshot(command: &str) -> Result<SnapshotRun>
```

**Purpose**: Convenience wrapper that runs a `shell_command` turn with default snapshot options.

**Data flow**: Accepts a command string, creates default options, forwards to `run_shell_command_snapshot_with_options`, and returns the resulting `SnapshotRun`.

**Call relations**: Used by the basic shell-command snapshot test to avoid repeating default option construction.

*Call graph*: calls 1 internal fn (run_shell_command_snapshot_with_options); called by 1 (linux_shell_command_uses_shell_snapshot); 1 external calls (default).


##### `run_shell_command_snapshot_with_options`  (lines 216–308)

```
async fn run_shell_command_snapshot_with_options(
    command: &str,
    options: SnapshotRunOptions,
) -> Result<SnapshotRun>
```

**Purpose**: Executes a mocked `shell_command` turn with shell snapshots enabled and captures the resulting exec events and snapshot file.

**Data flow**: Takes a command string and options, builds a harness with `ShellSnapshot` enabled and optional environment policy settings, mounts a `shell_command` function call with `{command, timeout_ms: 1000}`, submits a user turn with explicit thread settings, waits for `ExecCommandBegin`, waits for and reads the snapshot file, waits for `ExecCommandEnd` and `TurnComplete`, and returns a populated `SnapshotRun`.

**Call relations**: Parallel to `run_snapshot_command_with_options`, but for the classic shell tool. `run_shell_command_snapshot` delegates to it, and shell-command snapshot tests consume its captured begin/end data.

*Call graph*: calls 6 internal fn (mount_sse_sequence, with_builder, local_selections, test_codex, turn_permission_fields, wait_for_snapshot); called by 1 (run_shell_command_snapshot); 6 external calls (default, wait_for_event, wait_for_event_match, read_to_string, json!, vec!).


##### `run_tool_turn_on_harness`  (lines 310–376)

```
async fn run_tool_turn_on_harness(
    harness: &TestCodexHarness,
    prompt: &str,
    call_id: &str,
    tool_name: &str,
    args: serde_json::Value,
) -> Result<ExecCommandEndEvent>
```

**Purpose**: Runs a single mocked tool turn on an existing harness and returns the matching `ExecCommandEndEvent` after the turn completes.

**Data flow**: Receives a harness, prompt text, `call_id`, tool name, and JSON args. It mounts a two-step SSE sequence for that tool call, submits a user turn with explicit thread settings derived from the harness test state, waits for matching `ExecCommandBegin` and `ExecCommandEnd`, waits for `TurnComplete`, and returns the end event.

**Call relations**: Used by the policy-preservation tests to warm up snapshot creation on a reusable harness and then run a second assertion command against the same snapshot-enabled environment.

*Call graph*: calls 5 internal fn (mount_sse_sequence, server, test, local_selections, turn_permission_fields); called by 2 (linux_unified_exec_snapshot_preserves_shell_environment_policy_set, shell_command_snapshot_preserves_shell_environment_policy_set); 4 external calls (default, wait_for_event, wait_for_event_match, vec!).


##### `normalize_newlines`  (lines 378–380)

```
fn normalize_newlines(text: &str) -> String
```

**Purpose**: Normalizes Windows-style CRLF line endings to LF for stable stdout assertions.

**Data flow**: Takes a text slice and returns a new `String` with every `\r\n` replaced by `\n`.

**Call relations**: Used where tests compare captured stdout text across platforms or shell implementations.

*Call graph*: called by 1 (linux_unified_exec_uses_shell_snapshot).


##### `assert_posix_snapshot_sections`  (lines 382–391)

```
fn assert_posix_snapshot_sections(snapshot: &str)
```

**Purpose**: Checks that a POSIX snapshot script contains the expected structural sections and PATH export information.

**Data flow**: Consumes the snapshot script text and asserts it contains `# Snapshot file`, `aliases `, `exports `, `setopts `, and `PATH`, with a custom failure message for missing PATH.

**Call relations**: Shared by Linux, macOS, and apply-patch snapshot tests to validate that the generated snapshot is a real shell-state capture rather than an empty stub.

*Call graph*: called by 4 (linux_shell_command_uses_shell_snapshot, linux_unified_exec_uses_shell_snapshot, macos_unified_exec_uses_shell_snapshot, shell_command_snapshot_still_intercepts_apply_patch); 1 external calls (assert!).


##### `linux_unified_exec_uses_shell_snapshot`  (lines 395–412)

```
async fn linux_unified_exec_uses_shell_snapshot() -> Result<()>
```

**Purpose**: Verifies that unified exec on Linux invokes the shell via `-lc`, creates a snapshot under Codex home, and successfully runs the command through that snapshot.

**Data flow**: Runs `echo snapshot-linux` through `run_snapshot_command`, normalizes stdout, then asserts the begin command vector is exactly `[shell, "-lc", command]`, the snapshot path is under `codex_home`, the snapshot contains expected POSIX sections, the exit code is 0, and stdout contains `snapshot-linux`.

**Call relations**: This is the primary Linux unified-exec snapshot integration test and consumes the full `SnapshotRun` returned by the helper.

*Call graph*: calls 3 internal fn (assert_posix_snapshot_sections, normalize_newlines, run_snapshot_command); 2 external calls (assert!, assert_eq!).


##### `linux_shell_command_uses_shell_snapshot`  (lines 416–432)

```
async fn linux_shell_command_uses_shell_snapshot() -> Result<()>
```

**Purpose**: Verifies that `shell_command` on non-Windows platforms also routes through a snapshot-backed shell invocation.

**Data flow**: Runs `echo shell-command-snapshot-linux` via `run_shell_command_snapshot`, then asserts the begin command uses `-lc`, the snapshot path is under `codex_home`, the snapshot contains expected POSIX sections, stdout trims to the echoed text, and exit code is 0.

**Call relations**: This is the shell-tool counterpart to the Linux unified-exec test, proving both execution paths honor shell snapshots.

*Call graph*: calls 2 internal fn (assert_posix_snapshot_sections, run_shell_command_snapshot); 2 external calls (assert!, assert_eq!).


##### `shell_command_snapshot_preserves_shell_environment_policy_set`  (lines 436–481)

```
async fn shell_command_snapshot_preserves_shell_environment_policy_set() -> Result<()>
```

**Purpose**: Checks that after sourcing a snapshot, `shell_command` still reapplies configured shell environment policy values such as PATH.

**Data flow**: Builds a snapshot-enabled harness with `shell_environment_policy.r#set = {PATH: POLICY_PATH_FOR_TEST}`, warms up snapshot creation by running a trivial `shell_command`, waits for the snapshot file, overwrites it with conflicting snapshot content from `snapshot_override_content_for_policy_test`, then runs `command_asserting_policy_after_snapshot` through `run_tool_turn_on_harness` and asserts stdout is `policy-after-snapshot`, exit code is 0, and the snapshot path remains under `codex_home`.

**Call relations**: This test uses `run_tool_turn_on_harness` twice on the same harness to prove ordering: snapshot sourcing happens, but policy-set environment variables are applied afterward.

*Call graph*: calls 6 internal fn (with_builder, test_codex, command_asserting_policy_after_snapshot, run_tool_turn_on_harness, snapshot_override_content_for_policy_test, wait_for_snapshot); 4 external calls (assert!, assert_eq!, write, json!).


##### `linux_unified_exec_snapshot_preserves_shell_environment_policy_set`  (lines 485–535)

```
async fn linux_unified_exec_snapshot_preserves_shell_environment_policy_set() -> Result<()>
```

**Purpose**: Performs the same policy-precedence verification as the previous test, but through the unified `exec_command` tool path.

**Data flow**: Builds a harness with `UnifiedExec` and `ShellSnapshot` enabled plus the PATH policy override, warms up snapshot creation with `exec_command`, overwrites the snapshot file with conflicting content, runs the assertion command through `exec_command`, and checks for `policy-after-snapshot`, exit code 0, and a snapshot path under `codex_home`.

**Call relations**: This is the unified-exec analogue of `shell_command_snapshot_preserves_shell_environment_policy_set`, ensuring both execution stacks preserve policy precedence.

*Call graph*: calls 6 internal fn (with_builder, test_codex, command_asserting_policy_after_snapshot, run_tool_turn_on_harness, snapshot_override_content_for_policy_test, wait_for_snapshot); 4 external calls (assert!, assert_eq!, write, json!).


##### `shell_command_snapshot_still_intercepts_apply_patch`  (lines 539–644)

```
async fn shell_command_snapshot_still_intercepts_apply_patch() -> Result<()>
```

**Purpose**: Verifies that enabling shell snapshots does not bypass the special `apply_patch` interception path when a shell script invokes `apply_patch`.

**Data flow**: Builds a snapshot-enabled harness, prepares a target file path, mounts a `shell_command` call whose script feeds a patch to `apply_patch`, submits a user turn with explicit thread settings, waits for the snapshot file and validates its contents, then listens through turn completion for `PatchApplyBegin` and `PatchApplyEnd` events. It asserts patch interception occurred, the patch succeeded, and the target file eventually contains `hello from snapshot\n`.

**Call relations**: This test combines snapshot creation with patch interception event monitoring, proving the snapshot-enabled shell path still routes `apply_patch` through the dedicated patch subsystem.

*Call graph*: calls 7 internal fn (mount_sse_sequence, with_builder, local_selections, test_codex, turn_permission_fields, assert_posix_snapshot_sections, wait_for_snapshot); 7 external calls (default, assert!, assert_eq!, wait_for_event, read_to_string, json!, vec!).


##### `shell_snapshot_deleted_after_shutdown_with_skills`  (lines 648–677)

```
async fn shell_snapshot_deleted_after_shutdown_with_skills() -> Result<()>
```

**Purpose**: Checks that generated snapshot files are cleaned up after Codex shutdown.

**Data flow**: Builds a snapshot-enabled harness, waits for a snapshot file under `codex_home`, asserts it exists, submits `Op::Shutdown`, waits for `ShutdownComplete`, drops the codex and harness handles, sleeps briefly, and finally asserts the snapshot path no longer exists.

**Call relations**: This is a lifecycle/cleanup test rather than an execution test; it verifies teardown behavior after the snapshot feature has been initialized.

*Call graph*: calls 3 internal fn (with_builder, test_codex, wait_for_snapshot); 5 external calls (from_millis, assert!, assert_eq!, wait_for_event, sleep).


##### `macos_unified_exec_uses_shell_snapshot`  (lines 685–710)

```
async fn macos_unified_exec_uses_shell_snapshot() -> Result<()>
```

**Purpose**: Verifies the macOS-specific unified-exec command-line shape that sources the snapshot via a shell trampoline before executing the target command.

**Data flow**: Runs `echo snapshot-macos` through `run_snapshot_command`, extracts the shell path from the begin command, and asserts the argument vector includes `-c`, the sourcing trampoline `. "$0" && exec "$@"`, the shell path repeated in the expected position, a final `-c`, and the original command. It also checks snapshot location/content, stdout, and exit code.

**Call relations**: This is the macOS-specific counterpart to the Linux unified-exec test, documenting the different invocation strategy used on that platform.

*Call graph*: calls 2 internal fn (assert_posix_snapshot_sections, run_snapshot_command); 2 external calls (assert!, assert_eq!).


##### `windows_unified_exec_uses_shell_snapshot`  (lines 715–746)

```
async fn windows_unified_exec_uses_shell_snapshot() -> Result<()>
```

**Purpose**: Verifies the Windows/PowerShell-specific unified-exec invocation shape for shell snapshots, though the test is currently ignored.

**Data flow**: Runs `Write-Output snapshot-windows` through `run_snapshot_command`, finds the snapshot argument position in the begin command vector, asserts the presence of `-NoProfile` and the PowerShell sourcing script `param($snapshot) . $snapshot; & @args`, checks snapshot placement and content markers, and verifies stdout and exit code.

**Call relations**: Although ignored, this test serves as executable documentation for the intended Windows snapshot invocation contract.

*Call graph*: calls 1 internal fn (run_snapshot_command); 2 external calls (assert!, assert_eq!).


### `core/tests/suite/tool_parallelism.rs`

`test` · `request handling`

This non-Windows suite measures concurrency behavior in the tool runner. The shared helper `run_turn` submits a normal `Op::UserInput` with explicit local environment, disabled approval, and collaboration-mode settings, then waits for `EventMsg::TurnComplete`. `run_turn_and_measure` wraps that call with an `Instant` to produce elapsed wall-clock duration, while `build_codex_with_test_tool` constructs a fixture model exposing the synthetic `test_sync_tool`. `assert_parallel_duration` encodes the timing expectation: parallel execution should finish well under 1.6 seconds.

The first three tests mount SSE responses containing two tool calls in one response and then measure total turn duration. `read_file_tools_run_in_parallel` uses a barrier-aware synthetic tool with a warmup turn to avoid one-time startup skew; `shell_tools_run_in_parallel` runs two `shell_command` calls sleeping 250 ms each; and `mixed_parallel_tools_run_in_parallel` combines one synthetic sync tool with one shell command. All three assert that elapsed time reflects overlap rather than serial execution.

`tool_results_grouped` inspects the follow-up request body after three shell calls, asserting that all `function_call` items appear before any `function_call_output` items and that outputs preserve the original call order. The final test uses a gated streaming SSE server: it releases the chunk containing tool calls before the chunk containing `response.completed`, records timestamps written by four shell commands, and proves those commands started no later than the stream-completion timestamp. This catches regressions where tool execution is incorrectly deferred until the stream fully completes.

#### Function details

##### `run_turn`  (lines 35–70)

```
async fn run_turn(test: &TestCodex, prompt: &str) -> anyhow::Result<()>
```

**Purpose**: Submits a single user turn with the thread settings needed for tool execution and waits until the turn completes. It is the common execution primitive for the timing and grouping tests.

**Data flow**: It reads the session model from `TestCodex`, derives sandbox and permission settings from the test workspace, submits `Op::UserInput` containing one `UserInput::Text` plus explicit `ThreadSettingsOverrides` with local environment selections, `AskForApproval::Never`, sandbox policy, permission profile, and collaboration mode, then waits for `EventMsg::TurnComplete` and returns `Ok(())`.

**Call relations**: This helper is called directly by `read_file_tools_run_in_parallel` and `tool_results_grouped`, and indirectly by the timing helper `run_turn_and_measure`.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 3 (read_file_tools_run_in_parallel, run_turn_and_measure, tool_results_grouped); 3 external calls (default, wait_for_event, vec!).


##### `run_turn_and_measure`  (lines 72–76)

```
async fn run_turn_and_measure(test: &TestCodex, prompt: &str) -> anyhow::Result<Duration>
```

**Purpose**: Runs a turn and returns how long it took. It is used to turn concurrency expectations into simple duration assertions.

**Data flow**: It records `Instant::now()`, awaits `run_turn(test, prompt)`, computes `start.elapsed()`, and returns the resulting `Duration`.

**Call relations**: The parallelism tests call this helper after mounting multi-tool responses so they can compare elapsed time against the parallel-execution threshold.

*Call graph*: calls 1 internal fn (run_turn); called by 3 (mixed_parallel_tools_run_in_parallel, read_file_tools_run_in_parallel, shell_tools_run_in_parallel); 1 external calls (now).


##### `build_codex_with_test_tool`  (lines 78–81)

```
async fn build_codex_with_test_tool(server: &wiremock::MockServer) -> anyhow::Result<TestCodex>
```

**Purpose**: Constructs a `TestCodex` configured with the synthetic model used by the custom synchronization tool tests. It centralizes the model choice for those scenarios.

**Data flow**: It creates a builder via `test_codex().with_model("test-gpt-5.1-codex")`, builds it against the provided mock server, and returns the resulting `TestCodex`.

**Call relations**: This helper is used by tests that rely on `test_sync_tool` being available, avoiding repeated builder setup.

*Call graph*: calls 1 internal fn (test_codex); called by 3 (mixed_parallel_tools_run_in_parallel, read_file_tools_run_in_parallel, tool_results_grouped).


##### `assert_parallel_duration`  (lines 83–89)

```
fn assert_parallel_duration(actual: Duration)
```

**Purpose**: Asserts that a measured turn duration is short enough to indicate overlapping tool execution. The threshold includes CI headroom while still rejecting obviously serial behavior.

**Data flow**: It takes a `Duration` and asserts it is less than 1600 ms, embedding the actual duration in the failure message. It has no side effects beyond assertion failure.

**Call relations**: The three timing-based parallelism tests call this after `run_turn_and_measure` to enforce the expected concurrency property.

*Call graph*: called by 3 (mixed_parallel_tools_run_in_parallel, read_file_tools_run_in_parallel, shell_tools_run_in_parallel); 1 external calls (assert!).


##### `read_file_tools_run_in_parallel`  (lines 92–151)

```
async fn read_file_tools_run_in_parallel() -> anyhow::Result<()>
```

**Purpose**: Verifies parallel execution for two synthetic synchronization-tool calls, using a warmup turn to reduce startup noise and a barrier to guarantee overlap. It proves the tool runner does not serialize same-response tool calls.

**Data flow**: It starts a mock server, builds a codex with the test tool, prepares warmup and measured JSON args containing barrier ids, participant counts, and sleep durations, mounts a four-response SSE sequence (warmup tool calls, warmup completion, measured tool calls, measured completion), runs the warmup turn, measures the second turn with `run_turn_and_measure`, and asserts the duration is below the parallel threshold.

**Call relations**: This test uses both `run_turn` and `run_turn_and_measure`; the warmup phase specifically exists to make the later timing assertion more stable.

*Call graph*: calls 7 internal fn (mount_sse_sequence, sse, start_mock_server, assert_parallel_duration, build_codex_with_test_tool, run_turn, run_turn_and_measure); 3 external calls (json!, skip_if_no_network!, vec!).


##### `shell_tools_run_in_parallel`  (lines 154–186)

```
async fn shell_tools_run_in_parallel() -> anyhow::Result<()>
```

**Purpose**: Checks that two `shell_command` tool calls in one response execute concurrently rather than one after the other. It uses short sleeps and a non-login shell to keep timing deterministic.

**Data flow**: It starts a mock server, builds a `TestCodex` with model `gpt-5.4`, serializes identical shell-command args (`sleep 0.25`, `login: false`, timeout 1000 ms), mounts a two-response SSE sequence with two `shell_command` calls followed by assistant completion, measures the turn duration with `run_turn_and_measure`, and asserts it satisfies `assert_parallel_duration`.

**Call relations**: This is the shell-specific counterpart to the synthetic-tool parallelism test, proving the real shell tool participates in the same concurrency model.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, assert_parallel_duration, run_turn_and_measure); 4 external calls (json!, to_string, skip_if_no_network!, vec!).


##### `mixed_parallel_tools_run_in_parallel`  (lines 189–222)

```
async fn mixed_parallel_tools_run_in_parallel() -> anyhow::Result<()>
```

**Purpose**: Verifies that different tool types can overlap, not just multiple instances of the same tool. It combines one synthetic sync tool and one shell command in a single response.

**Data flow**: It starts a mock server, builds a codex with the test tool, prepares JSON args for a 300 ms sync-tool sleep and a 250 ms shell sleep, mounts a two-response SSE sequence containing both tool calls and then assistant completion, measures the turn duration, and asserts it is below the parallel threshold.

**Call relations**: This test broadens the concurrency guarantee established by the previous two tests to mixed tool classes sharing the same turn.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, assert_parallel_duration, build_codex_with_test_tool, run_turn_and_measure); 4 external calls (json!, to_string, skip_if_no_network!, vec!).


##### `tool_results_grouped`  (lines 225–300)

```
async fn tool_results_grouped() -> anyhow::Result<()>
```

**Purpose**: Ensures that when multiple tool calls run in one turn, the follow-up request groups all `function_call` items before any `function_call_output` items and preserves call/output ordering by `call_id`. This validates request serialization structure independently of timing.

**Data flow**: It starts a mock server, builds a codex with the test tool, mounts one SSE response containing three `shell_command` calls and a second response for completion, runs a turn, reads the follow-up request input array, filters and indexes `function_call` and `function_call_output` items, asserts there are three of each, asserts every call index precedes every output index, then zips calls with outputs and asserts matching `call_id`s in order.

**Call relations**: Unlike the timing tests, this one inspects the exact shape of the follow-up request after tool execution to verify grouping and stable ordering semantics.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, build_codex_with_test_tool, run_turn); 6 external calls (assert!, assert_eq!, json!, to_string, skip_if_no_network!, vec!).


##### `shell_tools_start_before_response_completed_when_stream_delayed`  (lines 303–437)

```
async fn shell_tools_start_before_response_completed_when_stream_delayed() -> anyhow::Result<()>
```

**Purpose**: Proves that shell tools begin executing as soon as their call events arrive on the stream, even if the SSE stream has not yet emitted `response.completed`. It guards against implementations that wait for stream completion before dispatching tools.

**Data flow**: It creates a temp file for timestamps, formats a shell command that appends the current millisecond timestamp to that file, builds two SSE chunks for the first response (tool calls first, completion later) plus a follow-up response, gates those chunks with `oneshot` receivers via `start_streaming_sse_server`, builds a websocket-disabled `TestCodex` against that streaming server, submits a user turn with explicit thread settings, releases the first chunk and the follow-up gate, polls the temp file until four timestamps are present, then releases the completion gate and waits for `TurnComplete`. It awaits the server-side completion timestamp receiver, asserts four timestamps were recorded, and checks each timestamp is less than or equal to the recorded completion time before shutting the server down.

**Call relations**: This is the file's most transport-sensitive test: it combines gated streaming, real shell execution, and server-recorded completion timing to verify dispatch happens before `response.completed`, not after.

*Call graph*: calls 5 internal fn (sse, start_streaming_sse_server, local_selections, test_codex, turn_permission_fields); 16 external calls (default, from_millis, from_secs, assert!, assert_eq!, wait_for_event, format!, read_to_string, try_from, json! (+6 more)).


### `core/tests/suite/truncation.rs`

`test` · `request handling`

This non-Windows suite concentrates on the serialization layer that turns tool results into model-facing `function_call_output` content. The small helper `assert_wall_time_header` validates the wall-time text item used in MCP array outputs. Most tests mount a first SSE response that instructs Codex to run either `shell_command` or an MCP tool, then inspect the second request—the follow-up sent back to the model—to see exactly what output was serialized.

For shell commands, the suite distinguishes model families and configured budgets. With a very large configured `tool_output_token_limit`, output from `seq 1 100000` should remain plain text and effectively untruncated. Under default or small limits, the output must still be plain text but include a single truncation marker, either `…N chars truncated…` for byte-estimated policies or `…N tokens truncated…` for token-based policies, while preserving the standard `Exit code`, `Wall time`, and `Total output lines` headers. One test explicitly counts truncation markers to ensure truncation is applied only once.

For MCP tools, the suite configures a real stdio test server via `McpServerConfig` and waits for it to become ready. Large text outputs from an `echo` tool must be truncated without shell-specific line-count headers, while image-only outputs from an `image` tool must be serialized as a content-item array containing exactly the wall-time text item and the preserved `input_image`, with no appended truncation summary because there is no text payload to summarize. Final tests raise the token limit to prove both shell and MCP outputs can remain intact when configured budgets allow it.

#### Function details

##### `assert_wall_time_header`  (lines 34–40)

```
fn assert_wall_time_header(output: &str)
```

**Purpose**: Validates the wall-time text item used in MCP array outputs. It ensures the text consists of a `Wall time: ... seconds` line followed by an `Output:` marker on the next line.

**Data flow**: It splits the input string once on the first newline, asserts the first part matches the wall-time regex, and asserts the second part equals `Output:`. It returns no value and mutates no state.

**Call relations**: This helper is used by `mcp_image_output_preserves_image_and_no_text_summary` when validating the first content item in the serialized MCP image output array.

*Call graph*: called by 1 (mcp_image_output_preserves_image_and_no_text_summary); 2 external calls (assert_eq!, assert_regex_match).


##### `tool_call_output_configured_limit_chars_type`  (lines 45–119)

```
async fn tool_call_output_configured_limit_chars_type() -> Result<()>
```

**Purpose**: Verifies that when the configured tool-output token limit is raised very high for a byte-estimated model, a huge shell-command output is returned as plain text without any truncation marker. It confirms that the configured budget can effectively disable truncation.

**Data flow**: It starts a mock server, builds a `TestCodex` with model `gpt-5.2` and `tool_output_token_limit = Some(100000)`, mounts a shell-command call running `seq 1 100000` (or the Windows equivalent) and a completion response, submits a turn with `PermissionProfile::Disabled`, extracts the shell output text from the second request, normalizes line endings, asserts it is not valid JSON, asserts its length is roughly 400k characters, and asserts it does not contain `tokens truncated`.

**Call relations**: This test establishes the non-truncating baseline for a large configured budget before later tests check default truncation behavior.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (assert!, cfg!, json!, skip_if_no_network!, vec!).


##### `tool_call_output_exceeds_limit_truncated_chars_limit`  (lines 124–196)

```
async fn tool_call_output_exceeds_limit_truncated_chars_limit() -> Result<()>
```

**Purpose**: Checks that oversized shell-command output is truncated with a character-count marker for the byte-estimated model path. It validates both the output envelope and the approximate final size.

**Data flow**: It starts a mock server, builds a default `gpt-5.2` `TestCodex`, mounts a shell-command call producing 100000 lines and a completion response, submits a turn with disabled permissions, extracts and normalizes the shell output text, asserts it is plain text rather than JSON, regex-matches a pattern containing `Exit code`, `Wall time`, `Total output lines: 100000`, and an `…N chars truncated…` marker, then asserts the final string length is about 10k characters.

**Call relations**: This test covers the default truncation path for byte-based policies, contrasting with the previous configured-large-budget case.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (assert!, cfg!, assert_regex_match, json!, skip_if_no_network!, vec!).


##### `tool_call_output_exceeds_limit_truncated_for_model`  (lines 201–277)

```
async fn tool_call_output_exceeds_limit_truncated_for_model() -> Result<()>
```

**Purpose**: Verifies token-based truncation formatting for a model that uses token-aware limits. The output must preserve the beginning and end of the shell output with a `tokens truncated` marker in the middle.

**Data flow**: It starts a mock server, builds a `gpt-5.4` `TestCodex`, mounts a shell-command call producing 100000 lines and a completion response, submits a turn with disabled permissions, extracts and normalizes the shell output text, asserts it is plain text, and regex-matches a multiline pattern showing the standard headers, the first few numbered lines, a `…137224 tokens truncated…` marker, and the final lines `99999` and `100000`.

**Call relations**: This is the token-based counterpart to the previous char-based truncation test, proving model-specific truncation markers differ as expected.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (assert!, cfg!, assert_regex_match, json!, skip_if_no_network!, vec!).


##### `tool_call_output_truncated_only_once`  (lines 281–337)

```
async fn tool_call_output_truncated_only_once() -> Result<()>
```

**Purpose**: Ensures that shell-command output exceeding the limit is truncated exactly once, preventing nested or repeated truncation markers from appearing in the serialized result.

**Data flow**: It starts a mock server, builds a `gpt-5.4` `TestCodex`, mounts a shell-command call producing 10000 lines and a completion response, submits a turn with disabled permissions, extracts the shell output text from the second request, counts occurrences of the substring `tokens truncated`, and asserts the count is exactly 1.

**Call relations**: This test guards against double-processing bugs in the truncation pipeline after the main truncation behavior has already been validated.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (assert_eq!, cfg!, json!, skip_if_no_network!, vec!).


##### `mcp_tool_call_output_exceeds_limit_truncated_for_model`  (lines 342–441)

```
async fn mcp_tool_call_output_exceeds_limit_truncated_for_model() -> Result<()>
```

**Purpose**: Verifies that oversized MCP text-tool output is truncated before being sent back to the model, but without shell-specific line-count headers. It checks the MCP serialization path separately from shell-command output.

**Data flow**: It starts a mock server, mounts a namespaced MCP `echo` tool call with a very large repeated message and a completion response, obtains the stdio MCP test server binary, builds a `TestCodex` whose config inserts an enabled `rmcp` `McpServerConfig` using stdio transport and sets `tool_output_token_limit = Some(500)`, waits for the MCP server to be ready, submits a read-only turn, extracts the function-call output text from the second request, asserts it does not contain `Total output lines:`, regex-matches a pattern beginning with `Wall time: ...\nOutput:\n{"echo": ... tokens truncated ...}`, and asserts the serialized output length is under 2600 characters.

**Call relations**: This test validates truncation in the MCP adapter path, where tool results are structured JSON rather than shell stdout.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only); 8 external calls (assert!, assert_regex_match, stdio_server_bin, wait_for_mcp_server, format!, json!, skip_if_no_network!, vec!).


##### `mcp_image_output_preserves_image_and_no_text_summary`  (lines 446–568)

```
async fn mcp_image_output_preserves_image_and_no_text_summary() -> Result<()>
```

**Purpose**: Checks that an MCP image tool result is serialized as a content-item array preserving the image and that no truncation summary is appended when there are no text items beyond the wall-time header. It validates a non-text MCP output path.

**Data flow**: It starts a mock server, mounts a namespaced MCP `image` tool call and a completion response, obtains the stdio MCP test server binary, defines a tiny PNG data URL, builds a `TestCodex` whose config inserts an `rmcp` stdio server with `MCP_TEST_IMAGE_DATA_URL` in its environment, waits for the MCP server, derives session model and read-only sandbox settings, submits `Op::UserInput` directly with explicit thread settings and local environment selections, waits for `TurnComplete`, extracts the raw `output` field from the function-call output item, asserts it is an array of length 2, validates the first item's text with `assert_wall_time_header`, and asserts the second item equals the expected `input_image` JSON object with the original data URL and `detail: "high"`.

**Call relations**: This test covers the image-preservation branch of MCP output serialization, where truncation summaries would be inappropriate because there is no textual payload to summarize.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, assert_wall_time_header, read_only); 9 external calls (default, assert!, assert_eq!, stdio_server_bin, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, vec!).


##### `token_policy_marker_reports_tokens`  (lines 572–619)

```
async fn token_policy_marker_reports_tokens() -> Result<()>
```

**Purpose**: Ensures that under a token-based truncation policy, the truncation marker reports removed token counts rather than bytes or characters. It uses a small configured budget to force truncation.

**Data flow**: It starts a mock server, builds a `gpt-5.4` `TestCodex` with `tool_output_token_limit = Some(50)`, mounts a shell-command call running `seq 1 150` and a completion response, submits a turn with disabled permissions, extracts the shell output text, and regex-matches a pattern showing the standard headers, early numbered lines, a `tokens truncated` marker, and the preserved tail lines `129` through `150`.

**Call relations**: This test isolates the wording of the truncation marker under token-based policy, complementing the broader token-truncation test above.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (assert_regex_match, json!, skip_if_no_network!, vec!).


##### `byte_policy_marker_reports_bytes`  (lines 623–670)

```
async fn byte_policy_marker_reports_bytes() -> Result<()>
```

**Purpose**: Ensures that under a byte-estimated truncation policy, the truncation marker reports removed characters rather than tokens. It mirrors the token-policy test on a different model family.

**Data flow**: It starts a mock server, builds a `gpt-5.2` `TestCodex` with `tool_output_token_limit = Some(50)`, mounts a shell-command call running `seq 1 150` and a completion response, submits a turn with disabled permissions, extracts the shell output text, and regex-matches a pattern showing the standard headers, early numbered lines, a `chars truncated` marker, and the preserved tail lines `129` through `150`.

**Call relations**: This is the byte-policy counterpart to `token_policy_marker_reports_tokens`, proving the marker wording follows the active truncation policy.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (assert_regex_match, json!, skip_if_no_network!, vec!).


##### `shell_command_output_not_truncated_with_custom_limit`  (lines 674–730)

```
async fn shell_command_output_not_truncated_with_custom_limit() -> Result<()>
```

**Purpose**: Verifies that increasing the configured tool-output token limit prevents truncation of a moderately large shell-command result. The full numbered output should be preserved and no truncation marker should appear.

**Data flow**: It starts a mock server, builds a `gpt-5.4` `TestCodex` with `tool_output_token_limit = Some(50000)`, prepares expected output text for `seq 1 1000`, mounts a shell-command call and a completion response, submits a turn with disabled permissions, extracts the shell output text, asserts it ends with the full expected numbered body, and asserts it does not contain `truncated`.

**Call relations**: This test confirms that the truncation system respects larger configured budgets on the shell-command path.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (assert!, json!, skip_if_no_network!, vec!).


##### `mcp_tool_call_output_not_truncated_with_custom_limit`  (lines 734–830)

```
async fn mcp_tool_call_output_not_truncated_with_custom_limit() -> Result<()>
```

**Purpose**: Checks that raising the configured token limit also prevents truncation for large MCP text-tool outputs. It validates the untruncated MCP serialization length and absence of truncation markers.

**Data flow**: It starts a mock server, mounts a namespaced MCP `echo` tool call with an 80000-character message and a completion response, obtains the stdio MCP test server binary, builds a `TestCodex` whose config sets `tool_output_token_limit = Some(50000)` and inserts an enabled `rmcp` stdio server, waits for the MCP server, submits a read-only turn, extracts the function-call output text from the second request, asserts its length is exactly 80065, and asserts it does not contain `truncated`.

**Call relations**: This final test mirrors the shell no-truncation case on the MCP path, proving that custom limits apply consistently across tool transports.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only); 8 external calls (assert!, assert_eq!, stdio_server_bin, wait_for_mcp_server, format!, json!, skip_if_no_network!, vec!).


### MCP, apps, and plugins
These suites cover deferred tool discovery and invocation across MCP, apps, plugins, and extension-provided tools, including file-upload and install flows.

### `core/tests/suite/extension_sandbox.rs`

`test` · `request handling / extension execution`

This file sets up the image-generation extension in a realistic `ExtensionRegistry<Config>` and then drives it through mocked model tool calls. The helper `image_generation_extensions` converts a `CodexAuth` into an auth manager, installs the image-generation extension into an `ExtensionRegistryBuilder<Config>`, and returns the built registry wrapped in `Arc`. The first test enables image generation, disables the legacy image-gen extension feature, and configures model info so image inputs are accepted. It creates a `denied.png` file under the workspace, then submits a turn with a runtime `PermissionProfile` derived from a `FileSystemSandboxPolicy` containing a single `Deny` entry for that exact path and restricted network. When the mocked model calls the `image_gen` extension with that path, the extension output must begin with an error saying it cannot read the referenced image. The second test starts from a workspace-write permission profile, enables the request-permissions tool, and mounts a three-step SSE sequence: request permissions, call `image_gen`, then finish. It submits a turn with `ApprovalsReviewer::User`, waits for `EventMsg::RequestPermissions`, responds with a turn-scoped `RequestPermissionsResponse` echoing the requested permissions, and finally asserts that the extension output contains an `input_image` item with a base64 data URL. The key invariant is that extension file access is governed by turn environment permissions, including newly granted turn-scoped access.

#### Function details

##### `image_generation_extensions`  (lines 49–54)

```
fn image_generation_extensions(auth: &CodexAuth) -> Arc<ExtensionRegistry<Config>>
```

**Purpose**: Builds an extension registry containing the image-generation extension configured with a test auth manager. It packages the registry in `Arc` so it can be injected into `TestCodex` builders.

**Data flow**: Takes a borrowed `CodexAuth`, clones it to create an auth manager via `codex_core::test_support::auth_manager_from_auth`, initializes `ExtensionRegistryBuilder::<Config>::new()`, installs the image-generation extension into that builder, builds the registry, wraps it in `Arc`, and returns `Arc<ExtensionRegistry<Config>>`.

**Call relations**: Both tests in this file call this helper during setup so they exercise the same extension implementation with different runtime permission conditions.

*Call graph*: calls 1 internal fn (auth_manager_from_auth); called by 2 (extension_tool_receives_turn_environment_sandbox, extension_tool_uses_granted_turn_permissions); 4 external calls (new, new, install, clone).


##### `extension_tool_receives_turn_environment_sandbox`  (lines 57–139)

```
async fn extension_tool_receives_turn_environment_sandbox() -> Result<()>
```

**Purpose**: Verifies that the image-generation extension cannot read a referenced image path that the current turn’s filesystem sandbox explicitly denies. The extension should return a readable error message rather than bypassing the sandbox.

**Data flow**: After the network guard, it starts a mock server, creates dummy auth and the extension registry, configures a test instance with image-capable model info plus `Feature::ImageGeneration` enabled and `Feature::ImageGenExt` disabled, and builds it. It writes a `denied.png` file under `test.config.cwd`, mounts an SSE sequence where the model calls namespaced tool `image_gen` with that path, then constructs a `FileSystemSandboxPolicy` whose `entries` contains one `FileSystemSandboxEntry` denying that exact path. It converts that plus `NetworkSandboxPolicy::Restricted` into a runtime `PermissionProfile`, submits the turn with that profile, inspects the last recorded request, extracts the extension output text for the call id, and asserts the text starts with `unable to read referenced image at ...`.

**Call relations**: This async test is driven by the harness and uses `image_generation_extensions` during setup. The mocked SSE sequence causes the extension invocation, and the test then inspects the outbound function-call output produced after the extension runs under the supplied turn sandbox.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, image_generation_extensions, create_dummy_chatgpt_auth_for_testing, from_runtime_permissions, default); 4 external calls (assert!, skip_if_no_network!, write, vec!).


##### `extension_tool_uses_granted_turn_permissions`  (lines 142–305)

```
async fn extension_tool_uses_granted_turn_permissions() -> Result<()>
```

**Purpose**: Checks that the image-generation extension can read an image outside the workspace after the user grants turn-scoped permissions through the request-permissions flow. It validates propagation of newly granted permissions into subsequent extension execution.

**Data flow**: After network and sandbox guards, it starts a mock server and mounts a wiremock handler for `POST /v1/images/edits` returning base64 image data. It creates dummy auth and the extension registry, prepares a base workspace-write `PermissionProfile`, and configures the test instance with `AskForApproval::OnRequest`, that base profile, image-generation features, and `Feature::RequestPermissionsTool`. It writes a tiny PNG into a temporary directory outside the workspace, builds a `RequestPermissionProfile` granting read/write roots for that directory, and mounts a three-stage SSE sequence: `request_permissions`, then namespaced `image_gen` referencing the external image path, then final assistant completion. It derives `(sandbox_policy, permission_profile)` from the base profile, submits `Op::UserInput` with local environment selections, `ApprovalsReviewer::User`, and explicit collaboration mode, waits for either `RequestPermissions` or `TurnComplete`, asserts it received `EventMsg::RequestPermissions`, submits `Op::RequestPermissionsResponse` granting the requested permissions with `PermissionGrantScope::Turn`, waits for `TurnComplete`, then inspects the final function-call output and asserts the first output item is `{ type: "input_image", image_url: "data:image/png;base64,cG5n" }`.

**Call relations**: This is the more complete end-to-end test in the file: it uses `image_generation_extensions` for setup, manually participates in the runtime permission-request protocol, and verifies that the extension invocation occurring after approval sees the expanded turn permissions.

*Call graph*: calls 9 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, image_generation_extensions, create_dummy_chatgpt_auth_for_testing, from_read_write_roots, workspace_write_with); 16 external calls (default, given, new, new, default, assert_eq!, wait_for_event, json!, panic!, skip_if_no_network! (+6 more)).


### `core/tests/suite/openai_file_mcp.rs`

`test` · `tool execution, file upload, and hook invocation`

This module exercises the bridge between Codex’s local file references, the ChatGPT file-upload API, and app-tool invocation metadata. It defines a realistic upload sequence against a `wiremock::MockServer`: `POST /files` to obtain an upload URL, `PUT /upload/file_123` with the expected `content-length`, and `POST /files/file_123/uploaded` to finalize the upload and return file metadata. `uploaded_file` centralizes the JSON object shape used both in assertions and hook payload checks.

`run_extract_turn` mounts a two-step SSE exchange where the first response asks for the namespaced document-extract tool and the second returns a final assistant message. The first main test provisions a large `report.txt` in the workspace, runs the turn, and inspects both the `/responses` request and the recorded Apps server call. It asserts the tool schema exposed to the model still describes the parameter as an absolute local file path, while the actual app invocation receives the uploaded-file object plus `_meta._codex_apps` metadata containing call id, resource URI, connector id, and `contains_mcp_source`. The second test installs a Python `PostToolUse` hook fixture under `hooks.json`, trusts discovered hooks, runs the same extraction flow, and verifies the hook log contains the uploaded-file JSON under `tool_input.file`.

#### Function details

##### `write_post_tool_use_hook`  (lines 42–80)

```
fn write_post_tool_use_hook(home: &Path) -> Result<()>
```

**Purpose**: Creates a Python post-tool-use hook script and matching `hooks.json` configuration under the test home directory. The hook records each stdin payload to a JSONL log and emits additional hook-specific context on stdout.

**Data flow**: Input is the Codex home path. The function computes `post_tool_use_hook.py` and `post_tool_use_hook_log.jsonl` paths, formats a Python script string embedding the log path, builds a JSON hooks configuration targeting the document-extract matcher, writes both files with `fs::write`, and returns `Ok(())` or a contextualized error.

**Call relations**: Only the hook-propagation test uses this helper, via a pre-build hook that prepares the fixture before the session starts. It does not invoke the hook itself; it only lays down the files Codex will later discover.

*Call graph*: 4 external calls (join, format!, write, json!).


##### `read_post_tool_use_hook_inputs`  (lines 82–89)

```
fn read_post_tool_use_hook_inputs(home: &Path) -> Result<Vec<Value>>
```

**Purpose**: Reads and parses the JSONL log produced by the post-tool-use hook into a vector of `serde_json::Value`. It gives the test direct access to the exact payloads the hook observed.

**Data flow**: Input is the Codex home path. The function reads `post_tool_use_hook_log.jsonl` as a string, splits it into non-empty lines, parses each line with `serde_json::from_str`, collects the parsed values into a `Vec<Value>`, and returns that vector.

**Call relations**: The post-tool-use-hook test calls this helper after the turn completes to verify that the hook saw the uploaded-file object rather than a raw local path.

*Call graph*: called by 1 (codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook); 2 external calls (join, read_to_string).


##### `uploaded_file`  (lines 91–100)

```
fn uploaded_file(server: &MockServer, file_size_bytes: u64) -> Value
```

**Purpose**: Builds the canonical uploaded-file JSON object expected from the file-upload API and passed into the app tool call. Centralizing this shape keeps assertions consistent across tests.

**Data flow**: Inputs are the mock server and the file size in bytes. It returns a JSON object containing `download_url`, `file_id`, `mime_type`, `file_name`, `uri`, and `file_size_bytes`, with URLs derived from `server.uri()`.

**Call relations**: Both top-level tests use this helper in assertions, and the hook test compares its output directly against the logged `tool_input.file` payload.

*Call graph*: 1 external calls (json!).


##### `mount_file_upload_mocks`  (lines 102–137)

```
async fn mount_file_upload_mocks(server: &MockServer, file_size_bytes: u64)
```

**Purpose**: Installs the three HTTP mocks that emulate the ChatGPT file-upload lifecycle for a single file. It enforces request shape and count so the tests prove Codex performed the upload correctly.

**Data flow**: Inputs are the mock server and the expected file size. The function mounts a `POST /files` mock requiring the account header and JSON body with `file_name`, `file_size`, and `use_case`, a `PUT /upload/file_123` mock requiring the matching `content-length`, and a `POST /files/file_123/uploaded` mock returning finalized file metadata. It writes no return value.

**Call relations**: Both top-level tests call this helper before running the extraction turn. It supplies the upload-side plumbing that the app-tool flow depends on.

*Call graph*: called by 2 (codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook, codex_apps_file_params_upload_environment_files_before_mcp_tool_call); 7 external calls (given, new, json!, body_json, header, method, path).


##### `run_extract_turn`  (lines 139–170)

```
async fn run_extract_turn(test: &TestCodex, server: &MockServer) -> Result<ResponseMock>
```

**Purpose**: Runs a standard two-request extraction scenario in which the model first calls the namespaced document-extract tool and then receives a final assistant completion. It returns the response mock so callers can inspect the outgoing `/responses` requests.

**Data flow**: Inputs are a `TestCodex` and the mock server. The function mounts an SSE sequence whose first response emits `ev_function_call_with_namespace("extract-call-1", DOCUMENT_EXTRACT_NAMESPACE, DOCUMENT_EXTRACT_TOOL, {"file":"report.txt"})` and whose second response emits `done`, then submits a turn with approval `Never` and `PermissionProfile::Disabled`. It returns the `ResponseMock` capturing the `/responses` traffic.

**Call relations**: Both top-level tests delegate the common model/tool exchange to this helper. It isolates the repeated SSE setup and turn submission from the file-upload and hook assertions.

*Call graph*: calls 2 internal fn (mount_sse_sequence, submit_turn_with_approval_and_permission_profile); called by 2 (codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook, codex_apps_file_params_upload_environment_files_before_mcp_tool_call); 1 external calls (vec!).


##### `codex_apps_file_params_upload_environment_files_before_mcp_tool_call`  (lines 173–227)

```
async fn codex_apps_file_params_upload_environment_files_before_mcp_tool_call() -> Result<()>
```

**Purpose**: Verifies the end-to-end path where a large local workspace file is uploaded before invoking an MCP-backed app tool. It checks both the tool schema shown to the model and the transformed file argument sent to the Apps server.

**Data flow**: The test starts the mock server, mounts an `AppsTestServer`, installs upload mocks for a 13 MiB file, and builds an apps-enabled session whose workspace setup writes `report.txt`. After `run_extract_turn`, it inspects the first `/responses` request to find the namespaced extract tool and asserts its `parameters.properties.file` description still says the model should provide an absolute local file path. It then fetches the recorded Apps tool call and asserts `/params/arguments/file` equals `uploaded_file(...)` and `/params/_meta/_codex_apps` contains the expected call id, resource URI, connector id, and MCP-source flag.

**Call relations**: This is the main integration test for file upload before app invocation. It depends on `mount_file_upload_mocks` for the upload API and `run_extract_turn` for the model/tool exchange.

*Call graph*: calls 6 internal fn (mount, apps_enabled_builder, recorded_apps_tool_call_by_name, start_mock_server, mount_file_upload_mocks, run_extract_turn); 2 external calls (assert_eq!, format!).


##### `codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook`  (lines 230–257)

```
async fn codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook() -> Result<()>
```

**Purpose**: Ensures that post-tool-use hooks receive the uploaded-file object in `tool_input.file`, not the original local filename. This validates that hooks observe the same transformed payload sent to the app tool.

**Data flow**: The test starts the mock server and Apps server, mounts upload mocks for an 11-byte file, builds an apps-enabled session with a pre-build hook that writes the Python hook fixture and config that trusts discovered hooks, writes `report.txt` into the cwd, and runs the extraction turn. It then reads the hook log via `read_post_tool_use_hook_inputs`, asserts exactly one payload was recorded, and compares `hook_inputs[0]["tool_input"]["file"]` against `uploaded_file(&server, 11)`.

**Call relations**: This test combines `write_post_tool_use_hook`, `mount_file_upload_mocks`, `run_extract_turn`, and `read_post_tool_use_hook_inputs` to validate the hook-observation side of the same upload transformation exercised by the previous test.

*Call graph*: calls 6 internal fn (mount, apps_enabled_builder, start_mock_server, mount_file_upload_mocks, read_post_tool_use_hook_inputs, run_extract_turn); 2 external calls (assert_eq!, write).


### `core/tests/suite/plugins.rs`

`test` · `plugin discovery, prompt assembly, and analytics regression coverage`

This Unix-only test module synthesizes plugin installations directly under a temporary Codex home and then inspects the resulting developer prompt sections, tool lists, and analytics traffic. The fixture helpers create a canonical plugin root under `plugins/cache/test/sample/local`, write `.codex-plugin/plugin.json`, and update `config.toml` to enable the `plugins` feature and the specific plugin entry `sample@test`. Additional helpers add one of three plugin surfaces: a skill (`skills/sample-search/SKILL.md`), an MCP declaration (`.mcp.json` with a command and startup timeout), or an app declaration (`.app.json` mapping a plugin app name to connector id `calendar`).

Two builder helpers create `TestCodex` instances with ChatGPT auth and optional Apps feature enabled; one also points analytics traffic back at the mock server. `tool_names` extracts tool identifiers from a captured request body so tests can reason about visible tools independent of exact JSON shape.

The tests cover prompt composition and auth-sensitive surface selection. One test verifies the developer message orders capability sections as Apps, then Skills, then Plugins, and that plugin skills are namespaced (`sample:sample-search`) rather than described as plain plugins. For explicit plugin mentions, ChatGPT auth prefers app tools over conflicting MCP tools when both surfaces share the same plugin-facing name, but preserves MCP tools when the app name is non-conflicting. API-key auth does the opposite: MCP remains visible and app tools are suppressed. The final test polls analytics requests until it finds a `codex_plugin_used` event and asserts detailed event parameters such as plugin id/name, marketplace name, skill presence, MCP counts, connector ids, client id, model slug, and generated thread/turn ids.

#### Function details

##### `sample_plugin_root`  (lines 33–35)

```
fn sample_plugin_root(home: &TempDir) -> std::path::PathBuf
```

**Purpose**: Computes the canonical filesystem location used by these tests for the sample plugin installation. It centralizes the plugin cache path layout.

**Data flow**: Takes a `TempDir` reference and returns `home.path().join("plugins/cache/test/sample/local")` as a `PathBuf`. It performs no I/O itself.

**Call relations**: Used only by `write_sample_plugin_manifest_and_config`, which builds all plugin fixtures under this shared root.

*Call graph*: called by 1 (write_sample_plugin_manifest_and_config); 1 external calls (path).


##### `write_sample_plugin_manifest_and_config`  (lines 37–55)

```
fn write_sample_plugin_manifest_and_config(home: &TempDir) -> std::path::PathBuf
```

**Purpose**: Creates the base plugin installation: manifest directory, plugin manifest JSON, and a `config.toml` that enables the plugin feature and the sample plugin entry. It is the common setup step for all plugin-surface fixtures.

**Data flow**: Computes the plugin root with `sample_plugin_root`, creates `.codex-plugin`, writes `.codex-plugin/plugin.json` containing the sample display name and description, writes `config.toml` enabling `[features].plugins = true` and `[plugins."sample@test"].enabled = true`, and returns the plugin root path.

**Call relations**: Called by the skill, MCP, and app fixture writers before they add their surface-specific files. It establishes the plugin metadata that later prompt rendering and analytics rely on.

*Call graph*: calls 1 internal fn (sample_plugin_root); called by 3 (write_plugin_app_plugin_with_name, write_plugin_mcp_plugin, write_plugin_skill_plugin); 4 external calls (path, format!, create_dir_all, write).


##### `write_plugin_skill_plugin`  (lines 57–67)

```
fn write_plugin_skill_plugin(home: &TempDir) -> std::path::PathBuf
```

**Purpose**: Adds a skill surface to the sample plugin by writing a `SKILL.md` file with frontmatter description. It returns the path to the created skill file.

**Data flow**: Calls `write_sample_plugin_manifest_and_config`, creates `skills/sample-search`, writes `SKILL.md` containing a description and body, and returns `skill_dir.join("SKILL.md")`.

**Call relations**: Used by tests that need plugin skills to appear in developer guidance or analytics. It layers on top of the base plugin manifest/config helper.

*Call graph*: calls 1 internal fn (write_sample_plugin_manifest_and_config); called by 5 (capability_sections_render_in_developer_message_in_order, explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, explicit_plugin_mentions_track_plugin_used_analytics, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins, explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins); 2 external calls (create_dir_all, write).


##### `write_plugin_mcp_plugin`  (lines 69–86)

```
fn write_plugin_mcp_plugin(home: &TempDir, command: &str)
```

**Purpose**: Adds an MCP surface to the sample plugin by writing `.mcp.json` with one server named `sample`. The command is supplied by the caller so tests can point at the stdio test server binary.

**Data flow**: Calls `write_sample_plugin_manifest_and_config`, formats a JSON document under `mcpServers.sample` with the provided command, cwd `.`, and `startup_timeout_sec = 60.0`, and writes it to `.mcp.json`.

**Call relations**: Used by the dual-surface plugin tests that compare MCP visibility against app visibility under different auth modes.

*Call graph*: calls 1 internal fn (write_sample_plugin_manifest_and_config); called by 3 (explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins, explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins); 2 external calls (format!, write).


##### `write_plugin_app_plugin`  (lines 88–90)

```
fn write_plugin_app_plugin(home: &TempDir)
```

**Purpose**: Adds an app surface to the sample plugin using the default app name `sample`. It is a convenience wrapper for the named variant.

**Data flow**: Accepts a `TempDir` and delegates directly to `write_plugin_app_plugin_with_name(home, "sample")`. It returns no value.

**Call relations**: Called by tests that want the plugin app name to conflict with the plugin mention name, which is important for ChatGPT-auth surface selection.

*Call graph*: calls 1 internal fn (write_plugin_app_plugin_with_name); called by 3 (capability_sections_render_in_developer_message_in_order, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins, explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins).


##### `write_plugin_app_plugin_with_name`  (lines 92–107)

```
fn write_plugin_app_plugin_with_name(home: &TempDir, app_name: &str)
```

**Purpose**: Adds an app surface to the sample plugin with a caller-chosen app name. This lets tests create either conflicting or non-conflicting app declarations.

**Data flow**: Calls `write_sample_plugin_manifest_and_config`, formats `.app.json` with one app entry whose key is `app_name` and whose connector id is `calendar`, and writes the file.

**Call relations**: Used directly by the non-conflicting app-name test and indirectly by `write_plugin_app_plugin`. It controls whether app and MCP surfaces collide on the same plugin-facing name.

*Call graph*: calls 1 internal fn (write_sample_plugin_manifest_and_config); called by 2 (explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, write_plugin_app_plugin); 2 external calls (format!, write).


##### `build_analytics_plugin_test_codex`  (lines 109–125)

```
async fn build_analytics_plugin_test_codex(
    server: &MockServer,
    codex_home: Arc<TempDir>,
) -> Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` configured for plugin analytics assertions, using ChatGPT auth and a fixed model while routing ChatGPT base URL to the mock server. It returns a ready-to-use conversation harness.

**Data flow**: Accepts the mock `MockServer` and shared temp home, derives `chatgpt_base_url = server.uri()`, configures a `test_codex()` builder with that home, dummy ChatGPT auth, model `gpt-5.2`, and the base URL override, then builds against the server and returns the resulting `TestCodex`.

**Call relations**: Only the analytics test calls this helper. It encapsulates the auth and base-URL wiring needed for analytics requests to hit the mock server.

*Call graph*: calls 2 internal fn (test_codex, create_dummy_chatgpt_auth_for_testing); called by 1 (explicit_plugin_mentions_track_plugin_used_analytics); 1 external calls (uri).


##### `build_apps_enabled_plugin_test_codex`  (lines 127–146)

```
async fn build_apps_enabled_plugin_test_codex(
    server: &MockServer,
    codex_home: Arc<TempDir>,
    chatgpt_base_url: String,
) -> Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` with Apps feature enabled and ChatGPT auth, suitable for tests that expect plugin app tools to be available. It also injects the ChatGPT base URL used by the apps test server.

**Data flow**: Accepts the mock server, shared temp home, and `chatgpt_base_url`, configures a `test_codex()` builder with that home, dummy ChatGPT auth, enables `Feature::Apps`, sets `config.chatgpt_base_url`, builds against the server, and returns the `TestCodex`.

**Call relations**: Used by the capability-order test and the ChatGPT-auth dual-surface tests. It centralizes the setup required for app connectors to be visible.

*Call graph*: calls 2 internal fn (test_codex, create_dummy_chatgpt_auth_for_testing); called by 3 (capability_sections_render_in_developer_message_in_order, explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins).


##### `tool_names`  (lines 148–163)

```
fn tool_names(body: &serde_json::Value) -> Vec<String>
```

**Purpose**: Extracts the visible tool names from a request JSON body regardless of whether a tool is represented by `name` or `type`. It simplifies assertions about which plugin surfaces became active.

**Data flow**: Reads `body["tools"]` as an array if present, iterates each tool object, takes `tool["name"]` or falls back to `tool["type"]`, converts found strings to owned `String`s, and returns them as `Vec<String>`. If the tools array is absent, it returns an empty vector.

**Call relations**: Called by the auth/surface-selection tests after they capture a request body. It abstracts away the exact tool JSON schema so those tests can focus on presence or absence.

*Call graph*: called by 3 (explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins, explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins); 1 external calls (get).


##### `capability_sections_render_in_developer_message_in_order`  (lines 166–233)

```
async fn capability_sections_render_in_developer_message_in_order() -> Result<()>
```

**Purpose**: Verifies that when plugin apps and skills are available, the developer message renders capability sections in the order Apps → Skills → Plugins and uses namespaced skill summaries. It also checks that plain plugin descriptions are not redundantly listed.

**Data flow**: Starts a mock server and mounted apps test server, mounts one SSE response, creates a temp home with both a plugin skill and plugin app, builds an apps-enabled `TestCodex`, submits a simple text turn, waits for `TurnComplete`, then joins developer messages from the captured request and checks section positions and expected/forbidden substrings.

**Call relations**: This direct test uses the app-enabled builder plus the skill/app fixture writers. It validates prompt rendering rather than tool visibility.

*Call graph*: calls 7 internal fn (mount_with_connector_name, mount_sse_once, sse, start_mock_server, build_apps_enabled_plugin_test_codex, write_plugin_app_plugin, write_plugin_skill_plugin); 8 external calls (clone, new, default, new, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins`  (lines 236–323)

```
async fn explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins() -> Result<()>
```

**Purpose**: Checks that under ChatGPT auth, explicitly mentioning a plugin that exposes both MCP and app surfaces prefers the app surface when the names conflict. MCP guidance and MCP tools from that plugin should be suppressed for the turn.

**Data flow**: Starts mock and apps servers, mounts one SSE response, creates a temp home with skill, MCP, and app surfaces, builds an apps-enabled ChatGPT-auth `TestCodex`, waits for the codex apps MCP server, submits a `UserInput::Mention` targeting `plugin://sample@test`, waits for completion, then inspects developer messages and request tools. It asserts skills guidance is present, MCP guidance is absent, app guidance is present, the Google Calendar app tool is visible, the plugin MCP echo tool is absent, and the app tool description includes plugin provenance.

**Call relations**: Invoked directly by the test runner. It combines plugin fixture setup, MCP-server readiness, explicit plugin mention submission, and `tool_names` inspection to validate ChatGPT-auth conflict resolution.

*Call graph*: calls 9 internal fn (mount_with_connector_name, mount_sse_once, sse, start_mock_server, build_apps_enabled_plugin_test_codex, tool_names, write_plugin_app_plugin, write_plugin_mcp_plugin, write_plugin_skill_plugin); 11 external calls (clone, new, default, new, assert!, stdio_server_bin, wait_for_event, wait_for_mcp_server, eprintln!, skip_if_no_network! (+1 more)).


##### `explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth`  (lines 326–403)

```
async fn explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth() -> Result<()>
```

**Purpose**: Verifies that ChatGPT auth suppresses plugin MCP only when it conflicts with an app surface; if the app uses a different name, both MCP and app surfaces remain visible. It checks the non-conflicting branch of the same policy.

**Data flow**: Starts mock and apps servers, mounts one SSE response, creates a temp home with skill, MCP, and an app named `sample_app`, builds an apps-enabled ChatGPT-auth `TestCodex`, waits for the plugin MCP server `sample`, submits a plugin mention, waits for completion, and inspects developer messages and tools. It asserts both MCP and app guidance are present, the Google Calendar app tool is visible, and the plugin MCP echo tool remains present with plugin provenance in its description.

**Call relations**: This direct test mirrors the previous one but uses `write_plugin_app_plugin_with_name` to avoid a naming collision. It proves the suppression logic is selective rather than blanket.

*Call graph*: calls 9 internal fn (mount_with_connector_name, mount_sse_once, sse, start_mock_server, build_apps_enabled_plugin_test_codex, tool_names, write_plugin_app_plugin_with_name, write_plugin_mcp_plugin, write_plugin_skill_plugin); 11 external calls (clone, new, default, new, assert!, stdio_server_bin, wait_for_event, wait_for_mcp_server, eprintln!, skip_if_no_network! (+1 more)).


##### `explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins`  (lines 406–498)

```
async fn explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins() -> Result<()>
```

**Purpose**: Checks that under API-key auth, explicit plugin mentions expose MCP surfaces and suppress app surfaces for dual-surface plugins. This is the auth-mode inverse of the ChatGPT-auth behavior.

**Data flow**: Starts a mock server and one SSE response, creates a temp home with skill, MCP, and app surfaces, builds a `TestCodex` manually with API-key auth and Apps feature enabled, waits for the plugin MCP server `sample`, submits a plugin mention, waits for completion, then inspects developer messages and tools. It asserts skills and MCP guidance are present, app guidance is absent, the Google Calendar app tool is absent, and the plugin MCP echo tool is present with plugin provenance.

**Call relations**: Called directly by the test runner. It uses the same fixture pattern as the ChatGPT-auth dual-surface test but changes auth setup to validate the alternate surface-selection policy.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_names, write_plugin_app_plugin, write_plugin_mcp_plugin, write_plugin_skill_plugin, from_api_key); 11 external calls (clone, new, default, new, assert!, stdio_server_bin, wait_for_event, wait_for_mcp_server, eprintln!, skip_if_no_network! (+1 more)).


##### `explicit_plugin_mentions_track_plugin_used_analytics`  (lines 501–576)

```
async fn explicit_plugin_mentions_track_plugin_used_analytics() -> Result<()>
```

**Purpose**: Verifies that explicitly mentioning a plugin emits a `codex_plugin_used` analytics event with detailed plugin metadata and turn identifiers. It ensures plugin usage is observable beyond prompt/tool behavior.

**Data flow**: Starts a mock server and one SSE response, creates a temp home with a plugin skill, builds an analytics-configured `TestCodex`, submits a plugin mention, waits for turn completion, then polls `server.received_requests()` until it finds a POST to `/codex/analytics-events/events` containing an event whose `event_type` is `codex_plugin_used`. It asserts event parameters including plugin id/name, marketplace name, `has_skills`, MCP counts and names, connector ids, product client id, model slug, and presence of thread and turn ids.

**Call relations**: This direct test uses `build_analytics_plugin_test_codex` so analytics traffic is routed to the mock server. Unlike the other tests, its main verification target is the side-channel analytics request rather than the model prompt.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, build_analytics_plugin_test_codex, write_plugin_skill_plugin); 14 external calls (clone, new, default, from_millis, from_secs, now, new, assert!, assert_eq!, wait_for_event (+4 more)).


### `core/tests/suite/request_plugin_install.rs`

`test` · `integration test execution for tool-list construction during request building`

This module contains one focused integration test around apps/plugin discovery. It defines small JSON-inspection helpers: `tool_names` extracts the names or types of tools from a captured Responses API request body, and `function_tool_description` finds the description string for a named function tool. The configuration helper `configure_apps_without_search_tool` mutates a `codex_core::config::Config` to enable `Apps`, `Plugins`, and `ToolSuggest`, points `chatgpt_base_url` at the mounted apps test server, selects model `gpt-5.4`, injects a discoverable Gmail connector id, and rewrites the bundled model catalog so the chosen model reports `supports_search_tool = false`.

The single test mounts both the generic mock server and an `AppsTestServer`, then builds a `TestCodex` with dummy ChatGPT auth and the modified config. It submits a turn with approvals disabled and `PermissionProfile::Disabled`, captures the outbound request body, and inspects the advertised tool list. The assertions are intentionally specific: `tool_search` must be absent, while `list_available_plugins_to_install` and `request_plugin_install` must both be present. It then checks the generated descriptions for those tools, ensuring they mention the exact fallback conditions and sequencing rules expected by the product design—for example, that `request_plugin_install` should only be called after `list_available_plugins_to_install` returns an exact match, and that it must not be called in parallel with other tools. The test also confirms internal discoverable ids and stale search-tool wording are not leaked into the prompt-visible descriptions.

#### Function details

##### `tool_names`  (lines 29–44)

```
fn tool_names(body: &Value) -> Vec<String>
```

**Purpose**: Extracts the list of tool identifiers from a captured request body. It accepts either `name` or `type` fields so it works across different tool encodings.

**Data flow**: Reads `body["tools"]` as an array, iterates each tool object, pulls `tool["name"]` or falls back to `tool["type"]`, converts present strings into owned `String`s, collects them into a `Vec<String>`, and returns an empty vector if the tools array is missing.

**Call relations**: The main plugin-install test uses this helper to assert which tools are exposed to the model.

*Call graph*: called by 1 (request_plugin_install_is_available_without_search_tool_after_discovery_attempts); 1 external calls (get).


##### `function_tool_description`  (lines 46–60)

```
fn function_tool_description(body: &Value, name: &str) -> Option<String>
```

**Purpose**: Finds the description text for a named function tool in the captured request body. It is used to validate prompt-visible guidance text, not just tool presence.

**Data flow**: Reads `body["tools"]` as an array, scans for the first tool whose `name` equals the requested name, then returns its `description` as `Option<String>`.

**Call relations**: The main test calls this helper twice to inspect the descriptions of `list_available_plugins_to_install` and `request_plugin_install`.

*Call graph*: called by 1 (request_plugin_install_is_available_without_search_tool_after_discovery_attempts); 1 external calls (get).


##### `configure_apps_without_search_tool`  (lines 62–89)

```
fn configure_apps_without_search_tool(config: &mut Config, apps_base_url: &str)
```

**Purpose**: Mutates a test `Config` so apps/plugin discovery is enabled while the selected model explicitly lacks search-tool support. This creates the exact precondition under which plugin-install tools should still be offered.

**Data flow**: Enables `Feature::Apps`, `Feature::Plugins`, and `Feature::ToolSuggest`; parses the bundled model catalog; finds the `gpt-5.4` model entry and sets `supports_search_tool = false`; sets `chatgpt_base_url`, `model`, and `tool_suggest.discoverables` to include the Gmail connector id; and stores the modified catalog back into `config.model_catalog`.

**Call relations**: Used only by the top-level test as a configuration closure passed into the `test_codex` builder.

*Call graph*: 2 external calls (bundled_models_response, vec!).


##### `request_plugin_install_is_available_without_search_tool_after_discovery_attempts`  (lines 92–164)

```
async fn request_plugin_install_is_available_without_search_tool_after_discovery_attempts() -> Result<()>
```

**Purpose**: Verifies that when apps/plugin features are enabled but the selected model does not support `tool_search`, the request still exposes plugin-install tools with the correct fallback-oriented descriptions.

**Data flow**: Starts a mock server, mounts an `AppsTestServer`, mounts a simple SSE completion, builds a `TestCodex` with dummy ChatGPT auth and `configure_apps_without_search_tool`, submits a turn with `AskForApproval::Never` and `PermissionProfile::Disabled`, captures the outbound request body, extracts tool names, asserts `tool_search` is absent and both plugin-install tools are present, then inspects each tool description and asserts required guidance text is present while internal ids and stale wording are absent.

**Call relations**: This is the sole scenario in the file and uses all three local helpers to inspect the generated request payload in detail.

*Call graph*: calls 8 internal fn (mount, mount_sse_once, sse, start_mock_server, test_codex, function_tool_description, tool_names, create_dummy_chatgpt_auth_for_testing); 3 external calls (assert!, skip_if_no_network!, vec!).


### `core/tests/suite/search_tool.rs`

`test` · `request handling tests / end-to-end conversation turn validation`

This is a test file for a feature that keeps the model's tool list small and focused. Instead of dumping many app tools, server tools, or dynamic tools into the model's prompt at the start, the system can offer one discovery tool called `tool_search`. The model uses that to ask, in effect, "what tools match this task?"

Why this matters: if too many tools are shown all at once, the model gets noisy instructions and may choose the wrong tool. But if tools are hidden too aggressively, useful actions become impossible. These tests check that the balance is right.

The file sets up fake servers and fake streaming model responses, then runs full conversation turns through the system. It checks several important behaviors: `tool_search` is present by default; app tools can be hidden behind search; some tools are never exposed directly; search results can still be called afterward without re-injecting the full tool list; dynamic tools and MCP tools (tools from external tool servers) also work through search; disabled tools stay unsearchable; and real execution errors are passed back to the model instead of being swallowed.

A good mental model is a library help desk: instead of entering a room with every book piled on a table, you first ask the desk what exists, then request the exact book you need.

#### Function details

##### `tool_names`  (lines 66–81)

```
fn tool_names(body: &Value) -> Vec<String>
```

**Purpose**: This helper pulls out the names of tools from a request body so tests can quickly see what the model was told it could use. It exists to make the tests read like simple questions such as "was `tool_search` present?" or "was the calendar tool hidden?"

**Data flow**: It takes a JSON request body, looks inside its `tools` list, and for each tool reads either its `name` or `type`. It turns those found text values into a plain list of strings, or returns an empty list if the request has no tools section.

**Call relations**: Many of the tests call this right after capturing an outgoing request to the mock model server. Those tests then compare the extracted names against what should or should not be visible at that point in the conversation.

*Call graph*: called by 9 (always_defer_feature_hides_small_app_tool_sets, app_search_sources_are_hidden_for_api_key_auth, explicit_app_mentions_respect_always_defer, search_tool_hides_apps_tools_without_search, tool_search_indexes_only_enabled_non_app_mcp_tools, tool_search_returns_deferred_dynamic_tool_and_routes_follow_up_call, tool_search_returns_deferred_tools_without_follow_up_tool_injection, tool_search_returns_deferred_v1_multi_agent_tools, tool_search_surfaced_mcp_tool_errors_are_returned_to_model); 1 external calls (get).


##### `tool_search_description`  (lines 83–97)

```
fn tool_search_description(body: &Value) -> Option<String>
```

**Purpose**: This helper finds the human-readable description attached to the special `tool_search` tool. Tests use it to verify that the discovery instructions shown to the model are correct and that hidden sources are not mentioned when they should stay invisible.

**Data flow**: It reads the JSON request body, scans the `tools` list for the item whose `type` is `tool_search`, and then pulls out that item's `description` text. If no such tool or description exists, it returns nothing.

**Call relations**: The tests that care about wording call this after the initial request is sent. They use the returned text to check whether search guidance includes the right sources and omits old or forbidden instructions.

*Call graph*: called by 2 (app_search_sources_are_hidden_for_api_key_auth, search_tool_adds_discovery_instructions_to_tool_description); 1 external calls (get).


##### `tool_search_output_item`  (lines 99–101)

```
fn tool_search_output_item(request: &ResponsesRequest, call_id: &str) -> Value
```

**Purpose**: This helper fetches the recorded output payload for one specific `tool_search` call. It gives tests a direct way to inspect what search results were returned for a given call ID.

**Data flow**: It takes a captured request plus a search call ID, asks the request for the stored `tool_search` output matching that ID, and returns that JSON payload. It does not reshape the data; it simply retrieves the exact output item.

**Call relations**: Other helpers and deeper end-to-end tests use this as the starting point when they need to inspect search results. It sits between the raw captured request and more specific checks like listing tools or finding a namespace child.

*Call graph*: calls 1 internal fn (tool_search_output); called by 3 (tool_search_output_tools, tool_search_returns_deferred_tools_without_follow_up_tool_injection, tool_search_returns_deferred_v1_multi_agent_tools).


##### `tool_search_output_tools`  (lines 103–109)

```
fn tool_search_output_tools(request: &ResponsesRequest, call_id: &str) -> Vec<Value>
```

**Purpose**: This helper extracts just the returned tool list from a `tool_search` result. Tests use it when they care about which tools search surfaced, not the rest of the output wrapper.

**Data flow**: It first gets the full `tool_search` output item for a call ID, then reads that item's `tools` array. If present, it clones and returns the array; otherwise it gives back an empty list.

**Call relations**: Several tests call this after a search step has completed to verify that the right deferred tools were returned. It builds on `tool_search_output_item` so each test can focus on expected content rather than JSON plumbing.

*Call graph*: calls 1 internal fn (tool_search_output_item); called by 5 (tool_search_indexes_only_enabled_non_app_mcp_tools, tool_search_returns_deferred_dynamic_tool_and_routes_follow_up_call, tool_search_returns_deferred_tools_without_follow_up_tool_injection, tool_search_returns_deferred_v1_multi_agent_tools, tool_search_uses_non_app_mcp_server_instructions_as_namespace_description).


##### `tool_search_output_has_namespace_child`  (lines 111–121)

```
fn tool_search_output_has_namespace_child(
    request: &ResponsesRequest,
    call_id: &str,
    namespace: &str,
    tool_name: &str,
) -> bool
```

**Purpose**: This helper answers a yes-or-no question: did a search result include a particular tool inside a particular namespace? A namespace here means a grouped tool area, like a folder containing related tools.

**Data flow**: It takes a request, a search call ID, a namespace name, and a child tool name. It wraps the extracted search-result tools into the shape expected by the namespace lookup helper, asks whether that child exists there, and returns true or false.

**Call relations**: The search-matching tests use this for concise assertions like "did query X surface tool Y inside namespace Z?" It is a small convenience layer over `tool_search_output_tools` plus the shared namespace lookup helper.

*Call graph*: calls 1 internal fn (namespace_child_tool); 1 external calls (json!).


##### `search_tool_enabled_by_default_adds_tool_search`  (lines 124–179)

```
async fn search_tool_enabled_by_default_adds_tool_search() -> Result<()>
```

**Purpose**: This test proves that a normal search-capable setup automatically advertises the `tool_search` tool. Without that, the whole deferred-discovery design would fail because the model would have no way to ask what hidden tools exist.

**Data flow**: It starts a mock model server and a searchable apps test server, runs one simple user turn, captures the outgoing request, and finds the `tool_search` declaration inside the tools list. It then checks that the declaration includes the expected execution mode, description, and input schema for `query` and `limit`.

**Call relations**: This acts like a baseline test for the whole file. The later tests build on the assumption established here: when deferred search is active, the model should first receive `tool_search` as its entry point into hidden tools.

*Call graph*: calls 5 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_once, sse, start_mock_server); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `always_defer_feature_hides_small_app_tool_sets`  (lines 182–225)

```
async fn always_defer_feature_hides_small_app_tool_sets() -> Result<()>
```

**Purpose**: This test checks a feature flag that says app tools should always stay behind `tool_search`, even if there are only a few of them. It matters because otherwise small tool sets might leak directly into the prompt and defeat the simpler discovery flow.

**Data flow**: It enables the always-defer feature, runs a turn, captures the initial request, and extracts the advertised tool names. Then it verifies that `tool_search` is present and that direct MCP-style tool names are absent.

**Call relations**: This test focuses on one configuration switch and how it changes the first request. It uses `tool_names` to summarize what the model saw and confirms the system chose search-based discovery over direct exposure.

*Call graph*: calls 6 internal fn (mount, search_capable_apps_builder, mount_sse_once, sse, start_mock_server, tool_names); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `app_only_tools_are_not_visible_or_runnable_by_direct_model_calls`  (lines 228–299)

```
async fn app_only_tools_are_not_visible_or_runnable_by_direct_model_calls() -> Result<()>
```

**Purpose**: This test protects a security and product boundary: some app tools are marked app-only, meaning the model should neither see them directly nor be able to force a call to them anyway. Without this check, a hidden tool might still be reachable by guessing its name.

**Data flow**: It sets up an app server with a tool that should be app-only, scripts the mock model to try calling that hidden tool directly, and runs the turn. It then checks that the visible sibling tool was declared, the app-only tool was not declared, the forced call came back as unsupported, and no real app-server call was made.

**Call relations**: This is one of the stronger negative-path tests in the file. It validates both halves of the rule: the tool must not be shown up front, and the dispatcher must still refuse it if the model tries to invoke it by name.

*Call graph*: calls 4 internal fn (mount_with_app_only_tool, apps_enabled_builder, mount_sse_sequence, start_mock_server); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `app_search_sources_are_hidden_for_api_key_auth`  (lines 302–344)

```
async fn app_search_sources_are_hidden_for_api_key_auth() -> Result<()>
```

**Purpose**: This test verifies that when the user is authenticated only by API key, app-backed search sources are hidden. That matters because some tool ecosystems are available only for richer login contexts, and the prompt should not promise capabilities the user cannot actually use.

**Data flow**: It builds a test client using API-key authentication, configures search-capable apps, runs a turn, and captures the request. Then it checks that app namespaces are missing from the visible tools and that the `tool_search` description does not mention the Calendar source.

**Call relations**: This test combines visibility checks on both structure and wording. It uses `tool_names` and `tool_search_description` together to ensure the model is not exposed to unavailable app features in either machine-readable or human-readable form.

*Call graph*: calls 8 internal fn (mount, mount_sse_once, sse, start_mock_server, test_codex, tool_names, tool_search_description, from_api_key); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `search_tool_adds_discovery_instructions_to_tool_description`  (lines 347–386)

```
async fn search_tool_adds_discovery_instructions_to_tool_description() -> Result<()>
```

**Purpose**: This test checks that the `tool_search` description teaches the model how tool discovery now works. The description is important because the model relies on prompt text to know it should search for deferred tools instead of assuming all tools are already listed.

**Data flow**: It runs a searchable setup, captures the initial request, extracts the `tool_search` description text, and checks for expected phrases about available sources. It also confirms that old wording about session-long client-side persistence is no longer present.

**Call relations**: This is a prompt-quality test rather than an execution test. It supports the broader search workflow by ensuring the model receives the right plain-language instructions at the moment `tool_search` is introduced.

*Call graph*: calls 6 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_once, sse, start_mock_server, tool_search_description); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `search_tool_hides_apps_tools_without_search`  (lines 389–422)

```
async fn search_tool_hides_apps_tools_without_search() -> Result<()>
```

**Purpose**: This test verifies the core hiding behavior: before the model performs a search, app tools should stay out of the initial tool list. That keeps the prompt smaller and forces discovery through the intended path.

**Data flow**: It starts a searchable app setup, sends a simple user message, captures the first request, and collects tool names. It then checks that `tool_search` appears while the direct calendar tools and their namespace do not.

**Call relations**: This is one of the clearest statement tests for the feature's main contract. Other tests examine what happens after search; this one confirms the initial state before any discovery has occurred.

*Call graph*: calls 6 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_once, sse, start_mock_server, tool_names); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `explicit_app_mentions_respect_always_defer`  (lines 425–477)

```
async fn explicit_app_mentions_respect_always_defer() -> Result<()>
```

**Purpose**: This test ensures that even if the user mentions a specific app explicitly, the always-defer feature still keeps its tools behind search. That matters because user wording should not accidentally bypass a global rule meant to simplify or control tool exposure.

**Data flow**: It enables always-defer, sends a message that directly references the calendar app, captures the initial request, and checks the visible tools. It confirms `tool_search` is still present and that the calendar namespace and child tools remain hidden.

**Call relations**: This test is a special-case follow-up to the always-defer behavior. It guards against a tempting shortcut where explicit mentions could have caused direct tool injection despite the feature flag.

*Call graph*: calls 6 internal fn (mount, search_capable_apps_builder, mount_sse_once, sse, start_mock_server, tool_names); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `tool_search_returns_deferred_tools_without_follow_up_tool_injection`  (lines 480–759)

```
async fn tool_search_returns_deferred_tools_without_follow_up_tool_injection() -> Result<()>
```

**Purpose**: This is a full end-to-end test of the main deferred-tool flow for app tools. It proves the model can search for a hidden tool, call that tool in a later step, and complete the turn without the system re-sending the whole tool definition in later requests.

**Data flow**: It scripts three model responses: first a `tool_search` call, then a call to the discovered calendar tool, then a final assistant reply. While the turn runs, it waits for MCP tool-call begin and end events, verifies the call metadata and structured source markers, checks that the real app server received the right arguments plus turn metadata, and inspects all three outgoing requests. The result is proof that search results were returned, the tool call executed successfully, and later requests relied on remembered search output instead of injecting the tool into the normal tool list.

**Call relations**: This is a centerpiece test in the file because it ties discovery, execution, metadata propagation, and prompt shape together. It uses several helper functions to inspect search output and compare the first, second, and third requests across the whole conversation.

*Call graph*: calls 8 internal fn (mount_searchable, recorded_apps_tool_call_by_call_id, search_capable_apps_builder, mount_sse_sequence, start_mock_server, tool_names, tool_search_output_item, tool_search_output_tools); 8 external calls (default, assert!, assert_eq!, wait_for_event, from_str, skip_if_no_network!, unreachable!, vec!).


##### `tool_search_returns_deferred_v1_multi_agent_tools`  (lines 762–862)

```
async fn tool_search_returns_deferred_v1_multi_agent_tools() -> Result<()>
```

**Purpose**: This test checks that older multi-agent tools are also hidden behind `tool_search` and returned in a grouped namespace when searched for. That keeps advanced delegation tools out of the initial prompt until the model has a reason to ask for them.

**Data flow**: It scripts a search for the spawn-agent tool, runs a turn, and inspects the first and second requests. It confirms the initial request contains `tool_search` but none of the multi-agent tools, and that search results later return a `multi_agent_v1` namespace containing `spawn_agent` with deferred-loading metadata and the updated guidance text.

**Call relations**: This extends the search feature beyond app tools into built-in advanced tooling. It also checks prompt wording for the returned child tool, making sure the model sees the correct cautionary instructions only after discovery.

*Call graph*: calls 7 internal fn (mount_sse_sequence, namespace_child_tool, start_mock_server, test_codex, tool_names, tool_search_output_item, tool_search_output_tools); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `tool_search_returns_deferred_dynamic_tool_and_routes_follow_up_call`  (lines 865–1045)

```
async fn tool_search_returns_deferred_dynamic_tool_and_routes_follow_up_call() -> Result<()>
```

**Purpose**: This test proves that dynamic tools, which are added at runtime rather than fixed in config, can also be discovered through `tool_search` and then invoked correctly. It matters because deferred discovery would be incomplete if it only worked for one tool source.

**Data flow**: It creates a dynamic namespace tool, starts a thread with that tool available, and scripts the model to first search for it and then call it. During execution, it waits for a dynamic-tool call request event, verifies the call ID, namespace, tool name, and arguments, sends back a synthetic success response, and then checks the captured requests. The final assertions show that the search result included the tool, the later call output was sent back to the model, and the system never re-injected the tool into the normal visible list.

**Call relations**: This is the dynamic-tool counterpart to the larger app-tool flow test. It links search discovery to the dynamic tool event channel and shows that the remembered search result is enough for follow-up model calls.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, tool_names, tool_search_output_tools); 11 external calls (default, assert!, assert_eq!, wait_for_event, json!, Namespace, from_value, to_string, skip_if_no_network!, unreachable! (+1 more)).


##### `tool_search_indexes_only_enabled_non_app_mcp_tools`  (lines 1048–1173)

```
async fn tool_search_indexes_only_enabled_non_app_mcp_tools() -> Result<()>
```

**Purpose**: This test checks that for non-app MCP tools from an external tool server, search only indexes the ones that are enabled and not explicitly disabled. That prevents hidden or blocked tools from resurfacing through search.

**Data flow**: It configures a local MCP test server with one tool effectively enabled and another disabled, waits for that server to be ready, then runs a turn where the model issues two tool-search queries. Afterward it verifies the initial request did not expose the MCP tools directly, the search result for the echo query contains the enabled tool inside the MCP namespace, and the image query does not surface the disabled tool.

**Call relations**: This test focuses on the search index itself: what gets included and what gets filtered out. It complements other tests that focus on execution by proving the searchable catalog respects config-based tool enablement.

*Call graph*: calls 7 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_sequence, namespace_child_tool, start_mock_server, tool_names, tool_search_output_tools); 7 external calls (assert!, assert_eq!, stdio_server_bin, wait_for_mcp_server, json!, skip_if_no_network!, vec!).


##### `tool_search_surfaced_mcp_tool_errors_are_returned_to_model`  (lines 1176–1331)

```
async fn tool_search_surfaced_mcp_tool_errors_are_returned_to_model() -> Result<()>
```

**Purpose**: This test makes sure that when a tool discovered through search fails during execution, the actual error is returned to the model. Without this, deferred MCP calls could degrade into vague "unsupported" failures or hide useful debugging detail.

**Data flow**: It configures an MCP server, scripts the model to search for the echo tool and then call it incorrectly, and runs the turn. It waits for the MCP tool-call end event, verifies the call failed with a real execution error mentioning missing input, then checks the later request's function-call output to confirm that same error text was visible to the model and not replaced by an unsupported-call fallback.

**Call relations**: This test covers the unhappy path after successful discovery. It shows that once a deferred MCP tool has been surfaced by search, later execution errors are treated as genuine tool results and passed through honestly.

*Call graph*: calls 5 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_sequence, start_mock_server, tool_names); 10 external calls (default, assert!, assert_eq!, stdio_server_bin, wait_for_event, wait_for_mcp_server, panic!, skip_if_no_network!, unreachable!, vec!).


##### `tool_search_uses_non_app_mcp_server_instructions_as_namespace_description`  (lines 1334–1422)

```
async fn tool_search_uses_non_app_mcp_server_instructions_as_namespace_description() -> Result<()>
```

**Purpose**: This test checks that search results for a non-app MCP server use that server's own instructions as the namespace description. That helps the model understand what a returned tool group is for in plain language.

**Data flow**: It configures and starts an MCP test server, runs a turn that triggers a search for one of its tools, extracts the returned search tools, and finds the `mcp__rmcp` namespace entry. It then verifies that the namespace description matches the server-provided instruction text.

**Call relations**: This is a quality-of-search-result test. Rather than checking visibility or execution, it verifies that the grouped result carries the right descriptive context from the external server into the model-facing search response.

*Call graph*: calls 5 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_sequence, start_mock_server, tool_search_output_tools); 5 external calls (assert_eq!, stdio_server_bin, wait_for_mcp_server, skip_if_no_network!, vec!).


##### `tool_search_matches_mcp_tools_by_distinct_name_description_and_schema_terms`  (lines 1425–1505)

```
async fn tool_search_matches_mcp_tools_by_distinct_name_description_and_schema_terms() -> Result<()>
```

**Purpose**: This test proves the search index for MCP tools is built from several kinds of text, not just exact tool names. The model should be able to find a tool by unusual name fragments, by words in its description, or by field names from its input schema.

**Data flow**: It scripts three separate `tool_search` queries in one run, each using a different kind of matching term, then runs a turn and inspects the recorded search outputs. It confirms that each query surfaces the expected child tool inside the calendar namespace.

**Call relations**: This test is about search quality and recall. It strengthens confidence that deferred tools remain practically discoverable even when the user's wording matches metadata other than the final exposed tool name.

*Call graph*: calls 4 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_sequence, start_mock_server); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `tool_search_matches_dynamic_tools_by_name_description_namespace_and_schema_terms`  (lines 1508–1617)

```
async fn tool_search_matches_dynamic_tools_by_name_description_namespace_and_schema_terms() -> Result<()>
```

**Purpose**: This test does the same broad matching check for dynamic tools. It ensures a dynamic tool can be found by its exact name, spaced version of that name, description words, namespace name, or schema field names.

**Data flow**: It creates a dynamic namespace tool with distinctive words in its name, description, and schema, scripts several `tool_search` calls using those different terms, starts a thread containing that tool, and runs a turn. After completion it checks each search result to confirm the same dynamic tool appears under the expected namespace every time.

**Call relations**: This mirrors the MCP matching test but for runtime-added tools. Together, the two tests show that tool discovery is consistent across different tool sources, not tied to only one backend.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 7 external calls (default, assert!, assert_eq!, wait_for_event, Namespace, skip_if_no_network!, vec!).


### Code mode and runtime items
These tests validate higher-level runtime behavior, including Code Mode orchestration, emitted items/events, image tooling, and user-invoked shell commands.

### `core/tests/suite/code_mode.rs`

`test` · `request handling`

This file is a large integration suite around Code Mode’s script runtime. Most tests use `run_code_mode_turn*` helpers to build a `TestCodex` with `Feature::CodeMode` or `Feature::CodeModeOnly`, mount one SSE response that asks the model to call the `exec` custom tool, and a second SSE response that captures the tool output sent back to the model. The helper functions then decode that follow-up request into normalized content items, text fragments, success flags, or last non-empty text so assertions can focus on runtime semantics rather than raw protocol shape.

The suite exercises several subsystems. Built-in nested tools such as `exec_command`, `wait`, `update_plan`, `get_context_remaining`, `apply_patch`, `view_image`, `store`, and `load` are invoked from inside scripts and checked for output formatting, truncation, exception propagation, and persistence. Yield/resume behavior is tested by writing gate files in the workspace, extracting the emitted cell id from the “Script running” header, and later resuming or terminating that cell through the `wait` function tool. MCP-backed tools are exposed through a stdio RMCP server, with tests for namespaced/global tool visibility, non-prefixed names, hidden dynamic tools, deferred app tools, and exclusion of configured namespaces. The file also covers image helper behavior, including data-URI emission, remote-URL rejection, malformed-image replacement under `ResizeAllImages`, and resizing of oversized original-detail images. Several tests assert subtle invariants: code-mode-only should hide app-only tools from the runtime object, yielded background cells continue running without an explicit wait turn, concurrent cells merge only the keys they wrote, and `ALL_TOOLS` metadata should include generated TypeScript declarations for both built-in and MCP tools.

#### Function details

##### `custom_tool_output_items`  (lines 69–77)

```
fn custom_tool_output_items(req: &ResponsesRequest, call_id: &str) -> Vec<Value>
```

**Purpose**: Normalizes a custom tool call output into a vector of content-item JSON values.

**Data flow**: It reads a `ResponsesRequest` and call id, fetches the `custom_tool_call_output`, and returns either the existing `output` array or wraps a plain string as a single `{type:"input_text", text}` item. Any other shape causes a panic.

**Call relations**: Many code-mode tests call this after the follow-up model request is captured, because `exec` outputs may be serialized either as a string or as structured content items.

*Call graph*: calls 1 internal fn (custom_tool_call_output); called by 21 (code_mode_background_keeps_running_on_later_turn_without_wait, code_mode_can_apply_patch_via_nested_tool, code_mode_can_output_images_via_global_helper, code_mode_can_return_exec_command_output, code_mode_can_run_multiple_yielded_sessions, code_mode_can_use_mcp_image_result_with_image_helper, code_mode_can_use_view_image_result_with_image_helper, code_mode_can_yield_and_resume_with_wait, code_mode_concurrent_cells_merge_only_the_stored_values_they_write, code_mode_exit_stops_script_immediately (+11 more)); 2 external calls (panic!, vec!).


##### `tool_names`  (lines 79–94)

```
fn tool_names(body: &Value) -> Vec<String>
```

**Purpose**: Extracts the visible tool names/types from a request body’s `tools` array.

**Data flow**: It reads the JSON body, looks up `tools`, iterates the array if present, and collects each tool’s `name` or fallback `type` string into a `Vec<String>`, defaulting to empty when absent.

**Call relations**: Tool-visibility tests use this helper to compare the exact prompt-exposed tool list under `CodeMode`, `CodeModeOnly`, and app-feature combinations.

*Call graph*: 1 external calls (get).


##### `function_tool_output_items`  (lines 96–104)

```
fn function_tool_output_items(req: &ResponsesRequest, call_id: &str) -> Vec<Value>
```

**Purpose**: Normalizes a function tool output into a vector of content-item JSON values.

**Data flow**: It reads a `ResponsesRequest` and call id, fetches the `function_call_output`, and returns either the existing output array or a one-item text array when the output is a string; unsupported shapes panic.

**Call relations**: Wait/termination tests use this helper because resumed code cells report through the `wait` function tool rather than the `exec` custom tool.

*Call graph*: calls 1 internal fn (function_call_output); called by 7 (code_mode_can_run_multiple_yielded_sessions, code_mode_can_yield_and_resume_with_wait, code_mode_wait_can_terminate_and_continue, code_mode_wait_returns_error_for_unknown_session, code_mode_wait_terminate_returns_completed_session_if_it_finished_after_yield_control, code_mode_wait_uses_its_own_max_tokens_budget, code_mode_yield_and_termination_are_not_starved_by_runtime_output); 2 external calls (panic!, vec!).


##### `text_item`  (lines 106–111)

```
fn text_item(items: &[Value], index: usize) -> &str
```

**Purpose**: Returns the `text` field from a specific content item in a normalized output array.

**Data flow**: It indexes into a slice of JSON items, reads the `text` string, and panics if the item is not an `input_text`-like object with a text field.

**Call relations**: Most output-shape assertions use this helper after `custom_tool_output_items` or `function_tool_output_items` has normalized the response.

*Call graph*: called by 18 (code_mode_background_keeps_running_on_later_turn_without_wait, code_mode_can_apply_patch_via_nested_tool, code_mode_can_output_images_via_global_helper, code_mode_can_return_exec_command_output, code_mode_can_run_multiple_yielded_sessions, code_mode_can_use_mcp_image_result_with_image_helper, code_mode_can_use_view_image_result_with_image_helper, code_mode_can_yield_and_resume_with_wait, code_mode_concurrent_cells_merge_only_the_stored_values_they_write, code_mode_exit_stops_script_immediately (+8 more)).


##### `extract_running_cell_id`  (lines 113–118)

```
fn extract_running_cell_id(text: &str) -> String
```

**Purpose**: Parses the yielded code-cell id from the standard “Script running with cell ID …” header text.

**Data flow**: It strips the fixed prefix, takes the first line after it, and returns that substring as the cell id, panicking if the header format is unexpected.

**Call relations**: Yield/resume and termination tests call this on the first output item from `exec` or `wait` so later turns can target the same running cell.

*Call graph*: called by 7 (code_mode_can_run_multiple_yielded_sessions, code_mode_can_yield_and_resume_with_wait, code_mode_concurrent_cells_merge_only_the_stored_values_they_write, code_mode_wait_can_terminate_and_continue, code_mode_wait_terminate_returns_completed_session_if_it_finished_after_yield_control, code_mode_wait_uses_its_own_max_tokens_budget, code_mode_yield_and_termination_are_not_starved_by_runtime_output).


##### `wait_for_file_source`  (lines 120–127)

```
fn wait_for_file_source(path: &Path) -> Result<String>
```

**Purpose**: Builds a JavaScript polling snippet that waits until a given file exists by repeatedly calling `tools.exec_command`.

**Data flow**: It shell-quotes the path, formats a shell command that prints `ready` when the file exists, then wraps that command in a JavaScript `while` loop string and returns it as `Result<String>`.

**Call relations**: Long-running code-mode tests embed this generated source into `exec` scripts to block until the test process writes a gate file.

*Call graph*: called by 6 (code_mode_can_run_multiple_yielded_sessions, code_mode_can_yield_and_resume_with_wait, code_mode_concurrent_cells_merge_only_the_stored_values_they_write, code_mode_wait_can_terminate_and_continue, code_mode_wait_terminate_returns_completed_session_if_it_finished_after_yield_control, code_mode_wait_uses_its_own_max_tokens_budget); 3 external calls (to_string_lossy, format!, try_join).


##### `custom_tool_output_body_and_success`  (lines 129–147)

```
fn custom_tool_output_body_and_success(
    req: &ResponsesRequest,
    call_id: &str,
) -> (String, Option<bool>)
```

**Purpose**: Extracts a human-meaningful text body and success flag from a custom tool output, skipping the standard status header item when present.

**Data flow**: It reads the custom tool output content/success tuple, normalizes the output items, collects all text items, and returns either the raw content, the only text item, or the concatenation of all text items after the first header item, along with the optional success boolean.

**Call relations**: Many tests use this helper when they care about semantic script output rather than the exact item-by-item framing of the `exec` result.

*Call graph*: calls 2 internal fn (custom_tool_call_output_content_and_success, custom_tool_output_items); called by 30 (app_only_tools_are_not_visible_or_runnable_by_code_mode_model, code_mode_can_call_hidden_dynamic_tools, code_mode_can_compare_elapsed_time_around_set_timeout, code_mode_can_output_images_via_global_helper, code_mode_can_output_serialized_text_via_global_helper, code_mode_can_print_content_only_mcp_tool_result_fields, code_mode_can_print_error_mcp_tool_result_fields, code_mode_can_print_structured_mcp_tool_result_fields, code_mode_can_resume_after_set_timeout, code_mode_can_store_and_load_values_across_turns (+15 more)).


##### `custom_tool_output_last_non_empty_text`  (lines 149–164)

```
fn custom_tool_output_last_non_empty_text(req: &ResponsesRequest, call_id: &str) -> Option<String>
```

**Purpose**: Finds the last non-blank text fragment emitted by a custom tool call.

**Data flow**: It inspects the custom tool output for the given call id; if the output is a non-empty string it returns it, and if it is an array it scans text items from the end and returns the last non-whitespace one.

**Call relations**: JSON-producing tests use this helper to ignore status headers and intermediate blank items, then parse the final emitted JSON payload.

*Call graph*: calls 1 internal fn (custom_tool_call_output); called by 6 (code_mode_can_call_hidden_dynamic_tools, code_mode_can_compare_elapsed_time_around_set_timeout, code_mode_can_store_and_load_values_across_turns, code_mode_concurrent_cells_merge_only_the_stored_values_they_write, code_mode_exports_all_tools_metadata_for_builtin_tools, code_mode_exports_all_tools_metadata_for_namespaced_mcp_tools).


##### `run_code_mode_turn`  (lines 166–172)

```
async fn run_code_mode_turn(
    server: &MockServer,
    prompt: &str,
    code: &str,
) -> Result<(TestCodex, ResponseMock)>
```

**Purpose**: Runs a single code-mode turn with default model and no extra config customization.

**Data flow**: It takes a mock server, user prompt, and JavaScript source, then delegates to `run_code_mode_turn_with_config` with a no-op config closure and returns the built `TestCodex` plus the second response mock that captures tool output.

**Call relations**: This is the main convenience entry point for simple code-mode tests that only need one `exec` call and one follow-up request.

*Call graph*: calls 1 internal fn (run_code_mode_turn_with_config); called by 19 (code_mode_can_apply_patch_via_nested_tool, code_mode_can_compare_elapsed_time_around_set_timeout, code_mode_can_output_images_via_global_helper, code_mode_can_output_serialized_text_via_global_helper, code_mode_can_resume_after_set_timeout, code_mode_can_return_exec_command_output, code_mode_exec_command_explicit_max_output_tokens_truncates, code_mode_exec_explicit_max_above_default_preserves_output, code_mode_exec_explicit_max_above_default_truncates_larger_output, code_mode_exec_explicit_max_output_tokens_truncates (+9 more)).


##### `run_code_mode_turn_with_config`  (lines 174–182)

```
async fn run_code_mode_turn_with_config(
    server: &MockServer,
    prompt: &str,
    code: &str,
    configure: impl FnOnce(&mut Config) + Send + 'static,
) -> Result<(TestCodex, ResponseMock)>
```

**Purpose**: Runs a single code-mode turn while allowing the caller to mutate `Config` before build.

**Data flow**: It forwards the server, prompt, code, default model slug, and caller-supplied config closure to `run_code_mode_turn_with_model_and_config`.

**Call relations**: Tests that need feature flags or token-limit tweaks use this wrapper instead of the simpler `run_code_mode_turn`.

*Call graph*: calls 1 internal fn (run_code_mode_turn_with_model_and_config); called by 5 (code_mode_exec_explicit_max_above_truncation_policy_preserves_output, code_mode_exec_without_max_preserves_output_beyond_truncation_policy, code_mode_get_context_remaining_returns_structured_result, resize_all_images_replaces_malformed_code_mode_image, run_code_mode_turn).


##### `run_code_mode_turn_with_model_and_config`  (lines 184–218)

```
async fn run_code_mode_turn_with_model_and_config(
    server: &MockServer,
    prompt: &str,
    code: &str,
    model: &'static str,
    configure: impl FnOnce(&mut Config) + Send + 'static,
) -> Re
```

**Purpose**: Builds a `TestCodex`, enables code mode, mounts the scripted `exec` call and follow-up assistant response, submits the user turn, and returns the harness plus follow-up request capture.

**Data flow**: It creates a `test_codex` builder with the chosen model and config closure, enables `Feature::CodeMode`, mounts one SSE stream that emits `response.created`, `custom_tool_call(exec, code)`, and `completed`, mounts a second SSE stream for the assistant follow-up, submits the prompt, and returns `(TestCodex, ResponseMock)`.

**Call relations**: All non-RMCP code-mode helpers funnel into this function. It wires the standard two-request pattern used by most tests in the file.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); called by 2 (resize_all_images_resizes_explicit_original_code_mode_image, run_code_mode_turn_with_config); 1 external calls (vec!).


##### `code_mode_can_call_standalone_web_search`  (lines 221–320)

```
async fn code_mode_can_call_standalone_web_search() -> Result<()>
```

**Purpose**: Verifies that code mode can invoke the standalone web-search extension and that the nested search request uses the expected model and settings.

**Data flow**: It mounts a `/v1/alpha/search` HTTP mock, scripts an `exec` call that invokes `tools.web__run`, builds a `TestCodex` with auth, installed web-search extension, `CodeMode`, `StandaloneWebSearch`, and `WebSearchMode::Live`, submits a turn, then inspects the recorded search request body and the final `exec` output text.

**Call relations**: This test bypasses the generic `run_code_mode_turn` helper because it must install an extension registry and inspect an extra outbound HTTP request.

*Call graph*: calls 6 internal fn (auth_manager_from_auth, mount_sse_once, sse, start_mock_server, test_codex, from_api_key); 11 external calls (new, new, given, new, assert_eq!, install, json!, skip_if_no_network!, vec!, method (+1 more)).


##### `run_code_mode_turn_with_rmcp`  (lines 322–328)

```
async fn run_code_mode_turn_with_rmcp(
    server: &MockServer,
    prompt: &str,
    code: &str,
) -> Result<(TestCodex, ResponseMock)>
```

**Purpose**: Runs a code-mode turn with the RMCP stdio test server enabled, using the default model.

**Data flow**: It forwards the server, prompt, and code to `run_code_mode_turn_with_rmcp_model` with the default model slug.

**Call relations**: MCP-related tests use this as the simplest entry point when they need RMCP tools available inside the code runtime.

*Call graph*: calls 1 internal fn (run_code_mode_turn_with_rmcp_model); called by 8 (code_mode_can_print_content_only_mcp_tool_result_fields, code_mode_can_print_error_mcp_tool_result_fields, code_mode_can_print_structured_mcp_tool_result_fields, code_mode_exports_all_tools_metadata_for_namespaced_mcp_tools, code_mode_exposes_mcp_tools_on_global_tools_object, code_mode_exposes_namespaced_mcp_tools_on_global_tools_object, code_mode_exposes_normalized_illegal_mcp_tool_names, code_mode_lists_global_scope_items).


##### `run_code_mode_turn_with_rmcp_model`  (lines 330–341)

```
async fn run_code_mode_turn_with_rmcp_model(
    server: &MockServer,
    prompt: &str,
    code: &str,
    model: &'static str,
) -> Result<(TestCodex, ResponseMock)>
```

**Purpose**: Runs a code-mode turn with RMCP enabled and an explicit model slug.

**Data flow**: It delegates to `run_code_mode_turn_with_rmcp_config` with `code_mode_only = false` and `non_prefixed_mcp_tool_names = false`.

**Call relations**: Image and MCP metadata tests use this helper when model capabilities matter, such as `gpt-5.3-codex` image behavior.

*Call graph*: calls 1 internal fn (run_code_mode_turn_with_rmcp_config); called by 2 (code_mode_can_use_mcp_image_result_with_image_helper, run_code_mode_turn_with_rmcp).


##### `run_code_mode_turn_with_rmcp_mode`  (lines 343–358)

```
async fn run_code_mode_turn_with_rmcp_mode(
    server: &MockServer,
    prompt: &str,
    code: &str,
    code_mode_only: bool,
) -> Result<(TestCodex, ResponseMock)>
```

**Purpose**: Runs a code-mode turn with RMCP enabled while choosing between `CodeMode` and `CodeModeOnly`.

**Data flow**: It forwards the server, prompt, code, and `code_mode_only` flag to `run_code_mode_turn_with_rmcp_config` using the default model and prefixed MCP names.

**Call relations**: The `code_mode_only_can_call_mcp_tool` test uses this to verify MCP access under the stricter code-mode-only prompt/tool surface.

*Call graph*: calls 1 internal fn (run_code_mode_turn_with_rmcp_config); called by 1 (code_mode_only_can_call_mcp_tool).


##### `run_code_mode_turn_with_rmcp_config`  (lines 360–438)

```
async fn run_code_mode_turn_with_rmcp_config(
    server: &MockServer,
    prompt: &str,
    code: &str,
    model: &'static str,
    code_mode_only: bool,
    non_prefixed_mcp_tool_names: bool,
) ->
```

**Purpose**: Builds a `TestCodex` configured with an RMCP stdio server, optional code-mode-only behavior, and optional non-prefixed MCP tool names, then runs the standard `exec`/follow-up sequence.

**Data flow**: It resolves the RMCP test server binary, mutates `config.mcp_servers` to add a stdio server with propagated environment variables and startup timeout, enables `CodeMode` or `CodeModeOnly` and optionally `NonPrefixedMcpToolNames`, waits for the MCP server to come up, mounts the `exec` SSE stream and follow-up assistant stream, submits the prompt, and returns `(TestCodex, ResponseMock)`.

**Call relations**: All RMCP-backed tests funnel through this function because it is the only helper that provisions the stdio MCP server and waits for readiness before the turn runs.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); called by 3 (code_mode_uses_non_prefixed_mcp_tool_names_when_feature_enabled, run_code_mode_turn_with_rmcp_mode, run_code_mode_turn_with_rmcp_model); 3 external calls (stdio_server_bin, wait_for_mcp_server, vec!).


##### `code_mode_can_return_exec_command_output`  (lines 442–480)

```
async fn code_mode_can_return_exec_command_output() -> Result<()>
```

**Purpose**: Checks that nested `exec_command` results are returned to code mode as structured JSON plus the standard script-completed header.

**Data flow**: It runs an `exec` script that stringifies the result of `tools.exec_command`, normalizes the follow-up output items, regex-matches the first header item, parses the second item as JSON, and asserts fields like `chunk_id`, `output`, `exit_code`, and absence of `session_id`.

**Call relations**: This is a baseline nested-tool test built on `run_code_mode_turn`, proving that `exec_command` output is surfaced intact to the script.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_items, run_code_mode_turn, text_item); 6 external calls (assert!, assert_eq!, concat!, assert_regex_match, from_str, skip_if_no_network!).


##### `code_mode_only_restricts_prompt_tools`  (lines 483–515)

```
async fn code_mode_only_restricts_prompt_tools() -> Result<()>
```

**Purpose**: Verifies that `CodeModeOnly` narrows the model-visible tool list to the small built-in code-mode set.

**Data flow**: It mounts a simple assistant response, builds a `TestCodex` with `Feature::CodeModeOnly`, submits a turn, then inspects the first request body and compares `tool_names` against the expected four-tool list.

**Call relations**: This test inspects the initial model prompt rather than script output, guarding the prompt-construction side of code-mode-only behavior.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `code_mode_only_guides_all_tools_search_and_calls_deferred_app_tools`  (lines 518–641)

```
async fn code_mode_only_guides_all_tools_search_and_calls_deferred_app_tools() -> Result<()>
```

**Purpose**: Checks that code-mode-only still exposes `ALL_TOOLS` metadata for deferred app tools and allows calling them indirectly after searching/filtering, without listing them directly in the prompt tool array.

**Data flow**: It mounts a searchable apps server and an `exec` script that looks up a deferred app tool in `ALL_TOOLS`, calls it, and prints JSON. After submitting the turn, it inspects the prompt tool list and `exec` description text, then parses the final script output and asserts the deferred app tool call succeeded.

**Call relations**: This test combines prompt-surface assertions with runtime `ALL_TOOLS` metadata and deferred dynamic tool dispatch.

*Call graph*: calls 7 internal fn (mount_searchable, mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_body_and_success, create_dummy_chatgpt_auth_for_testing); 6 external calls (assert!, assert_eq!, assert_ne!, from_str, skip_if_no_network!, vec!).


##### `app_only_tools_are_not_visible_or_runnable_by_code_mode_model`  (lines 644–727)

```
async fn app_only_tools_are_not_visible_or_runnable_by_code_mode_model() -> Result<()>
```

**Purpose**: Ensures app-only tools are neither listed in `ALL_TOOLS` nor callable from the code runtime, even when related searchable tools are visible.

**Data flow**: It mounts an apps server with an app-only tool, runs an `exec` script that probes `ALL_TOOLS` and `tools[...]`, catches any call error, then parses the final JSON output and asserts the app-only tool is not listed/callable and that no MCP call reached the apps server.

**Call relations**: This is the negative counterpart to deferred app-tool tests and protects the boundary between visible searchable tools and hidden app-only tools.

*Call graph*: calls 6 internal fn (mount_with_app_only_tool, search_capable_apps_builder, mount_sse_once, sse, start_mock_server, custom_tool_output_body_and_success); 7 external calls (assert!, assert_eq!, assert_ne!, format!, from_str, skip_if_no_network!, vec!).


##### `code_mode_only_can_call_nested_tools`  (lines 731–777)

```
async fn code_mode_only_can_call_nested_tools() -> Result<()>
```

**Purpose**: Verifies that `CodeModeOnly` still permits nested built-in tool calls from inside `exec`.

**Data flow**: It runs an `exec` script that calls `tools.exec_command` and prints its output, then extracts the final body/success and asserts the nested call succeeded and returned the expected marker text.

**Call relations**: This test proves that code-mode-only restricts prompt tools for the model, not the runtime’s ability to call allowed nested tools.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_body_and_success); 4 external calls (assert_eq!, assert_ne!, skip_if_no_network!, vec!).


##### `code_mode_update_plan_nested_tool_result_is_empty_object`  (lines 780–808)

```
async fn code_mode_update_plan_nested_tool_result_is_empty_object() -> Result<()>
```

**Purpose**: Checks that nested `update_plan` returns `{}` to code mode.

**Data flow**: It runs an `exec` script that calls `tools.update_plan`, stringifies the result, then parses the final output JSON and asserts it is an empty object.

**Call relations**: This is a focused nested-tool contract test using the standard code-mode helper path.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_get_context_remaining_returns_structured_result`  (lines 811–849)

```
async fn code_mode_get_context_remaining_returns_structured_result() -> Result<()>
```

**Purpose**: Verifies that `get_context_remaining` returns a structured token count when token-budget support is enabled.

**Data flow**: It runs an `exec` script that calls `tools.get_context_remaining`, with config enabling `Feature::TokenBudget` and a `model_context_window`, then parses the final JSON output and asserts `tokens_left` equals the expected derived value.

**Call relations**: This test depends on config mutation through `run_code_mode_turn_with_config` to enable the feature under test.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_config); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_nested_tool_calls_can_run_in_parallel`  (lines 853–941)

```
async fn code_mode_nested_tool_calls_can_run_in_parallel() -> Result<()>
```

**Purpose**: Ensures nested tool calls inside `exec` can execute concurrently rather than serially.

**Data flow**: It builds a code-mode harness, runs a warmup turn and then a measured turn whose script performs `Promise.all` over two `test_sync_tool` calls with a barrier and sleep, times the second submission, and asserts the duration stays below the serial upper bound while the final output equals `["ok","ok"]`.

**Call relations**: This test uses a custom multi-response sequence instead of the generic helper because it needs a warmup phase and wall-clock timing around the second turn.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, custom_tool_output_items); 5 external calls (now, assert!, assert_eq!, skip_if_no_network!, vec!).


##### `code_mode_exec_command_explicit_max_output_tokens_truncates`  (lines 945–971)

```
async fn code_mode_exec_command_explicit_max_output_tokens_truncates() -> Result<()>
```

**Purpose**: Checks that an explicit `max_output_tokens` argument on `exec_command` truncates nested command output in the returned text.

**Data flow**: It runs an `exec` script that calls `tools.exec_command` with `max_output_tokens: 5`, then asserts the second output item contains the expected truncated-output marker string.

**Call relations**: This test covers the nested-tool argument path, where truncation is requested directly in the tool call.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 2 external calls (assert_eq!, skip_if_no_network!).


##### `code_mode_exec_explicit_max_above_default_preserves_output`  (lines 975–1006)

```
async fn code_mode_exec_explicit_max_above_default_preserves_output() -> Result<()>
```

**Purpose**: Verifies that a large explicit max-output budget preserves large nested command output beyond the default limit.

**Data flow**: It runs an `exec` script with an `@exec` annotation and `exec_command` call both requesting a high token budget, then asserts the returned output is the full 50,000-character string.

**Call relations**: This test guards the interaction between script-level `@exec` metadata and nested `exec_command` output handling.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 3 external calls (assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `code_mode_exec_explicit_max_above_default_truncates_larger_output`  (lines 1010–1045)

```
async fn code_mode_exec_explicit_max_above_default_truncates_larger_output() -> Result<()>
```

**Purpose**: Checks that even with a raised explicit max, sufficiently large output is still truncated with a warning and preserved head/tail slices.

**Data flow**: It runs a Python command producing 90,000 `A`s under a 25,000-token script budget and 20,000-token nested budget, then compares the returned text to the expected warning/truncation format.

**Call relations**: This is the large-output negative case for the previous preservation test.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 3 external calls (assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `code_mode_exec_explicit_max_above_truncation_policy_preserves_output`  (lines 1049–1083)

```
async fn code_mode_exec_explicit_max_above_truncation_policy_preserves_output() -> Result<()>
```

**Purpose**: Verifies that an explicit max-output budget can override a lower global truncation policy.

**Data flow**: It runs a large-output script with `tool_output_token_limit` set low in config, but with a high explicit `@exec`/nested max, and asserts the full output is preserved.

**Call relations**: This test specifically covers precedence between per-exec limits and global config policy.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn_with_config); 3 external calls (assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `code_mode_exec_without_max_preserves_output_beyond_default`  (lines 1087–1117)

```
async fn code_mode_exec_without_max_preserves_output_beyond_default() -> Result<()>
```

**Purpose**: Checks that a high `@exec` max-output annotation preserves output even when the nested `exec_command` call omits `max_output_tokens`.

**Data flow**: It runs a large-output script with only the `@exec` annotation and asserts the returned output is complete.

**Call relations**: This complements the explicit nested-argument tests by proving the script-level annotation alone is enough.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 3 external calls (assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `code_mode_exec_without_max_preserves_output_beyond_truncation_policy`  (lines 1121–1154)

```
async fn code_mode_exec_without_max_preserves_output_beyond_truncation_policy() -> Result<()>
```

**Purpose**: Verifies that script-level `@exec` max-output can override a low global truncation policy even when the nested tool call omits its own max.

**Data flow**: It runs a large-output script with low `tool_output_token_limit` in config and a high `@exec` annotation, then asserts the full output is returned.

**Call relations**: This is the policy-precedence counterpart to the previous test.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn_with_config); 3 external calls (assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `code_mode_exec_explicit_max_output_tokens_truncates`  (lines 1158–1183)

```
async fn code_mode_exec_explicit_max_output_tokens_truncates() -> Result<()>
```

**Purpose**: Checks that a script-level `@exec` max-output annotation truncates nested command output when the nested call omits its own max.

**Data flow**: It runs a command producing 40 digits under `// @exec: {"max_output_tokens": 5}` and asserts the returned text includes the warning and truncation marker.

**Call relations**: This test covers truncation driven by the script annotation rather than the nested tool argument.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 2 external calls (assert_eq!, skip_if_no_network!).


##### `code_mode_returns_accumulated_output_when_script_fails`  (lines 1186–1225)

```
async fn code_mode_returns_accumulated_output_when_script_fails() -> Result<()>
```

**Purpose**: Ensures that when an `exec` script throws, previously emitted text is preserved and the final item contains a formatted stack trace.

**Data flow**: It runs a script that emits two text lines then throws, normalizes the output items, regex-matches the failure header, and asserts the two earlier text items plus a final `Script error:` item are present.

**Call relations**: This is a core runtime-failure test for the `exec` environment itself, not a nested tool.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_items, run_code_mode_turn, text_item); 4 external calls (assert_eq!, concat!, assert_regex_match, skip_if_no_network!).


##### `code_mode_exec_surfaces_handler_errors_as_exceptions`  (lines 1229–1264)

```
async fn code_mode_exec_surfaces_handler_errors_as_exceptions() -> Result<()>
```

**Purpose**: Checks that nested tool handler failures become JavaScript exceptions that user code can catch.

**Data flow**: It runs a script that calls `tools.exec_command({})` inside `try/catch`, then inspects the final output body and asserts the caught-error path ran and the success path did not.

**Call relations**: This test validates the exception bridge between Rust tool handlers and the JavaScript runtime.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn); 3 external calls (assert!, assert_ne!, skip_if_no_network!).


##### `code_mode_can_yield_and_resume_with_wait`  (lines 1268–1410)

```
async fn code_mode_can_yield_and_resume_with_wait() -> Result<()>
```

**Purpose**: Verifies that `yield_control()` pauses a running script, emits a resumable cell id, and that later `wait` turns resume the same cell through multiple phases until completion.

**Data flow**: It builds gate-file wait snippets, runs an `exec` script that emits phase 1, yields, waits for phase-2 and phase-3 files, and emits later phases. The test captures the first `exec` output and cell id, then submits two `wait` function calls after writing the gate files, checking each returned header and phase text.

**Call relations**: This is the canonical multi-turn yielded-session test. It uses both custom-tool and function-tool output helpers because the first phase comes from `exec` and later phases come from `wait`.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item, wait_for_file_source); 7 external calls (assert_eq!, concat!, assert_regex_match, format!, write, skip_if_no_network!, vec!).


##### `code_mode_yield_and_termination_are_not_starved_by_runtime_output`  (lines 1414–1507)

```
async fn code_mode_yield_and_termination_are_not_starved_by_runtime_output() -> Result<()>
```

**Purpose**: Ensures that a yielded or terminated session can still be controlled promptly even when the runtime has produced a very large backlog of output events.

**Data flow**: It starts a busy-loop script that emits 16,384 text events and then spins forever, waits for the initial yielded response, extracts the cell id, submits a terminating `wait` call, and asserts the returned header says `Script terminated`.

**Call relations**: This is a stress test for controller arbitration and output buffering under heavy runtime output.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item); 8 external calls (from_secs, assert!, assert_eq!, concat!, assert_regex_match, skip_if_no_network!, timeout, vec!).


##### `code_mode_can_run_multiple_yielded_sessions`  (lines 1511–1675)

```
async fn code_mode_can_run_multiple_yielded_sessions() -> Result<()>
```

**Purpose**: Checks that multiple yielded code cells can coexist and be resumed independently.

**Data flow**: It starts session A and session B in separate turns, each yielding after an initial text line and waiting on different gate files, records distinct cell ids, then resumes each with separate `wait` calls after writing the corresponding gate file and asserts each completion output matches the correct session.

**Call relations**: This extends the single-cell yield/resume flow to concurrent background sessions and guards against cross-session mix-ups.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item, wait_for_file_source); 8 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, format!, write, skip_if_no_network!, vec!).


##### `code_mode_concurrent_cells_merge_only_the_stored_values_they_write`  (lines 1679–1828)

```
async fn code_mode_concurrent_cells_merge_only_the_stored_values_they_write() -> Result<()>
```

**Purpose**: Verifies that concurrent yielded cells merge persisted `store()` state by key, preserving unrelated writes from other cells.

**Data flow**: It initializes stored keys `a` and `b`, starts one yielded cell that updates `a`, runs another turn that updates `b`, resumes the first cell, then runs a final `exec` turn that prints `load("a")` and `load("b")` as JSON and asserts the merged result is `{a:3,b:4}`.

**Call relations**: This test combines yielded-session control with cross-turn persistent storage semantics.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, custom_tool_output_last_non_empty_text, extract_running_cell_id, text_item, wait_for_file_source); 6 external calls (assert_eq!, format!, write, from_str, skip_if_no_network!, vec!).


##### `code_mode_wait_can_terminate_and_continue`  (lines 1832–1955)

```
async fn code_mode_wait_can_terminate_and_continue() -> Result<()>
```

**Purpose**: Checks that terminating a yielded cell via `wait` does not poison later `exec` turns.

**Data flow**: It starts a yielded script, extracts the cell id, submits a terminating `wait` call and asserts the returned header says `Script terminated`, then runs a fresh `exec` turn and confirms it completes normally with new output.

**Call relations**: This is a lifecycle cleanup test ensuring terminated cells do not block future code-mode execution.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item, wait_for_file_source); 6 external calls (assert_eq!, concat!, assert_regex_match, format!, skip_if_no_network!, vec!).


##### `code_mode_wait_returns_error_for_unknown_session`  (lines 1958–2015)

```
async fn code_mode_wait_returns_error_for_unknown_session() -> Result<()>
```

**Purpose**: Verifies that `wait` on a nonexistent cell id returns a failed function-tool result with a clear error message.

**Data flow**: It submits a turn whose model calls `wait` on cell id `999999`, inspects the function-tool success flag and normalized output items, and asserts the header says `Script failed` and the second item contains `exec cell 999999 not found`.

**Call relations**: This is the negative-path contract test for the `wait` function tool.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, function_tool_output_items, text_item); 6 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!, vec!).


##### `code_mode_wait_terminate_returns_completed_session_if_it_finished_after_yield_control`  (lines 2019–2211)

```
async fn code_mode_wait_terminate_returns_completed_session_if_it_finished_after_yield_control() -> Result<()>
```

**Purpose**: Checks the race between termination and natural completion: if a yielded session finishes after yielding but before a terminate request is processed, `wait` may return either terminated or completed output, but must remain coherent.

**Data flow**: It starts two yielded sessions, resumes session B while session A finishes in the background and writes a marker file, then submits a terminating `wait` for session A and accepts either a one-item terminated header or a two-item completed/terminated header plus final text.

**Call relations**: This is a race-condition regression test around yielded-session state transitions.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item, wait_for_file_source); 12 external calls (from_millis, assert!, assert_eq!, concat!, assert_regex_match, format!, write, panic!, try_join, skip_if_no_network! (+2 more)).


##### `code_mode_background_keeps_running_on_later_turn_without_wait`  (lines 2215–2304)

```
async fn code_mode_background_keeps_running_on_later_turn_without_wait() -> Result<()>
```

**Purpose**: Ensures a yielded background script continues executing after later unrelated turns, even if no `wait` turn is used to resume it.

**Data flow**: It starts a yielded script that later writes a file via nested `exec_command`, then submits a separate turn whose model calls `exec_command` to wait for that file, and finally asserts the file appeared and contains the expected text.

**Call relations**: This test proves yielded cells are true background tasks rather than only progressing when explicitly resumed by `wait`.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, text_item); 8 external calls (assert!, assert_eq!, concat!, assert_regex_match, format!, try_join, skip_if_no_network!, vec!).


##### `code_mode_wait_uses_its_own_max_tokens_budget`  (lines 2308–2404)

```
async fn code_mode_wait_uses_its_own_max_tokens_budget() -> Result<()>
```

**Purpose**: Checks that a `wait` call can impose its own output token budget independent of the original `exec` session’s budget.

**Data flow**: It starts a yielded script with a high `@exec` max-output budget, writes the completion gate, then resumes it with `wait(max_tokens: 6)` and asserts the returned second item matches a truncation-warning regex.

**Call relations**: This test covers output-budgeting on resumed sessions specifically, not just initial `exec` runs.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item, wait_for_file_source); 7 external calls (assert_eq!, concat!, assert_regex_match, format!, write, skip_if_no_network!, vec!).


##### `code_mode_can_output_serialized_text_via_global_helper`  (lines 2407–2434)

```
async fn code_mode_can_output_serialized_text_via_global_helper() -> Result<()>
```

**Purpose**: Verifies that the global `text()` helper serializes non-string values to JSON text.

**Data flow**: It runs a script calling `text({ json: true })`, extracts the final body/success, and asserts the output string is `{"json":true}`.

**Call relations**: This is a small runtime-helper contract test for the `text` global.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn); 4 external calls (assert_eq!, assert_ne!, eprintln!, skip_if_no_network!).


##### `code_mode_can_resume_after_set_timeout`  (lines 2437–2461)

```
async fn code_mode_can_resume_after_set_timeout() -> Result<()>
```

**Purpose**: Checks that the code runtime supports `setTimeout` and resumes async execution afterward.

**Data flow**: It runs a script awaiting a 10ms timeout and then emitting `timer done`, then asserts the final output body equals that text.

**Call relations**: This is a runtime event-loop capability test rather than a nested-tool test.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_notify_injects_additional_exec_tool_output_into_active_context`  (lines 2464–2498)

```
async fn code_mode_notify_injects_additional_exec_tool_output_into_active_context() -> Result<()>
```

**Purpose**: Verifies that the `notify()` helper injects extra `custom_tool_call_output` content for the active `exec` call into the follow-up model request.

**Data flow**: It runs a script that calls `notify(...)` and a nested sync tool, then scans the follow-up request inputs for a `custom_tool_call_output` item with the same call id, tool name `exec`, and text containing the notify marker.

**Call relations**: This test inspects raw request inputs rather than normalized final output because `notify` affects the active context payload sent back to the model.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 2 external calls (assert!, skip_if_no_network!).


##### `code_mode_exit_stops_script_immediately`  (lines 2501–2536)

```
async fn code_mode_exit_stops_script_immediately() -> Result<()>
```

**Purpose**: Checks that the global `exit()` helper terminates script execution without treating it as a failure.

**Data flow**: It runs a script that emits `before`, calls `exit()`, and would otherwise emit `after`; then it inspects the output items and final body/success to confirm only `before` appears under a `Script completed` header.

**Call relations**: This is a control-flow helper test for the code runtime itself.

*Call graph*: calls 5 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn, text_item); 5 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!).


##### `code_mode_surfaces_text_stringify_errors`  (lines 2539–2576)

```
async fn code_mode_surfaces_text_stringify_errors() -> Result<()>
```

**Purpose**: Ensures that `text()` serialization failures, such as circular JSON, surface as script failures with an explanatory error message.

**Data flow**: It runs a script that passes a circular object to `text()`, then inspects the output items and success flag to confirm failure and the presence of a `Converting circular structure to JSON` message.

**Call relations**: This is the negative-path counterpart to the successful `text()` serialization test.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_items, run_code_mode_turn, text_item); 6 external calls (assert!, assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!).


##### `code_mode_can_output_images_via_global_helper`  (lines 2579–2618)

```
async fn code_mode_can_output_images_via_global_helper() -> Result<()>
```

**Purpose**: Verifies that the global `image()` helper emits an `input_image` content item in the custom tool output.

**Data flow**: It runs a script calling `image("data:image/png;base64,AAA")`, then checks the output items for a `Script completed` header followed by the expected `input_image` JSON object with `detail: high`.

**Call relations**: This is the baseline image-helper contract test.

*Call graph*: calls 5 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn, text_item); 5 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!).


##### `resize_all_images_replaces_malformed_code_mode_image`  (lines 2621–2649)

```
async fn resize_all_images_replaces_malformed_code_mode_image() -> Result<()>
```

**Purpose**: Checks that with `ResizeAllImages` enabled, malformed image data from `image()` is replaced by a text placeholder instead of failing the turn.

**Data flow**: It runs a script emitting an invalid data URI image under `Feature::ResizeAllImages`, then asserts the second output item is an `input_text` placeholder saying the image content was omitted.

**Call relations**: This test covers the image post-processing path activated by the resize feature.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn_with_config); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `resize_all_images_resizes_explicit_original_code_mode_image`  (lines 2652–2704)

```
async fn resize_all_images_resizes_explicit_original_code_mode_image() -> Result<()>
```

**Purpose**: Verifies that oversized original-detail images emitted from code mode are resized to fit limits while preserving `detail: original`.

**Data flow**: It creates a 6401x100 PNG in memory, base64-encodes it into a data URL, runs a script calling `image(url, "original")` with `ResizeAllImages` enabled, then decodes the emitted image URL and asserts the resized dimensions are `(6000, 94)`.

**Call relations**: This is the positive-path resize test for valid oversized images.

*Call graph*: calls 5 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn_with_model_and_config, new); 9 external calls (ImageRgba8, from_pixel, new, assert_eq!, assert_ne!, format!, Rgba, load_from_memory, skip_if_no_network!).


##### `code_mode_image_helper_rejects_remote_url`  (lines 2707–2744)

```
async fn code_mode_image_helper_rejects_remote_url() -> Result<()>
```

**Purpose**: Checks that `image()` rejects remote HTTP URLs and requires base64 data URIs.

**Data flow**: It runs a script calling `image("https://example.com/image.jpg")`, then inspects the failure output items and asserts the second item contains the exact remote-URL rejection message.

**Call relations**: This is the negative-path validation test for the image helper.

*Call graph*: calls 5 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn, text_item); 5 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!).


##### `code_mode_can_use_view_image_result_with_image_helper`  (lines 2747–2827)

```
async fn code_mode_can_use_view_image_result_with_image_helper() -> Result<()>
```

**Purpose**: Verifies that a result returned by the built-in `view_image` tool can be passed directly to `image()` and re-emitted as an `input_image` item.

**Data flow**: It writes a tiny PNG to disk, runs a script that calls `tools.view_image({path, detail:"original"})` and then `image(out)`, and asserts the emitted item is an `input_image` data URL with `detail: original`.

**Call relations**: This test bridges a built-in nested tool result into the image helper’s accepted input forms.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_body_and_success, custom_tool_output_items, text_item); 10 external calls (assert!, assert_eq!, assert_ne!, concat!, assert_regex_match, format!, write, to_string, skip_if_no_network!, vec!).


##### `code_mode_can_use_mcp_image_result_with_image_helper`  (lines 2830–2883)

```
async fn code_mode_can_use_mcp_image_result_with_image_helper() -> Result<()>
```

**Purpose**: Checks that an MCP tool returning image content can be fed into `image()` and emitted as an `input_image` item.

**Data flow**: It runs an RMCP-backed script that calls `mcp__rmcp__image_scenario`, extracts the image item from `out.content`, passes it to `image()`, and then asserts the emitted output item is a data-URL `input_image` with `detail: original`.

**Call relations**: This is the MCP analogue of the `view_image` integration test.

*Call graph*: calls 5 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn_with_rmcp_model, text_item); 6 external calls (assert!, assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!).


##### `code_mode_can_apply_patch_via_nested_tool`  (lines 2886–2923)

```
async fn code_mode_can_apply_patch_via_nested_tool() -> Result<()>
```

**Purpose**: Verifies that code mode can call the nested `apply_patch` tool and that the patch is applied to the workspace.

**Data flow**: It runs a script that calls `tools.apply_patch` with an add-file patch and prints the result, then checks the output items for successful completion and reads the created file from disk to assert its contents.

**Call relations**: This test combines nested-tool output assertions with a real filesystem side effect.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_items, run_code_mode_turn, text_item); 6 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, format!, skip_if_no_network!).


##### `code_mode_can_print_structured_mcp_tool_result_fields`  (lines 2926–2961)

```
async fn code_mode_can_print_structured_mcp_tool_result_fields() -> Result<()>
```

**Purpose**: Checks that code mode can access `structuredContent`, `content`, and `isError` fields from an MCP tool result.

**Data flow**: It runs an RMCP-backed script calling `mcp__rmcp__echo`, formats selected fields into text, and asserts the final output matches the expected multiline string including propagated environment data.

**Call relations**: This is a contract test for the JavaScript shape of successful MCP tool results.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_only_can_call_mcp_tool`  (lines 2964–2991)

```
async fn code_mode_only_can_call_mcp_tool() -> Result<()>
```

**Purpose**: Verifies that MCP tools remain callable from inside `exec` even when `CodeModeOnly` is enabled.

**Data flow**: It runs a code-mode-only RMCP-backed script calling `mcp__rmcp__echo`, then asserts the final output text contains the echoed structured content.

**Call relations**: This complements the prompt-surface restrictions of code-mode-only by proving runtime MCP access still works.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp_mode); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_exposes_mcp_tools_on_global_tools_object`  (lines 2994–3032)

```
async fn code_mode_exposes_mcp_tools_on_global_tools_object() -> Result<()>
```

**Purpose**: Checks that namespaced MCP tools are installed as callable functions on the global `tools` object.

**Data flow**: It runs an RMCP-backed script that inspects `Object.keys(tools)`, calls `tools.mcp__rmcp__echo`, and prints booleans plus result fields, then compares the final output to the expected multiline string.

**Call relations**: This is a runtime-object exposure test for MCP tools.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_uses_non_prefixed_mcp_tool_names_when_feature_enabled`  (lines 3035–3076)

```
async fn code_mode_uses_non_prefixed_mcp_tool_names_when_feature_enabled() -> Result<()>
```

**Purpose**: Verifies that enabling `NonPrefixedMcpToolNames` exposes MCP tools under `rmcp__...` names instead of `mcp__rmcp__...`.

**Data flow**: It runs an RMCP-backed script under the feature flag, calls `tools.rmcp__echo`, prints booleans for prefixed/non-prefixed presence plus the echo result, and parses the final JSON output for exact comparison.

**Call relations**: This test covers the alternate naming scheme for MCP tool exposure in the code runtime.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp_config); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_exposes_namespaced_mcp_tools_on_global_tools_object`  (lines 3079–3112)

```
async fn code_mode_exposes_namespaced_mcp_tools_on_global_tools_object() -> Result<()>
```

**Purpose**: Checks that the global `tools` object contains both built-in tools and namespaced MCP tools.

**Data flow**: It runs an RMCP-backed script that prints whether `tools.exec_command` and `tools.mcp__rmcp__echo` are functions, then parses the final JSON output and compares it to the expected booleans.

**Call relations**: This is a lighter-weight object-shape test than the full MCP call tests.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_exposes_normalized_illegal_mcp_tool_names`  (lines 3115–3141)

```
async fn code_mode_exposes_normalized_illegal_mcp_tool_names() -> Result<()>
```

**Purpose**: Verifies that MCP tool names requiring normalization are exposed under normalized JavaScript-safe names.

**Data flow**: It runs an RMCP-backed script calling `tools.mcp__rmcp__echo_tool`, then asserts the final output text contains the expected echoed value.

**Call relations**: This guards the name-normalization layer between MCP tool metadata and the JavaScript runtime.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_lists_global_scope_items`  (lines 3144–3252)

```
async fn code_mode_lists_global_scope_items() -> Result<()>
```

**Purpose**: Checks the set of globals exposed inside the code runtime, including built-ins, helper functions, and tool-related objects.

**Data flow**: It runs an RMCP-backed script that serializes `Object.getOwnPropertyNames(globalThis).sort()`, parses the resulting JSON array into a set, and asserts every observed global is in the expected allowlist.

**Call relations**: This is a broad runtime-environment contract test for the JavaScript sandbox.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert!, assert_ne!, skip_if_no_network!).


##### `code_mode_exports_all_tools_metadata_for_builtin_tools`  (lines 3255–3288)

```
async fn code_mode_exports_all_tools_metadata_for_builtin_tools() -> Result<()>
```

**Purpose**: Verifies that `ALL_TOOLS` contains rich metadata for built-in tools, including generated TypeScript declarations.

**Data flow**: It runs a script that finds the `view_image` entry in `ALL_TOOLS`, prints it as JSON, then parses the final JSON output and compares it to the expected name/description/declaration payload.

**Call relations**: This test inspects metadata generation rather than tool execution.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_last_non_empty_text, run_code_mode_turn); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_exports_all_tools_metadata_for_namespaced_mcp_tools`  (lines 3291–3334)

```
async fn code_mode_exports_all_tools_metadata_for_namespaced_mcp_tools() -> Result<()>
```

**Purpose**: Verifies that `ALL_TOOLS` contains rich metadata for namespaced MCP tools, including namespace description and generated TypeScript declaration.

**Data flow**: It runs an RMCP-backed script that finds `mcp__rmcp__echo` in `ALL_TOOLS`, prints it as JSON, and compares the parsed result to the expected metadata object.

**Call relations**: This is the MCP counterpart to the built-in `ALL_TOOLS` metadata test.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_last_non_empty_text, run_code_mode_turn_with_rmcp); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_can_call_hidden_dynamic_tools`  (lines 3337–3502)

```
async fn code_mode_can_call_hidden_dynamic_tools() -> Result<()>
```

**Purpose**: Checks that hidden dynamic tools are discoverable in `ALL_TOOLS`, callable from code mode, and bridged through the top-level dynamic-tool request/response protocol.

**Data flow**: It starts a thread with a deferred dynamic namespace tool, runs an `exec` script that looks up and calls it, waits for `TurnStarted` and `DynamicToolCallRequest` events from the Codex thread, submits an `Op::DynamicToolResponse` with `hidden-ok`, waits for turn completion, then parses the final script output JSON and asserts the tool metadata and returned value.

**Call relations**: This test spans code-mode runtime, thread-manager dynamic tool registration, and the outer Codex event protocol for deferred tool fulfillment.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, turn_permission_fields, custom_tool_output_body_and_success, custom_tool_output_last_non_empty_text, new); 10 external calls (default, new, assert!, assert_eq!, assert_ne!, wait_for_event, wait_for_event_match, from_str, skip_if_no_network!, vec!).


##### `code_mode_excludes_configured_nested_tool_namespaces`  (lines 3505–3594)

```
async fn code_mode_excludes_configured_nested_tool_namespaces() -> Result<()>
```

**Purpose**: Verifies that configured excluded namespaces remain directly exposed to the model in mixed code mode but are removed from the nested `tools` object and `ALL_TOOLS` inside `exec`.

**Data flow**: It starts a thread with a dynamic namespace named `excluded`, configures `code_mode.excluded_tool_namespaces`, runs an `exec` script that probes `tools.excluded__lookup` and `ALL_TOOLS`, and asserts the prompt tool list still contains the namespace while the runtime JSON output reports the nested tool as unavailable.

**Call relations**: This test distinguishes model-visible namespace exposure from nested-runtime exposure filtering.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_body_and_success); 5 external calls (assert!, assert_eq!, assert_ne!, skip_if_no_network!, vec!).


##### `code_mode_can_print_content_only_mcp_tool_result_fields`  (lines 3597–3637)

```
async fn code_mode_can_print_content_only_mcp_tool_result_fields() -> Result<()>
```

**Purpose**: Checks the JavaScript shape of an MCP result that has only `content` and no `structuredContent`.

**Data flow**: It runs an RMCP-backed script calling `mcp__rmcp__image_scenario` in a text-only mode, formats selected fields into text, and asserts the final output matches the expected multiline string.

**Call relations**: This complements the structured-content MCP result test with a content-only result shape.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_can_print_error_mcp_tool_result_fields`  (lines 3640–3676)

```
async fn code_mode_can_print_error_mcp_tool_result_fields() -> Result<()>
```

**Purpose**: Verifies the JavaScript shape of an MCP error result, including `isError`, content length, and null `structuredContent`.

**Data flow**: It runs an RMCP-backed script that calls `mcp__rmcp__echo` with missing required args, inspects the returned content text for a missing-field message, and asserts the final formatted output string matches expectations.

**Call relations**: This is the error-path counterpart to the successful MCP result-shape tests.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_can_store_and_load_values_across_turns`  (lines 3679–3769)

```
async fn code_mode_can_store_and_load_values_across_turns() -> Result<()>
```

**Purpose**: Checks that `store()` persists JSON-serializable values across turns and `load()` retrieves them later.

**Data flow**: It runs one `exec` turn that stores a structured value and prints `stored`, then a second `exec` turn that prints `JSON.stringify(load("nb"))`; the test parses the second output and asserts the loaded value matches the original object.

**Call relations**: This is the baseline persistence test for code-mode key/value storage across turns.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_body_and_success, custom_tool_output_last_non_empty_text); 5 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!, vec!).


##### `code_mode_can_compare_elapsed_time_around_set_timeout`  (lines 3772–3816)

```
async fn code_mode_can_compare_elapsed_time_around_set_timeout() -> Result<()>
```

**Purpose**: Verifies that `Date.now()` and `setTimeout` interact sensibly in the runtime by measuring elapsed time around a 100ms delay.

**Data flow**: It runs a script that records start/end timestamps around `setTimeout`, prints a JSON object, parses the final output, and asserts `elapsed_ms >= 100` and `waited_long_enough` is true.

**Call relations**: This is another runtime event-loop/timer capability test, but with quantitative timing assertions.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_last_non_empty_text, run_code_mode_turn); 5 external calls (assert!, assert_eq!, assert_ne!, from_str, skip_if_no_network!).


### `core/tests/suite/items.rs`

`test` · `request handling`

This file is a broad protocol-level test suite for `EventMsg` and `TurnItem` emission. It uses mocked SSE streams to force specific response shapes and then waits on the Codex event stream to verify that started/completed item pairs, legacy compatibility events, and streaming deltas all carry the expected IDs, timestamps, and payloads. Two helpers support repeated setup: `disabled_plan_turn` constructs an `Op::UserInput` with approvals disabled, local environment selection, and a caller-supplied `CollaborationMode`; `image_generation_artifact_path` reproduces the runtime path convention for saved generated images by sanitizing session and call IDs into `generated_images/<session>/<call>.png`.

The simpler tests assert one item kind at a time: user messages preserve `TextElement` metadata and still emit the legacy `UserMessage` event; assistant messages produce `TurnItem::AgentMessage`; reasoning items preserve summary and raw content; web search items emit begin/completed events with the same call ID and a concrete `WebSearchAction::Search`; image generation emits begin/end events and writes decoded bytes to disk when possible, but leaves `saved_path` unset when base64 decoding fails. The streaming tests verify that `AgentMessageContentDelta`, `ReasoningContentDelta`, and `ReasoningRawContentDelta` include the originating item ID.

The plan-mode tests are the most nuanced. They feed assistant text containing `<proposed_plan>` blocks, sometimes split across added text and deltas, sometimes interleaved with `<oai-mem-citation>` tags, and sometimes missing a closing tag. The assertions prove that Codex emits a separate `TurnItem::Plan` plus `PlanDelta`, strips plan text from agent-message deltas and completed content, removes citation markup from both streams, preserves event ordering, and still finalizes plan content when the close tag never arrives.

#### Function details

##### `disabled_plan_turn`  (lines 47–72)

```
fn disabled_plan_turn(
    text: &str,
    _model: String,
    collaboration_mode: CollaborationMode,
) -> anyhow::Result<Op>
```

**Purpose**: Builds a user-input operation configured for deterministic plan-mode tests with approvals disabled and local environment selection. It centralizes the thread settings needed by all plan parsing scenarios.

**Data flow**: Takes input text, an unused model string, and a `CollaborationMode`. It reads the current working directory, converts it to an absolute path, derives sandbox and permission settings with `turn_permission_fields(PermissionProfile::Disabled, cwd)`, and returns `Op::UserInput` containing one `UserInput::Text` plus `ThreadSettingsOverrides` that set local environments, `AskForApproval::Never`, the derived sandbox and permission profile, and the supplied collaboration mode.

**Call relations**: All plan-mode tests call this helper before submitting a turn. It isolates the common setup so those tests can focus on streamed assistant content and the resulting `Plan`/`AgentMessage` event split.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 5 (plan_mode_emits_plan_item_from_proposed_plan_block, plan_mode_handles_missing_plan_close_tag, plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done, plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed, plan_mode_strips_plan_from_agent_messages); 4 external calls (default, Ok, current_dir, vec!).


##### `image_generation_artifact_path`  (lines 74–96)

```
fn image_generation_artifact_path(codex_home: &Path, session_id: &str, call_id: &str) -> PathBuf
```

**Purpose**: Reconstructs the filesystem path where Codex should save a generated image artifact for a given session and call ID. It mirrors the runtime naming and sanitization rules so tests can assert on exact paths.

**Data flow**: Accepts the Codex home directory, a session ID string, and a call ID string. It sanitizes each identifier by replacing non-ASCII-alphanumeric, non-`-`, non-`_` characters with `_`, falling back to `generated_image` if the result is empty, then joins `codex_home/generated_images/<sanitized session>/<sanitized call>.png` and returns that `PathBuf`.

**Call relations**: Used by both image-generation tests to compute the expected saved artifact location before the turn runs. Those tests then compare emitted `saved_path` values and on-disk file contents against this helper’s output.

*Call graph*: called by 2 (image_generation_call_event_is_emitted, image_generation_call_event_is_emitted_when_image_save_fails); 2 external calls (join, format!).


##### `user_message_item_is_emitted`  (lines 99–157)

```
async fn user_message_item_is_emitted() -> anyhow::Result<()>
```

**Purpose**: Checks that submitting text input emits matching `ItemStarted` and `ItemCompleted` events for `TurnItem::UserMessage`, and that the legacy `UserMessage` event still carries the same text and `TextElement` metadata. It validates both the new item stream and backward-compatible event surface.

**Data flow**: The test starts a mock server, builds `TestCodex`, mounts an empty completed SSE response, constructs a `UserInput::Text` with one `TextElement` spanning the `<file>` marker, submits `Op::UserInput`, waits for started and completed user-message items via `wait_for_event_match`, then waits for the legacy `EventMsg::UserMessage`. It asserts matching IDs, identical content vectors, and exact legacy message/text-element values before returning success.

**Call relations**: This top-level test does not use local helpers. It drives the minimal turn needed to observe user-message item lifecycle events and the compatibility event emitted alongside them.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, Ok, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `assistant_message_item_is_emitted`  (lines 160–212)

```
async fn assistant_message_item_is_emitted() -> anyhow::Result<()>
```

**Purpose**: Verifies that an assistant text response produces started and completed `TurnItem::AgentMessage` events with a stable item ID and final text content. It confirms the basic agent-message item lifecycle.

**Data flow**: It starts a mock server, builds `TestCodex`, mounts an SSE stream containing `ev_assistant_message("all done")`, submits a simple text `Op::UserInput`, waits for `ItemStarted` and `ItemCompleted` events carrying `TurnItem::AgentMessage`, extracts the first `AgentMessageContent::Text` from the completed item, and asserts that the started/completed IDs match and the text equals `all done`.

**Call relations**: This is a direct event-emission test. It relies on the mocked SSE assistant message to trigger the agent-message item path and uses `wait_for_event_match` to observe both lifecycle endpoints.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (default, Ok, assert_eq!, wait_for_event_match, panic!, skip_if_no_network!, vec!).


##### `reasoning_item_is_emitted`  (lines 215–276)

```
async fn reasoning_item_is_emitted() -> anyhow::Result<()>
```

**Purpose**: Checks that a reasoning response item is surfaced as a `TurnItem::Reasoning` with preserved summary lines and raw reasoning content. It validates the completed reasoning item payload, not just the existence of events.

**Data flow**: The test starts a mock server, builds `TestCodex`, creates a reasoning SSE item with summary strings and raw trace strings, mounts it, submits a text turn, waits for started and completed reasoning items, and asserts that the IDs match, `summary_text` equals the provided summary vector, and `raw_content` equals the provided raw trace vector.

**Call relations**: This top-level test uses the response helper `ev_reasoning_item` to synthesize the upstream event and then verifies Codex’s item translation on the event stream.

*Call graph*: calls 5 internal fn (ev_reasoning_item, mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, Ok, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `web_search_item_is_emitted`  (lines 279–348)

```
async fn web_search_item_is_emitted() -> anyhow::Result<()>
```

**Purpose**: Verifies that a web-search tool call produces both item lifecycle events and the legacy `WebSearchBegin` event, all tied to the same call ID and populated with the final search query. It also checks that start and completion timestamps are nonzero.

**Data flow**: It starts a mock server, builds `TestCodex`, mounts SSE events for a partial web-search call followed by a completed web-search call with query `weather seattle`, submits a text turn, waits for `ItemStarted(TurnItem::WebSearch)`, `WebSearchBegin`, and `ItemCompleted(TurnItem::WebSearch)`, then asserts matching call IDs, positive timestamps, and a final `WebSearchAction::Search { query: Some("weather seattle"), queries: None }`.

**Call relations**: This test exercises the translation from streamed web-search response events into both item-based and legacy event forms. It uses the partial and done SSE helpers to force the begin/completion sequence.

*Call graph*: calls 6 internal fn (ev_web_search_call_added_partial, ev_web_search_call_done, mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (default, Ok, assert!, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `image_generation_call_event_is_emitted`  (lines 351–436)

```
async fn image_generation_call_event_is_emitted() -> anyhow::Result<()>
```

**Purpose**: Checks that a completed image-generation call emits begin/end events, creates a corresponding `TurnItem::ImageGeneration`, decodes the returned base64 payload, and saves the bytes to the expected artifact path. It validates both event metadata and side effects on disk.

**Data flow**: The test starts a mock server, builds `TestCodex`, computes the expected artifact path from Codex home, thread ID, and call ID, removes any stale file, mounts an SSE image-generation call with revised prompt `A tiny blue square` and result `Zm9v`, submits a text turn, waits for started/completed image-generation items plus `ImageGenerationBegin` and `ImageGenerationEnd`, and asserts matching IDs, positive timestamps, status `completed`, revised prompt, raw result string, emitted `saved_path`, and on-disk file contents equal to `b"foo"`. It then removes the saved file.

**Call relations**: This test depends on `image_generation_artifact_path` to mirror runtime path construction. It verifies the full happy path from streamed image-generation response through artifact persistence and event emission.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, image_generation_artifact_path); 8 external calls (default, Ok, assert!, assert_eq!, wait_for_event_match, skip_if_no_network!, remove_file, vec!).


##### `image_generation_call_event_is_emitted_when_image_save_fails`  (lines 439–497)

```
async fn image_generation_call_event_is_emitted_when_image_save_fails() -> anyhow::Result<()>
```

**Purpose**: Verifies the failure mode where image-generation metadata is still emitted even though the returned payload cannot be decoded and no file is saved. It ensures save failures do not suppress the end event.

**Data flow**: It starts a mock server, builds `TestCodex`, computes and clears the expected artifact path for call ID `ig_invalid`, mounts an SSE image-generation call whose result string `_ -8` is invalid base64, submits a text turn, waits for `ImageGenerationBegin` and `ImageGenerationEnd`, and asserts the call ID, status, revised prompt, raw result string, `saved_path == None`, and absence of the expected file on disk.

**Call relations**: This is the negative-path companion to `image_generation_call_event_is_emitted`. It uses the same path helper but asserts that persistence is skipped while event emission still completes.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, image_generation_artifact_path); 8 external calls (default, Ok, assert!, assert_eq!, wait_for_event_match, skip_if_no_network!, remove_file, vec!).


##### `agent_message_content_delta_has_item_metadata`  (lines 500–565)

```
async fn agent_message_content_delta_has_item_metadata() -> anyhow::Result<()>
```

**Purpose**: Checks that streamed agent-message text deltas carry the originating thread ID, turn ID, and item ID, and that the completed item reuses that same item ID. It validates metadata linkage between streaming and finalized agent content.

**Data flow**: The test starts a mock server, builds `TestCodex`, mounts an SSE stream that adds a message item, emits one output-text delta `streamed response`, then completes the assistant message, submits a text turn, waits for `ItemStarted(TurnItem::AgentMessage)`, `AgentMessageContentDelta`, and `ItemCompleted(TurnItem::AgentMessage)`, and asserts that the delta event’s thread ID matches the configured session thread, its turn ID matches the started turn, its item ID matches the started item, its delta text is correct, and the completed item ID matches the started item ID.

**Call relations**: This test focuses on the streaming path for agent messages. It uses the added-item and delta SSE helpers to ensure Codex emits metadata-rich delta events before final completion.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, Ok, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `plan_mode_emits_plan_item_from_proposed_plan_block`  (lines 568–630)

```
async fn plan_mode_emits_plan_item_from_proposed_plan_block() -> anyhow::Result<()>
```

**Purpose**: Verifies that in plan collaboration mode, assistant text wrapped in `<proposed_plan>` tags is emitted as a separate plan stream and finalized as a `TurnItem::Plan`. It confirms the extracted plan text excludes the wrapper tags.

**Data flow**: It starts a mock server, builds `TestCodex`, constructs assistant text `Intro\n<proposed_plan>...` `Outro`, mounts a streaming SSE sequence for that message, builds a `CollaborationMode { mode: ModeKind::Plan, ... }`, submits a disabled plan turn, waits for `PlanDelta` and completed `TurnItem::Plan`, and asserts that the delta and completed plan text are exactly `- Step 1\n- Step 2\n` and that the delta thread ID matches the session thread ID.

**Call relations**: This is the simplest plan-mode extraction test and uses `disabled_plan_turn` for setup. It establishes the baseline behavior that later plan tests refine with stripping, citations, split tags, and missing close tags.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_plan_turn); 6 external calls (Ok, assert_eq!, wait_for_event_match, format!, skip_if_no_network!, vec!).


##### `plan_mode_strips_plan_from_agent_messages`  (lines 633–717)

```
async fn plan_mode_strips_plan_from_agent_messages() -> anyhow::Result<()>
```

**Purpose**: Checks that when a proposed-plan block appears inside assistant output, the plan text is removed from agent-message deltas and completed agent content while still being emitted as a separate plan item. It validates the split between conversational text and plan text.

**Data flow**: The test starts a mock server, builds `TestCodex`, mounts a streamed assistant message containing intro text, a `<proposed_plan>` block, and outro text, submits a plan-mode turn via `disabled_plan_turn`, then loops over all events until it has seen a `PlanDelta`, completed `AgentMessage`, and completed `Plan`. It concatenates all `AgentMessageContentDelta` fragments, extracts text from the completed agent item, and asserts that both agent streams equal `Intro\nOutro` while the plan delta and completed plan item equal `- Step 1\n- Step 2\n`.

**Call relations**: This test extends the baseline plan extraction path by observing multiple event kinds in one loop. It depends on `disabled_plan_turn` and on the runtime’s ability to route the same upstream assistant message into two separate item streams.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_plan_turn); 7 external calls (new, Ok, assert_eq!, wait_for_event, format!, skip_if_no_network!, vec!).


##### `plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done`  (lines 720–897)

```
async fn plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done() -> anyhow::Result<()>
```

**Purpose**: Exercises the hardest streaming plan-mode case: citation tags and proposed-plan tags are split across the initial added text, multiple deltas, and the final done message. It verifies that both citation markup and plan markup are stripped consistently from agent and plan outputs, and that event ordering remains sane.

**Data flow**: This async test starts a mock server, builds `TestCodex`, constructs an assistant message whose `<oai-mem-citation>` and `<proposed_plan>` tags are fragmented across `ev_message_item_added`, several `ev_output_text_delta` chunks, and the final assistant message, mounts that SSE stream, submits a plan-mode turn via `disabled_plan_turn`, and then consumes events until `TurnComplete`, recording indices for item starts, deltas, completions, and the turn completion. It reconstructs started/completed agent text and plan text, asserts that agent output is `Intro \nOutro`, plan output is `- Step 1\n- Step 2\n`, no reconstructed text contains citation tags, and lifecycle ordering is start < delta < completion < turn complete for both item kinds.

**Call relations**: This is the most comprehensive plan-streaming test in the file. It uses `disabled_plan_turn` and a custom SSE event sequence to prove the parser maintains state across chunk boundaries and strips markup before emitting either agent or plan events.

*Call graph*: calls 8 internal fn (ev_assistant_message, ev_completed, ev_output_text_delta, mount_sse_once, sse, start_mock_server, test_codex, disabled_plan_turn); 8 external calls (new, Ok, assert!, assert_eq!, wait_for_event, format!, skip_if_no_network!, vec!).


##### `plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed`  (lines 900–1005)

```
async fn plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed() -> anyhow::Result<()>
```

**Purpose**: Verifies that a `<proposed_plan>` opening tag split between the initial added text and the first delta is still recognized and parsed into a plan item. It targets parser state carried across stream boundaries.

**Data flow**: The test starts a mock server, builds `TestCodex`, creates assistant text where the added chunk ends with `Intro\n<proposed` and the next delta begins with `_plan>...`, mounts the SSE stream, submits a plan-mode turn, then loops until `TurnComplete` collecting started/completed agent and plan items plus their deltas. It asserts that the agent stream becomes `Intro\nOutro`, the plan starts empty, the plan delta is `- Step 1\n`, and the completed plan item contains the same text.

**Call relations**: This test is a focused parser-boundary case built on the same `disabled_plan_turn` helper as the other plan tests. It narrows specifically to split opening-tag recognition rather than citation stripping or missing close tags.

*Call graph*: calls 8 internal fn (ev_assistant_message, ev_completed, ev_output_text_delta, mount_sse_once, sse, start_mock_server, test_codex, disabled_plan_turn); 7 external calls (new, Ok, assert_eq!, wait_for_event, format!, skip_if_no_network!, vec!).


##### `plan_mode_handles_missing_plan_close_tag`  (lines 1008–1085)

```
async fn plan_mode_handles_missing_plan_close_tag() -> anyhow::Result<()>
```

**Purpose**: Checks that plan extraction still finalizes sensibly when the assistant output opens a `<proposed_plan>` block but never emits the closing tag. The remaining plan text should still become the completed plan item, while the agent message keeps only the pre-plan prefix.

**Data flow**: It starts a mock server, builds `TestCodex`, mounts a streamed assistant message `Intro\n<proposed_plan>\n- Step 1\n` with no closing tag, submits a plan-mode turn via `disabled_plan_turn`, waits until it has seen a `PlanDelta`, completed `Plan`, and completed `AgentMessage`, then asserts that the plan delta and completed plan text are `- Step 1\n` and that the completed agent text is just `Intro\n`.

**Call relations**: This is the malformed-input edge-case companion to the other plan tests. It uses `disabled_plan_turn` and demonstrates that the parser flushes unterminated plan content at end-of-stream instead of dropping it.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_plan_turn); 5 external calls (Ok, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `reasoning_content_delta_has_item_metadata`  (lines 1088–1135)

```
async fn reasoning_content_delta_has_item_metadata() -> anyhow::Result<()>
```

**Purpose**: Verifies that streamed reasoning summary deltas include the originating reasoning item ID. It checks metadata linkage for the summary-text delta path.

**Data flow**: The test starts a mock server, builds `TestCodex`, mounts an SSE stream that adds a reasoning item, emits `ev_reasoning_summary_text_delta("step one")`, then completes the reasoning item, submits a text turn, waits for the started reasoning item and the `ReasoningContentDelta` event, and asserts that the delta event’s `item_id` matches the started item ID and its `delta` equals `step one`.

**Call relations**: This test parallels `agent_message_content_delta_has_item_metadata` but for reasoning summaries. It uses the reasoning-item-added and summary-delta SSE helpers to force the streaming metadata path.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, Ok, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `reasoning_raw_content_delta_respects_flag`  (lines 1138–1190)

```
async fn reasoning_raw_content_delta_respects_flag() -> anyhow::Result<()>
```

**Purpose**: Checks that raw reasoning deltas are emitted only when `config.show_raw_agent_reasoning` is enabled, and that the emitted delta references the correct reasoning item. It validates the feature-gated raw-reasoning stream.

**Data flow**: It starts a mock server, builds `TestCodex` with `config.show_raw_agent_reasoning = true`, mounts an SSE stream that adds a reasoning item, emits `ev_reasoning_text_delta("raw detail")`, then completes the reasoning item with summary and raw content, submits a text turn, waits for the started reasoning item and the `ReasoningRawContentDelta` event, and asserts matching `item_id` and delta text `raw detail`.

**Call relations**: This test is the raw-content counterpart to `reasoning_content_delta_has_item_metadata`. It depends on the builder configuration closure to enable the runtime path that emits `ReasoningRawContentDelta`.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, Ok, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


### `core/tests/suite/user_shell_cmd.rs`

`test` · `interactive command execution and follow-up history propagation during tests`

This file specifies the behavior of direct user shell commands. Unlike unified exec, these commands are initiated by `Op::RunUserShellCommand` and are expected to emit normal exec lifecycle events with `ExecCommandSource::UserShell`. The tests cover basic execution in a temporary cwd (`ls` and `cat`), erroring when no local environment is selected, interruption via `Op::Interrupt`, and the important invariant that a user shell command must not replace an active model turn. That coexistence test mounts a model `shell_command` tool call, starts the turn, launches a user shell command while the agent command is running, and asserts the turn completes normally without `TurnAbortReason::Replaced`.

The file also verifies that shell-command history is persisted into later model requests as a `<user_shell_command>` block containing command, exit code, duration, and output; that this history uses truncated output when configured and is not truncated twice; and that user shell commands do not receive the `CODEX_SANDBOX_NETWORK_DISABLED` environment variable even when the session permission profile restricts network access. Several tests inspect begin, delta, and end events directly, while others inspect the next model request body captured by the mock server to confirm exactly what history text was forwarded.

#### Function details

##### `user_shell_cmd_ls_and_cat_in_temp_dir`  (lines 39–101)

```
async fn user_shell_cmd_ls_and_cat_in_temp_dir()
```

**Purpose**: Smoke-tests direct user shell commands by listing a temp directory and then printing a known file's contents.

**Data flow**: It creates a temporary cwd with `hello.txt`, builds `TestCodex` pinned to that cwd, submits `Op::RunUserShellCommand { command: "ls" }`, waits for `ExecCommandEnd`, and asserts exit code 0 plus presence of the filename in stdout. It then submits `cat hello.txt`, waits for another end event, normalizes CRLF on Windows, and asserts stdout exactly matches the file contents.

**Call relations**: This is the baseline execution test for the user-shell path, validating that commands run in the configured cwd and emit end events.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 8 external calls (new, assert!, assert_eq!, cfg!, wait_for_event, format!, write, unreachable!).


##### `user_shell_command_without_local_environment_emits_error`  (lines 104–135)

```
async fn user_shell_command_without_local_environment_emits_error() -> anyhow::Result<()>
```

**Purpose**: Ensures user shell commands are rejected when the session has no local environment selected.

**Data flow**: It builds a test, submits thread settings whose `TurnEnvironmentSelections` contain the cwd but an empty environment list, then submits `RunUserShellCommand`. It waits for `EventMsg::Error` and asserts the message is `shell is unavailable in this session` with no extra error info.

**Call relations**: This test covers the environment-gating branch before any shell process is started.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, new); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, unreachable!, vec!).


##### `user_shell_cmd_can_be_interrupted`  (lines 138–176)

```
async fn user_shell_cmd_can_be_interrupted()
```

**Purpose**: Checks that a long-running user shell command can be interrupted and causes a turn-aborted event with reason `Interrupted`.

**Data flow**: It builds a test, submits `sleep 5` as a user shell command, waits for `ExecCommandBegin` whose source is `UserShell`, submits `Op::Interrupt`, then waits up to 60 seconds for `EventMsg::TurnAborted` and asserts the abort reason is `Interrupted`.

**Call relations**: This test uses begin-event synchronization before interrupting, ensuring the command is actually running when the interrupt is sent.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 5 external calls (from_secs, assert_eq!, wait_for_event_match, wait_for_event_with_timeout, unreachable!).


##### `user_shell_command_does_not_replace_active_turn`  (lines 179–298)

```
async fn user_shell_command_does_not_replace_active_turn() -> anyhow::Result<()>
```

**Purpose**: Verifies that launching a user shell command while an agent turn is active does not abort or replace that active turn.

**Data flow**: It mounts a model-driven `shell_command` tool call followed by assistant completion, submits a user turn with disabled permissions and local environment selections, waits for `ExecCommandBegin` from source `Agent`, then submits a direct user shell command. It consumes subsequent events, tracking whether a `TurnAborted(Replaced)` occurs, whether a `UserShell` `ExecCommandEnd` occurs, and whether the turn completes, then asserts the turn completed, the user shell command finished, no replaced abort occurred, and the mock server saw two requests for the active turn.

**Call relations**: This test is the key concurrency/regression check for coexistence between direct user shell commands and model-driven turn execution.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); 9 external calls (default, from_secs, assert!, assert_eq!, cfg!, wait_for_event_match, json!, timeout, vec!).


##### `user_shell_command_history_is_persisted_and_shared_with_model`  (lines 301–381)

```
async fn user_shell_command_history_is_persisted_and_shared_with_model() -> anyhow::Result<()>
```

**Purpose**: Checks that a completed user shell command is recorded in conversation history and forwarded to the model in a structured XML-like block on the next turn.

**Data flow**: It disables `Feature::ShellSnapshot`, runs a shell command that prints the value of `CODEX_SANDBOX` or `not-set`, waits for begin, delta, and end events, asserting source `UserShell`, stdout delta content, and successful exit. After `TurnComplete`, it mounts a simple assistant response, submits a follow-up turn, extracts the user message containing `<user_shell_command>` from the captured request, normalizes line endings, and regex-matches the exact command/result block including exit code, duration, and output.

**Call relations**: This test bridges runtime event emission and later request serialization, proving shell-command history is persisted and visible to the model.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 10 external calls (from_utf8, assert!, assert_eq!, assert_regex_match, wait_for_event, wait_for_event_match, format!, escape, split, vec!).


##### `user_shell_command_does_not_set_network_sandbox_env_var`  (lines 384–426)

```
async fn user_shell_command_does_not_set_network_sandbox_env_var() -> anyhow::Result<()>
```

**Purpose**: Ensures direct user shell commands do not inherit the `CODEX_SANDBOX_NETWORK_DISABLED` environment variable even when the session permission profile restricts network access.

**Data flow**: It builds a test whose permission profile uses the existing filesystem sandbox policy plus `NetworkSandboxPolicy::Restricted`, runs a shell command that prints `CODEX_SANDBOX_NETWORK_DISABLED` or `not-set`, waits for `ExecCommandEnd`, and asserts successful exit and stdout `not-set`.

**Call relations**: This test isolates environment-variable behavior for the user-shell path, distinct from model tool execution.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 2 external calls (assert_eq!, wait_for_event_match).


##### `user_shell_command_output_is_truncated_in_history`  (lines 430–490)

```
async fn user_shell_command_output_is_truncated_in_history() -> anyhow::Result<()>
```

**Purpose**: Verifies that large user shell command output is truncated when persisted into history for later model turns.

**Data flow**: It builds a test with `tool_output_token_limit = Some(100)`, runs a command producing 400 numbered lines, waits for successful `ExecCommandEnd` and `TurnComplete`, mounts a follow-up assistant response, submits another turn, extracts the `<user_shell_command>` history block from the captured request, constructs the expected truncated body with warning header, total line count, preserved head and tail, escapes it for regex use, and asserts the serialized history matches.

**Call relations**: This test focuses on history serialization rather than the immediate shell-command event stream, complementing the persistence test above.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 7 external calls (assert_eq!, assert_regex_match, wait_for_event, wait_for_event_match, format!, escape, vec!).


##### `user_shell_command_is_truncated_only_once`  (lines 493–554)

```
async fn user_shell_command_is_truncated_only_once() -> anyhow::Result<()>
```

**Purpose**: Guards against double-truncation by ensuring shell-command output forwarded to the model contains only one truncation header.

**Data flow**: It builds a test with `tool_output_token_limit = Some(100)`, mounts a model `shell_command` tool call that produces very large output, then assistant completion, submits a turn with disabled permissions, extracts the function-call output text from the second request, counts occurrences of `Total output lines:`, and asserts the count is exactly one.

**Call relations**: This regression test targets the interaction between shell-command output generation and later forwarding, ensuring truncation is applied once in the pipeline.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (assert_eq!, cfg!, json!, skip_if_no_network!, vec!).


### `core/tests/suite/view_image.rs`

`test` · `request construction and tool execution during multimodal integration tests`

This Unix-only file is the main specification for image attachment behavior. It covers two related paths: direct `UserInput::LocalImage` attachments on user turns, and model-invoked `view_image` tool calls that read an image from a selected environment and return an `input_image` content item. The helper layer builds disabled-permission turns (`disabled_user_turn`), finds image-bearing messages in request JSON, synthesizes PNG bytes with `image` crate primitives, and writes files/directories through the test filesystem abstraction.

The tests validate resizing policies under both legacy and `Feature::ResizeAllImages` modes, including horizontal and vertical aspect-ratio cases. For `view_image`, they assert emitted item lifecycle events, legacy `ViewImageToolCall` events, exact output content-item shapes, local vs remote environment routing, sandbox read-deny enforcement, support for `detail: "original"` only on capable models, rejection of unsupported detail values, treatment of `null` detail as omitted, and clear errors for directories, missing files, non-image files, and text-only models. One test verifies that invalid images become a placeholder text item when `ResizeAllImages` is enabled; another, in non-debug builds, simulates a 400 bad-request response from the upstream API and confirms the client retries without the invalid image, replacing it with a plain `Invalid image` user message. Across the file, request-body inspection is used heavily to prove exactly what image payloads are sent upstream.

#### Function details

##### `disabled_user_turn`  (lines 76–99)

```
fn disabled_user_turn(test: &TestCodex, items: Vec<UserInput>, model: String) -> Op
```

**Purpose**: Builds a standard `Op::UserInput` turn with disabled permissions and a specified model, suitable for image-attachment tests.

**Data flow**: It derives sandbox and permission fields from `PermissionProfile::Disabled` and `test.config.cwd`, then constructs `Op::UserInput` with the provided `UserInput` items, `AskForApproval::Never`, and a default collaboration mode carrying the supplied model string. It returns the operation without submitting it.

**Call relations**: Most tests in the file call this helper before `codex.submit(...)` so they can focus on image-specific setup rather than turn boilerplate.

*Call graph*: calls 1 internal fn (turn_permission_fields); called by 13 (assert_user_turn_local_image_resizes_to, replaces_invalid_local_image_after_bad_request, resize_all_images_turns_invalid_view_image_into_placeholder, view_image_tool_attaches_local_image, view_image_tool_can_preserve_original_resolution_when_requested_on_gpt5_3_codex, view_image_tool_does_not_force_original_resolution_with_capability_only, view_image_tool_errors_clearly_for_unsupported_detail_values, view_image_tool_errors_for_non_image_files, view_image_tool_errors_when_file_missing, view_image_tool_errors_when_path_is_directory (+3 more)); 1 external calls (default).


##### `image_messages`  (lines 101–122)

```
fn image_messages(body: &Value) -> Vec<&Value>
```

**Purpose**: Extracts request `message` items whose content array contains at least one `input_image` span.

**Data flow**: It reads a JSON request body, looks under `input`, filters array elements where `type == "message"` and some content span has `type == "input_image"`, and returns a `Vec<&Value>` of matching message items.

**Call relations**: This helper underlies `find_image_message` and is used to inspect whether image content was attached to an upstream request.

*Call graph*: called by 1 (find_image_message); 1 external calls (get).


##### `find_image_message`  (lines 124–126)

```
fn find_image_message(body: &Value) -> Option<&Value>
```

**Purpose**: Returns the first image-bearing message from a request body, if any.

**Data flow**: It delegates to `image_messages(body)` and returns the first element from the resulting vector.

**Call relations**: Tests use this helper when they only care whether one image message exists or not, especially for direct local-image attachments and invalid-image replacement.

*Call graph*: calls 1 internal fn (image_messages); called by 1 (assert_user_turn_local_image_resizes_to).


##### `png_bytes`  (lines 128–133)

```
fn png_bytes(width: u32, height: u32, rgba: [u8; 4]) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Generates an in-memory PNG of a solid RGBA color with the requested dimensions.

**Data flow**: It creates an `ImageBuffer` filled with the provided `Rgba` pixel, wraps it in `DynamicImage::ImageRgba8`, writes it as PNG into a `Cursor<Vec<u8>>`, and returns the resulting byte vector.

**Call relations**: Fixture-writing helpers and environment-routing tests use this to create deterministic image files without external assets.

*Call graph*: calls 1 internal fn (new); called by 4 (view_image_routes_to_selected_local_environment, view_image_routes_to_selected_remote_environment, view_image_tool_applies_local_sandbox_read_denies, write_workspace_png); 4 external calls (ImageRgba8, from_pixel, new, Rgba).


##### `create_workspace_directory`  (lines 135–146)

```
async fn create_workspace_directory(test: &TestCodex, rel_path: &str) -> anyhow::Result<PathBuf>
```

**Purpose**: Creates a directory inside the test workspace through the filesystem abstraction.

**Data flow**: It joins the relative path onto `test.config.cwd`, converts it to `PathUri`, calls `test.fs().create_directory` with `recursive: true`, and returns the absolute `PathBuf`.

**Call relations**: Only the directory-error test uses this helper to create a path that exists but is not a file.

*Call graph*: calls 2 internal fn (fs, from_path); called by 1 (view_image_tool_errors_when_path_is_directory).


##### `write_workspace_file`  (lines 148–169)

```
async fn write_workspace_file(
    test: &TestCodex,
    rel_path: &str,
    contents: Vec<u8>,
) -> anyhow::Result<PathBuf>
```

**Purpose**: Writes arbitrary bytes to a workspace file, creating parent directories through the filesystem abstraction as needed.

**Data flow**: It joins the relative path onto the workspace cwd, creates the parent directory if present, converts paths to `PathUri`, writes the provided bytes with `test.fs().write_file`, and returns the absolute path.

**Call relations**: Several tests use this helper for non-image fixtures, denied-image fixtures, and as the underlying implementation for `write_workspace_png`.

*Call graph*: calls 2 internal fn (fs, from_path); called by 5 (resize_all_images_turns_invalid_view_image_into_placeholder, view_image_routes_to_selected_local_environment, view_image_tool_applies_local_sandbox_read_denies, view_image_tool_errors_for_non_image_files, write_workspace_png).


##### `write_workspace_png`  (lines 171–179)

```
async fn write_workspace_png(
    test: &TestCodex,
    rel_path: &str,
    width: u32,
    height: u32,
    rgba: [u8; 4],
) -> anyhow::Result<PathBuf>
```

**Purpose**: Convenience wrapper that writes a generated PNG fixture into the workspace.

**Data flow**: It calls `png_bytes` with the requested dimensions and color, then passes the resulting bytes to `write_workspace_file`, returning the absolute path.

**Call relations**: Most `view_image` tests use this helper to create image fixtures with known dimensions.

*Call graph*: calls 2 internal fn (png_bytes, write_workspace_file); called by 8 (replaces_invalid_local_image_after_bad_request, view_image_tool_attaches_local_image, view_image_tool_can_preserve_original_resolution_when_requested_on_gpt5_3_codex, view_image_tool_does_not_force_original_resolution_with_capability_only, view_image_tool_errors_clearly_for_unsupported_detail_values, view_image_tool_resizes_when_model_lacks_original_detail_support, view_image_tool_returns_unsupported_message_for_text_only_model, view_image_tool_treats_null_detail_as_omitted).


##### `assert_user_turn_local_image_resizes_to`  (lines 181–264)

```
async fn assert_user_turn_local_image_resizes_to(
    original_dimensions: (u32, u32),
    expected_dimensions: (u32, u32),
    resize_policy: TestImageResizePolicy,
) -> anyhow::Result<()>
```

**Purpose**: Shared assertion helper for direct `UserInput::LocalImage` uploads, verifying the attached image is resized to the expected dimensions before being sent upstream.

**Data flow**: It starts a mock server, optionally enables `Feature::ResizeAllImages`, builds a test, creates a temporary local PNG file with the original dimensions, mounts a simple assistant response, submits a disabled user turn containing `UserInput::LocalImage`, waits for `TurnComplete`, extracts the first image-bearing message from the captured request, decodes the base64 `data:image/png;base64,...` payload, loads it with `image`, and asserts the decoded dimensions equal `expected_dimensions`.

**Call relations**: Three top-level tests delegate to this helper to cover legacy horizontal resize, legacy vertical resize, and resize-all-images patch-budget behavior.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, find_image_message); called by 3 (resize_all_images_applies_patch_budget_to_local_user_image, user_turn_with_local_image_attaches_image, user_turn_with_vertical_local_image_resizes_to_square_bounds); 7 external calls (from_pixel, assert_eq!, wait_for_event_with_timeout, Rgba, load_from_memory, tempdir, vec!).


##### `user_turn_with_local_image_attaches_image`  (lines 273–278)

```
async fn user_turn_with_local_image_attaches_image() -> anyhow::Result<()>
```

**Purpose**: Checks the legacy resize behavior for a wide local image attached directly by the user.

**Data flow**: It skips without network, then delegates to `assert_user_turn_local_image_resizes_to((2304, 864), (2048, 768), Legacy)`.

**Call relations**: This is a thin scenario wrapper around the shared local-image resize helper.

*Call graph*: calls 1 internal fn (assert_user_turn_local_image_resizes_to); 1 external calls (skip_if_no_network!).


##### `user_turn_with_vertical_local_image_resizes_to_square_bounds`  (lines 281–290)

```
async fn user_turn_with_vertical_local_image_resizes_to_square_bounds() -> anyhow::Result<()>
```

**Purpose**: Checks the legacy resize behavior for a tall local image, ensuring it is constrained within square bounds.

**Data flow**: It delegates to `assert_user_turn_local_image_resizes_to((1024, 4096), (512, 2048), Legacy)` after the network skip.

**Call relations**: This complements the wide-image case by covering the vertical aspect-ratio branch.

*Call graph*: calls 1 internal fn (assert_user_turn_local_image_resizes_to); 1 external calls (skip_if_no_network!).


##### `resize_all_images_applies_patch_budget_to_local_user_image`  (lines 293–302)

```
async fn resize_all_images_applies_patch_budget_to_local_user_image() -> anyhow::Result<()>
```

**Purpose**: Verifies that enabling `ResizeAllImages` applies the newer patch-budget resize policy to direct local-image uploads.

**Data flow**: It delegates to `assert_user_turn_local_image_resizes_to((2048, 2048), (1600, 1600), AllImages)`.

**Call relations**: This is the feature-flag variant of the shared local-image resize test.

*Call graph*: calls 1 internal fn (assert_user_turn_local_image_resizes_to); 1 external calls (skip_if_no_network!).


##### `view_image_tool_attaches_local_image`  (lines 305–450)

```
async fn view_image_tool_attaches_local_image() -> anyhow::Result<()>
```

**Purpose**: Validates the normal `view_image` tool path for a local workspace image, including emitted item events and the exact returned content-item shape.

**Data flow**: It writes a workspace PNG, mounts an SSE response that asks for `view_image` on that path and a second assistant-completion response, submits a disabled text turn, collects `ItemStarted`, `ItemCompleted`, legacy `ViewImageToolCall`, and `TurnComplete` events, then inspects the second request. It asserts the started/completed items are `TurnItem::ImageView` with the correct call ID and absolute path, the legacy event matches, no separate image message was injected into the request body, the function-call output contains exactly one `input_image` item, and the decoded image payload was resized to `(2048, 768)`.

**Call relations**: This is the central positive-path `view_image` integration test, covering both event emission and request serialization.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 8 external calls (assert!, assert_eq!, wait_for_event_with_timeout, load_from_memory, panic!, json!, skip_if_no_network!, vec!).


##### `view_image_routes_to_selected_local_environment`  (lines 453–516)

```
async fn view_image_routes_to_selected_local_environment() -> anyhow::Result<()>
```

**Purpose**: Ensures `view_image` reads from the explicitly selected local environment when `environment_id` is `LOCAL_ENVIRONMENT_ID`.

**Data flow**: It writes `local.png` into the workspace, mounts a two-response sequence where the tool call includes `environment_id: LOCAL_ENVIRONMENT_ID`, submits a turn with only the local environment selected, then inspects the last request's function-call output and asserts it contains one content item whose `image_url` starts with `data:image/png;base64,`.

**Call relations**: This test isolates environment routing for local selections, distinct from the default local path and the remote-environment case.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, png_bytes, write_workspace_file); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `view_image_tool_applies_local_sandbox_read_denies`  (lines 519–592)

```
async fn view_image_tool_applies_local_sandbox_read_denies() -> anyhow::Result<()>
```

**Purpose**: Checks that `view_image` respects local filesystem sandbox deny rules and returns an error instead of attaching a denied image.

**Data flow**: It writes a workspace PNG, constructs a `FileSystemSandboxPolicy` with a deny entry for that exact path, wraps it in a `PermissionProfile`, mounts a `view_image` tool call, submits a turn with that permission profile, and inspects the resulting request. It asserts no `input_image` items were attached and that the function-call output text starts with either `unable to locate image at ...` or `unable to read image at ...` for the denied path.

**Call relations**: This is the local-sandbox enforcement test for `view_image`, complementing the broader unified-exec sandbox tests in another file.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, png_bytes, write_workspace_file, from_runtime_permissions, default); 4 external calls (assert!, format!, skip_if_no_network!, vec!).


##### `view_image_routes_to_selected_remote_environment`  (lines 595–695)

```
async fn view_image_routes_to_selected_remote_environment() -> anyhow::Result<()>
```

**Purpose**: Verifies that `view_image` can read from a selected remote environment rather than the local cwd when `environment_id` targets the remote environment.

**Data flow**: It requires a remote test environment, builds a test with both remote and local envs, creates a misleading local `remote.png`, creates a remote cwd and writes a real PNG there through `test.fs()`, mounts a `view_image` call with `environment_id: REMOTE_ENVIRONMENT_ID`, submits a turn selecting both local and remote environments, inspects the last request's function-call output for a base64 image URL, and finally removes the remote directory.

**Call relations**: This test is the remote-routing counterpart to the local-environment test and proves environment selection affects file resolution.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, local, test_codex, png_bytes, from_abs_path, from_path); 10 external calls (from, new, assert!, assert_eq!, get_remote_test_env, format!, write, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `view_image_tool_can_preserve_original_resolution_when_requested_on_gpt5_3_codex`  (lines 698–787)

```
async fn view_image_tool_can_preserve_original_resolution_when_requested_on_gpt5_3_codex() -> anyhow::Result<()>
```

**Purpose**: Checks that on a model supporting original image detail, `view_image` honors `detail: "original"` and preserves the source dimensions.

**Data flow**: It builds a test with model `gpt-5.3-codex`, writes a large PNG, mounts a `view_image` call with `detail: "original"`, submits a disabled text turn, waits for completion, inspects the function-call output, asserts the single content item has `detail == "original"`, decodes the image payload, and asserts the dimensions equal the original `2304x864`.

**Call relations**: This is the positive capability-dependent branch for original-detail support.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (assert_eq!, wait_for_event_with_timeout, load_from_memory, json!, skip_if_no_network!, vec!).


##### `view_image_tool_errors_clearly_for_unsupported_detail_values`  (lines 790–865)

```
async fn view_image_tool_errors_clearly_for_unsupported_detail_values() -> anyhow::Result<()>
```

**Purpose**: Ensures unsupported `detail` values produce a clear textual error and no image attachment.

**Data flow**: It builds a `gpt-5.3-codex` test, writes a PNG, mounts a `view_image` call with `detail: "low"`, submits the turn, waits for completion, reads the function-call output text from the captured request, and asserts it exactly matches the explanatory error about only supporting `high` or `original`. It also asserts no image message was injected into the request body.

**Call relations**: This test covers argument validation before any image payload is produced.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (assert!, assert_eq!, wait_for_event_with_timeout, json!, skip_if_no_network!, vec!).


##### `view_image_tool_treats_null_detail_as_omitted`  (lines 868–955)

```
async fn view_image_tool_treats_null_detail_as_omitted() -> anyhow::Result<()>
```

**Purpose**: Checks that `detail: null` is treated the same as omitting the field, yielding the default high-detail resized image.

**Data flow**: It builds a `gpt-5.3-codex` test, writes a large PNG, mounts a `view_image` call with `detail: null`, submits the turn, waits for completion, inspects the single output content item, asserts `detail == "high"`, decodes the image payload, and asserts resized dimensions `(2048, 768)`.

**Call relations**: This test distinguishes explicit `null` from unsupported string values, documenting the normalization behavior.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (assert_eq!, wait_for_event_with_timeout, load_from_memory, json!, skip_if_no_network!, vec!).


##### `view_image_tool_resizes_when_model_lacks_original_detail_support`  (lines 958–1048)

```
async fn view_image_tool_resizes_when_model_lacks_original_detail_support() -> anyhow::Result<()>
```

**Purpose**: Verifies that on a model without original-detail support, `view_image` still returns a resized high-detail image rather than preserving original resolution.

**Data flow**: It builds a `gpt-5.2` test, writes a large PNG, mounts a normal `view_image` call, submits the turn, waits for completion, inspects the output content item, asserts `detail == "high"`, decodes the image payload, and checks dimensions `(2048, 768)`.

**Call relations**: This is the lower-capability counterpart to the original-detail preservation test.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (assert_eq!, wait_for_event_with_timeout, load_from_memory, json!, skip_if_no_network!, vec!).


##### `view_image_tool_does_not_force_original_resolution_with_capability_only`  (lines 1051–1139)

```
async fn view_image_tool_does_not_force_original_resolution_with_capability_only() -> anyhow::Result<()>
```

**Purpose**: Ensures that merely using a model capable of original detail does not force original resolution unless the request explicitly asks for it.

**Data flow**: It builds a `gpt-5.3-codex` test, writes a large PNG, mounts a `view_image` call without `detail`, submits the turn, waits for completion, inspects the output content item, asserts `detail == "high"`, decodes the payload, and confirms resized dimensions `(2048, 768)`.

**Call relations**: This test complements the explicit `detail: "original"` case by proving capability alone does not change default behavior.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (assert_eq!, wait_for_event_with_timeout, load_from_memory, json!, skip_if_no_network!, vec!).


##### `view_image_tool_errors_when_path_is_directory`  (lines 1142–1209)

```
async fn view_image_tool_errors_when_path_is_directory() -> anyhow::Result<()>
```

**Purpose**: Checks that `view_image` returns a clear error when the requested path exists but is a directory.

**Data flow**: It creates a workspace directory `assets`, mounts a `view_image` call for that path, submits a disabled text turn, waits for completion, reads the function-call output text, and asserts it equals `image path `<abs>` is not a file`. It also asserts no image message was attached.

**Call relations**: This test covers path-type validation after existence resolution but before image decoding.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, create_workspace_directory, disabled_user_turn); 7 external calls (assert!, assert_eq!, wait_for_event_with_timeout, format!, json!, skip_if_no_network!, vec!).


##### `view_image_tool_errors_for_non_image_files`  (lines 1212–1286)

```
async fn view_image_tool_errors_for_non_image_files() -> anyhow::Result<()>
```

**Purpose**: Ensures non-image files produce an unsupported-image error rather than being attached as images.

**Data flow**: It writes a JSON file into the workspace, mounts a `view_image` call for that path, submits the turn, waits for completion, asserts the request contains no `input_image` items, extracts the function-call output text and success flag, asserts success is `None`, and checks the error mentions unsupported image `application/json` for the absolute path.

**Call relations**: This test covers MIME/type validation during image processing.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_file); 7 external calls (assert!, assert_eq!, wait_for_event_with_timeout, format!, json!, skip_if_no_network!, vec!).


##### `resize_all_images_turns_invalid_view_image_into_placeholder`  (lines 1289–1352)

```
async fn resize_all_images_turns_invalid_view_image_into_placeholder() -> anyhow::Result<()>
```

**Purpose**: Verifies that with `ResizeAllImages` enabled, an invalid `view_image` target is converted into a placeholder text content item instead of a hard error.

**Data flow**: It enables `Feature::ResizeAllImages`, writes an invalid JSON file, mounts a `view_image` call and assistant completion, submits a disabled text turn, waits for completion, and asserts the function-call output's `output` field equals a one-element array containing `{ "type": "input_text", "text": "image content omitted because it could not be processed" }`.

**Call relations**: This test documents the feature-flagged fallback behavior that differs from the normal non-image error path.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_file); 5 external calls (assert_eq!, wait_for_event_with_timeout, json!, skip_if_no_network!, vec!).


##### `view_image_tool_errors_when_file_missing`  (lines 1355–1426)

```
async fn view_image_tool_errors_when_file_missing() -> anyhow::Result<()>
```

**Purpose**: Checks that missing image paths produce a locate/read error and no image attachment.

**Data flow**: It computes an absolute path for a nonexistent workspace file, mounts a `view_image` call for the relative path, submits the turn, waits for completion, extracts the function-call output text, and asserts it starts with `unable to locate image at `<abs>`:`. It also asserts no image message was attached.

**Call relations**: This is the missing-file branch of `view_image` error handling.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn); 6 external calls (assert!, wait_for_event_with_timeout, format!, json!, skip_if_no_network!, vec!).


##### `view_image_tool_returns_unsupported_message_for_text_only_model`  (lines 1429–1554)

```
async fn view_image_tool_returns_unsupported_message_for_text_only_model() -> anyhow::Result<()>
```

**Purpose**: Verifies that `view_image` is rejected up front when the selected model supports only text input modalities.

**Data flow**: It starts a raw `MockServer`, mounts a `/models` response containing a custom text-only `ModelInfo`, builds a test authenticated with dummy ChatGPT auth and configured to use that model slug, writes a PNG, mounts a `view_image` call and assistant completion, submits a disabled text turn, waits for completion, and asserts the function-call output text is exactly `view_image is not allowed because you do not support image inputs`.

**Call relations**: This test bypasses `start_mock_server` so the first model lookup returns the custom text-only model, preventing fallback metadata from incorrectly enabling image support.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_once, sse, test_codex, disabled_user_turn, write_workspace_png, create_dummy_chatgpt_auth_for_testing, bytes); 9 external calls (Limited, default, builder, new, assert_eq!, wait_for_event_with_timeout, json!, skip_if_no_network!, vec!).


##### `replaces_invalid_local_image_after_bad_request`  (lines 1558–1630)

```
async fn replaces_invalid_local_image_after_bad_request() -> anyhow::Result<()>
```

**Purpose**: In release-style builds, simulates an upstream 400 invalid-image response and verifies the client retries without the image, replacing it with a plain `Invalid image` user message.

**Data flow**: It mounts a response matcher that returns HTTP 400 with a fixed invalid-image error whenever the request body contains `"input_image"`, then mounts a successful SSE completion response. It writes a PNG fixture, submits a disabled user turn containing `UserInput::LocalImage`, waits for completion, inspects the first failed request to confirm it contained an image message, then inspects the second request to confirm no image message remains and one of the user texts equals `Invalid image`.

**Call relations**: This test covers a recovery path after upstream rejection, distinct from local preprocessing failures handled elsewhere in the file.

*Call graph*: calls 7 internal fn (mount_response_once_match, mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (new, assert!, wait_for_event_with_timeout, skip_if_no_network!, vec!, body_string_contains).
