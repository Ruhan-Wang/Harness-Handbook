# Guardian review and mediated approval sessions  `stage-14.1.2`

This stage is a behind-the-scenes safety checkpoint in the main work loop. Before Codex takes a risky action, such as running a command, changing files, using the network, or calling an external MCP tool, Guardian may review it instead of immediately asking the user. It acts like a careful supervisor beside the main worker.

The front door in `guardian/mod.rs` decides when Guardian can automatically allow or deny a request, and includes a safety brake if too many actions are rejected. `approval_request.rs` describes the kinds of actions that may need approval and reshapes them for prompts, logs, safety checks, and conversation records. `prompt.rs` builds the message sent to the Guardian reviewer and reads the reviewer’s structured JSON answer.

The review itself runs as a separate mini-session. `session/review.rs` sets up that special review turn with its own model, limits, tools, and user-interface signal. `review_session.rs` manages whether to reuse an existing reviewer or start a temporary one, then handles timeouts and cancellation. Finally, `review.rs` turns the reviewer’s decision into an approved, denied, timed-out, or aborted result for the session, interface, and analytics.

## Files in this stage

### Guardian foundations
Defines the guardian subsystem’s shared types and the approval-request model that all later review flows consume.

### `core/src/guardian/mod.rs`

`domain_logic` · `request handling`

The guardian is a safety reviewer for planned actions. When the main system is about to do something that normally needs user approval, the guardian can inspect the recent conversation, the planned action, and the policy rules, then return a strict allow-or-deny answer. This file ties that subsystem together: it declares the guardian submodules, re-exports the important pieces other code should use, and defines shared limits such as review timeout, transcript size caps, and denial thresholds.

The most active logic in this file is the rejection circuit breaker. A circuit breaker is like a fuse box: if too many unsafe-looking actions are rejected in a short span, it trips so the system stops pushing forward in the same turn. It tracks rejection history separately for each turn, using the turn ID as the key. It watches two patterns: too many denials in a row, or too many denials within a recent sliding window. Once either limit is reached, it returns an instruction to interrupt the turn. It only triggers once per turn, so repeated denials after that do not cause repeated interrupts.

Without this file, other parts of the system would lack a single shared guardian interface and would not have this guardrail against repeatedly attempting actions the guardian has already judged unsafe.

#### Function details

##### `GuardianRejectionCircuitBreaker::clear_turn`  (lines 99–101)

```
fn clear_turn(&mut self, turn_id: &str)
```

**Purpose**: This forgets all guardian denial history for one conversation turn. It is used when a turn is finished or no longer needs tracking, so old rejections do not affect later work.

**Data flow**: It receives a turn ID as text. It looks up that ID in the circuit breaker's stored turn map and removes the matching entry if one exists. Nothing is returned; the only change is that the stored counters and recent-denial history for that turn are gone.

**Call relations**: This is the cleanup step for the circuit breaker. Other guardian review flow code can call it when a turn should no longer be monitored, so later calls to denial or non-denial recording start fresh for that turn ID.


##### `GuardianRejectionCircuitBreaker::record_denial`  (lines 103–120)

```
fn record_denial(&mut self, turn_id: &str) -> GuardianRejectionCircuitBreakerAction
```

**Purpose**: This records that the guardian rejected an action for a specific turn and decides whether that pattern is now serious enough to interrupt the turn. It protects the system from repeatedly trying actions that are being denied.

**Data flow**: It receives a turn ID. It finds or creates the tracking record for that turn, increases the count of back-to-back denials, and records this review as a denial in the recent history by calling `record_recent_review`. It then counts how many denials are in the recent window. If this is the first time the turn has crossed either denial limit, it marks the turn as interrupted and returns `InterruptTurn` with the current counts. Otherwise it returns `Continue`.

**Call relations**: This is called after a guardian review says no. It relies on `record_recent_review` to keep the sliding recent-history list up to date, then hands the caller a simple next step: keep going, or interrupt the current turn because the denial pattern has crossed the safety threshold.

*Call graph*: 1 external calls (record_recent_review).


##### `GuardianRejectionCircuitBreaker::record_non_denial`  (lines 122–126)

```
fn record_non_denial(&mut self, turn_id: &str)
```

**Purpose**: This records that a guardian review did not reject an action. It resets the back-to-back denial count while still keeping a note in the recent review history.

**Data flow**: It receives a turn ID. It finds or creates the tracking record for that turn, sets the consecutive-denial counter back to zero, and calls `record_recent_review` with a non-denial marker. It returns nothing; it only updates the stored state for that turn.

**Call relations**: This is called when a guardian review allows an action or otherwise does not count as a rejection. It uses the same recent-history helper as `record_denial`, so the circuit breaker has a balanced view of both denied and not-denied reviews.

*Call graph*: 1 external calls (record_recent_review).


##### `GuardianRejectionCircuitBreaker::record_recent_review`  (lines 128–133)

```
fn record_recent_review(turn: &mut GuardianRejectionCircuitBreakerTurn, denied: bool)
```

**Purpose**: This keeps the short recent-history list for one turn at a fixed size. It is the helper that lets the circuit breaker ask, 'How many of the latest reviews were denials?'

**Data flow**: It receives the stored tracking record for a turn and a true-or-false value saying whether the latest review was denied. It adds that value to the back of the recent-history queue. If the queue has grown beyond the configured window size, it removes the oldest entry from the front. It returns nothing; the queue is updated in place.

**Call relations**: Both `record_denial` and `record_non_denial` call this helper after each guardian review. By centralizing the sliding-window update here, both paths keep the recent review history in the same shape before the denial-counting logic uses it.


### `core/src/guardian/approval_request.rs`

`domain_logic` · `request handling during Guardian review`

Guardian is the part of the system that reviews potentially risky actions before they happen. This file is its shared “request form” drawer. Each variant of GuardianApprovalRequest describes one kind of thing the assistant might want to do: run a shell command, execute a program, edit files with a patch, reach the network, call an MCP tool, or ask for broader permissions.

The file then provides several ways to look at the same request. For a human- or model-facing approval prompt, it turns the request into JSON, with fields like the command, working directory, host, port, or tool name. For safety assessment, it creates a more compact GuardianAssessmentAction that focuses on the facts needed to judge risk. For analytics, it creates a GuardianReviewedAction that records what kind of action was reviewed without carrying every detail.

One important detail is formatting. Some action data can be very large, such as long patches or tool arguments. Before pretty-printing the JSON for a Guardian prompt, the file walks through every string inside it and truncates overly long text. It also sorts object keys, so the formatted result is stable and easier to compare. In short, this file keeps Guardian requests consistent, readable, and safe to pass between the review system, prompts, and reporting.

#### Function details

##### `serialize_guardian_action`  (lines 172–174)

```
fn serialize_guardian_action(value: impl Serialize) -> serde_json::Result<Value>
```

**Purpose**: This small helper turns any serializable Guardian action shape into a JSON value. It exists so the rest of the file can build typed Rust structs first, then convert them into a common JSON form for prompts or review messages.

**Data flow**: It receives a value that knows how to serialize itself. It passes that value to JSON conversion and returns either the resulting JSON value or a serialization error if something cannot be represented.

**Call relations**: The more specific conversion functions call this when they have built the right action shape. guardian_approval_request_to_json uses it for several request types, and serialize_command_guardian_action uses it for command-like requests.

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

**Purpose**: This helper builds the JSON description for command-style approvals, such as shell commands and unified exec commands. It keeps those two similar request types from duplicating the same serialization code.

**Data flow**: It receives the tool name, command arguments, current directory, sandbox permissions, optional extra permissions, optional justification, and optional terminal setting. It wraps those pieces in a command approval structure, then turns that structure into JSON.

**Call relations**: guardian_approval_request_to_json calls this when it sees a Shell or ExecCommand request. This helper then hands the final conversion off to serialize_guardian_action.

*Call graph*: calls 1 internal fn (serialize_guardian_action); called by 1 (guardian_approval_request_to_json).


##### `command_assessment_action`  (lines 196–206)

```
fn command_assessment_action(
    source: GuardianCommandSource,
    command: &[String],
    cwd: &AbsolutePathBuf,
) -> GuardianAssessmentAction
```

**Purpose**: This creates the compact safety-assessment version of a command request. It turns a list of command words into a single shell-like command string, while preserving where the command would run.

**Data flow**: It receives the command source, the command as a list of strings, and the working directory. It joins the command list into readable shell text, clones the directory, and returns a GuardianAssessmentAction::Command value.

**Call relations**: guardian_assessment_action calls this for Shell and ExecCommand requests. It delegates the command-string formatting to shlex_join, which produces a readable and safely quoted command line.

*Call graph*: calls 1 internal fn (shlex_join); called by 1 (guardian_assessment_action); 1 external calls (clone).


##### `guardian_command_source_tool_name`  (lines 209–214)

```
fn guardian_command_source_tool_name(source: GuardianCommandSource) -> &'static str
```

**Purpose**: On Unix systems, this maps a command source to the tool name used in Guardian JSON. It makes sure an execve request is labeled consistently as either coming from the shell flow or the unified exec flow.

**Data flow**: It receives a GuardianCommandSource value. It matches that source and returns the fixed text label "shell" or "exec_command".

**Call relations**: guardian_approval_request_to_json calls this when serializing Unix-only Execve requests. The returned label becomes the JSON tool field shown to Guardian.

*Call graph*: called by 1 (guardian_approval_request_to_json).


##### `truncate_guardian_action_value`  (lines 216–251)

```
fn truncate_guardian_action_value(value: Value) -> (Value, bool)
```

**Purpose**: This walks through a JSON value and shortens any string that is too large for a Guardian action display. It also reports whether anything was shortened, so callers can warn or mark the output as truncated.

**Data flow**: It receives a JSON value. If the value is a string, it truncates it using the Guardian text limit. If it is an array, it checks each item. If it is an object, it sorts the keys for stable output and checks each value. It returns the possibly changed JSON plus a true-or-false flag saying whether truncation happened.

**Call relations**: format_guardian_action_pretty calls this after building the raw JSON for an approval request. This function relies on guardian_truncate_text for the actual text shortening and rebuilds JSON strings, arrays, and objects as needed.

*Call graph*: calls 1 internal fn (guardian_truncate_text); called by 1 (format_guardian_action_pretty); 3 external calls (Array, Object, String).


##### `guardian_approval_request_to_json`  (lines 259–373)

```
fn guardian_approval_request_to_json(
    action: &GuardianApprovalRequest,
) -> serde_json::Result<Value>
```

**Purpose**: This converts any Guardian approval request into the detailed JSON form used for display or prompt construction. It is the main bridge from the internal request enum to a readable structured description.

**Data flow**: It receives a GuardianApprovalRequest. It looks at which kind of request it is, selects the useful fields, and builds JSON with a tool name and relevant details such as command, directory, files, patch text, network target, MCP metadata, or requested permissions. It returns the JSON or an error if serialization fails.

**Call relations**: format_guardian_action_pretty calls this before making a prompt-friendly string. Inside, it uses serialize_command_guardian_action for command requests, serialize_guardian_action for typed action structs, guardian_command_source_tool_name for Unix execve labeling, and direct JSON construction for patch requests.

*Call graph*: calls 3 internal fn (guardian_command_source_tool_name, serialize_command_guardian_action, serialize_guardian_action); called by 1 (format_guardian_action_pretty); 1 external calls (json!).


##### `guardian_assessment_action`  (lines 375–441)

