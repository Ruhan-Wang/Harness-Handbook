# Core src tools and unified-exec tests  `stage-23.2.2`

This stage is a verification-focused slice of the system’s cross-cutting execution infrastructure. It sits beneath the main agent loop, testing the machinery that defines tools, exposes them to the model, routes calls, prepares runtime execution, enforces approvals and sandbox policy, and runs commands through the newer unified-exec subsystem.

At the tool boundary, test_sync_spec.rs and test_sync.rs provide an internal synchronization tool used to make concurrent integration tests deterministic; their companion schema test freezes its wire contract. The many handler spec and behavior tests then lock down individual tool surfaces and helpers: agent jobs, apply_patch, MCP resource/search, multi-agent collaboration, plugin install requests, request_user_input, shell, hosted tools, and shared unified-exec hook behavior. Registry, router, spec-planning, context, and dispatch-trace tests verify how tools are discovered, filtered, named, dispatched, formatted, and recorded.

The remaining files validate the execution path itself: approval-command canonicalization, user-shell snapshot rewriting, network approval caching, sandboxing semantics, apply-patch and runtime preparation, shell escalation, process execution, MCP tool-call dispatch, and unified-exec internals such as output buffering, async watching, process management, and lifecycle races. Together, these tests ensure the system’s tool and command execution contracts stay stable and safe.

## Files in this stage

### Tool specs and handler contracts
These tests lock down the published tool schemas and the focused handler behaviors that define the core tool surface.

### `core/src/tools/handlers/test_sync_spec.rs`

`config` · `tool registration / test schema publication`

This file is the schema companion to the runtime in `test_sync.rs`. Its single constructor builds a `ToolSpec::Function` named `test_sync_tool` with a concise description marking it as an internal synchronization helper for integration tests. The parameter object is intentionally permissive in requiredness—none of the top-level fields are mandatory—so tests can request only the synchronization behavior they need.

The schema has three top-level properties. `sleep_before_ms` and `sleep_after_ms` are numeric delays that default to no delay when omitted. `barrier` is itself a nested object schema with `id`, `participants`, and `timeout_ms`; only `id` and `participants` are required, while `timeout_ms` is optional and documented as defaulting to 1000 ms. Both the nested barrier object and the top-level parameter object set `additionalProperties: false`, which keeps test payloads tightly constrained and catches misspelled fields early. The use of `BTreeMap` gives deterministic property ordering, which is useful for exact-equality tests in the companion test file.

#### Function details

##### `create_test_sync_tool`  (lines 6–59)

```
fn create_test_sync_tool() -> ToolSpec
```

**Purpose**: Constructs the full tool specification for the internal synchronization helper used in tests. It describes optional delays and an optional barrier rendezvous block with strict field validation.

**Data flow**: It first builds `barrier_properties` containing string/number schemas for `id`, `participants`, and `timeout_ms`, then embeds that object schema under the top-level `barrier` property alongside `sleep_before_ms` and `sleep_after_ms`. It wraps the resulting property map in a `ResponsesApiTool` named `test_sync_tool`, with no required top-level fields, `additionalProperties: false`, and no output schema, and returns the `ToolSpec`.

**Call relations**: This constructor is called by `TestSyncHandler::spec`, and its exact output is locked down by the companion test in `test_sync_spec_tests.rs`.

*Call graph*: calls 3 internal fn (number, object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


### `core/src/tools/handlers/test_sync.rs`

`test` · `test execution / concurrent tool-call coordination`

This file provides the runtime half of `test_sync_tool`, a helper used only in tests. The handler supports parallel tool calls explicitly and accepts a flexible JSON payload deserialized into `TestSyncArgs`: optional `sleep_before_ms`, optional `sleep_after_ms`, and an optional nested `BarrierArgs` block. `BarrierArgs` includes a shared barrier ID, participant count, and a timeout that defaults through `default_timeout_ms`.

Barrier state is stored globally in a `OnceLock<tokio::sync::Mutex<HashMap<String, BarrierState>>>`, keyed by barrier ID. Each `BarrierState` holds an `Arc<Barrier>` plus the participant count used to create it. `handle_call` parses function arguments, performs any requested pre-delay, optionally waits on a barrier, performs any post-delay, and returns a simple `ok` text output. The barrier logic in `wait_on_barrier` enforces two invariants up front: participants and timeout must both be greater than zero. It then either reuses an existing barrier with the same participant count or creates and registers a new one; mismatched participant counts for an existing ID are rejected with a model-facing error. Waiting is wrapped in `tokio::time::timeout`, and when the barrier opens, the leader removes the barrier from the global map only if the stored `Arc` still matches, preventing accidental deletion of a newer barrier with the same ID. The result is a compact but careful synchronization primitive for concurrent test scenarios.

#### Function details

##### `default_timeout_ms`  (lines 52–54)

```
fn default_timeout_ms() -> u64
```

**Purpose**: Provides the serde default for barrier timeouts in test-sync arguments. It centralizes the default value so deserialization and code stay aligned.

**Data flow**: It takes no inputs and returns the `DEFAULT_TIMEOUT_MS` constant as `u64`. No state is read beyond that constant.

**Call relations**: Serde uses this function when deserializing `BarrierArgs` if `timeout_ms` is omitted from the incoming JSON.


##### `barrier_map`  (lines 56–58)

```
fn barrier_map() -> &'static tokio::sync::Mutex<HashMap<String, BarrierState>>
```

**Purpose**: Returns the lazily initialized global barrier registry used to coordinate concurrent test-sync calls. It hides the `OnceLock` initialization details from the barrier logic.

**Data flow**: It takes no arguments and returns a shared reference to a `tokio::sync::Mutex<HashMap<String, BarrierState>>`, initializing `BARRIERS` with an empty map on first use.

**Call relations**: Only `wait_on_barrier` calls this helper, using it both to look up/create barriers and to remove them after the leader passes.

*Call graph*: called by 1 (wait_on_barrier).


##### `TestSyncHandler::tool_name`  (lines 61–63)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the registry name for the internal synchronization tool. This name must match the schema produced by the companion spec file.

**Data flow**: It ignores handler state and returns `ToolName::plain("test_sync_tool")`.

**Call relations**: The tool registry uses this method to dispatch calls to this handler; it complements `TestSyncHandler::spec`.

*Call graph*: calls 1 internal fn (plain).


##### `TestSyncHandler::spec`  (lines 65–67)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Supplies the published schema for the test synchronization tool. It delegates schema construction to the dedicated spec module.

**Data flow**: It takes `&self`, calls `create_test_sync_tool()`, and returns the resulting `ToolSpec`.

**Call relations**: This method is invoked during tool registration or schema enumeration and relies on `test_sync_spec.rs` for the actual schema definition.

*Call graph*: calls 1 internal fn (create_test_sync_tool).


##### `TestSyncHandler::supports_parallel_tool_calls`  (lines 69–71)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that this handler is safe and intended to run concurrently. That capability is essential because the barrier feature only makes sense when multiple calls can overlap.

**Data flow**: It takes `&self` and returns the constant boolean `true`.

**Call relations**: The runtime consults this trait method when deciding whether multiple invocations of the tool may execute in parallel.


##### `TestSyncHandler::handle`  (lines 73–75)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async implementation method into the boxed future shape required by the `ToolExecutor` trait. It contains no business logic beyond forwarding.

**Data flow**: It consumes a `ToolInvocation`, calls `self.handle_call(invocation)`, boxes and pins the resulting future, and returns it as `ToolExecutorFuture`.

**Call relations**: The tool runtime invokes this trait method for execution; it immediately delegates all substantive work to `TestSyncHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `TestSyncHandler::handle_call`  (lines 79–116)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Executes a single test-sync request by optionally sleeping, waiting on a named barrier, and sleeping again. It returns a simple success marker when all requested synchronization steps complete.

**Data flow**: It takes a `ToolInvocation`, extracts `payload`, rejects non-function payloads with `FunctionCallError::RespondToModel`, and parses the JSON arguments into `TestSyncArgs`. If `sleep_before_ms` is present and positive it awaits `tokio::time::sleep`; if a `barrier` block is present it awaits `wait_on_barrier`; if `sleep_after_ms` is present and positive it sleeps again. Finally it creates `FunctionToolOutput::from_text("ok", Some(true))`, boxes it, and returns it.

**Call relations**: This method is called only by `TestSyncHandler::handle`. It delegates barrier coordination to `wait_on_barrier` and uses `parse_arguments` for strict JSON decoding.

*Call graph*: calls 4 internal fn (from_text, boxed_tool_output, parse_arguments, wait_on_barrier); called by 1 (handle); 3 external calls (from_millis, sleep, RespondToModel).


##### `wait_on_barrier`  (lines 121–176)

```
async fn wait_on_barrier(args: BarrierArgs) -> Result<(), FunctionCallError>
```

**Purpose**: Coordinates rendezvous on a named barrier shared across concurrent test-sync calls, with validation, timeout handling, and cleanup by the barrier leader. It is the core synchronization primitive behind the tool.

**Data flow**: It consumes `BarrierArgs`, first rejecting `participants == 0` and `timeout_ms == 0` with model-facing errors. It clones the barrier ID, locks the global map from `barrier_map()`, and either reuses an existing `Arc<Barrier>` with matching participant count or inserts a new `BarrierState`; a participant-count mismatch for an existing ID becomes an error. It then waits on `barrier.wait()` under `tokio::time::timeout(Duration::from_millis(args.timeout_ms))`. If the wait times out it returns an error; if the current waiter is the barrier leader, it re-locks the map and removes the entry only when `Arc::ptr_eq` confirms the stored barrier is the same instance. On success it returns `Ok(())`.

**Call relations**: This helper is invoked from `TestSyncHandler::handle_call` whenever the parsed arguments include a barrier section. It encapsulates all shared-state access and cleanup so the handler method can remain linear.

*Call graph*: calls 1 internal fn (barrier_map); called by 1 (handle_call); 7 external calls (new, ptr_eq, new, from_millis, format!, timeout, RespondToModel).


### `core/src/tools/handlers/test_sync_spec_tests.rs`

`test` · `test execution`

This file contains a single exact-equality test for the `test_sync_tool` schema. Rather than probing a few fields, it reconstructs the entire expected `ToolSpec::Function(ResponsesApiTool)` inline, including the nested `barrier` object, required fields inside that nested object, descriptions for every property, and `additionalProperties: false` at both levels.

Because the runtime behavior in `test_sync.rs` depends on optional delays and barrier configuration, this test acts as a contract check that the model-facing schema still exposes those knobs with the intended names and defaults. It also implicitly verifies deterministic property ordering by comparing `BTreeMap`-backed schemas directly. Any change to wording, requiredness, or nesting will fail the test and force an intentional update.

#### Function details

##### `test_sync_tool_matches_expected_spec`  (lines 7–64)

```
fn test_sync_tool_matches_expected_spec()
```

**Purpose**: Asserts that `create_test_sync_tool()` returns the exact expected schema for the internal synchronization helper. It protects the full nested parameter contract from accidental drift.

**Data flow**: The test calls `create_test_sync_tool()`, constructs an inline expected `ToolSpec::Function(ResponsesApiTool)` with the full top-level and nested `barrier` schemas, and compares the two values using `assert_eq!`.

**Call relations**: It directly validates the sole constructor in `test_sync_spec.rs`, serving as the regression test for that file’s published schema.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/agent_jobs_spec_tests.rs`

`test` · `test execution`

This test file locks down the exact `ToolSpec` values produced by `agent_jobs_spec.rs`. The helper `described_object` creates an empty `JsonSchema::object` and attaches a description string, mirroring how the production code builds the `output_schema` and `result` object placeholders. The two tests then compare the entire returned `ToolSpec::Function(ResponsesApiTool { ... })` structures with `assert_eq!`, rather than checking only selected fields.

`spawn_agents_on_csv_tool_requires_csv_and_instruction` confirms the spawn tool's name, long-form description, property set, per-property descriptions, required list (`csv_path` and `instruction`), and `additional_properties: false`. `report_agent_job_result_tool_requires_result_payload` does the same for the worker reporting tool, ensuring `job_id`, `item_id`, and `result` are required and that the optional `stop` flag carries the cancellation semantics text. Because these tests compare full values, they serve as regression guards for accidental wording changes, property ordering changes, or schema loosenings/tightenings that would alter model-visible behavior.

#### Function details

##### `described_object`  (lines 6–14)

```
fn described_object(description: &str) -> JsonSchema
```

**Purpose**: Creates a minimal object `JsonSchema` with a caller-provided description for use in expected test values.

**Data flow**: It takes a `&str`, constructs an empty object schema with no required fields and no explicit additional-properties setting, mutates its `description` field to `Some(description.to_string())`, and returns the schema.

**Call relations**: Used by both tests to avoid duplicating the object-schema setup embedded in the expected `ToolSpec` literals.

*Call graph*: calls 1 internal fn (object); 1 external calls (new).


##### `spawn_agents_on_csv_tool_requires_csv_and_instruction`  (lines 17–85)

```
fn spawn_agents_on_csv_tool_requires_csv_and_instruction()
```

**Purpose**: Asserts that the spawn-tool spec exactly matches the intended schema and descriptive text.

**Data flow**: It calls `create_spawn_agents_on_csv_tool()`, compares the returned `ToolSpec` against a fully inlined expected `ResponsesApiTool`, and fails the test if any field differs.

**Call relations**: This test exercises the production spec factory directly and acts as a snapshot-style guard for model-facing API changes.

*Call graph*: 1 external calls (assert_eq!).


##### `report_agent_job_result_tool_requires_result_payload`  (lines 88–126)

```
fn report_agent_job_result_tool_requires_result_payload()
```

**Purpose**: Asserts that the worker result-reporting tool spec exactly matches the intended required fields and descriptions.

**Data flow**: It calls `create_report_agent_job_result_tool()`, builds the expected `ToolSpec::Function` literal, and uses equality comparison to validate every field.

**Call relations**: Like the spawn-tool test, it validates the production schema factory end-to-end and catches any drift in the worker callback contract.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/agent_jobs_tests.rs`

`test` · `test execution`

This file contains focused unit tests for lower-level helpers from the surrounding agent-jobs module. The tests are intentionally concrete and data-driven. `parse_csv_supports_quotes_and_commas` proves that CSV parsing preserves header order and correctly treats quoted commas as part of a field value. `csv_escape_quotes_when_needed` checks the inverse formatting behavior for plain strings, comma-containing strings, and strings containing literal quotes, ensuring the escaping logic doubles embedded quotes and wraps fields only when necessary.

Two tests cover prompt templating. `render_instruction_template_expands_placeholders_and_escapes_braces` passes a JSON row object with keys including a space (`file path`) and verifies that `{column}` placeholders are replaced while doubled braces `{{...}}` collapse to literal braces. `render_instruction_template_leaves_unknown_placeholders` confirms that missing keys are not erased or replaced with empty strings; the original placeholder text remains in the rendered instruction. Finally, `ensure_unique_headers_rejects_duplicates` validates that duplicate CSV headers are rejected with the exact `FunctionCallError::RespondToModel` message expected by higher-level code. Together these tests pin down edge cases that directly affect row-to-prompt rendering and CSV import correctness.

#### Function details

##### `parse_csv_supports_quotes_and_commas`  (lines 6–17)

```
fn parse_csv_supports_quotes_and_commas()
```

**Purpose**: Verifies that CSV parsing handles quoted fields containing commas without splitting them into extra columns.

**Data flow**: It defines a small CSV string, passes it to `parse_csv`, destructures the returned headers and rows, and compares both against expected vectors of strings.

**Call relations**: This test targets the parser helper used by the CSV job creation path, specifically the row-shape correctness that `handle` depends on.

*Call graph*: 1 external calls (assert_eq!).


##### `csv_escape_quotes_when_needed`  (lines 20–24)

```
fn csv_escape_quotes_when_needed()
```

**Purpose**: Checks that CSV field escaping leaves simple text untouched and correctly quotes/escapes problematic values.

**Data flow**: It feeds three representative strings into `csv_escape` and compares each returned string to the expected CSV-safe representation.

**Call relations**: This test validates formatting behavior likely used during CSV export, complementing the parser-side tests.

*Call graph*: 1 external calls (assert_eq!).


##### `render_instruction_template_expands_placeholders_and_escapes_braces`  (lines 27–41)

```
fn render_instruction_template_expands_placeholders_and_escapes_braces()
```

**Purpose**: Confirms that instruction templates substitute row values by column name and preserve literal braces via doubled-brace escaping.

**Data flow**: It builds a JSON row object, calls `render_instruction_template` with a template containing multiple placeholders and `{{literal}}`, and asserts on the final rendered string.

**Call relations**: This test covers the prompt-generation semantics that worker jobs rely on when turning CSV rows into per-item instructions.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `render_instruction_template_leaves_unknown_placeholders`  (lines 44–50)

```
fn render_instruction_template_leaves_unknown_placeholders()
```

**Purpose**: Ensures that placeholders with no matching row field remain visible in the rendered instruction.

**Data flow**: It creates a JSON row with only one key, renders a template containing one known and one missing placeholder, and compares the output string to the expected partially substituted result.

**Call relations**: This guards against silent data loss in template rendering and documents the fallback behavior used by the agent-job subsystem.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `ensure_unique_headers_rejects_duplicates`  (lines 53–62)

```
fn ensure_unique_headers_rejects_duplicates()
```

**Purpose**: Verifies that duplicate CSV header names are rejected with the exact user-facing error variant and message.

**Data flow**: It constructs a duplicate-header vector, calls `ensure_unique_headers`, pattern-matches the error case, and compares the resulting `FunctionCallError` to the expected `RespondToModel` value.

**Call relations**: This test covers a validation branch that the top-level CSV job handler depends on before constructing row JSON objects keyed by header name.

*Call graph*: 3 external calls (assert_eq!, panic!, vec!).


### `core/src/tools/handlers/apply_patch_spec_tests.rs`

`test` · `test execution`

This test file validates the exact `ToolSpec` emitted by `apply_patch_spec.rs`. The first test, `create_apply_patch_freeform_tool_matches_expected_spec`, compares the entire returned `ToolSpec::Freeform(FreeformTool { ... })` for the default single-environment case, ensuring the tool name, description, format type, syntax, and grammar definition string all match the embedded `APPLY_PATCH_LARK_GRAMMAR` exactly.

The second test exercises the conditional grammar rewrite used for multi-environment turns. It destructures the returned `ToolSpec` to confirm it is still freeform, then asserts that the generated grammar definition contains both the optional `environment_id?` marker in the start rule and the literal production line for `"*** Environment ID: " filename LF`. Together these tests guard the model-visible syntax contract for patch input and ensure that enabling environment selection changes only the intended grammar fragments.

#### Function details

##### `create_apply_patch_freeform_tool_matches_expected_spec`  (lines 5–20)

```
fn create_apply_patch_freeform_tool_matches_expected_spec()
```

**Purpose**: Asserts that the default `apply_patch` freeform spec exactly matches the expected name, description, and embedded grammar.

**Data flow**: It calls `create_apply_patch_freeform_tool(false)`, constructs the expected `ToolSpec::Freeform` literal using `APPLY_PATCH_LARK_GRAMMAR.to_string()`, and compares the two values with `assert_eq!`.

**Call relations**: This is a snapshot-style regression test for the single-environment spec factory output.

*Call graph*: 1 external calls (assert_eq!).


##### `create_apply_patch_freeform_tool_includes_environment_id_when_requested`  (lines 23–36)

```
fn create_apply_patch_freeform_tool_includes_environment_id_when_requested()
```

**Purpose**: Checks that enabling environment-id support injects the expected grammar fragments into the freeform tool definition.

**Data flow**: It calls `create_apply_patch_freeform_tool(true)`, pattern-matches the result as `ToolSpec::Freeform`, then asserts that the grammar definition string contains the optional environment-id rule references.

**Call relations**: This test specifically covers the conditional branch in the spec factory that rewrites the grammar for multi-environment turns.

*Call graph*: 2 external calls (assert!, panic!).


### `core/src/tools/handlers/apply_patch_tests.rs`

`test` · `test execution`

This test module exercises several distinct behaviors from `apply_patch.rs`. Two small helpers reduce setup cost: `sample_patch` returns a minimal add-file patch string, and `invocation_for_payload` builds a realistic `ToolInvocation` with a session, turn context, cancellation token, diff tracker, fixed call id, and tool name. The first async tests verify hook integration: `pre_tool_use_payload_uses_freeform_patch_input` and `post_tool_use_payload_uses_patch_input_and_tool_output` confirm that the handler preserves the raw patch text as `{ "command": ... }` and pairs it with the serialized tool response.

Three tests focus on `ApplyPatchArgumentDiffConsumer`. They show that partial patch text yields no event until enough structure is parsed, that add-file progress initially reports empty content and later flushes full content on completion, that an optional `*** Environment ID:` header is tolerated, and that the 500ms buffering logic suppresses intermediate updates until the interval elapses. Additional tests cover policy helpers: `reconcile_environment_id_requires_selection_when_enabled` checks the exact error when environment selection is disallowed; `approval_keys_include_move_destination` proves rename destinations are included in approval path accounting; and the two `write_permissions_for_paths_*` tests verify that extra write permissions are omitted for workspace-writable directories but retained for paths outside the workspace root. These tests collectively pin down subtle behavior around streaming UX, sandbox permissions, and hook payload fidelity.

#### Function details

##### `sample_patch`  (lines 23–28)

```
fn sample_patch() -> &'static str
```

**Purpose**: Returns a minimal valid apply-patch string used across tests.

**Data flow**: It takes no inputs and returns a static string literal representing a patch that adds `hello.txt` with one line of content.

**Call relations**: Used by the pre- and post-tool hook payload tests to avoid duplicating patch text.

*Call graph*: called by 2 (post_tool_use_payload_uses_patch_input_and_tool_output, pre_tool_use_payload_uses_freeform_patch_input).


##### `invocation_for_payload`  (lines 30–42)

```
async fn invocation_for_payload(payload: ToolPayload) -> ToolInvocation
```

**Purpose**: Builds a realistic `ToolInvocation` test fixture around an arbitrary payload.

**Data flow**: It asynchronously creates a session and turn via `make_session_and_context`, then constructs a `ToolInvocation` populated with those values, a fresh cancellation token, a new `TurnDiffTracker` wrapped in `Arc<Mutex<_>>`, a fixed call id, the plain tool name `apply_patch`, direct call source, and the caller-provided payload. It returns the assembled invocation.

**Call relations**: Called by the hook payload tests so they can exercise handler methods with production-shaped invocation data.

*Call graph*: calls 3 internal fn (make_session_and_context, new, plain); called by 2 (post_tool_use_payload_uses_patch_input_and_tool_output, pre_tool_use_payload_uses_freeform_patch_input); 3 external calls (new, new, new).


##### `pre_tool_use_payload_uses_freeform_patch_input`  (lines 45–60)

```
async fn pre_tool_use_payload_uses_freeform_patch_input()
```

**Purpose**: Verifies that the handler's pre-tool hook payload contains the raw freeform patch text under the `command` key.

**Data flow**: It gets the sample patch, wraps it in `ToolPayload::Custom`, builds an invocation fixture, constructs a default handler, and compares `pre_tool_use_payload` output to the expected `PreToolUsePayload` JSON structure.

**Call relations**: Exercises `ApplyPatchHandler::pre_tool_use_payload` end-to-end using the shared invocation fixture.

*Call graph*: calls 2 internal fn (invocation_for_payload, sample_patch); 2 external calls (assert_eq!, default).


##### `post_tool_use_payload_uses_patch_input_and_tool_output`  (lines 63–81)

```
async fn post_tool_use_payload_uses_patch_input_and_tool_output()
```

**Purpose**: Verifies that the handler's post-tool hook payload includes both the original patch command and the serialized textual tool response.

**Data flow**: It creates a custom-payload invocation from the sample patch, constructs an `ApplyPatchToolOutput` from success text, invokes `post_tool_use_payload`, and compares the result to the expected `PostToolUsePayload`.

**Call relations**: Exercises `ApplyPatchHandler::post_tool_use_payload`, complementing the pre-hook test.

*Call graph*: calls 3 internal fn (from_text, invocation_for_payload, sample_patch); 2 external calls (assert_eq!, default).


##### `diff_consumer_streams_apply_patch_changes`  (lines 84–135)

```
fn diff_consumer_streams_apply_patch_changes()
```

**Purpose**: Checks that the streaming diff consumer emits add-file progress only after enough patch structure is parsed and flushes final content on completion.

**Data flow**: It creates a default consumer, pushes several patch fragments in sequence, asserts `None` for incomplete states, captures emitted events when available, and compares their `call_id` and `changes` maps to expected `FileChange::Add` values before and after finalization.

**Call relations**: Directly exercises `ApplyPatchArgumentDiffConsumer::push_delta` and `finish_update_on_complete` behavior without going through the full tool framework.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


##### `diff_consumer_streams_apply_patch_changes_with_environment_header`  (lines 138–161)

```
fn diff_consumer_streams_apply_patch_changes_with_environment_header()
```

**Purpose**: Ensures the streaming diff consumer tolerates an environment-id header before the first file hunk.

**Data flow**: It pushes a begin-patch fragment containing `*** Environment ID: remote`, confirms no event yet, then pushes an add-file fragment and asserts that the resulting change map contains the expected add-file entry.

**Call relations**: Covers the grammar extension path relevant when multi-environment patch syntax is enabled.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


##### `diff_consumer_sends_next_update_after_buffer_interval`  (lines 164–194)

```
fn diff_consumer_sends_next_update_after_buffer_interval()
```

**Purpose**: Verifies that throttled progress updates resume once the configured buffer interval has elapsed.

**Data flow**: It creates a consumer, emits an initial event from early patch fragments, manually rewinds `last_sent_at` to simulate elapsed time, pushes another fragment, and asserts that a second progress event is produced with the expected partial file content.

**Call relations**: Targets the time-based branch inside `ApplyPatchArgumentDiffConsumer::push_delta`.

*Call graph*: 3 external calls (assert_eq!, default, now).


##### `reconcile_environment_id_requires_selection_when_enabled`  (lines 197–210)

```
fn reconcile_environment_id_requires_selection_when_enabled()
```

**Purpose**: Checks the exact behavior of environment-id validation for both disallowed and absent environment selections.

**Data flow**: It calls `require_environment_id` with a present id and `allow_environment_id = false`, then with no id and `allow_environment_id = true`, and compares both results to expected `Result` values.

**Call relations**: Unit-tests the policy helper used by the direct apply-patch handler before environment resolution.

*Call graph*: 1 external calls (assert_eq!).


##### `approval_keys_include_move_destination`  (lines 213–242)

```
async fn approval_keys_include_move_destination()
```

**Purpose**: Verifies that path accounting for a rename/update patch includes both the original file path and the move destination.

**Data flow**: It creates a temporary directory tree and source file, defines a patch that updates and moves the file, parses/verifies that patch into an action, passes the action to `file_paths_for_action`, and asserts that two approval keys are returned.

**Call relations**: Exercises the helper used by `effective_patch_permissions` to ensure rename destinations are considered for approvals and permissions.

*Call graph*: 7 external calls (new, assert_eq!, maybe_parse_apply_patch_verified, panic!, create_dir_all, write, vec!).


##### `write_permissions_for_paths_skip_dirs_already_writable_under_workspace_root`  (lines 245–262)

```
fn write_permissions_for_paths_skip_dirs_already_writable_under_workspace_root()
```

**Purpose**: Ensures no extra permission profile is requested when the touched file already lies under a workspace-writable directory.

**Data flow**: It creates a temporary workspace and nested file path, builds a workspace-write sandbox policy, calls `write_permissions_for_paths` with that file, and asserts that the result is `None`.

**Call relations**: Tests the filtering branch in permission derivation that avoids redundant write grants.

*Call graph*: calls 2 internal fn (workspace_write, try_from); 3 external calls (new, assert_eq!, create_dir_all).


##### `write_permissions_for_paths_keep_dirs_outside_workspace_root`  (lines 265–291)

```
fn write_permissions_for_paths_keep_dirs_outside_workspace_root()
```

**Purpose**: Ensures extra write permissions are retained for touched paths outside the workspace root.

**Data flow**: It creates separate workspace and outside directories, constructs an absolute file path under the outside directory, builds a workspace-write sandbox policy, calls `write_permissions_for_paths`, extracts the resulting write roots from the returned permission profile, and compares them to the canonicalized outside directory path.

**Call relations**: Tests the positive branch of permission derivation used when patches target locations not already writable by the sandbox.

*Call graph*: calls 2 internal fn (workspace_write, try_from); 4 external calls (new, assert_eq!, simplified, create_dir_all).


### `core/src/tools/handlers/mcp_resource_spec_tests.rs`

`test` · `test`

This test file exercises the pure spec-construction functions in `mcp_resource_spec.rs` by comparing each returned `ToolSpec` against a fully inlined expected value. The tests use `pretty_assertions::assert_eq` so any mismatch in nested schema structure is easy to inspect.

Each test reconstructs the exact `ToolSpec::Function(ResponsesApiTool { ... })` expected from the corresponding builder. For the list tools, the expected schema is an object with `server` and `cursor` string properties, no required fields, and `additionalProperties` disabled. For the read tool, the expected schema requires both `server` and `uri`. The descriptions are asserted verbatim, which means these tests also guard the model-facing wording and not just the structural schema.

Because the expected values are written out in full rather than partially matched, these tests serve as snapshot-style contract checks for tool registration. Any accidental change to a tool name, parameter description, required-field list, or schema strictness will fail immediately. The file contains no helper logic or runtime behavior; its value is in preserving the exact external interface promised by the MCP resource handlers.

#### Function details

##### `list_mcp_resources_tool_matches_expected_spec`  (lines 7–34)

```
fn list_mcp_resources_tool_matches_expected_spec()
```

**Purpose**: Asserts that `create_list_mcp_resources_tool()` returns the exact expected function-tool specification.

**Data flow**: It calls the builder, constructs an inline expected `ToolSpec::Function(ResponsesApiTool { ... })` with the full parameter schema, and compares actual versus expected with `assert_eq!`. It produces no outputs beyond test pass/fail.

**Call relations**: Executed by the test runner. It directly validates the list-resources spec builder and does not delegate to any helper beyond the assertion macro.

*Call graph*: 1 external calls (assert_eq!).


##### `list_mcp_resource_templates_tool_matches_expected_spec`  (lines 37–64)

```
fn list_mcp_resource_templates_tool_matches_expected_spec()
```

**Purpose**: Checks that the resource-template listing tool spec matches the intended name, description, and optional-parameter schema exactly.

**Data flow**: It obtains the actual spec from `create_list_mcp_resource_templates_tool()`, builds the expected nested `ToolSpec` value inline, and compares them with `assert_eq!`. The only side effect is a failing test if they differ.

**Call relations**: Run by the test harness to guard the contract exposed by the resource-template spec builder.

*Call graph*: 1 external calls (assert_eq!).


##### `read_mcp_resource_tool_matches_expected_spec`  (lines 67–96)

```
fn read_mcp_resource_tool_matches_expected_spec()
```

**Purpose**: Verifies that the read-resource tool spec requires `server` and `uri` and otherwise matches the expected metadata exactly.

**Data flow**: It calls `create_read_mcp_resource_tool()`, constructs the expected `ToolSpec` including the required-field vector, and asserts equality. No persistent state is modified.

**Call relations**: This test is invoked by the test runner and serves as a contract check for the read-resource schema builder.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/mcp_resource_tests.rs`

`test` · `test`

This file is a focused test suite for the `mcp_resource` module’s data-shaping helpers rather than the networked handlers themselves. Two small fixtures, `resource` and `template`, construct minimal `rmcp` resource values by filling `RawResource` and `RawResourceTemplate` with only the identifying fields and then stripping annotations via `no_annotation()`.

The tests validate several important invariants. `ResourceWithServer::new` and `ResourceTemplateWithServer::new` must serialize a top-level `server` field alongside the original MCP identifiers. `ListResourcesPayload::from_single_server` must preserve `next_cursor` and annotate each returned resource with the originating server. `ListResourcesPayload::from_all_servers` must flatten a `HashMap<String, Vec<Resource>>` into a deterministic, sorted serialized order, preventing unstable output from map iteration.

The suite also checks utility behavior around tool outputs: `call_tool_result_from_content` should mark successful calls with `is_error = Some(false)`, `parse_arguments` should treat blank input and JSON `null` as absent arguments while still parsing valid objects, and `serialize_function_output` should leave small payloads untouched but truncate oversized `ReadResourcePayload` text according to the configured `TruncationPolicy`. The large-payload test computes the expected truncated JSON using `truncate_text`, confirming that truncation happens on the serialized representation rather than on individual resource fields.

#### Function details

##### `resource`  (lines 7–19)

```
fn resource(uri: &str, name: &str) -> Resource
```

**Purpose**: Creates a minimal unannotated MCP `Resource` fixture with a URI and name for use in tests.

**Data flow**: It takes `uri` and `name` string slices, fills a `rmcp::model::RawResource` with those values and `None` for all optional metadata fields, calls `.no_annotation()`, and returns the resulting `Resource`.

**Call relations**: Used by tests that need concrete resource values, notably `resource_with_server_serializes_server_field`. It isolates fixture construction so assertions can focus on serialization behavior.

*Call graph*: called by 1 (resource_with_server_serializes_server_field).


##### `template`  (lines 21–31)

```
fn template(uri_template: &str, name: &str) -> ResourceTemplate
```

**Purpose**: Creates a minimal unannotated MCP `ResourceTemplate` fixture with a URI template and name.

**Data flow**: It accepts `uri_template` and `name`, constructs `rmcp::model::RawResourceTemplate` with those fields and `None` for optional metadata, calls `.no_annotation()`, and returns the resulting `ResourceTemplate`.

**Call relations**: Called by `template_with_server_serializes_server_field` to provide a simple template fixture for serialization checks.

*Call graph*: called by 1 (template_with_server_serializes_server_field).


##### `resource_with_server_serializes_server_field`  (lines 34–41)

```
fn resource_with_server_serializes_server_field()
```

**Purpose**: Verifies that wrapping a resource with `ResourceWithServer::new` adds the server name into the serialized JSON alongside the resource fields.

**Data flow**: It builds a fixture resource via `resource`, wraps it with server `test`, serializes the wrapper to `serde_json::Value`, and asserts the `server`, `uri`, and `name` fields match expected JSON values.

**Call relations**: Run by the test harness. It depends on the local `resource` helper and the production `ResourceWithServer::new` constructor.

*Call graph*: calls 2 internal fn (new, resource); 2 external calls (assert_eq!, to_value).


##### `list_resources_payload_from_single_server_copies_next_cursor`  (lines 44–58)

```
fn list_resources_payload_from_single_server_copies_next_cursor()
```

**Purpose**: Checks that `ListResourcesPayload::from_single_server` preserves pagination state and annotates nested resources with the server name.

**Data flow**: It constructs a `ListResourcesResult` with `next_cursor` and one resource, converts it into a payload with `from_single_server`, serializes to JSON, and asserts the top-level `server`, `nextCursor`, resource count, and nested resource `server` field.

**Call relations**: Executed by the test runner to validate the single-server payload constructor used by the list-resources handler.

*Call graph*: calls 1 internal fn (from_single_server); 3 external calls (assert_eq!, to_value, vec!).


##### `list_resources_payload_from_all_servers_is_sorted`  (lines 61–86)

```
fn list_resources_payload_from_all_servers_is_sorted()
```

**Purpose**: Ensures that aggregating resources from multiple servers yields a deterministic sorted order in the serialized payload.

**Data flow**: It builds a `HashMap` with resources under `beta` and `alpha`, converts it with `ListResourcesPayload::from_all_servers`, serializes to JSON, extracts the `uri` values from the `resources` array, and asserts they appear in sorted server/resource order.

**Call relations**: This test guards the aggregate constructor used when no server is specified. It specifically checks behavior that would otherwise be unstable due to hash-map iteration order.

*Call graph*: calls 1 internal fn (from_all_servers); 4 external calls (new, assert_eq!, to_value, vec!).


##### `call_tool_result_from_content_marks_success`  (lines 89–93)

```
fn call_tool_result_from_content_marks_success()
```

**Purpose**: Confirms that converting successful textual tool output into a call result marks it as non-error.

**Data flow**: It calls `call_tool_result_from_content("{}", Some(true))`, then asserts `is_error` is `Some(false)` and that one content item was produced.

**Call relations**: Run by the test harness to validate the helper used by MCP handlers when emitting end-of-call telemetry.

*Call graph*: 1 external calls (assert_eq!).


##### `parse_arguments_handles_empty_and_json`  (lines 96–111)

```
fn parse_arguments_handles_empty_and_json()
```

**Purpose**: Verifies that argument parsing treats blank input and JSON `null` as no arguments while still parsing valid JSON objects.

**Data flow**: It calls `parse_arguments` on whitespace and on `null`, asserting both return `None`, then parses a JSON object string and asserts the resulting value contains the expected `server` field.

**Call relations**: This test covers the parsing helper used by the MCP resource handlers before typed deserialization.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `template_with_server_serializes_server_field`  (lines 114–126)

```
fn template_with_server_serializes_server_field()
```

**Purpose**: Checks that `ResourceTemplateWithServer::new` serializes the server name together with the template URI and name.

**Data flow**: It creates a template fixture via `template`, wraps it with server `srv`, serializes to JSON, and asserts the entire JSON object matches the expected structure.

**Call relations**: Executed by the test runner to validate the template wrapper used in resource-template payloads.

*Call graph*: calls 2 internal fn (new, template); 2 external calls (assert_eq!, to_value).


##### `serialize_function_output_preserves_small_payload`  (lines 129–138)

```
fn serialize_function_output_preserves_small_payload()
```

**Purpose**: Ensures that serialization under a generous truncation policy leaves a small payload unchanged.

**Data flow**: It builds a small JSON payload, serializes it to the expected string with `serde_json::to_string`, passes the payload through `serialize_function_output` with `TruncationPolicy::Bytes(1_024)`, converts the result to text, and asserts exact equality with the original serialized string.

**Call relations**: This test validates the normal non-truncating path of the output serializer used by MCP handlers.

*Call graph*: 4 external calls (assert_eq!, json!, Bytes, to_string).


##### `serialize_function_output_caps_read_resource_payload`  (lines 141–162)

```
fn serialize_function_output_caps_read_resource_payload()
```

**Purpose**: Verifies that large read-resource payloads are truncated according to the byte policy instead of being returned in full.

**Data flow**: It constructs a `ReadResourcePayload` containing a `ReadResourceResult` with one very large `TextResourceContents`, serializes the full payload to JSON, computes the expected truncated string with `truncate_text`, serializes through `serialize_function_output` under `TruncationPolicy::Bytes(8_000)`, converts to text, and asserts the output differs from the full serialization but equals the expected truncated form.

**Call relations**: Run by the test harness to guard the bounded-output behavior relied on by `ReadMcpResourceHandler` when resource contents are large.

*Call graph*: 6 external calls (new, assert_eq!, assert_ne!, Bytes, to_string, vec!).


### `core/src/tools/handlers/mcp_search_tests.rs`

`test` · `test`

This file validates the search-index-facing metadata produced for MCP tools. Rather than exercising execution, it constructs a representative `ToolInfo` and asks `McpHandler::new(...).search_info()` to synthesize the searchable representation used elsewhere in the system.

The shared `tool_info` fixture builds a realistic MCP tool definition: server name `codex-apps`, callable namespace `mcp__calendar__`, callable name `_create_event`, connector name `Calendar`, plugin display names with surrounding whitespace, and an `rmcp::model::Tool` whose JSON schema exposes `start_time` and `attendees` parameters. The tool also has a title (`Create event`) and description (`Create a calendar event.`).

The first test asserts that `search_info.entry.search_text` concatenates multiple metadata sources into one normalized search string: namespace-qualified name, callable aliases, server name, connector name, title, description, namespace description, plugin display names, and parameter names. It also checks that `source_info` is populated from connector metadata. The second test removes `namespace_description` to verify the fallback path: the namespace output description should become `Tools for working with Calendar.` and `source_info` should still carry the connector name but no description. Together these tests ensure MCP tools remain discoverable even when some optional metadata is absent.

#### Function details

##### `search_info_uses_mcp_tool_metadata_and_parameter_names`  (lines 8–23)

```
fn search_info_uses_mcp_tool_metadata_and_parameter_names()
```

**Purpose**: Checks that MCP search metadata includes the expected combined search text and source attribution when full tool metadata is present.

**Data flow**: It builds a `ToolInfo` via `tool_info`, constructs an `McpHandler` from it, calls `search_info()`, and asserts the resulting `entry.search_text` and `source_info` exactly match the expected values.

**Call relations**: Executed by the test runner. It depends on the local `tool_info` fixture and the production `McpHandler::new`/`search_info` path.

*Call graph*: calls 2 internal fn (new, tool_info); 1 external calls (assert_eq!).


##### `search_info_uses_connector_name_for_output_namespace_description`  (lines 26–43)

```
fn search_info_uses_connector_name_for_output_namespace_description()
```

**Purpose**: Verifies the fallback behavior when `namespace_description` is absent: the namespace output description should be synthesized from the connector name.

**Data flow**: It starts from `tool_info()`, sets `namespace_description` to `None`, builds an `McpHandler`, obtains `search_info`, pattern-matches the output as `LoadableToolSpec::Namespace`, and asserts the namespace description and `source_info` contents. If the output is not a namespace, it panics.

**Call relations**: Run by the test harness to validate a specific fallback branch in MCP search metadata generation.

*Call graph*: calls 2 internal fn (new, tool_info); 2 external calls (assert_eq!, panic!).


##### `tool_info`  (lines 45–70)

```
fn tool_info() -> ToolInfo
```

**Purpose**: Constructs a representative `ToolInfo` fixture with realistic MCP metadata, schema properties, connector naming, and plugin display names.

**Data flow**: It creates and returns a `ToolInfo` struct populated with fixed strings and an `rmcp::model::Tool` built from a JSON object schema containing `start_time` and `attendees` properties. No external state is read or modified.

**Call relations**: Called by both tests in this file to centralize fixture setup and ensure they exercise the same baseline MCP tool definition.

*Call graph*: called by 2 (search_info_uses_connector_name_for_output_namespace_description, search_info_uses_mcp_tool_metadata_and_parameter_names); 5 external calls (new, json!, new, object, vec!).


### `core/src/tools/handlers/multi_agents_spec_tests.rs`

`test` · `test-time spec validation`

This test file exercises the spec-construction layer rather than runtime behavior. Each test builds a tool spec through helpers from the parent module and destructures the resulting `ToolSpec` into either a `ResponsesApiTool` function tool or a legacy namespace wrapper for v1. The assertions are concrete: `spawn_agent` v2 must expose an object schema with `task_name` and encrypted `message`, omit legacy `items` and `fork_context`, include `fork_turns`, and advertise only models whose `ModelPreset.show_in_picker` flag is true. The tests also pin the exact descriptive guidance strings for inherited model behavior, model override descriptions, and service-tier override descriptions.

A small `model_preset` helper fabricates realistic `ModelPreset` values with one reasoning effort and one service tier so description rendering can be checked deterministically. Edge cases covered include truncating the visible model summary list to five entries, truncating oversized custom reasoning-effort labels to `MAX_REASONING_EFFORT_CHARS_IN_SPAWN_AGENT_DESCRIPTION`, and suppressing all model/service-tier metadata when `hide_agent_type_model_reasoning` is enabled. Separate tests confirm that `send_message` and `followup_task` require encrypted `message` fields and produce no output schema, that `wait_agent` v2 accepts only timeout configuration and returns a summary-only output schema, and that `list_agents` includes path-prefix filtering plus the expanded status enum containing `interrupted`.

#### Function details

##### `model_preset`  (lines 11–37)

```
fn model_preset(id: &str, show_in_picker: bool) -> ModelPreset
```

**Purpose**: Builds a synthetic `ModelPreset` with predictable IDs, display text, one medium reasoning-effort preset, and one `priority` service tier for use in spec-description tests.

**Data flow**: Takes an `id` string and `show_in_picker` flag, derives `model`, `display_name`, and `description` strings from `id`, fills the remaining `ModelPreset` fields with fixed defaults, and returns the assembled struct without mutating external state.

**Call relations**: Used by tests that need concrete model metadata, especially the reasoning-effort truncation case, so the surrounding assertions can inspect exactly how spawn-agent descriptions summarize visible models.

*Call graph*: called by 1 (spawn_agent_tool_caps_reasoning_effort_value_length); 3 external calls (new, format!, vec!).


##### `spawn_agent_tool_v2_requires_task_name_and_lists_visible_models`  (lines 40–116)

```
fn spawn_agent_tool_v2_requires_task_name_and_lists_visible_models()
```

**Purpose**: Checks the v2 `spawn_agent` tool spec for required fields, encrypted message handling, output schema shape, and visible-only model summary text.

**Data flow**: Constructs `SpawnAgentToolOptions` with one visible and one hidden model, creates the tool, destructures the function spec, then reads description text, parameter schema type, property map, required list, and output schema JSON to assert exact inclusions and exclusions.

**Call relations**: Acts as the main contract test for the v2 spawn spec, validating the output of `create_spawn_agent_tool_v2` under normal metadata-rich configuration.

*Call graph*: 4 external calls (assert!, assert_eq!, panic!, vec!).


##### `spawn_agent_tool_v1_keeps_legacy_fork_context_field`  (lines 119–166)

```
fn spawn_agent_tool_v1_keeps_legacy_fork_context_field()
```

**Purpose**: Confirms the legacy v1 `spawn_agent` namespace tool still exposes `fork_context` and the older unencrypted message semantics.

**Data flow**: Builds a v1 tool with empty model options, unwraps the namespace and first nested function tool, then inspects the object-parameter properties to verify `fork_context` exists, `fork_turns` does not, and `message.encrypted` remains unset.

**Call relations**: Guards backward compatibility for the v1 surface produced by `create_spawn_agent_tool_v1`, contrasting it with the stricter v2 schema.

*Call graph*: 4 external calls (new, assert!, assert_eq!, panic!).


##### `spawn_agent_tool_caps_visible_model_summaries`  (lines 169–196)

```
fn spawn_agent_tool_caps_visible_model_summaries()
```

**Purpose**: Verifies that the spawn-agent description includes at most five visible model summaries even when more are available.

**Data flow**: Creates six visible `ModelPreset`s, builds the v2 tool, extracts the description string, and checks that the first five model slugs appear while the sixth does not.

**Call relations**: Exercises the description-rendering cap in the spawn-agent spec builder so prompt text stays bounded.

*Call graph*: 3 external calls (assert!, panic!, vec!).


##### `spawn_agent_tool_caps_reasoning_effort_value_length`  (lines 199–217)

```
fn spawn_agent_tool_caps_reasoning_effort_value_length()
```

**Purpose**: Ensures custom reasoning-effort labels are truncated before being embedded in the spawn-agent model summary text.

**Data flow**: Starts from a synthetic visible model, replaces its default and supported reasoning effort with an oversized `ReasoningEffort::Custom` string, passes the single-model slice into `spawn_agent_models_description`, and compares the returned description against the expected truncated string.

**Call relations**: Targets the formatting helper directly to pin the exact truncation behavior used by spawn-agent spec descriptions.

*Call graph*: calls 1 internal fn (model_preset); 3 external calls (assert_eq!, Custom, vec!).


##### `spawn_agent_tool_hides_service_tier_with_spawn_metadata`  (lines 220–248)

```
fn spawn_agent_tool_hides_service_tier_with_spawn_metadata()
```

**Purpose**: Checks that spawn-agent metadata fields and descriptive guidance disappear when agent-type/model reasoning details are intentionally hidden.

**Data flow**: Builds a v2 spawn tool with `hide_agent_type_model_reasoning` enabled, extracts description and parameter properties, and asserts that `agent_type`, `model`, `reasoning_effort`, and `service_tier` are absent and that inherited-model guidance text is omitted.

**Call relations**: Validates the alternate spec path used when the runtime wants a minimal spawn surface without model-selection hints.

*Call graph*: 3 external calls (assert!, panic!, vec!).


##### `send_message_tool_requires_message_and_has_no_output_schema`  (lines 251–289)

```
fn send_message_tool_requires_message_and_has_no_output_schema()
```

**Purpose**: Pins the `send_message` tool schema to an object with required `target` and encrypted `message`, and no output schema.

**Data flow**: Creates the tool, unwraps the function spec, reads parameter schema type, property descriptions, encrypted flags, required list, and `output_schema`, then asserts the exact expected values and omitted legacy fields.

**Call relations**: Serves as the schema contract test for `create_send_message_tool`.

*Call graph*: 3 external calls (assert!, assert_eq!, panic!).


##### `followup_task_tool_requires_message_and_has_no_output_schema`  (lines 292–330)

```
fn followup_task_tool_requires_message_and_has_no_output_schema()
```

**Purpose**: Verifies the `followup_task` tool name, exact description text, required encrypted message parameters, and lack of output schema.

**Data flow**: Builds the tool, destructures the function spec, and inspects `name`, `description`, parameter object properties, encrypted flag on `message`, required fields, and `output_schema`.

**Call relations**: Locks down the public spec emitted by `create_followup_task_tool`, including its longer behavioral description.

*Call graph*: 3 external calls (assert!, assert_eq!, panic!).


##### `wait_agent_tool_v2_uses_timeout_only_summary_output`  (lines 333–371)

```
fn wait_agent_tool_v2_uses_timeout_only_summary_output()
```

**Purpose**: Checks that the v2 wait tool accepts only timeout configuration and advertises summary-only output rather than returning child content.

**Data flow**: Creates the tool with explicit timeout bounds, unwraps the function spec, inspects description text, parameter properties, timeout description, required list, and output-schema JSON for the `message` field description.

**Call relations**: Validates the MultiAgentV2 wait-tool contract generated by `create_wait_agent_tool_v2`.

*Call graph*: 3 external calls (assert!, assert_eq!, panic!).


##### `list_agents_tool_includes_path_prefix_and_agent_fields`  (lines 374–402)

```
fn list_agents_tool_includes_path_prefix_and_agent_fields()
```

**Purpose**: Confirms the list-agents tool exposes an optional `path_prefix` filter and returns agent objects with the expected required fields.

**Data flow**: Creates the tool, unwraps the function spec, reads the parameter property map and output-schema JSON, and asserts the `path_prefix` description plus the required fields on each returned agent item.

**Call relations**: Tests the schema emitted by `create_list_agents_tool` for filtering and result-shape completeness.

*Call graph*: 3 external calls (assert!, assert_eq!, panic!).


##### `list_agents_tool_status_schema_includes_interrupted`  (lines 405–422)

```
fn list_agents_tool_status_schema_includes_interrupted()
```

**Purpose**: Pins the list-agents output schema so the status enum includes the `interrupted` state alongside other lifecycle states.

**Data flow**: Builds the list-agents tool, extracts its output schema JSON, navigates to the nested enum under `agent_status`, and compares it to the expected ordered list of status strings.

**Call relations**: Complements the broader list-agents schema test by focusing on the expanded status vocabulary exposed to callers.

*Call graph*: 2 external calls (assert_eq!, panic!).


### `core/src/tools/handlers/multi_agents_tests.rs`

`test` · `test-time handler and integration validation`

This is the main behavioral test suite for multi-agent tooling. It defines reusable helpers to build `ToolInvocation` values with a fresh `CancellationToken` and `TurnDiffTracker`, serialize JSON arguments into `ToolPayload::Function`, parse `ThreadId`s, create a test `ThreadManager`, install temporary role TOML files, update a `TurnContext` after feature toggles, and normalize any `ToolOutput` into plain text plus success metadata. Small deserialization structs (`ListAgentsResult`, `ListedAgentResult`, `InterruptAgentResult`) let tests inspect JSON responses structurally.

The tests cover both legacy handlers (`SpawnAgentHandler`, `SendInputHandler`, `ResumeAgentHandler`, `WaitAgentHandler`, `CloseAgentHandler`) and v2 handlers (`SpawnAgentHandlerV2`, `SendMessageHandlerV2`, `FollowupTaskHandlerV2`, `WaitAgentHandlerV2`, `ListAgentsHandlerV2`, `InterruptAgentHandler`). They verify argument parsing failures, empty-message rejection, mutual exclusion of `message` and `items`, depth-limit enforcement, manager-unavailable errors, and exact model-facing error strings. More involved scenarios assert inheritance and validation of model provider, reasoning effort, service tier, approval policy, sandbox and permission profiles, plus role-config overrides and fallback behavior.

For MultiAgentV2, the suite checks task-name requirements, path-based addressing, relative-path resolution, root/self-target restrictions, mailbox-driven wait semantics, summary-only wait outputs that never leak child content, list-agents filtering and status reporting, and interrupt behavior for resident and unloaded agents. It also exercises persistence-aware close/resume cascades across parent-child-grandchild subtrees and validates helper functions that derive child configs from `TurnContext`, ensuring runtime overrides are preserved while resume clears inherited base instructions.

#### Function details

##### `invocation`  (lines 69–85)

```
fn invocation(
    session: Arc<crate::session::session::Session>,
    turn: Arc<TurnContext>,
    tool_name: &str,
    payload: ToolPayload,
) -> ToolInvocation
```

**Purpose**: Builds a fully populated `ToolInvocation` fixture for tests, including cancellation and diff-tracking state.

**Data flow**: Consumes a session `Arc`, turn `Arc`, tool name string, and `ToolPayload`; wraps them into a `ToolInvocation` with a new `CancellationToken`, a fresh `Arc<Mutex<TurnDiffTracker>>`, fixed `call_id` `call-1`, plain tool name, and direct call source; returns the assembled invocation.

**Call relations**: Used throughout the suite whenever a handler is invoked, so each test can focus on payload and session setup rather than boilerplate invocation construction.

*Call graph*: calls 2 internal fn (default, plain); called by 76 (close_agent_submits_shutdown_and_returns_previous_status, handler_rejects_non_function_payloads, multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn, multi_agent_v2_followup_task_rejects_legacy_items_field, multi_agent_v2_followup_task_rejects_root_target_from_child, multi_agent_v2_full_history_fork_accepts_explicit_service_tier, multi_agent_v2_interrupt_agent_accepts_task_name_target, multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target, multi_agent_v2_interrupt_agent_rejects_root_target_and_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_id (+15 more)); 3 external calls (new, new, new).


##### `function_payload`  (lines 87–91)

```
fn function_payload(args: serde_json::Value) -> ToolPayload
```

**Purpose**: Converts a JSON value into the stringly typed function-call payload format expected by tool handlers.

**Data flow**: Takes a `serde_json::Value`, serializes it with `to_string`, and returns `ToolPayload::Function { arguments }`.

**Call relations**: Paired with `invocation` in nearly every handler test to feed parsed function arguments into the tool runtime.

*Call graph*: called by 75 (close_agent_submits_shutdown_and_returns_previous_status, multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn, multi_agent_v2_followup_task_rejects_legacy_items_field, multi_agent_v2_followup_task_rejects_root_target_from_child, multi_agent_v2_full_history_fork_accepts_explicit_service_tier, multi_agent_v2_interrupt_agent_accepts_task_name_target, multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target, multi_agent_v2_interrupt_agent_rejects_root_target_and_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_task_name (+15 more)); 1 external calls (to_string).


##### `parse_agent_id`  (lines 93–95)

```
fn parse_agent_id(id: &str) -> ThreadId
```

**Purpose**: Parses a thread identifier string into a `ThreadId` and fails the test immediately if the string is invalid.

**Data flow**: Reads an `&str`, calls `ThreadId::from_string`, unwraps with `expect`, and returns the parsed `ThreadId`.

**Call relations**: Used after spawn-tool responses are decoded from JSON so tests can inspect the spawned thread's config snapshot or status.

*Call graph*: calls 1 internal fn (from_string); called by 7 (spawn_agent_full_history_fork_accepts_explicit_service_tier, spawn_agent_reapplies_runtime_sandbox_after_role_config, spawn_agent_role_service_tier_falls_back_to_supported_parent_tier, spawn_agent_service_tier_inheritance_preserves_supported_or_configured_tiers, spawn_agent_service_tier_override_validates_the_effective_child_model, spawn_agent_uses_explorer_role_and_preserves_approval_policy, tool_handlers_cascade_close_and_resume_and_keep_explicitly_closed_subtrees_closed).


##### `thread_manager`  (lines 97–102)

```
fn thread_manager() -> ThreadManager
```

**Purpose**: Creates a test `ThreadManager` wired to dummy auth and the built-in OpenAI provider.

**Data flow**: Constructs `CodexAuth` from a dummy API key, looks up the `openai` provider from `built_in_model_providers`, and returns `ThreadManager::with_models_provider_for_tests(...)`.

**Call relations**: Supplies the in-memory agent-control backend for most integration tests that need to spawn, interrupt, list, or wait on threads.

*Call graph*: calls 2 internal fn (with_models_provider_for_tests, from_api_key); called by 56 (close_agent_submits_shutdown_and_returns_previous_status, multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn, multi_agent_v2_followup_task_rejects_legacy_items_field, multi_agent_v2_followup_task_rejects_root_target_from_child, multi_agent_v2_full_history_fork_accepts_explicit_service_tier, multi_agent_v2_interrupt_agent_accepts_task_name_target, multi_agent_v2_interrupt_agent_rejects_root_target_and_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_task_name, multi_agent_v2_interrupted_turn_does_not_notify_parent (+15 more)); 1 external calls (built_in_model_providers).


##### `install_role_with_model_override`  (lines 104–136)

```
async fn install_role_with_model_override(turn: &mut TurnContext) -> String
```

**Purpose**: Writes a temporary role config file that overrides model, provider, and reasoning effort, then registers that role in the turn config.

**Data flow**: Mutably borrows `TurnContext`, creates the codex home directory, writes `fork-context-role.toml` containing `model`, `model_provider`, and `model_reasoning_effort`, clones and updates `turn.config.agent_roles`, stores the new config back into `turn.config`, and returns the role name string.

**Call relations**: Called by tests that need a concrete role override to verify forking rules and partial-fork behavior around inherited versus overridden model settings.

*Call graph*: called by 3 (multi_agent_v2_spawn_fork_turns_all_rejects_agent_type_override, multi_agent_v2_spawn_partial_fork_turns_allows_agent_type_override, spawn_agent_fork_context_rejects_agent_type_override); 3 external calls (new, create_dir_all, write).


##### `set_turn_config`  (lines 138–141)

```
fn set_turn_config(turn: &mut TurnContext, config: crate::config::Config)
```

**Purpose**: Replaces the turn's config and recomputes its multi-agent version from enabled features.

**Data flow**: Takes a mutable `TurnContext` and a new `Config`, computes `multi_agent_version_from_features`, assigns that version to `turn.multi_agent_version`, wraps the config in `Arc`, and stores it on the turn.

**Call relations**: Used whenever tests toggle `Feature::MultiAgentV2` or adjust wait-timeout settings so the turn reflects the updated configuration.

*Call graph*: called by 39 (multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn, multi_agent_v2_followup_task_rejects_legacy_items_field, multi_agent_v2_followup_task_rejects_root_target_from_child, multi_agent_v2_full_history_fork_accepts_explicit_service_tier, multi_agent_v2_interrupt_agent_accepts_task_name_target, multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target, multi_agent_v2_interrupt_agent_rejects_root_target_and_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_task_name, multi_agent_v2_interrupted_turn_does_not_notify_parent (+15 more)); 2 external calls (new, multi_agent_version_from_features).


##### `expect_text_output`  (lines 143–167)

```
fn expect_text_output(output: T) -> (String, Option<bool>)
```

**Purpose**: Normalizes any `ToolOutput` into plain text and optional success metadata for assertions.

**Data flow**: Accepts a generic `T: ToolOutput`, converts it to a `ResponseInputItem` using a dummy function payload, matches function/custom tool outputs, extracts either direct text or flattens content items via `function_call_output_content_items_to_text`, and returns `(content, output.success)`; panics if the response item is not a tool output.

**Call relations**: Used after successful handler calls across the suite so tests can deserialize JSON result bodies or inspect empty-text acknowledgements uniformly.

*Call graph*: calls 1 internal fn (function_call_output_content_items_to_text); called by 35 (close_agent_submits_shutdown_and_returns_previous_status, multi_agent_v2_full_history_fork_accepts_explicit_service_tier, multi_agent_v2_interrupt_agent_accepts_task_name_target, multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target, multi_agent_v2_list_agents_filters_by_relative_path_prefix, multi_agent_v2_list_agents_keeps_interrupted_resident_agents, multi_agent_v2_list_agents_omits_closed_agents, multi_agent_v2_list_agents_returns_completed_status_without_encrypted_spawn_preview, multi_agent_v2_spawn_agent_ignores_configured_max_depth, multi_agent_v2_spawn_omits_agent_id_when_named (+15 more)); 2 external calls (to_response_item, panic!).


##### `handler_rejects_non_function_payloads`  (lines 187–206)

```
async fn handler_rejects_non_function_payloads()
```

**Purpose**: Verifies that the spawn-agent handler rejects non-function tool payloads with a model-facing error.

**Data flow**: Creates a session and turn, builds an invocation carrying `ToolPayload::Custom`, awaits `SpawnAgentHandler::handle`, and asserts the returned `FunctionCallError::RespondToModel` string.

**Call relations**: Exercises the earliest payload-kind validation path in the legacy spawn handler.

*Call graph*: calls 2 internal fn (make_session_and_context, invocation); 4 external calls (new, default, assert_eq!, panic!).


##### `spawn_agent_rejects_empty_message`  (lines 209–224)

```
async fn spawn_agent_rejects_empty_message()
```

**Purpose**: Checks that whitespace-only spawn messages are rejected.

**Data flow**: Builds a spawn invocation whose JSON arguments contain only a blank `message`, runs the handler, and compares the resulting error to the exact empty-message string.

**Call relations**: Covers shared message validation on the legacy spawn path.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `spawn_agent_rejects_when_message_and_items_are_both_set`  (lines 227–247)

```
async fn spawn_agent_rejects_when_message_and_items_are_both_set()
```

**Purpose**: Ensures legacy spawn rejects requests that provide both plain text and structured items.

**Data flow**: Creates a spawn invocation with both `message` and `items` in the JSON payload, executes the handler, and asserts the mutual-exclusion error text.

**Call relations**: Pins argument validation for the older spawn surface that still accepts structured items.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `spawn_agent_uses_explorer_role_and_preserves_approval_policy`  (lines 250–307)

```
async fn spawn_agent_uses_explorer_role_and_preserves_approval_policy()
```

**Purpose**: Tests that spawning with the `explorer` role applies the configured provider while preserving the caller's approval policy.

**Data flow**: Creates session/turn state, swaps in a test `ThreadManager`, changes config and turn approval policy to `AskForApproval::OnRequest`, switches provider info to `ollama`, invokes legacy spawn with `agent_type: explorer`, parses the JSON result, resolves the child thread, reads its config snapshot, and asserts approval policy and provider ID.

**Call relations**: Exercises a successful spawn path where role selection and runtime approval settings must both survive into the child thread.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, thread_manager); 8 external calls (new, default, assert!, assert_eq!, create_model_provider, built_in_model_providers, json!, from_str).


##### `spawn_agent_fork_context_rejects_agent_type_override`  (lines 310–341)

```
async fn spawn_agent_fork_context_rejects_agent_type_override()
```

**Purpose**: Confirms full-history legacy forks reject explicit `agent_type` overrides.

**Data flow**: Installs a role override, starts a root thread, points the session at that root, invokes legacy spawn with `fork_context: true` plus `agent_type`, and asserts the exact inheritance error message.

**Call relations**: Tests the legacy full-fork rule that child role/model/reasoning must be inherited from the parent.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, install_role_with_model_override, invocation, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `spawn_agent_fork_context_rejects_child_model_overrides`  (lines 344–376)

```
async fn spawn_agent_fork_context_rejects_child_model_overrides()
```

**Purpose**: Checks that full-history legacy forks also reject explicit child `model` and `reasoning_effort` overrides.

**Data flow**: Starts a root thread, invokes legacy spawn with `fork_context: true`, `model`, and `reasoning_effort`, and asserts the same inheritance error returned to the model.

**Call relations**: Complements the previous test by covering direct model-setting overrides instead of role-based overrides.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `multi_agent_v2_spawn_fork_turns_all_rejects_agent_type_override`  (lines 379–422)

```
async fn multi_agent_v2_spawn_fork_turns_all_rejects_agent_type_override()
```

**Purpose**: Verifies that MultiAgentV2 treats `fork_turns: all` as a full-history fork and rejects `agent_type` overrides.

**Data flow**: Enables `Feature::MultiAgentV2`, installs a role override, starts a root thread, invokes `SpawnAgentHandlerV2` with `task_name`, `fork_turns: all`, and `agent_type`, then asserts the inheritance error string.

**Call relations**: Covers the v2 equivalent of legacy `fork_context` validation.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, install_role_with_model_override, invocation, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `multi_agent_v2_spawn_defaults_to_full_fork_and_rejects_child_model_overrides`  (lines 425–463)

```
async fn multi_agent_v2_spawn_defaults_to_full_fork_and_rejects_child_model_overrides()
```

**Purpose**: Checks that omitting `fork_turns` in v2 defaults to full-history behavior and therefore rejects child model overrides.

**Data flow**: Enables v2 on the turn, starts a root thread, invokes v2 spawn with `task_name`, `model`, and `reasoning_effort` but no `fork_turns`, and asserts the inheritance error.

**Call relations**: Pins the default-fork semantics of v2 spawn.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `spawn_agent_service_tier_override_validates_the_effective_child_model`  (lines 466–562)

```
async fn spawn_agent_service_tier_override_validates_the_effective_child_model()
```

**Purpose**: Tests service-tier validation against the final child model, including acceptance of supported tiers and rejection of unsupported or unknown tiers.

**Data flow**: Runs three subcases: successful spawn with explicit `model` and supported `service_tier`, then two failing spawns with an unknown tier and with a tier unsupported by the chosen model; successful output is parsed to a child `ThreadId` and its snapshot is inspected for persisted `service_tier`.

**Call relations**: Exercises spawn-time service-tier validation logic on the legacy handler, including model-specific support checks.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `spawn_agent_service_tier_inheritance_preserves_supported_or_configured_tiers`  (lines 565–718)

```
async fn spawn_agent_service_tier_inheritance_preserves_supported_or_configured_tiers()
```

**Purpose**: Verifies inherited or role-configured service tiers are preserved when supported and cleared when incompatible with the effective child model.

**Data flow**: Runs three scenarios: inheriting a supported parent tier, clearing an inherited tier when the child model changes to one without support, and preserving a role-configured child tier from a TOML role file; each successful spawn is parsed and the child snapshot inspected.

**Call relations**: Covers the precedence and compatibility rules for service-tier inheritance during spawn.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, thread_manager); 7 external calls (new, default, assert_eq!, json!, from_str, create_dir_all, write).


##### `spawn_agent_role_service_tier_falls_back_to_supported_parent_tier`  (lines 721–790)

```
async fn spawn_agent_role_service_tier_falls_back_to_supported_parent_tier()
```

**Purpose**: Checks that an unsupported role-configured child tier falls back to a supported parent tier instead of failing the spawn.

**Data flow**: Creates a role file with `service_tier = "turbo"`, configures the parent with `priority`, spawns using that role, parses the child ID, and asserts the child snapshot kept the parent's supported tier.

**Call relations**: Tests fallback behavior when role config is invalid but the parent already has a usable tier.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, thread_manager); 7 external calls (new, default, assert_eq!, json!, from_str, create_dir_all, write).


##### `spawn_agent_role_service_tier_does_not_hide_invalid_spawn_request`  (lines 793–840)

```
async fn spawn_agent_role_service_tier_does_not_hide_invalid_spawn_request()
```

**Purpose**: Ensures an explicitly invalid spawn request still fails even if the selected role itself has a valid service tier.

**Data flow**: Writes a role file with supported `priority`, registers the role, invokes spawn with that role plus explicit `service_tier: turbo`, and asserts the request is rejected with the unsupported-tier error.

**Call relations**: Guards against role defaults masking caller-supplied invalid overrides.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 6 external calls (new, default, assert_eq!, json!, create_dir_all, write).


##### `spawn_agent_full_history_fork_accepts_explicit_service_tier`  (lines 843–888)

```
async fn spawn_agent_full_history_fork_accepts_explicit_service_tier()
```

**Purpose**: Confirms that full-history legacy forks may still accept an explicit service-tier override.

**Data flow**: Starts a root thread under model `gpt-5.4`, invokes legacy spawn with `fork_context: true` and `service_tier: priority`, parses the child ID, and asserts the child snapshot persisted that tier.

**Call relations**: Shows that full-fork inheritance restrictions apply to role/model/reasoning, not to service tier.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `multi_agent_v2_full_history_fork_accepts_explicit_service_tier`  (lines 891–954)

```
async fn multi_agent_v2_full_history_fork_accepts_explicit_service_tier()
```

**Purpose**: Checks the same explicit service-tier acceptance on the MultiAgentV2 full-fork path.

**Data flow**: Enables v2, starts a root thread, invokes v2 spawn with `task_name` and `service_tier`, parses the returned task path, resolves it back to a child thread ID through agent-control, and asserts the child snapshot's tier.

**Call relations**: Provides the v2 counterpart to the legacy full-fork service-tier test.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `multi_agent_v2_spawn_partial_fork_turns_allows_agent_type_override`  (lines 957–1012)

```
async fn multi_agent_v2_spawn_partial_fork_turns_allows_agent_type_override()
```

**Purpose**: Verifies that a partial v2 fork (`fork_turns: "1"`) allows role/model overrides that full forks reject.

**Data flow**: Enables v2, installs a role override, starts a root thread, invokes v2 spawn with `task_name`, `agent_type`, and `fork_turns: "1"`, parses the JSON result, identifies the spawned child from captured ops, and inspects its snapshot for overridden model, provider, and reasoning effort.

**Call relations**: Contrasts partial-fork semantics with full-fork inheritance restrictions.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, install_role_with_model_override, invocation, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `spawn_agent_returns_agent_id_without_task_name`  (lines 1015–1039)

```
async fn spawn_agent_returns_agent_id_without_task_name()
```

**Purpose**: Checks that legacy spawn returns an `agent_id` and nickname but no `task_name`.

**Data flow**: Creates a manager-backed session, invokes legacy spawn with only a message, converts the output to text, parses the JSON, and asserts presence/absence of `agent_id`, `task_name`, `nickname`, and success metadata.

**Call relations**: Pins the legacy response shape for unnamed spawned agents.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 6 external calls (new, default, assert!, assert_eq!, json!, from_str).


##### `multi_agent_v2_spawn_requires_task_name`  (lines 1042–1073)

```
async fn multi_agent_v2_spawn_requires_task_name()
```

**Purpose**: Ensures v2 spawn rejects requests that omit `task_name`.

**Data flow**: Enables v2, starts a root thread, invokes v2 spawn with only `message`, captures the parse error, and asserts the model-facing message mentions missing `task_name`.

**Call relations**: Covers strict argument parsing for the v2 spawn schema.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert!, json!, panic!).


##### `multi_agent_v2_spawn_rejects_legacy_items_field`  (lines 1076–1109)

```
async fn multi_agent_v2_spawn_rejects_legacy_items_field()
```

**Purpose**: Checks that v2 spawn rejects the legacy `items` field entirely.

**Data flow**: Enables v2, starts a root thread, invokes v2 spawn with `message`, `task_name`, and `items`, then asserts the parse error reports `unknown field `items``.

**Call relations**: Confirms the v2 parser is intentionally narrower than the legacy spawn surface.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert!, json!, panic!).


##### `spawn_agent_errors_when_manager_dropped`  (lines 1112–1127)

```
async fn spawn_agent_errors_when_manager_dropped()
```

**Purpose**: Verifies spawn fails cleanly when no collaboration manager is available in session services.

**Data flow**: Creates a plain session/turn without installing agent-control, invokes legacy spawn, and asserts the returned error is `collab manager unavailable`.

**Call relations**: Exercises the dependency-availability failure path before any thread work begins.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `multi_agent_v2_spawn_returns_path_and_send_message_accepts_relative_path`  (lines 1130–1228)

```
async fn multi_agent_v2_spawn_returns_path_and_send_message_accepts_relative_path()
```

**Purpose**: Tests that v2 spawn returns a canonical task path and that subsequent `send_message` can target the child by relative path.

**Data flow**: Enables v2, starts a root thread, spawns a child with encrypted message and `task_name`, parses the returned `/root/...` path, resolves the child thread ID, inspects its session source, checks captured `Op::InterAgentCommunication` for the encrypted spawn message with `trigger_turn = true`, then sends another message to relative target `test_process` and asserts a second queued communication with `trigger_turn = false`.

**Call relations**: Exercises the happy path across two v2 tools—spawn and send_message—and validates path resolution plus encrypted mailbox delivery.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 6 external calls (new, default, assert!, assert_eq!, json!, from_str).


##### `multi_agent_v2_spawn_rejects_legacy_fork_context`  (lines 1231–1268)

```
async fn multi_agent_v2_spawn_rejects_legacy_fork_context()
```

**Purpose**: Ensures v2 spawn rejects the old `fork_context` parameter and directs callers to `fork_turns`.

**Data flow**: Enables v2, starts a root thread, invokes v2 spawn with `task_name` and `fork_context: true`, and asserts the exact replacement-guidance error string.

**Call relations**: Pins migration behavior from the legacy fork flag to the v2 fork-turns model.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `multi_agent_v2_spawn_rejects_invalid_fork_turns_string`  (lines 1271–1308)

```
async fn multi_agent_v2_spawn_rejects_invalid_fork_turns_string()
```

**Purpose**: Checks that malformed `fork_turns` values are rejected.

**Data flow**: Enables v2, starts a root thread, invokes v2 spawn with `fork_turns: "banana"`, and asserts the validation error describing the accepted forms.

**Call relations**: Covers string parsing for the v2 fork-turns parameter.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `multi_agent_v2_spawn_rejects_zero_fork_turns`  (lines 1311–1348)

```
async fn multi_agent_v2_spawn_rejects_zero_fork_turns()
```

**Purpose**: Ensures `fork_turns: "0"` is rejected as invalid.

**Data flow**: Enables v2, starts a root thread, invokes v2 spawn with zero fork turns, and asserts the same positive-integer-or-keyword validation error.

**Call relations**: Complements the malformed-string test with the numeric edge case.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `multi_agent_v2_send_message_accepts_root_target_from_child`  (lines 1351–1425)

```
async fn multi_agent_v2_send_message_accepts_root_target_from_child()
```

**Purpose**: Verifies a child agent may use v2 `send_message` to queue an encrypted message to `/root`.

**Data flow**: Enables v2, starts a root thread, manually spawns a child with `SessionSource::SubAgent`, switches the session and turn to that child context, invokes `SendMessageHandlerV2` targeting `/root`, and inspects captured ops on the root thread for an encrypted `InterAgentCommunication` authored by the child path with `trigger_turn = false`.

**Call relations**: Exercises path resolution and author attribution for child-to-root queued messaging.

*Call graph*: calls 6 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager, try_from); 6 external calls (new, SubAgent, assert!, default, json!, vec!).


##### `multi_agent_v2_followup_task_rejects_root_target_from_child`  (lines 1428–1508)

```
async fn multi_agent_v2_followup_task_rejects_root_target_from_child()
```

**Purpose**: Checks that a child agent cannot use `followup_task` to target the root agent.

**Data flow**: Sets up a child session context under v2, invokes `FollowupTaskHandlerV2` with target `/root`, asserts the model-facing rejection string, then confirms no interrupt or communication ops were submitted to the root thread.

**Call relations**: Covers the special root-target prohibition enforced only for trigger-turn follow-up tasks.

*Call graph*: calls 6 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager, try_from); 8 external calls (new, SubAgent, assert!, assert_eq!, default, json!, panic!, vec!).


##### `multi_agent_v2_list_agents_returns_completed_status_without_encrypted_spawn_preview`  (lines 1511–1599)

```
async fn multi_agent_v2_list_agents_returns_completed_status_without_encrypted_spawn_preview()
```

**Purpose**: Verifies list-agents reports completed child status using completion events and does not expose the encrypted spawn message as `last_task_message`.

**Data flow**: Enables v2, spawns a worker, resolves its thread, emits a `TurnCompleteEvent` with `last_agent_message = "done"`, invokes `ListAgentsHandlerV2`, parses the JSON result, and asserts the root and worker entries, including worker `agent_status = {"completed":"done"}` and `last_task_message = null`.

**Call relations**: Exercises list-agents aggregation over live thread state and completion-event history.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 6 external calls (new, default, assert_eq!, json!, TurnComplete, from_str).


##### `multi_agent_v2_list_agents_filters_by_relative_path_prefix`  (lines 1602–1686)

```
async fn multi_agent_v2_list_agents_filters_by_relative_path_prefix()
```

**Purpose**: Checks that list-agents can filter descendants by a relative path prefix from the caller's current agent path.

**Data flow**: Enables v2, starts a root thread, manually spawns `/root/researcher` and `/root/researcher/worker`, changes the turn's session source to the researcher, invokes list-agents with `path_prefix: "worker"`, parses the result, and asserts only the nested worker is returned with its original task message.

**Call relations**: Tests path-prefix filtering semantics relative to the caller's subtree.

*Call graph*: calls 7 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, from_string); 7 external calls (new, SubAgent, assert_eq!, default, json!, from_str, vec!).


##### `multi_agent_v2_list_agents_omits_closed_agents`  (lines 1689–1750)

```
async fn multi_agent_v2_list_agents_omits_closed_agents()
```

**Purpose**: Ensures closed agents are not returned by list-agents.

**Data flow**: Enables v2, spawns a worker, resolves its thread ID, closes it through agent-control, invokes list-agents, parses the result, and asserts only `/root` remains.

**Call relations**: Covers the interaction between agent lifecycle state and list-agents visibility.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `multi_agent_v2_list_agents_keeps_interrupted_resident_agents`  (lines 1753–1826)

```
async fn multi_agent_v2_list_agents_keeps_interrupted_resident_agents()
```

**Purpose**: Checks that interrupted but still resident agents remain visible in list-agents output.

**Data flow**: Enables v2, spawns a worker, resolves its path, interrupts it through `InterruptAgentHandler`, then invokes list-agents and asserts both root and worker are still listed.

**Call relations**: Distinguishes interrupted agents from closed agents in list-agents behavior.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `multi_agent_v2_send_message_rejects_legacy_items_field`  (lines 1829–1882)

```
async fn multi_agent_v2_send_message_rejects_legacy_items_field()
```

**Purpose**: Verifies v2 `send_message` rejects the old structured `items` argument.

**Data flow**: Enables v2, spawns a worker, resolves its ID, invokes `SendMessageHandlerV2` with `items` instead of `message`, and asserts the parse error mentions `unknown field `items``.

**Call relations**: Pins the strict v2 parser for queued messaging.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert!, json!, panic!).


##### `multi_agent_v2_send_message_rejects_interrupt_parameter`  (lines 1885–1956)

```
async fn multi_agent_v2_send_message_rejects_interrupt_parameter()
```

**Purpose**: Checks that v2 `send_message` rejects the legacy `interrupt` parameter and performs no side effects.

**Data flow**: Enables v2, spawns a worker, invokes `SendMessageHandlerV2` with `message` plus `interrupt: true`, asserts the parse error prefix, then inspects captured ops to confirm neither `Op::Interrupt` nor the queued communication was submitted.

**Call relations**: Guards against accidental compatibility with the older send-input semantics.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert!, json!, panic!).


##### `multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn`  (lines 1959–2098)

```
async fn multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn()
```

**Purpose**: Verifies that after a follow-up task is sent, each subsequent completed child turn generates exactly one completion notification back to the parent.

**Data flow**: Enables v2, starts a root thread and initializes a parent turn runtime, spawns a worker, emits one `TurnCompleteEvent`, sends a follow-up task, emits a second completion event, renders the expected notification strings with `format_inter_agent_completion_message`, then polls captured ops until exactly one matching root-directed communication exists for each completion.

**Call relations**: Exercises the interaction between follow-up task delivery and the child-to-parent completion notification mechanism.

*Call graph*: calls 8 internal fn (make_session_and_context, format_inter_agent_completion_message, function_payload, invocation, set_turn_config, thread_manager, root, try_from); 10 external calls (new, from_millis, from_secs, default, assert_eq!, json!, Completed, TurnComplete, sleep, timeout).


##### `multi_agent_v2_followup_task_rejects_legacy_items_field`  (lines 2101–2151)

```
async fn multi_agent_v2_followup_task_rejects_legacy_items_field()
```

**Purpose**: Ensures v2 `followup_task` rejects the legacy `items` field.

**Data flow**: Enables v2, spawns a worker, resolves its ID, invokes `FollowupTaskHandlerV2` with `items`, and asserts the parse error mentions `unknown field `items``.

**Call relations**: Mirrors the send-message parser test for the trigger-turn follow-up tool.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert!, json!, panic!).


##### `multi_agent_v2_interrupted_turn_does_not_notify_parent`  (lines 2154–2228)

```
async fn multi_agent_v2_interrupted_turn_does_not_notify_parent()
```

**Purpose**: Checks that an interrupted child turn does not emit a completion-style notification to the parent.

**Data flow**: Enables v2, spawns a worker, emits a `TurnAbortedEvent` with `TurnAbortReason::Interrupted`, collects root-directed communications from captured ops, and asserts the list is empty.

**Call relations**: Covers the negative case for parent notifications: only completed turns should notify.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert_eq!, json!, TurnAborted).


##### `multi_agent_v2_spawn_omits_agent_id_when_named`  (lines 2231–2267)

```
async fn multi_agent_v2_spawn_omits_agent_id_when_named()
```

**Purpose**: Verifies that named v2 spawns return only `task_name` and omit `agent_id` and nickname.

**Data flow**: Enables v2, starts a root thread, invokes v2 spawn with `task_name`, parses the JSON output, and asserts `agent_id` is absent, `task_name` is canonicalized, `nickname` is absent, and success is true.

**Call relations**: Pins the response shape difference between legacy unnamed spawn and v2 named spawn.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 6 external calls (new, default, assert!, assert_eq!, json!, from_str).


##### `multi_agent_v2_spawn_surfaces_task_name_validation_errors`  (lines 2270–2304)

```
async fn multi_agent_v2_spawn_surfaces_task_name_validation_errors()
```

**Purpose**: Checks that invalid task names are rejected with the underlying validation message.

**Data flow**: Enables v2, starts a root thread, invokes v2 spawn with `task_name: "BadName"`, and asserts the exact lowercase/digits/underscore validation error.

**Call relations**: Exercises task-name validation on the v2 spawn path.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `spawn_agent_reapplies_runtime_sandbox_after_role_config`  (lines 2307–2396)

```
async fn spawn_agent_reapplies_runtime_sandbox_after_role_config()
```

**Purpose**: Verifies that runtime sandbox, approval, reviewer, and permission-profile overrides are re-applied after role config is merged during spawn.

**Data flow**: Builds an expected runtime sandbox and permission profile from the turn, mutates the turn to use those runtime overrides and `AskForApproval::OnRequest`, invokes legacy spawn with `agent_type: explorer`, parses the child ID, inspects the child config snapshot and a fresh child turn, and asserts sandbox policy, approval policy, reviewer, file-system/network sandbox policies, and permission profile all match the runtime values rather than the base config.

**Call relations**: Covers a subtle config-merging invariant: role config must not erase runtime execution constraints.

*Call graph*: calls 11 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, set_turn_config, thread_manager, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd (+1 more)); 7 external calls (new, default, assert!, assert_eq!, assert_ne!, json!, from_str).


##### `spawn_agent_rejects_when_depth_limit_exceeded`  (lines 2399–2428)

```
async fn spawn_agent_rejects_when_depth_limit_exceeded()
```

**Purpose**: Checks that legacy spawn refuses to create a child when the caller is already at the configured maximum depth.

**Data flow**: Creates a manager-backed session, sets `turn.session_source` to a `SubAgent` at `depth = agent_max_depth`, invokes legacy spawn, and asserts the depth-limit error string.

**Call relations**: Exercises depth enforcement on the legacy spawn path.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 6 external calls (new, default, SubAgent, assert_eq!, json!, panic!).


##### `spawn_agent_allows_depth_up_to_configured_max_depth`  (lines 2431–2474)

```
async fn spawn_agent_allows_depth_up_to_configured_max_depth()
```

**Purpose**: Verifies legacy spawn succeeds when the configured max depth is raised above the caller's current depth.

**Data flow**: Increases `config.agent_max_depth`, sets the turn as a sub-agent at the previous default max depth, invokes legacy spawn, parses the JSON result, and asserts a non-empty `agent_id`, non-empty nickname, and success flag.

**Call relations**: Complements the previous test by showing the depth check is configuration-driven.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 7 external calls (new, default, SubAgent, assert!, assert_eq!, json!, from_str).


##### `multi_agent_v2_spawn_agent_ignores_configured_max_depth`  (lines 2477–2528)

```
async fn multi_agent_v2_spawn_agent_ignores_configured_max_depth()
```

**Purpose**: Checks that MultiAgentV2 spawn ignores the legacy max-depth limit when using task-path semantics.

**Data flow**: Sets `agent_max_depth = 1`, enables v2, starts a root thread, marks the caller as `/root/parent` at depth 1, invokes v2 spawn with `task_name: child` and `fork_turns: none`, parses the result, and asserts the returned path is `/root/parent/child` with success.

**Call relations**: Documents the intentional behavioral divergence between legacy and v2 spawning.

*Call graph*: calls 7 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, try_from); 6 external calls (new, default, SubAgent, assert_eq!, json!, from_str).


##### `send_input_rejects_empty_message`  (lines 2531–2546)

```
async fn send_input_rejects_empty_message()
```

**Purpose**: Ensures the legacy `send_input` tool rejects empty messages.

**Data flow**: Builds a `send_input` invocation with an empty `message`, runs `SendInputHandler`, and asserts the empty-message error.

**Call relations**: Covers shared message validation on the legacy direct-input tool.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 4 external calls (new, assert_eq!, json!, panic!).


##### `send_input_rejects_when_message_and_items_are_both_set`  (lines 2549–2570)

```
async fn send_input_rejects_when_message_and_items_are_both_set()
```

**Purpose**: Checks that legacy `send_input` rejects simultaneous `message` and `items` arguments.

**Data flow**: Invokes `SendInputHandler` with both fields present and asserts the mutual-exclusion error string.

**Call relations**: Mirrors the same validation tested for legacy spawn.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 4 external calls (new, assert_eq!, json!, panic!).


##### `send_input_rejects_invalid_id`  (lines 2573–2588)

```
async fn send_input_rejects_invalid_id()
```

**Purpose**: Verifies `send_input` reports malformed target IDs as model-facing parse errors.

**Data flow**: Invokes `SendInputHandler` with `target: not-a-uuid`, captures the error, and asserts the message starts with `invalid agent id not-a-uuid:`.

**Call relations**: Exercises target-ID parsing before any agent lookup occurs.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 4 external calls (new, assert!, json!, panic!).


##### `send_input_reports_missing_agent`  (lines 2591–2609)

```
async fn send_input_reports_missing_agent()
```

**Purpose**: Checks that `send_input` reports a valid-but-unknown target thread ID as missing.

**Data flow**: Installs agent-control, generates a fresh `ThreadId` not present in the manager, invokes `SendInputHandler`, and asserts the `agent with id ... not found` error.

**Call relations**: Covers the lookup failure path after successful ID parsing.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, thread_manager, new); 4 external calls (new, assert_eq!, json!, panic!).


##### `send_input_interrupts_before_prompt`  (lines 2612–2651)

```
async fn send_input_interrupts_before_prompt()
```

**Purpose**: Verifies legacy `send_input` with `interrupt: true` submits an interrupt op before the user-input op.

**Data flow**: Starts a thread, invokes `SendInputHandler` with target ID, message, and `interrupt: true`, then inspects captured ops for that agent and asserts there are exactly two in order: `Op::Interrupt` then `Op::UserInput`; finally shuts the thread down.

**Call relations**: Pins the side-effect ordering of the legacy interrupt-and-send behavior.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 4 external calls (new, assert!, assert_eq!, json!).


##### `send_input_accepts_structured_items`  (lines 2654–2708)

```
async fn send_input_accepts_structured_items()
```

**Purpose**: Checks that legacy `send_input` accepts structured mention/text items and forwards them as `Op::UserInput`.

**Data flow**: Starts a thread, invokes `SendInputHandler` with an `items` array, constructs the expected `Op::UserInput` containing `UserInput::Mention` and `UserInput::Text`, and asserts that exact op was captured for the target thread; then shuts the thread down.

**Call relations**: Exercises the structured-input path that v2 intentionally removed.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 5 external calls (new, default, assert_eq!, json!, vec!).


##### `resume_agent_rejects_invalid_id`  (lines 2711–2726)

```
async fn resume_agent_rejects_invalid_id()
```

**Purpose**: Verifies `resume_agent` rejects malformed thread IDs.

**Data flow**: Invokes `ResumeAgentHandler` with `id: not-a-uuid`, captures the error, and asserts the message prefix.

**Call relations**: Covers resume-target parsing before any persistence or thread restoration logic.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 4 external calls (new, assert!, json!, panic!).


##### `resume_agent_reports_missing_agent`  (lines 2729–2747)

```
async fn resume_agent_reports_missing_agent()
```

**Purpose**: Checks that `resume_agent` reports a valid-but-unknown thread ID as missing.

**Data flow**: Installs agent-control, generates a fresh absent `ThreadId`, invokes `ResumeAgentHandler`, and asserts the `agent with id ... not found` error.

**Call relations**: Exercises the missing-agent branch of resume handling.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, thread_manager, new); 4 external calls (new, assert_eq!, json!, panic!).


##### `resume_agent_noops_for_active_agent`  (lines 2750–2786)

```
async fn resume_agent_noops_for_active_agent()
```

**Purpose**: Verifies resuming an already active agent returns its current status without creating duplicate threads.

**Data flow**: Starts a thread, records its status, invokes `ResumeAgentHandler` on that same ID, parses the JSON result into `resume_agent::ResumeAgentResult`, asserts the status matches the preexisting one and success is true, then checks the manager still has only that one thread.

**Call relations**: Covers the idempotent fast path of resume handling.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 4 external calls (new, assert_eq!, json!, from_str).


##### `resume_agent_restores_closed_agent_and_accepts_send_input`  (lines 2789–2865)

```
async fn resume_agent_restores_closed_agent_and_accepts_send_input()
```

**Purpose**: Tests that a previously materialized but shut-down agent can be resumed and then accepts new input.

**Data flow**: Creates a thread with forked history, shuts it down through agent-control so status becomes `NotFound`, invokes `ResumeAgentHandler`, parses and checks the resumed status, then invokes `SendInputHandler` against the same ID and asserts the returned JSON contains a non-empty `submission_id`; finally shuts the resumed agent down again.

**Call relations**: Exercises persistence-backed restoration followed by normal post-resume interaction.

*Call graph*: calls 7 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager, from_auth_for_testing, from_api_key); 8 external calls (new, assert!, assert_eq!, assert_ne!, json!, Forked, from_str, vec!).


##### `resume_agent_rejects_when_depth_limit_exceeded`  (lines 2868–2897)

```
async fn resume_agent_rejects_when_depth_limit_exceeded()
```

**Purpose**: Checks that resume is blocked when the caller is already at the configured maximum agent depth.

**Data flow**: Sets the turn's session source to a sub-agent at `depth = agent_max_depth`, invokes `ResumeAgentHandler`, and asserts the same depth-limit error used by spawn.

**Call relations**: Shows depth enforcement applies to resume as well as spawn on the legacy surface.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 5 external calls (new, SubAgent, assert_eq!, json!, panic!).


##### `wait_agent_rejects_non_positive_timeout`  (lines 2900–2918)

```
async fn wait_agent_rejects_non_positive_timeout()
```

**Purpose**: Ensures legacy `wait_agent` rejects `timeout_ms <= 0`.

**Data flow**: Invokes `WaitAgentHandler` with one target ID and `timeout_ms: 0`, then asserts the exact validation error.

**Call relations**: Covers timeout validation before any waiting begins.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `wait_agent_rejects_invalid_target`  (lines 2921–2936)

```
async fn wait_agent_rejects_invalid_target()
```

**Purpose**: Checks that legacy `wait_agent` rejects malformed target IDs.

**Data flow**: Invokes `WaitAgentHandler` with `targets: ["invalid"]`, captures the error, and asserts the message prefix.

**Call relations**: Exercises target parsing on the legacy wait path.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert!, json!, panic!).


##### `wait_agent_rejects_empty_targets`  (lines 2939–2954)

```
async fn wait_agent_rejects_empty_targets()
```

**Purpose**: Verifies legacy `wait_agent` requires a non-empty target list.

**Data flow**: Invokes `WaitAgentHandler` with `targets: []` and asserts the `agent ids must be non-empty` error.

**Call relations**: Pins the legacy wait API contract that differs from v2's timeout-only mode.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `multi_agent_v2_wait_agent_accepts_timeout_only_argument`  (lines 2957–3043)

```
async fn multi_agent_v2_wait_agent_accepts_timeout_only_argument()
```

**Purpose**: Checks that v2 `wait_agent` accepts a payload containing only `timeout_ms` and wakes on mailbox activity.

**Data flow**: Enables v2, starts a root thread, spawns a worker, resolves its path, launches `WaitAgentHandlerV2` in a task with only `timeout_ms`, enqueues a mailbox communication from the worker to root, awaits the wait result, parses `wait::WaitAgentResult`, and asserts `message = "Wait completed."`, `timed_out = false`, and no success flag.

**Call relations**: Exercises the core v2 wait behavior driven by mailbox notifications rather than explicit target statuses.

*Call graph*: calls 8 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, root, new); 9 external calls (new, default, new, default, assert_eq!, json!, from_str, spawn, yield_now).


##### `multi_agent_v2_wait_agent_rejects_timeout_below_configured_min`  (lines 3046–3073)

```
async fn multi_agent_v2_wait_agent_rejects_timeout_below_configured_min()
```

**Purpose**: Verifies v2 wait enforces the configured minimum timeout.

**Data flow**: Enables v2, sets min/max/default wait timeouts on config, invokes `WaitAgentHandlerV2` with `timeout_ms` below the minimum, and asserts the exact lower-bound error.

**Call relations**: Covers configurable timeout validation on the v2 wait path.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, set_turn_config); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `multi_agent_v2_wait_agent_accepts_explicit_timeout_at_configured_min`  (lines 3076–3108)

```
async fn multi_agent_v2_wait_agent_accepts_explicit_timeout_at_configured_min()
```

**Purpose**: Checks that v2 wait accepts a timeout exactly equal to the configured minimum and returns a timeout result when nothing happens.

**Data flow**: Configures min/max/default values, invokes `WaitAgentHandlerV2` with `timeout_ms` equal to the minimum, parses the JSON result, and asserts `Wait timed out.` with `timed_out = true` and no success flag.

**Call relations**: Complements the lower-bound rejection test with the inclusive boundary case.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `multi_agent_v2_wait_agent_uses_configured_default_timeout`  (lines 3111–3163)

```
async fn multi_agent_v2_wait_agent_uses_configured_default_timeout()
```

**Purpose**: Verifies that omitting `timeout_ms` causes v2 wait to use the configured default duration.

**Data flow**: Configures a 50 ms default timeout, first wraps a wait call in a 20 ms outer timeout to prove it does not return early, then awaits another call within 1 second, parses the result, and asserts a timeout outcome.

**Call relations**: Tests default-timeout selection rather than explicit timeout parsing.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config); 9 external calls (new, from_millis, from_secs, default, assert!, assert_eq!, json!, from_str, timeout).


##### `multi_agent_v2_wait_agent_allows_zero_configured_timeout`  (lines 3166–3203)

```
async fn multi_agent_v2_wait_agent_allows_zero_configured_timeout()
```

**Purpose**: Checks that a configuration with zero min/max/default timeout is allowed and causes immediate timeout completion.

**Data flow**: Sets all v2 wait timeout config values to zero, invokes `WaitAgentHandlerV2` under an outer 1-second timeout, parses the result, and asserts immediate `Wait timed out.` with `timed_out = true`.

**Call relations**: Covers the edge case where zero is legal because it comes from configuration rather than user input.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config); 7 external calls (new, from_secs, default, assert_eq!, json!, from_str, timeout).


##### `multi_agent_v2_wait_agent_rejects_timeout_above_configured_max`  (lines 3206–3233)

```
async fn multi_agent_v2_wait_agent_rejects_timeout_above_configured_max()
```

**Purpose**: Ensures v2 wait rejects explicit timeouts above the configured maximum.

**Data flow**: Configures min/max/default values, invokes `WaitAgentHandlerV2` with `timeout_ms` above max, and asserts the upper-bound error string.

**Call relations**: Completes the configurable timeout validation matrix for v2 wait.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, set_turn_config); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `multi_agent_v2_wait_agent_accepts_explicit_timeout_at_configured_max`  (lines 3236–3268)

```
async fn multi_agent_v2_wait_agent_accepts_explicit_timeout_at_configured_max()
```

**Purpose**: Checks that v2 wait accepts a timeout exactly equal to the configured maximum.

**Data flow**: Sets min=max=default=1, invokes `WaitAgentHandlerV2` with `timeout_ms: 1`, parses the result, and asserts a normal timeout response.

**Call relations**: Provides the inclusive upper-bound case for v2 wait validation.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `wait_agent_returns_not_found_for_missing_agents`  (lines 3271–3304)

```
async fn wait_agent_returns_not_found_for_missing_agents()
```

**Purpose**: Verifies legacy wait returns `NotFound` statuses for missing target agents instead of timing out.

**Data flow**: Installs agent-control, generates two absent `ThreadId`s, invokes `WaitAgentHandler` with both IDs and a long timeout, parses `wait::WaitAgentResult`, and asserts the `status` map contains both IDs mapped to `AgentStatus::NotFound` with `timed_out = false`.

**Call relations**: Exercises the immediate-final-status path for nonexistent agents on the legacy wait tool.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager, new); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `wait_agent_times_out_when_status_is_not_final`  (lines 3307–3347)

```
async fn wait_agent_times_out_when_status_is_not_final()
```

**Purpose**: Checks that legacy wait times out when the target agent remains in a non-final state.

**Data flow**: Starts a live thread, invokes `WaitAgentHandler` with the minimum timeout, parses the result, and asserts an empty status map with `timed_out = true`; then shuts the thread down.

**Call relations**: Covers the polling/waiting path where no final status arrives before timeout.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `wait_agent_clamps_short_timeouts_to_minimum`  (lines 3350–3385)

```
async fn wait_agent_clamps_short_timeouts_to_minimum()
```

**Purpose**: Verifies legacy wait clamps too-short explicit timeouts up to the minimum rather than returning immediately.

**Data flow**: Starts a live thread, invokes `WaitAgentHandler` with `timeout_ms: 10`, wraps the call in a 50 ms outer timeout, and asserts the outer timeout fires because the handler should still be waiting at the minimum duration; then shuts the thread down.

**Call relations**: Pins the minimum-timeout clamping behavior of the legacy wait implementation.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 6 external calls (new, from_millis, default, assert!, json!, timeout).


##### `wait_agent_returns_final_status_without_timeout`  (lines 3388–3437)

```
async fn wait_agent_returns_final_status_without_timeout()
```

**Purpose**: Checks that legacy wait returns immediately with a final status once the target has already transitioned to shutdown.

**Data flow**: Starts a thread, subscribes to its status, submits `Op::Shutdown`, waits for the status change, invokes `WaitAgentHandler`, parses the result, and asserts the status map contains `Shutdown` with `timed_out = false`.

**Call relations**: Exercises the successful final-status path after an observed lifecycle transition.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 7 external calls (new, from_secs, default, assert_eq!, json!, from_str, timeout).


##### `multi_agent_v2_wait_agent_returns_summary_for_mailbox_activity`  (lines 3440–3527)

```
async fn multi_agent_v2_wait_agent_returns_summary_for_mailbox_activity()
```

**Purpose**: Verifies v2 wait returns a generic completion summary when mailbox activity occurs.

**Data flow**: Enables v2, spawns a worker, resolves its path, starts a wait task, enqueues a root-directed mailbox communication from the worker, awaits the result, parses `wait::WaitAgentResult`, and asserts the generic completion message and `timed_out = false`.

**Call relations**: Confirms that mailbox activity, not child content, is the wake-up signal for v2 wait.

*Call graph*: calls 8 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, root, new); 9 external calls (new, default, new, default, assert_eq!, json!, from_str, spawn, yield_now).


##### `multi_agent_v2_wait_agent_returns_for_already_queued_mail`  (lines 3530–3608)

```
async fn multi_agent_v2_wait_agent_returns_for_already_queued_mail()
```

**Purpose**: Checks that v2 wait returns immediately if relevant mailbox communication is already queued before the wait starts.

**Data flow**: Enables v2, spawns a worker, resolves its path, enqueues mailbox communication first, then invokes `WaitAgentHandlerV2` under a short outer timeout and asserts it completes quickly with the standard completion summary.

**Call relations**: Covers the preexisting-mail fast path of the v2 wait implementation.

*Call graph*: calls 8 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, root, new); 9 external calls (new, from_millis, default, new, default, assert_eq!, json!, from_str, timeout).


##### `multi_agent_v2_wait_agent_wakes_on_any_mailbox_notification`  (lines 3611–3699)

```
async fn multi_agent_v2_wait_agent_wakes_on_any_mailbox_notification()
```

**Purpose**: Verifies that any mailbox notification from any child in the session subtree wakes v2 wait.

**Data flow**: Enables v2, spawns `worker_a` and `worker_b`, resolves `worker_b`'s path, starts a wait task, enqueues a mailbox communication from `worker_b`, then parses and asserts the standard completion summary.

**Call relations**: Shows v2 wait is session-wide rather than tied to a specific target list.

*Call graph*: calls 8 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, root, new); 9 external calls (new, default, new, default, assert_eq!, json!, from_str, spawn, yield_now).


##### `multi_agent_v2_wait_agent_does_not_return_completed_content`  (lines 3702–3788)

```
async fn multi_agent_v2_wait_agent_does_not_return_completed_content()
```

**Purpose**: Ensures v2 wait never includes the child agent's actual mailbox content in its returned summary.

**Data flow**: Enables v2, spawns a worker, starts a wait task, enqueues mailbox communication containing `sensitive child output`, awaits the result, parses the summary JSON, and asserts the returned content does not contain the sensitive string.

**Call relations**: Pins the privacy-preserving design of v2 wait responses.

*Call graph*: calls 8 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, root, new); 10 external calls (new, default, new, default, assert!, assert_eq!, json!, from_str, spawn, yield_now).


##### `multi_agent_v2_interrupt_agent_accepts_task_name_target`  (lines 3791–3895)

```
async fn multi_agent_v2_interrupt_agent_accepts_task_name_target()
```

**Purpose**: Checks that v2 interrupt accepts a task-name target, interrupts only that agent, and leaves descendants resident.

**Data flow**: Enables v2, spawns `/root/worker`, then from the worker session spawns `/root/worker/child`, resolves both IDs, invokes `InterruptAgentHandler` targeting `worker`, parses `InterruptAgentResult`, verifies the worker path still resolves and both threads remain loaded, and inspects captured ops to confirm only the worker received `Op::Interrupt` and neither thread received `Op::Shutdown`.

**Call relations**: Exercises path-based target resolution and non-destructive interrupt semantics in v2.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 7 external calls (new, default, assert!, assert_eq!, assert_ne!, json!, from_str).


##### `multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target`  (lines 3898–4005)

```
async fn multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target()
```

**Purpose**: Verifies v2 interrupt accepts a task-name target even when the child thread is unloaded, and that list-agents then omits that unloaded child.

**Data flow**: Builds a sqlite-backed manager with limited concurrency, enables v2 and sqlite, spawns a worker, removes its live thread from memory and shuts it down, invokes `InterruptAgentHandler` targeting `worker`, parses the result and checks `previous_status = NotFound`, queries the state DB to confirm the spawn edge remains open, then invokes list-agents and asserts only `/root` is listed.

**Call relations**: Covers the persistence-aware interrupt path for unloaded agents and its interaction with list-agents visibility.

*Call graph*: calls 8 internal fn (make_session_and_context, with_models_provider_home_and_state_for_tests, expect_text_output, function_payload, invocation, set_turn_config, default_for_tests, from_api_key); 6 external calls (new, default, assert_eq!, init_state_db, json!, from_str).


##### `multi_agent_v2_interrupt_agent_rejects_root_target_and_id`  (lines 4008–4055)

```
async fn multi_agent_v2_interrupt_agent_rejects_root_target_and_id()
```

**Purpose**: Checks that v2 interrupt rejects both `/root` and the root thread ID as invalid targets.

**Data flow**: Enables v2, starts a root thread, invokes `InterruptAgentHandler` twice—once with target `/root`, once with the root thread ID string—and asserts both return `root is not a spawned agent`.

**Call relations**: Exercises the explicit root-target guard in interrupt handling.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 3 external calls (new, assert_eq!, json!).


##### `multi_agent_v2_interrupt_agent_rejects_self_target_by_id`  (lines 4058–4123)

```
async fn multi_agent_v2_interrupt_agent_rejects_self_target_by_id()
```

**Purpose**: Verifies a child agent cannot interrupt itself by thread ID.

**Data flow**: Enables v2, manually spawns a child worker, switches session/turn context to that child, invokes `InterruptAgentHandler` with the child's own thread ID, and asserts the self-target rejection message.

**Call relations**: Covers one branch of the self-interrupt protection logic.

*Call graph*: calls 6 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager, try_from); 6 external calls (new, SubAgent, assert_eq!, default, json!, vec!).


##### `multi_agent_v2_interrupt_agent_rejects_self_target_by_task_name`  (lines 4126–4191)

```
async fn multi_agent_v2_interrupt_agent_rejects_self_target_by_task_name()
```

**Purpose**: Checks that a child agent also cannot interrupt itself by task path.

**Data flow**: Enables v2, manually spawns a child worker, switches into the child context, invokes `InterruptAgentHandler` with the child's own path string, and asserts the same self-target rejection message.

**Call relations**: Complements the self-target-by-ID test with path-based resolution.

*Call graph*: calls 6 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager, try_from); 6 external calls (new, SubAgent, assert_eq!, default, json!, vec!).


##### `close_agent_submits_shutdown_and_returns_previous_status`  (lines 4194–4230)

```
async fn close_agent_submits_shutdown_and_returns_previous_status()
```

**Purpose**: Verifies `close_agent` submits a shutdown op, returns the prior status, and leaves the agent as `NotFound` afterward.

**Data flow**: Starts a thread, records its status, invokes `CloseAgentHandler`, parses `close_agent::CloseAgentResult`, asserts the previous status and success flag, inspects captured ops for `Op::Shutdown`, and then checks agent-control now reports `NotFound`.

**Call relations**: Exercises the basic close-agent lifecycle transition.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 4 external calls (new, assert_eq!, json!, from_str).


##### `tool_handlers_cascade_close_and_resume_and_keep_explicitly_closed_subtrees_closed`  (lines 4233–4438)

```
async fn tool_handlers_cascade_close_and_resume_and_keep_explicitly_closed_subtrees_closed()
```

**Purpose**: Tests close/resume behavior across a persisted parent-child-grandchild tree, ensuring subtree closes cascade and explicitly closed descendants stay closed when an ancestor is later resumed.

**Data flow**: Creates a sqlite-backed `ThreadManager`, starts a parent thread, spawns a child and grandchild through the spawn handler, closes the child subtree and verifies both child and grandchild become `NotFound`, resumes the child and verifies both reopen, closes the child subtree again, then separately shuts down the parent and resumes it from another operator thread; after parent resume it asserts the parent is live again while the explicitly closed child and grandchild remain `NotFound`, then performs bounded shutdown of all threads.

**Call relations**: This is the broadest persistence/integration test in the file, combining spawn, close, resume, subtree state propagation, and final manager shutdown.

*Call graph*: calls 10 internal fn (make_session_and_context, new, thread_store_from_config, expect_text_output, function_payload, invocation, parse_agent_id, default_for_tests, from_auth_for_testing, from_api_key); 9 external calls (new, from_secs, default, assert_eq!, assert_ne!, empty_extension_registry, init_state_db, json!, from_str).


##### `build_agent_spawn_config_uses_turn_context_values`  (lines 4441–4526)

```
async fn build_agent_spawn_config_uses_turn_context_values()
```

**Purpose**: Verifies `build_agent_spawn_config` copies runtime values from `TurnContext` into the child config, including model, instructions, cwd, sandbox executable, approval policy, and permission profile.

**Data flow**: Defines a local helper to choose an alternate allowed sandbox policy, mutates a test turn with base instructions, developer instructions, compact prompt, shell environment policy, temp cwd, sandbox executable, runtime permission profile, and approval policy, calls `build_agent_spawn_config`, constructs an expected `Config` by cloning and patching `turn.config`, and asserts equality.

**Call relations**: Tests the config-building helper directly rather than through a handler, documenting exactly which turn-time overrides are propagated into spawned agents.

*Call graph*: calls 6 internal fn (make_session_and_context, default, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from); 3 external calls (from, assert_eq!, tempdir).


##### `build_agent_resume_config_clears_base_instructions`  (lines 4529–4564)

```
async fn build_agent_resume_config_clears_base_instructions()
```

**Purpose**: Checks that `build_agent_resume_config` preserves runtime turn settings but clears `base_instructions` when preparing a config for loading an existing agent.

**Data flow**: Starts from a turn whose base config already has `base_instructions`, sets approval policy, calls `build_agent_resume_config`, constructs the expected config by cloning the turn config, clearing `base_instructions`, and copying runtime model/provider/instruction/sandbox fields plus permission profile, then asserts equality.

**Call relations**: Complements the spawn-config test by pinning the one key difference for resume: inherited base instructions are intentionally removed.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (new, assert_eq!).


### `core/src/tools/handlers/request_plugin_install_tests.rs`

`test` · `test execution`

This file is a focused test suite around the request-plugin-install flow implemented elsewhere in the handlers module. The tests create temporary Codex home directories, populate curated marketplace fixtures, and exercise both plugin-manager state and persisted configuration. One group of tests checks completion semantics: a curated plugin suggestion such as `sample@openai-curated` is not considered completed until `PluginsManager::install_plugin` has actually installed it, while IDs ending in `@openai-curated-remote` are treated specially and skip local-installed verification. Another test group validates how elicitation responses are interpreted: only a `Decline` action paired with metadata `{ persist: "always" }` triggers persistent disable behavior.

The persistence tests inspect the resulting `config.toml` on disk after calling `persist_disabled_install_request`. They verify that connector suggestions become `ToolSuggestDisabledTool::connector(...)`, plugin suggestions become `ToolSuggestDisabledTool::plugin(...)`, and preexisting disabled entries are normalized and deduplicated by trimmed ID while preserving unrelated discoverables and plugin disables. The helper `connector_tool` constructs a realistic `DiscoverableTool::Connector(Box<AppInfo>)` with the minimum fields needed by these tests.

Overall, this file documents the edge cases that matter operationally: curated-vs-remote plugin IDs, persistent opt-out semantics, and idempotent config rewriting.

#### Function details

##### `verified_plugin_install_completed_requires_installed_plugin`  (lines 25–58)

```
async fn verified_plugin_install_completed_requires_installed_plugin()
```

**Purpose**: Checks that curated plugin suggestions are only marked complete after the plugin is actually installed. It proves that marketplace presence alone is insufficient.

**Data flow**: The test creates a temporary home directory, derives the curated repo path, writes curated marketplace and feature-config fixtures, loads plugin config, and constructs a `PluginsManager`. It first calls `verified_plugin_install_completed("sample@openai-curated", ...)` expecting `false`, then installs `sample` using a `PluginInstallRequest` pointing at the generated marketplace JSON, reloads config, and expects the verification call to return `true`.

**Call relations**: This test drives the production verification logic under realistic filesystem and plugin-manager conditions. It depends on fixture helpers to create the curated marketplace state and on `PluginsManager::install_plugin` to transition the system into the installed state that the verifier should recognize.

*Call graph*: calls 5 internal fn (new, curated_plugins_repo_path, write_curated_plugin_sha, write_plugins_feature_config, try_from); 4 external calls (assert!, load_plugins_config, write_openai_curated_marketplace, tempdir).


##### `remote_plugin_install_suggestions_skip_core_installed_verification`  (lines 61–69)

```
fn remote_plugin_install_suggestions_skip_core_installed_verification()
```

**Purpose**: Verifies the naming convention used to identify remote curated plugin suggestions. It ensures only the remote suffix triggers the bypass behavior.

**Data flow**: It passes three string IDs into `is_remote_plugin_install_suggestion`: one remote curated ID, one non-remote curated ID, and one unrelated identifier. The assertions expect `true` only for the `@openai-curated-remote` form.

**Call relations**: This test isolates the classification helper used by the install-request flow so that remote suggestions can avoid the stricter local-install completion checks.

*Call graph*: 1 external calls (assert!).


##### `request_plugin_install_response_persists_only_decline_always_mode`  (lines 72–105)

```
fn request_plugin_install_response_persists_only_decline_always_mode()
```

**Purpose**: Confirms that persistent disabling is requested only for a specific elicitation outcome: decline plus `persist=always`. Other actions or metadata values must not persist.

**Data flow**: It constructs several `ElicitationResponse` values with different `action` and `meta` combinations, including `Decline`/`Accept`, `always`/`session`, and `None`. Each is passed to `request_plugin_install_response_requests_persistent_disable`, and the test asserts that only the decline-with-always case returns `true`.

**Call relations**: This test documents the exact gate used before writing a permanent disable entry to config, preventing broader persistence than the UI metadata explicitly requested.

*Call graph*: 1 external calls (assert!).


##### `persist_disabled_install_request_writes_connector_config`  (lines 108–126)

```
async fn persist_disabled_install_request_writes_connector_config()
```

**Purpose**: Checks that declining a connector install suggestion writes the expected connector disable entry into `config.toml`. It validates the on-disk TOML shape, not just in-memory values.

**Data flow**: The test creates a temp home, builds a connector `DiscoverableTool` via `connector_tool`, calls `persist_disabled_install_request`, then reads `CONFIG_TOML_FILE` from disk and parses it as `ConfigToml`. It asserts that `tool_suggest` contains no discoverables and exactly one disabled connector entry for `connector_calendar`.

**Call relations**: This test exercises the persistence path end-to-end: helper-created tool input goes into the production writer, and the resulting file is reparsed to verify compatibility with the config model.

*Call graph*: calls 1 internal fn (connector_tool); 4 external calls (assert_eq!, read_to_string, tempdir, from_str).


##### `persist_disabled_install_request_writes_plugin_config`  (lines 129–155)

```
async fn persist_disabled_install_request_writes_plugin_config()
```

**Purpose**: Checks that declining a plugin install suggestion writes the expected plugin disable entry into `config.toml`. It mirrors the connector case for plugin IDs.

**Data flow**: It creates a temp home, constructs `DiscoverableTool::Plugin(Box<DiscoverablePluginInfo>)` for `slack@openai-curated`, invokes `persist_disabled_install_request`, reads the generated config file, parses it into `ConfigToml`, and asserts that `tool_suggest.disabled_tools` contains exactly `ToolSuggestDisabledTool::plugin("slack@openai-curated")`.

**Call relations**: This test covers the plugin branch of the persistence logic and ensures the writer chooses the correct disabled-tool variant based on the discoverable tool type.

*Call graph*: 7 external calls (new, new, assert_eq!, read_to_string, tempdir, from_str, Plugin).


##### `persist_disabled_install_request_dedupes_existing_disabled_tools`  (lines 158–208)

```
async fn persist_disabled_install_request_dedupes_existing_disabled_tools()
```

**Purpose**: Verifies that persisting a disabled install request normalizes and deduplicates existing disabled-tool entries instead of appending duplicates. It also confirms unrelated discoverables are preserved.

**Data flow**: The test writes a handcrafted TOML config containing one discoverable plugin plus multiple connector disabled entries with whitespace variants, an empty ID, and an unrelated plugin disable. After calling `persist_disabled_install_request` for the same connector, it rereads and parses the file, then asserts that the final config keeps the discoverable, collapses the connector disables to one normalized `connector_calendar`, drops the blank entry, and preserves the plugin disable.

**Call relations**: This test targets the config-rewrite behavior of the persistence function under messy real-world input, proving that the writer performs cleanup rather than blindly extending the list.

*Call graph*: calls 1 internal fn (connector_tool); 5 external calls (assert_eq!, read_to_string, write, tempdir, from_str).


##### `connector_tool`  (lines 210–226)

```
fn connector_tool(id: &str, name: &str) -> DiscoverableTool
```

**Purpose**: Builds a minimal connector-shaped `DiscoverableTool` for tests. It fills required `AppInfo` fields while leaving optional metadata absent.

**Data flow**: It takes `id` and `name` string slices, converts them to owned `String`s, constructs an `AppInfo` with `description`, logos, branding, metadata, labels, and install URL set to `None`, `is_accessible: false`, `is_enabled: true`, and empty plugin-display-name lists, then wraps it in `DiscoverableTool::Connector(Box<_>)`.

**Call relations**: This helper is called by the connector persistence tests to avoid repeating verbose `AppInfo` construction. It supplies the exact tool shape expected by `persist_disabled_install_request`.

*Call graph*: called by 2 (persist_disabled_install_request_dedupes_existing_disabled_tools, persist_disabled_install_request_writes_connector_config); 3 external calls (new, new, Connector).


### `core/src/tools/handlers/request_user_input_spec_tests.rs`

`test` · `test execution`

This test file exercises the companion spec module for `request_user_input`. Two small helpers derive the allowed-mode lists from `codex_features::Features`: one uses defaults only, and the other explicitly enables `Feature::DefaultModeRequestUserInput` before calling `request_user_input_available_modes`. The remaining tests lock down three categories of behavior.

First, `request_user_input_tool_includes_questions_schema` compares the entire generated `ToolSpec` against an inline expected value, including nested `JsonSchema` objects, required fields, descriptions, and the optional `autoResolutionMs` field. Second, the normalization tests verify that `normalize_request_user_input_args` always flips `is_other` to `true`, clamps out-of-range auto-resolution values to the configured min/max, and leaves boundary values unchanged. Third, the mode-policy tests confirm that `request_user_input_unavailable_message` respects the default-mode feature flag and that `request_user_input_tool_description` renders the allowed modes correctly in the final sentence.

Because these assertions compare exact strings and full schema trees, the file protects not just semantics but also the precise model-facing contract and user-visible wording.

#### Function details

##### `default_mode_enabled_available_modes`  (lines 12–16)

```
fn default_mode_enabled_available_modes() -> Vec<ModeKind>
```

**Purpose**: Builds the allowed-mode list for tests when the default-mode feature flag is enabled. It provides a reusable fixture for assertions about feature-gated availability.

**Data flow**: It creates a mutable `Features` with `Features::with_defaults()`, enables `Feature::DefaultModeRequestUserInput`, passes the resulting feature set to `request_user_input_available_modes`, and returns the produced `Vec<ModeKind>`.

**Call relations**: This helper is used by tests that compare availability messages and description text under the feature-enabled configuration.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (request_user_input_available_modes).


##### `default_available_modes`  (lines 18–20)

```
fn default_available_modes() -> Vec<ModeKind>
```

**Purpose**: Builds the allowed-mode list for tests using only default feature settings. It serves as the baseline fixture for mode-availability assertions.

**Data flow**: It creates a default `Features` value with `Features::with_defaults()`, passes it to `request_user_input_available_modes`, and returns the resulting `Vec<ModeKind>`.

**Call relations**: This helper is paired with `default_mode_enabled_available_modes` so tests can compare baseline and feature-enabled behavior without duplicating setup.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (request_user_input_available_modes).


##### `request_user_input_tool_includes_questions_schema`  (lines 23–114)

```
fn request_user_input_tool_includes_questions_schema()
```

**Purpose**: Verifies the exact nested JSON schema emitted for the `request_user_input` tool. It ensures the model sees the intended field names, descriptions, required lists, and strictness settings.

**Data flow**: It calls `create_request_user_input_tool("Ask the user to choose.".to_string())`, constructs the full expected `ToolSpec::Function(ResponsesApiTool { ... })` inline with nested `JsonSchema` values, and compares them using `assert_eq!`.

**Call relations**: This test directly exercises the schema builder and acts as a snapshot-style regression test for any changes to the tool's wire contract.

*Call graph*: 1 external calls (assert_eq!).


##### `normalize_request_user_input_args_clamps_out_of_range_auto_resolution_ms`  (lines 117–156)

```
fn normalize_request_user_input_args_clamps_out_of_range_auto_resolution_ms()
```

**Purpose**: Checks that normalization clamps auto-resolution values outside the supported range and still enables the implicit “Other” option. It covers both below-minimum and above-maximum inputs.

**Data flow**: It constructs a `RequestUserInputArgs` with one question and `auto_resolution_ms` below `MIN_AUTO_RESOLUTION_MS`, calls `normalize_request_user_input_args`, and asserts the result contains `is_other: true` and the minimum value. It repeats the assertion with a cloned args value whose `auto_resolution_ms` is above `MAX_AUTO_RESOLUTION_MS`, expecting the maximum value.

**Call relations**: This test targets the clamping branch of the normalization helper and documents the exact transformed output expected by the handler before session dispatch.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `normalize_request_user_input_args_accepts_auto_resolution_boundaries`  (lines 159–198)

```
fn normalize_request_user_input_args_accepts_auto_resolution_boundaries()
```

**Purpose**: Verifies that normalization preserves auto-resolution values exactly at the configured minimum and maximum. It confirms the clamp is inclusive rather than shifting boundary values.

**Data flow**: It builds a `RequestUserInputArgs` with one question and `auto_resolution_ms` equal to `MIN_AUTO_RESOLUTION_MS`, normalizes it, and asserts the same boundary value is retained while `is_other` becomes `true`. It repeats the check with `MAX_AUTO_RESOLUTION_MS`.

**Call relations**: This complements the out-of-range clamping test by covering the non-clamping boundary cases of the same helper.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `request_user_input_unavailable_messages_respect_default_mode_feature_flag`  (lines 201–228)

```
fn request_user_input_unavailable_messages_respect_default_mode_feature_flag()
```

**Purpose**: Checks that mode-availability messages change correctly when the default-mode feature flag is toggled. It verifies both allowed and disallowed modes by exact string.

**Data flow**: It calls `request_user_input_unavailable_message` with several `ModeKind` values and either `default_available_modes()` or `default_mode_enabled_available_modes()`. The assertions expect `None` for allowed modes and exact `Some(String)` values for disallowed ones such as Default, Execute, and Pair Programming under the baseline configuration.

**Call relations**: This test exercises the availability helper against realistic feature-derived mode lists, ensuring the handler will reject or allow calls consistently with feature flags.

*Call graph*: 1 external calls (assert_eq!).


##### `request_user_input_tool_description_mentions_available_modes`  (lines 231–240)

```
fn request_user_input_tool_description_mentions_available_modes()
```

**Purpose**: Verifies the exact description text generated for the tool under different allowed-mode sets. It ensures the final sentence names the modes in the intended human-readable form.

**Data flow**: It calls `request_user_input_tool_description` with the baseline and feature-enabled mode lists and compares each returned string against the full expected sentence using `assert_eq!`.

**Call relations**: This test covers the interaction between `request_user_input_tool_description` and `format_allowed_modes`, protecting the model-facing wording from accidental drift.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/request_user_input_tests.rs`

`test` · `test execution`

This file has a single async test focused on one important invariant in the `RequestUserInputHandler`: only the root thread may ask the user for input. The test uses `make_session_and_context()` to obtain a realistic session and turn, then mutates `turn.session_source` to `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { ... })` with a fresh parent thread ID and depth 1. It constructs a `ToolInvocation` that looks like a normal function-tool call, including a valid `request_user_input` payload with one question and two options, a cancellation token, a shared `TurnDiffTracker`, and the correct tool name.

The handler is instantiated with `available_modes: Vec::new()`, but the mode list is irrelevant because the sub-agent rejection happens earlier in control flow. After awaiting `.handle(...)`, the test asserts that the result is an error and specifically matches `FunctionCallError::RespondToModel("request_user_input can only be used by the root thread")`. This confirms the handler rejects sub-agent invocations before attempting mode checks, argument parsing, or session-side user prompting.

#### Function details

##### `multi_agent_v2_request_user_input_rejects_subagent_threads`  (lines 15–68)

```
async fn multi_agent_v2_request_user_input_rejects_subagent_threads()
```

**Purpose**: Verifies that the handler rejects `request_user_input` calls originating from a spawned sub-agent thread. It protects the root-thread-only invariant for user prompting.

**Data flow**: The test obtains a session and turn from `make_session_and_context().await`, mutates the turn's `session_source` to a `SubAgentSource::ThreadSpawn`, then builds a `ToolInvocation` containing a valid JSON function payload for `request_user_input`. It invokes `RequestUserInputHandler { available_modes: Vec::new() }.handle(...).await`, pattern-matches the result as `Err`, and asserts the exact `FunctionCallError::RespondToModel` value.

**Call relations**: This test drives `RequestUserInputHandler::handle`/`handle_call` through the early sub-agent guard path. It intentionally supplies otherwise valid input so the failure can only come from the thread-origin check.

*Call graph*: calls 4 internal fn (make_session_and_context, default, new, plain); 8 external calls (new, new, new, SubAgent, assert_eq!, json!, panic!, new).


### `core/src/tools/handlers/shell_spec_tests.rs`

`test` · `test execution`

This test file exercises the schema constructors in `shell_spec.rs` by rebuilding the expected `ToolSpec::Function(ResponsesApiTool)` values inline and comparing them for exact equality. The tests are intentionally concrete: they reconstruct the full `BTreeMap` of parameter schemas, required-field lists, descriptions, and output schemas rather than checking only a few fields. That makes changes to wording, optionality, or `additionalProperties` behavior visible immediately.

Two small helpers support the assertions. `windows_shell_guidance_description` mirrors the production formatting that prefixes the Windows safety block with two newlines, and `has_parameter` serializes a `ToolSpec` to JSON and probes `/parameters/properties/<name>` so tests can verify conditional omission of fields like `shell`. The exec-command tests cover both the default public wrapper and the internal variant that can hide the shell parameter. Additional tests validate the `write_stdin`, `request_permissions`, and `shell_command` specs, including the platform-specific shell-command description branch. Together these tests serve as regression protection for the exact API surface presented to the model and clients.

#### Function details

##### `windows_shell_guidance_description`  (lines 5–7)

```
fn windows_shell_guidance_description() -> String
```

**Purpose**: Builds the expected formatting wrapper used around the Windows safety guidance in test assertions. It ensures tests compare against the same newline-prefixed block shape used by production descriptions.

**Data flow**: It takes no arguments, calls `windows_shell_guidance()`, prefixes the returned text with `\n\n` via `format!`, and returns the resulting `String`.

**Call relations**: This helper is used by `shell_command_tool_matches_expected_spec` to assemble the expected Windows description text without duplicating the formatting logic inline.

*Call graph*: called by 1 (shell_command_tool_matches_expected_spec); 1 external calls (format!).


##### `has_parameter`  (lines 9–14)

```
fn has_parameter(tool: &ToolSpec, parameter_name: &str) -> bool
```

**Purpose**: Checks whether a serialized tool spec contains a named parameter under `parameters.properties`. It is used to verify conditional schema branches without reconstructing the entire expected spec.

**Data flow**: It accepts a `&ToolSpec` and a parameter name, serializes the tool to `serde_json::Value`, computes a JSON Pointer for `/parameters/properties/<parameter_name>`, and returns `true` if that pointer resolves to a value. It panics if serialization fails.

**Call relations**: The helper is used by `exec_command_tool_can_hide_shell_parameter` to confirm that the internal exec-command builder can omit `shell` while still retaining required fields like `cmd`.

*Call graph*: 2 external calls (format!, to_value).


##### `exec_command_tool_matches_expected_spec`  (lines 17–96)

```
fn exec_command_tool_matches_expected_spec()
```

**Purpose**: Asserts that the default `exec_command` spec exactly matches the expected schema, description, and output shape. It covers platform-specific description text and approval-parameter inclusion.

**Data flow**: The test constructs a tool via `create_exec_command_tool`, computes the expected description based on `cfg!(windows)`, builds the expected property map including `cmd`, `workdir`, `shell`, `tty`, `yield_time_ms`, `max_output_tokens`, and `login`, extends it with `create_approval_parameters(false)`, and compares the full `ToolSpec` with `assert_eq!`.

**Call relations**: It directly exercises the public wrapper constructor and indirectly validates the behavior delegated to the internal exec-command builder, approval-parameter helper, and unified output-schema helper.

*Call graph*: calls 3 internal fn (boolean, number, string); 4 external calls (from, assert_eq!, cfg!, format!).


##### `exec_command_tool_can_hide_shell_parameter`  (lines 99–111)

```
fn exec_command_tool_can_hide_shell_parameter()
```

**Purpose**: Verifies the internal exec-command builder’s ability to suppress the `shell` parameter while keeping the rest of the schema intact. This protects a non-default configuration path used by callers that do not want shell selection exposed.

**Data flow**: It calls `create_exec_command_tool_with_environment_id` with `include_shell_parameter = false`, then uses `has_parameter` to assert that `shell` is absent and `cmd` is still present. The test returns no value and fails on assertion failure.

**Call relations**: This test targets the configurable internal constructor rather than the public wrapper, specifically checking the branch controlled by the `include_shell_parameter` argument.

*Call graph*: 1 external calls (assert!).


##### `write_stdin_tool_matches_expected_spec`  (lines 114–161)

```
fn write_stdin_tool_matches_expected_spec()
```

**Purpose**: Checks that the `write_stdin` tool spec exposes the exact continuation-session parameters and shared output schema expected by clients. It guards against accidental drift in polling/write semantics.

**Data flow**: The test creates the tool with `create_write_stdin_tool`, reconstructs the expected property map for `session_id`, `chars`, `yield_time_ms`, and `max_output_tokens`, and compares the full `ToolSpec` against an inline expected `ResponsesApiTool` using `assert_eq!`.

**Call relations**: It directly validates the `create_write_stdin_tool` builder and indirectly confirms reuse of `unified_exec_output_schema`.

*Call graph*: calls 2 internal fn (number, string); 2 external calls (from, assert_eq!).


##### `request_permissions_tool_includes_full_permission_schema`  (lines 164–200)

```
fn request_permissions_tool_includes_full_permission_schema()
```

**Purpose**: Ensures that the permission-request tool embeds the complete nested permission profile schema rather than a simplified placeholder. This protects the contract for filesystem and network permission requests.

**Data flow**: It invokes `create_request_permissions_tool` with a custom description string, builds the expected property map containing `reason`, `environment_id`, and `permissions: permission_profile_schema()`, and compares the resulting `ToolSpec` for exact equality.

**Call relations**: The test exercises the request-permissions spec builder and indirectly validates that it reuses `permission_profile_schema` unchanged.

*Call graph*: calls 1 internal fn (string); 2 external calls (from, assert_eq!).


##### `shell_command_tool_matches_expected_spec`  (lines 203–274)

```
fn shell_command_tool_matches_expected_spec()
```

**Purpose**: Asserts that the `shell_command` tool spec matches the expected parameter schema and platform-specific description text. It covers both the Unix guidance and the Windows PowerShell example block plus safety appendix.

**Data flow**: It creates a tool with `create_shell_command_tool`, computes the expected description using either a raw multiline PowerShell example string plus `windows_shell_guidance_description()` or the non-Windows guidance string, builds the expected property map including `command`, `workdir`, `timeout_ms`, and `login`, extends it with `create_approval_parameters(false)`, and compares the full spec with `assert_eq!`.

**Call relations**: This test directly targets the shell-command spec builder and uses `windows_shell_guidance_description` to mirror the production Windows-description composition path.

*Call graph*: calls 4 internal fn (windows_shell_guidance_description, boolean, number, string); 3 external calls (from, assert_eq!, cfg!).


### `core/src/tools/handlers/shell_tests.rs`

`test` · `test execution`

This file tests the operational side of shell-command handling rather than schema generation. One group of tests verifies that commands produced by `ShellCommandHandler` remain recognizable by `codex_shell_command::is_known_safe_command`, which matters because safety heuristics inspect the final argv form, not just the original user command. The test covers Bash and Zsh unconditionally and PowerShell/Pwsh only when executables are discoverable on the host.

The async parameter-conversion tests build a real session and turn context via `make_session_and_context`, then compare `ShellCommandHandler::to_exec_params` output against values derived from session state: the user shell’s `derive_exec_args`, turn-context path resolution, environment creation through `create_env`, inherited network policy, timeout, sandbox permissions, and justification. Separate tests pin down login-shell policy: explicit `true` is honored when allowed, omitted login defaults to non-login when disallowed, and explicit login is rejected with a user-facing error when config forbids it. The final tests validate hook integration by checking that pre-tool and post-tool payloads preserve the raw `command` argument and use the wire-format `post_tool_use_response` from `FunctionToolOutput`. Together these tests document the exact translation boundary between model-facing shell calls and internal execution/hook machinery.

#### Function details

##### `commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command`  (lines 30–58)

```
fn commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command()
```

**Purpose**: Checks that shell-command argv vectors generated for supported shells still satisfy the external safe-command heuristic when the original command is benign. This prevents the handler’s wrapping logic from accidentally making safe commands look unsafe.

**Data flow**: The test constructs `Shell` values for Bash and Zsh with fixed paths, conditionally discovers PowerShell and Pwsh executables, and for each available shell passes a sample command into `assert_safe`. It produces no return value and fails if any generated argv is not recognized as safe.

**Call relations**: It is the top-level safety-regression test in this file and delegates the actual dual-login/non-login assertions to `assert_safe`. It also depends on executable discovery helpers to decide whether PowerShell variants can be tested on the current machine.

*Call graph*: calls 3 internal fn (assert_safe, try_find_powershell_executable_blocking, try_find_pwsh_executable_blocking); 1 external calls (from).


##### `assert_safe`  (lines 60–67)

```
fn assert_safe(shell: &Shell, command: &str)
```

**Purpose**: Asserts that a given shell produces safe-recognized exec arguments for both login-shell and non-login-shell modes. It is a compact helper to avoid duplicating the same two assertions across shell variants.

**Data flow**: It takes a `&Shell` and a command string, calls `shell.derive_exec_args(command, true)` and `shell.derive_exec_args(command, false)`, feeds both argv vectors into `is_known_safe_command`, and asserts that both results are true.

**Call relations**: This helper is only called by `commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command`, where it encapsulates the repeated safety check for each shell under test.

*Call graph*: called by 1 (commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command); 1 external calls (assert!).


##### `shell_command_handler_to_exec_params_uses_session_shell_and_turn_context`  (lines 70–119)

```
async fn shell_command_handler_to_exec_params_uses_session_shell_and_turn_context()
```

**Purpose**: Verifies that `ShellCommandHandler::to_exec_params` derives execution settings from the active session shell and turn context rather than from ad hoc defaults. It checks the full translation from tool-call parameters into internal exec parameters.

**Data flow**: The test asynchronously obtains a session and turn context, prepares a `ShellCommandToolCallParams` with command, relative workdir, timeout, escalation mode, and justification, computes expected command argv via `session.user_shell().derive_exec_args`, expected cwd via turn-context path resolution, and expected environment via `create_env`. It then calls `to_exec_params` and compares individual fields such as `command`, `cwd`, `env`, `network`, timeout, sandbox permissions, justification, and `arg0`.

**Call relations**: This test directly exercises `ShellCommandHandler::to_exec_params` and uses session/turn fixtures plus `create_env` to derive the expected values from the same contextual sources the handler should use.

*Call graph*: calls 3 internal fn (create_env, make_session_and_context, to_exec_params); 1 external calls (assert_eq!).


##### `shell_command_handler_respects_explicit_login_flag`  (lines 122–147)

```
fn shell_command_handler_respects_explicit_login_flag()
```

**Purpose**: Confirms that the handler’s base-command generation honors an explicit login-shell choice in both directions. It protects against regressions where the handler might silently force one mode.

**Data flow**: It constructs a Bash `Shell`, calls `ShellCommandHandler::base_command` once with `use_login_shell = true` and once with `false`, and compares each result to `shell.derive_exec_args` with the same flag using `assert_eq!`.

**Call relations**: This test targets the lower-level command-building helper `base_command`, isolating login-flag behavior from the broader `to_exec_params` path.

*Call graph*: calls 1 internal fn (base_command); 2 external calls (from, assert_eq!).


##### `shell_command_handler_defaults_to_non_login_when_disallowed`  (lines 150–178)

```
async fn shell_command_handler_defaults_to_non_login_when_disallowed()
```

**Purpose**: Checks that omitted login preference falls back to non-login execution when configuration disallows login shells. This documents the handler’s defaulting behavior under restrictive policy.

**Data flow**: It creates a session and turn context, builds `ShellCommandToolCallParams` with `login: None`, calls `ShellCommandHandler::to_exec_params` with `allow_login_shell = false`, and asserts that the resulting `command` field matches `session.user_shell().derive_exec_args("echo hello", false)`.

**Call relations**: This test exercises the policy branch inside `to_exec_params` where login shells are disabled but the caller did not explicitly request one.

*Call graph*: calls 2 internal fn (make_session_and_context, to_exec_params); 1 external calls (assert_eq!).


##### `shell_command_handler_rejects_login_when_disallowed`  (lines 181–191)

```
fn shell_command_handler_rejects_login_when_disallowed()
```

**Purpose**: Verifies that an explicit request for a login shell is rejected when configuration forbids login-shell execution. The test also checks that the resulting error message is user-facing and descriptive.

**Data flow**: It calls `ShellCommandHandler::resolve_use_login_shell(Some(true), false)`, expects an error, converts that error to a string, and asserts that the message contains `login shell is disabled by config`.

**Call relations**: This is a focused unit test for the login-resolution helper, covering the explicit-error path separately from the broader exec-parameter conversion tests.

*Call graph*: calls 1 internal fn (resolve_use_login_shell); 1 external calls (assert!).


##### `shell_command_pre_tool_use_payload_uses_raw_command`  (lines 194–217)

```
async fn shell_command_pre_tool_use_payload_uses_raw_command()
```

**Purpose**: Ensures that the pre-tool-use hook payload for `shell_command` contains the original raw command string from the tool arguments. This matters for hook consumers that want the exact user-requested command, not a transformed argv.

**Data flow**: The test builds a `ToolPayload::Function` containing JSON arguments with `command`, creates a session and turn fixture, constructs a classic `ShellCommandHandler`, wraps everything in a `ToolInvocation`, and compares `handler.pre_tool_use_payload(...)` to an expected payload with `tool_name: HookToolName::bash()` and `tool_input` equal to the parsed command JSON.

**Call relations**: It exercises the handler’s hook-export path before execution, validating how invocation payloads are translated into registry hook payloads.

*Call graph*: calls 2 internal fn (make_session_and_context, from); 2 external calls (assert_eq!, json!).


##### `build_post_tool_use_payload_uses_tool_output_wire_value`  (lines 220–250)

```
async fn build_post_tool_use_payload_uses_tool_output_wire_value()
```

**Purpose**: Checks that the post-tool-use hook payload uses the tool output’s wire-format response value rather than reconstructing output from text bodies. This preserves the exact response intended for downstream hook consumers.

**Data flow**: The test creates a function payload with a shell command, a `FunctionToolOutput` whose `post_tool_use_response` is `json!("shell output")`, a classic handler, and a full `ToolInvocation`. It then asserts that `post_tool_use_payload` returns a payload containing the hook tool name, the invocation call ID, the original command JSON as `tool_input`, and the wire response JSON as `tool_response`.

**Call relations**: This test covers the handler’s post-execution hook path and complements the pre-tool-use payload test by validating output propagation.

*Call graph*: calls 4 internal fn (make_session_and_context, from, new, plain); 6 external calls (new, new, assert_eq!, json!, new, vec!).


### `core/src/tools/handlers/unified_exec_tests.rs`

`test` · `test execution`

This file is a concentrated regression suite for the unified exec support code. It defines a reusable async helper, `invocation_for_payload`, that creates a realistic `ToolInvocation` with a fresh session/turn pair, cancellation token, diff tracker, tool name, source, and arbitrary payload. The tests then cover three broad areas.

First, command resolution: `get_command` is checked for default-shell behavior, explicit bash/powershell/cmd shell selection, rejection of `login: true` when login shells are disabled, and rejection of explicit `shell` in local `UnifiedExecShellMode::ZshFork`. The powershell test creates a temporary executable path so shell detection follows the same path-based logic as production.

Second, environment shell-mode policy: `shell_mode_for_environment` must preserve the configured mode for local environments but force `UnifiedExecShellMode::Direct` for remote ones created with a websocket URL.

Third, hook payload semantics: `ExecCommandHandler::pre_tool_use_payload` must expose the raw command as Bash input, `WriteStdinHandler::pre_tool_use_payload` must stay silent, and post-hook generation must emit only on terminal completion. The tests distinguish one-shot completion, interactive completion, still-running sessions (`process_id: Some(_)` yields `None`), and `write_stdin` completion where the output's original exec call id and command must be preserved even when multiple parallel sessions complete out of order.

#### Function details

##### `invocation_for_payload`  (lines 24–40)

```
async fn invocation_for_payload(
    tool_name: &str,
    call_id: &str,
    payload: ToolPayload,
) -> ToolInvocation
```

**Purpose**: Builds a realistic `ToolInvocation` fixture for a named tool, call id, and payload using a fresh test session and turn context.

**Data flow**: It takes `tool_name`, `call_id`, and a `ToolPayload`, awaits `make_session_and_context()`, and returns a `ToolInvocation` populated with `session`, `turn`, a new cancellation token, a new `TurnDiffTracker` wrapped in `Arc<Mutex<_>>`, the provided ids, `ToolCallSource::Direct`, and the supplied payload.

**Call relations**: Several post-hook tests call this helper to avoid repeating session/turn setup. It is purely test scaffolding and does not participate in production execution.

*Call graph*: calls 3 internal fn (make_session_and_context, new, plain); called by 5 (exec_command_post_tool_use_payload_skips_running_sessions, exec_command_post_tool_use_payload_uses_output_for_interactive_completion, exec_command_post_tool_use_payload_uses_output_for_noninteractive_one_shot_commands, write_stdin_post_tool_use_payload_keeps_parallel_session_metadata_separate, write_stdin_post_tool_use_payload_uses_original_exec_call_id_and_command_on_completion); 3 external calls (new, new, new).


##### `test_get_command_uses_default_shell_when_unspecified`  (lines 43–62)

```
fn test_get_command_uses_default_shell_when_unspecified() -> anyhow::Result<()>
```

**Purpose**: Checks that `get_command` falls back to the session's default user shell when no explicit `shell` argument is present.

**Data flow**: The test parses JSON containing only `cmd`, asserts `args.shell` is `None`, calls `get_command` with `default_user_shell()` and direct mode, then inspects the returned argv to confirm it has three elements and places the command string in the final slot.

**Call relations**: This test directly exercises the `UnifiedExecShellMode::Direct` branch of `get_command` with no model-provided shell override.

*Call graph*: calls 1 internal fn (default_user_shell); 3 external calls (new, assert!, assert_eq!).


##### `test_get_command_respects_explicit_bash_shell`  (lines 65–89)

```
fn test_get_command_respects_explicit_bash_shell() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicit `/bin/bash` shell path is honored when resolving the command.

**Data flow**: It parses JSON with `cmd` and `shell`, asserts the parsed shell string, calls `get_command`, and checks that the final argv element is the command. It also conditionally verifies PowerShell-style flags if the resolved argv contains `-Command`, covering platform-specific shell derivation behavior.

**Call relations**: This test targets the explicit-shell path inside `get_command` and ensures model-provided shell selection overrides the session shell when direct mode allows it.

*Call graph*: calls 1 internal fn (default_user_shell); 3 external calls (new, assert!, assert_eq!).


##### `test_get_command_respects_explicit_powershell_shell`  (lines 92–125)

```
fn test_get_command_respects_explicit_powershell_shell() -> anyhow::Result<()>
```

**Purpose**: Confirms that a path resembling a PowerShell executable resolves to `ShellType::PowerShell` and produces the expected argv layout.

**Data flow**: It creates a temporary directory and empty powershell executable file, serializes that path into JSON, parses `ExecCommandArgs`, calls `get_command`, then asserts the command string lands at index 2 and the returned `shell_type` is `ShellType::PowerShell`.

**Call relations**: This test exercises shell detection based on a model-provided executable path, validating the path-to-shell mapping used by `get_command`.

*Call graph*: calls 1 internal fn (default_user_shell); 6 external calls (new, assert_eq!, cfg!, json!, write, tempdir).


##### `test_get_command_respects_explicit_cmd_shell`  (lines 128–146)

```
fn test_get_command_respects_explicit_cmd_shell() -> anyhow::Result<()>
```

**Purpose**: Checks that the literal `cmd` shell override is accepted and still places the command string in the expected argv position.

**Data flow**: It parses JSON with `shell: "cmd"`, asserts the parsed shell value, calls `get_command` in direct mode, and verifies `command[2] == "echo hello"`.

**Call relations**: This covers another explicit-shell variant in `get_command`, ensuring Windows-style shell naming is accepted.

*Call graph*: calls 1 internal fn (default_user_shell); 2 external calls (new, assert_eq!).


##### `test_get_command_rejects_explicit_login_when_disallowed`  (lines 149–166)

```
fn test_get_command_rejects_explicit_login_when_disallowed() -> anyhow::Result<()>
```

**Purpose**: Ensures `get_command` rejects `login: true` when configuration forbids login shells.

**Data flow**: It parses JSON with `cmd` and `login: true`, calls `get_command` with `allow_login_shell` set to false, captures the error, and asserts the message mentions that login shells are disabled by config.

**Call relations**: This test covers the early policy-validation branch in `get_command` before any shell resolution occurs.

*Call graph*: calls 1 internal fn (default_user_shell); 2 external calls (new, assert!).


##### `test_get_command_rejects_explicit_shell_in_zsh_fork_mode`  (lines 169–199)

```
fn test_get_command_rejects_explicit_shell_in_zsh_fork_mode() -> anyhow::Result<()>
```

**Purpose**: Verifies that local zsh-fork mode forbids the model from specifying an explicit shell override.

**Data flow**: It parses JSON with both `cmd` and `shell`, constructs a `UnifiedExecShellMode::ZshFork` using absolute test paths, calls `get_command`, expects an error, and asserts the message explains that `shell` is unsupported for local zsh-fork exec.

**Call relations**: This test targets the zsh-fork branch of `get_command`, specifically the guard that rejects `args.shell.is_some()`.

*Call graph*: calls 2 internal fn (default_user_shell, from_absolute_path); 4 external calls (new, assert!, cfg!, ZshFork).


##### `shell_mode_for_environment_uses_direct_mode_for_remote_environments`  (lines 202–231)

```
async fn shell_mode_for_environment_uses_direct_mode_for_remote_environments() -> anyhow::Result<()>
```

**Purpose**: Checks that remote environments force direct shell mode while local environments preserve the configured mode.

**Data flow**: It constructs a zsh-fork shell mode, creates both a local test environment and a remote one with a websocket URL, then asserts `shell_mode_for_environment` returns the original zsh-fork mode for local and `UnifiedExecShellMode::Direct` for remote.

**Call relations**: This test directly validates the environment-policy shim used by `ExecCommandHandler::handle_call` before command resolution.

*Call graph*: calls 3 internal fn (create_for_tests, default_for_tests, from_absolute_path); 3 external calls (assert_eq!, cfg!, ZshFork).


##### `exec_command_pre_tool_use_payload_uses_raw_command`  (lines 234–257)

```
async fn exec_command_pre_tool_use_payload_uses_raw_command()
```

**Purpose**: Verifies that `ExecCommandHandler` emits a Bash pre-hook payload containing the raw `cmd` string.

**Data flow**: It builds a function payload with `cmd`, creates a test session and turn, instantiates `ExecCommandHandler::default()`, and asserts that `pre_tool_use_payload` returns `Some(PreToolUsePayload)` with `tool_name: HookToolName::bash()` and `tool_input: {"command": ...}`.

**Call relations**: This test exercises the hook-facing `CoreToolRuntime` implementation for `exec_command`, specifically the pre-hook path.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 2 external calls (assert_eq!, json!).


##### `exec_command_pre_tool_use_payload_skips_write_stdin`  (lines 260–280)

```
async fn exec_command_pre_tool_use_payload_skips_write_stdin()
```

**Purpose**: Confirms that `WriteStdinHandler` does not emit a pre-hook payload.

**Data flow**: It builds a `write_stdin`-style function payload, creates a test session and turn, instantiates `WriteStdinHandler`, and asserts `pre_tool_use_payload` returns `None`.

**Call relations**: This test documents the design choice that stdin writes are transport for an existing exec session rather than a new Bash tool invocation.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (assert_eq!, json!).


##### `exec_command_post_tool_use_payload_uses_output_for_noninteractive_one_shot_commands`  (lines 283–310)

```
async fn exec_command_post_tool_use_payload_uses_output_for_noninteractive_one_shot_commands()
```

**Purpose**: Checks that a completed noninteractive exec emits a Bash post-hook payload using the output's command and text.

**Data flow**: It constructs an `exec_command` payload with `tty: false`, an `ExecCommandToolOutput` representing completed output (`process_id: None`, `exit_code: Some(0)`, `hook_command: Some(...)`), builds an invocation fixture, and asserts `post_tool_use_payload` returns a `PostToolUsePayload` keyed by the original call id with response text `"three"`.

**Call relations**: This test exercises `ExecCommandHandler::post_tool_use_payload` through the shared `post_unified_exec_tool_use_payload` helper on a terminal one-shot command.

*Call graph*: calls 2 internal fn (default, invocation_for_payload); 3 external calls (assert_eq!, json!, from_millis).


##### `exec_command_post_tool_use_payload_uses_output_for_interactive_completion`  (lines 313–341)

```
async fn exec_command_post_tool_use_payload_uses_output_for_interactive_completion()
```

**Purpose**: Verifies that an interactive exec still emits a post-hook payload once the session has completed.

**Data flow**: It mirrors the previous test but uses `tty: true` in the payload. The completed `ExecCommandToolOutput` again has `process_id: None`, and the assertion expects the same Bash post-hook structure keyed by the exec call id.

**Call relations**: This covers the completion case for interactive sessions, showing that tty mode affects runtime behavior but not final post-hook emission once the process ends.

*Call graph*: calls 2 internal fn (default, invocation_for_payload); 3 external calls (assert_eq!, json!, from_millis).


##### `exec_command_post_tool_use_payload_skips_running_sessions`  (lines 344–363)

```
async fn exec_command_post_tool_use_payload_skips_running_sessions()
```

**Purpose**: Ensures no post-hook payload is emitted while an exec session is still live.

**Data flow**: It creates an `exec_command` payload and an `ExecCommandToolOutput` with `process_id: Some(45)` and no exit code, builds an invocation fixture, and asserts `post_tool_use_payload` returns `None`.

**Call relations**: This test validates the output-side completion check inside the shared post-hook helper path used by `ExecCommandHandler`.

*Call graph*: calls 2 internal fn (default, invocation_for_payload); 3 external calls (assert_eq!, json!, from_millis).


##### `write_stdin_post_tool_use_payload_uses_original_exec_call_id_and_command_on_completion`  (lines 366–398)

```
async fn write_stdin_post_tool_use_payload_uses_original_exec_call_id_and_command_on_completion()
```

**Purpose**: Checks that a final `write_stdin` poll emits the Bash post-hook for the original exec session rather than the `write_stdin` call itself.

**Data flow**: It builds a `write_stdin` payload with empty `chars`, an `ExecCommandToolOutput` whose `event_call_id` and `hook_command` refer to the original exec, creates an invocation fixture for `write_stdin`, and asserts the resulting `PostToolUsePayload` uses `tool_use_id: "exec-call-45"`, the original command, and the final output text.

**Call relations**: This test exercises `WriteStdinHandler::post_tool_use_payload` and demonstrates why it delegates to the shared unified-exec helper instead of using the current invocation metadata.

*Call graph*: calls 1 internal fn (invocation_for_payload); 3 external calls (assert_eq!, json!, from_millis).


##### `write_stdin_post_tool_use_payload_keeps_parallel_session_metadata_separate`  (lines 401–455)

```
async fn write_stdin_post_tool_use_payload_keeps_parallel_session_metadata_separate()
```

**Purpose**: Verifies that post-hook payload generation for concurrent `write_stdin` completions preserves each session's own exec metadata independently.

**Data flow**: It creates one shared `write_stdin` payload, two distinct completed `ExecCommandToolOutput` values (`output_a` and `output_b`) with different `event_call_id`, `chunk_id`, output text, and `hook_command`, then builds separate invocation fixtures and collects the two `post_tool_use_payload` results. The final assertion checks that each payload carries the matching original exec call id and command rather than leaking metadata across sessions.

**Call relations**: This test guards against accidental cross-session state reuse in the shared post-hook helper path used by `WriteStdinHandler`.

*Call graph*: calls 1 internal fn (invocation_for_payload); 3 external calls (assert_eq!, json!, from_millis).


### `core/src/tools/hosted_spec_tests.rs`

`test` · `test execution`

This test module exercises the conversion logic in `hosted_spec.rs` with concrete protocol values and exact equality assertions. It imports the production helpers through `super::*` and constructs realistic `WebSearchConfig` payloads using protocol-layer types such as `WebSearchFilters`, `WebSearchUserLocation`, `WebSearchUserLocationType`, and `WebSearchContextSize`. The expected outputs are compared against `codex_tools` response-facing structs like `ResponsesApiWebSearchFilters` and `ResponsesApiWebSearchUserLocation`, ensuring the `Into` conversions in production code preserve field values exactly.

The first test confirms that image generation simply wraps the requested format string into `ToolSpec::ImageGeneration`. The second is the most comprehensive: it uses `WebSearchMode::Live`, a full config object, and `WebSearchToolType::TextAndImage`, then asserts that the resulting `ToolSpec::WebSearch` contains `external_web_access: Some(true)`, cloned filter and location data, the configured low context size, and the two-element content-type vector. The final test checks the important absence invariant: when mode is `Disabled`, `create_web_search_tool` must return `None` rather than a partially populated tool spec. Together these tests document the intended distinction between “configured search tool” and “no search tool exposed.”

#### Function details

##### `image_generation_tool_matches_expected_spec`  (lines 11–18)

```
fn image_generation_tool_matches_expected_spec()
```

**Purpose**: Checks that image-generation spec creation preserves the requested output format exactly. It serves as a regression test for the simplest hosted-spec constructor.

**Data flow**: Calls `create_image_generation_tool("png")` → compares the returned `ToolSpec` against a literal `ToolSpec::ImageGeneration { output_format: "png".to_string() }` using `assert_eq!` → produces no return value beyond test success/failure.

**Call relations**: This test directly exercises the production helper in isolation. Its only downstream action is the equality assertion that fails the test if the constructor changes shape or ownership semantics.

*Call graph*: 1 external calls (assert_eq!).


##### `web_search_tool_preserves_configured_options`  (lines 21–56)

```
fn web_search_tool_preserves_configured_options()
```

**Purpose**: Verifies that live web-search mode plus a populated `WebSearchConfig` becomes a `ToolSpec::WebSearch` with all fields preserved and converted correctly. It specifically covers filters, user location, context size, and text-plus-image content types.

**Data flow**: Constructs `WebSearchToolOptions` with `web_search_mode: Some(WebSearchMode::Live)`, a borrowed `WebSearchConfig`, and `WebSearchToolType::TextAndImage` → calls `create_web_search_tool(...)` → compares the `Option<ToolSpec>` result to `Some(ToolSpec::WebSearch { ... })` containing the expected converted nested structs and content-type vector.

**Call relations**: This test drives the main branch of the production web-search builder where the tool is emitted. It validates the full translation path, including the nested `Into` conversions that the production function performs before returning.

*Call graph*: 1 external calls (assert_eq!).


##### `web_search_tool_is_absent_when_disabled`  (lines 59–68)

```
fn web_search_tool_is_absent_when_disabled()
```

**Purpose**: Confirms that disabled web-search mode suppresses the tool entirely. This protects the early-return behavior that distinguishes disabled search from an enabled tool with empty options.

**Data flow**: Builds `WebSearchToolOptions` with `web_search_mode: Some(WebSearchMode::Disabled)`, no config, and `WebSearchToolType::Text` → calls `create_web_search_tool(...)` → asserts that the result is `None`.

**Call relations**: This test covers the short-circuit branch in the production function. It ensures callers that assemble hosted tool lists can rely on `None` to mean “do not advertise web search.”

*Call graph*: 1 external calls (assert_eq!).


### Routing, registry, and tool exposure
This group moves from tool result shaping into registry dispatch, router behavior, and the planning logic that determines which tools are exposed.

### `core/src/tools/context_tests.rs`

`test` · `test`

This test file validates the behavior implemented in `context.rs`. Several tests focus on `FunctionToolOutput` and `function_tool_response`: custom payloads must round-trip as `ResponseInputItem::CustomToolCallOutput`, ordinary function payloads must remain `FunctionCallOutput`, and structured content items must preserve images while still deriving plain text from text segments. `ToolSearchOutput` is similarly checked to ensure it serializes as a `ToolSearchOutput` item with `status = "completed"` and `execution = "client"`.

A second cluster of tests covers `McpToolOutput`. They verify that code-mode serialization returns the raw `CallToolResult`, while model-facing response items prepend a wall-time header, preserve content items for image outputs, sanitize image detail defaults, and truncate large structured content instead of leaking oversized payloads. This distinction between raw code-mode JSON and truncated model-facing payloads is one of the file's key invariants.

The remaining tests cover utility behavior: `telemetry_preview` must return short content unchanged, truncate by bytes and by lines with the standard notice, and `ExecCommandToolOutput` must format a response containing chunk id, wall time, exit code, original token count, and a truncation marker when token-limited. Together these tests act as regression coverage for many protocol-shaping edge cases that are easy to break silently.

#### Function details

##### `custom_tool_calls_should_roundtrip_as_custom_outputs`  (lines 9–27)

```
fn custom_tool_calls_should_roundtrip_as_custom_outputs()
```

**Purpose**: Verifies that a `FunctionToolOutput` generated from a custom payload becomes `ResponseInputItem::CustomToolCallOutput` rather than a normal function output. It also checks that a single text item is collapsed into plain text body form.

**Data flow**: Builds `ToolPayload::Custom { input: "patch" }` and `FunctionToolOutput::from_text("patched", Some(true))` → calls `to_response_item("call-42", &payload)` → pattern matches the response and asserts `call_id`, absence of content items, text body, and success flag.

**Call relations**: This test exercises `FunctionToolOutput::from_text` and the downstream response conversion path in `context.rs`. It specifically validates the custom-payload branch inside `function_tool_response`.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (assert_eq!, panic!).


##### `function_payloads_remain_function_outputs`  (lines 30–46)

```
fn function_payloads_remain_function_outputs()
```

**Purpose**: Checks that ordinary function payloads are serialized as `FunctionCallOutput`, not custom outputs. It confirms the payload kind controls the protocol wrapper.

**Data flow**: Creates `ToolPayload::Function { arguments: "{}" }` and a text `FunctionToolOutput` → converts it with `to_response_item("fn-1", &payload)` → matches `ResponseInputItem::FunctionCallOutput` and asserts call id, text body, no content items, and success.

**Call relations**: This test complements the custom-output test by covering the non-custom branch of `function_tool_response`. It uses `FunctionToolOutput::from_text` as the input constructor.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (assert_eq!, panic!).


##### `mcp_code_mode_result_serializes_full_call_tool_result`  (lines 49–86)

```
fn mcp_code_mode_result_serializes_full_call_tool_result()
```

**Purpose**: Ensures MCP code-mode serialization returns the full raw `CallToolResult` structure, including structured content and metadata fields. It guards against accidental reuse of the model-facing truncated/textual payload path.

**Data flow**: Constructs a `CallToolResult` with `content`, `structured_content`, `is_error`, and `meta` → calls `output.code_mode_result(&ToolPayload::Function { ... })` → asserts exact JSON equality with the expected serialized object.

**Call relations**: This test targets `McpToolOutput::code_mode_result` behavior from `context.rs`. It verifies that code mode sees raw serialized MCP data rather than `response_payload()` output.

*Call graph*: 3 external calls (assert_eq!, json!, vec!).


##### `mcp_tool_output_response_item_includes_wall_time`  (lines 89–136)

```
fn mcp_tool_output_response_item_includes_wall_time()
```

**Purpose**: Checks that model-facing MCP response items prepend a wall-time header and serialize content into the output body text. It confirms the visible payload format expected by the model/history layer.

**Data flow**: Builds an `McpToolOutput` with a simple text `CallToolResult`, empty tool input, 1250 ms wall time, and byte truncation policy → calls `to_response_item("mcp-call-1", &ToolPayload::Function { ... })` → matches `FunctionCallOutput`, extracts body text, strips the expected wall-time prefix, parses the remainder as JSON, and asserts the serialized content array.

**Call relations**: This test exercises `McpToolOutput::to_response_item` and, indirectly, `response_payload`. It validates the wall-time header insertion path for text bodies.

*Call graph*: 7 external calls (assert_eq!, json!, panic!, Bytes, from_str, from_millis, vec!).


##### `mcp_tool_output_response_item_truncates_large_structured_content`  (lines 139–179)

```
fn mcp_tool_output_response_item_truncates_large_structured_content()
```

**Purpose**: Verifies that large MCP structured content is truncated in the model-facing response item and that fallback text content is not used when structured content is present. It protects the truncation and content-selection behavior of MCP formatting.

**Data flow**: Creates an `McpToolOutput` whose `CallToolResult` has large `structured_content`, ignored text content, and a small byte truncation policy → converts it to a response item → extracts body text and asserts it starts with the wall-time header, contains a truncation marker, and does not contain the ignored text string.

**Call relations**: This test targets `McpToolOutput::response_payload` via `to_response_item`. It specifically covers the truncation path after payload construction.

*Call graph*: 8 external calls (assert!, assert_eq!, json!, panic!, Bytes, json!, from_millis, vec!).


##### `mcp_tool_output_response_item_preserves_content_items`  (lines 182–232)

```
fn mcp_tool_output_response_item_preserves_content_items()
```

**Purpose**: Ensures that MCP image outputs remain structured content items in the response payload instead of being flattened into JSON text. It also checks that missing image detail is defaulted.

**Data flow**: Builds an `McpToolOutput` with image content, 500 ms wall time, and no original-image-detail support → converts it to a response item → matches `FunctionCallOutput` and asserts `output.content_items()` equals a header text item followed by an `InputImage` item with `detail: Some(DEFAULT_IMAGE_DETAIL)`; also asserts `body.to_text()` only contains the header text.

**Call relations**: This test exercises the content-item branch of `McpToolOutput::response_payload`, including image-detail sanitization/defaulting behavior from the protocol conversion path.

*Call graph*: 6 external calls (assert_eq!, json!, panic!, Bytes, from_millis, vec!).


##### `mcp_tool_output_code_mode_result_stays_raw_call_tool_result`  (lines 235–272)

```
fn mcp_tool_output_code_mode_result_stays_raw_call_tool_result()
```

**Purpose**: Confirms that code-mode MCP results are not truncated even when the model-facing truncation policy is very small. It separates machine-readable runtime output from conversation-history formatting.

**Data flow**: Creates an `McpToolOutput` with large structured content and a tiny byte truncation policy → calls `code_mode_result` → asserts the returned JSON still contains the full large structured content.

**Call relations**: This test directly validates `McpToolOutput::code_mode_result`. It complements the truncation test for `to_response_item` by proving the two paths intentionally diverge.

*Call graph*: 6 external calls (assert_eq!, json!, Bytes, json!, from_millis, vec!).


##### `custom_tool_calls_can_derive_text_from_content_items`  (lines 275–319)

```
fn custom_tool_calls_can_derive_text_from_content_items()
```

**Purpose**: Checks that custom tool outputs built from mixed content items preserve those items while still deriving plain text from text segments. It validates both structured and textual views of the same payload.

**Data flow**: Creates a custom payload and a `FunctionToolOutput::from_content(...)` containing text-image-text items → converts to a response item → matches `CustomToolCallOutput` and asserts call id, exact content items, derived `body.to_text()` of `"line 1\nline 2"`, and success.

**Call relations**: This test exercises `FunctionToolOutput::from_content` and the custom-output branch of `function_tool_response`. It specifically covers mixed content-item handling.

*Call graph*: calls 1 internal fn (from_content); 3 external calls (assert_eq!, panic!, vec!).


##### `tool_search_payloads_roundtrip_as_tool_search_outputs`  (lines 322–372)

```
fn tool_search_payloads_roundtrip_as_tool_search_outputs()
```

**Purpose**: Verifies that tool-search payloads serialize into the dedicated `ToolSearchOutput` protocol item with the expected metadata and serialized tool list. It protects the non-function response path.

**Data flow**: Builds `ToolPayload::ToolSearch` with `SearchToolCallParams`, constructs a `ToolSearchOutput` containing one `LoadableToolSpec::Function`, converts it with `to_response_item("search-1", &payload)`, and asserts the resulting `ToolSearchOutput` fields and serialized tool JSON.

**Call relations**: This test targets `ToolSearchOutput::to_response_item` in `context.rs`. It ensures tool-search results do not accidentally flow through function-output formatting.

*Call graph*: 3 external calls (assert_eq!, panic!, vec!).


##### `log_preview_uses_content_items_when_plain_text_is_missing`  (lines 375–388)

```
fn log_preview_uses_content_items_when_plain_text_is_missing()
```

**Purpose**: Checks that `FunctionToolOutput::log_preview` derives preview text from content items rather than requiring a plain-text body variant. It guards the preview path for structured outputs.

**Data flow**: Creates a `FunctionToolOutput::from_content` with one text content item → calls `log_preview()` and `function_call_output_content_items_to_text(&output.body)` → asserts both yield `"preview"`.

**Call relations**: This test exercises `FunctionToolOutput::from_content` and `FunctionToolOutput::log_preview`. It confirms the preview path uses content-item text extraction.

*Call graph*: calls 1 internal fn (from_content); 2 external calls (assert_eq!, vec!).


##### `telemetry_preview_returns_original_within_limits`  (lines 391–394)

```
fn telemetry_preview_returns_original_within_limits()
```

**Purpose**: Verifies that short content is returned unchanged by `telemetry_preview`. It covers the no-truncation fast path.

**Data flow**: Defines `content = "short output"` → calls `telemetry_preview(content)` → asserts equality with the original string.

**Call relations**: This test directly targets the utility function `telemetry_preview` in `context.rs`. It validates the branch where neither byte nor line limits are exceeded.

*Call graph*: 1 external calls (assert_eq!).


##### `telemetry_preview_truncates_by_bytes`  (lines 397–406)

```
fn telemetry_preview_truncates_by_bytes()
```

**Purpose**: Checks that `telemetry_preview` truncates oversized content by byte limit and appends the standard truncation notice. It protects the UTF-8-safe byte-boundary truncation behavior.

**Data flow**: Creates a string longer than `TELEMETRY_PREVIEW_MAX_BYTES` → calls `telemetry_preview(&content)` → asserts the preview contains `TELEMETRY_PREVIEW_TRUNCATION_NOTICE` and does not exceed the expected bounded length envelope.

**Call relations**: This test directly exercises the byte-truncation branch of `telemetry_preview`.

*Call graph*: 1 external calls (assert!).


##### `telemetry_preview_truncates_by_lines`  (lines 409–420)

```
fn telemetry_preview_truncates_by_lines()
```

**Purpose**: Checks that `telemetry_preview` truncates after the configured maximum number of lines and appends the truncation notice as the final line. It covers the line-count truncation branch independently of byte limits.

**Data flow**: Builds a multi-line string with more than `TELEMETRY_PREVIEW_MAX_LINES` lines → calls `telemetry_preview(&content)` → splits the preview into lines and asserts the line count is bounded and the last line is the truncation notice.

**Call relations**: This test directly targets the line-truncation logic in `telemetry_preview`.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `exec_command_tool_output_formats_truncated_response`  (lines 423–463)

```
fn exec_command_tool_output_formats_truncated_response()
```

**Purpose**: Verifies that exec-command outputs format a structured text response containing metadata and a truncation marker when `max_output_tokens` is small. It protects the human-readable exec summary contract.

**Data flow**: Constructs an `ExecCommandToolOutput` with chunk id, wall time, raw output bytes, token truncation policy, `max_output_tokens = Some(4)`, exit code, and original token count → converts it to a response item → extracts body text and asserts it matches a regex containing chunk id, wall time, exit code, original token count, `Output:`, and a `tokens truncated` marker.

**Call relations**: This test exercises `ExecCommandToolOutput::to_response_item` and, indirectly, `response_text`, `model_output_max_tokens`, and `truncated_output` from `context.rs`.

*Call graph*: 5 external calls (assert_eq!, assert_regex_match, panic!, Tokens, from_millis).


### `core/src/tools/registry_tests.rs`

`test` · `test execution`

This file is a focused test module for the core tool registry and related tool-runtime defaults. It defines two minimal executor implementations: `TestHandler`, which always returns a successful `FunctionToolOutput` containing text `"ok"`, and `LifecycleTestHandler`, which can either return a success payload with a configurable `success` flag or fail with `FunctionCallError::RespondToModel("handler failed")`. Both implement `CoreToolRuntime`, allowing the tests to exercise the same trait-default behavior used by production handlers.

A shared `test_spec` helper constructs a `codex_tools::ToolSpec::Function` with a default JSON schema, so tests can register synthetic tools without unrelated setup. For lifecycle assertions, the file introduces `RecordedToolLifecycle` and `ToolLifecycleRecorder`, which capture `Start` and `Finish` events into an `Arc<Mutex<Vec<_>>>`, explicitly tolerating poisoned mutexes by recovering the inner value.

The tests cover several distinct invariants: registry lookup must distinguish plain and namespaced aliases exactly; default hook payload generation for function tools must parse JSON arguments, normalize empty argument strings to `{}`, and rewrite namespaced `functions.` names into hook-facing names like `functions.echo`; special tools such as `spawn_agent`, code-mode wait, and write-stdin intentionally suppress or normalize default hook payloads; `PostToolUseFeedbackOutput` must preserve typed code-mode results while exposing model-visible text to response conversion; and registry dispatch must notify extension lifecycle contributors on both success and failure, with the finish outcome reflecting either `Completed { success }` or `Failed { handler_executed: true }`. The `test_invocation` helper centralizes construction of realistic `ToolInvocation` values with session, turn, cancellation token, and diff tracker state.

#### Function details

##### `TestHandler::tool_name`  (lines 9–11)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the configured `codex_tools::ToolName` for the synthetic test executor. It gives the registry and hook-default logic a stable identity to inspect.

**Data flow**: Reads `self.tool_name` and clones it, producing an owned `ToolName` return value. It does not mutate handler state or any external state.

**Call relations**: This trait method is invoked wherever the runtime needs the handler’s declared name, including tests that build invocations from a handler-derived tool name and registry logic that compares registered names.

*Call graph*: 1 external calls (clone).


##### `TestHandler::spec`  (lines 13–15)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Builds the test tool’s function specification from the handler’s name. The returned spec is intentionally minimal but structurally valid for registry use.

**Data flow**: Reads `self.tool_name` by reference and passes it to `test_spec`, which constructs a `ToolSpec::Function` with description, non-strict mode, default parameters schema, and no output schema. Returns that spec without side effects.

**Call relations**: Used through the `ToolExecutor` trait when the registry or surrounding tool infrastructure asks the handler for its advertised schema; it delegates all construction details to `test_spec`.

*Call graph*: calls 1 internal fn (test_spec).


##### `TestHandler::handle`  (lines 17–26)

```
fn handle(&self, _invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Implements a trivial successful tool execution for tests. Regardless of invocation contents, it returns a boxed `FunctionToolOutput` containing text `"ok"` and `success = Some(true)`.

**Data flow**: Accepts a `ToolInvocation` but ignores it. It creates an async future that constructs `FunctionToolOutput::from_text("ok", Some(true))`, boxes it as `Box<dyn ToolOutput>`, wraps it in `Ok`, and returns the pinned future.

**Call relations**: This is the execution path used when tests dispatch a `TestHandler` through the registry or inspect generic runtime defaults around function tools. It is the simplest concrete executor in the file and does not delegate further.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (new, pin).


##### `LifecycleTestHandler::tool_name`  (lines 43–45)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the configured tool name for the lifecycle-focused test executor. It allows lifecycle records to include the exact tool identity under test.

**Data flow**: Clones `self.tool_name` and returns the clone. No mutation or external output occurs.

**Call relations**: Called by registry/runtime code that needs the executor’s declared name while dispatching lifecycle test tools.

*Call graph*: 1 external calls (clone).


##### `LifecycleTestHandler::spec`  (lines 47–49)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Produces the same minimal function-tool spec shape used by the simpler test handler. This keeps lifecycle tests focused on dispatch outcomes rather than schema differences.

**Data flow**: Borrows `self.tool_name`, forwards it to `test_spec`, and returns the resulting `ToolSpec`. It does not read or alter `self.result`.

**Call relations**: Invoked through the `ToolExecutor` trait when the lifecycle test handlers are registered or inspected; it delegates spec construction to the shared helper.

*Call graph*: calls 1 internal fn (test_spec).


##### `LifecycleTestHandler::handle`  (lines 51–53)

```
fn handle(&self, _invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Bridges the trait-required async execution entrypoint to the handler’s explicit `handle_call` helper. It exists so tests can vary success and failure behavior while still returning the trait’s boxed future type.

**Data flow**: Accepts a `ToolInvocation` but ignores it, then creates and pins the future returned by `self.handle_call()`. The eventual output is either a boxed `ToolOutput` or a `FunctionCallError`.

**Call relations**: This method is the trait entrypoint used by registry dispatch in `dispatch_notifies_tool_lifecycle_contributors`; it immediately delegates the actual branching logic to `LifecycleTestHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `LifecycleTestHandler::handle_call`  (lines 57–72)

```
async fn handle_call(
        &self,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Implements the lifecycle test handler’s configurable success-or-error behavior. It lets tests verify how dispatch reports both completed and failed tool calls to lifecycle contributors.

**Data flow**: Reads and clones `self.result`, then matches it. For `Ok { success }`, it constructs `FunctionToolOutput::from_text("ok", Some(success))`, boxes it as `dyn ToolOutput`, and returns `Ok(...)`. For `Err`, it returns `Err(FunctionCallError::RespondToModel("handler failed".to_string()))`. No internal state is mutated.

**Call relations**: Called only by `LifecycleTestHandler::handle`. Its two branches are what drive the expected `ToolCallOutcome::Completed { success: false }` and `ToolCallOutcome::Failed { handler_executed: true }` assertions in the lifecycle dispatch test.

*Call graph*: calls 1 internal fn (from_text); called by 1 (handle); 3 external calls (new, clone, RespondToModel).


##### `test_spec`  (lines 77–86)

```
fn test_spec(tool_name: &codex_tools::ToolName) -> codex_tools::ToolSpec
```

**Purpose**: Creates a reusable synthetic function-tool specification for test handlers. It standardizes the schema shape so tests can focus on registry and runtime behavior.

**Data flow**: Consumes a borrowed `ToolName`, copies its `.name` field into a `codex_tools::ResponsesApiTool`, fills fixed values for description, `strict`, `defer_loading`, and `output_schema`, uses `JsonSchema::default()` for parameters, and wraps the result in `ToolSpec::Function`.

**Call relations**: This helper is called by both `TestHandler::spec` and `LifecycleTestHandler::spec`, ensuring all in-file handlers advertise the same kind of tool definition.

*Call graph*: called by 2 (spec, spec); 2 external calls (default, Function).


##### `ToolLifecycleRecorder::on_tool_start`  (lines 106–121)

```
fn on_tool_start(
        &'a self,
        input: codex_extension_api::ToolStartInput<'a>,
    ) -> codex_extension_api::ToolLifecycleFuture<'a>
```

**Purpose**: Records a tool-start lifecycle event into shared test state. It captures the call ID and tool name exactly as provided by the extension API input.

**Data flow**: Reads `input.call_id` and `input.tool_name`, clones the recorder’s `Arc<Mutex<Vec<RecordedToolLifecycle>>>`, constructs `RecordedToolLifecycle::Start`, and returns a pinned async block that locks the mutex and pushes the record. If the mutex is poisoned, it recovers via `PoisonError::into_inner` before pushing.

**Call relations**: Invoked by extension/lifecycle dispatch during tool execution when a start event is emitted. In this file it participates in `dispatch_notifies_tool_lifecycle_contributors`, where the accumulated records are later drained and compared.

*Call graph*: 2 external calls (clone, pin).


##### `ToolLifecycleRecorder::on_tool_finish`  (lines 123–139)

```
fn on_tool_finish(
        &'a self,
        input: codex_extension_api::ToolFinishInput<'a>,
    ) -> codex_extension_api::ToolLifecycleFuture<'a>
```

**Purpose**: Records a tool-finish lifecycle event, including the final `ToolCallOutcome`. It lets the test assert that both successful and failing dispatches emit finish notifications with the correct outcome payload.

**Data flow**: Reads `input.call_id`, `input.tool_name`, and `input.outcome`, clones the shared `Arc<Mutex<Vec<_>>>`, constructs `RecordedToolLifecycle::Finish`, and returns a pinned async block that locks the vector and appends the record, again recovering from poisoned mutexes.

**Call relations**: Called by lifecycle dispatch after a tool completes or fails. In the lifecycle test, its output is paired with `on_tool_start` records to verify exact event ordering and outcome classification.

*Call graph*: 2 external calls (clone, pin).


##### `handler_looks_up_namespaced_aliases_explicitly`  (lines 143–179)

```
fn handler_looks_up_namespaced_aliases_explicitly()
```

**Purpose**: Verifies that `ToolRegistry` treats plain and namespaced tool names as distinct explicit keys. It ensures a missing namespace does not silently fall back to a plain-name handler.

**Data flow**: Builds a plain `ToolName` and a namespaced `ToolName`, wraps separate `TestHandler` instances in `Arc<dyn CoreToolRuntime>`, inserts both into a `HashMap`, and constructs a `ToolRegistry`. It queries the registry for the plain name, the exact namespaced name, and a different namespace, then asserts presence/absence and pointer identity with `Arc::ptr_eq`.

**Call relations**: This standalone unit test directly exercises `ToolRegistry::new` and `ToolRegistry::tool`. It does not dispatch tools; instead it validates lookup semantics before execution ever occurs.

*Call graph*: calls 3 internal fn (new, namespaced, plain); 5 external calls (clone, new, from, assert!, assert_eq!).


##### `function_tools_expose_default_hook_payloads_and_rewrites`  (lines 182–225)

```
async fn function_tools_expose_default_hook_payloads_and_rewrites() -> anyhow::Result<()>
```

**Purpose**: Checks the default hook payload behavior for function tools, including hook-facing tool-name rewriting and argument rewriting. It confirms both pre-tool and post-tool payloads are derived from JSON arguments and model-visible output text.

**Data flow**: Creates a session/turn test context, a namespaced `functions.` tool name, a `TestHandler`, and a `ToolInvocation` whose payload contains JSON arguments `{ "message": "hello" }`. It constructs a `FunctionToolOutput` with text `"echoed"`, asserts that `pre_tool_use_payload` yields `HookToolName("functions.echo")` plus parsed JSON input, and that `post_tool_use_payload` includes the call ID and JSON string response `"echoed"`. It then calls `with_updated_hook_input` with rewritten JSON, destructures the returned invocation’s `ToolPayload::Function { arguments }`, parses the string back to JSON, and asserts the rewritten object is preserved.

**Call relations**: This async test drives trait-default methods on `TestHandler` rather than custom handler logic. It uses `test_invocation` to supply realistic invocation state and validates the runtime’s default hook serialization and rewrite path.

*Call graph*: calls 4 internal fn (make_session_and_context, from_text, test_invocation, namespaced); 4 external calls (new, assert_eq!, panic!, json!).


##### `function_hook_input_defaults_empty_arguments_to_object`  (lines 228–248)

```
async fn function_hook_input_defaults_empty_arguments_to_object()
```

**Purpose**: Verifies that blank function argument strings are normalized to an empty JSON object for hook payload generation. This prevents whitespace-only arguments from surfacing as invalid or absent hook input.

**Data flow**: Creates a session/turn context, a plain `echo` tool name, a `TestHandler`, and a `ToolInvocation` whose function arguments are the whitespace string `"  "`. It calls `pre_tool_use_payload` and asserts the result is `Some(PreToolUsePayload { tool_name: HookToolName("echo"), tool_input: {} })`.

**Call relations**: This test uses `test_invocation` and the default hook-input logic on `CoreToolRuntime` implementations. It isolates the empty-arguments edge case from the richer rewrite test above.

*Call graph*: calls 3 internal fn (make_session_and_context, test_invocation, plain); 2 external calls (new, assert_eq!).


##### `spawn_agent_function_tools_use_agent_matcher_alias`  (lines 251–288)

```
async fn spawn_agent_function_tools_use_agent_matcher_alias()
```

**Purpose**: Ensures both plain and namespaced `spawn_agent` function tools map to the same hook matcher alias. This keeps hook matching stable across alternate tool naming schemes.

**Data flow**: Builds a shared session/turn context, then iterates over two tool names: plain `spawn_agent` and namespaced `MULTI_AGENT_V1_NAMESPACE::spawn_agent`. For each, it creates a `TestHandler`, constructs a `ToolInvocation` with JSON arguments `{ "message": "inspect this repo" }`, calls `pre_tool_use_payload`, collects the results, and asserts both payloads use `HookToolName::spawn_agent()` with identical JSON input.

**Call relations**: This async test exercises the default pre-hook naming logic for a special-case tool alias. It does not dispatch execution; it validates the hook-facing name normalization path.

*Call graph*: calls 3 internal fn (make_session_and_context, namespaced, plain); 2 external calls (new, assert_eq!).


##### `code_mode_wait_does_not_expose_default_hook_payloads`  (lines 291–304)

```
async fn code_mode_wait_does_not_expose_default_hook_payloads()
```

**Purpose**: Confirms that the code-mode wait handler opts out of the generic default hook payload behavior. Both pre-tool and post-tool hook payloads must be absent for this special tool.

**Data flow**: Creates a session/turn context and a sample `FunctionToolOutput` with text `"ok"`. It instantiates `CodeModeWaitHandler`, builds a `ToolInvocation` using the handler’s own tool name, then asserts `pre_tool_use_payload` and `post_tool_use_payload` both return `None`.

**Call relations**: This test targets a production handler type from `crate::tools::handlers`, using `test_invocation` only to supply invocation scaffolding. It verifies that special-case handler overrides suppress the trait defaults.

*Call graph*: calls 3 internal fn (make_session_and_context, from_text, test_invocation); 2 external calls (new, assert_eq!).


##### `write_stdin_does_not_expose_default_pre_tool_use_payload`  (lines 307–319)

```
async fn write_stdin_does_not_expose_default_pre_tool_use_payload()
```

**Purpose**: Checks that the write-stdin handler suppresses the default pre-tool hook payload. This prevents internal terminal-input plumbing from being exposed through generic hook metadata.

**Data flow**: Creates a session/turn context, instantiates `WriteStdinHandler`, builds a `ToolInvocation` with that handler’s tool name, and asserts `pre_tool_use_payload` returns `None`.

**Call relations**: Like the code-mode wait test, this one exercises a concrete production handler’s override behavior using the shared invocation helper, but only for the pre-hook path.

*Call graph*: calls 2 internal fn (make_session_and_context, test_invocation); 2 external calls (new, assert_eq!).


##### `post_tool_use_feedback_output_keeps_code_mode_result_typed`  (lines 322–371)

```
fn post_tool_use_feedback_output_keeps_code_mode_result_typed()
```

**Purpose**: Verifies the dual-view behavior of `PostToolUseFeedbackOutput`: model-visible response conversion should use the feedback text, while code-mode result extraction should preserve the original typed JSON output. This guards against losing structured tool results when hook feedback wraps them.

**Data flow**: Constructs an `AnyToolResult` with `call_id`, function payload, and a boxed `PostToolUseFeedbackOutput` whose `original` is a `JsonToolOutput` containing `{ "typed": true }` and whose `model_visible` is a `FunctionToolOutput` containing text `"hook feedback"`. It first calls `into_response()` and asserts the returned `ResponseInputItem::FunctionCallOutput` contains text payload `"hook feedback"`. It then constructs an equivalent `AnyToolResult` again, calls `code_mode_result()`, and asserts the returned JSON is the original typed object.

**Call relations**: This unit test directly exercises result-conversion behavior rather than registry dispatch. It validates that wrapper outputs preserve separate representations for model-facing and code-mode consumers.

*Call graph*: calls 2 internal fn (from_text, new); 3 external calls (new, assert_eq!, json!).


##### `dispatch_notifies_tool_lifecycle_contributors`  (lines 374–452)

```
async fn dispatch_notifies_tool_lifecycle_contributors() -> anyhow::Result<()>
```

**Purpose**: Tests end-to-end lifecycle notification during registry dispatch for both successful and failing handlers. It proves that extension contributors receive ordered start/finish events and that finish outcomes encode the handler result correctly.

**Data flow**: Creates a mutable session/turn context, allocates a shared `Arc<Mutex<Vec<RecordedToolLifecycle>>>`, registers a `ToolLifecycleRecorder` in an `ExtensionRegistryBuilder`, and installs the built extension registry into `session.services.extensions`. It creates two tool names and corresponding `LifecycleTestHandler` instances: one returning `Ok { success: false }`, one returning `Err`. After building a `ToolRegistry`, it dispatches an invocation for the successful tool and awaits success, then dispatches the failing tool and captures the returned error, asserting its string is `"handler failed"`. Finally it builds the expected start/finish record sequence, drains the recorder vector under the mutex, and asserts exact equality.

**Call relations**: This async test is the file’s most integrated scenario: it uses `test_invocation` to create realistic calls, drives `ToolRegistry::dispatch_any`, and indirectly triggers `ToolLifecycleRecorder::on_tool_start` and `ToolLifecycleRecorder::on_tool_finish` through the extension system.

*Call graph*: calls 4 internal fn (make_session_and_context, new, test_invocation, plain); 9 external calls (clone, new, from, new, assert_eq!, new, panic!, new, vec!).


##### `test_invocation`  (lines 454–474)

```
fn test_invocation(
    session: Arc<crate::session::session::Session>,
    turn: Arc<crate::session::turn_context::TurnContext>,
    call_id: &str,
    tool_name: codex_tools::ToolName,
) -> ToolInvo
```

**Purpose**: Constructs a realistic `ToolInvocation` for tests with all required runtime context populated. It centralizes boilerplate so individual tests can focus on the behavior under inspection.

**Data flow**: Accepts `Arc<Session>`, `Arc<TurnContext>`, a `call_id`, and a `ToolName`. It creates a fresh `CancellationToken`, a new `TurnDiffTracker` wrapped in `tokio::sync::Mutex` and `Arc`, sets `source` to `ToolCallSource::Direct`, and initializes the payload as `ToolPayload::Function { arguments: "{}" }`. It returns the assembled `ToolInvocation`.

**Call relations**: This helper is called by multiple async tests that need a valid invocation object, including hook-payload tests and lifecycle dispatch tests. It does not perform assertions itself; it supplies consistent setup for callers.

*Call graph*: calls 1 internal fn (new); called by 5 (code_mode_wait_does_not_expose_default_hook_payloads, dispatch_notifies_tool_lifecycle_contributors, function_hook_input_defaults_empty_arguments_to_object, function_tools_expose_default_hook_payloads_and_rewrites, write_stdin_does_not_expose_default_pre_tool_use_payload); 3 external calls (new, new, new).


### `core/src/tools/router_tests.rs`

`test` · `request handling tests`

This file is a focused async test module for the tool-routing layer. It builds realistic `ToolRouter` instances from a session/turn created by `make_session_and_context`, then probes how the router interprets tool names, exposes specs to the model, and dispatches calls. Two small test-only types, `ExtensionEchoContributor` and `ExtensionEchoExecutor`, implement the extension API so the tests can register an `extension/echo` tool with a concrete `ToolSpec::Namespace` and a deterministic JSON response. That response includes parsed arguments, the tool call id, and the stored conversation history, which lets the test verify that extension dispatch receives the expected context.

The tests cover several subtle invariants. A plain local tool name that supports parallel execution must not accidentally match an MCP-style namespaced name. Conversely, MCP parallel support is keyed by handler metadata including callable namespace, so two servers exposing the same callable name can differ. Dynamic tools marked `defer_loading: true` are intentionally filtered out of `model_visible_specs`, while non-deferred siblings remain visible. `ToolRouter::build_tool_call` is also checked to ensure `ResponseItem::FunctionCall.namespace` is preserved in the resulting `ToolName`, preventing registry lookup collisions. Helper functions construct synthetic MCP `ToolInfo` records and extract function names from namespace specs for concise assertions.

#### Function details

##### `ExtensionEchoContributor::tools`  (lines 39–45)

```
fn tools(
        &self,
        _session_store: &ExtensionData,
        _thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn ToolExecutor<ExtensionToolCall>>>
```

**Purpose**: Supplies the test extension registry with a single executor instance, `ExtensionEchoExecutor`. It is the contributor hook that makes the synthetic extension tool discoverable during router construction.

**Data flow**: It receives session and thread `ExtensionData` references but ignores both stores. It constructs a one-element `Vec<Arc<dyn ToolExecutor<ExtensionToolCall>>>` containing `ExtensionEchoExecutor` and returns it without mutating external state.

**Call relations**: This method is invoked by the extension registry machinery after `extension_tool_test_registry` registers the contributor. Its only downstream role is to provide the executor that later contributes specs and handles dispatched extension calls in `extension_tool_executors_are_model_visible_and_dispatchable`.

*Call graph*: 1 external calls (vec!).


##### `ExtensionEchoExecutor::tool_name`  (lines 51–53)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Declares the executor's canonical routed name as the namespaced tool `extension/::echo`. This is the identity the router uses to match function calls to the executor.

**Data flow**: It takes no inputs beyond `self`, creates a `ToolName` via the namespaced constructor using namespace `extension/` and function `echo`, and returns that value. No state is read or written.

**Call relations**: The extension execution infrastructure queries this when assembling available extension executors. The returned name must align with the namespace and function emitted by `spec` and with the `ResponseItem::FunctionCall` built in the dispatch test.

*Call graph*: calls 1 internal fn (namespaced).


##### `ExtensionEchoExecutor::spec`  (lines 55–76)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the model-visible schema for the test extension tool as a namespace containing one strict function, `echo`, with a required string `message` parameter. This lets the router expose the extension tool exactly like production tools.

**Data flow**: It reads no mutable state. It constructs a `ToolSpec::Namespace` wrapping a `ResponsesApiNamespace` named `extension/`, fills its description with `default_namespace_description`, defines one `ResponsesApiTool` named `echo`, parses an inline JSON Schema for `{ message: string }`, and returns the completed `ToolSpec`.

**Call relations**: The router consumes this spec when `extension_tool_executors_are_model_visible_and_dispatchable` builds a `ToolRouter` with extension executors. The test later inspects `router.model_visible_specs()` to confirm this exact namespace/function pair is surfaced to the model.

*Call graph*: 3 external calls (default_namespace_description, Namespace, vec!).


##### `ExtensionEchoExecutor::handle`  (lines 78–80)

```
fn handle(&self, call: ExtensionToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the executor's async implementation into the boxed future shape required by the `ToolExecutor` trait. It is the trait entrypoint for executing the extension tool.

**Data flow**: It accepts an `ExtensionToolCall`, forwards it to `handle_call`, boxes and pins the resulting future, and returns that future. It does not itself inspect or modify the call contents.

**Call relations**: The extension dispatch path invokes this trait method when the router routes a matching extension tool call. It immediately delegates all substantive work to `ExtensionEchoExecutor::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ExtensionEchoExecutor::handle_call`  (lines 84–96)

```
async fn handle_call(
        &self,
        call: ExtensionToolCall,
    ) -> Result<Box<dyn codex_tools::ToolOutput>, codex_tools::FunctionCallError>
```

**Purpose**: Implements the test tool's behavior by echoing back parsed arguments, the call id, and the conversation history as JSON. This gives the test a concrete payload to validate router-to-extension data propagation.

**Data flow**: It takes an `ExtensionToolCall`, reads its serialized arguments through `function_arguments()`, parses them into `serde_json::Value`, reads `call.call_id`, and reads `call.conversation_history.items()`. It packages those fields plus `ok: true` into a `codex_tools::JsonToolOutput`, boxes it as `Box<dyn ToolOutput>`, and returns it as `Ok`; malformed test arguments would panic during JSON parsing.

**Call relations**: This async helper is called only by `ExtensionEchoExecutor::handle`. In the end-to-end extension test, the router dispatches the built tool call into this function, and the returned JSON is later converted into a `ResponseInputItem::FunctionCallOutput` for assertion.

*Call graph*: calls 1 internal fn (new); called by 1 (handle); 4 external calls (new, function_arguments, json!, from_str).


##### `extension_tool_test_registry`  (lines 99–103)

```
fn extension_tool_test_registry() -> Arc<ExtensionRegistry<Config>>
```

**Purpose**: Creates a minimal extension registry containing the single echo contributor used by this test module. It isolates extension setup so the main integration test can swap the session's extension registry easily.

**Data flow**: It allocates an `ExtensionRegistryBuilder`, registers an `Arc<ExtensionEchoContributor>` with `tool_contributor`, builds the registry, wraps it in `Arc`, and returns it. No external state is touched.

**Call relations**: This helper is called by `extension_tool_executors_are_model_visible_and_dispatchable` before constructing the router. The resulting registry is assigned into `session.services.extensions`, enabling `extension_tool_executors(&session)` to discover the test executor.

*Call graph*: calls 1 internal fn (new); called by 1 (extension_tool_executors_are_model_visible_and_dispatchable); 1 external calls (new).


##### `parallel_support_does_not_match_namespaced_local_tool_names`  (lines 106–148)

```
async fn parallel_support_does_not_match_namespaced_local_tool_names() -> anyhow::Result<()>
```

**Purpose**: Verifies that parallel-execution support for a plain local shell-like tool does not bleed over to an MCP-style namespaced tool with the same leaf name. The test guards against false-positive parallel eligibility caused by name-only matching.

**Data flow**: It creates a session and turn, loads all MCP tools from the session's MCP connection manager, and builds a `ToolRouter` from the turn context. It searches the candidate plain names `exec_command` and `shell_command` for one that `router.tool_supports_parallel` reports as parallel-capable, then asserts that a `ToolCall` using the same leaf name under namespace `mcp__server__` is not parallel-capable; it returns `Ok(())` on success.

**Call relations**: This is a standalone async test invoked by the test runner. It exercises `ToolRouter::from_turn_context` and `tool_supports_parallel` under realistic session state, but does not delegate to local helpers beyond session setup.

*Call graph*: calls 2 internal fn (make_session_and_context, from_turn_context); 3 external calls (default, new, assert!).


##### `build_tool_call_uses_namespace_for_registry_name`  (lines 151–177)

```
async fn build_tool_call_uses_namespace_for_registry_name() -> anyhow::Result<()>
```

**Purpose**: Checks that `ToolRouter::build_tool_call` preserves the `namespace` field from a `ResponseItem::FunctionCall` when constructing the routed `ToolName`. This prevents collisions between same-named tools from different registries.

**Data flow**: It constructs a `ResponseItem::FunctionCall` with name `create_event`, namespace `mcp__codex_apps__calendar`, empty JSON arguments, and call id `call-namespace`. It passes that item into `ToolRouter::build_tool_call`, unwraps the produced `ToolCall`, then asserts the resulting `tool_name`, `call_id`, and `ToolPayload::Function.arguments` match the source data before returning `Ok(())`.

**Call relations**: This standalone test directly targets the static conversion logic in `ToolRouter::build_tool_call`. It does not involve router dispatch; instead it validates the shape of the intermediate `ToolCall` consumed by later routing stages.

*Call graph*: calls 1 internal fn (build_tool_call); 2 external calls (assert_eq!, panic!).


##### `mcp_parallel_support_uses_handler_data`  (lines 180–226)

```
async fn mcp_parallel_support_uses_handler_data() -> anyhow::Result<()>
```

**Purpose**: Confirms that MCP parallel support is determined from handler metadata tied to both namespace and callable name, not just the callable name alone. Two servers exposing `query_with_delay` are intentionally distinguished.

**Data flow**: It creates a turn, synthesizes two `codex_mcp::ToolInfo` entries via `mcp_tool_info`—one parallel-capable under namespace `mcp__echo__`, one not under `mcp__hello_echo__`—and builds a router with those MCP tools. It then constructs two namespaced `ToolCall` values and asserts that only the call matching the parallel-capable handler returns true from `tool_supports_parallel`; it returns `Ok(())`.

**Call relations**: The test runner invokes this test directly. It relies on `mcp_tool_info` to fabricate precise handler metadata and then probes `ToolRouter::from_turn_context`/`tool_supports_parallel` to ensure the router keys off the full handler identity.

*Call graph*: calls 3 internal fn (make_session_and_context, from_turn_context, namespaced); 4 external calls (default, new, assert!, vec!).


##### `tools_without_handlers_do_not_support_parallel`  (lines 229–252)

```
async fn tools_without_handlers_do_not_support_parallel() -> anyhow::Result<()>
```

**Purpose**: Ensures the router defaults to non-parallel behavior when no handler metadata is available for a tool. This protects against optimistic assumptions for built-in or unresolved tools.

**Data flow**: It creates a turn, builds a `ToolRouter` with `mcp_tools: None`, constructs a plain `ToolCall` for `web_search` with empty JSON arguments, and asserts `tool_supports_parallel` returns false. It produces `Ok(())` if the invariant holds.

**Call relations**: This standalone test covers the negative path of the same parallel-support query exercised elsewhere. Unlike the MCP-specific tests, it intentionally omits handler data to validate the router's fallback behavior.

*Call graph*: calls 2 internal fn (make_session_and_context, from_turn_context); 3 external calls (default, new, assert!).


##### `specs_filter_deferred_dynamic_tools`  (lines 255–304)

```
async fn specs_filter_deferred_dynamic_tools() -> anyhow::Result<()>
```

**Purpose**: Verifies that dynamic tools marked for deferred loading are omitted from the model-visible tool specs, while non-deferred tools in the same namespace remain visible. This checks the router's filtering of discovery-only tools.

**Data flow**: It creates a turn, defines a `Vec<DynamicToolSpec>` containing one namespace `codex_app` with two function specs: `hidden_dynamic_tool` (`defer_loading: true`) and `visible_dynamic_tool` (`defer_loading: false`). After building a router with those dynamic tools, it extracts visible function names for `codex_app` using `namespace_function_names` and asserts the result contains only the visible tool, then returns `Ok(())`.

**Call relations**: The test runner invokes this directly. It drives `ToolRouter::from_turn_context` and `model_visible_specs`, then delegates the assertion-friendly extraction step to `namespace_function_names`.

*Call graph*: calls 2 internal fn (make_session_and_context, from_turn_context); 4 external calls (default, new, assert_eq!, vec!).


##### `mcp_tool_info`  (lines 306–330)

```
fn mcp_tool_info(
    server_name: &str,
    supports_parallel_tool_calls: bool,
    callable_namespace: &str,
    tool_name: &str,
) -> codex_mcp::ToolInfo
```

**Purpose**: Constructs synthetic `codex_mcp::ToolInfo` records for tests that need precise MCP handler metadata. It centralizes the boilerplate for namespace, callable name, and parallel-support flags.

**Data flow**: It accepts `server_name`, `supports_parallel_tool_calls`, `callable_namespace`, and `tool_name` strings/flags. It returns a fully populated `codex_mcp::ToolInfo` with those fields copied into owned strings, a simple RMCP tool schema of `{ "type": "object" }`, and all optional connector/origin metadata left as `None` or empty vectors.

**Call relations**: This helper is called by `mcp_parallel_support_uses_handler_data` to fabricate MCP tool descriptors without needing a live MCP server. The router then consumes the returned `ToolInfo` values as if they came from discovery.

*Call graph*: 5 external calls (new, new, json!, new, object).


##### `extension_tool_executors_are_model_visible_and_dispatchable`  (lines 333–416)

```
async fn extension_tool_executors_are_model_visible_and_dispatchable() -> anyhow::Result<()>
```

**Purpose**: Performs an end-to-end integration test proving that extension-provided executors become visible in router specs and can be dispatched successfully with conversation history attached. It is the most comprehensive test in the file.

**Data flow**: It creates a mutable session and turn, replaces `session.services.extensions` with the registry from `extension_tool_test_registry`, builds a user `ResponseItem::Message`, and records that item into the conversation history for the turn. It then builds a router using `extension_tool_executors(&session)`, asserts `model_visible_specs()` contains namespace `extension/` with function `echo`, constructs a namespaced `ResponseItem::FunctionCall`, converts it with `ToolRouter::build_tool_call`, and dispatches it with session, turn, a fresh `CancellationToken`, and a `TurnDiffTracker` mutex. Finally it converts the result into a `ResponseInputItem`, asserts the `call_id`, parses the text output as JSON, and checks that the echoed arguments, call id, stored history item, and `ok: true` are all present.

**Call relations**: This test is invoked by the test runner and ties together nearly every local helper: it calls `extension_tool_test_registry`, uses `extension_tool_executors(&session)` to obtain executors, and depends on the executor methods (`tool_name`, `spec`, `handle`/`handle_call`) indirectly through router visibility and dispatch. It also exercises `ToolRouter::from_turn_context`, `build_tool_call`, and `dispatch_tool_call_with_code_mode_result` in sequence.

*Call graph*: calls 5 internal fn (make_session_and_context, build_tool_call, from_turn_context, extension_tool_test_registry, new); 12 external calls (new, new, default, assert!, assert_eq!, json!, panic!, from_str, from_ref, extension_tool_executors (+2 more)).


##### `namespace_function_names`  (lines 418–439)

```
fn namespace_function_names(specs: &[ToolSpec], namespace_name: &str) -> Vec<String>
```

**Purpose**: Extracts the function names from a specific namespace within a slice of `ToolSpec` values. It is a small assertion helper for tests that care only about visible function names.

**Data flow**: It takes a borrowed slice of `ToolSpec` and a target namespace name. It iterates through the specs, selects the first `ToolSpec::Namespace` whose `name` matches, maps each contained `ResponsesApiNamespaceTool::Function` to its `name.clone()`, collects those names into a `Vec<String>`, and returns that vector; if no matching namespace exists, it returns an empty vector.

**Call relations**: This helper is called by `specs_filter_deferred_dynamic_tools` to reduce the router's full spec structure to a simple list suitable for equality assertions. It does not participate in production routing logic.

*Call graph*: 1 external calls (iter).


### `core/src/tools/spec_plan_tests.rs`

`test` · `test execution; validates tool planning during router construction`

This test file builds synthetic `TurnContext` instances and feeds them into `ToolRouter::from_turn_context` to inspect the resulting tool plan without executing tools. The central helper types are `ToolPlanInputs`, which packages optional MCP tools, deferred MCP tools, discoverable plugins, extension executors, and dynamic tools, and `ToolPlanProbe`, which snapshots router state into concrete assertions: `visible_specs`, flattened `visible_names`, namespace-to-function listings, registered runtime names, and per-tool `ToolExposure`. The probe extracts namespace contents only from `ToolSpec::Namespace`, intentionally ignoring plain functions, tool search, image generation, web search, and freeform tools.

The setup helpers mutate `TurnContext` in realistic ways: toggling `Feature` flags in both `turn.features` and cloned config, recomputing `multi_agent_version` and `tool_mode`, swapping auth/provider state, changing web-search mode, duplicating environments, and constructing placeholder Zsh-fork config so schema planning can exercise shell-mode branches without packaged binaries. Additional factories create valid and invalid `ToolInfo`, dynamic tool specs, and discoverable plugin entries.

The tests focus on subtle planning invariants: hidden-but-registered legacy shell tools, deferred tools surfacing only through `tool_search`, environment-count-dependent parameters like `environment_id`, code-mode-only suppression of nested tools, provider-specific namespace support, multi-agent v1 versus v2 family selection, encrypted message schemas, cache invalidation for deferred tool search descriptions, and hosted tool gating by auth, provider, model capabilities, and config. Many assertions inspect serialized schemas or freeform descriptions to verify exact planner output rather than just presence.

#### Function details

##### `ToolPlanProbe::from_router`  (lines 58–105)

```
fn from_router(router: ToolRouter) -> Self
```

**Purpose**: Builds a stable inspection snapshot from a `ToolRouter` for assertions. It captures both model-visible tool specs and the broader registered runtime set, including exposure metadata.

**Data flow**: Consumes a `ToolRouter` by value. It reads `model_visible_specs()` to collect `ToolSpec` values, derives `visible_names` from each spec name, extracts namespace member function names from `ToolSpec::Namespace`, reads `registered_tool_names_for_test()`, and queries each registered tool's exposure via `tool_exposure_for_test`. It returns a populated `ToolPlanProbe` containing these derived collections.

**Call relations**: Used by `probe_with` for nearly all tests and directly in `tool_search_cache_rebuilds_when_deferred_sources_change` when the test constructs routers manually. It is the bridge between router internals and the assertion helpers in this file.

*Call graph*: calls 2 internal fn (model_visible_specs, registered_tool_names_for_test); called by 2 (probe_with, tool_search_cache_rebuilds_when_deferred_sources_change).


##### `ToolPlanProbe::assert_visible_contains`  (lines 107–115)

```
fn assert_visible_contains(&self, expected: &[&str])
```

**Purpose**: Asserts that every expected tool name appears in the model-visible tool list. It produces failure messages that include the actual visible names for debugging planner regressions.

**Data flow**: Reads `self.visible_names` and iterates over the `expected` slice of `&str`. For each name it checks membership with `iter().any(...)`; on failure it panics with a message showing the current visible set. It returns no value.

**Call relations**: Called throughout the tests after a probe is built to verify positive visibility cases such as hosted tools, shell tools, multi-agent tools, and plugin-install tools.

*Call graph*: 1 external calls (assert!).


##### `ToolPlanProbe::assert_visible_lacks`  (lines 117–125)

```
fn assert_visible_lacks(&self, expected_absent: &[&str])
```

**Purpose**: Asserts that specified tool names are absent from the model-visible tool list. This is used to verify hidden, deferred, or gated tools stay out of the model-facing plan.

**Data flow**: Reads `self.visible_names` and iterates over `expected_absent`. For each name it checks that no visible entry matches; if one does, it panics with the full visible list. It returns no value.

**Call relations**: Used in negative-path tests where features, provider capabilities, environment count, or code-mode-only behavior should suppress visibility while tools may still be registered.

*Call graph*: 1 external calls (assert!).


##### `ToolPlanProbe::assert_registered_contains`  (lines 127–137)

```
fn assert_registered_contains(&self, expected: &[&str])
```

**Purpose**: Checks that runtime registration includes each expected tool name, regardless of whether the tool is visible to the model. This distinguishes hidden/deferred registration from visibility.

**Data flow**: Reads `self.registered_names` and scans for each string in `expected`. It panics with the registered set if any expected name is missing. It returns no value.

**Call relations**: Frequently paired with visibility assertions to prove planner behavior such as hidden legacy shell runtimes or deferred extension tools that remain callable through search.

*Call graph*: 1 external calls (assert!).


##### `ToolPlanProbe::assert_registered_lacks`  (lines 139–150)

```
fn assert_registered_lacks(&self, expected_absent: &[&str])
```

**Purpose**: Checks that certain tool runtimes were not registered at all. This catches invalid schemas or fully disabled tool families.

**Data flow**: Reads `self.registered_names`, iterates over `expected_absent`, and asserts no registered entry matches each name. It returns no value and panics on mismatch.

**Call relations**: Used where planner should omit runtimes entirely, such as invalid MCP tools or environment-backed tools when no environments exist.

*Call graph*: 1 external calls (assert!).


##### `ToolPlanProbe::namespace_function_names`  (lines 152–156)

```
fn namespace_function_names(&self, namespace: &str) -> &[String]
```

**Purpose**: Returns the visible function names inside a visible namespace tool. Missing namespaces are treated as empty rather than panicking.

**Data flow**: Takes a namespace string, looks it up in `self.namespace_functions`, and returns either the stored `Vec<String>` as a slice or an empty slice literal. It does not mutate state.

**Call relations**: Used by tests that inspect namespaced tool families such as MCP namespaces, dynamic tools, and multi-agent namespaces.


##### `ToolPlanProbe::visible_spec`  (lines 158–163)

```
fn visible_spec(&self, name: &str) -> &ToolSpec
```

**Purpose**: Fetches the exact visible `ToolSpec` by tool name for schema-level assertions. It panics if the named tool is not visible.

**Data flow**: Searches `self.visible_specs` for a spec whose `name()` matches the provided string. On success it returns a shared reference to that `ToolSpec`; on failure it panics with the visible-name list.

**Call relations**: Used when tests need to inspect parameters, descriptions, freeform definitions, or exact `ToolSpec::WebSearch` contents rather than just presence.


##### `ToolPlanProbe::exposure`  (lines 165–170)

```
fn exposure(&self, name: &str) -> ToolExposure
```

**Purpose**: Returns the recorded `ToolExposure` for a registered tool. It is used to verify direct-only, hidden, or deferred exposure semantics.

**Data flow**: Looks up the provided tool name in `self.exposures` and dereferences the stored `ToolExposure` copy. If absent, it panics because the caller expected a registered tool.

**Call relations**: Called by tests that distinguish visibility from exposure, such as direct-model-only `request_user_input`, hidden `shell_command`, and deferred extension or multi-agent tools.


##### `probe_with`  (lines 173–191)

```
async fn probe_with(
    configure_turn: impl FnOnce(&mut TurnContext),
    inputs: ToolPlanInputs,
) -> ToolPlanProbe
```

**Purpose**: Creates a fresh test session/turn, applies caller-provided turn mutations, constructs a `ToolRouter` with supplied synthetic tool inputs, and returns a `ToolPlanProbe` snapshot.

**Data flow**: Starts from `make_session_and_context().await`, mutably passes the `TurnContext` to `configure_turn`, then builds `ToolRouterParams` from `ToolPlanInputs` fields and calls `ToolRouter::from_turn_context` with a default handler cache. The resulting router is converted by `ToolPlanProbe::from_router` and returned.

**Call relations**: This is the main test harness for cases that need injected MCP tools, extension executors, discoverable plugins, or dynamic tools. Many tests call it directly; `probe` wraps it for the common no-extra-input case.

*Call graph*: calls 3 internal fn (make_session_and_context, from_turn_context, from_router); called by 10 (code_mode_only_exposes_code_executor_and_hides_nested_tools, deferred_extension_tools_are_discoverable_with_tool_search, excluded_deferred_namespaces_do_not_enable_nested_tool_guidance, hosted_tools_follow_provider_auth_model_and_config_gates, install_suggestion_tools_stay_visible_without_tool_search, invalid_mcp_tools_are_not_registered, mcp_and_tool_search_follow_direct_and_deferred_tool_exposure, probe, request_plugin_install_description_defers_inventory_to_list_tool, request_plugin_install_requires_all_discovery_features_and_discoverable_tools); 1 external calls (default).


##### `probe`  (lines 193–195)

```
async fn probe(configure_turn: impl FnOnce(&mut TurnContext)) -> ToolPlanProbe
```

**Purpose**: Convenience wrapper around `probe_with` for tests that only need to mutate the turn context and do not inject extra tool sources.

**Data flow**: Accepts a `configure_turn` closure, passes it to `probe_with` together with `ToolPlanInputs::default()`, awaits the result, and returns the resulting `ToolPlanProbe`.

**Call relations**: Used by most tests in this file. It keeps the common path concise while still exercising the same router-construction flow as `probe_with`.

*Call graph*: calls 1 internal fn (probe_with); called by 19 (code_mode_only_can_expose_namespaced_multi_agent_v2_as_normal_tools, environment_count_controls_environment_backed_tools, host_context_gates_agent_job_tools, hosted_tools_follow_provider_auth_model_and_config_gates, mcp_and_tool_search_follow_direct_and_deferred_tool_exposure, multi_agent_feature_selects_one_agent_tool_family, multi_agent_v2_can_use_configured_tool_namespace, multi_agent_v2_message_schemas_are_encrypted, multi_agent_v2_namespace_is_supported_by_bedrock_provider, request_plugin_install_requires_all_discovery_features_and_discoverable_tools (+9 more)); 1 external calls (default).


##### `set_feature`  (lines 197–231)

```
fn set_feature(turn: &mut TurnContext, feature: Feature, enabled: bool)
```

**Purpose**: Synchronizes a feature toggle across both the live `TurnContext` feature set and its cloned config, then recomputes dependent planner state such as multi-agent version and tool mode.

**Data flow**: Takes a mutable `TurnContext`, a `Feature`, and a boolean. It enables or disables the feature on `turn.features`, clones `turn.config`, applies the same change to `config.features`, recomputes `turn.multi_agent_version`, replaces `turn.config` with a new `Arc`, and recalculates `turn.tool_mode` from `model_info.tool_mode` or feature-derived defaults.

**Call relations**: Called by `set_features` and directly by some tests through closures. It encapsulates the otherwise easy-to-miss invariant that planner decisions depend on both runtime feature flags and config-derived state.

*Call graph*: called by 1 (set_features); 1 external calls (new).


##### `set_features`  (lines 233–237)

```
fn set_features(turn: &mut TurnContext, features: &[Feature])
```

**Purpose**: Enables a list of features on a turn by repeatedly applying `set_feature`. It is a small helper for concise test setup.

**Data flow**: Iterates over the provided slice of `Feature` values and calls `set_feature(turn, *feature, true)` for each. It mutates the supplied `TurnContext` in place and returns nothing.

**Call relations**: Used in many tests to establish feature combinations such as code mode, unified exec, plugin discovery, or multi-agent v2.

*Call graph*: calls 1 internal fn (set_feature).


##### `zsh_fork_config_for_spec_plan_tests`  (lines 239–252)

```
fn zsh_fork_config_for_spec_plan_tests() -> codex_tools::ZshForkConfig
```

**Purpose**: Constructs a placeholder `codex_tools::ZshForkConfig` suitable for planner tests that only inspect shell mode selection and never execute the binaries.

**Data flow**: Reads `std::env::current_exe()`, converts it to an absolute path buffer, clones it, and uses the same stable absolute path for both `shell_zsh_path` and `main_execve_wrapper_exe`. It returns the assembled `ZshForkConfig`.

**Call relations**: Used by Zsh-fork unified-exec tests to force the planner down the Zsh-fork branch without depending on packaged artifacts or executable correctness.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (current_exe).


##### `update_config`  (lines 254–258)

```
fn update_config(turn: &mut TurnContext, update: impl FnOnce(&mut crate::config::Config))
```

**Purpose**: Applies an arbitrary mutation to a cloned `crate::config::Config` and writes it back into the turn. It centralizes the clone-and-replace pattern for `Arc<Config>`.

**Data flow**: Clones `*turn.config`, passes the mutable clone to the caller-provided closure, then wraps the updated config in a new `Arc` and stores it back into `turn.config`. It returns nothing.

**Call relations**: Used by `set_web_search_mode`, `use_bedrock_provider`, and many inline test closures to tweak planner-relevant config fields.

*Call graph*: called by 2 (set_web_search_mode, use_bedrock_provider); 1 external calls (new).


##### `set_web_search_mode`  (lines 260–267)

```
fn set_web_search_mode(turn: &mut TurnContext, mode: WebSearchMode)
```

**Purpose**: Sets the configured `WebSearchMode` on the turn's config for planner tests. It ensures the mode is accepted and persisted through `update_config`.

**Data flow**: Receives a mutable `TurnContext` and a `WebSearchMode`, clones and mutates the config via `update_config`, and calls `config.web_search_mode.set(mode)` inside the closure. It returns nothing.

**Call relations**: Used in hosted-tool tests to switch between disabled and live web-search planning paths.

*Call graph*: calls 1 internal fn (update_config).


##### `use_chatgpt_auth`  (lines 269–277)

```
fn use_chatgpt_auth(turn: &mut TurnContext)
```

**Purpose**: Configures the turn to use dummy ChatGPT auth and rebuilds the model provider from that auth. This enables planner branches that require authenticated hosted tools.

**Data flow**: Creates a testing `CodexAuth`, wraps it in an `AuthManager`, stores it in `turn.auth_manager`, then rebuilds `turn.provider` using `create_model_provider` with the existing configured provider info and the new auth manager. It returns nothing.

**Call relations**: Used by hosted-tool tests to satisfy auth requirements for tools like image generation.

*Call graph*: calls 2 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 1 external calls (create_model_provider).


##### `use_bedrock_provider`  (lines 279–286)

```
fn use_bedrock_provider(turn: &mut TurnContext)
```

**Purpose**: Switches the turn to the Amazon Bedrock provider and rebuilds the provider instance. Tests use this to verify provider-specific namespace and hosted-tool behavior.

**Data flow**: Creates a `ModelProviderInfo` for Bedrock, updates config fields `model_provider_id` and `model_provider`, then rebuilds `turn.provider` from that provider info and the current auth manager. It mutates the turn in place.

**Call relations**: Used in tests that verify Bedrock-specific support for namespaced deferred tools and lack of support for hosted web search.

*Call graph*: calls 2 internal fn (update_config, create_amazon_bedrock_provider); 1 external calls (create_model_provider).


##### `WebRunExtensionTool::tool_name`  (lines 291–293)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Declares the extension runtime name as the namespaced tool `web.run`. This lets tests simulate an extension-provided standalone web-search replacement.

**Data flow**: Reads no state and returns `ToolName::namespaced("web", "run")`.

**Call relations**: Consumed by the router when the test injects this executor through `ToolPlanInputs::extension_tool_executors`.

*Call graph*: calls 1 internal fn (namespaced).


##### `WebRunExtensionTool::spec`  (lines 295–308)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Exposes the extension as a namespace spec named `web` containing a single function `run`. The schema is intentionally minimal because tests only care about planner visibility.

**Data flow**: Constructs and returns `ToolSpec::Namespace` with description text, one `ResponsesApiNamespaceTool::Function`, default JSON schema parameters, and no output schema.

**Call relations**: Used by the router during planning to detect that a `web.run` extension exists, which suppresses standalone hosted `web_search` in one test.

*Call graph*: 2 external calls (Namespace, vec!).


##### `WebRunExtensionTool::handle`  (lines 310–314)

```
fn handle(&self, _call: ExtensionToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Implements a no-op successful executor for completeness, returning an empty JSON object. Planner tests should not need to invoke it.

**Data flow**: Ignores the incoming `ExtensionToolCall`, returns a boxed future, and resolves to `Ok(Box<dyn ToolOutput>)` containing `JsonToolOutput` with `{}`.

**Call relations**: Present because `ToolExecutor` requires execution behavior, though this file's tests focus on planning rather than dispatch.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, pin, json!).


##### `DeferredExtensionTool::tool_name`  (lines 320–322)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Declares a plain extension tool named `extension_echo`. Tests use it to verify deferred extension registration and discoverability through tool search.

**Data flow**: Returns `ToolName::plain("extension_echo")` with no side effects.

**Call relations**: Used when injected into `probe_with` as a deferred extension executor.

*Call graph*: calls 1 internal fn (plain).


##### `DeferredExtensionTool::spec`  (lines 324–340)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Defines a strict function tool schema for `extension_echo` with one required string parameter `message`. The schema is concrete enough for planner registration and search indexing.

**Data flow**: Builds and returns `ToolSpec::Function(ResponsesApiTool)` with strict mode enabled, an object schema containing `message: string`, required list `["message"]`, and `additionalProperties: false`.

**Call relations**: Consumed by the router to register the tool and include it in deferred-searchable inventory.

*Call graph*: calls 2 internal fn (object, string); 3 external calls (from, Function, vec!).


##### `DeferredExtensionTool::exposure`  (lines 342–344)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Marks the extension tool as `ToolExposure::Deferred`, meaning it should be registered but not directly visible unless surfaced through search.

**Data flow**: Returns the enum value `ToolExposure::Deferred` without reading or mutating state.

**Call relations**: This exposure is what the corresponding test verifies after router planning.


##### `DeferredExtensionTool::handle`  (lines 346–348)

```
fn handle(&self, _call: ExtensionToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Panics if execution is attempted, enforcing the test assumption that spec planning must not run extension code.

**Data flow**: Ignores the call, returns a boxed future, and that future panics immediately when polled.

**Call relations**: Acts as a guardrail in case planner tests accidentally cross into execution.

*Call graph*: 2 external calls (pin, panic!).


##### `duplicate_primary_environment`  (lines 351–355)

```
fn duplicate_primary_environment(turn: &mut TurnContext)
```

**Purpose**: Adds a second environment to the turn by cloning the primary one and renaming its `environment_id` to `secondary`. This triggers planner branches for multi-environment parameterization.

**Data flow**: Clones `turn.environments.turn_environments[0]`, mutates the clone's `environment_id`, and pushes it back into `turn.environments.turn_environments`. It returns nothing.

**Call relations**: Used by environment-count tests to verify `environment_id` parameters appear when multiple environments are available.


##### `mcp_tool`  (lines 357–378)

```
fn mcp_tool(server: &str, namespace: &str, name: &str) -> ToolInfo
```

**Purpose**: Constructs a valid synthetic `ToolInfo` representing an MCP tool in a namespace on a named server. Tests use it to simulate direct and deferred MCP inventories.

**Data flow**: Takes server, namespace, and callable name strings and returns a `ToolInfo` with namespace description, a JSON-object input schema with no properties and `additionalProperties: false`, and default connector/plugin metadata.

**Call relations**: Used directly in MCP-related tests and as the base constructor for `invalid_mcp_tool`.

*Call graph*: called by 1 (invalid_mcp_tool); 6 external calls (new, new, format!, json!, new, object).


##### `invalid_mcp_tool`  (lines 380–386)

```
fn invalid_mcp_tool(server: &str, namespace: &str, name: &str) -> ToolInfo
```

**Purpose**: Creates an MCP tool whose input schema is intentionally invalid for planner registration. This verifies that malformed MCP tools are filtered out.

**Data flow**: Starts from `mcp_tool(...)`, then replaces `tool.tool.input_schema` with a schema object of type `null`. It returns the modified `ToolInfo`.

**Call relations**: Used only by `invalid_mcp_tools_are_not_registered` to exercise schema validation failure.

*Call graph*: calls 1 internal fn (mcp_tool); 3 external calls (new, json!, object).


##### `dynamic_tool`  (lines 388–411)

```
fn dynamic_tool(namespace: Option<&str>, name: &str, defer_loading: bool) -> DynamicToolSpec
```

**Purpose**: Builds either a plain or namespaced `DynamicToolSpec` with a configurable `defer_loading` flag. Tests use it to model nested dynamic tools and deferred namespaces.

**Data flow**: Creates a `DynamicToolFunctionSpec` with generated description and empty-object input schema, then wraps it either in `DynamicToolSpec::Namespace` with one function or `DynamicToolSpec::Function` depending on whether `namespace` is `Some` or `None`.

**Call relations**: Injected through `ToolPlanInputs::dynamic_tools` in code-mode and deferred-namespace tests.

*Call graph*: 5 external calls (format!, json!, Function, Namespace, vec!).


##### `discoverable_plugin`  (lines 413–424)

```
fn discoverable_plugin(id: &str, name: &str) -> DiscoverableTool
```

**Purpose**: Creates a synthetic discoverable plugin entry from plugin metadata. This feeds planner logic for install-suggestion tools.

**Data flow**: Builds `DiscoverablePluginInfo` with id, name, generated description, and empty MCP/app connector lists, then converts it into `DiscoverableTool` via `.into()`.

**Call relations**: Used by plugin-install tests to provide candidate inventory.

*Call graph*: 2 external calls (new, format!).


##### `has_parameter`  (lines 426–431)

```
fn has_parameter(spec: &ToolSpec, parameter_name: &str) -> bool
```

**Purpose**: Checks whether a serialized `ToolSpec` exposes a named parameter under `/parameters/properties`. It avoids hand-matching every `ToolSpec` variant.

**Data flow**: Serializes the `ToolSpec` to `serde_json::Value`, constructs a JSON Pointer for the parameter name, and returns `true` if that pointer resolves to a value. It does not mutate state.

**Call relations**: Used in shell, exec, and image-view tests to verify planner-added parameters like `shell` and `environment_id`.

*Call graph*: 2 external calls (format!, to_value).


##### `apply_patch_accepts_environment_id`  (lines 433–440)

```
fn apply_patch_accepts_environment_id(spec: &ToolSpec) -> bool
```

**Purpose**: Detects whether the visible freeform `apply_patch` tool mentions `Environment ID` in its format definition. This is how the test verifies multi-environment support for freeform patching.

**Data flow**: Pattern-matches the provided `ToolSpec`; if it is `ToolSpec::Freeform` named `apply_patch`, it searches the format definition string for `Environment ID` and returns that boolean, otherwise returns `false`.

**Call relations**: Used only by the environment-count test to inspect freeform planner output.


##### `request_user_input_tool_respects_experimental_config_gate`  (lines 443–460)

```
async fn request_user_input_tool_respects_experimental_config_gate()
```

**Purpose**: Verifies that `request_user_input` is visible and registered by default, but disappears entirely when `experimental_request_user_input_enabled` is disabled in config.

**Data flow**: Builds one default probe and one probe with config mutation, then asserts visibility, registration, and `ToolExposure::DirectModelOnly` for the enabled case and absence for the disabled case.

**Call relations**: Exercises the planner path for the user-input tool under config gating.

*Call graph*: calls 1 internal fn (probe); 1 external calls (assert_eq!).


##### `request_user_input_stays_direct_in_code_mode_only`  (lines 463–484)

```
async fn request_user_input_stays_direct_in_code_mode_only()
```

**Purpose**: Checks that code-mode-only planning still exposes `request_user_input` directly alongside code-mode entrypoints, and that the code executor description does not absorb that tool's semantics.

**Data flow**: Enables `CodeMode` and `CodeModeOnly`, probes the router, asserts visible names and direct-model-only exposure, then inspects the freeform code exec spec description to ensure it does not mention `request_user_input`.

**Call relations**: Validates coexistence of code-mode wrappers with a separately visible direct tool.

*Call graph*: calls 1 internal fn (probe); 3 external calls (assert!, assert_eq!, panic!).


##### `shell_family_registers_visible_unified_exec_and_hidden_legacy_shell`  (lines 487–500)

```
async fn shell_family_registers_visible_unified_exec_and_hidden_legacy_shell()
```

**Purpose**: Verifies that with shell tooling and unified exec enabled, the planner exposes `exec_command` and `write_stdin` while keeping legacy `shell_command` registered but hidden.

**Data flow**: Mutates features and shell type, probes, then asserts visible and registered sets, checks `shell_command` exposure is `Hidden`, and confirms `exec_command` includes a `shell` parameter.

**Call relations**: Covers the planner's shell-family composition and backward-compatibility registration behavior.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert!, assert_eq!).


##### `shell_zsh_fork_stays_standalone_until_unified_exec_composition_is_enabled`  (lines 503–540)

```
async fn shell_zsh_fork_stays_standalone_until_unified_exec_composition_is_enabled()
```

**Purpose**: Tests the split behavior for Zsh-fork shell mode: standalone `shell_command` until unified-exec composition is enabled, then conditional composition depending on PTY support.

**Data flow**: Builds one probe with `ShellZshFork` enabled but `UnifiedExecZshFork` disabled and another with both enabled. It asserts different visible/registered sets, branching on `codex_utils_pty::conpty_supported()` for the composed case.

**Call relations**: Exercises planner logic that depends on both feature flags and platform PTY capability.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert_eq!, conpty_supported).


##### `zsh_fork_unified_exec_hides_shell_parameter`  (lines 543–565)

```
async fn zsh_fork_unified_exec_hides_shell_parameter()
```

**Purpose**: Ensures that when unified exec is explicitly configured for Zsh-fork on a PTY-capable platform, `exec_command` no longer exposes a `shell` parameter.

**Data flow**: Early-returns if PTY support is absent. Otherwise it enables the relevant features, sets `turn.unified_exec_shell_mode` to `UnifiedExecShellMode::ZshFork(...)`, probes, and asserts `exec_command` lacks the `shell` parameter.

**Call relations**: Checks a schema-level planner refinement specific to local Zsh-fork execution.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert!, conpty_supported).


##### `zsh_fork_unified_exec_keeps_shell_parameter_when_remote_environment_available`  (lines 568–613)

```
async fn zsh_fork_unified_exec_keeps_shell_parameter_when_remote_environment_available()
```

**Purpose**: Verifies that adding a remote environment reintroduces `shell` and `environment_id` parameters on `exec_command` even under Zsh-fork unified exec.

**Data flow**: Skips on unsupported PTY platforms, otherwise configures Zsh-fork unified exec, appends a remote `TurnEnvironment` backed by a test exec-server URL, probes, and asserts both parameters are present.

**Call relations**: Covers the planner branch where remote execution options require explicit environment and shell selection.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert!, conpty_supported).


##### `environment_count_controls_environment_backed_tools`  (lines 616–655)

```
async fn environment_count_controls_environment_backed_tools()
```

**Purpose**: Checks that environment-backed tools disappear when there are no environments and gain `environment_id` support when multiple environments exist.

**Data flow**: Creates one probe with `turn.environments.turn_environments` cleared and another with a duplicated environment plus shell/unified-exec/apply-patch setup. It asserts absence in the first case and visibility plus parameter/format changes in the second.

**Call relations**: Validates planner dependence on environment inventory, not just feature flags.

*Call graph*: calls 1 internal fn (probe); 1 external calls (assert!).


##### `host_context_gates_agent_job_tools`  (lines 658–673)

```
async fn host_context_gates_agent_job_tools()
```

**Purpose**: Verifies that `report_agent_job_result` is only exposed when the session source identifies a worker subagent for an agent job, while `spawn_agents_on_csv` remains available in both contexts.

**Data flow**: Builds a normal probe and a probe whose `session_source` is `SubAgent(Other("agent_job:42"))`, then compares visible tool sets.

**Call relations**: Exercises planner gating based on host/session context rather than config alone.

*Call graph*: calls 1 internal fn (probe).


##### `sleep_tool_follows_feature_gate`  (lines 676–688)

```
async fn sleep_tool_follows_feature_gate()
```

**Purpose**: Confirms that the `sleep` tool is purely feature-gated. Disabled feature means no visible tool; enabled feature means visible tool.

**Data flow**: Builds one probe with `Feature::SleepTool` disabled and one with it enabled, then asserts visibility accordingly.

**Call relations**: A straightforward feature-gate regression test.

*Call graph*: calls 1 internal fn (probe).


##### `mcp_and_tool_search_follow_direct_and_deferred_tool_exposure`  (lines 691–764)

```
async fn mcp_and_tool_search_follow_direct_and_deferred_tool_exposure()
```

**Purpose**: Tests direct MCP visibility, deferred MCP discoverability through `tool_search`, and the additional gating imposed by model capability, feature state, and provider namespace support.

**Data flow**: Constructs several probes with combinations of direct MCP tools, deferred MCP tools, `supports_search_tool`, disabled collaboration, and Bedrock provider selection. It asserts visible namespaces, resource helper tools, `tool_search` presence or absence, and registration of deferred namespaced runtimes.

**Call relations**: This is the main integration-style test for MCP planning and deferred-search behavior.

*Call graph*: calls 3 internal fn (probe, probe_with, namespaced); 3 external calls (assert_eq!, default, vec!).


##### `deferred_extension_tools_are_discoverable_with_tool_search`  (lines 767–783)

```
async fn deferred_extension_tools_are_discoverable_with_tool_search()
```

**Purpose**: Verifies that a deferred extension executor is registered and searchable but not directly visible when the model supports tool search.

**Data flow**: Injects `DeferredExtensionTool` through `probe_with`, enables `supports_search_tool`, then asserts visible `tool_search`, hidden `extension_echo`, registered runtime presence, and `ToolExposure::Deferred`.

**Call relations**: Complements the deferred MCP test with the extension-tool source path.

*Call graph*: calls 1 internal fn (probe_with); 3 external calls (assert_eq!, default, vec!).


##### `tool_search_cache_rebuilds_when_deferred_sources_change`  (lines 786–838)

```
async fn tool_search_cache_rebuilds_when_deferred_sources_change()
```

**Purpose**: Ensures `ToolSearchHandlerCache` does not stale-cache deferred inventory descriptions across turns with different deferred MCP sources.

**Data flow**: Creates a shared cache, builds two separate sessions/turns with different deferred MCP namespaces, constructs routers manually, converts them to probes, extracts the `ToolSpec::ToolSearch` descriptions, and asserts each description mentions only its own server inventory.

**Call relations**: Directly exercises router construction with a reused cache to verify cache invalidation/rebuild semantics.

*Call graph*: calls 3 internal fn (make_session_and_context, from_turn_context, from_router); 5 external calls (new, assert!, default, panic!, vec!).


##### `invalid_mcp_tools_are_not_registered`  (lines 841–853)

```
async fn invalid_mcp_tools_are_not_registered()
```

**Purpose**: Checks that MCP tools with invalid input schemas are filtered out before registration and visibility.

**Data flow**: Injects one `invalid_mcp_tool` via `probe_with`, then asserts the namespace is not visible and the namespaced runtime name is absent from registration.

**Call relations**: Targets planner validation of MCP schemas.

*Call graph*: calls 2 internal fn (probe_with, namespaced); 2 external calls (default, vec!).


##### `request_plugin_install_requires_all_discovery_features_and_discoverable_tools`  (lines 856–908)

```
async fn request_plugin_install_requires_all_discovery_features_and_discoverable_tools()
```

**Purpose**: Verifies that plugin-install suggestion tools appear only when all three discovery features are enabled and there is at least one discoverable tool candidate.

**Data flow**: Loops over each feature to disable it in turn while keeping the others enabled, probing each case and asserting absence. It then probes with no candidates and finally with candidates plus all features enabled, asserting visibility only in the final case.

**Call relations**: Covers the conjunction of feature gates and inventory presence for plugin-install tooling.

*Call graph*: calls 2 internal fn (probe, probe_with); 2 external calls (default, vec!).


##### `install_suggestion_tools_stay_visible_without_tool_search`  (lines 911–932)

```
async fn install_suggestion_tools_stay_visible_without_tool_search()
```

**Purpose**: Confirms that plugin-install suggestion tools do not depend on `tool_search` support. They remain visible even when the model cannot use search.

**Data flow**: Builds a probe with `supports_search_tool = false`, discovery features enabled, and a discoverable plugin candidate, then asserts install tools are visible while `tool_search` is absent.

**Call relations**: Separates install-suggestion planning from deferred-search planning.

*Call graph*: calls 1 internal fn (probe_with); 2 external calls (default, vec!).


##### `request_plugin_install_description_defers_inventory_to_list_tool`  (lines 935–972)

```
async fn request_plugin_install_description_defers_inventory_to_list_tool()
```

**Purpose**: Checks the exact descriptions of the plugin-install tools so that inventory is delegated to the list tool and the request tool does not inline candidate names.

**Data flow**: Builds a probe with discovery features and a GitHub plugin candidate, extracts the visible `ResponsesApiTool` descriptions for `list_available_plugins_to_install` and `request_plugin_install`, and asserts required guidance text is present while the concrete plugin name is absent from the request description.

**Call relations**: Validates user-facing planner copy, not just tool presence.

*Call graph*: calls 1 internal fn (probe_with); 4 external calls (assert!, default, panic!, vec!).


##### `code_mode_only_exposes_code_executor_and_hides_nested_tools`  (lines 975–1016)

```
async fn code_mode_only_exposes_code_executor_and_hides_nested_tools()
```

**Purpose**: Verifies that code-mode-only planning replaces visible nested dynamic namespace tools with the code executor/wait entrypoints, while the same dynamic namespace is visible in plain mode.

**Data flow**: Creates one probe with a namespaced dynamic tool and no code-mode features, then another with `CodeMode` and `CodeModeOnly` enabled. It compares namespace contents and visible code-mode tool names across the two cases.

**Call relations**: Exercises the planner's code-mode-only abstraction layer over nested tools.

*Call graph*: calls 1 internal fn (probe_with); 3 external calls (assert_eq!, default, vec!).


##### `excluded_deferred_namespaces_do_not_enable_nested_tool_guidance`  (lines 1019–1052)

```
async fn excluded_deferred_namespaces_do_not_enable_nested_tool_guidance()
```

**Purpose**: Checks that deferred nested tools from namespaces explicitly excluded in config do not trigger extra guidance text in the code-mode executor description, even though the deferred tools remain registered and searchable.

**Data flow**: Configures code-mode-only, disables collaboration, enables search support, sets `config.code_mode.excluded_tool_namespaces = ["excluded"]`, injects a deferred dynamic namespace tool, then inspects the code exec description and registration state.

**Call relations**: Targets a subtle UX rule in code-mode planner messaging for excluded deferred namespaces.

*Call graph*: calls 2 internal fn (probe_with, namespaced); 4 external calls (assert!, default, panic!, vec!).


##### `multi_agent_feature_selects_one_agent_tool_family`  (lines 1055–1153)

```
async fn multi_agent_feature_selects_one_agent_tool_family()
```

**Purpose**: Verifies that planner output selects either multi-agent v1 or v2 tool families, not both, and that v2 can be forced to direct-model-only exposure in code-mode-only configurations.

**Data flow**: Builds three probes: v1 with `Collab` enabled and `MultiAgentV2` disabled, v2 with `MultiAgentV2` enabled and custom concurrency config, and a code-mode-only v2 case with `non_code_mode_only = true`. It asserts visible sets, namespace contents, schema properties, description text, and exposure values.

**Call relations**: This is the main family-selection test for multi-agent planning.

*Call graph*: calls 1 internal fn (probe); 3 external calls (assert!, assert_eq!, panic!).


##### `multi_agent_v2_message_schemas_are_encrypted`  (lines 1156–1177)

```
async fn multi_agent_v2_message_schemas_are_encrypted()
```

**Purpose**: Ensures that the `message` parameter in key multi-agent v2 tools is marked encrypted in the visible JSON schema.

**Data flow**: Enables `MultiAgentV2`, probes, iterates over `spawn_agent`, `send_message`, and `followup_task`, extracts each function tool's parameter schema, and asserts `properties["message"].encrypted == Some(true)`.

**Call relations**: Checks a schema security invariant in planner output.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert_eq!, panic!).


##### `tool_mode_selector_overrides_feature_flags`  (lines 1180–1191)

```
async fn tool_mode_selector_overrides_feature_flags()
```

**Purpose**: Verifies that an explicit `model_info.tool_mode = Direct` suppresses code-mode-only entrypoints even if code-mode features are enabled.

**Data flow**: Enables code-mode features, manually sets both `turn.model_info.tool_mode` and `turn.tool_mode` to `ToolMode::Direct`, probes, and asserts the code-mode public and wait tools are absent.

**Call relations**: Covers precedence between explicit model tool-mode selection and feature-derived defaults.

*Call graph*: calls 1 internal fn (probe).


##### `v1_multi_agent_tools_defer_when_tool_search_available`  (lines 1194–1236)

```
async fn v1_multi_agent_tools_defer_when_tool_search_available()
```

**Purpose**: Checks that when tool search is available, multi-agent v1 tools are hidden from direct visibility and instead registered as deferred namespaced runtimes discoverable through `tool_search`.

**Data flow**: Enables search support and v1 multi-agent features, probes, asserts visible `tool_search` and absence of plain multi-agent tools, then for each v1 function verifies the namespaced runtime is registered, the plain runtime is not, and exposure is `Deferred`. It also inspects the tool-search description text.

**Call relations**: Exercises the planner's deferred-search representation for the v1 multi-agent family.

*Call graph*: calls 2 internal fn (probe, namespaced); 3 external calls (assert!, assert_eq!, panic!).


##### `multi_agent_v2_can_use_configured_tool_namespace`  (lines 1239–1292)

```
async fn multi_agent_v2_can_use_configured_tool_namespace()
```

**Purpose**: Verifies that multi-agent v2 tools can be exposed under a configured namespace instead of as plain top-level functions, and that unsupported legacy names like `assign_task` stay absent.

**Data flow**: Enables `MultiAgentV2`, sets `config.multi_agent_v2.tool_namespace = Some("agents")`, probes, then asserts visible namespace presence, absence of plain tool names, registration of namespaced runtimes only, and namespace membership for each supported function.

**Call relations**: Covers configurable namespacing for v2 planner output.

*Call graph*: calls 1 internal fn (probe); 1 external calls (assert!).


##### `multi_agent_v2_namespace_is_supported_by_bedrock_provider`  (lines 1295–1316)

```
async fn multi_agent_v2_namespace_is_supported_by_bedrock_provider()
```

**Purpose**: Checks that Bedrock provider planning still supports namespaced multi-agent v2 tools when a namespace is configured.

**Data flow**: Enables `MultiAgentV2`, configures namespace `agents`, switches to Bedrock provider, probes, and asserts the namespace is visible while plain top-level v2 tools are absent and namespaced runtimes are registered.

**Call relations**: Complements the previous namespace test with provider-specific capability coverage.

*Call graph*: calls 1 internal fn (probe); 1 external calls (assert!).


##### `code_mode_only_can_expose_namespaced_multi_agent_v2_as_normal_tools`  (lines 1319–1369)

```
async fn code_mode_only_can_expose_namespaced_multi_agent_v2_as_normal_tools()
```

**Purpose**: Verifies the combined planner output for code-mode-only plus namespaced multi-agent v2, including exact visible tool ordering and namespace contents.

**Data flow**: Enables `CodeMode`, `CodeModeOnly`, and `MultiAgentV2`, configures `non_code_mode_only = true` and namespace `agents`, probes, then asserts the exact `visible_names` vector and checks that supported v2 functions appear inside the `agents` namespace while `assign_task` does not.

**Call relations**: Exercises a combined configuration where code-mode wrappers and namespaced v2 tools coexist.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert!, assert_eq!).


##### `hosted_tools_follow_provider_auth_model_and_config_gates`  (lines 1372–1467)

```
async fn hosted_tools_follow_provider_auth_model_and_config_gates()
```

**Purpose**: Tests hosted Responses tools such as image generation and web search across auth modes, provider selection, model capabilities, code-mode-only composition, standalone web-search feature gating, and extension overrides.

**Data flow**: Builds multiple probes covering API-key auth versus ChatGPT auth, image-generation features, web-search mode and tool type, code-mode-only plus multi-agent v2, standalone web search with and without `WebRunExtensionTool`, and Bedrock provider. It asserts visible sets and exact `ToolSpec::WebSearch` contents where relevant.

**Call relations**: This is the broadest hosted-tool planner regression test, tying together provider, auth, model, feature, and extension inputs.

*Call graph*: calls 2 internal fn (probe, probe_with); 3 external calls (default, assert_eq!, vec!).


### `core/src/tools/tool_dispatch_trace_tests.rs`

`test` · `test execution; validates rollout-trace emission during tool dispatch`

This file constructs real `ToolRegistry` dispatches against a temporary rollout-trace root and then replays the emitted bundle to assert trace contents. `TestHandler` is a minimal `ToolExecutor<ToolInvocation>` and `CoreToolRuntime` implementation that exposes a plain function tool and always returns `FunctionToolOutput::from_text("ok", Some(true))`. The tests use `make_session_and_context` to obtain a realistic `Session` and `TurnContext`, then replace `session.services.rollout_thread_trace` with a test trace context created by `attach_test_trace`.

The helper `test_invocation_with_payload` builds a full `ToolInvocation`, including a fresh `CancellationToken` and a new `TurnDiffTracker` wrapped in `Arc<tokio::sync::Mutex<_>>`, so dispatch runs through the same shape as production. `test_invocation` is a convenience wrapper for function-call payloads. `single_bundle_dir` asserts that exactly one trace bundle directory was produced and returns its path for replay.

The tests cover four important cases: direct versus code-mode requester attribution, unsupported-tool failures from an empty registry, incompatible payload failures when a function tool receives `ToolPayload::Custom`, and the special case where dispatching the code-mode wait tool should not fabricate code-cell traces if none were started. Assertions inspect replayed `tool_calls` entries for requester type, model-visible call id, code-mode runtime tool id, execution status, and presence of raw invocation/result payload ids, proving that both success and failure paths preserve enough trace data for later analysis.

#### Function details

##### `TestHandler::tool_name`  (lines 34–36)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the configured tool name for the test handler. This lets each test register a handler under a predictable runtime name.

**Data flow**: Reads `self.tool_name` and returns a clone of it. No state is mutated.

**Call relations**: Used by `ToolRegistry::with_handler_for_test` when the registry introspects the handler during test setup.

*Call graph*: 1 external calls (clone).


##### `TestHandler::spec`  (lines 38–47)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Provides a minimal function-tool spec for the registered test handler. The schema is intentionally empty because dispatch tracing tests care about execution and tracing, not validation richness.

**Data flow**: Builds and returns `codex_tools::ToolSpec::Function` containing a `ResponsesApiTool` whose name comes from `self.tool_name.name`, with a fixed description, `strict = false`, default parameters, and no output schema.

**Call relations**: Consumed by the registry during handler registration so dispatch can resolve the tool.

*Call graph*: 2 external calls (default, Function).


##### `TestHandler::handle`  (lines 49–56)

```
fn handle(&self, _invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Implements a successful test execution path that always returns the text output `ok` marked successful for logging.

**Data flow**: Ignores the incoming `ToolInvocation`, returns a boxed future, and resolves to `Ok(Box<dyn ToolOutput>)` containing `FunctionToolOutput::from_text("ok", Some(true))`.

**Call relations**: Invoked by registry dispatch in the success-path tracing test.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (new, pin).


##### `dispatch_lifecycle_trace_records_direct_and_code_mode_requesters`  (lines 62–146)

```
async fn dispatch_lifecycle_trace_records_direct_and_code_mode_requesters() -> anyhow::Result<()>
```

**Purpose**: Verifies that replayed rollout traces distinguish direct model calls from code-mode calls and preserve both invocation and result payload references.

**Data flow**: Creates a temp trace root, session, and turn; attaches tracing; starts a code-cell trace; registers `TestHandler`; dispatches one direct and one code-mode invocation; replays the single emitted bundle; and asserts requester fields, model-visible call id presence/absence, code-mode runtime tool id, and raw payload ids.

**Call relations**: Exercises the full dispatch-to-trace pipeline for both requester variants using the helper constructors in this file.

*Call graph*: calls 6 internal fn (make_session_and_context, with_handler_for_test, attach_test_trace, single_bundle_dir, test_invocation, plain); 6 external calls (clone, new, new, assert!, assert_eq!, replay_bundle).


##### `dispatch_lifecycle_trace_records_unsupported_tool_failures`  (lines 149–176)

```
async fn dispatch_lifecycle_trace_records_unsupported_tool_failures() -> anyhow::Result<()>
```

**Purpose**: Checks that dispatching an unknown tool from an empty registry records a failed tool-call trace with a result payload.

**Data flow**: Creates traced session state, uses `ToolRegistry::empty_for_test`, dispatches a direct invocation for `missing_tool`, asserts the returned error matches `FunctionCallError::RespondToModel`, replays the bundle, and checks failed execution status plus presence of `raw_result_payload_id`.

**Call relations**: Covers an early registry failure path to ensure `ToolDispatchTrace::record_failed` is wired correctly.

*Call graph*: calls 5 internal fn (make_session_and_context, empty_for_test, attach_test_trace, single_bundle_dir, test_invocation); 5 external calls (new, new, assert!, assert_eq!, replay_bundle).


##### `dispatch_lifecycle_trace_records_incompatible_payload_failures`  (lines 179–210)

```
async fn dispatch_lifecycle_trace_records_incompatible_payload_failures() -> anyhow::Result<()>
```

**Purpose**: Verifies that a payload-shape mismatch for a registered function tool is traced as a failed execution with a result payload.

**Data flow**: Creates traced session state, registers `TestHandler`, dispatches an invocation whose payload is `ToolPayload::Custom` instead of function arguments, asserts the error is `FunctionCallError::Fatal`, replays the bundle, and checks failed status and result payload presence.

**Call relations**: Exercises a different failure path than unsupported-tool lookup: the tool exists, but the invocation payload is incompatible.

*Call graph*: calls 6 internal fn (make_session_and_context, with_handler_for_test, attach_test_trace, single_bundle_dir, test_invocation_with_payload, plain); 5 external calls (new, new, assert!, assert_eq!, replay_bundle).


##### `missing_code_mode_wait_traces_only_the_wait_tool_call`  (lines 213–242)

```
async fn missing_code_mode_wait_traces_only_the_wait_tool_call() -> anyhow::Result<()>
```

**Purpose**: Checks that dispatching the code-mode wait tool without a preexisting code-cell trace records only the tool call and does not create synthetic code-cell trace entries.

**Data flow**: Creates traced session state, registers `CodeModeWaitHandler`, dispatches a direct wait-tool invocation with JSON arguments, replays the bundle, and asserts `replayed.code_cells.len() == 0` while the wait tool call still has a result payload id.

**Call relations**: Targets a special-case interaction between code-mode tooling and rollout tracing.

*Call graph*: calls 5 internal fn (make_session_and_context, with_handler_for_test, attach_test_trace, single_bundle_dir, test_invocation); 5 external calls (new, new, assert!, assert_eq!, replay_bundle).


##### `test_invocation`  (lines 244–262)

```
fn test_invocation(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    call_id: &str,
    tool_name: &str,
    source: ToolCallSource,
    arguments: &str,
) -> ToolInvocation
```

**Purpose**: Convenience constructor for a `ToolInvocation` carrying a plain function-call payload string.

**Data flow**: Accepts session, turn, call id, plain tool name string, source, and arguments string; converts the tool name with `ToolName::plain`, wraps the arguments in `ToolPayload::Function`, and delegates to `test_invocation_with_payload`.

**Call relations**: Used by the direct/code-mode requester test, unsupported-tool failure test, and wait-tool test.

*Call graph*: calls 2 internal fn (test_invocation_with_payload, plain); called by 3 (dispatch_lifecycle_trace_records_direct_and_code_mode_requesters, dispatch_lifecycle_trace_records_unsupported_tool_failures, missing_code_mode_wait_traces_only_the_wait_tool_call).


##### `test_invocation_with_payload`  (lines 264–282)

```
fn test_invocation_with_payload(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    call_id: &str,
    tool_name: codex_tools::ToolName,
    source: ToolCallSource,
    payload: ToolPayload,
)
```

**Purpose**: Builds a fully populated `ToolInvocation` for tests, including cancellation and diff-tracking state.

**Data flow**: Takes session and turn `Arc`s, call id, `ToolName`, `ToolCallSource`, and `ToolPayload`, then returns a `ToolInvocation` with a fresh `CancellationToken`, a new `TurnDiffTracker` inside `Arc<tokio::sync::Mutex<_>>`, and cloned/captured identifiers.

**Call relations**: Used directly by the incompatible-payload test and indirectly by `test_invocation` for the common function-call case.

*Call graph*: calls 1 internal fn (new); called by 2 (dispatch_lifecycle_trace_records_incompatible_payload_failures, test_invocation); 3 external calls (new, new, new).


##### `attach_test_trace`  (lines 284–307)

```
fn attach_test_trace(session: &mut Session, turn: &TurnContext, root: &Path) -> anyhow::Result<()>
```

**Purpose**: Installs a test rollout-thread trace context onto a session and marks the current turn as started so subsequent dispatches emit trace files under a temporary root.

**Data flow**: Reads `session.thread_id`, creates a `ThreadTraceContext` rooted at `root` with fixed metadata such as agent path, session source, cwd, model, provider, approval policy, and sandbox policy, records the current turn start using `turn.sub_id`, stores the trace context into `session.services.rollout_thread_trace`, and returns `Ok(())` or an error.

**Call relations**: Called by every test before dispatch so replayable trace bundles are produced.

*Call graph*: calls 1 internal fn (start_root_in_root_for_test); called by 4 (dispatch_lifecycle_trace_records_direct_and_code_mode_requesters, dispatch_lifecycle_trace_records_incompatible_payload_failures, dispatch_lifecycle_trace_records_unsupported_tool_failures, missing_code_mode_wait_traces_only_the_wait_tool_call); 1 external calls (from).


##### `single_bundle_dir`  (lines 309–316)

```
fn single_bundle_dir(root: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: Finds the sole emitted trace bundle directory under a temporary root and asserts there is exactly one.

**Data flow**: Reads directory entries from `root`, maps them to paths, collects and sorts them, asserts the count is one, removes and returns the only path as `Ok(PathBuf)`.

**Call relations**: Used by all replay-based tests before calling `codex_rollout_trace::replay_bundle`.

*Call graph*: called by 4 (dispatch_lifecycle_trace_records_direct_and_code_mode_requesters, dispatch_lifecycle_trace_records_incompatible_payload_failures, dispatch_lifecycle_trace_records_unsupported_tool_failures, missing_code_mode_wait_traces_only_the_wait_tool_call); 2 external calls (assert_eq!, read_dir).


### Approvals, sandboxing, and runtime preparation
These files cover approval normalization, sandbox policy helpers, and the runtime setup paths that prepare commands and patch execution safely.

### `core/src/apply_patch_tests.rs`

`test` · `test-time validation of patch-to-protocol conversion`

This small test module exercises the pure adapter in `apply_patch.rs`. It creates a temporary directory, derives an absolute path for `a.txt`, and uses the test-only constructor `ApplyPatchAction::new_add_for_test` to build an action containing exactly one add-file change with content `"hello"`. The test then calls `convert_apply_patch_to_protocol` and asserts that the returned `HashMap<PathBuf, FileChange>` contains an entry for the exact absolute path whose value is `FileChange::Add { content: "hello".to_string() }`.

Although narrow, this test is valuable because `convert_apply_patch_to_protocol` is the boundary between the internal patch representation (`ApplyPatchAction` / `ApplyPatchFileChange`) and the protocol representation consumed elsewhere. By checking the add variant explicitly, it guards against regressions in path ownership, map keying, and content cloning for the simplest and most common patch case.

#### Function details

##### `convert_apply_patch_maps_add_variant`  (lines 8–22)

```
fn convert_apply_patch_maps_add_variant()
```

**Purpose**: Verifies that an internal add-file patch action becomes a protocol `FileChange::Add` keyed by the same absolute path.

**Data flow**: Creates a temp directory, builds an absolute file path, constructs an `ApplyPatchAction` with one add change via `new_add_for_test`, passes it to `convert_apply_patch_to_protocol`, and asserts the resulting map entry equals `Some(&FileChange::Add { content: "hello".to_string() })`.

**Call relations**: This standalone unit test directly targets `convert_apply_patch_to_protocol` and does not involve approval or runtime delegation logic.

*Call graph*: calls 1 internal fn (new_add_for_test); 2 external calls (assert_eq!, tempdir).


### `core/src/command_canonicalization_tests.rs`

`test` · `test execution`

This test file exercises `canonicalize_command_for_approval` with four focused scenarios. The first verifies that simple `bash -lc` wrappers around a single plain command are reduced to the inner token sequence, and that wrapper path differences (`/bin/bash` vs `bash`) and extra shell whitespace do not affect the canonical result. The second covers complex shell scripts that cannot be safely tokenized, using a heredoc example; instead of flattening the script, the canonical form becomes a synthetic `__codex_shell_script__` key plus the shell mode and exact script text, again proving wrapper-path stability. The third does the same for PowerShell wrappers, asserting that both `powershell.exe` and `powershell` normalize to the same `__codex_powershell_script__` key with the original script body. The final test confirms that non-shell commands are left untouched.

Together these tests document the intended contract: normalize aggressively only when parsing is unambiguous, otherwise preserve script text exactly and only abstract over the wrapper executable.

#### Function details

##### `canonicalizes_word_only_shell_scripts_to_inner_command`  (lines 5–30)

```
fn canonicalizes_word_only_shell_scripts_to_inner_command()
```

**Purpose**: Verifies that a simple `bash -lc` command containing one plain shell command canonicalizes to the inner argv tokens. It also checks that wrapper path and whitespace differences collapse to the same result.

**Data flow**: Builds two command vectors with different shell executable spellings and spacing → calls `canonicalize_command_for_approval` on both → asserts the first equals the expected `cargo test -p codex-core` token vector and that both canonical forms are identical.

**Call relations**: This test exercises the parser-first branch of the canonicalization helper, specifically the path where `parse_shell_lc_plain_commands` succeeds with exactly one command.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `canonicalizes_heredoc_scripts_to_stable_script_key`  (lines 33–54)

```
fn canonicalizes_heredoc_scripts_to_stable_script_key()
```

**Purpose**: Verifies that complex shell scripts such as heredocs are not tokenized but instead mapped to a stable synthetic shell-script key. It confirms wrapper executable differences do not affect the canonical form.

**Data flow**: Constructs two `zsh -lc` command vectors around the same heredoc script → canonicalizes both → asserts the result is `["__codex_shell_script__", "-lc", script]` and equal across both wrappers.

**Call relations**: This test covers the fallback bash-like extraction branch used when plain-command parsing is unsafe or impossible.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `canonicalizes_powershell_wrappers_to_stable_script_key`  (lines 57–82)

```
fn canonicalizes_powershell_wrappers_to_stable_script_key()
```

**Purpose**: Verifies that PowerShell command wrappers normalize to a synthetic PowerShell script key carrying the exact script text. It ensures executable spelling and extra wrapper flags do not change the approval key.

**Data flow**: Builds two PowerShell argv vectors with different executable names and flags → canonicalizes both → asserts the result is `["__codex_powershell_script__", script]` and equal across both inputs.

**Call relations**: This test exercises the PowerShell extraction branch of the canonicalization helper.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `preserves_non_shell_commands`  (lines 85–88)

```
fn preserves_non_shell_commands()
```

**Purpose**: Verifies that commands not recognized as shell wrappers are returned unchanged. This protects ordinary argv commands from accidental rewriting.

**Data flow**: Creates a plain `cargo fmt` vector → canonicalizes it → asserts the output equals the original vector.

**Call relations**: This test covers the final fallback branch where no shell-specific recognizer matches.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/tasks/user_shell_tests.rs`

`test` · `unit test execution`

This test module focuses on the subtle PATH-handling behavior in `prepare_user_shell_exec_command_with_path_prepend`. The helper `shell_with_snapshot` constructs a `Shell` value from a `ShellType`, shell path, and snapshot path, returning both the shell and the absolute snapshot path for convenience.

The single test creates a temporary directory, writes a synthetic shell snapshot file that exports `PATH='/snapshot/bin'`, and constructs a Bash shell plus absolute snapshot path. It then prepares a simple command vector equivalent to `bash -lc "printf '%s' \"$PATH\""`, seeds the execution environment with `PATH=/worktree/bin`, and calls `prepare_user_shell_exec_command_with_path_prepend` with a closure that prepends a runtime-owned `codex-path` directory into both the live environment and the `RuntimePathPrepends` tracker.

Instead of mocking the wrapper, the test executes the rewritten command with `std::process::Command`, passing the mutated PATH from the environment map. The assertion checks that the command succeeds and that stdout equals `<package_path_dir>:/snapshot/bin`. That exact output proves the runtime prepend was preserved ahead of the snapshot-restored PATH, which is the invariant the production code needs when replaying shell snapshots on Unix.

#### Function details

##### `shell_with_snapshot`  (lines 9–21)

```
fn shell_with_snapshot(
    shell_type: ShellType,
    shell_path: &str,
    snapshot_path: AbsolutePathBuf,
) -> (Shell, AbsolutePathBuf)
```

**Purpose**: Builds a `Shell` configured with the requested shell type/path and pairs it with the provided snapshot path.

**Data flow**: Consumes `shell_type`, `shell_path`, and `snapshot_path`. It converts `shell_path` into a `PathBuf`, constructs `Shell { shell_type, shell_path }`, and returns `(Shell, AbsolutePathBuf)`.

**Call relations**: The PATH-preservation test uses this helper to create the shell/snapshot pair passed into command rewriting.

*Call graph*: called by 1 (user_shell_snapshot_preserves_package_path_prepend); 1 external calls (from).


##### `user_shell_snapshot_preserves_package_path_prepend`  (lines 24–62)

```
fn user_shell_snapshot_preserves_package_path_prepend()
```

**Purpose**: Verifies that Unix shell snapshot wrapping preserves runtime PATH prepends ahead of the snapshot's PATH value.

**Data flow**: Creates a temp directory and snapshot file, writes a snapshot script exporting `/snapshot/bin`, constructs a Bash shell and absolute snapshot path, defines a `bash -lc` command that prints `$PATH`, seeds an env map with `/worktree/bin`, and calls `prepare_user_shell_exec_command_with_path_prepend` with a closure that prepends a runtime package path. It then executes the rewritten command via `std::process::Command`, passing the mutated PATH, and asserts success plus exact stdout equal to `<package_path_dir>:/snapshot/bin`.

**Call relations**: This is a direct regression test for the Unix-only helper used by production shell execution. It exercises the real rewritten command rather than inspecting intermediate strings only.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (from, new, assert!, assert_eq!, new, write, tempdir, vec!).


### `core/src/tools/network_approval_tests.rs`

`test` · `test execution`

This test module probes the nontrivial concurrency and state invariants in `network_approval.rs`. It constructs `NetworkApprovalService` instances directly and, because the tests live in the same module tree, inspects private helpers and fields such as `HostApprovalKey`, `PendingHostApproval`, `session_approved_hosts`, and `take_call_outcome`. Several tests verify host-key scoping: approvals are deduplicated only when host, protocol, and port all match, and session-approved hosts preserve that same granularity when copied between services.

The module also validates the synchronization primitive behind deduplication. `pending_waiters_receive_owner_decision` spawns a waiter on `PendingHostApproval::wait_for_decision` and confirms that `set_decision` wakes it with the exact stored enum value. Policy-gating helpers are pinned down too: only `AskForApproval::Never` disables approval flow, and only managed permission profiles permit it.

For active-call attribution, helper functions build realistic `BlockedRequest` values and register calls with a concrete `GuardianNetworkAccessTrigger` representing a shell command. Tests then confirm that blocked requests record `DeniedByPolicy`, cancel the owning token, do not override an existing `DeniedByUser`, and are ignored when attribution is ambiguous because multiple calls are active. Finish-path tests verify that `finish_call` both returns the denial and unregisters the call, while deferred finish memoizes the first denial result through `OnceCell`. Together these tests document the service’s most subtle guarantees: precise host scoping, safe attribution, and stable denial propagation.

#### Function details

##### `pending_approvals_are_deduped_per_host_protocol_and_port`  (lines 13–27)

```
async fn pending_approvals_are_deduped_per_host_protocol_and_port()
```

**Purpose**: Checks that two requests for the exact same host/protocol/port share one pending approval object and only the first caller is marked as owner.

**Data flow**: Creates a default `NetworkApprovalService` and a `HostApprovalKey` → calls `get_or_create_pending_approval` twice with the same key → asserts first owner flag is true, second is false, and both returned `Arc<PendingHostApproval>` values point to the same allocation.

**Call relations**: This test directly exercises the service’s deduplication helper. It validates the ownership contract that drives owner/waiter branching in inline policy handling.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert!).


##### `pending_approvals_do_not_dedupe_across_ports`  (lines 30–49)

```
async fn pending_approvals_do_not_dedupe_across_ports()
```

**Purpose**: Verifies that pending approvals are scoped by port as well as host and protocol. Requests to the same host over different ports must not share approval state.

**Data flow**: Creates a service and two `HostApprovalKey` values differing only by port → calls `get_or_create_pending_approval` for each → asserts both callers are owners and the returned `Arc`s are distinct.

**Call relations**: This test complements the exact-match deduplication test by proving the key granularity includes port. It protects against accidental over-sharing of approvals.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert!).


##### `session_approved_hosts_preserve_protocol_and_port_scope`  (lines 52–107)

```
async fn session_approved_hosts_preserve_protocol_and_port_scope()
```

**Purpose**: Confirms that copying session-approved hosts preserves separate entries for different protocols and ports on the same hostname.

**Data flow**: Seeds one service’s `session_approved_hosts` set with three `HostApprovalKey` values, creates a second service, calls `sync_session_approved_hosts_to`, then reads, clones, sorts, and compares the target set contents against the expected three-key vector.

**Call relations**: This test exercises the approval-cache synchronization helper and documents that approval scope is not collapsed during copying.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_eq!).


##### `sync_session_approved_hosts_to_replaces_existing_target_hosts`  (lines 110–149)

```
async fn sync_session_approved_hosts_to_replaces_existing_target_hosts()
```

**Purpose**: Checks that syncing approved hosts overwrites the target cache instead of merging with stale entries. The target should contain only the source’s approvals afterward.

**Data flow**: Seeds source and target services with different approved-host entries → calls `sync_session_approved_hosts_to(&target)` → reads the target set and asserts it equals a single-entry vector containing only the source host.

**Call relations**: This test verifies the replacement semantics of cache synchronization, which matter when cloning or reseeding session state.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_eq!).


##### `pending_waiters_receive_owner_decision`  (lines 152–166)

```
async fn pending_waiters_receive_owner_decision()
```

**Purpose**: Validates the waiter-notification mechanism used for deduplicated approvals. A waiting task should unblock and observe the exact decision set by the owner.

**Data flow**: Creates `Arc<PendingHostApproval>`, spawns a task awaiting `wait_for_decision()`, calls `set_decision(PendingApprovalDecision::AllowOnce)`, awaits the spawned task, and asserts the returned decision equals `AllowOnce`.

**Call relations**: This test isolates the synchronization behavior of `PendingHostApproval`. It underpins the correctness of non-owner request handling in the service.

*Call graph*: calls 1 internal fn (new); 4 external calls (clone, new, assert_eq!, spawn).


##### `allow_once_and_allow_for_session_both_allow_network`  (lines 169–178)

```
fn allow_once_and_allow_for_session_both_allow_network()
```

**Purpose**: Ensures both positive pending-approval decisions map to `NetworkDecision::Allow`. Only explicit deny should produce a proxy denial.

**Data flow**: Calls `PendingApprovalDecision::to_network_decision()` for `AllowOnce` and `AllowForSession` → compares both results to `NetworkDecision::Allow` with `assert_eq!`.

**Call relations**: This test pins down the enum-to-proxy translation used when pending approval owners wake waiting requests.

*Call graph*: 1 external calls (assert_eq!).


##### `only_never_policy_disables_network_approval_flow`  (lines 181–186)

```
fn only_never_policy_disables_network_approval_flow()
```

**Purpose**: Checks the approval-policy gate for network approval flow. It documents that every policy except `Never` still permits prompting.

**Data flow**: Calls `allows_network_approval_flow` with `Never`, `OnRequest`, `OnFailure`, and `UnlessTrusted` → asserts the first is false and the others are true.

**Call relations**: This test covers the small policy helper that `handle_inline_policy_request` uses before attempting approval flow.

*Call graph*: 1 external calls (assert!).


##### `network_approval_flow_is_limited_to_restricted_sandbox_modes`  (lines 189–204)

```
fn network_approval_flow_is_limited_to_restricted_sandbox_modes()
```

**Purpose**: Verifies that network approval flow is allowed only for managed permission profiles and not for disabled or external profiles.

**Data flow**: Calls `permission_profile_allows_network_approval_flow` with `PermissionProfile::read_only()`, `workspace_write()`, `Disabled`, and `External { network: Restricted }` → asserts true for the managed profiles and false for the others.

**Call relations**: This test documents the permission-profile gate that blocks approval prompts outside managed sandbox modes.

*Call graph*: 1 external calls (assert!).


##### `denied_blocked_request`  (lines 206–218)

```
fn denied_blocked_request(host: &str) -> BlockedRequest
```

**Purpose**: Builds a representative denied `BlockedRequest` for tests that simulate proxy-level network policy failures. It standardizes the host, protocol, reason, and port fields used across multiple assertions.

**Data flow**: Reads `host: &str` → constructs `BlockedRequestArgs` with `reason: "not_allowed"`, protocol `"http"`, decision `"deny"`, source `"decider"`, and port `80` → returns `BlockedRequest::new(...)`.

**Call relations**: Several blocked-request tests call this helper to avoid repeating request construction. It feeds directly into `record_blocked_request` scenarios.

*Call graph*: calls 1 internal fn (new); called by 3 (blocked_request_policy_does_not_override_user_denial_outcome, record_blocked_request_ignores_ambiguous_unattributed_blocked_requests, record_blocked_request_sets_policy_outcome_for_owner_call).


##### `register_call_with_default_shell_trigger`  (lines 220–244)

```
async fn register_call_with_default_shell_trigger(
    service: &NetworkApprovalService,
    registration_id: &str,
) -> CancellationToken
```

**Purpose**: Registers a test active call with a realistic shell-command trigger and returns its cancellation token. This helper sets up service state for attribution and finish-path tests.

**Data flow**: Creates a new `CancellationToken` → calls `service.register_call(...)` with the supplied registration ID, fixed turn ID, a `GuardianNetworkAccessTrigger` describing `curl https://example.com`, a matching command string, and a clone of the token → returns the original token.

**Call relations**: Multiple tests use this helper before recording outcomes or blocked requests. It centralizes the active-call setup needed for service methods that require a registered owner.

*Call graph*: calls 1 internal fn (register_call); called by 6 (blocked_request_policy_does_not_override_user_denial_outcome, deferred_finish_reuses_denial_result_after_first_consumer, finish_call_returns_denial_and_unregisters_active_call, record_blocked_request_ignores_ambiguous_unattributed_blocked_requests, record_blocked_request_sets_policy_outcome_for_owner_call, record_call_outcome_ignores_inactive_call); 3 external calls (new, test_path_buf, vec!).


##### `active_call_preserves_triggering_command_context`  (lines 247–277)

```
async fn active_call_preserves_triggering_command_context()
```

**Purpose**: Checks that `register_call` stores the exact trigger metadata and command string supplied by the caller. This ensures approval prompts can later reflect the original command context.

**Data flow**: Creates a service and an expected `GuardianNetworkAccessTrigger`, registers a call with that trigger and command string, resolves the single active call, and asserts the stored `trigger` and `command` match the expected values.

**Call relations**: This test exercises the registration and single-call resolution path, documenting what metadata survives into active-call state.

*Call graph*: calls 1 internal fn (default); 4 external calls (new, assert_eq!, test_path_buf, vec!).


##### `record_blocked_request_sets_policy_outcome_for_owner_call`  (lines 280–296)

```
async fn record_blocked_request_sets_policy_outcome_for_owner_call()
```

**Purpose**: Verifies that a blocked proxy request records a `DeniedByPolicy` outcome for the sole active call and cancels its token.

**Data flow**: Creates a service, registers one active call via the helper, calls `record_blocked_request(denied_blocked_request("example.com"))`, asserts the cancellation token is cancelled, and asserts `take_call_outcome` returns the expected `DeniedByPolicy` message.

**Call relations**: This test covers the normal blocked-request attribution path through `record_blocked_request` and `record_outcome_for_single_active_call`.

*Call graph*: calls 3 internal fn (default, denied_blocked_request, register_call_with_default_shell_trigger); 2 external calls (assert!, assert_eq!).


##### `blocked_request_policy_does_not_override_user_denial_outcome`  (lines 299–314)

```
async fn blocked_request_policy_does_not_override_user_denial_outcome()
```

**Purpose**: Ensures a later policy denial cannot overwrite an earlier explicit user denial for the same call. `DeniedByUser` must remain authoritative.

**Data flow**: Creates a service, registers a call, records `DeniedByUser` with `record_call_outcome`, then feeds a denied blocked request into `record_blocked_request` → asserts `take_call_outcome` still returns `Some(NetworkApprovalOutcome::DeniedByUser)`.

**Call relations**: This test targets the overwrite guard inside `record_call_outcome`, which preserves user-denial semantics against subsequent policy events.

*Call graph*: calls 3 internal fn (default, denied_blocked_request, register_call_with_default_shell_trigger); 1 external calls (assert_eq!).


##### `finish_call_returns_denial_and_unregisters_active_call`  (lines 317–336)

```
async fn finish_call_returns_denial_and_unregisters_active_call()
```

**Purpose**: Checks that finishing a call returns the stored denial as `ToolError::Rejected`, removes the active registration, and clears the stored outcome.

**Data flow**: Creates a service, registers a call, records `DeniedByPolicy("network denied")`, calls `finish_call("registration-1")` expecting an error, then asserts the error message, that `resolve_single_active_call()` is `None`, and that `take_call_outcome` returns `None`.

**Call relations**: This test exercises the immediate finish path that production orchestration uses after a tool attempt completes.

*Call graph*: calls 2 internal fn (default, register_call_with_default_shell_trigger); 3 external calls (assert!, assert_eq!, DeniedByPolicy).


##### `deferred_finish_reuses_denial_result_after_first_consumer`  (lines 339–366)

```
async fn deferred_finish_reuses_denial_result_after_first_consumer()
```

**Purpose**: Verifies that deferred finish memoizes the first fetched denial outcome so later consumers see the same rejection even after service state has been consumed.

**Data flow**: Creates a service, registers a call, constructs a `DeferredNetworkApproval` with a fresh `OnceCell`, records `DeniedByPolicy("network denied")`, calls `deferred.finish(&service)` twice, and asserts both returned errors carry the same message.

**Call relations**: This test covers the `DeferredNetworkApproval::finish` memoization behavior that protects deferred consumers from one-shot state removal.

*Call graph*: calls 2 internal fn (default, register_call_with_default_shell_trigger); 4 external calls (new, new, assert!, DeniedByPolicy).


##### `record_call_outcome_ignores_inactive_call`  (lines 369–384)

```
async fn record_call_outcome_ignores_inactive_call()
```

**Purpose**: Ensures outcomes are not recorded for calls that have already been unregistered. Inactive calls should neither be cancelled nor accumulate stale denial state.

**Data flow**: Creates a service, registers a call and keeps its token, unregisters the call, attempts to record `DeniedByPolicy("network denied")`, then asserts the token is not cancelled and `take_call_outcome` returns `None`.

**Call relations**: This test validates the early-return branch in `record_call_outcome` when the registration ID is no longer active.

*Call graph*: calls 2 internal fn (default, register_call_with_default_shell_trigger); 3 external calls (assert!, assert_eq!, DeniedByPolicy).


##### `record_blocked_request_ignores_ambiguous_unattributed_blocked_requests`  (lines 387–398)

```
async fn record_blocked_request_ignores_ambiguous_unattributed_blocked_requests()
```

**Purpose**: Checks that blocked requests are ignored when more than one active call exists and ownership cannot be determined safely.

**Data flow**: Creates a service, registers two active calls, records a denied blocked request, then asserts `take_call_outcome` returns `None` for both registrations.

**Call relations**: This test documents the service’s deliberate refusal to guess attribution under concurrency, covering the `resolve_single_active_call` safeguard.

*Call graph*: calls 3 internal fn (default, denied_blocked_request, register_call_with_default_shell_trigger); 1 external calls (assert_eq!).


### `core/src/tools/sandboxing_tests.rs`

`test` · `test execution`

This test module covers the generic helpers in `tools/sandboxing.rs`. The first two tests validate `PermissionRequestPayload::bash`, ensuring the generated hook payload always includes `command` and only includes `description` when one is provided. The next group checks `default_exec_approval_requirement`: unrestricted/external sandboxes skip approval under `OnRequest`, restricted sandboxes require approval, and granular approval policies that disable sandbox approval convert what would have been a prompt into an immediate `Forbidden` requirement.

The remaining tests focus on first-attempt sandbox override and deny-read preservation. They verify that explicit exec-policy bypass (`Skip { bypass_sandbox: true }`) and explicit `RequireEscalated` requests both trigger `SandboxOverride::BypassSandboxFirstAttempt` under ordinary restricted policies. The final test constructs a filesystem policy with a deny-read glob and proves the key invariant of this module: deny-read restrictions make `unsandboxed_execution_allowed` false, force `sandbox_override_for_first_attempt` back to `NoOverride`, and rewrite `RequireEscalated` to `UseDefault` via `sandbox_permissions_preserving_denied_reads`. It also confirms that `WithAdditionalPermissions` remains sandboxed rather than being collapsed, preserving bounded permission expansion without dropping deny-read enforcement.

#### Function details

##### `bash_permission_request_payload_omits_missing_description`  (lines 12–20)

```
fn bash_permission_request_payload_omits_missing_description()
```

**Purpose**: Verifies that `PermissionRequestPayload::bash` omits the `description` field when no description is supplied. This keeps hook payloads minimal and semantically accurate.

**Data flow**: Calls `PermissionRequestPayload::bash("echo hi", None)` and asserts equality with a payload containing only `tool_name: HookToolName::bash()` and `tool_input: {"command": "echo hi"}`.

**Call relations**: This directly tests the payload constructor used by shell and unified-exec approval hooks.

*Call graph*: 1 external calls (assert_eq!).


##### `bash_permission_request_payload_includes_description_when_present`  (lines 23–37)

```
fn bash_permission_request_payload_includes_description_when_present()
```

**Purpose**: Verifies that `PermissionRequestPayload::bash` includes the `description` field when one is provided. This ensures hook consumers receive optional explanatory context.

**Data flow**: Calls `PermissionRequestPayload::bash("echo hi", Some("network-access example.com"))` and asserts equality with a payload whose JSON includes both `command` and `description`.

**Call relations**: This complements the previous payload-format test.

*Call graph*: 1 external calls (assert_eq!).


##### `external_sandbox_skips_exec_approval_on_request`  (lines 40–51)

```
fn external_sandbox_skips_exec_approval_on_request()
```

**Purpose**: Checks that `AskForApproval::OnRequest` does not require exec approval when the filesystem sandbox is external/unrestricted. Approval is only needed for restricted filesystem sandboxes.

**Data flow**: Calls `default_exec_approval_requirement(AskForApproval::OnRequest, &FileSystemSandboxPolicy::external_sandbox())` and asserts the result is `ExecApprovalRequirement::Skip { bypass_sandbox: false, proposed_execpolicy_amendment: None }`.

**Call relations**: This tests one branch of the default approval derivation helper.

*Call graph*: 1 external calls (assert_eq!).


##### `restricted_sandbox_requires_exec_approval_on_request`  (lines 54–65)

```
fn restricted_sandbox_requires_exec_approval_on_request()
```

**Purpose**: Checks that `AskForApproval::OnRequest` requires exec approval when the filesystem sandbox is restricted. This is the baseline prompting behavior for sandboxed execution.

**Data flow**: Calls `default_exec_approval_requirement(AskForApproval::OnRequest, &FileSystemSandboxPolicy::default())` and asserts the result is `ExecApprovalRequirement::NeedsApproval { ... }`.

**Call relations**: This covers the restricted-sandbox branch of default approval derivation.

*Call graph*: 1 external calls (assert_eq!).


##### `default_exec_approval_requirement_rejects_sandbox_prompt_when_granular_disables_it`  (lines 68–86)

```
fn default_exec_approval_requirement_rejects_sandbox_prompt_when_granular_disables_it()
```

**Purpose**: Verifies that granular approval settings can turn a would-be sandbox approval prompt into an immediate forbidden result. This enforces policy at requirement-derivation time rather than later in prompting.

**Data flow**: Builds `AskForApproval::Granular` with `sandbox_approval: false`, calls `default_exec_approval_requirement` with the default restricted filesystem policy, and asserts the result is `ExecApprovalRequirement::Forbidden` with the fixed rejection reason.

**Call relations**: This tests the granular-policy rejection branch in the shared helper.

*Call graph*: calls 1 internal fn (default); 2 external calls (Granular, assert_eq!).


##### `default_exec_approval_requirement_keeps_prompt_when_granular_allows_sandbox_approval`  (lines 89–108)

```
fn default_exec_approval_requirement_keeps_prompt_when_granular_allows_sandbox_approval()
```

**Purpose**: Checks that granular approval still yields `NeedsApproval` when sandbox approval is enabled, even if other granular flags are disabled. Only the sandbox-approval flag matters for this helper.

**Data flow**: Builds `AskForApproval::Granular` with `sandbox_approval: true`, calls `default_exec_approval_requirement` with the default restricted filesystem policy, and asserts the result is `NeedsApproval`.

**Call relations**: This complements the previous granular-policy test.

*Call graph*: calls 1 internal fn (default); 2 external calls (Granular, assert_eq!).


##### `additional_permissions_allow_bypass_sandbox_first_attempt_when_execpolicy_skips`  (lines 111–123)

```
fn additional_permissions_allow_bypass_sandbox_first_attempt_when_execpolicy_skips()
```

**Purpose**: Verifies that a trusted exec-policy skip with `bypass_sandbox: true` can bypass the sandbox on the first attempt even when the request shape is `WithAdditionalPermissions`. Trusted policy allow takes precedence when deny-read restrictions are absent.

**Data flow**: Calls `sandbox_override_for_first_attempt` with `SandboxPermissions::WithAdditionalPermissions`, `ExecApprovalRequirement::Skip { bypass_sandbox: true, ... }`, and the default filesystem policy, then asserts the result is `SandboxOverride::BypassSandboxFirstAttempt`.

**Call relations**: This tests the exec-policy-bypass branch of first-attempt sandbox override.

*Call graph*: 1 external calls (assert_eq!).


##### `guardian_bypasses_sandbox_for_explicit_escalation_on_first_attempt`  (lines 126–138)

```
fn guardian_bypasses_sandbox_for_explicit_escalation_on_first_attempt()
```

**Purpose**: Checks that an explicit `RequireEscalated` request bypasses the sandbox on the first attempt under ordinary restricted policies. This is the direct escalation path absent deny-read constraints.

**Data flow**: Calls `sandbox_override_for_first_attempt` with `SandboxPermissions::RequireEscalated`, a non-bypassing `Skip` requirement, and the default filesystem policy, then asserts the result is `BypassSandboxFirstAttempt`.

**Call relations**: This covers the explicit-escalation branch of first-attempt sandbox override.

*Call graph*: 1 external calls (assert_eq!).


##### `deny_read_blocks_explicit_escalation_and_policy_bypass`  (lines 141–195)

```
fn deny_read_blocks_explicit_escalation_and_policy_bypass()
```

**Purpose**: Verifies the central deny-read invariant: when the filesystem policy contains deny-read restrictions, neither explicit escalation nor trusted policy bypass may skip the sandbox. It also checks the corresponding permission normalization behavior.

**Data flow**: Builds a restricted filesystem policy with a deny glob for `**/*.env`, then calls `sandbox_override_for_first_attempt`, `unsandboxed_execution_allowed`, and `sandbox_permissions_preserving_denied_reads` with several permission/approval combinations. It asserts that bypass is blocked, unsandboxed execution is disallowed, `RequireEscalated` is rewritten to `UseDefault`, `WithAdditionalPermissions` is preserved, and the default policy still leaves `RequireEscalated` unchanged.

**Call relations**: This test exercises the interaction among the three shared helpers that preserve deny-read enforcement across orchestration.

*Call graph*: calls 1 internal fn (restricted); 3 external calls (assert!, assert_eq!, vec!).


### `core/src/tools/runtimes/apply_patch_tests.rs`

`test` · `test execution`

This is a focused test module for the apply-patch tool runtime. It imports the runtime implementation from the parent module and constructs concrete `ApplyPatchRequest` instances using temporary absolute paths, synthetic patch actions from `ApplyPatchAction::new_add_for_test`, and a helper `TurnEnvironment` rooted in `Environment::default_for_tests()`. The tests cover several distinct integration points. Approval behavior is checked first: `wants_no_sandbox_approval` must treat `AskForApproval::OnRequest` as requiring sandbox approval bypass, while `AskForApproval::Granular` is driven specifically by the `sandbox_approval` flag rather than the other granular booleans. Request-shaping tests then verify that guardian review requests include the patch action’s `cwd`, the exact patch text, and the file list; permission request payloads must identify the tool as `apply_patch`, expose matcher aliases `Write` and `Edit`, and serialize the patch under `{ "command": ... }`; and approval keys must include the turn environment’s `environment_id` alongside each path so approvals are scoped per environment.

The sandbox-oriented tests are more detailed. One confirms `sandbox_cwd` is taken directly from `req.action.cwd`. Another constructs a full `SandboxAttempt` with `SandboxType::MacosSeatbelt`, a base `PermissionProfile`, additional file-system permissions, and Windows/Linux sandbox flags, then checks that `file_system_sandbox_context_for_attempt` merges runtime permissions through `effective_file_system_sandbox_policy` and `effective_network_sandbox_policy`, preserves the attempt’s cwd and platform-specific sandbox settings, and returns a native permission profile equivalent to the expected merged policy. The final test asserts the invariant that `SandboxType::None` yields no file-system sandbox context at all.

#### Function details

##### `test_turn_environment`  (lines 18–25)

```
fn test_turn_environment(environment_id: &str) -> crate::session::turn_context::TurnEnvironment
```

**Purpose**: Builds a deterministic `TurnEnvironment` for tests from a supplied environment ID, using the default test exec environment and the process temp directory as an absolute `PathUri` root.

**Data flow**: It takes `environment_id: &str`, clones it into an owned `String`, creates a test `codex_exec_server::Environment` wrapped in `Arc`, converts `std::env::temp_dir().abs()` into a `PathUri`, and passes those values with `shell` set to `None` into `crate::session::turn_context::TurnEnvironment::new`. It returns the fully constructed `TurnEnvironment` without mutating external state.

**Call relations**: This helper is invoked by nearly every async test in the file whenever an `ApplyPatchRequest` needs a realistic turn context. It centralizes setup so the approval-key, guardian-review, permission-payload, sandbox-cwd, and sandbox-context tests all exercise runtime code with the same style of environment object.

*Call graph*: calls 3 internal fn (new, default_for_tests, from_abs_path); called by 6 (approval_keys_include_environment_id, file_system_sandbox_context_uses_active_attempt, guardian_review_request_includes_patch_context, no_sandbox_attempt_has_no_file_system_context, permission_request_payload_uses_apply_patch_hook_name_and_aliases, sandbox_cwd_uses_patch_action_cwd); 2 external calls (temp_dir, new).


##### `wants_no_sandbox_approval_granular_respects_sandbox_flag`  (lines 28–49)

```
fn wants_no_sandbox_approval_granular_respects_sandbox_flag()
```

**Purpose**: Verifies that `ApplyPatchRuntime::wants_no_sandbox_approval` keys off the sandbox-specific approval setting rather than unrelated granular approval toggles.

**Data flow**: The test creates a fresh `ApplyPatchRuntime`, then evaluates `wants_no_sandbox_approval` against three inputs: `AskForApproval::OnRequest`, a `GranularApprovalConfig` with `sandbox_approval: false`, and another with `sandbox_approval: true`. It asserts the returned booleans match the expected policy decisions and produces no side effects beyond test assertions.

**Call relations**: This is a direct unit test of the runtime’s approval decision helper. Nothing in this file calls it; instead, the test invokes the runtime method itself to pin down the branch behavior for the two approval enum variants and the critical `sandbox_approval` field.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `guardian_review_request_includes_patch_context`  (lines 52–88)

```
async fn guardian_review_request_includes_patch_context()
```

**Purpose**: Checks that the guardian approval request generated for an apply-patch operation carries the patch action’s working directory, exact patch text, and target file list.

**Data flow**: It creates an absolute temp-file path, builds an add-file `ApplyPatchAction`, captures `action.cwd` and `action.patch` as expected values, and assembles an `ApplyPatchRequest` containing a `FileChange::Add` entry and an `ExecApprovalRequirement::NeedsApproval`. That request is passed with call ID `"call-1"` into `ApplyPatchRuntime::build_guardian_review_request`, and the returned `GuardianApprovalRequest::ApplyPatch` is compared structurally against the expected object.

**Call relations**: The test uses `test_turn_environment` to supply the request context, then exercises the runtime’s guardian-review conversion path. Its role is to validate that when higher-level approval orchestration asks the runtime for a guardian payload, no patch-specific context is dropped or recomputed incorrectly.

*Call graph*: calls 3 internal fn (new_add_for_test, build_guardian_review_request, test_turn_environment); 4 external calls (from, assert_eq!, temp_dir, vec!).


##### `permission_request_payload_uses_apply_patch_hook_name_and_aliases`  (lines 91–124)

```
async fn permission_request_payload_uses_apply_patch_hook_name_and_aliases()
```

**Purpose**: Ensures the runtime’s permission-request payload identifies the tool with the apply-patch hook name, exposes the expected matcher aliases, and serializes the patch command in the request body.

**Data flow**: The test constructs a runtime, an absolute temp path, and an add-file `ApplyPatchAction`, then embeds that action in an `ApplyPatchRequest` with empty `changes` and a `NeedsApproval` exec requirement. It calls `runtime.permission_request_payload(&req)`, unwraps the `Option`/result with `expect`, and asserts that the returned payload contains tool name `apply_patch`, aliases `["Write", "Edit"]`, and JSON input `{ "command": expected_patch }`.

**Call relations**: This test drives the runtime method used when approval infrastructure asks a tool to describe itself for permission prompting. It depends on `test_turn_environment` for request setup and validates the exact outward-facing payload shape consumed by approval matching logic.

*Call graph*: calls 3 internal fn (new_add_for_test, new, test_turn_environment); 4 external calls (new, assert_eq!, temp_dir, vec!).


##### `approval_keys_include_environment_id`  (lines 127–156)

```
async fn approval_keys_include_environment_id()
```

**Purpose**: Verifies that approval keys generated for apply-patch requests are environment-scoped, not just path-scoped.

**Data flow**: It creates a runtime and a temp-file request whose `turn_environment` uses the explicit environment ID `"remote"`, with `ExecApprovalRequirement::Skip`. The test calls `runtime.approval_keys(&req)`, serializes the resulting key collection with `serde_json::to_value`, and asserts it equals a JSON array containing one object with both `environment_id: "remote"` and the file `path`.

**Call relations**: The test uses `test_turn_environment` with a non-local ID specifically to prove that the runtime threads environment identity into approval-key generation. This guards the call path used by approval caching or deduplication so approvals from one environment cannot silently apply to another.

*Call graph*: calls 3 internal fn (new_add_for_test, new, test_turn_environment); 4 external calls (new, assert_eq!, temp_dir, vec!).


##### `sandbox_cwd_uses_patch_action_cwd`  (lines 159–178)

```
async fn sandbox_cwd_uses_patch_action_cwd()
```

**Purpose**: Confirms that the runtime reports the sandbox working directory directly from the patch action embedded in the request.

**Data flow**: It builds a runtime and an `ApplyPatchRequest` around a temp-file add action, then calls `runtime.sandbox_cwd(&req)`. The returned `Option<&PathUri>` is asserted to equal `Some(&req.action.cwd)`, with no additional state changes.

**Call relations**: This is a narrow unit test of the runtime helper consulted when sandbox setup needs a cwd. By constructing a normal request and comparing against the action field itself, it verifies that no alternate cwd source is used in the runtime’s sandbox preparation flow.

*Call graph*: calls 3 internal fn (new_add_for_test, new, test_turn_environment); 4 external calls (new, assert_eq!, temp_dir, vec!).


##### `file_system_sandbox_context_uses_active_attempt`  (lines 181–252)

```
async fn file_system_sandbox_context_uses_active_attempt()
```

**Purpose**: Tests that file-system sandbox context generation for apply-patch uses the active `SandboxAttempt` settings and merges additional permissions into the effective runtime permission profile.

**Data flow**: The test creates a temp path and an `AdditionalPermissionProfile` whose file-system permissions grant that path as a read-write root. It builds an `ApplyPatchRequest` carrying those additional permissions, defines a base `FileSystemSandboxPolicy::default()` and restricted network policy, converts them into a base `PermissionProfile`, and constructs a `SandboxAttempt` with `SandboxType::MacosSeatbelt`, a `SandboxManager`, cwd/path roots, and explicit Windows/Linux sandbox flags. It then calls `ApplyPatchRuntime::file_system_sandbox_context_for_attempt(&req, &attempt)`, unwraps the returned context, recomputes the expected effective file-system and network policies via `effective_file_system_sandbox_policy` and `effective_network_sandbox_policy`, converts the context’s permissions back into a native `PermissionProfile`, and asserts equality on permissions, cwd, Windows sandbox level, private desktop flag, and legacy landlock flag.

**Call relations**: This test exercises the runtime path used after sandbox selection has already produced a concrete `SandboxAttempt`. It validates that the runtime does not merely echo request permissions; instead it derives context from the active attempt and policy-transform helpers, preserving platform-specific sandbox knobs needed by downstream sandbox execution.

*Call graph*: calls 10 internal fn (new_add_for_test, file_system_sandbox_context_for_attempt, test_turn_environment, from_read_write_roots, from_runtime_permissions, default, new, effective_file_system_sandbox_policy, effective_network_sandbox_policy, from_abs_path); 6 external calls (new, new, assert_eq!, temp_dir, from_ref, vec!).


##### `no_sandbox_attempt_has_no_file_system_context`  (lines 255–292)

```
async fn no_sandbox_attempt_has_no_file_system_context()
```

**Purpose**: Asserts that when the active sandbox attempt is `SandboxType::None`, the runtime declines to produce any file-system sandbox context.

**Data flow**: It builds an `ApplyPatchRequest` for a temp-file add action, creates a disabled `PermissionProfile`, a `SandboxManager`, and a `SandboxAttempt` whose `sandbox` is `SandboxType::None` and whose platform flags are all disabled. The test passes request and attempt into `ApplyPatchRuntime::file_system_sandbox_context_for_attempt` and asserts the return value is exactly `None`.

**Call relations**: This is the negative counterpart to the previous sandbox-context test. It verifies the branch taken when orchestration has chosen no sandbox at all, ensuring the runtime does not fabricate file-system context for unsandboxed execution.

*Call graph*: calls 4 internal fn (new_add_for_test, test_turn_environment, new, from_abs_path); 5 external calls (new, assert_eq!, temp_dir, from_ref, vec!).


### `core/src/tools/runtimes/mod_tests.rs`

`test` · `test execution`

This file is a test module for the runtime tooling layer, with most cases validating how commands and environments are rewritten before execution. It defines a tiny `StaticReloader` test double implementing `codex_network_proxy::ConfigReloader`; the reloader never produces updated config and intentionally errors on forced reload, allowing `test_network_proxy` to construct a stable `NetworkProxy` instance without external config churn. The tests then probe two broad areas.

First, sandbox/escalation preparation: `explicit_escalation_prepares_exec_without_managed_network` builds a sandbox command, wraps it in a `SandboxAttempt`, and verifies that `RequireEscalated` permissions suppress managed-network injection and scrub Codex-owned proxy/CA variables while preserving unrelated user variables. Companion tests verify that user-provided CA and proxy variables survive when they are not Codex-marked.

Second, shell snapshot replay: many tests create a temporary `snapshot.sh`, build a `(Shell, AbsolutePathBuf)` pair with `shell_with_snapshot`, call `maybe_wrap_shell_lc_with_snapshot`, and inspect either the rewritten argv or the actual subprocess output from running it. These cases pin down bootstrap-shell selection (`zsh`, `bash`, `sh`), shell quoting, preservation of trailing args, precedence of explicit env overrides over snapshot exports, restoration of live `CODEX_THREAD_ID`, nuanced proxy-variable refresh behavior, and replay of runtime PATH prepends. Unix-only tests also verify `RuntimePathPrepends` normalization and zsh-fork PATH insertion semantics, including deduplication and removal of empty PATH entries to avoid current-directory lookup.

#### Function details

##### `StaticReloader::source_label`  (lines 38–40)

```
fn source_label(&self) -> String
```

**Purpose**: Returns a fixed human-readable label for the test config source used by the proxy state. The label makes the synthetic reloader identifiable without depending on any real configuration backend.

**Data flow**: Reads no inputs beyond `self` and no external state. Produces the constant string `"test config state"` and writes nothing.

**Call relations**: Used indirectly by proxy-state machinery after `test_network_proxy` installs `StaticReloader` into `NetworkProxyState`; it exists only to satisfy the `ConfigReloader` trait contract for tests.


##### `StaticReloader::maybe_reload`  (lines 42–44)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Implements the non-forced reload path for the test reloader by always reporting that no new config is available. This keeps proxy state stable across tests.

**Data flow**: Consumes `self` by shared reference and returns a boxed async future resolving to `Ok(None)`. It reads no mutable state and performs no side effects.

**Call relations**: Reached only through the `ConfigReloader` interface after `test_network_proxy` wires the reloader into `NetworkProxyState`; it deliberately stops reload-driven behavior from affecting assertions.

*Call graph*: 1 external calls (pin).


##### `StaticReloader::reload_now`  (lines 46–48)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Implements forced reload for the test reloader by failing immediately. The explicit error prevents tests from accidentally depending on unsupported live reload behavior.

**Data flow**: Takes `&self`, returns a boxed async future, and resolves to an `anyhow` error with the message that force reload is unsupported in tests. It reads and writes no other state.

**Call relations**: Like `maybe_reload`, this is only exercised through the proxy reloader abstraction installed by `test_network_proxy`; its role is to make unsupported paths fail loudly if invoked.

*Call graph*: 2 external calls (pin, anyhow!).


##### `shell_with_snapshot`  (lines 51–63)

```
fn shell_with_snapshot(
    shell_type: ShellType,
    shell_path: &str,
    snapshot_path: AbsolutePathBuf,
) -> (Shell, AbsolutePathBuf)
```

**Purpose**: Builds the exact `(Shell, AbsolutePathBuf)` pair expected by snapshot-related tests. It packages a `ShellType`, shell executable path, and snapshot file path into a reusable fixture.

**Data flow**: Accepts a `ShellType`, a shell path string, and an `AbsolutePathBuf` snapshot path. It converts the shell path into a `PathBuf`, constructs a `Shell { shell_type, shell_path }`, and returns that shell alongside the unchanged snapshot path.

**Call relations**: This helper is the common setup step for nearly every `maybe_wrap_shell_lc_with_snapshot_*` test and for the PATH probe helper, reducing duplication while keeping each test focused on rewrite behavior.

*Call graph*: called by 19 (maybe_wrap_shell_lc_with_snapshot_applies_explicit_path_override, maybe_wrap_shell_lc_with_snapshot_bootstraps_in_user_shell, maybe_wrap_shell_lc_with_snapshot_clears_stale_codex_git_ssh_command_without_live_command, maybe_wrap_shell_lc_with_snapshot_does_not_embed_override_values_in_argv, maybe_wrap_shell_lc_with_snapshot_escapes_single_quotes, maybe_wrap_shell_lc_with_snapshot_keeps_snapshot_path_without_override, maybe_wrap_shell_lc_with_snapshot_keeps_user_proxy_env_when_proxy_inactive, maybe_wrap_shell_lc_with_snapshot_preserves_trailing_args, maybe_wrap_shell_lc_with_snapshot_preserves_unset_override_variables, maybe_wrap_shell_lc_with_snapshot_preserves_zsh_fork_path_prepend (+9 more)); 1 external calls (from).


##### `test_network_proxy`  (lines 65–80)

```
async fn test_network_proxy() -> anyhow::Result<NetworkProxy>
```

**Purpose**: Constructs a deterministic `NetworkProxy` instance for tests with fixed loopback HTTP and SOCKS addresses and a static config state. It avoids external configuration and marks the proxy as not managed by Codex.

**Data flow**: Builds a default `NetworkProxyConfig` and `NetworkProxyConstraints`, converts them into a `ConfigState`, wraps that in `NetworkProxyState::with_reloader` using `Arc<StaticReloader>`, then feeds the state and fixed socket addresses into `NetworkProxy::builder()`. Returns the asynchronously built `NetworkProxy` or an error.

**Call relations**: Called only by `explicit_escalation_prepares_exec_without_managed_network` to supply a realistic proxy object whose environment variables can be applied and then verified as stripped during escalated execution preparation.

*Call graph*: calls 2 internal fn (builder, with_reloader); called by 1 (explicit_escalation_prepares_exec_without_managed_network); 4 external calls (new, build_config_state, default, default).


##### `explicit_escalation_prepares_exec_without_managed_network`  (lines 83–152)

```
async fn explicit_escalation_prepares_exec_without_managed_network() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicitly escalated sandbox execution request does not carry managed-network settings or Codex proxy variables into the final exec environment. It also checks that ordinary user environment entries survive unchanged.

**Data flow**: Creates a temp workspace, a test proxy, and an env map seeded with `CUSTOM_ENV`; applies proxy vars into that env; builds a sandbox command for `/bin/echo ok`; constructs `ExecOptions`, `PermissionProfile::Disabled`, `SandboxManager`, and a `SandboxAttempt` configured with `SandboxType::None` and `enforce_managed_network: false`; then calls `attempt.env_for(...)`. It asserts the returned exec request preserves cwd values, sets `network` to `None`, removes all `PROXY_ENV_KEYS` and `CUSTOM_CA_ENV_KEYS` (plus the macOS git-ssh proxy var), and retains `CUSTOM_ENV`.

**Call relations**: This is a top-level async test. It depends on `test_network_proxy` for a populated proxy env and on runtime helpers such as `build_sandbox_command`, `exec_env_for_sandbox_permissions`, and `managed_network_for_sandbox_permissions` to drive the exact escalation path under test.

*Call graph*: calls 4 internal fn (test_network_proxy, managed_network_for_sandbox_permissions, new, from_abs_path); 5 external calls (from, assert_eq!, from_ref, tempdir, vec!).


##### `explicit_escalation_preserves_user_ca_env`  (lines 155–170)

```
fn explicit_escalation_preserves_user_ca_env()
```

**Purpose**: Checks that explicit escalation does not erase a user-supplied CA bundle path merely because proxy-related state is present. The test distinguishes user CA configuration from Codex-managed proxy CA injection.

**Data flow**: Builds an env map containing `PROXY_ACTIVE_ENV_KEY=1` and `SSL_CERT_FILE=/tmp/custom-ca.pem`, passes it through `exec_env_for_sandbox_permissions` with `SandboxPermissions::RequireEscalated`, and asserts the resulting map still contains the same `SSL_CERT_FILE` value.

**Call relations**: This standalone regression test targets the env-filtering helper directly rather than the full sandbox request path, narrowing the assertion to CA-variable preservation.

*Call graph*: 2 external calls (from, assert_eq!).


##### `runtime_path_prepends_records_runtime_path_prepend`  (lines 174–190)

```
fn runtime_path_prepends_records_runtime_path_prepend()
```

**Purpose**: Verifies that prepending a runtime path updates both the live `PATH` variable and the replay metadata stored in `RuntimePathPrepends`. It confirms the prepend is visible immediately and can later be reproduced from a snapshot.

**Data flow**: Starts with `PATH=/usr/bin:/bin` and a default `RuntimePathPrepends`, calls `prepend` with `/package/codex-path`, then asserts the env now has `/package/codex-path:/usr/bin:/bin` and `entries` contains exactly that directory once.

**Call relations**: This direct unit test exercises `RuntimePathPrepends::prepend` behavior in isolation, establishing the baseline later relied on by snapshot replay tests.

*Call graph*: 4 external calls (from, from, assert_eq!, default).


##### `runtime_path_prepends_drops_empty_path_entries`  (lines 194–213)

```
fn runtime_path_prepends_drops_empty_path_entries()
```

**Purpose**: Checks that runtime PATH prepending normalizes away empty path segments instead of preserving implicit current-directory lookups. It also verifies duplicate prepends are collapsed in the recorded replay list.

**Data flow**: Initializes `PATH` with leading, trailing, and repeated empty segments plus an existing `/package/codex-path`, calls `prepend` with the same directory, and asserts the resulting `PATH` is normalized to `/package/codex-path:/usr/bin:/bin` while `entries` records the prepend only once.

**Call relations**: This is another focused unit test of `RuntimePathPrepends::prepend`, covering the edge case where malformed or unsafe PATH contents must be sanitized.

*Call graph*: 4 external calls (from, from, assert_eq!, default).


##### `runtime_path_prepends_ignores_empty_path_entry`  (lines 217–233)

```
fn runtime_path_prepends_ignores_empty_path_entry()
```

**Purpose**: Ensures that attempting to prepend an empty filesystem path is treated as a no-op. This prevents corrupting `PATH` or recording meaningless replay metadata.

**Data flow**: Creates an env with `PATH=/usr/bin:/bin`, a default `RuntimePathPrepends`, and calls `prepend` with `PathBuf::new().as_path()`. It asserts `PATH` remains unchanged and the prepend tracker stays equal to its default empty state.

**Call relations**: This isolated test covers the guard path in runtime PATH handling where the candidate prepend has no usable string representation.

*Call graph*: 4 external calls (from, new, assert_eq!, default).


##### `prepend_zsh_fork_bin_to_path_ignores_empty_parent`  (lines 237–251)

```
fn prepend_zsh_fork_bin_to_path_ignores_empty_parent()
```

**Purpose**: Verifies that the zsh-fork PATH helper declines to modify `PATH` when the provided shell path has no parent directory. That avoids inventing an invalid prepend from a bare executable name.

**Data flow**: Starts with a normal `PATH`, passes `PathBuf::from("zsh")` to `prepend_zsh_fork_bin_to_path`, and asserts the function returns `None` and leaves `PATH` untouched.

**Call relations**: This unit test targets the lower-level zsh PATH helper directly, covering the failure-to-derive-parent branch that `apply_zsh_fork_path_prepend` depends on.

*Call graph*: 3 external calls (from, from, assert_eq!).


##### `apply_zsh_fork_path_prepend_uses_shell_parent`  (lines 255–273)

```
fn apply_zsh_fork_path_prepend_uses_shell_parent()
```

**Purpose**: Checks that zsh fork setup prepends the parent directory of the zsh executable to `PATH` and records that directory for snapshot replay. It validates the intended happy path for packaged zsh resources.

**Data flow**: Creates `PATH=/usr/bin:/bin` and an empty `RuntimePathPrepends`, calls `apply_zsh_fork_path_prepend` with `/package/codex-resources/zsh/bin/zsh`, then asserts `PATH` becomes `/package/codex-resources/zsh/bin:/usr/bin:/bin` and `entries` contains that bin directory.

**Call relations**: This test exercises the higher-level helper that combines parent extraction with runtime prepend recording, behavior later reused by snapshot replay tests.

*Call graph*: 4 external calls (from, from, assert_eq!, default).


##### `apply_zsh_fork_path_prepend_moves_existing_shell_parent_to_front`  (lines 277–301)

```
fn apply_zsh_fork_path_prepend_moves_existing_shell_parent_to_front()
```

**Purpose**: Verifies that applying the zsh fork prepend deduplicates an already-present shell bin directory and moves it to the front of `PATH`. This preserves precedence without leaving repeated entries behind.

**Data flow**: Begins with a `PATH` containing `/package/codex-resources/zsh/bin` twice in non-leading positions, applies the zsh fork prepend for the matching zsh path, and asserts the final `PATH` is `/package/codex-resources/zsh/bin:/usr/bin:/bin` with a single recorded prepend entry.

**Call relations**: This complements the previous zsh prepend test by covering the deduplication/reordering branch rather than simple insertion.

*Call graph*: 4 external calls (from, from, assert_eq!, default).


##### `explicit_escalation_keeps_user_proxy_env_without_codex_marker`  (lines 304–320)

```
fn explicit_escalation_keeps_user_proxy_env_without_codex_marker()
```

**Purpose**: Confirms that explicit escalation preserves ordinary user proxy settings when they are not marked as Codex-managed. The test prevents over-aggressive stripping of all proxy variables.

**Data flow**: Creates an env containing `HTTP_PROXY=http://user.proxy:8080` and `CUSTOM_ENV=kept`, passes it through `exec_env_for_sandbox_permissions` with `RequireEscalated`, and asserts both values remain present in the returned env map.

**Call relations**: This direct helper-level test complements the broader exec-request test by isolating the distinction between Codex-owned and user-owned proxy variables.

*Call graph*: 2 external calls (from, assert_eq!).


##### `maybe_wrap_shell_lc_with_snapshot_bootstraps_in_user_shell`  (lines 323–348)

```
fn maybe_wrap_shell_lc_with_snapshot_bootstraps_in_user_shell()
```

**Purpose**: Verifies that a `-lc` shell command is rewritten to bootstrap through the session shell and source the snapshot before executing the original command. It specifically checks zsh-based bootstrapping of a bash command.

**Data flow**: Creates a temp snapshot file, builds a `ShellType::Zsh` session shell fixture, defines a command `['/bin/bash','-lc','echo hello']`, and passes empty override/env maps plus default runtime prepends into `maybe_wrap_shell_lc_with_snapshot`. It asserts the rewritten argv starts with `/bin/zsh -c` and that the generated script sources the snapshot and `exec`s `/bin/bash -c 'echo hello'`.

**Call relations**: This is a top-level snapshot rewrite test using `shell_with_snapshot` for setup. It exercises the main wrapping path and inspects argv text rather than subprocess output.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 7 external calls (new, assert!, assert_eq!, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_escapes_single_quotes`  (lines 351–373)

```
fn maybe_wrap_shell_lc_with_snapshot_escapes_single_quotes()
```

**Purpose**: Checks that the wrapper script correctly shell-quotes embedded single quotes from the original command string. This prevents malformed bootstrap scripts when replaying commands containing apostrophes.

**Data flow**: Builds a zsh session shell and snapshot, rewrites `['/bin/bash','-lc',"echo 'hello'"]`, and asserts the generated script contains the expected shell-escaped sequence for `echo 'hello'` inside the nested `exec` command.

**Call relations**: This test narrows in on quoting logic within `maybe_wrap_shell_lc_with_snapshot`, complementing the broader bootstrap-shell selection tests.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 6 external calls (new, assert!, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_uses_bash_bootstrap_shell`  (lines 376–401)

```
fn maybe_wrap_shell_lc_with_snapshot_uses_bash_bootstrap_shell()
```

**Purpose**: Verifies that when the session shell is bash, the wrapper uses `/bin/bash -c` as the bootstrap shell regardless of the original command shell. It confirms bootstrap-shell choice follows session context.

**Data flow**: Creates a bash session shell fixture and snapshot, rewrites a zsh `-lc` command, and asserts the rewritten argv begins with `/bin/bash -c` while the generated script still `exec`s the original `/bin/zsh -c 'echo hello'` payload after sourcing the snapshot.

**Call relations**: This test is one of several shell-selection cases for `maybe_wrap_shell_lc_with_snapshot`, differing only in the session shell fixture.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 7 external calls (new, assert!, assert_eq!, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_uses_sh_bootstrap_shell`  (lines 404–429)

```
fn maybe_wrap_shell_lc_with_snapshot_uses_sh_bootstrap_shell()
```

**Purpose**: Checks that a session configured as plain `sh` causes snapshot bootstrapping to run under `/bin/sh -c`. It ensures the wrapper honors the exact shell family selected for the session.

**Data flow**: Creates an `sh` session shell and snapshot, rewrites a bash `-lc` command, and asserts the rewritten argv starts with `/bin/sh -c` and contains snapshot sourcing plus `exec '/bin/bash' -c 'echo hello'`.

**Call relations**: This is the third bootstrap-shell selection test, covering the `ShellType::Sh` branch of `maybe_wrap_shell_lc_with_snapshot`.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 7 external calls (new, assert!, assert_eq!, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_preserves_trailing_args`  (lines 432–459)

```
fn maybe_wrap_shell_lc_with_snapshot_preserves_trailing_args()
```

**Purpose**: Verifies that arguments following the `-c` script are preserved when the command is wrapped through the snapshot bootstrap. This matters because shells use those trailing argv entries as `$0`, `$1`, and so on.

**Data flow**: Creates a zsh session shell and snapshot, rewrites a bash command whose script prints `$0` and `$1` and whose argv includes `arg0` and `arg1`, then asserts the generated nested `exec` command includes both trailing arguments with proper quoting.

**Call relations**: This test exercises the argv reconstruction branch of `maybe_wrap_shell_lc_with_snapshot`, ensuring wrapping does not truncate shell positional parameters.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 6 external calls (new, assert!, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_restores_explicit_override_precedence`  (lines 462–498)

```
fn maybe_wrap_shell_lc_with_snapshot_restores_explicit_override_precedence()
```

**Purpose**: Checks that explicit environment overrides supplied by the caller take precedence over values exported by the snapshot, while unrelated snapshot-only variables remain available. It validates the wrapper’s post-source restoration logic.

**Data flow**: Writes a snapshot exporting `TEST_ENV_SNAPSHOT=global` and `SNAPSHOT_ONLY=from_snapshot`, rewrites a bash command that prints both variables, passes `TEST_ENV_SNAPSHOT=worktree` in both explicit overrides and live env maps, then executes the rewritten command with that env set. It asserts stdout is `worktree|from_snapshot`.

**Call relations**: Unlike argv-inspection tests, this one runs the rewritten command to verify actual shell semantics after `maybe_wrap_shell_lc_with_snapshot` restores selected live variables.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (from, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_restores_codex_thread_id_from_env`  (lines 501–532)

```
fn maybe_wrap_shell_lc_with_snapshot_restores_codex_thread_id_from_env()
```

**Purpose**: Ensures that `CODEX_THREAD_ID` from the live process environment overrides any stale value captured in the snapshot. This preserves nested execution context instead of reverting to the parent snapshot’s thread identity.

**Data flow**: Creates a snapshot exporting `CODEX_THREAD_ID=parent-thread`, rewrites a command that prints `CODEX_THREAD_ID`, passes a live env map containing `nested-thread`, executes the rewritten command with `CODEX_THREAD_ID=nested-thread`, and asserts stdout is `nested-thread`.

**Call relations**: This is a concrete precedence test for one special variable whose live value must survive snapshot sourcing; it validates the restoration branch inside `maybe_wrap_shell_lc_with_snapshot`.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (from, new, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_restores_proxy_env_from_process_env`  (lines 535–581)

```
fn maybe_wrap_shell_lc_with_snapshot_restores_proxy_env_from_process_env()
```

**Purpose**: Verifies that when proxying is active, live proxy variables from the process environment replace stale snapshot proxy values, while unrelated variables like plain `GIT_SSH_COMMAND` remain as exported by the snapshot. It captures the nuanced distinction between managed proxy vars and ordinary shell state.

**Data flow**: Writes a snapshot exporting stale `PIP_PROXY`, `HTTP_PROXY`, `http_proxy`, and `GIT_SSH_COMMAND`; rewrites a command that prints all four; executes it with `PROXY_ACTIVE_ENV_KEY=1` and fresh live values for the proxy vars plus `GIT_SSH_COMMAND`; then asserts the three proxy vars come from the live env while `GIT_SSH_COMMAND` remains the snapshot value.

**Call relations**: This subprocess-backed test exercises the proxy-refresh logic embedded in `maybe_wrap_shell_lc_with_snapshot`, specifically the branch activated by `PROXY_ACTIVE_ENV_KEY`.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (new, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_refreshes_codex_proxy_git_ssh_command`  (lines 585–625)

```
fn maybe_wrap_shell_lc_with_snapshot_refreshes_codex_proxy_git_ssh_command()
```

**Purpose**: On macOS, verifies that a stale Codex-managed git SSH proxy command captured in the snapshot is replaced by the live Codex-managed command. This keeps the proxy port/current command synchronized across snapshot replay.

**Data flow**: Builds stale and fresh command strings prefixed with `CODEX_PROXY_GIT_SSH_COMMAND_MARKER`, writes the stale one into the snapshot under `PROXY_GIT_SSH_COMMAND_ENV_KEY`, rewrites a command that prints that variable, executes it with the fresh command in the live env, and asserts stdout equals the fresh command.

**Call relations**: This macOS-only regression test targets the special-case refresh path in `maybe_wrap_shell_lc_with_snapshot` for Codex-owned git SSH proxy commands.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (new, assert!, assert_eq!, new, default, format!, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_restores_custom_git_ssh_command`  (lines 629–667)

```
fn maybe_wrap_shell_lc_with_snapshot_restores_custom_git_ssh_command()
```

**Purpose**: On macOS, checks that a user-provided custom git SSH command from the live environment overrides a stale Codex-managed snapshot command. It prevents Codex-specific snapshot state from clobbering user customization.

**Data flow**: Writes a stale marker-prefixed proxy command into the snapshot, rewrites a command that prints `PROXY_GIT_SSH_COMMAND_ENV_KEY`, executes it with a custom non-marker command in the live env, and asserts stdout equals the custom command.

**Call relations**: This complements the previous macOS test by covering the branch where the live value is not a Codex-generated proxy command but should still win over stale snapshot state.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (new, assert!, assert_eq!, new, default, format!, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_clears_stale_codex_git_ssh_command_without_live_command`  (lines 671–710)

```
fn maybe_wrap_shell_lc_with_snapshot_clears_stale_codex_git_ssh_command_without_live_command()
```

**Purpose**: On macOS, verifies that if the snapshot contains a stale Codex-managed git SSH command and the live environment has no replacement, the wrapper unsets the variable entirely. This avoids replaying dead proxy wiring.

**Data flow**: Writes a stale marker-prefixed command into the snapshot, rewrites a shell script that prints whether `PROXY_GIT_SSH_COMMAND_ENV_KEY` is set, executes it with that variable removed from the live env, and asserts stdout is `unset`.

**Call relations**: This is the cleanup counterpart to the two macOS git-ssh restoration tests, exercising the branch where stale Codex proxy state must be discarded rather than refreshed.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (new, assert!, assert_eq!, new, default, format!, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_keeps_user_proxy_env_when_proxy_inactive`  (lines 713–748)

```
fn maybe_wrap_shell_lc_with_snapshot_keeps_user_proxy_env_when_proxy_inactive()
```

**Purpose**: Checks that snapshot proxy variables are left alone when proxying is not active in the live environment. The wrapper should not rewrite user proxy settings unless the Codex proxy marker indicates active management.

**Data flow**: Writes a snapshot exporting `HTTP_PROXY=http://user.proxy:8080`, rewrites a command that prints `HTTP_PROXY`, executes it after removing all `PROXY_ENV_KEYS` from the subprocess environment, and asserts stdout remains `http://user.proxy:8080`.

**Call relations**: This test covers the inactive-proxy branch of `maybe_wrap_shell_lc_with_snapshot`, contrasting with tests where `PROXY_ACTIVE_ENV_KEY` triggers restoration from live env.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (new, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_restores_live_env_when_snapshot_proxy_active`  (lines 751–799)

```
fn maybe_wrap_shell_lc_with_snapshot_restores_live_env_when_snapshot_proxy_active()
```

**Purpose**: Verifies that if the snapshot itself says proxying was active, but the current process environment does not, the wrapper restores the live non-proxy state by unsetting stale proxy-only variables and preserving explicit live overrides. It prevents stale snapshot proxy activation from leaking into later commands.

**Data flow**: Writes a snapshot exporting `PROXY_ACTIVE_ENV_KEY=1`, `PIP_PROXY`, and `HTTP_PROXY`; rewrites a command that reports whether `PIP_PROXY` and `PROXY_ACTIVE_ENV_KEY` are set and prints `HTTP_PROXY`; passes explicit/live env with only `HTTP_PROXY=http://user.proxy:8080`; executes with `HTTP_PROXY` set and the other proxy vars removed; and asserts output shows `PIP_PROXY` unset, `HTTP_PROXY` from live env, and `PROXY_ACTIVE_ENV_KEY` unset.

**Call relations**: This subprocess test exercises the inverse proxy-reconciliation path in `maybe_wrap_shell_lc_with_snapshot`: stale snapshot proxy state must yield to the current process environment.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 10 external calls (from, new, assert!, assert_eq!, new, default, format!, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_keeps_snapshot_path_without_override`  (lines 802–832)

```
fn maybe_wrap_shell_lc_with_snapshot_keeps_snapshot_path_without_override()
```

**Purpose**: Checks the baseline PATH behavior: if there is no explicit PATH override, the snapshot’s exported PATH remains in effect after wrapping. This confirms the wrapper does not unnecessarily replace snapshot PATH state.

**Data flow**: Writes a snapshot exporting `PATH=/snapshot/bin`, rewrites a command that prints `PATH`, executes it without supplying a PATH override, and asserts stdout is `/snapshot/bin`.

**Call relations**: This is the control case for later PATH precedence tests around explicit overrides and runtime prepends in `maybe_wrap_shell_lc_with_snapshot`.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (new, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_applies_explicit_path_override`  (lines 835–867)

```
fn maybe_wrap_shell_lc_with_snapshot_applies_explicit_path_override()
```

**Purpose**: Verifies that an explicit PATH override from the caller suppresses the snapshot’s PATH export. This ensures worktree/runtime-selected PATH wins over captured shell state.

**Data flow**: Writes a snapshot exporting `PATH=/snapshot/bin`, rewrites a command that prints `PATH`, passes explicit/live env maps containing `PATH=/worktree/bin`, executes with that PATH in the subprocess environment, and asserts stdout is `/worktree/bin`.

**Call relations**: This test covers the PATH-specific override branch of `maybe_wrap_shell_lc_with_snapshot`, complementing the no-override baseline.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (from, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_preserves_package_path_prepend`  (lines 871–881)

```
fn maybe_wrap_shell_lc_with_snapshot_preserves_package_path_prepend() -> anyhow::Result<()>
```

**Purpose**: Checks that a runtime package PATH prepend recorded outside the snapshot is replayed ahead of the snapshot PATH when the wrapped command runs. This preserves runtime tool discoverability across snapshot restoration.

**Data flow**: Calls `run_snapshot_path_probe_with_runtime_path_prepend` with no explicit overrides, receives the command stdout and the generated package path directory, and asserts stdout equals `<package_path_dir>:/snapshot/bin`.

**Call relations**: This is a thin assertion wrapper around the shared probe helper, validating the default replay ordering of runtime prepends relative to snapshot PATH.

*Call graph*: calls 1 internal fn (run_snapshot_path_probe_with_runtime_path_prepend); 2 external calls (new, assert_eq!).


##### `maybe_wrap_shell_lc_with_snapshot_applies_runtime_path_prepend_after_explicit_path_override`  (lines 885–897)

```
fn maybe_wrap_shell_lc_with_snapshot_applies_runtime_path_prepend_after_explicit_path_override() -> anyhow::Result<()>
```

**Purpose**: Verifies that even when an explicit PATH override replaces the snapshot PATH, recorded runtime prepends are still replayed in front of that explicit PATH. This preserves package/tool injection without reintroducing snapshot PATH contents.

**Data flow**: Invokes `run_snapshot_path_probe_with_runtime_path_prepend` with `PATH=/worktree/bin` in the explicit override map, receives stdout and the package path directory, and asserts stdout equals `<package_path_dir>:/worktree/bin`.

**Call relations**: This test reuses the shared probe helper to cover the combined case of explicit PATH override plus runtime prepend replay.

*Call graph*: calls 1 internal fn (run_snapshot_path_probe_with_runtime_path_prepend); 2 external calls (from, assert_eq!).


##### `run_snapshot_path_probe_with_runtime_path_prepend`  (lines 900–941)

```
fn run_snapshot_path_probe_with_runtime_path_prepend(
    explicit_env_overrides: HashMap<String, String>,
) -> anyhow::Result<(String, PathBuf)>
```

**Purpose**: Provides a reusable subprocess probe for PATH replay behavior under snapshot wrapping. It sets up a snapshot PATH, applies a runtime prepend to the live env, runs the wrapped command, and returns the observed PATH plus the prepend directory used.

**Data flow**: Creates a temp dir and snapshot exporting `PATH=/snapshot/bin`; builds a bash session shell fixture; defines a command that prints `PATH`; creates `package_path_dir`; initializes live env with `PATH=/worktree/bin`; records a runtime prepend into both env and `RuntimePathPrepends`; rewrites the command with the supplied explicit overrides; executes it with the live PATH; asserts success; and returns `(stdout_string, package_path_dir)`.

**Call relations**: Called by the two PATH replay tests above. It centralizes the setup needed to verify how `maybe_wrap_shell_lc_with_snapshot` merges snapshot PATH, explicit overrides, and runtime prepend metadata.

*Call graph*: calls 1 internal fn (shell_with_snapshot); called by 2 (maybe_wrap_shell_lc_with_snapshot_applies_runtime_path_prepend_after_explicit_path_override, maybe_wrap_shell_lc_with_snapshot_preserves_package_path_prepend); 8 external calls (from, from_utf8_lossy, assert!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_preserves_zsh_fork_path_prepend`  (lines 945–991)

```
fn maybe_wrap_shell_lc_with_snapshot_preserves_zsh_fork_path_prepend()
```

**Purpose**: Checks that a zsh-fork PATH prepend recorded in runtime metadata is replayed ahead of the snapshot PATH. This ensures packaged zsh binaries remain discoverable after snapshot restoration.

**Data flow**: Creates a snapshot exporting `PATH=/snapshot/bin`, constructs a synthetic packaged zsh path under the temp dir, initializes live env with `/worktree/bin`, applies `apply_zsh_fork_path_prepend` to update env and `RuntimePathPrepends`, rewrites a command that prints `PATH`, executes it with the live PATH, and asserts stdout equals `<zsh_bin_dir>:/snapshot/bin`.

**Call relations**: This test combines the zsh-specific prepend helper with `maybe_wrap_shell_lc_with_snapshot`, proving that the generic runtime prepend replay mechanism also preserves zsh fork setup.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (from, new, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_does_not_embed_override_values_in_argv`  (lines 994–1036)

```
fn maybe_wrap_shell_lc_with_snapshot_does_not_embed_override_values_in_argv()
```

**Purpose**: Verifies that sensitive explicit override values are not interpolated into the generated shell script argv, even though they still take effect at runtime through the environment. This avoids leaking secrets via process listings.

**Data flow**: Writes a snapshot exporting `OPENAI_API_KEY=snapshot-value`, rewrites a command that prints `OPENAI_API_KEY`, passes explicit/live env maps containing `super-secret-value`, asserts the generated script text does not contain that secret, then executes the command with the env set and asserts stdout is `super-secret-value`.

**Call relations**: This subprocess-backed security regression test targets `maybe_wrap_shell_lc_with_snapshot`’s strategy for restoring overrides by variable reference rather than literal embedding.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (from, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_preserves_unset_override_variables`  (lines 1039–1074)

```
fn maybe_wrap_shell_lc_with_snapshot_preserves_unset_override_variables()
```

**Purpose**: Checks that if a variable appears in the explicit override set but is absent from the live process environment, the wrapper preserves that absence instead of resurrecting the snapshot value. This distinguishes 'explicitly managed but currently unset' from 'inherit snapshot export'.

**Data flow**: Writes a snapshot exporting `CODEX_TEST_UNSET_OVERRIDE=snapshot-value`, rewrites a command that reports whether the variable is set, passes an explicit override map naming the variable but supplies an empty live env map, executes the command with the variable removed from the subprocess environment, and asserts stdout is `unset`.

**Call relations**: This test covers an important edge case in `maybe_wrap_shell_lc_with_snapshot`: override restoration must respect unset live variables, not just overwrite with snapshot or explicit-map contents.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (from, new, assert!, assert_eq!, new, default, write, tempdir, vec!).


### `core/src/tools/runtimes/shell/unix_escalation_tests.rs`

`test` · `test execution`

This test module targets the Unix escalation implementation in detail. It includes small helpers for building platform-correct absolute paths, escaping strings for Starlark policy snippets, constructing read-only and deny-read filesystem sandbox policies, and producing a stable sandbox cwd. The tests then cover several distinct areas.

Parsing tests verify that `extract_shell_script` recognizes both `-c` and `-lc`, preserves the login-shell flag, tolerates wrapper prefixes such as `/usr/bin/env` or `sandbox-exec`, and rejects unsupported invocation shapes. `join_program_and_argv` is checked to ensure it replaces `argv[0]` with the resolved executable path. Policy-evaluation tests verify both modes of intercepted shell-wrapper parsing, host executable mapping behavior, and the distinction between rule-driven matches and heuristic fallback. They also confirm that preapproved additional permissions are treated like default sandbox permissions during approval-time policy evaluation.

Escalation-behavior tests validate `shell_request_escalation_execution`, ensure unsandboxed intercepted exec strips managed-network proxy environment variables, and confirm that preapproved additional permissions still escalate through the resolved permission profile. Approval-flow tests verify that granular approval flags reject the correct prompt classes and that permission-request hooks can short-circuit execve prompting entirely. Finally, denied-read tests ensure explicit escalation and prefix-rule allow decisions do not silently discard deny-read filesystem restrictions.

#### Function details

##### `host_absolute_path`  (lines 50–60)

```
fn host_absolute_path(segments: &[&str]) -> String
```

**Purpose**: Builds a platform-appropriate absolute path string from path segments for use in cross-platform tests. It abstracts away the root prefix difference between Windows and Unix.

**Data flow**: Takes a slice of path segments, starts from `C:\` on Windows or `/` otherwise, pushes each segment into a `PathBuf`, converts the result to a lossy string, and returns the owned `String`.

**Call relations**: Many tests call this helper to construct absolute executable and workspace paths without hardcoding platform-specific roots.

*Call graph*: called by 9 (commands_for_intercepted_exec_policy_parses_plain_shell_wrappers, denied_reads_keep_granular_sandbox_rejection_for_escalation, denied_reads_keep_prefix_rule_allow_inside_sandbox, evaluate_intercepted_exec_policy_matches_inner_shell_commands_when_enabled, evaluate_intercepted_exec_policy_uses_wrapper_command_when_shell_wrapper_parsing_disabled, intercepted_exec_policy_rejects_disallowed_host_executable_mapping, intercepted_exec_policy_treats_preapproved_additional_permissions_as_default, intercepted_exec_policy_uses_host_executable_mappings, test_sandbox_cwd); 2 external calls (from, cfg!).


##### `starlark_string`  (lines 62–64)

```
fn starlark_string(value: &str) -> String
```

**Purpose**: Escapes backslashes and double quotes so host paths can be embedded safely inside inline Starlark policy source strings. This keeps policy parser tests robust across platforms.

**Data flow**: Takes an input `&str`, replaces `\` with `\\` and `"` with `\"`, and returns the escaped `String`.

**Call relations**: Policy-source-building tests use it before interpolating absolute paths into `prefix_rule` and `host_executable` declarations.

*Call graph*: called by 3 (denied_reads_keep_prefix_rule_allow_inside_sandbox, intercepted_exec_policy_rejects_disallowed_host_executable_mapping, intercepted_exec_policy_uses_host_executable_mappings).


##### `read_only_file_system_sandbox_policy`  (lines 66–73)

```
fn read_only_file_system_sandbox_policy() -> FileSystemSandboxPolicy
```

**Purpose**: Constructs a restricted filesystem sandbox policy that grants read access to the root tree. It serves as a simple baseline policy for tests that need a sandboxed-but-readable environment.

**Data flow**: Creates a single `FileSystemSandboxEntry` for `FileSystemSpecialPath::Root` with `Read` access, wraps it in `FileSystemSandboxPolicy::restricted`, and returns the policy.

**Call relations**: Several tests use this helper when they need a policy that still allows unsandboxed execution semantics or baseline permission-profile construction.

*Call graph*: calls 1 internal fn (restricted); called by 4 (execve_permission_request_hook_short_circuits_prompt, preapproved_additional_permissions_escalate_intercepted_exec, shell_request_escalation_execution_is_explicit, unsandboxed_intercepted_exec_strips_managed_network_env); 1 external calls (vec!).


##### `denied_read_file_system_sandbox_policy`  (lines 75–90)

```
fn denied_read_file_system_sandbox_policy() -> FileSystemSandboxPolicy
```

**Purpose**: Constructs a restricted filesystem policy that includes an explicit deny-read glob for `**/*.env`. It is used to verify that denied reads prevent unsafe sandbox bypass.

**Data flow**: Builds two `FileSystemSandboxEntry` values: root read access and a deny rule for the glob `**/*.env`, wraps them in `FileSystemSandboxPolicy::restricted`, and returns the policy.

**Call relations**: Denied-read-specific tests use this helper to confirm that escalation logic preserves deny-read restrictions.

*Call graph*: calls 1 internal fn (restricted); called by 2 (denied_reads_keep_granular_sandbox_rejection_for_escalation, denied_reads_keep_prefix_rule_allow_inside_sandbox); 1 external calls (vec!).


##### `test_sandbox_cwd`  (lines 92–94)

```
fn test_sandbox_cwd() -> AbsolutePathBuf
```

**Purpose**: Produces a stable absolute workspace path for sandbox-related tests. It avoids repeating path construction boilerplate in async tests.

**Data flow**: Calls `host_absolute_path(["workspace"])`, converts the resulting string into `AbsolutePathBuf` with `try_from`, unwraps success, and returns it.

**Call relations**: Used by tests that need a cwd for `CoreShellCommandExecutor` or `CoreShellActionProvider` setup.

*Call graph*: calls 2 internal fn (host_absolute_path, try_from); called by 4 (denied_reads_keep_granular_sandbox_rejection_for_escalation, denied_reads_keep_prefix_rule_allow_inside_sandbox, preapproved_additional_permissions_escalate_intercepted_exec, unsandboxed_intercepted_exec_strips_managed_network_env).


##### `execve_prompt_rejection_keeps_prefix_rules_on_rules_flag`  (lines 97–111)

```
fn execve_prompt_rejection_keeps_prefix_rules_on_rules_flag()
```

**Purpose**: Verifies that prompt decisions caused by explicit prefix rules are rejected when granular approval disables rule approvals. This protects the distinction between rule prompts and sandbox prompts.

**Data flow**: Constructs a granular `AskForApproval` with `rules: false`, calls `execve_prompt_is_rejected_by_policy` with `DecisionSource::PrefixRule`, and asserts the returned rejection reason string.

**Call relations**: This test directly targets the policy-gating helper used by `CoreShellActionProvider::process_decision`.

*Call graph*: 1 external calls (assert_eq!).


##### `execve_prompt_rejection_keeps_unmatched_commands_on_sandbox_flag`  (lines 114–128)

```
fn execve_prompt_rejection_keeps_unmatched_commands_on_sandbox_flag()
```

**Purpose**: Verifies that prompt decisions caused by unmatched-command fallback are rejected when granular approval disables sandbox approvals. It confirms the fallback path uses the sandbox-specific granular flag.

**Data flow**: Builds a granular `AskForApproval` with `sandbox_approval: false`, calls `execve_prompt_is_rejected_by_policy` with `DecisionSource::UnmatchedCommandFallback`, and asserts the expected rejection reason.

**Call relations**: This complements the previous test by covering the other branch in the prompt-rejection helper.

*Call graph*: 1 external calls (assert_eq!).


##### `approval_sandbox_permissions_only_downgrades_preapproved_additional_permissions`  (lines 131–153)

```
fn approval_sandbox_permissions_only_downgrades_preapproved_additional_permissions()
```

**Purpose**: Checks that approval-time sandbox permission downgrading happens only for preapproved additional-permission requests and leaves other permission modes untouched. This preserves execution semantics while suppressing redundant prompts.

**Data flow**: Calls `approval_sandbox_permissions` with combinations of `WithAdditionalPermissions`, `RequireEscalated`, and the preapproved flag, then asserts the returned `SandboxPermissions` values.

**Call relations**: It validates the helper used when constructing `CoreShellActionProvider` in both shell and unified-exec zsh-fork flows.

*Call graph*: 1 external calls (assert_eq!).


##### `extract_shell_script_preserves_login_flag`  (lines 156–173)

```
fn extract_shell_script_preserves_login_flag()
```

**Purpose**: Ensures shell-script extraction distinguishes `-lc` from `-c` and records the login-shell bit correctly. This matters because zsh-fork passes the login flag into `ExecParams`.

**Data flow**: Calls `extract_shell_script` on simple `/bin/zsh -lc ...` and `/bin/zsh -c ...` vectors, unwraps the results, and asserts exact `ParsedShellCommand` equality.

**Call relations**: This test covers the happy-path parser behavior used by both zsh-fork execution and unified-exec preparation.

*Call graph*: 1 external calls (assert_eq!).


##### `extract_shell_script_supports_wrapped_command_prefixes`  (lines 176–209)

```
fn extract_shell_script_supports_wrapped_command_prefixes()
```

**Purpose**: Verifies that shell-script extraction can find the inner shell invocation even when wrapper arguments precede it. This matches the production parser’s sliding-window search behavior.

**Data flow**: Builds wrapped command vectors using `/usr/bin/env` and `sandbox-exec`, calls `extract_shell_script`, unwraps, and asserts the parsed program/script/login fields.

**Call relations**: It protects the parser behavior relied on when sandbox or env wrappers are inserted before the shell command.

*Call graph*: 1 external calls (assert_eq!).


##### `extract_shell_script_rejects_unsupported_shell_invocation`  (lines 212–227)

```
fn extract_shell_script_rejects_unsupported_shell_invocation()
```

**Purpose**: Confirms that unsupported shell invocation shapes are rejected with the expected `ToolError::Rejected` message. This prevents zsh-fork from silently misinterpreting malformed commands.

**Data flow**: Calls `extract_shell_script` on an unsupported `-fc` form, captures the error, asserts that it matches `ToolError::Rejected`, and checks the exact rejection string.

**Call relations**: This covers the parser’s failure path used by both `try_run_zsh_fork` and `prepare_unified_exec_zsh_fork` to decide whether to fall back.

*Call graph*: 3 external calls (assert!, assert_eq!, extract_shell_script).


##### `join_program_and_argv_replaces_original_argv_zero`  (lines 230–245)

```
fn join_program_and_argv_replaces_original_argv_zero()
```

**Purpose**: Checks that command normalization replaces the original `argv[0]` with the resolved absolute program path instead of duplicating it. This keeps policy matching and approval display accurate.

**Data flow**: Calls `join_program_and_argv` with an absolute `/tmp/tool` path and argv vectors containing `./tool`, then asserts the resulting vectors.

**Call relations**: It validates the normalization helper used in prompt display and escalated exec preparation.

*Call graph*: 1 external calls (assert_eq!).


##### `commands_for_intercepted_exec_policy_parses_plain_shell_wrappers`  (lines 248–263)

```
fn commands_for_intercepted_exec_policy_parses_plain_shell_wrappers()
```

**Purpose**: Verifies that plain shell-wrapper parsing splits a `bash -lc` script containing `&&` into multiple candidate commands for policy evaluation. This enables prefix rules to match inner commands rather than only the shell wrapper.

**Data flow**: Builds an absolute bash path, calls `commands_for_intercepted_exec_policy` with `-lc 'git status && pwd'`, and asserts both the parsed command list and `used_complex_parsing == false`.

**Call relations**: This test targets the candidate-command extraction helper used by `evaluate_intercepted_exec_policy` when shell-wrapper parsing is enabled.

*Call graph*: calls 2 internal fn (host_absolute_path, try_from); 3 external calls (assert!, assert_eq!, commands_for_intercepted_exec_policy).


##### `map_exec_result_preserves_stdout_and_stderr`  (lines 266–283)

```
fn map_exec_result_preserves_stdout_and_stderr()
```

**Purpose**: Ensures successful result mapping preserves stdout, stderr, and aggregated output text exactly. It checks the non-error branch of zsh-fork result conversion.

**Data flow**: Constructs an `ExecResult` with distinct output fields, calls `map_exec_result` with `SandboxType::None`, unwraps the output, and asserts the three text fields.

**Call relations**: This covers the success path of the mapper used at the end of `try_run_zsh_fork`.

*Call graph*: 3 external calls (from_millis, assert_eq!, map_exec_result).


##### `shell_request_escalation_execution_is_explicit`  (lines 286–355)

```
fn shell_request_escalation_execution_is_explicit()
```

**Purpose**: Checks the mapping from shell-request sandbox permissions to `EscalationExecution`, including unsandboxed execution, turn-default fallback, and resolved permission-profile escalation for additional permissions. It documents the intended semantics of shell-request escalation.

**Data flow**: Builds requested additional permissions, filesystem/network policies, and a `PermissionProfile`, then calls `CoreShellActionProvider::shell_request_escalation_execution` with several permission-mode combinations and asserts the exact `EscalationExecution` results.

**Call relations**: This test targets the helper used by `CoreShellActionProvider::determine_action` for unmatched-command fallback decisions.

*Call graph*: calls 4 internal fn (read_only_file_system_sandbox_policy, from_read_write_roots, from_runtime_permissions, restricted); 3 external calls (default, assert_eq!, vec!).


##### `unsandboxed_intercepted_exec_strips_managed_network_env`  (lines 358–404)

```
async fn unsandboxed_intercepted_exec_strips_managed_network_env() -> anyhow::Result<()>
```

**Purpose**: Verifies that preparing an unsandboxed intercepted exec removes managed-network proxy environment variables. This prevents proxy-only sandbox plumbing from leaking into unsandboxed execution.

**Data flow**: Builds a `CoreShellCommandExecutor` with no network proxy, constructs an env map containing `PROXY_ACTIVE_ENV_KEY` and all `PROXY_ENV_KEYS`, calls `prepare_escalated_exec` with `EscalationExecution::Unsandboxed`, and asserts that the resulting `PreparedExec.env` omits those keys.

**Call relations**: It exercises the unsandboxed branch of `CoreShellCommandExecutor::prepare_escalated_exec`, specifically the env filtering performed by `exec_env_for_sandbox_permissions`.

*Call graph*: calls 4 internal fn (read_only_file_system_sandbox_policy, test_sandbox_cwd, workspace_write, from_absolute_path); 5 external calls (new, new, assert!, format!, vec!).


##### `preapproved_additional_permissions_escalate_intercepted_exec`  (lines 407–457)

```
async fn preapproved_additional_permissions_escalate_intercepted_exec() -> anyhow::Result<()>
```

**Purpose**: Confirms that when additional permissions were preapproved, intercepted exec policy still chooses escalation through the resolved permission profile rather than treating the command as plain unsandboxed execution. Approval-time downgrading should not erase execution-time permissions.

**Data flow**: Creates a session and turn context, builds requested additional permissions and an effective merged permission profile, constructs a `CoreShellActionProvider` with `sandbox_permissions: WithAdditionalPermissions` but `approval_sandbox_permissions: UseDefault`, calls the `EscalationPolicy::determine_action` trait method for `/usr/bin/printf`, and asserts the exact `EscalationDecision::Escalate(ResolvedPermissionProfile(...))`.

**Call relations**: This test covers the interaction between `approval_sandbox_permissions`, policy fallback evaluation, and `shell_request_escalation_execution` inside `determine_action`.

*Call graph*: calls 8 internal fn (make_session_and_context, read_only_file_system_sandbox_policy, test_sandbox_cwd, from_read_write_roots, workspace_write, effective_permission_profile, new, from_absolute_path); 11 external calls (new, default, from_secs, new, assert_eq!, empty, ResolvedPermissionProfile, Escalate, Permissions, determine_action (+1 more)).


##### `execve_permission_request_hook_short_circuits_prompt`  (lines 460–609)

```
async fn execve_permission_request_hook_short_circuits_prompt() -> anyhow::Result<()>
```

**Purpose**: Verifies that a trusted permission-request hook can approve an intercepted execve request before Guardian or user prompting occurs. It also checks that the hook receives the expected bash-style command payload.

**Data flow**: Creates a session and mutable turn context, writes a temporary hook script and `hooks.json`, marks the hook trusted in config, installs the resulting `Hooks` into session services, configures approval policy and permission profile, builds a `CoreShellActionProvider`, and calls `EscalationPolicy::determine_action` under a timeout for `/usr/bin/touch`. It asserts the returned action is unsandboxed escalation, then reads the hook log JSONL file and asserts the logged `tool_input.command` and `description` fields.

**Call relations**: This test exercises the hook-first branch inside `CoreShellActionProvider::prompt`, proving that `run_permission_request_hooks` can short-circuit the rest of the approval pipeline.

*Call graph*: calls 10 internal fn (allow_any, make_session_and_context, read_only_file_system_sandbox_policy, new, from_runtime_permissions, read_only, shlex_join, new, from_absolute_path, try_from); 22 external calls (new, from_secs, new, assert!, assert_eq!, list_hooks, empty, format!, default, from_value (+12 more)).


##### `evaluate_intercepted_exec_policy_uses_wrapper_command_when_shell_wrapper_parsing_disabled`  (lines 612–660)

```
fn evaluate_intercepted_exec_policy_uses_wrapper_command_when_shell_wrapper_parsing_disabled()
```

**Purpose**: Checks that when shell-wrapper parsing is disabled, policy evaluation treats the whole wrapper command as the candidate command and therefore falls back to heuristics for `/bin/zsh -lc ...`. This preserves the intended default of relying on later execve interception rather than weak shell-script parsing.

**Data flow**: Builds a policy with `prefix_rule(["npm", "publish"], prompt)`, constructs an absolute zsh path, calls `evaluate_intercepted_exec_policy` with parsing disabled and argv `zsh -lc 'npm publish'`, and asserts that the result is a heuristics allow match against the wrapper command.

**Call relations**: It targets the disabled-parsing branch of `evaluate_intercepted_exec_policy` and documents why wrapper parsing is off by default.

*Call graph*: calls 4 internal fn (host_absolute_path, new, read_only, try_from); 2 external calls (assert!, evaluate_intercepted_exec_policy).


##### `evaluate_intercepted_exec_policy_matches_inner_shell_commands_when_enabled`  (lines 663–700)

```
fn evaluate_intercepted_exec_policy_matches_inner_shell_commands_when_enabled()
```

**Purpose**: Verifies that enabling shell-wrapper parsing lets exec policy match the inner command inside `bash -lc 'npm publish'`. This demonstrates the alternate parsing mode used only when explicitly enabled.

**Data flow**: Builds the same prompting policy, constructs an absolute bash path, calls `evaluate_intercepted_exec_policy` with parsing enabled, and asserts the returned `Evaluation` contains a `PrefixRuleMatch` for `npm publish` with `Decision::Prompt`.

**Call relations**: This complements the previous test by covering the enabled-parsing branch of policy evaluation.

*Call graph*: calls 4 internal fn (host_absolute_path, new, read_only, try_from); 2 external calls (assert_eq!, evaluate_intercepted_exec_policy).


##### `intercepted_exec_policy_uses_host_executable_mappings`  (lines 703–746)

```
fn intercepted_exec_policy_uses_host_executable_mappings()
```

**Purpose**: Checks that host executable mappings allow a rule written for `git` to match an intercepted absolute `/usr/bin/git` path. It also verifies that such a match counts as policy-driven rather than heuristic fallback.

**Data flow**: Builds a policy containing both a `prefix_rule` and `host_executable` mapping for git, constructs the absolute git path, calls `evaluate_intercepted_exec_policy`, asserts the exact `Evaluation` with `resolved_program: Some(program)`, and then asserts `CoreShellActionProvider::decision_driven_by_policy(...)` is true.

**Call relations**: This test covers host executable resolution inside `evaluate_intercepted_exec_policy` and the downstream classification helper used by `determine_action`.

*Call graph*: calls 5 internal fn (host_absolute_path, starlark_string, new, read_only, try_from); 4 external calls (assert!, assert_eq!, format!, evaluate_intercepted_exec_policy).


##### `denied_reads_keep_prefix_rule_allow_inside_sandbox`  (lines 749–793)

```
async fn denied_reads_keep_prefix_rule_allow_inside_sandbox() -> anyhow::Result<()>
```

**Purpose**: Verifies that even when a prefix rule explicitly allows a command, denied-read filesystem restrictions keep execution inside the sandbox rather than escalating unsandboxed. This prevents policy allow rules from silently dropping deny-read enforcement.

**Data flow**: Builds a policy allowing the absolute `cat` path, creates session/turn context and a deny-read filesystem policy, constructs a `CoreShellActionProvider` with `SandboxPermissions::UseDefault`, calls `EscalationPolicy::determine_action` for `cat /tmp/visible.txt`, and asserts the result is `EscalationDecision::Run`.

**Call relations**: It exercises `determine_action`’s `unsandboxed_execution_allowed` check and the prefix-rule escalation-selection logic.

*Call graph*: calls 9 internal fn (make_session_and_context, denied_read_file_system_sandbox_policy, host_absolute_path, starlark_string, test_sandbox_cwd, new, from_runtime_permissions, new, try_from); 6 external calls (new, from_secs, new, assert_eq!, format!, determine_action).


##### `denied_reads_keep_granular_sandbox_rejection_for_escalation`  (lines 796–840)

```
async fn denied_reads_keep_granular_sandbox_rejection_for_escalation() -> anyhow::Result<()>
```

**Purpose**: Checks that when denied reads are active and granular policy disables sandbox approval, an unmatched command requiring escalation is denied rather than prompted or unsandboxed. This preserves the sandbox-approval gate even under deny-read constraints.

**Data flow**: Creates session/turn context, a deny-read filesystem policy, and a `CoreShellActionProvider` with `SandboxPermissions::RequireEscalated` and granular approval disabling sandbox approval, then calls `EscalationPolicy::determine_action` for `/usr/bin/printf` and asserts the result is `EscalationDecision::Deny { reason: Some("Execution forbidden by policy") }`.

**Call relations**: This test covers the interaction between denied-read preservation, unmatched-command fallback, and `execve_prompt_is_rejected_by_policy` inside `process_decision`.

*Call graph*: calls 8 internal fn (make_session_and_context, denied_read_file_system_sandbox_policy, host_absolute_path, test_sandbox_cwd, new, from_runtime_permissions, new, try_from); 6 external calls (new, from_secs, new, Granular, assert_eq!, determine_action).


##### `intercepted_exec_policy_treats_preapproved_additional_permissions_as_default`  (lines 843–880)

```
fn intercepted_exec_policy_treats_preapproved_additional_permissions_as_default()
```

**Purpose**: Verifies that approval-time policy evaluation treats preapproved additional-permission requests like default sandbox permissions, while fresh additional-permission requests still prompt. This is the core semantic of `approval_sandbox_permissions`.

**Data flow**: Builds an empty policy, an absolute printf path, and a workspace-write permission profile. It evaluates the same command twice with `evaluate_intercepted_exec_policy`: once using `approval_sandbox_permissions(WithAdditionalPermissions, true)` and once using raw `WithAdditionalPermissions`. It asserts the first decision is `Allow` and the second is `Prompt`.

**Call relations**: This directly validates the approval-time permission normalization used when constructing `CoreShellActionProvider`.

*Call graph*: calls 4 internal fn (host_absolute_path, new, workspace_write, try_from); 3 external calls (assert_eq!, approval_sandbox_permissions, evaluate_intercepted_exec_policy).


##### `intercepted_exec_policy_rejects_disallowed_host_executable_mapping`  (lines 883–920)

```
fn intercepted_exec_policy_rejects_disallowed_host_executable_mapping()
```

**Purpose**: Checks that a host executable mapping does not match an intercepted executable path outside the allowed mapped paths. In that case evaluation should fall back to heuristics rather than treating the command as policy-matched.

**Data flow**: Builds a policy mapping `git` only to one absolute path, constructs a different absolute git path, calls `evaluate_intercepted_exec_policy`, asserts the matched rule is a heuristics rule against the actual path, and asserts `decision_driven_by_policy` is false.

**Call relations**: This covers the negative case for host executable resolution inside policy evaluation.

*Call graph*: calls 5 internal fn (host_absolute_path, starlark_string, new, read_only, try_from); 3 external calls (assert!, format!, evaluate_intercepted_exec_policy).


### Execution and unified-exec internals
This final group exercises end-to-end command execution, MCP tool-call dispatch, and the lower-level unified-exec buffering, process, and manager internals.

### `core/src/exec_tests.rs`

`test` · `cross-cutting`

This file is the regression and specification suite for the execution layer defined in the parent module. It builds concrete `ExecParams`, `PermissionProfile`, and `FileSystemSandboxPolicy` values, launches real child processes through Tokio, and verifies the exact semantics of output retention, process lifetime control, and sandbox compatibility decisions. A small helper, `make_exec_output`, fabricates `ExecToolCallOutput` values so sandbox-denial detection can be tested without spawning processes.

The tests are organized around a few critical behaviors. First, sandbox denial detection must only trigger for real sandbox contexts, must inspect stderr and aggregated output, and must ignore easy false positives such as exit code 127 or network-policy marker text in unsandboxed/zero-exit cases. Second, output capture is validated in both capped shell-tool mode and uncapped full-buffer mode: `read_output` must truncate retained bytes only when configured to do so, and `aggregate_output` must preferentially reserve more capacity for stderr when stdout/stderr compete for a capped buffer. Third, `ExecCapturePolicy::FullBuffer` is tested as a policy override that disables execution expiration but still preserves the I/O drain guard so descendants holding pipes open cannot block forever.

The remainder of the file targets sandbox policy translation, especially Windows restricted-token versus elevated backends. These tests construct nuanced filesystem permission sets—workspace writes, root writes, read carveouts, deny carveouts, glob denies—and assert whether helper functions reject unsafe unsandboxed fallbacks or synthesize precise `WindowsSandboxFilesystemOverrides`. Unix-only tests additionally verify process-group termination on timeout and cancellation, including graceful SIGTERM cleanup before escalation.

#### Function details

##### `make_exec_output`  (lines 13–27)

```
fn make_exec_output(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
    aggregated: &str,
) -> ExecToolCallOutput
```

**Purpose**: Builds a minimal `ExecToolCallOutput` fixture with caller-specified exit code and output streams so sandbox-detection logic can be exercised without running a child process.

**Data flow**: Takes `exit_code`, `stdout`, `stderr`, and `aggregated` string slices; converts each textual stream into `StreamOutput` via `StreamOutput::new`, sets a fixed 1 ms `duration`, and hardcodes `timed_out` to `false`. Returns a fully populated `ExecToolCallOutput` value and does not mutate external state.

**Call relations**: Used only by the sandbox-detection tests in this file as a common constructor before they invoke `is_likely_sandbox_denied` under different sandbox types, exit codes, and output-text combinations.

*Call graph*: calls 1 internal fn (new); called by 8 (sandbox_detection_flags_sigsys_exit_code, sandbox_detection_identifies_keyword_in_stderr, sandbox_detection_ignores_network_policy_text_in_non_sandbox_mode, sandbox_detection_ignores_network_policy_text_with_zero_exit_code, sandbox_detection_ignores_non_sandbox_mode, sandbox_detection_requires_keywords, sandbox_detection_respects_quick_reject_exit_codes, sandbox_detection_uses_aggregated_output); 1 external calls (from_millis).


##### `sandbox_detection_requires_keywords`  (lines 30–36)

```
fn sandbox_detection_requires_keywords()
```

**Purpose**: Verifies that a generic nonzero exit code alone is insufficient to classify an execution failure as sandbox denial.

**Data flow**: Creates an `ExecToolCallOutput` with exit code 1 and empty outputs, passes it to `is_likely_sandbox_denied` with `SandboxType::LinuxSeccomp`, and asserts the returned boolean is false.

**Call relations**: This is a direct unit test of the denial heuristic’s negative path: it sets up input with `make_exec_output` and stops at the assertion, proving no keyword-less failure should be treated as sandbox rejection.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_identifies_keyword_in_stderr`  (lines 39–42)

```
fn sandbox_detection_identifies_keyword_in_stderr()
```

**Purpose**: Checks that denial keywords found in stderr cause the heuristic to flag a likely sandbox failure for seccomp executions.

**Data flow**: Builds output with exit code 1 and stderr text `Operation not permitted`, feeds it to `is_likely_sandbox_denied`, and asserts a true result.

**Call relations**: Acts as the positive counterpart to the previous test, demonstrating that when the same nonzero failure includes a recognizable denial phrase, the heuristic should switch to reporting a sandbox denial.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_respects_quick_reject_exit_codes`  (lines 45–51)

```
fn sandbox_detection_respects_quick_reject_exit_codes()
```

**Purpose**: Ensures fast-fail exit codes associated with unrelated command errors do not get misclassified as sandbox denials, even if stderr contains suspicious text.

**Data flow**: Constructs an output with exit code 127 and stderr `command not found`, invokes `is_likely_sandbox_denied` for Linux seccomp, and asserts false.

**Call relations**: This test covers a guard branch in the heuristic: the caller supplies a shell-style command-resolution failure and expects the helper to reject sandbox interpretation immediately.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_ignores_non_sandbox_mode`  (lines 54–57)

```
fn sandbox_detection_ignores_non_sandbox_mode()
```

**Purpose**: Verifies that denial-like stderr text is ignored when no sandbox backend is active.

**Data flow**: Builds an output with `Operation not permitted` in stderr, calls `is_likely_sandbox_denied` with `SandboxType::None`, and asserts the result is false.

**Call relations**: This test isolates the sandbox-type precondition for denial detection, confirming that the helper should short-circuit when execution was unsandboxed.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_ignores_network_policy_text_in_non_sandbox_mode`  (lines 60–68)

```
fn sandbox_detection_ignores_network_policy_text_in_non_sandbox_mode()
```

**Purpose**: Checks that embedded network-policy decision markers do not look like sandbox failures when the process was not sandboxed.

**Data flow**: Creates an output whose aggregated stream contains a `CODEX_NETWORK_POLICY_DECISION` JSON line and whose exit code is 0, then calls `is_likely_sandbox_denied` with `SandboxType::None` and asserts false.

**Call relations**: This is another false-positive regression test around denial detection, specifically for protocol text emitted by network controls rather than OS-level sandbox failures.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_uses_aggregated_output`  (lines 71–82)

```
fn sandbox_detection_uses_aggregated_output()
```

**Purpose**: Confirms that the heuristic examines the combined output buffer, not just stderr, when looking for sandbox-denial evidence.

**Data flow**: Builds output with exit code 101, empty stdout/stderr, and aggregated text containing `Read-only file system`, then asserts that `is_likely_sandbox_denied` for `SandboxType::MacosSeatbelt` returns true.

**Call relations**: This test drives the branch where denial clues appear only in `aggregated_output`, documenting that post-processing or merged output is part of the heuristic’s search space.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_ignores_network_policy_text_with_zero_exit_code`  (lines 85–97)

```
fn sandbox_detection_ignores_network_policy_text_with_zero_exit_code()
```

**Purpose**: Ensures successful execution with network-policy marker text is not classified as sandbox denial even when a sandbox backend is present.

**Data flow**: Constructs an output with exit code 0 and aggregated text containing a `CODEX_NETWORK_POLICY_DECISION` line, passes it to `is_likely_sandbox_denied` for Linux seccomp, and asserts false.

**Call relations**: Complements the non-sandbox test above by showing that success status itself suppresses denial classification for network-policy metadata.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `read_output_limits_retained_bytes_for_shell_capture`  (lines 100–116)

```
async fn read_output_limits_retained_bytes_for_shell_capture()
```

**Purpose**: Tests that `read_output` enforces a byte-retention cap when shell-style capture is requested.

**Data flow**: Creates an in-memory Tokio duplex pipe, spawns a writer that sends more than twice `EXEC_OUTPUT_MAX_BYTES`, then awaits `read_output` with `max_bytes` set to `Some(EXEC_OUTPUT_MAX_BYTES * 2)`. It asserts that the returned `StreamOutput.text` length equals exactly the configured cap.

**Call relations**: This is a low-level async I/O test of the output reader; it drives `read_output` directly rather than the full process executor so the retention policy can be verified in isolation.

*Call graph*: 4 external calls (assert_eq!, duplex, spawn, vec!).


##### `aggregate_output_prefers_stderr_on_contention`  (lines 119–136)

```
fn aggregate_output_prefers_stderr_on_contention()
```

**Purpose**: Validates the aggregation rule that a capped merged buffer allocates a larger share to stderr when both streams are at capacity.

**Data flow**: Builds `stdout` and `stderr` `StreamOutput` values each with `EXEC_OUTPUT_MAX_BYTES` bytes, invokes `aggregate_output` with that cap, computes the expected one-third stdout / remainder stderr split, and asserts both overall length and exact byte layout.

**Call relations**: This test covers the balancing logic inside aggregation when both streams would overflow the merged cap, documenting stderr’s priority during contention.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `aggregate_output_fills_remaining_capacity_with_stderr`  (lines 139–156)

```
fn aggregate_output_fills_remaining_capacity_with_stderr()
```

**Purpose**: Checks that when stdout is smaller than its nominal budget, stderr expands to consume all remaining capped capacity.

**Data flow**: Creates a short stdout buffer and a full-size stderr buffer, calls `aggregate_output` with the global cap, then verifies the output starts with all stdout bytes and uses the rest of the capacity for stderr bytes.

**Call relations**: This test exercises the rebalance path where the preferred stderr share grows because stdout under-utilizes the cap.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `aggregate_output_rebalances_when_stderr_is_small`  (lines 159–175)

```
fn aggregate_output_rebalances_when_stderr_is_small()
```

**Purpose**: Ensures the aggregation logic symmetrically shifts capacity back to stdout when stderr is tiny.

**Data flow**: Supplies full-size stdout and 1-byte stderr to `aggregate_output` under a cap, then asserts the merged result contains `cap - 1` stdout bytes followed by the single stderr byte.

**Call relations**: Together with the previous test, this verifies that the cap split is adaptive rather than fixed, preserving as much content as possible while still respecting stream ordering.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `aggregate_output_keeps_stdout_then_stderr_when_under_cap`  (lines 178–195)

```
fn aggregate_output_keeps_stdout_then_stderr_when_under_cap()
```

**Purpose**: Verifies that if the combined streams fit under the cap, aggregation preserves all bytes in simple stdout-then-stderr order and reports no truncation metadata.

**Data flow**: Builds small `stdout` and `stderr` buffers, concatenates their bytes into an `expected` vector, runs `aggregate_output`, and asserts `aggregated.text == expected` and `aggregated.truncated_after_lines == None`.

**Call relations**: This test covers the non-overflow path of aggregation, establishing the base ordering and metadata behavior before any cap-driven truncation logic applies.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `read_output_retains_all_bytes_for_full_buffer_capture`  (lines 198–214)

```
async fn read_output_retains_all_bytes_for_full_buffer_capture()
```

**Purpose**: Checks that `read_output` preserves the entire stream when no byte cap is supplied, matching full-buffer capture semantics.

**Data flow**: Creates a duplex reader/writer pair, spawns a writer that sends slightly more than `EXEC_OUTPUT_MAX_BYTES`, then awaits `read_output` with `max_bytes` set to `None` and asserts the returned byte length equals the full amount written.

**Call relations**: This complements the capped-reader test and demonstrates the raw reader behavior required by `ExecCapturePolicy::FullBuffer`.

*Call graph*: 4 external calls (assert_eq!, duplex, spawn, vec!).


##### `aggregate_output_keeps_all_bytes_when_uncapped`  (lines 217–238)

```
fn aggregate_output_keeps_all_bytes_when_uncapped()
```

**Purpose**: Ensures merged output is lossless when aggregation is invoked without a maximum byte count.

**Data flow**: Constructs max-sized stdout and stderr buffers, calls `aggregate_output` with `None`, and asserts the result length is the sum of both inputs with exact stdout prefix and stderr suffix preserved.

**Call relations**: This test documents the uncapped aggregation branch used by full-buffer capture paths.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `full_buffer_capture_policy_disables_caps_and_exec_expiration`  (lines 241–248)

```
fn full_buffer_capture_policy_disables_caps_and_exec_expiration()
```

**Purpose**: Asserts the policy-level contract of `ExecCapturePolicy::FullBuffer`: no retained-byte cap, standard I/O drain timeout, and no execution expiration enforcement.

**Data flow**: Reads `retained_bytes_cap`, `io_drain_timeout`, and `uses_expiration` from `ExecCapturePolicy::FullBuffer` and compares them to `None`, `Duration::from_millis(IO_DRAIN_TIMEOUT_MS)`, and `false` respectively.

**Call relations**: This is a pure policy test, validating the methods later relied on by the async execution tests that spawn real commands.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `exec_full_buffer_capture_ignores_expiration`  (lines 251–292)

```
async fn exec_full_buffer_capture_ignores_expiration() -> Result<()>
```

**Purpose**: Verifies that `exec` does not treat the nominal expiration as a kill deadline when capture policy is `FullBuffer`.

**Data flow**: Builds an `ExecParams` with a short-lived shell or PowerShell command, `expiration` set to 1 ms, and `capture_policy` set to `ExecCapturePolicy::FullBuffer`; calls `exec`; then asserts stdout contains `hello` and `timed_out` is false.

**Call relations**: This is an integration test of the top-level executor, showing that full-buffer capture changes process-lifetime semantics, not just output buffering.

*Call graph*: calls 1 internal fn (current_dir); 4 external calls (assert!, assert_eq!, vars, vec!).


##### `exec_full_buffer_capture_keeps_io_drain_timeout_when_descendant_holds_pipe_open`  (lines 296–329)

```
async fn exec_full_buffer_capture_keeps_io_drain_timeout_when_descendant_holds_pipe_open() -> Result<()>
```

**Purpose**: Ensures full-buffer mode still preserves the post-exit I/O drain guard so a background descendant holding stdout open cannot stall `exec` forever.

**Data flow**: Runs a Unix shell command that prints `hello` and backgrounds `sleep 30`, wraps `exec` in an outer Tokio `timeout` of three times `IO_DRAIN_TIMEOUT_MS`, and asserts the call returns before the outer timeout and does not mark the execution as timed out.

**Call relations**: This test targets a subtle interaction: execution expiration is disabled in full-buffer mode, but the separate I/O drain timeout must remain active to bound stuck pipe drains.

*Call graph*: calls 1 internal fn (current_dir); 5 external calls (from_millis, assert!, vars, timeout, vec!).


##### `process_exec_tool_call_preserves_full_buffer_capture_policy`  (lines 332–378)

```
async fn process_exec_tool_call_preserves_full_buffer_capture_policy() -> Result<()>
```

**Purpose**: Checks that the higher-level tool-call path forwards `ExecCapturePolicy::FullBuffer` unchanged and therefore returns large stdout without truncation or timeout.

**Data flow**: Creates an `ExecParams` that emits more than `EXEC_OUTPUT_MAX_BYTES`, invokes `process_exec_tool_call` with disabled permissions and a single-root workspace, then asserts `timed_out` is false and `output.stdout.text.len()` equals the full generated byte count.

**Call relations**: This is the orchestration-layer analogue of the raw `exec` tests: instead of calling the low-level executor directly, it verifies that request-building and policy translation in `process_exec_tool_call` do not accidentally downgrade capture behavior.

*Call graph*: calls 1 internal fn (current_dir); 5 external calls (assert!, assert_eq!, vars, from_ref, vec!).


##### `windows_restricted_token_skips_external_sandbox_policies`  (lines 381–387)

```
fn windows_restricted_token_skips_external_sandbox_policies()
```

**Purpose**: Verifies that externally managed permission profiles are considered unsupported for the restricted-token Windows sandbox path.

**Data flow**: Constructs `PermissionProfile::External { network: NetworkSandboxPolicy::Restricted }`, passes it to `permission_profile_supports_windows_restricted_token_sandbox`, and asserts the boolean result is false.

**Call relations**: This is a narrow policy-compatibility test for the Windows sandbox selection logic, documenting that the helper excludes external policy ownership.

*Call graph*: 1 external calls (assert!).


##### `windows_restricted_token_supports_read_only_profiles`  (lines 390–394)

```
fn windows_restricted_token_supports_read_only_profiles()
```

**Purpose**: Checks that built-in read-only permission profiles are accepted by the Windows restricted-token backend.

**Data flow**: Builds a `PermissionProfile` via `PermissionProfile::read_only()`, evaluates `permission_profile_supports_windows_restricted_token_sandbox`, and asserts true.

**Call relations**: This complements the previous negative test by covering a known-supported profile shape.

*Call graph*: calls 1 internal fn (read_only); 1 external calls (assert!).


##### `windows_proxy_enforcement_uses_elevated_backend`  (lines 397–410)

```
fn windows_proxy_enforcement_uses_elevated_backend()
```

**Purpose**: Verifies the backend-selection rule for Windows sandboxing when proxy-enforced networking is active.

**Data flow**: Calls `windows_sandbox_uses_elevated_backend` three times with different combinations of `WindowsSandboxLevel` and `proxy_enforced`, asserting that restricted-token without proxy uses the non-elevated backend, while restricted-token with proxy and explicit elevated mode both select the elevated backend.

**Call relations**: This test captures the dispatch logic that later influences which filesystem-override helper is allowed to handle a permission profile.

*Call graph*: 1 external calls (assert!).


##### `windows_restricted_token_rejects_network_only_restrictions`  (lines 413–431)

```
fn windows_restricted_token_rejects_network_only_restrictions()
```

**Purpose**: Ensures the Windows restricted-token backend refuses profiles that require network restriction without any enforceable filesystem restriction, rather than silently running unsandboxed.

**Data flow**: Builds a managed `PermissionProfile` from unrestricted filesystem permissions plus `NetworkSandboxPolicy::Restricted`, computes `sandbox_policy_cwd`, passes all of that to `unsupported_windows_restricted_token_sandbox_reason`, and asserts the exact rejection string.

**Call relations**: This is a policy-validation test for the helper that explains unsupported combinations; it exercises the branch that returns a human-readable refusal reason instead of `None`.

*Call graph*: calls 3 internal fn (from_runtime_permissions, unrestricted, current_dir); 1 external calls (assert_eq!).


##### `windows_restricted_token_rejects_managed_root_write_profiles`  (lines 434–461)

```
fn windows_restricted_token_rejects_managed_root_write_profiles()
```

**Purpose**: Checks that a managed profile granting writable root access is rejected as unenforceable by the restricted-token backend.

**Data flow**: Constructs a restricted filesystem policy with a `Root` write entry, turns it into a `PermissionProfile`, calls `unsupported_windows_restricted_token_sandbox_reason` for the restricted-token level, and asserts the detailed refusal message.

**Call relations**: This test targets a stronger filesystem capability than workspace-write and verifies that the compatibility checker blocks it before execution could fall back unsafely.

*Call graph*: calls 3 internal fn (from_runtime_permissions, restricted, current_dir); 2 external calls (assert_eq!, vec!).


##### `windows_restricted_token_allows_read_only_profiles`  (lines 464–477)

```
fn windows_restricted_token_allows_read_only_profiles()
```

**Purpose**: Verifies that read-only profiles produce no incompatibility reason for the restricted-token backend.

**Data flow**: Creates a read-only `PermissionProfile`, computes the current directory as sandbox policy cwd, calls `unsupported_windows_restricted_token_sandbox_reason`, and asserts the result is `None`.

**Call relations**: This is the successful counterpart to the rejection tests and demonstrates the helper’s contract when a profile is enforceable.

*Call graph*: calls 2 internal fn (read_only, current_dir); 1 external calls (assert_eq!).


##### `windows_restricted_token_allows_workspace_write_profiles`  (lines 480–498)

```
fn windows_restricted_token_allows_workspace_write_profiles()
```

**Purpose**: Checks that workspace-write profiles are considered enforceable by restricted-token sandboxing.

**Data flow**: Builds a profile via `PermissionProfile::workspace_write_with` using restricted networking and excluding temp-path extras, calls `unsupported_windows_restricted_token_sandbox_reason`, and asserts `None`.

**Call relations**: This documents a key compatibility projection: ordinary workspace-write permissions are allowed even though broader root-write profiles are not.

*Call graph*: calls 2 internal fn (workspace_write_with, current_dir); 1 external calls (assert_eq!).


##### `windows_elevated_allows_split_restricted_read_policies`  (lines 501–528)

```
fn windows_elevated_allows_split_restricted_read_policies()
```

**Purpose**: Verifies that the elevated Windows backend accepts a filesystem policy consisting of a specific read-only path restriction.

**Data flow**: Creates a temporary `docs` directory, builds a restricted filesystem policy containing a single path-based read entry, converts it to a `PermissionProfile`, and asserts that `unsupported_windows_restricted_token_sandbox_reason` returns `None` when the sandbox level is `Elevated`.

**Call relations**: This tests the policy checker’s elevated-backend branch, which can support split restricted read roots that the unelevated backend cannot.

*Call graph*: calls 3 internal fn (from_runtime_permissions, restricted, from_absolute_path); 4 external calls (assert_eq!, create_dir_all, new, vec!).


##### `windows_restricted_token_rejects_split_only_filesystem_policies`  (lines 531–569)

```
fn windows_restricted_token_rejects_split_only_filesystem_policies()
```

**Purpose**: Ensures the unelevated restricted-token backend rejects split filesystem policies that combine writable project roots with extra read-only carveouts.

**Data flow**: Creates a temp workspace with a `docs` subdirectory, builds a restricted policy with `project_roots` write plus explicit `docs` read, derives a `PermissionProfile`, and asserts the exact rejection message from `unsupported_windows_restricted_token_sandbox_reason`.

**Call relations**: This test covers a nuanced unsupported shape: split read restrictions that cannot be directly enforced by the non-elevated backend.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 4 external calls (assert_eq!, create_dir_all, new, vec!).


##### `windows_restricted_token_rejects_root_write_read_only_carveouts`  (lines 572–608)

```
fn windows_restricted_token_rejects_root_write_read_only_carveouts()
```

**Purpose**: Checks that the unelevated backend rejects profiles that mix writable root access with narrower read-only carveouts.

**Data flow**: Builds a policy containing `Root` write and an explicit path `Read` carveout, creates a `PermissionProfile`, and asserts `unsupported_windows_restricted_token_sandbox_reason` returns the root-set rejection string.

**Call relations**: This addresses another unsupported split-policy shape, distinct from workspace-write, and verifies the helper reports why that combination cannot be safely projected.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 4 external calls (assert_eq!, create_dir_all, new, vec!).


##### `windows_restricted_token_supports_full_read_split_write_read_carveouts`  (lines 611–663)

```
fn windows_restricted_token_supports_full_read_split_write_read_carveouts()
```

**Purpose**: Verifies that a full-read plus workspace-write profile with an additional read-only carveout can be translated into restricted-token filesystem overrides.

**Data flow**: Canonicalizes a temp workspace, creates a `docs` directory, builds a restricted policy with `Root` read, `project_roots` write, and explicit `docs` read, then calls `resolve_windows_restricted_token_filesystem_overrides`. It asserts an `Ok(Some(...))` result whose `additional_deny_write_paths` contains only `docs` and whose root overrides are `None`.

**Call relations**: This test moves beyond yes/no compatibility into exact override synthesis, confirming that the helper projects the carveout into deny-write overlays rather than rejecting the profile.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, canonicalize, create_dir_all, new, vec!).


##### `windows_restricted_token_rejects_unreadable_split_carveouts`  (lines 666–710)

```
fn windows_restricted_token_rejects_unreadable_split_carveouts()
```

**Purpose**: Ensures the unelevated backend rejects profiles that require explicit deny-read carveouts, which it cannot enforce directly.

**Data flow**: Creates a `blocked` directory inside a canonicalized temp workspace, builds a policy with `Root` read, `project_roots` write, and explicit `blocked` deny access, converts it to a `PermissionProfile`, and asserts `resolve_windows_restricted_token_filesystem_overrides` returns an `Err` with the deny-read rejection message.

**Call relations**: This exercises the error-returning branch of the override resolver itself, showing that unsupported carveouts fail during override construction rather than yielding partial state.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, canonicalize, create_dir_all, new, vec!).


##### `windows_elevated_supports_split_restricted_read_roots`  (lines 713–747)

```
fn windows_elevated_supports_split_restricted_read_roots()
```

**Purpose**: Checks that the elevated backend can translate a split read-root policy into explicit `read_roots_override` values.

**Data flow**: Creates a canonical `docs` directory, builds a restricted filesystem policy with only that path readable, derives a `PermissionProfile`, and calls `resolve_windows_elevated_filesystem_overrides` with `use_windows_elevated_backend = true`. It asserts an override set containing `read_roots_override: Some(vec![expected_docs])` and no deny lists.

**Call relations**: This test covers the elevated override resolver’s ability to encode precise read roots, a capability unavailable to the unelevated restricted-token path.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, canonicalize, create_dir_all, new, vec!).


##### `windows_elevated_supports_split_write_read_carveouts`  (lines 750–801)

```
fn windows_elevated_supports_split_write_read_carveouts()
```

**Purpose**: Verifies that the elevated backend can represent a read-only carveout inside an otherwise writable workspace by generating deny-write overrides.

**Data flow**: Creates a temp `docs` directory, defines a policy with `Root` read, `project_roots` write, and explicit `docs` read, then asserts `resolve_windows_elevated_filesystem_overrides` returns overrides with `additional_deny_write_paths` containing canonicalized `docs` and no read-root overrides.

**Call relations**: This mirrors the restricted-token carveout test but targets the elevated resolver, proving both backends can express similar intent through different mechanisms.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, canonicalize, create_dir_all, new, vec!).


##### `windows_elevated_supports_unreadable_split_carveouts`  (lines 804–860)

```
fn windows_elevated_supports_unreadable_split_carveouts()
```

**Purpose**: Ensures the elevated backend can encode an explicit unreadable carveout by denying both reads and writes to the carved-out path.

**Data flow**: Creates a `blocked` directory, builds a policy with full read, workspace write, and explicit `Deny` on `blocked`, then calls `resolve_windows_elevated_filesystem_overrides` and asserts both `additional_deny_read_paths` and `additional_deny_write_paths` contain the canonicalized directory.

**Call relations**: This test captures a capability difference from the unelevated backend: explicit deny carveouts are supported once the elevated backend is in use.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, canonicalize, create_dir_all, new, vec!).


##### `windows_elevated_supports_unreadable_globs`  (lines 863–913)

```
fn windows_elevated_supports_unreadable_globs()
```

**Purpose**: Checks that glob-based deny rules can be concretized into elevated-backend read-deny overrides for matching files.

**Data flow**: Creates a temp tree containing `app/.env`, builds a policy with full read, workspace write, and a deny glob `**/*.env`, converts to a `PermissionProfile`, and asserts `resolve_windows_elevated_filesystem_overrides` returns an override set whose `additional_deny_read_paths` includes the concrete secret file and whose write-deny list remains empty.

**Call relations**: This extends the elevated override tests from exact paths to glob expansion, showing that the resolver scans the workspace and materializes matching files into explicit deny paths.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, create_dir_all, write, new, vec!).


##### `windows_elevated_rejects_reopened_writable_descendants`  (lines 916–968)

```
fn windows_elevated_rejects_reopened_writable_descendants()
```

**Purpose**: Ensures the elevated backend rejects profiles that attempt to reopen a writable descendant underneath a read-only carveout, which it cannot safely enforce.

**Data flow**: Creates nested `docs/nested` directories, builds a policy with full read, workspace write, `docs` read, and `nested` write, then calls `unsupported_windows_restricted_token_sandbox_reason` at `WindowsSandboxLevel::Elevated` and asserts the exact rejection message.

**Call relations**: This is a negative elevated-backend test covering policy contradictions that cannot be represented even with the more capable backend.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 4 external calls (assert_eq!, create_dir_all, new, vec!).


##### `process_exec_tool_call_uses_platform_sandbox_for_network_only_restrictions`  (lines 971–984)

```
fn process_exec_tool_call_uses_platform_sandbox_for_network_only_restrictions()
```

**Purpose**: Verifies sandbox selection for network-only restrictions falls back to the platform’s native sandbox type rather than choosing no sandbox outright.

**Data flow**: Computes `expected` using `codex_sandboxing::get_platform_sandbox(false).unwrap_or(SandboxType::None)`, calls `select_process_exec_tool_sandbox_type` with unrestricted filesystem permissions and restricted networking, and asserts equality.

**Call relations**: This is a focused selection-policy test for the orchestration helper that chooses which sandbox backend `process_exec_tool_call` should request.

*Call graph*: 2 external calls (assert_eq!, get_platform_sandbox).


##### `build_exec_request_preserves_windows_workspace_roots`  (lines 987–1019)

```
fn build_exec_request_preserves_windows_workspace_roots() -> Result<()>
```

**Purpose**: Checks that request construction copies the caller-provided workspace roots through to the Windows-specific exec request fields unchanged.

**Data flow**: Creates a temp cwd and an additional absolute root, builds `ExecParams`, calls `build_exec_request` with a `PermissionProfile::Disabled` and the two workspace roots, and asserts `exec_request.windows_sandbox_workspace_roots` equals the original vector.

**Call relations**: This test targets request assembly rather than execution, guarding against accidental loss of workspace-root context before sandbox setup on Windows.

*Call graph*: 4 external calls (new, assert_eq!, new, vec!).


##### `sandbox_detection_flags_sigsys_exit_code`  (lines 1023–1027)

```
fn sandbox_detection_flags_sigsys_exit_code()
```

**Purpose**: Ensures Unix `SIGSYS` termination is recognized as strong evidence of seccomp sandbox denial even without textual output.

**Data flow**: Computes an exit code as `EXIT_CODE_SIGNAL_BASE + libc::SIGSYS`, constructs an empty-output fixture with `make_exec_output`, calls `is_likely_sandbox_denied` for Linux seccomp, and asserts true.

**Call relations**: This Unix-only test covers the signal-based denial path, complementing the earlier keyword-based heuristics.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `kill_child_process_group_kills_grandchildren_on_timeout`  (lines 1031–1094)

```
async fn kill_child_process_group_kills_grandchildren_on_timeout() -> Result<()>
```

**Purpose**: Verifies that when an execution times out on Unix, the executor kills the entire child process group, including background grandchildren.

**Data flow**: Builds a shell command that backgrounds `sleep 60`, prints the grandchild PID, and then sleeps; runs it through `exec` with a 500 ms expiration and restricted networking; asserts `output.timed_out`; parses the PID from stdout; then polls `libc::kill(pid, 0)` until it reports `ESRCH`, finally asserting the grandchild is gone.

**Call relations**: This is an end-to-end timeout cleanup test for `exec`, driving real process-group semantics and checking post-timeout side effects outside the returned `ExecToolCallOutput`.

*Call graph*: calls 1 internal fn (current_dir); 7 external calls (from_millis, assert!, last_os_error, kill, vars, sleep, vec!).


##### `process_exec_tool_call_respects_cancellation_token`  (lines 1097–1139)

```
async fn process_exec_tool_call_respects_cancellation_token() -> Result<()>
```

**Purpose**: Checks that `process_exec_tool_call` terminates promptly when given an `ExecExpiration::Cancellation` token and that the result is a cancellation failure rather than a timeout.

**Data flow**: Builds a long-running command using `long_running_command`, creates a `CancellationToken`, spawns a task that cancels it after 1 second, wraps `process_exec_tool_call` in a 5-second Tokio timeout, and asserts the returned output is non-timeout with a nonzero exit code different from `EXEC_TIMEOUT_EXIT_CODE`.

**Call relations**: This is the cancellation counterpart to timeout tests: the test drives the higher-level tool-call path and verifies cancellation reaches process control logic quickly and produces distinct result semantics.

*Call graph*: calls 2 internal fn (long_running_command, current_dir); 11 external calls (new, from_millis, from_secs, assert!, assert_ne!, Cancellation, vars, from_ref, spawn, sleep (+1 more)).


##### `process_exec_tool_call_cancellation_allows_sigterm_cleanup`  (lines 1143–1249)

```
async fn process_exec_tool_call_cancellation_allows_sigterm_cleanup() -> Result<()>
```

**Purpose**: Verifies that cancellation first allows graceful SIGTERM cleanup in the parent process while still escalating to kill any TERM-ignoring descendants in the same process group.

**Data flow**: Creates temp marker files, runs a Unix shell script that spawns a TERM-ignoring child, records that child’s PID, installs a SIGTERM trap writing a cleanup marker, and loops forever. A spawned task watches for the ready marker and then cancels the token. The test awaits `process_exec_tool_call`, asserts the result is non-timeout, reads the cleanup marker to ensure the trap ran, reads and parses the descendant PID, then polls `kill(pid, 0)` until the descendant disappears, force-killing it only as cleanup if necessary.

**Call relations**: This is the most complete lifecycle test in the file: it validates cancellation orchestration, graceful termination, fallback escalation, and process-group cleanup behavior of `process_exec_tool_call` under Unix.

*Call graph*: calls 1 internal fn (current_dir); 15 external calls (new, from_millis, from_secs, assert!, assert_eq!, last_os_error, kill, vars, read_to_string, from_ref (+5 more)).


##### `long_running_command`  (lines 1261–1269)

```
fn long_running_command() -> Vec<String>
```

**Purpose**: Provides a platform-specific command vector for a process that simply sleeps long enough to exercise cancellation behavior.

**Data flow**: Takes no arguments and returns a `Vec<String>` containing either `/bin/sh -c 'sleep 30'` on Unix or the equivalent PowerShell sleep command on Windows. It does not read or write external state.

**Call relations**: Used by `process_exec_tool_call_respects_cancellation_token` to keep the cancellation test portable while avoiding inline platform conditionals there.

*Call graph*: called by 1 (process_exec_tool_call_respects_cancellation_token); 1 external calls (vec!).


### `core/src/mcp_tool_call_tests.rs`

`test` · `cross-cutting test coverage for MCP request handling, approval flow, telemetry, and config persistence`

This file is the regression suite for the MCP tool-call subsystem. It builds realistic `Session` and `TurnContext` fixtures, then verifies how MCP invocations are traced, exposed to approval systems, serialized into events, and persisted back into config. The helper functions construct concrete `ToolAnnotations`, `McpToolApprovalMetadata`, `McpTurnMetadataContext`, prompt-option structs, plugin MCP manifests, rollout trace bundles, and on-disk permission-request hooks. Those helpers let tests drive the real code paths rather than stubs.

The tests cover several distinct concerns. One group validates approval semantics: when annotations imply approval is required, how `AppToolApproval::{Auto,Prompt,Approve}` changes behavior, how remembered approvals and persistent approvals are keyed, and how elicitation responses map back into `McpToolApprovalDecision`. Another group checks request shaping: approval questions, elicitation metadata, guardian review requests, MCP request metadata headers, plugin IDs, Codex Apps metadata, and thread IDs. Telemetry-focused tests assert exact tracing fields on MCP call spans and allowlisted result metadata promotion. Result-shaping tests verify image redaction for models without image input and byte-bounded truncation for event payloads. Persistence tests write actual `config.toml` files for app tools, custom MCP servers, plugin MCP servers, and trusted project-local config, then reload session config and confirm remembered state. Finally, auth-elicitation tests simulate Codex Apps connector auth failures and verify that elicitation is only requested when feature flags, host-owned server state, and approval policy all permit it.

#### Function details

##### `annotations`  (lines 55–67)

```
fn annotations(
    read_only: Option<bool>,
    destructive: Option<bool>,
    open_world: Option<bool>,
) -> ToolAnnotations
```

**Purpose**: Builds a `ToolAnnotations` test value from optional read-only, destructive, and open-world hints. It centralizes the exact `ToolAnnotations::from_raw` call shape used throughout approval-related tests.

**Data flow**: Takes three `Option<bool>` flags and passes them into `ToolAnnotations::from_raw` with `title` and `idempotent_hint` forced to `None`. Returns the resulting `ToolAnnotations` without mutating external state.

**Call relations**: Used by many approval and guardian tests to create concrete annotation combinations that drive production approval logic, especially the branches that distinguish safe read-only tools from destructive or open-world tools.

*Call graph*: called by 13 (approval_not_required_when_read_only_and_other_hints_are_absent, approval_required_when_destructive_even_if_read_only_true, approval_required_when_read_only_false_and_destructive, approval_required_when_read_only_false_and_open_world, approve_mode_skips_guardian_in_every_permission_mode, approve_mode_skips_when_annotations_do_not_require_approval, full_access_mode_skips_mcp_tool_approval_for_all_approval_modes, guardian_mcp_review_request_includes_annotations_when_present, guardian_mode_mcp_denial_returns_rationale_message, guardian_mode_skips_auto_when_annotations_do_not_require_approval (+3 more)); 1 external calls (from_raw).


##### `approval_metadata`  (lines 69–88)

```
fn approval_metadata(
    connector_id: Option<&str>,
    connector_name: Option<&str>,
    connector_description: Option<&str>,
    tool_title: Option<&str>,
    tool_description: Option<&str>,
) ->
```

**Purpose**: Constructs a minimal `McpToolApprovalMetadata` fixture with selected connector and tool descriptive fields populated. It leaves unrelated metadata channels unset so tests can focus on specific request/meta behavior.

**Data flow**: Accepts optional string slices for connector identity and tool labeling, converts present values into owned `String`s, and returns an `McpToolApprovalMetadata` with `annotations`, `plugin_id`, `mcp_app_resource_uri`, `codex_apps_meta`, and `openai_file_input_params` set to `None`.

**Call relations**: Called by tests that need realistic metadata for approval elicitation payloads, persistent-approval key derivation, guardian review requests, plugin request metadata, and Codex Apps auth-failure scenarios.

*Call graph*: called by 5 (approval_elicitation_request_uses_message_override_and_preserves_tool_params_keys, codex_apps_auth_failure_metadata, codex_apps_connectors_support_persistent_approval, guardian_mcp_review_request_includes_invocation_metadata, plugin_mcp_tool_call_request_meta_includes_plugin_id).


##### `mcp_turn_metadata_context`  (lines 90–95)

```
fn mcp_turn_metadata_context(turn_context: &TurnContext) -> McpTurnMetadataContext<'_>
```

**Purpose**: Extracts the subset of turn context needed to compute MCP turn metadata headers. It packages the model slug and effective reasoning effort into `McpTurnMetadataContext`.

**Data flow**: Reads `turn_context.model_info.slug` and `turn_context.effective_reasoning_effort()`, then returns a borrowed `McpTurnMetadataContext<'_>` referencing the model string and carrying the optional reasoning effort.

**Call relations**: Used by request-metadata tests to compute the expected turn metadata independently, then compare it against what `build_mcp_tool_call_request_meta` emits for custom servers, plugins, and Codex Apps.

*Call graph*: calls 1 internal fn (effective_reasoning_effort); called by 4 (codex_apps_tool_call_request_meta_includes_call_id_without_existing_codex_apps_meta, codex_apps_tool_call_request_meta_includes_turn_metadata_and_codex_apps_meta, mcp_tool_call_request_meta_includes_turn_metadata_for_custom_server, plugin_mcp_tool_call_request_meta_includes_plugin_id).


##### `write_sample_plugin_mcp`  (lines 97–119)

```
fn write_sample_plugin_mcp(codex_home: &std::path::Path)
```

**Purpose**: Creates a synthetic plugin installation on disk with both a plugin manifest and `.mcp.json` server definition. It gives plugin-policy tests a real filesystem layout to load from.

**Data flow**: Takes a `codex_home` path, creates `plugins/cache/test/sample/local/.codex-plugin`, writes `.codex-plugin/plugin.json` containing `{ "name": "sample" }`, and writes `.mcp.json` defining an HTTP MCP server named `sample` at `https://sample.example/mcp`.

**Call relations**: Invoked by plugin approval-mode and persistence tests before loading config, so the plugin manager can discover a concrete plugin-backed MCP server and apply plugin-scoped tool policy.

*Call graph*: called by 3 (custom_mcp_tool_approval_mode_uses_plugin_mcp_policy, custom_mcp_tool_approval_mode_uses_updated_plugin_mcp_policy_after_cache_warm, maybe_persist_mcp_tool_approval_writes_plugin_mcp_policy); 3 external calls (join, create_dir_all, write).


##### `prompt_options`  (lines 121–129)

```
fn prompt_options(
    allow_session_remember: bool,
    allow_persistent_approval: bool,
) -> McpToolApprovalPromptOptions
```

**Purpose**: Builds `McpToolApprovalPromptOptions` fixtures for approval-question and elicitation tests. It makes the allowed remember scopes explicit in each scenario.

**Data flow**: Accepts two booleans and returns `McpToolApprovalPromptOptions { allow_session_remember, allow_persistent_approval }` with no side effects.

**Call relations**: Used by tests that verify approval-question option ordering, omission of persistent remember in prompt-only cases, and elicitation metadata persistence flags.

*Call graph*: called by 5 (approval_elicitation_request_uses_message_override_and_preserves_tool_params_keys, codex_apps_tool_question_uses_fallback_app_label, custom_mcp_tool_question_mentions_server_name, custom_mcp_tool_question_offers_session_remember_and_always_allow, trusted_codex_apps_tool_question_offers_always_allow).


##### `execute_mcp_tool_call_records_replayable_correlation`  (lines 132–183)

```
async fn execute_mcp_tool_call_records_replayable_correlation() -> anyhow::Result<()>
```

**Purpose**: Verifies that the real MCP execution path emits a replay-bundle correlation ID linking the model-visible tool call to the underlying MCP call, even when execution itself fails due to a missing backend.

**Data flow**: Creates a temp rollout root and synthetic session/turn, attaches a rollout trace bundle, starts a tool-dispatch trace with a concrete `ToolDispatchInvocation`, then calls `execute_mcp_tool_call` for server `docs` tool `search` with JSON arguments. It expects an error, replays the sole emitted bundle from disk, and asserts that `replayed.tool_calls["mcp-call"].mcp_call_id` is populated.

**Call relations**: This is an end-to-end trace-emission test: it sets up the trace context first, then drives the production MCP execution path specifically to validate reducer-visible replay metadata rather than successful tool execution.

*Call graph*: calls 3 internal fn (attach_trace_bundle, single_bundle_dir, make_session_and_context); 4 external calls (assert!, replay_bundle, json!, tempdir).


##### `install_mcp_permission_request_hook`  (lines 185–272)

```
fn install_mcp_permission_request_hook(
    session: &mut Session,
    turn_context: &TurnContext,
    matcher: &str,
    hook_output: &serde_json::Value,
) -> std::path::PathBuf
```

**Purpose**: Installs a real command hook for `PermissionRequest` events under the test `codex_home`, logging hook input and returning a caller-specified JSON decision. It prepares sessions for tests that exercise hook-based MCP approval.

**Data flow**: Given a mutable `Session`, `TurnContext`, matcher regex, and JSON hook output, it writes a Python script that reads stdin JSON, appends it to `mcp_permission_request_hook_log.jsonl`, and prints the configured output. It writes `hooks.json`, loads hooks via `codex_hooks::list_hooks`, wraps them in a trusted config layer stack, stores a new `Hooks` instance into `session.services.hooks`, and returns the log file path.

**Call relations**: Called by the permission-request hook tests before invoking `maybe_request_mcp_tool_approval`. Those tests then inspect the log file to confirm the exact payload sent to the hook and whether remembered approvals bypass hook execution.

*Call graph*: calls 2 internal fn (trusted_config_layer_stack, new); called by 3 (permission_request_hook_allows_mcp_tool_call, permission_request_hook_runs_after_remembered_mcp_approval, permission_request_hook_uses_hook_tool_name_without_metadata); 12 external calls (new, to_string, new, assert_eq!, cfg!, list_hooks, format!, default, json!, create_dir_all (+2 more)).


##### `attach_trace_bundle`  (lines 275–301)

```
fn attach_trace_bundle(
    session: &mut Session,
    turn_context: &TurnContext,
    root: &Path,
) -> anyhow::Result<()>
```

**Purpose**: Attaches a replayable rollout trace context to a synthetic session under test. It gives later MCP dispatches a real trace sink rooted in a temporary directory.

**Data flow**: Takes mutable `Session`, `TurnContext`, and a root path; starts `ThreadTraceContext::start_root_in_root_for_test` with concrete `ThreadStartedTraceMetadata` including thread ID, session source, cwd, model, provider, approval policy, and sandbox policy; records the current Codex turn start; then stores the trace context into `session.services.rollout_thread_trace`.

**Call relations**: Used only by the replay-correlation test as setup before `execute_mcp_tool_call`, ensuring the execution path has an active rollout trace to write into.

*Call graph*: calls 1 internal fn (start_root_in_root_for_test); called by 1 (execute_mcp_tool_call_records_replayable_correlation); 1 external calls (from).


##### `single_bundle_dir`  (lines 304–311)

```
fn single_bundle_dir(root: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: Finds the only rollout bundle directory emitted under a temporary trace root. It enforces the test invariant that exactly one bundle was produced.

**Data flow**: Reads directory entries under `root`, collects their paths into a vector, sorts them, asserts the vector length is exactly one, and returns that sole path.

**Call relations**: Called after MCP execution in the replay-correlation test to locate the bundle directory passed into `replay_bundle`.

*Call graph*: called by 1 (execute_mcp_tool_call_records_replayable_correlation); 2 external calls (assert_eq!, read_dir).


##### `mcp_app_resource_uri_reads_known_tool_meta_keys`  (lines 314–340)

```
fn mcp_app_resource_uri_reads_known_tool_meta_keys()
```

**Purpose**: Checks that MCP app resource URI extraction recognizes all supported metadata key layouts. It guards compatibility with nested UI metadata and flat OpenAI-style keys.

**Data flow**: Builds three JSON metadata objects—nested `ui.resourceUri`, flat `ui/resourceUri`, and `openai/outputTemplate`—passes each object map into `get_mcp_app_resource_uri`, and asserts the expected URI string is returned.

**Call relations**: Standalone unit test for metadata parsing behavior used when enriching MCP tool-call items and approval metadata.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `openai_file_params_are_only_honored_for_codex_apps`  (lines 343–357)

```
fn openai_file_params_are_only_honored_for_codex_apps()
```

**Purpose**: Verifies that `openai/fileParams` metadata is accepted only for the Codex Apps MCP server and ignored for ordinary custom servers.

**Data flow**: Creates a metadata object containing `openai/fileParams: ["file"]`, then calls `openai_file_input_params_for_server` once with `CODEX_APPS_MCP_SERVER_NAME` and once with `minimaltest`, asserting `Some(vec!["file"])` for the former and `None` for the latter.

**Call relations**: Standalone unit test for server-specific metadata gating in the MCP approval/request pipeline.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `approval_required_when_read_only_false_and_destructive`  (lines 360–363)

```
fn approval_required_when_read_only_false_and_destructive()
```

**Purpose**: Confirms that a tool marked non-read-only and destructive always requires approval.

**Data flow**: Builds annotations with `read_only=false` and `destructive=true`, passes them to `requires_mcp_tool_approval`, and asserts the result is `true`.

**Call relations**: One of several focused truth-table tests covering the approval requirement predicate.

*Call graph*: calls 1 internal fn (annotations); 1 external calls (assert_eq!).


##### `approval_required_when_read_only_false_and_open_world`  (lines 366–369)

```
fn approval_required_when_read_only_false_and_open_world()
```

**Purpose**: Confirms that a non-read-only tool with open-world access requires approval.

**Data flow**: Creates annotations with `read_only=false` and `open_world=true`, evaluates `requires_mcp_tool_approval`, and asserts `true`.

**Call relations**: Complements the destructive-hint test to cover the open-world branch of approval requirement logic.

*Call graph*: calls 1 internal fn (annotations); 1 external calls (assert_eq!).


##### `approval_required_when_destructive_even_if_read_only_true`  (lines 372–375)

```
fn approval_required_when_destructive_even_if_read_only_true()
```

**Purpose**: Verifies that a destructive hint overrides a read-only hint and still forces approval.

**Data flow**: Creates annotations with `read_only=true`, `destructive=true`, and `open_world=true`, then asserts `requires_mcp_tool_approval` returns `true`.

**Call relations**: Protects the invariant that destructive tools are never auto-treated as safe solely because `read_only_hint` is present.

*Call graph*: calls 1 internal fn (annotations); 1 external calls (assert_eq!).


##### `approval_required_when_annotations_are_absent`  (lines 378–380)

```
fn approval_required_when_annotations_are_absent()
```

**Purpose**: Checks the conservative default: missing annotations mean approval is required.

**Data flow**: Calls `requires_mcp_tool_approval(None)` and asserts `true`.

**Call relations**: Covers the no-metadata fallback branch of approval requirement logic.

*Call graph*: 1 external calls (assert_eq!).


##### `approval_not_required_when_read_only_and_other_hints_are_absent`  (lines 383–390)

```
fn approval_not_required_when_read_only_and_other_hints_are_absent()
```

**Purpose**: Verifies the only clearly safe case in the predicate: explicitly read-only with no destructive or open-world hints.

**Data flow**: Builds annotations with `read_only=true` and other hints absent, evaluates `requires_mcp_tool_approval`, and asserts `false`.

**Call relations**: Completes the approval predicate truth-table tests by covering the non-approval path.

*Call graph*: calls 1 internal fn (annotations); 1 external calls (assert_eq!).


##### `prompt_mode_does_not_allow_persistent_remember`  (lines 393–408)

```
fn prompt_mode_does_not_allow_persistent_remember()
```

**Purpose**: Ensures prompt-mode normalization strips session and persistent remember decisions down to a one-shot accept.

**Data flow**: Calls `normalize_approval_decision_for_mode` with `AcceptForSession` and `AcceptAndRemember` under `AppToolApproval::Prompt`, asserting both normalize to `McpToolApprovalDecision::Accept`.

**Call relations**: Unit test for the decision-normalization step used after approval responses are parsed.

*Call graph*: 1 external calls (assert_eq!).


##### `mcp_tool_call_span_records_expected_fields`  (lines 411–459)

```
async fn mcp_tool_call_span_records_expected_fields()
```

**Purpose**: Asserts that the MCP tool-call tracing span emits the expected OpenTelemetry-style fields, including RPC metadata, server origin parsing, connector identity, and conversation/session/turn IDs.

**Data flow**: Installs a tracing subscriber backed by a leaked in-memory buffer, creates a synthetic session and turn context, instruments an empty async block with `mcp_tool_call_span` using concrete span fields, awaits it, converts the captured bytes to UTF-8, and asserts the log output contains all expected key-value pairs.

**Call relations**: Directly exercises span construction and field recording without needing a real MCP call, serving as a telemetry contract test.

*Call graph*: calls 1 internal fn (make_session_and_context); 9 external calls (leak, new, new, from_utf8, new, assert!, new, set_default, fmt).


##### `mcp_result_telemetry_span_logs`  (lines 461–503)

```
async fn mcp_result_telemetry_span_logs(meta: Option<serde_json::Value>) -> String
```

**Purpose**: Helper that records MCP result telemetry into a tracing span and returns the captured logs as a string. It isolates the tracing setup shared by multiple result-telemetry tests.

**Data flow**: Creates an in-memory tracing subscriber, builds a synthetic session/turn and a `CallToolResult` with caller-provided `meta`, opens an `mcp_tool_call_span`, invokes `record_mcp_result_span_telemetry(&Span::current(), Some(&result))` inside that span, then returns the captured log buffer as UTF-8 text.

**Call relations**: Called by the allowlist, invalid-value, and truncation tests to inspect exactly which result metadata keys are promoted into span fields.

*Call graph*: calls 1 internal fn (make_session_and_context); called by 3 (mcp_result_telemetry_ignores_invalid_and_missing_values, mcp_result_telemetry_records_allowlisted_span_fields, mcp_result_telemetry_truncates_long_target_id); 9 external calls (leak, new, new, current, from_utf8, new, new, set_default, fmt).


##### `mcp_result_telemetry_records_allowlisted_span_fields`  (lines 506–528)

```
async fn mcp_result_telemetry_records_allowlisted_span_fields()
```

**Purpose**: Verifies that only allowlisted MCP result telemetry keys are promoted into tracing fields.

**Data flow**: Passes metadata containing `codex/telemetry.span.target_id`, `did_trigger_server_user_flow`, and an unknown sentinel key into `mcp_result_telemetry_span_logs`, then asserts the logs contain the promoted allowlisted fields and omit the unknown key/value.

**Call relations**: Builds on the shared log-capture helper to validate the positive allowlist path and the ignore-unknown-keys invariant.

*Call graph*: calls 1 internal fn (mcp_result_telemetry_span_logs); 2 external calls (assert!, json!).


##### `mcp_result_telemetry_ignores_invalid_and_missing_values`  (lines 531–563)

```
async fn mcp_result_telemetry_ignores_invalid_and_missing_values()
```

**Purpose**: Checks that malformed telemetry values, missing span objects, and absent metadata produce no promoted span fields.

**Data flow**: Calls `mcp_result_telemetry_span_logs` three times: once with wrong-typed values, once with an empty `codex/telemetry` object, and once with `None`. It asserts each resulting log string lacks the promoted telemetry field names.

**Call relations**: Covers defensive parsing branches in result telemetry extraction.

*Call graph*: calls 1 internal fn (mcp_result_telemetry_span_logs); 2 external calls (assert!, json!).


##### `mcp_result_telemetry_truncates_long_target_id`  (lines 566–582)

```
async fn mcp_result_telemetry_truncates_long_target_id()
```

**Purpose**: Ensures long `target_id` values are truncated to the configured character limit before being recorded in telemetry.

**Data flow**: Builds a `target_id` longer than `MCP_RESULT_TELEMETRY_TARGET_ID_MAX_CHARS`, captures logs via `mcp_result_telemetry_span_logs`, and asserts the logs contain only the truncated prefix and not the trailing suffix.

**Call relations**: Validates the length-bounding branch of result telemetry promotion.

*Call graph*: calls 1 internal fn (mcp_result_telemetry_span_logs); 3 external calls (assert!, format!, json!).


##### `truncates_strings_on_char_boundaries`  (lines 585–595)

```
fn truncates_strings_on_char_boundaries()
```

**Purpose**: Tests the string truncation helper with multibyte characters to ensure it never splits a UTF-8 codepoint.

**Data flow**: Constructs a string of repeated `á` characters plus a suffix, truncates it with `truncate_str_to_char_boundary`, and asserts the result equals the full multibyte prefix. It also checks that short ASCII strings are returned unchanged.

**Call relations**: Supports the telemetry truncation tests by validating the lower-level truncation invariant.

*Call graph*: 2 external calls (assert_eq!, format!).


##### `approval_elicitation_request_uses_message_override_and_preserves_tool_params_keys`  (lines 598–693)

```
async fn approval_elicitation_request_uses_message_override_and_preserves_tool_params_keys()
```

**Purpose**: Verifies the exact `McpServerElicitationRequestParams` built for MCP tool approval, including message override, persistence options, connector metadata, and unmodified tool parameter keys.

**Data flow**: Creates a session/turn, builds an approval question and a rich `McpToolApprovalElicitationRequest` containing metadata, raw tool params, rendered display params, and a message override, then calls `build_mcp_tool_approval_elicitation_request` and asserts deep equality with the expected request struct and nested JSON meta.

**Call relations**: End-to-end unit test for approval elicitation request construction, especially the metadata schema consumed by MCP servers.

*Call graph*: calls 3 internal fn (approval_metadata, prompt_options, make_session_and_context); 2 external calls (assert_eq!, json!).


##### `custom_mcp_tool_question_mentions_server_name`  (lines 696–721)

```
fn custom_mcp_tool_question_mentions_server_name()
```

**Purpose**: Checks that approval questions for non-Codex-Apps servers mention the MCP server name and omit persistent remember when not allowed.

**Data flow**: Builds a question for server `custom_server` and tool `run_action` with both remember flags disabled, then asserts the header text, question text, and option labels match expectations and exclude `AcceptAndRemember`.

**Call relations**: One of several tests covering user-facing approval question wording and option sets.

*Call graph*: calls 1 internal fn (prompt_options); 2 external calls (assert!, assert_eq!).


##### `codex_apps_tool_question_uses_fallback_app_label`  (lines 724–740)

```
fn codex_apps_tool_question_uses_fallback_app_label()
```

**Purpose**: Verifies that Codex Apps approval questions fall back to the generic phrase “this app” when no connector name is available.

**Data flow**: Builds a question for `CODEX_APPS_MCP_SERVER_NAME` without a connector name and asserts the generated question string uses the fallback label.

**Call relations**: Covers the Codex Apps-specific wording branch in approval question generation.

*Call graph*: calls 1 internal fn (prompt_options); 1 external calls (assert_eq!).


##### `trusted_codex_apps_tool_question_offers_always_allow`  (lines 743–776)

```
fn trusted_codex_apps_tool_question_offers_always_allow()
```

**Purpose**: Ensures a trusted Codex Apps connector approval question offers both session-scoped and persistent remember options, in the expected order and with the expected descriptions.

**Data flow**: Builds a question for the `Calendar` connector with both remember flags enabled, extracts the options, and asserts the presence and descriptions of `AcceptForSession` and `AcceptAndRemember`, plus the full ordered label list.

**Call relations**: Tests the richest approval-question variant where all remember scopes are available.

*Call graph*: calls 1 internal fn (prompt_options); 2 external calls (assert!, assert_eq!).


##### `codex_apps_tool_question_without_elicitation_omits_always_allow`  (lines 779–812)

```
fn codex_apps_tool_question_without_elicitation_omits_always_allow()
```

**Purpose**: Checks that persistent remember is suppressed when MCP elicitation support is disabled, even if session and persistent approval keys exist.

**Data flow**: Constructs matching session and persistent `McpToolApprovalKey`s, derives prompt options via `mcp_tool_approval_prompt_options(..., tool_call_mcp_elicitation_enabled=false)`, builds the question, and asserts the option labels include only accept, session remember, and cancel.

**Call relations**: Covers the interaction between approval-key availability and the feature gate for persistent elicitation.

*Call graph*: 1 external calls (assert_eq!).


##### `custom_mcp_tool_question_offers_session_remember_and_always_allow`  (lines 815–841)

```
fn custom_mcp_tool_question_offers_session_remember_and_always_allow()
```

**Purpose**: Verifies that custom MCP servers can expose both session and persistent remember options when allowed.

**Data flow**: Builds a question for `custom_server` with both remember flags enabled and asserts the option labels are exactly accept, accept-for-session, accept-and-remember, and cancel.

**Call relations**: Complements the Codex Apps question tests by covering the custom-server branch.

*Call graph*: calls 1 internal fn (prompt_options); 1 external calls (assert_eq!).


##### `custom_servers_support_session_and_persistent_approval`  (lines 844–868)

```
fn custom_servers_support_session_and_persistent_approval()
```

**Purpose**: Checks that custom MCP invocations derive both session and persistent approval keys from server name and tool name alone.

**Data flow**: Creates a `McpInvocation` for `custom_server/run_action`, constructs the expected `McpToolApprovalKey`, and asserts both `session_mcp_tool_approval_key` and `persistent_mcp_tool_approval_key` return it under `AppToolApproval::Auto`.

**Call relations**: Unit test for approval-key derivation logic outside the Codex Apps connector path.

*Call graph*: 1 external calls (assert_eq!).


##### `codex_apps_connectors_support_persistent_approval`  (lines 871–898)

```
fn codex_apps_connectors_support_persistent_approval()
```

**Purpose**: Verifies that Codex Apps invocations derive approval keys that include the connector ID from metadata.

**Data flow**: Creates a Codex Apps invocation and matching metadata with connector ID `calendar`, then asserts both session and persistent key builders return a key containing server name, connector ID, and tool name.

**Call relations**: Covers the connector-aware key derivation branch used for remembered approvals on Codex Apps tools.

*Call graph*: calls 1 internal fn (approval_metadata); 1 external calls (assert_eq!).


##### `sanitize_mcp_tool_result_for_model_rewrites_image_content`  (lines 901–935)

```
fn sanitize_mcp_tool_result_for_model_rewrites_image_content()
```

**Purpose**: Ensures MCP tool results are rewritten before being shown to models that do not support image input.

**Data flow**: Builds a successful `CallToolResult` containing one image content item and one text item, passes it through `sanitize_mcp_tool_result_for_model(false, ...)`, unwraps the success, and asserts the image item became a text placeholder while the text item remained unchanged.

**Call relations**: Tests the model-compatibility sanitization path for MCP results.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `sanitize_mcp_tool_result_for_model_preserves_image_when_supported`  (lines 938–957)

```
fn sanitize_mcp_tool_result_for_model_preserves_image_when_supported()
```

**Purpose**: Checks that result sanitization is a no-op when the model supports image input.

**Data flow**: Creates a `CallToolResult` with image content, structured content, error flag, and metadata, passes it through `sanitize_mcp_tool_result_for_model(true, Ok(original))`, and asserts the returned result equals the original struct.

**Call relations**: Complements the previous test by covering the pass-through branch.

*Call graph*: 3 external calls (assert_eq!, json!, vec!).


##### `truncate_mcp_tool_result_for_event_preserves_small_result`  (lines 960–975)

```
fn truncate_mcp_tool_result_for_event_preserves_small_result()
```

**Purpose**: Verifies that small successful MCP results are emitted into events unchanged.

**Data flow**: Builds a compact `CallToolResult`, passes `&Ok(original.clone())` into `truncate_mcp_tool_result_for_event`, unwraps the success, and asserts exact equality with the original result.

**Call relations**: Baseline test for event-result truncation logic.

*Call graph*: 3 external calls (assert_eq!, json!, vec!).


##### `truncate_mcp_tool_result_for_event_bounds_large_result`  (lines 978–1012)

```
fn truncate_mcp_tool_result_for_event_bounds_large_result()
```

**Purpose**: Checks that oversized successful results are reduced to a bounded preview, with structured content and metadata dropped.

**Data flow**: Creates a huge `CallToolResult` with very large text, structured content, and meta fields, truncates it for event emission, serializes the truncated result to JSON, and asserts the serialized size stays under a bounded threshold, `structured_content` and `meta` are `None`, `is_error` is preserved, and the preview text contains a truncation marker.

**Call relations**: Exercises the large-success branch of event truncation, including byte-budget enforcement.

*Call graph*: 5 external calls (assert!, assert_eq!, json!, to_string, vec!).


##### `truncate_mcp_tool_result_for_event_bounds_large_error`  (lines 1015–1023)

```
fn truncate_mcp_tool_result_for_event_bounds_large_error()
```

**Purpose**: Ensures oversized error strings are also truncated to a bounded size while remaining errors.

**Data flow**: Passes a huge `Err(String)` into `truncate_mcp_tool_result_for_event`, unwraps the resulting error string, and asserts its length is bounded and it contains a truncation marker.

**Call relations**: Covers the large-error branch parallel to the large-success truncation test.

*Call graph*: 1 external calls (assert!).


##### `mcp_tool_call_request_meta_includes_turn_metadata_for_custom_server`  (lines 1026–1066)

```
async fn mcp_tool_call_request_meta_includes_turn_metadata_for_custom_server()
```

**Purpose**: Verifies that custom MCP tool calls include the computed turn metadata header with model and reasoning effort.

**Data flow**: Creates a turn context, computes the expected turn metadata via `turn_metadata_state.current_meta_value_for_mcp_request(mcp_turn_metadata_context(...))`, calls `build_mcp_tool_call_request_meta` for a custom server, extracts the header object, and asserts both individual fields and the full JSON object match expectations.

**Call relations**: Tests the base request-metadata path used for non-Codex-Apps servers.

*Call graph*: calls 2 internal fn (mcp_turn_metadata_context, make_session_and_context); 1 external calls (assert_eq!).


##### `mcp_tool_call_request_meta_includes_turn_started_at_unix_ms`  (lines 1069–1092)

```
async fn mcp_tool_call_request_meta_includes_turn_started_at_unix_ms()
```

**Purpose**: Checks that turn-start timestamps are propagated into MCP request metadata when present in turn metadata state.

**Data flow**: Creates a turn context, sets `turn_started_at_unix_ms` on `turn_metadata_state`, builds request metadata for a custom server, extracts the turn metadata header, and asserts the timestamp field equals the injected millisecond value.

**Call relations**: Extends the custom-server metadata test to cover optional timing fields.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert_eq!).


##### `plugin_mcp_tool_call_request_meta_includes_plugin_id`  (lines 1095–1115)

```
async fn plugin_mcp_tool_call_request_meta_includes_plugin_id()
```

**Purpose**: Verifies that plugin-backed MCP tool calls include both turn metadata and the plugin ID in request metadata.

**Data flow**: Creates a turn context, computes expected turn metadata, builds approval metadata with `plugin_id = Some("sample@test")`, calls `build_mcp_tool_call_request_meta`, and asserts the returned JSON contains both the turn metadata header and `MCP_TOOL_PLUGIN_ID_META_KEY`.

**Call relations**: Covers the plugin-specific metadata enrichment branch.

*Call graph*: calls 3 internal fn (approval_metadata, mcp_turn_metadata_context, make_session_and_context); 1 external calls (assert_eq!).


##### `mcp_tool_call_item_includes_plugin_id`  (lines 1118–1149)

```
async fn mcp_tool_call_item_includes_plugin_id()
```

**Purpose**: Checks that the event emitted when an MCP tool call starts carries the plugin ID through to the `TurnItem::McpToolCall` payload.

**Data flow**: Creates a session/turn with an event receiver, calls `notify_mcp_tool_call_started` with `McpToolCallItemMetadata { plugin_id: Some("sample@test"), ... }`, waits for the next event with a timeout, pattern-matches it to `EventMsg::ItemStarted` and `TurnItem::McpToolCall`, and asserts `item.plugin_id` is set.

**Call relations**: Exercises the event-notification path rather than request metadata, ensuring plugin provenance is visible in the transcript/event stream.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 4 external calls (assert_eq!, panic!, from_secs, timeout).


##### `codex_apps_tool_call_request_meta_includes_turn_metadata_and_codex_apps_meta`  (lines 1152–1197)

```
async fn codex_apps_tool_call_request_meta_includes_turn_metadata_and_codex_apps_meta()
```

**Purpose**: Verifies that Codex Apps requests include turn metadata plus a merged `_codex_apps` metadata object containing the call ID and existing connector/resource fields.

**Data flow**: Creates a turn context, computes expected turn metadata, builds `McpToolApprovalMetadata` with a populated `codex_apps_meta` object, calls `build_mcp_tool_call_request_meta` for `CODEX_APPS_MCP_SERVER_NAME`, and asserts the returned JSON contains the turn metadata header and `MCP_TOOL_CODEX_APPS_META_KEY` with merged `call_id`, `resource_uri`, `contains_mcp_source`, and `connector_id`.

**Call relations**: Covers the Codex Apps-specific request metadata branch when upstream metadata already exists.

*Call graph*: calls 2 internal fn (mcp_turn_metadata_context, make_session_and_context); 2 external calls (assert_eq!, json!).


##### `codex_apps_tool_call_request_meta_includes_call_id_without_existing_codex_apps_meta`  (lines 1200–1221)

```
async fn codex_apps_tool_call_request_meta_includes_call_id_without_existing_codex_apps_meta()
```

**Purpose**: Checks that Codex Apps requests still include a `_codex_apps.call_id` object even when no existing Codex Apps metadata is available.

**Data flow**: Creates a turn context, computes expected turn metadata, calls `build_mcp_tool_call_request_meta` for Codex Apps with `metadata=None`, and asserts the returned JSON contains the turn metadata header plus `_codex_apps: { call_id: ... }`.

**Call relations**: Complements the previous test by covering the metadata-bootstrap branch.

*Call graph*: calls 2 internal fn (mcp_turn_metadata_context, make_session_and_context); 1 external calls (assert_eq!).


##### `codex_apps_auth_failure_result`  (lines 1223–1246)

```
fn codex_apps_auth_failure_result() -> CallToolResult
```

**Purpose**: Builds a canonical `CallToolResult` representing a Codex Apps connector authentication failure. It packages the exact nested metadata shape consumed by auth-elicitation logic.

**Data flow**: Returns a `CallToolResult` with one text content item, `is_error = Some(true)`, and `meta` containing `MCP_TOOL_CODEX_APPS_META_KEY.connector_auth_failure` fields such as `is_auth_failure`, `auth_reason`, connector identity, link ID, HTTP status, and action.

**Call relations**: Used by all Codex Apps auth-elicitation tests as the input result that may or may not trigger a follow-up elicitation request.

*Call graph*: called by 5 (codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result, codex_apps_auth_elicitation_feature_disabled_returns_original_result, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result, codex_apps_auth_elicitation_non_host_owned_server_returns_original_result); 2 external calls (json!, vec!).


##### `codex_apps_auth_failure_metadata`  (lines 1248–1256)

```
fn codex_apps_auth_failure_metadata() -> McpToolApprovalMetadata
```

**Purpose**: Builds matching approval metadata for the synthetic Codex Apps auth-failure scenarios.

**Data flow**: Delegates to `approval_metadata` with connector ID `connector_calendar`, connector name `Google Calendar`, and descriptive tool text, returning the resulting `McpToolApprovalMetadata`.

**Call relations**: Paired with `codex_apps_auth_failure_result` in auth-elicitation tests so the production code has connector metadata available.

*Call graph*: calls 1 internal fn (approval_metadata); called by 5 (codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result, codex_apps_auth_elicitation_feature_disabled_returns_original_result, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result, codex_apps_auth_elicitation_non_host_owned_server_returns_original_result).


##### `install_host_owned_codex_apps_manager`  (lines 1258–1291)

```
async fn install_host_owned_codex_apps_manager(session: &Session, turn_context: &TurnContext)
```

**Purpose**: Installs a real `codex_mcp::McpConnectionManager` configured as host-owned Codex Apps support for the current session. This enables auth-elicitation code paths that depend on manager state.

**Data flow**: Reads auth from `session.services.auth_manager`, constructs `McpConnectionManager::new` with empty server maps, approval policy, turn ID, event sender, cancellation token, permission profile, runtime context, `codex_home`, a Codex Apps cache key derived from auth, `host_owned_codex_apps_enabled = true`, MCP naming/elici­tation settings, and auth references; then stores the resulting manager into `session.services.mcp_connection_manager`.

**Call relations**: Called by auth-elicitation tests that need the production code to recognize Codex Apps as host-owned and therefore eligible for auth recovery prompts.

*Call graph*: calls 3 internal fn (new, new, permission_profile); called by 4 (codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result, codex_apps_auth_elicitation_feature_disabled_returns_original_result, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result); 7 external calls (new, new, new, default, codex_apps_tools_cache_key, get_tx_event, default).


##### `codex_apps_auth_elicitation_feature_disabled_returns_original_result`  (lines 1294–1312)

```
async fn codex_apps_auth_elicitation_feature_disabled_returns_original_result()
```

**Purpose**: Verifies that auth-elicitation is skipped entirely when the feature flag is disabled, even if the session has a host-owned Codex Apps manager and the tool result indicates auth failure.

**Data flow**: Creates a session/turn with event receiver, installs the host-owned manager, builds the auth-failure result and metadata, calls `maybe_request_codex_apps_auth_elicitation`, and asserts the returned result equals the original and no event was emitted.

**Call relations**: Covers the earliest feature-gate exit in the auth-elicitation flow.

*Call graph*: calls 4 internal fn (codex_apps_auth_failure_metadata, codex_apps_auth_failure_result, install_host_owned_codex_apps_manager, make_session_and_context_with_rx); 2 external calls (assert!, assert_eq!).


##### `codex_apps_auth_elicitation_non_host_owned_server_returns_original_result`  (lines 1315–1337)

```
async fn codex_apps_auth_elicitation_non_host_owned_server_returns_original_result()
```

**Purpose**: Checks that enabling the feature alone is insufficient; auth elicitation is skipped when the session is not configured with a host-owned Codex Apps manager.

**Data flow**: Creates a session/turn with receiver, enables `Feature::AuthElicitation` in `turn_context.features`, builds the auth-failure result and metadata, calls `maybe_request_codex_apps_auth_elicitation`, and asserts the original result is returned with no emitted event.

**Call relations**: Covers the host-owned-server precondition branch.

*Call graph*: calls 5 internal fn (from, codex_apps_auth_failure_metadata, codex_apps_auth_failure_result, make_session_and_context_with_rx, with_defaults); 3 external calls (get_mut, assert!, assert_eq!).


##### `codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result`  (lines 1340–1366)

```
async fn codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result()
```

**Purpose**: Verifies that auth elicitation is suppressed when approval policy is `AskForApproval::Never`, even with feature flag and host-owned manager enabled.

**Data flow**: Creates a session/turn with receiver, installs the host-owned manager, enables `Feature::AuthElicitation`, mutates `approval_policy` to `Never`, invokes `maybe_request_codex_apps_auth_elicitation`, and asserts the original result is returned and no event is queued.

**Call relations**: Tests policy-based gating in the auth-elicitation path.

*Call graph*: calls 6 internal fn (from, codex_apps_auth_failure_metadata, codex_apps_auth_failure_result, install_host_owned_codex_apps_manager, make_session_and_context_with_rx, with_defaults); 3 external calls (get_mut, assert!, assert_eq!).


##### `codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result`  (lines 1369–1401)

```
async fn codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result()
```

**Purpose**: Checks that granular approval policy disables auth elicitation when `mcp_elicitations` is false.

**Data flow**: Creates a session/turn with receiver, installs the host-owned manager, enables `Feature::AuthElicitation`, sets `approval_policy` to a `GranularApprovalConfig` with `mcp_elicitations=false`, invokes `maybe_request_codex_apps_auth_elicitation`, and asserts the original result is returned with no event.

**Call relations**: Covers the granular-policy branch distinct from the blanket `Never` policy.

*Call graph*: calls 6 internal fn (from, codex_apps_auth_failure_metadata, codex_apps_auth_failure_result, install_host_owned_codex_apps_manager, make_session_and_context_with_rx, with_defaults); 4 external calls (get_mut, Granular, assert!, assert_eq!).


##### `codex_apps_auth_elicitation_feature_enabled_requests_elicitation`  (lines 1404–1474)

```
async fn codex_apps_auth_elicitation_feature_enabled_requests_elicitation()
```

**Purpose**: End-to-end test proving that a host-owned Codex Apps auth failure triggers an elicitation request when the feature and policy allow it, and that accepting the elicitation rewrites the tool result into a retry instruction.

**Data flow**: Creates a session/turn with receiver, installs the host-owned manager, marks an active turn, enables `Feature::AuthElicitation`, spawns `maybe_request_codex_apps_auth_elicitation` in a task, loops on received events until it finds `EventMsg::ElicitationRequest`, asserts the request server name, request ID, and URL request shape, resolves the elicitation through `session.resolve_elicitation(...)` with `ElicitationAction::Accept`, awaits the task, and asserts the returned `CallToolResult.content` contains the acceptance/retry message for Google Calendar.

**Call relations**: This is the positive-path integration test for auth elicitation, covering event emission, request identity, response resolution, and final result rewriting.

*Call graph*: calls 7 internal fn (from, codex_apps_auth_failure_metadata, codex_apps_auth_failure_result, install_host_owned_codex_apps_manager, make_session_and_context_with_rx, default, with_defaults); 8 external calls (clone, get_mut, String, assert!, assert_eq!, from_secs, spawn, timeout).


##### `mcp_tool_call_thread_id_meta_is_added_to_request_meta`  (lines 1477–1503)

```
fn mcp_tool_call_thread_id_meta_is_added_to_request_meta()
```

**Purpose**: Verifies that helper logic injects or overwrites `threadId` in request metadata objects while leaving non-object metadata untouched.

**Data flow**: Calls `with_mcp_tool_call_thread_id_meta` with an object containing a stale `threadId`, with `None`, and with a non-object JSON string, asserting respectively that the thread ID is replaced, a new object is created, and invalid metadata is returned unchanged.

**Call relations**: Standalone unit test for request-meta augmentation used before MCP dispatch.

*Call graph*: 1 external calls (assert_eq!).


##### `accepted_elicitation_content_converts_to_request_user_input_response`  (lines 1506–1524)

```
fn accepted_elicitation_content_converts_to_request_user_input_response()
```

**Purpose**: Checks conversion from accepted elicitation JSON content into the synthetic `RequestUserInputResponse` shape used by shared approval parsing code.

**Data flow**: Passes JSON content `{ "approval": MCP_TOOL_APPROVAL_ACCEPT_AND_REMEMBER }` into `request_user_input_response_from_elicitation_content` and asserts it returns a `RequestUserInputResponse` whose `answers` map contains the expected single answer vector.

**Call relations**: Covers the bridge between MCP elicitation responses and the generic request-user-input approval parser.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `approval_elicitation_meta_marks_tool_approvals`  (lines 1527–1542)

```
fn approval_elicitation_meta_marks_tool_approvals()
```

**Purpose**: Verifies the minimal approval elicitation metadata object contains the MCP tool approval kind marker.

**Data flow**: Calls `build_mcp_tool_approval_elicitation_meta` for a custom server with no metadata, params, or persistence options, and asserts the returned JSON is `{ MCP_TOOL_APPROVAL_KIND_KEY: MCP_TOOL_APPROVAL_KIND_MCP_TOOL_CALL }`.

**Call relations**: Baseline test for elicitation metadata generation.

*Call graph*: 1 external calls (assert_eq!).


##### `approval_elicitation_meta_merges_session_and_always_persist_for_custom_servers`  (lines 1545–1575)

```
fn approval_elicitation_meta_merges_session_and_always_persist_for_custom_servers()
```

**Purpose**: Checks that custom-server approval elicitation metadata includes persistence options, tool title/description, and raw tool params.

**Data flow**: Builds metadata with tool title and description plus JSON params `{ id: 1 }`, calls `build_mcp_tool_approval_elicitation_meta` with both remember flags enabled, and asserts the returned JSON contains the kind marker, both persistence values, tool descriptive fields, and `MCP_TOOL_APPROVAL_TOOL_PARAMS_KEY`.

**Call relations**: Covers the richer custom-server metadata branch used when approval choices can be remembered.

*Call graph*: 1 external calls (assert_eq!).


##### `guardian_mcp_review_request_includes_invocation_metadata`  (lines 1578–1616)

```
fn guardian_mcp_review_request_includes_invocation_metadata()
```

**Purpose**: Verifies that guardian review requests for MCP tool calls include invocation arguments and connector/tool descriptive metadata.

**Data flow**: Creates a Codex Apps `McpInvocation` with URL arguments and approval metadata for the Playwright connector, calls `build_guardian_mcp_tool_review_request`, and asserts deep equality with the expected `GuardianApprovalRequest::McpToolCall` including IDs, arguments, connector fields, tool fields, and `annotations: None`.

**Call relations**: Tests the request-shaping path used when MCP approvals are delegated to guardian review.

*Call graph*: calls 1 internal fn (approval_metadata); 2 external calls (assert_eq!, json!).


##### `guardian_mcp_review_request_includes_annotations_when_present`  (lines 1619–1659)

```
fn guardian_mcp_review_request_includes_annotations_when_present()
```

**Purpose**: Checks that guardian review requests translate MCP tool annotations into `GuardianMcpAnnotations` when metadata includes them.

**Data flow**: Creates a custom-server invocation and metadata containing `ToolAnnotations`, builds the guardian review request, and asserts the resulting `GuardianApprovalRequest::McpToolCall` includes `annotations` with the expected destructive, open-world, and read-only hints.

**Call relations**: Complements the previous guardian request test by covering annotation propagation.

*Call graph*: calls 1 internal fn (annotations); 1 external calls (assert_eq!).


##### `guardian_review_decision_maps_to_mcp_tool_decision`  (lines 1662–1719)

```
async fn guardian_review_decision_maps_to_mcp_tool_decision()
```

**Purpose**: Verifies how guardian review outcomes are converted into MCP approval decisions, including rationale lookup for denials and timeout wording.

**Data flow**: Creates a session, calls `mcp_tool_approval_decision_from_guardian` for `Approved` and asserts `Accept`; inserts a `GuardianRejection` with rationale into `session.services.guardian_rejections`, calls the mapper for `Denied` and pattern-matches a decline message containing the rationale and anti-circumvention warning; calls it again for `TimedOut` and asserts the timeout message wording; finally asserts `Abort` maps to `Decline { message: None }`.

**Call relations**: Unit test for the final translation layer after guardian review completes.

*Call graph*: calls 1 internal fn (make_session_and_context); 4 external calls (new, assert!, assert_eq!, panic!).


##### `approval_elicitation_meta_includes_connector_source_for_codex_apps`  (lines 1722–1754)

```
fn approval_elicitation_meta_includes_connector_source_for_codex_apps()
```

**Purpose**: Checks that Codex Apps approval elicitation metadata marks the source as a connector and includes connector descriptive fields.

**Data flow**: Builds connector metadata and tool params for the `calendar` connector, calls `build_mcp_tool_approval_elicitation_meta` with no remember flags, and asserts the returned JSON contains the kind marker, connector source marker, connector ID/name/description, tool title/description, and raw params.

**Call relations**: Covers the Codex Apps-specific metadata branch distinct from custom servers.

*Call graph*: 1 external calls (assert_eq!).


##### `approval_elicitation_meta_merges_session_and_always_persist_with_connector_source`  (lines 1757–1793)

```
fn approval_elicitation_meta_merges_session_and_always_persist_with_connector_source()
```

**Purpose**: Verifies that Codex Apps elicitation metadata can combine connector-source fields with both session and persistent remember options.

**Data flow**: Builds the same connector metadata and params as the previous test but enables both remember flags, then asserts the returned JSON includes the persistence array alongside the connector and tool fields.

**Call relations**: Complements the previous test by covering the remembered-approval variant.

*Call graph*: 1 external calls (assert_eq!).


##### `declined_elicitation_response_stays_decline`  (lines 1796–1809)

```
fn declined_elicitation_response_stays_decline()
```

**Purpose**: Ensures an explicit elicitation decline remains a decline even if the content payload contains an accept label.

**Data flow**: Builds an `ElicitationResponse` with `action = Decline` and content `{ approval: ACCEPT }`, passes it to `parse_mcp_tool_approval_elicitation_response`, and asserts the result is `McpToolApprovalDecision::Decline { message: None }`.

**Call relations**: Tests precedence rules in elicitation response parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `synthetic_decline_request_user_input_response_stays_decline`  (lines 1812–1826)

```
fn synthetic_decline_request_user_input_response_stays_decline()
```

**Purpose**: Checks that the synthetic decline sentinel in a generic request-user-input response maps to a decline decision.

**Data flow**: Constructs a `RequestUserInputResponse` whose `approval` answer vector contains `MCP_TOOL_APPROVAL_DECLINE_SYNTHETIC`, passes it to `parse_mcp_tool_approval_response`, and asserts the result is `Decline { message: None }`.

**Call relations**: Covers the generic approval-response parser used for non-MCP elicitation flows.

*Call graph*: 3 external calls (from, assert_eq!, vec!).


##### `accepted_elicitation_response_uses_always_persist_meta`  (lines 1829–1842)

```
fn accepted_elicitation_response_uses_always_persist_meta()
```

**Purpose**: Verifies that accepted elicitation responses can encode persistent remember via response metadata alone.

**Data flow**: Builds an `ElicitationResponse` with `action = Accept`, no content, and meta `{ MCP_TOOL_APPROVAL_PERSIST_KEY: MCP_TOOL_APPROVAL_PERSIST_ALWAYS }`, parses it, and asserts the decision is `AcceptAndRemember`.

**Call relations**: Tests one accepted-response parsing branch keyed off response metadata.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `accepted_elicitation_response_uses_session_persist_meta`  (lines 1845–1858)

```
fn accepted_elicitation_response_uses_session_persist_meta()
```

**Purpose**: Verifies that accepted elicitation responses can encode session-scoped remember via response metadata.

**Data flow**: Builds an accepted `ElicitationResponse` with meta `{ MCP_TOOL_APPROVAL_PERSIST_KEY: MCP_TOOL_APPROVAL_PERSIST_SESSION }`, parses it, and asserts the decision is `AcceptForSession`.

**Call relations**: Parallel to the persistent-remember parsing test.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `accepted_elicitation_without_content_defaults_to_accept`  (lines 1861–1872)

```
fn accepted_elicitation_without_content_defaults_to_accept()
```

**Purpose**: Checks the default accepted-response behavior when no content or persistence metadata is present.

**Data flow**: Builds an accepted `ElicitationResponse` with `content=None` and `meta=None`, parses it, and asserts the decision is plain `Accept`.

**Call relations**: Covers the fallback branch of accepted elicitation parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `persist_codex_app_tool_approval_writes_tool_override`  (lines 1875–1917)

```
async fn persist_codex_app_tool_approval_writes_tool_override()
```

**Purpose**: Verifies that persisting approval for a Codex App tool writes the expected `[apps.<connector>.tools.<tool>]` override into `config.toml`.

**Data flow**: Creates a temp codex home, builds a `Config`, calls `persist_codex_app_tool_approval(&config, "calendar", "calendar/list_events")`, reads and parses the resulting `CONFIG_TOML_FILE` as `ConfigToml`, and asserts the `apps` section contains an enabled `calendar` app with a tool override whose `approval_mode` is `Approve`. It also checks the raw TOML contains the expected table header.

**Call relations**: Tests the file-writing persistence helper for Codex Apps approvals.

*Call graph*: 6 external calls (assert!, assert_eq!, default, read_to_string, tempdir, from_str).


##### `persist_custom_mcp_tool_approval_writes_tool_override`  (lines 1920–1952)

```
async fn persist_custom_mcp_tool_approval_writes_tool_override()
```

**Purpose**: Checks that persisting approval for a custom MCP server writes the expected tool override under `[mcp_servers.<server>.tools.<tool>]`.

**Data flow**: Seeds a temp `config.toml` with `[mcp_servers.docs]`, builds a `Config`, calls `persist_custom_mcp_tool_approval(&config, "docs", "search")`, reads and parses the file, extracts `docs/search`, and asserts it equals `McpServerToolConfig { approval_mode: Some(AppToolApproval::Approve) }`. It also checks the raw TOML table header.

**Call relations**: Parallel to the Codex Apps persistence test, but for custom MCP server config.

*Call graph*: 7 external calls (assert!, assert_eq!, default, read_to_string, write, tempdir, from_str).


##### `custom_mcp_tool_approval_mode_uses_server_default_with_tool_override`  (lines 1955–1989)

```
async fn custom_mcp_tool_approval_mode_uses_server_default_with_tool_override()
```

**Purpose**: Verifies resolution of custom MCP tool approval mode from server defaults and per-tool overrides in config.

**Data flow**: Seeds a temp config with `mcp_servers.docs.default_tools_approval_mode = "approve"` and a `search` tool override of `prompt`, builds config, injects it into a synthetic turn context, then calls `custom_mcp_tool_approval_mode` for `docs/read`, `docs/search`, and `unknown/search`, asserting `Approve`, `Prompt`, and `Auto` respectively.

**Call relations**: Tests config lookup precedence for custom MCP approval mode resolution.

*Call graph*: calls 1 internal fn (make_session_and_context); 5 external calls (new, assert_eq!, default, write, tempdir).


##### `custom_mcp_tool_approval_mode_uses_plugin_mcp_policy`  (lines 1992–2029)

```
async fn custom_mcp_tool_approval_mode_uses_plugin_mcp_policy()
```

**Purpose**: Checks that plugin-scoped MCP server policy is consulted when resolving approval mode for plugin-provided servers.

**Data flow**: Creates a synthetic plugin on disk, seeds config enabling plugins and defining plugin MCP approval policy with a server default of `prompt` and a `search` override of `approve`, rebuilds config, clears the plugin manager cache, and asserts `custom_mcp_tool_approval_mode` returns `Prompt` for `read` and `Approve` for `search` on server `sample`.

**Call relations**: Exercises the plugin-aware branch of approval-mode resolution.

*Call graph*: calls 2 internal fn (write_sample_plugin_mcp, make_session_and_context); 4 external calls (new, assert_eq!, default, write).


##### `custom_mcp_tool_approval_mode_uses_updated_plugin_mcp_policy_after_cache_warm`  (lines 2032–2082)

```
async fn custom_mcp_tool_approval_mode_uses_updated_plugin_mcp_policy_after_cache_warm()
```

**Purpose**: Verifies that plugin MCP approval policy reflects updated config even after the plugin cache has already been warmed.

**Data flow**: Creates a plugin and initial config enabling it, loads initial config and warms `plugins_manager.plugins_for_config(...)`, rewrites `config.toml` to add a `search` approval override, rebuilds config, injects it into the turn context, and asserts `custom_mcp_tool_approval_mode` now returns `Approve` for `sample/search`.

**Call relations**: Regression test against stale plugin-cache behavior during policy lookup.

*Call graph*: calls 2 internal fn (write_sample_plugin_mcp, make_session_and_context); 4 external calls (new, assert_eq!, default, write).


##### `maybe_persist_mcp_tool_approval_reloads_session_config`  (lines 2085–2121)

```
async fn maybe_persist_mcp_tool_approval_reloads_session_config()
```

**Purpose**: Checks that persisting a remembered Codex Apps approval updates on-disk config and reloads the session’s effective config immediately.

**Data flow**: Creates a session/turn, ensures `codex_home` exists, builds an `McpToolApprovalKey` for `calendar/list_events`, calls `maybe_persist_mcp_tool_approval`, then fetches `session.get_config()`, extracts the effective `apps` table, deserializes it into `AppsConfigToml`, and asserts the tool override exists with `approval_mode = Approve`. It also asserts `mcp_tool_approval_is_remembered` returns `true`.

**Call relations**: End-to-end persistence test covering both file mutation and in-memory session config refresh.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert_eq!, deserialize, create_dir_all).


##### `maybe_persist_mcp_tool_approval_reloads_session_config_for_custom_server`  (lines 2124–2169)

```
async fn maybe_persist_mcp_tool_approval_reloads_session_config_for_custom_server()
```

**Purpose**: Verifies the same reload behavior for remembered approvals on custom MCP servers.

**Data flow**: Creates a session/turn, seeds `config.toml` with `[mcp_servers.docs]`, builds config without managed config, injects it into the turn context, constructs a `docs/search` approval key, calls `maybe_persist_mcp_tool_approval`, then reads `session.get_config()`, extracts and deserializes the effective `mcp_servers` table, and asserts the `search` tool override exists with `approval_mode = Approve`. It also checks remembered state.

**Call relations**: Parallel to the previous test for the custom-server persistence path.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, make_session_and_context); 5 external calls (new, deserialize, assert_eq!, create_dir_all, write).


##### `maybe_persist_mcp_tool_approval_writes_plugin_mcp_policy`  (lines 2172–2219)

```
async fn maybe_persist_mcp_tool_approval_writes_plugin_mcp_policy()
```

**Purpose**: Checks that remembered approvals for plugin-provided MCP servers are written into the plugin section of `config.toml` and reflected in remembered state.

**Data flow**: Creates a plugin on disk, seeds config enabling it, rebuilds config, clears plugin cache, constructs a `sample/search` approval key, calls `maybe_persist_mcp_tool_approval`, reads and parses `config.toml`, extracts the plugin MCP server tool config, and asserts `approval_mode = Approve`, the raw TOML contains the plugin-scoped table header, and `mcp_tool_approval_is_remembered` is `true`.

**Call relations**: Covers the plugin-specific persistence branch.

*Call graph*: calls 2 internal fn (write_sample_plugin_mcp, make_session_and_context); 7 external calls (new, assert!, assert_eq!, default, read_to_string, write, from_str).


##### `maybe_persist_mcp_tool_approval_writes_project_config_for_project_server`  (lines 2222–2274)

```
async fn maybe_persist_mcp_tool_approval_writes_project_config_for_project_server()
```

**Purpose**: Verifies that remembered approvals for project-scoped MCP servers are written into the trusted project’s `.codex/config.toml` rather than global config.

**Data flow**: Creates a session/turn, a temporary project directory with `.git` and `.codex/config.toml`, marks the project trusted via `ConfigEditsBuilder`, builds config with that project as fallback cwd, injects it into the turn context, constructs a `docs/search` approval key, calls `maybe_persist_mcp_tool_approval`, then reads and parses the project-local config file and asserts the tool override exists with `approval_mode = Approve`. It also checks the raw table header and remembered state.

**Call relations**: Tests config-target selection logic for project-local persistence.

*Call graph*: calls 2 internal fn (new, make_session_and_context); 9 external calls (new, assert!, assert_eq!, default, create_dir_all, read_to_string, write, tempdir, from_str).


##### `approve_mode_skips_when_annotations_do_not_require_approval`  (lines 2277–2315)

```
async fn approve_mode_skips_when_annotations_do_not_require_approval()
```

**Purpose**: Checks that `AppToolApproval::Approve` does not force an approval interaction for clearly safe read-only tools.

**Data flow**: Creates a session and turn, wraps them in `Arc`, builds a read-only custom-server invocation and metadata, calls `maybe_request_mcp_tool_approval` with `AppToolApproval::Approve`, and asserts the returned decision is `None`.

**Call relations**: Covers the optimization where safe tools bypass approval even under approve mode.

*Call graph*: calls 3 internal fn (annotations, make_session_and_context, new); 2 external calls (new, assert_eq!).


##### `guardian_mode_skips_auto_when_annotations_do_not_require_approval`  (lines 2318–2389)

```
async fn guardian_mode_skips_auto_when_annotations_do_not_require_approval()
```

**Purpose**: Verifies that auto-review/guardian mode is not consulted for clearly safe read-only tools, avoiding unnecessary model calls.

**Data flow**: Starts a mock server expecting zero `/v1/responses` requests, creates a session/turn configured with `AskForApproval::OnRequest`, `ApprovalsReviewer::AutoReview`, and a model provider pointing at the mock server, then calls `maybe_request_mcp_tool_approval` for a read-only tool under `AppToolApproval::Auto` and asserts the decision is `None`.

**Call relations**: Regression test ensuring the guardian path is skipped before any external review request is attempted.

*Call graph*: calls 5 internal fn (annotations, make_session_and_context, models_manager_with_provider, new, start_mock_server); 7 external calls (clone, new, given, new, assert_eq!, create_model_provider, format!).


##### `permission_request_hook_allows_mcp_tool_call`  (lines 2392–2472)

```
async fn permission_request_hook_allows_mcp_tool_call()
```

**Purpose**: End-to-end test showing that a `PermissionRequest` hook can allow an MCP tool call and receives the expected hook payload.

**Data flow**: Creates a session/turn, installs a hook matching `mcp__memory__.*` that returns an allow decision, wraps session/turn in `Arc`, builds a destructive `memory/create_entities` invocation and metadata, calls `maybe_request_mcp_tool_approval` under `AppToolApproval::Auto`, asserts it returns `Some(Accept)`, then reads the hook log file, parses each JSON line, and asserts the single logged payload contains session ID, turn ID, cwd, model, permission mode, hook event name, tool name, and exact tool input.

**Call relations**: Exercises the hook-based approval path before any user prompt or guardian review.

*Call graph*: calls 4 internal fn (annotations, install_mcp_permission_request_hook, make_session_and_context, new); 4 external calls (new, assert_eq!, json!, read_to_string).


##### `permission_request_hook_uses_hook_tool_name_without_metadata`  (lines 2475–2529)

```
async fn permission_request_hook_uses_hook_tool_name_without_metadata()
```

**Purpose**: Checks that hook payload generation does not depend on approval metadata and still uses the provided `HookToolName`.

**Data flow**: Installs the same allow hook as the previous test, builds a `memory/create_entities` invocation without metadata, calls `maybe_request_mcp_tool_approval`, asserts `Some(Accept)`, then reads and parses the hook log and asserts the payload still contains the expected `tool_name` and `tool_input` fields.

**Call relations**: Covers the no-metadata branch of hook payload construction.

*Call graph*: calls 3 internal fn (install_mcp_permission_request_hook, make_session_and_context, new); 4 external calls (new, assert_eq!, json!, read_to_string).


##### `permission_request_hook_runs_after_remembered_mcp_approval`  (lines 2532–2592)

```
async fn permission_request_hook_runs_after_remembered_mcp_approval()
```

**Purpose**: Verifies that remembered session approvals short-circuit hook execution entirely.

**Data flow**: Creates a session/turn, installs a deny hook, builds a destructive memory invocation and metadata, derives a session approval key with `session_mcp_tool_approval_key`, stores it via `remember_mcp_tool_approval`, wraps session/turn in `Arc`, calls `maybe_request_mcp_tool_approval`, asserts `Some(Accept)`, and finally asserts the hook log path does not exist.

**Call relations**: Tests precedence between remembered approvals and hook-based permission requests.

*Call graph*: calls 4 internal fn (annotations, install_mcp_permission_request_hook, make_session_and_context, new); 4 external calls (new, assert!, assert_eq!, json!).


##### `guardian_mode_mcp_denial_returns_rationale_message`  (lines 2595–2680)

```
async fn guardian_mode_mcp_denial_returns_rationale_message()
```

**Purpose**: End-to-end test showing that guardian auto-review can deny an MCP tool call and that the returned decline message includes the guardian rationale plus anti-circumvention guidance.

**Data flow**: Starts a mock SSE server that emits a completed assistant response containing JSON with `outcome: deny` and a rationale, configures a session/turn for `AskForApproval::OnRequest` and `ApprovalsReviewer::AutoReview` against that server, builds a destructive custom-server invocation and metadata, calls `maybe_request_mcp_tool_approval`, pattern-matches a decline with message, and asserts the message contains the rationale and policy-circumvention wording. It also asserts the guardian request hit `/v1/responses`.

**Call relations**: Positive-path integration test for the guardian denial branch, including external review request and message synthesis.

*Call graph*: calls 7 internal fn (annotations, make_session_and_context, models_manager_with_provider, new, mount_sse_once, sse, start_mock_server); 9 external calls (clone, new, assert!, assert_eq!, create_model_provider, format!, panic!, json!, vec!).


##### `prompt_mode_waits_for_approval_when_annotations_do_not_require_approval`  (lines 2683–2735)

```
async fn prompt_mode_waits_for_approval_when_annotations_do_not_require_approval()
```

**Purpose**: Checks that explicit prompt mode still waits for user approval even for read-only tools that auto/approve modes would skip.

**Data flow**: Creates a session/turn with event receiver, marks an active turn, builds a read-only invocation and metadata, spawns `maybe_request_mcp_tool_approval` under `AppToolApproval::Prompt`, then asserts a short timeout expires without the task completing and aborts the task.

**Call relations**: Covers the distinction between prompt mode and auto/approve shortcuts for safe tools.

*Call graph*: calls 4 internal fn (annotations, make_session_and_context_with_rx, default, new); 3 external calls (clone, assert!, spawn).


##### `full_access_mode_skips_mcp_tool_approval_for_all_approval_modes`  (lines 2738–2784)

```
async fn full_access_mode_skips_mcp_tool_approval_for_all_approval_modes()
```

**Purpose**: Verifies that full-access permission mode disables MCP approval checks entirely regardless of per-tool approval mode.

**Data flow**: Creates a session/turn, sets `approval_policy` to `Never` and `permission_profile` to `PermissionProfile::Disabled`, wraps them in `Arc`, builds a destructive Codex Apps invocation and metadata, iterates over `AppToolApproval::{Auto,Prompt,Approve}`, calls `maybe_request_mcp_tool_approval` for each, and asserts every result is `None`.

**Call relations**: Regression test for the top-level bypass when sandbox/permission restrictions are disabled.

*Call graph*: calls 3 internal fn (annotations, make_session_and_context, new); 3 external calls (new, assert_eq!, json!).


##### `approve_mode_skips_guardian_in_every_permission_mode`  (lines 2787–2872)

```
async fn approve_mode_skips_guardian_in_every_permission_mode()
```

**Purpose**: Ensures `AppToolApproval::Approve` never triggers guardian/user review, across all approval-policy variants.

**Data flow**: Starts a mock server expecting zero review requests, defines a destructive Codex Apps invocation and metadata, then loops over several `AskForApproval` policies. For each, it creates a session/turn with auth, configures reviewer `User` and model/chat endpoints to the mock server, calls `maybe_request_mcp_tool_approval` under `AppToolApproval::Approve`, and asserts the result is `None`.

**Call relations**: Broad regression test proving approve mode short-circuits review logic independently of the surrounding approval policy.

*Call graph*: calls 7 internal fn (annotations, make_session_and_context, auth_manager_from_auth, models_manager_with_provider, new, start_mock_server, create_dummy_chatgpt_auth_for_testing); 9 external calls (clone, new, given, new, Granular, assert_eq!, create_model_provider, format!, json!).


### `core/src/unified_exec/async_watcher_tests.rs`

`test` · `test execution`

This file contains narrow unit tests for `split_valid_utf8_prefix_with_max`, the helper that slices raw process output into event-sized chunks without breaking UTF-8 boundaries. The first test uses plain ASCII bytes and confirms that the helper emits exactly `max_bytes` when possible, draining the consumed prefix from the original buffer and leaving the remainder for subsequent calls. The second test uses repeated `é` characters, which occupy two bytes each in UTF-8, to prove that a three-byte limit does not split a codepoint: only one full character is emitted and the remaining bytes stay buffered. The final test feeds an invalid leading byte followed by valid ASCII and checks the fallback behavior: when no valid UTF-8 prefix exists within the limit, the function emits a single raw byte so the stream can continue making progress instead of stalling forever. Together these tests document the contract relied on by the async watcher when converting arbitrary PTY bytes into downstream `ExecCommandOutputDelta` payloads.

#### Function details

##### `split_valid_utf8_prefix_respects_max_bytes_for_ascii`  (lines 6–18)

```
fn split_valid_utf8_prefix_respects_max_bytes_for_ascii()
```

**Purpose**: Checks that ASCII data is split strictly at the configured byte limit and that consumed bytes are removed from the source buffer. It demonstrates repeated incremental extraction.

**Data flow**: Initializes `buf` with `b"hello word!"`, calls `split_valid_utf8_prefix_with_max(&mut buf, 5)` twice, and asserts the returned prefixes are `b"hello"` and `b" word"` while `buf` shrinks first to `b" word!"` and then to `b"!"`.

**Call relations**: This is a direct unit test run by the test harness against the helper in `async_watcher.rs`. It covers the common fast path where all bytes are valid single-byte UTF-8.

*Call graph*: 2 external calls (assert_eq!, split_valid_utf8_prefix_with_max).


##### `split_valid_utf8_prefix_avoids_splitting_utf8_codepoints`  (lines 21–29)

```
fn split_valid_utf8_prefix_avoids_splitting_utf8_codepoints()
```

**Purpose**: Verifies that the splitter backs off rather than cutting through a multibyte UTF-8 character. It protects streamed output from producing invalid text fragments.

**Data flow**: Creates a buffer from `"ééé".as_bytes()`, calls `split_valid_utf8_prefix_with_max(&mut buf, 3)`, converts the returned bytes back to UTF-8, and asserts the prefix is exactly one `é` while the remaining buffer still contains two `é` characters.

**Call relations**: This test is invoked by the harness to validate the backward-scan logic inside the splitter. It specifically exercises the branch where `max_bytes` lands in the middle of a codepoint.

*Call graph*: 2 external calls (assert_eq!, split_valid_utf8_prefix_with_max).


##### `split_valid_utf8_prefix_makes_progress_on_invalid_utf8`  (lines 32–39)

```
fn split_valid_utf8_prefix_makes_progress_on_invalid_utf8()
```

**Purpose**: Confirms that malformed input does not block output processing forever. The helper must emit at least one byte even when no valid UTF-8 prefix exists.

**Data flow**: Starts with `buf = vec![0xff, b'a', b'b']`, calls `split_valid_utf8_prefix_with_max(&mut buf, 2)`, and asserts the returned prefix is the single invalid byte `0xff` while the remaining buffer becomes `b"ab"`.

**Call relations**: This harness-driven test targets the splitter’s final fallback branch. It documents the progress guarantee relied on by `process_chunk` when PTY output contains invalid byte sequences.

*Call graph*: 3 external calls (assert_eq!, split_valid_utf8_prefix_with_max, vec!).


### `core/src/unified_exec/head_tail_buffer_tests.rs`

`test` · `test execution`

This file exercises `HeadTailBuffer` as the retention mechanism for unified-exec transcripts. The tests cover both normal and edge-case capacities. Over-budget behavior is checked by filling a ten-byte buffer and then appending more data: the rendered output must keep the earliest prefix and latest suffix while `omitted_bytes` increases to reflect dropped middle bytes. A zero-capacity buffer must retain nothing, count all bytes as omitted, and report empty snapshots and flattened output. The one-byte-capacity case verifies the asymmetric split when `head_budget` becomes zero and only the final tail byte survives.

State-reset behavior is covered by draining a populated buffer and asserting that retained bytes, omitted bytes, and rendered output all return to empty defaults. Another test targets the special path where a single incoming chunk is larger than the entire tail budget: the old tail should be replaced and only the last tail-budget bytes of the new chunk should remain. Finally, a multi-chunk test demonstrates the intended fill order—head first across multiple pushes, then tail—and shows that once the tail is full, each additional byte evicts the oldest tail byte. Together these tests make the retention policy concrete and guard the invariants relied on by final transcript aggregation.

#### Function details

##### `keeps_prefix_and_suffix_when_over_budget`  (lines 6–19)

```
fn keeps_prefix_and_suffix_when_over_budget()
```

**Purpose**: Verifies that once the buffer exceeds its capacity, it preserves the earliest prefix and latest suffix while dropping the middle. It also checks that omitted-byte accounting stays zero until overflow actually occurs.

**Data flow**: Creates `HeadTailBuffer::new(10)`, pushes `"0123456789"`, asserts `omitted_bytes() == 0`, then pushes `"ab"`, asserts omitted bytes increased, renders `to_bytes()` through `String::from_utf8_lossy`, and checks the string starts with `"01234"` and ends with `"89ab"`.

**Call relations**: This unit test is run by the harness against `HeadTailBuffer` and exercises the common overflow path where head and tail are both populated.

*Call graph*: calls 1 internal fn (new); 3 external calls (from_utf8_lossy, assert!, assert_eq!).


##### `max_bytes_zero_drops_everything`  (lines 22–30)

```
fn max_bytes_zero_drops_everything()
```

**Purpose**: Checks the degenerate zero-capacity case where all input must be discarded. It ensures every readout API reflects an empty retained transcript.

**Data flow**: Constructs `HeadTailBuffer::new(0)`, pushes `"abc"`, then asserts `retained_bytes() == 0`, `omitted_bytes() == 3`, `to_bytes()` is empty, and `snapshot_chunks()` returns an empty `Vec<Vec<u8>>`.

**Call relations**: This test targets the early-return branch in `push_chunk` for `max_bytes == 0`. It documents the expected behavior for a fully disabled retention budget.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `head_budget_zero_keeps_only_last_byte_in_tail`  (lines 33–40)

```
fn head_budget_zero_keeps_only_last_byte_in_tail()
```

**Purpose**: Validates the smallest nonzero capacity, where the head budget is zero and only the tail can retain data. It confirms that only the newest byte survives.

**Data flow**: Creates `HeadTailBuffer::new(1)`, pushes `"abc"`, and asserts one retained byte, two omitted bytes, and flattened output equal to `"c"`.

**Call relations**: This harness-driven test exercises the path where all retention happens in the tail because integer division gives a zero-byte head.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `draining_resets_state`  (lines 43–54)

```
fn draining_resets_state()
```

**Purpose**: Ensures that draining a populated buffer returns retained chunks and fully resets counters and content. It guards against stale transcript state leaking across uses.

**Data flow**: Builds `HeadTailBuffer::new(10)`, pushes `"0123456789"` and `"ab"`, calls `drain_chunks()`, asserts the drained result is non-empty, then checks `retained_bytes()` and `omitted_bytes()` are zero and `to_bytes()` is empty.

**Call relations**: This test directly validates the destructive reset semantics of `drain_chunks`. It complements the non-destructive snapshot and flattening tests.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `chunk_larger_than_tail_budget_keeps_only_tail_end`  (lines 57–68)

```
fn chunk_larger_than_tail_budget_keeps_only_tail_end()
```

**Purpose**: Checks the special-case optimization for a chunk larger than the entire tail budget. The buffer should replace the old tail and keep only the newest tail-budget suffix of that chunk.

**Data flow**: Creates `HeadTailBuffer::new(10)`, pushes `"0123456789"`, then pushes `"ABCDEFGHIJK"`, renders `to_bytes()` as text, and asserts the output starts with `"01234"`, ends with `"GHIJK"`, and has positive omitted-byte count.

**Call relations**: This test targets the `chunk.len() >= tail_budget` branch in `push_to_tail`. It verifies that oversized chunks do not get appended and trimmed incrementally but instead replace the tail wholesale.

*Call graph*: calls 1 internal fn (new); 2 external calls (from_utf8_lossy, assert!).


##### `fills_head_then_tail_across_multiple_chunks`  (lines 71–89)

```
fn fills_head_then_tail_across_multiple_chunks()
```

**Purpose**: Demonstrates the intended fill order across multiple pushes: complete the head budget first, then accumulate the tail, then evict oldest tail bytes on further writes. It serves as a step-by-step behavioral example.

**Data flow**: Creates `HeadTailBuffer::new(10)`, pushes `"01"` and `"234"` and asserts `to_bytes()` is `"01234"`; then pushes `"567"` and `"89"` and asserts full output `"0123456789"` with zero omitted bytes; finally pushes `"a"` and asserts output becomes `"012346789a"` with one omitted byte.

**Call relations**: This test is run by the harness to validate the interaction between `push_chunk`, `push_to_tail`, and `trim_tail_to_budget` over several incremental writes.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### `core/src/unified_exec/process_manager_tests.rs`

`test` · `test-time validation of process-manager helpers and policies`

This test file validates the nontrivial helper behavior in `process_manager.rs`. Several unit tests focus on environment construction: `apply_unified_exec_env` must inject the fixed locale/pager/terminal defaults and override conflicting values, while `env_overlay_for_exec_server` must strip variables whose values already match the local policy environment so only runtime differences are sent remotely. `exec_server_params_use_path_uri_and_env_policy_overlay_contract` checks the full remote-launch contract: numeric process IDs become strings, cwd is converted with `PathUri::from_abs_path`, env policy is preserved, and only the overlay env is transmitted.

Platform-specific yield-time behavior is covered with separate Windows and non-Windows tests for `clamp_yield_time`. Async tests cover network-denial helpers: the fallback denial message when no session exists, and the late-denial grace period that should still observe cancellation shortly after exit. Another async test verifies `emit_failed_initial_exec_end_if_unstored` emits a failed `ExecCommandEnd` event with the fallback output text plus failure message when a process dies before being stored.

The final group of tests targets pruning policy directly through `UnifiedExecProcessManager::process_id_to_prune_from_meta`, asserting that pruning prefers exited processes outside the protected recent set, falls back to plain LRU when none are exited, and does not prune recently used processes even if they have already exited.

#### Function details

##### `unified_exec_env_injects_defaults`  (lines 8–24)

```
fn unified_exec_env_injects_defaults()
```

**Purpose**: Verifies that applying the unified-exec environment to an empty map produces exactly the expected fixed defaults.

**Data flow**: Creates an empty `HashMap`, passes it to `apply_unified_exec_env`, constructs an expected map containing the 10 default variables, and asserts equality.

**Call relations**: Directly exercises the environment-default injection helper to lock down the baseline process environment contract.

*Call graph*: 4 external calls (from, new, new, assert_eq!).


##### `unified_exec_env_overrides_existing_values`  (lines 27–36)

```
fn unified_exec_env_overrides_existing_values()
```

**Purpose**: Checks that unified-exec defaults overwrite conflicting keys while preserving unrelated environment entries.

**Data flow**: Builds a base map with `NO_COLOR=0` and `PATH=/usr/bin`, applies `apply_unified_exec_env`, then asserts that `NO_COLOR` became `1` while `PATH` remained unchanged.

**Call relations**: Complements the previous test by covering merge semantics rather than just the empty-input case.

*Call graph*: 2 external calls (new, assert_eq!).


##### `env_overlay_for_exec_server_keeps_runtime_changes_only`  (lines 39–67)

```
fn env_overlay_for_exec_server_keeps_runtime_changes_only()
```

**Purpose**: Ensures the exec-server overlay contains only variables whose values differ from the local policy environment.

**Data flow**: Constructs `local_policy_env` and `request_env` maps with overlapping and differing values, calls `env_overlay_for_exec_server`, and asserts that the result contains only changed or newly introduced keys.

**Call relations**: Validates the optimization/contract used before remote exec-server launch so redundant environment values are not resent.

*Call graph*: 2 external calls (from, assert_eq!).


##### `exec_server_params_use_path_uri_and_env_policy_overlay_contract`  (lines 70–128)

```
fn exec_server_params_use_path_uri_and_env_policy_overlay_contract()
```

**Purpose**: Tests that exec-server launch parameters preserve process ID, cwd conversion, env policy, and overlay-only environment transmission.

**Data flow**: Builds an `ExecRequest` with cwd, command, env, and `ExecServerEnvConfig`, calls `exec_server_params_for_request(123, &request, true)`, then asserts the string process ID, `PathUri` cwd, presence of env policy, and exact overlay env contents.

**Call relations**: Exercises the composed helper path from request/environment config into final remote `ExecParams`.

*Call graph*: calls 1 internal fn (unrestricted); 7 external calls (from, new, new, assert!, assert_eq!, current_dir, vec!).


##### `exec_server_process_id_matches_unified_exec_process_id`  (lines 131–133)

```
fn exec_server_process_id_matches_unified_exec_process_id()
```

**Purpose**: Confirms that exec-server process IDs are just the decimal string form of unified-exec numeric IDs.

**Data flow**: Calls `exec_server_process_id(4321)` and asserts the returned string equals `"4321"`.

**Call relations**: Pins down the ID-mapping convention used by remote execution.

*Call graph*: 1 external calls (assert_eq!).


##### `initial_exec_yield_time_uses_windows_floor`  (lines 137–149)

```
fn initial_exec_yield_time_uses_windows_floor()
```

**Purpose**: On Windows, verifies that initial exec yield time is clamped to the platform floor and maximum.

**Data flow**: Computes a value above the configured max, calls `clamp_yield_time` with representative low, normal, and too-high values, and asserts the expected floor/max behavior.

**Call relations**: Platform-gated test for the Windows-specific startup polling policy.

*Call graph*: 1 external calls (assert_eq!).


##### `initial_exec_yield_time_has_no_platform_floor`  (lines 153–159)

```
fn initial_exec_yield_time_has_no_platform_floor()
```

**Purpose**: On non-Windows platforms, verifies that initial exec yield time only respects the generic minimum and does not apply the Windows floor.

**Data flow**: Calls `clamp_yield_time` with a normal value and a too-small value, then asserts the unchanged normal result and clamped minimum result.

**Call relations**: Complements the Windows-only test to document cross-platform yield-time differences.

*Call graph*: 1 external calls (assert_eq!).


##### `network_denial_fallback_message_names_sandbox_network_proxy`  (lines 162–169)

```
async fn network_denial_fallback_message_names_sandbox_network_proxy()
```

**Purpose**: Checks the fallback denial message returned when no session/deferred approval context is available.

**Data flow**: Awaits `network_denial_message_for_session(None, None)` and asserts the exact fixed string naming the Codex sandbox network proxy.

**Call relations**: Validates the user-facing fallback text used in network-denial failure paths.

*Call graph*: 1 external calls (assert_eq!).


##### `late_network_denial_grace_observes_cancellation_after_exit`  (lines 172–181)

```
async fn late_network_denial_grace_observes_cancellation_after_exit()
```

**Purpose**: Verifies that the late-network-denial grace helper still reports denial when cancellation arrives shortly after waiting begins.

**Data flow**: Creates a `CancellationToken`, spawns a task that sleeps 10 ms then cancels it, awaits `wait_for_late_network_denial(Some(cancellation))`, and asserts the result is true.

**Call relations**: Exercises the grace-period timing logic used after process exit before finalizing network approval.

*Call graph*: 5 external calls (new, from_millis, assert!, spawn, sleep).


##### `failed_initial_end_for_unstored_process_uses_fallback_output`  (lines 184–258)

```
async fn failed_initial_end_for_unstored_process_uses_fallback_output()
```

**Purpose**: Ensures that a process which fails before being stored still emits a failed end event using the provided fallback output plus failure message.

**Data flow**: Creates a test session/turn/event receiver, builds a `UnifiedExecContext` and `ExecCommandRequest`, seeds a transcript buffer with partial output, calls `emit_failed_initial_exec_end_if_unstored(false, ...)`, then receives the emitted event and asserts its type, failed status, exit code, process ID, and aggregated output string.

**Call relations**: Covers the startup-failure event path that bypasses normal stored-process exit watching.

*Call graph*: calls 3 internal fn (make_session_and_context_with_rx, new, default); 9 external calls (clone, new, from_millis, from_secs, assert_eq!, panic!, new, timeout, vec!).


##### `pruning_prefers_exited_processes_outside_recently_used`  (lines 261–279)

```
fn pruning_prefers_exited_processes_outside_recently_used()
```

**Purpose**: Checks that pruning chooses an exited process when one exists outside the protected recent set.

**Data flow**: Builds synthetic `(process_id, last_used, exited)` metadata with one old exited process outside the newest eight, calls `UnifiedExecProcessManager::process_id_to_prune_from_meta`, and asserts the exited process ID is selected.

**Call relations**: Directly validates the first branch of the pruning policy.

*Call graph*: 4 external calls (now, assert_eq!, process_id_to_prune_from_meta, vec!).


##### `pruning_falls_back_to_lru_when_no_exited`  (lines 282–300)

```
fn pruning_falls_back_to_lru_when_no_exited()
```

**Purpose**: Checks that pruning falls back to the least recently used unprotected process when no exited candidates exist.

**Data flow**: Builds metadata where all processes are still running, calls `process_id_to_prune_from_meta`, and asserts the oldest process ID is returned.

**Call relations**: Validates the pruning policy’s fallback branch.

*Call graph*: 4 external calls (now, assert_eq!, process_id_to_prune_from_meta, vec!).


##### `pruning_protects_recent_processes_even_if_exited`  (lines 303–322)

```
fn pruning_protects_recent_processes_even_if_exited()
```

**Purpose**: Ensures recently used processes remain protected from pruning even if they have already exited.

**Data flow**: Builds metadata where one exited process is among the newest eight and another old process is outside that protected set, calls `process_id_to_prune_from_meta`, and asserts the old unprotected process is chosen instead of the recent exited one.

**Call relations**: Tests the interaction between recency protection and exited-process preference in the pruning algorithm.

*Call graph*: 4 external calls (now, assert_eq!, process_id_to_prune_from_meta, vec!).


### `core/src/unified_exec/process_tests.rs`

`test` · `test-time validation of remote unified-exec process behavior`

This file builds a focused mock of the `codex_exec_server::ExecProcess` trait to exercise the remote-process branch of `UnifiedExecProcess`. `MockExecProcess` stores a fixed `ProcessId`, a canned `WriteResponse`, a queue of `ReadResponse` values behind a `tokio::sync::Mutex<VecDeque<_>>`, an optional termination error string, and a `watch::Sender<u64>` used to implement the wake subscription expected by the remote output task. Its trait implementation returns empty event streams, boxed futures for read/write/signal/terminate, and either dequeued read responses or a default empty non-exited response.

The helper `remote_process` wraps this mock in `StartedExecProcess` and constructs a `UnifiedExecProcess` through `from_exec_server_started`, giving tests a realistic remote-process wrapper without a real exec server. The tests then verify several subtle state transitions: remote writes returning `UnknownProcess` or `StdinClosed` must surface `WriteToStdin` and mark the process exited; repeated `fail_and_terminate` calls must preserve the first failure message; `terminate_confirmed` must not mark the process exited if remote termination itself fails, but must do so on success; and `from_exec_server_started` must observe an early exit delivered through the output polling/wake mechanism within the grace period, including the correct exit code.

#### Function details

##### `MockExecProcess::process_id`  (lines 55–57)

```
fn process_id(&self) -> &ProcessId
```

**Purpose**: Returns the mock process ID required by the `ExecProcess` trait.

**Data flow**: Reads `self.process_id` by reference and returns `&ProcessId`.

**Call relations**: Used implicitly by any code interacting with the mock through the exec-server trait, though these tests focus more on read/write/terminate behavior.


##### `MockExecProcess::subscribe_wake`  (lines 59–61)

```
fn subscribe_wake(&self) -> watch::Receiver<u64>
```

**Purpose**: Creates a wake-channel receiver for the mock remote process.

**Data flow**: Reads `self.wake_tx`, calls `subscribe()`, and returns a `watch::Receiver<u64>`.

**Call relations**: Consumed by `UnifiedExecProcess::spawn_exec_server_output_task`, which waits on wake notifications between remote `read` polls.

*Call graph*: 1 external calls (subscribe).


##### `MockExecProcess::subscribe_events`  (lines 63–65)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Returns an empty exec-process event receiver because these tests do not use the event-stream API.

**Data flow**: Constructs and returns `ExecProcessEventReceiver::empty()`.

**Call relations**: Satisfies the `ExecProcess` trait for the mock; the tested code path does not depend on these events.

*Call graph*: calls 1 internal fn (empty).


##### `MockExecProcess::read`  (lines 67–74)

```
fn read(
        &self,
        _after_seq: Option<u64>,
        _max_bytes: Option<usize>,
        _wait_ms: Option<u64>,
    ) -> ExecProcessFuture<'_, ReadResponse>
```

**Purpose**: Implements the trait-level remote read call by delegating to the mock’s async read helper.

**Data flow**: Ignores the trait arguments, boxes the future returned by `MockExecProcess::read(self)`, and returns it as `ExecProcessFuture<'_, ReadResponse>`.

**Call relations**: Called by the remote output task inside `UnifiedExecProcess` when polling the mock process for output and exit state.

*Call graph*: 2 external calls (pin, new).


##### `MockExecProcess::write`  (lines 76–78)

```
fn write(&self, _chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse>
```

**Purpose**: Implements the trait-level remote write call by returning the mock’s preconfigured write response.

**Data flow**: Ignores the input chunk, clones `self.write_response`, wraps it in an async `Ok(...)`, boxes that future, and returns it.

**Call relations**: Exercised by tests that verify how `UnifiedExecProcess::write` reacts to different remote `WriteStatus` values.

*Call graph*: 2 external calls (pin, clone).


##### `MockExecProcess::signal`  (lines 80–82)

```
fn signal(&self, _signal: ProcessSignal) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Implements remote signaling as an unconditional success for test purposes.

**Data flow**: Ignores the requested `ProcessSignal`, returns a boxed async future resolving to `Ok(())`.

**Call relations**: Present to satisfy the trait; these tests do not directly assert signal behavior.

*Call graph*: 1 external calls (pin).


##### `MockExecProcess::terminate`  (lines 84–86)

```
fn terminate(&self) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Implements trait-level remote termination by delegating to the mock helper that may succeed or return a protocol error.

**Data flow**: Boxes the future from `MockExecProcess::terminate(self)` and returns it as `ExecProcessFuture<'_, ()>`.

**Call relations**: Used by `UnifiedExecProcess::terminate_confirmed` in tests that distinguish successful from failed remote termination.

*Call graph*: 2 external calls (pin, Protocol).


##### `remote_process`  (lines 89–109)

```
async fn remote_process(
    write_status: WriteStatus,
    terminate_error: Option<String>,
) -> UnifiedExecProcess
```

**Purpose**: Creates a `UnifiedExecProcess` backed by a mock exec-server process with configurable write status and termination behavior.

**Data flow**: Takes a `WriteStatus` and optional terminate-error string, creates a wake watch channel, constructs `StartedExecProcess` containing `Arc<MockExecProcess>` with empty queued reads, then awaits `UnifiedExecProcess::from_exec_server_started(..., SandboxType::None)` and returns the resulting process.

**Call relations**: Shared helper used by multiple tests to avoid repeating mock setup for common remote-process scenarios.

*Call graph*: calls 1 internal fn (from_exec_server_started); called by 4 (fail_and_terminate_preserves_failure_message, remote_terminate_confirmed_updates_state_on_success_only, remote_write_closed_stdin_marks_process_exited, remote_write_unknown_process_marks_process_exited); 4 external calls (new, new, new, channel).


##### `remote_write_unknown_process_marks_process_exited`  (lines 112–122)

```
async fn remote_write_unknown_process_marks_process_exited()
```

**Purpose**: Verifies that a remote write returning `UnknownProcess` becomes a stdin-write error and marks the process exited.

**Data flow**: Builds a mock remote process with `WriteStatus::UnknownProcess`, awaits `process.write(b"hello")`, expects an error, then asserts the error matches `UnifiedExecError::WriteToStdin` and `process.has_exited()` is true.

**Call relations**: Exercises the remote branch of `UnifiedExecProcess::write` for the case where the exec server no longer recognizes the process.

*Call graph*: calls 1 internal fn (remote_process); 1 external calls (assert!).


##### `remote_write_closed_stdin_marks_process_exited`  (lines 125–135)

```
async fn remote_write_closed_stdin_marks_process_exited()
```

**Purpose**: Verifies that a remote write returning `StdinClosed` becomes a stdin-write error and marks the process exited.

**Data flow**: Builds a mock remote process with `WriteStatus::StdinClosed`, awaits `process.write(b"hello")`, expects an error, then asserts `WriteToStdin` and exited state.

**Call relations**: Covers the sibling remote-write failure path where the process exists but stdin is no longer writable.

*Call graph*: calls 1 internal fn (remote_process); 1 external calls (assert!).


##### `fail_and_terminate_preserves_failure_message`  (lines 138–149)

```
async fn fail_and_terminate_preserves_failure_message()
```

**Purpose**: Checks that the first failure message recorded on a process is retained even if `fail_and_terminate` is called again with a different message.

**Data flow**: Creates a mock remote process, calls `fail_and_terminate("network denied")` and then `fail_and_terminate("second failure")`, then asserts the process has exited and `failure_message()` still returns the first string.

**Call relations**: Validates the one-time failure-message semantics implemented in `UnifiedExecProcess::fail_and_terminate`.

*Call graph*: calls 1 internal fn (remote_process); 2 external calls (assert!, assert_eq!).


##### `remote_terminate_confirmed_updates_state_on_success_only`  (lines 152–175)

```
async fn remote_terminate_confirmed_updates_state_on_success_only()
```

**Purpose**: Ensures `terminate_confirmed` leaves process state unchanged when remote termination fails, but marks the process exited when termination succeeds.

**Data flow**: First creates a mock process whose terminate call returns an error, awaits `terminate_confirmed()`, expects `UnifiedExecError::ProcessFailed`, and asserts `has_exited()` is false. Then creates a second mock process with successful termination, awaits `terminate_confirmed()`, and asserts `has_exited()` is true.

**Call relations**: Exercises the success/failure split in `UnifiedExecProcess::terminate_confirmed` for exec-server-backed processes.

*Call graph*: calls 1 internal fn (remote_process); 1 external calls (assert!).


##### `remote_process_waits_for_early_exit_event`  (lines 178–210)

```
async fn remote_process_waits_for_early_exit_event()
```

**Purpose**: Verifies that `from_exec_server_started` observes an early remote exit delivered through the read/wake loop before returning.

**Data flow**: Constructs a mock `StartedExecProcess` whose queued `ReadResponse` reports `exited: true`, `exit_code: Some(17)`, and `closed: true`; spawns a task that sends a wake notification after 10 ms; awaits `UnifiedExecProcess::from_exec_server_started`, then asserts the returned process has exited and reports exit code 17.

**Call relations**: Covers the constructor’s early-exit grace-period logic for remote processes, ensuring startup can synchronously surface short-lived failures.

*Call graph*: calls 1 internal fn (from_exec_server_started); 10 external calls (new, from_millis, new, new, from, assert!, assert_eq!, spawn, sleep, channel).


### `core/src/unified_exec/mod_tests.rs`

`test` · `test execution`

This file is the main behavioral test suite for unified exec. It starts with helper functions that build a session/turn pair, collect environment variables, construct `ExecRequest` values, open commands with or without TTY, and write to stdin through `UnifiedExecProcessManager`. The central helper, `exec_command_with_tty`, mirrors real startup flow: allocate a process id, build a bash command and request, open the process, optionally store a `ProcessEntry` if the process remains alive, collect output until a deadline, and return an `ExecCommandToolOutput` with wall time, raw output, exit code, token count, and optional persistent `process_id`.

The file also defines two test doubles. `TestSpawnLifecycle` exposes inherited file descriptors to validate remote exec-server rejection. `BlockingTerminateExecProcess` implements the `ExecProcess` trait with controllable termination via `watch` and `Notify`, allowing race-condition tests around process removal and in-flight stdin polling.

The tests themselves span several layers: `HeadTailBuffer` default-capacity behavior; persistence of interactive shells across requests; isolation between separate sessions; timeout and pause semantics for output collection; stale-process handling after exit; synchronization when terminating during the initial exec response or during a later stdin poll; preservation of exit codes for completed non-TTY commands; successful use of a configured remote exec server; and explicit rejection of inherited-FD launches in remote mode. Several tests are sandbox-skipped or ignored where environment sensitivity would make them flaky. Overall, this file documents the subsystem’s expected end-to-end behavior under both normal and adversarial timing conditions.

#### Function details

##### `test_session_and_turn`  (lines 37–40)

```
async fn test_session_and_turn() -> (Arc<Session>, Arc<TurnContext>)
```

**Purpose**: Creates a fresh session and turn context wrapped in `Arc`s for use across async unified-exec tests. It standardizes test setup.

**Data flow**: Awaits `make_session_and_context()`, receives owned `session` and `turn`, wraps each in `Arc`, and returns the pair.

**Call relations**: It is a shared helper invoked by many async tests before they open commands or manipulate process state. Those tests depend on it for isolated session fixtures.

*Call graph*: calls 1 internal fn (make_session_and_context); called by 9 (completed_commands_do_not_persist_sessions, multi_unified_exec_sessions, requests_with_large_timeout_are_capped, reusing_completed_process_returns_unknown_process, terminating_during_stdin_poll_returns_exited_response, terminating_initial_exec_command_rechecks_initial_response_state, unified_exec_pause_blocks_yield_timeout, unified_exec_persists_across_requests, unified_exec_timeouts); 1 external calls (new).


##### `exec_command`  (lines 42–58)

```
async fn exec_command(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    cmd: &str,
    yield_time_ms: u64,
    workdir: Option<PathBuf>,
) -> Result<ExecCommandToolOutput, UnifiedExecError
```

**Purpose**: Convenience wrapper that runs a command with TTY enabled using the common test helper path. It reduces duplication in tests that do not care about the TTY flag.

**Data flow**: Accepts session/turn references, command string, yield timeout, and optional working directory, forwards them to `exec_command_with_tty(..., true)`, and returns the resulting `Result<ExecCommandToolOutput, UnifiedExecError>`.

**Call relations**: Many integration tests call this helper instead of `exec_command_with_tty` directly. It delegates all real work to the lower-level helper.

*Call graph*: calls 1 internal fn (exec_command_with_tty); called by 7 (completed_commands_do_not_persist_sessions, multi_unified_exec_sessions, requests_with_large_timeout_are_capped, reusing_completed_process_returns_unknown_process, unified_exec_pause_blocks_yield_timeout, unified_exec_persists_across_requests, unified_exec_timeouts).


##### `shell_env`  (lines 60–62)

```
fn shell_env() -> HashMap<String, String>
```

**Purpose**: Captures the current process environment into a `HashMap` for constructing exec requests in tests. It ensures spawned commands inherit a realistic environment.

**Data flow**: Reads `std::env::vars()`, collects the iterator into `HashMap<String, String>`, and returns it.

**Call relations**: It is used by `test_exec_request` callers such as `exec_command_with_tty` and remote-exec tests. The helper isolates environment collection from request construction.

*Call graph*: called by 4 (completed_pipe_commands_preserve_exit_code, exec_command_with_tty, remote_exec_server_rejects_inherited_fd_launches, unified_exec_uses_remote_exec_server_when_configured); 1 external calls (vars).


##### `test_exec_request`  (lines 64–88)

```
fn test_exec_request(
    turn: &TurnContext,
    command: Vec<String>,
    cwd: AbsolutePathBuf,
    env: HashMap<String, String>,
) -> ExecRequest
```

**Purpose**: Builds a concrete `ExecRequest` suitable for unified-exec tests with sandboxing disabled and shell-tool capture policy. It fills in the turn-derived permission and workspace metadata expected by process startup.

**Data flow**: Takes a `TurnContext`, command vector, cwd, and environment map; derives `permission_profile` from `turn.permission_profile()`, sets fixed values like `SandboxType::None`, `ExecExpiration::DefaultTimeout`, `ExecCapturePolicy::ShellTool`, and `windows_sandbox_private_desktop = false`, then returns `ExecRequest::new(...)`.

**Call relations**: It is called by `exec_command_with_tty` and several direct process-opening tests. Those callers use it to avoid repeating the full `ExecRequest` parameter list.

*Call graph*: calls 2 internal fn (new, permission_profile); called by 4 (completed_pipe_commands_preserve_exit_code, exec_command_with_tty, remote_exec_server_rejects_inherited_fd_launches, unified_exec_uses_remote_exec_server_when_configured).


##### `exec_command_with_tty`  (lines 90–200)

```
async fn exec_command_with_tty(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    cmd: &str,
    yield_time_ms: u64,
    workdir: Option<PathBuf>,
    tty: bool,
) -> Result<ExecCommandTool
```

**Purpose**: Imitates the real unified-exec startup path inside tests, including process-id allocation, process opening, optional persistence, output collection, and response assembly. It is the core helper behind most end-to-end tests in this file.

**Data flow**: Accepts session/turn references, command text, yield timeout, optional workdir, and `tty`. It allocates a process id from the manager, resolves cwd relative to the turn, builds a bash command vector and `ExecRequest`, opens the process with `open_session_with_exec_env`, constructs `UnifiedExecContext`, records `started_at`, and if the process is still alive inserts a `ProcessEntry` into `process_store`. It then reads `OutputHandles`, computes a deadline, awaits `UnifiedExecProcessManager::collect_output_until_deadline`, derives wall time, text, exit state, and whether to return a persistent `process_id`, possibly releases the id if the process already exited, clears `initial_exec_command_active` when appropriate, and returns an `ExecCommandToolOutput` populated with chunk id, raw output, truncation policy, token count, hook command, and exit metadata.

**Call relations**: This helper is called by `exec_command` and underpins most integration tests. It exercises real manager and process code while manually performing some storage and response bookkeeping to keep tests explicit.

*Call graph*: calls 3 internal fn (new, shell_env, test_exec_request); called by 1 (exec_command); 11 external calls (clone, downgrade, new, new, from_millis, now, from_utf8_lossy, approx_token_count, collect_output_until_deadline, new (+1 more)).


##### `TestSpawnLifecycle::inherited_fds`  (lines 208–210)

```
fn inherited_fds(&self) -> Vec<i32>
```

**Purpose**: Returns the configured inherited file descriptors for the test spawn lifecycle. It lets tests simulate launches that request FD inheritance.

**Data flow**: Reads `self.inherited_fds`, clones the vector, and returns it.

**Call relations**: This trait method is consumed by process-opening code during remote exec-server tests. In this file it supports the case that verifies inherited FDs are rejected remotely.


##### `BlockingTerminateExecProcess::process_id`  (lines 246–248)

```
fn process_id(&self) -> &ProcessId
```

**Purpose**: Implements the `ExecProcess` trait accessor for the mock blocking process’s id. It exposes the stored `ProcessId` by reference.

**Data flow**: Returns `&self.process_id` without mutation.

**Call relations**: This trait method is used by `UnifiedExecProcess::from_exec_server_started` and any code interacting with the mock through the `ExecProcess` interface.


##### `BlockingTerminateExecProcess::subscribe_wake`  (lines 250–252)

```
fn subscribe_wake(&self) -> watch::Receiver<u64>
```

**Purpose**: Provides a watch receiver for wake notifications from the mock process. It satisfies the `ExecProcess` trait contract.

**Data flow**: Calls `self.wake_tx.subscribe()` and returns the new `watch::Receiver<u64>`.

**Call relations**: This method is invoked by code that wraps or polls the mock process through the exec-server abstraction. It supports the blocking-termination race tests.

*Call graph*: 1 external calls (subscribe).


##### `BlockingTerminateExecProcess::subscribe_events`  (lines 254–256)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Returns an empty event receiver for the mock process. The mock does not emit exec-server events beyond the explicit methods under test.

**Data flow**: Constructs and returns `ExecProcessEventReceiver::empty()`.

**Call relations**: It fulfills the `ExecProcess` trait for the mock used in termination tests. No other helper in this file depends on emitted events from this receiver.

*Call graph*: calls 1 internal fn (empty).


##### `BlockingTerminateExecProcess::read`  (lines 258–265)

```
fn read(
        &self,
        _after_seq: Option<u64>,
        _max_bytes: Option<usize>,
        _wait_ms: Option<u64>,
    ) -> ExecProcessFuture<'_, ReadResponse>
```

**Purpose**: Implements the trait-level async read entrypoint for the mock process by boxing the internal async `read` future. It always reports no output and no exit.

**Data flow**: Ignores the trait arguments `_after_seq`, `_max_bytes`, and `_wait_ms`, creates `Box::pin(BlockingTerminateExecProcess::read(self))`, and returns the boxed future.

**Call relations**: This trait adapter is used when the unified-exec wrapper interacts with the mock process through `ExecProcess`. It delegates to the inherent async `read` method defined earlier in the impl block.

*Call graph*: 2 external calls (pin, new).


##### `BlockingTerminateExecProcess::write`  (lines 267–269)

```
fn write(&self, _chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse>
```

**Purpose**: Implements the trait-level async write entrypoint for the mock process by boxing the internal async `write` future. The mock always accepts writes.

**Data flow**: Ignores the provided `_chunk`, returns `Box::pin(BlockingTerminateExecProcess::write(self))`, and ultimately yields a `WriteResponse { status: WriteStatus::Accepted }`.

**Call relations**: This adapter is part of the mock `ExecProcess` implementation used by termination-race tests. It delegates to the inherent async `write` helper.

*Call graph*: 1 external calls (pin).


##### `BlockingTerminateExecProcess::signal`  (lines 271–273)

```
fn signal(&self, _signal: ProcessSignal) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Implements process signaling for the mock by returning an immediately successful future. Signals are not modeled in these tests.

**Data flow**: Ignores `_signal`, returns a boxed async block that resolves to `Ok(())`.

**Call relations**: This trait method exists only to satisfy the `ExecProcess` interface for the mock process used in termination tests.

*Call graph*: 1 external calls (pin).


##### `BlockingTerminateExecProcess::terminate`  (lines 275–277)

```
fn terminate(&self) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Implements the trait-level terminate entrypoint by boxing the internal async termination routine. The routine blocks until the test explicitly allows termination to proceed.

**Data flow**: Returns `Box::pin(BlockingTerminateExecProcess::terminate(self))`; the underlying async method sends `true` on `terminate_started`, waits on `allow_terminate`, and then resolves successfully.

**Call relations**: This adapter is central to the race-condition tests that need termination to pause mid-flight. It delegates to the inherent async terminate method so tests can observe and control progress.

*Call graph*: 2 external calls (pin, send).


##### `blocking_terminate_unified_process`  (lines 280–300)

```
async fn blocking_terminate_unified_process(
    process_id: i32,
    terminate_started: watch::Sender<bool>,
    allow_terminate: Arc<Notify>,
) -> anyhow::Result<Arc<UnifiedExecProcess>>
```

**Purpose**: Builds a `UnifiedExecProcess` backed by the blocking mock exec-server process. It gives tests a controllable process whose termination can be delayed.

**Data flow**: Accepts a numeric `process_id`, a `watch::Sender<bool>` for termination-start notification, and an `Arc<Notify>` gate. It creates a wake watch channel, constructs `StartedExecProcess` containing an `Arc<BlockingTerminateExecProcess>` with those controls, awaits `UnifiedExecProcess::from_exec_server_started(..., SandboxType::None)`, wraps the result in `Arc`, and returns it inside `anyhow::Result`.

**Call relations**: It is called by the two termination-race tests to seed `process_store` with a controllable process. Those tests then interact with the resulting `UnifiedExecProcess` through normal manager/session APIs.

*Call graph*: calls 1 internal fn (from_exec_server_started); called by 2 (terminating_during_stdin_poll_returns_exited_response, terminating_initial_exec_command_rechecks_initial_response_state); 2 external calls (new, channel).


##### `write_stdin`  (lines 302–319)

```
async fn write_stdin(
    session: &Arc<Session>,
    process_id: i32,
    input: &str,
    yield_time_ms: u64,
) -> Result<ExecCommandToolOutput, UnifiedExecError>
```

**Purpose**: Convenience helper that sends input to an existing unified-exec process using a fixed token truncation policy. It mirrors the public write-stdin API used by production code.

**Data flow**: Accepts session reference, `process_id`, input string, and yield timeout; constructs `WriteStdinRequest { process_id, input, yield_time_ms, max_output_tokens: None, truncation_policy: TruncationPolicy::Tokens(10_000) }`; awaits `session.services.unified_exec_manager.write_stdin(...)`; and returns the resulting tool output or error.

**Call relations**: Many tests call this helper after opening a persistent shell. It delegates directly to the manager’s `write_stdin` implementation.

*Call graph*: called by 5 (multi_unified_exec_sessions, reusing_completed_process_returns_unknown_process, terminating_during_stdin_poll_returns_exited_response, unified_exec_persists_across_requests, unified_exec_timeouts); 1 external calls (Tokens).


##### `push_chunk_preserves_prefix_and_suffix`  (lines 322–341)

```
fn push_chunk_preserves_prefix_and_suffix()
```

**Purpose**: Checks that the default-capacity head/tail buffer retains the earliest bytes and newest appended chunks when overfilled. It validates chunk-level snapshot ordering under the production byte cap.

**Data flow**: Creates `HeadTailBuffer::default()`, pushes a full-capacity chunk of `b'a'`, then single-byte `b'b'` and `b'c'`, asserts retained bytes equal `UNIFIED_EXEC_OUTPUT_MAX_BYTES`, snapshots chunks, and checks the first retained byte is `a`, some chunk equals `b`, and the last chunk equals `c`.

**Call relations**: This unit test is run by the harness and complements the dedicated head-tail buffer test file by exercising the default-capacity constructor used in production.

*Call graph*: calls 1 internal fn (default); 3 external calls (assert!, assert_eq!, vec!).


##### `head_tail_buffer_default_preserves_prefix_and_suffix`  (lines 344–352)

```
fn head_tail_buffer_default_preserves_prefix_and_suffix()
```

**Purpose**: Verifies the rendered output of the default-capacity buffer after overflow, ensuring the first byte of the original prefix and the latest suffix bytes are both retained. It is a simpler flattened-output counterpart to the snapshot test.

**Data flow**: Creates `HeadTailBuffer::default()`, pushes a full-capacity `a` chunk and then `"bc"`, calls `to_bytes()`, and asserts the first byte is `a` and the output ends with `"bc"`.

**Call relations**: This harness-driven test documents the default retention policy in terms of flattened bytes rather than chunk boundaries.

*Call graph*: calls 1 internal fn (default); 3 external calls (assert!, assert_eq!, vec!).


##### `unified_exec_persists_across_requests`  (lines 355–404)

```
async fn unified_exec_persists_across_requests() -> anyhow::Result<()>
```

**Purpose**: Tests that an interactive shell remains alive across multiple requests, preserves environment state, appears in background-terminal listings, and can be terminated exactly once. It is the core persistence scenario for unified exec.

**Data flow**: Skips under sandbox, creates a session/turn, opens `bash -i` via `exec_command`, extracts the returned `process_id`, asserts `session.list_background_terminals()` contains one matching `BackgroundTerminalInfo`, writes an export command with `write_stdin`, writes an echo command and asserts the resulting truncated output contains `codex`, then calls `terminate_background_terminal` twice and checks the first returns true, the second false, and the terminal list becomes empty.

**Call relations**: This integration test uses `test_session_and_turn`, `exec_command`, and `write_stdin` to exercise the full manager/session path for persistent interactive processes.

*Call graph*: calls 3 internal fn (exec_command, test_session_and_turn, write_stdin); 3 external calls (assert!, assert_eq!, skip_if_sandbox!).


##### `multi_unified_exec_sessions`  (lines 407–461)

```
async fn multi_unified_exec_sessions() -> anyhow::Result<()>
```

**Purpose**: Verifies that a persistent interactive shell keeps its own state while a separate one-shot command runs in a fresh shell without inheriting that state. It checks isolation between sessions and persistence within a session.

**Data flow**: Skips under sandbox, creates a session/turn, opens `bash -i`, stores its `process_id`, exports an environment variable into that shell, runs a separate `exec_command("echo $CODEX_INTERACTIVE_SHELL_VAR")`, sleeps two seconds, asserts the short command returned no `process_id` and its output does not contain `codex`, then writes an echo command back to the original shell and asserts that output does contain `codex`.

**Call relations**: This test builds on the same helpers as the persistence test but contrasts persistent-shell state with fresh-command isolation. It exercises both startup and stdin-write paths.

*Call graph*: calls 3 internal fn (exec_command, test_session_and_turn, write_stdin); 4 external calls (from_secs, assert!, skip_if_sandbox!, sleep).


##### `unified_exec_timeouts`  (lines 464–511)

```
async fn unified_exec_timeouts() -> anyhow::Result<()>
```

**Purpose**: Checks that short yield timeouts can return incomplete output from a long-running command and that a later poll retrieves the delayed output. It validates incremental polling semantics for persistent shells.

**Data flow**: Skips under sandbox, creates a session/turn, opens `bash -i`, exports a known variable, writes `sleep 5 && echo ...` with a 10ms yield timeout and asserts the immediate output does not contain the variable value, sleeps seven seconds, then polls the shell with an empty `write_stdin` and asserts the later output now contains the value.

**Call relations**: This integration test uses `exec_command` and `write_stdin` to exercise timeout behavior in the manager’s output collection logic for persistent processes.

*Call graph*: calls 3 internal fn (exec_command, test_session_and_turn, write_stdin); 5 external calls (from_secs, assert!, format!, skip_if_sandbox!, sleep).


##### `unified_exec_pause_blocks_yield_timeout`  (lines 514–552)

```
async fn unified_exec_pause_blocks_yield_timeout() -> anyhow::Result<()>
```

**Purpose**: Verifies that the out-of-band elicitation pause state suspends the yield-time countdown, causing exec collection to wait until the pause is lifted before timing out. It ensures pauses do not silently consume the caller’s output window.

**Data flow**: Skips under sandbox, creates a session/turn, sets the session pause state to true, spawns a task that sleeps two seconds and clears the pause, records `started = Instant::now()`, runs `exec_command("sleep 1 && echo unified-exec-done", 250ms)`, then asserts elapsed time is at least two seconds, output contains `unified-exec-done`, and no persistent `process_id` is returned.

**Call relations**: This test drives the pause-aware output collection path indirectly through `exec_command`. It relies on session pause state and a spawned unpause task to create the timing condition.

*Call graph*: calls 2 internal fn (exec_command, test_session_and_turn); 7 external calls (clone, from_secs, assert!, skip_if_sandbox!, spawn, now, sleep).


##### `requests_with_large_timeout_are_capped`  (lines 556–576)

```
async fn requests_with_large_timeout_are_capped() -> anyhow::Result<()>
```

**Purpose**: Intended to verify that excessively large requested yield timeouts are capped by subsystem policy. The test is currently ignored pending a better validation strategy.

**Data flow**: Creates a session/turn, runs `exec_command("echo codex", 120_000ms)`, and asserts a process id is present and output contains `codex`.

**Call relations**: Although ignored, this test targets the timeout normalization behavior used by exec startup. It uses the standard helper path rather than calling `clamp_yield_time` directly.

*Call graph*: calls 2 internal fn (exec_command, test_session_and_turn); 1 external calls (assert!).


##### `completed_commands_do_not_persist_sessions`  (lines 580–613)

```
async fn completed_commands_do_not_persist_sessions() -> anyhow::Result<()>
```

**Purpose**: Intended to assert that commands which finish promptly do not remain stored as background sessions. It is currently ignored.

**Data flow**: Creates a session/turn, runs `exec_command("echo codex", 2_500ms)`, asserts a process id is present and output contains `codex`, then inspects `process_store` and asserts `processes` is empty.

**Call relations**: This ignored test probes the cleanup behavior after command completion. It uses the same helper path as active integration tests but checks manager internals afterward.

*Call graph*: calls 2 internal fn (exec_command, test_session_and_turn); 1 external calls (assert!).


##### `reusing_completed_process_returns_unknown_process`  (lines 616–654)

```
async fn reusing_completed_process_returns_unknown_process() -> anyhow::Result<()>
```

**Purpose**: Ensures that once a persistent shell exits and is cleaned up, later stdin writes against its old process id fail with `UnknownProcessId`. It also checks that the reported id matches the requested one.

**Data flow**: Skips under sandbox, creates a session/turn, opens `bash -i`, captures `process_id`, writes `exit\n`, sleeps 200ms, then calls `write_stdin` with empty input and expects an error. It pattern-matches the error as `UnifiedExecError::UnknownProcessId { process_id: err_id }`, asserts `err_id == process_id`, and finally asserts the manager’s `process_store.processes` map is empty.

**Call relations**: This integration test uses `exec_command` and `write_stdin` to exercise process cleanup and stale-id error propagation after shell exit.

*Call graph*: calls 3 internal fn (exec_command, test_session_and_turn, write_stdin); 6 external calls (from_millis, assert!, assert_eq!, panic!, skip_if_sandbox!, sleep).


##### `terminating_initial_exec_command_rechecks_initial_response_state`  (lines 657–726)

```
async fn terminating_initial_exec_command_rechecks_initial_response_state() -> anyhow::Result<()>
```

**Purpose**: Tests a race where termination begins while the initial exec response is still considered active, and verifies that once that flag is cleared the process can be removed cleanly. It guards synchronization between termination and initial-response bookkeeping.

**Data flow**: Creates a session/turn and manager, allocates a process id, builds a blocking mock process with watch/notify controls, inserts a `ProcessEntry` with `initial_exec_command_active = true` into `process_store`, spawns `session.terminate_background_terminal(process_id)`, waits until termination has started, then manually flips `initial_exec_command_active` to false inside the store, notifies the terminate gate, awaits the terminate task, asserts it returned true, and confirms the process entry is gone.

**Call relations**: This test uses `blocking_terminate_unified_process` plus direct `process_store` manipulation to simulate a precise race that ordinary command helpers cannot create. It exercises session termination logic against manager state transitions.

*Call graph*: calls 2 internal fn (blocking_terminate_unified_process, test_session_and_turn); 11 external calls (clone, downgrade, new, from_secs, now, new, assert!, new, spawn, timeout (+1 more)).


##### `terminating_during_stdin_poll_returns_exited_response`  (lines 729–796)

```
async fn terminating_during_stdin_poll_returns_exited_response() -> anyhow::Result<()>
```

**Purpose**: Verifies that if a process is terminated while a long stdin poll is in progress, the poll completes with a non-persistent exited response rather than hanging or returning a stale process id. It checks coordination between polling and process release.

**Data flow**: Creates a session/turn and manager, allocates a process id, builds a blocking mock process, inserts a `ProcessEntry` with `initial_exec_command_active = false` and an old `last_used`, spawns a long-timeout empty `write_stdin`, waits until `last_used` changes to confirm polling has started, releases the process id, notifies termination, awaits `process.terminate_confirmed()`, then awaits the poll task and asserts `output.process_id == None` and the store is empty.

**Call relations**: This race-condition test combines `blocking_terminate_unified_process` with the `write_stdin` helper to exercise manager behavior when termination overlaps an in-flight poll.

*Call graph*: calls 3 internal fn (blocking_terminate_unified_process, test_session_and_turn, write_stdin); 14 external calls (clone, downgrade, new, from_millis, from_secs, now, new, assert!, assert_eq!, new (+4 more)).


##### `completed_pipe_commands_preserve_exit_code`  (lines 799–834)

```
async fn completed_pipe_commands_preserve_exit_code() -> anyhow::Result<()>
```

**Purpose**: Checks that a non-interactive command run without TTY preserves its actual exit code after completion. It validates exit-code propagation through the unified-exec process wrapper.

**Data flow**: Creates a turn via `make_session_and_context`, builds an `ExecRequest` for `bash -lc 'exit 17'`, opens it with `UnifiedExecProcessManager::default().open_session_with_exec_env(..., tty = false, ...)`, waits for cancellation if the process has not yet exited, then asserts `process.has_exited()` and `process.exit_code() == Some(17)`.

**Call relations**: This integration test bypasses the higher-level command helper and talks directly to process startup to focus on exit-code behavior for completed pipe commands.

*Call graph*: calls 5 internal fn (make_session_and_context, default, shell_env, test_exec_request, default_for_tests); 4 external calls (new, assert!, assert_eq!, vec!).


##### `unified_exec_uses_remote_exec_server_when_configured`  (lines 837–886)

```
async fn unified_exec_uses_remote_exec_server_when_configured() -> anyhow::Result<()>
```

**Purpose**: Verifies that unified exec can launch and interact with a remote exec server when the test environment provides one. It confirms output can be written and collected through the remote-backed process.

**Data flow**: Skips under sandbox and returns early if no remote env is configured, obtains the remote test environment, builds a turn and `ExecRequest` for interactive bash in the remote cwd, opens the process with `UnifiedExecProcessManager::default().open_session_with_exec_env(..., tty = true, remote environment)`, writes `printf 'remote-unified-exec\n'` to the process, sleeps briefly, collects output via `collect_output_until_deadline` using the process’s `OutputHandles`, and asserts the collected bytes contain `remote-unified-exec`.

**Call relations**: This test directly exercises remote-process startup and output collection rather than the higher-level helper path. It validates integration between unified exec and the remote exec-server backend.

*Call graph*: calls 5 internal fn (make_session_and_context, default, shell_env, test_exec_request, test_env); 9 external calls (new, from_millis, now, assert!, collect_output_until_deadline, get_remote_test_env, skip_if_sandbox!, sleep, vec!).


##### `remote_exec_server_rejects_inherited_fd_launches`  (lines 889–932)

```
async fn remote_exec_server_rejects_inherited_fd_launches() -> anyhow::Result<()>
```

**Purpose**: Ensures that remote exec-server launches fail when the spawn lifecycle requests inherited file descriptors, which the remote backend does not support. It checks the exact surfaced error message.

**Data flow**: Skips under sandbox and returns early if no remote env is configured, obtains the remote environment, mutates the turn’s primary environment to use it, builds a local cwd `ExecRequest`, creates a default manager, calls `open_session_with_exec_env` with `TestSpawnLifecycle { inherited_fds: vec![42] }`, expects an error, and asserts `err.to_string()` equals the specific create-process failure message about unsupported inherited file descriptors.

**Call relations**: This test uses `TestSpawnLifecycle::inherited_fds` to force the unsupported condition and then exercises direct process opening. It validates startup-time rejection and error wrapping for remote mode.

*Call graph*: calls 5 internal fn (make_session_and_context, default, shell_env, test_exec_request, test_env); 6 external calls (new, new, assert_eq!, get_remote_test_env, skip_if_sandbox!, vec!).
