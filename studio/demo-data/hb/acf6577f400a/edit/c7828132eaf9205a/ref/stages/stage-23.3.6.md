# MCP server executable integration tests  `stage-23.3.6`

This stage is the system’s end-to-end check for the MCP server executable. Instead of testing tiny pieces in isolation, it starts the real `codex-mcp-server` program as a child process and talks to it the way a real client would. That makes it part of the “does the whole thing actually work?” story.

The entry point is `tests/all.rs`, which gathers these integration tests into one test binary. `tests/suite/mod.rs` organizes the suite and currently points to the `codex_tool` tests. `tests/common/lib.rs` adds shared helpers, including one that turns raw JSON-RPC messages — remote procedure call messages sent as JSON text — back into typed Rust values for easy checking.

`mcp_process.rs` is the heart of the harness. It launches the server and sends and receives line-by-line JSON-RPC traffic. `mock_model_server.rs` supplies a fake model service, so tests do not need a real backend. `responses.rs` prepares scripted streamed replies, including assistant text, shell tool requests, and patch commands. Finally, `codex_tool.rs` ties it together to verify real tool behavior, especially approval prompts and instruction passing.

## Files in this stage

### Test suite entrypoints
These files assemble the integration-test binary and expose the suite modules that the harness runs.

### `mcp-server/tests/all.rs`

`test` · `test run`

This file is the integration test entry point for the mcp-server crate. Like the analogous login test root, it uses a single `suite` module to gather all integration tests from `tests/suite/` into one Cargo test crate. The crate-level allowance for `clippy::expect_used` reflects a deliberate testing style where `expect` is acceptable for concise, readable assertions and setup failures.

Its main effect is organizational. Instead of multiple top-level files in `tests/` producing separate integration test binaries, this file creates one binary that compiles the suite as modules. That can simplify shared helpers, reduce duplication, and make the suite easier to navigate. The actual test logic is not here; this file only establishes the root from which the suite is loaded.

Because Cargo treats this file as the integration test crate boundary, any crate-level imports, attributes, or shared setup patterns would begin here. In its current form it is intentionally minimal, acting as a stable anchor for the suite while delegating all substantive testing to submodules.


### `mcp-server/tests/suite/mod.rs`

`test` · `test run`

This module is the suite manifest for mcp-server integration tests. Its sole declaration, `mod codex_tool;`, pulls the `codex_tool` integration tests into the single test crate rooted at `tests/all.rs`. That makes this file the authoritative list of suite components for the crate’s integration-level coverage.

Although tiny, it encodes the current scope of integration testing: the `codex_tool` behavior is the only grouped integration test module included here. As additional integration scenarios are added, they would be registered in this file to become part of the suite. This pattern keeps test discovery explicit and avoids scattering top-level integration test binaries.

There is no executable logic or state in this module. Its value is in composition and maintenance: it provides a clear, centralized place to see which integration test groups exist and to control whether they are compiled into the shared test harness.


### Shared integration harness
These common utilities provide typed JSON-RPC decoding, child-process MCP transport, mocked model serving, and canned streamed responses used across the tests.

### `mcp-server/tests/common/lib.rs`

`test` · `test execution`

This test-support module is a thin re-export hub for the MCP integration test suite. It exposes process helpers, mock model server setup, canned SSE response builders, and shell-formatting utilities from sibling modules and external test-support crates so individual tests can import a single common module.

Its only local behavior is `to_response`, a convenience adapter for tests that receive `JsonRpcResponse<serde_json::Value>` from the MCP process and want to deserialize the `result` field into a concrete Rust type. The helper first normalizes `response.result` through `serde_json::to_value`, then deserializes that value into the requested `T: DeserializeOwned`. This keeps test code concise and centralizes the conversion pattern used when asserting typed MCP responses. Errors from either serialization or deserialization are propagated as `anyhow::Result`, making failures easy to bubble up in async integration tests.

#### Function details

##### `to_response`  (lines 18–24)

```
fn to_response(
    response: JsonRpcResponse<serde_json::Value>,
) -> anyhow::Result<T>
```

**Purpose**: Converts a generic JSON-RPC response payload into a caller-specified typed value for assertions in tests. It is a small deserialization convenience wrapper.

**Data flow**: It takes `JsonRpcResponse<serde_json::Value>`, extracts `response.result`, converts it to a `serde_json::Value` with `to_value`, then deserializes that value into `T: DeserializeOwned` with `from_value`. It returns `anyhow::Result<T>`, propagating either conversion error.

**Call relations**: This helper is used by integration tests after reading responses from `McpProcess`. It does not participate in production runtime flow.

