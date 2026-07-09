# Tool, shell/exec, MCP/app, plugin, and runtime item suites  `stage-23.2.4.6`

This stage is a broad end-to-end safety check for Codex’s tool system, the part of the main work loop where the model asks the program to do real things. The tool tests check which tools are shown to the model, how custom tools run, and how blocked or unsafe actions are reported. The shell and exec suites cover local commands, long-running sessions, login shells, pipes, timeouts, Unicode, macOS sandbox limits, user-typed commands, aborts, saved shell setup, parallel tool calls, and readable result formatting. The patch tests make sure file edits are applied clearly and stay inside the workspace. Other suites check large-output truncation, image viewing and generation permissions, and file upload routing for app-style MCP tools, meaning external tools connected through a shared protocol. Plugin and search tests verify that Codex can discover plugins, apps, install options, and hidden tools only when needed. Code mode tests the JavaScript-like exec path that can call other tools. Finally, item tests make sure messages, reasoning, plans, searches, images, and tool events are emitted in the right user-visible stream.

## Files in this stage

### Tool execution foundations
These suites establish the baseline harness, exposure rules, and core execution paths for built-in shell, exec, and apply-patch tooling.

### `core/tests/suite/tools.rs`

`test` · `test run`

This is a non-Windows test file for Codex's tool system. In Codex, a "tool" is an action the assistant can ask the app to perform, such as running a shell command, applying a patch, or updating a plan. These tests use a fake server that pretends to be the model API. The fake server sends scripted events, such as "call this tool," and the test checks what Codex sends back.

The file covers several important safety and reliability cases. It checks that environment-backed tools, like command execution, disappear when a turn explicitly has no environments, but remain available when a local environment is selected. It checks that an unknown custom tool returns a clear error message. It also tests shell command behavior: requests for escalated permissions are rejected when approvals are disabled, sandbox-denied commands return the real command output and denial details, deny rules based on filename patterns prevent secrets from being read, and command timeouts are reported without hanging.

A small helper, `tool_names`, reads the outgoing request body and extracts the advertised tool names. Another helper, `collect_tools`, runs a miniature conversation and returns the tool list so a feature flag can be tested end to end. Overall, this file acts like a safety checklist for the bridge between model requests and real machine actions.

#### Function details

##### `tool_names`  (lines 37–52)

```
fn tool_names(body: &Value) -> Vec<String>
```

**Purpose**: This helper pulls the names of tools out of a JSON request body. Tests use it to check which tools Codex advertised to the model.

**Data flow**: It receives a JSON value, looks for a `tools` array, then reads each tool's `name` field or, if that is missing, its `type` field. It returns a list of plain strings; if the JSON has no usable tools list, it returns an empty list.

**Call relations**: The tool-list tests call this after the mock server records a request from Codex. It turns that recorded request into simple names that assertions can compare, and it is also used by `collect_tools` for the feature-flag test.

*Call graph*: called by 3 (collect_tools, empty_turn_environments_omits_environment_backed_tools, turn_environment_selection_keeps_environment_backed_tools); 1 external calls (get).


##### `empty_turn_environments_omits_environment_backed_tools`  (lines 55–93)

```
async fn empty_turn_environments_omits_environment_backed_tools() -> Result<()>
```

**Purpose**: This test proves that if a user turn explicitly says there are no usable environments, Codex does not offer tools that need an environment, such as shell execution. It also confirms that ordinary tools not tied to an environment still remain available.

**Data flow**: The test starts a fake model server, enables the unified execution feature, and submits a turn with an empty environment list. It then reads the request Codex sent to the fake server, extracts the tool names, and checks that `update_plan` is present while environment-backed tools like `exec_command`, `write_stdin`, `apply_patch`, and `view_image` are absent.

**Call relations**: The test uses the mock response helpers to make the fake server complete the conversation. After Codex sends its request, it hands the recorded JSON to `tool_names` so the test can inspect the advertised tools.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_names); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `turn_environment_selection_keeps_environment_backed_tools`  (lines 96–131)

```
async fn turn_environment_selection_keeps_environment_backed_tools() -> Result<()>
```

**Purpose**: This test checks the opposite case from the empty-environment test: when a local environment is selected, environment-backed tools should be available. It makes sure Codex does not hide the command execution tool when it has a place to run it.

**Data flow**: The test starts a fake server, enables unified execution, builds a Codex test instance, and submits a turn with one local environment. It reads the outgoing request, extracts its tool names, and asserts that `exec_command` is included.

**Call relations**: Like the related environment test, it relies on the mock server helpers to capture Codex's request. It then calls `tool_names` to turn the request body into a simple list for the assertion.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_names); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `custom_tool_unknown_returns_custom_output_error`  (lines 134–178)

```
async fn custom_tool_unknown_returns_custom_output_error() -> Result<()>
```

**Purpose**: This test makes sure Codex responds safely when the model asks for a custom tool that Codex does not know about. Instead of crashing or silently ignoring it, Codex sends back a clear error message as the tool output.

**Data flow**: The fake server first sends a custom tool call named `unsupported_tool`. Codex runs the turn with approvals disabled and permissions disabled, then sends a follow-up request containing the tool result. The test reads that result and checks that the output says the custom tool call is unsupported.

**Call relations**: The test script is driven by two mocked server responses: one to request the unknown tool and one to finish the conversation. It inspects the second request, where Codex reports the custom tool output back to the model.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (assert_eq!, format!, skip_if_no_network!, vec!).


##### `shell_command_escalated_permissions_rejected_then_ok`  (lines 181–272)

```
async fn shell_command_escalated_permissions_rejected_then_ok() -> Result<()>
```

**Purpose**: This test checks that Codex refuses a shell command that asks for escalated permissions when the approval policy says never ask for approval. It also verifies that a later normal shell command can still run successfully.

**Data flow**: The fake server first asks Codex to run `echo shell ok` with a setting that requires escalated sandbox permissions. Codex rejects that request and sends the rejection text back. The fake server then asks for the same command without escalation, and Codex runs it. The test checks both the rejection message and the successful command output.

**Call relations**: The test uses a sequence of mocked model interactions: blocked command, allowed command, then final assistant message. It checks the second recorded request for the blocked command's output and the third recorded request for the successful command's output.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (assert_eq!, assert_regex_match, format!, json!, skip_if_no_network!, vec!).


##### `sandbox_denied_shell_command_returns_original_output`  (lines 275–362)

```
async fn sandbox_denied_shell_command_returns_original_output() -> Result<()>
```

**Purpose**: This test ensures that when the sandbox blocks a shell command, Codex returns the command's real output and operating-system denial message, not a vague replacement message. This matters because the model needs useful details, but must not be allowed to bypass the sandbox.

**Data flow**: The test creates a command that prints a sentinel line, then tries to write to a file while running under a read-only permission profile. It submits the turn, captures the shell command output sent back to the fake server, parses the exit code, and checks for the sentinel text, the denied path, a permission-denied style message, and a non-zero exit code.

**Call relations**: The fake server asks for one shell command and then completes the conversation. The test reads the tool output captured by the mock server to confirm Codex faithfully forwarded the sandbox failure details.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_only); 6 external calls (assert!, assert_ne!, format!, json!, skip_if_no_network!, vec!).


##### `shell_command_enforces_glob_deny_read_policy`  (lines 365–467)

```
async fn shell_command_enforces_glob_deny_read_policy() -> Result<()>
```

**Purpose**: This test verifies that file access rules based on path patterns are enforced for shell commands. In particular, it checks that a `.env` file matching a deny rule cannot be read, while a nearby allowed file still can be read.

**Data flow**: The test configures a filesystem sandbox policy that denies access to `*.env` files under the test working directory. It writes one denied secret file and one allowed notes file, then asks Codex to run a command that tries to read both. The output must include the allowed file's text, must not include the secret, must show a denial message, and must have a non-zero exit code.

**Call relations**: This test sets up both the sandbox policy and the fixture files before the fake server requests the shell command. After Codex reports the command result back to the mock server, the test inspects that output for both safety and usefulness.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 9 external calls (assert!, assert_ne!, format!, create_dir_all, write, json!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `collect_tools`  (lines 469–503)

```
async fn collect_tools(use_unified_exec: bool) -> Result<Vec<String>>
```

**Purpose**: This helper runs a tiny fake conversation and returns the tool names Codex advertised. It exists so tests can compare tool availability with a feature switched on or off.

**Data flow**: It receives a boolean saying whether unified execution should be enabled. It starts a fake server, configures Codex with the feature enabled or disabled, submits a simple turn, reads the first recorded request body, and returns the extracted tool names.

**Call relations**: `unified_exec_spec_toggle_end_to_end` calls this twice, once with the feature disabled and once enabled. Inside, it uses the same mock server setup as the other tests and delegates JSON extraction to `tool_names`.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, tool_names); called by 1 (unified_exec_spec_toggle_end_to_end); 1 external calls (vec!).


##### `unified_exec_spec_toggle_end_to_end`  (lines 506–530)

```
async fn unified_exec_spec_toggle_end_to_end() -> Result<()>
```

**Purpose**: This test checks that the unified execution feature flag changes the tool list in the way users would actually experience. When the feature is off, unified execution tools should be missing; when it is on, they should appear.

**Data flow**: The test first calls `collect_tools` with unified execution disabled and confirms `exec_command` and `write_stdin` are absent. It then calls `collect_tools` with unified execution enabled and confirms both tools are present.

**Call relations**: This is a higher-level test built around the `collect_tools` helper. Rather than setting up its own fake server directly, it lets the helper run the conversation and simply checks the before-and-after tool lists.

*Call graph*: calls 1 internal fn (collect_tools); 2 external calls (assert!, skip_if_no_network!).


##### `shell_command_timeout_includes_timeout_prefix_and_metadata`  (lines 533–616)

```
async fn shell_command_timeout_includes_timeout_prefix_and_metadata() -> Result<()>
```

**Purpose**: This test checks that a shell command which runs too long is reported as a timeout in a useful way. The result should include timeout information and, when structured data is returned, the conventional timeout exit code `124`.

**Data flow**: The fake server asks Codex to run a command that produces output and then sleeps longer than the small timeout. The test reads the returned tool output. If it is JSON, it checks the metadata exit code and timeout text; if it is plain text, it accepts a formatted timeout report or, as a timing fallback, an execution error mentioning a signal.

**Call relations**: The mock server first sends the timeout-causing shell call and then receives Codex's tool output on the next request. The test uses regular-expression checks to allow small differences in timing and platform behavior while still requiring a clear timeout result.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (new, assert!, assert_eq!, assert_regex_match, json!, skip_if_no_network!, vec!).


##### `shell_command_timeout_handles_background_grandchild_stdout`  (lines 619–713)

```
async fn shell_command_timeout_handles_background_grandchild_stdout() -> Result<()>
```

**Purpose**: This test protects against a subtle hang: a command times out, but a detached child process keeps the output pipe open. Codex should still return shortly after the timeout instead of waiting forever.

**Data flow**: The test writes a small Python script that starts a detached long-running child process and then sleeps. It asks Codex to run that script with a short timeout and wraps the whole turn in a larger test timeout. It checks that Codex reports a timeout and that the total elapsed time stays under the safety limit, then tries to kill the leftover child process if its process ID was written down.

**Call relations**: The fake server asks for the shell command and later receives the timeout output from Codex. This test combines mock server inspection with real process timing, because the bug it guards against only appears when child processes and open output streams interact.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 13 external calls (from_secs, now, assert!, assert_eq!, assert_regex_match, format!, read_to_string, write, json!, kill (+3 more)).


### `core/tests/suite/tool_harness.rs`

`test` · `test run`

This is a test file for the “tool harness,” the part of Codex that receives a tool request from the model, runs the right local action, and sends the result back to the model. You can think of it like checking that a workshop assistant not only hears “use the hammer,” but picks up the hammer, uses it safely, reports what happened, and records any visible changes.

Each test starts a fake server that pretends to be the model API. The fake server sends scripted streaming events, such as “call the shell_command tool” or “apply this patch.” The test then sends normal user input into a temporary Codex session and watches the events Codex emits while it reacts.

The tests cover three important tool paths. The shell command test verifies that a command runs and its exit code, timing, and output are sent back. The plan tests verify that a valid plan becomes a PlanUpdate event, while malformed plan data is rejected and reported as an error. The patch tests verify that file edits really happen, that Codex emits begin/end and item status events, and that bad patch text produces useful diagnostics.

Without tests like these, Codex could silently stop executing tools, fail to notify the user interface, or send misleading results back to the model.

#### Function details

##### `call_output`  (lines 32–44)

```
fn call_output(req: &ResponsesRequest, call_id: &str) -> (String, Option<bool>)
```

**Purpose**: This helper pulls the result of a normal function-style tool call out of a recorded request to the mock server. It also checks that the returned record belongs to the expected tool call ID, so the tests do not accidentally inspect the wrong response.

**Data flow**: It receives a recorded response request and the expected call ID. It reads the raw function-call output for that ID, verifies the ID matches, extracts the text content and optional success flag, and returns those two pieces to the test. If the expected output is missing, the helper fails the test immediately.

**Call relations**: The shell command and plan-tool tests use this helper after Codex has finished a turn and sent tool results back to the fake server. It relies on the request-inspection methods from the test support layer, then hands the extracted text and success flag back to the test so the test can check the human-visible result.

*Call graph*: calls 2 internal fn (function_call_output, function_call_output_content_and_success); called by 3 (shell_command_tool_executes_command_and_streams_output, update_plan_tool_emits_plan_update_event, update_plan_tool_rejects_malformed_payload); 1 external calls (assert_eq!).


##### `custom_call_output`  (lines 46–58)

```
fn custom_call_output(req: &ResponsesRequest, call_id: &str) -> (String, Option<bool>)
```

**Purpose**: This helper is the custom-tool version of call_output. It extracts the result of a custom tool call, used here for apply_patch, and confirms that the result belongs to the intended call ID.

**Data flow**: It takes a recorded request and a call ID. It looks up the custom tool output in that request, confirms the embedded call ID is the same one the test asked for, extracts the output text and optional success flag, and returns them. Missing or mismatched data causes the test to fail.

**Call relations**: The apply-patch tests call this after Codex has processed a patch request and sent the result back to the mock server. It delegates the low-level lookup to the response test helpers, then gives the tests a simple text-and-success pair to assert on.

*Call graph*: calls 2 internal fn (custom_tool_call_output, custom_tool_call_output_content_and_success); called by 2 (apply_patch_reports_parse_diagnostics, apply_patch_tool_executes_and_emits_patch_events); 1 external calls (assert_eq!).


##### `shell_command_tool_executes_command_and_streams_output`  (lines 61–135)

```
async fn shell_command_tool_executes_command_and_streams_output() -> anyhow::Result<()>
```

**Purpose**: This test proves that when the model asks Codex to run a shell command, Codex actually runs it and reports the command result back. It specifically checks that command output is captured in the expected format.

**Data flow**: The test starts a mock model server, creates a temporary Codex session, and scripts the server to request the shell_command tool with an echo command. It submits a user message, waits until the turn is complete, then inspects the next request Codex sent to the server. The expected result is a tool output message containing exit code 0, a wall-clock duration, and the text printed by the command.

**Call relations**: This is a full integration-style test: it wires together the mock server, a test Codex session, local workspace selection, permission settings, and the response stream. After the main Codex flow sends tool output back to the model, the test uses call_output to read that returned output and verify it.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, call_output); 6 external calls (default, assert_regex_match, wait_for_event, json!, skip_if_no_network!, vec!).


##### `update_plan_tool_emits_plan_update_event`  (lines 138–230)

```
async fn update_plan_tool_emits_plan_update_event() -> anyhow::Result<()>
```

**Purpose**: This test checks that a valid update_plan tool call becomes a visible plan update event. That matters because user interfaces depend on these events to show the assistant’s current checklist or progress plan.

**Data flow**: The test scripts the fake server to ask for an update_plan call containing an explanation and two plan steps. It submits user input to Codex with local execution settings, then watches Codex events until the turn ends. Along the way, it expects a PlanUpdate event with the same explanation, step names, and statuses, and finally checks that Codex told the model “Plan updated.”

**Call relations**: The test drives Codex through the normal user-input path and listens to the event stream Codex produces. It uses the mock server helpers to provide the model’s tool call, waits for Codex’s PlanUpdate event, and then uses call_output to confirm the tool result was sent back to the server.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, call_output); 7 external calls (default, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `update_plan_tool_rejects_malformed_payload`  (lines 233–327)

```
async fn update_plan_tool_rejects_malformed_payload() -> anyhow::Result<()>
```

**Purpose**: This test makes sure Codex rejects a bad update_plan tool call instead of pretending it worked. It protects the user interface from showing an incomplete or invalid plan.

**Data flow**: The fake server sends an update_plan call that has an explanation but no actual plan data. The test submits user input, waits for the turn to complete, and records whether any PlanUpdate event appeared. The expected outcome is no plan update event, plus a tool output message that contains a parse error and, when available, a success flag set to false.

**Call relations**: This follows the same end-to-end route as the successful plan test, but with broken tool arguments. Codex receives the malformed call from the mock server, attempts to parse it, reports the failure back, and the test uses call_output to inspect that failure message.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, call_output); 6 external calls (default, assert!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `apply_patch_tool_executes_and_emits_patch_events`  (lines 330–470)

```
async fn apply_patch_tool_executes_and_emits_patch_events() -> anyhow::Result<()>
```

**Purpose**: This test verifies that the apply_patch custom tool really edits files and emits the events needed to show patch progress. It checks both the external report sent back to the model and the actual file contents on disk.

**Data flow**: The test creates a temporary workspace and scripts the mock server to request a patch that adds a new notes.txt file. After submitting user input, it watches Codex events for a file-change item starting, patch application beginning, patch application ending successfully, and the file-change item completing. It then inspects the tool output sent back to the model and reads the new file from disk to confirm the patch was applied.

**Call relations**: This test exercises the custom tool path rather than the normal function-call path. The fake server sends an apply_patch custom tool call, Codex runs the patch machinery and emits progress events, and the test uses custom_call_output to check the final report that Codex sends back.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, custom_call_output); 9 external calls (default, assert!, assert_eq!, assert_regex_match, wait_for_event, format!, read_to_string, skip_if_no_network!, vec!).


##### `apply_patch_reports_parse_diagnostics`  (lines 473–558)

```
async fn apply_patch_reports_parse_diagnostics() -> anyhow::Result<()>
```

**Purpose**: This test checks that a malformed patch does not fail silently. Instead, Codex should return a useful error message explaining that patch verification failed and pointing to the parse problem.

**Data flow**: The mock server sends an apply_patch custom tool call with patch text that is structurally invalid. The test submits user input, waits for the turn to finish, then reads the custom tool output Codex sent back. The expected result is text containing both a general apply_patch failure message and a more specific invalid-hunk diagnostic, with success marked false when that flag is present.

**Call relations**: This is the failure-case companion to the successful patch test. It sends the bad custom tool call through the same mock-server and Codex session path, then uses custom_call_output to inspect the error report returned to the model.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, custom_call_output); 5 external calls (default, assert!, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/exec.rs`

`test` · `test run on macOS`

This is a macOS-only test file for the project’s command-running feature. The project can run shell commands on behalf of the user, but it must do that safely. On macOS, that safety layer is Seatbelt, Apple’s sandbox system. These tests make sure the real execution path still works when that sandbox is active.

The file uses a shared helper to create a temporary working folder, build an execution request, and run it with a read-only permission profile. That is like giving a worker a desk to sit at, but not giving them permission to change anything on the desk. The tests then try several everyday command cases: a simple successful command, commands that produce many lines or many bytes of output, a missing command, and a Python program that opens a pseudo-terminal. A pseudo-terminal is a fake terminal device that some programs need in order to behave normally.

The most important safety test tries to create a file in the temporary folder. Because the command is supposed to run read-only, that write should fail and be treated as a sandbox violation. The file also skips all tests if it detects it is already running inside the Seatbelt sandbox, because putting one sandbox inside another can change the behavior being tested.

#### Function details

##### `skip_test`  (lines 18–25)

```
fn skip_test() -> bool
```

**Purpose**: This function decides whether the tests should be skipped because they are already running under the macOS Seatbelt sandbox. Skipping avoids confusing results from nested sandboxing, where the test sandbox and the outer sandbox can interfere with each other.

**Data flow**: It reads the process environment variable used by Codex to mark the active sandbox. If that variable says `seatbelt`, it prints a short message and returns `true`; otherwise it returns `false`. It does not change any project state.

**Call relations**: Each test calls this first as a gatekeeper. If it says to skip, the test returns immediately; if not, the test continues to create a temporary folder and run its sandboxed command.

*Call graph*: called by 6 (exit_code_0_succeeds, exit_command_not_found_is_ok, openpty_works_under_real_exec_seatbelt_path, truncates_output_bytes, truncates_output_lines, write_file_fails_as_sandbox_error); 2 external calls (eprintln!, var).


##### `run_test_cmd`  (lines 27–61)

```
async fn run_test_cmd(tmp: TempDir, command: I) -> Result<ExecToolCallOutput>
```

**Purpose**: This helper runs one command through the same execution machinery that the application uses, with macOS Seatbelt expected as the platform sandbox. It keeps the tests short and makes sure they all use the same read-only sandbox setup.

**Data flow**: It receives a temporary directory and a command expressed as a list of strings. It checks that the platform sandbox is macOS Seatbelt, turns the temporary directory into the command’s working folder, builds an execution request with shell-style output capture and read-only permissions, then awaits the command result. It returns either the captured command output or an error from the execution layer.

**Call relations**: The output-focused tests call this helper after their skip check. The helper then hands the prepared request to `process_exec_tool_call`, which is the real command execution path under test, and gives the result back to the individual test so it can make assertions.

*Call graph*: calls 2 internal fn (process_exec_tool_call, read_only); called by 5 (exit_code_0_succeeds, exit_command_not_found_is_ok, openpty_works_under_real_exec_seatbelt_path, truncates_output_bytes, truncates_output_lines); 6 external calls (new, into_iter, path, assert_eq!, get_platform_sandbox, from_ref).


##### `exit_code_0_succeeds`  (lines 65–77)

```
async fn exit_code_0_succeeds()
```

**Purpose**: This test proves that a simple successful command still works inside the sandbox. It uses `echo hello` as the plainest possible command that should succeed and produce predictable output.

**Data flow**: It first asks whether the test should be skipped. If not, it creates a temporary directory, builds the command `echo hello`, runs it through the shared helper, and checks that standard output contains `hello` followed by a newline, standard error is empty, and the output was not marked as truncated.

**Call relations**: This is one of the basic consumers of `skip_test` and `run_test_cmd`. It relies on the shared helper to exercise the real sandboxed execution path, then verifies the result at the test level.

*Call graph*: calls 2 internal fn (run_test_cmd, skip_test); 3 external calls (new, assert_eq!, vec!).


##### `truncates_output_lines`  (lines 81–97)

```
async fn truncates_output_lines()
```

**Purpose**: This test checks how the command runner records output when a command prints many lines. Despite the name, this particular case expects all 300 lines to be preserved without being marked as truncated.

**Data flow**: It skips if needed, creates a temporary directory, runs `seq 300`, and builds the exact text that should come back: the numbers 1 through 300, each on its own line. It compares that expected text with captured standard output and confirms there is no line-truncation marker.

**Call relations**: Like the other execution tests, it uses `skip_test` as the early safety gate and `run_test_cmd` to go through the real execution code. Its role in the wider flow is to confirm that normal multi-line output survives the sandboxed execution path.

*Call graph*: calls 2 internal fn (run_test_cmd, skip_test); 3 external calls (new, assert_eq!, vec!).


##### `truncates_output_bytes`  (lines 101–114)

```
async fn truncates_output_bytes()
```

**Purpose**: This test checks that a command producing a fairly large amount of text still returns its captured output correctly. It is aimed at byte volume rather than command success alone.

**Data flow**: It skips if necessary, creates a temporary directory, and runs a shell pipeline that prints 15 padded lines of about 1000 bytes each. After the command finishes, it checks that the captured standard output is at least 15,000 bytes long and that there is no line-truncation marker.

**Call relations**: The test depends on `run_test_cmd` to send the byte-heavy command through the sandboxed execution path. It then inspects the returned output to make sure the capture layer did not unexpectedly drop or flag this amount of data.

*Call graph*: calls 2 internal fn (run_test_cmd, skip_test); 4 external calls (new, assert!, assert_eq!, vec!).


##### `exit_command_not_found_is_ok`  (lines 118–126)

```
async fn exit_command_not_found_is_ok()
```

**Purpose**: This test confirms that a missing command is treated as an ordinary command failure, not as a sandbox failure. That matters because users can mistype commands, and the system should report that differently from a security block.

**Data flow**: It skips if needed, creates a temporary directory, and asks Bash to run a deliberately nonexistent command. It then runs that through the shared helper and expects the overall execution call to return successfully, even though the command itself exits with the usual “command not found” status.

**Call relations**: After the skip check, this test uses `run_test_cmd` to exercise the real execution layer. It is checking the boundary between normal process exit behavior and sandbox error reporting.

*Call graph*: calls 2 internal fn (run_test_cmd, skip_test); 2 external calls (new, vec!).


##### `openpty_works_under_real_exec_seatbelt_path`  (lines 129–157)

```
async fn openpty_works_under_real_exec_seatbelt_path()
```

**Purpose**: This test makes sure programs can still open and use a pseudo-terminal while running through the real macOS Seatbelt execution path. Some interactive tools depend on this kind of terminal-like device.

**Data flow**: It skips if needed, then looks for `python3` on the system. If Python is missing, it prints a message and returns. Otherwise it creates a temporary directory and runs a small Python script that opens a pseudo-terminal, writes `ping` to one side, and reads it back from the other. The test expects no standard output and no standard error.

**Call relations**: This test adds one extra setup step before using the common execution helper: it finds Python with the system path lookup. Once it has a Python executable, it calls `run_test_cmd` like the other tests and verifies that Seatbelt did not block this terminal-related operation.

*Call graph*: calls 2 internal fn (run_test_cmd, skip_test); 5 external calls (new, assert_eq!, eprintln!, vec!, which).


##### `write_file_fails_as_sandbox_error`  (lines 161–174)

```
async fn write_file_fails_as_sandbox_error()
```

**Purpose**: This test checks the core safety promise of the read-only sandbox: a command should not be allowed to create or modify files. If this test failed, it would mean sandboxed commands might be able to write where they should not.

**Data flow**: It first checks whether to skip. If it continues, it creates a temporary directory, chooses a file path inside it, and builds a `touch` command that would create that file. It then expects the attempted command run to produce an error, because writing is forbidden under the read-only sandbox setup.

**Call relations**: This is the negative safety test that balances the earlier success tests. The earlier tests show allowed behavior still works; this one verifies that forbidden file-writing behavior is stopped and surfaced as an error.

*Call graph*: calls 1 internal fn (skip_test); 3 external calls (new, assert!, vec!).


### `core/tests/suite/shell_command.rs`

`test` · `test run`

This is a test file. Its job is to make sure the shell-command tool behaves like a user would expect when the assistant asks to run a command on the machine. The tests use a harness, which is a controlled test setup, and a fake stream of server events. That fake stream tells Codex, “the model wants to call the shell_command tool with these arguments.” Codex then actually runs the command and the test checks what came back.

The file builds those fake model responses, mounts them on the test server, submits a user message, and then reads the recorded output for the tool call. The output is expected to include an exit code, a wall-clock running time, and the command’s printed text.

Several cases are covered because shells differ across systems. Some tests ask for a login shell, some do not. Some commands print one line, some print multiple lines, and some use a pipe. There is also a timeout test, which checks that a long-running command is stopped and reported as timed out. Unicode tests make sure non-ASCII text such as “naïve café” survives the trip through the shell, including on Windows PowerShell. Without these tests, small shell differences could silently break a core feature: letting the assistant run commands and show reliable results.

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

**Purpose**: Builds a fake sequence of model-server messages that asks Codex to run one shell command with a specific timeout. This lets tests control exactly what tool call Codex receives.

**Data flow**: It receives a tool-call id, a command string, an optional login-shell setting, and a timeout in milliseconds. It packages those values into JSON arguments, wraps them in server-sent event text, and returns a list of response chunks that the fake server can send to the harness.

**Call relations**: This is the low-level response builder. `shell_responses` uses it for the default timeout, while `mount_shell_responses_with_timeout` uses it when a test needs a custom timeout, such as the timeout and Unicode cases.

*Call graph*: called by 2 (mount_shell_responses_with_timeout, shell_responses); 3 external calls (json!, to_string, vec!).


##### `shell_responses`  (lines 56–58)

```
fn shell_responses(call_id: &str, command: &str, login: Option<bool>) -> Vec<String>
```

**Purpose**: Builds fake model responses for a shell command using the file’s normal default timeout. It is a convenience helper for tests that do not care about custom timing.

**Data flow**: It receives a call id, command, and optional login setting. It passes those values along with the default timeout to `shell_responses_with_timeout`, then returns the resulting fake response sequence.

**Call relations**: This sits between the simple mounting helper and the more detailed response builder. `mount_shell_responses` calls it when ordinary shell-command tests need fake model output.

*Call graph*: calls 1 internal fn (shell_responses_with_timeout); called by 1 (mount_shell_responses).


##### `shell_command_harness_with`  (lines 60–65)

```
async fn shell_command_harness_with(
    configure: impl FnOnce(TestCodexBuilder) -> TestCodexBuilder,
) -> Result<TestCodexHarness>
```

**Purpose**: Creates a test harness after giving the test a chance to customize the Codex builder. The harness is the controlled environment where the test can submit a prompt and inspect tool output.

**Data flow**: It starts from a standard test Codex builder, applies the caller’s configuration changes, then asynchronously creates a `TestCodexHarness`. The result is a ready-to-use test setup or an error if setup fails.

**Call relations**: Most tests call this near the beginning to create their environment, often only changing the model name. It hands the configured builder to `TestCodexHarness::with_builder`, which performs the actual setup.

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

**Purpose**: Installs the fake model responses for a shell command on the test server using the default timeout. This prepares the harness so the next submitted prompt triggers the desired tool call.

**Data flow**: It receives the harness, call id, command, and optional login setting. It asks `shell_responses` to build the fake response text, gets the harness’s server, and mounts that sequence there. It changes the fake server’s future behavior but returns no useful value.

**Call relations**: The basic shell-output tests call this before submitting a prompt. It connects the response-building helper to the test server by using `mount_sse_sequence`.

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

**Purpose**: Installs fake model responses for a shell command with a custom timeout. Tests use it when the exact timeout matters.

**Data flow**: It receives the harness, call id, command, optional login setting, and a `Duration` value. It converts the duration to milliseconds, builds the fake response sequence with that timeout, and mounts it on the harness server.

**Call relations**: The timeout test and Unicode tests call this before submitting a prompt. It hands the prepared event sequence to `mount_sse_sequence`, so the harness server will later tell Codex to run the chosen command.

*Call graph*: calls 3 internal fn (mount_sse_sequence, server, shell_responses_with_timeout); called by 3 (shell_command_times_out_with_timeout_ms, unicode_output, unicode_output_with_newlines); 1 external calls (as_millis).


##### `assert_shell_command_output`  (lines 90–103)

```
fn assert_shell_command_output(output: &str, expected: &str) -> Result<()>
```

**Purpose**: Checks that a successful shell command’s output has the expected shape and text. It accepts small timing differences by matching the wall time with a pattern.

**Data flow**: It receives the actual output string and the expected command output. It normalizes line endings so Windows and Unix-style newlines compare the same, builds a regular expression for the expected report, and asserts that the output matches. It returns success or a test error.

**Call relations**: Most successful command tests call this after reading the tool output from the harness. It delegates the final pattern check to `assert_regex_match`.

*Call graph*: called by 8 (multi_line_output_with_login, output_with_login, output_without_login, pipe_output_with_login, pipe_output_without_login, shell_command_works, unicode_output, unicode_output_with_newlines); 2 external calls (assert_regex_match, format!).


##### `shell_command_works`  (lines 106–125)

```
async fn shell_command_works() -> anyhow::Result<()>
```

**Purpose**: Tests the simplest shell-command path: the model asks Codex to run `echo 'hello, world'`, and Codex reports the text back successfully.

**Data flow**: It skips the test if networking is unavailable, creates a harness, mounts a fake model request for an echo command, submits a user prompt, reads the recorded tool output, and checks that it contains `hello, world` with exit code 0.

**Call relations**: This is the baseline test. It uses `shell_command_harness_with` to set up the environment, `mount_shell_responses` to prepare the fake model call, and `assert_shell_command_output` to verify the result.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 1 external calls (skip_if_no_network!).


##### `output_with_login`  (lines 128–141)

```
async fn output_with_login() -> anyhow::Result<()>
```

**Purpose**: Tests that a shell command still works when the model explicitly asks for a login shell. A login shell is a shell started as if the user had just logged in, often loading extra profile settings.

**Data flow**: It creates the harness, mounts a fake command request with `login` set to true, submits a prompt, reads the tool output, and checks that `hello, world` was printed successfully.

**Call relations**: This follows the same flow as the baseline test, but passes `Some(true)` through `mount_shell_responses`. That verifies the login-shell option does not break normal command execution.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 1 external calls (skip_if_no_network!).


##### `output_without_login`  (lines 144–157)

```
async fn output_without_login() -> anyhow::Result<()>
```

**Purpose**: Tests that a shell command works when the model explicitly asks not to use a login shell. This checks the other side of the login-shell option.

**Data flow**: It creates the harness, mounts a fake echo command with `login` set to false, submits a prompt, collects the tool output, and verifies the expected successful output.

**Call relations**: This mirrors `output_with_login`, but sends `Some(false)` through the response setup. It proves the non-login mode can also run a basic command.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 1 external calls (skip_if_no_network!).


##### `multi_line_output_with_login`  (lines 160–179)

```
async fn multi_line_output_with_login() -> anyhow::Result<()>
```

**Purpose**: Tests that command output containing more than one line is preserved correctly when using a login shell. This matters because many real commands print multi-line results.

**Data flow**: It prepares a harness and a fake model request for an echo command that prints two lines. After submitting the prompt, it reads the shell tool output and checks that both lines appear in order in the success report.

**Call relations**: This test uses the standard harness and response-mounting helpers, then relies on `assert_shell_command_output` to compare the normalized multi-line output.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 1 external calls (skip_if_no_network!).


##### `pipe_output_with_login`  (lines 182–202)

```
async fn pipe_output_with_login() -> anyhow::Result<()>
```

**Purpose**: Tests that shell syntax using a pipe works in the default login setting on non-Windows systems. A pipe sends the output of one command into another, like passing paper from one worker to the next.

**Data flow**: It skips if networking is unavailable or if the test is running on Windows. It sets up a command that pipes `echo` into `cat`, submits a prompt, reads the tool output, and checks that the final printed text is `hello, world`.

**Call relations**: This uses `shell_command_harness_with` and `mount_shell_responses` like the simpler tests, but adds `skip_if_windows` because pipe behavior and shell syntax differ enough on Windows that this case is only meant for Unix-like shells.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 2 external calls (skip_if_no_network!, skip_if_windows!).


##### `pipe_output_without_login`  (lines 205–219)

```
async fn pipe_output_without_login() -> anyhow::Result<()>
```

**Purpose**: Tests that piped shell commands work when the model explicitly disables login-shell mode, on non-Windows systems.

**Data flow**: It skips when networking is unavailable or the platform is Windows. It mounts a fake tool call for `echo 'hello, world' | cat` with `login` set to false, submits the prompt, reads the tool output, and verifies the expected successful text.

**Call relations**: This is the non-login companion to `pipe_output_with_login`. It uses the same helper chain, but sends `Some(false)` so the test covers the explicit non-login path.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses, shell_command_harness_with); 2 external calls (skip_if_no_network!, skip_if_windows!).


##### `shell_command_times_out_with_timeout_ms`  (lines 222–254)

```
async fn shell_command_times_out_with_timeout_ms() -> anyhow::Result<()>
```

**Purpose**: Tests that a long-running shell command is stopped when the model supplies a short timeout. This protects users from commands that hang forever.

**Data flow**: It chooses a sleep-like command appropriate for the operating system, mounts a fake model request with a 200 millisecond timeout, submits a prompt, then reads the tool output. Instead of expecting success, it checks for exit code 124 and a message saying the command timed out.

**Call relations**: This test uses `mount_shell_responses_with_timeout` because the timeout value is the point of the test. It performs its own regular-expression check rather than using `assert_shell_command_output`, because the expected result is a timeout report rather than a successful command report.

*Call graph*: calls 2 internal fn (mount_shell_responses_with_timeout, shell_command_harness_with); 4 external calls (from_millis, cfg!, assert_regex_match, skip_if_no_network!).


##### `unicode_output`  (lines 262–284)

```
async fn unicode_output(login: bool) -> anyhow::Result<()>
```

**Purpose**: Tests that Unicode text printed by a shell command is captured correctly. This is especially important on Windows, where PowerShell encoding can be tricky.

**Data flow**: It creates a harness, chooses a platform-appropriate command that prints `naïve_café`, mounts the command with either login enabled or disabled depending on the test case, submits the prompt, reads the output, and checks that the Unicode text survived unchanged.

**Call relations**: This parameterized test runs once with login mode and once without it. It uses `mount_shell_responses_with_timeout` with a medium timeout, then uses `assert_shell_command_output` for the final success check.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses_with_timeout, shell_command_harness_with); 2 external calls (cfg!, skip_if_no_network!).


##### `unicode_output_with_newlines`  (lines 289–309)

```
async fn unicode_output_with_newlines(login: bool) -> anyhow::Result<()>
```

**Purpose**: Tests that Unicode text is preserved even when it appears inside multi-line output. This catches bugs where encoding or newline handling only fails in more complex output.

**Data flow**: It creates a harness, mounts a fake request for a command that prints three lines including `naïve café`, submits the prompt, reads the tool output, and checks that all lines and Unicode characters are present in the expected order.

**Call relations**: Like `unicode_output`, this parameterized test runs for both login settings and uses the custom-timeout mounting helper. It finishes by calling `assert_shell_command_output`, which normalizes line endings before matching the result.

*Call graph*: calls 3 internal fn (assert_shell_command_output, mount_shell_responses_with_timeout, shell_command_harness_with); 1 external calls (skip_if_no_network!).


### `core/tests/suite/unified_exec.rs`

`test` · `test run`

Unified exec is the bridge between a model asking to run a command and the system actually starting, watching, and reporting on that command. These tests act like a safety checklist for that bridge. They set up a fake model server, feed Codex scripted tool calls such as `exec_command` and `write_stdin`, then watch what Codex sends back and what events it emits. The file covers simple commands, working-directory overrides, output truncation, terminal-style sessions, background processes, network denial, sandboxed file access, Ctrl+C behavior, and cleanup on shutdown. A good analogy is a theatre rehearsal: the fake server gives the actor its lines, and the tests make sure every cue, prop, and exit happens in the right order. Several helper functions parse the human-readable unified exec output into structured fields so the tests can assert on details like wall time, exit code, process ID, and truncated token counts. Without these tests, regressions in command execution could silently break important user-facing behavior, such as leaking denied file contents, losing output from long-running sessions, or failing to clean up processes.

#### Function details

##### `extract_output_text`  (lines 53–59)

```
fn extract_output_text(item: &Value) -> Option<&str>
```

**Purpose**: Pulls the text part out of a recorded tool-output JSON item. It supports both the older shape where output is a plain string and the newer shape where output is an object with a content field.

**Data flow**: It receives one JSON value, looks for its `output` field, and returns the contained text if it can find one. If the JSON does not contain output text in a known format, it returns nothing and leaves the input unchanged.

**Call relations**: When `collect_tool_outputs` scans mock server requests, it asks this helper to get the raw text before parsing the unified exec report. This keeps the request-scanning code from caring about small JSON format differences.

*Call graph*: called by 1 (collect_tool_outputs); 1 external calls (get).


##### `parse_unified_exec_output`  (lines 71–140)

```
fn parse_unified_exec_output(raw: &str) -> Result<ParsedUnifiedExecOutput>
```

**Purpose**: Turns the formatted text returned by unified exec into a structured record that tests can inspect. This lets tests ask clear questions like “what was the exit code?” instead of searching through one big string.

**Data flow**: It receives raw output text, matches it against the expected unified exec report format, and extracts optional chunk ID, wall time, process ID, exit code, original token count, and command output. It returns a parsed object or an error explaining which part could not be read.

**Call relations**: Many tests receive command output indirectly from the mock conversation. Helpers such as `collect_tool_outputs` and `wait_for_raw_unified_exec_output` call this parser before the test assertions compare metadata and output text.

*Call graph*: called by 4 (collect_tool_outputs, unified_exec_prunes_exited_sessions_first, wait_for_raw_unified_exec_output, write_stdin_ctrl_c_reports_unsupported_interrupt_to_model_on_windows); 1 external calls (new).


##### `collect_tool_outputs`  (lines 142–166)

```
fn collect_tool_outputs(bodies: &[Value]) -> Result<HashMap<String, ParsedUnifiedExecOutput>>
```

**Purpose**: Collects all unified exec tool outputs from the mock server’s recorded request bodies. It gives tests a map from tool call ID to parsed command result.

**Data flow**: It receives a list of JSON request bodies, walks through each body’s input items, keeps only function-call outputs, extracts their text, parses that text, and stores the parsed result by call ID. Empty outputs are ignored; malformed outputs return an error.

**Call relations**: After a test turn finishes, many tests call this helper on the mock server log. It delegates text extraction to `extract_output_text` and output parsing to `parse_unified_exec_output`, then hands structured results back to the test.

*Call graph*: calls 2 internal fn (extract_output_text, parse_unified_exec_output); called by 14 (assert_write_stdin_ctrl_c_interrupts_non_tty_session, exec_command_reports_chunk_and_exit_metadata, unified_exec_can_enable_tty, unified_exec_defaults_to_pipe, unified_exec_enforces_glob_deny_read_policy, unified_exec_formats_large_output_summary, unified_exec_python_prompt_under_seatbelt, unified_exec_respects_early_exit_notifications, unified_exec_reuses_session_via_stdin, unified_exec_runs_on_all_platforms (+4 more)); 1 external calls (new).


##### `wait_for_raw_unified_exec_output`  (lines 168–187)

```
async fn wait_for_raw_unified_exec_output(
    test: &TestCodex,
    call_id: &str,
) -> Result<ParsedUnifiedExecOutput>
```

**Purpose**: Waits until Codex emits a raw tool-output event for a specific call ID, then parses that output. It is useful when a test needs to inspect output as soon as it appears, not only after all server requests are collected.

**Data flow**: It receives a running test harness and a call ID, listens to Codex events until it sees the matching function-call output, converts the event’s text into a string, and parses it into a unified exec output record.

**Call relations**: The truncation-limit tests use this helper to catch the exact tool output for one call. It relies on the event-waiting support from the test framework and on `parse_unified_exec_output` for the final structured result.

*Call graph*: calls 1 internal fn (parse_unified_exec_output); called by 2 (exec_command_clamps_model_requested_max_output_tokens_to_policy, write_stdin_clamps_model_requested_max_output_tokens_to_policy); 1 external calls (wait_for_event_match).


##### `submit_unified_exec_turn`  (lines 189–225)

```
async fn submit_unified_exec_turn(
    test: &TestCodex,
    prompt: &str,
    permission_profile: PermissionProfile,
) -> Result<()>
```

**Purpose**: Starts a Codex turn with unified exec-friendly settings. It saves individual tests from repeating the same setup for permissions, sandboxing, approval policy, and model settings.

**Data flow**: It receives a test instance, a user prompt, and a permission profile. It converts the permission profile into the fields Codex expects, builds a user-input operation with approval disabled, applies the current model, submits it to Codex, and returns success or an error.

**Call relations**: Most tests use this as the standard way to begin a turn after mounting fake server responses. It calls the permission-field helper from the test support code, then hands the fully prepared operation to Codex.

*Call graph*: calls 1 internal fn (turn_permission_fields); called by 27 (assert_write_stdin_ctrl_c_interrupts_non_tty_session, exec_command_clamps_model_requested_max_output_tokens_to_policy, exec_command_reports_chunk_and_exit_metadata, unified_exec_can_enable_tty, unified_exec_defaults_to_pipe, unified_exec_emits_end_event_when_session_dies_via_stdin, unified_exec_emits_exec_command_begin_event, unified_exec_emits_exec_command_end_event, unified_exec_emits_one_begin_and_one_end_event, unified_exec_emits_output_delta_for_exec_command (+15 more)); 2 external calls (default, vec!).


##### `create_workspace_directory`  (lines 227–241)

```
async fn create_workspace_directory(
    test: &TestCodex,
    rel_path: impl AsRef<std::path::Path>,
) -> Result<std::path::PathBuf>
```

**Purpose**: Creates a directory inside the test workspace through Codex’s file-service path. This lets work-directory tests prepare folders the same way the running system would see them.

**Data flow**: It receives a test instance and a relative path, joins that path to the test workspace, converts it to a path URI, asks the file service to create the directory recursively, and returns the absolute path.

**Call relations**: The work-directory tests call this helper before asking unified exec to run a command in that directory. It bridges test setup and the file-system interface used by the application.

*Call graph*: calls 2 internal fn (fs, from_path); called by 2 (unified_exec_resolves_relative_workdir, unified_exec_respects_workdir_override); 1 external calls (as_ref).


##### `unified_exec_intercepts_apply_patch_exec_command`  (lines 244–384)

```
async fn unified_exec_intercepts_apply_patch_exec_command() -> Result<()>
```

**Purpose**: Checks that an `apply_patch` command sent through unified exec is treated as a patch operation, not as an ordinary shell command. This matters because patch application has special UI events and safety behavior.

**Data flow**: The test enables unified exec, scripts a fake model call that runs `apply_patch`, submits a user turn, watches events, and verifies patch-begin and patch-end events appear while normal exec begin/end events do not. It then checks the file was actually created with the expected contents.

**Call relations**: This test builds its own turn because it needs environment selections in addition to the usual permission settings. It uses the mock SSE response helpers to make the model request the patch, then observes Codex’s event stream and the harness’s captured tool output.

*Call graph*: calls 5 internal fn (mount_sse_sequence, with_builder, local_selections, test_codex, turn_permission_fields); 10 external calls (default, assert!, assert_eq!, wait_for_event, format!, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `unified_exec_emits_exec_command_begin_event`  (lines 387–448)

```
async fn unified_exec_emits_exec_command_begin_event() -> Result<()>
```

**Purpose**: Verifies that starting a unified exec command produces an `ExecCommandBegin` event. That event is what clients use to show that a command has started and where it is running.

**Data flow**: The test sets up a fake model call to run an echo command, submits a turn, waits for the begin event with the matching call ID, and checks the shell command and working directory recorded in the event.

**Call relations**: It uses `submit_unified_exec_turn` for the common turn setup and `assert_command` to validate the shell invocation. It finishes by waiting for the normal turn-complete event.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_command, submit_unified_exec_turn); 9 external calls (assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_resolves_relative_workdir`  (lines 451–521)

```
async fn unified_exec_resolves_relative_workdir() -> Result<()>
```

**Purpose**: Checks that a relative `workdir` argument is resolved against the turn’s current workspace directory. This prevents commands from accidentally running in the wrong place.

**Data flow**: The test creates a subdirectory, asks the fake model to run `pwd` with that relative directory as `workdir`, submits a turn, and inspects the command-begin event. The expected result is an absolute current directory matching the created folder.

**Call relations**: It prepares the folder with `create_workspace_directory`, starts the turn with `submit_unified_exec_turn`, and reads the result from Codex’s event stream.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, create_workspace_directory, submit_unified_exec_turn); 10 external calls (assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, from, vec!).


