# Guardian review and mediated approval sessions  `stage-14.1.2`

This stage is the mediated approval path that runs during the main execution loop whenever an action must be reviewed by the Guardian before proceeding. It sits between a concrete approval-triggering event and the final allow/deny decision, packaging the request, launching a constrained nested review, and reporting the outcome back to the session and UI.

At its foundation, core/src/guardian/mod.rs defines the shared Guardian types and constants and enforces the per-turn circuit breaker that stops a turn after too many automatic denials. core/src/guardian/approval_request.rs turns raw approval events into the canonical Guardian request model and renders that model into the JSON, analytics, action, and human-readable forms used downstream. core/src/guardian/prompt.rs then constructs the reviewer prompt from session history plus the exact request, while also parsing the reviewer’s structured assessment and trimming transcripts to keep prompts stable.

On the orchestration side, core/src/session/review.rs opens a dedicated review sub-turn with restricted capabilities and review-specific context. core/src/guardian/review_session.rs executes and reuses nested Guardian sessions, including forks, deadlines, and cancellation. Finally, core/src/guardian/review.rs coordinates the full workflow: routing, retries, metrics, event publication, rejection persistence, and circuit-breaker-aware final decisions.

## Files in this stage

### Guardian foundations
Defines the guardian subsystem’s shared types and the approval-request model that all later review flows consume.

### `core/src/guardian/mod.rs`

`domain_logic` · `cross-cutting guardian setup and per-turn denial tracking`

This module is the root of the guardian approval-review subsystem. Beyond wiring submodules together, it defines the constants that shape guardian behavior: the 90-second review timeout, the reviewer name used for subagent identification, transcript and action truncation budgets, and the denial thresholds used to stop pathological loops. It also declares the structured `GuardianAssessment` contract returned by the reviewer, the stored `GuardianRejection` rationale/source pair used for later user-facing messaging, and the `GuardianRejectionCircuitBreaker` state machine.

The circuit breaker tracks denial history per turn ID in a `HashMap<String, GuardianRejectionCircuitBreakerTurn>`. Each turn record stores a consecutive-denial counter, a bounded `VecDeque<bool>` of recent review outcomes, and a latch indicating whether an interrupt has already been triggered. `record_denial` increments the consecutive counter with saturation, appends a `true` into the sliding window, counts recent denials, and emits `InterruptTurn` exactly once when either the consecutive threshold or recent-window threshold is crossed. `record_non_denial` resets only the consecutive counter while still appending `false` into the recent window, so the rolling-rate threshold remains meaningful. `clear_turn` removes all state for a completed or discarded turn.

#### Function details

##### `GuardianRejectionCircuitBreaker::clear_turn`  (lines 99–101)

```
fn clear_turn(&mut self, turn_id: &str)
```

**Purpose**: Deletes all denial-tracking state for a specific turn ID. This resets both consecutive and rolling-window history for that turn.

**Data flow**: Takes `&mut self` and a `turn_id: &str`, removes the corresponding entry from the internal `turns: HashMap<String, GuardianRejectionCircuitBreakerTurn>`, and returns nothing.

**Call relations**: This is a simple state-reset operation used when a turn no longer needs guardian denial history. It does not delegate further.


##### `GuardianRejectionCircuitBreaker::record_denial`  (lines 103–120)

```
fn record_denial(&mut self, turn_id: &str) -> GuardianRejectionCircuitBreakerAction
```

**Purpose**: Records one denied guardian review for a turn and decides whether the turn should now be interrupted. It enforces both the consecutive-denial threshold and the rolling recent-denial threshold.

**Data flow**: Accepts `&mut self` and `turn_id`. It looks up or creates the per-turn state, increments `consecutive_denials` with saturation, appends a denied marker via `record_recent_review`, counts `true` values in `recent_denials`, and returns either `GuardianRejectionCircuitBreakerAction::InterruptTurn { consecutive_denials, recent_denials }` if thresholds are crossed for the first time, or `Continue` otherwise. It also sets `interrupt_triggered = true` when it emits the interrupt action.

**Call relations**: This method is called by guardian review orchestration after a denial. It delegates the sliding-window maintenance to `record_recent_review`, then performs the threshold check itself so callers can decide whether to abort the turn.

*Call graph*: 1 external calls (record_recent_review).


##### `GuardianRejectionCircuitBreaker::record_non_denial`  (lines 122–126)

```
fn record_non_denial(&mut self, turn_id: &str)
```

**Purpose**: Records an approved, aborted, timed-out, or otherwise non-denial review outcome for a turn. It clears the consecutive-denial streak without erasing the rolling recent-review window.

**Data flow**: Takes `&mut self` and `turn_id`, looks up or creates the turn state, sets `consecutive_denials` to zero, appends `false` into `recent_denials` through `record_recent_review`, and returns nothing.

**Call relations**: Called by guardian review orchestration whenever a review should not count as a denial for interruption purposes. It shares the same recent-window bookkeeping helper as `record_denial`.

*Call graph*: 1 external calls (record_recent_review).


##### `GuardianRejectionCircuitBreaker::record_recent_review`  (lines 128–133)

```
fn record_recent_review(turn: &mut GuardianRejectionCircuitBreakerTurn, denied: bool)
```

**Purpose**: Maintains the bounded sliding window of recent review outcomes for one turn. It ensures the deque never grows beyond `AUTO_REVIEW_DENIAL_WINDOW_SIZE`.

**Data flow**: Mutates a `GuardianRejectionCircuitBreakerTurn` by pushing `denied` onto `recent_denials`. If the deque length exceeds the configured window size, it pops the oldest entry from the front. It returns nothing.

**Call relations**: This private helper is used by both `record_denial` and `record_non_denial` so the rolling-window logic stays consistent across all review outcomes.


### `core/src/guardian/approval_request.rs`

`domain_logic` · `guardian request handling`

This file models every approval request Guardian can review through the `GuardianApprovalRequest` enum: shell commands, unified exec commands, Unix `execve`, patch application, network access, MCP tool calls, and permission requests. Supporting structs such as `GuardianNetworkAccessTrigger`, `GuardianMcpAnnotations`, and several private `*ApprovalAction` serializers define the exact JSON shape emitted for each request type. Optional fields are consistently omitted with `skip_serializing_if`, keeping prompts and telemetry compact.

The conversion functions serve different downstream consumers. `guardian_approval_request_to_json` produces structured JSON for prompt rendering, using specialized serializers for command-like actions and direct `json!` construction for patches. `guardian_assessment_action` maps requests into `GuardianAssessmentAction`, preserving enough semantic detail for policy/assessment logic, while `guardian_reviewed_action` strips each request down to the analytics-oriented `GuardianReviewedAction` variant. Two small helpers expose the target item id and effective turn id used by the review loop.

A notable feature is recursive truncation for prompt display. `format_guardian_action_pretty` first serializes the request to `serde_json::Value`, then `truncate_guardian_action_value` walks strings, arrays, and objects recursively, truncating long strings with `guardian_truncate_text` and returning a `FormattedGuardianAction` that records whether any truncation occurred. Object keys are sorted before reconstruction, making pretty-printed output deterministic for prompts and tests.

#### Function details

##### `serialize_guardian_action`  (lines 172–174)

```
fn serialize_guardian_action(value: impl Serialize) -> serde_json::Result<Value>
```

**Purpose**: Serializes any `Serialize` value into a `serde_json::Value` for Guardian prompt/rendering pipelines.

**Data flow**: Consumes `value: impl Serialize`, passes it to `serde_json::to_value`, and returns the resulting `serde_json::Result<Value>`.

**Call relations**: Used as the common serialization primitive by `serialize_command_guardian_action` and several branches of `guardian_approval_request_to_json`.

*Call graph*: called by 2 (guardian_approval_request_to_json, serialize_command_guardian_action); 1 external calls (to_value).


##### `serialize_command_guardian_action`  (lines 176–194)

```
fn serialize_command_guardian_action(
    tool: &'static str,
    command: &[String],
    cwd: &Path,
    sandbox_permissions: crate::sandboxing::SandboxPermissions,
    additional_permissions: Option
```

**Purpose**: Builds and serializes the JSON payload for shell-like command approval requests. It standardizes the shared fields between shell and unified exec requests.

**Data flow**: Reads `tool`, `command`, `cwd`, `sandbox_permissions`, optional `additional_permissions`, optional `justification`, and optional `tty`; constructs a `CommandApprovalAction` borrowing those fields; passes it to `serialize_guardian_action`; and returns the JSON result.

**Call relations**: Called from `guardian_approval_request_to_json` for `Shell` and `ExecCommand` variants so both share one JSON shape.

*Call graph*: calls 1 internal fn (serialize_guardian_action); called by 1 (guardian_approval_request_to_json).


##### `command_assessment_action`  (lines 196–206)

```
fn command_assessment_action(
    source: GuardianCommandSource,
    command: &[String],
    cwd: &AbsolutePathBuf,
) -> GuardianAssessmentAction
```

**Purpose**: Converts a command request into the `GuardianAssessmentAction::Command` form used by Guardian assessment logic.

**Data flow**: Reads `source`, `command`, and `cwd`; shell-joins the command vector with `codex_shell_command::parse_command::shlex_join`; clones `cwd`; and returns `GuardianAssessmentAction::Command { source, command, cwd }`.

**Call relations**: Used by `guardian_assessment_action` for both `Shell` and `ExecCommand` variants.

*Call graph*: calls 1 internal fn (shlex_join); called by 1 (guardian_assessment_action); 1 external calls (clone).


##### `guardian_command_source_tool_name`  (lines 209–214)

```
fn guardian_command_source_tool_name(source: GuardianCommandSource) -> &'static str
```

**Purpose**: Maps a Unix `GuardianCommandSource` to the tool name string used in serialized `Execve` approval actions.

**Data flow**: Reads `source`, matches `Shell` to `"shell"` and `UnifiedExec` to `"exec_command"`, and returns the static string.

**Call relations**: Called only from the Unix `Execve` branch of `guardian_approval_request_to_json`.

*Call graph*: called by 1 (guardian_approval_request_to_json).


##### `truncate_guardian_action_value`  (lines 216–251)

```
fn truncate_guardian_action_value(value: Value) -> (Value, bool)
```

**Purpose**: Recursively truncates long strings inside a serialized Guardian action while preserving overall JSON structure and reporting whether truncation occurred.

**Data flow**: Consumes a `serde_json::Value`; for `String`, calls `guardian_truncate_text` with `GUARDIAN_MAX_ACTION_STRING_TOKENS`; for `Array`, recursively truncates each element and ORs their truncation flags; for `Object`, sorts entries by key, recursively truncates each value, and rebuilds the object; for other scalar values, returns them unchanged. Returns `(Value, bool)`.

**Call relations**: Used by `format_guardian_action_pretty` after JSON serialization and before pretty-printing. It ensures prompt text stays bounded and deterministic.

*Call graph*: calls 1 internal fn (guardian_truncate_text); called by 1 (format_guardian_action_pretty); 3 external calls (Array, Object, String).


##### `guardian_approval_request_to_json`  (lines 259–373)

```
fn guardian_approval_request_to_json(
    action: &GuardianApprovalRequest,
) -> serde_json::Result<Value>
```

**Purpose**: Serializes each `GuardianApprovalRequest` variant into the exact JSON object shown to Guardian or downstream consumers.

**Data flow**: Reads `action`, pattern-matches on its variant, and for each branch either calls `serialize_command_guardian_action`, constructs an `ExecveApprovalAction`, uses `serde_json::json!` for `ApplyPatch`, or serializes one of the other private action structs. Returns `serde_json::Result<Value>`.

**Call relations**: This is the main serialization entry point used by `format_guardian_action_pretty`. It delegates variant-specific formatting to helper serializers and private action structs.

*Call graph*: calls 3 internal fn (guardian_command_source_tool_name, serialize_command_guardian_action, serialize_guardian_action); called by 1 (format_guardian_action_pretty); 1 external calls (json!).


##### `guardian_assessment_action`  (lines 375–441)

```
fn guardian_assessment_action(
    action: &GuardianApprovalRequest,
) -> GuardianAssessmentAction
```

**Purpose**: Maps a `GuardianApprovalRequest` into the semantic `GuardianAssessmentAction` consumed by Guardian review logic.

**Data flow**: Reads `action`, matches on its variant, and constructs the corresponding `GuardianAssessmentAction`, cloning owned fields like commands, paths, strings, permissions, and MCP metadata as needed.

**Call relations**: Called by `run_guardian_review` to feed the assessment engine. It delegates command variants to `command_assessment_action` and handles other variants inline.

*Call graph*: calls 1 internal fn (command_assessment_action); called by 1 (run_guardian_review).


##### `guardian_reviewed_action`  (lines 443–501)

```
fn guardian_reviewed_action(
    request: &GuardianApprovalRequest,
) -> GuardianReviewedAction
```

**Purpose**: Converts a request into the analytics-oriented `GuardianReviewedAction` summarizing what kind of action Guardian reviewed.

**Data flow**: Reads `request`, matches on its variant, and constructs the corresponding `GuardianReviewedAction`, copying scalar fields and cloning optional permission or metadata payloads where needed.

