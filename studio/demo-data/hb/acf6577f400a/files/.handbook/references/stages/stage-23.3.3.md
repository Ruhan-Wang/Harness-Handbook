# codex-exec binary verification  `stage-23.3.3`

This stage verifies the codex-exec binary at the executable boundary: after lower-level libraries exist, but before callers can trust the command-line tool in real automation. It covers startup parsing, request construction, streaming execution, persistence, resume, and failure signaling.

The direct unit tests lock down the binary’s front door and internal adapters. cli_tests.rs and main_tests.rs preserve the exact clap surface, especially tricky flag ordering and resume prompt parsing. lib_tests.rs checks startup helpers such as prompt decoding, notification filtering, tracing/log wiring, and bootstrap session conversion. The human and JSONL event-processor tests validate how streamed app events become terminal output or machine-readable records, including final-message tracking, warnings, sandbox summaries, and serialization details. event_processor_with_json_output.rs extends that into behavioral translation tests for machine consumers.

The integration suite then exercises full subprocess flows. Its modules verify prompt sourcing from args and stdin, auth and Originator headers, output-schema embedding, AGENTS.md inclusion, approval-policy derivation, writable-directory wiring, hooks, MCP startup failures, server-error exit codes, ephemeral versus persisted sessions, end-to-end resume behavior, and apply_patch workflows. all.rs and suite/mod.rs assemble these cases into one executable test harness, while core/tests/suite/cli_stream.rs provides broader external-process coverage of streaming, auth, config overrides, persistence, and resume.

## Files in this stage

### CLI shape and startup helpers
These tests lock down argument parsing and the library-level startup behavior that prepares exec runs before any output or subprocess execution occurs.

### `exec/src/cli_tests.rs`

`test` · `startup / CLI parsing tests`

This test file exercises the parser defined in `cli.rs` through `Cli::parse_from`, focusing on edge cases that are easy to regress when changing Clap annotations. The first test proves that arguments marked global by `mark_exec_global_args` still parse correctly after the `resume` subcommand and that the `ResumeArgs::from` positional reinterpretation works: with `resume --last ... PROMPT`, the trailing positional is treated as the prompt rather than a session id. The second test verifies output-related global flags (`-o` and `--output-schema`) are accepted after the subcommand and do not interfere with the resume session id and prompt positionals. Another test confirms `--ignore-user-config` and `--ignore-rules` are parsed independently and can be combined. The final test covers the hidden compatibility trap for `--full-auto`, asserting that parsing succeeds and `removed_full_auto_warning()` returns the exact migration guidance string. Together these tests document the intended CLI UX around mixed global/subcommand ordering and compatibility behavior.

#### Function details

##### `resume_parses_prompt_after_global_flags`  (lines 5–36)

```
fn resume_parses_prompt_after_global_flags()
```

**Purpose**: Verifies that global flags placed after the `resume` subcommand still parse and that a positional following `--last` is treated as the effective prompt. It specifically checks the custom resume semantics rather than only raw field placement.

**Data flow**: It feeds a synthetic argv array into `Cli::parse_from`, reads booleans like `ephemeral`, `ignore_user_config`, and `ignore_rules` from the parsed `Cli`, extracts `Command::Resume(args)`, computes an `effective_prompt` by falling back from `args.prompt` to `args.session_id` when `args.last` is true, and asserts that value equals the expected prompt string.

**Call relations**: This is a standalone unit test run by Rust’s test harness. It exercises the interaction between `mark_exec_global_args` and `ResumeArgs::from` indirectly through full parser construction.

*Call graph*: 4 external calls (parse_from, assert!, assert_eq!, panic!).


##### `resume_accepts_output_flags_after_subcommand`  (lines 39–62)

```
fn resume_accepts_output_flags_after_subcommand()
```

**Purpose**: Checks that output-related global flags remain valid after the `resume` subcommand and do not break positional parsing. It also confirms the session id and prompt are preserved in the expected fields.

**Data flow**: It parses a fixed argv sequence with `Cli::parse_from`, reads `cli.last_message_file` and `cli.output_schema`, extracts `Command::Resume(args)`, and asserts the parsed paths, `args.session_id`, and `args.prompt` all match the supplied command line.

**Call relations**: This unit test is invoked directly by the test runner. It complements the previous test by covering a different set of global flags and the non-`--last` resume path.

*Call graph*: 3 external calls (parse_from, assert_eq!, panic!).


##### `parses_config_isolation_flags`  (lines 65–75)

```
fn parses_config_isolation_flags()
```

**Purpose**: Confirms that the config-isolation booleans `--ignore-user-config` and `--ignore-rules` parse correctly together on the top-level command. It protects the startup behavior that disables loading user config and rule files.

**Data flow**: It parses a short argv array into `Cli`, reads `cli.ignore_user_config` and `cli.ignore_rules`, and asserts both booleans are true.

**Call relations**: This is a direct parser unit test with no deeper delegation beyond `Cli::parse_from`. It isolates the config-loading flags from subcommand-specific concerns.

*Call graph*: 2 external calls (parse_from, assert!).


##### `removed_full_auto_flag_reports_migration_path`  (lines 78–85)

```
fn removed_full_auto_flag_reports_migration_path()
```

**Purpose**: Ensures the hidden deprecated `--full-auto` flag is still recognized and mapped to a user-facing migration warning. The test locks down the exact warning text.

**Data flow**: It parses argv containing `--full-auto`, calls `cli.removed_full_auto_warning()`, and asserts the returned `Option<&'static str>` equals the expected deprecation message.

**Call relations**: This unit test validates the compatibility shim in `Cli::removed_full_auto_warning`. It is run directly by the test harness and does not involve subcommands.

*Call graph*: 2 external calls (parse_from, assert_eq!).


### `exec/src/main_tests.rs`

`test` · `test-time CLI parsing validation`

This file contains a single regression test for the top-level binary parser defined in `exec/src/main.rs`. The scenario is subtle: `TopCli` flattens root-level `CliConfigOverrides` alongside the inner `Cli`, and the `resume` subcommand itself accepts flags plus a positional prompt/session argument. The test constructs a realistic argv sequence where `--config` appears after the subcommand and before the final prompt, alongside `--strict-config`, `--last`, `--json`, `--model`, `--dangerously-bypass-approvals-and-sandbox`, and `--skip-git-repo-check`.

After parsing with `TopCli::parse_from`, the test performs the same merge step as `main`, moving root overrides into `inner.config_overrides`. It then inspects the parsed `ResumeArgs` and reconstructs the effective prompt using the same fallback logic the runtime uses for `--last`. The assertions verify three things at once: the trailing positional string is still treated as the resume prompt, the root-level config override was captured exactly once as `reasoning_level=xhigh`, and `strict_config` remained enabled. This protects against clap parsing regressions where global flags could accidentally consume or reorder subcommand positional arguments.

#### Function details

##### `top_cli_parses_resume_prompt_after_config_flag`  (lines 5–43)

```
fn top_cli_parses_resume_prompt_after_config_flag()
```

**Purpose**: Verifies that `TopCli` correctly parses a `resume` invocation where a root-level `--config` flag appears before the final positional prompt. It ensures prompt extraction and override merging both behave as intended.

**Data flow**: Builds an argv array, parses it with `TopCli::parse_from`, mutates `inner.config_overrides` by prepending root overrides, extracts the `ResumeArgs` from `inner.command`, reconstructs the effective prompt, and asserts the prompt text, override count/value, and `strict_config` flag.

**Call relations**: This test mirrors the exact merge step performed by `main`, validating the binary-layer CLI wiring before control would pass to `run_main`.

*Call graph*: 4 external calls (assert!, assert_eq!, parse_from, panic!).


### `exec/src/lib_tests.rs`

`test` · `test-time unit validation`

This file exercises the non-network logic in `exec/src/lib.rs`. The first helper, `test_tracing_subscriber`, builds a tracing subscriber backed by an OpenTelemetry test tracer so span parenting can be asserted without touching production telemetry. `TestLogWriter` and `TestLogSink` implement `tracing_subscriber::fmt::MakeWriter` and `std::io::Write` over an `Arc<Mutex<Vec<u8>>>`, letting tests capture formatted stderr logs and verify that `EXEC_DEFAULT_LOG_FILTER` suppresses `opentelemetry_sdk` and `opentelemetry_otlp` self-diagnostics while preserving real exec errors.

The rest of the file is a focused suite around pure helpers and config translation. It validates review-request construction for uncommitted, commit, and custom prompt targets; prompt decoding across UTF-8 BOM, UTF-16LE/BE BOM, invalid UTF-8, and rejected UTF-32 BOMs; stdin-context wrapping; lagged-event warning wording; and notification filtering for thread-scoped warnings. Several async tests build temporary `Config` values with `ConfigBuilder`, `ConfigOverrides`, and `LoaderOverrides` to verify `build_exec_config` retry semantics, thread start/resume parameter generation, hook-trust propagation, permission-profile selection, and legacy sandbox fallback when no active profile exists. The final group uses `sample_thread_start_response` to assert that bootstrap `SessionConfiguredEvent` mapping preserves review policy, permission profile, thread source, and parent thread ID. Overall, these tests lock down the subtle compatibility behavior that would be easy to regress during CLI or protocol refactors.

#### Function details

##### `test_tracing_subscriber`  (lines 20–24)

```
fn test_tracing_subscriber() -> impl tracing::Subscriber + Send + Sync
```

**Purpose**: Builds a tracing subscriber with an OpenTelemetry layer backed by an in-memory SDK tracer provider for tests. It gives span-parenting tests a real trace context pipeline without external exporters.

**Data flow**: Creates an `SdkTracerProvider`, obtains a tracer named `codex-exec-tests`, attaches it to `tracing_opentelemetry::layer()`, and returns the composed subscriber.

**Call relations**: Used by `exec_root_span_can_be_parented_from_trace_context` to install a subscriber before creating and parenting the exec root span.

*Call graph*: called by 1 (exec_root_span_can_be_parented_from_trace_context); 3 external calls (builder, layer, registry).


##### `exec_defaults_analytics_to_enabled`  (lines 27–29)

```
fn exec_defaults_analytics_to_enabled()
```

**Purpose**: Asserts that the library-level analytics default remains enabled. This protects the constant from accidental inversion.

**Data flow**: Reads `DEFAULT_ANALYTICS_ENABLED` and compares it to `true` with `assert_eq!`.

**Call relations**: Standalone regression test for a startup constant; it does not delegate further.

*Call graph*: 1 external calls (assert_eq!).


##### `TestLogWriter::make_writer`  (lines 43–47)

```
fn make_writer(&'a self) -> Self::Writer
```

**Purpose**: Creates a fresh sink object that writes into the shared test log buffer. It is the `MakeWriter` adapter required by tracing's formatting layer.

**Data flow**: Reads `self.buffer`, clones the `Arc`, and returns `TestLogSink { buffer }`.

**Call relations**: Used indirectly by the tracing formatter in `exec_default_stderr_filter_suppresses_otel_self_diagnostics` whenever a log event is emitted.

*Call graph*: 1 external calls (clone).


##### `TestLogSink::write`  (lines 51–54)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Appends formatted log bytes into the shared in-memory buffer. It lets tests inspect exactly what tracing would have written to stderr.

**Data flow**: Locks the `Mutex<Vec<u8>>`, extends it with `buf`, and returns `Ok(buf.len())`.

**Call relations**: Invoked by tracing's formatting layer during the stderr-filter test when error events are emitted.


##### `TestLogSink::flush`  (lines 56–58)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Implements a no-op flush for the in-memory log sink. The buffer is already updated eagerly on each write.

**Data flow**: Takes `&mut self` and returns `Ok(())` without mutating state.

**Call relations**: Called by tracing infrastructure as needed while using `TestLogSink` in the stderr-filter test.


##### `exec_default_stderr_filter_suppresses_otel_self_diagnostics`  (lines 62–84)

```
fn exec_default_stderr_filter_suppresses_otel_self_diagnostics()
```

**Purpose**: Verifies that the default stderr tracing filter hides OTEL exporter self-errors while still allowing ordinary exec errors through. This protects stdout/stderr cleanliness in headless mode.

**Data flow**: Builds a shared byte buffer, installs a tracing subscriber using `TestLogWriter` and `EXEC_DEFAULT_LOG_FILTER`, emits three error events with different targets, then decodes the captured bytes to UTF-8 and asserts which messages are present or absent.

**Call relations**: Exercises the same filter string used by `exec_stderr_env_filter`, but in a controlled test subscriber rather than through `run_main`.

*Call graph*: 10 external calls (clone, new, try_new, new, from_utf8, new, assert!, with_default, layer, registry).


##### `exec_root_span_can_be_parented_from_trace_context`  (lines 87–103)

```
fn exec_root_span_can_be_parented_from_trace_context()
```

**Purpose**: Checks that the exec root span accepts a W3C trace context parent and adopts the expected trace ID. This confirms startup tracing propagation works.

**Data flow**: Installs the test subscriber, constructs a `W3cTraceContext`, creates `exec_root_span()`, calls `set_parent_from_w3c_trace_context`, then reads the span context's trace ID and compares it to the expected parsed hex ID.

**Call relations**: Uses `test_tracing_subscriber` and `exec_root_span` together to validate the parent-setting path that `run_main` uses with environment-derived trace context.

*Call graph*: calls 1 internal fn (test_tracing_subscriber); 3 external calls (assert!, assert_eq!, set_default).


##### `builds_uncommitted_review_request`  (lines 106–122)

```
fn builds_uncommitted_review_request()
```

**Purpose**: Asserts that `build_review_request` maps `--uncommitted` into `ReviewTarget::UncommittedChanges`. It verifies the simplest review-target branch.

**Data flow**: Constructs `ReviewArgs` with only `uncommitted: true`, calls `build_review_request`, and compares the returned `ReviewRequest` to the expected value.

**Call relations**: Direct unit test of `build_review_request`'s first branch.

*Call graph*: 1 external calls (assert_eq!).


##### `builds_commit_review_request_with_title`  (lines 125–144)

```
fn builds_commit_review_request_with_title()
```

**Purpose**: Verifies that commit-based review requests preserve both SHA and optional commit title. This protects the commit-target mapping branch.

**Data flow**: Builds `ReviewArgs` with `commit` and `commit_title`, calls `build_review_request`, and asserts the resulting `ReviewRequest` contains `ReviewTarget::Commit { sha, title }`.

**Call relations**: Direct unit test of the commit branch in `build_review_request`.

*Call graph*: 1 external calls (assert_eq!).


##### `builds_custom_review_request_trims_prompt`  (lines 147–165)

```
fn builds_custom_review_request_trims_prompt()
```

**Purpose**: Checks that custom review instructions are trimmed before being stored in the request. It ensures surrounding whitespace does not leak into the target.

**Data flow**: Creates `ReviewArgs` with a padded `prompt`, calls `build_review_request`, and asserts the resulting `ReviewTarget::Custom.instructions` is trimmed.

**Call relations**: Exercises the custom-prompt branch of `build_review_request`, including its call into `resolve_prompt` for non-stdin prompt text.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_strips_utf8_bom`  (lines 168–174)

```
fn decode_prompt_bytes_strips_utf8_bom()
```

**Purpose**: Confirms that UTF-8 BOM-prefixed prompt input decodes successfully and omits the BOM from the resulting string.

**Data flow**: Passes a BOM-prefixed byte array to `decode_prompt_bytes` and asserts the returned string is `"hi\n"`.

**Call relations**: Direct regression test for the UTF-8 BOM branch in `decode_prompt_bytes`.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_decodes_utf16le_bom`  (lines 177–184)

```
fn decode_prompt_bytes_decodes_utf16le_bom()
```

**Purpose**: Verifies UTF-16LE prompt input with BOM is decoded into UTF-8 text correctly.

**Data flow**: Supplies a UTF-16LE BOM plus encoded `hi\n` bytes to `decode_prompt_bytes` and asserts the decoded string.

**Call relations**: Exercises the UTF-16LE path through `decode_prompt_bytes` and `decode_utf16`.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_decodes_utf16be_bom`  (lines 187–194)

```
fn decode_prompt_bytes_decodes_utf16be_bom()
```

**Purpose**: Verifies UTF-16BE prompt input with BOM is decoded into UTF-8 text correctly.

**Data flow**: Supplies a UTF-16BE BOM plus encoded `hi\n` bytes to `decode_prompt_bytes` and asserts the decoded string.

**Call relations**: Exercises the UTF-16BE path through `decode_prompt_bytes` and `decode_utf16`.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_rejects_utf32le_bom`  (lines 197–212)

```
fn decode_prompt_bytes_rejects_utf32le_bom()
```

**Purpose**: Checks that UTF-32LE BOM input is rejected with the specific `UnsupportedBom` error variant. Exec intentionally does not decode UTF-32 prompts.

**Data flow**: Passes UTF-32LE BOM-prefixed bytes to `decode_prompt_bytes`, expects an error, and compares it to `PromptDecodeError::UnsupportedBom { encoding: "UTF-32LE" }`.