##### `unified_exec_respects_workdir_override`  (lines 524–586)

```
async fn unified_exec_respects_workdir_override() -> Result<()>
```

**Purpose**: Checks that an absolute `workdir` argument overrides the normal workspace directory for a command. Users and models rely on this when a command must run inside a specific folder.

**Data flow**: The test creates a directory, scripts a command with that directory as its requested workdir, submits the turn, and verifies the begin event reports that directory as the command’s current working directory. It also confirms the mock server received requests.

**Call relations**: It follows the same fake-server and turn-submission pattern as other unified exec tests, using `create_workspace_directory` for setup and Codex events for validation.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, create_workspace_directory, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `unified_exec_emits_exec_command_end_event`  (lines 589–661)

```
async fn unified_exec_emits_exec_command_end_event() -> Result<()>
```

**Purpose**: Verifies that a command eventually emits an `ExecCommandEnd` event with the exit code and accumulated output. This is the signal clients need to mark a command as finished.

**Data flow**: The fake model first starts a command that prints a marker, then polls the session. The test waits for the end event, checks that the exit code is zero, and confirms the output contains the marker text.

**Call relations**: It uses `submit_unified_exec_turn` to start the scripted exchange. The follow-up `write_stdin` call in the fake responses helps exercise the path that discovers a command has completed.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 10 external calls (assert!, assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_emits_output_delta_for_exec_command`  (lines 664–721)

```
async fn unified_exec_emits_output_delta_for_exec_command() -> Result<()>
```

**Purpose**: Checks that command output is available through execution events, not only in the final tool response. This supports live streaming in user interfaces.

**Data flow**: The test scripts a command that prints a marker, submits a turn, waits for the matching command-end event, and verifies the event’s stdout contains that marker.

**Call relations**: It relies on the fake server to request the command and on `submit_unified_exec_turn` for setup. The assertion focuses on the event emitted by Codex after execution.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 9 external calls (assert!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_full_lifecycle_with_background_end_event`  (lines 724–818)

```
async fn unified_exec_full_lifecycle_with_background_end_event() -> Result<()>
```

**Purpose**: Exercises the full lifecycle of a command that stays alive briefly and is completed by a background watcher. This protects the case where a process finishes after the immediate tool call has yielded.

**Data flow**: The test starts a delayed command, then keeps reading Codex events until it has seen the begin event, the turn completion, and exactly one end event. It checks that both begin and end events include a process ID and that final output includes the marker.

**Call relations**: It uses the standard mock-response flow and `submit_unified_exec_turn`. The event loop in the test confirms the background watcher completes the story after the command has been started.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_network_denial_emits_failed_background_end_event`  (lines 821–863)

```
async fn unified_exec_network_denial_emits_failed_background_end_event() -> Result<()>
```

**Purpose**: Checks that a long-running command blocked by managed network policy emits a failed end event. This ensures network denials are visible as command failures instead of hanging silently.

**Data flow**: The test builds a network-restricted Codex setup, scripts a Python command that tries to use the proxy to reach a denied host, submits the turn, and waits for the command-end event. It expects failed status, exit code -1, denial text in the output, and a process ID.

**Call relations**: It gets the special network setup from `unified_exec_network_denial_test`, mounts responses with `mount_unified_exec_network_denial_responses`, and waits using `wait_for_unified_exec_end`.

*Call graph*: calls 5 internal fn (start_mock_server, mount_unified_exec_network_denial_responses, submit_unified_exec_turn, unified_exec_network_denial_test, wait_for_unified_exec_end); 8 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!).


##### `unified_exec_short_lived_network_denial_emits_failed_end_event`  (lines 866–908)

```
async fn unified_exec_short_lived_network_denial_emits_failed_end_event() -> Result<()>
```

**Purpose**: Checks the same network-denial behavior for a command that fails quickly. Fast failures still need a clear failed end event.

**Data flow**: The test configures managed network restrictions, runs a short Python network request to a denied host, and waits for the unified exec end event. It checks failed status, exit code -1, denial wording, and that a process ID was associated with the command.

**Call relations**: Like the long-running denial test, it uses `unified_exec_network_denial_test`, `mount_unified_exec_network_denial_responses`, `submit_unified_exec_turn`, and `wait_for_unified_exec_end` to drive and observe the scenario.

*Call graph*: calls 5 internal fn (start_mock_server, mount_unified_exec_network_denial_responses, submit_unified_exec_turn, unified_exec_network_denial_test, wait_for_unified_exec_end); 8 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!).


##### `unified_exec_network_denial_test`  (lines 910–960)

```
async fn unified_exec_network_denial_test(
    server: &wiremock::MockServer,
) -> Result<(TestCodex, PermissionProfile)>
```

**Purpose**: Builds a test Codex instance configured for managed network restrictions. It gives the network-denial tests a realistic permission setup without duplicating configuration code.

**Data flow**: It creates a temporary home directory, writes a config file that enables limited managed network access, builds a permission profile, enables unified exec, builds Codex against the mock server, and returns the test instance plus the permission profile.

**Call relations**: The two network-denial tests call this helper before mounting their scripted model responses. It packages configuration, cloud network requirements, and assertions that the network proxy config is present.

*Call graph*: calls 2 internal fn (test_codex, workspace_write_with); called by 2 (unified_exec_network_denial_emits_failed_background_end_event, unified_exec_short_lived_network_denial_emits_failed_end_event); 5 external calls (new, new, assert!, managed_network_requirements_loader, write).


##### `mount_unified_exec_network_denial_responses`  (lines 962–980)

```
async fn mount_unified_exec_network_denial_responses(
    server: &wiremock::MockServer,
    call_id: &str,
    args: &Value,
) -> Result<core_test_support::responses::ResponseMock>
```

**Purpose**: Installs the fake model responses used by the network-denial tests. It makes the mock server ask Codex to run one command and then finish the turn.

**Data flow**: It receives the mock server, call ID, and command arguments, builds two server-sent-event responses, mounts them on the mock server, and returns the response mock so later code can inspect requests.

**Call relations**: The network-denial tests call this immediately after creating their command arguments. It uses the shared response-building helpers so those tests can focus on denial behavior.

*Call graph*: calls 1 internal fn (mount_sse_sequence); called by 2 (unified_exec_network_denial_emits_failed_background_end_event, unified_exec_short_lived_network_denial_emits_failed_end_event); 1 external calls (vec!).


##### `wait_for_unified_exec_end`  (lines 982–1018)

```
async fn wait_for_unified_exec_end(
    test: &TestCodex,
    call_id: &str,
    response_mock: &core_test_support::responses::ResponseMock,
) -> (codex_protocol::protocol::ExecCommandEndEvent, bool)
```

**Purpose**: Waits for a specific unified exec command-end event, with a timeout and helpful debugging information. It also notes whether the turn completed while waiting.

**Data flow**: It receives a test instance, call ID, and response mock, then repeatedly reads Codex events until the matching end event appears or 15 seconds pass. It records observed events for timeout messages and returns the end event plus a boolean for turn completion.

**Call relations**: The network-denial tests use this because those failures may arrive from background process watching. It reads directly from Codex’s event stream and uses the response mock only to improve timeout diagnostics.

*Call graph*: called by 2 (unified_exec_network_denial_emits_failed_background_end_event, unified_exec_short_lived_network_denial_emits_failed_end_event); 7 external calls (new, format!, matches!, panic!, from_secs, now, timeout).


##### `unified_exec_emits_terminal_interaction_for_write_stdin`  (lines 1021–1103)

```
async fn unified_exec_emits_terminal_interaction_for_write_stdin() -> Result<()>
```

**Purpose**: Checks that writing input to an interactive session produces a terminal-interaction event. This lets clients show what was sent to a live terminal.

**Data flow**: The test starts an interactive bash session, scripts a `write_stdin` call that sends an echo command, submits the turn, and watches for a terminal interaction tied to the original session. It verifies the process ID and stdin text match the write request.

**Call relations**: It uses the usual mock-server setup and `submit_unified_exec_turn`. The important handoff is from a `write_stdin` tool call to a user-visible `TerminalInteraction` event.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 8 external calls (assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_terminal_interaction_captures_delayed_output`  (lines 1106–1284)

```
async fn unified_exec_terminal_interaction_captures_delayed_output() -> Result<()>
```

**Purpose**: Verifies that repeated polls of a delayed interactive command capture both terminal interactions and delayed output. This protects against losing output that arrives after the first yield.

**Data flow**: The test starts a command that prints two markers several seconds apart, then sends three `write_stdin` polls. It collects begin, output-delta, terminal-interaction, end, and turn-complete events, then checks all polls were recorded and both markers appear in streamed and final output.

**Call relations**: It combines `submit_unified_exec_turn` with a longer manual event loop. The fake responses drive the sequence of startup and polling calls, while the test verifies Codex stitches them into one coherent session.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 12 external calls (from_utf8_lossy, new, new, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows! (+2 more)).


##### `unified_exec_emits_one_begin_and_one_end_event`  (lines 1287–1407)

```
async fn unified_exec_emits_one_begin_and_one_end_event() -> Result<()>
```

**Purpose**: Checks that a session startup plus a later empty poll does not create duplicate begin or end events. This avoids confusing clients with repeated lifecycle signals.

**Data flow**: The test starts a short command, follows it with an empty `write_stdin` poll, then counts begin events, end events, and terminal interactions for the original call ID. It expects one begin, one end, and no terminal interaction for the empty completed poll.

**Call relations**: It uses `assert_command` to confirm the startup command shape and `submit_unified_exec_turn` for the turn. Its event-counting loop validates the lifecycle contract.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_command, submit_unified_exec_turn); 9 external calls (new, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `exec_command_reports_chunk_and_exit_metadata`  (lines 1410–1502)

```
async fn exec_command_reports_chunk_and_exit_metadata() -> Result<()>
```

**Purpose**: Checks that completed `exec_command` output includes useful metadata: chunk ID, wall time, exit code, truncation notice, and original token count. This metadata helps the model and UI understand what happened.

**Data flow**: The test runs a command with output too large for the requested token limit, waits for turn completion, collects parsed tool outputs, and inspects the metadata fields. It expects a hex chunk ID, nonnegative wall time, no process ID for a completed process, exit code zero, and truncation details.

**Call relations**: It uses `collect_tool_outputs` after the mock server records the conversation. The fake model call supplies `max_output_tokens` so the test exercises truncation metadata.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `exec_command_clamps_model_requested_max_output_tokens_to_policy`  (lines 1505–1566)

```
async fn exec_command_clamps_model_requested_max_output_tokens_to_policy() -> Result<()>
```

**Purpose**: Ensures the model cannot bypass the configured tool-output token limit by requesting a huge output allowance. The system should clamp the request to policy.

**Data flow**: The test configures a small output-token limit, scripts a command that prints many lines, asks for far more tokens than allowed, and waits for raw output. It expects the original token count and a specific truncated summary shape.

**Call relations**: It starts the turn with `submit_unified_exec_turn` and reads the tool output with `wait_for_raw_unified_exec_output`. The regex assertion verifies the policy-controlled truncation format.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn, wait_for_raw_unified_exec_output); 9 external calls (assert_eq!, assert_regex_match, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `write_stdin_clamps_model_requested_max_output_tokens_to_policy`  (lines 1569–1657)

```
async fn write_stdin_clamps_model_requested_max_output_tokens_to_policy() -> Result<()>
```

**Purpose**: Ensures output from `write_stdin` is also limited by system policy, not by the model’s requested maximum. This closes the same loophole for interactive sessions.

**Data flow**: The test starts an interactive command that waits for input, then sends input that triggers many output lines while requesting a huge token limit. It parses the startup and stdin outputs, checks the session stayed alive at first, and verifies the stdin output was truncated to the configured policy.

**Call relations**: It uses `wait_for_raw_unified_exec_output` for both the startup and write calls. The fake response sequence drives an interactive command followed by a `write_stdin` call.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn, wait_for_raw_unified_exec_output); 10 external calls (assert!, assert_eq!, assert_regex_match, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_defaults_to_pipe`  (lines 1660–1728)

```
async fn unified_exec_defaults_to_pipe() -> Result<()>
```

**Purpose**: Checks that unified exec uses ordinary pipe input by default, not a terminal. This matters because many commands behave differently when connected to a terminal.

**Data flow**: The test runs Python code that prints whether stdin is a terminal, collects the parsed output, and expects `False` with exit code zero.

**Call relations**: It uses `submit_unified_exec_turn` to run the scenario and `collect_tool_outputs` to inspect the model-visible result after turn completion.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_can_enable_tty`  (lines 1731–1796)

```
async fn unified_exec_can_enable_tty() -> Result<()>
```

**Purpose**: Checks that a command can explicitly request terminal mode with `tty: true`. Terminal mode is needed for interactive programs and prompts.

**Data flow**: The test runs Python code that checks whether stdin is a terminal, this time passing `tty: true`. It collects parsed output and expects `True`, exit code zero, and no remaining process ID because the command exited.

**Call relations**: It follows the same pattern as the default-pipe test, but the fake tool arguments enable TTY behavior. `collect_tool_outputs` provides the parsed result.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_respects_early_exit_notifications`  (lines 1799–1881)

```
async fn unified_exec_respects_early_exit_notifications() -> Result<()>
```

**Purpose**: Checks that a command that exits quickly returns promptly even if the model requested a very long yield time. This prevents needless waiting.

**Data flow**: The test runs a short sleep with a huge yield time, waits for completion, parses the output, and verifies there is no live process, exit code is zero, wall time is short, and output is empty.

**Call relations**: The fake server asks for the command, `submit_unified_exec_turn` starts the turn, and `collect_tool_outputs` lets the test compare the timing metadata after completion.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `write_stdin_returns_exit_metadata_and_clears_session`  (lines 1884–2036)

```
async fn write_stdin_returns_exit_metadata_and_clears_session() -> Result<()>
```

**Purpose**: Checks that an interactive session reports a process ID while running and clears it when the process exits. It also verifies final exit metadata for `write_stdin`.

**Data flow**: The test starts `/bin/cat`, writes a line to it, then sends end-of-file. It parses all three tool outputs and confirms the first two keep the same process ID, the echo appears, and the final output has no process ID but does have exit code zero and a chunk ID.

**Call relations**: It uses a scripted sequence of one `exec_command` and two `write_stdin` calls. `collect_tool_outputs` turns the recorded tool responses into comparable session state.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `write_stdin_ctrl_c_interrupts_non_tty_session`  (lines 2039–2049)

```
async fn write_stdin_ctrl_c_interrupts_non_tty_session() -> Result<()>
```

**Purpose**: Checks Ctrl+C behavior for a non-terminal session that traps the interrupt signal. The command should get the signal, run its trap, and report its chosen exit code.

**Data flow**: This small test names the trap scenario, supplies a shell command with an interrupt trap, and expects exit code 42 plus trap output. The shared assertion helper runs the full setup and validation.

**Call relations**: It delegates almost all work to `assert_write_stdin_ctrl_c_interrupts_non_tty_session`. The wrapper exists so this interrupt style is reported as its own test case.

*Call graph*: calls 1 internal fn (assert_write_stdin_ctrl_c_interrupts_non_tty_session); 1 external calls (skip_if_wine_exec!).


##### `write_stdin_ctrl_c_default_interrupt_reports_130_for_non_tty_session`  (lines 2052–2062)

```
async fn write_stdin_ctrl_c_default_interrupt_reports_130_for_non_tty_session() -> Result<()>
```

**Purpose**: Checks Ctrl+C behavior for a non-terminal session with default interrupt handling. On Unix-like systems, that should be reported as exit code 130.

**Data flow**: This wrapper supplies a long-running command without a custom trap and expects exit code 130 with no required interrupt output. The shared helper performs the command execution and assertions.

**Call relations**: It calls `assert_write_stdin_ctrl_c_interrupts_non_tty_session` with different expected values from the trap test, giving coverage for the default signal path.

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

**Purpose**: Shared test helper for Ctrl+C interrupt scenarios in non-terminal sessions. It avoids duplicating the setup for trapped and default interrupt behavior.

**Data flow**: It receives a test name, command, expected exit code, and optional expected output. It starts the command without TTY mode, sends Ctrl+C through `write_stdin`, collects parsed outputs, and checks the session started, reported readiness, then ended with the expected exit behavior.

**Call relations**: The two non-Windows Ctrl+C tests call this helper. It uses the common fake-server flow, `submit_unified_exec_turn`, and `collect_tool_outputs` to drive and inspect the session.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); called by 2 (write_stdin_ctrl_c_default_interrupt_reports_130_for_non_tty_session, write_stdin_ctrl_c_interrupts_non_tty_session); 9 external calls (assert!, assert_eq!, wait_for_event, format!, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `write_stdin_ctrl_c_reports_unsupported_interrupt_to_model_on_windows`  (lines 2188–2284)

```
async fn write_stdin_ctrl_c_reports_unsupported_interrupt_to_model_on_windows() -> Result<()>
```

**Purpose**: Checks that Windows reports unsupported Ctrl+C behavior clearly to the model for this backend. Instead of pretending the interrupt worked, the tool response should explain the failure.

**Data flow**: The test starts a long-running Windows command, sends Ctrl+C through `write_stdin`, waits for completion, parses the startup output, and inspects the interrupt output text. It expects the start session to be alive and the interrupt response to say that process interrupt is unsupported.

**Call relations**: This Windows-only test uses the normal mock response pattern but parses one output directly with `parse_unified_exec_output`. It validates the model-visible failure text rather than an end event.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, parse_unified_exec_output, submit_unified_exec_turn); 7 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `unified_exec_emits_end_event_when_session_dies_via_stdin`  (lines 2287–2378)

```
async fn unified_exec_emits_end_event_when_session_dies_via_stdin() -> Result<()>
```

**Purpose**: Checks that when a live session exits because of input sent through `write_stdin`, Codex emits the end event for the original `exec_command` call. This keeps lifecycle ownership clear.

**Data flow**: The test starts `cat`, sends a line, then sends end-of-file. It waits for an `ExecCommandEnd` event tied to the startup call ID and verifies exit code zero.

**Call relations**: The fake server drives one startup call and two stdin calls. `submit_unified_exec_turn` begins the sequence, and the event matcher confirms the end event is attached to the original session.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, submit_unified_exec_turn); 9 external calls (assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_keeps_long_running_session_after_turn_end`  (lines 2381–2488)

```
async fn unified_exec_keeps_long_running_session_after_turn_end() -> Result<()>
```

**Purpose**: Verifies that a long-running unified exec process can remain alive after the model turn completes. This is important for background terminal sessions users may continue later.

**Data flow**: The test starts a long sleep command that writes its operating-system process ID to a file, waits for the begin event and the PID file, then waits for turn completion and checks the process is still alive. Finally it shuts Codex down and confirms the process exits.

**Call relations**: This test builds and submits its own turn because it needs local environment selections. It uses process helpers to observe the real spawned process and shutdown events to verify cleanup.

*Call graph*: calls 7 internal fn (wait_for_pid_file, wait_for_process_exit, mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields); 11 external calls (default, assert!, wait_for_event, wait_for_event_match, format!, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, tempdir (+1 more)).


##### `unified_exec_interrupt_preserves_long_running_session`  (lines 2491–2586)

```
async fn unified_exec_interrupt_preserves_long_running_session() -> Result<()>
```

**Purpose**: Checks that interrupting a Codex turn does not automatically kill a long-running unified exec session. The session should survive until explicit background-terminal cleanup.

**Data flow**: The test starts a long sleep command, waits for its PID file, sends an interrupt operation to Codex, waits for the turn-aborted event, and verifies the process is still alive. It then requests background-terminal cleanup and waits for the process to exit.

**Call relations**: Like the long-running turn-end test, it submits a custom operation and uses process helpers. The key difference is that it sends `Op::Interrupt` followed by `Op::CleanBackgroundTerminals`.

*Call graph*: calls 7 internal fn (wait_for_pid_file, wait_for_process_exit, mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields); 11 external calls (default, assert!, wait_for_event, wait_for_event_match, format!, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, tempdir (+1 more)).


##### `unified_exec_reuses_session_via_stdin`  (lines 2589–2686)

```
async fn unified_exec_reuses_session_via_stdin() -> Result<()>
```

**Purpose**: Checks that `write_stdin` can reuse a session created by a previous `exec_command`. This is the core interactive-session behavior.

**Data flow**: The test starts `/bin/cat` in TTY mode, then sends a line to session ID 1000. It parses outputs and verifies the second response uses the same process ID and contains the echoed line.

**Call relations**: The mock response sequence creates a startup call followed by a stdin call. `collect_tool_outputs` lets the test compare process IDs across both tool responses.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_streams_after_lagged_output`  (lines 2689–2804)

```
async fn unified_exec_streams_after_lagged_output() -> Result<()>
```

**Purpose**: Checks that unified exec can still capture later output after a large burst of earlier output causes truncation or lag. This protects against losing the tail of noisy commands.

**Data flow**: The test runs a Python script that emits a large chunk, waits, then prints repeated tail markers. It starts the command with a short yield, polls later with `write_stdin`, waits with an extended timeout, and checks the poll output contains the tail marker.

**Call relations**: It uses `wait_for_event_with_timeout` because this worst-case output path can be slow in continuous integration. `collect_tool_outputs` confirms the initial session ID and later poll output.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 8 external calls (assert!, wait_for_event_with_timeout, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_timeout_and_followup_poll`  (lines 2807–2893)

```
async fn unified_exec_timeout_and_followup_poll() -> Result<()>
```

**Purpose**: Checks that when a command does not finish before its yield time, unified exec returns a live session that can be polled later. The follow-up poll should capture the delayed output.

**Data flow**: The test starts a command that sleeps before printing `ready`, with a very short yield time. It then polls the same session, collects outputs, and verifies the first response has a process ID with no output while the poll response contains `ready`.

**Call relations**: The fake model response sequence mirrors the intended user flow: start command, then poll. `collect_tool_outputs` provides the structured before-and-after session results.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 8 external calls (assert!, matches!, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_formats_large_output_summary`  (lines 2898–2971)

```
async fn unified_exec_formats_large_output_summary() -> Result<()>
```

**Purpose**: Checks the human-readable summary format for very large command output. The summary should show a warning, line count, beginning, truncation marker, and ending.

**Data flow**: The test runs a Python script that prints thousands of repeated lines with a small output-token limit. After completion, it parses the output and matches it against a pattern requiring a truncation warning and retained head and tail text.

**Call relations**: It uses the common turn and output-collection helpers. The regex assertion protects the exact model-visible shape of large-output summaries.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 9 external calls (assert!, assert_regex_match, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, skip_if_wine_exec!, vec!).


##### `unified_exec_runs_under_sandbox`  (lines 2974–3060)

```
async fn unified_exec_runs_under_sandbox() -> Result<()>
```

**Purpose**: Checks that unified exec can run a simple command under a read-only sandbox. This confirms command execution still works when filesystem permissions are restricted.

**Data flow**: The test configures a read-only permission profile, asks unified exec to echo `hello`, waits for turn completion, parses the tool output, and verifies the output contains the expected text.

**Call relations**: This test submits its own operation so it can provide local environment selections and read-only permissions. It uses `collect_tool_outputs` to inspect the final model-visible command output.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, collect_tool_outputs, read_only); 9 external calls (default, assert!, assert_regex_match, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `unified_exec_enforces_glob_deny_read_policy`  (lines 3064–3201)

```
async fn unified_exec_enforces_glob_deny_read_policy() -> Result<()>
```

**Purpose**: Checks that sandbox rules denying reads by glob pattern are enforced for unified exec. It protects against leaking contents of files that match denied patterns.

**Data flow**: The test creates one denied `.env` file and one allowed text file, then runs a command that tries to read both. It expects a nonzero exit code, allowed file contents present, secret contents absent, and an operating-system denial message in the output.

**Call relations**: This Unix-only test builds a custom permission profile before submitting the turn. It uses `collect_tool_outputs` to verify that sandbox policy affects the actual command result.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, collect_tool_outputs, read_only); 10 external calls (default, assert!, wait_for_event, format!, create_dir_all, write, json!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `unified_exec_python_prompt_under_seatbelt`  (lines 3205–3343)

```
async fn unified_exec_python_prompt_under_seatbelt() -> Result<()>
```

**Purpose**: Checks that an interactive Python prompt works under macOS Seatbelt sandboxing. Seatbelt is macOS’s sandbox mechanism, and prompts are a common interactive-terminal case.

**Data flow**: The test finds Python, starts it interactively in TTY mode under a read-only sandbox, then sends `exit()`. It parses outputs and verifies the prompt appeared, the session stayed alive after startup, and Python exited cleanly.

**Call relations**: This macOS-only test submits a custom read-only turn and uses the same output collection helper. The follow-up `write_stdin` call confirms the interactive session is usable under the sandbox.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, collect_tool_outputs, read_only); 9 external calls (default, assert!, assert_eq!, wait_for_event, eprintln!, json!, skip_if_no_network!, vec!, which).


##### `unified_exec_runs_on_all_platforms`  (lines 3346–3404)

```
async fn unified_exec_runs_on_all_platforms() -> Result<()>
```

**Purpose**: Checks the most basic unified exec path on supported platforms: run a command and see its output. It is a broad smoke test for cross-platform command execution.

**Data flow**: The test scripts an echo command, submits a turn, waits for completion, parses tool outputs, and checks that the output contains `hello crossplat` even if platform-specific control characters surround it.

**Call relations**: It uses `submit_unified_exec_turn` and `collect_tool_outputs` like many other tests. Its assertions are deliberately loose so the same behavior can be checked across operating systems.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, collect_tool_outputs, submit_unified_exec_turn); 8 external calls (assert!, assert_regex_match, wait_for_event, json!, skip_if_no_network!, skip_if_sandbox!, skip_if_wine_exec!, vec!).


##### `unified_exec_prunes_exited_sessions_first`  (lines 3408–3552)

```
async fn unified_exec_prunes_exited_sessions_first() -> Result<()>
```

**Purpose**: Checks the intended behavior when the session cache fills: exited sessions should be pruned before still-live sessions. This test is currently ignored, but documents and verifies the desired cleanup policy.

**Data flow**: The test starts one session to keep, one session expected to exit, and many filler sessions. It then writes to the kept session and probes the exited session, expecting the kept one to respond and the pruned one to be unknown.

**Call relations**: It builds a large fake response with many function calls, then uses `parse_unified_exec_output` directly on recorded outputs. Because it is ignored, it serves as a pending or expensive regression test for cache pruning.

*Call graph*: calls 8 internal fn (ev_completed, ev_function_call, mount_sse_sequence, sse, start_mock_server, test_codex, parse_unified_exec_output, submit_unified_exec_turn); 9 external calls (assert!, wait_for_event, format!, json!, to_string, skip_if_no_network!, skip_if_sandbox!, skip_if_windows!, vec!).


##### `assert_command`  (lines 3554–3566)

```
fn assert_command(command: &[String], expected_args: &str, expected_cmd: &str)
```

**Purpose**: Checks that a command event used Bash in the expected form and carried the expected shell argument and command string. It makes command-shape assertions readable in tests.

**Data flow**: It receives a command vector plus the expected shell argument and command text. It asserts there are three parts, the first part looks like a Bash path, and the second and third parts exactly match the expected values.

**Call relations**: The begin-event tests call this after receiving an `ExecCommandBegin` event. It centralizes the Bash-path tolerance so those tests can focus on lifecycle behavior.

*Call graph*: called by 2 (unified_exec_emits_exec_command_begin_event, unified_exec_emits_one_begin_and_one_end_event); 2 external calls (assert!, assert_eq!).


### `core/tests/suite/apply_patch_cli.rs`

`test` · `test run`

This test file acts like a safety inspector for the patch tool. Codex can receive model output that says “add this file,” “change these lines,” or “move this file.” These tests create temporary workspaces, fake model responses from a mock server, submit prompts to Codex, and then inspect the real files and emitted events.

The suite covers the happy path, such as adding, deleting, moving, and editing files, including multi-part patches and patches run through a shell heredoc (a block of text passed to a command). It also covers failure cases: bad patch syntax, missing files, missing context lines, empty patches, attempts to escape the workspace with `..`, and operations through symbolic links. These are important because a patch tool has write access; without these checks, a model could accidentally or maliciously edit files outside the project.

The tests also check user-facing behavior. They verify that Codex reports useful error text, emits turn diffs (Git-style summaries of what changed), aggregates diffs across several patch calls, and avoids emitting misleading diffs when a patch fails or a pure rename has no content change. Some tests are platform-specific because Linux, Unix links, Windows links, and remote environments behave differently.

#### Function details

##### `apply_patch_harness`  (lines 67–69)

```
async fn apply_patch_harness() -> Result<TestCodexHarness>
```

**Purpose**: Builds the standard test setup used by most `apply_patch` tests. A harness is the test “workbench”: it has a fake server, a workspace, and a running Codex instance.

**Data flow**: It takes no input, asks `apply_patch_harness_with` to build a harness with the default builder, and returns the ready-to-use test harness or an error.

**Call relations**: Most tests call this when they do not need special configuration. It hands the real setup work to `apply_patch_harness_with`, so individual tests can stay focused on the patch behavior they are checking.

*Call graph*: calls 1 internal fn (apply_patch_harness_with); called by 28 (apply_patch_aggregates_diff_across_multiple_tool_calls, apply_patch_aggregates_diff_preserves_success_after_failure, apply_patch_change_context_disambiguates_target, apply_patch_cli_add_overwrites_existing_file, apply_patch_cli_delete_directory_reports_verification_error, apply_patch_cli_delete_missing_file_reports_error, apply_patch_cli_end_of_file_anchor, apply_patch_cli_insert_only_hunk_modifies_file, apply_patch_cli_missing_second_chunk_context_rejected, apply_patch_cli_move_overwrites_existing_destination (+15 more)).


##### `apply_patch_harness_with`  (lines 71–78)

```
async fn apply_patch_harness_with(
    configure: impl FnOnce(TestCodexBuilder) -> TestCodexBuilder,
) -> Result<TestCodexHarness>
```

**Purpose**: Builds a test harness while letting a test customize the Codex configuration first. Tests use it when they need a different model, workspace, feature flag, shell, or current directory.

**Data flow**: It receives a function that edits a `TestCodexBuilder`, starts from the default `test_codex` builder, applies the customization, and creates a harness that can work with a remote environment. It returns the completed harness or an error.

**Call relations**: `apply_patch_harness` calls this for the default case. More specialized tests call it directly before mounting fake model responses and submitting prompts.

*Call graph*: calls 2 internal fn (with_remote_env_builder, test_codex); called by 11 (apply_patch_clears_aggregated_diff_after_inexact_delta, apply_patch_cli_can_use_shell_command_output_as_patch_input, apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace, apply_patch_cli_multiple_operations_integration, apply_patch_cli_preserves_existing_hard_link_outside_workspace, apply_patch_custom_tool_streaming_emits_updated_changes, apply_patch_harness, apply_patch_shell_command_failure_propagates_error_and_skips_diff, apply_patch_shell_command_heredoc_with_cd_emits_turn_diff, apply_patch_shell_command_heredoc_with_cd_updates_relative_workdir (+1 more)); 1 external calls (pin).


##### `submit_without_wait`  (lines 80–88)

```
async fn submit_without_wait(harness: &TestCodexHarness, prompt: &str) -> Result<()>
```

**Purpose**: Submits a user prompt to Codex but does not wait for the whole turn to finish. Tests use this when they need to watch events as the turn runs.

**Data flow**: It receives a harness and prompt, chooses full filesystem access with no special permission profile, and forwards everything to `submit_without_wait_with_turn_permissions`. It returns once the prompt has been submitted.

**Call relations**: Event-focused tests call this, then listen for events such as patch begin, patch end, turn diff, or turn complete. It is a small convenience wrapper around the more configurable submission helper.

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

**Purpose**: Submits a prompt with explicit sandbox and permission settings. This lets tests control what the patch tool is allowed to read or write.

**Data flow**: It reads the model from the harness's test session, builds a `UserInput` operation with the prompt, approval policy, sandbox policy, optional permission profile, and collaboration settings, then sends it to Codex. It returns success or an error from submission.

**Call relations**: `submit_without_wait` calls this with permissive defaults. It is the lower-level helper used when tests need to begin a turn and then observe events instead of waiting through the harness's simpler submit path.

*Call graph*: calls 1 internal fn (test); called by 1 (submit_without_wait); 2 external calls (default, vec!).


##### `restrictive_workspace_write_profile`  (lines 126–133)

```
fn restrictive_workspace_write_profile() -> PermissionProfile
```

**Purpose**: Creates a permission profile that allows writing in the workspace but blocks broader access and network use. Tests use it to prove path-escape attempts are rejected.

**Data flow**: It takes no input and builds a workspace-write profile with restricted networking and no temporary-directory exceptions. The output is a `PermissionProfile` ready to attach to a test turn.

**Call relations**: Path traversal tests call this before submitting prompts that try to write outside the project. The profile supplies the guardrails that the patch tool is expected to respect.

*Call graph*: calls 1 internal fn (workspace_write_with); called by 2 (apply_patch_cli_rejects_move_path_traversal_outside_workspace, apply_patch_cli_rejects_path_traversal_outside_workspace).


##### `workspace_write_with_read_only_root`  (lines 135–154)

```
fn workspace_write_with_read_only_root(read_only_root: AbsolutePathBuf) -> PermissionProfile
```

**Purpose**: Creates permissions where project files are writable but one chosen outside root is read-only. This is used to test link-related escape behavior.

**Data flow**: It receives an absolute path to protect, builds a filesystem policy that grants read access to that path and write access to project roots, combines it with restricted networking, and returns a permission profile.

**Call relations**: The symlink and hard-link tests use this profile to check whether applying a patch can affect files beyond the workspace. It feeds custom permissions into harness submission.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); called by 2 (apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace, apply_patch_cli_preserves_existing_hard_link_outside_workspace); 1 external calls (vec!).


##### `workspace_write_with_unreadable_path`  (lines 157–176)

```
fn workspace_write_with_unreadable_path(unreadable_path: AbsolutePathBuf) -> PermissionProfile
```

**Purpose**: Creates Unix-only permissions where one chosen path cannot be read at all while the project remains writable. Tests use it to confirm verification also obeys the sandbox.

**Data flow**: It receives an absolute path to deny, builds a filesystem policy denying that path and allowing project writes, combines it with restricted networking, and returns a permission profile.

**Call relations**: The intercepted shell heredoc sandbox test calls this before submitting a patch through a symlink. The goal is to prove that even the patch verification step cannot read denied content.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); called by 1 (intercepted_apply_patch_verification_uses_local_sandbox); 1 external calls (vec!).


##### `create_file_symlink`  (lines 189–194)

```
fn create_file_symlink(_source: &std::path::Path, _link: &std::path::Path) -> std::io::Result<()>
```

**Purpose**: Creates a file symbolic link, using the platform-specific system call. A symbolic link is a shortcut path that points to another file.

**Data flow**: It receives a source path and a link path. On Unix it creates a Unix symlink, on Windows it creates a file symlink, and on unsupported platforms it returns an unsupported-operation error.

**Call relations**: Symlink security tests call this to set up a workspace path that points somewhere else. The patch tests then check whether Codex follows or rejects that shortcut correctly.

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

**Purpose**: Sets up the mock model server to send an `apply_patch` custom tool call followed by an assistant message. This lets a test control exactly what patch Codex receives.

**Data flow**: It receives a harness, call id, patch text, and assistant message. It builds the fake server-sent event sequence with `apply_patch_responses` and mounts it on the harness's mock server.

**Call relations**: Most patch tests call this before submitting a prompt. It prepares the fake model response that causes Codex to run the patch tool.

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

**Purpose**: Sets up the mock model server for a specific style of patch output, such as a shell command using a heredoc. This is useful because models may request patching in different formats.

**Data flow**: It receives the harness, call id, patch, assistant message, and model-output style. It picks the right fake event builder, creates the response sequence, and mounts it on the mock server.

**Call relations**: Tests for heredoc and intercepted shell behavior call this instead of `mount_apply_patch`. It still relies on `apply_patch_responses` for the common response shape.

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

**Purpose**: Builds the two fake server responses used by patch tests: one response that asks Codex to apply a patch, and one response with the assistant's final message.

**Data flow**: It receives a call id, patch text, assistant message, and a function that creates the patch-call event. It returns a list of server-sent event strings.

**Call relations**: `mount_apply_patch` and `mount_apply_patch_model_output` call this to avoid repeating the same mock response structure in every test.

*Call graph*: called by 2 (mount_apply_patch, mount_apply_patch_model_output); 1 external calls (vec!).


##### `apply_patch_cli_uses_codex_self_exe_with_linux_sandbox_helper_alias`  (lines 255–286)

```
async fn apply_patch_cli_uses_codex_self_exe_with_linux_sandbox_helper_alias() -> Result<()>
```

**Purpose**: Checks that, on Linux, the patch tool uses the expected sandbox helper executable alias and can still apply a patch successfully.

**Data flow**: It builds a harness, verifies the configured Linux sandbox helper name, mounts a patch that adds a file, submits a prompt, then checks the tool output and the new file contents.

**Call relations**: The test runner invokes this Linux-only test. It uses `apply_patch_harness` and `mount_apply_patch` to set up the scenario, then validates both sandbox setup and patch execution.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert_eq!, assert_regex_match, skip_if_no_network!).


##### `apply_patch_cli_multiple_operations_integration`  (lines 289–325)

```
async fn apply_patch_cli_multiple_operations_integration() -> Result<()>
```

**Purpose**: Checks that one patch can add, modify, and delete files in a single operation. This mirrors a realistic model edit that touches several files at once.

**Data flow**: It creates initial files, mounts a patch with add/update/delete sections, submits the prompt, then checks the formatted output and final filesystem state.

**Call relations**: The test runner calls this. It uses the customizable harness to pick a model, then uses `mount_apply_patch` to drive Codex through a multi-operation patch.

*Call graph*: calls 2 internal fn (apply_patch_harness_with, mount_apply_patch); 4 external calls (assert!, assert_eq!, assert_regex_match, skip_if_no_network!).


##### `apply_patch_cli_multiple_chunks`  (lines 328–348)

```
async fn apply_patch_cli_multiple_chunks() -> Result<()>
```

**Purpose**: Verifies that a patch can update two separate places in the same file. This matters for edits that are not all next to each other.

**Data flow**: It writes a four-line file, mounts a patch with two hunks, submits the prompt, and checks that both targeted lines changed.

**Call relations**: The test runner invokes it. It uses the standard harness and mock patch response helpers.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_moves_file_to_new_directory`  (lines 351–370)

```
async fn apply_patch_cli_moves_file_to_new_directory() -> Result<()>
```

**Purpose**: Checks that a patch can move a file into a newly created directory while changing its contents.

**Data flow**: It creates the original file, mounts a patch with a move destination and a content change, submits the prompt, then checks that the old path is gone and the new path contains the new text.

**Call relations**: The test runner invokes it after setup through `apply_patch_harness` and `mount_apply_patch`.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert!, assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_updates_file_appends_trailing_newline`  (lines 373–392)

```
async fn apply_patch_cli_updates_file_appends_trailing_newline() -> Result<()>
```

**Purpose**: Verifies that updating a file without a final newline produces normal text ending with a newline. This keeps output consistent with common source-file conventions.

**Data flow**: It writes a file lacking a trailing newline, mounts an update patch, submits the prompt, then reads the file and checks both the exact content and the final newline.

**Call relations**: The test runner invokes it. The standard harness and patch mounting helper supply the test environment and fake model patch.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert!, assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_insert_only_hunk_modifies_file`  (lines 395–415)

```
async fn apply_patch_cli_insert_only_hunk_modifies_file() -> Result<()>
```

**Purpose**: Checks that a patch hunk can insert a line without removing any lines. This covers the simple “add a line between two existing lines” case.

**Data flow**: It writes a two-line file, mounts a patch that adds one line between them, submits the prompt, and checks the final three-line file.

**Call relations**: The test runner invokes it using the common harness and mock patch helpers.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_move_overwrites_existing_destination`  (lines 418–440)

```
async fn apply_patch_cli_move_overwrites_existing_destination() -> Result<()>
```

**Purpose**: Checks that moving a file to a path that already exists replaces the destination with the moved content.

**Data flow**: It creates both the source and destination files, mounts a move-and-edit patch, submits the prompt, then checks that the source disappeared and the destination has the new content.

**Call relations**: The test runner invokes it. It uses `apply_patch_harness` and `mount_apply_patch` to create the controlled model interaction.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert!, assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_move_without_content_change_has_no_turn_diff`  (lines 443–473)

```
async fn apply_patch_cli_move_without_content_change_has_no_turn_diff() -> Result<()>
```

**Purpose**: Verifies that a pure rename with no content change does not emit a turn diff. A turn diff is meant to show content changes, not every path movement.

**Data flow**: It creates a file, mounts a move-only patch, submits without waiting, watches Codex events until turn completion, and confirms no `TurnDiff` event appeared while the file was renamed.

**Call relations**: The test runner invokes it. It uses `submit_without_wait` because it needs to observe events during the turn, not just inspect files afterward.

*Call graph*: calls 3 internal fn (apply_patch_harness, mount_apply_patch, submit_without_wait); 4 external calls (assert!, assert_eq!, wait_for_event, skip_if_no_network!).


##### `apply_patch_cli_add_overwrites_existing_file`  (lines 476–494)

```
async fn apply_patch_cli_add_overwrites_existing_file() -> Result<()>
```

**Purpose**: Checks that an add-file patch aimed at an existing file replaces that file's contents.

**Data flow**: It writes an existing file, mounts an add-file patch for the same path, submits the prompt, and checks that the file now contains the new text.

**Call relations**: The test runner invokes it with the standard harness and patch mounting helper.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_rejects_invalid_hunk_header`  (lines 497–519)

```
async fn apply_patch_cli_rejects_invalid_hunk_header() -> Result<()>
```

**Purpose**: Checks that invalid patch section headers are rejected with useful diagnostics. This prevents malformed model output from being treated as a valid edit.

**Data flow**: It mounts a patch with an unknown header, submits the prompt, reads the patch tool output, and checks for a verification failure and a message about the invalid header.

**Call relations**: The test runner invokes it. The helper-mounted fake response supplies deliberately bad patch text.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_cli_reports_missing_context`  (lines 522–548)

```
async fn apply_patch_cli_reports_missing_context() -> Result<()>
```

**Purpose**: Checks that a patch fails cleanly when the lines it expects are not present in the target file.

**Data flow**: It writes a file, mounts an update patch looking for a nonexistent line, submits the prompt, checks the error message, and verifies the original file was not changed.

**Call relations**: The test runner invokes it. It relies on the normal harness and patch mock, then inspects both output and filesystem state.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert!, assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_reports_missing_target_file`  (lines 551–577)

```
async fn apply_patch_cli_reports_missing_target_file() -> Result<()>
```

**Purpose**: Checks that updating a nonexistent file reports a clear error and does not create the file by accident.

**Data flow**: It mounts an update patch for a missing path, submits the prompt, checks the output for a read failure mentioning the path, and confirms the file still does not exist.

**Call relations**: The test runner invokes it using `apply_patch_harness` and `mount_apply_patch`.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_cli_delete_missing_file_reports_error`  (lines 580–607)

```
async fn apply_patch_cli_delete_missing_file_reports_error() -> Result<()>
```

**Purpose**: Checks that deleting a nonexistent file reports a verification error instead of silently succeeding.

**Data flow**: It mounts a delete-file patch for a missing path, submits the prompt, checks for failure text and the missing filename, and confirms the path is absent.

**Call relations**: The test runner invokes it through the standard harness and mock patch setup.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_cli_rejects_empty_patch`  (lines 610–627)

```
async fn apply_patch_cli_rejects_empty_patch() -> Result<()>
```

**Purpose**: Checks that a patch with no file changes is rejected. This avoids reporting success for work that did nothing.

**Data flow**: It mounts an empty begin/end patch, submits the prompt, reads the patch output, and checks for the empty-patch rejection message.

**Call relations**: The test runner invokes it using the common helpers.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_cli_delete_directory_reports_verification_error`  (lines 630–647)

```
async fn apply_patch_cli_delete_directory_reports_verification_error() -> Result<()>
```

**Purpose**: Checks that `Delete File` cannot delete a directory and instead reports a verification failure.

**Data flow**: It creates a directory, mounts a delete-file patch targeting that directory, submits the prompt, and checks that the output contains failure text.

**Call relations**: The test runner invokes it. The standard patch helper supplies the bad delete request.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_cli_rejects_path_traversal_outside_workspace`  (lines 650–687)

```
async fn apply_patch_cli_rejects_path_traversal_outside_workspace() -> Result<()>
```

**Purpose**: Checks that a patch cannot write outside the project by using `..` in the path. This is a key safety boundary.

**Data flow**: It computes an outside path, removes any old file there, mounts a patch trying to add `../escape.txt`, submits with a restrictive permission profile, then checks for a rejection message and confirms no outside file was created.

**Call relations**: The test runner invokes it. It uses `restrictive_workspace_write_profile` to create the permissions that should block the attempted escape.

*Call graph*: calls 3 internal fn (apply_patch_harness, mount_apply_patch, restrictive_workspace_write_profile); 2 external calls (assert!, skip_if_no_network!).


##### `intercepted_apply_patch_verification_uses_local_sandbox`  (lines 691–746)

```
async fn intercepted_apply_patch_verification_uses_local_sandbox() -> Result<()>
```

**Purpose**: On Unix, checks that patch verification obeys the local sandbox even when the patch comes through a shell heredoc. Verification means reading the current file to make sure the patch matches.

**Data flow**: It creates a denied target file and a symlink to it, mounts a heredoc-style patch that would read through the symlink, submits with a profile denying the target path, then checks for a read failure and unchanged target contents.

**Call relations**: The test runner invokes this Unix-only test. It uses `create_file_symlink`, `workspace_write_with_unreadable_path`, and `mount_apply_patch_model_output` to build the sandbox escape attempt.

*Call graph*: calls 5 internal fn (apply_patch_harness, create_file_symlink, mount_apply_patch_model_output, workspace_write_with_unreadable_path, try_from); 6 external calls (assert!, assert_eq!, format!, skip_if_no_network!, skip_if_remote!, write).


##### `apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace`  (lines 749–811)

```
async fn apply_patch_cli_does_not_write_through_symlink_escape_outside_workspace() -> Result<()>
```

**Purpose**: Checks that applying a patch through a symlink inside the workspace does not modify a file outside the workspace.

**Data flow**: It creates separate work and outside directories, points a workspace symlink at an outside file, mounts an update patch for the symlink, submits with the outside directory read-only, and checks that the outside file and symlink remain safe.

**Call relations**: The test runner invokes it. It uses the customizable harness for a custom workspace, `create_file_symlink` for the escape setup, and `workspace_write_with_read_only_root` for permissions.

*Call graph*: calls 5 internal fn (apply_patch_harness_with, create_file_symlink, mount_apply_patch, workspace_write_with_read_only_root, try_from); 12 external calls (assert!, assert_eq!, cfg!, eprintln!, format!, skip_if_no_network!, skip_if_remote!, current_dir, create_dir_all, symlink_metadata (+2 more)).


##### `apply_patch_cli_preserves_existing_hard_link_outside_workspace`  (lines 814–909)

```
async fn apply_patch_cli_preserves_existing_hard_link_outside_workspace() -> Result<()>
```

**Purpose**: Checks how `apply_patch` behaves with hard links, where two paths refer to the same underlying file data. The expected behavior differs on Windows and non-Windows systems.

**Data flow**: It creates an outside file and a workspace hard link to it, mounts an update patch through the workspace path, submits with the outside directory read-only, and then checks platform-specific outcomes: Windows rejects the write, while other systems allow the shared hard-link update without replacing the link.

**Call relations**: The test runner invokes it. It uses `apply_patch_harness_with`, `mount_apply_patch`, and `workspace_write_with_read_only_root` to create a controlled hard-link safety test.

*Call graph*: calls 4 internal fn (apply_patch_harness_with, mount_apply_patch, workspace_write_with_read_only_root, try_from); 11 external calls (assert!, assert_eq!, cfg!, format!, skip_if_no_network!, skip_if_remote!, current_dir, create_dir_all, hard_link, write (+1 more)).


##### `apply_patch_cli_rejects_move_path_traversal_outside_workspace`  (lines 912–954)

```
async fn apply_patch_cli_rejects_move_path_traversal_outside_workspace() -> Result<()>
```

**Purpose**: Checks that moving a file to a `..` path outside the workspace is rejected and leaves the original file untouched.

**Data flow**: It creates a source file, mounts a patch that tries to move it outside the project, submits with restrictive workspace permissions, and checks both the rejection message and unchanged filesystem state.

**Call relations**: The test runner invokes it, except in Wine execution where path behavior is skipped. It uses `restrictive_workspace_write_profile` to enforce the expected boundary.

*Call graph*: calls 3 internal fn (apply_patch_harness, mount_apply_patch, restrictive_workspace_write_profile); 4 external calls (assert!, assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `apply_patch_cli_verification_failure_has_no_side_effects`  (lines 957–975)

```
async fn apply_patch_cli_verification_failure_has_no_side_effects() -> Result<()>
```

**Purpose**: Checks that if any part of a patch fails verification, none of its earlier changes are committed. This is like an all-or-nothing transaction.

**Data flow**: It mounts a patch that would first add a file and then fail while updating a missing file, submits the prompt, and confirms the earlier file was not created.

**Call relations**: The test runner invokes it using the standard harness and patch mock.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert!, skip_if_no_network!).


##### `apply_patch_shell_command_heredoc_with_cd_updates_relative_workdir`  (lines 978–1010)

```
async fn apply_patch_shell_command_heredoc_with_cd_updates_relative_workdir() -> Result<()>
```

**Purpose**: Checks that `apply_patch` run inside a shell command after `cd sub` uses the new directory for relative paths.

**Data flow**: It writes a file in a subdirectory, mounts a fake shell command containing `cd sub && apply_patch <<EOF`, submits the prompt, checks successful command output, and verifies the subdirectory file changed.

**Call relations**: The test runner invokes it. Unlike custom-tool tests, it mounts a shell-command event directly with `mount_sse_sequence`.

*Call graph*: calls 2 internal fn (mount_sse_sequence, apply_patch_harness_with); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `apply_patch_cli_can_use_shell_command_output_as_patch_input`  (lines 1013–1153)

```
async fn apply_patch_cli_can_use_shell_command_output_as_patch_input() -> Result<()>
```

**Purpose**: Checks that output from one shell command can be used by the model to build a later patch. This simulates a model reading a file and then creating another file from what it read.

**Data flow**: It writes a source file with Unicode text, sets up a dynamic mock responder that first asks Codex to read the file, then uses that returned output to build an add-file patch, submits the prompt, and checks that the target file matches the source.

**Call relations**: The test runner invokes it when not remote. It uses `apply_patch_harness_with` for model and shell settings, then a custom wiremock responder instead of the simpler patch mounting helper.

*Call graph*: calls 1 internal fn (apply_patch_harness_with); 7 external calls (new, given, assert_eq!, skip_if_no_network!, skip_if_remote!, method, path_regex).


##### `apply_patch_custom_tool_streaming_emits_updated_changes`  (lines 1156–1257)

```
async fn apply_patch_custom_tool_streaming_emits_updated_changes() -> Result<()>
```

**Purpose**: Checks that, when streaming patch events are enabled, Codex emits live updates as patch text arrives in chunks.

**Data flow**: It enables the streaming feature, mounts server events that send a custom tool call input piece by piece, submits without waiting, collects `PatchApplyUpdated` events, and checks that the changes evolve from an empty added file to the final full content.

**Call relations**: The test runner invokes it. It uses `apply_patch_harness_with` to enable the feature and `submit_without_wait` so it can observe streaming events before turn completion.

*Call graph*: calls 3 internal fn (mount_sse_sequence, apply_patch_harness_with, submit_without_wait); 5 external calls (new, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `apply_patch_shell_command_heredoc_with_cd_emits_turn_diff`  (lines 1260–1319)

```
async fn apply_patch_shell_command_heredoc_with_cd_emits_turn_diff() -> Result<()>
```

**Purpose**: Checks that a shell heredoc patch run from a changed directory emits patch lifecycle events and a turn diff.

**Data flow**: It writes a subdirectory file, mounts a shell command patch, submits without waiting, watches for patch begin, patch end, and turn diff events, and asserts the patch succeeded and the diff looks like a Git diff.

**Call relations**: The test runner invokes it. It uses direct server event mounting and `submit_without_wait` because event ordering is the thing being tested.

*Call graph*: calls 3 internal fn (mount_sse_sequence, apply_patch_harness_with, submit_without_wait); 5 external calls (assert!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `apply_patch_turn_diff_paths_stay_repo_relative_when_session_cwd_is_nested`  (lines 1322–1390)

```
async fn apply_patch_turn_diff_paths_stay_repo_relative_when_session_cwd_is_nested() -> Result<()>
```

**Purpose**: Checks that turn diffs show paths relative to the repository root, even when the session starts in a nested directory.

**Data flow**: It builds a workspace with a nested current directory and a fake repository marker, mounts a patch that edits a file outside the nested directory but inside the repo, submits without waiting, captures the diff, and checks that it uses `repo.txt` rather than an absolute path.

**Call relations**: The test runner invokes it. It uses `apply_patch_harness_with` for custom workspace setup, then `mount_apply_patch` and `submit_without_wait` for the patch turn.

*Call graph*: calls 3 internal fn (apply_patch_harness_with, mount_apply_patch, submit_without_wait); 3 external calls (assert!, wait_for_event, skip_if_no_network!).


##### `apply_patch_shell_command_failure_propagates_error_and_skips_diff`  (lines 1393–1447)

```
async fn apply_patch_shell_command_failure_propagates_error_and_skips_diff() -> Result<()>
```

**Purpose**: Checks that a failed shell-based patch reports the verification error and does not emit a turn diff.

**Data flow**: It writes a file, mounts a shell heredoc patch whose expected line is missing, submits without waiting, watches events to ensure no `TurnDiff` appears, then checks command output and unchanged file contents.

**Call relations**: The test runner invokes it. It uses direct server event mounting and `submit_without_wait` to inspect both events and final tool output.

*Call graph*: calls 3 internal fn (mount_sse_sequence, apply_patch_harness_with, submit_without_wait); 6 external calls (assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `apply_patch_shell_accepts_lenient_heredoc_wrapped_patch`  (lines 1450–1485)

```
async fn apply_patch_shell_accepts_lenient_heredoc_wrapped_patch() -> Result<()>
```

**Purpose**: Checks that a heredoc-wrapped patch accepted through a shell command is parsed successfully and returns plain text output.

**Data flow**: It mounts a heredoc-style model output that adds a file, submits the prompt, reads the function call stdout, confirms it is not JSON, checks success text, and verifies the new file contents.

**Call relations**: The test runner invokes it. It uses `mount_apply_patch_model_output` to choose the shell heredoc output style.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch_model_output); 4 external calls (assert!, assert_eq!, format!, skip_if_no_network!).


##### `apply_patch_cli_end_of_file_anchor`  (lines 1488–1502)

```
async fn apply_patch_cli_end_of_file_anchor() -> Result<()>
```

**Purpose**: Checks that the special end-of-file marker in a patch can anchor an edit at the file's tail.

**Data flow**: It writes a two-line file, mounts a patch replacing the final line and including the end-of-file marker, submits the prompt, and checks the final file contents.

**Call relations**: The test runner invokes it with the standard harness and patch mounting helper.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert_eq!, skip_if_no_network!).


##### `apply_patch_cli_missing_second_chunk_context_rejected`  (lines 1505–1532)

```
async fn apply_patch_cli_missing_second_chunk_context_rejected() -> Result<()>
```

**Purpose**: Checks that a malformed second edit chunk is rejected and does not partially update the file.

**Data flow**: It writes a four-line file, mounts a patch where the first chunk is valid but the second lacks the expected context marker, submits the prompt, checks failure diagnostics, and verifies the file stayed unchanged.

**Call relations**: The test runner invokes it using the common setup helpers.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 3 external calls (assert!, assert_eq!, skip_if_no_network!).


##### `apply_patch_emits_turn_diff_event_with_unified_diff`  (lines 1535–1566)

```
async fn apply_patch_emits_turn_diff_event_with_unified_diff() -> Result<()>
```

**Purpose**: Checks that a successful patch emits a `TurnDiff` event containing a unified diff, which is the familiar Git-style before-and-after text.

**Data flow**: It mounts a patch adding a file, submits without waiting, listens until turn completion, captures the diff event, and checks for basic unified diff markers.

**Call relations**: The test runner invokes it. It uses `submit_without_wait` because it needs to watch Codex events as they arrive.

*Call graph*: calls 3 internal fn (apply_patch_harness, mount_apply_patch, submit_without_wait); 4 external calls (assert!, wait_for_event, format!, skip_if_no_network!).


##### `apply_patch_turn_diff_tracks_local_and_remote_environment_paths`  (lines 1569–1731)

```
async fn apply_patch_turn_diff_tracks_local_and_remote_environment_paths() -> Result<()>
```

**Purpose**: Checks that turn diffs distinguish matching file changes made in local and remote environments. This matters when the same relative path exists in more than one execution place.

**Data flow**: It starts a mock server, builds a test with both local and remote environments, creates a shared path in both, mounts one local and one remote patch, submits a turn selecting both environments, waits for a diff, verifies both files were written in their environments, and checks the exact diff prefixes `local/` and `remote/`.

**Call relations**: The test runner invokes it only when a remote test environment is available. It uses lower-level setup instead of `apply_patch_harness` because it needs both local and remote environment selection.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, test_codex, turn_permission_fields, new, from_path); 11 external calls (default, from, assert_eq!, get_remote_test_env, wait_for_event, format!, create_dir_all, remove_dir_all, skip_if_no_network!, skip_if_wine_exec! (+1 more)).


##### `apply_patch_aggregates_diff_across_multiple_tool_calls`  (lines 1734–1781)

```
async fn apply_patch_aggregates_diff_across_multiple_tool_calls() -> Result<()>
```

**Purpose**: Checks that when a turn contains several successful patch calls, the final turn diff summarizes the combined result.

**Data flow**: It mounts two patch calls, one adding a file and another updating that file and adding a second file, submits without waiting, captures the last diff, and checks that both files and the final content appear.

**Call relations**: The test runner invokes it. It uses `mount_sse_sequence` directly because the fake model sends multiple patch calls before the final assistant message.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, apply_patch_harness, submit_without_wait); 4 external calls (assert!, wait_for_event, skip_if_no_network!, vec!).


##### `apply_patch_aggregates_diff_preserves_success_after_failure`  (lines 1784–1854)

```
async fn apply_patch_aggregates_diff_preserves_success_after_failure() -> Result<()>
```

**Purpose**: Checks that a later failed patch does not erase the diff from an earlier successful patch in the same turn.

**Data flow**: It mounts one successful add-file patch and one failing update patch, submits without waiting, captures the final diff, verifies it still includes the successful change, checks failure diagnostics, and confirms the successful file exists.

**Call relations**: The test runner invokes it. It uses `wait_for_event_with_timeout` because it waits for turn events while allowing enough time for failure handling.

*Call graph*: calls 3 internal fn (mount_sse_sequence, apply_patch_harness, submit_without_wait); 6 external calls (from_secs, assert!, assert_eq!, wait_for_event_with_timeout, skip_if_no_network!, vec!).


##### `apply_patch_clears_aggregated_diff_after_inexact_delta`  (lines 1857–1924)

```
async fn apply_patch_clears_aggregated_diff_after_inexact_delta() -> Result<()>
```

**Purpose**: Checks that if Codex cannot compute an exact text diff for a later change, it clears the aggregate diff instead of showing a misleading partial summary.

**Data flow**: It creates a binary-looking file, mounts one normal patch and one patch that replaces the binary file with text, submits without waiting, waits for the diff event, and expects the diff to be an empty string while verifying both filesystem changes happened.

**Call relations**: The test runner invokes it. It uses `apply_patch_harness_with` for custom workspace setup and `submit_without_wait` to observe the aggregate diff event.

*Call graph*: calls 3 internal fn (mount_sse_sequence, apply_patch_harness_with, submit_without_wait); 5 external calls (from_secs, assert_eq!, wait_for_event_with_timeout, skip_if_no_network!, vec!).


##### `apply_patch_change_context_disambiguates_target`  (lines 1927–1946)

```
async fn apply_patch_change_context_disambiguates_target() -> Result<()>
```

**Purpose**: Checks that extra change context in a patch can pick the right occurrence when the same line appears more than once.

**Data flow**: It writes a file with two similar sections, mounts a patch that includes context naming the second section, submits the prompt, and checks that only the intended occurrence changed.

**Call relations**: The test runner invokes it with the standard harness and mock patch response. It verifies the patch parser's context matching behavior.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 2 external calls (assert_eq!, skip_if_no_network!).


### Output shaping and interruption
These tests focus on how tool results are serialized, truncated, parallelized, snapshotted, and represented when execution is aborted.

### `core/tests/suite/shell_serialization.rs`

`test` · `test run`

These are integration-style tests for Unix-like systems. They set up a fake model server, make it ask Codex to run a shell command or apply a patch, then inspect the next request Codex sends back to the server. The important question is: what exactly does Codex put in the tool-result message?

The file protects a small but important contract. Shell output can contain anything, including text that looks like JSON. Codex must wrap that output as freeform text with a simple header: exit code, wall time, then an Output section. If this were serialized as real JSON by mistake, the model or server could misunderstand it. Think of it like putting a letter inside an envelope: the contents should stay as written, not be reinterpreted as the address label.

The tests also check that runtime duration is recorded, non-zero exits are still reported in the same plain-text style, and output truncation behaves as expected for large command results. A second group exercises the custom apply_patch tool, proving that successful patches create or update files and that failures return the raw failure message. Network-dependent test helpers are skipped when needed, and the whole file is disabled on Windows because the commands and path expectations are Unix-oriented.

#### Function details

##### `shell_responses`  (lines 37–58)

```
fn shell_responses(call_id: &str, command: Vec<&str>) -> Result<Vec<String>>
```

**Purpose**: Builds the fake server responses needed for tests where the model asks Codex to run a shell command. It packages a command into the same streamed event shape the real model API would use.

**Data flow**: It receives a tool call ID and a command as separate words. It safely joins the words into one shell command string, places that string and a timeout into JSON, then returns two server-sent-event response chunks: one asking for the shell command and one final assistant message saying the turn is done.

**Call relations**: The shell-output tests call this helper before mounting the fake response sequence on the mock server. It hands those tests ready-made streamed responses so they can focus on checking the returned tool output rather than rebuilding the fake API conversation each time.

*Call graph*: called by 3 (shell_output_is_freeform_for_nonzero_exit, shell_output_preserves_fixture_json_as_freeform, shell_output_records_duration); 3 external calls (json!, try_join, vec!).


##### `shell_output_preserves_fixture_json_as_freeform`  (lines 61–109)

```
async fn shell_output_preserves_fixture_json_as_freeform() -> Result<()>
```

**Purpose**: Checks that shell output containing valid-looking JSON is still sent back as plain text. This matters because command output should not be parsed or reshaped just because it happens to look like data.

**Data flow**: The test creates a mock server and a temporary Codex test workspace, writes a JSON fixture file, and makes the fake model request a command that prints that file. After Codex runs the command, the test reads the tool-output request sent back to the mock server and verifies that the output string is not parseable as a standalone JSON value, while its Output section exactly matches the fixture contents.

**Call relations**: It uses the shared test builder and mock server setup, then calls shell_responses to create the fake model instruction. After Codex submits the turn, the test inspects the mock server’s last recorded request and uses regex and equality checks to confirm the serialization format.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, shell_responses); 6 external calls (assert!, assert_eq!, assert_regex_match, write, skip_if_no_network!, vec!).


##### `shell_output_records_duration`  (lines 112–152)

```
async fn shell_output_records_duration() -> Result<()>
```

**Purpose**: Verifies that shell command results include a measured wall-clock duration. This gives the model and users useful context about how long the command actually took.

**Data flow**: The test asks the fake model to run a short sleep command. It then extracts Codex’s returned output string, checks that the string has the expected exit-code, wall-time, and Output layout, parses the reported seconds from the Wall time line, and confirms the duration is greater than a tiny threshold.

**Call relations**: It follows the same mock-server flow as the other shell tests, using shell_responses to prepare the streamed tool call. Its main handoff is from Codex’s executed command back into the recorded mock request, where the test reads the final serialized output.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, shell_responses); 5 external calls (new, assert!, assert_regex_match, skip_if_no_network!, vec!).


##### `apply_patch_custom_tool_call_creates_file`  (lines 155–194)

```
async fn apply_patch_custom_tool_call_creates_file() -> Result<()>
```

**Purpose**: Checks that an apply_patch custom tool call can create a new file and reports success in the standard command-output format. This proves that patch execution changes the workspace and that the model receives a clear summary.

**Data flow**: The test builds an apply-patch harness, prepares a patch that adds a new file, and mounts that patch request as the fake model’s tool call. After Codex runs the turn, the test reads the apply_patch output and checks for exit code, wall time, and a success message naming the added file. It then reads the new file from disk and confirms its contents.

**Call relations**: It relies on apply_patch_harness for a ready test workspace and mount_apply_patch for the fake server interaction. Once Codex submits the turn, the harness provides both the tool output to inspect and the filesystem read needed to prove the patch really happened.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 4 external calls (assert_eq!, assert_regex_match, format!, skip_if_no_network!).


##### `apply_patch_custom_tool_call_updates_existing_file`  (lines 197–234)

```
async fn apply_patch_custom_tool_call_updates_existing_file() -> Result<()>
```

**Purpose**: Checks that an apply_patch custom tool call can modify an existing file. It confirms both the file change and the success text returned to the model.

**Data flow**: The test creates a file with initial text, prepares a patch that replaces that text, and mounts the patch request. After Codex processes the request, it checks the tool output for a successful modified-file report, then reads the file back and confirms the text changed from before to after.

**Call relations**: Like the create-file patch test, it uses the apply-patch harness to set up the workspace and mount_apply_patch to feed Codex a fake model tool call. The test then uses the harness to collect the returned output and verify the on-disk result.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 4 external calls (assert_eq!, assert_regex_match, format!, skip_if_no_network!).


##### `apply_patch_custom_tool_call_reports_failure_output`  (lines 237–268)

```
async fn apply_patch_custom_tool_call_reports_failure_output() -> Result<()>
```

**Purpose**: Checks that a failed apply_patch call returns the raw failure message expected by callers. This is important because failures need to be understandable and not hidden inside the normal success wrapper.

**Data flow**: The test prepares a patch that tries to update a file that does not exist. After Codex runs the tool call, the test reads the apply_patch output and compares it to the exact expected error message, including the workspace path and missing-file explanation.

**Call relations**: It uses the same apply-patch harness and fake mounted tool call as the success tests, but the input patch is intentionally invalid. The test also skips one Wine-related environment because the asserted failure text is POSIX-style and would not match there.

*Call graph*: calls 2 internal fn (apply_patch_harness, mount_apply_patch); 4 external calls (assert_eq!, format!, skip_if_no_network!, skip_if_wine_exec!).


##### `shell_output_is_freeform_for_nonzero_exit`  (lines 271–302)

```
async fn shell_output_is_freeform_for_nonzero_exit() -> Result<()>
```

**Purpose**: Verifies that a shell command that exits with an error code is still reported as freeform text in the same shape as a successful command. The failure code should be visible, but the serialization format should not change.

**Data flow**: The test asks the fake model to run a shell command that exits with code 42. It then reads the function-call output Codex sends back and checks that it begins with Exit code: 42, includes wall time, and has an Output section even though there is no command output.

**Call relations**: It uses shell_responses to build the fake shell command request and mounts that on the mock server. After the test turn completes, it inspects the server’s last request to confirm the non-zero result was returned in the expected plain-text format.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, shell_responses); 3 external calls (assert_regex_match, skip_if_no_network!, vec!).


##### `shell_command_output_is_freeform`  (lines 305–354)

```
async fn shell_command_output_is_freeform() -> Result<()>
```

**Purpose**: Checks the newer shell_command tool path and confirms its output is also returned as plain text with the standard header. This keeps behavior consistent across shell-related tool interfaces.

**Data flow**: The test constructs a fake tool call whose arguments ask Codex to run an echo command. After Codex completes the turn, it extracts the output string from the recorded request and verifies it contains exit code 0, wall time, and the echoed text under Output.

**Call relations**: Instead of using shell_responses, this test builds the streamed fake response inline because it includes shell_command-specific arguments. It still uses the same mock server and Codex test builder, then checks the final function-call output with a regex.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_regex_match, json!, skip_if_no_network!, vec!).


##### `shell_command_output_is_not_truncated_under_10k_bytes`  (lines 357–405)

```
async fn shell_command_output_is_not_truncated_under_10k_bytes() -> Result<()>
```

**Purpose**: Verifies that shell_command output at 10,000 bytes is returned in full. This protects against accidental truncation of outputs that are still within the intended size limit.

**Data flow**: The test asks Codex to run a Perl one-liner that prints exactly 10,000 copies of the character 1. It then reads the output sent back to the mock server and checks that the Output section contains all 10,000 characters after the usual exit-code and wall-time header.

**Call relations**: It builds the fake shell_command request inline, mounts it on the mock server, and submits a Codex turn. The recorded request becomes the evidence used to confirm that the output was not shortened at the boundary size.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_regex_match, json!, skip_if_no_network!, vec!).


##### `shell_command_output_is_not_truncated_over_10k_bytes`  (lines 408–456)

```
async fn shell_command_output_is_not_truncated_over_10k_bytes() -> Result<()>
```

**Purpose**: Checks the behavior when shell_command output is larger than 10,000 bytes. Despite the function name, the expected result here is a controlled truncation marker showing that long output was shortened in a recognizable way.

**Data flow**: The test asks Codex to run a Perl command that prints 10,001 copies of the character 1. It then extracts the returned output string and verifies that it has the normal header, followed by shortened output containing an ellipsis-style message that says characters were truncated.

**Call relations**: This test follows the same inline fake-response flow as the other shell_command size test. It uses the mock server’s last recorded request to confirm that oversized output is reduced with an explicit marker rather than silently cut or returned in another format.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_regex_match, json!, skip_if_no_network!, vec!).


### `core/tests/suite/abort_tasks.rs`

`test` · `test run`

These are integration tests, meaning they exercise several real parts of the system together instead of checking one small helper in isolation. The file focuses on a common but important situation: the model asks Codex to run a shell command, the command takes too long or the user changes their mind, and the user interrupts it. Without this behavior, Codex might leave a command running, fail to notify the user that the turn stopped, or forget to tell the model what happened.

The tests use a mock Responses API server. In plain terms, this is a pretend model server that sends carefully chosen events back to Codex. Those events tell Codex to call the `shell_command` tool with `sleep 60`, which is a command that waits for a long time. The tests then wait until Codex has actually started running the command before sending an interrupt, so they are checking the real in-progress case rather than a timing accident.

After the interrupt, the tests look for user-visible and model-visible consequences. One test checks that Codex emits a `TurnAborted` event. Another checks that the next model request includes a tool result saying the command was aborted by the user, with elapsed wall-clock time. The last checks that the next request also contains a `<turn_aborted>` marker in conversation history, so the model can understand that the previous turn did not finish normally.

#### Function details

##### `interrupt_long_running_tool_emits_turn_aborted`  (lines 23–68)

```
async fn interrupt_long_running_tool_emits_turn_aborted()
```

**Purpose**: This test checks the basic interrupt path. It starts a fake model response that asks Codex to run a long shell command, interrupts the session once the command has begun, and expects Codex to report that the turn was aborted.

**Data flow**: The test starts with a command string, `sleep 60`, and wraps it in fake server-sent events, which are streamed messages from the mock model server. Codex receives a user message, asks the mock server what to do, starts the shell command requested by the fake response, then receives an interrupt operation. The expected result is a `TurnAborted` event coming out of Codex.

**Call relations**: This test builds its world using the test support helpers: it starts a mock server, mounts one fake streamed response, creates a test Codex instance, and submits a user input operation. It uses event waiting as the bridge between steps: first it waits for `ExecCommandBegin` so the command is truly running, then it sends `Op::Interrupt`, then it waits for `TurnAborted` to prove the interrupt was observed and surfaced.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (default, wait_for_event, json!, vec!).


##### `interrupt_tool_records_history_entries`  (lines 75–174)

```
async fn interrupt_tool_records_history_entries()
```

**Purpose**: This test checks that an interrupted tool call is not just stopped, but also written into the conversation history that will be sent to the model later. It verifies that the next request includes both the original function call and a synthetic tool output saying the command was aborted.

**Data flow**: The test feeds Codex two fake model responses: the first asks for a long shell command, and the second completes a later follow-up turn. After Codex starts the command, the test waits briefly, interrupts it, and then sends another user message. It then inspects the two requests received by the mock server and confirms that the follow-up request contains the original tool call ID plus a `function_call_output` text saying `aborted by user` and including the elapsed wall time.

**Call relations**: This test extends the basic interrupt story into the next user turn. It uses a sequence of mocked server responses so Codex can first enter the interrupted tool-call state and then make a second request. After `TurnAborted`, it submits a follow-up user input and waits for `TurnComplete`, then asks the mock response object what Codex sent back to the model. The regular expression check is there to ensure the abort message has the expected human-readable shape and that the measured time is at least the short delay inserted before the interrupt.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex); 10 external calls (clone, default, from_secs_f32, new, assert!, assert_matches!, wait_for_event, json!, sleep, vec!).


##### `interrupt_persists_turn_aborted_marker_in_next_request`  (lines 179–256)

```
async fn interrupt_persists_turn_aborted_marker_in_next_request()
```

**Purpose**: This test checks that Codex records a clear marker in the next model request showing that the previous turn was aborted. The marker lets the model understand the conversation flow instead of treating the next message as if nothing unusual happened.

**Data flow**: The test sets up a first fake response that asks Codex to run `sleep 60`, then a second fake response for the follow-up turn. Codex receives the first user message, starts the command, is interrupted after a short delay, and emits `TurnAborted`. The test then sends a second user message, waits for completion, reads the second request sent to the mock server, and checks that one of the user-visible text entries contains `<turn_aborted>`.

**Call relations**: This test follows the same interrupt setup as the history-entry test, using a mocked response sequence and a shared test Codex instance. Its focus is narrower: after the abort and the follow-up turn, it inspects the second `/responses` request and looks specifically at the user text portions. This confirms that the abort marker is persisted into the next model-facing conversation context.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex); 9 external calls (clone, default, from_secs_f32, assert!, assert_eq!, wait_for_event, json!, sleep, vec!).


### `core/tests/suite/shell_snapshot.rs`

`test` · `test execution`

A shell snapshot is like taking a photo of a terminal’s setup before asking it to run commands. That setup can include exported variables, aliases, shell options, and the PATH variable that tells the system where to find programs. This test file makes sure Codex captures that setup into a temporary script file and then loads it when running commands through two tool paths: the newer unified exec tool and the older shell_command tool.

The tests build a fake Codex session with selected feature flags turned on. They then fake model responses that ask Codex to run a command, wait for Codex to announce that the command started, look for the snapshot file under the test Codex home directory, and finally check the command result. The file also checks platform differences: Linux and macOS start shells differently, while the Windows test is currently ignored.

Several tests focus on safety and correctness around environment policy. They deliberately overwrite the snapshot file after it is created, then verify that policy-set environment values such as PATH are still applied after the snapshot loads. Another test confirms that apply_patch is still recognized and handled specially even when shell snapshots are enabled. The final cleanup test checks that snapshot files do not linger after shutdown.

#### Function details

##### `wait_for_snapshot`  (lines 52–74)

```
async fn wait_for_snapshot(codex_home: &Path) -> Result<PathBuf>
```

**Purpose**: Waits until Codex has written a shell snapshot file inside the test home directory. Tests use it because snapshot creation happens asynchronously, so the file may not exist immediately.

**Data flow**: It receives the Codex home folder path, looks inside its shell_snapshots subfolder, and repeatedly checks for a .sh or .ps1 file. If it finds one, it returns that path; if no snapshot appears before the timeout, it fails the test with a clear error.

**Call relations**: The command-running helpers call this after they see a command begin, so they can inspect the snapshot that was used. The policy, apply_patch, and shutdown tests also call it directly when they need to modify, validate, or later check deletion of the snapshot file.

*Call graph*: called by 6 (linux_unified_exec_snapshot_preserves_shell_environment_policy_set, run_shell_command_snapshot_with_options, run_snapshot_command_with_options, shell_command_snapshot_preserves_shell_environment_policy_set, shell_command_snapshot_still_intercepts_apply_patch, shell_snapshot_deleted_after_shutdown_with_skills); 7 external calls (from_millis, from_secs, now, join, bail!, read_dir, sleep).


##### `wait_for_file_contents`  (lines 76–91)

```
async fn wait_for_file_contents(path: &Path) -> Result<String>
```

**Purpose**: Waits for a file to appear and then reads its text. In this file it is used to confirm that apply_patch really created the expected file.

**Data flow**: It receives a path, tries to read it as text, and retries while the file is still missing. Once reading succeeds it returns the contents; if another read error occurs or the timeout is reached, it returns an error.

**Call relations**: The apply_patch test uses this after Codex reports that patch application finished. It gives the test a reliable way to wait for filesystem work that may complete just after the event is emitted.

*Call graph*: 6 external calls (from_millis, from_secs, now, bail!, read_to_string, sleep).


##### `policy_set_path_for_test`  (lines 93–95)

```
fn policy_set_path_for_test() -> HashMap<String, String>
```

**Purpose**: Builds a small test environment policy that forces PATH to a known value. This makes it possible to prove that Codex reapplies policy rules even after loading a shell snapshot.

**Data flow**: It takes no input and returns a map containing one entry: PATH set to the test policy path. The returned map is plugged into the test Codex configuration.

**Call relations**: The environment-policy tests use this when they build their harness. It sets up the condition later checked by the generated shell command.

*Call graph*: 1 external calls (from).


##### `snapshot_override_content_for_policy_test`  (lines 97–101)

```
fn snapshot_override_content_for_policy_test() -> String
```

**Purpose**: Creates fake snapshot file contents for the policy tests. The fake snapshot sets PATH to a competing value and sets a marker variable, so the test can tell whether the snapshot was actually loaded.

**Data flow**: It takes no input and returns a shell script as a string. That script exports a snapshot-only PATH value and a marker variable with a known value.

**Call relations**: The policy tests write this string over the real snapshot file after a warm-up command creates it. The next command then proves both that the snapshot loaded and that the policy PATH still won afterward.

*Call graph*: called by 2 (linux_unified_exec_snapshot_preserves_shell_environment_policy_set, shell_command_snapshot_preserves_shell_environment_policy_set); 1 external calls (format!).


##### `command_asserting_policy_after_snapshot`  (lines 103–107)

```
fn command_asserting_policy_after_snapshot() -> String
```

**Purpose**: Builds a shell command that checks the order of environment setup. It succeeds only if the snapshot marker exists but PATH is not left at the snapshot’s PATH value and does contain the policy PATH.

**Data flow**: It takes no input and returns a shell script command as text. When run, that command prints the success marker if the environment is correct, otherwise it prints diagnostic values showing the PATH and marker it saw.

**Call relations**: The policy tests run this command after replacing the snapshot contents. Its output is the main evidence that Codex loads snapshots first and then preserves or reapplies the configured environment policy.

*Call graph*: called by 2 (linux_unified_exec_snapshot_preserves_shell_environment_policy_set, shell_command_snapshot_preserves_shell_environment_policy_set); 1 external calls (format!).


##### `run_snapshot_command`  (lines 109–111)

```
async fn run_snapshot_command(command: &str) -> Result<SnapshotRun>
```

**Purpose**: Runs a command through the unified exec tool with shell snapshots enabled, using default test options. It is a convenience wrapper for tests that do not need special environment settings.

**Data flow**: It receives a command string, creates default snapshot-run options, and passes both to the fuller helper. It returns a SnapshotRun containing the start event, end event, snapshot path, snapshot contents, and Codex home path.

**Call relations**: The Linux, macOS, and ignored Windows unified-exec tests call this to avoid repeating the harness setup. It hands all real work to run_snapshot_command_with_options.

*Call graph*: calls 1 internal fn (run_snapshot_command_with_options); called by 3 (linux_unified_exec_uses_shell_snapshot, macos_unified_exec_uses_shell_snapshot, windows_unified_exec_uses_shell_snapshot); 1 external calls (default).


##### `run_snapshot_command_with_options`  (lines 113–210)

```
async fn run_snapshot_command_with_options(
    command: &str,
    options: SnapshotRunOptions,
) -> Result<SnapshotRun>
```

**Purpose**: Sets up a fake Codex session and runs one unified exec command while shell snapshots are enabled. It collects the important evidence that tests need to make assertions.

**Data flow**: It receives a command and optional environment-policy settings. It builds a test Codex configuration with UnifiedExec and ShellSnapshot enabled, mounts fake server-sent events that ask Codex to call exec_command, submits user input, waits for command start, reads the snapshot file, waits for command end and turn completion, then returns all collected data in a SnapshotRun.

**Call relations**: run_snapshot_command calls this for the ordinary unified-exec snapshot tests. Inside the flow it relies on the test harness, mocked SSE responses, permission setup helpers, wait_for_snapshot, and event-waiting helpers to drive Codex like a real model/tool turn.

*Call graph*: calls 6 internal fn (mount_sse_sequence, with_builder, local_selections, test_codex, turn_permission_fields, wait_for_snapshot); called by 1 (run_snapshot_command); 6 external calls (default, wait_for_event, wait_for_event_match, read_to_string, json!, vec!).


##### `run_shell_command_snapshot`  (lines 212–214)

```
async fn run_shell_command_snapshot(command: &str) -> Result<SnapshotRun>
```

**Purpose**: Runs a command through the shell_command tool with shell snapshots enabled, using default test options. It keeps the basic shell_command test short and readable.

**Data flow**: It receives a command string, creates default options, and delegates to the fuller shell_command helper. The result is a SnapshotRun with command events and snapshot details.

**Call relations**: The Linux shell_command snapshot test calls this. It hands the actual setup and event collection to run_shell_command_snapshot_with_options.

*Call graph*: calls 1 internal fn (run_shell_command_snapshot_with_options); called by 1 (linux_shell_command_uses_shell_snapshot); 1 external calls (default).


##### `run_shell_command_snapshot_with_options`  (lines 216–308)

```
async fn run_shell_command_snapshot_with_options(
    command: &str,
    options: SnapshotRunOptions,
) -> Result<SnapshotRun>
```

**Purpose**: Sets up a fake Codex session and runs one shell_command command while shell snapshots are enabled. It mirrors the unified exec helper but targets the older tool name and argument shape.

**Data flow**: It receives a command and optional environment-policy settings. It enables ShellSnapshot, mounts fake model responses that call shell_command, submits user input with local environment and no approval prompt, waits for command start, reads the snapshot file, waits for command completion, and returns the gathered SnapshotRun.

**Call relations**: run_shell_command_snapshot uses this for the simple shell_command path. The structure matches run_snapshot_command_with_options so the tests can compare behavior across the two command-running tools.

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

**Purpose**: Runs one tool call on an already-created test harness. This is useful for tests that need two turns in the same Codex session, such as first creating a snapshot and then reusing or modifying it.

**Data flow**: It receives a harness, prompt text, call id, tool name, and JSON arguments. It mounts fake model responses for that tool call, submits the prompt to Codex with standard test permissions, waits for the matching command begin and end events, waits for the turn to complete, and returns the command end event.

**Call relations**: The environment-policy tests call this twice on the same harness: once to warm up and create a snapshot, and once to verify behavior after the snapshot file is overwritten. It shares the same event-driven pattern as the larger command helpers.

*Call graph*: calls 5 internal fn (mount_sse_sequence, server, test, local_selections, turn_permission_fields); called by 2 (linux_unified_exec_snapshot_preserves_shell_environment_policy_set, shell_command_snapshot_preserves_shell_environment_policy_set); 4 external calls (default, wait_for_event, wait_for_event_match, vec!).


##### `normalize_newlines`  (lines 378–380)

```
fn normalize_newlines(text: &str) -> String
```

**Purpose**: Makes command output easier to compare across operating systems by changing Windows-style line endings to Unix-style line endings.

**Data flow**: It receives text, replaces every carriage-return-plus-newline sequence with a plain newline, and returns the normalized string. It does not change anything outside that returned value.

**Call relations**: Tests call this before checking stdout so that line-ending differences do not cause false failures. It is especially helpful when the same behavior may be checked on different platforms.

*Call graph*: called by 1 (linux_unified_exec_uses_shell_snapshot).


##### `assert_posix_snapshot_sections`  (lines 382–391)

```
fn assert_posix_snapshot_sections(snapshot: &str)
```

**Purpose**: Checks that a Unix-like shell snapshot contains the expected major sections. It verifies that the snapshot looks like a real captured shell setup rather than an empty or malformed file.

**Data flow**: It receives the snapshot text and asserts that it includes the snapshot header, aliases section, exports section, shell options section, and PATH information. If any piece is missing, the test fails.

**Call relations**: Linux, macOS, shell_command, and apply_patch tests call this after reading a snapshot file. It gives all those tests a shared definition of what a healthy POSIX-style snapshot should include.

*Call graph*: called by 4 (linux_shell_command_uses_shell_snapshot, linux_unified_exec_uses_shell_snapshot, macos_unified_exec_uses_shell_snapshot, shell_command_snapshot_still_intercepts_apply_patch); 1 external calls (assert!).


##### `linux_unified_exec_uses_shell_snapshot`  (lines 395–412)

```
async fn linux_unified_exec_uses_shell_snapshot() -> Result<()>
```

**Purpose**: Verifies on Linux that the unified exec tool runs commands through a shell snapshot. It confirms both the command shape and the successful output.

**Data flow**: It runs an echo command through the unified exec helper, normalizes stdout, and checks that the recorded shell command uses the expected -lc form, that the snapshot lives under the Codex home directory, that the snapshot has the expected POSIX sections, and that the command exits successfully with the expected output.

**Call relations**: This test relies on run_snapshot_command to perform the full fake Codex turn. It then uses normalize_newlines and assert_posix_snapshot_sections to make focused assertions about Linux behavior.

*Call graph*: calls 3 internal fn (assert_posix_snapshot_sections, normalize_newlines, run_snapshot_command); 2 external calls (assert!, assert_eq!).


##### `linux_shell_command_uses_shell_snapshot`  (lines 416–432)

```
async fn linux_shell_command_uses_shell_snapshot() -> Result<()>
```

**Purpose**: Verifies on Unix-like non-Windows platforms that the shell_command tool also uses a shell snapshot. This protects the older command path from drifting away from the unified exec behavior.

**Data flow**: It runs an echo command through shell_command, checks that the launched shell uses the expected -lc form, confirms the snapshot file is under Codex home and has POSIX sections, and verifies stdout and exit code.

**Call relations**: This test calls run_shell_command_snapshot for the setup and run. It then shares the same snapshot-section assertion used by the unified exec tests.

*Call graph*: calls 2 internal fn (assert_posix_snapshot_sections, run_shell_command_snapshot); 2 external calls (assert!, assert_eq!).


##### `shell_command_snapshot_preserves_shell_environment_policy_set`  (lines 436–481)

```
async fn shell_command_snapshot_preserves_shell_environment_policy_set() -> Result<()>
```

**Purpose**: Proves that shell_command does not let a loaded snapshot permanently override environment values that policy says must be set. In plain terms, the saved terminal setup is allowed to load, but the project’s safety/configuration rules still win.

**Data flow**: It builds a harness with ShellSnapshot enabled and PATH forced by policy, runs a warm-up shell_command to create a snapshot, overwrites that snapshot with content that sets a different PATH and marker variable, then runs a generated checking command. The test passes only if stdout shows the policy PATH was present after the snapshot loaded and the command exited successfully.

**Call relations**: This test uses policy_set_path_for_test during harness setup, run_tool_turn_on_harness for both command turns, wait_for_snapshot to find the snapshot, snapshot_override_content_for_policy_test to replace it, and command_asserting_policy_after_snapshot to verify the final environment.

*Call graph*: calls 6 internal fn (with_builder, test_codex, command_asserting_policy_after_snapshot, run_tool_turn_on_harness, snapshot_override_content_for_policy_test, wait_for_snapshot); 4 external calls (assert!, assert_eq!, write, json!).


##### `linux_unified_exec_snapshot_preserves_shell_environment_policy_set`  (lines 485–535)

```
async fn linux_unified_exec_snapshot_preserves_shell_environment_policy_set() -> Result<()>
```

**Purpose**: Performs the same environment-policy check as the shell_command test, but for the unified exec tool on Linux. It ensures both command paths obey the same rule: snapshots load, but configured environment policy is preserved.

**Data flow**: It creates a harness with UnifiedExec and ShellSnapshot enabled plus a forced PATH policy. After a warm-up exec_command creates the snapshot, it overwrites the snapshot with fake content, runs a checking command through exec_command, and asserts that the output is the expected success marker with exit code zero.

**Call relations**: This test follows the same two-turn story as shell_command_snapshot_preserves_shell_environment_policy_set. It calls run_tool_turn_on_harness for each turn and uses the shared snapshot-content and checking-command builders.

*Call graph*: calls 6 internal fn (with_builder, test_codex, command_asserting_policy_after_snapshot, run_tool_turn_on_harness, snapshot_override_content_for_policy_test, wait_for_snapshot); 4 external calls (assert!, assert_eq!, write, json!).


##### `shell_command_snapshot_still_intercepts_apply_patch`  (lines 539–644)

```
async fn shell_command_snapshot_still_intercepts_apply_patch() -> Result<()>
```

**Purpose**: Checks that enabling shell snapshots does not break Codex’s special handling of apply_patch. apply_patch is a patching command that Codex intercepts so it can report patch-specific begin and end events instead of treating it as an ordinary shell command.

**Data flow**: It creates a harness with ShellSnapshot enabled, prepares a shell script that calls apply_patch to add a file, mounts fake model responses for shell_command, submits the user input, waits for and validates the snapshot, then watches events until the turn completes. It asserts that patch begin and patch end events were seen, that the patch succeeded, and that the new file contains the expected text.

**Call relations**: Unlike the smaller helper-based tests, this test spells out the full harness and event flow because it needs to watch patch-specific events. It uses wait_for_snapshot and assert_posix_snapshot_sections for snapshot validation, and wait_for_file_contents to verify the filesystem result.

*Call graph*: calls 7 internal fn (mount_sse_sequence, with_builder, local_selections, test_codex, turn_permission_fields, assert_posix_snapshot_sections, wait_for_snapshot); 7 external calls (default, assert!, assert_eq!, wait_for_event, read_to_string, json!, vec!).


##### `shell_snapshot_deleted_after_shutdown_with_skills`  (lines 648–677)

```
async fn shell_snapshot_deleted_after_shutdown_with_skills() -> Result<()>
```

**Purpose**: Verifies that the temporary shell snapshot file is removed when Codex shuts down. This prevents stale shell setup files from being left behind after a session ends.

**Data flow**: It starts a harness with ShellSnapshot enabled, waits for the snapshot file to exist, sends a shutdown operation to Codex, waits for shutdown completion, drops the test objects, pauses briefly, and then checks that the snapshot path no longer exists.

**Call relations**: This test calls wait_for_snapshot at the beginning to capture the exact file that should disappear. It then drives the shutdown flow through Codex events and checks cleanup after the harness is dropped.

*Call graph*: calls 3 internal fn (with_builder, test_codex, wait_for_snapshot); 5 external calls (from_millis, assert!, assert_eq!, wait_for_event, sleep).


##### `macos_unified_exec_uses_shell_snapshot`  (lines 685–710)

```
async fn macos_unified_exec_uses_shell_snapshot() -> Result<()>
```

**Purpose**: Verifies on macOS that unified exec uses a shell snapshot with the macOS-specific shell invocation pattern. The test is marked ignored on macOS because it requires unrestricted networking in that environment.

**Data flow**: It runs an echo command through the unified exec helper, reads the recorded command arguments, and checks that the snapshot-loading wrapper and final command are arranged as expected. It also verifies the snapshot location, POSIX snapshot sections, stdout, and exit code.

**Call relations**: This test uses run_snapshot_command to drive the Codex turn and assert_posix_snapshot_sections to validate the snapshot body. Its assertions differ from the Linux test because macOS uses a different command wrapper to source the snapshot.

*Call graph*: calls 2 internal fn (assert_posix_snapshot_sections, run_snapshot_command); 2 external calls (assert!, assert_eq!).


##### `windows_unified_exec_uses_shell_snapshot`  (lines 715–746)

```
async fn windows_unified_exec_uses_shell_snapshot() -> Result<()>
```

**Purpose**: Documents the expected Windows behavior for unified exec with shell snapshots, although the test is currently ignored. It checks for PowerShell-style snapshot loading rather than POSIX shell behavior.

**Data flow**: It runs a PowerShell command through the unified exec helper, finds the snapshot argument in the recorded command, and checks for expected PowerShell flags and wrapper text. It then verifies that the snapshot is under Codex home, includes basic snapshot sections, prints the expected output, and exits successfully.

**Call relations**: This test calls run_snapshot_command like the Linux and macOS unified-exec tests. It serves as a platform-specific expectation for future or manual Windows validation, but it does not normally run because it is ignored.

*Call graph*: calls 1 internal fn (run_snapshot_command); 2 external calls (assert!, assert_eq!).


### `core/tests/suite/tool_parallelism.rs`

`test` · `test run`

This is a non-Windows test file for Codex’s tool-calling behavior. In Codex, the model can ask the system to run tools, such as shell commands or a special test tool. If the model asks for several independent tools at once, Codex should run them in parallel. Without that, a turn could become much slower: two 300 millisecond tasks would take about 600 milliseconds instead of roughly 300.

The tests build a fake Codex session and connect it to a mock server that pretends to be the model API. The mock server sends scripted server-sent events, which are streamed messages from the server to the client. Those messages tell Codex to call tools, finish a response, or continue with a follow-up response.

Several tests measure elapsed time to prove that shell tools, test tools, and mixed tool types overlap. Another test checks the shape of the follow-up request Codex sends back to the model: all original function calls should appear before all tool outputs, and outputs should match the original call order. The final test uses a delayed stream to confirm an important behavior: shell commands should begin as soon as their tool-call messages arrive, not only after the model response says it is complete.

#### Function details

##### `run_turn`  (lines 35–70)

```
async fn run_turn(test: &TestCodex, prompt: &str) -> anyhow::Result<()>
```

**Purpose**: Runs one user turn in a test Codex session and waits until Codex reports that the turn is finished. It sets the turn up with local environment information, no approval prompts, and disabled sandbox-style restrictions so the tests can focus on tool timing.

**Data flow**: It receives a test session and a prompt string. It reads the session’s model and working directory, builds the permission and environment settings for the turn, sends the user input into Codex, then waits until a TurnComplete event appears. It returns success when the turn finishes, or an error if submitting or waiting fails.

**Call relations**: The timing and grouping tests call this helper when they need Codex to process a scripted mock-model response. It prepares the same kind of turn each time, then hands control to Codex and waits for the completion event so the test can safely inspect timing or outgoing requests afterward.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 3 (read_file_tools_run_in_parallel, run_turn_and_measure, tool_results_grouped); 3 external calls (default, wait_for_event, vec!).


##### `run_turn_and_measure`  (lines 72–76)

```
async fn run_turn_and_measure(test: &TestCodex, prompt: &str) -> anyhow::Result<Duration>
```

**Purpose**: Runs one Codex turn and measures how long it took. The parallelism tests use this to tell whether multiple tool calls overlapped in time.

**Data flow**: It receives a test session and prompt. It records the current time, calls run_turn to do the actual Codex interaction, then returns the elapsed duration. If the turn fails, the error is passed back instead of a duration.

**Call relations**: The tests that care about speed call this helper instead of run_turn directly. After it gets the finished duration, those tests pass the value to assert_parallel_duration to check that the run was fast enough to count as parallel.

*Call graph*: calls 1 internal fn (run_turn); called by 3 (mixed_parallel_tools_run_in_parallel, read_file_tools_run_in_parallel, shell_tools_run_in_parallel); 1 external calls (now).


##### `build_codex_with_test_tool`  (lines 78–81)

```
async fn build_codex_with_test_tool(server: &wiremock::MockServer) -> anyhow::Result<TestCodex>
```

**Purpose**: Creates a test Codex session configured with a model name that enables the project’s special synchronization test tool. This keeps the setup for those tests short and consistent.

**Data flow**: It receives a mock server. It starts from the standard test Codex builder, sets the model to a test Codex model, builds the session against the mock server, and returns the ready-to-use TestCodex object.

**Call relations**: The tests that use the artificial test_sync_tool call this helper during setup. It hides the repeated builder configuration so the test bodies can focus on the mock responses and assertions.

*Call graph*: calls 1 internal fn (test_codex); called by 3 (mixed_parallel_tools_run_in_parallel, read_file_tools_run_in_parallel, tool_results_grouped).


##### `assert_parallel_duration`  (lines 83–89)

```
fn assert_parallel_duration(actual: Duration)
```

**Purpose**: Checks that a measured test turn finished quickly enough to show that tool calls ran in parallel. It allows extra time for slow continuous integration machines so the test is not too brittle.

**Data flow**: It receives an elapsed duration. It compares that duration with a fixed upper limit of 1.6 seconds. If the duration is below the limit, nothing changes; if it is too high, the test fails with a message showing the measured time.

**Call relations**: The timing-based tests call this after run_turn_and_measure returns. It is the shared final gate that turns a slow run into a failed test.

*Call graph*: called by 3 (mixed_parallel_tools_run_in_parallel, read_file_tools_run_in_parallel, shell_tools_run_in_parallel); 1 external calls (assert!).


##### `read_file_tools_run_in_parallel`  (lines 92–151)

```
async fn read_file_tools_run_in_parallel() -> anyhow::Result<()>
```

**Purpose**: Verifies that two calls to the special synchronization test tool can run at the same time. Despite the name, this test is about the test tool path rather than manually reading a real file.

**Data flow**: It starts a mock server, builds a Codex test session, and prepares scripted model responses. First it runs a warm-up turn with two short synchronized tool calls. Then it runs the real turn with two longer synchronized tool calls and measures the total time. The test passes if the time is short enough to show overlap.

**Call relations**: This test uses build_codex_with_test_tool for setup, mount_sse_sequence and sse to teach the fake server what to stream, run_turn for warm-up, run_turn_and_measure for the measured turn, and assert_parallel_duration for the final timing check.

*Call graph*: calls 7 internal fn (mount_sse_sequence, sse, start_mock_server, assert_parallel_duration, build_codex_with_test_tool, run_turn, run_turn_and_measure); 3 external calls (json!, skip_if_no_network!, vec!).


##### `shell_tools_run_in_parallel`  (lines 154–186)

```
async fn shell_tools_run_in_parallel() -> anyhow::Result<()>
```

**Purpose**: Verifies that multiple shell_command tool calls run in parallel. This matters because shell commands are common tools, and running them one by one would make a single model turn unnecessarily slow.

**Data flow**: It starts a mock server and a Codex test session, then scripts the server to request two shell commands that each sleep briefly. It runs one measured turn and checks that the total time is closer to one sleep than two sleeps. The shell is run as a non-login shell to avoid user startup scripts making the timing unreliable.

**Call relations**: This test builds the session directly with test_codex, uses the mock server helpers to stream the shell calls, measures the turn with run_turn_and_measure, and passes the result to assert_parallel_duration.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, test_codex, assert_parallel_duration, run_turn_and_measure); 4 external calls (json!, to_string, skip_if_no_network!, vec!).


##### `mixed_parallel_tools_run_in_parallel`  (lines 189–222)

```
async fn mixed_parallel_tools_run_in_parallel() -> anyhow::Result<()>
```

**Purpose**: Verifies that different kinds of tools can run at the same time, not just two calls of the same tool. It combines the special test tool with a shell command.

**Data flow**: It creates a mock server and Codex session, then prepares one test_sync_tool call and one shell_command call. The mocked model response asks for both during the same turn. The function measures how long the turn takes and expects the combined work to finish quickly enough to prove the two tool types overlapped.

**Call relations**: This test uses build_codex_with_test_tool because one of the requested tools is the test synchronization tool. It uses run_turn_and_measure for the full Codex turn and assert_parallel_duration to decide whether the mixed tools were truly parallel.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, assert_parallel_duration, build_codex_with_test_tool, run_turn_and_measure); 4 external calls (json!, to_string, skip_if_no_network!, vec!).


##### `tool_results_grouped`  (lines 225–300)

```
async fn tool_results_grouped() -> anyhow::Result<()>
```

**Purpose**: Checks that when Codex sends tool results back to the model, it groups the conversation items in a stable and understandable way. All function-call records should come first, followed by all matching outputs in the same order.

**Data flow**: It scripts the mock server to request three shell commands, then runs a Codex turn. After Codex sends the follow-up request containing tool outputs, the test reads that request body. It separates function call entries from function call output entries, confirms there are three of each, confirms every call appears before every output, and confirms each output matches the call id at the same position.

**Call relations**: This test uses build_codex_with_test_tool and run_turn for the basic Codex flow, but its main interest is the outgoing request captured by the mock server. The assertions protect the formatting contract between Codex and the model API after parallel tools have completed.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, build_codex_with_test_tool, run_turn); 6 external calls (assert!, assert_eq!, json!, to_string, skip_if_no_network!, vec!).


##### `shell_tools_start_before_response_completed_when_stream_delayed`  (lines 303–437)

```
async fn shell_tools_start_before_response_completed_when_stream_delayed() -> anyhow::Result<()>
```

**Purpose**: Verifies that shell tools start as soon as their tool-call events arrive from the stream, even if the server has not yet sent the response-completed event. This prevents unnecessary waiting during streamed model responses.

**Data flow**: It creates a temporary file and shell command that writes the current timestamp into that file. It starts a streaming mock server whose chunks are held behind manual gates. After releasing the first chunk, Codex receives four shell tool calls but not the completion message. The test waits until all four commands have written timestamps, then releases the completion chunk, waits for the turn to finish, and checks that every command timestamp is earlier than or equal to the recorded response completion time. Finally it shuts down the streaming server.

**Call relations**: This test uses the lower-level streaming server helpers instead of the simpler mock-server helpers because it needs precise control over when parts of the server stream are delivered. It submits the user input directly, releases stream gates in a controlled order, waits for TurnComplete at the end, and proves that tool execution began before the delayed completion signal.

*Call graph*: calls 5 internal fn (sse, start_streaming_sse_server, local_selections, test_codex, turn_permission_fields); 16 external calls (default, from_millis, from_secs, assert!, assert_eq!, wait_for_event, format!, read_to_string, try_from, json! (+6 more)).


### `core/tests/suite/truncation.rs`

`test` · `test run`

When Codex runs a tool, the result often has to be sent back to the model so the model can decide what to do next. That is fine for small results, but a command like `seq 1 100000` can produce a huge wall of text. Without limits, Codex could waste model context, slow down, or fail because the message is too large. This test file checks that Codex trims those outputs in the right way.

The tests use a mock model server. The fake model first asks Codex to run a tool, such as a shell command or an MCP tool. MCP means “Model Context Protocol,” a way for Codex to talk to external tools through a small server. Codex runs the tool, formats the result, and sends it back to the mock model. The tests then inspect that outgoing message.

The file covers several important cases: shell output trimmed by character limits, shell output trimmed by token-style limits, avoiding duplicate truncation markers, MCP text output truncation, MCP image output preservation, and custom settings that raise the limit so output is not trimmed. The overall idea is like packing a suitcase: Codex should keep the most useful beginning and ending of the output, clearly mark what was removed, and avoid damaging non-text items like images.

#### Function details

##### `assert_wall_time_header`  (lines 34–40)

```
fn assert_wall_time_header(output: &str)
```

**Purpose**: This helper checks that a text block starts with the standard timing header used for tool output. It confirms the header says how long the tool took and is immediately followed by an `Output:` marker.

**Data flow**: It takes one output string. It splits the string at the first newline, checks that the first line looks like `Wall time: ... seconds`, and checks that the second part begins with exactly `Output:`. It does not return a value; it passes silently or fails the test.

**Call relations**: The MCP image-output test calls this helper when it inspects the first item returned to the model. That keeps the image test focused on the image behavior while reusing one clear check for the timing text.

*Call graph*: called by 1 (mcp_image_output_preserves_image_and_no_text_summary); 2 external calls (assert_eq!, assert_regex_match).


##### `tool_call_output_configured_limit_chars_type`  (lines 45–119)

```
async fn tool_call_output_configured_limit_chars_type() -> Result<()>
```

**Purpose**: This test checks that a very large shell command result can be allowed through when the configured output budget is very high. It also verifies that, for this model path, the returned shell output is plain text rather than JSON.

**Data flow**: The test starts a fake model server, configures Codex with model `gpt-5.2` and a large tool-output limit, and has the fake model request a shell command that prints numbers from 1 to 100000. Codex runs the command and sends the result back to the fake model. The test reads that sent-back result, normalizes line endings, and checks that it is plain text, around the expected large size, and does not contain a truncation marker.

**Call relations**: This is a full end-to-end test using the mock server helpers. The mock model asks for the shell tool, Codex executes it, then the second mock request captures what Codex sends back so the test can verify the formatting and size.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (assert!, cfg!, json!, skip_if_no_network!, vec!).


##### `tool_call_output_exceeds_limit_truncated_chars_limit`  (lines 124–196)

```
async fn tool_call_output_exceeds_limit_truncated_chars_limit() -> Result<()>
```

**Purpose**: This test checks that an oversized shell command result is shortened when using the default limit for the `gpt-5.2` model path. It expects the truncation message to report removed characters.

**Data flow**: The test creates a fake model conversation where the model asks Codex to run a command that prints 100000 lines. After Codex runs it, the test reads the tool result that Codex sends back to the model. It checks that the output is plain text, includes the normal exit-code, timing, line-count, and output headers, contains a `chars truncated` marker, and is reduced to roughly 10000 characters.

**Call relations**: The mock server drives the conversation by sending a tool-call event first and a final assistant message second. This test sits at the end of that flow and inspects the second request, which is where Codex reports the command output back to the model.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (assert!, cfg!, assert_regex_match, json!, skip_if_no_network!, vec!).


##### `tool_call_output_exceeds_limit_truncated_for_model`  (lines 201–277)

```
async fn tool_call_output_exceeds_limit_truncated_for_model() -> Result<()>
```

**Purpose**: This test checks token-based truncation for a newer model path. A token is a small chunk of text used by language models, so this verifies that Codex reports a token-based cut rather than a character-based one.

**Data flow**: The test sets up Codex with model `gpt-5.4`, has the fake model request a shell command that prints 100000 lines, and waits for Codex to send the result back. It then verifies that the output starts with normal shell-result headers, keeps the beginning and end of the command output, and includes a marker saying many tokens were truncated.

**Call relations**: Like the other shell tests, the first mock model response asks Codex to run `shell_command`; the second mocked response captures the next model request. This test confirms that the formatting policy chosen for `gpt-5.4` is the token-oriented one.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (assert!, cfg!, assert_regex_match, json!, skip_if_no_network!, vec!).


##### `tool_call_output_truncated_only_once`  (lines 281–337)

```
async fn tool_call_output_truncated_only_once() -> Result<()>
```

**Purpose**: This test makes sure Codex does not add more than one truncation notice to a shell output. Duplicate notices would confuse the model and make the output look as if it had been trimmed multiple times.

**Data flow**: The test asks Codex to run a command that prints 10000 lines, which is enough to trigger truncation. It reads the output Codex sends back to the model and counts how many times the phrase `tokens truncated` appears. The test passes only if the count is exactly one.

**Call relations**: The fake model asks for a shell command, Codex runs and trims the result, and the test examines the captured follow-up request. It focuses on the final formatted text after all truncation steps have had a chance to run.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (assert_eq!, cfg!, json!, skip_if_no_network!, vec!).


##### `mcp_tool_call_output_exceeds_limit_truncated_for_model`  (lines 342–441)

```
async fn mcp_tool_call_output_exceeds_limit_truncated_for_model() -> Result<()>
```

**Purpose**: This test checks that a large text result from an MCP tool is also shortened before being sent back to the model. It makes sure MCP output uses the right format and does not borrow shell-specific line-count headers.

**Data flow**: The test prepares a very large message, starts a mock model server, and configures a local MCP test server reached through standard input and output. The fake model asks Codex to call the MCP `echo` tool with the large message. Codex runs the MCP tool, wraps the result with timing information, truncates the text to fit the configured limit, and sends it back. The test checks that the result has a wall-time header, contains JSON-like echo output with a token-truncation marker, stays under the expected size, and does not contain shell-only text such as `Total output lines:`.

**Call relations**: This test connects three pieces: the fake model server, Codex, and a real test MCP server binary. After the MCP server is ready, the fake model triggers the tool call, and the captured follow-up request shows whether Codex formatted MCP tool output correctly.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only); 8 external calls (assert!, assert_regex_match, stdio_server_bin, wait_for_mcp_server, format!, json!, skip_if_no_network!, vec!).


##### `mcp_image_output_preserves_image_and_no_text_summary`  (lines 446–568)

```
async fn mcp_image_output_preserves_image_and_no_text_summary() -> Result<()>
```

**Purpose**: This test verifies that an MCP tool result containing an image is preserved as an image item, not flattened into text or given a misleading truncation summary. This matters because image content must remain structured for the model to understand it as an image.

**Data flow**: The test provides a tiny PNG image as a data URL through the MCP test server’s environment. The fake model asks Codex to call the MCP `image` tool. Codex receives the MCP result and sends the model an output array: first a small wall-time text item, then an image item. The test checks that there are exactly two items, the first has the expected timing header, and the second matches the original image URL with high detail.

**Call relations**: This test uses the helper `assert_wall_time_header` for the timing text. Instead of the simpler turn-submission helper, it submits a user input operation with explicit thread settings so the MCP tool and permissions are set up exactly as needed, then waits for the turn to complete before checking the captured model request.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, assert_wall_time_header, read_only); 9 external calls (default, assert!, assert_eq!, stdio_server_bin, wait_for_event, wait_for_mcp_server, format!, skip_if_no_network!, vec!).


##### `token_policy_marker_reports_tokens`  (lines 572–619)

```
async fn token_policy_marker_reports_tokens() -> Result<()>
```

**Purpose**: This test checks that when Codex is using a token-based output limit, the truncation marker says tokens were removed. The wording matters because it tells the model and developers what kind of budget caused the cut.

**Data flow**: The test sets model `gpt-5.4` with a very small tool-output token limit, asks Codex to run `seq 1 150`, and captures the shell output sent back to the model. It verifies that the output keeps the early and late lines while the middle contains a `tokens truncated` marker.

**Call relations**: The mock model triggers the shell command, Codex applies its token-style policy, and the test checks the resulting text in the next request to the mock server. It pairs with the byte-policy test to prove the marker changes with the policy.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (assert_regex_match, json!, skip_if_no_network!, vec!).


##### `byte_policy_marker_reports_bytes`  (lines 623–670)

```
async fn byte_policy_marker_reports_bytes() -> Result<()>
```

**Purpose**: This test checks that when Codex is using a byte- or character-style output limit, the truncation marker says characters were removed. This avoids claiming token-based truncation when the limit was estimated by text size.

**Data flow**: The test sets model `gpt-5.2` with a small configured tool-output limit, asks Codex to run `seq 1 150`, and reads the shell result sent back to the model. It checks that the beginning and ending lines remain and that the middle contains a `chars truncated` marker.

**Call relations**: The fake model asks for the shell command and later receives Codex’s formatted result. This test mirrors the token-marker test but uses a model path whose policy reports character-style truncation.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (assert_regex_match, json!, skip_if_no_network!, vec!).


##### `shell_command_output_not_truncated_with_custom_limit`  (lines 674–730)

```
async fn shell_command_output_not_truncated_with_custom_limit() -> Result<()>
```

**Purpose**: This test confirms that shell command output is not shortened when the user configuration gives Codex enough budget. It protects against over-eager truncation.

**Data flow**: The test configures a large tool-output limit, asks Codex to run `seq 1 1000`, and builds the exact expected body of numbers from 1 to 1000. After Codex sends the tool result back to the model, the test checks that the full number list is present at the end and that no truncation marker appears.

**Call relations**: The fake model causes a shell call, and the captured follow-up request proves how Codex reported the result. This test complements the truncation tests by verifying the escape hatch: raising the limit should preserve full output.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (assert!, json!, skip_if_no_network!, vec!).


##### `mcp_tool_call_output_not_truncated_with_custom_limit`  (lines 734–830)

```
async fn mcp_tool_call_output_not_truncated_with_custom_limit() -> Result<()>
```

**Purpose**: This test confirms that large MCP text output is left intact when the configured output limit is high enough. It ensures the same custom-limit behavior works for external MCP tools, not only shell commands.

**Data flow**: The test creates an 80000-character message, configures a local MCP echo server, and raises Codex’s tool-output limit. The fake model asks Codex to call the MCP echo tool with that large message. Codex runs the tool and sends the serialized result back to the model. The test checks that the returned length matches the expected full size including the wall-time header, and that no truncation marker appears.

**Call relations**: This test again joins the mock model server, Codex, and the stdio MCP test server. Once the MCP server is ready, the model-triggered tool call flows through Codex, and the final captured request confirms that the raised limit applies to MCP output too.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, read_only); 8 external calls (assert!, assert_eq!, stdio_server_bin, wait_for_mcp_server, format!, json!, skip_if_no_network!, vec!).


### MCP, apps, and plugins
These suites cover deferred tool discovery and invocation across MCP, apps, plugins, and extension-provided tools, including file-upload and install flows.

### `core/tests/suite/extension_sandbox.rs`

`test` · `test run`

This test file protects an important safety boundary: extensions must not quietly read files that the current turn is not allowed to read. The image generation extension can take local image paths as inputs, so it needs to obey the same sandbox rules as the rest of Codex. A sandbox is like a fenced work area: tools may only touch what the fence allows.

The file builds a test Codex session with the image generation extension installed and uses a mock server instead of the real OpenAI service. The mock server sends scripted events that make the model call tools, such as the image generation tool or the permission-request tool.

The first test creates a local image path and then explicitly denies access to it. When the extension tries to use that path, the test confirms that the extension returns a readable error instead of reading the file.

The second test starts with a restricted permission profile, then simulates the model asking the user for extra file access. The test grants that access only for the current turn. After that, the image extension is expected to read the image and send it along as a base64 data URL. Together, these tests make sure temporary permissions are actually passed to extensions, while denied files stay protected.

#### Function details

##### `image_generation_extensions`  (lines 49–54)

```
fn image_generation_extensions(auth: &CodexAuth) -> Arc<ExtensionRegistry<Config>>
```

**Purpose**: This helper builds an extension registry that contains the image generation extension, using the supplied test authentication. The tests use it so they can run Codex with the same extension wiring that real image-editing flows need.

**Data flow**: It receives a Codex authentication object. It turns that into an authentication manager, creates a fresh extension registry builder, installs the image generation extension into that builder, and returns the finished registry wrapped in shared ownership so the test session can use it.

**Call relations**: Both tests call this helper during setup. It hides the repeated extension setup work, then hands the ready-to-use registry to the test Codex builder before any mock model events are played.

*Call graph*: calls 1 internal fn (auth_manager_from_auth); called by 2 (extension_tool_receives_turn_environment_sandbox, extension_tool_uses_granted_turn_permissions); 4 external calls (new, new, install, clone).


##### `extension_tool_receives_turn_environment_sandbox`  (lines 57–139)

```
async fn extension_tool_receives_turn_environment_sandbox() -> Result<()>
```

**Purpose**: This test proves that the image generation extension cannot read a file when the current turn's sandbox says that file is denied. It checks that the extension reports a clear error instead of bypassing the restriction.

**Data flow**: The test starts a mock server, creates a test Codex session with image generation enabled, writes a local file named like an image, and builds a permission profile that denies access to that exact path. It then submits a user turn where the mock model asks the image tool to edit that denied image. The result is inspected in the outgoing tool-response request, and the test passes only if the output starts with an error saying the image could not be read.

**Call relations**: During setup it calls the shared extension builder helper and uses the test Codex builder plus mock response helpers. The mock server drives the model side of the conversation by issuing an image-generation tool call. The test then reads the final request sent back to the mock server to confirm the extension obeyed the sandbox.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, image_generation_extensions, create_dummy_chatgpt_auth_for_testing, from_runtime_permissions, default); 4 external calls (assert!, skip_if_no_network!, write, vec!).


##### `extension_tool_uses_granted_turn_permissions`  (lines 142–305)

```
async fn extension_tool_uses_granted_turn_permissions() -> Result<()>
```

**Purpose**: This test proves the opposite side of the permission story: if the user grants extra file access for the current turn, the image generation extension receives and uses that access. It confirms that a previously outside-the-workspace image can be read after the grant.

**Data flow**: The test starts a mock server, registers a fake successful image-edit endpoint, creates a restricted Codex session, and writes a tiny PNG file in a temporary directory. The mock model first asks for permission to read that directory, and the test replies with a turn-scoped grant. The mock model then calls the image generation tool with the image path. At the end, the test inspects the extension output and expects to see an input image encoded as a PNG data URL.

**Call relations**: This test uses the same extension setup helper, plus test utilities that build the sandbox and permission fields for the submitted turn. The flow is deliberately staged: the mock model asks for permission, the test sends a permission response back into Codex, and only then does the image tool call succeed. The final mock-server request shows whether the granted permission reached the extension.

*Call graph*: calls 9 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, image_generation_extensions, create_dummy_chatgpt_auth_for_testing, from_read_write_roots, workspace_write_with); 16 external calls (default, given, new, new, default, assert_eq!, wait_for_event, json!, panic!, skip_if_no_network! (+6 more)).


### `core/tests/suite/openai_file_mcp.rs`

`test` · `test run`

This is a test file for the part of Codex that connects local files to external app tools. The real-world problem is simple: if a model asks an app tool to read `report.txt`, that app cannot directly see the user's local disk. Codex must upload the file to the remote service first, then call the app tool with a safe file reference that includes things like a file id, download URL, name, type, and size.

The tests build a fake world around Codex. A mock HTTP server pretends to be the OpenAI file-upload service and the app tool backend. The test creates a `report.txt` file, sets up expected upload requests, then simulates a model response that calls a document-extraction tool. After Codex runs the turn, the test inspects what was sent: first, that the tool schema told the model to provide an absolute local file path; second, that the actual app tool call received an uploaded-file payload.

A second test adds a post-tool-use hook, which is a small command Codex runs after a tool call. That hook records the input it received. The test confirms the hook also sees the uploaded-file payload. Without this behavior, app tools and hooks might receive unusable local paths instead of files they can actually access.

#### Function details

##### `write_post_tool_use_hook`  (lines 42–80)

```
fn write_post_tool_use_hook(home: &Path) -> Result<()>
```

**Purpose**: Creates a small Python hook script and a `hooks.json` configuration file inside a test home directory. The hook records what Codex sends to it after an app tool runs, so the test can later check that file arguments were converted correctly.

**Data flow**: It receives the path to a temporary Codex home directory. It builds paths for a Python script and a JSON-lines log file, writes a script that reads JSON from standard input and appends it to the log, then writes a hook configuration that tells Codex when to run that script. On success it returns nothing; on failure it returns an error with context about which file write failed.

**Call relations**: This helper is used during setup for the hook-focused test. That test installs the hook before building Codex, then later uses `read_post_tool_use_hook_inputs` to read back the log produced by this script.

*Call graph*: 4 external calls (join, format!, write, json!).


##### `read_post_tool_use_hook_inputs`  (lines 82–89)

```
fn read_post_tool_use_hook_inputs(home: &Path) -> Result<Vec<Value>>
```

**Purpose**: Reads the log written by the post-tool-use hook and turns each recorded line back into JSON. The test uses this to inspect exactly what Codex gave the hook.

**Data flow**: It receives the temporary Codex home directory, opens the hook log file there, skips blank lines, and parses each remaining line as JSON. It returns a list of JSON values, or an error if the file cannot be read or any line is not valid JSON.

**Call relations**: The hook-focused test calls this after `run_extract_turn` has caused Codex to invoke the app tool and then the hook. It is the verification half of the setup created by `write_post_tool_use_hook`.

*Call graph*: called by 1 (codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook); 2 external calls (join, read_to_string).


##### `uploaded_file`  (lines 91–100)

```
fn uploaded_file(server: &MockServer, file_size_bytes: u64) -> Value
```

**Purpose**: Builds the JSON shape that represents a file after Codex has uploaded it. Tests use this as the expected value when checking app tool calls and hook inputs.

**Data flow**: It receives the mock server and a file size. It uses the server's base URL to form a download URL, combines that with fixed test values like `file_123` and `report.txt`, and returns a JSON object describing the uploaded file.

**Call relations**: Both main tests compare real Codex output against this expected uploaded-file object. It keeps the expected file payload consistent between the app tool assertion and the hook assertion.

*Call graph*: 1 external calls (json!).


##### `mount_file_upload_mocks`  (lines 102–137)

```
async fn mount_file_upload_mocks(server: &MockServer, file_size_bytes: u64)
```

**Purpose**: Teaches the mock server how to behave like the remote file-upload API for one test file. It sets expectations for creating an upload, uploading the bytes, and marking the upload complete.

**Data flow**: It receives the mock server and the file size. It registers three expected HTTP interactions: a `POST /files` request that returns an upload URL, a `PUT` to that upload URL with the correct content length, and a final `POST` saying the file was uploaded. It changes the mock server's behavior; it does not return a value.

**Call relations**: Both tests call this before asking Codex to run the extraction turn. Later, each test calls `server.verify()` to make sure Codex really performed the upload sequence that this function registered.

*Call graph*: called by 2 (codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook, codex_apps_file_params_upload_environment_files_before_mcp_tool_call); 7 external calls (given, new, json!, body_json, header, method, path).


##### `run_extract_turn`  (lines 139–170)

```
async fn run_extract_turn(test: &TestCodex, server: &MockServer) -> Result<ResponseMock>
```

**Purpose**: Runs the shared test scenario where the model asks Codex to call the document-extraction app tool for `report.txt`. It sets up fake streamed model responses, submits a user request, and returns the recorded response mock for inspection.

**Data flow**: It receives a test Codex instance and the mock server. It mounts a two-part server-sent event stream: first a model response that requests the app tool call, then a follow-up assistant message saying `done`. It submits the user's prompt with approval disabled and no special permission profile. It returns the mock object that recorded the outgoing model requests.

**Call relations**: Both tests use this as the common action phase. Before it runs, the tests set up app servers, files, and upload mocks. After it runs, one test inspects the model request and app tool call, while the other reads the hook log.

*Call graph*: calls 2 internal fn (mount_sse_sequence, submit_turn_with_approval_and_permission_profile); called by 2 (codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook, codex_apps_file_params_upload_environment_files_before_mcp_tool_call); 1 external calls (vec!).


##### `codex_apps_file_params_upload_environment_files_before_mcp_tool_call`  (lines 173–227)

```
async fn codex_apps_file_params_upload_environment_files_before_mcp_tool_call() -> Result<()>
```

**Purpose**: Checks the main file-upload behavior: when an app tool needs a local file, Codex uploads the file before calling the MCP tool and passes the tool an uploaded-file object. MCP means Model Context Protocol, a standard way for tools to be exposed to the model.

**Data flow**: The test starts a mock server, mounts a fake app server, and prepares mocks for uploading a large `report.txt`. It builds a Codex test environment with that file present in the remote workspace, runs the extraction turn, then inspects the recorded requests. It verifies that the model saw a tool parameter described as an absolute local file path, and that the app backend received the uploaded-file JSON plus Codex metadata about the tool call.

**Call relations**: This is one of the two top-level async tests in the file. It relies on `mount_file_upload_mocks` for the fake upload service, `run_extract_turn` to trigger the model/tool flow, and `uploaded_file` to define the expected app-tool argument.

*Call graph*: calls 6 internal fn (mount, apps_enabled_builder, recorded_apps_tool_call_by_name, start_mock_server, mount_file_upload_mocks, run_extract_turn); 2 external calls (assert_eq!, format!).


##### `codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook`  (lines 230–257)

```
async fn codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook() -> Result<()>
```

**Purpose**: Checks that post-tool-use hooks receive the converted uploaded-file object, not the original local filename. This matters because hooks often audit or react to tool calls, and they need to see the same usable file information as the app tool.

**Data flow**: The test starts the mock server and app server, prepares upload mocks for an 11-byte file, writes and trusts a test hook, builds Codex, and creates `report.txt` containing `hello world`. It runs the extraction turn, reads the hook's JSON log, and asserts that exactly one hook input was recorded and that its `tool_input.file` field matches the expected uploaded-file JSON.

**Call relations**: This is the second top-level async test. It uses `write_post_tool_use_hook` during setup, `mount_file_upload_mocks` and `run_extract_turn` during execution, and `read_post_tool_use_hook_inputs` plus `uploaded_file` during verification.

*Call graph*: calls 6 internal fn (mount, apps_enabled_builder, start_mock_server, mount_file_upload_mocks, read_post_tool_use_hook_inputs, run_extract_turn); 2 external calls (assert_eq!, write).


### `core/tests/suite/plugins.rs`

`test` · `test run`

Plugins can add several kinds of abilities to Codex: written “skills,” MCP servers (small helper programs that expose tools through the Model Context Protocol), and Apps connectors such as Google Calendar. This test file makes sure those abilities show up in the right place, in the right order, and only when they should. Without these tests, Codex could accidentally hide a plugin tool, show the wrong tool for a user’s login type, or send confusing instructions to the model.

The file starts with small helpers that build a fake installed plugin on disk. Think of this like setting up a pretend shop display: the tests create the plugin’s manifest, optional skill file, optional MCP configuration, and optional app configuration inside a temporary Codex home directory. Other helpers build a test Codex session with either ChatGPT-style authentication or API-key authentication, because the product behaves differently for those cases.

Each test then starts a mock HTTP server, gives Codex a fake model response stream, submits user input, waits for the turn to finish, and inspects the outgoing request. The checks focus on human-facing developer instructions, available tools, provenance text saying a tool came from a plugin, conflict rules between Apps and MCP surfaces, and the analytics event emitted when a plugin is used.

#### Function details

##### `sample_plugin_root`  (lines 33–35)

```
fn sample_plugin_root(home: &TempDir) -> std::path::PathBuf
```

**Purpose**: This helper returns the folder path where the fake sample plugin should live inside a temporary Codex home directory. Tests use it so every plugin fixture is laid out in the same expected cache location.

**Data flow**: It receives a temporary home directory. It reads the home directory path, appends the fixed plugin cache path for the sample plugin, and returns that full path. It does not create or change anything on disk.

**Call relations**: The plugin setup helper calls this first to find where it should write the fake plugin files. Its returned path becomes the base folder for the manifest, skills, MCP config, and app config used by the tests.

*Call graph*: called by 1 (write_sample_plugin_manifest_and_config); 1 external calls (path).


##### `write_sample_plugin_manifest_and_config`  (lines 37–55)

```
fn write_sample_plugin_manifest_and_config(home: &TempDir) -> std::path::PathBuf
```

**Purpose**: This helper creates the minimum fake plugin installation needed for the tests: a plugin manifest and a Codex config file that enables the plugin feature and turns on the sample plugin.

**Data flow**: It receives a temporary home directory, computes the plugin root, creates the plugin metadata folder, writes a small plugin.json file with the sample name and description, and writes config.toml in the home directory. It returns the plugin root path so more plugin files can be added.

**Call relations**: The more specific fixture helpers call this before adding skills, MCP settings, or app settings. It provides the shared foundation that makes Codex believe the sample plugin is installed and enabled.

*Call graph*: calls 1 internal fn (sample_plugin_root); called by 3 (write_plugin_app_plugin_with_name, write_plugin_mcp_plugin, write_plugin_skill_plugin); 4 external calls (path, format!, create_dir_all, write).


##### `write_plugin_skill_plugin`  (lines 57–67)

```
fn write_plugin_skill_plugin(home: &TempDir) -> std::path::PathBuf
```

**Purpose**: This helper adds a sample skill to the fake plugin. A skill is a Markdown file that describes a reusable capability the model can be told about.

**Data flow**: It receives a temporary home directory, creates the base sample plugin setup, creates a skills/sample-search folder, and writes a SKILL.md file with a short description. It returns the path to that skill file.

**Call relations**: Several tests call this when they need Codex to discover a plugin skill. The resulting skill is later expected to appear in developer-message guidance or in plugin analytics as evidence that the plugin has skills.

*Call graph*: calls 1 internal fn (write_sample_plugin_manifest_and_config); called by 5 (capability_sections_render_in_developer_message_in_order, explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, explicit_plugin_mentions_track_plugin_used_analytics, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins, explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins); 2 external calls (create_dir_all, write).


##### `write_plugin_mcp_plugin`  (lines 69–86)

```
fn write_plugin_mcp_plugin(home: &TempDir, command: &str)
```

**Purpose**: This helper adds an MCP server declaration to the fake plugin. MCP, the Model Context Protocol, is the way a helper process can offer tools that the model may call.

**Data flow**: It receives a temporary home directory and the command that should start the test MCP server. It creates the base plugin setup, then writes a .mcp.json file that names the sample MCP server, sets its command, working folder, and startup timeout. It changes files on disk and returns nothing.

**Call relations**: Tests call this when they need the plugin to expose tool-like behavior through MCP. Later, those tests wait for the MCP server or inspect whether its tools were included or suppressed in the model request.

*Call graph*: calls 1 internal fn (write_sample_plugin_manifest_and_config); called by 3 (explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins, explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins); 2 external calls (format!, write).


##### `write_plugin_app_plugin`  (lines 88–90)

```
fn write_plugin_app_plugin(home: &TempDir)
```

**Purpose**: This helper adds the default sample app declaration to the fake plugin. It is a convenience wrapper for tests that want an app named "sample."

**Data flow**: It receives a temporary home directory and passes it along with the fixed app name "sample" to the more flexible app-writing helper. It does not do its own file writing.

**Call relations**: Tests call this when they need a plugin app whose name matches the sample plugin. That matching name is important in tests that check conflict behavior between an app surface and an MCP surface.

*Call graph*: calls 1 internal fn (write_plugin_app_plugin_with_name); called by 3 (capability_sections_render_in_developer_message_in_order, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins, explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins).


##### `write_plugin_app_plugin_with_name`  (lines 92–107)

```
fn write_plugin_app_plugin_with_name(home: &TempDir, app_name: &str)
```

**Purpose**: This helper adds an app declaration to the fake plugin, using whatever app name the test asks for. The app points at a calendar connector so Codex can expose app tools in requests.

**Data flow**: It receives a temporary home directory and an app name, creates the base sample plugin setup, and writes a .app.json file containing that app name and a calendar connector id. It changes files on disk and returns nothing.

**Call relations**: The default app helper calls this with "sample," while one test calls it with a different name to avoid a conflict. The app declaration it writes is later used by Codex to decide whether app tools should appear for a turn.

*Call graph*: calls 1 internal fn (write_sample_plugin_manifest_and_config); called by 2 (explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, write_plugin_app_plugin); 2 external calls (format!, write).


##### `build_analytics_plugin_test_codex`  (lines 109–125)

```
async fn build_analytics_plugin_test_codex(
    server: &MockServer,
    codex_home: Arc<TempDir>,
) -> Result<TestCodex>
```

**Purpose**: This helper builds a test Codex session configured for analytics checks. It uses dummy ChatGPT authentication and points Codex’s ChatGPT base URL at the mock server so the test can observe outgoing requests.

**Data flow**: It receives a mock server and a temporary Codex home directory. It creates a test Codex builder, attaches the home directory and dummy auth, selects model gpt-5.2, overrides the ChatGPT base URL, then builds and returns the ready test Codex session.

**Call relations**: The analytics test calls this after writing the fake plugin. The returned Codex instance is used to submit a plugin mention and then watch the mock server for the plugin-used analytics event.

*Call graph*: calls 2 internal fn (test_codex, create_dummy_chatgpt_auth_for_testing); called by 1 (explicit_plugin_mentions_track_plugin_used_analytics); 1 external calls (uri).


##### `build_apps_enabled_plugin_test_codex`  (lines 127–146)

```
async fn build_apps_enabled_plugin_test_codex(
    server: &MockServer,
    codex_home: Arc<TempDir>,
    chatgpt_base_url: String,
) -> Result<TestCodex>
```

**Purpose**: This helper builds a test Codex session with the Apps feature turned on. It is used by tests that need plugin app tools, such as calendar tools, to be available.

**Data flow**: It receives a mock server, a temporary Codex home directory, and a ChatGPT base URL. It creates a test Codex builder with dummy ChatGPT authentication, enables the Apps feature in the config, sets the base URL, builds the session, and returns it.

**Call relations**: The app-focused tests call this after creating fake plugin files and a fake Apps server. The Codex instance it returns is then driven with user input so the tests can inspect the developer instructions and tool list sent to the model.

*Call graph*: calls 2 internal fn (test_codex, create_dummy_chatgpt_auth_for_testing); called by 3 (capability_sections_render_in_developer_message_in_order, explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins).


##### `tool_names`  (lines 148–163)

```
fn tool_names(body: &serde_json::Value) -> Vec<String>
```

**Purpose**: This helper extracts tool names from a JSON request body in a simple list. Tests use it to check whether app or MCP tools were sent to the model.

**Data flow**: It receives a JSON value, looks for a top-level tools array, and for each tool tries to read either its name field or its type field. It returns a list of strings, or an empty list if the request has no tools in that shape.

**Call relations**: The tests call this after capturing the model request from the mock server. Its output makes assertions easier, such as checking whether the calendar app tool is visible or hidden.

*Call graph*: called by 3 (explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins, explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins); 1 external calls (get).


##### `capability_sections_render_in_developer_message_in_order`  (lines 166–233)

```
async fn capability_sections_render_in_developer_message_in_order() -> Result<()>
```

**Purpose**: This test checks that Codex writes capability guidance to the model in a predictable order: Apps first, then Skills, then Plugins. It also checks that plugin skills are shown with a plugin-name prefix instead of exposing the plugin description as a standalone plugin entry.

**Data flow**: It starts mock model and app servers, creates a fake plugin with one skill and one app, builds an Apps-enabled Codex session, submits a simple text message, waits for the turn to finish, and reads the developer messages from the captured model request. It then asserts the order and contents of those messages.

**Call relations**: This is one of the main end-to-end plugin presentation tests. It uses the fixture writers and Apps-enabled Codex builder, then relies on the mock response stream and event waiting helpers to reach the point where Codex has sent a request that can be inspected.

*Call graph*: calls 7 internal fn (mount_with_connector_name, mount_sse_once, sse, start_mock_server, build_apps_enabled_plugin_test_codex, write_plugin_app_plugin, write_plugin_skill_plugin); 8 external calls (clone, new, default, new, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins`  (lines 236–323)

```
async fn explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins() -> Result<()>
```

**Purpose**: This test checks what happens when a ChatGPT-authenticated user explicitly mentions a plugin that offers both an app and an MCP server with the same plugin-facing name. In that conflict case, Codex should prefer the Apps surface and hide the plugin’s MCP tools.

**Data flow**: It starts mock servers, creates a fake plugin with a skill, MCP server, and app, builds an Apps-enabled ChatGPT-style Codex session, waits for the Apps MCP server, submits a user mention of the plugin, and inspects the model request. The expected result is skill guidance and app guidance, calendar app tools with plugin provenance text, and no sample MCP tool.

**Call relations**: This test pulls together all plugin fixture types. It uses the app-enabled builder and the tool-name helper to verify the bigger rule: for ChatGPT auth, a dual-surface plugin should expose app tools when the app conflicts with the MCP plugin identity.

*Call graph*: calls 9 internal fn (mount_with_connector_name, mount_sse_once, sse, start_mock_server, build_apps_enabled_plugin_test_codex, tool_names, write_plugin_app_plugin, write_plugin_mcp_plugin, write_plugin_skill_plugin); 11 external calls (clone, new, default, new, assert!, stdio_server_bin, wait_for_event, wait_for_mcp_server, eprintln!, skip_if_no_network! (+1 more)).


##### `explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth`  (lines 326–403)

```
async fn explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth() -> Result<()>
```

**Purpose**: This test checks that ChatGPT authentication does not hide a plugin MCP server when the plugin’s app declaration has a different name and therefore does not conflict. In that case, Codex should show both the app tools and the MCP tools.

**Data flow**: It creates a fake plugin with a skill, an MCP server, and an app named differently from the plugin, builds an Apps-enabled ChatGPT-style Codex session, waits for the sample MCP server, submits a plugin mention, and inspects the outgoing model request. It expects both MCP guidance and app guidance, calendar app tools, and the sample MCP echo tool with plugin provenance text.

**Call relations**: This test is the companion to the conflict test. It uses the custom app-name fixture to prove that the suppression rule is not too broad: MCP tools remain available when there is no app/MCP naming conflict.

*Call graph*: calls 9 internal fn (mount_with_connector_name, mount_sse_once, sse, start_mock_server, build_apps_enabled_plugin_test_codex, tool_names, write_plugin_app_plugin_with_name, write_plugin_mcp_plugin, write_plugin_skill_plugin); 11 external calls (clone, new, default, new, assert!, stdio_server_bin, wait_for_event, wait_for_mcp_server, eprintln!, skip_if_no_network! (+1 more)).


##### `explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins`  (lines 406–498)

```
async fn explicit_plugin_mentions_use_mcp_for_api_key_dual_surface_plugins() -> Result<()>
```

**Purpose**: This test checks that API-key authentication chooses the MCP surface, not the Apps surface, for a plugin that declares both. This matters because app connector behavior is tied to ChatGPT-style authentication, while API-key users should still be able to use MCP tools.

**Data flow**: It starts a mock model server, creates a fake plugin with a skill, MCP server, and app, builds Codex with an API key and the Apps feature enabled, waits for the sample MCP server, submits a plugin mention, and inspects the model request. It expects skill and MCP guidance, no app guidance, no calendar app tool, and a visible sample MCP echo tool with plugin provenance text.

**Call relations**: This test builds its Codex session directly rather than using the ChatGPT helper, because it needs API-key authentication. It uses the same plugin fixture helpers and tool extraction helper to verify that authentication type changes which plugin surface is exposed.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_names, write_plugin_app_plugin, write_plugin_mcp_plugin, write_plugin_skill_plugin, from_api_key); 11 external calls (clone, new, default, new, assert!, stdio_server_bin, wait_for_event, wait_for_mcp_server, eprintln!, skip_if_no_network! (+1 more)).


##### `explicit_plugin_mentions_track_plugin_used_analytics`  (lines 501–576)

```
async fn explicit_plugin_mentions_track_plugin_used_analytics() -> Result<()>
```

**Purpose**: This test checks that explicitly mentioning a plugin sends a plugin-used analytics event with the right details. Analytics here means a background report that records which plugin was used and useful context such as model, thread, and plugin capabilities.

**Data flow**: It starts a mock server, mounts a fake model response, creates a fake plugin with a skill, builds a ChatGPT-style Codex session for analytics, submits a plugin mention, waits for the turn to finish, then repeatedly checks received mock-server requests until it finds a codex_plugin_used event. It asserts that the event contains the sample plugin id, name, marketplace, skill and MCP counts, connector ids, client id, model slug, thread id, and turn id.

**Call relations**: This test uses the analytics-specific Codex builder so outgoing analytics calls go to the mock server. Unlike the tool-visibility tests, its final inspection is not the model request but the separate analytics endpoint request emitted after plugin use.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, build_analytics_plugin_test_codex, write_plugin_skill_plugin); 14 external calls (clone, new, default, from_millis, from_secs, now, new, assert!, assert_eq!, wait_for_event (+4 more)).