**Call relations**: Called by `run_guardian_review` after review decisions to emit analytics about the reviewed action.

*Call graph*: called by 1 (run_guardian_review).


##### `guardian_request_target_item_id`  (lines 503–514)

```
fn guardian_request_target_item_id(request: &GuardianApprovalRequest) -> Option<&str>
```

**Purpose**: Extracts the item id associated with a Guardian request when one exists. Network access requests intentionally have no target item id.

**Data flow**: Reads `request`, matches on its variant, returns `Some(id)` for shell, exec, patch, MCP, request-permissions, and Unix execve variants, and `None` for `NetworkAccess`.

**Call relations**: Used by `run_guardian_review` when associating review results with a specific target item.

*Call graph*: called by 1 (run_guardian_review).


##### `guardian_request_turn_id`  (lines 516–530)

```
fn guardian_request_turn_id(
    request: &'a GuardianApprovalRequest,
    default_turn_id: &'a str,
) -> &'a str
```

**Purpose**: Returns the effective turn id for a Guardian request, falling back to a caller-supplied default for request types that do not carry their own turn id.

**Data flow**: Reads `request` and `default_turn_id`; returns the embedded `turn_id` for `NetworkAccess` and `RequestPermissions`, otherwise returns `default_turn_id`.

**Call relations**: Called by `run_guardian_review` to attribute review activity to the correct conversation turn.

*Call graph*: called by 1 (run_guardian_review).


##### `format_guardian_action_pretty`  (lines 532–541)

```
fn format_guardian_action_pretty(
    action: &GuardianApprovalRequest,
) -> serde_json::Result<FormattedGuardianAction>
```

**Purpose**: Produces a pretty-printed JSON string for a Guardian request along with a flag indicating whether any nested strings were truncated.

**Data flow**: Reads `action`, serializes it with `guardian_approval_request_to_json`, recursively truncates the resulting `Value` with `truncate_guardian_action_value`, pretty-prints it via `serde_json::to_string_pretty`, and returns `FormattedGuardianAction { text, truncated }`.

**Call relations**: Used by `build_guardian_prompt_items_with_parent_turn` when constructing prompt content for Guardian review. It composes the file’s serialization and truncation helpers into the final display form.

*Call graph*: calls 2 internal fn (guardian_approval_request_to_json, truncate_guardian_action_value); called by 1 (build_guardian_prompt_items_with_parent_turn); 1 external calls (to_string_pretty).


### Reviewer prompt construction
Builds the reviewer-facing prompt and parses structured review results for guardian approval assessments.

### `core/src/guardian/prompt.rs`

`domain_logic` · `guardian request assembly and guardian response parsing`

This file contains the guardian prompt assembly logic. It first reduces raw `ResponseItem` history into `GuardianTranscriptEntry` values that preserve user, assistant, selected developer, and tool evidence while skipping contextual scaffolding. Tool calls and outputs are retained with synthetic roles like `tool read_file call` and `tool read_file result`, using a `call_id -> tool name` map so outputs can be labeled even when they arrive later. Transcript rendering then applies separate token budgets for human conversation and tool evidence, truncates each entry individually, anchors on the first and last user turns when possible, and fills remaining budget from newest relevant entries. Omitted entries produce a note rather than silently disappearing.

Prompt construction supports both full and delta modes. A `GuardianTranscriptCursor` captures the parent history version and retained entry count; if a later review reuses the same history version and the cursor is still valid, only the unseen suffix is rendered with original numbering preserved. The assembled `GuardianPromptItems` are emitted as multiple `UserInput::Text` segments with explicit transcript and approval-request boundaries, optional parent-turn denied-read context, and special wording for network-access reviews that emphasizes evaluating the triggering command rather than the exact socket target. On the response side, `parse_guardian_assessment` accepts strict JSON or a prose-wrapped JSON object, fills defaults for omitted risk level, authorization, and rationale, and returns a concrete `GuardianAssessment`.

#### Function details

##### `GuardianTranscriptEntryKind::role`  (lines 46–53)

```
fn role(&self) -> &str
```

**Purpose**: Returns the textual role label used when rendering transcript entries for the guardian prompt.

**Data flow**: Reads `self` and returns `developer`, `user`, `assistant`, or the inner tool-role string for `Tool(String)`.

**Call relations**: Used during transcript rendering so each retained entry is prefixed with a stable human-readable role.


##### `GuardianTranscriptEntryKind::is_user`  (lines 55–57)

```
fn is_user(&self) -> bool
```

**Purpose**: Identifies whether a transcript entry kind represents a user message.

**Data flow**: Matches `self` against `GuardianTranscriptEntryKind::User` and returns a boolean.

**Call relations**: Called by transcript rendering to apply user-anchor selection and message-budget logic.

*Call graph*: 1 external calls (matches!).


##### `GuardianTranscriptEntryKind::is_tool`  (lines 59–61)

```
fn is_tool(&self) -> bool
```

**Purpose**: Identifies whether a transcript entry kind represents tool evidence.

**Data flow**: Matches `self` against `GuardianTranscriptEntryKind::Tool(_)` and returns a boolean.

**Call relations**: Used by transcript rendering to choose per-entry truncation caps and the separate tool-token budget.

*Call graph*: 1 external calls (matches!).


##### `build_guardian_prompt_items`  (lines 92–106)

```
async fn build_guardian_prompt_items(
    session: &Session,
    retry_reason: Option<String>,
    request: GuardianApprovalRequest,
    mode: GuardianPromptMode,
) -> serde_json::Result<GuardianPromp
```

**Purpose**: Test-visible convenience wrapper that builds guardian prompt items without a parent-turn permission context.

**Data flow**: Accepts a `Session`, optional retry reason, `GuardianApprovalRequest`, and `GuardianPromptMode`, forwards them to `build_guardian_prompt_items_with_parent_turn` with `parent_turn` set to `None`, and returns the resulting `GuardianPromptItems` or JSON serialization error.

**Call relations**: Used by tests and any caller that does not need parent-turn denied-read context. The real work is delegated to `build_guardian_prompt_items_with_parent_turn`.

*Call graph*: calls 1 internal fn (build_guardian_prompt_items_with_parent_turn).


##### `build_guardian_prompt_items_with_parent_turn`  (lines 108–242)

```
async fn build_guardian_prompt_items_with_parent_turn(
    session: &Session,
    parent_turn: Option<&TurnContext>,
    retry_reason: Option<String>,
    request: GuardianApprovalRequest,
    mode: G
```

**Purpose**: Constructs the full guardian user-input payload, including transcript, session ID, optional omission notes, optional parent permission context, and the exact planned action JSON. It chooses between full and delta transcript layouts based on the supplied prompt mode and current history version.

**Data flow**: Reads the parent `session`, optional `parent_turn`, optional `retry_reason`, approval `request`, and `mode`. It clones session history, converts raw items with `collect_guardian_transcript_entries`, computes a fresh `GuardianTranscriptCursor`, pretty-prints the action via `format_guardian_action_pretty`, decides whether the requested delta cursor is still reusable, renders either the full transcript or only the unseen suffix, and pushes a sequence of `UserInput::Text` items into a vector. It includes the reviewed session ID, omission note, optional denied-read context from `parent_turn_denied_reads_context`, and request-specific explanatory text; for network access it omits retry reason and uses specialized guidance. It returns `GuardianPromptItems { items, transcript_cursor, reviewed_action_truncated }`.

**Call relations**: This is the main prompt builder. It is called by the wrapper above and by review-session execution when submitting a guardian turn. It delegates transcript extraction and rendering to `collect_guardian_transcript_entries`, `render_guardian_transcript_entries`, and `render_guardian_transcript_entries_with_offset`, and action formatting to `format_guardian_action_pretty`.

*Call graph*: calls 4 internal fn (format_guardian_action_pretty, collect_guardian_transcript_entries, render_guardian_transcript_entries, render_guardian_transcript_entries_with_offset); called by 2 (build_guardian_prompt_items, run_review_on_session); 3 external calls (new, clone_history, format!).


##### `parent_turn_denied_reads_context`  (lines 244–267)

```
fn parent_turn_denied_reads_context(turn: &TurnContext) -> Option<String>
```

**Purpose**: Summarizes parent-turn filesystem read restrictions into a warning block for the guardian prompt. It only emits text when the active permission profile actually denies some roots or globs.

**Data flow**: Reads a `TurnContext`, extracts its cwd and filesystem sandbox policy, gathers unreadable roots and glob patterns relative to cwd, formats them as bullet lines, and returns `Some(String)` containing the explanatory paragraph plus entries, or `None` if there are no denied reads.

**Call relations**: Called from `build_guardian_prompt_items_with_parent_turn` when a parent turn is available, so guardian can avoid approving escalations whose purpose is to read explicitly denied paths.

*Call graph*: 1 external calls (format!).


##### `render_guardian_transcript_entries`  (lines 297–305)

```
fn render_guardian_transcript_entries(
    entries: &[GuardianTranscriptEntry],
) -> (Vec<String>, Option<String>)
```

**Purpose**: Renders retained transcript entries using the default numbering offset and empty placeholder.

**Data flow**: Takes a slice of `GuardianTranscriptEntry`, forwards it to `render_guardian_transcript_entries_with_offset` with offset `0` and placeholder `<no retained transcript entries>`, and returns the rendered lines plus optional omission note.

**Call relations**: Used by full prompt construction. It is a thin wrapper around the offset-aware renderer.

*Call graph*: calls 1 internal fn (render_guardian_transcript_entries_with_offset); called by 1 (build_guardian_prompt_items_with_parent_turn).


##### `render_guardian_transcript_entries_with_offset`  (lines 307–409)

```
fn render_guardian_transcript_entries_with_offset(
    entries: &[GuardianTranscriptEntry],
    entry_number_offset: usize,
    empty_placeholder: &str,
) -> (Vec<String>, Option<String>)
```

**Purpose**: Selects, truncates, numbers, and renders transcript entries under separate message and tool budgets. It preserves original numbering when rendering deltas and reports when entries were omitted.

**Data flow**: Consumes a slice of entries, an `entry_number_offset`, and an `empty_placeholder`. If the slice is empty it returns a one-line placeholder and no omission note. Otherwise it pre-renders each entry with role prefix and per-entry truncation via `guardian_truncate_text`, computes approximate token counts, marks included entries according to the selection policy (first user, last user if budget allows, remaining users newest-first, then recent non-user entries newest-first under message/tool budgets and `GUARDIAN_RECENT_ENTRY_LIMIT`), collects included rendered strings in original order, and returns them with `Some("Some conversation entries were omitted.")` if any entries were skipped.

**Call relations**: Called by both full and delta prompt assembly, and by the simpler wrapper. It relies on `GuardianTranscriptEntryKind::is_user`, `is_tool`, and `role`, plus `guardian_truncate_text`, to enforce the guardian transcript design.

*Call graph*: called by 2 (build_guardian_prompt_items_with_parent_turn, render_guardian_transcript_entries); 4 external calls (is_empty, iter, len, vec!).


##### `collect_guardian_transcript_entries`  (lines 419–521)

```
fn collect_guardian_transcript_entries(
    items: &[ResponseItem],
) -> Vec<GuardianTranscriptEntry>
```

**Purpose**: Filters raw session history down to the human-readable and tool-evidence entries that guardian should review. It intentionally excludes contextual user scaffolding and most developer messages.

**Data flow**: Reads a slice of `ResponseItem` and iterates in order, building `GuardianTranscriptEntry` values. User messages are kept unless `is_contextual_user_message_content` says they are synthetic context; developer messages are kept only if their text starts with `AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX`; assistant messages and plaintext agent messages are retained as assistant entries; shell/function/custom/web-search calls are serialized into tool-call entries; function/custom tool outputs are converted to text and labeled using a `HashMap` from `call_id` to tool name when available. Empty or whitespace-only text is dropped. It returns the retained entries in original order.

**Call relations**: Called by `build_guardian_prompt_items_with_parent_turn` before transcript rendering. It delegates content extraction to `content_items_to_text` and `plaintext_agent_message_content`, and uses the contextual-message predicate to avoid duplicating startup context in the guardian transcript.

*Call graph*: calls 3 internal fn (content_items_to_text, is_contextual_user_message_content, plaintext_agent_message_content); called by 1 (build_guardian_prompt_items_with_parent_turn); 4 external calls (new, new, Tool, to_string).


##### `guardian_truncate_text`  (lines 523–545)

```
fn guardian_truncate_text(content: &str, token_cap: usize) -> (String, bool)
```

**Purpose**: Truncates oversized text to an approximate token budget while preserving both prefix and suffix context and inserting an XML-like omission marker. It is designed for prompt readability rather than exact token accounting.

**Data flow**: Takes `content` and a `token_cap`. If the content is empty or already within the approximate byte budget from `approx_bytes_for_tokens`, it returns the original string and `false`. Otherwise it estimates omitted tokens from the dropped byte count, builds a `<truncated omitted_approx_tokens="..." />` marker, splits the remaining byte budget between prefix and suffix, computes UTF-8-safe boundaries with `split_guardian_truncation_bounds`, and returns the stitched string plus `true`.

