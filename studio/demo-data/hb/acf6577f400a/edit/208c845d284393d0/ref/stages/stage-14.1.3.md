# Hook execution and stop-continue mediation  `stage-14.1.3`

This stage is the system’s hook runner: the part that lets outside commands watch key moments and influence what happens next. A hook is a small extra program that can inspect an event and reply with “go on,” “stop,” “block this,” or “add this extra context.” This sits in the main work loop, between normal actions like starting a session, sending a prompt, using a tool, asking permission, compacting history, and stopping.

At the top, the registry and engine build the hook system from configuration and expose simple “preview” and “run” entry points. Discovery finds which hooks exist, whether they are enabled, and whether they are trusted. The dispatcher then picks the hooks that match a specific event and runs them, while the command runner actually launches the child processes and captures their output. The output parser turns that output into structured decisions, and output spilling saves oversized output to temp files while keeping only a smaller visible summary.

The event files contain the special rules for each moment in the lifecycle. The runtime adapter connects all of this to sessions and turns, emits events and metrics, and passes any hook-produced context back into the conversation. Legacy notify support keeps older hook commands working too.

## Files in this stage

### Registry and runtime entrypoints
These files expose the public hook APIs and connect session-level runtime flows to the hook engine and legacy notification path.

### `hooks/src/registry.rs`

`orchestration` · `startup construction and event dispatch entrypoints`

This file is the main façade over the hooks subsystem. `HooksConfig` gathers all startup inputs: optional legacy notify argv, feature flags, trust bypass, config-layer stack, plugin hook sources and warnings, and shell program/args for command execution. `HookListOutcome` is a simple container for discovered hook entries plus warnings. `Hooks` itself stores two execution mechanisms: `after_agent`, a list of legacy `Hook` closures, and `engine`, a `ClaudeHooksEngine` that handles the newer structured hook events.

`Hooks::new` wires these pieces together. If `legacy_notify_argv` is present and its first element is non-empty, it creates a single legacy notify hook via `crate::notify_hook`; otherwise the legacy list is empty. It then constructs `ClaudeHooksEngine::new(...)`, forwarding feature flags, trust settings, optional config stack, plugin sources/warnings, and a `CommandShell` built from the configured shell program and args. `dispatch` is only for legacy `HookEvent` values: it selects hooks with `hooks_for_event`, executes them sequentially, records each `HookResponse`, and stops early if a hook result says the surrounding operation should abort.

All other methods are thin pass-throughs to the engine for previewing or running specific event types such as session start, tool use, compaction, user prompt submit, and stop. `list_hooks` performs discovery without constructing a full `Hooks` instance, returning an empty result when the feature is disabled. `command_from_argv` is a small but important helper that rejects empty argv or empty program names before constructing a `tokio::process::Command` and attaching the remaining args.

#### Function details

##### `Hooks::default`  (lines 54–56)

```
fn default() -> Self
```

**Purpose**: Builds a `Hooks` instance using the default configuration.

**Data flow**: Calls `HooksConfig::default()` and passes it to `Self::new`, returning the constructed registry.

**Call relations**: Provides the standard default constructor and delegates all real setup work to `Hooks::new`.

*Call graph*: 2 external calls (new, default).


##### `Hooks::new`  (lines 60–82)

```
fn new(config: HooksConfig) -> Self
```

**Purpose**: Constructs the hooks registry from configuration, wiring legacy notify hooks and the structured Claude hooks engine.

**Data flow**: Consumes `HooksConfig`. It filters `legacy_notify_argv` to ensure the argv vector exists, is non-empty, and has a non-empty program element; if valid, it maps it through `crate::notify_hook` and collects the single resulting hook into `after_agent`. It then constructs `ClaudeHooksEngine::new(...)` with feature flags, trust bypass, optional config stack reference, plugin sources/warnings, and a `CommandShell` built from `shell_program.unwrap_or_default()` and `shell_args`. Returns `Hooks { after_agent, engine }`.

**Call relations**: Called by `Hooks::default` and by external setup code that needs a configured registry. It is the central wiring point for both legacy and modern hook execution paths.

*Call graph*: calls 1 internal fn (new); called by 6 (install_mcp_permission_request_hook, build_hooks_for_config, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, preview_session_start_hooks, execve_permission_request_hook_short_circuits_prompt).


##### `Hooks::startup_warnings`  (lines 84–86)

```
fn startup_warnings(&self) -> &[String]
```

**Purpose**: Exposes any warnings collected by the structured hook engine during initialization.

**Data flow**: Borrows `self`, calls `self.engine.warnings()`, and returns the borrowed slice of warning strings.

**Call relations**: Used by callers after construction to surface discovery or loading issues without rerunning initialization.

*Call graph*: calls 1 internal fn (warnings).


##### `Hooks::hooks_for_event`  (lines 88–92)

```
fn hooks_for_event(&self, hook_event: &HookEvent) -> &[Hook]
```

**Purpose**: Selects the legacy hook list associated with a given legacy `HookEvent`.

**Data flow**: Matches on a borrowed `HookEvent` and currently returns `&self.after_agent` for `HookEvent::AfterAgent { .. }`.

**Call relations**: Called only by `dispatch` to determine which legacy hooks should run for a payload.

*Call graph*: called by 1 (dispatch).


##### `Hooks::dispatch`  (lines 94–107)

```
async fn dispatch(&self, hook_payload: HookPayload) -> Vec<HookResponse>
```

**Purpose**: Runs legacy hooks sequentially for a `HookPayload`, stopping early if one requests abort semantics.

**Data flow**: Consumes an owned `HookPayload`, looks up the relevant hook slice with `hooks_for_event(&hook_payload.hook_event)`, preallocates an outcomes vector, then iterates hooks in order. For each hook it awaits `hook.execute(&hook_payload)`, checks `outcome.result.should_abort_operation()`, pushes the `HookResponse`, and breaks the loop if abort was requested. Returns the collected responses.

**Call relations**: This is the runtime entrypoint for the legacy `Hook` mechanism; it relies on `hooks_for_event` for routing and on each hook's `execute` implementation for actual work.

*Call graph*: calls 1 internal fn (hooks_for_event); 1 external calls (with_capacity).


##### `Hooks::preview_session_start`  (lines 109–114)

