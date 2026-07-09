# codex-exec binary verification  `stage-23.3.3`

This stage is the safety check for codex-exec, the command-line program people run to ask Codex to do work. It is behind-the-scenes support, run by tests to make sure startup options, the main request flow, and failure exits behave reliably. The CLI and main tests check that flags, configuration options, and resume prompts are read the way users expect. The library tests cover deeper defaults such as logging, permissions, review setup, prompt decoding, and session startup. The event processor tests check how server messages become user-visible output: readable text for humans, JSONL lines for streaming tools, and simpler JSON events for automation. The integration suite then tests the whole machine assembled: extra writable directories, AGENTS instruction files, API keys and Originator headers, JSON output schemas, stdin prompts, approval modes, ephemeral sessions, hooks, required MCP tool startup failures, patch application, resume behavior, server error exit codes, and real streaming against a mock server. Together these tests make sure codex-exec is predictable for both people and scripts.

## Files in this stage

### CLI shape and startup helpers
These tests lock down argument parsing and the library-level startup behavior that prepares exec runs before any output or subprocess execution occurs.

### `exec/src/cli_tests.rs`

`test` · `test run`

This is a test file for the command-line parser, the part of the program that turns typed terminal text into structured settings the rest of the app can use. Command-line parsing can be surprisingly easy to get wrong: a word after a subcommand might be mistaken for the wrong kind of argument, or a flag might only work in one position. These tests act like small rehearsals of real user commands.

The tests build fake command lines, such as `codex-exec resume --last ... prompt text`, and ask `Cli::parse_from` to interpret them. Then they check the parsed result: which command was chosen, which flags were switched on, which files were captured, and what prompt text the program would actually use.

A key concern here is that some flags are global, meaning they affect the whole run, while others belong to a specific command. This file makes sure those still work even when placed after `resume`. It also checks that old user habits are handled kindly: the removed `--full-auto` flag should produce a clear message telling people what to use instead. Without these tests, small parser changes could silently break real terminal commands.

#### Function details

##### `resume_parses_prompt_after_global_flags`  (lines 5–36)

```
fn resume_parses_prompt_after_global_flags()
```

**Purpose**: This test makes sure the `resume` command can still find the user's prompt text even when several global flags appear after the subcommand. It protects a realistic command style where users mix resume-specific choices, output mode, model choice, sandbox bypass, and config isolation flags.

**Data flow**: It starts with a made-up command line as if a user typed it in a terminal. The parser turns that list of words into a `Cli` value, the test checks that global settings like `ephemeral`, `ignore_user_config`, and `ignore_rules` are turned on, then it looks inside the parsed `resume` command and computes the prompt the program would use. The expected result is that the final prompt string is preserved exactly instead of being swallowed as another option or session identifier.

**Call relations**: During the test, it calls the command-line parser through `parse_from`, then uses assertions to verify the parsed fields. If the parser did not produce a `Resume` command, the test stops with a panic because the rest of the checks would no longer make sense.

*Call graph*: 4 external calls (parse_from, assert!, assert_eq!, panic!).


##### `resume_accepts_output_flags_after_subcommand`  (lines 39–62)

```
fn resume_accepts_output_flags_after_subcommand()
```

**Purpose**: This test checks that output-related flags still work when they appear after `resume`, not only before it. It ensures users can provide a session id, output file, output schema, and prompt in one command without the parser mixing them up.

**Data flow**: It feeds the parser a sample command containing `resume`, a session id, an output file path, an output schema path, and prompt text. The parsed command-line object should contain the two file paths in the top-level output settings, and the `resume` command should contain the session id plus the prompt. The before-and-after story is: raw terminal words go in, clearly separated settings come out.

**Call relations**: This test relies on `parse_from` to interpret the sample command and then uses equality checks to compare the parser's result with the expected paths and strings. If parsing does not choose the `Resume` command, the test panics because that means the command line was understood in the wrong shape.

*Call graph*: 3 external calls (parse_from, assert_eq!, panic!).


##### `parses_config_isolation_flags`  (lines 65–75)

```
fn parses_config_isolation_flags()
```

**Purpose**: This test verifies that the flags for ignoring user configuration and project rules are recognized. These options matter when someone wants a run that is isolated from local preferences or rule files.

**Data flow**: It gives the parser a short command line with `--ignore-user-config`, `--ignore-rules`, and a simple prompt-like argument. The parser should return a `Cli` value where both isolation switches are set to true. Nothing is written or launched; the test only checks that the intended settings are captured.

**Call relations**: The test calls `parse_from` with the sample command and then uses assertions to confirm that the two parsed booleans are enabled. It is a focused guard around these global configuration flags.

*Call graph*: 2 external calls (parse_from, assert!).


##### `removed_full_auto_flag_reports_migration_path`  (lines 78–85)

```
fn removed_full_auto_flag_reports_migration_path()
```

**Purpose**: This test makes sure an old removed flag, `--full-auto`, produces a helpful warning instead of failing silently or leaving users confused. It checks that the message points users to the replacement option.

**Data flow**: It parses a command line that still includes `--full-auto`. After parsing, it asks the resulting `Cli` value for the warning message tied to that removed flag. The expected output is a specific sentence explaining that `--full-auto` is deprecated and that `--sandbox workspace-write` should be used instead.

**Call relations**: The test uses `parse_from` to create the command-line settings, then compares the warning returned by `removed_full_auto_warning` with the exact expected text. This connects parser compatibility with user-facing migration guidance.

*Call graph*: 2 external calls (parse_from, assert_eq!).


### `exec/src/main_tests.rs`

`test` · `test run`

This is a focused safety test for the command-line interface, the part of the program that turns typed terminal arguments into structured settings. The test protects against a subtle kind of breakage: global configuration flags and subcommand options can be mixed in ways that are easy for a parser to misunderstand. Here, the command says to run `codex-exec resume`, asks for the last session, enables JSON output, chooses a model, adds a configuration override, bypasses some safety checks, and finally provides a prompt string. The test checks that the final prompt is not accidentally swallowed or mistaken for another setting. It also checks that the `--config reasoning_level=xhigh` value is stored as a configuration override, and that `--strict-config` is remembered. In everyday terms, this test is like checking that a mail sorter still puts the address, postage, and message in the right piles even when the envelope has several extra labels on it. Without this test, a future change to command-line parsing could silently make valid user commands behave differently.

#### Function details

##### `top_cli_parses_resume_prompt_after_config_flag`  (lines 5–43)

```
fn top_cli_parses_resume_prompt_after_config_flag()
```

**Purpose**: This test confirms that the top-level command-line parser correctly reads a `resume` command when both global flags and resume-specific options are present. In particular, it verifies that the final text argument remains the resume prompt and that configuration overrides are preserved.

**Data flow**: The test starts with a list of strings shaped like a real terminal command. It feeds those strings into the command-line parser, then combines root-level configuration overrides into the inner command settings. After parsing, it looks inside the result: the command should be `Resume`, the effective prompt should match the expected prompt text, the raw configuration override list should contain exactly `reasoning_level=xhigh`, and strict configuration mode should be turned on. If any of these facts are wrong, the assertions fail the test.

**Call relations**: During the test run, the Rust test framework calls this function. The function asks `TopCli::parse_from` to interpret the fake command line, uses assertion helpers to compare the parsed result with the expected result, and calls `panic!` only if the parser did not produce the expected `resume` command shape.

*Call graph*: 4 external calls (assert!, assert_eq!, parse_from, panic!).


### `exec/src/lib_tests.rs`

`test` · `test run`

This is a test file, not production code. It builds small fake situations and checks that the exec library responds the way users and other parts of the system expect. The tests cover several important seams. One group checks observability: analytics should start enabled, OpenTelemetry self-diagnostic noise should not clutter normal error logs, and a root tracing span can inherit an incoming trace context so work can be followed across process boundaries. Another group checks review and prompt preparation: review requests are built from CLI-style arguments, custom prompts are trimmed, input bytes are decoded safely from common Unicode formats, and stdin content is wrapped in clear XML-like tags. A larger group checks app-server thread behavior: warnings are filtered to the active thread, turn items are found correctly, ephemeral threads are not backfilled, start and resume parameters preserve permission and sandbox choices, and session configured events are rebuilt from thread start responses. The file also includes tiny helper types that capture logs in memory, like putting a bucket under a pipe so the test can inspect what came out.

#### Function details

##### `test_tracing_subscriber`  (lines 20–24)

```
fn test_tracing_subscriber() -> impl tracing::Subscriber + Send + Sync
```

**Purpose**: Creates a tracing subscriber for tests that can record OpenTelemetry trace information. It lets tests check trace behavior without needing a real external telemetry service.

**Data flow**: It starts with no input, creates a lightweight tracing provider and tracer, attaches that tracer to a tracing subscriber, and returns the subscriber for a test to install temporarily.

**Call relations**: The trace-parenting test calls this first so that spans created during the test have OpenTelemetry context attached. It hands the subscriber back to that test, which installs it before creating the exec root span.

*Call graph*: called by 1 (exec_root_span_can_be_parented_from_trace_context); 3 external calls (builder, layer, registry).


##### `exec_defaults_analytics_to_enabled`  (lines 27–29)

```
fn exec_defaults_analytics_to_enabled()
```

**Purpose**: Checks that analytics are enabled by default for exec. This protects a product default that affects whether usage information is collected unless configuration says otherwise.

**Data flow**: It reads the default analytics constant and compares it with the expected value true. Nothing is changed; the test passes only if the default remains enabled.

**Call relations**: This is a standalone test. It does not prepare data for other tests; it guards one shared default used by the exec library.

*Call graph*: 1 external calls (assert_eq!).


##### `TestLogWriter::make_writer`  (lines 43–47)

```
fn make_writer(&'a self) -> Self::Writer
```

**Purpose**: Creates a writable log sink that stores log output in a shared memory buffer. Tests use it when they need to inspect exactly which log messages were emitted.

**Data flow**: It reads the shared buffer held by the test writer, clones the shared pointer to that buffer, and returns a new sink connected to the same buffer.

**Call relations**: The log-filter test gives TestLogWriter to the tracing formatting layer. When tracing needs somewhere to write a log line, it calls this method and receives a TestLogSink.

*Call graph*: 1 external calls (clone).


##### `TestLogSink::write`  (lines 51–54)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Appends bytes of log output into an in-memory buffer. This turns normal log writing into something a test can read back afterward.

**Data flow**: It receives a slice of bytes, locks the shared buffer so only one writer changes it at a time, appends the bytes, and reports that all bytes were written.

**Call relations**: The tracing subscriber calls this through Rust's standard writing interface while the log-filter test emits messages. The captured bytes are later decoded into text and checked.


##### `TestLogSink::flush`  (lines 56–58)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Satisfies the writer interface for the in-memory log sink. Since the sink writes directly to memory, there is nothing waiting to be flushed.

**Data flow**: It receives no meaningful data, performs no extra work, and returns success.

**Call relations**: The tracing machinery may call this after writing logs. It exists so TestLogSink behaves like a normal writer during the log-filter test.


##### `exec_default_stderr_filter_suppresses_otel_self_diagnostics`  (lines 62–84)

```
fn exec_default_stderr_filter_suppresses_otel_self_diagnostics()
```

**Purpose**: Checks that exec's default stderr log filter hides noisy OpenTelemetry internal failures while still showing real exec errors. This keeps users from seeing distracting telemetry problems as if they were command failures.

**Data flow**: It creates a shared memory log buffer, installs a tracing subscriber that writes into that buffer using the default exec log filter, emits three error messages, then reads the captured logs and verifies that telemetry messages are absent while the real test error remains.

**Call relations**: This test uses TestLogWriter and TestLogSink indirectly through the tracing layer. It exercises the production log filter constant by running actual tracing calls under a temporary subscriber.

*Call graph*: 10 external calls (clone, new, try_new, new, from_utf8, new, assert!, with_default, layer, registry).


##### `exec_root_span_can_be_parented_from_trace_context`  (lines 87–103)

```
fn exec_root_span_can_be_parented_from_trace_context()
```

**Purpose**: Checks that exec's root tracing span can be connected to an incoming W3C trace context. In plain terms, it makes sure this process can join an existing request trail instead of starting an unrelated one.

**Data flow**: It installs a test tracing subscriber, builds a fake incoming trace context containing a known trace ID, creates the exec root span, applies the incoming parent context to it, and then checks that the span now carries the expected trace ID.

**Call relations**: It first calls test_tracing_subscriber to enable trace context support in the test. It then calls the production trace-parenting helper and verifies the span produced by exec_root_span behaves correctly.

*Call graph*: calls 1 internal fn (test_tracing_subscriber); 3 external calls (assert!, assert_eq!, set_default).


##### `builds_uncommitted_review_request`  (lines 106–122)

```
fn builds_uncommitted_review_request()
```

**Purpose**: Checks that review arguments asking for uncommitted changes become a review request aimed at the current working changes. This protects the common 'review what I have not committed yet' workflow.

**Data flow**: It builds ReviewArgs with the uncommitted flag set, passes them to the review request builder, and compares the result with a request whose target is UncommittedChanges and has no extra hint.

**Call relations**: This standalone test exercises build_review_request for one CLI input shape. It confirms downstream review code will receive the right target.

*Call graph*: 1 external calls (assert_eq!).


##### `builds_commit_review_request_with_title`  (lines 125–144)

```
fn builds_commit_review_request_with_title()
```

**Purpose**: Checks that review arguments naming a commit also preserve the commit title. The title gives the reviewer useful human context alongside the commit hash.

**Data flow**: It creates ReviewArgs with a commit SHA and title, builds a review request, and verifies the output target contains the same SHA and title.

**Call relations**: This test covers the commit branch of build_review_request. It complements the uncommitted and custom prompt tests by checking a different review mode.

*Call graph*: 1 external calls (assert_eq!).


##### `builds_custom_review_request_trims_prompt`  (lines 147–165)

```
fn builds_custom_review_request_trims_prompt()
```

**Purpose**: Checks that a custom review prompt is cleaned up before being sent as review instructions. Leading and trailing spaces should not become part of the user's instruction.

**Data flow**: It supplies ReviewArgs with a prompt padded by spaces, calls the review request builder, and expects a Custom review target whose instructions contain the trimmed text.

**Call relations**: This standalone test exercises build_review_request when the user provides free-form instructions instead of a commit or uncommitted-change target.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_strips_utf8_bom`  (lines 168–174)

```
fn decode_prompt_bytes_strips_utf8_bom()
```

**Purpose**: Checks that prompt text saved as UTF-8 with a byte order mark is read as normal text. A byte order mark is a hidden marker at the start of some text files.

**Data flow**: It provides bytes beginning with the UTF-8 marker followed by 'hi\n', decodes them, and expects the returned string to be just 'hi\n' without the marker.

**Call relations**: This test covers one accepted input format for decode_prompt_bytes. It helps ensure prompts copied from different editors work as expected.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_decodes_utf16le_bom`  (lines 177–184)

```
fn decode_prompt_bytes_decodes_utf16le_bom()
```

**Purpose**: Checks that prompt text marked as UTF-16 little-endian is decoded correctly. This matters because some systems and editors store text in UTF-16 rather than UTF-8.

**Data flow**: It passes bytes with a UTF-16 little-endian marker and encoded text, decodes them, and expects the normal Rust string 'hi\n'.

**Call relations**: This standalone test verifies an accepted branch of decode_prompt_bytes for UTF-16LE input.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_decodes_utf16be_bom`  (lines 187–194)

```
fn decode_prompt_bytes_decodes_utf16be_bom()
```

**Purpose**: Checks that prompt text marked as UTF-16 big-endian is decoded correctly. Big-endian and little-endian describe byte order, so the decoder must tell them apart.

**Data flow**: It passes bytes with a UTF-16 big-endian marker and encoded text, decodes them, and expects the plain string 'hi\n'.

**Call relations**: This test covers the UTF-16BE branch of decode_prompt_bytes, pairing with the UTF-16LE test to protect both byte orders.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_rejects_utf32le_bom`  (lines 197–212)

```
fn decode_prompt_bytes_rejects_utf32le_bom()
```

**Purpose**: Checks that UTF-32 little-endian prompt files are rejected with a clear unsupported-encoding error. The decoder intentionally supports common formats but not every possible Unicode encoding.

**Data flow**: It feeds bytes beginning with a UTF-32LE marker into the decoder, expects an error instead of text, and verifies the error names UTF-32LE.

**Call relations**: This test exercises the rejection path in decode_prompt_bytes. It ensures callers get a specific reason rather than garbled prompt text.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_rejects_utf32be_bom`  (lines 215–230)

```
fn decode_prompt_bytes_rejects_utf32be_bom()
```

**Purpose**: Checks that UTF-32 big-endian prompt files are rejected with a clear unsupported-encoding error. This prevents unsupported text from being misread.

**Data flow**: It provides bytes with a UTF-32BE marker, expects decoding to fail, and confirms the error reports UTF-32BE.

**Call relations**: This is the matching big-endian rejection test for decode_prompt_bytes, alongside the UTF-32LE rejection test.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_rejects_invalid_utf8`  (lines 233–240)

```
fn decode_prompt_bytes_rejects_invalid_utf8()
```

**Purpose**: Checks that malformed UTF-8 prompt bytes are rejected rather than silently changed. This protects users from sending corrupted instructions unknowingly.

**Data flow**: It passes an invalid byte sequence into the decoder, expects an invalid UTF-8 error, and verifies the error reports that no valid bytes came before the failure.

**Call relations**: This standalone test covers the bad-data path of decode_prompt_bytes when there is no supported byte order marker to guide another decoding choice.

*Call graph*: 1 external calls (assert_eq!).


##### `prompt_with_stdin_context_wraps_stdin_block`  (lines 243–250)

```
fn prompt_with_stdin_context_wraps_stdin_block()
```