**Call relations**: Used by transcript rendering and by action formatting code elsewhere in the guardian subsystem to keep prompts bounded while still exposing the start and end of long payloads.

*Call graph*: calls 1 internal fn (split_guardian_truncation_bounds); called by 1 (truncate_guardian_action_value); 4 external calls (new, approx_bytes_for_tokens, approx_tokens_from_byte_count, format!).


##### `split_guardian_truncation_bounds`  (lines 547–583)

```
fn split_guardian_truncation_bounds(
    content: &str,
    prefix_bytes: usize,
    suffix_bytes: usize,
) -> (&str, &str)
```

**Purpose**: Finds UTF-8-safe slice boundaries for the prefix and suffix portions of a truncated string.

**Data flow**: Reads `content`, desired `prefix_bytes`, and `suffix_bytes`. It walks `char_indices()` to find the largest valid prefix end not exceeding the prefix budget and the earliest valid suffix start at or after the suffix target, ensures the suffix does not overlap the prefix, and returns borrowed `(&str, &str)` slices.

**Call relations**: This is the low-level helper used only by `guardian_truncate_text` to avoid splitting inside multibyte characters.

*Call graph*: called by 1 (guardian_truncate_text).


##### `parse_guardian_assessment`  (lines 589–630)

```
fn parse_guardian_assessment(text: Option<&str>) -> anyhow::Result<GuardianAssessment>
```

**Purpose**: Parses the guardian reviewer’s final message into a `GuardianAssessment`, tolerating a prose wrapper around the JSON object and filling sensible defaults for omitted optional fields.

**Data flow**: Accepts `Option<&str>`. If absent, it returns an error stating that no assessment payload was produced. It first tries to deserialize the whole string as `GuardianAssessmentPayload`; if that fails, it searches for the outermost `{...}` slice and retries deserialization on that substring. It then derives `risk_level` from the payload or defaults it to `Low` for allow and `High` for deny, derives `user_authorization` or defaults to `Unknown`, normalizes blank or missing rationale into canned allow/deny messages, and returns a populated `GuardianAssessment`.

**Call relations**: Called by guardian review execution after the nested review session completes. It is the thin recovery layer between model output drift and the stricter internal assessment type.

*Call graph*: called by 1 (run_guardian_review_session_before_deadline); 1 external calls (bail!).


##### `guardian_output_schema`  (lines 645–668)

```
fn guardian_output_schema() -> Value
```

**Purpose**: Returns the JSON schema supplied to the model as the guardian review’s final-output contract.

**Data flow**: Constructs and returns a `serde_json::Value` object schema with `additionalProperties: false`, optional `risk_level`, `user_authorization`, and `rationale` properties, and required `outcome` constrained to `allow` or `deny`.

**Call relations**: Used by guardian review execution and tests so the request-side schema and parser-side expectations stay aligned.

*Call graph*: called by 2 (run_guardian_review, test_review_params); 1 external calls (json!).


##### `guardian_output_contract_prompt`  (lines 672–684)

```
fn guardian_output_contract_prompt() -> &'static str
```

**Purpose**: Provides the textual prompt fragment that explains the strict JSON output contract to the guardian model.

**Data flow**: Returns a static string literal describing read-only tool checks, the bare low-risk allow form, and the full JSON schema shape for other cases.

**Call relations**: Appended by `guardian_policy_prompt_with_config` so the human-readable policy prompt and machine-readable schema remain synchronized.


##### `guardian_policy_prompt`  (lines 695–697)

```
fn guardian_policy_prompt() -> String
```

**Purpose**: Builds the default guardian policy prompt using the bundled `policy.md` tenant-policy content.

**Data flow**: Loads `policy.md` with `include_str!`, passes it to `guardian_policy_prompt_with_config`, and returns the resulting prompt string.

**Call relations**: Used when no workspace-managed guardian policy override is configured. It delegates final assembly to `guardian_policy_prompt_with_config`.

*Call graph*: calls 1 internal fn (guardian_policy_prompt_with_config); 1 external calls (include_str!).


##### `guardian_policy_prompt_with_config`  (lines 699–703)

```
fn guardian_policy_prompt_with_config(tenant_policy_config: &str) -> String
```

**Purpose**: Builds the full guardian developer/base prompt by injecting tenant policy text into the markdown template and appending the output-contract instructions.

**Data flow**: Loads `policy_template.md`, trims trailing whitespace, replaces `{tenant_policy_config}` with the trimmed supplied config text, appends two newlines plus `guardian_output_contract_prompt()`, and returns the final `String`.

**Call relations**: Called by `guardian_policy_prompt` and by guardian review session config building when a workspace-managed guardian policy override is present.

*Call graph*: called by 1 (guardian_policy_prompt); 2 external calls (format!, include_str!).


### Review session execution
Sets up review-mode turns and runs the reusable nested guardian review sessions that execute assessments.

### `core/src/session/review.rs`

`orchestration` · `request handling`

This file contains the session-side setup for review execution as a child task. The single async routine clones the parent turn’s runtime context, but deliberately rewrites several pieces of state so review runs in a constrained, isolated mode. It chooses the review model from `Config.review_model` when present, otherwise falls back to the parent turn’s model slug, then asks `models_manager` both for concrete `model_info` and the current `available_models` list. Before constructing the child context, it disables review-inappropriate features (`Feature::WebSearchRequest`, `Feature::WebSearchCached`, and `Feature::Goals`) and forces `WebSearchMode::Disabled`; if config requirements reject that assignment, it logs a warning and keeps the constrained fallback value instead of failing.

The function builds a per-turn `Config`, computes `ToolMode` from the model’s declared mode or feature flags (`CodeModeOnly`, `CodeMode`, else `Direct`), and derives `UnifiedExecShellMode` from the filtered feature set and shell configuration. It also forks telemetry, auth/provider handles, reasoning settings, thread/session metadata, extension data, and inherited skills into a fresh `TurnContext`. Important invariants are encoded here: review turns have `developer_instructions` and `user_instructions` cleared, `multi_agent_version` forced to `Disabled`, `final_output_json_schema` removed, and fresh atomic flags / timing / terminal-error state. The child task is seeded with one synthesized `TurnInput::UserInput` text message containing the resolved review prompt, optionally starts git enrichment when a single local environment cwd exists, then launches `sess.spawn_task(..., ReviewTask::new())`. Only after spawning does it send `EventMsg::EnteredReviewMode`, carrying the resolved review target and user-facing hint so clients can switch UI state.

#### Function details

##### `spawn_review_thread`  (lines 7–185)

```
async fn spawn_review_thread(
    sess: Arc<Session>,
    config: Arc<Config>,
    parent_turn_context: Arc<TurnContext>,
    sub_id: String,
    resolved: crate::review_prompts::ResolvedReviewRequest
```

**Purpose**: Builds a review-specific child `TurnContext` from an existing session and parent turn, then starts a `ReviewTask` seeded with the synthesized review prompt. It also emits the review-mode event that tells clients the session has transitioned into review behavior.

**Data flow**: Inputs are `Arc<Session>`, `Arc<Config>`, `Arc<TurnContext>`, a `sub_id`, and a resolved review request containing the prompt/target/hint. The function reads session services (`models_manager`, shell settings), session feature flags, locked session state (`forked_from_thread_id`), and many fields from the parent turn context (provider, auth, telemetry, skills, environment, permissions, network, cwd, etc.). It clones and mutates config into a per-turn review config, disables selected features, computes `ToolMode`, `UnifiedExecShellMode`, telemetry, metadata, extension data, and a fresh `TurnContext`, then wraps that context in `Arc`. It writes effects by optionally spawning git enrichment on `turn_metadata_state`, launching `sess.spawn_task` with a single synthesized `TurnInput::UserInput` containing the review prompt, logging a warning if web-search mode cannot be forced to disabled, and sending `EventMsg::EnteredReviewMode`. It returns no value.

**Call relations**: This routine is invoked when the session subsystem decides to fork work into a review sub-thread. Within that flow it delegates object construction to several `new` constructors (`TurnMetadataState`, `ExtensionData`, `HostLoadedSkills`, `TurnSkillsContext`, `ReviewTask`, and default timing/error state), asks shell/tool helpers to derive the unified execution shell mode, and relies on session methods to actually run the child task and publish the mode-change event. Its role is the orchestration boundary between an already-running parent turn and the independently executing review task.

*Call graph*: calls 7 internal fn (new, new, new, tool_user_shell_type, new, new, for_session); 8 external calls (new, new, new, unified_exec_feature_mode_for_features, default, EnteredReviewMode, warn!, vec!).


### `core/src/guardian/review_session.rs`

`orchestration` · `during guardian review execution and guardian session reuse`

This file implements the guardian review session cache and execution model. A `GuardianReviewSessionManager` owns a serialized state containing an optional reusable trunk session and a list of active ephemeral forked sessions. Reuse is controlled by `GuardianReviewSessionReuseKey`, which captures only spawn-time settings that affect nested-session behavior: model/provider details, permissions, instructions, cwd, MCP servers, managed features, and related execution knobs. If the cached trunk’s reuse key no longer matches, it is replaced when idle; if the trunk is busy, parallel reviews run in ephemeral forked sessions seeded from the trunk’s last committed rollout snapshot.

Each `GuardianReviewSession` wraps a `Codex` thread, a cancellation token, a single-permit semaphore to serialize trunk reviews, and mutable review state tracking prior review count, the last reviewed transcript cursor, and the last committed fork snapshot. `run_review_on_session` decides whether to send a full or delta prompt, optionally injects a one-time follow-up reminder after the first review, syncs approved hosts from the parent session, submits a read-only `Op::UserInput` with `approval_policy = never`, then waits for the matching child turn to complete while ignoring stale events from prior turns. On success it updates token-usage deltas and transcript cursor state. The file also builds the locked-down guardian config by clearing developer instructions, disabling memories/MCP/apps/plugins/hooks and other nonessential features, forcing read-only permissions, and optionally rebuilding network proxy permissions from live proxy state.

#### Function details

##### `had_prior_review_context`  (lines 117–119)

```
fn had_prior_review_context(prompt_mode: &GuardianPromptMode) -> bool
```

**Purpose**: Reports whether the current guardian prompt mode represents a follow-up review with prior context.

**Data flow**: Matches the supplied `GuardianPromptMode` and returns true only for `Delta { .. }`.

**Call relations**: Used by `run_review_on_session` to populate analytics metadata about whether the guardian saw prior review context.

*Call graph*: called by 1 (run_review_on_session); 1 external calls (matches!).


##### `token_usage_delta`  (lines 121–130)

```
fn token_usage_delta(start: &TokenUsage, end: &TokenUsage) -> TokenUsage
```

**Purpose**: Computes non-negative token-usage growth across a guardian review turn.

**Data flow**: Reads starting and ending `TokenUsage` snapshots, subtracts each field, clamps negative differences to zero with `.max(0)`, and returns a new `TokenUsage` containing the deltas.

**Call relations**: Called by `run_review_on_session` after a successful nested review to attribute only the current review’s token consumption.

*Call graph*: called by 1 (run_review_on_session).


##### `GuardianReviewSessionReuseKey::from_spawn_config`  (lines 172–198)

```
fn from_spawn_config(
        spawn_config: &Config,
        user_instructions: Option<UserInstructions>,
    ) -> Self
```

**Purpose**: Extracts the subset of `Config` and user-instruction state that determines whether a guardian review session can be safely reused.

**Data flow**: Reads a `spawn_config` and optional `UserInstructions`, clones the relevant fields into a new `GuardianReviewSessionReuseKey`, and returns it.

**Call relations**: Used whenever the manager compares a cached trunk session to a new review request, and by tests that verify reuse invalidation behavior.

*Call graph*: called by 7 (cache_for_test, register_ephemeral_for_test, run_review, guardian_review_session_compact_scope_change_invalidates_cached_session, guardian_review_session_config_change_invalidates_cached_session, run_review_removes_trunk_when_event_stream_is_broken, test_review_session).


##### `prompt_cache_key_override_for_review_session`  (lines 201–213)

```
fn prompt_cache_key_override_for_review_session(
    session_source: &SessionSource,
    parent_thread_id: Option<ThreadId>,
) -> Option<String>
```

**Purpose**: Builds the stable Responses API prompt-cache key used by guardian review sessions, scoped to the parent thread ID.

**Data flow**: Examines `session_source`; if it is `SessionSource::SubAgent(SubAgentSource::Other(name))` with `name == GUARDIAN_REVIEWER_NAME` and `parent_thread_id` is present, it returns `Some(format!("guardian:{parent_thread_id}"))`; otherwise it returns `None`.

**Call relations**: Used by tests and by surrounding session machinery to ensure guardian prompt caching is shared across reviews of the same parent thread but isolated across different parent threads.

*Call graph*: called by 1 (guardian_prompt_cache_key_is_scoped_to_parent_thread); 1 external calls (format!).


##### `GuardianReviewSession::shutdown`  (lines 216–219)

```
async fn shutdown(&self)
```

**Purpose**: Cancels and fully shuts down a guardian review session’s underlying Codex thread.

**Data flow**: Cancels the session’s `CancellationToken`, awaits `codex.shutdown_and_wait()`, ignores its result, and returns nothing.