*Call graph*: 2 external calls (from_value, to_value).


### `mcp-server/tests/common/mcp_process.rs`

`test` · `test execution`

This file is the core black-box test driver for the MCP server. `McpProcess` owns a spawned child process plus piped stdin/stdout handles and an atomic request-id counter used to generate client-side JSON-RPC ids. `new_with_env` locates the built `codex-mcp-server` binary, configures piped stdio, injects `CODEX_HOME` and `RUST_LOG`, applies per-test environment overrides or removals, spawns the child with `kill_on_drop(true)`, extracts stdin/stdout, wraps stdout in `BufReader`, and forwards the child’s stderr to the test process’s stderr on a background task so failures remain visible.

The harness includes a full MCP initialization handshake in `initialize`: it sends an `initialize` request advertising elicitation form capability, reads the response, computes the expected `serverInfo.user_agent` string using OS/build/originator data, asserts the exact response payload, and then sends `notifications/initialized`. Additional helpers send `tools/call` requests for the `codex` tool, arbitrary requests, and raw JSON-RPC responses.

Read-side helpers continuously consume the child’s stdout until a message of interest appears. They intentionally ignore notifications when waiting for requests or specific responses, and they fail fast if an unexpected message kind arrives. One specialized reader waits for the legacy `codex/event` notification whose `params.msg.type` is `task_complete`. The custom `Drop` implementation performs bounded synchronous cleanup by issuing `start_kill()` and polling `try_wait()` for up to five seconds, reducing flaky leak detection caused by Tokio’s best-effort child reaping.

#### Function details

##### `McpProcess::new`  (lines 47–49)

```
async fn new(codex_home: &Path) -> anyhow::Result<Self>
```

**Purpose**: Creates a test MCP child process with the default environment behavior. It is a convenience wrapper over the more configurable constructor.

**Data flow**: It takes a `codex_home` path, calls `Self::new_with_env(codex_home, &[])`, and returns the resulting `anyhow::Result<McpProcess>`. It adds no additional state or side effects beyond delegation.

**Call relations**: It is called by integration tests such as `codex_tool_passes_base_instructions` and `create_mcp_process`. All actual process setup is delegated to `McpProcess::new_with_env`.

*Call graph*: called by 2 (codex_tool_passes_base_instructions, create_mcp_process); 1 external calls (new_with_env).


##### `McpProcess::new_with_env`  (lines 56–111)

```
async fn new_with_env(
        codex_home: &Path,
        env_overrides: &[(&str, Option<&str>)],
    ) -> anyhow::Result<Self>
```

**Purpose**: Launches the `codex-mcp-server` binary as a child process with test-controlled environment overrides and captured stdio. It prepares the process for subsequent JSON-RPC interaction.

**Data flow**: Inputs are a Codex home path and a slice of `(key, Option<value>)` environment overrides. It resolves the binary path with `cargo_bin`, builds a `tokio::process::Command`, pipes stdin/stdout/stderr, sets `CODEX_HOME` and `RUST_LOG`, applies each override or removal, spawns the child with `kill_on_drop(true)`, extracts stdin and stdout handles, wraps stdout in `BufReader`, and if stderr exists spawns a task that reads and prints each stderr line. It returns a populated `McpProcess` with `next_request_id` initialized to zero.

**Call relations**: It underpins `McpProcess::new` and is the entrypoint for tests that need custom child environment state. The spawned process is later driven by the send/read helpers in this same file.

*Call graph*: 7 external calls (new, new, piped, new, cargo_bin, eprintln!, spawn).


##### `McpProcess::initialize`  (lines 114–185)

```
async fn initialize(&mut self) -> anyhow::Result<()>
```

**Purpose**: Performs the MCP initialize handshake against the child server and asserts the exact initialize response shape. It also sends the follow-up initialized notification expected by the protocol.

**Data flow**: It increments `next_request_id`, builds `ClientCapabilities` with elicitation form support, constructs `InitializeRequestParams` with a test `Implementation` and protocol version, serializes those params, sends an `initialize` JSON-RPC request via `send_jsonrpc_message`, reads one message via `read_jsonrpc_message`, computes the expected `user_agent` string from OS info, package version, originator, and terminal user agent, pattern-matches the response as `JsonRpcMessage::Response`, asserts `jsonrpc`, `id`, and full `result` equality, then sends a `notifications/initialized` notification. It returns `anyhow::Result<()>`.

**Call relations**: Tests call this immediately after constructing `McpProcess` to bring the server into its initialized state. It relies on `send_jsonrpc_message` and `read_jsonrpc_message` for transport and validates behavior implemented by `MessageProcessor::handle_initialize`.

