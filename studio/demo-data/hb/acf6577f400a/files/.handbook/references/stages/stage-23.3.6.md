# MCP server executable integration tests  `stage-23.3.6`

This stage tests the MCP server as a real program, not just as separate pieces. It belongs to the “prove the system works end to end” part of the story. The tests start the codex MCP server as a child process, send it JSON-RPC messages, and check the replies. JSON-RPC is a simple request-and-response format written as JSON.

The test entry point, all.rs, gathers the integration tests so Rust can run them together. suite/mod.rs points to the codex_tool tests, like a small table of contents. common/lib.rs provides shared test tools, including a way to turn raw JSON replies into normal Rust values.

mcp_process.rs is the main wiring harness. It starts the server, talks to it, and shuts it down cleanly. mock_model_server.rs plays the role of the remote AI model, returning prepared answers instead of making real network calls. responses.rs builds those prepared streamed answers. Finally, codex_tool.rs uses all of these pieces to check real codex tool behavior, including permission prompts, approved file changes, and instruction forwarding.

## Files in this stage

### Test suite entrypoints
These files assemble the integration-test binary and expose the suite modules that the harness runs.

### `mcp-server/tests/all.rs`

`test` · `test run`

This file is like the front door to the integration tests. It does not contain test cases itself. Instead, it tells Rust’s test system to include the `suite` module, whose files live under `tests/suite/`. Without this file, those grouped integration tests would not be gathered into this one test binary, so the project’s broader server behavior could go untested in that form.

The first line relaxes one lint rule from Clippy, Rust’s optional code checker. It allows test code to use `expect`, which is a common way for tests to stop immediately with a clear message when setup fails. That is usually acceptable in tests because a failed assumption should make the test fail loudly.

In short, this file is a small connector. It gives the test suite a single place to start, while keeping the actual test logic organized elsewhere.


### `mcp-server/tests/suite/mod.rs`

`test` · `test discovery and test compilation`

This is a very small test-suite wiring file. In Rust, a `mod` line brings another source file or folder into the current module tree, which is how the compiler knows that code exists. Here, `mod codex_tool;` means “include the tests or helper code in the `codex_tool` module as part of this suite.” Without this line, the `codex_tool` tests could sit in the repository but not be compiled or run from this test suite. You can think of it like adding a chapter title to a book’s table of contents: the chapter may be written elsewhere, but this entry makes it part of the book.


### Shared integration harness
These common utilities provide typed JSON-RPC decoding, child-process MCP transport, mocked model serving, and canned streamed responses used across the tests.

### `mcp-server/tests/common/lib.rs`

`test` · `test execution`

Tests for the MCP server need to start helper processes, fake model-server replies, create sample streaming responses, and read server answers in a convenient form. This file acts like the test suite’s front desk: it pulls together helpers from nearby modules and re-exports them so each test can import one common module instead of many separate files.

Most of the file is a list of re-exports. These make tools such as `McpProcess`, mock response-server creation, shell formatting helpers, and prepared server-sent-event response builders available to tests. Re-exporting is a way of saying, “these helpers live elsewhere, but test code can find them here.”

The one local function, `to_response`, solves a common test problem. MCP uses JSON-RPC, a simple message format where replies contain a `result` field. Tests often receive that result as generic JSON, but they want a specific Rust type so they can make clear assertions. `to_response` takes the generic JSON-RPC response, extracts its result, and asks `serde` — Rust’s common serialization library — to turn it into the requested type. Without this helper, tests would repeat the same conversion code and would be harder to read.

#### Function details

##### `to_response`  (lines 18–24)

```
fn to_response(
    response: JsonRpcResponse<serde_json::Value>,
) -> anyhow::Result<T>
```

**Purpose**: Converts the `result` part of a JSON-RPC response into the concrete Rust type a test expects. This lets tests work with normal typed data instead of raw JSON blobs.

**Data flow**: It receives a `JsonRpcResponse` whose result is still stored as generic JSON. It first turns that result into a JSON value, then asks `serde_json` to deserialize that value into the caller’s chosen type `T`. If the shape matches, it returns the typed value; if not, it returns an error explaining the conversion failed.