**Call relations**: Direct regression test for one of the explicit unsupported-BOM branches in `decode_prompt_bytes`.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_rejects_utf32be_bom`  (lines 215–230)

```
fn decode_prompt_bytes_rejects_utf32be_bom()
```

**Purpose**: Checks that UTF-32BE BOM input is rejected with the specific `UnsupportedBom` error variant.

**Data flow**: Passes UTF-32BE BOM-prefixed bytes to `decode_prompt_bytes`, expects an error, and compares it to `PromptDecodeError::UnsupportedBom { encoding: "UTF-32BE" }`.

**Call relations**: Direct regression test for the other explicit unsupported-BOM branch in `decode_prompt_bytes`.

*Call graph*: 1 external calls (assert_eq!).


##### `decode_prompt_bytes_rejects_invalid_utf8`  (lines 233–240)

```
fn decode_prompt_bytes_rejects_invalid_utf8()
```

**Purpose**: Verifies that malformed UTF-8 without a BOM produces `InvalidUtf8` with the correct offset. This protects the user-facing decoding diagnostics.

**Data flow**: Supplies an invalid UTF-8 byte sequence to `decode_prompt_bytes`, expects an error, and asserts it equals `PromptDecodeError::InvalidUtf8 { valid_up_to: 0 }`.

**Call relations**: Exercises the plain UTF-8 fallback branch in `decode_prompt_bytes`.

*Call graph*: 1 external calls (assert_eq!).


##### `prompt_with_stdin_context_wraps_stdin_block`  (lines 243–250)

```
fn prompt_with_stdin_context_wraps_stdin_block()
```

**Purpose**: Asserts that positional prompt plus stdin text are combined using the `<stdin>` wrapper format expected by exec.

**Data flow**: Calls `prompt_with_stdin_context` with prompt and stdin text lacking a trailing newline, then compares the combined string to the expected wrapped form.

**Call relations**: Direct unit test of the formatting helper used by `resolve_root_prompt`.

*Call graph*: 1 external calls (assert_eq!).


##### `prompt_with_stdin_context_preserves_trailing_newline`  (lines 253–260)

```
fn prompt_with_stdin_context_preserves_trailing_newline()
```

**Purpose**: Checks that when stdin already ends with a newline, the wrapper helper does not add an extra blank line before `</stdin>`.

**Data flow**: Calls `prompt_with_stdin_context` with newline-terminated stdin text and asserts the exact combined output.

**Call relations**: Complements the previous test by covering the helper's newline-preservation branch.

*Call graph*: 1 external calls (assert_eq!).


##### `lagged_event_warning_message_is_explicit`  (lines 263–268)

```
fn lagged_event_warning_message_is_explicit()
```

**Purpose**: Verifies the exact wording of the lagged-event warning shown to users. This keeps the message concrete and automation-friendly.

**Data flow**: Calls `lagged_event_warning_message(7)` and compares the returned string to the expected literal.

**Call relations**: Direct unit test of the warning formatter used in `run_exec_session`.

*Call graph*: 1 external calls (assert_eq!).


##### `runtime_warnings_are_filtered_to_the_primary_thread`  (lines 271–297)

```
fn runtime_warnings_are_filtered_to_the_primary_thread()
```

**Purpose**: Checks that warning notifications are processed only when global or targeted at the active thread. This protects multi-thread output isolation.

**Data flow**: Builds three `WarningNotification` values with `None`, matching, and non-matching `thread_id`, maps each through `should_process_notification`, and asserts the resulting boolean array is `[true, true, false]`.

**Call relations**: Directly exercises the warning-specific branch of `should_process_notification`.

*Call graph*: 1 external calls (assert_eq!).


##### `resume_lookup_model_providers_filters_only_last_lookup`  (lines 300–331)

```
async fn resume_lookup_model_providers_filters_only_last_lookup()
```

**Purpose**: Verifies that resume lookup restricts model providers only for `--last`, not for named-session searches. This preserves broad search semantics for explicit resumes.

**Data flow**: Builds a temporary `Config`, sets `model_provider_id`, constructs `ResumeArgs` for `last` and named-session cases, calls `resume_lookup_model_providers` for each, and asserts the expected `Some(vec![...])` vs `None` results.

**Call relations**: Direct unit test of the small helper used by `resolve_resume_thread_id`.

*Call graph*: 4 external calls (assert_eq!, default, tempdir, vec!).


##### `turn_items_for_thread_returns_matching_turn_items`  (lines 334–397)

```
fn turn_items_for_thread_returns_matching_turn_items()
```

**Purpose**: Checks that turn-item extraction returns the cloned items for the requested turn and `None` for missing turns. This supports backfill correctness.

**Data flow**: Constructs an `AppServerThread` with two turns containing different item variants, calls `turn_items_for_thread` for an existing and missing turn ID, and asserts the returned values.

**Call relations**: Direct unit test of the helper used by `maybe_backfill_turn_completed_items`.

*Call graph*: 4 external calls (new, assert_eq!, test_path_buf, vec!).


##### `should_backfill_turn_completed_items_skips_ephemeral_threads`  (lines 400–420)

```
fn should_backfill_turn_completed_items_skips_ephemeral_threads()
```

**Purpose**: Verifies that turn-completion backfill is disabled for ephemeral threads even when terminal items are empty. This protects the rollout-history assumption.

**Data flow**: Builds a `ServerNotification::TurnCompleted` with empty items, calls `should_backfill_turn_completed_items(true, &notification)`, and asserts the result is false.

**Call relations**: Direct unit test of the eligibility predicate used before issuing `thread/read` backfill requests.

*Call graph*: 3 external calls (TurnCompleted, new, assert!).


##### `canceled_mcp_server_elicitation_response_uses_cancel_action`  (lines 423–437)

```
fn canceled_mcp_server_elicitation_response_uses_cancel_action()
```

**Purpose**: Checks that the auto-generated MCP elicitation response serializes to a cancel action with no content or metadata. This preserves exec's non-interactive behavior.

**Data flow**: Calls `canceled_mcp_server_elicitation_response`, deserializes the returned JSON `Value` back into `McpServerElicitationRequestResponse`, and asserts the fields match the expected cancel payload.

**Call relations**: Direct unit test of the helper consumed by `handle_server_request`.

*Call graph*: 2 external calls (assert_eq!, from_value).


##### `thread_start_params_include_review_policy_when_review_policy_is_manual_only`  (lines 440–466)

```
async fn thread_start_params_include_review_policy_when_review_policy_is_manual_only()
```

**Purpose**: Verifies that thread-start params preserve a manually configured approvals reviewer and send permission-profile selection instead of legacy sandbox when appropriate.

**Data flow**: Builds a temporary `Config` with `approvals_reviewer: User`, calls `thread_start_params_from_config`, and asserts `approvals_reviewer`, `sandbox`, and `permissions` fields.

**Call relations**: Exercises `thread_start_params_from_config` under a manual-review configuration.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (default, assert_eq!, default, tempdir).


##### `thread_start_params_include_review_policy_when_auto_review_is_enabled`  (lines 469–489)

```
async fn thread_start_params_include_review_policy_when_auto_review_is_enabled()
```

**Purpose**: Checks that thread-start params preserve `AutoReview` rather than collapsing it to a user reviewer. This protects review-policy propagation to app-server.

**Data flow**: Builds a temporary `Config` with `approvals_reviewer: AutoReview`, calls `thread_start_params_from_config`, and asserts the resulting protocol reviewer enum.

**Call relations**: Covers the auto-review branch of the same lifecycle-param helper.

*Call graph*: 4 external calls (default, assert_eq!, default, tempdir).


##### `build_exec_config_retries_without_invalid_headless_policy_for_auto_review`  (lines 492–550)

```
async fn build_exec_config_retries_without_invalid_headless_policy_for_auto_review()
```

**Purpose**: Validates the special retry behavior that drops the synthetic headless approval policy when auto-review config rejects it. This is one of the file's most subtle compatibility tests.

**Data flow**: Creates temporary config and requirements files that make `approval_policy = never` invalid while `approvals_reviewer = auto_review` is configured, proves the direct build fails, then calls `build_exec_config(..., preserve_headless_approval_policy = false, build_config)` and asserts the returned config uses `AskForApproval::OnRequest` with `ApprovalsReviewer::AutoReview`.

**Call relations**: Directly exercises the retry logic inside `build_exec_config`, mirroring the path `run_main` relies on during startup.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 5 external calls (default, assert!, assert_eq!, write, tempdir).


##### `build_exec_config_preserves_headless_error_when_retry_fails`  (lines 553–575)

```
async fn build_exec_config_preserves_headless_error_when_retry_fails()
```

**Purpose**: Checks that speculative retry does not overwrite the original headless error when the retry path also fails or is not justified. This preserves useful diagnostics.

**Data flow**: Calls `build_exec_config` with a closure that returns different `std::io::Error`s depending on whether `approval_policy` is `Never`, expects failure, and asserts the original `"headless error"` is preserved.

**Call relations**: Complements the previous test by covering the error-preservation branch in `build_exec_config`.

*Call graph*: 2 external calls (default, assert_eq!).


##### `thread_start_params_include_user_thread_source`  (lines 578–594)

```
async fn thread_start_params_include_user_thread_source()
```

**Purpose**: Verifies that fresh threads are started with `ThreadSource::User`. This preserves source attribution in app-server thread metadata.

**Data flow**: Builds a default temporary `Config`, calls `thread_start_params_from_config`, and asserts `params.thread_source == Some(User)`.

**Call relations**: Direct unit test of one fixed field in the thread-start helper.

*Call graph*: 3 external calls (assert_eq!, default, tempdir).


##### `thread_lifecycle_params_preserve_hook_trust_bypass`  (lines 597–620)

```
async fn thread_lifecycle_params_preserve_hook_trust_bypass()
```

**Purpose**: Checks that both thread-start and thread-resume params carry the `bypass_hook_trust` config override when enabled. This ensures lifecycle symmetry.

**Data flow**: Builds a temporary `Config` with `bypass_hook_trust: true`, computes expected JSON config map, calls both `thread_start_params_from_config` and `thread_resume_params_from_config`, and asserts their `config` fields match.

**Call relations**: Exercises `thread_config_overrides_from_config` indirectly through both lifecycle-param builders.

*Call graph*: 6 external calls (default, from, assert_eq!, default, Bool, tempdir).


##### `active_profile_selection_uses_profile_id_only`  (lines 623–629)

```
fn active_profile_selection_uses_profile_id_only()
```

**Purpose**: Verifies that permission-profile selection is just the active profile's ID string. This keeps the app-server selection contract stable.

**Data flow**: Constructs an `ActivePermissionProfile`, passes it to `permission_profile_id_from_active_profile`, and asserts the returned string equals the built-in workspace profile ID.

**Call relations**: Direct unit test of the tiny profile-ID extraction helper.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `thread_lifecycle_params_include_legacy_sandbox_when_no_active_profile`  (lines 632–661)

```
async fn thread_lifecycle_params_include_legacy_sandbox_when_no_active_profile()
```

**Purpose**: Checks that when no active permission profile exists, thread lifecycle params fall back to explicit legacy sandbox mode and omit `permissions`. This preserves backward compatibility.

**Data flow**: Builds a temporary `Config` with a legacy sandbox override and no managed config, calls both lifecycle-param helpers, and asserts `permissions == None` plus `sandbox == Some(DangerFullAccess)` for both.

**Call relations**: Exercises the `permissions_selection_from_config` absent path and `sandbox_mode_from_permission_profile` fallback through both lifecycle-param builders.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 4 external calls (default, assert_eq!, default, tempdir).


##### `session_configured_from_thread_response_uses_review_policy_from_response`  (lines 664–687)

```
async fn session_configured_from_thread_response_uses_review_policy_from_response()
```

**Purpose**: Verifies that bootstrap session mapping takes the approvals reviewer from the thread-start response rather than inventing one. This protects response authority.

**Data flow**: Builds a temporary `Config`, obtains `sample_thread_start_response()`, calls `session_configured_from_thread_start_response`, and asserts parsed session/thread IDs and `approvals_reviewer == AutoReview`.

**Call relations**: Direct unit test of the thread-start bootstrap mapping helper.

*Call graph*: calls 1 internal fn (sample_thread_start_response); 3 external calls (assert_eq!, default, tempdir).


##### `session_configured_from_thread_response_uses_permission_profile_from_config`  (lines 690–708)

```
async fn session_configured_from_thread_response_uses_permission_profile_from_config()
```

**Purpose**: Checks that bootstrap session mapping uses the effective permission profile from local config. This preserves exec's local permission interpretation in the synthesized event.

**Data flow**: Builds a temporary `Config`, maps `sample_thread_start_response()` through `session_configured_from_thread_start_response`, and compares `event.permission_profile` to `config.permissions.effective_permission_profile()`.

**Call relations**: Exercises another field choice inside the same bootstrap mapping path.

*Call graph*: calls 1 internal fn (sample_thread_start_response); 3 external calls (assert_eq!, default, tempdir).


##### `session_configured_from_thread_response_preserves_thread_source`  (lines 711–729)

```
async fn session_configured_from_thread_response_preserves_thread_source()
```

**Purpose**: Verifies that thread source from the app-server response is preserved in the synthesized `SessionConfiguredEvent`.

**Data flow**: Builds a temporary `Config`, maps `sample_thread_start_response()`, and asserts `event.thread_source == Some(ThreadSource::User)`.

**Call relations**: Direct unit test of source propagation in `session_configured_from_thread_start_response`.

*Call graph*: calls 1 internal fn (sample_thread_start_response); 3 external calls (assert_eq!, default, tempdir).


##### `session_configured_from_thread_response_preserves_parent_thread_id`  (lines 732–749)

```
async fn session_configured_from_thread_response_preserves_parent_thread_id()
```

**Purpose**: Checks that a parent thread ID present in the response is parsed and preserved in the synthesized session-configured event.

**Data flow**: Builds a temporary `Config`, mutates `sample_thread_start_response()` to include a generated parent thread ID string, maps it through `session_configured_from_thread_start_response`, and asserts the parsed `event.parent_thread_id` matches.

**Call relations**: Covers the optional parent-thread parsing branch in the shared bootstrap mapping logic.

*Call graph*: calls 2 internal fn (sample_thread_start_response, new); 3 external calls (assert_eq!, default, tempdir).


##### `sample_thread_start_response`  (lines 751–792)

```
fn sample_thread_start_response() -> ThreadStartResponse
```

**Purpose**: Provides a reusable `ThreadStartResponse` fixture with stable IDs and representative metadata for bootstrap mapping tests.

**Data flow**: Constructs and returns a concrete `ThreadStartResponse` containing a thread record, model/provider, cwd, approval settings, sandbox policy, and empty turns.

**Call relations**: Used by the session-configured mapping tests as the canonical response fixture.

*Call graph*: called by 4 (session_configured_from_thread_response_preserves_parent_thread_id, session_configured_from_thread_response_preserves_thread_source, session_configured_from_thread_response_uses_permission_profile_from_config, session_configured_from_thread_response_uses_review_policy_from_response); 5 external calls (from, new, new, test_path_buf, vec!).


### Output event processors
These suites verify how exec converts internal/app-server events into human-readable, JSONL, and machine-readable output streams, including completion and failure handling.

### `exec/src/event_processor_with_human_output_tests.rs`

`test` · `request handling / shutdown behavior tests`

This test file targets the pure helpers and stateful edge cases in `event_processor_with_human_output.rs`. Several small tests lock down the exact boolean behavior of `should_print_final_message_to_stdout` and `should_print_final_message_to_tty` for combinations of terminal/non-terminal stdout and stderr and whether the final message was already rendered. Two tests cover `reasoning_text`, ensuring summary text is preferred when raw reasoning is hidden and raw content is used when enabled. Sandbox-summary tests exercise `codex_utils_sandbox_summary::summarize_permission_profile` with disabled, external, workspace-write, and read-only permission profiles, using absolute test paths and explicit runtime permission structures.

The larger tests focus on final-message recovery and shutdown semantics. `config_summary_entries_include_runtime_workspace_roots` builds a real async `Config` with temporary directories and verifies the generated sandbox summary includes runtime workspace roots rather than only static config. The remaining tests instantiate `EventProcessorWithHumanOutput` directly with neutral `Style::new()` values and feed it `ServerNotification::TurnCompleted` events containing different `TurnStatus` values and item lists. They verify that successful turns recover or overwrite the final message from turn items, preserve a streamed final message when turn items are empty, and that failed or interrupted turns clear stale final-message state and disable shutdown emission.

#### Function details

##### `suppresses_final_stdout_message_when_both_streams_are_terminals`  (lines 31–37)

```
fn suppresses_final_stdout_message_when_both_streams_are_terminals()
```

**Purpose**: Checks that interactive terminal sessions do not mirror the final message to stdout. This preserves stderr-oriented human rendering when both streams are TTYs.

**Data flow**: It calls `should_print_final_message_to_stdout(Some("hello"), true, true)` and asserts the returned boolean is false.

**Call relations**: This is a direct unit test of the stdout-selection predicate, run by the test harness.

*Call graph*: 1 external calls (assert!).


##### `prints_final_stdout_message_when_stdout_is_not_terminal`  (lines 40–46)

```
fn prints_final_stdout_message_when_stdout_is_not_terminal()
```

**Purpose**: Verifies that the final message is sent to stdout when stdout is redirected or piped. This supports non-interactive consumption of the final answer.

**Data flow**: It evaluates `should_print_final_message_to_stdout(Some("hello"), false, true)` and asserts the result is true.

**Call relations**: This test directly exercises one branch of the stdout-selection helper.

*Call graph*: 1 external calls (assert!).


##### `prints_final_stdout_message_when_stderr_is_not_terminal`  (lines 49–55)

```
fn prints_final_stdout_message_when_stderr_is_not_terminal()
```

**Purpose**: Verifies that the final message is also sent to stdout when stderr is not a terminal. It covers the other non-interactive stream combination.

**Data flow**: It calls `should_print_final_message_to_stdout(Some("hello"), true, false)` and asserts the predicate returns true.

**Call relations**: This is another focused helper test for shutdown stream selection.

*Call graph*: 1 external calls (assert!).


##### `suppresses_final_stdout_message_when_missing`  (lines 58–63)

```
fn suppresses_final_stdout_message_when_missing()
```

**Purpose**: Ensures no stdout final-message emission occurs when there is no final message at all. It guards against printing empty or spurious output.

**Data flow**: It calls `should_print_final_message_to_stdout(None, false, false)` and asserts the result is false.

**Call relations**: This test covers the missing-message branch of the stdout predicate.

*Call graph*: 1 external calls (assert!).


##### `prints_final_tty_message_when_not_yet_rendered`  (lines 66–73)

```
fn prints_final_tty_message_when_not_yet_rendered()
```

**Purpose**: Checks that an interactive session prints the final message to the terminal at shutdown if it was never rendered during streaming. This supports turns whose final answer is only recoverable at completion time.

**Data flow**: It calls `should_print_final_message_to_tty(Some("hello"), false, true, true)` and asserts the result is true.

**Call relations**: This directly tests the positive branch of the TTY fallback predicate.

*Call graph*: 1 external calls (assert!).


##### `suppresses_final_tty_message_when_already_rendered`  (lines 76–83)

```
fn suppresses_final_tty_message_when_already_rendered()
```

**Purpose**: Ensures the processor does not duplicate a final message on the terminal when it was already shown during streaming. It protects against repeated human-visible output.

**Data flow**: It calls `should_print_final_message_to_tty(Some("hello"), true, true, true)` and asserts the result is false.

**Call relations**: This is the duplicate-suppression counterpart to the previous predicate test.

*Call graph*: 1 external calls (assert!).


##### `reasoning_text_prefers_summary_when_raw_reasoning_is_hidden`  (lines 86–94)

```
fn reasoning_text_prefers_summary_when_raw_reasoning_is_hidden()
```

**Purpose**: Verifies that reasoning display uses the summary text when raw reasoning is disabled, even if raw content exists. This matches the default privacy/verbosity policy.

**Data flow**: It passes one-element summary and content slices plus `false` to `reasoning_text`, then asserts the returned `Option<String>` dereferences to `Some("summary")`.

**Call relations**: This unit test directly targets the reasoning-selection helper.

*Call graph*: 2 external calls (assert_eq!, reasoning_text).


##### `reasoning_text_uses_raw_content_when_enabled`  (lines 97–105)

```
fn reasoning_text_uses_raw_content_when_enabled()
```

**Purpose**: Verifies that reasoning display switches to raw content when the corresponding flag is enabled. It confirms the helper’s branch preference.

**Data flow**: It calls `reasoning_text` with summary/content slices and `true`, then asserts the returned text is `Some("raw")`.

**Call relations**: This complements the previous reasoning helper test by covering the raw-content branch.

*Call graph*: 2 external calls (assert_eq!, reasoning_text).


##### `summarizes_disabled_permission_profile_as_danger_full_access`  (lines 108–119)

```
fn summarizes_disabled_permission_profile_as_danger_full_access()
```

**Purpose**: Checks the sandbox-summary string for a disabled permission profile. The expected human-facing label is `danger-full-access`.

**Data flow**: It creates an absolute `/tmp` path with `test_path_buf(...).abs()`, passes `PermissionProfile::Disabled` and that path to `summarize_permission_profile`, and asserts the returned string equals `danger-full-access`.

**Call relations**: Although it tests an external helper, this protects the wording relied on by `config_summary_entries` output.

*Call graph*: 2 external calls (assert_eq!, test_path_buf).


##### `summarizes_external_permission_profile`  (lines 122–135)

```
fn summarizes_external_permission_profile()
```

**Purpose**: Verifies the summary string for an external sandbox profile with network enabled. It ensures the human config summary reflects both sandbox mode and network access.

**Data flow**: It builds an absolute cwd path, constructs `PermissionProfile::External { network: NetworkSandboxPolicy::Enabled }`, calls `summarize_permission_profile`, and asserts the exact returned string.

**Call relations**: This is another wording-focused test for sandbox summaries used by the human output backend.

*Call graph*: 2 external calls (assert_eq!, test_path_buf).


##### `summarizes_managed_workspace_write_permission_profile`  (lines 138–161)

```
fn summarizes_managed_workspace_write_permission_profile()
```

**Purpose**: Checks that a managed restricted filesystem policy with writable cwd and cache root is summarized as workspace-write including both roots. It validates path-list formatting in the summary.

**Data flow**: It creates absolute cwd and cache-root paths, builds a restricted `FileSystemSandboxPolicy` with two writable entries, converts that into a `PermissionProfile` via `from_runtime_permissions`, calls `summarize_permission_profile` with both workspace roots, and asserts the formatted string includes `workdir` and the cache-root display path.

**Call relations**: This test covers a realistic workspace-write configuration that `config_summary_entries` may display.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 3 external calls (assert_eq!, test_path_buf, vec!).


##### `summarizes_managed_read_only_permission_profile`  (lines 164–175)

```
fn summarizes_managed_read_only_permission_profile()
```

**Purpose**: Verifies that a restricted filesystem policy with no writable entries is summarized as `read-only`. It protects the simplest managed sandbox label.

**Data flow**: It creates an absolute cwd path, builds an empty restricted filesystem policy, converts it with `from_runtime_permissions`, calls `summarize_permission_profile`, and asserts the result is `read-only`.

**Call relations**: This complements the workspace-write summary test by covering the read-only branch.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 3 external calls (new, assert_eq!, test_path_buf).


##### `config_summary_entries_include_runtime_workspace_roots`  (lines 178–241)

```
async fn config_summary_entries_include_runtime_workspace_roots()
```

**Purpose**: Ensures `config_summary_entries` uses the runtime workspace roots stored in `Config` and permissions state when building the sandbox summary. This prevents stale or incomplete root lists in the startup banner.

**Data flow**: It asynchronously builds a default `Config` with temporary codex-home and cwd directories, creates an extra workspace root, mutates `config.cwd` and `config.workspace_roots`, synchronizes those roots into `config.permissions`, sets a workspace-write permission profile, constructs a `SessionConfiguredEvent` from the runtime config, calls `config_summary_entries`, extracts the `sandbox` entry, and asserts the summary starts with `workspace-write [workdir, ` and contains the extra root’s file name.

**Call relations**: This Tokio test directly exercises the helper used by `print_config_summary`, validating integration between config state and sandbox summarization.

*Call graph*: calls 3 internal fn (workspace_write_with, new, new); 5 external calls (assert!, default, config_summary_entries, tempdir, vec!).


##### `final_message_from_turn_items_uses_latest_agent_message`  (lines 244–265)

```
fn final_message_from_turn_items_uses_latest_agent_message()
```

**Purpose**: Checks that final-message extraction prefers the most recent agent message over earlier messages and plans. It validates reverse-search behavior.

**Data flow**: It builds a slice of `ThreadItem` values containing two `AgentMessage`s and one `Plan`, calls `final_message_from_turn_items`, and asserts the returned message is `Some("second")`.

**Call relations**: This directly tests the helper used during successful turn completion in the human processor.

*Call graph*: 2 external calls (assert_eq!, final_message_from_turn_items).


##### `final_message_from_turn_items_falls_back_to_latest_plan`  (lines 268–286)

```
fn final_message_from_turn_items_falls_back_to_latest_plan()
```

**Purpose**: Verifies that final-message extraction falls back to the latest plan when no agent message exists. This supports turns that end with planning output only.

**Data flow**: It constructs reasoning and plan items, calls `final_message_from_turn_items`, and asserts the result is the text of the last `Plan` item.

**Call relations**: This covers the fallback branch of the same helper used by `process_server_notification`.

*Call graph*: 4 external calls (new, assert_eq!, final_message_from_turn_items, vec!).


##### `turn_completed_recovers_final_message_from_turn_items`  (lines 289–334)

```
fn turn_completed_recovers_final_message_from_turn_items()
```

**Purpose**: Ensures a completed turn with an agent message in its item list populates `final_message` and requests shutdown. It covers the normal successful-turn recovery path.

**Data flow**: It constructs an `EventProcessorWithHumanOutput` with neutral styles and empty state, sends a `ServerNotification::TurnCompleted` containing a `Turn` with one `AgentMessage` and `TurnStatus::Completed`, captures the returned `CodexStatus`, and asserts shutdown was initiated and `processor.final_message` became `Some("final answer")`.

**Call relations**: This stateful unit test drives `process_server_notification` directly and validates its use of `final_message_from_turn_items`.

*Call graph*: 4 external calls (TurnCompleted, new, assert_eq!, vec!).


##### `turn_completed_overwrites_stale_final_message_from_turn_items`  (lines 337–383)

```
fn turn_completed_overwrites_stale_final_message_from_turn_items()
```

**Purpose**: Verifies that a completed turn replaces a previously streamed stale final message with the authoritative message from turn items and marks it as not yet rendered if the text changed. This prevents stale shutdown output.

**Data flow**: It initializes the processor with `final_message = Some("stale answer")` and `final_message_rendered = true`, sends a completed-turn notification containing `"final answer"`, and asserts the returned status is shutdown, `final_message` is updated, and `final_message_rendered` becomes false.

**Call relations**: This test targets the branch in `process_server_notification` that compares previously rendered output with recovered turn-item output.

*Call graph*: 5 external calls (TurnCompleted, new, assert!, assert_eq!, vec!).


##### `turn_completed_preserves_streamed_final_message_when_turn_items_are_empty`  (lines 386–427)

```
fn turn_completed_preserves_streamed_final_message_when_turn_items_are_empty()
```

**Purpose**: Ensures that if a successful turn completes with no items, an already streamed final message is preserved and still scheduled for shutdown emission. It protects against losing output when the completion payload is sparse.

**Data flow**: It initializes the processor with `final_message = Some("streamed answer")`, `final_message_rendered = false`, and no turn items, sends a completed-turn notification, and asserts shutdown is initiated, the final message remains unchanged, and `emit_final_message_on_shutdown` is true.

**Call relations**: This test covers the successful-turn path where `final_message_from_turn_items` returns `None`, so existing streamed state must be retained.

*Call graph*: 5 external calls (TurnCompleted, new, new, assert!, assert_eq!).


##### `turn_failed_clears_stale_final_message`  (lines 430–472)

```
fn turn_failed_clears_stale_final_message()
```

**Purpose**: Checks that a failed turn clears any stale final message and disables shutdown emission. This prevents partial answers from being treated as final output.

**Data flow**: It initializes the processor with a stale final message and emission flags set, sends a `TurnCompleted` notification whose `TurnStatus` is `Failed`, and asserts the returned status is shutdown, `final_message` becomes `None`, `final_message_rendered` becomes false, and `emit_final_message_on_shutdown` becomes false.

**Call relations**: This directly tests the failure branch of `process_server_notification` for turn completion.

*Call graph*: 5 external calls (TurnCompleted, new, new, assert!, assert_eq!).


##### `turn_interrupted_clears_stale_final_message`  (lines 475–517)

```
fn turn_interrupted_clears_stale_final_message()
```

**Purpose**: Checks that an interrupted turn also clears stale final-message state and disables shutdown emission. It mirrors the failed-turn safety behavior for interruptions.

**Data flow**: It initializes the processor with a stale final message and emission flags set, sends a `TurnCompleted` notification whose `TurnStatus` is `Interrupted`, and asserts shutdown is initiated and all final-message-related state is cleared.

**Call relations**: This is the interruption counterpart to the failed-turn test, covering the other non-success shutdown branch in `process_server_notification`.

*Call graph*: 5 external calls (TurnCompleted, new, new, assert!, assert_eq!).


### `exec/src/event_processor_with_jsonl_output_tests.rs`

`test` · `request handling / shutdown serialization tests`

This test file exercises the structured-output backend at the event-collection level. The first test seeds a real output file, drives the processor through an `ItemCompleted` agent message followed by a failed `TurnCompleted`, and then calls the trait’s `print_final_output` to prove that failed turns clear `final_message` and do not overwrite the existing file contents. The second test checks the warning path: a `ServerNotification::Warning` should become a single `ThreadEvent::ItemCompleted` containing `ThreadItemDetails::Error`, and the processor should remain in `CodexStatus::Running` rather than escalating to a fatal thread error. The third test validates detailed MCP result mapping by sending a completed `ThreadItem::McpToolCall` with `_meta`-style payload content. It asserts both the in-memory mapped result preserves `meta` and the serialized JSON event exposes that data under `item.result._meta` while omitting a plain `meta` field. Together these tests lock down shutdown safety, warning semantics, and schema fidelity for machine-readable consumers.

#### Function details

##### `failed_turn_does_not_overwrite_output_last_message_file`  (lines 7–60)

```
fn failed_turn_does_not_overwrite_output_last_message_file()
```

**Purpose**: Verifies that a failed turn clears the remembered final message and prevents shutdown from rewriting the configured last-message file. This protects existing output files from being replaced by partial or empty content after failure.

**Data flow**: It creates a temporary directory and seeds `last-message.txt` with known contents, constructs `EventProcessorWithJsonOutput::new(Some(output_path))`, feeds an `ItemCompleted` agent-message notification to populate `processor.final_message`, then feeds a failed `TurnCompleted` notification and asserts the returned status is `InitiateShutdown` and `final_message()` is `None`. Finally it invokes `EventProcessor::print_final_output(&mut processor)` and reads the file back to assert the original contents remain unchanged.

**Call relations**: This test drives both `collect_thread_events` and the trait-level shutdown hook. It specifically validates the interaction between failed-turn state clearing and `print_final_output`’s conditional call to `handle_last_message`.

*Call graph*: calls 2 internal fn (print_final_output, new); 6 external calls (ItemCompleted, TurnCompleted, new, assert_eq!, write, tempdir).


##### `runtime_warning_emits_a_non_fatal_error_item`  (lines 63–87)

```
fn runtime_warning_emits_a_non_fatal_error_item()
```

**Purpose**: Checks that a runtime warning is represented as a non-fatal completed error item event rather than a critical thread error or shutdown signal. It locks down the JSONL warning schema.

**Data flow**: It creates a processor with no last-message path, passes a `ServerNotification::Warning` into `collect_thread_events`, and asserts the returned `CollectedThreadEvents` exactly matches one `ThreadEvent::ItemCompleted` containing `ThreadItemDetails::Error` with id `item_0` and status `CodexStatus::Running`.

**Call relations**: This is a direct unit test of `collect_thread_events`’ warning branch, indirectly exercising `collect_warning`.

*Call graph*: calls 1 internal fn (new); 2 external calls (Warning, assert_eq!).


##### `mcp_tool_call_result_preserves_meta_in_jsonl_event`  (lines 90–138)

```
fn mcp_tool_call_result_preserves_meta_in_jsonl_event()
```

**Purpose**: Verifies that MCP tool-call result metadata is preserved through internal mapping and JSON serialization, and that the serialized field name is `_meta` rather than `meta`. This protects compatibility for downstream JSONL consumers expecting the wire schema.

**Data flow**: It creates a processor, feeds an `ItemCompleted` notification containing a completed `ThreadItem::McpToolCall` with arguments, content, and `meta` JSON, asserts the collected status is `Running` and exactly one event was produced, destructures that event to inspect the mapped `ThreadItemDetails::McpToolCall`, and asserts `result.meta` matches the original JSON. It then serializes the event with `serde_json::to_value` and asserts `serialized["item"]["result"]["_meta"]` contains the metadata while `serialized["item"]["result"].get("meta")` is absent.

**Call relations**: This test exercises the MCP branch of `map_item_with_id` through `collect_thread_events`, then validates both in-memory mapping and serde output shape.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, ItemCompleted, assert!, assert_eq!, json!, panic!, to_value, vec!).


### `exec/tests/event_processor_with_json_output.rs`

`test` · `test-time event translation validation`

This integration-style test file focuses on `EventProcessorWithJsonOutput`, the component that turns app-server protocol notifications into the exec crate's exported `ThreadEvent` stream. Each test constructs concrete `ServerNotification` values—`TurnStarted`, `ItemStarted`, `ItemCompleted`, `TurnPlanUpdated`, `ThreadTokenUsageUpdated`, `TurnCompleted`, `Error`, and `ModelRerouted`—and asserts the exact `CollectedThreadEvents` returned by the processor. The suite covers many item mappings: command execution, reasoning summaries, web search actions, MCP tool calls with results/errors/structured content, collaborative agent tool calls, file changes with patch-kind/status translation, agent messages, warnings-as-error-items, and todo-list plan updates.

A recurring concern is synthetic item identity. Because some protocol items do not map one-to-one onto stable streamed IDs, the processor assigns `item_0`, `item_1`, and so on; tests verify unsupported items do not consume IDs and that started/completed notifications for the same logical item reuse the same synthetic ID. Another major theme is terminal reconciliation: on `TurnCompleted`, the processor may emit final todo completion, recover the final message from `turn.items`, reconcile previously started items into completed ones, preserve streamed final messages when terminal items are empty, clear stale final messages on failed turns, and attach token usage accumulated from earlier `ThreadTokenUsageUpdated` notifications. Together these tests define the JSONL contract consumed by automation and downstream tooling.

#### Function details

##### `map_todo_items_preserves_text_and_completion_state`  (lines 79–104)

```
fn map_todo_items_preserves_text_and_completion_state()
```

**Purpose**: Verifies that plan steps are converted into `TodoItem`s with the correct text and completed flag. It checks the summary mapping used for plan updates.

**Data flow**: Builds two `TurnPlanStep` values with `InProgress` and `Completed` statuses, passes them to `EventProcessorWithJsonOutput::map_todo_items`, and asserts the returned `Vec<TodoItem>`.

**Call relations**: Directly exercises the processor's static todo-mapping helper used during `TurnPlanUpdated` handling.

*Call graph*: calls 1 internal fn (map_todo_items); 1 external calls (assert_eq!).


##### `session_configured_produces_thread_started_event`  (lines 107–137)

```
fn session_configured_produces_thread_started_event()
```

**Purpose**: Checks that a bootstrap `SessionConfiguredEvent` becomes a `ThreadStarted` thread event containing the thread ID. This validates the processor's startup-event projection.

**Data flow**: Constructs a concrete `SessionConfiguredEvent`, calls `EventProcessorWithJsonOutput::thread_started_event`, and compares the returned `ThreadEvent` to the expected `ThreadStartedEvent`.

**Call relations**: Tests the processor helper used when exec prints initial JSON output from synthesized session configuration.

*Call graph*: calls 3 internal fn (read_only, from, from_string); 2 external calls (assert_eq!, test_path_buf).


##### `turn_started_emits_turn_started_event`  (lines 140–165)

```
fn turn_started_emits_turn_started_event()
```

**Purpose**: Verifies that a `TurnStarted` server notification yields a running-status collection containing a `TurnStarted` event.

**Data flow**: Creates a fresh processor, feeds it `ServerNotification::TurnStarted`, and asserts the returned `CollectedThreadEvents` contains one `ThreadEvent::TurnStarted` and `CodexStatus::Running`.

**Call relations**: Exercises the processor's notification dispatch for turn-start lifecycle events.

*Call graph*: calls 1 internal fn (new); 3 external calls (TurnStarted, new, assert_eq!).


##### `command_execution_started_and_completed_translate_to_thread_events`  (lines 168–244)

```
fn command_execution_started_and_completed_translate_to_thread_events()
```

**Purpose**: Checks that command execution items map to started and completed thread-item events with the same synthetic ID and correct command/output/exit-code/status fields.

**Data flow**: Creates a processor, sends an `ItemStarted` notification for `ThreadItem::CommandExecution`, asserts the started event, then sends a matching `ItemCompleted` notification and asserts the completed event with updated output and exit code.

**Call relations**: Covers both start and completion branches of command-execution item translation inside the JSON processor.

*Call graph*: calls 1 internal fn (new); 5 external calls (ItemCompleted, ItemStarted, new, assert_eq!, test_path_buf).


##### `empty_reasoning_items_are_ignored`  (lines 247–270)

```
fn empty_reasoning_items_are_ignored()
```

**Purpose**: Verifies that reasoning items with an empty summary do not emit any JSON thread events. Raw reasoning content alone is intentionally not surfaced.

**Data flow**: Feeds the processor an `ItemCompleted` notification containing `ThreadItem::Reasoning { summary: Vec::new(), ... }` and asserts the returned event list is empty with running status.

**Call relations**: Exercises the processor's reasoning-item filtering rule.

*Call graph*: calls 1 internal fn (new); 4 external calls (ItemCompleted, new, assert_eq!, vec!).


##### `unsupported_items_do_not_consume_synthetic_ids`  (lines 273–324)

```
fn unsupported_items_do_not_consume_synthetic_ids()
```

**Purpose**: Checks that ignored protocol items, such as `Plan`, do not advance the processor's synthetic item-ID counter. The next supported item should still receive `item_0`.

**Data flow**: Creates a processor, sends an ignored `ItemCompleted(Plan)` notification and asserts no events, then sends an `ItemCompleted(AgentMessage)` notification and asserts the emitted item uses synthetic ID `item_0`.

**Call relations**: Protects internal ID-allocation behavior across mixed supported and unsupported notifications.

*Call graph*: calls 1 internal fn (new); 2 external calls (ItemCompleted, assert_eq!).


##### `reasoning_items_emit_summary_not_raw_content`  (lines 327–357)

```
fn reasoning_items_emit_summary_not_raw_content()
```

**Purpose**: Verifies that reasoning output uses the safe summary text rather than raw reasoning content. This preserves the processor's redaction/summary contract.

**Data flow**: Feeds a completed reasoning item with both `summary` and `content`, then asserts the emitted `ReasoningItem.text` equals the summary string.

**Call relations**: Exercises the supported reasoning-item mapping branch after the empty-summary case.

*Call graph*: calls 1 internal fn (new); 3 external calls (ItemCompleted, assert_eq!, vec!).


##### `web_search_completion_preserves_query_and_action`  (lines 360–398)

```
fn web_search_completion_preserves_query_and_action()
```

**Purpose**: Checks that completed web-search items preserve both the query string and structured search action in the emitted thread event.

**Data flow**: Creates a processor, sends an `ItemCompleted` notification for `ThreadItem::WebSearch` with a `Search` action payload, and asserts the resulting `WebSearchItem` fields.

**Call relations**: Tests the processor's mapping from app-server web-search protocol types into exec's exported JSON event model.

*Call graph*: calls 1 internal fn (new); 2 external calls (ItemCompleted, assert_eq!).


##### `web_search_start_and_completion_reuse_item_id`  (lines 401–467)

```
fn web_search_start_and_completion_reuse_item_id()
```

**Purpose**: Verifies that started and completed notifications for the same web-search item share one synthetic ID and that missing start-time action data defaults to `WebSearchAction::Other`.

**Data flow**: Sends `ItemStarted(WebSearch)` with empty query/action, then `ItemCompleted(WebSearch)` with populated query/action, and asserts both emitted events use `item_0` with the expected details at each stage.

**Call relations**: Covers both lifecycle phases of web-search item handling and the processor's ID reuse logic.

*Call graph*: calls 1 internal fn (new); 4 external calls (ItemCompleted, ItemStarted, new, assert_eq!).


##### `mcp_tool_call_begin_and_end_emit_item_events`  (lines 470–557)

```
fn mcp_tool_call_begin_and_end_emit_item_events()
```

**Purpose**: Checks that MCP tool calls emit started and completed item events with preserved server/tool/arguments and mapped result/status fields.

**Data flow**: Creates a processor, sends started and completed notifications for the same `ThreadItem::McpToolCall`, and asserts the emitted `McpToolCallItem` details before and after completion.

**Call relations**: Exercises the processor's MCP tool-call translation for the successful path.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, ItemCompleted, ItemStarted, new, assert_eq!, json!).


##### `mcp_tool_call_failure_sets_failed_status`  (lines 560–606)

```
fn mcp_tool_call_failure_sets_failed_status()
```

**Purpose**: Verifies that failed MCP tool calls map to `McpToolCallStatus::Failed` and preserve the structured error message.

**Data flow**: Feeds a completed MCP tool-call notification with failed status and `McpToolCallError`, then asserts the emitted completed item contains the mapped error and failed status.

**Call relations**: Covers the failure branch of MCP tool-call mapping.

*Call graph*: calls 1 internal fn (new); 3 external calls (ItemCompleted, assert_eq!, json!).


##### `mcp_tool_call_defaults_arguments_and_preserves_structured_content`  (lines 609–702)

```
fn mcp_tool_call_defaults_arguments_and_preserves_structured_content()
```

**Purpose**: Checks that MCP tool calls preserve `Value::Null` arguments and carry structured result content through completion. This protects non-object argument payloads and richer result shapes.

**Data flow**: Sends started and completed MCP tool-call notifications with `arguments: Null` and a result containing both content and `structured_content`, then asserts the emitted events preserve those values.

**Call relations**: Complements the previous MCP tests by covering null arguments and structured result payloads.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, ItemCompleted, ItemStarted, assert_eq!, json!, vec!).


##### `collab_spawn_begin_and_end_emit_item_events`  (lines 705–794)

```
fn collab_spawn_begin_and_end_emit_item_events()
```

**Purpose**: Verifies that collaborative agent spawn tool calls map into started and completed collab-tool events with sender/receiver IDs, prompt, agent states, and status transitions.

**Data flow**: Creates a processor, sends started and completed `ThreadItem::CollabAgentToolCall` notifications, and asserts the emitted `CollabToolCallItem` details and synthetic ID reuse.

**Call relations**: Exercises the processor's mapping for collaborative-agent tool-call protocol items.

*Call graph*: calls 1 internal fn (new); 7 external calls (ItemCompleted, ItemStarted, new, assert_eq!, from, new, vec!).


##### `file_change_completion_maps_change_kinds`  (lines 797–857)

```
fn file_change_completion_maps_change_kinds()
```

**Purpose**: Checks that completed file-change items map patch change kinds and completion status into exec's exported file-change model.

**Data flow**: Feeds a completed `ThreadItem::FileChange` containing add/delete/update changes, then asserts the emitted `FileChangeItem` contains `PatchChangeKind::{Add,Delete,Update}` and `PatchApplyStatus::Completed`.

**Call relations**: Tests the processor's file-change translation logic for the successful path.

*Call graph*: calls 1 internal fn (new); 3 external calls (ItemCompleted, assert_eq!, vec!).


##### `file_change_declined_maps_to_failed_status`  (lines 860–898)

```
fn file_change_declined_maps_to_failed_status()
```

**Purpose**: Verifies that a declined patch application is surfaced as a failed file-change status in JSON output.

**Data flow**: Sends a completed `ThreadItem::FileChange` with protocol status `Declined` and asserts the emitted `FileChangeItem.status` is `PatchApplyStatus::Failed`.

**Call relations**: Covers the non-success status mapping branch for file changes.

*Call graph*: calls 1 internal fn (new); 3 external calls (ItemCompleted, assert_eq!, vec!).


##### `agent_message_item_updates_final_message`  (lines 901–933)

```
fn agent_message_item_updates_final_message()
```

**Purpose**: Checks that completed agent-message items both emit an item-completed event and update the processor's tracked final message.

**Data flow**: Creates a processor, feeds it `ItemCompleted(AgentMessage)`, asserts the emitted event, then reads `processor.final_message()` and compares it to the message text.

**Call relations**: Exercises the processor's final-message tracking on streamed agent output.

*Call graph*: calls 1 internal fn (new); 2 external calls (ItemCompleted, assert_eq!).


##### `agent_message_item_started_is_ignored`  (lines 936–959)

```
fn agent_message_item_started_is_ignored()
```

**Purpose**: Verifies that started agent-message notifications do not emit JSON events. Only completed agent messages are surfaced.

**Data flow**: Feeds the processor `ItemStarted(AgentMessage)` and asserts the returned event list is empty with running status.

**Call relations**: Covers the ignored start-phase branch for agent messages.

*Call graph*: calls 1 internal fn (new); 2 external calls (ItemStarted, assert_eq!).


##### `reasoning_item_completed_uses_synthetic_id`  (lines 962–992)

```
fn reasoning_item_completed_uses_synthetic_id()
```

**Purpose**: Checks that supported reasoning completions receive a synthetic item ID just like other mapped items.

**Data flow**: Creates a processor, sends `ItemCompleted(Reasoning)` with a non-empty summary, and asserts the emitted item uses `item_0`.

**Call relations**: Complements reasoning-content tests by focusing on ID allocation.

*Call graph*: calls 1 internal fn (new); 3 external calls (ItemCompleted, assert_eq!, vec!).


##### `warning_event_produces_error_item`  (lines 995–1016)

```
fn warning_event_produces_error_item()
```

**Purpose**: Verifies that warnings collected directly by the processor are surfaced as completed error items rather than a separate warning event type.

**Data flow**: Calls `processor.collect_warning` with a warning string and asserts the returned `CollectedThreadEvents` contains one `ThreadItemDetails::Error` item and running status.

**Call relations**: Exercises the processor's direct warning-ingestion path used by exec for local warnings outside server notifications.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `plan_update_emits_started_then_updated_then_completed`  (lines 1019–1147)

```
fn plan_update_emits_started_then_updated_then_completed()
```

**Purpose**: Checks the full lifecycle of todo-list plan handling: first plan update starts a todo item, subsequent update emits an item-updated event, and turn completion emits final item-completed plus turn-completed events.

**Data flow**: Creates a processor, sends two `TurnPlanUpdated` notifications with evolving step statuses, then a `TurnCompleted` notification, and asserts the exact sequence and contents of emitted events across all three calls.

**Call relations**: Exercises the processor's internal plan-state tracking and terminal reconciliation for todo lists.

*Call graph*: calls 1 internal fn (new); 5 external calls (TurnCompleted, TurnPlanUpdated, new, assert_eq!, vec!).


##### `plan_update_after_completion_starts_new_todo_list_with_new_id`  (lines 1150–1209)

```
fn plan_update_after_completion_starts_new_todo_list_with_new_id()
```

**Purpose**: Verifies that after a turn completes, a later plan update for a new turn starts a fresh todo list with a new synthetic ID rather than reusing the old one.

**Data flow**: Creates a processor, sends a plan update and turn completion for `turn-1`, then another plan update for `turn-2`, and asserts the new started todo-list item uses `item_1`.

**Call relations**: Covers processor state reset between turns for plan/todo tracking.

*Call graph*: calls 1 internal fn (new); 5 external calls (TurnCompleted, TurnPlanUpdated, new, assert_eq!, vec!).


##### `token_usage_update_is_emitted_on_turn_completion`  (lines 1212–1276)

```
fn token_usage_update_is_emitted_on_turn_completion()
```

**Purpose**: Checks that token-usage updates are buffered silently and only surfaced when the turn completes, attached to the terminal `TurnCompletedEvent`.

**Data flow**: Feeds a `ThreadTokenUsageUpdated` notification and asserts no immediate events, then feeds `TurnCompleted` and asserts the emitted `TurnCompletedEvent.usage` contains the buffered token counts.

**Call relations**: Exercises the processor's accumulation of usage state across notifications until terminal emission.

*Call graph*: calls 1 internal fn (new); 4 external calls (ThreadTokenUsageUpdated, TurnCompleted, new, assert_eq!).


##### `turn_completion_recovers_final_message_from_turn_items`  (lines 1279–1313)

```
fn turn_completion_recovers_final_message_from_turn_items()
```

**Purpose**: Verifies that when terminal `turn.items` contain an agent message, the processor updates its final message from that terminal payload even without a prior streamed item-completed event.

**Data flow**: Creates a processor, feeds `TurnCompleted` with `turn.items` containing `AgentMessage`, asserts the emitted terminal event, then checks `processor.final_message()`.

**Call relations**: Covers one of the reconciliation paths that `run_exec_session` relies on after optional turn-item backfill.

*Call graph*: calls 1 internal fn (new); 3 external calls (TurnCompleted, assert_eq!, vec!).


##### `turn_completion_reconciles_started_items_from_turn_items`  (lines 1316–1404)

```
fn turn_completion_reconciles_started_items_from_turn_items()
```

**Purpose**: Checks that a started item still in progress can be reconciled into a completed item when `TurnCompleted.turn.items` contains its final state. This protects against dropped intermediate notifications.

**Data flow**: Sends `ItemStarted(CommandExecution)` to establish tracked state, then `TurnCompleted` whose `turn.items` contains the completed command execution, and asserts the processor emits both `ItemCompleted` for the tracked item and `TurnCompleted`.

**Call relations**: Exercises the same terminal reconciliation behavior that motivates exec's `thread/read` backfill logic.

*Call graph*: calls 1 internal fn (new); 6 external calls (ItemStarted, TurnCompleted, new, assert_eq!, test_path_buf, vec!).


##### `turn_completion_overwrites_stale_final_message_from_turn_items`  (lines 1407–1454)

```
fn turn_completion_overwrites_stale_final_message_from_turn_items()
```

**Purpose**: Verifies that terminal turn items replace any stale final message captured from earlier streamed agent-message events.

**Data flow**: Creates a processor, first feeds a completed stale `AgentMessage`, then feeds `TurnCompleted` with a different final `AgentMessage` in `turn.items`, and asserts `processor.final_message()` now reflects the terminal message.

**Call relations**: Covers precedence rules between streamed and terminal final-message sources.

*Call graph*: calls 1 internal fn (new); 4 external calls (ItemCompleted, TurnCompleted, assert_eq!, vec!).


##### `turn_completion_preserves_streamed_final_message_when_turn_items_are_empty`  (lines 1457–1499)

```
fn turn_completion_preserves_streamed_final_message_when_turn_items_are_empty()
```

**Purpose**: Checks that if terminal turn items are empty, the processor keeps the previously streamed final message instead of clearing it.

**Data flow**: Feeds a completed streamed `AgentMessage`, then a `TurnCompleted` with empty `turn.items`, and asserts the terminal event is emitted while `processor.final_message()` remains the streamed text.

**Call relations**: Complements the previous test by covering the empty-terminal-items branch.

*Call graph*: calls 1 internal fn (new); 4 external calls (ItemCompleted, TurnCompleted, new, assert_eq!).


##### `failed_turn_clears_stale_final_message`  (lines 1502–1544)

```
fn failed_turn_clears_stale_final_message()
```

**Purpose**: Verifies that a failed turn clears any previously tracked final message so automation does not mistake partial output for a successful answer.

**Data flow**: Creates a processor, feeds a completed partial `AgentMessage`, confirms running status and stored final message, then feeds `TurnCompleted` with `TurnStatus::Failed` and asserts shutdown status plus `processor.final_message() == None`.

**Call relations**: Exercises failure cleanup behavior on terminal turn status.

*Call graph*: calls 1 internal fn (new); 4 external calls (ItemCompleted, TurnCompleted, new, assert_eq!).


##### `turn_completion_falls_back_to_final_plan_text`  (lines 1547–1579)

```
fn turn_completion_falls_back_to_final_plan_text()
```

**Purpose**: Checks that when no final agent message exists, the processor can fall back to the final `Plan` item text as the final message.

**Data flow**: Feeds `TurnCompleted` whose `turn.items` contains a `Plan` item, asserts the emitted terminal event, and checks that `processor.final_message()` equals the plan text.

**Call relations**: Covers a fallback final-message source used when agent-message output is absent.

*Call graph*: calls 1 internal fn (new); 3 external calls (TurnCompleted, assert_eq!, vec!).


##### `turn_failure_prefers_structured_error_message`  (lines 1582–1631)

```
fn turn_failure_prefers_structured_error_message()
```

**Purpose**: Verifies that a prior structured `Error` notification supplies the preferred failure message for the eventual `TurnFailed` event, including additional details.

**Data flow**: Creates a processor, feeds `ServerNotification::Error` with `TurnError { message, additional_details }` and asserts the immediate `ThreadErrorEvent`, then feeds a failed `TurnCompleted` without embedded error and asserts the emitted `TurnFailedEvent` reuses the structured message.

**Call relations**: Exercises the processor's error-state retention across notifications until terminal failure emission.

*Call graph*: calls 1 internal fn (new); 4 external calls (Error, TurnCompleted, new, assert_eq!).


##### `model_reroute_surfaces_as_error_item`  (lines 1634–1659)

```
fn model_reroute_surfaces_as_error_item()
```

**Purpose**: Checks that model reroute notifications are surfaced as completed error items with a descriptive reroute message. This makes reroutes visible in JSONL output.

**Data flow**: Feeds `ServerNotification::ModelRerouted` into a fresh processor, asserts running status and a single emitted event, destructures it as `ItemCompleted`, and compares the embedded `ErrorItem.message`.

**Call relations**: Exercises the processor's mapping for reroute notifications, which are not ordinary item lifecycle events.

*Call graph*: calls 1 internal fn (new); 3 external calls (ModelRerouted, assert_eq!, panic!).


### Integration test harness
These files define the shared integration-test crate and module index that collect the exec end-to-end suites into one runnable test binary.

### `exec/tests/all.rs`

`test` · `test discovery and integration-test compilation`

This file is the root of the integration test target under `exec/tests`. It does not implement test logic itself; instead, it configures the test crate and includes subordinate modules. The crate-level `#![allow(clippy::expect_used)]` relaxes linting for tests, acknowledging that assertions and setup code may intentionally use `expect` for clearer failures.

Its structure is intentionally minimal: `mod suite;` imports the aggregated test suite tree from `tests/suite/`, where the former standalone integration tests now live as submodules, and `mod event_processor_with_json_output;` includes an additional top-level integration test module alongside that suite. The practical effect is that Cargo builds one integration-test binary containing all these modules rather than many separate binaries.

Because there are no functions or top-level runtime statements beyond module declarations, this file’s role is organizational. It determines compilation boundaries, lint behavior, and which test modules are visible to the integration test harness. Readers should understand that test discovery and execution flow begin here only in the sense that Rust’s test harness compiles this crate and then runs the `#[test]` items defined in the imported modules.


### `exec/tests/suite/mod.rs`

`test` · `test discovery and integration-test compilation`

This file is a pure test-module manifest. It contains only `mod` declarations for the suite’s constituent integration tests: directory addition, `agents.md` behavior, patch application, approval policy, auth environment handling, ephemeral execution, hooks, MCP-required exit behavior, originator tracking, output schema checks, stdin prompt handling, resume behavior, sandboxing, and server-error exit handling.

The comment explains the intent: these modules were formerly standalone integration tests and are now aggregated as submodules. That changes the compilation layout without changing the underlying test logic. Instead of each file becoming its own integration-test crate, they are compiled together beneath `suite`, which can reduce duplication and make shared helpers easier to organize.

There is no executable logic here, but the file is still important for understanding test structure. Adding or removing a suite file requires updating this manifest; otherwise the Rust test harness will not compile that module into the integration binary rooted at `tests/all.rs`. In other words, this file is the authoritative list of suite modules that participate in integration testing for the `exec` crate.


### Request construction and prompt inputs
These integration tests cover how codex-exec builds outbound requests from prompts, stdin, workspace instructions, auth, headers, schemas, and writable-directory flags.

### `exec/tests/suite/add_dir.rs`

`test` · `test-time CLI integration`

This suite runs only on non-Windows platforms and uses the shared `core_test_support::test_codex_exec` harness plus a mock SSE server. Each test provisions one or more temporary directories, mounts a minimal successful response stream (`response_created`, assistant message, completed), and then invokes the exec binary through the harness with `--skip-git-repo-check`, an explicit sandbox mode of `workspace-write`, one or more `--add-dir` flags, and a simple prompt.

The first test verifies the basic single-use case with two temporary directories and asserts exit code 0. The second extends that to three separate `--add-dir` occurrences to confirm clap parsing and downstream config wiring accept repeated flags. These tests do not inspect the internal request payload or filesystem policy directly; instead, they serve as smoke tests that the CLI accepts the arguments, startup succeeds, and the mocked run completes normally. That makes them valuable regression coverage for command-line parsing and config propagation around additional writable roots.

#### Function details

##### `accepts_add_dir_flag`  (lines 10–38)

```
async fn accepts_add_dir_flag() -> anyhow::Result<()>
```

**Purpose**: Smoke-tests that `codex-exec` accepts repeated `--add-dir` flags and still completes a mocked run successfully.

**Data flow**: Creates the exec test harness, starts a mock server, mounts a successful SSE response stream, creates two temporary directories, invokes the command with sandbox and `--add-dir` arguments plus a prompt, and asserts exit code 0.

**Call relations**: Uses the shared test harness and mock-response helpers to validate binary-level CLI wiring for additional writable roots.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (tempdir, vec!).


##### `accepts_multiple_add_dir_flags`  (lines 42–72)

```
async fn accepts_multiple_add_dir_flags() -> anyhow::Result<()>
```

**Purpose**: Verifies that more than two `--add-dir` flags can be supplied in one invocation without breaking execution.

**Data flow**: Builds the same mocked successful run as the previous test, but creates three temporary directories and passes three `--add-dir` occurrences before asserting exit code 0.

**Call relations**: Extends the same integration path as `accepts_add_dir_flag` to cover repeated-flag parsing more thoroughly.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (tempdir, vec!).


### `exec/tests/suite/agents_md.rs`

`test` · `test-time request composition validation`

This suite uses the exec test harness and a mock SSE server to inspect the actual request payload sent by `codex-exec`. In the first test, it writes `AGENTS.md` into the harness working directory, runs exec with `--skip-git-repo-check` and a simple prompt, then inspects the captured user messages from the single request to ensure the workspace instructions text was included. This confirms that workspace-level agent instructions are loaded and injected into the prompt/request path.

The second test adds both `AGENTS.md` and `AGENTS.override.md`. After the same mocked successful run, it inspects the captured user messages and asserts that `override instructions` appear while `base instructions` do not. That verifies the shadowing rule: `AGENTS.override.md` replaces the base workspace instructions rather than being appended alongside them. These tests are intentionally black-box; they do not call internal loaders directly, but instead validate the externally visible request composition behavior that matters to users and downstream services.

#### Function details

##### `exec_includes_workspace_agents_md_in_request`  (lines 7–34)

```
async fn exec_includes_workspace_agents_md_in_request() -> anyhow::Result<()>
```

**Purpose**: Verifies that a workspace `AGENTS.md` file is incorporated into the user-facing request sent by exec.

**Data flow**: Creates the exec harness, writes `AGENTS.md` into the cwd, starts a mock SSE server, mounts a successful response stream, runs the command, then reads captured user message texts from the recorded request and asserts one contains `workspace instructions`.

**Call relations**: Uses the black-box request capture provided by the test harness to validate instruction-file inclusion during normal exec startup.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 3 external calls (assert!, write, vec!).


##### `exec_prefers_workspace_agents_override_md`  (lines 37–74)

```
async fn exec_prefers_workspace_agents_override_md() -> anyhow::Result<()>
```

**Purpose**: Checks that `AGENTS.override.md` takes precedence over `AGENTS.md` when both are present in the workspace.

**Data flow**: Writes both instruction files into the harness cwd, runs exec against a mock successful server, extracts captured user message texts, and asserts that override text is present while base text is absent.

**Call relations**: Builds on the same request-capture path as the previous test but validates the override/shadowing rule instead of simple inclusion.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 3 external calls (assert!, write, vec!).


### `exec/tests/suite/auth_env.rs`

`test` · `request handling`

This file contains a single async integration test focused on request authentication. It creates a temporary `codex exec` harness, starts a mock SSE server, and resolves the repository root with `codex_utils_cargo_bin::repo_root()` so the command can run from a real project directory via `-C`. The mock server is configured with `mount_sse_once_match` to accept exactly one SSE response only when the incoming request includes `Authorization: Bearer dummy`; the response body itself is minimal, containing only a completion event for `request_0`.

The command is then launched with `--skip-git-repo-check`, `-C <repo_root>`, and a simple prompt. The test asserts only process success, so the header matcher on the mock server is the real verification mechanism: if the executable fails to source the API key from the environment prepared by the test harness, the request would not match and the command would fail. This makes the test specifically about transport-level request construction rather than model output or local config parsing.

#### Function details

##### `exec_uses_codex_api_key_env_var`  (lines 10–31)

```
async fn exec_uses_codex_api_key_env_var() -> anyhow::Result<()>
```

**Purpose**: Runs `codex exec` against a mock backend that requires `Authorization: Bearer dummy`, proving the executable reads and uses the Codex API key environment variable. The test succeeds only if the outgoing request matches that header expectation.

**Data flow**: It creates a test harness, starts a mock server, and computes `repo_root` for the working directory argument. It mounts a one-shot SSE response guarded by a `wiremock::matchers::header` matcher for the authorization header, then executes the command with `--skip-git-repo-check`, `-C`, the repo root, and a prompt, finally asserting subprocess success and returning `Ok(())`.

**Call relations**: This function is invoked directly by the Tokio test runner. It delegates request matching and canned response generation to `mount_sse_once_match`, `header`, `sse`, and `ev_completed`, and uses `test_codex_exec` to obtain a command environment that supplies the expected dummy API key.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex_exec); 3 external calls (repo_root, vec!, header).