### `core/tests/suite/request_plugin_install.rs`

`test` · `test run`

This is a focused integration test for Codex's tool-selection behavior. In everyday terms, it checks that if the assistant cannot use its usual “search for tools” helper, it still brings the right backup tools to the conversation: one tool to list installable plugins, and another tool to request installing one.

The test builds a fake Codex session against a mock server instead of talking to the real service. It turns on the Apps, Plugins, and Tool Suggest features, then edits the test model setup so the selected model does not support the `tool_search` tool. That simulates a real situation where tool search is not available.

After sending a simple user turn, the test looks at the JSON request Codex sent to the mocked model API. It reads the advertised tools from that request and checks three important things: `tool_search` is absent, `list_available_plugins_to_install` is present, and `request_plugin_install` is present. It also checks the wording of the tool descriptions. Those descriptions matter because they are instructions the model reads before deciding when to call a tool. The test makes sure the instructions say to use the install-listing path when search is unavailable, and that they do not leak internal connector IDs or mention outdated behavior.

#### Function details

##### `tool_names`  (lines 29–44)

```
fn tool_names(body: &Value) -> Vec<String>
```

**Purpose**: This helper pulls the names of tools out of a JSON request body. The test uses it to ask, in a simple way, “which tools did Codex offer to the model?”