```
fn guardian_assessment_action(
    action: &GuardianApprovalRequest,
) -> GuardianAssessmentAction
```

**Purpose**: This converts a full approval request into the smaller action description used for Guardian risk assessment. It keeps the facts needed to judge the action, while leaving out details that are only needed for display or tracking.

**Data flow**: It receives a GuardianApprovalRequest. Based on the request type, it copies or clones the relevant data into a GuardianAssessmentAction: command details, patch files, network endpoint, MCP tool identity, or requested permissions. The result is a compact assessment object.

**Call relations**: run_guardian_review calls this when it needs to ask Guardian to assess an action. For shell-like commands, this function hands off to command_assessment_action so command formatting stays consistent.

*Call graph*: calls 1 internal fn (command_assessment_action); called by 1 (run_guardian_review).


##### `guardian_reviewed_action`  (lines 443–501)

```
fn guardian_reviewed_action(
    request: &GuardianApprovalRequest,
) -> GuardianReviewedAction
```

**Purpose**: This creates the analytics-friendly record of what Guardian reviewed. It records the kind of action and selected important attributes, without carrying the full request payload.

**Data flow**: It receives a GuardianApprovalRequest. It matches the request type and returns a GuardianReviewedAction containing summary fields such as sandbox permissions, extra permissions, terminal use, program name, network protocol and port, or MCP tool identity.

**Call relations**: run_guardian_review calls this after or during review to produce the reviewed-action record used by analytics. Unlike the JSON formatting path, this function does not call other helpers; it directly maps request variants into analytics variants.

*Call graph*: called by 1 (run_guardian_review).


##### `guardian_request_target_item_id`  (lines 503–514)

```
fn guardian_request_target_item_id(request: &GuardianApprovalRequest) -> Option<&str>
```

**Purpose**: This finds the conversation item ID that a Guardian request is attached to, when such an ID exists. That lets the review system connect an approval decision back to the specific command, patch, tool call, or permission request in the conversation.

**Data flow**: It receives a GuardianApprovalRequest. For request types that carry an id, it returns that id as text. For network access requests, it returns nothing because this request type is tracked differently and does not expose a target item ID here.

**Call relations**: run_guardian_review calls this when it needs to tie the review result to a target item. This function only extracts the ID; it does not create or modify any request.

*Call graph*: called by 1 (run_guardian_review).


##### `guardian_request_turn_id`  (lines 516–530)

```
fn guardian_request_turn_id(
    request: &'a GuardianApprovalRequest,
    default_turn_id: &'a str,
) -> &'a str
```

**Purpose**: This chooses which conversation turn ID should be associated with a Guardian request. Some request types carry their own turn ID, while others should use the caller’s default turn ID.

**Data flow**: It receives a GuardianApprovalRequest and a default turn ID. If the request is NetworkAccess or RequestPermissions, it returns the turn ID stored in the request. For other request types, it returns the default provided by the caller.

**Call relations**: run_guardian_review calls this while preparing review context. It acts like a simple routing rule for conversation tracking: use the request’s own turn ID when it has one, otherwise fall back to the surrounding turn.

*Call graph*: called by 1 (run_guardian_review).


##### `format_guardian_action_pretty`  (lines 532–541)

```
fn format_guardian_action_pretty(
    action: &GuardianApprovalRequest,
) -> serde_json::Result<FormattedGuardianAction>
```

**Purpose**: This produces a readable, pretty-printed JSON string for a Guardian approval request. It is used when the system needs to show or include the action details in a prompt without letting very large strings overwhelm the review.

**Data flow**: It receives a GuardianApprovalRequest. First it converts the request to JSON, then truncates any oversized strings inside that JSON, then formats the final JSON with indentation. It returns the formatted text together with a flag saying whether anything was shortened.

**Call relations**: build_guardian_prompt_items_with_parent_turn calls this when building the Guardian prompt items. This function ties together guardian_approval_request_to_json, truncate_guardian_action_value, and JSON pretty-printing into one prompt-ready result.

*Call graph*: calls 2 internal fn (guardian_approval_request_to_json, truncate_guardian_action_value); called by 1 (build_guardian_prompt_items_with_parent_turn); 1 external calls (to_string_pretty).


### Reviewer prompt construction
Builds the reviewer-facing prompt and parses structured review results for guardian approval assessments.

### `core/src/guardian/prompt.rs`

`domain_logic` · `approval review`

When Codex wants to do something that needs approval, the Guardian needs a clear packet of evidence: what happened in the conversation, what tools were used, what action is now being requested, and what answer format is expected. This file builds that packet.

It first turns the session history into a smaller transcript. It keeps the important human conversation, assistant messages, and tool calls or results, while skipping noisy setup messages. Then it trims long entries so the Guardian does not receive an oversized prompt. It uses separate space budgets for normal conversation and tool evidence, so a huge tool result cannot crowd out what the user actually asked for.

The file can build either a full prompt or a delta prompt. A delta prompt is like saying, “Since you already reviewed the earlier pages, here are only the new pages.” If the saved cursor no longer matches the session history, it safely falls back to the full transcript.

Finally, this file defines the Guardian’s required answer shape: strict JSON with an allow or deny outcome, optional risk details, and a rationale. It also contains the policy prompt assembly, combining a policy template with tenant-specific policy text.

#### Function details

##### `GuardianTranscriptEntryKind::role`  (lines 46–53)

```
fn role(&self) -> &str
```

**Purpose**: Returns the label that should appear in the Guardian transcript for this kind of entry, such as user, assistant, developer, or a named tool role. This makes the rendered transcript readable to the reviewing model.

**Data flow**: It reads the entry kind stored in the enum. It converts that kind into a short role string. It returns that string without changing anything.

**Call relations**: When transcript entries are rendered for Guardian review, the rendering code asks each entry kind for its display role so every line is clearly marked with who or what produced it.


##### `GuardianTranscriptEntryKind::is_user`  (lines 55–57)

```
fn is_user(&self) -> bool
```

**Purpose**: Checks whether a transcript entry came from the user. This matters because user messages are treated as key evidence for authorization.

**Data flow**: It receives an entry kind. It tests whether that kind is the user variant. It returns true for user entries and false for all others.

**Call relations**: The transcript selection logic uses this check to protect important user turns, especially the first and latest user messages, when deciding what fits into the Guardian prompt.

*Call graph*: 1 external calls (matches!).


##### `GuardianTranscriptEntryKind::is_tool`  (lines 59–61)

```
fn is_tool(&self) -> bool
```

**Purpose**: Checks whether a transcript entry is tool-related. Tool entries have their own size budget so tool logs do not overwhelm the human conversation.

**Data flow**: It receives an entry kind. It tests whether that kind represents a tool call or tool result. It returns a simple yes or no.

**Call relations**: The transcript renderer uses this check when choosing token limits and when deciding whether an entry should count against the tool budget or the conversation budget.

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

**Purpose**: Builds the Guardian prompt for tests and simpler callers that do not need extra parent-turn permission context. It is a convenience wrapper around the fuller prompt builder.

**Data flow**: It receives a session, an optional retry reason, the approval request, and whether to build a full or delta prompt. It passes those along with no parent turn. It returns the completed Guardian prompt items or a JSON formatting error.

**Call relations**: This function immediately hands the work to build_guardian_prompt_items_with_parent_turn. It exists so callers can use the same prompt-building path without having to supply a parent turn.

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

**Purpose**: Creates the actual list of user-facing prompt items sent to the Guardian reviewer. It packages the transcript, session id, optional retry reason, permission warnings, and the exact action JSON under review.

**Data flow**: It starts with the current session history, optional parent turn, optional retry reason, approval request, and prompt mode. It copies the history, filters it into Guardian transcript entries, formats the proposed action as JSON, chooses full or delta transcript text, and appends clear headings and boundaries. It returns the prompt items, a cursor showing how much transcript has now been reviewed, and a flag saying whether the action JSON had to be shortened.

**Call relations**: This is the central builder used when running a Guardian review. It relies on transcript collection, transcript rendering, action formatting, and optional parent-turn permission context, then hands a clean prompt packet back to the review runner.

*Call graph*: calls 4 internal fn (format_guardian_action_pretty, collect_guardian_transcript_entries, render_guardian_transcript_entries, render_guardian_transcript_entries_with_offset); called by 2 (build_guardian_prompt_items, run_review_on_session); 3 external calls (new, clone_history, format!).


##### `parent_turn_denied_reads_context`  (lines 244–267)

```
fn parent_turn_denied_reads_context(turn: &TurnContext) -> Option<String>
```

**Purpose**: Creates a warning for the Guardian when the parent turn’s permission profile says certain files, folders, or path patterns must not be read. This helps prevent approving an escalation whose real purpose is to bypass those read restrictions.

**Data flow**: It receives a parent turn context and reads its working directory and file-system permission policy. It gathers unreadable roots and glob patterns into bullet points. If there are any, it returns a formatted warning string; otherwise it returns nothing.

**Call relations**: The main prompt builder calls this when a parent turn is available. If it returns a warning, that warning is inserted into the Guardian prompt before the approval request.

*Call graph*: 1 external calls (format!).


##### `render_guardian_transcript_entries`  (lines 297–305)

```
fn render_guardian_transcript_entries(
    entries: &[GuardianTranscriptEntry],
) -> (Vec<String>, Option<String>)
```

**Purpose**: Turns retained transcript entries into short, numbered text lines for a full Guardian review prompt. It also reports when some entries had to be left out.

**Data flow**: It receives the filtered transcript entries. It asks the offset-aware renderer to number them from the beginning and to use a full-transcript empty placeholder if there are no entries. It returns rendered transcript lines plus an optional omission note.

**Call relations**: The main prompt builder uses this for full reviews. It delegates the real selection and trimming work to render_guardian_transcript_entries_with_offset.

*Call graph*: calls 1 internal fn (render_guardian_transcript_entries_with_offset); called by 1 (build_guardian_prompt_items_with_parent_turn).


##### `render_guardian_transcript_entries_with_offset`  (lines 307–409)

```
fn render_guardian_transcript_entries_with_offset(
    entries: &[GuardianTranscriptEntry],
    entry_number_offset: usize,
    empty_placeholder: &str,
) -> (Vec<String>, Option<String>)
```

**Purpose**: Selects and formats the transcript evidence that will fit into the Guardian prompt. It keeps the most useful user and recent non-user evidence while respecting size limits.

**Data flow**: It receives transcript entries, a numbering offset, and text to show if the list is empty. It truncates each entry if needed, estimates its size, chooses which entries fit into message and tool budgets, and formats selected entries as numbered lines. It returns those lines and an omission note if anything was skipped.

**Call relations**: Full prompts and delta prompts both use this renderer. It calls the text truncation helper for each entry, then gives the prompt builder a compact transcript that is small enough to send to the Guardian.

*Call graph*: called by 2 (build_guardian_prompt_items_with_parent_turn, render_guardian_transcript_entries); 4 external calls (is_empty, iter, len, vec!).


##### `collect_guardian_transcript_entries`  (lines 419–521)

```
fn collect_guardian_transcript_entries(
    items: &[ResponseItem],
) -> Vec<GuardianTranscriptEntry>
```

**Purpose**: Filters raw session history into the conversation and tool evidence that the Guardian should review. It removes synthetic context that would add noise and keeps useful user, assistant, and tool information.

**Data flow**: It receives raw response items from the session history. It walks through them one by one, converts message content and tool data into plain text, skips empty or contextual-only entries, remembers tool names by call id, and labels tool results with the right tool name when possible. It returns a clean list of Guardian transcript entries.