**Purpose**: Checks that stdin content is attached to a prompt inside a clearly labeled block. This keeps the user's instruction separate from the extra input text.

**Data flow**: It gives a prompt and stdin text to the combiner, then expects a result with the prompt first, a blank line, and the stdin text wrapped between <stdin> and </stdin> markers.

**Call relations**: This standalone test exercises prompt_with_stdin_context for normal stdin text without a trailing newline.

*Call graph*: 1 external calls (assert_eq!).


##### `prompt_with_stdin_context_preserves_trailing_newline`  (lines 253–260)

```
fn prompt_with_stdin_context_preserves_trailing_newline()
```

**Purpose**: Checks that stdin wrapping produces the same clean block even when the stdin text already ends with a newline. This avoids accidental extra blank lines at the end of the block.

**Data flow**: It passes a prompt and stdin text ending in '\n', combines them, and expects exactly one newline before the closing </stdin> tag.

**Call relations**: This complements the other stdin wrapping test by covering the common case where piped command output already has a final newline.

*Call graph*: 1 external calls (assert_eq!).


##### `lagged_event_warning_message_is_explicit`  (lines 263–268)

```
fn lagged_event_warning_message_is_explicit()
```

**Purpose**: Checks that the warning for dropped in-process app-server events says exactly what happened and how many events were dropped. Clear wording matters when diagnosing missed updates.

**Data flow**: It calls the warning-message builder with the skipped count 7 and compares the returned string with the expected human-readable warning.

**Call relations**: This standalone test protects the wording of lagged_event_warning_message, which is likely shown or logged when the event stream falls behind.

*Call graph*: 1 external calls (assert_eq!).


##### `runtime_warnings_are_filtered_to_the_primary_thread`  (lines 271–297)

```
fn runtime_warnings_are_filtered_to_the_primary_thread()
```

**Purpose**: Checks that runtime warning notifications are processed only when they are global or belong to the primary thread. This prevents warnings from another thread from confusing the current exec run.

**Data flow**: It builds three warning notifications: one global, one for the primary thread, and one for a different thread. It runs each through the notification filter and expects true, true, and false.

**Call relations**: This test exercises should_process_notification for warning notifications. It describes how the exec side decides which app-server messages are relevant to the active turn.

*Call graph*: 1 external calls (assert_eq!).


##### `resume_lookup_model_providers_filters_only_last_lookup`  (lines 300–331)

```
async fn resume_lookup_model_providers_filters_only_last_lookup()
```

**Purpose**: Checks that model-provider filtering is used only when resuming the last session, not when resuming a specifically named session. This keeps broad 'last session' lookup constrained without over-constraining explicit choices.

**Data flow**: It creates temporary config and working directories, builds a config with a test model provider, prepares two resume argument sets, and verifies that only the '--last' style arguments return a provider filter.

**Call relations**: This asynchronous test exercises resume_lookup_model_providers after building a realistic Config. It uses temporary folders so it does not depend on a developer's real environment.

*Call graph*: 4 external calls (assert_eq!, default, tempdir, vec!).


##### `turn_items_for_thread_returns_matching_turn_items`  (lines 334–397)

```
fn turn_items_for_thread_returns_matching_turn_items()
```

**Purpose**: Checks that the helper for finding turn items returns the items for the requested turn and returns nothing for a missing turn. A turn is one exchange or step inside a thread.

**Data flow**: It builds a fake thread with two turns, each containing different items, asks for the first turn's items, and then asks for a nonexistent turn. The first lookup returns the message item; the second returns none.

**Call relations**: This standalone test exercises turn_items_for_thread, which is used when exec needs to recover or inspect the app-server items associated with a specific turn.

*Call graph*: 4 external calls (new, assert_eq!, test_path_buf, vec!).


##### `should_backfill_turn_completed_items_skips_ephemeral_threads`  (lines 400–420)

```
fn should_backfill_turn_completed_items_skips_ephemeral_threads()
```

**Purpose**: Checks that completed-turn item backfilling is skipped for ephemeral threads. Ephemeral threads are short-lived and should not be treated like persistent conversation history.

**Data flow**: It builds a TurnCompleted notification for a normal-looking turn, marks the thread as ephemeral through the input flag, and expects the backfill decision to be false.

**Call relations**: This test exercises should_backfill_turn_completed_items for the ephemeral-thread guard. It protects the flow that decides whether to fetch or reuse completed turn items.

*Call graph*: 3 external calls (TurnCompleted, new, assert!).


##### `canceled_mcp_server_elicitation_response_uses_cancel_action`  (lines 423–437)

```
fn canceled_mcp_server_elicitation_response_uses_cancel_action()
```

**Purpose**: Checks that a canceled MCP server elicitation response serializes as a real cancel action. MCP here is a protocol where a server can ask the client for extra input; cancellation must be explicit.

**Data flow**: It asks the production helper for a cancellation response as JSON, deserializes that JSON back into the typed response, and verifies the action is Cancel with no content or metadata.

**Call relations**: This standalone test exercises canceled_mcp_server_elicitation_response and confirms it produces data compatible with the MCP response type.

*Call graph*: 2 external calls (assert_eq!, from_value).


##### `thread_start_params_include_review_policy_when_review_policy_is_manual_only`  (lines 440–466)

```
async fn thread_start_params_include_review_policy_when_review_policy_is_manual_only()
```

**Purpose**: Checks that starting a thread includes the manual review policy when configuration says the user should review approvals. It also checks that permission selection is sent instead of an old-style sandbox setting.

**Data flow**: It builds a temporary config with approvals_reviewer set to User, converts that config into thread start parameters, and verifies the reviewer, sandbox, and permissions fields.

**Call relations**: This asynchronous test exercises thread_start_params_from_config with a manual-review configuration. It uses ConfigBuilder and permission conversion helpers to mimic real startup data.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (default, assert_eq!, default, tempdir).


##### `thread_start_params_include_review_policy_when_auto_review_is_enabled`  (lines 469–489)

```
async fn thread_start_params_include_review_policy_when_auto_review_is_enabled()
```

**Purpose**: Checks that starting a thread includes the auto-review policy when configuration enables automatic review. This ensures the app server knows it should use that review mode.

**Data flow**: It builds a temporary config with approvals_reviewer set to AutoReview, turns the config into thread start parameters, and verifies the reviewer field is AutoReview.

**Call relations**: This test covers the auto-review branch of thread_start_params_from_config, complementing the manual-review test.

*Call graph*: 4 external calls (default, assert_eq!, default, tempdir).


##### `build_exec_config_retries_without_invalid_headless_policy_for_auto_review`  (lines 492–550)

```
async fn build_exec_config_retries_without_invalid_headless_policy_for_auto_review()
```

**Purpose**: Checks a recovery path for config loading: if exec adds a synthetic headless approval policy that conflicts with auto-review requirements, it retries without that synthetic policy. This lets valid user configuration succeed instead of failing because of a temporary headless override.

**Data flow**: It writes temporary config and requirements files, builds overrides that deliberately cause the first config build to fail, confirms that failure message, then calls build_exec_config and expects it to retry successfully with the user's on-request approval policy and auto-review setting.

**Call relations**: This asynchronous test drives build_exec_config with a real ConfigBuilder closure. It verifies the function can catch one expected failure mode, alter the overrides, and build again.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (default, assert!, assert_eq!, write, tempdir).


##### `build_exec_config_preserves_headless_error_when_retry_fails`  (lines 553–575)

```
async fn build_exec_config_preserves_headless_error_when_retry_fails()
```

**Purpose**: Checks that if the recovery retry also fails, exec reports the original headless-policy error rather than hiding it behind the retry error. This preserves the most useful explanation for the user.

**Data flow**: It creates overrides with a headless approval policy, supplies a fake config builder that fails once with 'headless error' and then with 'retry error', calls build_exec_config, and expects the final error text to be the original 'headless error'.

**Call relations**: This test exercises build_exec_config with a controlled fake builder instead of filesystem config. It focuses only on the error-preservation logic after a failed retry.

*Call graph*: 2 external calls (default, assert_eq!).


##### `thread_start_params_include_user_thread_source`  (lines 578–594)

```
async fn thread_start_params_include_user_thread_source()
```

**Purpose**: Checks that new thread start parameters mark the thread as user-created. This source label helps the app server understand where the thread came from.

**Data flow**: It builds a default temporary config, converts it to thread start parameters, and verifies thread_source is User.

**Call relations**: This asynchronous test exercises thread_start_params_from_config for a default startup path.

*Call graph*: 3 external calls (assert_eq!, default, tempdir).


##### `thread_lifecycle_params_preserve_hook_trust_bypass`  (lines 597–620)

```
async fn thread_lifecycle_params_preserve_hook_trust_bypass()
```

**Purpose**: Checks that the hook trust bypass setting is preserved both when starting and resuming a thread. Hooks are project-provided commands or scripts; this flag says trust checks are being bypassed.

**Data flow**: It builds a config with bypass_hook_trust set to true, creates both start and resume parameters from that config, and verifies each parameter set contains a JSON config entry with that boolean value.

**Call relations**: This test exercises both thread_start_params_from_config and thread_resume_params_from_config. It ensures the same important safety-related option travels through both lifecycle paths.

*Call graph*: 6 external calls (default, from, assert_eq!, default, Bool, tempdir).


##### `active_profile_selection_uses_profile_id_only`  (lines 623–629)

```
fn active_profile_selection_uses_profile_id_only()
```

**Purpose**: Checks that an active permission profile is represented by its profile ID string. The surrounding profile object may contain more structure, but the selection sent onward should be the simple identifier.

**Data flow**: It creates an ActivePermissionProfile for the built-in workspace profile, converts it to a permission profile ID, and compares the result with the expected workspace ID string.

**Call relations**: This standalone test exercises permission_profile_id_from_active_profile, which feeds permission selection data into thread lifecycle parameters.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `thread_lifecycle_params_include_legacy_sandbox_when_no_active_profile`  (lines 632–661)

```
async fn thread_lifecycle_params_include_legacy_sandbox_when_no_active_profile()
```

**Purpose**: Checks the backward-compatible path where no active permission profile exists, so start and resume parameters still include the older sandbox mode. This prevents older configuration styles from being dropped.

**Data flow**: It builds a config with a legacy DangerFullAccess sandbox override and no active permission profile, creates start and resume parameters, and verifies both contain the sandbox mode and no permissions selection.

**Call relations**: This asynchronous test exercises both thread_start_params_from_config and thread_resume_params_from_config. It protects compatibility between old sandbox settings and newer permission-profile settings.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (default, assert_eq!, default, tempdir).


##### `session_configured_from_thread_response_uses_review_policy_from_response`  (lines 664–687)

```
async fn session_configured_from_thread_response_uses_review_policy_from_response()
```

**Purpose**: Checks that the bootstrap session-configured event takes the review policy from the app server's thread start response. This matters because the server response is the final agreed configuration.

**Data flow**: It builds a default config, creates a sample thread start response, converts both into a session configured event, and verifies the session ID, thread ID, and approvals reviewer value.

**Call relations**: This test calls sample_thread_start_response to get realistic server data, then exercises session_configured_from_thread_start_response.

*Call graph*: calls 1 internal fn (sample_thread_start_response); 3 external calls (assert_eq!, default, tempdir).


##### `session_configured_from_thread_response_uses_permission_profile_from_config`  (lines 690–708)

```
async fn session_configured_from_thread_response_uses_permission_profile_from_config()
```

**Purpose**: Checks that the session-configured event carries the effective permission profile from local config. This tells later code what permissions were active for the session.

**Data flow**: It builds a default config, creates a sample server response, builds the session configured event, and compares the event's permission profile with the config's effective permission profile.

**Call relations**: This test uses sample_thread_start_response for shared fixture data and focuses on the permission-profile part of session_configured_from_thread_start_response.

*Call graph*: calls 1 internal fn (sample_thread_start_response); 3 external calls (assert_eq!, default, tempdir).


##### `session_configured_from_thread_response_preserves_thread_source`  (lines 711–729)

```
async fn session_configured_from_thread_response_preserves_thread_source()
```

**Purpose**: Checks that the thread source reported by the app server is preserved in the bootstrap event. This keeps provenance information, such as 'User', from being lost during conversion.

**Data flow**: It builds a default config and sample thread start response, converts them into a session configured event, and verifies the event contains the User thread source.

**Call relations**: This test uses sample_thread_start_response and exercises the thread-source mapping inside session_configured_from_thread_start_response.

*Call graph*: calls 1 internal fn (sample_thread_start_response); 3 external calls (assert_eq!, default, tempdir).


##### `session_configured_from_thread_response_preserves_parent_thread_id`  (lines 732–749)

```
async fn session_configured_from_thread_response_preserves_parent_thread_id()
```

**Purpose**: Checks that a parent thread ID from the server response is parsed and kept in the session-configured event. This is important for forked or related threads where lineage matters.

**Data flow**: It builds a config, creates a new parent thread ID, inserts that ID into a sample server response, converts the response into a session configured event, and verifies the parsed parent ID matches.

**Call relations**: This test calls sample_thread_start_response for the base fixture, modifies it for the parent-thread case, and then exercises session_configured_from_thread_start_response.

*Call graph*: calls 2 internal fn (sample_thread_start_response, new); 3 external calls (assert_eq!, default, tempdir).


##### `sample_thread_start_response`  (lines 751–792)

```
fn sample_thread_start_response() -> ThreadStartResponse
```

**Purpose**: Builds a reusable fake app-server thread start response for tests. It saves several tests from repeating a large block of setup data.

**Data flow**: It takes no input and returns a ThreadStartResponse filled with stable IDs, paths, model information, approval settings, sandbox policy, and thread metadata.

**Call relations**: Several session-configured tests call this helper when they need realistic server response data. They then either use it as-is or tweak one field before passing it to session_configured_from_thread_start_response.

*Call graph*: called by 4 (session_configured_from_thread_response_preserves_parent_thread_id, session_configured_from_thread_response_preserves_thread_source, session_configured_from_thread_response_uses_permission_profile_from_config, session_configured_from_thread_response_uses_review_policy_from_response); 5 external calls (from, new, new, test_path_buf, vec!).


### Output event processors
These suites verify how exec converts internal/app-server events into human-readable, JSONL, and machine-readable output streams, including completion and failure handling.

### `exec/src/event_processor_with_human_output_tests.rs`

`test` · `test run`

This is a safety net for the part of the app that turns server events into human-readable terminal output. That output has a few tricky rules: the final answer should not be printed twice, it should still be available when output is being piped, and stale partial answers should be cleared after failures. Without these tests, small changes could easily make the tool duplicate answers, hide the final response, or show misleading permission information.

The file tests helper decisions in isolation first. For example, it checks when the final message should go to standard output versus the terminal, and whether reasoning text should use a short summary or raw hidden reasoning. It also verifies how permission profiles are summarized in plain labels such as read-only, workspace-write, or danger-full-access.

The later tests build small fake server notifications, like “turn completed” events, and feed them to EventProcessorWithHumanOutput. They then inspect the processor’s stored final message and flags. Think of it like testing a receptionist: when a call ends normally, they should keep the final message; when the call fails or is cut off, they should throw away any unfinished note.

#### Function details

##### `suppresses_final_stdout_message_when_both_streams_are_terminals`  (lines 31–37)

```
fn suppresses_final_stdout_message_when_both_streams_are_terminals()
```

**Purpose**: This test checks that the final message is not printed to standard output when both standard output and standard error are already terminals. This prevents the same answer from being shown twice in an interactive session.

**Data flow**: It gives the print-decision helper a final message and says both output streams are terminals. The helper returns a yes-or-no decision, and the test expects “no.” Nothing else is changed.

**Call relations**: The test runner calls this test. Inside it, the important work is done by the final-message printing rule, and the assertion confirms the rule suppresses extra standard-output printing in normal terminal use.

*Call graph*: 1 external calls (assert!).


##### `prints_final_stdout_message_when_stdout_is_not_terminal`  (lines 40–46)

```
fn prints_final_stdout_message_when_stdout_is_not_terminal()
```

**Purpose**: This test checks that the final message is printed to standard output when standard output is not a terminal, such as when another program is reading the output. This matters for scripts and pipes that need the final answer as data.

**Data flow**: It supplies a final message, marks standard output as non-terminal, and marks standard error as a terminal. The helper decides whether to print, and the test expects “yes.”

**Call relations**: The test runner invokes this case to cover non-interactive output. It relies on the final-message print decision and verifies that piped standard output still receives the answer.

*Call graph*: 1 external calls (assert!).


##### `prints_final_stdout_message_when_stderr_is_not_terminal`  (lines 49–55)

```
fn prints_final_stdout_message_when_stderr_is_not_terminal()
```

**Purpose**: This test checks that the final message is printed to standard output when standard error is not a terminal. This covers another non-interactive setup where terminal-style rendering may not be available.

**Data flow**: It passes a final message, marks standard output as a terminal, and marks standard error as non-terminal. The print rule returns a decision, and the test expects it to allow standard-output printing.

**Call relations**: The test runner calls this test as another output-routing scenario. The assertion verifies that the helper errs on the side of making the final answer available when the output environment is not fully interactive.

*Call graph*: 1 external calls (assert!).


##### `suppresses_final_stdout_message_when_missing`  (lines 58–63)

```
fn suppresses_final_stdout_message_when_missing()
```

**Purpose**: This test checks that nothing is printed to standard output when there is no final message. It prevents empty or misleading output.

**Data flow**: It passes no final message and marks both streams as non-terminal. The helper returns a print decision, and the test expects “no” because there is no content to print.

**Call relations**: The test runner calls this test to cover the missing-message case. It uses the same standard-output decision helper and confirms that output only happens when there is actual text.

*Call graph*: 1 external calls (assert!).


##### `prints_final_tty_message_when_not_yet_rendered`  (lines 66–73)

```
fn prints_final_tty_message_when_not_yet_rendered()
```