**Data flow**: It receives a JSON value that should contain a `tools` array. It looks through each tool entry, tries to read either its `name` field or its `type` field, and collects those strings. It returns a list of tool names; if the expected JSON shape is missing, it returns an empty list instead of failing.

**Call relations**: The main test calls this after the mock server captures Codex's request. `tool_names` turns the raw JSON into a plain list, so the test can make clear assertions about whether `tool_search`, `list_available_plugins_to_install`, and `request_plugin_install` were included.

*Call graph*: called by 1 (request_plugin_install_is_available_without_search_tool_after_discovery_attempts); 1 external calls (get).


##### `function_tool_description`  (lines 46–60)

```
fn function_tool_description(body: &Value, name: &str) -> Option<String>
```

**Purpose**: This helper finds the human-readable description for one named tool inside a JSON request body. The test uses it to verify that the model-facing instructions for plugin installation say the right things.

**Data flow**: It receives a JSON request body and the name of the tool to look for. It searches the `tools` array for an entry whose `name` matches, then reads that tool's `description` text. It returns the description if found, or nothing if the tool or description is missing.

**Call relations**: The main test calls this after confirming the important tools are present. It narrows the captured request down to the exact instruction text for each tool, allowing the test to check wording that guides when the model should call those tools.

*Call graph*: called by 1 (request_plugin_install_is_available_without_search_tool_after_discovery_attempts); 1 external calls (get).