**Call relations**: The main prompt builder calls this before rendering the transcript. Its output is the raw material that later gets trimmed, selected, numbered, and placed into the Guardian prompt.

*Call graph*: calls 3 internal fn (content_items_to_text, is_contextual_user_message_content, plaintext_agent_message_content); called by 1 (build_guardian_prompt_items_with_parent_turn); 4 external calls (new, new, Tool, to_string).


##### `guardian_truncate_text`  (lines 523–545)

```
fn guardian_truncate_text(content: &str, token_cap: usize) -> (String, bool)
```

**Purpose**: Shortens long text so it can fit inside a token budget, while clearly marking that content was omitted. A token is a rough chunk of text used by language models to measure prompt size.

**Data flow**: It receives text and a token cap. It estimates how many bytes fit in that cap; if the text already fits, it returns the original text and false. If it is too long, it keeps a safe prefix and suffix, inserts an omission marker with an approximate omitted-token count, and returns the shortened text with true.

**Call relations**: Transcript rendering uses this kind of truncation, and action formatting code also calls it through truncation paths for Guardian action values. It depends on split_guardian_truncation_bounds to avoid cutting text in the middle of a character.

*Call graph*: calls 1 internal fn (split_guardian_truncation_bounds); called by 1 (truncate_guardian_action_value); 4 external calls (new, approx_bytes_for_tokens, approx_tokens_from_byte_count, format!).


##### `split_guardian_truncation_bounds`  (lines 547–583)

```
fn split_guardian_truncation_bounds(
    content: &str,
    prefix_bytes: usize,
    suffix_bytes: usize,
) -> (&str, &str)
```

**Purpose**: Finds safe prefix and suffix slices for shortened text without breaking multi-byte characters. This is important because some characters, such as emoji or non-Latin letters, take more than one byte.

**Data flow**: It receives the original text plus byte budgets for the beginning and end. It walks character by character to find valid cut points. It returns two string slices: the safe prefix and the safe suffix.

**Call relations**: guardian_truncate_text calls this after deciding how much room is available around the omission marker. This helper keeps truncation valid and prevents malformed text.

*Call graph*: called by 1 (guardian_truncate_text).


##### `parse_guardian_assessment`  (lines 589–630)

```
fn parse_guardian_assessment(text: Option<&str>) -> anyhow::Result<GuardianAssessment>
```

**Purpose**: Reads the Guardian reviewer’s final answer and turns it into the program’s internal assessment object. It accepts strict JSON, and also tries to recover if the JSON is wrapped in extra prose.

**Data flow**: It receives optional text from the Guardian. If there is no text, it returns an error. It tries to parse the whole text as JSON; if that fails, it tries the substring between the first opening brace and last closing brace. It fills in safe defaults for missing risk level, user authorization, or rationale, then returns a GuardianAssessment.

**Call relations**: The Guardian review session calls this after the model finishes. Its output is what the rest of the approval flow uses to allow or deny the requested action.

*Call graph*: called by 1 (run_guardian_review_session_before_deadline); 1 external calls (bail!).


##### `guardian_output_schema`  (lines 645–668)

```
fn guardian_output_schema() -> Value
```

**Purpose**: Builds the JSON schema that tells the Guardian model what final answer shape is expected. The schema requires an outcome and limits fields to known values.

**Data flow**: It creates a JSON object describing allowed fields: risk level, user authorization, outcome, and rationale. It marks extra fields as not allowed and requires only the outcome. It returns that schema value.

**Call relations**: Review setup code uses this schema when asking the Guardian for structured final output. Tests also use it to confirm review parameters stay aligned.

*Call graph*: called by 2 (run_guardian_review, test_review_params); 1 external calls (json!).


##### `guardian_output_contract_prompt`  (lines 672–684)

```
fn guardian_output_contract_prompt() -> &'static str
```

**Purpose**: Provides the plain-text instructions that explain the Guardian’s required JSON answer format. It mirrors the schema in words so the model knows how to respond.

**Data flow**: It takes no input. It returns a fixed string explaining that the Guardian may use read-only checks and must finish with strict JSON, including the minimal allow form for low-risk actions.

**Call relations**: guardian_policy_prompt_with_config appends this text to the policy prompt. Keeping it near the schema helps the code and prompt stay consistent.


##### `guardian_policy_prompt`  (lines 695–697)

```
fn guardian_policy_prompt() -> String
```

**Purpose**: Builds the default Guardian policy prompt using the project’s bundled policy file. This is the main way the review session gets its standing safety instructions.

**Data flow**: It reads the bundled policy text from policy.md at compile time. It passes that policy text into the configurable prompt builder. It returns the final complete policy prompt string.

**Call relations**: Review setup can call this when it wants the default policy. The detailed assembly is delegated to guardian_policy_prompt_with_config.

*Call graph*: calls 1 internal fn (guardian_policy_prompt_with_config); 1 external calls (include_str!).


##### `guardian_policy_prompt_with_config`  (lines 699–703)

```
fn guardian_policy_prompt_with_config(tenant_policy_config: &str) -> String
```

**Purpose**: Combines the Guardian policy template with a supplied tenant policy configuration and the required JSON output instructions. This supports different policy settings while keeping the overall prompt structure fixed.

**Data flow**: It receives tenant-specific policy text. It reads the bundled policy template, replaces the template placeholder with the trimmed tenant policy text, appends the output contract prompt, and returns the final policy prompt.

**Call relations**: guardian_policy_prompt calls this with the default bundled policy. Other code or tests can use it to build the same policy shape with a custom configuration.

*Call graph*: called by 1 (guardian_policy_prompt); 2 external calls (format!, include_str!).


### Review session execution
Sets up review-mode turns and runs the reusable nested guardian review sessions that execute assessments.

### `core/src/session/review.rs`

`orchestration` · `request handling`

This file exists so the system can ask the model to review something without disturbing the main conversation turn. Think of it like opening a side notebook for a proofreader: it uses information from the main session, but it has its own instructions and some stricter rules.

The main job is to build a fresh turn context for the review. A turn context is the bundle of information a model run needs: which model to use, what tools are allowed, where the user is working, what permissions apply, what telemetry should record, and so on. For review turns, this file deliberately disables web search and some broader features, even if they are enabled globally. That matters because reviews should be based on the supplied target and prompt, not on outside browsing or unrelated goal-tracking behavior.

The code chooses the review model, asks the model manager for details about it, prepares the shell/tool environment, copies safe pieces from the parent turn, and creates metadata so the review can be tracked as its own sub-task. It then seeds the review with a synthesized user message: the resolved review prompt. Finally, it starts the review task and sends an event telling user interfaces that review mode has begun. Without this file, review requests would either have to run as ordinary chat turns or duplicate a lot of fragile setup code elsewhere.

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

**Purpose**: Starts a review task as a child of an existing session turn. It prepares a separate model run with review-specific settings, feeds it the generated review prompt, and tells the rest of the system that review mode has started.

**Data flow**: It receives the current session, global configuration, the parent turn context, a sub-task id, and a resolved review request containing the prompt and target. It chooses the review model, fetches that model’s information, disables review-disallowed features such as web search, builds a new turn context with copied parent data plus review-specific overrides, and wraps the review prompt as the first user message. The result is not returned directly; instead, it changes the session by spawning a review task and sending an EnteredReviewMode event for listeners such as the UI.

**Call relations**: This function is called when the session needs to launch a review flow. Inside that flow, it asks shared services such as the model manager for model details and available models, uses helper constructors to build metadata, extension data, skills context, and shell execution settings, then hands the prepared context and prompt to the session’s task runner through spawn_task. After the task is started, it sends a session event so clients can switch into review display mode.

*Call graph*: calls 7 internal fn (new, new, new, tool_user_shell_type, new, new, for_session); 8 external calls (new, new, new, unified_exec_feature_mode_for_features, default, EnteredReviewMode, warn!, vec!).


### `core/src/guardian/review_session.rs`

`orchestration` · `approval review / request handling`

Guardian review is like asking a second, read-only teammate to inspect a risky action before it happens. This file creates and supervises that teammate. Without it, the system would either have to start a fresh reviewer every time, wasting context and time, or risk reusing the wrong reviewer after settings changed.

The main idea is a cached “trunk” review session. If the Guardian’s configuration still matches the current request, the manager reuses that session and sends only the new material when possible. If the trunk is busy or no longer matches, it starts an “ephemeral” temporary session, sometimes forked from the trunk’s saved history, so parallel reviews do not block each other.

The file also builds a locked-down Guardian configuration. The reviewer is read-only, cannot ask for approval, has extra tools and hooks disabled, and receives Guardian policy instructions instead of the normal assistant instructions. Each review is submitted as a turn, then the code waits only for events from that exact turn, ignoring stale events from earlier turns. If time runs out or the user cancels, it interrupts the Guardian and drains the event stream so the session can be safely reused when possible. It also records analytics such as model choice, session kind, truncation, time to first token, and token usage.

#### Function details

##### `had_prior_review_context`  (lines 117–119)

```
fn had_prior_review_context(prompt_mode: &GuardianPromptMode) -> bool
```

**Purpose**: Reports whether the Guardian prompt is using earlier review context. This matters for analytics, because a full review and a smaller follow-up review are different experiences.

**Data flow**: It receives a prompt mode. If the mode is a delta review, meaning it starts from a saved point in the transcript, it returns true; otherwise it returns false.

**Call relations**: run_review_on_session asks this helper while preparing analytics for a Guardian run, so the recorded result can say whether the reviewer had prior context.

*Call graph*: called by 1 (run_review_on_session); 1 external calls (matches!).


##### `token_usage_delta`  (lines 121–130)

```
fn token_usage_delta(start: &TokenUsage, end: &TokenUsage) -> TokenUsage
```

**Purpose**: Calculates how many tokens the Guardian used during one review. Tokens are chunks of text the model reads or writes, and this keeps usage reporting focused on the review itself.

**Data flow**: It receives token totals from before and after a review. It subtracts the start totals from the end totals for each field, never allowing a negative number, and returns the difference as a new usage record.

**Call relations**: run_review_on_session calls this after a successful review when token totals are available, then stores the result in the analytics data.

*Call graph*: called by 1 (run_review_on_session).


##### `GuardianReviewSessionReuseKey::from_spawn_config`  (lines 172–198)

```
fn from_spawn_config(
        spawn_config: &Config,
        user_instructions: Option<UserInstructions>,
    ) -> Self
```

**Purpose**: Builds a fingerprint of the settings that affect a spawned Guardian session. The manager uses this fingerprint to decide whether an existing reviewer can be reused safely.

**Data flow**: It reads the Guardian spawn configuration plus current user instructions. It copies only the settings that can change model behavior, permissions, tools, working directory, or feature availability, and returns a reuse key.

**Call relations**: run_review uses this before choosing the trunk session. Tests also use it to build realistic cached sessions and to confirm that important configuration changes invalidate reuse.

*Call graph*: called by 7 (cache_for_test, register_ephemeral_for_test, run_review, guardian_review_session_compact_scope_change_invalidates_cached_session, guardian_review_session_config_change_invalidates_cached_session, run_review_removes_trunk_when_event_stream_is_broken, test_review_session).


##### `prompt_cache_key_override_for_review_session`  (lines 201–213)

```
fn prompt_cache_key_override_for_review_session(
    session_source: &SessionSource,
    parent_thread_id: Option<ThreadId>,
) -> Option<String>
```

