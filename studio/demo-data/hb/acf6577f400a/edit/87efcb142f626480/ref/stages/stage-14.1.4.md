# Permission and elicitation request ingress  `stage-14.1.4`

This stage is one of the system’s front doors. It sits between outside callers such as tools or MCP integrations and the deeper approval and review machinery. Its job is to take different kinds of “please ask the user” requests, clean them up into a standard shape, and pass them inward so the system can decide whether to approve automatically or wait for a person.

The request_permissions tool is the entry point for permission requests. It reads what access is being asked for in the chosen execution environment, turns the request into normalized permission profiles, and sends it to the session for approval. The request_user_input tool does the same kind of intake work for general user questions: it checks that the call is valid, parses the arguments, and forwards the request, then returns the user’s reply.

On the MCP side, elicitation.rs keeps track of pending elicitation requests, meaning structured prompts sent out for approval or input. It applies policy rules, auto-resolves what it can, and emits events for anything that needs review. exec_approval.rs and patch_approval.rs create those MCP requests for command execution and code changes, then convert the client’s answer back into the system’s own approval format.

## Files in this stage

### Tool request handlers
These handlers accept tool-originated permission and user-input requests, normalize their arguments, and forward them into the session approval flow.

### `core/src/tools/handlers/request_permissions.rs`

`orchestration` · `tool invocation when elevated environment permissions are requested`

This file provides the runtime handler for permission-escalation requests originating from tool calls. `RequestPermissionsHandler` exposes the fixed tool name, builds its schema from the shell-spec helpers, and routes execution into `handle_call`. A small helper struct, `RequestPermissionsEnvironmentArgs`, is used to parse only the optional `environment_id` field first, supporting both `environment_id` and `environmentId` spellings.

The main execution path begins by requiring a `ToolPayload::Function`; unsupported payloads become `RespondToModel` errors. It then parses the environment selector, resolves the target environment with `resolve_tool_environment`, and rejects calls when no primary environment is available. Before parsing the full `RequestPermissionsArgs`, it converts the environment's cwd into a host-native absolute path; if the cwd is not native to the Codex host, the handler returns a model-facing error that includes the problematic cwd. That native cwd is then used as the base path for `parse_arguments_with_base_path`, allowing path-bearing permission arguments to be interpreted correctly. The resulting permission list is normalized through `normalize_additional_permissions`, converted into protocol `RequestPermissionProfile` values, and rejected if empty. Finally, the handler awaits `session.request_permissions_for_environment(...)`, passing turn context, call id, normalized args, the chosen environment selection, and the cancellation token. Cancellation before a response becomes a model-facing error; successful responses are serialized with `serde_json::to_string`, and serialization failures are treated as fatal internal errors. The final tool output is plain text containing the JSON response body with success marked true.

#### Function details

##### `RequestPermissionsHandler::tool_name`  (lines 29–31)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical tool name `request_permissions`. This is the identifier used for dispatching model tool calls.

**Data flow**: Creates a `ToolName` from the static string via `ToolName::plain` and returns it.

**Call relations**: Queried by the tool registry/runtime before execution.

*Call graph*: calls 1 internal fn (plain).


##### `RequestPermissionsHandler::spec`  (lines 33–35)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the tool specification for permission requests using the shell-spec helpers. The description is supplied dynamically by `request_permissions_tool_description`.

**Data flow**: Calls `request_permissions_tool_description()` to obtain descriptive text, passes that into `create_request_permissions_tool(...)`, and returns the resulting `ToolSpec`.

**Call relations**: Used during tool publication so the model sees the correct schema and description.

*Call graph*: calls 2 internal fn (create_request_permissions_tool, request_permissions_tool_description).


##### `RequestPermissionsHandler::handle`  (lines 37–39)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async permission-request workflow to the executor trait's boxed future interface. It delegates all real work to `handle_call`.

**Data flow**: Takes a `ToolInvocation`, calls `self.handle_call(invocation)`, boxes the future, and returns it.

**Call relations**: This is the runtime entrypoint invoked after dispatch.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `RequestPermissionsHandler::handle_call`  (lines 43–117)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Validates payload shape, resolves the target environment, parses and normalizes requested permissions, submits the request for approval, and returns the serialized response. It contains the file's full operational logic.