### `exec/tests/suite/originator.rs`

`test` · `request handling`

This file contains two Unix-only integration tests around outbound request headers. Both tests create a temporary exec harness, start a mock SSE server, and mount a one-shot successful assistant transcript. The distinguishing feature is that the mock is installed with `mount_sse_once_match` and a `wiremock::matchers::header` predicate on `Originator`, so the request must carry the expected header value for the interaction to succeed.

The first test removes `CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR` from the subprocess environment and expects `Originator: codex_exec`, documenting the default behavior when no override is present. The second test sets `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` to `codex_exec_override` and expects that exact header instead. In both cases the command is run with `--skip-git-repo-check` and a simple prompt, and success code `0` is asserted. The file therefore verifies transport-level metadata generation and the precedence of an internal override environment variable without needing to inspect response content.

#### Function details

##### `send_codex_exec_originator`  (lines 12–31)

```
async fn send_codex_exec_originator() -> anyhow::Result<()>
```

**Purpose**: Verifies that, absent any override, `codex exec` sends `Originator: codex_exec` on its backend request. The test removes the override environment variable explicitly to force the default path.

**Data flow**: It creates a test harness, starts a mock server, builds a standard successful SSE body, and mounts it with a header matcher requiring `Originator` to equal `codex_exec`. It then runs the command with the override env var removed, `--skip-git-repo-check`, and a prompt, asserting exit code `0` before returning `Ok(())`.