**Purpose**: This test checks that an interactive terminal should show the final message if it has not already been rendered. It protects the normal user experience: the answer should appear once at the end.

**Data flow**: It passes a final message, says it has not yet been rendered, and marks both streams as terminals. The terminal-print helper returns a decision, and the test expects “yes.”

**Call relations**: The test runner invokes this scenario for terminal output. The helper under test decides whether the human-facing terminal still needs the final answer.

*Call graph*: 1 external calls (assert!).


##### `suppresses_final_tty_message_when_already_rendered`  (lines 76–83)

```
fn suppresses_final_tty_message_when_already_rendered()
```

**Purpose**: This test checks that the terminal does not show the final message again if it was already rendered. This avoids duplicate final answers.

**Data flow**: It passes a final message, marks it as already rendered, and says both streams are terminals. The terminal-print helper returns a decision, and the test expects “no.”

**Call relations**: The test runner calls this test to cover duplicate-prevention. It verifies that the terminal output rule respects the processor’s remembered “already shown” flag.

*Call graph*: 1 external calls (assert!).


##### `reasoning_text_prefers_summary_when_raw_reasoning_is_hidden`  (lines 86–94)

```
fn reasoning_text_prefers_summary_when_raw_reasoning_is_hidden()
```

**Purpose**: This test checks that the user sees the reasoning summary, not the raw reasoning, when raw agent reasoning is disabled. This protects private or overly detailed internal reasoning from being shown by default.

**Data flow**: It gives the reasoning helper two pieces of text: a summary and raw content. It sets the raw-reasoning option to false, and expects the helper to return the summary.

**Call relations**: The test runner calls this test. It hands sample reasoning data to reasoning_text, then uses an equality check to confirm the display choice matches the privacy setting.

*Call graph*: 2 external calls (assert_eq!, reasoning_text).


##### `reasoning_text_uses_raw_content_when_enabled`  (lines 97–105)

```
fn reasoning_text_uses_raw_content_when_enabled()
```

**Purpose**: This test checks that raw reasoning text is used when the user or configuration explicitly enables it. It confirms that the advanced display option works.

**Data flow**: It gives the helper both a summary and raw reasoning text, then turns on the raw-reasoning option. The helper returns the chosen text, and the test expects the raw content.

**Call relations**: The test runner invokes this setting-specific case. The reasoning_text helper makes the selection, and the assertion confirms that enabling raw reasoning changes what is displayed.

*Call graph*: 2 external calls (assert_eq!, reasoning_text).


##### `summarizes_disabled_permission_profile_as_danger_full_access`  (lines 108–119)

```
fn summarizes_disabled_permission_profile_as_danger_full_access()
```

**Purpose**: This test checks the label used when sandboxing is disabled. The expected wording, danger-full-access, warns that the agent can access the system broadly.

**Data flow**: It creates a test current directory and passes a disabled permission profile into the sandbox-summary helper. The helper returns a plain text summary, and the test expects danger-full-access.

**Call relations**: The test runner calls this permission-summary case. It uses a test path helper to create a realistic absolute path, then verifies the external summary function’s wording.

*Call graph*: 2 external calls (assert_eq!, test_path_buf).


##### `summarizes_external_permission_profile`  (lines 122–135)

```
fn summarizes_external_permission_profile()
```

**Purpose**: This test checks how externally controlled sandboxing is described, especially when network access is enabled. It ensures users get a clear summary of who is enforcing restrictions.

**Data flow**: It creates a test current directory and an external permission profile with network access enabled. The summary helper turns that profile into text, and the test expects the external-sandbox label with the network note.

**Call relations**: The test runner invokes this scenario. The test sets up the permission profile, calls the sandbox-summary helper, and checks the exact human-facing wording.

*Call graph*: 2 external calls (assert_eq!, test_path_buf).


##### `summarizes_managed_workspace_write_permission_profile`  (lines 138–161)

```
fn summarizes_managed_workspace_write_permission_profile()
```

**Purpose**: This test checks the summary for a managed sandbox that allows writing in the workspace and a cache directory. It makes sure the output names the writable areas instead of hiding them.

**Data flow**: It builds absolute test paths for a project directory and cache directory, then creates a restricted file-system policy that grants write access to both. That policy is converted into a permission profile, summarized, and compared with the expected workspace-write text.

**Call relations**: The test runner calls this case to exercise the permission-building path. It uses policy constructors to model allowed write locations, then relies on the summary helper to produce the user-facing description.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 3 external calls (assert_eq!, test_path_buf, vec!).


##### `summarizes_managed_read_only_permission_profile`  (lines 164–175)

```
fn summarizes_managed_read_only_permission_profile()
```

**Purpose**: This test checks that a managed sandbox with no writable paths is described as read-only. This is important because users need to know the agent cannot change files.

**Data flow**: It creates a test current directory and a restricted file-system policy with no write entries. The policy becomes a permission profile, the summary helper turns it into text, and the test expects read-only.

**Call relations**: The test runner invokes this read-only sandbox scenario. The setup creates the restricted profile, and the assertion confirms that the summary language is simple and accurate.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 3 external calls (new, assert_eq!, test_path_buf).


##### `config_summary_entries_include_runtime_workspace_roots`  (lines 178–241)

```
async fn config_summary_entries_include_runtime_workspace_roots()
```

**Purpose**: This asynchronous test checks that the configuration summary includes workspace roots added at runtime, not just the original working directory. This matters because users should see all places the agent may write.

**Data flow**: It creates temporary directories for the app home, current working directory, and an extra workspace root. It builds a config, inserts both workspace roots, applies a workspace-write permission profile, creates a session-configured event, then asks config_summary_entries for display rows. Finally it finds the sandbox row and checks that it mentions the extra root.

**Call relations**: The async test runner calls this test because building the config can involve asynchronous setup. The test uses ConfigBuilder and permission helpers to prepare realistic state, then hands that state to config_summary_entries and verifies the resulting human-readable sandbox line.

*Call graph*: calls 3 internal fn (workspace_write_with, new, new); 5 external calls (assert!, default, config_summary_entries, tempdir, vec!).


##### `final_message_from_turn_items_uses_latest_agent_message`  (lines 244–265)

```
fn final_message_from_turn_items_uses_latest_agent_message()
```

**Purpose**: This test checks that the final answer is taken from the latest agent message when a turn contains multiple items. It ensures an older answer is not accidentally used.

**Data flow**: It creates a small list containing an agent message, a plan, and a newer agent message. The final-message helper scans the list and returns the selected text, which the test expects to be the newer agent message.

**Call relations**: The test runner invokes this helper-focused case. It gives final_message_from_turn_items a realistic turn history and checks that agent messages take priority, with the most recent one winning.

*Call graph*: 2 external calls (assert_eq!, final_message_from_turn_items).


##### `final_message_from_turn_items_falls_back_to_latest_plan`  (lines 268–286)

```
fn final_message_from_turn_items_falls_back_to_latest_plan()
```

**Purpose**: This test checks that if there is no agent message, the final message can fall back to the latest plan. This gives the processor something meaningful to show when the server only sent planning items.

**Data flow**: It creates turn items containing reasoning and two plans, with no agent message. The helper scans them and returns the newest plan text, which the test expects.

**Call relations**: The test runner calls this fallback scenario. The final_message_from_turn_items helper chooses from the available turn items, and the assertion confirms the fallback order.

*Call graph*: 4 external calls (new, assert_eq!, final_message_from_turn_items, vec!).


##### `turn_completed_recovers_final_message_from_turn_items`  (lines 289–334)

```
fn turn_completed_recovers_final_message_from_turn_items()
```

**Purpose**: This test checks that when a turn completes, the event processor can recover the final answer from the completed turn’s items. This protects cases where the final answer was not already stored through streaming.

**Data flow**: It creates an EventProcessorWithHumanOutput with no final message, then sends it a fake TurnCompleted notification containing one agent message. The processor updates its stored final message to that text and returns a status asking the app to shut down.

**Call relations**: The test runner calls this processor-level scenario. The fake server notification is passed into process_server_notification, and the test checks both the returned shutdown signal and the processor’s saved final answer.

*Call graph*: 4 external calls (TurnCompleted, new, assert_eq!, vec!).


##### `turn_completed_overwrites_stale_final_message_from_turn_items`  (lines 337–383)

```
fn turn_completed_overwrites_stale_final_message_from_turn_items()
```

**Purpose**: This test checks that a completed turn’s final answer replaces an older stale answer. It also checks that the processor marks the new answer as not yet rendered, so it can be shown correctly.

**Data flow**: It starts the processor with an old final message and a flag saying that old message was already rendered. It then sends a completed-turn notification with a new agent message. The processor stores the new text, clears the rendered flag, and returns the shutdown status.

**Call relations**: The test runner invokes this case to protect against stale output. process_server_notification receives the completion event, updates the processor’s final-message state, and the assertions verify the replacement.

*Call graph*: 5 external calls (TurnCompleted, new, assert!, assert_eq!, vec!).


##### `turn_completed_preserves_streamed_final_message_when_turn_items_are_empty`  (lines 386–427)

```
fn turn_completed_preserves_streamed_final_message_when_turn_items_are_empty()
```

**Purpose**: This test checks that a streamed final message is kept if the completed-turn event arrives with no turn items. This avoids losing an answer just because the final event is sparse.

**Data flow**: It starts the processor with an existing streamed answer and sends a completed-turn notification whose item list is empty. The processor keeps the existing answer, returns the shutdown status, and marks that the final message should be emitted during shutdown.

**Call relations**: The test runner calls this sparse-completion scenario. process_server_notification cannot recover a replacement from turn items, so the test confirms it preserves the already-collected message and prepares to emit it later.

*Call graph*: 5 external calls (TurnCompleted, new, new, assert!, assert_eq!).


##### `turn_failed_clears_stale_final_message`  (lines 430–472)

```
fn turn_failed_clears_stale_final_message()
```

**Purpose**: This test checks that a failed turn clears any partial or stale final message. This prevents the app from presenting unfinished text as a successful answer.

**Data flow**: It starts the processor with a partial answer and flags saying it was rendered and should be emitted later. It sends a completed-turn notification whose status is Failed. The processor clears the stored message and resets the related flags, while still returning the shutdown status.

**Call relations**: The test runner invokes this failure scenario. process_server_notification sees the failed turn status and wipes final-answer state; the assertions confirm there is no leftover answer to print.

*Call graph*: 5 external calls (TurnCompleted, new, new, assert!, assert_eq!).


##### `turn_interrupted_clears_stale_final_message`  (lines 475–517)

```
fn turn_interrupted_clears_stale_final_message()
```

**Purpose**: This test checks that an interrupted turn also clears any partial final message. This keeps cancelled or cut-off work from looking like a real final answer.

**Data flow**: It starts the processor with a partial answer plus flags showing it was rendered and scheduled for shutdown output. It sends a completed-turn notification marked Interrupted. The processor removes the message, resets the flags, and returns the shutdown status.

**Call relations**: The test runner calls this interruption scenario. process_server_notification handles the interrupted status like an unsuccessful turn, and the test verifies that stale output state is cleaned up.

*Call graph*: 5 external calls (TurnCompleted, new, new, assert!, assert_eq!).


### `exec/src/event_processor_with_jsonl_output_tests.rs`

`test` · `test suite`

This is a test file for `EventProcessorWithJsonOutput`, the part of the exec system that turns server notifications into JSON-style thread events and, when appropriate, writes the final assistant message to a file. JSONL means “JSON Lines”: a stream where each event is written as one JSON object, one line at a time.

The tests focus on three user-visible promises. First, if a conversation turn fails, any partial assistant message should not be treated as the final answer, and an existing “last message” file should not be overwritten. That matters because overwriting a saved file with a failed or incomplete result would lose useful data.

Second, a runtime warning from the server, such as bad global instructions, should become an error item in the event stream without stopping the run. In other words, it is reported to the caller but is not fatal.

Third, MCP tool call results preserve their special metadata field. MCP is a tool-connection protocol; its result metadata is serialized as `_meta`, not `meta`. This test makes sure the processor keeps that convention so other MCP-aware software can read the output correctly.

#### Function details

##### `failed_turn_does_not_overwrite_output_last_message_file`  (lines 7–60)

```
fn failed_turn_does_not_overwrite_output_last_message_file()
```

**Purpose**: This test checks that a failed turn does not erase or replace an existing last-message output file. It also confirms that a partial assistant message is forgotten once the turn is marked as failed.

**Data flow**: The test starts by creating a temporary folder and writing an existing text file with the contents “keep existing contents”. It then creates an event processor pointed at that file, feeds it an assistant message notification, and sees that the processor temporarily remembers the message while still running. Next it feeds the processor a failed turn completion notification. After that, the processor moves toward shutdown, clears the remembered final message, and when final output is printed, the original file contents remain unchanged.

**Call relations**: The test drives the processor the same way the real server flow would: it constructs an `ItemCompleted` notification, then a `TurnCompleted` notification, and finally calls `print_final_output`. The assertions around those calls prove that the processor refuses to hand a failed partial answer to the final-output-writing step.

*Call graph*: calls 2 internal fn (print_final_output, new); 6 external calls (ItemCompleted, TurnCompleted, new, assert_eq!, write, tempdir).


##### `runtime_warning_emits_a_non_fatal_error_item`  (lines 63–87)

```
fn runtime_warning_emits_a_non_fatal_error_item()
```

**Purpose**: This test checks that a server warning is turned into an error-shaped event for the JSONL output, but does not stop the processor. Someone reading the output can see the problem, while the run continues.

**Data flow**: The test creates a processor with no last-message file, then sends it a warning notification containing the message “invalid global instructions”. The processor converts that warning into one completed thread item whose details are an error item with the same message. The returned status stays `Running`, showing that the warning is reported but not treated as a shutdown condition.

**Call relations**: The test calls the processor’s event-collection path with a `Warning` notification and compares the full collected result to the expected event. This anchors the warning behavior in the same event stream used for normal completed items.

*Call graph*: calls 1 internal fn (new); 2 external calls (Warning, assert_eq!).


##### `mcp_tool_call_result_preserves_meta_in_jsonl_event`  (lines 90–138)

```
fn mcp_tool_call_result_preserves_meta_in_jsonl_event()
```

**Purpose**: This test checks that metadata from an MCP tool call result survives processing and is serialized under the required `_meta` JSON field. This matters because MCP clients and tools may depend on that exact field name.

**Data flow**: The test creates a processor and sends it a completed MCP tool call notification. The tool result includes content plus metadata containing a raw message reference. The processor returns one completed item, and the test pulls that item back out to confirm the metadata is still present in memory. It then serializes the event to JSON and confirms the metadata appears as `result._meta`, while the plain `result.meta` field is absent.

**Call relations**: The test enters through the same item-completion path used for other finished thread items, but with an MCP tool call payload. After the processor produces a thread event, the test hands that event to JSON serialization to verify not only the internal data but also the final shape that outside consumers will read.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, ItemCompleted, assert!, assert_eq!, json!, panic!, to_value, vec!).


### `exec/tests/event_processor_with_json_output.rs`

`test` · `test suite`

The `codex exec` command receives detailed notifications from an app server while an agent is working. Those notifications are not always in the exact shape that command-line users or JSON consumers need, so `EventProcessorWithJsonOutput` acts like a translator. This test file checks that translator from many angles.

Each test builds a small fake server notification, feeds it into the processor, and compares the result with the exact event that should come out. The tests cover ordinary flow, such as a turn starting and finishing, and also detailed item types: shell commands, web searches, MCP tool calls, collaboration agent calls, file patches, reasoning summaries, to-do plans, warnings, and model reroutes. They also check stateful behavior. For example, when an item starts and later completes, the processor must reuse the same friendly synthetic ID like `item_0`; when a final answer arrives, it must remember it; when a failed turn happens, it must not leave behind a stale answer.

Without these tests, a small change in the event mapping could silently break JSON output for automation that depends on stable event names, statuses, IDs, and final messages.

#### Function details

##### `map_todo_items_preserves_text_and_completion_state`  (lines 79–104)

```
fn map_todo_items_preserves_text_and_completion_state()
```

**Purpose**: Checks that plan steps from the server become simple to-do items without losing the step text or whether each step is finished. This protects the user-facing task list from showing wrong completion states.

**Data flow**: The test starts with two plan steps: one in progress and one completed. It sends them to `EventProcessorWithJsonOutput::map_todo_items`, then expects two `TodoItem` values: the same text, with only the completed step marked `completed: true`.

**Call relations**: The Rust test runner calls this test. Inside it, the test calls the processor's to-do mapping helper directly and uses `assert_eq!` to confirm the helper's output matches the expected public JSON-facing shape.

*Call graph*: calls 1 internal fn (map_todo_items); 1 external calls (assert_eq!).


##### `session_configured_produces_thread_started_event`  (lines 107–137)

```
fn session_configured_produces_thread_started_event()
```

**Purpose**: Verifies that a configured session is announced as the start of a thread. This matters because JSON consumers need a clear first event that identifies the thread they are watching.

**Data flow**: The test builds a `SessionConfiguredEvent` with a known thread ID, model, permissions, and working directory. It passes that into `EventProcessorWithJsonOutput::thread_started_event` and expects a `ThreadStarted` event containing the same thread ID as a string.

**Call relations**: The test runner invokes this test. The test relies on helper constructors for IDs, permissions, and a test path, then calls the processor's thread-start conversion function and checks the result.

*Call graph*: calls 3 internal fn (read_only, from, from_string); 2 external calls (assert_eq!, test_path_buf).


##### `turn_started_emits_turn_started_event`  (lines 140–165)

```
fn turn_started_emits_turn_started_event()
```

**Purpose**: Checks that a server notice saying a turn has started becomes a simple `TurnStarted` event. A turn is one round of agent work, so downstream tools need to know when that round begins.

