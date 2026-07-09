# Approval-mediated tool orchestration and approval UI  `stage-14.1.5`

This stage sits at the boundary between runtime tool execution and the user-facing approval experience. Its core job is to ensure every consequential tool call runs through policy checks, sandbox and network decisions, and any required user confirmation before execution proceeds. The central coordinator is core/src/tools/orchestrator.rs, which drives approval, sandbox selection, first execution, telemetry, and retry with escalated permissions when allowed. For MCP-backed tools, core/src/mcp_tool_approval_templates.rs supplies the exact approval wording and readable parameter labels shown to users.

On the TUI side, tui/src/approval_events.rs normalizes server approval payloads into renderable request models, and tui/src/chatwidget/tool_requests.rs turns those requests into overlays, footer status, notifications, and transcript entries. tui/src/bottom_pane/approval_overlay.rs presents concrete approval choices for exec, patch, permission, and elicitation requests, while tui/src/bottom_pane/request_user_input/mod.rs manages richer structured questionnaires and queued prompts. Permission selection flows live in tui/src/chatwidget/permission_popups.rs and tui/src/chatwidget/permissions_menu.rs, with Windows-specific sandbox guidance in tui/src/chatwidget/windows_sandbox_prompts.rs. Cross-thread visibility comes from tui/src/bottom_pane/pending_thread_approvals.rs, recent guardian denials are summarized by tui/src/auto_review_denials.rs, and tui/src/hooks_rpc.rs supports hook-review trust decisions.

## Files in this stage

### Approval orchestration core
These files define the approval prompt content and drive the end-to-end runtime flow that decides when tool execution needs user approval or escalation.

### `core/src/mcp_tool_approval_templates.rs`

`domain_logic` · `approval prompt rendering`

This module turns a bundled JSON template file into richer approval prompts for MCP tool calls, especially Codex Apps connector actions. The static `CONSEQUENTIAL_TOOL_MESSAGE_TEMPLATES` is a `LazyLock<Option<Vec<...>>>`, so parsing happens once on first use. `load_consequential_tool_message_templates` deserializes `consequential_tool_message_templates.json`, verifies the schema version against `CONSEQUENTIAL_TOOL_MESSAGE_TEMPLATES_SCHEMA_VERSION`, and disables templating entirely if parsing or version validation fails, logging a warning instead of panicking.

Rendering is intentionally strict. `render_mcp_tool_approval_template` simply forwards to `render_mcp_tool_approval_template_from_templates` using the bundled templates. The renderer requires an exact triple match on `server_name`, `connector_id`, and trimmed `tool_title`; partial matches are ignored. The question text is produced by `render_question_template`, which trims whitespace, rejects empty templates, and only substitutes `{connector_name}` when a non-empty connector name is available. Tool parameters are rendered by `render_tool_params`, which preserves the original object as `tool_params` while producing an ordered display list. Template-declared params appear first with human-friendly labels, remaining params are appended sorted by key, and any display-name collision or blank label causes the whole render to fail with `None`. Tests cover exact matches, missing matches, label collisions, bundled-template loading, literal templates without connector substitution, and failure when a connector placeholder lacks a value.

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

**Purpose**: Renders an approval template from the bundled template set for a specific server, connector, tool title, and optional parameter object. It is the public entrypoint used by approval prompting code.

**Data flow**: Accepts `server_name`, optional `connector_id`, optional `connector_name`, optional `tool_title`, and optional `tool_params`. It reads the lazily loaded bundled templates from `CONSEQUENTIAL_TOOL_MESSAGE_TEMPLATES`; if unavailable it returns `None`. Otherwise it forwards all inputs to `render_mcp_tool_approval_template_from_templates` and returns that `Option<RenderedMcpToolApprovalTemplate>`.

**Call relations**: Called by MCP tool approval flow when building user-facing prompts. It delegates all matching and rendering logic to `render_mcp_tool_approval_template_from_templates`.

*Call graph*: calls 1 internal fn (render_mcp_tool_approval_template_from_templates); called by 1 (maybe_request_mcp_tool_approval).


##### `load_consequential_tool_message_templates`  (lines 71–92)

```
fn load_consequential_tool_message_templates() -> Option<Vec<ConsequentialToolMessageTemplate>>
```

**Purpose**: Parses the bundled JSON template file and validates its schema version before exposing the templates. Failures are downgraded to warnings and disable templating.

**Data flow**: Reads the embedded JSON string via `include_str!`, attempts `serde_json::from_str::<ConsequentialToolMessageTemplatesFile>`, logs and returns `None` on parse failure, compares `schema_version` to `CONSEQUENTIAL_TOOL_MESSAGE_TEMPLATES_SCHEMA_VERSION`, logs and returns `None` on mismatch, and otherwise returns `Some(templates.templates)`.

**Call relations**: Used only as the initializer for the `LazyLock` static. All runtime rendering depends on this one-time load succeeding.

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

**Purpose**: Finds an exact matching template and renders both the approval question text and display-friendly parameter list. It enforces strict matching and rejects malformed inputs.

**Data flow**: Takes a template slice plus `server_name`, optional `connector_id`, optional `connector_name`, optional `tool_title`, and optional `tool_params`. It requires non-`None` `connector_id` and non-empty trimmed `tool_title`, finds the first template whose `server_name`, `connector_id`, and `tool_title` all match exactly, renders the question via `render_question_template`, and then either renders object parameters with `render_tool_params`, rejects non-object `tool_params`, or uses `(None, Vec::new())` when params are absent. On success it returns `Some(RenderedMcpToolApprovalTemplate { question, elicitation_message, tool_params, tool_params_display })`.

**Call relations**: This is the implementation behind the public renderer and is also exercised directly by tests. It delegates text substitution to `render_question_template` and parameter shaping to `render_tool_params`.

*Call graph*: calls 2 internal fn (render_question_template, render_tool_params); called by 3 (render_mcp_tool_approval_template, renders_exact_match_with_readable_param_labels, renders_literal_template_without_connector_substitution); 2 external calls (new, iter).


##### `render_question_template`  (lines 126–140)

```
fn render_question_template(template: &str, connector_name: Option<&str>) -> Option<String>
```

**Purpose**: Produces the final approval question string from a template, optionally substituting the connector name placeholder. It rejects empty templates and unresolved connector placeholders.

**Data flow**: Accepts `template: &str` and optional `connector_name`. It trims the template and returns `None` if empty. If the template contains `{connector_name}`, it requires a non-empty trimmed connector name and returns `template.replace(...)`; otherwise it returns `Some(template.to_string())`.

**Call relations**: Called only by `render_mcp_tool_approval_template_from_templates` as the text-rendering step before parameter rendering.

*Call graph*: called by 1 (render_mcp_tool_approval_template_from_templates).


##### `render_tool_params`  (lines 142–190)

```
fn render_tool_params(
    tool_params: &Map<String, Value>,
    template_params: &[ConsequentialToolTemplateParam],
) -> Option<(Option<Value>, Vec<RenderedMcpToolApprovalParam>)>
```

**Purpose**: Builds the ordered parameter display list for an approval prompt while preserving the original parameter object. Template-labeled parameters come first, and unlabeled leftovers are appended in sorted order.

**Data flow**: Inputs are `tool_params: &Map<String, Value>` and `template_params`. It initializes `display_params`, `display_names`, and `handled_names`. For each template param it trims the label, rejects blank labels, looks up the named value in `tool_params`, skips missing values, rejects duplicate display labels, pushes a `RenderedMcpToolApprovalParam` with the friendly label, and marks the param handled. It then collects remaining unhandled params, sorts them by key, rejects any display-name collision with existing labels, appends them using their raw names as display names, and returns `Some((Some(Value::Object(tool_params.clone())), display_params))`.

**Call relations**: Used by `render_mcp_tool_approval_template_from_templates` to produce the structured parameter display metadata consumed by approval UIs. Its collision checks are what cause some template renders to fail with `None`.

*Call graph*: called by 1 (render_mcp_tool_approval_template_from_templates); 6 external calls (new, clone, get, iter, Object, new).


##### `tests::renders_exact_match_with_readable_param_labels`  (lines 200–260)

```
fn renders_exact_match_with_readable_param_labels()
```

**Purpose**: Verifies successful rendering for an exact template match, including connector-name substitution and ordered readable parameter labels. It also checks that unspecified parameters are preserved and appended.

**Data flow**: Builds an in-memory template vector for a calendar `create_event` tool, calls `render_mcp_tool_approval_template_from_templates` with matching server/connector/tool and a JSON object containing labeled and unlabeled params, and asserts the returned `RenderedMcpToolApprovalTemplate` exactly matches the expected question text, original `tool_params`, and ordered `tool_params_display` entries.

**Call relations**: Directly exercises the internal renderer rather than the bundled-template wrapper. It validates the happy path across both `render_question_template` and `render_tool_params`.

*Call graph*: calls 1 internal fn (render_mcp_tool_approval_template_from_templates); 3 external calls (assert_eq!, json!, vec!).


##### `tests::returns_none_when_no_exact_match_exists`  (lines 263–283)

```
fn returns_none_when_no_exact_match_exists()
```

**Purpose**: Checks that rendering fails when the tool title does not exactly match any template. This confirms the renderer does not fall back to fuzzy or partial matching.

**Data flow**: Creates a single template for `create_event`, calls `render_mcp_tool_approval_template_from_templates` with `delete_event`, and asserts the result is `None`.

**Call relations**: Targets the exact-match lookup behavior inside `render_mcp_tool_approval_template_from_templates`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::returns_none_when_relabeling_would_collide`  (lines 286–312)

```
fn returns_none_when_relabeling_would_collide()
```

**Purpose**: Ensures rendering fails if a template-assigned display label would collide with another parameter’s display name. This protects the approval UI from ambiguous parameter labels.

**Data flow**: Creates a template that relabels `calendar_id` to `timezone`, then renders against params containing both `calendar_id` and `timezone`. It asserts the renderer returns `None` because `render_tool_params` detects the duplicate display name.

**Call relations**: Exercises the collision-detection branch in `render_tool_params` through the internal renderer.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::bundled_templates_load`  (lines 315–317)

```
fn bundled_templates_load()
```

**Purpose**: Sanity-checks that the bundled template file parses and passes schema validation in the test environment. It guards against broken embedded JSON or version drift.

**Data flow**: Reads the lazily initialized `CONSEQUENTIAL_TOOL_MESSAGE_TEMPLATES` static and asserts `is_some()` is `true`.

**Call relations**: Indirectly validates `load_consequential_tool_message_templates`, since the static initializer runs that function.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::renders_literal_template_without_connector_substitution`  (lines 320–347)

```
fn renders_literal_template_without_connector_substitution()
```

**Purpose**: Verifies that templates without the `{connector_name}` placeholder render successfully even when no connector name is supplied. It distinguishes literal templates from substitution-required templates.

**Data flow**: Creates a template whose text already names GitHub literally, calls `render_mcp_tool_approval_template_from_templates` with `connector_name` set to `None` and empty params, and asserts the returned rendered template contains the literal question text and empty display params.

**Call relations**: Exercises the non-substitution branch of `render_question_template` through the internal renderer.

*Call graph*: calls 1 internal fn (render_mcp_tool_approval_template_from_templates); 3 external calls (assert_eq!, json!, vec!).


##### `tests::returns_none_when_connector_placeholder_has_no_value`  (lines 350–370)

```
fn returns_none_when_connector_placeholder_has_no_value()
```

**Purpose**: Ensures rendering fails when a template requires `{connector_name}` substitution but no connector name is available. This prevents prompts with unresolved placeholders.

**Data flow**: Creates a template containing `{connector_name}`, calls `render_mcp_tool_approval_template_from_templates` with `connector_name` set to `None`, and asserts the result is `None`.

**Call relations**: Targets the placeholder-resolution requirement enforced by `render_question_template`.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `core/src/tools/orchestrator.rs`

`orchestration` · `tool execution path around each tool call`

This module is the high-level execution controller for tools. `ToolOrchestrator` owns a `SandboxManager`, and `OrchestratorRunResult<Out>` bundles the tool’s output with any `DeferredNetworkApproval` that must be finalized later. The orchestrator’s job is not to implement tool behavior itself, but to sequence policy checks and retries around arbitrary `ToolRuntime` implementations.

`run` begins by deriving telemetry labels from `flat_tool_name`, checking strict auto-review mode, and computing the tool’s `ExecApprovalRequirement` either from the tool or from default policy. It handles three approval cases: skip, forbidden, or explicit approval required. Approval requests may first consult permission-request hooks; otherwise they go through guardian or user approval via `request_approval`. `reject_if_not_approved` converts review outcomes into `ToolError::Rejected`, including guardian-specific rejection and timeout messages.

After approval, `run` selects the initial sandbox using `sandbox_override_for_first_attempt` and `SandboxManager::select_initial`, builds a `SandboxAttempt` with filesystem/network policy, workspace roots, cwd, platform-specific sandbox flags, and managed-network enforcement, then delegates actual execution to `run_attempt`. That helper wraps the tool run with `begin_network_approval` and either immediate or deferred network-approval finalization depending on `NetworkApprovalMode`.

If the first attempt succeeds, the orchestrator returns immediately. If it fails with `SandboxErr::Denied`, `run` decides whether retry is allowed: it inspects any embedded network-policy decision, whether the tool escalates on failure, whether unsandboxed execution is permitted, and whether approval policy allows a no-sandbox retry. For retries it builds a concise reason string—either a network-specific denial or the stable fallback `"command failed; retry without sandbox?"`—requests fresh approval when needed, constructs a second `SandboxAttempt` (often unsandboxed), and runs the tool again. Throughout, it emits telemetry decisions and sandbox outcomes, distinguishing initial denial, escalation success, timeout, and signal cases.

#### Function details

##### `ToolOrchestrator::new`  (lines 55–59)

```
fn new() -> Self
```

**Purpose**: Constructs a new orchestrator with its own `SandboxManager`. This is the standard entry point for code that needs to run tools under approval and sandbox policy.

**Data flow**: Allocates `SandboxManager::new()` → stores it in `ToolOrchestrator { sandbox }` → returns the new orchestrator.

**Call relations**: Session and tool-handling setup code instantiate the orchestrator before dispatching tool runs. It does not perform execution itself; it prepares the reusable sandbox-selection component.

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

**Purpose**: Executes one concrete tool attempt under a specific `SandboxAttempt`, wrapping the run with network-approval registration and finalization. It returns both the tool result and any deferred network-approval handle that survives the attempt.

**Data flow**: Reads mutable `tool`, request `req`, `tool_ctx`, chosen `attempt`, and `managed_network_active` → calls `begin_network_approval` using the tool’s `network_approval_spec(req, tool_ctx)` → clones session/turn/call metadata into a fresh `ToolCtx`, copies the sandbox attempt while injecting `network_denial_cancellation_token` from the active approval, and awaits `tool.run(req, &attempt_with_network_approval, &attempt_tool_ctx)` → if no network approval was started, returns the run result with `None`; otherwise branches on `network_approval.mode()`: immediate mode calls `finish_immediate_network_approval` and may replace the tool result with an error, while deferred mode converts to `DeferredNetworkApproval`, eagerly finishes it only when the tool run itself failed, and otherwise returns the deferred handle alongside the run result.

**Call relations**: The main `run` method calls this for both the initial and retry attempts. It delegates actual tool execution to the `ToolRuntime`, and delegates network-approval lifecycle work to `begin_network_approval`, `finish_immediate_network_approval`, and `finish_deferred_network_approval`.

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

**Purpose**: Drives the full tool-execution lifecycle: approval, sandbox selection, first attempt, sandbox-denial analysis, optional re-approval, and retry. It is the orchestrator’s main policy engine.

**Data flow**: Consumes mutable `tool`, request `req`, `tool_ctx`, `turn_ctx`, and `approval_policy` → derives telemetry labels and strict-auto-review state, computes filesystem/network sandbox policies and the tool’s `ExecApprovalRequirement`, and may request approval through `request_approval` followed by `reject_if_not_approved` → selects the initial sandbox using `sandbox_override_for_first_attempt` and `SandboxManager::select_initial`, builds an initial `SandboxAttempt`, times it, and calls `run_attempt`.

If the first attempt succeeds, returns `OrchestratorRunResult { output, deferred_network_approval }`. If it fails with `SandboxErr::Denied`, it extracts any network approval context from the denial payload, checks whether retry/escalation is allowed by tool policy, approval policy, and unsandboxed-execution rules, and may return the original denial unchanged. Otherwise it builds a retry reason, optionally requests fresh approval (especially for strict auto-review or network-related retries), constructs a retry `SandboxAttempt`—often with `SandboxType::None` when unsandboxed execution is allowed—times and runs it, emits telemetry for denied/escalated/timed-out/signal outcomes, and returns either the retry result or the retry error. Non-sandbox errors skip retry and only contribute telemetry when they map to a sandbox outcome.

**Call relations**: Higher-level tool handlers call this as the single entry point for executing a `ToolRuntime`. Internally it coordinates nearly every helper in the file plus sandboxing and network-approval helpers from other modules.

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

**Purpose**: Obtains an approval decision for a tool action, giving permission-request hooks first chance to answer before falling back to the tool’s normal async approval path. It also records the decision source in telemetry.

**Data flow**: Reads mutable `tool`, request `req`, `permission_request_run_id`, `approval_ctx`, `tool_ctx`, `evaluate_permission_request_hooks`, and telemetry handle `otel` → if hook evaluation is enabled and `tool.permission_request_payload(req)` returns a payload, calls `run_permission_request_hooks`; hook allow returns `ReviewDecision::Approved` and logs a config-sourced telemetry decision, hook deny logs `Denied` and returns `Err(ToolError::Rejected(message))`, and no hook decision falls through → otherwise determines telemetry source from presence of `guardian_review_id`, awaits `tool.start_approval_async(req, approval_ctx)`, logs the resulting `ReviewDecision`, and returns it.

**Call relations**: The main `run` method calls this for initial approvals and retry approvals. It delegates to permission hooks when configured, otherwise to the tool runtime’s own approval implementation, and always feeds the result into telemetry.

*Call graph*: calls 3 internal fn (run_permission_request_hooks, flat_tool_name, tool_decision); 3 external calls (permission_request_payload, start_approval_async, Rejected).


##### `ToolOrchestrator::reject_if_not_approved`  (lines 551–578)

```
async fn reject_if_not_approved(
        tool_ctx: &ToolCtx,
        guardian_review_id: Option<&str>,
        decision: ReviewDecision,
    ) -> Result<(), ToolError>