**Call relations**: This helper is meant to be used by tests after they receive a JSON-RPC response from the MCP server. It delegates the actual JSON conversion work to `serde_json::to_value` and `serde_json::from_value`, so the test code only has to call one clear helper instead of repeating those steps.

*Call graph*: 2 external calls (from_value, to_value).


### `mcp-server/tests/common/mcp_process.rs`

`test` · `integration test setup, test interaction, and teardown`

Tests for the MCP server need more than isolated functions: they need to launch the actual server program and check how it behaves over its normal input and output streams. This file provides that harness. Think of it like a remote control for a server running in a separate terminal window: it starts the server, writes requests to its standard input, reads responses from its standard output, and forwards the server's error output so failures are visible.

The communication format is JSON-RPC, a simple convention where each message is JSON and can be a request, response, notification, or error. The helper assigns increasing numeric request IDs so a test can match a response to the request that caused it. It also performs the MCP initialization handshake, including the client capabilities that these tests need, and verifies that the server reports the expected capabilities and identity.

Several reader methods wait through the stream until a specific kind of message appears, such as a server request, a response for a known ID, or a legacy task-complete notification. Unexpected message types cause the test to fail early, which makes problems easier to diagnose. Finally, when the helper is dropped, it tries to kill and reap the child process within a short timeout so tests do not leave stray server processes behind.

#### Function details

##### `McpProcess::new`  (lines 47–49)

```
async fn new(codex_home: &Path) -> anyhow::Result<Self>
```

**Purpose**: Starts a new MCP server process for a test using the normal environment. It is the simple constructor tests use when they do not need to change environment variables.

**Data flow**: It receives a path to the test's Codex home directory. It passes that path along with an empty list of environment overrides to `McpProcess::new_with_env`. The result is either a ready-to-use `McpProcess` connected to the child server, or an error explaining why startup failed.

**Call relations**: This is the convenience entry point used by tests such as `codex_tool_passes_base_instructions` and by helper setup such as `create_mcp_process`. It immediately hands the real setup work to `McpProcess::new_with_env`, which knows how to spawn and wire up the child process.

*Call graph*: called by 2 (codex_tool_passes_base_instructions, create_mcp_process); 1 external calls (new_with_env).


##### `McpProcess::new_with_env`  (lines 56–111)

```
async fn new_with_env(
        codex_home: &Path,
        env_overrides: &[(&str, Option<&str>)],
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts the `codex-mcp-server` binary as a child process and connects the test to its input and output. It also lets a test set, replace, or remove environment variables for that child only.

**Data flow**: It takes a Codex home directory and a list of environment changes. It finds the server binary, builds a command with piped stdin, stdout, and stderr, sets `CODEX_HOME` and logging, applies the requested environment changes, and spawns the process. It then keeps the child's stdin for sending messages, wraps stdout in a line reader for receiving messages, and starts a background task that prints the child's stderr. It returns a fully connected `McpProcess` with request IDs starting at zero.

**Call relations**: `McpProcess::new` calls this when no environment changes are needed, while tests can call it directly when they need a special child environment. The object it returns is used by later helpers such as `initialize`, `send_codex_tool_call`, and the stream-reading methods.

*Call graph*: 7 external calls (new, new, piped, new, cargo_bin, eprintln!, spawn).


##### `McpProcess::initialize`  (lines 114–185)

```
async fn initialize(&mut self) -> anyhow::Result<()>
```

**Purpose**: Performs the standard MCP startup handshake with the server and checks that the server responds with the expected protocol version, capabilities, and identity. Without this, later tool calls would be talking to a server that has not agreed on how the conversation should work.

**Data flow**: It creates a new request ID, builds an `initialize` JSON-RPC request describing the test client's capabilities, and writes it to the server. It reads one message back, verifies that it is the matching initialization response, and compares the response body with the expected server information, including the generated user-agent string. After that succeeds, it sends the `notifications/initialized` notification to acknowledge that initialization is complete. The output is success or a test failure/error if anything is wrong.

**Call relations**: Tests call this soon after creating `McpProcess`. Inside, it uses `send_jsonrpc_message` to write the initialize request and final notification, and `read_jsonrpc_message` to receive the server's response. It is the bridge between raw process startup and meaningful MCP test actions.

*Call graph*: calls 3 internal fn (originator, read_jsonrpc_message, send_jsonrpc_message); 15 external calls (fetch_add, default, new, new, new, new, Notification, Request, bail!, Number (+5 more)).


##### `McpProcess::send_codex_tool_call`  (lines 189–204)

```
async fn send_codex_tool_call(
        &mut self,
        params: CodexToolCallParam,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends a request asking the MCP server to run the `codex` tool with the supplied parameters. It returns the request ID so the test can later wait for the matching response or related notifications.

**Data flow**: It receives a `CodexToolCallParam`, converts it into JSON object fields, wraps those fields in a `tools/call` request for the tool named `codex`, and sends that request. The result is the numeric ID assigned to this request.

**Call relations**: Tests use this after initialization when they want the server to perform a Codex tool call. It delegates the common request-building and ID assignment to `McpProcess::send_request`, which then writes the JSON-RPC message through `send_jsonrpc_message`.

*Call graph*: calls 1 internal fn (send_request); 3 external calls (new, to_value, unreachable!).


##### `McpProcess::send_request`  (lines 206–220)

```
async fn send_request(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> anyhow::Result<i64>
```

**Purpose**: Builds and sends a generic JSON-RPC request with a fresh ID. It is the shared helper behind more specific request methods.

**Data flow**: It receives a method name and optional JSON parameters. It takes the next numeric request ID, creates a JSON-RPC request message with that method and parameters, writes it to the child process, and returns the ID it used.

**Call relations**: `McpProcess::send_codex_tool_call` uses this so it does not have to repeat the request-ID and message-wrapping logic. This function then hands the actual writing to `McpProcess::send_jsonrpc_message`.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); called by 1 (send_codex_tool_call); 4 external calls (fetch_add, new, Request, Number).