*Call graph*: calls 3 internal fn (originator, read_jsonrpc_message, send_jsonrpc_message); 15 external calls (fetch_add, default, new, new, new, new, Notification, Request, bail!, Number (+5 more)).


##### `McpProcess::send_codex_tool_call`  (lines 189–204)

```
async fn send_codex_tool_call(
        &mut self,
        params: CodexToolCallParam,
    ) -> anyhow::Result<i64>
```

**Purpose**: Sends a `tools/call` request targeting the `codex` tool with typed parameters. It hides the JSON object wrapping required by the MCP schema.

**Data flow**: It takes a `CodexToolCallParam`, serializes it to JSON, asserts the result is an object map, wraps that map in `CallToolRequestParams::new("codex").with_arguments(...)`, serializes the call params, and delegates to `send_request("tools/call", Some(...))`. It returns the numeric request id allocated by `send_request`.

**Call relations**: Integration tests use this helper to start Codex sessions through the child server. It delegates request-id allocation and wire transmission to `send_request`.

*Call graph*: calls 1 internal fn (send_request); 3 external calls (new, to_value, unreachable!).


##### `McpProcess::send_request`  (lines 206–220)

```
async fn send_request(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> anyhow::Result<i64>
```

**Purpose**: Builds and sends an arbitrary JSON-RPC request to the child process, returning the numeric request id used. It is the generic request primitive for the harness.

**Data flow**: Inputs are a method string and optional JSON params. It increments `next_request_id`, constructs `JsonRpcMessage::Request(JsonRpcRequest { jsonrpc: 2.0, id: RequestId::Number(request_id), request: CustomRequest::new(method, params) })`, sends it with `send_jsonrpc_message`, and returns the numeric id.

**Call relations**: It is called by `send_codex_tool_call` and can support other test helpers. The child server later correlates responses using the returned request id.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); called by 1 (send_codex_tool_call); 4 external calls (fetch_add, new, Request, Number).


##### `McpProcess::send_response`  (lines 222–233)

```
async fn send_response(
        &mut self,
        id: RequestId,
        result: serde_json::Value,
    ) -> anyhow::Result<()>
```

**Purpose**: Sends a JSON-RPC response message from the test harness to the child server. This is used when the server itself has issued a request, such as an elicitation prompt.

**Data flow**: It takes a `RequestId` and arbitrary JSON result, wraps them in `JsonRpcMessage::Response(JsonRpcResponse { jsonrpc: 2.0, id, result })`, and forwards that message through `send_jsonrpc_message`. It returns `anyhow::Result<()>`.

**Call relations**: Tests use this helper to answer server-originated requests observed via `read_stream_until_request_message`. It complements the server-side callback mechanism implemented by `OutgoingMessageSender::send_request` and `notify_client_response`.

*Call graph*: calls 1 internal fn (send_jsonrpc_message); 1 external calls (Response).


##### `McpProcess::send_jsonrpc_message`  (lines 235–245)

```
async fn send_jsonrpc_message(
        &mut self,
        message: JsonRpcMessage<CustomRequest, serde_json::Value, CustomNotification>,
    ) -> anyhow::Result<()>
```

**Purpose**: Serializes a JSON-RPC message and writes it to the child process’s stdin with newline framing. It is the low-level write path for the harness.

**Data flow**: It takes a typed `JsonRpcMessage<CustomRequest, serde_json::Value, CustomNotification>`, prints a debug line to stderr, serializes the message to a string, writes the bytes to `self.stdin`, writes a trailing newline, flushes stdin, and returns `anyhow::Result<()>`.

**Call relations**: It is called by `initialize`, `send_request`, and `send_response`. All outbound test traffic to the child process passes through this method.

*Call graph*: called by 3 (initialize, send_request, send_response); 4 external calls (flush, write_all, eprintln!, to_string).


##### `McpProcess::read_jsonrpc_message`  (lines 247–257)

```
async fn read_jsonrpc_message(
        &mut self,
    ) -> anyhow::Result<JsonRpcMessage<CustomRequest, serde_json::Value, CustomNotification>>
```

**Purpose**: Reads one line-delimited JSON-RPC message from the child process’s stdout and deserializes it. It is the low-level read primitive for the harness.

**Data flow**: It reads a line into a `String` from `self.stdout`, deserializes that line into `JsonRpcMessage<CustomRequest, serde_json::Value, CustomNotification>`, prints the decoded message to stderr, and returns it as `anyhow::Result<_>`.