**Call relations**: Called during manager shutdown and cleanup of stale trunk or ephemeral sessions.

*Call graph*: calls 1 internal fn (shutdown_and_wait); 1 external calls (cancel).


##### `GuardianReviewSession::shutdown_in_background`  (lines 221–226)

```
fn shutdown_in_background(self: &Arc<Self>)
```

**Purpose**: Schedules asynchronous shutdown of a guardian review session without blocking the caller.

**Data flow**: Clones the `Arc<Self>`, spawns a Tokio task that awaits `shutdown()`, and drops the join handle.

**Call relations**: Used when stale or completed sessions should be torn down opportunistically after the manager has already moved on.

*Call graph*: 2 external calls (clone, spawn).


##### `GuardianReviewSession::fork_snapshot`  (lines 228–230)

```
async fn fork_snapshot(&self) -> Option<GuardianReviewForkSnapshot>
```

**Purpose**: Returns the last committed fork snapshot, if any, from a guardian review session.

**Data flow**: Locks the session state, clones `last_committed_fork_snapshot`, and returns the optional snapshot.

**Call relations**: Called when a busy trunk needs to seed an ephemeral fork with the latest committed guardian history.


##### `GuardianReviewSession::refresh_last_committed_fork_snapshot`  (lines 232–250)

```
async fn refresh_last_committed_fork_snapshot(&self)
```

**Purpose**: Refreshes the trunk session’s reusable fork snapshot from its persisted rollout history after a successful review. This snapshot is what parallel ephemeral reviews inherit.

**Data flow**: Calls `load_rollout_items_for_fork(&self.codex.session)`. If it gets a non-empty item list, it locks state, reads `prior_review_count` and `last_reviewed_transcript_cursor`, and stores a new `GuardianReviewForkSnapshot { initial_history: InitialHistory::Forked(items), ... }`. Empty, absent, or failed loads are ignored except for a warning on error.

**Call relations**: Called by `GuardianReviewSessionManager::run_review` after a successful trunk review that should keep the session reusable.

*Call graph*: calls 1 internal fn (load_rollout_items_for_fork); 2 external calls (Forked, warn!).


##### `EphemeralReviewCleanup::new`  (lines 254–262)

```
fn new(
        state: Arc<Mutex<GuardianReviewSessionState>>,
        review_session: Arc<GuardianReviewSession>,
    ) -> Self
```

**Purpose**: Creates a drop guard that will unregister and shut down an ephemeral review session unless explicitly disarmed.

**Data flow**: Stores the shared manager state and wraps the supplied `Arc<GuardianReviewSession>` in `Some(...)` inside the cleanup struct.

**Call relations**: Constructed by `run_ephemeral_review` immediately after registering an active ephemeral session.

*Call graph*: called by 1 (run_ephemeral_review).


##### `EphemeralReviewCleanup::disarm`  (lines 264–266)

```
fn disarm(&mut self)
```

**Purpose**: Disables the drop-time cleanup action for an ephemeral review session.

**Data flow**: Sets `self.review_session` to `None` and returns nothing.

**Call relations**: Called when `run_ephemeral_review` has already removed and scheduled shutdown for the ephemeral session explicitly.


##### `EphemeralReviewCleanup::drop`  (lines 270–288)

```
fn drop(&mut self)
```

**Purpose**: On scope exit, removes the tracked ephemeral session from manager state and shuts it down in the background if it was not disarmed.

**Data flow**: Takes ownership of the optional review session, clones the shared state, spawns an async task that locks manager state, finds the matching ephemeral session by `Arc::ptr_eq`, removes it with `swap_remove`, and then awaits `shutdown()` on the removed session.

**Call relations**: Provides fail-safe cleanup for `run_ephemeral_review` so leaked or early-returned ephemeral sessions do not remain registered.

*Call graph*: 2 external calls (clone, spawn).


##### `GuardianReviewSessionManager::trunk_rollout_path`  (lines 292–302)

```
async fn trunk_rollout_path(&self) -> Option<PathBuf>
```

**Purpose**: Returns the materialized rollout path for the cached guardian trunk session, if one exists.

**Data flow**: Locks manager state to clone the trunk session, asks the trunk session to ensure rollout materialization, then queries `current_rollout_path()`. It returns `Some(PathBuf)` on success or `None` if there is no trunk or path resolution fails, logging a warning on error.

**Call relations**: Used by external code that needs to inspect the guardian trunk’s persisted rollout artifacts.

*Call graph*: 1 external calls (warn!).


##### `GuardianReviewSessionManager::shutdown`  (lines 304–318)

```
async fn shutdown(&self)
```

**Purpose**: Shuts down the cached trunk session and all active ephemeral guardian review sessions.

**Data flow**: Locks manager state, takes ownership of `trunk` and drains `ephemeral_reviews`, then sequentially awaits `shutdown()` on each session. It returns nothing.

**Call relations**: Called during broader session/service teardown to stop all nested guardian review threads.

*Call graph*: 1 external calls (take).


##### `GuardianReviewSessionManager::run_review`  (lines 324–449)

```
async fn run_review(
        &self,
        params: GuardianReviewSessionParams,
    ) -> (GuardianReviewSessionOutcome, GuardianReviewAnalyticsResult)
```

**Purpose**: Selects or spawns the appropriate guardian review session, runs the review on it before the deadline, and decides whether the session remains reusable afterward. It is the manager’s main orchestration entrypoint.

**Data flow**: Consumes `GuardianReviewSessionParams`. It computes the next reuse key from the spawn config and parent user instructions, acquires the serialized manager state under deadline/cancellation control, optionally evicts a stale idle trunk whose reuse key changed, spawns a new trunk if none exists, and then chooses among three paths: use the trunk directly if its reuse key matches and its semaphore can be acquired; run an ephemeral fork if the trunk is busy; or run an ephemeral session if the trunk’s reuse key no longer matches. After `run_review_on_session`, it refreshes the trunk’s committed fork snapshot on successful reusable completion, drops the trunk lock, and either keeps the session cached or removes and background-shuts it down if the review indicated the session should not be kept. It returns `(GuardianReviewSessionOutcome, GuardianReviewAnalyticsResult)`.

**Call relations**: Called by higher-level guardian review orchestration. It delegates spawning to `spawn_guardian_review_session`, actual review execution to `run_review_on_session`, deadline wrapping to `run_before_review_deadline` / `_with_cancel`, and fallback parallelism to `run_ephemeral_review`.

*Call graph*: calls 8 internal fn (without_session, remove_trunk_if_current, run_ephemeral_review, from_spawn_config, run_before_review_deadline, run_before_review_deadline_with_cancel, run_review_on_session, spawn_guardian_review_session); 8 external calls (clone, new, pin, new, anyhow!, Completed, PromptBuildFailed, matches!).


##### `GuardianReviewSessionManager::cache_for_test`  (lines 452–468)

```
async fn cache_for_test(&self, codex: Codex)
```

**Purpose**: Installs a supplied `Codex` instance as the cached trunk guardian session for tests.

**Data flow**: Builds a reuse key from the codex session config and user instructions, wraps the codex in a new `GuardianReviewSession` with fresh cancellation token, semaphore, and empty review state, and stores it as `state.trunk`.

**Call relations**: Used only by tests that need to seed manager state without going through real spawning.

*Call graph*: calls 1 internal fn (from_spawn_config); 4 external calls (new, new, new, new).


##### `GuardianReviewSessionManager::register_ephemeral_for_test`  (lines 471–491)

```
async fn register_ephemeral_for_test(&self, codex: Codex)
```

**Purpose**: Registers a supplied `Codex` instance as an active ephemeral guardian session for tests.

**Data flow**: Builds a reuse key from the codex session config and user instructions, wraps the codex in a new `GuardianReviewSession`, and pushes it into `state.ephemeral_reviews`.

**Call relations**: Test helper for exercising ephemeral-session bookkeeping.

*Call graph*: calls 1 internal fn (from_spawn_config); 4 external calls (new, new, new, new).


##### `GuardianReviewSessionManager::committed_fork_rollout_items_for_test`  (lines 494–502)

```
async fn committed_fork_rollout_items_for_test(&self) -> Option<Vec<RolloutItem>>
```

**Purpose**: Returns the trunk session’s committed fork rollout items for assertions in tests.

**Data flow**: Clones the trunk session, locks its state, reads `last_committed_fork_snapshot`, and if its `initial_history` is `InitialHistory::Forked(items)`, returns `Some(items.clone())`; otherwise returns `None`.

**Call relations**: Used by tests that verify follow-up reminders and prior guardian context are persisted into fork snapshots.


##### `GuardianReviewSessionManager::send_trunk_event_raw_for_test`  (lines 505–514)

```
async fn send_trunk_event_raw_for_test(&self, event: Event)
```

**Purpose**: Injects a raw event into the cached trunk session for tests.

**Data flow**: Clones the trunk session from manager state, panics if absent, and forwards the supplied `Event` to `trunk.codex.session.send_event_raw(event).await`.

**Call relations**: Used by tests that simulate stale or out-of-band events on a reused trunk session.


##### `GuardianReviewSessionManager::remove_trunk_if_current`  (lines 516–530)

```
async fn remove_trunk_if_current(
        &self,
        trunk: &Arc<GuardianReviewSession>,
    ) -> Option<Arc<GuardianReviewSession>>
```

**Purpose**: Atomically removes the cached trunk session only if it is still the same `Arc` instance the caller expects.

**Data flow**: Locks manager state, compares the current trunk with the supplied `Arc<GuardianReviewSession>` using `Arc::ptr_eq`, and returns `state.trunk.take()` on match or `None` otherwise.

**Call relations**: Called by `run_review` when a trunk session should be discarded after a broken event stream or other non-reusable outcome.

*Call graph*: called by 1 (run_review).


##### `GuardianReviewSessionManager::register_active_ephemeral`  (lines 532–538)

```
async fn register_active_ephemeral(&self, review_session: Arc<GuardianReviewSession>)
```

**Purpose**: Adds an ephemeral guardian review session to the manager’s active list.

**Data flow**: Locks manager state and pushes the supplied `Arc<GuardianReviewSession>` into `ephemeral_reviews`.

**Call relations**: Used by `run_ephemeral_review` immediately after spawning a forked session.

*Call graph*: called by 1 (run_ephemeral_review).


##### `GuardianReviewSessionManager::take_active_ephemeral`  (lines 540–550)

```
async fn take_active_ephemeral(
        &self,
        review_session: &Arc<GuardianReviewSession>,
    ) -> Option<Arc<GuardianReviewSession>>
```

**Purpose**: Removes and returns a specific active ephemeral session by pointer identity.

**Data flow**: Locks manager state, finds the matching session in `ephemeral_reviews` with `Arc::ptr_eq`, removes it with `swap_remove`, and returns it as `Some(...)`; returns `None` if not found.

**Call relations**: Called by `run_ephemeral_review` after the review completes so the ephemeral session can be shut down explicitly.

*Call graph*: called by 1 (run_ephemeral_review).


##### `GuardianReviewSessionManager::run_ephemeral_review`  (lines 552–604)

```
async fn run_ephemeral_review(
        &self,
        params: GuardianReviewSessionParams,
        reuse_key: GuardianReviewSessionReuseKey,
        deadline: tokio::time::Instant,
        fork_snapsh
```

**Purpose**: Spawns a forked ephemeral guardian session, runs one review on it, and tears it down afterward. This path is used for parallel reviews or when the trunk cannot be reused directly.

**Data flow**: Clones and marks the spawn config as `ephemeral = true`, creates a spawn cancellation token, spawns the guardian session under deadline/cancellation control via `spawn_guardian_review_session`, registers it as active, installs an `EphemeralReviewCleanup` guard, runs `run_review_on_session` with `GuardianReviewSessionKind::EphemeralForked`, then removes the session from active state, disarms the cleanup guard, and schedules background shutdown. It returns the review outcome and analytics result.

**Call relations**: Called by `run_review` when the trunk is busy or unsuitable. It shares the same review execution path as trunk reviews but always uses a short-lived forked session.

*Call graph*: calls 7 internal fn (without_session, new, register_active_ephemeral, take_active_ephemeral, run_before_review_deadline_with_cancel, run_review_on_session, spawn_guardian_review_session); called by 1 (run_review); 5 external calls (clone, new, pin, new, PromptBuildFailed).


##### `spawn_guardian_review_session`  (lines 607–645)

```
async fn spawn_guardian_review_session(
    params: &GuardianReviewSessionParams,
    spawn_config: Config,
    reuse_key: GuardianReviewSessionReuseKey,
    cancel_token: CancellationToken,
    fork_
```

**Purpose**: Creates a new nested guardian `Codex` thread and wraps it in a `GuardianReviewSession`, optionally seeded from a fork snapshot.

**Data flow**: Reads review params, a `spawn_config`, reuse key, cancellation token, and optional `GuardianReviewForkSnapshot`. It derives `initial_history`, `prior_review_count`, and initial transcript cursor from the snapshot when present, calls `run_codex_thread_interactive(...)` with `SubAgentSource::Other(GUARDIAN_REVIEWER_NAME.to_string())`, and returns a `GuardianReviewSession` containing the new codex, cancellation token, reuse key, semaphore, and initialized review state.

