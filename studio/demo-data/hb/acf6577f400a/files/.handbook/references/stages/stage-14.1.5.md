# Approval-mediated tool orchestration and approval UI  `stage-14.1.5`

This stage sits in the main work loop, whenever the assistant wants to do something that may affect the user’s machine or data. The core orchestrator is the traffic controller: it checks whether a tool needs permission, chooses a safety sandbox, runs the tool, and may ask again with broader access if the sandbox blocks it. MCP tool approval templates turn external tool-server requests into plain questions instead of raw names and JSON.

The terminal UI then makes those decisions visible. Approval events store requests in a safe displayable form, while the approval overlay shows the actual pop-up and sends back approve or deny. Tool requests puts these decisions into the chat screen. Permission popups and the permissions menu let users choose or change how much freedom the assistant has, including reviewing automatic denials. Auto-review denials keeps a recent list of blocked actions with readable labels. Pending thread approvals warns when background agent threads are waiting. Request user input handles structured questions and typed answers. Windows sandbox prompts guide Windows users through safe setup. Hooks RPC checks server-side hooks and records the user’s trust choices.

## Files in this stage

### Approval orchestration core
These files define the approval prompt content and drive the end-to-end runtime flow that decides when tool execution needs user approval or escalation.

### `core/src/mcp_tool_approval_templates.rs`

`domain_logic` · `request handling, with lazy template loading on first use`

Some MCP tools can do things that matter, like creating a calendar event or posting a comment. Before allowing that, the system may need to ask the user a clear permission question. This file is the small “message writer” for that approval step.

It loads a bundled JSON file of templates, checks that the file is in the expected format version, and keeps the templates ready for later use. When an approval is needed, it looks for an exact match by server name, connector id, and tool title. If it finds one, it fills in the template text. For example, it can replace `{connector_name}` with a readable name like “Calendar”.

It also prepares the tool parameters for display. Some parameters can be renamed with friendly labels, such as showing `calendar_id` as “Calendar”. Any leftover parameters are still shown, using their original names, so the user can see what the tool is about to do. The code is deliberately cautious: if the template is empty, the connector name is missing when needed, the parameters are not an object, or two displayed labels would collide, it returns no rendered template. That avoids showing confusing or misleading approval prompts.

#### Function details

##### `render_mcp_tool_approval_template`  (lines 53–69)

```
fn render_mcp_tool_approval_template(
    server_name: &str,
    connector_id: Option<&str>,
    connector_name: Option<&str>,
    tool_title: Option<&str>,
    tool_params: Option<&Value>,
) -> Optio
```

**Purpose**: This is the main entry point for producing an approval prompt from the bundled template list. A caller uses it when an MCP tool request needs a readable permission question for the user.

**Data flow**: It receives the server name, optional connector id and connector name, optional tool title, and optional tool parameters. It first reads the lazily loaded template list; if loading failed earlier, it stops and returns nothing. Otherwise, it passes all the request details and the loaded templates to the more detailed rendering function, then returns whatever rendered prompt that function produces.

**Call relations**: During the approval flow, `maybe_request_mcp_tool_approval` calls this function to ask, “Can we make a nice approval message for this tool call?” This function does not build the message itself; it hands the work to `render_mcp_tool_approval_template_from_templates` after making sure the shared bundled templates are available.

*Call graph*: calls 1 internal fn (render_mcp_tool_approval_template_from_templates); called by 1 (maybe_request_mcp_tool_approval).


##### `load_consequential_tool_message_templates`  (lines 71–92)

```
fn load_consequential_tool_message_templates() -> Option<Vec<ConsequentialToolMessageTemplate>>
```

**Purpose**: This function loads the built-in approval-message template file and checks that it matches the schema version this code understands. It protects the rest of the system from using malformed or outdated template data.

**Data flow**: It reads the bundled JSON file that is compiled into the program, tries to parse it into template records, and checks its schema version number. If parsing fails or the version is not the expected one, it logs a warning and returns nothing. If everything looks right, it returns the list of templates ready for rendering.

**Call relations**: This function is used by the lazy static template holder, so it runs only when the templates are first needed. It relies on the compile-time file inclusion helper to get the JSON contents and on warning logging to report bad template data without crashing the program.

*Call graph*: 2 external calls (include_str!, warn!).


##### `render_mcp_tool_approval_template_from_templates`  (lines 94–124)

```
fn render_mcp_tool_approval_template_from_templates(
    templates: &[ConsequentialToolMessageTemplate],
    server_name: &str,
    connector_id: Option<&str>,
    connector_name: Option<&str>,
    to
```

**Purpose**: This function does the real work of choosing the right approval template and turning it into a finished prompt. It is useful both in production, where it receives the bundled templates, and in tests, where small custom template lists are supplied.

**Data flow**: It receives a list of templates plus the details of one tool request. It requires a connector id and a non-empty tool title, then searches for a template whose server name, connector id, and tool title all match exactly. After finding one, it renders the question text and, if tool parameters are present, formats them for display. It returns a completed `RenderedMcpToolApprovalTemplate`, or returns nothing if any required piece is missing or unsafe to display.

**Call relations**: `render_mcp_tool_approval_template` calls this function after loading the shared templates. The rendering tests call it directly with hand-made templates so they can check exact behavior. Inside, it delegates text substitution to `render_question_template` and parameter display preparation to `render_tool_params`.

*Call graph*: calls 2 internal fn (render_question_template, render_tool_params); called by 3 (render_mcp_tool_approval_template, renders_exact_match_with_readable_param_labels, renders_literal_template_without_connector_substitution); 2 external calls (new, iter).


##### `render_question_template`  (lines 126–140)

```
fn render_question_template(template: &str, connector_name: Option<&str>) -> Option<String>
```

**Purpose**: This function turns a template sentence into the actual question text shown to the user. It supports one special placeholder, `{connector_name}`, for inserting a friendly connector name.

**Data flow**: It receives a template string and an optional connector name. It trims extra whitespace from the template and rejects it if it becomes empty. If the template contains `{connector_name}`, it also requires a non-empty connector name and replaces the placeholder with that name. If no replacement is needed, it returns the trimmed template as-is.

**Call relations**: `render_mcp_tool_approval_template_from_templates` calls this after it has selected the matching template. The result becomes both the approval question and the elicitation message in the rendered output.

*Call graph*: called by 1 (render_mcp_tool_approval_template_from_templates).


##### `render_tool_params`  (lines 142–190)

```
fn render_tool_params(
    tool_params: &Map<String, Value>,
    template_params: &[ConsequentialToolTemplateParam],
) -> Option<(Option<Value>, Vec<RenderedMcpToolApprovalParam>)>
```

**Purpose**: This function prepares the tool’s input parameters for display in the approval prompt. It gives selected parameters friendly labels while preserving all parameters so the user can review what will be sent.

**Data flow**: It receives the raw tool parameters as a JSON object and the template’s list of preferred parameter labels. It first walks through the preferred labels, adding matching parameters with their readable display names. It rejects empty labels and duplicate display names, because those could confuse the user. Then it adds any remaining parameters in sorted name order, using their original names as labels. It returns both the original parameter object and the ordered display list, or nothing if the display names would be ambiguous.

**Call relations**: `render_mcp_tool_approval_template_from_templates` calls this only when the incoming tool parameters are a JSON object. This function is the part that turns raw machine-facing parameter names into a safer, more readable checklist for the approval UI.

*Call graph*: called by 1 (render_mcp_tool_approval_template_from_templates); 6 external calls (new, clone, get, iter, Object, new).


##### `tests::renders_exact_match_with_readable_param_labels`  (lines 200–260)

```
fn renders_exact_match_with_readable_param_labels()
```

**Purpose**: This test proves the happy path: an exact template match produces a readable question and a display list with friendly parameter labels. It also checks that parameters not named in the template are still shown.

**Data flow**: It builds a small calendar template and a sample tool request with title, calendar id, and timezone. It sends that data into `render_mcp_tool_approval_template_from_templates`. The expected result is a completed approval template with “Calendar” and “Title” labels first, followed by the leftover `timezone` parameter.

**Call relations**: The test calls the lower-level rendering function directly instead of using the bundled file. That keeps the test focused on rendering behavior, while assertion and JSON helper macros provide the comparison data.

*Call graph*: calls 1 internal fn (render_mcp_tool_approval_template_from_templates); 3 external calls (assert_eq!, json!, vec!).


##### `tests::returns_none_when_no_exact_match_exists`  (lines 263–283)

```
fn returns_none_when_no_exact_match_exists()
```

**Purpose**: This test checks that the renderer refuses to use the wrong template. A similar template should not be used if the tool title does not match exactly.

**Data flow**: It creates a template for one calendar action, then asks for a different action. The expected before-to-after result is simple: the renderer is given mismatched input and should return nothing rather than a misleading approval prompt.

**Call relations**: This test exercises the exact-match rule used by the template selection flow. It uses assertions to confirm that a non-matching tool request does not produce a rendered message.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::returns_none_when_relabeling_would_collide`  (lines 286–312)

```
fn returns_none_when_relabeling_would_collide()
```

**Purpose**: This test checks a safety rule for parameter display names. If a friendly label would duplicate another parameter’s visible name, the renderer should reject the template instead of showing two confusing rows with the same label.

**Data flow**: It creates a template that renames `calendar_id` to `timezone`, while the actual tool parameters also contain a real `timezone` field. The renderer is expected to detect that the displayed names would collide and return nothing.

**Call relations**: This test is aimed at the duplicate-name protection inside `render_tool_params`, reached through the normal template-rendering path. The assertion confirms that ambiguous approval displays are not allowed.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::bundled_templates_load`  (lines 315–317)

```
fn bundled_templates_load()
```

**Purpose**: This test checks that the real bundled template file can be loaded successfully. It guards against shipping a broken JSON template file or one with the wrong schema version.

**Data flow**: It reads the shared lazy template holder and checks that it contains some loaded template data rather than failure. If the bundled file cannot be parsed or has the wrong version, this test would fail.

**Call relations**: This test indirectly exercises `load_consequential_tool_message_templates` through the lazy static template storage. It matters because production rendering depends on that bundled data being available.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::renders_literal_template_without_connector_substitution`  (lines 320–347)

```
fn renders_literal_template_without_connector_substitution()
```

**Purpose**: This test proves that templates without `{connector_name}` do not require a connector name. A fully written question like “Allow GitHub...” can be rendered as plain text.

**Data flow**: It builds a GitHub template whose text contains no placeholder and passes no connector name. The renderer should still return a completed approval prompt, with the literal question text and an empty parameter display list.

**Call relations**: The test calls `render_mcp_tool_approval_template_from_templates` directly to verify the branch handled by `render_question_template` where no substitution is needed. Assertions and JSON helpers check the exact rendered result.

*Call graph*: calls 1 internal fn (render_mcp_tool_approval_template_from_templates); 3 external calls (assert_eq!, json!, vec!).


##### `tests::returns_none_when_connector_placeholder_has_no_value`  (lines 350–370)

```
fn returns_none_when_connector_placeholder_has_no_value()
```

**Purpose**: This test checks that a template containing `{connector_name}` is not rendered unless a real connector name is available. That prevents showing the user a broken question with an unreplaced placeholder.

**Data flow**: It creates a calendar template that needs `{connector_name}` but passes no connector name. The expected output is nothing, because the renderer cannot safely complete the sentence.

**Call relations**: This test covers the failure path in `render_question_template`, reached through the normal template rendering flow. The assertion confirms that incomplete approval wording is rejected instead of displayed.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/tools/orchestrator.rs`

`orchestration` · `tool execution / request handling`

Tools in this project can do powerful things, such as running commands, changing files, or reaching the network. This file makes sure those actions happen only under the right safety rules. Without it, each tool would need to invent its own approval and sandbox behavior, which would make the system harder to trust and easier to get wrong.

The main type, ToolOrchestrator, works like a careful supervisor. First it checks whether the requested tool action is allowed, forbidden, or needs approval from a user, an automated reviewer called the guardian, or configured permission hooks. Then it picks a sandbox, which is a restricted environment that limits what the tool can touch. It also sets up network approval if the tool may try to connect outside the machine.

After that, it runs the tool once. If the tool succeeds, the result is returned. If the sandbox denies the action, the orchestrator decides whether a retry is allowed. For example, it may ask for fresh approval, explain that network access was blocked, and then retry with no sandbox or with an adjusted sandbox. It records telemetry, meaning diagnostic information about decisions and outcomes, so the system can later explain what happened.

#### Function details

##### `ToolOrchestrator::new`  (lines 55–59)

```
fn new() -> Self
```

**Purpose**: Creates a new ToolOrchestrator with its own SandboxManager, the component that knows how to choose and run sandbox types. Callers use this when they are about to run a tool through the shared approval-and-sandbox flow.

**Data flow**: It takes no input. It creates a fresh sandbox manager and stores it inside a new ToolOrchestrator. The output is a ready-to-use orchestrator object.

**Call relations**: Higher-level tool paths create this before running tool work, such as normal tool calls, exec-like commands, apply-patch interception, session setup with sandboxing, and tests around full-access behavior. After construction, the caller usually hands the orchestrator a tool request through ToolOrchestrator::run.

*Call graph*: calls 1 internal fn (new); called by 5 (danger_full_access_tool_attempts_do_not_enforce_managed_network, handle_call, intercept_apply_patch, run_exec_like, open_session_with_sandbox).


##### `ToolOrchestrator::run_attempt`  (lines 61–130)

```
async fn run_attempt(
        tool: &mut T,
        req: &Rq,
        tool_ctx: &ToolCtx,
        attempt: &SandboxAttempt<'_>,
        managed_network_active: bool,
    ) -> (Result<Out, ToolError>,
```

**Purpose**: Runs one single attempt of a tool under a specific sandbox setup. It also wraps that attempt with network approval tracking, so network access can be allowed, denied, cancelled, or finalized cleanly.

**Data flow**: It receives the tool, the tool request, the current tool context, the chosen sandbox attempt, and whether managed network control is active. It asks the tool what kind of network approval it may need, starts that approval process, adds any network cancellation token into the sandbox attempt, and then calls the tool’s own run method. After the run, it finalizes immediate network approvals right away, or returns a deferred network approval if the successful result still needs later completion. The output is the tool result plus an optional deferred network approval.

**Call relations**: ToolOrchestrator::run calls this for the first sandboxed attempt and, if needed, again for an escalated retry. This function hands off the actual work to the tool’s run implementation, while using the network approval helpers to begin and finish approval bookkeeping around that work.

*Call graph*: calls 3 internal fn (begin_network_approval, finish_deferred_network_approval, finish_immediate_network_approval); 2 external calls (network_approval_spec, run).


##### `ToolOrchestrator::run`  (lines 132–482)

```
async fn run(
        &mut self,
        tool: &mut T,
        req: &Rq,
        tool_ctx: &ToolCtx,
        turn_ctx: &crate::session::turn_context::TurnContext,
        approval_policy: AskForApprov
```

**Purpose**: Runs the full safe-tool workflow from beginning to end: approval, sandbox selection, first attempt, possible retry, and telemetry. This is the main entry for code that wants a tool executed under the project’s safety rules.

**Data flow**: It receives a mutable tool, the tool request, tool and turn context, and the approval policy for the session. It reads sandbox policies, network policy, permission settings, feature flags, workspace roots, and telemetry from the turn context. It decides whether approval is required, asks hooks, the guardian, or the user if needed, builds the first sandbox attempt, and runs it. If the first attempt succeeds, it returns the tool output and any deferred network approval. If the sandbox denies the attempt, it decides whether retrying is allowed, may request approval again, builds a retry attempt with broader permissions or a different sandbox, and runs the tool again. It returns success with output or a ToolError explaining rejection, sandbox denial, timeout, or another failure.

**Call relations**: This is the central story that brings together most of the file. Callers use it when a tool call must be executed. It calls ToolOrchestrator::request_approval to ask permission, ToolOrchestrator::reject_if_not_approved to turn non-approval into a clear error, ToolOrchestrator::run_attempt to do each actual execution attempt, and the two small helper functions to report sandbox outcomes and build a retry reason.

*Call graph*: calls 9 internal fn (file_system_sandbox_policy, network_sandbox_policy, flat_tool_name, build_denial_reason_from_output, sandbox_outcome_from_tool_error, sandbox_override_for_first_attempt, unsandboxed_execution_allowed, select_initial, from_abs_path); 18 external calls (now, reject_if_not_approved, request_approval, run_attempt, escalate_on_failure, exec_approval_requirement, sandbox_cwd, sandbox_permissions, sandbox_preference, should_bypass_approval (+8 more)).


##### `ToolOrchestrator::request_approval`  (lines 487–549)

```
async fn request_approval(
        tool: &mut T,
        req: &Rq,
        permission_request_run_id: &str,
        approval_ctx: ApprovalCtx<'_>,
        tool_ctx: &ToolCtx,
        evaluate_permissi
```

**Purpose**: Asks for permission to run or retry a tool action. It gives configured permission hooks the first chance to answer, then falls back to the normal user or guardian approval path.

**Data flow**: It receives the tool, the request, an identifier for this permission request, approval context, tool context, a flag saying whether hooks should be checked, and telemetry. If hooks are enabled and the tool can describe its permission request, it runs those hooks. A hook can allow the action, deny it with a message, or stay silent. If no hook decides, the function asks the tool to start its normal approval flow. It records where the decision came from, then returns the review decision or a rejection error.

**Call relations**: ToolOrchestrator::run calls this before the first attempt when approval is required, and again before an escalated retry when needed. It hands off to run_permission_request_hooks for configured automatic decisions, or to the tool’s start_approval_async method for the usual guardian or user prompt.

*Call graph*: calls 3 internal fn (run_permission_request_hooks, flat_tool_name, tool_decision); 3 external calls (permission_request_payload, start_approval_async, Rejected).


##### `ToolOrchestrator::reject_if_not_approved`  (lines 551–578)

```
async fn reject_if_not_approved(
        tool_ctx: &ToolCtx,
        guardian_review_id: Option<&str>,
        decision: ReviewDecision,
    ) -> Result<(), ToolError>
```

**Purpose**: Turns an approval decision into either permission to continue or a clear rejection error. It centralizes how denied, aborted, timed-out, and network-policy decisions are interpreted.

**Data flow**: It receives the tool context, an optional guardian review id, and the review decision. If the decision means approval, it returns success. If the decision means denial or abort, it builds a human-readable reason, using a guardian-specific rejection message when the guardian was involved or a simple user rejection message otherwise. If the decision timed out, it returns the standard guardian timeout message. For network policy changes, it allows an allow amendment and rejects a deny amendment.

**Call relations**: ToolOrchestrator::run calls this immediately after asking for approval. This keeps the main run flow simple: request a decision, then use this function to stop the tool unless the decision is good enough to continue.

*Call graph*: 3 external calls (Rejected, guardian_rejection_message, guardian_timeout_message).


##### `sandbox_outcome_from_tool_error`  (lines 581–588)

```
fn sandbox_outcome_from_tool_error(err: &ToolError) -> Option<&'static str>
```

**Purpose**: Converts certain sandbox-related errors into short outcome labels for telemetry. These labels help the system record whether the sandbox denied, timed out, or was interrupted by a signal.

**Data flow**: It receives a ToolError. If the error is a sandbox denial, timeout, or signal, it returns a matching text label. If the error is a user rejection or another kind of Codex error, it returns nothing because there is no sandbox outcome to record.

**Call relations**: ToolOrchestrator::run calls this when an attempt fails. If it gets a label back, it passes that label into telemetry so later diagnostics can show how the sandbox behaved.

*Call graph*: called by 1 (run).


##### `build_denial_reason_from_output`  (lines 590–594)

```
fn build_denial_reason_from_output(_output: &ExecToolCallOutput) -> String
```

**Purpose**: Builds the short message used when asking whether to retry after a sandbox denial. Today it deliberately returns a simple stable phrase rather than trying to explain every detail of the failed command output.

**Data flow**: It receives the failed command output, but does not inspect it yet. It returns the fixed message: "command failed; retry without sandbox?" This keeps user-facing wording predictable while leaving room for smarter reasoning later.

**Call relations**: ToolOrchestrator::run calls this when the first sandboxed attempt is denied for a non-network reason and the system is preparing an approval prompt for a retry. The returned text becomes the retry reason shown through the approval path.

*Call graph*: called by 1 (run).


### Approval event shaping
These files normalize incoming approval-related signals and maintain compact summaries that the UI can render or reference later.

### `tui/src/approval_events.rs`

`data_model` · `request handling`

When the assistant wants to run a command or apply a patch, the TUI may need to pause and ask the user for permission. That question can arrive while other output is still streaming, so the TUI needs a stable, self-contained record of what is being requested. This file provides those records.

`ExecApprovalRequestEvent` describes a request to run a command. It stores the command, the working directory, the reason, optional permission changes, and the choices the user may be offered. If the server does not explicitly provide the choices, this file can infer sensible defaults. For example, a network-related request may offer “allow once,” “allow for this session,” or “add a network rule,” while a normal command may offer “accept,” “accept with a command policy change,” or “cancel.”

`ApplyPatchApprovalRequestEvent` describes a request to apply file changes. Besides the request identifiers and reason, it carries a map of paths to `FileChange` display data, so the TUI can show the user what would change before asking for approval.

In short, this file is like a form template for permission prompts: it gathers the fields the TUI needs, fills in missing defaults, and keeps the prompt understandable even if it is shown later.

#### Function details

##### `ExecApprovalRequestEvent::effective_approval_id`  (lines 45–49)

```
fn effective_approval_id(&self) -> String
```

**Purpose**: This gives the TUI one reliable identifier to use for an execution approval. If the newer explicit approval ID is present, it uses that; otherwise it falls back to the older command call ID.

**Data flow**: It reads the approval request's optional `approval_id` and required `call_id`. If `approval_id` has a value, it returns a copy of it. If not, it returns a copy of `call_id`, so callers always get a usable string.

**Call relations**: Other TUI code can call this when it needs to track, queue, or answer an approval request without caring which identifier style the app server used. It does not hand work off to another helper; it simply chooses the best available ID.


##### `ExecApprovalRequestEvent::effective_available_decisions`  (lines 51–61)

```
fn effective_available_decisions(&self) -> Vec<CommandExecutionApprovalDecision>
```

**Purpose**: This returns the list of approval choices the user should be shown for a command request. It respects choices sent by the server, but can also build a default list when the server leaves them out.

**Data flow**: It looks at the request's `available_decisions`. If that field already contains choices, it returns a copy of them. If it is missing, it gathers the request's network context, proposed command policy change, proposed network policy changes, and extra permission profile, then passes those pieces to `default_available_decisions`; the result is returned as the final choice list.

**Call relations**: This is the convenient entry point for code that renders or processes an execution approval prompt. It delegates the fallback rules to `ExecApprovalRequestEvent::default_available_decisions`, keeping callers from having to repeat the decision-building logic.

*Call graph*: 1 external calls (default_available_decisions).


##### `ExecApprovalRequestEvent::default_available_decisions`  (lines 63–106)

```
fn default_available_decisions(
        network_approval_context: Option<&NetworkApprovalContext>,
        proposed_execpolicy_amendment: Option<&ExecPolicyAmendment>,
        proposed_network_policy_
```

**Purpose**: This builds a sensible default set of approval choices based on what kind of permission is being requested. It prevents the TUI from showing an empty or inappropriate prompt when the server did not send an explicit choice list.

**Data flow**: It receives optional context about network access, command policy changes, network policy changes, and additional permissions. If network approval is involved, it starts with temporary approval choices, adds a network-policy-amendment choice when there is an allow-rule amendment available, and ends with cancel. If additional permissions are involved, it offers only accept or cancel. Otherwise, it offers accept, optionally adds an accept-with-command-policy-change choice, and then adds cancel. The output is a vector of approval decision values.

**Call relations**: This helper is called by `ExecApprovalRequestEvent::effective_available_decisions` when an approval request does not already include its own choices. It is the central place where the TUI's fallback approval menu is assembled.

*Call graph*: 1 external calls (vec!).


### `tui/src/auto_review_denials.rs`

`domain_logic` · `request handling`

When the system automatically reviews an action and decides it should not be allowed, the terminal interface needs a simple way to remember and display that denial. This file is that small memory box. It stores only denied review events, keeps the newest ones first, removes older duplicates with the same review ID, and limits the list to ten items so the UI does not grow cluttered or waste memory. Think of it like a “recently blocked” shelf that always puts the newest item at the front and throws away anything beyond the tenth slot.

The main type, `RecentAutoReviewDenials`, wraps a queue, which is a list designed for adding and removing items efficiently at either end. Its methods let the UI add a new denial, ask whether there are any denials, look through the current list, or remove one specific denial once it has been dealt with.

The file also includes `action_summary`, which converts different kinds of reviewed actions into short text. For example, a shell command becomes the command text, a patch becomes a note about touched files, and network access becomes a phrase naming the target. This keeps UI messages compact and understandable.

#### Function details

##### `RecentAutoReviewDenials::push`  (lines 15–23)

```
fn push(&mut self, event: GuardianAssessmentEvent)
```

**Purpose**: Adds a newly reported review event to the recent-denials list, but only if the event was actually denied. It also keeps the list clean by removing any older entry with the same ID and keeping only the ten newest denials.

**Data flow**: It receives one review event. If the event is not marked as denied, nothing changes. If it is denied, the existing list is first filtered to remove any event with the same ID, then the new event is placed at the front, and finally anything beyond the ten most recent entries is dropped.

**Call relations**: This is the entry point for feeding review results into this small store. Internally it relies on standard list operations to remove duplicates, put the newest denial first, and trim the list to its fixed size.

*Call graph*: 3 external calls (push_front, retain, truncate).


##### `RecentAutoReviewDenials::is_empty`  (lines 25–27)

```
fn is_empty(&self) -> bool
```

**Purpose**: Answers whether there are currently any recent denied review events. A caller can use this to decide whether there is anything worth showing in the UI.

**Data flow**: It reads the stored queue of denial events and returns a true-or-false answer: true if there are no entries, false if at least one denial is stored. It does not change the list.

**Call relations**: This is a small helper for code that wants to check the store before displaying or processing it. It delegates the actual check to the underlying queue.

*Call graph*: 1 external calls (is_empty).


##### `RecentAutoReviewDenials::entries`  (lines 29–31)

```
fn entries(&self) -> impl Iterator<Item = &GuardianAssessmentEvent>
```

**Purpose**: Lets other code read through the current denial events in order, without taking ownership of them or changing the list. The newest denial appears first because of how `push` stores entries.

**Data flow**: It reads the internal queue and returns an iterator, which is a step-by-step reader over the stored events. The caller receives references to the events, while the original list stays unchanged.

**Call relations**: UI code can call this when it needs to render the recent denials. It hands out a safe view over the queue by using the queue’s built-in iteration behavior.

*Call graph*: 1 external calls (iter).


##### `RecentAutoReviewDenials::take`  (lines 33–36)

```
fn take(&mut self, id: &str) -> Option<GuardianAssessmentEvent>
```

**Purpose**: Finds and removes one stored denial by its ID. This is useful when a specific denial has been acknowledged, selected, or otherwise no longer needs to stay in the recent list.

**Data flow**: It receives an ID string. It searches the stored events for the first entry whose ID matches. If it finds one, it removes that event from the queue and returns it; if not, it returns nothing and leaves the list unchanged.

**Call relations**: This function is the counterpart to `entries`: after code has identified a particular denial, it can call `take` to pull that exact event out of the store. It uses the queue’s iterator to find the position and the queue’s remove operation to extract it.

*Call graph*: 2 external calls (iter, remove).


##### `action_summary`  (lines 39–75)

```
fn action_summary(action: &GuardianAssessmentAction) -> String
```

**Purpose**: Turns a reviewed action into a short label that a person can quickly understand. It is used to describe what the automated reviewer denied, such as a command, a patch, network access, or a permission request.

**Data flow**: It receives a `GuardianAssessmentAction`, which represents the kind of action that was reviewed. It checks which kind of action it is and builds a plain text summary from the important fields, such as the command text, program arguments, file count, network target, tool name, or permission reason. It returns that summary as a string.

**Call relations**: This function sits between detailed protocol data and the terminal display. For executable actions it tries to quote command arguments safely using shell-style joining, and if that fails it falls back to simply joining the words with spaces. Other action types are formatted directly into concise UI text.

*Call graph*: 3 external calls (format!, try_join, vec!).


##### `tests::denied_event`  (lines 86–104)

```
fn denied_event(id: usize) -> GuardianAssessmentEvent
```

**Purpose**: Builds a sample denied review event for tests. It gives each sample a predictable ID, rationale, and command so tests can check ordering and storage behavior clearly.

**Data flow**: It receives a number and uses it to create fields like `review-3`, `rationale 3`, and a matching shell command. It fills in the rest of the review event with fixed test values and returns a complete denied event object.

**Call relations**: The test `tests::keeps_only_ten_most_recent_denials` calls this helper repeatedly to create realistic denial events. The helper keeps the test focused on the behavior being checked instead of repeating event-building details.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `tests::keeps_only_ten_most_recent_denials`  (lines 107–132)

```
fn keeps_only_ten_most_recent_denials()
```