##### `McpProcess::send_response`  (lines 222–233)

```
async fn send_response(
        &mut self,
        id: RequestId,
        result: serde_json::Value,
    ) -> anyhow::Result<()>
```

**Purpose**: Sends a JSON-RPC response back to the server. Tests use this when the server asks the client a question and the test needs to answer it.

**Data flow**: It receives the ID of the server's request and a JSON result value. It wraps them in a JSON-RPC response message and writes that message to the server's stdin. It returns success once the message has been sent and flushed, or an error if writing fails.

**Call relations**: This complements the reader methods that can return server requests, especially `read_stream_until_request_message`. Once a test has read a request from the server and decided on an answer, it calls `send_response`, which sends the message through `send_jsonrpc_message`.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); 1 external calls (Response).


##### `McpProcess::send_jsonrpc_message`  (lines 235–245)

```
async fn send_jsonrpc_message(
        &mut self,
        message: JsonRpcMessage<CustomRequest, serde_json::Value, CustomNotification>,
    ) -> anyhow::Result<()>
```

**Purpose**: Writes one JSON-RPC message to the server process. It is the low-level output path used by all higher-level send methods.

**Data flow**: It receives a structured JSON-RPC message. It logs the message for debugging, turns it into a JSON string, writes that string to the child's stdin, adds a newline so the server can read the message as one line, and flushes the stream so the data is not stuck in a buffer.

**Call relations**: `initialize`, `send_request`, and `send_response` all call this instead of writing to stdin themselves. It is the single doorway for outbound test-to-server messages, which keeps the wire format consistent.

*Call graph*: called by 3 (initialize, send_request, send_response); 4 external calls (flush, write_all, eprintln!, to_string).


##### `McpProcess::read_jsonrpc_message`  (lines 247–257)

```
async fn read_jsonrpc_message(
        &mut self,
    ) -> anyhow::Result<JsonRpcMessage<CustomRequest, serde_json::Value, CustomNotification>>
```

**Purpose**: Reads one JSON-RPC message from the server process. It is the low-level input path used by all higher-level waiting methods.

**Data flow**: It waits for one line from the child's stdout, parses that line as a JSON-RPC message, logs it for debugging, and returns the parsed message. If the line cannot be read or parsed, it returns an error.