**Call relations**: Used by both trunk and ephemeral session creation paths inside the manager.

*Call graph*: calls 1 internal fn (run_codex_thread_interactive); called by 2 (run_ephemeral_review, run_review); 6 external calls (clone, pin, clone, new, new, Other).


##### `run_review_on_session`  (lines 647–831)

```
async fn run_review_on_session(
    review_session: &GuardianReviewSession,
    params: &GuardianReviewSessionParams,
    guardian_session_kind: GuardianReviewSessionKind,
    deadline: tokio::time::I
```

**Purpose**: Runs a single guardian review on an already spawned guardian session, handling prompt mode selection, prompt construction, nested turn submission, event waiting, analytics enrichment, and reusable-session state updates.

**Data flow**: Reads the target `review_session`, immutable review `params`, session kind, and deadline. It locks session state to decide whether to send the one-time follow-up reminder and whether prompt mode is `Full` or `Delta` based on `prior_review_count` and `last_reviewed_transcript_cursor`. It resolves model info, computes the effective guardian reasoning effort, initializes `GuardianReviewAnalyticsResult::from_session(...)`, optionally injects the follow-up reminder, syncs approved hosts from the parent session, builds prompt items with `build_guardian_prompt_items_with_parent_turn` under deadline control, snapshots starting token usage, submits `Op::UserInput` with read-only thread settings and the supplied JSON schema, waits for the matching child turn via `wait_for_guardian_review`, and on successful completion updates token-usage delta, increments `prior_review_count`, and stores the new transcript cursor. It returns `(GuardianReviewSessionOutcome, keep_review_session, GuardianReviewAnalyticsResult)`.

**Call relations**: Called by both trunk and ephemeral review paths. It delegates prompt building, reminder injection, deadline wrapping, token delta computation, and event waiting to the helpers in this file and the prompt module.

*Call graph*: calls 9 internal fn (from_session, build_guardian_prompt_items_with_parent_turn, append_guardian_followup_reminder, had_prior_review_context, run_before_review_deadline, token_usage_delta, wait_for_guardian_review, read_only, new); called by 3 (run_ephemeral_review, run_review, run_review_on_reused_session_waits_for_submitted_turn); 4 external calls (pin, default, PromptBuildFailed, matches!).


##### `append_guardian_followup_reminder`  (lines 833–840)

```
async fn append_guardian_followup_reminder(review_session: &GuardianReviewSession)
```

**Purpose**: Injects the one-time contextual reminder that prior guardian reviews are context, not binding precedent.

**Data flow**: Converts `GuardianFollowupReviewReminder` into a `ResponseItem` via `ContextualUserFragment::into`, then calls `inject_no_new_turn` on the guardian session with a one-item vector.

**Call relations**: Called by `run_review_on_session` only when `prior_review_count == 1`, so the reminder appears on the second and later reviews but is injected only once into the reusable guardian thread.

*Call graph*: calls 1 internal fn (into); called by 1 (run_review_on_session); 1 external calls (vec!).


##### `load_rollout_items_for_fork`  (lines 842–850)

```
async fn load_rollout_items_for_fork(
    session: &Session,
) -> anyhow::Result<Option<Vec<RolloutItem>>>
```

**Purpose**: Loads the persisted rollout history needed to fork a guardian session from its last committed state.

**Data flow**: Ensures rollout materialization, flushes rollout state, obtains the live thread for persistence, loads full history including archived items, and returns `Ok(Some(history.items))`.

**Call relations**: Used by `GuardianReviewSession::refresh_last_committed_fork_snapshot` to capture the trunk’s reusable fork baseline.

*Call graph*: called by 1 (refresh_last_committed_fork_snapshot); 3 external calls (flush_rollout, live_thread_for_persistence, try_ensure_rollout_materialized).


##### `wait_for_guardian_review`  (lines 852–934)

```
async fn wait_for_guardian_review(
    review_session: &GuardianReviewSession,
    expected_turn_id: &str,
    deadline: tokio::time::Instant,
    external_cancel: Option<&CancellationToken>,
    anal
```

**Purpose**: Waits for the submitted guardian child turn to finish, ignoring stale events from prior turns and handling timeout/cancellation by interrupting and draining the expected turn. It also captures TTFT and preserves structured session errors when possible.

**Data flow**: Reads the `review_session`, `expected_turn_id`, deadline, optional external cancel token, and mutable analytics result. It pins a sleep-until-deadline future, tracks the last `ErrorEvent` seen for the expected turn, and loops over `tokio::select!` between deadline expiry, external cancellation, and `codex.next_event()`. Non-matching-turn events are ignored. For matching events: `TurnComplete` stores `time_to_first_token_ms`; if there is no `last_agent_message` but a prior matching `ErrorEvent` exists, it returns `SessionFailed { error, error_info }`; otherwise it returns `Completed(Ok(last_agent_message))`. `Error` updates `last_error`, `TurnAborted` returns `Aborted`, and stream errors return `Completed(Err(...))` with `keep_review_session = false`. Timeout or cancellation first call `interrupt_and_drain_turn` and return `TimedOut` or `Aborted` plus whether the session remained drainable.

**Call relations**: Called by `run_review_on_session` after submitting the nested guardian turn. It relies on `event_matches_turn` and `interrupt_and_drain_turn` to avoid stale-turn confusion and to preserve session reusability after interruption.

*Call graph*: called by 7 (run_review_on_session, wait_for_guardian_review_cancel_drains_expected_turn_after_stale_terminal_event, wait_for_guardian_review_ignores_prior_turn_aborts, wait_for_guardian_review_ignores_prior_turn_completion, wait_for_guardian_review_ignores_prior_turn_errors, wait_for_guardian_review_preserves_structured_session_error, wait_for_guardian_review_timeout_drains_expected_turn_after_stale_terminal_event); 3 external calls (pin!, select!, sleep_until).


##### `event_matches_turn`  (lines 936–948)

```
fn event_matches_turn(event: &Event, expected_turn_id: &str) -> bool
```

**Purpose**: Determines whether an incoming event belongs to the expected guardian child turn.

**Data flow**: Compares `event.id` to `expected_turn_id`, then for terminal events additionally checks the embedded `turn_id` fields inside `TurnComplete` and `TurnAborted`. It returns a boolean.

**Call relations**: Used by `wait_for_guardian_review` and `interrupt_and_drain_turn` to ignore stale events from earlier guardian turns on a reused session.

*Call graph*: called by 1 (interrupt_and_drain_turn).


##### `build_guardian_review_session_config`  (lines 950–1026)

```
fn build_guardian_review_session_config(
    parent_config: &Config,
    live_network_config: Option<codex_network_proxy::NetworkProxyConfig>,
    active_model: &str,
    reasoning_effort: Option<code
```

**Purpose**: Derives the locked-down configuration used for nested guardian review sessions from the parent config and live network state. It strips mutable or user-extensible features while preserving the guardian policy and relevant network constraints.

**Data flow**: Clones `parent_config`, overwrites `model` and `model_reasoning_effort`, reduces provider retries to 1, disables skill instructions, memories, dedicated memory tools, apps instructions, notifications, and developer instructions, sets `base_instructions` to either the default guardian policy prompt or a workspace-managed override, forces `approval_policy = never`, sets `PermissionProfile::read_only()`, clears MCP servers, optionally rebuilds `permissions.network` from `live_network_config` and config-layer constraints, and attempts to disable a fixed list of features (`SpawnCsv`, `Collab`, `MultiAgentV2`, `CodexHooks`, `Apps`, `Plugins`, `WebSearchRequest`, `WebSearchCached`), warning if a pinned feature remains enabled. It returns the new `Config` or an error if required mutations fail.

**Call relations**: Called by higher-level guardian review orchestration before spawning or reusing a guardian session. Tests in this file and `guardian/tests.rs` verify many of its invariants.

*Call graph*: calls 3 internal fn (allow_only, from_config_and_constraints, read_only); called by 6 (run_guardian_review_session_before_deadline, guardian_review_session_compact_scope_change_invalidates_cached_session, guardian_review_session_config_change_invalidates_cached_session, guardian_review_session_config_disables_hooks, guardian_review_session_config_disables_skill_instructions, test_review_params); 3 external calls (new, clone, warn!).


##### `run_before_review_deadline`  (lines 1028–1044)

```
async fn run_before_review_deadline(
    deadline: tokio::time::Instant,
    external_cancel: Option<&CancellationToken>,
    future: impl Future<Output = T>,
) -> Result<T, GuardianReviewSessionOutco
```

**Purpose**: Runs an arbitrary future but converts deadline expiry or external cancellation into `GuardianReviewSessionOutcome` values.

**Data flow**: Takes a deadline, optional external cancel token, and a future. It `tokio::select!`s between sleeping until the deadline, awaiting the future, and awaiting cancellation. It returns `Ok(result)` on success, `Err(TimedOut)` on deadline, or `Err(Aborted)` on cancellation.

**Call relations**: Used throughout manager and review execution code to ensure prompt building, state locking, spawning, and submission all respect the guardian review deadline.

*Call graph*: called by 5 (run_review, run_before_review_deadline_with_cancel, run_review_on_session, run_before_review_deadline_aborts_when_cancelled, run_before_review_deadline_times_out_before_future_completes); 1 external calls (select!).


##### `run_before_review_deadline_with_cancel`  (lines 1046–1057)

```
async fn run_before_review_deadline_with_cancel(
    deadline: tokio::time::Instant,
    external_cancel: Option<&CancellationToken>,
    cancel_token: &CancellationToken,
    future: impl Future<Outp
```

**Purpose**: Wraps `run_before_review_deadline` and additionally cancels a supplied internal token when the operation times out or is aborted.

**Data flow**: Runs `run_before_review_deadline(...)`, and if the result is an error, calls `cancel_token.cancel()`. It returns the original `Result<T, GuardianReviewSessionOutcome>`.

**Call relations**: Used around guardian session spawning so a timed-out or aborted spawn attempt also cancels the in-flight nested session startup.

*Call graph*: calls 1 internal fn (run_before_review_deadline); called by 5 (run_ephemeral_review, run_review, run_before_review_deadline_with_cancel_cancels_token_on_abort, run_before_review_deadline_with_cancel_cancels_token_on_timeout, run_before_review_deadline_with_cancel_preserves_token_on_success); 1 external calls (cancel).


##### `interrupt_and_drain_turn`  (lines 1059–1079)

```
async fn interrupt_and_drain_turn(codex: &Codex, expected_turn_id: &str) -> anyhow::Result<()>
```

**Purpose**: Interrupts the current guardian child turn and drains events until that specific turn reaches a terminal state, ignoring stale terminal events from prior turns.

**Data flow**: Submits `Op::Interrupt` to the `Codex`, then waits up to `GUARDIAN_INTERRUPT_DRAIN_TIMEOUT` for `codex.next_event()` to yield a matching-turn `TurnAborted` or `TurnComplete`, using `event_matches_turn` to ignore unrelated events. It returns `Ok(())` on successful drain or an error if the timeout expires or event retrieval fails.

**Call relations**: Called by `wait_for_guardian_review` on timeout or cancellation to preserve session reusability by draining the interrupted turn cleanly.

*Call graph*: calls 3 internal fn (event_matches_turn, next_event, submit); called by 1 (interrupt_and_drain_turn_ignores_prior_turn_completion); 2 external calls (matches!, timeout).


##### `tests::test_review_session`  (lines 1091–1127)

```
async fn test_review_session() -> (
        GuardianReviewSession,
        async_channel::Sender<Event>,
        async_channel::Receiver<Submission>,
    )
```

**Purpose**: Builds a lightweight in-memory `GuardianReviewSession` plus channels for injecting events and observing submissions in tests.

**Data flow**: Creates a session/context fixture, bounded submission and unbounded event channels, a watch channel for agent status, derives a reuse key from the session config, and returns `(GuardianReviewSession, tx_event, rx_sub)`.

**Call relations**: Shared fixture for the review-session tests that simulate nested turn submissions and event streams.

*Call graph*: calls 3 internal fn (from_spawn_config, completed_session_loop_termination, make_session_and_context_with_rx); 6 external calls (new, new, new, bounded, unbounded, channel).


##### `tests::turn_complete_event`  (lines 1129–1144)

```
fn turn_complete_event(
        turn_id: &str,
        last_agent_message: Option<&str>,
        time_to_first_token_ms: Option<i64>,
    ) -> Event
```

**Purpose**: Constructs a synthetic `EventMsg::TurnComplete` event for a given turn ID, optional last agent message, and optional TTFT.

**Data flow**: Builds and returns an `Event` with matching outer `id` and inner `TurnCompleteEvent` fields.

**Call relations**: Used by tests that feed terminal events into `wait_for_guardian_review` and `run_review_on_session`.

*Call graph*: 1 external calls (TurnComplete).


##### `tests::turn_aborted_event`  (lines 1146–1156)

```
fn turn_aborted_event(turn_id: &str) -> Event
```

**Purpose**: Constructs a synthetic `EventMsg::TurnAborted` event for a given turn ID.