**Purpose**: Checks that the recent-denials store keeps exactly the ten newest denied events and orders them from newest to oldest. This protects the main behavior of the file from accidental changes.

**Data flow**: It starts with an empty `RecentAutoReviewDenials` store, creates twelve denied events, and pushes them in order. It then reads back the stored IDs and compares them with the expected list, which should contain only reviews 11 through 2 in descending order.

**Call relations**: This test exercises `RecentAutoReviewDenials::push` and `RecentAutoReviewDenials::entries` through the public behavior of the type. It uses `tests::denied_event` to create the inputs and an assertion to confirm the final stored order.

*Call graph*: 3 external calls (assert_eq!, default, denied_event).


### Approval and input overlays
These bottom-pane components present the main interactive approval and structured-response surfaces, plus lightweight visibility for pending approvals elsewhere.

### `tui/src/bottom_pane/approval_overlay.rs`

`domain_logic` · `request handling`

This file is the safety checkpoint for high-risk actions in the terminal interface. When the agent asks to run a command, change files, grant extra permissions, or answer an MCP elicitation request (a request from an external tool/server for user input), this overlay shows a small list of options like “Yes, proceed” or “No, cancel.” Without it, the app would either have no clear way to ask the user or might lose important decisions.

The main type, ApprovalOverlay, is like a ticket counter. It shows one approval request at a time, keeps later requests in a queue, and moves to the next ticket after the current one is answered or dismissed. It also listens for keyboard shortcuts, including custom key bindings, and routes the answer to the app through AppEventSender.

The file also carefully formats what the user sees. It can show the command, the reason for the request, the source thread, permission rules, or the server message. It records some decisions in the chat history so the user can see what they approved or denied. One important rule is that pressing Escape always cancels MCP elicitation prompts; it must never accidentally mean “continue without the requested information.”

#### Function details

##### `ApprovalRequest::thread_id`  (lines 109–116)

```
fn thread_id(&self) -> ThreadId
```

**Purpose**: Returns the conversation thread that owns this approval request. This lets the overlay send the final decision back to the right agent thread.

**Data flow**: It reads the stored thread identifier from whichever kind of approval request it is. It returns that identifier unchanged.

**Call relations**: Other overlay code uses this when it needs to send a decision or open the source thread. It is the common way to avoid duplicating thread lookup logic for every request type.


##### `ApprovalRequest::thread_label`  (lines 118–125)

```
fn thread_label(&self) -> Option<&str>
```

**Purpose**: Returns the optional human-readable label for the thread that produced the request. This is used when a request comes from a different visible thread and the UI should say where it came from.

**Data flow**: It looks inside the request, finds the optional label, and returns it as borrowed text if present. It does not change the request.

**Call relations**: The footer hint uses this to decide whether to show an “open thread” shortcut. Other decision-handling code also uses it to decide whether to write a decision into the current history.

*Call graph*: called by 1 (approval_footer_hint).


##### `ApprovalRequest::matches_resolved_request`  (lines 127–154)

```
fn matches_resolved_request(&self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Checks whether an approval request is the same one as a request that the app server says has already been resolved. This prevents stale pop-ups from staying on screen.

**Data flow**: It compares the identifying fields for matching request kinds: command id, permission call id, file-change id, or MCP server/request id. It returns true only when both the kind and identity match.

**Call relations**: The overlay uses this while dismissing resolved requests from either the current prompt or the queue. It is the matching rule that lets external resolution close the right prompt without sending a new denial.


##### `ApprovalOverlay::new`  (lines 172–193)

```
fn new(
        request: ApprovalRequest,
        app_event_tx: AppEventSender,
        features: Features,
        approval_keymap: ApprovalKeymap,
        list_keymap: ListKeymap,
    ) -> Self