**Data flow**: The test creates a fresh processor and feeds it a `TurnStarted` notification with an in-progress turn. The processor returns one `TurnStarted` event and keeps the overall status as running.

**Call relations**: The test runner calls this test. The test creates the processor with `new`, sends a server notification through `collect_thread_events`, and verifies the returned event bundle.

*Call graph*: calls 1 internal fn (new); 3 external calls (TurnStarted, new, assert_eq!).


##### `command_execution_started_and_completed_translate_to_thread_events`  (lines 168–244)

```
fn command_execution_started_and_completed_translate_to_thread_events()
```

**Purpose**: Confirms that shell command activity is reported correctly when it starts and when it finishes. This protects the JSON stream from losing command text, output, exit code, or status.

**Data flow**: The test first sends a command item with status `InProgress` and no output. The processor emits an `ItemStarted` command event with an empty output and a synthetic ID. Then the test sends the same command as completed with output and exit code, and the processor emits `ItemCompleted` using the same synthetic ID and the completed details.

**Call relations**: The test runner invokes this scenario. It calls the processor twice through `collect_thread_events`: once with `ItemStarted` and once with `ItemCompleted`, checking that the processor preserves continuity between the two notifications.

*Call graph*: calls 1 internal fn (new); 5 external calls (ItemCompleted, ItemStarted, new, assert_eq!, test_path_buf).


##### `empty_reasoning_items_are_ignored`  (lines 247–270)

```
fn empty_reasoning_items_are_ignored()
```

**Purpose**: Makes sure reasoning items with no safe summary are not emitted. This is important because raw internal reasoning content should not be exposed just because the server included it.

**Data flow**: The test sends a completed reasoning item whose summary list is empty but whose raw content contains text. The processor returns no events and stays in the running state.

**Call relations**: The test runner calls this test. It exercises the item-completion path in `collect_thread_events` and confirms that unsupported or unsafe reasoning content is filtered out.

*Call graph*: calls 1 internal fn (new); 4 external calls (ItemCompleted, new, assert_eq!, vec!).


##### `unsupported_items_do_not_consume_synthetic_ids`  (lines 273–324)

```
fn unsupported_items_do_not_consume_synthetic_ids()
```

**Purpose**: Checks that ignored item types do not use up the friendly generated IDs given to emitted items. This keeps visible IDs predictable and avoids gaps caused by hidden events.

**Data flow**: The test first sends a completed `Plan` item that the processor ignores, receiving no events. It then sends a completed agent message and expects that message to receive `item_0`, proving the ignored plan did not advance the ID counter.

**Call relations**: The test runner invokes this test. It sends two completed notifications through the same processor so the test can observe the processor's internal ID sequence across calls.

*Call graph*: calls 1 internal fn (new); 2 external calls (ItemCompleted, assert_eq!).


##### `reasoning_items_emit_summary_not_raw_content`  (lines 327–357)

```
fn reasoning_items_emit_summary_not_raw_content()
```

**Purpose**: Verifies that reasoning output uses the safe summary text rather than the raw reasoning text. This protects users and integrations from receiving content that is not meant for display.

**Data flow**: The input reasoning item contains both a summary and raw content. The processor emits a completed reasoning item whose text is the summary only, with a generated item ID.

**Call relations**: The test runner calls this test. It routes a completed reasoning notification through `collect_thread_events` and checks that the emitted `ReasoningItem` contains only the approved summary.

*Call graph*: calls 1 internal fn (new); 3 external calls (ItemCompleted, assert_eq!, vec!).


##### `web_search_completion_preserves_query_and_action`  (lines 360–398)

```
fn web_search_completion_preserves_query_and_action()
```

**Purpose**: Checks that a completed web search keeps both the visible query and the structured search action. This lets JSON consumers understand what search was performed.

**Data flow**: The test sends a completed web search notification with query text and a `Search` action. The processor emits a completed web search item with the same original search ID, query text, and converted action.

**Call relations**: The test runner invokes this test. The test calls `collect_thread_events` once and verifies that the processor translates the app-server web search action into the exec-facing web search action.

*Call graph*: calls 1 internal fn (new); 2 external calls (ItemCompleted, assert_eq!).


##### `web_search_start_and_completion_reuse_item_id`  (lines 401–467)

```
fn web_search_start_and_completion_reuse_item_id()
```

**Purpose**: Ensures that the start and finish of the same web search are tied together by one synthetic item ID. This makes the JSON stream easy to follow, like tracking the same package from shipment to delivery.

**Data flow**: The test sends a web search start with an empty query and no action, then a completion for the same server item ID with the final query and action. The processor emits `ItemStarted` and `ItemCompleted` events that both use `item_0`.

**Call relations**: The test runner calls this test. The same processor instance handles both notifications, which lets the test confirm that the processor remembers the mapping from the server's item ID to the public synthetic ID.

*Call graph*: calls 1 internal fn (new); 4 external calls (ItemCompleted, ItemStarted, new, assert_eq!).


##### `mcp_tool_call_begin_and_end_emit_item_events`  (lines 470–557)

```
fn mcp_tool_call_begin_and_end_emit_item_events()
```

**Purpose**: Verifies that an MCP tool call is emitted when it begins and when it completes. MCP means Model Context Protocol, a way for the agent to call external tools, so these calls need clear JSON records.

**Data flow**: The test starts with an in-progress MCP tool call containing server name, tool name, and JSON arguments. It expects an `ItemStarted` event. Then it sends a completed version with a result and expects an `ItemCompleted` event using the same item ID and completed status.

**Call relations**: The test runner invokes this test. It feeds start and completion notifications into `collect_thread_events`; the processor converts the app-server MCP fields into the exec-facing MCP item format.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, ItemCompleted, ItemStarted, new, assert_eq!, json!).


##### `mcp_tool_call_failure_sets_failed_status`  (lines 560–606)

```
fn mcp_tool_call_failure_sets_failed_status()
```

**Purpose**: Checks that a failed MCP tool call becomes a failed tool-call item, not a successful or in-progress one. This matters so automation can detect tool failures reliably.

**Data flow**: The test sends a completed MCP tool-call notification whose status is failed and whose error message says the tool exploded. The processor emits a completed item with failed status and the same error message in the exec-facing error shape.

**Call relations**: The test runner calls this test. It exercises the MCP completion conversion path and confirms that error information is carried into the public event.

*Call graph*: calls 1 internal fn (new); 3 external calls (ItemCompleted, assert_eq!, json!).


##### `mcp_tool_call_defaults_arguments_and_preserves_structured_content`  (lines 609–702)

```
fn mcp_tool_call_defaults_arguments_and_preserves_structured_content()
```

**Purpose**: Confirms that MCP tool-call arguments and structured results survive translation, even when the arguments are JSON null. Structured content is machine-readable result data, so losing it would break integrations.

**Data flow**: The test sends a started MCP call with null arguments, then a completed call with text content and structured JSON content. The processor emits start and completion events with null arguments unchanged and the structured result preserved.

**Call relations**: The test runner invokes this test. It sends two MCP notifications through one processor to confirm both item ID reuse and careful copying of JSON result fields.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, ItemCompleted, ItemStarted, assert_eq!, json!, vec!).


##### `collab_spawn_begin_and_end_emit_item_events`  (lines 705–794)

```
fn collab_spawn_begin_and_end_emit_item_events()
```

**Purpose**: Tests the JSON output for a collaboration tool call that spawns another agent. This makes sure parent and child thread information is visible when one agent asks another agent to help.

**Data flow**: The test sends an in-progress collaboration spawn call with a parent thread, prompt, and model. It then sends a completed version with a child thread ID and that child agent's running state. The processor emits matching started and completed events with the same synthetic ID and converted collaboration status fields.

**Call relations**: The test runner calls this test. It uses `collect_thread_events` for both start and completion, checking that collaboration-specific server types are translated into the exec-facing collaboration item types.

*Call graph*: calls 1 internal fn (new); 7 external calls (ItemCompleted, ItemStarted, new, assert_eq!, from, new, vec!).


##### `file_change_completion_maps_change_kinds`  (lines 797–857)

```
fn file_change_completion_maps_change_kinds()
```

**Purpose**: Checks that completed file patch information is simplified correctly for JSON output. It verifies that added, deleted, and updated files are labeled correctly.

**Data flow**: The test sends a completed file-change notification containing three changed paths and their server-side change kinds. The processor emits one completed file-change item whose changes contain the same paths and the exec-facing add, delete, and update kinds.

**Call relations**: The test runner invokes this test. It exercises the file-change conversion branch inside `collect_thread_events` and confirms that detailed patch diffs are not required for the public summary.

*Call graph*: calls 1 internal fn (new); 3 external calls (ItemCompleted, assert_eq!, vec!).


##### `file_change_declined_maps_to_failed_status`  (lines 860–898)

```
fn file_change_declined_maps_to_failed_status()
```

**Purpose**: Ensures that a declined patch is reported as a failed file change in exec JSON output. This helps consumers treat declined edits as work that did not apply.

**Data flow**: The test sends a file-change notification with status `Declined`. The processor emits a completed file-change item whose status is `Failed`, while preserving the changed path and update kind.

**Call relations**: The test runner calls this test. It sends one completed file-change notification through `collect_thread_events` and checks the status mapping.

*Call graph*: calls 1 internal fn (new); 3 external calls (ItemCompleted, assert_eq!, vec!).


##### `agent_message_item_updates_final_message`  (lines 901–933)

```
fn agent_message_item_updates_final_message()
```

**Purpose**: Verifies that a completed agent message is both emitted as an item and remembered as the final message candidate. This final message is what callers often want after `codex exec` finishes.

**Data flow**: The test sends a completed agent message saying `hello`. The processor emits a completed agent-message item with that text and then `final_message()` returns `hello`.

**Call relations**: The test runner invokes this test. It uses `collect_thread_events` to feed the message and then calls `final_message` to check the processor's stored state.

*Call graph*: calls 1 internal fn (new); 2 external calls (ItemCompleted, assert_eq!).


##### `agent_message_item_started_is_ignored`  (lines 936–959)

```
fn agent_message_item_started_is_ignored()
```

**Purpose**: Checks that an agent message is not emitted when it merely starts. The processor waits until the message is complete so the JSON stream does not show partial final answers as finished content.

**Data flow**: The test sends an `ItemStarted` notification for an agent message. The processor returns no events and keeps running.

**Call relations**: The test runner calls this test. It sends the start notification through `collect_thread_events` and confirms that only completed agent messages become visible items.

*Call graph*: calls 1 internal fn (new); 2 external calls (ItemStarted, assert_eq!).


##### `reasoning_item_completed_uses_synthetic_id`  (lines 962–992)

```
fn reasoning_item_completed_uses_synthetic_id()
```

**Purpose**: Confirms that completed reasoning summaries receive the generated public item IDs used by the exec JSON stream. This keeps reasoning items consistent with other emitted items.

**Data flow**: The test sends a completed reasoning item with a summary. The processor emits a completed reasoning item with text from the summary and ID `item_0`.

**Call relations**: The test runner invokes this test. It exercises the completed reasoning path and checks the processor's synthetic ID assignment.

*Call graph*: calls 1 internal fn (new); 3 external calls (ItemCompleted, assert_eq!, vec!).


##### `warning_event_produces_error_item`  (lines 995–1016)

```
fn warning_event_produces_error_item()
```

**Purpose**: Checks that a warning string can be surfaced as an error-shaped item in the JSON event stream. This gives users and tools a visible record of important warnings.

**Data flow**: The test passes a long warning message into `collect_warning`. The processor returns a completed item with a generated ID and `ErrorItem` details containing the same warning text.

**Call relations**: The test runner calls this test. Instead of sending a server notification, it calls the processor's warning collection helper directly and verifies the event it creates.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `plan_update_emits_started_then_updated_then_completed`  (lines 1019–1147)

```
fn plan_update_emits_started_then_updated_then_completed()
```

**Purpose**: Tests the lifecycle of a plan shown as a to-do list: first created, then updated, then completed when the turn ends. This keeps progress reporting stable for users watching the JSON stream.

**Data flow**: The test sends an initial plan update and expects an `ItemStarted` to-do list. It sends another plan update with one step completed and expects an `ItemUpdated` for the same item. Finally it sends turn completion and expects the to-do list to be completed before the turn-completed event, with shutdown requested.

**Call relations**: The test runner invokes this test. A single processor receives plan updates and turn completion, demonstrating how the processor remembers the active to-do list between notifications.

*Call graph*: calls 1 internal fn (new); 5 external calls (TurnCompleted, TurnPlanUpdated, new, assert_eq!, vec!).


##### `plan_update_after_completion_starts_new_todo_list_with_new_id`  (lines 1150–1209)

```
fn plan_update_after_completion_starts_new_todo_list_with_new_id()
```

**Purpose**: Verifies that after a to-do list has been completed, a later plan update starts a new list with a new ID. This prevents separate turns from being accidentally merged.

**Data flow**: The test creates a plan, completes the turn, then sends a new plan update for another turn. The processor emits a new started to-do list with ID `item_1`, not the old `item_0`.

**Call relations**: The test runner calls this test. It drives the processor through an old plan's completion and then a new plan update to confirm that the processor resets its active plan tracking.

*Call graph*: calls 1 internal fn (new); 5 external calls (TurnCompleted, TurnPlanUpdated, new, assert_eq!, vec!).


##### `token_usage_update_is_emitted_on_turn_completion`  (lines 1212–1276)

```
fn token_usage_update_is_emitted_on_turn_completion()
```

**Purpose**: Checks that token usage is stored when it arrives and included when the turn completes. Tokens are chunks of text processed by the model, and usage numbers are important for cost and debugging.

**Data flow**: The test first sends a token-usage update with input, cached input, output, and reasoning-output counts. That update emits no event immediately. When the turn completes, the processor emits `TurnCompleted` with those usage numbers and requests shutdown.

**Call relations**: The test runner invokes this test. It sends a usage notification followed by turn completion through the same processor, proving that usage is remembered until the final turn event.

*Call graph*: calls 1 internal fn (new); 4 external calls (ThreadTokenUsageUpdated, TurnCompleted, new, assert_eq!).


##### `turn_completion_recovers_final_message_from_turn_items`  (lines 1279–1313)

```
fn turn_completion_recovers_final_message_from_turn_items()
```

**Purpose**: Ensures the processor can find the final answer from the completed turn's item list, even if it was not previously streamed as a separate completed item. This makes final-message recovery more robust.

**Data flow**: The test sends a turn-completed notification whose turn contains one agent message saying `final answer`. The processor emits only the turn-completed event, then `final_message()` returns `final answer`.

**Call relations**: The test runner calls this test. It exercises the turn-completion path, where the processor scans the turn's included items for a final message.

*Call graph*: calls 1 internal fn (new); 3 external calls (TurnCompleted, assert_eq!, vec!).


##### `turn_completion_reconciles_started_items_from_turn_items`  (lines 1316–1404)

```
fn turn_completion_reconciles_started_items_from_turn_items()
```

**Purpose**: Checks that if an item started earlier but never sent its own completion notification, the processor can complete it from the final turn snapshot. This prevents dangling started items in the JSON stream.

**Data flow**: The test starts a command item and receives an `ItemStarted` event. Then it completes the turn with a full item list showing that command as completed with output and exit code. The processor emits the missing `ItemCompleted` for the same ID, followed by `TurnCompleted`.

**Call relations**: The test runner invokes this test. It uses one processor across the start notification and final turn notification so the processor can reconcile the already-started command.

*Call graph*: calls 1 internal fn (new); 6 external calls (ItemStarted, TurnCompleted, new, assert_eq!, test_path_buf, vec!).


##### `turn_completion_overwrites_stale_final_message_from_turn_items`  (lines 1407–1454)

```
fn turn_completion_overwrites_stale_final_message_from_turn_items()
```

**Purpose**: Verifies that the final turn snapshot can replace an earlier streamed final-message candidate. This avoids returning an outdated answer when the completed turn contains a newer one.

**Data flow**: The test first streams a completed agent message saying `stale answer`. Then it completes the turn with an agent message saying `final answer`. The processor emits turn completion and `final_message()` returns the newer text.

**Call relations**: The test runner calls this test. It checks how the processor resolves conflicts between earlier item events and the authoritative item list included with turn completion.

*Call graph*: calls 1 internal fn (new); 4 external calls (ItemCompleted, TurnCompleted, assert_eq!, vec!).


##### `turn_completion_preserves_streamed_final_message_when_turn_items_are_empty`  (lines 1457–1499)

```
fn turn_completion_preserves_streamed_final_message_when_turn_items_are_empty()
```

**Purpose**: Checks that an already streamed final answer is kept if the final turn snapshot has no items. This avoids losing a valid answer just because the completion notification is sparse.

**Data flow**: The test first sends a completed agent message saying `streamed answer`. It then sends a turn-completed notification with an empty item list. The processor emits turn completion and still returns `streamed answer` as the final message.

**Call relations**: The test runner invokes this test. It confirms that turn completion does not blindly clear the stored final message when there is no replacement item.

*Call graph*: calls 1 internal fn (new); 4 external calls (ItemCompleted, TurnCompleted, new, assert_eq!).


##### `failed_turn_clears_stale_final_message`  (lines 1502–1544)

```
fn failed_turn_clears_stale_final_message()
```

**Purpose**: Ensures that a failed turn does not leave a partial agent message behind as the final answer. This prevents callers from treating incomplete work as success.

**Data flow**: The test first sends a completed agent message saying `partial answer`, and the processor stores it. Then it sends a failed turn-completed notification. The processor enters shutdown status and `final_message()` becomes `None`.

**Call relations**: The test runner calls this test. It drives the processor through a partial answer followed by turn failure, checking that failure cleanup overrides earlier message storage.

*Call graph*: calls 1 internal fn (new); 4 external calls (ItemCompleted, TurnCompleted, new, assert_eq!).


##### `turn_completion_falls_back_to_final_plan_text`  (lines 1547–1579)

