# Core src tools and unified-exec tests  `stage-23.2.2`

This stage is a broad safety check for Codex’s tool system, the behind-the-scenes machinery that lets the model edit files, run commands, ask the user, call external MCP tools, manage sub-agents, and use hosted features like web search or image generation. Most files here are tests that protect the public “tool contract”: the exact names, descriptions, inputs, and outputs the model or outside clients depend on. That includes specs for shell, patching, MCP resources, multi-agent tools, user input, plugin installs, hosted tools, and agent jobs.

Other tests check the moving parts that execute those tools. The registry finds and runs tools. The router sends each requested call to the right local, MCP, dynamic, or extension handler. Context and trace tests make sure results and history are recorded clearly. Approval, sandboxing, network, command-canonicalization, and runtime tests guard the rules for when commands or file edits are allowed. The test synchronization tool helps timing-sensitive tests coordinate reliably. Finally, the unified-exec tests cover the newer command runner: streaming output, long-running processes, remote exec servers, timeouts, cleanup, and safe shutdown.

## Files in this stage

### Tool specs and handler contracts
These tests lock down the published tool schemas and the focused handler behaviors that define the core tool surface.

### `core/src/tools/handlers/test_sync_spec.rs`

`config` · `test tool registration`

This file is like the label and instruction card for a testing tool, not the tool’s working engine. The tool exists so Codex integration tests can coordinate several tool calls at once. For example, a test may need two concurrent calls to reach the same point before either one continues. That is what a “barrier” does: it is like a meeting point where everyone waits until the expected number of people arrive.

The file builds a schema, meaning a machine-readable description of allowed input. The tool can accept an optional delay before doing anything, an optional delay after finishing, and an optional barrier object. The barrier has an `id`, so different groups of calls do not get mixed together, a `participants` count, which says how many calls must arrive, and a `timeout_ms`, which prevents a test from waiting forever if something goes wrong.

The result is wrapped as a `ToolSpec`, which is the project’s standard way to describe a callable tool. Without this file, tests could still have synchronization logic somewhere else, but the tool would not be advertised with clear parameters for the system to call correctly.

#### Function details

##### `create_test_sync_tool`  (lines 6–59)

```
fn create_test_sync_tool() -> ToolSpec
```

**Purpose**: Creates the formal specification for the internal `test_sync_tool`. Someone uses it when registering available tools for tests, so the system knows the tool’s name, description, and accepted input fields.

**Data flow**: It starts with no caller-provided input. It builds small schema pieces for each accepted field, groups the barrier fields into a nested object, then groups all top-level fields into the final parameter schema. It returns a `ToolSpec` describing a function-style tool named `test_sync_tool`; it does not run the tool or wait on any barrier itself.

**Call relations**: When the broader tool specification setup asks for this test synchronization tool, it calls `create_test_sync_tool`. This function hands back the completed tool description, using schema-building helpers for strings, numbers, and objects so the rest of the system can validate or present the tool consistently.

*Call graph*: calls 3 internal fn (number, object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


### `core/src/tools/handlers/test_sync.rs`

`test` · `request handling during test runs`

This file is a small coordination aid for tests. Imagine several runners reaching a meeting point before anyone is allowed to continue; that meeting point is called a barrier. The `test_sync_tool` lets a test ask a tool call to sleep before it starts, wait at a named barrier until enough other calls arrive, sleep again afterward, and then return `ok`.

The file registers `TestSyncHandler` as a tool executor. It gives the tool its name and specification, says it is safe to run in parallel, and turns each incoming tool request into an asynchronous operation. The request must be a function-style payload with JSON arguments. Those arguments can include optional delays and an optional barrier with an ID, a participant count, and a timeout.

The barrier state is kept in one shared global map protected by an asynchronous mutex, which is a lock that prevents two tasks from editing the map at the same time. If two calls use the same barrier ID, they must agree on the same participant count. Once all participants arrive, they are released. One released call cleans the barrier out of the map so later tests do not reuse stale state. If the barrier is misconfigured or not enough calls arrive before the timeout, the tool returns an error message instead of hanging forever.

#### Function details

##### `default_timeout_ms`  (lines 52–54)

```
fn default_timeout_ms() -> u64
```

**Purpose**: Provides the fallback barrier timeout when the caller does not specify one. This keeps a test from waiting forever by default.

**Data flow**: It takes no input. It reads the file’s default timeout constant and returns that number of milliseconds.

**Call relations**: This is used by the argument deserializer for `BarrierArgs` when incoming JSON leaves out `timeout_ms`. It quietly supplies the safety limit before `handle_call` later sends the parsed arguments to `wait_on_barrier`.


##### `barrier_map`  (lines 56–58)

```
fn barrier_map() -> &'static tokio::sync::Mutex<HashMap<String, BarrierState>>
```

**Purpose**: Gives access to the shared table of named barriers. The table lets separate tool calls find the same meeting point by ID.

**Data flow**: It takes no input. It checks whether the global barrier table already exists; if not, it creates an empty hash map wrapped in an asynchronous mutex. It returns a reference to that shared locked map.

**Call relations**: `wait_on_barrier` calls this whenever it needs to look up, create, or remove a barrier. This keeps all barrier storage in one place instead of passing it through every tool call.

*Call graph*: called by 1 (wait_on_barrier).


##### `TestSyncHandler::tool_name`  (lines 61–63)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the public name of this tool: `test_sync_tool`. The registry uses this name so callers can request the right handler.

**Data flow**: It takes the handler as input and constructs a plain tool name from the fixed string `test_sync_tool`. It returns that tool name.

**Call relations**: The tool registry calls this when identifying available tools. It delegates the actual name construction to `ToolName::plain`.

*Call graph*: calls 1 internal fn (plain).


##### `TestSyncHandler::spec`  (lines 65–67)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the formal description of the tool’s inputs and behavior. This tells the rest of the system how the tool may be called.

**Data flow**: It takes the handler as input and calls `create_test_sync_tool`, which builds the tool specification. It returns that specification.

**Call relations**: The registry or model-facing tool setup calls this when advertising the tool. The details are supplied by `create_test_sync_tool`, keeping the handler focused on execution.

*Call graph*: calls 1 internal fn (create_test_sync_tool).


##### `TestSyncHandler::supports_parallel_tool_calls`  (lines 69–71)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that this tool is allowed to run at the same time as other tool calls. That is essential because its barrier feature only works when multiple calls can wait together.

**Data flow**: It takes the handler as input and returns `true`. It does not read or change any state.

**Call relations**: The tool runtime checks this capability before scheduling calls in parallel. For this specific tool, parallel execution is not just safe; it is the main reason the tool exists.


##### `TestSyncHandler::handle`  (lines 73–75)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts processing one invocation of the tool and returns it as an asynchronous task. This is the adapter between the generic tool runtime and this handler’s real work.

**Data flow**: It receives a `ToolInvocation`, wraps a call to `handle_call` in a pinned future, and returns that future to the runtime. The actual result will be produced later when the future runs.

**Call relations**: The tool runtime calls `handle` when `test_sync_tool` is invoked. `handle` immediately hands the invocation to `handle_call`, which performs the sleeps, barrier wait, and final response.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `TestSyncHandler::handle_call`  (lines 79–116)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Carries out one `test_sync_tool` request. It reads the caller’s requested delays and optional barrier, waits as instructed, and returns a simple successful output.

**Data flow**: It receives a tool invocation and first checks that the payload is a function call with arguments. It parses those arguments into `TestSyncArgs`. If `sleep_before_ms` is present and greater than zero, it pauses for that long. If a barrier is present, it calls `wait_on_barrier` and waits until enough matching calls arrive or an error occurs. If `sleep_after_ms` is present and greater than zero, it pauses again. On success it returns a boxed tool output containing the text `ok`; on unsupported payloads, bad arguments, or barrier failure, it returns an error for the model.

**Call relations**: `handle` calls this for each tool invocation. This function is the main execution path: it uses `parse_arguments` to understand input, uses async sleep for timing, calls `wait_on_barrier` for synchronization, and uses `FunctionToolOutput::from_text` plus `boxed_tool_output` to send the final response back through the tool system.

*Call graph*: calls 4 internal fn (from_text, boxed_tool_output, parse_arguments, wait_on_barrier); called by 1 (handle); 3 external calls (from_millis, sleep, RespondToModel).


##### `wait_on_barrier`  (lines 121–176)

```
async fn wait_on_barrier(args: BarrierArgs) -> Result<(), FunctionCallError>
```

**Purpose**: Makes one tool call wait at a named barrier until the required number of participants have arrived. It protects tests from deadlock by rejecting invalid settings and timing out if the group never completes.

**Data flow**: It receives barrier arguments: an ID, participant count, and timeout. It rejects a participant count of zero and a timeout of zero. It locks the shared barrier map, then either finds the existing barrier for that ID or creates a new one. If the same ID is already registered with a different participant count, it returns an error. Then it waits on the barrier, but only up to the requested timeout. When all participants arrive, they are released. The leader among the released waiters locks the map again and removes the barrier if it is still the same one. On success it returns nothing; on invalid input or timeout it returns an error message.

**Call relations**: `handle_call` calls this when the request includes a barrier. It uses `barrier_map` to share named barriers across concurrent calls, `tokio::time::timeout` to avoid waiting forever, and Tokio’s `Barrier` to release all participants together once the expected group has arrived.

*Call graph*: calls 1 internal fn (barrier_map); called by 1 (handle_call); 7 external calls (new, ptr_eq, new, from_millis, format!, timeout, RespondToModel).


### `core/src/tools/handlers/test_sync_spec_tests.rs`

`test` · `test suite`

This is a small test file, but it guards an important contract. The project has a special tool used only by Codex integration tests to coordinate multiple tool calls, a bit like asking several runners to meet at the same starting line before anyone continues. That tool is described by a formal specification: its name, its human-readable description, and the JSON-shaped inputs it accepts.

The test builds the real tool specification with `create_test_sync_tool()` and compares it to the expected specification written out in the test. The expected input shape includes a `barrier` object, which names a rendezvous point, says how many participants must arrive, and optionally sets a timeout. It also includes optional delays before and after the barrier.

The value of this file is not in running the synchronization itself. Its job is to catch drift. If someone changes the tool schema, removes a required field, renames an input, or changes whether extra fields are allowed, this test fails. That failure tells maintainers that either the change was accidental, or the documented expectation must be updated deliberately.

#### Function details

##### `test_sync_tool_matches_expected_spec`  (lines 7–64)

```
fn test_sync_tool_matches_expected_spec()
```

**Purpose**: This test verifies that `create_test_sync_tool()` returns the exact tool specification expected by the integration-test infrastructure. It is used to catch accidental changes to the tool’s public shape before they affect tests that rely on it.

**Data flow**: The test starts with no external input. It asks the code under test to create the synchronization tool specification, then builds the expected specification inline, including the tool name, description, accepted input fields, required fields, and whether extra fields are allowed. It compares the two values; if they match, the test passes, and if anything differs, the test fails with a readable comparison.

**Call relations**: During the automated test run, the Rust test runner calls this function. Inside it, the comparison is handed to `assert_eq!`, which checks the generated tool specification against the expected one and reports any mismatch.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/agent_jobs_spec_tests.rs`

`test` · `test run`

This is a test file for the tool definitions related to agent jobs. In plain terms, these tools let a main agent start many worker agents from rows in a CSV file, and let each worker report back its result. The file does not run jobs itself. Instead, it verifies the “menu card” for each tool: what the tool is called, what it says it does, which inputs are allowed, and which inputs are required.

That matters because these tool descriptions are part of the interface seen by agents or API clients. If a required field such as the CSV path or result payload were accidentally removed, a caller might send incomplete requests and fail later in a confusing way. These tests catch that kind of breakage early.

The helper `described_object` builds a small JSON Schema object with a description. A JSON Schema is a machine-readable description of what shape some JSON data should have. The two tests then compare the actual tool specifications produced by the code against the exact expected specifications. They use a strict equality check, so even wording, required fields, and whether extra fields are allowed are guarded.

#### Function details

##### `described_object`  (lines 6–14)

```
fn described_object(description: &str) -> JsonSchema
```

**Purpose**: This helper creates a simple JSON object schema with a human-readable description attached. The tests use it to avoid repeating the same setup for fields that accept an object, such as a worker result or an output schema.

**Data flow**: It receives a description string. It starts with an empty object-shaped JSON Schema, adds the description text to it, and returns the finished schema. Nothing outside the returned value is changed.

**Call relations**: The test code uses this as a small building block while writing the expected tool specifications. Inside, it asks the JSON Schema object builder to make the empty object shape, using an empty map for its properties, then fills in the description before handing it back to the test.

*Call graph*: calls 1 internal fn (object); 1 external calls (new).


##### `spawn_agents_on_csv_tool_requires_csv_and_instruction`  (lines 17–85)

```
fn spawn_agents_on_csv_tool_requires_csv_and_instruction()
```

**Purpose**: This test proves that the `spawn_agents_on_csv` tool requires the two essential inputs: the CSV file path and the instruction template. It also checks the rest of the advertised fields, such as optional output path, concurrency limits, timeout, and result schema.

**Data flow**: When the test runs, it builds the real tool specification and separately writes out the exact specification it expects. It then compares the two. If the name, description, allowed parameters, required parameters, or schema details differ, the test fails.

**Call relations**: The Rust test runner calls this during the test suite. The function relies on the equality assertion macro to compare the actual tool definition with the expected one, so this test acts like a guardrail around the public shape of the CSV agent-spawning tool.

*Call graph*: 1 external calls (assert_eq!).


##### `report_agent_job_result_tool_requires_result_payload`  (lines 88–126)

```
fn report_agent_job_result_tool_requires_result_payload()
```

**Purpose**: This test proves that the `report_agent_job_result` tool requires a worker to send a job id, an item id, and a result object. It also checks the optional stop flag, which lets a worker cancel remaining work after reporting.

**Data flow**: When the test runs, it creates the real reporting-tool specification and an expected specification written directly in the test. It compares them exactly. If the required result payload or any other part of the schema changes unexpectedly, the test fails.

**Call relations**: The Rust test runner calls this as part of the automated tests. Like the CSV-spawning test, it uses the equality assertion macro as the final judge, making sure the worker-only reporting tool keeps the contract that job workers depend on.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/agent_jobs_tests.rs`

`test` · `test run`

Agent jobs appear to use CSV rows as input and turn those rows into instructions for an agent. That means small text rules matter a lot: a comma inside a quoted CSV field should not split the field, duplicate column names should be rejected, and template placeholders should be replaced without accidentally changing literal braces. This file is a set of focused tests for those rules.

Each test gives the helper code a small example and checks the exact result. One test proves the CSV reader understands normal CSV quoting, like `"alpha, beta"` being one value rather than two. Another checks that writing CSV values adds quotes only when needed, and doubles quote marks inside a value, which is the standard CSV way to keep quotes safe. Two tests cover instruction templates: known placeholders are filled from a JSON row, doubled braces become literal braces, and unknown placeholders are left alone instead of being erased. The last test checks that repeated CSV headers are reported as a clear error.

Without these tests, a future change could quietly break job creation: rows might be misread, generated CSV could become invalid, or agent instructions could lose important file paths.

#### Function details

##### `parse_csv_supports_quotes_and_commas`  (lines 6–17)

```
fn parse_csv_supports_quotes_and_commas()
```

**Purpose**: This test proves that the CSV parser understands quoted fields that contain commas. Someone would rely on this behavior when a CSV cell contains natural text, such as a name or description, that includes punctuation.

**Data flow**: It starts with a short CSV string containing two headers and two rows. One row has a quoted value with a comma inside it. The test sends that text into the CSV parser, then compares the returned headers and rows with the expected clean values.

**Call relations**: During the test run, this function exercises the CSV parsing path and uses an equality check to confirm the parsed result is exactly right. If the parser split `alpha, beta` into two cells, this test would fail immediately.

*Call graph*: 1 external calls (assert_eq!).


##### `csv_escape_quotes_when_needed`  (lines 20–24)

```
fn csv_escape_quotes_when_needed()
```

**Purpose**: This test checks the rules for turning a single value into safe CSV text. It makes sure plain values stay plain, values with commas get wrapped in quotes, and quotes inside values are escaped correctly.

**Data flow**: It gives the CSV escaping helper three small strings: a simple word, a string with a comma, and a string containing a quote mark. Each input is transformed into CSV-safe text, and the test compares that output with the expected spelling.

**Call relations**: This test runs as a guard around the CSV-writing helper. Its equality checks catch changes that would produce CSV text other tools could misread.

*Call graph*: 1 external calls (assert_eq!).


##### `render_instruction_template_expands_placeholders_and_escapes_braces`  (lines 27–41)

```
fn render_instruction_template_expands_placeholders_and_escapes_braces()
```

**Purpose**: This test proves that an instruction template can be filled from row data, including column names with spaces, while still allowing literal braces in the final instruction. This matters because agent jobs often need to turn table rows into readable task prompts.

**Data flow**: It builds a small JSON object with values such as a file path and an area name. It then gives that object and a template string to the renderer. The renderer replaces known placeholders like `{path}` and `{file path}`, turns `{{literal}}` into `{literal}`, and returns the finished sentence, which the test checks exactly.

**Call relations**: This test uses a JSON-building helper to create row-like input, then checks the rendered instruction with an equality assertion. It protects the path from raw row data to final agent-facing text.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `render_instruction_template_leaves_unknown_placeholders`  (lines 44–50)

```
fn render_instruction_template_leaves_unknown_placeholders()
```

**Purpose**: This test checks that missing template values are not silently removed. Leaving an unknown placeholder visible is safer because it shows the user what could not be filled.

**Data flow**: It creates row data that contains only `path`, then renders a template containing both `{path}` and `{missing}`. The known placeholder is replaced, while the unknown one remains as `{missing}` in the final string.

**Call relations**: In the test suite, this function covers the renderer’s fallback behavior. Its equality check confirms the renderer does not guess, blank out, or error on an unknown placeholder in this case.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `ensure_unique_headers_rejects_duplicates`  (lines 53–62)

```
fn ensure_unique_headers_rejects_duplicates()
```

**Purpose**: This test verifies that CSV headers must be unique. Duplicate column names would make row data ambiguous, because `{path}` could refer to more than one column.

**Data flow**: It starts with a header list containing `path` twice. It passes that list to the header-checking helper and expects an error. The test then compares the error message with the exact user-facing message that should be returned; if no error appears, the test deliberately fails.

**Call relations**: This test covers the validation step before CSV data is used for jobs. It uses a failure check to ensure duplicates are rejected, then an equality assertion to ensure the reported problem is clear and stable.

*Call graph*: 3 external calls (assert_eq!, panic!, vec!).


### `core/src/tools/handlers/apply_patch_spec_tests.rs`

`test` · `test run`

The `apply_patch` tool is the way an agent asks the system to change files. This test file makes sure the tool’s public description stays stable and understandable to the agent using it. Think of it like checking the printed instructions on a form: if the wording or required layout changes by accident, people may fill it out wrong.

There are two checks here. The first confirms that the normal tool specification is exactly what the code promises: a freeform tool named `apply_patch`, with a description telling the agent not to wrap the patch in JSON, and a grammar definition written in Lark, which is a formal way to describe accepted text shapes. The second confirms an optional variant: when the caller asks for an environment ID, the patch grammar must include a place for that ID and the exact header text that introduces it.

Without these tests, a small change to the tool spec could quietly break communication between the agent and the patch parser. These tests run during the automated test phase, not during normal product use.

#### Function details

##### `create_apply_patch_freeform_tool_matches_expected_spec`  (lines 5–20)

```
fn create_apply_patch_freeform_tool_matches_expected_spec()
```

**Purpose**: This test verifies the standard `apply_patch` tool description when no environment ID is requested. It makes sure the tool name, user-facing instructions, format type, grammar syntax, and grammar text all match the expected specification.

**Data flow**: It starts by asking `create_apply_patch_freeform_tool` for the tool spec with environment IDs turned off. It then compares the returned value with a fully written-out expected value. If anything differs, the assertion reports the mismatch and the test fails.

**Call relations**: During the test suite, the Rust test runner calls this function. Inside the test, it uses `assert_eq!` to compare the generated tool spec against the expected one, so accidental changes to the public contract are caught immediately.

*Call graph*: 1 external calls (assert_eq!).


##### `create_apply_patch_freeform_tool_includes_environment_id_when_requested`  (lines 23–36)

```
fn create_apply_patch_freeform_tool_includes_environment_id_when_requested()
```

**Purpose**: This test verifies the special `apply_patch` tool description used when patches need to name an environment. It checks that the grammar includes both the optional environment ID rule and the exact text header that introduces it.

**Data flow**: It asks `create_apply_patch_freeform_tool` for the tool spec with environment IDs turned on. It expects the result to be a freeform tool; if it is not, the test stops with a panic. It then looks inside the grammar text and confirms that the environment ID pieces are present.

**Call relations**: The Rust test runner calls this function as part of automated testing. The test first uses pattern matching to unwrap the freeform tool, calls `panic!` if the wrong kind of tool comes back, and then uses `assert!` checks to confirm the needed grammar fragments were included.

*Call graph*: 2 external calls (assert!, panic!).


### `core/src/tools/handlers/apply_patch_tests.rs`

`test` · `test`

The apply_patch tool lets the system change files by receiving a patch, a text recipe that says which files to add, edit, move, or delete. This test file checks the small but important promises around that flow. Without these tests, the tool might still edit files, but surrounding systems could receive the wrong hook payload, miss a moved file during approval, or show stale progress while a patch is streaming in.

The tests cover several angles. First, they verify that pre-tool and post-tool hooks see the original free-form patch text in the shape they expect. Hooks are outside callbacks that can inspect or react to tool use, so they need stable data. Second, they test the streaming diff consumer. That consumer reads patch text as it arrives in chunks and sends partial file-change updates, like giving someone a preview while a document is still being typed. It must also understand optional environment headers and avoid sending updates too often unless enough time has passed. Third, the file checks safety behavior: selecting a remote environment must only be allowed when the turn permits it, moved files must include both old and new paths for approval, and sandbox write permissions should only be expanded for paths outside the already-writable workspace.

#### Function details

##### `sample_patch`  (lines 23–28)

```
fn sample_patch() -> &'static str
```

**Purpose**: Provides a tiny example patch used by the hook-payload tests. It keeps those tests focused on behavior instead of repeating patch text in multiple places.

**Data flow**: It takes no input. It returns a fixed patch string that says to add a file named hello.txt containing the word hello.

**Call relations**: The pre-tool and post-tool hook tests call this helper when they need a known patch body. It gives both tests the same input, so any difference in results comes from the hook logic being tested rather than from different patch text.

*Call graph*: called by 2 (post_tool_use_payload_uses_patch_input_and_tool_output, pre_tool_use_payload_uses_freeform_patch_input).


##### `invocation_for_payload`  (lines 30–42)

```
async fn invocation_for_payload(payload: ToolPayload) -> ToolInvocation
```

**Purpose**: Builds a realistic apply_patch tool invocation around a chosen payload. Tests use it when they need to ask the handler what it would send to hooks.

**Data flow**: It receives a ToolPayload, creates a test session and turn, adds a cancellation token, a diff tracker, a fixed call id, the apply_patch tool name, and marks the call as direct. It returns a ToolInvocation that looks like a real tool call but is safe for tests.

**Call relations**: The hook-payload tests call this helper before asking ApplyPatchHandler for pre-use or post-use data. Internally it relies on the session test helper and creates the small pieces a normal tool run would already have, so the tests do not need to hand-build that context.

*Call graph*: calls 3 internal fn (make_session_and_context, new, plain); called by 2 (post_tool_use_payload_uses_patch_input_and_tool_output, pre_tool_use_payload_uses_freeform_patch_input); 3 external calls (new, new, new).


##### `pre_tool_use_payload_uses_freeform_patch_input`  (lines 45–60)

```
async fn pre_tool_use_payload_uses_freeform_patch_input()
```

**Purpose**: Checks that the pre-tool hook receives the raw patch text when apply_patch is called with free-form input. This matters because hooks may inspect the exact command before the tool is allowed to run.

**Data flow**: It starts with the sample patch, wraps it as a custom tool payload, builds a tool invocation, and asks the default apply_patch handler for its pre-tool payload. It expects a payload whose tool name is apply_patch and whose input JSON contains the patch under the command field.

**Call relations**: The test runner calls this async test. The test uses sample_patch and invocation_for_payload to set up the scene, then calls the handler method under test and compares the result with the exact hook payload that downstream hook code should receive.

*Call graph*: calls 2 internal fn (invocation_for_payload, sample_patch); 2 external calls (assert_eq!, default).


##### `post_tool_use_payload_uses_patch_input_and_tool_output`  (lines 63–81)

```
async fn post_tool_use_payload_uses_patch_input_and_tool_output()
```

**Purpose**: Checks that the post-tool hook receives both the original patch text and the final tool output. This lets hooks record or react to what was requested and what happened.

**Data flow**: It creates the sample patch, wraps it in a custom payload, builds a tool invocation, and creates a successful apply_patch output message. It asks the handler for the post-tool payload and expects it to include the call id, patch command, and response text.

**Call relations**: The test runner calls this async test. It uses the same setup helper as the pre-tool test, then passes both the invocation and output into the handler so it can verify the data handed off after the tool finishes.

*Call graph*: calls 3 internal fn (from_text, invocation_for_payload, sample_patch); 2 external calls (assert_eq!, default).


##### `diff_consumer_streams_apply_patch_changes`  (lines 84–135)

```
fn diff_consumer_streams_apply_patch_changes()
```

**Purpose**: Checks that the diff consumer can read a patch arriving in pieces and report useful progress before the full patch is complete. This supports live UI updates while the model is still streaming tool arguments.

**Data flow**: It creates a fresh ApplyPatchArgumentDiffConsumer, feeds it patch fragments one by one, and watches when progress events appear. Early header text produces no event; once the added file is recognized, it reports hello.txt as being added with empty content; after the patch finishes, it reports the complete added content hello and world.

**Call relations**: The test runner calls this test. The test talks directly to the consumer through push_delta and finish_update_on_complete, exercising the same incremental path used when a tool argument is streamed rather than delivered all at once.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


##### `diff_consumer_streams_apply_patch_changes_with_environment_header`  (lines 138–161)

```
fn diff_consumer_streams_apply_patch_changes_with_environment_header()
```

**Purpose**: Checks that an optional environment header in the patch does not stop streaming diff detection. This is important because some patches may name a target environment before listing file edits.

**Data flow**: It creates a diff consumer, sends a patch start plus an Environment ID header, then sends the beginning of an added-file patch. The expected output is still a progress event showing hello.txt as an added file.

**Call relations**: The test runner calls this test. It feeds data directly into the diff consumer to confirm that environment-selection metadata is skipped over cleanly and the file-change parser still starts at the right place.

*Call graph*: 3 external calls (assert!, assert_eq!, default).


##### `diff_consumer_sends_next_update_after_buffer_interval`  (lines 164–194)

```
fn diff_consumer_sends_next_update_after_buffer_interval()
```

**Purpose**: Checks that the diff consumer sends another progress update after its buffer interval has passed. This prevents the interface from being flooded with updates while still keeping long-running streams fresh.

**Data flow**: It feeds the consumer enough patch text to trigger a first progress event. Then it manually moves the consumer's last-sent time into the past and sends more content. The result is a second progress event that includes the content known before the newest partial line.

**Call relations**: The test runner calls this test. It directly adjusts the consumer's timing state to simulate time passing, then uses push_delta to verify the rate-limiting behavior that normal streaming code depends on.

*Call graph*: 3 external calls (assert_eq!, default, now).


##### `reconcile_environment_id_requires_selection_when_enabled`  (lines 197–210)

```
fn reconcile_environment_id_requires_selection_when_enabled()
```

**Purpose**: Checks the rule for environment selection in apply_patch input. A patch may name an environment only when the current turn allows that feature.

**Data flow**: It calls require_environment_id with a parsed environment id while environment selection is disallowed and expects an error message to the model. It also calls it with no parsed id while selection is allowed and expects success with no selected environment.

**Call relations**: The test runner calls this test. It exercises the environment-id validation function directly, confirming the gate that protects turns where remote or alternate environment selection should not be available.

*Call graph*: 1 external calls (assert_eq!).


##### `approval_keys_include_move_destination`  (lines 213–242)

```
async fn approval_keys_include_move_destination()
```

**Purpose**: Checks that approval tracking includes the destination path when a patch moves a file. This matters because a move writes to a new location, not just the old one.

**Data flow**: It creates a temporary workspace with an old file and a destination directory, builds a patch that updates and moves the file, and asks the apply-patch parser to verify it. From the parsed action, it collects the file paths used for approval and expects two paths: the source and the move destination.

**Call relations**: The test runner calls this async test. It uses the real apply-patch parser rather than a mock, then passes the parsed action to file_paths_for_action to confirm approval checks will see every path that needs attention.

*Call graph*: 7 external calls (new, assert_eq!, maybe_parse_apply_patch_verified, panic!, create_dir_all, write, vec!).


##### `write_permissions_for_paths_skip_dirs_already_writable_under_workspace_root`  (lines 245–262)

```
fn write_permissions_for_paths_skip_dirs_already_writable_under_workspace_root()
```

**Purpose**: Checks that the system does not request extra write permission for files already inside the writable workspace. This keeps sandbox permissions minimal and avoids unnecessary approval prompts.

**Data flow**: It creates a temporary workspace with a nested directory, builds an absolute path to a file inside it, and uses a workspace-write sandbox policy. When it asks for extra write permissions for that path, the expected result is None because the workspace already covers it.

**Call relations**: The test runner calls this test. It exercises write_permissions_for_paths directly with a path under the current workspace, confirming that normal in-workspace edits do not create redundant sandbox permission entries.

*Call graph*: calls 2 internal fn (workspace_write, try_from); 3 external calls (new, assert_eq!, create_dir_all).


##### `write_permissions_for_paths_keep_dirs_outside_workspace_root`  (lines 265–291)

```
fn write_permissions_for_paths_keep_dirs_outside_workspace_root()
```

**Purpose**: Checks that paths outside the workspace are still included when extra write permissions are needed. This protects the sandbox rule that only known writable locations may be changed.

**Data flow**: It creates a temporary workspace directory and a separate outside directory, then builds an absolute file path in the outside directory. With a workspace-write sandbox policy, it asks for permissions and expects the outside directory to appear as an added writable root.

**Call relations**: The test runner calls this test. It exercises write_permissions_for_paths with an out-of-workspace target, then inspects the resulting sandbox profile to make sure the permission request names the correct outside directory.

*Call graph*: calls 2 internal fn (workspace_write, try_from); 4 external calls (new, assert_eq!, simplified, create_dir_all).


### `core/src/tools/handlers/mcp_resource_spec_tests.rs`

`test` · `test suite`

This is a test file for three tool definitions related to MCP, the Model Context Protocol, which lets external servers offer useful context such as files, schemas, or other application data. The tools tested here are not run against real servers. Instead, the tests check the “menu card” for each tool: what it is called, how it describes itself, and what inputs it says it accepts.

That matters because language models and API clients use these tool specifications to decide when and how to call a tool. If a field name changes by accident, or a required input is marked optional, the model may call the tool incorrectly. These tests act like a ruler held against the expected shape.

Each test builds the actual tool specification using the production helper from the surrounding module, then compares it with a hand-written expected `ToolSpec`. The expected values include the JSON schema, which is a machine-readable description of the tool’s input fields. Two list tools accept optional `server` and `cursor` fields for filtering and paging. The read tool requires both `server` and `uri`, because reading one resource needs an exact server and resource address.

#### Function details

##### `list_mcp_resources_tool_matches_expected_spec`  (lines 7–34)

```
fn list_mcp_resources_tool_matches_expected_spec()
```

**Purpose**: This test makes sure the `list_mcp_resources` tool is described correctly. It checks that the tool is named properly, explains that it lists MCP server resources, and accepts optional `server` and `cursor` inputs.

**Data flow**: The test starts with the tool specification produced by the real creation function. It builds a separate expected specification in the test, including the human-readable description and the JSON schema for inputs. It then compares the two; if anything differs, the test fails and shows the mismatch.

**Call relations**: During the test run, the Rust test runner calls this function. The function uses `assert_eq!` to compare the production tool definition against the expected one, so accidental changes to the public tool contract are caught immediately.

*Call graph*: 1 external calls (assert_eq!).


##### `list_mcp_resource_templates_tool_matches_expected_spec`  (lines 37–64)

```
fn list_mcp_resource_templates_tool_matches_expected_spec()
```

**Purpose**: This test checks the advertised shape of the `list_mcp_resource_templates` tool. Resource templates are parameterized resources, so the test confirms the description and optional paging/filtering inputs match the intended contract.

**Data flow**: The test gets the actual resource-template listing tool specification from the production code. It creates the expected version inline, with optional `server` and `cursor` string parameters. The comparison produces no output when the values match, but fails the test if any name, description, or parameter schema has drifted.

**Call relations**: The test runner invokes this function as part of the automated test suite. Inside it, `assert_eq!` is the checkpoint that decides whether the generated tool specification still matches the documented expectation.

*Call graph*: 1 external calls (assert_eq!).


##### `read_mcp_resource_tool_matches_expected_spec`  (lines 67–96)

```
fn read_mcp_resource_tool_matches_expected_spec()
```

**Purpose**: This test verifies the `read_mcp_resource` tool specification. It confirms that reading a resource requires both the MCP server name and the resource URI, which prevents callers from trying to read an unspecified resource.

**Data flow**: The test asks the production code for the actual read-resource tool specification. It then builds the expected specification, including two required string inputs: `server` and `uri`. The assertion compares the full structures and fails if the tool’s public contract changes unexpectedly.

**Call relations**: The automated test runner calls this function during tests. The function relies on `assert_eq!` to compare the actual and expected tool specifications, helping ensure callers and language models receive stable instructions for reading MCP resources.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/mcp_resource_tests.rs`

`test` · `test run`

This is a test file. It checks the small but important promises made by the MCP resource handler code. MCP, or Model Context Protocol, is the protocol shape this project uses to talk about resources such as files, memos, or templates exposed by a server. These tests make sure that when the code adds a server name to a resource, turns results into JSON, parses user-provided arguments, or trims very large output, the result still looks exactly as expected.

The file uses two helper builders, `resource` and `template`, to create simple fake resources without extra optional fields. The tests then exercise the real wrapping and serialization code. For example, they check that a resource gains a `server` field, that a paged resource list keeps its `nextCursor`, and that resources from multiple servers come out in a stable sorted order. That sorting matters because unstable output can make tools, snapshots, and users see surprising changes.

The last tests focus on tool output size. Small payloads should pass through unchanged. Very large resource reads should be cut down according to a truncation policy, like shortening an overlong receipt so it still fits in a message window. Without these tests, small changes in JSON field names, ordering, success flags, or truncation behavior could silently break clients that depend on this format.

#### Function details

##### `resource`  (lines 7–19)

```
fn resource(uri: &str, name: &str) -> Resource
```

**Purpose**: Creates a simple test resource with just a URI and a name. The tests use it as a clean sample object so they can focus on wrapping and serialization behavior instead of filling in many optional fields.

**Data flow**: It receives a URI string and a name string. It builds a raw MCP resource with those values, leaves all optional details empty, removes annotations, and returns the finished `Resource` test value.

**Call relations**: In the recorded test flow, `resource_with_server_serializes_server_field` calls this helper when it needs a small sample resource. The helper hands back that sample so the test can pass it into the resource-with-server wrapper.

*Call graph*: called by 1 (resource_with_server_serializes_server_field).


##### `template`  (lines 21–31)

```
fn template(uri_template: &str, name: &str) -> ResourceTemplate
```

**Purpose**: Creates a simple test resource template with just a URI pattern and a name. This gives the template serialization test a plain, predictable input.

**Data flow**: It receives a URI template string, such as one containing `{id}`, and a name string. It builds a raw MCP resource template, leaves optional display and media fields empty, removes annotations, and returns the finished `ResourceTemplate` value.

**Call relations**: `template_with_server_serializes_server_field` calls this helper to get a minimal template. The returned template is then wrapped with a server name and checked as JSON.

*Call graph*: called by 1 (template_with_server_serializes_server_field).


##### `resource_with_server_serializes_server_field`  (lines 34–41)

```
fn resource_with_server_serializes_server_field()
```

**Purpose**: Tests that a resource wrapped with its server name serializes to JSON with the expected `server`, `uri`, and `name` fields. This matters because clients need to know which server a listed resource came from.

**Data flow**: The test starts by making a sample resource and wrapping it with the server name `test`. It converts that wrapper into JSON, then checks that the JSON contains the server name, the resource URI, and the resource name exactly as expected.

**Call relations**: During the test run, Rust's test runner invokes this test. The test calls `resource` to make the sample input, calls the wrapper constructor `new`, then hands the wrapper to JSON serialization and compares the resulting fields with expected values.

*Call graph*: calls 2 internal fn (new, resource); 2 external calls (assert_eq!, to_value).


##### `list_resources_payload_from_single_server_copies_next_cursor`  (lines 44–58)

```
fn list_resources_payload_from_single_server_copies_next_cursor()
```

**Purpose**: Tests that a resource-list response from one server keeps its pagination cursor and marks each resource with the server name. A pagination cursor is a bookmark clients use to ask for the next page of results.

**Data flow**: The test builds a fake list result containing one resource and a `next_cursor` value. It converts that result into a single-server payload, serializes it to JSON, then checks that the top-level server and cursor are present and that the resource entry also carries the same server name.

**Call relations**: The test runner calls this test as part of the suite. The test calls `from_single_server` to transform the raw server result into the project’s outgoing payload, then uses JSON serialization and assertions to verify the result.

*Call graph*: calls 1 internal fn (from_single_server); 3 external calls (assert_eq!, to_value, vec!).


##### `list_resources_payload_from_all_servers_is_sorted`  (lines 61–86)

```
fn list_resources_payload_from_all_servers_is_sorted()
```

**Purpose**: Tests that resources collected from multiple servers are output in a predictable sorted order. Predictable order keeps clients and tests from seeing random-looking changes when the same data is returned.

**Data flow**: The test creates a map with two server names and several resources. It asks the payload builder to combine all servers, serializes the combined payload to JSON, extracts the resource URIs, and checks that they appear in the expected alpha-before-beta order.

**Call relations**: The test runner invokes this test. Inside it, the map is filled with sample resources, `from_all_servers` does the combining and ordering work, and the test inspects the serialized JSON to confirm the order.

*Call graph*: calls 1 internal fn (from_all_servers); 4 external calls (new, assert_eq!, to_value, vec!).


##### `call_tool_result_from_content_marks_success`  (lines 89–93)

```
fn call_tool_result_from_content_marks_success()
```

**Purpose**: Tests that tool output created from content is marked as successful when the success flag says so. This protects the meaning of the `is_error` field, which tells clients whether the tool call failed.

**Data flow**: The test passes a small content string and a success value into the result-building function. It then checks that the produced result has `is_error` set to `false` and contains exactly one content item.

**Call relations**: The test runner calls this test. The test exercises `call_tool_result_from_content` and then uses assertions to confirm that the result’s success/error signal and content count match the intended behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `parse_arguments_handles_empty_and_json`  (lines 96–111)

```
fn parse_arguments_handles_empty_and_json()
```

**Purpose**: Tests how tool argument text is interpreted. Empty text and JSON `null` should mean “no arguments,” while a JSON object should become usable structured data.

**Data flow**: The test first sends whitespace-only text into the parser and expects no value. It then sends the text `null` and again expects no value. Finally it sends a JSON object containing a server name and checks that the parsed value includes that server.

**Call relations**: The test runner invokes this test. The test calls `parse_arguments` with three representative inputs, then uses assertions to confirm that missing arguments and real JSON arguments are distinguished correctly.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `template_with_server_serializes_server_field`  (lines 114–126)

```
fn template_with_server_serializes_server_field()
```

**Purpose**: Tests that a resource template wrapped with a server name serializes to the expected compact JSON shape. This lets clients know which server owns a template for resources that can be filled in later.

**Data flow**: The test creates a simple template, wraps it with the server name `srv`, serializes the wrapper to JSON, and compares the whole JSON object with the exact expected object containing `server`, `uriTemplate`, and `name`.

**Call relations**: The test runner calls this test. It uses the `template` helper to make input data, calls the wrapper constructor `new`, serializes the result, and checks the final JSON with an equality assertion.

*Call graph*: calls 2 internal fn (new, template); 2 external calls (assert_eq!, to_value).


##### `serialize_function_output_preserves_small_payload`  (lines 129–138)

```
fn serialize_function_output_preserves_small_payload()
```

**Purpose**: Tests that normal-sized function output is serialized without being changed. Small responses should not be shortened or reformatted unexpectedly.

**Data flow**: The test builds a small JSON payload and separately creates the exact JSON string expected from it. It then serializes the payload through `serialize_function_output` with a generous byte limit and checks that the returned text matches the ordinary JSON string.

**Call relations**: The test runner invokes this test. The test creates a payload with the JSON helper, sets a byte-based truncation policy, sends both into the output serializer, and compares the text result with standard JSON serialization.

*Call graph*: 4 external calls (assert_eq!, json!, Bytes, to_string).


##### `serialize_function_output_caps_read_resource_payload`  (lines 141–162)

```
fn serialize_function_output_caps_read_resource_payload()
```

**Purpose**: Tests that very large resource-read output is shortened according to the configured size limit. This prevents oversized resource contents from flooding a tool response.

**Data flow**: The test builds a read-resource payload containing a long text resource. It serializes that full payload, computes the expected shortened text using the same truncation rule, then sends the payload through `serialize_function_output`. The final checks confirm the output is not the full original text and is exactly the expected shortened version.

**Call relations**: The test runner calls this test. The test constructs a large `ReadResourcePayload`, uses standard JSON serialization to know the full size, uses the truncation helper to calculate the expected capped output, and then verifies that `serialize_function_output` applies that cap.

*Call graph*: 6 external calls (new, assert_eq!, assert_ne!, Bytes, to_string, vec!).


### `core/src/tools/handlers/mcp_search_tests.rs`

`test` · `test run`

This is a test file for the MCP tool handler. MCP here means “Model Context Protocol,” a way for outside tool servers to describe tools that the system can call. The practical problem is search: if a calendar tool exists, the system needs useful searchable text so a user or model can discover it by typing things like “calendar,” “event,” “attendees,” or the tool’s own name.

The tests build a small fake calendar tool using `tool_info()`. That fake tool includes a server name, a callable name, a namespace, a title, a description, two parameter names, a connector name, and plugin display names. The tests then create an `McpHandler`, ask it for `search_info()`, and compare the result against the exact expected output.

One test checks that the search text is rich: it should include the generated tool name, original MCP tool name, server name, title, description, namespace description, plugin name, and parameter names. Another test checks the fallback behavior when the namespace description is missing. In that case, the visible namespace description should be built from the connector name, like “Tools for working with Calendar.” Without these tests, search could silently become worse or misleading when MCP metadata changes.

#### Function details

##### `search_info_uses_mcp_tool_metadata_and_parameter_names`  (lines 8–23)

```
fn search_info_uses_mcp_tool_metadata_and_parameter_names()
```

**Purpose**: This test proves that MCP tool metadata is gathered into the search entry. It checks that the handler includes both human-friendly labels and technical names, plus the tool’s parameter names, so the tool can be found through many search terms.

**Data flow**: It starts by asking `tool_info` for a sample calendar tool description. It gives that description to `McpHandler::new`, then asks the handler for its search information. The test compares the produced search text and source details against exact expected values, so any missing or extra search wording causes the test to fail.

**Call relations**: This test calls `tool_info` to get a realistic fake MCP tool, then calls the handler constructor to build the object under test. It is focused on the normal case where the MCP tool has a namespace description, and it uses assertions to lock down the search output format.

*Call graph*: calls 2 internal fn (new, tool_info); 1 external calls (assert_eq!).


##### `search_info_uses_connector_name_for_output_namespace_description`  (lines 26–43)

```
fn search_info_uses_connector_name_for_output_namespace_description()
```

**Purpose**: This test checks the fallback wording used when an MCP tool does not provide its own namespace description. It makes sure the system still gives the namespace a useful description based on the connector name.

**Data flow**: It first builds the sample calendar tool description, then removes its namespace description. After creating an `McpHandler` and asking for search information, it looks at the namespace output and verifies that its description became “Tools for working with Calendar.” It also checks that the source information keeps the connector name but has no source description.

**Call relations**: This test reuses `tool_info` but deliberately changes one field to simulate incomplete metadata. It then builds the handler, inspects the search output, and fails immediately if the output is not a namespace, because the rest of the check only makes sense for namespace search results.

*Call graph*: calls 2 internal fn (new, tool_info); 2 external calls (assert_eq!, panic!).


##### `tool_info`  (lines 45–70)

```
fn tool_info() -> ToolInfo
```

**Purpose**: This helper builds a complete sample MCP calendar tool for the tests. It keeps the test setup in one place so both tests use the same realistic tool description.

**Data flow**: It creates and returns a `ToolInfo` value filled with calendar-related metadata: server and callable names, namespace text, an MCP tool called `createEvent`, a title, a description, a JSON-shaped parameter schema with `start_time` and `attendees`, a connector name, and plugin display names. It does not read outside state or change anything elsewhere.

**Call relations**: Both tests call this helper before constructing an `McpHandler`. The helper supplies the shared input data, while each test decides what behavior to check; one uses it unchanged, and the other removes the namespace description to test fallback behavior.

*Call graph*: called by 2 (search_info_uses_connector_name_for_output_namespace_description, search_info_uses_mcp_tool_metadata_and_parameter_names); 5 external calls (new, json!, new, object, vec!).


### `core/src/tools/handlers/multi_agents_spec_tests.rs`

`test` · `test run`

This is a test file, not production logic. Its job is to protect the “contract” between the system and the language model for multi-agent tools. That contract is mostly written as tool descriptions and JSON schemas. A JSON schema is a machine-readable checklist that says which fields a tool accepts, which ones are required, and what kind of data each field should contain.

The tests create tool specifications and then inspect them like a careful proofreader. For example, they check that the newer spawn-agent tool requires both a task name and a message, hides models that should not be shown, encrypts message fields, and returns only the expected output fields. They also check backward compatibility: the older spawn-agent version must still expose the legacy `fork_context` field instead of the newer `fork_turns` field.

Other tests cover helper tools used after agents exist. They verify that sending messages and follow-up tasks require encrypted message text, that waiting for agents returns only a summary instead of full content, and that listing agents includes useful fields such as status and last task message. Without these tests, a small schema or wording change could silently break how models use multi-agent features, much like changing labels on a control panel without telling the operator.

#### Function details

##### `model_preset`  (lines 11–37)

```
fn model_preset(id: &str, show_in_picker: bool) -> ModelPreset
```

**Purpose**: Creates a small sample model entry for the tests. It lets the tests quickly make visible or hidden model presets without repeating the same setup data each time.

**Data flow**: It takes a short model id and a true-or-false flag saying whether the model should be shown in the picker. It builds a complete `ModelPreset` value from that, filling in names, descriptions, reasoning settings, service tier information, and visibility. The result is a ready-made fake model preset used by the tests.

**Call relations**: This helper is called when a test needs a realistic model preset, especially in the reasoning-effort length test. It uses standard string creation and list-building tools to assemble the preset before handing it back to the test.

*Call graph*: called by 1 (spawn_agent_tool_caps_reasoning_effort_value_length); 3 external calls (new, format!, vec!).


##### `spawn_agent_tool_v2_requires_task_name_and_lists_visible_models`  (lines 40–116)

```
fn spawn_agent_tool_v2_requires_task_name_and_lists_visible_models()
```

**Purpose**: Checks that the newer spawn-agent tool has the right required inputs and only advertises models that are meant to be visible. It also confirms that sensitive message text is marked for encryption.

**Data flow**: The test starts with two fake model presets: one visible and one hidden. It creates the version 2 spawn-agent tool, opens its description, input schema, and output schema, then compares them with the expected contract. The result is either a passing test or a failure showing exactly which part of the tool contract changed.

**Call relations**: During the test run, this function exercises the spawn-agent tool builder and then uses assertions to check the returned specification. If the builder returns the wrong kind of tool, the test stops with a panic because the rest of the checks would not make sense.

*Call graph*: 4 external calls (assert!, assert_eq!, panic!, vec!).


##### `spawn_agent_tool_v1_keeps_legacy_fork_context_field`  (lines 119–166)

```
fn spawn_agent_tool_v1_keeps_legacy_fork_context_field()
```

**Purpose**: Protects backward compatibility for the older spawn-agent tool. It verifies that version 1 still uses the old `fork_context` field and does not switch to the newer `fork_turns` field.

**Data flow**: The test creates a version 1 spawn-agent tool with no available models. It unwraps the namespace-style tool shape, reads the function’s parameters, and checks for the legacy field names, message encryption behavior, and model override descriptions. The output is a pass if the old contract is preserved, or a test failure if it has drifted.

**Call relations**: This test is part of the compatibility safety net. It calls into the version 1 tool creation path and then relies on assertions to prove that callers expecting the older namespace tool will still see the fields they know how to use.

*Call graph*: 4 external calls (new, assert!, assert_eq!, panic!).


##### `spawn_agent_tool_caps_visible_model_summaries`  (lines 169–196)

```
fn spawn_agent_tool_caps_visible_model_summaries()
```

**Purpose**: Checks that the spawn-agent description does not grow too long when many models are available. It makes sure only the first five visible model summaries are included.

**Data flow**: The test builds six visible fake models and creates the version 2 spawn-agent tool. It reads the generated description and checks that the first five model names appear while the sixth does not. The result is a pass if the description is capped as intended.

**Call relations**: This test exercises the description-building behavior of the spawn-agent tool. It uses assertions to catch accidental changes that would make the model-facing instructions too long or noisy.

*Call graph*: 3 external calls (assert!, panic!, vec!).


##### `spawn_agent_tool_caps_reasoning_effort_value_length`  (lines 199–217)

```
fn spawn_agent_tool_caps_reasoning_effort_value_length()
```

**Purpose**: Checks that very long custom reasoning-effort names are shortened before being placed in the spawn-agent description. This prevents unusually long model metadata from bloating the tool instructions.

**Data flow**: The test starts with a fake visible model, then replaces its reasoning-effort setting with a custom value that is one character too long. It asks for the model description text and compares it with the expected shortened version. The output is a pass if the text is trimmed to the allowed length.

**Call relations**: This is the only listed test that directly calls `model_preset` to make its starting model. It then creates a custom reasoning effort and uses equality checks to confirm that the description helper applies the length limit correctly.

*Call graph*: calls 1 internal fn (model_preset); 3 external calls (assert_eq!, Custom, vec!).


##### `spawn_agent_tool_hides_service_tier_with_spawn_metadata`  (lines 220–248)

```
fn spawn_agent_tool_hides_service_tier_with_spawn_metadata()
```

**Purpose**: Checks that certain spawn-agent metadata fields can be hidden when requested. This is important when the system wants to keep agent type, model, reasoning effort, and service tier choices out of the tool interface.

**Data flow**: The test creates a version 2 spawn-agent tool with the option to hide agent type, model, and reasoning metadata. It then inspects the parameter list and description. The expected result is that those fields and their guidance text are absent.

**Call relations**: This test drives the spawn-agent tool builder with a privacy-or-simplification option turned on. Assertions confirm that the builder follows that option instead of exposing extra controls to the model.

*Call graph*: 3 external calls (assert!, panic!, vec!).


##### `send_message_tool_requires_message_and_has_no_output_schema`  (lines 251–289)

```
fn send_message_tool_requires_message_and_has_no_output_schema()
```

**Purpose**: Checks the tool used to send a message to an existing agent. It verifies that both the target agent and the message are required, and that the tool does not promise a structured output.

**Data flow**: The test creates the send-message tool, reads its parameter schema, and checks for the `target` and `message` fields. It confirms the message is marked encrypted, older or unrelated fields are absent, the target description is clear, and there is no output schema. The result is a pass if the tool contract matches these expectations.

**Call relations**: This test focuses on the send-message tool creation path. It uses assertions after unpacking the returned function tool, and it panics if the created tool has an unexpected shape.

*Call graph*: 3 external calls (assert!, assert_eq!, panic!).


##### `followup_task_tool_requires_message_and_has_no_output_schema`  (lines 292–330)

```
fn followup_task_tool_requires_message_and_has_no_output_schema()
```

**Purpose**: Checks the tool used to send a follow-up task to an existing non-root agent. It makes sure the tool name, description, required fields, encryption marker, and lack of output schema all match the intended contract.

**Data flow**: The test creates the follow-up-task tool and inspects its name, description, parameters, and output schema. It expects a target and encrypted message to be required, and it expects no unrelated `items` field and no structured output. The output is simply a passing or failing test.

**Call relations**: This test exercises the follow-up-task tool builder during the test suite. It uses equality and presence checks to catch any accidental change in the tool instructions or schema.

*Call graph*: 3 external calls (assert!, assert_eq!, panic!).


##### `wait_agent_tool_v2_uses_timeout_only_summary_output`  (lines 333–371)

```
fn wait_agent_tool_v2_uses_timeout_only_summary_output()
```

**Purpose**: Checks the newer wait-agent tool contract. It verifies that waiting is controlled by an optional timeout and that the tool returns only a brief summary, not the agent’s full content.

**Data flow**: The test creates the version 2 wait-agent tool with default, minimum, and maximum timeout values. It inspects the input schema to confirm there is a `timeout_ms` field and no `targets` field, then checks the description and output schema for summary-only wording. The result is a pass if the wait tool stays focused on polling for updates rather than returning detailed content.

**Call relations**: This test drives the wait-agent tool builder with explicit timeout settings. Assertions connect those settings to the generated human-facing description and machine-readable schema.

*Call graph*: 3 external calls (assert!, assert_eq!, panic!).


##### `list_agents_tool_includes_path_prefix_and_agent_fields`  (lines 374–402)

```
fn list_agents_tool_includes_path_prefix_and_agent_fields()
```

**Purpose**: Checks that the list-agents tool supports filtering by task path and returns the key fields needed to understand each live agent. This helps callers ask for a subset of agents and read useful status information back.

**Data flow**: The test creates the list-agents tool, reads its input schema, and looks for the `path_prefix` filter with the expected explanation. It then inspects the output schema and checks that each listed agent requires `agent_name`, `agent_status`, and `last_task_message`. The result is a pass if both input filtering and output shape are correct.

**Call relations**: This test exercises the list-agents tool creation path. It uses assertions to make sure the schema remains useful for consumers that need to display or reason about active agents.

*Call graph*: 3 external calls (assert!, assert_eq!, panic!).


##### `list_agents_tool_status_schema_includes_interrupted`  (lines 405–422)

```
fn list_agents_tool_status_schema_includes_interrupted()
```

**Purpose**: Checks that `interrupted` is included as a possible agent status in the list-agents output. This matters because callers need to distinguish an interrupted agent from one that is running, shut down, missing, or still starting.

**Data flow**: The test creates the list-agents tool, opens the nested output schema for an agent’s status field, and compares the allowed status values with the expected list. The result is a pass if `interrupted` is part of the official schema.

**Call relations**: This test is a narrow guard around the status enum in the list-agents schema. It panics if the tool is not returned as the expected function shape, then uses an equality check to protect the exact set of advertised statuses.

*Call graph*: 2 external calls (assert_eq!, panic!).


### `core/src/tools/handlers/multi_agents_tests.rs`

`test` · `test`

This is a large test file for Codex's "agents talking to agents" tools. Think of a main agent as a team lead and spawned agents as helpers. These tests check the rules for hiring helpers, giving them tasks, waiting for replies, stopping them, and bringing them back later.

The file builds fake sessions, fake thread managers, and fake tool calls so each handler can be exercised without a real user conversation. It checks many edge cases that would be painful in production: empty messages, malformed agent IDs, missing managers, invalid task names, depth limits, service-tier compatibility, sandbox permissions, and whether old v1 fields are rejected in v2. It also verifies that v2 agents are addressed by stable paths such as `/root/worker`, not just raw thread IDs.

A recurring concern is inheritance. When a child agent is spawned, it must inherit the right model, approval policy, sandbox restrictions, and runtime permission profile unless the rules allow an override. Another concern is lifecycle: closed agents should disappear from lists, interrupted agents may remain resident, and explicitly closed subtrees must stay closed when a parent is resumed. Without these tests, small changes to multi-agent plumbing could quietly let agents escape restrictions, lose messages, or report confusing status to the model.

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

**Purpose**: Builds a fake tool call object for tests. It lets each test call a handler as if the model had invoked a real tool.

**Data flow**: It receives a session, a turn context, a tool name, and a payload. It wraps them with a fresh cancellation token, diff tracker, call ID, and direct-call source, then returns a complete ToolInvocation.

**Call relations**: Most tests use this helper right before calling a handler. It hides the repetitive setup so the test can focus on the handler behavior being checked.

*Call graph*: calls 2 internal fn (default, plain); called by 76 (close_agent_submits_shutdown_and_returns_previous_status, handler_rejects_non_function_payloads, multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn, multi_agent_v2_followup_task_rejects_legacy_items_field, multi_agent_v2_followup_task_rejects_root_target_from_child, multi_agent_v2_full_history_fork_accepts_explicit_service_tier, multi_agent_v2_interrupt_agent_accepts_task_name_target, multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target, multi_agent_v2_interrupt_agent_rejects_root_target_and_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_id (+15 more)); 3 external calls (new, new, new).


##### `function_payload`  (lines 87–91)

```
fn function_payload(args: serde_json::Value) -> ToolPayload
```

**Purpose**: Turns JSON test arguments into the function-call payload shape expected by tool handlers.

**Data flow**: It receives a JSON value, converts it to a string, and returns a ToolPayload::Function containing that string.

**Call relations**: Tests pass its result into invocation whenever they want to simulate a normal structured tool call from the model.

*Call graph*: called by 75 (close_agent_submits_shutdown_and_returns_previous_status, multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn, multi_agent_v2_followup_task_rejects_legacy_items_field, multi_agent_v2_followup_task_rejects_root_target_from_child, multi_agent_v2_full_history_fork_accepts_explicit_service_tier, multi_agent_v2_interrupt_agent_accepts_task_name_target, multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target, multi_agent_v2_interrupt_agent_rejects_root_target_and_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_task_name (+15 more)); 1 external calls (to_string).


##### `parse_agent_id`  (lines 93–95)

```
fn parse_agent_id(id: &str) -> ThreadId
```

**Purpose**: Converts an agent ID string returned by a handler back into a ThreadId used by the test manager.

**Data flow**: It receives text, parses it as a ThreadId, and fails the test immediately if the text is not valid.

**Call relations**: Spawn-related tests use it after reading JSON output, then query the thread manager for the spawned child thread.

*Call graph*: calls 1 internal fn (from_string); called by 7 (spawn_agent_full_history_fork_accepts_explicit_service_tier, spawn_agent_reapplies_runtime_sandbox_after_role_config, spawn_agent_role_service_tier_falls_back_to_supported_parent_tier, spawn_agent_service_tier_inheritance_preserves_supported_or_configured_tiers, spawn_agent_service_tier_override_validates_the_effective_child_model, spawn_agent_uses_explorer_role_and_preserves_approval_policy, tool_handlers_cascade_close_and_resume_and_keep_explicitly_closed_subtrees_closed).


##### `thread_manager`  (lines 97–102)

```
fn thread_manager() -> ThreadManager
```

**Purpose**: Creates a test thread manager with dummy authentication and the built-in OpenAI provider. This gives tests a controllable place to start and inspect agent threads.

**Data flow**: It reads built-in provider information, combines it with a dummy API key, and returns a ThreadManager configured for tests.

**Call relations**: Most tests that need live agent control call this before assigning the manager's agent_control handle to the fake session.

*Call graph*: calls 2 internal fn (with_models_provider_for_tests, from_api_key); called by 56 (close_agent_submits_shutdown_and_returns_previous_status, multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn, multi_agent_v2_followup_task_rejects_legacy_items_field, multi_agent_v2_followup_task_rejects_root_target_from_child, multi_agent_v2_full_history_fork_accepts_explicit_service_tier, multi_agent_v2_interrupt_agent_accepts_task_name_target, multi_agent_v2_interrupt_agent_rejects_root_target_and_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_task_name, multi_agent_v2_interrupted_turn_does_not_notify_parent (+15 more)); 1 external calls (built_in_model_providers).


##### `install_role_with_model_override`  (lines 104–136)

```
async fn install_role_with_model_override(turn: &mut TurnContext) -> String
```

**Purpose**: Adds a temporary agent role whose config file overrides the child model, provider, and reasoning effort. Tests use it to prove which spawn modes allow or reject role-based overrides.

**Data flow**: It writes a role TOML file under the test Codex home, inserts a matching AgentRoleConfig into the turn config, updates the turn, and returns the role name.

**Call relations**: Forking tests call this before spawning agents with an agent_type. The spawned handler then reads the role config through normal production paths.

*Call graph*: called by 3 (multi_agent_v2_spawn_fork_turns_all_rejects_agent_type_override, multi_agent_v2_spawn_partial_fork_turns_allows_agent_type_override, spawn_agent_fork_context_rejects_agent_type_override); 3 external calls (new, create_dir_all, write).


##### `set_turn_config`  (lines 138–141)

```
fn set_turn_config(turn: &mut TurnContext, config: crate::config::Config)
```

**Purpose**: Replaces a turn's config while also refreshing the derived multi-agent version. This keeps tests from accidentally enabling a feature flag without updating the turn state that handlers read.

**Data flow**: It receives a mutable turn and a config, computes the multi-agent version from the config's features, stores both on the turn, and returns nothing.

**Call relations**: MultiAgentV2 tests use this after enabling the feature flag so v2 handlers see a consistent turn context.

*Call graph*: called by 39 (multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn, multi_agent_v2_followup_task_rejects_legacy_items_field, multi_agent_v2_followup_task_rejects_root_target_from_child, multi_agent_v2_full_history_fork_accepts_explicit_service_tier, multi_agent_v2_interrupt_agent_accepts_task_name_target, multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target, multi_agent_v2_interrupt_agent_rejects_root_target_and_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_id, multi_agent_v2_interrupt_agent_rejects_self_target_by_task_name, multi_agent_v2_interrupted_turn_does_not_notify_parent (+15 more)); 2 external calls (new, multi_agent_version_from_features).


##### `expect_text_output`  (lines 143–167)

```
fn expect_text_output(output: T) -> (String, Option<bool>)
```

**Purpose**: Extracts the text and success flag from a handler's tool output. It gives tests a simple way to inspect JSON returned to the model.

**Data flow**: It converts a ToolOutput into a response item, accepts either normal or custom function-call output, turns text or content items into plain text, and returns that text plus the optional success value.

**Call relations**: Successful handler tests call this after handle returns, then deserialize the text or compare it directly. If the output is not a function result, it fails the test.

*Call graph*: calls 1 internal fn (function_call_output_content_items_to_text); called by 35 (close_agent_submits_shutdown_and_returns_previous_status, multi_agent_v2_full_history_fork_accepts_explicit_service_tier, multi_agent_v2_interrupt_agent_accepts_task_name_target, multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target, multi_agent_v2_list_agents_filters_by_relative_path_prefix, multi_agent_v2_list_agents_keeps_interrupted_resident_agents, multi_agent_v2_list_agents_omits_closed_agents, multi_agent_v2_list_agents_returns_completed_status_without_encrypted_spawn_preview, multi_agent_v2_spawn_agent_ignores_configured_max_depth, multi_agent_v2_spawn_omits_agent_id_when_named (+15 more)); 2 external calls (to_response_item, panic!).


##### `handler_rejects_non_function_payloads`  (lines 187–206)

```
async fn handler_rejects_non_function_payloads()
```

**Purpose**: Checks that the spawn handler refuses payloads that are not normal function-call arguments. This prevents the tool from accepting unsupported input shapes.

**Data flow**: It creates a session and a custom text payload, sends it to SpawnAgentHandler, and expects a model-facing error saying the payload is unsupported.

**Call relations**: It uses the common invocation helper and directly exercises the legacy spawn handler's input validation path.

*Call graph*: calls 2 internal fn (make_session_and_context, invocation); 4 external calls (new, default, assert_eq!, panic!).


##### `spawn_agent_rejects_empty_message`  (lines 209–224)

```
async fn spawn_agent_rejects_empty_message()
```

**Purpose**: Checks that an agent cannot be spawned with only blank text as its task. A child agent needs a real instruction.

**Data flow**: It passes a whitespace message to spawn_agent and expects the handler to return an error about empty messages.

**Call relations**: This test drives SpawnAgentHandler through the same function-payload path used by normal tool calls.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `spawn_agent_rejects_when_message_and_items_are_both_set`  (lines 227–247)

```
async fn spawn_agent_rejects_when_message_and_items_are_both_set()
```

**Purpose**: Checks that legacy spawn_agent rejects requests that provide both plain message text and structured items. This avoids ambiguous instructions.

**Data flow**: It sends both a message and an items array to the handler, then expects an error telling the caller to choose one format.

**Call relations**: It covers a shared validation rule also tested for send_input.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `spawn_agent_uses_explorer_role_and_preserves_approval_policy`  (lines 250–307)

```
async fn spawn_agent_uses_explorer_role_and_preserves_approval_policy()
```

**Purpose**: Verifies that spawning an explorer agent applies the requested role while keeping the parent's approval policy. Approval policy controls when user permission is required.

**Data flow**: It sets up a manager, configures the parent to use the Ollama provider and on-request approvals, spawns an explorer, parses the returned agent ID, and checks the child snapshot.

**Call relations**: The test calls SpawnAgentHandler and then asks the test thread manager what configuration the child actually received.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, thread_manager); 8 external calls (new, default, assert!, assert_eq!, create_model_provider, built_in_model_providers, json!, from_str).


##### `spawn_agent_fork_context_rejects_agent_type_override`  (lines 310–341)

```
async fn spawn_agent_fork_context_rejects_agent_type_override()
```

**Purpose**: Ensures a full-history fork cannot also change the agent type. A full-history fork is meant to continue the same context, not become a different role.

**Data flow**: It installs a role with model overrides, starts a root thread, asks spawn_agent for fork_context plus agent_type, and expects a clear rejection.

**Call relations**: It tests legacy spawn behavior and uses the role-install helper to make the forbidden override meaningful.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, install_role_with_model_override, invocation, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `spawn_agent_fork_context_rejects_child_model_overrides`  (lines 344–376)

```
async fn spawn_agent_fork_context_rejects_child_model_overrides()
```

**Purpose**: Ensures a full-history fork cannot override the model or reasoning effort. The child must inherit these from the parent in that mode.

**Data flow**: It starts a root thread, sends spawn_agent a fork_context request with explicit model and reasoning_effort, and checks for the inherited-settings error.

**Call relations**: It complements the agent_type fork test by covering direct model override fields.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `multi_agent_v2_spawn_fork_turns_all_rejects_agent_type_override`  (lines 379–422)

```
async fn multi_agent_v2_spawn_fork_turns_all_rejects_agent_type_override()
```

**Purpose**: Checks that MultiAgentV2 treats fork_turns="all" like a full-history fork and rejects agent type overrides.

**Data flow**: It enables MultiAgentV2, installs an overriding role, sends a spawn request with fork_turns all and agent_type, and expects the same inheritance error.

**Call relations**: This is the v2 version of the legacy full-history fork rule.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, install_role_with_model_override, invocation, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `multi_agent_v2_spawn_defaults_to_full_fork_and_rejects_child_model_overrides`  (lines 425–463)

```
async fn multi_agent_v2_spawn_defaults_to_full_fork_and_rejects_child_model_overrides()
```

**Purpose**: Checks that MultiAgentV2's default spawn is a full fork and therefore rejects child model overrides unless a partial or no fork is requested.

**Data flow**: It enables v2, starts a root thread, calls spawn_agent with model and reasoning_effort but no fork_turns, and expects the inherited-settings error.

**Call relations**: It confirms v2 default behavior through SpawnAgentHandlerV2.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `spawn_agent_service_tier_override_validates_the_effective_child_model`  (lines 466–562)

```
async fn spawn_agent_service_tier_override_validates_the_effective_child_model()
```

**Purpose**: Checks that requested service tiers are validated against the model the child will actually use. A service tier is a provider option such as priority access.

**Data flow**: It runs three spawn cases: a supported tier succeeds and is stored, an unknown tier fails, and a tier unsupported by the chosen child model fails.

**Call relations**: It calls the legacy spawn handler and then inspects child config snapshots for successful cases.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `spawn_agent_service_tier_inheritance_preserves_supported_or_configured_tiers`  (lines 565–718)

```
async fn spawn_agent_service_tier_inheritance_preserves_supported_or_configured_tiers()
```

**Purpose**: Checks how service tier values move from parent config, explicit child model choices, and role files into spawned agents.

**Data flow**: It creates several parent and role configurations, spawns children, and inspects snapshots to see whether the tier is preserved or cleared when incompatible.

**Call relations**: It exercises SpawnAgentHandler with inherited settings, explicit model overrides, and role config overrides.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, thread_manager); 7 external calls (new, default, assert_eq!, json!, from_str, create_dir_all, write).


##### `spawn_agent_role_service_tier_falls_back_to_supported_parent_tier`  (lines 721–790)

```
async fn spawn_agent_role_service_tier_falls_back_to_supported_parent_tier()
```

**Purpose**: Verifies that an unsupported service tier in a role file does not poison the spawn if the parent has a supported tier to use instead.

**Data flow**: It writes a role config with an invalid child tier, gives the parent a valid tier, spawns the role, and checks that the child uses the parent's supported tier.

**Call relations**: It focuses on the role-config path inside SpawnAgentHandler.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, thread_manager); 7 external calls (new, default, assert_eq!, json!, from_str, create_dir_all, write).


##### `spawn_agent_role_service_tier_does_not_hide_invalid_spawn_request`  (lines 793–840)

```
async fn spawn_agent_role_service_tier_does_not_hide_invalid_spawn_request()
```

**Purpose**: Ensures an invalid service tier explicitly requested in the spawn call is still rejected, even if the role file contains a valid tier.

**Data flow**: It creates a role with a supported tier, calls spawn_agent with service_tier="turbo", and expects the unsupported-tier error.

**Call relations**: This guards priority order: user request validation must not be hidden by role defaults.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 6 external calls (new, default, assert_eq!, json!, create_dir_all, write).


##### `spawn_agent_full_history_fork_accepts_explicit_service_tier`  (lines 843–888)

```
async fn spawn_agent_full_history_fork_accepts_explicit_service_tier()
```

**Purpose**: Checks that full-history fork restrictions still allow an explicit service tier when that tier is valid for the inherited model.

**Data flow**: It sets the parent model to one that supports the fast tier, spawns with fork_context and service_tier, then checks the child snapshot.

**Call relations**: It narrows the full-history fork rule tested earlier: model and role overrides are forbidden, but service tier can be supplied.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `multi_agent_v2_full_history_fork_accepts_explicit_service_tier`  (lines 891–954)

```
async fn multi_agent_v2_full_history_fork_accepts_explicit_service_tier()
```

**Purpose**: Checks the same valid service-tier exception for MultiAgentV2 full-history forks.

**Data flow**: It enables v2, spawns a named task with a supported service tier, resolves the task name to a child thread, and checks the child config.

**Call relations**: It proves SpawnAgentHandlerV2 follows the same service-tier rule as the legacy handler.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `multi_agent_v2_spawn_partial_fork_turns_allows_agent_type_override`  (lines 957–1012)

```
async fn multi_agent_v2_spawn_partial_fork_turns_allows_agent_type_override()
```

**Purpose**: Verifies that a partial v2 fork may use a different agent role. Partial forks do not inherit the entire parent history, so role changes are allowed.

**Data flow**: It enables v2, installs a role with model overrides, spawns with fork_turns="1", and checks the child model, provider, and reasoning effort.

**Call relations**: It contrasts with the v2 full-fork rejection tests.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, install_role_with_model_override, invocation, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `spawn_agent_returns_agent_id_without_task_name`  (lines 1015–1039)

```
async fn spawn_agent_returns_agent_id_without_task_name()
```

**Purpose**: Checks the legacy spawn response shape. In v1, an unnamed child should return a raw agent_id and nickname, not a task path.

**Data flow**: It spawns an agent, extracts the output JSON, and asserts agent_id exists, task_name does not, nickname exists, and success is true.

**Call relations**: It protects backwards compatibility for callers of the legacy SpawnAgentHandler.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 6 external calls (new, default, assert!, assert_eq!, json!, from_str).


##### `multi_agent_v2_spawn_requires_task_name`  (lines 1042–1073)

```
async fn multi_agent_v2_spawn_requires_task_name()
```

**Purpose**: Checks that v2 spawn requests must name the task. V2 uses task paths as stable addresses.

**Data flow**: It enables v2, calls spawn_agent without task_name, and expects a parse error mentioning the missing field.

**Call relations**: It drives SpawnAgentHandlerV2's argument parsing rules.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert!, json!, panic!).


##### `multi_agent_v2_spawn_rejects_legacy_items_field`  (lines 1076–1109)

```
async fn multi_agent_v2_spawn_rejects_legacy_items_field()
```

**Purpose**: Ensures v2 spawn rejects the old structured items field. V2 expects a simpler encrypted message field shape.

**Data flow**: It enables v2, sends message plus items plus task_name, and expects an unknown-field error for items.

**Call relations**: It is one of several v2 tests that keep legacy fields out of the new protocol.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert!, json!, panic!).


##### `spawn_agent_errors_when_manager_dropped`  (lines 1112–1127)

```
async fn spawn_agent_errors_when_manager_dropped()
```

**Purpose**: Checks that spawning fails cleanly when no agent manager is available. Without the manager, there is nowhere to create the child thread.

**Data flow**: It builds a normal session without installing agent_control, calls spawn_agent, and expects a "collab manager unavailable" error.

**Call relations**: It tests the handler's dependency check before any real spawn work happens.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `multi_agent_v2_spawn_returns_path_and_send_message_accepts_relative_path`  (lines 1130–1228)

```
async fn multi_agent_v2_spawn_returns_path_and_send_message_accepts_relative_path()
```

**Purpose**: Verifies that v2 spawn returns an absolute task path and that send_message can later address that child by a relative path.

**Data flow**: It spawns `/root/test_process`, checks the child's metadata and captured communication, then sends another message to `test_process` and checks the delivered operation.

**Call relations**: It connects SpawnAgentHandlerV2 and SendMessageHandlerV2 in one end-to-end path-addressing scenario.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 6 external calls (new, default, assert!, assert_eq!, json!, from_str).


##### `multi_agent_v2_spawn_rejects_legacy_fork_context`  (lines 1231–1268)

```
async fn multi_agent_v2_spawn_rejects_legacy_fork_context()
```

**Purpose**: Checks that v2 does not accept the old fork_context flag. Callers must use fork_turns instead.

**Data flow**: It enables v2, sends a spawn request containing fork_context, and expects a specific error pointing to fork_turns.

**Call relations**: It enforces the v2 API boundary in SpawnAgentHandlerV2.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `multi_agent_v2_spawn_rejects_invalid_fork_turns_string`  (lines 1271–1308)

```
async fn multi_agent_v2_spawn_rejects_invalid_fork_turns_string()
```

**Purpose**: Checks that v2 fork_turns only accepts known words or a positive integer string.

**Data flow**: It sends fork_turns="banana" and expects an error explaining the allowed values.

**Call relations**: It tests parsing and validation before any child thread is created.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `multi_agent_v2_spawn_rejects_zero_fork_turns`  (lines 1311–1348)

```
async fn multi_agent_v2_spawn_rejects_zero_fork_turns()
```

**Purpose**: Checks that fork_turns="0" is rejected. Zero turns must be written as the explicit word "none" instead.

**Data flow**: It sends a v2 spawn request with fork_turns set to zero and expects the allowed-values error.

**Call relations**: It covers a boundary case in SpawnAgentHandlerV2's fork-turn parser.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 4 external calls (new, default, assert_eq!, json!).


##### `multi_agent_v2_send_message_accepts_root_target_from_child`  (lines 1351–1425)

```
async fn multi_agent_v2_send_message_accepts_root_target_from_child()
```

**Purpose**: Verifies that a child agent can send a normal message back to the root agent in v2.

**Data flow**: It manually creates a child session source, calls send_message with target `/root`, and checks that the root thread receives an inter-agent communication from the child path.

**Call relations**: It exercises SendMessageHandlerV2 from a sub-agent context.

*Call graph*: calls 6 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager, try_from); 6 external calls (new, SubAgent, assert!, default, json!, vec!).


##### `multi_agent_v2_followup_task_rejects_root_target_from_child`  (lines 1428–1508)

```
async fn multi_agent_v2_followup_task_rejects_root_target_from_child()
```

**Purpose**: Checks that a child cannot create a follow-up task targeting the root agent. Follow-up tasks are for continuing spawned agents, not commanding the root.

**Data flow**: It creates a child context, calls followup_task with target `/root`, expects a rejection, and verifies no root interrupt or message operation was submitted.

**Call relations**: It tests FollowupTaskHandlerV2's extra safety rule compared with send_message.

*Call graph*: calls 6 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager, try_from); 8 external calls (new, SubAgent, assert!, assert_eq!, default, json!, panic!, vec!).


##### `multi_agent_v2_list_agents_returns_completed_status_without_encrypted_spawn_preview`  (lines 1511–1599)

```
async fn multi_agent_v2_list_agents_returns_completed_status_without_encrypted_spawn_preview()
```

**Purpose**: Checks that v2 list_agents reports completed agents clearly without leaking the encrypted spawn message as a preview.

**Data flow**: It spawns a worker, injects a completed event with the message "done", lists agents, and checks root and worker entries.

**Call relations**: It combines SpawnAgentHandlerV2, session event recording, and ListAgentsHandlerV2 output formatting.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 6 external calls (new, default, assert_eq!, json!, TurnComplete, from_str).


##### `multi_agent_v2_list_agents_filters_by_relative_path_prefix`  (lines 1602–1686)

```
async fn multi_agent_v2_list_agents_filters_by_relative_path_prefix()
```

**Purpose**: Verifies that v2 list_agents can filter descendants using a relative path prefix from the caller's current agent path.

**Data flow**: It creates `/root/researcher` and `/root/researcher/worker`, makes the caller the researcher, lists with prefix `worker`, and expects only the worker.

**Call relations**: It exercises ListAgentsHandlerV2's path resolution and filtering behavior.

*Call graph*: calls 7 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, from_string); 7 external calls (new, SubAgent, assert_eq!, default, json!, from_str, vec!).


##### `multi_agent_v2_list_agents_omits_closed_agents`  (lines 1689–1750)

```
async fn multi_agent_v2_list_agents_omits_closed_agents()
```

**Purpose**: Checks that closed v2 agents disappear from list_agents results.

**Data flow**: It spawns a worker, closes it through agent_control, lists agents, and expects only `/root` to remain.

**Call relations**: It confirms list_agents respects lifecycle state maintained by the manager.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `multi_agent_v2_list_agents_keeps_interrupted_resident_agents`  (lines 1753–1826)

```
async fn multi_agent_v2_list_agents_keeps_interrupted_resident_agents()
```

**Purpose**: Checks that interrupted but still resident agents remain visible in list_agents. Interrupted is not the same as closed.

**Data flow**: It spawns a worker, interrupts it through the v2 interrupt handler, lists agents, and expects both root and worker entries.

**Call relations**: It links InterruptAgentHandler behavior with ListAgentsHandlerV2 visibility rules.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `multi_agent_v2_send_message_rejects_legacy_items_field`  (lines 1829–1882)

```
async fn multi_agent_v2_send_message_rejects_legacy_items_field()
```

**Purpose**: Ensures v2 send_message rejects the old items field.

**Data flow**: It spawns a worker, calls send_message with items instead of message, and expects an unknown-field parse error.

**Call relations**: It mirrors the v2 spawn legacy-field rejection for the send-message handler.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert!, json!, panic!).


##### `multi_agent_v2_send_message_rejects_interrupt_parameter`  (lines 1885–1956)

```
async fn multi_agent_v2_send_message_rejects_interrupt_parameter()
```

**Purpose**: Checks that v2 send_message cannot also request an interrupt. Interrupting is a separate tool action.

**Data flow**: It spawns a worker, calls send_message with interrupt=true, expects a parse error, and confirms neither interrupt nor message operations were sent.

**Call relations**: It protects SendMessageHandlerV2 from silently accepting a removed or dangerous option.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert!, json!, panic!).


##### `multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn`  (lines 1959–2098)

```
async fn multi_agent_v2_followup_task_completion_notifies_parent_on_every_turn()
```

**Purpose**: Verifies that a parent is notified each time a child completes a turn, including after a follow-up task.

**Data flow**: It spawns a worker, injects one completed turn, sends a follow-up task, injects a second completed turn, then waits until exactly one parent notification for each appears.

**Call relations**: It connects SpawnAgentHandlerV2, FollowupTaskHandlerV2, event handling, and inter-agent completion-message formatting.

*Call graph*: calls 8 internal fn (make_session_and_context, format_inter_agent_completion_message, function_payload, invocation, set_turn_config, thread_manager, root, try_from); 10 external calls (new, from_millis, from_secs, default, assert_eq!, json!, Completed, TurnComplete, sleep, timeout).


##### `multi_agent_v2_followup_task_rejects_legacy_items_field`  (lines 2101–2151)

```
async fn multi_agent_v2_followup_task_rejects_legacy_items_field()
```

**Purpose**: Ensures v2 followup_task rejects the old items field.

**Data flow**: It spawns a worker, calls followup_task with items, and expects an unknown-field parse error.

**Call relations**: It is the follow-up-task version of the v2 legacy input-shape tests.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert!, json!, panic!).


##### `multi_agent_v2_interrupted_turn_does_not_notify_parent`  (lines 2154–2228)

```
async fn multi_agent_v2_interrupted_turn_does_not_notify_parent()
```

**Purpose**: Checks that an interrupted child turn does not produce a completion notification to the parent.

**Data flow**: It spawns a worker, sends a TurnAborted event with reason Interrupted, then checks that no parent communication from the worker was captured.

**Call relations**: It tests the event-to-notification path used by MultiAgentV2 child turns.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert_eq!, json!, TurnAborted).


##### `multi_agent_v2_spawn_omits_agent_id_when_named`  (lines 2231–2267)

```
async fn multi_agent_v2_spawn_omits_agent_id_when_named()
```

**Purpose**: Checks the v2 spawn response shape. Named v2 agents should be returned by task path, not raw internal thread ID.

**Data flow**: It spawns a named task, reads the JSON output, and asserts task_name exists while agent_id and nickname do not.

**Call relations**: It protects the public response contract of SpawnAgentHandlerV2.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 6 external calls (new, default, assert!, assert_eq!, json!, from_str).


##### `multi_agent_v2_spawn_surfaces_task_name_validation_errors`  (lines 2270–2304)

```
async fn multi_agent_v2_spawn_surfaces_task_name_validation_errors()
```

**Purpose**: Checks that invalid v2 task names produce a clear model-facing error.

**Data flow**: It sends task_name="BadName" and expects the lowercase/digit/underscore validation message.

**Call relations**: It exercises the path-name validation used before v2 agents are created.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `spawn_agent_reapplies_runtime_sandbox_after_role_config`  (lines 2307–2396)

```
async fn spawn_agent_reapplies_runtime_sandbox_after_role_config()
```

**Purpose**: Verifies that role config loading does not erase runtime sandbox and permission settings. Sandbox settings limit what files, network, and commands a child can use.

**Data flow**: It builds a runtime permission profile different from the base config, spawns an explorer role, then checks the child config and first turn policies match the runtime values.

**Call relations**: It tests SpawnAgentHandler's interaction with config overlays, approval settings, and turn-level permission profiles.

*Call graph*: calls 11 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, parse_agent_id, set_turn_config, thread_manager, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd (+1 more)); 7 external calls (new, default, assert!, assert_eq!, assert_ne!, json!, from_str).


##### `spawn_agent_rejects_when_depth_limit_exceeded`  (lines 2399–2428)

```
async fn spawn_agent_rejects_when_depth_limit_exceeded()
```

**Purpose**: Checks that legacy agents cannot keep spawning children past the configured depth limit.

**Data flow**: It marks the current turn as already at max depth, calls spawn_agent, and expects the "solve the task yourself" error.

**Call relations**: It exercises the legacy depth guard in SpawnAgentHandler.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 6 external calls (new, default, SubAgent, assert_eq!, json!, panic!).


##### `spawn_agent_allows_depth_up_to_configured_max_depth`  (lines 2431–2474)

```
async fn spawn_agent_allows_depth_up_to_configured_max_depth()
```

**Purpose**: Checks that the depth limit is configurable and allows spawning when the parent is still below the new maximum.

**Data flow**: It raises agent_max_depth, marks the current agent at the default depth, spawns a child, and checks that a valid ID and nickname are returned.

**Call relations**: It complements the depth-limit rejection test.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 7 external calls (new, default, SubAgent, assert!, assert_eq!, json!, from_str).


##### `multi_agent_v2_spawn_agent_ignores_configured_max_depth`  (lines 2477–2528)

```
async fn multi_agent_v2_spawn_agent_ignores_configured_max_depth()
```

**Purpose**: Verifies that MultiAgentV2 does not use the legacy max-depth rule. V2 path nesting is governed differently.

**Data flow**: It sets max depth to one, makes the caller a child agent, spawns another named child with fork_turns none, and expects `/root/parent/child` to be created.

**Call relations**: It proves SpawnAgentHandlerV2 intentionally differs from legacy SpawnAgentHandler on depth.

*Call graph*: calls 7 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, try_from); 6 external calls (new, default, SubAgent, assert_eq!, json!, from_str).


##### `send_input_rejects_empty_message`  (lines 2531–2546)

```
async fn send_input_rejects_empty_message()
```

**Purpose**: Checks that send_input refuses an empty message. A resumed or existing agent should not be prompted with nothing.

**Data flow**: It sends an empty message to a random target ID and expects the empty-message error before target lookup matters.

**Call relations**: It exercises SendInputHandler's input validation.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 4 external calls (new, assert_eq!, json!, panic!).


##### `send_input_rejects_when_message_and_items_are_both_set`  (lines 2549–2570)

```
async fn send_input_rejects_when_message_and_items_are_both_set()
```

**Purpose**: Checks that send_input rejects ambiguous requests containing both message and structured items.

**Data flow**: It passes both fields and expects the handler to tell the caller to choose one.

**Call relations**: It covers the same message-vs-items rule as legacy spawn.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 4 external calls (new, assert_eq!, json!, panic!).


##### `send_input_rejects_invalid_id`  (lines 2573–2588)

```
async fn send_input_rejects_invalid_id()
```

**Purpose**: Checks that send_input reports malformed agent IDs clearly.

**Data flow**: It passes target="not-a-uuid" and expects a model-facing invalid-agent-id error.

**Call relations**: It tests parsing before SendInputHandler tries to contact the manager.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 4 external calls (new, assert!, json!, panic!).


##### `send_input_reports_missing_agent`  (lines 2591–2609)

```
async fn send_input_reports_missing_agent()
```

**Purpose**: Checks that send_input reports a well-formed but nonexistent agent ID.

**Data flow**: It installs a test manager, chooses a new ThreadId that has no thread, sends input, and expects an agent-not-found error.

**Call relations**: It exercises SendInputHandler's lookup path through agent_control.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, thread_manager, new); 4 external calls (new, assert_eq!, json!, panic!).


##### `send_input_interrupts_before_prompt`  (lines 2612–2651)

```
async fn send_input_interrupts_before_prompt()
```

**Purpose**: Verifies that send_input sends an interrupt before the new prompt when requested.

**Data flow**: It starts a thread, calls send_input with interrupt=true, then inspects captured operations to confirm Interrupt comes before UserInput.

**Call relations**: It tests operation ordering in SendInputHandler.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 4 external calls (new, assert!, assert_eq!, json!).


##### `send_input_accepts_structured_items`  (lines 2654–2708)

```
async fn send_input_accepts_structured_items()
```

**Purpose**: Checks that legacy send_input can send structured input items such as mentions plus text.

**Data flow**: It starts a thread, sends an items array, builds the expected UserInput operation, and confirms the manager captured it.

**Call relations**: It verifies SendInputHandler's conversion from JSON items into protocol-level user input.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 5 external calls (new, default, assert_eq!, json!, vec!).


##### `resume_agent_rejects_invalid_id`  (lines 2711–2726)

```
async fn resume_agent_rejects_invalid_id()
```

**Purpose**: Checks that resume_agent rejects malformed IDs.

**Data flow**: It calls resume_agent with id="not-a-uuid" and expects an invalid-agent-id message.

**Call relations**: It tests ResumeAgentHandler's parsing guard.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 4 external calls (new, assert!, json!, panic!).


##### `resume_agent_reports_missing_agent`  (lines 2729–2747)

```
async fn resume_agent_reports_missing_agent()
```

**Purpose**: Checks that resume_agent reports a missing but well-formed agent ID.

**Data flow**: It installs a test manager, creates a fresh ThreadId with no stored agent, calls resume_agent, and expects an agent-not-found error.

**Call relations**: It exercises ResumeAgentHandler's lookup path.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, thread_manager, new); 4 external calls (new, assert_eq!, json!, panic!).


##### `resume_agent_noops_for_active_agent`  (lines 2750–2786)

```
async fn resume_agent_noops_for_active_agent()
```

**Purpose**: Verifies that resuming an already active agent does not create a duplicate thread.

**Data flow**: It starts an agent, records its status, calls resume_agent, checks the returned status, and confirms the manager still has exactly one thread ID.

**Call relations**: It tests the harmless no-op path of ResumeAgentHandler.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 4 external calls (new, assert_eq!, json!, from_str).


##### `resume_agent_restores_closed_agent_and_accepts_send_input`  (lines 2789–2865)

```
async fn resume_agent_restores_closed_agent_and_accepts_send_input()
```

**Purpose**: Checks that a closed agent with saved history can be resumed and then receive input.

**Data flow**: It creates a thread from forked history, shuts it down, resumes it, confirms it is no longer NotFound, then sends input and checks a submission ID is returned.

**Call relations**: It combines ResumeAgentHandler and SendInputHandler to prove restored agents are usable.

*Call graph*: calls 7 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager, from_auth_for_testing, from_api_key); 8 external calls (new, assert!, assert_eq!, assert_ne!, json!, Forked, from_str, vec!).


##### `resume_agent_rejects_when_depth_limit_exceeded`  (lines 2868–2897)

```
async fn resume_agent_rejects_when_depth_limit_exceeded()
```

**Purpose**: Checks that legacy resume_agent also respects the agent depth limit.

**Data flow**: It marks the current turn as already at max depth, calls resume_agent, and expects the depth-limit error.

**Call relations**: It mirrors the spawn depth-limit test for ResumeAgentHandler.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 5 external calls (new, SubAgent, assert_eq!, json!, panic!).


##### `wait_agent_rejects_non_positive_timeout`  (lines 2900–2918)

```
async fn wait_agent_rejects_non_positive_timeout()
```

**Purpose**: Checks that legacy wait_agent rejects timeout_ms values of zero or below.

**Data flow**: It calls wait_agent with one target and timeout_ms 0, then expects a greater-than-zero error.

**Call relations**: It tests argument validation in the legacy WaitAgentHandler.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `wait_agent_rejects_invalid_target`  (lines 2921–2936)

```
async fn wait_agent_rejects_invalid_target()
```

**Purpose**: Checks that legacy wait_agent rejects malformed target IDs.

**Data flow**: It passes targets=["invalid"] and expects an invalid-agent-id error.

**Call relations**: It exercises WaitAgentHandler's target parsing.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert!, json!, panic!).


##### `wait_agent_rejects_empty_targets`  (lines 2939–2954)

```
async fn wait_agent_rejects_empty_targets()
```

**Purpose**: Checks that legacy wait_agent requires at least one target.

**Data flow**: It passes an empty target list and expects an "agent ids must be non-empty" error.

**Call relations**: It covers a basic guard before waiting starts.

*Call graph*: calls 3 internal fn (make_session_and_context, function_payload, invocation); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `multi_agent_v2_wait_agent_accepts_timeout_only_argument`  (lines 2957–3043)

```
async fn multi_agent_v2_wait_agent_accepts_timeout_only_argument()
```

**Purpose**: Verifies that v2 wait_agent can wait without explicit targets, using mailbox activity instead.

**Data flow**: It spawns a worker, starts wait_agent with only timeout_ms, enqueues a worker-to-root mailbox message, and expects wait to complete without timing out.

**Call relations**: It tests the mailbox-based waiting style of WaitAgentHandlerV2.

*Call graph*: calls 8 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, root, new); 9 external calls (new, default, new, default, assert_eq!, json!, from_str, spawn, yield_now).


##### `multi_agent_v2_wait_agent_rejects_timeout_below_configured_min`  (lines 3046–3073)

```
async fn multi_agent_v2_wait_agent_rejects_timeout_below_configured_min()
```

**Purpose**: Checks that v2 wait_agent honors the configured minimum timeout.

**Data flow**: It sets min timeout to 50 ms, calls wait_agent with timeout_ms 1, and expects an at-least-50 error.

**Call relations**: It tests WaitAgentHandlerV2 against configurable limits.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, set_turn_config); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `multi_agent_v2_wait_agent_accepts_explicit_timeout_at_configured_min`  (lines 3076–3108)

```
async fn multi_agent_v2_wait_agent_accepts_explicit_timeout_at_configured_min()
```

**Purpose**: Checks that the v2 minimum timeout is inclusive.

**Data flow**: It sets min timeout to 1 ms, calls wait_agent with 1 ms, and expects a successful timed-out result.

**Call relations**: It complements the below-minimum rejection test.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `multi_agent_v2_wait_agent_uses_configured_default_timeout`  (lines 3111–3163)

```
async fn multi_agent_v2_wait_agent_uses_configured_default_timeout()
```

**Purpose**: Verifies that v2 wait_agent uses the configured default timeout when none is supplied.

**Data flow**: It sets the default to 50 ms, confirms an early 20 ms wrapper times out, then waits long enough and expects wait_agent's own timed-out result.

**Call relations**: It checks the default timeout path in WaitAgentHandlerV2.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config); 9 external calls (new, from_millis, from_secs, default, assert!, assert_eq!, json!, from_str, timeout).


##### `multi_agent_v2_wait_agent_allows_zero_configured_timeout`  (lines 3166–3203)

```
async fn multi_agent_v2_wait_agent_allows_zero_configured_timeout()
```

**Purpose**: Checks that v2 can be configured to allow an immediate zero-timeout wait.

**Data flow**: It sets min, max, and default wait timeouts to zero, calls wait_agent with no arguments, and expects an immediate timed-out result.

**Call relations**: It covers a special configuration boundary in WaitAgentHandlerV2.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config); 7 external calls (new, from_secs, default, assert_eq!, json!, from_str, timeout).


##### `multi_agent_v2_wait_agent_rejects_timeout_above_configured_max`  (lines 3206–3233)

```
async fn multi_agent_v2_wait_agent_rejects_timeout_above_configured_max()
```

**Purpose**: Checks that v2 wait_agent honors the configured maximum timeout.

**Data flow**: It sets max timeout to 50 ms, calls wait_agent with 500 ms, and expects an at-most-50 error.

**Call relations**: It tests the upper bound paired with the minimum-bound tests.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, set_turn_config); 5 external calls (new, default, assert_eq!, json!, panic!).


##### `multi_agent_v2_wait_agent_accepts_explicit_timeout_at_configured_max`  (lines 3236–3268)

```
async fn multi_agent_v2_wait_agent_accepts_explicit_timeout_at_configured_max()
```

**Purpose**: Checks that the v2 maximum timeout is inclusive.

**Data flow**: It sets min, max, and default to 1 ms, calls wait_agent with 1 ms, and expects a successful timed-out result.

**Call relations**: It complements the above-maximum rejection test.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `wait_agent_returns_not_found_for_missing_agents`  (lines 3271–3304)

```
async fn wait_agent_returns_not_found_for_missing_agents()
```

**Purpose**: Checks that legacy wait_agent returns NotFound status for missing agents instead of failing.

**Data flow**: It installs a manager, waits on two new ThreadIds that do not exist, and expects a status map marking both NotFound with no timeout.

**Call relations**: It tests WaitAgentHandler's final-status reporting for absent agents.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager, new); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `wait_agent_times_out_when_status_is_not_final`  (lines 3307–3347)

```
async fn wait_agent_times_out_when_status_is_not_final()
```

**Purpose**: Checks that legacy wait_agent times out if an agent remains active and does not reach a final status.

**Data flow**: It starts a thread, waits on it for the minimum timeout, and expects an empty status map with timed_out true.

**Call relations**: It exercises the normal waiting loop in WaitAgentHandler.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 5 external calls (new, default, assert_eq!, json!, from_str).


##### `wait_agent_clamps_short_timeouts_to_minimum`  (lines 3350–3385)

```
async fn wait_agent_clamps_short_timeouts_to_minimum()
```

**Purpose**: Verifies that legacy wait_agent silently raises very short positive timeouts to the minimum wait time.

**Data flow**: It asks for 10 ms but wraps the handler in a 50 ms timeout, expecting the wrapper to expire because the handler is still waiting.

**Call relations**: It tests legacy timeout clamping rather than rejection.

*Call graph*: calls 4 internal fn (make_session_and_context, function_payload, invocation, thread_manager); 6 external calls (new, from_millis, default, assert!, json!, timeout).


##### `wait_agent_returns_final_status_without_timeout`  (lines 3388–3437)

```
async fn wait_agent_returns_final_status_without_timeout()
```

**Purpose**: Checks that legacy wait_agent returns promptly when the target has already reached a final status.

**Data flow**: It starts and shuts down a thread, waits for the status update, then calls wait_agent and expects Shutdown with timed_out false.

**Call relations**: It tests WaitAgentHandler's fast path for completed agents.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 7 external calls (new, from_secs, default, assert_eq!, json!, from_str, timeout).


##### `multi_agent_v2_wait_agent_returns_summary_for_mailbox_activity`  (lines 3440–3527)

```
async fn multi_agent_v2_wait_agent_returns_summary_for_mailbox_activity()
```

**Purpose**: Checks that v2 wait_agent reports a generic completion summary when mailbox mail arrives.

**Data flow**: It spawns a task, starts wait_agent, enqueues a mailbox message to root, and expects "Wait completed" without exposing message details.

**Call relations**: It exercises WaitAgentHandlerV2's mailbox notification path.

*Call graph*: calls 8 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, root, new); 9 external calls (new, default, new, default, assert_eq!, json!, from_str, spawn, yield_now).


##### `multi_agent_v2_wait_agent_returns_for_already_queued_mail`  (lines 3530–3608)

```
async fn multi_agent_v2_wait_agent_returns_for_already_queued_mail()
```

**Purpose**: Verifies that v2 wait_agent returns immediately when relevant mailbox mail is already queued.

**Data flow**: It spawns a worker, queues a worker-to-root message before calling wait_agent, and expects completion within a short wrapper timeout.

**Call relations**: It tests WaitAgentHandlerV2's check-before-wait behavior.

*Call graph*: calls 8 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, root, new); 9 external calls (new, from_millis, default, new, default, assert_eq!, json!, from_str, timeout).


##### `multi_agent_v2_wait_agent_wakes_on_any_mailbox_notification`  (lines 3611–3699)

```
async fn multi_agent_v2_wait_agent_wakes_on_any_mailbox_notification()
```

**Purpose**: Checks that v2 wait_agent wakes when any child sends mailbox mail, not only a particular target.

**Data flow**: It spawns two workers, starts wait_agent, sends mail from worker_b, and expects the wait to complete.

**Call relations**: It verifies targetless mailbox waiting across multiple spawned agents.

*Call graph*: calls 8 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, root, new); 9 external calls (new, default, new, default, assert_eq!, json!, from_str, spawn, yield_now).


##### `multi_agent_v2_wait_agent_does_not_return_completed_content`  (lines 3702–3788)

```
async fn multi_agent_v2_wait_agent_does_not_return_completed_content()
```

**Purpose**: Ensures v2 wait_agent does not leak child output content in its result. The wait tool only reports that something happened.

**Data flow**: It sends mailbox content containing sensitive text, waits, and asserts the result says "Wait completed" while the sensitive text is absent.

**Call relations**: It protects the output contract of WaitAgentHandlerV2.

*Call graph*: calls 8 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager, root, new); 10 external calls (new, default, new, default, assert!, assert_eq!, json!, from_str, spawn, yield_now).


##### `multi_agent_v2_interrupt_agent_accepts_task_name_target`  (lines 3791–3895)

```
async fn multi_agent_v2_interrupt_agent_accepts_task_name_target()
```

**Purpose**: Verifies that v2 interrupt_agent can target a spawned agent by task name and interrupts only that agent.

**Data flow**: It spawns `/root/worker`, spawns a child under it, interrupts `worker`, checks the previous status, confirms both agents remain resident, and verifies only the worker got Interrupt.

**Call relations**: It exercises InterruptAgentHandler's path resolution and non-cascading interrupt behavior.

*Call graph*: calls 6 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, set_turn_config, thread_manager); 7 external calls (new, default, assert!, assert_eq!, assert_ne!, json!, from_str).


##### `multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target`  (lines 3898–4005)

```
async fn multi_agent_v2_interrupt_agent_accepts_unloaded_task_name_target()
```

**Purpose**: Checks that v2 interrupt_agent accepts a task-name target even when that agent is no longer loaded in memory.

**Data flow**: It uses a SQLite-backed manager, spawns a worker, removes and shuts down the live thread, calls interrupt_agent by task name, then checks database edges and list_agents output.

**Call relations**: It tests InterruptAgentHandler with persisted metadata rather than only resident threads.

*Call graph*: calls 8 internal fn (make_session_and_context, with_models_provider_home_and_state_for_tests, expect_text_output, function_payload, invocation, set_turn_config, default_for_tests, from_api_key); 6 external calls (new, default, assert_eq!, init_state_db, json!, from_str).


##### `multi_agent_v2_interrupt_agent_rejects_root_target_and_id`  (lines 4008–4055)

```
async fn multi_agent_v2_interrupt_agent_rejects_root_target_and_id()
```

**Purpose**: Ensures v2 interrupt_agent cannot target the root agent, whether by `/root` path or by root thread ID.

**Data flow**: It enables v2, calls interrupt_agent twice against root, and expects "root is not a spawned agent" both times.

**Call relations**: It enforces a core safety rule in InterruptAgentHandler.

*Call graph*: calls 5 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager); 3 external calls (new, assert_eq!, json!).


##### `multi_agent_v2_interrupt_agent_rejects_self_target_by_id`  (lines 4058–4123)

```
async fn multi_agent_v2_interrupt_agent_rejects_self_target_by_id()
```

**Purpose**: Checks that an agent cannot interrupt itself by using its own thread ID.

**Data flow**: It creates a child context, calls interrupt_agent targeting that child's ID, and expects a message telling the agent to return its result instead.

**Call relations**: It tests InterruptAgentHandler's self-target guard for ID addressing.

*Call graph*: calls 6 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager, try_from); 6 external calls (new, SubAgent, assert_eq!, default, json!, vec!).


##### `multi_agent_v2_interrupt_agent_rejects_self_target_by_task_name`  (lines 4126–4191)

```
async fn multi_agent_v2_interrupt_agent_rejects_self_target_by_task_name()
```

**Purpose**: Checks that an agent cannot interrupt itself by using its own task path.

**Data flow**: It creates a child context, calls interrupt_agent targeting that child's path, and expects the same self-interrupt rejection.

**Call relations**: It tests InterruptAgentHandler's self-target guard for path addressing.

*Call graph*: calls 6 internal fn (make_session_and_context, function_payload, invocation, set_turn_config, thread_manager, try_from); 6 external calls (new, SubAgent, assert_eq!, default, json!, vec!).


##### `close_agent_submits_shutdown_and_returns_previous_status`  (lines 4194–4230)

```
async fn close_agent_submits_shutdown_and_returns_previous_status()
```

**Purpose**: Verifies that close_agent shuts down a live agent and reports what its status was before closing.

**Data flow**: It starts a thread, records its status, calls close_agent, parses the result, checks success, confirms a Shutdown operation was submitted, and verifies the status is now NotFound.

**Call relations**: It directly exercises CloseAgentHandler against the test thread manager.

*Call graph*: calls 5 internal fn (make_session_and_context, expect_text_output, function_payload, invocation, thread_manager); 4 external calls (new, assert_eq!, json!, from_str).


##### `tool_handlers_cascade_close_and_resume_and_keep_explicitly_closed_subtrees_closed`  (lines 4233–4438)

```
async fn tool_handlers_cascade_close_and_resume_and_keep_explicitly_closed_subtrees_closed()
```

**Purpose**: Tests a larger lifecycle story: closing a child closes its descendants, resuming the child brings that subtree back, and later resuming the parent does not reopen a subtree explicitly closed by the user.

**Data flow**: It builds a SQLite-backed manager, spawns parent-child-grandchild threads through handlers, closes and resumes the child subtree, closes it again, shuts down the parent, resumes the parent from another thread, and checks which agents are live.

**Call relations**: It ties together SpawnAgentHandler, CloseAgentHandler, ResumeAgentHandler, persistent thread-store state, and final manager shutdown.

*Call graph*: calls 10 internal fn (make_session_and_context, new, thread_store_from_config, expect_text_output, function_payload, invocation, parse_agent_id, default_for_tests, from_auth_for_testing, from_api_key); 9 external calls (new, from_secs, default, assert_eq!, assert_ne!, empty_extension_registry, init_state_db, json!, from_str).


##### `build_agent_spawn_config_uses_turn_context_values`  (lines 4441–4526)

```
async fn build_agent_spawn_config_uses_turn_context_values()
```

**Purpose**: Checks that the helper which builds a child spawn config copies the live turn context, not just the base config.

**Data flow**: It customizes base instructions, developer instructions, compact prompt, shell policy, cwd, sandbox executable, permission profile, and approval policy on a turn, builds the spawn config, and compares it to an expected config.

**Call relations**: It verifies build_agent_spawn_config, which SpawnAgentHandler relies on before creating child threads.

*Call graph*: calls 6 internal fn (make_session_and_context, default, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from); 3 external calls (from, assert_eq!, tempdir).


##### `build_agent_resume_config_clears_base_instructions`  (lines 4529–4564)

```
async fn build_agent_resume_config_clears_base_instructions()
```

**Purpose**: Checks that the helper for resuming an agent clears caller base instructions while preserving live runtime settings.

**Data flow**: It sets base instructions on the turn config, calls build_agent_resume_config, builds the expected config with base_instructions set to none and runtime values copied, and compares them.

**Call relations**: It verifies build_agent_resume_config, which ResumeAgentHandler uses when restoring agents.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (new, assert_eq!).


### `core/src/tools/handlers/request_plugin_install_tests.rs`

`test` · `test suite`

This is a test file for the code that asks a user whether Codex may install a suggested plugin or connector. A plugin is an add-on that gives Codex extra abilities, and a connector is a link to an outside service such as a calendar. The tests create temporary Codex home folders, like disposable fake user profiles, so they can safely write plugin and configuration files without touching a real machine.

The file checks three main ideas. First, a curated plugin install is not considered complete just because the marketplace lists it; the plugin must actually be installed. Second, remote plugin suggestions are treated differently: they should not go through the same local-installed check as normal curated plugins. Third, when a user declines an install request, Codex should only remember that choice permanently if the response says both “decline” and “always.”

The remaining tests focus on persistence. “Persistence” means saving a choice to disk so it survives future runs. These tests confirm that declining a connector or plugin writes the right entry into `config.toml`, and that messy existing entries are cleaned up: duplicates are removed, whitespace is trimmed, blank disabled tools are ignored, and unrelated discoverable tools are kept. The helper at the end builds a realistic connector object for those tests.

#### Function details

##### `verified_plugin_install_completed_requires_installed_plugin`  (lines 25–58)

```
async fn verified_plugin_install_completed_requires_installed_plugin()
```

**Purpose**: This test proves that Codex only treats a curated plugin install as complete after the plugin has actually been installed. It guards against a false success state where the plugin appears in the marketplace but is not yet available to use.

**Data flow**: It starts with a temporary Codex home folder, writes fake curated marketplace data for a plugin named `sample`, and loads the plugin configuration. Before installation, it asks whether `sample@openai-curated` is complete and expects `false`. Then it installs the plugin through `PluginsManager`, reloads the configuration, asks the same question again, and expects `true`.

**Call relations**: The async test runner calls this test. Inside the test, setup helpers create a curated marketplace and feature config, `PluginsManager::new` creates the plugin installer, and `install_plugin` performs the install. The assertions frame the important story: marketplace presence alone is not enough, but installation plus refreshed config is enough.

*Call graph*: calls 5 internal fn (new, curated_plugins_repo_path, write_curated_plugin_sha, write_plugins_feature_config, try_from); 4 external calls (assert!, load_plugins_config, write_openai_curated_marketplace, tempdir).


##### `remote_plugin_install_suggestions_skip_core_installed_verification`  (lines 61–69)

```
fn remote_plugin_install_suggestions_skip_core_installed_verification()
```

**Purpose**: This test checks how Codex recognizes remote plugin install suggestions. Remote plugins are not installed locally in the same way as core curated plugins, so they should skip the normal local installation verification.

**Data flow**: It feeds several plugin-like identifiers into the remote-suggestion checker. An identifier ending in `@openai-curated-remote` should return `true`, while a normal curated plugin and a plain plugin name should return `false`.

**Call relations**: The test runner calls this small unit test. It directly exercises the remote plugin detection helper and uses assertions to lock in the naming rule that later install-request code relies on.

*Call graph*: 1 external calls (assert!).


##### `request_plugin_install_response_persists_only_decline_always_mode`  (lines 72–105)

```
fn request_plugin_install_response_persists_only_decline_always_mode()
```

**Purpose**: This test makes sure Codex only saves a permanent “do not suggest this again” choice when the user both declines and chooses the “always” option. It prevents accidental permanent disabling from other responses.

**Data flow**: It builds several fake user responses. The first response is a decline with metadata saying `always`, and the checker should return `true`. The other responses change one important detail: accepting instead of declining, choosing `session` instead of `always`, or omitting metadata. Each of those should return `false`.

**Call relations**: The test runner calls this test, and the test calls the response-checking helper with carefully chosen `ElicitationResponse` values. The assertions document the contract for the higher-level request flow: only a very specific response should be written permanently.

*Call graph*: 1 external calls (assert!).


##### `persist_disabled_install_request_writes_connector_config`  (lines 108–126)

```
async fn persist_disabled_install_request_writes_connector_config()
```

**Purpose**: This test confirms that when a user permanently declines a connector install suggestion, Codex writes that connector into the disabled-tools section of the config file. This is what stops the same connector suggestion from coming back later.

**Data flow**: It creates a temporary Codex home folder and uses `connector_tool` to make a fake Google Calendar connector. It passes that connector to the persistence function, then reads `config.toml` back from disk, parses it, and compares it with the expected config: no discoverable tools and one disabled connector with the connector id.

**Call relations**: The async test runner calls this test. The test uses `connector_tool` to build realistic input, then hands it to `persist_disabled_install_request`, which is the behavior under test. Finally it reads and parses the written file to verify the disk output, not just an in-memory result.

*Call graph*: calls 1 internal fn (connector_tool); 4 external calls (assert_eq!, read_to_string, tempdir, from_str).


##### `persist_disabled_install_request_writes_plugin_config`  (lines 129–155)

```
async fn persist_disabled_install_request_writes_plugin_config()
```

**Purpose**: This test confirms that permanently declining a plugin install suggestion is saved as a disabled plugin in the user config. It protects the plugin path of the same “do not suggest this again” behavior tested for connectors.

**Data flow**: It creates a temporary Codex home folder and builds a fake discoverable plugin called `slack@openai-curated`. It asks the persistence function to save the decline, then reads and parses `config.toml`. The expected result is a tool suggestion config with one disabled plugin entry and no discoverable entries.

**Call relations**: The async test runner calls this test. The test constructs a `DiscoverableTool::Plugin`, passes it to `persist_disabled_install_request`, and then checks the file that function wrote. This complements the connector test by proving both supported tool kinds are saved correctly.

*Call graph*: 7 external calls (new, new, assert_eq!, read_to_string, tempdir, from_str, Plugin).


##### `persist_disabled_install_request_dedupes_existing_disabled_tools`  (lines 158–208)

```
async fn persist_disabled_install_request_dedupes_existing_disabled_tools()
```

**Purpose**: This test checks that saving a disabled tool cleans up the disabled-tools list instead of blindly adding another entry. It matters because real config files can contain duplicates, extra spaces, or broken blank entries.

**Data flow**: It creates a temporary config file that already contains one discoverable plugin, duplicate disabled connector entries, a blank connector entry, and a disabled plugin. Then it saves a permanent decline for the same connector. After reading and parsing the config, it expects a tidy result: the discoverable plugin is preserved, the connector appears only once with clean spacing, the blank entry is gone, and the existing disabled plugin remains.

**Call relations**: The async test runner calls this test. It uses `connector_tool` to create the input tool, writes a deliberately messy config file, and then calls `persist_disabled_install_request`. The final assertion shows the cleanup rules that the persistence code must follow when it updates existing user configuration.

*Call graph*: calls 1 internal fn (connector_tool); 5 external calls (assert_eq!, read_to_string, write, tempdir, from_str).


##### `connector_tool`  (lines 210–226)

```
fn connector_tool(id: &str, name: &str) -> DiscoverableTool
```

**Purpose**: This helper builds a realistic connector-shaped test object from a simple id and display name. It keeps the connector tests focused on the behavior they care about instead of repeating a long `AppInfo` setup block.

**Data flow**: It receives an id and name as text. It copies those into an `AppInfo` structure, fills the optional details with empty values, sets accessibility and enabled flags to fixed test values, wraps the result as a `DiscoverableTool::Connector`, and returns it.

**Call relations**: This helper is called by the connector persistence tests: `persist_disabled_install_request_writes_connector_config` and `persist_disabled_install_request_dedupes_existing_disabled_tools`. Those tests need a valid connector object before they can call the persistence function, and this helper supplies that object in a consistent way.

*Call graph*: called by 2 (persist_disabled_install_request_dedupes_existing_disabled_tools, persist_disabled_install_request_writes_connector_config); 3 external calls (new, new, Connector).


### `core/src/tools/handlers/request_user_input_spec_tests.rs`

`test` · `test run`

This is a test file for a tool that lets the system pause and ask the user one to three short questions. That matters because this tool is exposed through a schema, which is like a form describing exactly what information the tool accepts. If that form changes by accident, clients may send the wrong data or show the wrong user interface.

The tests check three main things. First, they verify that `create_request_user_input_tool` produces the expected tool definition, including fields such as question id, header, prompt text, answer options, and the optional `autoResolutionMs` timeout. Second, they check that timeout values are made safe: values below the allowed minimum are raised to the minimum, values above the maximum are lowered to the maximum, and exact boundary values are accepted. The tests also confirm that each question is marked so the client can add a free-form “Other” answer automatically.

Finally, the file checks mode rules. A feature flag can make the tool available in Default mode as well as Plan mode. These tests make sure the unavailable-message text and the user-facing tool description match that feature setting. In short, this file acts like a guardrail: it catches accidental changes to how the tool is described, when it can be used, and how its input is cleaned up.

#### Function details

##### `default_mode_enabled_available_modes`  (lines 12–16)

```
fn default_mode_enabled_available_modes() -> Vec<ModeKind>
```

**Purpose**: Builds the list of modes where `request_user_input` is available when the special Default-mode feature is turned on. Tests use it as a small setup helper so they do not repeat the same feature-flag code.

**Data flow**: It starts with the normal default feature set, turns on the `DefaultModeRequestUserInput` feature, then asks the shared availability logic for the resulting allowed modes. The output is a list of `ModeKind` values, such as Default and Plan.

**Call relations**: This helper calls the feature system’s default setup and then hands those features to `request_user_input_available_modes`. The mode-related tests use its result to compare behavior with the feature flag enabled.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (request_user_input_available_modes).


##### `default_available_modes`  (lines 18–20)

```
fn default_available_modes() -> Vec<ModeKind>
```

**Purpose**: Builds the normal list of modes where `request_user_input` is available without extra feature flags. Tests use it as the baseline case.

**Data flow**: It creates the default feature set and passes it to the shared availability function. The output is the list of modes allowed under ordinary settings.

**Call relations**: This helper calls the same availability function as the feature-enabled helper, but without changing any features first. Later tests use it when checking default unavailable messages and default description text.

*Call graph*: calls 1 internal fn (with_defaults); 1 external calls (request_user_input_available_modes).


##### `request_user_input_tool_includes_questions_schema`  (lines 23–114)

```
fn request_user_input_tool_includes_questions_schema()
```

**Purpose**: Checks that the tool definition for `request_user_input` contains the exact input schema expected by clients. This protects the contract between the tool and anything that calls or displays it.

**Data flow**: The test creates the tool specification with a simple description, then compares the whole result with a hand-written expected structure. The expected structure says the tool accepts a required `questions` array and an optional `autoResolutionMs` number, and describes the nested question and option fields.

**Call relations**: During the test run, Rust’s test runner calls this function. It uses `assert_eq!` to compare the produced tool specification with the expected one, so a mismatch immediately fails the test.

*Call graph*: 1 external calls (assert_eq!).


##### `normalize_request_user_input_args_clamps_out_of_range_auto_resolution_ms`  (lines 117–156)

```
fn normalize_request_user_input_args_clamps_out_of_range_auto_resolution_ms()
```

**Purpose**: Checks that too-small or too-large auto-resolution timeouts are corrected into the allowed range. This prevents callers from accidentally asking for an unreasonable wait time.

**Data flow**: The test builds sample request arguments with one question and a timeout just below the minimum. It expects normalization to raise that timeout to the minimum and mark the question as allowing an automatic “Other” option. Then it repeats the same idea with a timeout just above the maximum and expects it to be lowered to the maximum.

**Call relations**: The test runner calls this function as part of the suite. Inside, it uses vector construction for sample questions and `assert_eq!` to check that the normalization result is exactly what the tool promises.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `normalize_request_user_input_args_accepts_auto_resolution_boundaries`  (lines 159–198)

```
fn normalize_request_user_input_args_accepts_auto_resolution_boundaries()
```

**Purpose**: Checks that the minimum and maximum allowed timeout values are accepted as-is. This makes sure the safety limits are inclusive, not accidentally too strict.

**Data flow**: The test creates request arguments with the timeout set to the minimum allowed value and expects normalization to keep that value. It then creates another version with the maximum allowed value and expects that value to stay unchanged too, while also confirming the question is marked for the client-added “Other” option.

**Call relations**: The test runner calls this function during testing. It builds sample input data and relies on `assert_eq!` to prove that boundary values pass through normalization without being changed.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `request_user_input_unavailable_messages_respect_default_mode_feature_flag`  (lines 201–228)

```
fn request_user_input_unavailable_messages_respect_default_mode_feature_flag()
```

**Purpose**: Checks that the message explaining why `request_user_input` is unavailable matches the current mode and feature settings. This keeps user-facing error text honest.

**Data flow**: The test asks for unavailable messages in several modes. With default settings, Plan mode returns no message because it is allowed, while Default, Execute, and Pair Programming return clear unavailable messages. With the Default-mode feature enabled, Default mode also returns no message.

**Call relations**: The test runner invokes this function, and the function uses the two local mode-list helpers to set up the feature-off and feature-on cases. Each expected result is checked with `assert_eq!`.

*Call graph*: 1 external calls (assert_eq!).


##### `request_user_input_tool_description_mentions_available_modes`  (lines 231–240)

```
fn request_user_input_tool_description_mentions_available_modes()
```

**Purpose**: Checks that the tool’s description tells callers which modes can use it. This matters because the description is guidance shown to the model or client before the tool is called.

**Data flow**: The test first generates the description using the normal available-mode list and expects text saying the tool is only available in Plan mode. Then it generates the description with the Default-mode feature enabled and expects text saying it is available in Default or Plan mode.

**Call relations**: The Rust test runner calls this function. It depends on the two helper functions that produce available-mode lists, then uses `assert_eq!` to lock down the exact wording.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/tools/handlers/request_user_input_tests.rs`

`test` · `test run`

This test protects an important boundary in the multi-agent system. In this project, a main conversation can spawn sub-agents, which are helper threads that work under the root thread. The `request_user_input` tool is the mechanism that asks the human a question, such as choosing between options. Without this check, a background helper could unexpectedly prompt the user, which would be confusing and could break the intended flow of control.

The test builds a normal fake session and turn, then changes the turn so it looks like it came from a sub-agent rather than the root thread. It then calls `RequestUserInputHandler` with a realistic payload: one question with two choices. The important part is not the question itself, but who is asking it.

After running the handler, the test expects failure. More specifically, it expects an error that is meant to be sent back to the model, saying that `request_user_input` can only be used by the root thread. This confirms that the handler refuses sub-agent requests before they can reach the user. In everyday terms, this is like making sure only the lead operator can press the intercom button, not every assistant working in the back room.

#### Function details

##### `multi_agent_v2_request_user_input_rejects_subagent_threads`  (lines 15–68)

```
async fn multi_agent_v2_request_user_input_rejects_subagent_threads()
```

**Purpose**: This test checks that a sub-agent thread is not allowed to use `request_user_input`. It proves the handler returns a clear error instead of opening a user prompt from a non-root thread.

**Data flow**: The test starts with a fake session and turn, then rewrites the turn’s source so it represents a spawned sub-agent. It builds a tool invocation containing a sample multiple-choice question and passes it into `RequestUserInputHandler`. The expected result is not an answer from the user, but an error saying the tool can only be used by the root thread.

**Call relations**: The test uses `make_session_and_context` to create the starting session state, then constructs supporting objects such as a thread ID, cancellation token, diff tracker, tool name, and JSON payload. It calls the handler’s `handle` method as the real code would during a tool call, then checks the returned error with `assert_eq` to lock in the intended behavior.

*Call graph*: calls 4 internal fn (make_session_and_context, default, new, plain); 8 external calls (new, new, new, SubAgent, assert_eq!, json!, panic!, new).


### `core/src/tools/handlers/shell_spec_tests.rs`

`test` · `test run`

This is a test file, not production code. Its job is to make sure several tool definitions stay stable: `exec_command`, `write_stdin`, `request_permissions`, and `shell_command`. These tools are how the system tells an AI model or API client, “Here is a command you may call, here are the fields you can send, and here is what you will get back.” If these definitions drift by accident, callers could send the wrong field, miss a required field, or misunderstand what the tool does.

The tests build each tool using the real factory functions from the shell handler code. Then they build the expected tool description by hand, including each parameter’s plain-English description, which fields are required, whether extra fields are allowed, and whether an output schema is present. Finally, they compare the real and expected versions exactly.

A small amount of behavior depends on the operating system. On Windows, descriptions include PowerShell-specific guidance; on other systems, they use shorter Unix-like shell wording. One test also checks that the `shell` parameter can be hidden when requested. In everyday terms, this file is a checklist that makes sure the public “instruction card” for each shell tool says exactly what the rest of the system promises it says.

#### Function details

##### `windows_shell_guidance_description`  (lines 5–7)

```
fn windows_shell_guidance_description() -> String
```

**Purpose**: Builds the Windows-specific extra guidance text used in expected tool descriptions. It wraps the shared Windows shell guidance with blank lines so the final description matches the production formatting.

**Data flow**: It takes no input directly. It reads the shared Windows shell guidance text from the surrounding module, prefixes it with two newline characters, and returns the combined string.

**Call relations**: The Windows branch of `shell_command_tool_matches_expected_spec` calls this helper when it needs to construct the exact expected description for the PowerShell command tool. The helper delegates the actual guidance content to `windows_shell_guidance` and only adds the formatting around it.

*Call graph*: called by 1 (shell_command_tool_matches_expected_spec); 1 external calls (format!).


##### `has_parameter`  (lines 9–14)

```
fn has_parameter(tool: &ToolSpec, parameter_name: &str) -> bool
```

**Purpose**: Checks whether a generated tool specification includes a named input parameter. This lets tests ask a simple yes-or-no question without manually digging through the nested schema structure.

**Data flow**: It receives a `ToolSpec` and a parameter name. It converts the whole tool specification into JSON, looks under `parameters.properties.<parameter name>`, and returns `true` if that entry exists or `false` if it does not.

**Call relations**: This is a small test helper for checking the shape of a tool specification. It uses JSON serialization as a convenient way to inspect the nested parameter map, then hands back a boolean result that assertions can use.

*Call graph*: 2 external calls (format!, to_value).


##### `exec_command_tool_matches_expected_spec`  (lines 17–96)

```
fn exec_command_tool_matches_expected_spec()
```

**Purpose**: Verifies that the `exec_command` tool is advertised exactly as expected. This matters because `exec_command` is the lower-level command runner, including options for working directory, shell choice, terminal behavior, output limits, and login-shell behavior.

**Data flow**: The test asks the real code to create an `exec_command` tool with login shells allowed and permission approvals disabled. It then builds the expected description, parameter schema, required fields, and output schema by hand. The final assertion compares the real tool and expected tool, and the test fails if any part differs.

**Call relations**: During the test run, this function exercises the production tool-building path for `exec_command`. It uses schema helpers such as string, number, and boolean schema builders, adds approval-related parameters, accounts for Windows-specific description text with a platform check, and then uses an exact equality assertion as the contract check.

*Call graph*: calls 3 internal fn (boolean, number, string); 4 external calls (from, assert_eq!, cfg!, format!).


##### `exec_command_tool_can_hide_shell_parameter`  (lines 99–111)

```
fn exec_command_tool_can_hide_shell_parameter()
```

**Purpose**: Checks that the `exec_command` tool can be created without exposing the `shell` input parameter. This is useful when the system wants callers to run commands but not choose the shell binary themselves.

**Data flow**: The test creates an `exec_command` tool with environment IDs and the shell parameter both excluded. It then inspects the resulting tool schema: `shell` should be absent, while the basic `cmd` parameter should still be present.

**Call relations**: This test focuses on one configurable part of the `exec_command` tool factory. After creating the tool with the relevant flags, it relies on boolean assertions to confirm that hiding `shell` does not remove the core command input.

*Call graph*: 1 external calls (assert!).


##### `write_stdin_tool_matches_expected_spec`  (lines 114–161)

```
fn write_stdin_tool_matches_expected_spec()
```

**Purpose**: Verifies that the `write_stdin` tool has the exact expected public shape. This tool is used to send text into an already-running command session and then read back recent output.

**Data flow**: The test creates the real `write_stdin` tool. It separately builds the expected parameter schema, including the required session identifier plus optional characters to write, wait time, and output budget. It compares the real and expected tool specifications exactly.

**Call relations**: This test runs as part of the tool contract suite. It uses schema-building helpers to describe each allowed input, then passes the completed expected schema into an equality assertion against the production result.

*Call graph*: calls 2 internal fn (number, string); 2 external calls (from, assert_eq!).


##### `request_permissions_tool_includes_full_permission_schema`  (lines 164–200)

```
fn request_permissions_tool_includes_full_permission_schema()
```

**Purpose**: Confirms that the `request_permissions` tool includes the complete permission request schema. This matters because callers need a reliable way to ask for extra rights, such as broader file or command access, during a turn.

**Data flow**: The test creates the real permission-request tool with a chosen description. It builds the expected schema with an optional reason, an optional environment identifier, and the required permissions object. It then checks that the generated tool exactly matches that expected structure and has no output schema.

**Call relations**: This test exercises the production permission-tool builder. It pulls in the shared permission profile schema for the important `permissions` field, then uses an exact equality assertion to make sure the full permission shape is exposed.

*Call graph*: calls 1 internal fn (string); 2 external calls (from, assert_eq!).


##### `shell_command_tool_matches_expected_spec`  (lines 203–274)

```
fn shell_command_tool_matches_expected_spec()
```

**Purpose**: Verifies that the higher-level `shell_command` tool is described exactly as expected. This tool runs a shell command and returns its output, so its public instructions must be especially clear about command text, working directory, timeout, and login-shell behavior.

**Data flow**: The test creates the real `shell_command` tool with login shells allowed and permission approvals disabled. It builds the expected description differently depending on the operating system: Windows gets PowerShell examples and extra guidance, while other systems get a shorter shell-command description. It then constructs the expected parameter schema and compares the whole tool specification with the real one.

**Call relations**: This test is part of the same contract-checking suite as the other tool spec tests. On Windows it calls `windows_shell_guidance_description` to include the shared extra guidance. It also uses schema helpers and approval-parameter helpers before handing the completed expected object to an exact equality assertion.

*Call graph*: calls 4 internal fn (windows_shell_guidance_description, boolean, number, string); 3 external calls (from, assert_eq!, cfg!).


### `core/src/tools/handlers/shell_tests.rs`

`test` · `test suite`

This is a test file, not production code. Its job is to protect the shell-command pathway from subtle mistakes. When the system is asked to run a command like `echo hello`, it does not run that text directly. It first chooses the user’s shell, builds the right command-line arguments, chooses a working folder, prepares environment variables, applies sandbox permissions, and may also notify hook code before or after the command runs. A small mismatch in any of that could make commands run in the wrong place, with the wrong permissions, or in a form that safety checks no longer recognize.

The tests here act like a checklist. They verify that commands produced for Bash, Zsh, and PowerShell still look safe to the command-safety detector when the original command is safe. They check that `ShellCommandHandler` uses the current session and turn context, which are the pieces of state that say what shell to use, where relative paths point, what network access is allowed, and what environment variables should exist. They also test the rule for login shells: a login shell is a shell started as if the user just logged in, which can load extra startup files. That is allowed only when configuration permits it. Finally, the file checks that pre-use and post-use hook messages contain the raw command and the intended output value, so outside hook systems see the same clean information the user requested.

#### Function details

##### `commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command`  (lines 30–58)

```
fn commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command()
```

**Purpose**: This test makes sure the command strings built for different shells can still be recognized by the safety checker when the original command is harmless. It matters because the handler wraps commands in shell-specific ways, and that wrapping must not confuse the safety logic.

**Data flow**: It starts with a few shell descriptions, such as Bash and Zsh, and uses PowerShell variants too if they are installed on the machine running the test. For each available shell, it sends a simple directory-listing command into the helper check. The result is not a returned value, but a set of assertions that must pass: both login-shell and non-login-shell forms must be considered known safe.

**Call relations**: This is the top-level test for safe-command recognition. It calls `assert_safe` to do the repeated check for each shell, and it asks the PowerShell lookup helpers whether PowerShell executables are available before testing those cases.

*Call graph*: calls 3 internal fn (assert_safe, try_find_powershell_executable_blocking, try_find_pwsh_executable_blocking); 1 external calls (from).


##### `assert_safe`  (lines 60–67)

```
fn assert_safe(shell: &Shell, command: &str)
```

**Purpose**: This helper avoids repeating the same safety check for every shell. Given a shell and a command, it confirms that the shell-wrapped version is still accepted by the known-safe-command detector.

**Data flow**: It receives a shell description and a raw command string. It asks the shell to turn that command into executable arguments twice: once as a login shell and once as a non-login shell. Each argument list is then fed into the safety checker, and the function succeeds only if both checks pass.

**Call relations**: It is called by `commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command` whenever that test wants to validate another shell. It sits between shell command construction and the safety-checking function, making sure those two parts agree.

*Call graph*: called by 1 (commands_generated_by_shell_command_handler_can_be_matched_by_is_known_safe_command); 1 external calls (assert!).


##### `shell_command_handler_to_exec_params_uses_session_shell_and_turn_context`  (lines 70–119)

```
async fn shell_command_handler_to_exec_params_uses_session_shell_and_turn_context()
```

**Purpose**: This test checks that a shell command request is translated into execution settings using the current session and turn context. In plain terms, it verifies that the handler uses the right shell, folder, environment, timeout, network setting, sandbox permission, and justification.

**Data flow**: It creates a fake session and turn context, then builds a shell command request with a command, relative working directory, timeout, sandbox setting, and justification text. It independently calculates what the command arguments, working directory, and environment should be. Then it asks `ShellCommandHandler::to_exec_params` to build the real execution parameters and compares each important field to the expected value.

**Call relations**: This test uses `make_session_and_context` to get realistic test state, `create_env` to compute the expected environment, and `ShellCommandHandler::to_exec_params` as the behavior under test. It proves that the handler correctly combines user input with session-level and turn-level settings before a command would be run.

*Call graph*: calls 3 internal fn (create_env, make_session_and_context, to_exec_params); 1 external calls (assert_eq!).


##### `shell_command_handler_respects_explicit_login_flag`  (lines 122–147)

```
fn shell_command_handler_respects_explicit_login_flag()
```

**Purpose**: This test verifies that when code explicitly asks for a login shell or a non-login shell, the handler follows that choice. This matters because login shells can load extra user startup configuration, so the distinction is intentional.

**Data flow**: It creates a Bash shell description and asks `ShellCommandHandler::base_command` to build one command with login-shell mode enabled and another with it disabled. For each case, it compares the handler’s result to the shell’s own expected argument-building method. The output is a pair of passing assertions showing that the requested mode was preserved.

**Call relations**: This test focuses on `ShellCommandHandler::base_command`. It compares that function against the shell’s lower-level command-building behavior, so it confirms the handler is not silently changing the caller’s login-shell choice.

*Call graph*: calls 1 internal fn (base_command); 2 external calls (from, assert_eq!).


##### `shell_command_handler_defaults_to_non_login_when_disallowed`  (lines 150–178)

```
async fn shell_command_handler_defaults_to_non_login_when_disallowed()
```

**Purpose**: This test checks the safe default when login shells are disabled by configuration. If the request does not explicitly ask for a login shell, the handler should still run the command, but as a non-login shell.

**Data flow**: It creates a test session and turn context, then builds a command request with no explicit login preference. It calls `ShellCommandHandler::to_exec_params` while telling it login shells are not allowed. The resulting executable command is compared with the session shell’s non-login form of the same raw command.

**Call relations**: This test uses `make_session_and_context` to supply realistic state and then exercises `ShellCommandHandler::to_exec_params`. It complements the rejection test by showing that disabling login shells does not block ordinary shell commands.

*Call graph*: calls 2 internal fn (make_session_and_context, to_exec_params); 1 external calls (assert_eq!).


##### `shell_command_handler_rejects_login_when_disallowed`  (lines 181–191)

```
fn shell_command_handler_rejects_login_when_disallowed()
```

**Purpose**: This test makes sure the handler refuses an explicit request for a login shell when configuration has disabled login shells. It protects the configuration rule from being bypassed.

**Data flow**: It calls `ShellCommandHandler::resolve_use_login_shell` with an explicit request for login-shell mode while login shells are not allowed. Instead of a normal result, it expects an error. The test then checks that the error message explains that login shells are disabled by configuration.

**Call relations**: This test goes directly to the decision function, `ShellCommandHandler::resolve_use_login_shell`, rather than building full execution parameters. It verifies the rule at the point where the handler decides whether login-shell mode may be used.

*Call graph*: calls 1 internal fn (resolve_use_login_shell); 1 external calls (assert!).


##### `shell_command_pre_tool_use_payload_uses_raw_command`  (lines 194–217)

```
async fn shell_command_pre_tool_use_payload_uses_raw_command()
```

**Purpose**: This test checks the message sent to pre-use hooks before a shell command runs. It makes sure the hook receives the raw command text the user requested, not a shell-wrapped version.

**Data flow**: It builds a tool payload containing a command string, creates a test session and turn context, and constructs a shell command handler. It then creates a tool invocation and asks the handler for its pre-tool-use payload. The expected result is a hook payload named like the Bash hook, with JSON input containing exactly the original command.

**Call relations**: This test uses `make_session_and_context` to build the invocation context and `ShellCommandHandler::from` to create the handler. It then exercises the handler’s pre-use hook payload method, confirming that hook systems get clear user-facing command input before execution.

*Call graph*: calls 2 internal fn (make_session_and_context, from); 2 external calls (assert_eq!, json!).


##### `build_post_tool_use_payload_uses_tool_output_wire_value`  (lines 220–250)

```
async fn build_post_tool_use_payload_uses_tool_output_wire_value()
```

**Purpose**: This test checks the message sent to post-use hooks after a shell command finishes. It verifies that the hook receives the tool output value meant for the wire format, which is the serialized value other parts of the system expect to see.

**Data flow**: It builds a command payload and a fake successful tool output whose post-use response is the JSON string `shell output`. It then creates a handler, session, turn context, and tool invocation. When it asks for the post-tool-use payload, it expects a payload containing the hook name, the original call ID, the raw command as input, and the chosen output value as the response.

**Call relations**: This test sets up a full `ToolInvocation` and calls the handler’s post-use hook payload method. It shows how the shell command handler connects the original tool call with the final output value so hook code can observe what happened after execution.

*Call graph*: calls 4 internal fn (make_session_and_context, from, new, plain); 6 external calls (new, new, assert_eq!, json!, new, vec!).


### `core/src/tools/handlers/unified_exec_tests.rs`

`test` · `test run`

This is a test file, not production code. Its job is to prove that the unified exec handler behaves correctly in common and risky situations. The exec tool is the part of the system that turns a requested command, such as `echo hello`, into the actual shell invocation that will run on the machine. These tests check that it uses the user’s default shell when no shell is named, respects explicit shells like Bash, PowerShell, or Windows `cmd`, and refuses options that are not allowed by configuration, such as a login shell when login shells are disabled.

The file also tests a special local execution mode called `zsh-fork`, where commands must go through a controlled zsh-based path. In that mode, asking for a different shell is rejected. Remote environments are treated differently: even if local execution would use `zsh-fork`, remote execution falls back to direct mode.

The second half checks hook payloads. A hook is a callback-like notification that lets other parts of the system see what command is about to run or what result came back. These tests make sure hooks receive the raw command before execution, receive completed output afterward, skip still-running interactive sessions, and keep parallel session metadata separate so one command’s output is not mistaken for another’s.

#### Function details

##### `invocation_for_payload`  (lines 24–40)

```
async fn invocation_for_payload(
    tool_name: &str,
    call_id: &str,
    payload: ToolPayload,
) -> ToolInvocation
```

**Purpose**: This helper builds a realistic tool invocation for tests. It saves the tests from repeating all the session, turn, cancellation, tracking, tool name, and payload setup every time they need to call a handler.

**Data flow**: It takes a tool name, a call id, and a tool payload. It creates a fresh test session and turn, adds a new cancellation token, a new diff tracker protected by a mutex (a lock that prevents overlapping access), and wraps the tool name in the project’s tool-name type. It returns a complete `ToolInvocation` that looks like one the real system would pass to a tool handler.

**Call relations**: Several post-tool-use tests call this helper before asking `ExecCommandHandler` or `WriteStdinHandler` to build hook output. It relies on `make_session_and_context` to supply a valid test session and uses small constructors such as `plain` and `new` to fill in the invocation fields.

*Call graph*: calls 3 internal fn (make_session_and_context, new, plain); called by 5 (exec_command_post_tool_use_payload_skips_running_sessions, exec_command_post_tool_use_payload_uses_output_for_interactive_completion, exec_command_post_tool_use_payload_uses_output_for_noninteractive_one_shot_commands, write_stdin_post_tool_use_payload_keeps_parallel_session_metadata_separate, write_stdin_post_tool_use_payload_uses_original_exec_call_id_and_command_on_completion); 3 external calls (new, new, new).


##### `test_get_command_uses_default_shell_when_unspecified`  (lines 43–62)

```
fn test_get_command_uses_default_shell_when_unspecified() -> anyhow::Result<()>
```

**Purpose**: This test proves that a command without a `shell` field still gets wrapped in a usable shell command. Without this behavior, a simple request like `echo hello` might not run consistently.

**Data flow**: It starts with JSON containing only `cmd`. After parsing, it checks that no explicit shell was supplied. It then resolves the command using the default user shell and direct execution mode, and confirms that the final command array contains the original text `echo hello` in the expected shell-command position.

**Call relations**: During the test run, this function calls `default_user_shell` and creates shared shell data before checking the result with assertions. It exercises the command-building path used when callers leave shell choice to the system.

*Call graph*: calls 1 internal fn (default_user_shell); 3 external calls (new, assert!, assert_eq!).


##### `test_get_command_respects_explicit_bash_shell`  (lines 65–89)

```
fn test_get_command_respects_explicit_bash_shell() -> anyhow::Result<()>
```

**Purpose**: This test checks that when the caller asks for Bash explicitly, the command builder honors that request. It also guards against accidentally dropping the user’s command while adding shell-specific flags.

**Data flow**: It feeds in JSON with `cmd` and `shell` set to `/bin/bash`. After parsing, it verifies that the shell value survived parsing, resolves the command, and checks that the final command still ends with `echo hello`. If the produced command looks like a PowerShell command, it also checks that the no-profile flag is present.

**Call relations**: This test uses the default shell only as background context while focusing on an explicit shell request. Its assertions confirm that the command-building logic keeps the caller’s requested shell and command aligned.

*Call graph*: calls 1 internal fn (default_user_shell); 3 external calls (new, assert!, assert_eq!).


##### `test_get_command_respects_explicit_powershell_shell`  (lines 92–125)

```
fn test_get_command_respects_explicit_powershell_shell() -> anyhow::Result<()>
```

**Purpose**: This test makes sure an explicit PowerShell executable is recognized as PowerShell, even when it is given as a path. That matters because PowerShell needs different command-line wrapping than Unix-style shells.

**Data flow**: It creates a temporary fake PowerShell file, using a platform-appropriate name, then places that path into the JSON arguments. After parsing and command resolution, it checks that the shell path was preserved, the command text appears in the shell invocation, and the detected shell type is `PowerShell`.

**Call relations**: The test uses temporary file creation to make shell detection realistic without depending on a real system PowerShell location. It calls the same command-resolution path as production code, then uses assertions to verify the shell classification.

*Call graph*: calls 1 internal fn (default_user_shell); 6 external calls (new, assert_eq!, cfg!, json!, write, tempdir).


##### `test_get_command_respects_explicit_cmd_shell`  (lines 128–146)

```
fn test_get_command_respects_explicit_cmd_shell() -> anyhow::Result<()>
```

**Purpose**: This test checks support for Windows `cmd` as an explicitly requested shell. It protects the command builder from treating `cmd` like an unknown or unsupported shell name.

**Data flow**: It parses JSON containing `cmd` and `shell: cmd`, verifies that the parsed shell is exactly `cmd`, resolves the command, and confirms that the requested command text appears in the resulting shell command array.

**Call relations**: The test supplies the default user shell as context but expects the explicit `cmd` choice to take priority. Its assertions pin down the behavior for callers who request the Windows command shell by name.

*Call graph*: calls 1 internal fn (default_user_shell); 2 external calls (new, assert_eq!).


##### `test_get_command_rejects_explicit_login_when_disallowed`  (lines 149–166)

```
fn test_get_command_rejects_explicit_login_when_disallowed() -> anyhow::Result<()>
```

**Purpose**: This test confirms that the command builder refuses a login shell request when configuration says login shells are disabled. A login shell can load extra startup files, so allowing it accidentally could change behavior or bypass policy.

**Data flow**: It parses JSON where `login` is set to true, then asks for command resolution with `allow_login_shell` set to false. Instead of a command, it expects an error message saying that login shells are disabled by config.

**Call relations**: This function exercises the failure branch of command resolution. It uses the default shell setup, then checks with an assertion that the rejection is clear and specific.

*Call graph*: calls 1 internal fn (default_user_shell); 2 external calls (new, assert!).


##### `test_get_command_rejects_explicit_shell_in_zsh_fork_mode`  (lines 169–199)

```
fn test_get_command_rejects_explicit_shell_in_zsh_fork_mode() -> anyhow::Result<()>
```

**Purpose**: This test makes sure callers cannot choose their own shell when local execution is configured for `zsh-fork` mode. In that mode, the system needs to use its controlled zsh path, so an explicit shell would conflict with the execution design.

**Data flow**: It parses a command that asks for `/bin/bash`, builds a `zsh-fork` shell-mode configuration with absolute paths for zsh and the exec wrapper, and tries to resolve the command. The expected output is an error explaining that `shell` is not supported for local zsh-fork execution.

**Call relations**: The test constructs the special shell mode using absolute-path helpers and the `ZshFork` configuration. It then verifies that command resolution rejects the incompatible explicit shell instead of silently ignoring or honoring it.

*Call graph*: calls 2 internal fn (default_user_shell, from_absolute_path); 4 external calls (new, assert!, cfg!, ZshFork).


##### `shell_mode_for_environment_uses_direct_mode_for_remote_environments`  (lines 202–231)

```
async fn shell_mode_for_environment_uses_direct_mode_for_remote_environments() -> anyhow::Result<()>
```

**Purpose**: This test checks that `zsh-fork` mode is used only for local environments, while remote environments use direct execution mode. That avoids trying to apply a local shell-wrapper setup to a remote exec server that may not have it.

**Data flow**: It builds a `zsh-fork` shell-mode configuration, then creates one local test environment and one remote test environment with a remote exec server URL. It asks which shell mode should apply to each environment. The local environment keeps `zsh-fork`; the remote environment becomes `Direct`.

**Call relations**: This async test uses environment test constructors and absolute-path helpers, then compares the selected shell modes with assertions. It documents the handoff point where environment type changes execution strategy.

*Call graph*: calls 3 internal fn (create_for_tests, default_for_tests, from_absolute_path); 3 external calls (assert_eq!, cfg!, ZshFork).


##### `exec_command_pre_tool_use_payload_uses_raw_command`  (lines 234–257)

```
async fn exec_command_pre_tool_use_payload_uses_raw_command()
```

**Purpose**: This test proves that before an exec command runs, the hook payload contains the user’s raw command text. That lets hook consumers inspect the actual requested command, not a rewritten shell wrapper.

**Data flow**: It creates a function-style tool payload with `cmd: printf exec command`, builds a test session and turn, and asks the default exec command handler for its pre-tool-use payload. The expected result is a Bash-named hook payload whose input is `{ "command": "printf exec command" }`.

**Call relations**: The test builds the invocation inline using `make_session_and_context`, then calls `ExecCommandHandler`’s pre-hook method. The assertion shows what information is handed to the hook system before command execution begins.

*Call graph*: calls 2 internal fn (make_session_and_context, default); 2 external calls (assert_eq!, json!).


##### `exec_command_pre_tool_use_payload_skips_write_stdin`  (lines 260–280)

```
async fn exec_command_pre_tool_use_payload_skips_write_stdin()
```

**Purpose**: This test confirms that `write_stdin` does not produce a pre-use hook payload. Writing characters into an already-running process is not the same as starting a new shell command, so there is no new raw command to announce.

**Data flow**: It creates a payload containing `chars`, builds a `write_stdin` invocation, and asks `WriteStdinHandler` for a pre-tool-use payload. The expected result is `None`, meaning no hook notification is produced before the write.

**Call relations**: The test uses `make_session_and_context` to form a realistic invocation, then checks that the write-stdin handler stays quiet at the pre-hook stage. This keeps hook behavior focused on command starts rather than every input write.

*Call graph*: calls 1 internal fn (make_session_and_context); 2 external calls (assert_eq!, json!).


##### `exec_command_post_tool_use_payload_uses_output_for_noninteractive_one_shot_commands`  (lines 283–310)

```
async fn exec_command_post_tool_use_payload_uses_output_for_noninteractive_one_shot_commands()
```

**Purpose**: This test checks that a completed non-interactive command produces a post-use hook payload containing its output. A one-shot command is expected to finish immediately, so its result can be reported to hook consumers.

**Data flow**: It creates an exec payload for `echo three` with `tty` set to false, then creates a fake completed output object with raw bytes `three`, exit code 0, and the original hook command. After building a realistic invocation, it asks the exec handler for a post-tool-use payload. The result includes the original command and the text output `three`.

**Call relations**: This test calls `invocation_for_payload` to prepare the invocation, then hands both invocation and output to `ExecCommandHandler`. The assertion confirms that completed command output flows into the hook response.

*Call graph*: calls 2 internal fn (default, invocation_for_payload); 3 external calls (assert_eq!, json!, from_millis).


##### `exec_command_post_tool_use_payload_uses_output_for_interactive_completion`  (lines 313–341)

```
async fn exec_command_post_tool_use_payload_uses_output_for_interactive_completion()
```

**Purpose**: This test verifies that an interactive command also produces a post-use hook payload once it has completed. Interactive mode may keep a process open, but when there is an exit code and no running process id, the result should be reportable.

**Data flow**: It builds an exec payload for `echo three` with `tty` set to true, then supplies fake output showing the command has finished: raw bytes `three`, exit code 0, and no process id. The handler turns that into a hook payload with the command and output text.

**Call relations**: Like the non-interactive test, it uses `invocation_for_payload` and the default exec handler. It covers the completion path for interactive commands, proving that interactivity alone does not suppress hook reporting.

*Call graph*: calls 2 internal fn (default, invocation_for_payload); 3 external calls (assert_eq!, json!, from_millis).


##### `exec_command_post_tool_use_payload_skips_running_sessions`  (lines 344–363)

```
async fn exec_command_post_tool_use_payload_skips_running_sessions()
```

**Purpose**: This test makes sure the exec handler does not send a final post-use hook payload while an interactive session is still running. Reporting too early would make partial output look like the command’s final result.

**Data flow**: It creates an exec payload and a fake output object where `process_id` is present and `exit_code` is missing. That combination means the process is still alive. When passed to the handler, the result is `None`, so no completion hook is emitted.

**Call relations**: The test gets a realistic invocation from `invocation_for_payload`, then checks the default exec handler’s decision. It protects the larger flow from confusing in-progress session output with completed command output.

*Call graph*: calls 2 internal fn (default, invocation_for_payload); 3 external calls (assert_eq!, json!, from_millis).


##### `write_stdin_post_tool_use_payload_uses_original_exec_call_id_and_command_on_completion`  (lines 366–398)

```
async fn write_stdin_post_tool_use_payload_uses_original_exec_call_id_and_command_on_completion()
```

**Purpose**: This test checks that when `write_stdin` causes or observes an interactive command finishing, the post-use hook is tied back to the original exec command, not to the later stdin-write call. This keeps hook records attached to the command that actually ran.

**Data flow**: It builds a `write_stdin` payload for a session, then supplies completed output whose event call id is `exec-call-45` and whose hook command is `sleep 1; echo finished`. The write-stdin handler returns a post-use payload using that original exec call id, the original command, and the finished output text.

**Call relations**: The test uses `invocation_for_payload` to represent the stdin write, then calls `WriteStdinHandler`’s post-hook method. It confirms that completion information is handed off under the original exec call identity.

*Call graph*: calls 1 internal fn (invocation_for_payload); 3 external calls (assert_eq!, json!, from_millis).


##### `write_stdin_post_tool_use_payload_keeps_parallel_session_metadata_separate`  (lines 401–455)

```
async fn write_stdin_post_tool_use_payload_keeps_parallel_session_metadata_separate()
```

**Purpose**: This test protects against mixing up metadata from two parallel interactive sessions. If two commands finish around the same time, each hook payload must keep its own command, call id, and output.

**Data flow**: It creates one shared write-stdin-style payload and two separate completed outputs: one for an `alpha` command and one for a `beta` command. It builds separate invocations and asks the handler for post-use payloads in beta-then-alpha order. The returned payloads preserve each output’s own exec call id, command text, and response text.

**Call relations**: This test calls `invocation_for_payload` twice and then uses `WriteStdinHandler` for both outputs. The final assertion shows that the handler follows the metadata carried by each output rather than relying on shared or stale session state.

*Call graph*: calls 1 internal fn (invocation_for_payload); 3 external calls (assert_eq!, json!, from_millis).


### `core/src/tools/hosted_spec_tests.rs`

`test` · `test run`

This is a test file. Its job is to make sure the code that creates tool specifications keeps producing the exact shapes the rest of the system expects. A tool specification is a structured description of a capability, such as “generate an image as PNG” or “search the web with these limits.” If these descriptions are wrong, the external service receiving them may misunderstand what the app wants, ignore important settings, or enable a tool that should be off.

The tests cover three important promises. First, when the project asks for an image generation tool with a given output format, that format is preserved. Second, when web search is enabled with detailed options, those options are carried through: allowed domains, approximate user location, search context size, and whether the search should include text and images. Third, when web search is disabled, no web search tool is produced at all.

You can think of these tests like checking a shipping label before a package leaves the warehouse. The package may contain complex instructions, but the test only cares that the label says exactly what it should say.

#### Function details

##### `image_generation_tool_matches_expected_spec`  (lines 11–18)

```
fn image_generation_tool_matches_expected_spec()
```

**Purpose**: This test makes sure that creating an image generation tool keeps the requested image format. It protects against accidentally changing the tool description sent for image generation.

**Data flow**: It starts with the input format "png". The test asks the tool-building code to create an image generation specification, then compares the result with the expected specification that contains the same "png" format. Nothing is changed outside the test; it either passes or fails.

**Call relations**: During the test run, the test framework calls this function. Inside it, the generated tool specification is checked with an equality assertion so any mismatch is reported immediately.

*Call graph*: 1 external calls (assert_eq!).


##### `web_search_tool_preserves_configured_options`  (lines 21–56)

```
fn web_search_tool_preserves_configured_options()
```

**Purpose**: This test makes sure that web search settings are not lost or altered when the web search tool specification is created. It verifies the enabled mode, allowed domain filter, user location, context size, and requested content types.

**Data flow**: It builds a set of web search options: live search is enabled, only example.com is allowed, the user location is approximately in the US with a Los Angeles time zone, the search context size is low, and both text and image search are requested. The tool-building code turns those options into a web search specification. The test compares that output with the exact expected structure.

**Call relations**: The test framework calls this during the test suite. The function relies on an equality assertion to confirm that the tool builder passes configuration through to the final API-facing shape without dropping or rewriting important fields.

*Call graph*: 1 external calls (assert_eq!).


##### `web_search_tool_is_absent_when_disabled`  (lines 59–68)

```
fn web_search_tool_is_absent_when_disabled()
```

**Purpose**: This test confirms that disabling web search really removes the web search tool. It prevents a serious mistake where web access could remain available even after configuration says it should be off.

**Data flow**: It starts with web search options where the mode is set to disabled and no extra web search configuration is supplied. The tool-building code is asked to create a web search tool. The expected result is no tool at all, represented by `None`, and the test checks for that result.

**Call relations**: The test framework runs this function as part of the test suite. It uses an equality assertion to verify that the disabled setting stops the web search tool from being produced.

*Call graph*: 1 external calls (assert_eq!).


### Routing, registry, and tool exposure
This group moves from tool result shaping into registry dispatch, router behavior, and the planning logic that determines which tools are exposed.

### `core/src/tools/context_tests.rs`

`test` · `test run`

This is a test file for the tool-output layer. In this project, tools can be ordinary function calls, custom tools, command execution, MCP tools (tools reached through the Model Context Protocol, a standard way for models to call outside tools), or tool-search results. Each of those produces output in a slightly different shape, and that output must be converted back into response items the model can read.

The tests act like a checklist at the border between internal tool code and the outside conversation format. They create small fake outputs, convert them into response items, and then check that the result has the right kind, call id, success flag, text body, images, JSON content, and truncation notice. This matters because a small formatting mistake could make the model see the wrong result, lose an image, miss an error, or receive an output that is too large.

A recurring theme is choosing the right representation. Plain text should stay plain text. Content items, such as text plus images, should not be flattened in a way that loses the image. MCP results should include useful timing information for normal conversation mode, but code-mode results should stay as raw structured JSON. Large outputs are shortened with a clear notice, like a receipt that says some pages were omitted.

#### Function details

##### `custom_tool_calls_should_roundtrip_as_custom_outputs`  (lines 9–27)

```
fn custom_tool_calls_should_roundtrip_as_custom_outputs()
```

**Purpose**: This test makes sure a result from a custom tool comes back as a custom-tool output, not as an ordinary function output. It protects the distinction between different tool families.

**Data flow**: It starts with a custom-tool payload and a text result saying "patched" with success set to true. The result is converted into a response item. The test then checks that the response still has the same call id, carries the text body, has no separate content items, and keeps the success value.

**Call relations**: During the test run, the Rust test harness calls this test. The test uses the normal text-output constructor and then exercises the response conversion path, with assertions acting as the guardrails for the expected shape.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (assert_eq!, panic!).


##### `function_payloads_remain_function_outputs`  (lines 30–46)

```
fn function_payloads_remain_function_outputs()
```

**Purpose**: This test confirms that ordinary function-call payloads are returned as ordinary function-call outputs. It prevents custom-tool behavior from accidentally leaking into the function-call path.

**Data flow**: It builds a function payload with empty JSON arguments and a simple text output of "ok". After conversion to a response item, it checks that the output is tied to the same call id, contains the same text, has no extra content-item list, and is marked successful.

**Call relations**: The test harness runs this as part of the tool context tests. It follows the same conversion route real function tool results use before they are sent back to the model.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (assert_eq!, panic!).


##### `mcp_code_mode_result_serializes_full_call_tool_result`  (lines 49–86)

```
fn mcp_code_mode_result_serializes_full_call_tool_result()
```

**Purpose**: This test verifies that an MCP tool result used in code mode keeps the full raw tool result as JSON. Code mode needs the structured data, not just a simplified text summary.

**Data flow**: It creates a fake MCP result with text content, structured content, an error flag, and metadata. It asks for the code-mode result and checks that the output JSON includes all of those pieces under the expected field names.

**Call relations**: The test is run by the test harness and focuses on the code-mode serialization path for MCP results. It makes sure the conversion hands forward the complete MCP result instead of trimming it down for display.

*Call graph*: 3 external calls (assert_eq!, json!, vec!).


##### `mcp_tool_output_response_item_includes_wall_time`  (lines 89–136)

```
fn mcp_tool_output_response_item_includes_wall_time()
```

**Purpose**: This test checks that normal MCP tool output includes how long the tool took. That timing header gives the model and logs useful context about the tool call.

**Data flow**: It builds an MCP output with one text content item, a 1.25 second wall time, and a byte limit. After converting it into a response item, it checks the call id and success flag, then reads the text body and confirms it starts with a wall-time header followed by JSON output.

**Call relations**: The test harness calls this test to exercise the normal response-item path for MCP tool output. The path formats timing information, serializes the MCP content, and hands that formatted text into a function-call output.

*Call graph*: 7 external calls (assert_eq!, json!, panic!, Bytes, from_str, from_millis, vec!).


##### `mcp_tool_output_response_item_truncates_large_structured_content`  (lines 139–179)

```
fn mcp_tool_output_response_item_truncates_large_structured_content()
```

**Purpose**: This test makes sure very large structured MCP output is shortened before it is put into a normal response item. That prevents oversized tool results from flooding the model context.

**Data flow**: It creates an MCP result with large structured content and a small byte limit. After conversion, it checks that the text starts with the wall-time header, includes a clear truncation notice, and does not include the fallback plain content that should be ignored when structured content exists.

**Call relations**: The test harness runs this against the MCP formatting path used for normal conversation responses. It verifies that the truncation policy is applied before the result is handed back as a function-call output.

*Call graph*: 8 external calls (assert!, assert_eq!, json!, panic!, Bytes, json!, from_millis, vec!).


##### `mcp_tool_output_response_item_preserves_content_items`  (lines 182–232)

```
fn mcp_tool_output_response_item_preserves_content_items()
```

**Purpose**: This test confirms that MCP output containing an image stays as content items instead of being reduced to plain text. This matters because flattening the result would lose the image.

**Data flow**: It creates an MCP result whose content is an image encoded as data. Conversion produces a response item with a text timing header plus an image item. The test checks both the structured content-item list and the plain text body derived from the text part.

**Call relations**: The test harness calls this when checking MCP response formatting. It exercises the branch that turns MCP media content into model-readable content items, while still keeping a text header for preview or fallback use.

*Call graph*: 6 external calls (assert_eq!, json!, panic!, Bytes, from_millis, vec!).


##### `mcp_tool_output_code_mode_result_stays_raw_call_tool_result`  (lines 235–272)

```
fn mcp_tool_output_code_mode_result_stays_raw_call_tool_result()
```

**Purpose**: This test ensures that code-mode MCP output is not shortened or reformatted into the normal chat-style response. Code mode should receive the raw structured result even when it is large.

**Data flow**: It builds an MCP result with large structured content and a very small truncation limit. Instead of converting it to a response item, it asks for the code-mode result and checks that the full original structured content is still present.

**Call relations**: The test harness runs this to protect the separate code-mode path. It shows that truncation used for normal responses does not affect the raw JSON handed to code-mode consumers.

*Call graph*: 6 external calls (assert_eq!, json!, Bytes, json!, from_millis, vec!).


##### `custom_tool_calls_can_derive_text_from_content_items`  (lines 275–319)

```
fn custom_tool_calls_can_derive_text_from_content_items()
```

**Purpose**: This test checks that a custom-tool output made from content items can still provide useful plain text. Text parts are combined, while non-text parts such as images are preserved separately.

**Data flow**: It creates content containing text, an image, and more text, then converts it as a custom-tool output. The test checks that the response keeps the full content-item list, derives the plain text as "line 1\nline 2", keeps the call id, and preserves success.

**Call relations**: The test harness calls this to exercise content-based output construction. It connects the content-item storage path with the response conversion path, proving that both rich content and plain-text fallback survive.

*Call graph*: calls 1 internal fn (from_content); 3 external calls (assert_eq!, panic!, vec!).


##### `tool_search_payloads_roundtrip_as_tool_search_outputs`  (lines 322–372)

```
fn tool_search_payloads_roundtrip_as_tool_search_outputs()
```

**Purpose**: This test verifies that a tool-search request produces a tool-search response, including the found tool descriptions. Tool search is how the system can tell the model what tools are available to load or use.

**Data flow**: It starts with a search payload asking for calendar tools and a fake search result containing one function tool named "create_event". After conversion, it checks that the response has the right call id, completed status, client execution label, and serialized tool definition.

**Call relations**: The test harness runs this to cover the tool-search conversion path. It makes sure search results are handed back in the special search-output format rather than being mistaken for ordinary function output.

*Call graph*: 3 external calls (assert_eq!, panic!, vec!).


##### `log_preview_uses_content_items_when_plain_text_is_missing`  (lines 375–388)

```
fn log_preview_uses_content_items_when_plain_text_is_missing()
```

**Purpose**: This test checks that logs can still show a readable preview when an output was built from content items instead of plain text. It keeps logs useful even for richer output formats.

**Data flow**: It creates a content-based output containing one text item. The test asks for the log preview and also directly converts the content items to text, confirming both produce "preview".

**Call relations**: The test harness calls this to cover the preview path used for logging or telemetry. It ties the content-item representation to the helper that extracts readable text from it.

*Call graph*: calls 1 internal fn (from_content); 2 external calls (assert_eq!, vec!).


##### `telemetry_preview_returns_original_within_limits`  (lines 391–394)

```
fn telemetry_preview_returns_original_within_limits()
```

**Purpose**: This test confirms that short telemetry previews are left unchanged. Telemetry here means small diagnostic data recorded for observing system behavior.

**Data flow**: It passes a short string into the preview function. Because the string is already within the allowed size, the same string comes back.

**Call relations**: The test harness runs this as the simplest case for telemetry previewing. It protects the rule that truncation should only happen when it is actually needed.

*Call graph*: 1 external calls (assert_eq!).


##### `telemetry_preview_truncates_by_bytes`  (lines 397–406)

```
fn telemetry_preview_truncates_by_bytes()
```

**Purpose**: This test makes sure telemetry previews are shortened when they exceed the byte limit. A byte is a unit of stored text size, so this protects logs from growing too large.

**Data flow**: It creates a string longer than the maximum preview byte count and sends it through the preview function. The returned preview must contain a truncation notice and stay within the expected maximum size plus that notice.

**Call relations**: The test harness calls this to check the byte-size limit in the telemetry preview helper. It verifies that oversized data is reduced before it would be recorded.

*Call graph*: 1 external calls (assert!).


##### `telemetry_preview_truncates_by_lines`  (lines 409–420)

```
fn telemetry_preview_truncates_by_lines()
```

**Purpose**: This test checks that telemetry previews are also shortened when they have too many lines. This keeps multi-line output from taking over diagnostics.

**Data flow**: It builds text with more lines than allowed and passes it to the preview function. The result must have no more than the allowed number of content lines plus a final truncation notice.

**Call relations**: The test harness runs this alongside the byte-limit test. Together they prove the preview helper controls both width by size and height by line count.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `exec_command_tool_output_formats_truncated_response`  (lines 423–463)

```
fn exec_command_tool_output_formats_truncated_response()
```

**Purpose**: This test verifies the user-facing format for command execution output when the output has been shortened. It checks that important command details are still shown.

**Data flow**: It builds a fake command result with a chunk id, wall time, exit code, original token count, raw output, and a maximum output-token limit. After conversion, it checks that the response is successful and that the text includes the chunk id, timing, exit code, original token count, output section, and a truncation message.

**Call relations**: The test harness calls this to exercise the command-output response path. The conversion formats process details and truncated output into the function-call response that the model would read after running a command.

*Call graph*: 5 external calls (assert_eq!, assert_regex_match, panic!, Tokens, from_millis).


### `core/src/tools/registry_tests.rs`

`test` · `test run`

The tool registry is like a front desk for tools. When the model asks to use a tool, the registry must find the right tool, pass it the request, shape the information sent to hooks, and report whether the tool started and finished successfully. If this went wrong, a namespaced tool could be confused with another tool, hooks could see the wrong input, or extensions would miss important lifecycle events.

This test file builds simple stand-in tool handlers. `TestHandler` always returns an "ok" result. `LifecycleTestHandler` can either return success-like output or fail on purpose. `ToolLifecycleRecorder` records start and finish notifications into a shared list, so tests can later check the exact order and content of those notifications.

The tests cover several important edge cases. They verify that plain tool names and namespaced tool names are looked up separately. They check that function-style tools expose sensible default payloads to pre-use and post-use hooks, including rewritten hook input. They make sure special tools such as code-mode waiting and writing to standard input do not expose default hook payloads when they should not. They also confirm that post-hook feedback can be shown to the model while preserving the original typed result for code mode. Finally, they test that lifecycle contributors are notified when a tool starts and when it finishes, including failures.

#### Function details

##### `TestHandler::tool_name`  (lines 9–11)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the fake tool's name. Tests use this so the fake handler behaves like a real tool that can tell the registry what it is called.

**Data flow**: It reads the stored tool name from the `TestHandler`, makes a copy of it, and returns that copy. Nothing else is changed.

**Call relations**: This is part of the `ToolExecutor` interface used by registry code and tests. When a test or registry path needs the handler's identity, this method supplies the name without exposing the handler's internal storage.

*Call graph*: 1 external calls (clone).


##### `TestHandler::spec`  (lines 13–15)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Builds a basic tool description for the fake tool. A tool description tells the surrounding system what the tool is called and what kind of input shape it accepts.

**Data flow**: It reads the handler's stored tool name, passes it to `test_spec`, and returns the simple tool specification that helper creates.

**Call relations**: This method lets `TestHandler` satisfy the same interface as real tools. It hands off the actual construction work to `test_spec` so all fake tools in this file share the same simple specification format.

*Call graph*: calls 1 internal fn (test_spec).


##### `TestHandler::handle`  (lines 17–26)

```
fn handle(&self, _invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Pretends to run a tool and always produces a successful text result of `ok`. This gives tests a dependable tool result without doing any real work.

**Data flow**: It receives a tool invocation but ignores its contents. It creates an asynchronous result containing a text output marked as successful, boxes it behind the common tool-output interface, and returns it as a future.

**Call relations**: Registry dispatch can call this just like it would call a real tool handler. The returned output is then used by tests that care about hook payloads, response conversion, or dispatch behavior rather than the tool's actual job.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (new, pin).


##### `LifecycleTestHandler::tool_name`  (lines 43–45)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the name of the lifecycle test tool. This lets the registry identify which fake lifecycle handler is being run.

**Data flow**: It reads the stored tool name, clones it, and returns the clone. The handler itself is not changed.

**Call relations**: This is the lifecycle-focused version of the normal tool-name method. Registry and test setup code can treat this fake handler as a normal tool because it provides the expected identity method.

*Call graph*: 1 external calls (clone).


##### `LifecycleTestHandler::spec`  (lines 47–49)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Builds a simple tool description for a lifecycle test handler. The description is only detailed enough for registry tests.

**Data flow**: It takes the handler's stored tool name, sends it to `test_spec`, and returns the resulting generic function-tool specification.

**Call relations**: Like `TestHandler::spec`, this keeps test tool setup consistent. It relies on `test_spec` so lifecycle tests do not need to repeat the same specification-building code.

*Call graph*: calls 1 internal fn (test_spec).


##### `LifecycleTestHandler::handle`  (lines 51–53)

```
fn handle(&self, _invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts the fake lifecycle handler's asynchronous work. It exists so the handler can be called through the same tool interface as real tools.

**Data flow**: It receives a tool invocation but does not inspect it directly. It wraps `handle_call` in an asynchronous future and returns that future to the caller.

**Call relations**: Registry dispatch calls this method when running the fake lifecycle tools. The real success-or-failure decision is delegated to `LifecycleTestHandler::handle_call`, which keeps this interface method small.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `LifecycleTestHandler::handle_call`  (lines 57–72)

```
async fn handle_call(
        &self,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Produces the configured result for a lifecycle test tool: either an `ok` output with a chosen success flag, or a deliberate error. This lets tests check how the registry reports both completed and failed tool calls.

**Data flow**: It reads the handler's stored `result` setting. If the setting is `Ok`, it creates a text output saying `ok` and attaches the configured success value. If the setting is `Err`, it returns an error message saying the handler failed.

**Call relations**: It is called by `LifecycleTestHandler::handle` during dispatch. Its output or error is what drives the lifecycle notification test, because the registry turns those outcomes into finished-tool events.

*Call graph*: calls 1 internal fn (from_text); called by 1 (handle); 3 external calls (new, clone, RespondToModel).


##### `test_spec`  (lines 77–86)

```
fn test_spec(tool_name: &codex_tools::ToolName) -> codex_tools::ToolSpec
```

**Purpose**: Creates a minimal function-tool specification for a named test tool. It avoids repeating the same boilerplate in each fake handler.

**Data flow**: It receives a tool name, copies the display name into a simple function-tool description, uses a default empty JSON schema for parameters, and returns the completed tool specification.

**Call relations**: Both `TestHandler::spec` and `LifecycleTestHandler::spec` call this helper. It acts as the shared recipe for making fake tools look enough like real tools for registry tests.

*Call graph*: called by 2 (spec, spec); 2 external calls (default, Function).


##### `ToolLifecycleRecorder::on_tool_start`  (lines 106–121)

```
fn on_tool_start(
        &'a self,
        input: codex_extension_api::ToolStartInput<'a>,
    ) -> codex_extension_api::ToolLifecycleFuture<'a>
```

**Purpose**: Records that a tool call has started. This gives tests a simple way to verify that lifecycle extensions are notified at the right time.

**Data flow**: It receives a start-event input containing the call id and tool name. It copies those values into a `Start` record, locks the shared record list, and appends the new record.

**Call relations**: The extension lifecycle system calls this when registry dispatch begins a tool call. Later, the lifecycle test reads the shared list to check that this start event appeared before the matching finish event.

*Call graph*: 2 external calls (clone, pin).


##### `ToolLifecycleRecorder::on_tool_finish`  (lines 123–139)

```
fn on_tool_finish(
        &'a self,
        input: codex_extension_api::ToolFinishInput<'a>,
    ) -> codex_extension_api::ToolLifecycleFuture<'a>
```

**Purpose**: Records that a tool call has finished, including whether it completed or failed. This lets tests confirm the registry reports final outcomes correctly.

**Data flow**: It receives finish-event input with the call id, tool name, and outcome. It copies those into a `Finish` record, locks the shared record list, and appends the record.

**Call relations**: The extension lifecycle system calls this after registry dispatch finishes a tool call. The dispatch lifecycle test compares these recorded finish events with the expected outcomes from successful and failing fake handlers.

*Call graph*: 2 external calls (clone, pin).


##### `handler_looks_up_namespaced_aliases_explicitly`  (lines 143–179)

```
fn handler_looks_up_namespaced_aliases_explicitly()
```

**Purpose**: Checks that the registry treats a plain tool name and a namespaced tool name as different entries. This prevents one tool from accidentally shadowing another tool with the same short name.

**Data flow**: The test creates one plain name, one namespaced name, and a second missing namespaced name. It registers separate fake handlers for the first two names, asks the registry for each name, and checks that the correct handlers are returned while the missing namespace returns nothing.

**Call relations**: The Rust test runner calls this test. Inside the test, `ToolRegistry::new` is used to build the registry, and registry lookup is exercised directly to prove name matching is exact.

*Call graph*: calls 3 internal fn (new, namespaced, plain); 5 external calls (clone, new, from, assert!, assert_eq!).


##### `function_tools_expose_default_hook_payloads_and_rewrites`  (lines 182–225)

```
async fn function_tools_expose_default_hook_payloads_and_rewrites() -> anyhow::Result<()>
```

**Purpose**: Verifies the default hook data for ordinary function tools and checks that hook input rewriting updates the function arguments. Hooks are extension points that can inspect or change tool input before or after a tool runs.

**Data flow**: The test builds a session, a function-style invocation with JSON arguments, and a fake text output. It checks the pre-use hook payload, the post-use hook payload, then asks the handler to replace the hook input and confirms the invocation still has function-shaped JSON arguments with the new value.

**Call relations**: The asynchronous test runner calls this test. It uses `test_invocation` to make a realistic invocation, then exercises the default hook methods on `TestHandler` and checks the rewritten payload.

*Call graph*: calls 4 internal fn (make_session_and_context, from_text, test_invocation, namespaced); 4 external calls (new, assert_eq!, panic!, json!).


##### `function_hook_input_defaults_empty_arguments_to_object`  (lines 228–248)

```
async fn function_hook_input_defaults_empty_arguments_to_object()
```

**Purpose**: Checks that blank function arguments are treated as an empty JSON object for hook input. This avoids hooks receiving invalid or surprising data when a function call has no real arguments.

**Data flow**: The test creates a function invocation whose arguments are only whitespace. It asks the handler for the pre-use hook payload and expects the tool input to be `{}`.

**Call relations**: The asynchronous test runner calls this test. It relies on `test_invocation` for the common invocation setup and focuses only on the argument-parsing default.

*Call graph*: calls 3 internal fn (make_session_and_context, test_invocation, plain); 2 external calls (new, assert_eq!).


##### `spawn_agent_function_tools_use_agent_matcher_alias`  (lines 251–288)

```
async fn spawn_agent_function_tools_use_agent_matcher_alias()
```

**Purpose**: Confirms that both the plain `spawn_agent` tool and its namespaced version appear to hooks under the same special hook name. This lets hook rules match agent-spawning consistently, no matter which alias was used.

**Data flow**: The test builds two invocations with the same JSON message: one for the plain tool name and one for the multi-agent namespace. It asks each handler for its pre-use hook payload and compares both results to the shared `spawn_agent` hook name.

**Call relations**: The asynchronous test runner calls this test. It uses shared session and turn objects for both invocations, then checks the hook-facing names produced by the handlers.

*Call graph*: calls 3 internal fn (make_session_and_context, namespaced, plain); 2 external calls (new, assert_eq!).


##### `code_mode_wait_does_not_expose_default_hook_payloads`  (lines 291–304)

```
async fn code_mode_wait_does_not_expose_default_hook_payloads()
```

**Purpose**: Ensures the code-mode wait tool does not produce the normal pre-use or post-use hook payloads. Waiting is a control action, not a regular model-facing function call, so exposing it like a normal tool would be misleading.

**Data flow**: The test creates a wait-tool invocation and a simple output. It asks the wait handler for pre-use and post-use hook payloads and expects both answers to be `None`.

**Call relations**: The asynchronous test runner calls this test. It uses `test_invocation` to create the call, then checks the specialized behavior of `CodeModeWaitHandler` instead of the generic defaults.

*Call graph*: calls 3 internal fn (make_session_and_context, from_text, test_invocation); 2 external calls (new, assert_eq!).


##### `write_stdin_does_not_expose_default_pre_tool_use_payload`  (lines 307–319)

```
async fn write_stdin_does_not_expose_default_pre_tool_use_payload()
```

**Purpose**: Checks that the tool for writing to standard input does not expose a default pre-use hook payload. Standard input is the stream of text sent into a running process, and treating this as an ordinary tool input could reveal or route data incorrectly.

**Data flow**: The test creates an invocation for the write-stdin handler. It asks for the pre-use hook payload and expects no payload to be produced.

**Call relations**: The asynchronous test runner calls this test. It uses `test_invocation` for setup and then verifies the special-case hook behavior of `WriteStdinHandler`.

*Call graph*: calls 2 internal fn (make_session_and_context, test_invocation); 2 external calls (new, assert_eq!).


##### `post_tool_use_feedback_output_keeps_code_mode_result_typed`  (lines 322–371)

```
fn post_tool_use_feedback_output_keeps_code_mode_result_typed()
```

**Purpose**: Checks that post-tool feedback can change what the model sees without losing the original typed result used by code mode. A typed result is structured data, such as JSON, rather than just plain text.

**Data flow**: The test builds a tool result whose original output is JSON and whose model-visible output is text feedback from a hook. It first converts the result into a model response and checks that the feedback text is used. Then it builds the same result again and checks that the code-mode result is still the original JSON.

**Call relations**: The Rust test runner calls this test. It exercises `AnyToolResult` conversion paths to ensure two consumers get the right view: the model gets feedback text, while code mode keeps structured data.

*Call graph*: calls 2 internal fn (from_text, new); 3 external calls (new, assert_eq!, json!).


##### `dispatch_notifies_tool_lifecycle_contributors`  (lines 374–452)

```
async fn dispatch_notifies_tool_lifecycle_contributors() -> anyhow::Result<()>
```

**Purpose**: Tests that tool lifecycle extensions are told when each tool starts and finishes, including both completed and failed calls. This is important for logging, monitoring, or extensions that react to tool activity.

**Data flow**: The test creates a session with a lifecycle recorder extension, registers one fake tool that returns output and one fake tool that returns an error, then dispatches both through the registry. It checks the failing call's error message and then drains the recorder's shared list to compare the exact start and finish records.

**Call relations**: The asynchronous test runner calls this test. It builds a `ToolRegistry`, uses `test_invocation` to create realistic calls, dispatches them through the normal registry path, and relies on `ToolLifecycleRecorder` to capture the lifecycle events.

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

**Purpose**: Creates a standard fake tool invocation for tests. This keeps each test from repeating the same session, turn, call id, cancellation, tracking, source, and empty function-argument setup.

**Data flow**: It receives a session, a turn context, a call id, and a tool name. It combines them with a fresh cancellation token, a fresh change tracker, a direct-call source, and default `{}` function arguments, then returns a complete `ToolInvocation`.

**Call relations**: Several tests call this helper when they need a realistic invocation object. The helper gives them a consistent starting point so each test can change only the part it cares about, such as arguments, tool name, or expected hook behavior.

*Call graph*: calls 1 internal fn (new); called by 5 (code_mode_wait_does_not_expose_default_hook_payloads, dispatch_notifies_tool_lifecycle_contributors, function_hook_input_defaults_empty_arguments_to_object, function_tools_expose_default_hook_payloads_and_rewrites, write_stdin_does_not_expose_default_pre_tool_use_payload); 3 external calls (new, new, new).


### `core/src/tools/router_tests.rs`

`test` · `test run`

The tool router is like a reception desk for tool calls. The model asks for a tool by name, sometimes with a namespace that says where the tool comes from, and the router must send that request to exactly the right place. These tests check that the desk does not confuse similar names, does not promise parallel execution unless a tool actually supports it, hides tools that should only appear after discovery, and can expose and run tools supplied by extensions.

The file includes a tiny fake extension tool called `extension/echo`. It reports back the arguments it received, the call id, and the conversation history. That gives the tests a simple way to prove that extension tools are visible to the model and executable through the same router path as built-in tools.

Several tests build a session and turn context, create a `ToolRouter`, then ask it questions: “Is this tool safe to run in parallel?”, “What tool specs are visible to the model?”, or “Can this response item become a correctly namespaced tool call?” The file matters because a wrong routing decision could call the wrong server’s tool, expose hidden tools too early, or run unsafe tools at the same time.

#### Function details

##### `ExtensionEchoContributor::tools`  (lines 39–45)

```
fn tools(
        &self,
        _session_store: &ExtensionData,
        _thread_store: &ExtensionData,
    ) -> Vec<Arc<dyn ToolExecutor<ExtensionToolCall>>>
```

**Purpose**: Supplies the fake extension tool used by this test file. It pretends to be an extension that contributes one executable tool, the echo tool.

**Data flow**: It receives extension data stores for the session and thread, but this test contributor does not need to read them. It creates an `ExtensionEchoExecutor`, wraps it so it can be shared, and returns it in a list of available extension tool executors.

**Call relations**: The test registry uses this contributor when building a fake extension environment. Later, the router asks the registry for extension tools, and this contributor is the source of the echo executor that becomes visible and dispatchable.

*Call graph*: 1 external calls (vec!).


##### `ExtensionEchoExecutor::tool_name`  (lines 51–53)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Gives the fake extension tool its full routed name. The namespace `extension/` keeps it separate from built-in or MCP tools that might also be called `echo`.

**Data flow**: It takes no outside input beyond the executor itself. It builds and returns a namespaced tool name made from `extension/` and `echo`.

**Call relations**: The router and extension machinery use this name to identify which executor should receive a matching tool call. It supports the extension dispatch test by making the fake tool addressable as `extension/echo`.

*Call graph*: calls 1 internal fn (namespaced).


##### `ExtensionEchoExecutor::spec`  (lines 55–76)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Describes the fake extension tool in the format the model can see. The spec says there is an `extension/` namespace with an `echo` function that requires a string field called `message`.

**Data flow**: It builds a tool description from fixed test data: namespace name, human-readable descriptions, and a JSON input schema. It returns a `ToolSpec` that can be included in the router’s model-visible tool list.

**Call relations**: When the router collects tool descriptions, this method lets the fake extension advertise itself. The extension visibility test checks that this spec appears among the tools offered to the model.

*Call graph*: 3 external calls (default_namespace_description, Namespace, vec!).


##### `ExtensionEchoExecutor::handle`  (lines 78–80)

```
fn handle(&self, call: ExtensionToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts execution of the fake extension tool in the async form expected by the tool system. Async means the work returns later without blocking the whole program while it runs.

**Data flow**: It receives an extension tool call, passes that call into `handle_call`, and wraps the resulting future so the generic tool executor interface can await it. It returns that future to the caller.

**Call relations**: The router calls this through the generic tool executor interface when it dispatches the extension echo call. This method is a small adapter between the trait’s required shape and the real test implementation in `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ExtensionEchoExecutor::handle_call`  (lines 84–96)

```
async fn handle_call(
        &self,
        call: ExtensionToolCall,
    ) -> Result<Box<dyn codex_tools::ToolOutput>, codex_tools::FunctionCallError>
```

**Purpose**: Runs the fake echo tool and creates a predictable JSON result for assertions. It proves that arguments, call identity, and conversation history reach an extension tool correctly.

**Data flow**: It reads the tool call’s function arguments as JSON text, parses them into structured JSON, and combines them with the call id and conversation history. It returns a JSON tool output containing those values plus `ok: true`; it does not change external state.

**Call relations**: It is called by `ExtensionEchoExecutor::handle` during extension tool dispatch. The main extension test inspects this output to confirm the router delivered the right call and context to the extension executor.

*Call graph*: calls 1 internal fn (new); called by 1 (handle); 4 external calls (new, function_arguments, json!, from_str).


##### `extension_tool_test_registry`  (lines 99–103)

```
fn extension_tool_test_registry() -> Arc<ExtensionRegistry<Config>>
```

**Purpose**: Builds a small extension registry containing only the fake echo contributor. This gives the tests a controlled extension setup instead of depending on real installed extensions.

**Data flow**: It creates a new registry builder, registers `ExtensionEchoContributor`, builds the registry, and returns it wrapped for shared ownership. The result can be installed into a test session’s services.

**Call relations**: The extension dispatch test calls this before creating the router. That makes the fake extension tools available when `extension_tool_executors` gathers executors from the session.

*Call graph*: calls 1 internal fn (new); called by 1 (extension_tool_executors_are_model_visible_and_dispatchable); 1 external calls (new).


##### `parallel_support_does_not_match_namespaced_local_tool_names`  (lines 106–148)

```
async fn parallel_support_does_not_match_namespaced_local_tool_names() -> anyhow::Result<()>
```

**Purpose**: Checks that a built-in local tool’s parallel-execution permission does not accidentally apply to a namespaced tool with the same final name. This prevents the router from treating `mcp__server__shell_command` as if it were the local `shell_command`.

**Data flow**: It creates a test session and router, finds a local shell-like tool that supports parallel calls, then builds a second call with the same tool name inside an MCP-style namespace. It asserts that the local call is recognized as parallel-safe but the namespaced lookalike is not.

**Call relations**: This test drives `ToolRouter::from_turn_context` and then asks the router’s parallel-support check about carefully chosen tool calls. It protects the routing rule that full names, including namespaces, matter.

*Call graph*: calls 2 internal fn (make_session_and_context, from_turn_context); 3 external calls (default, new, assert!).


##### `build_tool_call_uses_namespace_for_registry_name`  (lines 151–177)

```
async fn build_tool_call_uses_namespace_for_registry_name() -> anyhow::Result<()>
```

**Purpose**: Checks that a model function call with a namespace becomes a tool call whose name includes that namespace. Without this, two tools with the same short name from different places could be confused.

**Data flow**: It starts with a response item naming `create_event` and giving the namespace `mcp__codex_apps__calendar`. It asks the router to build a `ToolCall`, then verifies the output has the combined namespaced name, the original call id, and the original function arguments.

**Call relations**: This test exercises `ToolRouter::build_tool_call`, which is used when model responses are converted into executable tool requests. It confirms that namespacing is preserved before dispatch ever happens.

*Call graph*: calls 1 internal fn (build_tool_call); 2 external calls (assert_eq!, panic!).


##### `mcp_parallel_support_uses_handler_data`  (lines 180–226)

```
async fn mcp_parallel_support_uses_handler_data() -> anyhow::Result<()>
```

**Purpose**: Checks that parallel-execution support for MCP tools comes from the exact MCP tool’s metadata. MCP means Model Context Protocol, a way for external servers to provide tools to the model.

**Data flow**: It creates two fake MCP tool records with the same callable name but different namespaces and different parallel-support flags. It builds a router from those records, then verifies that only the tool from the server marked parallel-safe is treated as parallel-safe.

**Call relations**: This test feeds fake MCP tool info into `ToolRouter::from_turn_context` and queries the router with namespaced tool calls. It depends on `mcp_tool_info` to create the test tool records.

*Call graph*: calls 3 internal fn (make_session_and_context, from_turn_context, namespaced); 4 external calls (default, new, assert!, vec!).


##### `tools_without_handlers_do_not_support_parallel`  (lines 229–252)

```
async fn tools_without_handlers_do_not_support_parallel() -> anyhow::Result<()>
```

**Purpose**: Checks the safe default: if the router has no handler information for a tool, it must not assume the tool can run in parallel. This avoids racing tools whose behavior is unknown.

**Data flow**: It creates a router with no MCP tools, no extension executors, and no discoverable tools. It then asks whether a `web_search` call supports parallel execution and asserts the answer is false.

**Call relations**: This test exercises the router’s fallback behavior after `ToolRouter::from_turn_context` builds a minimal router. It protects against accidental optimistic parallelism when no concrete tool handler is registered.

*Call graph*: calls 2 internal fn (make_session_and_context, from_turn_context); 3 external calls (default, new, assert!).


##### `specs_filter_deferred_dynamic_tools`  (lines 255–304)

```
async fn specs_filter_deferred_dynamic_tools() -> anyhow::Result<()>
```

**Purpose**: Checks that dynamic tools marked as deferred are hidden from the model until later discovery. Deferred here means “do not show this tool immediately.”

**Data flow**: It creates a dynamic namespace with two tools: one hidden because `defer_loading` is true, and one visible because it is false. After building the router, it asks for model-visible specs and confirms that only the visible tool name appears.

**Call relations**: This test uses `ToolRouter::from_turn_context` with custom dynamic tool specs and uses `namespace_function_names` to read the resulting visible tool names. It protects the feature that keeps undiscovered tools out of the model’s initial menu.

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

**Purpose**: Creates a fake MCP tool record for tests. It packages the server name, namespace, tool name, and parallel-support flag into the same shape the router receives from real MCP connections.

**Data flow**: It receives simple strings and a boolean, then fills out a `ToolInfo` structure with those values plus harmless defaults for fields the tests do not care about. It also creates a minimal JSON schema saying the tool accepts an object.

**Call relations**: The MCP parallel-support test calls this helper to build two similar tools from different servers. That lets the test focus on router behavior instead of the many details needed to construct `ToolInfo` by hand.

*Call graph*: 5 external calls (new, new, json!, new, object).


##### `extension_tool_executors_are_model_visible_and_dispatchable`  (lines 333–416)

```
async fn extension_tool_executors_are_model_visible_and_dispatchable() -> anyhow::Result<()>
```

**Purpose**: Checks the full extension tool path: an extension tool appears in the model-visible tool list, can be called by namespace, and receives the correct conversation history and arguments.

**Data flow**: It creates a test session, installs the fake extension registry, records a user message into conversation history, and builds a router with extension executors. It verifies the echo tool’s spec is visible, builds a namespaced call to `extension/echo`, dispatches it, then parses the returned function-call output and compares it to the expected JSON.

**Call relations**: This is the main end-to-end test in the file. It uses `extension_tool_test_registry` to install the fake extension, `ToolRouter::build_tool_call` to convert a model response into a call, and the router’s dispatch method to run the call through `ExtensionEchoExecutor`.

*Call graph*: calls 5 internal fn (make_session_and_context, build_tool_call, from_turn_context, extension_tool_test_registry, new); 12 external calls (new, new, default, assert!, assert_eq!, json!, panic!, from_str, from_ref, extension_tool_executors (+2 more)).


##### `namespace_function_names`  (lines 418–439)

```
fn namespace_function_names(specs: &[ToolSpec], namespace_name: &str) -> Vec<String>
```

**Purpose**: Extracts the function names inside one namespace from a list of tool specs. It is a small test helper that makes visibility assertions easier to read.

**Data flow**: It receives a list of tool specs and a namespace name. It searches for a matching namespace, collects the names of function tools inside it, and returns those names; if the namespace is missing, it returns an empty list.

**Call relations**: The deferred dynamic tools test uses this helper after asking the router for model-visible specs. It turns the larger tool-spec structure into a simple list of names that can be compared directly in an assertion.

*Call graph*: 1 external calls (iter).


### `core/src/tools/spec_plan_tests.rs`

`test` · `test run`

Codex can offer the model many different tools: shell execution, web search, image generation, plugin installation, multi-agent tools, MCP tools, and more. The hard part is deciding which ones should be visible in a given session. This file acts like a checklist for that decision-making. It builds fake turns, changes settings on them, asks the ToolRouter to produce a tool plan, and then checks the result.

A useful way to picture this file is as a test kitchen. Each test changes the ingredients: turn on a feature flag, switch to a Bedrock provider, add a remote environment, add deferred tools, or pretend the model supports tool search. Then it inspects the final menu shown to the model and the hidden tools registered for runtime use.

The helper type ToolPlanProbe makes those inspections easy. It records visible tool names, namespaced functions, registered tool names, and each tool's exposure level. The rest of the file uses small setup helpers to create fake MCP tools, dynamic tools, plugin candidates, authentication modes, and extension tools. The tests are important because tool visibility is safety- and behavior-critical: exposing the wrong tool could confuse the model or give it powers it should not have; hiding the wrong tool could break expected workflows.

#### Function details

##### `ToolPlanProbe::from_router`  (lines 58–105)

```
fn from_router(router: ToolRouter) -> Self
```

**Purpose**: Builds a compact test-friendly snapshot from a ToolRouter. It lets tests inspect what the model can see, what tools are registered, and how each registered tool is exposed.

**Data flow**: It receives a completed ToolRouter. It reads the router's visible tool specs and registered test-only tool names, extracts plain names and namespaced function lists, looks up exposure settings, and returns a ToolPlanProbe containing those summaries.

**Call relations**: The probe helpers call this after ToolRouter::from_turn_context has built a plan. The cache-specific test also uses it directly so it can compare two router plans made from the same cache.

*Call graph*: calls 2 internal fn (model_visible_specs, registered_tool_names_for_test); called by 2 (probe_with, tool_search_cache_rebuilds_when_deferred_sources_change).


##### `ToolPlanProbe::assert_visible_contains`  (lines 107–115)

```
fn assert_visible_contains(&self, expected: &[&str])
```

**Purpose**: Checks that certain tools are visible to the model. Tests use it when a setting should make tools appear in the public tool list.

**Data flow**: It receives expected tool names and compares each one with the probe's visible_names list. If any name is missing, the test fails with a message showing what was visible.

**Call relations**: Individual tests call this after creating a probe, usually to prove that enabling a feature or capability exposes the expected tool.

*Call graph*: 1 external calls (assert!).


##### `ToolPlanProbe::assert_visible_lacks`  (lines 117–125)

```
fn assert_visible_lacks(&self, expected_absent: &[&str])
```

**Purpose**: Checks that certain tools are not visible to the model. This is used to confirm that gates, provider limits, or code-mode hiding rules are working.

**Data flow**: It receives names that should be absent and searches the probe's visible_names list. If any forbidden name is present, the test fails.

**Call relations**: Tests call it alongside assert_visible_contains to describe both sides of a tool-planning rule: what appears and what stays hidden.

*Call graph*: 1 external calls (assert!).


##### `ToolPlanProbe::assert_registered_contains`  (lines 127–137)

```
fn assert_registered_contains(&self, expected: &[&str])
```

**Purpose**: Checks that tools are registered for execution even if they may not be visible to the model. This matters for hidden or deferred tools that can still be called through another path.

**Data flow**: It receives expected registered names and compares them with registered_names. Missing names cause the test to fail with a helpful message.

**Call relations**: Tests use this after probing a router to verify the runtime side of planning, especially for legacy shell tools, deferred tools, and namespaced tools.

*Call graph*: 1 external calls (assert!).


##### `ToolPlanProbe::assert_registered_lacks`  (lines 139–150)

```
fn assert_registered_lacks(&self, expected_absent: &[&str])
```

**Purpose**: Checks that tools are not registered at all. This is stronger than being invisible: it means the runtime should not know about that tool in this plan.

**Data flow**: It receives names that should be absent and scans registered_names. If any are found, the test fails.

**Call relations**: Tests call it when a feature is disabled, a schema is invalid, or no environment exists, proving the tool is not merely hidden but unavailable.

*Call graph*: 1 external calls (assert!).


##### `ToolPlanProbe::namespace_function_names`  (lines 152–156)

```
fn namespace_function_names(&self, namespace: &str) -> &[String]
```

**Purpose**: Returns the function names inside a visible namespace tool. A namespace is a grouped tool surface, like a folder containing several related functions.

**Data flow**: It receives a namespace name, looks it up in the probe's namespace_functions map, and returns the stored list. If the namespace is missing, it returns an empty slice.

**Call relations**: Tests use it to check which functions appear inside MCP, multi-agent, dynamic, or configured namespaces.


##### `ToolPlanProbe::visible_spec`  (lines 158–163)

```
fn visible_spec(&self, name: &str) -> &ToolSpec
```

**Purpose**: Finds the full visible tool specification for one tool name. Tests use it when checking details beyond simple visibility, such as parameters or descriptions.

**Data flow**: It receives a tool name, searches visible_specs for a matching spec name, and returns that spec. If it cannot find the tool, it fails the test.

**Call relations**: Many tests first confirm a tool exists, then call this to inspect its schema, description, or special type.


##### `ToolPlanProbe::exposure`  (lines 165–170)

```
fn exposure(&self, name: &str) -> ToolExposure
```

**Purpose**: Returns how a registered tool is exposed, such as direct, hidden, or deferred. Exposure describes whether the model sees the tool directly or reaches it through another mechanism.

**Data flow**: It receives a registered tool name, looks it up in the probe's exposure map, and returns the ToolExposure value. If the name is not registered, the test fails.

**Call relations**: Tests use it to verify subtle planning decisions, such as hiding legacy shell tools or making request_user_input direct-model-only.


##### `probe_with`  (lines 173–191)

```
async fn probe_with(
    configure_turn: impl FnOnce(&mut TurnContext),
    inputs: ToolPlanInputs,
) -> ToolPlanProbe
```

**Purpose**: Creates a fake session turn, applies custom setup, feeds extra tool inputs into the ToolRouter, and returns a ToolPlanProbe. It is the main test harness for scenarios that need custom tool sources.

**Data flow**: It takes a function that mutates the TurnContext and a ToolPlanInputs bundle. It creates a session and turn, applies the mutation, builds a ToolRouter with MCP, deferred, discoverable, extension, and dynamic tools, then turns that router into a probe.

**Call relations**: Most tests use this directly when they need more than default settings. The simpler probe helper also calls it with empty inputs.

*Call graph*: calls 3 internal fn (make_session_and_context, from_turn_context, from_router); called by 10 (code_mode_only_exposes_code_executor_and_hides_nested_tools, deferred_extension_tools_are_discoverable_with_tool_search, excluded_deferred_namespaces_do_not_enable_nested_tool_guidance, hosted_tools_follow_provider_auth_model_and_config_gates, install_suggestion_tools_stay_visible_without_tool_search, invalid_mcp_tools_are_not_registered, mcp_and_tool_search_follow_direct_and_deferred_tool_exposure, probe, request_plugin_install_description_defers_inventory_to_list_tool, request_plugin_install_requires_all_discovery_features_and_discoverable_tools); 1 external calls (default).


##### `probe`  (lines 193–195)

```
async fn probe(configure_turn: impl FnOnce(&mut TurnContext)) -> ToolPlanProbe
```

**Purpose**: A shorter version of probe_with for tests that only need to change the turn context. It keeps simple tests easy to read.

**Data flow**: It receives a turn-configuration function, supplies default empty ToolPlanInputs, waits for probe_with, and returns the resulting ToolPlanProbe.

**Call relations**: Many tests call this when they only need to flip feature flags, provider settings, or model capabilities.

*Call graph*: calls 1 internal fn (probe_with); called by 19 (code_mode_only_can_expose_namespaced_multi_agent_v2_as_normal_tools, environment_count_controls_environment_backed_tools, host_context_gates_agent_job_tools, hosted_tools_follow_provider_auth_model_and_config_gates, mcp_and_tool_search_follow_direct_and_deferred_tool_exposure, multi_agent_feature_selects_one_agent_tool_family, multi_agent_v2_can_use_configured_tool_namespace, multi_agent_v2_message_schemas_are_encrypted, multi_agent_v2_namespace_is_supported_by_bedrock_provider, request_plugin_install_requires_all_discovery_features_and_discoverable_tools (+9 more)); 1 external calls (default).


##### `set_feature`  (lines 197–231)

```
fn set_feature(turn: &mut TurnContext, feature: Feature, enabled: bool)
```

**Purpose**: Turns one feature flag on or off in both the live turn and its copied config. This keeps the test context internally consistent.

**Data flow**: It receives a mutable turn, a feature, and whether it should be enabled. It updates the turn's feature set, clones and updates the config, recalculates multi-agent version and tool mode, and stores the updated config back on the turn.

**Call relations**: set_features calls it repeatedly. Tests rely on it so ToolRouter sees the same feature state through both TurnContext fields and config fields.

*Call graph*: called by 1 (set_features); 1 external calls (new).


##### `set_features`  (lines 233–237)

```
fn set_features(turn: &mut TurnContext, features: &[Feature])
```

**Purpose**: Enables several feature flags at once. It is a convenience helper for tests that need a bundle of capabilities.

**Data flow**: It receives a mutable turn and a list of features. For each feature, it calls set_feature with enabled set to true.

**Call relations**: Tests call it to prepare combinations like code mode plus code-mode-only, or all plugin-discovery features.

*Call graph*: calls 1 internal fn (set_feature).


##### `zsh_fork_config_for_spec_plan_tests`  (lines 239–252)

```
fn zsh_fork_config_for_spec_plan_tests() -> codex_tools::ZshForkConfig
```

**Purpose**: Creates a safe placeholder Zsh-fork shell configuration for tests. The paths only need to look valid because these tests inspect tool specs and never actually launch the shell.

**Data flow**: It reads the current test executable path, checks that it is absolute, and uses it as both required executable paths in a ZshForkConfig.

**Call relations**: Zsh-fork unified-exec tests call this when they need the turn to appear configured for ZshFork mode without depending on packaged shell artifacts.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (current_exe).


##### `update_config`  (lines 254–258)

```
fn update_config(turn: &mut TurnContext, update: impl FnOnce(&mut crate::config::Config))
```

**Purpose**: Safely edits the turn's shared config for a test. Because the config is stored behind an Arc, it clones the config, changes it, and replaces the shared value.

**Data flow**: It receives a mutable turn and an update function. It clones the current config, lets the caller mutate the clone, wraps the result in a new Arc, and assigns it back to the turn.

**Call relations**: Other setup helpers use this for web search mode and provider changes. Tests also use it directly for one-off config tweaks.

*Call graph*: called by 2 (set_web_search_mode, use_bedrock_provider); 1 external calls (new).


##### `set_web_search_mode`  (lines 260–267)

```
fn set_web_search_mode(turn: &mut TurnContext, mode: WebSearchMode)
```

**Purpose**: Sets the test turn's web search mode, such as live search. This isolates the config-writing details from the tests.

**Data flow**: It receives a mutable turn and a WebSearchMode. It calls update_config and writes the mode through the config's validated setter.

**Call relations**: Hosted-tool tests call this before checking whether web_search should be visible.

*Call graph*: calls 1 internal fn (update_config).


##### `use_chatgpt_auth`  (lines 269–277)

```
fn use_chatgpt_auth(turn: &mut TurnContext)
```

**Purpose**: Makes a test turn look like it is authenticated with ChatGPT. Some hosted tools are only available with this kind of authentication.

**Data flow**: It creates dummy ChatGPT authentication, stores it in the turn's auth manager, rebuilds the model provider using that auth, and writes the provider back to the turn.

**Call relations**: Hosted-tool tests call it before expecting image generation to appear.

*Call graph*: calls 2 internal fn (from_auth_for_testing, create_dummy_chatgpt_auth_for_testing); 1 external calls (create_model_provider).


##### `use_bedrock_provider`  (lines 279–286)

```
fn use_bedrock_provider(turn: &mut TurnContext)
```

**Purpose**: Switches a test turn to the Amazon Bedrock provider. Tests use this to check provider-specific tool support.

**Data flow**: It creates Bedrock provider info, updates the config's provider id and provider object, then rebuilds the turn's provider with the existing authentication.

**Call relations**: Tool-search, multi-agent namespace, and hosted web-search tests call this to verify behavior under Bedrock.

*Call graph*: calls 2 internal fn (update_config, create_amazon_bedrock_provider); 1 external calls (create_model_provider).


##### `WebRunExtensionTool::tool_name`  (lines 291–293)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Names the fake extension tool as web.run. This lets tests simulate an extension that provides standalone web execution.

**Data flow**: It has no input besides the tool object. It returns a namespaced ToolName with namespace web and function run.

**Call relations**: ToolRouter calls this through the ToolExecutor trait when extension executors are supplied to probe_with.

*Call graph*: calls 1 internal fn (namespaced).


##### `WebRunExtensionTool::spec`  (lines 295–308)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Describes the fake web.run extension tool as a namespace containing one function. The spec is what the planner would inspect when deciding visible tools.

**Data flow**: It builds a ToolSpec namespace named web with a single run function, a test description, empty JSON parameters, and no output schema.

**Call relations**: ToolRouter asks the extension executor for this spec while building a plan in the standalone web-search test.

*Call graph*: 2 external calls (Namespace, vec!).


##### `WebRunExtensionTool::handle`  (lines 310–314)

```
fn handle(&self, _call: ExtensionToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Provides a dummy implementation for the fake web.run tool. It returns an empty JSON output if ever called.

**Data flow**: It ignores the incoming tool call, creates an async future, and returns an empty JSON object wrapped as tool output.

**Call relations**: The tests only need planning, not execution, so this exists to satisfy the ToolExecutor trait.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, pin, json!).


##### `DeferredExtensionTool::tool_name`  (lines 320–322)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Names the fake deferred extension tool as extension_echo. Tests use that name to check registration and visibility.

**Data flow**: It has no input besides the tool object and returns a plain, non-namespaced ToolName.

**Call relations**: ToolRouter calls this through the ToolExecutor trait when the deferred extension executor is included in probe_with.

*Call graph*: calls 1 internal fn (plain).


##### `DeferredExtensionTool::spec`  (lines 324–340)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Describes a fake extension tool that echoes a message. The spec includes a required message parameter so it looks like a real callable function.

**Data flow**: It builds a function ToolSpec named extension_echo with a strict object schema containing a required string field called message.

**Call relations**: The deferred-extension test supplies this executor so ToolRouter can register it and make it discoverable through tool_search rather than directly visible.

*Call graph*: calls 2 internal fn (object, string); 3 external calls (from, Function, vec!).


##### `DeferredExtensionTool::exposure`  (lines 342–344)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Marks the fake extension tool as deferred. Deferred means the model should not see the tool directly, but it may discover or call it through another tool-search flow.

**Data flow**: It returns the ToolExposure::Deferred value without reading other state.

**Call relations**: ToolRouter uses this trait method while planning extension tools, and the related test checks that the exposure is preserved.


##### `DeferredExtensionTool::handle`  (lines 346–348)

```
fn handle(&self, _call: ExtensionToolCall) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Intentionally fails if the fake deferred tool is executed. These tests are about planning only, so execution would mean something unexpected happened.

**Data flow**: It ignores the call and returns an async future that panics when polled.

**Call relations**: The deferred-extension planning test should never trigger this; it exists only to complete the ToolExecutor implementation.

*Call graph*: 2 external calls (pin, panic!).


##### `duplicate_primary_environment`  (lines 351–355)

```
fn duplicate_primary_environment(turn: &mut TurnContext)
```

**Purpose**: Adds a second environment to a test turn by copying the primary one and giving it a new id. This lets tests check behavior when multiple execution targets exist.

**Data flow**: It reads the first environment, clones it, changes its environment_id to secondary, and pushes it into the turn's environment list.

**Call relations**: The environment-count test calls it before checking that tools include an environment_id parameter.


##### `mcp_tool`  (lines 357–378)

```
fn mcp_tool(server: &str, namespace: &str, name: &str) -> ToolInfo
```

**Purpose**: Builds a valid fake MCP tool for tests. MCP is a protocol that lets outside servers provide tools to the model.

**Data flow**: It receives server, namespace, and tool names. It creates a ToolInfo with a simple object input schema, namespace description, server metadata, and no connector information.

**Call relations**: MCP-related tests use it directly, and invalid_mcp_tool starts from it before corrupting the schema.

*Call graph*: called by 1 (invalid_mcp_tool); 6 external calls (new, new, format!, json!, new, object).


##### `invalid_mcp_tool`  (lines 380–386)

```
fn invalid_mcp_tool(server: &str, namespace: &str, name: &str) -> ToolInfo
```

**Purpose**: Builds a fake MCP tool with an invalid input schema. Tests use it to prove bad external tool definitions are rejected.

**Data flow**: It creates a normal fake MCP tool, replaces its input schema with a schema whose type is null, and returns the modified ToolInfo.

**Call relations**: The invalid-MCP test passes this into probe_with and checks that ToolRouter does not register or expose it.

*Call graph*: calls 1 internal fn (mcp_tool); 3 external calls (new, json!, object).


##### `dynamic_tool`  (lines 388–411)

```
fn dynamic_tool(namespace: Option<&str>, name: &str, defer_loading: bool) -> DynamicToolSpec
```

**Purpose**: Creates a fake dynamic tool spec, either as a standalone function or inside a namespace. Dynamic tools are tool definitions supplied at runtime rather than compiled in.

**Data flow**: It receives an optional namespace, a tool name, and whether loading should be deferred. It builds a simple object input schema and returns either a function spec or a namespace spec containing that function.

**Call relations**: Code-mode tests use it to check how nested dynamic tools are shown, hidden, or registered under different tool modes.

*Call graph*: 5 external calls (format!, json!, Function, Namespace, vec!).


##### `discoverable_plugin`  (lines 413–424)

```
fn discoverable_plugin(id: &str, name: &str) -> DiscoverableTool
```

**Purpose**: Creates a fake plugin candidate that could be suggested for installation. Tests use it as inventory for plugin-discovery tools.

**Data flow**: It receives an id and display name, builds DiscoverablePluginInfo with a description and empty connector/server lists, and converts it into a DiscoverableTool.

**Call relations**: Plugin-installation tests pass these fake candidates into probe_with to decide whether list and request install tools should appear.

*Call graph*: 2 external calls (new, format!).


##### `has_parameter`  (lines 426–431)

```
fn has_parameter(spec: &ToolSpec, parameter_name: &str) -> bool
```

**Purpose**: Checks whether a visible tool spec declares a particular input parameter. This helps tests inspect schemas without depending on all schema details.

**Data flow**: It serializes the ToolSpec to JSON, follows the /parameters/properties/<name> path, and returns true if that JSON location exists.

**Call relations**: Shell, environment, and view-image tests use it after visible_spec to confirm that parameters such as shell or environment_id are present or absent.

*Call graph*: 2 external calls (format!, to_value).


##### `apply_patch_accepts_environment_id`  (lines 433–440)

```
fn apply_patch_accepts_environment_id(spec: &ToolSpec) -> bool
```

**Purpose**: Checks whether the freeform apply_patch tool description mentions Environment ID. Freeform tools do not expose ordinary JSON parameters, so the test inspects the text definition.

**Data flow**: It receives a ToolSpec. If it is a freeform apply_patch tool, it searches the tool's format definition text for Environment ID; otherwise it returns false.

**Call relations**: The environment-count test uses this to confirm apply_patch adapts when more than one environment is available.


##### `request_user_input_tool_respects_experimental_config_gate`  (lines 443–460)

```
async fn request_user_input_tool_respects_experimental_config_gate()
```

**Purpose**: Tests that request_user_input appears only when its experimental config switch allows it. This protects an interactive user-prompting tool from appearing unexpectedly.

**Data flow**: It first probes the default config and checks the tool is visible, registered, and direct-model-only. Then it disables the experimental config setting, probes again, and checks the tool is absent from both visible and registered lists.

**Call relations**: The test relies on probe for setup and uses ToolPlanProbe assertions to compare enabled versus disabled plans.

*Call graph*: calls 1 internal fn (probe); 1 external calls (assert_eq!).


##### `request_user_input_stays_direct_in_code_mode_only`  (lines 463–484)

```
async fn request_user_input_stays_direct_in_code_mode_only()
```

**Purpose**: Tests that request_user_input remains a direct model tool even when code-mode-only is active. It also ensures the code executor description does not advertise that nested tool.

**Data flow**: It enables code mode and code-mode-only, builds a plan, checks request_user_input plus code-mode entry tools are visible, verifies exposure, then inspects the exec tool description.

**Call relations**: It uses set_features inside probe and then calls visible_spec for the code-mode exec tool.

*Call graph*: calls 1 internal fn (probe); 3 external calls (assert!, assert_eq!, panic!).


##### `shell_family_registers_visible_unified_exec_and_hidden_legacy_shell`  (lines 487–500)

```
async fn shell_family_registers_visible_unified_exec_and_hidden_legacy_shell()
```

**Purpose**: Tests the shell-tool family when unified exec is enabled. The new exec_command and write_stdin tools should be visible, while the old shell_command remains registered but hidden.

**Data flow**: It enables shell and unified exec features, disables ZshFork, sets the model shell type, and probes. It checks visible names, registered names, hidden exposure for shell_command, and the shell parameter on exec_command.

**Call relations**: This test uses probe plus helper assertions to verify both the public tool surface and the hidden compatibility runtime.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert!, assert_eq!).


##### `shell_zsh_fork_stays_standalone_until_unified_exec_composition_is_enabled`  (lines 503–540)

```
async fn shell_zsh_fork_stays_standalone_until_unified_exec_composition_is_enabled()
```

**Purpose**: Tests that ZshFork shell mode does not automatically use unified exec unless the specific composition feature is enabled. It also accounts for platforms where terminal support is unavailable.

**Data flow**: It builds one plan with ZshFork enabled but unified-exec composition disabled and expects shell_command only. Then it builds a second plan with composition enabled and checks either unified exec or standalone behavior depending on terminal support.

**Call relations**: It uses probe for both scenarios and the platform support check to avoid expecting unified terminal behavior where it cannot work.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert_eq!, conpty_supported).


##### `zsh_fork_unified_exec_hides_shell_parameter`  (lines 543–565)

```
async fn zsh_fork_unified_exec_hides_shell_parameter()
```

**Purpose**: Tests that unified exec hides the shell selector when ZshFork is the only local shell mode. This prevents the model from choosing a shell it cannot actually vary.

**Data flow**: If the platform lacks terminal support, it exits early. Otherwise it enables the needed shell features, sets ZshFork mode with a placeholder config, probes, and verifies exec_command lacks the shell parameter.

**Call relations**: It uses the ZshFork config helper and has_parameter to inspect the final exec_command schema.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert!, conpty_supported).


##### `zsh_fork_unified_exec_keeps_shell_parameter_when_remote_environment_available`  (lines 568–613)

```
async fn zsh_fork_unified_exec_keeps_shell_parameter_when_remote_environment_available()
```

**Purpose**: Tests that the shell selector comes back when a remote environment is available. A remote target may support different shell behavior, so the model needs a shell choice again.

**Data flow**: After a platform support check, it enables ZshFork unified exec, adds a remote test environment, probes, and checks exec_command includes both shell and environment_id parameters.

**Call relations**: It constructs an extra TurnEnvironment inside probe and then uses has_parameter to confirm the router noticed the multi-environment situation.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert!, conpty_supported).


##### `environment_count_controls_environment_backed_tools`  (lines 616–655)

```
async fn environment_count_controls_environment_backed_tools()
```

**Purpose**: Tests that tools requiring an execution environment disappear when no environment exists, and gain environment selection when multiple environments exist.

**Data flow**: It first clears all environments, enables shell/apply_patch settings, and checks shell, exec, apply_patch, and view_image are absent. Then it duplicates the primary environment, enables relevant features, and checks visible tools include environment_id support.

**Call relations**: It uses duplicate_primary_environment, has_parameter, and apply_patch_accepts_environment_id to inspect how the tool plan changes with environment count.

*Call graph*: calls 1 internal fn (probe); 1 external calls (assert!).


##### `host_context_gates_agent_job_tools`  (lines 658–673)

```
async fn host_context_gates_agent_job_tools()
```

**Purpose**: Tests that agent-job reporting tools only appear when the current session is a worker agent job. Normal sessions should be able to spawn CSV agents but not report job results.

**Data flow**: It probes once with SpawnCsv enabled in a normal session and checks only spawn_agents_on_csv appears. It probes again after marking the session source as a subagent job and checks report_agent_job_result appears too.

**Call relations**: The test changes session_source inside probe so ToolRouter can gate tools based on where the session came from.

*Call graph*: calls 1 internal fn (probe).


##### `sleep_tool_follows_feature_gate`  (lines 676–688)

```
async fn sleep_tool_follows_feature_gate()
```

**Purpose**: Tests that the sleep tool follows its feature flag. This keeps a simple timing tool from appearing unless explicitly enabled.

**Data flow**: It probes with SleepTool disabled and checks sleep is absent, then probes with SleepTool enabled and checks sleep is visible.

**Call relations**: It uses set_feature inside probe for the two opposite states.

*Call graph*: calls 1 internal fn (probe).


##### `mcp_and_tool_search_follow_direct_and_deferred_tool_exposure`  (lines 691–764)

```
async fn mcp_and_tool_search_follow_direct_and_deferred_tool_exposure()
```

**Purpose**: Tests how MCP tools interact with direct visibility and deferred tool search. It confirms direct MCP tools are shown as namespaces, while deferred MCP tools require model support for tool_search.

**Data flow**: It builds several plans: direct MCP, deferred MCP without model search support, no deferred tools, Bedrock with namespace capability, and fully enabled search. It checks visible resource helpers, tool_search visibility, and registered deferred tool names.

**Call relations**: The test combines probe_with, mcp_tool, provider setup, and ToolName construction to cover direct and searchable MCP paths.

*Call graph*: calls 3 internal fn (probe, probe_with, namespaced); 3 external calls (assert_eq!, default, vec!).


##### `deferred_extension_tools_are_discoverable_with_tool_search`  (lines 767–783)

```
async fn deferred_extension_tools_are_discoverable_with_tool_search()
```

**Purpose**: Tests that a deferred extension tool is registered but not directly visible, and that tool_search is shown so the model can discover it.

**Data flow**: It enables model support for search, supplies the fake DeferredExtensionTool executor, probes, and checks tool_search is visible, extension_echo is hidden from visible tools, and extension_echo is registered with deferred exposure.

**Call relations**: It uses probe_with because the scenario needs an extension executor in addition to turn configuration.

*Call graph*: calls 1 internal fn (probe_with); 3 external calls (assert_eq!, default, vec!).


##### `tool_search_cache_rebuilds_when_deferred_sources_change`  (lines 786–838)

```
async fn tool_search_cache_rebuilds_when_deferred_sources_change()
```

**Purpose**: Tests that the tool-search handler cache does not reuse stale descriptions when the set of deferred tools changes. This prevents the model from seeing an old tool inventory.

**Data flow**: It creates one shared cache, builds a first router with a deferred MCP server named first, then builds a second router with a deferred MCP server named second. It inspects each tool_search description and confirms each mentions only its own source.

**Call relations**: Unlike most tests, it calls make_session_and_context and ToolRouter::from_turn_context directly so both routers share the same cache.

*Call graph*: calls 3 internal fn (make_session_and_context, from_turn_context, from_router); 5 external calls (new, assert!, default, panic!, vec!).


##### `invalid_mcp_tools_are_not_registered`  (lines 841–853)

```
async fn invalid_mcp_tools_are_not_registered()
```

**Purpose**: Tests that MCP tools with invalid schemas are rejected. This protects the model and runtime from malformed external tool definitions.

**Data flow**: It supplies one invalid fake MCP tool, probes, and checks neither the namespace nor the namespaced callable is visible or registered.

**Call relations**: It uses invalid_mcp_tool and probe_with to feed bad external input into the normal router path.

*Call graph*: calls 2 internal fn (probe_with, namespaced); 2 external calls (default, vec!).


##### `request_plugin_install_requires_all_discovery_features_and_discoverable_tools`  (lines 856–908)

```
async fn request_plugin_install_requires_all_discovery_features_and_discoverable_tools()
```

**Purpose**: Tests that plugin-installation suggestion tools only appear when all required discovery features are enabled and there is at least one installable candidate.

**Data flow**: It loops over each required feature, disables that one while enabling the others, and checks install tools are absent. It also checks no candidates means absent, then supplies a fake plugin and confirms both list and request tools are visible.

**Call relations**: It uses discoverable_plugin plus probe_with for candidate inventory, and probe for the no-candidate case.

*Call graph*: calls 2 internal fn (probe, probe_with); 2 external calls (default, vec!).


##### `install_suggestion_tools_stay_visible_without_tool_search`  (lines 911–932)

```
async fn install_suggestion_tools_stay_visible_without_tool_search()
```

**Purpose**: Tests that plugin installation suggestion tools do not depend on the model's tool_search capability. They should still be directly visible when discovery is enabled.

**Data flow**: It disables model search support, enables the required plugin-discovery features, supplies a fake plugin candidate, probes, and checks install tools appear while tool_search does not.

**Call relations**: This complements the broader plugin gate test by isolating the relationship between plugin suggestions and tool_search.

*Call graph*: calls 1 internal fn (probe_with); 2 external calls (default, vec!).


##### `request_plugin_install_description_defers_inventory_to_list_tool`  (lines 935–972)

```
async fn request_plugin_install_description_defers_inventory_to_list_tool()
```

**Purpose**: Tests that request_plugin_install's description does not contain a hardcoded plugin inventory. Instead, the model should first call the list tool and then request an exact match.

**Data flow**: It enables plugin discovery, supplies a fake GitHub plugin, probes, then inspects the descriptions of list_available_plugins_to_install and request_plugin_install. It checks the list tool describes returning candidates and the request tool points to the list tool without naming github.

**Call relations**: It uses visible_spec to inspect exact function descriptions rather than only checking tool presence.

*Call graph*: calls 1 internal fn (probe_with); 4 external calls (assert!, default, panic!, vec!).


##### `code_mode_only_exposes_code_executor_and_hides_nested_tools`  (lines 975–1016)

```
async fn code_mode_only_exposes_code_executor_and_hides_nested_tools()
```

**Purpose**: Tests that code-mode-only changes the visible surface from nested dynamic tools to the code executor entrypoints. The model should use the code-mode wrapper rather than directly seeing nested tools.

**Data flow**: It first supplies a dynamic namespaced tool without code mode and checks the namespace function is visible. Then it enables code mode and code-mode-only with the same dynamic tool, checks exec and wait are visible, and confirms the original namespace no longer exposes the function.

**Call relations**: It uses dynamic_tool and probe_with to compare the same runtime tool under two different tool modes.

*Call graph*: calls 1 internal fn (probe_with); 3 external calls (assert_eq!, default, vec!).


##### `excluded_deferred_namespaces_do_not_enable_nested_tool_guidance`  (lines 1019–1052)

```
async fn excluded_deferred_namespaces_do_not_enable_nested_tool_guidance()
```

**Purpose**: Tests that deferred tools in excluded namespaces do not cause code-mode guidance text about omitted nested tools. Excluded namespaces should not affect that user-facing explanation.

**Data flow**: It enables code-mode-only, disables collaboration, enables model search support, configures an excluded namespace, and supplies a deferred dynamic tool in that namespace. It checks the code exec description lacks the deferred-tool guidance and that the tool plus tool_search are registered.

**Call relations**: It combines dynamic_tool, config updates, and visible_spec to inspect a subtle code-mode description rule.

*Call graph*: calls 2 internal fn (probe_with, namespaced); 4 external calls (assert!, default, panic!, vec!).


##### `multi_agent_feature_selects_one_agent_tool_family`  (lines 1055–1153)

```
async fn multi_agent_feature_selects_one_agent_tool_family()
```

**Purpose**: Tests that the planner chooses exactly one multi-agent tool family: older v1 namespaced tools or newer v2 tools. It also verifies selected schema and exposure details.

**Data flow**: It probes with collaboration enabled and MultiAgentV2 disabled, expecting the v1 namespace and its functions. Then it probes with v2 enabled, expecting v2 standalone tools and specific description content. Finally it tests code-mode-only with non-code-mode-only v2 settings and checks direct-model-only exposure.

**Call relations**: This test uses feature setup and config updates to compare the major multi-agent planning branches.

*Call graph*: calls 1 internal fn (probe); 3 external calls (assert!, assert_eq!, panic!).


##### `multi_agent_v2_message_schemas_are_encrypted`  (lines 1156–1177)

```
async fn multi_agent_v2_message_schemas_are_encrypted()
```

**Purpose**: Tests that message fields in v2 multi-agent tools are marked encrypted. This is important because those messages may contain user or task context that should be protected.

**Data flow**: It enables MultiAgentV2, probes, then inspects spawn_agent, send_message, and followup_task parameter schemas. For each one it checks the message property has encrypted set to true.

**Call relations**: It uses visible_spec to inspect schema metadata that simple visibility checks would miss.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert_eq!, panic!).


##### `tool_mode_selector_overrides_feature_flags`  (lines 1180–1191)

```
async fn tool_mode_selector_overrides_feature_flags()
```

**Purpose**: Tests that an explicit model tool-mode setting wins over feature flags. Even if code-mode features are enabled, ToolMode::Direct should prevent code-mode entry tools from appearing.

**Data flow**: It enables code-mode flags, sets the model and turn tool mode to Direct, probes, and checks the code-mode exec and wait tools are absent.

**Call relations**: This test checks the interaction between set_feature's default tool-mode recalculation and an explicit override set afterward.

*Call graph*: calls 1 internal fn (probe).


##### `v1_multi_agent_tools_defer_when_tool_search_available`  (lines 1194–1236)

```
async fn v1_multi_agent_tools_defer_when_tool_search_available()
```

**Purpose**: Tests that v1 multi-agent tools become deferred when tool_search is available. Instead of showing the whole namespace directly, the model sees tool_search and can discover those tools.

**Data flow**: It enables model search support, turns on collaboration, disables v2, probes, and checks tool_search is visible while v1 function names are not directly visible. It then verifies namespaced runtimes are registered with deferred exposure and the search description mentions multi-agent tools.

**Call relations**: It uses ToolName::namespaced to check the runtime names that should exist when v1 tools are deferred.

*Call graph*: calls 2 internal fn (probe, namespaced); 3 external calls (assert!, assert_eq!, panic!).


##### `multi_agent_v2_can_use_configured_tool_namespace`  (lines 1239–1292)

```
async fn multi_agent_v2_can_use_configured_tool_namespace()
```

**Purpose**: Tests that v2 multi-agent tools can be grouped under a configured namespace. It also confirms removed or unsupported tools, such as assign_task, do not sneak into that namespace.

**Data flow**: It enables MultiAgentV2, sets the namespace to agents, probes, and checks the visible surface is the agents namespace rather than standalone tool names. It verifies expected functions are registered and present inside the namespace, while assign_task is absent.

**Call relations**: This covers the configured namespace branch of multi-agent v2 planning.

*Call graph*: calls 1 internal fn (probe); 1 external calls (assert!).


##### `multi_agent_v2_namespace_is_supported_by_bedrock_provider`  (lines 1295–1316)

```
async fn multi_agent_v2_namespace_is_supported_by_bedrock_provider()
```

**Purpose**: Tests that a namespaced v2 multi-agent tool surface works with the Bedrock provider. Provider differences should not remove the configured agents namespace.

**Data flow**: It enables MultiAgentV2, configures the agents namespace, switches the provider to Bedrock, probes, and checks the namespace is visible while plain standalone names are not registered.

**Call relations**: It combines use_bedrock_provider with the namespace configuration to verify provider-specific compatibility.

*Call graph*: calls 1 internal fn (probe); 1 external calls (assert!).


##### `code_mode_only_can_expose_namespaced_multi_agent_v2_as_normal_tools`  (lines 1319–1369)

```
async fn code_mode_only_can_expose_namespaced_multi_agent_v2_as_normal_tools()
```

**Purpose**: Tests a code-mode-only setup where namespaced multi-agent v2 tools are still exposed as normal direct tools. This is a special case controlled by config.

**Data flow**: It enables code mode, code-mode-only, and MultiAgentV2, sets non_code_mode_only and the agents namespace, then probes. It checks the exact visible tool order and confirms the agents namespace contains expected functions but not assign_task.

**Call relations**: This test ties together code-mode visibility, multi-agent v2 namespace configuration, and hosted web-search ordering.

*Call graph*: calls 1 internal fn (probe); 2 external calls (assert!, assert_eq!).


##### `hosted_tools_follow_provider_auth_model_and_config_gates`  (lines 1372–1467)

```
async fn hosted_tools_follow_provider_auth_model_and_config_gates()
```

**Purpose**: Tests the rules for hosted Responses API tools such as image generation and web search. These tools depend on authentication, provider support, model capabilities, feature flags, and extension-tool conflicts.

**Data flow**: It checks image generation is hidden with API-key auth but visible with ChatGPT auth and image-capable model settings. It checks web_search specs under live mode, hosted tools in code-mode-only ordering, standalone web-search behavior with and without a web.run extension, and hiding web_search on an unsupported provider.

**Call relations**: This is a broad integration-style planner test that uses probe, probe_with, authentication helpers, provider helpers, and web-search config helpers.

*Call graph*: calls 2 internal fn (probe, probe_with); 3 external calls (default, assert_eq!, vec!).


### `core/src/tools/tool_dispatch_trace_tests.rs`

`test` · `test`

When the system asks a tool to run, it also needs to leave a clear paper trail: who asked for the tool, what payload was sent, whether it succeeded, and what result came back. This file is a set of automated tests for that paper trail. The “rollout trace” is like a flight recorder for an agent session; if it misses or mislabels tool calls, later replay and debugging would give a false story.

The file builds small fake sessions in temporary folders, attaches a test trace recorder to them, and then sends tool invocations through the normal ToolRegistry dispatch path. A tiny TestHandler stands in for a real tool: it advertises one test tool and always returns the text “ok”. The tests then replay the saved trace from disk and inspect what was recorded.

The important cases are: a normal model-requested tool call, a code-mode tool call coming from a code cell, an unsupported tool name, a tool called with the wrong kind of payload, and a code-mode wait call when no matching code cell trace exists. Together these tests protect the boundary between tool execution and trace recording, making sure both success and failure leave enough information for later inspection.

#### Function details

##### `TestHandler::tool_name`  (lines 34–36)

```
fn tool_name(&self) -> codex_tools::ToolName
```

**Purpose**: Returns the name of the fake tool used by these tests. The registry uses this name to decide which handler should receive a tool call.

**Data flow**: It reads the tool name stored inside the TestHandler, makes a copy of it, and gives that copy back. Nothing else is changed.

**Call relations**: This is part of the ToolExecutor behavior implemented by TestHandler. When the test registry is built with this handler, the registry can ask for the handler’s name so it can route matching invocations to it.

*Call graph*: 1 external calls (clone).


##### `TestHandler::spec`  (lines 38–47)

```
fn spec(&self) -> codex_tools::ToolSpec
```

**Purpose**: Builds the public description of the fake test tool. This description says the tool is a function-style tool named like the handler’s tool name, with a simple placeholder description and default input schema.

**Data flow**: It reads the stored tool name, fills out a tool specification object with that name and basic metadata, and returns the specification. It does not run the tool or inspect any invocation.

**Call relations**: This supports the same ToolExecutor interface as the real tools. The registry can use it when it needs to know what tools are available, although in these tests the main focus is dispatching and tracing rather than the schema itself.

*Call graph*: 2 external calls (default, Function).


##### `TestHandler::handle`  (lines 49–56)

```
fn handle(&self, _invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Pretends to run a tool and always succeeds with the text result “ok”. This gives the tests a predictable successful tool execution without depending on any real tool behavior.

**Data flow**: It receives a tool invocation but ignores its contents. It creates a successful FunctionToolOutput containing “ok”, wraps it in the asynchronous return shape expected by the tool system, and returns it.

**Call relations**: The ToolRegistry calls this when a test invocation names the fake tool. Its simple success result lets the surrounding tests check whether dispatch tracing records the invocation and result payloads correctly.

*Call graph*: calls 1 internal fn (from_text); 2 external calls (new, pin).


##### `dispatch_lifecycle_trace_records_direct_and_code_mode_requesters`  (lines 62–146)

```
async fn dispatch_lifecycle_trace_records_direct_and_code_mode_requesters() -> anyhow::Result<()>
```

**Purpose**: Checks that the trace records who requested a tool call correctly: either the model directly, or a code cell running in code mode. It also checks that the trace keeps the raw invocation and result payloads needed for replay.

**Data flow**: The test creates a temporary trace folder, makes a fake session and turn, attaches tracing, and starts a code-cell trace. It dispatches one direct tool call and one code-mode tool call through a registry containing TestHandler. Then it reloads the saved trace from disk and verifies that the direct call is marked as model-requested while the code-mode call is linked to the right code cell and runtime tool id.

**Call relations**: This is one of the main end-to-end tests in the file. It uses attach_test_trace to install the recorder, test_invocation to build dispatch inputs, TestHandler through ToolRegistry to produce successful outputs, and single_bundle_dir to find the saved trace before replaying it.

*Call graph*: calls 6 internal fn (make_session_and_context, with_handler_for_test, attach_test_trace, single_bundle_dir, test_invocation, plain); 6 external calls (clone, new, new, assert!, assert_eq!, replay_bundle).


##### `dispatch_lifecycle_trace_records_unsupported_tool_failures`  (lines 149–176)

```
async fn dispatch_lifecycle_trace_records_unsupported_tool_failures() -> anyhow::Result<()>
```

**Purpose**: Checks that asking for a tool that is not registered is still written to the trace as a failed tool call. This matters because failures are part of the real session history and must not disappear.

**Data flow**: The test creates a traced fake session, but uses an empty tool registry. It dispatches a call for a missing tool, expects an error that can be reported back to the model, then reloads the trace and confirms the tool call is marked failed and has a recorded result payload.

**Call relations**: This test exercises the registry’s failure path instead of TestHandler. It still uses the shared helpers attach_test_trace, test_invocation, and single_bundle_dir so the setup matches the successful dispatch tests.

*Call graph*: calls 5 internal fn (make_session_and_context, empty_for_test, attach_test_trace, single_bundle_dir, test_invocation); 5 external calls (new, new, assert!, assert_eq!, replay_bundle).


##### `dispatch_lifecycle_trace_records_incompatible_payload_failures`  (lines 179–210)

```
async fn dispatch_lifecycle_trace_records_incompatible_payload_failures() -> anyhow::Result<()>
```

**Purpose**: Checks that a tool call with the wrong kind of payload is recorded as a failure. This protects trace completeness when dispatch breaks before the tool can run normally.

**Data flow**: The test sets up tracing and registers TestHandler for the expected tool name. Instead of sending a normal function payload, it sends a custom payload that the dispatch path cannot use for this tool. It expects a fatal error, then replays the trace and verifies that the call was saved as failed with a result payload.

**Call relations**: This test uses test_invocation_with_payload directly because it needs to build an unusual payload. It relies on the normal registry dispatch path to reject the mismatch and on attach_test_trace and single_bundle_dir to inspect the resulting trace.

*Call graph*: calls 6 internal fn (make_session_and_context, with_handler_for_test, attach_test_trace, single_bundle_dir, test_invocation_with_payload, plain); 5 external calls (new, new, assert!, assert_eq!, replay_bundle).


##### `missing_code_mode_wait_traces_only_the_wait_tool_call`  (lines 213–242)

```
async fn missing_code_mode_wait_traces_only_the_wait_tool_call() -> anyhow::Result<()>
```

**Purpose**: Checks a special code-mode wait tool case: if there is no matching code-cell trace, the system should still record the wait tool call, but should not invent a code cell. This avoids misleading trace data.

**Data flow**: The test creates a traced fake session and registers the CodeModeWaitHandler. It dispatches a wait-tool invocation referring to a non-existent cell id. After replaying the saved trace, it confirms there are no recorded code cells, while the wait tool call still has a saved result payload.

**Call relations**: This test uses a real wait-tool handler rather than TestHandler. Like the other tests, it builds the invocation with test_invocation, attaches tracing with attach_test_trace, and reads the single saved bundle with single_bundle_dir.

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

**Purpose**: Builds a normal function-style ToolInvocation for tests. It is a convenience wrapper so each test does not have to repeat the same setup details.

**Data flow**: It receives a session, turn, call id, tool name, source, and argument text. It turns the plain tool-name string into a ToolName, wraps the argument text as a function payload, and passes everything to test_invocation_with_payload. The result is a ready-to-dispatch ToolInvocation.

**Call relations**: The main tests call this whenever they need an ordinary tool call. It delegates the common object construction to test_invocation_with_payload, keeping the tests focused on what behavior they are checking.

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

**Purpose**: Builds a ToolInvocation with a caller-supplied payload. Tests use it when they need full control over the payload, including deliberately invalid payloads.

**Data flow**: It receives the shared session and turn, cancellation setup information is created fresh, a new turn-diff tracker is made, and the call id, tool name, source, and payload are placed into a ToolInvocation. The completed invocation is returned for dispatch.

**Call relations**: test_invocation calls this for normal function payloads, and the incompatible-payload test calls it directly to create a bad input. The ToolRegistry then consumes the returned invocation during dispatch.

*Call graph*: calls 1 internal fn (new); called by 2 (dispatch_lifecycle_trace_records_incompatible_payload_failures, test_invocation); 3 external calls (new, new, new).


##### `attach_test_trace`  (lines 284–307)

```
fn attach_test_trace(session: &mut Session, turn: &TurnContext, root: &Path) -> anyhow::Result<()>
```

**Purpose**: Connects a fake session to a fresh rollout trace stored under a temporary test directory. Without this, dispatch would run but the tests would have no trace file to replay and inspect.

**Data flow**: It reads the session’s thread id and receives the current turn and root directory. It starts a test trace with fixed metadata such as model name, provider name, working directory, approval policy, and sandbox policy. It records that the turn has started, then replaces the session’s trace recorder with this new test recorder.

**Call relations**: Every test calls this before dispatching tools. It prepares the shared tracing environment that the registry and tool dispatch code write into, and single_bundle_dir later finds the trace bundle it created.

*Call graph*: calls 1 internal fn (start_root_in_root_for_test); called by 4 (dispatch_lifecycle_trace_records_direct_and_code_mode_requesters, dispatch_lifecycle_trace_records_incompatible_payload_failures, dispatch_lifecycle_trace_records_unsupported_tool_failures, missing_code_mode_wait_traces_only_the_wait_tool_call); 1 external calls (from).


##### `single_bundle_dir`  (lines 309–316)

```
fn single_bundle_dir(root: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: Finds the one trace bundle directory created inside a temporary test root. It also checks that exactly one bundle exists, so the tests do not accidentally read the wrong trace.

**Data flow**: It reads the entries in the given root directory, converts them into paths, sorts them for stable behavior, and asserts that there is exactly one. It removes and returns that single path.

**Call relations**: After each test dispatches tool calls, it calls this helper before replaying the trace. This bridges the filesystem output from attach_test_trace and the replay step that verifies the recorded data.

*Call graph*: called by 4 (dispatch_lifecycle_trace_records_direct_and_code_mode_requesters, dispatch_lifecycle_trace_records_incompatible_payload_failures, dispatch_lifecycle_trace_records_unsupported_tool_failures, missing_code_mode_wait_traces_only_the_wait_tool_call); 2 external calls (assert_eq!, read_dir).


### Approvals, sandboxing, and runtime preparation
These files cover approval normalization, sandbox policy helpers, and the runtime setup paths that prepare commands and patch execution safely.

### `core/src/apply_patch_tests.rs`

`test` · `test run`

This is a focused test file. It verifies that when the core code is asked to convert an apply-patch action into the protocol format, a newly added file stays marked as an added file and keeps its text content.

The test creates a temporary folder so it can use a real-looking file path without touching the user’s actual files. Inside that folder, it builds an apply-patch action that says: “add this file, with the content hello.” It then passes that action into `convert_apply_patch_to_protocol`, which is the code being checked.

The expected result is a map-like collection where looking up that file path gives back a `FileChange::Add` value containing the same text, `hello`. If the conversion accidentally used the wrong change type, lost the file path, or changed the content, the assertion would fail.

In everyday terms, this test is like checking that a shipping label is copied correctly from one form to another: the package is still marked as “new delivery,” and the contents listed on the label are still the same.

#### Function details

##### `convert_apply_patch_maps_add_variant`  (lines 8–22)

```
fn convert_apply_patch_maps_add_variant()
```

**Purpose**: This test proves that an apply-patch action for adding a file becomes a protocol `FileChange::Add` with the same content. It exists to catch mistakes in the conversion between the internal patch representation and the protocol representation used elsewhere.

**Data flow**: It starts by making a temporary directory, then builds an absolute path for `a.txt` inside it. That path and the text `hello` go into `new_add_for_test`, which creates an add-file patch action. The test sends that action into `convert_apply_patch_to_protocol`, then checks that looking up the same path in the converted result returns an add-file change containing `hello`.

**Call relations**: During the test, this function calls the test helper `new_add_for_test` to create a simple add-file action, uses `tempdir` to avoid depending on real project files, and finishes with `assert_eq!` to compare the converted output with the expected protocol value.

*Call graph*: calls 1 internal fn (new_add_for_test); 2 external calls (assert_eq!, tempdir).


### `core/src/command_canonicalization_tests.rs`

`test` · `test suite`

When a tool asks whether a command is allowed to run, it needs a stable way to recognize that command. The same real command can be wrapped in different shells, use a full path like `/bin/bash` or a short name like `bash`, or contain extra spacing. Without normalization, the approval system could treat these as different commands and ask again unnecessarily, or fail to match a previous approval.

This test file checks `canonicalize_command_for_approval`, the function that turns a raw command into a cleaner approval key. Think of it like writing addresses in a standard format before comparing them: “Main St.” and “Main Street” should not look unrelated if they point to the same place.

The tests cover four important cases. Simple shell commands such as `bash -lc "cargo test ..."` are reduced to the inner command words. More complex shell scripts, such as heredoc scripts, are not split apart; instead they receive a special stable marker so they can still be recognized safely. PowerShell command wrappers are treated similarly, ignoring wrapper differences like `powershell.exe` versus `powershell`. Finally, commands that are not shell wrappers, such as `cargo fmt`, are preserved exactly.

#### Function details

##### `canonicalizes_word_only_shell_scripts_to_inner_command`  (lines 5–30)

```
fn canonicalizes_word_only_shell_scripts_to_inner_command()
```

**Purpose**: This test checks that simple shell-wrapped commands are reduced to the actual command inside the shell. It also verifies that harmless differences, such as `/bin/bash` versus `bash` and extra spaces, do not change the approval key.

**Data flow**: It builds two command lists that both mean “run `cargo test -p codex-core` through bash.” It sends each list into the command canonicalization function, then compares the result with the expected clean list of words. The expected output is `cargo`, `test`, `-p`, and `codex-core`, with shell wrapper details removed.

**Call relations**: During the test run, the test framework calls this function. Inside it, the test uses assertion checks to prove that the canonicalization result matches the expected form, and that two differently written shell commands produce the same approval key.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `canonicalizes_heredoc_scripts_to_stable_script_key`  (lines 33–54)

```
fn canonicalizes_heredoc_scripts_to_stable_script_key()
```

**Purpose**: This test checks that shell scripts written as heredocs are not treated like simple word-only commands. A heredoc is a way to place a multi-line script directly inside a shell command, so the system gives it a stable script marker instead of trying to split it into ordinary words.

**Data flow**: It creates a small Python heredoc script and wraps it once with `/bin/zsh` and once with `zsh`. Each command is passed to the canonicalization function. The output should begin with the special marker `__codex_shell_script__`, keep the shell option `-lc`, and keep the full script text, making both wrapper forms compare the same.

**Call relations**: The test framework runs this as part of the test suite. The function then uses assertion checks to confirm that heredoc commands get a special shell-script approval key, and that the path-style shell name and short shell name are treated alike.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `canonicalizes_powershell_wrappers_to_stable_script_key`  (lines 57–82)

```
fn canonicalizes_powershell_wrappers_to_stable_script_key()
```

**Purpose**: This test checks that PowerShell-wrapped commands are turned into a consistent approval key. It ensures that wrapper differences like `powershell.exe`, `powershell`, and optional flags do not make the same script look like different commands.

**Data flow**: It creates two PowerShell command lists that both run the script `Write-Host hi`. One includes `powershell.exe` and `-NoProfile`; the other uses `powershell` with fewer wrapper arguments. Both are sent through canonicalization, and the expected result is a special PowerShell script marker plus the script text.

**Call relations**: The test framework calls this function during testing. The function relies on assertion checks to show that the canonicalization logic ignores non-essential PowerShell wrapper details and produces the same approval key for equivalent scripts.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `preserves_non_shell_commands`  (lines 85–88)

```
fn preserves_non_shell_commands()
```

**Purpose**: This test checks that ordinary commands are not changed when they are not shell or PowerShell wrappers. This protects normal commands from being over-simplified by the approval-key logic.

**Data flow**: It creates the command list `cargo fmt`, sends it through the canonicalization function, and compares the result with the original command list. The before and after should be identical.

**Call relations**: The test framework runs this function with the other canonicalization tests. Its assertion confirms the boundary of the feature: shell wrappers may be normalized, but plain commands should pass through unchanged.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/tasks/user_shell_tests.rs`

`test` · `test run`

This is a small test file for shell command setup. In this project, a command may be rewritten before it is run so that it first loads a saved shell “snapshot” file. That snapshot can contain environment settings, such as a PATH value. PATH is the list of folders the operating system searches when you type a command name.

The important behavior tested here is ordering. The system may need to add a package-specific directory to the front of PATH so tools from that package are found first. At the same time, it may load a shell snapshot that also sets PATH. Without care, the snapshot could wipe out or move the package directory, causing the wrong program version to run.

The test creates a temporary snapshot file that sets PATH to `/snapshot/bin`. It starts with an existing PATH of `/worktree/bin`, asks the command-preparation code to prepend a temporary package path, then actually runs the rewritten shell command and prints PATH. The expected result is that the package path appears first, followed by the snapshot path. This proves the rewrite logic preserves the package path prepend even when the snapshot changes PATH.

#### Function details

##### `shell_with_snapshot`  (lines 9–21)

```
fn shell_with_snapshot(
    shell_type: ShellType,
    shell_path: &str,
    snapshot_path: AbsolutePathBuf,
) -> (Shell, AbsolutePathBuf)
```

**Purpose**: This helper builds the two pieces of test data that represent a user shell and its saved snapshot file. It keeps the main test shorter and easier to read.

**Data flow**: It receives a shell type, a shell executable path as text, and an absolute path to a snapshot file. It turns the shell path into a path object, puts the shell type and path into a `Shell` value, and returns that together with the snapshot path unchanged.

**Call relations**: The main test calls this helper after creating a temporary snapshot file. The returned shell description and snapshot path are then passed into the command-preparation code so the test can simulate running through a real user shell setup.

*Call graph*: called by 1 (user_shell_snapshot_preserves_package_path_prepend); 1 external calls (from).


##### `user_shell_snapshot_preserves_package_path_prepend`  (lines 24–62)

```
fn user_shell_snapshot_preserves_package_path_prepend()
```

**Purpose**: This test checks that adding a package directory to the front of PATH still wins after a shell snapshot is loaded. It exists to catch regressions where the snapshot would accidentally erase or outrank the runtime package path.

**Data flow**: It creates a temporary directory, writes a snapshot script that sets PATH to `/snapshot/bin`, and builds a bash command that prints PATH. It starts with an environment containing `/worktree/bin`, asks the command-preparation function to rewrite the command while prepending a temporary package path, then runs the rewritten command with the resulting PATH. Finally, it checks that the command succeeded and that the printed PATH is `package-path:/snapshot/bin`.

**Call relations**: During the test, it calls `shell_with_snapshot` to build the shell-and-snapshot inputs. It then exercises `prepare_user_shell_exec_command_with_path_prepend`, the production code being tested, and uses the operating system process runner to execute the rewritten command. The final assertions confirm that the rewrite did the right thing from the user's point of view.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (from, new, assert!, assert_eq!, new, write, tempdir, vec!).


### `core/src/tools/network_approval_tests.rs`

`test` · `test suite`

The network approval system is a gatekeeper. When a tool command, such as a shell command running curl, tries to reach the internet, the system may need to ask for permission, remember an approval for the session, or reject the command if policy says network access is not allowed. This test file makes sure that gatekeeper behaves like a careful receptionist: it should not ask the same question twice for the same host, protocol, and port, but it should treat different ports or protocols as separate destinations.

The tests also cover how approvals are shared within a session, how waiting tasks hear about the final decision, and how high-level settings decide whether the approval flow is even available. Another important part is linking a blocked network request back to the tool call that caused it. If there is exactly one active call, the service can mark that call as denied and cancel it. If there are multiple active calls and the blocked request cannot be clearly attributed, the service avoids guessing.

Several tests focus on cleanup. When a call finishes, any stored denial result should be returned once, the active call should be removed, and deferred finish logic should still give later consumers the same result. Without these checks, users could see duplicate prompts, stale approvals, wrong denials, or commands left running after network access was blocked.

#### Function details

##### `pending_approvals_are_deduped_per_host_protocol_and_port`  (lines 13–27)

```
async fn pending_approvals_are_deduped_per_host_protocol_and_port()
```

**Purpose**: This test checks that two approval requests for the same host, protocol, and port share one pending approval instead of creating two separate prompts. This matters because the user should not be asked the same network question twice at the same time.

**Data flow**: It starts with a fresh NetworkApprovalService and builds one key for example.com over http on port 443. It asks the service for a pending approval twice with the same key. The first request should become the owner of the approval, the second should reuse the same pending approval object, and the test confirms both references point to the same shared item.

**Call relations**: The test creates the service with its default setup, then exercises the service method that creates or reuses pending approvals. It uses assertions to prove the first caller owns the decision and later callers wait on that same decision instead of starting a duplicate flow.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert!).


##### `pending_approvals_do_not_dedupe_across_ports`  (lines 30–49)

```
async fn pending_approvals_do_not_dedupe_across_ports()
```

**Purpose**: This test checks that network approval requests are not merged when only the port differs. A port is like a numbered door on the same building, so access to one door should not automatically cover another.

**Data flow**: It creates a fresh service and two approval keys for the same host and protocol but different ports: 443 and 8443. It asks for a pending approval for each key. Both requests should be treated as separate owner requests, and the two pending approval objects should be different.

**Call relations**: The test relies on the service's default state and then calls the pending-approval lookup twice with different keys. Its assertions protect the rule that deduplication is scoped to host, protocol, and port together.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert!).


##### `session_approved_hosts_preserve_protocol_and_port_scope`  (lines 52–107)

```
async fn session_approved_hosts_preserve_protocol_and_port_scope()
```

**Purpose**: This test checks that session-wide approved hosts keep their exact protocol and port information when copied to another service. It prevents a broad, unsafe interpretation such as treating all example.com access as approved.

**Data flow**: It creates a source service and manually fills its session-approved set with three entries for the same host but different protocol or port combinations. It then creates another service and copies the session approvals into it. Finally, it reads back and sorts the copied entries, confirming all three distinct approvals are still present exactly as entered.

**Call relations**: The test uses the service's default setup, directly prepares the approved-host set, and then exercises sync_session_approved_hosts_to. The final equality check confirms that syncing keeps the approval boundaries intact.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_eq!).


##### `sync_session_approved_hosts_to_replaces_existing_target_hosts`  (lines 110–149)

```
async fn sync_session_approved_hosts_to_replaces_existing_target_hosts()
```

**Purpose**: This test checks that copying session-approved hosts into another service replaces the target's old approvals instead of mixing old and new ones. This avoids stale permissions carrying over by accident.

**Data flow**: It creates a source service with one approved host and a target service with a different, stale approved host. After syncing from source to target, it reads the target's approvals. The result should contain only the source approval, with the stale target approval gone.

**Call relations**: The test sets up both services from defaults, mutates their stored approved-host sets, and calls the sync method. Its assertion verifies the sync behaves like replacing a list, not appending to it.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_eq!).


##### `pending_waiters_receive_owner_decision`  (lines 152–166)

```
async fn pending_waiters_receive_owner_decision()
```

**Purpose**: This test checks that tasks waiting on a pending approval receive the decision made by the owner of that approval. It verifies the basic handoff between the person or task deciding and the tasks waiting for that decision.

**Data flow**: It creates a shared PendingHostApproval, starts a background task that waits for a decision, and then sets the decision to AllowOnce. The waiting task completes and returns that same AllowOnce decision.

**Call relations**: The test creates the pending approval with new, shares it through a clone of the shared pointer, and uses a spawned asynchronous task to behave like a waiter. After set_decision runs, the final assertion confirms wait_for_decision receives the chosen value.

*Call graph*: calls 1 internal fn (new); 4 external calls (clone, new, assert_eq!, spawn).


##### `allow_once_and_allow_for_session_both_allow_network`  (lines 169–178)

```
fn allow_once_and_allow_for_session_both_allow_network()
```

**Purpose**: This test checks that both temporary approval and session-long approval translate into the same immediate network result: allow the request. The difference is how long the approval is remembered, not whether the current request may proceed.

**Data flow**: It takes two pending approval decisions, AllowOnce and AllowForSession, and converts each into the lower-level network decision. Both conversions should produce NetworkDecision::Allow.

**Call relations**: This is a small conversion test. It does not set up a service; it directly checks the mapping from user-facing approval choices to the network decision used by the enforcement path.

*Call graph*: 1 external calls (assert_eq!).


##### `only_never_policy_disables_network_approval_flow`  (lines 181–186)

```
fn only_never_policy_disables_network_approval_flow()
```

**Purpose**: This test checks which user approval settings allow the network approval flow to run. Only the setting that says never ask for approval should disable it.

**Data flow**: It passes several AskForApproval settings into the approval-flow check. The Never setting should return false, while OnRequest, OnFailure, and UnlessTrusted should return true.

**Call relations**: The test directly exercises allows_network_approval_flow. Its assertions define the expected behavior for higher-level configuration before the network approval service is used.

*Call graph*: 1 external calls (assert!).


##### `network_approval_flow_is_limited_to_restricted_sandbox_modes`  (lines 189–204)

```
fn network_approval_flow_is_limited_to_restricted_sandbox_modes()
```

**Purpose**: This test checks that network approval prompts are available only in the sandbox modes where they make sense. A sandbox is a safety boundary around a command, and this approval flow is meant for restricted built-in modes, not every permission setup.

**Data flow**: It passes several PermissionProfile values into the permission-profile check. Read-only and workspace-write profiles should allow the approval flow, while fully disabled permissions and an external restricted network policy should not.

**Call relations**: The test directly exercises permission_profile_allows_network_approval_flow. It ties the network approval feature to the broader permission profile rules used before commands run.

*Call graph*: 1 external calls (assert!).


##### `denied_blocked_request`  (lines 206–218)

```
fn denied_blocked_request(host: &str) -> BlockedRequest
```

**Purpose**: This helper builds a sample blocked network request that represents a denied attempt to reach a host. It gives several tests a consistent fake request to feed into the service.

**Data flow**: It receives a host name as text. It builds BlockedRequestArgs with that host, a denial decision, http protocol, port 80, and other fixed details, then turns those arguments into a BlockedRequest. The returned request says, in effect, that this host was blocked by policy.

**Call relations**: Several tests call this helper before record_blocked_request is exercised. It keeps those tests focused on the service behavior instead of repeating the same blocked-request construction.

*Call graph*: calls 1 internal fn (new); called by 3 (blocked_request_policy_does_not_override_user_denial_outcome, record_blocked_request_ignores_ambiguous_unattributed_blocked_requests, record_blocked_request_sets_policy_outcome_for_owner_call).


##### `register_call_with_default_shell_trigger`  (lines 220–244)

```
async fn register_call_with_default_shell_trigger(
    service: &NetworkApprovalService,
    registration_id: &str,
) -> CancellationToken
```

**Purpose**: This helper registers a fake active shell command that would trigger network access. It gives tests a realistic active call to attach approvals or denials to.

**Data flow**: It receives a NetworkApprovalService and a registration id. It creates a cancellation token, then registers a call for a curl command against example.com with a default sandbox permission setup and a test working directory. It returns the cancellation token so the test can later check whether the service cancelled the call.

**Call relations**: Many tests use this helper before recording blocked requests or call outcomes. It hands off to the service's register_call method and supplies the common trigger context that those tests need.

*Call graph*: calls 1 internal fn (register_call); called by 6 (blocked_request_policy_does_not_override_user_denial_outcome, deferred_finish_reuses_denial_result_after_first_consumer, finish_call_returns_denial_and_unregisters_active_call, record_blocked_request_ignores_ambiguous_unattributed_blocked_requests, record_blocked_request_sets_policy_outcome_for_owner_call, record_call_outcome_ignores_inactive_call); 3 external calls (new, test_path_buf, vec!).


##### `active_call_preserves_triggering_command_context`  (lines 247–277)

```
async fn active_call_preserves_triggering_command_context()
```

**Purpose**: This test checks that when a call is registered, the service keeps the exact command context that caused the possible network request. That context is what the user or policy code needs to understand what is asking for access.

**Data flow**: It builds an expected GuardianNetworkAccessTrigger containing the call id, tool name, command arguments, working directory, sandbox permissions, and justification. It registers that call with a command string, then asks the service to resolve the single active call. The returned call should contain the same trigger and command text.

**Call relations**: The test creates a default service, registers one call, and then uses resolve_single_active_call to read it back. Its assertions protect the connection between the active call record and the original command details.

*Call graph*: calls 1 internal fn (default); 4 external calls (new, assert_eq!, test_path_buf, vec!).


##### `record_blocked_request_sets_policy_outcome_for_owner_call`  (lines 280–296)

```
async fn record_blocked_request_sets_policy_outcome_for_owner_call()
```

**Purpose**: This test checks that when there is one active call and a denied network request appears, the service marks that call as denied by policy and cancels it. This prevents the command from continuing after network access has been blocked.

**Data flow**: It creates a service, registers one fake shell call, and keeps the returned cancellation token. It then records a blocked request for example.com. After that, the cancellation token should be cancelled, and taking the call outcome should return a policy-denial message explaining that the domain is not on the allowlist for the current sandbox mode.

**Call relations**: The test uses register_call_with_default_shell_trigger to create the active call and denied_blocked_request to create the blocked event. It then drives record_blocked_request and checks both visible effects: cancellation and stored denial outcome.

*Call graph*: calls 3 internal fn (default, denied_blocked_request, register_call_with_default_shell_trigger); 2 external calls (assert!, assert_eq!).


##### `blocked_request_policy_does_not_override_user_denial_outcome`  (lines 299–314)

```
async fn blocked_request_policy_does_not_override_user_denial_outcome()
```

**Purpose**: This test checks that a user's denial is not overwritten by a later policy-denial record. The user's explicit choice should remain the final reason shown for the call.

**Data flow**: It creates a service, registers one active call, and records that the call was denied by the user. It then records a blocked request for the same general situation. When the outcome is taken, it should still be DeniedByUser, not replaced by a policy denial.

**Call relations**: The test sets up the active call through the shared helper, then calls record_call_outcome before record_blocked_request. It confirms that the blocked-request path respects an outcome that was already recorded.

*Call graph*: calls 3 internal fn (default, denied_blocked_request, register_call_with_default_shell_trigger); 1 external calls (assert_eq!).


##### `finish_call_returns_denial_and_unregisters_active_call`  (lines 317–336)

```
async fn finish_call_returns_denial_and_unregisters_active_call()
```

**Purpose**: This test checks that finishing a call with a stored denial returns an error to the caller and removes the call from the active-call list. It also checks that the stored outcome is consumed so it does not linger.

**Data flow**: It creates a service, registers one active call, and records a policy denial with the message "network denied". It then finishes the call. The result should be a rejected tool error with that message, there should be no single active call left, and taking the outcome afterward should return nothing.

**Call relations**: The test uses the registration helper, stores a DeniedByPolicy outcome, and then exercises finish_call. The assertions connect three cleanup steps: reporting the denial, unregistering the call, and clearing the saved outcome.

*Call graph*: calls 2 internal fn (default, register_call_with_default_shell_trigger); 3 external calls (assert!, assert_eq!, DeniedByPolicy).


##### `deferred_finish_reuses_denial_result_after_first_consumer`  (lines 339–366)

```
async fn deferred_finish_reuses_denial_result_after_first_consumer()
```

**Purpose**: This test checks that deferred finish logic gives the same denial result to more than one consumer. This is important when different parts of the system may ask for the result after the network approval path has already finished once.

**Data flow**: It registers one call, builds a DeferredNetworkApproval with the call's registration id, cancellation token, and an empty one-time result cell. It records a policy denial, then calls finish on the deferred object twice. Both calls should return the same rejected tool error with the same denial message.

**Call relations**: The test uses register_call_with_default_shell_trigger to create the call, then constructs DeferredNetworkApproval directly. It checks that DeferredNetworkApproval::finish caches the finish result instead of losing it after the first caller.

*Call graph*: calls 2 internal fn (default, register_call_with_default_shell_trigger); 4 external calls (new, new, assert!, DeniedByPolicy).


##### `record_call_outcome_ignores_inactive_call`  (lines 369–384)

```
async fn record_call_outcome_ignores_inactive_call()
```

**Purpose**: This test checks that the service does not record or act on an outcome for a call that has already been unregistered. This avoids cancelling or reporting errors for work that is no longer active.

**Data flow**: It creates a service, registers one call, and then unregisters that call. Afterward it tries to record a policy denial for the same registration id. The cancellation token should not be cancelled, and there should be no stored outcome to take.

**Call relations**: The test prepares a normal active call through the helper, removes it with unregister_call, and then calls record_call_outcome. Its assertions prove that inactive registrations are ignored.

*Call graph*: calls 2 internal fn (default, register_call_with_default_shell_trigger); 3 external calls (assert!, assert_eq!, DeniedByPolicy).


##### `record_blocked_request_ignores_ambiguous_unattributed_blocked_requests`  (lines 387–398)

```
async fn record_blocked_request_ignores_ambiguous_unattributed_blocked_requests()
```

**Purpose**: This test checks that when multiple calls are active and a blocked request cannot be tied to one specific call, the service does not guess. Guessing could blame or cancel the wrong command.

**Data flow**: It creates a service and registers two active shell calls. It then records one denied blocked request for example.com without any clear attribution to either call. When it checks both registrations, neither should have a stored outcome.

**Call relations**: The test uses the shared registration helper twice and denied_blocked_request once. It then drives record_blocked_request and confirms the service only assigns a blocked request when ownership is unambiguous.

*Call graph*: calls 3 internal fn (default, denied_blocked_request, register_call_with_default_shell_trigger); 1 external calls (assert_eq!).


### `core/src/tools/sandboxing_tests.rs`

`test` · `test run`

This file is a set of safety checks for the code that runs shell commands and decides how much access they should get. A sandbox is a restricted area for running commands, like letting someone work at a desk where only certain drawers are unlocked. The tests make sure the system asks for permission when it should, skips asking when it is safe to do so, and never drops important filesystem protections by accident.

The first tests focus on the permission request message for a bash command. They confirm that the message includes the command, and only includes a human-readable description when one was actually provided. This matters because approval prompts should be clear but not filled with misleading empty fields.

The rest of the file checks execution approval and sandbox override rules. It compares different approval policies, such as “ask when requested” and “granular approval,” where individual approval features can be turned on or off. It also checks how filesystem sandbox policies affect whether a command can bypass restrictions.

The most important safety case is denied reads, such as blocking access to `*.env` files. These tests confirm that if a policy says certain files must not be read, the system will not bypass the sandbox in a way that would silently remove that protection.

#### Function details

##### `bash_permission_request_payload_omits_missing_description`  (lines 12–20)

```
fn bash_permission_request_payload_omits_missing_description()
```

**Purpose**: This test checks that a bash permission request does not include a description field when no description was provided. That keeps the request payload clean and avoids pretending there is extra context when there is none.

**Data flow**: It starts with a bash command, `echo hi`, and no description. It builds the expected permission request by hand, containing the bash tool name and only the command in the input data. The test then compares the real payload against that expected shape; if an unwanted description appears, the test fails.

**Call relations**: During the test suite, this test exercises `PermissionRequestPayload::bash` through a direct comparison. It relies on the assertion helper to catch any change in the payload format, so later code that displays or sends permission requests can depend on this exact behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `bash_permission_request_payload_includes_description_when_present`  (lines 23–37)

```
fn bash_permission_request_payload_includes_description_when_present()
```

**Purpose**: This test checks that a bash permission request includes the description when one is supplied. The description gives a reviewer extra context, such as why a command may need network access.

**Data flow**: It starts with the command `echo hi` and a description string. It expects the resulting request to name the bash tool and include both the command and the description in the input data. The output is not returned to other code here; the test passes only if the built payload exactly matches the expected one.

**Call relations**: This test is the companion to the missing-description test. Together they define when `PermissionRequestPayload::bash` should and should not add optional context before a permission prompt is shown or transmitted elsewhere.

*Call graph*: 1 external calls (assert_eq!).


##### `external_sandbox_skips_exec_approval_on_request`  (lines 40–51)

```
fn external_sandbox_skips_exec_approval_on_request()
```

**Purpose**: This test checks that an external sandbox does not require an extra execution approval under the “ask on request” policy. In plain terms, if another sandboxing system is already responsible for protection, this path should not unnecessarily stop the command for approval.

**Data flow**: It provides an approval policy of `OnRequest` and an external filesystem sandbox policy. It asks the approval-decision function what should happen. The expected result is to skip approval, without bypassing the sandbox and without suggesting any policy change.

**Call relations**: This test calls into the default execution approval decision logic and verifies one special case. It protects the flow where the broader tool-running code asks, “Do I need to prompt the user before running this command?”

*Call graph*: 1 external calls (assert_eq!).


##### `restricted_sandbox_requires_exec_approval_on_request`  (lines 54–65)

```
fn restricted_sandbox_requires_exec_approval_on_request()
```

**Purpose**: This test checks that the normal restricted sandbox still requires approval when the policy says approvals should happen on request. It makes sure restricted execution does not accidentally become automatic.

**Data flow**: It provides the `OnRequest` approval policy and the default filesystem sandbox policy. The approval logic produces a decision. The expected decision says approval is needed, with no extra reason text and no suggested policy amendment.

**Call relations**: This test covers the ordinary restricted-sandbox path used by the command execution system. It pairs with the external-sandbox test to show that the same approval policy can lead to different outcomes depending on what kind of sandbox is active.

*Call graph*: 1 external calls (assert_eq!).


##### `default_exec_approval_requirement_rejects_sandbox_prompt_when_granular_disables_it`  (lines 68–86)

```
fn default_exec_approval_requirement_rejects_sandbox_prompt_when_granular_disables_it()
```

**Purpose**: This test checks that granular approval settings can forbid a sandbox approval prompt. Granular approval means separate switches control separate kinds of permission prompts, instead of one all-or-nothing setting.

**Data flow**: It builds a granular approval configuration where sandbox approval is turned off while several other approval features remain on. It passes that policy and the default sandbox policy into the approval-decision function. The expected result is a forbidden decision with a clear reason saying sandbox approval prompts are disallowed.

**Call relations**: This test exercises the branch where `AskForApproval::Granular` is used. It confirms that the execution approval logic respects the specific `sandbox_approval` switch instead of assuming all granular configurations allow sandbox prompts.

*Call graph*: calls 1 internal fn (default); 2 external calls (Granular, assert_eq!).


##### `default_exec_approval_requirement_keeps_prompt_when_granular_allows_sandbox_approval`  (lines 89–108)

```
fn default_exec_approval_requirement_keeps_prompt_when_granular_allows_sandbox_approval()
```

**Purpose**: This test checks the opposite granular-approval case: when sandbox approval is allowed, the system should still ask for approval under the default sandbox policy. It prevents a configuration mix-up where allowing prompts might accidentally skip them.

**Data flow**: It builds a granular approval configuration with sandbox approval turned on. It sends that policy and the default filesystem sandbox policy into the approval-decision function. The expected result says approval is needed, with no special reason and no proposed policy amendment.

**Call relations**: This test works alongside the granular-disabled test. Together they show that the approval decision follows the sandbox-approval flag precisely: off means forbidden, on means a normal approval prompt can be requested.

*Call graph*: calls 1 internal fn (default); 2 external calls (Granular, assert_eq!).


##### `additional_permissions_allow_bypass_sandbox_first_attempt_when_execpolicy_skips`  (lines 111–123)

```
fn additional_permissions_allow_bypass_sandbox_first_attempt_when_execpolicy_skips()
```

**Purpose**: This test checks that when extra permissions are requested and the execution policy already says approval can be skipped with sandbox bypass, the first attempt is allowed to bypass the sandbox. It verifies the fast path for commands that are already permitted to run with more access.

**Data flow**: It starts with sandbox permissions set to `WithAdditionalPermissions`, an execution approval result that skips approval and allows sandbox bypass, and the default filesystem sandbox policy. It asks the sandbox override logic what to do for the first command attempt. The expected answer is to bypass the sandbox on that first attempt.

**Call relations**: This test exercises `sandbox_override_for_first_attempt`, the decision point that turns approval results and requested sandbox permissions into an actual execution mode. It confirms that the tool runner can honor an already-approved bypass when no extra filesystem denial blocks it.

*Call graph*: 1 external calls (assert_eq!).


##### `guardian_bypasses_sandbox_for_explicit_escalation_on_first_attempt`  (lines 126–138)

```
fn guardian_bypasses_sandbox_for_explicit_escalation_on_first_attempt()
```

**Purpose**: This test checks that an explicit escalation request can bypass the sandbox on the first attempt, even when the skip decision itself did not ask to bypass. Escalation here means the command is marked as needing higher access than the default sandbox allows.

**Data flow**: It provides `RequireEscalated` sandbox permissions, an execution approval result that skips approval but does not set its own bypass flag, and the default filesystem sandbox policy. The sandbox override logic combines those inputs. The expected result is still to bypass the sandbox for the first attempt.

**Call relations**: This test covers another path through `sandbox_override_for_first_attempt`. It shows that an explicit elevated-permission request can drive the execution mode, not only the bypass flag inside the approval requirement.

*Call graph*: 1 external calls (assert_eq!).


##### `deny_read_blocks_explicit_escalation_and_policy_bypass`  (lines 141–195)

```
fn deny_read_blocks_explicit_escalation_and_policy_bypass()
```

**Purpose**: This test checks a critical safety rule: if the sandbox policy denies reading certain files, the system must not bypass the sandbox in a way that removes that deny rule. It uses `*.env` files as the example, because those often contain secrets.

**Data flow**: It first builds a restricted filesystem policy with a deny rule for paths matching `**/*.env`. It then tries several decisions against that policy: explicit escalation, unsandboxed execution checks, permission preservation, and an execution-policy bypass. Each expected result keeps the command sandboxed or downgrades the requested sandbox permissions so the denied-read rule stays in force. It also compares the same preservation helper against the default policy to confirm escalation is only blocked when denied reads are present.

**Call relations**: This test ties together several safety helpers: `sandbox_override_for_first_attempt`, `unsandboxed_execution_allowed`, and `sandbox_permissions_preserving_denied_reads`. It tells the story of a command that might otherwise receive broader access, and verifies that denied-read filesystem rules have the final say.

*Call graph*: calls 1 internal fn (restricted); 3 external calls (assert!, assert_eq!, vec!).


### `core/src/tools/runtimes/apply_patch_tests.rs`

`test` · `test run`

The apply-patch tool changes files, so it sits at a sensitive point in the system: it can create or edit real files on disk. This test file checks that the surrounding safety machinery behaves correctly before that happens. In plain terms, it verifies that the tool asks for approval when it should, describes the patch accurately to reviewers, builds permission requests in the format other parts of the system expect, and carries the correct environment and sandbox information along with each request.

A sandbox is a restricted area where code can run with limited access, like letting someone work only at a specific desk instead of giving them keys to the whole building. These tests check both sides: when a real sandbox attempt exists, the apply-patch runtime should report the correct file-system permissions and working folder; when there is no sandbox, it should not pretend there is one.

Most tests build a small fake patch request against a temporary file. They then call one narrow runtime method and compare the result with the expected value. This matters because approval keys, aliases, working directories, and sandbox details are small pieces of data, but if any are wrong the system might skip a needed approval, ask the wrong reviewer question, or apply a patch under the wrong security rules.

#### Function details

##### `test_turn_environment`  (lines 18–25)

```
fn test_turn_environment(environment_id: &str) -> crate::session::turn_context::TurnEnvironment
```

**Purpose**: This helper builds a simple fake turn environment for tests. A turn environment is the context for one interaction, including which execution environment is being used and what base path represents it.

**Data flow**: It takes an environment id as text. It creates a default test execution environment, points it at the system temporary directory, leaves the shell unset, and returns a ready-to-use TurnEnvironment for the test request.

**Call relations**: The individual tests call this helper whenever they need to build an ApplyPatchRequest. It keeps those tests focused on what they are checking instead of repeating the setup for a fake local or remote environment each time.

*Call graph*: calls 3 internal fn (new, default_for_tests, from_abs_path); called by 6 (approval_keys_include_environment_id, file_system_sandbox_context_uses_active_attempt, guardian_review_request_includes_patch_context, no_sandbox_attempt_has_no_file_system_context, permission_request_payload_uses_apply_patch_hook_name_and_aliases, sandbox_cwd_uses_patch_action_cwd); 2 external calls (temp_dir, new).


##### `wants_no_sandbox_approval_granular_respects_sandbox_flag`  (lines 28–49)

```
fn wants_no_sandbox_approval_granular_respects_sandbox_flag()
```

**Purpose**: This test checks that the runtime correctly decides whether sandbox approval is wanted when approval settings are more detailed. It protects the rule that the specific sandbox-approval flag must be respected.

**Data flow**: It creates an ApplyPatchRuntime, then feeds it different approval modes. It expects normal on-request approval to require sandbox approval, expects granular settings with sandbox approval turned off to say no, and expects granular settings with sandbox approval turned on to say yes.

**Call relations**: This test calls directly into the runtime decision method. It does not hand work off elsewhere; its role is to lock down the approval decision that later patch execution relies on.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert!).


##### `guardian_review_request_includes_patch_context`  (lines 52–88)

```
async fn guardian_review_request_includes_patch_context()
```

**Purpose**: This test makes sure a request sent to the guardian approval system contains the actual patch details. The guardian is the review step that needs enough context to approve or reject a file change.

**Data flow**: It creates a fake patch that adds text to a temporary file, wraps that in an ApplyPatchRequest, and asks the runtime to build a guardian review request. The output is checked to ensure it includes the call id, working directory, affected files, and patch text.

**Call relations**: The test uses the shared turn-environment helper to build a realistic request, then calls the runtime method that formats the guardian request. It verifies that the approval layer receives the same patch context that the apply-patch action was built with.

*Call graph*: calls 3 internal fn (new_add_for_test, build_guardian_review_request, test_turn_environment); 4 external calls (from, assert_eq!, temp_dir, vec!).


##### `permission_request_payload_uses_apply_patch_hook_name_and_aliases`  (lines 91–124)

```
async fn permission_request_payload_uses_apply_patch_hook_name_and_aliases()
```

**Purpose**: This test checks the permission-request message produced for apply-patch. It ensures the message names the tool as apply_patch and also includes aliases like Write and Edit, so permission rules that refer to those names can still match.

**Data flow**: It creates a fake add-file patch, puts it into an ApplyPatchRequest, and asks the runtime for the permission request payload. It then checks that the payload has the expected tool name, expected matcher aliases, and a JSON input containing the patch command.

**Call relations**: The test calls the runtime method that prepares permission-request data. That data is meant for the broader approval and permission system, so this test protects the contract between apply-patch and that system.

*Call graph*: calls 3 internal fn (new_add_for_test, new, test_turn_environment); 4 external calls (new, assert_eq!, temp_dir, vec!).


##### `approval_keys_include_environment_id`  (lines 127–156)

```
async fn approval_keys_include_environment_id()
```

**Purpose**: This test confirms that approval keys include not only the file path but also the environment id. That matters because the same path may mean different things in different environments, such as local and remote machines.

**Data flow**: It creates an ApplyPatchRequest using a fake environment id of remote and a temporary file path. It asks the runtime for approval keys and checks that the serialized result contains both the remote environment id and the path.

**Call relations**: The test builds its request with the shared helper, then calls the runtime’s approval-key builder. The resulting key is used by approval caching or matching, so this test makes sure approvals are scoped to the right environment.

*Call graph*: calls 3 internal fn (new_add_for_test, new, test_turn_environment); 4 external calls (new, assert_eq!, temp_dir, vec!).


##### `sandbox_cwd_uses_patch_action_cwd`  (lines 159–178)

```
async fn sandbox_cwd_uses_patch_action_cwd()
```

**Purpose**: This test checks that the sandbox working directory comes from the patch action itself. The working directory is the folder context the sandbox should use when applying the patch.

**Data flow**: It creates a fake patch request for a temporary file, then asks the runtime for the sandbox current working directory. The returned value is expected to be the same directory stored on the ApplyPatchAction.

**Call relations**: The test calls the runtime method that supplies sandbox setup information. This connects the patch action to the sandbox runner, ensuring the sandbox starts from the same location the patch was prepared for.

*Call graph*: calls 3 internal fn (new_add_for_test, new, test_turn_environment); 4 external calls (new, assert_eq!, temp_dir, vec!).


##### `file_system_sandbox_context_uses_active_attempt`  (lines 181–252)

```
async fn file_system_sandbox_context_uses_active_attempt()
```

**Purpose**: This test verifies that when a real sandbox attempt is active, the runtime builds a file-system sandbox context from that attempt. It checks that extra file permissions and platform-specific sandbox settings are preserved.

**Data flow**: It creates a patch request with additional read-write permission for a temporary path, builds a sandbox attempt using a macOS-style sandbox type, and asks the runtime for a sandbox context. It then calculates the expected effective permissions and compares them with the returned context, along with the sandbox working directory and Windows/Linux-related settings carried through the attempt.

**Call relations**: This test combines several pieces: the request, the additional permission profile, and the active SandboxAttempt. It calls the runtime conversion method and verifies that the result is suitable for downstream file-system sandbox reporting or execution.

*Call graph*: calls 10 internal fn (new_add_for_test, file_system_sandbox_context_for_attempt, test_turn_environment, from_read_write_roots, from_runtime_permissions, default, new, effective_file_system_sandbox_policy, effective_network_sandbox_policy, from_abs_path); 6 external calls (new, new, assert_eq!, temp_dir, from_ref, vec!).


##### `no_sandbox_attempt_has_no_file_system_context`  (lines 255–292)

```
async fn no_sandbox_attempt_has_no_file_system_context()
```

**Purpose**: This test checks the opposite case from the sandbox-context test: if the chosen sandbox type is none, the runtime should return no file-system sandbox context. This avoids reporting restrictions that are not actually in force.

**Data flow**: It creates a patch request and a sandbox attempt whose sandbox type is None and whose permissions are disabled. It asks the runtime for a file-system sandbox context and expects the answer to be None.

**Call relations**: The test uses the same request-building pattern as the other sandbox tests, then calls the same runtime conversion method. It confirms that the runtime only produces sandbox context when there is a real sandbox attempt to describe.

*Call graph*: calls 4 internal fn (new_add_for_test, test_turn_environment, new, from_abs_path); 5 external calls (new, assert_eq!, temp_dir, from_ref, vec!).


### `core/src/tools/runtimes/mod_tests.rs`

`test` · `test run`

When Codex runs a command for a user, it may need to run it inside a sandbox, reuse the user's shell setup, add package helper paths, and avoid leaking stale network proxy settings. This test file checks those details from the outside, like rehearsing many tricky launch situations before trusting the real command runner. It creates small fake shells, temporary snapshot files, and test environments, then asks the runtime code to rewrite commands or prepare execution requests. The tests verify that explicit user choices win over saved shell snapshots, that secrets are not copied into command-line arguments, that proxy variables are removed or restored at the right time, and that PATH entries are kept in a safe order without empty entries that could accidentally mean “run something from the current folder.” It also checks sandbox escalation behavior: when a command is explicitly allowed to run outside the sandbox, Codex should not keep its own managed proxy environment attached. A small fake config reloader and test network proxy stand in for the real network proxy system so these tests can run without depending on live configuration reloads.

#### Function details

##### `StaticReloader::source_label`  (lines 38–40)

```
fn source_label(&self) -> String
```

**Purpose**: Gives the fake proxy configuration reloader a human-readable name. This helps the test proxy satisfy the same interface as the real reloader without doing real configuration work.

**Data flow**: It takes no outside data beyond the fake reloader itself and returns the fixed text “test config state.” Nothing else is changed.

**Call relations**: The test network proxy builds a proxy state using StaticReloader. When the proxy system asks where its configuration came from, this method supplies a simple test label.


##### `StaticReloader::maybe_reload`  (lines 42–44)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Pretends to check whether proxy configuration has changed, but always says there is no new configuration. This keeps tests stable and avoids background config changes.

**Data flow**: It receives the fake reloader, creates an asynchronous result, and returns success with no replacement configuration. No state is updated.

**Call relations**: The proxy state can call this through the ConfigReloader interface during proxy setup or use. In these tests it deliberately hands back “nothing changed” so command-preparation behavior is the only thing being tested.

*Call graph*: 1 external calls (pin).


##### `StaticReloader::reload_now`  (lines 46–48)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Rejects forced proxy configuration reloads in tests. A forced reload is outside what this fake object is meant to simulate.

**Data flow**: It receives the fake reloader, creates an asynchronous result, and returns an error explaining that forced reload is not supported. It does not change any proxy state.

**Call relations**: This exists because the real ConfigReloader interface requires it. If production-like code asks the fake reloader to force a reload, the test fails clearly instead of silently doing something misleading.

*Call graph*: 2 external calls (pin, anyhow!).


##### `shell_with_snapshot`  (lines 51–63)

```
fn shell_with_snapshot(
    shell_type: ShellType,
    shell_path: &str,
    snapshot_path: AbsolutePathBuf,
) -> (Shell, AbsolutePathBuf)
```

**Purpose**: Builds a small pair of test objects: a shell description and the path to a saved shell snapshot. Tests use this to avoid repeating the same setup.

**Data flow**: It receives a shell kind, a shell executable path as text, and a snapshot file path. It converts the shell path into a path object and returns both the Shell object and the snapshot path.

**Call relations**: Many snapshot-wrapping tests call this before asking maybe_wrap_shell_lc_with_snapshot to rewrite a command. It gives those tests a consistent “user shell plus saved setup file” starting point.

*Call graph*: called by 19 (maybe_wrap_shell_lc_with_snapshot_applies_explicit_path_override, maybe_wrap_shell_lc_with_snapshot_bootstraps_in_user_shell, maybe_wrap_shell_lc_with_snapshot_clears_stale_codex_git_ssh_command_without_live_command, maybe_wrap_shell_lc_with_snapshot_does_not_embed_override_values_in_argv, maybe_wrap_shell_lc_with_snapshot_escapes_single_quotes, maybe_wrap_shell_lc_with_snapshot_keeps_snapshot_path_without_override, maybe_wrap_shell_lc_with_snapshot_keeps_user_proxy_env_when_proxy_inactive, maybe_wrap_shell_lc_with_snapshot_preserves_trailing_args, maybe_wrap_shell_lc_with_snapshot_preserves_unset_override_variables, maybe_wrap_shell_lc_with_snapshot_preserves_zsh_fork_path_prepend (+9 more)); 1 external calls (from).


##### `test_network_proxy`  (lines 65–80)

```
async fn test_network_proxy() -> anyhow::Result<NetworkProxy>
```

**Purpose**: Creates a lightweight network proxy object for tests. It gives sandbox-preparation tests a realistic proxy shape without depending on real proxy configuration reloads.

**Data flow**: It starts from default proxy configuration and default constraints, wraps them in proxy state with StaticReloader, assigns fixed local HTTP and SOCKS addresses, and asynchronously builds a NetworkProxy. The result is a proxy object ready to apply environment variables in a test.

**Call relations**: The explicit sandbox-escalation test calls this first. The proxy it returns is then used to mark an environment as proxy-enabled so the test can confirm those Codex proxy settings are later stripped when escalation disables managed networking.

*Call graph*: calls 2 internal fn (builder, with_reloader); called by 1 (explicit_escalation_prepares_exec_without_managed_network); 4 external calls (new, build_config_state, default, default).


##### `explicit_escalation_prepares_exec_without_managed_network`  (lines 83–152)

```
async fn explicit_escalation_prepares_exec_without_managed_network() -> anyhow::Result<()>
```

**Purpose**: Checks that an explicitly escalated command is prepared without Codex-managed network proxy settings. This matters because a command allowed to run outside the sandbox should not accidentally inherit Codex’s internal proxy wiring.

**Data flow**: The test creates a fake proxy, a temporary working directory, an environment with both custom and proxy variables, and a simple echo command. It builds a sandbox command, prepares an execution request through SandboxAttempt, and then checks that paths are converted back correctly, managed network information is absent, proxy and custom certificate variables are gone, and the unrelated custom environment variable remains.

**Call relations**: The test runner calls this asynchronous test. It uses test_network_proxy, build_sandbox_command, exec_env_for_sandbox_permissions, managed_network_for_sandbox_permissions, and SandboxAttempt::env_for as a complete rehearsal of preparing an escalated tool command.

*Call graph*: calls 4 internal fn (test_network_proxy, managed_network_for_sandbox_permissions, new, from_abs_path); 5 external calls (from, assert_eq!, from_ref, tempdir, vec!).


##### `explicit_escalation_preserves_user_ca_env`  (lines 155–170)

```
fn explicit_escalation_preserves_user_ca_env()
```

**Purpose**: Checks that a user-provided certificate setting is not removed just because a Codex proxy marker is present. Certificate settings tell programs which trusted certificate file to use.

**Data flow**: The test starts with an environment containing the proxy-active marker and SSL_CERT_FILE pointing at a custom file. It runs the environment through the sandbox-permission filter and verifies that SSL_CERT_FILE still has the same value.

**Call relations**: The test runner calls this as a focused check of exec_env_for_sandbox_permissions. It complements the larger escalation test by proving user certificate choices survive the filtering step.

*Call graph*: 2 external calls (from, assert_eq!).


##### `runtime_path_prepends_records_runtime_path_prepend`  (lines 174–190)

```
fn runtime_path_prepends_records_runtime_path_prepend()
```

**Purpose**: Checks that adding a runtime helper directory to PATH updates both the live environment and the replay record. The replay record is needed later when a shell snapshot resets PATH.

**Data flow**: The test starts with PATH set to /usr/bin:/bin and an empty RuntimePathPrepends record. It prepends /package/codex-path, then verifies PATH begins with that directory and the same directory is recorded once.

**Call relations**: The test runner calls this to exercise RuntimePathPrepends::prepend. Later snapshot-wrapping tests depend on this behavior so runtime-added paths are restored after loading a snapshot.

*Call graph*: 4 external calls (from, from, assert_eq!, default).


##### `runtime_path_prepends_drops_empty_path_entries`  (lines 194–213)

```
fn runtime_path_prepends_drops_empty_path_entries()
```

**Purpose**: Checks that PATH cleanup removes empty entries while adding a runtime helper path. Empty PATH entries can mean “search the current directory,” which is usually unsafe.

**Data flow**: The test starts with a PATH that contains leading, repeated, and trailing empty sections plus an existing copy of the helper directory. After prepending, it expects a clean PATH with the helper directory first and no empty entries, and it expects the helper path to be recorded once.

**Call relations**: The test runner calls this as a safety check for RuntimePathPrepends::prepend. It proves the helper does not preserve risky current-directory lookups while reshaping PATH.

*Call graph*: 4 external calls (from, from, assert_eq!, default).


##### `runtime_path_prepends_ignores_empty_path_entry`  (lines 217–233)

```
fn runtime_path_prepends_ignores_empty_path_entry()
```

**Purpose**: Checks that asking to prepend an empty path does nothing. This prevents accidental blank PATH components from being recorded or added.

**Data flow**: The test starts with a normal PATH and an empty RuntimePathPrepends record. It passes an empty path to prepend, then verifies PATH and the record are unchanged.

**Call relations**: The test runner calls this to cover the no-op case for RuntimePathPrepends::prepend. It guards against later snapshot replay adding meaningless or unsafe entries.

*Call graph*: 4 external calls (from, new, assert_eq!, default).


##### `prepend_zsh_fork_bin_to_path_ignores_empty_parent`  (lines 237–251)

```
fn prepend_zsh_fork_bin_to_path_ignores_empty_parent()
```

**Purpose**: Checks that the zsh helper does not modify PATH when the shell path has no usable parent directory. The zsh helper only makes sense when Codex can find the directory that contains the shell executable.

**Data flow**: The test starts with PATH set and passes the relative path zsh, whose parent directory is empty. The helper returns no update and leaves PATH exactly as it was.

**Call relations**: The test runner calls this to exercise prepend_zsh_fork_bin_to_path. It protects apply_zsh_fork_path_prepend from recording bogus path additions when the shell path is incomplete.

*Call graph*: 3 external calls (from, from, assert_eq!).


##### `apply_zsh_fork_path_prepend_uses_shell_parent`  (lines 255–273)

```
fn apply_zsh_fork_path_prepend_uses_shell_parent()
```

**Purpose**: Checks that when Codex uses its bundled zsh fork, the directory containing that zsh binary is placed at the front of PATH and recorded for replay.

**Data flow**: The test starts with a normal PATH and an empty runtime prepend record. It passes a full zsh executable path, then verifies PATH begins with that executable’s parent directory and the parent directory is stored in RuntimePathPrepends.

**Call relations**: The test runner calls this to exercise apply_zsh_fork_path_prepend. Snapshot-wrapping code later uses the recorded prepend so the bundled zsh directory stays available even after loading saved shell state.

*Call graph*: 4 external calls (from, from, assert_eq!, default).


##### `apply_zsh_fork_path_prepend_moves_existing_shell_parent_to_front`  (lines 277–301)

```
fn apply_zsh_fork_path_prepend_moves_existing_shell_parent_to_front()
```

**Purpose**: Checks that the zsh binary directory is moved to the front of PATH if it is already present. This avoids duplicate PATH entries while still giving the bundled zsh tools priority.

**Data flow**: The test starts with PATH containing the zsh directory twice in the middle and at the end. After applying the prepend, it expects one clean copy at the front, followed by the other real directories, and one replay record.

**Call relations**: The test runner calls this as a deduplication check for apply_zsh_fork_path_prepend. It supports the broader PATH behavior tested later during snapshot replay.

*Call graph*: 4 external calls (from, from, assert_eq!, default).


##### `explicit_escalation_keeps_user_proxy_env_without_codex_marker`  (lines 304–320)

```
fn explicit_escalation_keeps_user_proxy_env_without_codex_marker()
```

**Purpose**: Checks that a user’s own proxy setting is preserved when it is not marked as Codex-managed. A normal HTTP_PROXY might be part of the user’s workplace network setup.

**Data flow**: The test starts with HTTP_PROXY and another custom variable. It filters the environment for an escalated command and verifies both values remain unchanged.

**Call relations**: The test runner calls this to pin down the difference between Codex proxy variables and user proxy variables. It exercises exec_env_for_sandbox_permissions in a case where proxy removal would be wrong.

*Call graph*: 2 external calls (from, assert_eq!).


##### `maybe_wrap_shell_lc_with_snapshot_bootstraps_in_user_shell`  (lines 323–348)

```
fn maybe_wrap_shell_lc_with_snapshot_bootstraps_in_user_shell()
```

**Purpose**: Checks that a shell command is wrapped so it first loads the user’s saved shell snapshot using the user’s session shell. This lets commands run with the same setup the user normally has.

**Data flow**: The test writes a snapshot file, describes the session shell as zsh, and supplies a bash -lc command. The wrapper returns a new command that starts /bin/zsh with -c, sources the snapshot, and then executes the original bash command.

**Call relations**: The test runner calls this as a basic behavior check for maybe_wrap_shell_lc_with_snapshot. It uses shell_with_snapshot for setup and then inspects the rewritten command text.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 7 external calls (new, assert!, assert_eq!, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_escapes_single_quotes`  (lines 351–373)

```
fn maybe_wrap_shell_lc_with_snapshot_escapes_single_quotes()
```

**Purpose**: Checks that commands containing single quotes are safely embedded in the wrapper command. Without this, a command like echo 'hello' could be broken or interpreted incorrectly by the shell.

**Data flow**: The test creates a snapshot and a command whose script contains single quotes. After wrapping, it checks that the generated shell text uses the standard safe quote-breaking pattern so the original script survives intact.

**Call relations**: The test runner calls this to verify the quoting behavior inside maybe_wrap_shell_lc_with_snapshot. It protects all later wrapped shell commands that include quoted text.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 6 external calls (new, assert!, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_uses_bash_bootstrap_shell`  (lines 376–401)

```
fn maybe_wrap_shell_lc_with_snapshot_uses_bash_bootstrap_shell()
```

**Purpose**: Checks that when the user’s session shell is bash, the snapshot wrapper uses bash to load the snapshot. The bootstrap shell should match the user environment being restored.

**Data flow**: The test creates a bash session shell and an original zsh command. The rewritten command starts /bin/bash with -c, sources the snapshot, and then executes the original zsh command.

**Call relations**: The test runner calls this to cover one supported shell type in maybe_wrap_shell_lc_with_snapshot. Together with the zsh and sh tests, it verifies shell selection.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 7 external calls (new, assert!, assert_eq!, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_uses_sh_bootstrap_shell`  (lines 404–429)

```
fn maybe_wrap_shell_lc_with_snapshot_uses_sh_bootstrap_shell()
```

**Purpose**: Checks that the wrapper can use plain sh as the bootstrap shell when that is the user’s session shell. This matters for systems or users that do not use bash or zsh.

**Data flow**: The test creates an sh session shell and a bash -lc command. The wrapper returns a command that starts /bin/sh with -c, loads the snapshot, and then runs the original bash command.

**Call relations**: The test runner calls this to cover the sh path in maybe_wrap_shell_lc_with_snapshot. It confirms the wrapper does not assume only bash or zsh exist.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 7 external calls (new, assert!, assert_eq!, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_preserves_trailing_args`  (lines 432–459)

```
fn maybe_wrap_shell_lc_with_snapshot_preserves_trailing_args()
```

**Purpose**: Checks that extra arguments after the shell script are preserved when a command is wrapped. Shell commands sometimes use these trailing values as $0, $1, and so on.

**Data flow**: The test builds a bash -lc command with a script plus two extra arguments. After wrapping, it checks that the generated exec command includes the original script and both trailing arguments with safe quoting.

**Call relations**: The test runner calls this to exercise maybe_wrap_shell_lc_with_snapshot on a command shape with more than the usual three arguments. It ensures the wrapper does not silently drop data.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 6 external calls (new, assert!, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_restores_explicit_override_precedence`  (lines 462–498)

```
fn maybe_wrap_shell_lc_with_snapshot_restores_explicit_override_precedence()
```

**Purpose**: Checks that explicit environment overrides win over values loaded from a shell snapshot. If Codex intentionally sets a value for a worktree command, the saved user shell should not overwrite it.

**Data flow**: The test writes a snapshot that sets TEST_ENV_SNAPSHOT and SNAPSHOT_ONLY. It wraps a command, runs it with TEST_ENV_SNAPSHOT set to the worktree value, and verifies the output uses the worktree value for the overridden variable while still receiving SNAPSHOT_ONLY from the snapshot.

**Call relations**: The test runner calls this and actually executes the rewritten command. It proves maybe_wrap_shell_lc_with_snapshot restores selected live environment values after sourcing the snapshot.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (from, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_restores_codex_thread_id_from_env`  (lines 501–532)

```
fn maybe_wrap_shell_lc_with_snapshot_restores_codex_thread_id_from_env()
```

**Purpose**: Checks that CODEX_THREAD_ID from the live command environment is restored after loading a snapshot. This keeps nested or current Codex session identity from being replaced by an older saved value.

**Data flow**: The test writes a snapshot with CODEX_THREAD_ID set to a parent value, wraps a command that prints it, then runs the command with CODEX_THREAD_ID set to a nested value. The output must be the nested value.

**Call relations**: The test runner calls this as a focused environment-restoration check for maybe_wrap_shell_lc_with_snapshot. It shows that important Codex bookkeeping variables are protected from stale snapshots.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (from, new, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_restores_proxy_env_from_process_env`  (lines 535–581)

```
fn maybe_wrap_shell_lc_with_snapshot_restores_proxy_env_from_process_env()
```

**Purpose**: Checks that live proxy variables are restored after a snapshot loads stale proxy values. This prevents commands from using old proxy ports saved in a previous shell snapshot.

**Data flow**: The test writes a snapshot with stale PIP_PROXY, HTTP_PROXY, http_proxy, and GIT_SSH_COMMAND values. It wraps a print command and runs it with fresh proxy values in the process environment. The proxy URL variables print the fresh values, while the generic GIT_SSH_COMMAND remains the snapshot value on non-macOS behavior covered here.

**Call relations**: The test runner calls this and executes the rewritten shell command. It verifies maybe_wrap_shell_lc_with_snapshot can repair proxy-related environment after sourcing a snapshot.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (new, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_refreshes_codex_proxy_git_ssh_command`  (lines 585–625)

```
fn maybe_wrap_shell_lc_with_snapshot_refreshes_codex_proxy_git_ssh_command()
```

**Purpose**: On macOS, checks that a Codex-managed Git SSH proxy command is refreshed from the live environment instead of keeping a stale snapshot value. Git SSH proxy commands tell git how to connect through a proxy.

**Data flow**: The test writes a snapshot containing an old Codex-marked Git SSH command and runs a wrapped command with a fresh Codex-marked command in the environment. The printed value must be the fresh command.

**Call relations**: The macOS test runner calls this to cover a platform-specific branch of maybe_wrap_shell_lc_with_snapshot. It uses shell_with_snapshot and shell quoting helpers to simulate stale and fresh proxy commands.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (new, assert!, assert_eq!, new, default, format!, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_restores_custom_git_ssh_command`  (lines 629–667)

```
fn maybe_wrap_shell_lc_with_snapshot_restores_custom_git_ssh_command()
```

**Purpose**: On macOS, checks that a user’s custom Git SSH command replaces a stale Codex-managed one from the snapshot. User-supplied SSH routing should not be overwritten by old Codex proxy data.

**Data flow**: The test writes a snapshot with a Codex-marked stale command, then runs the wrapped command with a custom, unmarked GIT SSH command in the environment. The output must be the custom command.

**Call relations**: The macOS test runner calls this as another Git SSH environment restoration case for maybe_wrap_shell_lc_with_snapshot. It confirms the wrapper respects user-provided live settings.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (new, assert!, assert_eq!, new, default, format!, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_clears_stale_codex_git_ssh_command_without_live_command`  (lines 671–710)

```
fn maybe_wrap_shell_lc_with_snapshot_clears_stale_codex_git_ssh_command_without_live_command()
```

**Purpose**: On macOS, checks that a stale Codex-managed Git SSH command from a snapshot is removed when there is no live replacement. This prevents commands from trying to use a proxy that no longer exists.

**Data flow**: The test writes a snapshot with a Codex-marked Git SSH command, wraps a command that reports whether the variable is set, and runs it with that variable removed from the live environment. The command reports that the variable is unset.

**Call relations**: The macOS test runner calls this to exercise the cleanup path in maybe_wrap_shell_lc_with_snapshot. It complements the tests that refresh or replace the same variable.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (new, assert!, assert_eq!, new, default, format!, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_keeps_user_proxy_env_when_proxy_inactive`  (lines 713–748)

```
fn maybe_wrap_shell_lc_with_snapshot_keeps_user_proxy_env_when_proxy_inactive()
```

**Purpose**: Checks that a proxy value saved in the snapshot is kept when Codex’s proxy is not active. A user’s normal proxy setting should not be deleted just because its name looks proxy-related.

**Data flow**: The test writes a snapshot setting HTTP_PROXY to a user proxy, wraps a command that prints HTTP_PROXY, and runs it after removing Codex proxy environment keys. The output remains the user proxy URL from the snapshot.

**Call relations**: The test runner calls this to make sure maybe_wrap_shell_lc_with_snapshot only repairs proxy variables when Codex proxy state says repair is needed. It protects ordinary user proxy setups.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (new, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_restores_live_env_when_snapshot_proxy_active`  (lines 751–799)

```
fn maybe_wrap_shell_lc_with_snapshot_restores_live_env_when_snapshot_proxy_active()
```

**Purpose**: Checks that if a snapshot says Codex proxy was active, the wrapper restores the current live environment instead of keeping the snapshot’s proxy state. This avoids resurrecting old proxy variables.

**Data flow**: The test writes a snapshot with the proxy-active marker, PIP_PROXY, and HTTP_PROXY. It runs the wrapped command with only a live user HTTP_PROXY and no PIP_PROXY or proxy-active marker. The output shows PIP_PROXY and the active marker are unset, while HTTP_PROXY has the live user value.

**Call relations**: The test runner calls this and executes the wrapped command. It tests the part of maybe_wrap_shell_lc_with_snapshot that compares snapshot proxy state with the live environment and restores the live version.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 10 external calls (from, new, assert!, assert_eq!, new, default, format!, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_keeps_snapshot_path_without_override`  (lines 802–832)

```
fn maybe_wrap_shell_lc_with_snapshot_keeps_snapshot_path_without_override()
```

**Purpose**: Checks that PATH from the shell snapshot is used when there is no explicit PATH override. This lets the command see the user’s normal shell search path.

**Data flow**: The test writes a snapshot that exports PATH=/snapshot/bin, wraps a command that prints PATH, runs it, and verifies the printed value is /snapshot/bin.

**Call relations**: The test runner calls this as the baseline PATH behavior for maybe_wrap_shell_lc_with_snapshot. Later tests add explicit overrides and runtime prepends on top of this baseline.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (new, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_applies_explicit_path_override`  (lines 835–867)

```
fn maybe_wrap_shell_lc_with_snapshot_applies_explicit_path_override()
```

**Purpose**: Checks that an explicit PATH override wins over the PATH saved in a snapshot. This matters when Codex needs to run a command with a worktree-specific tool path.

**Data flow**: The test writes a snapshot PATH of /snapshot/bin, provides an explicit override PATH of /worktree/bin, runs the wrapped command with that live PATH, and verifies the output is /worktree/bin.

**Call relations**: The test runner calls this to exercise PATH precedence in maybe_wrap_shell_lc_with_snapshot. It is the PATH-specific version of the broader explicit override test.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (from, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_preserves_package_path_prepend`  (lines 871–881)

```
fn maybe_wrap_shell_lc_with_snapshot_preserves_package_path_prepend() -> anyhow::Result<()>
```

**Purpose**: Checks that a runtime-added package helper path is replayed before the snapshot PATH. This keeps Codex-provided helper binaries discoverable even after the snapshot resets PATH.

**Data flow**: The test delegates setup and execution to run_snapshot_path_probe_with_runtime_path_prepend with no explicit PATH override. It receives the command output and helper directory, then verifies the output is helper-directory followed by /snapshot/bin.

**Call relations**: The test runner calls this focused assertion, while run_snapshot_path_probe_with_runtime_path_prepend performs the shared command-building and execution work.

*Call graph*: calls 1 internal fn (run_snapshot_path_probe_with_runtime_path_prepend); 2 external calls (new, assert_eq!).


##### `maybe_wrap_shell_lc_with_snapshot_applies_runtime_path_prepend_after_explicit_path_override`  (lines 885–897)

```
fn maybe_wrap_shell_lc_with_snapshot_applies_runtime_path_prepend_after_explicit_path_override() -> anyhow::Result<()>
```

**Purpose**: Checks that runtime PATH prepends still apply even when an explicit PATH override replaces the snapshot PATH. The helper path should remain first, but the base PATH should be the override.

**Data flow**: The test calls run_snapshot_path_probe_with_runtime_path_prepend with PATH explicitly set to /worktree/bin. It verifies the final printed PATH is helper-directory followed by /worktree/bin.

**Call relations**: The test runner calls this as the override version of the package-path replay check. It relies on the shared helper to build the snapshot, add the runtime prepend, wrap the command, and run it.

*Call graph*: calls 1 internal fn (run_snapshot_path_probe_with_runtime_path_prepend); 2 external calls (from, assert_eq!).


##### `run_snapshot_path_probe_with_runtime_path_prepend`  (lines 900–941)

```
fn run_snapshot_path_probe_with_runtime_path_prepend(
    explicit_env_overrides: HashMap<String, String>,
) -> anyhow::Result<(String, PathBuf)>
```

**Purpose**: Sets up and runs a reusable PATH probe for tests that involve shell snapshots plus runtime PATH prepends. It avoids duplicating the same temporary snapshot and command execution code.

**Data flow**: It receives any explicit environment overrides, creates a temporary snapshot that sets PATH, records a runtime prepend directory, wraps a command that prints PATH, runs the rewritten command with the live PATH, and returns the printed PATH plus the helper directory path.

**Call relations**: Two PATH tests call this helper: one without an explicit override and one with an explicit override. It calls shell_with_snapshot and maybe_wrap_shell_lc_with_snapshot to exercise the real wrapping behavior.

*Call graph*: calls 1 internal fn (shell_with_snapshot); called by 2 (maybe_wrap_shell_lc_with_snapshot_applies_runtime_path_prepend_after_explicit_path_override, maybe_wrap_shell_lc_with_snapshot_preserves_package_path_prepend); 8 external calls (from, from_utf8_lossy, assert!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_preserves_zsh_fork_path_prepend`  (lines 945–991)

```
fn maybe_wrap_shell_lc_with_snapshot_preserves_zsh_fork_path_prepend()
```

**Purpose**: Checks that the PATH prepend for Codex’s bundled zsh fork is replayed before the snapshot PATH. This keeps the zsh fork’s helper directory available after loading a saved shell environment.

**Data flow**: The test creates a snapshot PATH, builds a fake bundled zsh path, applies the zsh fork PATH prepend to the live environment and replay record, wraps a command that prints PATH, runs it, and verifies the zsh bin directory appears before /snapshot/bin.

**Call relations**: The test runner calls this to connect apply_zsh_fork_path_prepend with maybe_wrap_shell_lc_with_snapshot. It proves that PATH changes recorded earlier are honored during snapshot wrapping.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (from, new, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_does_not_embed_override_values_in_argv`  (lines 994–1036)

```
fn maybe_wrap_shell_lc_with_snapshot_does_not_embed_override_values_in_argv()
```

**Purpose**: Checks that secret override values are not written into the generated command-line text. Command-line arguments can be visible to process listings or logs, so secrets should stay in environment variables.

**Data flow**: The test writes a snapshot with an API key, provides a secret explicit override, and wraps a command that prints the key. It first verifies the secret text is not inside the rewritten shell argument, then runs the command with the secret in the environment and verifies the command still sees it.

**Call relations**: The test runner calls this to validate a security property of maybe_wrap_shell_lc_with_snapshot. It shows that the wrapper restores override variables by name from the environment, not by embedding their values in argv.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 8 external calls (from, assert!, assert_eq!, new, default, write, tempdir, vec!).


##### `maybe_wrap_shell_lc_with_snapshot_preserves_unset_override_variables`  (lines 1039–1074)

```
fn maybe_wrap_shell_lc_with_snapshot_preserves_unset_override_variables()
```

**Purpose**: Checks that an explicit override variable can remain unset if it is absent from the live environment, even when the snapshot sets it. This prevents a saved snapshot from recreating a value Codex intentionally left out.

**Data flow**: The test writes a snapshot setting CODEX_TEST_UNSET_OVERRIDE, marks that variable as an explicit override, but provides no live value. It runs the wrapped command with the variable removed and verifies the command sees it as unset.

**Call relations**: The test runner calls this to cover the “override by absence” case in maybe_wrap_shell_lc_with_snapshot. It complements tests where live override variables have actual values.

*Call graph*: calls 1 internal fn (shell_with_snapshot); 9 external calls (from, new, assert!, assert_eq!, new, default, write, tempdir, vec!).


### `core/src/tools/runtimes/shell/unix_escalation_tests.rs`

`test` · `test suite`

This is a test file, not production code. It builds small fake situations and checks that the shell command safety machinery makes the right choice. The main concern is escalation: when a command needs more power than the normal sandbox gives it, the system must decide whether to run it, ask the user, grant a specific permission set, run without the sandbox, or refuse it. Think of it like testing a building security desk: some visitors have badges, some need approval, some are blocked, and the desk must not be fooled by disguises.

The tests cover several risky edges. They check that shell commands wrapped by tools like `/usr/bin/env` or `sandbox-exec` are still understood, that command policy rules can match either the wrapper or the real inner command, and that known host executable paths are trusted only when they match the configured mapping. They also check that preapproved extra permissions are treated differently from a fresh permission request, and that denied file reads do not accidentally force unnecessary approval.

A few helpers build portable test paths, escaped policy strings, and sandbox policies. The asynchronous tests create realistic session objects, fake hooks, and command providers so the same decision code used at runtime can be exercised. Without these tests, changes to shell execution could silently weaken sandbox boundaries or annoy users with incorrect prompts.

#### Function details

##### `host_absolute_path`  (lines 50–60)

```
fn host_absolute_path(segments: &[&str]) -> String
```

**Purpose**: Builds an absolute path string that works on the current operating system. Tests use it so the same scenario can run on Unix-like systems and Windows without hard-coding the wrong root path.

**Data flow**: It receives a list of path pieces, starts with `/` on Unix-like systems or `C:\` on Windows, appends each piece, and returns the finished path as a string.

**Call relations**: Many policy and sandbox tests call this helper before building an executable path or workspace path. It hides the platform difference so those tests can focus on command-policy behavior rather than path syntax.

*Call graph*: called by 9 (commands_for_intercepted_exec_policy_parses_plain_shell_wrappers, denied_reads_keep_granular_sandbox_rejection_for_escalation, denied_reads_keep_prefix_rule_allow_inside_sandbox, evaluate_intercepted_exec_policy_matches_inner_shell_commands_when_enabled, evaluate_intercepted_exec_policy_uses_wrapper_command_when_shell_wrapper_parsing_disabled, intercepted_exec_policy_rejects_disallowed_host_executable_mapping, intercepted_exec_policy_treats_preapproved_additional_permissions_as_default, intercepted_exec_policy_uses_host_executable_mappings, test_sandbox_cwd); 2 external calls (from, cfg!).


##### `starlark_string`  (lines 62–64)

```
fn starlark_string(value: &str) -> String
```

**Purpose**: Escapes a string so it can be safely placed inside a Starlark policy file string literal. Starlark is the small configuration language used here for execution policy rules.

**Data flow**: It receives plain text, doubles backslashes, escapes double quotes, and returns the cleaned-up version for embedding in policy source text.

**Call relations**: Tests that generate policy text with real host paths call this helper before formatting those paths into rules. That prevents path characters from accidentally changing the meaning of the policy.

*Call graph*: called by 3 (denied_reads_keep_prefix_rule_allow_inside_sandbox, intercepted_exec_policy_rejects_disallowed_host_executable_mapping, intercepted_exec_policy_uses_host_executable_mappings).


##### `read_only_file_system_sandbox_policy`  (lines 66–73)

```
fn read_only_file_system_sandbox_policy() -> FileSystemSandboxPolicy
```

**Purpose**: Creates a sandbox policy where the whole file system is readable but not writable. Tests use it as a simple baseline for restricted command execution.

**Data flow**: It takes no input, builds one sandbox entry for the root of the file system with read access, and returns a restricted file-system policy containing that entry.

**Call relations**: Escalation tests call this helper when they need a predictable, limited sandbox. The returned policy is then fed into command providers or permission profiles.

*Call graph*: calls 1 internal fn (restricted); called by 4 (execve_permission_request_hook_short_circuits_prompt, preapproved_additional_permissions_escalate_intercepted_exec, shell_request_escalation_execution_is_explicit, unsandboxed_intercepted_exec_strips_managed_network_env); 1 external calls (vec!).


##### `denied_read_file_system_sandbox_policy`  (lines 75–90)

```
fn denied_read_file_system_sandbox_policy() -> FileSystemSandboxPolicy
```

**Purpose**: Creates a sandbox policy that mostly allows reads but specifically denies reading `.env` files. This lets tests cover the subtle case where read access has exceptions.

**Data flow**: It takes no input, creates one rule allowing root reads and another rule denying files that match `**/*.env`, then returns the combined restricted policy.

**Call relations**: Tests about denied reads call this helper to make sure command approval logic does not treat every read-restricted sandbox in the same way. The policy is converted into permission profiles for escalation decisions.

*Call graph*: calls 1 internal fn (restricted); called by 2 (denied_reads_keep_granular_sandbox_rejection_for_escalation, denied_reads_keep_prefix_rule_allow_inside_sandbox); 1 external calls (vec!).


##### `test_sandbox_cwd`  (lines 92–94)

```
fn test_sandbox_cwd() -> AbsolutePathBuf
```

**Purpose**: Returns the fake current working directory used by sandbox-related tests. It gives those tests a stable workspace path.

**Data flow**: It asks `host_absolute_path` for a platform-correct `/workspace`-style path, converts it into an absolute path type, and returns it.

**Call relations**: Several asynchronous escalation tests call this when constructing executors or providers. It supplies the working directory that later decision code uses when judging command execution.

*Call graph*: calls 2 internal fn (host_absolute_path, try_from); called by 4 (denied_reads_keep_granular_sandbox_rejection_for_escalation, denied_reads_keep_prefix_rule_allow_inside_sandbox, preapproved_additional_permissions_escalate_intercepted_exec, unsandboxed_intercepted_exec_strips_managed_network_env).


##### `execve_prompt_rejection_keeps_prefix_rules_on_rules_flag`  (lines 97–111)

```
fn execve_prompt_rejection_keeps_prefix_rules_on_rules_flag()
```

**Purpose**: Checks that prompts caused by explicit policy rules are rejected when granular approval has disabled rule-based approvals. This prevents a command from asking for approval through a channel the configuration turned off.

**Data flow**: The test builds a granular approval setting where `rules` is false, passes a prefix-rule decision source into the rejection checker, and expects a specific rejection message.

**Call relations**: The Rust test runner invokes this test. It directly exercises the prompt-rejection helper in the shell module and verifies that policy-rule prompts respect the `rules` switch.

*Call graph*: 1 external calls (assert_eq!).


##### `execve_prompt_rejection_keeps_unmatched_commands_on_sandbox_flag`  (lines 114–128)

```
fn execve_prompt_rejection_keeps_unmatched_commands_on_sandbox_flag()
```

**Purpose**: Checks that prompts caused by the sandbox fallback are rejected when granular approval has disabled sandbox approvals. This keeps unmatched commands from bypassing a user’s approval configuration.

**Data flow**: The test builds a granular approval setting where `sandbox_approval` is false, marks the decision source as an unmatched-command fallback, and expects the matching rejection message.

**Call relations**: The Rust test runner invokes this test. It directly checks the shell module’s prompt-rejection helper for the fallback path used when no command rule matched.

*Call graph*: 1 external calls (assert_eq!).


##### `approval_sandbox_permissions_only_downgrades_preapproved_additional_permissions`  (lines 131–153)

```
fn approval_sandbox_permissions_only_downgrades_preapproved_additional_permissions()
```

**Purpose**: Verifies that preapproved extra permissions are treated as already settled, while other escalation modes remain unchanged. This matters because a command should not ask again for permissions the turn already has.

**Data flow**: The test tries combinations of sandbox-permission mode and a preapproved flag, then compares the returned mode with the expected safer or unchanged mode.

**Call relations**: The Rust test runner invokes this test. It checks the shell module helper that later policy evaluation uses when deciding whether intercepted commands should prompt.

*Call graph*: 1 external calls (assert_eq!).


##### `extract_shell_script_preserves_login_flag`  (lines 156–173)

```
fn extract_shell_script_preserves_login_flag()
```

**Purpose**: Checks that shell parsing keeps track of whether a shell was started as a login shell. A login shell can load different startup files, so losing this flag would change command behavior.

**Data flow**: The test passes shell argument lists using `-lc` and `-c`, asks the parser to extract the script, and expects the same program and script with the correct login boolean.

**Call relations**: The Rust test runner invokes this test. It exercises `extract_shell_script`, which is used by the shell runtime when it needs to understand a shell-wrapped command.

*Call graph*: 1 external calls (assert_eq!).


##### `extract_shell_script_supports_wrapped_command_prefixes`  (lines 176–209)

```
fn extract_shell_script_supports_wrapped_command_prefixes()
```

**Purpose**: Checks that the parser can see through common wrappers before the real shell command. This prevents policy checks from being fooled by a command being launched through `env` or `sandbox-exec`.

**Data flow**: The test supplies wrapped command arrays, asks for the shell script extraction, and expects the real shell program, inner script, and login-shell flag.

**Call relations**: The Rust test runner invokes this test. It validates the parser used before intercepted execution policy is applied to shell-launched commands.

*Call graph*: 1 external calls (assert_eq!).


##### `extract_shell_script_rejects_unsupported_shell_invocation`  (lines 212–227)

```
fn extract_shell_script_rejects_unsupported_shell_invocation()
```

**Purpose**: Checks that an unexpected shell command shape is rejected instead of guessed at. This is important because guessing wrong could run or approve a different command than the user intended.

**Data flow**: The test passes an unsupported `sandbox-exec`-style argument list, receives an error, confirms it is a rejection, and checks the exact rejection reason.

**Call relations**: The Rust test runner invokes this test. It calls `extract_shell_script` directly and verifies the failure path used when shell command parsing cannot be trusted.

*Call graph*: 3 external calls (assert!, assert_eq!, extract_shell_script).


##### `join_program_and_argv_replaces_original_argv_zero`  (lines 230–245)

```
fn join_program_and_argv_replaces_original_argv_zero()
```

**Purpose**: Checks that a resolved executable path replaces the original first argument. The first argument, often called `argv[0]`, may be relative or misleading, so policy code needs the real program path.

**Data flow**: The test passes an absolute tool path plus an argument list, then expects a new list where the first item is the absolute path and the remaining arguments are preserved.

**Call relations**: The Rust test runner invokes this test. It verifies a helper used when rebuilding a command line for execution or policy evaluation.

*Call graph*: 1 external calls (assert_eq!).


##### `commands_for_intercepted_exec_policy_parses_plain_shell_wrappers`  (lines 248–263)

```
fn commands_for_intercepted_exec_policy_parses_plain_shell_wrappers()
```

**Purpose**: Checks that shell wrapper parsing can split a simple shell script into the commands policy rules should inspect. This lets rules see `git status` and `pwd` rather than only seeing `bash -lc ...`.

**Data flow**: The test builds a fake bash path and shell arguments, asks for candidate policy commands, and expects two parsed commands with a flag showing simple parsing was enough.

**Call relations**: The Rust test runner invokes this test. It uses `host_absolute_path` to build the program path, then calls `commands_for_intercepted_exec_policy`, the helper that feeds command candidates into policy evaluation.

*Call graph*: calls 2 internal fn (host_absolute_path, try_from); 3 external calls (assert!, assert_eq!, commands_for_intercepted_exec_policy).


##### `map_exec_result_preserves_stdout_and_stderr`  (lines 266–283)

```
fn map_exec_result_preserves_stdout_and_stderr()
```

**Purpose**: Checks that command output is copied into the runtime’s result object without mixing up standard output, standard error, or combined output. This protects what users and higher-level code see after a command runs.

**Data flow**: The test creates an execution result with separate `stdout`, `stderr`, and aggregate text, maps it into the shell tool output format, and confirms each text field is preserved.

**Call relations**: The Rust test runner invokes this test. It calls `map_exec_result`, which sits after command execution and converts low-level execution data into the shell tool’s output format.

*Call graph*: 3 external calls (from_millis, assert_eq!, map_exec_result).


##### `shell_request_escalation_execution_is_explicit`  (lines 286–355)

```
fn shell_request_escalation_execution_is_explicit()
```

**Purpose**: Checks that shell permission requests choose the right execution style: normal turn defaults, fully unsandboxed execution, or a resolved permission profile. This makes escalation behavior explicit instead of accidental.

**Data flow**: The test builds requested extra file permissions, a current sandbox policy, a permission profile, and a read-only policy. It calls the shell provider’s escalation-selection function with different sandbox-permission modes and compares each result with the expected execution choice.

**Call relations**: The Rust test runner invokes this test. It uses the read-only policy helper and production permission-profile builders, then checks `CoreShellActionProvider::shell_request_escalation_execution`, which is used when a shell command asks for more access.

*Call graph*: calls 4 internal fn (read_only_file_system_sandbox_policy, from_read_write_roots, from_runtime_permissions, restricted); 3 external calls (default, assert_eq!, vec!).


##### `unsandboxed_intercepted_exec_strips_managed_network_env`  (lines 358–404)

```
async fn unsandboxed_intercepted_exec_strips_managed_network_env() -> anyhow::Result<()>
```

**Purpose**: Checks that an unsandboxed intercepted command does not keep environment variables for the managed network proxy. If the command is no longer in the managed network sandbox, keeping those variables would give a false or broken network setup.

**Data flow**: The test creates a command executor, fills an environment map with proxy marker variables, prepares an unsandboxed escalated execution, and verifies all managed-network proxy variables were removed from the prepared environment.

**Call relations**: The async test runner invokes this test. It builds a `CoreShellCommandExecutor` using helper sandbox data, then calls `prepare_escalated_exec`, the runtime path that prepares an intercepted command for escalated execution.

*Call graph*: calls 4 internal fn (read_only_file_system_sandbox_policy, test_sandbox_cwd, workspace_write, from_absolute_path); 5 external calls (new, new, assert!, format!, vec!).


##### `preapproved_additional_permissions_escalate_intercepted_exec`  (lines 407–457)

```
async fn preapproved_additional_permissions_escalate_intercepted_exec() -> anyhow::Result<()>
```

**Purpose**: Checks that when extra permissions were already approved, an intercepted command escalates using the resolved permission profile instead of asking again. This keeps approved permission requests useful for later command execution.

**Data flow**: The test creates a session, requested file permissions, an effective permission profile, and a shell action provider marked as using additional permissions. It asks the escalation policy for an action and expects an escalation with the resolved permission profile.

**Call relations**: The async test runner invokes this test. It uses session-test fixtures, sandbox-policy helpers, and `effective_permission_profile`, then calls `EscalationPolicy::determine_action`, which drives the same decision flow used for real intercepted commands.

*Call graph*: calls 8 internal fn (make_session_and_context, read_only_file_system_sandbox_policy, test_sandbox_cwd, from_read_write_roots, workspace_write, effective_permission_profile, new, from_absolute_path); 11 external calls (new, default, from_secs, new, assert_eq!, empty, ResolvedPermissionProfile, Escalate, Permissions, determine_action (+1 more)).


##### `execve_permission_request_hook_short_circuits_prompt`  (lines 460–609)

```
async fn execve_permission_request_hook_short_circuits_prompt() -> anyhow::Result<()>
```

**Purpose**: Checks that a trusted permission-request hook can allow an escalated command without showing the normal approval prompt. Hooks are user-configured scripts that can automate decisions, so this test verifies both the decision and the data sent to the hook.

**Data flow**: The test creates a temporary hook script and hook configuration, marks the hook as trusted, installs it into the session, builds a provider for a `touch` command that needs escalation, and asks the escalation policy for a decision. It then reads the hook log and confirms the hook received the expected command and no description.

**Call relations**: The async test runner invokes this test. It wires together session fixtures, hook configuration, shell command formatting, and `EscalationPolicy::determine_action`; the hook result is expected to short-circuit the usual user prompt and return unsandboxed escalation.

*Call graph*: calls 10 internal fn (allow_any, make_session_and_context, read_only_file_system_sandbox_policy, new, from_runtime_permissions, read_only, shlex_join, new, from_absolute_path, try_from); 22 external calls (new, from_secs, new, assert!, assert_eq!, list_hooks, empty, format!, default, from_value (+12 more)).


##### `evaluate_intercepted_exec_policy_uses_wrapper_command_when_shell_wrapper_parsing_disabled`  (lines 612–660)

```
fn evaluate_intercepted_exec_policy_uses_wrapper_command_when_shell_wrapper_parsing_disabled()
```

**Purpose**: Checks that when shell-wrapper parsing is turned off, policy evaluation looks at the wrapper command line rather than the inner shell script. This preserves the configured behavior for users who do not want shell parsing in this policy path.

**Data flow**: The test builds a policy that would prompt for `npm publish`, passes a `zsh -lc 'npm publish'` command with wrapper parsing disabled, and verifies the result is an allow-style heuristic match for the wrapper command.

**Call relations**: The Rust test runner invokes this test. It creates a policy with `PolicyParser`, builds a platform-correct shell path, and calls `evaluate_intercepted_exec_policy` with parsing disabled.

*Call graph*: calls 4 internal fn (host_absolute_path, new, read_only, try_from); 2 external calls (assert!, evaluate_intercepted_exec_policy).


##### `evaluate_intercepted_exec_policy_matches_inner_shell_commands_when_enabled`  (lines 663–700)

```
fn evaluate_intercepted_exec_policy_matches_inner_shell_commands_when_enabled()
```

**Purpose**: Checks that when shell-wrapper parsing is enabled, policy evaluation can match the real command inside the shell script. This is what lets a rule for `npm publish` apply even when it is launched through `bash -lc`.

**Data flow**: The test builds a prompt rule for `npm publish`, passes a bash wrapper command with parsing enabled, and expects a prompt decision with a prefix-rule match for the inner command.

**Call relations**: The Rust test runner invokes this test. It uses `PolicyParser` to build the policy and then calls `evaluate_intercepted_exec_policy`, confirming the enabled parsing path feeds inner commands into the policy engine.

*Call graph*: calls 4 internal fn (host_absolute_path, new, read_only, try_from); 2 external calls (assert_eq!, evaluate_intercepted_exec_policy).


##### `intercepted_exec_policy_uses_host_executable_mappings`  (lines 703–746)

```
fn intercepted_exec_policy_uses_host_executable_mappings()
```

**Purpose**: Checks that policy rules can match a known command name to an allowed absolute executable path on the host machine. This lets a rule for `git status` still work when interception sees `/usr/bin/git`.

**Data flow**: The test builds a real-looking git path, escapes it for policy text, defines both a prefix rule and a host executable mapping, evaluates `git status`, and expects a prompt decision tied to the resolved program path.

**Call relations**: The Rust test runner invokes this test. It uses the path and escaping helpers, builds the policy, calls `evaluate_intercepted_exec_policy`, and then checks that `CoreShellActionProvider::decision_driven_by_policy` recognizes the match as policy-driven.

*Call graph*: calls 5 internal fn (host_absolute_path, starlark_string, new, read_only, try_from); 4 external calls (assert!, assert_eq!, format!, evaluate_intercepted_exec_policy).


##### `denied_reads_keep_prefix_rule_allow_inside_sandbox`  (lines 749–793)

```
async fn denied_reads_keep_prefix_rule_allow_inside_sandbox() -> anyhow::Result<()>
```

**Purpose**: Checks that a command explicitly allowed by a prefix rule still runs inside the sandbox even when the file-system policy contains denied read patterns. This avoids unnecessary escalation just because the sandbox has some read exclusions.

**Data flow**: The test builds an allow rule for a `cat` executable path, creates a sandbox policy that denies `.env` reads, builds a provider with default sandbox permissions, and asks the escalation policy what to do. It expects the command to run normally.

**Call relations**: The async test runner invokes this test. It combines policy parsing, the denied-read sandbox helper, session fixtures, and `EscalationPolicy::determine_action` to verify the run decision.

*Call graph*: calls 9 internal fn (make_session_and_context, denied_read_file_system_sandbox_policy, host_absolute_path, starlark_string, test_sandbox_cwd, new, from_runtime_permissions, new, try_from); 6 external calls (new, from_secs, new, assert_eq!, format!, determine_action).


##### `denied_reads_keep_granular_sandbox_rejection_for_escalation`  (lines 796–840)

```
async fn denied_reads_keep_granular_sandbox_rejection_for_escalation() -> anyhow::Result<()>
```

**Purpose**: Checks that a command needing escalation is still denied when granular approval has disabled sandbox approvals, even if the sandbox’s read restrictions include deny rules. This keeps approval settings authoritative.

**Data flow**: The test creates a denied-read sandbox policy, a granular approval policy with sandbox approval turned off, and a provider requiring escalation. It asks for the command decision and expects a denial with the policy-forbidden reason.

**Call relations**: The async test runner invokes this test. It uses session fixtures and the denied-read policy helper, then drives the real escalation decision function to confirm the rejection path.

*Call graph*: calls 8 internal fn (make_session_and_context, denied_read_file_system_sandbox_policy, host_absolute_path, test_sandbox_cwd, new, from_runtime_permissions, new, try_from); 6 external calls (new, from_secs, new, Granular, assert_eq!, determine_action).


##### `intercepted_exec_policy_treats_preapproved_additional_permissions_as_default`  (lines 843–880)

```
fn intercepted_exec_policy_treats_preapproved_additional_permissions_as_default()
```

**Purpose**: Checks that already-approved additional permissions are evaluated like the default sandbox mode, while a fresh request for additional permissions still prompts. This distinction prevents repeated prompts but still protects new permission requests.

**Data flow**: The test evaluates the same `printf hello` command twice: once after converting preapproved additional permissions through the approval helper, and once as a fresh additional-permissions request. It expects allow for the preapproved case and prompt for the fresh request.

**Call relations**: The Rust test runner invokes this test. It calls `approval_sandbox_permissions` to model preapproval, then passes both contexts to `evaluate_intercepted_exec_policy` and compares the decisions.

*Call graph*: calls 4 internal fn (host_absolute_path, new, workspace_write, try_from); 3 external calls (assert_eq!, approval_sandbox_permissions, evaluate_intercepted_exec_policy).


##### `intercepted_exec_policy_rejects_disallowed_host_executable_mapping`  (lines 883–920)

```
fn intercepted_exec_policy_rejects_disallowed_host_executable_mapping()
```

**Purpose**: Checks that a host executable mapping only applies to the exact allowed paths. If another `git` binary appears elsewhere, the policy must not pretend it is the trusted mapped executable.

**Data flow**: The test builds one allowed git path and one different git path, defines a policy mapping only the allowed path, evaluates a command using the other path, and confirms the result is only a heuristic match rather than a policy-driven match.

**Call relations**: The Rust test runner invokes this test. It uses `host_absolute_path` and `starlark_string` to build policy input, then calls `evaluate_intercepted_exec_policy` and checks `CoreShellActionProvider::decision_driven_by_policy` to make sure the disallowed path did not satisfy the mapping.

*Call graph*: calls 5 internal fn (host_absolute_path, starlark_string, new, read_only, try_from); 3 external calls (assert!, format!, evaluate_intercepted_exec_policy).


### Execution and unified-exec internals
This final group exercises end-to-end command execution, MCP tool-call dispatch, and the lower-level unified-exec buffering, process, and manager internals.

### `core/src/exec_tests.rs`

`test` · `test suite`

Running commands is risky: commands can print huge output, hang forever, spawn child processes, or be blocked by a sandbox. This test file makes sure the execution layer responds in predictable ways. It creates fake command results to test sandbox-denial detection, then runs real short commands to check output capture and timeout behavior. A sandbox is a restricted environment that limits what a command can read, write, or access on the network; these tests make sure Codex recognizes common “blocked by sandbox” signs without mistaking ordinary failures for sandbox failures. The file also checks how stdout and stderr are combined when there is too much output, including the special “full buffer” mode that keeps everything instead of trimming it. A large part of the file focuses on Windows sandbox rules. It verifies which permission profiles can be enforced by the restricted-token backend and when Codex must reject a setup rather than quietly running unsandboxed. Finally, Unix-only tests check that timeouts and cancellations kill whole process groups, including grandchildren, while still giving processes a chance to clean up after a soft termination signal.

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

**Purpose**: Builds a small fake command result for tests. It lets many sandbox-detection tests describe only the exit code and output text they care about.

**Data flow**: It receives an exit code plus stdout, stderr, and combined-output text. It wraps those strings in StreamOutput values, adds a tiny duration, marks the command as not timed out, and returns an ExecToolCallOutput.

**Call relations**: This is a shared test helper. The sandbox-detection tests call it first, then pass the result into the real sandbox-denial detector.

*Call graph*: calls 1 internal fn (new); called by 8 (sandbox_detection_flags_sigsys_exit_code, sandbox_detection_identifies_keyword_in_stderr, sandbox_detection_ignores_network_policy_text_in_non_sandbox_mode, sandbox_detection_ignores_network_policy_text_with_zero_exit_code, sandbox_detection_ignores_non_sandbox_mode, sandbox_detection_requires_keywords, sandbox_detection_respects_quick_reject_exit_codes, sandbox_detection_uses_aggregated_output); 1 external calls (from_millis).


##### `sandbox_detection_requires_keywords`  (lines 30–36)

```
fn sandbox_detection_requires_keywords()
```

**Purpose**: Checks that a failing command is not called a sandbox denial unless its output contains a known sandbox-related clue.

**Data flow**: It creates a fake Linux sandbox command result with exit code 1 and no output. It asks the detector about it and expects a false answer.

**Call relations**: The Rust test runner calls this test. It uses make_exec_output to prepare the case, then exercises the sandbox-denial detection logic directly.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_identifies_keyword_in_stderr`  (lines 39–42)

```
fn sandbox_detection_identifies_keyword_in_stderr()
```

**Purpose**: Checks that the detector recognizes a common permission error message as likely sandbox blocking.

**Data flow**: It creates a fake command result whose stderr says “Operation not permitted.” It passes that result to the Linux sandbox detector and expects true.

**Call relations**: The test runner calls this test. It relies on make_exec_output to build the fake output before checking the detector.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_respects_quick_reject_exit_codes`  (lines 45–51)

```
fn sandbox_detection_respects_quick_reject_exit_codes()
```

**Purpose**: Makes sure obvious non-sandbox failures, such as “command not found,” are not mislabeled as sandbox denials.

**Data flow**: It creates a fake result with exit code 127 and stderr saying the command was not found. The detector is expected to reject it as a sandbox-denial candidate.

**Call relations**: The test runner calls this test. It sets up the fake result with make_exec_output and then checks the sandbox-denial filter.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_ignores_non_sandbox_mode`  (lines 54–57)

```
fn sandbox_detection_ignores_non_sandbox_mode()
```

**Purpose**: Confirms that sandbox-denial detection is disabled when no sandbox is being used.

**Data flow**: It creates output that would look suspicious in a sandbox, then labels the sandbox type as None. The expected result is false.

**Call relations**: The test runner calls this test. It proves the detector pays attention to the current sandbox mode, not just output text.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_ignores_network_policy_text_in_non_sandbox_mode`  (lines 60–68)

```
fn sandbox_detection_ignores_network_policy_text_in_non_sandbox_mode()
```

**Purpose**: Ensures network policy log text is not treated as a sandbox denial when sandboxing is off.

**Data flow**: It creates a successful fake result whose combined output contains a network-policy decision marker. Because the sandbox type is None, the detector should return false.

**Call relations**: The test runner calls this test. It uses make_exec_output to isolate this one false-positive case.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_uses_aggregated_output`  (lines 71–82)

```
fn sandbox_detection_uses_aggregated_output()
```

**Purpose**: Checks that sandbox-denial detection looks at the combined output, not only stdout or stderr separately.

**Data flow**: It creates a fake macOS sandbox result where only the combined output mentions a read-only file system. The detector should treat that as likely sandbox blocking.

**Call relations**: The test runner calls this test. It prepares the fake result with make_exec_output and then tests the detector’s combined-output path.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `sandbox_detection_ignores_network_policy_text_with_zero_exit_code`  (lines 85–97)

```
fn sandbox_detection_ignores_network_policy_text_with_zero_exit_code()
```

**Purpose**: Makes sure a successful command is not marked as sandbox-denied just because it printed network policy text.

**Data flow**: It creates a fake result with exit code 0 and a network-policy marker in combined output. The detector should return false.

**Call relations**: The test runner calls this test. It protects against false alarms in normal successful command runs.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `read_output_limits_retained_bytes_for_shell_capture`  (lines 100–116)

```
async fn read_output_limits_retained_bytes_for_shell_capture()
```

**Purpose**: Checks that normal shell-tool output capture keeps only the configured maximum number of bytes.

**Data flow**: It writes more bytes than the limit into an in-memory pipe. It reads through the output reader with a byte cap and expects the retained text length to equal the cap.

**Call relations**: The async test runner calls this test. It simulates a noisy command by spawning a writer task, then exercises the real output-reading code.

*Call graph*: 4 external calls (assert_eq!, duplex, spawn, vec!).


##### `aggregate_output_prefers_stderr_on_contention`  (lines 119–136)

```
fn aggregate_output_prefers_stderr_on_contention()
```

**Purpose**: Verifies that when stdout and stderr are both too large, stderr gets most of the limited combined-output space.

**Data flow**: It creates full-size stdout and stderr buffers. The aggregator is expected to keep a smaller slice of stdout first and use the rest for stderr.

**Call relations**: The test runner calls this test. It checks the output-combining rule used after command execution finishes.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `aggregate_output_fills_remaining_capacity_with_stderr`  (lines 139–156)

```
fn aggregate_output_fills_remaining_capacity_with_stderr()
```

**Purpose**: Checks that stderr fills whatever combined-output space is left after a small stdout.

**Data flow**: It creates short stdout and very large stderr. The aggregator should keep all stdout and then as much stderr as fits.

**Call relations**: The test runner calls this test. It exercises the same aggregation policy as real command results.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `aggregate_output_rebalances_when_stderr_is_small`  (lines 159–175)

```
fn aggregate_output_rebalances_when_stderr_is_small()
```

**Purpose**: Ensures stdout can use almost all combined-output space when stderr is tiny.

**Data flow**: It creates a huge stdout and a one-byte stderr. The combined output should keep all but one byte for stdout, then append the stderr byte.

**Call relations**: The test runner calls this test. It checks that the aggregation rule is flexible rather than using a fixed split every time.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `aggregate_output_keeps_stdout_then_stderr_when_under_cap`  (lines 178–195)

```
fn aggregate_output_keeps_stdout_then_stderr_when_under_cap()
```

**Purpose**: Checks the simple case where combined stdout and stderr fit under the output limit.

**Data flow**: It creates small stdout and stderr buffers. The aggregator should return stdout followed by stderr with no truncation marker.

**Call relations**: The test runner calls this test. It verifies the normal no-pressure path of output aggregation.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `read_output_retains_all_bytes_for_full_buffer_capture`  (lines 198–214)

```
async fn read_output_retains_all_bytes_for_full_buffer_capture()
```

**Purpose**: Confirms that full-buffer capture keeps all command output instead of trimming it.

**Data flow**: It writes more than the normal maximum into an in-memory pipe. It reads with no byte limit and expects the returned text length to match everything written.

**Call relations**: The async test runner calls this test. It uses a spawned writer so the small pipe does not block while the reader drains it.

*Call graph*: 4 external calls (assert_eq!, duplex, spawn, vec!).


##### `aggregate_output_keeps_all_bytes_when_uncapped`  (lines 217–238)

```
fn aggregate_output_keeps_all_bytes_when_uncapped()
```

**Purpose**: Checks that output aggregation keeps both stdout and stderr completely when no maximum is set.

**Data flow**: It creates large stdout and stderr buffers. The aggregator should return their full concatenation: all stdout, then all stderr.

**Call relations**: The test runner calls this test. It protects the full-buffer mode used by higher-level execution tests.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `full_buffer_capture_policy_disables_caps_and_exec_expiration`  (lines 241–248)

```
fn full_buffer_capture_policy_disables_caps_and_exec_expiration()
```

**Purpose**: Verifies the settings attached to full-buffer capture mode.

**Data flow**: It asks the FullBuffer capture policy for its byte cap, I/O drain timeout, and expiration behavior. It expects no byte cap, a normal drain timeout, and no execution expiration.

**Call relations**: The test runner calls this test. It checks the policy object before other tests run commands using that policy.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `exec_full_buffer_capture_ignores_expiration`  (lines 251–292)

```
async fn exec_full_buffer_capture_ignores_expiration() -> Result<()>
```

**Purpose**: Makes sure full-buffer command execution is not stopped by the normal expiration timer.

**Data flow**: It builds a short command that sleeps briefly and prints “hello,” while setting an unrealistically tiny expiration. Because capture policy is FullBuffer, the command should finish and return hello without timing out.

**Call relations**: The async test runner calls this test. It exercises the real exec path with platform-specific shell commands.

*Call graph*: calls 1 internal fn (current_dir); 4 external calls (assert!, assert_eq!, vars, vec!).


##### `exec_full_buffer_capture_keeps_io_drain_timeout_when_descendant_holds_pipe_open`  (lines 296–329)

```
async fn exec_full_buffer_capture_keeps_io_drain_timeout_when_descendant_holds_pipe_open() -> Result<()>
```

**Purpose**: Checks that full-buffer mode still returns if a child process leaves an output pipe open.

**Data flow**: On Unix, it runs a shell command that prints hello and starts a background sleep process. The test wraps execution in a larger timeout and expects exec to return once its I/O drain guard fires.

**Call relations**: The async test runner calls this Unix-only test. It verifies exec’s cleanup behavior when descendants outlive the main command.

*Call graph*: calls 1 internal fn (current_dir); 5 external calls (from_millis, assert!, vars, timeout, vec!).


##### `process_exec_tool_call_preserves_full_buffer_capture_policy`  (lines 332–378)

```
async fn process_exec_tool_call_preserves_full_buffer_capture_policy() -> Result<()>
```

**Purpose**: Confirms that the higher-level tool-call path does not accidentally convert full-buffer capture into capped shell capture.

**Data flow**: It runs a command that prints more than the normal output limit using FullBuffer policy. The result should not time out, and stdout should contain every byte.

**Call relations**: The async test runner calls this test. It goes through process_exec_tool_call, which is the higher-level route used by tool execution.

*Call graph*: calls 1 internal fn (current_dir); 5 external calls (assert!, assert_eq!, vars, from_ref, vec!).


##### `windows_restricted_token_skips_external_sandbox_policies`  (lines 381–387)

```
fn windows_restricted_token_skips_external_sandbox_policies()
```

**Purpose**: Checks that Windows restricted-token support is not claimed for externally managed sandbox policies.

**Data flow**: It creates an external permission profile with restricted network access. The support check should return false.

**Call relations**: The test runner calls this test. It verifies a guard used before choosing the Windows restricted-token sandbox backend.

*Call graph*: 1 external calls (assert!).


##### `windows_restricted_token_supports_read_only_profiles`  (lines 390–394)

```
fn windows_restricted_token_supports_read_only_profiles()
```

**Purpose**: Checks that a read-only permission profile is compatible with the Windows restricted-token sandbox.

**Data flow**: It creates a read-only profile and asks whether restricted-token sandboxing supports it. The expected answer is true.

**Call relations**: The test runner calls this test. It covers one of the safe profile shapes that Windows sandbox selection may allow.

*Call graph*: calls 1 internal fn (read_only); 1 external calls (assert!).


##### `windows_proxy_enforcement_uses_elevated_backend`  (lines 397–410)

```
fn windows_proxy_enforcement_uses_elevated_backend()
```

**Purpose**: Verifies when Windows sandboxing must use the elevated backend, especially when proxy-based network enforcement is active.

**Data flow**: It asks the backend-selection helper about restricted-token and elevated levels with proxy enforcement on or off. It expects proxy enforcement to force the elevated path for restricted-token mode.

**Call relations**: The test runner calls this test. It checks a decision that affects how Windows sandbox requests are built.

*Call graph*: 1 external calls (assert!).


##### `windows_restricted_token_rejects_network_only_restrictions`  (lines 413–431)

```
fn windows_restricted_token_rejects_network_only_restrictions()
```

**Purpose**: Ensures the Windows restricted-token backend refuses a policy that restricts only the network while leaving the file system unrestricted.

**Data flow**: It builds a managed profile with unrestricted files and restricted network. The unsupported-reason helper should return a clear refusal message.

**Call relations**: The test runner calls this test. It protects against silently running without the intended network enforcement.

*Call graph*: calls 3 internal fn (from_runtime_permissions, unrestricted, current_dir); 1 external calls (assert_eq!).


##### `windows_restricted_token_rejects_managed_root_write_profiles`  (lines 434–461)

```
fn windows_restricted_token_rejects_managed_root_write_profiles()
```

**Purpose**: Checks that a managed policy allowing writes at the filesystem root is rejected for the restricted-token backend.

**Data flow**: It builds a restricted filesystem policy that grants write access to root, combines it with restricted network access, and expects a refusal reason.

**Call relations**: The test runner calls this test. It exercises the Windows compatibility checker for unsafe or unenforceable filesystem rules.

*Call graph*: calls 3 internal fn (from_runtime_permissions, restricted, current_dir); 2 external calls (assert_eq!, vec!).


##### `windows_restricted_token_allows_read_only_profiles`  (lines 464–477)

```
fn windows_restricted_token_allows_read_only_profiles()
```

**Purpose**: Confirms that read-only profiles produce no unsupported-reason message for restricted-token sandboxing.

**Data flow**: It creates a read-only profile and current working directory. The unsupported-reason helper should return None.

**Call relations**: The test runner calls this test. It is the positive counterpart to rejection tests around Windows sandbox support.

*Call graph*: calls 2 internal fn (read_only, current_dir); 1 external calls (assert_eq!).


##### `windows_restricted_token_allows_workspace_write_profiles`  (lines 480–498)

```
fn windows_restricted_token_allows_workspace_write_profiles()
```

**Purpose**: Checks that workspace-write profiles are accepted by the Windows restricted-token sandbox.

**Data flow**: It builds a profile that can write in workspace roots but has restricted network access. The unsupported-reason helper should return None.

**Call relations**: The test runner calls this test. It verifies that common project-editing permissions are considered enforceable.

*Call graph*: calls 2 internal fn (workspace_write_with, current_dir); 1 external calls (assert_eq!).


##### `windows_elevated_allows_split_restricted_read_policies`  (lines 501–528)

```
fn windows_elevated_allows_split_restricted_read_policies()
```

**Purpose**: Checks that the elevated Windows backend can allow a policy with a specific read-only root.

**Data flow**: It creates a temporary docs directory and a policy that allows reading only that path. The compatibility check in elevated mode should accept it.

**Call relations**: The test runner calls this test. It shows that the elevated backend can support more detailed filesystem shapes than the unelevated one.

*Call graph*: calls 3 internal fn (from_runtime_permissions, restricted, from_absolute_path); 4 external calls (assert_eq!, create_dir_all, new, vec!).


##### `windows_restricted_token_rejects_split_only_filesystem_policies`  (lines 531–569)

```
fn windows_restricted_token_rejects_split_only_filesystem_policies()
```

**Purpose**: Ensures the unelevated restricted-token backend rejects split filesystem read restrictions it cannot directly enforce.

**Data flow**: It builds a policy with writable project roots plus a separate read-only docs path. The helper should return a refusal message about split filesystem read restrictions.

**Call relations**: The test runner calls this test. It guards the rule that unsupported Windows policies must fail closed rather than run unsandboxed.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 4 external calls (assert_eq!, create_dir_all, new, vec!).


##### `windows_restricted_token_rejects_root_write_read_only_carveouts`  (lines 572–608)

```
fn windows_restricted_token_rejects_root_write_read_only_carveouts()
```

**Purpose**: Checks that an unelevated Windows sandbox rejects a writable-root policy with read-only exceptions.

**Data flow**: It creates a policy that grants root write access but carves out a read-only docs path. The helper should return a refusal message about split writable root sets.

**Call relations**: The test runner calls this test. It covers another unsupported filesystem shape for the restricted-token backend.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 4 external calls (assert_eq!, create_dir_all, new, vec!).


##### `windows_restricted_token_supports_full_read_split_write_read_carveouts`  (lines 611–663)

```
fn windows_restricted_token_supports_full_read_split_write_read_carveouts()
```

**Purpose**: Verifies a supported restricted-token case: full read access, workspace write access, and an extra read-only carveout.

**Data flow**: It creates a temporary workspace and docs folder, builds a policy with root read, project-root write, and docs read-only access. The resolver should return overrides that deny writes to the docs path.

**Call relations**: The test runner calls this test. It checks that compatible Windows filesystem rules are translated into concrete sandbox override lists.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, canonicalize, create_dir_all, new, vec!).


##### `windows_restricted_token_rejects_unreadable_split_carveouts`  (lines 666–710)

```
fn windows_restricted_token_rejects_unreadable_split_carveouts()
```

**Purpose**: Ensures the unelevated restricted-token backend rejects deny-read carveouts it cannot enforce.

**Data flow**: It builds a policy with root read, project-root write, and a denied blocked path. The restricted-token override resolver should return an error explaining that deny-read restrictions are unsupported.

**Call relations**: The test runner calls this test. It verifies the restricted-token resolver fails safely when asked for unreadable exceptions.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, canonicalize, create_dir_all, new, vec!).


##### `windows_elevated_supports_split_restricted_read_roots`  (lines 713–747)

```
fn windows_elevated_supports_split_restricted_read_roots()
```

**Purpose**: Checks that the elevated Windows backend can turn a specific read-root policy into sandbox overrides.

**Data flow**: It creates a docs folder, builds a policy that allows reading that folder, and expects the resolver to set that canonical path as the read-roots override.

**Call relations**: The test runner calls this test. It exercises the elevated override resolver, which is more capable than the restricted-token-only resolver.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, canonicalize, create_dir_all, new, vec!).


##### `windows_elevated_supports_split_write_read_carveouts`  (lines 750–801)

```
fn windows_elevated_supports_split_write_read_carveouts()
```

**Purpose**: Checks that the elevated Windows backend supports read-only carveouts inside writable workspace-style policies.

**Data flow**: It creates a docs folder and builds root-read, project-write, docs-read policy entries. The resolver should add the docs path to the deny-write list.

**Call relations**: The test runner calls this test. It confirms the elevated resolver can express “read this, but do not write it” as concrete overrides.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, canonicalize, create_dir_all, new, vec!).


##### `windows_elevated_supports_unreadable_split_carveouts`  (lines 804–860)

```
fn windows_elevated_supports_unreadable_split_carveouts()
```

**Purpose**: Verifies that the elevated Windows backend supports paths that should be neither readable nor writable.

**Data flow**: It creates a blocked folder and builds a policy denying access to it. The resolver should add that path to both deny-read and deny-write override lists.

**Call relations**: The test runner calls this test. It covers deny carveouts that the elevated backend can enforce but the unelevated backend cannot.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, canonicalize, create_dir_all, new, vec!).


##### `windows_elevated_supports_unreadable_globs`  (lines 863–913)

```
fn windows_elevated_supports_unreadable_globs()
```

**Purpose**: Checks that the elevated Windows backend can expand a deny glob pattern, such as all .env files, into concrete paths.

**Data flow**: It creates a secret .env file and a policy denying the glob pattern **/*.env. The resolver should find that file and include it in deny-read paths.

**Call relations**: The test runner calls this test. It verifies that pattern-based deny rules become explicit sandbox override paths.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 5 external calls (assert_eq!, create_dir_all, write, new, vec!).


##### `windows_elevated_rejects_reopened_writable_descendants`  (lines 916–968)

```
fn windows_elevated_rejects_reopened_writable_descendants()
```

**Purpose**: Ensures the elevated Windows backend rejects a policy that makes a child path writable inside a read-only carveout.

**Data flow**: It creates docs and nested folders, marks docs read-only, then marks nested writable. The compatibility helper should return a refusal message because reopening write access under a read-only area is unsupported.

**Call relations**: The test runner calls this test. It checks a tricky conflict in filesystem rules before sandbox execution is attempted.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 4 external calls (assert_eq!, create_dir_all, new, vec!).


##### `process_exec_tool_call_uses_platform_sandbox_for_network_only_restrictions`  (lines 971–984)

```
fn process_exec_tool_call_uses_platform_sandbox_for_network_only_restrictions()
```

**Purpose**: Checks sandbox selection when only network access is restricted.

**Data flow**: It asks the platform what sandbox is normally available, then asks the process-exec sandbox selector for an unrestricted-files, restricted-network policy. The selected sandbox should match the platform default.

**Call relations**: The test runner calls this test. It verifies the decision used before process_exec_tool_call builds and runs an execution request.

*Call graph*: 2 external calls (assert_eq!, get_platform_sandbox).


##### `build_exec_request_preserves_windows_workspace_roots`  (lines 987–1019)

```
fn build_exec_request_preserves_windows_workspace_roots() -> Result<()>
```

**Purpose**: Ensures Windows workspace roots are copied into the execution request without being lost or narrowed.

**Data flow**: It creates a temporary current directory and an additional workspace root, then builds an exec request. The request should contain exactly those workspace roots.

**Call relations**: The test runner calls this test. It exercises build_exec_request, the step that packages command settings before execution.

*Call graph*: 4 external calls (new, assert_eq!, new, vec!).


##### `sandbox_detection_flags_sigsys_exit_code`  (lines 1023–1027)

```
fn sandbox_detection_flags_sigsys_exit_code()
```

**Purpose**: On Unix, checks that a SIGSYS signal exit code is treated as likely sandbox blocking.

**Data flow**: It builds a fake result whose exit code represents termination by SIGSYS, a signal often caused by blocked system calls. The Linux sandbox detector should return true.

**Call relations**: The Unix test runner calls this test. It uses make_exec_output and then checks sandbox-denial detection for a signal-based failure.

*Call graph*: calls 1 internal fn (make_exec_output); 1 external calls (assert!).


##### `kill_child_process_group_kills_grandchildren_on_timeout`  (lines 1031–1094)

```
async fn kill_child_process_group_kills_grandchildren_on_timeout() -> Result<()>
```

**Purpose**: On Unix, verifies that a timed-out command kills not only the shell but also background grandchildren.

**Data flow**: It runs a shell command that starts a long sleep in the background and prints that process id. After exec times out, the test repeatedly checks the printed process id until the process is gone.

**Call relations**: The async Unix test runner calls this test. It exercises the real exec timeout path and then uses the operating system kill check to confirm cleanup.

*Call graph*: calls 1 internal fn (current_dir); 7 external calls (from_millis, assert!, last_os_error, kill, vars, sleep, vec!).


##### `process_exec_tool_call_respects_cancellation_token`  (lines 1097–1139)

```
async fn process_exec_tool_call_respects_cancellation_token() -> Result<()>
```

**Purpose**: Checks that higher-level command execution stops promptly when a cancellation token is triggered.

**Data flow**: It starts a long-running platform-specific command with cancellation-based expiration. A spawned task cancels after one second; the result should return quickly, not be marked as a timeout, and have a nonzero non-timeout exit code.

**Call relations**: The async test runner calls this test. It uses long_running_command to create the command, then runs through process_exec_tool_call to test normal tool cancellation.

*Call graph*: calls 2 internal fn (long_running_command, current_dir); 11 external calls (new, from_millis, from_secs, assert!, assert_ne!, Cancellation, vars, from_ref, spawn, sleep (+1 more)).


##### `process_exec_tool_call_cancellation_allows_sigterm_cleanup`  (lines 1143–1249)

```
async fn process_exec_tool_call_cancellation_allows_sigterm_cleanup() -> Result<()>
```

**Purpose**: On Unix, checks that cancellation first gives the process a soft termination signal so cleanup code can run, then still kills stubborn descendants.

**Data flow**: It runs a shell script that writes a ready marker, traps TERM to write a cleanup marker, and starts a child that ignores TERM. After cancellation, the test expects the cleanup marker to exist and then confirms the TERM-ignoring child is dead.

**Call relations**: The async Unix test runner calls this test. It goes through process_exec_tool_call and validates both graceful shutdown and final process-group cleanup.

*Call graph*: calls 1 internal fn (current_dir); 15 external calls (new, from_millis, from_secs, assert!, assert_eq!, last_os_error, kill, vars, read_to_string, from_ref (+5 more)).


##### `long_running_command`  (lines 1261–1269)

```
fn long_running_command() -> Vec<String>
```

**Purpose**: Returns a simple command that sleeps for a long time on the current platform. Tests use it when they need a process that will still be running when cancellation happens.

**Data flow**: It takes no input. On Unix it returns a shell sleep command; on Windows it returns a PowerShell sleep command.

**Call relations**: process_exec_tool_call_respects_cancellation_token calls this helper to avoid duplicating platform-specific command setup.

*Call graph*: called by 1 (process_exec_tool_call_respects_cancellation_token); 1 external calls (vec!).


### `core/src/mcp_tool_call_tests.rs`

`test` · `test runs`

MCP means Model Context Protocol: a way for Codex to call tools exposed by external servers or apps. This test file checks that those tool calls behave safely and predictably. It covers when a tool call needs approval, what the user sees in approval prompts, how approvals can be remembered for a session or written into config, and how special Codex Apps metadata is passed along. It also checks telemetry, trace replay data, plugin-owned MCP servers, permission hooks, Guardian review decisions, and authentication prompts for connectors that need re-login. Think of it like a safety inspection checklist for a power tool: the tests do not build the tool, but they make sure guards, warning labels, logs, and permission switches all work. Without these tests, changes to MCP tool execution could silently skip approval, leak oversized results into events, lose trace data, write approvals to the wrong config file, or show confusing prompts to users.

#### Function details

##### `annotations`  (lines 55–67)

```
fn annotations(
    read_only: Option<bool>,
    destructive: Option<bool>,
    open_world: Option<bool>,
) -> ToolAnnotations
```

**Purpose**: Builds a small test object describing whether an MCP tool is read-only, destructive, or open-world. Tests use it to simulate the safety hints that real MCP tools can provide.

**Data flow**: It receives three optional yes/no hints, passes them into the tool-annotation constructor, and returns a ToolAnnotations value ready for approval tests.

**Call relations**: Many approval and Guardian tests call this helper so they can focus on expected behavior instead of repeating annotation setup.

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

**Purpose**: Creates test metadata for an MCP tool approval prompt. This lets tests describe a connector, app, and tool in the same shape production code expects.

**Data flow**: It takes optional strings such as connector id, connector name, and tool title, converts present values into owned strings, fills unrelated fields with none, and returns McpToolApprovalMetadata.

**Call relations**: Approval prompt, Codex Apps, plugin, and Guardian tests call this helper when they need realistic metadata without building every field manually.

*Call graph*: called by 5 (approval_elicitation_request_uses_message_override_and_preserves_tool_params_keys, codex_apps_auth_failure_metadata, codex_apps_connectors_support_persistent_approval, guardian_mcp_review_request_includes_invocation_metadata, plugin_mcp_tool_call_request_meta_includes_plugin_id).


##### `mcp_turn_metadata_context`  (lines 90–95)

```
fn mcp_turn_metadata_context(turn_context: &TurnContext) -> McpTurnMetadataContext<'_>
```

**Purpose**: Extracts the small piece of turn information that MCP request metadata needs: the model name and reasoning effort. This mirrors what production requests send to MCP servers.

**Data flow**: It reads the model slug and effective reasoning effort from a TurnContext and returns an McpTurnMetadataContext borrowing those values.

**Call relations**: Request-metadata tests use it to compute the expected metadata before comparing it with what production code builds.

*Call graph*: calls 1 internal fn (effective_reasoning_effort); called by 4 (codex_apps_tool_call_request_meta_includes_call_id_without_existing_codex_apps_meta, codex_apps_tool_call_request_meta_includes_turn_metadata_and_codex_apps_meta, mcp_tool_call_request_meta_includes_turn_metadata_for_custom_server, plugin_mcp_tool_call_request_meta_includes_plugin_id).


##### `write_sample_plugin_mcp`  (lines 97–119)

```
fn write_sample_plugin_mcp(codex_home: &std::path::Path)
```

**Purpose**: Creates a fake plugin on disk with a minimal MCP server configuration. Tests use this as a stand-in for a real installed plugin.

**Data flow**: It receives a Codex home directory, creates plugin folders, writes a plugin manifest, writes an MCP config file, and leaves those files for config-loading tests to discover.

**Call relations**: Plugin approval-mode and persistence tests call this before loading config so the plugin manager has something concrete to read.

*Call graph*: called by 3 (custom_mcp_tool_approval_mode_uses_plugin_mcp_policy, custom_mcp_tool_approval_mode_uses_updated_plugin_mcp_policy_after_cache_warm, maybe_persist_mcp_tool_approval_writes_plugin_mcp_policy); 3 external calls (join, create_dir_all, write).


##### `prompt_options`  (lines 121–129)

```
fn prompt_options(
    allow_session_remember: bool,
    allow_persistent_approval: bool,
) -> McpToolApprovalPromptOptions
```

**Purpose**: Builds the options that decide whether an approval prompt may offer “remember for this session” or “always remember.” It keeps prompt tests short and readable.

**Data flow**: It receives two booleans and returns an McpToolApprovalPromptOptions value with those exact settings.

**Call relations**: Prompt-building tests call it to describe which remember choices should appear in the approval UI.

*Call graph*: called by 5 (approval_elicitation_request_uses_message_override_and_preserves_tool_params_keys, codex_apps_tool_question_uses_fallback_app_label, custom_mcp_tool_question_mentions_server_name, custom_mcp_tool_question_offers_session_remember_and_always_allow, trusted_codex_apps_tool_question_offers_always_allow).


##### `execute_mcp_tool_call_records_replayable_correlation`  (lines 132–183)

```
async fn execute_mcp_tool_call_records_replayable_correlation() -> anyhow::Result<()>
```

**Purpose**: Checks that the real MCP execution path records a replayable correlation id for a tool call. This matters because trace replay needs to connect the model-visible call to the backend MCP call.

**Data flow**: It creates a temporary trace bundle, starts a fake session and dispatch trace, tries an MCP tool call that is expected to fail because no backend exists, then replays the trace files and verifies the correlation id was still written.

**Call relations**: This test uses the trace helpers in this file and exercises production MCP execution far enough to prove trace emission happens even when the synthetic backend is missing.

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

**Purpose**: Installs a temporary command hook that records permission-request input and returns a chosen decision. Tests use it to verify how MCP tool approvals interact with user hooks.

**Data flow**: It writes a Python script and hooks.json into the test Codex home, loads and trusts that hook config, stores a Hooks service in the session, and returns the path where hook inputs will be logged.

**Call relations**: Permission-hook tests call this setup helper before asking production approval code to evaluate an MCP tool call.

*Call graph*: calls 2 internal fn (trusted_config_layer_stack, new); called by 3 (permission_request_hook_allows_mcp_tool_call, permission_request_hook_runs_after_remembered_mcp_approval, permission_request_hook_uses_hook_tool_name_without_metadata); 12 external calls (new, to_string, new, assert_eq!, cfg!, list_hooks, format!, default, json!, create_dir_all (+2 more)).


##### `attach_trace_bundle`  (lines 275–301)

```
fn attach_trace_bundle(
    session: &mut Session,
    turn_context: &TurnContext,
    root: &Path,
) -> anyhow::Result<()>
```

**Purpose**: Attaches a test rollout trace bundle to a synthetic session. This gives trace-related tests a real place to write replay data.

**Data flow**: It receives a session, turn context, and root directory, starts a trace context with fixed test metadata, records that the turn started, and stores the trace context on the session.

**Call relations**: The trace-correlation test calls this before invoking MCP execution so the production code emits files into the temporary bundle.

*Call graph*: calls 1 internal fn (start_root_in_root_for_test); called by 1 (execute_mcp_tool_call_records_replayable_correlation); 1 external calls (from).


##### `single_bundle_dir`  (lines 304–311)

```
fn single_bundle_dir(root: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: Finds the one trace bundle directory produced during a test. It makes the trace test fail loudly if zero or multiple bundles were written.

**Data flow**: It reads the entries under a root directory, sorts them, asserts there is exactly one, and returns that path.

**Call relations**: The trace-correlation test calls this just before replaying the emitted bundle.

*Call graph*: called by 1 (execute_mcp_tool_call_records_replayable_correlation); 2 external calls (assert_eq!, read_dir).


##### `mcp_app_resource_uri_reads_known_tool_meta_keys`  (lines 314–340)

```
fn mcp_app_resource_uri_reads_known_tool_meta_keys()
```

**Purpose**: Verifies that app resource URIs are recognized from the supported metadata key formats. This protects compatibility with different MCP tool metadata styles.

**Data flow**: It builds sample metadata objects using nested, flat, and output-template keys, passes each into the URI extractor, and checks the expected URI comes out.

**Call relations**: This standalone test exercises the production metadata reader directly.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `openai_file_params_are_only_honored_for_codex_apps`  (lines 343–357)

```
fn openai_file_params_are_only_honored_for_codex_apps()
```

**Purpose**: Checks that OpenAI file-input metadata is trusted only for the special Codex Apps MCP server. This avoids applying app-specific file behavior to arbitrary servers.

**Data flow**: It builds metadata containing file parameters, asks the production helper for Codex Apps and for a normal server, and verifies only Codex Apps gets the file list.

**Call relations**: This test directly protects the server-name gate in the metadata extraction logic.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `approval_required_when_read_only_false_and_destructive`  (lines 360–363)

```
fn approval_required_when_read_only_false_and_destructive()
```

**Purpose**: Confirms that a tool marked not read-only and destructive requires approval. This is one of the core safety rules.

**Data flow**: It creates annotations with read-only false and destructive true, passes them to the approval-required helper, and expects true.

**Call relations**: It uses the annotations helper and checks the production approval decision rule.

*Call graph*: calls 1 internal fn (annotations); 1 external calls (assert_eq!).


##### `approval_required_when_read_only_false_and_open_world`  (lines 366–369)

```
fn approval_required_when_read_only_false_and_open_world()
```

**Purpose**: Confirms that a not-read-only tool that can affect the outside world requires approval. “Open world” means the tool may touch things beyond local safe context.

**Data flow**: It creates annotations with read-only false and open-world true, runs the approval-required helper, and expects true.

**Call relations**: It covers another branch of the production approval decision rule.

*Call graph*: calls 1 internal fn (annotations); 1 external calls (assert_eq!).


##### `approval_required_when_destructive_even_if_read_only_true`  (lines 372–375)

```
fn approval_required_when_destructive_even_if_read_only_true()
```

**Purpose**: Checks that a destructive hint wins even if a tool also claims to be read-only. This prevents contradictory metadata from making a dangerous tool look safe.

**Data flow**: It creates annotations with read-only true plus destructive and open-world true, evaluates approval need, and expects true.

**Call relations**: It tests that production logic treats destructive hints as important safety signals.

*Call graph*: calls 1 internal fn (annotations); 1 external calls (assert_eq!).


##### `approval_required_when_annotations_are_absent`  (lines 378–380)

```
fn approval_required_when_annotations_are_absent()
```

**Purpose**: Checks the conservative default: if a tool gives no safety hints, approval is required. Unknown safety should not be treated as safe.

**Data flow**: It passes no annotations into the approval-required helper and verifies the answer is true.

**Call relations**: This standalone test protects the fallback behavior of the approval rule.

*Call graph*: 1 external calls (assert_eq!).


##### `approval_not_required_when_read_only_and_other_hints_are_absent`  (lines 383–390)

```
fn approval_not_required_when_read_only_and_other_hints_are_absent()
```

**Purpose**: Confirms that a clearly read-only tool does not require approval when no risky hints are present. This keeps harmless read operations from interrupting the user.

**Data flow**: It creates read-only annotations with no destructive or open-world hints, evaluates approval need, and expects false.

**Call relations**: It balances the stricter approval tests by checking the safe path.

*Call graph*: calls 1 internal fn (annotations); 1 external calls (assert_eq!).


##### `prompt_mode_does_not_allow_persistent_remember`  (lines 393–408)

```
fn prompt_mode_does_not_allow_persistent_remember()
```

**Purpose**: Ensures prompt-only approval mode does not preserve session or permanent remember choices. In this mode, “remember” choices are normalized down to a one-time accept.

**Data flow**: It feeds session and persistent accept decisions into the normalizer with Prompt mode and checks both become plain Accept.

**Call relations**: This protects the production rule that Prompt mode asks each time rather than saving approval.

*Call graph*: 1 external calls (assert_eq!).


##### `mcp_tool_call_span_records_expected_fields`  (lines 411–459)

```
async fn mcp_tool_call_span_records_expected_fields()
```

**Purpose**: Checks that MCP tool-call tracing spans include useful observability fields. These fields help operators understand which server, connector, and tool were called.

**Data flow**: It installs a test tracing subscriber, creates a session, runs an empty async block inside an MCP span, reads the captured logs, and checks for expected field names and values.

**Call relations**: This test exercises the production span builder and verifies the emitted trace data is complete.

*Call graph*: calls 1 internal fn (make_session_and_context); 9 external calls (leak, new, new, from_utf8, new, assert!, new, set_default, fmt).


##### `mcp_result_telemetry_span_logs`  (lines 461–503)

```
async fn mcp_result_telemetry_span_logs(meta: Option<serde_json::Value>) -> String
```

**Purpose**: Captures trace logs produced when MCP result metadata is recorded onto a span. Other tests use it to check which result metadata becomes telemetry.

**Data flow**: It sets up an in-memory tracing subscriber, builds a test tool result with optional metadata, records telemetry inside an MCP span, and returns the captured log text.

**Call relations**: Telemetry tests call this helper with valid, invalid, missing, and oversized metadata.

*Call graph*: calls 1 internal fn (make_session_and_context); called by 3 (mcp_result_telemetry_ignores_invalid_and_missing_values, mcp_result_telemetry_records_allowlisted_span_fields, mcp_result_telemetry_truncates_long_target_id); 9 external calls (leak, new, new, current, from_utf8, new, new, set_default, fmt).


##### `mcp_result_telemetry_records_allowlisted_span_fields`  (lines 506–528)

```
async fn mcp_result_telemetry_records_allowlisted_span_fields()
```

**Purpose**: Verifies that only approved MCP result telemetry fields are promoted into tracing. This prevents arbitrary server metadata from becoming logs.

**Data flow**: It sends metadata with allowed fields and an extra sentinel field through the telemetry helper, then checks allowed fields appear and the sentinel does not.

**Call relations**: It relies on mcp_result_telemetry_span_logs to capture production span output.

*Call graph*: calls 1 internal fn (mcp_result_telemetry_span_logs); 2 external calls (assert!, json!).


##### `mcp_result_telemetry_ignores_invalid_and_missing_values`  (lines 531–563)

```
async fn mcp_result_telemetry_ignores_invalid_and_missing_values()
```

**Purpose**: Checks that malformed or absent telemetry metadata is ignored. Bad metadata should not create misleading trace fields.

**Data flow**: It captures logs for invalid types, missing span data, and no metadata, then verifies none of the telemetry fields were recorded.

**Call relations**: It uses the shared telemetry-log helper to exercise the production recorder under negative cases.

*Call graph*: calls 1 internal fn (mcp_result_telemetry_span_logs); 2 external calls (assert!, json!).


##### `mcp_result_telemetry_truncates_long_target_id`  (lines 566–582)

```
async fn mcp_result_telemetry_truncates_long_target_id()
```

**Purpose**: Ensures long telemetry target ids are shortened before logging. This keeps traces bounded and avoids huge field values.

**Data flow**: It builds a target id longer than the allowed character count, records it through the telemetry helper, and checks only the truncated prefix appears.

**Call relations**: It covers the production truncation path used by MCP result telemetry.

*Call graph*: calls 1 internal fn (mcp_result_telemetry_span_logs); 3 external calls (assert!, format!, json!).


##### `truncates_strings_on_char_boundaries`  (lines 585–595)

```
fn truncates_strings_on_char_boundaries()
```

**Purpose**: Checks that string truncation does not split a multi-byte character. This matters because invalid UTF-8 would break text handling.

**Data flow**: It builds a long string using accented characters, truncates it by character count, and verifies the result ends cleanly and short strings are unchanged.

**Call relations**: This directly tests the low-level helper used by telemetry truncation.

*Call graph*: 2 external calls (assert_eq!, format!).


##### `approval_elicitation_request_uses_message_override_and_preserves_tool_params_keys`  (lines 598–693)

```
async fn approval_elicitation_request_uses_message_override_and_preserves_tool_params_keys()
```

**Purpose**: Verifies that an MCP approval elicitation request can use a custom message while preserving the exact tool parameter keys. An elicitation is a structured prompt sent through MCP to ask the user for input.

**Data flow**: It builds a session, approval question, metadata, raw tool parameters, and display-friendly parameter labels, then checks the generated request matches the expected form and metadata.

**Call relations**: It exercises the production request builder using approval_metadata and prompt_options helpers.

*Call graph*: calls 3 internal fn (approval_metadata, prompt_options, make_session_and_context); 2 external calls (assert_eq!, json!).


##### `custom_mcp_tool_question_mentions_server_name`  (lines 696–721)

```
fn custom_mcp_tool_question_mentions_server_name()
```

**Purpose**: Checks the wording for approval prompts for ordinary custom MCP servers. The prompt should clearly name the server and tool.

**Data flow**: It builds a question for a custom server with no remember options, then checks the header, question text, and absence of the permanent remember option.

**Call relations**: It tests the production approval-question builder with simple prompt options.

*Call graph*: calls 1 internal fn (prompt_options); 2 external calls (assert!, assert_eq!).


##### `codex_apps_tool_question_uses_fallback_app_label`  (lines 724–740)

```
fn codex_apps_tool_question_uses_fallback_app_label()
```

**Purpose**: Checks that Codex Apps prompts say “this app” when no connector name is available. This avoids showing an empty or awkward connector label.

**Data flow**: It builds a Codex Apps question without connector metadata and verifies the fallback wording.

**Call relations**: It exercises the Codex Apps branch of the approval-question builder.

*Call graph*: calls 1 internal fn (prompt_options); 1 external calls (assert_eq!).


##### `trusted_codex_apps_tool_question_offers_always_allow`  (lines 743–776)

```
fn trusted_codex_apps_tool_question_offers_always_allow()
```

**Purpose**: Verifies that trusted Codex Apps prompts can offer both session and future remember choices. This confirms the full option list is shown when allowed.

**Data flow**: It builds a question with connector name and both remember options enabled, then checks the option labels and descriptions.

**Call relations**: It tests how prompt_options influences the production question builder.

*Call graph*: calls 1 internal fn (prompt_options); 2 external calls (assert!, assert_eq!).


##### `codex_apps_tool_question_without_elicitation_omits_always_allow`  (lines 779–812)

```
fn codex_apps_tool_question_without_elicitation_omits_always_allow()
```

**Purpose**: Checks that the permanent “always allow” option is hidden when MCP tool-call elicitation is disabled. This prevents offering a choice that cannot be handled safely.

**Data flow**: It builds approval keys, asks production code for prompt options with elicitation disabled, builds the question, and verifies only accept, session remember, and cancel remain.

**Call relations**: It connects prompt-option calculation with the approval-question builder.

*Call graph*: 1 external calls (assert_eq!).


##### `custom_mcp_tool_question_offers_session_remember_and_always_allow`  (lines 815–841)

```
fn custom_mcp_tool_question_offers_session_remember_and_always_allow()
```

**Purpose**: Confirms custom MCP servers can show both remember choices when those choices are enabled. This keeps custom servers aligned with Codex Apps behavior where appropriate.

**Data flow**: It builds a custom-server question with session and persistent remembering allowed and checks the option order.

**Call relations**: It exercises the generic server branch of the approval-question builder.

*Call graph*: calls 1 internal fn (prompt_options); 1 external calls (assert_eq!).


##### `custom_servers_support_session_and_persistent_approval`  (lines 844–868)

```
fn custom_servers_support_session_and_persistent_approval()
```

**Purpose**: Checks that custom MCP tools can produce both session and persistent approval keys. These keys are how Codex remembers that a user approved a specific tool.

**Data flow**: It creates a custom-server invocation, builds the expected key, and compares it with both session and persistent key builders.

**Call relations**: It directly tests the approval-key functions used before remembering or persisting approvals.

*Call graph*: 1 external calls (assert_eq!).


##### `codex_apps_connectors_support_persistent_approval`  (lines 871–898)

```
fn codex_apps_connectors_support_persistent_approval()
```

**Purpose**: Checks that Codex Apps connector tools can be remembered using connector-aware keys. The connector id keeps approvals scoped to the right app connector.

**Data flow**: It creates a Codex Apps invocation and connector metadata, builds the expected key, and verifies session and persistent key builders match it.

**Call relations**: It uses approval_metadata and tests the Codex Apps path in approval-key creation.

*Call graph*: calls 1 internal fn (approval_metadata); 1 external calls (assert_eq!).


##### `sanitize_mcp_tool_result_for_model_rewrites_image_content`  (lines 901–935)

```
fn sanitize_mcp_tool_result_for_model_rewrites_image_content()
```

**Purpose**: Ensures image results are replaced with text when the model cannot accept images. This prevents sending unsupported content to the model.

**Data flow**: It builds a result containing image and text content, sanitizes it with image support disabled, and checks the image became an explanatory text item while text stayed unchanged.

**Call relations**: It directly tests the production result sanitizer.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `sanitize_mcp_tool_result_for_model_preserves_image_when_supported`  (lines 938–957)

```
fn sanitize_mcp_tool_result_for_model_preserves_image_when_supported()
```

**Purpose**: Confirms image results are left untouched when the model supports image input. This avoids throwing away useful data unnecessarily.

**Data flow**: It builds a result with image content, structured content, error status, and metadata, sanitizes with image support enabled, and expects the original result back.

**Call relations**: It covers the positive path of the production result sanitizer.

*Call graph*: 3 external calls (assert_eq!, json!, vec!).


##### `truncate_mcp_tool_result_for_event_preserves_small_result`  (lines 960–975)

```
fn truncate_mcp_tool_result_for_event_preserves_small_result()
```

**Purpose**: Checks that small MCP results are not modified before being emitted as events. Normal-sized data should remain faithful.

**Data flow**: It builds a compact successful result, passes it to the event truncator, and verifies the output equals the original.

**Call relations**: It protects the no-truncation path in event-result formatting.

*Call graph*: 3 external calls (assert_eq!, json!, vec!).


##### `truncate_mcp_tool_result_for_event_bounds_large_result`  (lines 978–1012)

```
fn truncate_mcp_tool_result_for_event_bounds_large_result()
```

**Purpose**: Ensures very large successful MCP results are reduced before event emission. This keeps event messages from becoming enormous.

**Data flow**: It builds a result with huge text, structured content, and metadata, truncates it, serializes it, and checks it is bounded, drops extra fields, and includes a truncation marker.

**Call relations**: It tests the production size guard for successful MCP tool-call events.

*Call graph*: 5 external calls (assert!, assert_eq!, json!, to_string, vec!).


##### `truncate_mcp_tool_result_for_event_bounds_large_error`  (lines 1015–1023)

```
fn truncate_mcp_tool_result_for_event_bounds_large_error()
```

**Purpose**: Ensures very large MCP error strings are also shortened. Error events need the same size protection as successful results.

**Data flow**: It passes a huge error string to the event truncator and checks the returned error is bounded and marked as truncated.

**Call relations**: It covers the error branch of the production event truncation helper.

*Call graph*: 1 external calls (assert!).


##### `mcp_tool_call_request_meta_includes_turn_metadata_for_custom_server`  (lines 1026–1066)

```
async fn mcp_tool_call_request_meta_includes_turn_metadata_for_custom_server()
```

**Purpose**: Checks that custom MCP tool requests include current turn metadata. This lets servers know context such as model and reasoning effort.

**Data flow**: It creates a test turn, computes expected turn metadata, builds request metadata for a custom server, and compares the embedded values and full object.

**Call relations**: It uses mcp_turn_metadata_context to verify the production request-meta builder.

*Call graph*: calls 2 internal fn (mcp_turn_metadata_context, make_session_and_context); 1 external calls (assert_eq!).


##### `mcp_tool_call_request_meta_includes_turn_started_at_unix_ms`  (lines 1069–1092)

```
async fn mcp_tool_call_request_meta_includes_turn_started_at_unix_ms()
```

**Purpose**: Verifies that request metadata includes the turn start time when it is known. This timestamp can help servers and logs line up events.

**Data flow**: It sets a fixed turn-start time on the turn metadata state, builds MCP request metadata, and checks the timestamp is present.

**Call relations**: It directly tests the production metadata builder’s time-field behavior.

*Call graph*: calls 1 internal fn (make_session_and_context); 1 external calls (assert_eq!).


##### `plugin_mcp_tool_call_request_meta_includes_plugin_id`  (lines 1095–1115)

```
async fn plugin_mcp_tool_call_request_meta_includes_plugin_id()
```

**Purpose**: Checks that MCP requests from plugin-backed servers include the plugin id. This keeps downstream code aware of which plugin owns the server.

**Data flow**: It creates metadata with a plugin id, builds request metadata, and verifies both turn metadata and plugin id are present.

**Call relations**: It combines approval_metadata, mcp_turn_metadata_context, and the production request-meta builder.

*Call graph*: calls 3 internal fn (approval_metadata, mcp_turn_metadata_context, make_session_and_context); 1 external calls (assert_eq!).


##### `mcp_tool_call_item_includes_plugin_id`  (lines 1118–1149)

```
async fn mcp_tool_call_item_includes_plugin_id()
```

**Purpose**: Ensures the user-visible tool-call item records the plugin id when a plugin tool starts. This preserves plugin provenance in session events.

**Data flow**: It starts a session with an event receiver, sends a tool-call-start notification with plugin metadata, receives the event, and checks the item contains the plugin id.

**Call relations**: It exercises the production event notification path and inspects the emitted event.

*Call graph*: calls 1 internal fn (make_session_and_context_with_rx); 4 external calls (assert_eq!, panic!, from_secs, timeout).


##### `codex_apps_tool_call_request_meta_includes_turn_metadata_and_codex_apps_meta`  (lines 1152–1197)

```
async fn codex_apps_tool_call_request_meta_includes_turn_metadata_and_codex_apps_meta()
```

**Purpose**: Checks that Codex Apps tool requests include both turn metadata and app-specific metadata. The app metadata includes the call id and connector details used by the app server.

**Data flow**: It builds Codex Apps metadata with connector and resource values, builds request metadata, and compares it with the expected JSON object.

**Call relations**: It tests the Codex Apps branch of the production request-meta builder.

*Call graph*: calls 2 internal fn (mcp_turn_metadata_context, make_session_and_context); 2 external calls (assert_eq!, json!).


##### `codex_apps_tool_call_request_meta_includes_call_id_without_existing_codex_apps_meta`  (lines 1200–1221)

```
async fn codex_apps_tool_call_request_meta_includes_call_id_without_existing_codex_apps_meta()
```

**Purpose**: Verifies Codex Apps requests still include a call id even when no prior Codex Apps metadata exists. The call id is needed to correlate the tool call.

**Data flow**: It builds request metadata for Codex Apps without metadata and checks the output contains turn metadata plus a Codex Apps object with the call id.

**Call relations**: It covers the fallback path of the production request-meta builder.

*Call graph*: calls 2 internal fn (mcp_turn_metadata_context, make_session_and_context); 1 external calls (assert_eq!).


##### `codex_apps_auth_failure_result`  (lines 1223–1246)

```
fn codex_apps_auth_failure_result() -> CallToolResult
```

**Purpose**: Builds a fake MCP result representing a Codex Apps connector authentication failure. Tests use it to simulate a tool response that requires reauthentication.

**Data flow**: It returns a CallToolResult with error text and metadata describing an auth failure, connector id, connector name, link id, and error details.

**Call relations**: Authentication-elicitation tests call this helper before asking production code whether to prompt the user.

*Call graph*: called by 5 (codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result, codex_apps_auth_elicitation_feature_disabled_returns_original_result, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result, codex_apps_auth_elicitation_non_host_owned_server_returns_original_result); 2 external calls (json!, vec!).


##### `codex_apps_auth_failure_metadata`  (lines 1248–1256)

```
fn codex_apps_auth_failure_metadata() -> McpToolApprovalMetadata
```

**Purpose**: Builds trusted approval metadata for the fake auth-failing connector. It supplies the human-friendly connector name used in user messages.

**Data flow**: It delegates to approval_metadata with connector and tool labels and returns the resulting metadata object.

**Call relations**: Authentication-elicitation tests pair this metadata with codex_apps_auth_failure_result.

*Call graph*: calls 1 internal fn (approval_metadata); called by 5 (codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result, codex_apps_auth_elicitation_feature_disabled_returns_original_result, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result, codex_apps_auth_elicitation_non_host_owned_server_returns_original_result).


##### `install_host_owned_codex_apps_manager`  (lines 1258–1291)

```
async fn install_host_owned_codex_apps_manager(session: &Session, turn_context: &TurnContext)
```

**Purpose**: Installs a test MCP connection manager configured as host-owned for Codex Apps. Host-owned means Codex itself owns the app server connection and can issue special auth prompts.

**Data flow**: It reads auth from the session, constructs an McpConnectionManager with test runtime context and host-owned Codex Apps enabled, and stores it on the session services.

**Call relations**: Auth-elicitation tests call this setup helper when they need production code to treat Codex Apps as host-owned.

*Call graph*: calls 3 internal fn (new, new, permission_profile); called by 4 (codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result, codex_apps_auth_elicitation_feature_disabled_returns_original_result, codex_apps_auth_elicitation_feature_enabled_requests_elicitation, codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result); 7 external calls (new, new, new, default, codex_apps_tools_cache_key, get_tx_event, default).


##### `codex_apps_auth_elicitation_feature_disabled_returns_original_result`  (lines 1294–1312)

```
async fn codex_apps_auth_elicitation_feature_disabled_returns_original_result()
```

**Purpose**: Checks that auth elicitation does nothing when the feature flag is off. A feature flag is a switch used to enable or disable behavior.

**Data flow**: It installs a host-owned manager, builds an auth-failure result, calls the auth-elicitation helper, and verifies the original result is returned and no event is sent.

**Call relations**: It uses the auth-failure and manager helpers to test the disabled-feature path.

*Call graph*: calls 4 internal fn (codex_apps_auth_failure_metadata, codex_apps_auth_failure_result, install_host_owned_codex_apps_manager, make_session_and_context_with_rx); 2 external calls (assert!, assert_eq!).


##### `codex_apps_auth_elicitation_non_host_owned_server_returns_original_result`  (lines 1315–1337)

```
async fn codex_apps_auth_elicitation_non_host_owned_server_returns_original_result()
```

**Purpose**: Checks that auth elicitation is skipped unless the Codex Apps server is host-owned. This prevents special auth behavior for ordinary servers.

**Data flow**: It enables the feature but does not install a host-owned manager, calls production auth-elicitation logic, and verifies no prompt is emitted and the result is unchanged.

**Call relations**: It tests one guard condition before auth prompts are allowed.

*Call graph*: calls 5 internal fn (from, codex_apps_auth_failure_metadata, codex_apps_auth_failure_result, make_session_and_context_with_rx, with_defaults); 3 external calls (get_mut, assert!, assert_eq!).


##### `codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result`  (lines 1340–1366)

```
async fn codex_apps_auth_elicitation_disallowed_by_policy_returns_original_result()
```

**Purpose**: Checks that auth elicitation respects the approval policy when prompts are disallowed. If the policy says never ask, the original result stays unchanged.

**Data flow**: It enables the feature, installs a host-owned manager, sets approval policy to Never, calls the helper, and verifies no event and no result change.

**Call relations**: It tests the policy gate in production auth-elicitation behavior.

*Call graph*: calls 6 internal fn (from, codex_apps_auth_failure_metadata, codex_apps_auth_failure_result, install_host_owned_codex_apps_manager, make_session_and_context_with_rx, with_defaults); 3 external calls (get_mut, assert!, assert_eq!).


##### `codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result`  (lines 1369–1401)

```
async fn codex_apps_auth_elicitation_granular_mcp_disabled_returns_original_result()
```

**Purpose**: Checks that granular approval settings can specifically disable MCP elicitations. Granular means different prompt types can be allowed or blocked separately.

**Data flow**: It enables the feature, installs a host-owned manager, configures granular approvals with MCP elicitations disabled, calls the helper, and expects the original result with no event.

**Call relations**: It covers the granular-policy branch of production auth-elicitation logic.

*Call graph*: calls 6 internal fn (from, codex_apps_auth_failure_metadata, codex_apps_auth_failure_result, install_host_owned_codex_apps_manager, make_session_and_context_with_rx, with_defaults); 4 external calls (get_mut, Granular, assert!, assert_eq!).


##### `codex_apps_auth_elicitation_feature_enabled_requests_elicitation`  (lines 1404–1474)

```
async fn codex_apps_auth_elicitation_feature_enabled_requests_elicitation()
```

**Purpose**: Verifies the full auth-elicitation path when all gates allow it. The user should receive a URL-style prompt, and accepting it should change the tool result into a retry message.

**Data flow**: It enables the feature, installs a host-owned manager, starts an active turn, calls auth-elicitation in a task, waits for an elicitation event, resolves it as accepted, and checks the returned result tells the model to retry.

**Call relations**: It is the positive counterpart to the auth-elicitation guard tests and exercises event sending plus response handling.

*Call graph*: calls 7 internal fn (from, codex_apps_auth_failure_metadata, codex_apps_auth_failure_result, install_host_owned_codex_apps_manager, make_session_and_context_with_rx, default, with_defaults); 8 external calls (clone, get_mut, String, assert!, assert_eq!, from_secs, spawn, timeout).


##### `mcp_tool_call_thread_id_meta_is_added_to_request_meta`  (lines 1477–1503)

```
fn mcp_tool_call_thread_id_meta_is_added_to_request_meta()
```

**Purpose**: Checks that a live thread id is inserted into MCP request metadata. If a stale thread id exists, it should be replaced.

**Data flow**: It tries metadata with an old thread id, no metadata, and invalid non-object metadata, then verifies object metadata gets the live thread id while invalid metadata is preserved.

**Call relations**: It directly tests the production helper that adds thread identity to outgoing MCP metadata.

*Call graph*: 1 external calls (assert_eq!).


##### `accepted_elicitation_content_converts_to_request_user_input_response`  (lines 1506–1524)

```
fn accepted_elicitation_content_converts_to_request_user_input_response()
```

**Purpose**: Checks that accepted elicitation content can be converted into the older request-user-input response shape. This keeps two approval-response paths compatible.

**Data flow**: It supplies JSON content containing an approval choice and verifies the converted response has the same choice under the expected answer key.

**Call relations**: It tests the adapter used when MCP elicitation responses need to feed existing approval parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `approval_elicitation_meta_marks_tool_approvals`  (lines 1527–1542)

```
fn approval_elicitation_meta_marks_tool_approvals()
```

**Purpose**: Verifies that approval elicitation metadata always marks the request as an MCP tool-call approval. This lets clients know what kind of prompt they are showing.

**Data flow**: It builds approval metadata with no connector or tool parameters and checks the output contains the approval kind marker.

**Call relations**: It directly tests the production metadata builder for the simplest case.

*Call graph*: 1 external calls (assert_eq!).


##### `approval_elicitation_meta_merges_session_and_always_persist_for_custom_servers`  (lines 1545–1575)

```
fn approval_elicitation_meta_merges_session_and_always_persist_for_custom_servers()
```

**Purpose**: Checks that custom-server approval metadata includes both remember scopes when both are allowed. It also verifies tool title, description, and parameters are copied.

**Data flow**: It builds metadata and parameters for a custom server, enables both remember options, and compares the produced JSON with the expected object.

**Call relations**: It exercises the generic-server branch of the production approval-elicitation metadata builder.

*Call graph*: 1 external calls (assert_eq!).


##### `guardian_mcp_review_request_includes_invocation_metadata`  (lines 1578–1616)

```
fn guardian_mcp_review_request_includes_invocation_metadata()
```

**Purpose**: Verifies that a Guardian review request includes the MCP invocation and connector/tool metadata. Guardian is an automated reviewer that can approve or deny risky actions.

**Data flow**: It builds an invocation with arguments and metadata, asks production code to build a Guardian request, and checks every expected field is present.

**Call relations**: It tests the request shape sent to Guardian before an MCP tool call is reviewed.

*Call graph*: calls 1 internal fn (approval_metadata); 2 external calls (assert_eq!, json!).


##### `guardian_mcp_review_request_includes_annotations_when_present`  (lines 1619–1659)

```
fn guardian_mcp_review_request_includes_annotations_when_present()
```

**Purpose**: Checks that Guardian review requests include MCP safety annotations when available. This helps Guardian judge risk using read-only, destructive, and open-world hints.

**Data flow**: It builds metadata containing annotations, creates a Guardian request, and compares it with the expected annotated request.

**Call relations**: It uses the annotations helper and exercises the annotation-mapping branch of the Guardian request builder.

*Call graph*: calls 1 internal fn (annotations); 1 external calls (assert_eq!).


##### `guardian_review_decision_maps_to_mcp_tool_decision`  (lines 1662–1719)

```
async fn guardian_review_decision_maps_to_mcp_tool_decision()
```

**Purpose**: Checks how Guardian decisions become MCP approval decisions. Approved becomes accept, while denied or timed out becomes a decline with the right message.

**Data flow**: It creates a session, maps approved, denied, timed-out, and abort decisions, stores a rejection rationale for the denied case, and checks the resulting approval decisions.

**Call relations**: It directly tests the bridge between Guardian review results and MCP approval flow.

*Call graph*: calls 1 internal fn (make_session_and_context); 4 external calls (new, assert!, assert_eq!, panic!).


##### `approval_elicitation_meta_includes_connector_source_for_codex_apps`  (lines 1722–1754)

```
fn approval_elicitation_meta_includes_connector_source_for_codex_apps()
```

**Purpose**: Verifies that Codex Apps approval metadata identifies connector-based requests. This lets clients show connector name, description, and tool details.

**Data flow**: It builds Codex Apps connector metadata and tool parameters, generates approval metadata, and checks connector source fields are present.

**Call relations**: It exercises the Codex Apps connector branch of the approval-elicitation metadata builder.

*Call graph*: 1 external calls (assert_eq!).


##### `approval_elicitation_meta_merges_session_and_always_persist_with_connector_source`  (lines 1757–1793)

```
fn approval_elicitation_meta_merges_session_and_always_persist_with_connector_source()
```

**Purpose**: Checks that Codex Apps connector metadata includes both remember choices when allowed. It combines connector identity with session and permanent persistence markers.

**Data flow**: It builds connector metadata and parameters, enables both remember options, and verifies the produced JSON includes all connector and persistence fields.

**Call relations**: It extends the connector metadata test to cover the remember-options branch.

*Call graph*: 1 external calls (assert_eq!).


##### `declined_elicitation_response_stays_decline`  (lines 1796–1809)

```
fn declined_elicitation_response_stays_decline()
```

**Purpose**: Ensures a declined elicitation action remains a decline even if its content says accept. The explicit user action must win over conflicting content.

**Data flow**: It builds an elicitation response with Decline action and accept-like content, parses it, and expects a decline decision.

**Call relations**: It tests the production parser’s priority rules for elicitation responses.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `synthetic_decline_request_user_input_response_stays_decline`  (lines 1812–1826)

```
fn synthetic_decline_request_user_input_response_stays_decline()
```

**Purpose**: Checks that a synthetic decline value in a request-user-input response parses as a decline. This supports internal cancellation paths.

**Data flow**: It builds a response containing the synthetic decline token, parses it, and verifies the decision is decline with no message.

**Call relations**: It directly tests the legacy approval-response parser.

*Call graph*: 3 external calls (from, assert_eq!, vec!).


##### `accepted_elicitation_response_uses_always_persist_meta`  (lines 1829–1842)

```
fn accepted_elicitation_response_uses_always_persist_meta()
```

**Purpose**: Verifies that accepted elicitation responses can request permanent remembering through metadata. This turns a plain accept action into AcceptAndRemember.

**Data flow**: It builds an accepted elicitation response with persist-always metadata, parses it, and expects AcceptAndRemember.

**Call relations**: It tests the production parser’s handling of persistence metadata.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `accepted_elicitation_response_uses_session_persist_meta`  (lines 1845–1858)

```
fn accepted_elicitation_response_uses_session_persist_meta()
```

**Purpose**: Verifies that accepted elicitation responses can request session-only remembering through metadata. This turns a plain accept action into AcceptForSession.

**Data flow**: It builds an accepted elicitation response with persist-session metadata, parses it, and expects AcceptForSession.

**Call relations**: It covers the session-persistence branch of the elicitation-response parser.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `accepted_elicitation_without_content_defaults_to_accept`  (lines 1861–1872)

```
fn accepted_elicitation_without_content_defaults_to_accept()
```

**Purpose**: Checks that an accepted elicitation with no content or metadata becomes a simple accept. This is the safe default for positive responses.

**Data flow**: It parses an accepted response with no content and no metadata and verifies the result is Accept.

**Call relations**: It covers the default accept path in the production elicitation parser.

*Call graph*: 1 external calls (assert_eq!).


##### `persist_codex_app_tool_approval_writes_tool_override`  (lines 1875–1917)

```
async fn persist_codex_app_tool_approval_writes_tool_override()
```

**Purpose**: Checks that permanently approving a Codex App tool writes the correct app-tool override to config.toml. This is how “always allow” survives future sessions.

**Data flow**: It creates a temporary config, persists approval for a calendar tool, reads the TOML file back, parses it, and checks the app tool approval mode is Approve.

**Call relations**: It directly tests the production config-writing function for Codex Apps.

*Call graph*: 6 external calls (assert!, assert_eq!, default, read_to_string, tempdir, from_str).


##### `persist_custom_mcp_tool_approval_writes_tool_override`  (lines 1920–1952)

```
async fn persist_custom_mcp_tool_approval_writes_tool_override()
```

**Purpose**: Checks that permanently approving a custom MCP tool writes the correct server-tool override to config.toml.

**Data flow**: It seeds a temporary MCP server config, persists approval for one tool, reads and parses the file, and verifies the server tool has approval mode Approve.

**Call relations**: It tests the custom-server config writer used by persistent approvals.

*Call graph*: 7 external calls (assert!, assert_eq!, default, read_to_string, write, tempdir, from_str).


##### `custom_mcp_tool_approval_mode_uses_server_default_with_tool_override`  (lines 1955–1989)

```
async fn custom_mcp_tool_approval_mode_uses_server_default_with_tool_override()
```

**Purpose**: Verifies custom MCP approval mode lookup uses a server default unless a specific tool override exists. Unknown servers fall back to Auto.

**Data flow**: It writes config with a default mode and one tool override, loads it into a turn context, and checks lookup results for a normal tool, overridden tool, and unknown server.

**Call relations**: It tests the production approval-mode resolver for plain custom MCP servers.

*Call graph*: calls 1 internal fn (make_session_and_context); 5 external calls (new, assert_eq!, default, write, tempdir).


##### `custom_mcp_tool_approval_mode_uses_plugin_mcp_policy`  (lines 1992–2029)

```
async fn custom_mcp_tool_approval_mode_uses_plugin_mcp_policy()
```

**Purpose**: Checks that plugin-provided MCP servers use approval policies from plugin config. Plugin defaults and tool overrides should both apply.

**Data flow**: It creates a sample plugin, writes plugin config with a default and one tool override, reloads config, clears plugin cache, and checks approval-mode lookup results.

**Call relations**: It uses write_sample_plugin_mcp and tests plugin-aware approval-mode resolution.

*Call graph*: calls 2 internal fn (write_sample_plugin_mcp, make_session_and_context); 4 external calls (new, assert_eq!, default, write).


##### `custom_mcp_tool_approval_mode_uses_updated_plugin_mcp_policy_after_cache_warm`  (lines 2032–2082)

```
async fn custom_mcp_tool_approval_mode_uses_updated_plugin_mcp_policy_after_cache_warm()
```

**Purpose**: Ensures plugin MCP approval lookup sees updated config even after the plugin cache has been warmed. This prevents stale approval rules.

**Data flow**: It creates a plugin, loads initial config to warm the cache, rewrites config with a tool approval override, reloads config, and verifies the new override is used.

**Call relations**: It tests the interaction between plugin caching and approval-mode lookup.

*Call graph*: calls 2 internal fn (write_sample_plugin_mcp, make_session_and_context); 4 external calls (new, assert_eq!, default, write).


##### `maybe_persist_mcp_tool_approval_reloads_session_config`  (lines 2085–2121)

```
async fn maybe_persist_mcp_tool_approval_reloads_session_config()
```

**Purpose**: Checks that persisting a Codex Apps approval also reloads the session config. The running session should immediately know the approval is remembered.

**Data flow**: It creates a session, persists a connector tool approval key, reads the session’s reloaded config, verifies the tool override exists, and checks the approval is remembered.

**Call relations**: It exercises the higher-level persistence flow rather than just the file writer.

*Call graph*: calls 1 internal fn (make_session_and_context); 3 external calls (assert_eq!, deserialize, create_dir_all).


##### `maybe_persist_mcp_tool_approval_reloads_session_config_for_custom_server`  (lines 2124–2169)

```
async fn maybe_persist_mcp_tool_approval_reloads_session_config_for_custom_server()
```

**Purpose**: Checks the same persistence-and-reload behavior for a custom MCP server. The remembered approval should be visible in the active session.

**Data flow**: It seeds custom MCP config, loads it into the turn context, persists a tool approval key, then verifies the session config contains the new server-tool override and remembers the key.

**Call relations**: It tests the custom-server path through the high-level persistence helper.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, make_session_and_context); 5 external calls (new, deserialize, assert_eq!, create_dir_all, write).


##### `maybe_persist_mcp_tool_approval_writes_plugin_mcp_policy`  (lines 2172–2219)

```
async fn maybe_persist_mcp_tool_approval_writes_plugin_mcp_policy()
```

**Purpose**: Checks that persisting approval for a plugin MCP tool writes the policy under that plugin’s config section. This keeps plugin approvals scoped correctly.

**Data flow**: It creates a sample plugin and config, persists approval for a plugin tool, reads config.toml, verifies the plugin tool override exists, and checks the session remembers it.

**Call relations**: It combines plugin setup with the high-level approval persistence flow.

*Call graph*: calls 2 internal fn (write_sample_plugin_mcp, make_session_and_context); 7 external calls (new, assert!, assert_eq!, default, read_to_string, write, from_str).


##### `maybe_persist_mcp_tool_approval_writes_project_config_for_project_server`  (lines 2222–2274)

```
async fn maybe_persist_mcp_tool_approval_writes_project_config_for_project_server()
```

**Purpose**: Verifies that approvals for project-defined MCP servers are written to the project’s config file, not the global one. This keeps project-specific trust local to the project.

**Data flow**: It creates a fake trusted project with its own .codex config, loads config from that project, persists a tool approval, reads the project config, and checks the override and remembered state.

**Call relations**: It tests config-layer selection inside the high-level persistence helper.

*Call graph*: calls 2 internal fn (new, make_session_and_context); 9 external calls (new, assert!, assert_eq!, default, create_dir_all, read_to_string, write, tempdir, from_str).


##### `approve_mode_skips_when_annotations_do_not_require_approval`  (lines 2277–2315)

```
async fn approve_mode_skips_when_annotations_do_not_require_approval()
```

**Purpose**: Checks that Approve mode does not prompt for a tool whose annotations show it is safe. Approve mode should only intervene when approval is actually required.

**Data flow**: It creates a read-only invocation and metadata, calls the production approval request helper in Approve mode, and expects no decision because no prompt was needed.

**Call relations**: It tests approval skipping based on annotations.

*Call graph*: calls 3 internal fn (annotations, make_session_and_context, new); 2 external calls (new, assert_eq!).


##### `guardian_mode_skips_auto_when_annotations_do_not_require_approval`  (lines 2318–2389)

```
async fn guardian_mode_skips_auto_when_annotations_do_not_require_approval()
```

**Purpose**: Checks that AutoReview Guardian mode also skips review for clearly safe read-only tools. The test ensures no model-review HTTP request is made.

**Data flow**: It starts a mock server expecting zero review calls, configures auto review, creates read-only metadata, asks for approval in Auto mode, and expects no decision.

**Call relations**: It tests that annotation-based skipping happens before Guardian review dispatch.

*Call graph*: calls 5 internal fn (annotations, make_session_and_context, models_manager_with_provider, new, start_mock_server); 7 external calls (clone, new, given, new, assert_eq!, create_model_provider, format!).


##### `permission_request_hook_allows_mcp_tool_call`  (lines 2392–2472)

```
async fn permission_request_hook_allows_mcp_tool_call()
```

**Purpose**: Verifies that a PermissionRequest hook can allow an MCP tool call. Hooks are user-configured commands that can inspect and decide on tool permissions.

**Data flow**: It installs a hook that returns allow, builds a risky MCP invocation, asks production approval logic for a decision, then reads the hook log and verifies the hook received the expected input.

**Call relations**: It uses install_mcp_permission_request_hook and tests hook integration in the approval flow.

*Call graph*: calls 4 internal fn (annotations, install_mcp_permission_request_hook, make_session_and_context, new); 4 external calls (new, assert_eq!, json!, read_to_string).


##### `permission_request_hook_uses_hook_tool_name_without_metadata`  (lines 2475–2529)

```
async fn permission_request_hook_uses_hook_tool_name_without_metadata()
```

**Purpose**: Checks that PermissionRequest hooks still receive the correct hook tool name when MCP metadata is absent. Missing metadata should not prevent hook matching.

**Data flow**: It installs an allow hook, builds an invocation without metadata, runs approval logic, and checks the logged hook input includes the expected tool name and arguments.

**Call relations**: It tests a metadata-missing branch of hook integration.

*Call graph*: calls 3 internal fn (install_mcp_permission_request_hook, make_session_and_context, new); 4 external calls (new, assert_eq!, json!, read_to_string).


##### `permission_request_hook_runs_after_remembered_mcp_approval`  (lines 2532–2592)

```
async fn permission_request_hook_runs_after_remembered_mcp_approval()
```

**Purpose**: Despite its name, this test verifies a remembered MCP approval skips the PermissionRequest hook. A previously remembered approval should short-circuit later checks.

**Data flow**: It installs a denying hook, remembers approval for a risky invocation, runs approval logic, expects accept, and confirms the hook log file was never created.

**Call relations**: It tests the ordering of remembered approvals versus hook execution.

*Call graph*: calls 4 internal fn (annotations, install_mcp_permission_request_hook, make_session_and_context, new); 4 external calls (new, assert!, assert_eq!, json!).


##### `guardian_mode_mcp_denial_returns_rationale_message`  (lines 2595–2680)

```
async fn guardian_mode_mcp_denial_returns_rationale_message()
```

**Purpose**: Checks that when Guardian denies an MCP tool call, the returned decline message includes the reviewer’s rationale and anti-circumvention warning. This gives the model a clear reason not to retry the same outcome.

**Data flow**: It mocks a Guardian response that denies with a rationale, configures auto review, builds a risky invocation, runs approval logic, and checks the decline message and review request.

**Call relations**: It exercises the full Guardian review path through MCP approval logic.

*Call graph*: calls 7 internal fn (annotations, make_session_and_context, models_manager_with_provider, new, mount_sse_once, sse, start_mock_server); 9 external calls (clone, new, assert!, assert_eq!, create_model_provider, format!, panic!, json!, vec!).


##### `prompt_mode_waits_for_approval_when_annotations_do_not_require_approval`  (lines 2683–2735)

```
async fn prompt_mode_waits_for_approval_when_annotations_do_not_require_approval()
```

**Purpose**: Confirms Prompt mode still waits for user approval even for read-only tools. Prompt mode means the user explicitly asked to be prompted.

**Data flow**: It starts an active turn, launches approval logic for a read-only tool in a background task, waits briefly, and verifies the task has not completed automatically.

**Call relations**: It tests that Prompt mode overrides the annotation-based auto-skip behavior.

*Call graph*: calls 4 internal fn (annotations, make_session_and_context_with_rx, default, new); 3 external calls (clone, assert!, spawn).


##### `full_access_mode_skips_mcp_tool_approval_for_all_approval_modes`  (lines 2738–2784)

```
async fn full_access_mode_skips_mcp_tool_approval_for_all_approval_modes()
```

**Purpose**: Checks that when the permission profile disables restrictions and approval policy is Never, MCP approval is skipped for Auto, Prompt, and Approve modes. This represents full-access operation.

**Data flow**: It configures a session for no approvals and disabled permission restrictions, builds a risky Codex Apps invocation, runs approval logic in each mode, and expects no decision each time.

**Call relations**: It tests the top-level full-access bypass in production approval logic.

*Call graph*: calls 3 internal fn (annotations, make_session_and_context, new); 3 external calls (new, assert_eq!, json!).


##### `approve_mode_skips_guardian_in_every_permission_mode`  (lines 2787–2872)

```
async fn approve_mode_skips_guardian_in_every_permission_mode()
```

**Purpose**: Verifies that Approve mode does not call Guardian, regardless of the broader approval policy. Approve mode should directly allow approved tools without automated review.

**Data flow**: It starts a mock review server expecting no calls, loops through several approval policies, configures each session, runs MCP approval logic in Approve mode, and expects no decision.

**Call relations**: It tests that Guardian dispatch is bypassed before any external review request is made.

*Call graph*: calls 7 internal fn (annotations, make_session_and_context, auth_manager_from_auth, models_manager_with_provider, new, start_mock_server, create_dummy_chatgpt_auth_for_testing); 9 external calls (clone, new, given, new, Granular, assert_eq!, create_model_provider, format!, json!).


### `core/src/unified_exec/async_watcher_tests.rs`

`test` · `test run`

This is a small test file for `split_valid_utf8_prefix_with_max`, a helper that takes bytes from the front of a buffer. The real-world problem is that command output or watched process output often arrives as raw bytes, not neat lines of text. The system may need to emit only a limited number of bytes at a time, but it must avoid breaking valid UTF-8 text in the middle of a character. UTF-8 is the common text encoding where some characters, like `é`, take more than one byte.

The tests cover three important cases. First, plain ASCII text is simple: each character is one byte, so the helper should split exactly at the requested byte limit. Second, multi-byte characters need care: if the limit falls in the middle of a character, the helper should stop earlier rather than produce broken text. Third, not all input is valid UTF-8. If the buffer starts with an invalid byte, the helper should still remove something and make progress, instead of getting stuck forever. Think of it like cutting a ribbon into short pieces: cut at the mark when safe, move the cut slightly earlier if it would slice through a symbol, and still snip off a bad knot so the process can continue.

#### Function details

##### `split_valid_utf8_prefix_respects_max_bytes_for_ascii`  (lines 6–18)

```
fn split_valid_utf8_prefix_respects_max_bytes_for_ascii()
```

**Purpose**: This test checks the easy case: ordinary ASCII text, where every character is one byte. It proves that the splitter takes no more than the requested byte count and leaves the rest of the buffer behind for later.

**Data flow**: It starts with the byte buffer for `hello word!`. It asks `split_valid_utf8_prefix_with_max` for up to 5 bytes, then checks that `hello` comes out and the buffer now starts with ` word!`. It asks again with the same limit, checks that ` word` comes out, and confirms only `!` remains.

**Call relations**: During the test run, the Rust test framework calls this function. The function calls `split_valid_utf8_prefix_with_max` to exercise the real splitter, then uses `assert_eq!` to compare the actual output and leftover buffer with the expected values.

*Call graph*: 2 external calls (assert_eq!, split_valid_utf8_prefix_with_max).


##### `split_valid_utf8_prefix_avoids_splitting_utf8_codepoints`  (lines 21–29)

```
fn split_valid_utf8_prefix_avoids_splitting_utf8_codepoints()
```

**Purpose**: This test checks that the splitter does not cut through a multi-byte UTF-8 character. That matters because a half character would not be valid text and could confuse later text processing.

**Data flow**: It starts with the UTF-8 bytes for `ééé`, where each `é` takes 2 bytes. It asks for up to 3 bytes, which is enough for one full `é` but not two. The test checks that the returned bytes decode to exactly one `é`, and that the buffer still contains the remaining two `é` characters.

**Call relations**: The Rust test framework runs this test as part of the suite. The test sends a multi-byte text buffer into `split_valid_utf8_prefix_with_max`, then uses `assert_eq!` to verify that the helper chose a safe character boundary rather than blindly using the byte limit.

*Call graph*: 2 external calls (assert_eq!, split_valid_utf8_prefix_with_max).


##### `split_valid_utf8_prefix_makes_progress_on_invalid_utf8`  (lines 32–39)

```
fn split_valid_utf8_prefix_makes_progress_on_invalid_utf8()
```

**Purpose**: This test checks a failure-resistant behavior: even if the buffer begins with an invalid UTF-8 byte, the splitter should still consume something. Without this, a stream reader could get stuck seeing the same bad byte over and over.

**Data flow**: It starts with a buffer containing an invalid byte `0xff`, followed by the valid ASCII bytes `a` and `b`. It asks for up to 2 bytes. The expected result is that the invalid byte is returned by itself, and the buffer is shortened to just `ab`.

**Call relations**: The test framework calls this function during testing. The function builds a deliberately mixed valid-and-invalid byte buffer, passes it to `split_valid_utf8_prefix_with_max`, and uses `assert_eq!` to confirm that the helper made forward progress while preserving the remaining bytes for future processing.

*Call graph*: 3 external calls (assert_eq!, split_valid_utf8_prefix_with_max, vec!).


### `core/src/unified_exec/head_tail_buffer_tests.rs`

`test` · `test run`

`HeadTailBuffer` is a bounded byte buffer: it remembers a fixed-size sample of data by keeping the “head” at the start and the “tail” at the end. That is useful for long command output or logs, where the first few bytes explain what started and the last few bytes show how it ended, but the middle may be too large to keep. This test file acts like a safety checklist for that behavior.

The tests feed small byte chunks into the buffer and then ask simple questions: How many bytes are still retained? How many were omitted? What bytes would be returned to a caller? They cover normal overflow, a zero-size buffer, a one-byte buffer, draining the buffer back to empty, a single chunk that is larger than the tail space, and filling the head and tail gradually across several chunks.

An everyday analogy is a notebook with only ten spaces: you copy the first five words and the last five words of a long message, and count how many words you skipped. These tests make sure the notebook never silently keeps the wrong words, forgets to count skipped data, or fails to reset after its contents are taken out.

#### Function details

##### `keeps_prefix_and_suffix_when_over_budget`  (lines 6–19)

```
fn keeps_prefix_and_suffix_when_over_budget()
```

**Purpose**: This test proves that when more bytes arrive than the buffer is allowed to keep, it preserves useful bytes from both the start and the end. It checks the core promise of `HeadTailBuffer`: drop the middle, not the edges.

**Data flow**: It starts with a new buffer limited to 10 bytes, then pushes ten bytes followed by two more. Before the extra bytes, nothing is omitted; after them, some bytes must be omitted. The test turns the saved bytes into readable text and verifies that the result still begins with `01234` and ends with `89ab`.

**Call relations**: During the test run, Rust’s test runner calls this function. The function creates a buffer with `HeadTailBuffer::new`, feeds it data, uses UTF-8 conversion so the retained bytes can be checked as text, and relies on assertions to fail the test if the prefix or suffix rule is broken.

*Call graph*: calls 1 internal fn (new); 3 external calls (from_utf8_lossy, assert!, assert_eq!).


##### `max_bytes_zero_drops_everything`  (lines 22–30)

```
fn max_bytes_zero_drops_everything()
```

**Purpose**: This test checks the edge case where the buffer is allowed to keep zero bytes. In that situation, every incoming byte should be counted as omitted and nothing should be returned.

**Data flow**: It creates a buffer with a maximum size of 0 and pushes `abc` into it. After that, retained bytes are 0, omitted bytes are 3, converting the buffer to bytes returns an empty list, and asking for chunk snapshots also returns no chunks.

**Call relations**: The test runner calls this function as one of the buffer checks. It uses `HeadTailBuffer::new` to create the zero-capacity case and assertion checks to confirm that all public views of the buffer agree that nothing was retained.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `head_budget_zero_keeps_only_last_byte_in_tail`  (lines 33–40)

```
fn head_budget_zero_keeps_only_last_byte_in_tail()
```

**Purpose**: This test checks the smallest non-empty buffer size. With room for only one byte, the buffer should keep the newest final byte and omit everything before it.

**Data flow**: It creates a buffer with a 1-byte limit and pushes `abc`. The buffer ends with 1 retained byte, 2 omitted bytes, and its saved output is just `c`.

**Call relations**: The test runner calls this function to cover a tight boundary case. It creates the buffer through `HeadTailBuffer::new` and uses equality assertions to confirm that the buffer behaves like a one-slot tail, keeping only the latest byte.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `draining_resets_state`  (lines 43–54)

```
fn draining_resets_state()
```

**Purpose**: This test makes sure that taking the saved chunks out of the buffer also clears its internal counters and stored bytes. Without this, later use could be polluted by old output.

**Data flow**: It creates a 10-byte buffer, pushes enough data to exceed the limit, and then drains the saved chunks out. The drained result must contain something, and afterward the buffer reports 0 retained bytes, 0 omitted bytes, and no saved byte output.

**Call relations**: The test runner calls this function to check cleanup behavior. The test creates a buffer, fills it, calls the buffer’s draining operation, and then uses assertions to verify that the buffer has returned to a fresh empty state.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `chunk_larger_than_tail_budget_keeps_only_tail_end`  (lines 57–68)

```
fn chunk_larger_than_tail_budget_keeps_only_tail_end()
```

**Purpose**: This test checks what happens when a single incoming chunk is bigger than the space reserved for the tail. The buffer should keep only the end of that large chunk for the tail, because those are the most recent bytes.

**Data flow**: It creates a 10-byte buffer and fills it with `0123456789`. Then it pushes `ABCDEFGHIJK`, which is too large to fit in the tail area. The final saved bytes should still start with `01234`, end with `GHIJK`, and report that some bytes were omitted.

**Call relations**: The test runner calls this function as a stress case for chunk replacement. It uses `HeadTailBuffer::new`, converts the output to readable text for prefix and suffix checks, and uses assertions to confirm that an oversized chunk does not crowd out the saved head.

*Call graph*: calls 1 internal fn (new); 2 external calls (from_utf8_lossy, assert!).


##### `fills_head_then_tail_across_multiple_chunks`  (lines 71–89)

```
fn fills_head_then_tail_across_multiple_chunks()
```

**Purpose**: This test proves the buffer behaves correctly when data arrives in several small pieces instead of one big piece. It checks that the head fills first, then the tail fills, and only then does the oldest tail byte get dropped.

**Data flow**: It creates a 10-byte buffer. It pushes `01` and `234`, which together fill the 5-byte head, then pushes `567` and `89`, filling the remaining space without omitting anything. When it pushes one more byte, `a`, the buffer keeps the head `01234`, updates the tail to `6789a`, and reports 1 omitted byte.

**Call relations**: The test runner calls this function to check the normal streaming path, where bytes arrive over time. It creates the buffer with `HeadTailBuffer::new`, pushes several chunks in order, and uses equality assertions after each phase to catch mistakes in how the head and tail are filled.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### `core/src/unified_exec/process_manager_tests.rs`

`test` · `test suite`

The unified execution system is the part of the project that starts shell commands and tracks them while they run. These tests act like a checklist for the promises that system must keep. They verify that commands get a controlled environment, for example by disabling color and pagers so output is easier for machines to read. They also check how environment changes are sent to an external exec server: only the values that changed at runtime should be sent, not the whole client environment.

The file also tests small but important edge cases. It confirms process IDs are represented the same way across the local manager and exec server. It checks how long the system initially waits before yielding output back, including a Windows-specific minimum wait. It verifies that network denial messages clearly name the sandbox network proxy, which is the component blocking network access.

A larger async test simulates a command that fails before it has been fully stored as a running process. In that case, the system still needs to emit a proper “command ended” event with useful fallback output, rather than leaving the caller waiting. Finally, the pruning tests check which old process record should be removed when the manager has too many: it prefers exited processes that are not among the most recently used, and otherwise falls back to the oldest record.

#### Function details

##### `unified_exec_env_injects_defaults`  (lines 8–24)

```
fn unified_exec_env_injects_defaults()
```

**Purpose**: This test confirms that an empty environment is filled with the standard variables the execution system wants every command to have. These defaults make command output plain, predictable, and suitable for automated reading.

**Data flow**: It starts with an empty map of environment variables. It passes that map through the environment-defaulting logic, then compares the result with the exact expected set, such as disabling color, using a simple terminal type, setting UTF-8 locale values, and forcing pagers to behave like plain output.

**Call relations**: The test runner calls this test during the normal test suite. The test exercises the environment-building helper and uses equality checking to make sure the helper’s contract has not drifted.

*Call graph*: 4 external calls (from, new, new, assert_eq!).


##### `unified_exec_env_overrides_existing_values`  (lines 27–36)

```
fn unified_exec_env_overrides_existing_values()
```

**Purpose**: This test checks that the unified execution defaults are strong enough to replace conflicting values, while leaving unrelated values alone. For example, it must force color off without destroying a useful PATH.

**Data flow**: It begins with a small environment containing an existing NO_COLOR value and a PATH. After applying the unified execution environment rules, it checks that NO_COLOR was changed to the required value and PATH stayed the same.

**Call relations**: The test runner invokes it as part of the suite. It backs up the same environment helper tested by the default-injection case, but focuses on what happens when caller-provided values already exist.

*Call graph*: 2 external calls (new, assert_eq!).


##### `env_overlay_for_exec_server_keeps_runtime_changes_only`  (lines 39–67)

```
fn env_overlay_for_exec_server_keeps_runtime_changes_only()
```

**Purpose**: This test verifies that the environment overlay sent to the exec server contains only runtime differences. That matters because the server already knows the policy-based environment, so sending unchanged values would be noisy and could hide real changes.

**Data flow**: It creates one environment representing the local policy baseline and another representing the actual request. The request changes PATH and adds runtime-only values like a thread ID and a network-disabled flag. The test expects the overlay to contain only those changed or newly added values.

**Call relations**: The test runner calls this test to protect the contract between the client-side process manager and the exec server. It exercises the overlay helper that is also indirectly important when exec-server parameters are built.

*Call graph*: 2 external calls (from, assert_eq!).


##### `exec_server_params_use_path_uri_and_env_policy_overlay_contract`  (lines 70–128)

```
fn exec_server_params_use_path_uri_and_env_policy_overlay_contract()
```

**Purpose**: This test checks that a local execution request is translated into exec-server parameters in the agreed format. It specifically protects the process ID, working-directory path format, environment policy, and reduced environment overlay.

**Data flow**: It builds a realistic execution request with a command, current working directory, sandbox and permission settings, an environment, and exec-server environment policy information. It then converts that request into exec-server parameters and checks that the process ID becomes a string, the working directory becomes a path URI, the environment policy is present, and the environment contains only the overlay values the server needs.

**Call relations**: The test runner invokes this test to guard the handoff from the local unified execution manager to the external exec server. It uses current directory information, sandbox policy construction, and request-to-parameter conversion, then checks the important parts of the resulting server request.

*Call graph*: calls 1 internal fn (unrestricted); 7 external calls (from, new, new, assert!, assert_eq!, current_dir, vec!).


##### `exec_server_process_id_matches_unified_exec_process_id`  (lines 131–133)

```
fn exec_server_process_id_matches_unified_exec_process_id()
```

**Purpose**: This test confirms that the process ID used by the exec server is the same plain string form as the unified execution process ID. Consistent IDs make it possible to connect events, logs, and follow-up requests to the same running command.

**Data flow**: It provides a numeric process ID and asks the conversion helper for the exec-server form. The expected result is the same number rendered as text.

**Call relations**: The test runner calls this small contract test. It supports the larger exec-server parameter tests by checking the ID conversion rule on its own.

*Call graph*: 1 external calls (assert_eq!).


##### `initial_exec_yield_time_uses_windows_floor`  (lines 137–149)

```
fn initial_exec_yield_time_uses_windows_floor()
```

**Purpose**: This Windows-only test checks that the initial output wait time is not allowed to be too short on Windows. The floor gives commands enough time to start producing useful output before the system yields back.

**Data flow**: It feeds several requested yield times into the clamping helper. Very small values are raised to the Windows-specific minimum, normal values are left alone, and values above the maximum are lowered to the maximum.

**Call relations**: On Windows, the test runner includes this test. It protects platform-specific timing behavior used when unified execution decides how long to wait before returning initial command output.

*Call graph*: 1 external calls (assert_eq!).


##### `initial_exec_yield_time_has_no_platform_floor`  (lines 153–159)

```
fn initial_exec_yield_time_has_no_platform_floor()
```

**Purpose**: This non-Windows test checks that other platforms do not use the Windows-specific initial wait floor. They still obey the general minimum, but do not get raised to the larger Windows value.

**Data flow**: It sends ordinary and very small requested yield times through the clamping helper. The ordinary value stays unchanged, while an extremely small value is raised only to the general minimum.

**Call relations**: On non-Windows systems, the test runner includes this test instead of the Windows-specific one. Together, the two tests make the platform split explicit and prevent accidental timing changes.

*Call graph*: 1 external calls (assert_eq!).


##### `network_denial_fallback_message_names_sandbox_network_proxy`  (lines 162–169)

```
async fn network_denial_fallback_message_names_sandbox_network_proxy()
```

**Purpose**: This async test verifies the fallback message shown when network access is denied and no more specific session information is available. The message should clearly say that the Codex sandbox network proxy blocked the access.

**Data flow**: It calls the network-denial message builder without a session or deferred detail source. The result should be a clear, fixed sentence naming the sandbox network proxy.

**Call relations**: The async test runner calls this test. It protects the user-facing error text used by the unified execution flow when a command tries to reach the network but sandbox policy blocks it.

*Call graph*: 1 external calls (assert_eq!).


##### `late_network_denial_grace_observes_cancellation_after_exit`  (lines 172–181)

```
async fn late_network_denial_grace_observes_cancellation_after_exit()
```

**Purpose**: This async test checks a race-like situation: a command has exited, but a late network-denial signal may still arrive briefly afterward. The system should notice cancellation during that short grace period.

**Data flow**: It creates a cancellation token, starts a background task that waits briefly and then cancels it, and then waits for the late-network-denial grace logic. The expected result is true, meaning the cancellation was observed.

**Call relations**: The async test runner invokes this test. It exercises the grace-wait helper and uses a spawned task plus a short sleep to mimic a network denial arriving just after process exit.

*Call graph*: 5 external calls (new, from_millis, assert!, spawn, sleep).


##### `failed_initial_end_for_unstored_process_uses_fallback_output`  (lines 184–258)

```
async fn failed_initial_end_for_unstored_process_uses_fallback_output()
```

**Purpose**: This async test makes sure callers still receive a proper command-ended event if an execution fails before the process was fully recorded. Without this, the user interface or caller could wait forever or show missing output.

**Data flow**: It creates a test session and execution context, builds a command request, and places partial transcript text into a shared buffer. It then asks the failure-emission helper to report a failed initial execution using a pre-denial marker and denial message. The test reads the next event from the session channel and checks that it is a failed command-end event with the expected call ID, exit code, process ID, and fallback combined output.

**Call relations**: The async test runner calls this scenario test. It relies on the session test helper to create a realistic event channel, then exercises the failure-reporting path that runs when a process dies before the process manager has stored it.

*Call graph*: calls 3 internal fn (make_session_and_context_with_rx, new, default); 9 external calls (clone, new, from_millis, from_secs, assert_eq!, panic!, new, timeout, vec!).


##### `pruning_prefers_exited_processes_outside_recently_used`  (lines 261–279)

```
fn pruning_prefers_exited_processes_outside_recently_used()
```

**Purpose**: This test checks the cleanup rule for too many tracked processes: if there is an exited process outside the protected recent set, remove that one first. This keeps active or recently touched processes safer.

**Data flow**: It builds sample process metadata with timestamps and one exited process that is not among the most recent entries. It asks the pruning selector which process ID should be removed and expects the exited older candidate.

**Call relations**: The test runner calls this test to protect the process manager’s pruning policy. It directly exercises the metadata-based selection helper used when the manager needs to free space.

*Call graph*: 4 external calls (now, assert_eq!, process_id_to_prune_from_meta, vec!).


##### `pruning_falls_back_to_lru_when_no_exited`  (lines 282–300)

```
fn pruning_falls_back_to_lru_when_no_exited()
```

**Purpose**: This test confirms the fallback cleanup rule: if no suitable exited process exists, remove the least recently used process. “Least recently used” means the one that has gone the longest without being touched.

**Data flow**: It creates process metadata where every process is still considered not exited. The pruning selector is asked for a candidate, and the expected answer is the oldest timestamped process.

**Call relations**: The test runner invokes this as another direct check of the pruning selector. It covers the path used when there is no obviously safe exited process to discard.

*Call graph*: 4 external calls (now, assert_eq!, process_id_to_prune_from_meta, vec!).


##### `pruning_protects_recent_processes_even_if_exited`  (lines 303–322)

```
fn pruning_protects_recent_processes_even_if_exited()
```

**Purpose**: This test ensures that recently used processes are protected even if they have exited. The idea is that recent records may still be useful for follow-up reads, status checks, or user-visible history.

**Data flow**: It builds metadata where some exited processes are among the most recent entries. The selector should not choose those protected recent exited processes; instead, it chooses the oldest process outside that recent set.

**Call relations**: The test runner calls this test to lock down a subtle part of the pruning policy. It complements the other pruning tests by showing that “exited” alone is not enough reason to remove a process if it is still recent.

*Call graph*: 4 external calls (now, assert_eq!, process_id_to_prune_from_meta, vec!).


### `core/src/unified_exec/process_tests.rs`

`test` · `test run`

This file is a safety net for code that talks to a remote process. In the real system, `UnifiedExecProcess` can represent a command running somewhere else, through an execution server. That kind of setup can fail in awkward ways: the process may disappear, standard input may close, termination may fail, or the process may exit before the caller has fully settled in. These tests make sure those cases leave `UnifiedExecProcess` in a clear and honest state.

The file builds a `MockExecProcess`, which is a fake version of the remote process interface. Think of it like a practice actor in a fire drill: it can pretend that writes succeed or fail, that reads report an exit, or that termination returns an error. The helper `remote_process` wraps this fake process in the real `UnifiedExecProcess` constructor, so the tests exercise the same path production code uses.

The important behavior being checked is state consistency. If writing fails because the remote process is unknown or its input is closed, the unified process should be marked as exited. If termination fails, it should not pretend the process exited. If a failure is recorded twice, the first message should be preserved. And if the remote process reports that it already exited, startup should notice that.

#### Function details

##### `MockExecProcess::process_id`  (lines 55–57)

```
fn process_id(&self) -> &ProcessId
```

**Purpose**: This returns the fake process identifier used by the mock remote process. It lets the real `UnifiedExecProcess` code treat the mock like a normal server-backed process.

**Data flow**: It reads the stored `process_id` field from the mock and gives back a reference to it. Nothing is changed.

**Call relations**: When `UnifiedExecProcess` talks to the mock through the `ExecProcess` interface, this method supplies the identity that a real execution server process would normally provide.


##### `MockExecProcess::subscribe_wake`  (lines 59–61)

```
fn subscribe_wake(&self) -> watch::Receiver<u64>
```

**Purpose**: This gives callers a way to be notified when the fake process has new information to read. The notification uses a watch channel, which is like a small shared notice board that subscribers can watch for updates.

**Data flow**: It reads the mock's stored wake sender and creates a new receiver subscribed to that sender. The caller gets the receiver; the mock keeps the sender.

**Call relations**: The startup path for `UnifiedExecProcess` can subscribe to wake notices so it knows when to read from the remote process. In the early-exit test, the test sends a wake signal so the process wrapper notices the queued exit response.

*Call graph*: 1 external calls (subscribe).


##### `MockExecProcess::subscribe_events`  (lines 63–65)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: This returns an empty event stream for the fake process. The tests in this file do not need separate process events, so the mock deliberately says there are none.

**Data flow**: It takes no useful input and returns an empty `ExecProcessEventReceiver`. No stored state changes.

**Call relations**: When the real wrapper asks the mock for process events, this method keeps that part quiet so each test can focus on reads, writes, and termination.

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

**Purpose**: This supplies the next fake read result to code that is polling the remote process. It is how tests make the remote process appear to have output, to have exited, or to have nothing new.

**Data flow**: The caller may provide read-position and size hints, but this mock ignores them. It calls the mock's asynchronous read routine, which removes the next queued `ReadResponse`; if none is queued, it returns a default response saying there is no output and the process has not exited.

**Call relations**: The `UnifiedExecProcess` startup and polling logic call this through the `ExecProcess` interface. In the early-exit test, this is the path that delivers the preloaded response with exit code `17`.

*Call graph*: 2 external calls (pin, new).


##### `MockExecProcess::write`  (lines 76–78)

```
fn write(&self, _chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse>
```

**Purpose**: This pretends to write bytes to the fake process's standard input. Instead of really sending data anywhere, it returns the preconfigured write result chosen by the test.

**Data flow**: It receives a byte chunk but ignores its contents. It clones the stored `WriteResponse` and returns it asynchronously, leaving the mock unchanged.

**Call relations**: The write-failure tests call `UnifiedExecProcess.write`, which reaches this mock method underneath. By returning `UnknownProcess` or `StdinClosed`, the mock lets those tests check that the wrapper marks the process as exited.

*Call graph*: 2 external calls (pin, clone).


##### `MockExecProcess::signal`  (lines 80–82)

```
fn signal(&self, _signal: ProcessSignal) -> ExecProcessFuture<'_, ()>
```

**Purpose**: This accepts a pretend signal, such as a request to interrupt a process, and always reports success. The tests here do not focus on signal behavior.

**Data flow**: It receives a `ProcessSignal`, ignores it, and returns a successful asynchronous result. No state changes.

**Call relations**: This fills out the `ExecProcess` interface so the mock can stand in for a real remote process. It is available if the wrapper sends a signal, but these tests do not rely on signal effects.

*Call graph*: 1 external calls (pin).


##### `MockExecProcess::terminate`  (lines 84–86)

```
fn terminate(&self) -> ExecProcessFuture<'_, ()>
```

**Purpose**: This pretends to terminate the fake remote process. It can either succeed or return a configured error, depending on what the test wants to prove.

**Data flow**: It reads the mock's `terminate_error` field. If there is an error message, it returns a protocol error containing that message; otherwise it returns success. The method itself does not change the mock.

**Call relations**: The termination test calls `UnifiedExecProcess.terminate_confirmed`, which delegates to this mock method. The test uses both outcomes to confirm that the wrapper only marks the process exited after termination really succeeds.

*Call graph*: 2 external calls (pin, Protocol).


##### `remote_process`  (lines 89–109)

```
async fn remote_process(
    write_status: WriteStatus,
    terminate_error: Option<String>,
) -> UnifiedExecProcess
```

**Purpose**: This helper builds a `UnifiedExecProcess` around a fake remote process. Tests use it to quickly create a process with a chosen write result and optional termination error.

**Data flow**: It receives the write status the mock should return and an optional termination error message. It creates a wake channel, builds a `MockExecProcess`, wraps it in `StartedExecProcess`, and passes that into `UnifiedExecProcess::from_exec_server_started`. The result is a ready-to-test unified process.

**Call relations**: Several tests call this helper before exercising one behavior. It keeps each test short while still going through the real remote-process construction path.

*Call graph*: calls 1 internal fn (from_exec_server_started); called by 4 (fail_and_terminate_preserves_failure_message, remote_terminate_confirmed_updates_state_on_success_only, remote_write_closed_stdin_marks_process_exited, remote_write_unknown_process_marks_process_exited); 4 external calls (new, new, new, channel).


##### `remote_write_unknown_process_marks_process_exited`  (lines 112–122)

```
async fn remote_write_unknown_process_marks_process_exited()
```

**Purpose**: This test proves that if the server says the process is unknown during a write, the unified process treats it as gone. That prevents later code from believing it can still talk to a missing process.

**Data flow**: It creates a remote process whose writes return `UnknownProcess`, then tries to write `hello`. The write returns a `WriteToStdin` error, and the process state changes to exited.

**Call relations**: The test uses `remote_process` to set up the fake server response, then calls the real `write` path on `UnifiedExecProcess`. The mock's write result drives the wrapper into the failure state being checked.

*Call graph*: calls 1 internal fn (remote_process); 1 external calls (assert!).


##### `remote_write_closed_stdin_marks_process_exited`  (lines 125–135)

```
async fn remote_write_closed_stdin_marks_process_exited()
```

**Purpose**: This test proves that if the remote process says standard input is already closed, the unified process is marked as exited. In plain terms, if you can no longer feed the command input, this wrapper treats that as a finished or unusable process.

**Data flow**: It creates a remote process whose writes return `StdinClosed`, then attempts to write `hello`. The write fails with `WriteToStdin`, and the process records that it has exited.

**Call relations**: The test uses `remote_process` for setup and then exercises `UnifiedExecProcess.write`. The fake write response lets the test confirm the wrapper's state update after this specific remote-server answer.

*Call graph*: calls 1 internal fn (remote_process); 1 external calls (assert!).


##### `fail_and_terminate_preserves_failure_message`  (lines 138–149)

```
async fn fail_and_terminate_preserves_failure_message()
```

**Purpose**: This test checks that the first failure reason is kept even if another failure is reported later. That matters because the first error is usually the clearest explanation of what really went wrong.

**Data flow**: It creates a normally writable remote process, calls `fail_and_terminate` with `network denied`, then calls it again with `second failure`. The process ends up marked exited, and its stored failure message remains `network denied`.

**Call relations**: The test uses `remote_process` to get a real `UnifiedExecProcess` backed by the mock. It then calls the wrapper's failure path directly and checks that repeated failure handling does not overwrite the original message.

*Call graph*: calls 1 internal fn (remote_process); 2 external calls (assert!, assert_eq!).


##### `remote_terminate_confirmed_updates_state_on_success_only`  (lines 152–175)

```
async fn remote_terminate_confirmed_updates_state_on_success_only()
```

**Purpose**: This test makes sure confirmed termination changes the process state only when the remote termination actually succeeds. It guards against falsely reporting that a process is dead when the server failed to terminate it.

**Data flow**: First it creates a process whose terminate call returns an error, calls `terminate_confirmed`, and checks that an error comes back and the process is not marked exited. Then it creates a process whose terminate call succeeds, calls the same method, and checks that the process is marked exited.

**Call relations**: Both halves use `remote_process` to build the wrapper with different mock termination behavior. The real `terminate_confirmed` method delegates to the mock's terminate path, and the test checks how the wrapper updates its own state afterward.

*Call graph*: calls 1 internal fn (remote_process); 1 external calls (assert!).


##### `remote_process_waits_for_early_exit_event`  (lines 178–210)

```
async fn remote_process_waits_for_early_exit_event()
```

**Purpose**: This test checks that startup notices a remote process that exits very early. Without this, the wrapper might start in a stale state and miss the fact that the command has already finished.

**Data flow**: It builds a mock process with one queued read response saying the process exited with code `17`. A background task waits briefly and sends a wake notification. The unified process constructor receives that wake, reads the queued exit response, and returns a process already marked exited with exit code `17`.

**Call relations**: Unlike the simpler tests, this one builds the mock inline so it can preload a specific read response and control the wake channel. It then calls `UnifiedExecProcess::from_exec_server_started`, which subscribes to wake notifications and reads from the mock before the assertions run.

*Call graph*: calls 1 internal fn (from_exec_server_started); 10 external calls (new, from_millis, new, new, from, assert!, assert_eq!, spawn, sleep, channel).


### `core/src/unified_exec/mod_tests.rs`

`test` · `test run`

The unified exec system is like a terminal clerk: it starts a command, watches its output for a while, decides whether the command is finished or should remain as a background terminal, and later lets the user type more into that same process. This test file checks that the clerk behaves correctly in normal and awkward situations.

The tests create lightweight sessions and run bash commands through the same manager used by the real application. They verify that an interactive shell keeps its state across later writes, while a short one-shot command does not accidentally share that state. They also check timeout behavior: if output is not ready before the requested wait time, the process can keep running and later output can still be collected.

Several tests focus on cleanup and race conditions, which are bugs that happen when two async tasks act at nearly the same time. A fake process called BlockingTerminateExecProcess lets a test pause termination halfway through, like holding a door open, so the code can prove it removes processes only when it is safe. The file also tests output buffering, exit-code preservation, remote execution support, and the rule that remote exec servers cannot launch processes with inherited file descriptors.

#### Function details

##### `test_session_and_turn`  (lines 37–40)

```
async fn test_session_and_turn() -> (Arc<Session>, Arc<TurnContext>)
```

**Purpose**: Creates a fresh test session and turn context, then wraps both in shared pointers so async test code can pass them around safely. A session represents the larger conversation state, while a turn context represents one user request within it.

**Data flow**: It starts with no inputs. It asks the shared test helper to build a session and turn, then wraps each value in an Arc, which is a thread-safe shared reference. It returns both wrapped objects for tests that need to run commands through the real unified exec manager.

**Call relations**: Many integration-style tests call this first, including the persistence, timeout, pause, termination, and reuse tests. It delegates the actual setup to make_session_and_context, keeping each test focused on behavior instead of boilerplate setup.

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

**Purpose**: Runs a shell command in the test environment using the default terminal-like mode. Tests use it when they want the same behavior as an interactive command invocation.

**Data flow**: It receives a session, turn context, command text, wait time, and optional working directory. It forwards all of that to exec_command_with_tty and forces the tty flag to true. The result is an ExecCommandToolOutput containing collected output, timing, exit information, and possibly a background process id.

**Call relations**: This is the convenient wrapper used by most tests. It hands the real work to exec_command_with_tty so tests do not need to repeat the terminal-mode argument.

*Call graph*: calls 1 internal fn (exec_command_with_tty); called by 7 (completed_commands_do_not_persist_sessions, multi_unified_exec_sessions, requests_with_large_timeout_are_capped, reusing_completed_process_returns_unknown_process, unified_exec_pause_blocks_yield_timeout, unified_exec_persists_across_requests, unified_exec_timeouts).


##### `shell_env`  (lines 60–62)

```
fn shell_env() -> HashMap<String, String>
```

**Purpose**: Captures the current process environment variables for use when launching test commands. This makes test shells inherit the same basic environment as the test runner.

**Data flow**: It reads all environment variables from the operating system and collects them into a map from variable name to value. It returns that map to be placed into an ExecRequest.

**Call relations**: Command-building helpers and remote-exec tests call this before constructing an execution request. It is a small bridge between the host test process and the shell process being launched.

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

**Purpose**: Builds an ExecRequest, which is the package of instructions needed to start a command. It chooses test-friendly defaults such as no sandbox and the standard shell capture policy.

**Data flow**: It receives the turn context, command arguments, working directory, and environment map. It reads permission and workspace settings from the turn, combines them with timeout, capture, sandbox, and network defaults, and returns a complete request object ready for the exec manager.

**Call relations**: exec_command_with_tty and several lower-level tests call this before opening a process. It centralizes request setup so all tests exercise the same launch configuration unless a test deliberately changes something else.

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

**Purpose**: Starts a command through the unified exec manager, waits for output until a deadline, and returns the same kind of result the real command tool would return. It can launch either with or without terminal behavior depending on the tty flag.

**Data flow**: It receives the session, turn, command text, yield wait time, optional working directory, and terminal flag. It allocates a process id, builds a bash command and ExecRequest, opens the process, stores it if it is still alive, then collects output until the deadline or process completion. It returns an ExecCommandToolOutput with raw output, token count estimate, elapsed time, exit code, and a process id only if the command is still running in the background.

**Call relations**: exec_command calls this as the main command runner for tests. Inside, it uses shell_env and test_exec_request for launch setup, then relies on UnifiedExecProcessManager output collection so the tests exercise the production path.

*Call graph*: calls 3 internal fn (new, shell_env, test_exec_request); called by 1 (exec_command); 11 external calls (clone, downgrade, new, new, from_millis, now, from_utf8_lossy, approx_token_count, collect_output_until_deadline, new (+1 more)).


##### `TestSpawnLifecycle::inherited_fds`  (lines 208–210)

```
fn inherited_fds(&self) -> Vec<i32>
```

**Purpose**: Reports a test-controlled list of inherited file descriptors. A file descriptor is a small operating-system number that points to an open file, pipe, or socket.

**Data flow**: It reads the inherited_fds field from the test struct, clones the list, and returns it. It does not change any state.

**Call relations**: The remote inherited-file-descriptor rejection test passes this lifecycle object into process launch. The exec manager asks this method what descriptors should be inherited, which lets the test prove remote launching rejects that unsupported feature.


##### `BlockingTerminateExecProcess::process_id`  (lines 246–248)

```
fn process_id(&self) -> &ProcessId
```

**Purpose**: Returns the fake process's id. This lets the fake object satisfy the same interface as a real exec-server process.

**Data flow**: It reads the process_id stored in the fake process and returns a reference to it. Nothing is created or changed.

**Call relations**: The unified process wrapper calls this through the ExecProcess interface whenever it needs to identify the fake process. It is part of making the blocking fake look like a real process to the code under test.


##### `BlockingTerminateExecProcess::subscribe_wake`  (lines 250–252)

```
fn subscribe_wake(&self) -> watch::Receiver<u64>
```

**Purpose**: Lets callers subscribe to wake-up notifications from the fake process. Wake notifications are used to tell the output collector that there may be new data to read.

**Data flow**: It takes the fake process's watch channel sender and creates a new receiver subscribed to it. The returned receiver can observe future wake values.

**Call relations**: The unified exec wrapper uses this method through the ExecProcess interface. In these tests the fake process does not produce real output, but the subscription is still needed to satisfy the normal process contract.

*Call graph*: 1 external calls (subscribe).


##### `BlockingTerminateExecProcess::subscribe_events`  (lines 254–256)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Returns an empty stream of process events for the fake process. This says, in effect, that the fake process has no extra lifecycle messages to report.

**Data flow**: It does not read meaningful input state. It creates and returns an empty event receiver.

**Call relations**: The unified process wrapper calls this while adapting the fake exec-server process. Returning an empty receiver keeps the test focused on termination timing rather than event delivery.

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

**Purpose**: Pretends to read from the fake process and always reports no output and no exit. This keeps the fake process alive from the point of view of the output collector.

**Data flow**: It ignores read parameters, builds a ReadResponse with no chunks, no exit code, and closed set to false, then returns it successfully.

**Call relations**: The ExecProcess trait method boxes this async helper so the production wrapper can call it like any real process read. The termination race tests depend on this predictable never-exited response.

*Call graph*: 2 external calls (pin, new).


##### `BlockingTerminateExecProcess::write`  (lines 267–269)

```
fn write(&self, _chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse>
```

**Purpose**: Pretends to accept input sent to the fake process. It does not store or interpret the input; it only reports success.

**Data flow**: It ignores the written bytes and returns a WriteResponse with status Accepted. No state changes occur.

**Call relations**: The ExecProcess trait method wraps this helper for callers that write to a process. It exists so the fake process can be used wherever a real process is expected.

*Call graph*: 1 external calls (pin).


##### `BlockingTerminateExecProcess::signal`  (lines 271–273)

```
fn signal(&self, _signal: ProcessSignal) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Pretends to send a signal to the fake process and always succeeds. A signal is an operating-system-style instruction such as interrupt or terminate.

**Data flow**: It ignores the requested signal and returns success from a small async block. It changes no state.

**Call relations**: This is part of the ExecProcess interface implementation. The tests in this file focus on terminate, not signal behavior, so this method provides a harmless placeholder.

*Call graph*: 1 external calls (pin).


##### `BlockingTerminateExecProcess::terminate`  (lines 275–277)

```
fn terminate(&self) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Starts fake termination, announces that termination has begun, and then waits until the test explicitly allows it to finish. This gives tests control over a race that would otherwise be hard to reproduce.

**Data flow**: It sends true on a watch channel to notify the test that termination reached the waiting point. Then it waits on a Notify object. Once the test wakes it, it returns success.

**Call relations**: Termination-focused tests use this through the ExecProcess interface. By blocking in the middle, it lets those tests change process-store state before termination completes and verify the manager reacts safely.

*Call graph*: 2 external calls (pin, send).


##### `blocking_terminate_unified_process`  (lines 280–300)

```
async fn blocking_terminate_unified_process(
    process_id: i32,
    terminate_started: watch::Sender<bool>,
    allow_terminate: Arc<Notify>,
) -> anyhow::Result<Arc<UnifiedExecProcess>>
```

**Purpose**: Builds a UnifiedExecProcess around the fake BlockingTerminateExecProcess. This lets tests plug a controlled fake process into the same manager storage used for real processes.

**Data flow**: It receives a numeric process id, a sender used to announce termination start, and a notification used to release termination. It creates a wake channel, constructs the fake exec-server process, wraps it as a started process, converts it into a UnifiedExecProcess, and returns it in a shared Arc.

**Call relations**: The two termination race tests call this when they need a process whose termination can be paused. It hands the fake to UnifiedExecProcess::from_exec_server_started so the rest of the code sees a normal unified process.

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

**Purpose**: Sends input text to an already-running background process and asks the unified exec manager to collect output for a short time afterward.

**Data flow**: It receives a session, process id, input string, and wait time. It builds a WriteStdinRequest with a generous token truncation setting, passes it to the session's unified exec manager, and returns the resulting command-style output or an error.

**Call relations**: Interactive-shell tests call this after exec_command has left a process running. It is the test helper for exercising the production write_stdin path.

*Call graph*: called by 5 (multi_unified_exec_sessions, reusing_completed_process_returns_unknown_process, terminating_during_stdin_poll_returns_exited_response, unified_exec_persists_across_requests, unified_exec_timeouts); 1 external calls (Tokens).


##### `push_chunk_preserves_prefix_and_suffix`  (lines 322–341)

```
fn push_chunk_preserves_prefix_and_suffix()
```

**Purpose**: Checks that the head-tail output buffer keeps both the beginning and the newest end of oversized output. This matters because users need early context and the latest output when output is too large to keep fully.

**Data flow**: It creates a default HeadTailBuffer, pushes a full-sized chunk of 'a' bytes, then pushes small 'b' and 'c' chunks. It snapshots the retained chunks and asserts that the first byte from the prefix, the middle small chunk, and the final suffix chunk are all still represented.

**Call relations**: This standalone unit test directly exercises HeadTailBuffer behavior. It does not go through the exec manager; it verifies the buffer foundation that command output collection relies on.

*Call graph*: calls 1 internal fn (default); 3 external calls (assert!, assert_eq!, vec!).


##### `head_tail_buffer_default_preserves_prefix_and_suffix`  (lines 344–352)

```
fn head_tail_buffer_default_preserves_prefix_and_suffix()
```

**Purpose**: Checks the simpler rendered form of the head-tail buffer: even after more data than the limit arrives, the final byte stream should still begin with the original prefix and end with the latest suffix.

**Data flow**: It creates a buffer, pushes a maximum-sized block of 'a' bytes, then pushes 'bc'. It renders the buffer to bytes and asserts that the first byte is 'a' and the output ends with 'bc'.

**Call relations**: Like the other buffer test, this runs directly against HeadTailBuffer. It protects the behavior used when unified exec turns collected chunks back into output text.

*Call graph*: calls 1 internal fn (default); 3 external calls (assert!, assert_eq!, vec!).


##### `unified_exec_persists_across_requests`  (lines 355–404)

```
async fn unified_exec_persists_across_requests() -> anyhow::Result<()>
```

**Purpose**: Proves that an interactive shell stays alive across separate writes and preserves state, such as exported environment variables. It also checks that background terminals can be listed and terminated.

**Data flow**: It creates a test session, starts bash interactively, gets its process id, and checks that the session reports it as a background terminal. It writes an environment variable into the shell, later echoes it, verifies the value appears, then terminates the terminal and confirms it is gone.

**Call relations**: The test uses test_session_and_turn, exec_command, and write_stdin to drive the production manager. It also calls session-level listing and termination methods to verify the user-visible background terminal flow.

*Call graph*: calls 3 internal fn (exec_command, test_session_and_turn, write_stdin); 3 external calls (assert!, assert_eq!, skip_if_sandbox!).


##### `multi_unified_exec_sessions`  (lines 407–461)

```
async fn multi_unified_exec_sessions() -> anyhow::Result<()>
```

**Purpose**: Checks that a persistent interactive shell does not leak its state into a separate short command. In plain terms, one terminal's private notes should not appear in a fresh terminal.

**Data flow**: It starts an interactive shell, writes an environment variable into it, then runs a separate one-shot echo command. It confirms the short command does not show the variable and does not remain as a background process, then writes back to the original shell and confirms the variable is still there.

**Call relations**: This test uses exec_command for both persistent and one-shot commands, plus write_stdin for the existing shell. It demonstrates the difference between reusing a stored process and launching a fresh command.

*Call graph*: calls 3 internal fn (exec_command, test_session_and_turn, write_stdin); 4 external calls (from_secs, assert!, skip_if_sandbox!, sleep).


##### `unified_exec_timeouts`  (lines 464–511)

```
async fn unified_exec_timeouts() -> anyhow::Result<()>
```

**Purpose**: Verifies that a short wait time does not kill a still-running interactive command. Output that arrives later should be retrievable in a later poll.

**Data flow**: It opens an interactive shell, sets an environment variable, then sends a command that sleeps before echoing the variable while asking for only a tiny wait. It confirms the first response does not include the delayed output, waits long enough for the command to finish, polls again with empty input, and confirms the delayed output appears.

**Call relations**: The test is built from test_session_and_turn, exec_command, and write_stdin. It exercises the output collection deadline without treating deadline expiry as process failure.

*Call graph*: calls 3 internal fn (exec_command, test_session_and_turn, write_stdin); 5 external calls (from_secs, assert!, format!, skip_if_sandbox!, sleep).


##### `unified_exec_pause_blocks_yield_timeout`  (lines 514–552)

```
async fn unified_exec_pause_blocks_yield_timeout() -> anyhow::Result<()>
```

**Purpose**: Checks that an out-of-band pause stops the yield timer from expiring too early. This matters when the system temporarily pauses for another interaction and should not unfairly cut off command output collection.

**Data flow**: It creates a session, marks it paused, and spawns a task that unpauses it after two seconds. It runs a command with a much shorter nominal wait time, then verifies the call lasted at least as long as the pause, collected the command output, and did not leave a background process.

**Call relations**: The test uses test_session_and_turn to set up state and exec_command to run the command. The output collector receives the session's pause state through the normal helper path, so the test checks real production timing behavior.

*Call graph*: calls 2 internal fn (exec_command, test_session_and_turn); 7 external calls (clone, from_secs, assert!, skip_if_sandbox!, spawn, now, sleep).


##### `requests_with_large_timeout_are_capped`  (lines 556–576)

```
async fn requests_with_large_timeout_are_capped() -> anyhow::Result<()>
```

**Purpose**: Documents the expected behavior that very large requested wait times should be capped. The test is currently ignored, meaning it is not run automatically while a better testing approach is planned.

**Data flow**: It creates a session, runs a simple echo command with a very large requested wait time, then checks that output contains the expected text and that a process id is reported according to the behavior being documented.

**Call relations**: It uses the same test_session_and_turn and exec_command helpers as the active command tests. Because it is ignored, it serves more as a pending specification than an active guardrail.

*Call graph*: calls 2 internal fn (exec_command, test_session_and_turn); 1 external calls (assert!).


##### `completed_commands_do_not_persist_sessions`  (lines 580–613)

```
async fn completed_commands_do_not_persist_sessions() -> anyhow::Result<()>
```

**Purpose**: Documents the expectation that completed commands should not remain in the background process store. This test is currently ignored while the project looks for a better way to check it.

**Data flow**: It creates a session, runs a simple echo command, verifies the output, then inspects the manager's process store and expects it to be empty after completion.

**Call relations**: It drives the normal exec_command helper and then looks directly at the unified exec manager's internal store. As an ignored test, it records desired cleanup behavior without running in normal test passes.

*Call graph*: calls 2 internal fn (exec_command, test_session_and_turn); 1 external calls (assert!).


##### `reusing_completed_process_returns_unknown_process`  (lines 616–654)

```
async fn reusing_completed_process_returns_unknown_process() -> anyhow::Result<()>
```

**Purpose**: Verifies that once a background process has exited and been cleaned up, later attempts to write to that old process id fail with a clear unknown-process error.

**Data flow**: It opens an interactive shell, sends exit to it, waits briefly for cleanup, then tries to write again using the same process id. It expects an UnknownProcessId error containing that id and confirms the process store is empty.

**Call relations**: The test starts with exec_command, uses write_stdin to exit and then retry, and checks the specific UnifiedExecError variant. It protects users from silently writing to a dead or reused terminal.

*Call graph*: calls 3 internal fn (exec_command, test_session_and_turn, write_stdin); 6 external calls (from_millis, assert!, assert_eq!, panic!, skip_if_sandbox!, sleep).


##### `terminating_initial_exec_command_rechecks_initial_response_state`  (lines 657–726)

```
async fn terminating_initial_exec_command_rechecks_initial_response_state() -> anyhow::Result<()>
```

**Purpose**: Checks a delicate race during termination of a process whose first command response is still being prepared. The manager must re-check whether that first response is still active before deciding how to remove the process.

**Data flow**: It creates a fake process whose terminate call blocks, inserts it into the process store marked as still in its initial response, and starts termination in another task. After termination has begun, the test flips the initial-response flag to false, releases the fake terminate call, and confirms termination succeeds and removes the process from the store.

**Call relations**: This test uses test_session_and_turn for setup and blocking_terminate_unified_process for the controllable fake. It calls the session's terminate_background_terminal method while manually adjusting stored process state to reproduce the timing window.

*Call graph*: calls 2 internal fn (blocking_terminate_unified_process, test_session_and_turn); 11 external calls (clone, downgrade, new, from_secs, now, new, assert!, new, spawn, timeout (+1 more)).


##### `terminating_during_stdin_poll_returns_exited_response`  (lines 729–796)

```
async fn terminating_during_stdin_poll_returns_exited_response() -> anyhow::Result<()>
```

**Purpose**: Checks that if a process is terminated while a write-stdin poll is waiting for output, the waiting call finishes cleanly instead of hanging. The response should say there is no continuing background process.

**Data flow**: It inserts a fake blocking-terminate process into the store, starts a long write_stdin poll in another task, waits until that poll has begun, then releases the process id and allows termination to complete. It waits for the poll result, checks that no process id is returned, and confirms the store is empty.

**Call relations**: The test combines blocking_terminate_unified_process with the normal write_stdin helper. It intentionally overlaps polling and termination to prove the manager wakes or resolves callers correctly when a process disappears.

*Call graph*: calls 3 internal fn (blocking_terminate_unified_process, test_session_and_turn, write_stdin); 14 external calls (clone, downgrade, new, from_millis, from_secs, now, new, assert!, assert_eq!, new (+4 more)).


##### `completed_pipe_commands_preserve_exit_code`  (lines 799–834)

```
async fn completed_pipe_commands_preserve_exit_code() -> anyhow::Result<()>
```

**Purpose**: Verifies that a non-terminal command that exits quickly still records its real exit code. This is important because command failure or success often depends entirely on that number.

**Data flow**: It creates a request for bash to exit with code 17, opens it without terminal behavior, waits for the process to report exit if needed, then asserts that the process is exited and its exit code is Some(17).

**Call relations**: This test uses make_session_and_context, shell_env, and test_exec_request for setup, then calls UnifiedExecProcessManager::open_session_with_exec_env directly. It bypasses the higher-level exec_command helper to inspect the process object itself.

*Call graph*: calls 5 internal fn (make_session_and_context, default, shell_env, test_exec_request, default_for_tests); 4 external calls (new, assert!, assert_eq!, vec!).


##### `unified_exec_uses_remote_exec_server_when_configured`  (lines 837–886)

```
async fn unified_exec_uses_remote_exec_server_when_configured() -> anyhow::Result<()>
```

**Purpose**: Checks that unified exec can launch and communicate with a remote exec server when a remote test environment is configured. A remote exec server means the shell process runs somewhere other than the local test process.

**Data flow**: It skips when remote testing is unavailable, builds a request for an interactive bash in the remote environment, opens the process through the manager, writes a printf command, waits briefly, collects output from the process handles, and verifies the remote text appears.

**Call relations**: The test uses shell_env and test_exec_request for launch setup and calls the manager directly with the remote environment. It then uses the same collect_output_until_deadline path used by normal unified exec output collection.

*Call graph*: calls 5 internal fn (make_session_and_context, default, shell_env, test_exec_request, test_env); 9 external calls (new, from_millis, now, assert!, collect_output_until_deadline, get_remote_test_env, skip_if_sandbox!, sleep, vec!).


##### `remote_exec_server_rejects_inherited_fd_launches`  (lines 889–932)

```
async fn remote_exec_server_rejects_inherited_fd_launches() -> anyhow::Result<()>
```

**Purpose**: Verifies that remote exec refuses launches that ask to inherit local file descriptors. This prevents pretending a remote machine can use open local files or sockets that only exist in the caller's process.

**Data flow**: It prepares a remote turn environment, builds a command request, and calls the manager with a TestSpawnLifecycle that reports one inherited descriptor. It expects launch to fail and checks the error message says remote exec-server does not support inherited file descriptors.

**Call relations**: This test uses TestSpawnLifecycle::inherited_fds through the spawn lifecycle interface. It calls the same open_session_with_exec_env launch path as real execution, proving the rejection happens at the manager boundary before a remote process is started.

*Call graph*: calls 5 internal fn (make_session_and_context, default, shell_env, test_exec_request, test_env); 6 external calls (new, new, assert_eq!, get_remote_test_env, skip_if_sandbox!, vec!).