**Call relations**: This function is called by the Tokio test runner as the default-originator scenario. It delegates request matching to `mount_sse_once_match` and `header`, and uses the imported override-env-var constant to ensure the subprocess cannot inherit an accidental override.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex_exec); 2 external calls (vec!, header).


##### `supports_originator_override`  (lines 34–54)

```
async fn supports_originator_override() -> anyhow::Result<()>
```

**Purpose**: Verifies that setting the internal originator override environment variable changes the outgoing `Originator` header to the supplied value. It covers the explicit override path complementary to the default-header test.

**Data flow**: It creates a test harness, starts a mock server, constructs the same successful SSE body, and mounts it with a matcher requiring `Originator: codex_exec_override`. It then runs the command with `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` set to `codex_exec_override`, plus `--skip-git-repo-check` and a prompt, and asserts exit code `0` before returning `Ok(())`.

**Call relations**: This test is the paired override case for `send_codex_exec_originator`. It relies on the same mock-server machinery but changes the subprocess environment so the request-construction code should emit the overridden header value.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex_exec); 2 external calls (vec!, header).


### `exec/tests/suite/output_schema.rs`

`test` · `request handling`

This Unix-only integration test focuses on request-body shape rather than command output. It creates a temporary exec harness and builds a concrete JSON schema object with `type: object`, a single string property `answer`, `required: ["answer"]`, and `additionalProperties: false`. That schema is written as pretty JSON to `schema.json` in the harness working directory, and also retained as a `serde_json::Value` for later comparison.