**Data flow**: Reads `session`, `turn`, `cancellation_token`, `call_id`, and `payload` from the invocation; extracts the raw arguments string only from `ToolPayload::Function`, otherwise returns `RespondToModel`; parses `RequestPermissionsEnvironmentArgs` from the arguments; resolves the selected environment with `resolve_tool_environment`; reads the environment cwd and converts it to a native absolute path, mapping conversion failures into model-facing errors; parses full `RequestPermissionsArgs` relative to that base path via `parse_arguments_with_base_path`; normalizes `args.permissions` with `normalize_additional_permissions`, converts each normalized permission into a protocol profile, and rejects an empty permission set; awaits `session.request_permissions_for_environment(&turn, call_id, args, turn_environment.selection(), cancellation_token)` and errors if it returns `None`; serializes the response to JSON text with `serde_json::to_string`, mapping serialization failures to `FunctionCallError::Fatal`; then wraps the JSON string in `FunctionToolOutput::from_text(..., Some(true))` and boxes it.

**Call relations**: Called only from `RequestPermissionsHandler::handle`. It delegates argument decoding to the shared parsing helpers and environment lookup to `resolve_tool_environment`, then hands the normalized request to the session's permission-request mechanism.

*Call graph*: calls 6 internal fn (from_text, boxed_tool_output, parse_arguments, parse_arguments_with_base_path, resolve_tool_environment, normalize_additional_permissions); called by 1 (handle); 2 external calls (to_string, RespondToModel).


### `core/src/tools/handlers/request_user_input.rs`

`domain_logic` · `tool invocation / request handling`

This file defines `RequestUserInputHandler`, a `ToolExecutor<ToolInvocation>` whose behavior is gated by a configured list of allowed `ModeKind` values. The trait methods are thin adapters: `tool_name` returns the shared constant, `spec` delegates to the spec builder with a mode-aware description, and `handle` boxes the async `handle_call` future.

The substantive logic lives in `handle_call`. It destructures the incoming `ToolInvocation`, rejects any non-function payload with a model-facing error, and then enforces a key multi-agent invariant: only the root thread may ask the user questions. If `turn.session_source.is_non_root_agent()` is true, the call fails immediately. Next it reads the current collaboration mode from `session.collaboration_mode().await.mode` and asks `request_user_input_unavailable_message` whether the tool is allowed in that mode; disallowed modes also produce a model-facing error.

For valid calls, the handler parses JSON arguments into `RequestUserInputArgs`, normalizes them via `normalize_request_user_input_args` (which enforces non-empty options and adjusts flags/ranges), and awaits `session.request_user_input(...)`. A cancelled or absent response becomes a recoverable model error; successful responses are serialized with `serde_json::to_string`. Serialization failure is treated as fatal. The final output is wrapped as `FunctionToolOutput::from_text(content, Some(true))`, signaling a successful tool call whose body is the JSON-encoded user response.

#### Function details

##### `RequestUserInputHandler::tool_name`  (lines 24–26)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical tool name for this handler. The name is the plain `request_user_input` identifier used by the registry and model.

**Data flow**: It reads no mutable state beyond the shared constant `REQUEST_USER_INPUT_TOOL_NAME`, passes it to `ToolName::plain`, and returns the resulting `ToolName` value.

**Call relations**: The tool registry calls this when registering or dispatching the handler. `handle_call` also indirectly relies on the same name constant for consistent error messages and invocation identity.

*Call graph*: calls 1 internal fn (plain).


##### `RequestUserInputHandler::spec`  (lines 28–30)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the model-visible tool specification with wording tailored to the handler's allowed collaboration modes. It keeps the runtime policy and prompt text aligned.

**Data flow**: It reads `self.available_modes`, converts them into a descriptive sentence via `request_user_input_tool_description`, then passes that string into `create_request_user_input_tool` and returns the resulting `ToolSpec`.

**Call relations**: This method is invoked by the tool registration path when exposing the handler to the model. It delegates all schema construction to the companion spec module and only contributes the mode-specific description.

*Call graph*: calls 2 internal fn (create_request_user_input_tool, request_user_input_tool_description).


##### `RequestUserInputHandler::handle`  (lines 32–34)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async implementation into the boxed future type expected by the `ToolExecutor` trait. It does not perform validation itself.

**Data flow**: It takes a `ToolInvocation`, calls `self.handle_call(invocation)`, wraps that future with `Box::pin`, and returns it as `codex_tools::ToolExecutorFuture<'_>`.