##### `configure_apps_without_search_tool`  (lines 62–89)

```
fn configure_apps_without_search_tool(config: &mut Config, apps_base_url: &str)
```

**Purpose**: This helper prepares a Codex test configuration where app and plugin features are enabled, but the chosen model is marked as not supporting the normal tool-search feature. It creates the special conditions the test needs.

**Data flow**: It receives a mutable configuration object and the base URL for the fake apps service. It turns on the Apps, Plugins, and Tool Suggest features, loads the bundled model catalog, finds the `gpt-5.4` model entry, points ChatGPT traffic at the test apps server, sets the model name, adds a discoverable Gmail connector, and changes the model record so `supports_search_tool` is false. The changed configuration is left in place for the test Codex session to use.

**Call relations**: The main test passes this helper into the test Codex builder as a configuration callback. During setup, the builder calls it so the session starts in the exact scenario under test: plugins and tool suggestions are active, but `tool_search` should not be available.

*Call graph*: 2 external calls (bundled_models_response, vec!).


##### `request_plugin_install_is_available_without_search_tool_after_discovery_attempts`  (lines 92–164)

```
async fn request_plugin_install_is_available_without_search_tool_after_discovery_attempts() -> Result<()>
```

**Purpose**: This is the main test. It verifies that when `tool_search` is unavailable, Codex still sends plugin-install support tools to the model and gives them the correct instructions.

**Data flow**: The test first skips itself if network access is not available. It starts a mock server, mounts a fake apps service, and prepares a one-time fake streaming response from the model. It then builds a Codex test session with dummy authentication and the special configuration that disables search-tool support. After submitting the user message `list tools`, it reads the single JSON request captured by the mock server. From that request, it extracts tool names and tool descriptions, then asserts that the search tool is absent, the plugin listing and install-request tools are present, and their descriptions contain or omit specific text as expected. If all checks pass, it returns success.

**Call relations**: This test drives the whole file. It calls the setup helpers from the test support libraries to create fake servers and a fake Codex session, calls `configure_apps_without_search_tool` through the builder setup path, then uses `tool_names` and `function_tool_description` to inspect the captured request. Its role is to connect all those pieces into one end-to-end check of the plugin-install fallback behavior.

*Call graph*: calls 8 internal fn (mount, mount_sse_once, sse, start_mock_server, test_codex, function_tool_description, tool_names, create_dummy_chatgpt_auth_for_testing); 3 external calls (assert!, skip_if_no_network!, vec!).


### `core/tests/suite/search_tool.rs`

`test` · `test run`

This is a non-Windows test file for a tool discovery system. In this project, tools are extra actions the model can call, such as calendar actions or MCP tools. MCP means “Model Context Protocol,” a standard way for outside tool servers to expose actions to the model. The problem this file protects against is tool overload and unsafe exposure: if every possible tool is shown to the model immediately, prompts get large, irrelevant tools appear too early, and special app-only tools may be called when they should not be.