**Purpose**: Creates a stable prompt-cache key for Guardian subagent sessions tied to a parent thread. This lets the model provider reuse cached prompt material without mixing different parent conversations.

**Data flow**: It receives a session source and an optional parent thread id. If the source is the Guardian reviewer and a parent thread id is present, it returns a string like guardian:<thread>; otherwise it returns no override.

**Call relations**: The dedicated cache-key test checks that this helper scopes Guardian caching to the parent thread and refuses non-Guardian or parentless sessions.

*Call graph*: called by 1 (guardian_prompt_cache_key_is_scoped_to_parent_thread); 1 external calls (format!).


##### `GuardianReviewSession::shutdown`  (lines 216–219)

```
async fn shutdown(&self)
```

**Purpose**: Stops a Guardian review session and waits for it to finish. This prevents background reviewer work from leaking after the manager no longer needs it.

**Data flow**: It cancels the session’s cancellation token, then asks the underlying Codex session to shut down and waits for completion. It does not return useful data; its effect is cleanup.

**Call relations**: The manager calls this during full shutdown, stale trunk replacement, ephemeral cleanup, and background shutdown paths.

*Call graph*: calls 1 internal fn (shutdown_and_wait); 1 external calls (cancel).


##### `GuardianReviewSession::shutdown_in_background`  (lines 221–226)

```
fn shutdown_in_background(self: &Arc<Self>)
```

**Purpose**: Starts shutdown for a Guardian session without making the caller wait. This is useful when the caller needs to return a review result promptly but still clean up old work.

**Data flow**: It clones the shared session handle, starts an asynchronous task, and that task calls shutdown. The caller gets no direct result.

**Call relations**: run_review uses this when discarding a stale or unhealthy trunk, and run_ephemeral_review uses it after a temporary review is finished.

*Call graph*: 2 external calls (clone, spawn).


##### `GuardianReviewSession::fork_snapshot`  (lines 228–230)

```
async fn fork_snapshot(&self) -> Option<GuardianReviewForkSnapshot>
```

**Purpose**: Returns the latest saved history snapshot that can seed a temporary forked Guardian session. This helps a parallel reviewer start with useful context instead of from scratch.

**Data flow**: It locks the session state, clones the saved fork snapshot if one exists, and returns it. Nothing is changed.

**Call relations**: run_review asks the trunk for this snapshot when the trunk is busy and an ephemeral review must be started.


##### `GuardianReviewSession::refresh_last_committed_fork_snapshot`  (lines 232–250)

```
async fn refresh_last_committed_fork_snapshot(&self)
```

**Purpose**: Updates the trunk’s saved history so future temporary reviews can fork from a recent, completed Guardian state. This keeps forked reviewers efficient and context-aware.

**Data flow**: It loads persisted rollout items from the session. If there are items, it stores them with the current review count and transcript cursor as the latest fork snapshot; if loading fails, it logs a warning.

**Call relations**: run_review calls this after a successful trunk review that should be kept, so later ephemeral reviews can inherit the latest committed Guardian conversation.

*Call graph*: calls 1 internal fn (load_rollout_items_for_fork); 2 external calls (Forked, warn!).


##### `EphemeralReviewCleanup::new`  (lines 254–262)

```
fn new(
        state: Arc<Mutex<GuardianReviewSessionState>>,
        review_session: Arc<GuardianReviewSession>,
    ) -> Self
```

**Purpose**: Creates a cleanup guard for a temporary Guardian review. A cleanup guard is like a safety tag: if the code exits early, it still knows what temporary session must be removed.

**Data flow**: It receives the shared manager state and the temporary review session. It stores both and marks the session as armed for cleanup.

**Call relations**: run_ephemeral_review creates this guard right after registering a temporary session, so unexpected exits still trigger cleanup.

*Call graph*: called by 1 (run_ephemeral_review).


##### `EphemeralReviewCleanup::disarm`  (lines 264–266)

```
fn disarm(&mut self)
```

**Purpose**: Turns off automatic cleanup for an ephemeral review guard. This is used after the session has already been removed and scheduled for shutdown normally.

**Data flow**: It clears the stored session from the guard. After that, dropping the guard will do nothing.

**Call relations**: run_ephemeral_review calls this after it successfully takes the temporary session out of the manager’s active list.


##### `EphemeralReviewCleanup::drop`  (lines 270–288)

```
fn drop(&mut self)
```

**Purpose**: Automatically cleans up a temporary Guardian review if its guard goes out of scope while still armed. This protects against leaks when a review exits through an error path.

**Data flow**: When dropped, it takes the stored review session, starts a background task, removes that exact session from the active ephemeral list, and shuts it down if found.

**Call relations**: This is the fallback path for EphemeralReviewCleanup created by run_ephemeral_review; disarm prevents it from running after normal cleanup.

*Call graph*: 2 external calls (clone, spawn).


##### `GuardianReviewSessionManager::trunk_rollout_path`  (lines 292–302)

```
async fn trunk_rollout_path(&self) -> Option<PathBuf>
```

**Purpose**: Returns the disk path for the cached trunk Guardian session’s rollout, if one exists. A rollout is the saved conversation/history used for persistence and forking.

**Data flow**: It looks up the trunk session, ensures its rollout file has been created, then asks for the current rollout path. If anything is missing or fails, it returns nothing and logs failures.

**Call relations**: External code can call this when it needs to inspect or persist the trunk review history; it operates only on the current trunk.

*Call graph*: 1 external calls (warn!).


##### `GuardianReviewSessionManager::shutdown`  (lines 304–318)

```
async fn shutdown(&self)
```

**Purpose**: Stops all Guardian review sessions owned by the manager. This is the main cleanup path when the parent session or process is ending.

**Data flow**: It removes the trunk and all active ephemeral sessions from shared state, then shuts each one down. Afterward, the manager no longer has active reviewer sessions.

**Call relations**: Higher-level teardown code calls this to avoid leaving reviewer sessions running after the main session is done.

*Call graph*: 1 external calls (take).


##### `GuardianReviewSessionManager::run_review`  (lines 324–449)

```
async fn run_review(
        &self,
        params: GuardianReviewSessionParams,
    ) -> (GuardianReviewSessionOutcome, GuardianReviewAnalyticsResult)
```

**Purpose**: Runs one Guardian review, choosing the safest and fastest session strategy. It reuses the trunk when possible, replaces stale trunks, or starts a temporary fork when the trunk is busy.

**Data flow**: It receives all review parameters, builds the expected reuse key, and checks the cached trunk under a lock. It may spawn a new trunk, shut down an old one, fall back to an ephemeral session, then runs the review and returns both the outcome and analytics.

**Call relations**: This is the manager’s central entry for Guardian review requests. It coordinates reuse-key creation, deadline-aware spawning, run_review_on_session, ephemeral fallback, trunk snapshot refresh, and removal of unhealthy trunks.

*Call graph*: calls 8 internal fn (without_session, remove_trunk_if_current, run_ephemeral_review, from_spawn_config, run_before_review_deadline, run_before_review_deadline_with_cancel, run_review_on_session, spawn_guardian_review_session); 8 external calls (clone, new, pin, new, anyhow!, Completed, PromptBuildFailed, matches!).


##### `GuardianReviewSessionManager::cache_for_test`  (lines 452–468)

```
async fn cache_for_test(&self, codex: Codex)
```

**Purpose**: Installs a provided Codex session as the cached trunk during tests. This lets tests control the reviewer session without starting a real one.

**Data flow**: It reads the Codex session configuration and user instructions, builds a reuse key, wraps the Codex session in GuardianReviewSession state, and stores it as the trunk.

**Call relations**: Test code can call this setup helper before exercising manager behavior that depends on a cached trunk.

*Call graph*: calls 1 internal fn (from_spawn_config); 4 external calls (new, new, new, new).


##### `GuardianReviewSessionManager::register_ephemeral_for_test`  (lines 471–491)

```
async fn register_ephemeral_for_test(&self, codex: Codex)
```

**Purpose**: Adds a provided Codex session to the active temporary review list during tests. This gives tests a way to simulate in-flight ephemeral reviews.

**Data flow**: It builds a reuse key from the Codex session, wraps the session with Guardian state, and pushes it into the manager’s ephemeral list.

**Call relations**: Test code uses this helper when it needs manager state that includes active temporary Guardian sessions.

*Call graph*: calls 1 internal fn (from_spawn_config); 4 external calls (new, new, new, new).


##### `GuardianReviewSessionManager::committed_fork_rollout_items_for_test`  (lines 494–502)

```
async fn committed_fork_rollout_items_for_test(&self) -> Option<Vec<RolloutItem>>
```

**Purpose**: Returns the trunk’s saved fork history items for tests. This lets tests confirm that successful trunk reviews refresh forkable history.

**Data flow**: It finds the trunk, reads its saved fork snapshot, and returns the stored rollout items only if the snapshot is a forked history.

**Call relations**: Tests call this after review flows that should have committed a fork snapshot.


##### `GuardianReviewSessionManager::send_trunk_event_raw_for_test`  (lines 505–514)

```
async fn send_trunk_event_raw_for_test(&self, event: Event)
```

**Purpose**: Injects a raw event into the trunk session during tests. This helps tests simulate model events without a real model.

**Data flow**: It looks up the trunk session and sends the provided event into that session’s event stream. It does not produce a returned value.

**Call relations**: Tests use this to drive code paths that wait for Guardian events.


##### `GuardianReviewSessionManager::remove_trunk_if_current`  (lines 516–530)

```
async fn remove_trunk_if_current(
        &self,
        trunk: &Arc<GuardianReviewSession>,
    ) -> Option<Arc<GuardianReviewSession>>
```

**Purpose**: Removes the trunk only if it is still the exact session the caller expects. This avoids accidentally deleting a newer trunk created by another task.

**Data flow**: It locks manager state, compares the stored trunk pointer with the provided trunk pointer, and takes the trunk out only if they match. It returns the removed session or nothing.

**Call relations**: run_review calls this when a trunk should be discarded after an unhealthy review result.

*Call graph*: called by 1 (run_review).


##### `GuardianReviewSessionManager::register_active_ephemeral`  (lines 532–538)

```
async fn register_active_ephemeral(&self, review_session: Arc<GuardianReviewSession>)
```

**Purpose**: Records a temporary Guardian session as active. This makes it visible to manager shutdown and cleanup logic.

**Data flow**: It locks shared state and appends the provided review session to the ephemeral list. It returns no data.

**Call relations**: run_ephemeral_review calls this immediately after spawning a temporary reviewer.

*Call graph*: called by 1 (run_ephemeral_review).


##### `GuardianReviewSessionManager::take_active_ephemeral`  (lines 540–550)

```
async fn take_active_ephemeral(
        &self,
        review_session: &Arc<GuardianReviewSession>,
    ) -> Option<Arc<GuardianReviewSession>>
```

**Purpose**: Removes a specific temporary Guardian session from the active list. This is used when its review has finished and it is ready to shut down.

**Data flow**: It locks shared state, searches for the exact session pointer, removes it with a fast swap, and returns it if found.

**Call relations**: run_ephemeral_review calls this during normal cleanup; the cleanup guard covers the case where this path is not reached.

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

**Purpose**: Runs a review in a one-off temporary Guardian session. This keeps reviews moving when the reusable trunk is busy or unsuitable.

**Data flow**: It marks the spawned config as ephemeral, starts a Guardian session before the deadline, registers it as active, runs the review, removes it from active state, and shuts it down in the background. It returns the review outcome and analytics.