**Call relations**: The tool runtime invokes this entrypoint for each tool call. It exists solely to route execution into `handle_call`, where all actual request processing occurs.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `RequestUserInputHandler::handle_call`  (lines 38–92)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Processes a `request_user_input` invocation end-to-end: validates payload type and thread origin, checks mode availability, parses and normalizes arguments, waits for the user's answer, and returns it as tool output.

**Data flow**: It consumes a `ToolInvocation`, extracting `session`, `turn`, `call_id`, and `payload`. From `ToolPayload::Function` it reads the raw JSON `arguments`; any other payload yields `FunctionCallError::RespondToModel`. It reads `turn.session_source` to reject non-root-agent threads, then awaits `session.collaboration_mode()` and checks the current mode against `self.available_modes` using `request_user_input_unavailable_message`. It parses `arguments` into `RequestUserInputArgs` with `parse_arguments`, normalizes them with `normalize_request_user_input_args`, and passes the result to `session.request_user_input(turn.as_ref(), call_id, args).await`. A missing response becomes a model-facing cancellation error. Otherwise it serializes the response with `serde_json::to_string`, converts that string into `FunctionToolOutput::from_text(content, Some(true))`, boxes it with `boxed_tool_output`, and returns it.

**Call relations**: This is called only by `handle`. It delegates schema-level parsing and normalization to the spec/helpers module, delegates the actual user interaction to `session.request_user_input`, and translates each failure mode into either a recoverable model response error or a fatal serialization error.

*Call graph*: calls 5 internal fn (from_text, boxed_tool_output, parse_arguments, normalize_request_user_input_args, request_user_input_unavailable_message); called by 1 (handle); 3 external calls (format!, to_string, RespondToModel).


### MCP elicitation bridge
This bridge tracks MCP elicitation requests, applies approval policy, and routes requests and later responses between MCP callbacks and Codex protocol events.

### `codex-mcp/src/elicitation.rs`

`domain_logic` · `interactive request handling`

This module encapsulates the state and policy around MCP elicitations. `ElicitationRequestManager` stores a Tokio `Mutex`-protected responder map keyed by `(server_name, RequestId)`, plus standard-mutex-protected approval policy, permission profile, and an `auto_deny` flag that can be changed at runtime. An optional `ElicitationReviewer` hook allows a higher-level reviewer to intercept requests before they are emitted as protocol events.

The main entry point is `make_sender`, which returns the `SendElicitation` callback RMCP clients use. The generated async closure first checks the `auto_deny` flag and immediately declines if set. It then snapshots the current approval policy and permission profile; if MCP permission prompts are auto-approved and the elicitation is a form with no requested properties, it auto-accepts with empty JSON content. If policy rejects MCP elicitations entirely, it auto-declines. Next, if a reviewer exists, the closure packages an `ElicitationReviewRequest` and gives the reviewer a chance to return a response directly.

Only if none of those fast paths apply does the code serialize the RMCP elicitation into a protocol-layer `ElicitationRequest` enum, create a oneshot channel, store the sender in the responder map, and emit an `EventMsg::ElicitationRequest` with a fixed event ID `mcp_elicitation_request`. Later, `resolve` removes the stored responder and forwards the chosen `ElicitationResponse`; missing requests and send failures become `anyhow` errors. The helper functions make the policy explicit: `elicitation_is_rejected_by_policy` maps `AskForApproval` variants to a boolean, and `can_auto_accept_elicitation` only approves empty form schemas, never URL elicitations.

#### Function details

##### `ElicitationRequestManager::new`  (lines 61–73)

```
fn new(
        approval_policy: AskForApproval,
        permission_profile: PermissionProfile,
        reviewer: Option<ElicitationReviewerHandle>,
    ) -> Self
```

**Purpose**: Constructs a new elicitation manager with empty pending-request state and initial policy/profile values. It also stores an optional reviewer hook.

**Data flow**: Consumes an `AskForApproval`, a `PermissionProfile`, and an optional `ElicitationReviewerHandle`; initializes an empty `HashMap` inside an async `Mutex`, wraps the policy, profile, and `auto_deny = false` in `Arc<StdMutex<_>>`, stores the reviewer, and returns the manager.

**Call relations**: Called by `McpConnectionManager::new`, `new_uninitialized_with_permission_profile`, and direct tests that exercise elicitation behavior without a full manager.

*Call graph*: called by 4 (new, new_uninitialized_with_permission_profile, disabled_permissions_auto_accept_elicitation_with_empty_form_schema, disabled_permissions_do_not_auto_accept_elicitation_with_requested_fields); 4 external calls (new, new, new, new).