```

**Purpose**: Converts a `ReviewDecision` into either success or a concrete rejection error. It centralizes guardian-specific rejection and timeout messaging.

**Data flow**: Reads `tool_ctx`, optional `guardian_review_id`, and `decision` → matches the decision: `Denied`/`Abort` become `Err(ToolError::Rejected(...))` using `guardian_rejection_message` when a guardian review ID exists or a generic user-rejection string otherwise; `TimedOut` becomes `Err(ToolError::Rejected(guardian_timeout_message()))`; approved variants return `Ok(())`; `NetworkPolicyAmendment` returns `Ok(())` for allow amendments and a generic rejection for deny amendments.

**Call relations**: After every approval request, `run` calls this to enforce the decision before proceeding. It delegates guardian-specific message generation to guardian helpers and keeps approval-result interpretation consistent across initial and retry flows.

*Call graph*: 3 external calls (Rejected, guardian_rejection_message, guardian_timeout_message).


##### `sandbox_outcome_from_tool_error`  (lines 581–588)

```
fn sandbox_outcome_from_tool_error(err: &ToolError) -> Option<&'static str>
```

**Purpose**: Maps sandbox-related `ToolError` variants to the short outcome labels used in telemetry. Non-sandbox rejections and generic codex errors intentionally produce no label.

**Data flow**: Reads `err: &ToolError` → matches nested `CodexErr::Sandbox` variants to `Some("denied")`, `Some("timed_out")`, or `Some("signal")`; returns `None` for `ToolError::Rejected(_)` and other codex errors.

**Call relations**: The main `run` method calls this after failed attempts to decide whether to emit a sandbox outcome metric. It is a pure classification helper.

*Call graph*: called by 1 (run).


##### `build_denial_reason_from_output`  (lines 590–594)

```
fn build_denial_reason_from_output(_output: &ExecToolCallOutput) -> String
```

**Purpose**: Produces the stable human-facing retry reason used when a sandboxed command fails and the orchestrator wants approval to retry without sandboxing. It currently ignores the actual output content by design.

**Data flow**: Reads `_output: &ExecToolCallOutput` but does not inspect it → returns the fixed string `"command failed; retry without sandbox?"`.

**Call relations**: The retry branch in `run` calls this when there is no network-specific denial context. The helper exists so heuristics can evolve later without changing call sites.

*Call graph*: called by 1 (run).


### Approval event shaping
These files normalize incoming approval-related signals and maintain compact summaries that the UI can render or reference later.

### `tui/src/approval_events.rs`

`data_model` · `request handling`

This file contains the local structs the TUI keeps while approval prompts are queued or rendered. `ExecApprovalRequestEvent` mirrors execution-approval data from the app server but adds convenience behavior around missing ids and decision lists. Its fields preserve command argv, cwd, optional reason, proposed exec/network policy amendments, optional network approval context, optional additional permissions, and any explicitly supplied available decisions. `ApplyPatchApprovalRequestEvent` is the patch-approval counterpart, storing a `HashMap<PathBuf, FileChange>` display model rather than raw protocol changes so the UI can render diffs directly.

The main logic lives on `ExecApprovalRequestEvent`. `effective_approval_id` falls back from `approval_id` to `call_id`, which is important because older or alternate payloads may omit a dedicated approval id. `effective_available_decisions` either clones the server-provided decision list or synthesizes one with `default_available_decisions`. That synthesis is context-sensitive: network approvals offer accept, accept-for-session, optionally an `ApplyNetworkPolicyAmendment` decision for the first allow amendment, then cancel; approvals carrying `additional_permissions` are intentionally restricted to accept/cancel; ordinary exec approvals offer accept, optionally accept-with-execpolicy-amendment, then cancel.

The design preserves app-server decision enums intact instead of inventing TUI-specific variants, minimizing translation work when the user eventually submits a decision back to the server.

#### Function details

##### `ExecApprovalRequestEvent::effective_approval_id`  (lines 45–49)

```
fn effective_approval_id(&self) -> String
```

**Purpose**: Returns the stable approval identifier the TUI should use for this execution approval, falling back to the call id when no explicit approval id is present.

**Data flow**: It reads `self.approval_id`; if `Some`, it clones and returns that string. Otherwise it clones and returns `self.call_id`.

**Call relations**: This helper is used by approval-handling code that needs a single identifier regardless of whether the upstream payload carried a dedicated `approval_id`.


##### `ExecApprovalRequestEvent::effective_available_decisions`  (lines 51–61)

```
fn effective_available_decisions(&self) -> Vec<CommandExecutionApprovalDecision>
```

**Purpose**: Returns the list of decisions the UI should present for this approval, preferring an explicit server-provided list and otherwise synthesizing defaults from the approval context.

**Data flow**: It reads `self.available_decisions`. If present, it clones and returns that vector. If absent, it passes `self.network_approval_context`, `self.proposed_execpolicy_amendment`, `self.proposed_network_policy_amendments`, and `self.additional_permissions` into `Self::default_available_decisions` and returns the generated vector.

**Call relations**: Approval rendering code calls this to populate buttons or menu choices. It delegates fallback synthesis to `default_available_decisions` so the context-sensitive rules live in one place.

*Call graph*: 1 external calls (default_available_decisions).


##### `ExecApprovalRequestEvent::default_available_decisions`  (lines 63–106)

```
fn default_available_decisions(
        network_approval_context: Option<&NetworkApprovalContext>,
        proposed_execpolicy_amendment: Option<&ExecPolicyAmendment>,
        proposed_network_policy_
```

**Purpose**: Synthesizes the default execution-approval decision list from network context, proposed policy amendments, and additional-permissions requests.

**Data flow**: It takes optional references to network approval context, execpolicy amendment, network policy amendments slice, and additional permissions. If network context exists, it builds `[Accept, AcceptForSession]`, optionally appends `ApplyNetworkPolicyAmendment` for the first amendment whose action is `Allow`, then appends `Cancel`. If additional permissions exist without network context, it returns `[Accept, Cancel]`. Otherwise it starts with `[Accept]`, optionally appends `AcceptWithExecpolicyAmendment { ... }`, then appends `Cancel`.

**Call relations**: This is the fallback logic used by `effective_available_decisions` when the server did not explicitly enumerate allowed decisions. It encodes the TUI's default approval UX policy for different approval categories.

*Call graph*: 1 external calls (vec!).


### `tui/src/auto_review_denials.rs`

`domain_logic` · `request handling`

This file provides a small in-memory model for the TUI's recent auto-review denial UX. `RecentAutoReviewDenials` wraps a `VecDeque<GuardianAssessmentEvent>` and keeps only the most recent denied events, capped by `MAX_RECENT_DENIALS` at 10. The `push` method enforces two invariants: only events whose `status` is `GuardianAssessmentStatus::Denied` are stored, and entries are deduplicated by `event.id` before the newest copy is pushed to the front. After insertion, the deque is truncated to the fixed maximum, so the structure behaves like a recency-ordered bounded cache.

The remaining methods are simple accessors: `is_empty` checks whether any denials are stored, `entries` exposes an iterator over the deque in newest-first order, and `take` removes and returns a denial by id if present. This supports UI flows where the user selects a recent denial for retry approval and the item should disappear from the list once consumed.

The standalone `action_summary` function turns a `GuardianAssessmentAction` into a short display string. It preserves shell commands directly, shell-quotes `Execve` argv with `shlex::try_join` and falls back to space-joining on quoting failure, summarizes patch actions by file count, formats network targets and MCP tool calls with readable labels, and uses the optional reason for permission requests when available. The included test verifies the bounded newest-first retention behavior.

#### Function details

##### `RecentAutoReviewDenials::push`  (lines 15–23)

```
fn push(&mut self, event: GuardianAssessmentEvent)
```

**Purpose**: Adds a denied guardian assessment to the recent-denials list, deduplicating by id and enforcing the fixed maximum size.

**Data flow**: It takes a `GuardianAssessmentEvent` by value. If `event.status` is not `Denied`, it returns immediately without mutation. Otherwise it removes any existing entries whose `id` matches `event.id`, pushes the new event to the front of `self.entries`, truncates the deque to `MAX_RECENT_DENIALS`, and returns `()`.

**Call relations**: This method is called when new guardian assessment events arrive and the TUI wants to maintain a short retryable history. It performs all recency ordering and deduplication locally.

*Call graph*: 3 external calls (push_front, retain, truncate).


##### `RecentAutoReviewDenials::is_empty`  (lines 25–27)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether there are any stored recent denial events.

**Data flow**: It reads `self.entries.is_empty()` and returns the resulting boolean.

**Call relations**: UI code uses this to decide whether to show recent-denial affordances or empty-state behavior.

*Call graph*: 1 external calls (is_empty).


##### `RecentAutoReviewDenials::entries`  (lines 29–31)

```
fn entries(&self) -> impl Iterator<Item = &GuardianAssessmentEvent>
```

**Purpose**: Returns an iterator over stored denial events in newest-first order.

**Data flow**: It borrows `self.entries` and returns `self.entries.iter()`, yielding `&GuardianAssessmentEvent` items.

**Call relations**: Rendering code uses this to list recent denials without taking ownership of the stored events.

*Call graph*: 1 external calls (iter).


##### `RecentAutoReviewDenials::take`  (lines 33–36)

```
fn take(&mut self, id: &str) -> Option<GuardianAssessmentEvent>
```

**Purpose**: Removes and returns a stored denial event by id.

**Data flow**: It takes `&str` id, searches `self.entries.iter().position(...)` for a matching `entry.id`, returns `None` if not found, otherwise removes that index from the deque and returns the owned `GuardianAssessmentEvent`.

**Call relations**: Selection/approval flows call this when the user chooses a recent denial to act on, so the consumed item no longer appears in the recent list.

*Call graph*: 2 external calls (iter, remove).


##### `action_summary`  (lines 39–75)

```
fn action_summary(action: &GuardianAssessmentAction) -> String
```

**Purpose**: Formats a concise human-readable summary string for a guardian assessment action.

**Data flow**: It pattern-matches `&GuardianAssessmentAction`. `Command` returns the command string clone. `Execve` uses `argv` if non-empty or `[program]` otherwise, then tries `shlex::try_join` and falls back to `join(" ")`. `ApplyPatch` formats either a single touched path or a file count. `NetworkAccess` formats the target. `McpToolCall` uses `connector_name` when present, otherwise `server`, and formats `MCP <tool> on <label>`. `RequestPermissions` uses the optional reason when present, otherwise a generic label. It returns the resulting `String`.

**Call relations**: This helper is used wherever the TUI needs a short label for a denied action, such as recent-denial menus or status text.

*Call graph*: 3 external calls (format!, try_join, vec!).


##### `tests::denied_event`  (lines 86–104)

```
fn denied_event(id: usize) -> GuardianAssessmentEvent
```

**Purpose**: Builds a synthetic denied guardian assessment event fixture for tests.

**Data flow**: It takes a numeric id, formats strings for `id`, `rationale`, and command text, constructs a `GuardianAssessmentEvent` with `status: Denied` and a `GuardianAssessmentAction::Command` rooted at `/tmp`, and returns it.

**Call relations**: The retention test uses this helper to generate a sequence of distinct denial events without repeating fixture boilerplate.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `tests::keeps_only_ten_most_recent_denials`  (lines 107–132)

```
fn keeps_only_ten_most_recent_denials()
```

**Purpose**: Verifies that the recent-denials structure retains only the ten newest denied events in newest-first order.

**Data flow**: It creates a default `RecentAutoReviewDenials`, pushes twelve generated denied events into it, iterates over `entries()` to collect ids, and asserts that only `review-11` through `review-2` remain in descending recency order.

**Call relations**: This test documents the bounded-cache behavior implemented by `RecentAutoReviewDenials::push`.

*Call graph*: 3 external calls (assert_eq!, default, denied_event).


### Approval and input overlays
These bottom-pane components present the main interactive approval and structured-response surfaces, plus lightweight visibility for pending approvals elsewhere.

### `tui/src/bottom_pane/approval_overlay.rs`

`orchestration` · `request handling while waiting for user approval`

This module is the approval-specific orchestration layer for bottom-pane modals. `ApprovalRequest` models four request families: command execution, permission grants, file changes, and MCP elicitation. `ApprovalOverlay` owns the currently displayed request, a queue of pending requests, a `ListSelectionView` for rendering and navigation, the derived `ApprovalOption` list, and keymaps for both generic list movement and approval-specific shortcuts.

The core flow is: construct the overlay with one request, derive a request-specific header and option set, render them through `ListSelectionView`, and on selection emit the corresponding app event. `build_options` chooses labels and shortcuts based on request type; for exec requests it adapts wording for network approvals and additional permissions, while MCP elicitation gets a special invariant: `Esc` must always mean `Cancel`, even if user keybindings overlap with decline. `apply_selection` dispatches to request-type-specific handlers, which in turn emit thread-scoped approval ops and, for some local-thread cases, insert history cells describing the user's decision.

The overlay also supports queueing multiple requests, dismissing stale requests resolved elsewhere, opening a fullscreen approval view, and jumping to the source thread for cross-thread approvals. Cancellation is explicit and type-aware: exec becomes `Cancel`, permissions become deny/empty grant, patch becomes `Cancel`, and elicitation becomes `Cancel`. Rendering itself is delegated almost entirely to the embedded `ListSelectionView`; this file's main responsibility is decision semantics, option construction, and shortcut policy.

#### Function details

##### `ApprovalRequest::thread_id`  (lines 109–116)

```
fn thread_id(&self) -> ThreadId
```

**Purpose**: Returns the `ThreadId` associated with any approval request variant.

**Data flow**: Pattern-matches `self` across all `ApprovalRequest` variants and copies out the stored `thread_id`.

**Call relations**: Used by decision handlers and thread-opening shortcuts so the overlay can route responses and navigation back to the originating thread without duplicating variant-specific extraction logic.


##### `ApprovalRequest::thread_label`  (lines 118–125)

```
fn thread_label(&self) -> Option<&str>
```

**Purpose**: Returns the optional human-readable source thread label for cross-thread approvals.

**Data flow**: Pattern-matches `self` across all variants and returns `thread_label.as_deref()`.

**Call relations**: Used when building footer hints and deciding whether the open-thread shortcut should be available.

*Call graph*: called by 1 (approval_footer_hint).


##### `ApprovalRequest::matches_resolved_request`  (lines 127–154)

```
fn matches_resolved_request(&self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Checks whether an externally resolved app-server request corresponds to this approval request.

**Data flow**: Matches `(self, request)` across compatible variant pairs and compares the relevant identifiers: exec id, permissions call id, patch id, or MCP server name plus request id → returns true only for an exact match.

**Call relations**: Called by `ApprovalOverlay::dismiss_resolved_request` to remove queued requests or close the current overlay when another client already answered the request.


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

**Purpose**: Constructs an approval overlay around an initial request and immediately derives its current option list and list view.

**Data flow**: Takes an initial `ApprovalRequest`, `AppEventSender`, feature flags, and keymaps → initializes empty current/queue state plus a default `ListSelectionView` → stores cloned sender and keymaps → calls `set_current(request)` to build the real header/options/list state → returns the overlay.

**Call relations**: This is the main constructor used when the app first surfaces an approval request. It delegates request-specific setup to `set_current` so queue advancement can reuse the same path.

*Call graph*: calls 1 internal fn (new); called by 4 (maybe_show_delayed_approval_requests_at, push_approval_request, apply_patch_prompt_with_thread_label_omits_command_line, make_overlay_with_keymap); 4 external calls (default, new, clone, clone).


##### `ApprovalOverlay::enqueue_request`  (lines 195–197)

```
fn enqueue_request(&mut self, req: ApprovalRequest)
```

**Purpose**: Adds another approval request to the overlay's pending queue.

**Data flow**: Takes an `ApprovalRequest` and pushes it onto `self.queue`.

**Call relations**: Used when a new approval arrives while another is already being shown; `try_consume_approval_request` delegates directly here.

*Call graph*: called by 1 (try_consume_approval_request).


##### `ApprovalOverlay::dismiss_resolved_request`  (lines 199–214)

```
fn dismiss_resolved_request(&mut self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Removes or completes requests that were resolved elsewhere, either from the queue or from the currently displayed request.

**Data flow**: Records the original queue length → retains only queued requests that do not match the resolved request → if the current request matches, marks `current_complete = true`, advances the queue, and returns true → otherwise returns whether the queue length changed.

**Call relations**: Called by the `BottomPaneView` dismissal hook. It relies on `ApprovalRequest::matches_resolved_request` and may delegate to `advance_queue` when the active request becomes stale.

*Call graph*: calls 1 internal fn (advance_queue); called by 1 (dismiss_app_server_request).


##### `ApprovalOverlay::set_current`  (lines 216–230)

```
fn set_current(&mut self, request: ApprovalRequest)
```

**Purpose**: Replaces the active request and rebuilds the header, options, and list-selection view for it.

**Data flow**: Takes an `ApprovalRequest` → resets `current_complete` → builds a header with `build_header` → calls `build_options` to derive `ApprovalOption`s and `SelectionViewParams` → stores the request and options → constructs a fresh `ListSelectionView` with the new params and cloned sender/keymap.

**Call relations**: Used during initial construction and queue advancement. It is the central reconfiguration step whenever the overlay switches to a different request.

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

**Purpose**: Converts an `ApprovalRequest` into a title, header, option list, and `SelectionViewParams` suitable for `ListSelectionView`.

**Data flow**: Takes a request, prebuilt header renderable, features, and keymaps → matches the request type to choose option builders (`exec_options`, `permissions_options`, `patch_options`, `elicitation_options`) and a title string → wraps the title and header into a `ColumnRenderable` → maps each `ApprovalOption` into a `SelectionItem` with label and first shortcut → builds `SelectionViewParams` with a footer hint from `approval_footer_hint` and returns both the raw options and params.

**Call relations**: Called only from `set_current`. It delegates request-specific option semantics to helper functions while standardizing how those options are presented in the generic list-selection UI.

*Call graph*: calls 6 internal fn (approval_footer_hint, elicitation_options, exec_options, patch_options, permissions_options, with); 4 external calls (new, default, from, format!).


##### `ApprovalOverlay::apply_selection`  (lines 302–347)

```
fn apply_selection(&mut self, actual_idx: usize)
```

**Purpose**: Applies the selected approval option to the current request, emits the corresponding decision, and advances or finishes the queue.

**Data flow**: Takes an option index → returns early if the current request is already complete or the index is out of range → reads the current request and selected `ApprovalOption` → matches request type against option decision type and dispatches to `handle_exec_decision`, `handle_permissions_decision`, `handle_patch_decision`, or `handle_elicitation_decision` → marks `current_complete = true` and calls `advance_queue`.

**Call relations**: Reached from keyboard shortcuts and from `ListSelectionView` selection results. It is the main bridge from UI choice to request-type-specific decision handling.

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

**Purpose**: Emits a command-execution approval decision and, for local-thread requests, records a human-readable history cell describing the user's choice.

**Data flow**: Takes the request id, command argv, and a `CommandExecutionApprovalDecision` → reads the current request to determine thread label and possible network context → if the request is not cross-thread, derives a `history_cell::ApprovalDecisionSubject` from either structured network context, a `network-access` command target, or the raw command, converts the decision to a `ReviewDecision`, builds a history cell, and sends `AppEvent::InsertHistoryCell` → finally sends the thread-scoped exec approval via `app_event_tx.exec_approval`.

**Call relations**: Called from `apply_selection` and `cancel_current_request` for exec requests. It delegates subject formatting to `network_approval_target`, `network_approval_command_target`, and `command_decision_to_review_decision`.

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

**Purpose**: Converts a permissions choice into a `RequestPermissionsResponse`, optionally records a local history message, and emits the response event.

**Data flow**: Takes the call id, requested `RequestPermissionProfile`, and a `PermissionsDecision` → derives granted permissions (`clone` for grant cases, default empty for deny), grant scope (`Turn` or `Session`), and `strict_auto_review` flag → if the request is not cross-thread, sends a plain history cell summarizing what was granted or denied → emits `request_permissions_response` with the constructed response.

**Call relations**: Called from `apply_selection` and `cancel_current_request` for permission requests. It encapsulates the mapping from UI choices to protocol-level permission responses.

*Call graph*: calls 3 internal fn (request_permissions_response, send, new); called by 2 (apply_selection, cancel_current_request); 6 external calls (new, default, clone, InsertHistoryCell, matches!, vec!).


##### `ApprovalOverlay::handle_patch_decision`  (lines 438–448)

```
fn handle_patch_decision(&self, id: &str, decision: FileChangeApprovalDecision)
```

**Purpose**: Emits a file-change approval decision for the current patch request.

**Data flow**: Takes the patch id and a `FileChangeApprovalDecision` → extracts the current request's `thread_id` if present → sends `patch_approval(thread_id, id.to_string(), decision)`.

**Call relations**: Used by `apply_selection` and `cancel_current_request` for apply-patch requests. It is intentionally minimal because patch approvals do not need local history-cell synthesis here.

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

**Purpose**: Emits an MCP elicitation resolution for the current request.

**Data flow**: Takes `server_name`, `request_id`, and a `McpServerElicitationAction` → extracts the current request's `thread_id` if present → calls `app_event_tx.resolve_elicitation` with cloned server/request identifiers and `None` content/meta.

**Call relations**: Called from `apply_selection` and `cancel_current_request` for MCP elicitation requests. It is the approval-overlay counterpart to app-link-view elicitation resolution.

*Call graph*: calls 1 internal fn (resolve_elicitation); called by 2 (apply_selection, cancel_current_request); 1 external calls (clone).


##### `ApprovalOverlay::advance_queue`  (lines 473–479)

```
fn advance_queue(&mut self)
```

**Purpose**: Moves the overlay to the next queued request or marks the overlay done if none remain.

**Data flow**: Pops one request from `self.queue` → if present, passes it to `set_current`; otherwise sets `done = true`.

**Call relations**: Called after a selection is applied and when the current request is dismissed as already resolved. It is the queue progression mechanism for the overlay.

*Call graph*: calls 1 internal fn (set_current); called by 2 (apply_selection, dismiss_resolved_request).


##### `ApprovalOverlay::cancel_current_request`  (lines 481–525)

```
fn cancel_current_request(&mut self)
```

**Purpose**: Cancels the active request using request-type-specific cancel semantics, clears the queue, and finishes the overlay.

**Data flow**: Returns immediately if `done` is already true → if the current request is not yet complete, matches its variant and dispatches a cancel-equivalent decision: exec `Cancel`, permissions `Deny`, patch `Cancel`, or elicitation `Cancel` → clears `queue` and sets `done = true`.

**Call relations**: Invoked by Ctrl-C and by the configured list-cancel shortcut. It reuses the same per-request decision handlers as normal selection paths so cancellation emits explicit protocol events.

*Call graph*: calls 4 internal fn (handle_elicitation_decision, handle_exec_decision, handle_patch_decision, handle_permissions_decision); called by 2 (on_ctrl_c, try_handle_shortcut).


##### `ApprovalOverlay::try_handle_shortcut`  (lines 531–566)

```
fn try_handle_shortcut(&mut self, key_event: &KeyEvent) -> bool
```

**Purpose**: Processes approval-specific shortcuts before generic list navigation, including fullscreen, open-thread, cancel, and direct decision shortcuts.

**Data flow**: Examines the incoming `KeyEvent` → on key press, if it matches `open_fullscreen`, sends `AppEvent::FullScreenApprovalRequest(current_request.clone())` → if it matches `open_thread` and the request has a thread label, sends `AppEvent::SelectAgentThread(thread_id)` → if it matches the list cancel binding, calls `cancel_current_request()` → otherwise searches `self.options` for a shortcut match and, if found, calls `apply_selection(idx)` → returns whether any shortcut was consumed.

**Call relations**: Called first from `handle_key_event`. It ensures approval semantics and global shortcuts take precedence over generic list movement.

*Call graph*: calls 3 internal fn (send, apply_selection, cancel_current_request); called by 1 (handle_key_event); 2 external calls (FullScreenApprovalRequest, SelectAgentThread).


##### `ApprovalOverlay::handle_key_event`  (lines 570–578)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Routes keyboard input through approval shortcuts first, then through the embedded list-selection view.

**Data flow**: Takes a `KeyEvent` → if `try_handle_shortcut` returns true, stops → otherwise forwards the event to `self.list.handle_key_event` → if the list reports a selected index via `take_last_selected_index`, calls `apply_selection(idx)`.

**Call relations**: This is the `BottomPaneView` input entrypoint. It composes approval-specific shortcut handling with the generic list-selection component.

*Call graph*: calls 4 internal fn (apply_selection, try_handle_shortcut, handle_key_event, take_last_selected_index).


##### `ApprovalOverlay::on_ctrl_c`  (lines 580–583)

```
fn on_ctrl_c(&mut self) -> CancellationEvent
```

**Purpose**: Cancels the current approval request and reports that Ctrl-C was handled.

**Data flow**: Calls `cancel_current_request()` and returns `CancellationEvent::Handled`.

**Call relations**: Used by the bottom-pane host for cancellation. It shares the same explicit-cancel semantics as the list cancel shortcut.

*Call graph*: calls 1 internal fn (cancel_current_request).


##### `ApprovalOverlay::is_complete`  (lines 585–587)

```
fn is_complete(&self) -> bool
```

**Purpose**: Reports whether the overlay has no more active or queued requests.

**Data flow**: Returns the `done` boolean.

**Call relations**: Queried by the bottom-pane host to know when to remove the overlay.


##### `ApprovalOverlay::try_consume_approval_request`  (lines 589–595)

```
fn try_consume_approval_request(
        &mut self,
        request: ApprovalRequest,
    ) -> Option<ApprovalRequest>
```

**Purpose**: Consumes additional approval requests by queueing them into the existing overlay.

**Data flow**: Takes an `ApprovalRequest`, enqueues it with `enqueue_request`, and returns `None` to indicate the request was consumed.

**Call relations**: Implements the `BottomPaneView` extension point that lets an existing approval overlay absorb later approval requests instead of spawning a second modal.

*Call graph*: calls 1 internal fn (enqueue_request).


##### `ApprovalOverlay::dismiss_app_server_request`  (lines 597–599)

```
fn dismiss_app_server_request(&mut self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Delegates external request dismissal to the overlay's resolved-request logic.

**Data flow**: Passes the `ResolvedAppServerRequest` reference to `dismiss_resolved_request` and returns its boolean result.

**Call relations**: This is the `BottomPaneView` hook used by the host when app-server requests are resolved elsewhere.

*Call graph*: calls 1 internal fn (dismiss_resolved_request).


##### `ApprovalOverlay::terminal_title_requires_action`  (lines 601–603)

```
fn terminal_title_requires_action(&self) -> bool
```

**Purpose**: Always marks the approval overlay as requiring user action for terminal-title purposes.

**Data flow**: Returns `true` unconditionally.

**Call relations**: Used by the surrounding UI to surface an 'Action Required' title whenever this overlay is active.


##### `ApprovalOverlay::desired_height`  (lines 607–609)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Delegates height calculation to the embedded `ListSelectionView`.

**Data flow**: Passes the width through to `self.list.desired_height(width)` and returns the result.

**Call relations**: Implements the `Renderable` sizing hook by reusing the generic list view's layout logic.

*Call graph*: calls 1 internal fn (desired_height); called by 1 (render_overlay_lines).


##### `ApprovalOverlay::render`  (lines 611–613)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Delegates rendering to the embedded `ListSelectionView`.

**Data flow**: Calls `self.list.render(area, buf)` with the provided area and buffer.

**Call relations**: The overlay's visual structure is entirely produced by the list-selection component configured in `set_current`.

*Call graph*: calls 1 internal fn (render); called by 1 (render_overlay_lines).


##### `ApprovalOverlay::cursor_pos`  (lines 615–617)

```
fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)>
```

**Purpose**: Delegates cursor-position reporting to the embedded `ListSelectionView`.

**Data flow**: Calls `self.list.cursor_pos(area)` and returns the result.

**Call relations**: Part of the `Renderable` implementation; it keeps cursor behavior consistent with the underlying list widget.

*Call graph*: 1 external calls (cursor_pos).


##### `approval_footer_hint`  (lines 620–643)

```
fn approval_footer_hint(
    request: &ApprovalRequest,
    approval_keymap: &ApprovalKeymap,
    list_keymap: &ListKeymap,
) -> Line<'static>
```

**Purpose**: Builds the footer hint line for approval prompts, including confirm/cancel bindings and an optional open-thread shortcut.

**Data flow**: Starts from `accept_cancel_hint_line` using the primary accept/cancel bindings from the list keymap → if the request has a thread label and the approval keymap has an open-thread binding, appends `or <binding> to open thread` spans → returns the assembled `Line<'static>`.

**Call relations**: Called from `ApprovalOverlay::build_options` so every request type gets a consistent footer hint, with cross-thread prompts advertising the extra navigation shortcut.

*Call graph*: calls 3 internal fn (thread_label, accept_cancel_hint_line, primary_binding); called by 1 (build_options); 1 external calls (from).


##### `network_approval_target`  (lines 645–660)

```
fn network_approval_target(
    network_approval_context: &NetworkApprovalContext,
    command: &[String],
) -> String
```

**Purpose**: Formats the human-readable network target for history cells and approval summaries.

**Data flow**: Takes a structured `NetworkApprovalContext` and the original command argv → first tries `network_approval_command_target(command)` and returns that if present → otherwise maps the protocol enum to a scheme string and formats `scheme://host`.

**Call relations**: Used by `handle_exec_decision` when building history-cell subjects for network approvals.

*Call graph*: calls 1 internal fn (network_approval_command_target); called by 1 (handle_exec_decision); 1 external calls (format!).


##### `network_approval_command_target`  (lines 662–672)

```
fn network_approval_command_target(command: &[String]) -> Option<&str>
```

**Purpose**: Extracts a target string from synthetic `network-access` commands when present.

**Data flow**: Matches the command argv either as `["network-access", target]` or as a single string starting with `"network-access "` → returns `Some(&str)` for a non-empty target, otherwise `None`.

**Call relations**: Used both directly by `handle_exec_decision` and indirectly by `network_approval_target` to prefer command-encoded targets over reconstructed protocol/host strings.

*Call graph*: called by 2 (handle_exec_decision, network_approval_target).


##### `build_header`  (lines 674–800)

```
fn build_header(request: &ApprovalRequest) -> Box<dyn Renderable>
```

**Purpose**: Builds the request-specific descriptive header shown above the approval options.

**Data flow**: Matches the `ApprovalRequest` variant → for exec, assembles optional thread label, reason, additional-permission rule, and highlighted shell command unless it is a network approval; for permissions, assembles thread/environment/reason plus requested-permission rule; for apply-patch, assembles thread label and wrapped reason; for MCP elicitation, assembles thread label, server name, and message → returns a boxed `Renderable`.

**Call relations**: Called from `set_current` before `build_options`. It delegates permission-rule formatting and command highlighting to helper functions so the overlay can present rich context without embedding that logic inline.

*Call graph*: calls 5 internal fn (format_additional_permissions_rule, format_requested_permissions_rule, strip_bash_lc_and_escape, highlight_bash_to_lines, with); called by 1 (set_current); 7 external calls (new, from, from_iter, new, from, new, vec!).


##### `command_decision_to_review_decision`  (lines 825–844)

```
fn command_decision_to_review_decision(
    decision: &CommandExecutionApprovalDecision,
) -> ReviewDecision
```

**Purpose**: Maps protocol-level command approval decisions into the `ReviewDecision` enum used by history cells.

**Data flow**: Matches a `CommandExecutionApprovalDecision` and converts each variant to the corresponding `ReviewDecision`, cloning embedded amendment payloads into core forms where needed.

**Call relations**: Used only by `handle_exec_decision` when synthesizing a local history cell for the user's choice.

*Call graph*: called by 1 (handle_exec_decision).


##### `exec_options`  (lines 846–932)

```
fn exec_options(
    available_decisions: &[CommandExecutionApprovalDecision],
    network_approval_context: Option<&NetworkApprovalContext>,
    additional_permissions: Option<&AdditionalPermissionPr
```

**Purpose**: Builds the selectable options for command-execution approvals, adapting labels and shortcut bindings to the available decisions and context.

**Data flow**: Iterates the provided `available_decisions` → for each supported decision variant, constructs an `ApprovalOption` with a context-sensitive label, the corresponding `ApprovalDecision::Command`, and the appropriate shortcut list from the approval keymap → filters out exec-policy amendment options whose rendered prefix contains newlines → returns the collected options.

**Call relations**: Called from `ApprovalOverlay::build_options` for exec requests. It encodes most of the nuanced wording differences for generic exec, network approvals, and additional-permission prompts.

*Call graph*: called by 4 (build_options, additional_permissions_exec_options_hide_execpolicy_amendment, generic_exec_options_can_offer_allow_for_session, network_exec_options_use_expected_labels_and_hide_execpolicy_amendment); 1 external calls (iter).


##### `format_additional_permissions_rule`  (lines 934–983)

```
fn format_additional_permissions_rule(
    additional_permissions: &AdditionalPermissionProfile,
) -> Option<String>
```

**Purpose**: Formats an `AdditionalPermissionProfile` into a compact semicolon-separated rule summary for display.

**Data flow**: Inspects network enablement and file-system entries → accumulates textual parts like `network`, `read ...`, `write ...`, and `deny read ...` using `format_file_system_entry_paths` for each access class → returns `None` if no parts were produced, otherwise `Some(parts.join("; "))`.

**Call relations**: Used by `build_header` for exec requests and by `format_requested_permissions_rule` after converting requested permissions into the same profile shape.

*Call graph*: calls 1 internal fn (format_file_system_entry_paths); called by 2 (build_header, format_requested_permissions_rule); 2 external calls (new, format!).


##### `format_requested_permissions_rule`  (lines 985–996)

```
fn format_requested_permissions_rule(
    permissions: &RequestPermissionProfile,
) -> Option<String>
```

**Purpose**: Formats a requested permission profile using the same display rules as additional permissions.

**Data flow**: Clones the `RequestPermissionProfile`, converts it through `granted_permission_profile_from_request`, wraps the result into an `AdditionalPermissionProfile`, and delegates to `format_additional_permissions_rule`.

**Call relations**: Called from `build_header` for permission requests so both request types share one formatting policy.

*Call graph*: calls 2 internal fn (granted_permission_profile_from_request, format_additional_permissions_rule); called by 1 (build_header); 1 external calls (clone).


##### `format_file_system_entry_paths`  (lines 998–1009)

```
fn format_file_system_entry_paths(
    entries: impl Iterator<Item = &'a FileSystemSandboxEntry>,
) -> String
```

**Purpose**: Formats file-system sandbox entries into a comma-separated list of path labels.

**Data flow**: Maps each `FileSystemSandboxEntry` to a string based on its `FileSystemPath` variant: backticked literal path, `glob` pattern, or special-path label from `special_path_label` → joins the strings with `, ` and returns the result.

**Call relations**: Used by `format_additional_permissions_rule` to render read/write/deny path lists.

*Call graph*: called by 1 (format_additional_permissions_rule); 1 external calls (map).


##### `special_path_label`  (lines 1011–1020)

```
fn special_path_label(value: &FileSystemSpecialPath) -> String
```

**Purpose**: Converts `FileSystemSpecialPath` values into user-facing labels.

**Data flow**: Matches the special-path enum and returns labels like `:root`, `:minimal`, `/tmp`, or a base-plus-subpath string via `path_label`.

**Call relations**: Used by `format_file_system_entry_paths` when sandbox entries refer to special path categories instead of literal paths.

*Call graph*: calls 1 internal fn (path_label).


##### `path_label`  (lines 1022–1027)

```
fn path_label(base: &str, subpath: &Option<PathBuf>) -> String
```

**Purpose**: Formats a base special-path label with an optional subpath suffix.

**Data flow**: Takes a base string and `Option<PathBuf>` → if a subpath exists, formats `base/subpath.display()`, otherwise returns the base unchanged.

**Call relations**: Used by `special_path_label` for project-root and unknown special-path variants.

*Call graph*: called by 1 (special_path_label); 1 external calls (format!).


##### `patch_options`  (lines 1029–1047)

```
fn patch_options(keymap: &ApprovalKeymap) -> Vec<ApprovalOption>
```

**Purpose**: Builds the fixed option set for apply-patch approvals.

**Data flow**: Returns a three-element `Vec<ApprovalOption>` for accept, accept-for-session, and cancel, each with the corresponding `FileChangeApprovalDecision` and approval-keymap shortcut list.

**Call relations**: Called from `ApprovalOverlay::build_options` for patch requests.

*Call graph*: called by 1 (build_options); 1 external calls (vec!).


##### `permissions_options`  (lines 1049–1081)

```
fn permissions_options(keymap: &ApprovalKeymap) -> Vec<ApprovalOption>
```

**Purpose**: Builds the fixed option set for permission requests, including a strict-auto-review grant path.

**Data flow**: Derives deny shortcuts from the approval keymap while filtering out plain Esc → returns options for grant-for-turn, grant-for-turn-with-strict-auto-review, grant-for-session, and deny, each with the corresponding `PermissionsDecision` and shortcut list.

**Call relations**: Called from `ApprovalOverlay::build_options` for permission requests. The Esc filtering preserves cancellation semantics distinct from deny.

*Call graph*: called by 2 (build_options, permissions_options_use_expected_labels); 1 external calls (vec!).


##### `elicitation_options`  (lines 1090–1122)

```
fn elicitation_options(keymap: &ApprovalKeymap) -> Vec<ApprovalOption>
```

**Purpose**: Builds MCP elicitation options while enforcing the invariant that Esc always means cancel.

**Data flow**: Starts `cancel_shortcuts` with plain Esc, then appends any configured cancel bindings not already present → derives `decline_shortcuts` by removing any overlap with cancel shortcuts from the configured decline bindings → returns options for accept, decline, and cancel with the resulting shortcut sets.

**Call relations**: Called from `ApprovalOverlay::build_options` for MCP elicitation requests. This helper is where the module's documented Esc-cancel contract is enforced.

*Call graph*: called by 1 (build_options); 1 external calls (vec!).


##### `tests::absolute_path`  (lines 1141–1143)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Creates an `AbsolutePathBuf` from a string literal for tests.

**Data flow**: Calls `AbsolutePathBuf::from_absolute_path(path)` and unwraps the result with `expect`.

**Call relations**: Used by tests that need stable absolute paths in permission and patch fixtures.

*Call graph*: calls 1 internal fn (from_absolute_path).


##### `tests::render_overlay_lines`  (lines 1145–1159)

```
fn render_overlay_lines(view: &ApprovalOverlay, width: u16) -> String
```

**Purpose**: Renders an `ApprovalOverlay` into a newline-joined plain-text string for snapshot assertions.

**Data flow**: Computes the overlay height, renders into an empty `Buffer`, converts each row's symbols into a trimmed string, and joins rows with newlines.

**Call relations**: Shared by multiple snapshot tests to compare rendered approval prompts.

*Call graph*: calls 2 internal fn (desired_height, render); 2 external calls (empty, new).


##### `tests::render_history_cell_lines`  (lines 1161–1174)

```
fn render_history_cell_lines(
        cell: &dyn crate::history_cell::HistoryCell,
        width: u16,
    ) -> Vec<String>
```

**Purpose**: Converts a history cell into plain strings for assertion-friendly comparison.

**Data flow**: Calls `display_lines(width)` on the history cell, then concatenates each line's span contents into a `Vec<String>`.

**Call relations**: Used by tests that verify the exact wording of approval-decision history cells.

*Call graph*: 1 external calls (display_lines).


##### `tests::normalize_snapshot_paths`  (lines 1176–1185)

```
fn normalize_snapshot_paths(rendered: String) -> String
```

**Purpose**: Replaces machine-specific absolute paths in rendered snapshots with stable normalized strings.

**Data flow**: Builds a small list of `(absolute_path, normalized)` replacements and folds over the rendered string, replacing each absolute path display string with its normalized form.

**Call relations**: Used by snapshot tests so path rendering remains stable across environments.

*Call graph*: 1 external calls (absolute_path).


##### `tests::make_overlay`  (lines 1187–1200)

```
fn make_overlay(
        request: ApprovalRequest,
        app_event_tx: AppEventSender,
        features: Features,
    ) -> ApprovalOverlay
```

**Purpose**: Constructs an `ApprovalOverlay` with default runtime keymaps for tests.

**Data flow**: Fetches `RuntimeKeymap::defaults()` and delegates to `make_overlay_with_keymap` with its approval and list keymaps.

**Call relations**: Convenience helper used by most tests that do not need custom key bindings.

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

**Purpose**: Constructs an `ApprovalOverlay` with explicit keymaps for tests.

**Data flow**: Passes the request, sender, features, approval keymap, and list keymap directly to `ApprovalOverlay::new` and returns the result.

**Call relations**: Used by tests that need to verify remapped shortcut behavior.

*Call graph*: calls 1 internal fn (new).


##### `tests::make_exec_request`  (lines 1218–1232)

```
fn make_exec_request() -> ApprovalRequest
```

**Purpose**: Builds a representative exec approval request fixture.

**Data flow**: Creates an `ApprovalRequest::Exec` with a fresh thread id, fixed id, `echo hi` command, a reason, and accept/cancel decisions.

**Call relations**: Shared by many tests covering generic exec approval behavior.

*Call graph*: calls 1 internal fn (new); 1 external calls (vec!).


##### `tests::make_permissions_request`  (lines 1234–1251)

```
fn make_permissions_request() -> ApprovalRequest
```

**Purpose**: Builds a representative permissions approval request fixture with network and file-system access.

**Data flow**: Creates an `ApprovalRequest::Permissions` with a fresh thread id, fixed call id, reason text, and a `RequestPermissionProfile` granting network plus read/write roots.

**Call relations**: Shared by tests covering permission prompt rendering and decision routing.

*Call graph*: calls 2 internal fn (from_read_write_roots, new); 1 external calls (vec!).


##### `tests::make_elicitation_request`  (lines 1253–1261)

```
fn make_elicitation_request() -> ApprovalRequest
```

**Purpose**: Builds a representative MCP elicitation approval request fixture.

**Data flow**: Creates an `ApprovalRequest::McpElicitation` with a fresh thread id, fixed server name, request id, and message.

**Call relations**: Shared by tests covering elicitation-specific cancel/decline semantics.

*Call graph*: calls 1 internal fn (new); 1 external calls (String).


##### `tests::ctrl_c_aborts_and_clears_queue`  (lines 1264–1272)

```
fn ctrl_c_aborts_and_clears_queue()
```

**Purpose**: Verifies that Ctrl-C cancels the current request, clears queued requests, and completes the overlay.

**Data flow**: Creates an overlay, enqueues a second request, calls `on_ctrl_c`, and asserts the cancellation event is handled, the queue is empty, and the overlay is complete.

**Call relations**: Covers the overlay-wide cancellation path through `cancel_current_request`.

*Call graph*: calls 2 internal fn (with_defaults, new); 4 external calls (assert!, assert_eq!, make_exec_request, make_overlay).


##### `tests::configured_list_cancel_aborts_exec_approval`  (lines 1275–1303)

```
fn configured_list_cancel_aborts_exec_approval()
```

**Purpose**: Checks that a remapped list-cancel key triggers exec cancellation.

**Data flow**: Builds a custom keymap with `q` as list cancel, sends that key to the overlay, then scans emitted events for an exec approval op with decision `Cancel`.

**Call relations**: Exercises `try_handle_shortcut`'s list-cancel branch for exec requests.

*Call graph*: calls 3 internal fn (with_defaults, new, defaults); 7 external calls (Char, new, assert!, assert_eq!, make_exec_request, make_overlay_with_keymap, vec!).


##### `tests::configured_list_cancel_cancels_mcp_elicitation`  (lines 1306–1334)

```
fn configured_list_cancel_cancels_mcp_elicitation()
```

**Purpose**: Checks that a remapped list-cancel key triggers MCP elicitation cancellation.

**Data flow**: Builds a custom keymap with `q` as list cancel, sends it to an elicitation overlay, and scans emitted events for a resolve-elicitation op with decision `Cancel`.

**Call relations**: Confirms cancellation semantics are request-type-specific even when triggered through the generic list cancel binding.

*Call graph*: calls 3 internal fn (with_defaults, new, defaults); 7 external calls (Char, new, assert!, assert_eq!, make_elicitation_request, make_overlay_with_keymap, vec!).


##### `tests::shortcut_triggers_selection`  (lines 1337–1352)

```
fn shortcut_triggers_selection()
```

**Purpose**: Verifies that an approval shortcut key directly applies a selection and emits an approval op.

**Data flow**: Creates an exec overlay, sends the default approve shortcut, and scans the event queue for any `SubmitThreadOp`.

**Call relations**: Covers the direct option-shortcut path in `try_handle_shortcut`.

*Call graph*: calls 2 internal fn (with_defaults, new); 6 external calls (Char, new, assert!, matches!, make_exec_request, make_overlay).


##### `tests::deny_shortcut_submits_denied_exec_decision`  (lines 1355–1391)

```
fn deny_shortcut_submits_denied_exec_decision()
```

**Purpose**: Ensures the deny shortcut maps to `Decline` for exec approvals when that decision is available.

**Data flow**: Creates an exec request with accept and decline options, sends the deny shortcut, and asserts the emitted exec approval decision is `Decline`.

**Call relations**: Exercises `exec_options` label/shortcut generation and `apply_selection` routing for decline.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 6 external calls (Char, new, assert!, assert_eq!, make_overlay, vec!).


##### `tests::network_deny_shortcut_submits_policy_deny_decision`  (lines 1394–1447)

```
fn network_deny_shortcut_submits_policy_deny_decision()
```

**Purpose**: Ensures the deny shortcut maps to a network-policy deny amendment when that is the available deny-like option.

**Data flow**: Creates a network approval request whose available decisions include `ApplyNetworkPolicyAmendment { action: Deny }`, sends the deny shortcut, and asserts the emitted exec approval decision is that amendment.

**Call relations**: Covers the network-specific branch of `exec_options`.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 6 external calls (Char, new, assert!, assert_eq!, make_overlay, vec!).


##### `tests::resolved_request_dismisses_overlay_without_emitting_abort`  (lines 1450–1468)

```
fn resolved_request_dismisses_overlay_without_emitting_abort()
```

**Purpose**: Verifies that externally dismissing a matching request closes the overlay without sending a cancel decision.

**Data flow**: Creates an exec overlay, calls `dismiss_app_server_request` with a matching resolved request, asserts the overlay completes, and checks that no event was emitted.

**Call relations**: Covers the stale-request dismissal path distinct from user cancellation.

*Call graph*: calls 2 internal fn (with_defaults, new); 3 external calls (assert!, make_exec_request, make_overlay).


##### `tests::o_opens_source_thread_for_cross_thread_approval`  (lines 1471–1500)

```
fn o_opens_source_thread_for_cross_thread_approval()
```

**Purpose**: Checks that the default open-thread shortcut selects the source thread for cross-thread approvals.

**Data flow**: Creates a cross-thread exec request with a thread label, sends `o`, and asserts the emitted event is `SelectAgentThread(thread_id)`.

**Call relations**: Exercises the open-thread branch of `try_handle_shortcut`.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 5 external calls (Char, new, assert_eq!, make_overlay, vec!).


##### `tests::configured_open_thread_shortcut_opens_source_thread`  (lines 1503–1541)

```
fn configured_open_thread_shortcut_opens_source_thread()
```

**Purpose**: Verifies that the open-thread shortcut is fully remappable.

**Data flow**: Builds a custom approval keymap with `x` as open-thread, confirms `o` no longer works, then sends `x` and asserts a `SelectAgentThread` event is emitted.

**Call relations**: Covers runtime keymap override behavior for cross-thread navigation.

*Call graph*: calls 4 internal fn (with_defaults, new, new, defaults); 5 external calls (Char, new, assert!, make_overlay_with_keymap, vec!).


##### `tests::cross_thread_footer_hint_mentions_o_shortcut`  (lines 1544–1569)

```
fn cross_thread_footer_hint_mentions_o_shortcut()
```

**Purpose**: Captures the rendered footer hint for a cross-thread approval prompt, including the open-thread shortcut text.

**Data flow**: Creates a cross-thread exec overlay, renders it to text with `render_overlay_lines`, and snapshot-compares the result.

**Call relations**: Documents the footer-hint augmentation performed by `approval_footer_hint`.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 3 external calls (assert_snapshot!, make_overlay, vec!).


##### `tests::exec_prefix_option_emits_execpolicy_amendment`  (lines 1572–1621)

```
fn exec_prefix_option_emits_execpolicy_amendment()
```

**Purpose**: Ensures the prefix-approval shortcut emits an exec-policy amendment decision.

**Data flow**: Creates an exec request whose available decisions include `AcceptWithExecpolicyAmendment`, sends the prefix shortcut, and asserts the emitted exec approval decision matches the amendment.

**Call relations**: Covers the exec-policy amendment branch of `exec_options` and selection routing.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 6 external calls (Char, new, assert!, assert_eq!, make_overlay, vec!).


##### `tests::network_deny_forever_shortcut_is_not_bound`  (lines 1624–1660)

```
fn network_deny_forever_shortcut_is_not_bound()
```

**Purpose**: Verifies that hidden network-policy allow options do not accidentally bind the deny shortcut when no deny decision exists.

**Data flow**: Creates a network approval request with accept, accept-for-session, allow-forever, and cancel options, sends the deny shortcut, and asserts no event is emitted.

**Call relations**: Protects against misleading shortcut exposure in `exec_options`.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 5 external calls (Char, new, assert!, make_overlay, vec!).


##### `tests::header_includes_command_snippet`  (lines 1663–1701)

```
fn header_includes_command_snippet()
```

**Purpose**: Checks that non-network exec approval headers include the command text.

**Data flow**: Creates an exec overlay, renders it into a buffer, converts rows to strings, and asserts one line contains `echo hello world`.

**Call relations**: Covers the command-rendering branch of `build_header`.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 5 external calls (empty, new, assert!, make_overlay, vec!).


##### `tests::network_exec_options_use_expected_labels_and_hide_execpolicy_amendment`  (lines 1704–1737)

```
fn network_exec_options_use_expected_labels_and_hide_execpolicy_amendment()
```

**Purpose**: Verifies the exact labels produced for network approval options and confirms exec-policy wording is not used there.

**Data flow**: Calls `exec_options` with a network context and several decisions, collects labels, and compares them to the expected list.

**Call relations**: Directly tests the network-specific label logic in `exec_options`.

*Call graph*: calls 2 internal fn (exec_options, defaults); 1 external calls (assert_eq!).


##### `tests::generic_exec_options_can_offer_allow_for_session`  (lines 1740–1762)

```
fn generic_exec_options_can_offer_allow_for_session()
```

**Purpose**: Verifies the generic exec option labels when session approval is available.

**Data flow**: Calls `exec_options` without network or additional-permission context, collects labels, and compares them to the expected generic wording.

**Call relations**: Covers the non-network, non-permission branch of `exec_options`.

*Call graph*: calls 2 internal fn (exec_options, defaults); 1 external calls (assert_eq!).


##### `tests::additional_permissions_exec_options_hide_execpolicy_amendment`  (lines 1765–1795)

```
fn additional_permissions_exec_options_hide_execpolicy_amendment()
```

**Purpose**: Checks that additional-permission exec prompts use simple proceed/cancel wording and do not expose exec-policy amendment options.

**Data flow**: Calls `exec_options` with additional permissions and basic decisions, collects labels, and compares them to the expected two-option list.

**Call relations**: Covers the additional-permissions wording branch in `exec_options`.

*Call graph*: calls 3 internal fn (from_read_write_roots, exec_options, defaults); 2 external calls (assert_eq!, vec!).


##### `tests::permissions_options_use_expected_labels`  (lines 1798–1813)

```
fn permissions_options_use_expected_labels()
```

**Purpose**: Verifies the exact labels for permission-request options.

**Data flow**: Calls `permissions_options`, collects labels, and compares them to the expected four strings.

**Call relations**: Directly tests the fixed option set for permission approvals.

*Call graph*: calls 2 internal fn (permissions_options, defaults); 1 external calls (assert_eq!).


##### `tests::additional_permissions_rule_shows_non_path_file_system_entries`  (lines 1816–1844)

```
fn additional_permissions_rule_shows_non_path_file_system_entries()
```

**Purpose**: Ensures permission-rule formatting handles special paths and glob patterns.

**Data flow**: Builds an `AdditionalPermissionProfile` with a special root write and glob deny entry, calls `format_additional_permissions_rule`, and asserts the formatted string matches expectations.

**Call relations**: Covers `format_file_system_entry_paths` and `special_path_label` behavior.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::additional_permissions_rule_uses_workspace_roots_label`  (lines 1847–1869)

```
fn additional_permissions_rule_uses_workspace_roots_label()
```

**Purpose**: Ensures project-root special paths render with the `:workspace_roots` label and subpath suffix.

**Data flow**: Builds an additional-permissions profile with a `ProjectRoots { subpath: .git }` read entry, formats it, and compares the result.

**Call relations**: Tests the `ProjectRoots` branch of `special_path_label` and `path_label`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::permissions_session_shortcut_submits_session_scope`  (lines 1872–1895)

```
fn permissions_session_shortcut_submits_session_scope()
```

**Purpose**: Checks that the session-grant shortcut emits a session-scoped permission response.

**Data flow**: Creates a permissions overlay, sends the session shortcut, scans emitted events for a permission response op, and asserts `scope == Session`.

**Call relations**: Exercises `handle_permissions_decision` for the session-grant path.

*Call graph*: calls 2 internal fn (with_defaults, new); 6 external calls (Char, new, assert!, assert_eq!, make_overlay, make_permissions_request).


##### `tests::permissions_deny_shortcut_uses_deny_keymap`  (lines 1898–1932)

```
fn permissions_deny_shortcut_uses_deny_keymap()
```

**Purpose**: Verifies that permission denial uses the configured deny keymap and emits an empty permission response.

**Data flow**: Builds a custom keymap with `x` as deny, sends it to a permissions overlay, and asserts the emitted response has empty permissions, turn scope, and no strict auto review.

**Call relations**: Covers the deny-shortcut filtering and routing in `permissions_options` and `handle_permissions_decision`.

*Call graph*: calls 3 internal fn (with_defaults, new, defaults); 8 external calls (Char, new, new, assert!, assert_eq!, make_overlay_with_keymap, make_permissions_request, vec!).


##### `tests::permissions_strict_auto_review_shortcut_submits_turn_scope_with_strict_review`  (lines 1935–1959)

```
fn permissions_strict_auto_review_shortcut_submits_turn_scope_with_strict_review()
```

**Purpose**: Checks that the strict-auto-review shortcut emits a turn-scoped response with the strict flag set.

**Data flow**: Creates a permissions overlay, sends `r`, scans emitted events for a permission response op, and asserts turn scope plus `strict_auto_review == true`.

**Call relations**: Exercises the special strict-review option in `permissions_options`.

*Call graph*: calls 2 internal fn (with_defaults, new); 6 external calls (Char, new, assert!, assert_eq!, make_overlay, make_permissions_request).


##### `tests::additional_permissions_prompt_shows_permission_rule_line`  (lines 1962–2015)

```
fn additional_permissions_prompt_shows_permission_rule_line()
```

**Purpose**: Verifies that exec prompts with additional permissions render a permission-rule line in the header.

**Data flow**: Creates an exec overlay with network and file-system additional permissions, renders it, and asserts the output contains `Permission rule:` and `network;` text.

**Call relations**: Covers the additional-permission header branch in `build_header`.

*Call graph*: calls 4 internal fn (with_defaults, from_read_write_roots, new, new); 5 external calls (empty, new, assert!, make_overlay, vec!).


##### `tests::additional_permissions_prompt_snapshot`  (lines 2018–2051)

```
fn additional_permissions_prompt_snapshot()
```

**Purpose**: Captures a snapshot of an exec approval prompt that includes additional permissions.

**Data flow**: Builds the overlay, renders it to normalized text, and snapshot-compares the result.

**Call relations**: Documents the combined reason/permission-rule/command presentation.

*Call graph*: calls 4 internal fn (with_defaults, from_read_write_roots, new, new); 3 external calls (assert_snapshot!, make_overlay, vec!).


##### `tests::permissions_prompt_snapshot`  (lines 2054–2062)

```
fn permissions_prompt_snapshot()
```

**Purpose**: Captures a snapshot of a permissions approval prompt.

**Data flow**: Builds a permissions overlay, renders it to normalized text, and snapshot-compares the result.

**Call relations**: Documents the permissions-specific header and option layout.

*Call graph*: calls 2 internal fn (with_defaults, new); 3 external calls (assert_snapshot!, make_overlay, make_permissions_request).


##### `tests::apply_patch_prompt_with_thread_label_omits_command_line`  (lines 2065–2095)

```
fn apply_patch_prompt_with_thread_label_omits_command_line()
```

**Purpose**: Verifies that apply-patch prompts with a thread label show thread context and open-thread hint but not a shell command line.

**Data flow**: Builds an apply-patch overlay with a thread label, renders it to text, and asserts the output contains the thread label and open-thread hint but not `$ apply_patch`.

**Call relations**: Covers the apply-patch branch of `build_header` and `approval_footer_hint`.

*Call graph*: calls 5 internal fn (with_defaults, new, new, new, defaults); 5 external calls (new, from, assert!, absolute_path, render_overlay_lines).


##### `tests::network_exec_prompt_title_includes_host`  (lines 2098–2155)

```
fn network_exec_prompt_title_includes_host()
```

**Purpose**: Checks that network approval prompts title the host explicitly and omit command-line and execpolicy wording.

**Data flow**: Builds a network exec overlay, renders it, snapshot-compares the raw buffer, and asserts the rendered text includes the host-specific title while excluding `$ curl` and `don't ask again` wording.

**Call relations**: Covers the network-specific title and header behavior in `build_options` and `build_header`.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 6 external calls (empty, new, assert!, assert_snapshot!, make_overlay, vec!).


##### `tests::ctrl_shift_a_opens_fullscreen`  (lines 2158–2176)

```
fn ctrl_shift_a_opens_fullscreen()
```

**Purpose**: Verifies that the fullscreen shortcut emits a `FullScreenApprovalRequest` event.

**Data flow**: Creates an overlay, sends Ctrl-Shift-A, and scans emitted events for `AppEvent::FullScreenApprovalRequest`.

**Call relations**: Exercises the fullscreen branch of `try_handle_shortcut`.

*Call graph*: calls 2 internal fn (with_defaults, new); 6 external calls (Char, new, assert!, matches!, make_exec_request, make_overlay).


##### `tests::exec_history_cell_wraps_with_two_space_indent`  (lines 2179–2207)

```
fn exec_history_cell_wraps_with_two_space_indent()
```

**Purpose**: Checks the wrapped formatting of command-approval history cells.

**Data flow**: Builds a history cell for an approved long command, renders it at narrow width, converts lines to strings, and compares them to the expected wrapped output.

**Call relations**: Indirectly validates the history-cell subject and review-decision mapping used by `handle_exec_decision`.

*Call graph*: 4 external calls (assert_eq!, new_approval_decision_cell, Command, vec!).


##### `tests::exec_history_cell_does_not_render_blank_action_for_empty_command`  (lines 2210–2230)

```
fn exec_history_cell_does_not_render_blank_action_for_empty_command()
```

**Purpose**: Ensures history cells for empty command subjects still render sensible approval text.

**Data flow**: Builds approval history cells for empty command vectors with two review decisions and compares their rendered lines to expected strings.

**Call relations**: Protects the history-cell rendering assumptions used when command subjects are absent.

*Call graph*: 4 external calls (new, assert_eq!, new_approval_decision_cell, Command).


##### `tests::network_access_command_history_uses_target_without_structured_context`  (lines 2233–2274)

```
fn network_access_command_history_uses_target_without_structured_context()
```

**Purpose**: Verifies that `network-access` commands produce network-target history text even without structured network context.

**Data flow**: Creates an exec overlay for a `network-access` command, approves it, extracts the inserted history cell, renders it, and compares the line to the expected network-access wording.

**Call relations**: Covers the fallback `network_approval_command_target` path in `handle_exec_decision`.

*Call graph*: calls 3 internal fn (with_defaults, new, new); 5 external calls (Char, new, assert_eq!, make_overlay, vec!).


##### `tests::esc_cancels_mcp_elicitation`  (lines 2277–2296)

```
fn esc_cancels_mcp_elicitation()
```

**Purpose**: Ensures plain Esc cancels MCP elicitation requests.

**Data flow**: Creates an elicitation overlay, sends Esc, scans emitted events for a resolve-elicitation op, and asserts the decision is `Cancel`.

**Call relations**: Directly tests the Esc-cancel contract for elicitation prompts.

*Call graph*: calls 2 internal fn (with_defaults, new); 4 external calls (new, assert_eq!, make_elicitation_request, make_overlay).


##### `tests::esc_still_cancels_elicitation_with_custom_overlap`  (lines 2299–2360)

```
fn esc_still_cancels_elicitation_with_custom_overlap()
```

**Purpose**: Verifies that Esc remains cancel even when custom decline and cancel bindings overlap, while non-Esc decline bindings still decline.

**Data flow**: Builds a custom keymap where decline includes Esc and `n`, cancel includes `x`, sends Esc in one overlay and `n` in another, and asserts the first emits `Cancel` while the second emits `Decline`.

**Call relations**: Covers the overlap-removal logic in `elicitation_options`.

*Call graph*: calls 3 internal fn (with_defaults, new, defaults); 6 external calls (Char, new, assert_eq!, make_elicitation_request, make_overlay_with_keymap, vec!).


##### `tests::enter_sets_last_selected_index_without_dismissing`  (lines 2363–2386)

```
fn enter_sets_last_selected_index_without_dismissing()
```

**Purpose**: Checks that pressing Enter on the list applies the selected option and completes the overlay without relying on list auto-dismissal.

**Data flow**: Creates an exec overlay, sends Enter, asserts the overlay completes, and scans emitted events for an exec approval decision of `Accept`.

**Call relations**: Exercises the path where `ListSelectionView` reports a selected index and `ApprovalOverlay::apply_selection` performs the actual completion.

*Call graph*: calls 2 internal fn (with_defaults, new); 5 external calls (new, assert!, assert_eq!, make_exec_request, make_overlay).


### `tui/src/bottom_pane/request_user_input/mod.rs`

`domain_logic` · `request handling`

This is the core implementation of the request-user-input overlay shown when a tool asks the user one or more questions. The main state lives in `RequestUserInputOverlay`: the active `ToolRequestUserInputParams`, a FIFO queue of later requests, a reused `ChatComposer` for notes/freeform answers, per-question `AnswerState` entries, current question index and focus (`Options` or `Notes`), unanswered-confirmation popup state, and auto-resolution timing fields. `ComposerDraft` snapshots composer text, text elements, local image paths, and pending paste placeholders so drafts survive question switches and submission/back-navigation. `FooterTip` models footer hint fragments with optional highlighting.

Construction happens in `new_with_keymap`, which creates a plain-text composer, applies runtime key bindings, suppresses the composer's own footer, initializes overlay state, then calls `reset_for_request`, `ensure_focus_available`, and `restore_current_draft`. The overlay distinguishes option questions from freeform-only questions, supports an extra synthetic `None of the above` option when `is_other` is enabled, and treats notes as an optional appended `user_note: ...` answer. Drafts are saved whenever the current question changes or submission is attempted; committed answers are invalidated if the draft later changes.

`handle_key_event` is the central control-flow hub. It first snoozes auto-resolution, routes unanswered-confirmation keys when that popup is open, handles Esc-clearing of notes for option questions, supports interrupt bindings, gives composer submit bindings priority in notes mode, then processes question navigation keys. Within `Focus::Options`, arrows/j-k move the highlighted option, space commits the current selection, Backspace/Delete clears it, Tab opens notes, Enter commits and advances, and digit keys select-and-submit directly. Within `Focus::Notes`, Tab or Esc can clear notes back to options, empty Backspace can close notes, Up/Down still move option selection, and all other editing is delegated to the composer; submitted composer results are converted into committed drafts and either advance or trigger unanswered confirmation. Submission builds a `HashMap<String, ToolRequestUserInputAnswer>`, emits both `user_input_answer` and a history cell event, then advances to the next queued request or marks the overlay done. Auto-resolution is modeled as hidden grace, visible countdown, and due states, with rendering support elsewhere using the timing helpers in this file.

#### Function details

##### `format_auto_resolution_remaining`  (lines 83–94)

```
fn format_auto_resolution_remaining(remaining: Duration) -> String
```

**Purpose**: Formats a remaining duration for the auto-resolution countdown as either seconds or `Xm YYs`. It rounds partial seconds up so the displayed countdown does not hit zero prematurely.

**Data flow**: Takes `remaining: Duration`, reads whole seconds and nanoseconds, increments the displayed seconds if there is any fractional remainder, then returns either `"{seconds}s"` for values under a minute or `"{minutes}m {seconds:02}s"` otherwise.

**Call relations**: Used by `auto_resolution_countdown_text_at` when the countdown becomes visible.

*Call graph*: 3 external calls (as_secs, subsec_nanos, format!).


##### `ComposerDraft::text_with_pending`  (lines 105–119)

```
fn text_with_pending(&self) -> String
```

**Purpose**: Returns the draft text with any pending paste placeholders expanded back into their full pasted payloads. It lets submission logic operate on the real text rather than placeholder markers.

**Data flow**: Reads `self.text`, `self.text_elements`, and `self.pending_pastes`. If there are no pending pastes it clones and returns `self.text`. Otherwise it asserts `text_elements` is non-empty, calls `ChatComposer::expand_pending_pastes` with the stored text, cloned text elements, and pending paste metadata, and returns the expanded string portion.

**Call relations**: Used during answer submission so notes include the actual pasted content rather than placeholder tokens.

*Call graph*: calls 1 internal fn (expand_pending_pastes); 1 external calls (debug_assert!).


##### `FooterTip::new`  (lines 140–145)

```
fn new(text: impl Into<String>) -> Self
```

**Purpose**: Constructs a non-highlighted footer tip from arbitrary text input. It is the default footer-tip constructor.

**Data flow**: Takes any `Into<String>`, converts it into a `String`, stores it in `text`, sets `highlight` to `false`, and returns the `FooterTip`.

**Call relations**: Used by `footer_tips` for ordinary, non-emphasized hints.

*Call graph*: 1 external calls (into).


##### `FooterTip::highlighted`  (lines 147–152)

```
fn highlighted(text: impl Into<String>) -> Self
```

**Purpose**: Constructs a highlighted footer tip. It marks especially important hints such as the primary submit action.

**Data flow**: Takes any `Into<String>`, converts it into a `String`, stores it in `text`, sets `highlight` to `true`, and returns the `FooterTip`.

**Call relations**: Used by `footer_tips` for emphasized actions like adding notes or submitting.

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

**Purpose**: Convenience constructor for tests that builds the overlay with the runtime default keymap. It forwards all behavior to `new_with_keymap`.

**Data flow**: Consumes request parameters, event sender, focus and capability flags, loads `RuntimeKeymap::defaults()`, and returns the result of `new_with_keymap`.

**Call relations**: Used heavily by tests and any callers that do not need custom keymaps.

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

**Purpose**: Builds a fully initialized overlay with a plain-text composer, runtime key bindings, per-question answer state, and restored draft/focus state. It is the real constructor for this subsystem.

**Data flow**: Consumes the request, event sender, focus/capability flags, paste-burst flag, and a `RuntimeKeymap`. It creates a `ChatComposer` configured for plain text and the answer placeholder, applies keymap bindings, suppresses the composer's footer, initializes overlay fields including submit/interrupt/list bindings and timestamps, then mutates the new overlay by calling `reset_for_request`, `ensure_focus_available`, and `restore_current_draft` before returning it.

**Call relations**: Called by `new` and by production code that needs custom keymaps.

*Call graph*: calls 2 internal fn (new_with_config, plain_text); called by 7 (push_user_input_request, freeform_footer_shows_configured_submit_binding, freeform_submit_binding_wins_over_question_navigation, freeform_uses_configured_composer_submit_binding, request_user_input_freeform_remapped_interrupt_snapshot, request_user_input_freeform_remapped_submit_snapshot, request_user_input_uses_remapped_interrupt_binding_while_notes_are_visible); 4 external calls (now, new, new, clone).


##### `RequestUserInputOverlay::current_index`  (lines 240–242)

```
fn current_index(&self) -> usize
```

**Purpose**: Returns the currently active question index. It centralizes access to `current_idx`.

**Data flow**: Reads `self.current_idx` and returns it.

**Call relations**: Used by many helpers that need the active question or answer slot.

*Call graph*: called by 8 (current_answer, current_answer_mut, current_question, footer_tips, go_next_or_submit, notes_has_content, notes_ui_visible, progress_prefix_text).


##### `RequestUserInputOverlay::current_question`  (lines 244–246)

```
fn current_question(&self) -> Option<&ToolRequestUserInputQuestion>
```

**Purpose**: Returns the currently active question, if any. It safely indexes into the request's question list.

**Data flow**: Reads `self.request.questions` and `current_index()`, then returns `self.request.questions.get(idx)`.

**Call relations**: Used by option, wrapping, and placeholder helpers that depend on the active question.

*Call graph*: calls 1 internal fn (current_index); called by 4 (has_options, option_rows, options_len, wrapped_question_lines).


##### `RequestUserInputOverlay::current_answer_mut`  (lines 248–251)

```
fn current_answer_mut(&mut self) -> Option<&mut AnswerState>
```

**Purpose**: Returns mutable access to the current question's answer state. It is the main mutation entrypoint for per-question state.

**Data flow**: Reads `current_index()`, indexes `self.answers` mutably with that index, and returns `Option<&mut AnswerState>`.

**Call relations**: Used throughout draft saving, selection changes, focus changes, and submission handling.

*Call graph*: calls 1 internal fn (current_index); called by 12 (apply_submission_draft, apply_submission_to_draft, clear_notes_and_focus_options, clear_notes_draft, clear_selection, ensure_focus_available, ensure_selected_for_notes, handle_composer_input_result, handle_key_event, handle_paste (+2 more)).


##### `RequestUserInputOverlay::current_answer`  (lines 253–256)

```
fn current_answer(&self) -> Option<&AnswerState>
```

**Purpose**: Returns shared access to the current question's answer state. It is the read-only counterpart to `current_answer_mut`.

**Data flow**: Reads `current_index()`, indexes `self.answers`, and returns `Option<&AnswerState>`.

**Call relations**: Used by visibility, selection, and sizing helpers.

*Call graph*: calls 1 internal fn (current_index); called by 5 (notes_ui_visible, options_preferred_height, options_required_height, restore_current_draft, selected_option_index).


##### `RequestUserInputOverlay::question_count`  (lines 258–260)

```
fn question_count(&self) -> usize
```

**Purpose**: Returns the number of questions in the active request. It is the shared source for navigation and progress text.

**Data flow**: Reads `self.request.questions.len()` and returns it.

**Call relations**: Used by navigation, progress display, and focus validation.

*Call graph*: called by 6 (ensure_focus_available, footer_tips, go_next_or_submit, jump_to_question, move_question, progress_prefix_text).


##### `RequestUserInputOverlay::advance_queue_or_complete_at`  (lines 262–273)

```
fn advance_queue_or_complete_at(&mut self, now: Instant)
```

**Purpose**: Moves from the current request to the next queued request, or marks the overlay complete if the queue is empty. It resets per-request state when advancing.

**Data flow**: Takes `now`, pops the front of `self.queue`. If a next request exists, it replaces `self.request`, updates `request_started_at`, clears `auto_resolution_snoozed`, then calls `reset_for_request`, `ensure_focus_available`, and `restore_current_draft`. If no queued request exists, it sets `self.done = true`.

**Call relations**: Called after successful submission, auto-resolution submission, and dismissal of the current resolved request.

*Call graph*: calls 3 internal fn (ensure_focus_available, reset_for_request, restore_current_draft); called by 3 (dismiss_resolved_request, submit_answers, submit_empty_auto_resolution); 1 external calls (pop_front).


##### `RequestUserInputOverlay::snooze_auto_resolution`  (lines 275–279)

```
fn snooze_auto_resolution(&mut self)
```

**Purpose**: Disables auto-resolution for the current request after user interaction. It prevents the timer from firing once the user has engaged.

**Data flow**: Checks whether `self.request.auto_resolution_ms` is `Some`; if so, sets `self.auto_resolution_snoozed = true`.

**Call relations**: Called at the start of key and paste handling so any interaction cancels the countdown.

*Call graph*: called by 2 (handle_key_event, handle_paste).


##### `RequestUserInputOverlay::auto_resolution_timing_at`  (lines 281–301)

```
fn auto_resolution_timing_at(&self, now: Instant) -> AutoResolutionTiming
```

**Purpose**: Classifies the current auto-resolution state as disabled, hidden grace, visible countdown, or due. It treats the request's `auto_resolution_ms` as an enable flag and uses fixed local timing policy.

**Data flow**: Takes `now`, returns `Disabled` immediately if `auto_resolution_ms` is absent or snoozed. Otherwise it computes elapsed time since `request_started_at`, compares it against `AUTO_RESOLUTION_HIDDEN_GRACE` and `AUTO_RESOLUTION_VISIBLE_COUNTDOWN`, and returns `HiddenGrace { remaining }`, `VisibleCountdown { remaining }`, or `Due` accordingly.

**Call relations**: Used by countdown text generation, frame scheduling, and pre-draw auto-resolution checks.

*Call graph*: called by 2 (auto_resolution_countdown_text_at, auto_resolution_next_frame_delay_at); 1 external calls (saturating_duration_since).


##### `RequestUserInputOverlay::auto_resolution_next_frame_delay_at`  (lines 303–312)

```
fn auto_resolution_next_frame_delay_at(&self, now: Instant) -> Option<Duration>
```

**Purpose**: Computes when the UI should next wake up to update or trigger auto-resolution. It converts timing state into a scheduling hint.

**Data flow**: Takes `now`, matches on `auto_resolution_timing_at(now)`, and returns `None` when disabled, the full remaining hidden-grace duration during grace, the smaller of remaining countdown time and one second during visible countdown, or `Some(Duration::ZERO)` when due.

**Call relations**: Used by `next_frame_delay` so the host can schedule redraws or immediate expiry handling.

*Call graph*: calls 1 internal fn (auto_resolution_timing_at); called by 1 (next_frame_delay); 1 external calls (from_secs).


##### `RequestUserInputOverlay::maybe_auto_resolve_at`  (lines 314–323)

```
fn maybe_auto_resolve_at(&mut self, now: Instant) -> bool
```

**Purpose**: Triggers empty-answer auto-resolution if the countdown has expired. It returns whether resolution occurred.

**Data flow**: Takes `now`, checks whether `auto_resolution_timing_at(now)` is `Due`, returns `false` if not, otherwise calls `submit_empty_auto_resolution(now)` and returns `true`.

**Call relations**: Called from `pre_draw_tick` before rendering.

*Call graph*: calls 1 internal fn (submit_empty_auto_resolution); called by 1 (pre_draw_tick); 1 external calls (matches!).


##### `RequestUserInputOverlay::auto_resolution_countdown_text_at`  (lines 325–335)

```
fn auto_resolution_countdown_text_at(&self, now: Instant) -> Option<String>
```

**Purpose**: Builds the visible countdown label when the auto-resolution timer is in its visible phase. It hides text during grace and after expiry.

**Data flow**: Takes `now`, matches on `auto_resolution_timing_at(now)`, and for `VisibleCountdown { remaining }` returns `Some(format!("auto-resolves in {}", format_auto_resolution_remaining(remaining)))`; otherwise returns `None`.

**Call relations**: Used by rendering code to show the countdown in the progress area.

*Call graph*: calls 1 internal fn (auto_resolution_timing_at); 1 external calls (format!).


##### `RequestUserInputOverlay::progress_prefix_text`  (lines 337–351)

```
fn progress_prefix_text(&self) -> String
```

**Purpose**: Builds the progress label shown above the question, including unanswered-question count when nonzero. It summarizes where the user is in the questionnaire.

**Data flow**: Reads `question_count`, `current_index`, and `unanswered_count`. If there are questions, it formats `Question i/n` and appends `({unanswered} unanswered)` when needed; otherwise it returns `No questions`.

**Call relations**: Used by rendering code for the overlay's progress line.

*Call graph*: calls 3 internal fn (current_index, question_count, unanswered_count); 1 external calls (format!).


##### `RequestUserInputOverlay::has_options`  (lines 353–357)

```
fn has_options(&self) -> bool
```

**Purpose**: Reports whether the current question has a non-empty options list. It drives focus rules, placeholders, and input behavior.

**Data flow**: Reads `current_question()`, accesses `question.options`, and returns true only when the option vector exists and is non-empty.

**Call relations**: Used throughout the overlay to branch between option-question and freeform-question behavior.

*Call graph*: calls 1 internal fn (current_question); called by 13 (clear_notes_and_focus_options, clear_selection, ensure_focus_available, footer_tips, handle_composer_input_result, handle_key_event, notes_placeholder, notes_ui_visible, option_index_for_digit, options_preferred_height (+3 more)).


##### `RequestUserInputOverlay::options_len`  (lines 359–363)

```
fn options_len(&self) -> usize
```

**Purpose**: Returns the number of selectable options for the current question, including the synthetic `None of the above` entry when enabled. It is the canonical option-count helper.

**Data flow**: Reads `current_question()`, maps it through `options_len_for_question`, and returns 0 when there is no current question.

**Call relations**: Used by selection movement, digit mapping, and option-commit logic.

*Call graph*: calls 1 internal fn (current_question); called by 4 (handle_composer_input_result, handle_key_event, option_index_for_digit, select_current_option).


##### `RequestUserInputOverlay::option_index_for_digit`  (lines 365–375)

```
fn option_index_for_digit(&self, ch: char) -> Option<usize>
```

**Purpose**: Maps a numeric key press to an option index for the current question. It ignores `0` and out-of-range digits.

**Data flow**: Takes `ch`, returns `None` if `has_options()` is false, converts the char to a base-10 digit, rejects zero, subtracts one to form a zero-based index, and returns it only if it is less than `options_len()`.

**Call relations**: Used in `handle_key_event` so pressing `1`, `2`, etc. can select and submit options directly.

*Call graph*: calls 2 internal fn (has_options, options_len); called by 1 (handle_key_event).


##### `RequestUserInputOverlay::selected_option_index`  (lines 377–383)

```
fn selected_option_index(&self) -> Option<usize>
```

**Purpose**: Returns the currently highlighted option index for the active question, if options exist. It hides selection state for freeform questions.

**Data flow**: Returns `None` when `has_options()` is false; otherwise reads `current_answer()` and returns `answer.options_state.selected_idx`.

**Call relations**: Used by placeholders, footer tips, and notes-opening logic.

*Call graph*: calls 2 internal fn (current_answer, has_options); called by 3 (footer_tips, handle_key_event, notes_placeholder).


##### `RequestUserInputOverlay::notes_has_content`  (lines 385–391)

```
fn notes_has_content(&self, idx: usize) -> bool
```

**Purpose**: Checks whether the notes draft for a given question contains non-whitespace content. For the current question it consults the live composer, not just the stored draft.

**Data flow**: Takes `idx`. If `idx == current_index()`, it reads `self.composer.current_text_with_pending()`, trims it, and returns whether it is non-empty. Otherwise it reads `self.answers[idx].draft.text`, trims it, and returns whether it is non-empty.

**Call relations**: Used by `notes_ui_visible` to keep notes visible when content exists.

*Call graph*: calls 2 internal fn (current_text_with_pending, current_index).


##### `RequestUserInputOverlay::notes_ui_visible`  (lines 393–400)

```
fn notes_ui_visible(&self) -> bool
```

**Purpose**: Determines whether the notes editor should currently be shown. Freeform questions always show notes; option questions show notes only when explicitly opened or when content exists.

**Data flow**: If `has_options()` is false, returns true. Otherwise it reads the current answer and current index and returns whether `answer.notes_visible` is true or `notes_has_content(idx)` is true.

**Call relations**: Used by focus validation, footer-tip generation, layout, and Esc handling.

*Call graph*: calls 3 internal fn (current_answer, current_index, has_options); called by 3 (ensure_focus_available, footer_tips, handle_key_event).


##### `RequestUserInputOverlay::wrapped_question_lines`  (lines 402–411)

```
fn wrapped_question_lines(&self, width: u16) -> Vec<String>
```

**Purpose**: Wraps the current question text to the given width and returns owned line strings. It prepares question content for layout and rendering.

**Data flow**: Reads `current_question()`. If present, it wraps `q.question` with `textwrap::wrap(width.max(1) as usize)`, converts each wrapped line to `String`, collects them into a vector, and returns it; otherwise returns an empty vector.

**Call relations**: Used by layout code to determine question height and renderable content.

*Call graph*: calls 1 internal fn (current_question).


##### `RequestUserInputOverlay::focus_is_notes`  (lines 413–415)

```
fn focus_is_notes(&self) -> bool
```

**Purpose**: Reports whether the overlay is currently focused on the notes composer rather than the options list. It is a small readability helper.

**Data flow**: Matches `self.focus` against `Focus::Notes` and returns the boolean result.

**Call relations**: Used by footer-tip logic, key handling, and Ctrl-C behavior.

*Call graph*: called by 3 (footer_tips, handle_key_event, on_ctrl_c); 1 external calls (matches!).


##### `RequestUserInputOverlay::confirm_unanswered_active`  (lines 417–419)

```
fn confirm_unanswered_active(&self) -> bool
```

**Purpose**: Reports whether the unanswered-confirmation popup is currently open. It gates alternate key handling paths.

**Data flow**: Returns `self.confirm_unanswered.is_some()`.

**Call relations**: Checked early in `handle_key_event` and `on_ctrl_c`.

*Call graph*: called by 2 (handle_key_event, on_ctrl_c).


##### `RequestUserInputOverlay::option_rows`  (lines 421–465)

```
fn option_rows(&self) -> Vec<GenericDisplayRow>
```

**Purpose**: Builds the renderable option rows for the current question, including numbering, selection arrow, descriptions, wrap indentation, and optional synthetic `None of the above`. It is the data source for option-list rendering and height measurement.

**Data flow**: Reads `current_question()`, current selected index from `current_answer()`, and the question's options. For each real option it formats a row name like `› 2. Label`, computes `wrap_indent` from the prefix width, and stores the option description. If `other_option_enabled_for_question(question)` is true, it appends an extra row labeled `None of the above` with `OTHER_OPTION_DESCRIPTION`. Returns an empty vector when there is no current option list.

**Call relations**: Used by both option-height calculators and, via rendering code in another module, the visible options list.

*Call graph*: calls 1 internal fn (current_question); called by 2 (options_preferred_height, options_required_height).


##### `RequestUserInputOverlay::options_required_height`  (lines 467–486)

```
fn options_required_height(&self, width: u16) -> u16
```

**Purpose**: Computes the full height needed to render all option rows for the current question. It ensures a default selection exists for measurement when none is set.

**Data flow**: Returns 0 if `has_options()` is false. Otherwise it builds `rows` with `option_rows()`, returns 1 if rows are empty, clones the current `options_state` or default state, forces `selected_idx = Some(0)` when absent, and passes rows, state, row count, and width to `measure_rows_height`.

**Call relations**: Used by layout planning when deciding how much vertical space options could consume.

*Call graph*: calls 4 internal fn (current_answer, has_options, option_rows, measure_rows_height).


##### `RequestUserInputOverlay::options_preferred_height`  (lines 488–507)

```
fn options_preferred_height(&self, width: u16) -> u16
```

**Purpose**: Computes the preferred option-list height for the current question. In the current implementation it matches the required height calculation.

**Data flow**: Follows the same steps as `options_required_height`: early-return 0 without options, build rows, ensure a default selected row for measurement, and call `measure_rows_height`.

**Call relations**: Used by layout planning to choose an initial options height before shrinking or growing.

*Call graph*: calls 4 internal fn (current_answer, has_options, option_rows, measure_rows_height).


##### `RequestUserInputOverlay::capture_composer_draft`  (lines 509–521)

```
fn capture_composer_draft(&self) -> ComposerDraft
```

**Purpose**: Snapshots the live composer state into a `ComposerDraft`. It preserves text, structured text elements, local image paths, and pending paste placeholders for later restoration.

**Data flow**: Reads `self.composer.current_text()`, `text_elements()`, `local_images()`, and `pending_pastes()`. It maps local images to their `path` fields, packages all of that into a `ComposerDraft`, and returns it.

**Call relations**: Used before question switches and during submission handling to persist notes state.

*Call graph*: calls 4 internal fn (current_text, local_images, pending_pastes, text_elements); called by 2 (handle_key_event, save_current_draft).


##### `RequestUserInputOverlay::save_current_draft`  (lines 523–535)

```
fn save_current_draft(&mut self)
```

**Purpose**: Stores the current composer's draft into the active answer slot and invalidates a previously committed answer if the draft changed. It also keeps notes visible once they contain content.

**Data flow**: Captures the current draft via `capture_composer_draft`, computes whether the draft text is empty after trimming, mutably accesses the current answer, clears `answer_committed` if it had been true and the stored draft differs from the new one, replaces `answer.draft`, and sets `answer.notes_visible = true` when notes are non-empty.

**Call relations**: Called before navigation and submission so per-question drafts stay synchronized with the live composer.

*Call graph*: calls 2 internal fn (capture_composer_draft, current_answer_mut); called by 5 (go_next_or_submit, handle_key_event, jump_to_question, move_question, submit_answers).


##### `RequestUserInputOverlay::restore_current_draft`  (lines 537–552)

```
fn restore_current_draft(&mut self)
```

**Purpose**: Loads the active question's stored draft back into the shared composer and updates the placeholder accordingly. It is the inverse of `save_current_draft` when switching questions.

**Data flow**: Sets the composer's placeholder from `notes_placeholder()` and clears its footer hint override. If there is no current answer, it empties the composer and moves the cursor to the end. Otherwise it clones the stored `ComposerDraft`, sets the composer's text content, pending pastes, and cursor position from that draft.

**Call relations**: Called after request resets and question navigation so the shared composer reflects the newly active question.

*Call graph*: calls 7 internal fn (move_cursor_to_end, set_footer_hint_override, set_pending_pastes, set_placeholder_text, set_text_content, current_answer, notes_placeholder); called by 3 (advance_queue_or_complete_at, jump_to_question, move_question); 2 external calls (new, new).


##### `RequestUserInputOverlay::notes_placeholder`  (lines 554–562)

```
fn notes_placeholder(&self) -> &'static str
```

**Purpose**: Chooses the placeholder text for the notes composer based on whether the current question has options and whether an option is selected. It guides the user toward the next valid action.

**Data flow**: Reads `has_options()` and `selected_option_index()`. Returns `SELECT_OPTION_PLACEHOLDER` when options exist but none is selected, `NOTES_PLACEHOLDER` when options exist and one is selected, and `ANSWER_PLACEHOLDER` for freeform questions.

**Call relations**: Used by `restore_current_draft` and `sync_composer_placeholder`.

*Call graph*: calls 2 internal fn (has_options, selected_option_index); called by 2 (restore_current_draft, sync_composer_placeholder).


##### `RequestUserInputOverlay::sync_composer_placeholder`  (lines 564–567)

```
fn sync_composer_placeholder(&mut self)
```

**Purpose**: Refreshes the composer's placeholder text to match current selection/focus state. It centralizes placeholder updates after state changes.

**Data flow**: Computes `notes_placeholder()` and passes it to `self.composer.set_placeholder_text(...)`.

**Call relations**: Called after selection changes, focus changes, and draft-clearing operations.

*Call graph*: calls 2 internal fn (set_placeholder_text, notes_placeholder); called by 7 (clear_notes_and_focus_options, clear_notes_draft, clear_selection, ensure_focus_available, ensure_selected_for_notes, handle_key_event, select_current_option).


##### `RequestUserInputOverlay::clear_notes_draft`  (lines 569–580)

```
fn clear_notes_draft(&mut self)
```

**Purpose**: Clears the current question's notes draft while keeping the notes UI visible. It is the Ctrl-C behavior when editing notes with content.

**Data flow**: Mutably accesses the current answer, replaces its draft with `ComposerDraft::default()`, clears `answer_committed`, forces `notes_visible = true`, clears `pending_submission_draft`, empties the composer text content, moves the cursor to the end, and refreshes the placeholder.

**Call relations**: Called from `on_ctrl_c` when notes are focused and non-empty.

*Call graph*: calls 4 internal fn (move_cursor_to_end, set_text_content, current_answer_mut, sync_composer_placeholder); called by 1 (on_ctrl_c); 3 external calls (new, new, default).


##### `RequestUserInputOverlay::footer_tips`  (lines 582–631)

```
fn footer_tips(&self) -> Vec<FooterTip>
```

**Purpose**: Builds the logical list of footer hints appropriate for the current question, focus, and keymap. It decides which actions to advertise and which ones should be highlighted.

**Data flow**: Reads notes visibility, option selection, question count, current index, focus, configured submit bindings, and interrupt bindings. It conditionally pushes tips for adding/clearing notes, submitting the current answer or all answers, navigating between questions, and interrupting, using `FooterTip::new` or `FooterTip::highlighted` depending on emphasis. It suppresses the interrupt tip when Esc is already being advertised as `clear notes` in option-notes mode.

**Call relations**: Used by footer wrapping helpers and ultimately by rendering code.

*Call graph*: calls 9 internal fn (highlighted, new, current_index, focus_is_notes, has_options, notes_ui_visible, question_count, selected_option_index, plain); called by 2 (footer_tip_lines, footer_tip_lines_with_prefix); 2 external calls (new, format!).


##### `RequestUserInputOverlay::footer_tip_lines`  (lines 633–635)

```
fn footer_tip_lines(&self, width: u16) -> Vec<Vec<FooterTip>>
```

**Purpose**: Wraps the current footer tips into one or more lines that fit the given width. It is the standard footer-line builder without a prefix tip.

**Data flow**: Calls `footer_tips()` to get the logical tips, then passes them to `wrap_footer_tips(width, tips)` and returns the resulting grouped lines.

**Call relations**: Used by `footer_required_height` and rendering code.

*Call graph*: calls 2 internal fn (footer_tips, wrap_footer_tips); called by 1 (footer_required_height).


##### `RequestUserInputOverlay::footer_tip_lines_with_prefix`  (lines 637–648)

```
fn footer_tip_lines_with_prefix(
        &self,
        width: u16,
        prefix: Option<FooterTip>,
    ) -> Vec<Vec<FooterTip>>
```

**Purpose**: Wraps footer tips with an optional leading prefix tip inserted before the standard tips. It supports render paths that need to prepend extra status text.

**Data flow**: Takes `width` and optional `prefix`, builds a tip vector starting with the prefix when present, extends it with `footer_tips()`, then returns `wrap_footer_tips(width, tips)`.

**Call relations**: Used by rendering code when a prefixed footer line is needed.

*Call graph*: calls 2 internal fn (footer_tips, wrap_footer_tips); 1 external calls (new).


##### `RequestUserInputOverlay::wrap_footer_tips`  (lines 650–689)

```
fn wrap_footer_tips(&self, width: u16, tips: Vec<FooterTip>) -> Vec<Vec<FooterTip>>
```

**Purpose**: Packs footer tips into width-bounded lines without splitting individual tips. It preserves the `TIP_SEPARATOR` between adjacent tips on the same line.

**Data flow**: Takes `width` and a vector of `FooterTip`. It computes `max_width` and separator width, returns a single empty line when there are no tips, then iterates through tips measuring each tip's display width, starting a new line whenever adding the next tip plus separator would exceed `max_width`. It returns a `Vec<Vec<FooterTip>>` where each inner vector is one rendered line.

**Call relations**: Shared by both footer-line builders and indirectly by footer height calculation.

*Call graph*: called by 2 (footer_tip_lines, footer_tip_lines_with_prefix); 3 external calls (width, new, vec!).


##### `RequestUserInputOverlay::footer_required_height`  (lines 691–693)

```
fn footer_required_height(&self, width: u16) -> u16
```

**Purpose**: Returns how many footer rows are needed at the given width. It is the layout-facing wrapper around footer-tip wrapping.

**Data flow**: Calls `footer_tip_lines(width)` and returns the number of grouped lines as `u16`.

**Call relations**: Used by layout planning to reserve footer space.

*Call graph*: calls 1 internal fn (footer_tip_lines).


##### `RequestUserInputOverlay::ensure_focus_available`  (lines 696–711)

```
fn ensure_focus_available(&mut self)
```

**Purpose**: Normalizes focus and notes visibility so they remain valid for the current question type and state. It prevents impossible focus combinations after navigation or request resets.

**Data flow**: If there are no questions it returns. If the current question has no options, it forces `self.focus = Focus::Notes` and marks the current answer's `notes_visible = true`. Otherwise, if focus is `Notes` but `notes_ui_visible()` is false, it switches focus back to `Options` and refreshes the placeholder.

**Call relations**: Called after request resets and question navigation to keep focus state coherent.

*Call graph*: calls 5 internal fn (current_answer_mut, has_options, notes_ui_visible, question_count, sync_composer_placeholder); called by 3 (advance_queue_or_complete_at, jump_to_question, move_question); 1 external calls (matches!).


##### `RequestUserInputOverlay::reset_for_request`  (lines 714–743)

```
fn reset_for_request(&mut self)
```

**Purpose**: Rebuilds all per-question answer state from the current request and resets overlay-local navigation/submission state. It is the per-request initialization routine.

**Data flow**: Iterates over `self.request.questions`, creating one `AnswerState` per question with a fresh `ScrollState`, default draft, `answer_committed = false`, and `notes_visible = !has_options`. For option questions it seeds `options_state.selected_idx = Some(0)`. It then resets `current_idx` to 0, `focus` to `Options`, clears the composer text, and clears unanswered-confirmation and pending-submission state.

**Call relations**: Called during construction and whenever the overlay advances to a queued request.

*Call graph*: calls 1 internal fn (set_text_content); called by 1 (advance_queue_or_complete_at); 2 external calls (new, new).


##### `RequestUserInputOverlay::options_len_for_question`  (lines 745–756)

```
fn options_len_for_question(question: &ToolRequestUserInputQuestion) -> usize
```

**Purpose**: Computes the selectable option count for an arbitrary question, including the synthetic `None of the above` row when enabled. It is the question-scoped counterpart to `options_len`.

**Data flow**: Reads `question.options` length or 0, checks `other_option_enabled_for_question(question)`, and returns either the raw length or length plus one.

**Call relations**: Used by `options_len` and other helpers that need option counts independent of current overlay state.

*Call graph*: 1 external calls (other_option_enabled_for_question).


##### `RequestUserInputOverlay::other_option_enabled_for_question`  (lines 758–764)

```
fn other_option_enabled_for_question(question: &ToolRequestUserInputQuestion) -> bool
```

**Purpose**: Reports whether a question should expose the synthetic `None of the above` option. It requires both `is_other` and a non-empty real options list.

**Data flow**: Reads `question.is_other` and `question.options`, returning true only when `is_other` is true and the options vector exists and is non-empty.

**Call relations**: Used by option counting, row building, and label lookup.


##### `RequestUserInputOverlay::option_label_for_index`  (lines 766–778)

```
fn option_label_for_index(
        question: &ToolRequestUserInputQuestion,
        idx: usize,
    ) -> Option<String>
```

**Purpose**: Maps an option index back to the label that should be submitted for a given question, including the synthetic `None of the above` label. It returns `None` for invalid indices.

**Data flow**: Takes a question and index, reads `question.options`, returns the real option label when `idx < options.len()`, returns `OTHER_OPTION_LABEL` when `idx == options.len()` and the synthetic option is enabled, otherwise returns `None`.

**Call relations**: Used during answer submission to convert committed selection indices into answer strings.

*Call graph*: 1 external calls (other_option_enabled_for_question).


##### `RequestUserInputOverlay::move_question`  (lines 781–791)

```
fn move_question(&mut self, next: bool)
```

**Purpose**: Moves to the next or previous question with wraparound, preserving the current draft before switching and restoring the destination draft afterward. It is the main question-navigation primitive.

**Data flow**: Reads `question_count()`, returns early when there are no questions, saves the current draft, computes an offset of `1` for next or `len - 1` for previous, updates `current_idx` modulo the question count, restores the new current draft, and normalizes focus with `ensure_focus_available()`.

**Call relations**: Called by key handling and by `go_next_or_submit` when advancing between questions.

*Call graph*: calls 4 internal fn (ensure_focus_available, question_count, restore_current_draft, save_current_draft); called by 2 (go_next_or_submit, handle_key_event).


##### `RequestUserInputOverlay::jump_to_question`  (lines 793–801)

```
fn jump_to_question(&mut self, idx: usize)
```

**Purpose**: Moves directly to a specific question index if it is in range, preserving and restoring drafts around the jump. It is used mainly by unanswered-confirmation flows.

**Data flow**: Takes `idx`, returns early if `idx >= question_count()`, saves the current draft, sets `current_idx = idx`, restores the destination draft, and calls `ensure_focus_available()`.

**Call relations**: Called from unanswered-confirmation handling when the user chooses to go back to the first unanswered question.

*Call graph*: calls 4 internal fn (ensure_focus_available, question_count, restore_current_draft, save_current_draft); called by 1 (handle_confirm_unanswered_key_event).


##### `RequestUserInputOverlay::select_current_option`  (lines 804–819)

```
fn select_current_option(&mut self, committed: bool)
```

**Purpose**: Commits or updates the current option selection for the active question and refreshes the notes placeholder. It clamps selection to the valid option range before marking commitment.

**Data flow**: Returns early if `has_options()` is false. Otherwise it reads `options_len()`, mutably accesses the current answer, clamps `answer.options_state` to that length, sets `answer.answer_committed = committed`, and then refreshes the composer placeholder if an answer was updated.

**Call relations**: Used by option-space, Enter, and digit-selection paths in `handle_key_event`.

*Call graph*: calls 4 internal fn (current_answer_mut, has_options, options_len, sync_composer_placeholder); called by 1 (handle_key_event).


##### `RequestUserInputOverlay::clear_selection`  (lines 822–837)

```
fn clear_selection(&mut self)
```

**Purpose**: Clears the current option selection and associated notes draft, hiding notes for option questions. It resets the active question back to an unanswered state.

**Data flow**: Returns early if `has_options()` is false. Otherwise it mutably accesses the current answer, resets `options_state`, replaces the draft with `ComposerDraft::default()`, clears `answer_committed` and `notes_visible`, clears `pending_submission_draft`, empties the composer text, moves the cursor to the end, and refreshes the placeholder.

**Call relations**: Triggered from `handle_key_event` on Backspace/Delete while focused on options.

*Call graph*: calls 5 internal fn (move_cursor_to_end, set_text_content, current_answer_mut, has_options, sync_composer_placeholder); called by 1 (handle_key_event); 3 external calls (new, new, default).


##### `RequestUserInputOverlay::clear_notes_and_focus_options`  (lines 839–854)

```
fn clear_notes_and_focus_options(&mut self)
```

**Purpose**: Drops the current notes draft, hides the notes UI, and returns focus to the options list while preserving the selected option. It is the shared path for Esc/Tab exits from notes mode on option questions.

**Data flow**: Returns early if `has_options()` is false. Otherwise it mutably accesses the current answer, replaces its draft with `ComposerDraft::default()`, clears `answer_committed` and `notes_visible`, clears `pending_submission_draft`, empties the composer, moves the cursor to the end, sets `self.focus = Focus::Options`, and refreshes the placeholder.

**Call relations**: Called from `handle_key_event` when Esc or Tab should close notes on option questions.

*Call graph*: calls 5 internal fn (move_cursor_to_end, set_text_content, current_answer_mut, has_options, sync_composer_placeholder); called by 1 (handle_key_event); 3 external calls (new, new, default).


##### `RequestUserInputOverlay::ensure_selected_for_notes`  (lines 857–862)

```
fn ensure_selected_for_notes(&mut self)
```

**Purpose**: Marks notes as visible for the current answer and refreshes the placeholder before notes editing or paste insertion. It does not itself create a selection, despite the name.

**Data flow**: Mutably accesses the current answer and sets `answer.notes_visible = true`, then calls `sync_composer_placeholder()`.

**Call relations**: Used before entering notes mode, before notes submission, and before handling pasted text.

*Call graph*: calls 2 internal fn (current_answer_mut, sync_composer_placeholder); called by 2 (handle_key_event, handle_paste).


##### `RequestUserInputOverlay::go_next_or_submit`  (lines 865–876)

```
fn go_next_or_submit(&mut self)
```

**Purpose**: Advances to the next question or submits the whole questionnaire when already on the last question. It also opens unanswered confirmation when needed.

**Data flow**: Checks whether `current_index() + 1 >= question_count()`. On the last question it saves the current draft and either opens unanswered confirmation when `unanswered_count() > 0` or calls `submit_answers()`. Otherwise it calls `move_question(true)`.

**Call relations**: Reached after committed option selection or successful composer submission.

*Call graph*: calls 7 internal fn (current_index, move_question, open_unanswered_confirmation, question_count, save_current_draft, submit_answers, unanswered_count); called by 2 (handle_composer_input_result, handle_key_event).


##### `RequestUserInputOverlay::submit_answers`  (lines 879–927)

```
fn submit_answers(&mut self)
```

**Purpose**: Builds the final structured answer payload for all questions, emits it to the app, records a history cell, and advances to the next queued request or completion. It is the main successful completion path.

**Data flow**: Clears unanswered confirmation, saves the current draft, then iterates over all questions and corresponding `AnswerState`s. For option questions it includes the selected option label only when `answer_committed` is true; for all questions it includes notes only when committed, using `draft.text_with_pending().trim()`. It builds a `HashMap<String, ToolRequestUserInputAnswer>`, sends it through `app_event_tx.user_input_answer`, emits an `AppEvent::InsertHistoryCell` containing the questions and answers, and finally calls `advance_queue_or_complete_at(Instant::now())`.

**Call relations**: Called from `go_next_or_submit` and from unanswered-confirmation acceptance.

*Call graph*: calls 4 internal fn (send, user_input_answer, advance_queue_or_complete_at, save_current_draft); called by 2 (go_next_or_submit, handle_confirm_unanswered_key_event); 6 external calls (new, new, now, new, InsertHistoryCell, format!).


##### `RequestUserInputOverlay::submit_empty_auto_resolution`  (lines 929–946)

```
fn submit_empty_auto_resolution(&mut self, now: Instant)
```

**Purpose**: Submits an empty answer map when auto-resolution expires, records the corresponding history cell, and advances the request queue. It bypasses draft inspection entirely.

**Data flow**: Clears unanswered confirmation, creates an empty `HashMap<String, ToolRequestUserInputAnswer>`, sends it via `user_input_answer`, emits a history cell with `interrupted: false`, and calls `advance_queue_or_complete_at(now)`.

**Call relations**: Called only by `maybe_auto_resolve_at` when the countdown reaches `Due`.

*Call graph*: calls 3 internal fn (send, user_input_answer, advance_queue_or_complete_at); called by 1 (maybe_auto_resolve_at); 3 external calls (new, new, InsertHistoryCell).


##### `RequestUserInputOverlay::dismiss_resolved_request`  (lines 948–962)

```
fn dismiss_resolved_request(&mut self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Removes a resolved request from either the active slot or the queued requests without emitting interrupt or answer events. It lets stale server-side resolutions close prompts quietly.

**Data flow**: Takes a `ResolvedAppServerRequest`, returns `false` unless it is `UserInput { call_id }`. It records the queue length, removes queued requests whose `item_id` matches `call_id`, and if the active request's `item_id` matches it advances to the next queued request or completion at `Instant::now()` and returns `true`. Otherwise it returns whether the queue length changed.

**Call relations**: Used by the `BottomPaneView` dismissal hook when app-server requests resolve externally.

*Call graph*: calls 1 internal fn (advance_queue_or_complete_at); called by 1 (dismiss_app_server_request); 3 external calls (now, len, retain).


##### `RequestUserInputOverlay::open_unanswered_confirmation`  (lines 964–968)

```
fn open_unanswered_confirmation(&mut self)
```

**Purpose**: Opens the two-choice confirmation popup shown when the user tries to submit with unanswered questions. It defaults selection to the submit/proceed option.

**Data flow**: Creates a fresh `ScrollState`, sets `selected_idx = Some(0)`, and stores it in `self.confirm_unanswered`.

**Call relations**: Called by `go_next_or_submit` when unanswered questions remain on the last question.

*Call graph*: calls 1 internal fn (new); called by 1 (go_next_or_submit).


##### `RequestUserInputOverlay::close_unanswered_confirmation`  (lines 970–972)

```
fn close_unanswered_confirmation(&mut self)
```

**Purpose**: Closes the unanswered-confirmation popup. It is the shared dismissal helper for multiple branches.

**Data flow**: Sets `self.confirm_unanswered = None`.

**Call relations**: Used by confirmation key handling and Ctrl-C behavior.

*Call graph*: called by 2 (handle_confirm_unanswered_key_event, on_ctrl_c).


##### `RequestUserInputOverlay::unanswered_question_count`  (lines 974–976)

```
fn unanswered_question_count(&self) -> usize
```

**Purpose**: Returns the number of unanswered questions. It is a naming wrapper used by confirmation-description code.

**Data flow**: Calls `unanswered_count()` and returns the result.

**Call relations**: Used by `unanswered_submit_description`.

*Call graph*: calls 1 internal fn (unanswered_count); called by 1 (unanswered_submit_description).


##### `RequestUserInputOverlay::unanswered_submit_description`  (lines 978–986)

```
fn unanswered_submit_description(&self) -> String
```

**Purpose**: Builds the descriptive text for the `Proceed` row in the unanswered-confirmation popup. It pluralizes `question` correctly.

**Data flow**: Reads `unanswered_question_count()`, chooses either the singular or plural suffix constant, formats `Submit with {count} unanswered {suffix}.`, and returns the string.

**Call relations**: Used by `unanswered_confirmation_rows`.

*Call graph*: calls 1 internal fn (unanswered_question_count); called by 1 (unanswered_confirmation_rows); 1 external calls (format!).


##### `RequestUserInputOverlay::first_unanswered_index`  (lines 988–996)

```
fn first_unanswered_index(&self) -> Option<usize>
```

**Purpose**: Finds the first question that would currently submit as unanswered. It is used to jump the user back from the confirmation popup.

**Data flow**: Reads the current composer text, iterates over `self.request.questions` with indices, calls `is_question_answered(idx, &current_text)` for each, and returns the first index for which that returns false.

**Call relations**: Used by unanswered-confirmation cancellation and `Go back` selection handling.

*Call graph*: calls 1 internal fn (current_text); called by 1 (handle_confirm_unanswered_key_event).


##### `RequestUserInputOverlay::unanswered_confirmation_rows`  (lines 998–1027)

```
fn unanswered_confirmation_rows(&self) -> Vec<GenericDisplayRow>
```

**Purpose**: Builds the two menu rows for the unanswered-confirmation popup, including selection arrow and descriptions. It is the popup's row-model generator.

**Data flow**: Reads the selected row from `self.confirm_unanswered`, builds two entries (`Proceed` with dynamic description and `Go back` with fixed description), maps them into `GenericDisplayRow`s with numbered labels and a `›` prefix on the selected row, and returns the vector.

**Call relations**: Used by rendering code when the confirmation popup is active.

*Call graph*: calls 1 internal fn (unanswered_submit_description).


##### `RequestUserInputOverlay::is_question_answered`  (lines 1029–1045)

```
fn is_question_answered(&self, idx: usize, _current_text: &str) -> bool
```

**Purpose**: Determines whether a specific question currently counts as answered for submission and unanswered-count purposes. Option questions require a committed selection; freeform questions require a committed draft.

**Data flow**: Takes `idx` and an unused `_current_text`, fetches the question and answer state, returns false if either is missing, checks whether the question has options, and then returns `answer.options_state.selected_idx.is_some() && answer.answer_committed` for option questions or `answer.answer_committed` for freeform questions.

**Call relations**: Used by unanswered counting and first-unanswered lookup.


##### `RequestUserInputOverlay::unanswered_count`  (lines 1048–1056)

```
fn unanswered_count(&self) -> usize
```

**Purpose**: Counts how many questions would currently submit an empty answer list. It is the core unanswered-question metric used in progress text and confirmation logic.

**Data flow**: Reads the current composer text, iterates over all questions with indices, filters those for which `is_question_answered(idx, &current_text)` is false, and returns the count.

**Call relations**: Used by progress text, unanswered confirmation, and submission gating.

*Call graph*: calls 1 internal fn (current_text); called by 3 (go_next_or_submit, progress_prefix_text, unanswered_question_count).


##### `RequestUserInputOverlay::notes_input_height`  (lines 1059–1064)

```
fn notes_input_height(&self, width: u16) -> u16
```

**Purpose**: Computes the preferred height of the notes composer, clamped to a small range above the minimum composer height. It prevents notes from growing unboundedly tall.

**Data flow**: Reads `self.composer.desired_height(width.max(1))`, clamps it between `MIN_COMPOSER_HEIGHT` and `MIN_COMPOSER_HEIGHT + 5`, and returns the result.

**Call relations**: Used by layout planning when notes are visible.

*Call graph*: calls 1 internal fn (desired_height).


##### `RequestUserInputOverlay::apply_submission_to_draft`  (lines 1066–1085)

```
fn apply_submission_to_draft(&mut self, text: String, text_elements: Vec<TextElement>)
```

**Purpose**: Stores submitted composer text back into the current answer draft and reloads the composer from that committed content. It clears pending-paste placeholders because submission has materialized the text.

**Data flow**: Takes submitted `text` and `text_elements`, collects current local image paths from the composer, writes a new `ComposerDraft` with empty `pending_pastes` into the current answer, then sets the composer's text content, moves the cursor to the end, and clears the footer hint override.

**Call relations**: Called by `handle_composer_input_result` when there is no pending submission draft override.

*Call graph*: calls 5 internal fn (local_images, move_cursor_to_end, set_footer_hint_override, set_text_content, current_answer_mut); called by 1 (handle_composer_input_result); 1 external calls (new).


##### `RequestUserInputOverlay::apply_submission_draft`  (lines 1087–1096)

```
fn apply_submission_draft(&mut self, draft: ComposerDraft)
```

**Purpose**: Restores a previously captured draft after the composer reports submission, preserving pending paste placeholders and other draft metadata. It is used when submission should commit the pre-submit draft exactly as captured.

**Data flow**: Takes a `ComposerDraft`, clones it into the current answer, sets the composer's text content and pending pastes from that draft, moves the cursor to the end, and clears the footer hint override.

**Call relations**: Called by `handle_composer_input_result` when `pending_submission_draft` was captured before forwarding the submit key to the composer.

*Call graph*: calls 5 internal fn (move_cursor_to_end, set_footer_hint_override, set_pending_pastes, set_text_content, current_answer_mut); called by 1 (handle_composer_input_result); 2 external calls (new, clone).


##### `RequestUserInputOverlay::handle_composer_input_result`  (lines 1098–1136)

```
fn handle_composer_input_result(&mut self, result: InputResult) -> bool
```

**Purpose**: Interprets the `ChatComposer` result in overlay terms, committing answers and advancing when the composer reports submission or queueing. It bridges generic composer behavior into request-user-input semantics.

**Data flow**: Takes an `InputResult`. For `Submitted` or `Queued`, it optionally clamps option selection when notes were entered on an option question, marks the current answer committed (or committed only when non-empty for freeform questions), applies either `pending_submission_draft` or the submitted text via `apply_submission_draft`/`apply_submission_to_draft`, calls `go_next_or_submit()`, and returns `true`. For all other results it returns `false` without advancing.

**Call relations**: Called after delegating key events to the composer from notes mode or submit-binding handling.

*Call graph*: calls 6 internal fn (apply_submission_draft, apply_submission_to_draft, current_answer_mut, go_next_or_submit, has_options, options_len); called by 1 (handle_key_event); 1 external calls (matches!).


##### `RequestUserInputOverlay::handle_confirm_unanswered_key_event`  (lines 1138–1178)

```
fn handle_confirm_unanswered_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Processes keyboard input while the unanswered-confirmation popup is open. It supports cancel, navigation, direct numeric selection, and acceptance.

**Data flow**: Takes a `KeyEvent`, ignores release events, mutably accesses `self.confirm_unanswered`, and matches on `key_event.code`. Esc/Backspace closes the popup and jumps to the first unanswered question if any; Up/k and Down/j wrap the two-row selection; Enter closes the popup and either submits answers or jumps back depending on the selected row; `1` and `2` directly set the selected row.

**Call relations**: Called early from `handle_key_event` whenever `confirm_unanswered_active()` is true.

*Call graph*: calls 4 internal fn (close_unanswered_confirmation, first_unanswered_index, jump_to_question, submit_answers); called by 1 (handle_key_event); 1 external calls (matches!).


##### `RequestUserInputOverlay::prefer_esc_to_handle_key_event`  (lines 1182–1184)

```
fn prefer_esc_to_handle_key_event(&self) -> bool
```

**Purpose**: Signals that this overlay wants to receive Esc through normal key handling rather than having it intercepted generically. This is necessary because Esc has overlay-specific meanings.

**Data flow**: Returns `true`.

**Call relations**: Queried by the bottom-pane host before dispatching Esc.


##### `RequestUserInputOverlay::handle_key_event`  (lines 1186–1422)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Implements the overlay's full keyboard state machine: auto-resolution snoozing, unanswered-confirmation routing, interrupt handling, question navigation, option selection, notes-mode editing, and composer submission bridging. It is the central interactive control path for this overlay.

**Data flow**: Consumes a `KeyEvent`. It ignores release events, snoozes auto-resolution, routes to `handle_confirm_unanswered_key_event` when the confirmation popup is active, handles Esc as `clear notes` for option questions with visible notes, interrupts immediately on configured interrupt bindings, gives composer submit bindings priority in notes mode by capturing a draft and forwarding the key to the composer, then processes question navigation keys (`ctrl-p/n`, PageUp/PageDown, h/l, arrows, remapped horizontal list bindings). In `Focus::Options`, it mutates option selection, commitment, notes visibility, and question advancement based on arrows/j-k, space, Backspace/Delete, Tab, Enter, and digit keys. In `Focus::Notes`, it supports Tab/Esc/backspace exits back to options, Up/Down option movement while editing notes, marks answers uncommitted on text-editing keys, delegates remaining input to the composer, and uses `handle_composer_input_result` plus before/after draft comparison to update commitment state.

**Call relations**: This is the main `BottomPaneView` event entrypoint; it orchestrates nearly every helper in the file depending on current focus and popup state.

*Call graph*: calls 23 internal fn (interrupt, current_text_with_pending, handle_key_event, capture_composer_draft, clear_notes_and_focus_options, clear_selection, confirm_unanswered_active, current_answer_mut, ensure_selected_for_notes, focus_is_notes (+13 more)); 1 external calls (matches!).


##### `RequestUserInputOverlay::terminal_title_requires_action`  (lines 1424–1426)

```
fn terminal_title_requires_action(&self) -> bool
```

**Purpose**: Indicates that the terminal title should reflect that user action is required while this overlay is active. It is a simple capability flag for the host UI.

**Data flow**: Returns `true`.

**Call relations**: Queried by the surrounding UI framework while the overlay is displayed.


##### `RequestUserInputOverlay::on_ctrl_c`  (lines 1428–1447)

```
fn on_ctrl_c(&mut self) -> CancellationEvent
```

**Purpose**: Handles Ctrl-C according to overlay state: close unanswered confirmation and interrupt, clear notes draft when editing non-empty notes, or interrupt outright otherwise. It always consumes the cancellation event.

**Data flow**: If unanswered confirmation is active, it closes the popup, sends `interrupt` through `app_event_tx`, marks `done = true`, and returns `Handled`. Else if notes are focused and the composer has non-empty text, it clears the notes draft and returns `Handled`. Otherwise it sends `interrupt`, marks `done = true`, and returns `Handled`.

**Call relations**: Invoked by the bottom-pane host on terminal cancellation.

*Call graph*: calls 6 internal fn (interrupt, current_text_with_pending, clear_notes_draft, close_unanswered_confirmation, confirm_unanswered_active, focus_is_notes).


##### `RequestUserInputOverlay::is_complete`  (lines 1449–1451)

```
fn is_complete(&self) -> bool
```

**Purpose**: Reports whether the overlay has finished processing all requests or has been interrupted. It is the `BottomPaneView` completion flag.

**Data flow**: Reads `self.done` and returns it.

**Call relations**: Used by the host to know when to dismiss the overlay.


##### `RequestUserInputOverlay::handle_paste`  (lines 1453–1467)

```
fn handle_paste(&mut self, pasted: String) -> bool
```

**Purpose**: Handles pasted text by snoozing auto-resolution, switching into notes mode when necessary, marking the current answer uncommitted, and delegating insertion to the shared composer. It treats paste like typing into notes.

**Data flow**: Takes `pasted: String`, returns `false` immediately if it is empty. Otherwise it snoozes auto-resolution, switches `focus` to `Notes` when currently in `Options`, ensures notes are visible, clears `answer_committed` on the current answer, and returns the boolean result of `self.composer.handle_paste(pasted)`.

**Call relations**: Called by the bottom-pane host for explicit paste events; it complements key-based notes editing.

*Call graph*: calls 4 internal fn (handle_paste, current_answer_mut, ensure_selected_for_notes, snooze_auto_resolution); 1 external calls (matches!).


##### `RequestUserInputOverlay::flush_paste_burst_if_due`  (lines 1469–1471)

```
fn flush_paste_burst_if_due(&mut self) -> bool
```

**Purpose**: Delegates pending paste-burst flushing to the shared composer. It exposes the composer's burst state machine through the overlay interface.

**Data flow**: Calls `self.composer.flush_paste_burst_if_due()` and returns the resulting boolean.

**Call relations**: Used by the host's periodic input-processing loop when this overlay is active.

*Call graph*: calls 1 internal fn (flush_paste_burst_if_due).


##### `RequestUserInputOverlay::is_in_paste_burst`  (lines 1473–1475)

```
fn is_in_paste_burst(&self) -> bool
```

**Purpose**: Reports whether the shared composer is currently inside a paste-burst transient state. It forwards the composer's status through the overlay.

**Data flow**: Calls `self.composer.is_in_paste_burst()` and returns the boolean result.

**Call relations**: Queried by the host when coordinating paste-burst behavior across views.

*Call graph*: calls 1 internal fn (is_in_paste_burst).


##### `RequestUserInputOverlay::pre_draw_tick`  (lines 1477–1479)

```
fn pre_draw_tick(&mut self, now: Instant) -> bool
```

**Purpose**: Runs pre-render maintenance and triggers auto-resolution when due. It lets the overlay mutate itself just before drawing.

**Data flow**: Takes `now`, calls `maybe_auto_resolve_at(now)`, and returns whether that caused a state change.

**Call relations**: Called by the host before rendering frames.

*Call graph*: calls 1 internal fn (maybe_auto_resolve_at).


##### `RequestUserInputOverlay::next_frame_delay`  (lines 1481–1483)

```
fn next_frame_delay(&self) -> Option<Duration>
```

**Purpose**: Returns the next desired wake-up time for countdown updates or auto-resolution expiry. It is the runtime-facing wrapper around the timing helper.

**Data flow**: Calls `auto_resolution_next_frame_delay_at(Instant::now())` and returns the resulting `Option<Duration>`.

**Call relations**: Used by the host scheduler while the overlay is active.

*Call graph*: calls 1 internal fn (auto_resolution_next_frame_delay_at); 1 external calls (now).


##### `RequestUserInputOverlay::try_consume_user_input_request`  (lines 1485–1491)

```
fn try_consume_user_input_request(
        &mut self,
        request: ToolRequestUserInputParams,
    ) -> Option<ToolRequestUserInputParams>
```

**Purpose**: Queues an additional user-input request behind the current one instead of replacing it immediately. It preserves FIFO processing order for multiple prompts.

**Data flow**: Takes a `ToolRequestUserInputParams`, pushes it onto `self.queue`, and returns `None` to indicate the current overlay continues handling the active request.

**Call relations**: Called by the host when a new request-user-input prompt arrives while one is already active.

*Call graph*: 1 external calls (push_back).


##### `RequestUserInputOverlay::dismiss_app_server_request`  (lines 1493–1495)

```
fn dismiss_app_server_request(&mut self, request: &ResolvedAppServerRequest) -> bool
```

**Purpose**: Forwards app-server request dismissal to the overlay's internal resolved-request handler. It is the `BottomPaneView` integration point for external resolution.

**Data flow**: Takes a `ResolvedAppServerRequest`, calls `dismiss_resolved_request(request)`, and returns that boolean result.

**Call relations**: Invoked by the host when app-server requests resolve independently of local user action.

*Call graph*: calls 1 internal fn (dismiss_resolved_request).


##### `tests::test_sender`  (lines 1513–1519)

```
fn test_sender() -> (
        AppEventSender,
        tokio::sync::mpsc::UnboundedReceiver<AppEvent>,
    )
```

*Call graph*: calls 1 internal fn (new).


##### `tests::expect_interrupt_only`  (lines 1521–1531)

```
fn expect_interrupt_only(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>)
```

*Call graph*: 4 external calls (try_recv, assert!, assert_eq!, panic!).


##### `tests::question_with_options`  (lines 1533–1555)

```
fn question_with_options(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

*Call graph*: 1 external calls (vec!).


##### `tests::question_with_options_and_other`  (lines 1557–1579)

```
fn question_with_options_and_other(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

*Call graph*: 1 external calls (vec!).


##### `tests::question_with_wrapped_options`  (lines 1581–1609)

```
fn question_with_wrapped_options(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

*Call graph*: 1 external calls (vec!).


##### `tests::question_with_very_long_option_text`  (lines 1611–1629)

```
fn question_with_very_long_option_text(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

*Call graph*: 1 external calls (vec!).


##### `tests::question_with_long_scroll_options`  (lines 1631–1660)

```
fn question_with_long_scroll_options(id: &str, header: &str) -> ToolRequestUserInputQuestion
```

*Call graph*: 1 external calls (vec!).


##### `tests::question_without_options`  (lines 1662–1671)

```
fn question_without_options(id: &str, header: &str) -> ToolRequestUserInputQuestion
```


##### `tests::request_event`  (lines 1673–1684)

```
fn request_event(
        turn_id: &str,
        questions: Vec<ToolRequestUserInputQuestion>,
    ) -> ToolRequestUserInputParams
```


##### `tests::request_event_with_auto_resolution`  (lines 1686–1693)

```
fn request_event_with_auto_resolution(
        turn_id: &str,
        questions: Vec<ToolRequestUserInputQuestion>,
    ) -> ToolRequestUserInputParams
```

*Call graph*: 1 external calls (request_event).


##### `tests::snapshot_buffer`  (lines 1695–1705)

```
fn snapshot_buffer(buf: &Buffer) -> String
```

*Call graph*: 3 external calls (area, new, new).


##### `tests::render_snapshot`  (lines 1707–1709)

```
fn render_snapshot(overlay: &RequestUserInputOverlay, area: Rect) -> String
```

*Call graph*: 2 external calls (now, render_snapshot_at).


##### `tests::render_snapshot_at`  (lines 1711–1715)

```
fn render_snapshot_at(overlay: &RequestUserInputOverlay, area: Rect, now: Instant) -> String
```

*Call graph*: 3 external calls (empty, render_ui_at, snapshot_buffer).


##### `tests::queued_requests_are_fifo`  (lines 1718–1741)

```
fn queued_requests_are_fifo()
```

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, request_event, test_sender, vec!).


##### `tests::interrupt_discards_queued_requests_and_emits_interrupt`  (lines 1744–1772)

```
fn interrupt_discards_queued_requests_and_emits_interrupt()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, expect_interrupt_only, request_event, test_sender, vec!).


##### `tests::auto_resolution_absent_has_no_timer`  (lines 1775–1792)

```
fn auto_resolution_absent_has_no_timer()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (now, assert_eq!, request_event, test_sender, vec!).


##### `tests::auto_resolution_hides_timer_during_grace_period`  (lines 1795–1823)

```
fn auto_resolution_hides_timer_during_grace_period()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (now, assert!, assert_eq!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::auto_resolution_visible_countdown_snapshot`  (lines 1826–1849)

```
fn auto_resolution_visible_countdown_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (now, assert_snapshot!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::auto_resolution_visible_countdown_is_red`  (lines 1852–1889)

```
fn auto_resolution_visible_countdown_is_red()
```

*Call graph*: calls 1 internal fn (new); 9 external calls (empty, now, new, assert_eq!, assert_ne!, request_event_with_auto_resolution, snapshot_buffer, test_sender, vec!).


##### `tests::auto_resolution_expiry_emits_empty_answer`  (lines 1892–1923)

```
fn auto_resolution_expiry_emits_empty_answer()
```

*Call graph*: calls 1 internal fn (new); 7 external calls (now, assert!, assert_eq!, panic!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::auto_resolution_key_interaction_snoozes_timer`  (lines 1926–1950)

```
fn auto_resolution_key_interaction_snoozes_timer()
```

*Call graph*: calls 1 internal fn (new); 7 external calls (now, from, assert!, assert_eq!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::auto_resolution_paste_interaction_snoozes_timer`  (lines 1953–1977)

```
fn auto_resolution_paste_interaction_snoozes_timer()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (now, assert!, assert_eq!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::auto_resolution_resets_for_queued_request`  (lines 1980–2012)

```
fn auto_resolution_resets_for_queued_request()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (now, assert!, assert_eq!, request_event_with_auto_resolution, test_sender, vec!).


##### `tests::resolved_request_dismisses_overlay_without_emitting_events`  (lines 2015–2041)

```
fn resolved_request_dismisses_overlay_without_emitting_events()
```

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, test_sender, vec!).


##### `tests::resolved_current_request_advances_to_next_same_turn_prompt`  (lines 2044–2081)

```
fn resolved_current_request_advances_to_next_same_turn_prompt()
```

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, test_sender, vec!).


##### `tests::resolved_queued_request_removes_only_that_prompt`  (lines 2084–2136)

```
fn resolved_queued_request_removes_only_that_prompt()
```

*Call graph*: calls 1 internal fn (new); 4 external calls (assert!, assert_eq!, test_sender, vec!).


##### `tests::options_can_submit_empty_when_unanswered`  (lines 2139–2158)

```
fn options_can_submit_empty_when_unanswered()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::enter_commits_default_selection_on_last_option_question`  (lines 2161–2179)

```
fn enter_commits_default_selection_on_last_option_question()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::enter_commits_default_selection_on_non_last_option_question`  (lines 2182–2227)

```
fn enter_commits_default_selection_on_non_last_option_question()
```

*Call graph*: calls 1 internal fn (new); 8 external calls (new, from, assert!, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::number_keys_select_and_submit_options`  (lines 2230–2248)

```
fn number_keys_select_and_submit_options()
```

*Call graph*: calls 1 internal fn (new); 7 external calls (Char, from, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::vim_keys_move_option_selection`  (lines 2251–2270)

```
fn vim_keys_move_option_selection()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (Char, from, assert_eq!, request_event, test_sender, vec!).


##### `tests::typing_in_options_does_not_open_notes`  (lines 2273–2296)

```
fn typing_in_options_does_not_open_notes()
```

*Call graph*: calls 1 internal fn (new); 7 external calls (Char, from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::h_l_move_between_questions_in_options`  (lines 2299–2320)

```
fn h_l_move_between_questions_in_options()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (Char, from, assert_eq!, request_event, test_sender, vec!).


##### `tests::left_right_move_between_questions_in_options`  (lines 2323–2344)

```
fn left_right_move_between_questions_in_options()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (from, assert_eq!, request_event, test_sender, vec!).


##### `tests::horizontal_list_keys_move_between_questions_in_options`  (lines 2347–2368)

```
fn horizontal_list_keys_move_between_questions_in_options()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (Char, new, assert_eq!, request_event, test_sender, vec!).


##### `tests::options_notes_focus_hides_question_navigation_tip`  (lines 2371–2405)

```
fn options_notes_focus_hides_question_navigation_tip()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (from, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_shows_ctrl_p_and_ctrl_n_question_navigation_tip`  (lines 2408–2435)

```
fn freeform_shows_ctrl_p_and_ctrl_n_question_navigation_tip()
```

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_footer_shows_configured_submit_binding`  (lines 2438–2457)

```
fn freeform_footer_shows_configured_submit_binding()
```

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 4 external calls (assert_eq!, request_event, test_sender, vec!).


##### `tests::request_user_input_uses_remapped_interrupt_binding_while_notes_are_visible`  (lines 2460–2491)

```
fn request_user_input_uses_remapped_interrupt_binding_while_notes_are_visible()
```

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 7 external calls (F, from, assert_eq!, expect_interrupt_only, request_event, test_sender, vec!).


##### `tests::tab_opens_notes_when_option_selected`  (lines 2494–2510)

```
fn tab_opens_notes_when_option_selected()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::switching_to_options_resets_notes_focus_when_notes_hidden`  (lines 2513–2534)

```
fn switching_to_options_resets_notes_focus_when_notes_hidden()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::switching_from_freeform_with_text_resets_focus_and_keeps_last_option_empty`  (lines 2537–2580)

```
fn switching_from_freeform_with_text_resets_focus_and_keeps_last_option_empty()
```

*Call graph*: calls 1 internal fn (new); 9 external calls (Char, from, new, assert!, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::esc_in_notes_mode_without_options_interrupts`  (lines 2583–2597)

```
fn esc_in_notes_mode_without_options_interrupts()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert_eq!, expect_interrupt_only, request_event, test_sender, vec!).


##### `tests::esc_in_options_mode_interrupts`  (lines 2600–2614)

```
fn esc_in_options_mode_interrupts()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert_eq!, expect_interrupt_only, request_event, test_sender, vec!).


##### `tests::esc_in_notes_mode_clears_notes_and_hides_ui`  (lines 2617–2642)

```
fn esc_in_notes_mode_clears_notes_and_hides_ui()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::esc_in_notes_mode_with_text_clears_notes_and_hides_ui`  (lines 2645–2671)

```
fn esc_in_notes_mode_with_text_clears_notes_and_hides_ui()
```

*Call graph*: calls 1 internal fn (new); 7 external calls (Char, from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::esc_drops_committed_answers`  (lines 2674–2699)

```
fn esc_drops_committed_answers()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, expect_interrupt_only, request_event, test_sender, vec!).


##### `tests::backspace_in_options_clears_selection`  (lines 2702–2720)

```
fn backspace_in_options_clears_selection()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::backspace_on_empty_notes_closes_notes_ui`  (lines 2723–2746)

```
fn backspace_on_empty_notes_closes_notes_ui()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::tab_in_notes_clears_notes_and_hides_ui`  (lines 2749–2775)

```
fn tab_in_notes_clears_notes_and_hides_ui()
```

*Call graph*: calls 1 internal fn (new); 7 external calls (from, new, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::skipped_option_questions_count_as_unanswered`  (lines 2778–2789)

```
fn skipped_option_questions_count_as_unanswered()
```

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, request_event, test_sender, vec!).


##### `tests::highlighted_option_questions_are_unanswered`  (lines 2792–2805)

```
fn highlighted_option_questions_are_unanswered()
```

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_requires_enter_with_text_to_mark_answered`  (lines 2808–2834)

```
fn freeform_requires_enter_with_text_to_mark_answered()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, new, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_enter_with_empty_text_is_unanswered`  (lines 2837–2857)

```
fn freeform_enter_with_empty_text_is_unanswered()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (from, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_shift_enter_inserts_newline_without_advancing`  (lines 2860–2886)

```
fn freeform_shift_enter_inserts_newline_without_advancing()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_uses_configured_composer_submit_binding`  (lines 2889–2917)

```
fn freeform_uses_configured_composer_submit_binding()
```

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 7 external calls (Char, new, new, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_submit_binding_wins_over_question_navigation`  (lines 2920–2948)

```
fn freeform_submit_binding_wins_over_question_navigation()
```

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 7 external calls (Char, new, new, assert_eq!, request_event, test_sender, vec!).


##### `tests::freeform_questions_submit_empty_when_empty`  (lines 2951–2969)

```
fn freeform_questions_submit_empty_when_empty()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::freeform_draft_is_not_submitted_without_enter`  (lines 2972–2994)

```
fn freeform_draft_is_not_submitted_without_enter()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (new, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::freeform_commit_resets_when_draft_changes`  (lines 2997–3037)

```
fn freeform_commit_resets_when_draft_changes()
```

*Call graph*: calls 1 internal fn (new); 7 external calls (from, new, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::notes_are_captured_for_selected_option`  (lines 3040–3079)

```
fn notes_are_captured_for_selected_option()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (new, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::notes_submission_commits_selected_option`  (lines 3082–3111)

```
fn notes_submission_commits_selected_option()
```

*Call graph*: calls 1 internal fn (new); 7 external calls (from, new, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::is_other_adds_none_of_the_above_and_submits_it`  (lines 3114–3164)

```
fn is_other_adds_none_of_the_above_and_submits_it()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (new, assert_eq!, panic!, request_event, test_sender, vec!).


##### `tests::large_paste_is_preserved_when_switching_questions`  (lines 3167–3192)

```
fn large_paste_is_preserved_when_switching_questions()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::pending_paste_placeholder_survives_submission_and_back_navigation`  (lines 3195–3223)

```
fn pending_paste_placeholder_survives_submission_and_back_navigation()
```

*Call graph*: calls 1 internal fn (new); 8 external calls (Char, from, new, assert!, assert_eq!, request_event, test_sender, vec!).


##### `tests::request_user_input_options_snapshot`  (lines 3226–3240)

```
fn request_user_input_options_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_options_notes_visible_snapshot`  (lines 3243–3263)

```
fn request_user_input_options_notes_visible_snapshot()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (from, new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_tight_height_snapshot`  (lines 3266–3280)

```
fn request_user_input_tight_height_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::layout_allocates_all_wrapped_options_when_space_allows`  (lines 3283–3308)

```
fn layout_allocates_all_wrapped_options_when_space_allows()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_eq!, request_event, test_sender, vec!).


##### `tests::desired_height_keeps_spacers_and_preferred_options_visible`  (lines 3311–3337)

```
fn desired_height_keeps_spacers_and_preferred_options_visible()
```

*Call graph*: calls 2 internal fn (new, menu_surface_inset); 5 external calls (new, assert_eq!, request_event, test_sender, vec!).


##### `tests::footer_wraps_tips_without_splitting_individual_tips`  (lines 3340–3374)

```
fn footer_wraps_tips_without_splitting_individual_tips()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (width, assert!, request_event, test_sender, vec!).


##### `tests::request_user_input_wrapped_options_snapshot`  (lines 3377–3407)

```
fn request_user_input_wrapped_options_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_long_option_text_snapshot`  (lines 3410–3427)

```
fn request_user_input_long_option_text_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::selected_long_wrapped_option_stays_visible`  (lines 3430–3450)

```
fn selected_long_wrapped_option_stays_visible()
```

*Call graph*: calls 1 internal fn (new); 6 external calls (new, assert!, render_snapshot, request_event, test_sender, vec!).


##### `tests::request_user_input_footer_wrap_snapshot`  (lines 3453–3478)

```
fn request_user_input_footer_wrap_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_scroll_options_snapshot`  (lines 3481–3530)

```
fn request_user_input_scroll_options_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_hidden_options_footer_snapshot`  (lines 3533–3582)

```
fn request_user_input_hidden_options_footer_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_freeform_snapshot`  (lines 3585–3599)

```
fn request_user_input_freeform_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_freeform_remapped_submit_snapshot`  (lines 3602–3619)

```
fn request_user_input_freeform_remapped_submit_snapshot()
```

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_freeform_remapped_interrupt_snapshot`  (lines 3622–3639)

```
fn request_user_input_freeform_remapped_interrupt_snapshot()
```

*Call graph*: calls 2 internal fn (new_with_keymap, defaults); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_multi_question_first_snapshot`  (lines 3642–3662)

```
fn request_user_input_multi_question_first_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_multi_question_last_snapshot`  (lines 3665–3686)

```
fn request_user_input_multi_question_last_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::request_user_input_unanswered_confirmation_snapshot`  (lines 3689–3712)

```
fn request_user_input_unanswered_confirmation_snapshot()
```

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_snapshot!, request_event, test_sender, vec!).


##### `tests::options_scroll_while_editing_notes`  (lines 3715–3736)

```
fn options_scroll_while_editing_notes()
```

*Call graph*: calls 1 internal fn (new); 7 external calls (from, new, assert!, assert_eq!, request_event, test_sender, vec!).


### `tui/src/bottom_pane/pending_thread_approvals.rs`

`domain_logic` · `rendering`

This file defines `PendingThreadApprovals`, a minimal stateful widget whose only persistent data is a `Vec<String>` of thread labels. The public API is intentionally small: `new` starts empty, `set_threads` replaces the list and reports whether anything changed, `is_empty` exposes whether there is anything to render, and a test-only `threads` accessor allows assertions on stored state.

The actual presentation logic lives in `as_renderable`. If there are no threads or the width is too narrow, it returns an empty renderable. Otherwise it builds a list of lines for up to the first three threads. Each thread becomes wrapped text of the form `Approval needed in {thread}`, rendered through `adaptive_wrap_lines` with an initial indent containing a red bold `!` marker and a plain two-space prefix, plus a four-space subsequent indent for wrapped continuations. If more than three threads exist, the widget appends a dim italic `...` line to indicate truncation. It always ends with a dim hint line containing a bold cyan `/agent` command followed by `to switch threads`. The `Renderable` implementation simply delegates both sizing and drawing to the boxed paragraph returned by `as_renderable`, ensuring height calculations and actual rendering stay in sync.

#### Function details

##### `PendingThreadApprovals::new`  (lines 17–21)

```
fn new() -> Self
```

**Purpose**: Creates an empty approvals widget with no tracked threads. It is the default starting state before any approval data arrives.

**Data flow**: Constructs `PendingThreadApprovals { threads: Vec::new() }` and returns it.

**Call relations**: Used by production setup and tests before thread names are injected.

*Call graph*: called by 4 (new, desired_height_empty, render_multiple_threads_snapshot, render_single_thread_snapshot); 1 external calls (new).


##### `PendingThreadApprovals::set_threads`  (lines 23–29)

```
fn set_threads(&mut self, threads: Vec<String>) -> bool
```

**Purpose**: Replaces the stored thread list and reports whether the value actually changed. This lets callers avoid unnecessary redraw work when the list is unchanged.

**Data flow**: Takes a new `Vec<String>`, compares it to `self.threads`, returns `false` immediately if equal, otherwise assigns the new vector into `self.threads` and returns `true`.

**Call relations**: Called by higher-level state synchronization code when pending approvals are recomputed.

*Call graph*: called by 1 (set_pending_thread_approvals).


##### `PendingThreadApprovals::is_empty`  (lines 31–33)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether there are any pending approval threads to show. It is a lightweight visibility check.

**Data flow**: Returns `self.threads.is_empty()`.

**Call relations**: Used by surrounding layout code to decide whether to reserve space for this widget.

*Call graph*: called by 1 (as_renderable_with_composer_right_reserve).


##### `PendingThreadApprovals::threads`  (lines 36–38)

```
fn threads(&self) -> &[String]
```

**Purpose**: Exposes the stored thread slice for tests. It allows assertions without rendering.

**Data flow**: Returns `&self.threads`.

**Call relations**: Only compiled in tests and used by test helpers or assertions.

*Call graph*: called by 1 (pending_thread_approvals).


##### `PendingThreadApprovals::as_renderable`  (lines 40–70)

```
fn as_renderable(&self, width: u16) -> Box<dyn Renderable>
```

**Purpose**: Builds the visible approval-warning paragraph or an empty renderable depending on content and width. It contains all truncation, wrapping, and styling rules for the widget.

**Data flow**: Reads `self.threads` and `width`. If there are no threads or width is under 4, returns `Box::new(())`. Otherwise it creates a `Vec<Line>`, iterates over at most the first three thread names, wraps `Approval needed in {thread}` with `adaptive_wrap_lines` using an initial indent of `  ! ` where `!` is red and bold and a subsequent indent of four spaces, and extends the line list with each wrapped result. If more than three threads exist, it appends a dim italic `    ...` line. Finally it appends a dim line containing bold cyan `/agent` followed by ` to switch threads`, wraps the lines in `Paragraph::new(lines).into()`, and returns it boxed.

**Call relations**: Shared by `render` and `desired_height`, making it the single formatting source for the widget.

*Call graph*: calls 2 internal fn (new, adaptive_wrap_lines); called by 2 (desired_height, render); 7 external calls (new, from, new, new, format!, once, vec!).


##### `PendingThreadApprovals::render`  (lines 74–80)

```
fn render(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the approvals widget into the target buffer when the area is non-empty. It delegates content generation to `as_renderable`.

**Data flow**: Takes `area` and mutable `buf`, returns early if `area.is_empty()`, otherwise constructs `as_renderable(area.width)` and renders it into the area.

**Call relations**: Called by the UI framework and by the snapshot helper in tests.

*Call graph*: calls 1 internal fn (as_renderable); called by 1 (snapshot_rows); 1 external calls (is_empty).


##### `PendingThreadApprovals::desired_height`  (lines 82–84)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Computes the widget's height by asking the generated renderable for its desired height. This keeps layout and rendering consistent.

**Data flow**: Takes `width`, builds the boxed renderable with `as_renderable(width)`, and returns its `desired_height(width)`.

**Call relations**: Used by layout code and tests before allocating render space.

*Call graph*: calls 1 internal fn (as_renderable); called by 1 (snapshot_rows).


##### `tests::snapshot_rows`  (lines 93–106)

```
fn snapshot_rows(widget: &PendingThreadApprovals, width: u16) -> String
```

**Purpose**: Renders the widget into a buffer and converts the visible rows into a newline-joined plain string for snapshot assertions. It is a test utility for stable textual snapshots.

**Data flow**: Takes a widget reference and width, computes height via `desired_height`, renders into a fresh `Buffer`, then iterates over every cell row-by-row collecting the first character of each symbol into strings and joins those rows with `\n`.

**Call relations**: Shared helper for the snapshot tests in this module.

*Call graph*: calls 2 internal fn (desired_height, render); 2 external calls (empty, new).


##### `tests::desired_height_empty`  (lines 109–112)

```
fn desired_height_empty()
```

**Purpose**: Verifies that an empty approvals widget takes zero height. This confirms the empty-renderable path.

**Data flow**: Creates a new widget and asserts `desired_height(40) == 0`.

**Call relations**: Exercises `new` and `desired_height` on the no-content case.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::render_single_thread_snapshot`  (lines 115–126)

```
fn render_single_thread_snapshot()
```

**Purpose**: Snapshots rendering for one pending approval thread. It validates the warning marker and `/agent` hint formatting.

**Data flow**: Creates a widget, sets one thread, renders through `snapshot_rows`, replaces spaces with dots for readability, and snapshots the resulting string.

**Call relations**: Covers the single-thread branch of `as_renderable`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_snapshot!, vec!).


##### `tests::render_multiple_threads_snapshot`  (lines 129–148)

```
fn render_multiple_threads_snapshot()
```

**Purpose**: Snapshots rendering when more than three threads exist. It verifies truncation to three visible entries plus the trailing ellipsis and hint line.

**Data flow**: Creates a widget, sets four thread names, renders through `snapshot_rows` at width 44, normalizes spaces to dots, and snapshots the output.

**Call relations**: Exercises the truncation branch in `as_renderable`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_snapshot!, vec!).


### Chat widget approval flows
These chat-widget modules turn approval events into concrete popup flows, permission selection, sandbox prompts, and transcript-visible request handling.

### `tui/src/chatwidget/permission_popups.rs`

`orchestration` · `interactive permission/approval configuration and confirmation flows`

This file owns the generic permission-selection UI for the chat widget. `open_approvals_popup` is just an alias into `open_permissions_popup`, which branches between the legacy preset picker and the newer explicit profile picker depending on `config.explicit_permission_profile_mode`.

The main popup enumerates `builtin_approval_presets()` and turns them into `SelectionItem`s. It computes current state from the configured approval policy, permission profile, reviewer mode, feature flags, and—on Windows—the sandbox level. Several details are easy to miss: the read-only preset is hidden off Windows, the `auto` preset label changes when Windows is using a degraded non-admin sandbox, and disabled reasons are computed separately for approval-policy constraints and Guardian Approval feature mutability. The `auto` preset may produce two rows: normal user approvals and “Approve for me” auto-review when the feature is enabled.

`permission_mode_actions` is the key dispatcher. It either returns direct preset/profile actions, redirects full-access selections into a confirmation popup when the warning has not been acknowledged, or on Windows routes Agent mode through sandbox-enablement or world-writable warnings before applying anything. `approval_preset_actions` emits the concrete `AppEvent`s that override turn context, update approval policy/profile/reviewer state, and insert a history info cell.

The file also includes a popup for recent auto-review denials, allowing one-click approval of a denied action retry, and a dedicated full-access confirmation surface with “continue”, “continue and remember”, and cancel paths. `preset_matches_current` contains the nuanced matching logic for synthetic presets like read-only and auto, comparing filesystem/network sandbox behavior rather than only raw profile equality.

#### Function details

##### `ChatWidget::open_approvals_popup`  (lines 11–13)

```
fn open_approvals_popup(&mut self)
```

**Purpose**: Provides the approvals command entrypoint by forwarding directly to the permissions popup.

**Data flow**: It takes no extra input, reads no additional state beyond `self`, calls `open_permissions_popup`, and returns no value.

**Call relations**: This is a thin alias used where the UI or command vocabulary says “approvals” but the underlying flow is the permissions picker implemented by `ChatWidget::open_permissions_popup`.

*Call graph*: calls 1 internal fn (open_permissions_popup).


##### `ChatWidget::open_permissions_popup`  (lines 16–160)

```
fn open_permissions_popup(&mut self)
```

**Purpose**: Builds and shows the main permissions-mode picker, including built-in presets, optional auto-review rows, disabled reasons, and Windows-specific sandbox hints.

**Data flow**: It reads configuration fields for explicit profile mode, approval policy, permission profile, Guardian Approval enablement, reviewer mode, current cwd, feature mutability, and on Windows sandbox level. It may delegate immediately to `open_permission_profiles_popup`; otherwise it iterates `builtin_approval_presets()`, filters read-only off non-Windows, computes labels/descriptions/current-state flags with `preset_matches_current`, obtains row actions from `permission_mode_actions`, optionally adds a footer note about upgrading the Windows sandbox, and writes a `SelectionViewParams` into `self.bottom_pane`.

**Call relations**: This is the main popup constructor reached from `ChatWidget::open_approvals_popup`. It delegates row behavior to `ChatWidget::permission_mode_actions` and current-state detection to `ChatWidget::preset_matches_current`.

*Call graph*: calls 3 internal fn (from, permission_mode_actions, level_from_config); called by 1 (open_approvals_popup); 7 external calls (new, default, preset_matches_current, new, cfg!, format!, matches!).


##### `ChatWidget::open_auto_review_denials_popup`  (lines 162–220)

```
fn open_auto_review_denials_popup(&mut self)
```

**Purpose**: Shows a searchable list of recent auto-review denials in the current thread so the user can approve one for a retry.

**Data flow**: It reads `self.review.recent_auto_review_denials` and the current thread ID. If there are no denials it adds an info message; if the thread is unavailable it adds an error message. Otherwise it builds a header row plus one `SelectionItem` per denial using the denial’s action summary and rationale, with actions that send `AppEvent::ApproveRecentAutoReviewDenial { thread_id, id }`, then writes the searchable selection view to `self.bottom_pane` and requests redraw.

**Call relations**: This popup is a side flow for reviewing Guardian auto-review outcomes. Its selection actions eventually lead to `ChatWidget::approve_recent_auto_review_denial`.

*Call graph*: 2 external calls (default, vec!).


##### `ChatWidget::approve_recent_auto_review_denial`  (lines 222–239)

```
fn approve_recent_auto_review_denial(&mut self, thread_id: ThreadId, id: String)
```

**Purpose**: Consumes a stored auto-review denial event and submits a thread operation approving one retry of that denied action.

**Data flow**: It takes a `ThreadId` and denial ID string, removes the matching event from `self.review.recent_auto_review_denials`, and if absent adds an error message. When present, it sends `AppEvent::SubmitThreadOp` with `AppCommand::approve_guardian_denied_action(event)` and adds an informational message explaining that the retry still passes through auto-review.

**Call relations**: This function is the execution side of the denial popup. It is reached after the user selects a denial row created by `ChatWidget::open_auto_review_denials_popup`.

*Call graph*: 1 external calls (approve_guardian_denied_action).


##### `ChatWidget::approval_preset_actions`  (lines 241–275)

```
fn approval_preset_actions(
        approval: AskForApproval,
        permission_profile: PermissionProfile,
        active_permission_profile: ActivePermissionProfile,
        label: String,
```

**Purpose**: Creates the concrete action closure that applies a built-in approval preset and records the change in history.

**Data flow**: It takes an `AskForApproval`, a `PermissionProfile`, an `ActivePermissionProfile`, a display label, and an `ApprovalsReviewer`. It returns a one-element action vector whose closure sends a `CodexOp` overriding turn context, updates the approval policy, active permission profile, and reviewer in widget/app state, and inserts an informational history cell announcing the new label.

**Call relations**: This helper is used by `ChatWidget::permission_mode_actions` and `ChatWidget::open_full_access_confirmation` when a selection should directly apply a built-in preset rather than route through profile selection.

*Call graph*: 1 external calls (vec!).


##### `ChatWidget::permission_profile_selection_actions`  (lines 277–283)

```
fn permission_profile_selection_actions(
        selection: PermissionProfileSelection,
    ) -> Vec<SelectionAction>
```

**Purpose**: Creates the action closure that selects an explicit permission profile by sending a single app event.

**Data flow**: It takes a `PermissionProfileSelection`, captures it in a closure, and returns a one-element action vector that sends `AppEvent::SelectPermissionProfile(selection.clone())`.

**Call relations**: This helper is used when the UI is operating in explicit profile-selection mode, either from `ChatWidget::permission_mode_actions` or from the profile-menu helpers in the neighboring file.

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

**Purpose**: Chooses the correct action path for a permission preset: direct apply, explicit profile selection, full-access confirmation, or Windows-specific sandbox/world-writable warning prompts.

**Data flow**: It reads the selected `ApprovalPreset`, label, reviewer mode, optional `PermissionProfileSelection`, and `return_to_permissions` flag plus widget config such as full-access warning acknowledgment and Windows sandbox state. It either returns direct actions from `approval_preset_actions`/`permission_profile_selection_actions`, or returns closures that send `OpenFullAccessConfirmation`, `EnableWindowsSandboxForAgentMode`, `OpenWindowsSandboxEnablePrompt`, or `OpenWorldWritableWarningConfirmation` depending on the preset and platform conditions.

**Call relations**: This dispatcher is called by `ChatWidget::open_permissions_popup` for each row and by the profile-menu code for built-in profile items. It centralizes all branching before a permission change is actually applied.

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

**Purpose**: Determines whether a built-in approval preset should be marked as the current selection based on the active approval policy and effective sandbox behavior.

**Data flow**: It takes the current `AskForApproval`, current `PermissionProfile`, current cwd, and a preset. It first compares approval policies, then for `full-access`, `read-only`, and `auto` performs specialized checks against filesystem and network sandbox policies—such as whether cwd is writable, whether full-disk write access exists, and whether writable roots are empty—falling back to direct profile equality for other presets. It returns a boolean.

**Call relations**: This helper is used by `ChatWidget::open_permissions_popup` to mark rows current. Its special-case logic is what lets synthetic presets match behaviorally equivalent managed profiles.

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

**Purpose**: Shows a warning popup before enabling full access, with options to proceed once, proceed and remember the acknowledgment, or cancel back to the previous permissions surface.

**Data flow**: It takes an `ApprovalPreset`, a `return_to_permissions` flag, and an optional `PermissionProfileSelection`. It builds a rich header with a red warning paragraph, constructs accept actions either from `approval_preset_actions` or `permission_profile_selection_actions`, appends acknowledgment update/persist events, builds a cancel action that reopens either permissions or approvals, and writes the resulting `SelectionViewParams` into `self.bottom_pane`.

**Call relations**: This confirmation popup is opened by `ChatWidget::permission_mode_actions` when the user selects the `full-access` preset under normal user-review mode and the warning has not been suppressed.

*Call graph*: calls 2 internal fn (from, with); 6 external calls (new, default, from, new, new, vec!).


### `tui/src/chatwidget/permissions_menu.rs`

`orchestration` · `interactive permission-profile selection`

This file is the profile-oriented counterpart to `permission_popups.rs`. `open_permission_profiles_popup` assembles a unified selection list containing built-in profiles mapped onto stable IDs (`:workspace`, `:danger-no-sandbox`, `:read-only`) plus any custom permission profiles from configuration. It first resolves the currently active profile ID from `config.permissions.active_permission_profile()`, then looks up the required built-in presets by ID and emits explicit error messages if any expected preset is missing—treating that as an internal consistency failure rather than silently degrading.

Built-in rows are created through `builtin_permission_mode_selection_item`, which derives the visible label from both preset ID and reviewer mode, computes whether the row is current by comparing active profile ID, approval policy, and reviewer, and packages a `PermissionProfileSelection` that can be routed through the generic permission action machinery. Disabled reasons are computed from both approval-policy mutability and whether the target permission profile itself is allowed by config constraints.

Custom rows are simpler: `permission_profile_selection_item` creates a `PermissionProfileSelection` with no explicit approval-policy or reviewer override, marks the row current when its ID matches the active profile, and wires it to `permission_profile_selection_actions`. The resulting popup uses the standard selection-view shell and popup hint line, but leaves the header empty because the row labels and descriptions carry the important information.

#### Function details

##### `ChatWidget::open_permission_profiles_popup`  (lines 4–87)

```
fn open_permission_profiles_popup(&mut self)
```

**Purpose**: Builds and shows the explicit permission-profile picker containing built-in workspace/full-access/read-only modes plus configured custom profiles.

**Data flow**: It reads the active profile ID from config, fetches `builtin_approval_presets()`, validates that `read-only`, `auto`, and `full-access` presets exist, emits error messages and returns if any are missing, then builds a `Vec<SelectionItem>` from `builtin_permission_mode_selection_item` and `permission_profile_selection_item` for custom profiles. Finally it writes the assembled `SelectionViewParams` into `self.bottom_pane`.

**Call relations**: This popup is opened from `ChatWidget::open_permissions_popup` when `config.explicit_permission_profile_mode` is enabled. It delegates row construction to the two helper functions in this file.

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

**Purpose**: Creates one selection row for a built-in permission mode, including current-state detection, disabled reasons, and the action payload needed to apply or confirm it.

**Data flow**: It takes a preset, synthetic profile ID, description, approval policy, and reviewer mode. It reads the active profile ID, current approval policy, and current reviewer from config, constructs a `PermissionProfileSelection`, computes `is_current`, obtains actions from `self.permission_mode_actions(...)`, computes disabled reasons from approval-policy and permission-profile `can_set` checks, and returns a populated `SelectionItem`.

**Call relations**: This helper is called repeatedly by `ChatWidget::open_permission_profiles_popup` for the built-in workspace, auto-review, full-access, and read-only rows.

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

**Purpose**: Creates a selection row for a custom permission profile that simply selects that profile without overriding approval policy or reviewer.

**Data flow**: It takes a label, profile ID, description, and optional active profile ID. It builds a `PermissionProfileSelection` with `approval_policy` and `approvals_reviewer` set to `None`, marks the row current when `active_profile_id == Some(id)`, wires actions from `permission_profile_selection_actions`, and returns the resulting `SelectionItem`.

**Call relations**: This helper is used by `ChatWidget::open_permission_profiles_popup` when appending custom profiles from `config.custom_permission_profiles`.

*Call graph*: 2 external calls (default, permission_profile_selection_actions).


### `tui/src/chatwidget/windows_sandbox_prompts.rs`

`orchestration` · `interactive prompt handling and Windows sandbox setup transitions`

This file extends `ChatWidget` with Windows sandbox UX logic guarded by `cfg(target_os = "windows")` or test builds, while providing inert no-op stubs on other platforms so the rest of the widget can call these methods unconditionally. The smallest checks are policy-oriented: `windows_sandbox_mode_allowed` asks the layered config requirements whether a requested `WindowsSandboxModeToml` can be set, and `elevated_windows_sandbox_setup_required` combines the effective sandbox level, whether the mode came from an explicit config source, and whether setup artifacts exist under `codex_home`.

The warning path for world-writable directories computes effective workspace roots, current working directory, environment variables, and the effective permission profile, then asks `codex_windows_sandbox` to resolve permissions and run a scan. A failed scan is surfaced distinctly from a successful scan that found no issue. `open_world_writable_warning_confirmation` then constructs a `SelectionView` with explanatory `Paragraph` content, optional sample paths, and two action bundles: continue once, or continue and persist acknowledgement. A subtle invariant is that acknowledgement events are queued before permission-profile-changing actions so downstream hooks do not immediately re-open the same warning.

The enable/fallback prompts are similar popup builders with telemetry counters and `AppEvent` closures for elevated setup, unelevated legacy setup, retry, or quit. If policy requires a choice, canceling the popup reopens it via `on_cancel`. Finally, setup status methods temporarily disable composer input, show/hide status indicators, and force redraws so the user cannot queue messages while sandbox mode is changing.

#### Function details

##### `ChatWidget::windows_sandbox_mode_allowed`  (lines 7–14)

```
fn windows_sandbox_mode_allowed(&self, mode: WindowsSandboxModeToml) -> bool
```

**Purpose**: Checks whether the current layered configuration requirements permit switching to a specific `WindowsSandboxModeToml`. It is a pure policy query used to decide whether the UI may offer the unelevated fallback path.

**Data flow**: `self` supplies `config.config_layer_stack.requirements().windows_sandbox_mode`; the `mode` argument is wrapped as `Some(mode)` and passed to `can_set`. The function converts the result into a boolean by returning `true` only when the requirement check is `Ok`.

**Call relations**: This method is consulted while building both the initial enable prompt and the fallback prompt. Those callers use the boolean to decide whether to include a non-admin sandbox option and whether dismissing the popup should be treated as invalid because setup is mandatory.

*Call graph*: called by 2 (open_windows_sandbox_enable_prompt, open_windows_sandbox_fallback_prompt).


##### `ChatWidget::elevated_windows_sandbox_setup_required`  (lines 17–27)

```
fn elevated_windows_sandbox_setup_required(&self) -> bool
```

**Purpose**: Determines whether the configured Windows sandbox mode specifically requires elevated setup work that has not yet been completed. It encodes the exact condition under which the UI must keep prompting for setup rather than assuming the sandbox is ready.

**Data flow**: It reads the effective sandbox level via `crate::windows_sandbox::level_from_config(&self.config)`, checks that the requirements source for `windows_sandbox_mode` is present, and probes `crate::windows_sandbox::sandbox_setup_is_complete` using `self.config.codex_home`. It returns `true` only when the level is `WindowsSandboxLevel::Elevated`, the mode was explicitly sourced, and setup completion is currently false.

**Call relations**: This predicate is reused by the enable prompt, fallback prompt, and the opportunistic `maybe_prompt_windows_sandbox_enable` gate. Those callers rely on it to distinguish a merely configured sandbox from one whose elevated installation steps still need user action.

*Call graph*: calls 1 internal fn (level_from_config); called by 3 (maybe_prompt_windows_sandbox_enable, open_windows_sandbox_enable_prompt, open_windows_sandbox_fallback_prompt); 1 external calls (sandbox_setup_is_complete).


##### `ChatWidget::world_writable_warning_details`  (lines 65–67)

```
fn world_writable_warning_details(&self) -> Option<(Vec<String>, usize, bool)>
```

**Purpose**: Computes whether the current Windows sandbox protections are undermined by world-writable paths and, if so, returns the warning payload shape expected by the confirmation popup. It also suppresses the warning entirely when the user has already chosen to hide it.

**Data flow**: The method first reads `self.config.notices.hide_world_writable_warning`; if set, it returns `None`. Otherwise it clones `cwd`, gathers effective workspace roots, snapshots the process environment with `std::env::vars().collect()` into a `HashMap<String, String>`, derives the effective permission profile, and attempts to build `ResolvedWindowsSandboxPermissions` for those roots. If permission resolution fails it returns `None`; if the subsequent world-writable scan succeeds it returns `None`; if the scan errors it returns `Some((Vec::new(), 0, true))`, using an empty sample list and `failed_scan = true` to indicate protections could not be verified.

**Call relations**: This method is a data-producing precursor for the warning confirmation flow. Its output is consumed by higher-level chat widget logic that decides whether to open `open_world_writable_warning_confirmation`, and the tuple fields directly drive that popup's explanatory text and sample-path section.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); 3 external calls (new, apply_world_writable_scan_and_denies_for_permissions, vars).


##### `ChatWidget::open_world_writable_warning_confirmation`  (lines 209–217)

```
fn open_world_writable_warning_confirmation(
        &mut self,
        _preset: Option<ApprovalPreset>,
        _profile_selection: Option<PermissionProfileSelection>,
        _sample_paths: Vec<Stri
```

**Purpose**: Builds and displays the popup that warns the user about world-writable folders or an incomplete scan before enabling a permission profile or approval preset. It translates the current or pending permission profile into user-facing mode labels and wires the popup buttons to acknowledgement and profile-change events.

**Data flow**: Inputs are an optional `ApprovalPreset`, optional `PermissionProfileSelection`, a `sample_paths` list, `extra_count`, and `failed_scan`. The function extracts `AskForApproval`, pending `PermissionProfile`, and active profile from the preset when present; derives a human-readable mode label by inspecting whether the profile is `Disabled`, writable in `cwd`, or effectively read-only; then assembles `Renderable` header content with one or more `Paragraph`s. It constructs two `Vec<SelectionAction>` pipelines: one for a one-time continue, and one that first sends `UpdateWorldWritableWarningAcknowledged(true)` and `PersistWorldWritableWarningAcknowledged` before applying the same profile-selection or approval-preset actions. If a preset is being applied, it also sends `SkipNextWorldWritableScan` to suppress an immediate duplicate warning. Finally it writes the popup into `self.bottom_pane.show_selection_view(...)` with two `SelectionItem`s and a standard footer hint.

**Call relations**: This method is the concrete UI endpoint for the world-writable warning path. It delegates profile-changing behavior to `Self::permission_profile_selection_actions` or `Self::approval_preset_actions` depending on whether the caller is changing permissions directly or applying a preset, and it is designed so those downstream policy-change hooks do not re-trigger the same warning before acknowledgement is recorded.

*Call graph*: calls 2 internal fn (from, with); 9 external calls (new, default, from, new, approval_preset_actions, permission_profile_selection_actions, new, format!, vec!).


##### `ChatWidget::open_windows_sandbox_enable_prompt`  (lines 328–333)

```
fn open_windows_sandbox_enable_prompt(
        &mut self,
        _preset: ApprovalPreset,
        _profile_selection: Option<PermissionProfileSelection>,
    )
```

**Purpose**: Shows the primary Windows sandbox setup prompt that asks the user to configure the default elevated sandbox, optionally choose the non-admin sandbox, or quit. It also records telemetry for prompt display and each user choice.

**Data flow**: It takes a required `ApprovalPreset` and optional `PermissionProfileSelection`, increments the `codex.windows_sandbox.elevated_prompt_shown` counter on `self.session_telemetry`, computes `allow_unelevated` and `setup_choice_is_required`, and builds a `ColumnRenderable` header with different explanatory text depending on policy. It then creates `SelectionItem`s whose closures clone telemetry and input state, emit counters for accept/legacy/quit, and send `AppEvent::BeginWindowsSandboxElevatedSetup`, `AppEvent::BeginWindowsSandboxLegacySetup`, or `AppEvent::Exit(ExitMode::ShutdownFirst)`. The popup is installed into `self.bottom_pane.show_selection_view`, and when setup is mandatory its `on_cancel` closure re-sends `AppEvent::OpenWindowsSandboxEnablePrompt` with the same preset and profile selection.

**Call relations**: This prompt is opened by `maybe_prompt_windows_sandbox_enable` when startup or a policy transition determines setup must happen now. Internally it depends on `windows_sandbox_mode_allowed` and `elevated_windows_sandbox_setup_required` to decide which choices are legal and whether cancel should loop back into the same prompt.

*Call graph*: calls 3 internal fn (elevated_windows_sandbox_setup_required, windows_sandbox_mode_allowed, new); called by 1 (maybe_prompt_windows_sandbox_enable); 5 external calls (new, default, new, clone, vec!).


##### `ChatWidget::open_windows_sandbox_fallback_prompt`  (lines 452–457)

```
fn open_windows_sandbox_fallback_prompt(
        &mut self,
        _preset: ApprovalPreset,
        _profile_selection: Option<PermissionProfileSelection>,
    )
```

**Purpose**: Shows the recovery prompt after elevated sandbox setup fails, offering retry, optional fallback to the non-admin sandbox, or quit. It mirrors the enable prompt but with failure-specific messaging and telemetry keys.

**Data flow**: The function receives an `ApprovalPreset` and optional `PermissionProfileSelection`, recomputes `allow_unelevated` and `setup_choice_is_required`, and builds a list of `line![]` messages headed by a bold failure sentence. It wraps those lines in a `Paragraph` inside a `ColumnRenderable`, then creates selection items whose closures emit fallback-specific telemetry counters and send `BeginWindowsSandboxElevatedSetup`, `BeginWindowsSandboxLegacySetup`, or `Exit(ShutdownFirst)`. As with the enable prompt, it writes the assembled `SelectionViewParams` to `self.bottom_pane`, and if setup remains mandatory it installs an `on_cancel` closure that reopens the fallback prompt.

**Call relations**: This method is used after an elevated setup attempt fails and the UI needs to keep the user in a constrained decision loop. Like the initial prompt, it relies on `windows_sandbox_mode_allowed` and `elevated_windows_sandbox_setup_required` to decide whether the legacy path is available and whether cancel should be converted into a retry prompt.

*Call graph*: calls 3 internal fn (elevated_windows_sandbox_setup_required, windows_sandbox_mode_allowed, new); 7 external calls (new, default, new, new, line!, clone, vec!).


##### `ChatWidget::maybe_prompt_windows_sandbox_enable`  (lines 475–475)

```
fn maybe_prompt_windows_sandbox_enable(&mut self, _show_now: bool)
```

**Purpose**: Conditionally opens the initial sandbox enable prompt when the current configuration indicates sandboxing is disabled or elevated setup is still incomplete. It is the lightweight gate that prevents the prompt from appearing unless the caller explicitly asks to show it now.

**Data flow**: It reads the effective level from `crate::windows_sandbox::level_from_config(&self.config)`, computes `setup_is_required` by comparing against `WindowsSandboxLevel::Disabled` and `self.elevated_windows_sandbox_setup_required()`, and checks the `show_now` flag. If all conditions hold, it searches `builtin_approval_presets()` for the preset whose `id` is `"auto"`; when found, it invokes `self.open_windows_sandbox_enable_prompt(preset, None)`.

**Call relations**: This method is the entry gate into the sandbox setup prompting flow. It delegates the actual UI construction to `open_windows_sandbox_enable_prompt` and uses `elevated_windows_sandbox_setup_required` to avoid prompting when elevated setup has already been completed.

*Call graph*: calls 3 internal fn (elevated_windows_sandbox_setup_required, open_windows_sandbox_enable_prompt, level_from_config).


##### `ChatWidget::show_windows_sandbox_setup_status`  (lines 499–499)

```
fn show_windows_sandbox_setup_status(&mut self)
```

**Purpose**: Switches the chat UI into a temporary setup-in-progress state while Windows sandbox installation runs. It prevents accidental message submission under an unexpected sandbox mode and surfaces a persistent status indicator.

**Data flow**: The method mutates `self.bottom_pane` to disable composer input with the placeholder `Input disabled until setup completes.`, ensures a status indicator exists, and hides the interrupt hint. It then calls `self.set_status(...)` with the title `Setting up sandbox...`, a secondary line `Hang tight, this may take a few minutes`, capitalization settings, and the default max-line limit, and finally requests a redraw.

**Call relations**: This is used during the active setup phase after the user has chosen a sandbox setup action. It does not delegate further business logic; instead it prepares the visible TUI state so asynchronous setup work elsewhere can proceed without conflicting user input.


##### `ChatWidget::clear_windows_sandbox_setup_status`  (lines 510–510)

```
fn clear_windows_sandbox_setup_status(&mut self)
```

**Purpose**: Restores normal chat input and removes the setup status indicator after sandbox setup finishes or aborts. It is the inverse of the setup-in-progress UI state.

**Data flow**: It re-enables composer input on `self.bottom_pane` with no placeholder, hides the status indicator, and requests a redraw. No value is returned.

**Call relations**: This method is called when the setup flow exits and the widget should return to ordinary interaction. It complements `show_windows_sandbox_setup_status` by undoing the temporary UI restrictions that method imposed.


### `tui/src/chatwidget/tool_requests.rs`

`domain_logic` · `request handling`

This module is the blocking-decision side of `ChatWidget`: whenever the backend needs the user or guardian to approve, answer, or grant permissions, these methods create the corresponding bottom-pane request surface and keep transcript/status state coherent. The lightweight `on_*` entrypoints all record visible turn activity and use `defer_or_handle` so requests can be queued during replay or thread transitions and rendered later by `handle_*_now` methods.

`on_guardian_assessment` is the most involved path. It derives human-readable summaries from `GuardianAssessmentAction`, including shell-joined commands, patch file counts, network targets, MCP tool labels, and permission-request reasons. In-progress assessments temporarily own the footer status via `pending_guardian_review_status`, aggregating parallel reviews into one indicator and showing the interrupt hint. Terminal assessments first remove their pending footer entry, restore or downgrade the status header if needed, then append an approved, timed-out, or denied history cell. Denials are also pushed into `review.recent_auto_review_denials` for later UX flows.

The immediate handlers all flush streamed assistant output before presenting a blocking prompt. They construct typed `ApprovalRequest` values for exec, patch, permissions, and fallback elicitation forms; route richer elicitation requests either into app-link views or MCP-specific forms; emit desktop/ambient notifications; and set the pet notification to `Waiting`. A notable design choice is that unsupported URL elicitation requests are auto-declined through `app_event_tx.resolve_elicitation` rather than leaving an unusable prompt on screen.

#### Function details

##### `ChatWidget::on_exec_approval_request`  (lines 9–16)

```
fn on_exec_approval_request(&mut self, _id: String, ev: ExecApprovalRequestEvent)
```

**Purpose**: Receives an execution-approval request and routes it through deferred or immediate handling. It preserves the event for whichever path is taken.

**Data flow**: Takes an unused request id and an `ExecApprovalRequestEvent`, records visible-turn activity, clones the event, then either pushes the original into the deferred queue or passes the clone to the immediate approval handler. It mutates queue or UI state and returns nothing.

**Call relations**: Called when the backend asks for command approval. If the widget is ready to render immediately it delegates to `ChatWidget::handle_exec_approval_now`; otherwise it stores the event for later replay.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_apply_patch_approval_request`  (lines 18–29)

```
fn on_apply_patch_approval_request(
        &mut self,
        _id: String,
        ev: ApplyPatchApprovalRequestEvent,
    )
```

**Purpose**: Receives an apply-patch approval request and routes it through the same defer-or-handle path used for other blocking prompts. It ensures patch approval can be shown later if immediate rendering is unsafe.

**Data flow**: Accepts an unused id and an `ApplyPatchApprovalRequestEvent`, records visible-turn activity, clones the event, and either queues the original or immediately handles the clone. It writes queue or bottom-pane state and returns nothing.

**Call relations**: Invoked when patch application requires approval. It delegates immediate rendering to `ChatWidget::handle_apply_patch_approval_now`.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_guardian_assessment`  (lines 38–254)

```
fn on_guardian_assessment(&mut self, ev: GuardianAssessmentEvent)
```

**Purpose**: Processes guardian review lifecycle events, updating the live footer while review is pending and appending final approved/denied/timed-out transcript cells when the review completes. It also tracks recent automatic denials for later review UX.

**Data flow**: Consumes a `GuardianAssessmentEvent`, derives helper closures to summarize actions and reconstruct command vectors, then branches on `ev.status`. For `InProgress`, it ensures a status indicator exists, shows the interrupt hint, updates `status_state.pending_guardian_review_status`, possibly calls `set_status`, requests redraw, and returns. For terminal states, it removes the pending footer entry, restores or downgrades the current status header if needed, then builds a history cell based on action type and status: command-like actions use `new_approval_decision_cell`, while patch/network/MCP/permission actions use guardian-specific approved, denied, or timed-out cell constructors. Denied events are cloned into `self.review.recent_auto_review_denials`. It appends the boxed history cell, requests redraw, and returns.

**Call relations**: This function is called directly on guardian assessment events rather than via a separate `handle_*_now` helper. It owns both the transient footer-status flow and the terminal transcript-rendering flow, delegating cell construction to the various `history_cell` constructors depending on action/status.

*Call graph*: 12 external calls (from, format!, new_approval_decision_cell, new_guardian_approved_action_request, new_guardian_denied_action_request, new_guardian_denied_patch_request, new_guardian_timed_out_action_request, new_guardian_timed_out_patch_request, clone, to_string (+2 more)).


##### `ChatWidget::on_elicitation_request`  (lines 256–268)

```
fn on_elicitation_request(
        &mut self,
        request_id: AppServerRequestId,
        params: McpServerElicitationRequestParams,
    )
```

**Purpose**: Receives an MCP server elicitation request and routes it through deferred or immediate handling. It preserves both the request id and params for whichever path executes.

**Data flow**: Takes an `AppServerRequestId` and `McpServerElicitationRequestParams`, records visible-turn activity, clones both values, and either queues the originals or immediately handles the clones. It mutates queue or prompt state and returns nothing.

**Call relations**: Called when an MCP server asks the user for additional information. If immediate rendering is possible it delegates to `ChatWidget::handle_elicitation_request_now`.

*Call graph*: 2 external calls (clone, clone).


##### `ChatWidget::on_request_user_input`  (lines 270–277)

```
fn on_request_user_input(&mut self, ev: ToolRequestUserInputParams)
```

**Purpose**: Receives a generic tool-driven user-input request and routes it through deferred or immediate handling. It is the entrypoint for plan-mode question prompts and similar multi-question requests.

**Data flow**: Consumes `ToolRequestUserInputParams`, records visible-turn activity, clones the event, and either queues the original or immediately handles the clone. It writes queue or bottom-pane state and returns nothing.

**Call relations**: Invoked when the backend requests explicit user answers. It delegates immediate prompt creation to `ChatWidget::handle_request_user_input_now`.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::on_request_permissions`  (lines 279–286)

```
fn on_request_permissions(&mut self, ev: RequestPermissionsEvent)
```

**Purpose**: Receives a permissions request event and routes it through deferred or immediate handling. It mirrors the approval-request entrypoints for permission grants.

**Data flow**: Takes a `RequestPermissionsEvent`, records visible-turn activity, clones it, and either queues the original or immediately handles the clone. It mutates queue or approval UI state and returns nothing.

**Call relations**: Called when the backend asks for environment permissions. It delegates immediate rendering to `ChatWidget::handle_request_permissions_now`.

*Call graph*: 1 external calls (clone).


##### `ChatWidget::handle_exec_approval_now`  (lines 288–312)

```
fn handle_exec_approval_now(&mut self, ev: ExecApprovalRequestEvent)
```

**Purpose**: Immediately presents an execution approval request in the bottom pane and emits a notification summarizing the command. It packages the backend event into the widget’s internal `ApprovalRequest::Exec` form.

**Data flow**: Consumes an `ExecApprovalRequestEvent`, flushes streamed answer output, shell-joins `ev.command` for notification text with a fallback plain join, notifies `ExecApprovalRequested`, computes `available_decisions` and effective approval id from the event, constructs `ApprovalRequest::Exec` using the current thread id plus reason/network/additional-permission context, pushes it into `bottom_pane`, sets the ambient pet notification to `Waiting`, requests redraw, and returns nothing.

**Call relations**: Reached from `ChatWidget::on_exec_approval_request` when immediate handling is allowed. It delegates decision normalization to the event’s `effective_*` helpers and uses the bottom pane as the actual approval surface.

*Call graph*: calls 2 internal fn (effective_approval_id, effective_available_decisions); 1 external calls (try_join).


##### `ChatWidget::handle_apply_patch_approval_now`  (lines 314–336)

```
fn handle_apply_patch_approval_now(&mut self, ev: ApplyPatchApprovalRequestEvent)
```

**Purpose**: Immediately presents an apply-patch approval request and emits an edit-approval notification listing the affected files. It wraps the backend event into `ApprovalRequest::ApplyPatch` with cwd context.

**Data flow**: Consumes an `ApplyPatchApprovalRequestEvent`, flushes streamed answer output, constructs `ApprovalRequest::ApplyPatch` from the current thread id, call id, reason, cloned changes map, and cloned cwd, pushes it into the bottom pane, sets the ambient pet notification to `Waiting`, requests redraw, and notifies `EditApprovalRequested` with cwd and the changed file paths collected from the map keys.

**Call relations**: Reached from `ChatWidget::on_apply_patch_approval_request` for immediate rendering. It does not branch further; the bottom pane owns the actual approval interaction.


##### `ChatWidget::handle_elicitation_request_now`  (lines 338–395)

```
fn handle_elicitation_request_now(
        &mut self,
        request_id: AppServerRequestId,
        params: McpServerElicitationRequestParams,
    )
```

**Purpose**: Immediately presents or resolves an MCP elicitation request, choosing among app-link views, MCP-specific forms, generic approval prompts, or automatic decline for unsupported URL requests. It also emits a notification naming the requesting server.

**Data flow**: Takes a request id and `McpServerElicitationRequestParams`, flushes streamed answer output, notifies `ElicitationRequested`, derives a `ThreadId` from `params.thread_id` with fallback to the current thread id, then tries three paths in order: build `AppLinkViewParams` and open an app-link view; build an `McpServerElicitationFormRequest` and push it to the bottom pane; or fall back on the raw request variant. For `Form`, it constructs `ApprovalRequest::McpElicitation` and pushes it as an approval request. For `Url`, it immediately resolves the elicitation through `app_event_tx` with a `Decline` action and no content/meta. Finally it sets the ambient pet notification to `Waiting`, requests redraw, and returns.

**Call relations**: This is the immediate handler used by `ChatWidget::on_elicitation_request`. It delegates request-shape detection to `AppLinkViewParams::from_url_app_server_request` and `McpServerElicitationFormRequest::from_app_server_request` before falling back to generic handling.

*Call graph*: calls 3 internal fn (from_string, from_url_app_server_request, from_app_server_request); 2 external calls (clone, clone).


##### `ChatWidget::push_approval_request`  (lines 397–405)

```
fn push_approval_request(&mut self, request: ApprovalRequest)
```

**Purpose**: Pushes a prebuilt approval request into the bottom pane and updates waiting-state UI affordances. It is a small convenience wrapper used by other chat-widget flows.

**Data flow**: Accepts an `ApprovalRequest`, forwards it to `bottom_pane.push_approval_request` with feature flags, sets the ambient pet notification to `Waiting`, requests redraw, and returns nothing.

**Call relations**: This helper is used by callers that already constructed an `ApprovalRequest` and only need the standard bottom-pane/pet/redraw side effects.


##### `ChatWidget::push_mcp_server_elicitation_request`  (lines 407–418)

```
fn push_mcp_server_elicitation_request(
        &mut self,
        request: McpServerElicitationFormRequest,
    )
```

**Purpose**: Pushes a prebuilt MCP server elicitation form request into the bottom pane and applies the standard waiting-state UI updates. It parallels `push_approval_request` for the MCP-specific request type.

**Data flow**: Consumes an `McpServerElicitationFormRequest`, forwards it to `bottom_pane.push_mcp_server_elicitation_request`, sets the ambient pet notification to `Waiting`, requests redraw, and returns nothing.

**Call relations**: Used by flows that already converted an app-server elicitation into the widget’s MCP form-request type and only need to surface it consistently.


##### `ChatWidget::handle_request_user_input_now`  (lines 420–436)

```
fn handle_request_user_input_now(&mut self, ev: ToolRequestUserInputParams)
```

**Purpose**: Immediately presents a user-input questionnaire in the bottom pane and emits a plan-mode prompt notification summarizing the request. It derives a concise title from the number and content of questions.

**Data flow**: Consumes `ToolRequestUserInputParams`, flushes streamed answer output, counts `ev.questions`, derives an optional summary via `Notification::user_input_request_summary`, chooses a title based on question count and summary availability, notifies `PlanModePrompt { title }`, pushes the request into `bottom_pane`, sets the ambient pet notification to `Waiting`, requests redraw, and returns nothing.

**Call relations**: Reached from `ChatWidget::on_request_user_input` when immediate handling is allowed. It delegates only the summary-string derivation; the bottom pane owns the actual answer UI.

*Call graph*: calls 1 internal fn (user_input_request_summary); 1 external calls (format!).


##### `ChatWidget::handle_request_permissions_now`  (lines 438–455)

```
fn handle_request_permissions_now(&mut self, ev: RequestPermissionsEvent)
```

**Purpose**: Immediately presents a permissions approval request in the bottom pane. It wraps the backend event into the widget’s internal `ApprovalRequest::Permissions` form.

**Data flow**: Consumes a `RequestPermissionsEvent`, flushes streamed answer output, constructs `ApprovalRequest::Permissions` from current thread id, call id, environment id, reason, and requested permissions, pushes it into the bottom pane with feature flags, sets the ambient pet notification to `Waiting`, requests redraw, and returns nothing.

**Call relations**: Reached from `ChatWidget::on_request_permissions` for immediate rendering. It is the terminal adapter from protocol event to bottom-pane approval surface.


### Hook review RPC
This helper module supports the hook-inspection approval path by fetching hook metadata and persisting trust decisions.

### `tui/src/hooks_rpc.rs`

`io_transport` · `request handling`

This file is a small transport-oriented adapter between TUI code and the app-server protocol for hook review. It defines `HookTrustUpdate`, a compact value carrying the config key and current hash that should be trusted. `fetch_hooks_list` creates a unique `RequestId` using a UUID, sends a typed `ClientRequest::HooksList` through `AppServerRequestHandle`, and wraps failures with TUI-specific context. `hooks_list_entry_for_cwd` then extracts the `HooksListEntry` matching a given cwd from the server response, falling back to an empty entry with no hooks, warnings, or errors if the server omitted that cwd entirely. `hook_needs_review` centralizes the trust-state predicate used by selection and bulk-trust flows, treating only `Untrusted` and `Modified` hooks as reviewable. For writes, `write_hook_trusts` converts a batch of `HookTrustUpdate` values into a JSON object under `hooks.state`, where each key maps to `{ "trusted_hash": current_hash }`, and submits that as a `ConfigBatchWrite` edit using `MergeStrategy::Upsert` with config reload enabled. `write_hook_trust` is a single-item convenience wrapper over the batch API. The design keeps protocol details and request-id generation out of UI code while preserving typed responses and contextual error messages.

#### Function details

##### `fetch_hooks_list`  (lines 24–36)

```
async fn fetch_hooks_list(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> Result<HooksListResponse>
```

**Purpose**: Requests the hook inventory for one cwd from the app server and returns the typed response.

**Data flow**: Consumes an `AppServerRequestHandle` and a `PathBuf` cwd, builds a UUID-backed `RequestId::String`, sends `ClientRequest::HooksList { params: HooksListParams { cwds: vec![cwd] } }`, awaits the typed response, and returns `Result<HooksListResponse>`. On failure it adds the message `hooks/list failed in TUI`.

**Call relations**: Called by startup and interactive hook-loading flows before the UI can display hook review state. It delegates all transport work to `request_typed` and leaves response filtering to `hooks_list_entry_for_cwd`.

*Call graph*: calls 1 internal fn (request_typed); called by 2 (fetch_hooks_list, load_startup_hooks_review_entry); 3 external calls (String, format!, vec!).


##### `hooks_list_entry_for_cwd`  (lines 38–49)

```
fn hooks_list_entry_for_cwd(response: HooksListResponse, cwd: &Path) -> HooksListEntry
```

**Purpose**: Selects the `HooksListEntry` corresponding to the current working directory, or synthesizes an empty one if none exists.

**Data flow**: Consumes a `HooksListResponse` and borrows a `&Path`; iterates `response.data`, finds the first entry whose `cwd` matches, and returns it. If no match exists, it returns a new `HooksListEntry` with the requested cwd and empty `hooks`, `warnings`, and `errors` vectors.

**Call relations**: Used immediately after `fetch_hooks_list` by hook-loading code. It isolates callers from having to handle missing-cwd entries themselves.

*Call graph*: called by 2 (on_hooks_loaded, load_startup_hooks_review_entry).


##### `hook_needs_review`  (lines 51–56)

```
fn hook_needs_review(hook: &HookMetadata) -> bool
```

**Purpose**: Determines whether a hook should appear in trust-review actions based on its trust status.

**Data flow**: Reads `hook.trust_status` from a borrowed `HookMetadata` and returns `true` only for `HookTrustStatus::Untrusted` or `HookTrustStatus::Modified`.

**Call relations**: Invoked by selection and bulk-trust commands to decide which hooks are actionable. It centralizes the review predicate so UI flows stay consistent.

*Call graph*: called by 3 (toggle_selected_hook, trust_all_hooks, trust_selected_hook); 1 external calls (matches!).


##### `write_hook_trusts`  (lines 58–92)

```
async fn write_hook_trusts(
    request_handle: AppServerRequestHandle,
    trust_updates: Vec<HookTrustUpdate>,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Writes one or more trusted hook hashes into config under `hooks.state` using a batch config edit.

**Data flow**: Consumes an `AppServerRequestHandle` and a vector of `HookTrustUpdate`; generates a UUID-backed request id; transforms updates into a `serde_json::Value::Object` mapping each key to `{ "trusted_hash": current_hash }`; wraps that in `ConfigBatchWriteParams` with one `ConfigEdit` targeting `hooks.state`, `MergeStrategy::Upsert`, `reload_user_config: true`; sends `ClientRequest::ConfigBatchWrite`; awaits and returns `Result<ConfigWriteResponse>` with contextual error wrapping.

**Call relations**: Called by bulk trust flows and by the single-item wrapper `write_hook_trust`. It is the main write path used when the TUI persists hook trust decisions.

*Call graph*: calls 1 internal fn (request_typed); called by 3 (trust_hooks, write_hook_trust, run_startup_hooks_review_app); 4 external calls (String, format!, Object, vec!).


##### `write_hook_trust`  (lines 94–100)

```
async fn write_hook_trust(
    request_handle: AppServerRequestHandle,
    key: String,
    current_hash: String,
) -> Result<ConfigWriteResponse>
```

**Purpose**: Convenience wrapper that writes trust for exactly one hook.

**Data flow**: Consumes a request handle, one config key, and one current hash; packages them into a single `HookTrustUpdate` vector; forwards to `write_hook_trusts`; and returns the resulting `ConfigWriteResponse`.

**Call relations**: Used by single-hook trust actions. It exists to keep callers from manually constructing one-element batches.

*Call graph*: calls 1 internal fn (write_hook_trusts); called by 1 (trust_hook); 1 external calls (vec!).