The test then starts a mock SSE server, mounts a one-shot successful response, and runs `codex exec` with `--skip-git-repo-check`, `-C <cwd>`, `--output-schema <schema_path>`, `-m gpt-5.1`, and a prompt. After asserting success, it retrieves the single captured request from the mounted mock and parses the body as JSON. Rather than comparing the whole payload, it drills into `payload["text"]["format"]`, failing with explicit `expect` messages if either field is absent. The final assertion checks exact equality with a JSON object containing `name: "codex_output_schema"`, `type: "json_schema"`, `strict: true`, and the original schema under `schema`. This documents both the presence and the precise wrapping format expected by the backend.

#### Function details

##### `exec_includes_output_schema_in_request`  (lines 9–62)

```
async fn exec_includes_output_schema_in_request() -> anyhow::Result<()>
```

**Purpose**: Writes a schema file, runs `codex exec` with `--output-schema`, captures the outbound request, and verifies the request contains the expected strict JSON-schema wrapper under `text.format`. It proves the CLI forwards the schema file contents into backend request metadata.

**Data flow**: It creates a test harness, constructs `schema_contents` as JSON, writes it to `<cwd>/schema.json` using pretty serialization, and stores the same value as `expected_schema`. It starts a mock server, mounts a successful SSE response, runs the command with `--skip-git-repo-check`, `-C`, the cwd, `--output-schema`, the schema path, `-m gpt-5.1`, and a prompt, then asserts success. Afterward it fetches the single captured request, parses the body as `serde_json::Value`, extracts `text` and then `format`, and asserts that `format` exactly equals the expected wrapper object containing `expected_schema`, finally returning `Ok(())`.

**Call relations**: This function is invoked directly by the Tokio test runner. It delegates backend simulation to `responses::start_mock_server`, `responses::sse`, and `responses::mount_sse_once`; the captured mock request is the key artifact used to validate how the CLI translated the schema file into request JSON.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 5 external calls (assert_eq!, json!, to_vec_pretty, write, vec!).


### `exec/tests/suite/prompt_stdin.rs`

`test` · `request handling`

This Unix-only test file exercises the prompt-building rules visible at the command line. The first four async tests use a mock SSE backend and inspect the captured request body through helper methods on the recorded request. In each case the command runs with `--skip-git-repo-check`, `-C <cwd>`, and usually `-m gpt-5.1`, while stdin content and positional prompt usage vary.

The append case proves that when a normal prompt argument is present and stdin contains data, the user message becomes the prompt followed by two newlines and a tagged block: `<stdin> ... </stdin>`. The empty-stdin variant proves that an explicit prompt is left unchanged when stdin is empty. Two more tests preserve older stdin-driven behavior: a lone `-` prompt argument means “read the prompt from stdin,” and omitting the prompt argument entirely also uses piped stdin as the prompt. Both expect the raw stdin text to become the sole user message.

The final two synchronous tests cover error handling without a mock server. They run the command with either no prompt argument or `-`, provide empty stdin, and assert exit code `1` plus stderr containing `No prompt provided via stdin.` Together these tests pin down both successful request construction and early CLI validation for missing prompt content.

#### Function details

##### `exec_appends_piped_stdin_to_prompt_argument`  (lines 9–40)

```
async fn exec_appends_piped_stdin_to_prompt_argument() -> anyhow::Result<()>
```

**Purpose**: Verifies that non-empty piped stdin is appended to an explicit prompt argument as tagged context rather than replacing the prompt. The expected user message includes the original prompt, a blank line, and a `<stdin>` block containing the piped text.

**Data flow**: It creates a test harness and mock server, mounts a successful SSE response, runs the command with `--skip-git-repo-check`, `-C`, the cwd, `-m gpt-5.1`, the prompt `Summarize this concisely`, and stdin `my output\n`, then asserts success. It retrieves the single captured request and asserts that the request contains one user message whose input text exactly matches `Summarize this concisely\n\n<stdin>\nmy output\n</stdin>`, then returns `Ok(())`.

**Call relations**: This test is run by the Tokio framework to cover the prompt-plus-stdin merge path. It relies on `mount_sse_once` to capture the outbound request and uses the request helper `has_message_with_input_texts` as the final verification mechanism.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (assert!, vec!).


##### `exec_ignores_empty_piped_stdin_when_prompt_argument_is_present`  (lines 43–73)