```
fn turn_completion_falls_back_to_final_plan_text()
```

**Purpose**: Checks that if a completed turn has no agent message but does have a final plan item, the plan text can be used as the final message. This gives callers a useful result in plan-only responses.

**Data flow**: The test sends a completed turn containing a `Plan` item with text. The processor emits turn completion and stores that plan text as the final message.

**Call relations**: The test runner invokes this test. It exercises the fallback logic in turn completion that looks beyond agent messages when deciding what final text to return.

*Call graph*: calls 1 internal fn (new); 3 external calls (TurnCompleted, assert_eq!, vec!).


##### `turn_failure_prefers_structured_error_message`  (lines 1582–1631)

```
fn turn_failure_prefers_structured_error_message()
```

**Purpose**: Verifies that a failed turn reports the best available structured error message. If the server sent extra details, the processor should include them in the user-visible failure event.

**Data flow**: The test first sends an error notification with message `backend failed` and additional details `request id abc`; the processor emits an error event with both pieces combined. Then a failed turn completion with no embedded error causes the processor to emit `TurnFailed` using the stored structured error message.

**Call relations**: The test runner calls this test. It checks cooperation between the error-notification path and the later turn-completion path, showing that the processor remembers the latest meaningful error for final failure reporting.

*Call graph*: calls 1 internal fn (new); 4 external calls (Error, TurnCompleted, new, assert_eq!).


##### `model_reroute_surfaces_as_error_item`  (lines 1634–1659)

```
fn model_reroute_surfaces_as_error_item()
```

**Purpose**: Checks that when the backend reroutes from one model to another, the JSON stream shows a visible error-style item explaining the reroute. This makes an important model change visible to users and automation.

**Data flow**: The test sends a model-rerouted notification from `gpt-5` to `gpt-5-mini` with a reason. The processor returns one completed error item with ID `item_0` and a message naming the old model, new model, and reason.

**Call relations**: The test runner invokes this test. It sends a `ModelRerouted` notification through `collect_thread_events`, then pattern-checks that the single returned event is the expected completed error item.

*Call graph*: calls 1 internal fn (new); 3 external calls (ModelRerouted, assert_eq!, panic!).


### Integration test harness
These files define the shared integration-test crate and module index that collect the exec end-to-end suites into one runnable test binary.

### `exec/tests/all.rs`

`test` · `test run`

This file is like the table of contents for a set of integration tests. In Rust, integration tests often live outside the main source code and are compiled as separate test programs. Here, this file creates one such test program and pulls in the actual test modules from elsewhere.

The line allowing `clippy::expect_used` relaxes a lint rule for these tests. `expect` is a Rust method that deliberately stops the test with a clear message if something goes wrong. That can be acceptable in tests because a quick, obvious failure is often better than complex error handling.

The `mod suite;` line includes the broader test suite from `tests/suite/`. The `mod event_processor_with_json_output;` line includes another focused test module. This file does not contain test logic itself; it makes sure the test logic is compiled and visible to Rust’s test runner.

Without this file, those integration test modules might not be included in the test binary, meaning important behavior could silently go untested.


### `exec/tests/suite/mod.rs`

`test` · `test discovery and test build`

This is a small but important directory map for the integration tests. Each `mod ...;` line tells Rust to include another test file from the same folder as a module. In plain terms, it is like a table of contents for this test suite: it does not contain the tests itself, but it points to all the chapters where the real checks live.

The listed modules cover different behaviors of the executable, such as adding directories, reading agent instructions, applying patches, approval policy behavior, authentication through environment variables, sandboxing, resume behavior, schema output, standard input prompts, and error exits. By gathering them here, the project can keep tests split into focused files while still presenting them as one organized suite to Rust’s test system.

There is no runtime feature logic here. Its job is purely structural. If a new test file is added to this folder but not listed here, it may sit unused. If a module name is removed or misspelled, the related tests will not compile into the suite, or the build may fail if Rust cannot find the referenced file.


### Request construction and prompt inputs
These integration tests cover how codex-exec builds outbound requests from prompts, stdin, workspace instructions, auth, headers, schemas, and writable-directory flags.

### `exec/tests/suite/add_dir.rs`

`test` · `test run`

This is a small test file for the non-Windows version of the executable. Its job is not to check what the tool does inside the extra directories, but to confirm that the command-line flag itself is understood and does not cause the program to fail.

Each test creates a fake server that pretends to be the remote service the tool normally talks to. The fake server sends a simple stream of events: a response starts, an assistant message is returned, and the response completes. This keeps the test focused on the command-line behavior instead of depending on a real network service.

The tests then create temporary folders and pass their paths using `--add-dir`. They also choose the `workspace-write` sandbox mode, which is the mode where extra writable folders matter. Finally, they run the command and require it to exit with code `0`, meaning success.

An everyday analogy: this file checks that the front desk accepts extra guest names on a booking form. It does not inspect the guests' rooms; it only makes sure the form can be submitted successfully with those extra names.

#### Function details

##### `accepts_add_dir_flag`  (lines 10–38)

```
async fn accepts_add_dir_flag() -> anyhow::Result<()>
```

**Purpose**: This test checks that the executable accepts the `--add-dir` flag when it is used more than once. It proves that adding extra directory paths to the command line still lets the command finish successfully.

**Data flow**: The test starts with a test command builder and a mock server. It prepares a fake server response, creates two temporary directories, and then runs the executable with those two paths passed through separate `--add-dir` flags. The expected result is that the process exits with code `0`; the temporary directories are only used as safe throwaway paths for the test.

**Call relations**: During the test, `test_codex_exec` provides the executable runner, `start_mock_server` creates the fake remote service, `sse` builds the fake streamed response, and `mount_sse_once` attaches that response to the server. The test then runs the command against that server and checks the exit code, so the broader flow is: set up fake service, provide real-looking directory paths, run the command, confirm success.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (tempdir, vec!).


##### `accepts_multiple_add_dir_flags`  (lines 42–72)

```
async fn accepts_multiple_add_dir_flags() -> anyhow::Result<()>
```

**Purpose**: This test checks the same feature with three `--add-dir` flags. It makes sure the command-line parser and execution path can accept several extra directories, not just one or two.

**Data flow**: The test creates a command runner, starts a mock server, prepares a fake successful response, and creates three temporary directories. It passes all three paths to the executable as repeated `--add-dir` arguments, along with sandbox settings and a prompt. The output that matters is the process result: it must finish with exit code `0`.

**Call relations**: Like the first test, this function relies on the support helpers to create a controlled command run and a fake server response. `test_codex_exec` supplies the command wrapper, `start_mock_server` and `mount_sse_once` make the server ready, and `sse` packages the response events. Once setup is complete, the function hands the arguments to the executable and verifies that the overall command flow accepts multiple added directories.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (tempdir, vec!).


### `exec/tests/suite/agents_md.rs`

`test` · `test run`

This test file protects an important user-facing behavior: a workspace can contain instruction files that tell Codex how to behave in that project. Without these tests, the command-line tool might accidentally stop including those instructions in requests, or might include the wrong file when an override is present.

Each test creates a temporary fake workspace, writes instruction files into it, and starts a mock server. A mock server is a pretend API endpoint used during tests so no real network call is made. The test then runs the `codex exec` command against that server and checks what the command sent.

The first test checks the simple case: if the workspace has an `AGENTS.md` file, its text should appear in the user-facing request sent to the server. The second test checks the priority rule: if both `AGENTS.md` and `AGENTS.override.md` exist, the override file should be used and the base file should be ignored. This is like putting a newer sticky note over an older one; the visible note is the one Codex should follow.

The mocked server returns a small fake streaming response so the command can complete normally. Afterward, the tests inspect the captured request and assert that the right instruction text was included.

#### Function details

##### `exec_includes_workspace_agents_md_in_request`  (lines 7–34)

```
async fn exec_includes_workspace_agents_md_in_request() -> anyhow::Result<()>
```

**Purpose**: This test proves that `codex exec` includes instructions from a workspace-level `AGENTS.md` file in the request it sends to the model. It is used to catch regressions where workspace guidance would be silently ignored.

**Data flow**: The test starts with a temporary Codex execution workspace, then writes an `AGENTS.md` file containing `workspace instructions`. It starts a mock server and prepares a fake streamed response. It runs the command with a normal prompt, then reads the request captured by the mock server. The expected outcome is that at least one user message sent to the server contains the text from `AGENTS.md`; if not, the test fails.

**Call relations**: The test uses `test_codex_exec` to build an isolated command environment, `start_mock_server` to create a fake API server, `sse` to build the fake streamed response, and `mount_sse_once` to attach that response to the server. After the command runs, the captured mock request becomes the evidence used by the final assertion.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 3 external calls (assert!, write, vec!).


##### `exec_prefers_workspace_agents_override_md`  (lines 37–74)

```
async fn exec_prefers_workspace_agents_override_md() -> anyhow::Result<()>
```

**Purpose**: This test proves that `AGENTS.override.md` replaces `AGENTS.md` when both files are present in the workspace. It protects the rule that an explicit override should win over the default instruction file.

**Data flow**: The test creates a temporary workspace and writes two instruction files: `AGENTS.md` with `base instructions` and `AGENTS.override.md` with `override instructions`. It starts a mock server, prepares a fake streamed response, and runs `codex exec` with a prompt. Then it inspects the user messages in the captured request. The expected result is that the override text is present and the base text is absent.

**Call relations**: Like the other test, it relies on `test_codex_exec` for a temporary command setup, `start_mock_server` for a pretend API endpoint, `sse` for a fake server stream, and `mount_sse_once` to record the single outgoing request. The assertions then confirm the command followed the intended file-priority behavior.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 3 external calls (assert!, write, vec!).


### `exec/tests/suite/auth_env.rs`

`test` · `test run`

This is a small integration test for the `codex exec` command. The real problem it checks is simple: when a user runs Codex from a terminal or script, the tool must prove who it is to the Codex API. In this test setup, that proof is an API key, and the command is expected to send it as an HTTP `Authorization` header, which is like showing an ID card at the door.

The test starts a fake server instead of talking to the real Codex service. That fake server is told to expect exactly one server-sent events response, but only if the incoming request includes `Authorization: Bearer dummy`. Server-sent events are a way for a server to stream progress messages back over one web connection.

Then the test runs `codex exec` against the fake server, points it at the repository root, and asks it to run a simple prompt: `echo testing codex api key`. If the command includes the expected API key header, the fake server returns a completed event and the command exits successfully. If the header is missing or wrong, the mock server would not match the request, and the test would fail. Without this test, a regression could silently break API-key authentication for command-line execution.

#### Function details

##### `exec_uses_codex_api_key_env_var`  (lines 10–31)

```
async fn exec_uses_codex_api_key_env_var() -> anyhow::Result<()>
```

**Purpose**: This test proves that `codex exec` uses the configured Codex API key when it talks to the API. It does this by requiring the outgoing request to contain `Authorization: Bearer dummy` and then checking that the command succeeds.

**Data flow**: The test starts with a prepared `codex exec` test command, a fake web server, and the repository root path. It programs the fake server to accept a request only when the authorization header contains the dummy API key, then to stream back a completed response. It then runs the command with the fake server and a simple prompt. The result is a successful command exit if the API key was sent correctly; otherwise the request would not match the fake server setup and the assertion would fail.

**Call relations**: During the test, it calls `test_codex_exec` to build the command under test, `start_mock_server` to create the fake API server, and `repo_root` to choose a working directory. It uses `header` to describe the required authorization header, wraps a completed event with `ev_completed` and `sse`, and registers that expected response through `mount_sse_once_match`. After that setup, the command is run and the success assertion confirms that all the pieces lined up.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex_exec); 3 external calls (repo_root, vec!, header).


### `exec/tests/suite/originator.rs`

`test` · `test run`

This is a test file, and it only runs on non-Windows systems. Its job is to protect a small but important piece of communication between the `codex-exec` command-line tool and the server it calls. When `codex-exec` sends a request, it includes an `Originator` header, which is like a label on a package saying who sent it. The server can use that label for tracking, routing, logging, or policy decisions.

The tests do not contact a real Codex server. Instead, they start a mock server, which is a fake server built just for the test. The mock server is told to expect one request with a specific `Originator` header. It then replies with a small stream of fake server-sent events, meaning messages delivered over one long response rather than as separate requests.

There are two cases. The first confirms the normal behavior: `codex-exec` sends `Originator: codex_exec`. The second confirms the override behavior: if `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` is set, `codex-exec` uses that value instead. In both cases, the command is expected to finish successfully with exit code `0`. Without these tests, a change could silently remove or rename this header, and server-side behavior depending on it could break.

#### Function details

##### `send_codex_exec_originator`  (lines 12–31)

```
async fn send_codex_exec_originator() -> anyhow::Result<()>
```

**Purpose**: This test checks the default behavior of `codex-exec`: when no override is present, it should identify itself to the server with the `Originator` header value `codex_exec`.

**Data flow**: The test starts by creating a test wrapper for running `codex-exec`, then starts a fake server. It builds a fake streaming response containing a created event, an assistant message, and a completed event. The fake server is configured to accept one request only if that request includes `Originator: codex_exec`. The test then runs `codex-exec`, explicitly removes the originator override environment variable, passes a sample prompt, and expects the command to exit successfully with code `0`.

**Call relations**: This function uses `test_codex_exec` to prepare a runnable command, `start_mock_server` to stand in for the real server, `sse` to build the fake streamed response, and `mount_sse_once_match` with `header` to make the mock server check the outgoing header. It proves the normal request path is sending the expected label before the command receives the fake server response.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex_exec); 2 external calls (vec!, header).


##### `supports_originator_override`  (lines 34–54)

```
async fn supports_originator_override() -> anyhow::Result<()>
```

**Purpose**: This test checks that `codex-exec` respects the internal override environment variable for the `Originator` header. This allows tests or special internal uses to change the caller label sent to the server.

**Data flow**: The test creates a `codex-exec` test command and starts a fake server. It prepares the same kind of fake streaming response as the default-originator test. This time, the fake server expects the request header `Originator: codex_exec_override`. The test runs `codex-exec` with `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` set to `codex_exec_override`, sends a sample prompt, and checks that the command exits with code `0`.

**Call relations**: Like the default-originator test, this function relies on `test_codex_exec` for launching the command, `start_mock_server` for a controlled server, `sse` for the response body, and `mount_sse_once_match` plus `header` to verify the exact request header. It covers the alternate path where environment configuration changes what `codex-exec` sends to the server.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex_exec); 2 external calls (vec!, header).


### `exec/tests/suite/output_schema.rs`

`test` · `test run`

This is an automated test for a command-line feature. The feature lets a user pass `--output-schema` with a path to a JSON Schema file. A JSON Schema is a document that describes the shape of allowed JSON, like saying “the answer must be an object with a string field named `answer`.”

The test builds a small temporary schema file, starts a fake model server, and makes that server return a simple streamed response. Using a fake server matters because the test can inspect exactly what the command tried to send without calling a real external service.

Then the test runs the `codex exec` command with the schema path, a model name, a working directory flag, and a prompt. After the command succeeds, the test looks at the single HTTP request received by the fake server. It checks that the request contains a `text.format` section with the expected structured-output settings: a fixed name, the type `json_schema`, strict mode enabled, and the exact schema read from disk.

Without this test, the command could accidentally ignore the schema file, send it in the wrong shape, or stop marking it as strict, and users relying on machine-readable output would get unreliable results. The file is disabled on Windows, likely because this test suite or its command setup is intended for Unix-like environments.

#### Function details

##### `exec_includes_output_schema_in_request`  (lines 9–62)

```
async fn exec_includes_output_schema_in_request() -> anyhow::Result<()>
```

**Purpose**: This test proves that when `codex exec` is run with `--output-schema`, the schema file is included in the outgoing request to the model server. It uses a mock server so it can verify the request safely and repeatably.

**Data flow**: The test starts with a hard-coded JSON schema and writes it to a temporary `schema.json` file. It then starts a mock server, prepares a fake streamed response, and runs the command-line tool with the schema path and a prompt. After the command finishes successfully, it reads the mock server’s captured request, extracts the JSON body, and compares the `text.format` field against the exact structure the server should receive.

**Call relations**: This function is the whole test case. It calls the test helper that creates an isolated `codex exec` command environment, uses response helpers to start and configure the mock server, writes the schema file to disk, and finally uses an equality assertion to confirm that the command handed the expected schema information to the request layer.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 5 external calls (assert_eq!, json!, to_vec_pretty, write, vec!).


### `exec/tests/suite/prompt_stdin.rs`

`test` · `test run`

This test file checks a small but important command-line behavior: what happens when a person runs `codex exec` with text piped into it. Standard input, often called stdin, is the stream of text a program can receive from another command, like `echo "text" | codex exec ...`. The tests make sure that stdin is treated differently depending on how the user invoked the command.

If the user gives a normal prompt argument and also pipes in non-empty stdin, the tool should keep the prompt and append the piped text inside a `<stdin>...</stdin>` block. That makes the final request clear: the user asked something, and the piped text is supporting material. If the prompt argument exists but stdin is empty, the prompt should be sent unchanged.

The file also protects older behavior: if the prompt argument is `-`, or if there is no prompt argument at all, then stdin becomes the prompt itself. But empty stdin is not acceptable in those cases, because the tool would have no actual question or instruction to send. The tests use a mock server instead of a real model service, like a rehearsal stage where the outgoing request can be inspected safely.

#### Function details

##### `exec_appends_piped_stdin_to_prompt_argument`  (lines 9–40)

```
async fn exec_appends_piped_stdin_to_prompt_argument() -> anyhow::Result<()>
```

**Purpose**: This test proves that when a user provides both a prompt argument and non-empty piped stdin, `codex exec` combines them into one user message. The prompt stays first, and the piped input is added as labeled stdin context.