**Call relations**: `initialize` uses this to read the initialization response. The stream-waiting helpers use it repeatedly while looking for a particular kind of message. Together with `send_jsonrpc_message`, it forms the basic read/write channel to the child server.

*Call graph*: called by 4 (initialize, read_stream_until_legacy_task_complete_notification, read_stream_until_request_message, read_stream_until_response_message); 3 external calls (read_line, new, eprintln!).


##### `McpProcess::read_stream_until_request_message`  (lines 259–282)

```
async fn read_stream_until_request_message(
        &mut self,
    ) -> anyhow::Result<JsonRpcRequest<CustomRequest>>
```

**Purpose**: Keeps reading server output until the server sends a JSON-RPC request to the client. Notifications are ignored, but responses and errors are treated as unexpected and fail the test.

**Data flow**: It repeatedly reads one message at a time from stdout. If the message is a notification, it logs and skips it. If it is a request, it returns that request to the caller. If it is an error or response, it stops with a failure because this helper was specifically waiting for a request.

**Call relations**: Tests use this when they expect the server to ask the client for something, such as information or confirmation. It relies on `read_jsonrpc_message` for each incoming line, and its result can be paired with `send_response` when the test wants to answer the server.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); 2 external calls (bail!, eprintln!).


##### `McpProcess::read_stream_until_response_message`  (lines 284–309)

```
async fn read_stream_until_response_message(
        &mut self,
        request_id: RequestId,
    ) -> anyhow::Result<JsonRpcResponse<serde_json::Value>>
```

**Purpose**: Keeps reading server output until it finds the response for a specific request ID. This lets a test ignore unrelated notifications while waiting for the answer to one request.

**Data flow**: It receives the request ID the test is waiting for. It reads messages one by one. Notifications are logged and skipped. A response is checked against the requested ID, and the matching response is returned. Requests and errors are considered unexpected in this context and cause the test to fail.

**Call relations**: Tests typically call this after sending a request such as a Codex tool call. The request ID often comes from `send_codex_tool_call` or another sender. Internally, it keeps using `read_jsonrpc_message` until the matching response appears.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); 2 external calls (bail!, eprintln!).


##### `McpProcess::read_stream_until_legacy_task_complete_notification`  (lines 313–353)

```
async fn read_stream_until_legacy_task_complete_notification(
        &mut self,
    ) -> anyhow::Result<JsonRpcNotification<CustomNotification>>
```

**Purpose**: Waits for the older-style Codex event notification that means a task has completed. This supports tests that still check the legacy `codex/event` notification shape.

**Data flow**: It reads messages from the server one at a time. For each notification, it checks whether the method is `codex/event` and whether the nested `params.msg.type` field is `task_complete`. Matching notifications are returned; other notifications are logged and ignored. Requests, responses, and errors are treated as unexpected and fail the test.

**Call relations**: Tests use this when they need to wait until a Codex task has finished according to the legacy event stream. Like the other waiting helpers, it depends on `read_jsonrpc_message` for raw input and adds a test-friendly filter on top.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); 2 external calls (bail!, eprintln!).


##### `McpProcess::drop`  (lines 357–383)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the child `codex-mcp-server` process when the test helper goes away. This reduces flaky tests caused by leftover child processes still running during test teardown.

**Data flow**: When `McpProcess` is dropped, it asks the child process to terminate. Then it checks repeatedly, for up to five seconds, whether the operating system reports that the child has exited. It sleeps briefly between checks and stops early if the process is gone or if checking fails.

**Call relations**: This runs automatically when a test finishes with its `McpProcess`. It backs up Tokio's best-effort `kill_on_drop` behavior with a bounded synchronous cleanup step, because `Drop` cannot perform asynchronous waiting.

*Call graph*: 6 external calls (start_kill, try_wait, sleep, from_millis, from_secs, now).


### `mcp-server/tests/common/mock_model_server.rs`

`test` · `test setup and mock request handling`

This file is a small testing tool. In normal use, the project may talk to a model API over HTTP. Tests should not depend on that real API, because it could be slow, expensive, unavailable, or change its answers. So this file builds a local mock server: a pretend web server that behaves just enough like the model service for tests to run safely.