##### `ElicitationRequestManager::auto_deny`  (lines 75–80)

```
fn auto_deny(&self) -> bool
```

**Purpose**: Returns the current blanket auto-deny flag for elicitation requests. Poisoned mutexes fall back to `false`.

**Data flow**: Locks `self.auto_deny`, copies the contained bool on success, and returns `false` if locking fails.

**Call relations**: Exposed through `McpConnectionManager::elicitations_auto_deny` for runtime inspection.

*Call graph*: called by 1 (elicitations_auto_deny).


##### `ElicitationRequestManager::set_auto_deny`  (lines 82–86)

```
fn set_auto_deny(&self, auto_deny: bool)
```

**Purpose**: Updates the blanket auto-deny flag controlling whether all future elicitation requests are immediately declined. Poisoned mutexes are ignored.

**Data flow**: Attempts to lock `self.auto_deny`, writes the provided bool into it on success, and returns unit.

**Call relations**: Exposed through `McpConnectionManager::set_elicitations_auto_deny` for runtime control.

*Call graph*: called by 1 (set_elicitations_auto_deny).


##### `ElicitationRequestManager::resolve`  (lines 88–101)

```
async fn resolve(
        &self,
        server_name: String,
        id: RequestId,
        response: ElicitationResponse,
    ) -> Result<()>
```

**Purpose**: Resolves a previously emitted elicitation request by removing its stored responder and sending the chosen response through the oneshot channel. It errors if the request is unknown or the receiver has gone away.

**Data flow**: Consumes `server_name`, `RequestId`, and `ElicitationResponse`, locks `self.requests`, removes the responder keyed by `(server_name, id)`, returns an `anyhow!` not-found error if absent, otherwise sends the response through the oneshot sender and maps send failure into an `anyhow!` error.

**Call relations**: Called by `McpConnectionManager::resolve_elicitation` after a user or reviewer decision arrives.

*Call graph*: called by 1 (resolve_elicitation).


##### `ElicitationRequestManager::make_sender`  (lines 103–231)

```
fn make_sender(
        &self,
        server_name: String,
        tx_event: Sender<Event>,
    ) -> SendElicitation
```

**Purpose**: Builds the RMCP-facing elicitation callback that applies policy, optional reviewer interception, event emission, and deferred response tracking. This is the core integration point between RMCP clients and Codex protocol events.

**Data flow**: Takes a `server_name` and event sender, clones shared state into a boxed async closure, and returns that closure. When invoked with a request ID and `CreateElicitationRequestParams`, the closure reads `auto_deny`; if true it returns a decline response. Otherwise it snapshots approval policy and permission profile, checks `mcp_permission_prompt_is_auto_approved` plus `can_auto_accept_elicitation` to possibly return an accept response with empty JSON content, checks `elicitation_is_rejected_by_policy` to possibly decline, optionally asks the reviewer and returns any reviewer-provided response, converts the RMCP elicitation into protocol-layer `ElicitationRequest::Form` or `::Url` by serializing metadata/schema as needed, creates a oneshot channel, stores the sender in the pending-request map under `(server_name.clone(), id.clone())`, emits an `EventMsg::ElicitationRequest` carrying a protocol `RequestId` converted from the RMCP numeric-or-string ID, then awaits the oneshot receiver and returns the eventual `ElicitationResponse` or a channel-closed error.

**Call relations**: This callback is handed to RMCP clients by higher-level startup code. It composes the helper functions `elicitation_is_rejected_by_policy` and `can_auto_accept_elicitation`, and it is the only place pending responders are inserted into the map later consumed by `resolve`.

*Call graph*: 1 external calls (new).


##### `elicitation_is_rejected_by_policy`  (lines 234–242)

```
fn elicitation_is_rejected_by_policy(approval_policy: AskForApproval) -> bool
```

**Purpose**: Determines whether the current approval policy should reject MCP elicitations outright. Only `Never` and granular configs that disallow MCP elicitations return true.

**Data flow**: Matches on `AskForApproval` and returns `true` for `Never`, `false` for `OnFailure`, `OnRequest`, and `UnlessTrusted`, and for `Granular` returns the negation of `granular_config.allows_mcp_elicitations()`.

**Call relations**: Used inside `make_sender` and directly by tests to document policy behavior.


##### `can_auto_accept_elicitation`  (lines 246–256)