**Data flow**: The test starts a fake model server and prepares a simple fake streaming response. It runs `codex exec` with a prompt, writes `my output\n` into stdin, and waits for the command to succeed. Then it inspects the single request sent to the fake server and checks that the user message contains `Summarize this concisely`, followed by a blank line and a `<stdin>` block containing the piped text.

**Call relations**: During the test, `test_codex_exec` creates the command runner, while `start_mock_server`, `sse`, and `mount_sse_once` set up the fake server response. After the command runs, the test uses an assertion to verify that the request body sent to the server follows the expected prompt-plus-stdin format.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (assert!, vec!).


##### `exec_ignores_empty_piped_stdin_when_prompt_argument_is_present`  (lines 43–73)

```
async fn exec_ignores_empty_piped_stdin_when_prompt_argument_is_present() -> anyhow::Result<()>
```

**Purpose**: This test makes sure empty stdin does not change a prompt that was already provided on the command line. It prevents the tool from adding an empty `<stdin>` block that would be noisy and unhelpful.

**Data flow**: The test prepares a fake server response, runs `codex exec` with the prompt `Summarize this concisely`, and writes an empty string to stdin. After the command succeeds, it reads the recorded request from the fake server. The expected output is a user message containing only the original prompt, with no extra stdin wrapper.

**Call relations**: The test uses the same fake execution setup as the other server-backed tests: `test_codex_exec` builds the test command, and the response helpers create and attach a mock model response. The final assertion checks the outgoing request so this behavior is verified at the boundary where the command talks to the model service.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (assert!, vec!).


##### `exec_dash_prompt_reads_stdin_as_the_prompt`  (lines 76–107)

```
async fn exec_dash_prompt_reads_stdin_as_the_prompt() -> anyhow::Result<()>
```

**Purpose**: This test checks the special `-` prompt form, where stdin is intentionally used as the whole prompt. This is a common command-line convention: a dash often means “read this value from standard input.”

**Data flow**: The test starts a fake server, runs `codex exec` with `-` as the prompt argument, and writes `prompt from stdin\n` into stdin. The command should succeed. The test then inspects the request and confirms that the user message is exactly the stdin text, not wrapped in a `<stdin>` context block and not combined with any other prompt.

**Call relations**: The mock server helpers provide a safe stand-in for the real model service, and `test_codex_exec` runs the command against that server. The assertion at the end confirms that the dash path still behaves as a direct stdin-to-prompt path.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (assert!, vec!).


##### `exec_without_prompt_argument_reads_piped_stdin_as_the_prompt`  (lines 110–140)

```
async fn exec_without_prompt_argument_reads_piped_stdin_as_the_prompt() -> anyhow::Result<()>
```

**Purpose**: This test verifies that if the user does not pass a prompt argument but does pipe in text, `codex exec` treats that piped text as the prompt. This preserves the natural shell workflow of sending text directly into the command.

**Data flow**: The test creates a fake model server and runs `codex exec` without a prompt argument. It writes `prompt from stdin\n` into stdin and expects the command to finish successfully. It then checks the request received by the fake server and confirms that the user message is exactly the piped stdin text.

**Call relations**: As with the other async tests, the command runner comes from `test_codex_exec`, and the response helpers provide a fake streaming reply from the server. The test focuses on the request that the command sends outward, proving that missing prompt plus non-empty stdin becomes a valid model prompt.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (assert!, vec!).


##### `exec_without_prompt_argument_rejects_empty_piped_stdin`  (lines 143–155)

```
fn exec_without_prompt_argument_rejects_empty_piped_stdin()
```

**Purpose**: This test makes sure `codex exec` fails clearly when the user gives no prompt argument and stdin is empty. Without this check, the tool might send an empty request or fail later in a more confusing way.

**Data flow**: The test builds a command with no prompt argument, writes empty stdin, and runs it without using a fake model server because no model request should be made. The expected result is exit code 1 and an error message saying `No prompt provided via stdin.`

**Call relations**: `test_codex_exec` provides the command under test, and the string predicate checks the error output. This test covers the early validation path, before any network request would be sent.

*Call graph*: calls 1 internal fn (test_codex_exec); 1 external calls (contains).


##### `exec_dash_prompt_rejects_empty_piped_stdin`  (lines 158–171)

```
fn exec_dash_prompt_rejects_empty_piped_stdin()
```

**Purpose**: This test checks that `codex exec -` also fails when stdin is empty. Since `-` means “use stdin as the prompt,” empty stdin means there is no prompt to send.

**Data flow**: The test runs `codex exec` with `-` as the prompt argument and writes an empty string to stdin. It expects the command to exit with code 1 and print `No prompt provided via stdin.` to standard error. Nothing is sent to a model server.

**Call relations**: `test_codex_exec` creates the command, and the error-message predicate checks that the failure is understandable. This complements the non-empty dash test by confirming that the special stdin prompt mode rejects missing input.

*Call graph*: calls 1 internal fn (test_codex_exec); 1 external calls (contains).


### Execution modes and lifecycle
These tests exercise approval behavior, session persistence and resume, hooks, patch-capable flows, and startup/runtime failure exits across the codex-exec binary surface.

### `exec/tests/suite/approval_policy.rs`

`test` · `test execution`

This is a small test file for the non-Windows version of the `codex exec` command. The real problem it guards against is confusing or unsafe approval behavior. The user may have a config file saying approvals are normally `on-request`, with an automatic reviewer enabled. These tests check that the command does not accidentally rewrite or hide that policy in its startup output.

The file builds a fake home directory, writes a `config.toml` into it, and starts a mock server. The mock server pretends to be the remote assistant service and sends a short streamed response: a response is created, the assistant says `done`, and the response completes. This lets the command run as if it had talked to the real service, without using the network or depending on outside systems.

The shared helper runs `codex exec` with optional extra command-line arguments, captures its standard error output, and returns it as text. Each test then looks for a specific phrase such as `approval: on-request` or `approval: never`. In plain terms, the tests are checking the label printed on the dashboard before the run begins. If this file failed, users could get misleading approval-mode reporting, especially in high-trust modes like full-auto or bypass.

#### Function details

##### `run_exec_with_auto_review_config`  (lines 7–35)

```
async fn run_exec_with_auto_review_config(extra_args: &[&str]) -> anyhow::Result<String>
```

**Purpose**: This helper sets up a realistic test run of `codex exec` using a temporary configuration where approvals are `on-request` and the reviewer is automatic. It runs the command, waits for it to finish successfully, and returns the command's standard error text so the tests can inspect what approval mode was printed.

**Data flow**: It takes a list of extra command-line arguments, such as full-auto or bypass flags. It creates a test environment, writes a config file into the fake home directory, starts a mock assistant server, prepares one fake streamed response, and runs `codex exec` against that server. If the command succeeds, it converts the captured standard error bytes into a readable string and returns that string; if setup or execution fails, it returns an error.

**Call relations**: The three test functions call this helper so they do not each have to repeat the same setup. Inside, it asks the test support code to create a fake `codex exec` command, asks the response helpers to start and prepare the mock server, mounts the fake streamed response, then hands the resulting stderr text back to the caller for the final assertion.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); called by 3 (exec_bypass_preserves_never_for_auto_review_config, exec_full_auto_preserves_never_for_auto_review_config, exec_preserves_on_request_for_auto_review_config); 4 external calls (from_utf8, assert!, write, vec!).


##### `exec_preserves_on_request_for_auto_review_config`  (lines 38–46)

```
async fn exec_preserves_on_request_for_auto_review_config() -> anyhow::Result<()>
```

**Purpose**: This test checks the default case: when the config says approvals are `on-request`, running `codex exec` without special override flags should still report `approval: on-request`.

**Data flow**: It calls the shared helper with no extra command-line arguments. The helper returns the command's standard error output as text. The test then searches that text for `approval: on-request`; if the phrase is missing, the test fails and prints the captured output to help explain what went wrong.

**Call relations**: This is one of the direct test cases that relies on `run_exec_with_auto_review_config` for all setup and command execution. It represents the baseline behavior that the later override-mode tests compare against.

*Call graph*: calls 1 internal fn (run_exec_with_auto_review_config); 1 external calls (assert!).


##### `exec_bypass_preserves_never_for_auto_review_config`  (lines 49–58)

```
async fn exec_bypass_preserves_never_for_auto_review_config() -> anyhow::Result<()>
```

**Purpose**: This test checks the dangerous bypass mode. When `codex exec` is run with the flag that bypasses approvals and sandboxing, it should report approvals as `never`, even if the config file normally says `on-request`.

**Data flow**: It passes the bypass flag into the shared helper. The helper runs the command in the fake environment and returns stderr as text. The test then checks that the text contains `approval: never`; if not, it fails with a message showing the actual output.

**Call relations**: This test uses the same setup path as the baseline test but adds the bypass command-line argument. It depends on `run_exec_with_auto_review_config` to simulate the command run, then verifies that the command-line override is reflected in the reported approval mode.

*Call graph*: calls 1 internal fn (run_exec_with_auto_review_config); 1 external calls (assert!).


##### `exec_full_auto_preserves_never_for_auto_review_config`  (lines 61–69)

```
async fn exec_full_auto_preserves_never_for_auto_review_config() -> anyhow::Result<()>
```

**Purpose**: This test checks full-auto mode. In that mode, `codex exec` should report approvals as `never`, rather than keeping the configured `on-request` wording.

**Data flow**: It sends the `--full-auto` flag to the shared helper. The helper runs `codex exec` using the fake config and mock server, then returns the captured stderr text. The test searches that text for `approval: never` and fails if the expected wording is absent.

**Call relations**: Like the bypass test, this test is built on `run_exec_with_auto_review_config`. It covers a different command-line shortcut that also changes the effective approval policy, making sure the command reports that final policy clearly.

*Call graph*: calls 1 internal fn (run_exec_with_auto_review_config); 1 external calls (assert!).


### `exec/tests/suite/ephemeral.rs`

`test` · `test run`

This test file checks a simple but important promise: normal runs of `codex exec` should save a session history file, while ephemeral runs should not. “Ephemeral” here means temporary, like writing on a whiteboard instead of in a notebook. The command may still talk to the model and produce output, but it should not leave a saved session transcript in the test home directory.

The tests avoid calling the real service directly. Instead, they start a mock server, which is a small fake web server used during tests. The helper `exec_sse_response` builds a fake streaming response from the assistant. SSE means “server-sent events,” a web format where a server sends updates one after another over a single connection.

After running the command, the tests inspect the fake home directory. The helper `session_rollout_count` walks through the `sessions` folder and counts `.jsonl` files, which are line-by-line JSON log files used here as saved session rollouts. One test confirms that a normal command creates exactly one such file. The other runs the same kind of command with `--ephemeral` and confirms that no file is created. These tests are skipped when network-style test support is unavailable.

#### Function details

##### `exec_sse_response`  (lines 10–16)

```
fn exec_sse_response() -> String
```

**Purpose**: Builds the fake assistant response used by these tests. It creates a small scripted stream saying that a response was created, an assistant message arrived, and the response completed.

**Data flow**: It takes no input. It asks the shared test response helpers to package three events into one server-sent-events text stream, then returns that stream as a string for the mock server to send back.

**Call relations**: Both test cases call this when preparing the fake server. The returned stream is handed to the response-mounting helper so the command under test receives a realistic-looking model response without needing the real model service.

*Call graph*: calls 1 internal fn (sse); called by 2 (does_not_persist_rollout_file_in_ephemeral_mode, persists_rollout_file_by_default); 1 external calls (vec!).


##### `session_rollout_count`  (lines 18–30)

```
fn session_rollout_count(home_path: &std::path::Path) -> usize
```

**Purpose**: Counts how many saved session rollout files exist under a test home directory. This lets the tests check whether running the command left a persisted session record behind.

**Data flow**: It receives a path to the fake home directory. It looks for a `sessions` subfolder; if that folder is missing, it returns zero. If it exists, it walks through all files below it, keeps only files whose names end in `.jsonl`, and returns the count.

**Call relations**: After each command run, the tests use this helper as their measuring stick. It turns the filesystem result into a simple number that can be compared with the expected outcome: one file for default behavior, zero files for ephemeral behavior.

*Call graph*: 2 external calls (join, new).


##### `persists_rollout_file_by_default`  (lines 33–48)

```
async fn persists_rollout_file_by_default() -> anyhow::Result<()>
```

**Purpose**: Checks the normal behavior of `codex exec`: when no ephemeral flag is given, the command should save one session rollout file.

**Data flow**: It first skips the test if the needed network-style test setup is unavailable. Then it creates a test command environment, starts a mock server, installs the fake streaming assistant response, and runs `codex exec` with a sample prompt. After confirming the command exits successfully, it counts saved rollout files in the fake home directory and expects exactly one.

**Call relations**: This is one of the two main test cases in the file. It uses `test_codex_exec` to build the command under test, `exec_sse_response` and the response mounting helper to fake the server reply, and then the rollout-counting helper to verify that default persistence happened.

*Call graph*: calls 3 internal fn (mount_sse_once, test_codex_exec, exec_sse_response); 3 external calls (start, assert_eq!, skip_if_no_network!).


##### `does_not_persist_rollout_file_in_ephemeral_mode`  (lines 51–67)

```
async fn does_not_persist_rollout_file_in_ephemeral_mode() -> anyhow::Result<()>
```

**Purpose**: Checks the special `--ephemeral` behavior: the command should run successfully but should not save a session rollout file.

**Data flow**: It first skips the test if the needed network-style test setup is unavailable. Then it creates a test command environment, starts a mock server, installs the fake streaming assistant response, and runs `codex exec` with `--ephemeral` plus a sample prompt. After confirming a successful exit code, it counts saved rollout files and expects zero.

**Call relations**: This test mirrors the default-persistence test, but adds the `--ephemeral` argument before running the command. By using the same fake server response and the same counting check, it isolates the difference to the command-line flag and proves that the flag suppresses saved session output.

*Call graph*: calls 3 internal fn (mount_sse_once, test_codex_exec, exec_sse_response); 3 external calls (start, assert_eq!, skip_if_no_network!).


### `exec/tests/suite/hooks.rs`

`test` · `automated test run`

This is an automated test for the hook system used by the exec command. A hook is a user-defined action that runs at a certain moment, like a doorbell that rings when a session begins. Here, the moment being tested is `SessionStart`, which means “right when a new exec session starts.”

The test builds a temporary fake home directory and writes a `hooks.json` file into it. That file says: when the session starts, run a shell command that creates a marker file. The marker file is the test’s proof that the hook actually ran.

Because the exec command also talks to a server, the test starts a mock server instead of using a real network service. The mock server sends back a simple streamed response: a response is created, the assistant says “done,” and the response completes. This keeps the test focused on the hook behavior rather than on real server behavior.

The command is then run with two important flags: one skips the Git repository safety check, and the other deliberately bypasses hook trust checks. After the command finishes successfully, the test checks that the marker file exists. If it does not, the session-start hook failed to run. This test is disabled on Windows because it uses Unix-style shell behavior such as `touch`.

#### Function details

##### `exec_hook_trust_bypass_runs_session_start_hook`  (lines 8–43)

```
async fn exec_hook_trust_bypass_runs_session_start_hook() -> anyhow::Result<()>
```

**Purpose**: This test proves that the exec command runs a `SessionStart` hook when the user passes the dangerous trust-bypass flag. It uses a marker file as visible evidence that the hook command was executed.

**Data flow**: The test starts by creating an isolated test exec environment and choosing a path for a marker file. It writes a hook configuration file that tells the program to run `touch <marker file>` at session start. It then starts a mock server and prepares a short fake streamed assistant response. Next, it runs the exec command against that server with the hook trust bypass flag enabled. If the command succeeds, the test looks for the marker file; the file’s presence is the output that proves the hook ran.

**Call relations**: This test relies on `test_codex_exec` to build a safe temporary command environment, then uses the response helpers to start a mock server, build a streamed response, and mount that response for one request. After those pieces are in place, the test launches the command and finally uses an assertion to verify the side effect created by the hook.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 6 external calls (assert!, format!, json!, to_vec_pretty, write, vec!).


### `exec/tests/suite/mcp_required_exit.rs`

`test` · `test run`

This is a focused integration test for the Codex executable. MCP means “Model Context Protocol,” a way for Codex to connect to extra helper servers that can provide tools or context. In this test, the configuration says there is one required MCP server, but its command points to a fake program name that cannot exist. That creates the same situation as a user installing a bad configuration or deleting a needed helper program.

The test then starts a mock HTTP server to stand in for the normal model service, so the command has somewhere to send its request if it gets that far. The mock is prepared to return a simple streaming response saying “hello.” This keeps the rest of the environment controlled and predictable.

Finally, the test runs the Codex command with that configuration. The important check is not the model response. The important check is that Codex exits with status code 1, meaning failure, and prints an error naming the required MCP server that failed to initialize. Without this behavior, Codex might appear to work while missing a tool the user explicitly said was mandatory.

#### Function details

##### `exits_non_zero_when_required_mcp_server_fails_to_initialize`  (lines 9–38)

```
async fn exits_non_zero_when_required_mcp_server_fails_to_initialize() -> anyhow::Result<()>
```

**Purpose**: This test verifies that Codex refuses to continue successfully when a required MCP server cannot be launched. It checks both the failure exit code and the human-readable error message.

**Data flow**: The test starts by creating an isolated Codex test environment. It writes a config file into that environment declaring a required MCP server whose command is deliberately fake. It then starts a mock server and prepares a simple streamed response, runs the Codex command against that server, and checks the result: the process must exit with code 1 and its error output must mention the broken required server by name.

**Call relations**: The test uses test_codex_exec to create a safe command-running sandbox, start_mock_server to provide a fake backend service, sse and mount_sse_once to prepare the mock streamed response, and contains to check the error text. These helpers set the stage so the test can focus on one story: when required MCP startup fails, the command reports that failure and exits unsuccessfully.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 3 external calls (contains, write, vec!).