**Call relations**: It is used by `initialize` and all stream-scanning helpers. Higher-level readers build their filtering logic on top of this single-message primitive.

*Call graph*: called by 4 (initialize, read_stream_until_legacy_task_complete_notification, read_stream_until_request_message, read_stream_until_response_message); 3 external calls (read_line, new, eprintln!).


##### `McpProcess::read_stream_until_request_message`  (lines 259–282)

```
async fn read_stream_until_request_message(
        &mut self,
    ) -> anyhow::Result<JsonRpcRequest<CustomRequest>>
```

**Purpose**: Consumes the child’s output stream until the next JSON-RPC request message appears, ignoring notifications along the way. It is useful when the server is expected to ask the client something, such as approval elicitation.

**Data flow**: It loops, repeatedly calling `read_jsonrpc_message`. Notifications are logged and skipped; a `JsonRpcMessage::Request` is returned immediately; `Error` and `Response` variants cause an `anyhow::bail!` failure. It returns the matched `JsonRpcRequest<CustomRequest>`.

**Call relations**: Tests call this after triggering server behavior that should emit a request to the client. It depends on `read_jsonrpc_message` for transport and acts as a filter over the mixed stdout stream.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); 2 external calls (bail!, eprintln!).


##### `McpProcess::read_stream_until_response_message`  (lines 284–309)

```
async fn read_stream_until_response_message(
        &mut self,
        request_id: RequestId,
    ) -> anyhow::Result<JsonRpcResponse<serde_json::Value>>
```

**Purpose**: Consumes the child’s output until it sees a response with a specific request id, ignoring unrelated notifications. It lets tests wait for the completion of a particular client request.

**Data flow**: Inputs are the target `RequestId`. It loops on `read_jsonrpc_message`, skipping notifications, failing on unexpected requests or errors, and returning the first `JsonRpcResponse` whose `id` equals the requested id. Responses for other ids are ignored and the loop continues.

**Call relations**: Tests use this after sending a request through `send_request` or `send_codex_tool_call` and needing the matching response. It is the response-side counterpart to `read_stream_until_request_message`.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); 2 external calls (bail!, eprintln!).


##### `McpProcess::read_stream_until_legacy_task_complete_notification`  (lines 313–353)

```
async fn read_stream_until_legacy_task_complete_notification(
        &mut self,
    ) -> anyhow::Result<JsonRpcNotification<CustomNotification>>
```

**Purpose**: Consumes the child’s output until it observes the legacy `codex/event` notification whose embedded event type is `task_complete`. It is specialized for older completion signaling still used in tests.

**Data flow**: It loops on `read_jsonrpc_message`. For each notification, it checks whether `notification.notification.method == "codex/event"` and whether `params.msg.type` equals `"task_complete"`; matching notifications are returned, non-matching notifications are logged and ignored, and any request/error/response message causes an `anyhow::bail!` failure.

**Call relations**: Integration tests call this when they expect the server to finish a task by emitting the legacy completion event. It builds on `read_jsonrpc_message` and encodes the exact notification shape to watch for.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); 2 external calls (bail!, eprintln!).


##### `McpProcess::drop`  (lines 357–383)

```
fn drop(&mut self)
```

**Purpose**: Performs bounded best-effort cleanup of the spawned child process during test teardown. It reduces flaky leak detection by waiting briefly for process exit after requesting termination.

**Data flow**: On drop, it calls `self.process.start_kill()`, records the current instant, and repeatedly polls `self.process.try_wait()` until the child exits, an error occurs, or five seconds elapse; between polls it sleeps for 10 ms on the current thread. It returns no value and mutates only OS process state.

**Call relations**: This destructor runs automatically when a `McpProcess` leaves scope. It complements the `kill_on_drop(true)` spawn setting with explicit synchronous waiting because the async runtime cannot be awaited from `Drop`.

*Call graph*: 6 external calls (start_kill, try_wait, sleep, from_millis, from_secs, now).


### `mcp-server/tests/common/mock_model_server.rs`

`test` · `integration test setup and mocked request handling`

This test helper spins up an in-process `wiremock::MockServer` and mounts exactly one mock route: `POST /v1/responses`. The route is backed by a custom `SeqResponder` that owns a `Vec<String>` of prebuilt response bodies and an `AtomicUsize` counter used to select the next body each time the endpoint is hit. `create_mock_responses_server` computes the expected number of calls from the response vector length, starts the server, installs the matcher chain for HTTP method and path, and configures wiremock to fail the test if the endpoint is not called exactly that many times.