The main helper, `create_mock_responses_server`, starts a `wiremock` server and teaches it one rule: when it receives a `POST` request to `/v1/responses`, return one of the supplied response strings. The responses are returned in order, like cards being dealt from a deck. The helper also tells the mock server how many calls to expect, so a test can catch mistakes such as calling the model too many or too few times.

The ordering is handled by `SeqResponder`. It keeps a counter using an atomic integer, which is a number that can be safely updated even if requests happen from different async tasks at the same time. Each incoming request increments the counter and uses the old value to pick the next response. The returned response is marked as `text/event-stream`, matching the streaming style used by the model endpoint.

#### Function details

##### `create_mock_responses_server`  (lines 13–30)

```
async fn create_mock_responses_server(responses: Vec<String>) -> MockServer
```

**Purpose**: Starts a local fake HTTP server for tests and configures it to return the given model responses, one per request, in order. A test uses this when it wants predictable model output without contacting a real model service.

**Data flow**: It receives a list of response bodies as strings. It starts a mock server, wraps those strings in a sequential responder with a call counter, and registers a rule for `POST /v1/responses`. It returns the running mock server, which the test can point the application at.

**Call relations**: This is the setup entry for tests that need fake model responses. It uses `wiremock` helpers to start the server, describe the request shape with `method` and `path`, and attach `SeqResponder` as the object that will produce each response when matching requests arrive.

*Call graph*: 5 external calls (new, given, start, method, path).


##### `SeqResponder::respond`  (lines 38–47)

```
fn respond(&self, _: &wiremock::Request) -> ResponseTemplate
```

**Purpose**: Produces the next prepared response whenever the mock server receives a matching request. It makes sure repeated calls get different answers in the same order the test provided them.

**Data flow**: It receives the incoming mock request, though it does not need to inspect it because the server rule already matched the method and path. It increases its internal call counter, uses the previous count as an index into the stored response list, and builds an HTTP 200 response with a `text/event-stream` content type and that response body. If there is no response left, it fails the test with a clear error message.

**Call relations**: The mock server calls this after `create_mock_responses_server` has mounted it as the responder for `POST /v1/responses`. Inside the response-building step, it uses the atomic counter update to choose the next answer, then hands a `ResponseTemplate` back to `wiremock` so it can send the fake HTTP response.

*Call graph*: 2 external calls (fetch_add, new).


### `mcp-server/tests/common/responses.rs`

`test` · `test setup and test execution`

Tests often need predictable answers. This file provides small helper functions that create those answers in the same streaming format the real system expects. The format is SSE, short for Server-Sent Events: a simple way for a server to send a sequence of messages over one connection, like handing over numbered slips of paper one after another.

Each helper builds a complete mini conversation response. First it creates a “response started” event. Then it adds the important middle event, such as “call this shell command” or “send this assistant message.” Finally it adds a “response completed” event. This shape matters because the code under test likely expects the same start-work-finish pattern it would receive from the real assistant service.

The file uses JSON for tool arguments, because tool calls need their inputs packed into a machine-readable string. For shell commands, it carefully joins command words into a shell-safe command line. For patches, it wraps the patch text in an `apply_patch` heredoc, which is a shell pattern for passing a block of text safely as input. Without these helpers, many tests would have to duplicate fragile response-building details.

#### Function details

##### `create_shell_command_sse_response`  (lines 6–24)

```
fn create_shell_command_sse_response(
    command: Vec<String>,
    workdir: Option<&Path>,
    timeout_ms: Option<u64>,
    call_id: &str,
) -> anyhow::Result<String>
```

**Purpose**: Creates a fake streamed assistant response that asks the system to run a shell command. Tests use it when they need to check how the MCP server reacts to a tool call for command execution.

**Data flow**: It takes a command as separate words, an optional working directory, an optional timeout, and a call ID. It turns the command words into one shell-safe command string, packs the command details into JSON, wraps that JSON in a function-call event, and surrounds it with start and completed events. The result is one string containing the whole fake SSE response, or an error if the command or JSON cannot be built.

**Call relations**: In test scenarios, this helper is called before feeding a mocked response into the code being tested. It relies on shared response-building helpers to make the standard SSE envelope, and it supplies the middle event that says: call the `shell_command` tool with these arguments.