**Data flow**: Builds and returns an `Event` containing `TurnAbortedEvent { turn_id: Some(...), reason: Interrupted, ... }`.

**Call relations**: Used by tests that simulate interrupted guardian turns.

*Call graph*: 1 external calls (TurnAborted).


##### `tests::test_review_params`  (lines 1158–1199)

```
async fn test_review_params() -> GuardianReviewSessionParams
```

**Purpose**: Builds a representative `GuardianReviewSessionParams` fixture for tests, including a shell approval request and guardian session config.

**Data flow**: Creates a session/turn fixture, derives model and reasoning settings from the turn, builds guardian config with `build_guardian_review_session_config`, constructs a shell `GuardianApprovalRequest`, and returns a populated `GuardianReviewSessionParams` with a near-future deadline.

**Call relations**: Shared by tests that exercise manager and session execution behavior.

*Call graph*: calls 3 internal fn (guardian_output_schema, build_guardian_review_session_config, make_session_and_context); 4 external calls (new, from_secs, now, vec!).


##### `tests::guardian_review_session_config_change_invalidates_cached_session`  (lines 1202–1239)

```
async fn guardian_review_session_config_change_invalidates_cached_session()
```

**Purpose**: Verifies that changing a spawn-relevant config field changes the guardian session reuse key.

**Data flow**: Builds a cached guardian config and reuse key, mutates the parent config’s provider base URL, rebuilds the guardian config and reuse key, and asserts the keys differ while recomputing the original key remains stable.

**Call relations**: Tests `GuardianReviewSessionReuseKey::from_spawn_config` and the reuse invalidation policy.

*Call graph*: calls 3 internal fn (test_config, from_spawn_config, build_guardian_review_session_config); 2 external calls (assert_eq!, assert_ne!).


##### `tests::guardian_prompt_cache_key_is_scoped_to_parent_thread`  (lines 1242–1279)

```
async fn guardian_prompt_cache_key_is_scoped_to_parent_thread()
```

**Purpose**: Verifies that guardian prompt-cache keys are stable per parent thread, differ across parent threads, and are absent for non-guardian or missing-parent cases.

**Data flow**: Constructs a guardian `SessionSource`, generates thread IDs, calls `prompt_cache_key_override_for_review_session` under several scenarios, and asserts equality, inequality, and `None` cases.

**Call relations**: Tests the prompt-cache-key helper used to stabilize guardian prompt caching.

*Call graph*: calls 2 internal fn (prompt_cache_key_override_for_review_session, new); 5 external calls (SubAgent, assert!, assert_eq!, assert_ne!, Other).


##### `tests::guardian_review_session_compact_scope_change_invalidates_cached_session`  (lines 1282–1312)

```
async fn guardian_review_session_compact_scope_change_invalidates_cached_session()
```

**Purpose**: Verifies that changing auto-compaction scope affects the guardian session reuse key.

**Data flow**: Builds a baseline guardian config and reuse key, mutates `model_auto_compact_token_limit_scope`, rebuilds, and asserts the reuse key changes.

**Call relations**: Another reuse-key invalidation test covering compaction-related config.

*Call graph*: calls 3 internal fn (test_config, from_spawn_config, build_guardian_review_session_config); 1 external calls (assert_ne!).


##### `tests::guardian_review_session_config_disables_hooks`  (lines 1315–1331)

```
async fn guardian_review_session_config_disables_hooks()
```

**Purpose**: Checks that guardian session config disables the `CodexHooks` feature even if the parent config enabled it.

**Data flow**: Enables hooks on a parent config, builds guardian config, and asserts the resulting feature flag is disabled.

**Call relations**: Tests one of the hardening invariants enforced by `build_guardian_review_session_config`.

*Call graph*: calls 2 internal fn (test_config, build_guardian_review_session_config); 1 external calls (assert!).


##### `tests::guardian_review_session_config_disables_skill_instructions`  (lines 1334–1347)

```
async fn guardian_review_session_config_disables_skill_instructions()
```

**Purpose**: Checks that guardian session config disables skill instructions inherited from the parent config.

**Data flow**: Sets `include_skill_instructions = true` on the parent config, builds guardian config, and asserts the guardian config has it disabled.

**Call relations**: Tests another hardening invariant of guardian session config.

*Call graph*: calls 2 internal fn (test_config, build_guardian_review_session_config); 1 external calls (assert!).


##### `tests::run_before_review_deadline_times_out_before_future_completes`  (lines 1350–1364)

```
async fn run_before_review_deadline_times_out_before_future_completes()
```

**Purpose**: Verifies that `run_before_review_deadline` returns `TimedOut` when the deadline expires before the future finishes.

**Data flow**: Runs the helper with a short deadline and a longer sleep future, awaits the result, and asserts it is `Err(TimedOut)`.

**Call relations**: Tests the deadline branch of the generic deadline wrapper.

*Call graph*: calls 1 internal fn (run_before_review_deadline); 4 external calls (from_millis, assert!, now, sleep).


##### `tests::run_before_review_deadline_aborts_when_cancelled`  (lines 1367–1386)

```
async fn run_before_review_deadline_aborts_when_cancelled()
```

**Purpose**: Verifies that `run_before_review_deadline` returns `Aborted` when the external cancellation token fires first.

**Data flow**: Creates a cancellation token, spawns a task to cancel it shortly, runs the helper with a pending future, and asserts the result is `Err(Aborted)`.

**Call relations**: Tests the cancellation branch of the generic deadline wrapper.

*Call graph*: calls 1 internal fn (run_before_review_deadline); 7 external calls (new, from_millis, from_secs, assert!, spawn, now, sleep).


##### `tests::run_before_review_deadline_with_cancel_cancels_token_on_timeout`  (lines 1389–1407)

```
async fn run_before_review_deadline_with_cancel_cancels_token_on_timeout()
```

**Purpose**: Verifies that the internal cancel token is cancelled when the wrapped operation times out.

**Data flow**: Runs `run_before_review_deadline_with_cancel` with a short deadline and a longer sleep future, asserts the result is `Err(TimedOut)`, and checks `cancel_token.is_cancelled()`.

**Call relations**: Tests the timeout side effect of the cancel-propagating wrapper.

*Call graph*: calls 1 internal fn (run_before_review_deadline_with_cancel); 5 external calls (new, from_millis, assert!, now, sleep).


##### `tests::run_before_review_deadline_with_cancel_cancels_token_on_abort`  (lines 1410–1432)

```
async fn run_before_review_deadline_with_cancel_cancels_token_on_abort()
```

**Purpose**: Verifies that the internal cancel token is cancelled when the wrapped operation is externally aborted.

**Data flow**: Creates external and internal cancellation tokens, schedules external cancellation, runs the helper with a pending future, and asserts both `Err(Aborted)` and internal token cancellation.

**Call relations**: Tests the abort side effect of the cancel-propagating wrapper.

*Call graph*: calls 1 internal fn (run_before_review_deadline_with_cancel); 7 external calls (new, from_millis, from_secs, assert!, spawn, now, sleep).


##### `tests::run_before_review_deadline_with_cancel_preserves_token_on_success`  (lines 1435–1448)

```
async fn run_before_review_deadline_with_cancel_preserves_token_on_success()
```

**Purpose**: Verifies that the internal cancel token remains untouched when the wrapped operation succeeds before deadline or cancellation.

**Data flow**: Runs the helper with a successful immediate future, asserts the returned value, and checks that the cancel token is not cancelled.

**Call relations**: Tests the success path of the cancel-propagating wrapper.

*Call graph*: calls 1 internal fn (run_before_review_deadline_with_cancel); 5 external calls (new, from_secs, assert!, assert_eq!, now).


##### `tests::had_prior_review_context_tracks_prompt_mode`  (lines 1451–1459)

```
fn had_prior_review_context_tracks_prompt_mode()
```

**Purpose**: Verifies that only delta prompt mode is reported as having prior review context.

**Data flow**: Calls `had_prior_review_context` with `Full` and `Delta` prompt modes and asserts false/true respectively.

**Call relations**: Tests the analytics helper used by `run_review_on_session`.

*Call graph*: 1 external calls (assert!).


##### `tests::token_usage_delta_never_reports_negative_usage`  (lines 1462–1488)

```
fn token_usage_delta_never_reports_negative_usage()
```

**Purpose**: Verifies that token-usage deltas clamp negative differences to zero.

**Data flow**: Constructs start and end `TokenUsage` values with some decreasing fields, calls `token_usage_delta`, and asserts the returned struct contains only non-negative deltas.