`SeqResponder` implements `wiremock::Respond` directly instead of using a closure so it can keep mutable call-order state behind shared references. Its `respond` method increments the atomic with `Ordering::SeqCst`, indexes into the stored response list, and panics with a clear message if a test causes more requests than prepared responses. Every reply is returned as HTTP 200 with `content-type: text/event-stream` and the raw body set to the corresponding SSE string. The design is intentionally strict: ordering matters, over-consumption is an error, and the helper only models the single endpoint used by Codex MCP tests.

#### Function details

##### `create_mock_responses_server`  (lines 13–30)

```
async fn create_mock_responses_server(responses: Vec<String>) -> MockServer
```

**Purpose**: Starts a mock HTTP server and mounts a sequential responder for `POST /v1/responses` using the supplied SSE payloads. It also configures the mock to expect exactly one request per provided response string.

**Data flow**: Takes `responses: Vec<String>` from the test, derives `num_calls` from its length, wraps the vector in a `SeqResponder` with an `AtomicUsize` initialized to zero, starts a `MockServer`, mounts the matcher/responder pipeline onto that server, and returns the live `MockServer` handle.

**Call relations**: This helper is invoked by higher-level MCP integration tests when they need a fake model backend. After startup it delegates actual per-request body selection to `SeqResponder::respond`, while wiremock enforces the method/path match and expected call count.

*Call graph*: 5 external calls (new, given, start, method, path).


##### `SeqResponder::respond`  (lines 38–47)

```
fn respond(&self, _: &wiremock::Request) -> ResponseTemplate
```

**Purpose**: Returns the next preloaded SSE response body for each incoming request to the mocked endpoint. It preserves request order across calls and fails immediately if the test asks for more responses than were configured.

**Data flow**: Reads and increments `self.num_calls` atomically to obtain the current call index, looks up the corresponding string in `self.responses`, constructs a `ResponseTemplate` with status 200, inserts a `content-type: text/event-stream` header, clones the selected body into the response, and returns that template.

**Call relations**: Wiremock invokes this implementation whenever the mounted mock route matches a request. It is the terminal step in the mock server flow created by `create_mock_responses_server`, translating stored test fixtures into HTTP responses.

*Call graph*: 2 external calls (fetch_add, new).


### `mcp-server/tests/common/responses.rs`

`test` · `integration test fixture construction`

This file contains small fixture constructors that return complete Server-Sent Events payloads as `String` values wrapped in `anyhow::Result`. Each helper uses `core_test_support::responses` primitives to assemble a realistic sequence of response events: a response-created event, one content-bearing event, and a completion event. The resulting strings are fed into the mock model server so tests can drive the MCP process through specific tool-call and completion paths.

`create_shell_command_sse_response` accepts a tokenized command, optional working directory, optional timeout, and a call ID. It shell-quotes the command with `shlex::try_join`, serializes the tool arguments as JSON, derives a response ID from the call ID, and emits a `shell_command` function-call event. `create_final_assistant_message_sse_response` emits a simple assistant text message with a fixed response/message ID pair for terminal assistant output. `create_apply_patch_sse_response` wraps patch text in a heredoc-style `apply_patch <<'EOF' ... EOF` shell command, serializes that command as JSON arguments, and emits the same `shell_command` tool-call shape expected by the server. The helpers centralize exact event ordering and payload formatting so tests stay concise and consistent.

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

**Purpose**: Constructs an SSE stream representing a model response that asks the MCP server to invoke the `shell_command` tool with a specific command, working directory, and timeout. It packages the command exactly as the tool interface expects: a single shell string inside JSON arguments.

**Data flow**: Consumes `command: Vec<String>`, `workdir: Option<&Path>`, `timeout_ms: Option<u64>`, and `call_id: &str`; shell-joins the command tokens, builds a JSON object containing `command`, `workdir`, and `timeout_ms`, serializes that object to a string, derives `response_id = format!("resp-{call_id}")`, wraps three response events into an SSE stream, and returns the final `String`.

**Call relations**: Tests call this helper when they want the mock model server to trigger shell-command approval or execution paths. It delegates event formatting to `core_test_support::responses` so the surrounding tests can focus on MCP behavior rather than SSE syntax.

*Call graph*: calls 1 internal fn (sse); 5 external calls (format!, json!, to_string, try_join, vec!).


##### `create_final_assistant_message_sse_response`  (lines 26–33)

```
fn create_final_assistant_message_sse_response(message: &str) -> anyhow::Result<String>
```

**Purpose**: Constructs an SSE stream for a plain assistant message followed by completion. It is used as the final model response after tool execution or patch application has finished.

**Data flow**: Takes `message: &str`, uses fixed identifiers `resp-final` and `msg-final`, creates response-created, assistant-message, and completed events, combines them into one SSE string, and returns it.