*Call graph*: calls 1 internal fn (sse); 5 external calls (format!, json!, to_string, try_join, vec!).


##### `create_final_assistant_message_sse_response`  (lines 26–33)

```
fn create_final_assistant_message_sse_response(message: &str) -> anyhow::Result<String>
```

**Purpose**: Creates a fake streamed response where the assistant simply sends a final text message. Tests use it for cases where no tool call is needed and the assistant is expected to finish with plain text.

**Data flow**: It takes the message text, places it into an assistant-message event, and wraps that event between a response-created event and a response-completed event. It returns the full SSE response string.

**Call relations**: This is the simplest test response builder in the file. Test code can call it when it wants the downstream system to see a normal assistant answer, and it hands off the event formatting to the shared response helpers.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `create_apply_patch_sse_response`  (lines 35–47)

```
fn create_apply_patch_sse_response(
    patch_content: &str,
    call_id: &str,
) -> anyhow::Result<String>
```

**Purpose**: Creates a fake streamed assistant response that asks the system to apply a code patch through a shell command. Tests use it to simulate the assistant proposing file edits.

**Data flow**: It takes patch text and a call ID. It wraps the patch text in an `apply_patch` command using a heredoc block, turns that command into JSON tool arguments, then builds an SSE response containing a `shell_command` function call. The output is the complete fake streamed response string, or an error if the JSON cannot be produced.

**Call relations**: Tests call this when they want to exercise the patch-application path without a real assistant. Like the shell-command helper, it uses the common SSE response builders for the outer start and finish events, while this function supplies the patch-specific command in the middle.

*Call graph*: calls 1 internal fn (sse); 4 external calls (format!, json!, to_string, vec!).


### Codex tool end-to-end tests
This test module uses the shared harness to validate full MCP `codex` tool behavior against mocked backend responses and approval flows.

### `mcp-server/tests/suite/codex_tool.rs`

`test` · `test run`

These tests act like a user talking to Codex through MCP, the Model Context Protocol, which is a JSON-based way for tools and assistants to exchange requests. The file sets up a fake model API server that sends prewritten streaming replies, then starts a real `codex mcp` process pointed at that fake server. This lets the tests check the full path without calling a real model provider.

The main behavior under test is permission asking, called “elicitation” here: when the model asks Codex to run an untrusted shell command or apply a patch, the MCP server must pause and ask the MCP client for approval. Only after the test sends an approval response should Codex continue. One test verifies this by approving a shell command and then checking that a file was actually created. Another approves a patch and checks that the file contents changed.

A third test checks a different path: when a caller supplies base and developer instructions to the `codex` tool, those instructions must be included in the request sent to the model server. The helper functions build expected JSON messages and create temporary configuration files so each test runs in its own clean sandbox. Without this file, regressions in the MCP permission flow could let actions run without approval, fail to resume after approval, or drop caller-provided instructions.

#### Function details

##### `test_shell_command_approval_triggers_elicitation`  (lines 40–53)

```
async fn test_shell_command_approval_triggers_elicitation()
```

**Purpose**: This is the public test case for the shell-command approval flow. It skips itself when the surrounding Codex sandbox has disabled networking, because the test needs a local mock server and process communication.

**Data flow**: It reads an environment variable that says whether network use is disabled. If networking is unavailable, it prints a skip message and exits; otherwise it hands control to the async helper that performs the real end-to-end test and turns any failure into a test failure.

**Call relations**: The test runner calls this function. It is a thin wrapper around `shell_command_approval_triggers_elicitation`, which contains the detailed setup, request, approval, and verification steps.

*Call graph*: calls 1 internal fn (shell_command_approval_triggers_elicitation); 2 external calls (var, println!).


##### `shell_command_approval_triggers_elicitation`  (lines 55–186)

```
async fn shell_command_approval_triggers_elicitation() -> anyhow::Result<()>
```

**Purpose**: This function proves that an untrusted shell command does not run silently. Codex must first send an approval request through MCP, and after approval the command should run and the original tool call should finish successfully.

**Data flow**: It creates a temporary working folder and chooses a simple command that creates a file, using a Windows-specific command on Windows and `touch` elsewhere. It starts a test MCP process whose fake model response asks Codex to run that command, sends a `codex` tool request, waits for an MCP approval request, checks that the request contains the expected command and directory, sends an approval response, then waits for the final Codex response and checks that the file now exists.