```

**Purpose**: Creates a new approval overlay for the first request. It prepares the list view, key maps, feature flags, and initial set of choices.

**Data flow**: It receives the request, event sender, feature settings, and keyboard mappings. It builds an empty overlay shell, then installs the request as the current prompt and returns the ready-to-render overlay.

**Call relations**: Higher-level app code calls this when an approval prompt needs to appear. It immediately delegates to the current-request setup path so construction and later queue advancement use the same display-building logic.

*Call graph*: calls 1 internal fn (new); called by 4 (maybe_show_delayed_approval_requests_at, push_approval_request, apply_patch_prompt_with_thread_label_omits_command_line, make_overlay_with_keymap); 4 external calls (default, new, clone, clone).


##### `ApprovalOverlay::enqueue_request`  (lines 195–197)

```
fn enqueue_request(&mut self, req: ApprovalRequest)
```

**Purpose**: Adds another approval request behind the one currently being shown. This lets several risky actions wait their turn instead of replacing each other.

**Data flow**: It receives a request and pushes it into the overlay's queue. Nothing is sent to the app yet, and the current prompt stays unchanged.

**Call relations**: The bottom-pane integration calls this through try_consume_approval_request when a prompt is already open. The queued request will be displayed later by the queue advancement path.

*Call graph*: called by 1 (try_consume_approval_request).


##### `ApprovalOverlay::dismiss_resolved_request`  (lines 199–214)

```
fn dismiss_resolved_request(&mut self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Removes a request that was resolved somewhere else, such as by the server or another part of the app. This avoids showing a question that no longer needs an answer.

**Data flow**: It receives a resolved-request identity, removes matching queued requests, and checks whether the current request also matches. If the current one matches, it marks it complete and moves on; it returns whether anything was removed.

**Call relations**: The BottomPaneView method dismiss_app_server_request calls this. If it dismisses the active prompt, it uses advance_queue to either show the next pending request or close the overlay.

*Call graph*: calls 1 internal fn (advance_queue); called by 1 (dismiss_app_server_request).


##### `ApprovalOverlay::set_current`  (lines 216–230)

```
fn set_current(&mut self, request: ApprovalRequest)
```

**Purpose**: Makes a request the active prompt and rebuilds everything the user sees for it. This is used both for the first request and for queued follow-up requests.

**Data flow**: It takes an approval request, builds its header text, builds the available options and list parameters, stores the request and options, and replaces the list selection view.

**Call relations**: Creation and queue advancement both rely on this function. It hands off formatting to build_header and choice construction to build_options so each request type gets the right UI.

*Call graph*: calls 2 internal fn (build_header, new); called by 1 (advance_queue); 3 external calls (build_options, clone, clone).


##### `ApprovalOverlay::build_options`  (lines 232–300)

```
fn build_options(
        request: &ApprovalRequest,
        header: Box<dyn Renderable>,
        _features: &Features,
        approval_keymap: &ApprovalKeymap,
        list_keymap: &ListKeymap,
```

**Purpose**: Turns a request into the selectable rows and title shown in the approval modal. It decides which choices make sense for commands, permissions, file edits, and MCP elicitation.

**Data flow**: It reads the request type, current key bindings, and header. It creates approval options, wraps the title and header into a renderable block, builds list items with shortcuts, and returns both the internal options and list-view settings.

**Call relations**: set_current calls this whenever a prompt is shown. It delegates to specialized option builders, then packages their results for ListSelectionView.

*Call graph*: calls 6 internal fn (approval_footer_hint, elicitation_options, exec_options, patch_options, permissions_options, with); 4 external calls (new, default, from, format!).


##### `ApprovalOverlay::apply_selection`  (lines 302–347)

```
fn apply_selection(&mut self, actual_idx: usize)
```

**Purpose**: Applies the option the user picked from the list or by shortcut. This is where a highlighted choice becomes an actual approval, denial, or cancel message.

**Data flow**: It receives an option index, ignores it if the prompt is already finished or invalid, matches the option's decision to the current request type, sends the corresponding response, marks the request complete, and advances the queue.

**Call relations**: Keyboard handling and shortcut handling both call this after the user chooses something. It routes to the specific decision sender for command, permission, patch, or MCP requests.

*Call graph*: calls 5 internal fn (advance_queue, handle_elicitation_decision, handle_exec_decision, handle_patch_decision, handle_permissions_decision); called by 2 (handle_key_event, try_handle_shortcut).


##### `ApprovalOverlay::handle_exec_decision`  (lines 349–386)

```
fn handle_exec_decision(
        &self,
        id: &str,
        command: &[String],
        decision: CommandExecutionApprovalDecision,
    )
```

**Purpose**: Sends the user's decision about running a command. It may also add a history note so the user can later see what they approved or denied.

**Data flow**: It reads the current request, command, id, and chosen command decision. It builds a history entry when appropriate, then sends an exec approval response for the correct thread.

**Call relations**: apply_selection calls this for command choices, and cancel_current_request calls it when a command prompt is aborted. It uses helper functions to describe network approvals and translate decisions into history wording.

*Call graph*: calls 5 internal fn (exec_approval, send, command_decision_to_review_decision, network_approval_command_target, network_approval_target); called by 2 (apply_selection, cancel_current_request); 3 external calls (InsertHistoryCell, new_approval_decision_cell, Command).


##### `ApprovalOverlay::handle_permissions_decision`  (lines 388–436)

```
fn handle_permissions_decision(
        &self,
        call_id: &str,
        permissions: &RequestPermissionProfile,
        decision: PermissionsDecision,
    )
```

**Purpose**: Sends the user's answer to a request for extra permissions. It converts friendly choices like “this turn” or “this session” into the permission response the agent protocol expects.

**Data flow**: It receives the call id, requested permission profile, and chosen permission decision. It either clones the requested permissions or replaces them with empty permissions, decides the scope and strict-review flag, optionally writes a history note, and sends the response.

**Call relations**: apply_selection calls this for permission choices, and cancel_current_request calls it as a denial. It is the bridge between UI labels and the protocol-level permission response.

*Call graph*: calls 3 internal fn (request_permissions_response, send, new); called by 2 (apply_selection, cancel_current_request); 6 external calls (new, default, clone, InsertHistoryCell, matches!, vec!).


##### `ApprovalOverlay::handle_patch_decision`  (lines 438–448)

```
fn handle_patch_decision(&self, id: &str, decision: FileChangeApprovalDecision)
```

**Purpose**: Sends the user's decision about applying file changes. This tells the agent whether it may proceed with the proposed edits.

**Data flow**: It reads the current request's thread id, combines it with the file-change request id and chosen decision, and sends a patch approval response. It changes no local display state itself.

**Call relations**: apply_selection calls this when the user chooses a patch option. cancel_current_request calls it with a cancel decision if the prompt is aborted.

*Call graph*: calls 1 internal fn (patch_approval); called by 2 (apply_selection, cancel_current_request).


##### `ApprovalOverlay::handle_elicitation_decision`  (lines 450–471)

```
fn handle_elicitation_decision(
        &self,
        server_name: &str,
        request_id: &RequestId,
        decision: McpServerElicitationAction,
    )
```

**Purpose**: Sends the user's answer to an MCP elicitation prompt. MCP elicitation is when an external server asks the app to get approval or information from the user.

**Data flow**: It reads the current thread id and receives the server name, request id, and chosen action. It sends a resolve-elicitation event with no extra content or metadata.

**Call relations**: apply_selection calls this for MCP choices, and cancel_current_request calls it with Cancel. The special Escape behavior eventually reaches this path as a cancel decision.

*Call graph*: calls 1 internal fn (resolve_elicitation); called by 2 (apply_selection, cancel_current_request); 1 external calls (clone).


##### `ApprovalOverlay::advance_queue`  (lines 473–479)

```
fn advance_queue(&mut self)
```

**Purpose**: Moves from the just-finished request to the next waiting request. If nothing is waiting, it marks the overlay as done.

**Data flow**: It pops one request from the queue if available. If there is one, it becomes the new current prompt; otherwise the overlay's done flag becomes true.

**Call relations**: Selection and external dismissal both call this after a request is finished. It reuses set_current so each queued prompt is rebuilt the same way as the first prompt.

*Call graph*: calls 1 internal fn (set_current); called by 2 (apply_selection, dismiss_resolved_request).


##### `ApprovalOverlay::cancel_current_request`  (lines 481–525)

```
fn cancel_current_request(&mut self)
```

**Purpose**: Cancels the active request and closes the whole overlay. This is used for Ctrl-C and cancel shortcuts.

**Data flow**: It checks whether the overlay is already done. If not, and the current request has not been answered, it sends the safest negative response for that request type, clears all queued requests, and marks the overlay done.

**Call relations**: Shortcut handling and Ctrl-C handling call this. It routes cancellation through the same decision-sending helpers used by normal selections, so the app still receives an explicit answer.

*Call graph*: calls 4 internal fn (handle_elicitation_decision, handle_exec_decision, handle_patch_decision, handle_permissions_decision); called by 2 (on_ctrl_c, try_handle_shortcut).


##### `ApprovalOverlay::try_handle_shortcut`  (lines 531–566)

```
fn try_handle_shortcut(&mut self, key_event: &KeyEvent) -> bool
```

**Purpose**: Handles approval-specific keyboard shortcuts before normal list navigation. This catches actions such as opening fullscreen, opening the source thread, canceling, or choosing a row by shortcut key.

**Data flow**: It receives a key event, checks it against approval and list key maps, sends UI events for fullscreen or thread switching when needed, cancels if the cancel binding is pressed, or applies the matching option. It returns whether it consumed the key.

**Call relations**: handle_key_event calls this first. If it returns false, the key is passed to the generic list view for navigation or Enter selection.

*Call graph*: calls 3 internal fn (send, apply_selection, cancel_current_request); called by 1 (handle_key_event); 2 external calls (FullScreenApprovalRequest, SelectAgentThread).


##### `ApprovalOverlay::handle_key_event`  (lines 570–578)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Processes one key press while the approval overlay is active. It decides whether the key is a special approval shortcut or ordinary list navigation.

**Data flow**: It receives a key event. First it gives shortcuts a chance to act; if none do, it forwards the key to the list view, then checks whether the list produced a selected index and applies that selection.

**Call relations**: The terminal UI calls this through the BottomPaneView interface. It ties together shortcut handling, list behavior, and final decision routing.

*Call graph*: calls 4 internal fn (apply_selection, try_handle_shortcut, handle_key_event, take_last_selected_index).


##### `ApprovalOverlay::on_ctrl_c`  (lines 580–583)

```
fn on_ctrl_c(&mut self) -> CancellationEvent
```

**Purpose**: Handles Ctrl-C while an approval prompt is open. It treats Ctrl-C as an explicit cancellation rather than letting the request hang.

**Data flow**: It cancels the current request and returns a value saying the cancellation was handled. The overlay state becomes complete and queued requests are cleared.

**Call relations**: The bottom-pane framework calls this for Ctrl-C. It delegates the actual work to cancel_current_request so all cancel paths behave consistently.

*Call graph*: calls 1 internal fn (cancel_current_request).


##### `ApprovalOverlay::is_complete`  (lines 585–587)

```
fn is_complete(&self) -> bool
```

**Purpose**: Reports whether the overlay is finished and can be removed from the bottom pane.

**Data flow**: It reads the overlay's done flag and returns it as a boolean. It does not change state.

**Call relations**: The surrounding UI uses this to know when to stop showing the approval modal after a selection, cancellation, or external dismissal.


##### `ApprovalOverlay::try_consume_approval_request`  (lines 589–595)

```
fn try_consume_approval_request(
        &mut self,
        request: ApprovalRequest,
    ) -> Option<ApprovalRequest>
```

**Purpose**: Accepts a new approval request while this overlay is already open. Instead of opening a second modal, it queues the request.

**Data flow**: It receives a request, appends it to the queue, and returns None to signal that the request was consumed by this overlay.

**Call relations**: The bottom-pane system calls this when another approval arrives. It delegates to enqueue_request and lets advance_queue show it later.

*Call graph*: calls 1 internal fn (enqueue_request).


##### `ApprovalOverlay::dismiss_app_server_request`  (lines 597–599)

```
fn dismiss_app_server_request(&mut self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Lets the app dismiss a prompt when the server reports that the request has already been resolved. This keeps the UI in sync with external state.

**Data flow**: It receives a resolved request description and passes it to the overlay's dismissal logic. It returns whether the overlay or its queue changed.

**Call relations**: This is the BottomPaneView-facing wrapper around dismiss_resolved_request. It exists so the general bottom-pane machinery can use the overlay's request-matching behavior.

*Call graph*: calls 1 internal fn (dismiss_resolved_request).


##### `ApprovalOverlay::terminal_title_requires_action`  (lines 601–603)

```
fn terminal_title_requires_action(&self) -> bool
```

**Purpose**: Tells the terminal title system that this overlay represents something waiting for the user's action. This can help draw attention to the terminal.

**Data flow**: It always returns true. It reads no request details and changes no state.

**Call relations**: The UI framework calls this through BottomPaneView while the overlay is active. It marks approval prompts as attention-worthy.


##### `ApprovalOverlay::desired_height`  (lines 607–609)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Asks how much vertical space the overlay wants to draw itself. This lets the bottom pane size the modal correctly.

**Data flow**: It receives the available width and forwards that width to the internal list view. It returns the list view's desired height.

**Call relations**: Rendering helpers and the UI layout call this before drawing. The overlay delegates sizing to ListSelectionView because that view owns the actual rows and header layout.

*Call graph*: calls 1 internal fn (desired_height); called by 1 (render_overlay_lines).


##### `ApprovalOverlay::render`  (lines 611–613)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the approval overlay into the terminal buffer. It shows the title, header, choices, and footer hint prepared earlier.

**Data flow**: It receives a screen area and buffer, then asks the internal list view to render into that space. It does not decide new approval logic while drawing.

**Call relations**: The UI renderer and tests call this when the overlay needs to appear. It delegates drawing to ListSelectionView.

*Call graph*: calls 1 internal fn (render); called by 1 (render_overlay_lines).


##### `ApprovalOverlay::cursor_pos`  (lines 615–617)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Reports where the cursor should appear, if the overlay needs one. This keeps cursor behavior aligned with the internal list view.

**Data flow**: It receives the drawing area, asks the list view for a cursor position, and returns that optional position.

**Call relations**: The rendering framework calls this through the Renderable interface. The overlay does not calculate cursor placement itself.

*Call graph*: 1 external calls (cursor_pos).


##### `approval_footer_hint`  (lines 620–643)

```
fn approval_footer_hint(
    request: &ApprovalRequest,
    approval_keymap: &ApprovalKeymap,
    list_keymap: &ListKeymap,
) -> Line<'static>
```

**Purpose**: Builds the small instruction line at the bottom of the approval modal. It explains which keys confirm, cancel, and sometimes open the source thread.

**Data flow**: It reads the request and key maps, starts with the standard confirm/cancel hint, and adds an open-thread hint if the request has a thread label. It returns a line of styled text.

**Call relations**: build_options calls this while preparing the list view. It uses ApprovalRequest::thread_label to decide whether the extra thread hint belongs.

*Call graph*: calls 3 internal fn (thread_label, accept_cancel_hint_line, primary_binding); called by 1 (build_options); 1 external calls (from).


##### `network_approval_target`  (lines 645–660)

```
fn network_approval_target(
    network_approval_context: &NetworkApprovalContext,
    command: &[String],
) -> String
```

**Purpose**: Creates a human-readable target for a network approval history entry. It prefers the exact target encoded in a command when present, otherwise it builds one from protocol and host.

**Data flow**: It receives network context and the command. It checks for a special network-access command format, and if none is found, combines protocol and host into text such as an HTTPS URL.

**Call relations**: handle_exec_decision uses this when recording a structured network approval. It relies on network_approval_command_target for the special command shortcut.

*Call graph*: calls 1 internal fn (network_approval_command_target); called by 1 (handle_exec_decision); 1 external calls (format!).


##### `network_approval_command_target`  (lines 662–672)

```
fn network_approval_command_target(command: &[String]) -> Option<&str>
```

**Purpose**: Detects whether a command is really a network-access request and extracts its target. This helps the history say “network access to X” instead of showing an internal command.

**Data flow**: It examines the command arguments. If they match either a two-part network-access command or one combined string, it returns the target text; otherwise it returns nothing.

**Call relations**: handle_exec_decision and network_approval_target call this before deciding how to describe an approval. It keeps the special parsing in one place.

*Call graph*: called by 2 (handle_exec_decision, network_approval_target).


##### `build_header`  (lines 674–800)

```
fn build_header(request: &ApprovalRequest) -> Box<dyn Renderable>
```

**Purpose**: Builds the explanatory content shown above the approval choices. It tells the user what is being requested and why.

**Data flow**: It reads the request type and fields such as thread label, reason, command, permissions, and server message. It formats those into renderable terminal text, including syntax-highlighted command text when appropriate.

**Call relations**: set_current calls this before building options. It delegates permission-rule wording to formatting helpers and command display to shell-formatting/highlighting helpers.

*Call graph*: calls 5 internal fn (format_additional_permissions_rule, format_requested_permissions_rule, strip_bash_lc_and_escape, highlight_bash_to_lines, with); called by 1 (set_current); 7 external calls (new, from, from_iter, new, from, new, vec!).


##### `command_decision_to_review_decision`  (lines 825–844)

```
fn command_decision_to_review_decision(
    decision: &CommandExecutionApprovalDecision,
) -> ReviewDecision
```

**Purpose**: Translates command approval decisions into the wording category used by history cells. This keeps protocol decisions and user-facing history labels connected.

**Data flow**: It receives a command decision and maps it to a review decision such as approved, approved for session, denied, or aborted. Some decisions carry policy amendments through into the history form.

**Call relations**: handle_exec_decision calls this when creating a history entry. It is not responsible for sending the actual approval response.

*Call graph*: called by 1 (handle_exec_decision).


##### `exec_options`  (lines 846–932)

```
fn exec_options(
    available_decisions: &[CommandExecutionApprovalDecision],
    network_approval_context: Option<&NetworkApprovalContext>,
    additional_permissions: Option<&AdditionalPermissionPr
```

**Purpose**: Builds the list of choices for a command execution request. The labels change depending on whether the request is about normal execution, network access, session approval, or policy changes.

**Data flow**: It receives the allowed protocol decisions, optional network context, optional extra permissions, and key map. It filters and converts each allowed decision into a label, internal decision value, and shortcut list.

**Call relations**: build_options calls this for command approvals. Several tests call it directly to lock down the exact labels and hidden-option behavior.

*Call graph*: called by 4 (build_options, additional_permissions_exec_options_hide_execpolicy_amendment, generic_exec_options_can_offer_allow_for_session, network_exec_options_use_expected_labels_and_hide_execpolicy_amendment); 1 external calls (iter).


##### `format_additional_permissions_rule`  (lines 934–983)

```
fn format_additional_permissions_rule(
    additional_permissions: &AdditionalPermissionProfile,
) -> Option<String>
```

**Purpose**: Turns an additional-permissions profile into a short readable rule line. This helps users understand what extra access they are about to grant.

**Data flow**: It reads network and file-system permission entries, groups them into phrases like network, read paths, write paths, and deny read paths, then joins those phrases. It returns nothing if there is no meaningful permission to show.

**Call relations**: build_header uses this for command requests with extra permissions. format_requested_permissions_rule also calls it after converting a request-style permission profile.

*Call graph*: calls 1 internal fn (format_file_system_entry_paths); called by 2 (build_header, format_requested_permissions_rule); 2 external calls (new, format!).


##### `format_requested_permissions_rule`  (lines 985–996)

```
fn format_requested_permissions_rule(
    permissions: &RequestPermissionProfile,
) -> Option<String>
```

**Purpose**: Formats a permission request into the same readable rule style used for additional permissions. It first converts the request format into a grant format.

**Data flow**: It receives a requested permission profile, converts it into a granted-permission profile, wraps it as additional permissions, and passes it to the shared formatter. It returns an optional text rule.

**Call relations**: build_header calls this for standalone permission prompts. It reuses format_additional_permissions_rule so both prompt types describe permissions consistently.

*Call graph*: calls 2 internal fn (granted_permission_profile_from_request, format_additional_permissions_rule); called by 1 (build_header); 1 external calls (clone).


##### `format_file_system_entry_paths`  (lines 998–1009)

```
fn format_file_system_entry_paths(
    entries: impl Iterator<Item = &'a FileSystemSandboxEntry>,
) -> String
```

**Purpose**: Formats file-system sandbox entries into readable path labels. It supports normal paths, glob patterns, and special built-in locations.

**Data flow**: It receives an iterator of file-system entries, converts each entry's path into display text, and joins the pieces with commas. It returns one string.

**Call relations**: format_additional_permissions_rule calls this separately for read, write, and denied-read entries. It uses special_path_label for non-normal paths.

*Call graph*: called by 1 (format_additional_permissions_rule); 1 external calls (map).


##### `special_path_label`  (lines 1011–1020)

```
fn special_path_label(value: &FileSystemSpecialPath) -> String
```

**Purpose**: Turns a special file-system location into a label that users can recognize. Examples include workspace roots, temporary directories, and root access.

**Data flow**: It receives a special-path enum value and returns a text label. For values with subpaths, it uses path_label to append the subpath cleanly.

**Call relations**: format_file_system_entry_paths uses this when an entry is not a literal path or glob. It keeps special sandbox names from leaking as raw protocol details.

*Call graph*: calls 1 internal fn (path_label).


##### `path_label`  (lines 1022–1027)

```
fn path_label(base: &str, subpath: &Option<PathBuf>) -> String
```

**Purpose**: Combines a base special-path label with an optional subpath. This avoids duplicated string-building for labels like workspace roots plus “.git”.

**Data flow**: It receives a base string and optional path. If a subpath exists, it appends it with a slash; otherwise it returns the base alone.

**Call relations**: special_path_label calls this for special paths that may include a subpath. It is a small formatting helper.

*Call graph*: called by 1 (special_path_label); 1 external calls (format!).


##### `patch_options`  (lines 1029–1047)

```
fn patch_options(keymap: &ApprovalKeymap) -> Vec<ApprovalOption>
```

**Purpose**: Builds the choices for approving proposed file edits. The choices allow one-time approval, session approval for those files, or cancellation.

**Data flow**: It receives the approval key map and returns a fixed list of ApprovalOption values with labels, file-change decisions, and shortcuts.

**Call relations**: build_options calls this for ApplyPatch requests. The resulting choices are later interpreted by apply_selection and sent through handle_patch_decision.

*Call graph*: called by 1 (build_options); 1 external calls (vec!).


##### `permissions_options`  (lines 1049–1081)

```
fn permissions_options(keymap: &ApprovalKeymap) -> Vec<ApprovalOption>
```

**Purpose**: Builds the choices for granting or denying extra permissions. It includes turn-only, turn with strict auto review, session-wide, and denial choices.

**Data flow**: It receives the approval key map, removes plain Escape from the deny shortcuts, and returns the permission options with their labels and shortcut bindings.

**Call relations**: build_options calls this for permission requests, and tests call it directly to verify labels. The Escape filtering helps keep cancel behavior separate from “deny and continue.”

*Call graph*: called by 2 (build_options, permissions_options_use_expected_labels); 1 external calls (vec!).


##### `elicitation_options`  (lines 1090–1122)

```
fn elicitation_options(keymap: &ApprovalKeymap) -> Vec<ApprovalOption>
```

**Purpose**: Builds the choices for MCP elicitation prompts while preserving a strict safety rule: Escape always means cancel. This prevents accidental continuation when the user meant to dismiss.

**Data flow**: It receives the approval key map, starts cancel shortcuts with Escape, adds configured cancel shortcuts, removes any overlap from decline shortcuts, and returns accept, decline, and cancel options.

**Call relations**: build_options calls this for MCP elicitation requests. Shortcut handling later uses these options so Escape reliably routes to handle_elicitation_decision with Cancel.

*Call graph*: called by 1 (build_options); 1 external calls (vec!).


##### `tests::absolute_path`  (lines 1141–1143)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Creates an absolute path value for tests. It keeps test setup short and ensures invalid relative paths fail immediately.

**Data flow**: It receives a path string, parses it as an absolute path, and returns the typed absolute path. If the test passes a non-absolute path, it panics.

**Call relations**: Many tests and snapshot helpers use this when building permission or patch requests. It is test-only setup support.

*Call graph*: calls 1 internal fn (from_absolute_path).


##### `tests::render_overlay_lines`  (lines 1145–1159)

```
fn render_overlay_lines(view: &ApprovalOverlay, width: u16) -> String
```

**Purpose**: Renders an approval overlay into plain text lines for snapshot tests. This lets tests compare what the user would see.

**Data flow**: It receives an overlay and width, asks the overlay for its height, renders it into a fake terminal buffer, trims line endings, and returns one newline-separated string.

**Call relations**: Snapshot tests call this to verify prompt layout. It exercises the same desired_height and render methods used by the real UI.

*Call graph*: calls 2 internal fn (desired_height, render); 2 external calls (empty, new).


##### `tests::render_history_cell_lines`  (lines 1161–1174)

```
fn render_history_cell_lines(
        cell: &dyn crate::history_cell::HistoryCell,
        width: u16,
    ) -> Vec<String>
```

**Purpose**: Converts a history cell into plain strings for assertions. This makes history rendering easy to compare in tests.

**Data flow**: It receives a history cell and width, asks the cell for display lines, joins each line's spans into plain text, and returns a vector of strings.

**Call relations**: History-focused tests use this to check approval decision messages. It sits between rich terminal text and simple test assertions.

*Call graph*: 1 external calls (display_lines).


##### `tests::normalize_snapshot_paths`  (lines 1176–1185)

```
fn normalize_snapshot_paths(rendered: String) -> String
```

**Purpose**: Replaces machine-specific absolute path display text with stable test strings. This keeps snapshots from changing across systems.

**Data flow**: It receives rendered text, replaces known absolute-path renderings with fixed path strings, and returns the normalized text.

**Call relations**: Snapshot tests for permission prompts use this after rendering. It depends on absolute_path to construct the path values being normalized.

*Call graph*: 1 external calls (absolute_path).


##### `tests::make_overlay`  (lines 1187–1200)

```
fn make_overlay(
        request: ApprovalRequest,
        app_event_tx: AppEventSender,
        features: Features,
    ) -> ApprovalOverlay
```

**Purpose**: Builds an approval overlay for tests using the default runtime key map. This avoids repeating setup in every test.

**Data flow**: It receives a request, event sender, and feature flags, fetches default key maps, and returns an overlay built through the keymap-aware helper.

**Call relations**: Most overlay tests call this. It delegates to make_overlay_with_keymap so tests that need custom shortcuts can share the same construction path.

*Call graph*: calls 1 internal fn (defaults); 1 external calls (make_overlay_with_keymap).


##### `tests::make_overlay_with_keymap`  (lines 1202–1216)

```
fn make_overlay_with_keymap(
        request: ApprovalRequest,
        app_event_tx: AppEventSender,
        features: Features,
        approval_keymap: ApprovalKeymap,
        list_keymap: ListKeyma
```

**Purpose**: Builds an approval overlay for tests with custom approval and list key maps. This is used when a test needs to change shortcuts.

**Data flow**: It receives the request, event sender, feature flags, and key maps, then calls ApprovalOverlay::new and returns the result.

**Call relations**: Shortcut-customization tests call this directly, while make_overlay calls it with defaults. It is the test bridge to the real constructor.

*Call graph*: calls 1 internal fn (new).


##### `tests::make_exec_request`  (lines 1218–1232)

```
fn make_exec_request() -> ApprovalRequest
```

**Purpose**: Creates a standard command approval request for tests. It gives tests a simple reusable request with an echo command and approve/cancel choices.

**Data flow**: It creates a new thread id and fills an Exec approval request with fixed ids, command text, reason, and decisions. It returns the request.

**Call relations**: Many tests use this as their baseline prompt. Tests that need special command behavior build custom requests instead.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


##### `tests::make_permissions_request`  (lines 1234–1251)

```
fn make_permissions_request() -> ApprovalRequest
```

**Purpose**: Creates a standard permissions request for tests. It asks for network access plus read and write file-system roots.

**Data flow**: It creates a new thread id, builds a permission profile with test paths, and returns a Permissions approval request with a reason.

**Call relations**: Permission behavior tests use this helper so they can focus on shortcut and response behavior rather than setup details.

*Call graph*: calls 2 internal fn (from_read_write_roots, new); 1 external calls (vec!).


##### `tests::make_elicitation_request`  (lines 1253–1261)

```
fn make_elicitation_request() -> ApprovalRequest
```

**Purpose**: Creates a standard MCP elicitation request for tests. It represents a test server asking for more information.

**Data flow**: It creates a new thread id and returns an MCP elicitation request with fixed server name, request id, and message.

**Call relations**: MCP cancellation and shortcut tests use this request. It keeps those tests focused on Escape and decline/cancel behavior.

*Call graph*: calls 1 internal fn (new); 1 external calls (String).


##### `tests::ctrl_c_aborts_and_clears_queue`  (lines 1264–1272)

```
fn ctrl_c_aborts_and_clears_queue()
```

**Purpose**: Checks that Ctrl-C cancels the active approval and removes queued approvals. This protects against leaving hidden pending requests after an abort.

**Data flow**: It creates an overlay, queues another request, triggers Ctrl-C behavior, and asserts the queue is empty and the overlay is complete.

**Call relations**: The test runner calls this. It exercises on_ctrl_c, which delegates to cancel_current_request.

*Call graph*: calls 2 internal fn (with_defaults, new); 4 external calls (assert!, assert_eq!, make_exec_request, make_overlay).


##### `tests::configured_list_cancel_aborts_exec_approval`  (lines 1275–1303)

```
fn configured_list_cancel_aborts_exec_approval()
```

**Purpose**: Verifies that a custom list cancel key cancels a command approval. This ensures user-configured cancel bindings still send an explicit abort.

**Data flow**: It sets the cancel key to q, opens an exec prompt, sends q, then reads emitted events and checks that the command decision was Cancel.

**Call relations**: The test runner calls this. It drives handle_key_event through try_handle_shortcut and then checks the app event output.

*Call graph*: calls 3 internal fn (with_defaults, new, defaults); 7 external calls (Char, new, assert!, assert_eq!, make_exec_request, make_overlay_with_keymap, vec!).


##### `tests::configured_list_cancel_cancels_mcp_elicitation`  (lines 1306–1334)

```
fn configured_list_cancel_cancels_mcp_elicitation()
```

**Purpose**: Verifies that a custom list cancel key cancels an MCP elicitation request. This keeps elicitation dismissal safe under custom key bindings.

**Data flow**: It sets the list cancel key to q, opens an MCP prompt, sends q, and checks that the emitted resolve-elicitation decision is Cancel.

**Call relations**: The test runner calls this. It covers the cancel path from key handling to handle_elicitation_decision.

*Call graph*: calls 3 internal fn (with_defaults, new, defaults); 7 external calls (Char, new, assert!, assert_eq!, make_elicitation_request, make_overlay_with_keymap, vec!).


##### `tests::shortcut_triggers_selection`  (lines 1337–1352)

```
fn shortcut_triggers_selection()
```

**Purpose**: Checks that an approval shortcut chooses an option and emits an approval operation. This confirms shortcut selection works without pressing Enter.

**Data flow**: It opens a standard exec prompt, sends the y key, drains events, and asserts that a thread operation was emitted.

**Call relations**: The test runner calls this. It exercises try_handle_shortcut and apply_selection.

*Call graph*: calls 2 internal fn (with_defaults, new); 6 external calls (Char, new, assert!, matches!, make_exec_request, make_overlay).


##### `tests::deny_shortcut_submits_denied_exec_decision`  (lines 1355–1391)

```
fn deny_shortcut_submits_denied_exec_decision()
```

**Purpose**: Checks that the deny shortcut submits a decline decision for command execution. This protects the meaning of the deny key.

**Data flow**: It builds an exec prompt with accept and decline choices, sends the deny key, and asserts the emitted exec approval decision is Decline.

**Call relations**: The test runner calls this. It verifies the option produced by exec_options is correctly routed by apply_selection.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 6 external calls (Char, new, assert!, assert_eq!, make_overlay, vec!).


##### `tests::network_deny_shortcut_submits_policy_deny_decision`  (lines 1394–1447)

```
fn network_deny_shortcut_submits_policy_deny_decision()
```

**Purpose**: Checks that a network policy deny option can be selected by the deny shortcut. This confirms “block this host in the future” is wired correctly.

**Data flow**: It builds a network approval request with a deny policy amendment, sends the deny key, and checks the emitted command decision contains that amendment.

**Call relations**: The test runner calls this. It covers exec_options label/shortcut construction and handle_exec_decision routing.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 6 external calls (Char, new, assert!, assert_eq!, make_overlay, vec!).


##### `tests::resolved_request_dismisses_overlay_without_emitting_abort`  (lines 1450–1468)

```
fn resolved_request_dismisses_overlay_without_emitting_abort()
```

**Purpose**: Verifies that externally resolved requests close the overlay without sending a new cancel or denial. This avoids double-answering a request.

**Data flow**: It opens an exec prompt, dismisses it with a matching resolved request, checks the overlay is complete, and checks no approval event was emitted.

**Call relations**: The test runner calls this. It exercises dismiss_app_server_request and the matching logic in dismiss_resolved_request.

*Call graph*: calls 2 internal fn (with_defaults, new); 3 external calls (assert!, make_exec_request, make_overlay).


##### `tests::o_opens_source_thread_for_cross_thread_approval`  (lines 1471–1500)

```
fn o_opens_source_thread_for_cross_thread_approval()
```

**Purpose**: Checks that the open-thread shortcut selects the thread that created a cross-thread approval. This helps users inspect the context before deciding.

**Data flow**: It creates a labeled request, sends the open-thread key, and asserts that a SelectAgentThread event with the right thread id was emitted.

**Call relations**: The test runner calls this. It exercises the open-thread branch in try_handle_shortcut.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 5 external calls (Char, new, assert_eq!, make_overlay, vec!).


##### `tests::configured_open_thread_shortcut_opens_source_thread`  (lines 1503–1541)

```
fn configured_open_thread_shortcut_opens_source_thread()
```

**Purpose**: Verifies that a customized open-thread shortcut is honored and the old default key no longer works. This protects user keymap customization.

**Data flow**: It changes the open-thread key to x, sends the old key and expects no event, then sends x and expects a thread-selection event.

**Call relations**: The test runner calls this. It uses make_overlay_with_keymap to test try_handle_shortcut with custom bindings.

*Call graph*: calls 4 internal fn (with_defaults, new, new, defaults); 5 external calls (Char, new, assert!, make_overlay_with_keymap, vec!).


##### `tests::cross_thread_footer_hint_mentions_o_shortcut`  (lines 1544–1569)

```
fn cross_thread_footer_hint_mentions_o_shortcut()
```

**Purpose**: Checks that a cross-thread approval shows the open-thread hint in the footer. This makes the shortcut discoverable to users.

**Data flow**: It creates a labeled exec request, renders the overlay, and compares the output to a stored snapshot.

**Call relations**: The test runner calls this. It indirectly exercises approval_footer_hint through build_options and rendering.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 3 external calls (assert_snapshot!, make_overlay, vec!).


##### `tests::exec_prefix_option_emits_execpolicy_amendment`  (lines 1572–1621)

```
fn exec_prefix_option_emits_execpolicy_amendment()
```

**Purpose**: Checks that selecting the command-prefix approval option sends the expected execution-policy amendment. This supports “do not ask again for commands starting with this.”

**Data flow**: It builds an exec request with an amendment option, sends its shortcut, and asserts the emitted exec approval contains the same amendment.

**Call relations**: The test runner calls this. It covers exec_options construction and apply_selection routing.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 6 external calls (Char, new, assert!, assert_eq!, make_overlay, vec!).


##### `tests::network_deny_forever_shortcut_is_not_bound`  (lines 1624–1660)

```
fn network_deny_forever_shortcut_is_not_bound()
```

**Purpose**: Checks that the deny shortcut is not accidentally active when the network prompt only offers allow-style options and cancel. This prevents hidden choices from firing.

**Data flow**: It builds a network approval without a deny amendment, sends the deny key, and asserts no approval event was emitted.

**Call relations**: The test runner calls this. It guards the shortcut assignment produced by exec_options.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 5 external calls (Char, new, assert!, make_overlay, vec!).


##### `tests::header_includes_command_snippet`  (lines 1663–1701)

```
fn header_includes_command_snippet()
```

**Purpose**: Verifies that normal command approvals show the command in the prompt header. Users need to see what they are approving.

**Data flow**: It builds an exec request, renders the overlay, converts the buffer to strings, and checks for the command text.

**Call relations**: The test runner calls this. It exercises build_header and render.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 5 external calls (empty, new, assert!, make_overlay, vec!).


##### `tests::network_exec_options_use_expected_labels_and_hide_execpolicy_amendment`  (lines 1704–1737)

```
fn network_exec_options_use_expected_labels_and_hide_execpolicy_amendment()
```

**Purpose**: Checks the labels for network approval choices and ensures command-prefix policy wording is not shown there. Network prompts should talk about hosts, not shell command prefixes.

**Data flow**: It calls exec_options with a network context and compares the produced labels to the expected list.

**Call relations**: The test runner calls this. It directly verifies exec_options behavior.

*Call graph*: calls 2 internal fn (exec_options, defaults); 1 external calls (assert_eq!).


##### `tests::generic_exec_options_can_offer_allow_for_session`  (lines 1740–1762)

```
fn generic_exec_options_can_offer_allow_for_session()
```

**Purpose**: Checks that normal command approvals can offer a session-wide approval choice. This confirms the generic command wording is correct.

**Data flow**: It calls exec_options without network or extra-permission context and compares the labels to expected generic command labels.

**Call relations**: The test runner calls this. It directly protects exec_options label text.

*Call graph*: calls 2 internal fn (exec_options, defaults); 1 external calls (assert_eq!).


##### `tests::additional_permissions_exec_options_hide_execpolicy_amendment`  (lines 1765–1795)

```
fn additional_permissions_exec_options_hide_execpolicy_amendment()
```

**Purpose**: Checks the command prompt labels when extra permissions are involved. It ensures the options stay focused on proceeding or canceling for that request shape.

**Data flow**: It builds an additional-permissions profile, calls exec_options, and compares the labels to the expected output.

**Call relations**: The test runner calls this. It directly verifies exec_options for permission-related command prompts.

*Call graph*: calls 3 internal fn (from_read_write_roots, exec_options, defaults); 2 external calls (assert_eq!, vec!).


##### `tests::permissions_options_use_expected_labels`  (lines 1798–1813)

```
fn permissions_options_use_expected_labels()
```

**Purpose**: Checks the visible labels for permission approval choices. This guards wording that users depend on to understand scope.

**Data flow**: It builds permission options from the default key map, extracts labels, and compares them to the expected list.

**Call relations**: The test runner calls this. It directly verifies permissions_options.

*Call graph*: calls 2 internal fn (permissions_options, defaults); 1 external calls (assert_eq!).


##### `tests::additional_permissions_rule_shows_non_path_file_system_entries`  (lines 1816–1844)

```
fn additional_permissions_rule_shows_non_path_file_system_entries()
```

**Purpose**: Checks that permission-rule formatting handles special paths and glob patterns. This ensures non-standard sandbox entries are still understandable.

**Data flow**: It creates additional file-system permissions with root and glob entries, formats them, and compares the result to expected text.

**Call relations**: The test runner calls this. It covers format_additional_permissions_rule and the path-formatting helpers.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::additional_permissions_rule_uses_workspace_roots_label`  (lines 1847–1869)

```
fn additional_permissions_rule_uses_workspace_roots_label()
```

**Purpose**: Checks that workspace-root special paths are labeled clearly, including subpaths. This avoids exposing confusing internal names.

**Data flow**: It creates a permission entry for workspace roots plus .git, formats it, and compares the output to the expected label.

**Call relations**: The test runner calls this. It covers special_path_label and path_label through the permission formatter.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::permissions_session_shortcut_submits_session_scope`  (lines 1872–1895)

```
fn permissions_session_shortcut_submits_session_scope()
```

**Purpose**: Verifies that the session approval shortcut sends a session-scoped permission response. This protects the difference between one-turn and whole-session grants.

**Data flow**: It opens a permission prompt, sends the session shortcut, reads emitted events, and checks the response scope is Session.

**Call relations**: The test runner calls this. It exercises permissions_options, apply_selection, and handle_permissions_decision.

*Call graph*: calls 2 internal fn (with_defaults, new); 6 external calls (Char, new, assert!, assert_eq!, make_overlay, make_permissions_request).


##### `tests::permissions_deny_shortcut_uses_deny_keymap`  (lines 1898–1932)

```
fn permissions_deny_shortcut_uses_deny_keymap()
```

**Purpose**: Checks that permission denial uses the configured deny shortcut and sends empty permissions. This confirms custom deny bindings are respected.

**Data flow**: It changes the deny shortcut to x, opens a permission prompt, sends x, and checks the emitted response has no permissions, turn scope, and no strict review.

**Call relations**: The test runner calls this. It verifies permissions_options shortcut filtering and handle_permissions_decision denial behavior.

*Call graph*: calls 3 internal fn (with_defaults, new, defaults); 8 external calls (Char, new, new, assert!, assert_eq!, make_overlay_with_keymap, make_permissions_request, vec!).


##### `tests::permissions_strict_auto_review_shortcut_submits_turn_scope_with_strict_review`  (lines 1935–1959)

```
fn permissions_strict_auto_review_shortcut_submits_turn_scope_with_strict_review()
```

**Purpose**: Checks that the strict auto review option sends a turn-scoped grant with the strict flag set. This protects a more cautious approval mode.

**Data flow**: It opens a permission prompt, sends r, reads the emitted response, and asserts the scope is Turn and strict auto review is true.

**Call relations**: The test runner calls this. It exercises the special permission option built by permissions_options.

*Call graph*: calls 2 internal fn (with_defaults, new); 6 external calls (Char, new, assert!, assert_eq!, make_overlay, make_permissions_request).


##### `tests::additional_permissions_prompt_shows_permission_rule_line`  (lines 1962–2015)

```
fn additional_permissions_prompt_shows_permission_rule_line()
```

**Purpose**: Verifies that command prompts requesting extra permissions show a permission-rule line. This makes extra access visible before approval.

**Data flow**: It builds an exec request with network and file-system permissions, renders it, and checks the output contains the permission rule and network text.

**Call relations**: The test runner calls this. It exercises build_header and format_additional_permissions_rule.

*Call graph*: calls 4 internal fn (with_defaults, from_read_write_roots, new, new); 5 external calls (empty, new, assert!, make_overlay, vec!).


##### `tests::additional_permissions_prompt_snapshot`  (lines 2018–2051)

```
fn additional_permissions_prompt_snapshot()
```

**Purpose**: Snapshot-tests the full prompt for a command that asks for extra permissions. This catches accidental layout or wording changes.

**Data flow**: It builds an extra-permissions exec request, renders the overlay, normalizes paths, and compares against a snapshot.

**Call relations**: The test runner calls this. It covers the combined path through make_overlay, build_header, option building, and rendering.

*Call graph*: calls 4 internal fn (with_defaults, from_read_write_roots, new, new); 3 external calls (assert_snapshot!, make_overlay, vec!).


##### `tests::permissions_prompt_snapshot`  (lines 2054–2062)

```
fn permissions_prompt_snapshot()
```

**Purpose**: Snapshot-tests the standalone permissions prompt. This protects the visual layout and wording of permission requests.

**Data flow**: It builds a standard permissions request, renders the overlay with stable paths, and compares the result to a snapshot.

**Call relations**: The test runner calls this. It uses make_permissions_request and render_overlay_lines.

*Call graph*: calls 2 internal fn (with_defaults, new); 3 external calls (assert_snapshot!, make_overlay, make_permissions_request).


##### `tests::apply_patch_prompt_with_thread_label_omits_command_line`  (lines 2065–2095)

```
fn apply_patch_prompt_with_thread_label_omits_command_line()
```

**Purpose**: Checks that apply-patch prompts with a source thread show the thread label and do not show a fake command line. This keeps file-edit prompts focused on edits, not internal mechanics.

**Data flow**: It builds a patch request with a thread label, renders the overlay, and asserts the thread hint is present while an apply_patch command line is absent.

**Call relations**: The test runner calls this. It directly constructs ApprovalOverlay and exercises build_header and approval_footer_hint for patch requests.

*Call graph*: calls 5 internal fn (with_defaults, new, new, new, defaults); 5 external calls (new, from, assert!, absolute_path, render_overlay_lines).


##### `tests::network_exec_prompt_title_includes_host`  (lines 2098–2155)

```
fn network_exec_prompt_title_includes_host()
```

**Purpose**: Verifies that network approval prompts name the host and hide the underlying command line. Users are approving network access, not a generic shell command.

**Data flow**: It builds a network exec request, renders the overlay, snapshots the buffer, and checks for the host title while checking command and command-policy wording are absent.

**Call relations**: The test runner calls this. It exercises build_options title selection, build_header's network behavior, and rendering.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 6 external calls (empty, new, assert!, assert_snapshot!, make_overlay, vec!).


##### `tests::ctrl_shift_a_opens_fullscreen`  (lines 2158–2176)

```
fn ctrl_shift_a_opens_fullscreen()
```

**Purpose**: Checks that the fullscreen approval shortcut emits the fullscreen request event. This lets users inspect a request in more space.

**Data flow**: It opens a standard exec prompt, sends Ctrl-Shift-A, drains events, and asserts a FullScreenApprovalRequest event appeared.

**Call relations**: The test runner calls this. It exercises the fullscreen branch in try_handle_shortcut.

*Call graph*: calls 2 internal fn (with_defaults, new); 6 external calls (Char, new, assert!, matches!, make_exec_request, make_overlay).


##### `tests::exec_history_cell_wraps_with_two_space_indent`  (lines 2179–2207)

```
fn exec_history_cell_wraps_with_two_space_indent()
```

**Purpose**: Checks that long command approval history messages wrap with a readable indent. This keeps history entries tidy in narrow terminals.

**Data flow**: It creates an approval decision history cell for a long command, renders it at a narrow width, and compares the resulting lines to expected text.

**Call relations**: The test runner calls this. It tests history rendering used by handle_exec_decision, even though the history cell implementation lives elsewhere.

*Call graph*: 4 external calls (assert_eq!, new_approval_decision_cell, Command, vec!).


##### `tests::exec_history_cell_does_not_render_blank_action_for_empty_command`  (lines 2210–2230)

```
fn exec_history_cell_does_not_render_blank_action_for_empty_command()
```

**Purpose**: Checks that history messages for empty commands still read naturally. This avoids awkward blank command text in approval history.

**Data flow**: It creates approved and approved-for-session history cells with an empty command, renders them, and compares the plain text lines to expected generic messages.

**Call relations**: The test runner calls this. It protects history output that handle_exec_decision may insert.

*Call graph*: 4 external calls (new, assert_eq!, new_approval_decision_cell, Command).


##### `tests::network_access_command_history_uses_target_without_structured_context`  (lines 2233–2274)

```
fn network_access_command_history_uses_target_without_structured_context()
```

**Purpose**: Verifies that a special network-access command is recorded in history as network access to its target. This makes history clearer even without structured network context.

**Data flow**: It builds an exec request whose command encodes a network target, approves it, captures the inserted history cell, and checks the rendered text.

**Call relations**: The test runner calls this. It exercises handle_exec_decision and network_approval_command_target.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 5 external calls (Char, new, assert_eq!, make_overlay, vec!).


##### `tests::esc_cancels_mcp_elicitation`  (lines 2277–2296)

```
fn esc_cancels_mcp_elicitation()
```

**Purpose**: Checks the key safety rule that Escape cancels MCP elicitation. This prevents Escape from meaning a softer decline.

**Data flow**: It opens an MCP elicitation prompt, sends Escape, reads emitted events, and asserts the decision is Cancel.

**Call relations**: The test runner calls this. It verifies elicitation_options and shortcut routing through handle_key_event.

*Call graph*: calls 2 internal fn (with_defaults, new); 4 external calls (new, assert_eq!, make_elicitation_request, make_overlay).


##### `tests::esc_still_cancels_elicitation_with_custom_overlap`  (lines 2299–2360)

```
fn esc_still_cancels_elicitation_with_custom_overlap()
```

**Purpose**: Checks that Escape still cancels MCP elicitation even if custom key bindings overlap with decline. It also confirms the remaining decline shortcut still declines.

**Data flow**: It customizes decline to include Escape and n, opens an MCP prompt, sends Escape and expects Cancel; then opens another prompt, sends n, and expects Decline.

**Call relations**: The test runner calls this. It directly protects the overlap-removal logic in elicitation_options.

*Call graph*: calls 3 internal fn (with_defaults, new, defaults); 6 external calls (Char, new, assert_eq!, make_elicitation_request, make_overlay_with_keymap, vec!).


##### `tests::enter_sets_last_selected_index_without_dismissing`  (lines 2363–2386)

```
fn enter_sets_last_selected_index_without_dismissing()
```

**Purpose**: Checks that pressing Enter selects the highlighted approval option and completes the prompt through the overlay's own decision flow. The list view should not silently dismiss without sending a response.

**Data flow**: It opens a standard exec prompt, sends Enter, asserts the overlay is complete, then checks the emitted command decision is Accept.

**Call relations**: The test runner calls this. It exercises handle_key_event's handoff to the list view and then apply_selection.

*Call graph*: calls 2 internal fn (with_defaults, new); 5 external calls (new, assert!, assert_eq!, make_exec_request, make_overlay).


### `tui/src/bottom_pane/request_user_input/mod.rs`

`orchestration` · `request handling and terminal redraw loop`

This file is the control center for a request-user-input overlay in the terminal interface. Think of it like a small questionnaire window that appears during a conversation: it can show one or more questions, offer numbered choices, and provide a text box for notes or free-form answers. Without it, the app could ask for clarification but the terminal UI would not know how to display the questions, remember draft answers, or send the final response back.

The overlay keeps track of the current request, any queued requests waiting behind it, the current question number, selected options, typed notes, and whether the user has really committed an answer. It also owns a reusable composer widget, which is the text-entry box. Because users may jump between questions, the file saves and restores drafts so text is not lost.

It also guides the user with footer hints, wraps long question and option text to fit the terminal width, and handles keyboard shortcuts. If the user tries to submit with unanswered questions, it opens a small confirmation menu. Some requests can auto-resolve: after a hidden grace period, the UI shows a countdown and then submits an empty answer unless the user interacts. The test helpers at the end build sample questions and snapshots to check this behavior. This chunk is the test coverage for the user-input request overlay. The overlay is like a small form that appears in the terminal when the app needs clarification from the user. It may show multiple questions, each with selectable options or a free-text answer box. These tests check that the form behaves predictably when the user presses keys, switches between questions, adds notes, pastes large text, or leaves an auto-resolving prompt unanswered. They also check what events are sent out: a completed answer, an interrupt when the user cancels, or nothing when a stale request is simply dismissed. Several tests use snapshot rendering, which means they compare the drawn terminal screen against a stored expected picture. That protects the layout: progress text, countdown color, wrapped options, footers, and tight-height views should not accidentally change. Without these tests, small input-handling changes could silently break important user-facing behavior, such as submitting a highlighted option too early, losing pasted text, hiding the wrong footer hint, or answering an expired prompt incorrectly. The request-user-input overlay is the screen panel shown when the program needs the user to answer one or more questions. Some questions are multiple choice, some allow free text, and some may include extra notes. These tests act like a photo album for that overlay: they build sample questions, render the overlay into a fixed-size terminal area, and compare the result with stored snapshots. A snapshot test is a test that saves the expected text UI output and warns developers if it changes later.

The tests cover practical cases a user would notice: a long list of choices that needs scrolling, a small terminal where some choices are hidden, a plain freeform question, changed keyboard shortcuts, moving between multiple questions, and showing a warning when not all questions have been answered. One behavior test also checks that pressing the down arrow can still move through answer options while the notes field is being edited, without accidentally marking the answer as final.

Together, these tests protect the user experience. Without them, a small change in layout, shortcut labels, scrolling, or answer selection could quietly make the prompt confusing or harder to use.

#### Function details

##### `format_auto_resolution_remaining`  (lines 83–94)

```
fn format_auto_resolution_remaining(remaining: Duration) -> String
```

**Purpose**: Turns a remaining countdown time into a short label such as `12s` or `1m 05s`. It rounds up partial seconds so the display does not say zero too early.

**Data flow**: It receives a duration, reads its seconds and leftover nanoseconds, rounds up if needed, then returns a formatted string in seconds or minutes-and-seconds.

**Call relations**: It is used when the overlay builds the visible auto-resolution countdown text, so the timer shown to the user stays compact and readable.

*Call graph*: 3 external calls (as_secs, subsec_nanos, format!).


##### `ComposerDraft::text_with_pending`  (lines 105–119)

```
fn text_with_pending(&self) -> String
```

**Purpose**: Returns the draft text as the user would expect to submit it, including paste chunks that have not yet been fully folded into the composer text. This matters because pasted text can be buffered briefly.

**Data flow**: It reads the draft's stored text, text elements, and pending pastes. If there are no pending pastes, it returns the stored text; otherwise it asks `ChatComposer` to expand the pending paste data and returns the expanded text.

**Call relations**: Submission code calls this when turning saved drafts into final answers, so delayed paste content is not accidentally omitted.

*Call graph*: calls 1 internal fn (expand_pending_pastes); 1 external calls (debug_assert!).


##### `FooterTip::new`  (lines 140–145)

```
fn new(text: impl Into<String>) -> Self
```

**Purpose**: Creates a normal footer hint, such as a keyboard shortcut reminder. It is used for hints that should not be visually emphasized.

**Data flow**: It receives text, converts it into an owned string, marks it as not highlighted, and returns a `FooterTip` value.

**Call relations**: The footer-building code uses this alongside `FooterTip::highlighted` when assembling the guidance shown at the bottom of the overlay.

*Call graph*: 1 external calls (into).


##### `FooterTip::highlighted`  (lines 147–152)

```
fn highlighted(text: impl Into<String>) -> Self
```

**Purpose**: Creates an emphasized footer hint for an especially important action, such as submitting. Highlighting helps the user see the next likely step.

**Data flow**: It receives text, converts it into an owned string, marks it as highlighted, and returns a `FooterTip` value.

**Call relations**: The footer tip builder uses it for primary actions while mixing it with normal tips created by `FooterTip::new`.

*Call graph*: 1 external calls (into).


##### `RequestUserInputOverlay::new`  (lines 179–194)

```
fn new(
        request: ToolRequestUserInputParams,
        app_event_tx: AppEventSender,
        has_input_focus: bool,
        enhanced_keys_supported: bool,
        disable_paste_burst: bool,
```

**Purpose**: Creates a new user-input overlay using the default keyboard shortcuts. Tests and callers use it when they do not need a custom keymap.

**Data flow**: It receives the request, event sender, focus and keyboard capability flags, and paste settings. It adds the default runtime keymap and delegates construction to `new_with_keymap`, returning a ready overlay.

**Call relations**: This is the simple constructor. It is called by tests and higher-level code, while the detailed setup happens in `RequestUserInputOverlay::new_with_keymap`.

*Call graph*: calls 1 internal fn (defaults); called by 65 (auto_resolution_absent_has_no_timer, auto_resolution_expiry_emits_empty_answer, auto_resolution_hides_timer_during_grace_period, auto_resolution_key_interaction_snoozes_timer, auto_resolution_paste_interaction_snoozes_timer, auto_resolution_resets_for_queued_request, auto_resolution_visible_countdown_is_red, auto_resolution_visible_countdown_snapshot, backspace_in_options_clears_selection, backspace_on_empty_notes_closes_notes_ui (+15 more)); 1 external calls (new_with_keymap).


##### `RequestUserInputOverlay::new_with_keymap`  (lines 196–238)

```
fn new_with_keymap(
        request: ToolRequestUserInputParams,
        app_event_tx: AppEventSender,
        has_input_focus: bool,
        enhanced_keys_supported: bool,
        disable_paste_burst
```

**Purpose**: Creates the overlay with a specific set of keyboard bindings. This is important for users who have remapped submit, interrupt, or list navigation keys.

**Data flow**: It receives the request, event sender, focus flags, paste setting, and keymap. It builds a plain-text composer, stores request state and key bindings, resets answers for the first request, fixes focus, restores the current draft, and returns the overlay.

**Call relations**: Higher-level request handling and keymap-focused tests call this. It prepares the composer and internal answer state used by almost every later method.

*Call graph*: calls 2 internal fn (new_with_config, plain_text); called by 7 (push_user_input_request, freeform_footer_shows_configured_submit_binding, freeform_submit_binding_wins_over_question_navigation, freeform_uses_configured_composer_submit_binding, request_user_input_freeform_remapped_interrupt_snapshot, request_user_input_freeform_remapped_submit_snapshot, request_user_input_uses_remapped_interrupt_binding_while_notes_are_visible); 4 external calls (now, new, new, clone).


##### `RequestUserInputOverlay::current_index`  (lines 240–242)

```
fn current_index(&self) -> usize
```

**Purpose**: Returns which question is currently being shown. Other helpers use it to avoid repeating direct access to the internal index field.

**Data flow**: It reads `current_idx` and returns that number unchanged.

**Call relations**: Question, answer, progress, and navigation helpers call this whenever they need to know the active question.

*Call graph*: called by 8 (current_answer, current_answer_mut, current_question, footer_tips, go_next_or_submit, notes_has_content, notes_ui_visible, progress_prefix_text).


##### `RequestUserInputOverlay::current_question`  (lines 244–246)

```
fn current_question(&self) -> Option<&ToolRequestUserInputQuestion>
```

**Purpose**: Returns the currently visible question, if there is one. This protects callers from asking for a question when the request has none.

**Data flow**: It reads the current index, looks up that position in the request's question list, and returns either a reference to the question or nothing.

**Call relations**: Option, wrapping, and display helpers call this before reading question text or options.

*Call graph*: calls 1 internal fn (current_index); called by 4 (has_options, option_rows, options_len, wrapped_question_lines).


##### `RequestUserInputOverlay::current_answer_mut`  (lines 248–251)

```
fn current_answer_mut(&mut self) -> Option<&mut AnswerState>
```

**Purpose**: Returns editable state for the current answer. It is the safe doorway for changing selection, draft text, note visibility, or committed status.

**Data flow**: It reads the current index, looks up the matching answer state in the answers list, and returns a mutable reference if it exists.

**Call relations**: Most editing and navigation methods use this before changing the active answer.

*Call graph*: calls 1 internal fn (current_index); called by 12 (apply_submission_draft, apply_submission_to_draft, clear_notes_and_focus_options, clear_notes_draft, clear_selection, ensure_focus_available, ensure_selected_for_notes, handle_composer_input_result, handle_key_event, handle_paste (+2 more)).


##### `RequestUserInputOverlay::current_answer`  (lines 253–256)

```
fn current_answer(&self) -> Option<&AnswerState>
```

**Purpose**: Returns read-only state for the current answer. Display code uses it to know what is selected or saved.

**Data flow**: It reads the current index, looks up the matching answer state, and returns a shared reference if it exists.

**Call relations**: Rendering and draft restoration helpers call this when they need to inspect the active answer without changing it.

*Call graph*: calls 1 internal fn (current_index); called by 5 (notes_ui_visible, options_preferred_height, options_required_height, restore_current_draft, selected_option_index).


##### `RequestUserInputOverlay::question_count`  (lines 258–260)

```
fn question_count(&self) -> usize
```

**Purpose**: Returns how many questions are in the current request. Navigation and progress display rely on this number.

**Data flow**: It reads the request's question list length and returns it.

**Call relations**: It is used by focus checks, progress text, footer hints, and question navigation to stay within valid bounds.

*Call graph*: called by 6 (ensure_focus_available, footer_tips, go_next_or_submit, jump_to_question, move_question, progress_prefix_text).


##### `RequestUserInputOverlay::advance_queue_or_complete_at`  (lines 262–273)

```
fn advance_queue_or_complete_at(&mut self, now: Instant)
```

**Purpose**: Moves from the current request to the next queued request, or marks the overlay finished if none remain. This keeps multiple incoming prompts in first-in, first-out order.

**Data flow**: It receives the current time, pops the next request from the queue if present, resets all per-request state, and restores the first draft. If the queue is empty, it sets `done` to true.

**Call relations**: Submission, auto-resolution, and dismissal paths call this after the active request is resolved.

*Call graph*: calls 3 internal fn (ensure_focus_available, reset_for_request, restore_current_draft); called by 3 (dismiss_resolved_request, submit_answers, submit_empty_auto_resolution); 1 external calls (pop_front).


##### `RequestUserInputOverlay::snooze_auto_resolution`  (lines 275–279)

```
fn snooze_auto_resolution(&mut self)
```

**Purpose**: Stops the auto-resolution countdown once the user interacts. This prevents the UI from submitting an empty answer while the user is actively working.

**Data flow**: It checks whether the current request has auto-resolution enabled. If so, it marks auto-resolution as snoozed.

**Call relations**: Keyboard and paste handlers call this at the start of user interaction.

*Call graph*: called by 2 (handle_key_event, handle_paste).


##### `RequestUserInputOverlay::auto_resolution_timing_at`  (lines 281–301)

```
fn auto_resolution_timing_at(&self, now: Instant) -> AutoResolutionTiming
```

**Purpose**: Figures out the current auto-resolution state: off, hidden grace period, visible countdown, or due now. This is the source of truth for timer behavior.

**Data flow**: It receives a time, compares it with when the request started, and returns a timing state. It disables timing if the request has no auto-resolution or the user already interacted.

**Call relations**: Countdown text, redraw scheduling, and pre-draw auto-submit checks all ask this method what stage the timer is in.

*Call graph*: called by 2 (auto_resolution_countdown_text_at, auto_resolution_next_frame_delay_at); 1 external calls (saturating_duration_since).


##### `RequestUserInputOverlay::auto_resolution_next_frame_delay_at`  (lines 303–312)

```
fn auto_resolution_next_frame_delay_at(&self, now: Instant) -> Option<Duration>
```

**Purpose**: Tells the terminal when it next needs to redraw because of auto-resolution timing. This avoids redrawing constantly when no timer is active.

**Data flow**: It receives a time, asks for the auto-resolution timing state, and returns no delay, a grace-period delay, a countdown delay capped at one second, or zero when submission is due.

**Call relations**: The overlay's `next_frame_delay` method calls this so the main UI loop can wake up at the right time.

*Call graph*: calls 1 internal fn (auto_resolution_timing_at); called by 1 (next_frame_delay); 1 external calls (from_secs).


##### `RequestUserInputOverlay::maybe_auto_resolve_at`  (lines 314–323)

```
fn maybe_auto_resolve_at(&mut self, now: Instant) -> bool
```

**Purpose**: Submits an empty response if the auto-resolution timer has expired. It returns whether it actually did anything.

**Data flow**: It receives a time, checks whether the timing state is due, and if so submits an empty auto-resolution response and returns true. Otherwise it returns false.

**Call relations**: The pre-draw tick calls this just before rendering, giving timed-out requests a chance to finish.

*Call graph*: calls 1 internal fn (submit_empty_auto_resolution); called by 1 (pre_draw_tick); 1 external calls (matches!).


##### `RequestUserInputOverlay::auto_resolution_countdown_text_at`  (lines 325–335)

```
fn auto_resolution_countdown_text_at(&self, now: Instant) -> Option<String>
```

**Purpose**: Builds the countdown message shown to the user during the visible countdown phase. Outside that phase, it shows nothing.

**Data flow**: It receives a time, checks the timer state, formats the remaining time if visible, and returns either text like `auto-resolves in 10s` or no text.

**Call relations**: Rendering code can call this to decide whether a countdown label belongs on screen.

*Call graph*: calls 1 internal fn (auto_resolution_timing_at); 1 external calls (format!).


##### `RequestUserInputOverlay::progress_prefix_text`  (lines 337–351)

```
fn progress_prefix_text(&self) -> String
```

**Purpose**: Creates the progress label, such as `Question 2/4 (1 unanswered)`. This helps the user understand where they are in a multi-question prompt.

**Data flow**: It reads the current index, total question count, and unanswered count. It returns a suitable progress string, or `No questions` if the request is empty.

**Call relations**: Display code uses this text near the question header or footer.

*Call graph*: calls 3 internal fn (current_index, question_count, unanswered_count); 1 external calls (format!).


##### `RequestUserInputOverlay::has_options`  (lines 353–357)

```
fn has_options(&self) -> bool
```

**Purpose**: Checks whether the current question offers choices. The overlay behaves differently for choice questions and free-form questions.

**Data flow**: It reads the current question, checks whether its options list exists and is non-empty, and returns true or false.

**Call relations**: Focus, footer, keyboard, placeholder, and note-visibility logic all use this branch point.

*Call graph*: calls 1 internal fn (current_question); called by 13 (clear_notes_and_focus_options, clear_selection, ensure_focus_available, footer_tips, handle_composer_input_result, handle_key_event, notes_placeholder, notes_ui_visible, option_index_for_digit, options_preferred_height (+3 more)).


##### `RequestUserInputOverlay::options_len`  (lines 359–363)

```
fn options_len(&self) -> usize
```

**Purpose**: Returns the number of selectable choices for the current question. This includes the synthetic `Other` choice when that is enabled.

**Data flow**: It reads the current question and asks `options_len_for_question`; if there is no current question, it returns zero.

**Call relations**: Keyboard navigation, digit shortcuts, and selection clamping call this before moving or choosing an option.

*Call graph*: calls 1 internal fn (current_question); called by 4 (handle_composer_input_result, handle_key_event, option_index_for_digit, select_current_option).


##### `RequestUserInputOverlay::option_index_for_digit`  (lines 365–375)

```
fn option_index_for_digit(&self, ch: char) -> Option<usize>
```

**Purpose**: Turns a number key into a zero-based option index. For example, pressing `1` means the first option.

**Data flow**: It receives a character, rejects it if there are no options, if it is not a digit, or if it is `0`. It converts valid digits to an index and returns it only if it fits the option list.

**Call relations**: The key handler calls this when the user presses a character while focused on options.

*Call graph*: calls 2 internal fn (has_options, options_len); called by 1 (handle_key_event).


##### `RequestUserInputOverlay::selected_option_index`  (lines 377–383)

```
fn selected_option_index(&self) -> Option<usize>
```

**Purpose**: Returns which option is currently selected, if any. It only reports a selection for questions that actually have options.

**Data flow**: It checks whether options exist, then reads the selected index from the current answer state.

**Call relations**: Footer hints, placeholders, and key behavior use this to decide whether notes can be added or an option can be submitted.

*Call graph*: calls 2 internal fn (current_answer, has_options); called by 3 (footer_tips, handle_key_event, notes_placeholder).


##### `RequestUserInputOverlay::notes_has_content`  (lines 385–391)

```
fn notes_has_content(&self, idx: usize) -> bool
```

**Purpose**: Checks whether a question has non-empty notes text. It knows to read live text from the composer for the current question and saved draft text for other questions.

**Data flow**: It receives a question index. If that index is active, it reads the composer text including pending paste data; otherwise it reads the saved draft for that answer. It trims whitespace and returns whether anything remains.

**Call relations**: Note visibility logic uses this so notes stay visible when they contain text.

*Call graph*: calls 2 internal fn (current_text_with_pending, current_index).


##### `RequestUserInputOverlay::notes_ui_visible`  (lines 393–400)

```
fn notes_ui_visible(&self) -> bool
```

**Purpose**: Decides whether the notes text box should be visible for the current question. Free-form questions always show it; option questions show it only when requested or when notes already exist.

**Data flow**: It checks whether the current question has options, reads the current answer state, and returns true if notes are visible or contain content.

**Call relations**: Focus handling, footer hints, and key handling call this before showing, hiding, or clearing the notes area.

*Call graph*: calls 3 internal fn (current_answer, current_index, has_options); called by 3 (ensure_focus_available, footer_tips, handle_key_event).


##### `RequestUserInputOverlay::wrapped_question_lines`  (lines 402–411)

```
fn wrapped_question_lines(&self, width: u16) -> Vec<String>
```

**Purpose**: Wraps the current question text so it fits the terminal width. This prevents long questions from running off the screen.

**Data flow**: It receives a width, reads the current question text, wraps it to at least one column, and returns the resulting lines. If there is no question, it returns an empty list.

**Call relations**: Rendering code uses these lines when drawing the question area.

*Call graph*: calls 1 internal fn (current_question).


##### `RequestUserInputOverlay::focus_is_notes`  (lines 413–415)

```
fn focus_is_notes(&self) -> bool
```

**Purpose**: Reports whether keyboard input is currently going to the notes text box. This keeps focus checks readable.

**Data flow**: It reads the overlay focus field and returns true only when it is `Notes`.

**Call relations**: Footer, key handling, and Ctrl-C handling call this to decide whether text-entry behavior applies.

*Call graph*: called by 3 (footer_tips, handle_key_event, on_ctrl_c); 1 external calls (matches!).


##### `RequestUserInputOverlay::confirm_unanswered_active`  (lines 417–419)

```
fn confirm_unanswered_active(&self) -> bool
```

**Purpose**: Reports whether the unanswered-question confirmation menu is open. While it is open, normal question controls should pause.

**Data flow**: It checks whether `confirm_unanswered` contains a state value and returns true or false.

**Call relations**: Keyboard and Ctrl-C handling call this before routing input to the confirmation menu.

*Call graph*: called by 2 (handle_key_event, on_ctrl_c).


##### `RequestUserInputOverlay::option_rows`  (lines 421–465)

```
fn option_rows(&self) -> Vec<GenericDisplayRow>
```

**Purpose**: Builds display rows for the current question's choices. Each row includes numbering, selection marker, label, description, and wrap indentation.

**Data flow**: It reads the current question and selected option, turns each option into a `GenericDisplayRow`, and adds an `Other` row when enabled. If there are no options, it returns an empty list.

**Call relations**: Height calculation and rendering helpers use these rows to show the choice list consistently.

*Call graph*: calls 1 internal fn (current_question); called by 2 (options_preferred_height, options_required_height).


##### `RequestUserInputOverlay::options_required_height`  (lines 467–486)

```
fn options_required_height(&self, width: u16) -> u16
```

**Purpose**: Calculates how much vertical space the options list needs at the given width. This helps the layout reserve enough room.

**Data flow**: It receives a width, returns zero if there are no options, builds option rows, prepares selection state, and measures the wrapped row height.

**Call relations**: Layout code calls this when deciding how tall the options section must be.

*Call graph*: calls 4 internal fn (current_answer, has_options, option_rows, measure_rows_height).


##### `RequestUserInputOverlay::options_preferred_height`  (lines 488–507)

```
fn options_preferred_height(&self, width: u16) -> u16
```

**Purpose**: Calculates the preferred height for the options list at the given width. In this chunk it uses the same measurement as the required height.

**Data flow**: It receives a width, returns zero if there are no options, builds rows, prepares selection state, and returns the measured wrapped height.

**Call relations**: Layout code can use this to choose a comfortable size for the options area.

*Call graph*: calls 4 internal fn (current_answer, has_options, option_rows, measure_rows_height).


##### `RequestUserInputOverlay::capture_composer_draft`  (lines 509–521)

```
fn capture_composer_draft(&self) -> ComposerDraft
```

**Purpose**: Takes a snapshot of everything currently in the text composer. This lets the overlay preserve drafts while the user moves between questions.

**Data flow**: It reads current text, structured text elements, local image paths, and pending paste data from the composer, then packages them into a `ComposerDraft`.

**Call relations**: Draft saving and submit-key handling call this before navigation or submission changes the composer.

*Call graph*: calls 4 internal fn (current_text, local_images, pending_pastes, text_elements); called by 2 (handle_key_event, save_current_draft).


##### `RequestUserInputOverlay::save_current_draft`  (lines 523–535)

```
fn save_current_draft(&mut self)
```

**Purpose**: Stores the current composer contents into the active answer state. It also marks an already committed answer as uncommitted if the draft changed.

**Data flow**: It captures the composer draft, checks whether notes are empty, updates the current answer draft, clears committed status if needed, and keeps notes visible when they contain text.

**Call relations**: Navigation and submission paths call this before leaving a question or sending answers.

*Call graph*: calls 2 internal fn (capture_composer_draft, current_answer_mut); called by 5 (go_next_or_submit, handle_key_event, jump_to_question, move_question, submit_answers).


##### `RequestUserInputOverlay::restore_current_draft`  (lines 537–552)

```
fn restore_current_draft(&mut self)
```

**Purpose**: Loads the saved draft for the current question back into the composer. This makes moving between questions feel safe and reversible.

**Data flow**: It sets the placeholder and empty footer hints, then either clears the composer if no answer exists or restores text, text elements, image paths, and pending pastes from the saved draft. It moves the cursor to the end.

**Call relations**: Request advancement and question navigation call this after changing which question is active.

*Call graph*: calls 7 internal fn (move_cursor_to_end, set_footer_hint_override, set_pending_pastes, set_placeholder_text, set_text_content, current_answer, notes_placeholder); called by 3 (advance_queue_or_complete_at, jump_to_question, move_question); 2 external calls (new, new).


##### `RequestUserInputOverlay::notes_placeholder`  (lines 554–562)

```
fn notes_placeholder(&self) -> &'static str
```

**Purpose**: Chooses the placeholder text shown in the notes composer. The wording changes depending on whether the user needs to select an option first.

**Data flow**: It checks whether the current question has options and whether an option is selected, then returns one of the static placeholder strings.

**Call relations**: Draft restoration and placeholder synchronization call this whenever focus or selection changes.

*Call graph*: calls 2 internal fn (has_options, selected_option_index); called by 2 (restore_current_draft, sync_composer_placeholder).


##### `RequestUserInputOverlay::sync_composer_placeholder`  (lines 564–567)

```
fn sync_composer_placeholder(&mut self)
```

**Purpose**: Refreshes the composer placeholder so it matches the current question state. This keeps the on-screen hint accurate after selection or focus changes.

**Data flow**: It computes the right placeholder with `notes_placeholder` and writes it into the composer.

**Call relations**: Selection, clearing, focus, and note-visibility changes call this after they alter what the user can type.

*Call graph*: calls 2 internal fn (set_placeholder_text, notes_placeholder); called by 7 (clear_notes_and_focus_options, clear_notes_draft, clear_selection, ensure_focus_available, ensure_selected_for_notes, handle_key_event, select_current_option).


##### `RequestUserInputOverlay::clear_notes_draft`  (lines 569–580)

```
fn clear_notes_draft(&mut self)
```

**Purpose**: Clears only the notes draft for the current question. It is used when the user cancels typed notes without closing the whole overlay.

**Data flow**: It resets the current answer's draft, clears committed status, keeps notes visible, clears pending submission data, empties the composer, moves the cursor to the end, and refreshes the placeholder.

**Call relations**: Ctrl-C handling calls this when focus is in notes and there is text to clear.

*Call graph*: calls 4 internal fn (move_cursor_to_end, set_text_content, current_answer_mut, sync_composer_placeholder); called by 1 (on_ctrl_c); 3 external calls (new, new, default).


##### `RequestUserInputOverlay::footer_tips`  (lines 582–631)

```
fn footer_tips(&self) -> Vec<FooterTip>
```

**Purpose**: Builds the list of keyboard hints shown at the bottom of the overlay. These hints change with focus, selected options, question count, and configured key bindings.

**Data flow**: It reads note visibility, option state, current question position, submit bindings, interrupt bindings, and focus. It returns normal or highlighted `FooterTip` values describing useful actions.

**Call relations**: Footer line wrapping methods call this before laying the tips out on screen.

*Call graph*: calls 9 internal fn (highlighted, new, current_index, focus_is_notes, has_options, notes_ui_visible, question_count, selected_option_index, plain); called by 2 (footer_tip_lines, footer_tip_lines_with_prefix); 2 external calls (new, format!).


##### `RequestUserInputOverlay::footer_tip_lines`  (lines 633–635)

```
fn footer_tip_lines(&self, width: u16) -> Vec<Vec<FooterTip>>
```

**Purpose**: Wraps the current footer hints into lines that fit a given width. This is the plain version without any extra prefix.

**Data flow**: It receives a width, builds footer tips, wraps them with `wrap_footer_tips`, and returns lines of tips.

**Call relations**: Footer height calculation calls this to know how many terminal rows the hints need.

*Call graph*: calls 2 internal fn (footer_tips, wrap_footer_tips); called by 1 (footer_required_height).


##### `RequestUserInputOverlay::footer_tip_lines_with_prefix`  (lines 637–648)

```
fn footer_tip_lines_with_prefix(
        &self,
        width: u16,
        prefix: Option<FooterTip>,
    ) -> Vec<Vec<FooterTip>>
```

**Purpose**: Wraps footer hints while optionally placing an extra tip at the front. This is useful when rendering wants to add context before normal shortcuts.

**Data flow**: It receives a width and optional prefix, prepends the prefix if present, appends normal footer tips, wraps the combined list, and returns lines.

**Call relations**: Rendering helpers can use this when they need footer hints plus a leading status message.

*Call graph*: calls 2 internal fn (footer_tips, wrap_footer_tips); 1 external calls (new).


##### `RequestUserInputOverlay::wrap_footer_tips`  (lines 650–689)

```
fn wrap_footer_tips(&self, width: u16, tips: Vec<FooterTip>) -> Vec<Vec<FooterTip>>
```

**Purpose**: Splits footer tips across multiple lines so they fit the terminal width. It treats the separator between tips as part of the width budget.

**Data flow**: It receives a width and a list of tips, measures each tip's displayed width, starts a new line when adding the next tip would overflow, and returns grouped lines.

**Call relations**: Both footer-line builders use this as their shared wrapping engine.

*Call graph*: called by 2 (footer_tip_lines, footer_tip_lines_with_prefix); 3 external calls (width, new, vec!).


##### `RequestUserInputOverlay::footer_required_height`  (lines 691–693)

```
fn footer_required_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows the footer needs. This helps layout reserve space for keyboard hints.

**Data flow**: It receives a width, wraps the footer tips for that width, and returns the number of resulting lines.

**Call relations**: Layout code calls this before drawing the overlay.

*Call graph*: calls 1 internal fn (footer_tip_lines).


##### `RequestUserInputOverlay::ensure_focus_available`  (lines 696–711)

```
fn ensure_focus_available(&mut self)
```

**Purpose**: Makes sure the current focus target actually exists. For example, free-form questions must focus notes, while option questions should not focus hidden notes.

**Data flow**: It checks the question count, whether options exist, and whether notes are visible. It updates focus and note visibility as needed, and refreshes the placeholder when it moves focus away from hidden notes.

**Call relations**: Request reset, queue advancement, and question navigation call this after the active question changes.

*Call graph*: calls 5 internal fn (current_answer_mut, has_options, notes_ui_visible, question_count, sync_composer_placeholder); called by 3 (advance_queue_or_complete_at, jump_to_question, move_question); 1 external calls (matches!).


##### `RequestUserInputOverlay::reset_for_request`  (lines 714–743)

```
fn reset_for_request(&mut self)
```

**Purpose**: Clears old per-question state and prepares fresh answer state for the current request. This is like resetting a form before filling it out.

**Data flow**: It reads all questions in the request, creates an `AnswerState` for each, selects the first option by default when options exist, clears composer text, resets the current index and focus, and removes confirmation or pending submission state.

**Call relations**: New overlay setup and queued-request advancement call this before showing a request.

*Call graph*: calls 1 internal fn (set_text_content); called by 1 (advance_queue_or_complete_at); 2 external calls (new, new).


##### `RequestUserInputOverlay::options_len_for_question`  (lines 745–756)

```
fn options_len_for_question(question: &ToolRequestUserInputQuestion) -> usize
```

**Purpose**: Counts the selectable choices for a specific question, including the extra `Other` choice when allowed.

**Data flow**: It receives a question, counts its option list or zero if absent, adds one if `Other` is enabled, and returns the total.

**Call relations**: The current-question option count helper uses this, and label lookup uses the same `Other` rule.

*Call graph*: 1 external calls (other_option_enabled_for_question).


##### `RequestUserInputOverlay::other_option_enabled_for_question`  (lines 758–764)

```
fn other_option_enabled_for_question(question: &ToolRequestUserInputQuestion) -> bool
```

**Purpose**: Checks whether a question should show an extra `Other` option. The extra option only appears when the question has normal options too.

**Data flow**: It receives a question and returns true when `is_other` is true and the options list exists and is not empty.

**Call relations**: Option row building, option counting, and option label lookup all use this shared rule.


##### `RequestUserInputOverlay::option_label_for_index`  (lines 766–778)

```
fn option_label_for_index(
        question: &ToolRequestUserInputQuestion,
        idx: usize,
    ) -> Option<String>
```

**Purpose**: Converts a selected option index into the label that should be submitted. It also handles the synthetic `Other` option.

**Data flow**: It receives a question and index, returns the matching option label if the index is inside the real options, returns `Other` for the extra option when enabled, or returns nothing for an invalid index.

**Call relations**: Answer submission calls this when turning selected indexes into final answer strings.

*Call graph*: 1 external calls (other_option_enabled_for_question).


##### `RequestUserInputOverlay::move_question`  (lines 781–791)

```
fn move_question(&mut self, next: bool)
```

**Purpose**: Moves to the previous or next question, wrapping around at the ends. It saves and restores drafts so the user's work follows each question.

**Data flow**: It receives a direction flag, checks the question count, saves the current draft, updates the index with wraparound, restores the new question's draft, and fixes focus.

**Call relations**: Keyboard navigation and next-or-submit flow call this when the user changes questions.

*Call graph*: calls 4 internal fn (ensure_focus_available, question_count, restore_current_draft, save_current_draft); called by 2 (go_next_or_submit, handle_key_event).


##### `RequestUserInputOverlay::jump_to_question`  (lines 793–801)

```
fn jump_to_question(&mut self, idx: usize)
```

**Purpose**: Moves directly to a specific question index. It is used when sending the user back to the first unanswered question.

**Data flow**: It receives an index, ignores it if out of range, saves the current draft, updates the current index, restores that draft, and fixes focus.

**Call relations**: The unanswered confirmation flow calls this when the user chooses to go back.

*Call graph*: calls 4 internal fn (ensure_focus_available, question_count, restore_current_draft, save_current_draft); called by 1 (handle_confirm_unanswered_key_event).


##### `RequestUserInputOverlay::select_current_option`  (lines 804–819)

```
fn select_current_option(&mut self, committed: bool)
```

**Purpose**: Commits the currently highlighted option, or updates selection state without final commitment depending on the argument. It also keeps selection inside valid bounds.

**Data flow**: It receives a `committed` flag, checks that the question has options, clamps the selected index to the option count, writes the committed flag, and refreshes the placeholder.

**Call relations**: Keyboard handling calls this for space, enter, digit shortcuts, and fallback submit behavior.

*Call graph*: calls 4 internal fn (current_answer_mut, has_options, options_len, sync_composer_placeholder); called by 1 (handle_key_event).


##### `RequestUserInputOverlay::clear_selection`  (lines 822–837)

```
fn clear_selection(&mut self)
```

**Purpose**: Removes the selected option and clears any notes for an option question. This gives the user a clean slate.

**Data flow**: It checks for options, resets the answer's option state, draft, committed flag, and note visibility, clears pending submission state, empties the composer, moves the cursor, and updates the placeholder.

**Call relations**: Keyboard handling calls this for backspace or delete while focused on options.

*Call graph*: calls 5 internal fn (move_cursor_to_end, set_text_content, current_answer_mut, has_options, sync_composer_placeholder); called by 1 (handle_key_event); 3 external calls (new, new, default).


##### `RequestUserInputOverlay::clear_notes_and_focus_options`  (lines 839–854)

```
fn clear_notes_and_focus_options(&mut self)
```

**Purpose**: Clears notes for an option question and returns focus to the option list. It is used when the user exits the note area.

**Data flow**: It checks for options, resets draft and note visibility, clears pending submission state, empties the composer, moves the cursor, sets focus to options, and refreshes the placeholder.

**Call relations**: Escape, tab, and other note-exit paths in key handling call this.

*Call graph*: calls 5 internal fn (move_cursor_to_end, set_text_content, current_answer_mut, has_options, sync_composer_placeholder); called by 1 (handle_key_event); 3 external calls (new, new, default).


##### `RequestUserInputOverlay::ensure_selected_for_notes`  (lines 857–862)

```
fn ensure_selected_for_notes(&mut self)
```

**Purpose**: Makes the notes area visible for the current answer. This is needed before typing or pasting notes.

**Data flow**: It marks the current answer's notes as visible if there is an answer state, then refreshes the composer placeholder.

**Call relations**: Keyboard and paste handling call this when the user enters the notes workflow.

*Call graph*: calls 2 internal fn (current_answer_mut, sync_composer_placeholder); called by 2 (handle_key_event, handle_paste).


##### `RequestUserInputOverlay::go_next_or_submit`  (lines 865–876)

```
fn go_next_or_submit(&mut self)
```

**Purpose**: Performs the main forward action: move to the next question, submit all answers, or ask for confirmation if some are unanswered.

**Data flow**: It checks whether the current question is the last one. If not, it moves next. If it is last, it saves the draft, counts unanswered questions, opens confirmation if needed, or submits answers.

**Call relations**: Composer submission and option-enter paths call this after the user commits an answer.

*Call graph*: calls 7 internal fn (current_index, move_question, open_unanswered_confirmation, question_count, save_current_draft, submit_answers, unanswered_count); called by 2 (handle_composer_input_result, handle_key_event).


##### `RequestUserInputOverlay::submit_answers`  (lines 879–927)

```
fn submit_answers(&mut self)
```

**Purpose**: Sends the user's committed answers back to the app and records the result in history. This is the normal successful finish path.

**Data flow**: It clears unanswered confirmation, saves the current draft, builds a map from question IDs to answer lists, includes selected labels and committed notes, sends a user-input response event, inserts a history cell, and advances to the next queued request or completes.

**Call relations**: The next-or-submit flow and unanswered confirmation menu call this when submission is accepted.

*Call graph*: calls 4 internal fn (send, user_input_answer, advance_queue_or_complete_at, save_current_draft); called by 2 (go_next_or_submit, handle_confirm_unanswered_key_event); 6 external calls (new, new, now, new, InsertHistoryCell, format!).


##### `RequestUserInputOverlay::submit_empty_auto_resolution`  (lines 929–946)

```
fn submit_empty_auto_resolution(&mut self, now: Instant)
```

**Purpose**: Submits an empty answer set when auto-resolution expires. This lets the system continue without manual input.

**Data flow**: It clears confirmation state, creates an empty answers map, sends it as the user-input response, records a non-interrupted history cell, and advances the queue or completes at the given time.

**Call relations**: The auto-resolution check calls this when the timer reaches the due state.

*Call graph*: calls 3 internal fn (send, user_input_answer, advance_queue_or_complete_at); called by 1 (maybe_auto_resolve_at); 3 external calls (new, new, InsertHistoryCell).


##### `RequestUserInputOverlay::dismiss_resolved_request`  (lines 948–962)

```
fn dismiss_resolved_request(&mut self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Removes a request that the app server says has already been resolved. This prevents stale prompts from staying visible or queued.

**Data flow**: It receives a resolved request, ignores it unless it is a user-input request, removes matching queued requests by call ID, and if the active request matches, advances to the next request. It returns whether anything changed.

**Call relations**: The trait-facing dismissal method calls this when server-side resolution notifications arrive.

*Call graph*: calls 1 internal fn (advance_queue_or_complete_at); called by 1 (dismiss_app_server_request); 3 external calls (now, len, retain).


##### `RequestUserInputOverlay::open_unanswered_confirmation`  (lines 964–968)

```
fn open_unanswered_confirmation(&mut self)
```

**Purpose**: Opens the small menu that asks whether to submit despite unanswered questions or go back. It starts with the first choice selected.

**Data flow**: It creates a new scroll state, selects index zero, and stores it as the active unanswered confirmation state.

**Call relations**: The next-or-submit flow calls this when the user tries to finish while some questions are not committed.

*Call graph*: calls 1 internal fn (new); called by 1 (go_next_or_submit).


##### `RequestUserInputOverlay::close_unanswered_confirmation`  (lines 970–972)

```
fn close_unanswered_confirmation(&mut self)
```

**Purpose**: Closes the unanswered-question confirmation menu. Normal overlay controls can resume afterward.

**Data flow**: It clears the optional confirmation state.

**Call relations**: Confirmation key handling and Ctrl-C handling call this before continuing with submit, go-back, or interrupt actions.

*Call graph*: called by 2 (handle_confirm_unanswered_key_event, on_ctrl_c).


##### `RequestUserInputOverlay::unanswered_question_count`  (lines 974–976)

```
fn unanswered_question_count(&self) -> usize
```

**Purpose**: Returns the number of unanswered questions. It exists as a small wrapper for wording the confirmation message.

**Data flow**: It calls `unanswered_count` and returns that value.

**Call relations**: The unanswered submit description calls this when building its message.

*Call graph*: calls 1 internal fn (unanswered_count); called by 1 (unanswered_submit_description).


##### `RequestUserInputOverlay::unanswered_submit_description`  (lines 978–986)

```
fn unanswered_submit_description(&self) -> String
```

**Purpose**: Builds the description shown for the confirmation menu's submit option. It uses singular or plural wording correctly.

**Data flow**: It reads the unanswered count, chooses the matching suffix, and returns a sentence explaining how many questions will remain unanswered.

**Call relations**: The confirmation row builder uses this text for the submit-anyway choice.

*Call graph*: calls 1 internal fn (unanswered_question_count); called by 1 (unanswered_confirmation_rows); 1 external calls (format!).


##### `RequestUserInputOverlay::first_unanswered_index`  (lines 988–996)

```
fn first_unanswered_index(&self) -> Option<usize>
```

**Purpose**: Finds the first question that is not answered. This helps send the user directly to the place that needs attention.

**Data flow**: It reads the current composer text, scans questions in order, asks whether each is answered, and returns the first unanswered index if any.

**Call relations**: Confirmation key handling calls this when the user cancels submission or chooses to go back.

*Call graph*: calls 1 internal fn (current_text); called by 1 (handle_confirm_unanswered_key_event).


##### `RequestUserInputOverlay::unanswered_confirmation_rows`  (lines 998–1027)

```
fn unanswered_confirmation_rows(&self) -> Vec<GenericDisplayRow>
```

**Purpose**: Builds the two display rows for the unanswered-question confirmation menu. One row submits anyway; the other returns to unanswered questions.

**Data flow**: It reads the selected menu index, creates the two entries with labels and descriptions, adds numbering and a selection marker, and returns display rows.

**Call relations**: Rendering code uses these rows while the confirmation menu is active.

*Call graph*: calls 1 internal fn (unanswered_submit_description).


##### `RequestUserInputOverlay::is_question_answered`  (lines 1029–1045)

```
fn is_question_answered(&self, idx: usize, _current_text: &str) -> bool
```

**Purpose**: Decides whether a specific question counts as answered. A choice question needs a committed selection; a free-form question needs a committed draft.

**Data flow**: It receives an index and current text argument, looks up the question and answer state, checks whether the question has options, and returns the appropriate committed-status test.

**Call relations**: Unanswered counting and first-unanswered search call this for each question.


##### `RequestUserInputOverlay::unanswered_count`  (lines 1048–1056)

```
fn unanswered_count(&self) -> usize
```

**Purpose**: Counts how many questions are not yet answered. This drives progress text and submit confirmation.

**Data flow**: It reads the current composer text, scans every question, filters those not answered according to `is_question_answered`, and returns the count.

**Call relations**: Progress display, next-or-submit flow, and confirmation wording use this count.

*Call graph*: calls 1 internal fn (current_text); called by 3 (go_next_or_submit, progress_prefix_text, unanswered_question_count).


##### `RequestUserInputOverlay::notes_input_height`  (lines 1059–1064)

```
fn notes_input_height(&self, width: u16) -> u16
```

**Purpose**: Chooses a reasonable height for the notes text box. It allows growth for multi-line text but caps it so the overlay does not take over the screen.

**Data flow**: It receives a width, asks the composer for its desired height, and clamps that height between a minimum and a small maximum above it.

**Call relations**: Layout code uses this when deciding how much vertical space to give the composer.

*Call graph*: calls 1 internal fn (desired_height).


##### `RequestUserInputOverlay::apply_submission_to_draft`  (lines 1066–1085)

```
fn apply_submission_to_draft(&mut self, text: String, text_elements: Vec<TextElement>)
```

**Purpose**: Stores freshly submitted composer text as the current answer draft and mirrors it back into the composer. This keeps saved state and visible text in sync after submission.

**Data flow**: It receives submitted text and text elements, reads local image paths from the composer, writes a draft with no pending pastes into the current answer, updates composer content, moves the cursor, and clears composer footer hints.

**Call relations**: Composer result handling calls this when there is no saved pending-submission draft override.

*Call graph*: calls 5 internal fn (local_images, move_cursor_to_end, set_footer_hint_override, set_text_content, current_answer_mut); called by 1 (handle_composer_input_result); 1 external calls (new).


##### `RequestUserInputOverlay::apply_submission_draft`  (lines 1087–1096)

```
fn apply_submission_draft(&mut self, draft: ComposerDraft)
```

**Purpose**: Applies a complete saved draft after submission. This path preserves details such as pending paste data.

**Data flow**: It receives a `ComposerDraft`, stores a clone in the current answer, writes its text, elements, images, and pending pastes into the composer, moves the cursor, and clears composer footer hints.

**Call relations**: Composer result handling calls this when `handle_key_event` captured a draft before passing a submit key to the composer.

*Call graph*: calls 5 internal fn (move_cursor_to_end, set_footer_hint_override, set_pending_pastes, set_text_content, current_answer_mut); called by 1 (handle_composer_input_result); 2 external calls (new, clone).


##### `RequestUserInputOverlay::handle_composer_input_result`  (lines 1098–1136)

```
fn handle_composer_input_result(&mut self, result: InputResult) -> bool
```

**Purpose**: Interprets what the text composer says happened after a key press. When text was submitted or queued, it marks the answer committed and moves forward.

**Data flow**: It receives an `InputResult`. For submitted or queued text, it updates option selection if notes were typed, sets committed status, applies the draft or submitted text, calls the next-or-submit flow, and returns true. Other results return false.

**Call relations**: The main key handler calls this after giving a key event to the composer.

*Call graph*: calls 6 internal fn (apply_submission_draft, apply_submission_to_draft, current_answer_mut, go_next_or_submit, has_options, options_len); called by 1 (handle_key_event); 1 external calls (matches!).


##### `RequestUserInputOverlay::handle_confirm_unanswered_key_event`  (lines 1138–1178)

```
fn handle_confirm_unanswered_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Handles keyboard input while the unanswered-question confirmation menu is open. It lets the user move between the two choices, submit anyway, or go back.

**Data flow**: It receives a key event, ignores key releases or inactive state, then updates the confirmation selection, closes the menu, submits answers, or jumps to the first unanswered question depending on the key.

**Call relations**: The main key handler delegates to this whenever `confirm_unanswered_active` is true.

*Call graph*: calls 4 internal fn (close_unanswered_confirmation, first_unanswered_index, jump_to_question, submit_answers); called by 1 (handle_key_event); 1 external calls (matches!).


##### `RequestUserInputOverlay::prefer_esc_to_handle_key_event`  (lines 1182–1184)

```
fn prefer_esc_to_handle_key_event(&self) -> bool
```

**Purpose**: Tells the broader UI that this overlay wants first chance to handle Escape. That matters because Escape can clear notes or interrupt the request.

**Data flow**: It takes no extra input and always returns true.

**Call relations**: The surrounding input-dispatch system can use this preference before routing Escape elsewhere.


##### `RequestUserInputOverlay::handle_key_event`  (lines 1186–1422)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: This is the main keyboard controller for the overlay. It routes keys to confirmation menus, option navigation, notes editing, submission, question movement, and interruption.

**Data flow**: It receives a key event, ignores releases, snoozes auto-resolution, then checks special states first: confirmation menu, Escape clearing notes, interrupt bindings, submit bindings, and question navigation. It then applies option-list behavior or forwards notes keys into the composer, updating answer state and drafts as needed.

**Call relations**: The terminal input loop calls this for key presses. It delegates smaller jobs to helpers such as draft saving, selection, composer handling, unanswered confirmation, and submit flow.

*Call graph*: calls 23 internal fn (interrupt, current_text_with_pending, handle_key_event, capture_composer_draft, clear_notes_and_focus_options, clear_selection, confirm_unanswered_active, current_answer_mut, ensure_selected_for_notes, focus_is_notes (+13 more)); 1 external calls (matches!).


##### `RequestUserInputOverlay::terminal_title_requires_action`  (lines 1424–1426)

```
fn terminal_title_requires_action(&self) -> bool
```

**Purpose**: Reports that this overlay represents something requiring user action. The terminal title can use this to signal attention is needed.

**Data flow**: It takes no extra input and always returns true.

**Call relations**: The surrounding UI can query this while deciding how to label or decorate the terminal.


##### `RequestUserInputOverlay::on_ctrl_c`  (lines 1428–1447)

```
fn on_ctrl_c(&mut self) -> CancellationEvent
```

**Purpose**: Handles Ctrl-C while the overlay is active. It either clears typed notes, closes confirmation and interrupts, or interrupts the whole request.

**Data flow**: It checks whether confirmation is open, then whether notes focus has text. It may close confirmation, clear notes, or send an interrupt event and mark the overlay done. It returns that the cancellation was handled.

**Call relations**: The outer cancellation handling calls this when Ctrl-C is pressed.

*Call graph*: calls 6 internal fn (interrupt, current_text_with_pending, clear_notes_draft, close_unanswered_confirmation, confirm_unanswered_active, focus_is_notes).


##### `RequestUserInputOverlay::is_complete`  (lines 1449–1451)

```
fn is_complete(&self) -> bool
```

**Purpose**: Reports whether the overlay has finished and can be removed. Completion happens after submission, dismissal, auto-resolution, or interruption.

**Data flow**: It reads the `done` flag and returns it.

**Call relations**: The surrounding UI uses this to know when to stop showing the overlay.


##### `RequestUserInputOverlay::handle_paste`  (lines 1453–1467)

```
fn handle_paste(&mut self, pasted: String) -> bool
```

**Purpose**: Handles pasted text. Pasting counts as user activity, switches to notes if needed, and marks the answer as not yet committed.

**Data flow**: It receives pasted text, rejects empty pastes, snoozes auto-resolution, moves focus to notes if currently on options, makes notes visible, clears committed status, and forwards the paste to the composer. It returns whether the composer accepted it.

**Call relations**: The terminal paste handling path calls this instead of treating paste as ordinary key presses.

*Call graph*: calls 4 internal fn (handle_paste, current_answer_mut, ensure_selected_for_notes, snooze_auto_resolution); 1 external calls (matches!).


##### `RequestUserInputOverlay::flush_paste_burst_if_due`  (lines 1469–1471)

```
fn flush_paste_burst_if_due(&mut self) -> bool
```

**Purpose**: Asks the composer to finish a buffered paste burst if its delay has expired. Paste bursts group rapid paste chunks together.

**Data flow**: It calls the composer paste-burst flush method and returns whether anything was flushed.

**Call relations**: The broader UI loop can call this periodically while paste buffering is active.

*Call graph*: calls 1 internal fn (flush_paste_burst_if_due).


##### `RequestUserInputOverlay::is_in_paste_burst`  (lines 1473–1475)

```
fn is_in_paste_burst(&self) -> bool
```

**Purpose**: Reports whether the composer is currently buffering a paste burst. This helps the UI know whether delayed paste work is still pending.

**Data flow**: It asks the composer for its paste-burst state and returns that boolean.

**Call relations**: The surrounding event loop can query this while scheduling paste-related work.

*Call graph*: calls 1 internal fn (is_in_paste_burst).


##### `RequestUserInputOverlay::pre_draw_tick`  (lines 1477–1479)

```
fn pre_draw_tick(&mut self, now: Instant) -> bool
```

**Purpose**: Runs time-based work just before drawing. In this chunk, that means checking whether auto-resolution should submit now.

**Data flow**: It receives the current time, calls `maybe_auto_resolve_at`, and returns whether the overlay changed.

**Call relations**: The render loop calls this before drawing a frame.

*Call graph*: calls 1 internal fn (maybe_auto_resolve_at).


##### `RequestUserInputOverlay::next_frame_delay`  (lines 1481–1483)

```
fn next_frame_delay(&self) -> Option<Duration>
```

**Purpose**: Tells the UI loop when the next redraw is needed for timer reasons. If no auto-resolution timer is active, it returns nothing.

**Data flow**: It reads the current time, delegates to `auto_resolution_next_frame_delay_at`, and returns the optional delay.

**Call relations**: The outer rendering scheduler calls this to avoid waking too often or too late.

*Call graph*: calls 1 internal fn (auto_resolution_next_frame_delay_at); 1 external calls (now).


##### `RequestUserInputOverlay::try_consume_user_input_request`  (lines 1485–1491)

```
fn try_consume_user_input_request(
        &mut self,
        request: ToolRequestUserInputParams,
    ) -> Option<ToolRequestUserInputParams>
```

**Purpose**: Accepts another user-input request while one is already active by placing it at the back of the queue. This preserves arrival order.

**Data flow**: It receives a request, pushes it into the queue, and returns `None` to show it was consumed by this overlay rather than handled elsewhere.

**Call relations**: The app request dispatcher calls this when a new user-input request arrives during an existing one.

*Call graph*: 1 external calls (push_back).


##### `RequestUserInputOverlay::dismiss_app_server_request`  (lines 1493–1495)

```
fn dismiss_app_server_request(&mut self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Lets the app server dismiss a request from this overlay. It is the public-facing wrapper around the resolved-request dismissal logic.

**Data flow**: It receives a resolved server request, passes it to `dismiss_resolved_request`, and returns whether the overlay changed.

**Call relations**: The surrounding app-server request handling calls this when it learns a pending request has been resolved elsewhere.

*Call graph*: calls 1 internal fn (dismiss_resolved_request).


##### `tests::test_sender`  (lines 1513–1519)

```
fn test_sender() -> (
        AppEventSender,
        tokio::sync::mpsc::UnboundedReceiver<AppEvent>,
    )
```

**Purpose**: Creates a test event sender and receiver pair. Tests use it to inspect what events the overlay emits.

**Data flow**: It creates an unbounded channel, wraps the sender in `AppEventSender`, and returns both sender and raw receiver.

**Call relations**: Many tests call this before constructing an overlay.

*Call graph*: calls 1 internal fn (new).


##### `tests::expect_interrupt_only`  (lines 1521–1531)

```
fn expect_interrupt_only(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>)
```

**Purpose**: Checks that the overlay emitted exactly one interrupt event and nothing else. This protects interruption behavior from accidental extra events.

**Data flow**: It receives a test receiver, pulls one event, verifies it is an interrupt operation, then verifies no further events are immediately available.

**Call relations**: The interrupt test calls this after pressing Escape.

*Call graph*: 4 external calls (try_recv, assert!, assert_eq!, panic!).


##### `tests::question_with_options`  (lines 1533–1555)

```
fn question_with_options(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

**Purpose**: Builds a simple sample question with three choices. It keeps tests short and consistent.

**Data flow**: It receives an ID and header, fills in standard question text and three option records, and returns a `ToolRequestUserInputQuestion`.

**Call relations**: Many tests use this helper when they need a normal option-based question.

*Call graph*: 1 external calls (vec!).


##### `tests::question_with_options_and_other`  (lines 1557–1579)

```
fn question_with_options_and_other(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

**Purpose**: Builds a sample option question that also allows an `Other` choice. Tests use it for behavior involving the extra synthetic option.

**Data flow**: It receives an ID and header, creates a question with `is_other` set to true and three normal options, and returns it.

**Call relations**: Tests that need the `Other` option can call this instead of duplicating setup.

*Call graph*: 1 external calls (vec!).


##### `tests::question_with_wrapped_options`  (lines 1581–1609)

```
fn question_with_wrapped_options(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

**Purpose**: Builds a sample question whose option descriptions are long enough to wrap. This helps test layout behavior.

**Data flow**: It receives an ID and header, creates a question with three descriptive options, and returns it.

**Call relations**: Snapshot and layout tests use this kind of data to verify wrapped option rows.

*Call graph*: 1 external calls (vec!).


##### `tests::question_with_very_long_option_text`  (lines 1611–1629)

```
fn question_with_very_long_option_text(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

**Purpose**: Builds a sample question with an unusually long option label and description. This stresses the interface's text wrapping.

**Data flow**: It receives an ID and header, creates a two-option question with one very long label, and returns it.

**Call relations**: Tests can use this helper to catch rendering problems with long single-line labels.

*Call graph*: 1 external calls (vec!).


##### `tests::question_with_long_scroll_options`  (lines 1631–1660)

```
fn question_with_long_scroll_options(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

**Purpose**: Builds a sample question with several very verbose option descriptions. This is useful for testing scrolling and keeping the selected row visible.

**Data flow**: It receives an ID and header, creates four options with long explanatory descriptions, and returns the question.

**Call relations**: Layout and scrolling tests use this to exercise constrained terminal sizes.

*Call graph*: 1 external calls (vec!).


##### `tests::question_without_options`  (lines 1662–1671)

```
fn question_without_options(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

**Purpose**: Builds a free-form sample question with no choices. Tests use it for notes-only answer behavior.

**Data flow**: It receives an ID and header, creates a question with `options` set to none, and returns it.

**Call relations**: Tests that need composer-only input use this helper.


##### `tests::request_event`  (lines 1673–1684)

```
fn request_event(
        turn_id: &str,
        questions: Vec<ToolRequestUserInputQuestion>,
    ) -> ToolRequestUserInputParams
```

**Purpose**: Builds a sample user-input request around a list of questions. It supplies stable thread and item IDs for tests.

**Data flow**: It receives a turn ID and question list, fills in request metadata, sets auto-resolution to absent, and returns the request.

**Call relations**: Most tests use this to create requests before constructing an overlay.


##### `tests::request_event_with_auto_resolution`  (lines 1686–1693)

```
fn request_event_with_auto_resolution(
        turn_id: &str,
        questions: Vec<ToolRequestUserInputQuestion>,
    ) -> ToolRequestUserInputParams
```

**Purpose**: Builds a sample request with auto-resolution enabled. Tests use it to check countdown and expiry behavior.

**Data flow**: It receives a turn ID and questions, starts from `request_event`, sets `auto_resolution_ms` to a value, and returns the modified request.

**Call relations**: Auto-resolution tests call this helper instead of hand-writing the request.

*Call graph*: 1 external calls (request_event).


##### `tests::snapshot_buffer`  (lines 1695–1705)

```
fn snapshot_buffer(buf: &Buffer) -> String
```

**Purpose**: Turns a terminal render buffer into plain text for snapshot assertions. This makes UI output easy to compare in tests.

**Data flow**: It receives a buffer, walks every cell in row order, takes the first character from each cell's symbol, joins rows with newlines, and returns the resulting string.

**Call relations**: Snapshot rendering helpers call this after drawing the overlay into a buffer.

*Call graph*: 3 external calls (area, new, new).


##### `tests::render_snapshot`  (lines 1707–1709)

```
fn render_snapshot(overlay: &RequestUserInputOverlay, area: Rect) -> String
```

**Purpose**: Renders the overlay at the current time and returns a text snapshot. It is the simple snapshot helper for tests that do not care about time.

**Data flow**: It receives an overlay and rectangle, gets the current instant, delegates to `render_snapshot_at`, and returns the snapshot string.

**Call relations**: Snapshot tests can call this when timer state is not important.

*Call graph*: 2 external calls (now, render_snapshot_at).


##### `tests::render_snapshot_at`  (lines 1711–1715)

```
fn render_snapshot_at(overlay: &RequestUserInputOverlay, area: Rect, now: Instant) -> String
```

**Purpose**: Renders the overlay at a chosen time and returns a text snapshot. This lets tests control countdown display.

**Data flow**: It receives an overlay, drawing area, and instant, creates an empty buffer, asks the overlay to render into it at that time, and converts the buffer to text.

**Call relations**: Auto-resolution and UI snapshot tests call this when they need deterministic rendering.

*Call graph*: 3 external calls (empty, render_ui_at, snapshot_buffer).


##### `tests::queued_requests_are_fifo`  (lines 1718–1741)

```
fn queued_requests_are_fifo()
```

**Purpose**: Verifies that queued user-input requests are processed in first-in, first-out order. This matters when multiple prompts arrive before the user finishes the first one.

**Data flow**: It creates an overlay, queues two more requests, submits the current request twice, and checks that the active turn IDs advance from the second to the third request.

**Call relations**: This test exercises `try_consume_user_input_request`, `submit_answers`, and queue advancement together.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, request_event, test_sender, vec!).


##### `tests::interrupt_discards_queued_requests_and_emits_interrupt`  (lines 1744–1772)

```
fn interrupt_discards_queued_requests_and_emits_interrupt()
```

**Purpose**: Verifies that interrupting the overlay ends it and emits only an interrupt event, even when requests are queued. This protects cancellation behavior.

**Data flow**: It creates an overlay, queues two requests, sends an Escape key event, checks the overlay is done, and checks the event receiver saw only an interrupt.

**Call relations**: This test drives the main key handler and then uses `expect_interrupt_only` to validate emitted events.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, expect_interrupt_only, request_event, test_sender, vec!).


##### `tests::auto_resolution_absent_has_no_timer`  (lines 1775–1792)

```
fn auto_resolution_absent_has_no_timer()
```

**Purpose**: Verifies that ordinary requests without auto-resolution do not schedule or display any timer. This prevents countdown UI from appearing by accident.

**Data flow**: It creates an overlay from a normal request, checks timing is disabled, checks there is no next-frame delay, and checks there is no countdown text.

**Call relations**: This test directly exercises the auto-resolution timing, scheduling, and text helpers.

*Call graph*: calls 1 internal fn (new); 5 external calls (now, assert_eq!, request_event, test_sender, vec!).


##### `tests::auto_resolution_hides_timer_during_grace_period`  (lines 1795–1823)

```
fn auto_resolution_hides_timer_during_grace_period()
```

**Purpose**: Verifies that auto-resolution exists but is not shown during its initial hidden grace period. The user gets a short quiet period before the countdown appears.

**Data flow**: It creates an auto-resolving overlay, sets the request start time, checks the timing state and next-frame delay, renders a snapshot, and confirms the countdown text is absent.

**Call relations**: This test combines request construction, timer calculation, redraw delay, and snapshot rendering.

*Call graph*: calls 1 internal fn (new); 6 external calls (now, assert!, assert_eq!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::auto_resolution_visible_countdown_snapshot`  (lines 1826–1849)

```
fn auto_resolution_visible_countdown_snapshot()
```

**Purpose**: Checks that an auto-resolving prompt shows the visible countdown once the hidden grace period has passed. This protects the screen text users rely on before the prompt answers itself.

**Data flow**: It builds an overlay with three option questions, rewinds the request start time to the end of the hidden grace period, renders the overlay at a fixed size and time, and compares the result to a saved snapshot.

**Call relations**: The test runner calls this test. The test creates the overlay through RequestUserInputOverlay::new, feeds it a request with auto-resolution, then hands the rendered view to the snapshot assertion.

*Call graph*: calls 1 internal fn (new); 5 external calls (now, assert_snapshot!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::auto_resolution_visible_countdown_is_red`  (lines 1852–1889)

```
fn auto_resolution_visible_countdown_is_red()
```

**Purpose**: Verifies that the countdown warning is colored red, while normal progress text is not. This makes sure the urgent part of the prompt stands out visually.

**Data flow**: It creates an auto-resolving overlay, sets its timer to the visible countdown phase, renders into a terminal buffer, finds the countdown text, and checks each countdown cell has a red foreground color while the nearby prefix does not.

**Call relations**: The test runner invokes it as a rendering-style check. It uses the overlay's timed rendering path and then inspects the raw buffer instead of only comparing text.

*Call graph*: calls 1 internal fn (new); 9 external calls (empty, now, new, assert_eq!, assert_ne!, request_event_with_auto_resolution, snapshot_buffer, test_sender, vec!).


##### `tests::auto_resolution_expiry_emits_empty_answer`  (lines 1892–1923)

```
fn auto_resolution_expiry_emits_empty_answer()
```

**Purpose**: Confirms that when an auto-resolving prompt expires without user input, the overlay sends an empty answer and records a history item. This ensures unattended prompts still complete cleanly.

**Data flow**: It creates a timed request, moves its start time back past the full timeout, runs the pre-draw tick, and reads the event channel. The output is a UserInputAnswer with the correct turn id and no answers, followed by a history-cell event.

**Call relations**: The test runner calls it. The test exercises pre_draw_tick, which is the overlay's periodic check before drawing, and observes the application events emitted through the test sender.

*Call graph*: calls 1 internal fn (new); 7 external calls (now, assert!, assert_eq!, panic!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::auto_resolution_key_interaction_snoozes_timer`  (lines 1926–1950)

```
fn auto_resolution_key_interaction_snoozes_timer()
```

**Purpose**: Checks that pressing a key disables the auto-resolution timer. This prevents the app from submitting an empty answer while the user is actively interacting.

**Data flow**: It creates an auto-resolving overlay, puts it into the visible countdown phase, sends a Down key, then asks what the timer would do after the timeout. The result is that auto-resolution is disabled, no tick completes the overlay, and no event is emitted.

**Call relations**: The test runner calls this input-behavior test. It drives handle_key_event and then confirms pre_draw_tick no longer submits anything.

*Call graph*: calls 1 internal fn (new); 7 external calls (now, from, assert!, assert_eq!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::auto_resolution_paste_interaction_snoozes_timer`  (lines 1953–1977)

```
fn auto_resolution_paste_interaction_snoozes_timer()
```

**Purpose**: Checks that pasting text also disables the auto-resolution timer. A paste is treated as user activity, just like a key press.

**Data flow**: It starts an auto-resolving overlay, simulates a paste, then checks the later timer state. The overlay reports auto-resolution disabled, the pre-draw tick does not finish it, and the event receiver stays empty.

**Call relations**: The test runner invokes it. The test uses handle_paste to enter text and then verifies the timer path with auto_resolution_timing_at and pre_draw_tick.

*Call graph*: calls 1 internal fn (new); 6 external calls (now, assert!, assert_eq!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::auto_resolution_resets_for_queued_request`  (lines 1980–2012)

```
fn auto_resolution_resets_for_queued_request()
```

**Purpose**: Ensures that when one timed prompt expires and another prompt is waiting, the new prompt gets a fresh timer. This avoids carrying the old prompt's expired timer into the next question.

**Data flow**: It creates one timed request, queues a second, forces the first to expire, and runs the tick. The overlay advances to the second request, clears the snooze flag, starts in the hidden grace phase, remains open, and emits events for the expired first request.

**Call relations**: The test runner calls it. It combines request queuing through try_consume_user_input_request with timeout processing through pre_draw_tick.

*Call graph*: calls 1 internal fn (new); 6 external calls (now, assert!, assert_eq!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::resolved_request_dismisses_overlay_without_emitting_events`  (lines 2015–2041)

```
fn resolved_request_dismisses_overlay_without_emitting_events()
```

**Purpose**: Checks that if the server says the current request has already been resolved, the overlay closes without sending an answer or interrupt. This prevents duplicate or stale responses.

**Data flow**: It builds an overlay for a request, passes in a matching resolved-request notice, and then checks the overlay is marked done. The event channel remains empty.

**Call relations**: The test runner invokes it. It exercises dismiss_app_server_request as the path for server-side cleanup.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, test_sender, vec!).


##### `tests::resolved_current_request_advances_to_next_same_turn_prompt`  (lines 2044–2081)

```
fn resolved_current_request_advances_to_next_same_turn_prompt()
```

**Purpose**: Verifies that resolving the current prompt can reveal a newer queued prompt from the same turn. The overlay should not disappear if there is still another question waiting.

**Data flow**: It creates a current request, queues a second request with the same turn id, dismisses the first by call id, and checks that the overlay now points at the second request. No event is sent.

**Call relations**: The test runner calls it. It checks the interaction between queued prompts and dismiss_app_server_request.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, test_sender, vec!).


##### `tests::resolved_queued_request_removes_only_that_prompt`  (lines 2084–2136)

```
fn resolved_queued_request_removes_only_that_prompt()
```

**Purpose**: Checks that dismissing a queued prompt removes only that prompt, not the active one or other queued prompts. This keeps the prompt queue consistent when stale requests are resolved out of order.

**Data flow**: It creates one active request and two queued requests, dismisses the middle queued one, then submits the active request. The overlay advances to the remaining queued request and emits the normal answer and history events for the submitted active request.

**Call relations**: The test runner invokes it. It uses dismiss_app_server_request to remove a queued item, then uses submit_answers to prove the active flow still works.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, test_sender, vec!).


##### `tests::options_can_submit_empty_when_unanswered`  (lines 2139–2158)

```
fn options_can_submit_empty_when_unanswered()
```

**Purpose**: Confirms that submitting an option question without choosing an option sends an empty answer list. This defines the meaning of an unanswered option prompt at final submission.

**Data flow**: It creates a one-question option overlay, calls submit_answers immediately, reads the emitted UserInputAnswer, and checks that question q1 has an empty list of answers.

**Call relations**: The test runner calls it. It directly exercises the final submission path rather than key-based selection.

*Call graph*: calls 1 internal fn (new); 5 external calls (assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::enter_commits_default_selection_on_last_option_question`  (lines 2161–2179)

```
fn enter_commits_default_selection_on_last_option_question()
```

**Purpose**: Checks that pressing Enter on a single option question submits the default highlighted option. This makes Enter useful without requiring an extra selection key.

**Data flow**: It creates one option question, sends Enter, receives the answer event, and verifies the submitted answer is Option 1.

**Call relations**: The test runner invokes it. It goes through handle_key_event, which commits the current option and submits because this is the last question.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::enter_commits_default_selection_on_non_last_option_question`  (lines 2182–2227)

```
fn enter_commits_default_selection_on_non_last_option_question()
```

**Purpose**: Checks that pressing Enter on an earlier option question commits it and moves forward, instead of submitting the whole form too soon. The full answer is only sent after the last question is also committed.

**Data flow**: It creates two option questions, presses Enter once, and sees the first answer committed while no event is emitted. After pressing Enter again, it receives a response containing Option 1 for both questions.

**Call relations**: The test runner calls it. It exercises the multi-question flow through handle_key_event and event-channel output.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, from, assert!, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::number_keys_select_and_submit_options`  (lines 2230–2248)

```
fn number_keys_select_and_submit_options()
```

**Purpose**: Verifies that number keys choose and submit matching options. This supports quick keyboard-only answering.

**Data flow**: It creates a one-question option overlay, presses the '2' key, then reads the emitted response. The answer for q1 is Option 2.

**Call relations**: The test runner invokes it. It drives the overlay through handle_key_event and checks the submitted application event.

*Call graph*: calls 1 internal fn (new); 7 external calls (Char, from, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::vim_keys_move_option_selection`  (lines 2251–2270)

```
fn vim_keys_move_option_selection()
```

**Purpose**: Checks that the Vim-style keys j and k move the highlighted option down and up. This supports users who expect those navigation keys.

**Data flow**: It starts with the first option highlighted, sends 'j' and sees the second option highlighted, then sends 'k' and sees the first option highlighted again.

**Call relations**: The test runner calls it. The test focuses on handle_key_event changing the current answer's option-selection state.

*Call graph*: calls 1 internal fn (new); 6 external calls (Char, from, assert_eq!, request_event, test_sender, vec!).


##### `tests::typing_in_options_does_not_open_notes`  (lines 2273–2296)

```
fn typing_in_options_does_not_open_notes()
```

**Purpose**: Ensures ordinary letter typing while focused on options does not accidentally open the notes editor. This prevents stray key presses from changing modes or adding hidden text.

**Data flow**: It creates two option questions, confirms it is on the first question with notes hidden, sends the 'x' key, and checks it is still on the same question, still focused on options, with an empty composer.

**Call relations**: The test runner invokes it. It tests the option-mode branch of handle_key_event.

*Call graph*: calls 1 internal fn (new); 7 external calls (Char, from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::h_l_move_between_questions_in_options`  (lines 2299–2320)

```
fn h_l_move_between_questions_in_options()
```

**Purpose**: Checks that h and l move between questions while the overlay is in option mode. These are Vim-style left and right navigation keys.

**Data flow**: It creates two option questions, starts on the first, sends 'l' to move to the second, then sends 'h' to return to the first.

**Call relations**: The test runner calls it. It verifies handle_key_event delegates these keys to question navigation.

*Call graph*: calls 1 internal fn (new); 6 external calls (Char, from, assert_eq!, request_event, test_sender, vec!).


##### `tests::left_right_move_between_questions_in_options`  (lines 2323–2344)

```
fn left_right_move_between_questions_in_options()
```

**Purpose**: Checks that the Left and Right arrow keys move between option questions. This gives users a familiar way to navigate the form.

**Data flow**: It creates two option questions, sends Right to advance to the second, then Left to move back to the first.

**Call relations**: The test runner invokes it. It tests the arrow-key path through handle_key_event.

*Call graph*: calls 1 internal fn (new); 5 external calls (from, assert_eq!, request_event, test_sender, vec!).


##### `tests::horizontal_list_keys_move_between_questions_in_options`  (lines 2347–2368)

```
fn horizontal_list_keys_move_between_questions_in_options()
```

**Purpose**: Verifies that Control-L and Control-H move between questions in option mode. These shortcuts match horizontal list navigation elsewhere in the terminal UI.

**Data flow**: It starts on the first of two option questions, sends Control-L and sees the second question, then sends Control-H and sees the first again.

**Call relations**: The test runner calls it. It checks handle_key_event with modified key events.

*Call graph*: calls 1 internal fn (new); 6 external calls (Char, new, assert_eq!, request_event, test_sender, vec!).


##### `tests::options_notes_focus_hides_question_navigation_tip`  (lines 2371–2405)

```
fn options_notes_focus_hides_question_navigation_tip()
```

**Purpose**: Checks that the footer tips change when the user switches from option selection to notes entry. In notes mode, question-navigation hints are hidden because the text box needs the user's attention.

**Data flow**: It reads the footer tips in option mode, then presses Tab to open notes and reads the tips again. The before state includes question navigation; the after state shows only notes-clearing and submit guidance.

**Call relations**: The test runner invokes it. It combines handle_key_event with footer_tips, the function that prepares help text for the bottom of the overlay.

*Call graph*: calls 1 internal fn (new); 5 external calls (from, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_shows_ctrl_p_and_ctrl_n_question_navigation_tip`  (lines 2408–2435)

```
fn freeform_shows_ctrl_p_and_ctrl_n_question_navigation_tip()
```

**Purpose**: Verifies that free-text questions show the correct shortcut tip for moving between questions. Control-P and Control-N are the advertised previous and next shortcuts in this mode.

**Data flow**: It creates an overlay with an option question and a free-text question, moves to the free-text question, then reads footer tips. The tips include submit, Control-P/Control-N navigation, and interrupt.

**Call relations**: The test runner calls it. It uses move_question to enter freeform mode and footer_tips to check the displayed guidance.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_footer_shows_configured_submit_binding`  (lines 2438–2457)

```
fn freeform_footer_shows_configured_submit_binding()
```

**Purpose**: Checks that the footer shows a customized submit shortcut for free-text questions. This keeps on-screen help aligned with the user's key settings.

**Data flow**: It changes the runtime keymap so composer submit is Control-J, creates a free-text overlay with that keymap, then checks the footer says 'ctrl + j to submit answer'.

**Call relations**: The test runner invokes it. It uses new_with_keymap to pass custom keyboard settings into the overlay and then checks footer_tips.

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 4 external calls (assert_eq!, request_event, test_sender, vec!).


##### `tests::request_user_input_uses_remapped_interrupt_binding_while_notes_are_visible`  (lines 2460–2491)

```
fn request_user_input_uses_remapped_interrupt_binding_while_notes_are_visible()
```

**Purpose**: Ensures the overlay respects a customized interrupt key even while the notes editor is open. This lets users cancel reliably with their configured shortcut.

**Data flow**: It sets the interrupt key to F12, opens notes for an option answer, checks the footer advertises F12, presses F12, and verifies the overlay closes with only an interrupt event.

**Call relations**: The test runner calls it. It combines keymap setup, notes-mode input handling, footer help, and event output validation.

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 7 external calls (F, from, assert_eq!, expect_interrupt_only, request_event, test_sender, vec!).


##### `tests::tab_opens_notes_when_option_selected`  (lines 2494–2510)

```
fn tab_opens_notes_when_option_selected()
```

**Purpose**: Checks that Tab opens the notes editor after an option has been selected. This supports adding extra explanation to a chosen option.

**Data flow**: It creates an option question, marks the second option selected, confirms notes are hidden, presses Tab, and then checks notes are visible and focused.

**Call relations**: The test runner invokes it. It drives the mode switch through handle_key_event.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::switching_to_options_resets_notes_focus_when_notes_hidden`  (lines 2513–2534)

```
fn switching_to_options_resets_notes_focus_when_notes_hidden()
```

**Purpose**: Verifies that moving from a free-text question to an option question resets focus to the option list when notes are not visible. This prevents the overlay from staying in a text-entry mode that no longer matches the question.

**Data flow**: It starts on a free-text question with notes focus, moves to an option question, and checks focus is now Options and the notes UI remains hidden.

**Call relations**: The test runner calls it. It exercises move_question and checks the resulting focus state.

*Call graph*: calls 1 internal fn (new); 5 external calls (assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::switching_from_freeform_with_text_resets_focus_and_keeps_last_option_empty`  (lines 2537–2580)

```
fn switching_from_freeform_with_text_resets_focus_and_keeps_last_option_empty()
```

**Purpose**: Checks that uncommitted free-text draft text is not treated as an answer when switching to an option question. The user must explicitly commit free text before it counts.

**Data flow**: It types draft text into a freeform question, moves to an option question, submits once and gets an unanswered confirmation, chooses option 1, submits, and verifies q1 is empty while q2 contains Option 1.

**Call relations**: The test runner invokes it. It tests how composer draft state, question movement, confirmation, option selection, and final submission interact.

*Call graph*: calls 1 internal fn (new); 9 external calls (Char, from, new, assert!, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::esc_in_notes_mode_without_options_interrupts`  (lines 2583–2597)

```
fn esc_in_notes_mode_without_options_interrupts()
```

**Purpose**: Checks that Escape cancels a plain free-text prompt. With no option list to return to, Escape means interrupt.

**Data flow**: It creates a free-text-only overlay, presses Escape, then checks the overlay is done and the event channel contains only an interrupt.

**Call relations**: The test runner calls it. It exercises the Escape branch of handle_key_event for freeform prompts.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert_eq!, expect_interrupt_only, request_event, test_sender, vec!).


##### `tests::esc_in_options_mode_interrupts`  (lines 2600–2614)

```
fn esc_in_options_mode_interrupts()
```

**Purpose**: Checks that Escape cancels an option prompt when the user is focused on the option list. This gives a consistent way to stop the request.

**Data flow**: It creates an option-only overlay, presses Escape, and verifies the overlay closes with only an interrupt event.

**Call relations**: The test runner invokes it. It drives handle_key_event and validates the emitted event with expect_interrupt_only.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert_eq!, expect_interrupt_only, request_event, test_sender, vec!).


##### `tests::esc_in_notes_mode_clears_notes_and_hides_ui`  (lines 2617–2642)

```
fn esc_in_notes_mode_clears_notes_and_hides_ui()
```

**Purpose**: Checks that Escape inside option notes clears the notes area and returns to option focus instead of canceling the whole prompt. This lets the user back out of notes safely.

**Data flow**: It selects and commits an option, opens notes, presses Escape, and checks the overlay is still open, notes are hidden and empty, the selected option remains, the committed flag is reset, and no event is sent.

**Call relations**: The test runner calls it. It tests the notes-mode Escape behavior through handle_key_event.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::esc_in_notes_mode_with_text_clears_notes_and_hides_ui`  (lines 2645–2671)

```
fn esc_in_notes_mode_with_text_clears_notes_and_hides_ui()
```

**Purpose**: Checks the same Escape behavior when notes contain typed text. The text should be discarded and the user should return to the option list without submitting anything.

**Data flow**: It selects an option, opens notes, types a character, presses Escape, and verifies the overlay stays open, notes are hidden and cleared, the option selection remains, and no event appears.

**Call relations**: The test runner invokes it. It combines notes typing and Escape handling in handle_key_event.

*Call graph*: calls 1 internal fn (new); 7 external calls (Char, from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::esc_drops_committed_answers`  (lines 2674–2699)

```
fn esc_drops_committed_answers()
```

**Purpose**: Verifies that canceling a multi-question prompt discards already committed partial answers. An interrupt should not send half-completed form data.

**Data flow**: It creates an option question followed by a free-text question, presses Enter to commit the first answer, then presses Escape. The only emitted event is an interrupt.

**Call relations**: The test runner calls it. It checks that handle_key_event's submit-progress path and interrupt path do not mix.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, expect_interrupt_only, request_event, test_sender, vec!).


##### `tests::backspace_in_options_clears_selection`  (lines 2702–2720)

```
fn backspace_in_options_clears_selection()
```

**Purpose**: Checks that Backspace in option mode clears the current option selection. This gives users a way to return a question to unanswered.

**Data flow**: It preselects the second option, presses Backspace, and verifies the selected index becomes empty, notes stay hidden, and no event is emitted.

**Call relations**: The test runner invokes it. It tests the option-mode Backspace branch of handle_key_event.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::backspace_on_empty_notes_closes_notes_ui`  (lines 2723–2746)

```
fn backspace_on_empty_notes_closes_notes_ui()
```

**Purpose**: Checks that Backspace in an empty notes box closes notes and returns to the option list. It should not clear the selected option.

**Data flow**: It selects an option, opens notes, presses Backspace with no notes text, and checks focus returns to Options, notes are hidden, the option remains selected, and no event is sent.

**Call relations**: The test runner calls it. It exercises notes-mode Backspace behavior through handle_key_event.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::tab_in_notes_clears_notes_and_hides_ui`  (lines 2749–2775)

```
fn tab_in_notes_clears_notes_and_hides_ui()
```

**Purpose**: Verifies that pressing Tab while editing notes cancels the notes entry and hides the notes UI. This mirrors the advertised footer hint.

**Data flow**: It selects an option, opens notes, inserts note text directly into the composer, presses Tab, then checks focus is back on options, notes and composer text are cleared, the option remains selected, and no event is emitted.

**Call relations**: The test runner invokes it. It checks how handle_key_event syncs composer text back into answer draft state when leaving notes.

*Call graph*: calls 1 internal fn (new); 7 external calls (from, new, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::skipped_option_questions_count_as_unanswered`  (lines 2778–2789)

```
fn skipped_option_questions_count_as_unanswered()
```

**Purpose**: Checks that an untouched option question counts as unanswered. This supports confirmation prompts for incomplete forms.

**Data flow**: It creates one option question and immediately asks the overlay for its unanswered count. The count is one.

**Call relations**: The test runner calls it. It exercises unanswered_count on a fresh overlay.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, request_event, test_sender, vec!).


##### `tests::highlighted_option_questions_are_unanswered`  (lines 2792–2805)

```
fn highlighted_option_questions_are_unanswered()
```

**Purpose**: Verifies that merely highlighting an option does not count as answering it. The user must commit the selection.

**Data flow**: It creates an option question, sets the highlighted selection to the first option, and checks unanswered_count still returns one.

**Call relations**: The test runner invokes it. It checks the distinction between option highlight state and committed answer state.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_requires_enter_with_text_to_mark_answered`  (lines 2808–2834)

```
fn freeform_requires_enter_with_text_to_mark_answered()
```

**Purpose**: Checks that free-text draft content only counts as answered after the user presses Enter. This prevents unsubmitted text from being treated as final.

**Data flow**: It puts draft text into the first of two free-text questions, sees both questions still unanswered, presses Enter, and then sees the first answer marked committed and only one question left unanswered.

**Call relations**: The test runner calls it. It uses the composer plus handle_key_event to test freeform commit behavior.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, new, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_enter_with_empty_text_is_unanswered`  (lines 2837–2857)

```
fn freeform_enter_with_empty_text_is_unanswered()
```

**Purpose**: Checks that pressing Enter on an empty free-text question does not mark it answered. Empty draft text should not become a committed response during navigation.

**Data flow**: It creates two free-text questions, presses Enter without typing, and verifies the first answer is not committed and both questions remain unanswered.

**Call relations**: The test runner invokes it. It tests handle_key_event for an empty composer.

*Call graph*: calls 1 internal fn (new); 5 external calls (from, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_shift_enter_inserts_newline_without_advancing`  (lines 2860–2886)

```
fn freeform_shift_enter_inserts_newline_without_advancing()
```

**Purpose**: Verifies that Shift-Enter inserts a newline in free-text mode instead of moving to the next question. This matters for multi-line answers.

**Data flow**: It types 'Draft' into a free-text question, sends Shift-Enter, and checks the current question stays the same, the composer text becomes 'Draft\n', and the answer is not committed.

**Call relations**: The test runner calls it. It uses enhanced key support and handle_key_event to check the newline shortcut.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_uses_configured_composer_submit_binding`  (lines 2889–2917)

```
fn freeform_uses_configured_composer_submit_binding()
```

**Purpose**: Checks that a customized composer submit key commits a free-text answer. This lets user key preferences control the overlay.

**Data flow**: It changes submit to Control-J, types draft text, presses Control-J, and verifies the overlay moves to the second question and the first answer is committed.

**Call relations**: The test runner invokes it. It passes a custom keymap through new_with_keymap and tests handle_key_event against that keymap.

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 7 external calls (Char, new, new, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_submit_binding_wins_over_question_navigation`  (lines 2920–2948)

```
fn freeform_submit_binding_wins_over_question_navigation()
```

**Purpose**: Ensures that if the configured submit key overlaps with a navigation shortcut, submit takes priority. This avoids surprising users who deliberately remapped submit.

**Data flow**: It sets submit to Control-N, which could also mean next question, types draft text, presses Control-N, and verifies the first answer is committed while moving forward.

**Call relations**: The test runner calls it. It checks shortcut priority inside handle_key_event.

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 7 external calls (Char, new, new, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_questions_submit_empty_when_empty`  (lines 2951–2969)

```
fn freeform_questions_submit_empty_when_empty()
```

**Purpose**: Confirms that final submission of an empty free-text question sends an empty answer list. This defines the wire format for intentionally blank freeform answers.

**Data flow**: It creates one free-text question, calls submit_answers, reads the answer event, and verifies q1 has no answer strings.

**Call relations**: The test runner invokes it. It directly exercises submit_answers for a freeform prompt.

*Call graph*: calls 1 internal fn (new); 5 external calls (assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::freeform_draft_is_not_submitted_without_enter`  (lines 2972–2994)

```
fn freeform_draft_is_not_submitted_without_enter()
```

**Purpose**: Checks that uncommitted free-text draft text is not included in final submission. The user must press the submit/commit key for the draft to become an answer.

**Data flow**: It places 'Draft text' in the composer, calls submit_answers without pressing Enter, and verifies the emitted q1 answer is empty.

**Call relations**: The test runner calls it. It tests the boundary between composer draft state and committed answer state.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::freeform_commit_resets_when_draft_changes`  (lines 2997–3037)

```
fn freeform_commit_resets_when_draft_changes()
```

**Purpose**: Verifies that editing a previously committed free-text answer makes it uncommitted again. This prevents stale committed text from being submitted after the user changes it.

**Data flow**: It commits 'Committed' on the first question, returns to it, changes the draft to 'Edited', moves away, and sees the answer is no longer committed. Final submission then sends an empty answer for q1.

**Call relations**: The test runner invokes it. It uses movement between questions and submit_answers to check draft-change tracking.

*Call graph*: calls 1 internal fn (new); 7 external calls (from, new, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::notes_are_captured_for_selected_option`  (lines 3040–3079)

```
fn notes_are_captured_for_selected_option()
```

**Purpose**: Checks that notes attached to a selected option are included in the submitted answer. Notes are sent as a separate 'user_note' entry after the option label.

**Data flow**: It selects Option 2, enters note text into the composer, captures that draft into the answer, submits, and verifies the response contains both 'Option 2' and 'user_note: Notes for option 2'.

**Call relations**: The test runner calls it. It uses select_current_option, capture_composer_draft, and submit_answers to test note serialization.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::notes_submission_commits_selected_option`  (lines 3082–3111)

```
fn notes_submission_commits_selected_option()
```

**Purpose**: Verifies that pressing Enter while writing notes commits both the notes and the selected option, then advances to the next question. This makes note submission behave like completing the current answer.

**Data flow**: It moves the option highlight down, opens notes, types note text, presses Enter, and checks the overlay has advanced while the first answer has option index 1 and is committed.

**Call relations**: The test runner invokes it. It exercises handle_key_event across option navigation, notes mode, and question advancement.

*Call graph*: calls 1 internal fn (new); 7 external calls (from, new, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::is_other_adds_none_of_the_above_and_submits_it`  (lines 3114–3164)

```
fn is_other_adds_none_of_the_above_and_submits_it()
```

**Purpose**: Checks that questions allowing an 'other' answer get a 'None of the above' row and can submit it with custom notes. This supports users when none of the listed options fit.

**Data flow**: It creates an option question with an 'other' setting, verifies the extra row text and description, selects that row, enters custom text, submits, and checks the answer contains the special label plus the user note.

**Call relations**: The test runner calls it. It uses option_rows, options_len, composer draft capture, and submit_answers to validate the 'other' option flow.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::large_paste_is_preserved_when_switching_questions`  (lines 3167–3192)

```
fn large_paste_is_preserved_when_switching_questions()
```

**Purpose**: Ensures a large pasted free-text draft is not lost when moving to another question. Large pastes may be stored behind placeholders, so this protects that bookkeeping.

**Data flow**: It pastes a 1,500-character string into the composer on the first question, moves to the next question, and checks the first answer draft still has one pending paste, contains the placeholder, and reconstructs the original large text.

**Call relations**: The test runner invokes it. It checks interaction between the composer paste path and move_question's draft-saving behavior.

*Call graph*: calls 1 internal fn (new); 5 external calls (assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::pending_paste_placeholder_survives_submission_and_back_navigation`  (lines 3195–3223)

```
fn pending_paste_placeholder_survives_submission_and_back_navigation()
```

**Purpose**: Checks that a large paste placeholder survives committing an option-with-notes answer and navigating back. This prevents large pasted notes from disappearing after submission-like movement.

**Data flow**: It enters notes mode, ensures an option is selected, pastes a 1,200-character string, presses Enter to advance, then navigates back with Control-P. The first answer draft still reconstructs the original pasted text.

**Call relations**: The test runner calls it. It combines notes handling, paste storage, answer commit, and backward navigation through handle_key_event.

*Call graph*: calls 1 internal fn (new); 8 external calls (Char, from, new, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::request_user_input_options_snapshot`  (lines 3226–3240)

```
fn request_user_input_options_snapshot()
```

**Purpose**: Captures the expected terminal rendering for a basic option prompt. This guards the normal visual layout.

**Data flow**: It creates an option overlay, renders it at 120 by 16 cells, and compares the text output to a stored snapshot.

**Call relations**: The test runner invokes it. It uses render_snapshot as the bridge from overlay state to snapshot testing.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_options_notes_visible_snapshot`  (lines 3243–3263)

```
fn request_user_input_options_notes_visible_snapshot()
```

**Purpose**: Captures the expected rendering when notes are open for an option prompt. This protects the layout for the combined option-and-notes state.

**Data flow**: It selects an option, presses Tab to open notes, renders at a fixed size, and compares the result to a saved snapshot.

**Call relations**: The test runner calls it. It drives handle_key_event before handing the overlay to render_snapshot.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_tight_height_snapshot`  (lines 3266–3280)

```
fn request_user_input_tight_height_snapshot()
```

**Purpose**: Checks how the option prompt renders in a short vertical space. This helps ensure the overlay remains usable when the terminal area is cramped.

**Data flow**: It creates a basic option overlay, renders it in a 120 by 10 rectangle, and compares the result to a stored snapshot.

**Call relations**: The test runner invokes it. It tests render_snapshot with a deliberately tight area.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::layout_allocates_all_wrapped_options_when_space_allows`  (lines 3283–3308)

```
fn layout_allocates_all_wrapped_options_when_space_allows()
```

**Purpose**: Verifies that the layout gives wrapped option text all the height it needs when enough space is available. This prevents multi-line options from being unnecessarily cut off.

**Data flow**: It computes the needed question, option, footer, and spacer heights for a narrow width, builds an area with exactly that height, lays out sections, and checks the options area height matches the required options height.

**Call relations**: The test runner calls it. It exercises wrapped_question_lines, options_required_height, footer_required_height, and layout_sections as a layout calculation chain.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_eq!, request_event, test_sender, vec!).


##### `tests::desired_height_keeps_spacers_and_preferred_options_visible`  (lines 3311–3337)

```
fn desired_height_keeps_spacers_and_preferred_options_visible()
```

**Purpose**: Checks that the overlay's preferred height includes both readable option space and one-line gaps between sections. This keeps the form from looking crowded.

**Data flow**: It asks the overlay for its desired height at a wide width, applies the menu inset, lays out sections, and verifies the options area gets the preferred height and the spacers around it are one line each.

**Call relations**: The test runner invokes it. It links desired_height, menu_surface_inset, options_preferred_height, and layout_sections.

*Call graph*: calls 2 internal fn (new, menu_surface_inset); 5 external calls (new, assert_eq!, request_event, test_sender, vec!).


##### `tests::footer_wraps_tips_without_splitting_individual_tips`  (lines 3340–3374)

```
fn footer_wraps_tips_without_splitting_individual_tips()
```

**Purpose**: Ensures footer help tips wrap onto multiple lines without breaking an individual tip across the line. This keeps shortcut help readable in narrow terminals.

**Data flow**: It creates a two-question option overlay, selects an option to enable more tips, asks for footer tip lines at a narrow width, and checks each line's combined tip width fits within that width.

**Call relations**: The test runner calls it. It exercises footer_tip_lines and uses Unicode display-width calculations to validate the result.

*Call graph*: calls 1 internal fn (new); 5 external calls (width, assert!, request_event, test_sender, vec!).


##### `tests::request_user_input_wrapped_options_snapshot`  (lines 3377–3407)

```
fn request_user_input_wrapped_options_snapshot()
```

**Purpose**: Captures the expected rendering for options whose labels or descriptions wrap across lines. This protects a more complex layout case.

**Data flow**: It creates a prompt with wrapped options, selects the first option, calculates a height that includes question and option wrapping, renders the overlay, and compares it to a saved snapshot.

**Call relations**: The test runner invokes it. It combines layout helper methods with render_snapshot for snapshot coverage.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_long_option_text_snapshot`  (lines 3410–3427)

```
fn request_user_input_long_option_text_snapshot()
```

**Purpose**: Captures how very long option text is drawn. This guards against unreadable wrapping or clipping changes.

**Data flow**: It creates a prompt with very long option text, renders it in a fixed 120 by 18 area, and compares the output to a stored snapshot.

**Call relations**: The test runner calls it. It uses render_snapshot to verify the long-text display path.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::selected_long_wrapped_option_stays_visible`  (lines 3430–3450)

```
fn selected_long_wrapped_option_stays_visible()
```

**Purpose**: Checks that a selected option with long wrapped text remains visible in the option viewport. This prevents the cursor from landing on an item the user cannot see.

**Data flow**: It creates a scroll-heavy option list, marks the third option selected, renders the overlay, and checks the rendered text contains the selected third option marker.

**Call relations**: The test runner invokes it. It uses render_snapshot as a simple visibility check rather than a full snapshot assertion.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, assert!, render_snapshot, request_event, test_sender, vec!).


##### `tests::request_user_input_footer_wrap_snapshot`  (lines 3453–3478)

```
fn request_user_input_footer_wrap_snapshot()
```

**Purpose**: Captures the expected rendering when footer tips wrap in a narrower overlay. This protects the user-facing help text layout.

**Data flow**: It creates a two-question option overlay, selects an option, asks the overlay for its desired height at width 52, renders that area, and compares the output to a stored snapshot.

**Call relations**: The test runner calls it. It ties together selection state, desired_height, footer wrapping, and snapshot rendering.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_scroll_options_snapshot`  (lines 3481–3530)

```
fn request_user_input_scroll_options_snapshot()
```

**Purpose**: This test checks how the overlay looks when a multiple-choice question has enough options to require scrolling. It makes sure the selected option and visible list are drawn correctly in a wide but short terminal area.

**Data flow**: The test starts with a fake message sender and a fake request containing one question with five answer choices. It creates a RequestUserInputOverlay, manually sets the selected choice to the fourth option, renders the overlay into a 120-by-12 terminal rectangle, and sends that rendered text to the snapshot checker. The output is not returned to normal program code; it is compared against the saved expected screen image for the test.

**Call relations**: During the test run, this function builds its test data with request_event and sends it into RequestUserInputOverlay::new. It then uses render_snapshot to turn the overlay into text and hands that text to insta::assert_snapshot!, which decides whether the screen output still matches the approved version.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_hidden_options_footer_snapshot`  (lines 3533–3582)

```
fn request_user_input_hidden_options_footer_snapshot()
```

**Purpose**: This test checks the overlay in a smaller terminal where not all multiple-choice options fit on screen. It protects the footer or hint area that tells the user there are hidden choices.

**Data flow**: The test creates a fake request with one question and five choices, then builds an overlay from it. It sets the selected choice to the fourth option, renders the overlay into an 80-by-10 terminal area, and compares the rendered result with a stored snapshot. The important before-to-after story is: many choices go in, a constrained screen size is applied, and the expected compact display comes out.

**Call relations**: The test runner calls this function as a snapshot test. Inside it, request_event supplies the pretend user-input request, RequestUserInputOverlay::new creates the real overlay under test, render_snapshot captures what a user would see, and insta::assert_snapshot! checks that view.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_freeform_snapshot`  (lines 3585–3599)

```
fn request_user_input_freeform_snapshot()
```

**Purpose**: This test checks how the overlay looks for a question where the user types their own answer instead of picking from options. It helps ensure the free-text prompt and input area stay clear and usable.

**Data flow**: The test creates a fake request with one question that has no predefined options. It builds the overlay, renders it inside a 120-by-10 terminal rectangle, and compares that rendered screen with the saved snapshot. The input is a plain question; the output is the expected freeform-answer layout.

**Call relations**: The test runner invokes this function with the other snapshot tests. It relies on question_without_options and request_event to make the sample request, passes that to RequestUserInputOverlay::new, then uses render_snapshot and insta::assert_snapshot! to verify the visual result.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_freeform_remapped_submit_snapshot`  (lines 3602–3619)

```
fn request_user_input_freeform_remapped_submit_snapshot()
```

**Purpose**: This test checks that the freeform-question overlay shows the correct submit shortcut when the user’s key settings have been changed. It matters because on-screen hints should match what the keyboard actually does.

**Data flow**: The test begins with the default runtime keymap, then changes the composer submit shortcut to Ctrl+J. It creates a freeform request overlay using that custom keymap, renders the overlay into a fixed terminal area, and compares the result to the expected snapshot. The changed shortcut goes in; the rendered help text should reflect that change.

**Call relations**: This test uses RuntimeKeymap::defaults as a starting point, changes one shortcut, and passes the customized map into RequestUserInputOverlay::new_with_keymap. The overlay is then rendered and checked with insta::assert_snapshot!, so any mismatch between configured keys and displayed hints is caught.

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_freeform_remapped_interrupt_snapshot`  (lines 3622–3639)

```
fn request_user_input_freeform_remapped_interrupt_snapshot()
```

**Purpose**: This test checks that the overlay displays a changed interrupt shortcut correctly. An interrupt shortcut is the key the user can press to stop or cancel the current turn.

**Data flow**: The test starts with the default key settings, changes the chat interrupt shortcut to F12, and builds a freeform question overlay with that custom setup. It renders the overlay into a 120-by-10 terminal area and compares the text UI against a stored snapshot. The custom keyboard setting is the input; the visible shortcut hint is the output being checked.

**Call relations**: The test runner calls this function as part of the snapshot suite. It uses RuntimeKeymap::defaults, modifies the interrupt binding, gives the result to RequestUserInputOverlay::new_with_keymap, then sends the rendered overlay to insta::assert_snapshot! for comparison.

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_multi_question_first_snapshot`  (lines 3642–3662)

```
fn request_user_input_multi_question_first_snapshot()
```

**Purpose**: This test checks the first screen shown when the overlay contains more than one question. It makes sure the user can see that they are answering the first question and that the navigation context is clear.

**Data flow**: The test creates a fake request with two questions: one multiple-choice question and one freeform question. It builds the overlay, leaves it on the first question, renders it into a 120-by-15 terminal area, and compares the result to the saved snapshot. The input is a two-question request; the output is the expected first-question view.

**Call relations**: This snapshot test feeds a multi-question request_event into RequestUserInputOverlay::new. It does not move the overlay forward, so render_snapshot captures the initial question state, and insta::assert_snapshot! verifies that initial state.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_multi_question_last_snapshot`  (lines 3665–3686)

```
fn request_user_input_multi_question_last_snapshot()
```

**Purpose**: This test checks how the overlay looks after moving from the first question to the last question in a multi-question request. It protects the layout and navigation hints for the later-question state.

**Data flow**: The test builds an overlay from a fake request containing two questions. It then calls move_question with the direction set to next, which advances the overlay to the second question. After that, it renders the overlay into a 120-by-12 area and compares the result with the saved snapshot.

**Call relations**: The test starts the same way as the first multi-question snapshot, using request_event and RequestUserInputOverlay::new. It then exercises the overlay’s own move_question behavior before handing the rendered result to insta::assert_snapshot!, so the checked screen is the post-navigation view.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_unanswered_confirmation_snapshot`  (lines 3689–3712)

```
fn request_user_input_unanswered_confirmation_snapshot()
```

**Purpose**: This test checks the confirmation screen shown when the user tries to proceed while some questions are still unanswered. It ensures the warning is visible and formatted correctly.

**Data flow**: The test creates an overlay with two questions and does not fill them in. It then opens the unanswered-confirmation state, renders the overlay in an 80-by-12 terminal area, and compares that warning view to a saved snapshot. The before state is an incomplete set of answers; the after state is the confirmation prompt the user would see.

**Call relations**: The test runner invokes this function to protect an important safety step in the overlay. It builds the overlay through RequestUserInputOverlay::new, switches it into confirmation mode with open_unanswered_confirmation, then uses render_snapshot and insta::assert_snapshot! to check the displayed warning.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::options_scroll_while_editing_notes`  (lines 3715–3736)

```
fn options_scroll_while_editing_notes()
```

**Purpose**: This test checks a real interaction rule: while the user is typing notes, pressing the down arrow can still move the selected multiple-choice option. It also verifies that simply moving the selection does not count as committing the answer.

**Data flow**: The test creates a multiple-choice overlay, selects the current option without committing it, changes focus to the notes area, writes the text "Notes" into the composer, and places the cursor at the end. It then sends a Down-arrow key event into the overlay. Afterward, it reads the current answer and checks that the selected option moved to index 1 while answer_committed is still false.

**Call relations**: Unlike the snapshot tests, this one checks state directly instead of comparing a rendered screen. It builds the overlay with RequestUserInputOverlay::new, prepares the notes-editing state through the composer, sends a keyboard event through handle_key_event, and finally uses assertions to confirm the overlay changed selection but did not finalize the answer.

*Call graph*: calls 1 internal fn (new); 7 external calls (from, new, assert!, assert_eq!, request_event, test_sender, vec!).


### `tui/src/bottom_pane/pending_thread_approvals.rs`

`domain_logic` · `main loop rendering`

This widget solves a visibility problem: an approval request can happen in a thread the user is not currently viewing. Without this reminder, the user might not know that another thread is blocked and waiting. The widget keeps a list of thread names that need attention, then draws a short warning for each one in the terminal interface.

It is deliberately compact. If there are no waiting threads, it draws nothing. If the available space is too narrow, it also draws nothing, because the message would not be useful. Otherwise, it shows up to three lines like “Approval needed in …”, with a red exclamation mark as a visual cue. Long thread names are wrapped using the project’s adaptive wrapping helper, so the text fits the current terminal width. If more than three threads need approval, it adds a dim “...” line instead of flooding the pane. At the bottom, it shows a hint: use “/agent” to switch threads.

Think of it like a dashboard warning light. It does not perform the approval itself; it simply makes sure the user sees that something elsewhere needs attention.

#### Function details

##### `PendingThreadApprovals::new`  (lines 17–21)

```
fn new() -> Self
```

**Purpose**: Creates an empty pending-approvals widget. It is used when the UI first needs a place to store and later display thread approval warnings.

**Data flow**: It takes no thread data in. It creates a new widget with an empty list of thread names. The result is a `PendingThreadApprovals` value that will draw nothing until threads are added.

**Call relations**: This is the starting point for the widget. The rendering tests create fresh widgets with it, and the surrounding UI setup also relies on it before any approval-thread list has been supplied.

*Call graph*: called by 4 (new, desired_height_empty, render_multiple_threads_snapshot, render_single_thread_snapshot); 1 external calls (new).


##### `PendingThreadApprovals::set_threads`  (lines 23–29)

```
fn set_threads(&mut self, threads: Vec<String>) -> bool
```

**Purpose**: Replaces the widget’s current list of threads that need approval. It also tells the caller whether the list actually changed, which helps avoid unnecessary redraw work.

**Data flow**: It receives a new list of thread names. If that list is the same as the current one, it leaves the widget unchanged and returns `false`. If it is different, it stores the new list and returns `true`.

**Call relations**: The wider bottom-pane code calls this when it learns which inactive threads have outstanding approval requests. After this updates the stored names, later rendering turns those names into visible warning lines.

*Call graph*: called by 1 (set_pending_thread_approvals).


##### `PendingThreadApprovals::is_empty`  (lines 31–33)

```
fn is_empty(&self) -> bool
```

**Purpose**: Answers whether there are any pending approval threads to show. Other layout code can use this to decide whether this widget needs space at all.

**Data flow**: It reads the widget’s stored thread list. It returns `true` if the list has no names, and `false` if at least one thread is waiting for approval.

**Call relations**: The surrounding bottom-pane layout asks this before reserving room near the composer. In the bigger flow, it helps the UI stay compact when there is nothing important to display.

*Call graph*: called by 1 (as_renderable_with_composer_right_reserve).


##### `PendingThreadApprovals::threads`  (lines 36–38)

```
fn threads(&self) -> &[String]
```

**Purpose**: Returns the stored thread names for test-only inspection. It exists so tests can check the widget’s internal state without changing it.

**Data flow**: It reads the widget’s thread list and returns a borrowed view of it. Nothing is copied, drawn, or modified.

**Call relations**: This function is only compiled for tests. Test code that checks pending thread approvals calls it to confirm that the expected names were stored.

*Call graph*: called by 1 (pending_thread_approvals).


##### `PendingThreadApprovals::as_renderable`  (lines 40–70)

```
fn as_renderable(&self, width: u16) -> Box<dyn Renderable>
```

**Purpose**: Builds the actual drawable content for the widget at a given terminal width. It converts raw thread names into styled, wrapped terminal lines plus the “/agent” hint.

**Data flow**: It receives the available width and reads the stored thread names. If there is nothing to show, or the width is too small, it returns an empty drawable object. Otherwise, it creates warning text for up to three threads, wraps those lines to fit the width, adds an ellipsis if more threads exist, adds the switch-thread hint, and returns a paragraph-like drawable object.

**Call relations**: Both `render` and `desired_height` call this so they agree on exactly what content exists. It hands text to the wrapping helper before packaging the result as something that follows the project’s `Renderable` interface.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_lines); called by 2 (desired_height, render); 7 external calls (new, from, new, new, format!, once, vec!).


##### `PendingThreadApprovals::render`  (lines 74–80)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the pending-approval warning into the terminal buffer. This is what makes the stored thread names visible to the user.

**Data flow**: It receives a screen area and a mutable terminal buffer. If the area is empty, it does nothing. Otherwise, it builds the drawable content for the area’s width and asks that content to paint itself into the buffer.

**Call relations**: The UI rendering pass calls this through the shared `Renderable` interface. In tests, `snapshot_rows` calls it after creating a buffer so the expected screen text can be checked.

*Call graph*: calls 1 internal fn (as_renderable); called by 1 (snapshot_rows); 1 external calls (is_empty).


##### `PendingThreadApprovals::desired_height`  (lines 82–84)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Calculates how many terminal rows the widget wants at a given width. Layout code uses this before drawing so it can reserve the right amount of space.

**Data flow**: It receives a width and reads the stored thread names. It builds the same drawable content that rendering would use, then asks that content how tall it wants to be. The result is a row count.

**Call relations**: This pairs with `render`: both go through `as_renderable`, so measuring and drawing stay consistent. The test helper calls this first to make a buffer of the right height.

*Call graph*: calls 1 internal fn (as_renderable); called by 1 (snapshot_rows).


##### `tests::snapshot_rows`  (lines 93–106)

```
fn snapshot_rows(widget: &PendingThreadApprovals, width: u16) -> String
```

**Purpose**: Renders the widget into an in-memory terminal buffer and turns the visible characters into plain text for snapshot testing. This lets tests compare what a user would see without opening a real terminal.

**Data flow**: It receives a widget and a width. It asks the widget for its desired height, creates an empty buffer of that size, renders the widget into it, then reads each cell’s first character into lines of text. The output is a newline-separated string.

**Call relations**: The rendering snapshot tests use this as their bridge between the widget and the snapshot assertion tool. It calls `desired_height` and `render`, so it exercises the same path the real UI uses.

*Call graph*: calls 2 internal fn (desired_height, render); 2 external calls (empty, new).


##### `tests::desired_height_empty`  (lines 109–112)

```
fn desired_height_empty()
```

**Purpose**: Checks that an empty widget asks for no screen height. This protects the UI from wasting space when there are no pending approvals.

**Data flow**: It creates a new widget with no threads, asks for its desired height at a normal width, and compares the answer with zero.

**Call relations**: This test starts with `PendingThreadApprovals::new` and verifies the measuring behavior that layout code depends on before any thread list has been set.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::render_single_thread_snapshot`  (lines 115–126)

```
fn render_single_thread_snapshot()
```

**Purpose**: Checks the exact text layout when one thread needs approval. It makes sure the warning line and the “/agent” hint appear as intended.

**Data flow**: It creates a widget, sets one thread name, renders it through the snapshot helper at a fixed width, replaces spaces with dots for easier visual comparison, and compares the result with a saved expected snapshot.

**Call relations**: This test uses the same rendering path as the real UI by going through `snapshot_rows`. It protects the single-thread display from accidental formatting changes.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_snapshot!, vec!).


##### `tests::render_multiple_threads_snapshot`  (lines 129–148)

```
fn render_multiple_threads_snapshot()
```

**Purpose**: Checks the exact text layout when several threads need approval, including the cutoff after three visible thread names. It confirms the widget stays compact while still signaling that more threads exist.

**Data flow**: It creates a widget, gives it four thread names, renders it at a fixed width, turns spaces into dots for readable comparison, and checks the result against the expected snapshot.

**Call relations**: This test also goes through `snapshot_rows`, so it exercises `desired_height`, `render`, and the internal renderable-building logic together. It specifically protects the multi-thread and ellipsis behavior.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_snapshot!, vec!).


### Chat widget approval flows
These chat-widget modules turn approval events into concrete popup flows, permission selection, sandbox prompts, and transcript-visible request handling.

### `tui/src/chatwidget/permission_popups.rs`

`orchestration` · `request handling`

This file is the chat screen’s “permissions desk.” It creates the menus and confirmation screens that decide what the model is allowed to do: read files, edit files, use the network, or act only after asking the user. Without it, users would have no clear in-chat way to change those safety settings or approve a recently blocked action.

The main flow starts when the chat widget opens the permissions popup. The code looks at the current configuration, builds a list of permission presets, marks the current one, disables choices that are not allowed, and attaches actions to each menu item. Selecting an item does not directly change everything in place. Instead, it sends app events, like putting notes into a mailbox for the rest of the application to process.

Some choices need extra care. Full access gets a warning because it lets Codex edit files and run network commands without asking. On Windows, the file also accounts for sandbox state, meaning the protective “box” around commands may need setup or elevation. There is also a separate popup for recent auto-review denials, where the user can approve one denied action for a retry.

Overall, this file turns sensitive security settings into guided, visible user choices rather than hidden switches.

#### Function details

##### `ChatWidget::open_approvals_popup`  (lines 11–13)

```
fn open_approvals_popup(&mut self)
```

**Purpose**: This is a compatibility wrapper that opens the permissions popup when something asks for the older “approvals” popup. It keeps callers working while routing them to the newer, broader permissions flow.

**Data flow**: It receives the current chat widget state, makes no decisions of its own, and immediately forwards control to the permissions popup builder. The visible result is the same permissions selection UI that a direct permissions request would show.

**Call relations**: When another part of the interface asks to open approvals, this function calls `open_permissions_popup` so there is one main place that builds the actual popup.

*Call graph*: calls 1 internal fn (open_permissions_popup).


##### `ChatWidget::open_permissions_popup`  (lines 16–160)

```
fn open_permissions_popup(&mut self)
```

**Purpose**: This builds and shows the main menu for changing model permissions. It decides which permission choices should appear, which one is currently active, and which choices should be disabled or require follow-up prompts.

**Data flow**: It reads the current configuration, such as the approval policy, permission profile, current folder, feature flags, and Windows sandbox status. It turns the built-in permission presets into selectable rows, attaches the right actions to each row, optionally adds a warning note, and sends the completed selection view to the bottom pane for display.

**Call relations**: This is the central popup builder, and `open_approvals_popup` delegates to it. While building each row, it calls `permission_mode_actions` to decide what should happen when the user selects that row, and uses `preset_matches_current` to mark the row that matches the current settings.

*Call graph*: calls 3 internal fn (from, permission_mode_actions, level_from_config); called by 1 (open_approvals_popup); 7 external calls (new, default, preset_matches_current, new, cfg!, format!, matches!).


##### `ChatWidget::open_auto_review_denials_popup`  (lines 162–220)

```
fn open_auto_review_denials_popup(&mut self)
```

**Purpose**: This shows a searchable popup listing recent actions that automatic review rejected. It gives the user a way to pick one denied action and approve it for a retry.

**Data flow**: It checks the chat widget’s stored recent denials. If there are none, it shows an informational message. If the current thread is gone, it shows an error. Otherwise, it builds rows from each denial, including a plain summary and rationale, and each row sends an approval event for that specific denial when selected.

**Call relations**: This popup is used when the user wants to inspect auto-review denials. The actions it creates send an `ApproveRecentAutoReviewDenial` event, which later leads to `approve_recent_auto_review_denial` doing the actual approval work.

*Call graph*: 2 external calls (default, vec!).


##### `ChatWidget::approve_recent_auto_review_denial`  (lines 222–239)

```
fn approve_recent_auto_review_denial(&mut self, thread_id: ThreadId, id: String)
```

**Purpose**: This records the user’s approval for one recently denied auto-review action. The approval is limited to a retry, rather than permanently changing the safety rules.

**Data flow**: It receives a thread ID and denial ID. It removes the matching denial from the recent-denials store; if it cannot find it, it shows an error. If found, it sends a thread operation that wraps the denied action as approved for retry, then shows an informational message explaining what happened.

**Call relations**: This is the follow-through for a selection made in `open_auto_review_denials_popup`. After the popup sends the approval event, this function packages the approved denial into an app command using `approve_guardian_denied_action` and sends it back into the thread flow.

*Call graph*: 1 external calls (approve_guardian_denied_action).


##### `ChatWidget::approval_preset_actions`  (lines 241–275)

```
fn approval_preset_actions(
        approval: AskForApproval,
        permission_profile: PermissionProfile,
        active_permission_profile: ActivePermissionProfile,
        label: String,
```

**Purpose**: This creates the list of actions needed to apply a permission preset. It is used when choosing a built-in mode should immediately update the running conversation’s permission context.

**Data flow**: It takes the approval rule, permission profile, active profile label, display label, and reviewer choice. It returns one selection action; when run, that action sends several app events to update the current turn context, store the new approval policy and profile, set the reviewer, and add a history message saying permissions were updated.

**Call relations**: Other popup builders call this when a menu item should apply a preset directly. `permission_mode_actions` uses it for normal preset choices, and `open_full_access_confirmation` uses it after the user confirms the risky full-access option.

*Call graph*: 1 external calls (vec!).


##### `ChatWidget::permission_profile_selection_actions`  (lines 277–283)

```
fn permission_profile_selection_actions(
        selection: PermissionProfileSelection,
    ) -> Vec<SelectionAction>
```

**Purpose**: This creates the action for selecting a named permission profile instead of directly applying one fixed preset. It lets the rest of the application process that profile choice through the normal event path.

**Data flow**: It receives a permission profile selection and returns one action. When that action runs, it sends an app event carrying the selected profile; the function itself does not apply the profile immediately.

**Call relations**: This is used as an alternative to `approval_preset_actions` when a popup item represents a profile selection. `permission_mode_actions` and `open_full_access_confirmation` choose between these two action builders depending on whether a profile selection was supplied.

*Call graph*: 1 external calls (vec!).


##### `ChatWidget::permission_mode_actions`  (lines 285–366)

```
fn permission_mode_actions(
        &self,
        preset: &ApprovalPreset,
        label: String,
        approvals_reviewer: ApprovalsReviewer,
        profile_selection: Option<PermissionProfileSel
```

**Purpose**: This decides what should happen when the user selects a permission mode. Sometimes it can apply the mode immediately; sometimes it must first show a warning or setup prompt.

**Data flow**: It receives the selected preset, display label, reviewer mode, optional profile selection, and whether the UI should return to the permissions menu afterward. It checks for special cases: full access may require a confirmation warning, and on Windows the automatic mode may require sandbox setup or a world-writable folder warning. It returns actions that either apply the choice or open the needed confirmation/setup popup first.

**Call relations**: `open_permissions_popup` calls this for each menu row so every choice gets the correct behavior. It may hand off to `approval_preset_actions` or `permission_profile_selection_actions` for ordinary choices, or send events that open full-access, Windows sandbox, or world-writable warning prompts.

*Call graph*: calls 1 internal fn (level_from_config); called by 1 (open_permissions_popup); 3 external calls (sandbox_setup_is_complete, clone, vec!).


##### `ChatWidget::preset_matches_current`  (lines 368–405)

```
fn preset_matches_current(
        current_approval: AskForApproval,
        current_permission_profile: &PermissionProfile,
        cwd: &std::path::Path,
        preset: &ApprovalPreset,
    ) -> bo
```

**Purpose**: This checks whether a permission preset represents the settings currently in effect. It is used so the popup can mark the active choice for the user.

**Data flow**: It receives the current approval policy, the current permission profile, the current working folder, and a preset to compare against. It first compares the approval policy, then checks the permission profile rules in a preset-specific way, such as whether the current folder is writable for automatic mode or whether no writable roots exist for read-only mode. It returns true if the preset matches, otherwise false.

**Call relations**: `open_permissions_popup` calls this while building menu items. Its answer controls the “current” marker in the popup, helping the user see which permission mode is already active.

*Call graph*: calls 3 internal fn (from, file_system_sandbox_policy, network_sandbox_policy); 1 external calls (matches!).


##### `ChatWidget::open_full_access_confirmation`  (lines 407–500)

```
fn open_full_access_confirmation(
        &mut self,
        preset: ApprovalPreset,
        return_to_permissions: bool,
        profile_selection: Option<PermissionProfileSelection>,
    )
```

**Purpose**: This shows a warning screen before enabling full access. It exists because full access is powerful and risky, so the user must make an explicit choice before continuing unless they have chosen not to be warned again.

**Data flow**: It receives the full-access preset, a flag saying where to return on cancel, and an optional profile selection. It builds a warning header explaining that Codex can edit files and use the network without approval. It then creates three choices: continue for this session, continue and remember the warning choice, or cancel and go back. The accept choices apply the preset or profile and mark the warning acknowledged; the remember choice also persists that preference.

**Call relations**: `permission_mode_actions` opens this confirmation instead of applying full access directly when the warning is needed. If the user accepts, it reuses `approval_preset_actions` or `permission_profile_selection_actions`; if the user cancels, it sends an event to reopen the appropriate permissions or approvals popup.

*Call graph*: calls 2 internal fn (from, with); 6 external calls (new, default, from, new, new, vec!).


### `tui/src/chatwidget/permissions_menu.rs`

`domain_logic` · `user interaction`

This file is the chat UI’s “permissions chooser.” Its job is to show a clear menu where the user can switch between safety modes, such as read-only access, normal workspace access, or full access. Without it, the app could still have permission settings internally, but users would not have this guided way to inspect and change them from the terminal interface.

The main flow starts by finding the currently active permission profile, then loading the built-in approval presets. These presets are like ready-made driving modes in a car: cautious, normal, or unrestricted. The file expects three built-in presets to exist: read-only, auto, and full-access. If one is missing, it reports an internal error instead of showing a broken menu.

It then creates menu items for each built-in mode. If the GuardianApproval feature is enabled, it adds an extra option where approvals can be reviewed automatically. After that, it adds any custom permission profiles from configuration.

Each menu row knows its label, description, whether it is the current choice, what action should happen when selected, and whether it should be disabled because the current configuration rules do not allow that change.

#### Function details

##### `ChatWidget::open_permission_profiles_popup`  (lines 4–87)

```
fn open_permission_profiles_popup(&mut self)
```

**Purpose**: Opens the popup that lets the user choose a permission profile for the model. It gathers the built-in choices, optionally adds an automatic review choice, adds configured custom profiles, and displays them as a selection menu.

**Data flow**: It reads the chat widget’s configuration, including the active permission profile, feature flags, built-in approval presets, and custom profiles. It turns that information into a list of selection items, each with a label, description, current-state marker, and actions. The result is not returned as a value; instead, the bottom pane of the UI is changed to show the permissions selection popup, or an error message is added if required built-in presets are missing.

**Call relations**: This is the top-level menu builder for this file. As it prepares the popup, it calls `ChatWidget::builtin_permission_mode_selection_item` for the standard built-in permission modes and uses the standard construction helpers such as `from`, `vec!`, and default values. Once the items are ready, it hands them to the bottom pane so the user can pick one.

*Call graph*: calls 2 internal fn (from, builtin_permission_mode_selection_item); 3 external calls (new, default, vec!).


##### `ChatWidget::builtin_permission_mode_selection_item`  (lines 89–147)

```
fn builtin_permission_mode_selection_item(
        &self,
        preset: &ApprovalPreset,
        id: &str,
        description: String,
        approval_policy: AskForApproval,
        approvals_rev
```

**Purpose**: Creates one selectable row for a built-in permission mode, such as workspace access, full access, read-only access, or automatic review. It also decides whether that row should appear as the current setting or be disabled.

**Data flow**: It receives a built-in preset, the profile id to use, a human-readable description, the approval policy, and who reviews approvals. It reads the current active profile, current approval policy, and current reviewer from configuration. From this, it builds a `SelectionItem` containing the visible label, description, current-choice flag, the actions to run if selected, and any disabled reason if the configuration does not allow that policy or profile.

**Call relations**: `ChatWidget::open_permission_profiles_popup` calls this while assembling the built-in part of the permissions menu. This function converts one preset into a finished menu row, and it relies on helper conversions such as `from` and `to_core` so the UI choice matches the core permission system.

*Call graph*: calls 2 internal fn (from, to_core); called by 1 (open_permission_profiles_popup); 1 external calls (default).


##### `ChatWidget::permission_profile_selection_item`  (lines 149–170)

```
fn permission_profile_selection_item(
        label: &str,
        id: &str,
        description: &str,
        active_profile_id: Option<&str>,
    ) -> SelectionItem
```

**Purpose**: Creates one selectable row for a custom permission profile defined in configuration. It is simpler than the built-in version because custom profiles already carry their own profile identity and do not override approval policy or reviewer settings here.

**Data flow**: It receives the text to show, the profile id, a description, and the currently active profile id. It builds a permission profile selection from that id, marks the row as current if it matches the active profile, attaches the actions needed to select it, and returns the completed `SelectionItem`.

**Call relations**: This function is the custom-profile counterpart to the built-in item builder. In the permissions menu flow, it turns configured profiles into rows the user can select, and it hands the resulting selection to `permission_profile_selection_actions` so choosing the row actually changes the profile.

*Call graph*: 2 external calls (default, permission_profile_selection_actions).


### `tui/src/chatwidget/windows_sandbox_prompts.rs`

`orchestration` · `startup and interactive prompt handling`

On Windows, Codex can run with a sandbox: a protective boundary that limits file writes and network access. This file is the chat UI’s “safety desk” for that feature. It decides when the user must be warned, builds the text shown in pop-up choice panels, and connects each button to the app event that should happen next.

The file covers three main moments. First, it checks whether a sandbox mode is allowed by configuration rules, including organization-level rules. Second, it shows prompts for setting up the stronger Administrator-based sandbox, or falling back to a non-admin sandbox if that is allowed. Third, it warns when Windows folder permissions are too loose, especially folders writable by “Everyone,” because the sandbox may not be able to protect those places reliably.

The prompts are not just labels. Each option carries actions: start elevated setup, use the non-admin setup, apply a permission profile, remember that a warning was acknowledged, or quit. The file also temporarily disables typing while setup is in progress, so the user cannot accidentally send work that would run under the wrong safety mode.

On non-Windows systems, most functions are harmless no-ops. This keeps the rest of the app able to call the same methods without constantly checking the operating system.

#### Function details

##### `ChatWidget::windows_sandbox_mode_allowed`  (lines 7–14)

```
fn windows_sandbox_mode_allowed(&self, mode: WindowsSandboxModeToml) -> bool
```

**Purpose**: This checks whether the current configuration rules allow Codex to use a particular Windows sandbox mode. It matters because some users or organizations may forbid the less-protective non-admin sandbox.

**Data flow**: It takes a requested sandbox mode, reads the layered configuration rules, and asks whether that mode can be set. It returns true if the rules accept the mode and false if they reject it.

**Call relations**: The enable and fallback prompts call this before showing the non-admin sandbox option. If this says the mode is not allowed, those prompts hide that path and steer the user toward the required default sandbox.

*Call graph*: called by 2 (open_windows_sandbox_enable_prompt, open_windows_sandbox_fallback_prompt).


##### `ChatWidget::elevated_windows_sandbox_setup_required`  (lines 17–27)

```
fn elevated_windows_sandbox_setup_required(&self) -> bool
```

**Purpose**: This decides whether the stronger Administrator-based Windows sandbox still needs setup before Codex can safely continue. It is a gatekeeper for prompts that require the user to finish sandbox preparation.

**Data flow**: It reads the configured Windows sandbox level, checks whether that setting came from an explicit configuration source, and checks whether setup files or markers are already complete in the Codex home folder. It returns true only when elevated sandbox mode is expected and setup is not finished.

**Call relations**: The automatic prompt checker and both sandbox choice screens call this to decide whether a setup choice is mandatory. It relies on the Windows sandbox configuration helper to interpret the config and on the setup-complete check to inspect the local setup state.

*Call graph*: calls 1 internal fn (level_from_config); called by 3 (maybe_prompt_windows_sandbox_enable, open_windows_sandbox_enable_prompt, open_windows_sandbox_fallback_prompt); 1 external calls (sandbox_setup_is_complete).


##### `ChatWidget::world_writable_warning_details`  (lines 65–67)

```
fn world_writable_warning_details(&self) -> Option<(Vec<String>, usize, bool)>
```

**Purpose**: This checks whether Codex should warn that Windows folder permissions may weaken sandbox protection. A folder writable by everyone is like leaving a side door unlocked: even if the main sandbox is careful, that folder may still be risky.

**Data flow**: It first respects the user's setting to hide this warning. If the warning is not hidden, it reads the current working folder, workspace roots, environment variables, and effective permission profile. It tries to translate those permissions into Windows sandbox permissions, then asks the Windows sandbox library to scan and apply protections. It returns no warning when everything is okay or the check is disabled, and returns warning details when protection cannot be verified. On non-Windows systems it always returns no warning.

**Call relations**: This function is used by the surrounding chat flow when deciding whether to show a world-writable warning. It hands the actual Windows permission work to the sandbox library, while this UI layer only decides whether there is something the user needs to see.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); 3 external calls (new, apply_world_writable_scan_and_denies_for_permissions, vars).


##### `ChatWidget::open_world_writable_warning_confirmation`  (lines 209–217)

```
fn open_world_writable_warning_confirmation(
        &mut self,
        _preset: Option<ApprovalPreset>,
        _profile_selection: Option<PermissionProfileSelection>,
        _sample_paths: Vec<Stri
```

**Purpose**: This opens the confirmation popup that explains the world-writable-folder risk and asks whether to continue. It lets the user proceed for now or proceed and remember that choice.

**Data flow**: It receives the permission preset or profile being applied, sample paths to display, a count of additional paths, and whether the scan failed. It builds a readable warning message, creates button choices, and attaches actions to each choice. Choosing continue may apply the requested permissions; choosing continue and do not warn again also records and persists the acknowledgement. The visible result is a selection panel in the chat bottom pane.

**Call relations**: This function is part of the broader permission-change flow. It uses shared action builders for permission-profile selections and approval presets, so the warning acknowledgement happens before the permission change is applied and does not immediately trigger the same warning again.

*Call graph*: calls 2 internal fn (from, with); 9 external calls (new, default, from, new, approval_preset_actions, permission_profile_selection_actions, new, format!, vec!).


##### `ChatWidget::open_windows_sandbox_enable_prompt`  (lines 328–333)

```
fn open_windows_sandbox_enable_prompt(
        &mut self,
        _preset: ApprovalPreset,
        _profile_selection: Option<PermissionProfileSelection>,
    )
```

**Purpose**: This shows the first setup prompt for the Windows sandbox. It explains why the sandbox is needed and lets the user start Administrator setup, choose the non-admin sandbox if allowed, or quit.

**Data flow**: It receives the approval preset and optional permission profile selection that should be applied after setup. It records telemetry that the prompt was shown, checks whether non-admin mode is allowed, checks whether setup is required, builds the prompt text and choices, and displays them. Button actions send app events to begin elevated setup, begin legacy non-admin setup, or exit the app.

**Call relations**: The automatic setup checker calls this when Codex detects that Windows sandbox setup is needed. Inside the prompt, it calls the mode-allowed and elevated-setup-required helpers to decide which choices to show and whether canceling the popup should reopen it.

*Call graph*: calls 3 internal fn (elevated_windows_sandbox_setup_required, windows_sandbox_mode_allowed, new); called by 1 (maybe_prompt_windows_sandbox_enable); 5 external calls (new, default, new, clone, vec!).


##### `ChatWidget::open_windows_sandbox_fallback_prompt`  (lines 452–457)

```
fn open_windows_sandbox_fallback_prompt(
        &mut self,
        _preset: ApprovalPreset,
        _profile_selection: Option<PermissionProfileSelection>,
    )
```

**Purpose**: This shows the recovery prompt after Administrator-based sandbox setup fails. It gives the user a clear next step: try again, use the non-admin sandbox if allowed, or quit.

**Data flow**: It receives the same preset and optional profile selection that would be used after setup. It checks whether non-admin mode is allowed and whether setup is mandatory, builds an explanation of the failure, and creates choices. The choices send events to retry elevated setup, start non-admin setup, or exit.

**Call relations**: This function is used by the Windows sandbox setup flow after elevated setup does not succeed. Like the initial prompt, it depends on the mode-allowed and setup-required checks so it can avoid offering a forbidden fallback and can reopen itself if the user cancels while a required choice remains unresolved.

*Call graph*: calls 3 internal fn (elevated_windows_sandbox_setup_required, windows_sandbox_mode_allowed, new); 7 external calls (new, default, new, new, line!, clone, vec!).


##### `ChatWidget::maybe_prompt_windows_sandbox_enable`  (lines 475–475)

```
fn maybe_prompt_windows_sandbox_enable(&mut self, _show_now: bool)
```

**Purpose**: This is the quick check that decides whether to show the Windows sandbox setup prompt right now. It prevents Codex from silently continuing when the configured sandbox is missing or incomplete.

**Data flow**: It receives a flag saying whether the prompt should be shown immediately. It reads the configured Windows sandbox level, checks whether setup is required, looks up the built-in automatic approval preset, and if all conditions match, opens the sandbox enable prompt.

**Call relations**: This sits upstream of the main sandbox prompt. It calls the configuration-level helper, the elevated-setup-required helper, and then hands control to the enable prompt when user action is needed.

*Call graph*: calls 3 internal fn (elevated_windows_sandbox_setup_required, open_windows_sandbox_enable_prompt, level_from_config).


##### `ChatWidget::show_windows_sandbox_setup_status`  (lines 499–499)

```
fn show_windows_sandbox_setup_status(&mut self)
```

**Purpose**: This updates the chat UI while Windows sandbox setup is running. It tells the user setup may take a few minutes and prevents them from typing new work during that uncertain state.

**Data flow**: It changes the bottom pane so the message composer is disabled, shows a status indicator, hides the interrupt hint, sets a status message, and requests a redraw. The result is a visible “setting up sandbox” state and temporarily blocked input.

**Call relations**: The surrounding Windows setup flow calls this when elevated sandbox setup begins. It does not start setup itself; it only makes the interface match the setup state.


##### `ChatWidget::clear_windows_sandbox_setup_status`  (lines 510–510)

```
fn clear_windows_sandbox_setup_status(&mut self)
```

**Purpose**: This restores the chat UI after Windows sandbox setup finishes or stops. It gives typing control back to the user and removes the setup indicator.

**Data flow**: It re-enables the message composer, clears the temporary placeholder text, hides the status indicator, and requests a redraw. The interface returns from setup mode to normal chat mode.

**Call relations**: The surrounding setup flow calls this after setup is no longer in progress. It is the cleanup partner to the setup-status function.


### `tui/src/chatwidget/tool_requests.rs`

`orchestration` · `request handling`

This module turns incoming “tool request” events into visible, interactive prompts inside `ChatWidget`, the main chat user interface. Think of it like a receptionist desk: when a request arrives, this code decides whether to put it in a waiting queue or show it immediately, then makes sure the user sees the right card, notification, and status message.

Most request types follow the same pattern. First, the widget records that something visible happened in the current conversation. Then it either defers the request, if the UI is not ready to interrupt yet, or handles it right away. Handling usually means stopping any streaming assistant text cleanly, building an approval or input request, pushing it into the bottom pane, showing a “waiting” pet notification, and asking the screen to redraw.

The most detailed path is guardian assessment. A guardian is an automatic reviewer that can approve, deny, or time out actions. While review is still happening, this file updates the live status footer so the user knows what is being checked. When the review ends, it removes that pending status and writes a final history entry saying whether the action was approved, denied, or timed out.

This file matters because tool use is where safety and user control meet the chat interface. It makes sensitive actions explicit instead of hidden.

#### Function details

##### `ChatWidget::on_exec_approval_request`  (lines 9–16)

```
fn on_exec_approval_request(&mut self, _id: String, ev: ExecApprovalRequestEvent)
```

**Purpose**: Receives a request asking whether the assistant may run a command. It records that the conversation has visible activity, then either queues the request or shows it immediately.

**Data flow**: A request id and an execution approval event come in. The id is not used here, but the event is cloned so one copy can be stored in a queue if needed and another can be used for immediate display. The result is not a returned value; the chat widget is changed by either adding the request to a pending queue or opening the approval prompt.

**Call relations**: This is the first stop for command approval events inside the chat UI. It prepares the event, using `clone` so the same information can safely travel down either path, and hands the actual immediate work to `ChatWidget::handle_exec_approval_now` when the widget is ready.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_apply_patch_approval_request`  (lines 18–29)

```
fn on_apply_patch_approval_request(
        &mut self,
        _id: String,
        ev: ApplyPatchApprovalRequestEvent,
    )
```

**Purpose**: Receives a request asking whether the assistant may apply a patch, meaning make file edits. It makes sure the edit approval is either saved for later or shown to the user now.

**Data flow**: An unused request id and an apply-patch event come in. The event is copied so it can be placed into the deferred-request queue or passed into the immediate handler. The function changes the widget state by scheduling or displaying an edit approval prompt.

**Call relations**: This is the entry point for patch approval events in this file. It uses `clone` to keep the event available for both possible paths, then relies on `ChatWidget::handle_apply_patch_approval_now` to build the visible prompt when immediate handling is allowed.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_guardian_assessment`  (lines 38–254)

```
fn on_guardian_assessment(&mut self, ev: GuardianAssessmentEvent)
```

**Purpose**: Updates the UI when the automatic guardian reviewer starts, finishes, approves, denies, or times out an action. It keeps the live status footer honest while review is pending and writes a final history message when there is a decision.

**Data flow**: A guardian assessment event comes in with an action, a status, and an id. The function turns the action into a readable summary, such as a command line, a file patch summary, or a network target. If the status is still in progress, it updates the footer and redraws. If the status is final, it removes the pending footer entry, creates the correct history cell for approved, denied, or timed-out review, records denial details when needed, and redraws the screen.

**Call relations**: This function sits between the automatic review system and the visible conversation history. It calls formatting helpers such as `format!` and command joining/splitting helpers to make readable text, then calls history-cell builders like `new_approval_decision_cell`, `new_guardian_approved_action_request`, `new_guardian_denied_action_request`, `new_guardian_denied_patch_request`, `new_guardian_timed_out_action_request`, and `new_guardian_timed_out_patch_request` so the final decision appears as a normal chat history item.

*Call graph*: 12 external calls (from, format!, new_approval_decision_cell, new_guardian_approved_action_request, new_guardian_denied_action_request, new_guardian_denied_patch_request, new_guardian_timed_out_action_request, new_guardian_timed_out_patch_request, clone, to_string (+2 more)).


##### `ChatWidget::on_elicitation_request`  (lines 256–268)

```
fn on_elicitation_request(
        &mut self,
        request_id: AppServerRequestId,
        params: McpServerElicitationRequestParams,
    )
```

**Purpose**: Receives a request from an MCP server asking the user for extra information. MCP means “Model Context Protocol,” a way for external tools or services to talk with the app.

**Data flow**: A server request id and request parameters come in. Both are cloned so the request can either be queued or handled immediately. The widget then either stores the request for later or starts showing the user the right kind of elicitation UI.

**Call relations**: This is the front door for MCP elicitation requests. It uses `clone` to preserve the incoming id and parameters across the deferred-or-immediate choice, and it hands immediate work to `ChatWidget::handle_elicitation_request_now`.

*Call graph*: 2 external calls (clone, clone).


##### `ChatWidget::on_request_user_input`  (lines 270–277)

```
fn on_request_user_input(&mut self, ev: ToolRequestUserInputParams)
```

**Purpose**: Receives a request for the user to answer one or more questions, such as a planning prompt. It ensures the questions are queued or displayed in the bottom pane.

**Data flow**: A user-input request event comes in. The event is copied so one version can be queued and one can be used immediately. The widget state changes by either saving the prompt for later or opening it for the user.

**Call relations**: This function is the intake point for user-question prompts. It uses `clone` before the deferred-or-immediate split, and the immediate path continues in `ChatWidget::handle_request_user_input_now`.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_request_permissions`  (lines 279–286)

```
fn on_request_permissions(&mut self, ev: RequestPermissionsEvent)
```

**Purpose**: Receives a request asking the user to grant extra permissions. It makes sure that permission request is either queued or shown as an approval card.

**Data flow**: A permissions event comes in. The event is cloned so it can safely go into the pending queue or into immediate processing. The output is a changed UI state: either a stored request or a visible permission approval prompt.

**Call relations**: This is the intake method for permission requests. It uses `clone` before choosing between waiting and immediate handling, and it delegates the immediate display work to `ChatWidget::handle_request_permissions_now`.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::handle_exec_approval_now`  (lines 288–312)

```
fn handle_exec_approval_now(&mut self, ev: ExecApprovalRequestEvent)
```

**Purpose**: Shows the user an approval prompt for running a command. It also sends a notification so the request is noticeable outside the immediate chat text.

**Data flow**: An execution approval event comes in with the command, reason, available choices, and related permission context. The function first separates it from any streaming assistant answer, then formats the command into readable shell-style text using `try_join`. It builds an `ApprovalRequest::Exec`, pushes it into the bottom pane, marks the ambient pet as waiting, and requests a redraw.

**Call relations**: This is called after `ChatWidget::on_exec_approval_request` decides the request should be handled now. It asks the event for its effective approval id and available decisions through `effective_approval_id` and `effective_available_decisions`, then hands the completed approval request to the bottom pane where the user can approve or deny it.

*Call graph*: calls 2 internal fn (effective_approval_id, effective_available_decisions); 1 external calls (try_join).


##### `ChatWidget::handle_apply_patch_approval_now`  (lines 314–336)

```
fn handle_apply_patch_approval_now(&mut self, ev: ApplyPatchApprovalRequestEvent)
```

**Purpose**: Shows the user an approval prompt for proposed file edits. It also sends an edit-approval notification that includes the working folder and changed files.

**Data flow**: An apply-patch event comes in with a call id, reason, and proposed changes. The function stops any streaming answer cleanly, builds an `ApprovalRequest::ApplyPatch` using the current working directory, pushes it into the bottom pane, sets the waiting pet notification, redraws, and notifies about the edit request.

**Call relations**: This is the immediate path used by `ChatWidget::on_apply_patch_approval_request`. It turns raw patch-event data into a UI approval card and hands it to the bottom pane, which is the part of the interface where users make decisions.


##### `ChatWidget::handle_elicitation_request_now`  (lines 338–395)

```
fn handle_elicitation_request_now(
        &mut self,
        request_id: AppServerRequestId,
        params: McpServerElicitationRequestParams,
    )
```

**Purpose**: Shows the right user interface for an MCP server’s request for more information. Depending on the request, it may open an app-link view, show a form, show a simple approval-style prompt, or decline an unsupported URL request.

**Data flow**: A request id and MCP elicitation parameters come in. The function stops any streaming answer, notifies the user, converts the thread id string into a real thread id with `from_string`, and then tries several display options in order. It first tries to create an app-link view with `from_url_app_server_request`; if that does not fit, it tries to create a form request with `from_app_server_request`; if that also does not fit, it either creates a simpler approval request for a form message or automatically declines a URL-style request. It finishes by setting the waiting notification and redrawing.

**Call relations**: This is called by `ChatWidget::on_elicitation_request` when the request can be shown now. It uses `clone` when the same request id or parameters are needed in more than one conversion attempt, and it routes the final result either to an app-link view, the bottom pane’s MCP form flow, the bottom pane’s approval flow, or the app event sender for an automatic decline.

*Call graph*: calls 3 internal fn (from_string, from_url_app_server_request, from_app_server_request); 2 external calls (clone, clone).


##### `ChatWidget::push_approval_request`  (lines 397–405)

```
fn push_approval_request(&mut self, request: ApprovalRequest)
```

**Purpose**: Adds an already-built approval request to the bottom pane and makes the UI visibly wait for the user. This is a small convenience method for code that has already created the request object.

**Data flow**: An approval request comes in. The function gives it to the bottom pane, along with feature flags from the current configuration, then sets the ambient pet notification to waiting and asks the interface to redraw. Nothing is returned; the widget display state is updated.

**Call relations**: Other parts of the chat widget can use this when they already have an `ApprovalRequest` ready. It centralizes the final UI steps so approval prompts consistently appear in the bottom pane with the same waiting signal and redraw behavior.


##### `ChatWidget::push_mcp_server_elicitation_request`  (lines 407–418)

```
fn push_mcp_server_elicitation_request(
        &mut self,
        request: McpServerElicitationFormRequest,
    )
```

**Purpose**: Adds an MCP server form request to the bottom pane and marks the UI as waiting for the user. It is the direct path for elicitation requests that have already been converted into form UI data.

**Data flow**: An MCP elicitation form request comes in. The function pushes it into the bottom pane, sets the ambient pet notification to waiting, and requests a redraw. It returns nothing, but the user now has a visible form to answer.

**Call relations**: This helper is used when a request is already in the bottom pane’s form-request shape. It keeps MCP form prompts consistent with other waiting prompts by using the same pet notification and redraw steps.


##### `ChatWidget::handle_request_user_input_now`  (lines 420–436)

```
fn handle_request_user_input_now(&mut self, ev: ToolRequestUserInputParams)
```

**Purpose**: Shows one or more questions that the assistant wants the user to answer. It also creates a clear notification title, such as a single-question summary or “3 questions requested.”

**Data flow**: A user-input request comes in with a list of questions. The function stops any streaming answer, counts the questions, asks `user_input_request_summary` for a short readable summary when possible, builds a notification title using that summary or `format!`, pushes the request into the bottom pane, sets the waiting pet notification, and redraws.

**Call relations**: This is the immediate handler used after `ChatWidget::on_request_user_input` accepts a prompt for display. It turns raw question data into both a notification and a bottom-pane input prompt, so the user sees that an answer is needed.

*Call graph*: calls 1 internal fn (user_input_request_summary); 1 external calls (format!).


##### `ChatWidget::handle_request_permissions_now`  (lines 438–455)

```
fn handle_request_permissions_now(&mut self, ev: RequestPermissionsEvent)
```

**Purpose**: Shows an approval prompt for a request to grant permissions. This covers cases where the assistant or a tool needs extra access before it can continue.

**Data flow**: A permissions event comes in with a call id, environment id, reason, and requested permissions. The function stops any streaming answer, wraps the data into an `ApprovalRequest::Permissions`, pushes it into the bottom pane with current feature settings, marks the pet as waiting, and redraws the UI.

**Call relations**: This is called by `ChatWidget::on_request_permissions` when the permission request should be displayed immediately. It converts the incoming event into the shared approval-request format so the bottom pane can present it like the other user decisions.


### Hook review RPC
This helper module supports the hook-inspection approval path by fetching hook metadata and persisting trust decisions.

### `tui/src/hooks_rpc.rs`

`io_transport` · `startup and hook review interactions`

Hooks are project-specific actions that can run as part of the tool’s workflow. Because a hook can change behavior, the TUI needs to show users when a hook is new or has changed, and let them mark it as trusted. This file keeps that server communication in one place.

The flow is simple. First, `fetch_hooks_list` sends a typed request to the app server asking for the hooks that apply to a working directory. The server replies with a list grouped by directory. `hooks_list_entry_for_cwd` then picks the entry for the directory the TUI cares about, or creates an empty one if the server did not return it. That fallback keeps the rest of the interface from having to deal with a missing result.

For each hook, `hook_needs_review` checks whether its trust status says it is untrusted or modified. If the user chooses to trust one or more hooks, `write_hook_trusts` turns those choices into a configuration write under `hooks.state`, storing the hook’s current hash as its trusted hash. A hash is a short fingerprint of the hook contents; trusting the hash means “I trust this exact version.” `write_hook_trust` is a convenience wrapper for saving just one hook.

#### Function details

##### `fetch_hooks_list`  (lines 24–36)

```
async fn fetch_hooks_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<HooksListResponse>
```

**Purpose**: Asks the app server for the list of hooks that apply to one working directory. The TUI uses this when it needs to show hook status to the user, especially during startup review.

**Data flow**: It receives an app server request handle and a directory path. It creates a fresh request ID, wraps the directory in a hooks-list request, sends it through the typed server request channel, and awaits the reply. On success it returns the server’s hooks-list response; on failure it adds a clear TUI-specific error message.

**Call relations**: This is the first step when hook information is needed. `load_startup_hooks_review_entry` calls on it during startup review, and the call graph also records it as calling through the request machinery used to send the typed request to the server.

*Call graph*: calls 1 internal fn (request_typed); called by 2 (fetch_hooks_list, load_startup_hooks_review_entry); 3 external calls (String, format!, vec!).


##### `hooks_list_entry_for_cwd`  (lines 38–49)

```
fn hooks_list_entry_for_cwd(response: HooksListResponse, cwd: &Path) -> HooksListEntry
```

**Purpose**: Finds the hook-list result for one specific working directory. If the server did not include that directory, it returns a safe empty entry instead of making callers handle a missing value.

**Data flow**: It receives the full hooks-list response and the directory the TUI is interested in. It searches the response entries for a matching path. It returns the matching entry, or creates a new entry with the requested directory and empty hooks, warnings, and errors.

**Call relations**: After hook data has been fetched, `on_hooks_loaded` and `load_startup_hooks_review_entry` use this helper to narrow the larger server response down to the directory currently being reviewed or displayed.

*Call graph*: called by 2 (on_hooks_loaded, load_startup_hooks_review_entry).


##### `hook_needs_review`  (lines 51–56)

```
fn hook_needs_review(hook: &HookMetadata) -> bool
```

**Purpose**: Answers the simple user-facing question: does this hook need attention before it should be trusted? It returns true for hooks that are new to the user or whose contents have changed since they were trusted.

**Data flow**: It receives one hook’s metadata, reads its trust status, and checks whether that status is `Untrusted` or `Modified`. It returns a boolean: true means the UI should treat the hook as needing review; false means it does not.

**Call relations**: Selection and trust actions use this as their shared rule. `toggle_selected_hook`, `trust_selected_hook`, and `trust_all_hooks` call it so they only act on hooks that actually need review.

*Call graph*: called by 3 (toggle_selected_hook, trust_all_hooks, trust_selected_hook); 1 external calls (matches!).


##### `write_hook_trusts`  (lines 58–92)

```
async fn write_hook_trusts(
    request_handle: AppServerRequestHandle,
    trust_updates: Vec<HookTrustUpdate>,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Saves trust decisions for one or more hooks into the user configuration. This is what makes the user’s choice persist after the TUI closes.

**Data flow**: It receives an app server request handle and a list of trust updates, where each update has a hook key and the hook’s current hash. It builds a JSON object mapping each hook key to its `trusted_hash`, then sends a batch config write request for `hooks.state` using an upsert strategy, meaning existing data is updated or created as needed. It returns the server’s config-write response, or an error with context if the write fails.

**Call relations**: This is the main save path for trust changes. Higher-level flows such as `trust_hooks`, `run_startup_hooks_review_app`, and the single-hook wrapper `write_hook_trust` call it when the user has approved hooks and the TUI needs to record that approval.

*Call graph*: calls 1 internal fn (request_typed); called by 3 (trust_hooks, write_hook_trust, run_startup_hooks_review_app); 4 external calls (String, format!, Object, vec!).


##### `write_hook_trust`  (lines 94–100)

```
async fn write_hook_trust(
    request_handle: AppServerRequestHandle,
    key: String,
    current_hash: String,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Saves trust for a single hook. It exists so callers with only one hook do not have to build a one-item update list themselves.

**Data flow**: It receives the app server request handle, one hook key, and that hook’s current hash. It wraps those two pieces of hook information into a `HookTrustUpdate`, puts it in a one-item list, and passes it to `write_hook_trusts`. It returns whatever response or error the multi-hook save function returns.

**Call relations**: `trust_hook` calls this when the user trusts one hook at a time. This function immediately hands the real work to `write_hook_trusts`, keeping single-hook and multi-hook saves on the same code path.

*Call graph*: calls 1 internal fn (write_hook_trusts); called by 1 (trust_hook); 1 external calls (vec!).