**Call relations**: This helper is typically paired after a tool-call SSE fixture so tests can verify the MCP server resumes the conversation and returns assistant text to the client. It relies on the shared response-event builders for exact wire formatting.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `create_apply_patch_sse_response`  (lines 35–47)

```
fn create_apply_patch_sse_response(
    patch_content: &str,
    call_id: &str,
) -> anyhow::Result<String>
```

**Purpose**: Constructs an SSE stream that asks the MCP server to run an `apply_patch` shell command encoded as a heredoc. This lets tests exercise patch-approval parsing through the same shell-command tool channel used in production.

**Data flow**: Accepts `patch_content: &str` and `call_id: &str`, embeds the patch text into a heredoc command string, serializes `{ "command": command }` to JSON, derives `response_id` from the call ID, emits response-created, `shell_command` function-call, and completed events, and returns the assembled SSE payload.

**Call relations**: Patch approval tests invoke this helper to make the mock model backend produce an `apply_patch` request. The MCP server then interprets that shell command and routes it into its patch-approval elicitation flow.

*Call graph*: calls 1 internal fn (sse); 4 external calls (format!, json!, to_string, vec!).


### Codex tool end-to-end tests
This test module uses the shared harness to validate full MCP `codex` tool behavior against mocked backend responses and approval flows.

### `mcp-server/tests/suite/codex_tool.rs`

`test` · `integration test execution and MCP process orchestration`

This integration test suite drives a real `McpProcess` through JSON-RPC interactions while a wiremock server stands in for the model provider’s `/v1/responses` API. The file defines a generous `DEFAULT_READ_TIMEOUT` for slow CI startup, three top-level async tests, helper functions that return `anyhow::Result<()>` so the tests can use `?`, and setup utilities for temporary Codex home directories and config files.

The shell-command approval path creates a temporary working directory, prepares a platform-specific file-creation command, starts an MCP process backed by two mocked SSE responses (tool call then final assistant message), sends a `CodexToolCallParam`, waits for an `elicitation/create` request, deserializes `ExecApprovalElicitRequestParams`, and compares the full JSON payload against a helper-built expected value including parsed command metadata. After sending an approved `ExecApprovalResponse`, it verifies a legacy task-complete notification arrives before the original tool response and confirms the file was created.

The patch-approval path is similar but skips Windows, seeds a file, emits an `apply_patch` shell command, validates `PatchApprovalElicitRequestParams` including a `HashMap<PathBuf, FileChange>` diff, approves it, and checks the file contents changed. The base-instructions test inspects the actual outbound request body captured by wiremock to ensure `instructions` starts with the provided base instructions and that developer messages include both permissions guidance and explicit developer instructions. `McpHandle` intentionally retains `MockServer` and `TempDir` so the child process cannot outlive its dependencies, and `create_config_toml` hardcodes `approval_policy = "untrusted"` and the mock provider wiring needed to force these code paths.

#### Function details

##### `test_shell_command_approval_triggers_elicitation`  (lines 40–53)

```
async fn test_shell_command_approval_triggers_elicitation()
```

**Purpose**: Tokio test wrapper for the shell-command approval scenario. It skips execution when the Codex sandbox disables network access and otherwise delegates to the fallible helper.

**Data flow**: Reads `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR` from the environment; if present, prints a skip message and returns `()`. Otherwise it awaits `shell_command_approval_triggers_elicitation()` and converts any error into a test failure with `expect`.

**Call relations**: This is the test entrypoint invoked by the test runner. Its only job is environment gating and forwarding control to `shell_command_approval_triggers_elicitation`.

*Call graph*: calls 1 internal fn (shell_command_approval_triggers_elicitation); 2 external calls (var, println!).


##### `shell_command_approval_triggers_elicitation`  (lines 55–186)

```
async fn shell_command_approval_triggers_elicitation() -> anyhow::Result<()>
```

**Purpose**: Runs the full shell-command approval flow and verifies both the elicitation payload and the eventual side effect on disk. It proves that an untrusted shell tool call is surfaced to the MCP client for approval before execution.

**Data flow**: Creates a temporary workdir and target filename, chooses a platform-specific command and timeout, formats the expected shell command string, starts an `McpProcess` via `create_mcp_process` with two mocked SSE responses, sends a `CodexToolCallParam`, waits for a request message under `DEFAULT_READ_TIMEOUT`, deserializes `ExecApprovalElicitRequestParams`, compares the raw params JSON against `create_expected_elicitation_request_params`, sends an approved `ExecApprovalResponse`, waits for a legacy task-complete notification and then the original JSON-RPC response, asserts the response body matches the expected assistant content and thread ID, checks that the file now exists, and returns `Ok(())`.