**Call relations**: Tests the token accounting helper used after successful guardian reviews.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::run_review_on_reused_session_waits_for_submitted_turn`  (lines 1491–1534)

```
async fn run_review_on_reused_session_waits_for_submitted_turn()
```

**Purpose**: Verifies that a reused guardian session ignores stale prior-turn completion events and waits for the completion of the newly submitted child turn.

**Data flow**: Creates a test review session with prior-review state, spawns `run_review_on_session`, receives the submitted child turn ID from the submission channel, injects a stale prior-turn completion followed by the real completion for the submitted turn, and asserts the outcome uses the fresh message and TTFT.

**Call relations**: Exercises the interaction between `run_review_on_session`, submission, and `wait_for_guardian_review` on reused sessions.

*Call graph*: calls 1 internal fn (run_review_on_session); 9 external calls (from_secs, assert!, assert_eq!, test_review_params, test_review_session, turn_complete_event, panic!, spawn, now).


##### `tests::run_review_removes_trunk_when_event_stream_is_broken`  (lines 1537–1559)

```
async fn run_review_removes_trunk_when_event_stream_is_broken()
```

**Purpose**: Verifies that the manager discards the cached trunk session when its event stream is broken.

**Data flow**: Seeds a manager with a trunk review session, drops the event sender to break the stream, runs `manager.run_review`, and asserts the outcome is a completed error and the trunk cache is now empty.

**Call relations**: Tests the non-reusable-session path in `GuardianReviewSessionManager::run_review`.

*Call graph*: calls 1 internal fn (from_spawn_config); 6 external calls (new, new, new, assert!, test_review_params, test_review_session).


##### `tests::wait_for_guardian_review_ignores_prior_turn_completion`  (lines 1562–1590)

```
async fn wait_for_guardian_review_ignores_prior_turn_completion()
```

**Purpose**: Verifies that waiting for a guardian review ignores stale completion events from earlier turns and captures TTFT from the expected turn.

**Data flow**: Injects a prior-turn completion and then a current-turn completion into a test session, calls `wait_for_guardian_review`, and asserts it returns the current turn’s message, TTFT, and token-usage capture flag.

**Call relations**: Directly tests stale-event filtering in `wait_for_guardian_review`.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 7 external calls (from_secs, assert!, assert_eq!, test_review_session, turn_complete_event, panic!, now).


##### `tests::wait_for_guardian_review_ignores_prior_turn_errors`  (lines 1593–1631)

```
async fn wait_for_guardian_review_ignores_prior_turn_errors()
```

**Purpose**: Verifies that stale error events from prior turns do not poison the current guardian review outcome.

**Data flow**: Injects a prior-turn `ErrorEvent` and then a current-turn completion with no message, calls `wait_for_guardian_review`, and asserts it still returns a completed outcome for the current turn rather than surfacing the stale error.

**Call relations**: Tests that `last_error` is only meaningful for the expected turn.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 8 external calls (from_secs, assert!, assert_eq!, test_review_session, turn_complete_event, panic!, Error, now).


##### `tests::wait_for_guardian_review_preserves_structured_session_error`  (lines 1634–1672)

```
async fn wait_for_guardian_review_preserves_structured_session_error()
```

**Purpose**: Verifies that a matching-turn error followed by a completion without a final message is surfaced as `SessionFailed` with preserved structured `CodexErrorInfo`.

**Data flow**: Injects a current-turn `ErrorEvent` carrying `ServerOverloaded`, then a current-turn completion with no message, calls `wait_for_guardian_review`, and asserts the returned outcome is `SessionFailed { error, error_info }` with the original values.

**Call relations**: Tests the structured-error preservation branch in `wait_for_guardian_review`.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 8 external calls (from_secs, assert!, assert_eq!, test_review_session, turn_complete_event, panic!, Error, now).


##### `tests::wait_for_guardian_review_ignores_prior_turn_aborts`  (lines 1675–1703)

```
async fn wait_for_guardian_review_ignores_prior_turn_aborts()
```

**Purpose**: Verifies that stale abort events from prior turns do not terminate the current guardian review wait.

**Data flow**: Injects a prior-turn abort and then a current-turn completion, calls `wait_for_guardian_review`, and asserts it returns the current turn’s successful completion.

**Call relations**: Another stale-event filtering test for `wait_for_guardian_review`.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 8 external calls (from_secs, assert!, assert_eq!, test_review_session, turn_aborted_event, turn_complete_event, panic!, now).


##### `tests::wait_for_guardian_review_timeout_drains_expected_turn_after_stale_terminal_event`  (lines 1706–1738)

```
async fn wait_for_guardian_review_timeout_drains_expected_turn_after_stale_terminal_event()
```

**Purpose**: Verifies that timeout handling interrupts and drains the expected turn even when a stale terminal event was seen earlier.

**Data flow**: Injects a stale prior-turn completion, arranges for the next submission to be an `Op::Interrupt` that triggers a current-turn abort event, calls `wait_for_guardian_review` with a near-immediate deadline, and asserts the outcome is `TimedOut` with session preservation and no token-usage capture.

**Call relations**: Tests the timeout-and-drain path in `wait_for_guardian_review` and `interrupt_and_drain_turn`.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 7 external calls (from_millis, assert!, test_review_session, turn_aborted_event, turn_complete_event, spawn, now).


##### `tests::wait_for_guardian_review_cancel_drains_expected_turn_after_stale_terminal_event`  (lines 1741–1775)

```
async fn wait_for_guardian_review_cancel_drains_expected_turn_after_stale_terminal_event()
```

**Purpose**: Verifies that cancellation handling interrupts and drains the expected turn even when stale terminal events are present.

**Data flow**: Injects a stale prior-turn completion, arranges for interrupt submission to yield a current-turn abort event, cancels the external token, calls `wait_for_guardian_review`, and asserts the outcome is `Aborted` with session preservation and no token-usage capture.

**Call relations**: Tests the cancellation-and-drain path in `wait_for_guardian_review`.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 8 external calls (new, from_secs, assert!, test_review_session, turn_aborted_event, turn_complete_event, spawn, now).


##### `tests::interrupt_and_drain_turn_ignores_prior_turn_completion`  (lines 1778–1794)

```
async fn interrupt_and_drain_turn_ignores_prior_turn_completion()
```

**Purpose**: Verifies that interrupt draining ignores stale prior-turn completion events and waits for the expected turn’s terminal event.

**Data flow**: Injects a prior-turn completion and a current-turn abort into a test session, calls `interrupt_and_drain_turn`, asserts success, and checks that the event queue is empty afterward.

**Call relations**: Directly tests the stale-event filtering inside `interrupt_and_drain_turn`.

*Call graph*: calls 1 internal fn (interrupt_and_drain_turn); 4 external calls (assert!, test_review_session, turn_aborted_event, turn_complete_event).


### Approval review orchestration
Coordinates the full guardian approval-review workflow, tying request modeling, prompt generation, session execution, and outcome handling together.

### `core/src/guardian/review.rs`

`orchestration` · `approval handling and guardian review completion`

This file drives a guardian review from start to finish. It decides whether approvals should route through guardian, creates review IDs, emits in-progress and terminal `GuardianAssessmentEvent`s, invokes the nested guardian review session with a strict JSON schema, and translates the result into a `ReviewDecision`. The workflow is intentionally fail-closed: explicit deny returns `Denied`, parse/session/prompt-build failures synthesize a high-risk deny rationale, timeout returns `TimedOut`, and cancellation returns `Abort`. Successful and failed reviews are both tracked through `GuardianReviewAnalyticsResult`, which is sent to both metrics and analytics.

The central `run_guardian_review` function computes request metadata such as target item ID, assessment turn ID, and redacted action summary, then handles several branches: immediate external cancellation, completed allow/deny assessment, timeout, cancellation, or fail-closed error. It stores denial rationales in `session.services.guardian_rejections` keyed by review ID so later user-facing rejection messages can retrieve them. It also updates the `GuardianRejectionCircuitBreaker`: explicit denials count toward interruption thresholds, while approvals, timeouts, cancellations, and fail-closed errors are recorded as non-denials. Retry behavior is narrowly scoped in `should_retry_guardian_review` to transient structured session failures and parse errors, with bounded exponential backoff and a shared absolute deadline. The file also supports detached review execution on a dedicated current-thread Tokio runtime for callers that need a oneshot receiver.

#### Function details

##### `new_guardian_review_id`  (lines 67–69)

```
fn new_guardian_review_id() -> String
```

**Purpose**: Generates a fresh UUID string for a guardian review instance.

**Data flow**: Calls `uuid::Uuid::new_v4()`, converts it to a string, and returns it.

**Call relations**: Used by higher-level approval flows when they need a unique review identifier before invoking guardian review orchestration.

*Call graph*: 1 external calls (new_v4).


##### `guardian_rejection_message`  (lines 71–90)

```
async fn guardian_rejection_message(session: &Session, review_id: &str) -> String
```

**Purpose**: Builds the user-facing rejection message for a previously denied guardian review, consuming any stored rationale from session state. It falls back to a generic denial rationale if none was stored or the stored rationale is blank.

**Data flow**: Reads `session.services.guardian_rejections`, removes the entry for `review_id`, filters out empty rationales, substitutes a default `GuardianRejection` if needed, and formats a message containing the rationale plus `GUARDIAN_REJECTION_INSTRUCTIONS`. It returns the final `String`.

**Call relations**: Called after a denial when the system needs to explain the guardian decision to the user. It depends on `run_guardian_review` having inserted a `GuardianRejection` for denied reviews.

*Call graph*: 1 external calls (format!).


##### `guardian_timeout_message`  (lines 92–94)

```
fn guardian_timeout_message() -> String
```

**Purpose**: Returns the canned user-facing message for guardian review timeouts.

**Data flow**: Clones `GUARDIAN_TIMEOUT_INSTRUCTIONS` into a `String` and returns it.

**Call relations**: Used by callers that need to distinguish timeout guidance from explicit policy denial messaging.


##### `GuardianReviewError::prompt_build`  (lines 119–123)

```
fn prompt_build(err: anyhow::Error) -> Self
```

**Purpose**: Wraps an arbitrary error as a guardian prompt-build failure.

**Data flow**: Consumes an `anyhow::Error`, converts it to a string, and returns `GuardianReviewError::PromptBuild { message }`.

**Call relations**: Used by review-session orchestration and tests to classify failures that occur before the nested guardian turn is submitted.

*Call graph*: called by 3 (guardian_review_error_reason_distinguishes_error_kinds, guardian_review_retry_only_retries_transient_session_and_parse_errors, run_guardian_review_session_before_deadline); 1 external calls (to_string).


##### `GuardianReviewError::session`  (lines 125–130)

```
fn session(err: anyhow::Error) -> Self
```

**Purpose**: Wraps an arbitrary error as an unstructured guardian session failure.

**Data flow**: Consumes an `anyhow::Error`, stringifies it, and returns `GuardianReviewError::Session { message, error_info: None }`.

**Call relations**: Used when the nested guardian session fails without structured `CodexErrorInfo` metadata.

*Call graph*: called by 3 (guardian_review_error_reason_distinguishes_error_kinds, guardian_review_retry_only_retries_transient_session_and_parse_errors, run_guardian_review_session_before_deadline); 1 external calls (to_string).


##### `GuardianReviewError::session_with_error_info`  (lines 132–137)

```
fn session_with_error_info(err: anyhow::Error, error_info: CodexErrorInfo) -> Self
```

**Purpose**: Wraps an arbitrary error as a guardian session failure while preserving structured `CodexErrorInfo` for retry decisions and analytics.

**Data flow**: Consumes an `anyhow::Error` and a `CodexErrorInfo`, stringifies the error, and returns `GuardianReviewError::Session { message, error_info: Some(error_info) }`.

**Call relations**: Used by review-session orchestration when the nested session surfaces a typed backend failure such as overload or connection loss.

*Call graph*: called by 3 (guardian_review_error_reason_distinguishes_error_kinds, guardian_review_retry_only_retries_transient_session_and_parse_errors, run_guardian_review_session_before_deadline); 1 external calls (to_string).


##### `GuardianReviewError::parse`  (lines 139–143)

```
fn parse(err: anyhow::Error) -> Self
```

**Purpose**: Wraps an arbitrary error as a guardian assessment parse failure.

**Data flow**: Consumes an `anyhow::Error`, converts it to a string, and returns `GuardianReviewError::Parse { message }`.

**Call relations**: Used after the nested guardian session completes but its final message cannot be parsed into a `GuardianAssessment`.

*Call graph*: called by 3 (guardian_review_error_reason_distinguishes_error_kinds, guardian_review_retry_only_retries_transient_session_and_parse_errors, run_guardian_review_session_before_deadline); 1 external calls (to_string).


##### `GuardianReviewError::failure_reason`  (lines 145–153)

```
fn failure_reason(&self) -> GuardianReviewFailureReason
```

**Purpose**: Maps internal guardian review error variants to analytics failure-reason enums.

**Data flow**: Matches `self` and returns the corresponding `GuardianReviewFailureReason` variant for prompt-build, session, parse, timeout, or cancellation failures.

**Call relations**: Called when constructing `GuardianReviewAnalyticsResult` for failed or aborted reviews.


##### `guardian_risk_level_str`  (lines 156–163)

```
fn guardian_risk_level_str(level: GuardianRiskLevel) -> &'static str
```

**Purpose**: Converts a `GuardianRiskLevel` into the lowercase string used in warning messages.

**Data flow**: Matches the enum and returns `low`, `medium`, `high`, or `critical`.

**Call relations**: Used by `run_guardian_review` when formatting the final warning event for approved or denied assessments.


##### `routes_approval_to_guardian`  (lines 168–170)

```
fn routes_approval_to_guardian(turn: &TurnContext) -> bool
```

**Purpose**: Determines whether the current turn’s approval policy and configured reviewer route approvals through guardian.

**Data flow**: Reads the `TurnContext`, extracts `turn.config.approvals_reviewer`, forwards both to `routes_approval_to_guardian_with_reviewer`, and returns the resulting boolean.

**Call relations**: This is the common routing predicate used by approval handling code. It delegates the actual policy/reviewer check to the reviewer-aware helper.

*Call graph*: calls 1 internal fn (routes_approval_to_guardian_with_reviewer).


##### `routes_approval_to_guardian_with_reviewer`  (lines 173–181)

```
fn routes_approval_to_guardian_with_reviewer(
    turn: &TurnContext,
    approvals_reviewer: ApprovalsReviewer,
) -> bool
```

**Purpose**: Determines whether a specific reviewer selection should route approvals through guardian for the given turn. It only allows guardian for `OnRequest` or `Granular` approval policies paired with `ApprovalsReviewer::AutoReview`.

**Data flow**: Reads `turn.approval_policy.value()` and the supplied `approvals_reviewer`, evaluates the match expression, and returns `true` or `false`.

**Call relations**: Called by `routes_approval_to_guardian` and by tests that simulate per-approval reviewer overrides.

*Call graph*: called by 1 (routes_approval_to_guardian); 1 external calls (matches!).


##### `is_guardian_reviewer_source`  (lines 183–191)

```
fn is_guardian_reviewer_source(
    session_source: &codex_protocol::protocol::SessionSource,
) -> bool
```

**Purpose**: Recognizes whether a session source identifies the internal guardian reviewer subagent.

**Data flow**: Matches the supplied `SessionSource` against `SessionSource::SubAgent(SubAgentSource::Other(label))` and returns true only when `label == GUARDIAN_REVIEWER_NAME`.

**Call relations**: Used elsewhere in the system to distinguish guardian-owned sessions from user-visible or other internal subagents.

*Call graph*: 1 external calls (matches!).


##### `track_guardian_review`  (lines 193–212)

```
fn track_guardian_review(
    session: &Session,
    tracking: &GuardianReviewTrackContext,
    approval_request_source: GuardianApprovalRequestSource,
    reviewed_action: &GuardianReviewedAction,
```

**Purpose**: Sends the completed guardian review analytics payload to both metrics and the analytics events client.

**Data flow**: Reads the parent `session`, tracking context, approval source, reviewed action, analytics result, and completion timestamp. It computes elapsed latency from `completed_at_ms - tracking.started_at_ms`, calls `emit_guardian_review_metrics` with the session telemetry, then forwards the same tracking/result pair to `analytics_events_client.track_guardian_review`. It returns nothing.

**Call relations**: Called from `run_guardian_review` on every terminal path so metrics and analytics stay in sync.

*Call graph*: calls 1 internal fn (emit_guardian_review_metrics); called by 1 (run_guardian_review).


##### `record_guardian_non_denial`  (lines 214–221)

```
async fn record_guardian_non_denial(session: &Arc<Session>, turn_id: &str)
```

**Purpose**: Marks a guardian review outcome as non-denial in the per-turn circuit breaker.

**Data flow**: Locks `session.services.guardian_rejection_circuit_breaker`, calls `record_non_denial(turn_id)`, and returns nothing.

**Call relations**: Used by `run_guardian_review` for approvals, timeouts, cancellations, and fail-closed errors that should not count toward denial-triggered interruption.

*Call graph*: called by 1 (run_guardian_review).


##### `record_guardian_denial`  (lines 223–261)

```
async fn record_guardian_denial(session: &Arc<Session>, turn: &Arc<TurnContext>, turn_id: &str)
```

**Purpose**: Records an explicit guardian denial in the circuit breaker and interrupts the turn if denial thresholds are crossed. It emits a warning before scheduling the asynchronous turn abort.

**Data flow**: Locks the circuit breaker and calls `record_denial(turn_id)`. If the result is `Continue`, it returns immediately. On `InterruptTurn`, it checks that the turn is still active via `session.turn_context_for_sub_id(turn_id)`, sends a `GuardianWarning` event describing the consecutive and recent denial counts, clones the runtime handle and session, and spawns an async task that calls `abort_turn_if_active(turn_id, TurnAbortReason::Interrupted)`. It returns nothing.

**Call relations**: Called by `run_guardian_review` after explicit deny outcomes, and exposed to tests through `record_guardian_denial_for_test`. It is the bridge between denial counting and actual turn interruption.

*Call graph*: called by 2 (record_guardian_denial_for_test, run_guardian_review); 3 external calls (clone, format!, GuardianWarning).


##### `record_guardian_denial_for_test`  (lines 264–270)

```
async fn record_guardian_denial_for_test(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    turn_id: &str,
)
```

**Purpose**: Test-visible wrapper around denial recording and possible turn interruption.

**Data flow**: Forwards the supplied session, turn, and turn ID to `record_guardian_denial` and awaits it.

**Call relations**: Used only by tests that need to exercise the circuit-breaker interruption path.

*Call graph*: calls 1 internal fn (record_guardian_denial).


##### `run_guardian_review`  (lines 275–591)

```
async fn run_guardian_review(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    review_id: String,
    request: GuardianApprovalRequest,
    retry_reason: Option<String>,
    approval_request
```

**Purpose**: Executes one guardian approval review end-to-end, including event emission, nested review-session execution, retries, analytics, rejection storage, and circuit-breaker updates. It is the central state machine for guardian review outcomes.

**Data flow**: Consumes cloned `Session` and `TurnContext`, a `review_id`, `GuardianApprovalRequest`, optional retry reason, approval source, and optional external cancellation token. It derives target item ID, assessment turn ID, action summary, reviewed action, and a `GuardianReviewTrackContext`; emits an in-progress `GuardianAssessmentEvent`; handles immediate cancellation as an aborted review; builds the output schema; runs `run_guardian_review_session_with_retry`; timestamps completion; then branches on `GuardianReviewOutcome`. Completed assessments produce approved/denied analytics, warning text, stored rejection rationale for denies, terminal assessment events, and either `ReviewDecision::Approved` or `Denied`. Timeout emits timeout analytics, a warning, a timed-out assessment event, records non-denial, and returns `TimedOut`. Cancellation emits aborted analytics and event, records non-denial, and returns `Abort`. Prompt-build/session/parse failures emit fail-closed analytics, synthesize a high-risk deny assessment, continue through the normal denied-event path, but do not count toward the denial circuit breaker. All terminal paths write events and analytics; some mutate `guardian_rejections` and the circuit breaker.

**Call relations**: This function is invoked by both public review entrypoints. It delegates nested execution to `run_guardian_review_session_with_retry`, telemetry to `track_guardian_review`, and circuit-breaker bookkeeping to `record_guardian_denial` or `record_guardian_non_denial` depending on the terminal outcome.

*Call graph*: calls 12 internal fn (without_session, new, guardian_assessment_action, guardian_request_target_item_id, guardian_request_turn_id, guardian_reviewed_action, guardian_output_schema, record_guardian_denial, record_guardian_non_denial, run_guardian_review_session_with_retry (+2 more)); called by 2 (review_approval_request, review_approval_request_with_cancel); 5 external calls (pin, format!, matches!, GuardianAssessment, GuardianWarning).


##### `review_approval_request`  (lines 594–613)

```
async fn review_approval_request(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    review_id: String,
    request: GuardianApprovalRequest,
    retry_reason: Option<String>,
) -> ReviewDec
```

**Purpose**: Public async entrypoint for guardian review of a main-turn approval request without external cancellation.

**Data flow**: Clones the supplied `Arc<Session>` and `Arc<TurnContext>`, boxes the future from `run_guardian_review` with `GuardianApprovalRequestSource::MainTurn` and no cancel token, awaits it, and returns the resulting `ReviewDecision`.

**Call relations**: Called by approval handling code for ordinary guardian-reviewed requests. It exists mainly to keep callers from inlining the full guardian async state machine.

*Call graph*: calls 1 internal fn (run_guardian_review); 2 external calls (clone, pin).


##### `review_approval_request_with_cancel`  (lines 615–634)

```
async fn review_approval_request_with_cancel(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    review_id: String,
    request: GuardianApprovalRequest,
    retry_reason: Option<String>,
```

**Purpose**: Public async entrypoint for guardian review when the caller needs to propagate an external cancellation token and explicit approval-request source.

**Data flow**: Clones the supplied session and turn Arcs, forwards all arguments plus `Some(cancel_token)` to `run_guardian_review`, awaits completion, and returns the `ReviewDecision`.

**Call relations**: Used by callers that need cancellation-aware guardian review, including delegated subagent approval flows and detached review execution.

*Call graph*: calls 1 internal fn (run_guardian_review); 1 external calls (clone).


##### `spawn_approval_request_review`  (lines 636–666)

```
fn spawn_approval_request_review(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    review_id: String,
    request: GuardianApprovalRequest,
    retry_reason: Option<String>,
    approval_req
```

**Purpose**: Runs a guardian review on a dedicated current-thread Tokio runtime in a new OS thread and returns a oneshot receiver for the decision. It provides a detached execution mode for callers that cannot await directly.

**Data flow**: Creates a oneshot channel, spawns a new thread, builds a current-thread Tokio runtime inside it, and either sends `ReviewDecision::Denied` immediately if runtime creation fails or blocks on `review_approval_request_with_cancel(...)` and sends the resulting decision through the channel. The function returns the receiver.

**Call relations**: This is the detached orchestration wrapper around `review_approval_request_with_cancel`. It isolates guardian review execution from the caller’s runtime and stack.

*Call graph*: 2 external calls (channel, spawn).


##### `run_guardian_review_session_before_deadline`  (lines 682–842)

```
async fn run_guardian_review_session_before_deadline(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    request: GuardianApprovalRequest,
    retry_reason: Option<String>,
    schema: serde_j
```

**Purpose**: Prepares the locked-down guardian review session configuration, runs one nested guardian review attempt before the shared deadline, and converts the session outcome into either a parsed assessment or a classified review error plus analytics metadata.

**Data flow**: Reads the parent `session`, `turn`, approval `request`, optional retry reason, output `schema`, optional external cancel token, and absolute `deadline`. It loads live network proxy state if present, lists available models, chooses the guardian review model and reasoning effort based on override/default/catalog availability, builds a guardian-specific `Config` with `build_guardian_review_session_config`, and invokes `session.guardian_review_session.run_review(...)`. It then maps `GuardianReviewSessionOutcome` variants into `GuardianReviewOutcome`: completed message payloads are parsed with `parse_guardian_assessment`, missing payloads become session errors, prompt-build/session failures are wrapped appropriately, and timeout/abort become `Timeout`/`Cancelled`. It returns `(GuardianReviewOutcome, GuardianReviewAnalyticsResult)`.

**Call relations**: Called by `run_guardian_review_session_with_retry` for each attempt. It is the boundary between parent-turn state and the reusable guardian review session manager.

*Call graph*: calls 7 internal fn (without_session, parse_guardian_assessment, parse, prompt_build, session, session_with_error_info, build_guardian_review_session_config); called by 1 (run_guardian_review_session_with_retry); 5 external calls (clone, pin, anyhow!, Completed, Error).


##### `run_guardian_review_session_with_retry`  (lines 844–878)

```
async fn run_guardian_review_session_with_retry(
    session: Arc<Session>,
    turn: Arc<TurnContext>,
    request: GuardianApprovalRequest,
    retry_reason: Option<String>,
    schema: serde_json::
```

**Purpose**: Runs guardian review attempts until one succeeds, a non-retriable outcome occurs, cancellation/deadline intervenes, or the maximum attempt count is reached.

**Data flow**: Consumes session, turn, request, retry reason, schema, optional cancel token, and `max_attempts`. It asserts `max_attempts > 0`, computes a single absolute deadline from `GUARDIAN_REVIEW_TIMEOUT`, loops from attempt 1 upward, calls `run_guardian_review_session_before_deadline`, stamps `analytics_result.attempt_count`, checks `should_retry_guardian_review`, optionally waits via `wait_before_guardian_retry`, and either returns the current outcome/analytics or retries with incremented attempt count.

**Call relations**: Called only by `run_guardian_review`. It delegates attempt execution to `run_guardian_review_session_before_deadline`, retry classification to `should_retry_guardian_review`, and backoff/deadline handling to `wait_before_guardian_retry`.

*Call graph*: calls 3 internal fn (run_guardian_review_session_before_deadline, should_retry_guardian_review, wait_before_guardian_retry); called by 1 (run_guardian_review); 6 external calls (clone, now, clone, assert!, clone, Error).


##### `wait_before_guardian_retry`  (lines 880–899)

```
async fn wait_before_guardian_retry(
    attempt_count: i64,
    deadline: Instant,
    external_cancel: Option<&CancellationToken>,
) -> Option<GuardianReviewError>
```

**Purpose**: Sleeps for the backoff delay before the next guardian retry, but aborts early on cancellation and converts deadline exhaustion into a timeout error.

**Data flow**: Reads `attempt_count`, absolute `deadline`, and optional external cancel token. It computes `retry_delay` via `backoff`, caps the wake-up time at the deadline, then `tokio::select!`s between sleeping until `retry_at` and waiting for cancellation. On sleep completion it returns `Some(GuardianReviewError::Timeout)` if the deadline has been reached, otherwise `None`; on cancellation it returns `Some(GuardianReviewError::Cancelled)`.

**Call relations**: Used by `run_guardian_review_session_with_retry` between attempts so retries respect both the global guardian timeout and caller cancellation.

*Call graph*: calls 1 internal fn (backoff); called by 3 (guardian_review_retry_wait_honors_cancellation, guardian_review_retry_wait_honors_deadline, run_guardian_review_session_with_retry); 2 external calls (now, select!).


##### `should_retry_guardian_review`  (lines 901–917)

```
fn should_retry_guardian_review(outcome: &GuardianReviewOutcome) -> bool
```

**Purpose**: Determines whether a guardian review outcome is transient enough to retry. Only selected structured session failures and parse failures qualify.

**Data flow**: Matches a borrowed `GuardianReviewOutcome` and returns true for `GuardianReviewError::Parse` and for `GuardianReviewError::Session` carrying retryable `CodexErrorInfo` values such as overload, connection failures, internal server error, or stream disconnects; all other outcomes return false.

**Call relations**: Called by `run_guardian_review_session_with_retry` after each attempt to decide whether another attempt is warranted.

*Call graph*: called by 1 (run_guardian_review_session_with_retry); 1 external calls (matches!).


##### `review_tests::guardian_review_error_reason_distinguishes_error_kinds`  (lines 925–951)

```
fn guardian_review_error_reason_distinguishes_error_kinds()
```

**Purpose**: Verifies that each `GuardianReviewError` constructor maps to the expected analytics failure reason.

**Data flow**: Constructs parse, prompt-build, session, and structured-session errors, calls `failure_reason()` on each, and asserts the expected `GuardianReviewFailureReason` variants.

**Call relations**: Exercises the error-classification helpers used by analytics emission.

*Call graph*: calls 4 internal fn (parse, prompt_build, session, session_with_error_info); 2 external calls (anyhow!, assert!).


##### `review_tests::guardian_review_retry_only_retries_transient_session_and_parse_errors`  (lines 954–1024)

```
fn guardian_review_retry_only_retries_transient_session_and_parse_errors()
```

**Purpose**: Verifies the retry policy accepts only transient structured session failures and parse failures, not successful outcomes or permanent failures.

**Data flow**: Builds a mix of `GuardianReviewOutcome` values, including completed assessments, prompt/session/parse errors, timeout, cancellation, and several structured transient session errors, then asserts `should_retry_guardian_review` matches the expected boolean for each case.

**Call relations**: Directly tests the retry classifier that governs `run_guardian_review_session_with_retry`.

*Call graph*: calls 4 internal fn (parse, prompt_build, session, session_with_error_info); 4 external calls (anyhow!, assert_eq!, Completed, Error).


##### `review_tests::guardian_review_retry_wait_honors_cancellation`  (lines 1027–1039)

```
async fn guardian_review_retry_wait_honors_cancellation()
```

**Purpose**: Checks that retry waiting returns `Cancelled` immediately when the external cancellation token is already cancelled.

**Data flow**: Creates and cancels a `CancellationToken`, calls `wait_before_guardian_retry` with a future deadline, awaits the result, and asserts it is `Some(GuardianReviewError::Cancelled)`.

**Call relations**: Tests the cancellation branch of the retry wait helper.

*Call graph*: calls 1 internal fn (wait_before_guardian_retry); 4 external calls (new, from_secs, now, assert!).


##### `review_tests::guardian_review_retry_wait_honors_deadline`  (lines 1042–1051)

```
async fn guardian_review_retry_wait_honors_deadline()
```

**Purpose**: Checks that retry waiting returns `Timeout` when the deadline has already been reached.

**Data flow**: Calls `wait_before_guardian_retry` with `Instant::now()` as the deadline and no cancel token, awaits the result, and asserts it is `Some(GuardianReviewError::Timeout)`.

**Call relations**: Tests the deadline-expiry branch of the retry wait helper.

*Call graph*: calls 1 internal fn (wait_before_guardian_retry); 2 external calls (now, assert!).