**Call relations**: run_review delegates here when trunk reuse is unsafe or unavailable. This function uses spawn_guardian_review_session, run_review_on_session, and EphemeralReviewCleanup to make temporary review sessions safe.

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

**Purpose**: Starts a new Guardian Codex thread and wraps it in Guardian session state. It can start fresh or from a saved fork snapshot.

**Data flow**: It receives review parameters, a spawn configuration, a reuse key, a cancellation token, and optional fork history. It launches an interactive Codex subagent named as the Guardian reviewer, then returns a GuardianReviewSession with counters and cursors initialized.

**Call relations**: run_review uses this to create a trunk, and run_ephemeral_review uses it to create temporary forked reviewers.

*Call graph*: calls 1 internal fn (run_codex_thread_interactive); called by 2 (run_ephemeral_review, run_review); 6 external calls (clone, pin, clone, new, new, Other).


##### `run_review_on_session`  (lines 647–831)

```
async fn run_review_on_session(
    review_session: &GuardianReviewSession,
    params: &GuardianReviewSessionParams,
    guardian_session_kind: GuardianReviewSessionKind,
    deadline: tokio::time::I
```

**Purpose**: Submits one Guardian prompt to an already chosen review session and waits for the answer. This is where a selected reviewer actually performs the review.

**Data flow**: It reads review state to decide full versus delta prompt, gathers model and analytics information, optionally adds a follow-up reminder, builds prompt items, submits them with read-only settings, waits for the matching turn to finish, then updates counters, transcript cursor, token usage, and analytics.

**Call relations**: run_review and run_ephemeral_review both call this after choosing or spawning a session. It relies on prompt building, deadline guards, wait_for_guardian_review, and token_usage_delta.

*Call graph*: calls 9 internal fn (from_session, build_guardian_prompt_items_with_parent_turn, append_guardian_followup_reminder, had_prior_review_context, run_before_review_deadline, token_usage_delta, wait_for_guardian_review, read_only, new); called by 3 (run_ephemeral_review, run_review, run_review_on_reused_session_waits_for_submitted_turn); 4 external calls (pin, default, PromptBuildFailed, matches!).


##### `append_guardian_followup_reminder`  (lines 833–840)

```
async fn append_guardian_followup_reminder(review_session: &GuardianReviewSession)
```

**Purpose**: Adds a reminder message into the Guardian session after its first follow-up review. This nudges the reviewer to keep later reviews consistent with earlier context.

**Data flow**: It converts a GuardianFollowupReviewReminder into a response item and injects it into the session without starting a new turn.

**Call relations**: run_review_on_session calls this when the session state says exactly one prior review has happened.

*Call graph*: calls 1 internal fn (into); called by 1 (run_review_on_session); 1 external calls (vec!).


##### `load_rollout_items_for_fork`  (lines 842–850)

```
async fn load_rollout_items_for_fork(
    session: &Session,
) -> anyhow::Result<Option<Vec<RolloutItem>>>
```

**Purpose**: Loads the persisted Guardian conversation items needed to fork a temporary reviewer. This turns the current trunk history into reusable starting material.

**Data flow**: It ensures rollout persistence exists, flushes pending history to disk, opens the live thread used for persistence, loads its history including archived items, and returns those items.

**Call relations**: refresh_last_committed_fork_snapshot calls this after successful trunk reviews to capture a fork snapshot.

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

**Purpose**: Waits for the Guardian turn that was just submitted and turns its event stream into a clear outcome. It ignores events from older turns so reused sessions do not confuse stale messages with the current review.

**Data flow**: It receives the review session, expected turn id, deadline, optional cancellation token, and analytics record. It watches for timeout, cancellation, or matching events; on completion it returns the Guardian message or error, and tells the caller whether the session can be kept and whether token usage should be captured.

**Call relations**: run_review_on_session calls this after submitting a review. Several tests drive it directly to verify stale events, structured errors, timeouts, and cancellation behavior.

*Call graph*: called by 7 (run_review_on_session, wait_for_guardian_review_cancel_drains_expected_turn_after_stale_terminal_event, wait_for_guardian_review_ignores_prior_turn_aborts, wait_for_guardian_review_ignores_prior_turn_completion, wait_for_guardian_review_ignores_prior_turn_errors, wait_for_guardian_review_preserves_structured_session_error, wait_for_guardian_review_timeout_drains_expected_turn_after_stale_terminal_event); 3 external calls (pin!, select!, sleep_until).


##### `event_matches_turn`  (lines 936–948)

```
fn event_matches_turn(event: &Event, expected_turn_id: &str) -> bool
```

**Purpose**: Checks whether an event belongs to the Guardian turn currently being watched. This prevents stale events from earlier turns from ending the wrong review.

**Data flow**: It compares the event id with the expected turn id. For terminal events that also carry a turn id, it checks that inner id too, then returns true or false.

**Call relations**: interrupt_and_drain_turn uses this while draining after an interrupt; wait_for_guardian_review also applies the same matching logic when processing events.

*Call graph*: called by 1 (interrupt_and_drain_turn).


##### `build_guardian_review_session_config`  (lines 950–1026)

```
fn build_guardian_review_session_config(
    parent_config: &Config,
    live_network_config: Option<codex_network_proxy::NetworkProxyConfig>,
    active_model: &str,
    reasoning_effort: Option<code
```

**Purpose**: Creates the locked-down configuration used for Guardian review sessions. It keeps the reviewer focused, read-only, and separate from normal assistant behavior.

**Data flow**: It clones the parent configuration, switches to the review model and reasoning effort, installs Guardian policy instructions, disables notifications, memory, skill/app instructions, MCP servers, and risky features, forces read-only permissions and no approval requests, and applies live network proxy settings when needed. It returns the adjusted config or an error if constraints cannot be applied.

**Call relations**: Higher-level Guardian review setup calls this before run_review. Tests call it to confirm configuration changes affect reuse and that unsafe extras are disabled.

*Call graph*: calls 3 internal fn (allow_only, from_config_and_constraints, read_only); called by 6 (run_guardian_review_session_before_deadline, guardian_review_session_compact_scope_change_invalidates_cached_session, guardian_review_session_config_change_invalidates_cached_session, guardian_review_session_config_disables_hooks, guardian_review_session_config_disables_skill_instructions, test_review_params); 3 external calls (new, clone, warn!).


##### `run_before_review_deadline`  (lines 1028–1044)

```
async fn run_before_review_deadline(
    deadline: tokio::time::Instant,
    external_cancel: Option<&CancellationToken>,
    future: impl Future<Output = T>,
) -> Result<T, GuardianReviewSessionOutco
```

**Purpose**: Runs an asynchronous operation only while the Guardian review is still allowed to continue. It converts timeout or external cancellation into Guardian review outcomes.

**Data flow**: It receives a deadline, optional cancellation token, and future work. It waits for whichever happens first: the deadline, the work finishing, or cancellation; it returns the work result or a timed-out/aborted outcome.

**Call relations**: run_review and run_review_on_session wrap locking, prompt building, and submission with this helper. Tests verify both timeout and cancellation behavior.

*Call graph*: called by 5 (run_review, run_before_review_deadline_with_cancel, run_review_on_session, run_before_review_deadline_aborts_when_cancelled, run_before_review_deadline_times_out_before_future_completes); 1 external calls (select!).


##### `run_before_review_deadline_with_cancel`  (lines 1046–1057)

```
async fn run_before_review_deadline_with_cancel(
    deadline: tokio::time::Instant,
    external_cancel: Option<&CancellationToken>,
    cancel_token: &CancellationToken,
    future: impl Future<Outp
```

**Purpose**: Like run_before_review_deadline, but also cancels a provided token if the operation does not finish. This is useful when a spawned Guardian session must be told to stop after a timeout or abort.

**Data flow**: It runs the provided future under the deadline helper. If the result is an error outcome, it cancels the supplied cancellation token; otherwise it leaves the token alone.

**Call relations**: run_review and run_ephemeral_review use this around Guardian session spawning. Tests confirm that the token is cancelled only on timeout or abort.

*Call graph*: calls 1 internal fn (run_before_review_deadline); called by 5 (run_ephemeral_review, run_review, run_before_review_deadline_with_cancel_cancels_token_on_abort, run_before_review_deadline_with_cancel_cancels_token_on_timeout, run_before_review_deadline_with_cancel_preserves_token_on_success); 1 external calls (cancel).


##### `interrupt_and_drain_turn`  (lines 1059–1079)

```
async fn interrupt_and_drain_turn(codex: &Codex, expected_turn_id: &str) -> anyhow::Result<()>
```

**Purpose**: Interrupts an active Guardian turn and waits until the event stream reaches that turn’s final event. This makes session reuse safer after timeouts or cancellations.

**Data flow**: It sends an interrupt operation to the Codex session, then reads events until it sees the expected turn complete or abort, with a short drain timeout. It returns success if the stream reaches that clean end, otherwise an error.

**Call relations**: wait_for_guardian_review calls this when a review times out or is externally cancelled. The related test checks that it ignores terminal events from older turns.

*Call graph*: calls 3 internal fn (event_matches_turn, next_event, submit); called by 1 (interrupt_and_drain_turn_ignores_prior_turn_completion); 2 external calls (matches!, timeout).


##### `tests::test_review_session`  (lines 1091–1127)

```
async fn test_review_session() -> (
        GuardianReviewSession,
        async_channel::Sender<Event>,
        async_channel::Receiver<Submission>,
    )
```

**Purpose**: Builds a fake Guardian review session for tests. It provides controllable event and submission channels so tests can simulate the model.

**Data flow**: It creates a test session and turn context, wires channels for submissions and events, builds a reuse key, and returns the GuardianReviewSession plus the channels.

**Call relations**: Many review-session tests use this helper before driving wait_for_guardian_review, interrupt behavior, or manager cleanup.

*Call graph*: calls 3 internal fn (from_spawn_config, completed_session_loop_termination, make_session_and_context_with_rx); 6 external calls (new, new, new, bounded, unbounded, channel).


##### `tests::turn_complete_event`  (lines 1129–1144)

```
fn turn_complete_event(
        turn_id: &str,
        last_agent_message: Option<&str>,
        time_to_first_token_ms: Option<i64>,
    ) -> Event
```

**Purpose**: Creates a test event representing a completed turn. This keeps test setup short and consistent.

**Data flow**: It receives a turn id, optional final agent message, and optional time-to-first-token value. It returns an Event containing a TurnComplete message with those values.

**Call relations**: Tests feed these events into fake Guardian sessions to make wait_for_guardian_review finish.

*Call graph*: 1 external calls (TurnComplete).


##### `tests::turn_aborted_event`  (lines 1146–1156)

```
fn turn_aborted_event(turn_id: &str) -> Event
```

**Purpose**: Creates a test event representing an interrupted turn. This helps tests simulate cancellation and interrupt cleanup.

**Data flow**: It receives a turn id and returns an Event containing a TurnAborted message for that id.

**Call relations**: Timeout, cancellation, and interrupt-drain tests use this helper to signal that the expected turn ended after interruption.

*Call graph*: 1 external calls (TurnAborted).


##### `tests::test_review_params`  (lines 1158–1199)

```
async fn test_review_params() -> GuardianReviewSessionParams
```

**Purpose**: Builds realistic Guardian review parameters for tests. This avoids repeating a large setup block in each test.

**Data flow**: It creates a test parent session and turn, builds a Guardian config, fills in a sample shell approval request, schema, model settings, personality, and deadline, then returns the parameter object.