**Call relations**: Called only by `test_shell_command_approval_triggers_elicitation`. It orchestrates the entire test flow, relying on `create_mcp_process` for setup and `create_expected_elicitation_request_params` to build the exact JSON shape expected from the server.

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

**Purpose**: Builds the exact JSON value expected in an exec-approval elicitation request. It mirrors the server-side parameter structure closely enough for strict equality assertions in the shell-command test.

**Data flow**: Accepts the shell `command` vector, `workdir`, `codex_mcp_tool_call_id`, `codex_event_id`, and `thread_id`; shell-quotes the command for the human-facing message, parses the command into `codex_parsed_cmd`, constructs an `ExecApprovalElicitRequestParams` with fixed `codex_elicitation = "exec-approval"`, fixed `codex_call_id = "call1234"`, empty-object `requested_schema`, and the supplied IDs/paths/command, serializes it to `serde_json::Value`, and returns that value.

**Call relations**: This helper is used by `shell_command_approval_triggers_elicitation` to compare the incoming elicitation request against a canonical expected payload. It does not perform I/O; it exists to keep the assertion logic readable and centralized.

*Call graph*: calls 1 internal fn (parse_command); 4 external calls (to_path_buf, format!, json!, to_value).


##### `test_patch_approval_triggers_elicitation`  (lines 219–230)

```
async fn test_patch_approval_triggers_elicitation()
```

**Purpose**: Tokio test wrapper for the patch-approval scenario. Like the shell-command wrapper, it skips when network-disabled sandboxing would prevent the test from running.

**Data flow**: Checks the sandbox network-disabled environment variable, optionally prints a skip message and returns early, otherwise awaits `patch_approval_triggers_elicitation()` and fails the test if that helper returns an error.

**Call relations**: This is the test runner entrypoint for patch approval. It delegates all substantive setup and assertions to `patch_approval_triggers_elicitation`.

*Call graph*: calls 1 internal fn (patch_approval_triggers_elicitation); 2 external calls (var, println!).


##### `patch_approval_triggers_elicitation`  (lines 232–350)

```
async fn patch_approval_triggers_elicitation() -> anyhow::Result<()>
```

**Purpose**: Runs the full patch-approval flow from mocked `apply_patch` tool call through elicitation approval to on-disk file modification. It verifies that patch proposals are converted into structured `FileChange` data before approval.

**Data flow**: On Windows it returns `Ok(())` immediately because PowerShell `apply_patch` calls are not parsed into patch approvals. Otherwise it creates a temp cwd, writes an initial file, builds unified patch text, starts an `McpProcess` with mocked patch and final-message SSE responses, sends a `CodexToolCallParam` with explicit cwd and `sandbox_mode = danger-full-access`, waits for an `elicitation/create` request, deserializes `PatchApprovalElicitRequestParams`, constructs an expected `HashMap<PathBuf, FileChange::Update>` diff, compares the raw params JSON against `create_expected_patch_approval_elicitation_request_params`, sends an approved `PatchApprovalResponse`, waits for the original tool response, asserts the assistant content and thread ID, reads the file back from disk, verifies it contains the modified content, and returns `Ok(())`.

**Call relations**: Called by `test_patch_approval_triggers_elicitation`. It uses `create_mcp_process` for environment setup and `create_expected_patch_approval_elicitation_request_params` to validate the exact elicitation payload emitted by the server.

*Call graph*: calls 1 internal fn (create_mcp_process); called by 1 (test_patch_approval_triggers_elicitation); 14 external calls (default, from, new, new, Number, assert_eq!, cfg!, format!, json!, to_value (+4 more)).


##### `test_codex_tool_passes_base_instructions`  (lines 353–361)

```
async fn test_codex_tool_passes_base_instructions()
```

**Purpose**: Tokio test wrapper for verifying that base and developer instructions are forwarded into the model request. It uses a network-availability macro gate rather than the sandbox environment variable.

**Data flow**: Invokes `skip_if_no_network!()` to abort the test when networking is unavailable, then awaits `codex_tool_passes_base_instructions()` and converts any error into a test failure.

**Call relations**: This is the test entrypoint for the instruction-forwarding scenario. It delegates all setup, request inspection, and assertions to `codex_tool_passes_base_instructions`.

*Call graph*: calls 1 internal fn (codex_tool_passes_base_instructions); 1 external calls (skip_if_no_network!).


##### `codex_tool_passes_base_instructions`  (lines 363–446)