**Call relations**: It is called by `test_shell_command_approval_triggers_elicitation`. It relies on `create_mcp_process` to start the fake model server and MCP process, and on `create_expected_elicitation_request_params` to build the exact approval-request JSON that the server should have sent.

*Call graph*: calls 1 internal fn (create_mcp_process); called by 1 (test_shell_command_approval_triggers_elicitation); 11 external calls (default, new, Number, assert!, assert_eq!, cfg!, format_with_current_shell, to_value, try_join, timeout (+1 more)).


##### `create_expected_elicitation_request_params`  (lines 188–214)

```
fn create_expected_elicitation_request_params(
    command: Vec<String>,
    workdir: &Path,
    codex_mcp_tool_call_id: String,
    codex_event_id: String,
    thread_id: codex_protocol::ThreadId,
)
```

**Purpose**: This helper builds the JSON object that a shell-command approval request is expected to contain. It keeps the test’s expected value in one clear place so the assertion is easier to read.

**Data flow**: It receives the command, working directory, Codex tool-call id, Codex event id, and thread id. It turns the command into a display string for the approval message, parses the command into Codex’s structured command form, packages all of that into `ExecApprovalElicitRequestParams`, and returns it as JSON.

**Call relations**: It is used inside `shell_command_approval_triggers_elicitation` after the MCP process sends an approval request. The helper mirrors the server’s expected approval payload so the test can compare the actual request against a complete expected JSON value.

*Call graph*: calls 1 internal fn (parse_command); 4 external calls (to_path_buf, format!, json!, to_value).


##### `test_patch_approval_triggers_elicitation`  (lines 219–230)

```
async fn test_patch_approval_triggers_elicitation()
```

**Purpose**: This is the public test case for the patch-approval flow. It checks the same approval idea as the shell test, but for proposed file edits rather than command execution.

**Data flow**: It first checks whether networking is disabled in the surrounding sandbox. If so, it prints a skip message and exits; otherwise it calls the async helper that performs the patch approval test and reports any error as a failed test.

**Call relations**: The test runner calls this function. It delegates the actual work to `patch_approval_triggers_elicitation`, keeping the top-level test small and allowing the helper to use normal error propagation.

*Call graph*: calls 1 internal fn (patch_approval_triggers_elicitation); 2 external calls (var, println!).


##### `patch_approval_triggers_elicitation`  (lines 232–350)

```
async fn patch_approval_triggers_elicitation() -> anyhow::Result<()>
```

**Purpose**: This function proves that Codex asks for permission before applying a proposed patch, and that approving the request really changes the target file.

**Data flow**: It skips the detailed check on Windows because the relevant PowerShell patch command is not parsed into the same approval path. On other platforms, it creates a temporary file with original content, prepares a patch that changes that content, starts an MCP process whose fake model response asks to apply the patch, sends a `codex` tool request, waits for an approval request, checks that the request describes the expected file change, sends an approval response, waits for the final Codex response, and finally reads the file back to confirm the content was modified.

**Call relations**: It is called by `test_patch_approval_triggers_elicitation`. It uses `create_mcp_process` for the end-to-end test setup and `create_expected_patch_approval_elicitation_request_params` to construct the approval JSON that should be emitted by the MCP server.

*Call graph*: calls 1 internal fn (create_mcp_process); called by 1 (test_patch_approval_triggers_elicitation); 14 external calls (default, from, new, new, Number, assert_eq!, cfg!, format!, json!, to_value (+4 more)).


##### `test_codex_tool_passes_base_instructions`  (lines 353–361)

```
async fn test_codex_tool_passes_base_instructions()
```

**Purpose**: This is the public test case that checks instruction forwarding. It verifies that caller-supplied base and developer instructions are not lost before the request reaches the model provider.

**Data flow**: It uses the project’s network-skip helper to avoid running when the needed local networking is unavailable. Then it calls the async helper that starts the mock server, sends the Codex request, and inspects what the mock server received.