```
fn can_auto_accept_elicitation(elicitation: &CreateElicitationRequestParams) -> bool
```

**Purpose**: Determines whether an elicitation is safe to auto-accept without user input. Only form elicitations with no schema properties qualify.

**Data flow**: Matches on `CreateElicitationRequestParams`; for `FormElicitationParams` it reads `requested_schema.properties.is_empty()` and returns that bool, while `UrlElicitationParams` always return `false`.

**Call relations**: Used by `make_sender` together with permission auto-approval checks to implement the empty-form fast path.


### Approval-specific MCP ingress
These adapters construct concrete MCP elicitation requests for execution and patch approvals, then translate client decisions back into Codex approval operations.

### `mcp-server/src/exec_approval.rs`

`domain_logic` · `request handling`

This file is the bridge between Codex’s internal execution-approval flow and the MCP client-facing elicitation protocol. It defines the exact JSON payload shape sent in `elicitation/create`: `ExecApprovalElicitRequestParams` includes the human-readable prompt text, an empty object schema in `requestedSchema`, and a set of Codex correlation fields such as `threadId`, tool call/event/call identifiers, the raw command vector, working directory, and parsed command structure. The companion `ExecApprovalResponse` expects only a `decision: ReviewDecision`, even though the comment notes this is not yet fully aligned with the MCP elicitation result schema.

The request path first renders a shell-safe display string with `shlex::try_join`, falling back to a plain space-joined command if escaping fails, then asks whether Codex may run that command in the given directory. Serialization failure is treated as a client-parameter problem and returned immediately as JSON-RPC `invalid_params`. On success, the file sends an outbound MCP request and receives a oneshot channel for the eventual response. Crucially, response handling is detached onto a Tokio task so the main message-processing loop never blocks waiting for user approval. The response path is conservative: if the oneshot is dropped, it logs and exits; if JSON deserialization fails, it synthesizes a denied decision; then it submits `Op::ExecApproval` back into the `CodexThread`, attaching the approval id and original event id as `turn_id`.

#### Function details

##### `handle_exec_approval_request`  (lines 51–110)

```
async fn handle_exec_approval_request(
    command: Vec<String>,
    cwd: PathBuf,
    outgoing: Arc<crate::outgoing_message::OutgoingMessageSender>,
    codex: Arc<CodexThread>,
    request_id: Reque
```

**Purpose**: Constructs the MCP `elicitation/create` request for an execution approval prompt and dispatches it to the client. It packages both user-visible text and Codex correlation metadata, then arranges asynchronous follow-up when the client responds.

**Data flow**: Inputs are the command vector, cwd, outgoing sender, Codex thread handle, JSON-RPC request id, tool/event/call/approval identifiers, parsed command list, and thread id. It derives an escaped command string, formats the approval message, fills an `ExecApprovalElicitRequestParams` struct, serializes it to `serde_json::Value`, and on success sends an outbound request through `OutgoingMessageSender::send_request`; on serialization failure it logs and emits `ErrorData::invalid_params` tied to the original request id. Its side effects are sending either an MCP error or an MCP request, and spawning a Tokio task that waits for the elicitation response.

**Call relations**: It is invoked from `run_codex_tool_session_inner` when a Codex tool session reaches an execution approval checkpoint. After sending the request, it delegates the eventual reply processing to `on_exec_approval_response` in a spawned task so the caller can continue servicing the agent loop without waiting on user input.

*Call graph*: calls 1 internal fn (on_exec_approval_response); called by 1 (run_codex_tool_session_inner); 8 external calls (invalid_params, clone, error!, format!, json!, to_value, try_join, spawn).


##### `on_exec_approval_response`  (lines 112–147)

```
async fn on_exec_approval_response(
    approval_id: String,
    event_id: String,
    receiver: tokio::sync::oneshot::Receiver<serde_json::Value>,
    codex: Arc<CodexThread>,
)
```

**Purpose**: Waits for the client’s elicitation reply, interprets it as an execution approval decision, and submits that decision back into the running Codex thread. If the reply is malformed, it denies by default.

**Data flow**: Inputs are the approval id, event id, a oneshot receiver carrying raw JSON, and the shared `CodexThread`. It awaits the receiver, logs and returns if the request channel failed, otherwise deserializes the JSON into `ExecApprovalResponse`; deserialization errors are logged and replaced with `ReviewDecision::Denied`. It then submits `Op::ExecApproval { id, turn_id: Some(event_id), decision }` to Codex, producing only logging side effects on failure and no return value.