```
async fn codex_tool_passes_base_instructions() -> anyhow::Result<()>
```

**Purpose**: Verifies that a `codex` tool call sends base instructions in the top-level `instructions` field and includes developer instructions among developer-role input messages. It also confirms the MCP response path still returns the assistant message correctly.

**Data flow**: Starts a mock responses server with a single final assistant SSE payload, creates a temporary Codex home and writes config via `create_config_toml`, launches and initializes `McpProcess`, sends a `CodexToolCallParam` containing `prompt`, `base_instructions`, and `developer_instructions`, waits for the JSON-RPC response and asserts its structure, fetches captured HTTP requests from the mock server, parses the first request body as JSON, extracts `instructions` and asserts it starts with the provided base instructions, filters `input` items for developer-role messages, flattens `input_text` spans into strings, and asserts those strings include both the permissions guidance mentioning ``sandbox_mode`` and the explicit developer instruction text.

**Call relations**: Called only by `test_codex_tool_passes_base_instructions`. It combines local setup from `create_config_toml` with request capture from the mock server to validate outbound request composition rather than only final MCP output.

*Call graph*: calls 2 internal fn (new, create_config_toml); called by 1 (test_codex_tool_passes_base_instructions); 8 external calls (default, new, Number, assert!, assert_eq!, create_mock_responses_server, timeout, vec!).


##### `create_expected_patch_approval_elicitation_request_params`  (lines 448–475)

```
fn create_expected_patch_approval_elicitation_request_params(
    changes: HashMap<PathBuf, FileChange>,
    grant_root: Option<PathBuf>,
    reason: Option<String>,
    codex_mcp_tool_call_id: String
```

**Purpose**: Builds the canonical JSON payload expected for patch-approval elicitation requests. It encapsulates the exact message formatting and field population used by the patch approval test.

**Data flow**: Takes `changes`, optional `grant_root`, optional `reason`, `codex_mcp_tool_call_id`, `codex_event_id`, and `thread_id`; builds `message_lines` starting with `reason` when present and always appending `Allow Codex to apply proposed code changes?`, constructs `PatchApprovalElicitRequestParams` with fixed `codex_elicitation = "patch-approval"`, fixed `codex_call_id = "call1234"`, empty-object `requested_schema`, and the supplied metadata, serializes it to `serde_json::Value`, and returns it.

**Call relations**: Used by `patch_approval_triggers_elicitation` to compare the server-emitted elicitation request against an exact expected JSON structure. It isolates formatting details from the main test body.

*Call graph*: 3 external calls (new, json!, to_value).


##### `create_mcp_process`  (lines 489–500)

```
async fn create_mcp_process(responses: Vec<String>) -> anyhow::Result<McpHandle>
```

**Purpose**: Creates a fully initialized MCP subprocess configured to talk to a mock model server serving the provided SSE responses. It returns a handle that keeps all supporting resources alive for the subprocess lifetime.

**Data flow**: Accepts `responses: Vec<String>`, starts a mock server with `create_mock_responses_server`, creates a temporary Codex home directory, writes `config.toml` via `create_config_toml`, constructs `McpProcess::new(codex_home.path())`, awaits initialization under `DEFAULT_READ_TIMEOUT`, and returns `McpHandle { process, server, dir }`.

**Call relations**: This setup helper is shared by both approval-flow tests. It sits at the bottom of their orchestration stack, wiring together the mock server, temporary config, and initialized MCP process before the tests begin sending JSON-RPC requests.

*Call graph*: calls 2 internal fn (new, create_config_toml); called by 2 (patch_approval_triggers_elicitation, shell_command_approval_triggers_elicitation); 3 external calls (new, create_mock_responses_server, timeout).


##### `create_config_toml`  (lines 505–528)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes a temporary Codex configuration file that points the MCP process at the mock model server and enables untrusted approval behavior. The generated config is tailored specifically for these integration tests.

**Data flow**: Receives `codex_home: &Path` and `server_uri: &str`, computes `config.toml` under the home directory, formats a TOML string containing model/provider settings, `approval_policy = "untrusted"`, `sandbox_policy = "workspace-write"`, mock provider base URL `${server_uri}/v1`, and zero retry counts, then writes that string to disk with `std::fs::write`.

**Call relations**: Called by both `create_mcp_process` and `codex_tool_passes_base_instructions` during test setup. It provides the configuration bridge that makes the spawned MCP process send requests to the wiremock server instead of a real model backend.

*Call graph*: called by 2 (codex_tool_passes_base_instructions, create_mcp_process); 3 external calls (join, format!, write).