The tests set up fake model responses and fake app or MCP servers. They then submit user turns and inspect the outgoing request bodies sent to the mocked Responses API. The key idea is like a library catalog: the model first sees a search desk called “tool_search,” then asks for matching tools, and only the search results become available through conversation history. The tests make sure tools are not secretly injected into later requests after search.

The file also checks edge cases: API-key users should not see app search sources, feature flags can force all MCP tools behind search, app-only tools cannot be run by direct model calls, dynamic tools can be searched and routed back to the host, MCP errors are returned visibly to the model, and search matching works across tool names, descriptions, namespaces, and schemas.

#### Function details

##### `tool_names`  (lines 66–81)

```
fn tool_names(body: &Value) -> Vec<String>
```

**Purpose**: Pulls the visible tool names out of a JSON request body. Tests use it to quickly ask, “What tools did we tell the model about?”

**Data flow**: It receives a JSON value that should contain a tools array. It reads each tool’s name field, or its type field when there is no name, and returns a list of strings. If the expected array is missing, it returns an empty list instead of failing.

**Call relations**: Many tests call this after a mocked model request is captured. It turns the raw JSON request into a simple list so the test can check whether tool_search is present and whether deferred tools stayed hidden.

*Call graph*: called by 9 (always_defer_feature_hides_small_app_tool_sets, app_search_sources_are_hidden_for_api_key_auth, explicit_app_mentions_respect_always_defer, search_tool_hides_apps_tools_without_search, tool_search_indexes_only_enabled_non_app_mcp_tools, tool_search_returns_deferred_dynamic_tool_and_routes_follow_up_call, tool_search_returns_deferred_tools_without_follow_up_tool_injection, tool_search_returns_deferred_v1_multi_agent_tools, tool_search_surfaced_mcp_tool_errors_are_returned_to_model); 1 external calls (get).


##### `tool_search_description`  (lines 83–97)

```
fn tool_search_description(body: &Value) -> Option<String>
```

**Purpose**: Finds the description text for the tool_search tool inside a request body. Tests use it to confirm that the model receives the right discovery instructions.

**Data flow**: It receives a JSON request body, looks through its tools array for the item whose type is tool_search, and returns that item’s description as text. If no such tool or description exists, it returns nothing.

**Call relations**: Tests that care about wording call this after submitting a turn. It bridges the large request JSON and assertions about whether app sources or discovery instructions were included.

*Call graph*: called by 2 (app_search_sources_are_hidden_for_api_key_auth, search_tool_adds_discovery_instructions_to_tool_description); 1 external calls (get).


##### `tool_search_output_item`  (lines 99–101)

```
fn tool_search_output_item(request: &ResponsesRequest, call_id: &str) -> Value
```

**Purpose**: Fetches the recorded output item for one tool_search call from a mocked Responses API request. It is a small shortcut used by tests that inspect search results.

**Data flow**: It receives a captured ResponsesRequest and a call ID. It asks the request for the tool_search output matching that call ID and returns the JSON item that was sent back to the model.

**Call relations**: The more specific helper tool_search_output_tools builds on this. Some tests also call it directly when they need to check fields on the whole search output, not just the returned tools.

*Call graph*: calls 1 internal fn (tool_search_output); called by 3 (tool_search_output_tools, tool_search_returns_deferred_tools_without_follow_up_tool_injection, tool_search_returns_deferred_v1_multi_agent_tools).


##### `tool_search_output_tools`  (lines 103–109)

```
fn tool_search_output_tools(request: &ResponsesRequest, call_id: &str) -> Vec<Value>
```

**Purpose**: Extracts just the returned tools from a tool_search output item. This keeps test assertions focused on the search results rather than the surrounding response wrapper.

**Data flow**: It receives a captured request and a tool_search call ID. It gets the matching output item, reads its tools array, clones that array, and returns it. If the tools array is missing, it returns an empty list.

**Call relations**: Tests call this after the model has requested tool_search. It supplies the list that assertions compare against expected app, MCP, dynamic, or multi-agent search results.

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

**Purpose**: Checks whether a tool_search result contains a named tool inside a named namespace. A namespace is a grouping label, like a folder containing related tools.

**Data flow**: It receives a captured request, a tool_search call ID, a namespace name, and a child tool name. It extracts the search-result tools, wraps them in a small JSON object, asks the shared namespace lookup helper to find the child, and returns true or false.

**Call relations**: Search matching tests use this helper when they do not need the whole result shape. It delegates the actual namespace lookup to namespace_child_tool so each test can read like a plain yes-or-no expectation.

*Call graph*: calls 1 internal fn (namespace_child_tool); 1 external calls (json!).


##### `search_tool_enabled_by_default_adds_tool_search`  (lines 124–179)

```
async fn search_tool_enabled_by_default_adds_tool_search() -> Result<()>
```

**Purpose**: Verifies that a search-capable setup advertises tool_search by default. Without this, the model would have no catalog-like entry point for discovering deferred tools.

**Data flow**: The test starts a mock model server and a searchable apps server, submits a simple user turn, and captures the outgoing request. It reads the tools array and checks that tool_search is present with client execution and the expected parameter schema.

**Call relations**: This is one of the baseline tests. It uses the mock SSE response helpers to make the model finish normally, then inspects the single request sent during that turn.

*Call graph*: calls 5 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_once, sse, start_mock_server); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `always_defer_feature_hides_small_app_tool_sets`  (lines 182–225)

```
async fn always_defer_feature_hides_small_app_tool_sets() -> Result<()>
```

**Purpose**: Checks that the always-defer feature flag hides app MCP tools even when the app tool set is small. This protects the rule that search should be the only entry point when that feature is enabled.

**Data flow**: The test enables ToolSearchAlwaysDeferMcpTools, submits a turn, and reads the names of tools sent to the model. It expects tool_search to be visible and every direct MCP tool name to be absent.

**Call relations**: It relies on configured app test setup and uses tool_names to simplify the captured request. The mocked model only completes the response; the important check is the first request’s advertised tools.

*Call graph*: calls 6 internal fn (mount, search_capable_apps_builder, mount_sse_once, sse, start_mock_server, tool_names); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `app_only_tools_are_not_visible_or_runnable_by_direct_model_calls`  (lines 228–299)

```
async fn app_only_tools_are_not_visible_or_runnable_by_direct_model_calls() -> Result<()>
```

**Purpose**: Ensures app-only tools are not shown to, or executable by, a direct model call. These tools are meant for app-controlled flows, so exposing them directly would bypass that boundary.

**Data flow**: The test mounts an app server with an app-only tool, then makes the mocked model attempt to call that hidden tool anyway. It confirms a normal visible calendar tool is declared, the app-only tool is not declared, the forced call returns an unsupported-call message, and no real app tool call reaches the MCP server.

**Call relations**: It uses a two-step mocked model sequence: first a forbidden function call, then a normal completion. The test connects request inspection with recorded server calls to prove the blocked call did not escape.

*Call graph*: calls 4 internal fn (mount_with_app_only_tool, apps_enabled_builder, mount_sse_sequence, start_mock_server); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `app_search_sources_are_hidden_for_api_key_auth`  (lines 302–344)

```
async fn app_search_sources_are_hidden_for_api_key_auth() -> Result<()>
```

**Purpose**: Checks that app search sources are hidden when authentication uses an API key. This matters because app connectors are only meant to appear for supported logged-in auth flows.

**Data flow**: The test builds a Codex session authenticated with a test API key, configures app search support, submits a turn, and captures the outgoing request. It checks that app tool names are absent and that the tool_search description does not mention Calendar.

**Call relations**: It uses tool_names for the advertised tools and tool_search_description for the catalog text. The mocked server response is only there to let the turn finish.

*Call graph*: calls 8 internal fn (mount, mount_sse_once, sse, start_mock_server, test_codex, tool_names, tool_search_description, from_api_key); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `search_tool_adds_discovery_instructions_to_tool_description`  (lines 347–386)

```
async fn search_tool_adds_discovery_instructions_to_tool_description() -> Result<()>
```

**Purpose**: Confirms that tool_search tells the model how discovery works and what sources are available. Good description text is important because the model relies on it to know when and how to search.

**Data flow**: The test runs a normal searchable app setup, submits a turn, extracts the tool_search description, and checks that it includes expected discovery wording and Calendar source text. It also checks that old wording about client-side persistence is gone.

**Call relations**: It shares the same mock request pattern as the baseline test, but focuses on the human-readable instructions attached to tool_search rather than the tool schema.

*Call graph*: calls 6 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_once, sse, start_mock_server, tool_search_description); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `search_tool_hides_apps_tools_without_search`  (lines 389–422)

```
async fn search_tool_hides_apps_tools_without_search() -> Result<()>
```

**Purpose**: Verifies that searchable app tools stay hidden until the model actually uses tool_search. This keeps the first request small and prevents premature direct tool calls.

**Data flow**: The test submits a normal user turn with searchable app tools configured. It reads the outgoing tool names and expects tool_search to be present, while direct calendar create/list tools and the calendar namespace are absent.

**Call relations**: It uses the same app-search setup as other tests and calls tool_names to inspect the request. No tool_search call is made in the mocked response, so the test checks the pre-search state.

*Call graph*: calls 6 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_once, sse, start_mock_server, tool_names); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `explicit_app_mentions_respect_always_defer`  (lines 425–477)

```
async fn explicit_app_mentions_respect_always_defer() -> Result<()>
```

**Purpose**: Checks that mentioning an app explicitly in user input does not override the always-defer setting. Even if the user points at Calendar, the model should still discover its tools through search when that feature is active.

**Data flow**: The test enables the always-defer feature, sends a user message containing an app link, and captures the outgoing tools. It confirms tool_search is present and calendar child tools are not directly exposed.

**Call relations**: It combines the feature-flag path with explicit app mention behavior. tool_names and namespace_child_tool-style checks prove that the app mention did not cause direct tool injection.

*Call graph*: calls 6 internal fn (mount, search_capable_apps_builder, mount_sse_once, sse, start_mock_server, tool_names); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `tool_search_returns_deferred_tools_without_follow_up_tool_injection`  (lines 480–759)

```
async fn tool_search_returns_deferred_tools_without_follow_up_tool_injection() -> Result<()>
```

**Purpose**: Tests the full happy path for app tools found through tool_search: search returns a deferred calendar tool, the model calls it, and later requests still do not directly inject that tool. This protects the design where search results live in conversation history instead of permanently changing the advertised tools list.

**Data flow**: The mocked model first calls tool_search for a calendar create tool, then calls the returned namespaced calendar tool, then completes. The test watches MCP begin/end events, checks the invocation details and app metadata, inspects the recorded app server call, and verifies each request’s tools list stays free of direct calendar injection.

**Call relations**: This test ties together many helpers: mock SSE sequences drive the turn, wait_for_event observes real tool execution, recorded_apps_tool_call_by_call_id checks what reached the app server, and tool_search_output helpers inspect the search result sent back to the model.

*Call graph*: calls 8 internal fn (mount_searchable, recorded_apps_tool_call_by_call_id, search_capable_apps_builder, mount_sse_sequence, start_mock_server, tool_names, tool_search_output_item, tool_search_output_tools); 8 external calls (default, assert!, assert_eq!, wait_for_event, from_str, skip_if_no_network!, unreachable!, vec!).


##### `tool_search_returns_deferred_v1_multi_agent_tools`  (lines 762–862)

```
async fn tool_search_returns_deferred_v1_multi_agent_tools() -> Result<()>
```

**Purpose**: Ensures old-style multi-agent tools are hidden at first but can be found through tool_search. Multi-agent tools let the model spawn and coordinate helper agents, so their guidance must appear only when searched.

**Data flow**: The test configures a search-capable model, has the mocked model search for “spawn agent,” and captures two requests. It verifies the initial request advertises tool_search but not the multi-agent functions or their guidance, then confirms the search output returns a multi_agent_v1 namespace with spawn_agent marked as deferred and with the right description text.

**Call relations**: It uses tool_names for the first request and tool_search_output_item/tools plus namespace_child_tool for the search result. The mocked response completes without actually spawning an agent.

*Call graph*: calls 7 internal fn (mount_sse_sequence, namespace_child_tool, start_mock_server, test_codex, tool_names, tool_search_output_item, tool_search_output_tools); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `tool_search_returns_deferred_dynamic_tool_and_routes_follow_up_call`  (lines 865–1045)

```
async fn tool_search_returns_deferred_dynamic_tool_and_routes_follow_up_call() -> Result<()>
```

**Purpose**: Checks that dynamic tools supplied when a thread starts can be searched, then called, and that their result is returned to the model. Dynamic tools are tools added at runtime rather than fixed in the app or MCP configuration.

**Data flow**: The test creates a dynamic namespaced automation tool with defer_loading enabled. The mocked model searches for it, calls it in a later response, and then completes after the test sends back a successful DynamicToolResponse. The test confirms the tool was hidden before search, appeared in search output, produced a DynamicToolCallRequest event, and sent the returned text back as function-call output.

**Call relations**: It starts a new thread with dynamic tools through the thread manager. The test then uses events to catch the dynamic tool request and submits the dynamic response back into Codex, while request helpers verify no follow-up tool injection happened.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, tool_names, tool_search_output_tools); 11 external calls (default, assert!, assert_eq!, wait_for_event, json!, Namespace, from_value, to_string, skip_if_no_network!, unreachable! (+1 more)).


##### `tool_search_indexes_only_enabled_non_app_mcp_tools`  (lines 1048–1173)

```
async fn tool_search_indexes_only_enabled_non_app_mcp_tools() -> Result<()>
```

**Purpose**: Verifies that tool_search indexes only enabled tools from non-app MCP servers. Disabled MCP tools should not be discoverable, even if their server exists.

**Data flow**: The test starts a local stdio MCP test server with echo enabled and image disabled, then asks the mocked model to search for both. It checks that initial direct MCP tools are hidden, that the echo tool appears inside the mcp__rmcp namespace after search, and that the disabled image tool does not appear.

**Call relations**: It waits for the MCP server to be ready before submitting the turn. tool_names checks the pre-search request, while tool_search_output_tools and namespace_child_tool inspect search results for enabled-versus-disabled behavior.

*Call graph*: calls 7 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_sequence, namespace_child_tool, start_mock_server, tool_names, tool_search_output_tools); 7 external calls (assert!, assert_eq!, stdio_server_bin, wait_for_mcp_server, json!, skip_if_no_network!, vec!).


##### `tool_search_surfaced_mcp_tool_errors_are_returned_to_model`  (lines 1176–1331)

```
async fn tool_search_surfaced_mcp_tool_errors_are_returned_to_model() -> Result<()>
```

**Purpose**: Checks that when a tool discovered through search fails during execution, the model receives the real MCP error instead of a generic unsupported-call message. This helps the model recover from bad arguments or missing fields.

**Data flow**: The test configures an MCP echo tool behind search, has the mocked model search for it, then call it with missing required arguments. It waits for the MCP tool end event, confirms the call failed with an error mentioning the missing message field, and checks that the next model request includes that same visible error output.

**Call relations**: It combines search-result routing with actual MCP execution. The test proves that a namespaced tool found by tool_search is accepted as a valid follow-up call and that execution errors travel back through the normal function-call output path.

*Call graph*: calls 5 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_sequence, start_mock_server, tool_names); 10 external calls (default, assert!, assert_eq!, stdio_server_bin, wait_for_event, wait_for_mcp_server, panic!, skip_if_no_network!, unreachable!, vec!).


##### `tool_search_uses_non_app_mcp_server_instructions_as_namespace_description`  (lines 1334–1422)

```
async fn tool_search_uses_non_app_mcp_server_instructions_as_namespace_description() -> Result<()>
```

**Purpose**: Ensures a non-app MCP server’s own instructions become the description for its namespace in tool_search results. This gives the model context about what that group of tools is for.

**Data flow**: The test starts the rmcp test server, searches for its echo tool, and reads the returned tools. It finds the mcp__rmcp namespace and checks that its description matches the server-provided instructions.

**Call relations**: It waits for the MCP server, submits a simple search turn, and then uses tool_search_output_tools to inspect the second request where search results are sent back to the model.

*Call graph*: calls 5 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_sequence, start_mock_server, tool_search_output_tools); 5 external calls (assert_eq!, stdio_server_bin, wait_for_mcp_server, skip_if_no_network!, vec!).


##### `tool_search_matches_mcp_tools_by_distinct_name_description_and_schema_terms`  (lines 1425–1505)

```
async fn tool_search_matches_mcp_tools_by_distinct_name_description_and_schema_terms() -> Result<()>
```

**Purpose**: Checks that MCP tool search can match more than just friendly descriptions. It should also find tools by raw tool names and by words inside their input schema, which describes the arguments a tool accepts.

**Data flow**: The mocked model issues several tool_search calls in one response, each with a different query: a raw calendar tool name, a description phrase, and a schema field name. After the turn continues, the test checks that each query surfaces the expected calendar namespace child tool.

**Call relations**: This test uses the searchable app server as the source of MCP-backed calendar tools. It relies on the namespace-child search helper to make each query-result check concise.

*Call graph*: calls 4 internal fn (mount_searchable, search_capable_apps_builder, mount_sse_sequence, start_mock_server); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `tool_search_matches_dynamic_tools_by_name_description_namespace_and_schema_terms`  (lines 1508–1617)

```
async fn tool_search_matches_dynamic_tools_by_name_description_namespace_and_schema_terms() -> Result<()>
```

**Purpose**: Checks that dynamic tools are searchable by several kinds of text: exact name, name with spaces, description wording, namespace name, and schema fields. This makes discovery robust when the model does not know the exact tool identifier.

**Data flow**: The test creates a deferred dynamic tool named quasar_ping_beacon inside the orbit_ops namespace with a distinctive description and schema. The mocked model sends multiple tool_search calls using different query terms. After the turn completes, the test confirms every query returns the same dynamic tool as a namespace child.

**Call relations**: It starts a thread with runtime-provided dynamic tools, submits user input, waits for turn completion, and checks the captured search outputs. The test complements the MCP matching test by proving the same search behavior works for tools injected at thread start.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 7 external calls (default, assert!, assert_eq!, wait_for_event, Namespace, skip_if_no_network!, vec!).


### Code mode and runtime items
These tests validate higher-level runtime behavior, including Code Mode orchestration, emitted items/events, image tooling, and user-invoked shell commands.

### `core/tests/suite/code_mode.rs`

`test` · `test run`

Code mode is like giving the assistant a small workbench: it can run a script, print results, call tools, pause, resume, and keep some values for later. This test file makes sure that workbench behaves correctly when used through the real conversation flow, not just isolated unit tests. The tests create fake model responses with server-sent events, which are streamed messages from a mock API server, then watch what Codex sends back after executing the requested code. They verify everyday user-facing behavior: command output is returned, errors are shown clearly, long output is shortened only when it should be, images are accepted or rejected correctly, and yielded scripts can be waited on or terminated. They also check that nested tools are exposed properly through the global `tools` object, including MCP tools, app tools, hidden dynamic tools, and special helpers such as `text`, `image`, `store`, `load`, `notify`, `exit`, and `yield_control`. Without these tests, regressions in code mode could silently break important promises: scripts might lose output, run forever, expose tools they should not, fail to call external tools, or send malformed data back to the model.

#### Function details

##### `custom_tool_output_items`  (lines 69–77)

```
fn custom_tool_output_items(req: &ResponsesRequest, call_id: &str) -> Vec<Value>
```

**Purpose**: Reads the output from a custom tool call and normalizes it into a list of content items. Tests use it so they can compare outputs in one shape even when the protocol used either plain text or structured content.

**Data flow**: It takes a recorded response request and a tool call id. It looks up that call's output; if the output is already an array, it returns the array, and if it is a string, it wraps the string as an `input_text` item. If the output is neither, the test fails immediately.

**Call relations**: Many code-mode tests call this after a mock model turn finishes. It sits between the recorded HTTP request and the assertions that check script status headers, printed text, image items, and command results.

*Call graph*: calls 1 internal fn (custom_tool_call_output); called by 21 (code_mode_background_keeps_running_on_later_turn_without_wait, code_mode_can_apply_patch_via_nested_tool, code_mode_can_output_images_via_global_helper, code_mode_can_return_exec_command_output, code_mode_can_run_multiple_yielded_sessions, code_mode_can_use_mcp_image_result_with_image_helper, code_mode_can_use_view_image_result_with_image_helper, code_mode_can_yield_and_resume_with_wait, code_mode_concurrent_cells_merge_only_the_stored_values_they_write, code_mode_exit_stops_script_immediately (+11 more)); 2 external calls (panic!, vec!).


##### `tool_names`  (lines 79–94)

```
fn tool_names(body: &Value) -> Vec<String>
```

**Purpose**: Extracts the visible tool names from a request body sent to the model. It is used to check which tools Codex offered to the model in a given mode.

**Data flow**: It takes a JSON request body, looks for its `tools` array, and collects each tool's `name` or `type` field into strings. If there are no tools, it returns an empty list.

**Call relations**: Tests that care about prompt-time tool exposure use this helper after inspecting the first mocked model request. It turns verbose JSON into a simple list that can be compared against expected tool names.

*Call graph*: 1 external calls (get).


##### `function_tool_output_items`  (lines 96–104)

```
fn function_tool_output_items(req: &ResponsesRequest, call_id: &str) -> Vec<Value>
```

**Purpose**: Reads the output from a normal function tool call and normalizes it into a list of content items. It mirrors `custom_tool_output_items`, but for ordinary function tools such as `wait`.

**Data flow**: It receives a recorded response request and a call id. It fetches the function tool output, returns it directly if it is structured as an array, or wraps plain text as an `input_text` item.

**Call relations**: The wait-and-resume tests use this when the model calls the `wait` tool after an `exec` script has yielded. It prepares the returned data for assertions about running, completed, failed, or terminated scripts.

*Call graph*: calls 1 internal fn (function_call_output); called by 7 (code_mode_can_run_multiple_yielded_sessions, code_mode_can_yield_and_resume_with_wait, code_mode_wait_can_terminate_and_continue, code_mode_wait_returns_error_for_unknown_session, code_mode_wait_terminate_returns_completed_session_if_it_finished_after_yield_control, code_mode_wait_uses_its_own_max_tokens_budget, code_mode_yield_and_termination_are_not_starved_by_runtime_output); 2 external calls (panic!, vec!).


##### `text_item`  (lines 106–111)

```
fn text_item(items: &[Value], index: usize) -> &str
```

**Purpose**: Pulls the text string out of one content item at a chosen position. It keeps test assertions short and focused.

**Data flow**: It receives a slice of JSON content items and an index. It reads the item at that index, expects it to contain a text field, and returns that text as a string reference.

**Call relations**: Most output-checking tests call this after `custom_tool_output_items` or `function_tool_output_items`. It is the last small step before comparing script output to expected text or regular expressions.

*Call graph*: called by 18 (code_mode_background_keeps_running_on_later_turn_without_wait, code_mode_can_apply_patch_via_nested_tool, code_mode_can_output_images_via_global_helper, code_mode_can_return_exec_command_output, code_mode_can_run_multiple_yielded_sessions, code_mode_can_use_mcp_image_result_with_image_helper, code_mode_can_use_view_image_result_with_image_helper, code_mode_can_yield_and_resume_with_wait, code_mode_concurrent_cells_merge_only_the_stored_values_they_write, code_mode_exit_stops_script_immediately (+8 more)).


##### `extract_running_cell_id`  (lines 113–118)

```
fn extract_running_cell_id(text: &str) -> String
```

**Purpose**: Finds the id of a still-running code cell from the status text returned by code mode. Tests need this id to resume or terminate the same script later.

**Data flow**: It takes a status header string such as `Script running with cell ID ...`, removes the fixed prefix, reads the id before the next newline, and returns it as a new string.

**Call relations**: Yielding tests call this after the first `exec` response reports that a script is still running. They then pass the id into later `wait` calls so Codex targets the right background execution.

*Call graph*: called by 7 (code_mode_can_run_multiple_yielded_sessions, code_mode_can_yield_and_resume_with_wait, code_mode_concurrent_cells_merge_only_the_stored_values_they_write, code_mode_wait_can_terminate_and_continue, code_mode_wait_terminate_returns_completed_session_if_it_finished_after_yield_control, code_mode_wait_uses_its_own_max_tokens_budget, code_mode_yield_and_termination_are_not_starved_by_runtime_output).


##### `wait_for_file_source`  (lines 120–127)

```
fn wait_for_file_source(path: &Path) -> Result<String>
```

**Purpose**: Builds a small code-mode snippet that waits until a file exists. Tests use files as simple gates to control when a background script may continue.

**Data flow**: It takes a filesystem path, safely quotes it for a shell command, and returns JavaScript source that repeatedly calls `tools.exec_command` until the command prints `ready`.

**Call relations**: Long-running and multi-session tests insert this generated code into scripts. The Rust test later creates the file, which lets the running code move from one phase to the next in a predictable way.

*Call graph*: called by 6 (code_mode_can_run_multiple_yielded_sessions, code_mode_can_yield_and_resume_with_wait, code_mode_concurrent_cells_merge_only_the_stored_values_they_write, code_mode_wait_can_terminate_and_continue, code_mode_wait_terminate_returns_completed_session_if_it_finished_after_yield_control, code_mode_wait_uses_its_own_max_tokens_budget); 3 external calls (to_string_lossy, format!, try_join).


##### `custom_tool_output_body_and_success`  (lines 129–147)

```
fn custom_tool_output_body_and_success(
    req: &ResponsesRequest,
    call_id: &str,
) -> (String, Option<bool>)
```

**Purpose**: Gets the main human-readable output and success flag from a custom tool call. It hides the protocol details so tests can say, in effect, "what did the script print, and did it succeed?"

**Data flow**: It reads the call's content and success marker, then also examines structured output items. If there are text items, it chooses or combines them into one output string; otherwise it falls back to the raw content.

**Call relations**: Many tests call this after a code-mode `exec` run. It depends on `custom_tool_output_items` and feeds concise output plus success information into assertions about tool calls, script helpers, and error paths.

*Call graph*: calls 2 internal fn (custom_tool_call_output_content_and_success, custom_tool_output_items); called by 30 (app_only_tools_are_not_visible_or_runnable_by_code_mode_model, code_mode_can_call_hidden_dynamic_tools, code_mode_can_compare_elapsed_time_around_set_timeout, code_mode_can_output_images_via_global_helper, code_mode_can_output_serialized_text_via_global_helper, code_mode_can_print_content_only_mcp_tool_result_fields, code_mode_can_print_error_mcp_tool_result_fields, code_mode_can_print_structured_mcp_tool_result_fields, code_mode_can_resume_after_set_timeout, code_mode_can_store_and_load_values_across_turns (+15 more)).


##### `custom_tool_output_last_non_empty_text`  (lines 149–164)

```
fn custom_tool_output_last_non_empty_text(req: &ResponsesRequest, call_id: &str) -> Option<String>
```

**Purpose**: Finds the last non-blank text emitted by a custom tool call. This is useful when the output also contains a status header before the actual value being tested.

**Data flow**: It looks up the call output. If it is a non-empty string, it returns that string; if it is an array, it scans text fields from the end and returns the last one that is not blank.

**Call relations**: Tests that expect JSON or a final value use this helper to skip over earlier status items. It is often paired with JSON parsing to check stored values or `ALL_TOOLS` metadata.

*Call graph*: calls 1 internal fn (custom_tool_call_output); called by 6 (code_mode_can_call_hidden_dynamic_tools, code_mode_can_compare_elapsed_time_around_set_timeout, code_mode_can_store_and_load_values_across_turns, code_mode_concurrent_cells_merge_only_the_stored_values_they_write, code_mode_exports_all_tools_metadata_for_builtin_tools, code_mode_exports_all_tools_metadata_for_namespaced_mcp_tools).


##### `run_code_mode_turn`  (lines 166–172)

```
async fn run_code_mode_turn(
    server: &MockServer,
    prompt: &str,
    code: &str,
) -> Result<(TestCodex, ResponseMock)>
```

**Purpose**: Sets up the common two-step mock conversation for a simple code-mode test. It enables code mode, makes the fake model call `exec`, then prepares a follow-up response.

**Data flow**: It receives a mock server, user prompt, and code string. It delegates to the configurable setup helper and returns the built `TestCodex` plus the mock that records the follow-up request.

**Call relations**: Most straightforward tests call this instead of repeating setup. It hands off to `run_code_mode_turn_with_config`, which adds the actual mock responses and configuration.

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

**Purpose**: Runs the standard code-mode test setup while letting the caller tweak Codex configuration. Tests use it when they need a feature flag, token budget, or image behavior changed.

**Data flow**: It takes the server, prompt, code, and a configuration callback. It chooses the default test model, passes the callback onward, and returns the test harness and follow-up mock.

**Call relations**: This helper is the middle layer between the simplest `run_code_mode_turn` and the full model-aware setup. Tests call it when the default model is fine but configuration matters.

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

**Purpose**: Builds a complete code-mode test conversation with a chosen model and custom configuration. It is the main reusable setup block for simple `exec` tests.

**Data flow**: It builds a `TestCodex`, enables code mode, applies caller configuration, mounts one mock response where the model calls `exec`, mounts a second response where the model says done, submits the user turn, and returns the test plus the second mock.

**Call relations**: Higher-level setup helpers call this. The individual tests then inspect the second mock because that is where Codex sends the code-mode tool output back to the model.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); called by 2 (resize_all_images_resizes_explicit_original_code_mode_image, run_code_mode_turn_with_config); 1 external calls (vec!).


##### `code_mode_can_call_standalone_web_search`  (lines 221–320)

```
async fn code_mode_can_call_standalone_web_search() -> Result<()>
```

**Purpose**: Checks that code running inside code mode can call the standalone web search tool. This protects the integration between the code-mode sandbox and live web-search extension wiring.

**Data flow**: The test sets up a fake search endpoint, enables code mode plus standalone web search, and runs code that calls `tools.web__run`. It then verifies the search request body and confirms the search result is returned as tool output.

**Call relations**: This test does its own setup because it needs authentication, an extension registry, and a mock HTTP search route. It uses the same follow-up request pattern as other code-mode tests.

*Call graph*: calls 6 internal fn (auth_manager_from_auth, mount_sse_once, sse, start_mock_server, test_codex, from_api_key); 11 external calls (new, new, given, new, assert_eq!, install, json!, skip_if_no_network!, vec!, method (+1 more)).


##### `run_code_mode_turn_with_rmcp`  (lines 322–328)

```
async fn run_code_mode_turn_with_rmcp(
    server: &MockServer,
    prompt: &str,
    code: &str,
) -> Result<(TestCodex, ResponseMock)>
```

**Purpose**: Sets up a standard code-mode turn with the test MCP server attached. MCP means Model Context Protocol, a way for Codex to talk to external tool servers.

**Data flow**: It receives a server, prompt, and code string, then delegates to the model-specific MCP helper with the default code-mode test model.

**Call relations**: MCP-focused tests call this when they do not need special model or feature settings. It forwards to `run_code_mode_turn_with_rmcp_model`, which eventually starts and waits for the MCP server.

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

**Purpose**: Sets up a code-mode turn with the test MCP server and a chosen model. It is used when image or model behavior matters.

**Data flow**: It takes the mock server, prompt, code, and model name, then passes them to the full MCP configuration helper with default feature choices.

**Call relations**: Tests that need the MCP server plus a non-default model call this. It hands off to `run_code_mode_turn_with_rmcp_config` for the actual server and mock conversation setup.

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

**Purpose**: Sets up a code-mode turn with MCP while choosing whether to run normal code mode or code-mode-only behavior. Code-mode-only limits which tools are exposed directly to the model.

**Data flow**: It receives the server, prompt, code, and a boolean for code-mode-only. It forwards these to the full MCP configuration helper using the default test model.

**Call relations**: The test that proves MCP tools still work in code-mode-only calls this. The full helper then configures features, launches the MCP test server, and submits the turn.

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

**Purpose**: Builds the full reusable test setup for code mode with a local MCP test server. It can also enable code-mode-only and alternate MCP tool naming.

**Data flow**: It finds the test MCP server binary, configures Codex to start it over standard input/output, enables the requested features, waits until the server is ready, mounts the two mock model responses, submits the prompt, and returns the test plus follow-up mock.

**Call relations**: All MCP helper layers eventually call this. MCP tests then inspect the follow-up request to see whether code-mode calls reached the server and came back with the right shape.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); called by 3 (code_mode_uses_non_prefixed_mcp_tool_names_when_feature_enabled, run_code_mode_turn_with_rmcp_mode, run_code_mode_turn_with_rmcp_model); 3 external calls (stdio_server_bin, wait_for_mcp_server, vec!).


##### `code_mode_can_return_exec_command_output`  (lines 442–480)

```
async fn code_mode_can_return_exec_command_output() -> Result<()>
```

**Purpose**: Verifies that code mode can call the nested local command tool and return its structured result. This proves scripts can use shell commands and receive details such as output and exit code.

**Data flow**: The test runs code that calls `tools.exec_command` with a `printf` command and prints the JSON result. It then checks that the tool output contains a completion header and a parsed command result with output, exit code, timing, and no session id.

**Call relations**: It uses `run_code_mode_turn` for setup and `custom_tool_output_items` plus `text_item` for inspection. It is skipped where local command execution is unavailable.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_items, run_code_mode_turn, text_item); 6 external calls (assert!, assert_eq!, concat!, assert_regex_match, from_str, skip_if_no_network!).


##### `code_mode_only_restricts_prompt_tools`  (lines 483–515)

```
async fn code_mode_only_restricts_prompt_tools() -> Result<()>
```

**Purpose**: Checks that code-mode-only exposes only the small prompt-level tool set to the model. This keeps direct model access narrow while code mode remains the main workbench.

**Data flow**: The test enables `CodeModeOnly`, submits a turn, and reads the first request sent to the fake model. It extracts tool names and compares them with the expected list.

**Call relations**: This test uses direct mock setup rather than the code-running helper because it only cares about the tools shown before any code executes. It relies on `tool_names` to summarize the request body.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `code_mode_only_guides_all_tools_search_and_calls_deferred_app_tools`  (lines 518–641)

```
async fn code_mode_only_guides_all_tools_search_and_calls_deferred_app_tools() -> Result<()>
```

**Purpose**: Checks that code-mode-only hides app tools from the prompt list but still lets code discover and call allowed deferred app tools through `ALL_TOOLS`. Deferred means the tool is loaded or invoked only when needed.

**Data flow**: The test mounts a fake searchable apps server, enables apps and code-mode-only, and runs code that finds a calendar tool in `ALL_TOOLS` and calls it. It verifies the prompt tool list is short, the `exec` description guides tool search, and the deferred app tool returns the expected text.

**Call relations**: This test combines app-server support with code-mode output helpers. It proves the path from metadata discovery inside code to an actual app tool call works even when the model cannot directly see every app tool.

*Call graph*: calls 7 internal fn (mount_searchable, mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_body_and_success, create_dummy_chatgpt_auth_for_testing); 6 external calls (assert!, assert_eq!, assert_ne!, from_str, skip_if_no_network!, vec!).


##### `app_only_tools_are_not_visible_or_runnable_by_code_mode_model`  (lines 644–727)

```
async fn app_only_tools_are_not_visible_or_runnable_by_code_mode_model() -> Result<()>
```

**Purpose**: Ensures app-only tools are not exposed to or callable from code mode. This protects tools intended only for direct app use from being reached through the code-mode workbench.

**Data flow**: The test mounts an app server with one normal visible tool and one app-only tool. Code checks `ALL_TOOLS`, checks the `tools` object, tries to call the app-only name, and reports what happened; the test confirms the app-only tool was absent and never reached the server.

**Call relations**: It uses app test support plus `custom_tool_output_body_and_success` to inspect the code result. It also checks the app server's recorded calls to ensure blocked access failed before dispatch.

*Call graph*: calls 6 internal fn (mount_with_app_only_tool, search_capable_apps_builder, mount_sse_once, sse, start_mock_server, custom_tool_output_body_and_success); 7 external calls (assert!, assert_eq!, assert_ne!, format!, from_str, skip_if_no_network!, vec!).


##### `code_mode_only_can_call_nested_tools`  (lines 731–777)

```
async fn code_mode_only_can_call_nested_tools() -> Result<()>
```

**Purpose**: Verifies that code-mode-only still allows code run by `exec` to call nested tools. The prompt tool list is restricted, but the script workbench must remain useful.

**Data flow**: The test enables code-mode-only and runs code that calls `tools.exec_command`. It checks the final output equals the marker printed by the nested command.

**Call relations**: It sets up its own mock model responses and uses `custom_tool_output_body_and_success` to read the result. It is skipped on systems without local command execution.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_body_and_success); 4 external calls (assert_eq!, assert_ne!, skip_if_no_network!, vec!).


##### `code_mode_update_plan_nested_tool_result_is_empty_object`  (lines 780–808)

```
async fn code_mode_update_plan_nested_tool_result_is_empty_object() -> Result<()>
```

**Purpose**: Checks that calling `update_plan` from code mode succeeds and returns an empty object. This confirms planning updates can be made without leaking unnecessary data back into the script.

**Data flow**: The test runs code that calls `tools.update_plan`, stringifies the result, and prints it. It parses the returned output and expects `{}`.

**Call relations**: It uses the standard code-mode turn helper and the common output parser. The test covers one built-in nested tool's return shape.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_get_context_remaining_returns_structured_result`  (lines 811–849)

```
async fn code_mode_get_context_remaining_returns_structured_result() -> Result<()>
```

**Purpose**: Checks that code mode can call the context-budget tool and receive structured token information. Token budget here means an estimate of how much conversation space remains.

**Data flow**: The test enables the token-budget feature, sets a context window, runs code that calls `tools.get_context_remaining`, and prints the result. It parses the JSON and expects a `tokens_left` value.

**Call relations**: It uses `run_code_mode_turn_with_config` because the feature and model window must be configured. The output helper then verifies the nested tool's structured result.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_config); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_nested_tool_calls_can_run_in_parallel`  (lines 853–941)

```
async fn code_mode_nested_tool_calls_can_run_in_parallel() -> Result<()>
```

**Purpose**: Verifies that two nested tools called from one code-mode script can run at the same time. Without this, scripts using `Promise.all` would be slower or could deadlock.

**Data flow**: The test first warms up parallel tool execution, then runs two synchronized test tools with a delay and measures wall-clock time. It expects the total time to be short enough to prove parallel execution and checks the results are both `ok`.

**Call relations**: It mounts a sequence of mock model responses for two turns. It reads the last follow-up request with `custom_tool_output_items` to confirm what the script returned.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, custom_tool_output_items); 5 external calls (now, assert!, assert_eq!, skip_if_no_network!, vec!).


##### `code_mode_exec_command_explicit_max_output_tokens_truncates`  (lines 945–971)

```
async fn code_mode_exec_command_explicit_max_output_tokens_truncates() -> Result<()>
```