**Call relations**: Review-flow tests call this before invoking run_review_on_session or manager run_review paths.

*Call graph*: calls 3 internal fn (guardian_output_schema, build_guardian_review_session_config, make_session_and_context); 4 external calls (new, from_secs, now, vec!).


##### `tests::guardian_review_session_config_change_invalidates_cached_session`  (lines 1202–1239)

```
async fn guardian_review_session_config_change_invalidates_cached_session()
```

**Purpose**: Checks that a meaningful model-provider configuration change makes a cached Guardian session unusable. This protects against reusing a reviewer with old connection settings.

**Data flow**: It builds one Guardian config and reuse key, changes the parent model provider base URL, builds another config and key, and asserts that the keys differ while the original key remains stable.

**Call relations**: This test exercises build_guardian_review_session_config and GuardianReviewSessionReuseKey::from_spawn_config together.

*Call graph*: calls 3 internal fn (test_config, from_spawn_config, build_guardian_review_session_config); 2 external calls (assert_eq!, assert_ne!).


##### `tests::guardian_prompt_cache_key_is_scoped_to_parent_thread`  (lines 1242–1279)

```
async fn guardian_prompt_cache_key_is_scoped_to_parent_thread()
```

**Purpose**: Checks that Guardian prompt cache keys are tied to the parent thread and only apply to Guardian subagents. This prevents cache sharing across unrelated conversations.

**Data flow**: It builds a Guardian session source and parent thread id, asks for cache keys with same and different parents, and checks non-Guardian or missing-parent cases return none.

**Call relations**: This test directly validates prompt_cache_key_override_for_review_session.

*Call graph*: calls 2 internal fn (prompt_cache_key_override_for_review_session, new); 5 external calls (SubAgent, assert!, assert_eq!, assert_ne!, Other).


##### `tests::guardian_review_session_compact_scope_change_invalidates_cached_session`  (lines 1282–1312)

```
async fn guardian_review_session_compact_scope_change_invalidates_cached_session()
```

**Purpose**: Checks that changing auto-compaction scope invalidates Guardian session reuse. Compaction changes what history the model sees, so reuse must be conservative.

**Data flow**: It builds a reuse key from the default config, changes the compact token limit scope, builds a second key, and asserts that they differ.

**Call relations**: This test covers the reuse-key fields selected by GuardianReviewSessionReuseKey::from_spawn_config.

*Call graph*: calls 3 internal fn (test_config, from_spawn_config, build_guardian_review_session_config); 1 external calls (assert_ne!).


##### `tests::guardian_review_session_config_disables_hooks`  (lines 1315–1331)

```
async fn guardian_review_session_config_disables_hooks()
```

**Purpose**: Checks that Guardian configs turn off hook features. Hooks are extension points that should not run inside this safer reviewer session.

**Data flow**: It enables hooks on a parent test config, builds the Guardian config, and asserts hooks are disabled there.

**Call relations**: This test validates one safety rule in build_guardian_review_session_config.

*Call graph*: calls 2 internal fn (test_config, build_guardian_review_session_config); 1 external calls (assert!).


##### `tests::guardian_review_session_config_disables_skill_instructions`  (lines 1334–1347)

```
async fn guardian_review_session_config_disables_skill_instructions()
```

**Purpose**: Checks that Guardian sessions do not include skill instructions from the parent. The reviewer should follow Guardian policy, not unrelated assistant skills.

**Data flow**: It enables skill instructions on the parent config, builds the Guardian config, and asserts the Guardian setting is off.

**Call relations**: This test validates another isolation rule in build_guardian_review_session_config.

*Call graph*: calls 2 internal fn (test_config, build_guardian_review_session_config); 1 external calls (assert!).


##### `tests::run_before_review_deadline_times_out_before_future_completes`  (lines 1350–1364)

```
async fn run_before_review_deadline_times_out_before_future_completes()
```

**Purpose**: Verifies that the deadline helper reports a timeout when work takes too long.

**Data flow**: It runs a future that sleeps longer than a short deadline and checks that the result is TimedOut.

**Call relations**: This test directly exercises run_before_review_deadline.

*Call graph*: calls 1 internal fn (run_before_review_deadline); 4 external calls (from_millis, assert!, now, sleep).


##### `tests::run_before_review_deadline_aborts_when_cancelled`  (lines 1367–1386)

```
async fn run_before_review_deadline_aborts_when_cancelled()
```

**Purpose**: Verifies that the deadline helper reports an abort when an external cancellation token fires.

**Data flow**: It starts a task that cancels a token shortly after the test begins, runs pending work with that token, and checks that the result is Aborted.

**Call relations**: This test directly exercises the cancellation branch of run_before_review_deadline.

*Call graph*: calls 1 internal fn (run_before_review_deadline); 7 external calls (new, from_millis, from_secs, assert!, spawn, now, sleep).


##### `tests::run_before_review_deadline_with_cancel_cancels_token_on_timeout`  (lines 1389–1407)

```
async fn run_before_review_deadline_with_cancel_cancels_token_on_timeout()
```

**Purpose**: Checks that the cancel-aware deadline helper cancels its internal token after a timeout.

**Data flow**: It runs work that sleeps past the deadline, expects a TimedOut result, and verifies the supplied cancellation token is marked cancelled.

**Call relations**: This test directly validates run_before_review_deadline_with_cancel.

*Call graph*: calls 1 internal fn (run_before_review_deadline_with_cancel); 5 external calls (new, from_millis, assert!, now, sleep).


##### `tests::run_before_review_deadline_with_cancel_cancels_token_on_abort`  (lines 1410–1432)

```
async fn run_before_review_deadline_with_cancel_cancels_token_on_abort()
```

**Purpose**: Checks that the cancel-aware deadline helper cancels its internal token after external abort.

**Data flow**: It arranges an external token to cancel, runs pending work through the helper, then checks for Aborted and confirms the internal token was cancelled.

**Call relations**: This test validates the abort path of run_before_review_deadline_with_cancel.

*Call graph*: calls 1 internal fn (run_before_review_deadline_with_cancel); 7 external calls (new, from_millis, from_secs, assert!, spawn, now, sleep).


##### `tests::run_before_review_deadline_with_cancel_preserves_token_on_success`  (lines 1435–1448)

```
async fn run_before_review_deadline_with_cancel_preserves_token_on_success()
```

**Purpose**: Checks that successful work does not cancel the supplied token. This prevents normal Guardian spawning from being stopped accidentally.

**Data flow**: It runs a quick future returning a number, asserts the number is returned, and verifies the token is still active.

**Call relations**: This test validates the success path of run_before_review_deadline_with_cancel.

*Call graph*: calls 1 internal fn (run_before_review_deadline_with_cancel); 5 external calls (new, from_secs, assert!, assert_eq!, now).


##### `tests::had_prior_review_context_tracks_prompt_mode`  (lines 1451–1459)

```
fn had_prior_review_context_tracks_prompt_mode()
```

**Purpose**: Checks that full prompts are not marked as prior-context reviews and delta prompts are. This keeps analytics classification accurate.

**Data flow**: It calls the helper with a full mode and a delta mode, then asserts the expected false and true results.

**Call relations**: This test directly validates had_prior_review_context.

*Call graph*: 1 external calls (assert!).


##### `tests::token_usage_delta_never_reports_negative_usage`  (lines 1462–1488)

```
fn token_usage_delta_never_reports_negative_usage()
```

**Purpose**: Checks that token usage differences never go below zero. This guards against odd counters or resets creating impossible negative analytics.

**Data flow**: It builds start and end usage records where some end fields are lower, calls token_usage_delta, and asserts those fields become zero while positive deltas remain.