**Call relations**: It is only launched by `handle_exec_approval_request` after an outbound `elicitation/create` request has been sent. Its sole downstream action is the `codex.submit(...)` call that resumes the internal approval workflow with the user’s decision.

*Call graph*: called by 1 (handle_exec_approval_request); 1 external calls (error!).


### `mcp-server/src/patch_approval.rs`

`domain_logic` · `request handling`

This file mirrors the execution-approval bridge but for proposed file modifications. `PatchApprovalElicitRequestParams` defines the exact request payload sent to the MCP client: a prompt message, empty `requestedSchema`, `threadId`, Codex correlation identifiers, optional `codex_reason`, optional `codex_grant_root`, and a `HashMap<PathBuf, FileChange>` describing the proposed edits. `PatchApprovalResponse` is the minimal expected reply shape containing only a `ReviewDecision`.

`handle_patch_approval_request` assembles a user-facing message from an optional reason plus the fixed question "Allow Codex to apply proposed code changes?". It uses the `call_id` itself as the approval id, serializes the full parameter struct, and if serialization fails sends a JSON-RPC `invalid_params` error tied to the original request id. Otherwise it sends an `elicitation/create` request through `OutgoingMessageSender` and spawns a detached task to await the response.

The response path is slightly stricter than exec approval: if the oneshot receiver fails, it not only logs the failure but also proactively submits `Op::PatchApproval { decision: Denied }` back to Codex so the pending approval cannot hang indefinitely. If deserialization fails, it again defaults to denial. On success, it submits the chosen decision to the `CodexThread`. This conservative-deny behavior is an important invariant: malformed or missing client replies never authorize file changes.

#### Function details

##### `handle_patch_approval_request`  (lines 44–101)

```
async fn handle_patch_approval_request(
    call_id: String,
    reason: Option<String>,
    grant_root: Option<PathBuf>,
    changes: HashMap<PathBuf, FileChange>,
    outgoing: Arc<OutgoingMessageSe
```

**Purpose**: Constructs the MCP `elicitation/create` request for patch approval and sends it to the client. It includes both the human prompt and the structured file-change payload Codex wants reviewed.

**Data flow**: Inputs are the call id, optional reason, optional grant root, map of changed files to `FileChange`, outgoing sender, Codex thread handle, original request id, tool call id, event id, and thread id. It derives `approval_id` from `call_id`, builds a multi-line message from the optional reason plus the fixed approval question, fills `PatchApprovalElicitRequestParams`, serializes it to JSON, and on failure logs and sends `ErrorData::invalid_params`. On success it sends `elicitation/create` via `OutgoingMessageSender::send_request` and spawns a Tokio task to await the reply.

**Call relations**: It is called by `run_codex_tool_session_inner` when Codex proposes applying code changes that require review. After dispatching the request, it delegates asynchronous completion to `on_patch_approval_response` so the main session loop remains responsive.

*Call graph*: calls 1 internal fn (on_patch_approval_response); called by 1 (run_codex_tool_session_inner); 8 external calls (invalid_params, new, clone, error!, format!, json!, to_value, spawn).


##### `on_patch_approval_response`  (lines 103–142)

```
async fn on_patch_approval_response(
    approval_id: String,
    receiver: tokio::sync::oneshot::Receiver<serde_json::Value>,
    codex: Arc<CodexThread>,
)
```

**Purpose**: Waits for the client’s patch-approval reply and submits the resulting decision to Codex, defaulting to denial on transport or decoding failure. It explicitly denies on dropped response channels to avoid leaving approvals unresolved.

**Data flow**: Inputs are the approval id, a oneshot receiver of raw JSON, and the shared `CodexThread`. It awaits the receiver; if that fails, it logs and submits `Op::PatchApproval { id: approval_id.clone(), decision: Denied }`, logging again if even that submission fails. If a JSON value arrives, it deserializes to `PatchApprovalResponse`, replacing decode failures with `Denied`, then submits `Op::PatchApproval { id: approval_id, decision }` to Codex. It returns unit and only emits logs on failure paths.

**Call relations**: It is spawned exclusively by `handle_patch_approval_request` after the outbound elicitation request is sent. Its downstream role is to resume the Codex patch workflow with an explicit allow/deny result, even when the client-side request path breaks.

*Call graph*: called by 1 (handle_patch_approval_request); 1 external calls (error!).