**Purpose**: Checks that a nested `exec_command` call can request a small output limit and receive truncated output. This keeps huge command output from overwhelming the model.

**Data flow**: The test runs a command that prints a fixed long string while setting `max_output_tokens` to a small number. It then checks that the returned command output contains the expected truncation message and preserved beginning/end text.

**Call relations**: It uses the standard code-mode helper and directly compares the second output item. This covers the per-tool argument form of output limiting.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 2 external calls (assert_eq!, skip_if_no_network!).


##### `code_mode_exec_explicit_max_above_default_preserves_output`  (lines 975–1006)

```
async fn code_mode_exec_explicit_max_above_default_preserves_output() -> Result<()>
```

**Purpose**: Checks that a larger explicit code-mode output budget can preserve output bigger than the normal default. This prevents accidental truncation when a script asks for more room.

**Data flow**: The test runs Python that prints many `x` characters and includes an `@exec` directive with a larger `max_output_tokens` value. It expects the complete output to be returned.

**Call relations**: It uses `run_code_mode_turn` and is skipped in environments where nested command output is unreliable. It exercises the script-level directive form of output budgeting.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 3 external calls (assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `code_mode_exec_explicit_max_above_default_truncates_larger_output`  (lines 1010–1045)

```
async fn code_mode_exec_explicit_max_above_default_truncates_larger_output() -> Result<()>
```

**Purpose**: Checks that even with a larger explicit budget, output larger than that budget is still truncated. This confirms the limit is honored rather than ignored.

**Data flow**: The test prints a very large block of `A` characters with a high but finite `@exec` limit. It expects a warning, line count, and a middle truncation marker between preserved output sections.

**Call relations**: It uses the standard turn helper and exact string comparison. Together with the previous test, it defines both sides of the output-budget boundary.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 3 external calls (assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `code_mode_exec_explicit_max_above_truncation_policy_preserves_output`  (lines 1049–1083)

```
async fn code_mode_exec_explicit_max_above_truncation_policy_preserves_output() -> Result<()>
```

**Purpose**: Checks that an explicit code-mode budget can override a smaller global tool-output truncation policy. This matters when a script intentionally requests more output for a valid reason.

**Data flow**: The test sets the global tool output token limit very low but includes an `@exec` directive asking for more. It runs a large-output command and expects the full output to be preserved.

**Call relations**: It uses `run_code_mode_turn_with_config` to set the policy. The test proves script-level budgeting has the intended priority over the broader default limit.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn_with_config); 3 external calls (assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `code_mode_exec_without_max_preserves_output_beyond_default`  (lines 1087–1117)

```
async fn code_mode_exec_without_max_preserves_output_beyond_default() -> Result<()>
```

**Purpose**: Checks that a script-level `@exec` output budget applies even when the nested `exec_command` call itself does not specify a maximum. This keeps the directive useful for all nested output.

**Data flow**: The test runs a large-output command with an `@exec` directive but no `max_output_tokens` argument inside the command call. It expects the full output to appear.

**Call relations**: It uses the standard helper and skips unreliable command environments. It complements tests that set limits directly on `exec_command`.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 3 external calls (assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `code_mode_exec_without_max_preserves_output_beyond_truncation_policy`  (lines 1121–1154)

```
async fn code_mode_exec_without_max_preserves_output_beyond_truncation_policy() -> Result<()>
```

**Purpose**: Checks that the script-level output budget also beats a low global truncation policy when the nested command omits its own max. This protects output chosen by the code-mode caller.

**Data flow**: The test lowers the global output limit, runs a large-output command under a larger `@exec` directive, and expects the complete output.

**Call relations**: It uses the configurable turn helper. It ties together the global policy, script directive, and nested command default behavior.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn_with_config); 3 external calls (assert_eq!, skip_if_no_network!, skip_if_wine_exec!).


##### `code_mode_exec_explicit_max_output_tokens_truncates`  (lines 1158–1183)

```
async fn code_mode_exec_explicit_max_output_tokens_truncates() -> Result<()>
```

**Purpose**: Checks that a script-level `@exec` maximum causes truncation of printed nested command output. This is the directive-based version of the small-output-limit test.

**Data flow**: The test runs a command that prints a fixed string and puts `max_output_tokens: 5` in the `@exec` directive. It expects a warning and a shortened output with a token-truncation marker.

**Call relations**: It uses the standard helper and compares the returned output text. Although it shares a name with another test in the provided inventory, this case covers the directive form rather than the nested tool argument form.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 2 external calls (assert_eq!, skip_if_no_network!).


##### `code_mode_returns_accumulated_output_when_script_fails`  (lines 1186–1225)

```
async fn code_mode_returns_accumulated_output_when_script_fails() -> Result<()>
```

**Purpose**: Verifies that code mode keeps text printed before a script error. Users need to see partial progress, not just the final crash.

**Data flow**: The test runs code that prints two messages and then throws an error. It checks that the output contains a failure header, both earlier messages, and a script error stack.

**Call relations**: It uses `run_code_mode_turn`, then normalizes the custom tool output into items. The assertions confirm both accumulated output and failure reporting.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_items, run_code_mode_turn, text_item); 4 external calls (assert_eq!, concat!, assert_regex_match, skip_if_no_network!).


##### `code_mode_exec_surfaces_handler_errors_as_exceptions`  (lines 1229–1264)

```
async fn code_mode_exec_surfaces_handler_errors_as_exceptions() -> Result<()>
```

**Purpose**: Checks that errors from nested tool handlers become catchable script exceptions. This lets code-mode scripts recover from tool failures using normal `try`/`catch` logic.

**Data flow**: The test calls `tools.exec_command` with invalid arguments inside a `try` block. It expects the catch branch to print an error marker and the success branch not to run.

**Call relations**: It uses the standard helper and output-success reader. The test protects the contract between nested tool failures and JavaScript exception behavior.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn); 3 external calls (assert!, assert_ne!, skip_if_no_network!).


##### `code_mode_can_yield_and_resume_with_wait`  (lines 1268–1410)

```
async fn code_mode_can_yield_and_resume_with_wait() -> Result<()>
```

**Purpose**: Verifies that a long-running code-mode script can pause with `yield_control` and later resume through the `wait` tool. This is essential for scripts that need more than one model turn.

**Data flow**: The test starts a script that prints phase 1, yields, waits for file gates, then prints phases 2 and 3. It captures the running cell id, calls `wait` twice, opens the gates by writing files, and checks each phase output.

**Call relations**: It uses `wait_for_file_source` to build controllable script gates and `extract_running_cell_id` to target the same running cell. Function-tool output helpers inspect the later wait results.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item, wait_for_file_source); 7 external calls (assert_eq!, concat!, assert_regex_match, format!, write, skip_if_no_network!, vec!).


##### `code_mode_yield_and_termination_are_not_starved_by_runtime_output`  (lines 1414–1507)

```
async fn code_mode_yield_and_termination_are_not_starved_by_runtime_output() -> Result<()>
```

**Purpose**: Checks that heavy script output does not prevent yielding or termination commands from being processed. This avoids a runaway script blocking control messages.

**Data flow**: The test runs code that emits many text events and then loops forever, with immediate yielding and a tiny output budget. It confirms the first response reports a running cell, then sends a terminating `wait` call and expects a termination header.

**Call relations**: It uses manual mock setup because it needs a start turn and a terminate turn. The test focuses on controller fairness under output pressure.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item); 8 external calls (from_secs, assert!, assert_eq!, concat!, assert_regex_match, skip_if_no_network!, timeout, vec!).


##### `code_mode_can_run_multiple_yielded_sessions`  (lines 1511–1675)

```
async fn code_mode_can_run_multiple_yielded_sessions() -> Result<()>
```

**Purpose**: Verifies that two yielded code-mode scripts can exist at the same time and be resumed independently. Each running cell must keep its own identity and output.

**Data flow**: The test starts session A, captures its cell id, starts session B, captures a different id, then releases each file gate and waits on each id. It checks that each session returns its own completion text.

**Call relations**: It uses `wait_for_file_source` for gates and both custom-tool and function-tool output helpers. This proves code mode can track multiple background cells.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item, wait_for_file_source); 8 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, format!, write, skip_if_no_network!, vec!).


##### `code_mode_concurrent_cells_merge_only_the_stored_values_they_write`  (lines 1679–1828)

```
async fn code_mode_concurrent_cells_merge_only_the_stored_values_they_write() -> Result<()>
```

**Purpose**: Checks that shared stored values are merged safely when concurrent code cells run. One cell should not overwrite unrelated stored changes made by another cell.

**Data flow**: The test stores initial values `a` and `b`, starts one yielded cell that changes `a`, runs another cell that changes `b`, then lets the first finish. A final script loads both values and expects `a` and `b` to reflect both changes.

**Call relations**: It uses yielded-cell helpers plus `custom_tool_output_last_non_empty_text` for the final JSON. The scenario protects the `store`/`load` state merge behavior.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, custom_tool_output_last_non_empty_text, extract_running_cell_id, text_item, wait_for_file_source); 6 external calls (assert_eq!, format!, write, from_str, skip_if_no_network!, vec!).


##### `code_mode_wait_can_terminate_and_continue`  (lines 1832–1955)

```
async fn code_mode_wait_can_terminate_and_continue() -> Result<()>
```

**Purpose**: Verifies that a yielded script can be terminated and that code mode remains usable afterward. Termination must clean up only the target cell, not the whole code-mode system.

**Data flow**: The test starts a script, captures its cell id, sends a `wait` request with `terminate: true`, and checks for a termination header. It then runs a fresh `exec` script and expects it to complete normally.

**Call relations**: It combines custom output inspection for the original script with function output inspection for the termination. A final normal exec call proves recovery.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item, wait_for_file_source); 6 external calls (assert_eq!, concat!, assert_regex_match, format!, skip_if_no_network!, vec!).


##### `code_mode_wait_returns_error_for_unknown_session`  (lines 1958–2015)

```
async fn code_mode_wait_returns_error_for_unknown_session() -> Result<()>
```

**Purpose**: Checks that waiting on a nonexistent cell id returns a clear failure. This prevents silent hangs or misleading success when the model asks about the wrong running script.

**Data flow**: The test sends a `wait` tool call for cell id `999999`. It expects the tool output success flag not to be true and the content to say the exec cell was not found.

**Call relations**: It directly mounts a function-call response rather than starting a script first. The function output helper is used to read the failure items.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, function_tool_output_items, text_item); 6 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!, vec!).


##### `code_mode_wait_terminate_returns_completed_session_if_it_finished_after_yield_control`  (lines 2019–2211)

```
async fn code_mode_wait_terminate_returns_completed_session_if_it_finished_after_yield_control() -> Result<()>
```

**Purpose**: Tests a race-like case where a yielded session finishes in the background before a later terminate request reaches it. The result should be sensible whether termination wins or completion is already recorded.

**Data flow**: The test starts sessions A and B, lets A finish while B is being waited on, confirms A wrote a marker file, then asks to terminate A. It accepts either a clean termination header or a completed/terminated response that includes A's final text.

**Call relations**: It uses multiple yielded sessions, file gates, nested command output, and wait calls. The test protects robust behavior around timing edges.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item, wait_for_file_source); 12 external calls (from_millis, assert!, assert_eq!, concat!, assert_regex_match, format!, write, panic!, try_join, skip_if_no_network! (+2 more)).


##### `code_mode_background_keeps_running_on_later_turn_without_wait`  (lines 2215–2304)

```
async fn code_mode_background_keeps_running_on_later_turn_without_wait() -> Result<()>
```

**Purpose**: Checks that a yielded background script continues running on a later turn even if the model does not call `wait` for that script. Yielding should release control, not freeze the cell forever.

**Data flow**: The test starts code that yields, then writes a file through a nested command after resuming. On a later turn, the model calls a separate `exec_command` that waits for that file, and the test confirms the file appears.

**Call relations**: It uses manual mock setup for the yielded exec and then a separate function tool call. The file acts as proof that the background cell resumed without being explicitly waited on.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, text_item); 8 external calls (assert!, assert_eq!, concat!, assert_regex_match, format!, try_join, skip_if_no_network!, vec!).


##### `code_mode_wait_uses_its_own_max_tokens_budget`  (lines 2308–2404)

```
async fn code_mode_wait_uses_its_own_max_tokens_budget() -> Result<()>
```

**Purpose**: Verifies that the `wait` tool can apply its own output token budget when collecting later output from a yielded script. This lets a model request a smaller continuation result than the original script budget.

**Data flow**: The test starts a yielded script with a large `@exec` budget, then calls `wait` with `max_tokens: 6` after releasing the file gate. It expects the completion result to include a truncation warning.

**Call relations**: It uses the same yield/resume mechanics as other wait tests but focuses on output sizing. Function-tool output items are inspected because the limited output comes from `wait`.

*Call graph*: calls 9 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_items, extract_running_cell_id, function_tool_output_items, text_item, wait_for_file_source); 7 external calls (assert_eq!, concat!, assert_regex_match, format!, write, skip_if_no_network!, vec!).


##### `code_mode_can_output_serialized_text_via_global_helper`  (lines 2407–2434)

```
async fn code_mode_can_output_serialized_text_via_global_helper() -> Result<()>
```

**Purpose**: Checks that the global `text` helper can serialize non-string values. This lets scripts print objects without manually calling `JSON.stringify`.

**Data flow**: The test runs code that calls `text({ json: true })`. It reads the output body and expects compact JSON text.

**Call relations**: It uses the standard code-mode helper and the common body/success reader. The test defines the user-facing behavior of `text` for structured values.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn); 4 external calls (assert_eq!, assert_ne!, eprintln!, skip_if_no_network!).


##### `code_mode_can_resume_after_set_timeout`  (lines 2437–2461)

```
async fn code_mode_can_resume_after_set_timeout() -> Result<()>
```

**Purpose**: Verifies that asynchronous timers work inside code mode. Scripts should be able to await a short delay and then continue.

**Data flow**: The test runs code that awaits a `setTimeout` promise and then prints `timer done`. It checks the returned output and success flag.

**Call relations**: It uses the standard helper. This covers the JavaScript runtime's event-loop behavior inside code mode.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_notify_injects_additional_exec_tool_output_into_active_context`  (lines 2464–2498)

```
async fn code_mode_notify_injects_additional_exec_tool_output_into_active_context() -> Result<()>
```

**Purpose**: Checks that the `notify` helper can add extra output to the active conversation context while a script is still running. This lets scripts surface progress before final completion.

**Data flow**: The test runs code that calls `notify`, then calls a nested test tool, then prints done. It scans the request sent back to the model and verifies a custom tool output item contains the notification marker.

**Call relations**: It uses the standard turn helper but inspects raw input items rather than only final output. The test proves notification output is injected under the original `exec` call.

*Call graph*: calls 2 internal fn (start_mock_server, run_code_mode_turn); 2 external calls (assert!, skip_if_no_network!).


##### `code_mode_exit_stops_script_immediately`  (lines 2501–2536)

```
async fn code_mode_exit_stops_script_immediately() -> Result<()>
```

**Purpose**: Verifies that the global `exit` helper stops script execution cleanly. Code after `exit()` should not run.

**Data flow**: The test prints `before`, calls `exit()`, then has a later print that should be skipped. It checks that the script completed successfully and only `before` appears.

**Call relations**: It uses both item-level and body-level output helpers. This confirms `exit` is treated as a controlled stop, not an error.

*Call graph*: calls 5 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn, text_item); 5 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!).


##### `code_mode_surfaces_text_stringify_errors`  (lines 2539–2576)

```
async fn code_mode_surfaces_text_stringify_errors() -> Result<()>
```

**Purpose**: Checks that failures while serializing `text` output are reported as script failures. A common example is trying to JSON-serialize a circular object.

**Data flow**: The test creates an object that points to itself and passes it to `text`. It expects a failure header and an error message mentioning circular JSON conversion.

**Call relations**: It uses the standard helper and item inspection. The test protects clear error reporting from the global output helper.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_items, run_code_mode_turn, text_item); 6 external calls (assert!, assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!).


##### `code_mode_can_output_images_via_global_helper`  (lines 2579–2618)

```
async fn code_mode_can_output_images_via_global_helper() -> Result<()>
```

**Purpose**: Verifies that the global `image` helper can emit an image content item from a base64 data URL. This is how code mode can send visual results back to the model.

**Data flow**: The test calls `image` with a data URL. It expects a completed script header followed by an `input_image` item with the same URL and high detail.

**Call relations**: It uses the standard helper and structured item inspection. This test defines the happy path for code-mode image output.

*Call graph*: calls 5 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn, text_item); 5 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!).


##### `resize_all_images_replaces_malformed_code_mode_image`  (lines 2621–2649)

```
async fn resize_all_images_replaces_malformed_code_mode_image() -> Result<()>
```

**Purpose**: Checks that when image resizing is enabled, malformed image data is replaced with a text explanation instead of causing bad image content to be sent. This is a safety fallback.

**Data flow**: The test enables `ResizeAllImages`, emits an invalid PNG data URL, and reads the output items. It expects the second item to be text saying the image was omitted because it could not be processed.

**Call relations**: It uses the configurable code-mode setup because the resize feature must be enabled. The test guards the image-processing error path.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn_with_config); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `resize_all_images_resizes_explicit_original_code_mode_image`  (lines 2652–2704)

```
async fn resize_all_images_resizes_explicit_original_code_mode_image() -> Result<()>
```

**Purpose**: Verifies that a very large image emitted with `detail: original` is resized when the resize-all-images feature is enabled. This keeps image payloads within acceptable limits.

**Data flow**: The test creates a large in-memory PNG, encodes it as a data URL, runs code that emits it, then decodes the returned image URL. It checks that the output kept `original` detail but the dimensions were reduced.

**Call relations**: It uses the model-and-config setup because both model choice and resize feature matter. Image library calls create and inspect the actual image bytes.

*Call graph*: calls 5 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn_with_model_and_config, new); 9 external calls (ImageRgba8, from_pixel, new, assert_eq!, assert_ne!, format!, Rgba, load_from_memory, skip_if_no_network!).


##### `code_mode_image_helper_rejects_remote_url`  (lines 2707–2744)

```
async fn code_mode_image_helper_rejects_remote_url() -> Result<()>
```

**Purpose**: Checks that the `image` helper rejects remote image URLs. Code-mode outputs must use embedded data URLs so the system controls what is sent onward.

**Data flow**: The test calls `image` with an `https://` URL. It expects script failure and an error message telling the caller to pass a base64 data URI instead.

**Call relations**: It uses the standard helper and text item assertions. This protects the boundary between local/embedded image output and external URLs.

*Call graph*: calls 5 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn, text_item); 5 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!).


##### `code_mode_can_use_view_image_result_with_image_helper`  (lines 2747–2827)

```
async fn code_mode_can_use_view_image_result_with_image_helper() -> Result<()>
```

**Purpose**: Verifies that code mode can call `view_image` on a local file and pass that result into the `image` helper. This lets scripts inspect or forward images found on disk.

**Data flow**: The test writes a tiny PNG file, runs code that calls `tools.view_image` with original detail, and then calls `image(out)`. It checks the final output contains an `input_image` data URL with original detail.

**Call relations**: It uses manual setup because it creates a real file in the test workspace. The test connects the nested `view_image` tool result shape to the global image helper.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_body_and_success, custom_tool_output_items, text_item); 10 external calls (assert!, assert_eq!, assert_ne!, concat!, assert_regex_match, format!, write, to_string, skip_if_no_network!, vec!).


##### `code_mode_can_use_mcp_image_result_with_image_helper`  (lines 2830–2883)

```
async fn code_mode_can_use_mcp_image_result_with_image_helper() -> Result<()>
```

**Purpose**: Checks that an image returned by an MCP tool can be passed to the code-mode `image` helper. This proves external tool image results can become model-visible image inputs.

**Data flow**: The test calls an MCP image scenario tool, finds the image item in its content, and passes it to `image`. It expects a completed script and an `input_image` data URL with original detail.

**Call relations**: It uses the MCP model helper to attach the test server. The output assertions mirror the local `view_image` test but with an external MCP source.

*Call graph*: calls 5 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_items, run_code_mode_turn_with_rmcp_model, text_item); 6 external calls (assert!, assert_eq!, assert_ne!, concat!, assert_regex_match, skip_if_no_network!).


##### `code_mode_can_apply_patch_via_nested_tool`  (lines 2886–2923)

```
async fn code_mode_can_apply_patch_via_nested_tool() -> Result<()>
```

**Purpose**: Verifies that code mode can call the nested `apply_patch` tool to edit files. This lets scripts make workspace changes through the same patch machinery as the assistant.

**Data flow**: The test builds a patch that adds a file, runs code that calls `tools.apply_patch`, and expects an empty-object result. It then reads the new file from disk and checks its contents.

**Call relations**: It uses the standard helper for the code turn and direct filesystem inspection for the side effect. The test connects nested tool output with real workspace mutation.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_items, run_code_mode_turn, text_item); 6 external calls (assert_eq!, assert_ne!, concat!, assert_regex_match, format!, skip_if_no_network!).


##### `code_mode_can_print_structured_mcp_tool_result_fields`  (lines 2926–2961)

```
async fn code_mode_can_print_structured_mcp_tool_result_fields() -> Result<()>
```

**Purpose**: Checks that code mode receives structured fields from an MCP tool result. Structured content is machine-readable data returned alongside ordinary content.

**Data flow**: The test calls the MCP echo tool with a message, then prints fields from `structuredContent`, `isError`, and `content`. It expects the echoed message, propagated environment value, false error flag, and empty content length.

**Call relations**: It uses the standard MCP helper. This proves code-mode scripts can read rich MCP return values, not just plain text.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_only_can_call_mcp_tool`  (lines 2964–2991)

```
async fn code_mode_only_can_call_mcp_tool() -> Result<()>
```

**Purpose**: Verifies that MCP tools remain callable from inside code mode when code-mode-only is enabled. Restricted prompt tools should not block nested MCP use.

**Data flow**: The test enables code-mode-only with the MCP server, calls the MCP echo tool from code, and prints the echoed value. It expects the result to be returned successfully.

**Call relations**: It uses `run_code_mode_turn_with_rmcp_mode` to choose code-mode-only. The output helper confirms the MCP call succeeded from inside `exec`.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp_mode); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_exposes_mcp_tools_on_global_tools_object`  (lines 2994–3032)

```
async fn code_mode_exposes_mcp_tools_on_global_tools_object() -> Result<()>
```

**Purpose**: Checks that MCP tools appear as callable functions on the global `tools` object inside code mode. Scripts need this global object to call nested tools.

**Data flow**: The test checks that `tools` includes the namespaced echo function, calls it, and prints type and result details. It expects the function to exist and return the echo response.

**Call relations**: It uses the MCP helper and output body reader. This test focuses on the global JavaScript API exposed to scripts.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_uses_non_prefixed_mcp_tool_names_when_feature_enabled`  (lines 3035–3076)

```
async fn code_mode_uses_non_prefixed_mcp_tool_names_when_feature_enabled() -> Result<()>
```

**Purpose**: Checks the alternate MCP naming feature where tool names omit the leading `mcp__` prefix. This protects compatibility with a feature-flagged naming mode.

**Data flow**: The test enables non-prefixed MCP names, calls `tools.rmcp__echo`, and reports whether prefixed and non-prefixed functions exist. It expects only the non-prefixed name to be callable and the echo result to be correct.

**Call relations**: It uses the full MCP configuration helper because a special feature flag is required. The returned JSON is parsed to verify the names available in code.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp_config); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_exposes_namespaced_mcp_tools_on_global_tools_object`  (lines 3079–3112)

```
async fn code_mode_exposes_namespaced_mcp_tools_on_global_tools_object() -> Result<()>
```

**Purpose**: Checks that both built-in and namespaced MCP tools are exposed correctly on `tools`. Namespacing avoids collisions between tools from different servers.

**Data flow**: The test prints whether `tools.exec_command` and `tools.mcp__rmcp__echo` are functions. It expects the MCP echo tool to exist and the local command tool to exist only where supported.

**Call relations**: It uses the MCP helper and parses the printed JSON. This test validates the combined tool namespace visible inside code mode.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_exposes_normalized_illegal_mcp_tool_names`  (lines 3115–3141)

```
async fn code_mode_exposes_normalized_illegal_mcp_tool_names() -> Result<()>
```

**Purpose**: Verifies that MCP tool names that are not legal JavaScript property names are normalized into callable names. This lets scripts call external tools even when their original names contain awkward characters.

**Data flow**: The test calls `tools.mcp__rmcp__echo_tool`, the normalized form of an MCP tool name, and prints the echo result. It expects the call to succeed.

**Call relations**: It uses the MCP helper. The test covers name translation before dispatching to the MCP server.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_lists_global_scope_items`  (lines 3144–3252)

```
async fn code_mode_lists_global_scope_items() -> Result<()>
```

**Purpose**: Checks which global names are visible inside the code-mode runtime. This prevents accidental leaks of unexpected globals and confirms intended helpers are present.

**Data flow**: The test prints all own property names on `globalThis`, parses them into a set, and compares every returned name against an allowed list. The allowed list includes JavaScript built-ins and Codex helpers such as `tools`, `text`, `image`, `store`, and `yield_control`.

**Call relations**: It uses the MCP helper so MCP tools are also part of the runtime environment. The test is a broad guardrail around the script sandbox's public surface.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert!, assert_ne!, skip_if_no_network!).


##### `code_mode_exports_all_tools_metadata_for_builtin_tools`  (lines 3255–3288)

```
async fn code_mode_exports_all_tools_metadata_for_builtin_tools() -> Result<()>
```

**Purpose**: Verifies that `ALL_TOOLS` includes rich metadata for built-in nested tools. This metadata helps code-mode scripts discover tools and understand their argument and return shapes.

**Data flow**: The test finds the `view_image` entry in `ALL_TOOLS`, prints it as JSON, and compares the name and description to the expected declaration text.

**Call relations**: It uses the standard helper and `custom_tool_output_last_non_empty_text` to parse the final JSON. This protects the documentation-like metadata presented to code.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_last_non_empty_text, run_code_mode_turn); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_exports_all_tools_metadata_for_namespaced_mcp_tools`  (lines 3291–3334)

```
async fn code_mode_exports_all_tools_metadata_for_namespaced_mcp_tools() -> Result<()>
```

**Purpose**: Checks that `ALL_TOOLS` also documents namespaced MCP tools. External tools should be discoverable in the same way as built-in tools.

**Data flow**: The test finds the `mcp__rmcp__echo` entry in `ALL_TOOLS`, prints it, and verifies the description includes server and tool descriptions plus a TypeScript-style declaration.

**Call relations**: It uses the MCP setup helper. The test ties MCP discovery metadata to code-mode's `ALL_TOOLS` global.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_last_non_empty_text, run_code_mode_turn_with_rmcp); 4 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!).


##### `code_mode_can_call_hidden_dynamic_tools`  (lines 3337–3502)

```
async fn code_mode_can_call_hidden_dynamic_tools() -> Result<()>
```

**Purpose**: Verifies that code mode can discover and call hidden dynamic tools through deferred tool-loading flow. Dynamic tools are tools supplied to a thread at runtime rather than fixed at startup.

**Data flow**: The test starts a thread with a hidden dynamic tool, runs code that finds it in `ALL_TOOLS` and calls it, waits for Codex to emit a dynamic tool call request, sends back a successful response, and checks the script output.

**Call relations**: This test uses lower-level thread submission rather than the simple helper because it must intercept and answer the dynamic tool request. It proves the full bridge from code-mode `tools` call to dynamic tool response.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, turn_permission_fields, custom_tool_output_body_and_success, custom_tool_output_last_non_empty_text, new); 10 external calls (default, new, assert!, assert_eq!, assert_ne!, wait_for_event, wait_for_event_match, from_str, skip_if_no_network!, vec!).


##### `code_mode_excludes_configured_nested_tool_namespaces`  (lines 3505–3594)

```
async fn code_mode_excludes_configured_nested_tool_namespaces() -> Result<()>
```

**Purpose**: Checks that configured namespaces can be excluded from code-mode nested tools while still being directly exposed in mixed mode. This gives configuration control over what code scripts may call.

**Data flow**: The test configures the `excluded` namespace, starts a thread with an excluded dynamic tool, and runs code that checks both the excluded tool and an allowed tool. It expects the excluded tool to be absent from `tools` and `ALL_TOOLS`, while `update_plan` remains available.

**Call relations**: It uses custom thread-with-tools setup and direct prompt tool-name inspection. The output reader confirms the code-mode nested namespace filter worked.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_body_and_success); 5 external calls (assert!, assert_eq!, assert_ne!, skip_if_no_network!, vec!).


##### `code_mode_can_print_content_only_mcp_tool_result_fields`  (lines 3597–3637)

```
async fn code_mode_can_print_content_only_mcp_tool_result_fields() -> Result<()>
```

**Purpose**: Checks that code mode can read an MCP result that has content but no structured content. Not every external tool returns machine-readable fields.

**Data flow**: The test calls an MCP scenario tool that returns text content only. It prints the first content item type and text, confirms structured content is null, and checks `isError` is false.

**Call relations**: It uses the standard MCP helper. This complements the structured-result test by covering content-only MCP responses.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_can_print_error_mcp_tool_result_fields`  (lines 3640–3676)

```
async fn code_mode_can_print_error_mcp_tool_result_fields() -> Result<()>
```

**Purpose**: Checks that MCP tool errors are returned to code mode as result objects that scripts can inspect. The script should see `isError` and error content rather than crashing unexpectedly.

**Data flow**: The test calls the MCP echo tool without a required message. It prints whether `isError` is true, how much content was returned, whether the message mentions the missing field, and whether structured content is null.

**Call relations**: It uses the MCP helper and output body reader. This defines the behavior of external tool validation errors inside code mode.

*Call graph*: calls 3 internal fn (start_mock_server, custom_tool_output_body_and_success, run_code_mode_turn_with_rmcp); 3 external calls (assert_eq!, assert_ne!, skip_if_no_network!).


##### `code_mode_can_store_and_load_values_across_turns`  (lines 3679–3769)

```
async fn code_mode_can_store_and_load_values_across_turns() -> Result<()>
```

**Purpose**: Verifies that code mode can persist values with `store` and retrieve them with `load` on a later turn. This gives scripts notebook-like memory across assistant steps.

**Data flow**: The first turn stores a JSON-like object and prints `stored`. The second turn loads the value, prints it as JSON, and the test parses it to confirm the full nested value survived.

**Call relations**: It uses manual mock setup for two separate turns. The common output helpers read both the immediate confirmation and the later stored value.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, custom_tool_output_body_and_success, custom_tool_output_last_non_empty_text); 5 external calls (assert_eq!, assert_ne!, from_str, skip_if_no_network!, vec!).


##### `code_mode_can_compare_elapsed_time_around_set_timeout`  (lines 3772–3816)

```
async fn code_mode_can_compare_elapsed_time_around_set_timeout() -> Result<()>
```

**Purpose**: Checks that time functions and timers behave consistently inside code mode. The script should be able to measure elapsed time around an awaited timeout.

**Data flow**: The test records `Date.now()`, waits 100 milliseconds with `setTimeout`, records the end time, and prints timing data as JSON. It parses the output and confirms the elapsed time is at least 100 milliseconds.

**Call relations**: It uses the standard code-mode helper and the last-non-empty-text helper to parse the final JSON. This is a practical runtime sanity check for asynchronous timing.

*Call graph*: calls 4 internal fn (start_mock_server, custom_tool_output_body_and_success, custom_tool_output_last_non_empty_text, run_code_mode_turn); 5 external calls (assert!, assert_eq!, assert_ne!, from_str, skip_if_no_network!).


### `core/tests/suite/items.rs`

`test` · `test run`

This is a test file, active only on non-Windows systems, that protects the event stream seen by clients of Codex. In Codex, a conversation turn is reported as a sequence of events: an item starts, content may stream in piece by piece, and the item completes. If this contract changes by accident, user interfaces could show missing messages, duplicate content, wrong IDs, or leaked hidden plan text.

Each test starts a fake server that pretends to be the model API. The test feeds Codex a planned sequence of server-sent events, which are streaming messages sent over a long-lived HTTP response. Then it submits a user turn and waits for Codex to emit its own protocol events. The assertions compare what Codex emitted with what a client would need to render the conversation correctly.

The file covers ordinary messages, reasoning summaries, raw reasoning when enabled, web search calls, image generation calls, and special “plan mode” behavior. Plan mode is important because the model may include a proposed plan inside special tags. Codex must pull that plan out into a separate plan item, remove it from the normal assistant message, and strip citation tags even when those tags are split across streaming chunks. The tests act like a checklist at an airport gate: every event must have the right ID, timing shape, text, and final state before the turn is considered safe to show.

#### Function details

##### `disabled_plan_turn`  (lines 47–72)

```
fn disabled_plan_turn(
    text: &str,
    _model: String,
    collaboration_mode: CollaborationMode,
) -> anyhow::Result<Op>
```

**Purpose**: Builds a user-input operation for tests that need Codex to run in plan mode with permissions deliberately turned off. This gives the plan-mode tests a consistent, low-risk setup.

**Data flow**: It takes the user text, an unused model string, and a collaboration mode. It reads the current working directory, builds local environment and permission settings from it, wraps the text as user input, and returns an operation ready to submit to Codex.

**Call relations**: The plan-mode tests call this helper before submitting a turn. It hands them a prebuilt request so those tests can focus on whether plan text is extracted and streamed correctly, rather than repeating setup code.

*Call graph*: calls 2 internal fn (local_selections, turn_permission_fields); called by 5 (plan_mode_emits_plan_item_from_proposed_plan_block, plan_mode_handles_missing_plan_close_tag, plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done, plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed, plan_mode_strips_plan_from_agent_messages); 4 external calls (default, Ok, current_dir, vec!).


##### `image_generation_artifact_path`  (lines 74–96)

```
fn image_generation_artifact_path(codex_home: &Path, session_id: &str, call_id: &str) -> PathBuf
```

**Purpose**: Predicts where Codex should save a generated image during an image-generation test. It also cleans unsafe characters out of the session ID and call ID so they are safe to use as folder and file names.

**Data flow**: It receives the Codex home folder, a session ID, and an image-generation call ID. It turns the IDs into filesystem-safe strings, then returns a path like a generated-images folder, then the session folder, then a PNG file for the call.

**Call relations**: The image-generation tests use this before running Codex so they know exactly which file should appear, or should not appear, after the mocked image result is processed.

*Call graph*: called by 2 (image_generation_call_event_is_emitted, image_generation_call_event_is_emitted_when_image_save_fails); 2 external calls (join, format!).


##### `user_message_item_is_emitted`  (lines 99–157)

```
async fn user_message_item_is_emitted() -> anyhow::Result<()>
```

**Purpose**: Checks that when a user submits text, Codex emits a modern user-message item as both started and completed, while still emitting the older user-message event for compatibility.

**Data flow**: The test prepares a fake completed model response, submits user text with a marked text range, then listens to Codex events. It verifies that the started and completed user-message items share the same ID and content, and that the legacy event carries the same plain message and text metadata.

**Call relations**: This test drives Codex through the normal submit path using the mock server. It waits for item events and the legacy event to prove that both the newer item-based protocol and the older event shape stay in sync.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, Ok, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `assistant_message_item_is_emitted`  (lines 160–212)

```
async fn assistant_message_item_is_emitted() -> anyhow::Result<()>
```

**Purpose**: Checks that an assistant message from the model becomes an agent-message item in Codex’s event stream. This protects the basic path where the model replies with final text.

**Data flow**: The test makes the fake server stream an assistant message saying “all done.” After submitting a user request, it waits for the agent-message item to start and complete, then confirms the completed content contains that text and uses the same item ID.

**Call relations**: The test sits between the mocked model response and Codex’s public events. It proves that Codex converts a finished assistant response into the item lifecycle that clients expect.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (default, Ok, assert_eq!, wait_for_event_match, panic!, skip_if_no_network!, vec!).


##### `reasoning_item_is_emitted`  (lines 215–276)

```
async fn reasoning_item_is_emitted() -> anyhow::Result<()>
```

**Purpose**: Checks that model reasoning is exposed as a reasoning item with both summary text and raw reasoning content where appropriate. This matters for clients that display a concise explanation of the model’s thought process.

**Data flow**: The fake server sends one reasoning item with summary lines and a raw trace. The test submits a prompt, waits for reasoning start and completion events, then checks that the final reasoning item contains the expected summary and raw content.

**Call relations**: This test uses a canned reasoning response and observes Codex’s item events. It ensures the internal model response shape is translated into a stable reasoning item for downstream consumers.

*Call graph*: calls 5 internal fn (ev_reasoning_item, mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, Ok, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `web_search_item_is_emitted`  (lines 279–348)

```
async fn web_search_item_is_emitted() -> anyhow::Result<()>
```

**Purpose**: Checks that a web search call from the model is reported as a started and completed web-search item, with the search query preserved.

**Data flow**: The test feeds Codex a mocked web-search start and finish from the server. It submits a user request, then verifies the web-search begin event, item IDs, timestamps, and final search action containing the query “weather seattle.”

**Call relations**: The fake model stream triggers Codex’s web-search reporting path. The test confirms that the older web-search begin event and the item-based lifecycle describe the same call.

*Call graph*: calls 6 internal fn (ev_web_search_call_added_partial, ev_web_search_call_done, mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (default, Ok, assert!, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `image_generation_call_event_is_emitted`  (lines 351–436)

```
async fn image_generation_call_event_is_emitted() -> anyhow::Result<()>
```

**Purpose**: Checks that a successful image-generation result is announced to clients and saved to disk. This protects both the visible event stream and the generated image artifact.

**Data flow**: The test computes the expected output path, removes any old file there, and makes the fake server return a completed image-generation call with base64 image data. After submission, it checks the begin and end events, the item lifecycle, the revised prompt, the saved path, and the actual bytes written to the file.

**Call relations**: It uses the path helper to know where Codex should save the image, then drives the mocked image response through Codex. The resulting events and file contents prove that the image-generation pipeline finished correctly.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, image_generation_artifact_path); 8 external calls (default, Ok, assert!, assert_eq!, wait_for_event_match, skip_if_no_network!, remove_file, vec!).


##### `image_generation_call_event_is_emitted_when_image_save_fails`  (lines 439–497)

```
async fn image_generation_call_event_is_emitted_when_image_save_fails() -> anyhow::Result<()>
```

**Purpose**: Checks that Codex still emits image-generation completion information even when the image payload cannot be saved as a file. This prevents a bad image payload from hiding the whole event from clients.

**Data flow**: The test predicts the path where a file would be saved, then sends an image-generation result with invalid base64 data. It verifies that Codex reports the call ID, status, prompt, and raw result, but leaves the saved path empty and does not create a file.

**Call relations**: This is the failure-case partner to the successful image-save test. It confirms that Codex separates reporting the model’s image result from the optional disk-save step.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, image_generation_artifact_path); 8 external calls (default, Ok, assert!, assert_eq!, wait_for_event_match, skip_if_no_network!, remove_file, vec!).


##### `agent_message_content_delta_has_item_metadata`  (lines 500–565)

```
async fn agent_message_content_delta_has_item_metadata() -> anyhow::Result<()>
```

**Purpose**: Checks that streamed assistant text chunks include enough metadata to identify the thread, turn, and item they belong to. Without this, a client could not reliably attach streaming text to the right message.

**Data flow**: The fake server streams an assistant item and a text delta. The test submits a request, captures the started agent item, then checks that the streamed content delta carries the same turn and item identity, plus the expected text.

**Call relations**: This test watches the streaming path rather than only the final message. It connects the item-start event to the later delta event to ensure clients can assemble streamed messages correctly.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, Ok, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `plan_mode_emits_plan_item_from_proposed_plan_block`  (lines 568–630)

```
async fn plan_mode_emits_plan_item_from_proposed_plan_block() -> anyhow::Result<()>
```

**Purpose**: Checks that in plan mode, text inside a special proposed-plan block becomes a separate plan item. This lets clients display the plan distinctly from the assistant’s ordinary message.

**Data flow**: The fake server sends an assistant message containing intro text, a tagged proposed plan, and outro text. The test submits a plan-mode turn and then verifies that Codex emits a plan delta and completed plan item containing only the plan steps.

**Call relations**: It uses the plan-turn helper to enter plan mode, then observes the plan-specific events. The test proves that Codex recognizes the plan tags and turns their contents into a dedicated item.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_plan_turn); 6 external calls (Ok, assert_eq!, wait_for_event_match, format!, skip_if_no_network!, vec!).