```
fn preview_session_start(
        &self,
        request: &SessionStartRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Delegates session-start previewing to the structured hook engine.

**Data flow**: Borrows `self` and a `SessionStartRequest`, forwards the request to `self.engine.preview_session_start(request)`, and returns the resulting summaries.

**Call relations**: Thin façade method exposing engine functionality through the public registry API.

*Call graph*: calls 1 internal fn (preview_session_start).


##### `Hooks::preview_pre_tool_use`  (lines 116–121)

```
fn preview_pre_tool_use(
        &self,
        request: &PreToolUseRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Delegates pre-tool-use previewing to the structured hook engine.

**Data flow**: Borrows `self` and a `PreToolUseRequest`, forwards it to `self.engine.preview_pre_tool_use`, and returns the summaries.

**Call relations**: Part of the registry's pass-through preview API.

*Call graph*: calls 1 internal fn (preview_pre_tool_use).


##### `Hooks::preview_permission_request`  (lines 123–128)

```
fn preview_permission_request(
        &self,
        request: &PermissionRequestRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Delegates permission-request previewing to the structured hook engine.

**Data flow**: Borrows `self` and a `PermissionRequestRequest`, forwards it to `self.engine.preview_permission_request`, and returns the summaries.

**Call relations**: Public wrapper around the engine's permission-request preview path.

*Call graph*: calls 1 internal fn (preview_permission_request).


##### `Hooks::preview_post_tool_use`  (lines 130–135)

```
fn preview_post_tool_use(
        &self,
        request: &PostToolUseRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Delegates post-tool-use previewing to the structured hook engine.

**Data flow**: Borrows `self` and a `PostToolUseRequest`, forwards it to `self.engine.preview_post_tool_use`, and returns the summaries.

**Call relations**: Another thin preview wrapper in the registry API.

*Call graph*: calls 1 internal fn (preview_post_tool_use).


##### `Hooks::run_session_start`  (lines 137–143)

```
async fn run_session_start(
        &self,
        request: SessionStartRequest,
        turn_id: Option<String>,
    ) -> SessionStartOutcome
```

**Purpose**: Delegates execution of session-start hooks to the structured hook engine.

**Data flow**: Consumes an owned `SessionStartRequest` plus optional `turn_id`, awaits `self.engine.run_session_start(request, turn_id)`, and returns the resulting `SessionStartOutcome`.

**Call relations**: Public runtime entrypoint for session-start hook execution.

*Call graph*: calls 1 internal fn (run_session_start).


##### `Hooks::run_pre_tool_use`  (lines 145–147)

```
async fn run_pre_tool_use(&self, request: PreToolUseRequest) -> PreToolUseOutcome
```

**Purpose**: Delegates execution of pre-tool-use hooks to the structured hook engine.

**Data flow**: Consumes a `PreToolUseRequest`, awaits `self.engine.run_pre_tool_use(request)`, and returns `PreToolUseOutcome`.

**Call relations**: Pass-through runtime wrapper.

*Call graph*: calls 1 internal fn (run_pre_tool_use).


##### `Hooks::run_permission_request`  (lines 149–154)

```
async fn run_permission_request(
        &self,
        request: PermissionRequestRequest,
    ) -> PermissionRequestOutcome
```

**Purpose**: Delegates execution of permission-request hooks to the structured hook engine.

**Data flow**: Consumes a `PermissionRequestRequest`, awaits `self.engine.run_permission_request(request)`, and returns `PermissionRequestOutcome`.

**Call relations**: Pass-through runtime wrapper.

*Call graph*: calls 1 internal fn (run_permission_request).


##### `Hooks::run_post_tool_use`  (lines 156–158)

```
async fn run_post_tool_use(&self, request: PostToolUseRequest) -> PostToolUseOutcome
```

**Purpose**: Delegates execution of post-tool-use hooks to the structured hook engine.

**Data flow**: Consumes a `PostToolUseRequest`, awaits `self.engine.run_post_tool_use(request)`, and returns `PostToolUseOutcome`.

**Call relations**: Pass-through runtime wrapper.

*Call graph*: calls 1 internal fn (run_post_tool_use).


##### `Hooks::preview_pre_compact`  (lines 160–165)

```
fn preview_pre_compact(
        &self,
        request: &PreCompactRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Delegates pre-compaction previewing to the structured hook engine.

**Data flow**: Borrows `self` and a `PreCompactRequest`, forwards it to `self.engine.preview_pre_compact`, and returns the summaries.

**Call relations**: Public preview wrapper for compaction hooks.

*Call graph*: calls 1 internal fn (preview_pre_compact).


##### `Hooks::run_pre_compact`  (lines 167–169)

```
async fn run_pre_compact(&self, request: PreCompactRequest) -> PreCompactOutcome
```

**Purpose**: Delegates execution of pre-compaction hooks to the structured hook engine.

**Data flow**: Consumes a `PreCompactRequest`, awaits `self.engine.run_pre_compact(request)`, and returns `PreCompactOutcome`.

**Call relations**: Public runtime wrapper for pre-compaction hooks.

*Call graph*: calls 1 internal fn (run_pre_compact).


##### `Hooks::preview_post_compact`  (lines 171–176)

```
fn preview_post_compact(
        &self,
        request: &PostCompactRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Delegates post-compaction previewing to the structured hook engine.

**Data flow**: Borrows `self` and a `PostCompactRequest`, forwards it to `self.engine.preview_post_compact`, and returns the summaries.

**Call relations**: Public preview wrapper for post-compaction hooks.

*Call graph*: calls 1 internal fn (preview_post_compact).


##### `Hooks::run_post_compact`  (lines 178–180)

```
async fn run_post_compact(&self, request: PostCompactRequest) -> StatelessHookOutcome
```

**Purpose**: Delegates execution of post-compaction hooks to the structured hook engine.

**Data flow**: Consumes a `PostCompactRequest`, awaits `self.engine.run_post_compact(request)`, and returns `StatelessHookOutcome`.

**Call relations**: Public runtime wrapper for post-compaction hooks.

*Call graph*: calls 1 internal fn (run_post_compact).


##### `Hooks::preview_user_prompt_submit`  (lines 182–187)

```
fn preview_user_prompt_submit(
        &self,
        request: &UserPromptSubmitRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Delegates user-prompt-submit previewing to the structured hook engine.

**Data flow**: Borrows `self` and a `UserPromptSubmitRequest`, forwards it to `self.engine.preview_user_prompt_submit`, and returns the summaries.

**Call relations**: Public preview wrapper for prompt-submit hooks.

*Call graph*: calls 1 internal fn (preview_user_prompt_submit).


##### `Hooks::run_user_prompt_submit`  (lines 189–194)

```
async fn run_user_prompt_submit(
        &self,
        request: UserPromptSubmitRequest,
    ) -> UserPromptSubmitOutcome
```

**Purpose**: Delegates execution of user-prompt-submit hooks to the structured hook engine.

**Data flow**: Consumes a `UserPromptSubmitRequest`, awaits `self.engine.run_user_prompt_submit(request)`, and returns `UserPromptSubmitOutcome`.

**Call relations**: Public runtime wrapper for prompt-submit hooks.

*Call graph*: calls 1 internal fn (run_user_prompt_submit).


##### `Hooks::preview_stop`  (lines 196–201)

```
fn preview_stop(
        &self,
        request: &StopRequest,
    ) -> Vec<codex_protocol::protocol::HookRunSummary>
```

**Purpose**: Delegates stop-hook previewing to the structured hook engine.

**Data flow**: Borrows `self` and a `StopRequest`, forwards it to `self.engine.preview_stop`, and returns the summaries.

**Call relations**: Public preview wrapper for stop hooks.

*Call graph*: calls 1 internal fn (preview_stop).


##### `Hooks::run_stop`  (lines 203–205)

```
async fn run_stop(&self, request: StopRequest) -> StopOutcome
```

**Purpose**: Delegates execution of stop hooks to the structured hook engine.

**Data flow**: Consumes a `StopRequest`, awaits `self.engine.run_stop(request)`, and returns `StopOutcome`.

**Call relations**: Public runtime wrapper for stop hooks.

*Call graph*: calls 1 internal fn (run_stop).


##### `list_hooks`  (lines 208–223)

```
fn list_hooks(config: HooksConfig) -> HookListOutcome
```

**Purpose**: Discovers configured structured hook handlers and returns their list plus warnings, without constructing a full `Hooks` registry.

**Data flow**: Consumes `HooksConfig`. If `feature_enabled` is false, it returns `HookListOutcome::default()`. Otherwise it calls `crate::engine::discovery::discover_handlers` with the optional config stack reference, plugin sources, plugin load warnings, and trust-bypass flag, then returns `HookListOutcome { hooks: discovered.hook_entries, warnings: discovered.warnings }`.

**Call relations**: Used by callers that need inspection/listing of configured hooks rather than runtime execution.

*Call graph*: calls 1 internal fn (discover_handlers); 1 external calls (default).


##### `command_from_argv`  (lines 225–233)

```
fn command_from_argv(argv: &[String]) -> Option<Command>
```

**Purpose**: Safely converts an argv slice into a `tokio::process::Command`, rejecting missing or empty program names.

**Data flow**: Accepts `&[String]`, uses `split_first()` to separate program and args, returns `None` if the slice is empty or the program string is empty, otherwise constructs `Command::new(program)`, appends `args`, and returns `Some(command)`.

**Call relations**: Used by the legacy notify path to turn configured argv into a spawnable command while treating empty configuration as disabled.

*Call graph*: 1 external calls (new).


### `core/src/hook_runtime.rs`

`orchestration` · `cross-cutting during turn execution, tool execution, and compaction`

This file is the execution layer for user/system/project hooks. For each hook family—session start, user prompt submit, pre/post tool use, permission request, stop, pre/post compact, and the legacy after-agent hook—it builds the corresponding request object from `Session` and `TurnContext`, previews matching runs to emit `HookStarted` events, executes the hook(s), emits `HookCompleted` events, records metrics and analytics, and persists any additional context fragments as separate developer messages. The helper `run_context_injecting_hook` abstracts the common preview/run/completed flow for hook types that can inject additional context and request turn stoppage.

The runtime also adapts session topology into hook-visible targets. Thread-spawn subagents get `SubagentStart`/`SubagentStop` targets and a `SubagentHookContext` containing agent ID/type; internal non-thread-spawn subagents skip lifecycle hooks entirely. Permission mode is normalized from approval policy into the hook contract’s `bypassPermissions` vs `default` strings. Pre-tool hooks can either continue with optional updated JSON input or block execution with a synthesized message that includes the command for Bash/apply_patch calls. Completed hook runs are tagged into metrics by hook name, source, and status, and are also converted into `HookRunFact` analytics using the completed turn ID when present. Additional contexts are intentionally recorded as separate developer messages to preserve ordering and avoid concatenation ambiguity.

#### Function details

##### `ContextInjectingHookOutcome::from`  (lines 85–99)

```
fn from(value: UserPromptSubmitOutcome) -> Self
```

**Purpose**: Converts a `SessionStartOutcome` into the internal normalized hook outcome shape used by the runtime.

**Data flow**: Consumes `SessionStartOutcome`, extracts `hook_events`, `should_stop`, and `additional_contexts`, discards `stop_reason`, and returns `ContextInjectingHookOutcome { hook_events, outcome: HookRuntimeOutcome { should_stop, additional_contexts } }`.

**Call relations**: Used implicitly by `run_context_injecting_hook` when running session-start hooks.


##### `run_pending_session_start_hooks`  (lines 103–156)

```
async fn run_pending_session_start_hooks(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
) -> bool
```

**Purpose**: Drains and runs any queued session-start hooks for the session, including thread-spawn subagent starts, and records any additional context they inject. It returns whether any hook requested that execution stop.

**Data flow**: Loops while `sess.take_pending_session_start_source().await` yields a source. For each source it derives a `StartHookTarget`: thread-spawn subagents become `SubagentStart` with agent metadata from `subagent_hook_context`, ordinary root sessions become `SessionStart`, and other subagents short-circuit to `false`. It builds a `SessionStartRequest` from session ID, cwd, transcript path, model, permission mode, and target; previews matching hooks; runs them through `run_context_injecting_hook`; then calls `HookRuntimeOutcome::record_additional_contexts`. If any run requests stop, it returns `true`; otherwise it returns `false` after the queue is empty.

**Call relations**: Called from the main turn runner before normal turn processing. It delegates common hook execution to `run_context_injecting_hook` and target derivation to `subagent_hook_context` and `hook_permission_mode`.

*Call graph*: calls 3 internal fn (hook_permission_mode, run_context_injecting_hook, subagent_hook_context); called by 1 (run_turn); 1 external calls (matches!).


##### `run_pre_tool_use_hooks`  (lines 163–220)

```
async fn run_pre_tool_use_hooks(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    tool_use_id: String,
    tool_name: &HookToolName,
    tool_input: &Value,
) -> PreToolUseHookResult
```

**Purpose**: Runs `PreToolUse` hooks before a tool executes, emits hook events, records additional contexts, and returns either a possibly updated tool input or a blocking reason.

**Data flow**: Builds a `PreToolUseRequest` from session/turn IDs, optional thread-spawn subagent context, cwd, transcript path, model, permission mode, canonical tool name, matcher aliases, tool-use ID, and cloned tool input JSON. It previews hooks and emits started events, awaits `hooks.run_pre_tool_use(request)`, emits completed events, records any additional contexts, and then returns `PreToolUseHookResult::Continue { updated_input }` when `should_block` is false or no block reason is provided. If blocked with a reason, it formats either a command-specific message for Bash/apply_patch using `tool_input["command"]` or a generic tool-blocked message.

**Call relations**: Called by tool-dispatch code before executing a tool. It uses `emit_hook_started_events`, `emit_hook_completed_events`, `record_additional_contexts`, `thread_spawn_subagent_hook_context`, and `hook_permission_mode` to integrate hook execution into the turn runtime.

*Call graph*: calls 7 internal fn (emit_hook_completed_events, emit_hook_started_events, hook_permission_mode, record_additional_contexts, thread_spawn_subagent_hook_context, matcher_aliases, name); called by 1 (dispatch_any_with_terminal_outcome); 4 external calls (clone, get, Blocked, format!).


##### `run_permission_request_hooks`  (lines 225–256)

```
async fn run_permission_request_hooks(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    run_id_suffix: &str,
    payload: PermissionRequestPayload,
) -> Option<PermissionRequestDecisi
```

**Purpose**: Runs `PermissionRequest` hooks around an approval request and returns any hook-supplied decision.

**Data flow**: Builds a `PermissionRequestRequest` from session/turn IDs, optional subagent context, cwd, transcript path, model, permission mode, tool name and matcher aliases from the payload, run ID suffix, and tool input. It previews hooks and emits started events, awaits `hooks.run_permission_request(request)`, emits completed events, and returns the optional `decision` from the outcome.

**Call relations**: Called by approval-request paths such as MCP tool approval and inline policy requests. It shares the same preview/start/completed event flow as other hook families.

*Call graph*: calls 4 internal fn (emit_hook_completed_events, emit_hook_started_events, hook_permission_mode, thread_spawn_subagent_hook_context); called by 4 (maybe_request_mcp_tool_approval, handle_inline_policy_request, request_approval, prompt).


##### `run_post_tool_use_hooks`  (lines 264–295)

```
async fn run_post_tool_use_hooks(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    tool_use_id: String,
    tool_name: String,
    matcher_aliases: Vec<String>,
    tool_input: Value,
```

**Purpose**: Runs `PostToolUse` hooks after a successful tool execution using the stable hook contract values rather than raw internal tool data.

**Data flow**: Builds a `PostToolUseRequest` from session/turn IDs, optional subagent context, cwd, transcript path, model, permission mode, tool name, matcher aliases, tool-use ID, tool input JSON, and tool response JSON. It previews hooks and emits started events, awaits `hooks.run_post_tool_use(request)`, emits completed events using a clone of `outcome.hook_events`, and returns the full `PostToolUseOutcome`.

**Call relations**: Called by tool-dispatch code after a tool succeeds. It mirrors the pre-tool flow but returns the hook library’s full post-tool outcome.

*Call graph*: calls 4 internal fn (emit_hook_completed_events, emit_hook_started_events, hook_permission_mode, thread_spawn_subagent_hook_context); called by 1 (dispatch_any_with_terminal_outcome).


##### `run_turn_stop_hooks`  (lines 298–366)

```
async fn run_turn_stop_hooks(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    stop_hook_active: bool,
    last_assistant_message: Option<String>,
) -> StopOutcome
```

**Purpose**: Runs stop hooks at the end of a turn, adapting root turns to `Stop` and thread-spawn child turns to `SubagentStop`. Internal non-thread-spawn subagents skip stop hooks entirely.

**Data flow**: Examines `turn_context.session_source`. For thread-spawn subagents it builds `StopHookTarget::SubagentStop` with agent metadata and resolves the parent transcript path from `thread_store`; for other subagents it returns `StopOutcome::default()` immediately; for root turns it uses `StopHookTarget::Stop` and the current session transcript path. It then builds a `StopRequest` with session/turn IDs, cwd, transcript path, model, permission mode, `stop_hook_active`, optional last assistant message, and target; previews hooks and emits started events; runs `hooks.run_stop(request)`; emits completed events while taking ownership of `outcome.hook_events`; and returns the mutated `StopOutcome`.

**Call relations**: Called by the main turn runner during turn teardown. It uses `subagent_hook_context`, `hook_permission_mode`, and the common event emitters.

*Call graph*: calls 4 internal fn (emit_hook_completed_events, emit_hook_started_events, hook_permission_mode, subagent_hook_context); called by 1 (run_turn); 3 external calls (default, take, warn!).


##### `run_pre_compact_hooks`  (lines 368–393)

```
async fn run_pre_compact_hooks(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    trigger: CompactionTrigger,
) -> PreCompactHookOutcome
```

**Purpose**: Runs `PreCompact` hooks before compaction and converts the hook outcome into a simple continue/stopped enum.

**Data flow**: Builds a `PreCompactRequest` from session/turn IDs, optional subagent context, cwd, transcript path, model, and stringified compaction trigger. It previews hooks and emits started events, awaits `sess.hooks().run_pre_compact(request)`, emits completed events, and returns `PreCompactHookOutcome::Stopped` when `outcome.should_stop` is true or `Continue` otherwise.

**Call relations**: Called by local and remote compaction tasks before compaction begins.

*Call graph*: calls 4 internal fn (compaction_trigger_label, emit_hook_completed_events, emit_hook_started_events, thread_spawn_subagent_hook_context); called by 3 (run_compact_task_inner, run_remote_compact_task_inner, run_remote_compact_task_inner).


##### `run_post_compact_hooks`  (lines 405–430)

```
async fn run_post_compact_hooks(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    trigger: CompactionTrigger,
) -> PostCompactHookOutcome
```

**Purpose**: Runs `PostCompact` hooks after compaction and converts the hook outcome into a simple continue/stopped enum.

**Data flow**: Builds a `PostCompactRequest` from session/turn IDs, optional subagent context, cwd, transcript path, model, and stringified compaction trigger. It previews hooks and emits started events, awaits `sess.hooks().run_post_compact(request)`, emits completed events, and returns `PostCompactHookOutcome::Stopped` when `outcome.should_stop` is true or `Continue` otherwise.

**Call relations**: Called by local and remote compaction tasks after compaction completes.

*Call graph*: calls 4 internal fn (compaction_trigger_label, emit_hook_completed_events, emit_hook_started_events, thread_spawn_subagent_hook_context); called by 3 (run_compact_task_inner, run_remote_compact_task_inner, run_remote_compact_task_inner).


##### `run_legacy_after_agent_hook`  (lines 433–498)

```
async fn run_legacy_after_agent_hook(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    input: &[ResponseItem],
    last_assistant_message: Option<String>,
) -> bool
```

**Purpose**: Runs the older `AfterAgent` hook API after agent completion, logging failures and optionally aborting turn completion if a hook requested abort.

**Data flow**: Parses the supplied `input` response items into user messages via `parse_turn_item`, builds a legacy `HookPayload` with session ID, cwd, client name, current UTC timestamp, thread ID, turn ID, input messages, and optional last assistant message, then awaits `hooks.dispatch(...)`. For each hook outcome it ignores successes, logs warnings for failures, and remembers the first aborting failure message. If no aborting failure occurred it returns `false`; otherwise it sends an `EventMsg::Error` with `CodexErrorInfo::Other` and returns `true`.

**Call relations**: Called by the main turn runner after agent completion for backward compatibility with legacy hooks. Unlike the newer hook families, it uses the older dispatch API directly.

*Call graph*: called by 1 (run_turn); 5 external calls (now, format!, iter, Error, warn!).


##### `inspect_pending_input`  (lines 500–537)

```
async fn inspect_pending_input(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    pending_input_item: &TurnInput,
) -> HookRuntimeOutcome
```

**Purpose**: Runs input-inspection hooks for pending turn input before the input is recorded, currently only for user prompts.

**Data flow**: Matches `pending_input_item`. For `TurnInput::UserInput`, it builds a `UserPromptSubmitRequest` from session/turn IDs, optional subagent context, cwd, transcript path, model, permission mode, and the user message text from `UserMessageItem::new(content).message()`, then runs it through `run_context_injecting_hook` and returns the resulting `HookRuntimeOutcome`. For `ResponseItem` and `InterAgentCommunication`, it returns `HookRuntimeOutcome { should_stop: false, additional_contexts: Vec::new() }`.

**Call relations**: Called before recording pending input in turn-processing paths. It delegates common hook execution to `run_context_injecting_hook`.

*Call graph*: calls 4 internal fn (hook_permission_mode, run_context_injecting_hook, thread_spawn_subagent_hook_context, new); called by 2 (run_hooks_and_record_inputs, on_task_finished); 1 external calls (new).


##### `record_pending_input`  (lines 539–564)

```
async fn record_pending_input(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    pending_input: TurnInput,
    additional_contexts: Vec<String>,
)
```

**Purpose**: Persists a pending input item into session history and then records any additional contexts produced by hooks.

**Data flow**: Matches the owned `TurnInput`: user input is recorded via `record_user_prompt_and_emit_turn_item`, a response item via `record_conversation_items`, and inter-agent communication via `record_inter_agent_communication`. After recording the primary input, it calls `record_additional_contexts` with the supplied extra context strings. It returns nothing.

**Call relations**: Called after hook inspection succeeds so the original input and any hook-injected context are both persisted in order.

*Call graph*: calls 1 internal fn (record_additional_contexts); called by 2 (run_hooks_and_record_inputs, on_task_finished); 1 external calls (from_ref).


##### `run_context_injecting_hook`  (lines 566–581)

```
async fn run_context_injecting_hook(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    preview_runs: Vec<HookRunSummary>,
    outcome_future: Fut,
) -> HookRuntimeOutcome
```

**Purpose**: Shared helper for hook families that can inject additional context and request turn stoppage. It centralizes the preview/start/completed event flow.

**Data flow**: Accepts session and turn references, preview hook summaries, and a future producing some `Outcome: Into<ContextInjectingHookOutcome>`. It emits started events for the previews, awaits the future, converts the result into `ContextInjectingHookOutcome`, emits completed events for its `hook_events`, and returns the normalized `HookRuntimeOutcome`.

**Call relations**: Used by `run_pending_session_start_hooks` and `inspect_pending_input` to avoid duplicating the common hook execution pattern.

*Call graph*: calls 2 internal fn (emit_hook_completed_events, emit_hook_started_events); called by 2 (inspect_pending_input, run_pending_session_start_hooks).


##### `HookRuntimeOutcome::record_additional_contexts`  (lines 584–592)

```
async fn record_additional_contexts(
        self,
        sess: &Arc<Session>,
        turn_context: &Arc<TurnContext>,
    ) -> bool
```

**Purpose**: Persists any additional contexts carried by a hook outcome and returns whether the hook requested stop.

**Data flow**: Consumes `self`, calls `record_additional_contexts(sess, turn_context, self.additional_contexts).await`, and returns `self.should_stop`.

**Call relations**: Used by `run_pending_session_start_hooks` after `run_context_injecting_hook` so stop decisions and context persistence are handled together.

*Call graph*: calls 1 internal fn (record_additional_contexts).


##### `record_additional_contexts`  (lines 595–607)

```
async fn record_additional_contexts(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    additional_contexts: Vec<String>,
)
```

**Purpose**: Converts hook-supplied additional context strings into developer messages and records them in conversation history.

**Data flow**: Takes owned `additional_contexts`, converts them with `additional_context_messages`, returns early if the resulting vector is empty, otherwise records them via `sess.record_conversation_items(turn_context, ...)`. It returns nothing.

**Call relations**: Called from multiple hook execution and input-recording paths whenever hooks inject extra context into the conversation.

*Call graph*: calls 1 internal fn (additional_context_messages); called by 6 (record_additional_contexts, record_pending_input, run_pre_tool_use_hooks, run_hooks_and_record_inputs, on_task_finished, dispatch_any_with_terminal_outcome).


##### `additional_context_messages`  (lines 609–615)

```
fn additional_context_messages(additional_contexts: Vec<String>) -> Vec<ResponseItem>
```

**Purpose**: Wraps each additional context string as a separate contextual developer message.

**Data flow**: Consumes a vector of strings, maps each through `HookAdditionalContext::new`, converts each to a `ResponseItem` via `ContextualUserFragment::into`, collects them into a vector, and returns it.

**Call relations**: Used by `record_additional_contexts` and directly tested to ensure contexts remain separate and ordered.

*Call graph*: called by 2 (record_additional_contexts, additional_context_messages_stay_separate_and_ordered).


##### `emit_hook_started_events`  (lines 617–632)

```
async fn emit_hook_started_events(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    preview_runs: Vec<HookRunSummary>,
)
```

**Purpose**: Emits `HookStarted` events for each previewed hook run.

**Data flow**: Iterates over `preview_runs`, wraps each `HookRunSummary` in `EventMsg::HookStarted(HookStartedEvent { turn_id: Some(turn_context.sub_id.clone()), run })`, sends it through `sess.send_event`, and returns nothing.

**Call relations**: Called before actual hook execution by all modern hook families and by `run_context_injecting_hook`.

*Call graph*: called by 7 (run_context_injecting_hook, run_permission_request_hooks, run_post_compact_hooks, run_post_tool_use_hooks, run_pre_compact_hooks, run_pre_tool_use_hooks, run_turn_stop_hooks); 1 external calls (HookStarted).


##### `emit_hook_completed_events`  (lines 634–645)

```
async fn emit_hook_completed_events(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    completed_events: Vec<HookCompletedEvent>,
)
```

**Purpose**: Processes completed hook events by recording metrics, analytics, and user-visible `HookCompleted` events.

**Data flow**: Iterates over `completed_events`, calls `emit_hook_completed_metrics(turn_context, &completed)`, `track_hook_completed_analytics(sess, turn_context, &completed)`, then sends `EventMsg::HookCompleted(completed)` through the session. It returns nothing.

**Call relations**: Called after hook execution by all modern hook families and by `run_context_injecting_hook`.

*Call graph*: calls 2 internal fn (emit_hook_completed_metrics, track_hook_completed_analytics); called by 7 (run_context_injecting_hook, run_permission_request_hooks, run_post_compact_hooks, run_post_tool_use_hooks, run_pre_compact_hooks, run_pre_tool_use_hooks, run_turn_stop_hooks); 1 external calls (HookCompleted).


##### `emit_hook_completed_metrics`  (lines 647–661)

```
fn emit_hook_completed_metrics(turn_context: &TurnContext, completed: &HookCompletedEvent)
```

**Purpose**: Records per-hook-run count and optional duration metrics tagged by hook name, source, and status.

**Data flow**: Builds tags with `hook_run_metric_tags(&completed.run)`, increments `HOOK_RUN_METRIC` on `turn_context.session_telemetry`, and if `completed.run.duration_ms` exists and converts to `u64`, records `HOOK_RUN_DURATION_METRIC` with `Duration::from_millis(duration_ms)`. It returns nothing.

**Call relations**: Called by `emit_hook_completed_events` for every completed hook run.

*Call graph*: calls 1 internal fn (hook_run_metric_tags); called by 1 (emit_hook_completed_events); 2 external calls (from_millis, try_from).


##### `track_hook_completed_analytics`  (lines 663–673)

```
fn track_hook_completed_analytics(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    completed: &HookCompletedEvent,
)
```

**Purpose**: Sends a completed hook run to the analytics events client.

**Data flow**: Builds `(tracking, hook)` via `hook_run_analytics_payload(sess.thread_id.to_string(), turn_context, completed)` and forwards them to `analytics_events_client.track_hook_run`. It returns nothing.

**Call relations**: Called by `emit_hook_completed_events` alongside metric emission.

*Call graph*: calls 1 internal fn (hook_run_analytics_payload); called by 1 (emit_hook_completed_events).


##### `hook_run_analytics_payload`  (lines 675–695)

```
fn hook_run_analytics_payload(
    thread_id: String,
    turn_context: &TurnContext,
    completed: &HookCompletedEvent,
) -> (codex_analytics::TrackEventsContext, HookRunFact)
```

**Purpose**: Builds the analytics tracking context and `HookRunFact` for a completed hook run.

**Data flow**: Reads the outer `thread_id`, `turn_context`, and `HookCompletedEvent`. It chooses the turn ID from `completed.turn_id` when present or falls back to `turn_context.sub_id`, builds a `TrackEventsContext` with `build_track_events_context`, and returns it paired with `HookRunFact { event_name, hook_source, status }` copied from `completed.run`.

**Call relations**: Used by `track_hook_completed_analytics` and directly tested for turn-ID selection behavior.

*Call graph*: called by 3 (hook_run_analytics_payload_falls_back_to_turn_context_id, hook_run_analytics_payload_uses_completed_turn_id, track_hook_completed_analytics); 1 external calls (build_track_events_context).


##### `hook_run_metric_tags`  (lines 697–736)

```
fn hook_run_metric_tags(run: &HookRunSummary) -> [(&'static str, &'static str); 3]
```

**Purpose**: Maps a `HookRunSummary` into the fixed metric tag triplet used for hook metrics.

**Data flow**: Matches `run.event_name`, `run.source`, and `run.status` into static strings and returns `[ ("hook_name", ...), ("source", ...), ("status", ...) ]`.

**Call relations**: Used by `emit_hook_completed_metrics` and tested to ensure metric tags align with analytics semantics.

*Call graph*: called by 1 (emit_hook_completed_metrics).


##### `hook_permission_mode`  (lines 738–747)

```
fn hook_permission_mode(turn_context: &TurnContext) -> String
```

**Purpose**: Normalizes the turn’s approval policy into the hook contract’s permission-mode string.

**Data flow**: Reads `turn_context.approval_policy.value()`, maps `AskForApproval::Never` to `bypassPermissions` and all other modes to `default`, converts the chosen literal to `String`, and returns it.

**Call relations**: Used when building requests for most hook families so hooks see a stable permission-mode vocabulary.

*Call graph*: called by 6 (inspect_pending_input, run_pending_session_start_hooks, run_permission_request_hooks, run_post_tool_use_hooks, run_pre_tool_use_hooks, run_turn_stop_hooks).


##### `thread_spawn_subagent_hook_context`  (lines 749–759)

```
fn thread_spawn_subagent_hook_context(
    sess: &Arc<Session>,
    turn_context: &TurnContext,
) -> Option<SubagentHookContext>
```

**Purpose**: Returns subagent hook context only for thread-spawn child sessions.

**Data flow**: Matches `turn_context.session_source`; for `SubAgentSource::ThreadSpawn` it delegates to `subagent_hook_context(sess, agent_role)` and wraps the result in `Some`, otherwise returns `None`.

**Call relations**: Used by tool, permission, compact, and input-inspection hook requests that optionally expose subagent metadata.

*Call graph*: calls 1 internal fn (subagent_hook_context); called by 6 (inspect_pending_input, run_permission_request_hooks, run_post_compact_hooks, run_post_tool_use_hooks, run_pre_compact_hooks, run_pre_tool_use_hooks).


##### `subagent_hook_context`  (lines 761–768)

```
fn subagent_hook_context(sess: &Arc<Session>, agent_role: &Option<String>) -> SubagentHookContext
```

**Purpose**: Builds the hook-visible subagent identity from the session thread ID and optional agent role.

**Data flow**: Reads `sess.thread_id()` and `agent_role`, returns `SubagentHookContext { agent_id: thread_id.to_string(), agent_type: agent_role.clone().unwrap_or_else(DEFAULT_ROLE_NAME) }`.

**Call relations**: Used by lifecycle hooks and by `thread_spawn_subagent_hook_context`.

*Call graph*: called by 3 (run_pending_session_start_hooks, run_turn_stop_hooks, thread_spawn_subagent_hook_context).


##### `compaction_trigger_label`  (lines 770–775)

```
fn compaction_trigger_label(value: CompactionTrigger) -> &'static str
```

**Purpose**: Maps compaction trigger enums to the string labels used in hook requests.

**Data flow**: Matches `CompactionTrigger::Manual` or `Auto` and returns `manual` or `auto`.

**Call relations**: Used by pre/post compact hook request builders.

*Call graph*: called by 2 (run_post_compact_hooks, run_pre_compact_hooks).


##### `tests::additional_context_messages_stay_separate_and_ordered`  (lines 798–829)

```
fn additional_context_messages_stay_separate_and_ordered()
```

**Purpose**: Verifies that additional hook contexts are recorded as separate developer messages in original order.

**Data flow**: Calls `additional_context_messages` with two strings, asserts the vector length is two, and inspects each `ResponseItem::Message` to assert developer role and exact text ordering.

**Call relations**: Tests the helper used by `record_additional_contexts`.

*Call graph*: calls 1 internal fn (additional_context_messages); 2 external calls (assert_eq!, vec!).


##### `tests::hook_run_analytics_payload_uses_completed_turn_id`  (lines 832–848)

```
async fn hook_run_analytics_payload_uses_completed_turn_id()
```

**Purpose**: Verifies that analytics payload generation prefers the completed event’s explicit turn ID over the current turn context ID.

**Data flow**: Builds a session/turn fixture and a `HookCompletedEvent` with `turn_id = Some(...)`, calls `hook_run_analytics_payload`, and asserts the returned tracking context and `HookRunFact` fields.

**Call relations**: Tests turn-ID selection in analytics payload generation.

*Call graph*: calls 2 internal fn (hook_run_analytics_payload, make_session_and_context); 2 external calls (assert_eq!, sample_hook_run).


##### `tests::hook_run_analytics_payload_falls_back_to_turn_context_id`  (lines 851–864)

```
async fn hook_run_analytics_payload_falls_back_to_turn_context_id()
```

**Purpose**: Verifies that analytics payload generation falls back to the turn context ID when the completed event lacks a turn ID.

**Data flow**: Builds a fixture and a `HookCompletedEvent` with `turn_id = None`, calls `hook_run_analytics_payload`, and asserts the fallback turn ID and copied hook source/status.

**Call relations**: Companion test for the analytics payload helper.

*Call graph*: calls 2 internal fn (hook_run_analytics_payload, make_session_and_context); 2 external calls (assert_eq!, sample_hook_run).


##### `tests::hook_run_metric_tags_match_analytics_shape`  (lines 867–890)

```
fn hook_run_metric_tags_match_analytics_shape()
```

**Purpose**: Verifies that hook metric tags encode the same hook name/source/status semantics used by analytics.

**Data flow**: Builds sample `HookRunSummary` values and asserts `hook_run_metric_tags` returns the expected tag arrays for project and cloud-requirements sources.

**Call relations**: Tests the metric-tag mapping helper.

*Call graph*: 2 external calls (assert_eq!, sample_hook_run).


##### `tests::hook_run_metric_tags_include_expanded_hook_sources`  (lines 893–904)

```
fn hook_run_metric_tags_include_expanded_hook_sources()
```

**Purpose**: Verifies that less common hook sources such as legacy managed-config MDM are mapped to the expected metric tag strings.

**Data flow**: Builds a sample run with `HookSource::LegacyManagedConfigMdm`, calls `hook_run_metric_tags`, and asserts the returned tags.

**Call relations**: Additional coverage for the metric-tag mapping helper.

*Call graph*: 2 external calls (assert_eq!, sample_hook_run).


##### `tests::sample_hook_run`  (lines 906–923)

```
fn sample_hook_run(status: HookRunStatus, source: HookSource) -> HookRunSummary
```

**Purpose**: Builds a representative `HookRunSummary` fixture for hook-runtime tests.

**Data flow**: Constructs and returns a `HookRunSummary` with fixed IDs, stop event name, command handler type, sync execution mode, turn scope, source path, supplied source/status, timestamps, duration, and empty entries.

**Call relations**: Shared fixture for analytics and metric-tag tests.

*Call graph*: 2 external calls (new, test_path_buf).


### `hooks/src/legacy_notify.rs`

`io_transport` · `after-agent notification dispatch`

This file exists solely for legacy compatibility with older notification hooks that expect a final JSON argument rather than the newer structured hook engine. The internal `UserNotification` enum is tagged with `type` and kebab-case serde naming so that `AgentTurnComplete` serializes exactly as `{"type":"agent-turn-complete", ...}` with kebab-cased field names. The only supported source event is `HookEvent::AfterAgent`, which is converted by `legacy_notify_json` into a payload containing the thread id, turn id, cwd, optional client, input messages, and optional last assistant message.

`notify_hook` turns a raw argv vector into a `Hook`. It stores the argv in an `Arc` so the returned closure can be cloned and invoked asynchronously. When executed, the closure reconstructs a `tokio::process::Command` via `command_from_argv`; an empty argv or empty program short-circuits to `HookResult::Success`, treating the hook as disabled. If payload serialization succeeds, the JSON string is appended as the final command-line argument. The command is then fully detached from interactive I/O by setting stdin/stdout/stderr to `Stdio::null()`. Spawning success is reported as `HookResult::Success`; spawn failure becomes `HookResult::FailedContinue`, meaning the failure is recorded but does not abort the surrounding operation. The tests pin the exact serialized JSON shape to preserve historical compatibility.

#### Function details

##### `legacy_notify_json`  (lines 28–41)

```
fn legacy_notify_json(payload: &HookPayload) -> Result<String, serde_json::Error>
```

**Purpose**: Serializes a modern `HookPayload` into the historical JSON notification format expected by legacy notify hooks.

**Data flow**: Reads a borrowed `HookPayload`, matches on `payload.hook_event`, and for `HookEvent::AfterAgent` constructs `UserNotification::AgentTurnComplete` using the event's thread id, turn id, input messages, last assistant message, plus `payload.cwd` and `payload.client`. It then serializes that enum with `serde_json::to_string` and returns `Result<String, serde_json::Error>`.

**Call relations**: Used by `notify_hook` at runtime before spawning the external command, and directly by the compatibility test that verifies the historical wire shape.

*Call graph*: called by 1 (legacy_notify_json_matches_historical_wire_shape); 1 external calls (to_string).


##### `notify_hook`  (lines 43–70)

```
fn notify_hook(argv: Vec<String>) -> Hook
```

**Purpose**: Builds a `Hook` that launches an external legacy notification command with the serialized payload appended as the last argv element.

**Data flow**: Consumes an argv vector, wraps it in `Arc`, and returns a `Hook` named `legacy_notify` whose async function clones the argv, calls `command_from_argv`, and returns `HookResult::Success` immediately if no valid command can be built. Otherwise it attempts `legacy_notify_json(payload)` and, on success, appends the JSON string as an argument. It nulls stdin/stdout/stderr, spawns the command, and returns `HookResult::Success` on spawn success or `HookResult::FailedContinue(err.into())` on spawn failure.

**Call relations**: Constructed from `Hooks::new` when `legacy_notify_argv` is configured. It delegates argv parsing to `command_from_argv` and payload serialization to `legacy_notify_json`.

*Call graph*: 1 external calls (new).


##### `tests::expected_notification_json`  (lines 85–96)

```
fn expected_notification_json() -> Value
```

**Purpose**: Defines the canonical JSON object that legacy notification serialization must produce.

**Data flow**: Builds a test cwd path with `test_path_buf`, then returns a `serde_json::Value` via `json!` containing the exact kebab-case keys and expected values for an `agent-turn-complete` notification.

**Call relations**: Shared by both tests as the golden wire-format fixture.

*Call graph*: 2 external calls (test_path_buf, json!).


##### `tests::test_user_notification`  (lines 99–116)

```
fn test_user_notification() -> Result<()>
```

**Purpose**: Verifies serde serialization of the internal `UserNotification` enum itself.

**Data flow**: Constructs a `UserNotification::AgentTurnComplete` with fixed sample data, serializes it to a JSON string, parses that string back into `serde_json::Value`, and asserts equality with `expected_notification_json()`.

**Call relations**: Tests the enum's serde attributes independently of `HookPayload` conversion.

*Call graph*: 5 external calls (assert_eq!, test_path_buf, from_str, to_string, vec!).


##### `tests::legacy_notify_json_matches_historical_wire_shape`  (lines 119–145)

```
fn legacy_notify_json_matches_historical_wire_shape() -> Result<()>
```

**Purpose**: Checks that converting a real `HookPayload` through `legacy_notify_json` yields the exact historical JSON shape.

**Data flow**: Builds a `HookPayload` containing `HookEvent::AfterAgent` with fixed ids/messages and current timestamp, calls `legacy_notify_json`, parses the resulting string into `serde_json::Value`, and compares it to `expected_notification_json()`.

**Call relations**: Directly validates the runtime conversion path used by `notify_hook`.

*Call graph*: calls 3 internal fn (legacy_notify_json, from_string, new); 5 external calls (assert_eq!, now, test_path_buf, from_str, vec!).


### Engine foundation
These files discover configured hooks, assemble the engine, execute commands, parse outputs, and manage oversized output handling.

### `hooks/src/engine/mod.rs`

`orchestration` · `startup initialization and per-event hook API`

This module is the top-level runtime surface for the hooks subsystem. It re-exports submodules for discovery, dispatch, command execution, output parsing, and schema loading, and defines the shared data structures they operate on. `CommandShell` captures the shell program and arguments used to execute command hooks. `ConfiguredHandler` is the normalized executable form of a discovered command hook, carrying event name, matcher, command string, timeout, source metadata, display order, and injected environment variables. Its `run_id` combines a stable event label, display order, and source path for protocol summaries.

`HookListEntry` is the richer listing model used for UI or inspection, including persisted key, plugin ID, enablement, managed status, current trust hash, and `HookTrustStatus`. `ClaudeHooksEngine` stores the discovered executable handlers, startup warnings, shell configuration, and a `HookOutputSpiller` used to offload large textual outputs.

Construction happens through `ClaudeHooksEngine::new`. If hooks are disabled, it returns an empty engine immediately. Otherwise it eagerly touches generated schemas, runs discovery with config layers, plugin sources, and trust-bypass settings, and stores the resulting handlers and warnings. The remaining methods are thin event-specific façade methods: preview methods delegate to event modules to compute `HookRunSummary` values, while run methods delegate to event modules for execution and then selectively spill large outputs back through `HookOutputSpiller`. Session-start, pre-tool-use, post-tool-use, user-prompt-submit, and stop each post-process different output fields, while permission-request and compact events return event-module results directly.

#### Function details

##### `ConfiguredHandler::run_id`  (lines 55–62)

```
fn run_id(&self) -> String
```

**Purpose**: Builds a stable identifier for one configured handler execution from its event, display order, and source path. The ID is used in protocol summaries.

**Data flow**: It reads `self.event_name`, `self.display_order`, and `self.source_path`, converts the event to a label via `event_name_label()`, formats them into `"{label}:{display_order}:{source_path}"`, and returns the resulting `String`.

**Call relations**: This method is called by dispatcher summary builders when constructing running and completed `HookRunSummary` values.

*Call graph*: called by 2 (completed_summary, running_summary); 1 external calls (format!).


##### `ConfiguredHandler::event_name_label`  (lines 64–77)

```
fn event_name_label(&self) -> &'static str
```

**Purpose**: Maps a handler’s `HookEventName` to the kebab-case label used in run IDs. It provides a stable textual naming scheme across all supported events.

**Data flow**: It matches on `self.event_name` and returns a static string such as `pre-tool-use`, `session-start`, or `stop`.

**Call relations**: This private helper is used only by `ConfiguredHandler::run_id` to keep event-to-label mapping centralized.


##### `ClaudeHooksEngine::new`  (lines 108–138)

```
fn new(
        enabled: bool,
        bypass_hook_trust: bool,
        config_layer_stack: Option<&ConfigLayerStack>,
        plugin_hook_sources: Vec<PluginHookSource>,
        plugin_hook_load_warn
```

**Purpose**: Constructs a hook engine with discovered handlers, startup warnings, shell configuration, and output spilling support. It also supports a disabled mode that skips discovery entirely.

**Data flow**: Inputs are `enabled`, `bypass_hook_trust`, an optional config stack, plugin hook sources and warnings, and a `CommandShell`. If `enabled` is false, it returns an engine with empty handlers and warnings plus a fresh `HookOutputSpiller`. Otherwise it touches generated schemas, calls `discovery::discover_handlers`, stores the discovered handlers and warnings, preserves the shell, and creates a new spiller.

**Call relations**: This constructor is called by higher-level startup code and many tests. It delegates discovery to `discover_handlers`, schema initialization to `schema_loader::generated_hook_schemas`, and spiller creation to `HookOutputSpiller::new`.

*Call graph*: calls 3 internal fn (discover_handlers, generated_hook_schemas, new); called by 18 (allow_managed_hooks_only_false_keeps_unmanaged_hooks, allow_managed_hooks_only_in_config_toml_does_not_enable_policy, allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks, allow_managed_hooks_only_skips_unmanaged_json_and_toml_hooks, allow_managed_hooks_only_skips_unmanaged_plugin_hooks, discovers_hooks_from_json_and_toml_in_the_same_layer, malformed_hooks_json_is_reported_as_startup_warning, plugin_hook_load_warnings_are_startup_warnings, plugin_hook_sources_expand_plugin_placeholders, plugin_hook_sources_run_with_plugin_env_and_plugin_source (+8 more)); 1 external calls (new).


##### `ClaudeHooksEngine::warnings`  (lines 140–142)

```
fn warnings(&self) -> &[String]
```

**Purpose**: Exposes the engine’s startup warnings collected during discovery and plugin loading. It provides read-only access to the stored warning list.

**Data flow**: It takes `&self` and returns `&[String]` referencing `self.warnings`.

**Call relations**: This accessor is used by callers that need to surface startup diagnostics after engine construction.

*Call graph*: called by 1 (startup_warnings).


##### `ClaudeHooksEngine::preview_session_start`  (lines 144–149)

```
fn preview_session_start(
        &self,
        request: &SessionStartRequest,
    ) -> Vec<HookRunSummary>
```

**Purpose**: Computes the run summaries for session-start hooks that would execute for a given request, without running them. It is the session-start preview façade.

**Data flow**: It takes `&self` and a `&SessionStartRequest`, passes `&self.handlers` and the request to `crate::events::session_start::preview`, and returns the resulting `Vec<HookRunSummary>`.

**Call relations**: This method is called by external preview flows for session-start events. It delegates all selection and summary construction to the event module.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_session_start).


##### `ClaudeHooksEngine::preview_pre_tool_use`  (lines 151–153)

```
fn preview_pre_tool_use(&self, request: &PreToolUseRequest) -> Vec<HookRunSummary>
```

**Purpose**: Previews which pre-tool-use hooks would run for a request. It forwards the engine’s discovered handlers into the event-specific preview logic.

**Data flow**: It takes `&self` and a `&PreToolUseRequest`, calls `crate::events::pre_tool_use::preview(&self.handlers, request)`, and returns the resulting summaries.

**Call relations**: This is the pre-tool-use preview entrypoint used by higher-level code; it delegates entirely to the event module.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_pre_tool_use).


##### `ClaudeHooksEngine::preview_permission_request`  (lines 155–160)

```
fn preview_permission_request(
        &self,
        request: &PermissionRequestRequest,
    ) -> Vec<HookRunSummary>
```

**Purpose**: Previews permission-request hooks for a request without executing them. It is a thin wrapper over the event module.

**Data flow**: It takes `&self` and a `&PermissionRequestRequest`, calls `crate::events::permission_request::preview(&self.handlers, request)`, and returns the summaries.

**Call relations**: This method is invoked by permission-request preview flows and delegates all logic to the corresponding event module.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_permission_request).


##### `ClaudeHooksEngine::preview_post_tool_use`  (lines 162–167)

```
fn preview_post_tool_use(
        &self,
        request: &PostToolUseRequest,
    ) -> Vec<HookRunSummary>
```

**Purpose**: Previews post-tool-use hooks that match a request. It exposes the event module’s preview behavior through the engine façade.

**Data flow**: It takes `&self` and a `&PostToolUseRequest`, calls `crate::events::post_tool_use::preview(&self.handlers, request)`, and returns the resulting summaries.

**Call relations**: This method is used by post-tool-use preview callers and delegates directly to the event module.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_post_tool_use).


##### `ClaudeHooksEngine::run_session_start`  (lines 169–181)

```
async fn run_session_start(
        &self,
        request: SessionStartRequest,
        turn_id: Option<String>,
    ) -> SessionStartOutcome
```

**Purpose**: Executes session-start hooks and spills any large additional-context outputs after execution. It wraps event execution with output post-processing.

**Data flow**: It takes ownership of a `SessionStartRequest` and optional `turn_id`, extracts `session_id`, awaits `crate::events::session_start::run(&self.handlers, &self.shell, request, turn_id)`, then replaces `outcome.additional_contexts` with the result of `maybe_spill_texts(session_id, ...)` and returns the modified outcome.

**Call relations**: This async method is called during session-start handling. It delegates execution to the session-start event module and then delegates output-size management to `maybe_spill_texts`.

*Call graph*: calls 2 internal fn (maybe_spill_texts, run); called by 1 (run_session_start).


##### `ClaudeHooksEngine::run_pre_tool_use`  (lines 183–191)

```
async fn run_pre_tool_use(&self, request: PreToolUseRequest) -> PreToolUseOutcome
```

**Purpose**: Executes pre-tool-use hooks and spills any large additional-context outputs. It is the runtime façade for pre-tool-use hook execution.

**Data flow**: It takes a `PreToolUseRequest`, extracts `session_id`, awaits `crate::events::pre_tool_use::run(&self.handlers, &self.shell, request)`, post-processes `outcome.additional_contexts` through `maybe_spill_texts`, and returns the updated outcome.

**Call relations**: This method is invoked during pre-tool-use handling. It delegates execution to the event module and output spilling to `maybe_spill_texts`.

*Call graph*: calls 2 internal fn (maybe_spill_texts, run); called by 1 (run_pre_tool_use).


##### `ClaudeHooksEngine::run_permission_request`  (lines 193–198)

```
async fn run_permission_request(
        &self,
        request: PermissionRequestRequest,
    ) -> PermissionRequestOutcome
```

**Purpose**: Executes permission-request hooks without any additional output spilling step. It simply forwards the request to the event module.

**Data flow**: It takes a `PermissionRequestRequest`, awaits `crate::events::permission_request::run(&self.handlers, &self.shell, request)`, and returns the resulting `PermissionRequestOutcome` unchanged.

**Call relations**: This async façade is used during permission-request handling and delegates entirely to the event module.

*Call graph*: calls 1 internal fn (run); called by 1 (run_permission_request).


##### `ClaudeHooksEngine::run_post_tool_use`  (lines 200–214)

```
async fn run_post_tool_use(
        &self,
        request: PostToolUseRequest,
    ) -> PostToolUseOutcome
```

**Purpose**: Executes post-tool-use hooks and spills both additional contexts and the optional feedback message if needed. It performs the richest post-processing among the event runners in this file.

**Data flow**: It takes a `PostToolUseRequest`, extracts `session_id`, awaits `crate::events::post_tool_use::run(&self.handlers, &self.shell, request)`, rewrites `outcome.additional_contexts` via `maybe_spill_texts`, rewrites `outcome.feedback_message` via `maybe_spill_text`, and returns the modified outcome.

**Call relations**: This method is called during post-tool-use handling. It delegates execution to the event module and then uses both `maybe_spill_texts` and `maybe_spill_text` for output-size management.

*Call graph*: calls 3 internal fn (maybe_spill_text, maybe_spill_texts, run); called by 1 (run_post_tool_use).


##### `ClaudeHooksEngine::preview_pre_compact`  (lines 216–218)

```
fn preview_pre_compact(&self, request: &PreCompactRequest) -> Vec<HookRunSummary>
```

**Purpose**: Previews pre-compact hooks for a compact request. It is a thin façade over the compact event module’s pre-preview path.

**Data flow**: It takes `&self` and a `&PreCompactRequest`, calls `crate::events::compact::preview_pre(&self.handlers, request)`, and returns the summaries.

**Call relations**: This method is used by pre-compact preview flows and delegates directly to the compact event module.

*Call graph*: calls 1 internal fn (preview_pre); called by 1 (preview_pre_compact).


##### `ClaudeHooksEngine::run_pre_compact`  (lines 220–222)

```
async fn run_pre_compact(&self, request: PreCompactRequest) -> PreCompactOutcome
```

**Purpose**: Executes pre-compact hooks. Unlike some other event runners, it does not perform output spilling in this layer.

**Data flow**: It takes a `PreCompactRequest`, awaits `crate::events::compact::run_pre(&self.handlers, &self.shell, request)`, and returns the resulting `PreCompactOutcome` unchanged.

**Call relations**: This async method is called during pre-compact handling and delegates entirely to the compact event module.

*Call graph*: calls 1 internal fn (run_pre); called by 1 (run_pre_compact).


##### `ClaudeHooksEngine::preview_post_compact`  (lines 224–226)

```
fn preview_post_compact(&self, request: &PostCompactRequest) -> Vec<HookRunSummary>
```

**Purpose**: Previews post-compact hooks for a compact request. It forwards to the compact event module’s post-preview logic.

**Data flow**: It takes `&self` and a `&PostCompactRequest`, calls `crate::events::compact::preview_post(&self.handlers, request)`, and returns the summaries.

**Call relations**: This method is used by post-compact preview flows and delegates directly to the compact event module.

*Call graph*: calls 1 internal fn (preview_post); called by 1 (preview_post_compact).


##### `ClaudeHooksEngine::run_post_compact`  (lines 228–233)

```
async fn run_post_compact(
        &self,
        request: PostCompactRequest,
    ) -> StatelessHookOutcome
```

**Purpose**: Executes post-compact hooks and returns their stateless outcome. No output spilling is applied here.

**Data flow**: It takes a `PostCompactRequest`, awaits `crate::events::compact::run_post(&self.handlers, &self.shell, request)`, and returns the resulting `StatelessHookOutcome`.

**Call relations**: This async façade is used during post-compact handling and delegates entirely to the compact event module.

*Call graph*: calls 1 internal fn (run_post); called by 1 (run_post_compact).


##### `ClaudeHooksEngine::preview_user_prompt_submit`  (lines 235–240)

```
fn preview_user_prompt_submit(
        &self,
        request: &UserPromptSubmitRequest,
    ) -> Vec<HookRunSummary>
```

**Purpose**: Previews user-prompt-submit hooks for a request. It exposes the event module’s preview logic through the engine.

**Data flow**: It takes `&self` and a `&UserPromptSubmitRequest`, calls `crate::events::user_prompt_submit::preview(&self.handlers, request)`, and returns the summaries.

**Call relations**: This method is used by user-prompt-submit preview flows and delegates directly to the event module.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_user_prompt_submit).


##### `ClaudeHooksEngine::run_user_prompt_submit`  (lines 242–253)

```
async fn run_user_prompt_submit(
        &self,
        request: UserPromptSubmitRequest,
    ) -> UserPromptSubmitOutcome
```

**Purpose**: Executes user-prompt-submit hooks and spills any large additional-context outputs. It wraps event execution with output post-processing.

**Data flow**: It takes a `UserPromptSubmitRequest`, extracts `session_id`, awaits `crate::events::user_prompt_submit::run(&self.handlers, &self.shell, request)`, rewrites `outcome.additional_contexts` via `maybe_spill_texts`, and returns the updated outcome.

**Call relations**: This async method is called during user-prompt-submit handling. It delegates execution to the event module and output spilling to `maybe_spill_texts`.

*Call graph*: calls 2 internal fn (maybe_spill_texts, run); called by 1 (run_user_prompt_submit).


##### `ClaudeHooksEngine::preview_stop`  (lines 255–257)

```
fn preview_stop(&self, request: &StopRequest) -> Vec<HookRunSummary>
```

**Purpose**: Previews stop hooks for a request. It is the stop-event preview façade.

**Data flow**: It takes `&self` and a `&StopRequest`, calls `crate::events::stop::preview(&self.handlers, request)`, and returns the resulting summaries.

**Call relations**: This method is used by stop preview flows and delegates directly to the stop event module.

*Call graph*: calls 1 internal fn (preview); called by 1 (preview_stop).


##### `ClaudeHooksEngine::run_stop`  (lines 259–266)

```
async fn run_stop(&self, request: StopRequest) -> StopOutcome
```

**Purpose**: Executes stop hooks and spills any continuation prompt fragments after execution. It post-processes the stop outcome’s fragment payloads.

**Data flow**: It takes a `StopRequest`, extracts `session_id`, awaits `crate::events::stop::run(&self.handlers, &self.shell, request)`, rewrites `outcome.continuation_fragments` via `maybe_spill_prompt_fragments`, and returns the modified outcome.

**Call relations**: This async method is called during stop handling. It delegates execution to the stop event module and fragment spilling to `maybe_spill_prompt_fragments`.

*Call graph*: calls 2 internal fn (maybe_spill_prompt_fragments, run); called by 1 (run_stop).


##### `ClaudeHooksEngine::maybe_spill_texts`  (lines 268–272)

```
async fn maybe_spill_texts(&self, session_id: ThreadId, texts: Vec<String>) -> Vec<String>
```

**Purpose**: Delegates a batch of text outputs to the output spiller, which may replace oversized inline text with spilled references. It centralizes that post-processing behind the engine.

**Data flow**: It takes a `ThreadId` and `Vec<String>`, awaits `self.output_spiller.maybe_spill_texts(session_id, texts)`, and returns the possibly transformed vector.

**Call relations**: This helper is called by several run methods after event execution whenever outcomes contain multiple text fields that may need spilling.

*Call graph*: calls 1 internal fn (maybe_spill_texts); called by 4 (run_post_tool_use, run_pre_tool_use, run_session_start, run_user_prompt_submit).


##### `ClaudeHooksEngine::maybe_spill_text`  (lines 274–279)

```
async fn maybe_spill_text(&self, session_id: ThreadId, text: Option<String>) -> Option<String>
```

**Purpose**: Conditionally spills a single optional text output. It preserves `None` unchanged and only invokes the spiller for present text.

**Data flow**: It takes a `ThreadId` and `Option<String>`. If the option is `Some(text)`, it awaits `self.output_spiller.maybe_spill_text(session_id, text)` and wraps the result back in `Some`; if `None`, it returns `None` directly.

**Call relations**: This helper is used by `run_post_tool_use` for the optional feedback message field.

*Call graph*: calls 1 internal fn (maybe_spill_text); called by 1 (run_post_tool_use).


##### `ClaudeHooksEngine::maybe_spill_prompt_fragments`  (lines 281–289)

```
async fn maybe_spill_prompt_fragments(
        &self,
        session_id: ThreadId,
        fragments: Vec<codex_protocol::items::HookPromptFragment>,
    ) -> Vec<codex_protocol::items::HookPromptFra
```

**Purpose**: Delegates prompt-fragment spilling to the output spiller for stop-hook continuation fragments. It handles structured prompt fragment outputs rather than plain strings.

**Data flow**: It takes a `ThreadId` and a vector of `codex_protocol::items::HookPromptFragment`, awaits `self.output_spiller.maybe_spill_prompt_fragments(session_id, fragments)`, and returns the transformed fragment vector.

**Call relations**: This helper is called only by `run_stop` after stop-hook execution.

*Call graph*: calls 1 internal fn (maybe_spill_prompt_fragments); called by 1 (run_stop).


### `hooks/src/engine/discovery.rs`

`domain_logic` · `startup hook discovery`

This file is the heart of hook discovery. `discover_handlers` gathers hook declarations from three sources: managed requirements embedded in `ConfigLayerStack::requirements()`, per-layer hook config from `hooks.json` or TOML `hooks` sections, and plugin hook bundles. It first computes persisted user/session hook state with `hook_states_from_stack`, derives a `HookDiscoveryPolicy` from requirements and the `bypass_hook_trust` flag, and then walks config layers in precedence order while deduplicating JSON hook folders. If both JSON and TOML hooks are present for one layer and both are non-empty, it emits a warning.

The normalization path flows through `append_hook_events` and `append_matcher_groups`. Matchers are canonicalized per event with `matcher_pattern_for_event`; invalid matchers only produce warnings for events where validation applies. Command handlers are normalized by resolving Windows overrides, rejecting async and empty commands, defaulting timeout to at least 1 second, substituting plugin environment placeholders like `${PLUGIN_ROOT}`, and computing a stable trust hash from a serialized `NormalizedHookIdentity`. Each concrete handler gets a durable positional key via `crate::hook_key`, a `HookListEntry` recording source, trust, enablement, and display order, and—if enabled and trusted or bypassed—a `ConfiguredHandler` for execution.

Managed hooks are always enabled and treated as `HookTrustStatus::Managed`; unmanaged hooks consult persisted `HookStateToml` for `enabled` and `trusted_hash`. The file also contains path attribution helpers for synthetic sources such as MDM and enterprise-managed configs, including XML escaping for display-safe synthetic paths. Tests cover matcher behavior, trust bypass, malformed state tolerance, source attribution, and managed-source edge cases.

#### Function details

##### `HookDiscoveryPolicy::allows`  (lines 58–60)

```
fn allows(self, source: &HookHandlerSource<'_>) -> bool
```

**Purpose**: Checks whether a discovered hook source is permitted under the current discovery policy. Its only current gate is whether unmanaged hooks should be excluded.

**Data flow**: It reads `self.allow_managed_hooks_only` and `source.is_managed`. It returns `true` for all sources unless managed-only mode is active, in which case it returns `true` only for managed sources.

**Call relations**: This method is called by `append_hook_events` before any event expansion. It acts as the policy gate that suppresses unmanaged hooks when requirements demand managed-only discovery.

*Call graph*: called by 1 (append_hook_events).


##### `discover_handlers`  (lines 63–174)

```
fn discover_handlers(
    config_layer_stack: Option<&ConfigLayerStack>,
    plugin_hook_sources: Vec<PluginHookSource>,
    plugin_hook_load_warnings: Vec<String>,
    bypass_hook_trust: bool,
) -> D
```

**Purpose**: Builds the complete discovered hook set, including executable handlers, hook list entries, and startup warnings, from config layers and plugin sources. It is the top-level discovery pipeline used during engine construction.

**Data flow**: Inputs are an optional `ConfigLayerStack`, plugin hook sources and their load warnings, and a `bypass_hook_trust` flag. It initializes output vectors and display-order state, computes persisted hook states, derives a `HookDiscoveryPolicy`, optionally appends managed requirement hooks, iterates config layers to load JSON and TOML hooks with warnings, appends discovered events into handlers and entries, then appends plugin hooks with plugin-specific environment variables. It returns a `DiscoveryResult` containing the final handlers, hook entries, and warnings.

**Call relations**: This function is called by `ClaudeHooksEngine::new` during startup. It delegates source-specific work to `append_managed_requirement_handlers`, `load_hooks_json`, `load_toml_hooks_from_layer`, `append_hook_events`, and `append_plugin_hook_sources`, while using `hook_states_from_stack` and source-metadata helpers to drive policy and attribution.

*Call graph*: calls 8 internal fn (hook_states_from_stack, append_hook_events, append_managed_requirement_handlers, append_plugin_hook_sources, config_toml_source_path, hook_metadata_for_config_layer_source, load_hooks_json, load_toml_hooks_from_layer); called by 9 (new, allow_managed_hooks_only_false_keeps_unmanaged_hooks, allow_managed_hooks_only_in_config_toml_does_not_enable_policy, allow_managed_hooks_only_keeps_managed_requirement_and_config_layer_hooks, trusted_plugin_hook_stack, unknown_requirement_source_hooks_stay_managed, user_disablement_does_not_filter_managed_layer_hooks, user_disablement_filters_non_managed_hooks_but_not_managed_hooks, list_hooks); 4 external calls (new, new, new, format!).


##### `append_managed_requirement_handlers`  (lines 176–207)

```
fn append_managed_requirement_handlers(
    handlers: &mut Vec<ConfiguredHandler>,
    hook_entries: &mut Vec<HookListEntry>,
    warnings: &mut Vec<String>,
    display_order: &mut i64,
    config_la
```

**Purpose**: Adds hooks declared in managed requirements to the discovery outputs. It treats these hooks as managed and attributes them to the requirement source.

**Data flow**: It receives mutable handler, entry, warning, and display-order accumulators plus the config stack, persisted hook states, and policy. It reads `config_layer_stack.requirements().managed_hooks`, returns early if absent, computes a source path and `HookSource`, constructs a managed `HookHandlerSource` with empty env and no plugin ID, clones the requirement hooks, and forwards them to `append_hook_events`.

**Call relations**: This helper is invoked only from `discover_handlers` before ordinary layer scanning. It delegates path attribution to `managed_hooks_source_path`, source attribution to `hook_source_for_requirement_source`, and actual event expansion to `append_hook_events`.

*Call graph*: calls 4 internal fn (requirements, append_hook_events, hook_source_for_requirement_source, managed_hooks_source_path); called by 1 (discover_handlers); 1 external calls (new).


##### `append_plugin_hook_sources`  (lines 209–259)

```
fn append_plugin_hook_sources(
    handlers: &mut Vec<ConfiguredHandler>,
    hook_entries: &mut Vec<HookListEntry>,
    warnings: &mut Vec<String>,
    display_order: &mut i64,
    plugin_hook_source
```

**Purpose**: Transforms plugin hook bundles into discovered hook handlers and entries, injecting plugin-specific environment variables and stable plugin key prefixes. It is the plugin-specific branch of discovery.

**Data flow**: It takes mutable output accumulators, a vector of `PluginHookSource`, persisted hook states, and policy. For each plugin source it extracts roots, IDs, paths, and hooks; builds an env map containing `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA`, and `CLAUDE_PLUGIN_DATA`; derives a plugin key source string; constructs a `HookHandlerSource` marked as `HookSource::Plugin`; and passes the hooks to `append_hook_events`.

**Call relations**: This helper is called by `discover_handlers` after config-layer discovery. It delegates plugin key-prefix formatting to `crate::declarations::plugin_hook_key_source` and relies on `append_hook_events` for matcher expansion, trust computation, and handler creation.

*Call graph*: calls 2 internal fn (plugin_hook_key_source, append_hook_events); called by 1 (discover_handlers); 1 external calls (new).


##### `managed_hooks_source_path`  (lines 261–273)

```
fn managed_hooks_source_path(
    managed_hooks: &ManagedHooksRequirementsToml,
    requirement_source: Option<&RequirementSource>,
) -> AbsolutePathBuf
```

**Purpose**: Determines the source path to attribute to managed requirement hooks. It prefers a platform-specific managed directory when available and absolute, otherwise falls back to a synthetic or requirement-derived path.

**Data flow**: It reads the `ManagedHooksRequirementsToml` and optional `RequirementSource`. If `managed_dir_for_current_platform()` yields an absolute path that converts to `AbsolutePathBuf`, it returns that path; otherwise it calls `fallback_managed_hooks_source_path` and returns its result.

**Call relations**: This helper is used by `append_managed_requirement_handlers` to label managed hooks with a source path. Its branch structure preserves real filesystem attribution when possible and synthetic attribution otherwise.

*Call graph*: calls 3 internal fn (managed_dir_for_current_platform, fallback_managed_hooks_source_path, from_absolute_path); called by 1 (append_managed_requirement_handlers).


##### `fallback_managed_hooks_source_path`  (lines 275–301)

```
fn fallback_managed_hooks_source_path(
    requirement_source: Option<&RequirementSource>,
) -> AbsolutePathBuf
```

**Purpose**: Builds a synthetic or source-derived path for managed hooks when no concrete managed directory can be used. It preserves coarse provenance across several requirement-source variants.

**Data flow**: It matches on `Option<&RequirementSource>`. File-backed sources return their stored file path; MDM, composite, enterprise-managed, legacy-MDM, unknown, and absent sources are converted into synthetic absolute paths using formatted placeholder strings, with enterprise-managed `name` and `id` XML-escaped first. It returns an `AbsolutePathBuf`.

**Call relations**: This helper is called by `managed_hooks_source_path` on fallback paths. It delegates placeholder path construction to `synthetic_layer_path` and escaping of enterprise display fields to `escape_xml_text`.

*Call graph*: calls 2 internal fn (escape_xml_text, synthetic_layer_path); called by 1 (managed_hooks_source_path); 1 external calls (format!).


##### `load_hooks_json`  (lines 303–344)

```
fn load_hooks_json(
    config_folder: Option<&Path>,
    warnings: &mut Vec<String>,
) -> Option<(AbsolutePathBuf, HookEventsToml)>
```

**Purpose**: Loads and parses a `hooks.json` file from a config folder, returning normalized hook events and recording warnings on read or parse failures. Empty hook sets are treated as absent.

**Data flow**: It takes an optional config folder path and mutable warnings. It appends `hooks.json`, returns `None` if the file does not exist, reads the file contents as text, parses them as `HooksFile` with `serde_json::from_str`, normalizes the path to `AbsolutePathBuf`, and returns `Some((source_path, parsed.hooks))` only if the parsed hooks are non-empty. Any read, parse, or path-normalization error pushes a warning and yields `None`.

**Call relations**: This loader is called by `discover_handlers` for each eligible config layer, with folder deduplication handled by the caller. It feeds successful results into `append_hook_events` alongside TOML-loaded hooks.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (discover_handlers); 3 external calls (format!, read_to_string, from_str).


##### `load_toml_hooks_from_layer`  (lines 346–364)

```
fn load_toml_hooks_from_layer(
    layer: &ConfigLayerEntry,
    warnings: &mut Vec<String>,
) -> Option<(AbsolutePathBuf, HookEventsToml)>
```

**Purpose**: Extracts and deserializes the `hooks` section from a config layer’s TOML tree. It reports parse failures as warnings and ignores empty hook sets.

**Data flow**: It takes a `ConfigLayerEntry` and mutable warnings, computes the layer’s source path, clones `layer.config["hooks"]` if present, attempts `HookEventsToml::deserialize`, and returns `Some((source_path, parsed))` only when the parsed hook events are non-empty. Deserialization failures append a warning and return `None`.

**Call relations**: This helper is called by `discover_handlers` for each config layer. It uses `config_toml_source_path` for attribution and supplies successful hook sets to `append_hook_events`.

*Call graph*: calls 1 internal fn (config_toml_source_path); called by 1 (discover_handlers); 2 external calls (deserialize, format!).


##### `config_toml_source_path`  (lines 366–386)

```
fn config_toml_source_path(layer: &ConfigLayerEntry) -> AbsolutePathBuf
```

**Purpose**: Computes the path that should be shown as the source of a config layer’s TOML hooks. It collapses detailed layer metadata into a single absolute path or synthetic placeholder path.

**Data flow**: It matches on `layer.name`. File-backed system, user, and legacy-managed layers return their stored file path; project layers derive a config path from `hooks_config_folder()` or `.codex`; MDM, enterprise-managed, legacy-MDM, and session-flags layers produce synthetic absolute paths using formatted placeholders. It returns an `AbsolutePathBuf`.

**Call relations**: This helper is used both by `discover_handlers` when constructing policy metadata and by `load_toml_hooks_from_layer` for warning attribution. It delegates synthetic path creation to `synthetic_layer_path`.

*Call graph*: calls 2 internal fn (hooks_config_folder, synthetic_layer_path); called by 2 (discover_handlers, load_toml_hooks_from_layer); 1 external calls (format!).


##### `synthetic_layer_path`  (lines 388–398)

```
fn synthetic_layer_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Creates an absolute placeholder path for non-filesystem config sources. It anchors synthetic paths against a platform-appropriate root.

**Data flow**: It takes a relative placeholder string and resolves it against `C:\` on Windows or `/` on non-Windows using `AbsolutePathBuf::resolve_path_against_base`. It returns the resulting absolute path buffer.

**Call relations**: This helper is called by `config_toml_source_path` and `fallback_managed_hooks_source_path`. It centralizes the platform-specific root used for synthetic attribution paths.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 2 (config_toml_source_path, fallback_managed_hooks_source_path).


##### `escape_xml_text`  (lines 400–413)

```
fn escape_xml_text(value: &str) -> String
```

**Purpose**: Escapes XML-sensitive characters in display strings used inside synthetic enterprise-managed paths. This prevents raw `<`, `>`, `&`, and quote characters from appearing unescaped in those placeholders.

**Data flow**: It takes an input `&str`, allocates a `String` with matching capacity, iterates characters, replaces XML-sensitive characters with entity strings, and copies all others unchanged. It returns the escaped string.

**Call relations**: This helper is only used by `fallback_managed_hooks_source_path` when formatting enterprise-managed synthetic paths. Its role is display-safe path construction rather than general serialization.

*Call graph*: called by 1 (fallback_managed_hooks_source_path); 1 external calls (with_capacity).


##### `append_hook_events`  (lines 415–439)

```
fn append_hook_events(
    handlers: &mut Vec<ConfiguredHandler>,
    hook_entries: &mut Vec<HookListEntry>,
    warnings: &mut Vec<String>,
    display_order: &mut i64,
    source: HookHandlerSource<
```

**Purpose**: Expands a `HookEventsToml` bundle into matcher groups and appends any resulting handlers and hook entries, subject to discovery policy. It is the common bridge from source-specific loading to per-handler normalization.

**Data flow**: It receives mutable output accumulators, a `HookHandlerSource`, a `HookEventsToml`, and a `HookDiscoveryPolicy`. If the policy disallows the source it returns immediately; otherwise it iterates `hook_events.into_matcher_groups()` and forwards each event’s matcher groups to `append_matcher_groups`.

**Call relations**: This helper is called from `discover_handlers`, `append_managed_requirement_handlers`, and `append_plugin_hook_sources`. It delegates the detailed per-group and per-handler logic to `append_matcher_groups` after applying the coarse policy gate.

*Call graph*: calls 3 internal fn (into_matcher_groups, allows, append_matcher_groups); called by 3 (append_managed_requirement_handlers, append_plugin_hook_sources, discover_handlers).


##### `append_matcher_groups`  (lines 441–559)

```
fn append_matcher_groups(
    handlers: &mut Vec<ConfiguredHandler>,
    hook_entries: &mut Vec<HookListEntry>,
    warnings: &mut Vec<String>,
    display_order: &mut i64,
    source: &HookHandlerSou
```

**Purpose**: Normalizes matcher groups into concrete hook list entries and executable command handlers. It performs matcher validation, command normalization, trust computation, enablement checks, and display-order assignment.

**Data flow**: Inputs are mutable handler, entry, warning, and display-order accumulators; a `HookHandlerSource`; an event name; and a vector of `MatcherGroup`. For each group it derives an event-specific matcher pattern, validates it when applicable, then iterates cloned handlers. Command handlers are normalized by resolving Windows overrides, rejecting async or empty commands, defaulting timeout, computing a normalized trust hash, substituting `${KEY}` placeholders from `source.env`, generating a durable positional key, reading persisted state, deriving `enabled`, `trusted_hash`, and `trust_status`, and pushing a `HookListEntry`. If the hook is enabled and either trusted/managed or trust bypass is active, it also pushes a `ConfiguredHandler`. Unsupported prompt and agent handlers only emit warnings. It increments `display_order` after each command handler considered.

**Call relations**: This is the core expansion routine called by `append_hook_events` and directly by several tests. It delegates matcher canonicalization and validation to event helpers, trust hashing to `command_hook_hash`, and state interpretation to `hook_enabled`, `hook_trusted_hash`, and `hook_trust_status`.

*Call graph*: calls 6 internal fn (command_hook_hash, hook_enabled, hook_trust_status, hook_trusted_hash, matcher_pattern_for_event, validate_matcher_pattern); called by 8 (append_hook_events, bypass_hook_trust_allows_enabled_untrusted_handlers, bypass_hook_trust_respects_disabled_handlers, post_tool_use_keeps_valid_matcher_during_discovery, pre_tool_use_keeps_valid_matcher_during_discovery, pre_tool_use_resolves_windows_command_override_during_discovery, pre_tool_use_treats_star_matcher_as_match_all, user_prompt_submit_ignores_invalid_matcher_during_discovery); 4 external calls (cfg!, hook_key, format!, matches!).


##### `command_hook_hash`  (lines 570–587)

```
fn command_hook_hash(
    event_name: codex_protocol::protocol::HookEventName,
    matcher: Option<&str>,
    group: &MatcherGroup,
    normalized_handler: HookHandlerConfig,
) -> String
```

**Purpose**: Computes a stable trust hash for a command hook from a normalized semantic identity rather than raw source text. Equivalent hooks from TOML and JSON therefore converge on the same trust fingerprint.

**Data flow**: It takes an event name, optional normalized matcher, the original `MatcherGroup`, and a normalized `HookHandlerConfig`. It clones the group, replaces its matcher and hooks with the normalized values, wraps that in `NormalizedHookIdentity`, converts it to `TomlValue`, and hashes/version-tags it with `version_for_toml`. It returns the resulting hash string.

**Call relations**: This helper is called by `append_matcher_groups` before trust evaluation. Its output is compared against persisted trusted hashes by `hook_trust_status`.

*Call graph*: called by 1 (append_matcher_groups); 6 external calls (try_from, version_for_toml, clone, hook_event_key_label, unreachable!, vec!).


##### `hook_trust_status`  (lines 589–603)

```
fn hook_trust_status(
    is_managed: bool,
    current_hash: &str,
    trusted_hash: Option<&str>,
) -> HookTrustStatus
```

**Purpose**: Determines the trust status of a hook from its managed flag, current normalized hash, and persisted trusted hash. Managed hooks bypass hash comparison entirely.

**Data flow**: It reads `is_managed`, `current_hash`, and `trusted_hash`. Managed hooks return `HookTrustStatus::Managed`; otherwise a matching trusted hash yields `Trusted`, a non-matching trusted hash yields `Modified`, and absence of a trusted hash yields `Untrusted`.

**Call relations**: This helper is called by `append_matcher_groups` when constructing each `HookListEntry` and deciding whether an unmanaged hook may execute without trust bypass.

*Call graph*: called by 1 (append_matcher_groups).


##### `hook_enabled`  (lines 605–607)

```
fn hook_enabled(is_managed: bool, state: Option<&HookStateToml>) -> bool
```

**Purpose**: Computes whether a hook should be considered enabled based on managed status and persisted state. Managed hooks cannot be disabled by user state.

**Data flow**: It takes `is_managed` and an optional `&HookStateToml`. It returns `true` for managed hooks, otherwise returns `false` only when the state explicitly contains `enabled: Some(false)`.

**Call relations**: This helper is called by `append_matcher_groups` for each discovered command handler. Its result is stored in `HookListEntry.enabled` and gates whether a `ConfiguredHandler` is emitted.

*Call graph*: called by 1 (append_matcher_groups).


##### `hook_trusted_hash`  (lines 609–613)

```
fn hook_trusted_hash(is_managed: bool, state: Option<&HookStateToml>) -> Option<&str>
```

**Purpose**: Extracts the persisted trusted hash applicable to a hook, suppressing trust state for managed hooks. It ensures managed hooks are not evaluated against user trust records.

**Data flow**: It takes `is_managed` and an optional `&HookStateToml`. For unmanaged hooks it returns `state.trusted_hash.as_deref()`, and for managed hooks it returns `None`.

**Call relations**: This helper is called by `append_matcher_groups` immediately before `hook_trust_status`. It isolates the rule that managed hooks ignore persisted trust hashes.

*Call graph*: called by 1 (append_matcher_groups).


##### `hook_metadata_for_config_layer_source`  (lines 615–630)

```
fn hook_metadata_for_config_layer_source(source: &ConfigLayerSource) -> (HookSource, bool)
```

**Purpose**: Maps a config layer source to coarse hook provenance metadata: protocol-level `HookSource` and whether the source is managed. It intentionally discards source-specific details like file paths.

**Data flow**: It matches on `&ConfigLayerSource` and returns a `(HookSource, bool)` pair for each variant, marking system, MDM, enterprise-managed, and legacy-managed variants as managed and user/project/session-flags as unmanaged.

**Call relations**: This helper is called by `discover_handlers` when preparing per-layer `HookHandlerSource` values. It provides the source classification later stored in `HookListEntry` and `ConfiguredHandler`.

*Call graph*: called by 1 (discover_handlers).


##### `hook_source_for_requirement_source`  (lines 632–652)

```
fn hook_source_for_requirement_source(source: Option<&RequirementSource>) -> HookSource
```

**Purpose**: Maps a managed requirement source to the protocol-level `HookSource` used for hooks originating from requirements. Composite sources inherit the first contributing source as coarse attribution.

**Data flow**: It matches on `Option<&RequirementSource>`, returning the corresponding `HookSource`. For `Composite`, it recursively examines `sources.first()`; unknown or absent sources map to `HookSource::Unknown`.

**Call relations**: This helper is used by `append_managed_requirement_handlers` to label requirement-derived hooks. Its recursive composite handling preserves the primary contributor when exact merged provenance cannot be represented.

*Call graph*: called by 1 (append_managed_requirement_handlers).


##### `tests::source_path`  (lines 675–677)

```
fn source_path() -> AbsolutePathBuf
```

**Purpose**: Provides a reusable absolute test path for hook source attribution. It keeps test fixtures consistent across discovery tests.

**Data flow**: It constructs `/tmp/hooks.json` with `test_path_buf(...).abs()` and returns the resulting `AbsolutePathBuf`.

**Call relations**: This helper is used by multiple tests that need a stable source path when constructing expected handlers or hook sources.

*Call graph*: 1 external calls (test_path_buf).


##### `tests::hook_source`  (lines 679–681)

```
fn hook_source() -> HookSource
```

**Purpose**: Returns the canonical `HookSource::System` value used by several tests. It avoids repeating the same literal in expected values.

**Data flow**: It takes no input and returns `HookSource::System`.

**Call relations**: This helper is used by test fixture constructors and assertions involving managed/system hook sources.


##### `tests::hook_handler_source`  (lines 683–697)

```
fn hook_handler_source(
        path: &'a AbsolutePathBuf,
        hook_states: &'a std::collections::HashMap<String, HookStateToml>,
    ) -> super::HookHandlerSource<'a>
```

**Purpose**: Builds a managed `HookHandlerSource` fixture for tests. It mirrors the production structure with a path-derived key source and empty environment.

**Data flow**: It takes a path and hook-state map reference, formats the path display string into `key_source`, fills `source` from `hook_source()`, sets `is_managed` true and `bypass_hook_trust` false, and returns the constructed `HookHandlerSource`.

**Call relations**: This helper is used by matcher and discovery tests that need a managed source fixture to pass into `append_matcher_groups`.

*Call graph*: calls 1 internal fn (display); 2 external calls (hook_source, new).


##### `tests::unmanaged_hook_handler_source`  (lines 699–714)

```
fn unmanaged_hook_handler_source(
        path: &'a AbsolutePathBuf,
        hook_states: &'a std::collections::HashMap<String, HookStateToml>,
        bypass_hook_trust: bool,
    ) -> super::HookHan
```

**Purpose**: Builds an unmanaged `HookHandlerSource` fixture for tests, with configurable trust bypass. It is used to exercise user-state and trust behavior.

**Data flow**: It takes a path, hook-state map reference, and `bypass_hook_trust` flag, derives `key_source` from the path display string, sets `source` to `HookSource::User`, marks `is_managed` false, and returns the constructed `HookHandlerSource`.

**Call relations**: This helper is used by tests that verify trust bypass and disabled unmanaged hooks in `append_matcher_groups`.

*Call graph*: calls 1 internal fn (display); 1 external calls (new).


##### `tests::composite_requirement_hook_source_uses_primary_source`  (lines 717–734)

```
fn composite_requirement_hook_source_uses_primary_source()
```

**Purpose**: Verifies that composite requirement sources are attributed to their first contributing source. This protects the recursive primary-source rule in requirement-source mapping.

**Data flow**: It constructs a `RequirementSource::Composite` with system and enterprise contributors, calls `hook_source_for_requirement_source`, and asserts that the result is `HookSource::System`.

**Call relations**: This test directly exercises the composite branch of `hook_source_for_requirement_source`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::enterprise_managed_synthetic_path_escapes_display_fields`  (lines 737–749)

```
fn enterprise_managed_synthetic_path_escapes_display_fields()
```

**Purpose**: Checks that enterprise-managed synthetic paths escape XML-sensitive characters in display fields. It prevents raw markup-like characters from leaking into synthetic source paths.

**Data flow**: It constructs an enterprise-managed requirement source with special characters, calls `fallback_managed_hooks_source_path`, converts the result to a display string, and asserts that escaped entities are present while raw text is absent.

**Call relations**: This test targets the `escape_xml_text` path indirectly through `fallback_managed_hooks_source_path`.

*Call graph*: 2 external calls (assert!, fallback_managed_hooks_source_path).


##### `tests::command_group`  (lines 751–762)

```
fn command_group(matcher: Option<&str>) -> MatcherGroup
```

**Purpose**: Creates a one-command matcher group fixture used across matcher-related tests. It standardizes the command payload and optional matcher.

**Data flow**: It takes an optional matcher string, converts it to owned form if present, constructs a `MatcherGroup` containing one `HookHandlerConfig::Command` with `echo hello`, and returns it.

**Call relations**: This helper is used by multiple tests that call `append_matcher_groups` with minimal command-hook fixtures.

*Call graph*: 1 external calls (vec!).


##### `tests::user_prompt_submit_ignores_invalid_matcher_during_discovery`  (lines 765–797)

```
fn user_prompt_submit_ignores_invalid_matcher_during_discovery()
```

**Purpose**: Verifies that `UserPromptSubmit` discovery ignores an invalid matcher rather than warning or dropping the handler. This reflects event-specific matcher semantics.

**Data flow**: It builds empty handler and warning accumulators, a managed source fixture, and a matcher group with an invalid pattern `[`, calls `append_matcher_groups`, and asserts that no warnings were produced and one handler was discovered with `matcher: None`.

**Call relations**: This test directly exercises `append_matcher_groups` and the event-specific matcher normalization path via `matcher_pattern_for_event`.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, hook_handler_source, source_path, new, vec!).


##### `tests::pre_tool_use_keeps_valid_matcher_during_discovery`  (lines 800–832)

```
fn pre_tool_use_keeps_valid_matcher_during_discovery()
```

**Purpose**: Checks that a valid `PreToolUse` matcher survives discovery unchanged. It confirms that valid regex-like matchers are preserved for executable handlers.

**Data flow**: It constructs a managed source and a command group with matcher `^Bash$`, calls `append_matcher_groups`, and asserts that one handler is produced with the same matcher and default timeout.

**Call relations**: This test drives the successful matcher-validation branch of `append_matcher_groups`.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, hook_handler_source, source_path, new, vec!).


##### `tests::bypass_hook_trust_allows_enabled_untrusted_handlers`  (lines 835–862)

```
fn bypass_hook_trust_allows_enabled_untrusted_handlers()
```

**Purpose**: Ensures trust bypass permits execution of enabled unmanaged hooks even when they are untrusted. It distinguishes execution gating from trust-status reporting.

**Data flow**: It creates an unmanaged source fixture with `bypass_hook_trust = true` and no persisted state, calls `append_matcher_groups`, and asserts that both a handler and a hook entry are produced, with `trust_status` `Untrusted` and `enabled` true.

**Call relations**: This test exercises the execution gate inside `append_matcher_groups` where bypass overrides trust but not enablement.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, source_path, unmanaged_hook_handler_source, new, vec!).


##### `tests::bypass_hook_trust_respects_disabled_handlers`  (lines 865–898)

```
fn bypass_hook_trust_respects_disabled_handlers()
```

**Purpose**: Verifies that trust bypass does not override explicit user disablement. Disabled unmanaged hooks should still appear in the hook list but not execute.

**Data flow**: It builds a hook-state map containing `enabled: false` for the expected positional key, creates an unmanaged source with trust bypass enabled, calls `append_matcher_groups`, and asserts that no executable handlers are emitted while one hook entry remains with `enabled` false and `trust_status` `Untrusted`.

**Call relations**: This test targets the interaction between `hook_enabled` and trust bypass inside `append_matcher_groups`.

*Call graph*: calls 1 internal fn (append_matcher_groups); 7 external calls (new, assert_eq!, format!, source_path, unmanaged_hook_handler_source, from, vec!).


##### `tests::pre_tool_use_treats_star_matcher_as_match_all`  (lines 901–921)

```
fn pre_tool_use_treats_star_matcher_as_match_all()
```

**Purpose**: Checks that the special `*` matcher is preserved as a match-all pattern for `PreToolUse`. It confirms discovery does not reject or rewrite this wildcard form.

**Data flow**: It constructs a managed source and a command group with matcher `*`, calls `append_matcher_groups`, and asserts that one handler is produced whose matcher remains `Some("*")`.

**Call relations**: This test exercises the matcher normalization path in `append_matcher_groups` for wildcard tool matching.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, hook_handler_source, source_path, new, vec!).


##### `tests::post_tool_use_keeps_valid_matcher_during_discovery`  (lines 924–945)

```
fn post_tool_use_keeps_valid_matcher_during_discovery()
```

**Purpose**: Verifies that a valid `PostToolUse` matcher is retained during discovery. It mirrors the `PreToolUse` matcher-preservation behavior for another event type.

**Data flow**: It builds a managed source and a command group with matcher `Edit|Write`, calls `append_matcher_groups`, and asserts that one handler is produced with event `PostToolUse` and the same matcher.

**Call relations**: This test covers another successful matcher-validation branch of `append_matcher_groups`.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, hook_handler_source, source_path, new, vec!).


##### `tests::toml_hook_discovery_ignores_malformed_state_entries`  (lines 948–978)

```
fn toml_hook_discovery_ignores_malformed_state_entries()
```

**Purpose**: Confirms that malformed `hooks.state` entries inside a TOML config layer do not prevent valid hook event deserialization. Discovery should load the event hooks cleanly.

**Data flow**: It constructs a `ConfigLayerEntry` whose config contains malformed state plus a valid `SessionStart` command hook, calls `load_toml_hooks_from_layer`, unwraps the returned hooks, and asserts that warnings are empty and the expected `HookEventsToml` was loaded.

**Call relations**: This test directly exercises `load_toml_hooks_from_layer` and demonstrates that hook-event deserialization ignores unrelated malformed state entries.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, assert_eq!, test_path_buf, config_with_malformed_state_and_session_start_hook, load_toml_hooks_from_layer).


##### `tests::pre_tool_use_resolves_windows_command_override_during_discovery`  (lines 981–1017)

```
fn pre_tool_use_resolves_windows_command_override_during_discovery()
```

**Purpose**: Checks that discovery chooses `command_windows` on Windows and the base `command` elsewhere. It validates platform-specific command normalization before execution.

**Data flow**: It constructs a matcher group containing both `command` and `command_windows`, calls `append_matcher_groups`, and asserts that the discovered handler’s `command` matches the platform-appropriate string.

**Call relations**: This test targets the `cfg!(windows)` branch inside `append_matcher_groups`.

*Call graph*: calls 1 internal fn (append_matcher_groups); 6 external calls (new, assert_eq!, hook_handler_source, source_path, new, vec!).


##### `tests::config_with_malformed_state_and_session_start_hook`  (lines 1019–1036)

```
fn config_with_malformed_state_and_session_start_hook() -> TomlValue
```

**Purpose**: Builds a TOML-like fixture containing malformed hook state and one valid session-start command hook. It supports tests that verify tolerant hook-event loading.

**Data flow**: It creates a JSON object with `hooks.state.some_key.enabled = "not a bool"` and a valid `hooks.SessionStart` array, deserializes it into `TomlValue`, and returns the result.

**Call relations**: This helper is used by `tests::toml_hook_discovery_ignores_malformed_state_entries` to feed `load_toml_hooks_from_layer` a mixed-validity config document.

*Call graph*: 2 external calls (from_value, json!).


##### `tests::hook_metadata_for_config_layer_source_discards_source_details`  (lines 1039–1092)

```
fn hook_metadata_for_config_layer_source_discards_source_details()
```

**Purpose**: Verifies that each `ConfigLayerSource` variant maps to the expected coarse `HookSource` and managed flag. It ensures discovery attribution ignores path/detail fields consistently.

**Data flow**: It constructs representative `ConfigLayerSource` values for all variants, calls `hook_metadata_for_config_layer_source` on each, and asserts the returned `(HookSource, bool)` pairs.

**Call relations**: This test directly exercises the source-classification helper used by `discover_handlers`.

*Call graph*: 2 external calls (assert_eq!, test_path_buf).


### `hooks/src/engine/command_runner.rs`

`io_transport` · `hook process execution`

This file is the low-level process runner for command-type hooks. `CommandRunResult` records wall-clock timestamps, elapsed duration, exit code, captured stdout/stderr, and any execution error string. The main async function, `run_command`, timestamps the start, builds a `tokio::process::Command` from the configured shell and handler, sets the working directory, pipes all standard streams, and enables `kill_on_drop` so abandoned children do not linger.

Execution has three major failure points, each converted into a structured `CommandRunResult` instead of raising an exception. If spawning fails, it returns immediately with empty output and an error string. If writing the JSON payload to stdin fails, it attempts to kill the child and returns a specific `failed to write hook stdin` error. Otherwise it waits for completion under `tokio::time::timeout`, returning either captured output, a wait error, or a timeout error mentioning the configured timeout seconds. Durations are measured from `Instant` and saturated to `i64::MAX` if conversion overflows.

`build_command` decides whether to use an explicit shell program or a platform default shell. The default shell is `cmd.exe /C` on Windows, using `COMSPEC` when available, and `$SHELL -lc` on non-Windows, defaulting to `/bin/sh`.

#### Function details

##### `run_command`  (lines 24–101)

```
async fn run_command(
    shell: &CommandShell,
    handler: &ConfiguredHandler,
    input_json: &str,
    cwd: &Path,
) -> CommandRunResult
```

**Purpose**: Runs one configured hook command in a child process, feeds it the JSON request on stdin, and returns a fully populated execution record. It normalizes spawn, stdin-write, wait, and timeout failures into `CommandRunResult` values.

**Data flow**: Inputs are a `CommandShell`, a `ConfiguredHandler`, the serialized `input_json`, and a working directory path. It records start timestamps, builds a `Command`, configures cwd and piped stdio, spawns the child, optionally writes `input_json` bytes to stdin, then waits for output under a timeout derived from `handler.timeout_sec`. It returns a `CommandRunResult` containing timestamps, elapsed milliseconds, exit code and decoded stdout/stderr on success, or empty outputs plus an error string on failure.

**Call relations**: This async runner is called by `execute_handlers` for each selected hook. It delegates command construction to `build_command`, and its control flow branches on spawn failure, stdin write failure, successful completion, wait failure, or timeout.

*Call graph*: calls 1 internal fn (build_command); called by 1 (execute_handlers); 8 external calls (from_secs, now, piped, from_utf8_lossy, new, now, format!, timeout).


##### `build_command`  (lines 103–117)

```
fn build_command(shell: &CommandShell, handler: &ConfiguredHandler) -> Command
```

**Purpose**: Constructs the `tokio::process::Command` used to execute a hook command string under either an explicit shell or the platform default shell. It also injects the handler’s environment variables.

**Data flow**: It reads `shell.program`, `shell.args`, `handler.command`, and `handler.env`. If `shell.program` is empty it starts from `default_shell_command()` and appends only the command string; otherwise it creates a command for `shell.program`, appends `shell.args`, then the command string, and finally applies `handler.env` via `envs`. It returns the configured `Command` object.

**Call relations**: This helper is only called by `run_command`. It encapsulates the shell-selection branch so process execution code can focus on spawning and I/O.

*Call graph*: calls 1 internal fn (default_shell_command); called by 1 (run_command); 1 external calls (new).


##### `default_shell_command`  (lines 119–135)

```
fn default_shell_command() -> Command
```

**Purpose**: Builds the fallback shell invocation used when no explicit shell program is configured. It chooses a conventional command interpreter and the argument needed to execute a command string.

**Data flow**: On Windows it reads `COMSPEC` or falls back to `cmd.exe`, creates a `Command`, and appends `/C`. On non-Windows it reads `SHELL` or falls back to `/bin/sh`, creates a `Command`, and appends `-lc`. It returns the prepared `Command`.

**Call relations**: This helper is called by `build_command` when the configured shell program is empty. Its sole role is to centralize platform-specific default shell selection.

*Call graph*: called by 1 (build_command); 2 external calls (new, var).


### `hooks/src/engine/output_parser.rs`

`domain_logic` · `hook stdout parsing during request handling and hook completion processing`

This file is the hook engine’s stdout interpretation layer. It defines small internal result structs such as `UniversalOutput`, `PreToolUseOutput`, `PermissionRequestOutput`, `PostToolUseOutput`, `StopOutput`, and compact/stateless variants, then provides one parser per hook event that deserializes event-specific wire schemas from `crate::schema`. The parsers all start from `parse_json`, which trims stdout, rejects empty or non-object JSON, and deserializes into the requested wire type.

The important logic is not just deserialization but policy validation. `parse_pre_tool_use` supports both legacy `decision/reason` and newer hook-specific permission decisions, but rejects unsupported combinations like `permissionDecision:ask`, `allow` without `updatedInput`, `updatedInput` without `allow`, or universal fields such as `continue:false` and `suppressOutput`. `parse_permission_request` similarly rejects reserved fields like `updatedInput`, `updatedPermissions`, and `interrupt`. `parse_post_tool_use`, `parse_user_prompt_submit`, and stop parsers validate that `decision:block` includes a non-empty reason. Universal fields are normalized through `UniversalOutput::from`, preserving `continue`, `stop_reason`, `suppress_output`, and `system_message` for later event-specific handling.

A key design choice is fail-open parsing: unsupported semantics become `invalid_reason` strings rather than panics, letting callers mark runs failed while preserving transcript-visible output. The embedded tests focus on reserved-field rejection for permission-request hooks.

#### Function details

##### `parse_session_start`  (lines 93–100)

```
fn parse_session_start(stdout: &str) -> Option<SessionStartOutput>
```

**Purpose**: Parses stdout for a `SessionStart` hook into `SessionStartOutput`. It extracts universal fields plus optional `additional_context` from hook-specific output.

**Data flow**: Takes raw stdout text → `parse_json` deserializes it into `SessionStartCommandOutputWire` or returns `None` → passes `wire.universal` and optional `hook_specific_output.additional_context` into `session_start_output` → returns `Some(SessionStartOutput)` or `None`.

**Call relations**: Called by higher-level completion parsing for session-start hooks after a command exits successfully and stdout appears JSON-like.

*Call graph*: calls 2 internal fn (parse_json, session_start_output); called by 1 (parse_completed).


##### `parse_subagent_start`  (lines 102–109)

```
fn parse_subagent_start(stdout: &str) -> Option<SessionStartOutput>
```

**Purpose**: Parses stdout for a `SubagentStart` hook using the same shape as session-start output. It reuses the same internal constructor to keep semantics aligned.

**Data flow**: Reads stdout → deserializes to `SubagentStartCommandOutputWire` via `parse_json` → extracts universal fields and optional `additional_context` → returns `SessionStartOutput` wrapped in `Some`, or `None` if parsing fails.

**Call relations**: Invoked by the generic completion path for subagent-start hooks; it delegates final struct assembly to `session_start_output`.

*Call graph*: calls 2 internal fn (parse_json, session_start_output); called by 1 (parse_completed).


##### `session_start_output`  (lines 111–119)

```
fn session_start_output(
    universal: HookUniversalOutputWire,
    additional_context: Option<String>,
) -> SessionStartOutput
```

**Purpose**: Builds a `SessionStartOutput` from already-deserialized universal and hook-specific pieces. It is a shared constructor for session and subagent start events.

**Data flow**: Accepts `HookUniversalOutputWire` and optional additional-context string → converts the universal wire via `UniversalOutput::from` → returns `SessionStartOutput { universal, additional_context }`.

**Call relations**: Used only by `parse_session_start` and `parse_subagent_start` to avoid duplicating the same mapping logic.

*Call graph*: calls 1 internal fn (from); called by 2 (parse_session_start, parse_subagent_start).


##### `parse_pre_tool_use`  (lines 121–182)

```
fn parse_pre_tool_use(stdout: &str) -> Option<PreToolUseOutput>
```

**Purpose**: Parses `PreToolUse` stdout and resolves whether it represents a block, an input rewrite, additional context, or an invalid unsupported response. It supports both legacy and newer permission-decision formats.

**Data flow**: Deserializes stdout into `PreToolUseCommandOutputWire` → converts universal fields → inspects `hook_specific_output` to decide whether to interpret the response via hook-specific permission fields or legacy `decision/reason` → computes `invalid_reason` using universal and event-specific validators → if valid, derives `block_reason` for deny/block cases and `updated_input` only for `permissionDecision:allow` with `updatedInput` → returns `PreToolUseOutput` containing universal data, optional context, block reason, updated input, and invalid reason.

**Call relations**: Called by pre-tool-use completion handling after a hook exits with code 0. It delegates validation to `unsupported_pre_tool_use_universal`, `unsupported_pre_tool_use_hook_specific_output`, and `unsupported_pre_tool_use_legacy_decision`.

*Call graph*: calls 3 internal fn (from, parse_json, unsupported_pre_tool_use_universal); called by 1 (parse_completed).


##### `parse_permission_request`  (lines 184–205)

```
fn parse_permission_request(stdout: &str) -> Option<PermissionRequestOutput>
```

**Purpose**: Parses `PermissionRequest` stdout into a normalized decision or an invalid-reason failure. It only accepts a narrow subset of the wire schema.

**Data flow**: Deserializes stdout into `PermissionRequestCommandOutputWire` → converts universal fields → reads optional hook-specific decision → computes `invalid_reason` from unsupported universal fields or unsupported decision subfields → if valid, maps the wire decision into internal `PermissionRequestDecision` via `permission_request_decision` → returns `PermissionRequestOutput`.

**Call relations**: Used by permission-request completion parsing and directly by unit tests that verify reserved fields are rejected.

*Call graph*: calls 3 internal fn (from, parse_json, unsupported_permission_request_universal); called by 4 (permission_request_rejects_reserved_interrupt_field, permission_request_rejects_reserved_updated_input_field, permission_request_rejects_reserved_updated_permissions_field, parse_completed).


##### `parse_post_tool_use`  (lines 207–239)

```
fn parse_post_tool_use(stdout: &str) -> Option<PostToolUseOutput>
```

**Purpose**: Parses `PostToolUse` stdout, validating stop/block semantics and extracting optional additional context. It distinguishes unsupported output from a valid block decision with feedback.

**Data flow**: Deserializes stdout into `PostToolUseCommandOutputWire` → converts universal fields → computes `invalid_reason` from unsupported universal or hook-specific fields → derives `should_block` from `decision == Block`, then computes `invalid_block_reason` if a block lacks a non-empty reason or if a reason appears without a decision while processing continues → extracts optional `additional_context` → returns `PostToolUseOutput` with block flag suppressed when invalid.

**Call relations**: Called by post-tool-use completion handling; it relies on `unsupported_post_tool_use_universal`, `unsupported_post_tool_use_hook_specific_output`, and `invalid_block_message`.

*Call graph*: calls 4 internal fn (from, invalid_block_message, parse_json, unsupported_post_tool_use_universal); called by 1 (parse_completed); 1 external calls (matches!).


##### `parse_pre_compact`  (lines 241–248)

```
fn parse_pre_compact(stdout: &str) -> Option<PreCompactOutput>
```

**Purpose**: Parses `PreCompact` stdout into a minimal output carrying only universal fields. No event-specific validation is currently applied.

**Data flow**: Deserializes stdout into `PreCompactCommandOutputWire` → converts `wire.universal` via `UniversalOutput::from` → returns `PreCompactOutput { universal, invalid_reason: None }`.

**Call relations**: Used by compact-event completion parsing for pre-compact hooks.

*Call graph*: calls 2 internal fn (from, parse_json); called by 1 (parse_pre_completed).


##### `parse_post_compact`  (lines 250–257)

```
fn parse_post_compact(stdout: &str) -> Option<StatelessHookOutput>
```

**Purpose**: Parses `PostCompact` stdout into a stateless output with universal fields only. It mirrors `parse_pre_compact` for the post phase.

**Data flow**: Deserializes stdout into `PostCompactCommandOutputWire` → converts universal fields → returns `StatelessHookOutput { universal, invalid_reason: None }`.

**Call relations**: Used by compact-event completion parsing for post-compact hooks.

*Call graph*: calls 2 internal fn (from, parse_json).


##### `parse_user_prompt_submit`  (lines 259–281)

```
fn parse_user_prompt_submit(stdout: &str) -> Option<UserPromptSubmitOutput>
```

**Purpose**: Parses `UserPromptSubmit` stdout and validates optional block decisions. It supports additional context but requires a non-empty reason when blocking.

**Data flow**: Deserializes stdout into `UserPromptSubmitCommandOutputWire` → computes `should_block` from `decision` → computes `invalid_block_reason` if block lacks a non-empty reason → extracts optional `additional_context` → returns `UserPromptSubmitOutput` with universal fields and a block flag only when valid.

**Call relations**: Called by generic completion parsing for user-prompt-submit hooks.

*Call graph*: calls 3 internal fn (from, invalid_block_message, parse_json); called by 1 (parse_completed); 1 external calls (matches!).


##### `parse_stop`  (lines 283–291)

```
fn parse_stop(stdout: &str) -> Option<StopOutput>
```

**Purpose**: Parses `Stop` hook stdout into a normalized `StopOutput`. It delegates shared stop-event validation to `stop_output`.

**Data flow**: Deserializes stdout into `StopCommandOutputWire` → passes universal fields, decision, reason, and event label `Stop` to `stop_output` → returns the resulting `StopOutput`.

**Call relations**: Used by stop-event completion handling and shares logic with subagent-stop parsing.

*Call graph*: calls 2 internal fn (parse_json, stop_output); called by 1 (parse_completed).


##### `parse_subagent_stop`  (lines 293–301)

```
fn parse_subagent_stop(stdout: &str) -> Option<StopOutput>
```

**Purpose**: Parses `SubagentStop` hook stdout using the same stop-event rules as `parse_stop`. The only difference is the event label used in error text.

**Data flow**: Deserializes stdout into `SubagentStopCommandOutputWire` → forwards universal fields, decision, reason, and label `SubagentStop` to `stop_output` → returns `StopOutput`.

**Call relations**: Called by subagent-stop completion handling and reuses the common stop parser helper.

*Call graph*: calls 2 internal fn (parse_json, stop_output); called by 1 (parse_completed).


##### `stop_output`  (lines 303–325)

```
fn stop_output(
    universal: HookUniversalOutputWire,
    decision: Option<BlockDecisionWire>,
    reason: Option<String>,
    event_name: &str,
) -> StopOutput
```

**Purpose**: Constructs a `StopOutput` and validates that `decision:block` includes a non-empty reason. It centralizes stop-event semantics for both stop variants.

**Data flow**: Accepts universal wire fields, optional `BlockDecisionWire`, optional reason, and event name → computes `should_block` from the decision → if blocking without a trimmed reason, sets `invalid_block_reason` using `invalid_block_message` → converts universal fields and returns `StopOutput` with block flag disabled when invalid.

**Call relations**: Used by `parse_stop` and `parse_subagent_stop` so both events enforce identical block-reason rules.

*Call graph*: calls 2 internal fn (from, invalid_block_message); called by 2 (parse_stop, parse_subagent_stop); 1 external calls (matches!).


##### `UniversalOutput::from`  (lines 328–335)

```
fn from(value: HookUniversalOutputWire) -> Self
```

**Purpose**: Maps the wire-level universal hook output fields into the engine’s internal representation. It is a straightforward field rename/normalization step.

**Data flow**: Consumes `HookUniversalOutputWire` → copies `continue` into `continue_processing`, `stop_reason`, `suppress_output`, and `system_message` into a new `UniversalOutput` → returns it.

**Call relations**: Called by nearly every event parser as the first normalization step after JSON deserialization.

*Call graph*: called by 8 (parse_permission_request, parse_post_compact, parse_post_tool_use, parse_pre_compact, parse_pre_tool_use, parse_user_prompt_submit, session_start_output, stop_output).


##### `parse_json`  (lines 338–351)

```
fn parse_json(stdout: &str) -> Option<T>
```

**Purpose**: Shared helper that parses stdout into a typed wire struct only when the content is non-empty JSON object text. It intentionally rejects arrays, scalars, and blank output.

**Data flow**: Takes stdout string → trims whitespace; returns `None` if empty → parses into `serde_json::Value`; returns `None` on parse failure → checks `value.is_object()`; returns `None` if not → deserializes the value into generic `T` and returns `Some(T)` on success.

**Call relations**: This is the common entry point for all event-specific parsers, allowing callers to distinguish plain text/no output from structured hook JSON.

*Call graph*: called by 10 (parse_permission_request, parse_post_compact, parse_post_tool_use, parse_pre_compact, parse_pre_tool_use, parse_session_start, parse_stop, parse_subagent_start, parse_subagent_stop, parse_user_prompt_submit); 2 external calls (from_str, from_value).


##### `looks_like_json`  (lines 353–356)

```
fn looks_like_json(stdout: &str) -> bool
```

**Purpose**: Heuristically detects whether stdout begins like JSON so callers can treat malformed JSON-like output as an error instead of a no-op. It is intentionally shallow and cheap.

**Data flow**: Reads stdout, trims only leading whitespace → checks whether the first non-space character is `{` or `[` → returns a boolean.

**Call relations**: Used by completion parsers after `parse_json` fails, to decide whether to emit an invalid-JSON error entry.

*Call graph*: called by 7 (parse_completed, parse_pre_completed, parse_completed, parse_completed, parse_completed, parse_completed, parse_completed).


##### `invalid_block_message`  (lines 358–360)

```
fn invalid_block_message(event_name: &str) -> String
```

**Purpose**: Formats the standard error message for block decisions that omit a non-empty reason. It keeps wording consistent across events.

**Data flow**: Takes an event name string → interpolates it into `"{event_name} hook returned decision:block without a non-empty reason"` → returns the message.

**Call relations**: Called by post-tool-use, user-prompt-submit, stop-output, and legacy pre-tool-use validation paths.

*Call graph*: called by 4 (parse_post_tool_use, parse_user_prompt_submit, stop_output, unsupported_pre_tool_use_legacy_decision); 1 external calls (format!).


##### `unsupported_pre_tool_use_universal`  (lines 362–372)

```
fn unsupported_pre_tool_use_universal(universal: &UniversalOutput) -> Option<String>
```

**Purpose**: Rejects universal output fields that `PreToolUse` does not support. This prevents hooks from using stop/suppress semantics reserved for other events.

**Data flow**: Reads a `UniversalOutput` → if `continue_processing` is false, returns an unsupported-continue message; else if `stop_reason` is present, returns unsupported-stopReason; else if `suppress_output` is true, returns unsupported-suppressOutput; otherwise returns `None`.

**Call relations**: Called first by `parse_pre_tool_use` before event-specific decision validation.

*Call graph*: called by 1 (parse_pre_tool_use).


##### `unsupported_permission_request_universal`  (lines 374–384)

```
fn unsupported_permission_request_universal(universal: &UniversalOutput) -> Option<String>
```

**Purpose**: Rejects unsupported universal fields for `PermissionRequest` hooks. The event cannot stop processing or suppress output through universal controls.

**Data flow**: Inspects `UniversalOutput` in priority order: `continue_processing == false`, then `stop_reason.is_some()`, then `suppress_output` → returns the corresponding error string or `None`.

**Call relations**: Used by `parse_permission_request` before checking hook-specific decision fields.

*Call graph*: called by 1 (parse_permission_request).


##### `unsupported_post_tool_use_universal`  (lines 386–392)

```
fn unsupported_post_tool_use_universal(universal: &UniversalOutput) -> Option<String>
```

**Purpose**: Rejects the one universal field currently unsupported for `PostToolUse`: `suppressOutput`. Other universal fields remain meaningful for this event.

**Data flow**: Checks `universal.suppress_output` → returns an unsupported-suppressOutput message if true, else `None`.

**Call relations**: Called by `parse_post_tool_use` as part of invalid-reason computation.

*Call graph*: called by 1 (parse_post_tool_use).


##### `unsupported_permission_request_hook_specific_output`  (lines 394–407)

```
fn unsupported_permission_request_hook_specific_output(
    decision: Option<&PermissionRequestDecisionWire>,
) -> Option<String>
```

**Purpose**: Rejects reserved decision subfields that permission-request hooks are not allowed to use. This keeps the event limited to allow/deny behavior.

**Data flow**: Takes an optional borrowed `PermissionRequestDecisionWire` → returns `None` if absent → otherwise checks `updated_input`, `updated_permissions`, and `interrupt` in order and returns the first corresponding unsupported-field message, or `None` if none are set.

**Call relations**: Used internally by `parse_permission_request` when hook-specific output is present.


##### `permission_request_decision`  (lines 409–422)

```
fn permission_request_decision(
    decision: &PermissionRequestDecisionWire,
) -> PermissionRequestDecision
```

**Purpose**: Converts a valid wire-level permission decision into the internal enum used by event execution code. Deny decisions get a normalized fallback message when none is supplied.

**Data flow**: Reads `decision.behavior` → returns `PermissionRequestDecision::Allow` for `Allow`; for `Deny`, trims `decision.message` via `trimmed_reason` and uses it if present, otherwise falls back to `PermissionRequest hook denied approval` → returns the internal decision.

**Call relations**: Called by `parse_permission_request` only after unsupported-field validation passes.


##### `unsupported_post_tool_use_hook_specific_output`  (lines 424–432)

```
fn unsupported_post_tool_use_hook_specific_output(
    output: &crate::schema::PostToolUseHookSpecificOutputWire,
) -> Option<String>
```

**Purpose**: Rejects unsupported hook-specific fields for `PostToolUse`, currently `updatedMCPToolOutput`. The event may annotate or block, but not rewrite tool output.

**Data flow**: Inspects `PostToolUseHookSpecificOutputWire` → if `updated_mcp_tool_output` is present, returns an unsupported-field message; otherwise returns `None`.

**Call relations**: Used by `parse_post_tool_use` as part of invalid-reason detection.


##### `unsupported_pre_tool_use_hook_specific_output`  (lines 434–475)

```
fn unsupported_pre_tool_use_hook_specific_output(
    output: &crate::schema::PreToolUseHookSpecificOutputWire,
) -> Option<String>
```

**Purpose**: Validates the newer hook-specific `PreToolUse` permission-decision format and rejects unsupported or inconsistent combinations. It encodes the event’s rewrite/block contract in one place.

**Data flow**: Reads `PreToolUseHookSpecificOutputWire` → first rejects `updated_input` unless `permission_decision` is `Allow` → then matches on `permission_decision`: `Allow` requires `updated_input`; `Ask` is always unsupported; `Deny` requires a non-empty trimmed `permission_decision_reason`; `None` rejects a stray `permission_decision_reason` but otherwise allows absence → returns an explanatory `Option<String>`.

**Call relations**: Called by `parse_pre_tool_use` when hook-specific decision fields are in play; it uses `invalid_pre_tool_use_reason_message` for the deny-without-reason case.

*Call graph*: calls 1 internal fn (invalid_pre_tool_use_reason_message); 1 external calls (matches!).


##### `unsupported_pre_tool_use_legacy_decision`  (lines 477–500)

```
fn unsupported_pre_tool_use_legacy_decision(
    decision: Option<&PreToolUseDecisionWire>,
    reason: Option<&str>,
) -> Option<String>
```

**Purpose**: Validates the deprecated legacy `decision/reason` format for `PreToolUse`. Only `block` with a non-empty reason is accepted; `approve` and stray reasons are rejected.

**Data flow**: Takes optional `PreToolUseDecisionWire` and optional reason string → returns unsupported-approve for `Approve`; for `Block`, requires `trimmed_reason(reason)` and otherwise returns `invalid_block_message("PreToolUse")`; for `None`, rejects `reason` without decision and otherwise returns `None`.

**Call relations**: Used by `parse_pre_tool_use` when no hook-specific permission decision fields are present.

*Call graph*: calls 1 internal fn (invalid_block_message).


##### `invalid_pre_tool_use_reason_message`  (lines 502–505)

```
fn invalid_pre_tool_use_reason_message() -> String
```

**Purpose**: Provides the canonical error text for `permissionDecision:deny` without a non-empty `permissionDecisionReason`. It keeps this specific validation message centralized.

**Data flow**: Returns a fixed `String` literal describing the missing deny reason requirement.

**Call relations**: Called only from `unsupported_pre_tool_use_hook_specific_output`.

*Call graph*: called by 1 (unsupported_pre_tool_use_hook_specific_output).


##### `trimmed_reason`  (lines 507–514)

```
fn trimmed_reason(reason: &str) -> Option<String>
```

**Purpose**: Normalizes optional human-readable reason strings by trimming whitespace and discarding empty results. It prevents blank strings from counting as valid reasons.

**Data flow**: Takes `&str` → trims leading/trailing whitespace → returns `None` if the trimmed string is empty, otherwise returns `Some(trimmed.to_string())`.

**Call relations**: Used throughout decision validation and message normalization for pre-tool-use and permission-request parsing.


##### `tests::permission_request_rejects_reserved_updated_input_field`  (lines 524–544)

```
fn permission_request_rejects_reserved_updated_input_field()
```

**Purpose**: Tests that a permission-request hook output containing `decision.updatedInput` is parsed but marked invalid. This protects a reserved field from being silently accepted.

**Data flow**: Builds JSON stdout with `updatedInput` using `json!` → calls `parse_permission_request` → asserts the returned `invalid_reason` equals the expected unsupported-field message.

**Call relations**: Directly exercises `parse_permission_request`’s hook-specific validation branch.

*Call graph*: calls 1 internal fn (parse_permission_request); 2 external calls (assert_eq!, json!).


##### `tests::permission_request_rejects_reserved_updated_permissions_field`  (lines 547–567)

```
fn permission_request_rejects_reserved_updated_permissions_field()
```

**Purpose**: Tests that `decision.updatedPermissions` is rejected for permission-request hooks. The parser must surface a specific invalid-reason string.

**Data flow**: Constructs JSON stdout containing `updatedPermissions` → parses it → asserts `invalid_reason` matches the unsupported updated-permissions message.

**Call relations**: Covers another reserved-field branch inside `unsupported_permission_request_hook_specific_output` via `parse_permission_request`.

*Call graph*: calls 1 internal fn (parse_permission_request); 2 external calls (assert_eq!, json!).


##### `tests::permission_request_rejects_reserved_interrupt_field`  (lines 570–590)

```
fn permission_request_rejects_reserved_interrupt_field()
```

**Purpose**: Tests that `decision.interrupt: true` is rejected for permission-request hooks. This ensures unsupported control-flow semantics are not accepted.

**Data flow**: Creates JSON stdout with `interrupt: true` → calls `parse_permission_request` → asserts the parser returns the expected invalid-reason string.

**Call relations**: Exercises the final reserved-field validation branch in permission-request parsing.

*Call graph*: calls 1 internal fn (parse_permission_request); 2 external calls (assert_eq!, json!).


### `hooks/src/output_spill.rs`

`util` · `post-hook output processing`

This file encapsulates the policy for limiting hook-generated text that is surfaced back to the model. `HookOutputSpiller` stores a base output directory under the OS temp directory, specifically `<temp>/hook_outputs`. The token budget is fixed by `HOOK_OUTPUT_TOKEN_LIMIT` at 2,500 tokens.

`HookOutputSpiller::maybe_spill_text` is the core routine. It first estimates token count with `approx_token_count`; if the text is already within budget, it returns the original string unchanged. Otherwise it computes a unique spill path under `<output_dir>/<thread_id>/<uuid>.txt` using `hook_output_path`. It then attempts to create the parent directory and write the full text asynchronously with `tokio::fs`. Any filesystem failure is logged with `tracing::warn!`, and the function falls back to an inline truncated preview using `formatted_truncate_text` with a token-based truncation policy.

When spilling succeeds, the visible replacement is generated by `spilled_hook_output_preview`. A footer containing the recovery path is budgeted before truncation, so the preview plus footer still fits within the same token limit. The helper methods `maybe_spill_texts` and `maybe_spill_prompt_fragments` apply the same policy across vectors of raw strings or `HookPromptFragment`s, preserving fragment `hook_run_id`s while rewriting only the text. The design intentionally favors graceful degradation: callers always receive usable text even if the spill directory cannot be created or written.

#### Function details

##### `HookOutputSpiller::new`  (lines 20–25)

```
fn new() -> Self
```

**Purpose**: Constructs a spiller rooted at the process temp directory under a fixed `hook_outputs` subdirectory.

**Data flow**: Calls `std::env::temp_dir()` to get the OS temp path, resolves it against `/` into an `AbsolutePathBuf`, joins `HOOK_OUTPUTS_DIR`, and returns `HookOutputSpiller { output_dir }`.

**Call relations**: Used by higher-level hook execution code when a default spill location is needed.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 1 (new); 1 external calls (temp_dir).


##### `HookOutputSpiller::maybe_spill_text`  (lines 33–61)

```
async fn maybe_spill_text(&self, thread_id: ThreadId, text: String) -> String
```

**Purpose**: Returns hook text inline when small enough, or writes the full text to disk and returns a truncated preview plus recovery path when it exceeds the token budget.

**Data flow**: Consumes `thread_id` and an owned `text`. It estimates token count; if within `HOOK_OUTPUT_TOKEN_LIMIT`, it returns `text` unchanged. Otherwise it computes a unique file path with `hook_output_path`, attempts `fs::create_dir_all` on the parent directory, and on failure logs a warning and returns `formatted_truncate_text(text, Tokens(limit))`. If directory creation succeeds, it attempts `fs::write` of the full text; write failure follows the same warning-plus-inline-truncation fallback. On success it returns `spilled_hook_output_preview(&text, &path)`.

**Call relations**: This is the core primitive called by the batch helpers `maybe_spill_texts` and `maybe_spill_prompt_fragments`.

*Call graph*: calls 2 internal fn (hook_output_path, spilled_hook_output_preview); called by 3 (maybe_spill_text, maybe_spill_prompt_fragments, maybe_spill_texts); 6 external calls (approx_token_count, formatted_truncate_text, create_dir_all, write, Tokens, warn!).


##### `HookOutputSpiller::maybe_spill_texts`  (lines 63–73)

```
async fn maybe_spill_texts(
        &self,
        thread_id: ThreadId,
        texts: Vec<String>,
    ) -> Vec<String>
```

**Purpose**: Applies spill-or-inline logic to a batch of plain hook-output strings.

**Data flow**: Accepts a `thread_id` and `Vec<String>`, preallocates an output vector with matching capacity, iterates through each text, awaits `maybe_spill_text(thread_id, text)`, pushes the result, and returns the transformed vector.

**Call relations**: Used when callers need to process multiple context strings with the same spill policy.

*Call graph*: calls 1 internal fn (maybe_spill_text); called by 1 (maybe_spill_texts); 1 external calls (with_capacity).


##### `HookOutputSpiller::maybe_spill_prompt_fragments`  (lines 75–88)

```
async fn maybe_spill_prompt_fragments(
        &self,
        thread_id: ThreadId,
        fragments: Vec<HookPromptFragment>,
    ) -> Vec<HookPromptFragment>
```

**Purpose**: Applies spill-or-inline logic to prompt fragments while preserving their originating hook run ids.

**Data flow**: Accepts a `thread_id` and `Vec<HookPromptFragment>`, preallocates an output vector, iterates through fragments, rewrites each fragment's `text` by awaiting `maybe_spill_text(thread_id, fragment.text)`, keeps `hook_run_id` unchanged, and returns the rebuilt fragment vector.

**Call relations**: Used when blocked-stop continuation prompts need the same token-budget enforcement as ordinary hook text.

*Call graph*: calls 1 internal fn (maybe_spill_text); called by 1 (maybe_spill_prompt_fragments); 1 external calls (with_capacity).


##### `hook_output_path`  (lines 91–95)

```
fn hook_output_path(output_dir: &AbsolutePathBuf, thread_id: ThreadId) -> AbsolutePathBuf
```

**Purpose**: Builds a unique spill-file path for one oversized hook output under the thread-specific directory.

**Data flow**: Takes the base `output_dir` and a `ThreadId`, converts the thread id to string, appends it as a directory, appends a randomly generated `Uuid::new_v4()` filename with `.txt`, and returns the resulting `AbsolutePathBuf`.

**Call relations**: Called only by `HookOutputSpiller::maybe_spill_text` when a spill is required.

*Call graph*: calls 1 internal fn (join); called by 1 (maybe_spill_text); 2 external calls (format!, to_string).


##### `spilled_hook_output_preview`  (lines 101–107)

```
fn spilled_hook_output_preview(text: &str, path: &AbsolutePathBuf) -> String
```

**Purpose**: Creates the model-visible replacement text for a spilled output, ensuring the preview plus footer still fits the token budget.

**Data flow**: Accepts the original `text` and spill `path`, formats a footer `"\n\nFull hook output saved to: ..."`, estimates the footer token cost with `approx_token_count`, subtracts that from `HOOK_OUTPUT_TOKEN_LIMIT` using `saturating_sub`, truncates the original text with `formatted_truncate_text` under the reduced token budget, and concatenates the footer. Returns the final preview string.

**Call relations**: Used by `HookOutputSpiller::maybe_spill_text` only after the full output has been successfully written to disk.

*Call graph*: called by 1 (maybe_spill_text); 3 external calls (approx_token_count, format!, Tokens).


### `hooks/src/engine/dispatcher.rs`

`orchestration` · `per-event handler selection and execution`

This file sits between discovered hook configuration and event-specific parsing logic. `select_handlers` and `select_handlers_for_matcher_inputs` filter a slice of `ConfiguredHandler` by `HookEventName` and matcher semantics. For tool-like and compact/session events, handlers are kept only if their matcher matches at least one provided input; if no matcher inputs are supplied, matching is evaluated against `None`. For `UserPromptSubmit` and `Stop`, matcher values are ignored and all handlers for the event are selected. A key design choice is that each handler is checked once even when multiple compatibility names are supplied, so one handler with a regex like `apply_patch|Write|Edit` runs only once per tool call.

`execute_handlers` runs the selected handlers concurrently using `FuturesUnordered`. It clones the shared JSON input and optional turn ID per task, invokes `run_command`, parses each result through a caller-supplied function, records completion order as tasks finish, then sorts the final vector back into original configured order before returning it. This preserves declaration order for downstream semantics while still exposing completion order in each `ParsedHandler`.

The summary helpers, `running_summary` and `completed_summary`, construct `HookRunSummary` values with consistent IDs, scope, source metadata, timestamps, and output entries. `scope_for_event` maps session-start/subagent-start to thread scope and all other supported events to turn scope.

#### Function details

##### `select_handlers`  (lines 27–34)

```
fn select_handlers(
    handlers: &[ConfiguredHandler],
    event_name: HookEventName,
    matcher_input: Option<&str>,
) -> Vec<ConfiguredHandler>
```

**Purpose**: Convenience wrapper that selects handlers for a single optional matcher input. It adapts the single-input API to the multi-input matcher-selection routine.

**Data flow**: It takes a handler slice, event name, and optional matcher input. It converts the optional input into a temporary `Vec<&str>` and passes that slice to `select_handlers_for_matcher_inputs`, returning the resulting cloned handlers.

**Call relations**: This function is used by many event preview/run paths and tests that only have one matcher input. It delegates all actual filtering logic to `select_handlers_for_matcher_inputs`.

*Call graph*: calls 1 internal fn (select_handlers_for_matcher_inputs); called by 19 (compact_hooks_match_trigger, post_tool_use_matches_tool_name, pre_tool_use_matches_tool_name, pre_tool_use_regex_alternation_matches_each_tool_name, pre_tool_use_star_matcher_matches_all_tools, select_handlers_keeps_duplicate_stop_handlers, select_handlers_keeps_overlapping_session_start_matchers, select_handlers_preserves_declaration_order, user_prompt_submit_ignores_matcher, preview_post (+9 more)).


##### `select_handlers_for_matcher_inputs`  (lines 36–68)

```
fn select_handlers_for_matcher_inputs(
    handlers: &[ConfiguredHandler],
    event_name: HookEventName,
    matcher_inputs: &[&str],
) -> Vec<ConfiguredHandler>
```

**Purpose**: Filters discovered handlers down to those applicable for a given event and one or more matcher inputs. It preserves declaration order and avoids duplicate execution when multiple inputs match the same handler.

**Data flow**: Inputs are a slice of `ConfiguredHandler`, a `HookEventName`, and a slice of matcher input strings. It iterates handlers, keeps only those with the requested event name, applies event-specific matcher logic using `matches_matcher`, clones the surviving handlers, and collects them into a `Vec<ConfiguredHandler>` in original order.

**Call relations**: This is the core selection routine called by `select_handlers` and by event code that supplies multiple compatibility names. Its filtering semantics are consumed later by preview and run flows before `execute_handlers` is invoked.

*Call graph*: called by 8 (select_handlers, pre_tool_use_aliases_match_once_per_handler, preview, run, preview, run, preview, run); 1 external calls (iter).


##### `running_summary`  (lines 70–87)

```
fn running_summary(handler: &ConfiguredHandler) -> HookRunSummary
```

**Purpose**: Builds a protocol summary representing a hook that has started execution but not yet completed. It fills in static handler metadata and a current start timestamp.

**Data flow**: It reads fields from a `ConfiguredHandler`, computes a stable run ID with `run_id()`, derives scope with `scope_for_event`, stamps `started_at` with the current UTC timestamp, and returns a `HookRunSummary` with `status` set to `Running`, no completion time, no duration, and an empty `entries` list.

**Call relations**: This helper is used by higher-level event preview/run code when reporting in-flight hook execution. It depends on `ConfiguredHandler::run_id` and `scope_for_event` for consistent protocol metadata.

*Call graph*: calls 2 internal fn (run_id, scope_for_event); 2 external calls (new, now).


##### `execute_handlers`  (lines 89–116)

```
async fn execute_handlers(
    shell: &CommandShell,
    handlers: Vec<ConfiguredHandler>,
    input_json: String,
    cwd: &Path,
    turn_id: Option<String>,
    parse: fn(&ConfiguredHandler, Comman
```

**Purpose**: Runs a batch of configured handlers concurrently, parses each command result, records completion order, and returns parsed results in original configured order. It separates execution concurrency from externally visible ordering.

**Data flow**: Inputs are the shell configuration, a vector of handlers, serialized input JSON, working directory, optional turn ID, and a parse callback. It enumerates handlers to capture configured order, clones `input_json` and `turn_id` into async tasks, runs each handler via `run_command`, transforms each result with `parse`, assigns `completion_order` as futures resolve, sorts completed items by original configured order, and returns the parsed vector.

**Call relations**: This async orchestrator is called by multiple event-specific `run` implementations. It delegates process execution to `run_command` and leaves event-specific interpretation of command output to the supplied parse function.

*Call graph*: calls 1 internal fn (run_command); called by 8 (run_post, run_pre, run, run, run, run, run, run); 2 external calls (new, new).


##### `completed_summary`  (lines 118–140)

```
fn completed_summary(
    handler: &ConfiguredHandler,
    run_result: &CommandRunResult,
    status: HookRunStatus,
    entries: Vec<codex_protocol::protocol::HookOutputEntry>,
) -> HookRunSummary
```

**Purpose**: Builds a protocol summary for a finished hook execution using the captured command result and parsed output entries. It mirrors `running_summary` but fills in completion metadata.

**Data flow**: It takes a `ConfiguredHandler`, a `CommandRunResult`, a final `HookRunStatus`, and a vector of protocol `HookOutputEntry` values. It reads handler metadata, computes run ID and scope, copies timestamps and duration from `run_result`, and returns a populated `HookRunSummary` with the supplied status and entries.

**Call relations**: This helper is called by event-specific output parsers after `execute_handlers` completes each command. It pairs with `running_summary` to provide consistent before/after summary shapes.

*Call graph*: calls 2 internal fn (run_id, scope_for_event); called by 8 (parse_completed, parse_pre_completed, parse_completed, parse_completed, parse_completed, parse_completed, parse_completed, parse_completed).


##### `scope_for_event`  (lines 142–154)

```
fn scope_for_event(event_name: HookEventName) -> HookScope
```

**Purpose**: Maps each hook event type to its protocol execution scope. Session and subagent start hooks are thread-scoped; all other supported events are turn-scoped.

**Data flow**: It takes a `HookEventName`, matches on the enum variant, and returns the corresponding `HookScope`.

**Call relations**: This helper is used by both `running_summary` and `completed_summary` so all summaries classify scope consistently.

*Call graph*: called by 2 (completed_summary, running_summary).


##### `tests::make_handler`  (lines 167–184)

```
fn make_handler(
        event_name: HookEventName,
        matcher: Option<&str>,
        command: &str,
        display_order: i64,
    ) -> ConfiguredHandler
```

**Purpose**: Constructs a minimal `ConfiguredHandler` fixture for dispatcher tests. It standardizes source metadata and timeout while allowing event, matcher, command, and display order to vary.

**Data flow**: It takes an event name, optional matcher, command string, and display order, converts owned fields as needed, fills fixed source path and `HookSource::User`, and returns the resulting `ConfiguredHandler`.

**Call relations**: This helper is used throughout the test module to build handler lists for selection tests.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::select_handlers_keeps_duplicate_stop_handlers`  (lines 187–208)

```
fn select_handlers_keeps_duplicate_stop_handlers()
```

**Purpose**: Verifies that duplicate `Stop` handlers are both retained rather than deduplicated. This protects declaration-order semantics for matcherless stop hooks.

**Data flow**: It builds two `Stop` handlers with identical commands but different display orders, calls `select_handlers`, and asserts that both are returned in order.

**Call relations**: This test exercises the `Stop` branch of `select_handlers`, which ignores matchers and preserves all handlers.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::select_handlers_keeps_overlapping_session_start_matchers`  (lines 211–232)

```
fn select_handlers_keeps_overlapping_session_start_matchers()
```

**Purpose**: Checks that multiple `SessionStart` handlers whose matchers both match the same input are all selected. Selection is per handler, not per unique command or matcher result.

**Data flow**: It creates two `SessionStart` handlers with overlapping matchers, calls `select_handlers` with input `startup`, and asserts that both handlers are returned in declaration order.

**Call relations**: This test drives the matcher-based branch of `select_handlers` for session-start events.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::compact_hooks_match_trigger`  (lines 235–255)

```
fn compact_hooks_match_trigger()
```

**Purpose**: Verifies that compact-event handlers are filtered by the provided trigger string. Only handlers whose matcher matches the trigger should be selected.

**Data flow**: It builds two `PreCompact` handlers with matchers `manual` and `auto`, calls `select_handlers` with input `manual`, and asserts that only the first handler is returned.

**Call relations**: This test exercises event-specific matcher filtering for compact hooks through `select_handlers`.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::pre_tool_use_matches_tool_name`  (lines 258–278)

```
fn pre_tool_use_matches_tool_name()
```

**Purpose**: Checks that `PreToolUse` selection matches handlers against the tool name. It confirms regex-style matcher filtering for tool hooks.

**Data flow**: It creates `PreToolUse` handlers for `Bash` and `Edit`, calls `select_handlers` with matcher input `Bash`, and asserts that only the Bash handler is selected.

**Call relations**: This test covers the tool-event matcher path in `select_handlers`.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::post_tool_use_matches_tool_name`  (lines 281–301)

```
fn post_tool_use_matches_tool_name()
```

**Purpose**: Checks that `PostToolUse` selection uses the same tool-name matcher semantics as `PreToolUse`. It ensures consistency across pre/post tool events.

**Data flow**: It creates `PostToolUse` handlers for `Bash` and `Edit`, calls `select_handlers` with input `Bash`, and asserts that only the Bash handler is returned.

**Call relations**: This test exercises the post-tool-use branch of the matcher-based selection logic.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::pre_tool_use_star_matcher_matches_all_tools`  (lines 304–324)

```
fn pre_tool_use_star_matcher_matches_all_tools()
```

**Purpose**: Verifies that the special `*` matcher matches any tool name for `PreToolUse`. It confirms wildcard semantics in handler selection.

**Data flow**: It builds one wildcard `PreToolUse` handler and one `Edit`-specific handler, calls `select_handlers` with input `Bash`, and asserts that only the wildcard handler is selected.

**Call relations**: This test depends on `matches_matcher` behavior as exercised through `select_handlers`.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::pre_tool_use_regex_alternation_matches_each_tool_name`  (lines 327–342)

```
fn pre_tool_use_regex_alternation_matches_each_tool_name()
```

**Purpose**: Checks that a regex alternation matcher can match multiple tool names while excluding others. It validates multi-name matching for one handler.

**Data flow**: It creates one `PreToolUse` handler with matcher `Edit|Write`, calls `select_handlers` three times with `Edit`, `Write`, and `Bash`, and asserts selected counts of 1, 1, and 0 respectively.

**Call relations**: This test exercises repeated calls to `select_handlers` against the same handler to validate matcher semantics.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::pre_tool_use_aliases_match_once_per_handler`  (lines 345–387)

```
fn pre_tool_use_aliases_match_once_per_handler()
```

**Purpose**: Verifies that when multiple compatibility names are supplied, one handler is selected at most once even if several inputs match it. This prevents duplicate execution for alias-rich tool events.

**Data flow**: It builds four `PreToolUse` handlers, including one combined matcher `apply_patch|Write|Edit`, calls `select_handlers_for_matcher_inputs` with all three aliases, and asserts that exactly four handlers are returned with display orders 0 through 3.

**Call relations**: This test directly targets `select_handlers_for_matcher_inputs`, specifically its design of filtering each handler once rather than once per matching input.

*Call graph*: calls 1 internal fn (select_handlers_for_matcher_inputs); 2 external calls (assert_eq!, vec!).


##### `tests::user_prompt_submit_ignores_matcher`  (lines 390–415)

```
fn user_prompt_submit_ignores_matcher()
```

**Purpose**: Checks that `UserPromptSubmit` selection ignores matcher contents entirely, even invalid ones. All handlers for the event should be selected.

**Data flow**: It creates two `UserPromptSubmit` handlers with different matcher strings, including an invalid regex, calls `select_handlers` with no matcher input, and asserts that both handlers are returned in order.

**Call relations**: This test exercises the unconditional-true branch for `UserPromptSubmit` in `select_handlers`.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


##### `tests::select_handlers_preserves_declaration_order`  (lines 418–446)

```
fn select_handlers_preserves_declaration_order()
```

**Purpose**: Verifies that selected handlers remain in their original declaration order. Selection should filter but not reorder handlers.

**Data flow**: It builds three `Stop` handlers with commands `first`, `second`, and `third`, calls `select_handlers`, and asserts that the returned commands remain in that same order.

**Call relations**: This test confirms the stable iteration order of `select_handlers` after filtering.

*Call graph*: calls 1 internal fn (select_handlers); 2 external calls (assert_eq!, vec!).


### Lifecycle and prompt hooks
These event handlers cover session and prompt lifecycle moments, including startup, stop mediation, and compaction-related decisions.

### `hooks/src/events/session_start.rs`

`domain_logic` · `session initialization and subagent launch`

This file defines the request/response types and execution path for `SessionStart` and `SubagentStart` hooks. `SessionStartSource` encodes the startup trigger (`Startup`, `Resume`, `Clear`, `Compact`) and is converted to the matcher string used during handler selection. `SessionStartRequest` carries the session/thread id, absolute cwd, optional transcript path, model, permission mode, and a `StartHookTarget` that distinguishes a normal session start from a subagent launch. `preview` performs only handler matching and converts each selected handler into a `HookRunSummary`.

`run` is the main orchestration path. It first selects handlers by event name plus matcher input (`source.as_str()` for session starts, `agent_type` for subagents). If none match, it returns an empty `SessionStartOutcome`. Otherwise it serializes either `SessionStartCommandInput::new(...)` or a `SubagentStartCommandInput`, converting optional paths through `NullableString::from_path`. Serialization failures are turned into synthetic failed hook events via `common::serialization_failure_hook_events`, but never stop the session.

Completed command runs are interpreted by `parse_completed`. Successful stdout may be parsed as structured hook JSON via `output_parser::parse_session_start` or `parse_subagent_start`; warnings become `Warning` entries, additional context is appended both to visible entries and the accumulated model-context vector, and plain non-JSON stdout is also treated as context. JSON-looking but invalid stdout is a hard failure. A key invariant is that only `SessionStart` honors `continue:false` by producing `HookRunStatus::Stopped`, `should_stop = true`, and an optional `Stop` entry; `SubagentStart` ignores that flag and remains context-only. The final outcome aggregates all completed events, whether any handler requested stop, the first stop reason, and flattened additional contexts.

#### Function details

##### `SessionStartSource::as_str`  (lines 31–38)

```
fn as_str(self) -> &'static str
```

**Purpose**: Maps each `SessionStartSource` variant to the exact lowercase string used in hook matcher input and serialized payloads.

**Data flow**: Reads `self` by value and matches it to one of four static string literals: `startup`, `resume`, `clear`, or `compact`. Returns that `&'static str` without mutating any state.

**Call relations**: Used when building `SessionStart` hook input and when deriving the matcher string for handler selection, so downstream dispatch and payload serialization agree on the same source label.


##### `StartHookTarget::event_name`  (lines 64–69)

```
fn event_name(&self) -> HookEventName
```

**Purpose**: Converts the target enum into the protocol-level hook event name so dispatch can distinguish session starts from subagent starts.

**Data flow**: Reads `self` and returns `HookEventName::SessionStart` for `SessionStart { .. }` or `HookEventName::SubagentStart` for `SubagentStart { .. }`.

**Call relations**: Called by both preview and execution paths before handler selection, ensuring the dispatcher searches the correct event bucket.


##### `StartHookTarget::matcher_input`  (lines 71–76)

```
fn matcher_input(&self) -> &str
```

**Purpose**: Extracts the string used to match handlers within the selected start event type.

**Data flow**: For `SessionStart`, reads the embedded `source` and returns `source.as_str()`. For `SubagentStart`, reads `agent_type` and returns its string slice.

**Call relations**: Feeds `dispatcher::select_handlers` in both `preview` and `run`, so session-start hooks match on source while subagent-start hooks match on agent type.


##### `preview`  (lines 94–106)

```
fn preview(
    handlers: &[ConfiguredHandler],
    request: &SessionStartRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Computes the list of start-hook handlers that would run for a request, without executing any commands.

**Data flow**: Consumes a handler slice plus a borrowed `SessionStartRequest`, derives event name and matcher input from `request.target`, passes them to `dispatcher::select_handlers`, then maps each selected handler through `dispatcher::running_summary` into a `Vec<HookRunSummary>`.

**Call relations**: Invoked by the higher-level `preview_session_start` API. It is the non-mutating mirror of `run`, sharing the same selection criteria so previews reflect actual execution.

*Call graph*: calls 1 internal fn (select_handlers); called by 1 (preview_session_start).


##### `run`  (lines 108–209)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: SessionStartRequest,
    turn_id: Option<String>,
) -> SessionStartOutcome
```

**Purpose**: Executes all matching `SessionStart` or `SubagentStart` handlers, serializes the correct input schema, and aggregates stop/context effects across all runs.

**Data flow**: Takes configured handlers, a `CommandShell`, an owned `SessionStartRequest`, and an optional outer `turn_id`. It selects matching handlers; if none exist, returns an empty `SessionStartOutcome`. For `SessionStart`, it builds `SessionStartCommandInput::new(...)`; for `SubagentStart`, it constructs `SubagentStartCommandInput` directly, converting optional transcript paths with `NullableString::from_path`. It serializes to JSON with `serde_json::to_string`; on failure it emits synthetic failed hook events and returns a non-stopping outcome. On success it calls `dispatcher::execute_handlers`, passing cwd, the effective turn id, and `parse_completed`. It then reduces parsed results into `should_stop` via `any`, picks the first `stop_reason`, flattens all `additional_contexts_for_model` with `common::flatten_additional_contexts`, and returns the collected `HookCompletedEvent`s plus aggregate flags.

**Call relations**: Called by `run_session_start` in the engine-facing API. It delegates matching to `select_handlers`, command execution to `execute_handlers`, serialization-failure reporting to `common::serialization_failure_hook_events`, and per-run interpretation to `parse_completed`.

*Call graph*: calls 7 internal fn (execute_handlers, select_handlers, flatten_additional_contexts, serialization_failure_hook_events, serialization_failure_outcome, from_path, new); called by 1 (run_session_start); 3 external calls (new, format!, to_string).


##### `parse_completed`  (lines 217–335)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<SessionStartHandlerData>
```

**Purpose**: Interprets one finished start-hook command into protocol-visible output entries and internal stop/context data.

**Data flow**: Accepts the `ConfiguredHandler`, a `CommandRunResult`, and an optional `turn_id`. It initializes `entries`, `status`, stop flags, and context accumulation. If `run_result.error` is present, it marks the run failed and emits an `Error` entry. Otherwise it branches on `exit_code`: code `0` inspects trimmed stdout; empty stdout is a no-op, structured stdout is parsed with `output_parser::parse_session_start` or `parse_subagent_start` depending on `handler.event_name`, invalid event names panic, JSON warnings become `Warning` entries, additional context is appended through `common::append_additional_context`, and `continue:false` only affects `SessionStart`, setting `HookRunStatus::Stopped`, `should_stop`, `stop_reason`, and an optional `Stop` entry. If parsing fails but stdout looks like JSON, it emits an event-specific invalid-JSON error; otherwise plain stdout becomes context. Nonzero exit codes and missing status codes become generic `Error` entries. Finally it builds a `HookCompletedEvent` via `dispatcher::completed_summary` and returns `dispatcher::ParsedHandler` containing `SessionStartHandlerData` and `completion_order: 0`.

**Call relations**: Passed as the parse callback into `dispatcher::execute_handlers` from `run`. The unit tests call it directly to verify nuanced behavior around plain stdout, invalid JSON-like stdout, and the difference between `SessionStart` and `SubagentStart` handling of `continue:false`.

*Call graph*: calls 5 internal fn (completed_summary, looks_like_json, parse_session_start, parse_subagent_start, append_additional_context); called by 5 (continue_false_preserves_context_for_later_turns, invalid_json_like_stdout_fails_instead_of_becoming_model_context, plain_stdout_becomes_model_context, subagent_start_continue_false_is_ignored, subagent_start_plain_stdout_becomes_model_context); 3 external calls (new, format!, panic!).


##### `serialization_failure_outcome`  (lines 337–344)

```
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> SessionStartOutcome
```

**Purpose**: Wraps synthetic serialization-failure hook events in a normal `SessionStartOutcome` that never requests stopping.

**Data flow**: Takes a prebuilt `Vec<HookCompletedEvent>` and returns `SessionStartOutcome` with those events, `should_stop = false`, `stop_reason = None`, and empty `additional_contexts`.

**Call relations**: Used only from `run` when request payload serialization fails before any external command can be launched.

*Call graph*: called by 1 (run); 1 external calls (new).


##### `tests::plain_stdout_becomes_model_context`  (lines 362–385)

```
fn plain_stdout_becomes_model_context()
```

**Purpose**: Verifies that successful non-JSON stdout is preserved as model context rather than treated as an error.

**Data flow**: Builds a default session-start handler and a successful `CommandRunResult` with `stdout = "hello from hook\n"`, passes them to `parse_completed`, and asserts that the parsed data contains one context string and the completed run contains a single `Context` entry with `Completed` status.

**Call relations**: Directly exercises `parse_completed`'s plain-stdout branch for `SessionStart`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::continue_false_preserves_context_for_later_turns`  (lines 388–421)

```
fn continue_false_preserves_context_for_later_turns()
```

**Purpose**: Checks that structured `continue:false` output stops processing but still preserves emitted additional context.

**Data flow**: Creates a session-start handler and a successful run whose stdout is valid hook JSON containing `continue:false`, `stopReason`, and `additionalContext`. It parses the result and asserts both `should_stop`/`stop_reason` and retention of the context string in data and output entries.

**Call relations**: Targets the `SessionStart`-specific stop branch inside `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::invalid_json_like_stdout_fails_instead_of_becoming_model_context`  (lines 424–451)

```
fn invalid_json_like_stdout_fails_instead_of_becoming_model_context()
```

**Purpose**: Ensures malformed JSON-looking stdout is rejected instead of being silently injected as context.

**Data flow**: Supplies truncated JSON text on stdout with exit code `0`, invokes `parse_completed`, and asserts failed status, no accumulated context, and a single event-specific `Error` entry.

**Call relations**: Exercises the `looks_like_json` safeguard in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::subagent_start_plain_stdout_becomes_model_context`  (lines 454–478)

```
fn subagent_start_plain_stdout_becomes_model_context()
```

**Purpose**: Confirms that plain stdout from a `SubagentStart` hook is treated as context and preserves the supplied turn id.

**Data flow**: Builds a handler configured for `HookEventName::SubagentStart`, parses a successful run with plain stdout and `Some("turn-1")`, then asserts context accumulation, completed status, and propagation of `turn_id` into the `HookCompletedEvent`.

**Call relations**: Covers the shared plain-stdout path in `parse_completed` for the subagent variant.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler_for, run_result).


##### `tests::subagent_start_continue_false_is_ignored`  (lines 481–509)

```
fn subagent_start_continue_false_is_ignored()
```

**Purpose**: Verifies that `SubagentStart` ignores `continue:false` and remains a context-only hook.

**Data flow**: Parses valid subagent-start JSON containing `continue:false`, `stopReason`, and `additionalContext`, then asserts that no stop flags are set, the context is retained, and the run remains `Completed` rather than `Stopped`.

**Call relations**: Documents the intentional divergence between `SessionStart` and `SubagentStart` in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler_for, run_result).


##### `tests::handler`  (lines 511–513)

```
fn handler() -> ConfiguredHandler
```

**Purpose**: Provides a convenience constructor for a default `SessionStart` test handler.

**Data flow**: Calls `handler_for(HookEventName::SessionStart)` and returns the resulting `ConfiguredHandler`.

**Call relations**: Used by multiple tests to avoid repeating the standard session-start handler setup.

*Call graph*: 1 external calls (handler_for).


##### `tests::handler_for`  (lines 515–527)

```
fn handler_for(event_name: HookEventName) -> ConfiguredHandler
```

**Purpose**: Constructs a minimal `ConfiguredHandler` for a chosen start-event type.

**Data flow**: Accepts a `HookEventName`, fills a `ConfiguredHandler` with that event name, fixed command/timeout/source metadata, an absolute `/tmp/hooks.json` source path from `test_path_buf(...).abs()`, and an empty environment map, then returns it.

**Call relations**: Shared by the test helpers and subagent-specific tests so `parse_completed` can be exercised with either start event.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 529–539)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Builds deterministic `CommandRunResult` fixtures for parser tests.

**Data flow**: Accepts an optional exit code plus stdout/stderr strings, copies them into a `CommandRunResult` with fixed timestamps/duration and `error = None`, and returns it.

**Call relations**: Used by all tests in this module to isolate parser behavior from command execution details.


### `hooks/src/events/user_prompt_submit.rs`

`domain_logic` · `pre-prompt processing`

This file defines the request and outcome types for hooks that run when a user prompt is submitted. `UserPromptSubmitRequest` includes session and turn ids, optional subagent context, cwd, transcript path, model and permission mode, and the raw prompt text. `UserPromptSubmitOutcome` reports completed hook events plus whether processing should stop and any additional contexts to inject later.

`preview` is straightforward: it selects handlers for `HookEventName::UserPromptSubmit` with no matcher and converts them to running summaries. `run` mirrors that selection, returns an empty outcome when no handlers match, and otherwise builds a `UserPromptSubmitCommandInput`. If the request came from a subagent, `SubagentCommandInputFields::from(request.subagent.as_ref())` extracts `agent_id` and `agent_type`; optional transcript paths are normalized with `NullableString::from_path`. Serialization failures are surfaced as synthetic failed hook events and do not themselves stop processing.

`parse_completed` contains the event semantics. Successful stdout may be valid structured JSON from `output_parser::parse_user_prompt_submit`, invalid JSON-looking text is a failure, and plain non-JSON stdout becomes additional model context. Parsed output can emit a warning, append additional context, request a stop via `continue:false`, or request a block via `decision:block`. Unlike stop hooks, a block here sets `HookRunStatus::Blocked` and also sets `should_stop = true` with `stop_reason = parsed.reason`; there is no continuation-fragment mechanism. Exit code `2` is also treated as a blocking shorthand, but stderr must contain a non-empty reason. Across all handlers, `run` aggregates with `any` for stopping, takes the first stop reason, and flattens all collected context strings.

#### Function details

##### `preview`  (lines 49–61)

```
fn preview(
    handlers: &[ConfiguredHandler],
    _request: &UserPromptSubmitRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Returns the `UserPromptSubmit` handlers that would run for a request, without executing them.

**Data flow**: Accepts configured handlers and an unused borrowed request, selects handlers for `HookEventName::UserPromptSubmit` with no matcher, maps them through `dispatcher::running_summary`, and returns the resulting summaries.

**Call relations**: Called by `preview_user_prompt_submit`; it shares the same event-selection criteria as `run`.

*Call graph*: calls 1 internal fn (select_handlers); called by 1 (preview_user_prompt_submit).


##### `run`  (lines 63–131)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: UserPromptSubmitRequest,
) -> UserPromptSubmitOutcome
```

**Purpose**: Executes all matching user-prompt-submit hooks and aggregates stop/context effects.

**Data flow**: Consumes handlers, shell, and an owned `UserPromptSubmitRequest`. It selects `UserPromptSubmit` handlers and returns an empty `UserPromptSubmitOutcome` if none match. Otherwise it derives optional subagent fields via `SubagentCommandInputFields::from(request.subagent.as_ref())`, constructs `UserPromptSubmitCommandInput`, converts the optional transcript path with `NullableString::from_path`, and serializes to JSON. On serialization failure it returns synthetic failed hook events via `serialization_failure_outcome`. On success it calls `dispatcher::execute_handlers` with cwd, `Some(request.turn_id)`, and `parse_completed`, then aggregates `should_stop`, the first `stop_reason`, and flattened additional contexts using `common::flatten_additional_contexts` before returning all completed events.

**Call relations**: Invoked by `run_user_prompt_submit`. It delegates command execution to `execute_handlers`, per-run interpretation to `parse_completed`, and serialization-failure reporting to `common::serialization_failure_hook_events`.

*Call graph*: calls 7 internal fn (execute_handlers, select_handlers, flatten_additional_contexts, serialization_failure_hook_events, serialization_failure_outcome, from_path, from); called by 1 (run_user_prompt_submit); 3 external calls (new, format!, to_string).


##### `parse_completed`  (lines 133–265)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<UserPromptSubmitHandlerData>
```

**Purpose**: Interprets one completed `UserPromptSubmit` hook run into visible output entries and internal stop/context data.

**Data flow**: Takes a `ConfiguredHandler`, `CommandRunResult`, and optional `turn_id`. It initializes status, stop flags, and context accumulation. A transport-level `error` becomes failed status with an `Error` entry. For exit code `0`, empty stdout is ignored; valid structured stdout from `output_parser::parse_user_prompt_submit` may emit a `Warning`, append `additional_context` through `common::append_additional_context` when there is no invalid block reason, stop processing on `continue:false` by setting `Stopped`, `should_stop`, and optional `Stop` entry, fail on `invalid_block_reason`, or block by setting `Blocked`, `should_stop = true`, `stop_reason = parsed.reason.clone()`, and a `Feedback` entry. If parsing fails but stdout looks like JSON, it emits an invalid-JSON error; otherwise plain stdout is treated as additional context. Exit code `2` reads a blocking reason from trimmed stderr, producing blocked status and stop flags if present, or a specific error if absent. Other exit codes and missing status codes become generic failures. It wraps the result in `HookCompletedEvent` via `dispatcher::completed_summary` and returns `dispatcher::ParsedHandler<UserPromptSubmitHandlerData>`.

**Call relations**: Passed into `dispatcher::execute_handlers` by `run`. The tests call it directly to validate stop preservation of context, block decisions, and stderr-based blocking.

*Call graph*: calls 5 internal fn (completed_summary, looks_like_json, parse_user_prompt_submit, append_additional_context, trimmed_non_empty); called by 4 (claude_block_decision_blocks_processing, claude_block_decision_requires_reason, continue_false_preserves_context_for_later_turns, exit_code_two_blocks_processing); 2 external calls (new, format!).


##### `serialization_failure_outcome`  (lines 267–274)

```
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> UserPromptSubmitOutcome
```

**Purpose**: Builds a non-stopping outcome around synthetic hook events created when request serialization fails.

**Data flow**: Accepts a vector of `HookCompletedEvent` and returns `UserPromptSubmitOutcome` with those events, `should_stop = false`, `stop_reason = None`, and no additional contexts.

**Call relations**: Used only from `run` when `serde_json::to_string` fails.

*Call graph*: called by 1 (run); 1 external calls (new).


##### `tests::continue_false_preserves_context_for_later_turns`  (lines 292–325)

```
fn continue_false_preserves_context_for_later_turns()
```

**Purpose**: Verifies that `continue:false` stops prompt processing but still preserves emitted additional context.

**Data flow**: Builds a handler and a successful JSON run containing `continue:false`, `stopReason`, and `additionalContext`, parses it, and asserts stopped status plus retention of the context string in both parsed data and output entries.

**Call relations**: Exercises the stop branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::claude_block_decision_blocks_processing`  (lines 328–361)

```
fn claude_block_decision_blocks_processing()
```

**Purpose**: Checks that a valid `decision:block` response blocks prompt processing and records the reason as feedback.

**Data flow**: Parses successful JSON containing `decision:block`, `reason`, and `additionalContext`, then asserts `should_stop = true`, `stop_reason` equal to the block reason, blocked status, and both context and feedback entries.

**Call relations**: Covers the structured block-decision path in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::claude_block_decision_requires_reason`  (lines 364–392)

```
fn claude_block_decision_requires_reason()
```

**Purpose**: Ensures that block decisions without a non-empty reason fail validation and do not inject context.

**Data flow**: Supplies JSON with `decision:block` but no reason, parses it, and asserts failed status, cleared stop/context data, and the specific validation error entry.

**Call relations**: Exercises the `invalid_block_reason` handling path in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::exit_code_two_blocks_processing`  (lines 395–418)

```
fn exit_code_two_blocks_processing()
```

**Purpose**: Verifies the legacy exit-code-2 blocking path for user prompt submit hooks.

**Data flow**: Creates a run with `exit_code = Some(2)` and stderr containing a blocking reason, parses it, and asserts blocked status, `should_stop = true`, `stop_reason` from stderr, and a single `Feedback` entry.

**Call relations**: Covers the stderr-based blocking branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::handler`  (lines 420–432)

```
fn handler() -> ConfiguredHandler
```

**Purpose**: Constructs a standard `UserPromptSubmit` handler fixture for parser tests.

**Data flow**: Returns a `ConfiguredHandler` with `event_name = HookEventName::UserPromptSubmit`, fixed command metadata, an absolute test source path, and an empty environment map.

**Call relations**: Shared by all tests in this module.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 434–444)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Creates deterministic `CommandRunResult` fixtures for testing parser behavior.

**Data flow**: Accepts optional exit code and stdout/stderr strings, copies them into a `CommandRunResult` with fixed timing fields and `error = None`, and returns it.

**Call relations**: Used by each parser test to supply controlled command outcomes.


### `hooks/src/events/stop.rs`

`domain_logic` · `turn completion and subagent shutdown`

This file defines the stop-hook request and outcome model for both top-level stop hooks and subagent stop hooks. `StopRequest` carries session and turn identifiers, cwd, transcript paths, model and permission metadata, whether a stop hook is already active, the last assistant message, and a `StopHookTarget`. The target determines both the protocol event (`Stop` vs `SubagentStop`) and whether a matcher string is supplied (`None` for `Stop`, `Some(agent_type)` for subagents).

`preview` mirrors runtime selection by asking the dispatcher for handlers matching the event name and optional matcher. `run` performs the full path: select handlers, return an empty `StopOutcome` if none match, otherwise build either `StopCommandInput` or `SubagentStopCommandInput`. Optional strings and paths are normalized through `NullableString::from_string` and `NullableString::from_path`. Serialization failures are converted into synthetic failed hook events and never produce stop/block decisions.

The core logic lives in `parse_completed`. For exit code `0`, stdout must be valid stop-hook JSON; unlike session-start hooks, arbitrary plain text is not accepted. Parsed output may emit warnings, request a hard stop via `continue:false`, or request a block via `decision:block` with a non-empty reason. A block reason becomes both a `Feedback` entry and a `HookPromptFragment` tied to the completed run id. Exit code `2` is a legacy shorthand for blocking: stderr must contain a non-blank continuation prompt, otherwise the run fails. `aggregate_results` then combines all handler data with a strict precedence: any stop suppresses all blocking, otherwise blocking reasons are concatenated in declaration order with `common::join_text_chunks`, and continuation fragments are preserved only for blocking handlers.

#### Function details

##### `StopHookTarget::event_name`  (lines 47–52)

```
fn event_name(&self) -> HookEventName
```

**Purpose**: Maps the stop target variant to the corresponding protocol hook event name.

**Data flow**: Reads `self` and returns `HookEventName::Stop` for `Stop` or `HookEventName::SubagentStop` for `SubagentStop { .. }`.

**Call relations**: Used by both preview and execution to select the correct handler set.


##### `StopHookTarget::matcher_input`  (lines 54–59)

```
fn matcher_input(&self) -> Option<&str>
```

**Purpose**: Extracts the optional matcher string used during stop-hook dispatch.

**Data flow**: Returns `None` for top-level `Stop`, because ordinary stop hooks do not dispatch on a matcher, and `Some(agent_type.as_str())` for `SubagentStop`.

**Call relations**: Passed into `dispatcher::select_handlers` so only subagent stop hooks use matcher-based filtering.


##### `preview`  (lines 81–93)

```
fn preview(
    handlers: &[ConfiguredHandler],
    request: &StopRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Lists the stop handlers that would run for a given request without executing them.

**Data flow**: Accepts configured handlers and a borrowed `StopRequest`, derives event name and matcher input from `request.target`, selects matching handlers, and maps them to `HookRunSummary` values via `dispatcher::running_summary`.

**Call relations**: Called by the engine-facing `preview_stop` method and kept in sync with `run` by sharing the same selection logic.

*Call graph*: calls 1 internal fn (select_handlers); called by 1 (preview_stop).


##### `run`  (lines 95–200)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: StopRequest,
) -> StopOutcome
```

**Purpose**: Executes matching `Stop` or `SubagentStop` handlers and reduces their outputs into one stop/block decision.

**Data flow**: Consumes handlers, shell, and an owned `StopRequest`. It selects matching handlers and returns a default-like empty `StopOutcome` if none match. For `Stop`, it constructs `StopCommandInput`; for `SubagentStop`, it constructs `SubagentStopCommandInput`, converting optional transcript paths and last assistant message through `NullableString` helpers. It serializes the input to JSON, returning synthetic failure events on serialization error. On success it calls `dispatcher::execute_handlers` with cwd, `Some(request.turn_id)`, and `parse_completed`, then passes the parsed handler data into `aggregate_results`. The returned `StopOutcome` contains all completed events plus aggregate stop/block flags, reasons, and continuation fragments.

**Call relations**: Invoked by `run_stop`. It delegates per-handler parsing to `parse_completed`, aggregate precedence rules to `aggregate_results`, and serialization-failure event generation to `common::serialization_failure_hook_events`.

*Call graph*: calls 7 internal fn (execute_handlers, select_handlers, serialization_failure_hook_events, aggregate_results, serialization_failure_outcome, from_path, from_string); called by 1 (run_stop); 3 external calls (new, format!, to_string).


##### `parse_completed`  (lines 202–371)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<StopHandlerData>
```

**Purpose**: Parses one completed stop-hook command into protocol output entries, stop/block flags, and optional continuation prompt fragments.

**Data flow**: Takes a `ConfiguredHandler`, `CommandRunResult`, and optional `turn_id`. It first validates that `handler.event_name` is `Stop` or `SubagentStop`, panicking otherwise. It initializes status and decision fields, then branches on command outcome. A transport-level `error` becomes failed status with an `Error` entry. Exit code `0` requires valid JSON parsed by `output_parser::parse_stop` or `parse_subagent_stop`; warnings become `Warning` entries, `continue:false` sets `Stopped`, `should_stop`, and optional `Stop` entry, invalid block reasons become failed `Error`s, and `decision:block` with a non-empty trimmed reason sets `Blocked`, `should_block`, `block_reason`, a `Feedback` entry, and a single `HookPromptFragment::from_single_hook(reason, completed.run.id.clone())`. Missing or blank block reasons fail with event-specific messages. Exit code `2` is treated specially: stderr must contain a non-empty trimmed continuation prompt, which produces the same blocked state and fragment; otherwise the run fails. Other exit codes or missing status codes become generic failures. It then builds `HookCompletedEvent` via `dispatcher::completed_summary` and returns `dispatcher::ParsedHandler<StopHandlerData>`.

**Call relations**: Supplied as the parser callback from `run`. The tests call it directly to validate precedence between stop and block, stderr-based blocking, and strict invalid-output handling.

*Call graph*: calls 4 internal fn (completed_summary, parse_stop, parse_subagent_stop, trimmed_non_empty); called by 7 (block_decision_with_blank_reason_fails_instead_of_blocking, block_decision_with_reason_sets_continuation_prompt, block_decision_without_reason_is_invalid, continue_false_overrides_block_decision, exit_code_two_uses_stderr_feedback_only, exit_code_two_without_stderr_does_not_block, invalid_stdout_fails_instead_of_silently_nooping); 4 external calls (new, format!, panic!, unreachable!).


##### `aggregate_results`  (lines 373–407)

```
fn aggregate_results(
    results: impl IntoIterator<Item = &'a StopHandlerData>,
) -> StopHandlerData
```

**Purpose**: Combines multiple parsed stop-hook results into one final decision with stop taking precedence over block.

**Data flow**: Consumes an iterator of `&StopHandlerData`, collects it into a `Vec`, computes `should_stop` if any result requested stop, picks the first available `stop_reason`, computes `should_block` only when no stop occurred and at least one result requested block, joins all block reasons with `common::join_text_chunks` when blocking is active, and concatenates continuation fragments from blocking results in iteration order. Returns a new `StopHandlerData` carrying the aggregate values.

**Call relations**: Called by `run` after all handlers finish, and directly by a unit test that verifies declaration-order concatenation of block reasons.

*Call graph*: calls 1 internal fn (join_text_chunks); called by 2 (run, aggregate_results_concatenates_blocking_reasons_in_declaration_order); 3 external calls (into_iter, iter, new).


##### `serialization_failure_outcome`  (lines 409–418)

```
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> StopOutcome
```

**Purpose**: Packages synthetic serialization-failure events into a non-stopping, non-blocking `StopOutcome`.

**Data flow**: Accepts a vector of `HookCompletedEvent` and returns `StopOutcome` with those events plus all decision flags cleared and an empty continuation-fragment list.

**Call relations**: Used only from `run` when request JSON cannot be serialized.

*Call graph*: called by 1 (run); 1 external calls (new).


##### `tests::block_decision_with_reason_sets_continuation_prompt`  (lines 439–464)

```
fn block_decision_with_reason_sets_continuation_prompt()
```

**Purpose**: Verifies that a valid `decision:block` response produces blocked status and a continuation fragment tied to the hook run id.

**Data flow**: Builds a stop handler and a successful JSON run containing `decision:block` and `reason`, parses it, and asserts blocked flags plus a single `HookPromptFragment` whose `hook_run_id` matches the completed run.

**Call relations**: Exercises the structured block branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::block_decision_without_reason_is_invalid`  (lines 467–483)

```
fn block_decision_without_reason_is_invalid()
```

**Purpose**: Checks that `decision:block` without a non-empty reason is rejected.

**Data flow**: Parses successful stdout containing only `{"decision":"block"}`, then asserts default handler data, failed status, and the specific validation error entry.

**Call relations**: Covers the missing-reason validation path in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::continue_false_overrides_block_decision`  (lines 486–508)

```
fn continue_false_overrides_block_decision()
```

**Purpose**: Ensures that `continue:false` takes precedence over any simultaneous block decision fields.

**Data flow**: Supplies JSON containing both `continue:false` and `decision:block`, parses it, and asserts that the result is a stop with no block flags or continuation fragments.

**Call relations**: Documents the precedence encoded in `parse_completed` before block handling is considered.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::exit_code_two_uses_stderr_feedback_only`  (lines 511–532)

```
fn exit_code_two_uses_stderr_feedback_only()
```

**Purpose**: Verifies the legacy exit-code-2 blocking path that reads the continuation prompt from stderr.

**Data flow**: Creates a run with `exit_code = Some(2)`, ignored stdout, and non-empty stderr, parses it, and asserts blocked status, block reason, and a continuation fragment built from stderr text.

**Call relations**: Exercises the dedicated exit-code-2 branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::exit_code_two_without_stderr_does_not_block`  (lines 535–553)

```
fn exit_code_two_without_stderr_does_not_block()
```

**Purpose**: Checks that exit code 2 without a usable stderr prompt fails instead of silently blocking.

**Data flow**: Parses a run with `exit_code = Some(2)` and blank stderr, then asserts default data, failed status, and the event-specific missing-prompt error.

**Call relations**: Covers the validation failure branch of the legacy blocking path.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::block_decision_with_blank_reason_fails_instead_of_blocking`  (lines 556–572)

```
fn block_decision_with_blank_reason_fails_instead_of_blocking()
```

**Purpose**: Ensures whitespace-only block reasons are treated as invalid, not as usable continuation prompts.

**Data flow**: Parses JSON with `decision:block` and a blank `reason`, then asserts failed status and the same non-empty-reason validation error used for missing reasons.

**Call relations**: Exercises `common::trimmed_non_empty` integration inside `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::invalid_stdout_fails_instead_of_silently_nooping`  (lines 575–591)

```
fn invalid_stdout_fails_instead_of_silently_nooping()
```

**Purpose**: Confirms that non-JSON stdout on a successful stop hook is always an error.

**Data flow**: Supplies `stdout = "not json"` with exit code `0`, parses it, and asserts failed status, default data, and the invalid-stop-JSON error entry.

**Call relations**: Documents the stricter parsing contract for stop hooks compared with context-injecting hooks.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::aggregate_results_concatenates_blocking_reasons_in_declaration_order`  (lines 594–629)

```
fn aggregate_results_concatenates_blocking_reasons_in_declaration_order()
```

**Purpose**: Verifies that multiple blocking results are merged in order and their continuation fragments are preserved in the same order.

**Data flow**: Constructs two `StopHandlerData` references with distinct block reasons and fragments, passes them to `aggregate_results`, and asserts the joined reason string `first\n\nsecond` plus ordered fragment concatenation.

**Call relations**: Directly tests the aggregation logic used by `run` after all handlers complete.

*Call graph*: calls 1 internal fn (aggregate_results); 2 external calls (assert_eq!, vec!).


##### `tests::handler`  (lines 631–643)

```
fn handler() -> ConfiguredHandler
```

**Purpose**: Creates a standard `Stop` handler fixture for parser tests.

**Data flow**: Returns a `ConfiguredHandler` with `event_name = HookEventName::Stop`, fixed command metadata, an absolute test source path, and an empty environment map.

**Call relations**: Shared by all parser tests in this module.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 645–655)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Builds deterministic command-run fixtures for stop-hook parser tests.

**Data flow**: Accepts optional exit code and stdout/stderr strings, copies them into a `CommandRunResult` with fixed timing fields and `error = None`, and returns it.

**Call relations**: Used by every test here to isolate parsing behavior from process execution.


### `hooks/src/events/compact.rs`

`domain_logic` · `pre-compact and post-compact hook handling during compaction lifecycle`

This module handles the compact lifecycle hooks, which are simpler than tool-use hooks because they have no matcher aliases, no tool-use ID suffixing, and no event-specific rewrite/block payloads beyond universal stop semantics. It defines `PreCompactRequest` and `PostCompactRequest` carrying session, turn, optional subagent metadata, cwd, transcript path, model, and a `trigger` string, plus outcome structs that report completed hook events and whether execution should stop.

`preview_pre` and `preview_post` select handlers by `HookEventName` and the request trigger, then convert them into running summaries. `run_pre` and `run_post` perform the full flow: select matching handlers, early-return if none match, serialize request data into `PreCompactCommandInput` or `PostCompactCommandInput`, synthesize failed events if serialization fails, and otherwise execute handlers through `dispatcher::execute_handlers`. The resulting parsed handler data is folded into `should_stop` and first `stop_reason` while preserving all completed events.

Parsing is split between `parse_pre_completed` and a generic `parse_completed` used for post-compact. Both inspect `CommandRunResult` in the same order: transport error, exit code 0 with optional JSON parsing, nonzero exit code, or missing exit code. Plain stdout is ignored; JSON-like but invalid stdout becomes a failed run. For valid parsed output, `system_message` becomes a warning entry, `continue:false` becomes `HookRunStatus::Stopped` with a `Stop` entry, and stderr on nonzero exit is trimmed before falling back to `hook exited with code ...`.

#### Function details

##### `preview_pre`  (lines 58–70)

```
fn preview_pre(
    handlers: &[ConfiguredHandler],
    request: &PreCompactRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Builds preview rows for `PreCompact` handlers matching the request trigger. It does not execute commands.

**Data flow**: Takes handler slice and `PreCompactRequest` → calls `dispatcher::select_handlers` with `HookEventName::PreCompact` and `Some(trigger)` → maps each selected handler to `dispatcher::running_summary` → returns `Vec<HookRunSummary>`.

**Call relations**: Called by the higher-level pre-compact preview API before any hook execution occurs.

*Call graph*: calls 1 internal fn (select_handlers); called by 1 (preview_pre_compact).


##### `run_pre`  (lines 72–123)

```
async fn run_pre(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: PreCompactRequest,
) -> PreCompactOutcome
```

**Purpose**: Executes all matching `PreCompact` handlers and aggregates whether compaction should stop. It handles no-match and serialization-failure cases explicitly.

**Data flow**: Selects matching handlers for `PreCompact` and trigger → returns an empty `PreCompactOutcome` if none match → serializes request via `pre_command_input_json`; on error, returns failed synthetic events from `common::serialization_failure_hook_events` → otherwise executes handlers with `dispatcher::execute_handlers`, using `parse_pre_completed` to parse each result → computes `should_stop` as any parsed stop and `stop_reason` as the first available reason → returns outcome with collected completed events.

**Call relations**: Invoked by the public pre-compact run path; it delegates selection and execution to `dispatcher` and parsing to `parse_pre_completed`.

*Call graph*: calls 4 internal fn (execute_handlers, select_handlers, serialization_failure_hook_events, pre_command_input_json); called by 1 (run_pre_compact); 2 external calls (new, format!).


##### `pre_command_input_json`  (lines 125–138)

```
fn pre_command_input_json(request: &PreCompactRequest) -> Result<String, serde_json::Error>
```

**Purpose**: Serializes a `PreCompactRequest` into the JSON stdin expected by compact hook commands. It includes lifecycle metadata and optional subagent fields.

**Data flow**: Reads request fields and converts optional subagent via `SubagentCommandInputFields::from` and transcript path via `NullableString::from_path` → constructs `PreCompactCommandInput` with `hook_event_name = "PreCompact"` → serializes it with `serde_json::to_string` and returns the JSON string or serialization error.

**Call relations**: Used by `run_pre` and directly by a unit test that verifies the serialized payload shape.

*Call graph*: calls 2 internal fn (from_path, from); called by 2 (run_pre, pre_compact_input_includes_lifecycle_metadata); 1 external calls (to_string).


##### `preview_post`  (lines 140–152)

```
fn preview_post(
    handlers: &[ConfiguredHandler],
    request: &PostCompactRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Builds preview rows for `PostCompact` handlers matching the request trigger. It mirrors `preview_pre` for the post phase.

**Data flow**: Selects handlers with `HookEventName::PostCompact` and `Some(trigger)` → maps them to running summaries → returns the preview vector.

**Call relations**: Called by the higher-level post-compact preview API.

*Call graph*: calls 1 internal fn (select_handlers); called by 1 (preview_post_compact).


##### `run_post`  (lines 154–205)

```
async fn run_post(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: PostCompactRequest,
) -> StatelessHookOutcome
```

**Purpose**: Executes all matching `PostCompact` handlers and aggregates stop decisions after compaction. It mirrors `run_pre` with post-specific input serialization and parsing.

**Data flow**: Selects matching `PostCompact` handlers → returns empty `StatelessHookOutcome` if none → serializes request via `post_command_input_json`; on error returns synthetic failed events → otherwise executes handlers with `parse_post_completed` → folds parsed results into `should_stop`, first `stop_reason`, and completed events → returns the outcome.

**Call relations**: Invoked by the public post-compact run path and delegates parsing to the generic post parser wrapper.

*Call graph*: calls 4 internal fn (execute_handlers, select_handlers, serialization_failure_hook_events, post_command_input_json); called by 1 (run_post_compact); 2 external calls (new, format!).


##### `post_command_input_json`  (lines 207–220)

```
fn post_command_input_json(request: &PostCompactRequest) -> Result<String, serde_json::Error>
```

**Purpose**: Serializes a `PostCompactRequest` into command stdin JSON. It is the post-phase counterpart to `pre_command_input_json`.

**Data flow**: Converts optional subagent and transcript path, copies request metadata, sets `hook_event_name = "PostCompact"`, builds `PostCompactCommandInput`, and serializes it to a JSON string or returns a `serde_json::Error`.

**Call relations**: Used by `run_post` and by the unit test that checks post-compact input serialization.

*Call graph*: calls 2 internal fn (from_path, from); called by 2 (run_post, post_compact_input_includes_lifecycle_metadata); 1 external calls (to_string).


##### `parse_pre_completed`  (lines 228–313)

```
fn parse_pre_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<CompactHandlerData>
```

**Purpose**: Parses one completed `PreCompact` command run into transcript entries, run status, and stop metadata. It treats only universal output as valid structured JSON.

**Data flow**: Takes a handler, `CommandRunResult`, and optional turn ID → initializes empty entries/status/data → if `run_result.error` exists, marks failed with one error entry → else branches on `exit_code`: `0` parses stdout; empty stdout is ignored; valid `parse_pre_compact` output may emit a warning entry from `system_message`, a stopped status and `Stop` entry when `continue_processing` is false, or an error entry for `invalid_reason`; JSON-like but unparsable stdout becomes `hook returned invalid PreCompact hook JSON output`; nonzero exit uses trimmed stderr or fallback exit-code text; missing exit code yields a fixed error → wraps everything in `dispatcher::completed_summary` and returns `ParsedHandler<CompactHandlerData>`.

**Call relations**: Used by `run_pre` and directly by tests covering stop behavior, invalid JSON, and plain-stdout no-op behavior.

*Call graph*: calls 4 internal fn (completed_summary, looks_like_json, parse_pre_compact, trimmed_non_empty); called by 3 (block_decision_is_not_supported_for_pre_compact, continue_false_stops_before_compaction, pre_compact_ignores_plain_stdout); 1 external calls (new).


##### `parse_post_completed`  (lines 315–327)

```
fn parse_post_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<CompactHandlerData>
```

**Purpose**: Thin wrapper that parses a `PostCompact` command run using the generic compact completion parser. It supplies the event label and parser function.

**Data flow**: Forwards handler, run result, turn ID, event label `PostCompact`, and `output_parser::parse_post_compact` into `parse_completed` → returns the parsed handler result.

**Call relations**: Called by `run_post` and by tests for post-compact completion behavior.

*Call graph*: calls 1 internal fn (parse_completed); called by 2 (post_compact_continue_false_stops_after_compaction, post_compact_ignores_plain_stdout).


##### `parse_completed`  (lines 329–416)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
    event_label: &'static str,
    parse_output: fn(&str) -> Option<output_parser::S
```

**Purpose**: Generic completion parser for stateless compact hooks that support universal stop semantics. It handles command errors, invalid JSON-like stdout, warnings, and stop entries.

**Data flow**: Accepts handler, run result, turn ID, event label, and a parser function returning `StatelessHookOutput` → processes `run_result.error`, `exit_code`, stdout, and stderr similarly to `parse_pre_completed` → on valid parsed output, emits warning entries for `system_message`, stop entries and `Stopped` status for `continue:false`, error entries for `invalid_reason`, and ignores plain stdout → returns `dispatcher::ParsedHandler<CompactHandlerData>` with completion summary and stop metadata.

**Call relations**: Used by `parse_post_completed` to avoid duplicating the common post-compact parsing logic.

*Call graph*: calls 3 internal fn (completed_summary, looks_like_json, trimmed_non_empty); called by 1 (parse_post_completed); 2 external calls (new, format!).


##### `tests::pre_compact_input_includes_lifecycle_metadata`  (lines 438–455)

```
fn pre_compact_input_includes_lifecycle_metadata()
```

**Purpose**: Tests that serialized pre-compact command input contains the expected lifecycle fields and values. It verifies the JSON contract sent to hooks.

**Data flow**: Builds a fixture request via `pre_request()` → serializes it with `pre_command_input_json` → parses the JSON string back into `serde_json::Value` → asserts equality with the expected object.

**Call relations**: Directly exercises `pre_command_input_json`.

*Call graph*: calls 1 internal fn (pre_command_input_json); 3 external calls (assert_eq!, pre_request, from_str).


##### `tests::post_compact_input_includes_lifecycle_metadata`  (lines 458–475)

```
fn post_compact_input_includes_lifecycle_metadata()
```

**Purpose**: Tests that serialized post-compact command input contains the expected lifecycle metadata. It mirrors the pre-compact serialization test.

**Data flow**: Creates a fixture request via `post_request()` → serializes with `post_command_input_json` → parses back to JSON value → asserts the expected object shape and values.

**Call relations**: Directly covers `post_command_input_json`.

*Call graph*: calls 1 internal fn (post_command_input_json); 3 external calls (assert_eq!, post_request, from_str).


##### `tests::block_decision_is_not_supported_for_pre_compact`  (lines 478–497)

```
fn block_decision_is_not_supported_for_pre_compact()
```

**Purpose**: Tests that a pre-compact hook returning block-decision JSON is treated as invalid output rather than a valid block. Pre-compact only supports universal stop semantics.

**Data flow**: Builds a fake handler and successful run result whose stdout is `{"decision":"block",...}` → parses with `parse_pre_completed` → asserts failed status and one error entry saying the JSON output is invalid.

**Call relations**: Exercises the invalid-JSON-like branch after `parse_pre_compact` rejects unsupported structured output.

*Call graph*: calls 1 internal fn (parse_pre_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::continue_false_stops_before_compaction`  (lines 500–517)

```
fn continue_false_stops_before_compaction()
```

**Purpose**: Tests that `continue:false` with `stopReason` stops pre-compact processing and records the stop reason. This is the main structured control-flow path for pre-compact hooks.

**Data flow**: Creates a successful run result with stdout `{"continue":false,"stopReason":"nope"}` → parses it → asserts `Stopped` status, `should_stop = true`, `stop_reason = Some("nope")`, and one `Stop` entry with the same text.

**Call relations**: Directly validates the stop-handling branch in `parse_pre_completed`.

*Call graph*: calls 1 internal fn (parse_pre_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::post_compact_continue_false_stops_after_compaction`  (lines 520–544)

```
fn post_compact_continue_false_stops_after_compaction()
```

**Purpose**: Tests that `continue:false` also stops processing for post-compact hooks. It verifies the generic post parser preserves stop semantics.

**Data flow**: Creates a successful run result with post-compact stop JSON → parses via `parse_post_completed` → asserts stopped status, `should_stop`, stop reason, and one `Stop` entry.

**Call relations**: Exercises `parse_post_completed` and, through it, the generic `parse_completed` stop branch.

*Call graph*: calls 1 internal fn (parse_post_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::pre_compact_ignores_plain_stdout`  (lines 547–556)

```
fn pre_compact_ignores_plain_stdout()
```

**Purpose**: Tests that non-JSON stdout from a successful pre-compact hook is ignored rather than treated as an error. Plain logging output is therefore harmless.

**Data flow**: Creates a successful run result with plain text stdout → parses with `parse_pre_completed` → asserts completed status and no entries.

**Call relations**: Covers the plain-stdout no-op branch in pre-compact parsing.

*Call graph*: calls 1 internal fn (parse_pre_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::post_compact_ignores_plain_stdout`  (lines 559–568)

```
fn post_compact_ignores_plain_stdout()
```

**Purpose**: Tests that non-JSON stdout from a successful post-compact hook is also ignored. This mirrors pre-compact behavior.

**Data flow**: Creates a successful run result with plain text stdout → parses with `parse_post_completed` → asserts completed status and empty entries.

**Call relations**: Covers the plain-stdout branch in the generic post parser.

*Call graph*: calls 1 internal fn (parse_post_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::pre_request`  (lines 570–581)

```
fn pre_request() -> super::PreCompactRequest
```

**Purpose**: Builds a canonical `PreCompactRequest` fixture for serialization tests. It supplies stable IDs and paths.

**Data flow**: Constructs a `ThreadId` from a fixed UUID string, uses `/tmp` as absolute cwd, and fills fixed turn/model/trigger values → returns the request struct.

**Call relations**: Used by the pre-compact input serialization test.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (test_path_buf).


##### `tests::post_request`  (lines 583–594)

```
fn post_request() -> super::PostCompactRequest
```

**Purpose**: Builds a canonical `PostCompactRequest` fixture for serialization tests. It mirrors `pre_request` with a different fixed thread ID.

**Data flow**: Creates a fixed `ThreadId`, absolute `/tmp` cwd, and constant turn/model/trigger values → returns the request.

**Call relations**: Used by the post-compact input serialization test.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (test_path_buf).


##### `tests::handler`  (lines 596–608)

```
fn handler(event_name: HookEventName) -> ConfiguredHandler
```

**Purpose**: Creates a representative `ConfiguredHandler` fixture for compact hook parsing tests. It fixes source metadata and command details.

**Data flow**: Takes a `HookEventName` → returns `ConfiguredHandler` with that event, no matcher, command `python3 compact_hook.py`, timeout 5, status message, `/tmp/hooks.json` source path, `HookSource::User`, display order 0, and empty env map.

**Call relations**: Used by all compact parsing tests to supply handler metadata for completed summaries.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 610–620)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Builds a deterministic `CommandRunResult` fixture for compact parsing tests. It avoids repeating timestamp and duration setup.

**Data flow**: Takes optional exit code plus stdout/stderr strings → returns `CommandRunResult` with fixed timestamps, duration, copied stdout/stderr, and `error = None`.

**Call relations**: Used by all compact parsing tests as the simulated command execution result.


### Tool and permission hooks
These event handlers mediate tool execution and approval requests, aggregating hook outputs into blocking, context, and allow-deny outcomes.

### `hooks/src/events/pre_tool_use.rs`

`domain_logic` · `pre-tool execution handling before a tool is invoked`

This module contains the event-specific logic for hooks that run before a tool invocation. `PreToolUseRequest` carries session and turn metadata, optional subagent context, cwd, transcript path, model, permission mode, canonical tool name plus matcher aliases, the `tool_use_id`, and the proposed `tool_input`. `PreToolUseOutcome` reports all completed hook events, whether execution should be blocked, the first block reason, any accumulated additional contexts, and an optional rewritten input.

`preview` selects handlers using matcher inputs derived from the canonical tool name and aliases, then rewrites preview run IDs with the tool-use ID. `run` repeats selection, returns an empty outcome if nothing matches, serializes a `PreToolUseCommandInput`, and on serialization failure returns synthetic failed events with neutral outcome fields. Otherwise it executes handlers and aggregates results: any handler block sets `should_block`, the first block reason wins, all additional contexts are flattened in handler order, and `updated_input` is chosen only when no handler blocked.

The rewrite-selection rule is subtle and encoded in `latest_updated_input`: hook events are reported in configured order, but competing rewrites are resolved by completion order, so the hook that actually finished last wins. `parse_completed` interprets successful JSON output via `output_parser::parse_pre_tool_use`, emits warning entries for `system_message`, records valid `additionalContext`, turns deny/block responses into `Blocked` runs with `Feedback`, and accepts rewrites only when not blocked. Unsupported outputs fail open as `Failed`. A legacy shell convention also exists: exit code `2` plus non-empty stderr means block with that stderr as the reason.

#### Function details

##### `preview`  (lines 54–69)

```
fn preview(
    handlers: &[ConfiguredHandler],
    request: &PreToolUseRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Builds preview summaries for pre-tool-use hooks matching the tool name or aliases. It appends the tool-use ID to each run ID.

**Data flow**: Takes handlers and `PreToolUseRequest` → computes matcher inputs with `common::matcher_inputs` → selects matching handlers for `HookEventName::PreToolUse` → maps each running summary through `common::hook_run_for_tool_use` using `tool_use_id` → returns preview summaries.

**Call relations**: Called by the higher-level pre-tool-use preview API and by tests that compare preview IDs with completed or synthetic failure IDs.

*Call graph*: calls 2 internal fn (select_handlers_for_matcher_inputs, matcher_inputs); called by 3 (preview_pre_tool_use, preview_and_completed_run_ids_include_tool_use_id, serialization_failure_run_ids_include_tool_use_id).


##### `run`  (lines 71–142)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: PreToolUseRequest,
) -> PreToolUseOutcome
```

**Purpose**: Executes matching pre-tool-use hooks and aggregates block state, block reason, additional context, and any final input rewrite. It handles no-match and serialization-failure cases explicitly.

**Data flow**: Computes matcher inputs and selects matching handlers → returns empty `PreToolUseOutcome` if none → serializes request via `command_input_json`; on error synthesizes failed events with `serialization_failure_hook_events_for_tool_use` and wraps them with `serialization_failure_outcome` → otherwise executes handlers with `dispatcher::execute_handlers` and `parse_completed` → computes `should_block` with `any`, takes the first available `block_reason`, flattens additional contexts, and if no block occurred chooses `updated_input` via `latest_updated_input` → rewrites completed event IDs with `hook_completed_for_tool_use` and returns the outcome.

**Call relations**: Invoked by the public pre-tool-use run path; it delegates parsing to `parse_completed` and rewrite conflict resolution to `latest_updated_input`.

*Call graph*: calls 8 internal fn (execute_handlers, select_handlers_for_matcher_inputs, flatten_additional_contexts, matcher_inputs, serialization_failure_hook_events_for_tool_use, command_input_json, latest_updated_input, serialization_failure_outcome); called by 1 (run_pre_tool_use); 2 external calls (new, format!).


##### `latest_updated_input`  (lines 148–162)

```
fn latest_updated_input(
    results: &[dispatcher::ParsedHandler<PreToolUseHandlerData>],
) -> Option<Value>
```

**Purpose**: Chooses the winning rewritten tool input from multiple handlers based on completion order rather than configuration order. This reflects the event contract for competing rewrites.

**Data flow**: Takes a slice of `dispatcher::ParsedHandler<PreToolUseHandlerData>` → iterates results, extracting `(completion_order, updated_input)` pairs for handlers that produced a rewrite → selects the pair with the maximum `completion_order` → returns the associated `serde_json::Value`, or `None` if no handler rewrote input.

**Call relations**: Called only by `run` after all handlers complete and only when no handler blocked execution.

*Call graph*: called by 1 (run); 1 external calls (iter).


##### `command_input_json`  (lines 170–186)

```
fn command_input_json(request: &PreToolUseRequest) -> Result<String, serde_json::Error>
```

**Purpose**: Serializes a `PreToolUseRequest` into the JSON stdin contract for pre-tool-use hooks. It preserves the canonical tool name even if aliases were used for matching.

**Data flow**: Converts optional subagent and transcript path, clones request metadata including `tool_input` and `tool_use_id`, sets `hook_event_name = "PreToolUse"`, builds `PreToolUseCommandInput`, and serializes it with `serde_json::to_string`.

**Call relations**: Used by `run` before command execution and by a unit test that verifies the serialized `tool_name` field.

*Call graph*: calls 2 internal fn (from_path, from); called by 2 (run, command_input_uses_request_tool_name); 1 external calls (to_string).


##### `parse_completed`  (lines 188–303)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<PreToolUseHandlerData>
```

**Purpose**: Parses one pre-tool-use command result into transcript entries and per-handler block/context/rewrite data. It supports both structured JSON output and the legacy exit-code-2 blocking convention.

**Data flow**: Takes handler, `CommandRunResult`, and optional turn ID → initializes entries/status/block/context/rewrite state → if transport error exists, marks failed with one error entry → else on exit code `0`, ignores empty stdout, parses JSON via `output_parser::parse_pre_tool_use`, emits warning entry for `system_message`, marks failed on `invalid_reason`, otherwise appends `additional_context` through `common::append_additional_context`, converts `block_reason` into `Blocked` status plus `Feedback` entry, and if not blocked stores `updated_input`; malformed JSON-like stdout becomes a failed run → on exit code `2`, trims stderr and treats non-empty text as block reason/feedback, otherwise fails with a specific missing-reason message → other exit codes and missing status code become generic failures → wraps the result in `dispatcher::completed_summary` and returns `ParsedHandler<PreToolUseHandlerData>`.

**Call relations**: Used by `run` as the dispatcher parse callback and directly by tests covering deny, rewrite, deprecated legacy decisions, invalid JSON, and stderr-based blocking.

*Call graph*: calls 5 internal fn (completed_summary, looks_like_json, parse_pre_tool_use, append_additional_context, trimmed_non_empty); called by 13 (additional_context_is_recorded, deprecated_approve_decision_fails_open, deprecated_block_decision_blocks_processing, deprecated_block_decision_with_additional_context_blocks_processing, exit_code_two_blocks_processing, invalid_json_like_stdout_fails_instead_of_becoming_noop, last_completed_updated_input_wins, permission_decision_allow_can_update_input, permission_decision_allow_without_updated_input_fails_open, permission_decision_deny_blocks_processing (+3 more)); 2 external calls (new, format!).


##### `serialization_failure_outcome`  (lines 305–313)

```
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> PreToolUseOutcome
```

**Purpose**: Wraps synthetic serialization-failure events in a neutral `PreToolUseOutcome`. Serialization errors do not themselves block or rewrite input.

**Data flow**: Takes a vector of `HookCompletedEvent` → returns `PreToolUseOutcome { hook_events, should_block: false, block_reason: None, additional_contexts: Vec::new(), updated_input: None }`.

**Call relations**: Called only by `run` on the early-return path when command input serialization fails.

*Call graph*: called by 1 (run); 1 external calls (new).


##### `tests::command_input_uses_request_tool_name`  (lines 336–345)

```
fn command_input_uses_request_tool_name()
```

**Purpose**: Tests that serialized pre-tool-use input uses the request’s canonical `tool_name`. Matching aliases must not leak into hook stdin.

**Data flow**: Builds a request fixture, overrides `tool_name`, serializes with `command_input_json`, parses the JSON back, and asserts `input["tool_name"]` equals the overridden value.

**Call relations**: Directly exercises `command_input_json`.

*Call graph*: calls 1 internal fn (command_input_json); 3 external calls (assert_eq!, request_for_tool_use, from_str).


##### `tests::permission_decision_deny_blocks_processing`  (lines 348–376)

```
fn permission_decision_deny_blocks_processing()
```

**Purpose**: Tests that the newer hook-specific `permissionDecision: deny` format blocks execution and records feedback. This is the preferred structured blocking path.

**Data flow**: Creates successful JSON stdout with `permissionDecision = deny` and `permissionDecisionReason` → parses with `parse_completed` → asserts handler data marks block with the expected reason, run status is `Blocked`, and entries contain one `Feedback` item.

**Call relations**: Covers the deny branch of structured pre-tool-use parsing.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::permission_decision_allow_can_update_input`  (lines 379–401)

```
fn permission_decision_allow_can_update_input()
```

**Purpose**: Tests that `permissionDecision: allow` with `updatedInput` produces a rewrite without blocking. This is the structured rewrite path.

**Data flow**: Creates successful JSON stdout with `permissionDecision = allow` and `updatedInput` → parses it → asserts no block, no context, and `updated_input` equals the rewritten JSON object, with completed status and no entries.

**Call relations**: Exercises the valid rewrite branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::last_completed_updated_input_wins`  (lines 404–430)

```
fn last_completed_updated_input_wins()
```

**Purpose**: Tests the rewrite conflict rule that the last completed handler wins, regardless of configuration order. This is a subtle but intentional invariant.

**Data flow**: Parses two successful rewrite results, manually sets their `completion_order` values so the second-finished handler has the larger order, then calls `latest_updated_input` on both → asserts the returned JSON rewrite is from the later-finishing handler.

**Call relations**: Directly exercises `latest_updated_input` independent of full event execution.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::permission_decision_allow_without_updated_input_fails_open`  (lines 433–461)

```
fn permission_decision_allow_without_updated_input_fails_open()
```

**Purpose**: Tests that `permissionDecision: allow` without `updatedInput` is rejected as unsupported rather than treated as approval. Pre-tool-use allow is only meaningful when rewriting input.

**Data flow**: Creates successful JSON stdout with `permissionDecision = allow` but no `updatedInput` → parses it → asserts no block/rewrite data, failed status, and one error entry with the unsupported-allow message.

**Call relations**: Covers one invalid-reason branch produced by `output_parser::parse_pre_tool_use`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::deprecated_block_decision_blocks_processing`  (lines 464–492)

```
fn deprecated_block_decision_blocks_processing()
```

**Purpose**: Tests that the deprecated legacy `decision:block` format still blocks processing when accompanied by a reason. Backward compatibility is preserved.

**Data flow**: Creates successful JSON stdout `{"decision":"block","reason":"..."}` → parses it → asserts blocked handler data, blocked run status, and one feedback entry with the reason.

**Call relations**: Exercises the legacy-decision compatibility path in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::deprecated_block_decision_with_additional_context_blocks_processing`  (lines 495–529)

```
fn deprecated_block_decision_with_additional_context_blocks_processing()
```

**Purpose**: Tests that legacy block decisions can still carry `additionalContext` through hook-specific output. Both context and feedback should be recorded.

**Data flow**: Creates successful JSON stdout with legacy `decision:block`, `reason`, and hook-specific `additionalContext` → parses it → asserts blocked handler data with one context string, blocked status, and entries containing `Context` then `Feedback`.

**Call relations**: Covers interaction between legacy blocking and additional-context recording.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::unsupported_permission_decision_fails_open`  (lines 532–560)

```
fn unsupported_permission_decision_fails_open()
```

**Purpose**: Tests that unsupported `permissionDecision: ask` is rejected as a failed run rather than changing control flow. The engine does not implement ask semantics here.

**Data flow**: Creates successful JSON stdout with `permissionDecision = ask` and a reason → parses it → asserts no block/rewrite data, failed status, and one error entry with the unsupported-ask message.

**Call relations**: Exercises another invalid-reason branch from `output_parser::parse_pre_tool_use`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::deprecated_approve_decision_fails_open`  (lines 563–587)

```
fn deprecated_approve_decision_fails_open()
```

**Purpose**: Tests that the deprecated legacy `decision:approve` format is rejected. Legacy approval is unsupported for pre-tool-use hooks.

**Data flow**: Creates successful JSON stdout `{"decision":"approve"}` → parses it → asserts no block/rewrite data, failed status, and one error entry with the unsupported-approve message.

**Call relations**: Covers the legacy invalid-decision branch.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::additional_context_is_recorded`  (lines 590–624)

```
fn additional_context_is_recorded()
```

**Purpose**: Tests that structured deny output can also carry `additionalContext`, which is recorded for both transcript and model use. Blocking does not suppress context recording.

**Data flow**: Creates successful JSON stdout with deny decision, deny reason, and `additionalContext` → parses it → asserts blocked handler data with one context string, blocked status, and entries containing `Context` followed by `Feedback`.

**Call relations**: Exercises the normal additional-context path in combination with structured blocking.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::plain_stdout_is_ignored`  (lines 627–645)

```
fn plain_stdout_is_ignored()
```

**Purpose**: Tests that plain non-JSON stdout from a successful pre-tool-use hook is ignored. Hooks may log text without affecting execution.

**Data flow**: Creates a successful run result with plain text stdout → parses it → asserts no block/context/rewrite data, completed status, and no entries.

**Call relations**: Covers the plain-stdout no-op branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::invalid_json_like_stdout_fails_instead_of_becoming_noop`  (lines 648–672)

```
fn invalid_json_like_stdout_fails_instead_of_becoming_noop()
```

**Purpose**: Tests that malformed JSON-like stdout is treated as an error rather than ignored. This prevents partially structured output from silently disappearing.

**Data flow**: Creates a successful run result with truncated JSON stdout → parses it → asserts no block/context/rewrite data, failed status, and one error entry saying the pre-tool-use JSON output is invalid.

**Call relations**: Exercises the `looks_like_json` failure branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::exit_code_two_blocks_processing`  (lines 675–699)

```
fn exit_code_two_blocks_processing()
```

**Purpose**: Tests the legacy shell convention that exit code `2` plus stderr blocks processing. The stderr text becomes the block reason and feedback entry.

**Data flow**: Creates a run result with `exit_code = Some(2)` and stderr `blocked by policy\n` → parses it → asserts blocked handler data with trimmed reason, blocked status, and one feedback entry.

**Call relations**: Covers the exit-code-2 branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::preview_and_completed_run_ids_include_tool_use_id`  (lines 702–723)

```
fn preview_and_completed_run_ids_include_tool_use_id()
```

**Purpose**: Tests that preview and completed pre-tool-use run IDs both include the same tool-use suffix. This keeps UI and transcript correlation stable.

**Data flow**: Builds a request fixture with known `tool_use_id` → calls `preview` and checks the formatted run ID → parses an empty successful completion and rewrites it with `common::hook_completed_for_tool_use` → asserts the completed run ID matches the preview ID.

**Call relations**: Exercises both `preview` and the common completed-event ID rewriting helper.

*Call graph*: calls 3 internal fn (hook_completed_for_tool_use, parse_completed, preview); 4 external calls (assert_eq!, handler, request_for_tool_use, run_result).


##### `tests::serialization_failure_run_ids_include_tool_use_id`  (lines 726–739)

```
fn serialization_failure_run_ids_include_tool_use_id()
```

**Purpose**: Tests that synthetic serialization-failure events also include the tool-use suffix in their run IDs. Early failures must still align with preview rows.

**Data flow**: Builds a request fixture and preview rows → calls `common::serialization_failure_hook_events_for_tool_use` with one handler and the same tool-use ID → asserts the synthetic completed event’s run ID equals the preview run ID.

**Call relations**: Covers the serialization-failure helper path used by `run`.

*Call graph*: calls 2 internal fn (serialization_failure_hook_events_for_tool_use, preview); 4 external calls (assert_eq!, handler, request_for_tool_use, vec!).


##### `tests::handler`  (lines 741–753)

```
fn handler() -> ConfiguredHandler
```

**Purpose**: Creates a representative `ConfiguredHandler` fixture for pre-tool-use tests. It fixes matcher, command, source metadata, and empty env.

**Data flow**: Returns a `ConfiguredHandler` with `HookEventName::PreToolUse`, matcher `^Bash$`, command `echo hook`, timeout 5, no status message, `/tmp/hooks.json` source path, `HookSource::User`, display order 0, and empty env map.

**Call relations**: Used by parsing and preview-ID tests as stable handler metadata.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 755–765)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Builds deterministic `CommandRunResult` fixtures for pre-tool-use parsing tests. It avoids repeated boilerplate setup.

**Data flow**: Takes optional exit code and stdout/stderr strings → returns `CommandRunResult` with fixed timestamps, duration, copied outputs, and `error = None`.

**Call relations**: Used by all pre-tool-use parsing tests.


##### `tests::request_for_tool_use`  (lines 767–781)

```
fn request_for_tool_use(tool_use_id: &str) -> super::PreToolUseRequest
```

**Purpose**: Builds a canonical `PreToolUseRequest` fixture with stable metadata and JSON tool input. Tests customize it as needed.

**Data flow**: Takes a `tool_use_id` string → constructs a request with fresh `ThreadId`, fixed turn/model/permission mode/tool name, empty aliases, absolute `/tmp` cwd, and `tool_input` JSON `{ "command": "echo hello" }`.

**Call relations**: Used by command-input and run-ID tests.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, test_path_buf, json!).


### `hooks/src/events/post_tool_use.rs`

`domain_logic` · `post-tool execution handling after a tool returns`

This module handles hooks that run after a tool invocation completes. `PostToolUseRequest` carries session and turn metadata, optional subagent context, cwd, transcript path, model, permission mode, canonical tool name plus matcher aliases, the `tool_use_id`, and both `tool_input` and `tool_response`. The resulting `PostToolUseOutcome` reports all completed hook events, whether any hook blocked normal processing, any accumulated additional contexts, and a combined feedback message.

`preview` computes matcher inputs from the canonical tool name and aliases, selects matching handlers for `HookEventName::PostToolUse`, and rewrites each preview run ID with the tool-use ID. `run` repeats selection, returns an empty outcome if nothing matches, serializes a `PostToolUseCommandInput`, and on serialization failure returns synthetic failed events through `serialization_failure_outcome`. Otherwise it executes handlers and folds parsed results: `flatten_additional_contexts` merges model-facing context from all handlers, `any` determines whether any handler blocked, and `join_text_chunks` combines feedback strings into one message.

`parse_completed` is the core interpreter for command results. Successful JSON output is parsed with `output_parser::parse_post_tool_use`; `system_message` becomes a warning entry, valid `additionalContext` becomes both a `Context` entry and model context, `continue:false` becomes a stopped run with a `Stop` entry and synthesized feedback if needed, valid block decisions become `Blocked` runs with `Feedback`, and unsupported fields like `updatedMCPToolOutput` fail open as `Failed`. Exit code `2` plus stderr is also treated as a block-with-feedback convention. Plain stdout is ignored, while malformed JSON-like stdout is an error.

#### Function details

##### `preview`  (lines 53–68)

```
fn preview(
    handlers: &[ConfiguredHandler],
    request: &PostToolUseRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Builds preview summaries for post-tool-use hooks matching the tool name or aliases. It appends the tool-use ID to each run ID.

**Data flow**: Takes handlers and `PostToolUseRequest` → computes matcher inputs via `common::matcher_inputs` → selects matching handlers for `HookEventName::PostToolUse` → maps each running summary through `common::hook_run_for_tool_use` with `tool_use_id` → returns preview summaries.

**Call relations**: Called by the higher-level post-tool-use preview API and by tests that compare preview IDs with completed IDs.

*Call graph*: calls 2 internal fn (select_handlers_for_matcher_inputs, matcher_inputs); called by 3 (preview_post_tool_use, preview_and_completed_run_ids_include_tool_use_id, serialization_failure_run_ids_include_tool_use_id).


##### `run`  (lines 70–137)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: PostToolUseRequest,
) -> PostToolUseOutcome
```

**Purpose**: Executes matching post-tool-use hooks and aggregates block state, additional context, and feedback. It handles no-match and serialization-failure cases explicitly.

**Data flow**: Computes matcher inputs and selects matching handlers → returns empty `PostToolUseOutcome` if none → serializes request via `command_input_json`; on error synthesizes failed events with `serialization_failure_hook_events_for_tool_use` and wraps them with `serialization_failure_outcome` → otherwise executes handlers with `dispatcher::execute_handlers` and `parse_completed` → flattens additional contexts, computes `should_block` with `any`, joins feedback strings with `join_text_chunks`, rewrites completed event IDs with `hook_completed_for_tool_use`, and returns the final outcome.

**Call relations**: Invoked by the public post-tool-use run path; it delegates parsing to `parse_completed` and aggregation to common helpers.

*Call graph*: calls 8 internal fn (execute_handlers, select_handlers_for_matcher_inputs, flatten_additional_contexts, join_text_chunks, matcher_inputs, serialization_failure_hook_events_for_tool_use, command_input_json, serialization_failure_outcome); called by 1 (run_post_tool_use); 2 external calls (new, format!).


##### `command_input_json`  (lines 145–162)

```
fn command_input_json(request: &PostToolUseRequest) -> Result<String, serde_json::Error>
```

**Purpose**: Serializes a `PostToolUseRequest` into the JSON stdin contract for post-tool-use hooks. It preserves the canonical tool name even when aliases were used for matching.

**Data flow**: Converts optional subagent and transcript path, clones request metadata including `tool_input`, `tool_response`, and `tool_use_id`, sets `hook_event_name = "PostToolUse"`, builds `PostToolUseCommandInput`, and serializes it with `serde_json::to_string`.

**Call relations**: Used by `run` before command execution and by a unit test that verifies the serialized `tool_name` field.

*Call graph*: calls 2 internal fn (from_path, from); called by 2 (run, command_input_uses_request_tool_name); 1 external calls (to_string).


##### `parse_completed`  (lines 164–300)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<PostToolUseHandlerData>
```

**Purpose**: Parses one post-tool-use command result into transcript entries and per-handler aggregation data. It supports warnings, additional context, stop semantics, block feedback, and stderr-based blocking.

**Data flow**: Takes handler, `CommandRunResult`, and optional turn ID → initializes entries/status/flags/accumulators → if transport error exists, marks failed with one error entry → else on exit code `0`, ignores empty stdout, parses JSON via `output_parser::parse_post_tool_use`, emits warning entry for `system_message`, appends valid `additional_context` through `common::append_additional_context` only when no invalid reason/block-reason exists, handles `continue:false` by marking `Stopped`, adding a `Stop` entry, and pushing either trimmed `reason` or synthesized stop text into feedback messages, handles `invalid_reason` and `invalid_block_reason` as failures, and handles valid block decisions by marking `Blocked`, setting `should_block`, and recording feedback entries/messages; malformed JSON-like stdout becomes a failed run → exit code `2` with non-empty trimmed stderr becomes blocked feedback, otherwise a specific failure; other exit codes and missing status code become generic failures → returns `ParsedHandler<PostToolUseHandlerData>` with completion summary and aggregation data.

**Call relations**: Used by `run` as the dispatcher parse callback and directly by tests covering all major output forms.

*Call graph*: calls 5 internal fn (completed_summary, looks_like_json, parse_post_tool_use, append_additional_context, trimmed_non_empty); called by 8 (additional_context_is_recorded, block_decision_stops_normal_processing, continue_false_stops_with_reason, continue_false_without_reason_synthesizes_feedback, exit_two_blocks_with_feedback, plain_stdout_is_ignored_for_post_tool_use, preview_and_completed_run_ids_include_tool_use_id, unsupported_updated_mcp_tool_output_fails_open); 2 external calls (new, format!).


##### `serialization_failure_outcome`  (lines 302–309)

```
fn serialization_failure_outcome(hook_events: Vec<HookCompletedEvent>) -> PostToolUseOutcome
```

**Purpose**: Wraps synthetic serialization-failure events in a neutral `PostToolUseOutcome`. It ensures serialization errors do not themselves block processing or add context.

**Data flow**: Takes a vector of `HookCompletedEvent` → returns `PostToolUseOutcome { hook_events, should_block: false, additional_contexts: Vec::new(), feedback_message: None }`.

**Call relations**: Called only by `run` on the early-return path when command input JSON cannot be serialized.

*Call graph*: called by 1 (run); 1 external calls (new).


##### `tests::command_input_uses_request_tool_name`  (lines 332–341)

```
fn command_input_uses_request_tool_name()
```

**Purpose**: Tests that serialized post-tool-use input uses the request’s canonical `tool_name`, not any matcher alias. This preserves stable audit semantics.

**Data flow**: Builds a request fixture, overrides `tool_name`, serializes with `command_input_json`, parses the JSON back, and asserts `input["tool_name"]` equals the overridden canonical name.

**Call relations**: Directly exercises `command_input_json`.

*Call graph*: calls 1 internal fn (command_input_json); 3 external calls (assert_eq!, request_for_tool_use, from_str).


##### `tests::block_decision_stops_normal_processing`  (lines 344–364)

```
fn block_decision_stops_normal_processing()
```

**Purpose**: Tests that a valid JSON block decision marks the run blocked and records feedback for the model. This is the main structured blocking path.

**Data flow**: Creates a successful run result with `{"decision":"block","reason":"..."}` stdout → parses with `parse_completed` → asserts handler data contains `should_block = true` and one feedback message, and run status is `Blocked`.

**Call relations**: Covers the valid block-decision branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::additional_context_is_recorded`  (lines 367–393)

```
fn additional_context_is_recorded()
```

**Purpose**: Tests that valid `additionalContext` is emitted both as transcript context and model-facing context. It should not imply blocking.

**Data flow**: Creates successful JSON stdout with `hookSpecificOutput.additionalContext` → parses it → asserts handler data contains the context string and completed run entries contain one `Context` entry with the same text.

**Call relations**: Exercises the `append_additional_context` path in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::unsupported_updated_mcp_tool_output_fails_open`  (lines 396–423)

```
fn unsupported_updated_mcp_tool_output_fails_open()
```

**Purpose**: Tests that unsupported `updatedMCPToolOutput` causes a failed run rather than a block or rewrite. The event rejects output rewriting.

**Data flow**: Creates successful JSON stdout containing `updatedMCPToolOutput` → parses it → asserts no block/context/feedback data, failed status, and one error entry with the unsupported-field message.

**Call relations**: Covers the invalid-reason branch produced by `output_parser::parse_post_tool_use`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::exit_two_blocks_with_feedback`  (lines 426–442)

```
fn exit_two_blocks_with_feedback()
```

**Purpose**: Tests the legacy shell convention that exit code `2` plus stderr means block with feedback. This provides a non-JSON blocking path.

**Data flow**: Creates a run result with `exit_code = Some(2)` and stderr text → parses it → asserts handler data marks `should_block = true`, stores the stderr message as feedback, and sets run status to `Blocked`.

**Call relations**: Exercises the exit-code-2 branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::continue_false_stops_with_reason`  (lines 445–472)

```
fn continue_false_stops_with_reason()
```

**Purpose**: Tests that `continue:false` stops processing and uses `reason` as model feedback while `stopReason` becomes the transcript stop entry. This distinguishes transcript stop text from model-facing feedback.

**Data flow**: Creates successful JSON stdout with `continue:false`, `stopReason`, and `reason` → parses it → asserts no block flag, one feedback message equal to `reason`, stopped status, and one `Stop` entry equal to `stopReason`.

**Call relations**: Covers the structured stop branch in `parse_completed` when both stop and feedback text are present.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::continue_false_without_reason_synthesizes_feedback`  (lines 475–498)

```
fn continue_false_without_reason_synthesizes_feedback()
```

**Purpose**: Tests that when a stop response omits both `stopReason` and `reason`, the parser synthesizes a default stop message for both transcript and model feedback. This avoids silent stops.

**Data flow**: Creates successful JSON stdout `{"continue":false}` → parses it → asserts feedback messages contain `PostToolUse hook stopped execution`, status is `Stopped`, and the completed run has one `Stop` entry with the same synthesized text.

**Call relations**: Exercises the fallback-message branch in stop handling.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::plain_stdout_is_ignored_for_post_tool_use`  (lines 501–518)

```
fn plain_stdout_is_ignored_for_post_tool_use()
```

**Purpose**: Tests that plain non-JSON stdout from a successful post-tool-use hook is ignored. Hooks may log text without affecting execution.

**Data flow**: Creates a successful run result with plain text stdout → parses it → asserts no block/context/feedback data, completed status, and no transcript entries.

**Call relations**: Covers the plain-stdout no-op branch in `parse_completed`.

*Call graph*: calls 1 internal fn (parse_completed); 3 external calls (assert_eq!, handler, run_result).


##### `tests::preview_and_completed_run_ids_include_tool_use_id`  (lines 521–542)

```
fn preview_and_completed_run_ids_include_tool_use_id()
```

**Purpose**: Tests that preview run IDs and completed run IDs both include the same tool-use suffix. This keeps UI rows and transcript events correlated.

**Data flow**: Builds a request fixture with a known `tool_use_id` → calls `preview` and checks the generated run ID format → parses an empty successful completion and rewrites it with `common::hook_completed_for_tool_use` → asserts the completed run ID equals the preview run ID.

**Call relations**: Exercises both `preview` and the common run-ID rewriting helper used after parsing.

*Call graph*: calls 3 internal fn (hook_completed_for_tool_use, parse_completed, preview); 4 external calls (assert_eq!, handler, request_for_tool_use, run_result).


##### `tests::serialization_failure_run_ids_include_tool_use_id`  (lines 545–558)

```
fn serialization_failure_run_ids_include_tool_use_id()
```

**Purpose**: Tests that synthetic serialization-failure events also use tool-use-suffixed run IDs. Even early failures must line up with preview rows.

**Data flow**: Builds a request fixture and preview rows → calls `common::serialization_failure_hook_events_for_tool_use` with one handler and the same tool-use ID → asserts the synthetic completed event’s run ID matches the preview run ID.

**Call relations**: Covers the serialization-failure helper path used by `run`.

*Call graph*: calls 2 internal fn (serialization_failure_hook_events_for_tool_use, preview); 4 external calls (assert_eq!, handler, request_for_tool_use, vec!).


##### `tests::handler`  (lines 560–572)

```
fn handler() -> ConfiguredHandler
```

**Purpose**: Creates a representative `ConfiguredHandler` fixture for post-tool-use tests. It fixes matcher, command, source metadata, and empty env.

**Data flow**: Returns a `ConfiguredHandler` with `HookEventName::PostToolUse`, matcher `^Bash$`, command `python3 post_tool_use_hook.py`, timeout 5, status message, `/tmp/hooks.json` source path, `HookSource::User`, display order 0, and empty env map.

**Call relations**: Used by parsing and preview-ID tests as stable handler metadata.

*Call graph*: 2 external calls (test_path_buf, new).


##### `tests::run_result`  (lines 574–584)

```
fn run_result(exit_code: Option<i32>, stdout: &str, stderr: &str) -> CommandRunResult
```

**Purpose**: Builds deterministic `CommandRunResult` fixtures for post-tool-use parsing tests. It avoids repeated boilerplate.

**Data flow**: Takes optional exit code and stdout/stderr strings → returns `CommandRunResult` with fixed timestamps, duration, copied output strings, and `error = None`.

**Call relations**: Used by all post-tool-use parsing tests.


##### `tests::request_for_tool_use`  (lines 586–601)

```
fn request_for_tool_use(tool_use_id: &str) -> super::PostToolUseRequest
```

**Purpose**: Builds a canonical `PostToolUseRequest` fixture with stable metadata and JSON payloads. Tests customize it as needed.

**Data flow**: Takes a `tool_use_id` string → constructs a request with fresh `ThreadId`, fixed turn/model/permission mode/tool name, empty aliases, absolute `/tmp` cwd, `tool_input` JSON `{ "command": "echo hello" }`, and `tool_response` JSON `{ "ok": true }`.

**Call relations**: Used by command-input and run-ID tests.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, test_path_buf, json!).


### `hooks/src/events/permission_request.rs`

`domain_logic` · `approval-path request handling before user/guardian approval UI`

This module implements the permission-request event, which runs before guardian or user approval UI and differs from `PreToolUse` in one crucial way: hooks do not rewrite tool input or stop execution directly. Instead, they may return an explicit allow/deny decision or abstain. The file defines `PermissionRequestRequest`, the internal/public `PermissionRequestDecision`, the final `PermissionRequestOutcome`, and a small per-handler data struct used during aggregation.

`preview` computes matcher inputs from the canonical tool name plus aliases, selects matching handlers for `HookEventName::PermissionRequest`, and rewrites each preview run ID with the request’s `run_id_suffix`. `run` repeats selection, returns early if nothing matches, serializes a `PermissionRequestCommandInput`, and on serialization failure synthesizes failed hook events whose run IDs still include the tool-use suffix. Otherwise it executes handlers through the dispatcher and parses each result with `parse_completed`.

The aggregation rule is intentionally conservative and encoded in `resolve_permission_request_decision`: any deny wins immediately, otherwise the latest encountered allow is retained, otherwise there is no hook verdict. `parse_completed` interprets successful JSON output via `output_parser::parse_permission_request`, emits warning entries for `system_message`, marks unsupported output as failed, and turns deny decisions into `Blocked` runs with `Feedback` entries. It also supports a legacy shell convention where exit code `2` plus non-empty stderr means deny; other nonzero or missing exit codes are failures.

#### Function details

##### `preview`  (lines 67–85)

```
fn preview(
    handlers: &[ConfiguredHandler],
    request: &PermissionRequestRequest,
) -> Vec<HookRunSummary>
```

**Purpose**: Builds preview summaries for permission-request hooks matching the tool name or aliases. It also appends the request-specific run ID suffix so preview rows line up with completed events.

**Data flow**: Takes handlers and `PermissionRequestRequest` → computes matcher inputs with `common::matcher_inputs` → selects matching handlers for `HookEventName::PermissionRequest` → maps each running summary through `common::hook_run_for_tool_use` using `run_id_suffix` → returns preview summaries.

**Call relations**: Called by the higher-level permission-request preview API before execution.

*Call graph*: calls 2 internal fn (select_handlers_for_matcher_inputs, matcher_inputs); called by 1 (preview_permission_request).


##### `run`  (lines 87–148)

```
async fn run(
    handlers: &[ConfiguredHandler],
    shell: &CommandShell,
    request: PermissionRequestRequest,
) -> PermissionRequestOutcome
```

**Purpose**: Executes matching permission-request hooks and resolves their combined allow/deny verdict. It handles empty matches, serialization failures, and normal execution aggregation.

**Data flow**: Computes matcher inputs and selects matching handlers → returns empty outcome if none → serializes `build_command_input(&request)` with `serde_json::to_string`; on error returns synthetic failed events from `serialization_failure_hook_events_for_tool_use` and no decision → otherwise executes handlers with `dispatcher::execute_handlers` and `parse_completed` → resolves final decision from parsed handler decisions via `resolve_permission_request_decision` → rewrites completed event IDs with `hook_completed_for_tool_use` and returns `PermissionRequestOutcome`.

**Call relations**: Invoked by the public permission-request run path; it delegates input construction, execution, parsing, and final decision folding to helper functions.

*Call graph*: calls 6 internal fn (execute_handlers, select_handlers_for_matcher_inputs, matcher_inputs, serialization_failure_hook_events_for_tool_use, build_command_input, resolve_permission_request_decision); called by 1 (run_permission_request); 3 external calls (new, format!, to_string).


##### `resolve_permission_request_decision`  (lines 153–170)

```
fn resolve_permission_request_decision(
    decisions: impl IntoIterator<Item = &'a PermissionRequestDecision>,
) -> Option<PermissionRequestDecision>
```

**Purpose**: Combines multiple handler decisions into one final verdict using deny-first semantics. It preserves allow only when no deny appears.

**Data flow**: Consumes an iterator of borrowed `PermissionRequestDecision` values → iterates in order, storing `Some(Allow)` when an allow is seen, but immediately returns a cloned `Deny { message }` when any deny appears → returns the last stored allow or `None` if no decisions were present.

**Call relations**: Called only by `run` after all handlers have completed and been parsed.

*Call graph*: called by 1 (run).


##### `build_command_input`  (lines 172–187)

```
fn build_command_input(request: &PermissionRequestRequest) -> PermissionRequestCommandInput
```

**Purpose**: Constructs the typed command-input payload for a permission-request hook. It serializes approval context but intentionally does not include matcher aliases.

**Data flow**: Reads request fields, converts optional subagent via `SubagentCommandInputFields::from`, converts transcript path via `NullableString::from_path`, and clones `tool_input` → returns a `PermissionRequestCommandInput` with `hook_event_name = "PermissionRequest"`.

**Call relations**: Used by `run` immediately before JSON serialization.

*Call graph*: calls 2 internal fn (from_path, from); called by 1 (run).


##### `parse_completed`  (lines 189–291)

```
fn parse_completed(
    handler: &ConfiguredHandler,
    run_result: CommandRunResult,
    turn_id: Option<String>,
) -> dispatcher::ParsedHandler<PermissionRequestHandlerData>
```

**Purpose**: Parses one permission-request hook command result into transcript entries, run status, and an optional internal decision. It supports both structured JSON output and the legacy exit-code-2 deny convention.

**Data flow**: Takes handler metadata, `CommandRunResult`, and optional turn ID → initializes entries/status/decision → if `run_result.error` exists, marks failed with one error entry → else on exit code `0`, ignores empty stdout, parses JSON via `output_parser::parse_permission_request`, emits warning entry for `system_message`, marks failed on `invalid_reason`, maps valid allow/deny decisions into internal `PermissionRequestDecision`, and for deny also marks status `Blocked` and adds a `Feedback` entry; JSON-like but invalid stdout becomes a failed run → on exit code `2`, trims stderr and treats non-empty text as deny feedback/block, otherwise fails with a specific missing-reason message → other exit codes and missing status code become generic failures → wraps the result in `dispatcher::completed_summary` and returns `ParsedHandler<PermissionRequestHandlerData>`.

**Call relations**: Used by `run` as the dispatcher parse callback; it is the event-specific bridge between raw command execution and decision aggregation.

*Call graph*: calls 4 internal fn (completed_summary, looks_like_json, parse_permission_request, trimmed_non_empty); 2 external calls (new, format!).


##### `tests::permission_request_deny_overrides_earlier_allow`  (lines 301–315)

```
fn permission_request_deny_overrides_earlier_allow()
```

**Purpose**: Tests the conservative aggregation rule that any deny beats an earlier allow. This protects specific deny policies from being overridden.

**Data flow**: Creates an array `[Allow, Deny { ... }]` → passes `decisions.iter()` to `resolve_permission_request_decision` → asserts the result is the deny decision with the same message.

**Call relations**: Directly exercises the deny-short-circuit branch of decision resolution.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::permission_request_returns_allow_when_no_handler_denies`  (lines 318–328)

```
fn permission_request_returns_allow_when_no_handler_denies()
```

**Purpose**: Tests that allow is returned when one or more handlers allow and none deny. Multiple allows collapse to a single allow verdict.

**Data flow**: Creates two `Allow` decisions → resolves them → asserts the result is `Some(Allow)`.

**Call relations**: Covers the positive allow path in `resolve_permission_request_decision`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::permission_request_returns_none_when_no_handler_decides`  (lines 331–335)

```
fn permission_request_returns_none_when_no_handler_decides()
```

**Purpose**: Tests that no final decision is produced when no handler returns one. This leaves the normal approval flow untouched.

**Data flow**: Creates an empty `Vec<PermissionRequestDecision>` → resolves `decisions.iter()` → asserts the result is `None`.

**Call relations**: Covers the empty-input branch of decision resolution.

*Call graph*: 2 external calls (new, assert_eq!).