### `exec/tests/suite/apply_patch.rs`

`test` · `test run`

This test file checks the patch-editing path from two angles. First, it treats `codex-exec` as a small standalone command-line tool and feeds it a patch by hand. That proves the executable can still act like the older `apply_patch` tool, even if the larger `codex` command grows other subcommands later. Second, it simulates a model-driven session: a mock server sends fake streaming responses, including tool calls that ask Codex to add or update files. The test then runs `codex-exec` against that mock server and checks the files on disk afterward.

The everyday analogy is a proofreader sending marked-up pages to an assistant. These tests make sure the assistant not only reads the markup, but actually replaces the right sentences in the final document.

The tests use temporary folders so they do not touch the developer’s real files. The network-style tests are skipped on Windows and can also skip when networking is unavailable. They use a mock server, meaning no real AI service is needed; the server simply plays back prepared events. What matters is the end result: files are created or changed exactly as the patch instructions say.

#### Function details

##### `test_standalone_exec_cli_can_use_apply_patch`  (lines 19–45)

```
fn test_standalone_exec_cli_can_use_apply_patch() -> anyhow::Result<()>
```

**Purpose**: This test proves that the `codex-exec` binary can be used directly as an `apply_patch`-style command. It matters because other tools or users may rely on this smaller executable to apply a patch without running a full Codex session.

**Data flow**: It starts with a new temporary directory and writes a file named `source.txt` containing `original content`. It then launches the `codex-exec` program, passes the special apply-patch argument and a patch that changes the text, and runs the command inside that temporary directory. The expected result is a successful command, a clear success message on standard output, no error output, and the file changed to `modified by apply_patch`.

**Call relations**: This is a direct command-line test. It creates test data with temporary-file and file-writing helpers, finds the built `codex-exec` binary, runs it with the patch argument, and then uses assertions to check both the command output and the final file contents.

*Call graph*: 6 external calls (assert_eq!, new, cargo_bin, write, is_empty, tempdir).


##### `test_apply_patch_tool`  (lines 49–93)

```
async fn test_apply_patch_tool() -> anyhow::Result<()>
```

**Purpose**: This test checks that `codex-exec` obeys apply-patch tool calls that arrive during a simulated AI conversation. It verifies the normal structured patch flow: first adding a file, then updating that file.

**Data flow**: It prepares two patch strings: one that creates `test.md` with `Hello world`, and another that changes that text to `Final text`. It builds fake server-sent event streams, which are streamed messages from a server to a client, containing tool-call events and completion events. After mounting those responses on a mock server, it runs `codex-exec` against that server. When the run finishes, it reads `test.md` from the test working directory and expects the final contents to be `Final text`.

**Call relations**: This test depends on the mock-server helpers to stand in for the real remote service. It calls `start_mock_server` to create the fake server, `mount_sse_sequence` to preload the server’s streamed responses, and then runs the test `codex-exec` command. The patch events handed out by the mock server drive the file edits that the final assertion checks.

*Call graph*: calls 2 internal fn (mount_sse_sequence, start_mock_server); 4 external calls (assert_eq!, skip_if_no_network!, read_to_string, vec!).


##### `test_apply_patch_freeform_tool`  (lines 97–147)

```
async fn test_apply_patch_freeform_tool() -> anyhow::Result<()>
```

**Purpose**: This test checks a looser, more freeform apply-patch case where the patch context is less tidy than a simple exact-line replacement. It makes sure Codex can still apply a realistic edit to a source file and produce the expected final content.

**Data flow**: It prepares one patch that creates `app.py` with a small Python class and another patch that changes the method body from returning `False` to returning `True`, including a blank line in the changed area. It feeds those patch requests through fake streamed server responses, runs `codex-exec`, then reads the final `app.py`. Instead of writing the expected file inline, it compares the result with a fixture file that stores the exact expected final text.

**Call relations**: Like the structured patch test, this one uses `start_mock_server` and `mount_sse_sequence` to make a fake server send prepared tool calls to `codex-exec`. The difference is the shape of the patch: it exercises a more flexible patch format. The final file comparison confirms that the tool-call flow and patch application worked together correctly.

*Call graph*: calls 2 internal fn (mount_sse_sequence, start_mock_server); 4 external calls (assert_eq!, skip_if_no_network!, read_to_string, vec!).


### `exec/tests/suite/resume.rs`

`test` · `test run`

This is a test file for the non-interactive `codex exec` command. Its focus is the “resume” feature: when a user comes back to an old conversation, the tool should write the next turn into the same saved session file instead of starting a new one. Without these tests, small command-line parsing changes or session lookup changes could quietly break resume behavior and users might lose continuity between runs.

The tests use a fake HTTP server instead of talking to the real model service. The fake server returns simple streamed responses, so the command can run as if an assistant answered. Each test creates a unique text marker, like a label on a suitcase, then looks through the saved session files to find where that marker was recorded. After running `resume`, the test checks that the second marker appears in the same file.

Several helper functions make the tests easier to read. Some scan saved JSONL files, which are files with one JSON object per line. Others pull out the conversation ID or count attached images in the latest user message. The main tests cover resuming the newest session, resuming by ID, choosing sessions by current working directory, accepting global flags after the subcommand, carrying output schemas into the model request, preserving command-line overrides, and attaching images after `resume`.

#### Function details

##### `find_session_file_containing_marker`  (lines 16–61)

```
fn find_session_file_containing_marker(
    sessions_dir: &std::path::Path,
    marker: &str,
) -> Option<std::path::PathBuf>
```

**Purpose**: Searches the test session folder for a saved conversation file that contains a particular unique text marker. Tests use it to prove that a prompt was written to the expected session file.

**Data flow**: It receives a sessions directory and a marker string. It walks through files under that directory, reads only `.jsonl` files, skips the first metadata line, parses the remaining lines as JSON, and looks for assistant or user message content containing the marker. If it finds one, it returns that file path; otherwise it returns nothing.

**Call relations**: The resume tests create unique markers before running the command, then call this helper afterward to locate the session file that recorded the marker. It relies on directory walking, file reading, and JSON parsing so the tests can inspect the saved conversation history directly.

*Call graph*: called by 6 (exec_resume_accepts_images_after_subcommand, exec_resume_by_id_appends_to_existing_file, exec_resume_last_accepts_prompt_after_flag_in_json_mode, exec_resume_last_appends_to_existing_file, exec_resume_last_respects_cwd_filter_and_all_flag, exec_resume_preserves_cli_configuration_overrides); 3 external calls (new, from_str, read_to_string).


##### `extract_conversation_id`  (lines 64–74)

```
fn extract_conversation_id(path: &std::path::Path) -> String
```

**Purpose**: Reads the saved conversation ID from the first line of a session file. Tests use this when they need to resume a specific conversation by ID instead of using `--last`.

**Data flow**: It receives a path to a session file. It reads the file, takes the first line, parses it as JSON, and pulls out `payload.id`. It returns that ID as a string, or an empty string if the expected field is missing.

**Call relations**: The tests first find a session file with `find_session_file_containing_marker`, then pass that path here to get the ID needed for an explicit `resume <id>` command. This connects the file on disk to the command-line resume feature.

*Call graph*: called by 2 (exec_resume_by_id_appends_to_existing_file, exec_resume_last_respects_cwd_filter_and_all_flag); 2 external calls (from_str, read_to_string).


##### `last_user_image_count`  (lines 76–107)

```
fn last_user_image_count(path: &std::path::Path) -> usize
```

**Purpose**: Counts how many image attachments are present in the most recent saved user message. It is used to confirm that images passed after the `resume` subcommand were actually included in the resumed prompt.

**Data flow**: It receives a session file path, reads the file, and parses each non-empty line as JSON. Whenever it sees a user message, it counts the content entries whose type is `input_image` and remembers that count. After scanning the whole file, it returns the count from the last user message it found.

**Call relations**: The image-resume test runs the command with two `--image` arguments, finds the updated session file, then calls this helper. The helper inspects the saved transcript so the test can verify the command-line images made it into the recorded user turn.

*Call graph*: called by 1 (exec_resume_accepts_images_after_subcommand); 2 external calls (from_str, read_to_string).


##### `exec_repo_root`  (lines 109–111)

```
fn exec_repo_root() -> anyhow::Result<std::path::PathBuf>
```

**Purpose**: Returns the repository root path for use as a working directory in tests. This gives the command a real project directory to run from.

**Data flow**: It asks the shared cargo-test utility for the repository root and wraps the result in the test file’s normal error type. The output is a filesystem path.

**Call relations**: Several resume tests call this before launching `codex exec` with `-C`. It keeps those tests from hard-coding where the repository lives on a developer machine or in continuous integration.

*Call graph*: called by 5 (exec_resume_accepts_images_after_subcommand, exec_resume_by_id_appends_to_existing_file, exec_resume_last_accepts_prompt_after_flag_in_json_mode, exec_resume_last_appends_to_existing_file, exec_resume_preserves_cli_configuration_overrides); 1 external calls (repo_root).


##### `exec_sse_response`  (lines 113–121)

```
fn exec_sse_response(index: usize) -> String
```

**Purpose**: Builds one fake streamed assistant response for the mock server. SSE means “server-sent events,” a simple way for a server to send a sequence of updates over one response.

**Data flow**: It receives an index number, uses it to make unique response and message IDs, and builds a stream containing three events: response created, assistant message, and completed. It returns the full stream as a string.

**Call relations**: This is the small response factory used when preparing the fake server replies for the command. It hands those prepared event streams to the response-mounting helper so each command run gets a believable assistant response.

*Call graph*: calls 1 internal fn (sse); 2 external calls (format!, vec!).


##### `mount_exec_responses`  (lines 123–128)

```
async fn mount_exec_responses(
    server: &MockServer,
    count: usize,
) -> core_test_support::responses::ResponseMock
```

**Purpose**: Prepares the mock server to answer a chosen number of model requests. Tests use it so each `codex exec` run can complete without contacting the real service.

**Data flow**: It receives a mock server and a count. It creates that many fake streamed responses and registers them with the server as a sequence. It returns a response mock object that can later be inspected, for example to see what requests were sent.

**Call relations**: Every main test starts a mock server and calls this helper before running the CLI. In most tests it simply makes the command succeed; in the output-schema test, the returned mock is also used to inspect the second request body.

*Call graph*: calls 1 internal fn (mount_sse_sequence); called by 8 (exec_resume_accepts_global_flags_after_subcommand, exec_resume_accepts_images_after_subcommand, exec_resume_by_id_appends_to_existing_file, exec_resume_includes_output_schema_in_request, exec_resume_last_accepts_prompt_after_flag_in_json_mode, exec_resume_last_appends_to_existing_file, exec_resume_last_respects_cwd_filter_and_all_flag, exec_resume_preserves_cli_configuration_overrides).


##### `exec_resume_last_appends_to_existing_file`  (lines 131–181)

```
async fn exec_resume_last_appends_to_existing_file() -> anyhow::Result<()>
```

**Purpose**: Tests the basic promise of `resume --last`: the next prompt should be appended to the newest existing session file, not written to a new file.

**Data flow**: It creates a test CLI environment and fake server, runs `codex exec` once with a unique marker, and finds the created session file. It then runs the command again with another marker plus `resume --last`. Finally it checks that the second marker appears in the same file and that both markers are present.

**Call relations**: This test brings together the mock responses, repository-root helper, and session-file scanner. It exercises the public command-line flow exactly as a user would run it.

*Call graph*: calls 4 internal fn (test_codex_exec, exec_repo_root, find_session_file_containing_marker, mount_exec_responses); 6 external calls (start, assert!, assert_eq!, format!, skip_if_no_network!, read_to_string).


##### `exec_resume_last_accepts_prompt_after_flag_in_json_mode`  (lines 184–234)

```
async fn exec_resume_last_accepts_prompt_after_flag_in_json_mode() -> anyhow::Result<()>
```

**Purpose**: Tests that JSON mode still accepts the prompt after `resume --last`. This protects a command-line shape users might naturally write.

**Data flow**: It runs a first command to create a session, then runs a second command with `--json resume --last <prompt>`. It searches for the new marker and confirms it was written into the same session file as the original marker.

**Call relations**: Like the basic `--last` test, it uses the mock server, repository root, and marker search helper. Its special role is checking the command-line parser when JSON output and a prompt after the resume flag are combined.

*Call graph*: calls 4 internal fn (test_codex_exec, exec_repo_root, find_session_file_containing_marker, mount_exec_responses); 6 external calls (start, assert!, assert_eq!, format!, skip_if_no_network!, read_to_string).


##### `exec_resume_last_respects_cwd_filter_and_all_flag`  (lines 237–339)

```
async fn exec_resume_last_respects_cwd_filter_and_all_flag() -> anyhow::Result<()>
```

**Purpose**: Tests how `resume --last` chooses among sessions from different working directories. It also checks that `--all` widens the search beyond the current directory.

**Data flow**: It creates two temporary directories and starts one session in each. It then makes the second directory’s session clearly newer, resumes with `--last --all` from the first directory, and verifies the newest overall session was chosen. After that, it runs plain `--last` and checks that the latest matching session for the current working directory is chosen.

**Call relations**: This test uses marker searches to identify session files and `extract_conversation_id` to explicitly touch one session. The sleeps are there because saved update times only have one-second precision, so the test avoids accidental ties when deciding which session is newest.

*Call graph*: calls 4 internal fn (test_codex_exec, extract_conversation_id, find_session_file_containing_marker, mount_exec_responses); 7 external calls (start, new, assert_eq!, format!, skip_if_no_network!, sleep, from_millis).


##### `exec_resume_accepts_global_flags_after_subcommand`  (lines 342–376)

```
async fn exec_resume_accepts_global_flags_after_subcommand() -> anyhow::Result<()>
```

**Purpose**: Tests that global command-line options still work when placed after the `resume` subcommand. This matters because users often mix option order, and the command should accept supported forms consistently.

**Data flow**: It first seeds a session. Then it runs `resume --last` while placing options such as `--config`, `--json`, `--model`, approval/sandbox bypass, and git-repo skipping after the subcommand. The test passes if the command exits successfully.

**Call relations**: This test depends on the mock response setup so the resumed command can complete. Unlike the file-content tests, it mainly checks command-line parsing and option acceptance rather than inspecting the saved transcript.

*Call graph*: calls 2 internal fn (test_codex_exec, mount_exec_responses); 3 external calls (start, format!, skip_if_no_network!).


##### `exec_resume_includes_output_schema_in_request`  (lines 379–432)

```
async fn exec_resume_includes_output_schema_in_request() -> anyhow::Result<()>
```

**Purpose**: Tests that a JSON output schema provided during resume is sent to the model request. A schema is a set of rules describing the shape of the answer the model should return.

**Data flow**: It writes a small schema file, creates an initial session, then resumes with `--json --output-schema <file>`. After the run, it inspects the mock server’s recorded requests and checks that the second request contains the expected `text.format` JSON schema block.

**Call relations**: This test uses `mount_exec_responses` not only to fake replies but also to capture outgoing requests. It verifies the resume path still includes output-format instructions in the transport sent to the model service.

*Call graph*: calls 2 internal fn (test_codex_exec, mount_exec_responses); 6 external calls (start, assert_eq!, json!, to_vec_pretty, skip_if_no_network!, write).


##### `exec_resume_by_id_appends_to_existing_file`  (lines 435–488)

```
async fn exec_resume_by_id_appends_to_existing_file() -> anyhow::Result<()>
```

**Purpose**: Tests that resuming by an explicit conversation ID appends to that exact session file. This protects users who choose a specific older conversation rather than the most recent one.

**Data flow**: It creates a session with a unique marker, finds the file, extracts its conversation ID, then runs `resume <id>` with a second marker. It finds where the second marker was saved and checks that it is the original file and contains both markers.

**Call relations**: This test uses the session scanner to find the file and the ID extractor to turn that file into a command-line argument. It covers the explicit-ID branch of the resume feature, while the `--last` tests cover automatic selection.

*Call graph*: calls 5 internal fn (test_codex_exec, exec_repo_root, extract_conversation_id, find_session_file_containing_marker, mount_exec_responses); 6 external calls (start, assert!, assert_eq!, format!, skip_if_no_network!, read_to_string).


##### `exec_resume_preserves_cli_configuration_overrides`  (lines 491–563)

```
async fn exec_resume_preserves_cli_configuration_overrides() -> anyhow::Result<()>
```

**Purpose**: Tests that command-line configuration overrides still take effect when resuming. In plain terms, if the user says “use this model” or “use this sandbox mode” on the resume command, that choice should win.

**Data flow**: It creates an initial session with certain options, then resumes with a different model and sandbox setting. It checks the command succeeded, reads standard error output, and confirms the displayed model and sandbox reflect the resume command’s options. It also verifies the new marker was appended to the same session file.

**Call relations**: This test combines transcript inspection with output inspection. It uses the mock server for model replies, the repository-root helper for a stable working directory, and the marker search helper to prove the resumed run updated the original session.

*Call graph*: calls 4 internal fn (test_codex_exec, exec_repo_root, find_session_file_containing_marker, mount_exec_responses); 8 external calls (start, from_utf8, assert!, assert_eq!, cfg!, format!, skip_if_no_network!, read_to_string).


##### `exec_resume_accepts_images_after_subcommand`  (lines 566–623)

```
async fn exec_resume_accepts_images_after_subcommand() -> anyhow::Result<()>
```

**Purpose**: Tests that image attachments passed after `resume --last` are accepted and saved with the resumed user prompt.

**Data flow**: It creates an initial session, writes two tiny PNG image files, then resumes with two `--image` arguments and a new marker. It finds the updated session file and counts image entries in the last saved user message. The test expects exactly two images.