**Call relations**: The test runner calls this wrapper. It delegates to `codex_tool_passes_base_instructions`, which performs the full setup and assertions.

*Call graph*: calls 1 internal fn (codex_tool_passes_base_instructions); 1 external calls (skip_if_no_network!).


##### `codex_tool_passes_base_instructions`  (lines 363–446)

```
async fn codex_tool_passes_base_instructions() -> anyhow::Result<()>
```

**Purpose**: This function checks that text instructions supplied to the MCP `codex` tool are included in the model API request. This matters because these instructions shape how the assistant behaves.

**Data flow**: It starts a fake model server that returns a final message, creates a temporary Codex home directory with configuration pointing to that server, starts and initializes an MCP process, and sends a `codex` tool request with a prompt plus base and developer instructions. It waits for the tool response, checks that the user-facing answer is correct, then reads the HTTP request captured by the fake server to confirm the base instructions appear at the start of the model instructions and the developer instructions appear among developer messages alongside Codex’s own permission-related developer message.

**Call relations**: It is called by `test_codex_tool_passes_base_instructions`. It uses `create_config_toml` to point Codex at the fake model server, while the mock server records the outgoing model request so this test can inspect it after the MCP call completes.

*Call graph*: calls 2 internal fn (new, create_config_toml); called by 1 (test_codex_tool_passes_base_instructions); 8 external calls (default, new, Number, assert!, assert_eq!, create_mock_responses_server, timeout, vec!).


##### `create_expected_patch_approval_elicitation_request_params`  (lines 448–475)

```
fn create_expected_patch_approval_elicitation_request_params(
    changes: HashMap<PathBuf, FileChange>,
    grant_root: Option<PathBuf>,
    reason: Option<String>,
    codex_mcp_tool_call_id: String
```

**Purpose**: This helper builds the JSON object that a patch-approval request is expected to contain. It lets the test compare the server’s real approval request against a precise description of the proposed file edits.

**Data flow**: It receives the expected file changes, optional permission root, optional reason text, Codex ids, and thread id. It builds the human-facing approval message, wraps the changes and metadata in `PatchApprovalElicitRequestParams`, and returns that structure as JSON.

**Call relations**: It is used by `patch_approval_triggers_elicitation` after the MCP process emits a patch approval request. The helper supplies the expected payload for the assertion that checks whether Codex described the patch correctly.

*Call graph*: 3 external calls (new, json!, to_value).


##### `create_mcp_process`  (lines 489–500)

```
async fn create_mcp_process(responses: Vec<String>) -> anyhow::Result<McpHandle>
```

**Purpose**: This helper creates the test world needed for the approval tests: a fake model server, a temporary Codex configuration directory, and a live MCP process connected to that fake server.

**Data flow**: It receives a list of fake streaming model responses. It starts a mock responses server with those responses, creates a temporary Codex home directory, writes a config file pointing Codex at the mock server, launches an `McpProcess`, initializes it with a timeout, and returns an `McpHandle` that keeps the process, server, and temporary directory alive together.

**Call relations**: It is called by both approval-flow helpers, `shell_command_approval_triggers_elicitation` and `patch_approval_triggers_elicitation`. It hands back a ready-to-use MCP process so those tests can focus on sending tool calls and checking approval behavior instead of repeating setup code.

*Call graph*: calls 2 internal fn (new, create_config_toml); called by 2 (patch_approval_triggers_elicitation, shell_command_approval_triggers_elicitation); 3 external calls (new, create_mock_responses_server, timeout).


##### `create_config_toml`  (lines 505–528)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes a temporary Codex configuration file for tests. The configuration tells Codex to use the mock model provider and to require approval for untrusted actions.

**Data flow**: It receives a Codex home directory and the mock server’s base URI. It writes `config.toml` into that directory with a mock model name, an untrusted approval policy, workspace-write sandbox settings, and provider settings that point requests at the fake server with retries disabled.

**Call relations**: It is used by `create_mcp_process` for the approval tests and directly by `codex_tool_passes_base_instructions`. By controlling the config file, these tests make the real MCP process talk to the local mock server instead of an external provider.

*Call graph*: called by 2 (codex_tool_passes_base_instructions, create_mcp_process); 3 external calls (join, format!, write).