##### `plan_mode_strips_plan_from_agent_messages`  (lines 633–717)

```
async fn plan_mode_strips_plan_from_agent_messages() -> anyhow::Result<()>
```

**Purpose**: Checks that the proposed plan is removed from the normal assistant message in plan mode. This prevents clients from showing the same plan twice: once as a plan and once inside the assistant text.

**Data flow**: The test streams a message with intro text, a proposed-plan block, and outro text. It collects assistant text deltas, the plan delta, and completed items, then verifies the assistant message is only “Intro\nOutro” while the plan item contains the plan steps.

**Call relations**: This test follows both branches created by plan parsing: ordinary assistant text and extracted plan text. It confirms Codex sends each piece to the correct public event stream.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_plan_turn); 7 external calls (new, Ok, assert_eq!, wait_for_event, format!, skip_if_no_network!, vec!).


##### `plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done`  (lines 720–897)

```
async fn plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done() -> anyhow::Result<()>
```

**Purpose**: Checks a difficult streaming case: memory citation tags and proposed-plan tags are split across several chunks, but Codex still removes citations and separates plan text correctly.

**Data flow**: The fake response begins with partial text, then sends several deltas that split citation tags and plan tags across chunk boundaries. The test records event order and all streamed text, then confirms assistant text, plan text, and final completed items contain no citation markup and have the expected clean content.

**Call relations**: This is a stress test for the streaming parser. It proves that Codex does not need tags to arrive neatly in one piece, and that item start, delta, completion, and turn completion events happen in a sensible order.

*Call graph*: calls 8 internal fn (ev_assistant_message, ev_completed, ev_output_text_delta, mount_sse_once, sse, start_mock_server, test_codex, disabled_plan_turn); 8 external calls (new, Ok, assert!, assert_eq!, wait_for_event, format!, skip_if_no_network!, vec!).


##### `plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed`  (lines 900–1005)

```
async fn plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed() -> anyhow::Result<()>
```

**Purpose**: Checks that Codex can detect a proposed-plan tag even when the opening tag is split between the initial message content and a later streamed delta.

**Data flow**: The fake server sends “<proposed” in the initially added message text and “_plan>” in the next delta, followed by plan content and normal outro text. The test collects assistant and plan events until the turn completes, then verifies that the assistant text excludes the plan and the plan item contains the plan step.

**Call relations**: This test focuses on a boundary case in the same plan-mode parser used by the other plan tests. It makes sure parsing works across the seam between an item-added event and later text deltas.

*Call graph*: calls 8 internal fn (ev_assistant_message, ev_completed, ev_output_text_delta, mount_sse_once, sse, start_mock_server, test_codex, disabled_plan_turn); 7 external calls (new, Ok, assert_eq!, wait_for_event, format!, skip_if_no_network!, vec!).


##### `plan_mode_handles_missing_plan_close_tag`  (lines 1008–1085)

```
async fn plan_mode_handles_missing_plan_close_tag() -> anyhow::Result<()>
```

**Purpose**: Checks that Codex still produces a plan item when the model starts a proposed-plan block but never sends the closing tag. This makes plan mode more forgiving of incomplete model output.

**Data flow**: The fake server sends intro text followed by an opening proposed-plan tag and one plan step, with no closing tag. The test waits for plan and assistant completions, then verifies the plan contains the step and the assistant message contains only the intro.

**Call relations**: This test uses the same disabled plan-mode turn setup as the other plan tests. It checks the parser’s fallback behavior when the stream ends while still inside a plan block.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_plan_turn); 5 external calls (Ok, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `reasoning_content_delta_has_item_metadata`  (lines 1088–1135)

```
async fn reasoning_content_delta_has_item_metadata() -> anyhow::Result<()>
```

**Purpose**: Checks that streamed reasoning summary text includes the reasoning item ID. This lets a client attach incremental reasoning updates to the correct reasoning block.

**Data flow**: The fake server starts a reasoning item, streams a summary delta, then completes the reasoning item. The test captures the started reasoning item and confirms the later reasoning-content delta has the same item ID and the expected text.

**Call relations**: This test connects the reasoning item lifecycle with the streaming summary event. It ensures consumers can build the reasoning display progressively and accurately.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, Ok, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `reasoning_raw_content_delta_respects_flag`  (lines 1138–1190)

```
async fn reasoning_raw_content_delta_respects_flag() -> anyhow::Result<()>
```

**Purpose**: Checks that raw reasoning deltas are emitted only when the configuration allows raw agent reasoning to be shown. In this test, the flag is turned on, so the raw detail should appear.

**Data flow**: The test builds Codex with raw reasoning display enabled, then the fake server streams a raw reasoning text delta. After submitting a prompt, it captures the reasoning item and verifies the raw-content delta uses that item ID and contains “raw detail.”

**Call relations**: This test exercises the same reasoning stream as the summary-delta test, but with a configuration switch enabled. It proves that Codex honors the setting and still attaches raw reasoning to the correct item.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, Ok, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


### `core/tests/suite/user_shell_cmd.rs`

`test` · `test run`

This test file acts like a safety checklist for user-run shell commands. A shell is the command-line program that runs commands such as `ls`, `cat`, or `seq`. Codex has two different kinds of shell activity: commands requested by the model, and commands explicitly requested by the user. These tests make sure the user version behaves like a side task, not like a normal AI turn that can replace or interrupt the conversation.

The tests create temporary conversations using a mock server instead of a real model service. They submit operations to Codex, then watch the event stream for messages such as “command started,” “command produced output,” “command ended,” “turn completed,” or “turn aborted.” This is similar to sending a package through a delivery system and checking every tracking update.

The file covers practical behavior: commands run in the configured working directory; an unavailable local shell gives a clear error; a long command can be interrupted; a user command can run while the model is already doing work; command history is saved and sent to the model on the next turn; sandbox-related environment variables are not wrongly added; and very large command output is shortened before being stored so later prompts do not become too large. Without these tests, small changes could accidentally make user shell commands unsafe, disruptive, or confusing to the model.

#### Function details

##### `user_shell_cmd_ls_and_cat_in_temp_dir`  (lines 39–101)

```
async fn user_shell_cmd_ls_and_cat_in_temp_dir()
```

**Purpose**: This test proves that a user shell command runs inside the configured working directory. It creates a temporary folder with a known file, runs `ls`, then runs `cat` on that file and checks that the output is exactly what was written.

**Data flow**: The test starts with a fresh temporary directory and writes `hello.txt` into it. It builds a Codex test conversation whose current working directory points at that temporary directory, then submits two user shell commands. It reads command-finished events from Codex and checks that the first output includes the file name, and the second output matches the file contents, with Windows line endings normalized before comparison.

**Call relations**: The async test runner calls this test. Inside it, the mock server and test Codex builder create an isolated conversation, and `wait_for_event` is used to listen until Codex reports that each shell command has ended. The assertions then confirm that Codex passed the command through to the real local shell in the expected directory.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 8 external calls (new, assert!, assert_eq!, cfg!, wait_for_event, format!, write, unreachable!).


##### `user_shell_command_without_local_environment_emits_error`  (lines 104–135)

```
async fn user_shell_command_without_local_environment_emits_error() -> anyhow::Result<()>
```

**Purpose**: This test checks the failure path when the session has no local environment available for shell commands. Instead of silently doing nothing or crashing, Codex should tell the user that the shell is unavailable.

**Data flow**: The test creates a Codex conversation, then changes the thread settings so there are no selected local environments. It submits `echo shell` as a user shell command. Codex emits an error event, and the test checks that the message is exactly `shell is unavailable in this session` and that no extra structured error information is attached.

**Call relations**: The test runner starts the function, which uses `submit_thread_settings` to put the conversation into a no-local-shell state. After submitting the command, it waits for an error event from Codex and verifies the user-facing message.

*Call graph*: calls 3 internal fn (start_mock_server, test_codex, new); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, unreachable!, vec!).


##### `user_shell_cmd_can_be_interrupted`  (lines 138–176)

```
async fn user_shell_cmd_can_be_interrupted()
```

**Purpose**: This test proves that a long-running user shell command can be stopped by an interrupt. That matters because users need a way out if they accidentally start a command that hangs or takes too long.

**Data flow**: The test starts a conversation, submits a command that sleeps for several seconds, and waits until Codex announces that the user shell command has begun. It then sends an interrupt operation. The expected result is a `TurnAborted` event whose reason says the work was interrupted.

**Call relations**: The test runner calls this async test. The test uses the mock server and Codex fixture to start a controlled session, uses `wait_for_event_match` to catch the exact command-start event for a user shell command, then submits `Interrupt` and waits with a timeout for the abort notification.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 5 external calls (from_secs, assert_eq!, wait_for_event_match, wait_for_event_with_timeout, unreachable!).


##### `user_shell_command_does_not_replace_active_turn`  (lines 179–298)

```
async fn user_shell_command_does_not_replace_active_turn() -> anyhow::Result<()>
```

**Purpose**: This test checks that a user shell command does not cancel or replace an AI turn that is already in progress. In plain terms, if the model is busy running its own shell command, the user can still run a separate shell command without knocking the model off course.

**Data flow**: The test sets up mock model responses that cause the model to request a shell command, then later finish with an assistant message. It submits user input to start that model turn, waits until the model-requested shell command begins, and then submits a separate user shell command. It watches events until the turn completes, recording whether the user command ended and whether any `Replaced` abort occurred. The desired result is that the model turn completes, the user command finishes, and no replacement abort is seen.

**Call relations**: The test runner invokes this multi-threaded async test because two flows need to overlap. The test uses mocked server-sent events, which are one-way streamed model responses, to drive the agent shell command. It then injects a user shell command during that active turn and confirms through Codex events and mock request counts that the original model flow continued to its follow-up request.

*Call graph*: calls 6 internal fn (mount_sse_sequence, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); 9 external calls (default, from_secs, assert!, assert_eq!, cfg!, wait_for_event_match, json!, timeout, vec!).


##### `user_shell_command_history_is_persisted_and_shared_with_model`  (lines 301–381)

```
async fn user_shell_command_history_is_persisted_and_shared_with_model() -> anyhow::Result<()>
```

**Purpose**: This test verifies that a completed user shell command is saved into conversation history and included in the next model request. This lets the model understand what the user ran and what happened, without requiring the user to paste the output manually.

**Data flow**: The test disables shell snapshots to make the expected command text easier to match. It runs a command that prints the `CODEX_SANDBOX` environment variable or `not-set` if it is absent. It checks the begin event, the streamed output chunk, and the final command result. After the command’s turn completes, it submits a follow-up user message and inspects the mock model request. The output should contain a structured `<user_shell_command>` block with the command, exit code, duration, and output.

**Call relations**: This test is driven by the async test runner. It first talks directly to Codex by submitting a user shell command and waiting for command events. Then it mounts a mock model response and submits a follow-up turn, using the captured request to confirm that Codex handed the saved shell-command history to the model in the next prompt.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 10 external calls (from_utf8, assert!, assert_eq!, assert_regex_match, wait_for_event, wait_for_event_match, format!, escape, split, vec!).


##### `user_shell_command_does_not_set_network_sandbox_env_var`  (lines 384–426)

```
async fn user_shell_command_does_not_set_network_sandbox_env_var() -> anyhow::Result<()>
```

**Purpose**: This test checks that user shell commands do not receive the environment variable that says network access is disabled, even when the session permission profile has restricted networking. That distinction matters because user-run commands are treated differently from sandboxed model-run commands.

**Data flow**: The test configures permissions so the network sandbox policy is restricted. It then runs a user shell command that prints `CODEX_SANDBOX_NETWORK_DISABLED` if present, or `not-set` if absent. Codex returns a command-end event. The test checks that the command succeeded and that the printed value is `not-set`.

**Call relations**: The test runner starts the function, which builds a Codex fixture with custom permission settings. After submitting the command, it waits for the command-end event and uses that event to verify both successful execution and the absence of the network-sandbox environment flag.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 2 external calls (assert_eq!, wait_for_event_match).


##### `user_shell_command_output_is_truncated_in_history`  (lines 430–490)

```
async fn user_shell_command_output_is_truncated_in_history() -> anyhow::Result<()>
```

**Purpose**: This test makes sure very large user shell output is shortened before it is stored in history and sent to the model. This protects later model requests from being flooded with hundreds of lines of command output.

**Data flow**: The test sets a small tool output token limit, runs a command that prints many numbered lines, and waits for the command to finish successfully. After the shell turn completes, it submits a follow-up message and inspects the mock model request. The expected history contains the command plus a shortened output block: a warning, total line count, the beginning of the output, a truncation marker, and the end of the output.

**Call relations**: The async test runner calls this test. The test uses Codex events to confirm the large-output command completed, then uses a mocked model response for the next turn. By examining the request sent to the mock server, it checks the handoff from shell-command history storage to model prompt construction.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 7 external calls (assert_eq!, assert_regex_match, wait_for_event, wait_for_event_match, format!, escape, vec!).


##### `user_shell_command_is_truncated_only_once`  (lines 493–554)

```
async fn user_shell_command_is_truncated_only_once() -> anyhow::Result<()>
```

**Purpose**: This test guards against double truncation of large shell output. If output is shortened once, Codex should not later wrap it in another truncation warning, because that would make the model context confusing and waste space.

**Data flow**: The test skips itself if network-dependent test support is unavailable. It configures a small output token limit and mocks a model response that asks for a shell command producing a very large amount of output. Codex runs that command and then sends the command result back to the model in a follow-up request. The test extracts the function-call output text and counts the truncation headers. The expected count is exactly one.

**Call relations**: The test runner invokes this multi-threaded async test. Mock server responses first make the model request a shell command, then accept the follow-up result. The test inspects the second mock request to ensure the output passed from command execution into model feedback was shortened once, not repeatedly.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (assert_eq!, cfg!, json!, skip_if_no_network!, vec!).


### `core/tests/suite/view_image.rs`

`test` · `test run`

This is a non-Windows test file for Codex’s image input path. In everyday terms, it makes sure that when a user or the model says “look at this image,” Codex sends the right image data to the model and does not send unsafe or unusable data. The tests set up a fake model server, create small temporary files and PNG images, run a Codex turn, then inspect the outgoing request that Codex would have sent to the real service. They check two main paths. First, a user can attach a local image directly. Second, the model can call a `view_image` tool, which reads an image file and returns it as an `input_image` item. The file also covers edge cases: large images should be resized unless original detail is explicitly supported and requested; missing files, folders, and non-image files should produce readable errors; sandbox deny rules should prevent reading blocked files; text-only models should reject image viewing; and multi-environment sessions should read from the selected local or remote environment. Think of this file as a safety and quality checklist for the image conveyor belt: it confirms the image is picked up from the right place, transformed to the right size, packed in the right format, or rejected with a useful label.

#### Function details

##### `disabled_user_turn`  (lines 76–99)

```
fn disabled_user_turn(test: &TestCodex, items: Vec<UserInput>, model: String) -> Op
```

**Purpose**: Builds a test user-turn operation with approvals and sandboxing effectively turned off. Tests use it when they want to focus on image behavior, not permission prompts.

**Data flow**: It receives a test harness, a list of user inputs, and a model name. It reads the test working directory, asks `turn_permission_fields` for a disabled permission setup, then returns an `Op::UserInput` containing the inputs plus thread settings such as “never ask for approval” and the requested model.

**Call relations**: Most tests in this file call this helper before submitting work to Codex. It hides the repeated setup so the individual tests can concentrate on what image data is sent back to the mock server.

*Call graph*: calls 1 internal fn (turn_permission_fields); called by 13 (assert_user_turn_local_image_resizes_to, replaces_invalid_local_image_after_bad_request, resize_all_images_turns_invalid_view_image_into_placeholder, view_image_tool_attaches_local_image, view_image_tool_can_preserve_original_resolution_when_requested_on_gpt5_3_codex, view_image_tool_does_not_force_original_resolution_with_capability_only, view_image_tool_errors_clearly_for_unsupported_detail_values, view_image_tool_errors_for_non_image_files, view_image_tool_errors_when_file_missing, view_image_tool_errors_when_path_is_directory (+3 more)); 1 external calls (default).


##### `image_messages`  (lines 101–122)

```
fn image_messages(body: &Value) -> Vec<&Value>
```

**Purpose**: Finds message entries in a JSON request body that contain an image input. This lets tests ask, “Did Codex send an image as a normal message?”

**Data flow**: It takes a JSON body, looks under its `input` array, filters for items of type `message`, and keeps only those whose content includes an `input_image` span. It returns the matching JSON values, or an empty list if there are none.

**Call relations**: It is the lower-level scanner used by `find_image_message`. Tests rely on that wrapper when checking whether an image was or was not injected into the request.

*Call graph*: called by 1 (find_image_message); 1 external calls (get).


##### `find_image_message`  (lines 124–126)

```
fn find_image_message(body: &Value) -> Option<&Value>
```

**Purpose**: Returns the first image-containing message from a request body. It is a convenience helper for tests that only expect at most one such message.

**Data flow**: It receives a JSON request body, calls `image_messages` to gather all message items containing `input_image`, and returns the first one if present.

**Call relations**: The resize assertion helper calls this after the mock server captures a request. That flow uses it to locate the encoded image and measure the decoded result.

*Call graph*: calls 1 internal fn (image_messages); called by 1 (assert_user_turn_local_image_resizes_to).


##### `png_bytes`  (lines 128–133)

```
fn png_bytes(width: u32, height: u32, rgba: [u8; 4]) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Creates an in-memory PNG image of a single color. Tests use it to make predictable image files without needing checked-in image fixtures.

**Data flow**: It receives a width, height, and RGBA color. It builds an image buffer filled with that color, writes it as PNG bytes into memory, and returns those bytes or an error.

**Call relations**: File-writing helpers and several environment-routing tests call this when they need a valid image. The resulting bytes are then written into the test workspace or remote filesystem.

*Call graph*: calls 1 internal fn (new); called by 4 (view_image_routes_to_selected_local_environment, view_image_routes_to_selected_remote_environment, view_image_tool_applies_local_sandbox_read_denies, write_workspace_png); 4 external calls (ImageRgba8, from_pixel, new, Rgba).


##### `create_workspace_directory`  (lines 135–146)

```
async fn create_workspace_directory(test: &TestCodex, rel_path: &str) -> anyhow::Result<PathBuf>
```

**Purpose**: Creates a directory inside the test workspace through Codex’s filesystem layer. This is used to test what happens when `view_image` is pointed at a folder instead of a file.

**Data flow**: It receives the test harness and a relative path. It joins that path to the test working directory, converts it to a path URI, creates the directory recursively, and returns the absolute path.

**Call relations**: `view_image_tool_errors_when_path_is_directory` calls this to prepare the bad input. The test then verifies that the tool reports “not a file” rather than trying to treat the directory as an image.

*Call graph*: calls 2 internal fn (fs, from_path); called by 1 (view_image_tool_errors_when_path_is_directory).


##### `write_workspace_file`  (lines 148–169)

```
async fn write_workspace_file(
    test: &TestCodex,
    rel_path: &str,
    contents: Vec<u8>,
) -> anyhow::Result<PathBuf>
```

**Purpose**: Writes arbitrary bytes to a file in the test workspace, creating parent folders first. It is the general-purpose setup helper for image and non-image test files.

**Data flow**: It receives the test harness, a relative file path, and byte contents. It creates any missing parent directory through the filesystem API, writes the bytes to the target path, and returns the absolute path.

**Call relations**: Many tests call this directly for JSON or raw files, and `write_workspace_png` builds on it for PNGs. It keeps test setup consistent whether the filesystem is local or supplied by the test environment.

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

**Purpose**: Creates a solid-color PNG file inside the test workspace. It saves tests from repeating image generation and file writing steps.

**Data flow**: It receives a test harness, relative path, dimensions, and a color. It calls `png_bytes` to generate PNG data, then calls `write_workspace_file` to put that data in the workspace, returning the final absolute path.

**Call relations**: Most tests that need a valid image call this helper. It connects the image-making helper with the workspace-writing helper so each test can focus on the behavior being checked.

*Call graph*: calls 2 internal fn (png_bytes, write_workspace_file); called by 8 (replaces_invalid_local_image_after_bad_request, view_image_tool_attaches_local_image, view_image_tool_can_preserve_original_resolution_when_requested_on_gpt5_3_codex, view_image_tool_does_not_force_original_resolution_with_capability_only, view_image_tool_errors_clearly_for_unsupported_detail_values, view_image_tool_resizes_when_model_lacks_original_detail_support, view_image_tool_returns_unsupported_message_for_text_only_model, view_image_tool_treats_null_detail_as_omitted).


##### `assert_user_turn_local_image_resizes_to`  (lines 181–264)

```
async fn assert_user_turn_local_image_resizes_to(
    original_dimensions: (u32, u32),
    expected_dimensions: (u32, u32),
    resize_policy: TestImageResizePolicy,
) -> anyhow::Result<()>
```

**Purpose**: Checks that a direct user-attached local image is resized to an expected size before being sent to the model. It is shared by several image-resizing tests.

**Data flow**: It receives original dimensions, expected dimensions, and a resize policy. It starts a mock server, builds a test Codex instance, creates a temporary PNG, submits it as a local image input, waits for the turn to finish, extracts the base64 image from the captured request, decodes it, loads it as an image, and compares its dimensions to the expected result.

**Call relations**: The three direct-local-image resize tests call this helper with different dimensions or feature settings. Inside, it uses `disabled_user_turn` to submit the image and `find_image_message` to inspect what Codex sent.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, find_image_message); called by 3 (resize_all_images_applies_patch_budget_to_local_user_image, user_turn_with_local_image_attaches_image, user_turn_with_vertical_local_image_resizes_to_square_bounds); 7 external calls (from_pixel, assert_eq!, wait_for_event_with_timeout, Rgba, load_from_memory, tempdir, vec!).


##### `user_turn_with_local_image_attaches_image`  (lines 273–278)

```
async fn user_turn_with_local_image_attaches_image() -> anyhow::Result<()>
```

**Purpose**: Verifies that a wide local image attached by the user is included in the model request and resized under the legacy policy. This protects the basic “upload an image with your prompt” path.

**Data flow**: It skips if networking is unavailable, then asks `assert_user_turn_local_image_resizes_to` to test a 2304×864 image and confirm it becomes 2048×768.

**Call relations**: This is a top-level test. It delegates the actual server setup, turn submission, request inspection, decoding, and size check to `assert_user_turn_local_image_resizes_to`.

*Call graph*: calls 1 internal fn (assert_user_turn_local_image_resizes_to); 1 external calls (skip_if_no_network!).


##### `user_turn_with_vertical_local_image_resizes_to_square_bounds`  (lines 281–290)

```
async fn user_turn_with_vertical_local_image_resizes_to_square_bounds() -> anyhow::Result<()>
```

**Purpose**: Verifies that a very tall user-attached image is resized correctly. This guards against resize logic that only works for wide images.

**Data flow**: It skips if networking is unavailable, then calls the shared resize helper with a 1024×4096 image and expects a 512×2048 result.

**Call relations**: This top-level test uses `assert_user_turn_local_image_resizes_to` as its test engine. Its role is to supply a portrait-shaped image case.

*Call graph*: calls 1 internal fn (assert_user_turn_local_image_resizes_to); 1 external calls (skip_if_no_network!).


##### `resize_all_images_applies_patch_budget_to_local_user_image`  (lines 293–302)

```
async fn resize_all_images_applies_patch_budget_to_local_user_image() -> anyhow::Result<()>
```

**Purpose**: Checks the newer “resize all images” feature path for a direct user image. It confirms that this feature applies a stricter size budget than the legacy behavior.

**Data flow**: It skips if networking is unavailable, then calls the shared resize helper with a 2048×2048 image, expecting it to be reduced to 1600×1600 when the `ResizeAllImages` feature is enabled.

**Call relations**: This test drives `assert_user_turn_local_image_resizes_to` with the `AllImages` policy, which turns on the feature in the test configuration before submitting the image.

*Call graph*: calls 1 internal fn (assert_user_turn_local_image_resizes_to); 1 external calls (skip_if_no_network!).


##### `view_image_tool_attaches_local_image`  (lines 305–450)

```
async fn view_image_tool_attaches_local_image() -> anyhow::Result<()>
```

**Purpose**: Tests the main `view_image` tool success path for a local workspace image. It makes sure the tool returns the image as tool output, not as an extra user message.

**Data flow**: It creates a mock server and a test workspace PNG, then has the fake model call `view_image` with that path. After Codex processes the tool call and sends the next request, the test checks emitted image-view events, confirms no separate image message was injected, reads the tool output content item, decodes the base64 PNG, and verifies the resized dimensions.

**Call relations**: This top-level test uses `write_workspace_png` for setup and `disabled_user_turn` to start the conversation. The mock server first requests the tool call, then receives the tool result that the test inspects.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 8 external calls (assert!, assert_eq!, wait_for_event_with_timeout, load_from_memory, panic!, json!, skip_if_no_network!, vec!).


##### `view_image_routes_to_selected_local_environment`  (lines 453–516)

```
async fn view_image_routes_to_selected_local_environment() -> anyhow::Result<()>
```

**Purpose**: Verifies that when a `view_image` tool call names the local environment, Codex reads the image from that local environment. This matters in sessions that may have more than one filesystem available.

**Data flow**: It creates a local PNG in the test workspace, sets up a mock model response that calls `view_image` with the local environment ID, submits a turn with a local environment selection, then checks that the final tool output contains a base64 PNG image URL.

**Call relations**: This test uses `png_bytes` and `write_workspace_file` to prepare the image and `mount_sse_sequence` to script the two model responses. It verifies the environment-routing path rather than the image resizing details.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, png_bytes, write_workspace_file); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `view_image_tool_applies_local_sandbox_read_denies`  (lines 519–592)

```
async fn view_image_tool_applies_local_sandbox_read_denies() -> anyhow::Result<()>
```

**Purpose**: Checks that filesystem sandbox rules are honored when `view_image` tries to read a local file. A sandbox is a safety boundary that says which files a tool may access.

**Data flow**: It writes a valid PNG, creates a sandbox policy that denies access to that exact path, submits a turn using that permission profile, then inspects the tool output. The expected result is no image attachment and an error message saying the image could not be located or read.

**Call relations**: This test prepares bytes with `png_bytes`, writes them with `write_workspace_file`, and builds a permission profile from the deny policy. The model’s tool call is supplied by the mock server sequence, and the final request is inspected for the error.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, test_codex, png_bytes, write_workspace_file, from_runtime_permissions, default); 4 external calls (assert!, format!, skip_if_no_network!, vec!).


##### `view_image_routes_to_selected_remote_environment`  (lines 595–695)

```
async fn view_image_routes_to_selected_remote_environment() -> anyhow::Result<()>
```

**Purpose**: Verifies that `view_image` can read from a selected remote environment instead of accidentally using a local file with the same name. This protects multi-environment sessions from mixing up file locations.

**Data flow**: It skips when remote testing is unavailable, creates a misleading local file, creates a real PNG in a remote working directory, submits a turn with both local and remote selections, then checks that the tool output includes a base64 image from the remote path. It cleans up the remote directory afterward.

**Call relations**: This test uses `local`, path URI helpers, filesystem create/write/remove calls, and `png_bytes` to build the local-versus-remote setup. The mock model calls `view_image` with the remote environment ID, and the test confirms Codex follows that selection.

*Call graph*: calls 7 internal fn (mount_sse_sequence, start_mock_server, local, test_codex, png_bytes, from_abs_path, from_path); 10 external calls (from, new, assert!, assert_eq!, get_remote_test_env, format!, write, skip_if_no_network!, skip_if_wine_exec!, vec!).


##### `view_image_tool_can_preserve_original_resolution_when_requested_on_gpt5_3_codex`  (lines 698–787)

```
async fn view_image_tool_can_preserve_original_resolution_when_requested_on_gpt5_3_codex() -> anyhow::Result<()>
```

**Purpose**: Checks that a model with original-detail support can request an image at its original resolution. This ensures high-fidelity image viewing works when explicitly asked for.

**Data flow**: It builds a test using the `gpt-5.3-codex` model, writes a large PNG, has the mock model call `view_image` with `detail: original`, waits for completion, then decodes the returned image and confirms its dimensions match the original file.

**Call relations**: The test uses `write_workspace_png` for setup and `disabled_user_turn` to start the turn. The mock server drives the tool call, and the second captured request contains the tool output that is measured.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (assert_eq!, wait_for_event_with_timeout, load_from_memory, json!, skip_if_no_network!, vec!).


##### `view_image_tool_errors_clearly_for_unsupported_detail_values`  (lines 790–865)

```
async fn view_image_tool_errors_clearly_for_unsupported_detail_values() -> anyhow::Result<()>
```

**Purpose**: Verifies that unsupported `detail` values produce a clear error instead of silently doing something surprising. Here, `detail` is an option that controls image quality or resolution.

**Data flow**: It writes a valid image, has the mock model call `view_image` with `detail: low`, waits for the turn to finish, then checks that the tool output says only `high` and `original` are supported and that no image was attached.

**Call relations**: This test uses `write_workspace_png` and `disabled_user_turn` for setup and submission. The mocked two-step model exchange lets Codex return the tool error in the next request.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (assert!, assert_eq!, wait_for_event_with_timeout, json!, skip_if_no_network!, vec!).


##### `view_image_tool_treats_null_detail_as_omitted`  (lines 868–955)

```
async fn view_image_tool_treats_null_detail_as_omitted() -> anyhow::Result<()>
```

**Purpose**: Checks that `detail: null` behaves the same as leaving `detail` out. This avoids punishing callers that serialize an absent option as JSON null.

**Data flow**: It writes a large PNG, has the model call `view_image` with a null detail value, waits for completion, then inspects the tool output. The returned item should say `detail: high`, include an image URL, and contain a resized 2048×768 image.

**Call relations**: This top-level test uses `write_workspace_png` and `disabled_user_turn`. The mock server triggers the tool call, and the captured follow-up request proves how Codex interpreted the null field.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (assert_eq!, wait_for_event_with_timeout, load_from_memory, json!, skip_if_no_network!, vec!).


##### `view_image_tool_resizes_when_model_lacks_original_detail_support`  (lines 958–1048)

```
async fn view_image_tool_resizes_when_model_lacks_original_detail_support() -> anyhow::Result<()>
```

**Purpose**: Verifies that models without original-detail support still receive resized images. This prevents unsupported models from getting larger or differently marked image data.

**Data flow**: It builds a test with model `gpt-5.2`, writes a large PNG, has the model call `view_image`, then inspects the returned tool output. The item should use `detail: high` and the decoded image should be 2048×768.

**Call relations**: The test follows the same mock two-response pattern as other `view_image` tests. It uses `write_workspace_png` and `disabled_user_turn`, then checks the tool output in the second mock request.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (assert_eq!, wait_for_event_with_timeout, load_from_memory, json!, skip_if_no_network!, vec!).


##### `view_image_tool_does_not_force_original_resolution_with_capability_only`  (lines 1051–1139)

```
async fn view_image_tool_does_not_force_original_resolution_with_capability_only() -> anyhow::Result<()>
```

**Purpose**: Checks that merely using a model capable of original image detail does not automatically send original-resolution images. The caller must explicitly request `detail: original`.

**Data flow**: It uses `gpt-5.3-codex`, writes a large PNG, has the model call `view_image` without a detail option, waits for completion, then decodes the returned image. The output should be marked `high` and resized to 2048×768.

**Call relations**: This test complements the explicit-original test. Both use `write_workspace_png` and `disabled_user_turn`, but this one omits the detail field to prove default behavior remains resized.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (assert_eq!, wait_for_event_with_timeout, load_from_memory, json!, skip_if_no_network!, vec!).


##### `view_image_tool_errors_when_path_is_directory`  (lines 1142–1209)

```
async fn view_image_tool_errors_when_path_is_directory() -> anyhow::Result<()>
```

**Purpose**: Verifies that `view_image` gives a clear error when pointed at a directory. A folder should not be read or encoded as if it were an image file.

**Data flow**: It creates a directory in the workspace, has the mock model call `view_image` with that path, waits for the turn to finish, then checks the tool output text. The expected message says the resolved path is not a file, and no image message should appear.

**Call relations**: This test gets its bad input from `create_workspace_directory` and submits the turn with `disabled_user_turn`. The mock server captures the tool-result request, where the error is asserted.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, create_workspace_directory, disabled_user_turn); 7 external calls (assert!, assert_eq!, wait_for_event_with_timeout, format!, json!, skip_if_no_network!, vec!).


##### `view_image_tool_errors_for_non_image_files`  (lines 1212–1286)

```
async fn view_image_tool_errors_for_non_image_files() -> anyhow::Result<()>
```

**Purpose**: Checks that a regular non-image file, such as JSON, is rejected by `view_image` with a useful unsupported-type message. This prevents accidental text or binary files from being sent as images.

**Data flow**: It writes JSON bytes to the workspace, has the model call `view_image` on that file, waits for completion, then checks that no `input_image` was produced. It reads the tool output and confirms the error mentions an unsupported `application/json` image type.

**Call relations**: The setup uses `write_workspace_file`; the turn is submitted through `disabled_user_turn`. The mock server’s second request contains the tool error that the test inspects.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_file); 7 external calls (assert!, assert_eq!, wait_for_event_with_timeout, format!, json!, skip_if_no_network!, vec!).


##### `resize_all_images_turns_invalid_view_image_into_placeholder`  (lines 1289–1352)

```
async fn resize_all_images_turns_invalid_view_image_into_placeholder() -> anyhow::Result<()>
```

**Purpose**: Checks a special behavior of the `ResizeAllImages` feature: if a `view_image` target cannot be processed as an image, Codex returns a placeholder text item instead of a detailed image-processing error item.

**Data flow**: It enables the resize-all-images feature, writes an invalid image file containing JSON, has the model call `view_image`, waits for completion, then asserts that the tool output is a single `input_text` item saying the image content was omitted because it could not be processed.

**Call relations**: This test uses `write_workspace_file` for invalid content and `disabled_user_turn` to start the flow. The mock server receives the final tool output that demonstrates the feature-specific placeholder behavior.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_file); 5 external calls (assert_eq!, wait_for_event_with_timeout, json!, skip_if_no_network!, vec!).


##### `view_image_tool_errors_when_file_missing`  (lines 1355–1426)

```
async fn view_image_tool_errors_when_file_missing() -> anyhow::Result<()>
```

**Purpose**: Verifies that `view_image` reports a clear error when the requested file does not exist. This helps the model and user understand that the problem is the path, not image decoding.

**Data flow**: It chooses a missing relative path, has the mock model call `view_image` with it, waits for completion, then checks the tool output. The message should start with “unable to locate image” and no image content should be attached.

**Call relations**: This test uses `disabled_user_turn` to submit the prompt and a mock two-response exchange to trigger and receive the tool result. It does not create a file, because the missing-file condition is the point.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn); 6 external calls (assert!, wait_for_event_with_timeout, format!, json!, skip_if_no_network!, vec!).


##### `view_image_tool_returns_unsupported_message_for_text_only_model`  (lines 1429–1554)

```
async fn view_image_tool_returns_unsupported_message_for_text_only_model() -> anyhow::Result<()>
```

**Purpose**: Checks that `view_image` is rejected when the selected model only supports text input. This prevents Codex from sending image content to a model that cannot use it.

**Data flow**: It starts a mock server with custom model metadata that lists only text as an input modality, builds Codex with that model, writes a PNG, has the model call `view_image`, then verifies the tool output says image viewing is not allowed because the model does not support image inputs.

**Call relations**: Unlike most tests, this one mounts a custom `/models` response before building the test session. It still uses `write_workspace_png` for setup and `disabled_user_turn` to submit the turn, then reads the final mock request for the rejection message.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_once, sse, test_codex, disabled_user_turn, write_workspace_png, create_dummy_chatgpt_auth_for_testing, bytes); 9 external calls (Limited, default, builder, new, assert_eq!, wait_for_event_with_timeout, json!, skip_if_no_network!, vec!).


##### `replaces_invalid_local_image_after_bad_request`  (lines 1558–1630)

```
async fn replaces_invalid_local_image_after_bad_request() -> anyhow::Result<()>
```

**Purpose**: In release builds, checks that if the API rejects an uploaded local image as invalid, Codex retries the turn without that image and adds replacement text. This protects users from a stuck conversation caused by one bad image payload.

**Data flow**: It sets up the mock server so the first request containing an `input_image` returns a 400 error, then the next request succeeds. It writes a PNG, submits it as a local image, waits for completion, confirms the first request included the image, and confirms the second request removed the image and included user text saying “Invalid image.”

**Call relations**: This test uses `write_workspace_png` and `disabled_user_turn` to create the failing upload path. It relies on one mock response for the bad request and another for the successful retry, then compares both captured requests.

*Call graph*: calls 7 internal fn (mount_response_once_match, mount_sse_once, sse, start_mock_server, test_codex, disabled_user_turn, write_workspace_png); 6 external calls (new, assert!, wait_for_event_with_timeout, skip_if_no_network!, vec!, body_string_contains).