**Call relations**: This test directly validates token_usage_delta.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::run_review_on_reused_session_waits_for_submitted_turn`  (lines 1491–1534)

```
async fn run_review_on_reused_session_waits_for_submitted_turn()
```

**Purpose**: Verifies that a reused Guardian session waits for the newly submitted turn, not an older completion event. This is important because reused sessions may still have stale events in their stream.

**Data flow**: It prepares a session with prior review state, starts run_review_on_session, captures the submitted turn id, sends one stale completion and one matching completion, and checks that the fresh result is used.

**Call relations**: This test exercises run_review_on_session and the turn-matching behavior inside wait_for_guardian_review.

*Call graph*: calls 1 internal fn (run_review_on_session); 9 external calls (from_secs, assert!, assert_eq!, test_review_params, test_review_session, turn_complete_event, panic!, spawn, now).


##### `tests::run_review_removes_trunk_when_event_stream_is_broken`  (lines 1537–1559)

```
async fn run_review_removes_trunk_when_event_stream_is_broken()
```

**Purpose**: Checks that the manager discards a trunk session if its event stream is broken. A broken reviewer should not be cached for future reviews.

**Data flow**: It creates a manager with a matching trunk, drops the event sender to break the stream, runs a review, and asserts the outcome is an error and the trunk is gone.

**Call relations**: This test drives GuardianReviewSessionManager::run_review and its remove_trunk_if_current cleanup path.

*Call graph*: calls 1 internal fn (from_spawn_config); 6 external calls (new, new, new, assert!, test_review_params, test_review_session).


##### `tests::wait_for_guardian_review_ignores_prior_turn_completion`  (lines 1562–1590)

```
async fn wait_for_guardian_review_ignores_prior_turn_completion()
```

**Purpose**: Checks that waiting for a Guardian review ignores completion events from older turns.

**Data flow**: It sends a stale completion followed by the current turn completion, then verifies the returned message and timing come from the current turn.

**Call relations**: This test directly exercises wait_for_guardian_review.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 7 external calls (from_secs, assert!, assert_eq!, test_review_session, turn_complete_event, panic!, now).


##### `tests::wait_for_guardian_review_ignores_prior_turn_errors`  (lines 1593–1631)

```
async fn wait_for_guardian_review_ignores_prior_turn_errors()
```

**Purpose**: Checks that errors from older turns do not poison the current Guardian review.

**Data flow**: It sends a stale error event, then a current turn completion with no final message, and verifies the current turn completes normally.

**Call relations**: This test validates wait_for_guardian_review’s filtering of stale events.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 8 external calls (from_secs, assert!, assert_eq!, test_review_session, turn_complete_event, panic!, Error, now).


##### `tests::wait_for_guardian_review_preserves_structured_session_error`  (lines 1634–1672)

```
async fn wait_for_guardian_review_preserves_structured_session_error()
```

**Purpose**: Checks that a current-turn Guardian error keeps its structured error information. Structured error information lets higher layers distinguish causes such as server overload.

**Data flow**: It sends a current-turn error with a structured code, then a completion without a final message, and asserts the outcome contains the original message and code.

**Call relations**: This test validates the error-handling path in wait_for_guardian_review.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 8 external calls (from_secs, assert!, assert_eq!, test_review_session, turn_complete_event, panic!, Error, now).


##### `tests::wait_for_guardian_review_ignores_prior_turn_aborts`  (lines 1675–1703)

```
async fn wait_for_guardian_review_ignores_prior_turn_aborts()
```

**Purpose**: Checks that abort events from older turns do not abort the current review.

**Data flow**: It sends a stale abort event followed by a current completion, then verifies the current review succeeds.

**Call relations**: This test directly validates stale-abort filtering in wait_for_guardian_review.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 8 external calls (from_secs, assert!, assert_eq!, test_review_session, turn_aborted_event, turn_complete_event, panic!, now).


##### `tests::wait_for_guardian_review_timeout_drains_expected_turn_after_stale_terminal_event`  (lines 1706–1738)

```
async fn wait_for_guardian_review_timeout_drains_expected_turn_after_stale_terminal_event()
```

**Purpose**: Checks that timeout cleanup interrupts and drains the expected current turn, even if an older terminal event appears first.

**Data flow**: It sends a stale completion, lets the review timeout, intercepts the interrupt submission, sends a current-turn abort, and verifies the review reports TimedOut while keeping the session reusable.

**Call relations**: This test exercises wait_for_guardian_review together with interrupt_and_drain_turn behavior.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 7 external calls (from_millis, assert!, test_review_session, turn_aborted_event, turn_complete_event, spawn, now).


##### `tests::wait_for_guardian_review_cancel_drains_expected_turn_after_stale_terminal_event`  (lines 1741–1775)

```
async fn wait_for_guardian_review_cancel_drains_expected_turn_after_stale_terminal_event()
```

**Purpose**: Checks that cancellation cleanup also drains the expected current turn after ignoring stale terminal events.

**Data flow**: It sends a stale completion, uses an already-cancelled external token, observes the interrupt submission, sends the current abort, and checks the outcome is Aborted and reusable.

**Call relations**: This test validates wait_for_guardian_review’s external-cancel path and its use of interrupt draining.

*Call graph*: calls 2 internal fn (without_session, wait_for_guardian_review); 8 external calls (new, from_secs, assert!, test_review_session, turn_aborted_event, turn_complete_event, spawn, now).


##### `tests::interrupt_and_drain_turn_ignores_prior_turn_completion`  (lines 1778–1794)

```
async fn interrupt_and_drain_turn_ignores_prior_turn_completion()
```

**Purpose**: Checks that interrupt draining waits for the target turn and ignores older completions. This prevents cleanup from stopping too early.

**Data flow**: It sends an old completion and a current abort, calls interrupt_and_drain_turn, and confirms the event stream has been drained through the current abort.

**Call relations**: This test directly exercises interrupt_and_drain_turn and its event_matches_turn filtering.

*Call graph*: calls 1 internal fn (interrupt_and_drain_turn); 4 external calls (assert!, test_review_session, turn_aborted_event, turn_complete_event).


### Approval review orchestration
Coordinates the full guardian approval-review workflow, tying request modeling, prompt generation, session execution, and outcome handling together.

### `core/src/guardian/review.rs`

`orchestration` · `request handling`

When the agent wants to do something that needs permission, this file can route that request to a special “guardian” reviewer instead of asking the user directly. The guardian is another locked-down review session whose job is only to judge risk. Think of it like a safety inspector: the main worker pauses, the inspector reads the proposed action, and then returns a clear allow-or-deny decision.

The file starts by creating review IDs, deciding whether a request should go to the guardian, and formatting messages for denied or timed-out reviews. The main path sends an “in progress” event, runs the guardian review with a deadline, retries only for problems that are likely temporary, parses the guardian’s answer, and then turns that answer into a normal approval decision.

It is deliberately cautious. If the guardian cannot be reached, gives malformed output, or fails in most ways, the code “fails closed,” meaning it blocks the action rather than silently allowing it. Timeouts are treated specially: they still do not approve the action, but callers can tell the difference between a timeout and an explicit denial.

The file also records metrics, stores denial reasons so later messages can explain them, and has a circuit breaker that interrupts a turn if too many automatic reviews are denied in a row.

#### Function details

##### `new_guardian_review_id`  (lines 67–69)

```
fn new_guardian_review_id() -> String
```

**Purpose**: Creates a fresh unique ID for one guardian review. This lets events, metrics, stored rejection reasons, and final decisions all refer to the same review.

**Data flow**: It takes no input. It asks the UUID library for a new random identifier and turns it into text. The output is that text ID.

**Call relations**: Other approval-review code can call this before starting a review, then pass the ID through the rest of this file so every later event can be tied back to the same review.

*Call graph*: 1 external calls (new_v4).


##### `guardian_rejection_message`  (lines 71–90)

```
async fn guardian_rejection_message(session: &Session, review_id: &str) -> String
```

**Purpose**: Builds the message shown after the guardian has rejected an action. It explains the reason and warns the agent not to work around the denial.

**Data flow**: It receives the session and a review ID. It looks up and removes the saved rejection reason for that ID; if none exists, it uses a generic fallback reason. It returns a user-facing text message with the rationale and safety instructions.

**Call relations**: This is used after a denial has already been recorded by the review flow. It depends on the rejection store populated by run_guardian_review when the guardian denies an action.

*Call graph*: 1 external calls (format!).


##### `guardian_timeout_message`  (lines 92–94)

```
fn guardian_timeout_message() -> String
```

**Purpose**: Returns the standard message used when the guardian review did not finish in time. The wording tells the agent not to assume the action is unsafe solely because of the timeout.

**Data flow**: It takes no input. It copies a fixed instruction string into a new text value. The output is that timeout message.

**Call relations**: Callers use this when a review ends with the timed-out decision produced by run_guardian_review.


##### `GuardianReviewError::prompt_build`  (lines 119–123)

```
fn prompt_build(err: anyhow::Error) -> Self
```

**Purpose**: Wraps a prompt or configuration-building failure in the guardian review error type. This keeps prompt setup failures separate from model-session failures or parsing failures.

**Data flow**: It receives a general error value. It converts that error into readable text and stores it in the PromptBuild variant. The output is a GuardianReviewError.

**Call relations**: run_guardian_review_session_before_deadline uses this when it cannot prepare the guardian review session. The tests also call it to confirm that this kind of error is classified correctly.

*Call graph*: called by 3 (guardian_review_error_reason_distinguishes_error_kinds, guardian_review_retry_only_retries_transient_session_and_parse_errors, run_guardian_review_session_before_deadline); 1 external calls (to_string).


##### `GuardianReviewError::session`  (lines 125–130)

```
fn session(err: anyhow::Error) -> Self
```

**Purpose**: Wraps a guardian session failure when there is no structured error detail. It records the problem as text so it can be surfaced and tracked.

**Data flow**: It receives a general error value. It converts it to a message and stores it as a Session error with no extra error info. The output is a GuardianReviewError.

**Call relations**: run_guardian_review_session_before_deadline uses this for ordinary guardian runtime failures. The tests use it to check retry and failure-reason behavior.

*Call graph*: called by 3 (guardian_review_error_reason_distinguishes_error_kinds, guardian_review_retry_only_retries_transient_session_and_parse_errors, run_guardian_review_session_before_deadline); 1 external calls (to_string).


##### `GuardianReviewError::session_with_error_info`  (lines 132–137)

```
fn session_with_error_info(err: anyhow::Error, error_info: CodexErrorInfo) -> Self
```

**Purpose**: Wraps a guardian session failure together with structured error information. The structured part lets retry logic tell temporary service problems apart from permanent failures.

**Data flow**: It receives a general error and a CodexErrorInfo value. It stores the error message and the structured detail inside a Session error. The output is a GuardianReviewError.

**Call relations**: run_guardian_review_session_before_deadline uses this when the lower review session reports extra error details. should_retry_guardian_review later reads those details to decide whether another attempt is worth trying.

*Call graph*: called by 3 (guardian_review_error_reason_distinguishes_error_kinds, guardian_review_retry_only_retries_transient_session_and_parse_errors, run_guardian_review_session_before_deadline); 1 external calls (to_string).


##### `GuardianReviewError::parse`  (lines 139–143)

```
fn parse(err: anyhow::Error) -> Self
```

**Purpose**: Wraps a failure to read the guardian’s answer. This is used when the review session produced text, but it did not match the expected assessment format.

**Data flow**: It receives a general parsing error. It turns the error into text and stores it in the Parse variant. The output is a GuardianReviewError.

**Call relations**: run_guardian_review_session_before_deadline uses this after parse_guardian_assessment fails. The retry logic treats parse errors as retryable, and tests confirm that behavior.

*Call graph*: called by 3 (guardian_review_error_reason_distinguishes_error_kinds, guardian_review_retry_only_retries_transient_session_and_parse_errors, run_guardian_review_session_before_deadline); 1 external calls (to_string).


##### `GuardianReviewError::failure_reason`  (lines 145–153)

```
fn failure_reason(&self) -> GuardianReviewFailureReason
```

**Purpose**: Converts an internal guardian review error into the smaller set of failure reasons used by analytics. This keeps reporting consistent even though the code has more detailed error variants.

**Data flow**: It reads the kind of GuardianReviewError it was called on. It maps that kind to a GuardianReviewFailureReason such as timeout, cancelled, parse error, session error, or prompt-build error. The output is the analytics-friendly reason.

**Call relations**: run_guardian_review calls this when tracking failed, timed-out, or aborted reviews. The tests verify that each internal error kind reports the expected analytics reason.


##### `guardian_risk_level_str`  (lines 156–163)

```
fn guardian_risk_level_str(level: GuardianRiskLevel) -> &'static str
```

**Purpose**: Turns a guardian risk level into plain text for warning messages. This avoids exposing enum-style names directly to users.

**Data flow**: It receives a risk level such as low, medium, high, or critical. It chooses the matching lowercase word. The output is a static text slice.

**Call relations**: run_guardian_review uses this when it writes the final approval or denial warning shown to the session.


##### `routes_approval_to_guardian`  (lines 168–170)

```
fn routes_approval_to_guardian(turn: &TurnContext) -> bool
```

**Purpose**: Decides whether the current turn should send approval prompts to the automatic guardian reviewer. It uses the reviewer setting already stored on the turn.

**Data flow**: It receives the turn context. It reads the turn’s approval policy and configured approvals reviewer, then delegates the actual check. The output is true if guardian review should be used, otherwise false.

**Call relations**: This is the simple entry point for routing decisions. It hands the details to routes_approval_to_guardian_with_reviewer so the same rule can also be used with an explicit reviewer choice.

*Call graph*: calls 1 internal fn (routes_approval_to_guardian_with_reviewer).


##### `routes_approval_to_guardian_with_reviewer`  (lines 173–181)

```
fn routes_approval_to_guardian_with_reviewer(
    turn: &TurnContext,
    approvals_reviewer: ApprovalsReviewer,
) -> bool
```

**Purpose**: Applies the exact rule for guardian routing. Approval prompts go to the guardian only when approvals are request-based or granular, and the selected reviewer is AutoReview.

**Data flow**: It receives a turn context and an approvals reviewer choice. It reads the turn’s approval policy and compares the reviewer to AutoReview. The output is a boolean routing decision.

**Call relations**: routes_approval_to_guardian calls this with the turn’s configured reviewer. Other code can use it when an approval request brings its own reviewer selection.

*Call graph*: called by 1 (routes_approval_to_guardian); 1 external calls (matches!).


##### `is_guardian_reviewer_source`  (lines 183–191)

```
fn is_guardian_reviewer_source(
    session_source: &codex_protocol::protocol::SessionSource,
) -> bool
```

**Purpose**: Checks whether a session source represents the guardian reviewer itself. This helps distinguish guardian sub-agent work from normal user-facing agent work.

**Data flow**: It receives a session source. It checks whether it is a sub-agent labeled with the guardian reviewer name. The output is true for guardian review sessions and false otherwise.

**Call relations**: Other parts of the guardian system can use this to recognize review-session traffic and avoid treating it like ordinary agent activity.

*Call graph*: 1 external calls (matches!).


##### `track_guardian_review`  (lines 193–212)

```
fn track_guardian_review(
    session: &Session,
    tracking: &GuardianReviewTrackContext,
    approval_request_source: GuardianApprovalRequestSource,
    reviewed_action: &GuardianReviewedAction,
```

**Purpose**: Records the outcome of a guardian review in both metrics and analytics. Metrics are useful for system health, while analytics events preserve richer review details.

**Data flow**: It receives the session, tracking context, request source, reviewed action, final result, and completion time. It calculates elapsed time from the review start, emits metrics, and sends an analytics event. It returns nothing but causes those tracking side effects.

**Call relations**: run_guardian_review calls this whenever a review reaches a terminal state: approved, denied, timed out, failed, or aborted.

*Call graph*: calls 1 internal fn (emit_guardian_review_metrics); called by 1 (run_guardian_review).


##### `record_guardian_non_denial`  (lines 214–221)

```
async fn record_guardian_non_denial(session: &Arc<Session>, turn_id: &str)
```

**Purpose**: Tells the denial circuit breaker that this review did not count as a denial. This resets or advances the safety counter so one bad streak does not continue forever.

**Data flow**: It receives the session and turn ID. It locks the circuit-breaker state and records a non-denial for that turn. It returns nothing, but updates shared session state.

**Call relations**: run_guardian_review calls this for approvals, timeouts, cancellations, and failures that should not count as explicit guardian denials.

*Call graph*: called by 1 (run_guardian_review).


##### `record_guardian_denial`  (lines 223–261)

```
async fn record_guardian_denial(session: &Arc<Session>, turn: &Arc<TurnContext>, turn_id: &str)
```

**Purpose**: Records an explicit guardian denial and interrupts the turn if too many denials happen close together. This prevents the agent from repeatedly asking for risky actions after being rejected.

**Data flow**: It receives the session, turn context, and turn ID. It updates the denial circuit breaker. If the breaker says to interrupt, it sends a warning event and starts an asynchronous abort of the active turn. The output is no direct value, but the turn may be interrupted.

**Call relations**: run_guardian_review calls this after a completed guardian assessment denies the request. record_guardian_denial_for_test calls it so tests can exercise the same behavior.

*Call graph*: called by 2 (record_guardian_denial_for_test, run_guardian_review); 3 external calls (clone, format!, GuardianWarning).


##### `record_guardian_denial_for_test`  (lines 264–270)

```
async fn record_guardian_denial_for_test(
    session: &Arc<Session>,
    turn: &Arc<TurnContext>,
    turn_id: &str,
)
```

**Purpose**: Exposes the denial-recording behavior to tests. It exists only in test builds.

**Data flow**: It receives the same session, turn context, and turn ID used by the real helper. It forwards them to record_guardian_denial. The output is whatever state changes that helper performs.

**Call relations**: Test code calls this wrapper instead of reaching into the private helper directly. The wrapper keeps production visibility narrow while still allowing coverage.

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

**Purpose**: Runs the full guardian approval review from start to finish. It announces the review, runs the reviewer, tracks the result, sends final events, stores denial reasons, updates the circuit breaker, and returns the approval decision.

**Data flow**: It receives the session, turn, review ID, approval request, optional retry reason, request source, and optional cancellation token. It extracts IDs and action summaries, sends an in-progress event, checks for early cancellation, runs the guardian session with retry, converts the outcome into approved, denied, timed out, or aborted, and records events and analytics. The output is a ReviewDecision, and it also updates session state such as rejection rationales and denial counters.

**Call relations**: review_approval_request and review_approval_request_with_cancel are the public-facing wrappers that call this. Inside, it hands the model work to run_guardian_review_session_with_retry, hands tracking to track_guardian_review, and updates denial state through record_guardian_denial or record_guardian_non_denial.

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

**Purpose**: Starts a guardian review for a normal main-turn approval request. It is the public entry point when no external cancellation token is needed.

**Data flow**: It receives borrowed shared session and turn handles, a review ID, the request, and an optional retry reason. It clones the shared handles, marks the source as MainTurn, and calls the main review runner. The output is the final ReviewDecision.

**Call relations**: Callers use this instead of calling run_guardian_review directly. It keeps the common case small and hides the lower-level options.

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

**Purpose**: Starts a guardian review that can be cancelled from outside. This is useful when the parent work may be stopped while the review is still running.

**Data flow**: It receives the session, turn, review ID, request, retry reason, request source, and cancellation token. It passes those into the main review runner. The output is the final ReviewDecision, which may be Abort if cancellation wins.

**Call relations**: spawn_approval_request_review calls this inside its separate runtime. It is also the direct wrapper for callers that need cancellation-aware guardian review.

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

**Purpose**: Runs a guardian review on a separate operating-system thread and returns a one-shot receiver for the answer. A one-shot receiver is a small channel that delivers exactly one value.

**Data flow**: It receives all information needed for a guardian review. It creates a one-use channel, starts a new thread, builds a small Tokio async runtime there, runs the cancellation-aware review, and sends the final decision back through the channel. The output is the receiving end of that channel; if runtime creation fails, the sent decision is Denied.

**Call relations**: This is used when the caller wants to kick off review work without awaiting it directly in the current async task. The spawned thread calls review_approval_request_with_cancel, which then calls run_guardian_review.

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

**Purpose**: Runs one actual guardian review attempt before a fixed deadline. It prepares the locked-down review configuration, chooses the review model, launches the guardian session, and parses the guardian’s final answer.

**Data flow**: It receives the parent session and turn, approval request, retry reason, required output schema, optional cancellation token, and deadline. It reads live network settings and available models, chooses the best guardian model and reasoning effort, builds a restricted review-session configuration, runs the guardian review session, and converts the session outcome into either a parsed GuardianAssessment or a GuardianReviewError. The output also includes analytics details gathered by the review session.

**Call relations**: run_guardian_review_session_with_retry calls this for each attempt. This function delegates prompt/config creation to build_guardian_review_session_config and output interpretation to parse_guardian_assessment.

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

**Purpose**: Repeats guardian review attempts when retrying is safe and useful. It stops when a review succeeds, a non-retryable failure happens, the maximum attempt count is reached, the deadline expires, or cancellation happens.

**Data flow**: It receives the session, turn, request, retry reason, schema, optional cancellation token, and maximum attempt count. It sets one overall deadline, runs an attempt, records the attempt count in analytics, checks whether that outcome should be retried, waits with backoff if needed, and loops. The output is the final review outcome plus analytics from the last attempt.

**Call relations**: run_guardian_review calls this to get a dependable final guardian result. It relies on run_guardian_review_session_before_deadline for each attempt, should_retry_guardian_review for the retry decision, and wait_before_guardian_retry for the pause between attempts.

*Call graph*: calls 3 internal fn (run_guardian_review_session_before_deadline, should_retry_guardian_review, wait_before_guardian_retry); called by 1 (run_guardian_review); 6 external calls (clone, now, clone, assert!, clone, Error).


##### `wait_before_guardian_retry`  (lines 880–899)

```
async fn wait_before_guardian_retry(
    attempt_count: i64,
    deadline: Instant,
    external_cancel: Option<&CancellationToken>,
) -> Option<GuardianReviewError>
```

**Purpose**: Waits before trying the guardian again, while still respecting the overall deadline and cancellation. The delay uses backoff, meaning later retries wait longer than earlier ones.

**Data flow**: It receives the current attempt count, deadline, and optional cancellation token. It computes the next retry time, then waits until either that time arrives or cancellation is requested. It returns no error if retry can continue, Timeout if the deadline has passed, or Cancelled if cancellation happened.

**Call relations**: run_guardian_review_session_with_retry calls this between retryable attempts. The tests call it directly to confirm that cancellation and deadlines are honored.

*Call graph*: calls 1 internal fn (backoff); called by 3 (guardian_review_retry_wait_honors_cancellation, guardian_review_retry_wait_honors_deadline, run_guardian_review_session_with_retry); 2 external calls (now, select!).


##### `should_retry_guardian_review`  (lines 901–917)

```
fn should_retry_guardian_review(outcome: &GuardianReviewOutcome) -> bool
```

**Purpose**: Decides whether a failed guardian review should be attempted again. It only retries parsing problems and specific session failures that look temporary, such as server overload or broken connections.

**Data flow**: It receives a guardian review outcome. It inspects the outcome and, for session errors, any structured error info. The output is true if another attempt is allowed, otherwise false.

**Call relations**: run_guardian_review_session_with_retry calls this after each attempt. The retry-focused test checks that it says yes only for the intended temporary failures and parse errors.

*Call graph*: called by 1 (run_guardian_review_session_with_retry); 1 external calls (matches!).


##### `review_tests::guardian_review_error_reason_distinguishes_error_kinds`  (lines 925–951)

```
fn guardian_review_error_reason_distinguishes_error_kinds()
```

**Purpose**: Tests that each internal guardian error kind maps to the correct analytics failure reason. This protects reporting from accidentally grouping distinct failures together.

**Data flow**: It creates prompt-build, session, structured-session, and parse errors. It calls failure_reason on each and checks the returned category. The output is a passing or failing test result.

**Call relations**: This test exercises the GuardianReviewError constructor helpers and GuardianReviewError::failure_reason without running a real guardian session.

*Call graph*: calls 4 internal fn (parse, prompt_build, session, session_with_error_info); 2 external calls (anyhow!, assert!).


##### `review_tests::guardian_review_retry_only_retries_transient_session_and_parse_errors`  (lines 954–1024)

```
fn guardian_review_retry_only_retries_transient_session_and_parse_errors()
```

**Purpose**: Tests the retry policy for guardian reviews. It confirms that temporary service problems and parse errors are retried, while approvals, denials, bad requests, prompt failures, timeouts, and cancellations are not.

**Data flow**: It builds a list of sample outcomes paired with the expected retry answer. For each one, it calls should_retry_guardian_review and compares the result to the expectation. The output is a passing or failing test result.

**Call relations**: This test directly protects should_retry_guardian_review, which is used by run_guardian_review_session_with_retry in production.

*Call graph*: calls 4 internal fn (parse, prompt_build, session, session_with_error_info); 4 external calls (anyhow!, assert_eq!, Completed, Error).


##### `review_tests::guardian_review_retry_wait_honors_cancellation`  (lines 1027–1039)

```
async fn guardian_review_retry_wait_honors_cancellation()
```

**Purpose**: Tests that the retry wait stops immediately when cancellation has already been requested. This matters so cancelled work does not sleep unnecessarily.

**Data flow**: It creates a cancellation token, cancels it, then calls wait_before_guardian_retry with a future deadline. It checks that the returned error is Cancelled. The output is a passing or failing async test result.

**Call relations**: This test covers the cancellation branch of wait_before_guardian_retry, the helper used between retry attempts.

*Call graph*: calls 1 internal fn (wait_before_guardian_retry); 4 external calls (new, from_secs, now, assert!).


##### `review_tests::guardian_review_retry_wait_honors_deadline`  (lines 1042–1051)

```
async fn guardian_review_retry_wait_honors_deadline()
```

**Purpose**: Tests that the retry wait reports a timeout when the deadline has already arrived. This keeps retry logic from running past the review’s allowed time.

**Data flow**: It calls wait_before_guardian_retry with the deadline set to now and no cancellation token. It checks that the returned error is Timeout. The output is a passing or failing async test result.

**Call relations**: This test covers the deadline branch of wait_before_guardian_retry, which run_guardian_review_session_with_retry depends on to enforce the overall timeout.

*Call graph*: calls 1 internal fn (wait_before_guardian_retry); 2 external calls (now, assert!).