**Call relations**: This test uses the common mock-server and repository-root setup, then relies on `find_session_file_containing_marker` to locate the resumed transcript and `last_user_image_count` to inspect the final user turn. It covers the multimodal, or text-plus-image, path through resume.

*Call graph*: calls 5 internal fn (test_codex_exec, exec_repo_root, find_session_file_containing_marker, last_user_image_count, mount_exec_responses); 5 external calls (start, assert_eq!, format!, skip_if_no_network!, write).


### `exec/tests/suite/server_error_exit.rs`

`test` · `automated test run`

This is a small automated test for a failure path. It creates a fake server, makes that server send back a realistic streaming error message, then runs `codex-exec` against it and checks the final exit code.

The problem it guards against is easy to miss: a command-line tool can print an error but still exit with code 0, which usually means “success.” If that happened here, a build script, CI job, or other automation could wrongly continue after the server rejected the request. This test makes sure that does not happen.

The fake server returns a Server-Sent Events stream, often shortened to SSE. SSE is a simple way for a server to send a sequence of messages over one HTTP connection, like a live ticker. In this test, the stream immediately contains a `response.failed` event with a made-up rate-limit error. The test then starts `codex-exec` with JSON output enabled and a sample prompt. Finally, it asserts that the process exits with status code 1, meaning failure. The test is disabled on Windows, likely because this particular command-running setup or exit behavior is only expected on Unix-like systems.

#### Function details

##### `exits_non_zero_when_server_reports_error`  (lines 10–33)

```
async fn exits_non_zero_when_server_reports_error() -> anyhow::Result<()>
```

**Purpose**: This test proves that `codex-exec` exits with a non-zero status when the server reports an error. Someone would use it to prevent regressions where the tool looks like it failed to a human but still appears successful to automation.

**Data flow**: The test starts with no real external server. It creates a test command runner, starts a mock server, builds a fake SSE response containing a `response.failed` error, and installs that response on the server for one request. It then runs `codex-exec` with a prompt and JSON mode against that server. The observable result is the child process exit code, which the test expects to be `1`; no useful value is returned except successful test completion.

**Call relations**: This function is the whole test scenario. It asks the test support code to create a `codex-exec` command setup, asks the response helpers to start and prepare a mock server, and then hands that server to the command runner. The command runner performs the real program execution, and the final assertion checks that the server-side failure is turned into a process-level failure.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 1 external calls (vec!).


### `core/tests/suite/cli_stream.rs`

`test` · `integration test run`

These tests act like a careful dress rehearsal for the Codex command-line tool. Instead of calling the real OpenAI or ChatGPT services, the file starts a local mock HTTP server that pretends to be those services and sends back small streaming replies. That lets the tests check the real CLI behavior without depending on live servers or user accounts.

The main pattern is: create a temporary home directory, point the CLI at the mock server, run `codex exec` as a child process, then inspect both the command output and the request the CLI sent. This is important because many bugs only appear when all pieces are wired together: command-line flags, environment variables, authentication headers, streaming response parsing, and session file writing.

A small cleanup guard makes sure child processes do not linger if a test times out. That matters because `codex exec` may start helper processes, so killing only the first process would be like closing a parent app while leaving its background workers running.

The file also checks personal access token behavior, custom instruction files, profile-based configuration, session resume behavior, and Git information collection. In short, it verifies that the CLI behaves correctly from the outside, the way a real user would experience it.

#### Function details

##### `repo_root`  (lines 34–36)

```
fn repo_root() -> std::path::PathBuf
```

**Purpose**: Finds the root folder of the project repository so tests can run the CLI from a known working directory. This avoids tests depending on whatever directory the test runner happened to start in.

**Data flow**: It takes no direct input. It asks the shared cargo-binary test helper for the repository root, and returns that path. If the root cannot be found, the test stops immediately with a clear failure message.

**Call relations**: Many CLI tests call this before building a command, including the streaming tests, instruction-file tests, session-file test, and personal-access-token command builder. It supplies the directory passed to `codex exec` with `-C`, so the CLI is tested in the real project tree.

*Call graph*: called by 7 (exec_cli_applies_model_instructions_file, exec_cli_profile_applies_model_instructions_file, integration_creates_and_checks_session_file, personal_access_token_exec_command, responses_api_stream_cli, responses_mode_stream_cli, responses_mode_stream_cli_supports_openai_base_url_config_override); 1 external calls (repo_root).


##### `cli_sse_response`  (lines 38–44)

```
fn cli_sse_response() -> String
```

**Purpose**: Builds a small fake streaming response for tests. The fake stream says a response was created, sends one assistant message, then marks the response complete.

**Data flow**: It takes no input. It creates a list of response events and turns them into an SSE string, where SSE means “server-sent events,” a simple text format for streaming updates over HTTP. It returns that string for the mock server to send back.

**Call relations**: Tests such as the personal-access-token stream test, the Responses API stream test, and the session-file integration test use this as the canned answer from the mock server. It hands the finished stream text to the response-mounting helpers.

*Call graph*: calls 1 internal fn (sse); called by 2 (responses_api_stream_cli, responses_mode_stream_cli_supports_personal_access_tokens); 1 external calls (vec!).


##### `mount_personal_access_token_startup`  (lines 46–67)

```
async fn mount_personal_access_token_startup(server: &MockServer)
```

**Purpose**: Sets up the mock server endpoints that the CLI calls when it starts with a personal access token. It teaches the fake server to answer “who am I?” and cloud configuration requests.

**Data flow**: It receives a mock server. It adds two expected GET routes: one returns account details for the token, and the other returns an empty cloud configuration bundle. After it runs, the mock server is ready for CLI startup traffic using the test token.

**Call relations**: The personal-access-token tests call this before running the CLI. It prepares the startup part of the conversation, then those tests add response-specific mocks and use `personal_access_token_exec_command` plus `run_cli_command` to exercise the full command.

*Call graph*: called by 2 (responses_mode_stream_cli_does_not_attempt_oauth_refresh_for_personal_access_tokens_after_401, responses_mode_stream_cli_supports_personal_access_tokens); 6 external calls (given, new, json!, header, method, path).


##### `personal_access_token_exec_command`  (lines 70–88)

```
fn personal_access_token_exec_command(server: &MockServer, home: &TempDir) -> Command
```

**Purpose**: Builds a ready-to-run `codex exec` command configured to authenticate with a personal access token. It keeps the command setup consistent across tests that check token behavior.

**Data flow**: It receives the mock server and a temporary home directory. It finds the compiled `codex` binary, adds command-line arguments that point OpenAI and ChatGPT base URLs at the mock server, sets `CODEX_HOME`, sets the personal access token environment variable, and removes API-key environment variables. It returns the configured command without running it.

**Call relations**: The personal-access-token success test and the 401-refresh test both call this after mounting startup server routes. They then pass the returned command to `run_cli_command`, which actually starts the CLI process.

*Call graph*: calls 1 internal fn (repo_root); called by 2 (responses_mode_stream_cli_does_not_attempt_oauth_refresh_for_personal_access_tokens_after_401, responses_mode_stream_cli_supports_personal_access_tokens); 5 external calls (uri, path, new, cargo_bin, format!).


##### `ChildProcessCleanupGuard::drop`  (lines 93–113)

```
fn drop(&mut self)
```

**Purpose**: Cleans up a spawned CLI process, including its child processes, when a test finishes or times out. This prevents stuck shell or Python helper processes from being left behind.

**Data flow**: It holds a process id. When the guard is dropped, it tries to kill the whole process group on Unix, uses `taskkill` to kill the process tree on Windows, and does nothing meaningful on unsupported platforms. It does not return a value; its effect is cleanup.

**Call relations**: This cleanup runs automatically because `run_cli_command` creates a `ChildProcessCleanupGuard` after spawning the CLI. If the wait path finishes normally, the target process is already gone; if a timeout or panic happens, the guard is the safety net.

*Call graph*: calls 1 internal fn (kill_process_group); 2 external calls (null, new).


##### `run_cli_command`  (lines 119–144)

```
fn run_cli_command(command: &mut Command) -> io::Result<Output>
```

**Purpose**: Runs a prepared CLI command with a timeout and captures its output. It is the shared safe way for these tests to execute `codex exec` as a real child process.

**Data flow**: It receives a mutable command. It disconnects standard input, captures standard output and error, starts the process, and waits for another thread to collect the finished output. If the command finishes in time, it returns the captured result; if it takes too long or the waiter thread fails, it returns an error.

**Call relations**: Almost every CLI integration test in this file passes its command through this function. It also creates the cleanup guard, so the tests can focus on assertions while this helper takes care of process lifetime and timeout safety.

*Call graph*: called by 8 (exec_cli_applies_model_instructions_file, exec_cli_profile_applies_model_instructions_file, integration_creates_and_checks_session_file, responses_api_stream_cli, responses_mode_stream_cli, responses_mode_stream_cli_does_not_attempt_oauth_refresh_for_personal_access_tokens_after_401, responses_mode_stream_cli_supports_openai_base_url_config_override, responses_mode_stream_cli_supports_personal_access_tokens); 9 external calls (null, piped, process_group, spawn, stdin, new, other, sync_channel, spawn).


##### `responses_mode_stream_cli_supports_personal_access_tokens`  (lines 147–175)

```
async fn responses_mode_stream_cli_supports_personal_access_tokens()
```

**Purpose**: Checks that `codex exec` can stream a Responses API result while authenticated with a personal access token. It also verifies that the correct account and FedRAMP headers are sent.

**Data flow**: It starts a mock server, mounts personal-token startup routes, mounts one fake streaming response, creates a temporary home, builds the token-based CLI command, and runs it. It then checks that the command succeeded and inspects the captured request headers and path.

**Call relations**: This test uses `mount_personal_access_token_startup` to prepare login-related replies, `cli_sse_response` for the fake streamed answer, `personal_access_token_exec_command` to build the command, and `run_cli_command` to execute it. It finishes by asking the mock server to verify the expected calls happened.

*Call graph*: calls 5 internal fn (mount_sse_once, cli_sse_response, mount_personal_access_token_startup, personal_access_token_exec_command, run_cli_command); 5 external calls (start, new, assert!, assert_eq!, skip_if_no_network!).


##### `responses_mode_stream_cli_does_not_attempt_oauth_refresh_for_personal_access_tokens_after_401`  (lines 178–209)

```
async fn responses_mode_stream_cli_does_not_attempt_oauth_refresh_for_personal_access_tokens_after_401()
```

**Purpose**: Checks that a personal access token is not treated like an OAuth token after an unauthorized response. In plain terms, if the server rejects the personal token, the CLI should fail instead of trying a refresh flow that does not apply.

**Data flow**: It starts a mock server, mounts the normal token startup routes, then configures the response endpoint to return HTTP 401. It also sets an OAuth token endpoint mock that must not be called. After running the CLI, it expects failure and verifies the forbidden refresh call did not happen.

**Call relations**: Like the successful personal-token test, it uses `mount_personal_access_token_startup`, `personal_access_token_exec_command`, and `run_cli_command`. The difference is that the response mock deliberately rejects the request, and the mock server verification proves the CLI did not hand off to OAuth refresh.

*Call graph*: calls 3 internal fn (mount_personal_access_token_startup, personal_access_token_exec_command, run_cli_command); 9 external calls (given, start, new, new, assert!, skip_if_no_network!, header, method, path).


##### `responses_mode_stream_cli`  (lines 213–255)

```
async fn responses_mode_stream_cli()
```

**Purpose**: Checks the basic streaming path for `codex exec` using a custom mock model provider. It proves the CLI can receive a streamed assistant message and print it once.

**Data flow**: It starts a mock server, builds a fake response stream containing the message `hi`, configures a temporary provider that points to the mock server, and runs `codex exec`. It reads standard output, counts exact `hi` lines, and inspects the recorded request path.

**Call relations**: This test calls `repo_root` to choose the working directory and `run_cli_command` to launch the binary. It relies on the response helper to mount the SSE stream and then checks that the CLI sent traffic to the mock provider’s `/v1/responses` endpoint.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, repo_root, run_cli_command); 11 external calls (start, from_utf8_lossy, new, assert!, assert_eq!, new, cargo_bin, format!, println!, skip_if_no_network! (+1 more)).


##### `responses_mode_stream_cli_supports_openai_base_url_config_override`  (lines 259–289)

```
async fn responses_mode_stream_cli_supports_openai_base_url_config_override()
```

**Purpose**: Checks that the `openai_base_url` configuration option actually redirects built-in OpenAI provider requests. This matters so users and tests can point the CLI at a different compatible endpoint.

**Data flow**: It creates a mock server and a small streamed answer, then runs `codex exec` with `openai_base_url` set to that server. After the command succeeds, it checks that the captured request went to `/v1/responses` on the mock server.

**Call relations**: The test uses `repo_root` for the working directory and `run_cli_command` to execute the prepared CLI command. The mock response helper records the outbound request so the test can confirm the configuration override was honored.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, repo_root, run_cli_command); 9 external calls (start, new, assert!, assert_eq!, new, cargo_bin, format!, skip_if_no_network!, vec!).


##### `exec_cli_applies_model_instructions_file`  (lines 295–359)

```
async fn exec_cli_applies_model_instructions_file()
```

**Purpose**: Checks that passing `model_instructions_file` on the command line replaces or augments the model instructions sent in the request. This protects the user-facing feature that lets people supply custom guidance from a file.

**Data flow**: It writes a temporary instructions file containing a unique marker, starts a mock server, and runs `codex exec` with a provider override plus a config override pointing at that file. After the CLI succeeds, it parses the captured request body and checks that the `instructions` field contains the marker.

**Call relations**: This test gets the repository path through `repo_root`, runs the command through `run_cli_command`, and uses the mock response helper to capture the outgoing request. The request inspection is the proof that the CLI configuration reached the model-call layer.

*Call graph*: calls 3 internal fn (mount_sse_once, repo_root, run_cli_command); 10 external calls (start, new, assert!, new, cargo_bin, concat!, format!, println!, skip_if_no_network!, write).


##### `exec_cli_profile_applies_model_instructions_file`  (lines 365–427)

```
async fn exec_cli_profile_applies_model_instructions_file()
```

**Purpose**: Checks that `codex exec --profile ...` preserves the selected profile when the CLI starts its internal app-server thread. The user-visible result is that profile-specific instruction files still reach the model request.

**Data flow**: It writes a profile config file inside a temporary Codex home directory, with `model_instructions_file` pointing to a marker file. It runs `codex exec --profile default` against a mock provider, then reads the captured request body and confirms the marker appears in the `instructions` field.

**Call relations**: This test follows the same request-capture pattern as `exec_cli_applies_model_instructions_file`, using `repo_root` and `run_cli_command`. Its special focus is the handoff from the CLI profile option into the in-process server work that eventually sends the HTTP request.

*Call graph*: calls 3 internal fn (mount_sse_once, repo_root, run_cli_command); 10 external calls (start, new, assert!, new, cargo_bin, concat!, format!, println!, skip_if_no_network!, write).


##### `responses_api_stream_cli`  (lines 431–458)

```
async fn responses_api_stream_cli()
```

**Purpose**: Checks that the CLI can stream a response through a local Responses API-compatible server and show the assistant text. It is a straightforward end-to-end stream test using the built-in OpenAI-style base URL override.

**Data flow**: It starts a mock server, mounts the standard fake SSE response, runs `codex exec` with `openai_base_url` pointed at the mock server, and captures output. It expects the command to succeed, expects stdout to contain `fixture hello`, and checks the request path.

**Call relations**: This test uses `cli_sse_response` for the server reply, `repo_root` for the working directory, and `run_cli_command` for process execution. It confirms the CLI, streaming parser, and output path work together.

*Call graph*: calls 4 internal fn (mount_sse_once, cli_sse_response, repo_root, run_cli_command); 9 external calls (start, from_utf8_lossy, new, assert!, assert_eq!, new, cargo_bin, format!, skip_if_no_network!).


##### `integration_creates_and_checks_session_file`  (lines 462–643)

```
async fn integration_creates_and_checks_session_file() -> anyhow::Result<()>
```

**Purpose**: Checks that a real `codex exec` run creates a session log file, writes useful metadata and messages into it, and later appends to the same file when resuming. This protects the history feature users rely on to continue past sessions.

**Data flow**: It creates a temporary Codex home, generates a unique marker prompt, serves two fake streaming responses, and runs the CLI once. It waits for a session JSONL file, which is a file with one JSON record per line, then verifies its date-based folder path, metadata line, and message content. It runs the CLI again with `resume --last`, then checks that the second marker was written into the same file alongside the first marker.

**Call relations**: This larger test uses `repo_root` to run in the repository, `run_cli_command` for both CLI launches, and the response sequence helper so the mock server can answer twice. It also uses filesystem waiting helpers because session writing happens asynchronously enough that the test must wait for files to appear.

*Call graph*: calls 3 internal fn (mount_sse_sequence, repo_root, run_cli_command); 14 external calls (from_secs, start, new, assert!, assert_eq!, new, cargo_bin, format!, wait_for_matching_file, wait_for_path_exists (+4 more)).


##### `integration_git_info_unit_test`  (lines 647–787)

```
async fn integration_git_info_unit_test()
```

**Purpose**: Checks that Git repository information can be collected and serialized correctly. This matters because session metadata should be able to record where a run happened: commit, branch, and remote URL.

**Data flow**: It creates a temporary Git repository, configures a user, commits a file, creates a branch, and adds a remote. It calls the Git-info collector, verifies the commit hash, branch, and repository URL, then converts the result to JSON and back to make sure it survives storage.

**Call relations**: Unlike the CLI tests, this one calls the Git collection function directly instead of running `codex exec`. It still supports the same broader session-file feature by proving the `GitInfo` data that sessions may store is accurate and safely serializable.

*Call graph*: 11 external calls (from_utf8, new, assert!, assert_eq!, new, collect_git_info, println!, from_str, to_string, write (+1 more)).