```
async fn exec_ignores_empty_piped_stdin_when_prompt_argument_is_present() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicit prompt argument is preserved unchanged when stdin is present but empty. It prevents the append logic from introducing empty `<stdin>` wrappers or otherwise altering the prompt.

**Data flow**: It sets up the harness and mock server, mounts a successful SSE response, runs the command with the same explicit prompt as the previous test but writes empty stdin, and asserts success. It then inspects the captured request and asserts that the sole user message text is exactly `Summarize this concisely`, returning `Ok(())`.

**Call relations**: This function is the empty-stdin counterpart to `exec_appends_piped_stdin_to_prompt_argument`. It uses the same mock capture flow but validates the branch where stdin contributes nothing and should therefore be ignored.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (assert!, vec!).


##### `exec_dash_prompt_reads_stdin_as_the_prompt`  (lines 76–107)

```
async fn exec_dash_prompt_reads_stdin_as_the_prompt() -> anyhow::Result<()>
```

**Purpose**: Verifies the special `-` prompt argument keeps its historical meaning: consume stdin as the prompt itself. The request should contain only the stdin text, not a literal dash or a wrapped stdin block.

**Data flow**: It creates the harness and mock server, mounts a successful SSE response, runs the command with `--skip-git-repo-check`, `-C`, the cwd, `-m gpt-5.1`, positional prompt `-`, and stdin `prompt from stdin\n`, then asserts success. It captures the request and asserts the user message text is exactly `prompt from stdin\n`, then returns `Ok(())`.

**Call relations**: This test is invoked by the Tokio runner to preserve the forced-stdin prompt mode. It shares the same mock-response setup as the other async prompt tests but validates a distinct CLI parsing branch triggered by the `-` argument.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (assert!, vec!).


##### `exec_without_prompt_argument_reads_piped_stdin_as_the_prompt`  (lines 110–140)

```
async fn exec_without_prompt_argument_reads_piped_stdin_as_the_prompt() -> anyhow::Result<()>
```

**Purpose**: Verifies that when no positional prompt argument is supplied, piped stdin becomes the prompt content. This preserves the existing stdin-only invocation style.

**Data flow**: It creates the harness and mock server, mounts a successful SSE response, runs the command with `--skip-git-repo-check`, `-C`, the cwd, `-m gpt-5.1`, and stdin `prompt from stdin\n` but no prompt argument, then asserts success. It inspects the captured request and asserts the user message text is exactly `prompt from stdin\n`, returning `Ok(())`.

**Call relations**: This function complements `exec_dash_prompt_reads_stdin_as_the_prompt` by covering the no-argument stdin path instead of the explicit `-` sentinel. It uses the same request-capture mechanism to verify the resulting user message.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 2 external calls (assert!, vec!).


##### `exec_without_prompt_argument_rejects_empty_piped_stdin`  (lines 143–155)

```
fn exec_without_prompt_argument_rejects_empty_piped_stdin()
```

**Purpose**: Verifies that invoking `codex exec` without a prompt argument and with empty stdin fails fast with a user-facing error. It defines the validation behavior for the stdin-only mode when no actual prompt text is available.

**Data flow**: It creates a test harness, runs the command directly with `--skip-git-repo-check`, `-C`, the cwd, and empty stdin but no prompt argument, and asserts exit code `1`. It also asserts stderr contains `No prompt provided via stdin.`; the function has no return value.

**Call relations**: This synchronous test is invoked by the standard test runner and intentionally avoids mock-server setup because the command should fail before any backend request is attempted. Its role is to validate early CLI argument/stdin checking rather than request construction.

*Call graph*: calls 1 internal fn (test_codex_exec); 1 external calls (contains).


##### `exec_dash_prompt_rejects_empty_piped_stdin`  (lines 158–171)

```
fn exec_dash_prompt_rejects_empty_piped_stdin()
```

**Purpose**: Verifies that the explicit `-` stdin-prompt mode also fails when stdin is empty. It ensures both stdin-as-prompt entry points share the same empty-input validation.

**Data flow**: It creates a test harness, runs the command with `--skip-git-repo-check`, `-C`, the cwd, positional prompt `-`, and empty stdin, and asserts exit code `1`. It further asserts stderr contains `No prompt provided via stdin.`; the function returns no value.

**Call relations**: This test is the `-`-argument counterpart to `exec_without_prompt_argument_rejects_empty_piped_stdin`. Like that test, it exercises a pre-request validation path and therefore does not involve the mock SSE infrastructure used by the async success cases.

*Call graph*: calls 1 internal fn (test_codex_exec); 1 external calls (contains).


### Execution modes and lifecycle
These tests exercise approval behavior, session persistence and resume, hooks, patch-capable flows, and startup/runtime failure exits across the codex-exec binary surface.

### `exec/tests/suite/approval_policy.rs`

`test` · `request handling`

This test file builds a reusable fixture around a temporary `codex exec` home directory and a mock SSE server, then exercises three CLI variants against the same configuration. The helper writes a concrete `config.toml` into the test home with `approval_policy = "on-request"` and `approvals_reviewer = "auto_review"`, starts the mock server, mounts a one-shot SSE transcript containing `response_created`, an assistant message, and `completed`, and runs the binary with `--skip-git-repo-check`, any extra flags under test, and a simple prompt. Instead of inspecting structured output, it captures `stderr` and asserts the process succeeded; the tests rely on the executable emitting its resolved approval mode there.

The three async tests differ only in the extra CLI arguments passed into the helper. The baseline case expects `approval: on-request`, proving that the auto-review reviewer does not silently rewrite the configured policy during ordinary execution. The `--dangerously-bypass-approvals-and-sandbox` and `--full-auto` cases both expect `approval: never`, documenting that these explicit automation modes override the config-derived approval behavior even when auto-review is configured. The file is Unix-only and intentionally permits `unwrap`-style test ergonomics.

#### Function details

##### `run_exec_with_auto_review_config`  (lines 7–35)

```
async fn run_exec_with_auto_review_config(extra_args: &[&str]) -> anyhow::Result<String>
```

**Purpose**: Creates the shared test setup for approval-policy scenarios, runs `codex exec` with optional extra flags, and returns the process stderr as UTF-8 text. It centralizes config creation, mock response setup, command invocation, and the success check used by all three tests.

**Data flow**: It takes `extra_args: &[&str]`, creates a test harness via `test_codex_exec()`, and writes a `config.toml` under the harness home directory containing the on-request/auto-review settings. It then starts a mock server, builds an SSE body from three canned events, mounts that body for a single request, executes the command with `--skip-git-repo-check`, the supplied extra args, and the prompt `check approval mode`, and reads `output.stderr`. After asserting the exit status is successful, it converts stderr from bytes to `String` and returns it.

**Call relations**: This helper is invoked by all three test cases in the file so they can vary only the CLI flags under examination. Internally it delegates network simulation to `responses::start_mock_server`, `responses::sse`, and `responses::mount_sse_once`, and uses the `test_codex_exec` harness to construct the command pointed at that server.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); called by 3 (exec_bypass_preserves_never_for_auto_review_config, exec_full_auto_preserves_never_for_auto_review_config, exec_preserves_on_request_for_auto_review_config); 4 external calls (from_utf8, assert!, write, vec!).


##### `exec_preserves_on_request_for_auto_review_config`  (lines 38–46)

```
async fn exec_preserves_on_request_for_auto_review_config() -> anyhow::Result<()>
```

**Purpose**: Verifies the default execution path keeps the effective approval mode at `on-request` when auto-review is configured. The test checks the stderr diagnostics emitted by the executable rather than inspecting internal state.

**Data flow**: It calls `run_exec_with_auto_review_config(&[])` with no extra CLI flags, receives the captured stderr string, and asserts that the string contains `approval: on-request`. It returns `Ok(())` on success.

**Call relations**: This is the baseline consumer of the shared helper, covering the no-override path. Its only delegation is to `run_exec_with_auto_review_config`, after which it performs the final assertion specific to the preserved-policy case.

*Call graph*: calls 1 internal fn (run_exec_with_auto_review_config); 1 external calls (assert!).


##### `exec_bypass_preserves_never_for_auto_review_config`  (lines 49–58)

```
async fn exec_bypass_preserves_never_for_auto_review_config() -> anyhow::Result<()>
```

**Purpose**: Checks that the dangerous bypass flag forces approval mode to `never` even when config says on-request with auto-review. It documents CLI precedence over the config file for this automation mode.

**Data flow**: It invokes `run_exec_with_auto_review_config` with `--dangerously-bypass-approvals-and-sandbox`, receives stderr text, and asserts that stderr contains `approval: never`. It returns `Ok(())` if the command succeeded and the expected diagnostic is present.

**Call relations**: This test reuses the common setup helper but exercises the bypass branch by supplying the explicit override flag. The helper performs all command execution and mock-server work; this function contributes the scenario-specific expectation.

*Call graph*: calls 1 internal fn (run_exec_with_auto_review_config); 1 external calls (assert!).


##### `exec_full_auto_preserves_never_for_auto_review_config`  (lines 61–69)

```
async fn exec_full_auto_preserves_never_for_auto_review_config() -> anyhow::Result<()>
```

**Purpose**: Checks that `--full-auto` also resolves the effective approval mode to `never` despite the on-request auto-review config. It covers the second automation-oriented override path.

**Data flow**: It calls `run_exec_with_auto_review_config` with `--full-auto`, obtains the stderr string from the subprocess, and asserts that the string contains `approval: never`. It returns `Ok(())` after the assertion passes.

**Call relations**: Like the bypass test, this function is a thin scenario wrapper around the shared helper. It is invoked by the test runner to validate the full-auto branch and relies on `run_exec_with_auto_review_config` for setup, execution, and stderr capture.

*Call graph*: calls 1 internal fn (run_exec_with_auto_review_config); 1 external calls (assert!).


### `exec/tests/suite/ephemeral.rs`

`test` · `request handling`

This Unix-only test file verifies a concrete persistence side effect: creation of `.jsonl` rollout files beneath the temporary home directory. The small helper `exec_sse_response` constructs a deterministic SSE transcript with a created event, one assistant message containing `ephemeral response`, and a completion event. The second helper, `session_rollout_count`, inspects `<home>/sessions`; if the directory does not exist it returns `0`, otherwise it recursively walks the tree with `walkdir::WalkDir`, keeps only successful entries that are regular files, filters names ending in `.jsonl`, and counts them.

Both async tests are guarded by `skip_if_no_network!(Ok(()))`, reflecting that these integration runs still depend on network-capable test conditions even though they use a local mock server. Each test creates a fresh harness and `wiremock::MockServer`, mounts the shared SSE response once, runs `codex exec` with `--skip-git-repo-check` and a prompt, and asserts exit code `0`. The difference is the presence or absence of `--ephemeral`. After execution, the tests inspect the home directory: default mode must leave exactly one rollout file, while ephemeral mode must leave none. The file therefore documents persistence as an externally visible contract rather than an internal implementation detail.

#### Function details

##### `exec_sse_response`  (lines 10–16)

```
fn exec_sse_response() -> String
```

**Purpose**: Builds the canned SSE response body shared by the persistence tests. The payload simulates a minimal successful assistant exchange ending in completion.

**Data flow**: It takes no arguments and constructs a `String` by passing a three-event vector into `responses::sse`: `ev_response_created("resp-ephemeral")`, `ev_assistant_message("msg-ephemeral", "ephemeral response")`, and `ev_completed("resp-ephemeral")`. It returns that serialized SSE body without mutating external state.

**Call relations**: This helper is called by both `persists_rollout_file_by_default` and `does_not_persist_rollout_file_in_ephemeral_mode` so they share identical backend behavior. It delegates all event formatting to the `responses` helpers.

*Call graph*: calls 1 internal fn (sse); called by 2 (does_not_persist_rollout_file_in_ephemeral_mode, persists_rollout_file_by_default); 1 external calls (vec!).


##### `session_rollout_count`  (lines 18–30)

```
fn session_rollout_count(home_path: &std::path::Path) -> usize
```

**Purpose**: Counts persisted rollout files under the test home directory’s `sessions` subtree. It abstracts the filesystem inspection used to distinguish default persistence from ephemeral execution.

**Data flow**: It accepts `home_path: &std::path::Path`, derives `sessions_dir = home_path.join("sessions")`, and immediately returns `0` if that directory does not exist. Otherwise it creates a recursive `WalkDir`, iterates entries, discards traversal errors, keeps only regular files whose names end with `.jsonl`, and returns the resulting count as `usize`.

**Call relations**: This helper is used after command execution by both tests in the file to convert on-disk state into a simple numeric assertion. It does not call back into the exec harness; its role is purely post-run verification over the filesystem.

*Call graph*: 2 external calls (join, new).


##### `persists_rollout_file_by_default`  (lines 33–48)

```
async fn persists_rollout_file_by_default() -> anyhow::Result<()>
```

**Purpose**: Verifies that a normal `codex exec` run writes one rollout file into the sessions directory. It establishes the default persistence behavior that `--ephemeral` is expected to suppress.

**Data flow**: After the network-availability guard, it creates a test harness and starts a `MockServer`, mounts the shared SSE response once, runs the command with `--skip-git-repo-check` and the prompt `default persistence behavior`, and asserts exit code `0`. It then calls `session_rollout_count(test.home_path())` and asserts the count equals `1`, returning `Ok(())`.

**Call relations**: This test is invoked by the Tokio runner as the baseline persistence scenario. It depends on `exec_sse_response` for the backend transcript and on `session_rollout_count` for post-run filesystem verification.

*Call graph*: calls 3 internal fn (mount_sse_once, test_codex_exec, exec_sse_response); 3 external calls (start, assert_eq!, skip_if_no_network!).


##### `does_not_persist_rollout_file_in_ephemeral_mode`  (lines 51–67)

```
async fn does_not_persist_rollout_file_in_ephemeral_mode() -> anyhow::Result<()>
```

**Purpose**: Verifies that adding `--ephemeral` prevents rollout-file persistence entirely. It checks the same filesystem location as the default test but expects no `.jsonl` artifacts.

**Data flow**: It performs the same guarded setup as the default test: create harness, start mock server, mount the shared SSE response, and run `codex exec`. The command includes `--ephemeral` before the prompt `ephemeral behavior`; after asserting exit code `0`, it computes `session_rollout_count(test.home_path())` and asserts the result is `0`, then returns `Ok(())`.

**Call relations**: This is the contrasting scenario to `persists_rollout_file_by_default`, sharing the same helper-generated response and count logic. Its only behavioral difference is the extra CLI flag, which the test treats as the cause of the missing persisted rollout file.

*Call graph*: calls 3 internal fn (mount_sse_once, test_codex_exec, exec_sse_response); 3 external calls (start, assert_eq!, skip_if_no_network!).


### `exec/tests/suite/hooks.rs`

`test` · `request handling`

This file contains a single Unix-only integration test for hook execution under trust bypass. It creates a temporary exec harness, computes a marker path inside the harness home directory, and builds a shell command `touch <marker>` using `format!`. It then writes a concrete `hooks.json` file into the home directory. The JSON structure is produced with `serde_json::json!` and pretty-serialized; it defines one `SessionStart` hook entry whose nested hook list contains a single command hook with the generated `touch` command.

After configuring hooks, the test starts a mock SSE server and mounts a one-shot successful assistant exchange so the command can proceed through a normal session lifecycle. It runs `codex exec` with `--skip-git-repo-check`, `--dangerously-bypass-hook-trust`, and a prompt. The process must succeed. The actual assertion is filesystem-based: `marker_path.exists()` must be true after the run, proving that the session-start hook was not merely parsed but actually executed when trust checks were bypassed. The test therefore captures both config loading and the runtime gating behavior around untrusted hooks.

#### Function details

##### `exec_hook_trust_bypass_runs_session_start_hook`  (lines 8–43)

```
async fn exec_hook_trust_bypass_runs_session_start_hook() -> anyhow::Result<()>
```

**Purpose**: Configures a `SessionStart` command hook that touches a marker file, runs `codex exec` with hook-trust bypass enabled, and verifies the marker file was created. It proves the bypass flag allows the hook to execute during session startup.

**Data flow**: It creates a test harness, derives `marker_path`, formats a shell `touch` command string, and writes a `hooks.json` file under the harness home containing a JSON hook definition serialized with `serde_json::to_vec_pretty`. It then starts a mock server, builds and mounts a successful SSE response, executes the command with `--skip-git-repo-check`, `--dangerously-bypass-hook-trust`, and a prompt, asserts subprocess success, and finally checks `marker_path.exists()` before returning `Ok(())`.

**Call relations**: This function is run directly by the Tokio test framework. It delegates backend simulation to the `responses` helpers and uses the `test_codex_exec` harness for isolated filesystem state; the final existence check ties the command-line trust-bypass flag to actual hook execution.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 6 external calls (assert!, format!, json!, to_vec_pretty, write, vec!).


### `exec/tests/suite/mcp_required_exit.rs`

`test` · `startup`

This Unix-only test exercises an initialization failure path rather than a successful request flow. It creates a temporary exec harness and writes a `config.toml` into the harness home directory containing an `[mcp_servers.required_broken]` table. That table sets `command = "codex-definitely-not-a-real-binary"` and `required = true`, intentionally guaranteeing startup failure when the executable attempts to launch the MCP server.

The test still provisions a mock SSE backend with a normal created/message/completed transcript, but that backend is incidental: the key behavior under test is that required MCP startup happens early enough to abort the command before a successful run can proceed. The command is invoked with `--skip-git-repo-check`, `--experimental-json`, and a prompt. The assertion checks two things together: the process exits with code `1`, and stderr contains the exact phrase `required MCP servers failed to initialize: required_broken`. This makes the contract explicit: required MCP failures are surfaced as user-visible CLI errors naming the failing server key, not silently ignored or downgraded to warnings.

#### Function details

##### `exits_non_zero_when_required_mcp_server_fails_to_initialize`  (lines 9–38)

```
async fn exits_non_zero_when_required_mcp_server_fails_to_initialize() -> anyhow::Result<()>
```

**Purpose**: Creates a config with a deliberately broken required MCP server and verifies that `codex exec` terminates with a non-zero exit code and a descriptive stderr message. It confirms required MCP initialization failures are fatal.

**Data flow**: It creates a test harness, defines a TOML string for `mcp_servers.required_broken`, and writes that string to `<home>/config.toml`. It then starts a mock server, mounts a standard successful SSE body, runs the command with `--skip-git-repo-check`, `--experimental-json`, and a prompt, and asserts exit code `1` plus stderr containing the expected failure text before returning `Ok(())`.

**Call relations**: This test is invoked directly by the Tokio runner to cover the MCP startup error path. It uses the `responses` helpers only to provide a backend if execution reached request time; the core relation is between the written config and the command’s early termination behavior.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 3 external calls (contains, write, vec!).


### `exec/tests/suite/apply_patch.rs`

`test` · `test-time binary and tool-flow integration`

This suite covers two related but distinct patch paths. `test_standalone_exec_cli_can_use_apply_patch` invokes the compiled `codex-exec` binary directly with `CODEX_CORE_APPLY_PATCH_ARG1` and an inline patch payload, using a temporary directory as cwd. It asserts exact stdout (`Success. Updated the following files:\nM source.txt\n`), empty stderr, and the final file contents, proving the binary can emulate the standalone `apply_patch` CLI without going through the normal agent runtime.

The two async tests run only on non-Windows systems and use the network-enabled exec harness plus a mock SSE server. They mount sequences of SSE streams that contain `apply_patch` custom tool-call events followed by completion events, then run exec in `danger-full-access` mode with a dummy prompt. `test_apply_patch_tool` applies an add patch and then an update patch to the same file, asserting the final file contains `Final text\n`. `test_apply_patch_freeform_tool` does the same with a Python file and a more freeform patch shape, comparing the final file to a fixture. Together these tests validate both the binary's special patch entry behavior and the runtime's ability to execute patch tool calls emitted by the model/server.

#### Function details

##### `test_standalone_exec_cli_can_use_apply_patch`  (lines 19–45)

```
fn test_standalone_exec_cli_can_use_apply_patch() -> anyhow::Result<()>
```

**Purpose**: Verifies that invoking `codex-exec` with the special apply-patch arg runs patch application directly, without normal exec session behavior.

**Data flow**: Creates a temp directory and source file, spawns the compiled `codex-exec` binary with `CODEX_CORE_APPLY_PATCH_ARG1` and an inline patch, sets the current directory, asserts success plus exact stdout/stderr, then reads the file back and asserts the patched contents.

**Call relations**: Exercises the binary's alternate CLI behavior for patch emulation, independent of the mock-server harness used by the other tests.

*Call graph*: 6 external calls (assert_eq!, new, cargo_bin, write, is_empty, tempdir).


##### `test_apply_patch_tool`  (lines 49–93)

```
async fn test_apply_patch_tool() -> anyhow::Result<()>
```

**Purpose**: Checks that apply-patch tool calls emitted through mocked SSE responses are executed in sequence and leave the expected final file contents.

**Data flow**: Skips when network is unavailable, creates the exec harness, defines add and update patch strings, mounts three SSE response streams containing custom apply-patch tool calls and completions, runs exec with git-check bypass and danger-full-access sandbox, then reads the resulting file and asserts its contents.

**Call relations**: Uses the normal exec runtime path with mocked server tool-call events to validate patch execution inside an agent session.

*Call graph*: calls 2 internal fn (mount_sse_sequence, start_mock_server); 4 external calls (assert_eq!, skip_if_no_network!, read_to_string, vec!).


##### `test_apply_patch_freeform_tool`  (lines 97–147)

```
async fn test_apply_patch_freeform_tool() -> anyhow::Result<()>
```

**Purpose**: Verifies that more freeform apply-patch payloads are also executed correctly through the tool-call path, not just tightly formatted simple patches.

**Data flow**: Skips when network is unavailable, creates the harness, defines freeform add and update patch strings for `app.py`, mounts corresponding SSE streams, runs exec, then reads the final file and compares it to a fixture file included in the test tree.

**Call relations**: Extends `test_apply_patch_tool` by covering a less rigid patch shape through the same mocked tool-call execution path.

*Call graph*: calls 2 internal fn (mount_sse_sequence, start_mock_server); 4 external calls (assert_eq!, skip_if_no_network!, read_to_string, vec!).


### `exec/tests/suite/resume.rs`

`test` · `request handling`

This test file builds realistic `codex-exec` runs against a `wiremock::MockServer`, then inspects the session JSONL files written under the test home directory to prove resume semantics. Three small helpers decode rollout files directly: `find_session_file_containing_marker` walks `sessions/` recursively with `WalkDir`, skips unreadable or malformed files, ignores the first metadata line, and searches later `response_item`/`message` entries whose serialized `content` contains a unique marker string; `extract_conversation_id` parses the first line’s `payload.id`; and `last_user_image_count` scans all response items and remembers the image attachment count from the last user message. The file also centralizes mock response setup with `exec_sse_response` and `mount_exec_responses`, producing deterministic SSE streams for multiple sequential CLI invocations.

The tests cover both `resume --last` and explicit session-id resume, including argument ordering in JSON mode, acceptance of global flags after the subcommand, and forwarding of `--output-schema` into the second HTTP request body under `text.format`. A more subtle test manipulates two sessions in different working directories and inserts sleeps because rollout `updated_at` has only second-level granularity; this avoids nondeterministic ties and proves the selection logic around current working directory filtering and `--all`. Other cases verify that CLI overrides such as `--model` and `--sandbox` win over stored session configuration, and that `--image` flags placed after `resume --last` become `input_image` entries in the resumed user turn.

#### Function details

##### `find_session_file_containing_marker`  (lines 16–61)

```
fn find_session_file_containing_marker(
    sessions_dir: &std::path::Path,
    marker: &str,
) -> Option<std::path::PathBuf>
```

**Purpose**: Searches the test session directory tree for a rollout `.jsonl` file whose recorded message content contains a supplied marker string. It is used to locate the exact session file created or updated by a prior CLI invocation.

**Data flow**: Takes a `&Path` for the sessions root and a marker `&str`. It iterates every `WalkDir` entry, filters to regular `.jsonl` files, reads each file as text, skips the first metadata line, parses remaining non-empty lines as `serde_json::Value`, and checks for `type == "response_item"` with a `payload.type == "message"` whose `content` stringification contains the marker. It returns `Some(PathBuf)` for the first matching file or `None` if no readable, parseable file matches.

**Call relations**: This helper is invoked by most resume tests after seeding or resuming a session. Those tests use it first to discover the original rollout file and later to confirm whether a second run appended to the same file or selected a different one.

*Call graph*: called by 6 (exec_resume_accepts_images_after_subcommand, exec_resume_by_id_appends_to_existing_file, exec_resume_last_accepts_prompt_after_flag_in_json_mode, exec_resume_last_appends_to_existing_file, exec_resume_last_respects_cwd_filter_and_all_flag, exec_resume_preserves_cli_configuration_overrides); 3 external calls (new, from_str, read_to_string).


##### `extract_conversation_id`  (lines 64–74)

```
fn extract_conversation_id(path: &std::path::Path) -> String
```

**Purpose**: Pulls the persisted conversation UUID out of the first metadata line of a rollout file. The tests use that ID to drive explicit `resume <id>` flows.

**Data flow**: Accepts a rollout file `&Path`, reads it fully, takes the first line, parses it as JSON, then drills into `payload.id`. Missing or malformed content causes panics via `unwrap`/`expect`; otherwise it returns the ID as an owned `String`, defaulting to empty only if the field is absent.

**Call relations**: Called only in tests that need a stable session identifier rather than marker-based discovery. Those tests first locate a file, then extract its conversation ID, then pass that ID back into the CLI to verify resume-by-id or deterministic newest-session updates.

*Call graph*: called by 2 (exec_resume_by_id_appends_to_existing_file, exec_resume_last_respects_cwd_filter_and_all_flag); 2 external calls (from_str, read_to_string).


##### `last_user_image_count`  (lines 76–107)

```
fn last_user_image_count(path: &std::path::Path) -> usize
```

**Purpose**: Counts how many `input_image` content items appear in the most recent user message recorded in a session file. It verifies that resumed prompts preserve all image attachments.

**Data flow**: Reads the rollout file text, iterates JSONL lines, ignores malformed or irrelevant entries, filters to `response_item` records whose payload is a user `message`, then inspects `payload.content` as an array and counts entries with `type == "input_image"`. It overwrites `last_count` each time it sees a later user message and returns that final count.

**Call relations**: Used only by the image-resume test after the CLI appends a resumed turn. The test locates the updated session file and delegates to this helper to assert that both `--image` flags became two image content items in the last user message.

*Call graph*: called by 1 (exec_resume_accepts_images_after_subcommand); 2 external calls (from_str, read_to_string).


##### `exec_repo_root`  (lines 109–111)

```
fn exec_repo_root() -> anyhow::Result<std::path::PathBuf>
```

**Purpose**: Resolves the repository root path for tests that need a stable working directory accepted by `codex-exec`. It wraps the cargo-bin utility in an `anyhow::Result`.

**Data flow**: Takes no arguments, calls `codex_utils_cargo_bin::repo_root()`, and returns the resulting `PathBuf` inside `anyhow::Result`.

**Call relations**: Several resume tests call this before invoking the CLI with `-C`. It supplies a known directory so session metadata records a predictable cwd and resume selection can be asserted reliably.

*Call graph*: called by 5 (exec_resume_accepts_images_after_subcommand, exec_resume_by_id_appends_to_existing_file, exec_resume_last_accepts_prompt_after_flag_in_json_mode, exec_resume_last_appends_to_existing_file, exec_resume_preserves_cli_configuration_overrides); 1 external calls (repo_root).


##### `exec_sse_response`  (lines 113–121)

```
fn exec_sse_response(index: usize) -> String
```

**Purpose**: Builds one synthetic SSE response stream for a single mocked exec request. Each stream contains a created event, one assistant message, and a completed event.

**Data flow**: Accepts an `index: usize`, derives deterministic response and message IDs with `format!`, assembles three response events via `core_test_support::responses`, and serializes them into one SSE body `String`.

**Call relations**: This is an internal constructor used by `mount_exec_responses` to generate a sequence of distinct mocked server replies for repeated CLI runs in the same test.

*Call graph*: calls 1 internal fn (sse); 2 external calls (format!, vec!).


##### `mount_exec_responses`  (lines 123–128)

```
async fn mount_exec_responses(
    server: &MockServer,
    count: usize,
) -> core_test_support::responses::ResponseMock
```

**Purpose**: Registers a sequence of mocked SSE responses on the `wiremock` server so multiple `codex-exec` invocations can consume them in order. It abstracts away repetitive mock setup across tests.

**Data flow**: Takes a `&MockServer` and a response `count`, maps `0..count` through `exec_sse_response`, collects the SSE bodies, and passes them to `responses::mount_sse_sequence`. It returns the resulting `ResponseMock`, which some tests later inspect for captured requests.

**Call relations**: Every test that performs one or more exec requests calls this during setup. In most cases it simply ensures enough responses exist; in the output-schema test the returned mock is also queried afterward to inspect the second outbound request payload.

*Call graph*: calls 1 internal fn (mount_sse_sequence); called by 8 (exec_resume_accepts_global_flags_after_subcommand, exec_resume_accepts_images_after_subcommand, exec_resume_by_id_appends_to_existing_file, exec_resume_includes_output_schema_in_request, exec_resume_last_accepts_prompt_after_flag_in_json_mode, exec_resume_last_appends_to_existing_file, exec_resume_last_respects_cwd_filter_and_all_flag, exec_resume_preserves_cli_configuration_overrides).


##### `exec_resume_last_appends_to_existing_file`  (lines 131–181)

```
async fn exec_resume_last_appends_to_existing_file() -> anyhow::Result<()>
```

**Purpose**: Verifies that `resume --last` appends a new turn to the existing most recent session file instead of creating a new rollout file. It also confirms both the original and resumed prompts remain present in that file.

**Data flow**: Creates a test harness and mock server, mounts two SSE responses, resolves the repo root, generates a unique marker and prompt, runs `codex-exec` once, locates the created session file by marker, then generates a second marker and runs `codex-exec <prompt2> resume --last`. Afterward it finds the file containing the second marker, asserts path equality with the original file, reads the file contents, and asserts both markers are present before returning `Ok(())`.

**Call relations**: This is a top-level async test. It drives the common helper flow of setup via `test_codex_exec`, `mount_exec_responses`, and `exec_repo_root`, then uses `find_session_file_containing_marker` before and after the resume command to prove append-in-place behavior.

*Call graph*: calls 4 internal fn (test_codex_exec, exec_repo_root, find_session_file_containing_marker, mount_exec_responses); 6 external calls (start, assert!, assert_eq!, format!, skip_if_no_network!, read_to_string).


##### `exec_resume_last_accepts_prompt_after_flag_in_json_mode`  (lines 184–234)

```
async fn exec_resume_last_accepts_prompt_after_flag_in_json_mode() -> anyhow::Result<()>
```

**Purpose**: Checks that in `--json` mode the CLI still accepts the resumed prompt after `resume --last`. The test ensures argument parsing does not require the prompt to precede the subcommand.

**Data flow**: Seeds a session with a first prompt and marker, locates the resulting rollout file, then runs `codex-exec --json resume --last <prompt2>` against the same mock server. It finds the file containing the second marker, asserts it is the same path as the original session file, reads the file, and verifies both markers are present.

**Call relations**: Like the previous test, this is an end-to-end async test using the shared mock and file-inspection helpers. Its distinguishing branch is the second invocation’s argument order, which specifically places `--json` before `resume` and the prompt after `--last`.

*Call graph*: calls 4 internal fn (test_codex_exec, exec_repo_root, find_session_file_containing_marker, mount_exec_responses); 6 external calls (start, assert!, assert_eq!, format!, skip_if_no_network!, read_to_string).


##### `exec_resume_last_respects_cwd_filter_and_all_flag`  (lines 237–339)

```
async fn exec_resume_last_respects_cwd_filter_and_all_flag() -> anyhow::Result<()>
```

**Purpose**: Proves that `resume --last` normally filters by the latest turn’s cwd, while `resume --last --all` ignores that filter and picks the globally newest session. It also codifies the subtle rule that a cross-cwd `--all` resume updates the session’s latest cwd context.

**Data flow**: Creates two temporary directories, seeds one session in each with distinct markers, locates both files, sleeps to avoid `updated_at` ties, extracts session B’s conversation ID, resumes B explicitly from `dir_b` to make it newest, sleeps again, then runs `resume --last --all` from `dir_a` with a new marker and asserts the updated file is B’s path. It then runs plain `resume --last` from `dir_a` with another marker and asserts B is still selected because the prior `--all` resume appended a latest turn whose cwd now matches `dir_a`.

**Call relations**: This test orchestrates the most complex call flow in the file. It combines `find_session_file_containing_marker` and `extract_conversation_id` with multiple CLI invocations and deliberate sleeps to make metadata ordering deterministic on CI systems where timestamps are only second-granular.

*Call graph*: calls 4 internal fn (test_codex_exec, extract_conversation_id, find_session_file_containing_marker, mount_exec_responses); 7 external calls (start, new, assert_eq!, format!, skip_if_no_network!, sleep, from_millis).


##### `exec_resume_accepts_global_flags_after_subcommand`  (lines 342–376)

```
async fn exec_resume_accepts_global_flags_after_subcommand() -> anyhow::Result<()>
```

**Purpose**: Ensures clap parsing accepts global options even when they appear after the `resume` subcommand. The test covers configuration, JSON mode, model selection, and sandbox bypass flags in that position.

**Data flow**: Seeds a session with one mocked server-backed run, then constructs a second command using `test.cmd()` rather than `cmd_with_server`, passing `resume --last` followed by `--config`, `--json`, `--model`, another `--config`, `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`, and a prompt. It asserts the command exits successfully and returns `Ok(())`.

**Call relations**: This async test uses `mount_exec_responses` only for the initial seed run. Its main purpose is parser coverage: after the session exists, it invokes the CLI with global flags placed after the subcommand to verify the command-line grammar remains permissive.

*Call graph*: calls 2 internal fn (test_codex_exec, mount_exec_responses); 3 external calls (start, format!, skip_if_no_network!).


##### `exec_resume_includes_output_schema_in_request`  (lines 379–432)

```
async fn exec_resume_includes_output_schema_in_request() -> anyhow::Result<()>
```

**Purpose**: Verifies that a resumed JSON-mode request includes the user-supplied output schema in the outbound API payload. It checks the exact `text.format` structure sent on the second request.

**Data flow**: Creates a JSON schema value, writes it prettified to `schema.json` in the test cwd, seeds a session, then runs `resume --last --json --output-schema <path>`. After both requests complete, it fetches captured requests from the response mock, asserts there were two, parses the second request body as `serde_json::Value`, extracts `text.format`, and compares it to the expected strict `json_schema` object containing the original schema contents.

**Call relations**: This test is the only one that consumes the `ResponseMock` returned by `mount_exec_responses`. Rather than inspecting session files, it validates request construction by examining the second HTTP payload emitted during a resumed run.

*Call graph*: calls 2 internal fn (test_codex_exec, mount_exec_responses); 6 external calls (start, assert_eq!, json!, to_vec_pretty, skip_if_no_network!, write).


##### `exec_resume_by_id_appends_to_existing_file`  (lines 435–488)

```
async fn exec_resume_by_id_appends_to_existing_file() -> anyhow::Result<()>
```

**Purpose**: Checks that `resume <conversation-id>` appends to the original rollout file for that session. It validates explicit-ID selection independently of `--last` heuristics.

**Data flow**: Seeds a session with a unique marker, locates the rollout file, extracts its conversation ID, asserts the ID is non-empty, then runs a second command with a new prompt followed by `resume <session_id>`. It locates the file containing the second marker, asserts it is the same path as the original file, reads the file contents, and verifies both markers are present.

**Call relations**: This async test follows the same seed-then-resume pattern as the `--last` tests, but swaps in `extract_conversation_id` and an explicit resume target. It demonstrates that session identity from the metadata line is sufficient to route appends to the existing file.

*Call graph*: calls 5 internal fn (test_codex_exec, exec_repo_root, extract_conversation_id, find_session_file_containing_marker, mount_exec_responses); 6 external calls (start, assert!, assert_eq!, format!, skip_if_no_network!, read_to_string).


##### `exec_resume_preserves_cli_configuration_overrides`  (lines 491–563)

```
async fn exec_resume_preserves_cli_configuration_overrides() -> anyhow::Result<()>
```

**Purpose**: Verifies that CLI flags supplied on a resumed run override any configuration persisted from the original session. It specifically checks model selection and sandbox mode reporting in stderr.

**Data flow**: Runs an initial command with `--sandbox workspace-write` and `--model gpt-5.1`, locates the resulting session file, then runs `resume --last` with a new prompt but a different `--model gpt-5.1-high` while keeping the sandbox flag. It captures the full `Output`, asserts success, decodes stderr as UTF-8, and checks for the expected model line plus either `sandbox: read-only` on Windows or `sandbox: workspace-write` elsewhere. Finally it confirms the resumed marker was appended to the same session file and that both markers remain present.

**Call relations**: This test uses the same file-discovery helpers as other resume tests, but its key assertion is against process stderr rather than request bodies. It proves the resumed invocation’s explicit CLI configuration wins during execution and logging.

*Call graph*: calls 4 internal fn (test_codex_exec, exec_repo_root, find_session_file_containing_marker, mount_exec_responses); 8 external calls (start, from_utf8, assert!, assert_eq!, cfg!, format!, skip_if_no_network!, read_to_string).


##### `exec_resume_accepts_images_after_subcommand`  (lines 566–623)

```
async fn exec_resume_accepts_images_after_subcommand() -> anyhow::Result<()>
```

**Purpose**: Ensures `--image` flags are accepted after `resume --last` and become image attachments on the resumed user turn. It validates both parser behavior and persisted session content.

**Data flow**: Seeds a session, writes two tiny PNG files into the test cwd, then runs `codex-exec -C <repo> resume --last --image <img1> --image <img2> <prompt2>`. After success, it locates the updated session file by the second marker, computes the image count in the last user message with `last_user_image_count`, and asserts the count is exactly 2.

**Call relations**: This async test combines the standard session setup with the image-count helper. It specifically exercises argument ordering after the subcommand and verifies the resulting persisted message structure rather than only command success.

*Call graph*: calls 5 internal fn (test_codex_exec, exec_repo_root, find_session_file_containing_marker, last_user_image_count, mount_exec_responses); 5 external calls (start, assert_eq!, format!, skip_if_no_network!, write).


### `exec/tests/suite/server_error_exit.rs`

`test` · `request handling`

This file contains a single non-Windows integration test focused on process exit semantics rather than session persistence or request contents. It uses the shared `core_test_support::responses` helpers to start a mock server and mount a one-shot SSE stream whose only event is `response.failed`. The synthetic event includes a response ID and a structured error payload with code `rate_limit_exceeded` and message `synthetic server error`, matching the shape the real API would send.

The test then launches `codex-exec` through the standard `test_codex_exec` harness, points it at the mock server, supplies a simple prompt, and enables `--experimental-json`. The assertion is specifically `.code(1)`, not just generic failure, so the contract here is that server-reported failures map to a deterministic non-zero exit status visible to scripts and CI. There is no file inspection or request introspection in this test; its entire value is proving that an SSE-level error propagates all the way out to the operating system process status.

#### Function details

##### `exits_non_zero_when_server_reports_error`  (lines 10–33)

```
async fn exits_non_zero_when_server_reports_error() -> anyhow::Result<()>
```

**Purpose**: Simulates a server-side `response.failed` SSE event and asserts that `codex-exec` terminates with exit code 1. It verifies error propagation from the streaming API to the CLI process status.

**Data flow**: The test creates a `test_codex_exec` harness, starts a mock server, constructs an SSE body containing one JSON event with `type: response.failed` and an embedded error object, mounts that body for a single request, then runs the CLI with `--skip-git-repo-check`, a prompt, and `--experimental-json`. It asserts the resulting process exits with code 1 and returns `Ok(())`.

**Call relations**: This is the sole entry in the file and a standalone async integration test. It depends on the shared response helpers to emulate the server stream and does not delegate to any local helpers.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex_exec); 1 external calls (vec!).


### `core/tests/suite/cli_stream.rs`

`test` · `external CLI execution, startup auth, session persistence, and git metadata collection during integration tests`

This file tests the real CLI binary rather than in-process thread APIs. It provides helpers to locate the repository root, generate a minimal assistant SSE stream, mount startup endpoints for personal-access-token auth (`whoami` and cloud config bundle), and build a `codex exec` command configured to use those endpoints. `run_cli_command` is the key subprocess utility: it starts the command in its own process group, captures stdout/stderr, waits on a background thread with a 30-second timeout, and relies on `ChildProcessCleanupGuard` to kill the whole process tree on drop so shell or Python grandchildren do not leak.

The tests cover PAT startup headers and the guarantee that a 401 on the Responses endpoint does not trigger OAuth refresh for PAT auth. Other tests verify provider and `openai_base_url` overrides route requests to the expected mock path, and that `model_instructions_file` can be supplied either directly via `-c` or indirectly through `--profile` and reaches the outbound `instructions` field. The session integration test runs `codex exec`, waits for a JSONL session file under `sessions/YYYY/MM/DD`, validates its metadata and recorded response items, then runs `resume --last` and confirms the same file is appended rather than replaced. Finally, `integration_git_info_unit_test` creates a temporary git repository, commits content, adds a branch and remote, calls `collect_git_info`, and verifies commit hash, branch, repository URL, and JSON serialization round-trip.

#### Function details

##### `repo_root`  (lines 34–36)

```
fn repo_root() -> std::path::PathBuf
```

**Purpose**: Resolves the repository root path used as the CLI working directory in subprocess tests. It panics if the cargo-bin helper cannot determine the root.

**Data flow**: Calls `codex_utils_cargo_bin::repo_root()`, unwraps the result, and returns the resulting `PathBuf`.

**Call relations**: Most CLI subprocess tests call this helper when constructing `codex exec -C ...` commands so they run from a stable repository root.

*Call graph*: called by 7 (exec_cli_applies_model_instructions_file, exec_cli_profile_applies_model_instructions_file, integration_creates_and_checks_session_file, personal_access_token_exec_command, responses_api_stream_cli, responses_mode_stream_cli, responses_mode_stream_cli_supports_openai_base_url_config_override); 1 external calls (repo_root).


##### `cli_sse_response`  (lines 38–44)

```
fn cli_sse_response() -> String
```

**Purpose**: Builds a minimal successful SSE response body for CLI streaming tests. It emits one assistant message and a completion event.

**Data flow**: Returns the string produced by `responses::sse` over a vector containing `response.created`, an assistant message `fixture hello`, and `response.completed`.

**Call relations**: Several CLI tests mount this canned response on the mock server instead of hand-writing SSE bodies.

*Call graph*: calls 1 internal fn (sse); called by 2 (responses_api_stream_cli, responses_mode_stream_cli_supports_personal_access_tokens); 1 external calls (vec!).


##### `mount_personal_access_token_startup`  (lines 46–67)

```
async fn mount_personal_access_token_startup(server: &MockServer)
```

**Purpose**: Mounts the startup HTTP endpoints required for personal-access-token authentication flows. It simulates both identity lookup and cloud-config bundle fetch using PAT headers.

**Data flow**: On the provided `MockServer`, mounts a GET `WHOAMI_PATH` expectation requiring `authorization: Bearer at-cli-test` and responding with user/account/fedramp JSON, then mounts a GET `CLOUD_CONFIG_BUNDLE_PATH` expectation with the same authorization header responding with an empty JSON object.

**Call relations**: PAT-focused CLI tests call this helper before launching the subprocess so startup auth and config bootstrap succeed against the mock server.

*Call graph*: called by 2 (responses_mode_stream_cli_does_not_attempt_oauth_refresh_for_personal_access_tokens_after_401, responses_mode_stream_cli_supports_personal_access_tokens); 6 external calls (given, new, json!, header, method, path).


##### `personal_access_token_exec_command`  (lines 70–88)

```
fn personal_access_token_exec_command(server: &MockServer, home: &TempDir) -> Command
```

**Purpose**: Constructs a `codex exec` subprocess command configured for personal-access-token auth against the mock auth and Responses endpoints. It also clears API-key env vars so PAT auth is the only available credential path.

**Data flow**: Resolves the `codex` cargo binary, creates a `Command`, adds `exec`, `--skip-git-repo-check`, config overrides for `openai_base_url` and `chatgpt_base_url`, `-C repo_root()`, and the prompt `hello?`. It sets `CODEX_HOME`, `CODEX_ACCESS_TOKEN_ENV_VAR`, `CODEX_AUTHAPI_BASE_URL`, and removes `CODEX_API_KEY_ENV_VAR` and `OPENAI_API_KEY`, then returns the configured `Command`.

**Call relations**: Both PAT CLI tests call this helper after mounting startup mocks, then pass the resulting command to `run_cli_command`.

*Call graph*: calls 1 internal fn (repo_root); called by 2 (responses_mode_stream_cli_does_not_attempt_oauth_refresh_for_personal_access_tokens_after_401, responses_mode_stream_cli_supports_personal_access_tokens); 5 external calls (uri, path, new, cargo_bin, format!).


##### `ChildProcessCleanupGuard::drop`  (lines 93–113)

```
fn drop(&mut self)
```

**Purpose**: Ensures timed-out or abandoned CLI subprocess tests clean up the entire spawned process tree, not just the direct child. This prevents leaked shell/Python grandchildren from hanging later tests.

**Data flow**: On Unix it calls `kill_process_group(self.0)` for the stored PID; on Windows it runs `taskkill /PID <pid> /T /F` with stdio redirected to null; on unsupported platforms it simply touches the PID to avoid warnings.

**Call relations**: `run_cli_command` creates this guard immediately after spawning the subprocess so cleanup happens automatically when the function returns or errors.

*Call graph*: calls 1 internal fn (kill_process_group); 2 external calls (null, new).


##### `run_cli_command`  (lines 119–144)

```
fn run_cli_command(command: &mut Command) -> io::Result<Output>
```

**Purpose**: Runs a configured CLI subprocess with captured stdio, a hard timeout, and whole-process-group cleanup. It is the core execution helper for all external CLI tests in this file.

**Data flow**: On Unix it places the command in a new process group, then configures stdin to null and stdout/stderr to piped, spawns the child, creates a `ChildProcessCleanupGuard` for the child PID, and starts a background thread that waits for `wait_with_output()`. It receives the result over a sync channel with `CLI_TIMEOUT`; on success it returns the `Output`, on timeout it returns `io::ErrorKind::TimedOut`, and on channel disconnect it returns `io::Error::other(...)`.

**Call relations**: Every subprocess-based CLI test delegates actual process execution to this helper so timeout and cleanup behavior are consistent.

*Call graph*: called by 8 (exec_cli_applies_model_instructions_file, exec_cli_profile_applies_model_instructions_file, integration_creates_and_checks_session_file, responses_api_stream_cli, responses_mode_stream_cli, responses_mode_stream_cli_does_not_attempt_oauth_refresh_for_personal_access_tokens_after_401, responses_mode_stream_cli_supports_openai_base_url_config_override, responses_mode_stream_cli_supports_personal_access_tokens); 9 external calls (null, piped, process_group, spawn, stdin, new, other, sync_channel, spawn).


##### `responses_mode_stream_cli_supports_personal_access_tokens`  (lines 147–175)

```
async fn responses_mode_stream_cli_supports_personal_access_tokens()
```

**Purpose**: Verifies that `codex exec` can authenticate with a personal access token and sends the expected PAT-derived headers to the Responses endpoint. It also confirms the CLI request path uses the configured `/api/codex/responses` route.

**Data flow**: Starts a mock server, mounts PAT startup endpoints and a one-shot SSE response, creates a temp home, builds the PAT-configured CLI command, runs it, asserts subprocess success, inspects the captured request, and checks path `/api/codex/responses`, `authorization: Bearer at-cli-test`, `chatgpt-account-id: account-pat`, and `x-openai-fedramp: true`. It then calls `server.verify()`.

**Call relations**: This top-level subprocess test combines `mount_personal_access_token_startup`, `personal_access_token_exec_command`, and `run_cli_command` to validate the PAT startup/auth path end to end.

*Call graph*: calls 5 internal fn (mount_sse_once, cli_sse_response, mount_personal_access_token_startup, personal_access_token_exec_command, run_cli_command); 5 external calls (start, new, assert!, assert_eq!, skip_if_no_network!).


##### `responses_mode_stream_cli_does_not_attempt_oauth_refresh_for_personal_access_tokens_after_401`  (lines 178–209)

```
async fn responses_mode_stream_cli_does_not_attempt_oauth_refresh_for_personal_access_tokens_after_401()
```

**Purpose**: Checks that a 401 from the Responses endpoint under PAT auth does not trigger an OAuth token refresh attempt. The CLI should fail, but `/oauth/token` must never be called.

**Data flow**: Starts a mock server, mounts PAT startup endpoints, mounts a POST `/api/codex/responses` expectation returning 401 for the PAT headers, mounts a POST `/oauth/token` expectation with `expect(0)`, creates a temp home, builds the PAT CLI command, runs it, asserts the subprocess exit status is unsuccessful, and verifies the server expectations.

**Call relations**: This PAT-specific negative test uses the same command-construction helper as the previous test but changes the server behavior to validate refresh suppression.

*Call graph*: calls 3 internal fn (mount_personal_access_token_startup, personal_access_token_exec_command, run_cli_command); 9 external calls (given, start, new, new, assert!, skip_if_no_network!, header, method, path).


##### `responses_mode_stream_cli`  (lines 213–255)

```
async fn responses_mode_stream_cli()
```

**Purpose**: Tests basic streaming through `codex exec` using a custom mock provider configured via `-c model_providers.mock=...`. It verifies both successful CLI output and the request path.

**Data flow**: Starts a mock server, mounts a one-shot SSE response containing assistant text `hi`, creates a temp home, builds a `codex exec` command with provider override config and `model_provider="mock"`, sets `OPENAI_API_KEY=dummy`, runs the command, prints status/stdout/stderr for debugging, asserts success, counts lines equal to `hi` in stdout and asserts exactly one, then inspects the captured request path and asserts `/v1/responses`.

**Call relations**: This is the baseline CLI streaming test for provider overrides and uses `run_cli_command` to execute the real binary.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, repo_root, run_cli_command); 11 external calls (start, from_utf8_lossy, new, assert!, assert_eq!, new, cargo_bin, format!, println!, skip_if_no_network! (+1 more)).


##### `responses_mode_stream_cli_supports_openai_base_url_config_override`  (lines 259–289)

```
async fn responses_mode_stream_cli_supports_openai_base_url_config_override()
```

**Purpose**: Verifies that overriding `openai_base_url` on the CLI reroutes built-in OpenAI provider requests to the supplied mock server. It checks only the path and successful execution.

**Data flow**: Starts a mock server, mounts a one-shot SSE response, creates a temp home, builds a `codex exec` command with `-c openai_base_url="{server}/v1"`, sets `OPENAI_API_KEY=dummy`, runs it, asserts success, and checks the captured request path is `/v1/responses`.

**Call relations**: This test is the built-in-provider counterpart to the custom-provider streaming test.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, repo_root, run_cli_command); 9 external calls (start, new, assert!, assert_eq!, new, cargo_bin, format!, skip_if_no_network!, vec!).


##### `exec_cli_applies_model_instructions_file`  (lines 295–359)

```
async fn exec_cli_applies_model_instructions_file()
```

**Purpose**: Checks that passing `-c model_instructions_file=...` to `codex exec` causes the file contents to appear in the outbound `instructions` field. It validates direct CLI config override propagation.

**Data flow**: Starts a mock server with a minimal created/completed SSE body, creates a temp instructions file containing a unique marker, builds a mock provider override pointing at the server, creates a temp home, constructs a `codex exec` command with provider override, `model_provider="mock"`, and `model_instructions_file="..."`, runs it, asserts success, then inspects the captured request body and asserts `instructions` contains the marker.

**Call relations**: This subprocess test focuses on CLI config parsing and propagation into the request payload rather than auth or session behavior.

*Call graph*: calls 3 internal fn (mount_sse_once, repo_root, run_cli_command); 10 external calls (start, new, assert!, new, cargo_bin, concat!, format!, println!, skip_if_no_network!, write).


##### `exec_cli_profile_applies_model_instructions_file`  (lines 365–427)

```
async fn exec_cli_profile_applies_model_instructions_file()
```

**Purpose**: Verifies that `codex exec --profile default` preserves the selected profile when starting the in-process app-server thread, so profile-defined `model_instructions_file` reaches the outbound request. It is the profile-based counterpart to the previous test.

**Data flow**: Starts a mock server with a minimal SSE body, creates a temp instructions file with a unique marker, writes `default.config.toml` in a temp home containing `model_instructions_file = "..."`, builds a mock provider override, constructs a `codex exec --profile default` command using that home and provider override, runs it, asserts success, and checks the captured request body’s `instructions` field contains the marker.

**Call relations**: This test extends the direct instructions-file override case to profile loading and profile propagation through the CLI startup path.

*Call graph*: calls 3 internal fn (mount_sse_once, repo_root, run_cli_command); 10 external calls (start, new, assert!, new, cargo_bin, concat!, format!, println!, skip_if_no_network!, write).


##### `responses_api_stream_cli`  (lines 431–458)

```
async fn responses_api_stream_cli()
```

**Purpose**: Tests basic `codex exec` streaming against a local Responses API server using the built-in provider path. It verifies successful CLI output and the `/v1/responses` request path.

**Data flow**: Starts a mock server, mounts `cli_sse_response()`, creates a temp home, builds a `codex exec` command with `openai_base_url` pointing at the server, sets `OPENAI_API_KEY=dummy`, runs it, asserts success, checks stdout contains `fixture hello`, and asserts the captured request path is `/v1/responses`.

**Call relations**: This is a simpler built-in-provider streaming test that reuses the canned SSE helper.

*Call graph*: calls 4 internal fn (mount_sse_once, cli_sse_response, repo_root, run_cli_command); 9 external calls (start, from_utf8_lossy, new, assert!, assert_eq!, new, cargo_bin, format!, skip_if_no_network!).


##### `integration_creates_and_checks_session_file`  (lines 462–643)

```
async fn integration_creates_and_checks_session_file() -> anyhow::Result<()>
```

**Purpose**: End-to-end integration test for session-log creation and resume. It verifies that `codex exec` writes a JSONL session file under the expected date-based directory structure and that `resume --last` appends to the same file.

**Data flow**: Creates a temp home and unique marker/prompt, starts a mock server with two canned SSE responses, builds and runs a first `codex exec` command against the server, asserts success, waits for `home/sessions` to appear, then waits for a `.jsonl` file under that tree whose contents contain the marker. It validates the relative path shape `YYYY/MM/DD/<file>`, parses the first line as `session_meta`, checks required payload fields, scans later lines for a `response_item` message containing the marker, then constructs and runs a second `codex exec ... resume --last` command with a new marker. After asserting success and two total requests, it waits for a session file containing the resumed marker, asserts it is the same path as the original file, and confirms the file now contains both markers.

**Call relations**: This is the heaviest subprocess integration test in the file, combining CLI execution, filesystem polling, JSONL parsing, and resume behavior.

*Call graph*: calls 3 internal fn (mount_sse_sequence, repo_root, run_cli_command); 14 external calls (from_secs, start, new, assert!, assert_eq!, new, cargo_bin, format!, wait_for_matching_file, wait_for_path_exists (+4 more)).


##### `integration_git_info_unit_test`  (lines 647–787)

```
async fn integration_git_info_unit_test()
```

**Purpose**: Tests git metadata collection independently of the CLI by creating a temporary repository and calling `collect_git_info` directly. It also verifies JSON serialization round-trip for the resulting `GitInfo`.

**Data flow**: Creates a temp directory, initializes a git repo with isolated config env vars, configures user name/email, writes and commits a file, creates a branch, adds a remote, then awaits `collect_git_info(&git_repo)`. It asserts the result is `Some`, checks the commit hash exists, is 40 hex characters, checks the branch equals `integration-test-branch`, compares the repository URL to `git remote get-url origin`, prints the collected values, serializes the `GitInfo` to JSON and deserializes it back, and asserts the key fields round-trip unchanged.

**Call relations**: Unlike the other tests, this one does not launch the CLI; it directly validates the git-info helper used when writing session metadata.

*Call graph*: 11 external calls (from_utf8, new, assert!, assert_eq!, new, collect_git_info, println!, from_str, to_string, write (+1 more)).
